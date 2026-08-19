/**
 * The job queue over the control-plane Postgres (U10 approach step 1).
 *
 * Three properties are worth stating before the code, because each is carried by
 * one statement and would be easy to lose in a refactor:
 *
 * **1. Every protective decision is made by a statement, never by the caller.**
 * Dedupe, quarantine and tenant-readiness are all `WHERE` clauses on the insert,
 * not reads the caller performs first. A caller that looks and then writes has
 * checked a value after the moment it protects: two schedulers during a rolling
 * deploy both look, both see nothing, and both insert.
 *
 * **2. Every write a worker makes is fenced on `lease_token`.** `claim`
 * increments it; `heartbeat`, `complete` and `fail` all carry it in their
 * `WHERE`. A worker whose lease was stolen is not asked to stop — the store
 * refuses it. This is the shape U2 got wrong first and paid for.
 *
 * **3. Nothing reads the database's clock.** Every statement takes `$now` as a
 * parameter. That is what makes the whole unit testable against a real Postgres
 * with an injected clock instead of against sleeps — and it removes a real
 * production hazard too, since `now()` on the control plane and `Date.now()` on
 * a worker are two clocks that can disagree about whether a lease has expired.
 */

import type { SQL } from 'bun';

import {
  backoffMs,
  DEFAULT_MAX_ATTEMPTS,
  isLegalTarget,
  JOB_KINDS,
  retryPolicyFor,
  type BackoffConfig,
  type ClaimRequest,
  type ClearDeadLetterOutcome,
  type ClearDeadLetterRequest,
  type CompleteRequest,
  type EnqueueOutcome,
  type EnqueueRequest,
  type FailRequest,
  type FencedOutcome,
  type JobFailureCode,
  type JobKind,
  type JobLease,
  type JobQueue,
  type JobRecord,
  type JobState,
  type JobTarget,
  type JobTrigger,
  type ReclaimRequest,
  type ReviveLaneOutcome,
  type ReviveLaneRequest,
} from './jobs.ts';
import {
  attemptDeadlineAt,
  attemptOverranBeforeLeaseLapsed,
  leaseExpiryAt,
  type ConnectionBound,
} from './locks.ts';

/**
 * Re-exported from where the policy now lives (`jobs.ts`), so the ladder length
 * and the ladder's shape are one record rather than a number here and a config
 * there. Kept exported under this name because it is the queue's own default and
 * callers know it as that.
 */
export { DEFAULT_MAX_ATTEMPTS };

/** How many wedged leases one reclaim sweep takes. */
export const DEFAULT_RECLAIM_LIMIT = 100;

interface JobRow {
  readonly job_id: string;
  readonly tenant_id: string;
  readonly kind: string;
  readonly target: string;
  readonly state: string;
  readonly trigger_reason: string;
  readonly attempts: number;
  readonly max_attempts: number;
  readonly debt_observed: number;
  readonly run_at: Date;
  readonly lease_token: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: Date | null;
  readonly heartbeat_at: Date | null;
  readonly attempt_deadline_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly finished_at: Date | null;
  readonly dead_lettered_at: Date | null;
  readonly failure_code: string | null;
}

function toJobRecord(row: JobRow): JobRecord {
  return {
    jobId: row.job_id,
    tenantId: row.tenant_id,
    kind: row.kind as JobKind,
    target: row.target as JobTarget,
    state: row.state as JobState,
    trigger: row.trigger_reason as JobTrigger,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    debtObserved: row.debt_observed,
    runAt: row.run_at,
    leaseToken: row.lease_token,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    heartbeatAt: row.heartbeat_at,
    attemptDeadlineAt: row.attempt_deadline_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    deadLetteredAt: row.dead_lettered_at,
    failureCode: row.failure_code as JobFailureCode | null,
  };
}

function rowsOf(result: unknown): JobRow[] {
  return result as JobRow[];
}

export interface JobQueueOptions {
  readonly sql: SQL;
  /** Injectable so a test can name the rows it asserts on. */
  readonly newJobId?: () => string;
  /**
   * Replaces the ladder for **every** kind. A test knob: production reads
   * `RETRY_POLICY` per kind, and a deployment-wide override would be exactly the
   * one-number policy that `RETRY_POLICY` exists to end.
   */
  readonly backoff?: BackoffConfig;
  /**
   * Pins the jitter without replacing the ladder, so a test can assert the
   * connector policy's own rungs as exact numbers. Wins over
   * `backoff.random` when both are given.
   */
  readonly random?: () => number;
}

export type PostgresJobQueue = JobQueue & ConnectionBound;

export function createJobQueue(options: JobQueueOptions): PostgresJobQueue {
  const { sql } = options;
  const newJobId = options.newJobId ?? (() => crypto.randomUUID());

  /**
   * The ladder this kind walks. Resolved per call rather than captured once,
   * because `fail` and `reclaim` see one kind at a time and a queue that closed
   * over a single config is the global policy wearing a record's clothes.
   */
  function backoffFor(kind: JobKind): BackoffConfig {
    const ladder: BackoffConfig = options.backoff ?? retryPolicyFor(kind).backoff;
    const random = options.random ?? ladder.random;
    return random === undefined ? ladder : { ...ladder, random };
  }

  /**
   * Why an insert that returned nothing returned nothing. Read *after* the
   * refusal, and only to name it: the refusal itself was the statement's, so
   * this cannot be the check-after-use shape even though it reads second.
   */
  async function explainRefusal(request: EnqueueRequest): Promise<EnqueueOutcome> {
    const rows = (await sql`
      SELECT
        (SELECT count(*)::int FROM control.job
          WHERE tenant_id = ${request.tenantId}
            AND kind = ${request.kind}::control.job_kind
            AND target = ${request.target}::control.job_target
            AND state = 'dead') AS dead,
        (SELECT count(*)::int FROM control.job
          WHERE tenant_id = ${request.tenantId}
            AND kind = ${request.kind}::control.job_kind
            AND target = ${request.target}::control.job_target
            AND state IN ('due', 'running')) AS open,
        (SELECT count(*)::int FROM control.tenant
          WHERE tenant_id = ${request.tenantId}
            AND state = 'ready') AS ready
    `) as unknown as { dead: number; open: number; ready: number }[];

    const counts = rows[0];
    if (counts === undefined || counts.ready === 0) {
      return { enqueued: false, reason: 'tenant_not_ready' };
    }
    if (counts.dead > 0) return { enqueued: false, reason: 'quarantined' };
    if (counts.open > 0) return { enqueued: false, reason: 'already_open' };
    // The row that refused us has already moved. Reported rather than guessed.
    return { enqueued: false, reason: 'raced' };
  }

  return {
    connection: sql,

    async enqueue(request: EnqueueRequest): Promise<EnqueueOutcome> {
      // The one thing checked in TypeScript, because the alternative is a
      // constraint violation raised on a live enqueue: the schema's
      // `job_target_suits_its_kind` would refuse this pairing, and a caller
      // deserves the answer before the round trip.
      if (!isLegalTarget(request.kind, request.target)) {
        throw new Error(`invariant: ${request.kind} jobs cannot target ${request.target}`);
      }

      const jobId = request.jobId ?? newJobId();
      const runAt = request.runAt ?? request.now;
      // The kind's own budget, not one number for the fleet. A caller may still
      // name its own — the cadence never does; a test that is about something
      // else does — but the default is the policy `RETRY_POLICY` states.
      const maxAttempts = request.maxAttempts ?? retryPolicyFor(request.kind).maxAttempts;

      // One statement carries three refusals:
      //
      //   * `NOT EXISTS (… state = 'dead' …)` — poison-job quarantine. A lane
      //     with a dead letter in it stays shut until an operator clears it, so
      //     a crashing tenant is quarantined rather than permanently due.
      //   * `EXISTS (… tenant … 'ready')` — no job for a tenant nothing routes to.
      //   * `ON CONFLICT DO NOTHING` — the partial unique index on
      //     (tenant_id, kind, target) WHERE state IN ('due','running'). No
      //     conflict target is named on purpose: a partial index is not
      //     inferrable from a column list alone, and the bare form covers it.
      const inserted = rowsOf(await sql`
        INSERT INTO control.job (
          job_id, tenant_id, kind, target, state, trigger_reason,
          attempts, max_attempts, debt_observed, run_at, lease_token,
          created_at, updated_at
        )
        SELECT
          ${jobId}::uuid, ${request.tenantId}, ${request.kind}::control.job_kind,
          ${request.target}::control.job_target, 'due', ${request.trigger}::control.job_trigger,
          0, ${maxAttempts}, ${request.debtObserved ?? 0}, ${runAt}, 0,
          ${request.now}, ${request.now}
        WHERE NOT EXISTS (
          SELECT 1 FROM control.job q
          WHERE q.tenant_id = ${request.tenantId}
            AND q.kind = ${request.kind}::control.job_kind
            AND q.target = ${request.target}::control.job_target
            AND q.state = 'dead'
        )
        AND EXISTS (
          SELECT 1 FROM control.tenant t
          WHERE t.tenant_id = ${request.tenantId} AND t.state = 'ready'
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `);

      const row = inserted[0];
      if (row === undefined) return explainRefusal(request);
      return { enqueued: true, job: toJobRecord(row) };
    },

    async claim(request: ClaimRequest): Promise<JobLease | undefined> {
      const kinds = [...(request.kinds ?? JOB_KINDS)];
      // Fail closed on a kind nobody declared. The filter below is a string
      // comparison, so an unknown kind would not error — it would quietly match
      // no rows, and a fleet configured for a mistyped kind would look like a
      // fleet with no work.
      for (const kind of kinds) {
        if (!JOB_KINDS.includes(kind)) throw new Error(`invariant: unknown job kind '${kind}'`);
      }
      if (kinds.length === 0) throw new Error('invariant: a claim must name at least one job kind');
      const expiresAt = leaseExpiryAt(request.now, request.leaseTtlMs);
      const deadline = attemptDeadlineAt(request.now, request.maxAttemptMs);

      // `FOR UPDATE … SKIP LOCKED` is the whole race. Two workers reaching this
      // statement at the same instant take row locks in the same order; the
      // loser skips the locked row rather than waiting for it, so it either
      // finds different work or finds none — and never the same job.
      //
      // The join to `control.tenant` is a fail-closed re-check: a tenant that
      // left `ready` between enqueue and claim (U17's deletion, a failed
      // migration) has jobs that must not run.
      const claimed = rowsOf(await sql`
        UPDATE control.job AS j
        SET state = 'running',
            attempts = j.attempts + 1,
            lease_token = j.lease_token + 1,
            lease_owner = ${request.owner},
            lease_expires_at = ${expiresAt},
            heartbeat_at = ${request.now},
            attempt_deadline_at = ${deadline},
            updated_at = ${request.now}
        WHERE j.job_id = (
          SELECT c.job_id
          FROM control.job AS c
          JOIN control.tenant AS t ON t.tenant_id = c.tenant_id
          WHERE c.state = 'due'
            AND c.run_at <= ${request.now}
            AND c.kind::text = ANY(string_to_array(${kinds.join(',')}, ','))
            AND t.state = 'ready'
          ORDER BY c.run_at, c.created_at
          FOR UPDATE OF c SKIP LOCKED
          LIMIT 1
        )
        RETURNING j.*
      `);

      const row = claimed[0];
      if (row === undefined) return undefined;
      const job = toJobRecord(row);
      if (job.leaseExpiresAt === null || job.attemptDeadlineAt === null || job.leaseOwner === null) {
        // Unreachable while `running_jobs_hold_a_lease` stands. Thrown rather
        // than defaulted, because a lease with a missing expiry is a lease no
        // reaper can ever take.
        throw new Error('invariant: a claimed job must carry an owner, an expiry and an attempt deadline');
      }
      return {
        jobId: job.jobId,
        tenantId: job.tenantId,
        kind: job.kind,
        target: job.target,
        leaseToken: job.leaseToken,
        owner: job.leaseOwner,
        expiresAt: job.leaseExpiresAt,
        attemptDeadlineAt: job.attemptDeadlineAt,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        debtObserved: job.debtObserved,
      };
    },

    async complete(lease: JobLease, request: CompleteRequest): Promise<FencedOutcome> {
      const settle = request.settle;

      const outcome = await sql.begin(async (tx) => {
        const done = rowsOf(await tx`
          UPDATE control.job
          SET state = 'done',
              finished_at = ${request.now},
              updated_at = ${request.now},
              lease_owner = NULL,
              lease_expires_at = NULL,
              attempt_deadline_at = NULL,
              failure_code = NULL
          WHERE job_id = ${lease.jobId}::uuid
            AND lease_token = ${lease.leaseToken}
            AND state = 'running'
          RETURNING *
        `);
        const row = done[0];
        if (row === undefined) return undefined;

        if (settle !== undefined) {
          // Under the same fence and in the same transaction as the completion,
          // so a worker that lost its lease cannot subtract a debt it did not
          // work off or push a due date it does not own.
          //
          // `GREATEST(0, …)` rather than `= 0`: U6 increments this counter while
          // the cycle runs, so zeroing it discards every signal that arrived
          // mid-cycle — and a blind subtraction would trip the schema's own
          // `pending_debt >= 0` CHECK at the worst possible moment.
          //
          // `last_cycle_at` moves only for a cycle that *finished*. A
          // continuation — the same brain, more work, a fresh job — leaves it
          // where it was, because the scheduler's rested window and its debounce
          // arm are both measured from it and both would otherwise hold the
          // tenant for thirty minutes over work it asked to resume at once.
          await tx`
            UPDATE control.tenant
            SET pending_debt = GREATEST(0, pending_debt - ${settle.debtObserved}),
                last_cycle_at = CASE WHEN ${settle.moreToDo === true} THEN last_cycle_at
                                     ELSE ${request.now} END,
                next_due_at = ${settle.nextDueAt},
                updated_at = ${request.now}
            WHERE tenant_id = ${lease.tenantId}
          `;
        }
        return row;
      });

      if (outcome === undefined) return { applied: false, current: await this.get(lease.jobId) };
      return { applied: true, job: toJobRecord(outcome) };
    },

    async fail(lease: JobLease, request: FailRequest): Promise<FencedOutcome> {
      const retryAt = new Date(
        request.now.getTime() + backoffMs(lease.attempts, backoffFor(lease.kind)),
      );
      // Terminal is the caller's reading of *this* failure — "the permission was
      // withdrawn" is not a fact the row carries — so it arrives as a parameter.
      // What it is not allowed to be is a second write path: it ORs into the
      // same CASE the exhaustion test uses, so there is exactly one statement
      // that can move a job to `dead` and one place that sets `dead_lettered_at`.
      const terminal = request.terminal === true;

      // The dead-letter decision is made by the statement, from the row's own
      // `attempts`, rather than from the lease the caller is holding. A worker
      // whose attempt was already superseded holds a stale count, and a retry
      // ladder computed from a stale count is a ladder with no top.
      const failed = rowsOf(await sql`
        UPDATE control.job
        SET state = CASE WHEN ${terminal} OR attempts >= max_attempts THEN 'dead' ELSE 'due' END::control.job_state,
            run_at = CASE WHEN ${terminal} OR attempts >= max_attempts THEN run_at ELSE ${retryAt} END,
            failure_code = ${request.code}::control.job_failure,
            dead_lettered_at = CASE WHEN ${terminal} OR attempts >= max_attempts THEN ${request.now}::timestamptz ELSE NULL END,
            lease_owner = NULL,
            lease_expires_at = NULL,
            attempt_deadline_at = NULL,
            updated_at = ${request.now}
        WHERE job_id = ${lease.jobId}::uuid
          AND lease_token = ${lease.leaseToken}
          AND state = 'running'
        RETURNING *
      `);

      const row = failed[0];
      if (row === undefined) return { applied: false, current: await this.get(lease.jobId) };
      return { applied: true, job: toJobRecord(row) };
    },

    async get(jobId: string): Promise<JobRecord | undefined> {
      const rows = rowsOf(await sql`SELECT * FROM control.job WHERE job_id = ${jobId}::uuid`);
      const row = rows[0];
      return row === undefined ? undefined : toJobRecord(row);
    },

    async reclaim(request: ReclaimRequest): Promise<readonly JobRecord[]> {
      const limit = request.limit ?? DEFAULT_RECLAIM_LIMIT;
      const stealBefore = new Date(request.now.getTime() - request.stealGraceMs);

      return sql.begin(async (tx) => {
        // Candidates are locked with `SKIP LOCKED` so two reapers never contend,
        // and each row is then updated under a compare-and-set on the token it
        // was observed holding. Both halves matter: the lock stops two reapers
        // fighting, and the CAS stops a reaper stealing a lease that was renewed
        // between the select and the update.
        // `kind` is selected because the ladder is per kind: a reaped
        // `ingest_pull` and a reaped `consolidate` must come back at their own
        // policy's next rung, and a sweep that computed one backoff for both
        // would quietly return the connector lane to the 30-second ladder every
        // time a worker died mid-poll.
        const candidates = rowsOf(await tx`
          -- lease_expires_at is read as well as filtered on, because the
          -- failure code below has to compare the two arms against each other
          -- rather than against this sweep's clock. It is already in the WHERE
          -- clause and already in the ORDER BY, so this is one more column on a
          -- row the statement was reading anyway.
          SELECT job_id, kind, lease_token, attempts, max_attempts,
                 attempt_deadline_at, lease_expires_at
          FROM control.job
          WHERE state = 'running'
            AND (lease_expires_at <= ${stealBefore} OR attempt_deadline_at <= ${request.now})
          ORDER BY lease_expires_at
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        `);

        const reclaimed: JobRecord[] = [];
        for (const candidate of candidates) {
          // Which arm fired, decided on the row's own two timestamps. Asking
          // "has the deadline passed by now" instead named every container the
          // platform killed an overrun, because a reap that arrives half an
          // hour late arrives after a fifteen-minute ceiling whatever the
          // holder was doing — and the one code worth escalating on meant
          // nothing.
          const code: JobFailureCode = attemptOverranBeforeLeaseLapsed(
            {
              leaseExpiresAt: candidate.lease_expires_at,
              attemptDeadlineAt: candidate.attempt_deadline_at,
            },
            request.now,
            { stealGraceMs: request.stealGraceMs },
          )
            ? 'attempt_timed_out'
            : 'lease_stolen';
          const exhausted = candidate.attempts >= candidate.max_attempts;
          const retryAt = new Date(
            request.now.getTime() +
              backoffMs(candidate.attempts, backoffFor(candidate.kind as JobKind)),
          );

          // The steal increments the token. That single increment is what turns
          // "the old worker should stop" into "the old worker cannot write".
          const moved = rowsOf(await tx`
            UPDATE control.job
            SET state = ${exhausted ? 'dead' : 'due'}::control.job_state,
                -- A dead job keeps the run_at it had: nothing will claim it
                -- again, and rewriting it would erase when it was last due.
                run_at = COALESCE(${exhausted ? null : retryAt}::timestamptz, run_at),
                lease_token = lease_token + 1,
                lease_owner = NULL,
                lease_expires_at = NULL,
                attempt_deadline_at = NULL,
                failure_code = ${code}::control.job_failure,
                dead_lettered_at = ${exhausted ? request.now : null}::timestamptz,
                updated_at = ${request.now}
            WHERE job_id = ${candidate.job_id}::uuid
              AND lease_token = ${candidate.lease_token}
              AND state = 'running'
            RETURNING *
          `);
          const row = moved[0];
          if (row !== undefined) reclaimed.push(toJobRecord(row));
        }
        return reclaimed;
      });
    },

    async listDeadLetters(
      request: { readonly tenantId?: string; readonly limit?: number } = {},
    ): Promise<readonly JobRecord[]> {
      const limit = request.limit ?? DEFAULT_RECLAIM_LIMIT;
      const tenantId = request.tenantId ?? null;
      const rows = rowsOf(await sql`
        SELECT * FROM control.job
        WHERE state = 'dead'
          AND (${tenantId}::text IS NULL OR tenant_id = ${tenantId})
        ORDER BY dead_lettered_at DESC
        LIMIT ${limit}
      `);
      return rows.map(toJobRecord);
    },

    async clearDeadLetter(
      jobId: string,
      request: ClearDeadLetterRequest,
    ): Promise<ClearDeadLetterOutcome> {
      if (request.action === 'discard') {
        const discarded = rowsOf(await sql`
          UPDATE control.job
          SET state = 'discarded', updated_at = ${request.now}
          WHERE job_id = ${jobId}::uuid AND state = 'dead'
          RETURNING *
        `);
        const row = discarded[0];
        if (row === undefined) return { cleared: false, reason: 'not_dead_lettered' };
        return { cleared: true, job: toJobRecord(row) };
      }

      // Requeue puts the lane back in service, from attempt zero. The partial
      // unique index still holds: if something re-opened this lane while the
      // dead letter sat there, the requeue is refused rather than producing two
      // open jobs for one lane.
      try {
        const requeued = rowsOf(await sql`
          UPDATE control.job
          SET state = 'due',
              attempts = 0,
              run_at = ${request.now},
              dead_lettered_at = NULL,
              failure_code = NULL,
              updated_at = ${request.now}
          WHERE job_id = ${jobId}::uuid AND state = 'dead'
          RETURNING *
        `);
        const row = requeued[0];
        if (row === undefined) return { cleared: false, reason: 'not_dead_lettered' };
        return { cleared: true, job: toJobRecord(row) };
      } catch (error) {
        if (uniqueViolation(error)) return { cleared: false, reason: 'already_open' };
        throw error;
      }
    },

    reviveLane(request: ReviveLaneRequest): Promise<ReviveLaneOutcome> {
      return reviveDeadLane(sql, request);
    },
  };
}

/**
 * Put a lane's dead letter back into service, keyed on the lane.
 *
 * **Standalone, and taking a connection rather than a queue**, which is the
 * shape `createLeaseChannel` already uses one function down and for a related
 * reason: the two callers that need this are not the worker fleet. The web app
 * holds `controlSql` and reads `control.job` directly (that is how the connector
 * panel is rendered); the operator surface holds the same handle. Making them
 * compose a `JobQueue` — with a lease channel, a backoff config and a job-id
 * minter — to move one row would be a queue built to be used once.
 * `createJobQueue` delegates to this, so there is one statement and not two.
 *
 * ============================================================================
 * WHY IT REVIVES RATHER THAN DISCARDS
 * ============================================================================
 *
 * The neighbouring recovery (`src/control/connector-lanes.ts`) *discards* the
 * row and lets the cadence enqueue a fresh one, and its argument — a row put
 * back into circulation carrying a `lease_token` some straggler may still
 * believe it holds is a fence that has stopped fencing — is right for a
 * disconnect. It is not the shape this one wants, for two reasons:
 *
 *   * **The fence is `state = 'running'`, not the token alone.** Every worker
 *     write (`complete`, `fail`, `heartbeat`, `reclaim`) carries that predicate
 *     as well as the token, and a revived row is `due`. A straggler holding the
 *     old token therefore cannot write to it before some worker claims it — and
 *     the claim increments the token, so it cannot write after either.
 *   * **A discard is invisible to the person who pressed the button.** It leaves
 *     nothing in the queue, so the panel reads *connected* and the user waits
 *     for the connector's own cadence to come round before anything is even
 *     queued. A revived row is `due` immediately, which is what *try this again*
 *     means and what the panel then honestly reports.
 *
 * ============================================================================
 * THE ROW IT WILL NOT TOUCH
 * ============================================================================
 *
 * `AND state = 'dead'` is the whole of the safety. Keyed on the lane, the
 * tempting statement is "set this lane back to attempt zero" — which, run
 * against a **healthy** lane on attempt three of its ladder, hands a connector
 * that is currently failing an unlimited retry budget and moves its next attempt
 * to now. It is the same class as the reset that `clearDeadLetter` guards
 * against, and it is the case `test/worker/retry-policy.test.ts` builds
 * deliberately.
 *
 * `enqueue`'s quarantine clause keeps at most one dead row per lane, so the
 * `UPDATE` matches one row. If that invariant were ever broken, the partial
 * unique index refuses the second and the whole statement rolls back rather than
 * opening two jobs for one lane.
 */
export async function reviveDeadLane(
  sql: SQL,
  request: ReviveLaneRequest,
): Promise<ReviveLaneOutcome> {
  try {
    const revived = rowsOf(await sql`
      UPDATE control.job
      SET state = 'due',
          attempts = 0,
          run_at = ${request.now},
          -- Why the job is here is recorded rather than inferred, and somebody
          -- pressing a button is not the cadence coming round.
          trigger_reason = 'user_request'::control.job_trigger,
          dead_lettered_at = NULL,
          failure_code = NULL,
          finished_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          attempt_deadline_at = NULL,
          updated_at = ${request.now}
      WHERE tenant_id = ${request.tenantId}
        AND kind = ${request.kind}::control.job_kind
        AND target = ${request.target}::control.job_target
        AND state = 'dead'
      RETURNING *
    `);
    const row = revived[0];
    if (row === undefined) return { revived: false, reason: 'no_dead_lane' };
    return { revived: true, job: toJobRecord(row) };
  } catch (error) {
    if (uniqueViolation(error)) return { revived: false, reason: 'already_open' };
    throw error;
  }
}

/** SQLSTATE 23505. Bun surfaces the code on `errno`; the message is prose. */
function uniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { errno?: unknown }).errno === '23505';
}

/**
 * The renewal channel, on a connection of its own.
 *
 * Separate from `createJobQueue` so the wiring is a decision someone makes
 * rather than a default they inherit — and so `assertDedicatedLeaseChannel` has
 * two objects to compare. See hazard H4 in `docs/porting-hazards.md`.
 */
export function createLeaseChannel(options: { readonly sql: SQL }): {
  heartbeat: (
    lease: JobLease,
    request: { readonly now: Date; readonly leaseTtlMs: number },
  ) => Promise<{ applied: true; expiresAt: Date } | { applied: false; reason: 'lease_lost' }>;
  connection: SQL;
} {
  const { sql } = options;
  return {
    connection: sql,
    async heartbeat(lease, request) {
      const expiresAt = leaseExpiryAt(request.now, request.leaseTtlMs);
      const rows = (await sql`
        UPDATE control.job
        SET lease_expires_at = ${expiresAt},
            heartbeat_at = ${request.now},
            updated_at = ${request.now}
        WHERE job_id = ${lease.jobId}::uuid
          AND lease_token = ${lease.leaseToken}
          AND state = 'running'
        RETURNING lease_expires_at
      `) as unknown as { lease_expires_at: Date }[];

      const row = rows[0];
      if (row === undefined) return { applied: false, reason: 'lease_lost' };
      return { applied: true, expiresAt: row.lease_expires_at };
    },
  };
}
