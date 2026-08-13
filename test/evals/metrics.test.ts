/**
 * The metric implementations, pinned against hand-computed values.
 *
 * **Why this file exists before the corpus does.** R6's floors are numbers, and
 * a number is only a floor if the function producing it is the function everyone
 * thinks it is. A subtly wrong nDCG — natural-log discount instead of log2,
 * linear gain instead of exponential, an ideal ranking computed over the
 * returned items rather than over the whole gold set — still produces a
 * plausible 0.7 and makes every floor, both R6a receipts, and stop condition (c)
 * meaningless in the same silent way. So the expected values here are written
 * out rank by rank as arithmetic, not produced by calling the implementation and
 * pasting the output.
 *
 * Two forms of expectation appear deliberately:
 *
 *   1. **Rank-by-rank arithmetic** — readable, and independent of the loop
 *      shape the implementation happens to use.
 *   2. **Decimal literals** — computed once, off to the side, and pasted. They
 *      pin what the arithmetic form could still let slide.
 *
 * **What these expectations do and do not pin, established by mutation rather
 * than by assumption.** Each mutation below was applied to `evals/metrics.ts`
 * and the suite re-run:
 *
 *   - exponential gain `2^g - 1` → linear `g`      — **red** (3 tests)
 *   - `log2(rank + 1)` discount → linear `rank + 1` — **red** (3 tests)
 *   - ideal ranking not truncated at `k`            — **red** (1 test)
 *   - `log2(rank + 1)` → `log(rank + 1)`            — **GREEN, and correctly so**
 *
 * The last one is not a hole in the tests, it is a property of the metric: the
 * discount's log base is a constant factor that appears in both DCG and IDCG and
 * cancels in the ratio. nDCG is invariant to it. This is recorded here because
 * the obvious thing to write in a docstring — "the literal pins the discount
 * base" — is false, and a future author who believes it will trust a guard that
 * does not exist. What is pinned is the discount's *shape* (logarithmic in rank,
 * not linear), the gain function, and the ideal-truncation policy.
 * {@link ndcgIsInvariantToLogBase} keeps that statement honest by asserting it.
 *
 * The degenerate-input cases matter as much as the arithmetic ones. Every one of
 * them asserts a **throw**, never a score. A metric that returns 0 for "no gold
 * key" and 1 for "no results" is the fail-open shape this whole unit is built
 * against: it lets a query silently drop out of a mean, and a mean over the
 * queries that happened to work is not a measurement.
 */

import { test, expect, describe } from 'bun:test';

import {
  ndcgAt,
  hitAt,
  dilutionHitAt,
  duplicateOccupancyAt,
  MAX_GRADE,
} from '../../evals/metrics.ts';

const log2 = Math.log2;

/** `chunkId -> dup group`, the shape the harness passes down. */
function groupsFrom(entries: Record<string, string>): (chunkId: string) => string | undefined {
  return (chunkId) => entries[chunkId];
}

describe('ndcgAt', () => {
  test('a perfect ranking scores exactly 1', () => {
    const relevance = new Map([
      ['a', 3],
      ['b', 2],
      ['c', 1],
    ]);
    expect(ndcgAt(['a', 'b', 'c', 'd'], relevance, 10)).toBe(1);
  });

  test('the reference mixed ranking matches its rank-by-rank arithmetic', () => {
    // Returned: a(3) b(-) c(2) d(-) e(1). Gold also holds f(3), never returned.
    const relevance = new Map([
      ['a', 3],
      ['c', 2],
      ['e', 1],
      ['f', 3],
    ]);

    const dcg = 7 / log2(2) + 3 / log2(4) + 1 / log2(6);
    const idcg = 7 / log2(2) + 7 / log2(3) + 3 / log2(4) + 1 / log2(5);

    expect(ndcgAt(['a', 'b', 'c', 'd', 'e'], relevance, 10)).toBeCloseTo(dcg / idcg, 12);
  });

  test('the same ranking matches the decimal literal, which pins gain and discount shape', () => {
    const relevance = new Map([
      ['a', 3],
      ['c', 2],
      ['e', 1],
      ['f', 3],
    ]);
    // Exponential gain (2^g - 1), a logarithmic-in-rank discount, ideal over the
    // full gold set truncated to k. Linear gain, linear discount, or an
    // untruncated ideal all miss this number; a different log base does not,
    // and the test below says so out loud.
    expect(ndcgAt(['a', 'b', 'c', 'd', 'e'], relevance, 10)).toBeCloseTo(0.665822262775099, 12);
  });

  /**
   * Named so the docstring above can reference it: the one mutation that
   * survives, asserted as the property it is rather than left as a silent gap.
   */
  test('ndcgIsInvariantToLogBase — a rebased discount is the same metric, by construction', () => {
    const relevance = new Map([
      ['a', 3],
      ['c', 2],
      ['e', 1],
      ['f', 3],
    ]);
    const ranked = ['a', 'b', 'c', 'd', 'e'];

    // Recompute the reference value with a natural-log discount. Both DCG and
    // IDCG scale by 1/ln(2), so the ratio is untouched. Any test that claimed to
    // pin the base would be claiming to detect this difference, and could not.
    const ln = Math.log;
    const dcgLn = 7 / ln(2) + 3 / ln(4) + 1 / ln(6);
    const idcgLn = 7 / ln(2) + 7 / ln(3) + 3 / ln(4) + 1 / ln(5);

    expect(dcgLn / idcgLn).toBeCloseTo(ndcgAt(ranked, relevance, 10), 12);
  });

  test('a gold item past the cutoff contributes nothing to DCG but everything to IDCG', () => {
    const ranked = ['x1', 'g1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9', 'g3'];
    const relevance = new Map([
      ['g1', 1],
      ['g3', 3],
    ]);

    const dcg = 1 / log2(3); // only g1, at rank 2
    const idcg = 7 / log2(2) + 1 / log2(3); // g3 then g1
    expect(ndcgAt(ranked, relevance, 10)).toBeCloseTo(dcg / idcg, 12);
    expect(ndcgAt(ranked, relevance, 10)).toBeCloseTo(0.082680587287043, 12);
  });

  test('the ideal ranking is itself truncated at k', () => {
    // Twelve grade-3 golds, ten returned. IDCG must count ten, not twelve —
    // otherwise a perfect top-10 scores below 1 and the floor is unreachable.
    const relevance = new Map(Array.from({ length: 12 }, (_, i) => [`g${i}`, 3] as const));
    const ranked = Array.from({ length: 10 }, (_, i) => `g${i}`);
    expect(ndcgAt(ranked, relevance, 10)).toBe(1);
  });

  test('an empty result list scores 0 rather than throwing — a ranker may legitimately return nothing', () => {
    expect(ndcgAt([], new Map([['a', 3]]), 10)).toBe(0);
  });

  test('an empty gold key throws instead of scoring', () => {
    expect(() => ndcgAt(['a'], new Map(), 10)).toThrow(/gold/i);
  });

  test('a repeated chunk in the ranking throws — a duplicate would be double-counted', () => {
    expect(() => ndcgAt(['a', 'a'], new Map([['a', 3]]), 10)).toThrow(/twice|duplicate/i);
  });

  test('a grade outside 1..MAX_GRADE throws', () => {
    expect(() => ndcgAt(['a'], new Map([['a', 0]]), 10)).toThrow(/grade/i);
    expect(() => ndcgAt(['a'], new Map([['a', MAX_GRADE + 1]]), 10)).toThrow(/grade/i);
    expect(() => ndcgAt(['a'], new Map([['a', 1.5]]), 10)).toThrow(/grade/i);
  });

  test('a non-positive cutoff throws', () => {
    expect(() => ndcgAt(['a'], new Map([['a', 3]]), 0)).toThrow(/cutoff/i);
  });
});

describe('hitAt', () => {
  const answers = ['a1', 'a2'];

  test('hits when an answer sits at rank 1', () => {
    expect(hitAt(['a1', 'x', 'y'], answers, 1)).toBe(1);
  });

  test('misses at k=1 when the answer sits at rank 2', () => {
    expect(hitAt(['x', 'a1', 'y'], answers, 1)).toBe(0);
  });

  test('hits at k=3 when the answer sits at rank 3', () => {
    expect(hitAt(['x', 'y', 'a2'], answers, 3)).toBe(1);
  });

  test('misses at k=3 when the answer sits at rank 4', () => {
    expect(hitAt(['x', 'y', 'z', 'a2'], answers, 3)).toBe(0);
  });

  test('one answer of several is enough', () => {
    expect(hitAt(['a2'], answers, 1)).toBe(1);
  });

  test('an empty answer set throws rather than scoring 0', () => {
    expect(() => hitAt(['a1'], [], 1)).toThrow(/answer/i);
  });

  test('a repeated chunk in the ranking throws', () => {
    expect(() => hitAt(['x', 'x', 'a1'], answers, 3)).toThrow(/twice|duplicate/i);
  });
});

describe('dilutionHitAt', () => {
  const groupOf = groupsFrom({
    d1: 'g-dup',
    d2: 'g-dup',
    d3: 'g-dup',
    t1: 'g-answer',
    o1: 'g-other',
  });

  test('a top-3 flooded by one duplicate group misses, even though its members are gold', () => {
    expect(dilutionHitAt(['d1', 'd2', 'd3', 't1'], ['g-answer'], groupOf, 3)).toBe(0);
  });

  test('collapsing the duplicates so the distinct answer reaches rank 3 hits', () => {
    expect(dilutionHitAt(['d1', 'o1', 't1'], ['g-answer'], groupOf, 3)).toBe(1);
  });

  test('every required group must be present, not just one of them', () => {
    expect(dilutionHitAt(['t1', 'd1', 'd2'], ['g-answer', 'g-other'], groupOf, 3)).toBe(0);
    expect(dilutionHitAt(['t1', 'o1', 'd1'], ['g-answer', 'g-other'], groupOf, 3)).toBe(1);
  });

  test('a returned chunk with no group mapping cannot satisfy a required group', () => {
    // Fails closed: an unmapped chunk is not silently treated as a member.
    expect(dilutionHitAt(['unmapped', 'x', 'y'], ['g-answer'], groupOf, 3)).toBe(0);
  });

  test('an empty required-group set throws rather than vacuously hitting', () => {
    expect(() => dilutionHitAt(['t1'], [], groupOf, 3)).toThrow(/group/i);
  });
});

describe('duplicateOccupancyAt', () => {
  const groupOf = groupsFrom({ d1: 'g', d2: 'g', d3: 'g', u1: 'h' });

  test('three members of one group occupy two redundant slots of three', () => {
    expect(duplicateOccupancyAt(['d1', 'd2', 'd3'], groupOf, 3)).toBeCloseTo(2 / 3, 12);
  });

  test('a top-3 with no repeats occupies none', () => {
    expect(duplicateOccupancyAt(['d1', 'u1', 'nogroup'], groupOf, 3)).toBe(0);
  });

  test('ungrouped chunks are never redundant with each other', () => {
    expect(duplicateOccupancyAt(['n1', 'n2', 'n3'], groupOf, 3)).toBe(0);
  });

  test('the denominator is the slots actually filled, not the cutoff', () => {
    expect(duplicateOccupancyAt(['d1', 'd2'], groupOf, 3)).toBeCloseTo(1 / 2, 12);
  });

  test('an empty ranking throws rather than reporting a clean 0', () => {
    expect(() => duplicateOccupancyAt([], groupOf, 3)).toThrow(/empty/i);
  });
});
