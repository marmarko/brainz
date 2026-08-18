/**
 * The retry ladder, per kind — and the two things that must be able to end a
 * lane early: a terminal refusal, and a person pressing a button.
 *
 * **The incident this file is the guard for.** Three connectors were connected;
 * every poll failed with `provider_error` because a vendor URL was built in a
 * shape the vendor answers `404` to. The fix was written and deployed the same
 * evening — and it changed nothing, because by then all three lanes were
 * `dead` at `attempts = 5/5`. The whole ladder had burned in **under four
 * minutes of wall clock**: five attempts at 30s doubling to a 15-minute cap,
 * with equal jitter pinned by luck near its floor, is 3m45s of retrying. A dead
 * lane is never reclaimed, so the fix landed on lanes that would never ask
 * again.
 *
 * Nothing about that policy was a bug. It is a defensible ladder for
 * `consolidate`, where the failure is usually ours and a human is nearby. It is
 * the wrong ladder for `ingest_pull`, where the thing being waited on is
 * **somebody else's API** and a vendor deploy routinely outlasts four minutes by
 * three orders of magnitude.
 *
 * **The tests here assert SHAPE, not numbers.** A test that says
 * `expect(maxAttempts).toBe(12)` passes trivially the moment somebody edits both
 * the constant and the test, and it proves nothing about whether the ladder is a
 * ladder. So what is asserted is: each rung is at least as far out as the one
 * before it, no rung exceeds the cap, the last attempt lands beyond the horizon
 * the policy claims, and a `consolidate` failure and an `ingest_pull` failure
 * land in different orders of magnitude — which is the assertion that fails if
 * the policy table exists and nothing reads it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import {
  backoffMs,
  CONNECTOR_RETRY_HORIZON_MS,
  jobRetryableOf,
  retryPolicyFor,
  RETRY_POLICY,
  type JobKind,
} from '../../src/worker/jobs.ts';
import { createJobQueue, createLeaseChannel, reviveDeadLane, type PostgresJobQueue } from '../../src/worker/queue.ts';
import { createJobRunner } from '../../src/worker/runner.ts';
import { DEFAULT_LEASE_CONFIG } from '../../src/worker/locks.ts';
import {
  connect,
  createControlPlane,
  dropControlPlane,
  readJobRow,
  seedTenant,
  type ControlFixture,
} from './fixture.ts';

const TENANT = 'ladder-tenant';
const OTHER = 'bystander-tenant';
const T0 = new Date('2026-08-12T00:00:00Z');
const CONFIG = DEFAULT_LEASE_CONFIG;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let fixture: ControlFixture;
let sql: SQL;
let leaseSql: SQL;
/** Jitter pinned to its floor, so every rung below is an exact number. */
let queue: PostgresJobQueue;

beforeAll(async () => {
  fixture = await createControlPlane('retrypolicy');
  sql = connect(fixture, 6);
  leaseSql = connect(fixture, 1);
  queue = createJobQueue({ sql, random: () => 0 });
});

afterAll(async () => {
  await sql.close();
  await leaseSql.close();
  await dropControlPlane(fixture);
});

beforeEach(async () => {
  await sql`DELETE FROM control.job`;
  await sql`DELETE FROM control.tenant`;
  await seedTenant(sql, TENANT);
  await seedTenant(sql, OTHER);
});

/** Every gap the policy for `kind` produces, from the first failure to the last. */
function rungs(kind: JobKind, random: () => number): number[] {
  const policy = retryPolicyFor(kind);
  const gaps: number[] = [];
  // A job that has failed its Nth attempt waits, then makes its (N+1)th. The
  // last attempt is followed by the dead letter, so there are one fewer gaps
  // than attempts.
  for (let attempt = 1; attempt < policy.maxAttempts; attempt += 1) {
    gaps.push(backoffMs(attempt, { ...policy.backoff, random }));
  }
  return gaps;
}

describe('the ladder each kind walks', () => {
  test('every kind has a policy, and the connector lane is the one that differs', () => {
    // Not "the record has the right keys" — that is a type. What is asserted is
    // that the other four were left alone, because the fix for one lane silently
    // re-timing consolidation is exactly the regression this shape invites.
    for (const kind of ['consolidate', 'export', 're_embed', 'import'] as const) {
      expect({ kind, ...retryPolicyFor(kind) }).toEqual({
        kind,
        maxAttempts: 5,
        backoff: { baseMs: 30_000, maxMs: 15 * MINUTE },
      });
    }
    const connector = retryPolicyFor('ingest_pull');
    expect(connector.maxAttempts).toBeGreaterThan(5);
    expect(connector.backoff.baseMs).toBeGreaterThanOrEqual(30 * MINUTE);
  });

  test('the connector ladder never steps backwards and never exceeds its cap', () => {
    // Both extremes of the jitter, because equal jitter means every real rung
    // lands between them. At the floor the ladder must still climb; at the
    // ceiling it must still be bounded.
    for (const random of [() => 0, () => 0.5, () => 1]) {
      const gaps = rungs('ingest_pull', random);
      const cap = retryPolicyFor('ingest_pull').backoff.maxMs;
      for (let i = 1; i < gaps.length; i += 1) {
        expect({ i, monotone: (gaps[i] as number) >= (gaps[i - 1] as number) }).toEqual({
          i,
          monotone: true,
        });
      }
      for (const [i, gap] of gaps.entries()) {
        expect({ i, withinCap: gap <= cap }).toEqual({ i, withinCap: true });
      }
    }
  });

  test('the worst-case ladder still outlives a provider outage measured in hours', () => {
    // The floor of the jitter is the honest horizon: half of every delay is
    // random, so this is the shortest life a connector lane can have. It has to
    // be longer than an ordinary outage, or the whole change is decorative.
    const floor = rungs('ingest_pull', () => 0).reduce((a, b) => a + b, 0);
    expect(floor).toBeGreaterThanOrEqual(CONNECTOR_RETRY_HORIZON_MS);
    expect(CONNECTOR_RETRY_HORIZON_MS).toBeGreaterThanOrEqual(24 * HOUR);
  });

  test('a broken connector lane costs a bounded number of vendor calls a day', () => {
    // The cap is the knob that decides what a genuinely-broken lane costs, and
    // it matters more than the attempt count. Stated as calls per day so the
    // assertion survives a change to either number.
    const { backoff, maxAttempts } = retryPolicyFor('ingest_pull');
    const callsPerDaySteadyState = (24 * HOUR) / (backoff.maxMs / 2);
    expect(callsPerDaySteadyState).toBeLessThanOrEqual(12);
    expect(maxAttempts).toBeLessThanOrEqual(24);
  });
});

describe('the queue reads the policy rather than a global default', () => {
  test('an enqueued job carries its own kind’s attempt budget', async () => {
    const pull = await queue.enqueue({
      tenantId: TENANT,
      kind: 'ingest_pull',
      target: 'gmail',
      trigger: 'connector_cadence',
      now: T0,
    });
    const cycle = await queue.enqueue({
      tenantId: TENANT,
      kind: 'consolidate',
      target: 'whole_brain',
      trigger: 'time_ceiling',
      now: T0,
    });
    expect(pull.enqueued && pull.job.maxAttempts).toBe(RETRY_POLICY.ingest_pull.maxAttempts);
    expect(cycle.enqueued && cycle.job.maxAttempts).toBe(RETRY_POLICY.consolidate.maxAttempts);
  });

  test('the same failure on two kinds lands orders of magnitude apart', async () => {
    // The mutation this kills: a policy table that exists, typechecks, is
    // exported — and is read by nothing, so both lanes still walk the old
    // 30-second ladder.
    const runAtAfterOneFailure = async (kind: JobKind, target: 'gmail' | 'whole_brain') => {
      const enqueued = await queue.enqueue({
        tenantId: TENANT,
        kind,
        target,
        trigger: 'user_request',
        now: T0,
      });
      if (!enqueued.enqueued) throw new Error('fixture: the enqueue was refused');
      const lease = await queue.claim({
        owner: 'w',
        now: T0,
        leaseTtlMs: CONFIG.leaseTtlMs,
        maxAttemptMs: CONFIG.maxAttemptMs,
        kinds: [kind],
      });
      if (lease === undefined) throw new Error('fixture: nothing claimable');
      const failed = await queue.fail(lease, { now: T0, code: 'handler_error' });
      if (!failed.applied) throw new Error('fixture: the failure did not apply');
      return failed.job.runAt.getTime() - T0.getTime();
    };

    const connectorGap = await runAtAfterOneFailure('ingest_pull', 'gmail');
    const cycleGap = await runAtAfterOneFailure('consolidate', 'whole_brain');
    expect(connectorGap).toBeGreaterThanOrEqual(15 * MINUTE);
    expect(cycleGap).toBeLessThanOrEqual(MINUTE);
  });

  test('a connector lane that keeps failing dies beyond the horizon, not inside four minutes', async () => {
    const enqueued = await queue.enqueue({
      tenantId: TENANT,
      kind: 'ingest_pull',
      target: 'gmail',
      trigger: 'connector_cadence',
      now: T0,
    });
    if (!enqueued.enqueued) throw new Error('fixture: the enqueue was refused');

    let now = T0;
    let attempts = 0;
    const claimedAt: Date[] = [];
    // Driven by the row's own `run_at` rather than by a fixed step, so what is
    // measured is the ladder the store actually wrote.
    for (let i = 0; i < RETRY_POLICY.ingest_pull.maxAttempts; i += 1) {
      const lease = await queue.claim({
        owner: 'w',
        now,
        leaseTtlMs: CONFIG.leaseTtlMs,
        maxAttemptMs: CONFIG.maxAttemptMs,
        kinds: ['ingest_pull'],
      });
      if (lease === undefined) break;
      claimedAt.push(now);
      attempts = lease.attempts;
      const failed = await queue.fail(lease, { now, code: 'handler_error' });
      if (!failed.applied) throw new Error('fixture: the failure did not apply');
      now = new Date(Math.max(now.getTime(), failed.job.runAt.getTime()));
    }

    const row = await readJobRow(sql, enqueued.job.jobId);
    expect({ attempts, state: row['state'] }).toEqual({
      attempts: RETRY_POLICY.ingest_pull.maxAttempts,
      state: 'dead',
    });
    const last = claimedAt[claimedAt.length - 1] as Date;
    expect(last.getTime() - T0.getTime()).toBeGreaterThanOrEqual(CONNECTOR_RETRY_HORIZON_MS);
  }, 30_000);
});

describe('terminal is not the same as retryable', () => {
  test('a handler’s claim is read, and an interrupted lease overrules it', () => {
    expect(jobRetryableOf(new Error('boom'), false)).toBe(true);
    expect(jobRetryableOf({ jobRetryable: false }, false)).toBe(false);
    // The fence wins, exactly as it does for the failure code: a lease stolen
    // mid-pull is the fleet's own interruption, and it must never be able to
    // kill a user's connector.
    expect(jobRetryableOf({ jobRetryable: false }, true)).toBe(true);
    // Anything that is not strictly `false` is retryable. Fail-open, because the
    // failure this whole file exists for is a lane that stopped too early.
    expect(jobRetryableOf({ jobRetryable: 'no' }, false)).toBe(true);
    expect(jobRetryableOf('nonsense', false)).toBe(true);
  });

  test('a lane that fails terminally on attempt one is not retried at all', async () => {
    const enqueued = await queue.enqueue({
      tenantId: TENANT,
      kind: 'ingest_pull',
      target: 'gmail',
      trigger: 'connector_cadence',
      now: T0,
    });
    if (!enqueued.enqueued) throw new Error('fixture: the enqueue was refused');

    const terminal = Object.assign(new Error('the grant was withdrawn'), {
      jobRetryable: false,
      jobFailureCode: 'handler_error',
    });
    const runner = createJobRunner({
      queue,
      leases: createLeaseChannel({ sql: leaseSql }),
      handlers: {
        ingest_pull: () => Promise.reject(terminal),
      },
      owner: 'terminal-worker',
      concurrency: 1,
      config: CONFIG,
      clock: () => T0,
      onError: () => undefined,
    });

    const pass = await runner.runOnce({ now: T0 });
    expect(pass.outcomes.failed).toBe(1);

    const row = await readJobRow(sql, enqueued.job.jobId);
    expect({
      state: row['state'],
      attempts: row['attempts'],
      deadLettered: row['dead_lettered_at'] !== null,
    }).toEqual({ state: 'dead', attempts: 1, deadLettered: true });

    // The opposite of every other assertion in this suite: nothing is claimable
    // afterwards, at any point on the ladder the policy would otherwise allow.
    const later = await queue.claim({
      owner: 'w',
      now: new Date(T0.getTime() + 7 * 24 * HOUR),
      leaseTtlMs: CONFIG.leaseTtlMs,
      maxAttemptMs: CONFIG.maxAttemptMs,
      kinds: ['ingest_pull'],
    });
    expect(later).toBeUndefined();
  });

  test('the same handler failing retryably walks the ladder instead', async () => {
    const enqueued = await queue.enqueue({
      tenantId: TENANT,
      kind: 'ingest_pull',
      target: 'calendar',
      trigger: 'connector_cadence',
      now: T0,
    });
    if (!enqueued.enqueued) throw new Error('fixture: the enqueue was refused');

    const runner = createJobRunner({
      queue,
      leases: createLeaseChannel({ sql: leaseSql }),
      handlers: { ingest_pull: () => Promise.reject(new Error('the provider is down')) },
      owner: 'retryable-worker',
      concurrency: 1,
      config: CONFIG,
      clock: () => T0,
      onError: () => undefined,
    });
    await runner.runOnce({ now: T0 });

    const row = await readJobRow(sql, enqueued.job.jobId);
    expect({ state: row['state'], deadLettered: row['dead_lettered_at'] }).toEqual({
      state: 'due',
      deadLettered: null,
    });
  });
});

describe('a dead lane has a way back', () => {
  /** Walks a lane to `dead` and hands back its job id. */
  async function killLane(tenantId: string, target: 'gmail' | 'calendar'): Promise<string> {
    const enqueued = await queue.enqueue({
      tenantId,
      kind: 'ingest_pull',
      target,
      trigger: 'connector_cadence',
      now: T0,
      // The policy's own budget is 12 rungs and this test is about the way back,
      // not about the ladder. Overridden rather than weakened at the source.
      maxAttempts: 1,
    });
    if (!enqueued.enqueued) throw new Error('fixture: the enqueue was refused');
    const lease = await queue.claim({
      owner: 'w',
      now: T0,
      leaseTtlMs: CONFIG.leaseTtlMs,
      maxAttemptMs: CONFIG.maxAttemptMs,
      kinds: ['ingest_pull'],
    });
    if (lease === undefined) throw new Error('fixture: nothing claimable');
    await queue.fail(lease, { now: T0, code: 'handler_error' });
    return enqueued.job.jobId;
  }

  test('reviving a dead lane makes it claimable again, from attempt zero', async () => {
    const jobId = await killLane(TENANT, 'gmail');
    const at = new Date(T0.getTime() + HOUR);

    const revived = await reviveDeadLane(sql, {
      tenantId: TENANT,
      kind: 'ingest_pull',
      target: 'gmail',
      now: at,
    });
    expect(revived.revived).toBe(true);

    const row = await readJobRow(sql, jobId);
    expect({
      state: row['state'],
      attempts: row['attempts'],
      deadLettered: row['dead_lettered_at'],
      failureCode: row['failure_code'],
      // Why the job is here is recorded rather than inferred, and a person
      // pressing a button is not the cadence coming round.
      trigger: row['trigger_reason'],
    }).toEqual({
      state: 'due',
      attempts: 0,
      deadLettered: null,
      failureCode: null,
      trigger: 'user_request',
    });

    const lease = await queue.claim({
      owner: 'w',
      now: at,
      leaseTtlMs: CONFIG.leaseTtlMs,
      maxAttemptMs: CONFIG.maxAttemptMs,
      kinds: ['ingest_pull'],
    });
    expect(lease?.jobId).toBe(jobId);
  });

  test('reviving a lane that is not dead changes nothing at all', async () => {
    // The violating case. A healthy lane mid-ladder is `due` with `attempts > 0`
    // — the exact row a revive keyed on the lane rather than on the state would
    // reset to zero, handing a failing connector an unlimited retry budget and
    // moving its next attempt to now.
    const enqueued = await queue.enqueue({
      tenantId: TENANT,
      kind: 'ingest_pull',
      target: 'gmail',
      trigger: 'connector_cadence',
      now: T0,
    });
    if (!enqueued.enqueued) throw new Error('fixture: the enqueue was refused');
    const lease = await queue.claim({
      owner: 'w',
      now: T0,
      leaseTtlMs: CONFIG.leaseTtlMs,
      maxAttemptMs: CONFIG.maxAttemptMs,
      kinds: ['ingest_pull'],
    });
    if (lease === undefined) throw new Error('fixture: nothing claimable');
    const failed = await queue.fail(lease, { now: T0, code: 'handler_error' });
    if (!failed.applied) throw new Error('fixture: the failure did not apply');
    const before = await readJobRow(sql, enqueued.job.jobId);

    const outcome = await reviveDeadLane(sql, {
      tenantId: TENANT,
      kind: 'ingest_pull',
      target: 'gmail',
      now: new Date(T0.getTime() + HOUR),
    });
    expect(outcome).toEqual({ revived: false, reason: 'no_dead_lane' });

    const after = await readJobRow(sql, enqueued.job.jobId);
    expect({
      state: after['state'],
      attempts: after['attempts'],
      runAt: (after['run_at'] as Date).toISOString(),
      updatedAt: (after['updated_at'] as Date).toISOString(),
    }).toEqual({
      state: 'due',
      attempts: 1,
      runAt: (before['run_at'] as Date).toISOString(),
      updatedAt: (before['updated_at'] as Date).toISOString(),
    });
  });

  test('a revive reaches one tenant’s one source and no other', async () => {
    const mine = await killLane(TENANT, 'gmail');
    const alsoMine = await killLane(TENANT, 'calendar');
    const theirs = await killLane(OTHER, 'gmail');

    await reviveDeadLane(sql, {
      tenantId: TENANT,
      kind: 'ingest_pull',
      target: 'gmail',
      now: new Date(T0.getTime() + HOUR),
    });

    expect({
      mine: (await readJobRow(sql, mine))['state'],
      alsoMine: (await readJobRow(sql, alsoMine))['state'],
      theirs: (await readJobRow(sql, theirs))['state'],
    }).toEqual({ mine: 'due', alsoMine: 'dead', theirs: 'dead' });
  });

  test('reviving a lane that never failed is refused rather than inventing a job', async () => {
    const outcome = await reviveDeadLane(sql, {
      tenantId: TENANT,
      kind: 'ingest_pull',
      target: 'drive',
      now: T0,
    });
    expect(outcome).toEqual({ revived: false, reason: 'no_dead_lane' });
    const rows = (await sql`SELECT count(*)::int AS n FROM control.job`) as unknown as { n: number }[];
    expect(rows[0]?.n).toBe(0);
  });
});
