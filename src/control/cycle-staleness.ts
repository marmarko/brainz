/**
 * Whether a brain is *finishing* its consolidation cycles, and the one clock
 * that can answer.
 *
 * **The failure this closes.** One brain's consolidation froze for days — 5,608
 * pages, 167 facts, flat — and nothing alerted. The mechanism is worth stating
 * exactly, because every cheaper rule than this one is a rule that would have
 * missed it, and because it is the third instance of one class of mistake:
 *
 *   * A cycle that stops short is deliberately **not** thrown on. It banks its
 *     reason, closes its run, and *returns* (`src/worker/consolidate/cycle.ts`
 *     — "One exit, for every reason"). So the handler returns normally.
 *   * A handler that returns is settled by `queue.complete()`, which stamps
 *     `control.tenant.last_cycle_at` and `next_due_at` in the same transaction
 *     as `state = 'done', failure_code = NULL` (`src/worker/queue.ts`). The
 *     settlement is computed by `defaultSettle(lease, now)`, which cannot see
 *     the cycle's outcome — `JobHandler` returns `void`.
 *   * So `control.job` held no dead rows, no failure codes and a fresh
 *     `finished_at`, and `last_cycle_at` stayed hours fresh throughout. Measured
 *     on the live control plane during the freeze, the frozen brain's
 *     `last_cycle_at` was *fresher* than a healthy canary's.
 *
 * Only one thing stood still: the instant a cycle last *completed*. Every other
 * clock in the system advances on a stopped cycle, and that includes
 * `finished_at` — since rung 23 a cycle closes its run on **every** exit
 * (`cycle.ts`, one `finishRun` call site under "One exit, for every reason"), so
 * the column that used to be written only by a completion is now written by all
 * six stop reasons. The completion clock is `finished_at` **gated by the
 * reason**, and the gate is the whole of it.
 *
 * So this module reads that and only that, and {@link CycleCompletionState} is
 * deliberately too narrow to carry a return time — it has no `lastCycleAt` and
 * no `lastReturnAt` field, so a later edit cannot quietly start measuring from
 * the clock that lied. (The one function here that *does* take a return clock
 * names it {@link ControlPlaneCycleInput.lastReturnAt} and is typed so it cannot
 * return {@link CycleFreshness} `'stale'`. See below.)
 *
 * **`stop_reason IN ('complete','free_tier')` is the completion predicate, not
 * `finished_at IS NOT NULL`.** The two are **already** non-equivalent, and this
 * is the correction that matters most in this header: they agreed only while
 * `finishRun` ran on two of the six reasons, and rung 23 ended that. A rule
 * anchored on `finished_at` today does not *risk* the trap class above — it IS
 * the trap class, and it has already been found live twice, in the coverage
 * page's backlog anchor and in the briefing assembler's debt anchor, each
 * resetting "how much has piled up" to roughly zero on every failed cycle of a
 * permanently frozen brain. Anything reading this column for completion is
 * wrong until it carries the reason with it.
 *
 * **The rule is a cross-product, not a severity ladder.** Two independent facts
 * decide it: what the *latest* cycle did, and how long ago the *last completion*
 * was.
 *
 *                      | latest completed  | latest stopped short
 *     ------------------------------------------------------------------
 *      completion recent | current         | slipping
 *      completion old    | unattended*     | stale        ← the incident
 *      never completed   | (not storable)  | starting / never_completed
 *
 * `unattended*` is the cell that keeps this usable. If the newest cycle
 * *completed* and that completion is nevertheless old, nothing is failing —
 * nothing has run. That is the scheduler's own failure, not the brain's, and it
 * only becomes an alarm at the wider ceiling so that a fleet paused over a long
 * weekend does not page.
 *
 * **Thresholds are multiples of the scheduling ceiling.** `ALPHA_SCHEDULER`
 * re-enqueues every tenant at a 24-hour ceiling whatever its debt does
 * (`src/worker/scheduler.ts:ALPHA_CEILING_MS`), so a healthy brain completes at
 * least once a day and the observed `next_due_at − last_cycle_at` on live
 * tenants is 23h48m–23h59m. One period is therefore the unit; everything below
 * is a multiple of it. This makes the alert inherently slower than the connector
 * one, which is honest rather than a defect: the failure it is written for
 * lasted days, and there is no faster truthful signal, because a brain that
 * consolidates once a day cannot be judged on an hour of silence.
 *
 * **Nothing here is content.** Every input is a code or an instant and every
 * output is a label from a closed set — which is what lets the same function
 * decide a user's own sentence on `/dashboard?view=coverage` and an operator's
 * fleet verdict.
 */

import type { StopReason } from '../worker/consolidate/checkpoint.ts';

/**
 * How often a brain is *actually* consolidated, at best.
 *
 * `ALPHA_SCHEDULER.ceilingMs` re-enqueues every tenant a day after its last
 * cycle regardless of debt, so no brain completes more often than this whatever
 * its activity says — it is the floor under every threshold below.
 *
 * Declared here rather than imported: `src/worker/scheduler.ts` reaches back
 * into `src/control/migrate.ts`, and a value import would pull the schema sweep
 * into the web fleet's bundle to read one number. `test/control/cycle-staleness.test.ts`
 * imports both and fails on drift, which is the guard the import would have been.
 */
export const CYCLE_PERIOD_SECONDS = 24 * 60 * 60;

/**
 * Missed ceilings before a brain is called stale, and before it is called
 * unattended.
 *
 * **Three periods for `stale`, and the number is set by the widest *healthy* gap
 * between completions rather than by the cadence.** A first consolidation of a
 * large brain legitimately stops on `out_of_time`, and the next cycle picks up
 * where it left off — not through the run, which is closed, but through the
 * per-row consideration stamps rung 22 put on the work itself. Because
 * `defaultSettle` is outcome-blind that chain reschedules at the full ceiling
 * each time, so a brain that is genuinely converging can go two ceilings without
 * a completion and be perfectly well. Three is past
 * anything that has been observed to converge, and the freeze this rule is
 * written for had been running for days by the time anybody looked.
 *
 * **Four periods for `unattended`, which is wider on purpose.** That cell is
 * where a paused fleet, a long deploy freeze and a scale-down land — nothing is
 * failing there, nothing has run — and a rule that pages on a three-day holiday
 * weekend is a rule somebody mutes, which is how the days happen again. It is
 * only one period wider rather than double the way the connector rule's is,
 * because under a *completed* latest cycle there is no resume chain to give the
 * benefit of the doubt to: the only reading left is that nothing scheduled it.
 */
export const STALE_PERIODS = 3;
export const UNATTENDED_PERIODS = 4;

/**
 * How long a brain that has never completed a cycle is given before it is an
 * alarm.
 *
 * The same three periods as {@link STALE_PERIODS}, deliberately: "it has been
 * cycling for three ceilings and never once finished" and "it stopped finishing
 * three ceilings ago" are the same emergency measured from different ends, and a
 * different number here would be an asymmetry with no argument behind it. The
 * window exists at all because a first consolidation is the largest single piece
 * of work a brain ever does — a monitor that flips on every signup for its first
 * day is a monitor that is off by the second week.
 */
export const FIRST_COMPLETION_GRACE_PERIODS = 3;

export function cyclePeriodSeconds(): number {
  return CYCLE_PERIOD_SECONDS;
}

export function staleAfterSeconds(): number {
  return CYCLE_PERIOD_SECONDS * STALE_PERIODS;
}

export function unattendedAfterSeconds(): number {
  return CYCLE_PERIOD_SECONDS * UNATTENDED_PERIODS;
}

export function firstCompletionGraceSeconds(): number {
  return CYCLE_PERIOD_SECONDS * FIRST_COMPLETION_GRACE_PERIODS;
}

/**
 * What the nine readings mean, and which of them anybody is paged for.
 *
 *  * `current` — a completion inside its window, and the latest cycle completed
 *    (or made no claim at all, which is an in-flight cycle; see below).
 *  * `slipping` — a completion inside its window, and the latest cycle stopped
 *    short. One `out_of_time` or one `budget_exhausted` is an ordinary Tuesday
 *    that the next cycle resumes into. Not an alarm — but worth showing, because
 *    it is the sentence that tells a user their spend cap is holding their
 *    brain.
 *  * `stale` — no completion inside its window, and the latest cycle stopped
 *    short for a reason the brain did not choose. **The incident.** Cycles are
 *    running constantly, every job succeeds, and nothing has finished for days.
 *  * `capped` — the same clock reading as `stale`, and a different fact: the
 *    latest cycle stopped because **the owner's own spend cap was reached**.
 *    Split out because the cap is a 30-day ROLLING figure (`tier.ts` passes
 *    `max(0, cap − spent)` over the window in `gateway.ts`), not a per-cycle
 *    allowance — so a cap reached on day 3 stops every cycle for the remaining
 *    ~24 days, and folding that into `stale` renders a brain doing exactly what
 *    it was configured to do as a multi-day emergency, every day, for most of
 *    the billing window. That is the shape an owner mutes, and a muted surface
 *    is how the freeze this module exists for ran for days. It is **not
 *    alarming** and it is **not silent**: the coverage page states it and names
 *    the remedy. The argument is the one `free_tier` already won one tier
 *    down — a plan working as configured is not a failure — and the reason it
 *    could not simply be folded INTO `free_tier` is that a free cycle closes
 *    `complete` while a capped one genuinely leaves model work undone.
 *  * `unattended` — the latest cycle completed (or banked nothing), and that was
 *    long enough ago that nothing has consolidated this brain since. The
 *    scheduler's own failure rather than the brain's.
 *  * `never_completed` — cycles have run, none has ever completed, past the
 *    grace. Distinct from `stale` on purpose: "it stopped finishing in March"
 *    and "it has never once finished" are different emergencies with different
 *    remedies.
 *  * `starting` — the same brain, inside the grace. Not yet a claim either way.
 *  * `uncycled` — no cycle has ever run, or (control plane) none has ever
 *    returned, and it is early enough for that to be ordinary.
 *  * `not_ready` — decided from the tenant's own state, before any clock is
 *    read. A half-provisioned brain that is not consolidating is not a fault.
 *  * `unobserved` — **the blind spot, named rather than hidden.** The surface
 *    doing the reading cannot see completions at all, so it declines to make a
 *    claim. Never alarming — a permanently non-green monitor is a monitor
 *    somebody turns off. The count of these is what argues for the follow-up
 *    that removes them; see {@link controlPlaneCycleFreshness}.
 */
export type CycleFreshness =
  | 'current'
  | 'slipping'
  | 'stale'
  | 'capped'
  | 'unattended'
  | 'never_completed'
  | 'starting'
  | 'uncycled'
  | 'not_ready'
  | 'unobserved';

/**
 * The brain's cycle history, reduced to the two fields that decide anything.
 *
 * **There is no return clock here and that is the point.** `last_cycle_at`,
 * `next_due_at`, `control.job.finished_at` and `consolidation_run.started_at`
 * all advanced normally throughout the freeze, so a rule that could see any of
 * them is a rule that could be rewritten to measure from one.
 */
export interface CycleCompletionState {
  /**
   * When a cycle last *closed* — `max(finished_at)` over runs whose
   * `stop_reason` is `complete` or `free_tier`, and never `finished_at IS NOT
   * NULL` alone. See this module's header for why the distinction is the whole
   * rule rather than a nicety.
   */
  readonly lastCompleteCycleAt: Date | null;
  /**
   * What the newest run banked. `null` is *no claim* rather than *failed*: an
   * open run with no reason is a cycle in flight or a cycle killed before it
   * could write, and those two are indistinguishable from here. Reading it as a
   * failure would flip every brain to `slipping` during every cycle it ran.
   */
  readonly latestStopReason: StopReason | null;
}

export interface CycleFreshnessInput {
  /** Absent means no cycle has ever started against this brain. */
  readonly completion: CycleCompletionState | undefined;
  /**
   * When this brain started cycling — the first run's `started_at`.
   *
   * Only ever used to decide whether a brain that has never completed is still
   * inside its first window. `null` is read as *expired*, not as *young*: on the
   * surface whose whole job is to notice, "I cannot tell how long this has been
   * trying" must not answer "so assume it just started".
   */
  readonly cyclingSince: Date | null;
  readonly now: Date;
}

export interface CycleFreshnessReport {
  readonly state: CycleFreshness;
  /** Echoed so a caller can render the clock it was judged against. */
  readonly lastCompleteCycleAt: Date | null;
  /** The threshold applied, so a surface can say what it used rather than guess. */
  readonly staleAfterSeconds: number;
}

/**
 * The readings an operator is paged for.
 *
 * `slipping` is deliberately not one, and neither is `capped`: a cap the owner
 * set is not a fleet fault, and paging on one teaches an operator to mute the
 * page that also carries the freeze. `capped` is still rendered to the owner,
 * who is the only party who can act on it — see `freezeNote` in
 * `src/web/pages.ts`, and note that "not alarming" there means "not red", never
 * "not shown".
 */
const ALARMING: ReadonlySet<CycleFreshness> = new Set<CycleFreshness>([
  'stale',
  'unattended',
  'never_completed',
]);

export function isAlarming(state: CycleFreshness): boolean {
  return ALARMING.has(state);
}

/**
 * The two stop reasons that close a run, restated where the rule can see them.
 *
 * `free_tier` is a **completion**, and the test pins it. A free brain's cycle
 * runs the deterministic half and finishes; `finishRun` closes it exactly as it
 * closes `complete`. Calling it a failure would put every free tenant in the
 * fleet permanently in `stale`, and a fleet verdict that is permanently red is
 * the same as no verdict at all.
 */
export function isCompletion(reason: StopReason): boolean {
  switch (reason) {
    case 'complete':
    case 'free_tier':
      return true;
    case 'budget_exhausted':
    case 'phase_failed':
    case 'cancelled':
    case 'out_of_time':
      return false;
  }
}

function elapsedSeconds(from: Date, now: Date): number {
  return (now.getTime() - from.getTime()) / 1000;
}

/**
 * The rule. Pure, so a mutation to it fails a case rather than a fleet.
 *
 * Fed only by a surface holding a tenant handle, because `consolidation_run`
 * lives in the tenant's own database and nothing in the control plane carries a
 * cycle outcome.
 */
export function cycleFreshnessOf(input: CycleFreshnessInput): CycleFreshnessReport {
  const staleAfter = staleAfterSeconds();
  const report = (state: CycleFreshness, lastCompleteCycleAt: Date | null = null) => ({
    state,
    lastCompleteCycleAt,
    staleAfterSeconds: staleAfter,
  });

  if (input.completion === undefined) {
    // No cycle has ever started here. Deliberately not an alarm from this
    // surface, and it is a limit rather than a judgement: `consolidation_run` is
    // the only thing being read, so an empty table gives no clock at all to
    // measure the silence against. Saying "this brain has never consolidated and
    // that is now too long" needs a *ready since*, which lives one plane over —
    // `controlPlaneCycleFreshness` has it and makes exactly that call.
    return report('uncycled');
  }

  const { lastCompleteCycleAt, latestStopReason } = input.completion;

  if (lastCompleteCycleAt === null) {
    // Cycles have run and none has ever closed. Inside the first window this is
    // a brain still chewing through its first consolidation; past it, it is a
    // brain that has never once worked — which no elapsed-time reading of a
    // completion clock can state, because there is no completion to measure
    // from.
    const trying =
      input.cyclingSince === null
        ? Number.POSITIVE_INFINITY
        : elapsedSeconds(input.cyclingSince, input.now);
    return report(trying <= firstCompletionGraceSeconds() ? 'starting' : 'never_completed', null);
  }

  const since = elapsedSeconds(lastCompleteCycleAt, input.now);

  if (latestStopReason === null || isCompletion(latestStopReason)) {
    // Nothing is claiming to have failed. Either a cycle closed recently, or
    // nothing has closed one since — and the second only becomes an alarm at the
    // wider ceiling, because up to a few days of it is an ordinary paused fleet.
    //
    // The two ways to arrive here are not the same fact and are treated the same
    // on purpose. A completed newest cycle with an old completion is exactly
    // "nothing has run since", the scheduler's own failure. A newest cycle that
    // banked *nothing* is a cycle in flight or one killed before it could write,
    // and those are indistinguishable from any surface — so at the near end this
    // reads `current` (a running cycle is not a fault) and at the far end it
    // still reaches an alarm, which is the property that matters for a crash
    // loop that never gets far enough to bank a reason.
    return report(since > unattendedAfterSeconds() ? 'unattended' : 'current', lastCompleteCycleAt);
  }

  // The newest cycle stopped short and said so. Whether that is an ordinary
  // pass that will be resumed by the next one, or the freeze, is decided by the
  // completion clock and by nothing else.
  if (since <= staleAfter) return report('slipping', lastCompleteCycleAt);

  // Past the window, and the reason now decides which of two different things
  // this is. A cap is the owner's instruction being obeyed; everything else is
  // the brain failing to finish. They read identically on every clock, which is
  // exactly why the reason has to be consulted here rather than inferred later.
  return report(
    latestStopReason === 'budget_exhausted' ? 'capped' : 'stale',
    lastCompleteCycleAt,
  );
}

/**
 * The subset of {@link CycleFreshness} the control plane is able to justify.
 *
 * **`'stale'` is not in it, and that is a type fact rather than a comment.**
 * Nothing in `control.tenant` or `control.job` records what a cycle *did* — the
 * outcome lives in `consolidation_run.stop_reason`, in the tenant's own
 * database, and the web fleet's health surface holds no tenant handles by
 * design. So the reading available fleet-wide cannot see the incident, and the
 * compiler is what keeps a later edit from claiming otherwise.
 */
export type ControlPlaneCycleFreshness = Extract<
  CycleFreshness,
  'not_ready' | 'uncycled' | 'unattended' | 'unobserved'
>;

export interface ControlPlaneCycleInput {
  /** `control.tenant.state`. Read first, and alone: see below. */
  readonly tenantState: string;
  /**
   * `control.tenant.last_cycle_at`, named for what it actually is.
   *
   * **A return clock, not a cycle clock.** `queue.complete()` stamps it in the
   * same transaction as `state = 'done'` for every consolidate job whose handler
   * *returned*, and a cycle that stops short returns — so it advanced on every
   * pass throughout a multi-day freeze. It is the exact analogue of
   * `connector_health.last_attempt_at`: useless for "is this healthy",
   * conclusive for "has anything even run".
   */
  readonly lastReturnAt: Date | null;
  /** `ready_at`, falling back to `created_at`. Only used for the first grace. */
  readonly readySince: Date | null;
  readonly now: Date;
}

/**
 * What the tenant row can honestly say, which is less.
 *
 * **Three readings, and the fourth is a refusal.** A tenant that is not `ready`
 * is not consolidating and that is not a fault. A tenant that has never
 * returned a cycle, past its grace, is one nothing has scheduled — the one cell
 * a return clock answers truthfully and the one an operator cannot get anywhere
 * else. Everything else answers {@link CycleFreshness} `'unobserved'`: something
 * came back recently, and whether it *finished* is not a fact this plane holds.
 *
 * **`'unobserved'` is not alarming, deliberately.** Every ready tenant in the
 * fleet reads it today, so an alarming `unobserved` would be a monitor that is
 * red on the day it ships and off by the end of the week — the state that let
 * the freeze run for days. The count published beside the verdict is the honest
 * artifact: *N brains whose completion this surface cannot see*, which is the
 * argument for the follow-up that removes them.
 *
 * **The follow-up, named.** `control.tenant.last_complete_cycle_at`, stamped
 * only when `stopReason ∈ {complete, free_tier}` — the same success-clock
 * discipline as `connector_health.last_success_at`. `onCycle` in
 * `src/worker/serve.ts` already receives `(tenantId, result)` inside a closure
 * holding `controlSql`, so it is one UPDATE plus a migration (worker territory,
 * and `onCycle` would need to be awaited rather than fired). When it lands, the
 * fleet feeds {@link cycleFreshnessOf} directly, `'unobserved'` stops being
 * produced, and this function goes away.
 */
export function controlPlaneCycleFreshness(
  input: ControlPlaneCycleInput,
): ControlPlaneCycleFreshness {
  // The tenant's state is read first and the clocks second, for the reason
  // `freshnessOf` reads the link before the health row: a half-provisioned or
  // deleting brain has clocks that will never move again, and a rule that
  // started from them would hold the fleet verdict red on rows nobody intends to
  // consolidate.
  if (input.tenantState !== 'ready') return 'not_ready';

  if (input.lastReturnAt === null) {
    // Nothing has ever come back for this brain. Inside the first window that is
    // provisioning finishing; past it, nothing is scheduling it at all.
    const waiting =
      input.readySince === null
        ? Number.POSITIVE_INFINITY
        : elapsedSeconds(input.readySince, input.now);
    return waiting <= firstCompletionGraceSeconds() ? 'uncycled' : 'unattended';
  }

  if (elapsedSeconds(input.lastReturnAt, input.now) > unattendedAfterSeconds()) {
    return 'unattended';
  }

  // Something returned inside the ceiling. Whether it *completed* is the
  // question, and this plane does not hold the answer, so it declines rather
  // than reporting the green it cannot justify.
  return 'unobserved';
}

/**
 * One field a monitor can page on, folded from many brains.
 *
 * Three levels rather than a boolean, so the external rule can be *warn on
 * `degraded`, page on `stalled`* rather than a JSON walk. Monotone: the worst
 * brain decides, because a fleet with one frozen brain in it is not a healthy
 * fleet with a rounding error. An empty fleet is `ok`, for the reason
 * `fleetConnectorVerdict` gives at length — the counts beside it are what tell
 * an empty fleet from a broken one.
 */
export type FleetCycleVerdict = 'ok' | 'degraded' | 'stalled';

export function fleetCycleVerdict(states: Iterable<CycleFreshness>): FleetCycleVerdict {
  let verdict: FleetCycleVerdict = 'ok';
  for (const state of states) {
    if (isAlarming(state)) return 'stalled';
    // `capped` warns rather than pages: an operator wants to know a brain has
    // been sitting at its ceiling for most of a window — that is a conversation
    // with its owner — but it is not an incident and must not read as one.
    if (state === 'slipping' || state === 'capped') verdict = 'degraded';
  }
  return verdict;
}
