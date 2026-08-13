/**
 * The warm pool: the claim under concurrency, KTD9's assignment-time language,
 * and the number this unit refuses to invent.
 *
 * **What is not tested here, and why.** Nothing measures whether the pool is
 * *worth* having, because that number is U2's committed create-to-first-query
 * benchmark and it does not exist — the run is gated on `BRAINZ_REAL_SUBSTRATE`
 * and every iteration creates a billable Neon project. This unit may not create
 * cloud resources, so pool sizing is reported `deferred`. What is tested is that
 * the machinery is correct and that it **refuses to run unsized**, which is the
 * honest shape for a component whose justification is a measurement nobody has
 * taken.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import {
  PoolNotSizedError,
  assignPoolProject,
  claimPoolProject,
  fillPool,
  newPoolId,
  poolDepth,
} from '../../src/control/pool.ts';
import {
  adminIdentity,
  controlPlaneIdentity,
  createInMemorySecretBackend,
  createTenantSecretStore,
  fleetIdentity,
  poolNamespace,
  tenantNamespace,
} from '../../src/control/secrets.ts';
import {
  connect,
  createControlPlane,
  dropControlPlane,
  type ControlFixture,
} from '../worker/fixture.ts';

const AT = new Date('2026-08-13T09:00:00.000Z');

let fixture: ControlFixture;
let sql: SQL;

beforeAll(async () => {
  fixture = await createControlPlane('pool');
  sql = connect(fixture, 8);
}, 60_000);

afterAll(async () => {
  await sql?.close();
  if (fixture) await dropControlPlane(fixture);
});

async function reset(): Promise<void> {
  await sql`DELETE FROM control.pool_project`;
  await sql`DELETE FROM control.tenant`;
}

function store() {
  return createTenantSecretStore({ backend: createInMemorySecretBackend() });
}

/**
 * Run a statement expected to be refused and answer the message.
 *
 * `expect(sql\`…\`).rejects` does not work here: Bun's tagged template is a lazy
 * query object rather than a live promise, and handing it to a matcher never
 * starts it — the test hangs on a statement that was never sent, which reads as a
 * database problem and is not one.
 */
async function refused(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'the statement was accepted';
}

/** A fake vendor. Deterministic ids, so an assertion can name one. */
function vendor() {
  const created: string[] = [];
  return {
    created,
    create(poolId: string) {
      created.push(poolId);
      return Promise.resolve({
        neonProjectId: `proj-${poolId}`,
        neonBranchId: `br-${poolId}`,
        neonDatabase: 'brainz',
        neonRole: 'brainz_owner',
        connectionString: `postgres://brainz_owner:secret@${poolId}.example.invalid/brainz`,
      });
    },
  };
}

// ---------------------------------------------------------------------------

describe('the pool refuses to be sized by accident', () => {
  test('filling with no target throws rather than choosing a number', async () => {
    await reset();
    const api = vendor();
    await expect(
      fillPool({ sql, create: api.create, secrets: store(), caller: controlPlaneIdentity() }, {}),
    ).rejects.toThrow(PoolNotSizedError);
    expect(api.created).toEqual([]);
  });

  test('zero is a legal target and means synchronous provisioning', async () => {
    await reset();
    const api = vendor();
    const report = await fillPool(
      { sql, create: api.create, secrets: store(), caller: controlPlaneIdentity() },
      { target: 0 },
    );
    expect(report).toEqual({ created: 0, failed: 0, ready: 0 });
    expect(api.created).toEqual([]);
  });
});

describe('filling', () => {
  test('a fill brings the pool up to its target and stores each connection string', async () => {
    await reset();
    const secrets = store();
    const api = vendor();
    const report = await fillPool(
      { sql, create: api.create, secrets, caller: controlPlaneIdentity() },
      { target: 3 },
    );

    expect(report).toMatchObject({ created: 3, failed: 0, ready: 3 });
    expect(await poolDepth(sql)).toBe(3);

    const first = api.created[0] ?? '';
    const resolved = await secrets.resolvePool(controlPlaneIdentity(), first);
    expect(resolved).toEqual({
      ok: true,
      secret: { connectionString: `postgres://brainz_owner:secret@${first}.example.invalid/brainz` },
    });
  });

  test('a second fill adds only the difference', async () => {
    await reset();
    const secrets = store();
    const api = vendor();
    const deps = { sql, create: api.create, secrets, caller: controlPlaneIdentity() };
    await fillPool(deps, { target: 2 });
    const second = await fillPool(deps, { target: 3 });
    expect(second).toMatchObject({ created: 1, ready: 3 });
  });

  test('a vendor failure retires its row rather than deleting it', async () => {
    await reset();
    const secrets = store();
    const report = await fillPool(
      {
        sql,
        create: () => Promise.reject(new Error('the vendor said no')),
        secrets,
        caller: controlPlaneIdentity(),
      },
      { target: 2 },
    );

    expect(report).toMatchObject({ created: 0, failed: 1, ready: 0 });
    // The row survives, because it is the only record that we may be paying for
    // a project a reconciliation sweep has to find.
    const rows = await sql<{ state: string }[]>`SELECT state::text AS state FROM control.pool_project`;
    expect(rows).toEqual([{ state: 'retired' }]);
  });
});

describe('the claim is a compare-and-set', () => {
  test('one project goes to one tenant when several claim at once', async () => {
    await reset();
    const secrets = store();
    const api = vendor();
    await fillPool({ sql, create: api.create, secrets, caller: controlPlaneIdentity() }, { target: 1 });

    const claims = await Promise.all([
      claimPoolProject(sql, { tenantId: 'alice', now: AT }),
      claimPoolProject(sql, { tenantId: 'bob', now: AT }),
      claimPoolProject(sql, { tenantId: 'carol', now: AT }),
    ]);

    // Exactly one winner. The losers are told the pool is empty and fall back to
    // synchronous provisioning; the alternative — two signups handed the same
    // project — is two tenants applying a schema to one database.
    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
    expect(claims.filter((claim) => !claim.ok)).toHaveLength(2);
    for (const claim of claims) {
      if (!claim.ok) expect(claim.reason).toBe('pool_empty');
    }

    const rows = await sql<{ state: string; claimed_by: string | null }[]>`
      SELECT state::text AS state, claimed_by FROM control.pool_project`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('claimed');
    expect(['alice', 'bob', 'carol']).toContain(rows[0]?.claimed_by ?? '');
  });

  test('an empty pool is a refusal, not a wait', async () => {
    await reset();
    expect(await claimPoolProject(sql, { tenantId: 'alice', now: AT })).toEqual({
      ok: false,
      reason: 'pool_empty',
    });
  });
});

describe('assignment applies KTD9 language before anything else', () => {
  async function assign(ftsLanguage: string) {
    const secrets = store();
    const api = vendor();
    await fillPool({ sql, create: api.create, secrets, caller: controlPlaneIdentity() }, { target: 1 });

    const applied: { connectionString: string; ftsLanguage: string }[] = [];
    const outcome = await assignPoolProject(
      {
        sql,
        secrets,
        caller: controlPlaneIdentity(),
        applySchema: (request) => {
          applied.push({ ...request });
          return Promise.resolve({ schemaVersion: 7 });
        },
        mintBearer: (tenantId) => Promise.resolve(`bzk_${tenantId}_secret`),
      },
      { tenantId: 'alice', ftsLanguage, now: AT },
    );
    return { outcome, applied, secrets, poolId: api.created[0] ?? '' };
  }

  test('the schema is applied with the tenant language, not a default', async () => {
    await reset();
    const { outcome, applied } = await assign('spanish');

    expect(outcome.ok).toBe(true);
    expect(applied).toHaveLength(1);
    // KTD9's forbidden failure is silent English. A pool project cannot carry a
    // language at all — the DDL refuses to be applied without one — so the only
    // place it can arrive is here.
    expect(applied[0]?.ftsLanguage).toBe('spanish');
  });

  test('a missing language refuses, and does not consume a project', async () => {
    await reset();
    const { outcome } = await assign('');
    expect(outcome).toEqual({ ok: false, reason: 'missing_fts_language' });
    expect(await poolDepth(sql)).toBe(1);
  });

  test('the connection string moves to the tenant namespace and leaves the pool one', async () => {
    await reset();
    const { outcome, secrets, poolId } = await assign('simple');
    expect(outcome.ok).toBe(true);

    // The tenant can now resolve it, by its own fleet identity and no other.
    const asTenant = await secrets.resolve(fleetIdentity('alice'), 'alice');
    expect(asTenant.ok).toBe(true);

    // And the pool entry is gone, so the narrow control-plane pool permission no
    // longer reaches this project's string.
    expect(await secrets.resolvePool(controlPlaneIdentity(), poolId)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  test('the assignment reports the refs the control-plane row records', async () => {
    await reset();
    const { outcome } = await assign('simple');
    if (!outcome.ok) throw new Error('assignment failed');
    expect(outcome.connectionSecretRef).toBe(tenantNamespace('alice'));
    expect(outcome.bearerSecretRef).toBe(tenantNamespace('alice'));
    expect(outcome.schemaVersion).toBe(7);
  });
});

describe('the pool namespace is a different namespace, with a different permission', () => {
  test('pool and tenant namespaces cannot collide however the ids are chosen', () => {
    expect(poolNamespace('alice')).not.toBe(tenantNamespace('alice'));
    expect(poolNamespace('alice').startsWith('pool/')).toBe(true);
    expect(tenantNamespace('alice').startsWith('tenant/')).toBe(true);
  });

  test('the control plane can read a pool entry and still cannot read any tenant entry', async () => {
    const secrets = store();
    await secrets.putPool(controlPlaneIdentity(), 'pool-abc', { connectionString: 'postgres://x' });
    await secrets.put(controlPlaneIdentity(), 'alice', {
      connectionString: 'postgres://alice',
      bearerGrant: 'bzk_alice_x',
    });

    expect((await secrets.resolvePool(controlPlaneIdentity(), 'pool-abc')).ok).toBe(true);
    // Rule 3 still holds where it was always the point: the identity that writes
    // tenant secrets cannot read them.
    expect(await secrets.resolve(controlPlaneIdentity(), 'alice')).toEqual({
      ok: false,
      reason: 'scope_denied',
    });
  });

  test('the fleet and admin identities cannot read a pool entry either', async () => {
    const secrets = store();
    await secrets.putPool(controlPlaneIdentity(), 'pool-abc', { connectionString: 'postgres://x' });

    for (const caller of [fleetIdentity('pool-abc'), adminIdentity()]) {
      expect(await secrets.resolvePool(caller, 'pool-abc')).toEqual({
        ok: false,
        reason: 'scope_denied',
      });
    }
  });

  test('a pool id is addressable as a namespace', () => {
    // A generated id that the namespace derivation refuses would be a project
    // the pool could create and never reach.
    for (let i = 0; i < 20; i += 1) {
      expect(newPoolId()).toMatch(/^pool-[a-f0-9]{24}$/);
    }
  });
});

describe('a claimed project belongs to exactly one tenant', () => {
  test('the database refuses one tenant holding two projects', async () => {
    await reset();
    const secrets = store();
    const api = vendor();
    await fillPool({ sql, create: api.create, secrets, caller: controlPlaneIdentity() }, { target: 2 });

    expect((await claimPoolProject(sql, { tenantId: 'alice', now: AT })).ok).toBe(true);

    // The second claim is written directly, bypassing `claimPoolProject`: the
    // database is what has to refuse this, not the code path that happens to sit
    // in front of it today. A tenant holding two projects is a project we pay for
    // and no tenant will ever use.
    await expect(
      refused(async () => {
        await sql`
          UPDATE control.pool_project
          SET state = 'claimed', claimed_by = 'alice', claimed_at = ${AT}
          WHERE state = 'ready'`;
      }),
    ).resolves.toMatch(/pool_project_claimant_is_exclusive/);
  });

  test('a claimed row that names nobody is unrepresentable', async () => {
    await reset();
    await expect(
      refused(async () => {
        await sql`
          INSERT INTO control.pool_project (pool_id, state, created_at)
          VALUES ('pool-orphan', 'claimed', ${AT})`;
      }),
    ).resolves.toMatch(/claimed_pool_projects_name_a_tenant/);
  });
});
