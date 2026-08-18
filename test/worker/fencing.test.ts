/**
 * **A worker that lost its lease has its writes refused.** Not "notices and
 * stops" — refused, by the store, whether or not it is still running.
 *
 * U2 shipped the other design one unit ago and this repo's git history carries
 * what it cost: every provisioning write was a blind patch keyed on the tenant
 * id alone, a run that had been legitimately taken over banked `failed` over a
 * live tenant's `ready` row, and the ordinary retry that a recorded failure
 * invites then deleted a user's database. The mechanism needed no bug — only a
 * hung call that outlived its own deadline.
 *
 * The same interleave here is cheaper to reach and just as damaging: a worker
 * pauses long enough for its lease to lapse (a GC pause, a saturated pool, a
 * container the platform froze), the reaper hands the job to a second worker,
 * and the first wakes up and reports. If that report is unfenced it marks done a
 * job that is still running, subtracts a debt it never worked off, or
 * dead-letters a job the new worker is about to finish.
 *
 * So this file asserts the *refusal*, on every write a worker can make, and ends
 * with the seeded regression: the same interleave against an unfenced statement,
 * which corrupts the row. A guard that has only ever been green has not been
 * shown to guard anything.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { createJobQueue, createLeaseChannel, type PostgresJobQueue } from '../../src/worker/queue.ts';
import { isStealable } from '../../src/worker/locks.ts';
import { connect, createControlPlane, dropControlPlane, readJobRow, seedTenant, type ControlFixture } from './fixture.ts';

const TENANT = 'fence-tenant';
const T0 = new Date('2026-08-12T00:00:00Z');
const LEASE_TTL_MS = 30_000;
const MAX_ATTEMPT_MS = 300_000;
const STEAL_GRACE_MS = 15_000;

/** Comfortably past `lease_expires_at + stealGrace`, so the reaper takes it. */
const AFTER_EXPIRY = new Date(T0.getTime() + LEASE_TTL_MS + STEAL_GRACE_MS + 1);

/**
 * Backoff with the jitter pinned to its floor, so "when is this claimable
 * again" is a number rather than a range. A reclaimed job is *not* instantly
 * re-claimable — a worker that keeps dying would otherwise be handed the same
 * job in a tight loop — so the tests below claim after the ladder's first rung.
 */
const BACKOFF_BASE_MS = 30_000;
const FIRST_BACKOFF_MS = BACKOFF_BASE_MS / 2;
const AFTER_BACKOFF = new Date(AFTER_EXPIRY.getTime() + FIRST_BACKOFF_MS);

let fixture: ControlFixture;
let sql: SQL;
let leaseSql: SQL;
let queue: PostgresJobQueue;

beforeAll(async () => {
  fixture = await createControlPlane('fencing');
  sql = connect(fixture, 4);
  leaseSql = connect(fixture, 1);
  queue = createJobQueue({ sql, backoff: { baseMs: BACKOFF_BASE_MS, maxMs: 900_000, random: () => 0 } });
});

afterAll(async () => {
  await sql.close();
  await leaseSql.close();
  await dropControlPlane(fixture);
});

beforeEach(async () => {
  await sql`DELETE FROM control.job`;
  await sql`DELETE FROM control.tenant`;
  await seedTenant(sql, TENANT, { pendingDebt: 12 });
});

/** Claims one consolidation job, then lets the reaper take it away. */
async function claimThenLoseIt() {
  const enqueued = await queue.enqueue({
    tenantId: TENANT,
    kind: 'consolidate',
    target: 'whole_brain',
    trigger: 'debt_debounce',
    now: T0,
    debtObserved: 12,
  });
  if (!enqueued.enqueued) throw new Error('fixture: enqueue refused');

  const stale = await queue.claim({
    owner: 'worker-stale',
    now: T0,
    leaseTtlMs: LEASE_TTL_MS,
    maxAttemptMs: MAX_ATTEMPT_MS,
  });
  if (stale === undefined) throw new Error('fixture: claim found nothing');

  const reclaimed = await queue.reclaim({ now: AFTER_EXPIRY, stealGraceMs: STEAL_GRACE_MS });
  expect(reclaimed).toHaveLength(1);

  const fresh = await queue.claim({
    owner: 'worker-fresh',
    now: AFTER_BACKOFF,
    leaseTtlMs: LEASE_TTL_MS,
    maxAttemptMs: MAX_ATTEMPT_MS,
  });
  if (fresh === undefined) throw new Error('fixture: the reclaimed job was not re-claimable');

  // The fence moved twice: once when the reaper took it, once when the new
  // worker claimed it. The stale worker still believes in the old number.
  expect(fresh.leaseToken).toBeGreaterThan(stale.leaseToken);
  return { stale, fresh, jobId: stale.jobId };
}

describe('a worker whose lease was stolen cannot write', () => {
  test('its completion is refused, and the job stays running for the worker that owns it', async () => {
    const { stale, fresh, jobId } = await claimThenLoseIt();

    const outcome = await queue.complete(stale, { now: AFTER_BACKOFF });
    expect(outcome.applied).toBe(false);
    if (outcome.applied) return;
    expect(outcome.current?.state).toBe('running');
    expect(outcome.current?.leaseOwner).toBe('worker-fresh');

    // And the live worker's completion still lands.
    const real = await queue.complete(fresh, { now: AFTER_BACKOFF });
    expect(real.applied).toBe(true);
    expect((await readJobRow(sql, jobId))['state']).toBe('done');
  });

  test('its failure report is refused — a zombie cannot dead-letter live work', async () => {
    const { stale, jobId } = await claimThenLoseIt();

    const outcome = await queue.fail(stale, { now: AFTER_BACKOFF, code: 'handler_error' });
    expect(outcome.applied).toBe(false);

    const row = await readJobRow(sql, jobId);
    expect(row['state']).toBe('running');
    expect(row['dead_lettered_at']).toBeNull();
  });

  test('its heartbeat is refused, and says so', async () => {
    const { stale } = await claimThenLoseIt();
    const channel = createLeaseChannel({ sql: leaseSql });

    const beat = await channel.heartbeat(stale, { now: AFTER_BACKOFF, leaseTtlMs: LEASE_TTL_MS });
    expect(beat).toEqual({ applied: false, reason: 'lease_lost' });
  });

  test('it cannot settle the tenant: the debt it never worked off stays owed', async () => {
    // The write that would be invisible. A refused `complete` that had already
    // subtracted the debt leaves the job correctly running and the tenant
    // wrongly settled — and nothing anywhere reports an error.
    const { stale } = await claimThenLoseIt();

    const outcome = await queue.complete(stale, {
      now: AFTER_BACKOFF,
      settle: { debtObserved: 12, nextDueAt: new Date(AFTER_BACKOFF.getTime() + 86_400_000) },
    });
    expect(outcome.applied).toBe(false);

    const tenant = (await sql`
      SELECT pending_debt, last_cycle_at, next_due_at FROM control.tenant WHERE tenant_id = ${TENANT}
    `) as unknown as { pending_debt: number; last_cycle_at: Date | null; next_due_at: Date | null }[];
    expect(tenant[0]?.pending_debt).toBe(12);
    expect(tenant[0]?.last_cycle_at).toBeNull();
    expect(tenant[0]?.next_due_at).toBeNull();
  });

  test('the worker that owns the lease settles the tenant, and only what it observed', async () => {
    const { fresh } = await claimThenLoseIt();

    // U6 keeps incrementing while the cycle runs: the tenant accrued 5 more
    // units of debt after this job was enqueued against 12.
    await sql`UPDATE control.tenant SET pending_debt = pending_debt + 5 WHERE tenant_id = ${TENANT}`;

    const nextDue = new Date(AFTER_BACKOFF.getTime() + 86_400_000);
    const outcome = await queue.complete(fresh, {
      now: AFTER_BACKOFF,
      settle: { debtObserved: fresh.debtObserved, nextDueAt: nextDue },
    });
    expect(outcome.applied).toBe(true);

    const tenant = (await sql`
      SELECT pending_debt, last_cycle_at, next_due_at FROM control.tenant WHERE tenant_id = ${TENANT}
    `) as unknown as { pending_debt: number; last_cycle_at: Date; next_due_at: Date }[];
    // 17 accrued, 12 worked off. A `= 0` reset would have discarded the 5 that
    // arrived mid-cycle, and the tenant would never be enqueued for them.
    expect(tenant[0]?.pending_debt).toBe(5);
    expect(tenant[0]?.last_cycle_at?.getTime()).toBe(AFTER_BACKOFF.getTime());
    expect(tenant[0]?.next_due_at?.getTime()).toBe(nextDue.getTime());
  });

  test('debt never goes negative, however the counters disagree', async () => {
    // The blind-subtraction bug, which the schema would catch as a constraint
    // violation raised mid-completion — the worst possible moment.
    const { fresh } = await claimThenLoseIt();
    await sql`UPDATE control.tenant SET pending_debt = 3 WHERE tenant_id = ${TENANT}`;

    const outcome = await queue.complete(fresh, {
      now: AFTER_BACKOFF,
      settle: { debtObserved: 12, nextDueAt: new Date(AFTER_BACKOFF.getTime() + 86_400_000) },
    });
    expect(outcome.applied).toBe(true);

    const tenant = (await sql`
      SELECT pending_debt FROM control.tenant WHERE tenant_id = ${TENANT}
    `) as unknown as { pending_debt: number }[];
    expect(tenant[0]?.pending_debt).toBe(0);
  });
});

describe('the fence is what does the work — the seeded regression', () => {
  test('the same interleave against an unfenced write corrupts the row', async () => {
    const { jobId } = await claimThenLoseIt();

    // This is the statement U2 shipped, transposed: a patch keyed on the row id
    // alone, with no `AND lease_token = …`. It is what `queue.complete` would be
    // if the fence were dropped, and the interleave above is unchanged.
    await sql`
      UPDATE control.job
      SET state = 'done', finished_at = ${AFTER_BACKOFF}, updated_at = ${AFTER_BACKOFF},
          lease_owner = NULL, lease_expires_at = NULL, attempt_deadline_at = NULL
      WHERE job_id = ${jobId}::uuid
    `;

    // A live worker's job, marked finished by a worker that no longer holds it.
    // Every fenced assertion above is measuring the distance from this row.
    const row = await readJobRow(sql, jobId);
    expect(row['state']).toBe('done');
    expect(row['lease_owner']).toBeNull();
  });
});

describe('the stealing rule and the SQL that implements it agree', () => {
  /**
   * `isStealable` is a mirror of the predicate inside `reclaim`, and mirrors
   * drift. The failure mode is quiet in both directions: a predicate that
   * over-reports makes a healthy fleet look like it is reaping constantly, and
   * one that under-reports makes a fleet that never reaps look healthy. So the
   * two are run against the same rows and compared.
   */
  /** Both implementations, asked about the same rows at the same instant. */
  async function compareAt(at: Date): Promise<{ predicted: string[]; taken: string[]; rows: number }> {
    const rows = (await sql`
      SELECT job_id, state, lease_expires_at, attempt_deadline_at FROM control.job
    `) as unknown as {
      job_id: string;
      state: string;
      lease_expires_at: Date | null;
      attempt_deadline_at: Date | null;
    }[];

    const predicted = rows
      .filter((row) =>
        isStealable(
          { state: row.state, leaseExpiresAt: row.lease_expires_at, attemptDeadlineAt: row.attempt_deadline_at },
          at,
          { stealGraceMs: STEAL_GRACE_MS },
        ),
      )
      .map((row) => row.job_id)
      .sort();

    const taken = (await queue.reclaim({ now: at, stealGraceMs: STEAL_GRACE_MS }))
      .map((job) => job.jobId)
      .sort();

    return { predicted, taken, rows: rows.length };
  }

  test('both arms agree: the expired lease, the overrun deadline, and neither firing early', async () => {
    // Four leases with three different lifetimes, so a comparison run at one
    // instant separates the rows rather than sweeping all of them.
    const lanes = [
      { slug: 'short-a', kind: 'ingest_pull', target: 'gmail', ttl: LEASE_TTL_MS },
      { slug: 'short-b', kind: 'ingest_pull', target: 'calendar', ttl: LEASE_TTL_MS },
      { slug: 'short-c', kind: 'ingest_pull', target: 'drive', ttl: LEASE_TTL_MS },
      // Its lease outlives the attempt deadline by a wide margin, which is
      // exactly the wedged-handler shape: renewed, alive, and never finishing.
      { slug: 'wedged', kind: 'consolidate', target: 'whole_brain', ttl: MAX_ATTEMPT_MS * 4 },
    ] as const;

    for (const lane of lanes) {
      const enqueued = await queue.enqueue({
        tenantId: TENANT,
        kind: lane.kind,
        target: lane.target,
        trigger: 'connector_cadence',
        now: T0,
      });
      expect(enqueued.enqueued).toBe(true);
      const lease = await queue.claim({
        owner: `worker-${lane.slug}`,
        now: T0,
        leaseTtlMs: lane.ttl,
        maxAttemptMs: MAX_ATTEMPT_MS,
        kinds: [lane.kind],
      });
      expect(lease).toBeDefined();
    }

    // Inside the grace window: nothing is stealable, and both say so. A guard
    // that only ever compares two non-empty sets never notices a predicate that
    // fires early.
    const early = await compareAt(new Date(T0.getTime() + LEASE_TTL_MS + 1));
    expect(early.predicted).toEqual([]);
    expect(early.taken).toEqual([]);

    // Past the grace window: the three short leases go, the wedged one stays —
    // its lease is still being renewed, which is the whole reason the deadline
    // has to be a separate term.
    const expired = await compareAt(new Date(T0.getTime() + LEASE_TTL_MS + STEAL_GRACE_MS + 1));
    expect(expired.taken).toEqual(expired.predicted);
    expect(expired.taken).toHaveLength(3);
    expect(expired.taken.length).toBeLessThan(expired.rows);

    // Past the attempt deadline: the wedged job goes too, on the backstop arm
    // alone. The three already-reclaimed rows are `due` now, and neither
    // implementation counts them.
    const overrun = await compareAt(new Date(T0.getTime() + MAX_ATTEMPT_MS + 1));
    expect(overrun.taken).toEqual(overrun.predicted);
    expect(overrun.taken).toHaveLength(1);

    const wedged = await queue.get(overrun.taken[0] ?? '');
    expect(wedged?.failureCode).toBe('attempt_timed_out');
  });
});

describe('the failure code names the arm that fired, not the moment the reaper looked', () => {
  /**
   * `attempt_timed_out` and `lease_stolen` are read by humans deciding whether a
   * lane needs a bigger budget or a healthier container, and one of them was
   * being written by a clock that belongs to neither.
   *
   * `reclaim` runs inside a tick. A fleet that sheds its container after five
   * idle minutes and is woken by a half-hourly cron leaves a dead holder's row
   * `running` for longer than the attempt ceiling — so by the time anyone looks,
   * `attempt_deadline_at <= now` is true of *every* dead holder, and the label
   * says "this attempt ran long" about an attempt that stopped in its first
   * minute. The evidence for an overrun is not when the reaper arrived; it is
   * whether the holder was still heartbeating when its own deadline passed.
   */

  const DEADLINE = new Date(T0.getTime() + MAX_ATTEMPT_MS);

  /** One connector lane, claimed at T0 with the shipped lease geometry. */
  async function claimLane(target: 'gmail' | 'calendar' | 'drive') {
    const enqueued = await queue.enqueue({
      tenantId: TENANT,
      kind: 'ingest_pull',
      target,
      trigger: 'connector_cadence',
      now: T0,
    });
    expect(enqueued.enqueued).toBe(true);
    const lease = await queue.claim({
      owner: `worker-${target}`,
      now: T0,
      leaseTtlMs: LEASE_TTL_MS,
      maxAttemptMs: MAX_ATTEMPT_MS,
      kinds: ['ingest_pull'],
    });
    if (lease === undefined) throw new Error('fixture: claim found nothing');
    return lease;
  }

  test('a holder that stopped heartbeating before its deadline is stolen, not timed out', async () => {
    // Zero renewals: the container was killed mid-attempt, so the lease lapsed
    // at T0+30s and the deadline it never reached passed at T0+5m with nobody
    // holding the job. The reaper turns up five minutes after that.
    await claimLane('gmail');

    const taken = await queue.reclaim({
      now: new Date(DEADLINE.getTime() + 5 * 60_000),
      stealGraceMs: STEAL_GRACE_MS,
    });

    expect(taken).toHaveLength(1);
    expect(taken[0]?.failureCode).toBe('lease_stolen');
  });

  test('reaper latency does not change the verdict', async () => {
    // One geometry, four observation times. `reclaim` consumes the row it
    // takes, so the lane is rebuilt identically between instants rather than
    // reaped four times — same claim, same TTL, same absent heartbeat, and the
    // only thing that differs is when somebody looked.
    //
    // The first instant is deliberately *before* the deadline, where only the
    // lease arm has fired. Without it the other three agree on the wrong answer
    // and the assertion is vacuous.
    const instants = [
      new Date(T0.getTime() + LEASE_TTL_MS + STEAL_GRACE_MS + 1),
      new Date(DEADLINE.getTime() + 1_000),
      new Date(DEADLINE.getTime() + 5 * 60_000),
      new Date(DEADLINE.getTime() + 30 * 60_000),
    ];

    const verdicts: (string | null | undefined)[] = [];
    for (const at of instants) {
      await sql`DELETE FROM control.job`;
      await claimLane('gmail');
      const taken = await queue.reclaim({ now: at, stealGraceMs: STEAL_GRACE_MS });
      expect(taken).toHaveLength(1);
      verdicts.push(taken[0]?.failureCode);
    }

    // Named rather than merely compared: four instants that agreed on
    // `attempt_timed_out` would be just as invariant and just as wrong.
    expect(verdicts).toEqual(['lease_stolen', 'lease_stolen', 'lease_stolen', 'lease_stolen']);
  });

  test('a holder that heartbeated past its deadline keeps the timed-out label even when the reap is late', async () => {
    // The overrun this code exists to name: the worker was alive at the instant
    // its own ceiling passed, then stopped. A rule that read only "the lease has
    // lapsed by now" would relabel this `lease_stolen` and erase the one signal
    // worth escalating on.
    const lease = await claimLane('calendar');
    const channel = createLeaseChannel({ sql: leaseSql });

    const renewAt = new Date(DEADLINE.getTime() - 5_000);
    const beat = await channel.heartbeat(lease, { now: renewAt, leaseTtlMs: LEASE_TTL_MS });
    expect(beat.applied).toBe(true);

    const taken = await queue.reclaim({
      now: new Date(DEADLINE.getTime() + 30 * 60_000),
      stealGraceMs: STEAL_GRACE_MS,
    });

    expect(taken).toHaveLength(1);
    expect(taken[0]?.failureCode).toBe('attempt_timed_out');
  });
});
