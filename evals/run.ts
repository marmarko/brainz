/**
 * The harness: it runs a ranker over the whole query set and produces one
 * report, per family and per question type, that the floors are checked against.
 *
 * **The harness does not filter for the ranker.** It would be easy — and wrong —
 * for this file to hand each ranker only the chunks its grant allows. R15 fences
 * reads on `origin_context`, and the system under test is the thing that has to
 * honour that. If the harness applied the fence, a ranker that ignored it
 * entirely would score identically to one that enforced it, and the
 * context-fenced floor would be measuring nothing. So the ranker sees the whole
 * corpus, the query carries its grant, and a result outside that grant is a
 * **violation**: counted, named, and fatal at the gate, independent of any
 * score. The same goes for soft-deleted (R12) and quarantined (U9) chunks.
 *
 * **Nothing is skipped, ever.** A query with no gold key, a ranker that returns
 * an unknown chunk id, a duplicate in a result list — each throws. The
 * alternative in every case is a query quietly dropping out of a mean, and a
 * mean over the queries that happened to work is the exact fail-open shape this
 * unit is built against. For the same reason, per-type and per-family buckets
 * carry their **count** alongside their mean, and an empty bucket's mean is
 * `NaN` rather than 0 or 1 — `evals/gates.ts` treats a non-finite measurement
 * and an under-populated bucket as violations rather than trying to compare
 * them.
 */

import type { Corpus, FixtureQuery, QueryFamily, QuestionType } from './corpus.ts';
import type { EmbeddingIndex } from './embeddings.ts';
import { QUERY_FAMILIES, QUESTION_TYPES } from './fixtures/types.ts';
import { dilutionHitAt, duplicateOccupancyAt, hitAt, ndcgAt } from './metrics.ts';

/** R6's cutoff for the ranking floor. */
export const NDCG_CUTOFF = 10;

/**
 * The most results a ranker may return. A return policy is part of R5's stack;
 * more immediately, an unbounded list lets a degenerate ranker return the whole
 * corpus and makes some diagnostics meaningless.
 */
export const RESULT_LIMIT = 50;

export interface RankerContext {
  readonly corpus: Corpus;
  readonly embeddings: EmbeddingIndex;
}

/**
 * What U5 implements and what the baselines implement, identically.
 *
 * A ranker receives the query — including its grant — and the whole corpus. It
 * returns chunk ids, best first. Honouring the grant is its job.
 */
export interface Ranker {
  readonly name: string;
  readonly description: string;
  rank(query: FixtureQuery, context: RankerContext): readonly string[];
}

export interface Bucket {
  readonly count: number;
  /** NaN when `count` is 0. Deliberately not 0 and deliberately not 1. */
  readonly ndcg10: number;
  readonly hit1: number;
  readonly hit3: number;
}

export interface FamilyBucket extends Bucket {
  /** Only meaningful for the dilution family; NaN elsewhere, and never a default. */
  readonly dilutionHit3: number;
  /** Diagnostic: how much of the top 3 was spent on repeats. NaN when count is 0. */
  readonly duplicateOccupancy3: number;
}

export interface Violation {
  readonly queryId: string;
  readonly kind: 'fence' | 'visibility' | 'unknown_chunk';
  readonly chunkId: string;
  readonly detail: string;
}

export interface EvalReport {
  readonly ranker: string;
  readonly queryCount: number;
  readonly aggregate: Bucket;
  readonly byType: Readonly<Record<QuestionType, Bucket>>;
  readonly byFamily: Readonly<Record<QueryFamily, FamilyBucket>>;
  /** Empty is the only acceptable value at the gate. */
  readonly violations: readonly Violation[];
  /** Binds a report to the exact vectors it was produced against. */
  readonly embeddingManifestDigest: string;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

interface Scored {
  readonly ndcg10: number;
  readonly hit1: number;
  readonly hit3: number;
  readonly dilutionHit3: number | undefined;
  readonly duplicateOccupancy3: number;
}

/**
 * Score one query.
 *
 * A violation forces every metric on that query to 0. Two reasons, and the
 * second is the load-bearing one: a ranker that reached outside its grant did
 * not answer the question it was asked, and — more importantly — a scoring rule
 * that let a leaked chunk earn relevance would make leaking *profitable*.
 */
function scoreQuery(
  query: FixtureQuery,
  ranked: readonly string[],
  corpus: Corpus,
  violations: Violation[],
): Scored {
  if (ranked.length > RESULT_LIMIT) {
    throw new Error(`ranker returned ${ranked.length} results for ${query.id}; the limit is ${RESULT_LIMIT}`);
  }

  const grant = new Set<string>(query.grant);
  let leaked = false;

  for (const chunkId of ranked) {
    const chunk = corpus.chunks.get(chunkId);
    if (chunk === undefined) {
      // Not survivable and not scoreable: an id that is not in the corpus means
      // the ranker and the gold key are talking about different things.
      violations.push({
        queryId: query.id,
        kind: 'unknown_chunk',
        chunkId,
        detail: 'result is not a chunk in this corpus',
      });
      leaked = true;
      continue;
    }
    if (!chunk.live) {
      violations.push({
        queryId: query.id,
        kind: 'visibility',
        chunkId,
        detail: 'result is soft-deleted or quarantined and must never be returned',
      });
      leaked = true;
    } else if (!grant.has(chunk.origin)) {
      violations.push({
        queryId: query.id,
        kind: 'fence',
        chunkId,
        detail: `result origin ${chunk.origin} is outside the query's grant`,
      });
      leaked = true;
    }
  }

  // `relevanceFor` throws for a query with no gold key rather than returning an
  // empty map, so an unauthored gold key cannot become a silent zero.
  const relevance = corpus.relevanceFor(query.id);

  if (leaked) {
    return {
      ndcg10: 0,
      hit1: 0,
      hit3: 0,
      dilutionHit3: query.family === 'dilution' ? 0 : undefined,
      duplicateOccupancy3: ranked.length === 0 ? 0 : duplicateOccupancyAt(ranked, (id) => corpus.groupOf(id), 3),
    };
  }

  const dilution =
    query.family === 'dilution'
      ? dilutionHitAt(ranked, query.requiredGroups ?? [], (id) => corpus.groupOf(id), 3)
      : undefined;

  return {
    ndcg10: ndcgAt(ranked, relevance, NDCG_CUTOFF),
    hit1: hitAt(ranked, query.answers, 1),
    hit3: hitAt(ranked, query.answers, 3),
    dilutionHit3: dilution,
    duplicateOccupancy3: ranked.length === 0 ? 0 : duplicateOccupancyAt(ranked, (id) => corpus.groupOf(id), 3),
  };
}

export function runEval(ranker: Ranker, context: RankerContext): EvalReport {
  const { corpus } = context;
  const violations: Violation[] = [];

  const all: Scored[] = [];
  const byType = new Map<QuestionType, Scored[]>();
  const byFamily = new Map<QueryFamily, Scored[]>();
  for (const type of QUESTION_TYPES) byType.set(type, []);
  for (const family of QUERY_FAMILIES) byFamily.set(family, []);

  for (const query of corpus.queries) {
    const ranked = ranker.rank(query, context);
    const scored = scoreQuery(query, ranked, corpus, violations);
    all.push(scored);
    byType.get(query.type)?.push(scored);
    byFamily.get(query.family)?.push(scored);
  }

  // Every query must have been scored exactly once. A ranker cannot cause this
  // to fail, but a future edit to the loop can, and a report over a subset of
  // the corpus is a report that reads as a measurement.
  if (all.length !== corpus.queries.length) {
    throw new Error(`scored ${all.length} of ${corpus.queries.length} queries; a partial run is not a measurement`);
  }

  const bucketOf = (scores: readonly Scored[]): Bucket => ({
    count: scores.length,
    ndcg10: mean(scores.map((score) => score.ndcg10)),
    hit1: mean(scores.map((score) => score.hit1)),
    hit3: mean(scores.map((score) => score.hit3)),
  });

  const familyBucketOf = (scores: readonly Scored[]): FamilyBucket => {
    const dilutionScores = scores
      .map((score) => score.dilutionHit3)
      .filter((value): value is number => value !== undefined);
    return {
      ...bucketOf(scores),
      // NaN when this family has no dilution queries, which is every family but
      // one. `gates.ts` only reads it where a floor asks for it.
      dilutionHit3: mean(dilutionScores),
      duplicateOccupancy3: mean(scores.map((score) => score.duplicateOccupancy3)),
    };
  };

  const typeReport = {} as Record<QuestionType, Bucket>;
  for (const type of QUESTION_TYPES) typeReport[type] = bucketOf(byType.get(type) ?? []);

  const familyReport = {} as Record<QueryFamily, FamilyBucket>;
  for (const family of QUERY_FAMILIES) familyReport[family] = familyBucketOf(byFamily.get(family) ?? []);

  return {
    ranker: ranker.name,
    queryCount: all.length,
    aggregate: bucketOf(all),
    byType: typeReport,
    byFamily: familyReport,
    violations,
    embeddingManifestDigest: context.embeddings.manifestDigest,
  };
}
