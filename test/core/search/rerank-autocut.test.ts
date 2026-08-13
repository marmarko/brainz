/**
 * Stages 12 and 13 — the flag-gated rerank and autocut.
 *
 * **This file's whole reason for existing is one sentence from the audit:
 * autocut reads the rerank score only, and when rerank is off, autocut is off.**
 * Pointing it at the RRF gap cuts on noise — the gap between fused scores is an
 * artefact of how many arms happened to agree on a chunk, not a statement about
 * where relevance falls off. The regression is silent: results still come back,
 * sorted, plausible, and short.
 *
 * So the guards here are behavioural rather than structural:
 *
 *   - With rerank off, autocut returns the list **unchanged** even when the
 *     fused-score gap is enormous. A regression to gap-cutting fails this.
 *   - With rerank off, the scorer is **never called**. A rerank that ran and
 *     then discarded its answer would still be a synchronous external call on
 *     the request path, which is what the flag exists to prevent (KTD4).
 *   - No result carries a `rerankScore` when rerank is off. `undefined` is not
 *     zero; autocut must be able to tell "no signal" from "a low score".
 */

import { describe, expect, test } from 'bun:test';

import { autocut } from '../../../src/core/search/autocut.ts';
import { RERANK_DEFAULT_ENABLED, rerank } from '../../../src/core/search/rerank.ts';
import type { ScoredCandidate } from '../../../src/core/search/types.ts';

function scored(id: string, score: number): ScoredCandidate {
  return {
    candidate: {
      id,
      pageId: `page-${id}`,
      ordinal: 0,
      title: null,
      content: `content for ${id}`,
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

/** A cliff in the fused score: a gap-based cut would fire here, hard. */
const CLIFF: ScoredCandidate[] = [
  scored('a', 1.0),
  scored('b', 0.99),
  scored('c', 0.02),
  scored('d', 0.019),
  scored('e', 0.018),
];

describe('rerank is off until U12', () => {
  test('the default is off, stated as a constant', () => {
    expect(RERANK_DEFAULT_ENABLED).toBe(false);
  });

  test('off is a pass-through: same order, same length, no scores', () => {
    const out = rerank(CLIFF);
    expect(out.map((r) => r.candidate.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    for (const entry of out) expect(entry.rerankScore).toBeUndefined();
  });

  test('off means the scorer is never invoked', () => {
    // A rerank that ran and discarded its answer is still a synchronous
    // external call on a path that promises a warm p99 (KTD4).
    let calls = 0;
    rerank(CLIFF, {
      enabled: false,
      score: () => {
        calls += 1;
        return 1;
      },
    });
    expect(calls).toBe(0);
  });

  test('enabled, it scores and reorders', () => {
    const out = rerank(CLIFF, {
      enabled: true,
      // Reverse the order, so "did it actually apply" is unambiguous.
      score: (entry) => 1 - entry.score,
    });
    expect(out.map((r) => r.candidate.id)).toEqual(['e', 'd', 'c', 'b', 'a']);
    for (const entry of out) expect(entry.rerankScore).toBeDefined();
  });

  test('enabled with no scorer is a configuration error, not a silent no-op', () => {
    expect(() => rerank(CLIFF, { enabled: true })).toThrow(/scorer/);
  });
});

describe('autocut reads the rerank score and nothing else', () => {
  test('with rerank off it is a no-op, even across a huge fused gap', () => {
    // The regression this file exists for. `CLIFF` drops 50× between b and c.
    const cut = autocut(rerank(CLIFF));
    expect(cut.applied).toBe(false);
    expect(cut.results.map((r) => r.candidate.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('with rerank on it cuts at the largest drop in the rerank score', () => {
    const reranked = rerank(CLIFF, {
      enabled: true,
      score: (entry) => (entry.candidate.id === 'a' || entry.candidate.id === 'b' ? 0.9 : 0.05),
    });
    const cut = autocut(reranked);
    expect(cut.applied).toBe(true);
    expect(cut.results.map((r) => r.candidate.id)).toEqual(['a', 'b']);
  });

  test('a partially-scored list is treated as unscored, not half-cut', () => {
    // Fail-closed. A mixed list means something went wrong upstream, and
    // guessing which half is authoritative is how a bug becomes a truncation.
    const mixed = [{ ...scored('a', 1), rerankScore: 0.9 }, scored('b', 0.5)];
    const cut = autocut(mixed);
    expect(cut.applied).toBe(false);
    expect(cut.results).toHaveLength(2);
  });

  test('a smooth rerank distribution is not cut', () => {
    const smooth = rerank(
      [scored('a', 1), scored('b', 1), scored('c', 1), scored('d', 1)],
      { enabled: true, score: (_entry, index) => 1 - index * 0.02 },
    );
    const cut = autocut(smooth);
    expect(cut.results).toHaveLength(4);
  });

  test('it never returns nothing', () => {
    const reranked = rerank([scored('a', 1), scored('b', 1)], {
      enabled: true,
      score: (_entry, index) => (index === 0 ? 0.9 : 0.001),
    });
    expect(autocut(reranked).results.length).toBeGreaterThanOrEqual(1);
  });

  test('an empty list is not an error', () => {
    expect(autocut([]).results).toEqual([]);
    expect(autocut([]).applied).toBe(false);
  });
});
