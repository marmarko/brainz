/**
 * Stage 11 — token-budget packing.
 *
 * **Order-preserving truncation. Nothing cleverer, on purpose.**
 *
 * The obvious improvement is best-fit: when the next result does not fit, skip
 * it and take a later, shorter one. It packs the budget fuller and it is wrong,
 * because it is a re-ranking performed by the budget over a list that eleven
 * stages spent their effort ordering — and it is invisible from the outside,
 * since the payload still looks full and still looks sorted. The reader has no
 * way to tell that result three is missing because it was long rather than
 * because it was worse.
 *
 * **One exception, stated and tested: a single result larger than the entire
 * budget is returned anyway.** Returning nothing to a question the stack did
 * retrieve an answer for is a worse outcome than returning one over-budget
 * result, and the caller can see the count and the token total in the response.
 */

import type { ScoredCandidate } from './types.ts';
import { estimateTokens } from './pipeline.ts';

/**
 * Take the longest prefix that fits, and never fewer than one result.
 *
 * The estimate is `pipeline.ts`'s, shared rather than re-derived: a packer that
 * measured differently from the field the response reports would produce a
 * payload whose declared cost is not its cost.
 */
export function packToBudget(
  results: readonly ScoredCandidate[],
  maxTokens: number,
): ScoredCandidate[] {
  if (results.length === 0) return [];

  const budget = Number.isFinite(maxTokens) ? maxTokens : Number.POSITIVE_INFINITY;
  const packed: ScoredCandidate[] = [];
  let spent = 0;

  for (const entry of results) {
    const cost = estimateTokens(entry.candidate.content);
    if (packed.length > 0 && spent + cost > budget) break;
    packed.push(entry);
    spent += cost;
  }

  return packed;
}
