/**
 * Stage 12 — the cross-encoder rerank, behind a flag, off until U12.
 *
 * **What ships here is the seam and the guarantee that it is closed.** KTD4
 * admits *bounded* scoring over a fixed candidate set at request time, and names
 * the cross-encoder as the single largest quality lever. It also names the cost:
 * enabling it puts a second synchronous external call on a path that promises a
 * warm p99, alongside the query embedding. So U5 ships the stage, the flag, and
 * the property that matters until U12 flips it — **when the flag is off, nothing
 * happens, and in particular no scorer is called.** A rerank that ran and then
 * discarded its answer would be exactly the latency this flag exists to defer.
 *
 * **`undefined` is the off state, not zero.** Autocut reads the rerank score and
 * only the rerank score, so it has to be able to distinguish "this candidate
 * scored badly" from "nothing scored anything". A default of zero would collapse
 * those two into one value and hand autocut a cliff at every position.
 *
 * **The scorer is injected.** U12 supplies one backed by the gateway's `rerank`
 * op — which is where routing, metering and the key resolution live — so no
 * provider reaches this module and no model is named in it.
 */

import type { ScoredCandidate } from './types.ts';

/** Off. U12 flips it, and KTD4 records what that costs. */
export const RERANK_DEFAULT_ENABLED = false;

export interface RerankOptions {
  readonly enabled?: boolean;
  /**
   * The bounded scorer. Called once per candidate, over the fixed set the
   * earlier stages produced — never over the corpus.
   */
  readonly score?: (candidate: ScoredCandidate, index: number) => number;
}

/**
 * Score and reorder, or pass through untouched.
 *
 * An enabled rerank with no scorer throws rather than passing through: a
 * configuration that believes rerank is on while nothing reranks would show up
 * as a quality regression with no error attached, and it would take autocut down
 * with it silently.
 */
export function rerank(
  results: readonly ScoredCandidate[],
  options: RerankOptions = {},
): ScoredCandidate[] {
  const enabled = options.enabled ?? RERANK_DEFAULT_ENABLED;
  if (!enabled) return [...results];

  const scorer = options.score;
  if (scorer === undefined) {
    throw new Error('rerank is enabled but no scorer was supplied; refusing to run unranked');
  }

  return results
    .map((entry, index) => ({ ...entry, rerankScore: scorer(entry, index) }))
    .sort(
      (a, b) =>
        b.rerankScore - a.rerankScore ||
        (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0),
    );
}
