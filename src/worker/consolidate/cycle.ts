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
 * **Only model phases are skipped by a checkpoint**, and that asymmetry is
 * deliberate. The checkpoint exists so a killed cycle "never re-pays model
 * calls" — its subject is money. The deterministic phases cost nothing and their
 * inputs move between cycles, so skipping them would mean a tenant sitting at a
 * zero cap silently stops deduplicating anything, which is the free tier failing
 * quietly at exactly the thing it was promised.
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
import type { JobContext, JobHandler } from '../runner.ts';
import type { JobTrigger } from '../jobs.ts';
import {
  bankEstimate,
  completePhase,
  finishRun,
  openRun,
  recordProgress,
  type ConsolidationTier,
  type StopReason,
} from './checkpoint.ts';
import {
  clusterByEmbedding,
  collapseDuplicateFacts,
  computeDeterministicSalience,
  markStaleness,
  mergeEntitiesByRule,
  reconcileAllEdges,
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

  const clock = options.clock ?? Date.now;
  const startedAt = clock();
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
  let stop: StopReason = 'complete';

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

    // Only model phases are checkpoint-skippable. See the header.
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
      const items = await runDeterministicPhase(deps.sql, phase, options.now);
      await completePhase(deps.sql, run, phase, { items, spentMicroUsd: NO_SPEND, now: options.now });
      phases.push({
        phase,
        tier: 'deterministic',
        ran: true,
        skipped: null,
        items,
        spentMicroUsd: NO_SPEND,
        stopped: null,
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
      ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    });

    spent += outcome.spentMicroUsd;
    modelCalls += outcome.modelCalls;

    if (outcome.stopped === null) {
      await completePhase(deps.sql, run, phase, {
        items: outcome.items,
        spentMicroUsd: outcome.spentMicroUsd,
        now: options.now,
      });
    } else {
      stop = outcome.stopped === 'budget_exhausted' ? 'budget_exhausted' : 'phase_failed';
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
  const wallClockMs = Math.max(0, clock() - startedAt);
  const ran = phases.filter((phase) => phase.ran).length;

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
    phases,
    wallClockMs,
    spentMicroUsd: spent,
    modelCalls,
    estimate: priced,
  };
}

/**
 * One deterministic phase, by name.
 *
 * The staleness phase re-reconciles when it invalidated something, and that is
 * the one place this switch does more than dispatch. Reconciliation reads the
 * live fact set; staleness *changes* it; and the plan's phase order puts
 * reconciliation first. Rather than reordering the plan's phases, the phase that
 * moved the inputs re-runs the phase that reads them — otherwise an edge whose
 * only support was just retired stands for a whole cycle, which is Gap #18's
 * cancelled meeting still in the briefing.
 */
async function runDeterministicPhase(sql: SQL, phase: CyclePhase, now: Date): Promise<number> {
  switch (phase) {
    case 'dedup':
      return (await collapseDuplicateFacts(sql)).collapsed;
    case 'link_reconcile': {
      const result = await reconcileAllEdges(sql, { taxonomyVersion: 1 });
      return result.added + result.removed;
    }
    case 'staleness': {
      const result = await markStaleness(sql, { now });
      if (result.factsInvalidated > 0) await reconcileAllEdges(sql, { taxonomyVersion: 1 });
      return result.staled;
    }
    case 'entity_merge':
      return (await mergeEntitiesByRule(sql)).merged;
    case 'salience':
      return (await computeDeterministicSalience(sql, { now })).scored;
    case 'cluster':
      return (await clusterByEmbedding(sql, { runId: null })).clusters;
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
  close(): Promise<void>;
}

export interface ConsolidatePorts {
  open(tenantId: string): Promise<TenantWorld>;
  /** Receives every finished cycle, for the fleet's own logging. */
  readonly onCycle?: (tenantId: string, result: CycleResult) => void;
}

/**
 * The `consolidate` job, as U10's runner expects it.
 *
 * The lease's trigger is carried onto the run record rather than re-derived:
 * KTD11 has three triggers and the scheduler is the only thing that knows which
 * one fired, so inferring it here would be inventing the answer to the one
 * question a capacity model asks of these rows.
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
        },
        {
          trigger: jobTriggerOf(context),
          tier: world.tier,
          capMicroUsd: world.capMicroUsd,
          now: context.now,
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
