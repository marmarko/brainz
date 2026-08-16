/**
 * Shared harness for the U5 retrieval suite. Not a `*.test.ts` file.
 *
 * **A real tenant database, through the real applier.** The arms are SQL, and
 * three of the four properties worth guarding about them — the `ef_search` pool
 * sizing (H1), the post-filter yield (H3) and the origin fence — are properties
 * of pgvector and of Postgres, not of TypeScript. A hand-rolled in-memory stand-in
 * would make every one of them pass by construction.
 *
 * **Vectors that mean something, generated the same way U4's write fixture
 * generates them.** Cosine against a zero vector is undefined; a fixture built
 * on one measures pgvector's NaN handling. This is a deterministic lexical
 * projection: texts sharing words land near each other, unrelated texts land
 * near-orthogonal, and every run is identical. It is not a semantic encoder and
 * nothing here pretends otherwise.
 *
 * **The distance ladder is constructed, not sampled.** {@link seedDistanceLadder}
 * writes rows whose embedding is `[1, t, 0, …]` against a query of `[1, 0, …]`,
 * so cosine distance rises monotonically with `t` and "the answer is the 90th
 * nearest row" is a property of the fixture rather than a hope about a draw.
 * That is what lets the pool guard state a rank rather than a similarity.
 */

import { SQL } from 'bun';

import { textArrayLiteral } from '../../../src/core/write/pg-values.ts';
import { ACTIVE_EMBEDDING_SEAT } from '../../../src/schema/embedding-seat.ts';
import { EMBEDDING_DIMENSIONS } from '../../../src/schema/vector-index.ts';
import {
  connect,
  dropFixtureDatabase,
  provisionFixture,
  type SchemaFixture,
} from '../../schema/fixture.ts';

export { EMBEDDING_DIMENSIONS };

/**
 * The column a seeded vector goes in — the active seat's, never the literal
 * `embedding`. A fixture pinned to a column the arm no longer scans seeds rows
 * no read can reach, and every recall assertion built on it measures nothing
 * while staying green.
 */
export const SEAT_COLUMN = ACTIVE_EMBEDDING_SEAT.column;

export interface SearchFixture {
  readonly schema: SchemaFixture;
  readonly sql: SQL;
  close(): Promise<void>;
}

export async function createSearchFixture(slug: string): Promise<SearchFixture> {
  const schema = await provisionFixture(slug);
  const sql = connect(schema);
  return {
    schema,
    sql,
    async close() {
      await sql.close();
      await dropFixtureDatabase(schema);
    },
  };
}

/** The pgvector literal for `[1, t, 0, 0, …]`. */
export function ladderVector(t: number): string {
  return `[1,${t}${',0'.repeat(EMBEDDING_DIMENSIONS - 2)}]`;
}

/** The query the ladder is measured against: `[1, 0, 0, …]`. */
export const LADDER_QUERY: readonly number[] = [1, ...new Array<number>(EMBEDDING_DIMENSIONS - 1).fill(0)];

export interface SeedPage {
  readonly id: string;
  readonly title: string;
  readonly sourceType: string;
  readonly origin: string;
  readonly createdAt: string;
  readonly paragraphs: readonly string[];
  readonly externalRef?: string;
  readonly deleted?: boolean;
  readonly quarantined?: boolean;
  /** `[1, t, 0, …]` per chunk ordinal, when the test cares about vector rank. */
  readonly ladder?: readonly number[];
}

/** Writes a page and its chunks. Returns the chunk ids, in ordinal order. */
export async function seedPage(sql: SQL, page: SeedPage): Promise<string[]> {
  const rows = (await sql`
    INSERT INTO page (origin_context, source_type, title, external_ref, created_at,
                      embedding_model, embedding_dimensions, chunker_version, normalizer_version,
                      content_sha256, deleted_at, quarantined_at)
    VALUES (${page.origin}, ${page.sourceType}, ${page.title}, ${page.externalRef ?? null},
            ${page.createdAt}::timestamptz,
            'fixture-model', ${EMBEDDING_DIMENSIONS}, 1, 1,
            ${'0'.repeat(64)},
            ${page.deleted === true ? new Date().toISOString() : null}::timestamptz,
            ${page.quarantined === true ? new Date().toISOString() : null}::timestamptz)
    RETURNING page_id::text AS page_id
  `) as Array<{ page_id: string }>;
  const pageId = rows[0]?.page_id;
  if (pageId === undefined) throw new Error(`failed to seed page ${page.id}`);

  const chunkIds: string[] = [];
  for (const [ordinal, text] of page.paragraphs.entries()) {
    const t = page.ladder?.[ordinal];
    const inserted = (await sql.unsafe(
      `INSERT INTO chunk (origin_context, content, page_id, ordinal, ${SEAT_COLUMN},
                          deleted_at, quarantined_at)
       VALUES ($1, $2, $3::bigint, $4, $5::vector, $6::timestamptz, $7::timestamptz)
       RETURNING chunk_id::text AS chunk_id`,
      [
        page.origin,
        text,
        pageId,
        ordinal,
        t === undefined ? null : ladderVector(t),
        page.deleted === true ? new Date().toISOString() : null,
        page.quarantined === true ? new Date().toISOString() : null,
      ],
    )) as Array<{ chunk_id: string }>;
    const chunkId = inserted[0]?.chunk_id;
    if (chunkId === undefined) throw new Error(`failed to seed chunk ${page.id}#${ordinal}`);
    chunkIds.push(chunkId);
  }

  return chunkIds;
}

/**
 * Seeds `count` single-chunk pages at monotonically increasing distance.
 *
 * Returns the chunk ids in distance order, so a test can name "the 90th nearest"
 * without computing anything.
 */
export async function seedDistanceLadder(
  sql: SQL,
  options: {
    readonly count: number;
    readonly origin: string;
    readonly prefix?: string;
    readonly step?: number;
  },
): Promise<string[]> {
  const step = options.step ?? 0.01;
  const prefix = options.prefix ?? 'ladder';
  const ids: string[] = [];

  for (let index = 0; index < options.count; index += 1) {
    const [chunkId] = await seedPage(sql, {
      id: `${prefix}-${index}`,
      title: `${prefix} page ${index}`,
      sourceType: 'document',
      origin: options.origin,
      createdAt: '2026-01-01',
      paragraphs: [`${prefix} body ${index} filler text`],
      ladder: [(index + 1) * step],
    });
    if (chunkId === undefined) throw new Error('ladder seed produced no chunk');
    ids.push(chunkId);
  }

  await sql.unsafe('ANALYZE chunk');
  return ids;
}

export interface SeedEntity {
  readonly slug: string;
  readonly name: string;
  readonly type: string;
  readonly origins: readonly string[];
  readonly aliases?: readonly { readonly alias: string; readonly source: 'user' | 'inferred'; readonly confidence?: number }[];
}

export async function seedEntity(sql: SQL, entity: SeedEntity): Promise<string> {
  const rows = (await sql`
    INSERT INTO entity (canonical_name, entity_type, origin_contexts)
    VALUES (${entity.name}, ${entity.type}, ${textArrayLiteral(entity.origins)}::text[])
    RETURNING entity_id::text AS entity_id
  `) as Array<{ entity_id: string }>;
  const entityId = rows[0]?.entity_id;
  if (entityId === undefined) throw new Error(`failed to seed entity ${entity.slug}`);

  await sql`INSERT INTO entity_slug (slug, entity_id, kind) VALUES (${entity.slug}, ${entityId}::bigint, 'canonical')`;
  for (const alias of entity.aliases ?? []) {
    await sql`
      INSERT INTO entity_alias (entity_id, alias, alias_source, confidence)
      VALUES (${entityId}::bigint, ${alias.alias}, ${alias.source}, ${alias.confidence ?? null})
    `;
  }
  return entityId;
}

export async function seedEdgeType(
  sql: SQL,
  type: string,
  inverse: string,
  description = 'fixture edge type',
): Promise<void> {
  await sql`
    INSERT INTO edge_type (edge_type, inverse_type, description)
    VALUES (${type}, ${inverse}, ${description})
    ON CONFLICT DO NOTHING
  `;
}

export async function seedEdge(
  sql: SQL,
  edge: {
    readonly subject: string;
    readonly type: string;
    readonly object: string;
    readonly origins: readonly string[];
  },
): Promise<void> {
  await sql`
    INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
    VALUES (${edge.subject}::bigint, ${edge.type}, ${edge.object}::bigint, ${textArrayLiteral(edge.origins)}::text[])
  `;
}

/**
 * A fact plus its `fact_source` rows.
 *
 * `fact.embedding` is `NOT NULL` by design (U4's synchronous half), so the
 * fixture supplies one; the graph arm does not read it, and a fixture that left
 * it out would fail at the constraint rather than at the assertion.
 */
export async function seedFact(
  sql: SQL,
  fact: {
    readonly statement: string;
    readonly origins: readonly string[];
    readonly chunkIds: readonly string[];
    readonly pageId?: string;
    readonly createdAt?: string;
    readonly superseded?: boolean;
  },
): Promise<string> {
  const zero = `[${new Array<number>(EMBEDDING_DIMENSIONS).fill(0).map((_, i) => (i === 0 ? 1 : 0)).join(',')}]`;
  const rows = (await sql.unsafe(
    `INSERT INTO fact (statement, ${SEAT_COLUMN}, origin_contexts, page_id, created_at)
     VALUES ($1, $2::vector, $3::text[], $4::bigint, $5::timestamptz)
     RETURNING fact_id::text AS fact_id`,
    [
      fact.statement,
      zero,
      textArrayLiteral(fact.origins),
      fact.pageId ?? null,
      fact.createdAt ?? '2026-01-01',
    ],
  )) as Array<{ fact_id: string }>;
  const factId = rows[0]?.fact_id;
  if (factId === undefined) throw new Error('failed to seed fact');

  for (const chunkId of fact.chunkIds) {
    await sql`INSERT INTO fact_source (fact_id, chunk_id) VALUES (${factId}::bigint, ${chunkId}::bigint)`;
  }
  if (fact.superseded === true) {
    await sql`UPDATE fact SET superseded_by = ${factId}::bigint WHERE fact_id = ${factId}::bigint`;
  }
  return factId;
}
