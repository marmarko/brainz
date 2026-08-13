/**
 * The naive single-arm baselines R6a's lower bound is measured against, and the
 * oracle ranker its upper bound is measured against.
 *
 * **Why there are two naive baselines and not one.** R6a says "a naive
 * single-arm baseline". Choosing which single arm is a choice with a thumb on
 * the scale: pick the weaker arm and the corpus looks harder than it is, and the
 * lower-bound receipt — whose whole job is to prove the corpus is not easy —
 * becomes the thing that is easy. So both available arms are run and
 * {@link strongestNaive} takes the **higher** score on each floor. The stack has
 * to beat the best naive arm, not the one that flattered the fixture.
 *
 * **The baselines are naive about ranking and nothing else.** Both honour the
 * origin fence and both exclude soft-deleted and quarantined chunks. This is not
 * generosity: a baseline that ignored the fence would retrieve decoys it was
 * never entitled to, score lower for a reason that has nothing to do with
 * ranking, and make the corpus look harder than it is. The lower bound would
 * then be measuring the baseline's bug.
 *
 * **What the vector arm is measuring today.** The committed vectors are
 * synthetic — hashed lexical projections, not semantic embeddings (see the
 * notice in `evals/embeddings.ts`). So `vector-cosine` today is a second lexical
 * arm with different weighting rather than an independent signal, and the
 * lower-bound receipt says so. When real embeddings land it becomes a genuinely
 * different arm and the receipt must be recomputed: the honest expectation is
 * that the vector baseline gets **stronger**, which narrows the margin, which is
 * exactly the kind of change a committed receipt exists to surface.
 *
 * **Ties are broken by chunk id, ascending, everywhere.** Every ranker here
 * produces a total order, so a score is a function of the corpus and nothing
 * else — not of `Array.prototype.sort` stability, not of insertion order.
 */

import type { Corpus, FixtureQuery } from './corpus.ts';
import { cosine, tokenize } from './embeddings.ts';
import type { Ranker, RankerContext } from './run.ts';
import { RESULT_LIMIT } from './run.ts';

const BM25_K1 = 1.2;
const BM25_B = 0.75;

interface LexicalIndex {
  readonly documentFrequency: ReadonlyMap<string, number>;
  readonly lengths: ReadonlyMap<string, number>;
  readonly termFrequencies: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly averageLength: number;
  readonly liveCount: number;
}

const lexicalIndexes = new WeakMap<Corpus, LexicalIndex>();

/**
 * Corpus statistics for BM25, computed over every **live** chunk rather than
 * per-grant.
 *
 * Per-grant statistics would be more faithful to a fenced reader's view, but
 * they would also make a chunk's score depend on who is asking, which turns a
 * ranking comparison into two incomparable rankings. Whole-corpus statistics are
 * the ordinary choice and are stated here so the choice is visible.
 */
function lexicalIndexFor(corpus: Corpus): LexicalIndex {
  const cached = lexicalIndexes.get(corpus);
  if (cached !== undefined) return cached;

  const documentFrequency = new Map<string, number>();
  const lengths = new Map<string, number>();
  const termFrequencies = new Map<string, ReadonlyMap<string, number>>();
  let totalLength = 0;
  let liveCount = 0;

  for (const chunkId of corpus.chunkIds) {
    const chunk = corpus.chunks.get(chunkId);
    if (chunk === undefined || !chunk.live) continue;
    const tokens = tokenize(chunk.content);
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const token of frequencies.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
    termFrequencies.set(chunkId, frequencies);
    lengths.set(chunkId, tokens.length);
    totalLength += tokens.length;
    liveCount += 1;
  }

  if (liveCount === 0) throw new Error('lexical index over a corpus with no live chunks');

  const index: LexicalIndex = {
    documentFrequency,
    lengths,
    termFrequencies,
    averageLength: totalLength / liveCount,
    liveCount,
  };
  lexicalIndexes.set(corpus, index);
  return index;
}

function rankByScore(scored: readonly { readonly id: string; readonly score: number }[]): readonly string[] {
  return [...scored]
    .sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, RESULT_LIMIT)
    .map((entry) => entry.id);
}

/**
 * BM25 over chunk content, and nothing else.
 *
 * Deliberately over **chunk content only**: the page title is a separate field
 * in the tenant schema (`page.title_tsv`) and R5's title-phrase boost is the
 * stack element that reads it. A naive keyword arm that also searched titles
 * would already be carrying one of the mechanisms the floors are meant to prove.
 */
export const lexicalBaseline: Ranker = {
  name: 'naive-lexical-bm25',
  description: 'Single arm: BM25 over chunk content. No titles, no aliases, no graph, no recency, no dedup.',
  rank(query: FixtureQuery, context: RankerContext): readonly string[] {
    const { corpus } = context;
    const index = lexicalIndexFor(corpus);
    const visible = corpus.visibleTo(query.grant);
    const terms = tokenize(query.text);

    const scored: { id: string; score: number }[] = [];
    for (const chunkId of visible) {
      const frequencies = index.termFrequencies.get(chunkId);
      const length = index.lengths.get(chunkId);
      if (frequencies === undefined || length === undefined) continue;

      let score = 0;
      for (const term of terms) {
        const frequency = frequencies.get(term);
        if (frequency === undefined) continue;
        const df = index.documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (index.liveCount - df + 0.5) / (df + 0.5));
        const denominator = frequency + BM25_K1 * (1 - BM25_B + (BM25_B * length) / index.averageLength);
        score += idf * ((frequency * (BM25_K1 + 1)) / denominator);
      }
      // A zero-scoring chunk shares no term with the query; returning it would
      // pad the list with noise and inflate the duplicate-occupancy diagnostic.
      if (score > 0) scored.push({ id: chunkId, score });
    }

    return rankByScore(scored);
  },
};

/**
 * Cosine over the committed vectors, and nothing else.
 *
 * The query is read in its `query` encoding and the chunks in their `document`
 * encoding, which is KTD8's asymmetric pairing. No fusion, no reranking, no
 * `ef_search` concerns — this is an exhaustive scan, so hazard H1 cannot apply.
 */
export const vectorBaseline: Ranker = {
  name: 'naive-vector-cosine',
  description: 'Single arm: cosine over the committed asymmetric vectors. No fusion, no boosts, no dedup.',
  rank(query: FixtureQuery, context: RankerContext): readonly string[] {
    const { corpus, embeddings } = context;
    const queryVector = embeddings.get(query.id, 'query');
    const visible = corpus.visibleTo(query.grant);

    const scored: { id: string; score: number }[] = [];
    for (const chunkId of visible) {
      scored.push({ id: chunkId, score: cosine(queryVector, embeddings.get(chunkId, 'document')) });
    }

    return rankByScore(scored);
  },
};

/**
 * The oracle: the gold key, returned in its own best order.
 *
 * This is what R6a's upper bound is scored through, and its value is not that it
 * scores 1.0 — it is that it scores 1.0 **through the same metric functions the
 * floors use**, over a gold key that has already survived the loader's
 * visibility and grant checks. A query whose gold key is malformed, whose answer
 * is fenced out of its own grant, or whose required duplicate groups cannot all
 * reach the top three does not score 1.0 here, and the attainability receipt
 * goes red instead of the corpus quietly being unwinnable.
 *
 * It orders by grade descending, then by chunk id, and returns nothing that is
 * not in the gold key — an oracle that padded its list could hide a dilution
 * probe whose required groups were never reachable in three slots.
 */
export const goldOracle: Ranker = {
  name: 'gold-oracle',
  description: 'Returns the gold key, ordered by grade then id. The attainability ceiling.',
  rank(query: FixtureQuery, context: RankerContext): readonly string[] {
    const relevance = context.corpus.relevanceFor(query.id);
    return [...relevance.entries()]
      .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, RESULT_LIMIT)
      .map(([chunkId]) => chunkId);
  },
};

export const NAIVE_BASELINES: readonly Ranker[] = [lexicalBaseline, vectorBaseline];

/**
 * The strongest naive value for one measurement, across all naive arms.
 *
 * Used by the lower-bound receipt so the committed margin is measured against
 * the best naive arm rather than a conveniently weak one.
 */
export function strongestNaive(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('no naive baseline values to compare; the lower bound would be vacuous');
  }
  let best = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    // A non-finite naive value would win a `>` comparison against nothing and
    // lose one against everything, depending on which side NaN lands. Refuse it.
    if (!Number.isFinite(value)) throw new Error('a naive baseline produced a non-finite value');
    if (value > best) best = value;
  }
  return best;
}
