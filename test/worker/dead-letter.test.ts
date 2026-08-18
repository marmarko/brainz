/**
 * Poison-job protection, dead-lettering, and the two re-enqueue paths.
 *
 * The requirement this file is built on is a negative one: **a crashing tenant
 * is quarantined, not permanently due.** Under debt-driven scheduling a tenant
 * whose consolidation kills the worker is enqueued again the moment it is
 * noticed missing, which is immediately, forever — one tenant then occupies the
 * whole fleet and every other tenant silently stops being served. Nothing errors.
 * The fleet looks busy.
 *
 * Three properties together make that impossible, and each is asserted here:
 *
 *   1. Attempts are counted at **claim**, so a worker that dies without
 *      reporting still walks the ladder. Counting only caught exceptions leaves
 *      the crash loop unbounded, which is the shape that actually happens.
 *   2. An exhausted job lands in a **visible** dead-letter state rather than
 *      being deleted or left due.
 *   3. `enqueue` refuses a lane that holds a dead letter, in the statement
 *      itself. A caller-side check would be a check that ran before the value it
 *      protects was used, and two schedulers during a rolling deploy both pass it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { retryPolicyFor } from '../../src/worker/jobs.ts';
import { createJobQueue, type PostgresJobQueue } from '../../src/worker/queue.ts';
import { connect, countJobs, createControlPlane, dropControlPlane, seedTenant, type ControlFixture } from './fixture.ts';

const TENANT = 'poison-tenant';
const OTHER = 'healthy-tenant';
const T0 = new Date('2026-08-12T00:00:00Z');
const LEASE_TTL_MS = 30_000;
const MAX_ATTEMPT_MS = 300_000;
const STEAL_GRACE_MS = 15_000;
const BACKOFF_BASE_MS = 30_000;

let fixture: ControlFixture;
let sql: SQL;
let queue: PostgresJobQueue;

beforeAll(async () => {
  fixture = await createControlPlane('deadletter');
  sql = connect(fixture, 4);
  // Jitter pinned to its floor: the ladder's rungs are then exact numbers, and
  // "when is it claimable again" stops being a range.
  queue = createJobQueue({ sql, backoff: { baseMs: BACKOFF_BASE_MS, maxMs: 900_000, random: () => 0 } });
});

afterAll(async () => {
  await sql.close();
  await dropControlPlane(fixture);
});

beforeEach(async () => {
  await sql`DELETE FROM control.job`;
  await sql`DELETE FROM control.tenant`;
  await seedTenant(sql, TENANT, { pendingDebt: 4 });
  await seedTenant(sql, OTHER, { pendingDebt: 4 });
});

async function enqueueConsolidate(tenantId = TENANT, now = T0): Promise<void> {
  const outcome = await queue.enqueue({
    tenantId,
    kind: 'consolidate',
    target: 'whole_brain',
    trigger: 'debt_debounce',
    now,
    debtObserved: 4,
  });
  if (!outcome.enqueued) throw new Error(`fixture: enqueue refused (${outcome.reason})`);
}

/** The rung a job lands on after its nth failure, jitter pinned to the floor. */
function backoffAfter(attempts: number): number {
  return Math.min(900_000, BACKOFF_BASE_MS * 2 ** (attempts - 1)) / 2;
}

describe('a killed worker re-enqueues its job exactly once', () => {
  test('one row, one extra attempt, and the lease cleared', async () => {
    await enqueueConsolidate();
    const lease = await queue.claim({
      owner: 'worker-doomed',
      now: T0,
      leaseTtlMs: LEASE_TTL_MS,
      maxAttemptMs: MAX_ATTEMPT_MS,
    });
    expect(lease?.attempts).toBe(1);

    // The worker dies here: no failure report, no release, no heartbeat.
    const at = new Date(T0.getTime() + LEASE_TTL_MS + STEAL_GRACE_MS + 1);
    const reclaimed = await queue.reclaim({ now: at, stealGraceMs: STEAL_GRACE_MS });

    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.state).toBe('due');
    expect(reclaimed[0]?.failureCode).toBe('lease_stolen');
    expect(reclaimed[0]?.leaseOwner).toBeNull();
    // The assertion the requirement is written as: re-enqueued **once**. A
    // reaper that inserted a replacement instead of moving the row would leave
    // two, and both would run.
    await expect(countJobs(sql, TENANT)).resolves.toBe(1);
  });

  test('a second reaper sweeping the same instant takes nothing', async () => {
    await enqueueConsolidate();
    await queue.claim({ owner: 'worker-doomed', now: T0, leaseTtlMs: LEASE_TTL_MS, maxAttemptMs: MAX_ATTEMPT_MS });

    const at = new Date(T0.getTime() + LEASE_TTL_MS + STEAL_GRACE_MS + 1);
    const [first, second] = await Promise.all([
      queue.reclaim({ now: at, stealGraceMs: STEAL_GRACE_MS }),
      queue.reclaim({ now: at, stealGraceMs: STEAL_GRACE_MS }),
    ]);

    expect(first.length + second.length).toBe(1);
    await expect(countJobs(sql, TENANT)).resolves.toBe(1);
  });

  test('the backoff ladder is honoured between attempts', async () => {
    await enqueueConsolidate();
    const lease = await queue.claim({ owner: 'w', now: T0, leaseTtlMs: LEASE_TTL_MS, maxAttemptMs: MAX_ATTEMPT_MS });
    if (lease === undefined) throw new Error('fixture: nothing claimed');

    const failedAt = new Date(T0.getTime() + 1_000);
    const outcome = await queue.fail(lease, { now: failedAt, code: 'handler_error' });
    expect(outcome.applied).toBe(true);
    if (!outcome.applied) return;

    expect(outcome.job.state).toBe('due');
    expect(outcome.job.runAt.getTime()).toBe(failedAt.getTime() + backoffAfter(1));

    // And the queue actually refuses to hand it back before then, which is the
    // half that makes the ladder real rather than decorative.
    await expect(
      queue.claim({ owner: 'w', now: failedAt, leaseTtlMs: LEASE_TTL_MS, maxAttemptMs: MAX_ATTEMPT_MS }),
    ).resolves.toBeUndefined();
  });
});

describe('a poison job exhausts its ladder and is quarantined', () => {
  /** Runs the job to its dead letter through repeated handler failures. */
  async function poisonByFailure(): Promise<Date> {
    await enqueueConsolidate();
    let at = T0;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const lease = await queue.claim({
        owner: `worker-${attempt}`,
        now: at,
        leaseTtlMs: LEASE_TTL_MS,
        maxAttemptMs: MAX_ATTEMPT_MS,
      });
      if (lease === undefined) throw new Error(`fixture: nothing claimable on attempt ${attempt}`);
      expect(lease.attempts).toBe(attempt);
      const outcome = await queue.fail(lease, { now: at, code: 'handler_error' });
      expect(outcome.applied).toBe(true);
      at = new Date(at.getTime() + backoffAfter(attempt) + 1);
    }
    return at;
  }

  test('the fifth failure dead-letters it, with a code and a moment', async () => {
    await poisonByFailure();

    const dead = await queue.listDeadLetters({ tenantId: TENANT });
    expect(dead).toHaveLength(1);
    expect(dead[0]?.state).toBe('dead');
    expect(dead[0]?.failureCode).toBe('handler_error');
    expect(dead[0]?.deadLetteredAt).not.toBeNull();
    expect(dead[0]?.attempts).toBe(5);
  });

  test('a crash loop reaches the same dead letter — attempts count claims, not confessions', async () => {
    // The failure mode that matters more, because it is the one that actually
    // happens: the handler does not throw, it takes the worker down with it. No
    // `fail` is ever called, so a ladder counting reported failures never moves.
    await enqueueConsolidate();
    let at = T0;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const lease = await queue.claim({
        owner: `worker-${attempt}`,
        now: at,
        leaseTtlMs: LEASE_TTL_MS,
        maxAttemptMs: MAX_ATTEMPT_MS,
      });
      expect(lease?.attempts).toBe(attempt);
      at = new Date(at.getTime() + LEASE_TTL_MS + STEAL_GRACE_MS + 1);
      await queue.reclaim({ now: at, stealGraceMs: STEAL_GRACE_MS });
      at = new Date(at.getTime() + backoffAfter(attempt) + 1);
    }

    const dead = await queue.listDeadLetters({ tenantId: TENANT });
    expect(dead).toHaveLength(1);
    expect(dead[0]?.failureCode).toBe('lease_stolen');
    expect(dead[0]?.attempts).toBe(5);
  });

  test('the quarantined lane refuses new work until an operator clears it', async () => {
    const at = await poisonByFailure();

    const blocked = await queue.enqueue({
      tenantId: TENANT,
      kind: 'consolidate',
      target: 'whole_brain',
      trigger: 'time_ceiling',
      now: at,
    });
    expect(blocked).toEqual({ enqueued: false, reason: 'quarantined' });
    // Refused by the statement, so nothing was written: the tenant is not
    // "permanently due", it is out of the rotation.
    await expect(countJobs(sql, TENANT)).resolves.toBe(1);
  });

  test('quarantine is per lane, not per tenant — a poisoned mailbox does not stop the calendar', async () => {
    // The unit of quarantine is the unit of scheduling. A Gmail pull that
    // poisons a worker must not take the tenant's calendar and drive with it,
    // or one bad connector silently ends all ingestion for that user.
    await queue.enqueue({ tenantId: TENANT, kind: 'ingest_pull', target: 'gmail', trigger: 'connector_cadence', now: T0 });
    let at = T0;
    // The lane's own budget rather than the literal five: `RETRY_POLICY` gives
    // `ingest_pull` a longer ladder than the other kinds, and a loop that
    // hard-coded the old number would leave the lane alive and assert the
    // quarantine of a job that had not been quarantined.
    for (let attempt = 1; attempt <= retryPolicyFor('ingest_pull').maxAttempts; attempt++) {
      const lease = await queue.claim({
        owner: `w${attempt}`,
        now: at,
        leaseTtlMs: LEASE_TTL_MS,
        maxAttemptMs: MAX_ATTEMPT_MS,
        kinds: ['ingest_pull'],
      });
      if (lease === undefined) throw new Error('fixture: nothing claimable');
      await queue.fail(lease, { now: at, code: 'handler_error' });
      at = new Date(at.getTime() + backoffAfter(attempt) + 1);
    }

    await expect(
      queue.enqueue({ tenantId: TENANT, kind: 'ingest_pull', target: 'gmail', trigger: 'connector_cadence', now: at }),
    ).resolves.toEqual({ enqueued: false, reason: 'quarantined' });

    const calendar = await queue.enqueue({
      tenantId: TENANT,
      kind: 'ingest_pull',
      target: 'calendar',
      trigger: 'connector_cadence',
      now: at,
    });
    expect(calendar.enqueued).toBe(true);

    // And the tenant's consolidation is untouched.
    const consolidate = await queue.enqueue({
      tenantId: TENANT,
      kind: 'consolidate',
      target: 'whole_brain',
      trigger: 'debt_debounce',
      now: at,
    });
    expect(consolidate.enqueued).toBe(true);
  });

  test("one tenant's dead letter does not quarantine another tenant", async () => {
    await poisonByFailure();
    const other = await queue.enqueue({
      tenantId: OTHER,
      kind: 'consolidate',
      target: 'whole_brain',
      trigger: 'debt_debounce',
      now: T0,
    });
    expect(other.enqueued).toBe(true);
  });
});

describe('an operator can empty the dead-letter box', () => {
  async function poison(): Promise<{ jobId: string; at: Date }> {
    await enqueueConsolidate();
    let at = T0;
    let jobId = '';
    for (let attempt = 1; attempt <= 5; attempt++) {
      const lease = await queue.claim({
        owner: `w${attempt}`,
        now: at,
        leaseTtlMs: LEASE_TTL_MS,
        maxAttemptMs: MAX_ATTEMPT_MS,
      });
      if (lease === undefined) throw new Error('fixture: nothing claimable');
      jobId = lease.jobId;
      await queue.fail(lease, { now: at, code: 'handler_error' });
      at = new Date(at.getTime() + backoffAfter(attempt) + 1);
    }
    return { jobId, at };
  }

  test('requeue puts the lane back in service from attempt zero', async () => {
    const { jobId, at } = await poison();

    const cleared = await queue.clearDeadLetter(jobId, { now: at, action: 'requeue' });
    expect(cleared.cleared).toBe(true);
    if (!cleared.cleared) return;
    expect(cleared.job.state).toBe('due');
    expect(cleared.job.attempts).toBe(0);
    expect(cleared.job.deadLetteredAt).toBeNull();

    // Claimable again, and the lane is no longer quarantined.
    await expect(
      queue.claim({ owner: 'w', now: at, leaseTtlMs: LEASE_TTL_MS, maxAttemptMs: MAX_ATTEMPT_MS }),
    ).resolves.toBeDefined();
  });

  test('discard retires the job and reopens the lane, keeping the record', async () => {
    const { jobId, at } = await poison();

    const cleared = await queue.clearDeadLetter(jobId, { now: at, action: 'discard' });
    expect(cleared.cleared).toBe(true);
    if (!cleared.cleared) return;
    expect(cleared.job.state).toBe('discarded');
    // The evidence survives. A `DELETE` would make a poison job and a job that
    // never existed the same row.
    expect(cleared.job.deadLetteredAt).not.toBeNull();
    expect(cleared.job.failureCode).toBe('handler_error');

    const next = await queue.enqueue({
      tenantId: TENANT,
      kind: 'consolidate',
      target: 'whole_brain',
      trigger: 'time_ceiling',
      now: at,
    });
    expect(next.enqueued).toBe(true);
  });

  test('clearing something that is not dead-lettered is refused, not silently applied', async () => {
    await enqueueConsolidate();
    const row = (await sql`SELECT job_id FROM control.job LIMIT 1`) as unknown as { job_id: string }[];
    const jobId = row[0]?.job_id ?? '';

    await expect(queue.clearDeadLetter(jobId, { now: T0, action: 'requeue' })).resolves.toEqual({
      cleared: false,
      reason: 'not_dead_lettered',
    });
  });
});

describe('the queue refuses work it cannot run', () => {
  test('a second enqueue for an open lane is refused, and leaves one row', async () => {
    await enqueueConsolidate();
    // The debounce firing on every quiet tick is the realistic caller. It must
    // be a no-op, and it must be a no-op decided by the database.
    for (let tick = 0; tick < 5; tick++) {
      const outcome = await queue.enqueue({
        tenantId: TENANT,
        kind: 'consolidate',
        target: 'whole_brain',
        trigger: 'debt_debounce',
        now: new Date(T0.getTime() + tick * 60_000),
      });
      expect(outcome).toEqual({ enqueued: false, reason: 'already_open' });
    }
    await expect(countJobs(sql, TENANT)).resolves.toBe(1);
  });

  test('a running job still holds its lane', async () => {
    await enqueueConsolidate();
    await queue.claim({ owner: 'w', now: T0, leaseTtlMs: LEASE_TTL_MS, maxAttemptMs: MAX_ATTEMPT_MS });

    await expect(
      queue.enqueue({ tenantId: TENANT, kind: 'consolidate', target: 'whole_brain', trigger: 'time_ceiling', now: T0 }),
    ).resolves.toEqual({ enqueued: false, reason: 'already_open' });
  });

  test('a finished job releases its lane', async () => {
    await enqueueConsolidate();
    const lease = await queue.claim({ owner: 'w', now: T0, leaseTtlMs: LEASE_TTL_MS, maxAttemptMs: MAX_ATTEMPT_MS });
    if (lease === undefined) throw new Error('fixture: nothing claimed');
    await queue.complete(lease, { now: T0 });

    const next = await queue.enqueue({
      tenantId: TENANT,
      kind: 'consolidate',
      target: 'whole_brain',
      trigger: 'time_ceiling',
      now: new Date(T0.getTime() + 86_400_000),
    });
    expect(next.enqueued).toBe(true);
    await expect(countJobs(sql, TENANT)).resolves.toBe(2);
  });

  test('a tenant that is not ready gets no jobs, and a claim skips one that stops being ready', async () => {
    await seedTenant(sql, 'half-provisioned', { state: 'provisioning' });
    await expect(
      queue.enqueue({
        tenantId: 'half-provisioned',
        kind: 'consolidate',
        target: 'whole_brain',
        trigger: 'time_ceiling',
        now: T0,
      }),
    ).resolves.toEqual({ enqueued: false, reason: 'tenant_not_ready' });

    // And the re-check at claim time, which is the one that matters: U17 moves a
    // tenant to `deleting` while its jobs are already queued.
    await enqueueConsolidate();
    await sql`UPDATE control.tenant SET state = 'deleting' WHERE tenant_id = ${TENANT}`;
    await expect(
      queue.claim({ owner: 'w', now: T0, leaseTtlMs: LEASE_TTL_MS, maxAttemptMs: MAX_ATTEMPT_MS }),
    ).resolves.toBeUndefined();
  });

  test('a kind that cannot name a target is refused before the round trip', async () => {
    // The schema would refuse it too — `job_target_suits_its_kind` — but as a
    // constraint violation raised on a live enqueue. The caller gets the answer
    // instead.
    await expect(
      queue.enqueue({
        tenantId: TENANT,
        kind: 'consolidate',
        target: 'gmail',
        trigger: 'debt_debounce',
        now: T0,
      }),
    ).rejects.toThrow(/cannot target/);
  });
});
