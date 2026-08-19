/**
 * The cycle: estimate, then cheap, then expensive, checkpointing as it goes.
 *
 * **Where it stops is the interesting part.** Four exits, and they are not
 * interchangeable — an operator reading a run record has to be able to tell them
 * apart, and the next cycle behaves differently for each:
 *
 *   `complete`          — everything ran. `dreamt: true`. The run closes and its
 *                         checkpoints go with it.
 *   `free_tier`         — R8's line. The deterministic phases ran, no model was
 *                         called, and the run **closes**: nothing was left
 *                         undone that a later cycle should skip.
 *   `budget_exhausted`  — the cap fired. The run stays **open**, so the next
 *                         cycle resumes into it and does not re-pay for the model
 *                         phases that finished. This is U11's "consolidated but
 *                         not dreamt".
 *   `phase_failed`      — a provider was unavailable, or answered with something
 *                         this code cannot read. Also stays open, for the same
 *                         reason and with a different name, because "we ran out
 *                         of money" and "the provider was down" want different
 *                         responses.
 *
 *   `out_of_time`      — the attempt's wall clock ran out with work left. The
 *                         run stays **open** and a *position* is banked, so the
 *                         next attempt resumes inside the phase that was
 *                         interrupted. The job completes normally and asks to be
 *                         run again; see {@link createConsolidateHandler}.
 *   `cancelled`         — the lease was lost or the worker is shutting down.
 *                         Same banking, different name, because "we were
 *                         interrupted" and "this brain is bigger than one
 *                         attempt" want different responses.
 *
 * A fifth reason, `abandoned`, is never a cycle's own: it is written by
 * {@link openRun} onto a run that was left open for longer than a continuation
 * lasts, so that the work can carry on in a fresh one. See
 * {@link CONTINUATION_HORIZON_MS}.
 *
 * **A checkpoint's subject is money for the model tier and position for the
 * deterministic one**, and the difference is what makes both true at once. The
 * original asymmetry — only model phases skipped — was the right reading of
 * KTD11's "never re-pays model calls" and the wrong reading of a wall clock. The
 * deterministic phases cost nothing to *run* and everything to run *again* under
 * a ceiling: on a 5,608-page brain they re-ran in full on every attempt, so five
 * attempts of fifteen minutes each produced no completed cycle and the lane
 * dead-lettered.
 *
 * So the deterministic tier now resumes, and it resumes **only while the run is
 * being continued on the clock** (`out_of_time`, `cancelled`). The original
 * argument survives intact for every other resume: a run that stopped because a
 * provider was unavailable may be picked up hours later over a brain that has
 * ingested since, and skipping its free work would be a tenant at a zero cap
 * silently ceasing to deduplicate — the free tier failing quietly at exactly the
 * thing it was promised.
 *
 * **The order is asserted, not assumed.** `assertPhaseOrder` runs before the
 * first phase: an order with a model phase ahead of a deterministic one spends
 * money before doing the free work, and nothing about that fails on its own.
 */

import type { SQL } from 'bun';

import type { Budget, ModelGateway } from '../../ai/gateway.ts';
import { PROFILES, type NamedProfile, type RoutingProfileName } from '../../ai/routing.ts';
import type { CallerIdentity } from '../../control/secrets.ts';
import { fleetIdentity } from '../../control/secrets.ts';
import type { StoredPayloadReader } from '../../core/media/accept.ts';
import type { HandlerOutcome, JobContext, JobHandler } from '../runner.ts';
import type { JobTrigger } from '../jobs.ts';
import { ALPHA_CEILING_MS } from '../scheduler.ts';
import {
  bankEstimate,
  bankPhaseProgress,
  completePhase,
  finishRun,
  openRun,
  phaseIsComplete,
  readPhaseTimings,
  recordPhaseDuration,
  recordProgress,
  reopenPhase,
  type ConsolidationTier,
  type CycleRun,
  type PhaseCheckpoint,
  type StopReason,
} from './checkpoint.ts';
import { createAttemptBudget, type AttemptBudget } from './deadline.ts';
import {
  clusterByEmbedding,
  collapseDuplicateFacts,
  computeDeterministicSalience,
  markStaleness,
  mergeEntitiesByRule,
  reconcileAllEdges,
  type PhaseProgress,
} from './deterministic.ts';
import {
  NO_SPEND,
  budgetsFor,
  estimateCycle,
  measureWorkload,
  type CycleEstimate,
} from './estimate.ts';
import { MODEL_PHASE_RUNNERS, type PhaseOutcome } from './model-phases.ts';
import {
  CYCLE_PHASES,
  TIER_OF,
  assertPhaseOrder,
  canStopPartWay,
  isModelPhase,
  type CyclePhase,
  type ModelPhase,
} from './phases.ts';

export interface CycleDeps {
  readonly sql: SQL;
  readonly gateway: ModelGateway;
  readonly tenantId: string;
  readonly caller: CallerIdentity;
  /**
   * The routing profile the estimate prices against.
   *
   * Resolved from the gateway's profile name when omitted, and that resolution
   * can fail: an operator serving from their own endpoint hands the gateway a
   * profile this process has never seen, and pricing a cycle against the shipped
   * table would then be an estimate of somebody else's costs.
   */
  readonly profile?: NamedProfile;
  /**
   * How U21's transcription phase reads a stored payload back.
   *
   * A port rather than an object-store client, for the reason every other
   * boundary in this file is one: the cycle schedules work and does not resolve
   * credentials. Absent on a fleet with no object store wired — the phase then
   * reports the work it cannot do instead of reporting none.
   */
  readonly payloads?: StoredPayloadReader;
}

export interface CycleOptions {
  readonly trigger: JobTrigger;
  readonly tier: ConsolidationTier;
  readonly now: Date;
  /** A ceiling on the whole cycle's model spend. `0` is the free tier's cap. */
  readonly capMicroUsd?: number | null;
  /** How many candidates a phase considers. Bounds the cycle, not the corpus. */
  readonly limit?: number;
  readonly nonce?: string;
  /** Injected so a test can assert on a duration without sleeping. */
  readonly clock?: () => number;
  /**
   * The keyset batch the walking deterministic phases take per read/write pair.
   *
   * Absent leaves every phase at its own tuned constant, which is what the fleet
   * wants: those numbers were measured against a real brain, and a cycle that
   * second-guessed them would be a second tuning nobody took. It is expressible
   * because the property the whole resume mechanism exists for — an attempt
   * interrupted mid-walk hands the next one its position — is only reachable
   * over more rows than one batch, and a suite that had to seed five hundred
   * pages to reach it is a suite that stops being run.
   */
  readonly batch?: number;
  /**
   * The attempt's wall-clock budget. Absent means unbudgeted, which is what
   * every caller that is not a job wants.
   *
   * It is **not** `DEFAULT_MAX_ATTEMPT_MS`, and it is deliberately not read from
   * `locks.ts` here: the number that matters is what is left of *this* attempt's
   * ceiling, which only the lease knows. {@link createConsolidateHandler}
   * computes it. Hard-coding the constant would make a cycle claimed nine
   * minutes ago believe it had fifteen.
   */
  readonly budgetMs?: number | null;
  /**
   * Aborted when the runner loses the lease or is stopping.
   *
   * `JobContext` has carried this since U10 and the cycle used to drop it, so a
   * dispossessed attempt kept issuing statements against the tenant's database
   * long after its writes to the control plane were fenced. The fence protects
   * the job row; nothing protected the brain.
   */
  readonly signal?: AbortSignal;
}

export interface PhaseRecord {
  readonly phase: CyclePhase;
  readonly tier: 'deterministic' | 'model';
  readonly ran: boolean;
  /**
   * Why the phase did not run. `does_not_fit` is the one that is a *decision*:
   * the phase cannot be stopped part-way and its last measured duration was
   * longer than what was left, so the cycle declined to start it.
   */
  readonly skipped: 'checkpointed' | 'free_tier' | 'not_reached' | 'does_not_fit' | null;
  readonly items: number;
  readonly spentMicroUsd: number;
  readonly stopped: string | null;
}

export interface CycleResult {
  readonly runId: string;
  readonly resumed: boolean;
  readonly dreamt: boolean;
  readonly stopReason: StopReason;
  /**
   * There is work left and running the same cycle again would do it. True for
   * the clock stops and for a phase declined as too long — all three are cured
   * by a fresh attempt's full budget. A cap that fired or a provider that was
   * down are also unfinished, and both want to wait rather than to be retried at
   * once.
   */
  readonly moreToDo: boolean;
  /**
   * This attempt banked something the next one will not redo.
   *
   * The guard on the continuation loop. A cycle that stopped out of time having
   * advanced *nothing* would, if it asked to be re-run, ask again forever at
   * whatever rate the scheduler ticks. Reported rather than inferred, because
   * "did anything move" is a fact about the phases and not about the clock.
   */
  readonly advanced: boolean;
  readonly phases: readonly PhaseRecord[];
  readonly wallClockMs: number;
  readonly spentMicroUsd: number;
  readonly modelCalls: number;
  readonly estimate: CycleEstimate;
}

function profileOf(deps: CycleDeps): NamedProfile {
  if (deps.profile !== undefined) return deps.profile;
  const named = PROFILES[deps.gateway.profileName as RoutingProfileName];
  if (named === undefined) {
    throw new Error(
      `no routing profile named '${deps.gateway.profileName}'; pass one to the cycle rather than ` +
        'pricing it against a table that does not describe what this gateway calls',
    );
  }
  return named;
}

const DEFAULT_LIMIT = 200;

/**
 * How old an open run may be and still be a continuation.
 *
 * The deterministic tier's checkpoints are honoured while a run is being
 * *continued* — attempts seconds apart, working the same brain down. They are
 * not honoured for a continuation that got stuck, because the argument for
 * skipping them is "nothing has changed since", and after a day of ingestion
 * something has.
 *
 * One ceiling period, derived rather than typed: past that the tenant would have
 * been given a fresh cycle anyway, so a run still open beyond it is not a
 * continuation in any sense the scheduler recognises.
 *
 * **It closes the run, and the first version of it did not — which made it a
 * trap rather than a bound.** Distrusting the checkpoints of a run left open is
 * only half a decision: `started_at` never advances, nothing but a completed
 * cycle sets `finished_at`, and there is no abandonment sweep anywhere. So a run
 * that crossed the horizon could not leave it. Every later attempt restarted the
 * whole deterministic tier from zero, which on a brain whose free tier outlives
 * one attempt means the tier is never finished, the model tier is never reached,
 * and the cycle never completes — the original dead-lane failure, reintroduced
 * by the bound that was written to prevent a different one.
 *
 * Handed to {@link openRun}, because "is this still a continuation" and "do we
 * adopt it" are one question. Past the horizon the run is closed as `abandoned`
 * and a fresh one opens: fresh `started_at`, so the free work is re-run *once*
 * — which is what the horizon wanted — rather than for ever.
 */
const CONTINUATION_HORIZON_MS = ALPHA_CEILING_MS;

export async function runConsolidationCycle(
  deps: CycleDeps,
  options: CycleOptions,
): Promise<CycleResult> {
  assertPhaseOrder(CYCLE_PHASES);

  const attempt = createAttemptBudget({
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const limit = options.limit ?? DEFAULT_LIMIT;
  const profile = profileOf(deps);

  // Estimate before running, and bank it before the first phase: a number
  // computed and then discarded is a calculation nobody can audit against a bill.
  const workload = await measureWorkload(deps.sql, { batch: limit });
  const estimate = estimateCycle({ profile, workload });

  const opened = await openRun(deps.sql, {
    trigger: options.trigger,
    tier: options.tier,
    now: options.now,
    estimateMicroUsd: options.tier === 'free' ? 0 : estimate.totalMicroUsd,
    horizonMs: CONTINUATION_HORIZON_MS,
  });
  const run = opened.run;

  let budgets: Readonly<Record<ModelPhase, Budget>> = budgetsFor(estimate, { capMicroUsd: NO_SPEND });
  let priced = estimate;

  // What each phase cost the last time it finished. Read once: nothing but the
  // end of a phase writes it, so asking again per phase would be six round trips
  // to learn six numbers that cannot have changed.
  const timings = await readPhaseTimings(deps.sql);

  const phases: PhaseRecord[] = [];
  let spent = opened.spentMicroUsd;
  let modelCalls = 0;
  let refined = false;
  let advanced = false;
  let stop: StopReason = 'complete';

  // **Whose checkpoints still describe the brain as it is now.** A run continued
  // on the clock is the same attempt one process later, so its free work is
  // current and skipping it is thrift. A run resumed after a provider outage may
  // be hours old over a brain that has ingested since, and skipping its free
  // work would be the free tier quietly stopping. See the header.
  // The age half of this test is gone, and its absence is the point: `openRun`
  // does not hand back a run older than the horizon, so a run that reaches here
  // is inside it by construction. Keeping the clause as a belt would be keeping
  // the branch that made the horizon absorbing, in a place where it now can
  // never be true — dead code that reads as the live rule.
  const continuingOnTheClock =
    opened.previousStop === 'out_of_time' || opened.previousStop === 'cancelled';
  const bankedFor = (phase: CyclePhase): PhaseCheckpoint | undefined => {
    const banked = opened.banked.get(phase);
    if (banked === undefined) return undefined;
    if (isModelPhase(phase)) return banked;
    return continuingOnTheClock ? banked : undefined;
  };

  // **A phase's duration is the interval between the two consultations that
  // bracket it**, and the cycle already takes both: it asks the budget at every
  // phase boundary. Measuring from those readings rather than taking its own
  // means the guard costs nothing and cannot move what it is reading. Only a
  // phase that *completed* is banked — see `recordPhaseDuration`.
  let measuring: { readonly phase: CyclePhase; readonly enteredAt: number } | null = null;
  const closeMeasurement = async (at: number): Promise<void> => {
    if (measuring === null) return;
    await recordPhaseDuration(deps.sql, measuring.phase, at - measuring.enteredAt, options.now);
    measuring = null;
  };

  for (const phase of CYCLE_PHASES) {
    if (stop !== 'complete') {
      phases.push({
        phase,
        tier: TIER_OF[phase],
        ran: false,
        skipped: 'not_reached',
        items: 0,
        spentMicroUsd: NO_SPEND,
        stopped: null,
      });
      continue;
    }

    // Consulted **between** phases, so the stop is a decision rather than a
    // reap: whatever is in flight finishes, its position is banked, and the run
    // record carries a name an operator can act on.
    const halted = attempt.stop();
    const boundary = attempt.elapsedAtLastCheck();
    await closeMeasurement(boundary);
    if (halted !== null) {
      stop = halted;
      phases.push({
        phase,
        tier: TIER_OF[phase],
        ran: false,
        skipped: 'not_reached',
        items: 0,
        spentMicroUsd: NO_SPEND,
        stopped: null,
      });
      continue;
    }

    // **The estimate is refined once, on the boundary between the tiers.** The
    // one taken before the cycle is banked on the run record so an aborted run
    // still carries a number — but the deterministic tier is what *creates* the
    // model tier's inputs: it resolves the entities enrichment reads and merges
    // the ones it would otherwise have paid for twice. A cap computed before it
    // is a cap over work that did not exist yet, and on a fresh brain it is
    // zero, which stops the cycle at the first model call for no reason anyone
    // would recognise.
    if (isModelPhase(phase) && !refined) {
      refined = true;
      if (options.tier !== 'free') {
        priced = estimateCycle({
          profile,
          workload: await measureWorkload(deps.sql, { batch: limit }),
        });
        budgets = budgetsFor(priced, { capMicroUsd: options.capMicroUsd ?? null });
        await bankEstimate(deps.sql, run.runId, priced.totalMicroUsd);
      }
    }

    if (isModelPhase(phase) && options.tier === 'free') {
      phases.push({
        phase,
        tier: 'model',
        ran: false,
        skipped: 'free_tier',
        items: 0,
        spentMicroUsd: NO_SPEND,
        stopped: null,
      });
      continue;
    }

    const banked = bankedFor(phase);

    if (banked?.completed === true) {
      phases.push({
        phase,
        tier: TIER_OF[phase],
        ran: false,
        skipped: 'checkpointed',
        items: 0,
        spentMicroUsd: NO_SPEND,
        stopped: null,
      });
      continue;
    }

    if (!isModelPhase(phase)) {
      // **A phase that has to run to the end is decided about before it starts.**
      // `link_reconcile` diffs the live edges against a desired set built from
      // every live fact, so an interruption anywhere inside it is either wasted
      // or destructive — there is no partial answer it could bank. Entering it
      // with less than it needs can therefore only end in a reap, which is the
      // event this whole seam replaces with a decision. Declining is the
      // decision, and it carries a name so a phase that stops fitting *at all*
      // is an operator's alert rather than a lane that goes quiet.
      //
      // Answered from the boundary reading taken a few statements ago rather
      // than from a fresh one: that reading is what defines the interval the
      // measurement below was taken over, and a guard that took its own would be
      // timing itself.
      const expected = timings.get(phase);
      if (!canStopPartWay(phase) && expected !== undefined && expected > attempt.remainingAtLastCheck()) {
        stop = 'phase_does_not_fit';
        phases.push({
          phase,
          tier: 'deterministic',
          ran: false,
          skipped: 'does_not_fit',
          items: 0,
          spentMicroUsd: NO_SPEND,
          stopped: stop,
        });
        continue;
      }

      // **What this phase had banked before the attempt started**, which is not
      // always what it is allowed to resume from: `bankedFor` withholds a
      // deterministic checkpoint from a resume that is not on the clock, and the
      // phase then re-runs. Both facts are needed below — one to run the phase,
      // the other to judge whether running it got anywhere.
      const snapshot = opened.banked.get(phase);

      const outcome = await runDeterministicPhase(deps.sql, phase, {
        run,
        now: options.now,
        cursor: banked?.cursor ?? null,
        attempt,
        ...(options.batch === undefined ? {} : { batch: options.batch }),
        ...(timings.has('link_reconcile')
          ? { reconcileCostMs: timings.get('link_reconcile') as number }
          : {}),
      });
      // Items are banked **cumulatively over the run** and reported per attempt.
      // A phase resumed three times has done the sum of what its three attempts
      // did, and a checkpoint that recorded only the last one would describe a
      // brain nobody consolidated.
      const total = (banked?.items ?? 0) + outcome.items;

      // **Rows changed are progress wherever they happen.** A collapse, a merge,
      // a supersession or an edge taken down is work the next attempt will not
      // find waiting, whether or not the phase that did it finished.
      if (outcome.mutations > 0) advanced = true;

      if (outcome.done) {
        // Timed from the boundary above to the next one, which is where
        // `closeMeasurement` collects it.
        measuring = { phase, enteredAt: boundary };
        await completePhase(deps.sql, run, phase, {
          items: total,
          spentMicroUsd: NO_SPEND,
          now: options.now,
        });
        // A completion is progress only if it was not already banked. When a
        // resume is not on the clock the free work runs again — legitimately,
        // because the brain has moved since — but a phase completing over rows
        // nobody changed is repetition, and reading it as progress is what kept
        // the continuation gate permanently open.
        if (snapshot?.completed !== true) advanced = true;
      } else if (outcome.cursor !== null) {
        await bankPhaseProgress(deps.sql, run, phase, {
          items: total,
          cursor: outcome.cursor,
          now: options.now,
        });
        // A position is progress when the phase *resumed* from the one it
        // replaces, or when there was none to resume from. A phase whose
        // checkpoint was withheld started at the beginning again, and the
        // positions it reaches on the way back to where it already was are
        // repetition wearing a new number.
        if (snapshot === undefined || (banked !== undefined && outcome.cursor !== banked.cursor)) {
          advanced = true;
        }
        stop = attempt.stop() ?? 'out_of_time';
      } else if (outcome.refused !== undefined) {
        // The phase declined work it triggered rather than starting something it
        // could not finish — the staleness fix point, which is a reconciliation
        // by another name and inherits the same rule. Nothing is banked; the
        // phase is honestly incomplete.
        stop = 'phase_does_not_fit';
      } else {
        // Stopped with no position to hand over: a whole-set phase that will
        // restart. Nothing is banked, deliberately — a checkpoint here would
        // claim a completion this phase did not reach.
        stop = attempt.stop() ?? 'out_of_time';
      }

      phases.push({
        phase,
        tier: 'deterministic',
        ran: true,
        skipped: null,
        items: outcome.items,
        spentMicroUsd: NO_SPEND,
        stopped: outcome.done ? null : stop,
      });
      continue;
    }

    const outcome: PhaseOutcome = await MODEL_PHASE_RUNNERS[phase]({
      sql: deps.sql,
      gateway: deps.gateway,
      tenantId: deps.tenantId,
      caller: deps.caller,
      budget: budgets[phase],
      runId: run.runId,
      now: options.now,
      limit,
      attempt,
      ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
      ...(deps.payloads === undefined ? {} : { payloads: deps.payloads }),
    });

    spent += outcome.spentMicroUsd;
    modelCalls += outcome.modelCalls;

    if (outcome.stopped === null) {
      await completePhase(deps.sql, run, phase, {
        items: outcome.items,
        spentMicroUsd: outcome.spentMicroUsd,
        now: options.now,
      });
      advanced = true;
    } else if (outcome.stopped === 'out_of_time') {
      // A model phase that ran out of the clock banks nothing — a partial
      // checkpoint row for a model phase would make the *previous* fleet
      // version, which reads every row as a completion, skip the phase outright
      // mid-deploy. Its progress is durable in the content instead: the synopsis
      // phase no longer re-selects a page it has already summarised, so the next
      // attempt starts where this one stopped without a row to say so.
      stop = attempt.stop() ?? 'out_of_time';
    } else {
      stop = outcome.stopped === 'budget_exhausted' ? 'budget_exhausted' : 'phase_failed';
    }
    if (outcome.applied > 0 || outcome.queued > 0) advanced = true;

    phases.push({
      phase,
      tier: 'model',
      ran: true,
      skipped: null,
      items: outcome.items,
      spentMicroUsd: outcome.spentMicroUsd,
      stopped: outcome.stopped,
    });
  }

  const stopReason: StopReason =
    stop === 'complete' && options.tier === 'free' ? 'free_tier' : stop;
  const dreamt = stopReason === 'complete';
  const wallClockMs = attempt.elapsedMs();
  await closeMeasurement(wallClockMs);
  const ran = phases.filter((phase) => phase.ran).length;
  const moreToDo =
    stopReason === 'out_of_time' ||
    stopReason === 'cancelled' ||
    stopReason === 'phase_does_not_fit';

  const record = {
    dreamt,
    stopReason,
    spentMicroUsd: spent,
    modelCalls,
    phasesRun: ran,
    wallClockMs,
    now: options.now,
  };

  // A run that stopped short stays open, because that null `finished_at` is the
  // resume signal. Closing it here would be the cycle forgiving itself and the
  // next one paying for the phases this one already completed.
  if (stopReason === 'complete' || stopReason === 'free_tier') {
    await finishRun(deps.sql, run, record);
  } else {
    await recordProgress(deps.sql, run, record);
  }

  return {
    runId: run.runId,
    resumed: opened.resumed,
    dreamt,
    stopReason,
    moreToDo,
    advanced,
    phases,
    wallClockMs,
    spentMicroUsd: spent,
    modelCalls,
    estimate: priced,
  };
}

/**
 * What one deterministic phase did, in the two counts that answer two questions.
 *
 * `items` is what the phase looked at, and it is what an operator reads. It is
 * **not** an answer to "did this attempt get anywhere", because two of the six
 * phases re-do their whole output every pass by design: salience re-scores every
 * page because the recency term decays with wall clock, and clustering rebuilds
 * membership from the current corpus. Counting either as progress makes an
 * attempt that repeated itself indistinguishable from one that moved, which is
 * exactly the reading that kept a stuck continuation asking to be run again.
 *
 * `mutations` is the narrower count: rows this phase changed in a way no later
 * attempt will do again. Zero for salience and clustering — not because they did
 * nothing, but because what they did, they will do again next pass, and their
 * real position is the cursor.
 */
export interface DeterministicOutcome extends PhaseProgress {
  readonly items: number;
  readonly mutations: number;
  /**
   * A phase this one would have triggered and declined to start, because its
   * last measured duration is longer than what is left of the attempt.
   *
   * Only the staleness fix point can set it. That call is a `link_reconcile` in
   * everything but name, so it inherits the rule the phase loop applies to the
   * named one — otherwise closing the fix point's gap would have re-opened
   * exactly the un-clocked overrun the guard exists to end, one call site along.
   */
  readonly refused?: CyclePhase;
}

/**
 * One deterministic phase, by name, under the attempt's clock.
 *
 * The staleness phase re-reconciles when it invalidated something, and that is
 * the one place this switch does more than dispatch. Reconciliation reads the
 * live fact set; staleness *changes* it; and the plan's phase order puts
 * reconciliation first. Rather than reordering the plan's phases, the phase that
 * moved the inputs re-runs the phase that reads them — otherwise an edge whose
 * only support was just retired stands for a whole cycle, which is Gap #18's
 * cancelled meeting still in the briefing.
 *
 * **Every phase takes the budget and returns where it got to.** The budget is
 * consulted inside the phases rather than only between them because two of them
 * — salience and clustering — are the whole of the cycle's wall clock on a large
 * brain, and a check that only fires at a phase boundary would never fire inside
 * the phase that is the reason there is a boundary problem.
 */
export async function runDeterministicPhase(
  sql: SQL,
  phase: CyclePhase,
  options: {
    /** Whose checkpoints this phase reads and writes. See the `staleness` arm. */
    readonly run: CycleRun;
    readonly now: Date;
    readonly cursor: string | null;
    readonly attempt: AttemptBudget;
    /**
     * The keyset batch the walking phases take per read/write pair. Absent
     * leaves each phase at its own tuned constant; see {@link CycleOptions}.
     */
    readonly batch?: number;
    /**
     * What `link_reconcile` cost the last time it finished, when anybody knows.
     *
     * Only the staleness arm reads it, and only to decline the fix point it
     * would otherwise start with whatever happens to be left. Absent means no
     * measurement exists, which is the one case where starting it is the only
     * way to learn anything.
     */
    readonly reconcileCostMs?: number;
  },
): Promise<DeterministicOutcome> {
  const { run, now, cursor, attempt: budget } = options;
  const batched = options.batch === undefined ? {} : { batch: options.batch };

  switch (phase) {
    case 'dedup': {
      const result = await collapseDuplicateFacts(sql, { budget });
      // Every collapse is a fact that leaves the live set for good, so the next
      // attempt's read is strictly smaller. Repetition is not possible here.
      return {
        items: result.collapsed,
        mutations: result.collapsed,
        done: result.done,
        cursor: result.cursor,
      };
    }
    case 'link_reconcile': {
      const result = await reconcileAllEdges(sql, { taxonomyVersion: 1, budget });
      // `kept` is deliberately not counted: an edge the projection re-derives
      // unchanged is the phase agreeing with itself, which every pass does.
      return {
        items: result.added + result.removed,
        mutations: result.added + result.removed,
        done: result.done,
        cursor: result.cursor,
      };
    }
    case 'staleness': {
      const result = await markStaleness(sql, { now, cursor, budget, ...batched });
      // The re-reconcile is skipped when this pass did not finish, because it is
      // a *fix point* over the whole edge set: running it against a fact set the
      // next attempt is still retiring from would remove edges that attempt is
      // about to re-derive, and re-add them, once per attempt.
      // **The debt is banked, not carried in a local.** `factsInvalidated` counts
      // what *this call* retired, and the walk is resumable — so the attempt
      // that supersedes three hundred facts and the attempt that finishes the
      // walk need not be the same process. Withdrawing reconciliation's
      // completion is how the first tells the second, and it is the only form of
      // that message which survives the process that discovered it. Without it,
      // attempt N+1 resumed past those rows, finished with `factsInvalidated`
      // zero, skipped a `link_reconcile` banked complete in attempt N, and left
      // every edge whose only support had been retired standing over a cycle
      // that reported itself complete.
      if (result.factsInvalidated > 0) await reopenPhase(sql, run, 'link_reconcile');

      if (!result.done) {
        return {
          items: result.staled,
          mutations: result.staled,
          done: false,
          cursor: result.cursor,
        };
      }

      // The walk is over, so the fix point is owed exactly when reconciliation
      // is not banked complete against this run. That one question answers both
      // cases — this call retired something, or an earlier attempt did — which
      // is what makes it a fix point rather than a coincidence of scheduling.
      if (await phaseIsComplete(sql, run, 'link_reconcile')) {
        return { items: result.staled, mutations: result.staled, done: true, cursor: null };
      }

      // Same rule as the phase loop's, and it must be: this is reconciliation,
      // and it cannot bank a partial answer here any more than it can there.
      // `remainingMs` rather than the last reading, because the last reading was
      // taken before the staleness walk that just ran — which is precisely the
      // interval a guard on what is *left* must not ignore.
      const owed = options.reconcileCostMs;
      if (owed !== undefined && owed > budget.remainingMs()) {
        return {
          items: result.staled,
          mutations: result.staled,
          done: false,
          cursor: null,
          refused: 'link_reconcile',
        };
      }

      const again = await reconcileAllEdges(sql, { taxonomyVersion: 1, budget });
      if (!again.done) {
        // **A phase is not complete while work it triggered is unfinished.**
        // `reconcileAllEdges` reports a restart when it yields, and dropping
        // that on the floor here banked staleness as *done* over an edge set
        // nothing had reconciled — after which every later attempt skipped the
        // phase and the retired fact's edge stood for the life of the run. The
        // walk itself is over, so there is no position to hand on; the phase
        // says so and restarts, which is cheap because a page already marked
        // stale is not selected again.
        return { items: result.staled, mutations: result.staled, done: false, cursor: null };
      }
      // The debt is discharged where it was recorded. `items` is the fix point's
      // own diff rather than a sum with the pass this re-opened: the earlier
      // count went with the withdrawn row, and inventing a total across two
      // reconciliations of the same edge set would be double-counting an
      // idempotent pass.
      await completePhase(sql, run, 'link_reconcile', {
        items: again.added + again.removed,
        spentMicroUsd: NO_SPEND,
        now,
      });
      // The fix point's own diff counts. An attempt that resumed past every row
      // it had already staled retires nothing and still takes down the edges an
      // earlier attempt's supersessions left unsupported — real work, and the
      // only work that attempt did.
      return {
        items: result.staled,
        mutations: result.staled + again.added + again.removed,
        done: true,
        cursor: null,
      };
    }
    case 'entity_merge': {
      const result = await mergeEntitiesByRule(sql, { budget });
      // A merged loser is tombstoned, so it is gone from the next attempt's read
      // for the same reason a collapsed fact is.
      return {
        items: result.merged,
        mutations: result.merged,
        done: result.done,
        cursor: result.cursor,
      };
    }
    case 'salience': {
      const result = await computeDeterministicSalience(sql, { now, cursor, budget, ...batched });
      // **No mutations, and the zero is the assertion.** Every page is re-scored
      // on every pass on purpose — the recency term decays with wall clock — so
      // `scored` counts work that will be done again and is worth nothing as
      // evidence of progress. The cursor is where this phase's progress lives.
      return { items: result.scored, mutations: 0, done: result.done, cursor: result.cursor };
    }
    case 'cluster': {
      const result = await clusterByEmbedding(sql, { runId: null, cursor, budget, ...batched });
      // Zero for the same reason as salience: a fresh start rebuilds membership
      // from the current corpus, so a cluster count is a restatement rather than
      // an advance. Its progress is the cursor over the seed walk.
      return { items: result.clusters, mutations: 0, done: result.done, cursor: result.cursor };
    }
    default:
      throw new Error(`invariant: '${phase}' is not a deterministic phase`);
  }
}

// ---------------------------------------------------------------------------
// The job handler.
// ---------------------------------------------------------------------------

/**
 * What a worker needs to run somebody else's cycle.
 *
 * Resolving a tenant's connection string is U6's dispatch seam and R11's secret
 * boundary, not this module's, so it arrives as a port. `close` is on the type
 * because a worker that opened a connection per job and never closed one would
 * exhaust the per-tenant LRU KTD2 is built around.
 */
export interface TenantWorld {
  readonly sql: SQL;
  readonly gateway: ModelGateway;
  readonly tier: ConsolidationTier;
  readonly capMicroUsd: number | null;
  /** U21's payload reader, scoped to this tenant by whoever opened the world. */
  readonly payloads?: StoredPayloadReader;
  close(): Promise<void>;
}

export interface ConsolidatePorts {
  open(tenantId: string): Promise<TenantWorld>;
  /** Receives every finished cycle, for the fleet's own logging. */
  readonly onCycle?: (tenantId: string, result: CycleResult) => void;
}

/**
 * How much of an attempt's ceiling is reserved for stopping.
 *
 * A cycle handed exactly `attemptDeadlineAt - now` would start its last unit of
 * work just inside the ceiling and be reaped while writing its own run record —
 * which is the failure this whole seam exists to end, arriving one statement
 * later and looking identical from the outside. A minute covers the closing
 * writes (the checkpoint, the run record, the tenant settlement) with room for a
 * database that is having a bad afternoon, against a ceiling of fifteen.
 */
export const ATTEMPT_CLOSING_MARGIN_MS = 60_000;

/**
 * What is left of this attempt's wall-clock ceiling, minus the closing margin.
 *
 * Read off the **lease**, not off `DEFAULT_MAX_ATTEMPT_MS`. The constant says how
 * long an attempt may run; the lease says when *this* attempt must be over, and
 * they differ by however long the job waited between claim and here. A cycle
 * that trusted the constant would believe it had fifteen minutes at minute nine.
 *
 * `null` when the lease carries no usable deadline — unbudgeted, which is the
 * behaviour every caller had before this existed, so a lease shape this code
 * does not recognise degrades to the old cycle rather than to a zero budget that
 * stops before the first phase.
 */
function attemptBudgetMsFor(context: JobContext): number | null {
  const deadline = context.lease.attemptDeadlineAt;
  if (!(deadline instanceof Date) || Number.isNaN(deadline.getTime())) return null;
  return Math.max(0, deadline.getTime() - context.now.getTime() - ATTEMPT_CLOSING_MARGIN_MS);
}

/**
 * The `consolidate` job, as U10's runner expects it.
 *
 * The lease's trigger is carried onto the run record rather than re-derived:
 * KTD11 has three triggers and the scheduler is the only thing that knows which
 * one fired, so inferring it here would be inventing the answer to the one
 * question a capacity model asks of these rows.
 *
 * **It returns a continuation rather than finishing, when there is more to do.**
 * A whole-brain cycle that does not fit one attempt is a long job, not a broken
 * one, and the two used to be the same event: the attempt was reaped, an attempt
 * was charged, and five of those dead-lettered the lane — after which nothing,
 * not the cadence and not a redeploy, would poll that tenant again until an
 * operator cleared it. The cycle now stops itself, banks a position, and says
 * so; the runner completes the job normally and settles the tenant as due again
 * immediately rather than at the next 24-hour ceiling. Each continuation is a
 * **fresh job with a fresh attempt ladder**, which is what makes a brain that
 * needs ten attempts survivable under a policy that allows five.
 *
 * **`advanced` gates it.** A cycle that ran out of time having banked nothing
 * would ask to be re-run forever at whatever rate the scheduler ticks, so it
 * settles normally instead and waits for the ceiling — slow, and finite.
 */
export function createConsolidateHandler(ports: ConsolidatePorts): JobHandler {
  return async (context: JobContext): Promise<HandlerOutcome | undefined> => {
    const world = await ports.open(context.lease.tenantId);
    try {
      const result = await runConsolidationCycle(
        {
          sql: world.sql,
          gateway: world.gateway,
          tenantId: context.lease.tenantId,
          caller: fleetIdentity(context.lease.tenantId),
          ...(world.payloads === undefined ? {} : { payloads: world.payloads }),
        },
        {
          trigger: jobTriggerOf(context),
          tier: world.tier,
          capMicroUsd: world.capMicroUsd,
          now: context.now,
          budgetMs: attemptBudgetMsFor(context),
          signal: context.signal,
        },
      );
      ports.onCycle?.(context.lease.tenantId, result);
      return result.moreToDo && result.advanced ? { continuation: true } : undefined;
    } finally {
      await world.close();
    }
  };
}

/**
 * The trigger the scheduler recorded, read off the lease.
 *
 * `JobLease` does not carry it, so this reads the only thing it does carry that
 * distinguishes the arms — and says so, rather than defaulting silently. A wrong
 * trigger on a run record is a capacity model reading debounced cycles as ceiling
 * ones.
 */
function jobTriggerOf(context: JobContext): JobTrigger {
  return context.lease.debtObserved > 0 ? 'debt_debounce' : 'time_ceiling';
}
