/**
 * The three phases that are not a walk, and what an exhausted budget means to
 * each of them.
 *
 * `salience` and `cluster` are walks over an ordered set, so "where I got to" is
 * a row id and an interrupted attempt hands the next one its position. The other
 * three are whole-set computations with no such position, and they used to be
 * treated as one kind because of that. They are two.
 *
 *   **`dedup` and `entity_merge` are monotone.** A collapsed fact gets a
 *   `superseded_by` and leaves the live set; a merged entity is tombstoned and
 *   leaves it too. So the read the next attempt makes is *strictly smaller* than
 *   the one this attempt made, and stopping mid-loop is real progress banked in
 *   the rows rather than in a checkpoint. They yielded only to a lost lease,
 *   which meant an attempt with four seconds left entered them and was reaped
 *   somewhere inside — the reap being the thing this whole seam exists to
 *   replace with a decision.
 *
 *   **`link_reconcile` is not.** It builds the desired edge set from every live
 *   fact and then diffs the live edges against it, so an edge missing from a
 *   half-built desired set is an edge the diff *deletes*. It cannot stop early
 *   and it cannot bank a position, and no amount of chunking changes that
 *   without changing what the phase means. The only safe thing to do with a
 *   budget it will not fit is to decline to start it — and to say so, because a
 *   phase the cycle keeps refusing is an operator's problem rather than the
 *   cycle's, and a cycle reaped in the middle of one says nothing at all.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runConsolidationCycle } from '../../src/worker/consolidate/cycle.ts';
import { readPhaseTimings } from '../../src/worker/consolidate/checkpoint.ts';
import {
  CALLER,
  TENANT,
  countRows,
  createGateway,
  createTenantFixture,
  seedFact,
  seedPage,
  type TenantFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;

let tenant: TenantFixture;

beforeEach(async () => {
  tenant = await createTenantFixture('wholeset');
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  await tenant?.close();
}, SETUP_TIMEOUT_MS);

/**
 * `pages` pages, each stating one claim **twice** under one credential.
 *
 * Two rows of one claim through one credential is the residue `write/dedup.ts`
 * documents — a second writer whose snapshot predates the first's commit — and
 * it is what the dedup phase exists to collapse. One group per page, so "how far
 * did dedup get" is countable.
 */
async function seedDuplicates(pages: number): Promise<void> {
  const { sql } = tenant;
  for (let index = 0; index < pages; index++) {
    const statement = `Person${index} joined Company${index}.`;
    const page = await seedPage(sql, {
      origin: 'personal:mail',
      sourceType: 'email',
      title: `Thread ${index}`,
      body: statement,
    });
    for (const pass of [0, 1]) {
      void pass;
      await seedFact(sql, {
        statement,
        origins: ['personal:mail'],
        pageId: page.pageId,
        chunkIds: page.chunkIds,
        confidence: 0.8,
      });
    }
  }
}

/** One tick per read, so a wall-clock budget is a count of units of work. */
function tickingClock(): () => number {
  let ticks = 0;
  return () => (ticks += 1);
}

const collapsed = (): Promise<number> =>
  countRows(tenant.sql, 'fact', 'superseded_by IS NOT NULL');

describe('a monotone whole-set phase stops on the clock and keeps what it did', () => {
  test(
    'dedup collapses part of the brain, banks it, and finishes it on later attempts',
    async () => {
      const GROUPS = 20;
      await seedDuplicates(GROUPS);
      const { gateway } = createGateway();
      const deps = { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER };
      const now = new Date('2026-03-01T00:00:00Z');

      // Three units of work: the phase boundary and two groups. Nothing like
      // enough for twenty.
      const first = await runConsolidationCycle(deps, {
        trigger: 'time_ceiling',
        tier: 'free',
        now,
        clock: tickingClock(),
        budgetMs: 3,
      });

      // **The claim.** The phase consulted the clock only for a lost lease, so
      // an attempt with three units of budget collapsed all twenty groups and
      // then handed the *next* phase a budget that had been gone for some time —
      // on a real brain, an hour of whole-set work started with four seconds
      // left and finished by the reaper.
      const partial = await collapsed();
      expect(partial).toBeGreaterThan(0);
      expect(partial).toBeLessThan(GROUPS);
      expect(first.stopReason).toBe('out_of_time');
      // Rows changed are progress even with no position to bank, which is what
      // makes stopping here safe for the continuation gate.
      expect(first.advanced).toBe(true);

      // And the work is *kept*. Each attempt's read is strictly smaller than the
      // last one's, because a collapsed fact is no longer live — so the phase
      // converges by repetition without a cursor and without undoing anything.
      let previous = partial;
      for (let attempt = 0; attempt < 20; attempt++) {
        const result = await runConsolidationCycle(deps, {
          trigger: 'time_ceiling',
          tier: 'free',
          now,
          clock: tickingClock(),
          budgetMs: 3,
        });
        const total = await collapsed();
        expect(total).toBeGreaterThanOrEqual(previous);
        previous = total;
        if (result.stopReason !== 'out_of_time') break;
      }

      // Exactly one survivor per group, and no fact superseded twice: the
      // repetition is idempotent, not merely convergent.
      expect(previous).toBe(GROUPS);
      expect(await countRows(tenant.sql, 'fact', 'superseded_by IS NULL')).toBe(GROUPS);
    },
    SETUP_TIMEOUT_MS,
  );
});

/** How many `works_at` edges the graph currently claims. */
const liveEdges = (): Promise<number> => countRows(tenant.sql, 'entity_edge', 'deleted_at IS NULL');

async function seedGraph(pages: number, from = 0): Promise<void> {
  const { sql } = tenant;
  for (let index = from; index < from + pages; index++) {
    const statement = `Person${index} joined Company${index % 3}.`;
    const page = await seedPage(sql, {
      origin: 'personal:mail',
      sourceType: 'email',
      title: `Thread ${index}`,
      body: statement,
    });
    await seedFact(sql, {
      statement,
      origins: ['personal:mail'],
      pageId: page.pageId,
      chunkIds: page.chunkIds,
      confidence: 0.8,
    });
  }
}

describe('a phase that cannot be stopped part-way is not entered unless it fits', () => {
  test(
    'a measured reconciliation that will not fit is declined, by name, and run next attempt',
    async () => {
      await seedGraph(9);
      const { gateway } = createGateway();
      const deps = { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER };
      const now = new Date('2026-03-01T00:00:00Z');

      // A first cycle, on a budget it comfortably fits, so every phase completes
      // and every completion is measured.
      const first = await runConsolidationCycle(deps, {
        trigger: 'time_ceiling',
        tier: 'free',
        now,
        clock: tickingClock(),
        budgetMs: 1_000,
      });
      expect(first.stopReason).toBe('free_tier');
      const measured = await readPhaseTimings(tenant.sql);
      // A completing phase leaves a number behind, or the guard below has
      // nothing to decide on and this whole seam is decoration.
      expect(measured.has('link_reconcile')).toBe(true);
      const settled = await liveEdges();
      expect(settled).toBeGreaterThan(0);

      // Now the brain grows enough to matter and the measurement says so. Writing
      // the row directly is the point of the guard being data-driven: what it
      // does with "this phase takes longer than you have" must not depend on how
      // long the fixture's database happens to take.
      await tenant.sql`
        UPDATE consolidation_phase_timing
           SET last_duration_ms = 1000000
         WHERE phase = 'link_reconcile'
      `;
      // Three people nobody has reconciled yet, so a refusal cannot be confused
      // with a phase that had nothing to do.
      await seedGraph(3, 9);

      const refused = await runConsolidationCycle(deps, {
        trigger: 'time_ceiling',
        tier: 'free',
        now,
        clock: tickingClock(),
        budgetMs: 100,
      });

      // **The claim.** The phase has to run to the end or not at all — a
      // half-built desired set makes the diff delete edges nothing stopped
      // stating — so entering it with less than it needs can only end in a reap.
      // It is declined instead, under a name an operator can alert on, and the
      // run stays open asking to be run again.
      expect(refused.stopReason).toBe('phase_does_not_fit');
      expect(refused.moreToDo).toBe(true);
      const declined = refused.phases.find((record) => record.phase === 'link_reconcile');
      expect(declined?.ran).toBe(false);
      expect(declined?.stopped).toBe('phase_does_not_fit');
      // Declining means declining: it did not half-run and leave the graph
      // holding a diff against a fact set it never finished reading.
      expect(await liveEdges()).toBe(settled);

      // And the next attempt, whose budget starts full, runs it.
      await tenant.sql`
        UPDATE consolidation_phase_timing SET last_duration_ms = 1 WHERE phase = 'link_reconcile'
      `;
      const done = await runConsolidationCycle(deps, {
        trigger: 'time_ceiling',
        tier: 'free',
        now,
        clock: tickingClock(),
        budgetMs: 1_000,
      });
      expect(done.stopReason).toBe('free_tier');
      expect(await liveEdges()).toBeGreaterThan(settled);
    },
    SETUP_TIMEOUT_MS,
  );
});
