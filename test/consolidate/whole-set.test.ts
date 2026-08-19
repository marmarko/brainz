/**
 * A whole-set phase against an exhausted budget: what it may do, and why.
 *
 * No phase in this cycle resumes. A phase that stops is run again from the top
 * next time, so the only question worth asking about an interruption is whether
 * the work it committed *stays* committed — and for two of them the answer makes
 * stopping strictly better than being reaped.
 *
 *   **`dedup` and `entity_merge` are monotone.** A collapsed fact gets a
 *   `superseded_by` and leaves the live set; a merged entity is tombstoned and
 *   leaves it too. So the read the next attempt makes is *strictly smaller* than
 *   the one this attempt made, and stopping mid-loop banks real progress in the
 *   rows. They yielded only to a lost lease, which meant an attempt with four
 *   seconds left entered them and was reaped somewhere inside — the reap being
 *   the thing the attempt budget exists to replace with a decision.
 *
 *   **`link_reconcile` is not.** It builds the desired edge set from every live
 *   fact and then diffs the live edges against it, so an edge missing from a
 *   half-built desired set is an edge the diff *deletes*. Stopping it on the
 *   clock would throw the pass away, so it yields to a lost lease and to nothing
 *   else. Affordable because it is small: 214ms on a 5,608-page brain.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runConsolidationCycle } from '../../src/worker/consolidate/cycle.ts';
import { createAttemptBudget } from '../../src/worker/consolidate/deadline.ts';
import { reconcileAllEdges } from '../../src/worker/consolidate/deterministic.ts';
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
      expect(first.moreToDo).toBe(true);

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

describe('a phase that cannot be stopped part-way does not stop on the clock', () => {
  test(
    'reconciliation finishes a spent budget and yields only to a lost lease',
    async () => {
      await seedGraph(9);

      // A budget that was over before the call began. Every other phase would
      // stop on this; reconciliation must not, because there is nothing it could
      // hand over — an edge missing from a half-built desired set is an edge the
      // diff below *deletes*, so a partial pass is not slow progress but damage.
      const spent = await reconcileAllEdges(tenant.sql, {
        taxonomyVersion: 1,
        budget: createAttemptBudget({ budgetMs: 0 }),
      });
      expect(spent.done).toBe(true);
      const settled = await liveEdges();
      expect(settled).toBeGreaterThan(0);

      // A lost lease is different in kind: every write from that point is
      // unfenced against the tenant's database, so continuing cannot help. It
      // reports a restart and leaves the graph exactly as it found it.
      const dispossessed = new AbortController();
      dispossessed.abort();
      const lost = await reconcileAllEdges(tenant.sql, {
        taxonomyVersion: 1,
        budget: createAttemptBudget({ signal: dispossessed.signal }),
      });
      expect(lost.done).toBe(false);
      expect(await liveEdges()).toBe(settled);
    },
    SETUP_TIMEOUT_MS,
  );
});
