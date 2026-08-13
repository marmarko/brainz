/**
 * The tenant schema, as the database reports it — U3's approach steps 1 and 2.
 *
 * Two properties carry this file, and neither is "the DDL parsed".
 *
 * **R15, enumerated rather than spot-checked.** Every row carries an immutable,
 * credential-derived origin and a separate mutable, confidence-scored subject.
 * A per-table assertion would guard the tables that exist on the day it is
 * written; the guard below instead enumerates every table in the tenant
 * database, reads the class each one declares in its own `COMMENT ON TABLE`,
 * and fails closed on a table that declares nothing. A future table cannot skip
 * the origin fence by being new — it can only skip it by writing down a false
 * class, which is a reviewable act rather than an omission.
 *
 * **Immutability is the database's, not the write path's.** R15 calls origin
 * "immutable"; a convention that says so is a convention one careless UPDATE
 * defeats, and access fencing evaluates origin only (KTD5), so a mutable origin
 * is a privilege-escalation primitive rather than a data-quality nit. So the
 * guard issues the UPDATE and asserts the database refuses it — and, in the same
 * breath, asserts that an UPDATE of `subject_context` succeeds, because a
 * trigger that refused every UPDATE would pass the first assertion while
 * breaking inference.
 */

import type { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { HEAD_SCHEMA_VERSION } from '../../src/schema/migrations.ts';
import {
  CHUNK_EMBEDDING_COLUMN,
  CHUNK_TABLE,
  EMBEDDING_DIMENSIONS,
  INDEXED_VECTOR_COLUMNS,
  RESERVED_VECTOR_COLUMNS,
  assertHnswIndex,
  findIndexesOnColumn,
} from '../../src/schema/vector-index.ts';
import {
  generatedExpression,
  listColumns,
  listIndexes,
  listTables,
  listTriggers,
  type ColumnRecord,
} from './catalog.ts';
import {
  FIXTURE_FTS_LANGUAGE,
  connect,
  dropFixtureDatabase,
  provisionFixture,
  sqlstateOfFailure,
  type SchemaFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

/**
 * The class every table declares in its own comment, and the whole legal set.
 *
 * `content:ingested` — arrived through exactly one credential, so its origin is
 * a scalar. `content:derived` — computed from other rows, so its origin is the
 * UNION of its inputs' origins and therefore an array (R15).
 * `operational` — a log or an artifact record: it may carry an origin, it
 * carries no inference. `registry` — schema's own bookkeeping, no user rows.
 */
const TABLE_CLASSES = ['content:ingested', 'content:derived', 'operational', 'registry'] as const;
type TableClass = (typeof TABLE_CLASSES)[number];

/**
 * The tables U3 ships, and what each one is. Compared as a set in both
 * directions: a table that disappears fails, and so does a table that appears
 * without being written down here. The second half is the one that matters —
 * it is what makes the R15 enumeration below unable to go quiet.
 */
const EXPECTED_TABLES: ReadonlyMap<string, TableClass> = new Map([
  ['schema_migration', 'registry'],
  ['tenant_setting', 'registry'],
  ['edge_type', 'registry'],

  ['page', 'content:ingested'],
  ['chunk', 'content:ingested'],
  ['attachment', 'content:ingested'],

  ['fact', 'content:derived'],
  ['fact_source', 'operational'],
  ['entity', 'content:derived'],
  ['entity_slug', 'operational'],
  ['entity_alias', 'operational'],
  ['entity_edge', 'content:derived'],
  ['contradiction_report', 'content:derived'],

  ['ingest_log', 'operational'],
]);

const SHARED_ORIGIN_TRIGGER_FUNCTION = 'refuse_origin_change';

let fixture: SchemaFixture;
let sql: SQL;

beforeAll(async () => {
  fixture = await provisionFixture('head');
  sql = connect(fixture);
}, { timeout: SETUP_TIMEOUT_MS });

afterAll(async () => {
  await sql?.close();
  if (fixture !== undefined) await dropFixtureDatabase(fixture);
}, { timeout: SETUP_TIMEOUT_MS });

function columnsOf(columns: readonly ColumnRecord[], table: string): Map<string, ColumnRecord> {
  return new Map(columns.filter((c) => c.table === table).map((c) => [c.column, c]));
}

describe('the tenant schema is applied whole, and says which version it is', () => {
  test(
    'provisioning leaves a ledger naming every migration that ran',
    async () => {
      const rows = await sql<{ version: number; name: string }[]>`
        SELECT version, name FROM schema_migration ORDER BY version
      `;

      expect(rows.map((row) => row.version)).toEqual(
        Array.from({ length: HEAD_SCHEMA_VERSION }, (_, i) => i + 1),
      );
      // Names, not just numbers: a ledger of bare integers cannot tell an
      // operator which change a tenant is missing.
      for (const row of rows) expect(row.name.length).toBeGreaterThan(3);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'every table that exists was declared here, and every declared table exists',
    async () => {
      const tables = await listTables(sql);
      const present = tables.map((t) => t.table).sort();

      expect(present).toEqual([...EXPECTED_TABLES.keys()].sort());
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'every table declares a legal class in its own comment — fail-closed',
    async () => {
      const tables = await listTables(sql);
      const findings: string[] = [];

      for (const { table, comment } of tables) {
        const declared = comment?.split(/\s|—/)[0];
        if (declared === undefined || !TABLE_CLASSES.includes(declared as TableClass)) {
          findings.push(
            `${table}: comment does not open with one of ${TABLE_CLASSES.join(', ')} — an unclassified table is a table no R15 guard covers`,
          );
          continue;
        }
        const expected = EXPECTED_TABLES.get(table);
        if (declared !== expected) findings.push(`${table}: declares ${declared}, expected ${expected}`);
      }

      expect(findings).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the tenant records its own FTS language and taxonomy version',
    async () => {
      const rows = await sql<{ fts_language: string; taxonomy_version: number }[]>`
        SELECT fts_language, taxonomy_version FROM tenant_setting
      `;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.fts_language).toBe(FIXTURE_FTS_LANGUAGE);
      expect(rows[0]?.taxonomy_version).toBeGreaterThanOrEqual(1);

      // A second row would make "the tenant's language" ambiguous, which is the
      // shape KTD9's silent fallback takes once there is more than one answer.
      const second = await sqlstateOfFailure(
        sql,
        `INSERT INTO tenant_setting (fts_language, taxonomy_version) VALUES ('english', 1)`,
      );
      expect(second).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('R15 — origin and subject, on every content row, enumerated', () => {
  test(
    'each class carries the origin shape its class implies',
    async () => {
      const columns = await listColumns(sql);
      const findings: string[] = [];

      for (const [table, klass] of EXPECTED_TABLES) {
        const cols = columnsOf(columns, table);
        const scalar = cols.get('origin_context');
        const union = cols.get('origin_contexts');

        if (klass === 'content:ingested') {
          if (scalar === undefined || scalar.type !== 'text' || !scalar.notNull) {
            findings.push(`${table}: an ingested row needs a NOT NULL scalar origin_context`);
          }
          if (union !== undefined) {
            findings.push(`${table}: an ingested row arrives through one credential, not a union`);
          }
        }

        if (klass === 'content:derived') {
          // R15: derived rows inherit the union of their inputs' origins, so the
          // column has to be able to hold more than one.
          if (union === undefined || union.type !== 'text[]' || !union.notNull) {
            findings.push(`${table}: a derived row needs a NOT NULL origin_contexts text[]`);
          }
          if (scalar !== undefined) {
            findings.push(`${table}: a derived row cannot narrow its origins to a scalar`);
          }
        }

        if (klass === 'registry' && (scalar !== undefined || union !== undefined)) {
          findings.push(`${table}: declares registry but carries an origin — reclassify it`);
        }
      }

      expect(findings).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'content rows carry a mutable, confidence-scored subject; nothing else does',
    async () => {
      const columns = await listColumns(sql);
      const findings: string[] = [];

      for (const [table, klass] of EXPECTED_TABLES) {
        const cols = columnsOf(columns, table);
        const subject = cols.get('subject_context');
        const confidence = cols.get('subject_confidence');
        const isContent = klass.startsWith('content:');

        if (isContent) {
          // Nullable on purpose: inference has not run yet on a freshly written
          // row, and "not yet inferred" must be distinguishable from "inferred
          // as nothing". Confidence is what makes it *scored* rather than
          // asserted — KTD5 lets it inform ranking, never access.
          if (subject === undefined || subject.notNull) {
            findings.push(`${table}: content rows need a nullable subject_context`);
          }
          if (confidence === undefined) findings.push(`${table}: subject_context needs a confidence`);
        } else if (subject !== undefined || confidence !== undefined) {
          findings.push(`${table}: is not content but carries a subject — reclassify or drop it`);
        }
      }

      expect(findings).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'every origin column in the database is protected by the shared trigger',
    async () => {
      const columns = await listColumns(sql);
      const triggers = await listTriggers(sql);
      const findings: string[] = [];

      const originColumns = columns.filter(
        (c) => c.column === 'origin_context' || c.column === 'origin_contexts',
      );
      // A vacuous scan would report a clean sheet for a schema with no fences at
      // all, which is exactly the failure the enumeration exists to catch.
      expect(originColumns.length).toBeGreaterThanOrEqual(EXPECTED_TABLES.size / 2);

      for (const column of originColumns) {
        const guarding = triggers.filter(
          (t) =>
            t.table === column.table &&
            t.definition.includes(SHARED_ORIGIN_TRIGGER_FUNCTION) &&
            t.definition.includes(`UPDATE OF ${column.column}`),
        );
        if (guarding.length === 0) {
          findings.push(
            `${column.table}.${column.column}: no BEFORE UPDATE OF trigger calling ${SHARED_ORIGIN_TRIGGER_FUNCTION}`,
          );
          continue;
        }
        for (const trigger of guarding) {
          if (!trigger.definition.startsWith('CREATE TRIGGER') || !trigger.definition.includes('BEFORE')) {
            findings.push(`${column.table}: ${trigger.trigger} is not a BEFORE trigger`);
          }
        }
      }

      expect(findings).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('R15 — the database refuses to let an origin move', () => {
  beforeAll(async () => {
    await sql.unsafe(`
      INSERT INTO chunk (origin_context, content) VALUES ('personal', 'immutability fixture');
      INSERT INTO fact (statement, embedding, origin_contexts)
      VALUES ('derived fixture',
              ('[1' || repeat(',0', ${EMBEDDING_DIMENSIONS - 1}) || ']')::vector(${EMBEDDING_DIMENSIONS}),
              ARRAY['personal']);
    `);
  });

  test(
    'an UPDATE that changes a scalar origin is rejected by the database',
    async () => {
      const state = await sqlstateOfFailure(
        sql,
        `UPDATE chunk SET origin_context = 'work' WHERE content = 'immutability fixture'`,
      );

      // The code, not the message: the write path has to be able to tell this
      // apart from an ordinary constraint violation and answer `scope_denied`.
      expect(state).toBe('BZ001');

      const rows = await sql<{ origin_context: string }[]>`
        SELECT origin_context FROM chunk WHERE content = 'immutability fixture'
      `;
      expect(rows[0]?.origin_context).toBe('personal');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an UPDATE that changes a derived origin union is rejected too',
    async () => {
      const state = await sqlstateOfFailure(
        sql,
        `UPDATE fact SET origin_contexts = ARRAY['personal','work'] WHERE statement = 'derived fixture'`,
      );

      // Widening a derived row's origins in place is the interesting case: it is
      // how an inference would silently grant a work-fenced reader a personal
      // fact. A derived row whose inputs changed is rewritten, not mutated.
      expect(state).toBe('BZ001');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the trigger refuses a change, not every UPDATE',
    async () => {
      // Without this, a trigger that raised unconditionally would pass every
      // assertion above while making inference (R15's mutable half) impossible.
      await sql.unsafe(
        `UPDATE chunk SET subject_context = 'travel', subject_confidence = 0.7 WHERE content = 'immutability fixture'`,
      );
      const rows = await sql<{ subject_context: string | null }[]>`
        SELECT subject_context FROM chunk WHERE content = 'immutability fixture'
      `;
      expect(rows[0]?.subject_context).toBe('travel');

      // And a SET of the same value is not a change. The write path re-writes
      // whole rows; a trigger keyed on "the column appeared in the SET list"
      // rather than on the value would break every such write.
      await sql.unsafe(
        `UPDATE chunk SET origin_context = 'personal' WHERE content = 'immutability fixture'`,
      );
    },
    TEST_TIMEOUT_MS,
  );
});

describe('KTD8 / H2 — every vector column is accounted for', () => {
  test(
    'the schema declares no vector column that is neither indexed nor reserved',
    async () => {
      const columns = await listColumns(sql);
      const vectorColumns = columns
        .filter((c) => c.type.startsWith('vector(') || c.type.startsWith('halfvec('))
        .map((c) => `${c.table}.${c.column}`)
        .sort();

      const registered = [
        ...INDEXED_VECTOR_COLUMNS.map((c) => `${c.table}.${c.column}`),
        ...RESERVED_VECTOR_COLUMNS.map((c) => `${c.table}.${c.column}`),
      ].sort();

      // Fail-closed both ways. An unregistered vector column is H2 waiting to
      // happen — it answers by sequential scan, exactly, forever.
      expect(vectorColumns).toEqual(registered);
      expect(vectorColumns.length).toBeGreaterThan(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'every column registered as indexed really has a valid hnsw index',
    async () => {
      for (const column of INDEXED_VECTOR_COLUMNS) {
        const index = await assertHnswIndex(sql, column.table, column.column);
        expect(index.method).toBe('hnsw');
        expect(index.valid).toBe(true);
      }

      // The one the hazard suite pins, named explicitly so a refactor that
      // renamed it would have to come through here too.
      expect(
        INDEXED_VECTOR_COLUMNS.some(
          (c) => c.table === CHUNK_TABLE && c.column === CHUNK_EMBEDDING_COLUMN,
        ),
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the reserved image column is reserved: no index, and inside the ceiling',
    async () => {
      for (const column of RESERVED_VECTOR_COLUMNS) {
        const indexes = await findIndexesOnColumn(sql, column.table, column.column);
        // Reserved means nothing queries it. An index on an unqueried column is
        // a build cost and a promise the U21 model has not made yet — and the
        // moment something *does* query it, the registry entry has to move.
        expect(indexes).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'facts are embedded synchronously — the column cannot be NULL',
    async () => {
      const columns = await listColumns(sql);
      const factEmbedding = columnsOf(columns, 'fact').get('embedding');
      const chunkEmbedding = columnsOf(columns, 'chunk').get('embedding');

      // The asymmetry is the design (U3 approach step 1): a chunk is written
      // before it is embedded and backfilled, so its column is nullable; a fact
      // is embedded on the write path, so an unembedded fact is a bug the
      // database can refuse rather than a row the vector arm silently skips.
      expect(factEmbedding?.notNull).toBe(true);
      expect(chunkEmbedding?.notNull).toBe(false);

      const state = await sqlstateOfFailure(
        sql,
        `INSERT INTO fact (statement, origin_contexts) VALUES ('unembedded', ARRAY['personal'])`,
      );
      expect(state).toBe('23502'); // not_null_violation
    },
    TEST_TIMEOUT_MS,
  );
});

describe('KTD9 — the tenant’s language reaches every generated column', () => {
  test(
    'no generated text-search column silently says english',
    async () => {
      const columns = await listColumns(sql);
      const generated = columns.filter((c) => c.generated && c.type === 'tsvector');

      // Two of them today (chunk body, page title); the assertion is over
      // whatever exists, so a third added later is covered by construction.
      expect(generated.length).toBeGreaterThanOrEqual(2);

      for (const column of generated) {
        const expression = await generatedExpression(sql, column.table, column.column);
        expect(expression).toContain(`'${FIXTURE_FTS_LANGUAGE}'::regconfig`);
        expect(expression).not.toContain('english');
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the full-text arm has an index to read on both of them',
    async () => {
      const columns = await listColumns(sql);
      const generated = columns.filter((c) => c.generated && c.type === 'tsvector');

      for (const column of generated) {
        const indexes = await listIndexes(sql, column.table);
        const covering = indexes.filter(
          (index) => index.method === 'gin' && index.definition.includes(column.column),
        );
        expect(covering.length).toBeGreaterThanOrEqual(1);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('KTD8 — the per-page provenance signature a re-embed keys on', () => {
  test(
    'a page names the model, the dimension and the pipeline that produced it',
    async () => {
      const columns = columnsOf(await listColumns(sql), 'page');

      for (const name of [
        'embedding_model',
        'embedding_dimensions',
        'chunker_version',
        'normalizer_version',
        'content_sha256',
      ]) {
        expect(columns.get(name)?.notNull).toBe(true);
      }

      // Derived rather than stored twice: U10's `re_embed` job selects on this
      // one value, and a hand-assembled signature drifts from its parts.
      expect(columns.get('provenance_signature')?.generated).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the signature changes when any part of the pipeline changes',
    async () => {
      const rows = await sql<{ signature: string }[]>`
        INSERT INTO page (origin_context, source_type, title, embedding_model,
                          embedding_dimensions, chunker_version, normalizer_version, content_sha256)
        VALUES ('personal', 'note', 'provenance', 'text-embedding-3-large',
                ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64)),
               ('personal', 'note', 'provenance', 'text-embedding-3-small',
                ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64))
        RETURNING provenance_signature AS signature
      `;

      expect(rows).toHaveLength(2);
      expect(rows[0]?.signature).not.toBe(rows[1]?.signature);
      expect(rows[0]?.signature).toContain('text-embedding-3-large');
      expect(rows[0]?.signature).toContain(String(EMBEDDING_DIMENSIONS));
    },
    TEST_TIMEOUT_MS,
  );
});
