/**
 * The job vocabulary (U10): what a job is, what states it moves through, and the
 * port every scheduler and runner talks to.
 *
 * **Why this is a bespoke queue and not pg-boss or graphile-worker.** Two
 * reasons, and if either stops holding the right answer is to adopt a library
 * rather than keep rebuilding hardened machinery:
 *
 *   1. **Lease renewal must run on a connection this module owns.** Production
 *      upstream lost roughly 39 worker processes a day when a pooled connection
 *      rotated mid-renewal (`docs/porting-hazards.md`, H4). The fix is a
 *      dedicated channel for the heartbeat, which is a statement about
 *      connection ownership that a library taking a pool cannot make for us.
 *   2. **The job table is control-plane schema, and the control plane is
 *      content-free.** Every off-the-shelf queue stores a `jsonb` payload;
 *      `src/control/schema.sql` cannot hold one, and the guard that enforces
 *      that (`test/control/schema.test.ts`) names this table as the pressure
 *      point it expects. Typed columns are the price of the property.
 *
 * Everything here is data and pure functions. The Postgres implementation is
 * `queue.ts`, the lease arithmetic is `locks.ts`, and the loop is `runner.ts`.
 */

/**
 * The five kinds, fixed at U10 rather than grown per consumer. U8 (`import`) and
 * U9 (`ingest_pull`) land in Phase 2 and consume these; a queue whose type set is
 * still moving is a queue every consumer re-implements.
 */
export const JOB_KINDS = ['consolidate', 'ingest_pull', 'import', 'export', 're_embed'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * What the job acts on. One NOT NULL enum rather than a nullable column per
 * kind, because it is half the dedupe key and a nullable column in a unique
 * index is not a key at all — Postgres holds NULLs distinct, so "one open job
 * per tenant" would be quietly false for every kind that left it empty.
 */
export const JOB_TARGETS = [
  'whole_brain',
  'gmail',
  'calendar',
  'drive',
  'chat_export',
  'folder',
] as const;
export type JobTarget = (typeof JOB_TARGETS)[number];

/**
 * Which targets each kind may name. Mirrors `job_target_suits_its_kind` in
 * `src/control/schema.sql`, and a test pins the two together — a pairing this
 * table allows and the CHECK refuses is a constraint violation raised on a live
 * enqueue, which is the worst place to discover a disagreement.
 */
export const LEGAL_TARGETS: Readonly<Record<JobKind, readonly JobTarget[]>> = {
  consolidate: ['whole_brain'],
  export: ['whole_brain'],
  re_embed: ['whole_brain'],
  ingest_pull: ['gmail', 'calendar', 'drive'],
  import: ['chat_export', 'folder'],
};

export function isLegalTarget(kind: JobKind, target: JobTarget): boolean {
  return LEGAL_TARGETS[kind].includes(target);
}

export const JOB_STATES = ['due', 'running', 'done', 'dead', 'discarded'] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Which of KTD11's triggers put this job here. Recorded, not inferred. */
export const JOB_TRIGGERS = [
  'debt_debounce',
  'time_ceiling',
  'user_request',
  'connector_cadence',
] as const;
export type JobTrigger = (typeof JOB_TRIGGERS)[number];

/**
 * Why the last attempt ended, as a code rather than a message — the same rule
 * `provisioning_failure` follows, for the same reason: a handler's exception
 * text is the ordinary way a user's filename or a connection string reaches a
 * content-free database.
 */
export const JOB_FAILURE_CODES = [
  'handler_error',
  'attempt_timed_out',
  'lease_stolen',
  'tenant_unavailable',
  'cancelled',
] as const;
export type JobFailureCode = (typeof JOB_FAILURE_CODES)[number];

/** One row of `control.job`. */
export interface JobRecord {
  readonly jobId: string;
  readonly tenantId: string;
  readonly kind: JobKind;
  readonly target: JobTarget;
  readonly state: JobState;
  readonly trigger: JobTrigger;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly debtObserved: number;
  readonly runAt: Date;
  readonly leaseToken: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: Date | null;
  readonly heartbeatAt: Date | null;
  readonly attemptDeadlineAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly finishedAt: Date | null;
  readonly deadLetteredAt: Date | null;
  readonly failureCode: JobFailureCode | null;
}

/**
 * What a worker holds while it runs a job.
 *
 * **`leaseToken` is the fence.** It is not advisory and it is not a hint: every
 * write a worker makes names the token it believes it holds, and the store
 * applies the write only while the row still carries that token. A worker whose
 * lease was stolen is therefore not *asked* to notice and stop — its writes are
 * refused. U2 shipped the other design first (a blind patch keyed on the row id
 * alone) and a straggling run banked `failed` over a live tenant's `ready` row.
 * The same shape here lets a zombie worker mark done a job that another worker
 * is still running, and lets it subtract a debt it did not work off.
 */
export interface JobLease {
  readonly jobId: string;
  readonly tenantId: string;
  readonly kind: JobKind;
  readonly target: JobTarget;
  readonly leaseToken: number;
  readonly owner: string;
  readonly expiresAt: Date;
  readonly attemptDeadlineAt: Date;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly debtObserved: number;
}

export interface EnqueueRequest {
  readonly tenantId: string;
  readonly kind: JobKind;
  readonly target: JobTarget;
  readonly trigger: JobTrigger;
  readonly now: Date;
  /** Defaults to `now`. Backoff and cadence both move it forward. */
  readonly runAt?: Date;
  readonly maxAttempts?: number;
  /**
   * The debt this job is enqueued to work off. Completion subtracts *this*
   * rather than zeroing the counter, because U6 increments it concurrently and a
   * blind reset silently discards everything that arrived mid-cycle.
   */
  readonly debtObserved?: number;
  /** Injectable so tests are deterministic; production lets the store mint one. */
  readonly jobId?: string;
}

/**
 * Why an enqueue was refused. Each one is decided by the store's own statement,
 * never by the caller looking first and inserting second — a caller-side check
 * is a check that ran before the value it protects was used.
 */
export type EnqueueRefusal =
  /** An open job for this tenant, kind and target already exists. */
  | 'already_open'
  /** A dead-lettered job holds this lane until an operator clears it. */
  | 'quarantined'
  /** No `ready` tenant to run it for. */
  | 'tenant_not_ready'
  /**
   * The insert was refused and the row that refused it had already moved by the
   * time the reason was read. Reported honestly rather than guessed at.
   */
  | 'raced';

export type EnqueueOutcome =
  | { readonly enqueued: true; readonly job: JobRecord }
  | { readonly enqueued: false; readonly reason: EnqueueRefusal };

/**
 * `applied: false` is the store telling a worker it no longer owns the job. It
 * is not an error and not a store failure: `current` is what the row says now,
 * so the caller can see what happened to it, and is `undefined` only if the row
 * is gone.
 */
export type FencedOutcome =
  | { readonly applied: true; readonly job: JobRecord }
  | { readonly applied: false; readonly current: JobRecord | undefined };

export interface ClaimRequest {
  readonly owner: string;
  readonly now: Date;
  readonly leaseTtlMs: number;
  /** The wall-clock ceiling on one attempt. See `locks.ts`. */
  readonly maxAttemptMs: number;
  /** Defaults to every kind. A fleet may specialise. */
  readonly kinds?: readonly JobKind[];
}

export interface FailRequest {
  readonly now: Date;
  readonly code: JobFailureCode;
}

export interface CompleteRequest {
  readonly now: Date;
  /**
   * Present when finishing a job settles the tenant's scheduling signals — a
   * consolidation cycle does, a Gmail poll does not. Written in the same
   * transaction and under the same fence as the completion itself, so a stale
   * worker cannot subtract a debt or move a due date.
   */
  readonly settle?: {
    readonly debtObserved: number;
    readonly nextDueAt: Date;
  };
}

/**
 * The queue, behind a port.
 *
 * A store failure is **not** flattened into a job failure: it propagates. "The
 * control plane is down" must never be recorded on a job row as "this job is
 * poison", because that ladder ends in a dead letter and a quarantined tenant.
 *
 * Every method that a lease-holder calls takes the lease positionally, so no
 * write site can omit the fence and still compile.
 */
export interface JobQueue {
  enqueue(request: EnqueueRequest): Promise<EnqueueOutcome>;
  claim(request: ClaimRequest): Promise<JobLease | undefined>;
  complete(lease: JobLease, request: CompleteRequest): Promise<FencedOutcome>;
  fail(lease: JobLease, request: FailRequest): Promise<FencedOutcome>;
  get(jobId: string): Promise<JobRecord | undefined>;
  /**
   * Re-enqueue jobs whose worker died or whose attempt overran. Returns the rows
   * it moved, so a caller can log what it found rather than discovering the
   * fleet was reaping constantly from a metric nobody watches.
   */
  reclaim(request: ReclaimRequest): Promise<readonly JobRecord[]>;
  listDeadLetters(request?: { readonly tenantId?: string; readonly limit?: number }): Promise<
    readonly JobRecord[]
  >;
  clearDeadLetter(jobId: string, request: ClearDeadLetterRequest): Promise<ClearDeadLetterOutcome>;
}

export interface ReclaimRequest {
  readonly now: Date;
  /** How far past expiry a lease must be before it is taken. See `locks.ts`. */
  readonly stealGraceMs: number;
  readonly limit?: number;
}

export interface ClearDeadLetterRequest {
  readonly now: Date;
  /** `requeue` sends the job round again from attempt zero; `discard` retires it. */
  readonly action: 'requeue' | 'discard';
}

export type ClearDeadLetterOutcome =
  | { readonly cleared: true; readonly job: JobRecord }
  | { readonly cleared: false; readonly reason: 'not_dead_lettered' | 'already_open' };

/**
 * Retry backoff: exponential, capped, with **equal jitter** — half the delay
 * fixed, half random.
 *
 * Full jitter is the more common recipe and is wrong here: it can return
 * near-zero, so a job that fails instantly is retried instantly, and one poison
 * tenant spins a worker at whatever rate the handler can crash. The fixed half
 * is the floor that makes the ladder a ladder.
 */
export interface BackoffConfig {
  readonly baseMs: number;
  readonly maxMs: number;
  /** Injectable so tests are deterministic. Production passes nothing. */
  readonly random?: () => number;
}

export const DEFAULT_BACKOFF: Required<Omit<BackoffConfig, 'random'>> = {
  baseMs: 30_000,
  maxMs: 15 * 60_000,
};

export function backoffMs(attempts: number, config: BackoffConfig): number {
  const step = Math.max(1, Math.trunc(attempts));
  // 2^30 caps the shift before it can overflow into a negative or an Infinity;
  // `maxMs` clamps it back down to something a human chose either way.
  const exponent = Math.min(step - 1, 30);
  const ceiling = Math.min(config.maxMs, config.baseMs * 2 ** exponent);
  const half = ceiling / 2;
  const random = config.random ?? Math.random;
  return Math.round(half + half * random());
}
