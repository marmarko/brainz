/**
 * KTD11's three triggers, and the capacity arithmetic that follows from them.
 *
 * The assertion this file is really about is the negative one in the plan's own
 * scenario list: *"A tenant accumulating debt purely from connector polling,
 * with no user-originated calls, is not enqueued by the debounce — only by the
 * time ceiling."*
 *
 * That is a fail-open of the exact shape this codebase keeps producing. The
 * obvious debounce predicate — "debt is high and there has been no user activity
 * for N minutes" — is **satisfied by the absence of the signal**. A tenant that
 * has never had a user call has no `last_activity` at all, so it is permanently
 * quiet, permanently in debt from its connectors, and enqueued on every tick
 * forever. Nothing errors; the fleet simply spends its whole budget on the
 * tenants who are not using it.
 *
 * So the predicate has to say something stronger: somebody was here, and they
 * have gone. `last_activity IS NOT NULL AND last_activity > last_cycle_at`. The
 * seeded regression at the bottom runs the naive version against the same rows
 * and shows it pulling the polling-only tenant in.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { createJobQueue, type PostgresJobQueue } from '../../src/worker/queue.ts';
import {
  ALPHA_CAPACITY,
  ALPHA_CEILING_MS,
  ALPHA_CONCURRENCY,
  ALPHA_SCHEDULER,
  describeCapacity,
  ESTIMATED_CYCLE_MS,
  maxTenantsAt,
  nextCeilingDueAt,
  requiredConcurrency,
  runSchedulerTick,
  selectDueTenants,
  stampMissingDueTimes,
  staggerOffsetMs,
  type DueTenant,
} from '../../src/worker/scheduler.ts';
import type { SweepPorts } from '../../src/control/migrate.ts';
import { connect, createControlPlane, dropControlPlane, seedTenant, type ControlFixture } from './fixture.ts';

/**
 * A fleet with no schema work, stated rather than omitted.
 *
 * `SchedulerDeps.schemas` is required precisely so that "this tick migrates
 * nothing" has to be something a caller said. The tests in this file are about
 * KTD11's triggers; `test/worker/schema-sweep.test.ts` is where the sweep's own
 * wiring is asserted.
 */
const NO_SCHEMA_WORK: SweepPorts = {
  listBehind: () => Promise.resolve([]),
  migrate: () => Promise.reject(new Error('invariant: nothing was listed to migrate')),
  recordSchemaVersion: () => Promise.resolve(),
};

const NOW = new Date('2026-08-12T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const CONFIG = ALPHA_SCHEDULER;

let fixture: ControlFixture;
let sql: SQL;
let queue: PostgresJobQueue;

beforeAll(async () => {
  fixture = await createControlPlane('scheduler');
  sql = connect(fixture, 2);
  queue = createJobQueue({ sql });
});

afterAll(async () => {
  await sql.close();
  await dropControlPlane(fixture);
});

beforeEach(async () => {
  await sql`DELETE FROM control.job`;
  await sql`DELETE FROM control.tenant`;
});

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

async function due(): Promise<readonly DueTenant[]> {
  return selectDueTenants(sql, { now: NOW, config: CONFIG });
}

describe('the inactivity debounce', () => {
  test('a tenant with debt who was here and has gone quiet is due', async () => {
    await seedTenant(sql, 'went-quiet', {
      pendingDebt: 20,
      lastActivity: ago(20 * MINUTE),
      lastCycleAt: ago(6 * HOUR),
    });

    expect(await due()).toEqual([{ tenantId: 'went-quiet', pendingDebt: 20, reason: 'debt_debounce' }]);
  });

  test('a tenant still in the middle of a conversation is not', async () => {
    // Quiet for one minute is not quiet. Consolidating under an active user is
    // both wasted spend and a moving target.
    await seedTenant(sql, 'still-typing', {
      pendingDebt: 20,
      lastActivity: ago(MINUTE),
      lastCycleAt: ago(6 * HOUR),
    });

    expect(await due()).toEqual([]);
  });

  test('a tenant below the debt threshold is not, however long it has been quiet', async () => {
    await seedTenant(sql, 'barely-used', {
      pendingDebt: CONFIG.minDebt - 1,
      lastActivity: ago(6 * HOUR),
      lastCycleAt: ago(6 * HOUR),
    });

    expect(await due()).toEqual([]);
  });

  test('a tenant whose activity predates its last cycle has already been served', async () => {
    // The debt is from connectors that have run since. Its user's last visit was
    // consolidated an hour ago, so the debounce has nothing left to fire on.
    await seedTenant(sql, 'already-served', {
      pendingDebt: 40,
      lastActivity: ago(4 * HOUR),
      lastCycleAt: ago(HOUR),
    });

    expect(await due()).toEqual([]);
  });

  test('a tenant that cycled minutes ago waits out the inter-cycle interval', async () => {
    await seedTenant(sql, 'just-cycled', {
      pendingDebt: 40,
      lastActivity: ago(15 * MINUTE),
      lastCycleAt: ago(5 * MINUTE),
    });

    expect(await due()).toEqual([]);
  });
});

describe('the polling-only tenant — the missing-signal fail-open', () => {
  /**
   * Debt from connectors alone. No user has ever called this brain: the mailbox
   * fills, `pending_debt` climbs, and `last_activity` stays NULL because it is
   * stamped by user-originated calls only.
   */
  async function seedPollingOnly(): Promise<void> {
    await seedTenant(sql, 'connector-only', {
      pendingDebt: 400,
      lastActivity: null,
      lastCycleAt: ago(2 * HOUR),
      // Its ceiling slot is still hours away.
      nextDueAt: new Date(NOW.getTime() + 6 * HOUR),
    });
  }

  test('the debounce does not fire for it', async () => {
    await seedPollingOnly();
    expect(await due()).toEqual([]);
  });

  test('a long-dormant tenant with debt is not "quiet" either', async () => {
    // The same hole reached from the other side: activity that is merely ancient
    // rather than absent, and older than the last cycle. A predicate keyed on
    // "no activity recently" pulls this one in too.
    await seedTenant(sql, 'dormant', {
      pendingDebt: 400,
      lastActivity: ago(90 * 24 * HOUR),
      lastCycleAt: ago(2 * HOUR),
      nextDueAt: new Date(NOW.getTime() + 6 * HOUR),
    });

    expect(await due()).toEqual([]);
  });

  test('the time ceiling is what eventually serves it — R3, unattended', async () => {
    await seedPollingOnly();
    await sql`UPDATE control.tenant SET next_due_at = ${ago(MINUTE)} WHERE tenant_id = 'connector-only'`;

    expect(await due()).toEqual([
      { tenantId: 'connector-only', pendingDebt: 400, reason: 'time_ceiling' },
    ]);
  });

  test('the seeded regression: the naive predicate pulls it in', async () => {
    await seedPollingOnly();

    // The predicate this module deliberately does not use. It is what "quiet for
    // N minutes with debt" means read literally, and it is satisfied by a signal
    // that was never written rather than by a user who went away.
    const quietBefore = new Date(NOW.getTime() - CONFIG.quietMs);
    const naive = (await sql`
      SELECT tenant_id FROM control.tenant
      WHERE state = 'ready'
        AND pending_debt >= ${CONFIG.minDebt}
        AND (last_activity IS NULL OR last_activity <= ${quietBefore})
    `) as unknown as { tenant_id: string }[];

    expect(naive.map((row) => row.tenant_id)).toEqual(['connector-only']);
    // Same row, same instant, and the shipped predicate leaves it alone.
    expect(await due()).toEqual([]);
  });
});

describe('the time ceiling', () => {
  test('a tenant past its staggered slot is due, with the ceiling as the reason', async () => {
    await seedTenant(sql, 'ceiling-tenant', {
      pendingDebt: 0,
      lastActivity: null,
      lastCycleAt: ago(25 * HOUR),
      nextDueAt: ago(MINUTE),
    });

    expect(await due()).toEqual([{ tenantId: 'ceiling-tenant', pendingDebt: 0, reason: 'time_ceiling' }]);
  });

  test('a tenant short of its slot is not', async () => {
    await seedTenant(sql, 'not-yet', {
      lastCycleAt: ago(6 * HOUR),
      nextDueAt: new Date(NOW.getTime() + HOUR),
    });

    expect(await due()).toEqual([]);
  });

  test('the ceiling respects the inter-cycle interval too', async () => {
    // A debounced cycle finishing minutes before the tenant's slot must not be
    // followed straight away by an empty ceiling cycle.
    await seedTenant(sql, 'fresh-cycle', {
      lastCycleAt: ago(5 * MINUTE),
      nextDueAt: ago(MINUTE),
    });

    expect(await due()).toEqual([]);
  });

  test('the debounce sorts ahead of the ceiling when both are due', async () => {
    await seedTenant(sql, 'ceiling-one', { lastCycleAt: ago(30 * HOUR), nextDueAt: ago(HOUR) });
    await seedTenant(sql, 'debounced-one', {
      pendingDebt: 30,
      lastActivity: ago(20 * MINUTE),
      lastCycleAt: ago(6 * HOUR),
    });

    const rows = await due();
    expect(rows.map((row) => row.tenantId)).toEqual(['debounced-one', 'ceiling-one']);
  });
});

describe('the stagger spreads the fleet across the ceiling period', () => {
  test('a tenant\'s slot is deterministic and inside the period', () => {
    for (const tenantId of ['a', 'tenant-b', 'x'.repeat(63)]) {
      const offset = staggerOffsetMs(tenantId, ALPHA_CEILING_MS);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(ALPHA_CEILING_MS);
      expect(staggerOffsetMs(tenantId, ALPHA_CEILING_MS)).toBe(offset);
    }
  });

  test('a thousand tenants land in a thousand different hours-of-the-day, roughly evenly', () => {
    // The property that matters is not uniformity for its own sake: an unstaggered
    // fleet comes due in one instant, the concurrency bound rejects most of it,
    // and the rest arrives a day late.
    const buckets = new Array<number>(24).fill(0);
    for (let i = 0; i < 1000; i++) {
      const hour = Math.floor(staggerOffsetMs(`tenant-${i}`, ALPHA_CEILING_MS) / HOUR);
      buckets[hour] = (buckets[hour] ?? 0) + 1;
    }
    expect(buckets.filter((count) => count === 0)).toEqual([]);
    // No hour carries more than three times its share.
    expect(Math.max(...buckets)).toBeLessThan(125);
  });

  test('the next slot is strictly after the moment asked about, and within one period', () => {
    for (const tenantId of ['alpha', 'beta', 'gamma']) {
      const next = nextCeilingDueAt(tenantId, NOW, ALPHA_CEILING_MS);
      expect(next.getTime()).toBeGreaterThan(NOW.getTime());
      expect(next.getTime() - NOW.getTime()).toBeLessThanOrEqual(ALPHA_CEILING_MS);
      // And it is the same slot every time it is asked, from anywhere in the fleet.
      expect(nextCeilingDueAt(tenantId, NOW, ALPHA_CEILING_MS).getTime()).toBe(next.getTime());
    }
  });

  test('successive slots are exactly one period apart', () => {
    const first = nextCeilingDueAt('drifting', NOW, ALPHA_CEILING_MS);
    const second = nextCeilingDueAt('drifting', first, ALPHA_CEILING_MS);
    expect(second.getTime() - first.getTime()).toBe(ALPHA_CEILING_MS);
  });
});

describe('a tenant that has never cycled still gets a due time', () => {
  test('the backfill stamps one, inside one ceiling period', async () => {
    await seedTenant(sql, 'brand-new', { nextDueAt: null });

    const stamped = await stampMissingDueTimes(sql, { now: NOW, config: CONFIG });
    expect(stamped).toBe(1);

    const rows = (await sql`
      SELECT next_due_at FROM control.tenant WHERE tenant_id = 'brand-new'
    `) as unknown as { next_due_at: Date }[];
    const at = rows[0]?.next_due_at?.getTime() ?? 0;
    expect(at).toBeGreaterThan(NOW.getTime());
    expect(at - NOW.getTime()).toBeLessThanOrEqual(ALPHA_CEILING_MS);
  });

  test('it never moves a due time that already exists', async () => {
    const existing = new Date(NOW.getTime() + 3 * HOUR);
    await seedTenant(sql, 'already-stamped', { nextDueAt: existing });

    expect(await stampMissingDueTimes(sql, { now: NOW, config: CONFIG })).toBe(0);
    const rows = (await sql`
      SELECT next_due_at FROM control.tenant WHERE tenant_id = 'already-stamped'
    `) as unknown as { next_due_at: Date }[];
    expect(rows[0]?.next_due_at?.getTime()).toBe(existing.getTime());
  });

  test('a half-provisioned tenant gets nothing', async () => {
    await seedTenant(sql, 'half-done', { state: 'provisioning' });
    expect(await stampMissingDueTimes(sql, { now: NOW, config: CONFIG })).toBe(0);
  });
});

describe('the capacity arithmetic is visible, and the bound is not a magic number', () => {
  test('the formula is the plan\'s: tenants ÷ (ceiling ÷ cycle)', () => {
    // 24h ÷ 3min = 480 cycles per concurrent slot per day.
    expect(requiredConcurrency({ tenants: 480, ceilingMs: ALPHA_CEILING_MS, cycleMs: ESTIMATED_CYCLE_MS })).toBe(1);
    expect(requiredConcurrency({ tenants: 9_600, ceilingMs: ALPHA_CEILING_MS, cycleMs: ESTIMATED_CYCLE_MS })).toBe(
      ALPHA_CONCURRENCY,
    );
  });

  test('the alpha bound reports what it is worth, rather than asserting it', () => {
    expect(ALPHA_CAPACITY.concurrency).toBe(20);
    expect(ALPHA_CAPACITY.maxTenants).toBe(9_600);
    expect(ALPHA_CAPACITY.exceeded).toBe(false);
    // Comfortably past the plan's "low thousands of daily cycles", and far short
    // of the >30k-tenant substrate KTD1 is sized for. Both halves are the point.
    expect(ALPHA_CAPACITY.maxTenants).toBeGreaterThan(3_000);
    expect(ALPHA_CAPACITY.maxTenants).toBeLessThan(30_000);
  });

  test('a longer measured cycle shrinks the fleet the same bound can serve', () => {
    // The reason the number is computed rather than written down. When U11
    // commits a real cycle duration, this moves on its own; a hardcoded 20 would
    // have gone on claiming a capacity it no longer had.
    const slower = describeCapacity({
      tenants: ALPHA_CAPACITY.maxTenants,
      ceilingMs: ALPHA_CEILING_MS,
      cycleMs: ESTIMATED_CYCLE_MS * 3,
      concurrency: ALPHA_CONCURRENCY,
    });
    expect(slower.maxTenants).toBe(3_200);
    expect(slower.requiredConcurrency).toBe(60);
    expect(slower.exceeded).toBe(true);
  });

  test('a longer ceiling buys capacity back', () => {
    expect(
      maxTenantsAt({ concurrency: ALPHA_CONCURRENCY, ceilingMs: ALPHA_CEILING_MS * 2, cycleMs: ESTIMATED_CYCLE_MS }),
    ).toBe(19_200);
  });

  test('a nonsensical ceiling or cycle is refused, not divided by', () => {
    expect(() => requiredConcurrency({ tenants: 1, ceilingMs: 0, cycleMs: 1 })).toThrow(/positive/);
    expect(() => requiredConcurrency({ tenants: 1, ceilingMs: 1, cycleMs: 0 })).toThrow(/positive/);
    expect(() => staggerOffsetMs('a', 0)).toThrow(/positive/);
  });
});

describe('a scheduler tick', () => {
  test('enqueues each due tenant once, however many times it ticks', async () => {
    await seedTenant(sql, 'quiet-with-debt', {
      pendingDebt: 30,
      lastActivity: ago(20 * MINUTE),
      lastCycleAt: ago(6 * HOUR),
    });

    const deps = { sql, queue, config: CONFIG, stealGraceMs: 15_000, schemas: NO_SCHEMA_WORK };
    const first = await runSchedulerTick(deps, { now: NOW });
    expect(first.enqueued).toEqual([{ tenantId: 'quiet-with-debt', reason: 'debt_debounce' }]);

    // The debounce is a level, not an edge: it keeps being true for as long as
    // the tenant stays quiet. The tick must be a no-op, and the refusal must be
    // reported rather than swallowed.
    const second = await runSchedulerTick(deps, { now: new Date(NOW.getTime() + MINUTE) });
    expect(second.enqueued).toEqual([]);
    expect(second.refused).toEqual([{ tenantId: 'quiet-with-debt', reason: 'already_open' }]);

    const rows = (await sql`SELECT count(*)::int AS n FROM control.job`) as unknown as { n: number }[];
    expect(rows[0]?.n).toBe(1);
  });

  test('the job records which trigger enqueued it', async () => {
    await seedTenant(sql, 'ceiling-only', { lastCycleAt: ago(30 * HOUR), nextDueAt: ago(MINUTE) });

    await runSchedulerTick({ sql, queue, config: CONFIG, stealGraceMs: 15_000, schemas: NO_SCHEMA_WORK }, { now: NOW });
    const rows = (await sql`
      SELECT trigger_reason, debt_observed FROM control.job WHERE tenant_id = 'ceiling-only'
    `) as unknown as { trigger_reason: string; debt_observed: number }[];
    expect(rows[0]?.trigger_reason).toBe('time_ceiling');
  });

  test('a brand-new tenant is stamped on one tick and served on a later one', async () => {
    // R3 end to end, with no user in the loop: connect, walk away, get consolidated.
    await seedTenant(sql, 'connected-and-idle', { pendingDebt: 0, lastActivity: null, nextDueAt: null });
    const deps = { sql, queue, config: CONFIG, stealGraceMs: 15_000, schemas: NO_SCHEMA_WORK };

    const first = await runSchedulerTick(deps, { now: NOW });
    expect(first.stamped).toBe(1);
    expect(first.enqueued).toEqual([]);

    const rows = (await sql`
      SELECT next_due_at FROM control.tenant WHERE tenant_id = 'connected-and-idle'
    `) as unknown as { next_due_at: Date }[];
    const slot = rows[0]?.next_due_at ?? NOW;

    const later = await runSchedulerTick(deps, { now: new Date(slot.getTime() + MINUTE) });
    expect(later.enqueued).toEqual([{ tenantId: 'connected-and-idle', reason: 'time_ceiling' }]);
  });

  test('a tick reports when the due list outruns the concurrency bound', async () => {
    // Not trimmed silently. A fleet that is behind must say so — the number is
    // what tells an operator the bound or the cycle estimate has to move.
    for (let i = 0; i < ALPHA_CONCURRENCY + 5; i++) {
      await seedTenant(sql, `busy-${i}`, {
        pendingDebt: 30,
        lastActivity: ago(20 * MINUTE),
        lastCycleAt: ago(6 * HOUR),
      });
    }

    const result = await runSchedulerTick(
      { sql, queue, config: CONFIG, stealGraceMs: 15_000, schemas: NO_SCHEMA_WORK },
      { now: NOW, cycleMs: ALPHA_CEILING_MS },
    );

    expect(result.due).toBe(ALPHA_CONCURRENCY + 5);
    expect(result.enqueued).toHaveLength(ALPHA_CONCURRENCY + 5);
    // At a cycle duration equal to the whole ceiling period, one slot serves one
    // tenant, so 25 due tenants need 25 slots and the bound of 20 cannot do it.
    expect(result.capacity.requiredConcurrency).toBe(ALPHA_CONCURRENCY + 5);
    expect(result.capacity.exceeded).toBe(true);
  });
});
