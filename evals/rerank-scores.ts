/**
 * The committed (query, candidate) cross-encoder scores, and the loader that
 * refuses to hand out one it has not verified.
 *
 * ============================================================================
 * WHAT IS REAL HERE AND WHAT IS A STAND-IN — read this before trusting a number
 * ============================================================================
 *
 * U7 step 1 asks for these and U7 deliberately did not commit them, on the
 * grounds that "fabricating a synthetic score manifest to have one would commit
 * an artifact nothing reads, in the shape of a measurement". That objection had
 * a specific shape — *nothing reads it* — and U12 is the unit that changes it:
 * the blocking tier's rerank leg reads every row below, and `eval:live-parity`'s
 * rerank leg compares against them the day a provider is reachable.
 *
 * **No cross-encoder is reachable from this environment**, so what is committed
 * is the format in full, a deterministic generator, and per-query digests. Same
 * arrangement as `evals/embeddings.ts`, and the same `source` switch: one
 * `provider` row anywhere and the deferral machinery stops deferring, with
 * nobody having to remember to remove anything.
 *
 * **What the synthetic scorer is.** A *joint* lexical relevance function over
 * (query, passage): what fraction of the query's content terms the passage
 * carries, how tightly they sit together, and whether the passage is itself
 * question-shaped. Joint is the important word — it is the one signal a fused
 * bag-of-words ranking genuinely does not have, so it is the honest thing to
 * stand in with.
 *
 * **What it is NOT: a relevance model.** `bge-reranker-base` is a 278M-parameter
 * cross-encoder. This is thirty lines of arithmetic. Used as the *sole sort key*
 * — which is what stage 12 does — it is measurably **worse** than the stack it
 * reranks: U12 measured −0.1646 aggregate nDCG@10 on the committed corpus, with
 * title-substring Hit@1 falling from 1.000 to 0.100. That number is in the
 * committed A/B receipt, and it is evidence about *this generator*, not about
 * the rerank stage. It is exactly why the uplift claim is `deferred` rather than
 * reported: **a stand-in weaker than the stack it reranks measures the
 * stand-in.**
 *
 * So the rows below buy three things and not a fourth:
 *
 *   1. stages 12 and 13 execute in the blocking tier on every run, over the same
 *      shape the fleet runs, so a change to either is graded rather than
 *      unobserved;
 *   2. the tier's rerank leg has determinism, zero-egress and zero-leak
 *      enforced, none of which depend on score quality;
 *   3. `live-parity` gains something to compare a live score against.
 *
 * They do **not** buy a quality claim about reranking. Nothing in this file or
 * downstream of it should be read as one.
 *
 * ============================================================================
 *
 * **One row per query, not one per pair.** The digest covers the whole score
 * vector over the corpus's chunk ids in corpus order, which is 77 rows instead
 * of ~11,800 and verifies exactly as strictly. A provider run fills `scores_b64`
 * the way `embeddings.manifest.jsonl` fills `vector_b64`; scoring the full
 * matrix through `@cf/baai/bge-reranker-base` costs about a cent and a half, so
 * the full-matrix shape stays available to a real run rather than being a
 * synthetic-only convenience.
 */

import { createHash } from 'node:crypto';

import { rerankPassageOf } from '../src/core/search/rerank.ts';
import { PHRASE_STOPWORDS, tokens } from '../src/core/search/normalize.ts';

/** Bumped whenever the synthetic generator changes shape. Committed per row. */
export const CROSS_ENCODER_GENERATOR = 'joint-lexical-v1';

/** The model the synthetic scores stand in for is NOT claimed to be KTD13's. */
export const SYNTHETIC_CROSS_ENCODER_MODEL = 'synthetic-cross-encoder-v1';

export const SCORE_SOURCES = ['synthetic', 'provider'] as const;
export type ScoreSource = (typeof SCORE_SOURCES)[number];

export interface RerankScoreRow {
  readonly query_id: string;
  readonly model: string;
  readonly source: ScoreSource;
  /** How many candidates the vector covers. Must equal the corpus's chunk count. */
  readonly candidates: number;
  /** Present iff `source === 'synthetic'`. */
  readonly generator?: string;
  /** Present iff `source === 'provider'`. Base64 of little-endian float32. */
  readonly scores_b64?: string;
  /** sha256 of the canonical float32 little-endian bytes. */
  readonly sha256: string;
}

export interface RerankScoreIndex {
  /** Throws for a pair that was never verified. Never returns a default. */
  score(queryId: string, chunkId: string): number;
  has(queryId: string, chunkId: string): boolean;
  readonly queries: number;
  readonly manifestDigest: string;
  /**
   * How many verified score vectors came from each source.
   *
   * The switch every "not yet measurable" verdict about the rerank stage hangs
   * off, counted from the rows rather than declared. See the header: while
   * `provider` is zero, the rerank leg's floors are reported and not enforced.
   */
  readonly sources: Readonly<Record<ScoreSource, number>>;
}

function failScores(message: string): never {
  throw new Error(`cross-encoder score fixture is invalid: ${message}`);
}

/** One candidate, as the scorer sees it. The same fields `rerankPassageOf` reads. */
export interface ScoredPassage {
  readonly id: string;
  readonly title: string | null;
  readonly content: string;
}

/**
 * The deterministic synthetic cross-encoder.
 *
 * Three terms, weighted, clamped to [0, 1]:
 *
 *   - **coverage** — what fraction of the query's content terms the passage
 *     carries. The dominant term, because a passage that answers a question
 *     usually contains what the question is about.
 *   - **proximity** — how tightly the matched terms sit. A bag-of-words arm
 *     cannot see this at all, which is why it is here: a stand-in that carried
 *     no signal the earlier stages lack would make the whole stage a no-op and
 *     the leg would grade nothing.
 *   - **answer shape** — a passage that is itself a question is a poor answer to
 *     one. The committed corpus is built with a large population of
 *     question-shaped decoys precisely because they defeat a keyword arm.
 *
 * Deliberately simple, deliberately declared as insufficient. See the header.
 */
export function crossEncoderScore(query: string, passage: string): number {
  const queryTerms = tokens(query).filter((term) => !PHRASE_STOPWORDS.has(term));
  if (queryTerms.length === 0) return 0;

  const passageTerms = tokens(passage);
  const positions = new Map<string, number[]>();
  passageTerms.forEach((term, index) => {
    const list = positions.get(term);
    if (list === undefined) positions.set(term, [index]);
    else list.push(index);
  });

  const matched = queryTerms.filter((term) => positions.has(term));
  const coverage = matched.length / queryTerms.length;

  let proximity = 0;
  if (matched.length >= 2) {
    const firsts = matched.map((term) => positions.get(term)![0]!);
    const lasts = matched.map((term) => {
      const list = positions.get(term)!;
      return list[list.length - 1]!;
    });
    const span = Math.max(...lasts) - Math.min(...firsts) + 1;
    proximity = matched.length / Math.max(span, matched.length);
  } else if (matched.length === 1) {
    proximity = 0.5;
  }

  const answerShape = /\?/.test(passage) ? 0 : 1;
  const raw = 0.65 * coverage + 0.25 * proximity + 0.1 * answerShape;
  return Math.max(0, Math.min(1, raw));
}

/** One query's score vector over the corpus, in the caller's candidate order. */
export function syntheticScoreVector(
  query: string,
  passages: readonly ScoredPassage[],
): Float32Array {
  return Float32Array.from(
    passages.map((passage) => crossEncoderScore(query, rerankPassageOf(passage))),
  );
}

export function digestOfScores(scores: Float32Array): string {
  return createHash('sha256')
    .update(Buffer.from(scores.buffer, scores.byteOffset, scores.byteLength))
    .digest('hex');
}

export function encodeScores(scores: Float32Array): string {
  return Buffer.from(scores.buffer, scores.byteOffset, scores.byteLength).toString('base64');
}

export function decodeScores(base64: string, candidates: number): Float32Array {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.byteLength !== candidates * 4) {
    failScores(`a score vector decoded to ${bytes.byteLength} bytes, not the ${candidates * 4} its length requires`);
  }
  const copy = new Float32Array(candidates);
  Buffer.from(copy.buffer).set(bytes);
  return copy;
}

function parseRow(line: string, lineNumber: number): RerankScoreRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    failScores(`manifest line ${lineNumber} is not JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null) failScores(`manifest line ${lineNumber} is not an object`);
  const row = parsed as Record<string, unknown>;

  const queryId = row['query_id'];
  const model = row['model'];
  const source = row['source'];
  const candidates = row['candidates'];
  const sha256 = row['sha256'];

  if (typeof queryId !== 'string' || queryId.length === 0) failScores(`manifest line ${lineNumber} has no query id`);
  if (typeof model !== 'string' || model.length === 0) failScores(`manifest row ${queryId} names no model`);
  // No default. An unrecognised source is refused rather than treated as one of
  // the two known ones — guessing here is how an unverified score reaches a leg
  // that decides whether a floor is enforced.
  if (source !== 'synthetic' && source !== 'provider') {
    failScores(`manifest row ${queryId} declares source ${String(source)}, which is neither synthetic nor provider`);
  }
  if (typeof candidates !== 'number' || !Number.isSafeInteger(candidates) || candidates <= 0) {
    failScores(`manifest row ${queryId} declares ${String(candidates)} candidates`);
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    failScores(`manifest row ${queryId} has no usable sha256`);
  }

  const generator = row['generator'];
  const scoresB64 = row['scores_b64'];

  if (source === 'synthetic') {
    if (typeof generator !== 'string' || generator.length === 0) {
      failScores(`synthetic manifest row ${queryId} names no generator, so its digest cannot be reproduced`);
    }
    if (scoresB64 !== undefined) failScores(`synthetic manifest row ${queryId} also carries scores; pick one`);
    return { query_id: queryId, model, source, candidates, generator, sha256 };
  }

  if (typeof scoresB64 !== 'string' || scoresB64.length === 0) {
    failScores(`provider manifest row ${queryId} carries no scores; a digest alone cannot be verified against a model`);
  }
  if (generator !== undefined) failScores(`provider manifest row ${queryId} names a generator; provider scores are not generated here`);
  return { query_id: queryId, model, source, candidates, scores_b64: scoresB64, sha256 };
}

export interface ScoreCorpus {
  /** The queries, by id, with the text the scorer sees. */
  readonly queries: ReadonlyMap<string, string>;
  /** Every candidate, in the canonical order the vectors are laid out in. */
  readonly passages: readonly ScoredPassage[];
}

/**
 * Parse, verify, and index a manifest.
 *
 * Fails closed in five directions, each of which is a way a silently-wrong score
 * produces a plausible ranking: a row for a query that is not in the corpus, a
 * corpus query with no row, a vector of the wrong length, a `provider` row with
 * no floats, and a digest that does not match. Verification happens before any
 * score is reachable.
 */
export function loadRerankScores(manifest: string, corpus: ScoreCorpus): RerankScoreIndex {
  const lines = manifest.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length === 0) failScores('manifest is empty');

  const order = new Map<string, number>();
  corpus.passages.forEach((passage, index) => order.set(passage.id, index));

  const vectors = new Map<string, Float32Array>();
  const sources: Record<ScoreSource, number> = { synthetic: 0, provider: 0 };

  lines.forEach((line, index) => {
    const row = parseRow(line, index + 1);
    if (vectors.has(row.query_id)) failScores(`manifest declares ${row.query_id} twice`);

    const query = corpus.queries.get(row.query_id);
    if (query === undefined) failScores(`manifest row ${row.query_id} has no corresponding query in the corpus`);
    if (row.candidates !== corpus.passages.length) {
      failScores(
        `manifest row ${row.query_id} covers ${row.candidates} candidates; the corpus has ${corpus.passages.length}`,
      );
    }

    const scores =
      row.source === 'synthetic'
        ? (() => {
            if (row.generator !== CROSS_ENCODER_GENERATOR) {
              failScores(
                `manifest row ${row.query_id} was written by generator ${String(row.generator)}, not ${CROSS_ENCODER_GENERATOR}`,
              );
            }
            return syntheticScoreVector(query, corpus.passages);
          })()
        : decodeScores(row.scores_b64 ?? failScores(`provider row ${row.query_id} lost its scores`), row.candidates);

    const digest = digestOfScores(scores);
    if (digest !== row.sha256) {
      failScores(`manifest row ${row.query_id} has digest ${row.sha256} but its scores digest to ${digest}`);
    }

    vectors.set(row.query_id, scores);
    sources[row.source] += 1;
  });

  // The orphan direction: a query with no row would silently score every
  // candidate the same and read as "the reranker had no opinion".
  for (const [queryId] of corpus.queries) {
    if (!vectors.has(queryId)) failScores(`corpus query ${queryId} has no manifest row`);
  }

  const manifestDigest = createHash('sha256').update(manifest).digest('hex');

  return {
    score(queryId, chunkId) {
      const vector = vectors.get(queryId);
      if (vector === undefined) failScores(`no verified score vector for ${queryId}`);
      const index = order.get(chunkId);
      if (index === undefined) failScores(`${chunkId} is not a candidate this manifest covers`);
      const value = vector[index];
      if (value === undefined) failScores(`no verified score for ${queryId} × ${chunkId}`);
      return value;
    },
    has(queryId, chunkId) {
      const index = order.get(chunkId);
      return index !== undefined && vectors.get(queryId)?.[index] !== undefined;
    },
    queries: vectors.size,
    manifestDigest,
    sources,
  };
}

/** Serialise one synthetic row. Used by the regenerator and by the guards. */
export function syntheticScoreRow(
  queryId: string,
  query: string,
  passages: readonly ScoredPassage[],
): RerankScoreRow {
  return {
    query_id: queryId,
    model: SYNTHETIC_CROSS_ENCODER_MODEL,
    source: 'synthetic',
    candidates: passages.length,
    generator: CROSS_ENCODER_GENERATOR,
    sha256: digestOfScores(syntheticScoreVector(query, passages)),
  };
}

/** Stable key order, so a regenerated manifest diffs cleanly. */
export function serializeScoreRow(row: RerankScoreRow): string {
  const ordered: Record<string, unknown> = {
    query_id: row.query_id,
    model: row.model,
    source: row.source,
    candidates: row.candidates,
  };
  if (row.generator !== undefined) ordered['generator'] = row.generator;
  if (row.scores_b64 !== undefined) ordered['scores_b64'] = row.scores_b64;
  ordered['sha256'] = row.sha256;
  return JSON.stringify(ordered);
}
