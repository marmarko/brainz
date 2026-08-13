/**
 * Stage 4 — reciprocal rank fusion.
 *
 * RRF is the stage most likely to be "obviously correct" and quietly wrong,
 * because every arrangement of arms produces *some* ordering and only a fixture
 * distinguishes fusion from concatenation. The four properties pinned here are
 * the ones the rest of the stack depends on:
 *
 *   1. **Agreement beats any single arm's confidence.** An item two arms rank
 *      second beats an item one arm ranks first. This is the reason to fuse at
 *      all; a fusion that failed it would be a weighted concatenation.
 *   2. **Weights are load-bearing.** The intent plan sets them, so a fusion that
 *      ignored them would make stage 2 decorative.
 *   3. **k is load-bearing.** Small k makes rank 1 dominant; large k flattens the
 *      curve so agreement matters more.
 *   4. **The order is total.** Ties break on id, so a score is a function of the
 *      inputs and not of `Array.prototype.sort`'s stability or of insertion
 *      order — the same rule U7's baselines follow.
 */

import { describe, expect, test } from 'bun:test';

import { fuse } from '../../../src/core/search/rrf.ts';
import type { ArmResult } from '../../../src/core/search/types.ts';

const EVEN = { vector: 1, fts: 1, graph: 1 };

function arms(spec: Partial<Record<ArmResult['arm'], readonly string[]>>): ArmResult[] {
  return (Object.entries(spec) as Array<[ArmResult['arm'], readonly string[]]>).map(
    ([arm, ranked]) => ({ arm, ranked }),
  );
}

function order(result: ReadonlyMap<string, number>): string[] {
  return [...result.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([id]) => id);
}

describe('fusion, not concatenation', () => {
  test('two arms agreeing at rank 2 beat one arm at rank 1', () => {
    const fused = fuse(
      arms({ vector: ['solo', 'both'], fts: ['other', 'both'] }),
      { weights: EVEN, k: 5 },
    );
    expect(order(fused)[0]).toBe('both');
  });

  test('an id missing from an arm simply gets nothing from it', () => {
    const fused = fuse(arms({ vector: ['a'], fts: ['b'] }), { weights: EVEN, k: 10 });
    expect(fused.get('a')).toBeCloseTo(1 / 11, 12);
    expect(fused.get('b')).toBeCloseTo(1 / 11, 12);
  });

  test('the arithmetic is the stated formula, 1-based', () => {
    const fused = fuse(arms({ vector: ['a', 'b'] }), { weights: EVEN, k: 60 });
    expect(fused.get('a')).toBeCloseTo(1 / 61, 12);
    expect(fused.get('b')).toBeCloseTo(1 / 62, 12);
  });
});

describe('the plan actually moves fusion', () => {
  test('weights change the winner', () => {
    const spec = arms({ vector: ['v'], graph: ['g'] });
    const vectorLed = fuse(spec, { weights: { vector: 3, fts: 1, graph: 1 }, k: 10 });
    const graphLed = fuse(spec, { weights: { vector: 1, fts: 1, graph: 3 }, k: 10 });
    expect(order(vectorLed)[0]).toBe('v');
    expect(order(graphLed)[0]).toBe('g');
  });

  test('a zero-weight arm contributes nothing even when it returned rows', () => {
    const fused = fuse(arms({ vector: ['a'], graph: ['ghost'] }), {
      weights: { vector: 1, fts: 1, graph: 0 },
      k: 10,
    });
    expect(fused.get('ghost')).toBe(0);
    expect(order(fused)[0]).toBe('a');
  });

  test('k controls how much a rank-1 advantage is worth', () => {
    // `top` is first in one arm and absent from the other; `agreed` is fourth
    // and third. The comparison is between those two and nothing else — stating
    // it as "who is globally first" would also be measuring whichever id each
    // arm happens to rank first, which is not the property.
    const spec = arms({ vector: ['top', 'a1', 'a2', 'agreed'], fts: ['b1', 'b2', 'agreed'] });

    // Small k: being first in one arm is worth more than being third and fourth.
    const sharp = fuse(spec, { weights: EVEN, k: 1 });
    expect(sharp.get('top')!).toBeGreaterThan(sharp.get('agreed')!);

    // Large k: the curve flattens and cross-arm agreement overtakes it.
    const flat = fuse(spec, { weights: EVEN, k: 200 });
    expect(flat.get('agreed')!).toBeGreaterThan(flat.get('top')!);
  });
});

describe('determinism', () => {
  test('equal scores break on id, ascending', () => {
    const fused = fuse(arms({ vector: ['zeta'], fts: ['alpha'] }), { weights: EVEN, k: 10 });
    expect(order(fused)).toEqual(['alpha', 'zeta']);
  });

  test('an empty arm set fuses to nothing rather than throwing', () => {
    // The degraded read (Assumption 5) can arrive here with one arm or none.
    expect(fuse([], { weights: EVEN, k: 10 }).size).toBe(0);
    expect(fuse(arms({ vector: [] }), { weights: EVEN, k: 10 }).size).toBe(0);
  });

  test('a non-positive k is refused rather than dividing by zero at rank 0', () => {
    expect(() => fuse(arms({ vector: ['a'] }), { weights: EVEN, k: 0 })).toThrow(/k/);
  });

  test('a duplicate id inside one arm counts once, at its best rank', () => {
    // An arm that returned the same chunk twice would otherwise double its own
    // vote — a self-reinforcing arm is the opposite of what fusion is for.
    const fused = fuse(arms({ vector: ['a', 'a'] }), { weights: EVEN, k: 10 });
    expect(fused.get('a')).toBeCloseTo(1 / 11, 12);
  });
});
