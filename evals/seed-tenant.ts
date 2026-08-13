/**
 * The fixture corpus, written into a real tenant database.
 *
 * **Why this is a module rather than a `beforeAll`.** It started life inside
 * `test/evals/seed.test.ts`, whose whole point is that the corpus is checked
 * against the *actual* CHECK constraints, foreign keys and deferred triggers
 * rather than against regexes copied out of the DDL. U11 needs the same corpus
 * in the same database for a different question — whether a free-tier
 * consolidation cycle measurably improves it — and a second seeder written for
 * that question would be a second definition of "the corpus in a database". The
 * two would drift, and the one that drifted would be the one nobody was
 * watching.
 *
 * So the seeding is here and both callers use it. `evals/` is the right home:
 * the corpus is an eval artifact, `src/` may not import from here, and the
 * dependency runs test → evals exactly as it already does for `corpus.ts` and
 * `embeddings.ts`.
 *
 * **Two entry points, because the two callers want different states.**
 * {@link seedCorpus} writes the corpus as it is *defined* — facts, their
 * supersession chains, reconciled edges, the contradiction report. That is a
 * consolidated brain, and it is what the drift guard wants. U11 wants the state
 * *before* consolidation ran, so it takes {@link seedCorpusPagesAndChunks} and
 * derives the rest itself with the consolidation-owned steps left out.
 */

import type { SQL } from 'bun';

import type { Corpus } from './corpus.ts';
import { corpusTexts, type Chunk } from './corpus.ts';
import { loadEmbeddings, type EmbeddingIndex } from './embeddings.ts';
import { MANIFEST_PATH } from './regenerate-embeddings.ts';

/** The committed vectors, read once per process. */
let cached: EmbeddingIndex | undefined;

export async function loadCorpusEmbeddings(corpus: Corpus): Promise<EmbeddingIndex> {
  if (cached === undefined) {
    cached = loadEmbeddings(await Bun.file(MANIFEST_PATH).text(), corpusTexts(corpus));
  }
  return cached;
}

/** pgvector's text input form. The committed floats go in exactly as committed. */
function vectorLiteral(embeddings: EmbeddingIndex, id: string): string {
  return `[${Array.from(embeddings.get(id, 'document')).join(',')}]`;
}

/**
 * A Postgres `text[]` literal, bound as text and cast in SQL.
 *
 * Bun binds a JS array as a comma-joined string, which `array_in` rejects. The
 * `$N::text[]` form is the same shape the repository's JSONB rule prescribes for
 * the positional path: bind as text, let the cast parse it.
 */
export function pgTextArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;
}

/** A fact inherits the union of its source chunks' origins — R15, by trigger. */
export function originUnionFor(corpus: Corpus, sourceChunks: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const chunkId of sourceChunks) {
    const chunk = corpus.chunks.get(chunkId);
    if (chunk === undefined) throw new Error(`fact sources missing chunk ${chunkId}`);
    origins.add(chunk.origin);
  }
  return [...origins].sort();
}

export interface SeededChunk {
  readonly chunkId: string;
  readonly ordinal: number;
  readonly content: string;
  readonly corpusId: string;
}

export interface SeededPages {
  /** Corpus page id → the `page_id` it was written as. */
  readonly pageIds: ReadonlyMap<string, string>;
  /** Corpus chunk id → the `chunk_id` it was written as. */
  readonly chunkIds: ReadonlyMap<string, string>;
  /** Corpus page id → its written chunks, in ordinal order. */
  readonly chunksByPage: ReadonlyMap<string, readonly SeededChunk[]>;
  readonly chunkCount: number;
}

/**
 * Pages and chunks only. Everything a retrieval arm reads, and nothing a
 * consolidation phase produces.
 */
export async function seedCorpusPagesAndChunks(
  sql: SQL,
  corpus: Corpus,
  index?: EmbeddingIndex,
): Promise<SeededPages> {
  const embeddings = index ?? (await loadCorpusEmbeddings(corpus));

  const pageIds = new Map<string, string>();
  for (const page of corpus.pages.values()) {
    const rows = (await sql`
      INSERT INTO page (
        origin_context, source_type, title, embedding_model, embedding_dimensions,
        chunker_version, normalizer_version, content_sha256, created_at, deleted_at, quarantined_at
      ) VALUES (
        ${page.origin}, ${page.sourceType}, ${page.title}, 'synthetic-lexical-v1', 1536,
        1, 1, ${new Bun.CryptoHasher('sha256').update(page.paragraphs.join('\n\n')).digest('hex')},
        ${page.createdAt}, ${page.deletedAt ?? null}, ${page.quarantinedAt ?? null}
      ) RETURNING page_id::text AS page_id`) as Array<{ page_id: string }>;
    const row = rows[0];
    if (row === undefined) throw new Error(`page ${page.id} did not insert`);
    pageIds.set(page.id, row.page_id);
  }

  const chunkIds = new Map<string, string>();
  const chunksByPage = new Map<string, SeededChunk[]>();
  for (const corpusChunkId of corpus.chunkIds) {
    const chunk: Chunk | undefined = corpus.chunks.get(corpusChunkId);
    if (chunk === undefined) throw new Error(`chunk ${corpusChunkId} vanished`);
    const pageId = pageIds.get(chunk.pageId);
    if (pageId === undefined) throw new Error(`chunk ${corpusChunkId} has no page row`);
    const page = corpus.pages.get(chunk.pageId);
    const rows = (await sql`
      INSERT INTO chunk (origin_context, content, embedding, page_id, ordinal, created_at, deleted_at, quarantined_at)
      VALUES (
        ${chunk.origin}, ${chunk.content}, ${vectorLiteral(embeddings, corpusChunkId)}::vector,
        ${pageId}::bigint, ${chunk.ordinal},
        ${chunk.createdAt}, ${page?.deletedAt ?? null}, ${page?.quarantinedAt ?? null}
      ) RETURNING chunk_id::text AS chunk_id`) as Array<{ chunk_id: string }>;
    const row = rows[0];
    if (row === undefined) throw new Error(`chunk ${corpusChunkId} did not insert`);
    chunkIds.set(corpusChunkId, row.chunk_id);

    const bucket = chunksByPage.get(chunk.pageId) ?? [];
    bucket.push({
      chunkId: row.chunk_id,
      ordinal: chunk.ordinal,
      content: chunk.content,
      corpusId: corpusChunkId,
    });
    chunksByPage.set(chunk.pageId, bucket);
  }

  for (const bucket of chunksByPage.values()) bucket.sort((a, b) => a.ordinal - b.ordinal);

  return { pageIds, chunkIds, chunksByPage, chunkCount: chunkIds.size };
}

export interface SeededCorpus extends SeededPages {
  readonly entityIds: ReadonlyMap<string, string>;
  readonly factIds: ReadonlyMap<string, string>;
}

/**
 * The whole corpus, as defined: entities and their two naming primitives, the
 * edge vocabulary it adds, facts with their sources and supersession chains,
 * reconciled edges, and the one contradiction report.
 */
export interface SeedCorpusOptions {
  readonly index?: EmbeddingIndex;
  /**
   * The contradictions to report. Not on {@link Corpus} — the built corpus keeps
   * pages, entities, facts and edges, and the contradiction list stays on the
   * *input*, so a caller that wants them seeded says which ones rather than
   * having this module reach for a particular fixture.
   */
  readonly contradictions?: readonly { readonly left: string; readonly right: string }[];
}

export async function seedCorpus(
  sql: SQL,
  corpus: Corpus,
  options: SeedCorpusOptions = {},
): Promise<SeededCorpus> {
  const index = options.index;
  const embeddings = index ?? (await loadCorpusEmbeddings(corpus));
  const pages = await seedCorpusPagesAndChunks(sql, corpus, embeddings);

  const entityIds = new Map<string, string>();
  for (const entity of corpus.entities.values()) {
    const rows = (await sql`
      INSERT INTO entity (canonical_name, entity_type, origin_contexts)
      VALUES (${entity.canonicalName}, ${entity.type}, ${pgTextArray(entity.origins)}::text[])
      RETURNING entity_id::text AS entity_id`) as Array<{ entity_id: string }>;
    const row = rows[0];
    if (row === undefined) throw new Error(`entity ${entity.id} did not insert`);
    entityIds.set(entity.id, row.entity_id);

    await sql`INSERT INTO entity_slug (slug, entity_id, kind) VALUES (${entity.id}, ${row.entity_id}::bigint, 'canonical')`;
    for (const alias of entity.aliases) {
      await sql`
        INSERT INTO entity_alias (entity_id, alias, alias_source, confidence)
        VALUES (${row.entity_id}::bigint, ${alias.alias}, ${alias.source}, ${alias.confidence ?? null})`;
    }
  }

  // The base vocabulary is seeded by the migration; the corpus adds the ones it
  // needs. Inserted in one transaction because the involution trigger is
  // DEFERRABLE INITIALLY DEFERRED — neither half of a pair can be complete
  // before the other exists.
  await sql.begin(async (tx: SQL) => {
    const existing = (await tx`SELECT edge_type FROM edge_type`) as Array<{ edge_type: string }>;
    const have = new Set(existing.map((row) => row.edge_type));
    for (const edgeType of corpus.edgeTypes.values()) {
      if (have.has(edgeType.type)) continue;
      await tx`
        INSERT INTO edge_type (edge_type, inverse_type, description)
        VALUES (${edgeType.type}, ${edgeType.inverse}, ${edgeType.description})`;
    }
  });

  const factIds = new Map<string, string>();
  await sql.begin(async (tx: SQL) => {
    for (const fact of corpus.facts.values()) {
      const rows = (await tx`
        INSERT INTO fact (statement, embedding, origin_contexts, created_at)
        VALUES (
          ${fact.statement}, ${vectorLiteral(embeddings, fact.id)}::vector,
          ${pgTextArray(originUnionFor(corpus, fact.sourceChunks))}::text[], ${fact.validFrom}
        ) RETURNING fact_id::text AS fact_id`) as Array<{ fact_id: string }>;
      const row = rows[0];
      if (row === undefined) throw new Error(`fact ${fact.id} did not insert`);
      factIds.set(fact.id, row.fact_id);
    }
    for (const fact of corpus.facts.values()) {
      for (const chunkId of fact.sourceChunks) {
        await tx`
          INSERT INTO fact_source (fact_id, chunk_id)
          VALUES (${factIds.get(fact.id)}::bigint, ${pages.chunkIds.get(chunkId)}::bigint)`;
      }
    }
  });

  for (const fact of corpus.facts.values()) {
    if (fact.supersededBy === undefined) continue;
    await sql`
      UPDATE fact SET superseded_by = ${factIds.get(fact.supersededBy)}::bigint
      WHERE fact_id = ${factIds.get(fact.id)}::bigint`;
  }

  for (const edge of corpus.edges) {
    // R15's union rule for an edge is stricter than for a fact, and the database
    // is where that was discovered rather than assumed: a trigger requires the
    // edge to carry the origins of BOTH entities it connects, not just those of
    // the chunks its supporting facts came from.
    const origins = new Set<string>();
    for (const entityId of [edge.subject, edge.object]) {
      const entity = corpus.entities.get(entityId);
      if (entity === undefined) throw new Error(`edge names missing entity ${entityId}`);
      for (const origin of entity.origins) origins.add(origin);
    }
    for (const factId of edge.factIds) {
      const fact = corpus.facts.get(factId);
      if (fact === undefined) throw new Error(`edge cites missing fact ${factId}`);
      for (const origin of originUnionFor(corpus, fact.sourceChunks)) origins.add(origin);
    }
    await sql`
      INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
      VALUES (
        ${entityIds.get(edge.subject)}::bigint, ${edge.type}, ${entityIds.get(edge.object)}::bigint,
        ${pgTextArray([...origins].sort())}::text[]
      )`;
  }

  for (const contradiction of options.contradictions ?? []) {
    const left = corpus.facts.get(contradiction.left);
    const right = corpus.facts.get(contradiction.right);
    if (left === undefined || right === undefined) {
      throw new Error(`contradiction names a missing fact`);
    }
    const origins = [
      ...new Set([
        ...originUnionFor(corpus, left.sourceChunks),
        ...originUnionFor(corpus, right.sourceChunks),
      ]),
    ].sort();
    await sql`
      INSERT INTO contradiction_report (left_fact_id, right_fact_id, kind, origin_contexts)
      VALUES (${factIds.get(contradiction.left)}::bigint, ${factIds.get(contradiction.right)}::bigint,
              'value_conflict', ${pgTextArray(origins)}::text[])`;
  }

  return { ...pages, entityIds, factIds };
}
