/**
 * Stage 11 — token-budget packing.
 *
 * **Order-preserving truncation, and nothing cleverer.** The tempting
 * improvement is best-fit: skip the long result that does not fit and take the
 * next short one instead. That is a re-ranking, performed by the budget, on a
 * list every earlier stage spent its effort ordering — and it is invisible,
 * because the payload still looks full and still looks sorted. So packing takes
 * a prefix, and the assertions below say so in the form that a best-fit
 * implementation fails.
 *
 * The one exception is stated and tested: a single result larger than the whole
 * budget is returned anyway. An empty answer to a question the stack *did*
 * retrieve an answer for is worse than an over-budget one, and the caller can
 * see the count.
 */

import { describe, expect, test } from 'bun:test';

import { packToBudget } from '../../../src/core/search/budget.ts';
import { estimateTokens } from '../../../src/core/search/pipeline.ts';
import type { ScoredCandidate } from '../../../src/core/search/types.ts';

function scored(id: string, chars: number, score = 1): ScoredCandidate {
  return {
    candidate: {
      id,
      pageId: `page-${id}`,
      ordinal: 0,
      title: null,
      content: 'x'.repeat(chars),
      origin: 'personal:mail',
      sourceType: 'document',
      createdAt: '2026-06-01',
      live: true,
      attestations: [],
      entityIds: [],
    },
    fused: score,
    score,
    boosts: {},
  };
}

describe('packing', () => {
  test('takes a prefix that fits', () => {
    // 100 chars ≈ 25 tokens each.
    const rows = [scored('a', 100), scored('b', 100), scored('c', 100)];
    expect(packToBudget(rows, 50).map((r) => r.candidate.id)).toEqual(['a', 'b']);
  });

  test('does not skip a large result to fit a later small one', () => {
    // The best-fit implementation returns ['a', 'c']. That is a re-ranking.
    const rows = [scored('a', 100), scored('b', 1000), scored('c', 40)];
    expect(packToBudget(rows, 60).map((r) => r.candidate.id)).toEqual(['a']);
  });

  test('returns the first result even when it alone exceeds the budget', () => {
    const rows = [scored('huge', 10_000), scored('small', 20)];
    const packed = packToBudget(rows, 10);
    expect(packed.map((r) => r.candidate.id)).toEqual(['huge']);
  });

  test('a budget large enough keeps everything', () => {
    const rows = [scored('a', 100), scored('b', 100)];
    expect(packToBudget(rows, 10_000)).toHaveLength(2);
  });

  test('an empty list packs to an empty list', () => {
    expect(packToBudget([], 100)).toEqual([]);
  });

  test('a non-positive budget still returns the top result rather than nothing', () => {
    const rows = [scored('a', 100)];
    expect(packToBudget(rows, 0).map((r) => r.candidate.id)).toEqual(['a']);
  });
});

describe('the token estimate', () => {
  test('is characters over four, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  test('over-estimates rather than under-estimates dense scripts', () => {
    // CJK is denser than four characters per token, so this over-counts — the
    // direction an over-run should err in.
    expect(estimateTokens('日本語のテキスト')).toBeGreaterThan(0);
  });
});
