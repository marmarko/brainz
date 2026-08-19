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
 * **2b. Its subject is money, and only money.** A row here means "this phase is
 * paid for", and only the model tier reads one. The deterministic tier is not
 * checkpointed across attempts and re-runs from the top every time, which is
 * affordable because the round-trip costs that made it unaffordable are gone —
 * see the note on the phase loop in `cycle.ts`. A resumable position for the
 * free tier was built once and removed: it bought nothing the batching had not
 * already bought, and every version of it carried a state a run could enter and
 * not leave.
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
import type { CyclePhase, PhaseAttribution, PhaseStop } from './phases.ts';

export type ConsolidationTier = 'free' | 'paid';

export type StopReason =
  | 'complete'
  | 'free_tier'
  | 'budget_exhausted'
  | 'phase_failed'
  | 'cancelled'
  /**
   * The attempt's wall clock ran out with work left.
   *
   * Not a failure and not a cap. The cycle *decided* to stop between two units
   * of work rather than being reaped inside one, so its writes are whole, its
   * run record says what happened, and the phases it completed are banked. The
   * run stays open and the next cycle resumes into it, skipping the model phases
   * that are already paid for — the same treatment `budget_exhausted` and
   * `phase_failed` have always had, for the same reason. See `deadline.ts`.
   */
  | 'out_of_time';

export interface CycleRun {
  readonly runId: string;
  readonly trigger: JobTrigger;
  readonly tier: ConsolidationTier;
  readonly startedAt: Date;
}

export interface OpenedRun {
  readonly run: CycleRun;
  /** True when this call adopted a cycle a previous process left open. */
  readonly resumed: boolean;
  /**
   * Phases already banked against this run. Skipped rather than re-paid — and
   * only the *model* ones are, because only a model phase's cost is a thing that
   * cannot be paid twice. See the header's point 2b.
   */
  readonly done: ReadonlySet<CyclePhase>;
  /** What the resumed phases already spent, so the run's total stays a total. */
  readonly spentMicroUsd: number;
}

interface RunRow {
  readonly run_id: string;
  readonly trigger_reason: JobTrigger;
  readonly tier: ConsolidationTier;
  readonly started_at: Date;
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
    SELECT run_id::text AS run_id, trigger_reason, tier, started_at
      FROM consolidation_run
     WHERE finished_at IS NULL
     ORDER BY run_id DESC
     LIMIT 1
  `) as RunRow[];

  const existing = open[0];
  if (existing !== undefined) {
    const banked = (await sql`
      SELECT phase, spent_micro_usd::bigint AS spent
        FROM consolidation_checkpoint
       WHERE run_id = ${existing.run_id}::bigint
    `) as Array<{ phase: string; spent: string }>;

    return {
      run: {
        runId: existing.run_id,
        trigger: existing.trigger_reason,
        tier: existing.tier,
        startedAt: existing.started_at,
      },
      resumed: true,
      done: new Set(banked.map((row) => row.phase as CyclePhase)),
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
    RETURNING run_id::text AS run_id, trigger_reason, tier, started_at
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
    done: new Set<CyclePhase>(),
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
    INSERT INTO consolidation_checkpoint (phase, run_id, items, spent_micro_usd, completed_at)
    VALUES (${phase}, ${run.runId}::bigint, ${outcome.items}, ${outcome.spentMicroUsd}, ${outcome.now})
    ON CONFLICT (phase) DO UPDATE
      SET run_id = EXCLUDED.run_id,
          items = EXCLUDED.items,
          spent_micro_usd = EXCLUDED.spent_micro_usd,
          completed_at = EXCLUDED.completed_at
  `;
}

export interface FinishRequest {
  readonly dreamt: boolean;
  readonly stopReason: StopReason;
  readonly spentMicroUsd: number;
  readonly modelCalls: number;
  readonly phasesRun: number;
  readonly wallClockMs: number;
  /**
   * Which phase stopped this cycle and with what code, or `null` when no phase
   * is answerable for the stop.
   *
   * **Required rather than optional, because the field's job is to be
   * overwritten.** A run stays open across attempts and both writers rewrite the
   * same row, so a writer that only set these columns when it had something to
   * say would leave a later attempt's success sitting under an earlier
   * attempt's failure — a row naming a phase that stopped nothing, which is
   * worse than the aggregate `stop_reason` it was added to improve on. `null`
   * is a value here, not an absence.
   */
  readonly stoppedPhase: PhaseAttribution | null;
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
           -- Written even though a completed cycle never has one. The run being
           -- closed may be a run an earlier attempt attributed a failure to, and
           -- a completed row still naming the phase that once stopped it is a
           -- row that lies to the next reader.
           stopped_phase = ${request.stoppedPhase?.phase ?? null},
           stopped_phase_code = ${request.stoppedPhase?.code ?? null},
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
           wall_clock_ms = ${request.wallClockMs},
           -- The reason this row is worth reading. The stop reason says a phase
           -- failed; these two say WHICH phase and WHAT it reported, and without
           -- them an operator with no access to the tenant's database has "a
           -- phase failed" and nothing else — which is the state a brain with
           -- 5,608 pages and 167 facts was diagnosed from.
           stopped_phase = ${request.stoppedPhase?.phase ?? null},
           stopped_phase_code = ${request.stoppedPhase?.code ?? null}
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
  /**
   * Which phase stopped the cycle, or `null`. Read back rather than left on the
   * row for a hand-written SELECT: a column no reader surfaces is a column
   * shaped for nobody, and the whole point of persisting it is that somebody
   * without a psql session can see it.
   */
  readonly stoppedPhase: PhaseAttribution | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

/** The most recent run, for the `brain` surface and for operators. */
export async function readLatestRun(sql: SQL): Promise<RunRecord | undefined> {
  const rows = (await sql`
    SELECT run_id::text AS run_id, tier, dreamt, stop_reason,
           estimated_micro_usd::bigint AS estimated, spent_micro_usd::bigint AS spent,
           model_calls, phases_run, wall_clock_ms, stopped_phase, stopped_phase_code,
           started_at, finished_at
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
    stopped_phase: CyclePhase | null;
    stopped_phase_code: PhaseStop | null;
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
    // Reassembled only when both halves are there. The database's pairing CHECK
    // makes a half-set row impossible to write, so this is the reader agreeing
    // with the constraint rather than defending against it.
    stoppedPhase:
      row.stopped_phase === null || row.stopped_phase_code === null
        ? null
        : { phase: row.stopped_phase, code: row.stopped_phase_code },
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
