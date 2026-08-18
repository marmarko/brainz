/**
 * The `purge` job: the caller `forget`'s 72-hour promise never had.
 *
 * ============================================================================
 * WHAT WAS WRONG
 * ============================================================================
 *
 * `src/mcp/tombstone.ts:purgeExpiredTombstones` has existed since R12. Every
 * mention of it in `src/` outside its own definition is a **comment** —
 * `severance.ts` says the archive "is already swept by
 * `purgeExpiredTombstones`", `versions.ts` says a snapshot "is deleted 72 hours
 * later by `purgeExpiredTombstones`", `subject-erasure.ts` and `reads.ts` both
 * reason from it. Nothing called it. So `forget` never hard-deleted anything,
 * superseded page versions lived forever, and the one time somebody actually
 * needed retracted rows gone they deleted them by hand.
 *
 * That is the same defect as the missing `export` handler, in its fifth
 * instance: a function with no production caller sitting next to a job kind with
 * no handler. This file is the caller.
 *
 * ============================================================================
 * THE SLOT IS THE CONSOLIDATION SLOT, DELIBERATELY
 * ============================================================================
 *
 * A purge for a tenant with nothing expired costs eight `SELECT`s that return
 * nothing — but the connection *wakes a suspended Postgres compute*, and doing
 * that on a schedule of its own for every tenant in the fleet is the cost
 * `scheduler.ts` bounds its schema sweep to avoid. So it is scheduled onto the
 * instant the tenant is already being woken: `nextCeilingDueAt(tenantId, …,
 * ALPHA_CEILING_MS)`, the same staggered slot the consolidation ceiling and the
 * export lane both use, with the same salt. Three jobs, three leases, one wake.
 *
 * **Why not fold it into the consolidation handler**, which already holds the
 * tenant's handle and would have cost no enum value, no CHECK migration and no
 * registration at all: because a tenant whose consolidation lane dead-letters
 * would then silently stop honouring its own retention promise — and precisely
 * for the tenants already in trouble. A lane that can dead-letter on its own is
 * a lane an operator can see.
 *
 * ============================================================================
 * THE ANTI-JOIN, AND WHY THE QUEUE'S OWN REFUSAL IS NOT ENOUGH
 * ============================================================================
 *
 * `enqueue` already refuses a second open job per (tenant, kind, target) — a
 * partial unique index, and it is the authority. But a tick that asked anyway
 * would issue one INSERT per ready tenant per minute for the life of the fleet
 * and be told `already_open` for almost all of them. The anti-join asks the
 * question in one statement instead, so a steady-state tick enqueues only for
 * tenants whose last purge finished. Dead-lettered lanes are excluded for the
 * same reason: the queue would refuse them `quarantined` every minute until an
 * operator cleared them.
 *
 * ============================================================================
 * THE BUDGET IS THE MODULE'S, NOT THE ROW'S
 * ============================================================================
 *
 * `control.job` carries no `jsonb` payload — that is R10's content-free rule and
 * `src/control/schema.sql` states it at length — so there is nowhere on a job row
 * to put a per-tenant budget, and inventing typed columns for one would be a
 * schema change per knob. The handler therefore runs
 * {@link PURGE_ROWS_PER_BATCH} / {@link PURGE_MAX_BATCHES}, the conservative
 * defaults, and that is the right shape rather than a limitation: this sweep has
 * never run anywhere, so its first pass over any real brain should be small,
 * countable, and repeated on the next slot rather than exhaustive on the first.
 * An operator who needs a different pass calls the exported function.
 *
 * **A run that does not finish is not a failure.** `exhausted: false` means the
 * budget ran out with work still waiting, which is the *expected* outcome of the
 * first several runs against an accumulated backlog. The handler completes the
 * job; the anti-join re-enqueues it on the tenant's next slot; the cutoff
 * predicate is idempotent so the next run resumes where this one stopped, with
 * no state carried between them. Throwing instead would walk the backoff ladder
 * and dead-letter a lane that is working exactly as designed.
 *
 * What *does* throw is the fleet's own failure to reach the tenant's database,
 * because that is not a fact about retention at all.
 */

import type { SQL } from 'bun';

import {
  PURGE_MAX_BATCHES,
  PURGE_ROWS_PER_BATCH,
  purgeExpiredTombstones,
  type PurgeRunResult,
} from '../mcp/tombstone.ts';
import type { EnqueueRefusal, JobQueue } from './jobs.ts';
import type { JobContext, JobHandler } from './runner.ts';
import { ALPHA_CEILING_MS, nextCeilingDueAt } from './scheduler.ts';

/** The tenant's own database, and the handle discipline `worker/serve.ts` uses. */
export interface PurgeWorld {
  readonly sql: SQL;
  close(): Promise<void>;
}

export interface PurgePorts {
  open(tenantId: string): Promise<PurgeWorld>;
  /** Where the run's outcome is published. Observability only. */
  readonly onPurge?: (tenantId: string, result: PurgeRunResult) => void;
}

export function createPurgeHandler(ports: PurgePorts): JobHandler {
  return async (context: JobContext): Promise<void> => {
    const tenantId = context.lease.tenantId;
    const world = await ports.open(tenantId);
    try {
      const result = await purgeExpiredTombstones(world.sql, {
        now: context.now,
        budget: { rowsPerBatch: PURGE_ROWS_PER_BATCH, maxBatches: PURGE_MAX_BATCHES },
      });
      ports.onPurge?.(tenantId, result);
    } finally {
      await world.close();
    }
  };
}

// ---------------------------------------------------------------------------
// The enqueue.
// ---------------------------------------------------------------------------

export interface PurgeEnqueueDeps {
  readonly sql: SQL;
  readonly queue: JobQueue;
  /** The cadence. The consolidation ceiling's period, so the slots coincide. */
  readonly periodMs?: number;
}

export interface PurgeEnqueueResult {
  /** Tenants with no purge job standing. Zero is the steady state, not a fault. */
  readonly due: number;
  readonly enqueued: readonly { readonly tenantId: string; readonly runAt: Date }[];
  /**
   * Refusals, carried out rather than swallowed — the rule `runSchedulerTick`
   * states for its own: a tick whose enqueues all come back refused looks
   * exactly like a fleet with nothing to do.
   */
  readonly refused: readonly { readonly tenantId: string; readonly reason: EnqueueRefusal }[];
}

/** How many tenants one tick will give a purge slot to. */
const DEFAULT_LIMIT = 500;

/**
 * **Off unless an operator turned it on, and that stays true for a different
 * reason than it used to.**
 *
 * This comment used to say the lane must stay off because `restoreForgotten`
 * had no production caller — so switching it on would not begin keeping the
 * 72-hour promise, it would convert `forget` from reversible-in-principle into
 * irreversible-in-fact. That condition is gone: `GET /api/retractions` lists
 * what is still restorable, `POST /api/restore` puts one back, `/retractions`
 * is the page `forget`'s own notice names, and `src/web/serve.ts` supplies the
 * port that reaches all three.
 *
 * **The default does not flip with it, and that is a separate property rather
 * than leftover caution.** "Absent reads as off" means a deployment that has
 * never heard of this flag does not start hard-deleting because somebody
 * rebuilt a container — which is a statement about upgrades, not about whether
 * the undo exists. Turning the lane on is still an operator's decision made
 * once, deliberately, per fleet.
 */
export function purgeEnqueueEnabled(env: Record<string, string | undefined>): boolean {
  return env['BRAINZ_PURGE_ENABLED'] === 'true';
}

export async function enqueueDuePurges(
  deps: PurgeEnqueueDeps,
  options: { readonly now: Date; readonly limit?: number; readonly enabled?: boolean },
): Promise<PurgeEnqueueResult> {
  const { now } = options;
  // Absent reads as off, so a deployment that never heard of the flag does not
  // start deleting because it was upgraded.
  if (options.enabled !== true) return { due: 0, enqueued: [], refused: [] };
  const periodMs = deps.periodMs ?? ALPHA_CEILING_MS;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const rows = (await deps.sql`
    SELECT t.tenant_id
      FROM control.tenant t
     WHERE t.state = 'ready'
       AND NOT EXISTS (
         SELECT 1 FROM control.job j
          WHERE j.tenant_id = t.tenant_id
            AND j.kind = 'purge'::control.job_kind
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
      kind: 'purge',
      target: 'whole_brain',
      // The periodic backstop, which is what a retention sweep is: nothing a
      // user does brings it forward, and `user_request` would be a lie about who
      // asked for it.
      trigger: 'time_ceiling',
      now,
      runAt,
    });
    if (outcome.enqueued) enqueued.push({ tenantId: row.tenant_id, runAt });
    else refused.push({ tenantId: row.tenant_id, reason: outcome.reason });
  }

  return { due: rows.length, enqueued, refused };
}
