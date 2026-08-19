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
import {
  bankEstimate,
  bankPhaseProgress,
  completePhase,
  finishRun,
  openRun,
  recordProgress,
  type ConsolidationTier,
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
   * There is work left and running the same cycle again would do it. True only
   * for the clock stops — a cap that fired or a provider that was down are also
   * unfinished, and both want to wait rather than to be retried at once.
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
  });
  const run = opened.run;

  let budgets: Readonly<Record<ModelPhase, Budget>> = budgetsFor(estimate, { capMicroUsd: NO_SPEND });
  let priced = estimate;

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
  const continuingOnTheClock =
    opened.previousStop === 'out_of_time' || opened.previousStop === 'cancelled';
  const bankedFor = (phase: CyclePhase): PhaseCheckpoint | undefined => {
    const banked = opened.banked.get(phase);
    if (banked === undefined) return undefined;
    if (isModelPhase(phase)) return banked;
    return continuingOnTheClock ? banked : undefined;
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
      const outcome = await runDeterministicPhase(deps.sql, phase, {
        now: options.now,
        cursor: banked?.cursor ?? null,
        attempt,
      });
      // Items are banked **cumulatively over the run** and reported per attempt.
      // A phase resumed three times has done the sum of what its three attempts
      // did, and a checkpoint that recorded only the last one would describe a
      // brain nobody consolidated.
      const total = (banked?.items ?? 0) + outcome.items;

      if (outcome.done) {
        await completePhase(deps.sql, run, phase, {
          items: total,
          spentMicroUsd: NO_SPEND,
          now: options.now,
        });
        advanced = true;
      } else if (outcome.cursor !== null) {
        await bankPhaseProgress(deps.sql, run, phase, {
          items: total,
          cursor: outcome.cursor,
          now: options.now,
        });
        if (outcome.cursor !== (banked?.cursor ?? null)) advanced = true;
        stop = attempt.stop() ?? 'out_of_time';
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
        stopped: outcome.done ? null : (stop as string),
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
  const ran = phases.filter((phase) => phase.ran).length;
  const moreToDo = stopReason === 'out_of_time' || stopReason === 'cancelled';

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
async function runDeterministicPhase(
  sql: SQL,
  phase: CyclePhase,
  options: {
    readonly now: Date;
    readonly cursor: string | null;
    readonly attempt: AttemptBudget;
  },
): Promise<{ readonly items: number } & PhaseProgress> {
  const { now, cursor, attempt: budget } = options;

  switch (phase) {
    case 'dedup': {
      const result = await collapseDuplicateFacts(sql, { budget });
      return { items: result.collapsed, done: result.done, cursor: result.cursor };
    }
    case 'link_reconcile': {
      const result = await reconcileAllEdges(sql, { taxonomyVersion: 1, budget });
      return { items: result.added + result.removed, done: result.done, cursor: result.cursor };
    }
    case 'staleness': {
      const result = await markStaleness(sql, { now, cursor, budget });
      // The re-reconcile is skipped when this pass did not finish, because it is
      // a *fix point* over the whole edge set: running it against a fact set the
      // next attempt is still retiring from would remove edges that attempt is
      // about to re-derive, and re-add them, once per attempt.
      if (result.done && result.factsInvalidated > 0) {
        await reconcileAllEdges(sql, { taxonomyVersion: 1, budget });
      }
      return { items: result.staled, done: result.done, cursor: result.cursor };
    }
    case 'entity_merge': {
      const result = await mergeEntitiesByRule(sql, { budget });
      return { items: result.merged, done: result.done, cursor: result.cursor };
    }
    case 'salience': {
      const result = await computeDeterministicSalience(sql, { now, cursor, budget });
      return { items: result.scored, done: result.done, cursor: result.cursor };
    }
    case 'cluster': {
      const result = await clusterByEmbedding(sql, { runId: null, cursor, budget });
      return { items: result.clusters, done: result.done, cursor: result.cursor };
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
