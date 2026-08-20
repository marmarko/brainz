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
 * **3. An open run means a cycle that was KILLED, and nothing else.** That
 * sentence used to be aspirational and is now enforced, and the difference is
 * the incident this module's shape is owed to.
 *
 * `finished_at IS NULL` was carrying two meanings at once. One was KTD11's: a
 * process died mid-cycle and never got to write anything, so the next cycle
 * picks its run up rather than starting a second one beside it. The other was a
 * cycle that *returned* — a cap that fired, a provider that was down, a clock
 * that ran out — deliberately leaving its run open so the next cycle would skip
 * the phases it had paid for. The second meaning is what froze a brain: one page
 * drawing a provider 500 stopped the synopsis phase, which stopped the cycle,
 * which left the run open, which left `extract`'s checkpoint standing in front
 * of every later cycle. 5,608 pages behind 167 facts, and `extract` called once
 * in the whole of it.
 *
 * So the second meaning is gone. **A cycle that returns closes its run** —
 * {@link finishRun} on every exit, whatever stopped it — because it reached a
 * state it can describe and its pass is over. The next cycle is a new pass, and
 * it costs what a new pass costs: nothing extra, since a completed cycle's
 * checkpoints are deleted here too.
 *
 * **That last sentence is what this change cost when it was tried without rung
 * 22, and it is why the rung has to come first.** Four of the six model phases
 * had no record of doneness anywhere, so "a new pass costs nothing extra" was
 * false for them: closing the run re-paid `extract` on every cycle and left
 * `enrich`, `synopsis`, `contradiction` and `salience_refine` unreached
 * entirely. Measured, and reverted. Rung 22 gave those four a consideration
 * stamp on the row they consume, which is the same kind of durability
 * `transcribe` and `synopsis` always had — and with it, closing the run costs
 * exactly nothing, which is what makes the sentence above true rather than
 * hopeful. See `consideration.ts`.
 *
 * **4. Adoption happens at most once per run**, stamped in {@link openRun} by
 * `resumed_at` (rung 23). A worker that dies at the same phase every time never
 * returns, so its run never closes, and an unbounded adoption chain would skip
 * the banked phase forever — the same freeze reached through a different door.
 * One free ride per killed cycle; after that the run is debris, it is closed,
 * and the phase is paid for again. That is what makes forward progress a
 * property rather than a hope.
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
   * of work rather than being reaped inside one, so its writes are whole and its
   * run record says what happened — which is the whole of what this reason buys,
   * and it is worth more than it sounds: a reaped attempt charges the lease
   * ladder and five of them dead-lettered a lane. See `deadline.ts`.
   *
   * It closes its run like every other reason a cycle can report. It used to
   * leave one open so the next cycle would skip the phases already paid for,
   * and what that bought is now bought by the phases themselves: the two whose
   * work a whole-phase checkpoint could never have banked anyway — `transcribe`
   * and `synopsis`, both of which call the model once per item — re-select only
   * items nobody has done yet.
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
 * The reason written onto a run whose cycle never reported one.
 *
 * Reused rather than invented. `cancelled` already means "this cycle was
 * interrupted rather than finished", which is precisely what a run left open by
 * a dead process is, and it is already in the rung-3 CHECK and in every reader's
 * vocabulary — a new member would need widening in the database and a matching
 * edit in surfaces this module has no business reaching into.
 */
const NEVER_REPORTED: StopReason = 'cancelled';

/**
 * Close every open run except the one this cycle is keeping.
 *
 * Debris, by construction: a cycle that returns closes its own run, and a killed
 * cycle's run is adoptable exactly once — so anything still open here is either
 * a ride already spent or the residue of a fleet version that left runs open on
 * purpose. Left alone it is a row that says a cycle is still running, forever,
 * to every operator and every surface that reads one.
 *
 * `coalesce` rather than an overwrite: the production row this rung was written
 * for carries `phase_failed` and the phase that reported it, and that is the
 * diagnosis. Closing a run is not the place to erase why it stopped.
 */
async function closeOpenRunsExcept(sql: SQL, keep: string | null, now: Date): Promise<void> {
  if (keep === null) {
    await sql`
      UPDATE consolidation_run
         SET finished_at = ${now}, stop_reason = coalesce(stop_reason, ${NEVER_REPORTED})
       WHERE finished_at IS NULL
    `;
    return;
  }
  await sql`
    UPDATE consolidation_run
       SET finished_at = ${now}, stop_reason = coalesce(stop_reason, ${NEVER_REPORTED})
     WHERE finished_at IS NULL AND run_id <> ${keep}::bigint
  `;
}

/**
 * Adopt the run a killed cycle left behind, or start one.
 *
 * **Only a killed cycle leaves one.** A cycle that returns closes its run in
 * {@link finishRun}, so an open run is one nothing ever reported on — which is
 * the case KTD11's sentence is about, and the only case where skipping a banked
 * model phase is thrift rather than a freeze.
 *
 * **And it is adopted at most once.** The stamp is a conditional UPDATE rather
 * than a read followed by a write, so a cycle killed during its own adoption has
 * still spent the ride and two workers racing the same run cannot both win it.
 * Without that bound a worker dying at the same phase every time would skip the
 * phase it banked forever — the incident, reached through a different door.
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
     WHERE finished_at IS NULL AND resumed_at IS NULL
     ORDER BY run_id DESC
     LIMIT 1
  `) as RunRow[];

  const existing = open[0];
  if (existing !== undefined) {
    const claimed = (await sql`
      UPDATE consolidation_run
         SET resumed_at = ${options.now}
       WHERE run_id = ${existing.run_id}::bigint AND resumed_at IS NULL
      RETURNING run_id::text AS run_id
    `) as Array<{ run_id: string }>;

    // Lost the race, so somebody else is resuming this run and this cycle is a
    // new pass. Falling through is the safe direction: it pays for a phase
    // rather than skipping one on a checkpoint it does not own.
    if (claimed.length > 0) {
      await closeOpenRunsExcept(sql, existing.run_id, options.now);
      // Only the adopted run's rows are honoured, and only they survive: a
      // checkpoint is keyed on the phase alone, so a debris run's row would
      // occupy the key its successor needs.
      await sql`DELETE FROM consolidation_checkpoint WHERE run_id <> ${existing.run_id}::bigint`;

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
  }

  // Nothing this cycle may resume into, so nothing open is a cycle in flight.
  await closeOpenRunsExcept(sql, null, options.now);

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
   * overwritten.** A cycle that adopted a killed cycle's run rewrites that run's
   * row, so a writer that only set these columns when it had something to say
   * would leave its own success sitting under the dead attempt's failure — a row
   * naming a phase that stopped nothing, which is worse than the aggregate
   * `stop_reason` it was added to improve on. `null` is a value here, not an
   * absence.
   */
  readonly stoppedPhase: PhaseAttribution | null;
  readonly now: Date;
}

/**
 * Close the run. **Every cycle that returns calls this, whatever stopped it.**
 *
 * There used to be a second exit — `recordProgress`, which wrote the same
 * columns and left `finished_at` alone — taken by the three stop reasons that
 * meant "there is work left": a cap that fired, a provider that was down, a
 * clock that ran out. The intent was thrift, and the argument was that the null
 * is the resume signal so the next cycle would not re-pay for the phases this
 * one completed.
 *
 * It was the mechanism of the incident. A provider 500 on ONE page out of 5,608
 * stopped the synopsis phase, which stopped the cycle, which took that second
 * exit, which left `extract`'s checkpoint standing in front of every later cycle
 * — permanently, because every later cycle stopped the same way. The brain sat
 * at 167 facts with extraction called once in the whole of it, and no state it
 * could reach on its own would have let it out.
 *
 * The thrift it bought was also smaller than it looked, and the per-phase
 * durability table is why. `transcribe` re-selects only attachments with a null
 * `ocr_text` and `synopsis` only unsummarised pages, so closing costs those two
 * nothing at all. The other four have no record of doneness anywhere — this
 * function has always deleted their checkpoints on `complete`, so they are
 * re-paid on every pass by design already. Closing a stopped run therefore costs
 * exactly what a successful cycle costs, and never more.
 *
 * A cycle that died *with the process* still leaves `finished_at` null, because
 * nothing ran to set it. That is the resume signal now: not a decision, an
 * absence. See {@link openRun}.
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
