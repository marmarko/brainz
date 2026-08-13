/**
 * H3 — Post-filter recall collapse (H1 one layer down).
 *
 * See `docs/porting-hazards.md` for the full card. pgvector applies a query's
 * `WHERE` predicates **after** the HNSW scan returns its `ef_search` candidates,
 * so the GUC sizes the *scan* and not the *qualifying yield*. Raising
 * `hnsw.ef_search` to the requested pool size — H1's entire fix — buys nothing
 * once a filter is present: the scan returns N candidates, the filter discards
 * most of them, and the arm yields far fewer than the pool it was asked for even
 * though the corpus holds plenty of qualifying rows.
 *
 * **Why H1's guard cannot see this.** H1's is specified unfiltered. With no
 * `WHERE` clause it passes at any `ef_search` above the pool size and keeps
 * passing forever, while production — which never issues an unfiltered vector
 * query — starves exactly as H1 described. This file re-runs H1's fixture
 * through the three predicates every read here carries: the origin fence (R15),
 * the soft-delete exclusion (R12), and the junk-quarantine filter (U9). A brain
 * with a work grant, some tombstoned pages and a quarantined newsletter backlog
 * is the ordinary steady state, not an edge case.
 *
 * **Measured on this substrate before it was written**, because a guard that
 * cannot go red is worse than none: pgvector 0.8.6 on PostgreSQL 17.10 ships
 * `hnsw.iterative_scan` defaulting to `off`, and at this fixture's shape a
 * 250-candidate request under the production predicates yields **150** rows
 * without it and 250 with it. The collapse is real here and now, not a hazard
 * inherited on paper.
 */

import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  HNSW_MAX_SCAN_TUPLES_DEFAULT,
  withVectorScan,
} from '../../src/schema/vector-query.ts';
import {
  CANDIDATE_POOL,
  FORCE_INDEX_SCAN,
  NEAR_DECOY_CHUNKS,
  REQUIRED_YIELD,
  candidateQuery,
  countQualifying,
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
  fixture = await provisionFixtureDatabase('h3');
  sql = new SQL(fixture.dsn, { max: 1 });
  await seedCorpus(sql);
}, { timeout: SETUP_TIMEOUT_MS });

afterAll(async () => {
  await sql?.close();
  if (fixture !== undefined) await dropFixtureDatabase(fixture);
}, { timeout: SETUP_TIMEOUT_MS });

describe('H3 — the pool survives the predicates every production read carries', () => {
  test(
    'the fixture holds enough qualifying rows, and enough excluded rows nearer than they are',
    async () => {
      const qualifying = await countQualifying(sql);

      // Same floor as H1, on the population that actually has to come back.
      expect(qualifying).toBeGreaterThanOrEqual(REQUIRED_YIELD);
      expect(qualifying).toBeGreaterThanOrEqual(CANDIDATE_POOL);

      // And the half that makes this test different from H1's. Every decoy sits
      // NEARER the query than every qualifying row, so a scan sized to the pool
      // spends this many of its candidates on rows the filter will discard. If
      // that headroom ever drops below the gap between the pool and the required
      // yield, the collapse stops being observable and this guard goes quiet.
      const excludedRows = await sql.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n
           FROM chunk
          WHERE embedding IS NOT NULL
            AND NOT (origin_context = 'personal' AND deleted_at IS NULL AND quarantined_at IS NULL)`,
      );
      expect(excludedRows[0]?.n).toBe(NEAR_DECOY_CHUNKS);
      expect(NEAR_DECOY_CHUNKS).toBeGreaterThan(CANDIDATE_POOL - REQUIRED_YIELD);

      // All three exclusions are represented. A fixture that lost two of them
      // would still be "filtered", and would still be testing less than the
      // product issues.
      const byReason = await sql.unsafe<{ fenced: number; deleted: number; quarantined: number }[]>(
        `SELECT count(*) FILTER (WHERE origin_context <> 'personal')::int AS fenced,
                count(*) FILTER (WHERE deleted_at IS NOT NULL)::int      AS deleted,
                count(*) FILTER (WHERE quarantined_at IS NOT NULL)::int  AS quarantined
           FROM chunk`,
      );
      expect(byReason[0]?.fenced).toBeGreaterThan(0);
      expect(byReason[0]?.deleted).toBeGreaterThan(0);
      expect(byReason[0]?.quarantined).toBeGreaterThan(0);

      // A scope limit, stated rather than left for someone to discover. The
      // remedy this guard pins — an iterative scan — is itself bounded by
      // `hnsw.max_scan_tuples`, and this corpus is nowhere near it. So what is
      // proven here is that the scan resumes, NOT that it resumes far enough on
      // a brain whose origin fence excludes most of a large corpus. That is the
      // same hazard one layer further down, and it is unguarded.
      const total = await sql.unsafe<{ n: number }[]>('SELECT count(*)::int AS n FROM chunk');
      expect(total[0]?.n).toBeLessThan(HNSW_MAX_SCAN_TUPLES_DEFAULT);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a 250-candidate request under the production predicates still returns at least 200 QUALIFYING rows',
    async () => {
      const query = candidateQuery({ filtered: true, limit: CANDIDATE_POOL });

      const { rows, plan } = await withVectorScan(sql, { candidatePool: CANDIDATE_POOL }, async (tx) => {
        await tx.unsafe(FORCE_INDEX_SCAN);
        const explained = await explainLines(tx, query);
        const found = await tx.unsafe<CandidateRow[]>(query);
        return { rows: found, plan: explained };
      });

      // The predicates must be applied by the index scan, not by a seq scan
      // that never had the hazard. Both halves are asserted: the plan is an
      // HNSW index scan, and it is the one carrying the filter.
      expect(usesHnswIndexScan(plan)).toBe(true);
      expect(plan.some((line) => line.trimStart().startsWith('Filter:'))).toBe(true);

      expect(rows.length).toBeGreaterThanOrEqual(REQUIRED_YIELD);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'every row that came back actually qualifies',
    async () => {
      // The cheap way to satisfy the count above would be to stop filtering.
      // This is the assertion that makes "qualifying" mean something.
      const query = candidateQuery({ filtered: true, limit: CANDIDATE_POOL });

      const rows = await withVectorScan(sql, { candidatePool: CANDIDATE_POOL }, async (tx) => {
        await tx.unsafe(FORCE_INDEX_SCAN);
        return tx.unsafe<CandidateRow[]>(query);
      });

      const ids = rows.map((row) => row.chunk_id);
      // Asserted before the round-trip below, so an empty result set fails on
      // the yield — the thing this hazard is about — rather than on an empty
      // array literal, which would report a binding error instead of a hazard.
      expect(ids.length).toBeGreaterThanOrEqual(REQUIRED_YIELD);

      // Built as a literal rather than bound: every element is checked to be
      // digits-only first, so there is no text here that did not come from the
      // database as an integer id.
      expect(ids.every((id) => /^\d+$/.test(id))).toBe(true);

      const disqualified = await sql.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n
           FROM chunk
          WHERE chunk_id = ANY('{${ids.join(',')}}'::bigint[])
            AND NOT (origin_context = 'personal' AND deleted_at IS NULL AND quarantined_at IS NULL)`,
      );
      expect(disqualified[0]?.n).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});
