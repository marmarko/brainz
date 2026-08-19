/**
 * The worker loop (U10).
 *
 * It claims up to a bound, runs handlers, renews leases on a channel of its own,
 * and reports every outcome — including the ones that are nobody's fault.
 *
 * **No timers where a clock will do.** `runOnce` and `beat` both take the
 * current instant as an argument, and the renewal interval is supplied by a
 * `Ticker` port. Production wires `setInterval`; a test calls `beat` by hand.
 * That is what makes lease expiry, backoff and stealing testable as arithmetic
 * against a real database rather than as sleeps.
 *
 * **A runner only claims kinds it can run.** The alternative — claim everything,
 * fail what has no handler — dead-letters real user work every time a fleet is
 * mid-rollout and one instance is a version behind. Scoping the claim is the
 * fail-closed reading and it makes specialised fleets fall out for free.
 *
 * **Nothing here depends on a handler noticing that its lease was lost.** The
 * signal is aborted as a courtesy, so a cooperative handler can stop burning
 * money; the guarantee comes from the store refusing the write.
 *
 * **A handler finishes or it throws, and there is deliberately no third answer.**
 * A return channel for "successful, but run me again at once" existed briefly,
 * for a consolidation cycle that could not fit one attempt. The cycle fits now,
 * and a handler that can re-enqueue itself is a loop whose bound lives in the
 * handler rather than in the scheduler — which is the wrong place for it. A long
 * job says so on its own record and waits for its next scheduled slot.
 */

import {
  jobFailureCodeOf,
  jobRetryableOf,
  type CompleteRequest,
  type JobKind,
  type JobLease,
  type JobQueue,
} from './jobs.ts';
import {
  assertDedicatedLeaseChannel,
  assertLeaseConfig,
  DEFAULT_LEASE_CONFIG,
  type ConnectionBound,
  type LeaseChannel,
  type LeaseConfig,
} from './locks.ts';
import { ALPHA_CEILING_MS, nextCeilingDueAt } from './scheduler.ts';

export interface JobContext {
  readonly lease: JobLease;
  /**
   * Aborted when the lease is lost or the runner is stopping. A courtesy, not a
   * guarantee: a handler that ignores it cannot corrupt anything, because every
   * write it could make is fenced.
   */
  readonly signal: AbortSignal;
  readonly now: Date;
}

export type JobHandler = (context: JobContext) => Promise<void>;

/** Repeating-timer port, so the renewal interval is injectable. */
export interface Ticker {
  every(intervalMs: number, fn: () => void): () => void;
}

export function systemTicker(): Ticker {
  return {
    every(intervalMs, fn) {
      const timer = setInterval(fn, intervalMs);
      // An interval that outlives its runner holds the process open.
      (timer as unknown as { unref?: () => void }).unref?.();
      return () => clearInterval(timer);
    },
  };
}

/** What happened to one claimed job in a pass. */
export type JobOutcome =
  | 'completed'
  | 'failed'
  /** The lease was gone by the time the outcome was written. Not an error. */
  | 'superseded'
  /**
   * The **store** failed while recording an outcome — not the job. Kept distinct
   * because "the control plane is down" must never be recorded on a job as "this
   * job is poison": that ladder ends in a dead letter and a quarantined tenant.
   */
  | 'store_error';

export interface RunOnceResult {
  readonly claimed: number;
  readonly outcomes: Readonly<Record<JobOutcome, number>>;
  /**
   * Store failures, carried out rather than logged and dropped. A pass that
   * returns an empty `claimed` and three of these is a broken control plane, and
   * it must not look like an idle fleet.
   */
  readonly storeErrors: readonly unknown[];
}

export interface RunnerDeps {
  /**
   * The queue **and the connection it runs work on**. The connection is on the
   * type because `assertDedicatedLeaseChannel` needs something to compare, and a
   * queue that will not say where it runs cannot be checked against hazard H4.
   */
  readonly queue: JobQueue & ConnectionBound;
  readonly leases: LeaseChannel;
  /** One per kind this runner serves. Its keys scope every claim. */
  readonly handlers: Partial<Record<JobKind, JobHandler>>;
  /** Identifies the process in `lease_owner`. Observability only. */
  readonly owner: string;
  readonly concurrency: number;
  readonly config?: LeaseConfig;
  /**
   * What a completed job settles on the tenant row. Defaults to the
   * consolidation rule: subtract the debt this job observed and stamp the next
   * staggered ceiling slot. Returning `undefined` settles nothing.
   */
  readonly settle?: (lease: JobLease, now: Date) => CompleteRequest['settle'];
  readonly ticker?: Ticker;
  readonly clock?: () => Date;
  /**
   * Where an error from a detached heartbeat goes. Defaulting this to a silent
   * swallow is how a renewal loop dies and takes the fleet's leases with it, so
   * the default is noisy.
   */
  readonly onError?: (error: unknown) => void;
}

export interface JobRunner {
  runOnce(options: { readonly now: Date }): Promise<RunOnceResult>;
  /** Renews every in-flight lease. Never throws; losses abort their handler. */
  beat(now: Date): Promise<{ readonly renewed: number; readonly lost: number }>;
  inFlight(): number;
  /** Wires the renewal ticker. Returns a stop function that aborts in-flight work. */
  start(): () => void;
}

/** The default settle rule: consolidation moves the tenant's scheduling signals. */
function defaultSettle(lease: JobLease, now: Date): CompleteRequest['settle'] {
  if (lease.kind !== 'consolidate') return undefined;
  return {
    debtObserved: lease.debtObserved,
    nextDueAt: nextCeilingDueAt(lease.tenantId, now, ALPHA_CEILING_MS),
  };
}

export function createJobRunner(deps: RunnerDeps): JobRunner {
  const config = deps.config ?? DEFAULT_LEASE_CONFIG;
  assertLeaseConfig(config);
  // The wiring hazard, refused at construction rather than in review (H4).
  assertDedicatedLeaseChannel(deps.queue, deps.leases);

  const kinds = Object.keys(deps.handlers) as JobKind[];
  if (kinds.length === 0) {
    throw new Error('invariant: a runner with no handlers would claim work it cannot run');
  }
  if (deps.concurrency < 1) {
    throw new Error('invariant: the concurrency bound must admit at least one job');
  }

  const clock = deps.clock ?? (() => new Date());
  const settle = deps.settle ?? defaultSettle;
  const onError = deps.onError ?? ((error: unknown) => console.error('[worker]', error));

  /** In-flight leases, by job id, each with the controller that stops it. */
  const running = new Map<string, { lease: JobLease; controller: AbortController }>();

  /** Store failures from the pass in progress. Carried out, never dropped. */
  let storeErrors: unknown[] = [];

  /**
   * One pass at a time. Overlapping passes would each compute their headroom
   * against a shared in-flight count and each claim up to it — which is the
   * concurrency bound quietly becoming twice what it says.
   */
  let passInFlight = false;

  async function runOne(lease: JobLease, now: Date): Promise<JobOutcome> {
    const controller = new AbortController();
    running.set(lease.jobId, { lease, controller });
    const handler = deps.handlers[lease.kind];

    try {
      if (handler === undefined) {
        // Unreachable: claims are scoped to the handler keys. Thrown rather than
        // defaulted, because the fallback would be to dead-letter user work.
        throw new Error(`invariant: no handler for kind '${lease.kind}'`);
      }
      await handler({ lease, signal: controller.signal, now });
    } catch (error) {
      running.delete(lease.jobId);
      try {
        // The handler's own reading of its failure, where it offered one. Before
        // this, every thrown error was `handler_error` — "a tenant database
        // nobody could reach" and "our code has a bug" were the same row, and
        // the difference was written to container stdout, which nothing outside
        // the container can read. `jobFailureCodeOf` refuses anything outside
        // the enum, so a handler cannot widen the vocabulary or smuggle text
        // into it.
        //
        // **The second reading is whether asking again could help.** A ladder
        // long enough to outlive a provider outage — which is what
        // `ingest_pull` now has — is also long enough to spend two days asking
        // a provider that already said the permission was withdrawn. So a
        // handler may declare its failure terminal, `jobRetryableOf` refuses
        // anything but a literal `false`, and an aborted lease overrules it:
        // our own interruption must never be the thing that kills a lane.
        const outcome = await deps.queue.fail(lease, {
          now: clock(),
          code: jobFailureCodeOf(error, controller.signal.aborted),
          terminal: !jobRetryableOf(error, controller.signal.aborted),
        });
        return outcome.applied ? 'failed' : 'superseded';
      } catch (storeError) {
        storeErrors.push(storeError);
        onError(storeError);
        return 'store_error';
      } finally {
        // The handler's own error is never dropped, whatever the store did with it.
        onError(error);
      }
    }

    running.delete(lease.jobId);
    try {
      const at = clock();
      const settlement = settle(lease, at);
      const outcome = await deps.queue.complete(
        lease,
        settlement === undefined ? { now: at } : { now: at, settle: settlement },
      );
      return outcome.applied ? 'completed' : 'superseded';
    } catch (storeError) {
      storeErrors.push(storeError);
      onError(storeError);
      return 'store_error';
    }
  }

  /**
   * Renews every in-flight lease. Standalone rather than a method so the ticker
   * closes over the function itself — a `this`-bound callback in a detached
   * timer is one refactor away from renewing nothing.
   */
  async function beat(now: Date): Promise<{ renewed: number; lost: number }> {
    let renewed = 0;
    let lost = 0;
    // A snapshot: a handler finishing mid-sweep must not disturb the iteration.
    for (const entry of [...running.values()]) {
      try {
        const outcome = await deps.leases.heartbeat(entry.lease, {
          now,
          leaseTtlMs: config.leaseTtlMs,
        });
        if (outcome.applied) {
          renewed += 1;
        } else {
          lost += 1;
          // A courtesy so a cooperative handler stops spending. The guarantee is
          // the fence, not this.
          entry.controller.abort();
        }
      } catch (error) {
        // A renewal that throws must not take the loop — and every other
        // in-flight lease — down with it. This is the detached-timer
        // unhandled-rejection shape, caught where it happens.
        onError(error);
      }
    }
    return { renewed, lost };
  }

  return {
    inFlight: () => running.size,

    async runOnce(options): Promise<RunOnceResult> {
      if (passInFlight) {
        throw new Error('invariant: a runner pass is already in flight — the concurrency bound is per pass');
      }
      // The latch is set immediately before the block that clears it. Anything
      // between the two — the claim loop especially, which is a store call like
      // any other — would otherwise leave it set on the way out, and a runner
      // that latched once refuses every later pass for the life of the process
      // while looking perfectly alive.
      passInFlight = true;
      try {
        storeErrors = [];
        const outcomes: Record<JobOutcome, number> = {
          completed: 0,
          failed: 0,
          superseded: 0,
          store_error: 0,
        };

        // **The concurrency bound.** Claimed one at a time up to the remaining
        // headroom, so a pass can never exceed it — and so a fleet with 100 due
        // tenants runs 20 of them rather than opening 100 database connections and
        // 100 model conversations.
        const headroom = Math.max(0, deps.concurrency - running.size);
        const leases: JobLease[] = [];
        for (let i = 0; i < headroom; i++) {
          let lease: JobLease | undefined;
          try {
            lease = await deps.queue.claim({
              owner: deps.owner,
              now: options.now,
              leaseTtlMs: config.leaseTtlMs,
              maxAttemptMs: config.maxAttemptMs,
              kinds,
            });
          } catch (storeError) {
            // A claim that fails is the **store** failing, and it gets the same
            // treatment `complete` and `fail` get: carried out, never flattened
            // onto a job. Letting it propagate abandoned every lease already
            // taken this pass — rows left `running` with no worker behind them,
            // recovered only when the reaper takes them and charges an attempt
            // each, which is a control-plane blip walking healthy tenants up the
            // retry ladder and into a quarantine that was never theirs.
            storeErrors.push(storeError);
            onError(storeError);
            break;
          }
          if (lease === undefined) break;
          leases.push(lease);
        }

        const results = await Promise.all(leases.map((lease) => runOne(lease, options.now)));
        for (const result of results) outcomes[result] += 1;
        return { claimed: leases.length, outcomes, storeErrors: [...storeErrors] };
      } finally {
        passInFlight = false;
      }
    },

    beat,

    start() {
      const ticker = deps.ticker ?? systemTicker();
      const stopTicker = ticker.every(config.heartbeatIntervalMs, () => {
        beat(clock()).catch(onError);
      });
      return () => {
        stopTicker();
        for (const entry of running.values()) entry.controller.abort();
      };
    },
  };
}
