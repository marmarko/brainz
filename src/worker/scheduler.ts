/**
 * Who is due, and how many of them can run at once (U10 approach step 3, KTD11).
 *
 * The scheduler **consumes** the control-plane signals U6 writes; it does not
 * produce them. `pending_debt`, `last_activity` and `last_cycle_at` are already
 * on the tenant row, and everything below is a reading of them.
 *
 * **Three triggers, and the third is not a fallback.**
 *
 * 1. **The inactivity debounce.** A tenant that has cleared a debt threshold,
 *    has been quiet of *user-originated* calls for N minutes, and has rested for
 *    a minimum inter-cycle interval. "Session end" cannot be observed on a
 *    stateless surface (KTD3) — there is no session — so this is the realizable
 *    proxy for it.
 *
 * 2. **The time ceiling.** `next_due_at`, stamped forward on every completed
 *    cycle and staggered by a hash of the tenant id. It is the only trigger a
 *    connected-but-inactive tenant ever fires, which is why the fleet's capacity
 *    can be computed at all.
 *
 * 3. **A user request**, which is not this module's — it arrives through U6.
 *
 * **The debounce's hard part is a signal that is missing rather than old.** The
 * obvious predicate — "no user activity in the last N minutes" — is satisfied by
 * a tenant with *no user activity at all*. A connector polling a busy mailbox
 * accrues debt continuously and never stamps `last_activity` (by design: it is
 * user-originated only, or a busy mailbox would starve the quiet window). Under
 * the obvious predicate that tenant is permanently "quiet with debt" and is
 * enqueued on every tick, forever. KTD11 says it must be served by the ceiling
 * instead. So the debounce additionally requires that user activity **exists**
 * and is **newer than the last cycle**: somebody was here, and they have gone.
 *
 * **The concurrency bound is a resource decision; its consequences are computed.**
 * `describeCapacity` turns a bound into the fleet size it buys, from the plan's
 * own arithmetic — `tenants ÷ (ceiling ÷ cycle duration) ≤ bound` — so the
 * number moves on its own the moment U11 commits a measured cycle duration
 * instead of the estimate below.
 */

import type { SQL } from 'bun';

import type { EnqueueRefusal, JobQueue, JobTrigger } from './jobs.ts';

// ---------------------------------------------------------------------------
// The triggers.
// ---------------------------------------------------------------------------

export interface SchedulerConfig {
  /** Debt below this is not worth a cycle. */
  readonly minDebt: number;
  /** N in "quiet for N minutes". KTD11 puts it at 5–15. */
  readonly quietMs: number;
  /**
   * The floor on the gap between two cycles for one tenant. Applied to **both**
   * arms: without it, a debounced cycle finishing just before the tenant's
   * staggered ceiling slot is followed minutes later by a second, empty cycle.
   */
  readonly minIntervalMs: number;
  /** The backstop period. 24 hours at alpha, as a knob (KTD11). */
  readonly ceilingMs: number;
  /** How many due tenants one tick will look at. */
  readonly batchLimit: number;
}

export const ALPHA_CEILING_MS = 24 * 60 * 60 * 1000;

export const ALPHA_SCHEDULER: SchedulerConfig = {
  minDebt: 5,
  quietMs: 10 * 60 * 1000,
  minIntervalMs: 30 * 60 * 1000,
  ceilingMs: ALPHA_CEILING_MS,
  batchLimit: 500,
};

/** Why a tenant is due. Maps onto the job's recorded `trigger_reason`. */
export type DueReason = Extract<JobTrigger, 'debt_debounce' | 'time_ceiling'>;

export interface DueTenant {
  readonly tenantId: string;
  readonly pendingDebt: number;
  readonly reason: DueReason;
}

interface DueRow {
  readonly tenant_id: string;
  readonly pending_debt: number;
  readonly reason: DueReason;
}

/**
 * The two arms, in one statement so a tenant that satisfies both is returned
 * once, labelled with the arm that has the stronger claim on it.
 *
 * It is a sweep of `ready` tenants rather than an index seek, which is honest
 * for alpha (thousands of rows, one tick a minute) and is the query U15 revisits
 * when the fleet is sized for KTD1's substrate.
 */
export async function selectDueTenants(
  sql: SQL,
  options: { readonly now: Date; readonly config: SchedulerConfig; readonly limit?: number },
): Promise<readonly DueTenant[]> {
  const { now, config } = options;
  const quietBefore = new Date(now.getTime() - config.quietMs);
  const restedBefore = new Date(now.getTime() - config.minIntervalMs);
  const limit = options.limit ?? config.batchLimit;

  const rows = (await sql`
    WITH candidate AS (
      SELECT
        tenant_id,
        pending_debt,
        next_due_at,
        last_activity,
        (
          pending_debt >= ${config.minDebt}
          -- The two terms that separate "went quiet" from "was never here".
          -- Dropping either one enqueues a connector-only tenant on every tick.
          AND last_activity IS NOT NULL
          AND (last_cycle_at IS NULL OR last_activity > last_cycle_at)
          AND last_activity <= ${quietBefore}
        ) AS debounced,
        (next_due_at IS NOT NULL AND next_due_at <= ${now}) AS ceilinged,
        (last_cycle_at IS NULL OR last_cycle_at <= ${restedBefore}) AS rested
      FROM control.tenant
      WHERE state = 'ready'
    )
    SELECT
      tenant_id,
      pending_debt,
      CASE WHEN debounced THEN 'debt_debounce' ELSE 'time_ceiling' END AS reason
    FROM candidate
    WHERE rested AND (debounced OR ceilinged)
    ORDER BY debounced DESC, COALESCE(next_due_at, last_activity)
    LIMIT ${limit}
  `) as unknown as DueRow[];

  return rows.map((row) => ({
    tenantId: row.tenant_id,
    pendingDebt: row.pending_debt,
    reason: row.reason,
  }));
}

// ---------------------------------------------------------------------------
// The stagger.
// ---------------------------------------------------------------------------

/**
 * FNV-1a, 32-bit. Chosen because it is four lines, dependency-free and
 * deterministic across processes — the property that matters, since two
 * schedulers must agree about a tenant's slot during a rolling deploy.
 */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Where in the period this tenant's slot falls. Without it the whole fleet comes
 * due at the same instant — every ceiling-driven cycle in one thundering minute,
 * with the bound below rejecting most of them and the rest arriving a day late.
 */
export function staggerOffsetMs(tenantId: string, periodMs: number): number {
  if (periodMs <= 0) throw new Error('invariant: the ceiling period must be positive');
  return fnv1a(tenantId) % periodMs;
}

/**
 * The tenant's next staggered slot strictly after `from`.
 *
 * Strictly after, rather than "at least one period after", so the ceiling's
 * promise stays literal: no more than `periodMs` between a cycle and the next
 * time the tenant is due. A slot that lands sooner than that is held back by the
 * minimum inter-cycle interval rather than by moving the slot, which keeps the
 * fleet's slots fixed and its intervals bounded.
 */
export function nextCeilingDueAt(tenantId: string, from: Date, periodMs: number): Date {
  const offset = staggerOffsetMs(tenantId, periodMs);
  const at = from.getTime();
  const slot = Math.floor((at - offset) / periodMs) * periodMs + offset;
  return new Date(slot > at ? slot : slot + periodMs);
}

/**
 * Give a due time to every `ready` tenant that has none.
 *
 * Without this a tenant that has never cycled has `next_due_at IS NULL` and the
 * ceiling arm — the only arm a connected-but-inactive tenant ever satisfies —
 * never sees it. That is R3 failing silently: a source connected, ingestion
 * accruing, and nothing ever scheduled. Bounded per tick, and it only ever fills
 * a NULL: it cannot move a due time that already exists.
 */
export async function stampMissingDueTimes(
  sql: SQL,
  options: { readonly now: Date; readonly config: SchedulerConfig; readonly limit?: number },
): Promise<number> {
  const { now, config } = options;
  const limit = options.limit ?? config.batchLimit;

  const rows = (await sql`
    SELECT tenant_id, last_cycle_at
    FROM control.tenant
    WHERE state = 'ready' AND next_due_at IS NULL
    ORDER BY created_at
    LIMIT ${limit}
  `) as unknown as { tenant_id: string; last_cycle_at: Date | null }[];

  let stamped = 0;
  for (const row of rows) {
    const from = row.last_cycle_at ?? now;
    const due = nextCeilingDueAt(row.tenant_id, from, config.ceilingMs);
    const updated = (await sql`
      UPDATE control.tenant
      SET next_due_at = ${due}, updated_at = ${now}
      WHERE tenant_id = ${row.tenant_id} AND next_due_at IS NULL
      RETURNING tenant_id
    `) as unknown as { tenant_id: string }[];
    if (updated.length > 0) stamped += 1;
  }
  return stamped;
}

// ---------------------------------------------------------------------------
// Capacity. The arithmetic, not a constant.
// ---------------------------------------------------------------------------

export interface CapacityInputs {
  /** Tenants the fleet must keep inside the ceiling. */
  readonly tenants: number;
  readonly ceilingMs: number;
  /** Wall-clock duration of one cycle. U11 commits the measured number. */
  readonly cycleMs: number;
}

/**
 * `tenants ÷ (ceiling ÷ cycle duration)`, which is the plan's own formula
 * rearranged: each concurrent slot delivers `ceiling ÷ cycle` cycles per ceiling
 * period, and every tenant needs one.
 */
export function requiredConcurrency(inputs: CapacityInputs): number {
  if (inputs.ceilingMs <= 0 || inputs.cycleMs <= 0) {
    throw new Error('invariant: the ceiling period and the cycle duration must both be positive');
  }
  const cyclesPerSlot = inputs.ceilingMs / inputs.cycleMs;
  return Math.ceil(inputs.tenants / cyclesPerSlot);
}

/** The same equation solved the other way: what a bound is worth in tenants. */
export function maxTenantsAt(inputs: {
  readonly concurrency: number;
  readonly ceilingMs: number;
  readonly cycleMs: number;
}): number {
  if (inputs.ceilingMs <= 0 || inputs.cycleMs <= 0) {
    throw new Error('invariant: the ceiling period and the cycle duration must both be positive');
  }
  return Math.floor((inputs.concurrency * inputs.ceilingMs) / inputs.cycleMs);
}

export interface CapacityReport extends CapacityInputs {
  readonly concurrency: number;
  readonly requiredConcurrency: number;
  readonly maxTenants: number;
  /** True when the bound cannot keep the tenant count inside the ceiling. */
  readonly exceeded: boolean;
}

export function describeCapacity(
  inputs: CapacityInputs & { readonly concurrency: number },
): CapacityReport {
  const required = requiredConcurrency(inputs);
  return {
    ...inputs,
    requiredConcurrency: required,
    maxTenants: maxTenantsAt(inputs),
    exceeded: required > inputs.concurrency,
  };
}

/**
 * The alpha bound. It is a **resource** decision — twenty cycles at once is what
 * the fleet's compute and the model provider's throughput will carry — and it is
 * written here rather than derived because deriving it from a tenant target and
 * then quoting the tenant target as its consequence would be circular.
 *
 * What is derived is everything downstream: `ALPHA_CAPACITY` says what twenty
 * buys, and it moves on its own when the cycle estimate is replaced by U11's
 * measurement. A bound that stays at twenty while the cycle triples is then a
 * visibly smaller fleet rather than a silently late one.
 */
export const ALPHA_CONCURRENCY = 20;

/**
 * An estimate, and labelled as one. U11's exit gate commits the measured
 * wall-clock duration of a consolidation cycle as a receipt; until then every
 * capacity number in this module carries this assumption.
 */
export const ESTIMATED_CYCLE_MS = 3 * 60 * 1000;

export const ALPHA_CAPACITY: CapacityReport = describeCapacity({
  tenants: maxTenantsAt({
    concurrency: ALPHA_CONCURRENCY,
    ceilingMs: ALPHA_CEILING_MS,
    cycleMs: ESTIMATED_CYCLE_MS,
  }),
  ceilingMs: ALPHA_CEILING_MS,
  cycleMs: ESTIMATED_CYCLE_MS,
  concurrency: ALPHA_CONCURRENCY,
});

// ---------------------------------------------------------------------------
// The tick.
// ---------------------------------------------------------------------------

export interface SchedulerDeps {
  readonly sql: SQL;
  readonly queue: JobQueue;
  readonly config: SchedulerConfig;
  /** How far past expiry a lease must be before the sweep takes it. */
  readonly stealGraceMs: number;
}

export interface SchedulerTickResult {
  readonly reclaimed: number;
  readonly stamped: number;
  readonly due: number;
  readonly enqueued: readonly { readonly tenantId: string; readonly reason: DueReason }[];
  /**
   * Tenants the queue refused, with the reason it gave. Reported rather than
   * swallowed: a fleet whose enqueues are all coming back `quarantined` is a
   * fleet that has stopped working, and it looks identical to an idle one.
   */
  readonly refused: readonly { readonly tenantId: string; readonly reason: EnqueueRefusal }[];
  readonly capacity: CapacityReport;
}

/**
 * One pass: reap what died, give new tenants a due time, enqueue who is due.
 *
 * Reclaim runs **first**. A tenant whose consolidation is stuck in a dead
 * worker's lease is not due — its lane is occupied — so sweeping afterwards
 * would leave it one full tick behind on every cycle.
 */
export async function runSchedulerTick(
  deps: SchedulerDeps,
  options: { readonly now: Date; readonly cycleMs?: number },
): Promise<SchedulerTickResult> {
  const { sql, queue, config } = deps;
  const { now } = options;

  const reclaimed = await queue.reclaim({ now, stealGraceMs: deps.stealGraceMs });
  const stamped = await stampMissingDueTimes(sql, { now, config });
  const due = await selectDueTenants(sql, { now, config });

  const enqueued: { tenantId: string; reason: DueReason }[] = [];
  const refused: { tenantId: string; reason: EnqueueRefusal }[] = [];

  for (const tenant of due) {
    const outcome = await queue.enqueue({
      tenantId: tenant.tenantId,
      kind: 'consolidate',
      target: 'whole_brain',
      trigger: tenant.reason,
      now,
      debtObserved: tenant.pendingDebt,
    });
    if (outcome.enqueued) enqueued.push({ tenantId: tenant.tenantId, reason: tenant.reason });
    else refused.push({ tenantId: tenant.tenantId, reason: outcome.reason });
  }

  return {
    reclaimed: reclaimed.length,
    stamped,
    due: due.length,
    enqueued,
    refused,
    capacity: describeCapacity({
      tenants: due.length,
      ceilingMs: config.ceilingMs,
      cycleMs: options.cycleMs ?? ESTIMATED_CYCLE_MS,
      concurrency: ALPHA_CONCURRENCY,
    }),
  };
}
