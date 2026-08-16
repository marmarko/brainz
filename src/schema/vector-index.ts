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
 * Three assertions close it, and they close different halves:
 *
 * 1. {@link assertHnswIndex} runs against a live tenant database, in
 *    provisioning (`src/schema/apply.ts`), not only in tests. Schema is applied
 *    per tenant, so a DDL step that fails on one tenant and succeeds on the next
 *    produces a fleet where some brains have a vector index and some do not,
 *    with no aggregate signal — the slow ones just look like unlucky users. A
 *    tenant without this index is broken, not slow, and should fail provisioning
 *    loudly. It requires an index whose **opclass serves the distance operator
 *    the arm actually issues**, not merely an index of method `hnsw`: an HNSW
 *    index built `vector_l2_ops` on a column queried with cosine `<=>` is an
 *    index the planner cannot use, so the query falls back to a sequential scan
 *    — H2's exact mechanism, reached by changing one token.
 *
 * 2. {@link assertVectorColumns} compares the two registries below against the
 *    vector columns the database actually has. Presence in a list is a claim;
 *    this is what makes the claim checkable. Its load-bearing rule is that a
 *    **reserved column may not be `NOT NULL`** — see
 *    {@link findVectorRegistryViolations} for why that is the one property that
 *    distinguishes "nothing reads this" from "something reads this and was
 *    filed in the wrong list".
 *
 * 3. {@link findIndexableDimensionViolations} runs against schema *text*, at
 *    migration-definition time, with no database in sight. pgvector stores far
 *    more dimensions than it can index, and the gap is where a model swap dies:
 *    `vector` stores 16,000 and HNSW-indexes 2,000; `halfvec` stores 16,000 and
 *    indexes 4,000. `text-embedding-3-large` is natively 3072d, which stores,
 *    inserts and queries fine and only fails at `CREATE INDEX`. KTD8 resolves
 *    that by truncating to 1536 — this function is what keeps the resolution
 *    from being quietly undone by the next model.
 */

import type { SQL } from 'bun';

import {
  ACTIVE_EMBEDDING_SEAT,
  EMBEDDING_SEATS,
  UnservableEmbeddingSeatError,
  findSeatWriteBlockers,
  type EmbeddingSeat,
} from './embedding-seat.ts';

/**
 * The stored dimension of the seat a tenant is provisioned at.
 *
 * It used to be the literal 1536, and it was true because exactly one model was
 * ever routed to the `embedding` op. It is now derived, because a second seat
 * exists at 1024 and a constant cannot be right for both — see
 * `src/schema/embedding-seat.ts` for which column a given model's vectors go in
 * and why the active seat is the one it is.
 *
 * Anything that has a *specific* model in hand must ask the seat registry rather
 * than read this: this is the schema's default, not a statement about any
 * particular call. `test/hazards/h2-missing-vector-index.test.ts` parses the
 * ladder and asserts the DDL agrees, rather than trusting this to have been
 * updated alongside it.
 */
export const EMBEDDING_DIMENSIONS = ACTIVE_EMBEDDING_SEAT.dimensions;

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

/** The table every read's vector arm goes through. */
export const CHUNK_TABLE = 'chunk';

/**
 * The column it goes through **under the active seat**. Derived for the same
 * reason {@link EMBEDDING_DIMENSIONS} is: with two seats registered, the column
 * a statement touches is a property of the model that produced the vector, and
 * a caller holding a model id must resolve it through
 * `embedding-seat.ts:seatForModel` instead of reading this.
 */
export const CHUNK_EMBEDDING_COLUMN = ACTIVE_EMBEDDING_SEAT.column;

/**
 * The distance operators pgvector's vector-family opclasses provide, spelled the
 * way a query spells them.
 *
 * The operator is registry *data* rather than an assumption baked into the
 * catalog query, because the opclass that can serve one of these cannot serve
 * the others: an index built `vector_l2_ops` is invisible to an `ORDER BY x <=>
 * q`, and the planner's only remaining option is a sequential scan. Which is to
 * say the operator a column is queried with is part of what "this column is
 * indexed" means, and leaving it implicit is how a one-token edit turns the
 * assertion into a formality.
 */
export type VectorDistanceOperator = '<=>' | '<->' | '<#>';

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
 * The tables that carry one column per embedding seat, and the rung each table
 * arrived at.
 *
 * Both are read by similarity and both therefore need an index per seat. They
 * are listed rather than derived because "which tables hold embeddings" is a
 * fact about the schema, while "which columns hold them" is a fact about the
 * seat registry — keeping the two separate is what lets a new seat register
 * itself into this file without a second edit.
 */
const EMBEDDING_BEARING_TABLES: ReadonlyArray<{
  readonly table: string;
  readonly since: number;
  readonly why: string;
}> = [
  {
    table: CHUNK_TABLE,
    since: 1,
    why: "the vector arm of every read; H1 and H3's fixture measures this table",
  },
  {
    table: 'fact',
    since: 2,
    why: 'facts are embedded on the write path and retrieved by similarity alongside chunks',
  },
];

export interface IndexedVectorColumn extends VectorColumn {
  /**
   * The distance operator the arm that reads this column issues. Asserted
   * against the index's opclass on every tenant, so "there is an hnsw index on
   * it" cannot pass for "the planner can use it".
   */
  readonly operator: VectorDistanceOperator;
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
 * Ordered with `chunk`'s columns first: it is the table the whole retrieval
 * stack reads, so a tenant missing one of its indexes should fail provisioning
 * naming *that*.
 *
 * **Derived from the seat registry rather than listed.** Every registered
 * embedding seat owns a column on both embedding-bearing tables, so a seat added
 * to `embedding-seat.ts` without a matching entry here is not a thing that can
 * happen — which matters because the failure it would cause (an unindexed
 * column the arm scans under one configuration) is H2 exactly, and H2's whole
 * character is that nothing reports it.
 */
export const INDEXED_VECTOR_COLUMNS: readonly IndexedVectorColumn[] =
  EMBEDDING_BEARING_TABLES.flatMap((table) =>
    EMBEDDING_SEATS.map(
      (seat): IndexedVectorColumn => ({
        table: table.table,
        column: seat.column,
        // A column exists once BOTH its table and its seat exist. Taking the
        // seat's rung alone would assert an index on `fact` at version 1, where
        // there is no `fact`; taking the table's alone would assert one on a
        // column no rung has added yet. Either produces a provisioning failure
        // that names H2 for a tenant whose schema is simply older than the
        // claim.
        since: Math.max(table.since, seat.since),
        operator: '<=>',
        why: `${table.why} (seat '${seat.id}', ${seat.dimensions}d)`,
      }),
    ),
  );

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
 *
 * Every entry here is checked against the database, not taken on trust — a
 * reserved column must be nullable and must carry no index. See
 * {@link findVectorRegistryViolations}.
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
  /** The operator class the index was built with, or `null` for none. */
  readonly opclass: string | null;
  /**
   * Whether that opclass's family provides the distance operator this lookup
   * asked about — read from `pg_amop`, not from a name the code recognises, so
   * a `halfvec_cosine_ops` column added later is judged by what it can do
   * rather than by whether anyone remembered to extend a map.
   */
  readonly servesOperator: boolean;
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
  /** The operator the arm issues, which is what the index had to be able to serve. */
  readonly operator: VectorDistanceOperator;
  /** What *was* found, so the message can distinguish absent from invalid. */
  readonly found: readonly VectorIndexRecord[];

  constructor(
    table: string,
    column: string,
    operator: VectorDistanceOperator,
    found: readonly VectorIndexRecord[],
  ) {
    const describe = (index: VectorIndexRecord): string => {
      const faults: string[] = [];
      if (!index.valid) faults.push('INVALID');
      // Named rather than folded into "no usable index": a wrong opclass is the
      // one failure here that looks completely healthy in `pg_indexes`.
      if (index.method === 'hnsw' && !index.servesOperator) {
        faults.push(`opclass ${index.opclass ?? 'unknown'} does not serve ${operator}`);
      }
      return `${index.indexName} (${[index.method, ...faults].join(', ')})`;
    };

    const detail =
      found.length === 0
        ? 'no index of any method covers it'
        : `found ${found.map(describe).join(', ')}`;
    super(
      `no hnsw index on ${table}.${column} that can serve ${operator}: ${detail}. A tenant without one is broken, not slow — it answers by sequential scan, which is exact, so recall goes up and nothing errors while latency collapses at scale.`,
    );
    this.name = 'MissingVectorIndexError';
    this.table = table;
    this.column = column;
    this.operator = operator;
    this.found = found;
  }
}

/**
 * Thrown when the vector-column registries in this file disagree with the vector
 * columns the database has. Distinct from {@link MissingVectorIndexError}
 * because the remedy differs: that one means a DDL step did not run on this
 * tenant, this one means the source of truth in this file is wrong for every
 * tenant.
 */
export class VectorColumnRegistryError extends Error {
  readonly findings: readonly string[];

  constructor(findings: readonly string[]) {
    super(
      `the vector-column registry does not match the database: ${findings.join('; ')}. Every vector column is either queried (indexed) or not (reserved); a column filed under the wrong one is H2 with a green guard over it.`,
    );
    this.name = 'VectorColumnRegistryError';
    this.findings = findings;
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
  operator: VectorDistanceOperator = '<=>',
): Promise<VectorIndexRecord[]> {
  const rows = await sql<
    { index_name: string; method: string; valid: boolean; opclass: string | null; serves: boolean }[]
  >`
    SELECT i.relname   AS index_name,
           am.amname   AS method,
           ix.indisvalid AND ix.indisready AS valid,
           oc.opcname  AS opclass,
           -- Asked of pg_amop rather than matched against a list of opclass
           -- names: the question is whether the planner can answer an ORDER BY
           -- through this index, and that is a property of the operator family,
           -- not of what the family happens to be called.
           coalesce(
             EXISTS (
               SELECT 1
               FROM pg_amop ao
               JOIN pg_operator o ON o.oid = ao.amopopr
               WHERE ao.amopfamily = oc.opcfamily
                 AND ao.amoppurpose = 'o'
                 AND o.oprname = ${operator}
             ),
             false
           ) AS serves
    FROM pg_class t
    JOIN pg_index ix ON ix.indrelid = t.oid
    JOIN pg_class i  ON i.oid = ix.indexrelid
    JOIN pg_am am    ON am.oid = i.relam
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY (ix.indkey)
    -- indclass is position-matched to indkey, so the opclass is looked up at
    -- this column's own position rather than at the first one. Today's vector
    -- indexes are single-column; a composite one would otherwise be judged by
    -- whatever its leading column happened to use.
    LEFT JOIN pg_opclass oc
      ON oc.oid = ix.indclass[array_position(string_to_array(ix.indkey::text, ' ')::int[], a.attnum::int) - 1]
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
    opclass: row.opclass,
    servesOperator: row.serves,
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
  operator: VectorDistanceOperator = '<=>',
): Promise<VectorIndexRecord> {
  const found = await findIndexesOnColumn(sql, table, column, operator);
  // All three conditions are the same condition asked three ways: can the
  // planner answer this arm's ORDER BY through an index? A wrong opclass fails
  // it exactly as completely as a missing index, and looks exactly as healthy.
  const usable = found.find(
    (index) => index.method === 'hnsw' && index.valid && index.servesOperator,
  );
  if (usable === undefined) throw new MissingVectorIndexError(table, column, operator, found);
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
    accepted.push(await assertHnswIndex(sql, column.table, column.column, column.operator));
  }
  return accepted;
}

/** One vector column as the tenant's own catalog reports it. */
export interface CatalogVectorColumn {
  readonly table: string;
  readonly column: string;
  /** `format_type`, so it arrives spelled as declared: `vector(1536)`. */
  readonly type: string;
  readonly notNull: boolean;
}

/** Every vector-family column the tenant database actually has. */
export async function listVectorColumns(sql: SQL): Promise<CatalogVectorColumn[]> {
  const rows = await sql<
    { table_name: string; column_name: string; type: string; not_null: boolean }[]
  >`
    SELECT c.relname AS table_name,
           a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS type,
           a.attnotnull AS not_null
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    JOIN pg_type ty ON ty.oid = a.atttypid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND ty.typname IN ('vector', 'halfvec')
    ORDER BY c.relname, a.attname
  `;

  return rows.map((row) => ({
    table: row.table_name,
    column: row.column_name,
    type: row.type,
    notNull: row.not_null,
  }));
}

/**
 * Where the two registries stop being prose.
 *
 * The lists above say which vector columns are queried and which are not, and
 * that claim used to be carried entirely by their `why` strings. It is not
 * checkable directly — nothing in the database knows what a future retrieval arm
 * will read — so this checks the two properties that make the claim *survivable*
 * when it is wrong in the one direction that matters:
 *
 *   * **Every vector column the database has is in exactly one list.** A column
 *     in neither is H2 waiting to happen: it answers by sequential scan, exactly,
 *     forever, and no guard is watching it. A column in both makes "which rule
 *     applies" a question with two answers.
 *
 *   * **A reserved column may not be `NOT NULL`.** This is the rule that catches
 *     the move a registry cannot otherwise see: taking a queried column *off* the
 *     indexed list. `NOT NULL` on a vector column means the write path computes
 *     an embedding for every row or the insert fails — and nothing pays an
 *     embedding call per row for a column it never reads. So a `NOT NULL` vector
 *     column is by construction on somebody's read path, and filing it as
 *     reserved is a false statement the database can catch. (`fact.embedding` is
 *     exactly this: synchronous on the write path, `NOT NULL` by design.)
 *
 * The residual is stated rather than hidden: a *nullable* queried column
 * mis-filed as reserved is still invisible here. `chunk.embedding` is nullable
 * and is caught instead by H1's and H3's plan-level assertions; a third such
 * column would need its own. That is narrower than the hole this replaces, not
 * the absence of one.
 */
export function findVectorRegistryViolations(
  columns: readonly CatalogVectorColumn[],
): string[] {
  const findings: string[] = [];
  const key = (c: { table: string; column: string }): string => `${c.table}.${c.column}`;
  const indexed = new Set(INDEXED_VECTOR_COLUMNS.map(key));
  const reserved = new Set(RESERVED_VECTOR_COLUMNS.map(key));

  for (const name of indexed) {
    if (reserved.has(name)) {
      findings.push(`${name}: registered as BOTH indexed and reserved — it is one or the other`);
    }
  }

  for (const column of columns) {
    const name = key(column);
    if (!indexed.has(name) && !reserved.has(name)) {
      findings.push(
        `${name} (${column.type}): a vector column in neither INDEXED_VECTOR_COLUMNS nor RESERVED_VECTOR_COLUMNS — an unregistered vector column is answered by sequential scan with nothing watching`,
      );
      continue;
    }
    if (reserved.has(name) && column.notNull) {
      findings.push(
        `${name}: registered as reserved but declared NOT NULL — the write path must produce a value for every row, so something computes this embedding, so something reads it. It belongs in INDEXED_VECTOR_COLUMNS with an index and an operator.`,
      );
    }
  }

  return findings;
}

/**
 * The whole H2 assertion for one tenant, in the order the failures matter.
 *
 * Structure first, then indexes: a registry that disagrees with the database
 * makes the index assertions meaningless (they are a loop over the registry), so
 * reporting "no index on X" while X was never supposed to be on that list sends
 * the reader to the wrong file.
 */
export async function assertVectorColumns(
  sql: SQL,
  schemaVersion: number,
  seat: EmbeddingSeat = ACTIVE_EMBEDDING_SEAT,
): Promise<VectorIndexRecord[]> {
  const present = await listVectorColumns(sql);
  const findings = findVectorRegistryViolations(present);

  // Asked of the catalog rather than assumed from the list: "reserved" means an
  // index was never built, and an index that appeared anyway is either a copied
  // migration or a column that quietly became queried.
  const here = new Set(present.map((c) => `${c.table}.${c.column}`));
  for (const column of RESERVED_VECTOR_COLUMNS) {
    if (!here.has(`${column.table}.${column.column}`)) continue;
    const indexes = await findIndexesOnColumn(sql, column.table, column.column);
    if (indexes.length > 0) {
      findings.push(
        `${column.table}.${column.column}: registered as reserved but carries ${indexes.map((i) => `${i.indexName} (${i.method})`).join(', ')} — a reserved column is one nothing reads, so an index on it is a build cost for no read, or a mis-registration`,
      );
    }
  }

  if (findings.length > 0) throw new VectorColumnRegistryError(findings);

  // Whether the tenant *can be written* under the seat this fleet is configured
  // for, asked before any index assertion because an unwritable seat is not a
  // missing-index problem and reporting it as one sends the reader to the wrong
  // file. A tenant provisioned under a seat whose vectors no INSERT can supply
  // is a tenant that accepts reads and fails its first write, under a user,
  // naming a constraint rather than the routing row that caused it.
  const blockers = findSeatWriteBlockers(seat, present);
  if (blockers.length > 0) throw new UnservableEmbeddingSeatError(seat, blockers);

  return assertIndexedVectorColumns(sql, schemaVersion);
}
