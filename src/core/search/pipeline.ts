/**
 * The composed retrieval stack: the ordered stages, in order, and the one
 * function that runs them.
 *
 * **The split this file exists to hold.** {@link composeRanking} is
 * *synchronous* and pure. It takes what the arms returned and applies every
 * stage after them — alias ladder, boosts, dedup, packing, rerank, autocut — and
 * it is the same code path whether the arms came from a tenant Postgres database
 * or from U7's in-memory fixture corpus. That is not an aesthetic choice: U7's
 * `Ranker` interface is synchronous, so a stack that could only be exercised
 * through an `await` could not be graded by the blocking tier at all, and CI
 * would be measuring a second implementation.
 *
 * **The order is the specification.** Each stage's output is the next one's
 * input and several of them are not commutative — dedup before packing (packing
 * a payload full of near-duplicates wastes the budget), boosts before dedup (the
 * per-page cap must keep the *best* chunk, which is not knowable before the
 * boosts land), autocut last and only ever on a rerank score.
 *
 * **Autocut reads the rerank score and nothing else.** When rerank is off,
 * autocut does not run. The audit's finding is explicit: cut on the RRF gap and
 * you cut on noise, because the gap between fused ranks is an artefact of how
 * many arms happened to agree rather than a statement about relevance.
 * `rerank-autocut.test.ts` pins the off case behaviourally and
 * `rerank-stage.ts` carries the coupling as a value.
 *
 * **The stage-11/12 seam is a public split, and U12 is why.** The cross-encoder
 * is an *external* call, so the production read path has to `await` between
 * packing and reranking — and this function must stay synchronous, because U7's
 * `Ranker` interface is synchronous and a stack reachable only through an
 * `await` could not be graded by the blocking tier at all. So the stages are
 * exposed as two halves: {@link composeUpToPacking} (1–11) and
 * {@link finishRanking} (12–13). `composeRanking` is their composition, the
 * eval calls it with a scorer that reads committed scores, and `read.ts` calls
 * the two halves around one gateway round trip. Two entry points, one
 * implementation — a second `composeRankingAsync` would be the second
 * implementation this whole file exists to prevent.
 */

import { autocut } from './autocut.ts';
import { packToBudget } from './budget.ts';
import { applyBoosts, type BoostOptions } from './boosts.ts';
import { dedupe, type DedupOptions } from './dedup.ts';
import { classifyIntent, planFor, type RankingPlan } from './intent.ts';
import { fuse, foldRanked } from './rrf.ts';
import { rerank, rerankPassageOf, type RerankOptions } from './rerank.ts';
import { resolveRerankStage, type RerankStagePlan } from './rerank-stage.ts';
import type { Degradation, RecallOutcome, ScoredCandidate, SearchResponse } from './types.ts';

export interface ComposeRequest {
  readonly query: string;
  readonly limit: number;
  /** Injected rather than read from the wall clock — see `boosts.ts`. */
  readonly now: Date;
  /**
   * Override the plan the arms ran under. Almost nothing should pass this: the
   * outcome carries the plan, and disagreeing with it is a deliberate act.
   */
  readonly plan?: RankingPlan;
  readonly budget?: { readonly maxTokens: number };
  readonly dedup?: Partial<DedupOptions>;
  readonly rerank?: RerankOptions;
  readonly boosts?: Partial<BoostOptions>;
}

/**
 * Stages 1–11, ending at the packed candidate set the cross-encoder is asked
 * about.
 *
 * This is the boundary a rerank call is made across, so it is what the request
 * path holds while it awaits one. The plan travels on it because
 * {@link finishRanking} must not recompute one — see `types.ts:RecallOutcome.plan`.
 */
export interface PackedRanking {
  readonly results: readonly ScoredCandidate[];
  readonly plan: RankingPlan;
  readonly degraded: readonly Degradation[];
  readonly armsUsed: SearchResponse['armsUsed'];
}

/**
 * Everything after the arms, in the plan's order.
 *
 * Pure and synchronous. The only inputs are the request, the plan and what the
 * arms returned; the only output is the response. No clock, no database, no
 * provider.
 */
export function composeRanking(request: ComposeRequest, outcome: RecallOutcome): SearchResponse {
  return finishRanking(composeUpToPacking(request, outcome), request.rerank);
}

/** Stages 1–11. See {@link PackedRanking} for why this is a public seam. */
export function composeUpToPacking(request: ComposeRequest, outcome: RecallOutcome): PackedRanking {
  // The outcome's plan, not a fresh one. See `types.ts:RecallOutcome.plan` —
  // recomputing here silently scores the ranking under a plan the arms never
  // ran under. `request.plan` stays as an explicit override.
  const plan = request.plan ?? outcome.plan;

  // Stage 4 — weighted RRF across whichever arms ran.
  const fused = fuse(outcome.arms, { weights: plan.armWeights, k: plan.rrfK });

  // Stage 5 — the alias ladder, folded in with the same arithmetic so it can
  // *inject* a candidate no arm recalled (see `rrf.ts:foldRanked`). One fold per
  // rung, at that rung's weight: an exact title and an entity's incidental
  // evidence both land at rank 1 when they are the only rung that matched, and
  // folding them at one weight would make the ladder's ordering decorative.
  let withLadder: ReadonlyMap<string, number> = fused;
  for (const tier of outcome.aliasLadder) {
    withLadder = foldRanked(withLadder, tier.ids, {
      weight: plan.aliasWeight * tier.weight,
      k: plan.rrfK,
    });
  }

  // Stages 6-9 — the boosts, as one multiplicative envelope over the fused base.
  const scored = applyBoosts({
    fused: withLadder,
    candidates: outcome.candidates,
    query: request.query,
    plan,
    now: request.now,
    resolvedEntityIds: outcome.resolvedEntityIds,
    ...(outcome.resolvedNames === undefined ? {} : { resolvedNames: outcome.resolvedNames }),
    aliasLadder: outcome.aliasLadder.flatMap((tier) => [...tier.ids]),
    ...(request.boosts ?? {}),
  });

  // Stage 10 — four-layer read-time dedup. The requested size is passed through
  // because the page-type cap's denominator is the request, not the survivors —
  // see `dedup.ts:DedupOptions.targetSize`.
  const deduped = dedupe(scored, { targetSize: request.limit, ...request.dedup });

  // Stage 11 — return policy, then token-budget packing.
  const capped = deduped.slice(0, Math.max(1, Math.trunc(request.limit)));
  const packed =
    request.budget === undefined ? capped : packToBudget(capped, request.budget.maxTokens);

  return {
    results: packed,
    plan,
    degraded: outcome.degraded,
    armsUsed: outcome.arms.filter((arm) => arm.ranked.length > 0).map((arm) => arm.arm),
  };
}

/**
 * Stages 12 and 13, over an already-packed list.
 *
 * **They resolve together and they run together.** `rerank-stage.ts` decides
 * once whether the pair is on; autocut is not consulted separately, because a
 * second opinion about whether there is a rerank score to cut on is how the two
 * come apart. A configuration that says rerank is on with nothing to score with
 * resolves to `unavailable` and both stages sit out — the read degrades rather
 * than throwing, which is the same call `read.ts:embedQuery` makes about the
 * other external dependency on this path.
 */
export function finishRanking(packed: PackedRanking, options?: RerankOptions): SearchResponse {
  const stage: RerankStagePlan = resolveRerankStage(options);

  // The candidate cap is the latency dial, applied where the cost is: the tail
  // beyond it is never scored and never reordered, so it keeps its packed order
  // and sits below everything the cross-encoder saw.
  const scored = stage.rerank ? packed.results.slice(0, stage.candidates) : packed.results;
  const tail = stage.rerank ? packed.results.slice(stage.candidates) : [];

  const reranked = stage.rerank ? [...rerank(scored, options), ...tail] : [...packed.results];
  const cut = stage.autocut ? autocut(reranked) : { results: reranked, applied: false };

  return {
    results: cut.results,
    intent: packed.plan.intent,
    plan: packed.plan,
    degraded: packed.degraded,
    armsUsed: packed.armsUsed,
    tokens: tokensOf(cut.results),
    rerankApplied: stage.rerank,
    rerankReason: stage.reason,
    autocutApplied: cut.applied,
  };
}

export { rerankPassageOf };

/** The packed payload's cost, recomputed rather than carried, so it cannot lie. */
function tokensOf(results: readonly ScoredCandidate[]): number {
  let total = 0;
  for (const result of results) total += estimateTokens(result.candidate.content);
  return total;
}

/**
 * Token estimate: characters over four.
 *
 * Deliberately an estimate and deliberately stated as one. The exact count
 * depends on the downstream model's tokenizer, which the read path does not know
 * and must not call — and a budget that is 15% wrong in the safe direction costs
 * a little payload, while a budget that requires a tokenizer round-trip costs a
 * dependency on the request path. Four characters per token is the ratio for
 * English prose; CJK is denser, which this over-estimates, which is the
 * direction an over-run should err in.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export { classifyIntent, planFor };
export type { RankingPlan };
