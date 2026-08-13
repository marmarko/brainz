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
 *
 * **The seeding itself moved to `evals/seed-tenant.ts`** when U11 needed the same
 * corpus in the same database to measure a consolidation cycle against. It is
 * the same statements, called from both places: a second seeder written for the
 * second question would be a second definition of "the corpus in a database",
 * and the one that drifted would be the one nobody was watching.
 */

import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import type { SQL } from 'bun';

import { CORPUS, CORPUS_INPUT, corpusTexts } from '../../evals/corpus.ts';
import { loadEmbeddings } from '../../evals/embeddings.ts';
import { MANIFEST_PATH } from '../../evals/regenerate-embeddings.ts';
import { pgTextArray, seedCorpus } from '../../evals/seed-tenant.ts';
import { connect, dropFixtureDatabase, provisionFixture, type SchemaFixture } from '../schema/fixture.ts';

const manifest = await Bun.file(MANIFEST_PATH).text();
const embeddings = loadEmbeddings(manifest, corpusTexts(CORPUS));

let fixture: SchemaFixture;
let sql: SQL;

beforeAll(async () => {
  fixture = await provisionFixture('evalcorpus');
  sql = connect(fixture);
  await seedCorpus(sql, CORPUS, {
    index: embeddings,
    contradictions: CORPUS_INPUT.contradictions,
  });
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
