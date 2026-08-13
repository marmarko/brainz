/**
 * H2 — The vector index that quietly isn't there.
 *
 * See `docs/porting-hazards.md` for the full card. The hazard is not that
 * `CREATE INDEX ... USING hnsw` fails loudly on an oversized dimension — that
 * part is loud. The hazard is what happens *afterwards*: **the queries keep
 * working.** Postgres falls back to a sequential scan, which returns exact
 * nearest neighbours, so recall goes UP. Every test passes. The accuracy evals
 * pass *harder* than they will in production, because exact search beats
 * approximate search on recall. Latency is fine on any corpus small enough to
 * fit a dev fixture. Then the first real brain with 100k chunks turns every
 * query into a full table scan, and the symptom is "search got slow" — at the
 * exact moment the corpus becomes worth searching.
 *
 * An eval suite cannot catch this. The only signal is a query plan nobody reads.
 * So it is guarded in two places, which fail for different reasons:
 *
 *   **At migration-definition time**, with no database in sight: the declared
 *   dimension must stay inside the type's *index* ceiling, which sits far below
 *   its storage ceiling. `vector` stores 16,000 and HNSW-indexes 2,000;
 *   `text-embedding-3-large` is natively 3072. A future model swap that walks
 *   past the ceiling is rejected here rather than by production `CREATE INDEX`.
 *
 *   **At provisioning time**, against the tenant's own database: schema is
 *   applied per tenant, so a DDL step that fails on one tenant and succeeds on
 *   the next produces a fleet where some brains have a vector index and some do
 *   not, with no aggregate signal — the slow ones just look like unlucky users.
 *
 * Presence-checking the `CREATE INDEX` text in the schema file would pass in
 * both halves while the fleet drifted, which is why neither test below reads the
 * schema file for reassurance.
 */

import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createTenantSchemaApplier, readTenantDdl } from '../../src/schema/apply.ts';
import {
  CHUNK_EMBEDDING_COLUMN,
  CHUNK_TABLE,
  EMBEDDING_DIMENSIONS,
  HNSW_INDEXABLE_DIMENSIONS,
  MissingVectorIndexError,
  assertHnswIndex,
  findIndexableDimensionViolations,
  findIndexesOnColumn,
  findVectorDeclarations,
} from '../../src/schema/vector-index.ts';
import {
  FIXTURE_FTS_LANGUAGE,
  createEmptyDatabase,
  dropFixtureDatabase,
  provisionFixtureDatabase,
  type TenantFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

/** `text-embedding-3-large` at its native width — the dimension KTD8 rejected. */
const THREE_LARGE_NATIVE_DIMENSIONS = 3072;

const tenantDdl = await readTenantDdl();

describe('H2 — the declared dimension stays inside the type\'s index ceiling', () => {
  test('the scanner finds the declaration it is supposed to find', () => {
    // First, and load-bearing: a regex that silently matched nothing would make
    // every assertion below pass vacuously, which is the same class of quiet
    // failure this ledger exists to catch. So the guard asserts what the scan
    // FOUND, not only what it objected to.
    const declarations = findVectorDeclarations(tenantDdl);

    expect(declarations).toEqual([{ type: 'vector', dimensions: 1536, declaration: 'vector(1536)' }]);
  });

  test('the TypeScript constant and the DDL agree, by parsing rather than by trust', () => {
    const declared = findVectorDeclarations(tenantDdl).map((d) => d.dimensions);

    // If someone changes the column and not the constant — or the reverse — the
    // embedding pipeline and the storage disagree silently.
    expect(declared).toContain(EMBEDDING_DIMENSIONS);
  });

  test('the shipped tenant schema has no unindexable declaration', () => {
    expect(findIndexableDimensionViolations(tenantDdl)).toEqual([]);
    expect(EMBEDDING_DIMENSIONS).toBeLessThanOrEqual(HNSW_INDEXABLE_DIMENSIONS.vector);
  });

  test('a swap to 3-large at its native width is rejected here, not by production CREATE INDEX', () => {
    const swapped = tenantDdl.replace(
      `vector(${EMBEDDING_DIMENSIONS})`,
      `vector(${THREE_LARGE_NATIVE_DIMENSIONS})`,
    );
    // The rewrite has to have taken, or this asserts nothing.
    expect(swapped).not.toBe(tenantDdl);

    expect(findIndexableDimensionViolations(swapped)).toEqual([
      {
        type: 'vector',
        dimensions: THREE_LARGE_NATIVE_DIMENSIONS,
        declaration: `vector(${THREE_LARGE_NATIVE_DIMENSIONS})`,
        ceiling: HNSW_INDEXABLE_DIMENSIONS.vector,
      },
    ]);
  });

  test('the ceiling is per type — halfvec buys headroom, and it too runs out', () => {
    // The card names `halfvec(3072)` as the alternative escape from the 2,000
    // ceiling. A guard that hardcoded 2,000 would reject the correct answer.
    expect(findIndexableDimensionViolations('embedding halfvec(3072)')).toEqual([]);
    expect(findIndexableDimensionViolations('embedding halfvec(4000)')).toEqual([]);
    expect(findIndexableDimensionViolations('embedding halfvec(4001)')).toHaveLength(1);
    expect(findIndexableDimensionViolations('embedding vector(2000)')).toEqual([]);
    expect(findIndexableDimensionViolations('embedding vector(2001)')).toHaveLength(1);
  });

  test('prose about the ceiling is not mistaken for a declaration', () => {
    // The schema file necessarily discusses the dimensions that do NOT fit. A
    // scanner that read its own explanation would fail on the comment that
    // explains why it exists.
    expect(findVectorDeclarations('-- 3-large is vector(3072) natively\n')).toEqual([]);
    expect(findVectorDeclarations('/* halfvec(16000) stores fine */')).toEqual([]);
    expect(findIndexableDimensionViolations(`-- vector(3072)\nx vector(1536)`)).toEqual([]);
  });
});

describe('H2 — a tenant is not handed out without a usable vector index', () => {
  let healthy: TenantFixture;
  let healthySql: SQL;

  beforeAll(async () => {
    healthy = await provisionFixtureDatabase('h2');
    healthySql = new SQL(healthy.dsn, { max: 1 });
  }, { timeout: SETUP_TIMEOUT_MS });

  afterAll(async () => {
    await healthySql?.close();
    if (healthy !== undefined) await dropFixtureDatabase(healthy);
  }, { timeout: SETUP_TIMEOUT_MS });

  test(
    'provisioning the real schema leaves an hnsw index the assertion accepts',
    async () => {
      const index = await assertHnswIndex(healthySql, CHUNK_TABLE, CHUNK_EMBEDDING_COLUMN);

      expect(index.method).toBe('hnsw');
      expect(index.valid).toBe(true);
      expect(index.indexName).toBe('chunk_embedding_hnsw');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a tenant whose index DDL did not run FAILS PROVISIONING instead of serving slowly',
    async () => {
      // The fleet failure the card describes: one tenant's DDL step does not
      // run. Everything else about this database is correct, every query it
      // answers is correct, and it is broken.
      const withoutIndex = tenantDdl.replace(
        /^CREATE INDEX chunk_embedding_hnsw[^;]*;/m,
        '-- (the index step did not run on this tenant)',
      );
      expect(withoutIndex).not.toBe(tenantDdl);
      expect(withoutIndex).not.toContain('USING hnsw');

      const broken = await createEmptyDatabase('h2_no_index');
      try {
        const applier = createTenantSchemaApplier({ ddl: withoutIndex });

        // `apply` is the exact method `src/control/provision.ts` calls, and a
        // throw from it is recorded as `schema_apply_failed` — pinned by
        // `test/control/provision.test.ts`. So this rejection IS provisioning
        // failing loudly, not a test-only assertion standing next to it.
        const applying = applier.apply({
          connectionString: broken.dsn,
          ftsLanguage: FIXTURE_FTS_LANGUAGE,
        });

        await expect(applying).rejects.toThrow(MissingVectorIndexError);

        // And the tenant really is servable-but-slow, which is why nothing else
        // would have noticed: the table exists and answers queries.
        const sql = new SQL(broken.dsn, { max: 1 });
        try {
          const rows = await sql.unsafe<{ n: number }[]>('SELECT count(*)::int AS n FROM chunk');
          expect(rows[0]?.n).toBe(0);
          expect(await findIndexesOnColumn(sql, CHUNK_TABLE, CHUNK_EMBEDDING_COLUMN)).toEqual([]);
        } finally {
          await sql.close();
        }
      } finally {
        await dropFixtureDatabase(broken);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an index that exists but is not hnsw does not satisfy the assertion',
    async () => {
      // The check a presence-style guard would perform — "some index covers the
      // embedding column" — and the reason it is not enough.
      const other = await provisionFixtureDatabase('h2_wrong_method');
      const sql = new SQL(other.dsn, { max: 1 });
      try {
        await sql.unsafe('DROP INDEX chunk_embedding_hnsw');
        await sql.unsafe('CREATE INDEX chunk_embedding_btree ON chunk (embedding)');

        const found = await findIndexesOnColumn(sql, CHUNK_TABLE, CHUNK_EMBEDDING_COLUMN);
        expect(found.map((i) => i.method)).toEqual(['btree']);

        await expect(assertHnswIndex(sql, CHUNK_TABLE, CHUNK_EMBEDDING_COLUMN)).rejects.toThrow(
          MissingVectorIndexError,
        );
      } finally {
        await sql.close();
        await dropFixtureDatabase(other);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an hnsw index left invalid by a failed build does not satisfy the assertion either',
    async () => {
      // A build that fails partway leaves an index the planner will not use, so
      // the tenant is back to sequential scans while `pg_indexes` still lists a
      // perfectly plausible hnsw index. Existence is not usability.
      const remnant = await provisionFixtureDatabase('h2_invalid_index');
      const sql = new SQL(remnant.dsn, { max: 1 });
      try {
        await sql.unsafe(
          "UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'chunk_embedding_hnsw'::regclass",
        );

        const found = await findIndexesOnColumn(sql, CHUNK_TABLE, CHUNK_EMBEDDING_COLUMN);
        expect(found).toEqual([
          { indexName: 'chunk_embedding_hnsw', method: 'hnsw', valid: false },
        ]);

        await expect(assertHnswIndex(sql, CHUNK_TABLE, CHUNK_EMBEDDING_COLUMN)).rejects.toThrow(
          MissingVectorIndexError,
        );
      } finally {
        await sql.close();
        await dropFixtureDatabase(remnant);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
