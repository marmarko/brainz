/**
 * H1 — Silent candidate-pool truncation via `hnsw.ef_search`.
 *
 * See `docs/porting-hazards.md` for the full card. The mechanism in one line:
 * pgvector defaults `hnsw.ef_search` to **40**, and an HNSW scan returns at most
 * that many rows *regardless of what the query's LIMIT asks for* — the GUC sizes
 * the candidate list, so it caps the row count before LIMIT is applied.
 *
 * Nothing errors. The query succeeds and returns plausible results, and every
 * downstream stage silently operates on a fraction of the pool it was designed
 * for: RRF fusion ranks a truncated universe, per-page collapse dedupes 40
 * chunks instead of 250, rerank cannot recover what never arrived, and autocut
 * fires on a score distribution that does not exist at n=40. It looks like "our
 * ranking is mediocre", not "one GUC is unset".
 *
 * **This is a behavioural guard, and it has to be.** A lint that greps for
 * `ef_search` near the query passes while the setting evaporates: on a pooled
 * connection a bare `SET` either leaks to the next tenant's query or is gone
 * before this one runs, depending on pooling mode. That is the actual failure
 * mode, so the last test in this file exercises it directly.
 *
 * Three ways this guard could pass while the hazard is live, all closed below:
 *
 *   1. **Fixture too small.** Under 40 matching chunks the index returns
 *      everything anyway. Asserted from the database, not from a constant.
 *   2. **Sequential scan.** At fixture scale Postgres prefers a seq scan, which
 *      returns exact neighbours and full recall — a green tick for a query path
 *      production never takes. The plan is asserted.
 *   3. **The helper not being on the path.** The query runs through
 *      `withVectorScan`, the one helper every vector query goes through, rather
 *      than through hand-written SQL that sets the GUC itself.
 */

import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  HNSW_EF_SEARCH_DEFAULT,
  HNSW_EF_SEARCH_MAX,
  HNSW_ITERATIVE_SCAN_MODE,
  candidatePoolFor,
  withVectorScan,
} from '../../src/schema/vector-query.ts';
import {
  CANDIDATE_POOL,
  FORCE_INDEX_SCAN,
  REQUIRED_YIELD,
  candidateQuery,
  countEmbedded,
  dropFixtureDatabase,
  explainLines,
  provisionFixtureDatabase,
  seedCorpus,
  usesHnswIndexScan,
  type CandidateRow,
  type TenantFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

let fixture: TenantFixture;
let sql: SQL;

beforeAll(async () => {
  fixture = await provisionFixtureDatabase('h1');
  sql = new SQL(fixture.dsn, { max: 1 });
  await seedCorpus(sql);
}, { timeout: SETUP_TIMEOUT_MS });

afterAll(async () => {
  await sql?.close();
  if (fixture !== undefined) await dropFixtureDatabase(fixture);
}, { timeout: SETUP_TIMEOUT_MS });

describe('H1 — the candidate pool the vector arm asked for is the pool it gets', () => {
  test(
    'the fixture is big enough for the truncation to be observable at all',
    async () => {
      const embedded = await countEmbedded(sql);

      // The ledger's own words: "a guard seeded with fewer than 40 chunks
      // silently passes forever and is worse than no guard." Both floors are
      // asserted because they say different things — one is the hazard's
      // threshold, the other is the guard's.
      expect(embedded).toBeGreaterThan(HNSW_EF_SEARCH_DEFAULT);
      expect(embedded).toBeGreaterThanOrEqual(REQUIRED_YIELD);
      expect(embedded).toBeGreaterThanOrEqual(CANDIDATE_POOL);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a 250-candidate request through the helper returns at least 200 candidates',
    async () => {
      const query = candidateQuery({ filtered: false, limit: CANDIDATE_POOL });

      const { rows, plan } = await withVectorScan(sql, { candidatePool: CANDIDATE_POOL }, async (tx) => {
        await tx.unsafe(FORCE_INDEX_SCAN);
        // The plan is read inside the same transaction as the measurement, so
        // it describes the query that was actually counted.
        const explained = await explainLines(tx, query);
        const found = await tx.unsafe<CandidateRow[]>(query);
        return { rows: found, plan: explained };
      });

      // Closes the vacuous-pass-by-sequential-scan hole. A seq scan is exact,
      // so without this the guard reports green on the one plan that cannot
      // exhibit the hazard.
      expect(usesHnswIndexScan(plan)).toBe(true);

      expect(rows.length).toBeGreaterThanOrEqual(REQUIRED_YIELD);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'both GUCs are in effect inside the helper\'s own transaction, at the values it chose',
    async () => {
      // **Why a settings assertion sits next to a yield assertion.** Measured on
      // this substrate: with `hnsw.iterative_scan` on, deleting the
      // `hnsw.ef_search` statement changes the yield of the test above by
      // nothing at all — the iterative scan resumes and refills the pool from a
      // 40-row batch, so the ledger's H1 guard as specified stays green while
      // the setting it exists to pin is gone. H3's remedy masks H1's.
      //
      // So the pool size is pinned where the mask cannot reach: inside the
      // transaction the query runs in. This is still the behaviour a grep
      // cannot see — `current_setting` reports what is in effect for *this*
      // transaction on *this* pooled connection, which is precisely what a bare
      // `SET` outside the transaction fails to deliver.
      const settings = await withVectorScan(sql, { candidatePool: CANDIDATE_POOL }, async (tx) => {
        const rows = await tx.unsafe<{ ef: string; iterative: string }[]>(
          `SELECT current_setting('hnsw.ef_search')      AS ef,
                  current_setting('hnsw.iterative_scan') AS iterative`,
        );
        return rows[0];
      });

      expect(settings?.ef).toBe(String(CANDIDATE_POOL));
      expect(settings?.iterative).toBe(HNSW_ITERATIVE_SCAN_MODE);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the pool the arm asks for is a pool, not a limit',
    () => {
      // What this file cannot otherwise pin. Every test here calls the helper
      // directly, so they measure the helper's transaction mechanics — not that
      // the retrieval arm (U5) hands it `offset + max(limit * 5, 100)` rather
      // than a bare `limit`. A caller passing `limit` sets `ef_search` to 10 or
      // 25 and truncates the pool *below* pgvector's own default, with every
      // guard in this file still green. Naming the arithmetic is what makes the
      // wrong call a visible mistake rather than a plausible one.
      expect(candidatePoolFor({ limit: 10 })).toBe(100); // conservative
      expect(candidatePoolFor({ limit: 25 })).toBe(125); // balanced
      expect(candidatePoolFor({ limit: 50 })).toBe(CANDIDATE_POOL); // tokenmax
      expect(candidatePoolFor({ limit: 50, offset: 50 })).toBe(CANDIDATE_POOL + 50);

      // The floor is the half that is easy to drop: at small limits the
      // multiplier alone gives a pool barely above the default this module
      // exists to raise.
      expect(candidatePoolFor({ limit: 1 })).toBeGreaterThan(HNSW_EF_SEARCH_DEFAULT);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a pool request above pgvector\'s hard ceiling is clamped, not silently rejected',
    async () => {
      // The GUC's ceiling is 1000. A caller asking for more must still get a
      // set value rather than an error the retrieval stack would have to catch.
      const ef = await withVectorScan(sql, { candidatePool: 5000 }, async (tx) => {
        const rows = await tx.unsafe<{ ef: string }[]>(
          `SELECT current_setting('hnsw.ef_search') AS ef`,
        );
        return rows[0]?.ef;
      });
      expect(ef).toBe(String(HNSW_EF_SEARCH_MAX));
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the remedy is transaction-scoped: SET LOCAL does not leak across a pooled connection',
    async () => {
      // `max: 1` is the whole point — every statement below runs on one backend,
      // which is what a per-tenant connection LRU looks like from the database's
      // side. A leaked GUC here is a cross-tenant correctness bug, not just a
      // correctness bug.
      const before = await sql.unsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
      // Named before it is compared: two `undefined`s are equal, and a
      // connection-identity check that passes on missing data proves nothing.
      const backendPid = before[0]?.pid;
      expect(typeof backendPid).toBe('number');

      await withVectorScan(sql, { candidatePool: CANDIDATE_POOL }, async (tx) => {
        await tx.unsafe(FORCE_INDEX_SCAN);
        // Runs a real vector query first, deliberately. `SHOW hnsw.ef_search`
        // raises "unrecognized configuration parameter" until the extension is
        // loaded into the session, so a probe that asked before touching the
        // index would fail for the wrong reason and prove nothing.
        return tx.unsafe(candidateQuery({ filtered: false, limit: CANDIDATE_POOL }));
      });

      const after = await sql.unsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid');
      // If the pool handed out a second connection, the leak test below would
      // pass for the wrong reason.
      expect(after[0]?.pid).toBe(backendPid as number);

      const ef = await sql.unsafe<Record<string, string>[]>('SHOW hnsw.ef_search');
      const iterative = await sql.unsafe<Record<string, string>[]>('SHOW hnsw.iterative_scan');

      expect(Object.values(ef[0] ?? {})[0]).toBe(String(HNSW_EF_SEARCH_DEFAULT));
      expect(Object.values(iterative[0] ?? {})[0]).toBe('off');
    },
    TEST_TIMEOUT_MS,
  );
});
