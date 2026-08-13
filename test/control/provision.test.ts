/**
 * Provisioning is where a half-tenant becomes possible, so this file is mostly
 * about failure.
 *
 * The happy path is one test. The other forty are the states a run can die in:
 * a Neon project created but never banked, a role that never landed, a schema
 * applied under the wrong language, a bearer minted that nobody ever marked
 * ready. Each of those is a real, billable, externally-visible resource sitting
 * in an account with nothing pointing at it, and the plan's first named test
 * scenario is that a retry converges instead of accumulating them.
 *
 * Three rules the tests below exist to pin:
 *
 * 1. **`ready` is an absolute stop.** A retry against a ready tenant must not
 *    delete its project, rotate its bearer, or re-apply its schema. The
 *    idempotence that cleans up a failure would destroy a live user's brain if
 *    it ran one state too far.
 * 2. **The bearer grant is stored before the tenant is marked ready.** A ready
 *    tenant without a grant is unreachable; a grant without a ready tenant is
 *    harmless and gets rotated on retry. The order is asserted directly, from an
 *    ordered call log, not inferred from the code reading top to bottom.
 * 3. **The FTS language is applied before the first write is accepted (KTD9).**
 *    An English-default silent fallback is forbidden: a missing language is
 *    rejected before any resource exists, and a database that reports a language
 *    other than the one chosen never reaches `ready`.
 *
 * And one hazard carried over from `scripts/probes/r2-boundary/RESULT.md`, in a
 * second store. Neon's list-projects `search` is documented as a *partial* match
 * on name or id, so the orphan sweep that cleans up after a failed run would
 * find `brainz-alice2` while cleaning up after `alice` — and delete a sibling
 * tenant's entire database. The Neon fake below matches the way the vendor
 * documents it, substring and all, so an exact-match bug fails here the way it
 * would delete a real project. Every cross-tenant case in this file uses a
 * sibling (`alice` / `alice2`), never a stranger, for exactly the reason the R2
 * probe recorded: a stranger shares no leading substring and proves nothing.
 *
 * No network, no credentials, no live Neon. Every port is an interface with an
 * in-memory fake, as `secrets.ts` and `storage.ts` both do; the control-plane
 * fake enforces the CHECK constraints in `src/control/schema.sql` so an illegal
 * row fails here the way Postgres would reject it.
 */

import { beforeEach, describe, expect, test } from 'bun:test';

import {
  createInMemorySecretBackend,
  createTenantSecretStore,
  fleetIdentity,
  tenantNamespace,
  type TenantSecretStore,
} from '../../src/control/secrets.ts';
import {
  createInMemoryCredentialMinter,
  createTenantStorage,
  prefixCovers,
  type PrefixResult,
  type TenantPrefix,
  type TenantStorage,
} from '../../src/control/storage.ts';
import {
  DEFAULT_PROVISION_DEADLINE_MS,
  DEFAULT_STALE_PROVISIONING_MS,
  neonProjectName,
  provisionTenant,
  PROVISIONING_FAILURE_CODES,
  TENANT_STATES,
  TENANT_SUSPEND_TIMEOUT_SECONDS,
  FTS_LANGUAGE_PATTERN,
  type BearerGrantMinter,
  type ControlPlaneStore,
  type CreateProjectRequest,
  type FirstQueryResult,
  type NeonProjectApi,
  type ProvisionDeps,
  type ProvisionRequest,
  type ProvisionResult,
  type ProvisioningFailureCode,
  type SchemaApplyRequest,
  type TenantPatch,
  type TenantRecord,
  type UpdateOutcome,
} from '../../src/control/provision.ts';

/** Siblings by construction: one id is a strict prefix of the other. */
const TENANT = 'alice';
const SIBLING = 'alice2';

/** Deliberately not English — an English default is the failure KTD9 forbids. */
const LANGUAGE = 'spanish';

/**
 * Obviously-fake credential material. The repo is public and gitleaks runs in
 * CI, so nothing here is shaped like a real key, host, project id or bucket.
 */
const CONNECTION_STRING = 'postgres://role-fake:pw-fake@ep-fake.example.invalid/brainz';
const BEARER_GRANT = 'bearer-grant-fake-0001';
const PARENT_ACCESS_KEY_ID = 'parent-key-id-fake';
const PARENT_SECRET_ACCESS_KEY = 'parent-secret-fake-do-not-use';

const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Fakes. Each one records into a single shared, ordered call log, because the
// property this unit lives or dies by is an *ordering* property.
// ---------------------------------------------------------------------------

type FailAt = 'throw' | 'orphan' | 'none';

interface NeonFakeProject {
  readonly projectId: string;
  readonly name: string;
  readonly branchId: string;
}

interface NeonFake extends NeonProjectApi {
  /** Every project the vendor currently holds, orphans included. */
  readonly live: Map<string, NeonFakeProject>;
  readonly createRequests: CreateProjectRequest[];
  seed(projectId: string, name: string): void;
  failCreateProject: FailAt;
  failCreateRoleAndDatabase: FailAt;
}

/**
 * The Neon fake, modelling the vendor's *documented* semantics and nothing
 * kinder. Two of those matter here:
 *
 * - `searchProjectsByName` is a **substring** match, as Neon documents `search`
 *   ("You can specify partial `name` or `id` values"). A sweep that trusts it
 *   deletes the sibling.
 * - `failCreateProject: 'orphan'` models the worst real failure: the project is
 *   created at the vendor and the call *then* fails, so no id ever reaches the
 *   control-plane row. Only the deterministic name can find it again.
 */
function createNeonFake(log: string[]): NeonFake {
  const live = new Map<string, NeonFakeProject>();
  const createRequests: CreateProjectRequest[] = [];
  let serial = 0;

  const fake: NeonFake = {
    live,
    createRequests,
    failCreateProject: 'none',
    failCreateRoleAndDatabase: 'none',

    seed(projectId, name) {
      live.set(projectId, { projectId, name, branchId: `br-${projectId}` });
    },

    createProject(request) {
      log.push('neon.createProject');
      createRequests.push(request);

      if (fake.failCreateProject === 'throw') {
        return Promise.reject(new Error('neon fake: createProject refused'));
      }

      serial += 1;
      const projectId = `proj-${serial}`;
      const project: NeonFakeProject = { projectId, name: request.name, branchId: `br-${projectId}` };
      live.set(projectId, project);

      if (fake.failCreateProject === 'orphan') {
        // Created at the vendor, then the response never arrived. The id exists
        // and nothing in our control plane has ever seen it.
        return Promise.reject(new Error('neon fake: createProject timed out after creating'));
      }

      return Promise.resolve({ projectId, branchId: project.branchId });
    },

    createRoleAndDatabase(request) {
      log.push('neon.createRoleAndDatabase');
      if (fake.failCreateRoleAndDatabase !== 'none') {
        return Promise.reject(new Error('neon fake: createRoleAndDatabase refused'));
      }
      return Promise.resolve({
        roleName: request.roleName,
        databaseName: request.databaseName,
        connectionString: CONNECTION_STRING,
      });
    },

    deleteProject(projectId) {
      log.push('neon.deleteProject');
      live.delete(projectId);
      return Promise.resolve();
    },

    searchProjectsByName(name) {
      log.push('neon.searchProjectsByName');
      // Substring, exactly as documented. This is the trap.
      const matches = [...live.values()].filter((project) => project.name.includes(name));
      return Promise.resolve(matches.map((project) => ({ projectId: project.projectId, name: project.name })));
    },
  };

  return fake;
}

interface SchemaFake {
  apply(request: SchemaApplyRequest): Promise<{ readonly schemaVersion: number }>;
  verifyFirstQuery(request: { readonly connectionString: string }): Promise<FirstQueryResult>;
  readonly applyRequests: SchemaApplyRequest[];
  failApply: boolean;
  failVerify: boolean;
  /** What the database reports back. A silent English fallback looks like this. */
  reportedLanguage: string | null;
  appliedVersion: number;
}

function createSchemaFake(log: string[]): SchemaFake {
  const applyRequests: SchemaApplyRequest[] = [];

  const fake: SchemaFake = {
    applyRequests,
    failApply: false,
    failVerify: false,
    reportedLanguage: null,
    appliedVersion: SCHEMA_VERSION,

    apply(request) {
      log.push('schema.apply');
      applyRequests.push(request);
      if (fake.failApply) return Promise.reject(new Error('schema fake: apply refused'));
      return Promise.resolve({ schemaVersion: fake.appliedVersion });
    },

    verifyFirstQuery() {
      log.push('schema.verifyFirstQuery');
      if (fake.failVerify) return Promise.resolve({ ok: false });
      const observed = fake.reportedLanguage ?? applyRequests[applyRequests.length - 1]?.ftsLanguage ?? '';
      return Promise.resolve({ ok: true, ftsLanguage: observed });
    },
  };

  return fake;
}

interface StoreFake extends ControlPlaneStore {
  readonly rows: Map<string, TenantRecord>;
  readonly patches: TenantPatch[];
  put(record: TenantRecord): void;
}

/**
 * The control-plane fake, enforcing the CHECK constraints declared in
 * `src/control/schema.sql`. A test that "proves" provisioning marks a tenant
 * ready without a bearer ref proves nothing if the fake would have accepted the
 * row Postgres rejects, so the fake rejects it too — loudly, by throwing, the
 * way a constraint violation surfaces.
 */
function createStoreFake(log: string[]): StoreFake {
  const rows = new Map<string, TenantRecord>();
  const patches: TenantPatch[] = [];

  function checkRow(record: TenantRecord): void {
    if (record.state === 'ready') {
      const complete =
        record.neonProjectId !== null &&
        record.neonBranchId !== null &&
        record.neonDatabase !== null &&
        record.neonRole !== null &&
        record.connectionSecretRef !== null &&
        record.bearerSecretRef !== null &&
        record.storagePrefix !== null &&
        record.schemaVersion > 0 &&
        record.readyAt !== null;
      if (!complete) {
        throw new Error('CHECK ready_tenants_are_fully_provisioned');
      }
    }

    if (record.state === 'failed' && record.failureCode === null) {
      throw new Error('CHECK failed_tenants_name_a_code');
    }

    if (record.readyAt !== null && record.state !== 'ready' && record.state !== 'deleting') {
      throw new Error('CHECK only_served_tenants_carry_a_ready_at');
    }

    if (record.storagePrefix !== null) {
      const belongs =
        record.storagePrefix === `${record.tenantId}/` ||
        record.storagePrefix.endsWith(`/${record.tenantId}/`);
      if (!belongs) throw new Error('CHECK storage_prefix_belongs_to_this_tenant');
    }

    if (record.schemaVersion < 0 || record.provisioningAttempts < 0 || record.provisioningLease < 0) {
      throw new Error('CHECK tenant_counters_are_non_negative');
    }

    for (const other of rows.values()) {
      if (other.tenantId === record.tenantId) continue;
      if (record.neonProjectId !== null && other.neonProjectId === record.neonProjectId) {
        throw new Error('UNIQUE tenant_neon_project_is_exclusive');
      }
      if (record.storagePrefix !== null && other.storagePrefix === record.storagePrefix) {
        throw new Error('UNIQUE tenant_storage_prefix_is_exclusive');
      }
    }
  }

  return {
    rows,
    patches,

    put(record) {
      checkRow(record);
      rows.set(record.tenantId, record);
    },

    get(tenantId) {
      log.push('store.get');
      return Promise.resolve(rows.get(tenantId));
    },

    insert(row) {
      log.push('store.insert');
      const existing = rows.get(row.tenantId);
      if (existing !== undefined) return Promise.resolve({ inserted: false, record: existing });
      checkRow(row);
      rows.set(row.tenantId, row);
      return Promise.resolve({ inserted: true, record: row });
    },

    update(tenantId, expectedLease, patch) {
      const keys = Object.keys(patch).sort().join('+');
      log.push(`store.update[${keys}]`);
      patches.push(patch);

      const existing = rows.get(tenantId);
      if (existing === undefined) throw new Error('control-plane fake: no such row');

      // The compare-and-set, modelled the way Postgres would run it: one
      // statement, and a row whose lease has moved on is simply not matched. An
      // empty patch is still a lease check, per the port's contract.
      if (existing.provisioningLease !== expectedLease) {
        return Promise.resolve({ applied: false, current: existing });
      }

      const next: TenantRecord = { ...existing, ...patch };
      checkRow(next);
      rows.set(tenantId, next);
      return Promise.resolve({ applied: true, record: next });
    },
  };
}

function createBearerFake(log: string[]): BearerGrantMinter & { serial: number; fail: boolean } {
  const fake = {
    serial: 0,
    fail: false,
    mint(): Promise<string> {
      log.push('bearer.mint');
      if (fake.fail) return Promise.reject(new Error('bearer fake: mint refused'));
      fake.serial += 1;
      return Promise.resolve(`${BEARER_GRANT}-${fake.serial}`);
    },
  };
  return fake;
}

/** Wraps the real secret store so writes and revocations land in the call log. */
function observeSecrets(inner: TenantSecretStore, log: string[]): TenantSecretStore {
  return {
    resolve: (caller, tenantId) => {
      // Nothing provisioning holds can call this — the port it declares has no
      // `resolve`. Recorded anyway, so the claim has a runtime witness too.
      log.push('secrets.resolve');
      return inner.resolve(caller, tenantId);
    },
    put: (caller, tenantId, secret) => {
      log.push('secrets.put');
      return inner.put(caller, tenantId, secret);
    },
    revoke: (caller, tenantId) => {
      log.push('secrets.revoke');
      return inner.revoke(caller, tenantId);
    },
    invalidate: (caller, tenantId) => inner.invalidate(caller, tenantId),
  };
}

/**
 * The real storage accessor, wrapped so the test can prove provisioning never
 * reaches for a credential. The *type* provisioning accepts has no
 * `credentialFor` at all — this recorder is the runtime half of the same claim.
 */
interface StorageRecorder extends TenantStorage {
  readonly credentialCalls: number;
}

function recordStorage(inner: TenantStorage): StorageRecorder {
  let credentialCalls = 0;
  return {
    get credentialCalls() {
      return credentialCalls;
    },
    prefixFor: (caller, tenantId) => inner.prefixFor(caller, tenantId),
    keyFor: (caller, tenantId, remainder) => inner.keyFor(caller, tenantId, remainder),
    keyForUntrusted: (caller, tenantId, collection, untrustedId) =>
      inner.keyForUntrusted(caller, tenantId, collection, untrustedId),
    credentialFor: (caller, tenantId) => {
      credentialCalls += 1;
      return inner.credentialFor(caller, tenantId);
    },
    invalidate: (caller, tenantId) => inner.invalidate(caller, tenantId),
  };
}

// ---------------------------------------------------------------------------

describe('tenant provisioning', () => {
  let clockMs: number;
  let log: string[];
  let neon: NeonFake;
  let schema: SchemaFake;
  let store: StoreFake;
  let bearer: ReturnType<typeof createBearerFake>;
  let secretStore: TenantSecretStore;
  let secrets: TenantSecretStore;
  let storage: StorageRecorder;
  let deps: ProvisionDeps;

  const now = (): number => clockMs;

  beforeEach(() => {
    clockMs = 1_700_000_000_000;
    log = [];
    neon = createNeonFake(log);
    schema = createSchemaFake(log);
    store = createStoreFake(log);
    bearer = createBearerFake(log);
    secretStore = createTenantSecretStore({
      backend: createInMemorySecretBackend(),
      now,
    });
    secrets = observeSecrets(secretStore, log);
    storage = recordStorage(
      createTenantStorage({
        minter: createInMemoryCredentialMinter({
          parentAccessKeyId: PARENT_ACCESS_KEY_ID,
          parentSecretAccessKey: PARENT_SECRET_ACCESS_KEY,
          now,
        }),
        now,
      }),
    );
    deps = { neon, schema, store, secrets, storage, bearer, now };
  });

  function request(overrides: Partial<ProvisionRequest> = {}): ProvisionRequest {
    return { tenantId: TENANT, ftsLanguage: LANGUAGE, ...overrides };
  }

  async function provision(overrides: Partial<ProvisionRequest> = {}): Promise<ProvisionResult> {
    return provisionTenant(deps, request(overrides));
  }

  function row(tenantId = TENANT): TenantRecord {
    const record = store.rows.get(tenantId);
    if (record === undefined) throw new Error(`test: no control-plane row for ${tenantId}`);
    return record;
  }

  // -------------------------------------------------------------------------
  describe('the sequence, in order', () => {
    test('a provisioned tenant is ready, with every artifact banked', async () => {
      const result = await provision();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.alreadyReady).toBe(false);
      expect(result.tenant.state).toBe('ready');
      expect(result.tenant.ftsLanguage).toBe(LANGUAGE);
      expect(result.tenant.schemaVersion).toBe(SCHEMA_VERSION);
      expect(result.tenant.neonProjectId).not.toBeNull();
      expect(result.tenant.neonBranchId).not.toBeNull();
      expect(result.tenant.neonDatabase).not.toBeNull();
      expect(result.tenant.neonRole).not.toBeNull();
      expect(result.tenant.connectionSecretRef).toBe(tenantNamespace(TENANT));
      expect(result.tenant.bearerSecretRef).toBe(tenantNamespace(TENANT));
      expect(result.tenant.storagePrefix).toBe('tenants/alice/');
      expect(result.tenant.readyAt).toBe(clockMs);
      expect(result.tenant.failureCode).toBeNull();
    });

    test('the order is exactly the sequence U2 specifies', async () => {
      await provision();

      expect(log).toEqual([
        'store.get',
        'store.insert',
        'store.update[storagePrefix]',
        'neon.createProject',
        'store.update[neonBranchId+neonProjectId]',
        'neon.createRoleAndDatabase',
        'store.update[neonDatabase+neonRole]',
        'schema.apply',
        'store.update[schemaVersion]',
        'schema.verifyFirstQuery',
        'bearer.mint',
        // The lease check that runs immediately before a write to a store that
        // has no lease of its own.
        'store.update[]',
        'secrets.put',
        'store.update[bearerSecretRef+connectionSecretRef]',
        'store.update[failureCode+readyAt+state]',
      ]);
    });

    test('the bearer grant is stored BEFORE the tenant is marked ready', async () => {
      await provision();

      const put = log.indexOf('secrets.put');
      const ready = log.indexOf('store.update[failureCode+readyAt+state]');

      expect(put).toBeGreaterThanOrEqual(0);
      expect(ready).toBeGreaterThanOrEqual(0);
      expect(put).toBeLessThan(ready);
    });

    test('U6 can authenticate the moment the tenant is ready', async () => {
      await provision();

      const resolved = await secretStore.resolve(fleetIdentity(TENANT), TENANT);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.secret.bearerGrant).toBe(`${BEARER_GRANT}-1`);
      expect(resolved.secret.connectionString).toBe(CONNECTION_STRING);
    });

    test('every Neon artifact is banked on the row before the next call is made', async () => {
      // The property that makes cleanup possible at all: an id we hold is an id
      // the retry can delete.
      await provision();

      const bankProject = log.indexOf('store.update[neonBranchId+neonProjectId]');
      const roleCall = log.indexOf('neon.createRoleAndDatabase');
      expect(bankProject).toBeLessThan(roleCall);
    });

    test('the compute suspend delay is set at provision time, at one minute', async () => {
      await provision();

      expect(TENANT_SUSPEND_TIMEOUT_SECONDS).toBe(60);
      expect(neon.createRequests).toHaveLength(1);
      expect(neon.createRequests[0]?.suspendTimeoutSeconds).toBe(60);
    });

    test('the project name is deterministic, so an unbanked project is findable', async () => {
      await provision();

      expect(neonProjectName(TENANT)).toBe('brainz-alice');
      expect(neon.createRequests[0]?.name).toBe('brainz-alice');
    });
  });

  // -------------------------------------------------------------------------
  describe('the FTS language is applied before the first write is accepted (KTD9)', () => {
    test('the chosen language reaches the schema applier verbatim', async () => {
      await provision();

      expect(schema.applyRequests).toHaveLength(1);
      expect(schema.applyRequests[0]?.ftsLanguage).toBe(LANGUAGE);
    });

    test('the schema is applied before the first query is verified', async () => {
      await provision();
      expect(log.indexOf('schema.apply')).toBeLessThan(log.indexOf('schema.verifyFirstQuery'));
    });

    test('a database that reports English when Spanish was chosen never becomes ready', async () => {
      // The exact failure KTD9 forbids: nothing errors, the tenant works, and
      // every document it ever indexes is stemmed by the wrong language.
      schema.reportedLanguage = 'english';

      const result = await provision();

      expect(result).toEqual({ ok: false, reason: 'schema_apply_failed', recorded: true });
      expect(row().state).toBe('failed');
      expect(row().readyAt).toBeNull();
    });

    test('a missing language is refused before any resource exists', async () => {
      const result = await provisionTenant(deps, { tenantId: TENANT, ftsLanguage: '' });

      expect(result).toEqual({ ok: false, reason: 'missing_fts_language', recorded: false });
      expect(log).toEqual([]);
      expect(neon.live.size).toBe(0);
      expect(store.rows.size).toBe(0);
    });

    test('a language that is not a Postgres config name is refused, also before any resource', async () => {
      const result = await provisionTenant(deps, { tenantId: TENANT, ftsLanguage: 'Espa nol!' });

      expect(result).toEqual({ ok: false, reason: 'invalid_fts_language', recorded: false });
      expect(log).toEqual([]);
      expect(neon.live.size).toBe(0);
    });

    test('the request type carries no default language', () => {
      // A compile-time assertion: if `ftsLanguage` ever becomes optional, the
      // silent English fallback becomes expressible and this stops compiling.
      // @ts-expect-error — ftsLanguage is required, deliberately (KTD9).
      const missing: ProvisionRequest = { tenantId: TENANT };
      expect(missing.tenantId).toBe(TENANT);
    });
  });

  // -------------------------------------------------------------------------
  describe('a failure mid-sequence leaves no orphaned half-tenant', () => {
    test('project create fails outright: nothing was created, the row says why', async () => {
      neon.failCreateProject = 'throw';

      const result = await provision();

      expect(result).toEqual({ ok: false, reason: 'project_create_failed', recorded: true });
      expect(neon.live.size).toBe(0);
      expect(row().state).toBe('failed');
      expect(row().failureCode).toBe('project_create_failed');
      expect(row().neonProjectId).toBeNull();
    });

    test('project created but its id never banked: the retry finds it by name and deletes it', async () => {
      neon.failCreateProject = 'orphan';

      const first = await provision();
      expect(first.ok).toBe(false);
      expect(neon.live.size).toBe(1); // the orphan, unreferenced by any row
      expect(row().neonProjectId).toBeNull();

      neon.failCreateProject = 'none';
      const second = await provision();

      expect(second.ok).toBe(true);
      // Exactly one project survives: the orphan was swept, the new one kept.
      expect(neon.live.size).toBe(1);
      if (!second.ok) return;
      expect([...neon.live.keys()]).toEqual([second.tenant.neonProjectId ?? '']);
    });

    test('project created, role not: the retry deletes the recorded project', async () => {
      neon.failCreateRoleAndDatabase = 'throw';

      const first = await provision();
      expect(first).toEqual({ ok: false, reason: 'role_create_failed', recorded: true });
      const orphanId = row().neonProjectId;
      expect(orphanId).not.toBeNull();
      expect(neon.live.size).toBe(1);

      neon.failCreateRoleAndDatabase = 'none';
      const second = await provision();

      expect(second.ok).toBe(true);
      expect(neon.live.size).toBe(1);
      expect(neon.live.has(orphanId ?? '')).toBe(false);
    });

    test('schema apply fails: the tenant is failed, the project is cleaned up on retry', async () => {
      schema.failApply = true;

      const first = await provision();
      expect(first).toEqual({ ok: false, reason: 'schema_apply_failed', recorded: true });
      expect(row().schemaVersion).toBe(0);

      schema.failApply = false;
      const second = await provision();

      expect(second.ok).toBe(true);
      expect(neon.live.size).toBe(1);
      expect(row().schemaVersion).toBe(SCHEMA_VERSION);
    });

    test('the first query fails: the tenant is failed with its own code', async () => {
      schema.failVerify = true;

      const result = await provision();

      expect(result).toEqual({ ok: false, reason: 'first_query_failed', recorded: true });
      expect(row().failureCode).toBe('first_query_failed');
    });

    test('the schema never reaches a version the row cannot serve', async () => {
      // `ready` requires schema_version > 0 in the schema's own CHECK. An applier
      // that reports 0 is a failed apply, not a ready tenant.
      schema.appliedVersion = 0;

      const result = await provision();

      expect(result).toEqual({ ok: false, reason: 'schema_apply_failed', recorded: true });
      expect(row().schemaVersion).toBe(0);
    });

    test('the bearer cannot be minted: no secret is written and the tenant is not ready', async () => {
      bearer.fail = true;

      const result = await provision();

      expect(result).toEqual({ ok: false, reason: 'secret_write_failed', recorded: true });
      expect(log).not.toContain('secrets.put');
      const resolved = await secretStore.resolve(fleetIdentity(TENANT), TENANT);
      expect(resolved).toEqual({ ok: false, reason: 'not_found' });
    });

    test('the secret write is refused: the tenant is failed, never ready', async () => {
      // A store that denies the control plane its write. Modelled through the
      // real store's own scope check rather than a bespoke fake.
      deps = {
        ...deps,
        secrets: {
          ...secrets,
          put: () => Promise.resolve({ ok: false as const, reason: 'scope_denied' as const }),
        },
      };

      const result = await provision();

      expect(result).toEqual({ ok: false, reason: 'secret_write_failed', recorded: true });
      expect(row().state).toBe('failed');
      expect(row().bearerSecretRef).toBeNull();
    });

    test('a crash between the secret write and mark-ready leaves a harmless grant', async () => {
      // The state the ordering guarantee deliberately allows: a grant exists, no
      // tenant is ready. Nothing can use it, because nothing routes to a tenant
      // that is not ready — and the retry rotates it away.
      const failingStore: ControlPlaneStore = {
        ...store,
        update: (tenantId, expectedLease, patch) => {
          if (patch.state === 'ready') throw new Error('control plane fake: crashed before ready');
          return store.update(tenantId, expectedLease, patch);
        },
      };
      deps = { ...deps, store: failingStore };

      await expect(provision()).rejects.toThrow('crashed before ready');

      const stranded = await secretStore.resolve(fleetIdentity(TENANT), TENANT);
      expect(stranded.ok).toBe(true);
      expect(row().state).toBe('provisioning');
      expect(row().readyAt).toBeNull();
    });

    test('a retry after a stranded grant rotates the bearer rather than reusing it', async () => {
      const failingStore: ControlPlaneStore = {
        ...store,
        update: (tenantId, expectedLease, patch) => {
          if (patch.state === 'ready') throw new Error('control plane fake: crashed before ready');
          return store.update(tenantId, expectedLease, patch);
        },
      };
      deps = { ...deps, store: failingStore };
      await expect(provision()).rejects.toThrow('crashed before ready');

      const before = await secretStore.resolve(fleetIdentity(TENANT), TENANT);
      expect(before.ok).toBe(true);

      clockMs += DEFAULT_STALE_PROVISIONING_MS + 1;
      deps = { ...deps, store };
      log.length = 0;
      const second = await provision();

      expect(second.ok).toBe(true);
      // The property this test *names* is revocation, so revocation is what it
      // checks. Comparing the grant before and after passes either way — the
      // write at the end of the run overwrites the entry regardless — so the
      // ordered call log is the only witness that the stranded grant was
      // actually revoked rather than merely replaced.
      expect(log.indexOf('secrets.revoke')).toBeGreaterThanOrEqual(0);
      expect(log.indexOf('secrets.revoke')).toBeLessThan(log.indexOf('secrets.put'));

      const after = await secretStore.resolve(fleetIdentity(TENANT), TENANT);
      expect(after.ok).toBe(true);
      if (!before.ok || !after.ok) return;
      expect(after.secret.bearerGrant).not.toBe(before.secret.bearerGrant);
    });

    test('a retry converges: one project, one row, one grant, whatever the first run did', async () => {
      neon.failCreateProject = 'orphan';
      await provision();
      neon.failCreateProject = 'none';
      neon.failCreateRoleAndDatabase = 'throw';
      await provision();
      neon.failCreateRoleAndDatabase = 'none';
      schema.failApply = true;
      await provision();
      schema.failApply = false;

      const result = await provision();

      expect(result.ok).toBe(true);
      expect(neon.live.size).toBe(1);
      expect(store.rows.size).toBe(1);
      expect(row().provisioningAttempts).toBe(4);
    });

    test('the failure path records artifacts rather than deleting them', async () => {
      // One cleanup owner. The failure path banks the code and leaves the ids on
      // the row; the retry is the only thing that deletes. Two cleanup
      // implementations would drift, and the one that runs less often is wrong.
      neon.failCreateRoleAndDatabase = 'throw';

      await provision();

      expect(row().neonProjectId).not.toBeNull();
      expect(log).not.toContain('neon.deleteProject');
    });
  });

  // -------------------------------------------------------------------------
  describe('the orphan sweep must not reach a sibling', () => {
    test('sweeping after alice does not delete alice2 — the sibling case, in Neon', async () => {
      // Neon's `search` is a documented *substring* match on name or id. A sweep
      // that deletes everything the search returns deletes the sibling tenant's
      // entire database. Same shape as the R2 finding, second store.
      neon.seed('proj-sibling', neonProjectName(SIBLING));
      neon.failCreateProject = 'orphan';

      await provision();
      neon.failCreateProject = 'none';
      const second = await provision();

      expect(second.ok).toBe(true);
      expect(neon.live.has('proj-sibling')).toBe(true);
    });

    test('a sibling prefix is not covered by this tenant prefix', async () => {
      await provision();
      await provisionTenant(deps, { tenantId: SIBLING, ftsLanguage: LANGUAGE });

      const mine = row(TENANT).storagePrefix ?? '';
      const theirs = row(SIBLING).storagePrefix ?? '';

      expect(mine).toBe('tenants/alice/');
      expect(theirs).toBe('tenants/alice2/');
      expect(prefixCovers(mine as TenantPrefix, theirs)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('a ready tenant is never re-provisioned', () => {
    test('a retry against a ready tenant is a no-op that reports it', async () => {
      const first = await provision();
      expect(first.ok).toBe(true);

      log.length = 0;
      const second = await provision();

      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.alreadyReady).toBe(true);
      expect(log).toEqual(['store.get']);
    });

    test("a retry against a ready tenant does not delete that tenant's project", async () => {
      const first = await provision();
      expect(first.ok).toBe(true);
      const projectId = row().neonProjectId ?? '';

      await provision();

      expect(neon.live.has(projectId)).toBe(true);
      expect(log).not.toContain('neon.deleteProject');
    });

    test('a retry against a ready tenant does not rotate its bearer', async () => {
      await provision();
      const before = await secretStore.resolve(fleetIdentity(TENANT), TENANT);

      await provision();
      const after = await secretStore.resolve(fleetIdentity(TENANT), TENANT);

      expect(before.ok && after.ok).toBe(true);
      if (!before.ok || !after.ok) return;
      expect(after.secret.bearerGrant).toBe(before.secret.bearerGrant);
    });

    test('a tenant being deleted is refused rather than re-provisioned', async () => {
      await provision();
      store.put({ ...row(), state: 'deleting' });

      const result = await provision();

      expect(result).toEqual({ ok: false, reason: 'tenant_deleting', recorded: false });
    });
  });

  // -------------------------------------------------------------------------
  describe('a run in flight is not stolen', () => {
    /**
     * A run that died without recording anything leaves the row in
     * `provisioning` — indistinguishable, from the outside, from a run still
     * going. That is the only state the in-flight guard applies to: a row that
     * says `failed` says so because a run finished and reported, and making a
     * user wait ten minutes to retry that would be absurd.
     */
    function crashBeforeReady(): void {
      deps = {
        ...deps,
        store: {
          ...store,
          update: (tenantId, expectedLease, patch) => {
            if (patch.state === 'ready') throw new Error('control plane fake: crashed before ready');
            return store.update(tenantId, expectedLease, patch);
          },
        },
      };
    }

    test('a second provision while one may still be running is refused', async () => {
      crashBeforeReady();
      await expect(provision()).rejects.toThrow('crashed before ready');
      expect(row().state).toBe('provisioning');

      deps = { ...deps, store };
      log.length = 0;
      const second = await provision();

      expect(second).toEqual({ ok: false, reason: 'provisioning_in_progress', recorded: false });
      expect(log).toEqual(['store.get']);
      expect(neon.live.size).toBe(1);
    });

    test('a recorded failure is retryable at once — it is not an in-flight run', async () => {
      neon.failCreateProject = 'throw';
      await provision();
      expect(row().state).toBe('failed');

      neon.failCreateProject = 'none';
      const second = await provision();

      expect(second.ok).toBe(true);
    });

    test('a run that stopped long enough ago is taken over and cleaned up', async () => {
      crashBeforeReady();
      await expect(provision()).rejects.toThrow('crashed before ready');
      const abandoned = row().neonProjectId ?? '';
      expect(neon.live.has(abandoned)).toBe(true);

      deps = { ...deps, store };
      clockMs += DEFAULT_STALE_PROVISIONING_MS + 1;
      const second = await provision();

      expect(second.ok).toBe(true);
      expect(neon.live.size).toBe(1);
      expect(neon.live.has(abandoned)).toBe(false);
    });

    test('the stale window outlives the deadline, so a live run is never stale', () => {
      // If a run may take `DEFAULT_PROVISION_DEADLINE_MS`, a window shorter than
      // that declares running attempts dead and lets a second run delete the
      // first one's project out from under it.
      expect(DEFAULT_STALE_PROVISIONING_MS).toBeGreaterThan(DEFAULT_PROVISION_DEADLINE_MS);
    });

    test('the attempt counter and its start time move on every retry', async () => {
      neon.failCreateProject = 'throw';
      await provision();
      expect(row().provisioningAttempts).toBe(1);
      const firstStart = row().provisioningStartedAt;

      clockMs += DEFAULT_STALE_PROVISIONING_MS + 1;
      await provision();

      expect(row().provisioningAttempts).toBe(2);
      expect(row().provisioningStartedAt).toBeGreaterThan(firstStart);
    });
  });

  // -------------------------------------------------------------------------
  /**
   * Two runs overlapping **in time**, which is the case every other test in this
   * file misses: the sequential "concurrency" tests above all let the first run
   * return before the second starts, so the interleave that actually destroys a
   * tenant has never been exercised.
   *
   * The interleave is not exotic and needs no bug to reach. The deadline is
   * cooperative — it is observed between phases — so a provider call that hangs
   * outlives it, and then outlives the stale window too. At that point the
   * takeover is *legitimate*: the row looks abandoned because, from the outside,
   * an abandoned run and a stuck one are the same row.
   */
  describe('two runs overlapping in time', () => {
    /** A promise the test opens by hand, so a run can be suspended mid-call. */
    function gate(): { readonly promise: Promise<void>; open: () => void } {
      let open = (): void => {};
      const promise = new Promise<void>((resolve) => {
        open = (): void => {
          resolve();
        };
      });
      return { promise, open };
    }

    /**
     * Suspends the run inside `createRoleAndDatabase` — a provider call, the
     * place a run really does hang — and hands the test the two ends of it.
     */
    function hangingNeon(outcome: 'throw' | 'succeed'): {
      readonly neon: NeonProjectApi;
      readonly inside: Promise<void>;
      readonly release: () => void;
    } {
      const entered = gate();
      const held = gate();
      return {
        inside: entered.promise,
        release: held.open,
        neon: {
          ...neon,
          createRoleAndDatabase: async (req) => {
            entered.open();
            await held.promise;
            if (outcome === 'throw') throw new Error('neon fake: the provider gave up');
            return neon.createRoleAndDatabase(req);
          },
        },
      };
    }

    test('a straggler that wakes after a takeover cannot flip the ready tenant to failed', async () => {
      const hung = hangingNeon('throw');

      const runA = provisionTenant({ ...deps, neon: hung.neon }, request());
      await hung.inside;
      expect(row().state).toBe('provisioning');

      // The clock passes the stale window while A is stuck inside the provider
      // call. Nothing tells A; nothing can.
      clockMs += DEFAULT_STALE_PROVISIONING_MS + 1;

      const runB = await provision();
      expect(runB.ok).toBe(true);
      expect(row().state).toBe('ready');
      const readyProject = row().neonProjectId ?? '';
      const readyAt = row().readyAt;
      expect(readyProject).not.toBe('');

      hung.release();
      const resultA = await runA;
      expect(resultA).toEqual({ ok: false, reason: 'superseded', recorded: false });

      // The row a live user is being served from, after the straggler reported.
      expect(row().state).toBe('ready');
      expect(row().readyAt).toBe(readyAt);
      expect(row().neonProjectId).toBe(readyProject);

      // And the consequence that makes this critical rather than untidy: a
      // `failed` row is retryable at once, and the retry is the one thing that
      // deletes. An ordinary retry must be a no-op here, not a demolition.
      const runC = await provision();
      expect(runC.ok).toBe(true);
      if (runC.ok) expect(runC.alreadyReady).toBe(true);
      expect(neon.live.has(readyProject)).toBe(true);
    });

    test('a straggler that wakes and SUCCEEDS does not re-provision over the ready row', async () => {
      // The variant that needs no failure at all: the straggler simply carries
      // on, re-running the later phases against a row that is already ready.
      // Both runs report success, the bearer the user was handed is rotated
      // away, and the secret store ends up holding a connection string for a
      // project the takeover deleted — addressable but misconfigured, with
      // nothing anywhere recording a failure.
      const hung = hangingNeon('succeed');

      const runA = provisionTenant({ ...deps, neon: hung.neon }, request());
      await hung.inside;

      clockMs += DEFAULT_STALE_PROVISIONING_MS + 1;
      const runB = await provision();
      expect(runB.ok).toBe(true);

      const served = await secretStore.resolve(fleetIdentity(TENANT), TENANT);
      expect(served.ok).toBe(true);
      const readyProject = row().neonProjectId ?? '';
      const readyAt = row().readyAt;

      hung.release();
      const resultA = await runA;

      expect(resultA).toEqual({ ok: false, reason: 'superseded', recorded: false });
      expect(row().state).toBe('ready');
      expect(row().readyAt).toBe(readyAt);
      expect(row().neonProjectId).toBe(readyProject);
      expect(neon.live.has(readyProject)).toBe(true);

      // The grant the user is holding is still the grant that routes to them.
      const after = await secretStore.resolve(fleetIdentity(TENANT), TENANT);
      expect(after.ok).toBe(true);
      if (!served.ok || !after.ok) return;
      expect(after.secret.bearerGrant).toBe(served.secret.bearerGrant);
    });

    test('two retries of a failed row create one billable project, not two', async () => {
      // A `failed` row has no staleness gate — deliberately, so a user at a
      // signup form is not made to wait out a stale window. Two retries
      // therefore both pass triage, and without a conditional claim both create
      // a real, billable project. The loser's is referenced by nothing and, once
      // the winner is ready, cleanup never runs again: it is orphaned forever.
      neon.failCreateProject = 'throw';
      await provision();
      expect(row().state).toBe('failed');
      neon.failCreateProject = 'none';

      // Both runs read the failed row before either of them writes.
      let waiting = 0;
      const bothRead = gate();
      const racingStore: ControlPlaneStore = {
        ...store,
        get: async (tenantId) => {
          const found = await store.get(tenantId);
          waiting += 1;
          if (waiting >= 2) bothRead.open();
          await bothRead.promise;
          return found;
        },
      };
      const racing: ProvisionDeps = { ...deps, store: racingStore };

      const [first, second] = await Promise.all([
        provisionTenant(racing, request()),
        provisionTenant(racing, request()),
      ]);

      expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
      const loser = first.ok ? second : first;
      expect(loser).toEqual({
        ok: false,
        reason: 'provisioning_in_progress',
        recorded: false,
      });
      expect(neon.live.size).toBe(1);
      expect(neon.live.has(row().neonProjectId ?? '')).toBe(true);
    });

    test('a superseded run does not leave the project it created behind', async () => {
      // The straggler created a project under its own lease. Nothing references
      // it — the row names the winner's — so the one thing a superseded run may
      // still do is undo its own work.
      const entered = gate();
      const held = gate();
      const slowNeon: NeonProjectApi = {
        ...neon,
        // Suspended *before* the create, so the takeover's sweep has already run
        // by the time this project comes into existence. Nothing else will ever
        // look for it: the sweep runs on the retry path, and once the winner is
        // ready there is no retry.
        createProject: async (req) => {
          entered.open();
          await held.promise;
          return neon.createProject(req);
        },
      };

      const runA = provisionTenant({ ...deps, neon: slowNeon }, request());
      await entered.promise;
      clockMs += DEFAULT_STALE_PROVISIONING_MS + 1;
      const runB = await provision();
      expect(runB.ok).toBe(true);
      const readyProject = row().neonProjectId ?? '';

      held.open();
      expect(await runA).toEqual({ ok: false, reason: 'superseded', recorded: false });

      // A billable project, referenced by nothing and swept by nobody, is what a
      // superseded run leaves behind if it walks away silently.
      expect([...neon.live.keys()]).toEqual([readyProject]);
    });

    test('taking a row over advances the lease, and the previous holder cannot write', async () => {
      neon.failCreateProject = 'throw';
      await provision();
      const before = row().provisioningLease;

      neon.failCreateProject = 'none';
      await provision();
      expect(row().provisioningLease).toBe(before + 1);

      const stale: UpdateOutcome = await store.update(TENANT, before, {
        state: 'failed',
        failureCode: 'timed_out',
      });
      expect(stale.applied).toBe(false);
      expect(row().state).toBe('ready');
      expect(row().failureCode).toBeNull();

      // Positive control: the lease the row actually holds is still writable, so
      // the refusal above is the fence and not a store that refuses everything.
      const held = await store.update(TENANT, row().provisioningLease, { schemaVersion: 2 });
      expect(held.applied).toBe(true);
    });

    test('cleanup refuses to run against a row that reached ready, whatever its state says', async () => {
      await provision();
      const live = row();

      // The row `schema.sql` now refuses to store, handed to provisioning
      // anyway: `state='failed'` while the `ready_at` of a live tenant is still
      // on it. The lease is the first control and the CHECK is the second; this
      // is what is left when both are subverted, and it must abort rather than
      // proceed on a suspicion.
      const contradictory: TenantRecord = { ...live, state: 'failed', failureCode: 'timed_out' };
      const lyingStore: ControlPlaneStore = {
        ...store,
        get: () => Promise.resolve(contradictory),
      };
      deps = { ...deps, store: lyingStore };

      await expect(provision()).rejects.toThrow(
        'cleanup must never run against a tenant that reached ready',
      );
      expect(neon.live.has(live.neonProjectId ?? '')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('the wall clock and the abort signal', () => {
    test('a run that overruns its deadline is failed as timed_out, not left hanging', async () => {
      const slowNeon: NeonProjectApi = {
        ...neon,
        createProject: async (req) => {
          const created = await neon.createProject(req);
          clockMs += DEFAULT_PROVISION_DEADLINE_MS + 1;
          return created;
        },
      };
      deps = { ...deps, neon: slowNeon };

      const result = await provision();

      expect(result).toEqual({ ok: false, reason: 'timed_out', recorded: true });
      expect(row().failureCode).toBe('timed_out');
      expect(row().state).toBe('failed');
    });

    test('an aborted run stops at the next step and records why', async () => {
      const controller = new AbortController();
      const abortingNeon: NeonProjectApi = {
        ...neon,
        createProject: async (req) => {
          const created = await neon.createProject(req);
          controller.abort();
          return created;
        },
      };
      deps = { ...deps, neon: abortingNeon };

      const result = await provisionTenant(deps, {
        tenantId: TENANT,
        ftsLanguage: LANGUAGE,
        signal: controller.signal,
      });

      expect(result).toEqual({ ok: false, reason: 'cancelled', recorded: true });
      expect(log).not.toContain('schema.apply');
    });

    test('every port call is handed a signal, and an abort ends a call in flight', async () => {
      // The deadline used to be advisory: it was read between phases and never
      // reached the call itself, so a provider that never answered outlived both
      // the deadline and the window after which this run's row is presumed dead.
      const controller = new AbortController();
      const seen: (AbortSignal | undefined)[] = [];
      const signalNeon: NeonProjectApi = {
        ...neon,
        createProject: (req) => {
          seen.push(req.signal);
          return neon.createProject(req);
        },
        createRoleAndDatabase: (req) => {
          seen.push(req.signal);
          // A call that will never answer on its own. Only the signal ends it.
          return new Promise((_resolve, reject) => {
            req.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
            controller.abort();
          });
        },
      };
      deps = { ...deps, neon: signalNeon };

      const result = await provisionTenant(deps, {
        tenantId: TENANT,
        ftsLanguage: LANGUAGE,
        signal: controller.signal,
      });

      expect(result).toEqual({ ok: false, reason: 'cancelled', recorded: true });
      expect(seen).toHaveLength(2);
      expect(seen.every((signal) => signal !== undefined)).toBe(true);
    });

    test('a provider call that never returns is ended by the deadline, and recorded as timed_out', async () => {
      // A real, tiny wall-clock deadline. The injected clock never moves here,
      // so nothing cooperative can end this run: if the signal did not reach the
      // port, this test would hang — which is precisely what a hung provisioning
      // run does in production.
      const hangingNeon: NeonProjectApi = {
        ...neon,
        createProject: (req) =>
          new Promise((_resolve, reject) => {
            req.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      };
      deps = { ...deps, neon: hangingNeon, deadlineMs: 5 };

      const result = await provision();

      expect(result).toEqual({ ok: false, reason: 'timed_out', recorded: true });
      expect(row().failureCode).toBe('timed_out');
    });

    test('an interrupted call is recorded as the interruption, not as a provider failure', async () => {
      // The code a run banks is read by an operator and by the retry. Naming the
      // provider for a call the run itself cut off is a lie in the one record
      // anybody has.
      const controller = new AbortController();
      const abortingNeon: NeonProjectApi = {
        ...neon,
        createProject: (req) =>
          new Promise((_resolve, reject) => {
            req.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
            controller.abort();
          }),
      };
      deps = { ...deps, neon: abortingNeon };

      const result = await provisionTenant(deps, {
        tenantId: TENANT,
        ftsLanguage: LANGUAGE,
        signal: controller.signal,
      });

      expect(result).toEqual({ ok: false, reason: 'cancelled', recorded: true });
    });

    test('a stale window that does not outlive the deadline is refused, not obeyed', async () => {
      // The ordering was asserted for the two defaults and never for the values
      // actually in force. Reversed, the module manufactures its own takeover: a
      // live run is declared dead while it is still working.
      deps = { ...deps, deadlineMs: 60_000, staleAfterMs: 60_000 };

      await expect(provision()).rejects.toThrow('stale window must outlive');
      expect(store.rows.size).toBe(0);
      expect(neon.live.size).toBe(0);
    });

    test('a run aborted before it starts touches nothing', async () => {
      const controller = new AbortController();
      controller.abort();

      const result = await provisionTenant(deps, {
        tenantId: TENANT,
        ftsLanguage: LANGUAGE,
        signal: controller.signal,
      });

      expect(result).toEqual({ ok: false, reason: 'cancelled', recorded: false });
      expect(neon.live.size).toBe(0);
      expect(store.rows.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('nothing secret escapes the control plane', () => {
    test('the result carries references, never the secrets they point at', async () => {
      const result = await provision();
      const serialised = JSON.stringify(result);

      expect(serialised).not.toContain(CONNECTION_STRING);
      expect(serialised).not.toContain('pw-fake');
      expect(serialised).not.toContain(BEARER_GRANT);
      expect(serialised).toContain(tenantNamespace(TENANT));
    });

    test('the control-plane row carries references, never the secrets', async () => {
      await provision();
      const serialised = JSON.stringify(row());

      expect(serialised).not.toContain('pw-fake');
      expect(serialised).not.toContain(BEARER_GRANT);
    });

    test("a provider error carrying a connection string does not reach the row or the result", async () => {
      // The realistic leak: a driver error whose message quotes the DSN it was
      // handed. `failure_code` is an enum for exactly this reason.
      const leakyNeon: NeonProjectApi = {
        ...neon,
        createRoleAndDatabase: () =>
          Promise.reject(new Error(`connect failed: ${CONNECTION_STRING}`)),
      };
      deps = { ...deps, neon: leakyNeon };

      const result = await provision();
      const serialised = `${JSON.stringify(result)}${JSON.stringify(row())}`;

      expect(result.ok).toBe(false);
      expect(serialised).not.toContain('pw-fake');
      expect(serialised).not.toContain('example.invalid');
    });

    test('provisioning never mints an object-storage credential', async () => {
      // The parent R2 credential is not reachable from provisioning either: the
      // port provisioning accepts declares `prefixFor` and nothing else, and at
      // runtime the accessor is never asked for a credential.
      await provision();

      expect(storage.credentialCalls).toBe(0);
    });

    test('the prefix source provisioning accepts is narrower than the accessor', () => {
      // The point is what this port *cannot* express. Asserting the key count of
      // a literal the test just wrote proves nothing about the type; reaching
      // for the method that must not be there is the assertion that goes red if
      // the port ever widens, because `bun test` strips types but `tsc` does not.
      const narrow: ProvisionDeps['storage'] = {
        prefixFor: (): PrefixResult => ({ ok: false, reason: 'scope_denied' }),
      };
      expect(typeof narrow.prefixFor).toBe('function');
      // @ts-expect-error — `credentialFor` is not on this port, deliberately.
      expect(narrow.credentialFor).toBeUndefined();
    });

    test('provisioning cannot read a secret, and does not', async () => {
      // The same narrowing at the higher-stakes seam. A module that writes every
      // tenant's connection string and bearer has no business being *able* to
      // read them, and the port it declares is what makes that a type property
      // rather than a habit.
      const narrow: ProvisionDeps['secrets'] = {
        put: () => Promise.resolve({ ok: true }),
        revoke: () => Promise.resolve({ ok: true }),
      };
      expect(typeof narrow.put).toBe('function');
      expect(typeof narrow.revoke).toBe('function');
      // @ts-expect-error — a writer has no `resolve`: provisioning is
      // type-incapable of reading any tenant's secret.
      expect(narrow.resolve).toBeUndefined();

      // The runtime half: the full store is what is actually injected here, and
      // provisioning never reaches for the read it cannot declare.
      await provision();
      expect(log).not.toContain('secrets.resolve');
    });
  });

  // -------------------------------------------------------------------------
  describe('the tenant id is the same id everywhere', () => {
    test('an id the secret store could not namespace is refused before anything exists', async () => {
      const result = await provisionTenant(deps, {
        tenantId: 'Alice/../bob',
        ftsLanguage: LANGUAGE,
      });

      expect(result).toEqual({ ok: false, reason: 'invalid_tenant_id', recorded: false });
      expect(log).toEqual([]);
      expect(neon.live.size).toBe(0);
    });

    test('the storage prefix on the row is terminated and ends in this tenant', async () => {
      await provision();

      const prefix = row().storagePrefix ?? '';
      expect(prefix.endsWith('/')).toBe(true);
      expect(prefix.endsWith(`/${TENANT}/`)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('the control plane cannot be marked ready by halves', () => {
    test('the fake rejects a ready row with no bearer ref, as Postgres would', async () => {
      await provision();

      expect(() => store.put({ ...row(), bearerSecretRef: null })).toThrow(
        'ready_tenants_are_fully_provisioned',
      );
    });

    test('the fake rejects a failed row with no code, as Postgres would', async () => {
      await provision();

      expect(() => store.put({ ...row(), state: 'failed', failureCode: null })).toThrow(
        'failed_tenants_name_a_code',
      );
    });

    test('the fake rejects a failed row still carrying ready_at, as Postgres would', async () => {
      // The exact row a straggling run used to produce, and the reason the next
      // ordinary retry deleted a live user's database: `failed` is retryable at
      // once, and `ready_at` was left behind to prove the tenant had been
      // served. Neither the schema nor this fake could refuse it before.
      await provision();

      expect(() => store.put({ ...row(), state: 'failed', failureCode: 'timed_out' })).toThrow(
        'only_served_tenants_carry_a_ready_at',
      );
    });

    test("the fake rejects a prefix belonging to another tenant, as Postgres would", async () => {
      await provision();

      expect(() => store.put({ ...row(), storagePrefix: 'tenants/alice2/' })).toThrow(
        'storage_prefix_belongs_to_this_tenant',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-file pins. The control plane's vocabulary is declared in SQL; this
// module writes it. Drift between the two is a runtime constraint violation on
// a real tenant, so it is a test failure here instead.
// ---------------------------------------------------------------------------

describe('the failure vocabulary matches the schema that stores it', () => {
  const sql = Bun.file(new URL('../../src/control/schema.sql', import.meta.url).pathname);

  async function enumValues(typeName: string): Promise<string[]> {
    const text = await sql.text();
    const match = new RegExp(
      `CREATE TYPE control\\.${typeName} AS ENUM \\(([^)]*)\\)`,
      's',
    ).exec(text);
    if (match?.[1] === undefined) throw new Error(`test: no enum control.${typeName} in schema.sql`);
    return [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1] ?? '');
  }

  test('every provisioning failure code is a value the enum can hold', async () => {
    const declared = await enumValues('provisioning_failure');
    const codes: string[] = [...PROVISIONING_FAILURE_CODES];
    expect(codes.sort()).toEqual(declared.sort());
  });

  test('every tenant state this module writes is a value the enum can hold', async () => {
    const declared = await enumValues('tenant_state');
    const states: string[] = [...TENANT_STATES];
    expect(states.sort()).toEqual(declared.sort());
  });

  test('the FTS language pattern is the schema domain pattern', async () => {
    const text = await sql.text();
    const match = /CREATE DOMAIN control\.fts_language[\s\S]*?CHECK \(VALUE ~ '([^']+)'\)/.exec(text);
    expect(match?.[1]).toBe(FTS_LANGUAGE_PATTERN.source);
  });

  test('a failure code this module can produce is never outside the enum', () => {
    // Type-level: the union and the frozen list are the same set, so a new code
    // added to one without the other fails to compile.
    const codes: readonly ProvisioningFailureCode[] = PROVISIONING_FAILURE_CODES;
    expect(new Set(codes).size).toBe(codes.length);
  });
});
