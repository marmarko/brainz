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

/**
 * What a handler may say about its own failure, so `handler_error` stops being
 * the answer to every question.
 *
 * **Why a property on the error rather than a parameter.** A handler signals
 * failure by throwing; there is no return channel, and giving one to the
 * `JobHandler` type would mean every handler that does not care declares it.
 * So the classification rides on the thrown value, and {@link jobFailureCodeOf}
 * reads it.
 *
 * **Why it is duck-typed rather than an exported error class.** This module is
 * U10's vocabulary and it is imported by every handler; a base class here would
 * invert that, and an `instanceof` check across module instances is the fragile
 * half of that arrangement anyway. Anything carrying the property is understood,
 * and anything else is `handler_error`, which is what it was before.
 *
 * **It cannot widen the vocabulary and that is the point.** The value is checked
 * for membership in {@link JOB_FAILURE_CODES}, so a handler that assigned a
 * provider's error text to it — the ordinary way somebody's subject line reaches
 * a content-free database — records `handler_error` and the text goes nowhere.
 * The column's enum would refuse it a second time; this is the first.
 */
export interface JobFailureCause {
  readonly jobFailureCode?: unknown;
  /**
   * `false` when this failure will not fix itself and the lane should stop now.
   * Read by {@link jobRetryableOf}; anything other than a literal `false` — a
   * missing property, a provider's message assigned to it — is retryable.
   */
  readonly jobRetryable?: unknown;
}

function isJobFailureCode(value: unknown): value is JobFailureCode {
  return (JOB_FAILURE_CODES as readonly unknown[]).includes(value);
}

/**
 * Which code a failed attempt is recorded under.
 *
 * `aborted` wins over anything the handler claims, and it is checked first: the
 * fence is the truth about whether this worker still owned the job, and a
 * handler that noticed some other problem on its way out does not get to
 * relabel a stolen lease as its own failure.
 */
export function jobFailureCodeOf(error: unknown, aborted: boolean): JobFailureCode {
  if (aborted) return 'lease_stolen';
  if (typeof error !== 'object' || error === null) return 'handler_error';
  const claimed = (error as JobFailureCause).jobFailureCode;
  return isJobFailureCode(claimed) ? claimed : 'handler_error';
}

/**
 * Whether asking again could plausibly help.
 *
 * **The distinction, and why conflating it was the real defect.** A retry ladder
 * long enough to outlive a provider outage is also long enough to spend two days
 * asking a provider that has already answered *this permission was withdrawn* —
 * which costs vendor quota, costs a tenant-database wake per rung, and reads to
 * the user as a connector that is limping rather than one that needs thirty
 * seconds of their attention. One ladder cannot serve both, so the failure says
 * which it is.
 *
 * **Three rules, in this order.**
 *
 *   1. **An aborted lease is always retryable**, checked first and for the same
 *      reason `jobFailureCodeOf` checks it first: the fleet losing its own lease
 *      mid-attempt is our interruption, not the provider's answer. Without this,
 *      a redeploy landing in the middle of a poll that had *already* decided it
 *      was terminal would kill the lane on our schedule.
 *   2. **Only `jobRetryable === false` is terminal.** Not falsy — false. A
 *      handler that assigned a provider's message to the property, or left it
 *      `undefined`, gets the ladder.
 *   3. **Everything unclassified is retryable.** Fail-open, which is the
 *      opposite of this module's usual direction and is deliberate: the incident
 *      was a lane that stopped too early, and an unrecognised throw is exactly
 *      the "we do not know" case that must keep trying.
 */
export function jobRetryableOf(error: unknown, aborted: boolean): boolean {
  if (aborted) return true;
  if (typeof error !== 'object' || error === null) return true;
  return (error as JobFailureCause).jobRetryable !== false;
}

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
  /**
   * True when asking again cannot help — see {@link jobRetryableOf}. The lane
   * dead-letters on this attempt whatever its ladder had left.
   *
   * Optional, and its absence means *retryable*. That default is the deliberate
   * direction: the failure this whole policy exists to stop is a lane that gave
   * up too early, so a caller who says nothing gets the ladder.
   */
  readonly terminal?: boolean;
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
  /**
   * The same recovery as `clearDeadLetter`'s `requeue`, keyed on the **lane**
   * rather than on a job id — see {@link ReviveLaneRequest}.
   */
  reviveLane(request: ReviveLaneRequest): Promise<ReviveLaneOutcome>;
}

/**
 * Put one lane's dead letter back into service.
 *
 * **Why a second entry point when `clearDeadLetter` exists.** That one is keyed
 * on a job id, which is the right key for an operator reading
 * `listDeadLetters`. It is the wrong key for the two callers that actually need
 * this: a user pressing *try this again* on their dashboard knows their source,
 * not a UUID, and asking the caller to look the id up first is the
 * check-then-write shape this store refuses everywhere else — two presses of the
 * same button would each find the same row and each act on it.
 *
 * So the lane is the key, and the statement decides. `kind` is on the request
 * rather than fixed to `ingest_pull` because nothing about the shape is
 * connector-specific; what is connector-specific is who is allowed to ask, and
 * that belongs to the surface, not here.
 */
export interface ReviveLaneRequest {
  readonly tenantId: string;
  readonly kind: JobKind;
  readonly target: JobTarget;
  readonly now: Date;
}

export type ReviveLaneOutcome =
  | { readonly revived: true; readonly job: JobRecord }
  | {
      readonly revived: false;
      /**
       * `no_dead_lane` — nothing here is dead. Covers "it never failed", "it
       * recovered on its own" and "somebody already pressed this", which is
       * everything a caller can honestly be told apart from a lie.
       *
       * `already_open` — a dead letter sat here **and** something re-opened the
       * lane, so reviving would produce two open jobs for one lane. Refused by
       * the partial unique index rather than by a look-first.
       */
      readonly reason: 'no_dead_lane' | 'already_open';
    };

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

/** Default retry ladder length. Five attempts, then the dead letter. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * How long a job of one kind is given, in total, before the lane is declared
 * dead. One record, five entries, and the argument for each is below.
 *
 * ============================================================================
 * WHY THIS IS PER KIND AND NOT ONE NUMBER
 * ============================================================================
 *
 * The old policy was a single global: five attempts, 30s doubling to a
 * 15-minute cap. It is a *good* policy for `consolidate`, `export`, `re_embed`
 * and `import` — those fail because something of **ours** broke, a human is
 * usually nearby, and a lane that limps for two days before anyone is told is
 * worse than one that stops loudly in four minutes.
 *
 * It is the wrong policy for `ingest_pull`, because the thing being waited on is
 * **somebody else's API**. A provider outage, a rate-limit window, or a vendor
 * deploy routinely lasts longer than that entire ladder. It happened: three of
 * one brain's connectors dead-lettered at 5/5 inside four minutes of wall clock
 * because a vendor route answered `404`; the corrected route deployed the same
 * evening and reached three lanes that would never ask again.
 *
 * ============================================================================
 * THE CONNECTOR LADDER, AND WHY THESE NUMBERS
 * ============================================================================
 *
 * **The unit is the cron tick, not the second.** A Cloudflare cron wakes the
 * worker fleet every thirty minutes (`wrangler.toml`, DECISION 3) and the
 * container sleeps five minutes after it goes idle. Any delay shorter than that
 * period is rounded up to the next wake anyway, so a ladder expressed in seconds
 * is fiction for this kind — and worse than fiction, because the four rungs
 * below 30 seconds all landed inside a *single* wake window, which is how five
 * attempts burned in under four minutes. `baseMs` is therefore one cron period,
 * which makes the first rung the shortest thing the fleet can actually honour.
 *
 * **`maxMs` is 6 hours, and it is the number that matters most.** The cap, not
 * the attempt count, sets what a lane that is genuinely broken costs forever
 * after: at a 6-hour cap and equal jitter, a dead-in-all-but-name lane makes at
 * most 4 provider calls a day and wakes the tenant's database 4 times. Three
 * connectors on one brain is 12. That is small enough to be affordable and large
 * enough that a recovery inside a working day is noticed on the same day.
 *
 * **`maxAttempts` is 12, and it follows from the cap plus a horizon.** With a
 * 30-minute base doubling to a 6-hour cap, twelve attempts put the *last* one
 * between 24.75 h (jitter at its floor) and 49.5 h (at its ceiling) after the
 * first failure. That comfortably outlives an ordinary outage — the case this
 * exists for — and stops well before "it has been asking for a week".
 * {@link CONNECTOR_RETRY_HORIZON_MS} is the floor stated as a claim, and
 * `test/worker/retry-policy.test.ts` holds the policy to it.
 *
 * **The ladder does not have to be infinite, because there is now a way back.**
 * `reviveDeadLane` (`src/worker/queue.ts`) puts a dead lane back into service
 * from attempt zero without costing the user a re-authorization, and it is
 * reachable from the dashboard and from `/admin`. Before it existed, the only
 * argument for a longer ladder was that the alternative was forever.
 *
 * **Equal jitter throughout.** See {@link BackoffConfig}: half of each delay is
 * fixed and half is random. Full jitter can return near zero, which would put
 * the connector ladder's first rung back inside the wake window it was widened
 * to escape.
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly backoff: Required<Omit<BackoffConfig, 'random'>>;
}

/**
 * The floor the connector ladder claims to reach, stated as a round human number
 * rather than derived from the policy.
 *
 * Derived, it would be a tautology — the ladder would meet its horizon by
 * definition and the test would assert nothing. Stated, it is a claim the
 * numbers above have to keep meeting, and shortening any of them turns
 * `test/worker/retry-policy.test.ts` red.
 */
export const CONNECTOR_RETRY_HORIZON_MS = 24 * 60 * 60_000;

export const RETRY_POLICY: Readonly<Record<JobKind, RetryPolicy>> = {
  // Ours to fix and a human is nearby: stop loudly, and soon.
  consolidate: { maxAttempts: DEFAULT_MAX_ATTEMPTS, backoff: DEFAULT_BACKOFF },
  export: { maxAttempts: DEFAULT_MAX_ATTEMPTS, backoff: DEFAULT_BACKOFF },
  re_embed: { maxAttempts: DEFAULT_MAX_ATTEMPTS, backoff: DEFAULT_BACKOFF },
  // A user-supplied archive against our own object store. Same class.
  import: { maxAttempts: DEFAULT_MAX_ATTEMPTS, backoff: DEFAULT_BACKOFF },
  // Somebody else's API. See the block above for every number here.
  ingest_pull: { maxAttempts: 12, backoff: { baseMs: 30 * 60_000, maxMs: 6 * 60 * 60_000 } },
};

/**
 * The policy for one kind.
 *
 * A function rather than a bare index so every read is one call site to find,
 * and so a kind that somehow arrived from outside the enum fails here rather
 * than resolving to `undefined` and giving a lane a `NaN` ladder.
 */
export function retryPolicyFor(kind: JobKind): RetryPolicy {
  const policy = RETRY_POLICY[kind];
  if (policy === undefined) throw new Error(`invariant: no retry policy for job kind '${kind}'`);
  return policy;
}

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
