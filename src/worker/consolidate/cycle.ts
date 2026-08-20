/**
 * The cycle: estimate, then cheap, then expensive, checkpointing as it goes.
 *
 * **Where it stops is the interesting part.** Six exits, and they are not
 * interchangeable — an operator reading a run record has to be able to tell them
 * apart — but **every one of them closes the run**, and that uniformity is not
 * tidiness. It is the fix for the incident this file's shape is owed to:
 *
 *   `complete`          — everything ran. `dreamt: true`.
 *   `free_tier`         — R8's line. The deterministic phases ran and no model
 *                         was called.
 *   `budget_exhausted`  — the cap fired. U11's "consolidated but not dreamt".
 *   `phase_failed`      — a provider was unavailable, or answered with something
 *                         this code cannot read. A different name from the cap
 *                         because "we ran out of money" and "the provider was
 *                         down" want different responses.
 *   `out_of_time`       — the attempt's wall clock ran out with work left. The
 *                         job completes normally rather than being reaped, which
 *                         is the whole of what this reason buys.
 *   `cancelled`         — the lease was lost or the worker is shutting down.
 *                         Named apart from the clock because "we were
 *                         interrupted" and "this brain is long" want different
 *                         responses from whoever reads the run record.
 *
 * **Three of those used to leave the run open, and that is what froze a brain.**
 * The cap, the failed phase and the clock each left `finished_at` null so the
 * next cycle would resume into the same run and skip the model phases already
 * paid for. Then one page out of 5,608 drew a provider 500. The synopsis phase
 * stopped on it — correctly; a 500 is systemic and every other page would meet
 * it identically — the cycle stopped, the run stayed open, and `extract`'s
 * checkpoint stood in front of every later cycle. Every later cycle stopped the
 * same way, so the run never closed: 167 facts, flat for hours, with `extract`
 * called once in the whole of it.
 *
 * A cycle that reaches the bottom of this function has finished what was in
 * flight and can name what stopped it. Its pass is over, so it closes. The only
 * run left open is one whose cycle never got here at all — a process that died
 * mid-statement — and that absence, not a decision, is what `openRun` resumes
 * into, once.
 *
 * **What closing costs is nothing, and rung 22 is why.** Closing was tried
 * before that rung and reverted: with no record of doneness on the four phases
 * whose selectors took the top N by salience or by id, closure re-paid `extract`
 * every cycle and left `enrich`, `synopsis`, `contradiction` and
 * `salience_refine` unreached — out_of_time five cycles running, zero summaries,
 * measured. Every model phase now re-selects only work nobody has done:
 * `transcribe` and `synopsis` from the content, the other four from a
 * consideration stamp on the row they consume. See `consideration.ts`.
 *
 * **Three of those exits name the phase they happened in, on the row.**
 * `phase_failed`, `budget_exhausted` and `out_of_time` are all things a
 * particular phase reported, and until rung 20 the run record kept only the
 * aggregate word. A brain sat at `phase_failed` with a flat fact count for hours
 * while the phase and its code existed in `PhaseRecord[]` — in this process's
 * memory and on one line of a container's stdout that nothing outside the
 * container can read. `stoppedPhase` is the half of that picture that survives:
 * one member of `CYCLE_PHASES`, one member of `PHASE_STOPS`, no sentence. The
 * other three exits name nothing, because nothing a phase did caused them.
 *
 * **A checkpoint's subject is money, so only model phases are skipped by one.**
 * That asymmetry is KTD11's "never re-pays model calls" read literally, and it
 * is the one this file had before a wall-clock incident and has again. The
 * deterministic prefix re-runs from the top on every attempt.
 *
 * That was once unaffordable and is not any more, and the difference is measured
 * rather than assumed: salience issued `1 + 2N` sequential statements (11,217 on
 * a 5,608-page brain, fifteen minutes on its own at 36ms) and now reads and
 * writes in batches; clustering paid a whole transaction per seed. Those two
 * were 28,799 of the pass's 30,850 round trips. With them batched the whole free
 * tier is seconds, so redoing it is cheaper than the machinery that would avoid
 * redoing it — and that machinery, three versions of it, kept a state a run
 * could enter and not leave. See the note on `done: false` in the phase loop.
 *
 * **The stop is clean whether or not anything resumes from it.** A cycle that
 * decides to stop between two units of work finishes what is in flight, writes
 * its own run record, and names the reason. A cycle that is reaped by the lease
 * ceiling does none of that and charges an attempt for the privilege — five of
 * which dead-lettered a lane. That difference is worth the budget on its own.
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
import type { JobContext, JobHandler } from '../runner.ts';
import type { JobTrigger } from '../jobs.ts';
import {
  bankEstimate,
  completePhase,
  finishRun,
  openRun,
  type ConsolidationTier,
  type StopReason,
} from './checkpoint.ts';
import {
  considerationVersions,
  type ConsiderationVersions,
} from './consideration.ts';
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
  isModelPhase,
  type CyclePhase,
  type ModelPhase,
  type PhaseAttribution,
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
  /**
   * Consideration versions to run the four durable-marker phases at.
   *
   * Absent means the shipped numbers in `consideration.ts`, which is what every
   * production caller wants. A higher number offers the corpus to that phase
   * again — the seam exists so that expressing a bump is an argument rather than
   * a mutated module constant.
   */
  readonly consideration?: Partial<ConsiderationVersions>;
  /** Injected so a test can assert on a duration without sleeping. */
  readonly clock?: () => number;
  /**
   * The keyset batch the walking deterministic phases take per read/write pair.
   *
   * Absent leaves every phase at its own tuned constant, which is what the fleet
   * wants: those numbers were measured against a real brain, and a cycle that
   * second-guessed them would be a second tuning nobody took. It is expressible
   * because the behaviour that matters here — a phase noticing the clock
   * *between* batches and stopping cleanly — is only reachable over more rows
   * than one batch, and a suite that had to seed five hundred pages to reach it
   * is a suite that stops being run.
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
  /** Why the phase did not run, for a phase that did not. */
  readonly skipped: 'checkpointed' | 'free_tier' | 'not_reached' | null;
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
   * There is work left and running the same cycle again would do it.
   *
   * True for the two clock stops. It is a **report**, not a request: nothing
   * re-enqueues on it, and the tenant waits for its next scheduled cycle like
   * any other. It is on the record — and in the fleet's cycle log — because
   * "this brain did not finish in one attempt" is the fact an operator needs to
   * see repeating, and a cap that fired or a provider that was down are
   * unfinished for reasons that read differently.
   */
  readonly moreToDo: boolean;
  /**
   * Which phase stopped this cycle and with what code, or `null`.
   *
   * The one field of `phases` that survives the process. `PhaseRecord[]` is the
   * full picture and it only ever existed in memory and on a container's
   * stdout — which is why a brain stuck at `stop_reason: 'phase_failed'` could
   * be observed for hours without anybody being able to say which phase. This
   * pair goes on the run record.
   *
   * `null` when no phase is answerable: the clock read *between* two phases, a
   * lost lease, or a cycle that finished.
   */
  readonly stoppedPhase: PhaseAttribution | null;
  readonly phases: readonly PhaseRecord[];
  readonly wallClockMs: number;
  readonly spentMicroUsd: number;
  readonly modelCalls: number;
  /**
   * Items this cycle passed over, across every per-item phase.
   *
   * **A cycle that could not read something says so, because nothing else
   * will.** A per-item failure no longer stops its phase — that link is what
   * froze a brain at 167 facts — so it no longer reaches `stopReason` or
   * `stoppedPhase` either, and a cycle that summarised nothing because every
   * candidate was unreadable would otherwise read on the run record exactly like
   * a brain with nothing left to do. This number is the difference between those
   * two, and it is why completing through a failure is not the same as
   * swallowing one.
   *
   * A count rather than a list, and it is the coarse half of the picture on
   * purpose: `page.consolidation_refusals` says WHICH pages and for how long,
   * and this says how many, in the line an operator is already watching. Small
   * and steady is a few unreadable documents, which now cost one model call each
   * per cycle forever and nothing else. Equal to a phase's whole candidate set,
   * cycle after cycle, is a broken prompt or a seat whose output ceiling is too
   * tight — and that is a change to make, not a page to blame.
   */
  readonly skippedItems: number;
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
  // Resolved once, and handed to both the estimate and the phases. Two
  // resolutions would be two answers to "which version is this cycle running
  // at", and the phase whose cap was priced against the other one is the phase
  // that stops for no reason anybody could reconstruct.
  const consideration = considerationVersions(options.consideration);

  // Estimate before running, and bank it before the first phase: a number
  // computed and then discarded is a calculation nobody can audit against a bill.
  const workload = await measureWorkload(deps.sql, { batch: limit, consideration });
  const estimate = estimateCycle({ profile, workload });

  const opened = await openRun(deps.sql, {
    trigger: options.trigger,
    tier: options.tier,
    now: options.now,
    estimateMicroUsd: options.tier === 'free' ? 0 : estimate.totalMicroUsd,
  });
  const run = opened.run;

  let budgets: Readonly<Record<ModelPhase, Budget>> = budgetsFor(estimate, { capMicroUsd: NO_SPEND });
  let priced = estimate;

  const phases: PhaseRecord[] = [];
  let spent = opened.spentMicroUsd;
  let modelCalls = 0;
  let skippedItems = 0;
  let refined = false;
  let stop: StopReason = 'complete';
  /**
   * The phase the stop is attributable to, set at the same moment `stop` is.
   *
   * Kept beside `stop` rather than derived afterwards from `phases`, because the
   * two disagree in the case that matters: a `cancelled` cycle has a phase that
   * reported `out_of_time` and nothing to attribute — the lease went, not the
   * phase — and a scan of the records after the loop would happily name it.
   */
  let stoppedPhase: PhaseAttribution | null = null;

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
    // reap: whatever is in flight finishes, the phases that completed stay
    // banked, and the run record carries a name an operator can act on.
    const halted = attempt.stop();
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
          workload: await measureWorkload(deps.sql, { batch: limit, consideration }),
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

    // **Only a model phase is skipped by a checkpoint**, because only a model
    // phase's cost is an invoice somebody would pay twice. See the header.
    if (isModelPhase(phase) && opened.done.has(phase)) {
      phases.push({
        phase,
        tier: 'model',
        ran: false,
        skipped: 'checkpointed',
        items: 0,
        spentMicroUsd: NO_SPEND,
        stopped: null,
      });
      continue;
    }

    if (!isModelPhase(phase)) {
      const outcome = await runDeterministicPhase(deps.sql, phase, {
        now: options.now,
        attempt,
        ...(options.batch === undefined ? {} : { batch: options.batch }),
      });

      if (outcome.done) {
        await completePhase(deps.sql, run, phase, {
          items: outcome.items,
          spentMicroUsd: NO_SPEND,
          now: options.now,
        });
      } else {
        // **The phase stopped part-way, and the next attempt will start it
        // again from the top. That is the design, and it is affordable.**
        //
        // Nothing is banked, because there is nothing a deterministic phase
        // could bank that is worth what banking it costs. The version of this
        // file that did bank positions was written against a fifteen-minute
        // wall that no longer exists: on a 5,608-page brain the free tier was
        // 30,850 round trips, of which salience's `1 + 2N` sequential
        // statements and clustering's transaction-per-seed were 28,799. Batched,
        // the other four phases together measure under 400ms at that size and
        // the two walks are a low multiple of that. Redoing seconds of free work
        // is cheaper than a resume protocol — and every version of that protocol
        // shipped with a state a run could enter and not leave, which is the
        // same class of defect as the dead lane it existed to prevent.
        //
        // If this stops being true — if a fleet starts seeing `out_of_time`
        // repeatedly on the same tenant — the answer is another round trip
        // removed from a phase, not a checkpoint added to this loop.
        stop = attempt.stop() ?? 'out_of_time';
        // Attributed only for the clock. A `cancelled` run lost its lease, which
        // is something that happened *to* the cycle: naming the phase that
        // happened to be in flight would point an operator at whichever phase is
        // slowest rather than at the deploy or the steal that took the lease.
        if (stop === 'out_of_time') stoppedPhase = { phase, code: 'out_of_time' };
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
      consideration,
      ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
      ...(deps.payloads === undefined ? {} : { payloads: deps.payloads }),
    });

    spent += outcome.spentMicroUsd;
    modelCalls += outcome.modelCalls;
    skippedItems += outcome.skippedItems;

    if (outcome.stopped === null) {
      await completePhase(deps.sql, run, phase, {
        items: outcome.items,
        spentMicroUsd: outcome.spentMicroUsd,
        now: options.now,
      });
    } else if (outcome.stopped === 'out_of_time') {
      // A model phase that ran out of the clock banks nothing — a partial
      // checkpoint row for a model phase would make the *previous* fleet
      // version, which reads every row as a completion, skip the phase outright
      // mid-deploy. Its progress is durable in the content instead: the synopsis
      // phase no longer re-selects a page it has already summarised, so the next
      // attempt starts where this one stopped without a row to say so.
      stop = attempt.stop() ?? 'out_of_time';
      if (stop === 'out_of_time') stoppedPhase = { phase, code: 'out_of_time' };
    } else {
      stop = outcome.stopped === 'budget_exhausted' ? 'budget_exhausted' : 'phase_failed';
      // **The line the whole rung is for.** `phase_failed` covers three codes
      // that want three different responses — a provider that went away, a
      // provider that answered with something this code cannot read, and a
      // stored payload that was not there — and until this was written down they
      // were one word on the run record.
      stoppedPhase = { phase, code: outcome.stopped };
    }

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
  const ran = phases.filter((phase) => phase.ran).length;
  const moreToDo = stopReason === 'out_of_time' || stopReason === 'cancelled';

  const record = {
    dreamt,
    stopReason,
    spentMicroUsd: spent,
    modelCalls,
    phasesRun: ran,
    wallClockMs,
    stoppedPhase,
    now: options.now,
  };

  // **One exit, for every reason.** A cycle that got here has finished what was
  // in flight, knows what stopped it and can say so — its pass is over, so its
  // run closes and its checkpoints go with it.
  //
  // Three of the six reasons used to leave the run open instead, and that is the
  // mechanism the whole incident is about: a run left open is adopted by the
  // next cycle, and a model phase holding a checkpoint against an adopted run is
  // skipped. One page drawing a provider 500 therefore stopped extraction for
  // 5,608 others, on every cycle, forever. The resume signal is now an absence
  // rather than a decision — a cycle killed with the process leaves `finished_at`
  // null because nothing ran to set it — and that is the only state `openRun`
  // adopts, at most once. See the note there.
  //
  // This line is free only because every model phase can now say what it has
  // already done. It was written once without that and reverted, and the note in
  // the header records what it cost.
  await finishRun(deps.sql, run, record);

  return {
    runId: run.runId,
    resumed: opened.resumed,
    dreamt,
    stopReason,
    moreToDo,
    stoppedPhase,
    phases,
    wallClockMs,
    spentMicroUsd: spent,
    modelCalls,
    skippedItems,
    estimate: priced,
  };
}

/**
 * What one deterministic phase did.
 *
 * `items` is what the phase looked at, and it is what an operator reads. `done`
 * is the only thing the loop decides on: a phase that finished is banked, and a
 * phase that stopped on the clock stops the cycle with it.
 */
export interface DeterministicOutcome extends PhaseProgress {
  readonly items: number;
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
 * **Every phase takes the budget and says whether it finished.** The budget is
 * consulted inside the phases rather than only between them because two of them
 * — salience and clustering — are the whole of the cycle's wall clock on a large
 * brain, and a check that only fires at a phase boundary would never fire inside
 * the phase that is the reason there is a boundary problem.
 */
export async function runDeterministicPhase(
  sql: SQL,
  phase: CyclePhase,
  options: {
    readonly now: Date;
    readonly attempt: AttemptBudget;
    /**
     * The keyset batch the walking phases take per read/write pair. Absent
     * leaves each phase at its own tuned constant; see {@link CycleOptions}.
     */
    readonly batch?: number;
  },
): Promise<DeterministicOutcome> {
  const { now, attempt: budget } = options;
  const batched = options.batch === undefined ? {} : { batch: options.batch };

  switch (phase) {
    case 'dedup': {
      const result = await collapseDuplicateFacts(sql, { budget });
      return { items: result.collapsed, done: result.done };
    }
    case 'link_reconcile': {
      const result = await reconcileAllEdges(sql, { taxonomyVersion: 1, budget });
      // `kept` is deliberately not counted: an edge the projection re-derives
      // unchanged is the phase agreeing with itself, which every pass does.
      return { items: result.added + result.removed, done: result.done };
    }
    case 'staleness': {
      const result = await markStaleness(sql, { now, budget, ...batched });
      // The re-reconcile is skipped when this pass did not finish, because it is
      // a *fix point* over the whole edge set: running it against a fact set a
      // later pass is still retiring from would remove edges that pass is about
      // to re-derive, and re-add them.
      if (!result.done || result.factsInvalidated === 0) {
        return { items: result.staled, done: result.done };
      }

      // **The debt is discharged in the call that incurred it**, which is the
      // only place it can be now that a deterministic phase does not carry state
      // across attempts. Both halves — the walk and the fix point — belong to
      // one `staleness`, so either both happen or the phase says it did not
      // finish.
      const again = await reconcileAllEdges(sql, { taxonomyVersion: 1, budget });
      if (!again.done) {
        // **A phase is not complete while work it triggered is unfinished.**
        // `reconcileAllEdges` yields only to a lost lease, so this is the
        // cancelled path and the cycle is stopping anyway — but the phase still
        // reports honestly rather than banking a completion over an edge set
        // nothing reconciled. Restarting is cheap: a page already marked stale
        // is not selected again.
        return { items: result.staled, done: false };
      }
      return { items: result.staled, done: true };
    }
    case 'entity_merge': {
      const result = await mergeEntitiesByRule(sql, { budget });
      return { items: result.merged, done: result.done };
    }
    case 'salience': {
      const result = await computeDeterministicSalience(sql, { now, budget, ...batched });
      return { items: result.scored, done: result.done };
    }
    case 'cluster': {
      const result = await clusterByEmbedding(sql, { runId: null, budget, ...batched });
      return { items: result.clusters, done: result.done };
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
 * **A cycle that ran out of time completes the job.** It does not ask to be
 * re-run, and the difference between that and being reaped is the whole point:
 * an attempt that returns settles the tenant, writes its run record and leaves
 * the lane healthy, where a reaped one charges an attempt against a ladder that
 * dead-lettered a lane after five. The tenant then waits for its next scheduled
 * cycle like any other, and that cycle is a new pass: nothing is held open for
 * it, and no phase re-pays for work this one finished, because every phase now
 * selects only rows nobody has considered.
 *
 * There was briefly a re-enqueue here — a successful attempt asking the fleet to
 * run it again at once. It is gone with the machinery that made it necessary:
 * the deterministic prefix now fits an attempt with room to spare, so "this
 * brain needs ten attempts back to back" is not a state the fleet is expected to
 * be in, and a handler that can ask for itself is a loop somebody has to bound.
 */
export function createConsolidateHandler(ports: ConsolidatePorts): JobHandler {
  return async (context: JobContext): Promise<void> => {
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
