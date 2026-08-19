/**
 * The two ways a cycle can look like it is converging while standing still.
 *
 * A brain too large for one attempt is supposed to converge over N attempts,
 * with every attempt making strictly forward progress. The measured failure was
 * the opposite: five attempts, no completed cycle, a dead-lettered lane. The
 * fixes for that put two new loops in reach, and this file is written against
 * both of them rather than against the original.
 *
 *   **A continuation that cannot tell progress from repetition.** The handler
 *   asks to be run again immediately when a cycle stopped on the clock *and*
 *   advanced. `advanced` was satisfied by any phase completing — which is
 *   equally true of "banked a position nobody had" and "re-did the same free
 *   work for the ninth time". A run whose checkpoints are not being honoured
 *   re-runs its whole deterministic tier every attempt and every one of those
 *   attempts reported progress, so the gate that exists to stop an infinite
 *   immediate retry was permanently open.
 *
 *   **A horizon that absorbs rather than terminates.** Free work is skipped only
 *   while a run is being continued on the clock and is younger than one ceiling
 *   period. Nothing advanced `started_at` and nothing but a completed cycle set
 *   `finished_at`, so a run that crossed that horizon could never leave it: no
 *   deterministic checkpoint was honoured again, ever, and the tier restarted
 *   from zero on every attempt for as long as the run stayed open.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { CycleResult } from '../../src/worker/consolidate/cycle.ts';
import { runConsolidationCycle } from '../../src/worker/consolidate/cycle.ts';
import { DETERMINISTIC_PHASES } from '../../src/worker/consolidate/phases.ts';
import { ALPHA_CEILING_MS } from '../../src/worker/scheduler.ts';
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
  tenant = await createTenantFixture('livelock');
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  await tenant?.close();
}, SETUP_TIMEOUT_MS);

/** A handful of pages with something for every deterministic phase to do. */
async function seedBrain(pages: number): Promise<void> {
  const { sql } = tenant;
  for (let index = 0; index < pages; index++) {
    const subject = `Person${index}`;
    const company = `Company${index % 3}`;
    const body = `${subject} joined ${company}. ${company} is based in City${index % 2}.`;
    const page = await seedPage(sql, {
      origin: 'personal:mail',
      sourceType: 'email',
      title: `Thread ${index}`,
      body,
    });
    for (const statement of [`${subject} joined ${company}.`, `${company} is based in City${index % 2}.`]) {
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

/**
 * A gateway whose extraction phase answers with something no phase can read.
 *
 * The cycle calls that `phase_failed` and leaves the run **open** — a provider
 * outage, which is the one resume that deliberately does *not* honour the
 * deterministic tier's checkpoints, because a run picked up hours later sits
 * over a brain that has ingested since. That is the state this file needs and it
 * is a real one: it is how every unavailable provider leaves a cycle.
 */
function outage(): ReturnType<typeof createGateway> {
  return createGateway({
    chat: {
      extract: () => 'this is not the JSON the phase asked for',
      enrich: () => JSON.stringify({ cards: [] }),
      synopsis: () => JSON.stringify({ summary: 'A thread about a hire.' }),
      contradiction: () => JSON.stringify({ conflicts: [] }),
      salience: () => JSON.stringify({ scores: [] }),
    },
  });
}

describe('an attempt that only re-did work already banked has not advanced', () => {
  test(
    'the free tier running a second time over an unchanged brain is not progress',
    async () => {
      await seedBrain(8);
      const now = new Date('2026-03-01T00:00:00Z');
      const deps = { sql: tenant.sql, gateway: outage().gateway, tenantId: TENANT, caller: CALLER };

      // Attempt one. The deterministic tier does its work and banks it, then the
      // provider answers with rubbish and the run stays open at `phase_failed`.
      const first = await runConsolidationCycle(deps, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now,
        capMicroUsd: null,
      });
      expect(first.stopReason).toBe('phase_failed');
      expect(first.advanced).toBe(true);

      // Attempt two, same instant, same brain, same outage. Nothing has ingested
      // and nothing has been retired since; the run is resumed but not on the
      // clock, so its deterministic checkpoints are deliberately not honoured
      // and the whole free tier runs again over rows it has already settled.
      const second = await runConsolidationCycle(deps, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now,
        capMicroUsd: null,
      });
      expect(second.runId).toBe(first.runId);
      expect(second.resumed).toBe(true);

      // It really did re-run them, or the claim below would be true for the
      // wrong reason.
      const reran = second.phases
        .filter((record) => record.tier === 'deterministic' && record.ran)
        .map((record) => record.phase)
        .sort();
      expect(reran).toEqual([...DETERMINISTIC_PHASES].sort());

      // **The claim.** Six phases completed and not one row moved. `advanced` is
      // what gates the immediate continuation, and answering it from "a phase
      // completed" made an attempt that changed nothing indistinguishable from
      // one that banked a position no attempt had reached — so a run in this
      // state asked the fleet to run it again, forever, at whatever rate the
      // scheduler ticks.
      expect(second.advanced).toBe(false);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'a first attempt over a brain with work in it still reports progress',
    async () => {
      // The other half, without which the gate above could be closed by being
      // broken: a cycle that genuinely consolidates must still say so.
      await seedBrain(8);
      const { gateway } = createGateway();
      const result = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'free', now: new Date('2026-03-01T00:00:00Z') },
      );
      expect(result.stopReason).toBe('free_tier');
      expect(result.advanced).toBe(true);
    },
    SETUP_TIMEOUT_MS,
  );
});

/**
 * A clock that advances one millisecond every time it is read.
 *
 * The cycle reads it exactly where it decides whether to keep going, so a
 * wall-clock budget becomes a *count of units of work* — deterministic, the same
 * on a fast laptop and a loaded CI box, and about the thing under test rather
 * than about how long a database took.
 */
function tickingClock(): () => number {
  let ticks = 0;
  return () => (ticks += 1);
}

/** The open run, if there is one, and what the last closed one said. */
async function runsByAge(): Promise<
  Array<{ runId: string; stopReason: string | null; finished: boolean }>
> {
  const rows = (await tenant.sql`
    SELECT run_id::text AS run_id, stop_reason, finished_at
      FROM consolidation_run
     ORDER BY run_id
  `) as Array<{ run_id: string; stop_reason: string | null; finished_at: Date | null }>;
  return rows.map((row) => ({
    runId: row.run_id,
    stopReason: row.stop_reason,
    finished: row.finished_at !== null,
  }));
}

describe('a run that outlived the continuation horizon is closed, not held open', () => {
  test(
    'a brain still converges after its cycle sat unclaimed for longer than a ceiling period',
    async () => {
      const PAGES = 24;
      // A batch small enough that the two walking phases outlive one attempt,
      // which is the whole precondition: a deterministic tier that fits in one
      // attempt is one that restarting costs nothing, and this file is about
      // what happens when restarting it costs everything.
      const BATCH = 4;
      // Room for the twelve phase-boundary checks plus a dozen units of real
      // work: enough that a *resuming* attempt gets somewhere, far too little
      // for one starting from the beginning to finish.
      const BUDGET_UNITS = 24;
      const ATTEMPT_CEILING = 8;
      await seedBrain(PAGES);

      const { gateway } = createGateway({
        chat: {
          extract: () => JSON.stringify({ facts: [] }),
          enrich: () => JSON.stringify({ cards: [] }),
          synopsis: () => JSON.stringify({ summary: 'A thread about a hire.' }),
          contradiction: () => JSON.stringify({ conflicts: [] }),
          salience: () => JSON.stringify({ scores: [] }),
        },
      });
      const deps = { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER };
      const started = new Date('2026-03-01T00:00:00Z');

      const first = await runConsolidationCycle(deps, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now: started,
        clock: tickingClock(),
        budgetMs: BUDGET_UNITS,
        batch: BATCH,
      });
      expect(first.stopReason).toBe('out_of_time');

      // Two days pass with nobody claiming the continuation — a paused lane, a
      // fleet rollback, an operator's morning. The run is still open and still
      // says `out_of_time`, and it is now older than the horizon past which its
      // banked free work stops describing this brain.
      const afterTheHorizon = started.getTime() + 2 * ALPHA_CEILING_MS;

      const attempts: CycleResult[] = [];
      for (let attempt = 0; attempt < ATTEMPT_CEILING; attempt++) {
        const result = await runConsolidationCycle(deps, {
          trigger: 'time_ceiling',
          tier: 'paid',
          // A minute apart, so every attempt after the first is a continuation
          // inside the horizon rather than another crossing of it.
          now: new Date(afterTheHorizon + attempt * 60_000),
          clock: tickingClock(),
          budgetMs: BUDGET_UNITS,
          batch: BATCH,
        });
        attempts.push(result);
        if (result.stopReason !== 'out_of_time') break;
        // Each of these is what the handler gates its continuation on. A cycle
        // that stopped on the clock having advanced nothing settles normally
        // and waits for the ceiling, so a `false` here is the lane going quiet.
        expect(result.advanced).toBe(true);
      }

      // **The claim, and it is the whole point of the file.** The horizon used to
      // be absorbing: `started_at` never moved, nothing but a completed cycle
      // set `finished_at`, and there was no sweep anywhere — so once a run
      // crossed it, no deterministic checkpoint was ever honoured again. Measured
      // against the code this replaces, at these exact numbers: thirty attempts,
      // the same run every time, three phases ever skipped (the model ones the
      // pre-horizon attempt had banked), `advanced` false throughout, and no
      // completed cycle. The loop above does not terminate.
      const last = attempts[attempts.length - 1];
      expect(last?.stopReason).toBe('complete');
      expect(last?.dreamt).toBe(true);

      // The crossing closed the stalled run rather than leaving it open, and the
      // work carried on in a fresh one — which gets a fresh `started_at` and so
      // legitimately re-runs the free work the horizon distrusted, instead of an
      // un-closeable run that re-runs it every attempt for ever.
      const runs = await runsByAge();
      const abandoned = runs.find((row) => row.runId === first.runId);
      expect(abandoned).toEqual({ runId: first.runId, stopReason: 'abandoned', finished: true });
      expect(attempts[0]?.runId).not.toBe(first.runId);

      // And inside that fresh run the checkpoints are honoured again: at least
      // one deterministic phase was skipped because an earlier attempt of the
      // same run had finished it. Past the horizon this could never happen.
      const skipped = attempts
        .flatMap((result) => result.phases)
        .filter((record) => record.tier === 'deterministic' && record.skipped === 'checkpointed');
      expect(skipped.length).toBeGreaterThan(0);
    },
    SETUP_TIMEOUT_MS,
  );
});
