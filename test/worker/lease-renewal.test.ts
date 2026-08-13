/**
 * **Hazard H4: lease renewal starved by the connection it shares with the work.**
 *
 * Upstream lost roughly 39 worker processes a day to this — the
 * pooler had the connection busy, `renewLock` waited its turn, the lease lapsed
 * while the worker was healthy and working, and the job was taken from
 * underneath it. Nothing in that sequence is an error. Every query succeeds. The
 * only symptom is a worker count that drifts down and a queue that does the same
 * work twice.
 *
 * It cannot be caught by inspection, because the wiring that fails looks
 * identical to the wiring that works right up until the pool is busy. So it is
 * caught behaviourally, with a real Postgres and a pool of exactly one
 * connection, and the file holds both halves:
 *
 *   - **The guard.** With renewal on a channel of its own, a work pool saturated
 *     by a long query does not stop the heartbeat, and the reaper — running at an
 *     instant that would otherwise have taken the lease — takes nothing.
 *   - **The seeded regression.** Same clock, same reaper, renewal routed through
 *     the saturated pool: the heartbeat queues behind the work, the lease is
 *     stolen while the worker is alive, and the renewal that eventually runs is
 *     refused by the fence.
 *
 * The second half is what makes the first mean something. A guard that has only
 * ever been green has not been shown to guard anything.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { createJobQueue, createLeaseChannel, type PostgresJobQueue } from '../../src/worker/queue.ts';
import {
  assertDedicatedLeaseChannel,
  assertLeaseConfig,
  DEFAULT_LEASE_CONFIG,
  MIN_HEARTBEATS_PER_LEASE,
} from '../../src/worker/locks.ts';
import { connect, createControlPlane, dropControlPlane, seedTenant, type ControlFixture } from './fixture.ts';

const TENANT = 'renewal-tenant';
const T0 = new Date('2026-08-12T00:00:00Z');

const LEASE_TTL_MS = 30_000;
const STEAL_GRACE_MS = 15_000;
const MAX_ATTEMPT_MS = 600_000;

/** Renewal happens here, comfortably inside the first lease. */
const RENEW_AT = new Date(T0.getTime() + 20_000);

/**
 * The reaper's instant, chosen so the two wirings give opposite answers:
 *
 *   - un-renewed, the lease expired at T0+30s and is stealable from T0+45s → taken;
 *   - renewed at T0+20s, it expires at T0+50s and is stealable from T0+65s → left alone.
 */
const REAP_AT = new Date(T0.getTime() + 50_000);

/** Long enough to still be running while the reaper sweeps. */
const SATURATION_SECONDS = 1.5;

let fixture: ControlFixture;
/** The work pool. **One** connection, which is the whole point. */
let workSql: SQL;
let leaseSql: SQL;
/** The reaper runs elsewhere, as it does in production. */
let reaperSql: SQL;
let queue: PostgresJobQueue;
let reaper: PostgresJobQueue;

beforeAll(async () => {
  fixture = await createControlPlane('renewal');
  workSql = connect(fixture, 1);
  leaseSql = connect(fixture, 1);
  reaperSql = connect(fixture, 1);
  queue = createJobQueue({ sql: workSql });
  reaper = createJobQueue({ sql: reaperSql });
});

afterAll(async () => {
  await workSql.close();
  await leaseSql.close();
  await reaperSql.close();
  await dropControlPlane(fixture);
});

beforeEach(async () => {
  await reaperSql`DELETE FROM control.job`;
  await reaperSql`DELETE FROM control.tenant`;
  await seedTenant(reaperSql, TENANT);
});

async function claimOne() {
  const enqueued = await queue.enqueue({
    tenantId: TENANT,
    kind: 'import',
    target: 'chat_export',
    trigger: 'user_request',
    now: T0,
  });
  if (!enqueued.enqueued) throw new Error(`fixture: enqueue refused (${enqueued.reason})`);
  const lease = await queue.claim({
    owner: 'worker-importing',
    now: T0,
    leaseTtlMs: LEASE_TTL_MS,
    maxAttemptMs: MAX_ATTEMPT_MS,
  });
  if (lease === undefined) throw new Error('fixture: nothing claimed');
  return lease;
}

/**
 * Occupies the work pool the way a real job does — a long query the pool cannot
 * interleave. `pg_sleep` rather than a lock, because the hazard is *pool
 * occupancy*, not row contention: the renewal query touches a row nothing else
 * is holding and is starved anyway.
 *
 * `.then()` is not decoration. A Bun tagged-template query is lazy: it is
 * dispatched when something subscribes to it, and a sleep that was never sent
 * saturates nothing — which makes both tests below pass for the wrong reason,
 * intermittently. It cost one flaky run to find, so the handshake underneath is
 * mandatory rather than defensive.
 */
function saturateWorkPool(): Promise<unknown> {
  return workSql`SELECT pg_sleep(${SATURATION_SECONDS})`.then(() => undefined);
}

/**
 * Waits until the database itself reports the work connection busy.
 *
 * Without it the guard is vacuous in the most dangerous way: an unsaturated pool
 * renews instantly, the reaper finds a live lease, and the test reports that the
 * hazard is guarded because the hazard was never staged. Asking Postgres is the
 * only observation that cannot be fooled by dispatch ordering.
 */
async function awaitWorkPoolBusy(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const rows = (await reaperSql`
      SELECT count(*)::int AS busy
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND state = 'active'
        AND query LIKE ${'%pg_sleep%'}
    `) as unknown as { busy: number }[];
    if ((rows[0]?.busy ?? 0) > 0) return;
    await Bun.sleep(5);
  }
  throw new Error('fixture: the work pool never became busy, so the guard below would prove nothing');
}

describe('renewal on a dedicated channel survives a saturated work pool', () => {
  test('the heartbeat lands while the work pool is busy, and the reaper finds nothing to take', async () => {
    const lease = await claimOne();
    const channel = createLeaseChannel({ sql: leaseSql });

    const busy = saturateWorkPool();
    await awaitWorkPoolBusy();

    const startedAt = Date.now();
    const beat = await channel.heartbeat(lease, { now: RENEW_AT, leaseTtlMs: LEASE_TTL_MS });
    const elapsedMs = Date.now() - startedAt;

    expect(beat.applied).toBe(true);
    // It did not wait for the work. If this ever starts failing, the channel has
    // quietly been given the work pool.
    expect(elapsedMs).toBeLessThan(SATURATION_SECONDS * 1000);

    const taken = await reaper.reclaim({ now: REAP_AT, stealGraceMs: STEAL_GRACE_MS });
    expect(taken).toEqual([]);

    const job = await reaper.get(lease.jobId);
    expect(job?.state).toBe('running');
    expect(job?.leaseOwner).toBe('worker-importing');
    expect(job?.leaseToken).toBe(lease.leaseToken);

    await busy;
  });

  test('the seeded regression: renewal through the work pool loses the lease', async () => {
    const lease = await claimOne();
    // The mis-wiring, spelled out. This is the line the guard exists to forbid.
    const sharedChannel = createLeaseChannel({ sql: workSql });

    const busy = saturateWorkPool();
    await awaitWorkPoolBusy();
    // Queued behind the work, on the pool's single connection. Deliberately not
    // awaited yet: the reaper runs while it is still waiting its turn.
    const starved = sharedChannel.heartbeat(lease, { now: RENEW_AT, leaseTtlMs: LEASE_TTL_MS });

    const taken = await reaper.reclaim({ now: REAP_AT, stealGraceMs: STEAL_GRACE_MS });
    // A live worker, mid-import, with its job taken away from it.
    expect(taken).toHaveLength(1);
    expect(taken[0]?.jobId).toBe(lease.jobId);
    expect(taken[0]?.failureCode).toBe('lease_stolen');

    // And when the renewal finally gets a connection, the fence refuses it. The
    // worker is not asked to notice; it is told, and it could not have written
    // anything even if it had not been.
    await expect(starved).resolves.toEqual({ applied: false, reason: 'lease_lost' });

    await busy;
  });
});

describe('the wiring is refused structurally, not left to reviewers', () => {
  test('a lease channel sharing the work connection is rejected at construction', () => {
    const shared = createLeaseChannel({ sql: workSql });
    expect(() => assertDedicatedLeaseChannel(queue, shared)).toThrow(/hazard H4/);
  });

  test('a lease channel with its own connection is accepted', () => {
    const dedicated = createLeaseChannel({ sql: leaseSql });
    expect(() => assertDedicatedLeaseChannel(queue, dedicated)).not.toThrow();
  });
});

describe('a lease configuration that manufactures stealing is refused', () => {
  test('the shipped defaults are legal', () => {
    expect(() => assertLeaseConfig(DEFAULT_LEASE_CONFIG)).not.toThrow();
  });

  test('a TTL that does not span several heartbeats is refused', () => {
    // The misconfiguration that reads as fine and steals leases from healthy
    // workers on any slow query — the same class as U2's stale window being
    // shorter than its own deadline.
    expect(() =>
      assertLeaseConfig({
        ...DEFAULT_LEASE_CONFIG,
        leaseTtlMs: DEFAULT_LEASE_CONFIG.heartbeatIntervalMs * (MIN_HEARTBEATS_PER_LEASE - 1),
      }),
    ).toThrow(/heartbeat intervals/);
  });

  test('an attempt deadline shorter than the lease is refused', () => {
    expect(() =>
      assertLeaseConfig({ ...DEFAULT_LEASE_CONFIG, maxAttemptMs: DEFAULT_LEASE_CONFIG.leaseTtlMs }),
    ).toThrow(/reclaimed mid-flight/);
  });

  test('a non-positive heartbeat interval is refused', () => {
    expect(() => assertLeaseConfig({ ...DEFAULT_LEASE_CONFIG, heartbeatIntervalMs: 0 })).toThrow(
      /never renewed/,
    );
  });

  test('a negative steal grace is refused', () => {
    expect(() => assertLeaseConfig({ ...DEFAULT_LEASE_CONFIG, stealGraceMs: -1 })).toThrow(
      /before it expires/,
    );
  });
});
