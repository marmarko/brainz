/**
 * `bun run evals/regenerate-rerank-scores.ts` — rewrites the committed
 * cross-encoder score manifest from the committed corpus text.
 *
 * The counterpart to `regenerate-embeddings.ts`, and the same discipline: no
 * network call, idempotent, and byte-identical on an unchanged corpus.
 * `test/evals/rerank-scores.test.ts` regenerates in memory and diffs against
 * what is on disk, so a corpus edit that was not followed by a regeneration
 * fails the suite rather than quietly scoring against stale numbers.
 *
 * **On the day a cross-encoder is reachable** this is the same entry point: it
 * writes `source: "provider"` rows carrying real floats, at which point the
 * blocking tier's rerank leg stops deferring and its floors enforce, and the A/B
 * receipt's `uplift_status` flips from `deferred` to `measured` — all three
 * without an edit anywhere, because each hangs off the row count rather than off
 * a constant. Read the notice at the top of `evals/rerank-scores.ts` first: the
 * synthetic scores are a stand-in for the *stage*, never for its quality.
 */

import { CORPUS } from './corpus.ts';
import {
  digestOfScores,
  encodeScores,
  serializeScoreRow,
  syntheticScoreRow,
  syntheticScoreVector,
  SYNTHETIC_CROSS_ENCODER_MODEL,
  type RerankScoreRow,
  type ScoreCorpus,
  type ScoredPassage,
} from './rerank-scores.ts';

export const RERANK_MANIFEST_PATH = 'evals/fixtures/rerank-scores.manifest.jsonl';
export const RERANK_PROVIDER_SAMPLE_PATH = 'evals/fixtures/rerank-scores.provider-sample.jsonl';

/**
 * The candidate order every score vector is laid out in.
 *
 * `CORPUS.chunkIds` and nothing else: a vector is positional, so the order it
 * was written in and the order it is read in must be one list. Deriving it here
 * rather than storing it means a corpus edit changes the digest, which is what
 * makes a stale manifest a failure rather than a silent mis-attribution.
 */
export function scoreCorpus(): ScoreCorpus {
  const passages: ScoredPassage[] = [];
  for (const chunkId of CORPUS.chunkIds) {
    const chunk = CORPUS.chunks.get(chunkId);
    if (chunk === undefined) throw new Error(`chunk ${chunkId} is in the id list and not in the corpus`);
    passages.push({ id: chunk.id, title: chunk.title, content: chunk.content });
  }

  const queries = new Map<string, string>();
  for (const query of CORPUS.queries) queries.set(query.id, query.text);

  return { queries, passages };
}

export function buildRerankManifest(): string {
  const corpus = scoreCorpus();
  const rows: RerankScoreRow[] = [];
  for (const [queryId, text] of corpus.queries) {
    rows.push(syntheticScoreRow(queryId, text, corpus.passages));
  }
  return `${rows.map(serializeScoreRow).join('\n')}\n`;
}

/**
 * One row in the shape a real cross-encoder's scores will arrive in, so the
 * provider branch of the loader is exercised by the suite rather than sitting
 * untested until the day it is the only branch that runs.
 *
 * The floats are the synthetic generator's, and the row's `model` says so. What
 * the sample proves is the base64 round trip, the length check and the digest
 * check on a vector that is *carried* rather than reproduced.
 */
export function buildRerankProviderSample(): string {
  const corpus = scoreCorpus();
  const first = CORPUS.queries[0];
  if (first === undefined) throw new Error('corpus has no queries; there is nothing to sample');

  const scores = syntheticScoreVector(first.text, corpus.passages);
  const row: RerankScoreRow = {
    query_id: first.id,
    model: SYNTHETIC_CROSS_ENCODER_MODEL,
    source: 'provider',
    candidates: corpus.passages.length,
    scores_b64: encodeScores(scores),
    sha256: digestOfScores(scores),
  };
  return `${serializeScoreRow(row)}\n`;
}

if (import.meta.main) {
  await Bun.write(RERANK_MANIFEST_PATH, buildRerankManifest());
  await Bun.write(RERANK_PROVIDER_SAMPLE_PATH, buildRerankProviderSample());
  process.stderr.write(`wrote ${RERANK_MANIFEST_PATH} and ${RERANK_PROVIDER_SAMPLE_PATH}\n`);
}
