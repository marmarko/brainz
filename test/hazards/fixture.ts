/**
 * The corpus the three retrieval hazards are measured against, and the
 * throwaway tenant database it lives in.
 *
 * Not a `*.test.ts` file, so `registry-consistency.test.ts` does not scan it.
 *
 * **Why the fixture is shaped the way it is.** Every card in
 * `docs/porting-hazards.md` shares one property: it is invisible on a small dev
 * corpus. A guard seeded under 40 chunks passes forever and is worse than no
 * guard, because it reports green for the exact condition it was written to
 * catch. So the numbers here are load-bearing, not arbitrary, and the guards
 * assert them **from the database** rather than from these constants — a
 * fixture that failed to seed must fail the guard, not shrink it.
 *
 * The layout, from the query vector outwards:
 *
 *   1. {@link NEAR_DECOY_CHUNKS} rows that do NOT qualify, placed *nearest*.
 *      They are what makes H3 different from H1: production predicates run
 *      after the HNSW scan, so these consume the candidate budget and are then
 *      discarded. One third fails the origin fence (R15), one third is
 *      soft-deleted (R12), one third is junk-quarantined (U9) — the ordinary
 *      steady state of a brain with a work grant, some tombstones and a
 *      quarantined newsletter backlog, not an edge case.
 *   2. {@link QUALIFYING_CHUNKS} rows that DO qualify, immediately behind them.
 *   3. {@link BACKGROUND_CHUNKS} far filler, so the HNSW graph is not degenerate
 *      and the corpus is not a toy.
 *
 * **The distances are constructed, not random.** Each embedding is
 * `[1, t, 0, 0, …]` and the query is `[1, 0, 0, …]`; cosine distance is
 * `1 - 1/sqrt(1 + t²)`, which rises monotonically with `t`. So `t` *is* the
 * rank, exactly, and "the decoys are nearer than the qualifying rows" is a
 * property of the fixture rather than a hope about a random draw.
 */

import { SQL } from 'bun';

import { createTenantSchemaApplier } from '../../src/schema/apply.ts';
import { EMBEDDING_DIMENSIONS } from '../../src/schema/vector-index.ts';

/**
 * The CI form is the default, per `.github/workflows/ci.yml`, so the same file
 * runs unchanged in both places: CI's service container publishes 5432, and a
 * local container on another port is selected by exporting `DATABASE_URL`.
 * These hazards are **not** gated behind a flag — the service container is
 * always present, and a guard that skips itself is the unguarded state wearing
 * a green tick.
 */
export const ADMIN_DSN =
  process.env['DATABASE_URL'] ?? 'postgres://postgres@localhost:5432/brainz_test';

/** Deliberately not English: KTD9's silent-fallback failure must not pass. */
export const FIXTURE_FTS_LANGUAGE = 'simple';

/**
 * The decoys, and the number that decides whether H3's guard can go red at all.
 *
 * Every decoy sits NEARER the query than every qualifying row, so without the
 * iterative scan a pool of {@link CANDIDATE_POOL} spends this many candidates on
 * rows the filter then discards: the arm yields `CANDIDATE_POOL - NEAR_DECOY_CHUNKS`.
 * At 100 that arithmetic gave exactly 150 against a floor of 200 — a 50-row
 * margin, which is to say the fixture was calibrated to the boundary of its own
 * assertion, and weakening either number by one step made both headline
 * assertions pass with the hazard live. At 150 the unremedied yield is 100
 * against the same floor, and the margin is no longer a rounding error.
 *
 * The margin is not defended by this comment. `h3-post-filter-recall.test.ts`
 * measures the unremedied yield directly and fails if it is not comfortably
 * below the floor — a fixture that stops exhibiting the collapse fails the guard
 * rather than quietly passing it.
 */
export const NEAR_DECOY_CHUNKS = 150;
export const QUALIFYING_CHUNKS = 250;
export const BACKGROUND_CHUNKS = 4600;

/** What the retrieval stack asks the vector arm for in `tokenmax`: 50 × 5. */
export const CANDIDATE_POOL = 250;

/** H1's and H3's assertion floor, straight from the ledger. */
export const REQUIRED_YIELD = 200;

/**
 * How far below the floor the *unremedied* arm has to fall for the guard to be
 * worth anything.
 *
 * A guard whose remedy-on and remedy-off measurements sit either side of the
 * floor by one row is a guard that passes as soon as anything drifts. This is
 * the headroom H3 asserts it still has, measured rather than computed — see
 * {@link REQUIRED_YIELD} and the control arm in `h3-post-filter-recall.test.ts`.
 */
export const COLLAPSE_MARGIN = 50;

/**
 * The query vector, as SQL. Built by repetition rather than written out so the
 * dimension is derived from {@link EMBEDDING_DIMENSIONS} and cannot drift from
 * the column it is compared against.
 */
export const QUERY_VECTOR_SQL = `('[1' || repeat(',0', ${EMBEDDING_DIMENSIONS - 1}) || ']')::vector(${EMBEDDING_DIMENSIONS})`;

/** The three predicates every production read carries (R15, R12, U9). */
export const PRODUCTION_PREDICATES = `origin_context = 'personal'
       AND deleted_at IS NULL
       AND quarantined_at IS NULL`;

/**
 * The candidate query, in the two shapes the ledger demands: unfiltered (H1)
 * and production-shaped (H3). One builder so the two guards cannot drift into
 * measuring different queries.
 */
export function candidateQuery(options: { readonly filtered: boolean; readonly limit: number }): string {
  const where = options.filtered ? `WHERE ${PRODUCTION_PREDICATES}` : 'WHERE embedding IS NOT NULL';
  return `SELECT chunk_id
    FROM chunk
    ${where}
    ORDER BY embedding <=> ${QUERY_VECTOR_SQL}
    LIMIT ${options.limit}`;
}

/**
 * One candidate as the driver hands it back. `chunk_id` is a `bigint` column,
 * and Bun renders those as strings rather than as JS numbers — typing it as
 * `number` would compile and then silently fail every numeric check.
 */
export interface CandidateRow {
  readonly chunk_id: string;
}

function databaseUrlFor(database: string): string {
  const url = new URL(ADMIN_DSN);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * A database name that is legal unquoted and unique to one guard file, so two
 * files cannot collide and a leftover from a killed run is recognisably ours.
 */
export function fixtureDatabaseName(slug: string): string {
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(slug)) throw new Error(`unusable fixture slug: ${slug}`);
  return `brainz_hazard_${slug}`;
}

export interface TenantFixture {
  readonly dsn: string;
  readonly database: string;
}

/**
 * An empty throwaway database — the state a Neon project is in after
 * `createRoleAndDatabase` and before any schema has been applied.
 */
export async function createEmptyDatabase(slug: string): Promise<TenantFixture> {
  const database = fixtureDatabaseName(slug);
  const admin = new SQL(ADMIN_DSN, { max: 1 });
  try {
    // Identifier, so it cannot be a parameter. The name is derived above from a
    // slug matched against an anchored pattern, never from input.
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${database}`);
  } finally {
    await admin.close();
  }
  return { dsn: databaseUrlFor(database), database };
}

/**
 * Creates a throwaway database and applies the tenant schema **through the real
 * provisioning applier**. Going through `createTenantSchemaApplier` rather than
 * running the DDL directly is the point: H2's assertion is only worth anything
 * if it sits on the path provisioning actually takes.
 */
export async function provisionFixtureDatabase(
  slug: string,
  options: { readonly ddl?: string } = {},
): Promise<TenantFixture> {
  const fixture = await createEmptyDatabase(slug);
  const applier = createTenantSchemaApplier(options.ddl === undefined ? {} : { ddl: options.ddl });
  await applier.apply({ connectionString: fixture.dsn, ftsLanguage: FIXTURE_FTS_LANGUAGE });
  return fixture;
}

export async function dropFixtureDatabase(fixture: TenantFixture): Promise<void> {
  const admin = new SQL(ADMIN_DSN, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${fixture.database} WITH (FORCE)`);
  } finally {
    await admin.close();
  }
}

/**
 * Seeds the corpus described at the top of this file.
 *
 * `ANALYZE` at the end because a planner working from no statistics is a
 * planner making a different decision than the one the guards then assert.
 */
export async function seedCorpus(sql: SQL): Promise<void> {
  const embedding = (offset: string): string =>
    `('[1,' || (${offset})::text || repeat(',0', ${EMBEDDING_DIMENSIONS - 2}) || ']')::vector(${EMBEDDING_DIMENSIONS})`;

  // Nearest: the rows every production predicate throws away. Interleaved
  // across all three exclusions rather than one, because a brain in its
  // ordinary steady state carries all three at once.
  await sql.unsafe(`
    INSERT INTO chunk (origin_context, content, embedding, deleted_at, quarantined_at)
    SELECT CASE WHEN i % 3 = 0 THEN 'work' ELSE 'personal' END,
           'decoy ' || i,
           ${embedding('i * 0.001')},
           CASE WHEN i % 3 = 1 THEN now() ELSE NULL END,
           CASE WHEN i % 3 = 2 THEN now() ELSE NULL END
    FROM generate_series(1, ${NEAR_DECOY_CHUNKS}) i
  `);

  // Immediately behind them: the rows that must survive every predicate.
  await sql.unsafe(`
    INSERT INTO chunk (origin_context, content, embedding)
    SELECT 'personal',
           'qualifying ' || i,
           ${embedding(`(${NEAR_DECOY_CHUNKS} + i) * 0.001`)}
    FROM generate_series(1, ${QUALIFYING_CHUNKS}) i
  `);

  // Far filler, so the graph is not degenerate.
  await sql.unsafe(`
    INSERT INTO chunk (origin_context, content, embedding)
    SELECT 'personal',
           'background ' || i,
           ${embedding('5 + i * 0.001')}
    FROM generate_series(1, ${BACKGROUND_CHUNKS}) i
  `);

  await sql.unsafe('ANALYZE chunk');
}

/** How many rows in the database actually satisfy every production predicate. */
export async function countQualifying(sql: SQL): Promise<number> {
  const rows = await sql.unsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM chunk WHERE ${PRODUCTION_PREDICATES} AND embedding IS NOT NULL`,
  );
  return rows[0]?.n ?? -1;
}

/** How many rows match the query at all, ignoring the production predicates. */
export async function countEmbedded(sql: SQL): Promise<number> {
  const rows = await sql.unsafe<{ n: number }[]>(
    'SELECT count(*)::int AS n FROM chunk WHERE embedding IS NOT NULL',
  );
  return rows[0]?.n ?? -1;
}

/**
 * `EXPLAIN` for a query, flattened to lines.
 *
 * Every guard here asserts the plan, and that assertion is not decoration. At
 * fixture scale Postgres prefers a **sequential scan** over the HNSW index —
 * `vector(1536)` is stored out of line, so the heap looks tiny and the cost
 * model never charges for detoasting. A seq scan returns *exact* neighbours,
 * which means an unasserted guard passes with full recall while measuring a
 * query path production never takes. That is precisely H2's mechanism turning
 * up inside H1's guard.
 */
export async function explainLines(sql: SQL, query: string): Promise<string[]> {
  const rows = await sql.unsafe<Record<string, string>[]>(`EXPLAIN (COSTS OFF) ${query}`);
  return rows.map((row) => Object.values(row)[0] ?? '');
}

/**
 * The plan must be an HNSW index scan. The guards force it (see
 * {@link FORCE_INDEX_SCAN}); this is what proves the force took, which is what
 * makes forcing it non-circular.
 */
export function usesHnswIndexScan(plan: readonly string[], indexName = 'chunk_embedding_hnsw'): boolean {
  return plan.some((line) => line.includes(`Index Scan using ${indexName}`));
}

/**
 * Test-side only, and never in `src/`.
 *
 * The honest alternative — a corpus large enough that the planner reaches for
 * the index unaided — measures at roughly 50,000 chunks of 1536 dimensions on
 * this substrate, which is a multi-hundred-megabyte fixture and an HNSW build
 * far too slow for the PR-blocking tier. Forcing the plan is what lets a
 * fixture-scale corpus exercise the production-scale path; the `EXPLAIN`
 * assertion above is the licence for doing so.
 */
export const FORCE_INDEX_SCAN = 'SET LOCAL enable_seqscan = off';
