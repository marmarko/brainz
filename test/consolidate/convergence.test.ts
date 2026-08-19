/**
 * The claim the cycle's whole design rests on: a brain fits one attempt.
 *
 * **The failure this suite is written against.** A whole-brain cycle on a real
 * brain — 5,608 pages, 16,913 chunks — burned five attempts of a 15-minute
 * wall-clock ceiling and completed none of them. Every attempt was *reaped*
 * rather than returning, so `lease_token` came back at exactly twice `attempts`,
 * and the lane dead-lettered with `attempt_timed_out` having produced no
 * completed cycle in 2h46m.
 *
 * **The cause was round trips, not rows.** Salience issued `1 + 2N` sequential
 * statements — a per-page fact query and a per-page UPDATE, 11,217 of them on
 * that brain, which at 36ms of worker-to-database latency is fifteen minutes on
 * its own — and clustering paid a whole transaction per seed. Together they were
 * 28,799 of the pass's 30,850 round trips, against the other four deterministic
 * phases' combined 400ms.
 *
 * So there are three things to pin, and they are the three tests below:
 *
 *   1. **The deterministic prefix costs round trips per batch, not per page**,
 *      and it finishes in one attempt. This is the claim that makes redoing the
 *      free work on every attempt affordable, which is in turn why nothing here
 *      carries a position across attempts. If this test goes red the answer is
 *      another round trip removed from a phase — not a checkpoint added to the
 *      cycle.
 *   2. **A model phase cut short does not re-pay for what it already did.** Its
 *      progress is durable in the content: the synopsis phase no longer
 *      re-selects a page it has summarised.
 *   3. **A completed model phase is skipped when the next cycle resumes into an
 *      open run**, including a run left open by the clock. That is KTD11's
 *      checkpoint, and `out_of_time` is a stop reason it has to work for like
 *      any other.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import {
  completePhase,
  openRun,
  recordProgress,
} from '../../src/worker/consolidate/checkpoint.ts';
import { runConsolidationCycle, runDeterministicPhase } from '../../src/worker/consolidate/cycle.ts';
import { createAttemptBudget } from '../../src/worker/consolidate/deadline.ts';
import { NO_SPEND } from '../../src/worker/consolidate/estimate.ts';
import { DETERMINISTIC_PHASES } from '../../src/worker/consolidate/phases.ts';
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
  tenant = await createTenantFixture('convergence');
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  await tenant?.close();
}, SETUP_TIMEOUT_MS);

/**
 * A brain of `pages` pages, each with one chunk and two facts.
 *
 * Bodies are distinct so the extractor finds a different claim on each page and
 * the clustering phase has more than one theme to find — a corpus of identical
 * pages would collapse to one cluster and stop exercising the seed walk that is
 * half of what this suite measures.
 */
async function seedBrain(pages: number): Promise<void> {
  const { sql } = tenant;
  for (let index = 0; index < pages; index++) {
    const subject = `Person${index}`;
    const company = `Company${index % 7}`;
    const body = `${subject} joined ${company}. ${company} is based in City${index % 5}.`;
    const page = await seedPage(sql, {
      origin: 'personal:mail',
      sourceType: 'email',
      title: `Thread ${index}`,
      body,
    });
    await seedFact(sql, {
      statement: `${subject} joined ${company}.`,
      origins: ['personal:mail'],
      pageId: page.pageId,
      chunkIds: page.chunkIds,
      confidence: 0.8,
    });
    await seedFact(sql, {
      statement: `${company} is based in City${index % 5}.`,
      origins: ['personal:mail'],
      pageId: page.pageId,
      chunkIds: page.chunkIds,
      confidence: 0.8,
    });
  }
}

const SCRIPT = {
  extract: () => JSON.stringify({ facts: [] }),
  enrich: () => JSON.stringify({ cards: [] }),
  synopsis: () => JSON.stringify({ summary: 'A thread about a hire.' }),
  contradiction: () => JSON.stringify({ conflicts: [] }),
  salience: () => JSON.stringify({ scores: [] }),
};

/** How many canonical summary **rows** exist. One per model call ever made. */
function summaryPages(): Promise<number> {
  return countRows(tenant.sql, 'page', "external_ref LIKE 'summary:%' AND deleted_at IS NULL");
}

// ---------------------------------------------------------------------------
// 1. The cost of the free tier, counted rather than timed.
// ---------------------------------------------------------------------------

/**
 * Every statement the wrapped handle issues, counted.
 *
 * **Round trips rather than milliseconds, because milliseconds here are a lie.**
 * The fixture's database is on localhost, where a statement costs microseconds;
 * the brain that dead-lettered was 36ms away, where the same statement is four
 * orders of magnitude more expensive. A wall-clock assertion would therefore
 * pass on any code at all, including the code that failed. What actually
 * separated the two is the *number* of sequential statements, so that is what
 * this counts — and the arithmetic back to the incident's latency is written out
 * at each assertion.
 *
 * A transaction counts as two (its `BEGIN` and its `COMMIT`) plus whatever runs
 * inside it, which is why the handle a `begin` callback receives is wrapped too.
 */
function countingSql(sql: SQL, tally: { statements: number }): SQL {
  const wrap = (target: SQL): SQL =>
    new Proxy(target, {
      apply(fn, thisArg, args: unknown[]) {
        tally.statements += 1;
        return Reflect.apply(fn as (...a: unknown[]) => unknown, thisArg, args);
      },
      get(inner, property, receiver) {
        const value = Reflect.get(inner, property, receiver) as unknown;
        if (property === 'unsafe' && typeof value === 'function') {
          return (...args: unknown[]) => {
            tally.statements += 1;
            return (value as (...a: unknown[]) => unknown).apply(inner, args);
          };
        }
        if (property === 'begin' && typeof value === 'function') {
          return (run: (tx: SQL) => Promise<unknown>) => {
            tally.statements += 2;
            return (value as (fn: (tx: SQL) => Promise<unknown>) => unknown).call(
              inner,
              (tx: SQL) => run(wrap(tx)),
            );
          };
        }
        return typeof value === 'function' ? (value as () => unknown).bind(inner) : value;
      },
    }) as SQL;
  return wrap(sql);
}

describe('the deterministic prefix fits one attempt at the current phase costs', () => {
  test(
    'every free phase completes, and salience costs round trips per batch rather than per page',
    async () => {
      const PAGES = 120;
      const BATCH = 25;
      const BATCHES = Math.ceil(PAGES / BATCH);
      await seedBrain(PAGES);

      // A real clock and a real budget: fifteen minutes less the closing margin,
      // which is what `createConsolidateHandler` hands a cycle claimed at the
      // top of its lease. Nothing in this test may stop on it — that is the
      // assertion — but a budget of `Infinity` would make "it fits" unfalsifiable.
      const budgetMs = 14 * 60 * 1000;
      const now = new Date('2026-03-01T00:00:00Z');

      const cost = new Map<string, number>();
      for (const phase of DETERMINISTIC_PHASES) {
        const tally = { statements: 0 };
        const outcome = await runDeterministicPhase(countingSql(tenant.sql, tally), phase, {
          now,
          attempt: createAttemptBudget({ budgetMs }),
          batch: BATCH,
        });
        // **No phase stops.** A free tier that cannot finish inside one attempt
        // is the dead-lane condition, whatever else is true.
        expect(outcome.done).toBe(true);
        cost.set(phase, tally.statements);
      }

      // **The phase that was the incident.** `1 + 2N` was 241 statements at this
      // size and 11,217 on the brain that dead-lettered — fifteen minutes at
      // 36ms, on its own, before any other phase ran. Batched it is one read and
      // one write per batch, so the bound is stated in batches and the page count
      // may grow without it moving.
      expect(cost.get('salience')).toBeLessThanOrEqual(2 * BATCHES + 2);
      // Stated as a ratio too, because the constant above would still pass if
      // somebody quietly made the batch size one.
      expect(cost.get('salience')).toBeLessThan(PAGES);

      // **Clustering: a transaction per batch of seeds, not per seed.** The old
      // shape paid `BEGIN`, two `SET LOCAL`s and a `COMMIT` for every seed —
      // five round trips of pure overhead each — and then one INSERT per member.
      // What is left is one probe per seed still unassigned when its turn comes,
      // which is the work itself rather than overhead, plus five per batch.
      expect(cost.get('cluster')).toBeLessThanOrEqual(PAGES + 5 * BATCHES);

      // **The three that cost one statement per row they actually change.**
      // `dedup` reads the live facts once and writes one supersession per
      // collapse; `staleness` and `entity_merge` are a single query each on a
      // brain with nothing to retire and nothing to merge. None of them is a
      // statement per page, which is the property that matters.
      expect(cost.get('dedup')).toBeLessThanOrEqual(PAGES + 1);
      expect(cost.get('staleness')).toBeLessThanOrEqual(2 * BATCHES + 2);
      expect(cost.get('entity_merge')).toBeLessThanOrEqual(PAGES + 1);

      // **Reconciliation is the one phase whose cost is per *fact*, and it is
      // the next thing to attack if this ever stops fitting.** Every implied
      // edge resolves its two entities, and each resolution is its own round
      // trip. Measured on the brain that dead-lettered: 1,074 round trips and
      // 214ms — about 39 seconds at that fleet's 36ms latency, which fits a
      // fifteen-minute attempt with room and is why it was never the problem.
      // The bound here is stated per fact rather than per page, so a corpus that
      // states more claims per page does not silently relax it.
      const facts = await countRows(tenant.sql, 'fact', 'superseded_by IS NULL');
      expect(cost.get('link_reconcile')).toBeLessThan(facts * 12);

      // **The whole prefix, end to end, through the cycle the fleet runs.** One
      // attempt, one run, six phases, no clock stop — and this is the *second*
      // pass over this brain, which is the shape a nightly cycle actually has:
      // the duplicates are already collapsed and the entities already resolved,
      // so it is the steady-state cost rather than the first-import one. Measured
      // at this size: 1,450 statements on the first pass (the loop above) and 698
      // on this one. At 36ms a round trip those are the numbers to multiply out
      // when asking whether a brain ten times this size still fits fifteen
      // minutes.
      const whole = { statements: 0 };
      const { gateway } = createGateway();
      const cycle = await runConsolidationCycle(
        { sql: countingSql(tenant.sql, whole), gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'free', now, budgetMs, batch: BATCH },
      );
      expect(cycle.stopReason).toBe('free_tier');
      expect(cycle.moreToDo).toBe(false);
      const ranToTheEnd = cycle.phases.filter(
        (record) => record.tier === 'deterministic' && record.ran && record.stopped === null,
      );
      expect(ranToTheEnd.map((record) => record.phase).sort()).toEqual([
        'cluster',
        'dedup',
        'entity_merge',
        'link_reconcile',
        'salience',
        'staleness',
      ]);
      expect(whole.statements).toBeLessThan(PAGES * 12);

      // A completed cycle closes its run and takes its checkpoints with it, so
      // the next cycle starts clean rather than skipping the free work.
      expect(await countRows(tenant.sql, 'consolidation_run', 'finished_at IS NULL')).toBe(0);
      expect(await countRows(tenant.sql, 'consolidation_checkpoint')).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2 and 3. What a checkpoint is for: money, once.
// ---------------------------------------------------------------------------

describe('a phase cut short does not re-pay for the pages it already summarised', () => {
  test(
    'the second attempt summarises only what the first one did not',
    async () => {
      const PAGES = 6;
      const FIRST_ATTEMPT_CALLS = 2;
      await seedBrain(PAGES);

      // The synopsis phase's own stopping condition, used as a scalpel: the
      // model answers properly for two pages and then returns an object with no
      // `summary` in it, which the phase reads as `bad_output` and stops on. The
      // run stays open, exactly as it does when a provider goes away mid-phase.
      let synopsisCalls = 0;
      const cut = createGateway({
        chat: {
          ...SCRIPT,
          synopsis: () => {
            synopsisCalls += 1;
            return synopsisCalls <= FIRST_ATTEMPT_CALLS
              ? JSON.stringify({ summary: 'A thread about a hire.' })
              : JSON.stringify({});
          },
        },
      });

      // One instant for both attempts: `selectIngestedPages` orders by salience,
      // salience decays with age, and a second `now` would reshuffle the queue
      // and make "did it skip what it did" unanswerable.
      const now = new Date();

      const first = await runConsolidationCycle(
        { sql: tenant.sql, gateway: cut.gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now },
      );
      expect(first.stopReason).toBe('phase_failed');
      expect(await summaryPages()).toBe(FIRST_ATTEMPT_CALLS);

      const healthy = createGateway({ chat: SCRIPT });
      const second = await runConsolidationCycle(
        { sql: tenant.sql, gateway: healthy.gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now },
      );
      expect(second.resumed).toBe(true);

      // The whole claim. Before the fix both numbers were wrong in the same
      // direction: the phase re-selected all six pages, so it made six calls and
      // left eight summary pages behind — two of them second copies of a page
      // already summarised, which nothing supersedes and every later cycle then
      // carries.
      expect(healthy.transport.callsFor('synopsis').length).toBe(PAGES - FIRST_ATTEMPT_CALLS);
      expect(await summaryPages()).toBe(PAGES);
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('a run left open by the clock is resumed without re-paying for it', () => {
  test(
    'a model phase banked before an out_of_time stop is skipped, not called again',
    async () => {
      await seedBrain(4);
      const now = new Date();

      // The state an attempt that stopped on its own clock leaves behind: a run
      // with no `finished_at`, one model phase banked, and `out_of_time` on the
      // record. Built directly rather than provoked, because provoking it means
      // tuning a tick budget to land between two model phases — which tests the
      // tuning rather than the resume, and re-tunes itself every time a phase
      // changes how often it reads the clock.
      const opened = await openRun(tenant.sql, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now,
        estimateMicroUsd: NO_SPEND,
      });
      await completePhase(tenant.sql, opened.run, 'extract', {
        items: 4,
        spentMicroUsd: 9_000,
        now,
      });
      await recordProgress(tenant.sql, opened.run, {
        dreamt: false,
        stopReason: 'out_of_time',
        spentMicroUsd: 9_000,
        modelCalls: 4,
        phasesRun: 7,
        wallClockMs: 840_000,
        now,
      });

      const { gateway, transport } = createGateway({ chat: SCRIPT });
      const next = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now },
      );

      // **The claim.** `out_of_time` is a stop reason the checkpoint has to work
      // for exactly as `budget_exhausted` and `phase_failed` always did: the same
      // run, the paid phase skipped by name, and not one call to the provider for
      // work somebody has already been billed for.
      expect(next.runId).toBe(opened.run.runId);
      expect(next.resumed).toBe(true);
      const extract = next.phases.find((record) => record.phase === 'extract');
      expect(extract?.ran).toBe(false);
      expect(extract?.skipped).toBe('checkpointed');
      expect(transport.callsFor('extract')).toEqual([]);

      // And the spend it already carried stays on the run's total, or the tenant's
      // bill would reset every time an attempt did.
      expect(next.spentMicroUsd).toBeGreaterThanOrEqual(9_000);

      // The free tier, by contrast, ran again from the top. That is the design
      // and it is what the first test in this file measures the cost of.
      const redone = next.phases.filter(
        (record) => record.tier === 'deterministic' && record.ran,
      );
      expect(redone.length).toBe(6);
    },
    SETUP_TIMEOUT_MS,
  );
});
