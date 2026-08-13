/**
 * Stage 13 — autocut, on the rerank score and nothing else.
 *
 * **The audit's finding, implemented as a refusal.** Autocut sizes a result list
 * by finding where the score distribution falls off a cliff. Pointed at the RRF
 * gap it cuts on noise: the distance between two fused scores is an artefact of
 * how many arms happened to return a chunk and at what rank, not a statement
 * about where relevance ends. Two arms agreeing on the top two results and one
 * arm carrying the rest produces a large gap at position two on *every* query,
 * regardless of whether the answer is at position one or position seven.
 *
 * So this stage reads {@link ScoredCandidate.rerankScore} and refuses to act
 * without it. Since rerank is off until U12, **autocut is off until U12** — and
 * the response says so through `autocutApplied`, so an operator can tell the
 * difference between "the list was not cut" and "the list did not need cutting".
 *
 * **A partially-scored list is treated as unscored.** A mixed list means
 * something went wrong upstream, and guessing which half is authoritative is how
 * a bug becomes a truncation.
 *
 * **It never returns nothing.** The largest relative drop in a two-element list
 * is between its two elements, and an autocut that could return zero results
 * would turn a merely-mediocre ranking into an empty answer.
 */

import type { ScoredCandidate } from './types.ts';

/**
 * How much the score must fall, as a fraction of the preceding score, for the
 * position to count as a cliff.
 *
 * Relative rather than absolute because cross-encoder scores are not calibrated
 * across queries: an absolute threshold would cut aggressively on a query whose
 * every candidate scored low and never cut on one whose candidates all scored
 * high.
 */
export const AUTOCUT_RELATIVE_DROP = 0.5;

/**
 * Never cut above this position.
 *
 * **Three, and the number is R6's rather than a preference.** The blocking tier
 * measures a dilution floor of Hit@3 = 1.0 — three distinct duplicate groups in
 * the top three — and a title-substring floor at Hit@1. An autocut that may
 * return two results makes the dilution floor *unsatisfiable by construction*
 * every time it fires, which is a product promise lost to a ranking constant
 * with no error attached anywhere.
 *
 * It is not hypothetical: a cross-encoder's score distribution is routinely
 * top-heavy, so at a relative-drop threshold of 0.5 a cut at position one is the
 * ordinary case rather than the exotic one. U12 measured exactly that when it
 * enabled the stage. `test/core/search/rerank-stage.test.ts` derives the bound
 * from `RANKING_FLOORS` so that a new Hit@k floor at a wider cutoff makes this
 * constant red rather than making the floor unreachable.
 */
export const AUTOCUT_MINIMUM_KEPT = 3;

export interface AutocutResult {
  readonly results: readonly ScoredCandidate[];
  /** False whenever rerank was off. Reported through the response envelope. */
  readonly applied: boolean;
}

export function autocut(results: readonly ScoredCandidate[]): AutocutResult {
  if (results.length === 0) return { results: [], applied: false };

  // Every candidate must carry a rerank score, or there is no signal to cut on.
  // Deliberately not `?? 0`: absent is not low.
  const scores: number[] = [];
  for (const entry of results) {
    if (entry.rerankScore === undefined || !Number.isFinite(entry.rerankScore)) {
      return { results: [...results], applied: false };
    }
    scores.push(entry.rerankScore);
  }

  let cutAfter = results.length;
  for (let index = AUTOCUT_MINIMUM_KEPT; index < scores.length; index += 1) {
    const previous = scores[index - 1]!;
    const current = scores[index]!;
    if (previous <= 0) continue;
    const drop = (previous - current) / previous;
    if (drop >= AUTOCUT_RELATIVE_DROP) {
      cutAfter = index;
      break;
    }
  }

  return {
    results: results.slice(0, Math.max(AUTOCUT_MINIMUM_KEPT, cutAfter)),
    applied: cutAfter < results.length,
  };
}
