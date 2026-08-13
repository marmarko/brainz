/**
 * Synchronous tenant provisioning (U2 approach steps 2, 5 and 6).
 *
 * One call turns a tenant id and a language choice into a ready tenant: a Neon
 * project, a role and database, the tenant schema applied under that language, a
 * verified first query, a stored bearer grant, and a control-plane row that says
 * `ready`. Synchronous and single-tenant on purpose — KTD1's alpha provisions one
 * at a time, and KTD9's per-tenant language choice is only coherent because the
 * user and their choice exist before the schema is applied. The warm pool that
 * makes this constant-time under concurrent signups is U15's.
 *
 * **The interesting states are all partial**, so the design here is about them
 * rather than about the happy path. Provisioning creates real, billable,
 * externally-visible resources in a specific order, and a run can die between
 * any two of them:
 *
 * | Died after… | What exists | What a retry does |
 * |---|---|---|
 * | validation | nothing at all | starts fresh; no row was written |
 * | the row claim | a `provisioning` row | re-claims it once it is stale |
 * | project create, response lost | a Neon project **nothing references** | finds it by its deterministic name and deletes it |
 * | project create, id banked | project + row that names it | deletes the project by id, recreates |
 * | role/database create | project, role, database | same — the project is the unit of cleanup |
 * | schema apply | a database with a schema | same |
 * | bearer mint + secret write | a grant nobody can route to | revokes it, mints a new one |
 * | mark ready | nothing partial — this is the end | nothing; `ready` is an absolute stop |
 *
 * Three rules follow from that table, and each is pinned by a test:
 *
 * 1. **Bank the id before using it.** Every provider id is written to the
 *    control-plane row before the next call is made, because a retry can only
 *    delete what it can name. The one case where that is impossible — a create
 *    that succeeded at the vendor and then failed to return — is why the project
 *    name is derived from the tenant id and never random: the deterministic name
 *    is the second handle on a resource whose id was lost.
 * 2. **The retry is the only thing that cleans up.** The failure path banks a
 *    code and leaves the artifacts recorded. Two cleanup implementations would
 *    drift, and the one that runs less often would be the wrong one.
 * 3. **`ready` is an absolute stop.** The idempotence that cleans up after a
 *    failure would delete a live user's database if it ran one state further, so
 *    a ready tenant short-circuits before any provider is touched.
 *
 * **The bearer grant is stored before the tenant is marked ready** (step 6). A
 * ready tenant without a grant is unreachable — U6 has nothing to authenticate
 * against and the user's brain is a billed resource nobody can open. A grant
 * without a ready tenant is inert, because nothing routes to a tenant that is not
 * ready, and the retry rotates it away. The asymmetry is the whole reason for the
 * order.
 *
 * **The FTS language is applied before the first write is accepted** (KTD9), and
 * an English-default silent fallback is forbidden. So the language is a required
 * field with no default, a missing or malformed one is refused before any
 * resource exists, and the first-query verification compares the language the
 * database *reports* against the one that was chosen. That last check is the one
 * that matters: a silent fallback produces a working tenant that stems every
 * document it will ever index with the wrong language, and nothing errors.
 *
 * **Failure codes are an enum, not a message.** Every reason maps onto a value
 * `control.provisioning_failure` can hold, pinned to `schema.sql` by test. A
 * driver error quoting the DSN it was handed is the ordinary way a connection
 * string lands in a content-free database; a code cannot carry one.
 *
 * **A note on the storage seam.** `storage.ts` gates prefix derivation on the
 * fleet identity for that tenant, so provisioning constructs one to derive the
 * prefix it must record. That is a real wart and it is contained deliberately:
 * the dependency this module declares is `TenantPrefixSource`, which has
 * `prefixFor` and nothing else, so provisioning is *type-incapable* of asking for
 * an object-storage credential even though the accessor it is handed can mint
 * one. The parent R2 credential stays out of this path as it stays out of the
 * request path (R10/R11).
 */

import {
  controlPlaneIdentity,
  fleetIdentity,
  isValidTenantId,
  tenantNamespace,
  type CallerIdentity,
  type TenantSecretStore,
} from './secrets.ts';
import type { PrefixResult } from './storage.ts';

/**
 * Every value `control.provisioning_failure` can hold. Frozen here and pinned to
 * `schema.sql` by test: a code this module can produce but the column cannot
 * store is a constraint violation raised on a tenant mid-failure, which is the
 * worst possible moment to discover it.
 */
export const PROVISIONING_FAILURE_CODES = [
  'project_create_failed',
  'role_create_failed',
  'schema_apply_failed',
  'first_query_failed',
  'secret_write_failed',
  'storage_prefix_failed',
  'timed_out',
  'cancelled',
] as const;

export type ProvisioningFailureCode = (typeof PROVISIONING_FAILURE_CODES)[number];

export const TENANT_STATES = ['provisioning', 'ready', 'failed', 'deleting'] as const;
export type TenantState = (typeof TENANT_STATES)[number];

export type TenantTier = 'free' | 'paid' | 'internal';

/**
 * Why a request was refused *before* anything was created. Deliberately a
 * different set from the failure codes: nothing was written, so nothing carries
 * a code, and a caller can tell "you asked for something impossible" apart from
 * "we tried and it broke".
 */
export const PROVISION_REJECTIONS = [
  'invalid_tenant_id',
  'missing_fts_language',
  'invalid_fts_language',
  'tenant_deleting',
  'provisioning_in_progress',
  'cancelled',
] as const;

export type ProvisionRejection = (typeof PROVISION_REJECTIONS)[number];

/** The `control.fts_language` domain's alphabet, pinned to `schema.sql` by test. */
export const FTS_LANGUAGE_PATTERN = /^[a-z][a-z_]{0,31}$/;

/**
 * The Postgres text-search configurations a stock server ships. Advisory: it is
 * exported so a signup form can offer a list, and U3 owns the authoritative one
 * once the tenant schema exists. Provisioning validates the *shape* against the
 * schema domain and lets an unlisted-but-legal name through rather than blocking
 * a tenant whose language a newer Postgres knows about and this list does not.
 */
export const KNOWN_FTS_LANGUAGES = [
  'simple',
  'arabic',
  'armenian',
  'basque',
  'catalan',
  'danish',
  'dutch',
  'english',
  'finnish',
  'french',
  'german',
  'greek',
  'hindi',
  'hungarian',
  'indonesian',
  'irish',
  'italian',
  'lithuanian',
  'nepali',
  'norwegian',
  'portuguese',
  'romanian',
  'russian',
  'serbian',
  'spanish',
  'swedish',
  'tamil',
  'turkish',
  'yiddish',
] as const;

/**
 * Step 5, and a pure cost lever: a tenant compute suspends one minute after its
 * last query. R13's idle anchor (≈$0.105/month, storage only) assumes it.
 */
export const TENANT_SUSPEND_TIMEOUT_SECONDS = 60;

/** The wall-clock ceiling on one run. Overrunning is a recorded `timed_out`. */
export const DEFAULT_PROVISION_DEADLINE_MS = 300_000;

/**
 * How long a `provisioning` row is presumed live. **Must exceed the deadline**: a
 * window shorter than the longest legal run declares a running attempt dead and
 * lets a second run delete the first one's project out from under it.
 */
export const DEFAULT_STALE_PROVISIONING_MS = 600_000;

export const DEFAULT_TENANT_TIER: TenantTier = 'free';

/** Constant per project, so a connection string never carries a tenant id. */
export const TENANT_ROLE_NAME = 'brainz_owner';
export const TENANT_DATABASE_NAME = 'brainz';

const PROJECT_NAME_PREFIX = 'brainz-';

/**
 * The control-plane row, as provisioning sees it. Content-free by construction:
 * ids, counters, timestamps and *references* into the secret store. Mirrors the
 * columns of `control.tenant` that this unit writes.
 */
export interface TenantRecord {
  readonly tenantId: string;
  readonly state: TenantState;
  readonly tier: TenantTier;
  readonly schemaVersion: number;
  readonly ftsLanguage: string;
  readonly neonProjectId: string | null;
  readonly neonBranchId: string | null;
  readonly neonDatabase: string | null;
  readonly neonRole: string | null;
  readonly connectionSecretRef: string | null;
  readonly bearerSecretRef: string | null;
  readonly storagePrefix: string | null;
  readonly provisioningStartedAt: number;
  readonly provisioningAttempts: number;
  readonly readyAt: number | null;
  readonly failureCode: ProvisioningFailureCode | null;
}

/** An absent key means "leave that column alone"; `null` means "clear it". */
export interface TenantPatch {
  readonly state?: TenantState;
  readonly schemaVersion?: number;
  readonly ftsLanguage?: string;
  readonly neonProjectId?: string | null;
  readonly neonBranchId?: string | null;
  readonly neonDatabase?: string | null;
  readonly neonRole?: string | null;
  readonly connectionSecretRef?: string | null;
  readonly bearerSecretRef?: string | null;
  readonly storagePrefix?: string | null;
  readonly provisioningStartedAt?: number;
  readonly provisioningAttempts?: number;
  readonly readyAt?: number | null;
  readonly failureCode?: ProvisioningFailureCode | null;
}

/**
 * `inserted: false` means the row already existed — the shape of
 * `INSERT … ON CONFLICT DO NOTHING`, which is how two racing signups for one id
 * resolve without either of them creating a second Neon project.
 */
export type InsertOutcome =
  | { readonly inserted: true; readonly record: TenantRecord }
  | { readonly inserted: false; readonly record: TenantRecord };

/**
 * The control-plane database, behind a port. A store failure is **not** flattened
 * into a provisioning failure: it propagates, exactly as `secrets.ts` propagates
 * a backend failure, because "the control plane is down" must never be recorded
 * on a tenant row as "this tenant is broken".
 */
export interface ControlPlaneStore {
  get(tenantId: string): Promise<TenantRecord | undefined>;
  insert(record: TenantRecord): Promise<InsertOutcome>;
  update(tenantId: string, patch: TenantPatch): Promise<TenantRecord>;
}

export interface CreateProjectRequest {
  readonly name: string;
  readonly suspendTimeoutSeconds: number;
}

export interface CreatedProject {
  readonly projectId: string;
  readonly branchId: string;
}

export interface CreateRoleAndDatabaseRequest {
  readonly projectId: string;
  readonly branchId: string;
  readonly roleName: string;
  readonly databaseName: string;
}

export interface CreatedRoleAndDatabase {
  readonly roleName: string;
  readonly databaseName: string;
  /** Request-path secret. It goes to the secret store and nowhere else. */
  readonly connectionString: string;
}

export interface NeonProjectSummary {
  readonly projectId: string;
  readonly name: string;
}

/**
 * The provider, behind a port; no vendor is hardcoded in this module.
 *
 * `searchProjectsByName` is named for what it is. Neon's list-projects `search`
 * matches *partial* names ("You can specify partial `name` or `id` values"), so
 * it returns candidates and the caller filters. A sweep that trusted it would
 * delete `brainz-alice2` while cleaning up after `alice` — the same
 * literal-substring hazard the R2 probe measured, in a second store, except here
 * the consequence is a deleted database rather than a leaked read.
 */
export interface NeonProjectApi {
  createProject(request: CreateProjectRequest): Promise<CreatedProject>;
  createRoleAndDatabase(request: CreateRoleAndDatabaseRequest): Promise<CreatedRoleAndDatabase>;
  /** Idempotent: deleting an already-absent project is a success. */
  deleteProject(projectId: string): Promise<void>;
  searchProjectsByName(name: string): Promise<readonly NeonProjectSummary[]>;
}

export interface SchemaApplyRequest {
  readonly connectionString: string;
  readonly ftsLanguage: string;
}

/**
 * What the tenant database itself reports. The language comes back from the
 * database rather than being echoed by the applier, because the failure KTD9
 * forbids is precisely a database quietly disagreeing with what was requested.
 */
export type FirstQueryResult =
  | { readonly ok: true; readonly ftsLanguage: string }
  | { readonly ok: false };

/** U3 owns the real one (`src/schema/tenant.sql` + its migration runner). */
export interface TenantSchemaApplier {
  apply(request: SchemaApplyRequest): Promise<{ readonly schemaVersion: number }>;
  verifyFirstQuery(request: { readonly connectionString: string }): Promise<FirstQueryResult>;
}

export interface BearerGrantMinter {
  mint(tenantId: string): Promise<string>;
}

/**
 * Deliberately narrower than `TenantStorage`. `TenantStorage` satisfies it
 * structurally, but nothing reached through this type can mint an
 * object-storage credential — the method is not on the type to call.
 */
export interface TenantPrefixSource {
  prefixFor(caller: CallerIdentity, tenantId: string): PrefixResult;
}

export interface ProvisionDeps {
  readonly neon: NeonProjectApi;
  readonly schema: TenantSchemaApplier;
  readonly store: ControlPlaneStore;
  readonly secrets: TenantSecretStore;
  readonly storage: TenantPrefixSource;
  readonly bearer: BearerGrantMinter;
  /** Injectable clock. Tests advance it; production passes nothing. */
  readonly now?: () => number;
  readonly deadlineMs?: number;
  readonly staleAfterMs?: number;
}

export interface ProvisionRequest {
  readonly tenantId: string;
  /** Required, with no default. A default is KTD9's forbidden silent fallback. */
  readonly ftsLanguage: string;
  readonly signal?: AbortSignal;
}

export type ProvisionResult =
  | { readonly ok: true; readonly tenant: TenantRecord; readonly alreadyReady: boolean }
  | { readonly ok: false; readonly reason: ProvisionRejection; readonly recorded: false }
  | { readonly ok: false; readonly reason: ProvisioningFailureCode; readonly recorded: true };

/**
 * The second handle on a project whose id was lost. Derived from the tenant id
 * and never random, because a create that succeeds at the vendor and then fails
 * to return leaves a resource that nothing in the control plane can name.
 */
export function neonProjectName(tenantId: string): string {
  return `${PROJECT_NAME_PREFIX}${tenantId}`;
}

/**
 * 256 bits from the platform CSPRNG, hex-encoded. Production default; tests
 * inject a fake. Web Crypto rather than `node:crypto` because the fleet runs on
 * Cloudflare's runtime, where this is the primitive that exists everywhere.
 */
export function createRandomBearerGrantMinter(): BearerGrantMinter {
  return {
    mint: () => {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return Promise.resolve(
        Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
      );
    },
  };
}

function isValidFtsLanguage(language: string): boolean {
  return FTS_LANGUAGE_PATTERN.test(language);
}

/** A run stops for one of two reasons that are nobody's fault but the clock's. */
type StopReason = 'timed_out' | 'cancelled';

export async function provisionTenant(
  deps: ProvisionDeps,
  request: ProvisionRequest,
): Promise<ProvisionResult> {
  const { neon, schema, store, secrets, storage, bearer } = deps;
  const now = deps.now ?? Date.now;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_PROVISION_DEADLINE_MS;
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_PROVISIONING_MS;
  const { tenantId, ftsLanguage } = request;

  const startedAt = now();
  const deadline = startedAt + deadlineMs;

  // -------------------------------------------------------------------------
  // Phase A — validate. Nothing external is touched and no row is written, so
  // an impossible request never leaves a billable resource behind. The language
  // rules live here for that reason: KTD9's tenant must fail loudly at the
  // cheapest possible moment, not quietly at the most expensive one.
  // -------------------------------------------------------------------------
  if (!isValidTenantId(tenantId)) {
    return { ok: false, reason: 'invalid_tenant_id', recorded: false };
  }
  if (ftsLanguage.length === 0) {
    return { ok: false, reason: 'missing_fts_language', recorded: false };
  }
  if (!isValidFtsLanguage(ftsLanguage)) {
    return { ok: false, reason: 'invalid_fts_language', recorded: false };
  }
  if (request.signal?.aborted === true) {
    return { ok: false, reason: 'cancelled', recorded: false };
  }

  // -------------------------------------------------------------------------
  // Phase B — claim the row, or triage the one already there.
  // -------------------------------------------------------------------------
  const existing = await store.get(tenantId);
  let record: TenantRecord;

  if (existing === undefined) {
    const claimed = await store.insert({
      tenantId,
      state: 'provisioning',
      tier: DEFAULT_TENANT_TIER,
      schemaVersion: 0,
      ftsLanguage,
      neonProjectId: null,
      neonBranchId: null,
      neonDatabase: null,
      neonRole: null,
      connectionSecretRef: null,
      bearerSecretRef: null,
      storagePrefix: null,
      provisioningStartedAt: startedAt,
      provisioningAttempts: 1,
      readyAt: null,
      failureCode: null,
    });

    // Lost the insert race: whoever won it is provisioning this tenant right now.
    if (!claimed.inserted) {
      return { ok: false, reason: 'provisioning_in_progress', recorded: false };
    }
    record = claimed.record;
  } else {
    // The absolute stop. A ready tenant holds a live user's data, so the cleanup
    // below must never see one.
    if (existing.state === 'ready') {
      return { ok: true, tenant: existing, alreadyReady: true };
    }
    if (existing.state === 'deleting') {
      return { ok: false, reason: 'tenant_deleting', recorded: false };
    }
    // A `provisioning` row that was touched recently may be a run still going.
    // A `failed` row is a run that finished and said so — retryable at once,
    // because a user waiting at a signup form should not serve a stale window.
    if (existing.state === 'provisioning' && now() - existing.provisioningStartedAt < staleAfterMs) {
      return { ok: false, reason: 'provisioning_in_progress', recorded: false };
    }

    // The one cleanup owner. Everything the previous attempt may have created is
    // removed here, and only here.
    await cleanUpAfterFailedAttempt(neon, secrets, existing);

    record = await store.update(tenantId, {
      state: 'provisioning',
      ftsLanguage,
      schemaVersion: 0,
      neonProjectId: null,
      neonBranchId: null,
      neonDatabase: null,
      neonRole: null,
      connectionSecretRef: null,
      bearerSecretRef: null,
      storagePrefix: null,
      provisioningStartedAt: startedAt,
      provisioningAttempts: existing.provisioningAttempts + 1,
      readyAt: null,
      failureCode: null,
    });
  }

  /** Bank a code on the row and stop. Artifacts stay recorded for the retry. */
  async function fail(code: ProvisioningFailureCode): Promise<ProvisionResult> {
    await store.update(tenantId, { state: 'failed', failureCode: code });
    return { ok: false, reason: code, recorded: true };
  }

  function stopped(): StopReason | undefined {
    if (request.signal?.aborted === true) return 'cancelled';
    if (now() > deadline) return 'timed_out';
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Phase C — derive the prefix. Local and free, and it happens before anything
  // billable exists, so `storage_prefix_failed` is always the cheapest failure.
  // -------------------------------------------------------------------------
  const prefix = storage.prefixFor(fleetIdentity(tenantId), tenantId);
  if (!prefix.ok) return fail('storage_prefix_failed');
  record = await store.update(tenantId, { storagePrefix: prefix.prefix });

  // -------------------------------------------------------------------------
  // Phase D — create the tenant's substrate. Every id is banked on the row
  // before the next call is made.
  // -------------------------------------------------------------------------
  const stopBeforeProject = stopped();
  if (stopBeforeProject !== undefined) return fail(stopBeforeProject);

  let project: CreatedProject;
  try {
    project = await neon.createProject({
      name: neonProjectName(tenantId),
      suspendTimeoutSeconds: TENANT_SUSPEND_TIMEOUT_SECONDS,
    });
  } catch {
    // The error is deliberately not read. A provider error quoting the DSN it was
    // handed is the ordinary way a connection string reaches a content-free
    // database, and a code cannot carry one.
    return fail('project_create_failed');
  }
  record = await store.update(tenantId, {
    neonProjectId: project.projectId,
    neonBranchId: project.branchId,
  });

  const stopBeforeRole = stopped();
  if (stopBeforeRole !== undefined) return fail(stopBeforeRole);

  let roleAndDatabase: CreatedRoleAndDatabase;
  try {
    roleAndDatabase = await neon.createRoleAndDatabase({
      projectId: project.projectId,
      branchId: project.branchId,
      roleName: TENANT_ROLE_NAME,
      databaseName: TENANT_DATABASE_NAME,
    });
  } catch {
    return fail('role_create_failed');
  }
  record = await store.update(tenantId, {
    neonDatabase: roleAndDatabase.databaseName,
    neonRole: roleAndDatabase.roleName,
  });

  // Held in memory only, until the single secret write below.
  const connectionString = roleAndDatabase.connectionString;

  // -------------------------------------------------------------------------
  // Phase E — apply the schema under this tenant's language, then make the
  // database prove it (KTD9).
  // -------------------------------------------------------------------------
  const stopBeforeSchema = stopped();
  if (stopBeforeSchema !== undefined) return fail(stopBeforeSchema);

  let applied: { readonly schemaVersion: number };
  try {
    applied = await schema.apply({ connectionString, ftsLanguage });
  } catch {
    return fail('schema_apply_failed');
  }
  // `ready` requires `schema_version > 0` in the schema's own CHECK, so an
  // applier reporting 0 has not produced a servable tenant.
  if (applied.schemaVersion <= 0) return fail('schema_apply_failed');
  record = await store.update(tenantId, { schemaVersion: applied.schemaVersion });

  const stopBeforeVerify = stopped();
  if (stopBeforeVerify !== undefined) return fail(stopBeforeVerify);

  let verified: FirstQueryResult;
  try {
    verified = await schema.verifyFirstQuery({ connectionString });
  } catch {
    return fail('first_query_failed');
  }
  if (!verified.ok) return fail('first_query_failed');
  // The silent fallback, caught. A tenant that asked for Spanish and got English
  // works perfectly and indexes everything wrong, forever.
  if (verified.ftsLanguage !== ftsLanguage) return fail('schema_apply_failed');

  // -------------------------------------------------------------------------
  // Phase F — the grant, stored BEFORE ready. Both halves of the tenant's secret
  // go in one write: the store replaces whole entries, so a two-step write would
  // publish an entry carrying a placeholder for whichever half came second.
  // -------------------------------------------------------------------------
  const stopBeforeGrant = stopped();
  if (stopBeforeGrant !== undefined) return fail(stopBeforeGrant);

  let bearerGrant: string;
  try {
    bearerGrant = await bearer.mint(tenantId);
  } catch {
    return fail('secret_write_failed');
  }

  const written = await secrets.put(controlPlaneIdentity(), tenantId, {
    connectionString,
    bearerGrant,
  });
  if (!written.ok) return fail('secret_write_failed');

  const secretRef = tenantNamespace(tenantId);
  record = await store.update(tenantId, {
    connectionSecretRef: secretRef,
    bearerSecretRef: secretRef,
  });

  // -------------------------------------------------------------------------
  // Phase G — ready. The last write, and the only one that makes the tenant
  // routable.
  // -------------------------------------------------------------------------
  record = await store.update(tenantId, {
    state: 'ready',
    readyAt: now(),
    failureCode: null,
  });

  return { ok: true, tenant: record, alreadyReady: false };
}

/**
 * Undo whatever the previous attempt managed to create. Reached only from the
 * retry path, and never for a `ready` tenant.
 *
 * The name sweep is the half that needs care. Neon's `search` is a substring
 * match, so cleaning up after `alice` gets `brainz-alice2` in the candidate list
 * — a sibling tenant's entire database, one careless `for` loop from deletion.
 * Only an exact name match is deleted.
 */
async function cleanUpAfterFailedAttempt(
  neon: NeonProjectApi,
  secrets: TenantSecretStore,
  record: TenantRecord,
): Promise<void> {
  if (record.neonProjectId !== null) {
    await neon.deleteProject(record.neonProjectId);
  }

  // The project whose id never arrived. Its deterministic name is the only
  // handle left on it.
  const wanted = neonProjectName(record.tenantId);
  const candidates = await neon.searchProjectsByName(wanted);
  for (const candidate of candidates) {
    if (candidate.name !== wanted) continue;
    await neon.deleteProject(candidate.projectId);
  }

  // A grant from a run that never finished routes to nothing, but it is live
  // credential material and the next attempt mints a fresh one.
  await secrets.revoke(controlPlaneIdentity(), record.tenantId);
}
