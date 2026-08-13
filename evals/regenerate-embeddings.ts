/**
 * `bun run evals/regenerate-embeddings.ts` — rewrites the committed embedding
 * manifest from the committed corpus text.
 *
 * This is the maintainer script U7 step 1 calls for. Today it regenerates
 * synthetic vectors; on the day a provider is reachable it is the same entry
 * point, writing `source: "provider"` rows with real floats — see the long
 * notice at the top of `evals/embeddings.ts` for exactly what changes then.
 *
 * It makes **no network calls** and it is idempotent: running it on an unchanged
 * corpus rewrites byte-identical files. `test/evals/embeddings.test.ts` asserts
 * that by regenerating in memory and comparing to what is on disk, so a corpus
 * edit that was not followed by a regeneration fails the suite rather than
 * quietly scoring against stale vectors.
 */

import { CORPUS, corpusTexts } from './corpus.ts';
import {
  encodeVector,
  serializeRow,
  syntheticRow,
  syntheticVector,
  digestOf,
  SYNTHETIC_MODEL,
  type ManifestRow,
} from './embeddings.ts';
import { EMBEDDING_DIMENSIONS } from '../src/schema/vector-index.ts';

export const MANIFEST_PATH = 'evals/fixtures/embeddings.manifest.jsonl';
export const PROVIDER_SAMPLE_PATH = 'evals/fixtures/embeddings.provider-sample.jsonl';

/**
 * Build the manifest in memory.
 *
 * Chunks and facts carry one `document` vector each. Queries carry both
 * encodings — the `query` one the vector arm reads, and a `document` one that
 * only the live-parity job will ever compare against.
 */
export function buildManifest(): string {
  const texts = corpusTexts(CORPUS);
  const rows: ManifestRow[] = [];

  for (const [id, text] of texts) {
    if (text.kind === 'query') {
      rows.push(syntheticRow(id, 'query', 'query', text.text));
      rows.push(syntheticRow(id, 'query', 'document', text.text));
    } else {
      // Chunks and facts are both document-side rows.
      rows.push(syntheticRow(id, text.kind, 'document', text.text));
    }
  }

  return `${rows.map(serializeRow).join('\n')}\n`;
}

/**
 * Two rows in the shape real vectors will arrive in, so the provider branch of
 * the loader is exercised by the suite rather than sitting untested until the
 * day it is the only branch that runs.
 *
 * The floats are the synthetic generator's output. They are not claimed to be
 * anything else — the row's `model` says so — and what the sample proves is that
 * the base64 round trip, the dimension check and the digest check all work on a
 * row whose vector is carried rather than reproduced.
 */
export function buildProviderSample(): string {
  const first = CORPUS.chunkIds[0];
  const firstQuery = CORPUS.queries[0];
  if (first === undefined || firstQuery === undefined) {
    throw new Error('corpus is empty; there is nothing to sample');
  }
  const chunk = CORPUS.chunks.get(first);
  if (chunk === undefined) throw new Error(`chunk ${first} vanished`);

  const rows: ManifestRow[] = [
    (() => {
      const vector = syntheticVector(chunk.content, 'document');
      return {
        id: chunk.id,
        kind: 'chunk',
        encoding: 'document',
        model: SYNTHETIC_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        source: 'provider',
        vector_b64: encodeVector(vector),
        sha256: digestOf(vector),
      };
    })(),
    (() => {
      const vector = syntheticVector(firstQuery.text, 'query');
      return {
        id: firstQuery.id,
        kind: 'query',
        encoding: 'query',
        model: SYNTHETIC_MODEL,
        dimensions: EMBEDDING_DIMENSIONS,
        source: 'provider',
        vector_b64: encodeVector(vector),
        sha256: digestOf(vector),
      };
    })(),
  ];

  return `${rows.map(serializeRow).join('\n')}\n`;
}

if (import.meta.main) {
  await Bun.write(MANIFEST_PATH, buildManifest());
  await Bun.write(PROVIDER_SAMPLE_PATH, buildProviderSample());
  process.stderr.write(`wrote ${MANIFEST_PATH} and ${PROVIDER_SAMPLE_PATH}\n`);
}
