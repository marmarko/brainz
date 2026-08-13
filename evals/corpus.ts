/**
 * The corpus loader, which is really the corpus's validator.
 *
 * **This file exists because the failure it prevents is silent.** A gold key
 * that points at a chunk which no longer exists, a query whose answer is
 * soft-deleted, a dilution probe whose required duplicate group has no visible
 * member under the grant the query is asked with — none of those produce an
 * error at run time. They produce a *score*: the query quietly becomes
 * unanswerable, the ranker "misses" it forever, and the floor it belongs to is
 * measuring the fixture rather than the stack. R6a's upper bound is the receipt
 * that catches this class, and every check below is what makes that receipt
 * mechanical rather than a promise.
 *
 * **Everything is checked in both directions**, the way
 * `test/hazards/registry-consistency.test.ts` checks the hazard ledger: every
 * query resolves to corpus rows, and every corpus row a query names exists. A
 * one-directional check is the fail-open shape — it catches the dangling
 * reference and misses the orphan.
 *
 * **Nothing here is lenient.** There is no "skip the malformed row and carry
 * on", no default for a missing field, and no branch that returns a partial
 * corpus. `buildCorpus` either returns a corpus in which every invariant holds
 * or it throws, and it throws before any caller has seen a value it could use.
 * The exported {@link CORPUS} is built at module load, so an invalid fixture
 * fails the import rather than the assertion.
 */

import { createHash } from 'node:crypto';

import {
  CONTRADICTIONS,
  EDGES,
  EDGE_TYPES,
  ENTITIES,
  FACTS,
  PAGES,
} from './fixtures/brain.ts';
import { QUERIES } from './fixtures/queries.ts';
import {
  ENTITY_TYPES,
  ORIGIN_CONTEXTS,
  QUERY_FAMILIES,
  QUESTION_TYPES,
  SOURCE_TYPES,
  type FixtureEdge,
  type FixtureEdgeType,
  type FixtureEntity,
  type FixtureFact,
  type FixturePage,
  type FixtureQuery,
  type OriginContext,
  type QueryFamily,
  type QuestionType,
  type SourceType,
} from './fixtures/types.ts';

/** The slug rule from `entity_slug_is_a_slug`, copied rather than approximated. */
const SLUG = /^[a-z0-9][a-z0-9-]{0,127}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A chunk as the retrieval arms see it: content, origin, and whether it is live. */
export interface Chunk {
  readonly id: string;
  readonly pageId: string;
  readonly ordinal: number;
  readonly content: string;
  readonly title: string;
  readonly origin: OriginContext;
  readonly sourceType: SourceType;
  readonly createdAt: string;
  readonly dupGroup: string | undefined;
  /**
   * False when the page is soft-deleted (R12) or junk-quarantined (U9).
   * A ranker returning one of these has committed a visibility violation, which
   * the harness treats as a hard failure rather than as a lower score.
   */
  readonly live: boolean;
}

export interface Corpus {
  readonly pages: ReadonlyMap<string, FixturePage>;
  readonly chunks: ReadonlyMap<string, Chunk>;
  /** Insertion-ordered, so any iteration over the corpus is deterministic. */
  readonly chunkIds: readonly string[];
  readonly entities: ReadonlyMap<string, FixtureEntity>;
  readonly edgeTypes: ReadonlyMap<string, FixtureEdgeType>;
  readonly edges: readonly FixtureEdge[];
  readonly facts: ReadonlyMap<string, FixtureFact>;
  readonly queries: readonly FixtureQuery[];
  readonly queriesById: ReadonlyMap<string, FixtureQuery>;
  /** chunkId → duplicate group, or undefined. The dilution metric reads this. */
  groupOf(chunkId: string): string | undefined;
  /** The graded gold key for a query: answers at grade 3, plus the supporting grades. */
  relevanceFor(queryId: string): ReadonlyMap<string, number>;
  /** Chunks a credential holding `grant` may see, in corpus order. */
  visibleTo(grant: readonly OriginContext[]): readonly string[];
}

export interface CorpusInput {
  readonly pages: readonly FixturePage[];
  readonly entities: readonly FixtureEntity[];
  readonly edgeTypes: readonly FixtureEdgeType[];
  readonly edges: readonly FixtureEdge[];
  readonly facts: readonly FixtureFact[];
  readonly queries: readonly FixtureQuery[];
  readonly contradictions: readonly { readonly id: string; readonly left: string; readonly right: string }[];
}

function fail(message: string): never {
  throw new Error(`fixture corpus is invalid: ${message}`);
}

function chunkIdFor(pageId: string, ordinal: number): string {
  return `${pageId}#${ordinal}`;
}

/**
 * Build and validate. Exported separately from {@link CORPUS} so the guard tests
 * can hand it a deliberately broken corpus and watch it throw — a validator
 * that is only ever called on valid input has never been shown to reject
 * anything.
 */
export function buildCorpus(input: CorpusInput): Corpus {
  const originSet = new Set<string>(ORIGIN_CONTEXTS);
  const sourceTypeSet = new Set<string>(SOURCE_TYPES);
  const entityTypeSet = new Set<string>(ENTITY_TYPES);
  const questionTypeSet = new Set<string>(QUESTION_TYPES);
  const familySet = new Set<string>(QUERY_FAMILIES);

  // ---- pages and chunks --------------------------------------------------
  const pages = new Map<string, FixturePage>();
  const chunks = new Map<string, Chunk>();
  const chunkIds: string[] = [];
  const dupGroupMembers = new Map<string, string[]>();

  for (const page of input.pages) {
    if (pages.has(page.id)) fail(`page ${page.id} is declared twice`);
    if (!/^p-[a-z0-9-]+$/.test(page.id)) fail(`page id ${page.id} is not of the form p-<slug>`);
    if (!sourceTypeSet.has(page.sourceType)) fail(`page ${page.id} has unknown source_type ${page.sourceType}`);
    if (!originSet.has(page.origin)) fail(`page ${page.id} has unknown origin_context ${page.origin}`);
    if (!ISO_DATE.test(page.createdAt)) fail(`page ${page.id} has a non-ISO createdAt ${page.createdAt}`);
    if (page.title.trim().length === 0) fail(`page ${page.id} has an empty title`);
    if (page.paragraphs.length === 0) fail(`page ${page.id} has no paragraphs, so it produces no chunks`);

    pages.set(page.id, page);

    const live = page.deletedAt === undefined && page.quarantinedAt === undefined;
    page.paragraphs.forEach((content, ordinal) => {
      if (content.trim().length === 0) fail(`page ${page.id} paragraph ${ordinal} is empty`);
      const id = chunkIdFor(page.id, ordinal);
      chunks.set(id, {
        id,
        pageId: page.id,
        ordinal,
        content,
        title: page.title,
        origin: page.origin,
        sourceType: page.sourceType,
        createdAt: page.createdAt,
        dupGroup: page.dupGroup,
        live,
      });
      chunkIds.push(id);
      if (page.dupGroup !== undefined) {
        const members = dupGroupMembers.get(page.dupGroup) ?? [];
        members.push(id);
        dupGroupMembers.set(page.dupGroup, members);
      }
    });
  }

  if (chunks.size === 0) fail('corpus has no chunks at all');

  // ---- entities ----------------------------------------------------------
  const entities = new Map<string, FixtureEntity>();
  for (const entity of input.entities) {
    if (entities.has(entity.id)) fail(`entity ${entity.id} is declared twice`);
    if (!SLUG.test(entity.id)) fail(`entity id ${entity.id} does not match the tenant schema's slug pattern`);
    if (!entityTypeSet.has(entity.type)) fail(`entity ${entity.id} has unknown entity_type ${entity.type}`);
    if (entity.origins.length === 0) fail(`entity ${entity.id} has an empty origin set, which the schema forbids`);
    for (const origin of entity.origins) {
      if (!originSet.has(origin)) fail(`entity ${entity.id} names unknown origin ${origin}`);
    }
    const aliasSeen = new Set<string>();
    for (const alias of entity.aliases) {
      if (alias.alias.trim().length === 0) fail(`entity ${entity.id} has an empty alias`);
      if (aliasSeen.has(alias.alias)) fail(`entity ${entity.id} declares alias ${alias.alias} twice`);
      aliasSeen.add(alias.alias);
      // Mirrors `entity_alias_inferred_is_scored`: an inference with no
      // confidence is an assertion wearing an inference's clothes.
      if (alias.source === 'inferred' && (alias.confidence === undefined || alias.confidence < 0 || alias.confidence > 1)) {
        fail(`entity ${entity.id} has an inferred alias ${alias.alias} with no usable confidence`);
      }
      if (alias.source === 'user' && alias.confidence !== undefined) {
        fail(`entity ${entity.id} scores a user-declared alias ${alias.alias}; a declaration is not an inference`);
      }
    }
    entities.set(entity.id, entity);
  }

  // ---- edge types, and the involution the schema enforces ----------------
  const edgeTypes = new Map<string, FixtureEdgeType>();
  for (const edgeType of input.edgeTypes) {
    if (edgeTypes.has(edgeType.type)) fail(`edge type ${edgeType.type} is declared twice`);
    edgeTypes.set(edgeType.type, edgeType);
  }
  for (const edgeType of edgeTypes.values()) {
    const inverse = edgeTypes.get(edgeType.inverse);
    if (inverse === undefined) fail(`edge type ${edgeType.type} names undeclared inverse ${edgeType.inverse}`);
    // `invested_in → has_investor → mentions` is a traversal that silently
    // changes meaning. The pair must be an involution or the graph arm walks
    // into a different relationship without noticing.
    if (inverse.inverse !== edgeType.type) {
      fail(`edge types ${edgeType.type} and ${edgeType.inverse} are not involutive`);
    }
  }

  // ---- facts -------------------------------------------------------------
  const facts = new Map<string, FixtureFact>();
  for (const fact of input.facts) {
    if (facts.has(fact.id)) fail(`fact ${fact.id} is declared twice`);
    if (fact.sourceChunks.length === 0) fail(`fact ${fact.id} has no source chunks`);
    for (const chunkId of fact.sourceChunks) {
      if (!chunks.has(chunkId)) fail(`fact ${fact.id} sources missing chunk ${chunkId}`);
    }
    if (!ISO_DATE.test(fact.validFrom)) fail(`fact ${fact.id} has a non-ISO validFrom ${fact.validFrom}`);
    facts.set(fact.id, fact);
  }
  for (const fact of facts.values()) {
    if (fact.supersededBy === undefined) continue;
    if (fact.supersededBy === fact.id) fail(`fact ${fact.id} supersedes itself`);
    const successor = facts.get(fact.supersededBy);
    if (successor === undefined) fail(`fact ${fact.id} is superseded by missing fact ${fact.supersededBy}`);
    // A successor that predates what it replaces is a supersession chain that
    // would make the temporal probes unanswerable in the wrong direction.
    if (successor.validFrom < fact.validFrom) {
      fail(`fact ${fact.id} is superseded by ${successor.id}, which is older than it`);
    }
  }

  // ---- edges -------------------------------------------------------------
  const edgeSeen = new Set<string>();
  for (const edge of input.edges) {
    if (!entities.has(edge.subject)) fail(`edge subject ${edge.subject} is not an entity`);
    if (!entities.has(edge.object)) fail(`edge object ${edge.object} is not an entity`);
    if (!edgeTypes.has(edge.type)) fail(`edge type ${edge.type} is not declared`);
    if (edge.subject === edge.object) fail(`edge ${edge.subject}-${edge.type} is a self loop, which the schema forbids`);
    if (edge.factIds.length === 0) fail(`edge ${edge.subject}-${edge.type}-${edge.object} has no supporting fact`);
    for (const factId of edge.factIds) {
      if (!facts.has(factId)) fail(`edge ${edge.subject}-${edge.type}-${edge.object} cites missing fact ${factId}`);
    }
    const key = `${edge.subject}|${edge.type}|${edge.object}`;
    if (edgeSeen.has(key)) fail(`edge ${key} is stated twice`);
    edgeSeen.add(key);
  }

  // ---- contradictions ----------------------------------------------------
  for (const contradiction of input.contradictions) {
    if (!facts.has(contradiction.left)) fail(`contradiction ${contradiction.id} cites missing fact ${contradiction.left}`);
    if (!facts.has(contradiction.right)) fail(`contradiction ${contradiction.id} cites missing fact ${contradiction.right}`);
    if (contradiction.left === contradiction.right) fail(`contradiction ${contradiction.id} cites one fact twice`);
  }

  // ---- queries, gold keys, and answerability -----------------------------
  const queriesById = new Map<string, FixtureQuery>();
  const relevance = new Map<string, ReadonlyMap<string, number>>();
  /** Every chunk any gold key names, for the orphan direction of the check. */
  const goldReferenced = new Set<string>();

  for (const query of input.queries) {
    if (queriesById.has(query.id)) fail(`query ${query.id} is declared twice`);
    if (query.text.trim().length === 0) fail(`query ${query.id} has empty text`);
    if (!questionTypeSet.has(query.type)) fail(`query ${query.id} has unknown type ${query.type}`);
    if (!familySet.has(query.family)) fail(`query ${query.id} has unknown family ${query.family}`);
    if (query.grant.length === 0) fail(`query ${query.id} has an empty grant, so nothing is visible to it`);
    for (const origin of query.grant) {
      if (!originSet.has(origin)) fail(`query ${query.id} grants unknown origin ${origin}`);
    }
    if (new Set(query.grant).size !== query.grant.length) fail(`query ${query.id} repeats an origin in its grant`);
    if (query.mechanisms.length === 0) {
      fail(`query ${query.id} names no mechanism; an unaudited query cannot support the attainability receipt`);
    }
    if (new Set(query.mechanisms).size !== query.mechanisms.length) {
      fail(`query ${query.id} repeats a mechanism`);
    }
    if (query.evidence.trim().length < 40) {
      fail(`query ${query.id} has no substantive answerability note`);
    }
    if (query.answers.length === 0) fail(`query ${query.id} has no answers`);
    if (new Set(query.answers).size !== query.answers.length) fail(`query ${query.id} repeats an answer`);

    const grant = new Set<string>(query.grant);
    const graded = new Map<string, number>();

    for (const answer of query.answers) {
      const chunk = chunks.get(answer);
      if (chunk === undefined) fail(`query ${query.id} answers with missing chunk ${answer}`);
      // The attainability checks. Each of these, left unchecked, turns into a
      // permanent miss that reads as a retrieval failure.
      if (!chunk.live) fail(`query ${query.id} answers with ${answer}, which is deleted or quarantined`);
      if (!grant.has(chunk.origin)) {
        fail(`query ${query.id} answers with ${answer}, whose origin ${chunk.origin} is outside its own grant`);
      }
      graded.set(answer, 3);
      goldReferenced.add(answer);
    }

    for (const [chunkId, grade] of Object.entries(query.supporting ?? {})) {
      const chunk = chunks.get(chunkId);
      if (chunk === undefined) fail(`query ${query.id} grades missing chunk ${chunkId}`);
      if (grade !== 1 && grade !== 2) fail(`query ${query.id} grades ${chunkId} as ${grade}; supporting grades are 1 or 2`);
      if (graded.has(chunkId)) fail(`query ${query.id} grades ${chunkId} both as an answer and as supporting`);
      if (!chunk.live) fail(`query ${query.id} grades ${chunkId}, which is deleted or quarantined`);
      if (!grant.has(chunk.origin)) {
        fail(`query ${query.id} grades ${chunkId}, whose origin ${chunk.origin} is outside its own grant`);
      }
      graded.set(chunkId, grade);
      goldReferenced.add(chunkId);
    }

    // Dilution is a family, and the required groups belong to it and only to it.
    if (query.family === 'dilution') {
      if (query.requiredGroups === undefined || query.requiredGroups.length < 2) {
        fail(`dilution query ${query.id} must require at least two distinct duplicate groups`);
      }
      const groupSeen = new Set<string>();
      for (const group of query.requiredGroups) {
        if (groupSeen.has(group)) fail(`dilution query ${query.id} repeats required group ${group}`);
        groupSeen.add(group);
        const members = dupGroupMembers.get(group);
        if (members === undefined) fail(`dilution query ${query.id} requires unknown duplicate group ${group}`);
        // The group must be reachable *by this query*: visible, live, and one of
        // its members must be in the gold key. A required group with no visible
        // member is a query that can never score 1, forever.
        const reachable = members.filter((id) => {
          const chunk = chunks.get(id);
          return chunk !== undefined && chunk.live && grant.has(chunk.origin);
        });
        if (reachable.length === 0) {
          fail(`dilution query ${query.id} requires group ${group}, which has no live member inside its grant`);
        }
        if (!reachable.some((id) => graded.has(id))) {
          fail(`dilution query ${query.id} requires group ${group} but grades none of its reachable members`);
        }
      }
    } else if (query.requiredGroups !== undefined) {
      fail(`query ${query.id} declares required groups but is not in the dilution family`);
    }

    queriesById.set(query.id, query);
    relevance.set(query.id, graded);
  }

  // ---- the orphan direction ----------------------------------------------
  // A duplicate group nobody probes is dead weight in the corpus, and worse, it
  // is the shape a dilution probe leaves behind when it is deleted: the pages
  // stay, the measurement goes, and nothing says so.
  const probedGroups = new Set<string>();
  for (const query of input.queries) {
    for (const group of query.requiredGroups ?? []) probedGroups.add(group);
  }
  for (const group of dupGroupMembers.keys()) {
    if (!probedGroups.has(group)) fail(`duplicate group ${group} exists in the corpus but no query probes it`);
  }

  // Every invisible page must be invisible on purpose — that is, it must be a
  // strong lexical match for something, or it is just an unused page pretending
  // to be a guard. Checked as "at least one exists in each state", which is the
  // weakest honest form: the harness's violation counter is what proves they bite.
  const hasDeleted = input.pages.some((page) => page.deletedAt !== undefined);
  const hasQuarantined = input.pages.some((page) => page.quarantinedAt !== undefined);
  if (!hasDeleted) fail('corpus has no soft-deleted page, so R12 visibility is never exercised');
  if (!hasQuarantined) fail('corpus has no quarantined page, so the junk gate is never exercised');

  const visibleCache = new Map<string, readonly string[]>();

  return {
    pages,
    chunks,
    chunkIds,
    entities,
    edgeTypes,
    edges: input.edges,
    facts,
    queries: input.queries,
    queriesById,
    groupOf(chunkId: string): string | undefined {
      return chunks.get(chunkId)?.dupGroup;
    },
    relevanceFor(queryId: string): ReadonlyMap<string, number> {
      const graded = relevance.get(queryId);
      // Not a default, not an empty map: a caller asking for a gold key that does
      // not exist is a caller about to score a query that was never authored.
      if (graded === undefined) fail(`no gold key for query ${queryId}`);
      return graded;
    },
    visibleTo(grant: readonly OriginContext[]): readonly string[] {
      if (grant.length === 0) fail('visibility asked for an empty grant');
      const key = [...grant].sort().join('|');
      const cached = visibleCache.get(key);
      if (cached !== undefined) return cached;
      const allowed = new Set<string>(grant);
      const visible = chunkIds.filter((id) => {
        const chunk = chunks.get(id);
        return chunk !== undefined && chunk.live && allowed.has(chunk.origin);
      });
      visibleCache.set(key, visible);
      return visible;
    },
  };
}

/**
 * The corpus itself. Built at import, so an invalid fixture is an import
 * failure rather than a test that happens to notice.
 */
export const CORPUS: Corpus = buildCorpus({
  pages: PAGES,
  entities: ENTITIES,
  edgeTypes: EDGE_TYPES,
  edges: EDGES,
  facts: FACTS,
  queries: QUERIES,
  contradictions: CONTRADICTIONS,
});

/**
 * A stable fingerprint of the corpus, recorded in both R6a receipts.
 *
 * It is what binds a receipt to the fixture it was computed over: edit a page,
 * a query, a gold grade or an edge and the digest moves, the committed receipts
 * no longer match, and `test/evals/receipts.test.ts` goes red. Without it a
 * receipt is a number with no statement about what it measured.
 *
 * Serialised through `JSON.stringify` over the declared field order rather than
 * over the module's exports, so a purely cosmetic edit — reordering imports,
 * reformatting — does not move it, while any change to the data does.
 */
export function corpusDigest(input: CorpusInput): string {
  const canonical = JSON.stringify({
    pages: input.pages,
    entities: input.entities,
    edgeTypes: input.edgeTypes,
    edges: input.edges,
    facts: input.facts,
    queries: input.queries,
    contradictions: input.contradictions,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * The texts every committed vector must be computed from.
 *
 * Deliberately typed structurally rather than by importing the embedding
 * module's `TextSource`: the embedding loader must not reach into the corpus,
 * and the corpus must not reach into the embedding loader, so the bidirectional
 * manifest check has two genuinely independent sides.
 *
 * Chunks get a document encoding. Queries get **both** — the query encoding the
 * vector arm reads, and a document encoding of the same text, which is what
 * U7 step 7's live-parity job needs in order to notice a swapped asymmetric
 * prefix. A tier scoring against committed vectors cannot see that swap; having
 * both encodings on disk is what makes it detectable later.
 */
export function corpusTexts(
  corpus: Corpus,
): ReadonlyMap<string, { kind: 'chunk' | 'query' | 'fact'; text: string }> {
  const texts = new Map<string, { kind: 'chunk' | 'query' | 'fact'; text: string }>();
  for (const id of corpus.chunkIds) {
    const chunk = corpus.chunks.get(id);
    if (chunk === undefined) fail(`chunk ${id} vanished between build and use`);
    texts.set(id, { kind: 'chunk', text: chunk.content });
  }
  for (const query of corpus.queries) {
    texts.set(query.id, { kind: 'query', text: query.text });
  }
  // Facts too, and not as an afterthought: `fact.embedding` is NOT NULL in the
  // tenant schema, because a fact is embedded synchronously on the write path
  // while a chunk is backfilled. A corpus with no fact vectors is a corpus U5
  // cannot seed.
  for (const fact of corpus.facts.values()) {
    texts.set(fact.id, { kind: 'fact', text: fact.statement });
  }
  return texts;
}

/** Convenience for callers that want the raw input shape (the guard tests do). */
export const CORPUS_INPUT: CorpusInput = {
  pages: PAGES,
  entities: ENTITIES,
  edgeTypes: EDGE_TYPES,
  edges: EDGES,
  facts: FACTS,
  queries: QUERIES,
  contradictions: CONTRADICTIONS,
};

/** The committed corpus's fingerprint. Both receipts carry it. */
export const CORPUS_DIGEST: string = corpusDigest(CORPUS_INPUT);

export type { QuestionType, QueryFamily, OriginContext, FixtureQuery };
