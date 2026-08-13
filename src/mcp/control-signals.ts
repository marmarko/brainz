/**
 * The three control-plane signals KTD11's trigger consumes (U6 approach 3c).
 *
 * **This module produces; U10's scheduler consumes.** `control.tenant` already
 * declares the columns — `pending_debt`, `last_activity`, `rank1_score_sum`,
 * `rank1_sample_count` — and its own comment names this unit as the writer.
 * Until now nothing wrote them, which made the inactivity debounce correct and
 * permanently inert.
 *
 * **Debt on writes only.** A read that accrued debt would enqueue a
 * consolidation cycle for a tenant with nothing new to consolidate, on every
 * chatty agent, forever.
 *
 * **`last_activity` on user-originated calls only.** KTD11 is explicit: connector
 * polling accrues debt without resetting the quiet window. A mailbox that pulls
 * every five minutes would otherwise keep a tenant permanently "active", the
 * debounce would never fire, and the 24-hour ceiling would become the only
 * trigger in the system — a fleet that looks like it is working.
 *
 * **Off the response critical path, and throttled.** `entity` publishes a warm
 * p99 under 100ms; an UPDATE against a second database inside that budget is the
 * kind of thing that turns a latency promise into a latency hope. So calls
 * accumulate in memory and flush at most once per tenant per 30 seconds, and a
 * flush that fails is counted rather than raised — the tool call has already
 * been answered.
 *
 * **Deltas coalesce; they are not dropped.** The throttle bounds how often the
 * control plane is *written*, not how much debt is counted. Three writes inside
 * one window bank three, on the next flush. The residual, written down: a
 * process that dies inside a window loses that window's accumulated debt. Debt
 * is a scheduling hint whose backstop is the 24-hour time ceiling, so the cost
 * of the loss is a late cycle rather than a lost one.
 */

import type { SQL } from 'bun';

/** KTD11's window: at most one activity stamp per tenant per 30 seconds. */
export const ACTIVITY_THROTTLE_MS = 30_000;

export interface SignalDelta {
  /** How much to add to `pending_debt`. Zero on reads. */
  readonly debt: number;
  /** ISO timestamp to stamp, or `null` to leave `last_activity` alone. */
  readonly activityAt: string | null;
  readonly rank1Sum: number;
  readonly rank1Count: number;
}

export interface SignalSink {
  apply(tenantId: string, delta: SignalDelta): Promise<void>;
}

export interface SignalInput {
  readonly tenantId: string;
  /** True for a call a person caused. False for connector-driven work. */
  readonly userOriginated: boolean;
  readonly debt: number;
  /** The top result's score, when this call ranked anything. */
  readonly rank1Score?: number;
}

export interface ControlSignals {
  /** Records a call. Returns immediately; never throws. */
  record(input: SignalInput): void;
  /** Forces every pending delta out. Awaited by tests and at shutdown. */
  flush(): Promise<void>;
  /** Flushes that failed. Observability, and the guard's assertion. */
  readonly failures: number;
}

interface Pending {
  debt: number;
  rank1Sum: number;
  rank1Count: number;
  activityAt: string | null;
  lastStampAt: number;
}

export function createControlSignals(options: {
  readonly sink: SignalSink;
  readonly now: () => number;
  readonly throttleMs?: number;
}): ControlSignals {
  const throttleMs = options.throttleMs ?? ACTIVITY_THROTTLE_MS;
  const pending = new Map<string, Pending>();
  const stamped = new Map<string, number>();
  let inFlight: Promise<void> = Promise.resolve();
  let failures = 0;

  function entryFor(tenantId: string): Pending {
    const existing = pending.get(tenantId);
    if (existing !== undefined) return existing;
    const fresh: Pending = { debt: 0, rank1Sum: 0, rank1Count: 0, activityAt: null, lastStampAt: 0 };
    pending.set(tenantId, fresh);
    return fresh;
  }

  async function drain(): Promise<void> {
    const batch = [...pending.entries()];
    pending.clear();
    for (const [tenantId, entry] of batch) {
      if (entry.debt === 0 && entry.rank1Count === 0 && entry.activityAt === null) continue;
      try {
        await options.sink.apply(tenantId, {
          debt: entry.debt,
          activityAt: entry.activityAt,
          rank1Sum: entry.rank1Sum,
          rank1Count: entry.rank1Count,
        });
      } catch {
        // Counted, never raised. The response has already been sent, and a
        // control-plane blip must not become a failed read.
        failures += 1;
      }
    }
  }

  return {
    record(input) {
      try {
        const at = options.now();
        const entry = entryFor(input.tenantId);
        entry.debt += input.debt;
        if (input.rank1Score !== undefined && Number.isFinite(input.rank1Score)) {
          entry.rank1Sum += input.rank1Score;
          entry.rank1Count += 1;
        }
        if (input.userOriginated) {
          const last = stamped.get(input.tenantId) ?? Number.NEGATIVE_INFINITY;
          if (at - last >= throttleMs) {
            stamped.set(input.tenantId, at);
            entry.activityAt = new Date(at).toISOString();
          }
        }
      } catch {
        failures += 1;
      }
    },

    flush() {
      inFlight = inFlight.then(drain, drain);
      return inFlight;
    },

    get failures() {
      return failures;
    },
  };
}

/**
 * The real sink: one statement against `control.tenant`.
 *
 * `pending_debt = pending_debt + $` rather than `= $`, because U10's completion
 * path subtracts the debt it *observed* and a blind assignment from either side
 * discards everything that arrived mid-cycle. `last_activity` uses `GREATEST`
 * so an out-of-order flush from a second instance cannot move the stamp
 * backwards — two stateless containers serving one tenant during a rolling
 * deploy is the ordinary case, not the exotic one.
 */
export function createPostgresSignalSink(sql: SQL): SignalSink {
  return {
    async apply(tenantId, delta) {
      await sql`
        UPDATE control.tenant
           SET pending_debt = pending_debt + ${delta.debt},
               rank1_score_sum = rank1_score_sum + ${delta.rank1Sum},
               rank1_sample_count = rank1_sample_count + ${delta.rank1Count},
               last_activity = CASE
                 WHEN ${delta.activityAt}::timestamptz IS NULL THEN last_activity
                 ELSE GREATEST(COALESCE(last_activity, to_timestamp(0)), ${delta.activityAt}::timestamptz)
               END,
               updated_at = now()
         WHERE tenant_id = ${tenantId}
      `;
    },
  };
}
