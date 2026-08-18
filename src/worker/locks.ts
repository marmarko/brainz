/**
 * Lease arithmetic, the stealing rule, and the dedicated heartbeat channel
 * (U10 approach step 2).
 *
 * **The stealing rule, stated once.** A lease may be taken from its holder when,
 * and only when, it has been expired for longer than a grace window:
 *
 *     stealable  ⟺  state = 'running'
 *                   AND ( lease_expires_at ≤ now − stealGrace
 *                         OR attempt_deadline_at ≤ now )
 *
 * Three properties follow, and each is the reason for one of the terms:
 *
 *   - **The grace window is what a starved-but-alive worker survives.** A
 *     heartbeat that is late because the database was busy is not a dead worker,
 *     and taking its job means two workers run the same cycle. TTL alone makes
 *     every latency spike a double-run.
 *   - **The attempt deadline is the backstop, and it is not redundant with the
 *     lease.** The lease is renewed by the *runner*, not by the handler, so a
 *     wedged handler on a perfectly healthy worker heartbeats forever and holds
 *     its job forever: the liveness signal is exactly what masks the stall. The
 *     deadline is a wall-clock ceiling stamped at claim, and it expires whether
 *     or not the lease still looks alive.
 *   - **Stealing is safe because it fences.** The steal increments
 *     `lease_token`, so the previous holder's subsequent writes are refused by
 *     the store rather than merely discouraged. Nothing here depends on the
 *     dispossessed worker noticing.
 *
 * **And the connection the heartbeat runs on is part of the rule.** Upstream
 * lost roughly 39 worker processes a day when a pooled connection rotated
 * mid-renewal: the renewal query waited behind whatever else the pool was doing,
 * the lease lapsed, the job was stolen, and the worker died holding a lease it
 * no longer had (`docs/porting-hazards.md`, H4). So the heartbeat gets a channel
 * of its own, and `assertDedicatedLeaseChannel` refuses the wiring that shares
 * one — the failure is silent by nature, so the check has to be structural.
 */

import type { JobLease } from './jobs.ts';

/** How long a claim holds the job before it must be renewed. */
export const DEFAULT_LEASE_TTL_MS = 30_000;

/** How often the runner renews it. Several renewals fit inside one TTL. */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * How far past expiry a lease must be before another worker takes it. Sized to
 * cover a latency spike that delays a renewal without covering a dead process.
 */
export const DEFAULT_STEAL_GRACE_MS = 15_000;

/**
 * The wall-clock ceiling on a single attempt — the stall backstop. Generous,
 * because a first import is genuinely long; finite, because "genuinely long" and
 * "wedged" are indistinguishable from the outside without a bound.
 */
export const DEFAULT_MAX_ATTEMPT_MS = 15 * 60_000;

/**
 * A TTL shorter than this many heartbeat intervals declares a live worker dead
 * on a single slow query. Three is the smallest number that survives one lost
 * renewal.
 */
export const MIN_HEARTBEATS_PER_LEASE = 3;

export interface LeaseConfig {
  readonly leaseTtlMs: number;
  readonly heartbeatIntervalMs: number;
  readonly stealGraceMs: number;
  readonly maxAttemptMs: number;
}

export const DEFAULT_LEASE_CONFIG: LeaseConfig = {
  leaseTtlMs: DEFAULT_LEASE_TTL_MS,
  heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
  stealGraceMs: DEFAULT_STEAL_GRACE_MS,
  maxAttemptMs: DEFAULT_MAX_ATTEMPT_MS,
};

/**
 * Checked on the values actually in force, not asserted for the defaults and
 * assumed for every injected set — the discipline `provisionTenant` applies to
 * its own stale window. A misconfiguration here manufactures the double-run the
 * lease exists to prevent, so it throws rather than being recorded on a job as
 * "this job is broken".
 */
export function assertLeaseConfig(config: LeaseConfig): void {
  const { leaseTtlMs, heartbeatIntervalMs, stealGraceMs, maxAttemptMs } = config;

  if (heartbeatIntervalMs <= 0) {
    throw new Error('invariant: the heartbeat interval must be positive, or a lease is never renewed');
  }
  if (leaseTtlMs < heartbeatIntervalMs * MIN_HEARTBEATS_PER_LEASE) {
    throw new Error(
      `invariant: the lease TTL must span at least ${MIN_HEARTBEATS_PER_LEASE} heartbeat intervals, or one slow renewal declares a live worker dead`,
    );
  }
  if (stealGraceMs < 0) {
    throw new Error('invariant: the steal grace cannot be negative, or a lease is stealable before it expires');
  }
  if (maxAttemptMs <= leaseTtlMs) {
    throw new Error(
      'invariant: the attempt deadline must outlive the lease TTL, or every healthy job is reclaimed mid-flight',
    );
  }
}

/** The subset of a job row the stealing rule reads. */
export interface LeaseView {
  readonly state: string;
  readonly leaseExpiresAt: Date | null;
  readonly attemptDeadlineAt: Date | null;
}

/**
 * The stealing rule as a predicate.
 *
 * This is a **mirror** of the SQL `reclaim` issues, and mirrors drift. A test
 * runs both against the same rows and compares, because the failure mode of a
 * drifted mirror is a queue that reaps rows nobody predicted — or, worse, one
 * that predicts reaps it never performs, which reads as a healthy fleet.
 */
export function isStealable(job: LeaseView, now: Date, config: Pick<LeaseConfig, 'stealGraceMs'>): boolean {
  if (job.state !== 'running') return false;

  const deadlinePassed = job.attemptDeadlineAt !== null && job.attemptDeadlineAt.getTime() <= now.getTime();
  if (deadlinePassed) return true;

  // A running row with no expiry cannot exist — `running_jobs_hold_a_lease`
  // refuses it — so treating the impossible row as stealable is the fail-closed
  // reading: a lease nobody can prove is alive is not a lease.
  if (job.leaseExpiresAt === null) return true;

  return job.leaseExpiresAt.getTime() + config.stealGraceMs <= now.getTime();
}

/** When a claim or renewal taken at `now` expires. */
export function leaseExpiryAt(now: Date, leaseTtlMs: number): Date {
  return new Date(now.getTime() + leaseTtlMs);
}

/** The wall-clock ceiling stamped on an attempt claimed at `now`. */
export function attemptDeadlineAt(now: Date, maxAttemptMs: number): Date {
  return new Date(now.getTime() + maxAttemptMs);
}

export type HeartbeatOutcome =
  | { readonly applied: true; readonly expiresAt: Date }
  /**
   * The lease is gone. The worker is told, but nothing depends on it acting:
   * every write it makes from here is refused by the same fence.
   */
  | { readonly applied: false; readonly reason: 'lease_lost' };

/**
 * The renewal path, deliberately a separate port from the queue.
 *
 * An implementation MUST NOT share a connection or a pool with the work the job
 * is doing. That is the entire content of hazard H4: the renewal is a tiny query
 * that must run *now*, and a pool busy with a 40,000-row import cannot promise
 * it will.
 */
export interface LeaseChannel {
  heartbeat(
    lease: JobLease,
    request: { readonly now: Date; readonly leaseTtlMs: number },
  ): Promise<HeartbeatOutcome>;
  /** The connection this channel owns. Compared, never used, by the guard below. */
  readonly connection: unknown;
}

/** Anything that names the connection it runs its work on. */
export interface ConnectionBound {
  readonly connection: unknown;
}

/**
 * Refuse the wiring hazard H4 describes.
 *
 * A shared connection is not a style problem: it is a fleet that loses workers
 * under load and only under load, which is why the check is structural and runs
 * at construction rather than being a comment asking future callers to be
 * careful.
 */
export function assertDedicatedLeaseChannel(work: ConnectionBound, leases: ConnectionBound): void {
  if (work.connection === leases.connection) {
    throw new Error(
      'invariant: the lease channel must own a connection the job work never uses, or a busy pool starves lease renewal (hazard H4)',
    );
  }
}
