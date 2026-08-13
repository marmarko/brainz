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
 * 250-candidate request under the production predicates yields **0** rows at
 * pgvector's defaults, **100** with `ef_search` raised and the iterative scan
 * still off, and 250 with it on. The collapse is real here and now, not a hazard
 * inherited on paper.
 *
 * **The middle number is asserted, not just quoted.** A guard that only measures
 * the remedied arm passes on any fixture where the predicates stopped biting —
 * including one somebody shrank. So the first test below is a control: the same
 * query, the same forced index scan, `hnsw.iterative_scan` explicitly off, and
 * an assertion that the yield is still *well* under the floor. That is what
 * replaced an arithmetic tripwire over the fixture constants, which adversarial
 * review found calibrated to its own boundary — one edit in either constant left
 * both headline assertions green with the hazard live.
 */

import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  HNSW_MAX_SCAN_TUPLES_DEFAULT,
  withVectorScan,
} from '../../src/schema/vector-query.ts';
import {
  CANDIDATE_POOL,
  COLLAPSE_MARGIN,
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
      // spends this many of its candidates on rows the filter will discard.
      //
      // Whether that headroom is *enough* is not asserted here as arithmetic —
      // the previous version of this file did exactly that, with
      // `NEAR_DECOY_CHUNKS > CANDIDATE_POOL - REQUIRED_YIELD`, and adversarial
      // review found it calibrated to the boundary: one step in either constant
      // left both headline assertions green over a live hazard, with this
      // inequality as the only red. The question "can this fixture still exhibit
      // the collapse" is now answered by measuring the collapse, in the control
      // arm below.
      const excludedRows = await sql.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n
           FROM chunk
          WHERE embedding IS NOT NULL
            AND NOT (origin_context = 'personal' AND deleted_at IS NULL AND quarantined_at IS NULL)`,
      );
      expect(excludedRows[0]?.n).toBe(NEAR_DECOY_CHUNKS);

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
    'the control arm: without the remedy this fixture still collapses, with room to spare',
    async () => {
      // **This is the assertion that makes the next one mean something.** The
      // headline test says the arm yields ≥ REQUIRED_YIELD *with* the remedy. On
      // its own that passes on any fixture where the predicates happen not to
      // bite — including one someone shrank. So this runs the identical query
      // with `hnsw.iterative_scan` explicitly off, which is pgvector 0.8.6's
      // default and therefore the unremedied production configuration, and
      // requires the collapse to still be there.
      //
      // Everything else is held identical to the headline test, deliberately:
      // same pool, same predicates, same forced index scan, same plan
      // assertions. `enable_seqscan = off` matters most — a sequential scan is
      // exact, would return the full 250, and would fail this assertion for
      // precisely the wrong reason.
      const query = candidateQuery({ filtered: true, limit: CANDIDATE_POOL });

      const { rows, plan } = await sql.begin(async (tx) => {
        await tx.unsafe(FORCE_INDEX_SCAN);
        await tx.unsafe(`SET LOCAL hnsw.ef_search = ${CANDIDATE_POOL}`);
        await tx.unsafe('SET LOCAL hnsw.iterative_scan = off');
        const explained = await explainLines(tx, query);
        const found = await tx.unsafe<CandidateRow[]>(query);
        return { rows: found, plan: explained };
      });

      expect(usesHnswIndexScan(plan)).toBe(true);
      expect(plan.some((line) => line.trimStart().startsWith('Filter:'))).toBe(true);

      // The hazard, measured: the scan spends its budget on rows the filter
      // discards, so the arm returns far fewer qualifying rows than the pool it
      // was asked for even though the corpus holds plenty.
      expect(rows.length).toBeLessThan(REQUIRED_YIELD);

      // And it is not a near miss. If this fails, the fixture no longer proves
      // anything about the remedy below — shrink the decoys or raise the floor
      // until it does, rather than trusting a guard whose red and green sit one
      // row apart.
      expect(rows.length).toBeLessThanOrEqual(REQUIRED_YIELD - COLLAPSE_MARGIN);
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
