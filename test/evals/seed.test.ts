/**
 * The whole fixture corpus, loaded into a real tenant database.
 *
 * **This is the check that cannot go stale.** `evals/corpus.ts` validates the
 * fixture against unions and regexes copied out of the tenant DDL, and a copy
 * drifts. The database does not: it holds the actual CHECK constraints, the
 * actual foreign keys, the actual deferred involution trigger on `edge_type`,
 * the actual `assert_origin_union` trigger on `fact_source`, and the actual
 * `NOT NULL` on `fact.embedding`. Seeding the corpus exercises every one of them
 * at once, so a fixture that has quietly drifted from the schema fails here
 * rather than on the day U5 first tries to use it.
 *
 * It also settles a question the corpus half would otherwise leave open: **can
 * this corpus be seeded at all?** A gold answer key over a corpus that no
 * tenant database will accept is not a measurement apparatus.
 *
 * Not gated behind a flag. The pgvector service container is always present in
 * the blocking tier, exactly as `test/schema/` and `test/hazards/` assume, and a
 * guard that skips itself is the unguarded state wearing a green tick.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import type { SQL } from 'bun';

import { CORPUS, corpusTexts } from '../../evals/corpus.ts';
import { loadEmbeddings } from '../../evals/embeddings.ts';
import { MANIFEST_PATH } from '../../evals/regenerate-embeddings.ts';
import { connect, dropFixtureDatabase, provisionFixture, type SchemaFixture } from '../schema/fixture.ts';

const manifest = await Bun.file(MANIFEST_PATH).text();
const embeddings = loadEmbeddings(manifest, corpusTexts(CORPUS));

let fixture: SchemaFixture;
let sql: SQL;

/** pgvector's text input form. The committed floats go in exactly as committed. */
function vectorLiteral(id: string): string {
  return `[${Array.from(embeddings.get(id, 'document')).join(',')}]`;
}

/**
 * A Postgres `text[]` literal, bound as text and cast in SQL.
 *
 * Bun binds a JS array as a comma-joined string, which `array_in` rejects. The
 * `$N::text[]` form is the same shape the repository's JSONB rule prescribes for
 * the positional path: bind as text, let the cast parse it.
 */
function pgTextArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;
}

/** A fact inherits the union of its source chunks' origins — R15, enforced by trigger. */
function originUnionFor(sourceChunks: readonly string[]): string[] {
  const origins = new Set<string>();
  for (const chunkId of sourceChunks) {
    const chunk = CORPUS.chunks.get(chunkId);
    if (chunk === undefined) throw new Error(`fact sources missing chunk ${chunkId}`);
    origins.add(chunk.origin);
  }
  return [...origins].sort();
}

beforeAll(async () => {
  fixture = await provisionFixture('evalcorpus');
  sql = connect(fixture);

  const pageIds = new Map<string, number>();
  for (const page of CORPUS.pages.values()) {
    const [row] = await sql`
      INSERT INTO page (
        origin_context, source_type, title, embedding_model, embedding_dimensions,
        chunker_version, normalizer_version, content_sha256, created_at, deleted_at, quarantined_at
      ) VALUES (
        ${page.origin}, ${page.sourceType}, ${page.title}, 'synthetic-lexical-v1', 1536,
        1, 1, ${new Bun.CryptoHasher('sha256').update(page.paragraphs.join('\n\n')).digest('hex')},
        ${page.createdAt}, ${page.deletedAt ?? null}, ${page.quarantinedAt ?? null}
      ) RETURNING page_id`;
    if (row === undefined) throw new Error(`page ${page.id} did not insert`);
    pageIds.set(page.id, Number(row.page_id));
  }

  const chunkIds = new Map<string, number>();
  for (const chunkId of CORPUS.chunkIds) {
    const chunk = CORPUS.chunks.get(chunkId);
    if (chunk === undefined) throw new Error(`chunk ${chunkId} vanished`);
    const pageId = pageIds.get(chunk.pageId);
    if (pageId === undefined) throw new Error(`chunk ${chunkId} has no page row`);
    const page = CORPUS.pages.get(chunk.pageId);
    const [row] = await sql`
      INSERT INTO chunk (origin_context, content, embedding, page_id, ordinal, created_at, deleted_at, quarantined_at)
      VALUES (
        ${chunk.origin}, ${chunk.content}, ${vectorLiteral(chunkId)}::vector, ${pageId}, ${chunk.ordinal},
        ${chunk.createdAt}, ${page?.deletedAt ?? null}, ${page?.quarantinedAt ?? null}
      ) RETURNING chunk_id`;
    if (row === undefined) throw new Error(`chunk ${chunkId} did not insert`);
    chunkIds.set(chunkId, Number(row.chunk_id));
  }

  const entityIds = new Map<string, number>();
  for (const entity of CORPUS.entities.values()) {
    const [row] = await sql`
      INSERT INTO entity (canonical_name, entity_type, origin_contexts)
      VALUES (${entity.canonicalName}, ${entity.type}, ${pgTextArray(entity.origins)}::text[])
      RETURNING entity_id`;
    if (row === undefined) throw new Error(`entity ${entity.id} did not insert`);
    const entityId = Number(row.entity_id);
    entityIds.set(entity.id, entityId);

    await sql`INSERT INTO entity_slug (slug, entity_id, kind) VALUES (${entity.id}, ${entityId}, 'canonical')`;
    for (const alias of entity.aliases) {
      await sql`
        INSERT INTO entity_alias (entity_id, alias, alias_source, confidence)
        VALUES (${entityId}, ${alias.alias}, ${alias.source}, ${alias.confidence ?? null})`;
    }
  }

  // The base vocabulary is seeded by the migration; the corpus adds the ones it
  // needs. Inserted as involutive pairs in one statement because the trigger
  // that checks the involution is DEFERRABLE INITIALLY DEFERRED — neither half
  // can be complete before the other exists.
  await sql.begin(async (tx: SQL) => {
    const existing = await tx`SELECT edge_type FROM edge_type`;
    const have = new Set(existing.map((row: { edge_type: string }) => row.edge_type));
    for (const edgeType of CORPUS.edgeTypes.values()) {
      if (have.has(edgeType.type)) continue;
      await tx`
        INSERT INTO edge_type (edge_type, inverse_type, description)
        VALUES (${edgeType.type}, ${edgeType.inverse}, ${edgeType.description})`;
    }
  });

  const factIds = new Map<string, number>();
  // Facts first without supersession, then the back-references, because a fact
  // cannot point at a successor that does not exist yet.
  await sql.begin(async (tx: SQL) => {
    for (const fact of CORPUS.facts.values()) {
      const [row] = await tx`
        INSERT INTO fact (statement, embedding, origin_contexts, created_at)
        VALUES (
          ${fact.statement}, ${vectorLiteral(fact.id)}::vector,
          ${pgTextArray(originUnionFor(fact.sourceChunks))}::text[], ${fact.validFrom}
        ) RETURNING fact_id`;
      if (row === undefined) throw new Error(`fact ${fact.id} did not insert`);
      factIds.set(fact.id, Number(row.fact_id));
    }
    for (const fact of CORPUS.facts.values()) {
      for (const chunkId of fact.sourceChunks) {
        await tx`
          INSERT INTO fact_source (fact_id, chunk_id)
          VALUES (${factIds.get(fact.id)!}, ${chunkIds.get(chunkId)!})`;
      }
    }
  });

  for (const fact of CORPUS.facts.values()) {
    if (fact.supersededBy === undefined) continue;
    await sql`
      UPDATE fact SET superseded_by = ${factIds.get(fact.supersededBy)!}
      WHERE fact_id = ${factIds.get(fact.id)!}`;
  }

  for (const edge of CORPUS.edges) {
    // R15's union rule for an edge is stricter than for a fact, and the database
    // is where that was discovered rather than assumed: a trigger requires the
    // edge to carry the origins of BOTH entities it connects, not just those of
    // the chunks its supporting facts came from. An edge is a claim about two
    // things, so it inherits from two things.
    const origins = new Set<string>();
    for (const entityId of [edge.subject, edge.object]) {
      const entity = CORPUS.entities.get(entityId);
      if (entity === undefined) throw new Error(`edge names missing entity ${entityId}`);
      for (const origin of entity.origins) origins.add(origin);
    }
    for (const factId of edge.factIds) {
      const fact = CORPUS.facts.get(factId);
      if (fact === undefined) throw new Error(`edge cites missing fact ${factId}`);
      for (const origin of originUnionFor(fact.sourceChunks)) origins.add(origin);
    }
    await sql`
      INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
      VALUES (
        ${entityIds.get(edge.subject)!}, ${edge.type}, ${entityIds.get(edge.object)!},
        ${pgTextArray([...origins].sort())}::text[]
      )`;
  }

  await sql`
    INSERT INTO contradiction_report (left_fact_id, right_fact_id, kind, origin_contexts)
    VALUES (
      ${factIds.get('f-series-a-amount-memo')!}, ${factIds.get('f-series-a-amount-recap')!},
      'value_conflict',
      ${pgTextArray(
        [
          ...new Set([
            ...originUnionFor(CORPUS.facts.get('f-series-a-amount-memo')!.sourceChunks),
            ...originUnionFor(CORPUS.facts.get('f-series-a-amount-recap')!.sourceChunks),
          ]),
        ].sort(),
      )}::text[]
    )`;
}, 120_000);

afterAll(async () => {
  await sql?.close();
  if (fixture !== undefined) await dropFixtureDatabase(fixture);
});

describe('the corpus in a real tenant database', () => {
  test('every page, chunk, entity, fact and edge round-trips', async () => {
    const [pages] = await sql`SELECT count(*)::int AS n FROM page`;
    const [chunks] = await sql`SELECT count(*)::int AS n FROM chunk`;
    const [entities] = await sql`SELECT count(*)::int AS n FROM entity`;
    const [facts] = await sql`SELECT count(*)::int AS n FROM fact`;
    const [edges] = await sql`SELECT count(*)::int AS n FROM entity_edge`;

    expect(pages?.n).toBe(CORPUS.pages.size);
    expect(chunks?.n).toBe(CORPUS.chunks.size);
    expect(entities?.n).toBe(CORPUS.entities.size);
    expect(facts?.n).toBe(CORPUS.facts.size);
    expect(edges?.n).toBe(CORPUS.edges.length);
  });

  test('the committed vectors survive the round trip at full width', async () => {
    const [row] = await sql`
      SELECT vector_dims(embedding) AS dims FROM chunk WHERE embedding IS NOT NULL LIMIT 1`;
    expect(row?.dims).toBe(1536);
    const [unembedded] = await sql`SELECT count(*)::int AS n FROM chunk WHERE embedding IS NULL`;
    expect(unembedded?.n).toBe(0);
  });

  test('the visibility predicates the harness models are the database\'s own', async () => {
    const [invisible] = await sql`
      SELECT count(*)::int AS n FROM chunk WHERE deleted_at IS NOT NULL OR quarantined_at IS NOT NULL`;
    const expected = [...CORPUS.chunks.values()].filter((chunk) => !chunk.live).length;
    expect(invisible?.n).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  test('a live read under one grant returns what visibleTo returns', async () => {
    const rows = await sql`
      SELECT count(*)::int AS n FROM chunk
      WHERE origin_context = ANY(${pgTextArray(['work:mail'])}::text[])
        AND deleted_at IS NULL AND quarantined_at IS NULL`;
    expect(rows[0]?.n).toBe(CORPUS.visibleTo(['work:mail']).length);
  });

  test('the supersession chains land as real foreign keys', async () => {
    const [row] = await sql`SELECT count(*)::int AS n FROM fact WHERE superseded_by IS NOT NULL`;
    const expected = [...CORPUS.facts.values()].filter((fact) => fact.supersededBy !== undefined).length;
    expect(row?.n).toBe(expected);
  });

  test('the contradiction is recorded, open, and unresolved', async () => {
    const [row] = await sql`
      SELECT kind, status, resolution FROM contradiction_report LIMIT 1`;
    expect(row?.kind).toBe('value_conflict');
    expect(row?.status).toBe('open');
    expect(row?.resolution).toBeNull();
  });

  test('every corpus edge type is involutive in the database, not just in the fixture', async () => {
    const rows = await sql`
      SELECT e.edge_type, e.inverse_type, i.inverse_type AS round_trip
      FROM edge_type e JOIN edge_type i ON i.edge_type = e.inverse_type`;
    for (const row of rows) {
      expect(row.round_trip).toBe(row.edge_type);
    }
    expect(rows.length).toBeGreaterThanOrEqual(CORPUS.edgeTypes.size);
  });

  test('the full-text index the keyword arm will read is populated', async () => {
    const [row] = await sql`SELECT count(*)::int AS n FROM chunk WHERE content_tsv IS NOT NULL`;
    expect(row?.n).toBe(CORPUS.chunks.size);
  });
});
