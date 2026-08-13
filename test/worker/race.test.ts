/**
 * **Two workers, one job.** The scenario the whole unit is built around, and the
 * first test written.
 *
 * A queue that hands one job to two workers is not a queue with a rare bug; it
 * is a queue that runs every tenant's consolidation twice, doubles the model
 * spend it was capped on, and lets two cycles interleave their writes into one
 * brain. Nothing about that surfaces as an error — both workers report success —
 * which is why it is the assertion this file leads with instead of a happy-path
 * enqueue-and-claim.
 *
 * Everything here runs against a real Postgres. `SELECT … FOR UPDATE SKIP
 * LOCKED` is the mechanism, and it is a property of the database's lock manager,
 * not of the SQL text: an in-memory fake asserting "exactly one winner" would
 * pass against a query with no locking in it at all.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { createJobQueue, type PostgresJobQueue } from '../../src/worker/queue.ts';
import { connect, countJobs, createControlPlane, dropControlPlane, seedTenant, type ControlFixture } from './fixture.ts';

const TENANT = 'race-tenant';
const T0 = new Date('2026-08-12T00:00:00Z');

/** Long enough that nothing in this file expires by accident. */
const LEASE_TTL_MS = 60_000;
const MAX_ATTEMPT_MS = 300_000;

let fixture: ControlFixture;
/** Deliberately more than one connection: the workers race in parallel. */
let sql: SQL;
let queue: PostgresJobQueue;

beforeAll(async () => {
  fixture = await createControlPlane('race');
  sql = connect(fixture, 8);
  queue = createJobQueue({ sql });
});

afterAll(async () => {
  await sql.close();
  await dropControlPlane(fixture);
});

beforeEach(async () => {
  await sql`DELETE FROM control.job`;
  await sql`DELETE FROM control.tenant`;
  await seedTenant(sql, TENANT);
});

async function enqueueOne(): Promise<string> {
  const outcome = await queue.enqueue({
    tenantId: TENANT,
    kind: 'consolidate',
    target: 'whole_brain',
    trigger: 'time_ceiling',
    now: T0,
  });
  if (!outcome.enqueued) throw new Error(`expected an enqueue, got ${outcome.reason}`);
  return outcome.job.jobId;
}

describe('two workers race for one job', () => {
  test('exactly one worker wins, and the loser is told nothing was claimed', async () => {
    const jobId = await enqueueOne();

    const [a, b] = await Promise.all([
      queue.claim({ owner: 'worker-a', now: T0, leaseTtlMs: LEASE_TTL_MS, maxAttemptMs: MAX_ATTEMPT_MS }),
      queue.claim({ owner: 'worker-b', now: T0, leaseTtlMs: LEASE_TTL_MS, maxAttemptMs: MAX_ATTEMPT_MS }),
    ]);

    const winners = [a, b].filter((lease) => lease !== undefined);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.jobId).toBe(jobId);
    expect(winners[0]?.leaseToken).toBe(1);

    // One job, one attempt. A queue that hands the row out twice also counts the
    // attempt twice, which walks a healthy job toward the dead-letter ladder.
    await expect(countJobs(sql, TENANT)).resolves.toBe(1);
    const rows = (await sql`SELECT attempts, state FROM control.job WHERE job_id = ${jobId}::uuid`) as unknown as {
      attempts: number;
      state: string;
    }[];
    expect(rows[0]).toEqual({ attempts: 1, state: 'running' });
  });

  test('eight workers racing for one job produce one winner and seven empty hands', async () => {
    // Two is the smallest race and the easiest to pass by luck. Eight against a
    // single row is where a claim that reads and then writes — rather than
    // locking — reliably hands the same row out more than once.
    await enqueueOne();

    const claims = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        queue.claim({
          owner: `worker-${i}`,
          now: T0,
          leaseTtlMs: LEASE_TTL_MS,
          maxAttemptMs: MAX_ATTEMPT_MS,
        }),
      ),
    );

    expect(claims.filter((lease) => lease !== undefined)).toHaveLength(1);
  });

  test('eight workers racing for eight jobs claim one each — the lock skips, it does not serialize', async () => {
    // The other half of `SKIP LOCKED`, and the reason a plain `FOR UPDATE` is
    // not good enough: eight workers must not queue behind each other for eight
    // distinct rows. Without `SKIP LOCKED` this still passes eventually, so the
    // assertion is on the distribution, which is what degrades.
    for (const target of ['gmail', 'calendar', 'drive'] as const) {
      const outcome = await queue.enqueue({
        tenantId: TENANT,
        kind: 'ingest_pull',
        target,
        trigger: 'connector_cadence',
        now: T0,
      });
      expect(outcome.enqueued).toBe(true);
    }
    await enqueueOne();

    const claims = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        queue.claim({
          owner: `worker-${i}`,
          now: T0,
          leaseTtlMs: LEASE_TTL_MS,
          maxAttemptMs: MAX_ATTEMPT_MS,
        }),
      ),
    );

    const claimed = claims.filter((lease) => lease !== undefined);
    expect(claimed).toHaveLength(4);
    expect(new Set(claimed.map((lease) => lease.jobId)).size).toBe(4);
  });

  test('a claimed job is not claimable again, however long a second worker waits', async () => {
    await enqueueOne();
    const first = await queue.claim({
      owner: 'worker-a',
      now: T0,
      leaseTtlMs: LEASE_TTL_MS,
      maxAttemptMs: MAX_ATTEMPT_MS,
    });
    expect(first).toBeDefined();

    const second = await queue.claim({
      owner: 'worker-b',
      now: new Date(T0.getTime() + LEASE_TTL_MS / 2),
      leaseTtlMs: LEASE_TTL_MS,
      maxAttemptMs: MAX_ATTEMPT_MS,
    });
    expect(second).toBeUndefined();
  });

  test('a job whose run_at is in the future is not claimable', async () => {
    // Backoff is worth nothing if the claim ignores it: a poison job would be
    // retried in a tight loop by whichever worker asked first.
    await queue.enqueue({
      tenantId: TENANT,
      kind: 'consolidate',
      target: 'whole_brain',
      trigger: 'debt_debounce',
      now: T0,
      runAt: new Date(T0.getTime() + 60_000),
    });

    await expect(
      queue.claim({ owner: 'worker-a', now: T0, leaseTtlMs: LEASE_TTL_MS, maxAttemptMs: MAX_ATTEMPT_MS }),
    ).resolves.toBeUndefined();

    await expect(
      queue.claim({
        owner: 'worker-a',
        now: new Date(T0.getTime() + 60_000),
        leaseTtlMs: LEASE_TTL_MS,
        maxAttemptMs: MAX_ATTEMPT_MS,
      }),
    ).resolves.toBeDefined();
  });
});
