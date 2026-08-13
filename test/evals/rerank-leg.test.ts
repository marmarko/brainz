/**
 * The committed cross-encoder scores, and the switch that decides whether the
 * shipped configuration's floors are enforced.
 *
 * **The guard that matters most is the switch, driven from both sides.** While
 * every committed score is synthetic the rerank leg's floor outcomes are
 * reported and not enforced — which is a deferral, and a deferral nobody can
 * observe flipping is a deferral that becomes permanent. So this file loads the
 * real manifest (all synthetic, leg not enforced) *and* a manifest carrying one
 * provider-sourced row (leg enforced), and asserts the behaviour differs. A
 * hard-coded `false` passes the first and fails the second.
 *
 * **What never depends on the switch** is the other half: determinism, network
 * egress and fence leaks bind on the rerank leg whatever the scores are, because
 * they are properties of the stages rather than of the numbers the stages read.
 */

import { describe, expect, test } from 'bun:test';

import {
  loadRerankScoreIndex,
  loadTierContext,
  runRerankLeg,
  SYNTHETIC_SCORES_REASON,
} from '../../evals/blocking.ts';
import {
  buildRerankManifest,
  buildRerankProviderSample,
  RERANK_MANIFEST_PATH,
  RERANK_PROVIDER_SAMPLE_PATH,
  scoreCorpus,
} from '../../evals/regenerate-rerank-scores.ts';
import {
  CROSS_ENCODER_GENERATOR,
  crossEncoderScore,
  digestOfScores,
  loadRerankScores,
  serializeScoreRow,
  syntheticScoreVector,
  type RerankScoreRow,
} from '../../evals/rerank-scores.ts';
import { rerankedStackRanker, stackRanker } from '../core/search/corpus-ranker.ts';

const corpus = scoreCorpus();
const context = loadTierContext();

describe('the manifest is fresh and reproducible', () => {
  test('regenerating it in memory produces what is on disk', async () => {
    // A corpus edit that was not followed by a regeneration would otherwise
    // score against stale numbers with no signal anywhere.
    const onDisk = await Bun.file(`${import.meta.dir}/../../${RERANK_MANIFEST_PATH}`).text();
    expect(buildRerankManifest()).toBe(onDisk);
  });

  test('the provider sample is fresh too, and loads through the provider branch', async () => {
    const onDisk = await Bun.file(`${import.meta.dir}/../../${RERANK_PROVIDER_SAMPLE_PATH}`).text();
    expect(buildRerankProviderSample()).toBe(onDisk);

    const firstQuery = [...corpus.queries.keys()][0]!;
    const index = loadRerankScores(onDisk, {
      queries: new Map([[firstQuery, corpus.queries.get(firstQuery)!]]),
      passages: corpus.passages,
    });
    expect(index.sources.provider).toBe(1);
    expect(index.sources.synthetic).toBe(0);
  });

  test('every query has a verified vector over every candidate', () => {
    const index = loadRerankScoreIndex();
    expect(index.queries).toBe(corpus.queries.size);
    expect(index.sources.synthetic).toBe(corpus.queries.size);
    const query = [...corpus.queries.keys()][0]!;
    for (const passage of corpus.passages) expect(index.has(query, passage.id)).toBe(true);
  });
});

describe('the loader fails closed', () => {
  const query = [...corpus.queries.keys()][0]!;
  const text = corpus.queries.get(query)!;
  const oneQuery = new Map([[query, text]]);
  const good = syntheticScoreVector(text, corpus.passages);

  function manifestOf(overrides: Partial<RerankScoreRow>): string {
    return `${serializeScoreRow({
      query_id: query,
      model: 'synthetic-cross-encoder-v1',
      source: 'synthetic',
      candidates: corpus.passages.length,
      generator: CROSS_ENCODER_GENERATOR,
      sha256: digestOfScores(good),
      ...overrides,
    })}\n`;
  }

  test('an unrecognised source is refused rather than guessed', () => {
    expect(() =>
      loadRerankScores(manifestOf({ source: 'guessed' as never }), { queries: oneQuery, passages: corpus.passages }),
    ).toThrow(/neither synthetic nor provider/);
  });

  test('a digest that does not match is refused before the score is reachable', () => {
    expect(() =>
      loadRerankScores(manifestOf({ sha256: 'f'.repeat(64) }), { queries: oneQuery, passages: corpus.passages }),
    ).toThrow(/digest/);
  });

  test('a vector covering the wrong number of candidates is refused', () => {
    expect(() =>
      loadRerankScores(manifestOf({ candidates: corpus.passages.length - 1 }), {
        queries: oneQuery,
        passages: corpus.passages,
      }),
    ).toThrow(/candidates/);
  });

  test('a query with no row is refused — the orphan direction', () => {
    const second = [...corpus.queries.keys()][1]!;
    expect(() =>
      loadRerankScores(manifestOf({}), {
        queries: new Map([...oneQuery, [second, corpus.queries.get(second)!]]),
        passages: corpus.passages,
      }),
    ).toThrow(/has no manifest row/);
  });

  test('a row for a query the corpus does not have is refused', () => {
    expect(() =>
      loadRerankScores(manifestOf({ query_id: 'q-not-in-the-corpus' }), {
        queries: oneQuery,
        passages: corpus.passages,
      }),
    ).toThrow(/no corresponding query/);
  });

  test('a synthetic row written by another generator is refused', () => {
    expect(() =>
      loadRerankScores(manifestOf({ generator: 'joint-lexical-v0' }), {
        queries: oneQuery,
        passages: corpus.passages,
      }),
    ).toThrow(/generator/);
  });

  test('an unverified pair is never served a default', () => {
    const index = loadRerankScores(manifestOf({}), { queries: oneQuery, passages: corpus.passages });
    expect(() => index.score(query, 'not-a-chunk')).toThrow(/not a candidate/);
  });
});

describe('the synthetic scorer carries joint signal, and says it is not a model', () => {
  test('coverage dominates: a passage carrying the query terms outscores one that does not', () => {
    const near = crossEncoderScore('renewal pricing', 'The renewal pricing is agreed.');
    const far = crossEncoderScore('renewal pricing', 'The kettle needs descaling.');
    expect(near).toBeGreaterThan(far);
  });

  test('proximity is signal a bag-of-words arm does not have', () => {
    const tight = crossEncoderScore('renewal pricing', 'renewal pricing agreed');
    const loose = crossEncoderScore(
      'renewal pricing',
      `renewal ${'filler '.repeat(40)}pricing`,
    );
    expect(tight).toBeGreaterThan(loose);
  });

  test('a question-shaped passage is a worse answer than a statement', () => {
    const answer = crossEncoderScore('renewal pricing', 'The renewal pricing is agreed.');
    const question = crossEncoderScore('renewal pricing', 'What is the renewal pricing?');
    expect(answer).toBeGreaterThan(question);
  });

  test('every score is a probability', () => {
    const index = loadRerankScoreIndex();
    const query = [...corpus.queries.keys()][0]!;
    for (const passage of corpus.passages.slice(0, 20)) {
      const value = index.score(query, passage.id);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('the rerank leg, and the switch that enforces it', () => {
  const scores = loadRerankScoreIndex();

  test('the shipped configuration is graded on every run', () => {
    const leg = runRerankLeg({ ranker: rerankedStackRanker(scores), context, scores });
    expect(leg.result.ranker).toBe('u12-shipped-stack');
    // It really ran: floor outcomes exist for every floor, over the whole set.
    expect(leg.result.gate.outcomes.length).toBeGreaterThan(0);
    expect(leg.result.report.queryCount).toBe(context.corpus.queries.length);
  });

  test('while every score is synthetic, its floors are reported and not enforced', () => {
    const leg = runRerankLeg({ ranker: rerankedStackRanker(scores), context, scores });
    expect(scores.sources.provider).toBe(0);
    expect(leg.enforced).toBe(false);
    expect(leg.reason).toBe(SYNTHETIC_SCORES_REASON);
    // The stand-in genuinely misses floors — so this is a real deferral of a
    // real failure, not a deferral of nothing.
    expect(leg.result.violations.some((violation) => violation.kind === 'floor')).toBe(true);
    expect(leg.binding.filter((violation) => violation.kind === 'floor')).toEqual([]);
  });

  test('ONE PROVIDER SCORE AND IT ENFORCES — the switch, from the other side', () => {
    // The half a hard-coded `false` would pass. Same corpus, same ranker, same
    // numbers; the only change is that one row claims a provider produced it.
    const providerScores = loadRerankScores(buildRerankProviderSample() + buildSyntheticTail(), corpus);
    expect(providerScores.sources.provider).toBe(1);

    const leg = runRerankLeg({ ranker: rerankedStackRanker(providerScores), context, scores: providerScores });
    expect(leg.enforced).toBe(true);
    expect(leg.reason).not.toBe(SYNTHETIC_SCORES_REASON);
    expect(leg.binding.filter((violation) => violation.kind === 'floor').length).toBeGreaterThan(0);
  });

  test('determinism and leaks bind whatever the scores are', () => {
    const leg = runRerankLeg({ ranker: rerankedStackRanker(scores), context, scores });
    // No leak and no non-determinism on the shipped stack, which is what makes
    // the binding list empty rather than the filter being inert: the kinds it
    // would carry are exactly the ones it does not filter out.
    expect(leg.binding).toEqual([]);
    expect(leg.result.egress).toEqual([]);
    for (const kind of ['leak', 'nondeterministic', 'network_egress', 'empty_query_set'] as const) {
      expect(leg.binding.some((violation) => violation.kind === kind)).toBe(false);
    }
  });

  test('the baseline leg still carries the enforced floors', () => {
    const { runBlockingTier } = require('../../evals/blocking.ts') as typeof import('../../evals/blocking.ts');
    expect(runBlockingTier({ ranker: stackRanker, context }).passed).toBe(true);
  });
});

/** The manifest's rows minus its first, so a spliced provider row is not a duplicate. */
function buildSyntheticTail(): string {
  const first = [...corpus.queries.keys()][0]!;
  return buildRerankManifest()
    .split('\n')
    .filter((line) => line.trim().length > 0 && !line.includes(`"query_id":"${first}"`))
    .join('\n')
    .concat('\n');
}
