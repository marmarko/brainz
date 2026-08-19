/**
 * The clock the cycle stops against, and the one thing it is not.
 *
 * **What was broken.** `locks.ts` stamps an `attempt_deadline_at` on every claim
 * — a wall-clock ceiling that is the fleet's stall backstop — and the
 * consolidation cycle could not read it. `CycleOptions` had no deadline field,
 * the phase loop had no time check, and `StopReason` had no member meaning "there
 * is more to do". So a cycle that ran long was not stopped: it was *reaped*, by a
 * reaper that increments `lease_token`, charges an attempt, and leaves the run
 * record exactly as the dead process left it. Five such attempts on one brain
 * produced no completed cycle and dead-lettered the lane.
 *
 * A reap and a clean stop are different events even when they happen at the same
 * instant. One is discovered by a timeout and banks whatever the process
 * happened to have committed; the other is *decided* by the work, banks a
 * position, names itself on the run record, and asks to be run again.
 *
 * **This is a budget, not a timeout.** Nothing here interrupts anything. It is
 * consulted *between* units of work — between phases, between batches, between
 * model calls — and the answer is advisory in the only way that matters: a unit
 * already in flight runs to its end. That is the property that makes the stop
 * clean. A budget that could cut a statement in half would leave exactly the torn
 * state the checkpoint exists to avoid, and it would need a cancellation story
 * for every query in the cycle to be safe. The wall-clock ceiling upstream stays
 * the backstop for the case this cannot cover: one unit of work that never
 * returns.
 *
 * **The margin is why the budget is smaller than the ceiling.** A cycle handed
 * exactly `attemptDeadlineAt - now` would finish its last unit of work *at* the
 * deadline and be reaped while writing its own run record — the failure this
 * module exists to end, arriving one statement later. The handler subtracts a
 * margin sized for the closing writes, and the cycle treats the result as the
 * real ceiling.
 */

/** Why an attempt must stop, or `null` while it may keep going. */
export type AttemptStop = 'out_of_time' | 'cancelled';

export interface AttemptBudget {
  /**
   * `null` while there is time and the lease is held; otherwise the reason to
   * stop. Cancellation is reported ahead of the clock: a lost lease means every
   * write from here is refused anyway, so "we ran out of time" would be a
   * misleading thing to write on the run record.
   *
   * **Only ask this where stopping banks something.** See {@link cancelled}.
   */
  stop(): AttemptStop | null;
  /**
   * The half of {@link stop} that applies to work which cannot resume.
   *
   * **The asymmetry is the point, and it took a starvation to find.** Stopping
   * on the clock is worth doing when the phase can hand its position to the next
   * attempt: committed work plus a cursor is progress. It is worth *nothing*
   * when the phase is a whole-set computation that will restart — the next
   * attempt redoes the same prefix, runs out at the same place, and the cycle
   * never advances past that phase however many attempts it is given. That is
   * the exact failure this module was written to end, reintroduced by the fix
   * for it.
   *
   * A lost lease is different in kind rather than in degree. Every write from
   * that point is unfenced against the tenant's database and fenced against the
   * control plane, so continuing cannot help and can only compound. So
   * cancellation stops everything; the clock stops only what can bank a
   * position, and the wall-clock ceiling upstream stays the backstop for the
   * rest.
   */
  cancelled(): 'cancelled' | null;
  /** Milliseconds left. `Infinity` when this attempt is unbudgeted. */
  remainingMs(): number;
  /** How long this attempt has been running. What the run record reports. */
  elapsedMs(): number;
  /**
   * Elapsed and remaining **as of the last consultation**, without taking a new
   * reading.
   *
   * The cycle consults this budget at every phase boundary, so the interval
   * between two of those consultations *is* a phase's duration — measured at the
   * instants the cycle already decided things at, rather than at two new instants
   * chosen by the measurement. That difference is not pedantry in either
   * direction it matters: a second reading taken a few statements after the
   * boundary attributes the bookkeeping between them to the phase, and under an
   * injected clock — where the suite's whole technique is one tick per decision —
   * a guard that took its own readings would move the budget it was reading.
   */
  elapsedAtLastCheck(): number;
  remainingAtLastCheck(): number;
}

export interface AttemptBudgetOptions {
  /** Injected so a test asserts on a duration without sleeping. */
  readonly clock?: () => number;
  /**
   * The soft ceiling. Omitted or non-finite means unbudgeted — which is what
   * every caller outside the job handler wants, and what the handler falls back
   * to only if the lease carries no deadline at all.
   */
  readonly budgetMs?: number | null;
  /** Aborted when the runner loses the lease or is shutting down. */
  readonly signal?: AbortSignal;
}

/**
 * A budget that has already started running.
 *
 * The start instant is taken here rather than at first use, because the interval
 * being measured is the *attempt*, and the attempt began when the handler was
 * called — not when some phase first thought to ask what time it was.
 */
export function createAttemptBudget(options: AttemptBudgetOptions = {}): AttemptBudget {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const budgetMs =
    options.budgetMs === null || options.budgetMs === undefined || !Number.isFinite(options.budgetMs)
      ? Number.POSITIVE_INFINITY
      : Math.max(0, options.budgetMs);
  const signal = options.signal;

  // The last reading taken, so a caller can ask what time it was at the moment
  // this budget was last consulted without consulting it again. See
  // {@link AttemptBudget.elapsedAtLastCheck}.
  let lastElapsed = 0;
  const elapsedMs = (): number => {
    lastElapsed = Math.max(0, clock() - startedAt);
    return lastElapsed;
  };

  const remainingFrom = (elapsed: number): number =>
    budgetMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : budgetMs - elapsed;

  return {
    elapsedMs,
    elapsedAtLastCheck: (): number => lastElapsed,
    remainingAtLastCheck: (): number => remainingFrom(lastElapsed),
    cancelled(): 'cancelled' | null {
      return signal?.aborted === true ? 'cancelled' : null;
    },
    remainingMs(): number {
      return remainingFrom(elapsedMs());
    },
    stop(): AttemptStop | null {
      if (signal?.aborted === true) return 'cancelled';
      // Read even when unbudgeted, which the early return here used to skip. An
      // unbudgeted attempt has nothing to stop for and still has phases worth
      // timing, and the readings above are the only ones anybody takes.
      const elapsed = elapsedMs();
      if (budgetMs === Number.POSITIVE_INFINITY) return null;
      return elapsed >= budgetMs ? 'out_of_time' : null;
    },
  };
}

/** A budget that never stops. The default for every caller that is not a job. */
export function unboundedAttempt(clock?: () => number): AttemptBudget {
  return createAttemptBudget(clock === undefined ? {} : { clock });
}
