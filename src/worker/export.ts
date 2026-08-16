/**
 * The `export` job: the caller U17's scheduled self-export never had.
 *
 * **What was wrong.** `JOB_KINDS` has carried `export` since U10 and
 * `LEGAL_TARGETS` has said it targets `whole_brain` for just as long;
 * `src/core/export/schedule.ts` has known how to build the tree, deliver it and
 * bank the attempt since U17. Nothing joined them. `src/worker/serve.ts`
 * registered `{ consolidate }`, `runSchedulerTick` enqueued `consolidate`, and
 * the scheduled export was a job kind with no handler and a function with no
 * production caller — which is the defect this repo has produced more than any
 * other, in its fourth instance.
 *
 * ============================================================================
 * THE SLOT IS THE CONSOLIDATION SLOT, DELIBERATELY
 * ============================================================================
 *
 * An export for a tenant that has chosen no destination costs one connection
 * and one row read — but the connection *wakes a suspended Postgres compute*,
 * and doing that daily for every tenant in the fleet is the cost
 * `scheduler.ts` bounds its schema sweep to avoid ("a wake plus DDL against
 * somebody's suspended database").
 *
 * So the export is scheduled onto the instant the tenant is *already* being
 * woken: `nextCeilingDueAt(tenantId, …, ALPHA_CEILING_MS)`, the same staggered
 * slot the consolidation ceiling uses, with the same salt. A salt of its own
 * would spread the load more evenly and double the number of wakes, which is
 * the wrong trade for a job whose ordinary outcome is a single `SELECT`. The
 * two jobs are separate rows and separate leases; what they share is the
 * minute.
 *
 * ============================================================================
 * THE ANTI-JOIN, AND WHY THE QUEUE'S OWN REFUSAL IS NOT ENOUGH
 * ============================================================================
 *
 * `enqueue` already refuses a second open job per (tenant, kind, target) — that
 * is a partial unique index and it is the authority. But a tick that asked
 * anyway would issue one INSERT per ready tenant per minute for the life of the
 * fleet, and receive `already_open` for almost all of them. The anti-join below
 * asks the question in one statement instead, so a steady-state tick enqueues
 * only for the tenants whose last export actually finished. Dead-lettered lanes
 * are excluded for the same reason: the queue would refuse them `quarantined`
 * every minute until an operator cleared them.
 *
 * ============================================================================
 * THE BRANCH THAT WRITES NOTHING
 * ============================================================================
 *
 * `schedule.ts` exists to keep two facts apart: *"never set up"* and *"tried and
 * failed"*. They are two columns — `last_export_at` and `last_attempt_at` — and
 * the reminder reads both to decide which sentence to say. A handler that
 * banked an attempt for a tenant who has chosen no destination would collapse
 * them on the first tick, for every brain in the fleet: a reminder that should
 * read *"N documents live only here"* would read *"your scheduled export has
 * been failing for 40 days"* — about a schedule that has never had anywhere to
 * go. So the no-destination branch reads one row and returns, and it is the
 * columns rather than the return value that the test asserts on.
 *
 * A destination the tenant chose and this fleet cannot serve is the opposite
 * case and is banked as a failure: the user picked somewhere, nothing is going
 * there, and silence would be the deployment's misconfiguration presented to
 * them as "you have not set this up".
 *
 * ============================================================================
 * A FAILED DELIVERY IS NOT A POISON JOB
 * ============================================================================
 *
 * When the destination throws, `runSelfExport` banks the attempt and the
 * failure and this handler **completes** the job. Letting it throw would fail
 * the job, walk it up the backoff ladder and dead-letter it — which quarantines
 * the tenant's export lane until a human clears it, over a destination that was
 * unreachable for an hour. The failure is already a product fact with a surface
 * that says it out loud; it does not also need to be an operator's incident.
 * What *does* throw is the fleet's own failure to reach the tenant's database,
 * because that is not a fact about the export at all.
 *
 * ============================================================================
 * WHAT IS STILL NOT REACHABLE, NAMED RATHER THAN IMPLIED
 * ============================================================================
 *
 * Nothing can write `self_export.destination_kind` today. Rung 9 gave the table
 * a *kind* and no address and no credential, and `src/web/app.ts`'s
 * `/api/export-config` still answers `501` saying so. Until a rung can hold a
 * destination's address and secret, every scheduled run in a real deployment
 * takes the no-destination branch above — the schedule is live, and it has
 * nowhere to deliver. That is a smaller and more visible gap than the one this
 * file closes, and it is stated here so it is not mistaken for this one.
 */

import type { SQL } from 'bun';

import {
  readExportState,
  runSelfExport,
  type SelfExportDestination,
} from '../core/export/schedule.ts';
import type { EnqueueRefusal, JobQueue } from './jobs.ts';
import type { JobContext, JobHandler } from './runner.ts';
import { ALPHA_CEILING_MS, nextCeilingDueAt } from './scheduler.ts';

/** The tenant's own database, and the handle discipline `worker/serve.ts` uses. */
export interface ExportWorld {
  readonly sql: SQL;
  close(): Promise<void>;
}

/** One destination, built for one tenant. Built per run: it may hold a credential. */
export type ExportDestinationFactory = (tenantId: string) => SelfExportDestination;

export interface ExportPorts {
  open(tenantId: string): Promise<ExportWorld>;
  /**
   * What this deployment can deliver to, by the kind recorded on the tenant's
   * row. Keyed on `string` rather than on `SelfExportDestination['kind']`
   * because the column is text and a value this fleet does not recognise is a
   * state that has to be *handled*, not one the type system can rule out.
   */
  readonly destinations: Readonly<Record<string, ExportDestinationFactory>>;
  /** Where the run's outcome is published. Observability only. */
  readonly onExport?: (tenantId: string, outcome: ExportOutcome) => void;
}

/**
 * What one run did. Four outcomes, and three of them are not deliveries — a
 * shape that reported only success and failure could not tell the deployment's
 * misconfiguration apart from the user's own choice not to have made one.
 */
export type ExportOutcome =
  | { readonly result: 'no_destination' }
  | { readonly result: 'destination_unavailable'; readonly destinationKind: string }
  | {
      readonly result: 'delivered';
      readonly destinationKind: string;
      readonly files: number;
      readonly pages: number;
      readonly digest: string;
    }
  | { readonly result: 'failed'; readonly destinationKind: string; readonly failure: string };

/**
 * The failure banked when the tenant named a destination this fleet cannot
 * build. A code rather than a sentence, for `control.job`'s reason applied to a
 * tenant column: it is read back and shown to a user, and an operator's message
 * is where a hostname or a bucket name reaches somebody's screen.
 */
export const DESTINATION_UNAVAILABLE = 'destination_unavailable';

export function createExportHandler(ports: ExportPorts): JobHandler {
  return async (context: JobContext): Promise<void> => {
    const tenantId = context.lease.tenantId;
    const world = await ports.open(tenantId);
    try {
      const state = await readExportState(world.sql);
      const kind = state.destinationKind;

      if (kind === null) {
        // Nothing is written. See the header: this is the branch that keeps
        // "never set up" from being reported as "failing".
        ports.onExport?.(tenantId, { result: 'no_destination' });
        return;
      }

      const build = ports.destinations[kind];
      if (build === undefined) {
        await bankUnavailable(world.sql, kind, context.now);
        ports.onExport?.(tenantId, { result: 'destination_unavailable', destinationKind: kind });
        return;
      }

      const outcome = await runSelfExport(world.sql, {
        destination: build(tenantId),
        now: context.now,
      });
      ports.onExport?.(
        tenantId,
        outcome.ok
          ? {
              result: 'delivered',
              destinationKind: kind,
              files: outcome.files,
              pages: outcome.manifest.pages,
              digest: outcome.manifest.digest,
            }
          : { result: 'failed', destinationKind: kind, failure: outcome.failure },
      );
    } finally {
      await world.close();
    }
  };
}

/**
 * Bank the attempt for a destination this fleet cannot build.
 *
 * The statement is `runSelfExport`'s failure branch minus the tree, and it is
 * written here rather than reached through that function because reaching it
 * would mean reconstructing every live page in the brain — the expensive half —
 * in order to hand it to a destination that does not exist. The two columns it
 * touches are the two that branch carries, and no others.
 */
async function bankUnavailable(sql: SQL, destinationKind: string, now: Date): Promise<void> {
  const at = now.toISOString();
  await sql`
    INSERT INTO self_export (singleton, destination_kind, last_attempt_at, last_failure)
    VALUES (true, ${destinationKind}, ${at}::timestamptz, ${DESTINATION_UNAVAILABLE})
    ON CONFLICT (singleton) DO UPDATE
      SET destination_kind = EXCLUDED.destination_kind,
          last_attempt_at = EXCLUDED.last_attempt_at,
          last_failure = EXCLUDED.last_failure,
          updated_at = now()
  `;
}

// ---------------------------------------------------------------------------
// The enqueue.
// ---------------------------------------------------------------------------

export interface ExportEnqueueDeps {
  readonly sql: SQL;
  readonly queue: JobQueue;
  /** The cadence. The consolidation ceiling's period, so the slots coincide. */
  readonly periodMs?: number;
}

export interface ExportEnqueueResult {
  /** Tenants with no export job standing. Zero is the steady state, not a fault. */
  readonly due: number;
  readonly enqueued: readonly { readonly tenantId: string; readonly runAt: Date }[];
  /**
   * Refusals, carried out rather than swallowed — the rule `runSchedulerTick`
   * states for its own: a tick whose enqueues all come back refused looks
   * exactly like a fleet with nothing to do.
   */
  readonly refused: readonly { readonly tenantId: string; readonly reason: EnqueueRefusal }[];
}

/** How many tenants one tick will give an export slot to. */
const DEFAULT_LIMIT = 500;

export async function enqueueDueExports(
  deps: ExportEnqueueDeps,
  options: { readonly now: Date; readonly limit?: number },
): Promise<ExportEnqueueResult> {
  const { now } = options;
  const periodMs = deps.periodMs ?? ALPHA_CEILING_MS;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const rows = (await deps.sql`
    SELECT t.tenant_id
      FROM control.tenant t
     WHERE t.state = 'ready'
       AND NOT EXISTS (
         SELECT 1 FROM control.job j
          WHERE j.tenant_id = t.tenant_id
            AND j.kind = 'export'::control.job_kind
            AND j.target = 'whole_brain'::control.job_target
            AND j.state IN ('due', 'running', 'dead')
       )
     ORDER BY t.created_at
     LIMIT ${limit}
  `) as Array<{ tenant_id: string }>;

  const enqueued: { tenantId: string; runAt: Date }[] = [];
  const refused: { tenantId: string; reason: EnqueueRefusal }[] = [];

  for (const row of rows) {
    const runAt = nextCeilingDueAt(row.tenant_id, now, periodMs);
    const outcome = await deps.queue.enqueue({
      tenantId: row.tenant_id,
      kind: 'export',
      target: 'whole_brain',
      // The periodic backstop, which is what this is: nothing about a user's
      // activity brings an export forward, and `user_request` would be a lie
      // about who asked for it.
      trigger: 'time_ceiling',
      now,
      runAt,
    });
    if (outcome.enqueued) enqueued.push({ tenantId: row.tenant_id, runAt });
    else refused.push({ tenantId: row.tenant_id, reason: outcome.reason });
  }

  return { due: rows.length, enqueued, refused };
}
