/**
 * Convergence: a brain too big for one attempt still gets consolidated.
 *
 * **The failure this suite is written against.** A whole-brain cycle on a real
 * brain — 5,608 pages, 16,913 chunks — burned five attempts of a 15-minute
 * wall-clock ceiling and completed none of them. Every attempt was *reaped*
 * rather than returning, so `lease_token` came back at exactly twice `attempts`,
 * and the lane dead-lettered with `attempt_timed_out` having produced no
 * completed cycle in 2h46m. The cause was not one slow query. It was three
 * independent properties, and all three had to go:
 *
 *   1. **The cycle could not see its own deadline.** `CycleOptions` had no
 *      budget, the phase loop had no time check, and `StopReason` had no member
 *      meaning "there is more to do". A cycle discovered the ceiling only by
 *      being killed by it, which is the one way of discovering it that banks
 *      nothing and reports nothing.
 *   2. **Only model phases were skipped by a checkpoint.** The deterministic
 *      prefix re-ran in full on every attempt, so attempt N+1 walked the same
 *      rows in the same order as attempt N. The writes committed; the position
 *      did not. That is not slow progress, it is repeated identical work.
 *   3. **The synopsis phase had no idempotence.** It selected the top pages by
 *      salience with no already-summarised predicate, so a phase cut short
 *      re-summarised — and re-*wrote* — every page it had already paid for.
 *
 * The two tests below are the two halves of that, and each one was red before
 * the fix for the reason named in its own comment.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { bankPhaseProgress, openRun } from '../../src/worker/consolidate/checkpoint.ts';
import type { CycleResult } from '../../src/worker/consolidate/cycle.ts';
import { runConsolidationCycle } from '../../src/worker/consolidate/cycle.ts';
import { DETERMINISTIC_PHASES, MODEL_PHASES } from '../../src/worker/consolidate/phases.ts';
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

/**
 * How many source pages have a summary — the rows above, deduplicated by what
 * they summarise.
 *
 * The two numbers were equal only by luck. `writeCanonicalSummary` inserts, and
 * `page_by_external_ref` is not unique, so a phase that re-summarised a page it
 * had already paid for left two rows pointing at the same source. Progress has
 * to be measured on *this* number: counting rows would let a cycle that made no
 * progress at all look busy, which is precisely what the broken one did.
 */
async function pagesSummarised(): Promise<number> {
  const rows = (await tenant.sql`
    SELECT count(DISTINCT external_ref)::int AS n FROM page
     WHERE external_ref LIKE 'summary:%' AND deleted_at IS NULL
  `) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

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

/**
 * A clock that advances one millisecond every time it is read.
 *
 * The cycle reads it exactly where it decides whether to keep going, so "one
 * tick per decision" turns a wall-clock budget into a *count of units of work* —
 * deterministic, identical on a fast laptop and a loaded CI box, and asserting
 * on the thing the fix is about (does the next attempt start where this one
 * stopped) rather than on how long a database took.
 */
function tickingClock(): () => number {
  let ticks = 0;
  return () => (ticks += 1);
}

/** Phases banked against the open run, with their positions. */
async function banked(): Promise<Array<{ phase: string; completed: boolean; cursor: string | null }>> {
  return (await tenant.sql`
    SELECT phase, completed, phase_cursor AS cursor
      FROM consolidation_checkpoint
     ORDER BY phase
  `) as Array<{ phase: string; completed: boolean; cursor: string | null }>;
}

describe('a brain too big for one attempt converges over several', () => {
  test(
    'every attempt starts where the last one stopped, and the cycle completes',
    async () => {
      const PAGES = 40;
      // Room for the twelve phase-boundary checks plus a dozen units of real
      // work: enough that every attempt advances, far too little to finish.
      const BUDGET_UNITS = 24;
      const CEILING = 12;
      await seedBrain(PAGES);

      const { gateway, transport } = createGateway({ chat: SCRIPT });
      const deps = { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER };
      const now = new Date();

      const attempts: CycleResult[] = [];
      let summarised = 0;
      let bankedPhases = 0;

      for (let attempt = 0; attempt < CEILING; attempt++) {
        const result = await runConsolidationCycle(deps, {
          trigger: 'time_ceiling',
          tier: 'paid',
          now,
          clock: tickingClock(),
          budgetMs: BUDGET_UNITS,
        });
        attempts.push(result);

        // A cycle that stopped on the clock says so, stays open, and asks to be
        // run again — it is not a failure and must not look like one. The
        // completing attempt is measured by its own reason below; measuring it
        // here would compare against a checkpoint table `finishRun` has just
        // emptied, which reads as a step backwards and is a cycle finishing.
        if (result.stopReason !== 'out_of_time') break;

        expect(result.dreamt).toBe(false);
        expect(result.moreToDo).toBe(true);
        expect(result.advanced).toBe(true);

        // **The assertion that was false.** Before the fix, attempt two restarted
        // at `dedup` and walked the identical rows in the identical order: the
        // writes committed and the position did not, so this number never moved
        // and the loop ran to its ceiling without ever completing. It is
        // deliberately counted over *distinct* summarised pages and banked
        // phases — the broken cycle did add a summary row per attempt, and
        // counting rows would have called that progress.
        const summarisedNow = await pagesSummarised();
        const bankedNow = (await banked()).length;
        expect(summarisedNow + bankedNow).toBeGreaterThan(summarised + bankedPhases);
        summarised = summarisedNow;
        bankedPhases = bankedNow;
      }

      const last = attempts[attempts.length - 1];
      expect(last?.stopReason).toBe('complete');
      expect(last?.dreamt).toBe(true);
      expect(last?.moreToDo).toBe(false);
      // More than one attempt, or the budget was never the constraint and this
      // test would pass against the code it was written to fail against.
      expect(attempts.length).toBeGreaterThan(1);
      expect(attempts.length).toBeLessThan(CEILING);

      // Every attempt after the first resumed the same run rather than opening a
      // second one beside it.
      const runIds = new Set(attempts.map((result) => result.runId));
      expect(runIds.size).toBe(1);

      // **Nothing was paid for twice.** One summary per page, and exactly one
      // model call per page across every attempt combined.
      expect(await summaryPages()).toBe(PAGES);
      expect(transport.callsFor('synopsis').length).toBe(PAGES);

      // **And the free work was done once per run, not once per attempt.** This
      // is the deterministic half of the defect stated as an assertion: the
      // prefix used to re-run in full every time, which is what made a brain
      // whose prefix outlived one attempt unable to finish at all. A phase
      // reported as `checkpointed` must have completed in an earlier attempt,
      // and no phase may complete twice.
      const completedIn = new Map<string, number>();
      attempts.forEach((result, index) => {
        for (const record of result.phases) {
          if (record.tier !== 'deterministic') continue;
          if (record.skipped === 'checkpointed') {
            expect(completedIn.has(record.phase)).toBe(true);
            continue;
          }
          if (record.ran && record.stopped === null) {
            expect(completedIn.get(record.phase)).toBeUndefined();
            completedIn.set(record.phase, index);
          }
        }
      });
      expect([...completedIn.keys()].sort()).toEqual([
        'cluster',
        'dedup',
        'entity_merge',
        'link_reconcile',
        'salience',
        'staleness',
      ]);

      // A completed cycle closes its run and takes its checkpoints with it, so
      // the next cycle starts clean rather than skipping the free work.
      expect(await countRows(tenant.sql, 'consolidation_run', 'finished_at IS NULL')).toBe(0);
      expect(await banked()).toEqual([]);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'the clustering phase resumes into its own output instead of deleting it',
    async () => {
      await seedBrain(30);
      const { gateway } = createGateway({ chat: SCRIPT });
      const deps = { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER };
      const now = new Date();

      // Six phase-boundary checks precede the clustering phase, and the seventh
      // read of the clock is the one it takes after its first batch of seeds.
      // Stopping there is what puts a cursor on the row.
      const first = await runConsolidationCycle(deps, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now,
        clock: tickingClock(),
        budgetMs: 7,
      });
      expect(first.stopReason).toBe('out_of_time');

      const interrupted = (await banked()).find((row) => row.phase === 'cluster');
      expect(interrupted?.completed).toBe(false);
      expect(interrupted?.cursor).not.toBeNull();

      const built = (await tenant.sql`
        SELECT cluster_id::text AS cluster_id FROM content_cluster ORDER BY cluster_id
      `) as Array<{ cluster_id: string }>;
      expect(built.length).toBeGreaterThan(0);

      const second = await runConsolidationCycle(deps, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now,
        clock: tickingClock(),
        budgetMs: 7,
      });
      expect(second.runId).toBe(first.runId);

      // **The defect this pins.** The phase opened with `DELETE FROM
      // cluster_member; DELETE FROM content_cluster;`, so an interrupted attempt
      // was not merely re-done by the next one — it was *undone*. Clustering was
      // strictly net-zero across a reap, for ever, however many attempts a brain
      // was given. The identifiers surviving is what proves the rebuild was
      // skipped rather than merely repeated.
      const after = (await tenant.sql`
        SELECT cluster_id::text AS cluster_id FROM content_cluster ORDER BY cluster_id
      `) as Array<{ cluster_id: string }>;
      expect(after.map((row) => row.cluster_id)).toEqual(
        expect.arrayContaining(built.map((row) => row.cluster_id)),
      );
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('a partial checkpoint is a deterministic-phase thing, structurally', () => {
  test(
    'banking a position for a model phase is refused, not merely discouraged',
    async () => {
      const opened = await openRun(tenant.sql, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now: new Date(),
        estimateMicroUsd: 0,
      });

      // **The rolling-deploy hazard, refused at the seam.** The previous fleet
      // version reads *any* checkpoint row as a completion and skips model
      // phases on that basis. A row saying "synopsis, position 40" would make an
      // instance one release behind skip synopsis outright for the rest of the
      // run — a phase silently not run, during a deploy, which is the worst
      // place to find out a convention was only a comment.
      for (const phase of MODEL_PHASES) {
        await expect(
          bankPhaseProgress(tenant.sql, opened.run, phase, {
            items: 1,
            cursor: '40',
            now: new Date(),
          }),
        ).rejects.toThrow(/model phase/);
      }

      // And the deterministic ones go through, or the check above would be
      // passing because nothing works.
      for (const phase of DETERMINISTIC_PHASES) {
        await bankPhaseProgress(tenant.sql, opened.run, phase, {
          items: 1,
          cursor: '40',
          now: new Date(),
        });
      }
      const rows = await banked();
      expect(rows.length).toBe(DETERMINISTIC_PHASES.length);
      expect(rows.every((row) => row.completed === false && row.cursor === '40')).toBe(true);
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('a continuation that got stuck stops being treated as one', () => {
  test(
    'free work banked more than a ceiling period ago is redone, not skipped',
    async () => {
      await seedBrain(20);
      const { gateway } = createGateway({ chat: SCRIPT });
      const deps = { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER };
      const started = new Date('2026-08-01T00:00:00Z');

      const first = await runConsolidationCycle(deps, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now: started,
        clock: tickingClock(),
        budgetMs: 7,
      });
      expect(first.stopReason).toBe('out_of_time');
      const bankedPhases = (await banked()).map((row) => row.phase);
      expect(bankedPhases.length).toBeGreaterThan(0);

      // Two days later. "Nothing has changed since" — the entire argument for
      // skipping the free work — is no longer a claim anyone can make about this
      // brain, so the stalled run is **closed** and the work carries on in a
      // fresh one. Closed rather than merely distrusted: a run left open past the
      // horizon has no way back inside it, and would re-run its whole free tier
      // on every attempt for as long as it stayed open. See
      // `test/consolidate/livelock.test.ts`.
      const later = new Date(started.getTime() + 2 * 24 * 60 * 60 * 1000);
      const second = await runConsolidationCycle(deps, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now: later,
      });
      expect(second.runId).not.toBe(first.runId);
      const swept = (await tenant.sql`
        SELECT stop_reason, finished_at FROM consolidation_run WHERE run_id = ${first.runId}::bigint
      `) as Array<{ stop_reason: string | null; finished_at: Date | null }>;
      expect(swept[0]?.stop_reason).toBe('abandoned');
      expect(swept[0]?.finished_at).not.toBeNull();

      const rerun = second.phases.filter(
        (record) => record.tier === 'deterministic' && record.ran,
      );
      expect(rerun.map((record) => record.phase).sort()).toEqual([
        'cluster',
        'dedup',
        'entity_merge',
        'link_reconcile',
        'salience',
        'staleness',
      ]);
    },
    SETUP_TIMEOUT_MS,
  );
});
