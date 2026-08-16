/**
 * The five-leg account erasure runbook (R12), and the trap it is written
 * against.
 *
 * **"An erasure test passes trivially if the fixture never had a row in that
 * store."** Deleting nothing from an empty store looks exactly like deleting
 * everything from a full one, and a suite built that way stays green while a leg
 * is quietly removed. So every test below does three things in order:
 *
 *   1. **Seeds the store**, and asserts it is non-empty *before* erasure runs.
 *   2. **Runs the erasure.**
 *   3. **Asserts the store is empty afterwards** — the absence, not the call.
 *      A test that asserted "the fake was invoked" is a test of the
 *      orchestrator's call list, and a leg that called the wrong tenant's
 *      delete would pass it.
 *
 * The fourth leg is the one the roadmap singles out. `deleteExternalUser` has
 * existed since U9 with **no caller anywhere in `src/`**, deliberately left for
 * this unit: without it, live OAuth tokens to the erased user's mailbox persist
 * at a vendor inside the trust boundary and "no queryable trace" is false.
 *
 * And the receipt does not launder the vendor's honesty. `tokensRevoked` is
 * `'unverified'` and a 404/410 is `already_absent` rather than `deleted`,
 * because the question of whether Pipedream's deletion revokes the grant *at
 * Google* is a vendor answer nobody has in writing. A test pins the string.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { ERASURE_LEGS, eraseAccount, type ErasureDeps } from '../../../src/core/lifecycle/erasure.ts';
import { createInMemoryProviderKeyBackend, createTenantProviderKeyStore } from '../../../src/ai/keys.ts';
import {
  controlPlaneIdentity,
  createInMemorySecretBackend,
  createTenantSecretStore,
  tenantNamespace,
  type SecretBackend,
} from '../../../src/control/secrets.ts';
import { createTenantStorage, type TenantPrefix } from '../../../src/control/storage.ts';
import { createInMemoryCredentialMinter } from '../../../src/control/storage.ts';
import type { ClientOutcome, ExternalUserDeletion } from '../../../src/ingest/pipedream/client.ts';
import {
  connect as connectControl,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from '../../worker/fixture.ts';

import type { SQL } from 'bun';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

const TENANT = 'erasure-subject';
const OTHER = 'erasure-bystander';
const CALLER = controlPlaneIdentity();

let control: ControlFixture;
let controlSql: SQL;

/** An object store that can be emptied. `RawStore` (U8) has only put and get. */
function objectStore() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    list(prefix: TenantPrefix): Promise<readonly string[]> {
      return Promise.resolve([...objects.keys()].filter((key) => key.startsWith(prefix)));
    },
    deletePrefix(prefix: TenantPrefix): Promise<number> {
      let removed = 0;
      for (const key of [...objects.keys()]) {
        if (key.startsWith(prefix)) {
          objects.delete(key);
          removed += 1;
        }
      }
      return Promise.resolve(removed);
    },
  };
}

function neonApi() {
  const projects = new Set<string>();
  return {
    projects,
    deleteProject(projectId: string): Promise<void> {
      projects.delete(projectId);
      return Promise.resolve();
    },
  };
}

function pipedream(options: { readonly status?: 'deleted' | 'already_absent'; readonly fail?: boolean } = {}) {
  const externalUsers = new Set<string>();
  return {
    externalUsers,
    deleteExternalUser(request: {
      readonly externalUserId: string;
    }): Promise<ClientOutcome<ExternalUserDeletion>> {
      if (options.fail === true) {
        return Promise.resolve({ ok: false, reason: 'provider_error' as const, status: 500 });
      }
      const present = externalUsers.delete(request.externalUserId);
      return Promise.resolve({
        ok: true,
        value: {
          deleted: true,
          evidence: present ? ('deleted' as const) : ('already_absent' as const),
          // The vendor's honesty, carried rather than upgraded.
          tokensRevoked: 'unverified' as const,
        },
      });
    },
  };
}

interface Harness {
  readonly deps: ErasureDeps;
  readonly objects: ReturnType<typeof objectStore>;
  readonly neon: ReturnType<typeof neonApi>;
  readonly connect: ReturnType<typeof pipedream>;
  readonly secretBackend: SecretBackend;
  readonly providerKeyBackend: ReturnType<typeof createInMemoryProviderKeyBackend>;
}

async function harness(options: { readonly pipedreamFails?: boolean } = {}): Promise<Harness> {
  const objects = objectStore();
  const neon = neonApi();
  const connect = pipedream(options.pipedreamFails === true ? { fail: true } : {});

  const secretBackend = createInMemorySecretBackend();
  const secrets = createTenantSecretStore({ backend: secretBackend });
  const providerKeyBackend = createInMemoryProviderKeyBackend();
  const providerKeys = createTenantProviderKeyStore({ backend: providerKeyBackend });
  const storage = createTenantStorage({
    minter: createInMemoryCredentialMinter({
      parentAccessKeyId: 'fixture-key',
      parentSecretAccessKey: 'fixture-secret',
    }),
  });

  // Seed EVERY store. A leg that deletes from an empty store proves nothing.
  connect.externalUsers.add(TENANT);
  connect.externalUsers.add(OTHER);
  neon.projects.add(`proj-${TENANT}`);
  neon.projects.add(`proj-${OTHER}`);
  objects.objects.set(`tenants/${TENANT}/raw/one`, new Uint8Array([1]));
  objects.objects.set(`tenants/${TENANT}/raw/two`, new Uint8Array([2]));
  objects.objects.set(`tenants/${OTHER}/raw/one`, new Uint8Array([3]));
  await secrets.put(CALLER, TENANT, { connectionString: 'postgres://x', bearerGrant: 'b' });
  await secrets.put(CALLER, OTHER, { connectionString: 'postgres://y', bearerGrant: 'c' });
  await providerKeys.put(CALLER, TENANT, 'openai', 'sk-tenant');
  await providerKeys.put(CALLER, OTHER, 'openai', 'sk-bystander');

  return {
    deps: { connect, neon, objects, secrets, providerKeys, storage, control: controlSql, caller: CALLER },
    objects,
    neon,
    connect,
    secretBackend,
    providerKeyBackend,
  };
}

async function tenantRows(tenantId: string): Promise<number> {
  const rows = (await controlSql`
    SELECT count(*)::int AS n FROM control.tenant WHERE tenant_id = ${tenantId}
  `) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

beforeEach(async () => {
  if (control === undefined) {
    control = await createControlPlane('u17erase');
    controlSql = connectControl(control);
  }
  await controlSql`DELETE FROM control.tenant`;
  await seedTenant(controlSql, TENANT);
  await seedTenant(controlSql, OTHER);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await controlSql?.close();
  if (control !== undefined) await dropControlPlane(control);
});

describe('the runbook has five legs, and each is asserted by absence', () => {
  test(
    'the receipt names every leg the roadmap does, and no fewer',
    async () => {
      expect([...ERASURE_LEGS]).toEqual([
        'connector',
        'provider_key',
        'object_store',
        'neon',
        'control_plane',
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'leg 1 — the connector external user no longer resolves',
    async () => {
      const h = await harness();
      expect(h.connect.externalUsers.has(TENANT)).toBe(true);

      await eraseAccount(h.deps, { tenantId: TENANT });

      expect(h.connect.externalUsers.has(TENANT)).toBe(false);
      // And the bystander is untouched, or the leg is a truncate wearing a
      // tenant id.
      expect(h.connect.externalUsers.has(OTHER)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'leg 2 — no stored provider key remains',
    async () => {
      const h = await harness();
      expect(await h.providerKeyBackend.get(`provider-key/${TENANT}/openai`)).toBe('sk-tenant');

      await eraseAccount(h.deps, { tenantId: TENANT });

      expect(await h.providerKeyBackend.get(`provider-key/${TENANT}/openai`)).toBeUndefined();
      expect(await h.providerKeyBackend.get(`provider-key/${OTHER}/openai`)).toBe('sk-bystander');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'leg 3 — every object under the prefix is gone',
    async () => {
      const h = await harness();
      expect(h.objects.objects.size).toBe(3);

      await eraseAccount(h.deps, { tenantId: TENANT });

      expect([...h.objects.objects.keys()]).toEqual([`tenants/${OTHER}/raw/one`]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'leg 4 — the Neon project is gone',
    async () => {
      const h = await harness();
      expect(h.neon.projects.has(`proj-${TENANT}`)).toBe(true);

      await eraseAccount(h.deps, { tenantId: TENANT });

      expect(h.neon.projects.has(`proj-${TENANT}`)).toBe(false);
      expect(h.neon.projects.has(`proj-${OTHER}`)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'leg 5 — the control-plane row is gone, and so are the secrets it pointed at',
    async () => {
      const h = await harness();
      expect(await tenantRows(TENANT)).toBe(1);
      expect(await h.secretBackend.get(tenantNamespace(TENANT))).toBeDefined();

      await eraseAccount(h.deps, { tenantId: TENANT });

      expect(await tenantRows(TENANT)).toBe(0);
      expect(await tenantRows(OTHER)).toBe(1);
      // The sixth store, named rather than discovered later: a credential to a
      // database that no longer exists is still a queryable trace.
      expect(await h.secretBackend.get(tenantNamespace(TENANT))).toBeUndefined();
      expect(await h.secretBackend.get(tenantNamespace(OTHER))).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a complete run reports every leg, and reports complete',
    async () => {
      const h = await harness();
      const receipt = await eraseAccount(h.deps, { tenantId: TENANT });

      expect(receipt.legs.map((leg) => leg.leg)).toEqual([...ERASURE_LEGS]);
      expect(receipt.legs.every((leg) => leg.status === 'done' || leg.status === 'already_absent')).toBe(true);
      expect(receipt.complete).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the receipt does not claim what the vendor did not say', () => {
  test(
    'token revocation is reported unverified, and stays that way',
    async () => {
      const h = await harness();
      const receipt = await eraseAccount(h.deps, { tenantId: TENANT });
      // Promoting this to 'confirmed' without a written vendor answer would put
      // a false sentence in a privacy policy. See
      // docs/vendor/2026-08-12-pipedream-compliance.md.
      expect(receipt.tokensRevoked).toBe('unverified');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an external user that was already absent is not reported as deleted',
    async () => {
      const h = await harness();
      h.connect.externalUsers.delete(TENANT);

      const receipt = await eraseAccount(h.deps, { tenantId: TENANT });
      const leg = receipt.legs.find((entry) => entry.leg === 'connector');
      expect(leg?.status).toBe('already_absent');
      expect(receipt.complete).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a partial run is reported as partial, and keeps the record of what to retry', () => {
  test(
    'a failed leg does not report success',
    async () => {
      const h = await harness({ pipedreamFails: true });
      const receipt = await eraseAccount(h.deps, { tenantId: TENANT });

      expect(receipt.complete).toBe(false);
      expect(receipt.legs.find((leg) => leg.leg === 'connector')?.status).toBe('failed');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the control-plane row SURVIVES a failed leg, because it is the only record of what to retry',
    async () => {
      const h = await harness({ pipedreamFails: true });
      await eraseAccount(h.deps, { tenantId: TENANT });

      expect(await tenantRows(TENANT)).toBe(1);
      const receipt = await eraseAccount(h.deps, { tenantId: TENANT });
      expect(receipt.legs.find((leg) => leg.leg === 'control_plane')?.status).toBe('skipped');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the legs that CAN run still run — a stuck vendor does not hold the user\'s data hostage',
    async () => {
      const h = await harness({ pipedreamFails: true });
      await eraseAccount(h.deps, { tenantId: TENANT });

      expect([...h.objects.objects.keys()]).toEqual([`tenants/${OTHER}/raw/one`]);
      expect(h.neon.projects.has(`proj-${TENANT}`)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a re-run after the vendor recovers completes, and erasure is idempotent',
    async () => {
      const h = await harness({ pipedreamFails: true });
      await eraseAccount(h.deps, { tenantId: TENANT });

      const recovered: ErasureDeps = { ...h.deps, connect: pipedream() };
      const receipt = await eraseAccount(recovered, { tenantId: TENANT });
      expect(receipt.complete).toBe(true);
      expect(await tenantRows(TENANT)).toBe(0);

      const again = await eraseAccount(recovered, { tenantId: TENANT });
      expect(again.complete).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the stated time bound', () => {
  test(
    'the receipt carries the deletion SLA rather than leaving it to a support answer',
    async () => {
      const h = await harness();
      const receipt = await eraseAccount(h.deps, { tenantId: TENANT });
      // The platform PITR window, per the roadmap. Rows stop being queryable
      // immediately; they stop being *recoverable* when the window rolls.
      expect(receipt.unrecoverableAfterDays).toBe(7);
    },
    TEST_TIMEOUT_MS,
  );
});
