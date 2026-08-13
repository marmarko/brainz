/**
 * The four ranking metrics R6 names, and nothing else.
 *
 * **These functions are the definition of the floors.** R6 says "nDCG@10 ≥ 0.65",
 * "title-substring Hit@1 ≥ 0.95", "alias Hit@1 ≥ 0.98", "dilution Hit@3 = 1.0" —
 * it names the metrics and does not define them, so this file is where they
 * become checkable. `test/evals/metrics.test.ts` pins every one of them against
 * hand-computed arithmetic, because a subtly wrong metric produces a plausible
 * number and makes every floor, both R6a calibration receipts, and stop
 * condition (c) meaningless in exactly the way that is hardest to notice.
 *
 * The conventions, stated once:
 *
 * - **Graded gain is exponential** (`2^grade - 1`) and the **discount is
 *   `log2(rank + 1)`** with ranks 1-based. This is the standard Järvelin–Kekäläinen
 *   formulation and the one gbrain's floors were measured under; a linear gain
 *   or a linear-in-rank discount produces different numbers for the same
 *   ranking. The log *base* is the one thing here that does not matter — it is a
 *   constant factor in both DCG and IDCG and cancels — and the test file records
 *   that as an asserted property rather than leaving it as an untested belief.
 * - **The ideal ranking is computed over the whole gold key, then truncated to
 *   the same cutoff.** Computing it over the returned items only would score
 *   every ranking 1.0; computing it without truncation would make a perfect
 *   top-10 score below 1 whenever the gold key holds more than ten items, and the
 *   absolute floor would then be unreachable for reasons that have nothing to do
 *   with retrieval.
 * - **Grades are integers in `1..MAX_GRADE`.** Grade 0 is not a grade, it is
 *   absence, and a gold key that records zeroes is a gold key whose author was
 *   thinking of a different scale.
 *
 * **Every degenerate input throws.** No metric here returns a score for a
 * malformed call. This is the unit's recurring-defect discipline made concrete:
 * a metric that returns 0 for "no gold key" lets a query with a missing gold
 * entry slide into a mean as a zero, and a mean over the queries that happened to
 * be well-formed is not a measurement of anything. The one exception is an empty
 * *result list*, which is a legitimate thing for a ranker to produce and scores
 * a real 0.
 */

/** The top of the relevance scale: 3 = answers the question outright. */
export const MAX_GRADE = 3;

function assertCutoff(k: number): void {
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`metric cutoff must be a positive integer, got ${k}`);
  }
}

/**
 * A ranker returning the same chunk twice would collect its gain twice and
 * occupy two slots with one document. Throw rather than de-duplicate silently:
 * the caller has a bug, and quietly repairing it hides the bug in a score.
 */
function assertNoRepeats(ranked: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ranked) {
    if (seen.has(id)) throw new Error(`ranking returned ${id} twice; a duplicate cannot be scored`);
    seen.add(id);
  }
}

function assertGrades(relevance: ReadonlyMap<string, number>): void {
  if (relevance.size === 0) {
    throw new Error('gold key is empty; a query with no graded relevance cannot be scored');
  }
  for (const [id, grade] of relevance) {
    if (!Number.isInteger(grade) || grade < 1 || grade > MAX_GRADE) {
      throw new Error(`gold grade for ${id} must be an integer in 1..${MAX_GRADE}, got ${grade}`);
    }
  }
}

/** Järvelin–Kekäläinen exponential gain. */
function gain(grade: number): number {
  return 2 ** grade - 1;
}

/** 1-based rank, log2 discount. */
function discount(rank: number): number {
  return Math.log2(rank + 1);
}

/**
 * Normalised discounted cumulative gain at `k`.
 *
 * Returns 0 for an empty ranking — a ranker that finds nothing has genuinely
 * earned a zero, and that is different from a call the harness got wrong.
 */
export function ndcgAt(
  ranked: readonly string[],
  relevance: ReadonlyMap<string, number>,
  k: number,
): number {
  assertCutoff(k);
  assertGrades(relevance);
  assertNoRepeats(ranked);

  if (ranked.length === 0) return 0;

  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i += 1) {
    const id = ranked[i];
    if (id === undefined) continue;
    const grade = relevance.get(id);
    if (grade === undefined) continue;
    dcg += gain(grade) / discount(i + 1);
  }

  const ideal = [...relevance.values()].sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < Math.min(k, ideal.length); i += 1) {
    const grade = ideal[i];
    if (grade === undefined) continue;
    idcg += gain(grade) / discount(i + 1);
  }

  // `assertGrades` guarantees at least one grade ≥ 1, so IDCG > 0 and this is
  // never a divide-by-zero. Stated rather than assumed, because a future author
  // relaxing the grade rule would otherwise introduce a silent NaN.
  return dcg / idcg;
}

/**
 * 1 if any chunk from `answers` appears in the top `k`, else 0.
 *
 * The answer set is the grade-3 subset of the gold key, carried separately
 * because Hit@k is a different question from nDCG: "did the thing that actually
 * answers this reach the top of the list", not "how good was the whole ordering".
 */
export function hitAt(ranked: readonly string[], answers: readonly string[], k: number): number {
  assertCutoff(k);
  if (answers.length === 0) {
    throw new Error('answer set is empty; Hit@k over no answers would be vacuously 0 forever');
  }
  assertNoRepeats(ranked);

  const wanted = new Set(answers);
  for (let i = 0; i < Math.min(k, ranked.length); i += 1) {
    const id = ranked[i];
    if (id !== undefined && wanted.has(id)) return 1;
  }
  return 0;
}

/**
 * The dilution metric: 1 if **every** required duplicate group has a member in
 * the raw top `k`, else 0.
 *
 * **Definition, since R6 names this metric without defining it and this is
 * therefore the committed one.** A dilution query is constructed so that one
 * duplicate group — the same content arriving through several origins, or one
 * verbose page's many near-identical chunks — can fill the whole top-3 on term
 * overlap alone. The metric is evaluated on the **raw** ranking, deliberately
 * *not* on a de-duplicated view of it: the system under test is the one that has
 * to collapse the duplicates (R5's 4-layer read-time dedup — top-3-per-page,
 * 0.85 Jaccard, page-type cap, 2-chunks-per-page). Scoring a collapsed list
 * would measure the harness's dedup instead of the stack's, which is the
 * measurement equivalent of grading your own homework.
 *
 * With a single required group this degenerates to plain Hit@3 over that group,
 * which is upstream's form. Two or more required groups extend it to the
 * cross-origin-duplicate case: the answer exists in two distinct places and a
 * ranker that returns three copies of one of them has not answered the question.
 *
 * A returned chunk with no group mapping can never satisfy a requirement. That
 * is the fail-closed direction: an unmapped chunk is unknown, not a match.
 */
export function dilutionHitAt(
  ranked: readonly string[],
  requiredGroups: readonly string[],
  groupOf: (chunkId: string) => string | undefined,
  k: number,
): number {
  assertCutoff(k);
  if (requiredGroups.length === 0) {
    throw new Error('dilution requires at least one required group; an empty set hits vacuously');
  }
  assertNoRepeats(ranked);

  const found = new Set<string>();
  for (let i = 0; i < Math.min(k, ranked.length); i += 1) {
    const id = ranked[i];
    if (id === undefined) continue;
    const group = groupOf(id);
    if (group !== undefined) found.add(group);
  }

  return requiredGroups.every((group) => found.has(group)) ? 1 : 0;
}

/**
 * Diagnostic, not a floor: the fraction of the filled top-`k` slots taken by a
 * duplicate group that was already represented higher up.
 *
 * It exists so a dilution miss can be read. A dilution Hit@3 of 0 says the answer
 * was crowded out; this says by how much, which is the difference between "the
 * dedup layer is missing" and "the answer ranked badly for an unrelated reason".
 *
 * Ungrouped chunks are never redundant with each other — each is its own thing.
 * The denominator is the slots actually filled rather than `k`, so a short
 * ranking is not credited with the cleanliness of slots it never filled.
 */
export function duplicateOccupancyAt(
  ranked: readonly string[],
  groupOf: (chunkId: string) => string | undefined,
  k: number,
): number {
  assertCutoff(k);
  assertNoRepeats(ranked);
  if (ranked.length === 0) {
    throw new Error('duplicate occupancy over an empty ranking is undefined, not zero');
  }

  const filled = Math.min(k, ranked.length);
  const seen = new Set<string>();
  let redundant = 0;

  for (let i = 0; i < filled; i += 1) {
    const id = ranked[i];
    if (id === undefined) continue;
    const group = groupOf(id);
    if (group === undefined) continue;
    if (seen.has(group)) redundant += 1;
    else seen.add(group);
  }

  return redundant / filled;
}
