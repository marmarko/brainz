/**
 * The embedding fixture format, its deterministic synthetic generator, and the
 * loader that refuses to hand out a vector it has not verified.
 *
 * ============================================================================
 * WHAT IS REAL HERE AND WHAT IS A STAND-IN — read this before trusting a score
 * ============================================================================
 *
 * U7 step 1 requires the fixture and query embeddings to be **precomputed and
 * committed** under KTD8's model, with both asymmetric encodings, so the
 * blocking tier makes zero model calls and is bit-identical across runs. No
 * embedding provider is reachable from this environment, so the corpus half
 * ships:
 *
 *   - **the format**, in full, including the provider branch that real vectors
 *     will arrive through (`evals/fixtures/embeddings.provider-sample.jsonl`
 *     exercises it today so it is not dead code);
 *   - **a deterministic synthetic generator** whose output is reproducible from
 *     the committed corpus text alone, with per-vector digests committed in the
 *     manifest so generator drift is caught;
 *   - **this notice**, because a synthetic vector arm is not a semantic one.
 *
 * **What the synthetic vectors are.** Hashed random projections of the text's
 * tokens, plus a small encoding-specific rotation that makes the `query` and
 * `document` encodings of the same text similar but distinct. Cosine similarity
 * between them therefore tracks **lexical overlap**, not meaning. A real
 * `text-embedding-3-large` vector would place "who is Sam" near a page about
 * Samantha Okonkwo; a synthetic one will not, because the strings share no
 * tokens.
 *
 * **What that implies for the floors, stated plainly rather than buried.** Under
 * synthetic vectors the vector arm carries lexical recall and nothing else, so
 * the alias, relational and paraphrase probes must be reached by the alias hop
 * and the graph arm alone. Both R6a receipts are therefore functions of these
 * vectors, and **both must be recomputed when real embeddings land.** The
 * vector-arm leg of the lower-bound baseline will move; the upper bound will
 * not, because it does not read vectors at all.
 *
 * **What must be regenerated, and what changes about the format, on the day a
 * provider is reachable:**
 *
 *   1. Re-encode every chunk with the `document` input type and every query with
 *      the `query` input type under KTD8's model. Truncation to 1536 goes
 *      through the API's `dimensions` parameter — **never client-side slicing**,
 *      which returns a vector that is no longer unit length and silently changes
 *      distance semantics under inner-product operators.
 *   2. Write the rows with `source: "provider"` and a populated `vector_b64`.
 *      Provider vectors cannot be regenerated from committed text, so the floats
 *      themselves must be committed from then on — the synthetic branch's
 *      "regenerate and compare the digest" trick stops being available.
 *   3. Recompute both R6a receipts and re-commit them.
 *   4. Cross-encoder scores for every (query, candidate) pair are the other half
 *      of U7 step 1 and are **not** in this file: they belong to the gates half
 *      of the unit, which needs a running server. Their absence here is a
 *      sequencing decision, not an oversight.
 *
 * ============================================================================
 *
 * **The loader fails closed in four directions**, because every one of them is a
 * way a silently-wrong vector set produces a plausible score: a manifest row for
 * a text that is not in the corpus, a corpus text with no manifest row, a
 * `provider` row with no floats, and a digest that does not match. Verification
 * happens before any vector is returned, never after a caller has used one.
 */

import { createHash } from 'node:crypto';

import { EMBEDDING_DIMENSIONS } from '../src/schema/vector-index.ts';

/**
 * The asymmetric encodings KTD8 requires. A query and a document of identical
 * text get different vectors, which is the whole point of asymmetric encoding —
 * and the reason U7 step 7's live-parity job exists, since a swapped prefix is
 * invisible to a tier that scores against committed vectors.
 */
export const ENCODINGS = ['query', 'document'] as const;
export type Encoding = (typeof ENCODINGS)[number];

export const VECTOR_SOURCES = ['synthetic', 'provider'] as const;
export type VectorSource = (typeof VECTOR_SOURCES)[number];

/** Bumped whenever the synthetic generator changes shape. Committed in the manifest. */
export const SYNTHETIC_GENERATOR = 'lexical-hash-v1';

/** The model id the synthetic vectors stand in for is NOT claimed to be KTD8's. */
export const SYNTHETIC_MODEL = 'synthetic-lexical-v1';

/** Projections per token. Sixteen fits exactly in one sha256 digest. */
const PROJECTIONS_PER_TOKEN = 16;

/** How much of the vector the encoding rotation accounts for. */
const ENCODING_WEIGHT = 0.15;

export interface ManifestRow {
  /** Chunk id (`p-page#n`) or query id (`q-...`). */
  readonly id: string;
  readonly kind: 'chunk' | 'query' | 'fact';
  readonly encoding: Encoding;
  readonly model: string;
  readonly dimensions: number;
  readonly source: VectorSource;
  /** Present iff `source === 'synthetic'`. */
  readonly generator?: string;
  /** Present iff `source === 'provider'`. Base64 of little-endian float32. */
  readonly vector_b64?: string;
  /** sha256 of the canonical float32 little-endian bytes. */
  readonly sha256: string;
}

/** The text a row's vector is computed from, supplied by the caller. */
export interface TextSource {
  readonly kind: 'chunk' | 'query' | 'fact';
  readonly text: string;
}

export interface EmbeddingIndex {
  /** Throws for an id that was never verified. Never returns a zero vector. */
  get(id: string, encoding: Encoding): Float32Array;
  has(id: string, encoding: Encoding): boolean;
  readonly size: number;
  /** Digest over the whole manifest, recorded in both receipts. */
  readonly manifestDigest: string;
  /**
   * How many verified vectors came from each source.
   *
   * **This is the switch every "not yet measurable" verdict hangs off**, and it
   * is counted from the rows rather than declared anywhere. `evals/gates.ts`
   * will only defer a floor while `provider` is zero: the day a single real
   * vector lands, the deferral evaporates on its own and the floor is enforced
   * again, with nobody having to remember to remove anything. A hand-written
   * `kind: 'synthetic'` constant — which is what the R6a receipt carried — is a
   * claim that keeps its value after it stops being true.
   */
  readonly sources: Readonly<Record<VectorSource, number>>;
}

function failEmbeddings(message: string): never {
  throw new Error(`embedding fixture is invalid: ${message}`);
}

/**
 * Tokenisation, deliberately trivial and deliberately shared with the lexical
 * baseline. It is the fixture's normalizer, and R5's real one (`stack.shared-normalizer`)
 * is a U5 deliverable — the point here is only that write and read tokenise the
 * same way, which is the property whose absence presents as misses rather than
 * as errors.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9@.+#-]+/g, ' ')
    .split(' ')
    .map((token) => token.replace(/^[.#-]+|[.#-]+$/g, ''))
    .filter((token) => token.length > 0);
}

function accumulate(target: Float64Array, seed: string, weight: number): void {
  const digest = createHash('sha256').update(seed).digest();
  for (let j = 0; j < PROJECTIONS_PER_TOKEN; j += 1) {
    const high = digest[2 * j];
    const low = digest[2 * j + 1];
    if (high === undefined || low === undefined) continue;
    const index = ((high << 8) | low) % EMBEDDING_DIMENSIONS;
    const sign = (high & 0x80) === 0 ? 1 : -1;
    const current = target[index];
    if (current === undefined) continue;
    target[index] = current + sign * weight;
  }
}

function l2Normalize(vector: Float64Array): void {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  // A text that hashes to the zero vector cannot happen for non-empty input,
  // but a silent divide-by-zero here would produce NaNs that score as misses
  // rather than as errors, so it is refused rather than guarded around.
  if (!(norm > 0)) failEmbeddings('a text produced a zero vector, which has no direction');
  for (let i = 0; i < vector.length; i += 1) {
    const value = vector[i];
    if (value === undefined) continue;
    vector[i] = value / norm;
  }
}

/**
 * The deterministic synthetic encoder.
 *
 * Same text plus same encoding always yields the same bytes, on any machine,
 * with no network and no model. That is what lets the manifest commit a digest
 * instead of two megabytes of floats while keeping the zero-model,
 * bit-identical-across-runs promise intact.
 */
export function syntheticVector(text: string, encoding: Encoding): Float32Array {
  const tokens = tokenize(text);
  if (tokens.length === 0) failEmbeddings('cannot encode text with no tokens');

  const accumulator = new Float64Array(EMBEDDING_DIMENSIONS);
  for (const token of tokens) accumulate(accumulator, token, 1);
  l2Normalize(accumulator);

  // The asymmetric part: a fixed pseudorandom direction per encoding, mixed in
  // at a weight small enough that a query and its answer stay near each other.
  const rotation = new Float64Array(EMBEDDING_DIMENSIONS);
  accumulate(rotation, `encoding:${encoding}`, 1);
  l2Normalize(rotation);
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i += 1) {
    const base = accumulator[i];
    const turn = rotation[i];
    if (base === undefined || turn === undefined) continue;
    accumulator[i] = base + ENCODING_WEIGHT * turn;
  }
  l2Normalize(accumulator);

  return Float32Array.from(accumulator);
}

export function digestOf(vector: Float32Array): string {
  return createHash('sha256').update(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength)).digest('hex');
}

export function encodeVector(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
}

export function decodeVector(base64: string, dimensions: number): Float32Array {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.byteLength !== dimensions * 4) {
    failEmbeddings(`a vector decoded to ${bytes.byteLength} bytes, not the ${dimensions * 4} its dimensions require`);
  }
  const copy = new Float32Array(dimensions);
  Buffer.from(copy.buffer).set(bytes);
  return copy;
}

/** Cosine similarity. Both sides are unit length by construction, but not assumed to be. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) failEmbeddings('cosine over vectors of different length');
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (!(denominator > 0)) failEmbeddings('cosine against a zero vector');
  return dot / denominator;
}

function parseRow(line: string, lineNumber: number): ManifestRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    failEmbeddings(`manifest line ${lineNumber} is not JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null) failEmbeddings(`manifest line ${lineNumber} is not an object`);
  const row = parsed as Record<string, unknown>;

  const id = row['id'];
  const kind = row['kind'];
  const encoding = row['encoding'];
  const model = row['model'];
  const dimensions = row['dimensions'];
  const source = row['source'];
  const sha256 = row['sha256'];

  if (typeof id !== 'string' || id.length === 0) failEmbeddings(`manifest line ${lineNumber} has no id`);
  if (kind !== 'chunk' && kind !== 'query' && kind !== 'fact') {
    failEmbeddings(`manifest row ${id} has unknown kind`);
  }
  if (encoding !== 'query' && encoding !== 'document') failEmbeddings(`manifest row ${id} has unknown encoding`);
  if (typeof model !== 'string' || model.length === 0) failEmbeddings(`manifest row ${id} names no model`);
  if (dimensions !== EMBEDDING_DIMENSIONS) {
    failEmbeddings(`manifest row ${id} declares ${String(dimensions)} dimensions; the tenant column is ${EMBEDDING_DIMENSIONS}`);
  }
  // No default. An unrecognised source is refused rather than treated as one of
  // the two known ones, because guessing here is how an unverified vector gets
  // into a score.
  if (source !== 'synthetic' && source !== 'provider') {
    failEmbeddings(`manifest row ${id} declares source ${String(source)}, which is neither synthetic nor provider`);
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    failEmbeddings(`manifest row ${id} has no usable sha256`);
  }

  const generator = row['generator'];
  const vectorB64 = row['vector_b64'];

  if (source === 'synthetic') {
    if (typeof generator !== 'string' || generator.length === 0) {
      failEmbeddings(`synthetic manifest row ${id} names no generator, so its digest cannot be reproduced`);
    }
    if (vectorB64 !== undefined) failEmbeddings(`synthetic manifest row ${id} also carries floats; pick one`);
    return { id, kind, encoding, model, dimensions, source, generator, sha256 };
  }

  if (typeof vectorB64 !== 'string' || vectorB64.length === 0) {
    failEmbeddings(`provider manifest row ${id} carries no vector; a digest alone cannot be verified against a model`);
  }
  if (generator !== undefined) failEmbeddings(`provider manifest row ${id} names a generator; provider vectors are not generated here`);
  return { id, kind, encoding, model, dimensions, source, vector_b64: vectorB64, sha256 };
}

/**
 * Parse, verify, and index a manifest.
 *
 * `texts` maps `id` → the text the vector must be computed from. It is supplied
 * by the caller (the corpus for chunks, the query set for queries) so this
 * module does not reach into either, and so the bidirectional check has two
 * genuinely independent sides to compare.
 */
export function loadEmbeddings(
  manifest: string,
  texts: ReadonlyMap<string, TextSource>,
): EmbeddingIndex {
  const lines = manifest.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) failEmbeddings('manifest is empty');

  const vectors = new Map<string, Float32Array>();
  const seenIds = new Set<string>();
  const sources: Record<VectorSource, number> = { synthetic: 0, provider: 0 };

  lines.forEach((line, index) => {
    const row = parseRow(line, index + 1);
    const key = `${row.id}|${row.encoding}`;
    if (vectors.has(key)) failEmbeddings(`manifest declares ${key} twice`);

    const text = texts.get(row.id);
    if (text === undefined) failEmbeddings(`manifest row ${row.id} has no corresponding text in the corpus`);
    if (text.kind !== row.kind) failEmbeddings(`manifest row ${row.id} says ${row.kind}; the corpus says ${text.kind}`);

    const vector =
      row.source === 'synthetic'
        ? (() => {
            if (row.generator !== SYNTHETIC_GENERATOR) {
              failEmbeddings(`manifest row ${row.id} was written by generator ${String(row.generator)}, not ${SYNTHETIC_GENERATOR}`);
            }
            return syntheticVector(text.text, row.encoding);
          })()
        : decodeVector(row.vector_b64 ?? failEmbeddings(`provider row ${row.id} lost its vector`), row.dimensions);

    // Verified BEFORE it is stored, so no caller can reach an unverified vector
    // even transiently.
    const digest = digestOf(vector);
    if (digest !== row.sha256) {
      failEmbeddings(
        `manifest row ${row.id} (${row.encoding}) has digest ${row.sha256} but its vector digests to ${digest}`,
      );
    }

    vectors.set(key, vector);
    seenIds.add(row.id);
    sources[row.source] += 1;
  });

  // The orphan direction: a corpus text with no manifest row would silently
  // drop out of the vector arm and read as a retrieval miss forever.
  for (const [id] of texts) {
    if (!seenIds.has(id)) failEmbeddings(`corpus text ${id} has no manifest row`);
  }

  const manifestDigest = createHash('sha256').update(manifest).digest('hex');

  return {
    get(id: string, encoding: Encoding): Float32Array {
      const vector = vectors.get(`${id}|${encoding}`);
      if (vector === undefined) failEmbeddings(`no verified ${encoding} vector for ${id}`);
      return vector;
    },
    has(id: string, encoding: Encoding): boolean {
      return vectors.has(`${id}|${encoding}`);
    },
    size: vectors.size,
    manifestDigest,
    sources,
  };
}

/** Serialise one synthetic row. Used by the regenerator and by the guard tests. */
export function syntheticRow(
  id: string,
  kind: 'chunk' | 'query' | 'fact',
  encoding: Encoding,
  text: string,
): ManifestRow {
  return {
    id,
    kind,
    encoding,
    model: SYNTHETIC_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    source: 'synthetic',
    generator: SYNTHETIC_GENERATOR,
    sha256: digestOf(syntheticVector(text, encoding)),
  };
}

/** Stable key order, so a regenerated manifest diffs cleanly against its predecessor. */
export function serializeRow(row: ManifestRow): string {
  const ordered: Record<string, unknown> = {
    id: row.id,
    kind: row.kind,
    encoding: row.encoding,
    model: row.model,
    dimensions: row.dimensions,
    source: row.source,
  };
  if (row.generator !== undefined) ordered['generator'] = row.generator;
  if (row.vector_b64 !== undefined) ordered['vector_b64'] = row.vector_b64;
  ordered['sha256'] = row.sha256;
  return JSON.stringify(ordered);
}
