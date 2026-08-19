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
 * So there are six things to pin, and they are the six sections below:
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
 *   4. **`link_reconcile` costs round trips per pass, not per fact.** It is the
 *      one phase that refuses to stop on the clock — a half-built desired edge
 *      set makes the diff *delete* — so overrunning it is a reap rather than a
 *      stop, and the only defence is for it to be cheap. It was 8.42 round trips
 *      per live fact, which is four whole attempts on the brain that
 *      dead-lettered. The corpus doubles inside that test and the statement
 *      count does not move.
 *   5. **One page the model cannot summarise does not hold the rest of the brain
 *      hostage.** The second failure this suite is written against, observed on
 *      the same brain after the first was fixed: the cycle ran, did real work,
 *      and stopped at `phase_failed` with the fact count flat at 167 over 5,608
 *      pages. `runSynopsisPhase` returned on the *first* page it could not
 *      summarise, which stopped the cycle, which left the run open, which left
 *      `extract`'s checkpoint standing — and a model phase with a checkpoint
 *      against an open run is skipped on every resume. So one unusable page
 *      stopped extraction for every other page, permanently, and the brain that
 *      looked broken was one page's worth of broken. That is the same shape as
 *      the embed batch that wedged ingest: one un-processable item stopping
 *      everything behind it.
 *   6. **And the skip alone was not enough.** Section 5's tolerance defers the
 *      freeze rather than removing it: a skipped page writes nothing, so
 *      `selectIngestedPages(unsummarised)` offers it again — every good page
 *      leaves the candidate set and every unusable one stays, until the
 *      unusable ones are all that is left, adjacent at the head of a fixed
 *      ordering, tripping the consecutive bound at the first three calls of
 *      every cycle. The terminal state is the freeze it was meant to fix. So a
 *      page the model can *never* read has to LEAVE the set, and section 6 is
 *      the pair of properties that makes that safe: the set shrinks under
 *      unreadable pages, and a page failing on a transient is still a candidate
 *      next cycle.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { TransportError } from '../../src/ai/gateway.ts';
import {
  completePhase,
  openRun,
  recordProgress,
} from '../../src/worker/consolidate/checkpoint.ts';
import { runConsolidationCycle, runDeterministicPhase } from '../../src/worker/consolidate/cycle.ts';
import { createAttemptBudget } from '../../src/worker/consolidate/deadline.ts';
import { reconcileAllEdges } from '../../src/worker/consolidate/deterministic.ts';
import { NO_SPEND } from '../../src/worker/consolidate/estimate.ts';
import {
  CONSECUTIVE_ITEM_FAILURE_LIMIT,
  QUARANTINE_AFTER_REFUSALS,
  runSynopsisPhase,
} from '../../src/worker/consolidate/model-phases.ts';
import { DETERMINISTIC_PHASES } from '../../src/worker/consolidate/phases.ts';
import {
  CALLER,
  TENANT,
  countRows,
  createGateway,
  createTenantFixture,
  seedFact,
  seedPage,
  uncappedBudget,
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
async function seedBrain(pages: number, from = 0): Promise<void> {
  const { sql } = tenant;
  for (let index = from; index < from + pages; index++) {
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

/**
 * How many canonical summary **rows** exist.
 *
 * One per page the phase summarised — *not* one per model call, since a call
 * whose answer could not be read writes nothing and the page is offered again.
 * The gap between this and `callsFor('synopsis')` is what section 5 measures.
 */
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

      // **Reconciliation was the one phase whose cost was per *fact*.** Every
      // implied edge resolved its two entities and each resolution was its own
      // round trip, which measured 8.42 round trips per live fact cold. It now
      // resolves the whole pass's names in batches, so the bound below is stated
      // per fact only so that a corpus stating more claims per page cannot
      // silently relax it — the cost no longer tracks the fact count at all. The
      // rate itself is pinned in its own test at the bottom of this file, which
      // is where the arithmetic back to a 5,608-page brain is written out.
      const facts = await countRows(tenant.sql, 'fact', 'superseded_by IS NULL');
      // `facts / 4` is sound only for a pass in which no entity's origin set
      // grows, and this fixture structurally cannot widen — cold creates
      // everything, warm and grown change no origins. So this bound has no
      // teeth against the one shape that still costs per fact:
      // `5·W + 2·Σdegree(W)` for the W entities whose origins grow. That is
      // measured and disclosed in docs/deploy.md rather than asserted here,
      // because a bound this fixture cannot violate is not a guard.
      expect(cost.get('link_reconcile')).toBeLessThanOrEqual(facts / 4);

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
        // The phase the clock caught, as rung 20 records it. Carried here so the
        // resumed cycle below is resuming a row that names something — which is
        // the state a real interrupted attempt leaves, and the state whose
        // attribution the completing cycle has to clear.
        stoppedPhase: { phase: 'synopsis', code: 'out_of_time' },
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

// ---------------------------------------------------------------------------
// 4. The phase that could not yield, and therefore had to become cheap.
// ---------------------------------------------------------------------------

/**
 * `link_reconcile` costs round trips per *pass*, not per fact.
 *
 * **Why this phase and not another.** Every other phase here consults the budget
 * between units of work and returns `done: false`, which is a clean
 * `out_of_time`: a run record, no attempt charged, the next attempt resumes by
 * repetition. `reconcileAllEdges` cannot do that — an edge missing from a
 * half-built desired set is an edge the diff *deletes* — so it yields only to a
 * lost lease. A phase that will not stop on the clock is a phase that gets
 * **reaped** when it overruns, and a reap charges an attempt against a ladder
 * that dead-letters after five. Being expensive is a different kind of problem
 * here than it is anywhere else in the file.
 *
 * **The arithmetic, which is the whole reason for the bound below.** A 14-minute
 * attempt at the incident fleet's 36ms worker-to-database latency buys about
 * 23,300 sequential round trips for the entire deterministic prefix. The brain
 * that dead-lettered is 5,608 pages ≈ 11,200 facts once extraction actually
 * runs:
 *
 *   * At the shape this test was written against — two `resolveOrCreateEntity`
 *     calls per implied edge, each of them two to six round trips, plus a probe
 *     loop per new slug — it measured **8.42 round trips per live fact cold** and
 *     4.01 warm. 11,200 facts × 8.42 ≈ 94,000 round trips: four whole attempts
 *     for one phase, before any other phase ran. The reassuring "214ms, never the
 *     problem" figure recorded in the code was taken on a brain with 160 facts,
 *     *because* extraction had dead-lettered — so it could not support the
 *     conclusion drawn from it.
 *   * The ceiling asserted here is **one round trip per four live facts**. At
 *     11,200 facts that is 2,800 round trips ≈ 101 seconds, about an eighth of
 *     the attempt, which leaves the prefix's other five phases their share.
 *
 * **Counted, never timed.** Same reason as the first test in this file: on
 * localhost the 8.42-per-fact version is also fast, which is exactly how this was
 * missed.
 */
describe('reconciliation costs round trips per pass rather than per fact', () => {
  test(
    'doubling the corpus does not double the statements',
    async () => {
      const PAGES = 120;
      await seedBrain(PAGES);

      /** The denominator: what `LIVE_FACT` means, spelled out. */
      const liveFacts = (): Promise<number> =>
        countRows(
          tenant.sql,
          'fact',
          'deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL',
        );

      // **Cold**: no entity exists yet, so this pass creates every one of them,
      // allocates every slug and inserts every edge. It is the expensive
      // direction and the one the incident brain would have taken.
      const cold = { statements: 0 };
      const first = await reconcileAllEdges(countingSql(tenant.sql, cold), {
        taxonomyVersion: 1,
      });
      expect(first.done).toBe(true);
      expect(first.added).toBeGreaterThan(0);
      const factsAtFirst = await liveFacts();
      expect(cold.statements).toBeLessThanOrEqual(factsAtFirst / 4);

      // **Warm**: the nightly shape. Every entity resolves, every edge is already
      // present, and the pass still has to prove that by recomputing the desired
      // set from every live fact.
      const warm = { statements: 0 };
      const second = await reconcileAllEdges(countingSql(tenant.sql, warm), {
        taxonomyVersion: 1,
      });
      expect(second.done).toBe(true);
      expect(second.removed).toBe(0);
      expect(second.added).toBe(0);
      expect(warm.statements).toBeLessThanOrEqual(factsAtFirst / 4);

      // **A rate rather than a constant.** A bound stated per fact is satisfied
      // by any fixed cost at one corpus size, so the corpus doubles and the
      // *marginal* cost is what gets asserted. Everything a second 120 pages adds
      // is a longer array inside statements that were being issued anyway: one
      // more batch of names to resolve, one more batch of entities to create, one
      // more batch of edges to insert. The ceiling is per batch group, not per
      // fact, so it does not move with the corpus.
      await seedBrain(PAGES, PAGES);
      const grown = { statements: 0 };
      const third = await reconcileAllEdges(countingSql(tenant.sql, grown), {
        taxonomyVersion: 1,
      });
      expect(third.done).toBe(true);
      const factsAtThird = await liveFacts();
      expect(factsAtThird).toBeGreaterThanOrEqual(2 * factsAtFirst);
      expect(grown.statements).toBeLessThanOrEqual(factsAtThird / 4);
      // 240 more live facts for at most a handful more statements. At the rate
      // this phase used to run, the same 240 facts cost about 2,000.
      expect(grown.statements - warm.statements).toBeLessThanOrEqual(8);
    },
    SETUP_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 5. The poison page, and the phase that used to stop on it.
// ---------------------------------------------------------------------------

/**
 * The chain that turned one unusable page into a brain that stopped growing.
 *
 * Four links, and only the first one is about the page:
 *
 *   1. the synopsis phase calls the model once per page and returned on the
 *      first answer it could not read;
 *   2. a model phase that stops stops the cycle, at `phase_failed`;
 *   3. a cycle that stops short leaves its run **open**, because that null
 *      `finished_at` is what the next cycle resumes into;
 *   4. a model phase with a checkpoint against an open run is skipped on every
 *      resume — so `extract`, banked by an earlier attempt of the same run,
 *      never ran again and the fact count could not move.
 *
 * The brain this was measured on had 5,608 pages and 167 facts, flat for hours,
 * with `extract` holding a checkpoint at exactly its batch bound. Nothing was
 * broken about extraction; it had finished once and was being skipped by a run
 * that a later phase was holding open.
 *
 * So the property is not "the phase tolerates bad output" — it is **the cycle
 * still reaches `complete`**, which is the only state that closes the run and
 * clears the checkpoints. Both halves are asserted below, because the first one
 * without the second is a phase that survived and a brain that did not.
 */
describe('a page the model cannot summarise does not stop the cycle', () => {
  test(
    'the other pages are summarised, the run closes, and its checkpoints go with it',
    async () => {
      const PAGES = 6;
      const POISON = 'Thread 3';
      await seedBrain(PAGES);

      // One page answers with prose instead of JSON — the `bad_output` code, on
      // one item out of six. Keyed on the title inside the prompt rather than on
      // a call counter, because `selectIngestedPages` orders by salience and a
      // counter would be asserting against whichever page happened to sort third.
      const { gateway, transport } = createGateway({
        chat: {
          ...SCRIPT,
          synopsis: (request) =>
            request.input.kind === 'chat' && request.input.user.includes(POISON)
              ? 'I am afraid I cannot summarise that.'
              : JSON.stringify({ summary: 'A thread about a hire.' }),
        },
      });

      const result = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now: new Date() },
      );

      // **The claim.** Before the fix this was `phase_failed` at
      // `{ phase: 'synopsis', code: 'bad_output' }`, with however many pages
      // happened to sort ahead of the poison one summarised and the rest of the
      // cycle — contradiction, salience refinement — never reached.
      expect(result.stopReason).toBe('complete');
      expect(result.stoppedPhase).toBeNull();
      expect(result.dreamt).toBe(true);

      // Every page was tried; five of the six were written down. The page that
      // could not be summarised is counted, not silently dropped: it stays
      // unsummarised, so the next cycle selects it and tries again.
      expect(transport.callsFor('synopsis').length).toBe(PAGES);
      expect(await summaryPages()).toBe(PAGES - 1);

      // Links 3 and 4 of the chain, which are the ones that mattered. A closed
      // run has no checkpoints, so the next cycle runs `extract` again — which
      // is the whole of what "the fact count can move" means here.
      const open = await countRows(tenant.sql, 'consolidation_run', 'finished_at IS NULL');
      expect(open).toBe(0);
      expect(await countRows(tenant.sql, 'consolidation_checkpoint')).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'a provider that is down stops the phase after a bounded run of failures, not one call per page',
    async () => {
      const PAGES = 8;
      await seedBrain(PAGES);

      // The other half of the same decision. Skipping an item is only safe while
      // "this item" and "the provider" stay distinguishable, and the thing that
      // distinguishes them is that a broken provider fails *every* call. Without
      // a bound, tolerating a per-item failure would buy 200 sequential calls
      // into a provider that is down — a phase that costs a full attempt and a
      // full batch of spend to discover what its first three calls already knew.
      const { gateway, transport } = createGateway({
        chat: SCRIPT,
        failOn: 'synopsis',
        failWith: new Error('provider down'),
      });
      const run = await openRun(tenant.sql, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now: new Date(),
        estimateMicroUsd: NO_SPEND,
      });

      const outcome = await runSynopsisPhase({
        sql: tenant.sql,
        gateway,
        tenantId: TENANT,
        caller: CALLER,
        runId: run.run.runId,
        now: new Date(),
        budget: uncappedBudget('synopsis'),
      });

      expect(outcome.stopped).toBe('model_unavailable');
      expect(outcome.applied).toBe(0);
      expect(transport.callsFor('synopsis').length).toBe(CONSECUTIVE_ITEM_FAILURE_LIMIT);
      expect(CONSECUTIVE_ITEM_FAILURE_LIMIT).toBeLessThan(PAGES);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'a phase that summarised nothing reports the failure rather than a quiet success',
    async () => {
      // Fewer pages than the consecutive bound, so the bound cannot be what
      // stops this — and the phase still has to say something failed. A phase
      // that skipped every item and returned `stopped: null` would bank a
      // checkpoint saying `synopsis` is paid for, and would read on the run
      // record exactly like a brain with nothing left to summarise. That is the
      // "a refusal is carried out, never swallowed" rule at the point where
      // per-item tolerance would quietly repeal it.
      const PAGES = CONSECUTIVE_ITEM_FAILURE_LIMIT - 1;
      await seedBrain(PAGES);

      const { gateway, transport } = createGateway({
        chat: { ...SCRIPT, synopsis: () => 'I am afraid I cannot summarise that.' },
      });
      const run = await openRun(tenant.sql, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now: new Date(),
        estimateMicroUsd: NO_SPEND,
      });

      const outcome = await runSynopsisPhase({
        sql: tenant.sql,
        gateway,
        tenantId: TENANT,
        caller: CALLER,
        runId: run.run.runId,
        now: new Date(),
        budget: uncappedBudget('synopsis'),
      });

      expect(transport.callsFor('synopsis').length).toBe(PAGES);
      expect(outcome.applied).toBe(0);
      expect(outcome.stopped).toBe('bad_output');
    },
    SETUP_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 6. The link the skip did not break: a page that can never be read must leave.
// ---------------------------------------------------------------------------

/**
 * The candidate set shrinks under unreadable pages, so the phase can finish.
 *
 * **Why section 5's skip was not the fix.** `selectIngestedPages(unsummarised)`
 * excludes a page only once a summary row exists for it. A skipped page writes
 * nothing, so every *good* page leaves the candidate set and every unusable one
 * stays. The set converges monotonically onto the unusable pages; the ordering
 * (`salience DESC NULLS LAST, page_id`) is a fixed key, so they end up adjacent
 * at the head; three adjacent failures trip the consecutive bound at calls one
 * to three of every cycle with `applied === 0`; and the terminal state is
 * byte-identical to the freeze the skip was written to fix.
 *
 * So this asserts the property the skip could not: **the run CLOSES.** That is
 * the only state that clears `extract`'s checkpoint, which is the only thing
 * that lets the fact count move.
 */
describe('a page the model can never read leaves the candidate set', () => {
  test(
    'unreadable pages plus good ones converge: every good page summarised, the run closed',
    async () => {
      const PAGES = 8;
      // Interleaved rather than contiguous, so the run is not trivially the
      // shape where the poison sorts last and never blocks anything.
      const POISON = new Set(['Thread 1', 'Thread 3', 'Thread 5']);
      const GOOD = PAGES - POISON.size;
      await seedBrain(PAGES);

      // **A durable refusal, not a flaky one.** 413 is the provider saying the
      // request itself is unacceptable — the same page will be refused the same
      // way forever, which is the only evidence that licenses removing a page
      // from the set. The gateway keeps the status and discards everything else.
      const { gateway } = createGateway({
        chat: {
          ...SCRIPT,
          synopsis: (request) => {
            if (request.input.kind !== 'chat') return JSON.stringify({ summary: 'A thread.' });
            for (const title of POISON) {
              if (request.input.user.includes(title)) {
                throw new TransportError('request payload too large', 413);
              }
            }
            return JSON.stringify({ summary: 'A thread about a hire.' });
          },
        },
      });

      // One instant for every cycle: salience decays with age and orders the
      // candidate set, so a moving `now` would reshuffle the queue between
      // cycles and make "the set shrank" unanswerable.
      const now = new Date();

      // **A bound with an argument behind it, not a guess.** Every cycle makes
      // at least one unit of progress on the set: the first candidate is either
      // a good page (summarised, leaves) or an unreadable one (earns a strike).
      // So the work is bounded by the good pages plus the strikes the
      // unreadable ones must accumulate, and one more cycle to find nothing
      // left to do.
      //
      // **Run to the bound rather than stopping at the first `complete`.** The
      // first cycle of this shape completes on any version of the code — five
      // good pages are summarised and the three unreadable ones are scattered
      // among them, so the consecutive bound never trips. The freeze arrives on
      // the cycle *after*, when the unreadable pages are all that is left and
      // are adjacent. What converges is the steady state, so the steady state is
      // what gets asserted.
      const MAX_CYCLES = GOOD + POISON.size * QUARANTINE_AFTER_REFUSALS + 2;
      const reasons: string[] = [];
      for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
        const result = await runConsolidationCycle(
          { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
          { trigger: 'time_ceiling', tier: 'paid', now },
        );
        reasons.push(result.stopReason);
      }

      // **The assertion the previous attempt could not make.** With the skip
      // alone this reads `phase_failed`: every cycle from the second on stopped
      // in `synopsis` at call three with nothing applied, so the run never
      // closed and `extract`'s checkpoint stood in front of every resume.
      expect(reasons.at(-1)).toBe('complete');

      // Every good page is summarised, and the unreadable ones are the only
      // thing missing.
      expect(await summaryPages()).toBe(GOOD);

      // The unreadable pages left the set the one way `selectIngestedPages`
      // already honours — and each one says under which code, so an operator can
      // see how many pages this has taken and why without reading any of them.
      expect(
        await countRows(tenant.sql, 'page', "quarantined_at IS NOT NULL AND quarantine_reason = 'input_rejected'"),
      ).toBe(POISON.size);

      // And nothing else was touched. Every good page is still live, so "the set
      // shrank" cannot be satisfied by a phase that retired the corpus.
      expect(
        await countRows(tenant.sql, 'page', "derivation = 'ingested' AND quarantined_at IS NULL"),
      ).toBe(GOOD);

      // Links 3 and 4 of the original chain, which are the ones that starved the
      // brain: a closed run has no checkpoints, so the next cycle runs `extract`
      // again rather than skipping it forever.
      expect(await countRows(tenant.sql, 'consolidation_run', 'finished_at IS NULL')).toBe(0);
      expect(await countRows(tenant.sql, 'consolidation_checkpoint')).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );
});

/**
 * The half that protects the user, and the one a green "the freeze lifts" test
 * would never have caught.
 *
 * **Quarantining on a transient is a worse bug than the freeze**, and the
 * asymmetry is the entire reason the threshold and the status check exist. The
 * freeze is loud: it is on the run record, in the cycle log, and in a fact count
 * that visibly stops moving. A page dropped from consolidation because the
 * provider had a bad minute is silent — the cycle completes, the fact count
 * grows, and the only symptom is that the brain has quietly stopped reading
 * something its owner still has.
 *
 * So the assertion is the negative one: however many times a transient recurs,
 * it moves no counter and retires nothing, and the page is still there to be
 * summarised the moment the provider comes back.
 */
describe('a page that failed on a transient is still a candidate next cycle', () => {
  test(
    'a rate-limited page is never retired, however many cycles it fails in',
    async () => {
      const PAGES = 4;
      const FLAKY = 'Thread 2';
      await seedBrain(PAGES);
      const now = new Date();

      // 429 is a 4xx and is emphatically not durable — it is the fleet being
      // told to slow down. A rule that read "the provider refused, so the page
      // is bad" would retire a page on every busy hour, which is how a
      // well-meaning quarantine turns one rate limit into permanent data loss.
      let outage = true;
      const { gateway } = createGateway({
        chat: {
          ...SCRIPT,
          synopsis: (request) => {
            if (
              outage &&
              request.input.kind === 'chat' &&
              request.input.user.includes(FLAKY)
            ) {
              throw new TransportError('slow down', 429);
            }
            return JSON.stringify({ summary: 'A thread about a hire.' });
          },
        },
      });

      // More cycles than the threshold, by a clear margin: if a transient
      // counted at all, this page would have been retired several times over.
      const CYCLES = QUARANTINE_AFTER_REFUSALS + 3;
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        await runConsolidationCycle(
          { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
          { trigger: 'time_ceiling', tier: 'paid', now },
        );
      }

      // **Nothing moved.** Not the quarantine, and not the counter behind it —
      // a counter that crept during an outage would be a page one durable
      // refusal from retirement for reasons that were never its own.
      expect(
        await countRows(tenant.sql, 'page', 'quarantined_at IS NOT NULL'),
      ).toBe(0);
      expect(
        await countRows(tenant.sql, 'page', 'consolidation_refusals > 0'),
      ).toBe(0);
      expect(await summaryPages()).toBe(PAGES - 1);

      // And the page is still a candidate, which is the whole claim: the
      // provider comes back and the brain reads it, with no operator involved.
      outage = false;
      await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now },
      );
      expect(await summaryPages()).toBe(PAGES);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'a provider that is simply unreachable retires nothing either',
    async () => {
      // The status-less shape: a socket that died, a DNS failure, a gateway that
      // never answered. `providerStatus` is null, which proves nothing about the
      // request, so it must count for nothing. This is the case a rule written
      // as "not a success, therefore the page" would sweep in wholesale — and it
      // is the case that hits EVERY page at once, so getting it wrong retires
      // the corpus rather than a page.
      const PAGES = 3;
      await seedBrain(PAGES);
      const now = new Date();

      const { gateway } = createGateway({
        chat: SCRIPT,
        failOn: 'synopsis',
        failWith: new Error('socket hang up'),
      });

      for (let cycle = 0; cycle < QUARANTINE_AFTER_REFUSALS + 2; cycle++) {
        await runConsolidationCycle(
          { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
          { trigger: 'time_ceiling', tier: 'paid', now },
        );
      }

      expect(await countRows(tenant.sql, 'page', 'quarantined_at IS NOT NULL')).toBe(0);
      expect(await countRows(tenant.sql, 'page', 'consolidation_refusals > 0')).toBe(0);
      expect(await summaryPages()).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );
});

/**
 * A page is retired at the threshold and not one refusal before it.
 *
 * Asserted against the phase directly rather than through the cycle, because
 * the claim is about *when* — and a cycle test can only observe the state after
 * a whole pass, which is exactly the resolution the claim is made at.
 */
describe('a durable refusal is evidence, not a verdict', () => {
  test(
    'the page survives every refusal before the threshold and leaves on it',
    async () => {
      const POISON = 'Thread 0';
      await seedBrain(2);
      const now = new Date();

      const { gateway } = createGateway({
        chat: {
          ...SCRIPT,
          synopsis: (request) =>
            request.input.kind === 'chat' && request.input.user.includes(POISON)
              ? // Reachable, billed, and unreadable: the durable case that needs
                // the threshold most, since one badly sampled answer and a page
                // the model can never parse look identical in a single exchange.
                'I am afraid I cannot summarise that.'
              : JSON.stringify({ summary: 'A thread about a hire.' }),
        },
      });
      const run = await openRun(tenant.sql, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now,
        estimateMicroUsd: NO_SPEND,
      });

      const runPhase = () =>
        runSynopsisPhase({
          sql: tenant.sql,
          gateway,
          tenantId: TENANT,
          caller: CALLER,
          runId: run.run.runId,
          now,
          budget: uncappedBudget('synopsis'),
        });

      // **More than one, or the loop below is vacuous and the claim with it.**
      // One phase run offers a page to the model exactly once, so a threshold
      // above one is precisely what makes retirement span independent attempts
      // — separate cycles, separately sampled answers. At one, a single bad
      // sample would be a verdict.
      expect(QUARANTINE_AFTER_REFUSALS).toBeGreaterThan(1);

      // Every pass before the last one leaves the page in the set.
      for (let strike = 1; strike < QUARANTINE_AFTER_REFUSALS; strike++) {
        const outcome = await runPhase();
        expect(outcome.quarantined).toBe(0);
        expect(await countRows(tenant.sql, 'page', 'quarantined_at IS NOT NULL')).toBe(0);
      }

      const last = await runPhase();
      expect(last.quarantined).toBe(1);
      expect(
        await countRows(tenant.sql, 'page', "quarantined_at IS NOT NULL AND quarantine_reason = 'bad_output'"),
      ).toBe(1);

      // And the reversal an operator performs when the judgement was wrong has
      // to clear the counter too — the rung's header spells the statement out.
      // Left set, the page would sit one refusal from instant re-quarantine and
      // the operator's decision would survive exactly one cycle.
      await tenant.sql`
        UPDATE page
           SET quarantined_at = NULL, quarantine_reason = NULL, consolidation_refusals = 0
         WHERE quarantined_at IS NOT NULL
      `;
      const restored = await runPhase();
      expect(restored.quarantined).toBe(0);
      expect(await countRows(tenant.sql, 'page', 'quarantined_at IS NOT NULL')).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );
});
