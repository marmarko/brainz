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
 * **Autocut reads the rerank score and nothing else.** When rerank is off — its
 * state until U12 — autocut does not run. The audit's finding is explicit: cut
 * on the RRF gap and you cut on noise, because the gap between fused ranks is an
 * artefact of how many arms happened to agree rather than a statement about
 * relevance. `rerank.test.ts` pins the off case behaviourally.
 */

import { autocut } from './autocut.ts';
import { packToBudget } from './budget.ts';
import { applyBoosts, type BoostOptions } from './boosts.ts';
import { dedupe, type DedupOptions } from './dedup.ts';
import { classifyIntent, planFor, type RankingPlan } from './intent.ts';
import { fuse, foldRanked } from './rrf.ts';
import { rerank, type RerankOptions } from './rerank.ts';
import type { RecallOutcome, ScoredCandidate, SearchResponse } from './types.ts';

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
 * Everything after the arms, in the plan's order.
 *
 * Pure and synchronous. The only inputs are the request, the plan and what the
 * arms returned; the only output is the response. No clock, no database, no
 * provider.
 */
export function composeRanking(request: ComposeRequest, outcome: RecallOutcome): SearchResponse {
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

  // Stage 12 — rerank, flag-gated and off until U12.
  const reranked = rerank(packed, request.rerank);

  // Stage 13 — autocut, on the rerank score only.
  const cut = autocut(reranked);

  return {
    results: cut.results,
    intent: plan.intent,
    plan,
    degraded: outcome.degraded,
    armsUsed: outcome.arms.filter((arm) => arm.ranked.length > 0).map((arm) => arm.arm),
    tokens: tokensOf(cut.results),
    autocutApplied: cut.applied,
  };
}

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
