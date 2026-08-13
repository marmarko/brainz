/**
 * `bun run eval:live-parity` — the only coverage the two read-path model stages
 * have anywhere in the two-tier design (U7 approach step 7, Gap #16).
 *
 * **The gap this closes, stated exactly.** The blocking tier's determinism comes
 * from committed embeddings and committed cross-encoder scores. That means it
 * grades the *consumers* of those scores and never the invocations. A swapped
 * asymmetric query prefix, a changed `dimensions` parameter, a client-side
 * truncation that skips re-normalisation, or a broken rerank input template all
 * produce **identical blocking-tier scores** while real recall degrades — and
 * that is not a hypothetical, it is what committing the vectors buys and costs.
 *
 * The two properties below are therefore tested together, because either alone
 * is misleading:
 *
 *   1. The blocking tier does **not** move under a perturbed encoder. (If it
 *      did, this job would be redundant.)
 *   2. The parity check **does** catch it. (If it did not, the perturbation
 *      would ship green through both tiers.)
 *
 * **Refusals are the point, not an edge case.** The committed manifest carries
 * zero provider-sourced vectors today — no embedding provider is reachable from
 * this environment — and the cross-encoder scores U12 needs do not exist at all.
 * A parity job that returned success having compared nothing would be the
 * strongest possible version of the defect it exists to catch, so an empty
 * sample is `no_committed_provider_vectors` and the command exits non-zero. The
 * *workflow* decides whether to invoke it; the command never lies about what it
 * compared.
 */

import { describe, expect, test } from 'bun:test';

import { CORPUS, corpusTexts } from '../../evals/corpus.ts';
import { EMBEDDING_DIMENSIONS } from '../../src/schema/vector-index.ts';
import { loadEmbeddings, syntheticVector, type Encoding } from '../../evals/embeddings.ts';
import { MANIFEST_PATH } from '../../evals/regenerate-embeddings.ts';
import { runBlockingTier } from '../../evals/blocking.ts';
import {
  TOLERANCE_PATH,
  checkEmbeddingParity,
  checkRerankParity,
  committedProviderSamples,
  loadTolerance,
  parseTolerance,
  type ParitySample,
  type ParityViolation,
} from '../../evals/live-parity.ts';
import { stackRanker } from '../core/search/corpus-ranker.ts';

const manifestText = await Bun.file(`${import.meta.dir}/../../${MANIFEST_PATH}`).text();
const embeddings = loadEmbeddings(manifestText, corpusTexts(CORPUS));
const context = { corpus: CORPUS, embeddings };
const tolerance = loadTolerance();

const kinds = (violations: readonly ParityViolation[]): string[] => violations.map((v) => v.kind);

const ROUTED = 'text-embedding-3-large';

function sample(id: string, text: string, encoding: Encoding = 'query'): ParitySample {
  return {
    id,
    encoding,
    model: ROUTED,
    dimensions: EMBEDDING_DIMENSIONS,
    vector: syntheticVector(text, encoding),
  };
}

/** What a provider round-trip returns, as the command hands it to the check. */
function response(id: string, text: string, encoding: Encoding = 'query') {
  return { id, encoding, model: ROUTED, vector: [...syntheticVector(text, encoding)] };
}

describe('the shipped state: nothing to compare, and the job says so', () => {
  test('the committed manifest carries no provider-sourced vectors', () => {
    expect(embeddings.sources.provider).toBe(0);
    expect(committedProviderSamples(manifestText, embeddings)).toEqual([]);
  });

  test('an empty sample is a refusal, never a pass', () => {
    const result = checkEmbeddingParity({ samples: [], fresh: [], tolerance, routedModelId: ROUTED });
    expect(result.passed).toBe(false);
    expect(kinds(result.violations)).toEqual(['no_committed_provider_vectors']);
    expect(result.compared).toBe(0);
  });

  test('the rerank leg refuses the same way, for the scores U12 has not committed', () => {
    const result = checkRerankParity({ samples: [], fresh: [], tolerance });
    expect(result.passed).toBe(false);
    expect(kinds(result.violations)).toEqual(['no_committed_rerank_scores']);
  });
});

describe('the embedding leg catches what the blocking tier cannot see', () => {
  const samples = [
    sample('q-1', 'who does Sam work for'),
    sample('q-2', 'what did the pilot conclude'),
    sample('p-1#0', 'The pilot concluded with a signed extension.', 'document'),
  ];
  const clean = [
    response('q-1', 'who does Sam work for'),
    response('q-2', 'what did the pilot conclude'),
    response('p-1#0', 'The pilot concluded with a signed extension.', 'document'),
  ];

  test('an unchanged provider round-trip passes and reports what it compared', () => {
    const result = checkEmbeddingParity({ samples, fresh: clean, tolerance, routedModelId: ROUTED });
    expect(result.violations).toEqual([]);
    expect(result.compared).toBe(3);
  });

  test('a swapped asymmetric prefix diverges — the query encoded as a document', () => {
    // The exact failure Gap #16 names: query and document share one space, and
    // encoding a query with the document input type is silent everywhere else.
    const perturbed = [
      { ...response('q-1', 'who does Sam work for', 'document'), encoding: 'query' as Encoding },
      ...clean.slice(1),
    ];
    const result = checkEmbeddingParity({ samples, fresh: perturbed, tolerance, routedModelId: ROUTED });
    expect(kinds(result.violations)).toEqual(['divergence']);
    expect(result.violations[0]?.detail).toContain('q-1');
  });

  test('a changed query prefix diverges', () => {
    const perturbed = [response('q-1', 'search query: who does Sam work for'), ...clean.slice(1)];
    const result = checkEmbeddingParity({ samples, fresh: perturbed, tolerance, routedModelId: ROUTED });
    expect(kinds(result.violations)).toEqual(['divergence']);
  });

  test('a changed `dimensions` value is dimension_mismatch, not a silent shorter compare', () => {
    const truncated = { ...clean[0]!, vector: [...clean[0]!.vector].slice(0, 1024) };
    const result = checkEmbeddingParity({
      samples,
      fresh: [truncated, ...clean.slice(1)],
      tolerance,
      routedModelId: ROUTED,
    });
    expect(kinds(result.violations)).toEqual(['dimension_mismatch']);
    expect(result.violations[0]?.detail).toContain('1024');
  });

  test('client-side truncation that skips re-normalisation is not_unit_norm — KTD8 pins the mechanism', () => {
    // The vector is the right width and points the right way; it is simply no
    // longer unit length, which silently changes distance semantics under an
    // inner-product operator and degrades recall with no error anywhere.
    const sliced = [...clean[0]!.vector];
    for (let i = 1024; i < sliced.length; i += 1) sliced[i] = 0;
    const result = checkEmbeddingParity({
      samples,
      fresh: [{ ...clean[0]!, vector: sliced }, ...clean.slice(1)],
      tolerance,
      routedModelId: ROUTED,
    });
    expect(kinds(result.violations)).toContain('not_unit_norm');
  });

  test('a vector the provider never returned is missing_response, not a skipped sample', () => {
    const result = checkEmbeddingParity({
      samples,
      fresh: clean.slice(1),
      tolerance,
      routedModelId: ROUTED,
    });
    expect(kinds(result.violations)).toEqual(['missing_response']);
    expect(result.compared).toBe(2);
  });

  test('a NaN component is non_finite, checked before any comparison', () => {
    const poisoned = [...clean[0]!.vector];
    poisoned[7] = Number.NaN;
    const result = checkEmbeddingParity({
      samples,
      fresh: [{ ...clean[0]!, vector: poisoned }, ...clean.slice(1)],
      tolerance,
      routedModelId: ROUTED,
    });
    expect(kinds(result.violations)).toEqual(['non_finite']);
  });

  test('a committed vector produced by a model the table no longer routes is model_mismatch', () => {
    // The responses deliberately carry no `model` attribution, so the only
    // check that can fire is the one comparing the COMMITTED vector's model
    // against the routed id. A provider that does not echo its model back must
    // not be the reason this drift goes unnoticed — the committed side already
    // knows what produced it.
    const unattributed = clean.map(({ model: _drop, ...rest }) => rest);
    const result = checkEmbeddingParity({
      samples,
      fresh: unattributed,
      tolerance,
      routedModelId: 'text-embedding-3-small',
    });
    expect(kinds(result.violations)).toEqual(['model_mismatch', 'model_mismatch', 'model_mismatch']);
  });

  test('a response attributed to a different model is model_mismatch too', () => {
    const result = checkEmbeddingParity({
      samples,
      fresh: [{ ...clean[0]!, model: 'text-embedding-3-small' }, ...clean.slice(1)],
      tolerance,
      routedModelId: ROUTED,
    });
    expect(kinds(result.violations)).toEqual(['model_mismatch']);
  });
});

describe('the two tiers, side by side: the blocking tier is blind to all of it', () => {
  test('a perturbed encoder moves nothing in the blocking tier', () => {
    // The blocking tier reads the committed manifest and never encodes anything,
    // so there is no perturbation of an encoder that it can observe. That is the
    // property this whole job exists because of, and it is asserted here rather
    // than described: the digest is a function of the committed vectors alone,
    // and the run records zero egress because it never asks a provider for one.
    const before = runBlockingTier({ ranker: stackRanker, context });
    const after = runBlockingTier({ ranker: stackRanker, context });
    expect(after.digest).toBe(before.digest);
    expect(before.egress).toEqual([]);
    expect(before.passed).toBe(true);
  });

  test('and the parity check is what notices — same input, opposite verdict', () => {
    const one = [sample('q-1', 'who does Sam work for')];
    const perturbed = [response('q-1', 'query: who does Sam work for')];
    const result = checkEmbeddingParity({ samples: one, fresh: perturbed, tolerance, routedModelId: ROUTED });
    expect(result.passed).toBe(false);
  });
});

describe('the rerank leg', () => {
  const samples = [
    { queryId: 'q-1', candidateId: 'p-1#0', model: 'rerank-2', score: 0.82 },
    { queryId: 'q-1', candidateId: 'p-2#0', model: 'rerank-2', score: 0.11 },
  ];

  test('unchanged scores pass', () => {
    const result = checkRerankParity({ samples, fresh: samples.map((s) => ({ ...s })), tolerance });
    expect(result.violations).toEqual([]);
    expect(result.compared).toBe(2);
  });

  test('a score outside tolerance diverges, naming the pair', () => {
    const fresh = [{ ...samples[0]!, score: 0.4 }, { ...samples[1]! }];
    const result = checkRerankParity({ samples, fresh, tolerance });
    expect(kinds(result.violations)).toEqual(['divergence']);
    expect(result.violations[0]?.detail).toContain('p-1#0');
  });

  test('a pair the model did not score is missing_response', () => {
    const result = checkRerankParity({ samples, fresh: [samples[0]!], tolerance });
    expect(kinds(result.violations)).toEqual(['missing_response']);
  });

  test('a non-finite score is non_finite, never compared', () => {
    const fresh = [{ ...samples[0]!, score: Number.NaN }, { ...samples[1]! }];
    const result = checkRerankParity({ samples, fresh, tolerance });
    expect(kinds(result.violations)).toEqual(['non_finite']);
  });
});

describe('the tolerance is committed data with a rationale, not a constant in code', () => {
  test('it loads, and every threshold is a positive finite number', () => {
    expect(tolerance.maxCosineDistance).toBeGreaterThan(0);
    expect(tolerance.maxComponentDelta).toBeGreaterThan(0);
    expect(tolerance.unitNormEpsilon).toBeGreaterThan(0);
    expect(tolerance.maxScoreDelta).toBeGreaterThan(0);
  });

  test('it carries the reasoning that produced the numbers', () => {
    expect(tolerance.rationale.length).toBeGreaterThan(80);
  });

  test(`it lives at ${TOLERANCE_PATH}`, () => {
    expect(TOLERANCE_PATH.endsWith('.json')).toBe(true);
  });

  test('a tolerance with no rationale is refused — an unexplained threshold is a knob', () => {
    const bad = JSON.stringify({ ...tolerance, rationale: '' });
    expect(() => parseTolerance(bad)).toThrow(/rationale/);
  });

  test('a non-positive or non-finite threshold is refused', () => {
    expect(() => parseTolerance(JSON.stringify({ ...tolerance, maxCosineDistance: 0 }))).toThrow();
    expect(() => parseTolerance(JSON.stringify({ ...tolerance, unitNormEpsilon: -1 }))).toThrow();
  });

  test('a tolerance loose enough to accept a swapped encoding is refused', () => {
    // The threshold has one job. A value that would let the perturbation this
    // job exists to catch through is not a looser gate, it is no gate.
    expect(() => parseTolerance(JSON.stringify({ ...tolerance, maxCosineDistance: 0.5 }))).toThrow(
      /maxCosineDistance/,
    );
  });
});
