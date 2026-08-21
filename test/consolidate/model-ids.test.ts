/**
 * The id a model hands back, and the seat that decides what type it is.
 *
 * ============================================================================
 * THE FAILURE
 * ============================================================================
 *
 * Three phases ask the model about many rows at once and match the answers back
 * by id. The id is a `bigint`, rendered into the prompt as a string. What comes
 * back is JSON — and whether it returns as `"1344"` or as `1344` is the seat's
 * choice. The same prompt gets both from different models and neither is wrong.
 *
 * Those three call sites read it with `text`, which refuses a number. For a
 * `statement` or a `summary` that refusal is right: a number there means the
 * model did not answer the question. For an id it produced two different bugs,
 * and only one of them was loud enough to notice:
 *
 *   * **`salience_refine` discarded every score.** It checks the id against a
 *     `known` set, so a numeric id missed, counted as `logged`, and applied
 *     nothing — while the phase returned success and `markConsidered` retired
 *     the whole batch. Measured on a production brain against the live seat,
 *     which returns `{"page_id":1344,"salience":0.6}`: 186 pages marked
 *     considered, 25 ever scored. The phase could run for the life of a brain
 *     and never write a single model score, reporting health the whole time.
 *   * **`extract` would have mis-attributed instead of dropping.** Its fallback
 *     is `byId.get(chunkId) ?? candidates[0]`, so a numeric id sends every fact
 *     in the batch to the batch's first chunk — wrong provenance, silently.
 *
 * It bit `salience_refine` alone because of the routing table and nothing
 * deeper: `salience` routes to a reasoning seat that emits numeric ids, while
 * `extract` and `contradiction` route to a Gemini seat that quotes them. That is
 * a fact about this quarter's seats, not a guarantee — which is why these tests
 * assert the phases against BOTH shapes rather than against the one their
 * current seat happens to send.
 */

import { afterEach, beforeEach, expect, describe, test } from 'bun:test';

import { runSalienceRefinePhase, runExtractPhase } from '../../src/worker/consolidate/model-phases.ts';
import { CONSIDERATION_VERSION } from '../../src/worker/consolidate/consideration.ts';
import { createBudget } from '../../src/ai/gateway.ts';
import {
  CALLER,
  TENANT,
  createGateway,
  createTenantFixture,
  seedPage,
  type TenantFixture,
} from './fixture.ts';

const RUN_ID = '1';
const NOW = new Date('2026-08-20T22:00:00.000Z');

let fixture: TenantFixture;

beforeEach(async () => {
  fixture = await createTenantFixture('modelids');
  await fixture.sql.unsafe(
    `INSERT INTO consolidation_run (run_id, trigger_reason, tier, started_at)
     OVERRIDING SYSTEM VALUE VALUES (1, 'user_request', 'paid', $1::timestamptz)`,
    [NOW.toISOString()],
  );
});

afterEach(async () => {
  await fixture?.close();
});

/** Two seats, one prompt, two legal answer shapes. */
const SHAPES = [
  { name: 'a seat that quotes its ids', quote: true },
  { name: 'a seat that returns them as numbers', quote: false },
] as const;

describe('salience_refine applies the scores it was given', () => {
  for (const shape of SHAPES) {
    test(`it scores every page under ${shape.name}`, async () => {
      const first = await seedPage(fixture.sql, {
        origin: 'work:mail',
        sourceType: 'email',
        title: 'The Q3 renewal',
        body: 'Priya confirmed the renewal lands in Q3.',
      });
      const second = await seedPage(fixture.sql, {
        origin: 'work:mail',
        sourceType: 'email',
        title: 'Lunch',
        body: 'Lunch moved to Thursday.',
      });

      const ids = [first.pageId, second.pageId];
      const { gateway } = createGateway({
        chat: {
          salience: () =>
            JSON.stringify({
              scores: ids.map((id, index) => ({
                page_id: shape.quote ? id : Number(id),
                salience: index === 0 ? 0.9 : 0.2,
              })),
            }),
        },
      });

      const outcome = await runSalienceRefinePhase({
        sql: fixture.sql,
        gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: createBudget({ label: 'test.salience_refine', capMicroUsd: null }),
        runId: RUN_ID,
        now: NOW,
      });

      // The whole bug in one assertion: before the fix this was 0 under the
      // numeric shape, with `items: 2` and no `stopped` code — success reported,
      // nothing written, and the batch retired.
      expect(outcome.applied).toBe(2);
      expect(outcome.logged).toBe(0);
      expect(outcome.stopped).toBeNull();

      const rows = (await fixture.sql.unsafe(
        `SELECT page_id::text AS id, salience, salience_source::text AS source
           FROM page WHERE salience_source = 'model_refined' ORDER BY page_id`,
      )) as Array<{ id: string; salience: number; source: string }>;
      expect(rows.length).toBe(2);
      expect(rows[0]?.salience).toBeCloseTo(0.9, 5);
      expect(rows[1]?.salience).toBeCloseTo(0.2, 5);
    });
  }

  test('a page the model did not score is still marked, and is not invented', async () => {
    const only = await seedPage(fixture.sql, {
      origin: 'work:mail',
      sourceType: 'email',
      title: 'Untouched',
      body: 'Nothing much.',
    });
    const { gateway } = createGateway({ chat: { salience: () => JSON.stringify({ scores: [] }) } });

    const outcome = await runSalienceRefinePhase({
      sql: fixture.sql,
      gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: createBudget({ label: 'test.salience_refine', capMicroUsd: null }),
      runId: RUN_ID,
      now: NOW,
    });

    expect(outcome.applied).toBe(0);
    // The marker follows the ASK, not the answer — a page the model declined to
    // score has still had its turn, and re-offering it would pin the batch.
    const marked = (await fixture.sql.unsafe(
      `SELECT salience_refine_considered_version AS v FROM page WHERE page_id = $1::bigint`,
      [only.pageId],
    )) as Array<{ v: number | null }>;
    expect(marked[0]?.v).toBe(CONSIDERATION_VERSION.salience_refine);
  });

  test('an id that is not a page in this batch is refused, not guessed at', async () => {
    await seedPage(fixture.sql, {
      origin: 'work:mail',
      sourceType: 'email',
      title: 'Real',
      body: 'A real page.',
    });
    const { gateway } = createGateway({
      chat: {
        // A float, a negative, and an id past the safe-integer ceiling: none of
        // these can be the string the map was keyed with, and applying a score
        // to a guessed page is worse than applying none.
        salience: () =>
          JSON.stringify({
            scores: [
              { page_id: 1.5, salience: 0.9 },
              { page_id: -3, salience: 0.9 },
              { page_id: 9007199254740993, salience: 0.9 },
            ],
          }),
      },
    });

    const outcome = await runSalienceRefinePhase({
      sql: fixture.sql,
      gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: createBudget({ label: 'test.salience_refine', capMicroUsd: null }),
      runId: RUN_ID,
      now: NOW,
    });
    expect(outcome.applied).toBe(0);
    expect(outcome.logged).toBe(3);
  });
});

describe('extract attributes a fact to the chunk the model named', () => {
  for (const shape of SHAPES) {
    test(`it uses the named chunk under ${shape.name}`, async () => {
      const first = await seedPage(fixture.sql, {
        origin: 'work:mail',
        sourceType: 'email',
        title: 'First',
        body: 'The first document says one thing.',
      });
      const second = await seedPage(fixture.sql, {
        origin: 'work:mail',
        sourceType: 'email',
        title: 'Second',
        body: 'The second document says another.',
      });
      // The claim belongs to the SECOND chunk. Under the old reader a numeric id
      // fell through to `candidates[0]`, which is the first — a fact filed
      // against a document that never stated it.
      const target = second.chunkIds[0] ?? '';

      const { gateway } = createGateway({
        chat: {
          extract: () =>
            JSON.stringify({
              facts: [
                {
                  chunk_id: shape.quote ? target : Number(target),
                  statement: 'The second document says another.',
                  confidence: 0.95,
                },
              ],
            }),
        },
      });

      const outcome = await runExtractPhase({
        sql: fixture.sql,
        gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: createBudget({ label: 'test.extract', capMicroUsd: null }),
        runId: RUN_ID,
        now: NOW,
      });
      expect(outcome.applied).toBe(1);

      const sources = (await fixture.sql.unsafe(
        `SELECT fs.chunk_id::text AS chunk_id FROM fact_source fs`,
      )) as Array<{ chunk_id: string }>;
      expect(sources.length).toBe(1);
      expect(sources[0]?.chunk_id).toBe(target);
      expect(sources[0]?.chunk_id).not.toBe(first.chunkIds[0]);
    });
  }
});
