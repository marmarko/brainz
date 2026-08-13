/**
 * U5's stack as a U7 `Ranker`. Not a `*.test.ts` file.
 *
 * **This adapter is the reason the accuracy stack is written the way it is.**
 * U7's harness calls `rank(query, context)` — synchronously, over an in-memory
 * corpus, with no database. The production read path calls the same stages over
 * a tenant Postgres. If the stack could only be exercised through the async
 * path, the blocking tier would be grading a second implementation, and the
 * floors would say nothing about what the fleet runs.
 *
 * So what lives here is **only the arms** — recall over the fixture corpus,
 * standing in for the SQL in `src/core/search/arms.ts`. Every stage after them
 * is imported: fusion, the alias ladder, the boosts, the four dedup layers, the
 * return policy, packing, rerank and autocut are the shipped modules, called in
 * the shipped order by the shipped `composeRanking`.
 *
 * **What the arms here are, honestly.** The vector arm is cosine over U7's
 * committed vectors, which are synthetic lexical projections rather than
 * semantic embeddings (`evals/embeddings.ts` says so at length). Under those
 * vectors the vector arm carries lexical recall and nothing else, so the alias,
 * relational and paraphrase probes have to be reached by the alias ladder and
 * the graph arm — which is precisely what makes this a demanding test of the
 * post-retrieval stack rather than a flattering one.
 *
 * **The fence is the ranker's job, not the harness's.** `evals/run.ts` hands
 * every ranker the whole corpus on purpose: a ranker that ignored the grant
 * would score identically to one that honoured it if the harness pre-filtered.
 * So every arm below applies `visibleUnder` itself.
 *
 * **`now` is anchored to the corpus, not to the wall clock.** The recency
 * half-lives differ by source type, so a wall-clock anchor would change
 * cross-class ordering as real time passed and drift the floors out from under a
 * codebase nobody touched.
 */

import type { Chunk, Corpus, FixtureQuery } from '../../../evals/corpus.ts';
import { cosine, tokenize, type EmbeddingIndex } from '../../../evals/embeddings.ts';
import type { Ranker, RankerContext } from '../../../evals/run.ts';
import { RESULT_LIMIT } from '../../../evals/run.ts';
import {
  aliasLadderTiers,
  mentionsIn,
  resolveEntities,
  type EntityRef,
  type LadderLookup,
  type LadderTier,
  type MentionKey,
  type PageRef,
} from '../../../src/core/search/alias-hop.ts';
import { CHANNEL_BY_SOURCE_TYPE } from '../../../src/core/search/arms.ts';
import { visibleUnder } from '../../../src/core/search/fence.ts';
import { classifyIntent, planFor, refinePlan, resolutionOf } from '../../../src/core/search/intent.ts';
import { normalize, tokens } from '../../../src/core/search/normalize.ts';
import { composeRanking } from '../../../src/core/search/pipeline.ts';
import { candidatePoolFor } from '../../../src/schema/vector-query.ts';
import type {
  ArmResult,
  Candidate,
  RecallOutcome,
  SourceType,
} from '../../../src/core/search/types.ts';

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/** How many results the composed stack is asked for. Inside U7's own cap. */
export const RANK_LIMIT = 20;

interface CorpusIndex {
  readonly candidates: ReadonlyMap<string, Candidate>;
  readonly documentFrequency: ReadonlyMap<string, number>;
  readonly lengths: ReadonlyMap<string, number>;
  readonly termFrequencies: ReadonlyMap<string, ReadonlyMap<string, number>>;
  readonly averageLength: number;
  readonly liveCount: number;
  readonly pagesByTitleKey: ReadonlyMap<string, PageRef>;
  readonly pages: readonly PageRef[];
  readonly entities: readonly EntityIndexEntry[];
  readonly dictionary: readonly MentionKey[];
  /**
   * Which entities each chunk names. The alias ladder's mention rung reads it,
   * and so does the graph-adjacency boost — one derivation, because a rung that
   * nominated a page the boost then could not recognise would be two different
   * answers to "does this chunk name the entity".
   */
  readonly mentionsByChunk: ReadonlyMap<string, ReadonlySet<string>>;
  readonly now: Date;
}

interface EntityIndexEntry {
  readonly ref: EntityRef;
  readonly origins: readonly string[];
  /** Canonical name plus every alias, normalized. Longest first. */
  readonly keys: readonly string[];
  /** Chunks evidencing this entity, best first. */
  readonly evidence: readonly string[];
}

const indexes = new WeakMap<Corpus, CorpusIndex>();

function candidateFor(chunk: Chunk): Candidate {
  const sourceType = chunk.sourceType as SourceType;
  const channel = CHANNEL_BY_SOURCE_TYPE[sourceType] ?? 'user_curated';
  return {
    id: chunk.id,
    pageId: chunk.pageId,
    ordinal: chunk.ordinal,
    title: chunk.title,
    content: chunk.content,
    origin: chunk.origin,
    sourceType,
    createdAt: chunk.createdAt,
    live: chunk.live,
    attestations: [
      // The fixture records no per-message sender, so every external row under
      // one credential collapses to one attestation. That is `arms.ts`'s stated
      // fail-closed fallback, reproduced rather than worked around: it can
      // under-count independent origins, never manufacture one.
      channel === 'external' ? { channel, senderKey: `origin:${chunk.origin}` } : { channel },
    ],
    entityIds: [],
  };
}

/**
 * Build every index the arms need, once per corpus.
 *
 * BM25 statistics are computed over every **live** chunk rather than per grant,
 * matching U7's own baselines: per-grant statistics would make a chunk's score
 * depend on who is asking, which turns a ranking comparison into two
 * incomparable rankings.
 */
function indexOf(corpus: Corpus): CorpusIndex {
  const cached = indexes.get(corpus);
  if (cached !== undefined) return cached;

  const documentFrequency = new Map<string, number>();
  const lengths = new Map<string, number>();
  const termFrequencies = new Map<string, ReadonlyMap<string, number>>();
  const candidates = new Map<string, Candidate>();
  const chunksByPage = new Map<string, string[]>();
  const pageTitle = new Map<string, string>();
  let totalLength = 0;
  let liveCount = 0;
  let newest = 0;

  for (const chunkId of corpus.chunkIds) {
    const chunk = corpus.chunks.get(chunkId);
    if (chunk === undefined) continue;
    candidates.set(chunkId, candidateFor(chunk));

    if (!chunk.live) continue;
    const at = Date.parse(chunk.createdAt);
    if (Number.isFinite(at)) newest = Math.max(newest, at);

    (chunksByPage.get(chunk.pageId) ?? chunksByPage.set(chunk.pageId, []).get(chunk.pageId)!).push(chunkId);
    pageTitle.set(chunk.pageId, chunk.title);

    const terms = tokenize(chunk.content);
    const frequencies = new Map<string, number>();
    for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    for (const term of frequencies.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
    termFrequencies.set(chunkId, frequencies);
    lengths.set(chunkId, terms.length);
    totalLength += terms.length;
    liveCount += 1;
  }

  const pages: PageRef[] = [];
  const pagesByTitleKey = new Map<string, PageRef>();
  for (const [pageId, chunkIds] of chunksByPage) {
    const title = pageTitle.get(pageId) ?? null;
    const ref: PageRef = {
      pageId,
      title,
      chunkIds,
      // The page's body, which the mention rung ranks on. The SQL substrate has
      // the same string available as `string_agg(c.content, ' ')` over the
      // page's live chunks — see `arms.ts:pagesMentioningEntity`.
      text: chunkIds.map((id) => candidates.get(id)?.content ?? '').join(' '),
    };
    pages.push(ref);
    if (title !== null) {
      const key = normalize(title);
      // First writer wins, so the mapping is a function of corpus order rather
      // than of iteration order.
      if (!pagesByTitleKey.has(key)) pagesByTitleKey.set(key, ref);
    }
  }

  // One dictionary over every entity's names, so mentions resolve competitively
  // rather than per entity — see `alias-hop.ts:mentionsIn`.
  const dictionary: MentionKey[] = [];
  for (const [entityId, entity] of corpus.entities) {
    for (const name of [entity.canonicalName, ...entity.aliases.map((alias) => alias.alias)]) {
      const key = normalize(name);
      if (key.length > 0) dictionary.push({ key, entityId });
    }
  }

  const entities: EntityIndexEntry[] = [];
  for (const [entityId, entity] of corpus.entities) {
    const keys = [entity.canonicalName, ...entity.aliases.map((alias) => alias.alias)]
      .map((name) => normalize(name))
      .filter((key) => key.length > 0)
      .sort((a, b) => b.length - a.length);

    entities.push({
      ref: { entityId, canonicalName: entity.canonicalName, slug: entityId },
      origins: entity.origins,
      keys,
      evidence: evidenceFor(corpus, entityId, dictionary),
    });
  }

  // Attach the entities each chunk evidences, for the graph-adjacency boost.
  //
  // Two sources, and the second is the one that matters. A chunk is adjacent to
  // an entity if it is the source of a fact about that entity — *or* if it names
  // it. "MV roast contract" resolves Marcus Vandenberg and wants the supplier
  // list's second paragraph, which names him and evidences no fact at all; a
  // fact-sources-only derivation cannot see it. The SQL arm has the same signal
  // available through an alias match on `chunk.content`.
  const mentionsByChunk = new Map<string, Set<string>>();
  for (const [chunkId, candidate] of candidates) {
    mentionsByChunk.set(chunkId, mentionsIn(candidate.content, dictionary));
  }
  // The evidence half is tracked separately: a chunk that is the source of a
  // fact about an entity is a much stronger statement than one that names it,
  // and `boosts.ts` pays them differently.
  const evidenceByChunk = new Map<string, Set<string>>();
  for (const entity of entities) {
    for (const chunkId of entity.evidence) {
      mentionsByChunk.get(chunkId)?.add(entity.ref.entityId);
      (evidenceByChunk.get(chunkId) ?? evidenceByChunk.set(chunkId, new Set()).get(chunkId)!).add(
        entity.ref.entityId,
      );
    }
  }
  for (const [chunkId, entityIds] of mentionsByChunk) {
    const candidate = candidates.get(chunkId);
    if (candidate === undefined || entityIds.size === 0) continue;
    candidates.set(chunkId, {
      ...candidate,
      entityIds: [...entityIds],
      evidenceEntityIds: [...(evidenceByChunk.get(chunkId) ?? [])],
    });
  }

  const index: CorpusIndex = {
    candidates,
    documentFrequency,
    lengths,
    termFrequencies,
    averageLength: liveCount === 0 ? 1 : totalLength / liveCount,
    liveCount,
    pagesByTitleKey,
    pages,
    entities,
    dictionary,
    mentionsByChunk,
    now: new Date(newest === 0 ? Date.UTC(2026, 6, 1) : newest),
  };
  indexes.set(corpus, index);
  return index;
}

/**
 * Chunks that evidence an entity: the source chunks of every fact naming it,
 * current facts before superseded ones, newest first.
 *
 * The ordering mirrors `arms.ts:graphArm`'s `ORDER BY` — a superseded statement
 * is demoted rather than dropped, because it is still the best evidence for a
 * question about the past.
 */
function evidenceFor(corpus: Corpus, entityId: string, dictionary: readonly MentionKey[]): string[] {
  const scored: { chunkId: string; superseded: boolean; at: number }[] = [];

  for (const [, fact] of corpus.facts) {
    // Competitive longest-match, never per-entity containment. `sam` is an alias
    // of Samantha Okonkwo and the first token of "Sam Trelawney works at
    // Northwind Analytics" — a per-entity check attributes a second person's
    // employment to the first, and the ladder then answers "who is Sam" with
    // somebody else's job.
    if (!mentionsIn(fact.statement, dictionary).has(entityId)) continue;
    const at = Date.parse(fact.validFrom);
    for (const chunkId of fact.sourceChunks) {
      const chunk = corpus.chunks.get(chunkId);
      if (chunk === undefined || !chunk.live) continue;
      scored.push({
        chunkId,
        superseded: fact.supersededBy !== undefined,
        at: Number.isFinite(at) ? at : 0,
      });
    }
  }

  scored.sort(
    (a, b) =>
      Number(a.superseded) - Number(b.superseded) ||
      b.at - a.at ||
      (a.chunkId < b.chunkId ? -1 : 1),
  );

  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of scored) {
    if (seen.has(entry.chunkId)) continue;
    seen.add(entry.chunkId);
    out.push(entry.chunkId);
  }
  return out;
}

function ladderLookup(index: CorpusIndex, visible: ReadonlySet<string>): LadderLookup {
  const fenceChunks = (chunkIds: readonly string[]): string[] =>
    chunkIds.filter((id) => visible.has(id));

  const fencePage = (page: PageRef): PageRef | null => {
    const chunkIds = fenceChunks(page.chunkIds);
    return chunkIds.length === 0 ? null : { ...page, chunkIds };
  };

  return {
    pagesByTitle(normalizedQuery) {
      const page = index.pagesByTitleKey.get(normalizedQuery);
      if (page === undefined) return [];
      const fenced = fencePage(page);
      return fenced === null ? [] : [fenced];
    },
    pagesTitledContaining(normalizedQuery) {
      const out: PageRef[] = [];
      for (const page of index.pages) {
        if (page.title === null) continue;
        const key = normalize(page.title);
        if (key === normalizedQuery) continue;
        if (!key.includes(normalizedQuery) && !normalizedQuery.includes(key)) continue;
        const fenced = fencePage(page);
        if (fenced !== null) out.push(fenced);
      }
      return out;
    },
    entitiesByName(normalizedQuery, queryTokens) {
      const tokenSet = new Set(queryTokens);
      const out: { ref: EntityRef; weight: number }[] = [];
      for (const entity of index.entities) {
        // Intersect on origins: an entity is a *name*, and a subset rule would
        // refuse to resolve any entity seen under more than one credential.
        // See `fence.ts` — everything the resolution then reaches is fenced
        // again, on the rows.
        for (const key of entity.keys) {
          const isToken = tokenSet.has(key);
          const isPhrase = key.includes(' ') && normalizedQuery.includes(key);
          if (!isToken && !isPhrase) continue;
          // The key that matched travels with the ref: `intent.ts:resolutionOf`
          // needs it to tell "the query is nothing but a name" from "the query
          // asks about something".
          out.push({ ref: { ...entity.ref, matchedKey: key }, weight: key.length });
          break;
        }
      }
      return out.sort((a, b) => b.weight - a.weight).map((entry) => entry.ref);
    },
    entitiesBySlugSuffix(queryTokens) {
      const wanted = new Set(queryTokens);
      return index.entities
        .filter((entity) => {
          const suffix = entity.ref.slug.split('-').pop() ?? '';
          return suffix.length > 2 && wanted.has(suffix);
        })
        .map((entity) => entity.ref);
    },
    pagesTitled(name) {
      const page = index.pagesByTitleKey.get(normalize(name));
      if (page === undefined) return [];
      const fenced = fencePage(page);
      return fenced === null ? [] : [fenced];
    },
    evidenceFor(entityId) {
      const entity = index.entities.find((entry) => entry.ref.entityId === entityId);
      return entity === undefined ? [] : fenceChunks(entity.evidence);
    },
    pagesMentioning(entityId) {
      const out: PageRef[] = [];
      for (const page of index.pages) {
        if (!page.chunkIds.some((id) => index.mentionsByChunk.get(id)?.has(entityId) === true)) {
          continue;
        }
        const fenced = fencePage(page);
        if (fenced !== null) out.push(fenced);
      }
      return out;
    },
  };
}

function bm25(index: CorpusIndex, visible: readonly string[], query: string, pool: number): string[] {
  const terms = tokenize(query);
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

    // The title at a discount, matching the SQL arm: recall on either field,
    // rank on the body. The ordered-phrase title signal is stage 6's.
    const title = index.candidates.get(chunkId)?.title;
    if (title !== null && title !== undefined) {
      const titleTokens = new Set(tokens(title));
      let hits = 0;
      for (const term of terms) if (titleTokens.has(term)) hits += 1;
      if (hits > 0) score += 0.4 * hits;
    }

    if (score > 0) scored.push({ id: chunkId, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, pool)
    .map((entry) => entry.id);
}

function vectorRanking(
  embeddings: EmbeddingIndex,
  queryId: string,
  visible: readonly string[],
  pool: number,
): string[] {
  const queryVector = embeddings.get(queryId, 'query');
  return visible
    .map((id) => ({ id, score: cosine(queryVector, embeddings.get(id, 'document')) }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))
    .slice(0, pool)
    .map((entry) => entry.id);
}

/**
 * The graph arm: from resolved entities out along typed edges to the chunks that
 * evidence them.
 *
 * Mirrors `arms.ts:graphArm` — edge evidence first (the answer to "who invested
 * in X" is the row that states the investment), then the seed's own facts.
 * Edges are fenced by subset on their origins, which is `fence.ts:fenceRow`.
 */
function graphRanking(
  corpus: Corpus,
  index: CorpusIndex,
  seeds: readonly EntityRef[],
  grant: ReadonlySet<string>,
  visible: ReadonlySet<string>,
  seedFirst: boolean,
  relations: readonly string[],
): string[] {
  if (seeds.length === 0) return [];
  const seedIds = new Set(seeds.map((seed) => seed.entityId));

  // The neighbourhood: entities one typed edge from a seed. The edge is fenced
  // by subset on the origins of the facts that produced it — `fence.ts:fenceRow`.
  const neighbours = new Set<string>();
  // Facts that evidence an edge of the type the question asked about. "Where
  // does Sam work" and "who does Sam work with" fan out over the same
  // neighbourhood; `works_at` versus `collaborates_with` is what separates them.
  const preferredFacts = new Set<string>();
  const wanted = new Set(relations);
  for (const edge of corpus.edges) {
    if (!seedIds.has(edge.subject) && !seedIds.has(edge.object)) continue;

    const factOrigins = new Set<string>();
    for (const factId of edge.factIds) {
      const fact = corpus.facts.get(factId);
      if (fact === undefined) continue;
      for (const chunkId of fact.sourceChunks) {
        const chunk = corpus.chunks.get(chunkId);
        if (chunk !== undefined) factOrigins.add(chunk.origin);
      }
    }
    if (factOrigins.size === 0) continue;
    let allowed = true;
    for (const origin of factOrigins) if (!grant.has(origin)) allowed = false;
    if (!allowed) continue;

    neighbours.add(edge.subject);
    neighbours.add(edge.object);
    if (wanted.has(edge.type)) for (const factId of edge.factIds) preferredFacts.add(factId);
  }

  const touched = new Map<string, EntityIndexEntry>();
  for (const entity of index.entities) {
    if (seedIds.has(entity.ref.entityId) || neighbours.has(entity.ref.entityId)) {
      touched.set(entity.ref.entityId, entity);
    }
  }

  // Fact-level ranking, mirroring `arms.ts:graphArm`'s ORDER BY exactly:
  // facts naming more than one touched entity first (the answer to "where does
  // Sam work" is the statement naming *both* Sam and the company), then
  // non-superseded, then newest.
  const rows: {
    chunkId: string;
    preferred: boolean;
    namesSeed: boolean;
    multi: boolean;
    superseded: boolean;
    at: number;
  }[] = [];
  for (const [factId, fact] of corpus.facts) {
    const mentioned = mentionsIn(fact.statement, index.dictionary);
    const named = [...mentioned].filter((entityId) => touched.has(entityId));
    if (named.length === 0) continue;

    const at = Date.parse(fact.validFrom);
    const multi = named.length > 1;
    const seedOnly = named.every((entityId) => seedIds.has(entityId));
    for (const chunkId of fact.sourceChunks) {
      if (!visible.has(chunkId)) continue;
      rows.push({
        chunkId,
        preferred: preferredFacts.has(factId),
        // The second hop. A fact naming only a *neighbour* is admitted, below
        // the seed's own — "Marc's shop location" is answered by a statement
        // about Kettle and Quill that never says Marcus, and a fan-out that
        // stops at facts naming the seed cannot reach it. See the header.
        namesSeed: named.some((entityId) => seedIds.has(entityId)),
        // An entity lookup ("who is Sam") wants the seed's own statements first;
        // a relational question wants the statement that spans the edge. Same
        // fan-out, opposite priority — which is the intent plan doing work.
        multi: seedFirst ? seedOnly : multi,
        superseded: fact.supersededBy !== undefined,
        at: Number.isFinite(at) ? at : 0,
      });
    }
  }

  rows.sort(
    (a, b) =>
      Number(b.preferred) - Number(a.preferred) ||
      Number(b.namesSeed) - Number(a.namesSeed) ||
      Number(b.multi) - Number(a.multi) ||
      Number(a.superseded) - Number(b.superseded) ||
      b.at - a.at ||
      (a.chunkId < b.chunkId ? -1 : 1),
  );

  const seen = new Set<string>();
  const ranked: string[] = [];
  for (const row of rows) {
    if (seen.has(row.chunkId)) continue;
    seen.add(row.chunkId);
    ranked.push(row.chunkId);
  }
  return ranked;
}

/**
 * The recall half, over the fixture corpus. Everything after this is the shipped
 * stack.
 */
export function recallOverCorpus(
  query: FixtureQuery,
  context: RankerContext,
  options: { readonly limit: number; readonly withoutVectorArm?: boolean },
): { outcome: RecallOutcome & { plan: ReturnType<typeof planFor> }; now: Date } {
  const { corpus, embeddings } = context;
  const index = indexOf(corpus);
  const grant = new Set<string>(query.grant);
  const visibleIds = corpus.visibleTo(query.grant);
  const visibleSet = new Set(visibleIds);
  const pool = candidatePoolFor({ limit: options.limit });

  const lookup = ladderLookup(index, visibleSet);
  const seeds = resolveEntities(query.text, lookup);
  // Resolution happens before the arms — the graph arm cannot fan out without
  // seeds — so the plan is refined with what resolution found.
  const plan = refinePlan(planFor(classifyIntent(query.text)), resolutionOf(query.text, seeds));
  const ladder = aliasLadderTiers(query.text, lookup, seeds);

  const arms: ArmResult[] = [];
  if (options.withoutVectorArm !== true) {
    arms.push({ arm: 'vector', ranked: vectorRanking(embeddings, query.id, visibleIds, pool) });
  }
  arms.push({ arm: 'fts', ranked: bm25(index, visibleIds, query.text, pool) });
  if (plan.useGraphArm) {
    arms.push({
      arm: 'graph',
      ranked: graphRanking(
        corpus,
        index,
        seeds,
        grant,
        visibleSet,
        plan.intent === 'entity_lookup',
        plan.relations,
      ),
    });
  }

  // Hydrate everything any arm or the ladder produced, then fence it — the same
  // two steps `arms.ts` performs, in the same order.
  const wanted = new Set<string>([
    ...arms.flatMap((arm) => [...arm.ranked]),
    ...ladder.flatMap((tier) => [...tier.ids]),
  ]);
  const hydrated: Candidate[] = [];
  for (const id of wanted) {
    const candidate = index.candidates.get(id);
    if (candidate !== undefined) hydrated.push(candidate);
  }
  const candidates = new Map<string, Candidate>();
  for (const candidate of visibleUnder(hydrated, grant)) candidates.set(candidate.id, candidate);

  return {
    outcome: {
      plan,
      arms,
      candidates,
      aliasLadder: ladder
        .map((tier): LadderTier => ({ ...tier, ids: tier.ids.filter((id) => candidates.has(id)) }))
        .filter((tier) => tier.ids.length > 0),
      resolvedEntityIds: seeds.map((seed) => seed.entityId),
      degraded: options.withoutVectorArm === true ? ['embedding_unavailable'] : [],
    },
    now: index.now,
  };
}

/** U5's composed stack, as a `Ranker` U7's harness can grade. */
export const stackRanker: Ranker = {
  name: 'u5-retrieval-stack',
  description:
    'The composed U5 stack: shared normalizer, intent plan, three arms, RRF, alias ladder, boosts, four-layer dedup, return policy, packing. Rerank and autocut are off (U12).',
  rank(query: FixtureQuery, context: RankerContext): readonly string[] {
    const { outcome, now } = recallOverCorpus(query, context, { limit: RANK_LIMIT });
    const response = composeRanking(
      { query: query.text, limit: Math.min(RANK_LIMIT, RESULT_LIMIT), now, plan: outcome.plan },
      outcome,
    );
    return response.results.map((result) => result.candidate.id);
  },
};

/** The same stack with the vector arm dropped — Assumption 5's degraded read. */
export const degradedStackRanker: Ranker = {
  name: 'u5-retrieval-stack-degraded',
  description: 'The composed stack with the embedding provider unavailable: FTS and graph only.',
  rank(query: FixtureQuery, context: RankerContext): readonly string[] {
    const { outcome, now } = recallOverCorpus(query, context, {
      limit: RANK_LIMIT,
      withoutVectorArm: true,
    });
    const response = composeRanking(
      { query: query.text, limit: Math.min(RANK_LIMIT, RESULT_LIMIT), now, plan: outcome.plan },
      outcome,
    );
    return response.results.map((result) => result.candidate.id);
  },
};
