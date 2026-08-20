/**
 * A slow deterministic prefix must not delete the model tier.
 *
 * **The incident, measured on a real brain.** The two tiers shared one clock,
 * first come first served, and the deterministic tier runs first. On 8,893
 * chunks the `cluster` phase alone measures ~6.7 minutes at 22 seeds a second
 * against a 14-minute attempt; the prefix took the clock, the cycle reported
 * `out_of_time` attributed to `cluster`, and `transcribe`, `extract`, `enrich`,
 * `synopsis`, `contradiction` and `salience_refine` were all recorded
 * `not_reached`. Every cycle, indefinitely. The brain sat at 3,402 unsummarised
 * pages, 0 considered chunks and 168 facts while every clock in the control
 * plane said the lane was healthy — the same shape as every other freeze this
 * suite is written against, one tier further in.
 *
 * It is a priority inversion rather than a slow phase. `cluster`'s output is
 * read by nothing in `src/` outside the erasure sweep; the model tier produces
 * every fact, summary and card the owner ever sees. The fix is that the prefix
 * gets a bounded share of the attempt and the model tier is entitled to the
 * rest — `DETERMINISTIC_ATTEMPT_SHARE`.
 *
 * **What these tests pin, and what they deliberately do not.** They pin the
 * split: that a prefix which cannot finish yields instead of ending the cycle,
 * that the model tier runs anyway, and that the cycle says there is more to do.
 * They do NOT pin that any particular phase is fast — that is a property of a
 * corpus, and a test that asserted it would be measuring the fixture.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  DETERMINISTIC_ATTEMPT_SHARE,
  runConsolidationCycle,
} from '../../src/worker/consolidate/cycle.ts';
import { createAttemptBudget, shareOfAttempt } from '../../src/worker/consolidate/deadline.ts';
import {
  CALLER,
  TENANT,
  createGateway,
  createTenantFixture,
  seedFact,
  seedPage,
  type TenantFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;

let tenant: TenantFixture;

beforeEach(async () => {
  tenant = await createTenantFixture('detshare');
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  await tenant?.close();
}, SETUP_TIMEOUT_MS);

/** One tick per clock read, so a budget is a count of units of work. */
function tickingClock(): () => number {
  let ticks = 0;
  return () => (ticks += 1);
}

const SCRIPT = {
  extract: () => JSON.stringify({ facts: [] }),
  enrich: () => JSON.stringify({ cards: [] }),
  synopsis: () => JSON.stringify({ summary: 'A thread about a hire.' }),
  contradiction: () => JSON.stringify({ conflicts: [] }),
  salience: () => JSON.stringify({ scores: [] }),
};

/**
 * A brain with a great deal of deterministic work and almost no model work.
 *
 * **The shape is the fixture's whole point.** The two tiers' costs both scale
 * with pages, so a corpus that is merely large makes each tier slow together and
 * proves nothing about which one is being starved. Here `groups` duplicate fact
 * pairs — dedup's unit of work — hang off only `pages` pages, which is the
 * summariser's unit. So the prefix has a hundred things to do and the model tier
 * has three, and an attempt sized between them separates the two clocks cleanly.
 */
async function seedLopsided(options: {
  readonly pages: number;
  readonly groups: number;
}): Promise<void> {
  const { sql } = tenant;
  const pages: Array<{ pageId: string; chunkIds: string[] }> = [];
  for (let index = 0; index < options.pages; index++) {
    pages.push(
      await seedPage(sql, {
        origin: 'personal:mail',
        sourceType: 'email',
        title: `Thread ${index}`,
        body: `Person${index} joined Company${index}.`,
      }),
    );
  }
  for (let index = 0; index < options.groups; index++) {
    const page = pages[index % pages.length];
    if (page === undefined) continue;
    const statement = `Person${index} joined Company${index}.`;
    for (let copy = 0; copy < 2; copy++) {
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

describe('the prefix gets a share, and the model tier gets the rest', () => {
  test(
    'a prefix that cannot finish yields rather than ending the cycle',
    async () => {
      // A hundred dedup groups over three pages: far more prefix work than the
      // share can finish, and a model tier that costs almost nothing.
      //
      // The observed split at this budget, which is what the assertions below
      // are describing: `dedup` runs and stops on the share, the five
      // deterministic phases behind it yield, and all six model phases run to
      // the end. Before the reserve every one of those six read `not_reached`.
      await seedLopsided({ pages: 3, groups: 100 });
      const { gateway } = createGateway({ chat: SCRIPT });
      const result = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        {
          trigger: 'time_ceiling',
          tier: 'paid',
          capMicroUsd: null,
          now: new Date('2026-03-01T00:00:00Z'),
          clock: tickingClock(),
          budgetMs: 160,
        },
      );

      const deterministic = result.phases.filter((phase) => phase.tier === 'deterministic');
      const model = result.phases.filter((phase) => phase.tier === 'model');

      // The prefix ran out: at least one deterministic phase either stopped on
      // its own clock or was skipped because the share was already gone.
      const yielded = deterministic.filter(
        (phase) => phase.stopped === 'out_of_time' || phase.skipped === 'prefix_yielded',
      );
      expect(yielded.length).toBeGreaterThan(0);

      // **The assertion this file exists for.** The model tier ran. Before the
      // share, every one of these was `not_reached` and the cycle was over.
      expect(model.some((phase) => phase.ran)).toBe(true);
      expect(model.every((phase) => phase.skipped === 'not_reached')).toBe(false);

      // And the cycle is not reported as having died on the clock — it reached
      // the end of the pipeline, with prefix work left over.
      expect(result.stopReason).not.toBe('out_of_time');
      expect(result.moreToDo).toBe(true);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'an unbudgeted attempt is not divided, because there is no wall to divide',
    async () => {
      // A CLI run, an eval, a test: no lease, no deadline. Halving infinity
      // would be a phase stopping for a reason that does not exist.
      await seedLopsided({ pages: 2, groups: 4 });
      const { gateway } = createGateway({ chat: SCRIPT });
      const result = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        {
          trigger: 'time_ceiling',
          tier: 'paid',
          capMicroUsd: null,
          now: new Date('2026-03-01T00:00:00Z'),
        },
      );
      expect(result.stopReason).toBe('complete');
      expect(result.moreToDo).toBe(false);
      expect(result.phases.every((phase) => phase.skipped !== 'prefix_yielded')).toBe(true);
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('shareOfAttempt', () => {
  test('reads the parent clock rather than starting a second one', () => {
    // The property that keeps every other budgeted test honest: a share must not
    // consume clock readings of its own, or adding one silently changes how much
    // work every existing budgeted cycle does.
    const clock = tickingClock();
    const attempt = createAttemptBudget({ clock, budgetMs: 10 });
    const half = shareOfAttempt(attempt, { budgetMs: 10, fraction: 0.5 });

    // `startedAt` took tick 1. Reading the share takes tick 2 and no more.
    expect(half.stop()).toBeNull();
    expect(attempt.elapsedAtLastCheck()).toBe(1);

    // It expires at half the attempt's ceiling, on the attempt's own elapsed
    // time — ticks 3, 4, 5, 6 bring elapsed to 5.
    for (let read = 0; read < 3; read++) half.stop();
    expect(half.stop()).toBe('out_of_time');
    // And the attempt itself is still perfectly alive, which is the whole point.
    expect(attempt.stop()).toBeNull();
  });

  test('a share of an unbudgeted attempt never stops', () => {
    const attempt = createAttemptBudget({});
    const half = shareOfAttempt(attempt, { fraction: DETERMINISTIC_ATTEMPT_SHARE });
    expect(half.stop()).toBeNull();
    expect(half.remainingMs()).toBe(Number.POSITIVE_INFINITY);
  });

  test('a lost lease stops the share, and is not scaled', () => {
    // Cancellation is not a clock: the fence the attempt lost protects every
    // budget derived from it, so the share must report it immediately.
    const controller = new AbortController();
    const attempt = createAttemptBudget({ budgetMs: 10_000, signal: controller.signal });
    const half = shareOfAttempt(attempt, { budgetMs: 10_000, fraction: 0.5 });
    expect(half.stop()).toBeNull();
    controller.abort();
    expect(half.stop()).toBe('cancelled');
  });
});
