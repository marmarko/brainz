/**
 * Stage 4 — weighted reciprocal rank fusion.
 *
 *     fused(id) = Σ over arms a of  w(a) / (k + rank_a(id))
 *
 * with `rank` 1-based and arms that did not return an id contributing nothing.
 *
 * **Why rank and not score.** The three arms produce numbers on three
 * incomparable scales: cosine distance in [0,2], `ts_rank_cd` in an unbounded
 * positive range that depends on document length, and a graph fan-out that has
 * no natural score at all. Normalising them against each other requires knowing
 * each arm's distribution on this corpus, which changes as the corpus does; RRF
 * needs only the ordering, which is why it survives a corpus that grows by two
 * orders of magnitude without retuning.
 *
 * **Why weights and k come from the plan.** They are the two knobs stage 2 sets.
 * `w` decides which arm's opinion counts more for this *kind* of question — a
 * relational query wants the graph arm's ordering to outweigh the vector arm's.
 * `k` decides how fast a rank advantage decays: at small k, rank 1 is worth far
 * more than rank 3 and a single confident arm wins; at large k the curve
 * flattens and agreement across arms wins. Both being per-intent is what makes
 * the classifier a ranking input rather than a router (`stack.intent-classification`).
 *
 * **A duplicate inside one arm counts once, at its best rank.** An arm that
 * returned the same chunk twice would otherwise cast two votes and outvote the
 * other two arms by itself.
 */

import type { ArmName, ArmResult } from './types.ts';

export interface FusionOptions {
  readonly weights: Readonly<Record<ArmName, number>>;
  readonly k: number;
}

/**
 * Fuse the arms into one score per id.
 *
 * Returns a map rather than a sorted list on purpose: the alias ladder folds
 * into these scores next, and sorting before that would be sorting a number that
 * is not final. The pipeline sorts once, after every additive stage.
 *
 * An empty arm set fuses to an empty map rather than throwing — a degraded read
 * (Assumption 5) legitimately arrives here with one arm, and a read whose every
 * arm found nothing is an empty answer, not an error.
 */
export function fuse(
  arms: readonly ArmResult[],
  options: FusionOptions,
): ReadonlyMap<string, number> {
  if (!Number.isFinite(options.k) || options.k <= 0) {
    throw new RangeError(`RRF k must be a positive finite number, got ${String(options.k)}`);
  }

  const fused = new Map<string, number>();

  for (const arm of arms) {
    const weight = options.weights[arm.arm] ?? 0;
    const seen = new Set<string>();

    for (const [index, id] of arm.ranked.entries()) {
      // Best rank only. Later repeats of the same id are ignored outright rather
      // than added at a worse rank, which would still be a second vote.
      if (seen.has(id)) continue;
      seen.add(id);

      const contribution = weight === 0 ? 0 : weight / (options.k + index + 1);
      fused.set(id, (fused.get(id) ?? 0) + contribution);
    }
  }

  return fused;
}

/**
 * Fold an extra ranked list into an existing fusion, at a given weight.
 *
 * This is how the alias ladder (stage 5) enters: the plan puts the ladder
 * *after* fusion, and folding it in with the same arithmetic — rather than as a
 * multiplicative boost — is what lets it **inject** a candidate no arm recalled.
 * A boost cannot do that: a multiplier on a fused score of zero is still zero,
 * so an exact-title match that neither the vector nor the full-text arm
 * retrieved would score zero forever. The alias floor is all-or-nothing at
 * fourteen queries, and that is the failure it would take.
 */
export function foldRanked(
  fused: ReadonlyMap<string, number>,
  ranked: readonly string[],
  options: { readonly weight: number; readonly k: number },
): Map<string, number> {
  if (!Number.isFinite(options.k) || options.k <= 0) {
    throw new RangeError(`RRF k must be a positive finite number, got ${String(options.k)}`);
  }

  const out = new Map(fused);
  const seen = new Set<string>();

  for (const [index, id] of ranked.entries()) {
    if (seen.has(id)) continue;
    seen.add(id);
    const contribution = options.weight === 0 ? 0 : options.weight / (options.k + index + 1);
    out.set(id, (out.get(id) ?? 0) + contribution);
  }

  return out;
}

/** Deterministic ordering: score descending, then id ascending. */
export function rankedByScore(scores: ReadonlyMap<string, number>): string[] {
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id]) => id);
}
