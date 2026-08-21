/**
 * How far each step of the pipeline has got — the read behind
 * `/dashboard?view=processing`.
 *
 * ===========================================================================
 * THE GAP THIS CLOSES, AND WHY IT IS NOT `?view=coverage`
 * ===========================================================================
 *
 * `coverage.ts` answers *what came in, and what the brain made of it*: documents
 * per origin, facts, entities, cards, edges, and one freshness verdict over the
 * cycle as a whole. It is the right page for "is my brain working". It cannot
 * answer the question that costs the most time when the answer is no — **which
 * step is behind, and is it behind because it failed or because it never got a
 * turn.**
 *
 * That distinction is not a nicety. It is the whole of the week this page was
 * written in. A brain sat at 8,584 pages and 205 facts while every clock in the
 * system read healthy: the `synopsis` phase used the whole of every attempt's
 * model half, so `contradiction` and `salience_refine` were recorded
 * `not_reached` on every cycle and never ran at all. Separately, `extract` was
 * sending its whole batch to a seat whose output ceiling could not hold the
 * answer — so the reply was truncated, the phase reported `bad_output`, and it
 * marked nothing. Coverage rendered a fact count that was not moving. Nothing in
 * the product said which of the twelve steps to look at, and the diagnosis was
 * made by a human reading SQL against the tenant database.
 *
 * So this page is a sibling and not a section. It opens the tenant database for
 * counters over `chunk`, `attachment` and `page` that `coverage.ts:137-146`
 * deliberately does not carry, and one click pays for one page.
 *
 * ===========================================================================
 * THE PRIVACY LINE, WHICH THIS PAGE WIDENS BY EXACTLY ONE CLASS
 * ===========================================================================
 *
 * `coverage.ts` states the rule this whole surface obeys: **counts,
 * closed-vocabulary codes, and instants. No names, no titles, no statements —
 * including the user's own.** Every argument for it carries here unchanged, and
 * the strongest is that this page's job is to be looked at: it gets
 * screenshotted into a support thread, cast to a meeting-room display, left open
 * on a desk. A count survives all three.
 *
 * This page renders a fourth class of value: **money**, one figure, the spend
 * the last cycle banked against itself. That is a widening and it is written
 * down rather than absorbed. The argument for it is that the failure this page
 * exists to make visible has a *cost* signature and no other: a cycle that made
 * forty calls and banked almost nothing is a cycle whose calls were answered and
 * could not be used, and that is the one shape of "not getting through" that
 * leaves no other trace on any record a page can read. A figure in dollars is
 * not personal data, does not name a correspondent, and does not become more
 * revealing in aggregate — which is the property the rule is actually defending.
 *
 * The consequence is that the page's own rule paragraph could NOT be copied from
 * `pages.ts:1297-1300`. That one promises "counts, codes and times", and a page
 * promising three classes while rendering four understates itself in the one
 * paragraph whose entire job is being exact. The sentence is extended instead,
 * and the test asserts the extended form.
 *
 * **What was refused, and it is the obvious feature.** The owner asked for
 * fractions — `extracted 4,375 / 4,543 chunks`. There is no denominator here,
 * for four reasons, and the fourth is the one that settles it:
 *
 *   1. `coverage.ts:139-146` refused chunk-level denominators once already, and
 *      the rendered page says why: counting every passage of a large brain is a
 *      scan of the biggest table it has, and this is a page load.
 *   2. Three of the six denominators — live pages, entities, facts — are already
 *      on the sibling page, so drawing them here is the duplication that makes a
 *      second page not worth its cost.
 *   3. Fractions for four steps and bare counts for two would read as a bug.
 *   4. **The denominator would go backwards while the brain worked correctly.**
 *      `writeCanonicalSummary` inserts a `model_derived` page *and a chunk
 *      against it* (`materialize.ts:653`, `:670-673`), and that chunk is never an
 *      extraction candidate — `selectExtractionCandidates` admits
 *      `derivation = 'ingested'` only. So a bare `count(*) FROM chunk` grows by
 *      one every time `synopsis` succeeds, and a fraction built on it would fall
 *      as the brain got healthier. That is not a bug to fix in the query; it is
 *      the query asking a question the schema does not have an answer to.
 *
 * If fractions are wanted later the path is a schema rung, not a page change:
 * `CREATE INDEX chunk_extract_live ON chunk (extract_considered_version) WHERE
 * deleted_at IS NULL AND quarantined_at IS NULL`, plus denormalising the page's
 * liveness onto `chunk` — because even that index does not carry the join this
 * count needs.
 *
 * ===========================================================================
 * WHAT "WAITING" MEANS, AND THE CLAIM IT DOES NOT MAKE
 * ===========================================================================
 *
 * Each number is what that phase's **own selector** would take next, whole-brain
 * and unclamped. Every predicate below is checked against the selector it
 * mirrors, and the mirror is the point: a predicate that drifts produces a meter
 * that never reaches zero, or one that reads converged while work remains, and
 * both are worse than no page at all.
 *
 * It is emphatically **not** "how many are unfinished". A phase marks a row
 * *considered* when it sent the row and got a readable answer, whether or not
 * anything came of it (`consideration.ts:26-36`). So a step with nothing waiting
 * has been *through* everything in this brain; it has not necessarily *found*
 * anything in it. A phase that answered thinly about a large batch looks
 * identical from here to one that answered well — which is the other half of
 * this week's incident, and the page says so in the reader's own words rather
 * than leaving the gap for them to fall into. The number that would close it,
 * `skippedItems`, reaches only the worker's stderr and no table, so no page can.
 *
 * ===========================================================================
 * VERSIONS ARE IMPORTED, VOCABULARIES ARE NOT RESTATED
 * ===========================================================================
 *
 * `CONSIDERATION_VERSION` is **imported**, never copied. `coverage.ts:160-178`
 * restates vocabularies deliberately, and the reason that is safe is that a
 * CHECK exists to assert them against. A version number is in no CHECK: a stale
 * copy here would report a converged brain on the very day a bump re-offered the
 * whole corpus to a phase. That module imports only `bun`'s `SQL` type and
 * `pg-values.ts`, so it pulls no cycle graph into a page render — the ban at
 * `coverage.ts:167-169` names `phases.ts` and its reason does not reach here.
 *
 * `SUMMARY_REF_PREFIX` is the opposite call: restated locally, because importing
 * the value would pull `materialize.ts` and the whole worker graph in behind it.
 * `materialize.ts:143` is the writer, and the test pins the two together.
 *
 * `cycleFreshnessOf` is **called, never re-derived**: `cycle-staleness.ts:38-49`
 * records that a freshness rule anchored on `finished_at` alone is the trap
 * class, found wrong on live data twice.
 */

import type { SQL } from 'bun';

import { cycleFreshnessOf, type CycleFreshness } from '../control/cycle-staleness.ts';
import { CONSIDERATION_VERSION } from '../worker/consolidate/consideration.ts';
import {
  CYCLE_PHASE_NAMES,
  type CyclePhaseName,
  type CyclePhaseStop,
  type CycleStopReason,
} from './coverage.ts';

/**
 * The six model phases, in `CYCLE_PHASES` order.
 *
 * The **order is read**, not merely asserted: `standingOf` decides `not_reached`
 * by position against `CYCLE_PHASE_NAMES`, so a reordering there changes what
 * this page claims. That is the same list the database's own CHECK admits
 * (`v20-stopped-phase.sql:71`).
 */
export const PROCESSING_PHASES = [
  'transcribe',
  'extract',
  'enrich',
  'synopsis',
  'contradiction',
  'salience_refine',
] as const;

export type ProcessingPhase = (typeof PROCESSING_PHASES)[number];

/**
 * `materialize.ts:143`'s prefix, restated for the reason in the header.
 *
 * A summary page is stored as an ordinary `page` whose `external_ref` is this
 * prefix followed by the id of the page it summarises, which is what makes
 * "has this been summarised" an `EXISTS` rather than a column.
 */
const SUMMARY_REF_PREFIX = 'summary:';

/**
 * What the newest run says about ONE phase, and this page's one novel inference
 * — so the derivation is written where the next reader meets it.
 *
 *  * `not_reached` — provable, and **only** when `stopReason` is `out_of_time`
 *    or `budget_exhausted`, `stoppedPhase` is non-null, and this phase comes
 *    after it in `CYCLE_PHASE_NAMES` order. Those are the two branches where
 *    `cycle.ts` sets the stop and pushes every later phase `skipped:'not_reached'`.
 *  * `stopped_here` — this phase *is* `stoppedPhase`, under those same two
 *    reasons.
 *  * `failed_here` — this phase *is* `stoppedPhase` under `phase_failed`, and it
 *    carries **no claim about the phases behind it**. Since `549787e` the loop
 *    continues past a durable phase failure and records only the first, so the
 *    phases after it were attempted and the run record says nothing about how
 *    they fared. The rendered sentence says "attempted" and stops.
 *  * `unknown` — everything else, rendering nothing. `cancelled` is here on
 *    purpose: the cycle refuses to attribute a lost lease to a phase, so
 *    `stoppedPhase` is null and there is nothing to say. A `complete` run is
 *    here too, because a deterministic phase that yielded its share is recorded
 *    `prefix_yielded` with the stop still `complete`.
 *
 * **`stoppedPhase` can name a DETERMINISTIC phase**, and routinely does:
 * `cluster` does not converge at this corpus size. All six phases here are then
 * `not_reached`, correctly — and the renderer must not print that name, because
 * telling an owner they are behind on work that produces nothing they can see is
 * worse than silence.
 *
 * `finishedAt` is deliberately not part of the judgement: rows that banked a
 * reason and stayed open predate rung 23 and are still in production databases.
 * The reason decides, not the clock.
 */
export type PhaseStanding = 'not_reached' | 'stopped_here' | 'failed_here' | 'unknown';

export interface PhaseProgress {
  readonly phase: ProcessingPhase;
  /** Rows this phase's own selector would take next, whole-brain and unclamped. */
  readonly waiting: number;
  readonly standing: PhaseStanding;
}

export interface ProcessingCycle {
  /** The RUN's plan, never the reader's. Decides {@link ProcessingCycle.phasesPlanned} and nothing else. */
  readonly tier: 'free' | 'paid';
  readonly dreamt: boolean;
  readonly stopReason: CycleStopReason | null;
  readonly stoppedPhase: CyclePhaseName | null;
  readonly stoppedPhaseCode: CyclePhaseStop | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  /**
   * Phases recorded `ran`. A phase that ran *and failed* counts; `free_tier`,
   * `checkpointed`, `not_reached` and `prefix_yielded` skips do not. Rendered
   * only under a completion, and never as a bare shortfall.
   */
  readonly phasesRun: number;
  /** `CYCLE_PHASE_NAMES.length`, less the model half on a free run. Never a literal. */
  readonly phasesPlanned: number;
  readonly modelCalls: number;
  /**
   * What the run **banked**, in micro-USD.
   *
   * Not the account's bill, and not `/api/spend`'s number either: that reads
   * `control.tenant.spend_micro_usd`, a rolling 30-day control-plane window
   * accrued from all model use. Two figures with different denominators on one
   * page is the class of mistake that agrees just often enough to hide itself,
   * so the two never appear together and this one is labelled on the page.
   *
   * Its diagnostic value comes from a sharp edge: every whole-batch phase
   * returns no spend on a refused call, while the gateway has already settled
   * the reservation and metered it. **A truncated call is charged to the account
   * and recorded here as zero** — so calls-made against spend-banked is the
   * signature of a step whose answers cannot be used.
   */
  readonly spentMicroUsd: number;
}

export interface ProcessingView {
  /** Newest live ingested page's `created_at` — the clock the rest is read against. */
  readonly lastArrivedAt: string | null;
  readonly latestCycle: ProcessingCycle | null;
  /** From `cycleFreshnessOf`, never re-derived. Decides emphasis, not wording. */
  readonly cycleFreshness: CycleFreshness;
  /** `null` — not `[]` — on the free tier: absent rather than empty. */
  readonly phases: readonly PhaseProgress[] | null;
  /** Of the documents `synopsis` is still waiting on, how many have come back unusable. */
  readonly refusedWaiting: number | null;
  /** The most any single one of those has been sent. A count, never a threshold. */
  readonly mostRefusals: number | null;
  /** The READER's plan, so the renderer never mistakes the run's tier for theirs. */
  readonly modelTier: 'free' | 'paid';
}

/** Bun's SQL returns `timestamptz` as a `Date`; a `text` cast would return a string. */
function isoOf(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Whether `phase` comes strictly after `stopped` in the cycle's fixed order. */
function comesAfter(phase: ProcessingPhase, stopped: CyclePhaseName): boolean {
  return CYCLE_PHASE_NAMES.indexOf(phase) > CYCLE_PHASE_NAMES.indexOf(stopped);
}

/** The trichotomy argued on {@link PhaseStanding}, in one place so it cannot drift. */
export function standingOf(
  phase: ProcessingPhase,
  cycle: Pick<ProcessingCycle, 'stopReason' | 'stoppedPhase'> | null,
): PhaseStanding {
  if (cycle === null || cycle.stoppedPhase === null) return 'unknown';
  const here = cycle.stoppedPhase === phase;
  if (cycle.stopReason === 'phase_failed') return here ? 'failed_here' : 'unknown';
  if (cycle.stopReason === 'out_of_time' || cycle.stopReason === 'budget_exhausted') {
    if (here) return 'stopped_here';
    return comesAfter(phase, cycle.stoppedPhase) ? 'not_reached' : 'unknown';
  }
  return 'unknown';
}

/**
 * The whole view, in two statements plus two more on a paid brain.
 *
 * **One connection, one clock**, for `readCoverage`'s reason: a page rendered
 * from one process's clock and judged against another's is a contradiction
 * nobody looking at it can see.
 *
 * The two conditional statements are the six counters. A free brain is not asked
 * for them at all — the model phases are that plan's *shape*, not its backlog,
 * and six zeroes under a heading would read as a fault report for every free
 * user.
 */
export async function readProcessing(
  sql: SQL,
  options: { readonly now: Date; readonly modelTier: 'free' | 'paid' },
): Promise<ProcessingView> {
  // The most recent run, open or finished. `run_id DESC` rather than
  // `finished_at DESC` for `readCoverage`'s reason: an open run has no
  // `finished_at` to order by and is exactly the row a reader needs.
  //
  // `spent_micro_usd` is cast to text because it is a `bigint` and Bun hands
  // those back as strings; `Number()` one line down is the pattern
  // `checkpoint.ts` already uses on the same column.
  const cycleRows = (await sql.unsafe(
    `SELECT tier, dreamt, stop_reason, stopped_phase, stopped_phase_code,
            started_at, finished_at, phases_run, model_calls,
            spent_micro_usd::text AS spent_micro_usd
       FROM consolidation_run
      ORDER BY run_id DESC
      LIMIT 1`,
    [],
  )) as Array<{
    tier: 'free' | 'paid';
    dreamt: boolean;
    stop_reason: CycleStopReason | null;
    stopped_phase: CyclePhaseName | null;
    stopped_phase_code: CyclePhaseStop | null;
    started_at: Date | string;
    finished_at: Date | string | null;
    phases_run: number;
    model_calls: number;
    spent_micro_usd: string;
  }>;
  const cycleRow = cycleRows[0];
  const latestCycle: ProcessingCycle | null =
    cycleRow === undefined
      ? null
      : {
          tier: cycleRow.tier,
          dreamt: cycleRow.dreamt,
          stopReason: cycleRow.stop_reason,
          stoppedPhase: cycleRow.stopped_phase,
          stoppedPhaseCode: cycleRow.stopped_phase_code,
          startedAt: isoOf(cycleRow.started_at) ?? '',
          finishedAt: isoOf(cycleRow.finished_at),
          phasesRun: cycleRow.phases_run,
          // Never the literals 6 and 12, and never by importing `phases.ts` into
          // a page render: the free tier's plan IS the deterministic half.
          phasesPlanned:
            CYCLE_PHASE_NAMES.length -
            (cycleRow.tier === 'free' ? PROCESSING_PHASES.length : 0),
          modelCalls: cycleRow.model_calls,
          spentMicroUsd: Number(cycleRow.spent_micro_usd),
        };

  // The three anchors in one round trip. The completion predicate is
  // `readCoverage`'s verbatim, `OR dreamt` arm included for the legacy rows the
  // schema still permits — never `finished_at` alone, which since rung 23 is a
  // RETURN clock and would read a permanently frozen brain as freshly complete.
  const anchorRows = (await sql.unsafe(
    `SELECT
       (SELECT finished_at FROM consolidation_run
         WHERE finished_at IS NOT NULL
           AND (stop_reason IN ('complete', 'free_tier') OR dreamt)
         ORDER BY finished_at DESC, run_id DESC LIMIT 1) AS last_completed_at,
       (SELECT min(started_at) FROM consolidation_run) AS cycling_since,
       (SELECT max(created_at) FROM page
         WHERE derivation = 'ingested' AND deleted_at IS NULL
           AND quarantined_at IS NULL AND stale_at IS NULL) AS last_arrived_at`,
    [],
  )) as Array<{
    last_completed_at: Date | string | null;
    cycling_since: Date | string | null;
    last_arrived_at: Date | string | null;
  }>;
  const anchors = anchorRows[0] ?? {
    last_completed_at: null,
    cycling_since: null,
    last_arrived_at: null,
  };
  const lastCompletedAt = isoOf(anchors.last_completed_at);

  const cycleFreshness = cycleFreshnessOf({
    completion:
      latestCycle === null
        ? undefined
        : {
            lastCompleteCycleAt: lastCompletedAt === null ? null : new Date(lastCompletedAt),
            latestStopReason: latestCycle.stopReason,
          },
    cyclingSince:
      anchors.cycling_since === null ? null : new Date(isoOf(anchors.cycling_since) ?? 0),
    now: options.now,
  }).state;

  if (options.modelTier === 'free') {
    return {
      lastArrivedAt: isoOf(anchors.last_arrived_at),
      latestCycle,
      cycleFreshness,
      phases: null,
      refusedWaiting: null,
      mostRefusals: null,
      modelTier: 'free',
    };
  }

  // The four row-keyed counters. Every predicate mirrors the phase's own
  // selector, and every consideration test is spelled `IS NULL OR col < $n`
  // rather than a bare `IS NULL`: on the day a version is bumped, a bare-`IS
  // NULL` page reports a converged brain while the phase re-pays for the corpus.
  const rowCountRows = (await sql.unsafe(
    `SELECT
       (SELECT count(*) FROM attachment
         WHERE ocr_text IS NULL AND deleted_at IS NULL AND quarantined_at IS NULL
       )::int AS transcribe_waiting,

       (SELECT count(*)
          FROM chunk c JOIN page p ON p.page_id = c.page_id
         WHERE c.deleted_at IS NULL AND c.quarantined_at IS NULL
           AND p.deleted_at IS NULL AND p.quarantined_at IS NULL AND p.stale_at IS NULL
           AND p.derivation = 'ingested'
           AND (c.extract_considered_version IS NULL OR c.extract_considered_version < $1)
       )::int AS extract_waiting,

       (SELECT count(*) FROM entity
         WHERE deleted_at IS NULL
           AND (enrich_considered_version IS NULL OR enrich_considered_version < $2)
       )::int AS enrich_waiting,

       (SELECT count(*) FROM fact
         WHERE deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL
           AND (contradiction_considered_version IS NULL OR contradiction_considered_version < $3)
       )::int AS contradiction_waiting`,
    [
      CONSIDERATION_VERSION.extract,
      CONSIDERATION_VERSION.enrich,
      CONSIDERATION_VERSION.contradiction,
    ],
  )) as Array<{
    transcribe_waiting: number;
    extract_waiting: number;
    enrich_waiting: number;
    contradiction_waiting: number;
  }>;
  const rowCounts = rowCountRows[0] ?? {
    transcribe_waiting: 0,
    extract_waiting: 0,
    enrich_waiting: 0,
    contradiction_waiting: 0,
  };

  // One pass over the page candidate set, four numbers out of it.
  //
  // The `EXISTS` over `chunk` is load-bearing rather than defensive:
  // `selectIngestedPages` joins `chunk` and groups, so a page with no live chunk
  // is never a candidate, and counting it would make the meter unreachable.
  // `EXISTS` short-circuits on the first live chunk instead of materialising a
  // row per chunk.
  //
  // The summary probe is `NOT EXISTS` rather than a count because
  // `page_by_external_ref` is not unique and duplicate summaries stand in
  // production databases with nothing retiring them.
  //
  // `refused_waiting` is filtered to the pages `synopsis` is still waiting on,
  // and that is the whole reason it is in this pass rather than its own: the
  // copy invites the reader to compare the two numbers, and a refusal count over
  // a different row set than the waiting count would make that comparison a lie.
  const pageRows = (await sql.unsafe(
    `SELECT
       count(*) FILTER (WHERE NOT cand.summarised)::int                       AS synopsis_waiting,
       count(*) FILTER (WHERE cand.unrefined)::int                            AS salience_refine_waiting,
       count(*) FILTER (WHERE NOT cand.summarised AND cand.refusals > 0)::int AS refused_waiting,
       coalesce(max(cand.refusals) FILTER (WHERE NOT cand.summarised), 0)::int AS most_refusals
       FROM (
         SELECT
           p.consolidation_refusals AS refusals,
           (p.salience_refine_considered_version IS NULL
            OR p.salience_refine_considered_version < $1) AS unrefined,
           EXISTS (SELECT 1 FROM page s
                    WHERE s.external_ref = $2 || p.page_id::text
                      AND s.deleted_at IS NULL) AS summarised
           FROM page p
          WHERE p.deleted_at IS NULL AND p.quarantined_at IS NULL AND p.stale_at IS NULL
            AND p.derivation = 'ingested'
            AND EXISTS (SELECT 1 FROM chunk c
                         WHERE c.page_id = p.page_id
                           AND c.deleted_at IS NULL AND c.quarantined_at IS NULL)
       ) AS cand`,
    [CONSIDERATION_VERSION.salience_refine, SUMMARY_REF_PREFIX],
  )) as Array<{
    synopsis_waiting: number;
    salience_refine_waiting: number;
    refused_waiting: number;
    most_refusals: number;
  }>;
  const pageCounts = pageRows[0] ?? {
    synopsis_waiting: 0,
    salience_refine_waiting: 0,
    refused_waiting: 0,
    most_refusals: 0,
  };

  const waiting: Readonly<Record<ProcessingPhase, number>> = {
    transcribe: rowCounts.transcribe_waiting,
    extract: rowCounts.extract_waiting,
    enrich: rowCounts.enrich_waiting,
    synopsis: pageCounts.synopsis_waiting,
    contradiction: rowCounts.contradiction_waiting,
    salience_refine: pageCounts.salience_refine_waiting,
  };

  return {
    lastArrivedAt: isoOf(anchors.last_arrived_at),
    latestCycle,
    cycleFreshness,
    phases: PROCESSING_PHASES.map((phase) => ({
      phase,
      waiting: waiting[phase],
      standing: standingOf(phase, latestCycle),
    })),
    refusedWaiting: pageCounts.refused_waiting,
    mostRefusals: pageCounts.most_refusals,
    modelTier: 'paid',
  };
}
