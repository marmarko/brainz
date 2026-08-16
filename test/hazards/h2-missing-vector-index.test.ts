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
 *
 * **Two ways an index-presence check stays green over a live hazard**, both
 * found by adversarial review of the first version of this file and both closed
 * below, because each is a single-token edit:
 *
 *   * **A wrong opclass.** `USING hnsw (embedding vector_l2_ops)` on a column
 *     the arm reads with cosine `<=>` is a valid hnsw index the planner cannot
 *     use for that ordering. The plan falls back to a sequential scan *even
 *     under `enable_seqscan = off`*, because there is no alternative — exact
 *     neighbours, recall up, nothing errors. Presence of an hnsw index is not
 *     the property; being able to serve the operator the arm issues is.
 *
 *   * **A demotion.** Moving a queried column to `RESERVED_VECTOR_COLUMNS` and
 *     deleting its `CREATE INDEX` used to be accepted by everything: the
 *     registry checks were consistency checks *between the lists and the
 *     database*, and a column in the reserved list is supposed to have no index.
 *     What catches it is that a reserved column may not be `NOT NULL` — nothing
 *     computes an embedding for every row of a column it never reads.
 */

import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createTenantSchemaApplier, readTenantDdl } from '../../src/schema/apply.ts';
import { readLadderDdl } from '../../src/schema/migrations.ts';
import { HEAD_SCHEMA_VERSION } from '../../src/schema/migrations.ts';
import {
  CHUNK_EMBEDDING_COLUMN,
  CHUNK_TABLE,
  EMBEDDING_DIMENSIONS,
  HNSW_INDEXABLE_DIMENSIONS,
  INDEXED_VECTOR_COLUMNS,
  MissingVectorIndexError,
  RESERVED_VECTOR_COLUMNS,
  VectorColumnRegistryError,
  assertHnswIndex,
  assertVectorColumns,
  findIndexableDimensionViolations,
  findIndexesOnColumn,
  findVectorDeclarations,
  findVectorRegistryViolations,
  listVectorColumns,
  type CatalogVectorColumn,
} from '../../src/schema/vector-index.ts';
import {
  FIXTURE_FTS_LANGUAGE,
  createEmptyDatabase,
  dropFixtureDatabase,
  explainLines,
  provisionFixtureDatabase,
  type TenantFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

/** `text-embedding-3-large` at its native width — the dimension KTD8 rejected. */
const THREE_LARGE_NATIVE_DIMENSIONS = 3072;

const tenantDdl = await readTenantDdl();

/**
 * Every rung's DDL, concatenated.
 *
 * The scans below used to read rung one alone, which was the whole schema when
 * one model could ever be routed. The column the arm reads is now declared by a
 * later rung, so a scan of the baseline would be checking the dimension of a
 * column nothing queries — H2's own failure shape, applied to H2's guard. The
 * migration runner checks each rung at execution
 * (`src/control/migrate.ts:ddlFor`); this checks the ladder as a whole.
 */
const ladderDdl = (await readLadderDdl()).map(({ ddl }) => ddl).join('\n');

/** The index rung 13 built for the active seat, named the way that rung names it. */
const ACTIVE_INDEX_NAME = `chunk_${CHUNK_EMBEDDING_COLUMN}_hnsw`;

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
    const declared = findVectorDeclarations(ladderDdl).map((d) => d.dimensions);

    // If someone changes the column and not the constant — or the reverse — the
    // embedding pipeline and the storage disagree silently.
    expect(declared).toContain(EMBEDDING_DIMENSIONS);
  });

  test('the shipped tenant schema has no unindexable declaration', () => {
    expect(findIndexableDimensionViolations(ladderDdl)).toEqual([]);
    expect(EMBEDDING_DIMENSIONS).toBeLessThanOrEqual(HNSW_INDEXABLE_DIMENSIONS.vector);
  });

  test('a swap to 3-large at its native width is rejected here, not by production CREATE INDEX', () => {
    const swapped = ladderDdl.replace(
      `vector(${EMBEDDING_DIMENSIONS})`,
      `vector(${THREE_LARGE_NATIVE_DIMENSIONS})`,
    );
    // The rewrite has to have taken, or this asserts nothing.
    expect(swapped).not.toBe(ladderDdl);

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
      expect(index.indexName).toBe(ACTIVE_INDEX_NAME);
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
          // Rung one's index is the one this mutation removed — `baselineDdl`
          // overrides that rung and no other — so it is rung one's column that
          // has none. Provisioning still fails, above, because
          // `assertIndexedVectorColumns` walks every registered seat's column
          // rather than the active one alone: a seat added later must not make
          // an earlier seat's missing index invisible.
          expect(await findIndexesOnColumn(sql, CHUNK_TABLE, 'embedding')).toEqual([]);
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
        await sql.unsafe(`DROP INDEX ${ACTIVE_INDEX_NAME}`);
        await sql.unsafe(`CREATE INDEX chunk_seat_btree ON chunk (${CHUNK_EMBEDDING_COLUMN})`);

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
          `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '${ACTIVE_INDEX_NAME}'::regclass`,
        );

        const found = await findIndexesOnColumn(sql, CHUNK_TABLE, CHUNK_EMBEDDING_COLUMN);
        expect(found).toEqual([
          {
            indexName: ACTIVE_INDEX_NAME,
            method: 'hnsw',
            valid: false,
            opclass: 'vector_cosine_ops',
            servesOperator: true,
          },
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

  test(
    'every indexed column can actually be ORDER BY-ed through its index — asserted from the plan',
    async () => {
      // The assertion that grows with the registry rather than behind it. The
      // catalog checks above ask whether an index exists and whether its opclass
      // is right; this asks the planner, which is the only party whose opinion
      // decides whether production does a sequential scan. `enable_seqscan` is
      // off, so a plan that still says Seq Scan says the planner had no
      // alternative — H2, exactly.
      const columns = await listVectorColumns(healthySql);
      const dimensionOf = new Map(columns.map((c) => [`${c.table}.${c.column}`, c.type]));
      const checked: string[] = [];

      for (const column of INDEXED_VECTOR_COLUMNS) {
        if (column.since > HEAD_SCHEMA_VERSION) continue;
        const declared = dimensionOf.get(`${column.table}.${column.column}`);
        // The registry names a column the database does not have: a finding, not
        // a skip. A `continue` here would make this loop vacuous the moment a
        // table was renamed.
        expect(declared).toBeDefined();
        const dimensions = Number(/\((\d+)\)/.exec(declared ?? '')?.[1]);
        expect(Number.isSafeInteger(dimensions)).toBe(true);

        // Built from the column's own declared type, so this test does not carry
        // a second copy of the dimension that could drift from the schema.
        const probe = `('[1' || repeat(',0', ${dimensions - 1}) || ']')::${declared}`;
        const accepted = await assertHnswIndex(
          healthySql,
          column.table,
          column.column,
          column.operator,
        );

        const plan = await healthySql.begin(async (tx) => {
          await tx.unsafe('SET LOCAL enable_seqscan = off');
          return {
            value: await explainLines(
              tx,
              `SELECT 1 FROM ${column.table} ORDER BY ${column.column} ${column.operator} ${probe} LIMIT 10`,
            ),
          };
        });

        const lines = (plan as { value: string[] }).value;
        expect(lines.some((line) => line.includes(`Index Scan using ${accepted.indexName}`))).toBe(
          true,
        );
        checked.push(`${column.table}.${column.column}`);
      }

      // The loop must have run. A registry that emptied itself would otherwise
      // report a clean sheet, which is the failure this whole file is about.
      expect(checked).toEqual(INDEXED_VECTOR_COLUMNS.map((c) => `${c.table}.${c.column}`));
      expect(checked.length).toBeGreaterThan(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an hnsw index built for the wrong distance is refused — and the planner agrees',
    async () => {
      // One token: `vector_l2_ops` where the arm issues cosine `<=>`. Every
      // presence-style check passes — the index is hnsw, valid, on the right
      // column, and `pg_indexes` shows nothing odd.
      const wrong = await provisionFixtureDatabase('h2_wrong_opclass');
      const sql = new SQL(wrong.dsn, { max: 1 });
      try {
        await sql.unsafe(`DROP INDEX ${ACTIVE_INDEX_NAME}`);
        await sql.unsafe(
          `CREATE INDEX ${ACTIVE_INDEX_NAME} ON chunk USING hnsw (${CHUNK_EMBEDDING_COLUMN} vector_l2_ops)`,
        );

        const found = await findIndexesOnColumn(sql, CHUNK_TABLE, CHUNK_EMBEDDING_COLUMN);
        expect(found).toEqual([
          {
            indexName: ACTIVE_INDEX_NAME,
            method: 'hnsw',
            valid: true,
            opclass: 'vector_l2_ops',
            servesOperator: false,
          },
        ]);

        // The mechanism, measured rather than asserted: with the wrong opclass
        // there is no index the planner can use for a cosine ordering, so it
        // sequentially scans even when told not to.
        const plan = await sql.begin(async (tx) => {
          await tx.unsafe('SET LOCAL enable_seqscan = off');
          return {
            value: await explainLines(
              tx,
              `SELECT 1 FROM chunk ORDER BY ${CHUNK_EMBEDDING_COLUMN} <=> ('[1' || repeat(',0', ${EMBEDDING_DIMENSIONS - 1}) || ']')::vector(${EMBEDDING_DIMENSIONS}) LIMIT 10`,
            ),
          };
        });
        const lines = (plan as { value: string[] }).value;
        expect(lines.some((line) => line.includes('Seq Scan on chunk'))).toBe(true);
        expect(lines.some((line) => line.includes('Index Scan using'))).toBe(false);

        // And the same index IS usable for the distance it was built for, which
        // is what makes this a wrong-operator finding rather than a broken index.
        await expect(
          assertHnswIndex(sql, CHUNK_TABLE, CHUNK_EMBEDDING_COLUMN, '<->'),
        ).resolves.toMatchObject({ opclass: 'vector_l2_ops' });

        await expect(assertHnswIndex(sql, CHUNK_TABLE, CHUNK_EMBEDDING_COLUMN)).rejects.toThrow(
          MissingVectorIndexError,
        );
        await expect(assertVectorColumns(sql, HEAD_SCHEMA_VERSION)).rejects.toThrow(
          MissingVectorIndexError,
        );
      } finally {
        await sql.close();
        await dropFixtureDatabase(wrong);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('H2 — the registry is checked against the database, not read as prose', () => {
  const catalog = (
    table: string,
    column: string,
    notNull: boolean,
    type = 'vector(1536)',
  ): CatalogVectorColumn => ({ table, column, type, notNull });

  test('the shipped registry agrees with the shipped schema', () => {
    // The control case. Every assertion below is about a registry that is wrong;
    // this is the one that says the rule does not reject the right answer.
    expect(
      findVectorRegistryViolations([
        ...INDEXED_VECTOR_COLUMNS.map((c) => catalog(c.table, c.column, false)),
        ...RESERVED_VECTOR_COLUMNS.map((c) => catalog(c.table, c.column, false)),
      ]),
    ).toEqual([]);
  });

  test('a vector column in neither list is a finding', () => {
    // The original H2 shape one level up: the guard covers the columns it was
    // told about, and reports green for the fleet.
    const findings = findVectorRegistryViolations([catalog('note', 'embedding', false)]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('note.embedding');
  });

  test('a NOT NULL vector column cannot be filed as reserved', () => {
    // The demotion, caught. `fact.embedding` is NOT NULL because a fact is
    // embedded synchronously on the write path — which is a statement that
    // something computes this vector for every row, and nothing pays that for a
    // column it never reads.
    const reserved = RESERVED_VECTOR_COLUMNS[0];
    expect(reserved).toBeDefined();
    const findings = findVectorRegistryViolations([
      catalog(reserved?.table ?? '', reserved?.column ?? '', true),
    ]);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('NOT NULL');

    // And nullable is fine, which is what makes the rule usable: a reserved
    // column is one nothing fills.
    expect(
      findVectorRegistryViolations([catalog(reserved?.table ?? '', reserved?.column ?? '', false)]),
    ).toEqual([]);
  });

  test(
    'provisioning runs this against the real catalog, and the shipped schema passes it',
    async () => {
      const healthy = await provisionFixtureDatabase('h2_registry');
      const sql = new SQL(healthy.dsn, { max: 1 });
      try {
        const columns = await listVectorColumns(sql);
        // Read from the catalog, so a column added to the DDL without being
        // registered fails here rather than in whatever queries it next year.
        expect(columns.map((c) => `${c.table}.${c.column}`).sort()).toEqual(
          [
            ...INDEXED_VECTOR_COLUMNS.map((c) => `${c.table}.${c.column}`),
            ...RESERVED_VECTOR_COLUMNS.map((c) => `${c.table}.${c.column}`),
          ].sort(),
        );
        expect(findVectorRegistryViolations(columns)).toEqual([]);
        await expect(assertVectorColumns(sql, HEAD_SCHEMA_VERSION)).resolves.toHaveLength(
          INDEXED_VECTOR_COLUMNS.length,
        );

        // An index appearing on a reserved column is the mirror failure: either
        // a copied migration, or a column that became queried without its entry
        // moving. Both are findings.
        const reserved = RESERVED_VECTOR_COLUMNS[0];
        expect(reserved).toBeDefined();
        await sql.unsafe(
          `CREATE INDEX reserved_probe_hnsw ON ${reserved?.table} USING hnsw (${reserved?.column} vector_cosine_ops)`,
        );
        await expect(assertVectorColumns(sql, HEAD_SCHEMA_VERSION)).rejects.toThrow(
          VectorColumnRegistryError,
        );
      } finally {
        await sql.close();
        await dropFixtureDatabase(healthy);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
