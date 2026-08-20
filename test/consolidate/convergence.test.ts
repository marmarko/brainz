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
 *   3. **A completed model phase is skipped when the next cycle resumes into a
 *      run nobody ever closed.** That is KTD11's checkpoint, and since rung 23
 *      there is exactly one way to be in that state: a cycle that was killed and
 *      never wrote anything. A cycle that RETURNS closes its run whatever
 *      stopped it — see `run-closure.test.ts` for why that had to become true —
 *      so the checkpoint's subject is now the word KTD11 actually used.
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
 *   6. **A per-item failure is the item's outcome, and never the phase's.** The
 *      phase completes when it did everything it could do, *including* when
 *      everything it could do was skip — because a cycle that stops at synopsis
 *      never reaches the phases behind it, and an earlier fix that still stopped
 *      on `applied === 0` put that back the moment the unreadable pages were all
 *      that was left. Section 6 pins the three
 *      properties that make that safe: the frozen run is closed by the next
 *      cycle and the stranded checkpoint goes with it; a page the model can
 *      never read is **never removed** — still live, still returned by search,
 *      still in the user's own export, costing one call a cycle forever, which
 *      is the right side of that trade; and a provider refusing *everything*
 *      still stops the phase, decided from the answer rather than from a count
 *      of items.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { TransportError } from '../../src/ai/gateway.ts';
// The two read paths a retired page would have vanished from. They are imported
// into a *consolidation* suite deliberately: the property section 6 defends is
// not about consolidation at all, and asserting it against `page.quarantined_at`
// rather than against the readers that honour it would be asserting the
// mechanism instead of the harm.
import { ftsArm, readFtsLanguage } from '../../src/core/search/arms.ts';
import { reconstructLivePages } from '../../src/core/export/reconstruct.ts';
import {
  completePhase,
  openRun,
  readLatestRun,
} from '../../src/worker/consolidate/checkpoint.ts';
import { runConsolidationCycle, runDeterministicPhase } from '../../src/worker/consolidate/cycle.ts';
import { createAttemptBudget } from '../../src/worker/consolidate/deadline.ts';
import { reconcileAllEdges } from '../../src/worker/consolidate/deterministic.ts';
import { NO_SPEND } from '../../src/worker/consolidate/estimate.ts';
import { runSynopsisPhase } from '../../src/worker/consolidate/model-phases.ts';
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

      // The provider goes away after two pages, which is the one thing that
      // still stops this phase part-way. An unreadable *answer* would not: that
      // is one page's outcome, the phase skips it and completes. Section 6 is
      // where that difference is the subject rather than the scaffolding.
      let synopsisCalls = 0;
      const cut = createGateway({
        chat: {
          ...SCRIPT,
          synopsis: () => {
            synopsisCalls += 1;
            if (synopsisCalls > FIRST_ATTEMPT_CALLS) throw new Error('socket hang up');
            return JSON.stringify({ summary: 'A thread about a hire.' });
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

      // **A new run, and the claim below does not care.** The first cycle
      // returned, so it closed its run and took its checkpoints with it — this
      // is a fresh pass over the corpus, not a resumption. That the phase still
      // does not re-pay is the point: its progress is durable in the CONTENT,
      // which is what makes it safe for a run to end wherever a cycle does.
      expect(second.resumed).toBe(false);
      expect(second.runId).not.toBe(first.runId);

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

describe('a run no cycle ever closed is resumed without re-paying for it', () => {
  test(
    'a model phase banked against it is skipped, not called again',
    async () => {
      await seedBrain(4);
      const now = new Date();

      // **The state, and since rung 23 there are exactly two ways into it.** A
      // process that died mid-cycle, which writes nothing at all; and — for the
      // length of one rolling deploy — the previous fleet version, which wrote
      // the reason and the spend and deliberately left `finished_at` null so the
      // next cycle would resume. The second is built here because it is the
      // harder one: the row names a phase, and a cycle that adopts it has to
      // clear that attribution rather than leave a later success sitting under
      // an earlier failure.
      //
      // Built directly rather than provoked, because provoking it means tuning a
      // tick budget to land between two model phases — which tests the tuning
      // rather than the resume, and re-tunes itself every time a phase changes
      // how often it reads the clock.
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
      // Written as the retired `recordProgress` wrote it — every column of the
      // run record except `finished_at`. Raw SQL rather than a helper, because
      // the code that produced this shape is gone and a helper kept alive to
      // reproduce it in a test would be an exit somebody could take again.
      await tenant.sql`
        UPDATE consolidation_run
           SET dreamt = false, stop_reason = 'out_of_time', spent_micro_usd = 9000,
               model_calls = 4, phases_run = 7, wall_clock_ms = 840000,
               stopped_phase = 'synopsis', stopped_phase_code = 'out_of_time'
         WHERE run_id = ${opened.run.runId}::bigint
      `;

      const { gateway, transport } = createGateway({ chat: SCRIPT });
      const next = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now },
      );

      // **The claim, and it is KTD11's sentence.** The same run, the paid phase
      // skipped by name, and not one call to the provider for work somebody has
      // already been billed for.
      expect(next.runId).toBe(opened.run.runId);
      expect(next.resumed).toBe(true);
      const extract = next.phases.find((record) => record.phase === 'extract');
      expect(extract?.ran).toBe(false);
      expect(extract?.skipped).toBe('checkpointed');
      expect(transport.callsFor('extract')).toEqual([]);

      // And the spend it already carried stays on the run's total, or the tenant's
      // bill would reset every time an attempt did.
      expect(next.spentMicroUsd).toBeGreaterThanOrEqual(9_000);

      // **The free ride is taken once.** The adopting cycle closes the run it
      // adopted — that is rung 23's whole subject — and the attribution the
      // stopped attempt left is cleared with it, so the row does not name a
      // phase that stopped nothing.
      expect(await countRows(tenant.sql, 'consolidation_run', 'finished_at IS NULL')).toBe(0);
      expect(await countRows(tenant.sql, 'consolidation_checkpoint')).toBe(0);
      const closed = (await tenant.sql`
        SELECT stop_reason, stopped_phase, resumed_at
          FROM consolidation_run WHERE run_id = ${opened.run.runId}::bigint
      `) as Array<{ stop_reason: string; stopped_phase: string | null; resumed_at: Date | null }>;
      expect(closed[0]?.stop_reason).toBe('complete');
      expect(closed[0]?.stopped_phase).toBeNull();
      expect(closed[0]?.resumed_at).not.toBeNull();

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
 *   3. a cycle that stopped short left its run **open**, because that null
 *      `finished_at` was what the next cycle resumed into;
 *   4. a model phase with a checkpoint against an open run is skipped on every
 *      resume — so `extract`, banked by an earlier attempt of the same run,
 *      never ran again and the fact count could not move.
 *
 * Link 3 is gone since rung 23 — a cycle that returns closes its run, whatever
 * stopped it — so this test now asserts more than it was written to. Both fixes
 * stay: this one is about the cycle finishing its WORK, and rung 23 is about the
 * cycle ENDING. A brain that stops at synopsis every night still never reaches
 * contradiction or salience refinement, however cleanly its runs close.
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
      expect(result.skippedItems).toBe(1);

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
    'a phase whose every page was unreadable still completes, and says how many it skipped',
    async () => {
      // **The case the previous two attempts got wrong, in opposite directions.**
      // The first returned the last failure whenever `applied === 0`, so a pass
      // that could only skip put the cycle back into `phase_failed` the moment
      // the unreadable pages were all that was left — which is the freeze, a few
      // cycles later. The second removed that by removing the pages, which took
      // a person's document out of their own search.
      //
      // The phase did everything it could do. That it could do nothing is a fact
      // about the corpus, and it is reported as a count rather than as a stop,
      // because a stop is what keeps the cycle from reaching the phases behind
      // this one.
      const PAGES = 3;
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

      // Every page was offered — no bound cut the pass short — and the phase
      // finished.
      expect(transport.callsFor('synopsis').length).toBe(PAGES);
      expect(outcome.applied).toBe(0);
      expect(outcome.stopped).toBeNull();
      expect(outcome.skippedItems).toBe(PAGES);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'a reasoning model that thinks and never answers costs one page, not the pass',
    async () => {
      // **Measured on the live synopsis seat, which is a reasoning model.** Its
      // `max_tokens` has to cover the trace AND the answer; when it does not,
      // the provider returns HTTP 200 with `content: null` and the whole budget
      // spent on `reasoning`. Nineteen calls in a row answered and the twentieth
      // did this.
      //
      // The gateway names that `reasoning_only_output` — correctly, and then
      // `stopFor` folded it in with a dead provider, so ONE unlucky sample
      // stopped the phase and every page behind it. On the brain it happened to,
      // a cycle produced 48 summaries out of 3,400 and reported
      // `phase_failed at synopsis / model_unavailable`, which sent every reader
      // looking for an outage that was not there.
      //
      // It is the page's outcome: the provider answered, about this request, and
      // the next page gets a fresh sample.
      const PAGES = 3;
      await seedBrain(PAGES);

      let call = 0;
      const { gateway, transport } = createGateway({
        chat: {
          ...SCRIPT,
          synopsis: () => {
            call += 1;
            // The middle page only. The pages either side must be summarised,
            // which is what separates "skipped one" from "gave up".
            return call === 2
              ? { text: '', reasoning: 'Okay, let me think about this thread. The user wants…' }
              : JSON.stringify({ summary: 'A thread about a hire.' });
          },
        },
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

      // The phase COMPLETED, so every phase behind it is still reached.
      expect(outcome.stopped).toBeNull();
      // Every page was offered — the pass was not cut short at the second.
      expect(transport.callsFor('synopsis').length).toBe(PAGES);
      // Two summarised, one passed over and counted rather than swallowed.
      expect(outcome.applied).toBe(PAGES - 1);
      expect(outcome.skippedItems).toBe(1);
    },
    SETUP_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 6. The link that actually had to break, and the one that must not.
// ---------------------------------------------------------------------------

/**
 * The freeze lifting, asserted from the state a frozen brain is actually in.
 *
 * **Why this is built rather than looped into.** Under the code below every
 * cycle completes from the first one, so running N cycles and asserting the last
 * one completed never passes through the frozen state and proves nothing about
 * leaving it. The state is therefore constructed exactly as a production brain
 * carried it for hours: a run with no `finished_at`, `extract` banked against it
 * at its batch bound, and `synopsis` named on the record as the phase that
 * stopped the cycle. That is the shape in which 5,608 pages sat behind 167
 * facts.
 *
 * The claim is the whole chain unwinding in one cycle: the stranded checkpoint
 * is honoured once more (nobody re-pays for extraction), the phase that was
 * holding the run open now completes through the pages it cannot read, the run
 * CLOSES, the checkpoint goes with it — and the next cycle calls `extract`
 * again, which is the thing the brain had not done in hours.
 */
describe('a run frozen by a page the model cannot read is closed by the next cycle', () => {
  test(
    'the stranded extract checkpoint clears, the run closes, and extraction runs again',
    async () => {
      const PAGES = 8;
      // Interleaved rather than contiguous, so the pass is not trivially the
      // shape where the unreadable pages sort last and block nothing.
      const POISON = new Set(['Thread 1', 'Thread 3', 'Thread 5']);
      const GOOD = PAGES - POISON.size;
      await seedBrain(PAGES);

      // One instant for every cycle: salience decays with age and orders the
      // candidate set, so a moving `now` would reshuffle the queue between
      // cycles and make "what did the second cycle see" unanswerable.
      const now = new Date();

      // **The frozen state, built rather than provoked.** `extract` completed on
      // an earlier attempt of this run and banked its checkpoint; `synopsis`
      // then stopped the cycle, which left `finished_at` null, which is what a
      // resume reads — and a model phase with a checkpoint against an open run
      // is skipped on every one.
      const opened = await openRun(tenant.sql, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now,
        estimateMicroUsd: NO_SPEND,
      });
      await completePhase(tenant.sql, opened.run, 'extract', {
        items: 200,
        spentMicroUsd: 9_000,
        now,
      });
      // The row exactly as the fleet version that produced it wrote it: every
      // column of the record except `finished_at`. Raw SQL because the code that
      // wrote this shape is retired, and a helper kept alive to reproduce it
      // would be an exit somebody could take again.
      await tenant.sql`
        UPDATE consolidation_run
           SET dreamt = false, stop_reason = 'phase_failed', spent_micro_usd = 9000,
               model_calls = 15, phases_run = 9, wall_clock_ms = 120000,
               stopped_phase = 'synopsis', stopped_phase_code = 'bad_output'
         WHERE run_id = ${opened.run.runId}::bigint
      `;

      const { gateway, transport } = createGateway({
        chat: {
          ...SCRIPT,
          synopsis: (request) => {
            if (request.input.kind !== 'chat') return JSON.stringify({ summary: 'A thread.' });
            for (const title of POISON) {
              if (request.input.user.includes(title)) return 'I am afraid I cannot summarise that.';
            }
            return JSON.stringify({ summary: 'A thread about a hire.' });
          },
        },
      });

      const thaw = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now },
      );

      // It resumed the frozen run, and honoured the checkpoint one last time —
      // the point of the checkpoint is that nobody pays for extraction twice.
      expect(thaw.runId).toBe(opened.run.runId);
      expect(thaw.resumed).toBe(true);
      const stranded = thaw.phases.find((record) => record.phase === 'extract');
      expect(stranded?.ran).toBe(false);
      expect(stranded?.skipped).toBe('checkpointed');
      expect(transport.callsFor('extract')).toEqual([]);

      // **The assertion neither previous attempt could make.** The phase worked
      // through the pages it could not read instead of stopping on them, so the
      // cycle completed, so the run closed, so the checkpoint that was standing
      // in front of extraction went with it.
      expect(thaw.stopReason).toBe('complete');
      expect(thaw.stoppedPhase).toBeNull();
      expect(await summaryPages()).toBe(GOOD);
      expect(thaw.skippedItems).toBe(POISON.size);
      expect(await countRows(tenant.sql, 'consolidation_run', 'finished_at IS NULL')).toBe(0);
      expect(await countRows(tenant.sql, 'consolidation_checkpoint')).toBe(0);

      // And the thing the brain had not done in hours. `extract` is called on
      // the next cycle, against a fresh run with no checkpoint in front of it —
      // which is the whole of what "the fact count can move again" means.
      const next = createGateway({ chat: SCRIPT });
      const after = await runConsolidationCycle(
        { sql: tenant.sql, gateway: next.gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now },
      );
      expect(after.resumed).toBe(false);
      expect(next.transport.callsFor('extract').length).toBeGreaterThan(0);
      expect(after.stopReason).toBe('complete');
    },
    SETUP_TIMEOUT_MS,
  );
});

/**
 * The property this redesign exists for, and the one a green "the freeze lifts"
 * test will never catch.
 *
 * An earlier fix broke the chain by removing the page: two durable refusals set
 * `page.quarantined_at`, which the candidate query already honoured. It worked,
 * and it was the wrong column — `quarantined_at` is U9's junk gate, and **every
 * read in the system honours it**. A page retired by the summariser leaves
 * `src/core/search/arms.ts`, the briefing, and the user's own self-export in
 * `src/core/export/reconstruct.ts`. The harm was never "missing from
 * consolidation"; it was a document its owner still has, no longer coming back
 * when they search their own brain.
 *
 * And the evidence could not carry that. `stopFor` can prove a 400/413/422 is
 * the provider refusing THIS request, but the widest failure — an HTTP 200
 * whose body will not parse — is a page the model can never read and a badly
 * sampled answer at the same time, and the code says in as many words that it
 * cannot tell them apart in one exchange. Retiring on an inference the code
 * admits it cannot make is how a bad minute at a provider becomes data loss.
 *
 * So nothing is retired. The page stays a candidate and costs a call per cycle
 * for as long as it stays unreadable — a small, permanent, bounded price, and
 * the right side of that trade. These are the assertions that hold the line.
 */
describe('a page the model can never read is still the user\'s page', () => {
  test(
    'it is never retired: still live, still returned by search, still in the export',
    async () => {
      const PAGES = 4;
      const POISON = 'Thread 3';
      // The body term is unique to the unreadable page, so the search assertion
      // below is about that page and not about the corpus.
      const POISON_TERM = 'Person3';
      await seedBrain(PAGES);
      const now = new Date();

      const { gateway } = createGateway({
        chat: {
          ...SCRIPT,
          synopsis: (request) =>
            request.input.kind === 'chat' && request.input.user.includes(POISON)
              ? // Reachable, billed, and unreadable. The durable case that no
                // threshold can make safe: one badly sampled answer and a page
                // the model can never parse look identical in every exchange.
                'I am afraid I cannot summarise that.'
              : JSON.stringify({ summary: 'A thread about a hire.' }),
        },
      });

      // Far more cycles than any retirement threshold would have been. Under the
      // fix this refuted, the page was gone after the second.
      const CYCLES = 5;
      const reasons: string[] = [];
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        const result = await runConsolidationCycle(
          { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
          { trigger: 'time_ceiling', tier: 'paid', now },
        );
        reasons.push(result.stopReason);
      }

      // Every cycle completed. The unreadable page never held the run open, so
      // it never stranded another phase's checkpoint.
      expect(reasons).toEqual(Array.from({ length: CYCLES }, () => 'complete'));
      expect(await summaryPages()).toBe(PAGES - 1);

      // **Nothing was retired.** Not by the summariser, not by anything.
      expect(await countRows(tenant.sql, 'page', 'quarantined_at IS NOT NULL')).toBe(0);
      expect(
        await countRows(tenant.sql, 'page', "derivation = 'ingested' AND deleted_at IS NULL"),
      ).toBe(PAGES);

      // The refusals were counted, which is the whole of what the evidence is
      // allowed to do now: one per cycle, on the page, for an operator to read.
      // A count that stopped at a threshold would be a count that was deciding
      // something.
      const refused = (await tenant.sql`
        SELECT page_id::text AS page_id, consolidation_refusals AS n
          FROM page
         WHERE consolidation_refusals > 0
      `) as Array<{ page_id: string; n: number }>;
      expect(refused.length).toBe(1);
      expect(refused[0]?.n).toBe(CYCLES);
      const poisonPageId = refused[0]?.page_id;

      // **Still returned by search.** The arm every read path goes through,
      // asked for a term only this page carries. Under the retirement this
      // replaces, the row was fenced out here by `LIVE_AND_IN_GRANT` and the
      // owner got nothing back.
      const language = await readFtsLanguage(tenant.sql);
      const found = await ftsArm(tenant.sql, {
        query: POISON_TERM,
        grant: ['personal:mail'],
        limit: 10,
        ftsLanguage: language,
      });
      expect(found.ranked.length).toBeGreaterThan(0);
      expect(
        [...found.candidates.values()].some((candidate) => candidate.pageId === poisonPageId),
      ).toBe(true);

      // **Still in the export.** The self-export is the user taking their own
      // brain with them, and a page the summariser could not read is still
      // theirs.
      const exported = await reconstructLivePages(tenant.sql);
      expect(exported.some((page) => page.pageId === poisonPageId)).toBe(true);
    },
    SETUP_TIMEOUT_MS,
  );
});

/**
 * The one case that must still stop the phase, and the rule that decides it.
 *
 * **A failure stops the phase exactly when nothing in it is about the item.**
 * The evidence is in the answer rather than in a count: {@link stopFor} already
 * separates a provider that read the request and refused it (`input_rejected`,
 * durable — a fact about this page) from one that never gave the request a
 * verdict at all (`model_unavailable`, not durable). Every failure of the second
 * kind is the provider, the credential or the configuration — an auth refusal, a
 * key that will not resolve, a rate limit, a 5xx, a dead socket — and every
 * remaining page would fail it identically. So the first one stops the phase,
 * and no number of items is counted to reach that conclusion.
 *
 * This is what keeps "the phase completes even when all it could do was skip"
 * from meaning "a total outage reads as a clean cycle". A cycle that never
 * called a working provider must not bank a checkpoint saying the phase is paid
 * for, and must not report `complete` — an outage has to be legible as one on
 * the run record, or nobody chases the provider.
 *
 * What it must NOT do is stay open. Rung 22 separated those two: the run closes
 * and the stop reason and the phase that reported it are what say the cycle did
 * not do its job. Holding the row open said the same thing far less clearly and
 * stranded the next cycle's extraction to say it.
 */
describe('a provider refusing everything stops the phase rather than reading as skips', () => {
  test(
    'a dead provider stops on the first call, blames no page, and closes the run anyway',
    async () => {
      const PAGES = 6;
      await seedBrain(PAGES);

      // The status-less shape: a socket that died, a DNS failure, a gateway that
      // never answered. `providerStatus` is null, which proves nothing about any
      // request, so it is not durable and it is not the page's.
      const { gateway, transport } = createGateway({
        chat: SCRIPT,
        failOn: 'synopsis',
        failWith: new Error('socket hang up'),
      });

      const result = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now: new Date() },
      );

      // It stopped, and it stopped on the FIRST call — the evidence was complete
      // at one. Burning five more to reach a count would be spending the tenant's
      // money to rediscover what the first answer already said.
      expect(transport.callsFor('synopsis').length).toBe(1);
      expect(result.stopReason).toBe('phase_failed');
      expect(result.stoppedPhase).toEqual({ phase: 'synopsis', code: 'model_unavailable' });

      // **And the run closes anyway**, which is the difference rung 23 makes.
      // The outage is real and the cycle is right to stop, but "there is work
      // still owed" is not a reason to leave a run open: it was that null
      // `finished_at` — under a provider failing on exactly one page — that
      // stranded `extract`'s checkpoint and pinned a brain at 167 facts. The
      // work is still owed; the next cycle is a new pass at it, and
      // `run-closure.test.ts` is where three of those in a row are counted.
      expect(await countRows(tenant.sql, 'consolidation_run', 'finished_at IS NULL')).toBe(0);
      expect(await countRows(tenant.sql, 'consolidation_checkpoint')).toBe(0);
      const record = await readLatestRun(tenant.sql);
      expect(record?.stopReason).toBe('phase_failed');
      expect(record?.stoppedPhase).toEqual({ phase: 'synopsis', code: 'model_unavailable' });

      // And no page is answerable for it. Not retired — nothing is, ever — and
      // not even counted, because a counter that crept during an outage would be
      // telling an operator the corpus is bad when the provider was down.
      expect(await countRows(tenant.sql, 'page', 'quarantined_at IS NOT NULL')).toBe(0);
      expect(await countRows(tenant.sql, 'page', 'consolidation_refusals > 0')).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'a credential the provider refuses is systemic too, however 4xx it looks',
    async () => {
      // 401 is a 4xx and is emphatically not a fact about the request's content.
      // The remedy is a configuration change and every page fails identically,
      // which is precisely what "systemic" means here — the class a rule written
      // as "the provider refused, therefore the page" would get backwards, and
      // the one that hits every page at once.
      await seedBrain(4);

      const { gateway, transport } = createGateway({
        chat: SCRIPT,
        failOn: 'synopsis',
        failWith: new TransportError('invalid api key', 401),
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
      expect(outcome.skippedItems).toBe(0);
      expect(transport.callsFor('synopsis').length).toBe(1);
      expect(await countRows(tenant.sql, 'page', 'consolidation_refusals > 0')).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );
});

/**
 * The refusal the provider CAN attribute to the request, which is still the
 * item's and still not grounds for removing anything.
 *
 * `input_rejected` is the one failure class where the provider read what was
 * sent and said no to it — a 400/413/422. It survives from the refuted design
 * because it is a genuinely better diagnosis than "the provider was
 * unavailable", and it now does that job and only that job: the phase skips the
 * page, records the refusal, and carries on. The page is offered again next
 * cycle, because a request that is too large today is a request a re-chunk or a
 * bigger seat makes acceptable tomorrow, and nothing about that is the
 * document's fault.
 */
describe('a request the provider refuses is one page skipped, not a phase stopped', () => {
  test(
    'the refused page is skipped and counted; the pages after it are summarised',
    async () => {
      const PAGES = 6;
      const POISON = 'Thread 0';
      await seedBrain(PAGES);

      const { gateway, transport } = createGateway({
        chat: {
          ...SCRIPT,
          synopsis: (request) => {
            if (request.input.kind === 'chat' && request.input.user.includes(POISON)) {
              throw new TransportError('request payload too large', 413);
            }
            return JSON.stringify({ summary: 'A thread about a hire.' });
          },
        },
      });

      const result = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now: new Date() },
      );

      // Every page was offered, the cycle completed, and the refused page is a
      // count rather than a stop.
      expect(transport.callsFor('synopsis').length).toBe(PAGES);
      expect(result.stopReason).toBe('complete');
      expect(result.skippedItems).toBe(1);
      expect(await summaryPages()).toBe(PAGES - 1);
      expect(await countRows(tenant.sql, 'page', 'consolidation_refusals = 1')).toBe(1);
      expect(await countRows(tenant.sql, 'page', 'quarantined_at IS NOT NULL')).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );
});

/**
 * A transient costs a page nothing, which is the asymmetry the counter is built
 * around.
 *
 * Nothing is retired any more, so the stake is smaller than it was — but the
 * counter is what an operator now reads to tell "these three pages are
 * unreadable" from "the provider had a bad hour", and a counter that crept
 * during an outage would answer that question wrongly in the direction that
 * blames the corpus.
 */
describe('a page that failed on a transient is charged nothing for it', () => {
  test(
    'a rate limit moves no counter, and the page is summarised when it lifts',
    async () => {
      const PAGES = 4;
      const FLAKY = 'Thread 2';
      await seedBrain(PAGES);
      const now = new Date();

      // 429 is a 4xx and is emphatically not durable — it is the fleet being
      // told to slow down. Under the rule above it stops the phase, exactly as a
      // 5xx does, because no other page fares better against a rate limit
      // either.
      let outage = true;
      const { gateway } = createGateway({
        chat: {
          ...SCRIPT,
          synopsis: (request) => {
            if (outage && request.input.kind === 'chat' && request.input.user.includes(FLAKY)) {
              throw new TransportError('slow down', 429);
            }
            return JSON.stringify({ summary: 'A thread about a hire.' });
          },
        },
      });

      const CYCLES = 4;
      for (let cycle = 0; cycle < CYCLES; cycle++) {
        await runConsolidationCycle(
          { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
          { trigger: 'time_ceiling', tier: 'paid', now },
        );
      }

      // **Nothing was charged to any page.** However many cycles the outage
      // spans, it is not evidence about a document.
      expect(await countRows(tenant.sql, 'page', 'consolidation_refusals > 0')).toBe(0);
      expect(await countRows(tenant.sql, 'page', 'quarantined_at IS NOT NULL')).toBe(0);

      // And the brain reads it the moment the provider comes back, with no
      // operator involved.
      outage = false;
      await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now },
      );
      expect(await summaryPages()).toBe(PAGES);
    },
    SETUP_TIMEOUT_MS,
  );
});
