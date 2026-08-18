/**
 * The `purge` job kind, from the migration that makes it storable to the row the
 * tick writes.
 *
 * ============================================================================
 * WHAT WAS MISSING
 * ============================================================================
 *
 * `src/mcp/tombstone.ts:purgeExpiredTombstones` has existed since R12 with **no
 * production caller anywhere**. Every other mention of it in `src/` is a comment
 * reasoning from a sweep that does not run: the archive "is already swept by
 * `purgeExpiredTombstones`", a page snapshot "is deleted 72 hours later by
 * `purgeExpiredTombstones`". So `forget`'s 72-hour TTL was never once enforced,
 * and the fifth instance of this repo's most-produced defect — a function with
 * no caller beside a job kind with no handler — was sitting where a privacy
 * promise should have been.
 *
 * ============================================================================
 * THREE HALVES, TESTED AS THREE
 * ============================================================================
 *
 * An end-to-end test that seeds a queue and asserts a row appeared cannot say
 * *which* gap it closed, and every one of them alone leaves the capability
 * unreachable.
 *
 *   1. **The database can store the kind at all.** A live control plane was
 *      created from `src/control/schema.sql` before `purge` was in it, and there
 *      is no migration ladder for the control plane. The case below builds
 *      exactly that database — `schema.sql` with this rung's two changes
 *      stripped back out — and proves the insert fails, then that
 *      `ensurePurgeJobKind` makes it succeed. Without this the fleet's first
 *      tick answers `22P02` on a live deployment and green tests on a fresh one.
 *   2. **Something enqueues it**, on the slot the tenant is already woken for.
 *   3. **Something runs it**, and a run that does not finish completes the job
 *      rather than walking the retry ladder — because `exhausted: false` is the
 *      *expected* outcome of the first passes over a real backlog, and failing
 *      on it would dead-letter the retention lane of every brain that has any.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { SQL } from 'bun';

import { ensurePurgeJobKind } from '../../src/control/job-kinds.ts';
import { JOB_KINDS, LEGAL_TARGETS, retryPolicyFor } from '../../src/worker/jobs.ts';
import { createPurgeHandler, enqueueDuePurges } from '../../src/worker/purge.ts';
import { createJobQueue } from '../../src/worker/queue.ts';
import { ALPHA_CEILING_MS, nextCeilingDueAt } from '../../src/worker/scheduler.ts';
import type { JobLease } from '../../src/worker/jobs.ts';
import {
  ADMIN_DSN,
  connect as connectControl,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const TENANT = 'purge-alice';
const OTHER = 'purge-bob';
const NOW = new Date('2026-08-18T09:00:00.000Z');

let control: ControlFixture;
let controlSql: SQL;

beforeAll(async () => {
  control = await createControlPlane('purgejob');
  controlSql = connectControl(control, 4);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await controlSql?.close();
  if (control !== undefined) await dropControlPlane(control);
});

beforeEach(async () => {
  await controlSql`DELETE FROM control.job`;
  await controlSql`DELETE FROM control.tenant`;
});

// ---------------------------------------------------------------------------
// Half one: the live control plane learns the kind.
// ---------------------------------------------------------------------------

describe('a control plane created before this release can store the kind afterwards', () => {
  const database = 'brainz_control_purgejob_old';
  let oldSql: SQL;

  beforeEach(async () => {
    // The control plane as it stood before this rung: the real `schema.sql`
    // with exactly the two lines this change added taken back out. Anything
    // else — a hand-written subset, a fixture that skips the DDL — would be
    // testing a database no deployment has.
    const ddl = await Bun.file(`${import.meta.dir}/../../src/control/schema.sql`).text();
    const before = ddl
      .replace(/,\n  -- The 72-hour retention sweep[\s\S]*?\n  'purge'\n\);/, '\n);')
      .replace("    OR (kind = 'purge' AND target = 'whole_brain')\n", '');
    expect(before).not.toContain("'purge'");

    const admin = new SQL(ADMIN_DSN, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.unsafe(`CREATE DATABASE ${database}`);
    } finally {
      await admin.close();
    }
    const url = new URL(ADMIN_DSN);
    url.pathname = `/${database}`;
    oldSql = new SQL(url.toString(), { max: 2 });
    await oldSql.unsafe(before);
  }, SETUP_TIMEOUT_MS);

  afterEach(async () => {
    await oldSql?.close();
    const admin = new SQL(ADMIN_DSN, { max: 1 });
    try {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    } finally {
      await admin.close();
    }
  });

  test(
    'it refuses the kind before the rung and accepts it after, and the rung re-runs clean',
    async () => {
      await seedTenant(oldSql, TENANT);
      const queue = createJobQueue({ sql: oldSql });

      // The failure a live fleet would have taken on its first tick, every tick.
      let refusal = '';
      try {
        await queue.enqueue({
          tenantId: TENANT,
          kind: 'purge',
          target: 'whole_brain',
          trigger: 'time_ceiling',
          now: NOW,
        });
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      expect(refusal).toContain('purge');

      await ensurePurgeJobKind(oldSql);
      const enqueued = await queue.enqueue({
        tenantId: TENANT,
        kind: 'purge',
        target: 'whole_brain',
        trigger: 'time_ceiling',
        now: NOW,
      });
      expect(enqueued.enqueued).toBe(true);

      // Idempotent, because it runs at every boot of every process in the fleet
      // and most of those boots have nothing to do.
      await ensurePurgeJobKind(oldSql);
      await ensurePurgeJobKind(oldSql);
      const rows = (await oldSql`
        SELECT count(*)::int AS n FROM control.job WHERE kind = 'purge'::control.job_kind
      `) as Array<{ n: number }>;
      expect(rows[0]?.n).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and the migrated CHECK admits exactly the pairings the module declares',
    async () => {
      // The rule lives in two files that no third file reaches —
      // `src/control/schema.sql` for a fresh install and
      // `src/control/job-kinds.ts` for a live one. This is what keeps them from
      // drifting: every pairing `LEGAL_TARGETS` allows is inserted against the
      // migrated constraint, and an illegal one is refused by it.
      await seedTenant(oldSql, TENANT);
      await ensurePurgeJobKind(oldSql);
      const queue = createJobQueue({ sql: oldSql });

      for (const kind of JOB_KINDS) {
        for (const target of LEGAL_TARGETS[kind]) {
          const outcome = await queue.enqueue({
            tenantId: TENANT,
            kind,
            target,
            trigger: 'user_request',
            now: NOW,
          });
          expect(`${kind}/${target}: ${outcome.enqueued}`).toBe(`${kind}/${target}: true`);
        }
      }

      let refusal = '';
      try {
        await oldSql`
          INSERT INTO control.job (
            job_id, tenant_id, kind, target, state, trigger_reason,
            attempts, max_attempts, debt_observed, run_at, lease_token, created_at, updated_at
          ) VALUES (
            gen_random_uuid(), ${TENANT}, 'purge'::control.job_kind, 'gmail'::control.job_target,
            'due'::control.job_state, 'time_ceiling'::control.job_trigger,
            0, 5, 0, ${NOW}, 0, ${NOW}, ${NOW}
          )`;
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      expect(refusal).toContain('job_target_suits_its_kind');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Half two: something enqueues it.
// ---------------------------------------------------------------------------

// `enabled: true` on every call below, and deliberately not a default: the
// production tick reads `BRAINZ_PURGE_ENABLED` and this lane hard-deletes, so
// the off-by-default behaviour is pinned in `purge-gate.test.ts` rather than
// left as the absence of an assertion here.
describe('the tick enqueues a whole-brain purge for every ready tenant', () => {
  test('one job per ready tenant, and none for a tenant that is not', async () => {
    await seedTenant(controlSql, TENANT);
    await seedTenant(controlSql, OTHER);
    await seedTenant(controlSql, 'purge-unprovisioned', { state: 'provisioning' });

    const queue = createJobQueue({ sql: controlSql });
    const result = await enqueueDuePurges({ sql: controlSql, queue }, { now: NOW, enabled: true });

    expect(result.enqueued.map((row) => row.tenantId).sort()).toEqual([TENANT, OTHER].sort());
    const rows = (await controlSql`
      SELECT tenant_id, kind::text AS kind, target::text AS target, state::text AS state
        FROM control.job ORDER BY tenant_id
    `) as Array<Record<string, string>>;
    expect(rows.map((row) => `${row.tenant_id}/${row.kind}/${row.target}/${row.state}`)).toEqual([
      `${TENANT}/purge/whole_brain/due`,
      `${OTHER}/purge/whole_brain/due`,
    ]);
  });

  test('it lands on the tenant’s own consolidation slot, so it rides a wake already paid for', async () => {
    await seedTenant(controlSql, TENANT);
    const queue = createJobQueue({ sql: controlSql });

    const result = await enqueueDuePurges({ sql: controlSql, queue }, { now: NOW, enabled: true });

    // A salt of its own would spread the fleet's load more evenly and double the
    // number of times a suspended tenant compute is woken, which is the wrong
    // trade for a sweep whose ordinary outcome is eight empty claims.
    expect(result.enqueued[0]?.runAt.toISOString()).toBe(
      nextCeilingDueAt(TENANT, NOW, ALPHA_CEILING_MS).toISOString(),
    );
  });

  test('a second tick over a standing job enqueues nothing at all', async () => {
    await seedTenant(controlSql, TENANT);
    const queue = createJobQueue({ sql: controlSql });

    await enqueueDuePurges({ sql: controlSql, queue }, { now: NOW, enabled: true });
    const again = await enqueueDuePurges({ sql: controlSql, queue }, { now: NOW, enabled: true });

    // Not "refused once" — asked zero times. The queue's partial unique index is
    // the authority, but a tick that leaned on it would issue one INSERT per
    // ready tenant per minute for the life of the fleet.
    expect(again.due).toBe(0);
    expect(again.enqueued).toEqual([]);
    expect(again.refused).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Half three: something runs it.
// ---------------------------------------------------------------------------

describe('the handler', () => {
  function leaseFor(tenantId: string): JobLease {
    return {
      jobId: 'job-1',
      tenantId,
      kind: 'purge',
      target: 'whole_brain',
      leaseToken: 1,
      owner: 'w',
      expiresAt: NOW,
      attemptDeadlineAt: NOW,
      attempts: 1,
      maxAttempts: 5,
      debtObserved: 0,
    };
  }

  test('closes the tenant handle even when the sweep throws', async () => {
    let closed = 0;
    const handler = createPurgeHandler({
      open: () =>
        Promise.resolve({
          // A handle whose first statement fails is the shape a tenant database
          // mid-failover produces, and the connection must still be given back:
          // a worker that leaked one per failed job exhausts the per-tenant LRU
          // the whole runtime choice was made around.
          sql: { begin: () => Promise.reject(new Error('tenant unavailable')) } as unknown as SQL,
          close: () => {
            closed += 1;
            return Promise.resolve();
          },
        }),
    });

    await expect(handler({ lease: leaseFor(TENANT), signal: new AbortController().signal, now: NOW })).rejects.toThrow(
      /tenant unavailable/,
    );
    expect(closed).toBe(1);
  });

  test('a run that exhausts its budget completes the job rather than failing it', async () => {
    // The property this asserts is a *non*-throw, which is why the fake reports
    // the unfinished shape explicitly. `exhausted: false` is the expected
    // outcome of the first passes over an accumulated backlog; a handler that
    // treated it as a failure would walk the backoff ladder and dead-letter the
    // retention lane of every brain that has one.
    const published: string[] = [];
    const handler = createPurgeHandler({
      open: () =>
        Promise.resolve({
          sql: {
            begin: (fn: (tx: unknown) => unknown) =>
              Promise.resolve(
                fn({
                  unsafe: () => Promise.resolve([]),
                }),
              ),
          } as unknown as SQL,
          close: () => Promise.resolve(),
        }),
      onPurge: (tenantId, result) => published.push(`${tenantId}:${result.exhausted}`),
    });

    await handler({ lease: leaseFor(TENANT), signal: new AbortController().signal, now: NOW });
    expect(published).toEqual([`${TENANT}:true`]);
  });

  test('the lane stops loudly rather than limping, and has a policy at all', () => {
    // `retryPolicyFor` throws on a missing entry rather than resolving to
    // `undefined` and giving a lane a NaN ladder, so this is the registration
    // check as much as it is the policy one.
    expect(retryPolicyFor('purge')).toEqual({
      maxAttempts: 5,
      backoff: { baseMs: 30_000, maxMs: 15 * 60_000 },
    });
    expect(LEGAL_TARGETS.purge).toEqual(['whole_brain']);
  });
});
