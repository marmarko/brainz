/**
 * The vector index, and the ceiling that decides whether one can exist.
 *
 * Hazard H2 in `docs/porting-hazards.md`: a missing HNSW index does not break
 * correctness. Postgres falls back to a sequential scan, which returns *exact*
 * nearest neighbours — strictly better recall than the approximate index — so
 * every accuracy test passes harder than production ever will, right up until
 * the first real brain turns every query into a full table scan. There is no
 * error, no failing test, and no signal except a query plan nobody reads.
 *
 * Two assertions close it, and they close different halves:
 *
 * 1. {@link assertHnswIndex} runs against a live tenant database, in
 *    provisioning (`src/schema/apply.ts`), not only in tests. Schema is applied
 *    per tenant, so a DDL step that fails on one tenant and succeeds on the next
 *    produces a fleet where some brains have a vector index and some do not,
 *    with no aggregate signal — the slow ones just look like unlucky users. A
 *    tenant without this index is broken, not slow, and should fail provisioning
 *    loudly.
 *
 * 2. {@link findIndexableDimensionViolations} runs against schema *text*, at
 *    migration-definition time, with no database in sight. pgvector stores far
 *    more dimensions than it can index, and the gap is where a model swap dies:
 *    `vector` stores 16,000 and HNSW-indexes 2,000; `halfvec` stores 16,000 and
 *    indexes 4,000. `text-embedding-3-large` is natively 3072d, which stores,
 *    inserts and queries fine and only fails at `CREATE INDEX`. KTD8 resolves
 *    that by truncating to 1536 — this function is what keeps the resolution
 *    from being quietly undone by the next model.
 */

import type { SQL } from 'bun';

/**
 * KTD8's stored dimension, and the single place it is written down in
 * TypeScript. `test/hazards/h2-missing-vector-index.test.ts` parses
 * `tenant.sql` and asserts the DDL agrees, rather than trusting this constant
 * to have been updated alongside it.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * How many dimensions each pgvector type can be HNSW-indexed at. These are the
 * *index* ceilings, which are far below the storage ceilings — that difference
 * is the entire hazard, so the numbers are named here rather than inlined at a
 * comparison.
 */
export const HNSW_INDEXABLE_DIMENSIONS = {
  vector: 2000,
  halfvec: 4000,
} as const;

export type VectorTypeName = keyof typeof HNSW_INDEXABLE_DIMENSIONS;

/** The table and column every read's vector arm goes through. */
export const CHUNK_TABLE = 'chunk';
export const CHUNK_EMBEDDING_COLUMN = 'embedding';

export interface VectorColumn {
  readonly table: string;
  readonly column: string;
  /**
   * The schema rung that creates it. A tenant part-way up the ladder does not
   * have the later rungs' columns, and asserting an index on a table that does
   * not exist yet would fail provisioning for a reason that is not H2.
   */
  readonly since: number;
  /** Why it is on this list rather than the other one. */
  readonly why: string;
}

/**
 * Vector columns something queries — so each one needs an index, on every
 * tenant, or that tenant answers from it by sequential scan.
 *
 * A list rather than a single hardcoded column because H2's real shape is a
 * fleet-wide silence: the check has to grow with the schema, and the moment a
 * second vector column is queried without being added here, the guard that
 * covers the first reports green for both. `test/schema/tenant-schema.test.ts`
 * closes the loop by enumerating the vector columns the database actually has
 * and failing on any that appears in neither list.
 *
 * Ordered with `chunk.embedding` first: it is the column the whole retrieval
 * stack reads, so a tenant missing it should fail provisioning naming *that*.
 */
export const INDEXED_VECTOR_COLUMNS: readonly VectorColumn[] = [
  {
    table: CHUNK_TABLE,
    column: CHUNK_EMBEDDING_COLUMN,
    since: 1,
    why: "the vector arm of every read; H1 and H3's fixture measures this column",
  },
  {
    table: 'fact',
    column: 'embedding',
    since: 2,
    why: 'facts are embedded on the write path and retrieved by similarity alongside chunks',
  },
];

/**
 * Vector columns that exist and are not yet queried by anything.
 *
 * KTD8 reserves an image-embedding column now so the media path (U21) does not
 * need a column migration later. A reserved column carries no index on purpose:
 * an HNSW build costs storage and write latency for a column nothing reads, and
 * the model that will fill it has not been chosen — so the declared dimension is
 * a placeholder, free to change while the column is empty, unindexed and
 * unqueried. The day U21 queries it, its entry moves to the list above and
 * provisioning starts asserting an index for it.
 */
export const RESERVED_VECTOR_COLUMNS: readonly VectorColumn[] = [
  {
    table: 'attachment',
    column: 'image_embedding',
    since: 2,
    why: 'reserved for U21 (media path); nothing queries it, so it carries no index yet',
  },
];

export interface VectorDeclaration {
  readonly type: VectorTypeName;
  readonly dimensions: number;
  /** The matched text, so a violation names itself rather than a line number. */
  readonly declaration: string;
}

export interface DimensionCeilingViolation extends VectorDeclaration {
  readonly ceiling: number;
}

/**
 * Comments are stripped before scanning. Without this, the prose above a column
 * — which necessarily discusses the dimensions that do *not* fit — reads as a
 * declaration, and the guard fails on its own explanation of itself.
 */
function stripSqlComments(sqlText: string): string {
  return sqlText.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

const VECTOR_DECLARATION = /\b(vector|halfvec)\s*\(\s*(\d+)\s*\)/gi;

/**
 * Every dimensioned vector-family type named in a piece of schema text.
 *
 * Exported because the caller has to be able to prove the scan was not vacuous.
 * A regex that silently matches nothing turns
 * {@link findIndexableDimensionViolations} into a function that returns `[]`
 * forever, which is the same shape of quiet failure the ledger exists to catch
 * — so the guard asserts what this found, not only what it objected to.
 */
export function findVectorDeclarations(sqlText: string): VectorDeclaration[] {
  const found: VectorDeclaration[] = [];

  for (const match of stripSqlComments(sqlText).matchAll(VECTOR_DECLARATION)) {
    const rawType = match[1];
    const rawDimensions = match[2];
    if (rawType === undefined || rawDimensions === undefined) continue;

    const type = rawType.toLowerCase() as VectorTypeName;
    const dimensions = Number.parseInt(rawDimensions, 10);
    if (!Number.isSafeInteger(dimensions)) continue;

    found.push({ type, dimensions, declaration: `${type}(${dimensions})` });
  }

  return found;
}

/**
 * The declarations that store but cannot be indexed.
 *
 * Deliberately broader than "column definitions": any dimensioned vector type
 * anywhere in a schema file is checked. A cast to an unindexable dimension is
 * not a thing this schema should be doing quietly either, and the alternative —
 * deciding which occurrences are column definitions — needs a SQL parser, which
 * would fail open on the DDL it did not understand.
 */
export function findIndexableDimensionViolations(sqlText: string): DimensionCeilingViolation[] {
  const violations: DimensionCeilingViolation[] = [];

  for (const declaration of findVectorDeclarations(sqlText)) {
    const ceiling = HNSW_INDEXABLE_DIMENSIONS[declaration.type];
    if (declaration.dimensions > ceiling) violations.push({ ...declaration, ceiling });
  }

  return violations;
}

/** A live index, as the catalog reports it. */
export interface VectorIndexRecord {
  readonly indexName: string;
  readonly method: string;
  /** A build that failed leaves an index the planner will not use. */
  readonly valid: boolean;
}

/**
 * Thrown when a tenant database has no usable HNSW index on its embedding
 * column. Typed rather than a bare `Error` because provisioning has to be able
 * to tell this apart from a connection failure: this one means the tenant is
 * broken and must not be handed out, and `src/control/provision.ts` records it
 * as `schema_apply_failed`.
 */
export class MissingVectorIndexError extends Error {
  readonly table: string;
  readonly column: string;
  /** What *was* found, so the message can distinguish absent from invalid. */
  readonly found: readonly VectorIndexRecord[];

  constructor(table: string, column: string, found: readonly VectorIndexRecord[]) {
    const detail =
      found.length === 0
        ? 'no index of any method covers it'
        : `found ${found.map((i) => `${i.indexName} (${i.method}${i.valid ? '' : ', INVALID'})`).join(', ')}`;
    super(
      `no valid hnsw index on ${table}.${column}: ${detail}. A tenant without one is broken, not slow — it answers by sequential scan, which is exact, so recall goes up and nothing errors while latency collapses at scale.`,
    );
    this.name = 'MissingVectorIndexError';
    this.table = table;
    this.column = column;
    this.found = found;
  }
}

/**
 * Every index covering `column` on `table`, whatever its method.
 *
 * It reports all methods rather than filtering to `hnsw` in SQL on purpose: the
 * interesting failure is a tenant that has *a* index on the embedding column —
 * a btree from a copied migration, an HNSW build that failed and left an invalid
 * remnant — because "an index exists" is exactly the check a presence-style
 * guard would perform and pass.
 */
export async function findIndexesOnColumn(
  sql: SQL,
  table: string,
  column: string,
): Promise<VectorIndexRecord[]> {
  const rows = await sql<{ index_name: string; method: string; valid: boolean }[]>`
    SELECT i.relname   AS index_name,
           am.amname   AS method,
           ix.indisvalid AND ix.indisready AS valid
    FROM pg_class t
    JOIN pg_index ix ON ix.indrelid = t.oid
    JOIN pg_class i  ON i.oid = ix.indexrelid
    JOIN pg_am am    ON am.oid = i.relam
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (ix.indkey)
    WHERE t.relname = ${table}
      AND a.attname = ${column}
      AND t.relkind = 'r'
      AND pg_table_is_visible(t.oid)
    ORDER BY i.relname
  `;

  return rows.map((row) => ({
    indexName: row.index_name,
    method: row.method,
    valid: row.valid,
  }));
}

/**
 * Asserts a tenant database can actually serve its vector arm through an index.
 *
 * Called by `src/schema/apply.ts` during provisioning. Throws
 * {@link MissingVectorIndexError}; returns the index it accepted so the caller
 * can log which one satisfied it.
 */
export async function assertHnswIndex(
  sql: SQL,
  table: string = CHUNK_TABLE,
  column: string = CHUNK_EMBEDDING_COLUMN,
): Promise<VectorIndexRecord> {
  const found = await findIndexesOnColumn(sql, table, column);
  const usable = found.find((index) => index.method === 'hnsw' && index.valid);
  if (usable === undefined) throw new MissingVectorIndexError(table, column, found);
  return usable;
}

/**
 * Every queried vector column the tenant's schema version has, asserted in one
 * pass — what provisioning runs before a tenant is handed out. Throws
 * {@link MissingVectorIndexError} for the first column that has no usable index,
 * in list order, so a tenant missing `chunk.embedding` fails naming that rather
 * than naming whatever came later.
 *
 * Scoped by version because provisioning can stop part-way up the ladder: a
 * tenant at rung one has no `fact` table, and failing it for the absence of an
 * index on a table its version never had would be a false H2 report — the class
 * of noise that gets a guard switched off.
 */
export async function assertIndexedVectorColumns(
  sql: SQL,
  schemaVersion: number,
): Promise<VectorIndexRecord[]> {
  const accepted: VectorIndexRecord[] = [];
  for (const column of INDEXED_VECTOR_COLUMNS) {
    if (column.since > schemaVersion) continue;
    accepted.push(await assertHnswIndex(sql, column.table, column.column));
  }
  return accepted;
}
