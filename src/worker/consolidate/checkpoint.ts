/**
 * Where a cycle got to, banked in the tenant's own database.
 *
 * KTD11: "checkpoints in the tenant DB so a killed cycle never re-pays model
 * calls." Three decisions follow from that sentence and each one is the
 * difference between a checkpoint and a log line.
 *
 * **1. The checkpoint lives with the work, not with the scheduler.** A phase's
 * output is rows in this database; a record that it completed has to commit
 * against the same database or the two can disagree — a control-plane row
 * claiming `extract` is done over a tenant that rolled it back is a phase
 * silently skipped forever.
 *
 * **2. A checkpoint belongs to a run.** Keyed on the phase, because "where is
 * this brain up to" has one answer per phase — but carrying `run_id`, because a
 * checkpoint is only *resumable* while the run it belongs to is still open. A
 * checkpoint that outlived its cycle would skip the next cycle's work while
 * looking like thrift.
 *
 * **2b. Its subject is position, not only money.** KTD11's sentence is about
 * re-paying, and for a phase whose cost is a provider invoice a done-flag is the
 * whole answer. For a phase whose cost is *wall clock* it is not: the
 * deterministic tier re-ran in full on every attempt, committing its writes and
 * losing its place, so a brain large enough that the tier outlived one attempt
 * could never finish it — repeated identical work under a finite attempt
 * ceiling. Rung 19 adds `completed` and `phase_cursor`, and
 * {@link bankPhaseProgress} is how an interrupted phase says where it got to.
 *
 * **3. Resuming is the default, and it is decided by the database.** An open run
 * — one with no `finished_at` — is a cycle that was killed, and the next cycle
 * picks it up rather than starting a second one beside it. That is what makes
 * "the next cycle resumes without re-paying for completed phases" true of a
 * process that was killed rather than of one that was asked politely to stop.
 */

import type { SQL } from 'bun';

import type { JobTrigger } from '../jobs.ts';
import { NO_SPEND } from './estimate.ts';
import { isModelPhase, type CyclePhase } from './phases.ts';

export type ConsolidationTier = 'free' | 'paid';

export type StopReason =
  | 'complete'
  | 'free_tier'
  | 'budget_exhausted'
  | 'phase_failed'
  | 'cancelled'
  /**
   * The attempt's wall clock ran out with work left. Not a failure and not a
   * cap: the run stays open, a position is banked, and the correct response is
   * to run the same cycle again immediately rather than to wait for a provider
   * or for a spend window. See `deadline.ts`.
   */
  | 'out_of_time';

export interface CycleRun {
  readonly runId: string;
  readonly trigger: JobTrigger;
  readonly tier: ConsolidationTier;
  readonly startedAt: Date;
}

/**
 * One phase's banked state within the open run.
 *
 * `completed` is what tells a finished phase from an interrupted one now that
 * presence of the row no longer can — see rung 19. `cursor` is where inside the
 * phase the last attempt stopped, opaque to this module: only the phase that
 * wrote it knows how to read it, which is what keeps the checkpoint table from
 * growing a column per phase.
 */
export interface PhaseCheckpoint {
  readonly completed: boolean;
  readonly cursor: string | null;
  /** Items this phase has done **across the whole run**, not this attempt. */
  readonly items: number;
  readonly spentMicroUsd: number;
}

export interface OpenedRun {
  readonly run: CycleRun;
  /** True when this call adopted a cycle a previous process left open. */
  readonly resumed: boolean;
  /**
   * What each phase has banked against this run — completed phases and
   * interrupted ones alike. A completed model phase is skipped rather than
   * re-paid; an interrupted deterministic phase resumes from its cursor rather
   * than restarting.
   */
  readonly banked: ReadonlyMap<CyclePhase, PhaseCheckpoint>;
  /**
   * Why the open run stopped last time, or `null` for a run nobody has stopped.
   *
   * The cycle reads it to decide whether the deterministic tier's checkpoints
   * still describe *now*. A run that stopped on the clock is being continued
   * seconds later and its free work is still current; a run that stopped because
   * a provider was unavailable may be resumed hours later over a brain that has
   * ingested since, and its free work is not.
   */
  readonly previousStop: StopReason | null;
  /** What the resumed phases already spent, so the run's total stays a total. */
  readonly spentMicroUsd: number;
}

interface RunRow {
  readonly run_id: string;
  readonly trigger_reason: JobTrigger;
  readonly tier: ConsolidationTier;
  readonly started_at: Date;
  readonly stop_reason: StopReason | null;
}

/**
 * Adopt the open cycle, or start one.
 *
 * The estimate is written **here**, before any phase runs. "Estimate before run"
 * is only a discipline if the number outlives the decision it informed; an
 * estimate computed and then discarded is a calculation nobody can audit against
 * the bill.
 */
export async function openRun(
  sql: SQL,
  options: {
    readonly trigger: JobTrigger;
    readonly tier: ConsolidationTier;
    readonly now: Date;
    readonly estimateMicroUsd: number;
  },
): Promise<OpenedRun> {
  const open = (await sql`
    SELECT run_id::text AS run_id, trigger_reason, tier, started_at, stop_reason
      FROM consolidation_run
     WHERE finished_at IS NULL
     ORDER BY run_id DESC
     LIMIT 1
  `) as RunRow[];

  const existing = open[0];
  if (existing !== undefined) {
    const banked = (await sql`
      SELECT phase, completed, phase_cursor, items,
             spent_micro_usd::bigint AS spent
        FROM consolidation_checkpoint
       WHERE run_id = ${existing.run_id}::bigint
    `) as Array<{
      phase: string;
      completed: boolean;
      phase_cursor: string | null;
      items: number;
      spent: string;
    }>;

    return {
      run: {
        runId: existing.run_id,
        trigger: existing.trigger_reason,
        tier: existing.tier,
        startedAt: existing.started_at,
      },
      resumed: true,
      previousStop: existing.stop_reason,
      banked: new Map(
        banked.map((row) => [
          row.phase as CyclePhase,
          {
            completed: row.completed,
            cursor: row.phase_cursor,
            items: row.items,
            spentMicroUsd: Number(row.spent),
          },
        ]),
      ),
      spentMicroUsd: banked.reduce((total, row) => total + Number(row.spent), 0),
    };
  }

  // Nothing to resume, so nothing banked is honourable. Cleared before the run
  // exists rather than after it finishes: a process killed between the two would
  // otherwise leave a completed cycle's checkpoints in front of the next one.
  await sql`DELETE FROM consolidation_checkpoint`;

  const created = (await sql`
    INSERT INTO consolidation_run (trigger_reason, tier, estimated_micro_usd, started_at)
    VALUES (${options.trigger}, ${options.tier}, ${options.estimateMicroUsd}, ${options.now})
    RETURNING run_id::text AS run_id, trigger_reason, tier, started_at, stop_reason
  `) as RunRow[];

  const row = created[0];
  if (row === undefined) throw new Error('could not open a consolidation run');

  return {
    run: {
      runId: row.run_id,
      trigger: row.trigger_reason,
      tier: row.tier,
      startedAt: row.started_at,
    },
    resumed: false,
    previousStop: null,
    banked: new Map<CyclePhase, PhaseCheckpoint>(),
    spentMicroUsd: NO_SPEND,
  };
}

/**
 * Bank one phase.
 *
 * An upsert rather than an insert, because a resumed run re-banks a phase it
 * completed *this* time round after a previous attempt banked something else for
 * the same phase — and because the primary key is the phase, which is what makes
 * "where is this brain up to" answerable with one row.
 */
export async function completePhase(
  sql: SQL,
  run: CycleRun,
  phase: CyclePhase,
  outcome: { readonly items: number; readonly spentMicroUsd: number; readonly now: Date },
): Promise<void> {
  await sql`
    INSERT INTO consolidation_checkpoint (phase, run_id, items, spent_micro_usd, completed_at,
                                          completed, phase_cursor)
    VALUES (${phase}, ${run.runId}::bigint, ${outcome.items}, ${outcome.spentMicroUsd}, ${outcome.now},
            true, NULL)
    ON CONFLICT (phase) DO UPDATE
      SET run_id = EXCLUDED.run_id,
          items = EXCLUDED.items,
          spent_micro_usd = EXCLUDED.spent_micro_usd,
          completed_at = EXCLUDED.completed_at,
          completed = true,
          -- Cleared, not left: a completed phase with a stale position would
          -- send the next attempt into the middle of work that is already done.
          phase_cursor = NULL
  `;
}

/**
 * Bank a phase **mid-flight**, so the next attempt resumes instead of restarting.
 *
 * The counterpart to {@link completePhase} and the reason rung 19 exists. A
 * deterministic phase that ran out of the attempt's wall clock has done real,
 * committed work and has no way to say so: presence of a checkpoint row used to
 * mean "finished", so the only honest thing such a phase could do was write
 * nothing — and the next attempt then walked the same rows in the same order and
 * was reaped at the same place. Five attempts, no progress, dead lane.
 *
 * **Deterministic phases only, and it throws rather than warns.** The previous
 * fleet version reads every checkpoint row as a completion and skips model
 * phases on that basis, so a partial row for a model phase would make a
 * mid-rolling-deploy instance skip a phase that had barely started. It ignores
 * deterministic rows entirely, which is exactly what makes a partial one safe
 * there. The rule is structural because the failure is silent and only happens
 * during a deploy — the worst place to discover a convention.
 */
export async function bankPhaseProgress(
  sql: SQL,
  run: CycleRun,
  phase: CyclePhase,
  progress: { readonly items: number; readonly cursor: string; readonly now: Date },
): Promise<void> {
  if (isModelPhase(phase)) {
    throw new Error(
      `invariant: '${phase}' is a model phase and cannot bank a partial checkpoint — the previous fleet version reads any checkpoint row as a completion and would skip the phase mid-deploy`,
    );
  }
  await sql`
    INSERT INTO consolidation_checkpoint (phase, run_id, items, spent_micro_usd, completed_at,
                                          completed, phase_cursor)
    VALUES (${phase}, ${run.runId}::bigint, ${progress.items}, ${NO_SPEND}, ${progress.now},
            false, ${progress.cursor})
    ON CONFLICT (phase) DO UPDATE
      SET run_id = EXCLUDED.run_id,
          items = EXCLUDED.items,
          completed_at = EXCLUDED.completed_at,
          completed = false,
          phase_cursor = EXCLUDED.phase_cursor
  `;
}

/**
 * Whether the phase is banked as **finished** against this run.
 *
 * Asked rather than remembered, and that is the point. A phase that triggers
 * another phase's work — staleness re-running reconciliation over the fact set
 * it just changed — used to decide on a per-*call* local, which is a correct
 * answer only for a cycle that runs each phase exactly once. Under a resumable
 * walk the attempt that creates the debt and the attempt that discharges it are
 * different processes, and the only thing both can see is this table.
 */
export async function phaseIsComplete(sql: SQL, run: CycleRun, phase: CyclePhase): Promise<boolean> {
  const rows = (await sql`
    SELECT completed
      FROM consolidation_checkpoint
     WHERE phase = ${phase} AND run_id = ${run.runId}::bigint
  `) as Array<{ completed: boolean }>;
  return rows[0]?.completed === true;
}

/**
 * Withdraw a phase's completion, because a later phase invalidated its inputs.
 *
 * **A DELETE, not an update to `completed = false`.** Rung 19's CHECK requires an
 * incomplete row to carry a position, and a whole-set phase has none to carry —
 * the only position it could offer is "from the beginning", which is what the
 * absence of a row already says. Writing a placeholder cursor would be inventing
 * a resume point for a phase that cannot resume.
 *
 * **Deterministic phases only.** Re-opening a model phase would re-pay for it,
 * which is the one thing KTD11's checkpoint exists to prevent — and the caller
 * that wanted to would be expressing a dependency the cycle's cheap→expensive
 * order says cannot exist. Structural rather than documented, for the same
 * reason {@link bankPhaseProgress} refuses the mirror case.
 */
export async function reopenPhase(sql: SQL, run: CycleRun, phase: CyclePhase): Promise<void> {
  if (isModelPhase(phase)) {
    throw new Error(
      `invariant: '${phase}' is a model phase and cannot be re-opened — a phase whose cost is a provider invoice is checkpointed so it is never paid for twice`,
    );
  }
  await sql`
    DELETE FROM consolidation_checkpoint
     WHERE phase = ${phase} AND run_id = ${run.runId}::bigint
  `;
}

export interface FinishRequest {
  readonly dreamt: boolean;
  readonly stopReason: StopReason;
  readonly spentMicroUsd: number;
  readonly modelCalls: number;
  readonly phasesRun: number;
  readonly wallClockMs: number;
  readonly now: Date;
}

/**
 * Close the run.
 *
 * Only called when the cycle reached a state it is willing to stand behind. A
 * cycle that died with the process leaves `finished_at` null on purpose — that
 * null is the resume signal, and writing a finished row on the way out of a
 * failure would be the cycle forgiving itself.
 */
export async function finishRun(sql: SQL, run: CycleRun, request: FinishRequest): Promise<void> {
  await sql`
    UPDATE consolidation_run
       SET dreamt = ${request.dreamt},
           stop_reason = ${request.stopReason},
           spent_micro_usd = ${request.spentMicroUsd},
           model_calls = ${request.modelCalls},
           phases_run = ${request.phasesRun},
           wall_clock_ms = ${request.wallClockMs},
           finished_at = ${request.now}
     WHERE run_id = ${run.runId}::bigint
  `;
  // A finished cycle has nothing to resume into. Left behind, these rows would
  // be indistinguishable from a killed run's and would skip the next cycle's
  // phases.
  await sql`DELETE FROM consolidation_checkpoint WHERE run_id = ${run.runId}::bigint`;
}

/**
 * Bank what a cycle did **without closing it**.
 *
 * The counterpart to {@link finishRun}, and the difference is one column: a run
 * that stopped on an exhausted cap or an unavailable provider keeps its null
 * `finished_at`, because that null is what the next cycle resumes into. Writing
 * the reason and the spend anyway is what keeps an operator from having to infer
 * "it stopped" from "it never finished".
 */
export async function recordProgress(sql: SQL, run: CycleRun, request: FinishRequest): Promise<void> {
  await sql`
    UPDATE consolidation_run
       SET dreamt = ${request.dreamt},
           stop_reason = ${request.stopReason},
           spent_micro_usd = ${request.spentMicroUsd},
           model_calls = ${request.modelCalls},
           phases_run = ${request.phasesRun},
           wall_clock_ms = ${request.wallClockMs}
     WHERE run_id = ${run.runId}::bigint
  `;
}

export interface RunRecord {
  readonly runId: string;
  readonly tier: ConsolidationTier;
  readonly dreamt: boolean;
  readonly stopReason: StopReason | null;
  readonly estimatedMicroUsd: number;
  readonly spentMicroUsd: number;
  readonly modelCalls: number;
  readonly phasesRun: number;
  readonly wallClockMs: number | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

/** The most recent run, for the `brain` surface and for operators. */
export async function readLatestRun(sql: SQL): Promise<RunRecord | undefined> {
  const rows = (await sql`
    SELECT run_id::text AS run_id, tier, dreamt, stop_reason,
           estimated_micro_usd::bigint AS estimated, spent_micro_usd::bigint AS spent,
           model_calls, phases_run, wall_clock_ms, started_at, finished_at
      FROM consolidation_run
     ORDER BY run_id DESC
     LIMIT 1
  `) as Array<{
    run_id: string;
    tier: ConsolidationTier;
    dreamt: boolean;
    stop_reason: StopReason | null;
    estimated: string;
    spent: string;
    model_calls: number;
    phases_run: number;
    wall_clock_ms: number | null;
    started_at: Date;
    finished_at: Date | null;
  }>;

  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    runId: row.run_id,
    tier: row.tier,
    dreamt: row.dreamt,
    stopReason: row.stop_reason,
    estimatedMicroUsd: Number(row.estimated),
    spentMicroUsd: Number(row.spent),
    modelCalls: row.model_calls,
    phasesRun: row.phases_run,
    wallClockMs: row.wall_clock_ms,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Re-bank the estimate on the boundary between the tiers.
 *
 * The number written at {@link openRun} is taken before anything ran, which is
 * what makes it useful to an aborted cycle and useless as a cap: the
 * deterministic tier creates the rows the model tier is priced against. This
 * overwrites it with the refined figure, so the run record carries the estimate
 * the caps were actually built from rather than the one that preceded them.
 */
export async function bankEstimate(sql: SQL, runId: string, estimateMicroUsd: number): Promise<void> {
  await sql`
    UPDATE consolidation_run SET estimated_micro_usd = ${estimateMicroUsd}
     WHERE run_id = ${runId}::bigint
  `;
}
