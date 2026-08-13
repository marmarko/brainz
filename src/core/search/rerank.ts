/**
 * Stage 12 — the cross-encoder rerank, behind a flag, on as of U12.
 *
 * **What ships here is the seam and the guarantee that it is closed when it is
 * closed.** KTD4 admits *bounded* scoring over a fixed candidate set at request
 * time, and names the cross-encoder as the single largest quality lever. It also
 * names the cost: it puts a second synchronous external call on a path that
 * promises a warm p99, alongside the query embedding. So the property that
 * matters in both directions is that **when the flag is off, nothing happens,
 * and in particular no scorer is called** — a rerank that ran and then discarded
 * its answer would be exactly the latency the flag exists to control.
 *
 * **`undefined` is the off state, not zero.** Autocut reads the rerank score and
 * only the rerank score, so it has to be able to distinguish "this candidate
 * scored badly" from "nothing scored anything". A default of zero would collapse
 * those two into one value and hand autocut a cliff at every position.
 *
 * **The scorer is injected.** U12 supplies one backed by the gateway's `rerank`
 * op — which is where routing, metering and the key resolution live — so no
 * provider reaches this module and no model is named in it.
 *
 * **U12 flipped the flag.** What that buys and what it costs is KTD4's
 * accounting: the largest single quality lever, against a second synchronous
 * external call on a path promising a warm p99. The dial when that budget misses
 * is the candidate count — `rerank-stage.ts` owns it, and owns the reason the
 * flag itself is not the dial.
 */

import type { ScoredCandidate } from './types.ts';

/**
 * On, as of U12.
 *
 * Read by `rerank-stage.ts:resolveRerankStage` for a caller that supplies a
 * scorer and states no opinion — which is both the production read path and the
 * blocking tier's rerank leg. Setting it back to `false` observably stops both
 * from reranking, which is what makes the flip a fact rather than a comment.
 */
export const RERANK_DEFAULT_ENABLED = true;

export interface RerankOptions {
  readonly enabled?: boolean;
  /**
   * The bounded scorer. Called once per candidate, over the fixed set the
   * earlier stages produced — never over the corpus.
   */
  readonly score?: (candidate: ScoredCandidate, index: number) => number;
  /**
   * How many candidates the scorer may be asked about. KTD4's named latency
   * dial; see `rerank-stage.ts:LATENCY_DIAL`. Read there rather than here,
   * because this module scores what it is handed.
   */
  readonly candidates?: number;
}

/**
 * The text one candidate is scored as, for the cross-encoder's second half.
 *
 * **One builder, two callers**, and that is the whole point: the production
 * scorer in `read.ts` and the eval's committed score manifest must send the
 * cross-encoder the *same* string, or `eval:live-parity`'s rerank leg compares a
 * score against one produced from a different input and reports drift that is
 * really a template divergence. A title is part of what a passage says — a mail
 * subject routinely carries the answer — so it leads.
 */
export function rerankPassageOf(candidate: {
  readonly title: string | null;
  readonly content: string;
}): string {
  const title = candidate.title;
  return title === null || title.length === 0 ? candidate.content : `${title}\n${candidate.content}`;
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
