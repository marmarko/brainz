/**
 * A run must not outlive the cycle that failed.
 *
 * **The incident, and it is one page.** A brain of 5,608 pages sat at 167 facts
 * for hours. Every cycle reported the same three lines:
 *
 *     phase_failed {phase:'synopsis', code:'model_unavailable'} extractCallsSoFar=1 openRuns=1
 *
 * `extract` was called once, ever. Nothing was wrong with extraction — it had
 * finished once and was being skipped for the rest of the brain's life by a
 * chain of five links, of which only the first is about the page:
 *
 *   1. one page's synopsis draws a provider 500, which is systemic rather than
 *      the page's fault and correctly stops the phase;
 *   2. a model phase that stops stops the cycle, at `phase_failed`;
 *   3. `recordProgress` runs instead of `finishRun`, and `finishRun` is the only
 *      writer of `consolidation_run.finished_at` anywhere in `src/`;
 *   4. so the run stays open, and `openRun` adopts the newest open run
 *      unconditionally;
 *   5. and `cycle.ts` skips any model phase holding a checkpoint against the
 *      adopted run — so `extract`, banked by the first cycle, was skipped by
 *      every cycle after it.
 *
 * Link 3 is the one this suite is written against. Rung 21 fixed the *page's*
 * half of link 1 — a page whose ANSWER cannot be read is now the page's outcome
 * and the phase completes through it — but a 500 is not the page's answer, it is
 * the absence of one, and the phase is right to stop on it. So the freeze was
 * still one transient provider away, and the only link that closes it for every
 * cause at once is the run's.
 *
 * **What the fix must not cost.** The checkpoint exists so a *killed* cycle
 * never re-pays for model calls (KTD11). Closing the run must not turn every
 * phase failure into a re-paid `extract`. The line between the two is drawn in
 * `checkpoint.ts`: a cycle that RETURNS closes its run, because it reached a
 * state it can describe and its pass is over; a cycle that never returned leaves
 * one open because it never got the chance to close it, and that — and only that
 * — is the run a later cycle adopts. Sections 2 and 3 below hold that line.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { TransportError } from '../../src/ai/gateway.ts';
import { completePhase, openRun } from '../../src/worker/consolidate/checkpoint.ts';
import { runConsolidationCycle } from '../../src/worker/consolidate/cycle.ts';
import { NO_SPEND } from '../../src/worker/consolidate/estimate.ts';
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
  tenant = await createTenantFixture('runclosure');
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  await tenant?.close();
}, SETUP_TIMEOUT_MS);

const SCRIPT = {
  extract: () => JSON.stringify({ facts: [] }),
  enrich: () => JSON.stringify({ cards: [] }),
  synopsis: () => JSON.stringify({ summary: 'A thread about a hire.' }),
  contradiction: () => JSON.stringify({ conflicts: [] }),
  salience: () => JSON.stringify({ scores: [] }),
};

/** The title the scripted provider always answers with a 500. */
const POISON = 'Thread poison';

/**
 * Six pages, and the one that draws the 500 is the LEAST salient of them.
 *
 * Its position is load-bearing rather than incidental. A 500 is not durable, so
 * `runSynopsisPhase` stops the phase at the first one — every page ranked below
 * it is therefore never offered in that pass, and a poison page in the middle
 * would make "the good pages are summarised" unreachable by any correct
 * implementation rather than by this one. `selectIngestedPages` orders by
 * salience, and the deterministic salience phase decays it with the page's age,
 * so the poison page is seeded old and sorts last.
 */
async function seedProbeBrain(good: number): Promise<void> {
  const { sql } = tenant;
  for (let index = 0; index < good; index++) {
    const subject = `Person${index}`;
    const company = `Company${index}`;
    const page = await seedPage(sql, {
      origin: 'personal:mail',
      sourceType: 'email',
      title: `Thread ${index}`,
      body: `${subject} joined ${company}. ${company} is based in City${index}.`,
    });
    await seedFact(sql, {
      statement: `${subject} joined ${company}.`,
      origins: ['personal:mail'],
      pageId: page.pageId,
      chunkIds: page.chunkIds,
      confidence: 0.8,
    });
  }

  await seedPage(sql, {
    origin: 'personal:mail',
    sourceType: 'email',
    title: POISON,
    body: 'PersonX joined CompanyX. CompanyX is based in CityX.',
    // A year old, so recency puts it at the bottom of the candidate order. The
    // page is otherwise entirely ordinary — nothing about it is unreadable, and
    // the provider's 500 says nothing about it either.
    createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
  });
}

/** A provider that is down for exactly one page and healthy for every other. */
function flakyProvider(): ReturnType<typeof createGateway> {
  return createGateway({
    chat: {
      ...SCRIPT,
      synopsis: (request) => {
        if (request.input.kind === 'chat' && request.input.user.includes(POISON)) {
          // 502-class: the request never got a verdict. `stopFor` calls that
          // `model_unavailable` and NOT durable, which is correct — every
          // remaining page would meet it identically — and it is the code the
          // incident reported verbatim.
          throw new TransportError('bad gateway', 500);
        }
        return JSON.stringify({ summary: 'A thread about a hire.' });
      },
    },
  });
}

function openRuns(): Promise<number> {
  return countRows(tenant.sql, 'consolidation_run', 'finished_at IS NULL');
}

function summaryPages(): Promise<number> {
  return countRows(tenant.sql, 'page', "external_ref LIKE 'summary:%' AND deleted_at IS NULL");
}

// ---------------------------------------------------------------------------
// 1. The probe, as a permanent assertion.
// ---------------------------------------------------------------------------

describe('a cycle stopped by a provider leaves no run open behind it', () => {
  test(
    'extract is called on every cycle, not once, and the good pages are summarised',
    async () => {
      const GOOD = 5;
      const CYCLES = 3;
      await seedProbeBrain(GOOD);

      // One instant for every cycle. Salience decays with age and orders the
      // candidate set, so a moving `now` would reshuffle the queue between
      // cycles and make "what did the second cycle see" unanswerable.
      const now = new Date();
      const { gateway, transport } = flakyProvider();

      const stops: string[] = [];
      const attributions: Array<unknown> = [];
      const extractCalls: number[] = [];
      const openAfter: number[] = [];
      const runIds: string[] = [];

      for (let cycle = 0; cycle < CYCLES; cycle++) {
        const result = await runConsolidationCycle(
          { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
          { trigger: 'time_ceiling', tier: 'paid', now },
        );
        stops.push(result.stopReason);
        attributions.push(result.stoppedPhase);
        runIds.push(result.runId);
        extractCalls.push(transport.callsFor('extract').length);
        openAfter.push(await openRuns());
      }

      // **The incident state, verbatim.** This half was true before the fix and
      // stays true after it: the provider really is down for that page, the
      // phase is right to stop, and the cycle is right to report it. Nothing
      // here is what froze the brain.
      expect(stops).toEqual(Array.from({ length: CYCLES }, () => 'phase_failed'));
      expect(attributions).toEqual(
        Array.from({ length: CYCLES }, () => ({ phase: 'synopsis', code: 'model_unavailable' })),
      );

      // **The half that froze it.** `openRuns=1` after the first cycle is what
      // every later cycle resumed into, and `extractCallsSoFar=1` is what it
      // cost: extraction banked a checkpoint against that run and was skipped by
      // name for the rest of the brain's life.
      expect(extractCalls).toEqual([1, 2, 3]);
      expect(openAfter).toEqual(Array.from({ length: CYCLES }, () => 0));

      // Each cycle is its own pass over the corpus rather than another attempt
      // at one that never ends. Three cycles, three runs.
      expect(new Set(runIds).size).toBe(CYCLES);

      // And the work the brain is actually for got done. Five pages were
      // summarised on the first pass and the sixth is still owed — offered
      // again every cycle, costing one call, blaming nobody.
      expect(await summaryPages()).toBe(GOOD);
      expect(await countRows(tenant.sql, 'page', 'quarantined_at IS NOT NULL')).toBe(0);
      expect(await countRows(tenant.sql, 'page', 'consolidation_refusals > 0')).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. What the checkpoint is still for: the cycle that never returned.
// ---------------------------------------------------------------------------

/**
 * KTD11's sentence, read literally: "a **killed** cycle never re-pays model
 * calls."
 *
 * A cycle that returns has written its record and closed its run; there is
 * nothing to resume into and the next cycle is a new pass. A cycle that was
 * killed mid-flight wrote nothing, so its run is still open with its
 * checkpoints — and that is the one state a later cycle adopts. Built rather
 * than provoked, because provoking it means killing a process mid-statement.
 */
describe('a cycle that never returned is resumed without re-paying for it', () => {
  test(
    'the killed run is adopted once, its banked phase is skipped, and it closes',
    async () => {
      await seedProbeBrain(3);
      const now = new Date();

      const killed = await openRun(tenant.sql, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now,
        estimateMicroUsd: NO_SPEND,
      });
      await completePhase(tenant.sql, killed.run, 'extract', {
        items: 200,
        spentMicroUsd: 9_000,
        now,
      });
      // No run-record write at all: that is what "killed" means. `finished_at`
      // is null because nothing ran to set it, not because a cycle decided.

      const { gateway, transport } = createGateway({ chat: SCRIPT });
      const next = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now },
      );

      // The claim: nobody pays twice for extraction.
      expect(next.runId).toBe(killed.run.runId);
      expect(next.resumed).toBe(true);
      const extract = next.phases.find((record) => record.phase === 'extract');
      expect(extract?.ran).toBe(false);
      expect(extract?.skipped).toBe('checkpointed');
      expect(transport.callsFor('extract')).toEqual([]);
      expect(next.spentMicroUsd).toBeGreaterThanOrEqual(9_000);

      // And the adopted run closes with the cycle that adopted it, so the free
      // ride is taken exactly once.
      expect(await openRuns()).toBe(0);
      expect(await countRows(tenant.sql, 'consolidation_checkpoint')).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'a run adopted by a cycle that was itself killed is not adopted again',
    async () => {
      // **The absorbing state this closes.** A deterministic kill — an OOM on
      // one enormous page, a lane restarting on a loop — would otherwise skip
      // the banked phase on every cycle forever, which is the incident reached
      // through a different door. Adoption is stamped on the run at the moment
      // it happens rather than when the adopting cycle finishes, so a kill
      // during the adopting cycle still spends the ride.
      await seedProbeBrain(3);
      const now = new Date();

      const killed = await openRun(tenant.sql, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now,
        estimateMicroUsd: NO_SPEND,
      });
      await completePhase(tenant.sql, killed.run, 'extract', {
        items: 200,
        spentMicroUsd: 9_000,
        now,
      });
      // The adopting cycle got as far as stamping the run and was then killed
      // too: still open, still checkpointed, but its one resume is spent.
      const adopted = await openRun(tenant.sql, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now,
        estimateMicroUsd: NO_SPEND,
      });
      expect(adopted.resumed).toBe(true);
      expect(adopted.run.runId).toBe(killed.run.runId);

      const { gateway, transport } = createGateway({ chat: SCRIPT });
      const third = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now },
      );

      // A fresh run, the debris closed behind it, and extraction paid for
      // again — which is the forward progress the alternative never makes.
      expect(third.resumed).toBe(false);
      expect(third.runId).not.toBe(killed.run.runId);
      expect(transport.callsFor('extract').length).toBe(1);
      expect(await openRuns()).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. The brain that was frozen, thawing while the cause is still there.
// ---------------------------------------------------------------------------

/**
 * The production state, and the property the previous fix did not have.
 *
 * Rung 21's thaw needed the cycle to reach `complete` — which it does when the
 * page's own ANSWER is unreadable, and never does while a provider is returning
 * 500s. So the brain below is the one that was actually observed: a run left
 * open with `extract` banked against it, under a provider that is still failing.
 * It has to leave that state anyway, and on the second cycle rather than never.
 */
describe('a frozen brain thaws even while the provider is still failing', () => {
  test(
    'the stranded checkpoint is honoured once, then extraction runs every cycle',
    async () => {
      const GOOD = 5;
      await seedProbeBrain(GOOD);
      const now = new Date();

      const frozen = await openRun(tenant.sql, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now,
        estimateMicroUsd: NO_SPEND,
      });
      await completePhase(tenant.sql, frozen.run, 'extract', {
        items: 200,
        spentMicroUsd: 9_000,
        now,
      });
      // The row the incident left: stopped, reported, and open. Written as the
      // fleet version that produced it wrote it — an UPDATE that names the
      // reason and leaves `finished_at` null.
      await tenant.sql`
        UPDATE consolidation_run
           SET dreamt = false, stop_reason = 'phase_failed', spent_micro_usd = 9000,
               model_calls = 15, phases_run = 9, wall_clock_ms = 120000,
               stopped_phase = 'synopsis', stopped_phase_code = 'model_unavailable'
         WHERE run_id = ${frozen.run.runId}::bigint
      `;

      const { gateway, transport } = flakyProvider();
      const first = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now },
      );

      // Cycle one adopts the frozen run — nobody re-pays for extraction — and
      // stops on the same 500 the brain has been stopping on for hours. The
      // difference is the last line: it closes the run on its way out.
      expect(first.resumed).toBe(true);
      expect(first.stopReason).toBe('phase_failed');
      expect(transport.callsFor('extract')).toEqual([]);
      expect(await openRuns()).toBe(0);

      const second = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now },
      );

      // **The thing the brain had not done in hours.** No surgery, no operator,
      // and the provider is still down for that one page.
      expect(second.resumed).toBe(false);
      expect(transport.callsFor('extract').length).toBe(1);
      expect(await openRuns()).toBe(0);
      expect(await summaryPages()).toBe(GOOD);
    },
    SETUP_TIMEOUT_MS,
  );
});
