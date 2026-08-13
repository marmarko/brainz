/**
 * Stages 12 and 13 as **one decision**, because they are not two.
 *
 * **The coupling this module exists to make un-loseable.** Autocut reads
 * `ScoredCandidate.rerankScore` and nothing else — that is the audit's finding
 * and `autocut.ts`'s refusal. So the two stages are not independently
 * configurable, however much the config surface suggests they are: turn rerank
 * off and result-sizing goes with it, silently, with longer lists and no error
 * anywhere.
 *
 * That matters at U12 specifically. KTD4 puts rerank on the request path as a
 * **second** synchronous external call, alongside the query embedding, on a path
 * that promises a warm p99 under 100ms. The obvious lever when that budget
 * misses is the flag. KTD4 names a different one: **the candidate count**. So
 * {@link reduceForLatency} shrinks the pool and refuses to reach the stage —
 * when it has nothing left to give it reports `at_floor` rather than quietly
 * doing the thing that costs the product a stage.
 *
 * **Three states, not two.** A caller that never wired stage 12 (the eval
 * baselines, a unit test of stage 8) is not the same as one that switched it
 * off, and neither is the same as a provider that refused mid-request. Each
 * carries its own reason so a read that came back un-reranked can say which.
 */

import type { RerankOptions } from './rerank.ts';
import { RERANK_DEFAULT_ENABLED } from './rerank.ts';

/**
 * Stated as a value so a future operator meets it in code review rather than in
 * a dashboard three weeks after the lists got longer.
 */
export const AUTOCUT_REQUIRES_RERANK = true;

/** What goes with rerank when rerank goes. */
export function disablingRerankAlsoDisables(): readonly string[] {
  return ['autocut'];
}

/**
 * KTD4's dial, named. The escape hatch for a missed latency budget is this
 * number and not {@link RERANK_DEFAULT_ENABLED}.
 */
export const LATENCY_DIAL = 'candidate_count';

/**
 * How many candidates the cross-encoder scores. KTD4's envelope is quoted
 * against 100 × ~400 tokens; the cost receipt is computed from this constant and
 * the canonical pricing table rather than from a number typed twice.
 */
export const RERANK_CANDIDATES_DEFAULT = 100;

/**
 * The smallest pool worth a cross-encoder round trip.
 *
 * Below this the stage is paying a network hop to reorder a list the earlier
 * stages already ordered, and autocut has too few points to find a cliff in. It
 * is a floor rather than a path to zero on purpose: zero candidates is rerank
 * off by another name, which is the move this module exists to refuse.
 */
export const RERANK_CANDIDATES_FLOOR = 20;

/** How much of the pool one turn of the dial gives back. */
const REDUCTION_FACTOR = 2;

export type RerankStageReason =
  /** The caller did not participate in stage 12 at all. */
  | 'stage_not_wired'
  /** Configuration says off. Autocut is off with it — see the header. */
  | 'disabled'
  /** Configuration says on and nothing can score: a provider refused, or nobody wired a scorer. */
  | 'unavailable'
  | 'enabled';

export interface RerankStagePlan {
  readonly rerank: boolean;
  /**
   * Always equal to {@link rerank}. Carried rather than derived at each call
   * site so that "autocut is on" is never a second opinion about the same fact.
   */
  readonly autocut: boolean;
  readonly candidates: number;
  readonly reason: RerankStageReason;
}

function planOf(reason: RerankStageReason, candidates: number): RerankStagePlan {
  const on = reason === 'enabled';
  // The coupling, in one expression, in one place: autocut is not a second
  // opinion about whether rerank ran, it is the same boolean.
  return { rerank: on, autocut: on, candidates, reason };
}

function candidatesOf(options: RerankOptions | undefined): number {
  const requested = options?.candidates;
  if (requested === undefined || !Number.isFinite(requested)) return RERANK_CANDIDATES_DEFAULT;
  return Math.max(RERANK_CANDIDATES_FLOOR, Math.trunc(requested));
}

/**
 * Resolve what stages 12 and 13 do for this call.
 *
 * `undefined` is *not* "off by default": a caller that passed no rerank options
 * never wired the stage, and treating that as a configured `enabled` would make
 * every composition that predates U12 throw for want of a scorer. A caller that
 * supplies a scorer and no opinion gets {@link RERANK_DEFAULT_ENABLED}, which is
 * the flag U12 flipped — set it back to false and both the request path and the
 * eval leg stop reranking, which is what pins the flip as a real one.
 */
export function resolveRerankStage(options?: RerankOptions): RerankStagePlan {
  const candidates = candidatesOf(options);
  if (options === undefined) return planOf('stage_not_wired', candidates);

  const enabled = options.enabled ?? RERANK_DEFAULT_ENABLED;
  if (!enabled) return planOf('disabled', candidates);
  if (options.score === undefined) return planOf('unavailable', candidates);
  return planOf('enabled', candidates);
}

export interface LatencyReduction {
  readonly plan: RerankStagePlan;
  readonly change: 'candidates_reduced' | 'at_floor';
}

/**
 * Turn the dial once.
 *
 * Never returns a plan with `rerank: false`. If the budget still misses at the
 * floor, the answer is a faster reranker or a self-hosted one (KTD4 keeps the
 * self-hosted cross-encoder as the *latency* contingency), not a stage removed
 * from the product.
 */
export function reduceForLatency(plan: RerankStagePlan): LatencyReduction {
  const next = Math.max(RERANK_CANDIDATES_FLOOR, Math.floor(plan.candidates / REDUCTION_FACTOR));
  if (next >= plan.candidates) return { plan: { ...plan, candidates: RERANK_CANDIDATES_FLOOR }, change: 'at_floor' };
  return { plan: { ...plan, candidates: next }, change: 'candidates_reduced' };
}
