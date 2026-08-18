/**
 * The pull runner (U9 approach 2, 2a, 3, 4) and the `ingest_pull` handler.
 *
 * A pull is an import with three things an import does not have, and each one
 * is a way a connector quietly ruins a brain rather than merely costing money:
 *
 *   1. **Update and tombstone semantics.** An item whose upstream version moved
 *      re-chunks through U4's reconcile path (`ingestDocument` does this on a
 *      changed digest); an item deleted, trashed or cancelled upstream is
 *      tombstoned here. Skip the second and a cancelled meeting keeps appearing
 *      in tomorrow's briefing, an edited document keeps its superseded chunks
 *      ranking, and U11 reads the stale row against its replacement and reports
 *      a contradiction that never happened.
 *   2. **A cursor that expires.** Providers force this: Calendar answers `410
 *      GONE` and mandates a full re-sync, Gmail's history window lapses the
 *      same way. The answer is *not* to re-list the mailbox — that is the
 *      unbounded first import U8's gate exists to prevent, arriving through a
 *      door marked "routine poll". So an invalidation discards the cursor,
 *      writes a staleness event, and re-enters through the gate with a bounded
 *      window.
 *   2a. **The window bounds a first import and nothing else.** A delta feed is
 *      already bounded by what changed, so windowing it buys no ceiling and
 *      costs the update: the item is dropped *and* the cursor advances past it,
 *      so the provider never offers that change again. An item's `occurredAt`
 *      is when it happened, not when it was edited — a meeting held in March
 *      and annotated in August arrives dated March — and every window is
 *      measured from `now`, so a row drifts out of one just by the calendar
 *      moving. {@link windowFor} is the single place that decides, and a
 *      cursor-expiry re-list picks the window back up because it *is* a first
 *      import wearing a poller's clothes.
 *   3. **A junk gate in front of the meter.** Hidden items are handed to U4's
 *      `quarantine` seam, which contributes no facts and keeps their chunks out
 *      of the embedding backlog — and, because their characters are zeroed
 *      before the estimate, they do not inflate the approval either.
 *   4. **An erasure tombstone in front of everything.** R12's subject erasure is
 *      only real if the next poll cannot undo it, and it *would*: the erasure
 *      soft-deletes her pages and U4's replacement lookup only finds live ones,
 *      so an unconsulted poll writes a brand-new page about the correspondent
 *      whose receipt says this brain holds nothing about her — on a five-minute
 *      cadence. `src/ingest/erased-subjects.ts` is the question this runner asks
 *      before the meter, and states what a digest-only tombstone can reach.
 *
 * **The gate is U8's, reused, with one adapter.** `gateFirstImport` defers into
 * the `import` job lane; the database's `job_target_suits_its_kind` admits only
 * `ingest_pull` for a connector target. {@link connectorGateQueue} rewrites the
 * kind and target on the way through and changes nothing else. It is a seam,
 * and it is stated rather than hidden: when U8's `GateRequest.target` is next
 * widened to `JobTarget`, this adapter deletes.
 *
 * **Deletions run in front of the gate, not behind it.** A tombstone costs no
 * provider call, so no ceiling has an opinion on it — and a pull the gate
 * refused that skipped the sweep would keep a cancelled meeting answering
 * queries until the tenant's thirty-day spend window rolls. Worse than late: if
 * the sync cursor expires meanwhile, the recovery re-list carries no tombstones
 * at all (a backfill enumerates what exists, never what is gone) and the
 * deletion is lost for good. That is the stale row U11 reports against its
 * replacement as a genuine contradiction, manufactured by the spend gate.
 *
 * **A banked approval is re-clamped, not re-gated.** Deferring spends nothing,
 * so the counter the gate read has not moved by the time the background job
 * runs; `clampApproval` trims the banked figure to the headroom still there.
 * Without it every deferred lane carries its own full copy of the ceiling.
 *
 * **Two callers, two ceilings.** An interactive caller (the web app's "connect
 * Gmail") gets U8's default inline ceilings, so a large first import defers to
 * a background job. The `ingest_pull` handler passes `interactive: false`,
 * because it *is* that background job: deferring from inside it would refuse
 * with `no_queue` (the lane is already held by this very job) and the connector
 * would never backfill at all. What still bounds it there is the thing that
 * always bounds it — one `Budget`, built from what the gate approved, threaded
 * through every write.
 *
 * **The cursor advances last, and only over banked work.** A crash before the
 * advance re-pulls items the brain already holds, which U4 answers `unchanged`
 * at zero cost. The other order silently skips whatever was in flight, and
 * nothing downstream can tell.
 */

import type { SQL } from 'bun';

import { createBudget } from '../../ai/gateway.ts';
import type { PriceBook } from '../../ai/pricing.ts';
import type { NamedProfile } from '../../ai/routing.ts';
import type { TenantStorage } from '../../control/storage.ts';
import { acceptMedia } from '../../core/media/accept.ts';
import { runChunkEmbedBacklog } from '../../core/write/embed.ts';
import {
  contentDigest,
  ingestDocument,
  type WriteFailureReason,
} from '../../core/write/write-path.ts';
import type {
  EnqueueOutcome,
  EnqueueRefusal,
  JobFailureCode,
  JobLease,
  JobQueue,
  JobTrigger,
} from '../../worker/jobs.ts';
import type { JobContext } from '../../worker/runner.ts';
import {
  SOURCE_TYPE_FOR,
  discardCursor,
  isConnectorSource,
  isPullDue,
  normalizeAccountKey,
  pullModeFor,
  type ConnectorSource,
  type ConnectorState,
  type ConnectorStateStore,
  type PullMode,
} from '../cursor.ts';
import {
  DEFAULT_WINDOW_DAYS,
  clampApproval,
  estimateImport,
  gateFirstImport,
  selectWindow,
  type GateDecision,
  type ImportCandidate,
  type ImportEstimate,
  type ImportTarget,
  type ImportWindow,
} from '../first-import.ts';
import { partitionErasedSubjects } from '../erased-subjects.ts';
import { gateJunk } from '../junk.ts';
import { countRunItem, finishRun, openRun, recordItem, type IngestFailureCode } from '../log.ts';
import { mediaFailureFor, type TenantRuntime } from '../import/run.ts';
import type { RawStore } from '../import/raw.ts';
import type { PullFailureReason } from './client.ts';
import { tombstoneRefs } from './tombstone.ts';
import type { ProviderSource } from './sources/types.ts';

/**
 * R15's origin, credential-derived and immutable: **which half of the brain this
 * connection belongs to, and the source that fetched the item.** Every page,
 * chunk and fact this unit writes carries it, and it is what scopes the
 * tombstone sweep.
 *
 * **This is the producer U18's context grants did not have.** The grammar, the
 * wildcard expansion, the mint-and-verify scope invariant and the read fence
 * were all built and all tested — against rows planted in SQL, because nothing
 * in `src/` wrote one. Every connector page filed at `pipedream:<source>`, whose
 * class no `work:*` or `personal:*` grant can name, so a work-scoped grant
 * obtained through the real consent flow expanded to `['work:agent']` and read
 * back exactly the memories it had written itself. "A work-scoped grant provably
 * cannot read personal rows" was true of it, and so was "it cannot read a
 * mailbox". A connection that records a context class now files at
 * `<class>:<source>`, and `test/ingest/pipedream/context-origin.test.ts` proves
 * the read-back through the real `expandGrant` and the real fence.
 *
 * **`null` keeps the vendor class, and that is the safe direction rather than
 * the timid one.** `origin` is immutable by trigger and U4's replacement lookup
 * keys on `(external_ref, origin_context)`, so re-originating an existing
 * connection would strand every page it already wrote at the old origin — out of
 * reach of a tombstone sweep that scopes by origin — and write a second live
 * page for each on the next poll. `pipedream:<source>` is also unreachable by
 * any narrowed grant, so the failure mode of a forgotten class is a mailbox a
 * context grant cannot see, never one it should not have seen.
 *
 * The parameter is **required** for the same reason `PulledFailure.retryable`
 * is: the caller is the only one that knows, and a default here would be a
 * decision about access that nobody made.
 */
export function originContextFor(source: ConnectorSource, contextClass: string | null): string {
  return contextClass === null ? `pipedream:${source}` : `${contextClass}:${source}`;
}

/** How many items one pull will take from a provider before stopping. */
export const DEFAULT_MAX_ITEMS_PER_PULL = 500;

/**
 * The placeholder handed to U8's gate, which types `target` as an
 * `ImportTarget`. It never reaches the queue: {@link connectorGateQueue}
 * replaces it with the connector's own lane, and the assertion inside the
 * adapter is what stops this from becoming a job nobody handles.
 */
export const GATE_PLACEHOLDER_TARGET: ImportTarget = 'folder';

export interface PullRequest {
  readonly tenant: TenantRuntime;
  /** The control plane. The gate's counter and cap live on the tenant row. */
  readonly control: SQL;
  readonly profile: NamedProfile;
  readonly source: ProviderSource;
  readonly states: ConnectorStateStore;
  /**
   * Where an object goes, and the accessor that decides its key.
   *
   * Optional because a source that offers no media needs neither, and required
   * in practice for Drive: a listing that carries objects and a runner with
   * nowhere to put them writes a failure row per object and **holds the
   * cursor**, so the file is offered again once the fleet is wired rather than
   * skipped for good by a configuration nobody noticed.
   */
  readonly storage?: TenantStorage;
  readonly rawStore?: RawStore;
  readonly now: Date;
  readonly window?: ImportWindow;
  readonly queue?: JobQueue;
  /**
   * Defaults to true. False means "this already IS the background job" — the
   * inline ceilings are lifted and the budget is the only bound. See the
   * header.
   */
  readonly interactive?: boolean;
  /** A resumed, already-gated backfill. Present means "skip the gate". */
  readonly approvedMicroUsd?: number;
  readonly jobId?: string;
  readonly priceBook?: PriceBook;
  readonly inlineItemCeiling?: number;
  readonly inlineSpendCeiling?: number;
  readonly maxItems?: number;
}

export type PullStopReason =
  | PullFailureReason
  | 'budget_exhausted'
  | 'model_not_priced'
  /** The listing reported a different account than the one on record. */
  | 'identity_changed'
  /** Items the page offered that this pull never got to. The cursor holds. */
  | 'not_attempted';

/** Which ingest-log code a stop is, so a stopped run says *why* it stopped. */
function stopCodeFor(reason: PullStopReason): IngestFailureCode {
  switch (reason) {
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'identity_changed':
    case 'not_attempted':
      return 'cancelled';
    case 'model_not_priced':
      return 'provider_error';
    default:
      return ingestCodeFor(reason);
  }
}

/**
 * An item-level failure code, read back as the reason this run is incomplete.
 *
 * The inverse of {@link ingestCodeFor}, and lossy in the same one place: the
 * table's `cancelled` covers both "the ceiling stopped us" and "the account
 * went away mid-page", and both mean the same thing to the cursor.
 */
function reasonForCode(code: IngestFailureCode): PullStopReason {
  switch (code) {
    case 'rate_limited':
      return 'rate_limited';
    case 'auth_expired':
      return 'auth_expired';
    case 'budget_exhausted':
      return 'budget_exhausted';
    case 'cancelled':
      return 'not_attempted';
    default:
      return 'provider_error';
  }
}

/**
 * Would asking again help?
 *
 * The content refusals (`empty_document`, `unknown_source_type`) are stable
 * facts about the item and must not hold the cursor. Everything else is the
 * fleet's own machinery failing around an item that was perfectly fine, and
 * advancing past it loses the change for good.
 */
function writeLossIsRetryable(reason: WriteFailureReason): boolean {
  return (
    reason === 'embed_failed' ||
    reason === 'tenant_not_configured' ||
    reason === 'embedding_model_unknown'
  );
}

export interface PullCounts {
  readonly written: number;
  readonly unchanged: number;
  readonly quarantined: number;
  /** Written, searchable, and flagged by the junk gate as transactional. */
  readonly warned: number;
  readonly failed: number;
  readonly tombstoned: number;
  /**
   * Items an erasure instruction forbids this brain from holding (R12).
   *
   * Its own counter, and not folded into `failed`: nothing failed. The provider
   * offered the message, the fetch worked, and the brain declined to write it —
   * a number an operator reading a connector's health has to be able to tell
   * apart from mail that went missing.
   */
  readonly suppressed: number;
  /**
   * Objects preserved and queued for transcription — stored, replaced or
   * already held. Apart from `written` because an attachment is not a page: it
   * becomes one later, in U11's cycle, if there is anything written on it.
   */
  readonly attachments: number;
}

/**
 * What a pull did, as a closed set.
 *
 * Named rather than left inline on {@link PullResult} because the control
 * plane's `connector_run_outcome` enum restates it — `src/control/
 * connector-health.sql` — and a test parses that file and compares the two. An
 * inline union is a vocabulary nothing can check.
 */
export const PULL_OUTCOMES = ['completed', 'stopped', 'deferred', 'refused', 'failed'] as const;
export type PullOutcome = (typeof PULL_OUTCOMES)[number];

export interface PullResult {
  readonly outcome: PullOutcome;
  readonly mode: PullMode;
  readonly runId: string | null;
  readonly decision: GateDecision | null;
  readonly estimate: ImportEstimate | null;
  readonly counts: PullCounts;
  /** The visible widen path: what the window left out, and what the provider says is beyond it. */
  readonly widen: {
    readonly excludedItems: number;
    readonly windowDays: number | null;
    readonly outsideWindow: number | null;
  };
  readonly attemptedItems: number;
  readonly cursorAdvanced: boolean;
  readonly cursorInvalidated: boolean;
  readonly stopReason?: PullStopReason;
}

const EMPTY_COUNTS: PullCounts = {
  written: 0,
  unchanged: 0,
  quarantined: 0,
  warned: 0,
  failed: 0,
  tombstoned: 0,
  suppressed: 0,
  attachments: 0,
};

interface MutableCounts {
  written: number;
  unchanged: number;
  quarantined: number;
  warned: number;
  failed: number;
  tombstoned: number;
  suppressed: number;
  attachments: number;
}

/** A provider failure, in the vocabulary `ingest_log.failure_code` admits. */
function ingestCodeFor(reason: PullFailureReason): IngestFailureCode {
  switch (reason) {
    case 'auth_expired':
      return 'auth_expired';
    case 'rate_limited':
      return 'rate_limited';
    case 'not_connected':
      return 'cancelled';
    // `cursor_invalid` has no code of its own — the table's vocabulary is U3's
    // and is not this unit's to widen. The precise record is the connector
    // state's `lastCursorInvalidatedAt`; the log row says a run failed against
    // the provider, which is what a staleness display needs.
    default:
      return 'provider_error';
  }
}

function writeCodeFor(reason: WriteFailureReason): IngestFailureCode {
  switch (reason) {
    case 'embed_failed':
    case 'tenant_not_configured':
      return 'provider_error';
    default:
      return 'parse_failed';
  }
}

/**
 * U8's gate, deferring into the connector's own job lane.
 *
 * Only `kind` and `target` are rewritten; the trigger the gate chose survives,
 * because "why is this job here" is recorded rather than inferred and a user's
 * connect request is not a cadence tick. Everything else delegates, so this
 * wrapper cannot drift from the queue it wraps.
 *
 * What stops the placeholder target becoming a job nobody handles is the
 * database's own `job_target_suits_its_kind`, which admits only a connector
 * source for `ingest_pull` — not a check here, which would be a second copy of
 * a constraint that already exists.
 */
export function connectorGateQueue(
  queue: JobQueue,
  options: { readonly source: ConnectorSource; readonly trigger?: JobTrigger },
): JobQueue {
  return {
    enqueue(request) {
      return queue.enqueue({
        ...request,
        kind: 'ingest_pull',
        target: options.source,
        ...(options.trigger === undefined ? {} : { trigger: options.trigger }),
      });
    },
    claim: (request) => queue.claim(request),
    complete: (lease, request) => queue.complete(lease, request),
    fail: (lease, request) => queue.fail(lease, request),
    get: (jobId) => queue.get(jobId),
    reclaim: (request) => queue.reclaim(request),
    listDeadLetters: (request) => queue.listDeadLetters(request),
    clearDeadLetter: (jobId, request) => queue.clearDeadLetter(jobId, request),
  };
}

/**
 * The cadence trigger. It does **not** decide who is due across the fleet —
 * that is U10's scheduler, and this unit does not build a second one. What it
 * owns is the per-source predicate and the one enqueue that follows it.
 *
 * `already_open` is the queue's own answer, from the unique index, not a check
 * here: a caller-side "is one already running" is a check that ran before the
 * value it protects was used.
 *
 * **`paused` is checked before the cadence, and it is what makes U14's
 * `pause_source` a fact rather than a setting.** The caller supplies it — read
 * from `source_pause` via `readPausedSources` — rather than this function
 * opening the tenant database, because the scheduler already holds a connection
 * and reads every tenant's pause set once per sweep rather than once per source.
 * A user who paused their mailbox and watched it keep pulling would be right to
 * conclude the button does nothing, so this refusal is named in the outcome
 * rather than folded into `not_due`, which would make a pause look like a
 * cadence that had not come round yet.
 */
export async function enqueuePullIfDue(
  queue: JobQueue,
  request: {
    readonly tenantId: string;
    readonly state: ConnectorState;
    readonly now: Date;
    readonly trigger?: JobTrigger;
    /** True when U14's `source_pause` holds a row for this source. */
    readonly paused?: boolean;
  },
): Promise<
  EnqueueOutcome | { readonly enqueued: false; readonly reason: 'not_due' | 'paused' }
> {
  if (request.paused === true) return { enqueued: false, reason: 'paused' };
  if (!isPullDue(request.state, request.now)) return { enqueued: false, reason: 'not_due' };
  return queue.enqueue({
    tenantId: request.tenantId,
    kind: 'ingest_pull',
    target: request.state.source,
    trigger: request.trigger ?? 'connector_cadence',
    now: request.now,
  });
}

/**
 * The window this pull runs under.
 *
 * **A delta feed is not windowed, and that is the whole point of asking.** The
 * bounded window exists to cap a *first import* — a mailbox nobody has read
 * yet. A delta feed is already bounded by how much actually changed, so
 * windowing it buys no ceiling and costs the one thing a poller cannot recover:
 * the update is dropped **and** the cursor advances past it, so the provider
 * never offers that change again. The row is stale for good, and U11 then reads
 * it against its live replacement and reports a contradiction that never
 * happened.
 *
 * Widening does not rescue it either, because the item's timestamp is not the
 * edit's: a meeting held in March and annotated in August arrives dated March,
 * and every window is measured from `now`, so an item drifts out of one just by
 * the calendar moving.
 */
function windowFor(mode: PullMode, window: ImportWindow | undefined): ImportWindow {
  if (mode === 'delta') return 'all';
  return window ?? { days: DEFAULT_WINDOW_DAYS };
}

function windowBoundary(window: ImportWindow, now: Date): Date | null {
  if (window === 'all') return null;
  return new Date(now.getTime() - Math.max(0, window.days) * 24 * 60 * 60 * 1000);
}

function windowDaysOf(window: ImportWindow): number | null {
  return window === 'all' ? null : window.days;
}

export async function runPull(request: PullRequest): Promise<PullResult> {
  const { tenant, source, states } = request;
  const sourceType = SOURCE_TYPE_FOR[source.source];
  const interactive = request.interactive ?? true;
  const maxItems = request.maxItems ?? DEFAULT_MAX_ITEMS_PER_PULL;

  const counts: MutableCounts = { ...EMPTY_COUNTS };
  let attemptedItems = 0;
  let cursorInvalidated = false;
  let widen: PullResult['widen'] = {
    excludedItems: 0,
    windowDays: windowDaysOf(windowFor('backfill', request.window)),
    outsideWindow: null,
  };

  let state = await states.read(source.source);
  if (state === null) {
    // Not an error and not a silence: a job for a source nobody connected (or
    // one disconnected while the job sat in the queue) has nothing to do.
    return {
      outcome: 'refused',
      mode: 'backfill',
      runId: null,
      decision: null,
      estimate: null,
      counts,
      widen,
      attemptedItems,
      cursorAdvanced: false,
      cursorInvalidated,
      stopReason: 'not_connected',
    };
  }

  // **Read from the connection, not from the source name.** Which half of the
  // brain a connected account belongs to is the user's answer at connect, and it
  // is the whole difference between a `work:*` grant that can read this mailbox
  // and one that reads only the memories it wrote itself. Computed after the
  // state read for that reason: before it, there is no connection to ask.
  const originContext = originContextFor(source.source, state.contextClass);

  let mode = pullModeFor(state);

  /**
   * A staleness event: a terminal run row of its own, carrying zero items.
   * Separate from this pull's row because that row goes on to succeed — the
   * recovery is the point — and an event folded into a successful run is an
   * event no staleness display will ever show.
   */
  const logStalenessEvent = async (code: IngestFailureCode): Promise<void> => {
    const event = await openRun(tenant.sql, { originContext, sourceType });
    await finishRun(tenant.sql, event.ingestId, { outcome: 'failed', failureCode: code });
  };

  const run = await openRun(tenant.sql, { originContext, sourceType });

  /** What the listing said this account is, once it has said it. */
  let adoptedAccountKey: string | null = null;

  /** Stamp the attempt, advance the cursor if it was earned, drop a spent approval. */
  const saveState = async (nextCursorValue: ConnectorState['cursor']): Promise<boolean> => {
    const advanced = nextCursorValue !== null;
    const consumed = request.approvedMicroUsd !== undefined;
    state = {
      ...(state as ConnectorState),
      ...(adoptedAccountKey === null ? {} : { accountKey: adoptedAccountKey }),
      // Always stamped, success or failure: it is "when this source was last
      // checked", and a failing source that never stamps it is due on every
      // tick — a poll loop against a provider that is already unhappy.
      lastPullAt: request.now.toISOString(),
      ...(advanced ? { cursor: nextCursorValue } : {}),
      ...(consumed ? { backfill: null } : {}),
    };
    await states.write(state);
    return advanced;
  };

  const failRun = async (
    reason: PullStopReason,
    code: IngestFailureCode,
    extra: Partial<PullResult> = {},
  ): Promise<PullResult> => {
    await finishRun(tenant.sql, run.ingestId, { outcome: 'failed', failureCode: code });
    await saveState(null);
    return {
      outcome: 'failed',
      mode,
      runId: run.ingestId,
      decision: null,
      estimate: null,
      counts,
      widen,
      attemptedItems,
      cursorAdvanced: false,
      cursorInvalidated,
      stopReason: reason,
      ...extra,
    };
  };

  try {
    // ------------------------------------------------------------------
    // 1. List, and treat an expired cursor as a first-class path.
    // ------------------------------------------------------------------
    let window = windowFor(mode, request.window);
    let listing = await source.list({
      mode,
      cursor: state.cursor?.value ?? null,
      since: windowBoundary(window, request.now),
      maxItems,
      now: request.now,
      externalUserId: state.externalUserId,
      accountId: state.accountId,
      accountKey: state.accountKey,
    });

    if (!listing.ok && listing.reason === 'cursor_invalid') {
      cursorInvalidated = true;
      state = discardCursor(state, request.now);
      await states.write(state);
      await logStalenessEvent('provider_error');

      mode = 'backfill';
      // The recovery is a first import wearing a poller's clothes, so it picks
      // the window back up — including when the pull that expired was a delta.
      window = windowFor(mode, request.window);
      listing = await source.list({
        mode,
        // The whole point: recovery re-enters as a *bounded, gated* backfill,
        // not as a free re-list of the mailbox.
        cursor: null,
        since: windowBoundary(window, request.now),
        maxItems,
        now: request.now,
        externalUserId: state.externalUserId,
        accountId: state.accountId,
        accountKey: state.accountKey,
      });
    }

    if (!listing.ok) {
      // A token refresh failure lands here, and it lands as a row: a connector
      // that stops silently looks exactly like a connector with nothing to say.
      return await failRun(listing.reason, ingestCodeFor(listing.reason));
    }

    const listed = listing.page;

    // ------------------------------------------------------------------
    // 1a. **Whose mailbox is this?** Before the tombstone sweep, before the
    //     gate, before anything writes.
    //
    //     Provider ids are unique per account, not globally, so a connection
    //     re-pointed at a different Google account offers colliding ids — and
    //     every one of them would land as an *update* to the first account's
    //     page: their mail tombstoned and replaced by a stranger's, under the
    //     same origin, which is why the origin fence cannot see it. Running the
    //     check after the sweep would be worse still: the sweep would tombstone
    //     the first account's pages using the second's deletions.
    // ------------------------------------------------------------------
    const observedAccountKey = normalizeAccountKey(listed.accountKey ?? null);
    if (
      observedAccountKey !== null &&
      state.accountKey !== null &&
      observedAccountKey !== state.accountKey
    ) {
      await finishRun(tenant.sql, run.ingestId, {
        outcome: 'failed',
        failureCode: stopCodeFor('identity_changed'),
      });
      // The attempt is stamped, the cursor is not advanced, and the recorded
      // identity is **not** overwritten by whoever pulled last. Re-pointing a
      // connector at another account is a re-connect, not a poll.
      await saveState(null);
      return {
        outcome: 'refused',
        mode,
        runId: run.ingestId,
        decision: null,
        estimate: null,
        counts,
        widen,
        attemptedItems,
        cursorAdvanced: false,
        cursorInvalidated,
        stopReason: 'identity_changed',
      };
    }
    adoptedAccountKey = state.accountKey ?? observedAccountKey;

    // ------------------------------------------------------------------
    // 2. The junk gate — before the estimate, not merely before the write.
    //    A hidden item is priced at zero characters, so a newsletter backlog
    //    cannot inflate the approval it will never spend.
    // ------------------------------------------------------------------
    // The same seam the import runner reaches, so neither can drift from the
    // other about what junk is or about what a hidden item costs.
    const classified = gateJunk(listed.items);

    // ------------------------------------------------------------------
    // 2a. **The erasure tombstone — before the estimate, for the same reason
    //     the junk gate is.**
    //
    //     R12's subject erasure owes four properties and the fourth is
    //     "tombstoned against re-ingestion". Without this consult it is false on
    //     a cadence: the erasure *soft*-deletes her pages, U4's replacement
    //     lookup only finds live ones, so the next tick writes a brand-new page
    //     about the correspondent whose receipt says this brain holds nothing
    //     about her — within the hour, and with the receipt already handed to a
    //     third party.
    //
    //     Ahead of the meter because an item that will never be written must not
    //     price the approval. `src/ingest/erased-subjects.ts` states what the
    //     digest-only tombstone can and cannot reach.
    // ------------------------------------------------------------------
    const suppression = await partitionErasedSubjects(tenant.sql, classified);
    for (const entry of suppression.suppressed) {
      counts.suppressed += 1;
      await countRunItem(tenant.sql, run.ingestId, { written: 0, quarantined: 0 });
      await recordItem(tenant.sql, {
        originContext,
        sourceType,
        externalRef: entry.item.externalRef,
        disposition: 'suppressed',
      });
    }
    // **Not `incomplete`.** A suppression is a stable fact about the item — the
    // same class as an empty document — so the cursor moves past it. Holding it
    // would wedge the source forever on a message that is never going to become
    // ingestable, and the provider would offer it again on every tick for as
    // long as the erasure stands.
    const admitted = suppression.kept;

    const candidates: ImportCandidate[] = admitted.map((entry) => ({
      externalRef: entry.item.externalRef,
      contentSha256: contentDigest(entry.item.title, entry.item.body),
      occurredAt: entry.item.occurredAt,
      characters: entry.characters,
    }));

    // ------------------------------------------------------------------
    // 3. One item set: the estimate's and the loop's. Two walks is how a gate
    //    approves 1,200 items and imports 40,000.
    // ------------------------------------------------------------------
    const selection = selectWindow(candidates, { now: request.now, window });
    widen = {
      excludedItems: selection.excluded.length,
      windowDays: selection.windowDays,
      outsideWindow: listed.outsideWindow,
    };

    const selected = new Set(selection.selected.map((candidate) => candidate.externalRef));
    const items = admitted.filter((entry) => selected.has(entry.item.externalRef));

    // ------------------------------------------------------------------
    // 4. Deletions, **before the gate**.
    //
    // A tombstone costs no provider call, so nothing about the ceiling has an
    // opinion on it — and a refused pull that skipped the sweep would leave a
    // cancelled meeting answering queries until the tenant's thirty-day spend
    // window rolls. Worse than late: if the sync cursor expires in the
    // meantime, the recovery re-list carries no tombstones at all (a backfill
    // enumerates what exists, never what is gone) and that deletion is lost
    // permanently. It is the stale row U11 reports against its replacement as
    // a genuine contradiction, produced by the spend gate.
    // ------------------------------------------------------------------
    if (listed.tombstones.length > 0) {
      const swept = await tombstoneRefs(tenant.sql, {
        originContext,
        externalRefs: listed.tombstones.map((tombstone) => tombstone.externalRef),
      });
      counts.tombstoned = swept.tombstoned;
      for (const externalRef of swept.externalRefs) {
        await countRunItem(tenant.sql, run.ingestId, { written: 0, quarantined: 0 });
        await recordItem(tenant.sql, {
          originContext,
          sourceType,
          externalRef,
          disposition: 'tombstoned',
        });
      }
    }

    // ------------------------------------------------------------------
    // 5. The gate. Skipped only when this run carries an approval the gate
    //    already made — but the *amount* is re-read, because a deferral
    //    reserved nothing and the cap may have gone elsewhere since.
    // ------------------------------------------------------------------
    let decision: GateDecision | null = null;
    let estimate: ImportEstimate | null = null;
    let approvedMicroUsd: number;

    if (request.approvedMicroUsd !== undefined) {
      const clamp = await clampApproval({
        control: request.control,
        tenantId: tenant.tenantId,
        approvedMicroUsd: request.approvedMicroUsd,
        now: request.now,
      });
      if (!clamp.ok) {
        await finishRun(tenant.sql, run.ingestId, {
          outcome: 'failed',
          failureCode: clamp.reason === 'cap_exhausted' ? 'budget_exhausted' : 'cancelled',
        });
        await saveState(null);
        return {
          outcome: 'refused',
          mode,
          runId: run.ingestId,
          decision: { proceed: 'refused', reason: clamp.reason, headroom: clamp.headroom },
          estimate,
          counts,
          widen,
          attemptedItems,
          cursorAdvanced: false,
          cursorInvalidated,
        };
      }
      approvedMicroUsd = clamp.approvedMicroUsd;
    } else {
      const estimated = await estimateImport({
        sql: tenant.sql,
        profile: request.profile,
        candidates: selection.selected,
        ...(request.priceBook === undefined ? {} : { priceBook: request.priceBook }),
      });
      if (!estimated.ok) {
        return await failRun('model_not_priced', 'provider_error');
      }
      estimate = estimated.estimate;

      const gateQueue =
        request.queue === undefined
          ? undefined
          : connectorGateQueue(request.queue, { source: source.source });

      decision = await gateFirstImport({
        control: request.control,
        tenantId: tenant.tenantId,
        target: GATE_PLACEHOLDER_TARGET,
        estimate,
        now: request.now,
        ...(gateQueue === undefined ? {} : { queue: gateQueue }),
        // Inside the background job there is nowhere to defer to: the lane is
        // held by this very job, so a deferral would come back `already_open`
        // and the connector would never backfill. The budget is the bound.
        ...(interactive
          ? {
              ...(request.inlineItemCeiling === undefined
                ? {}
                : { inlineItemCeiling: request.inlineItemCeiling }),
              ...(request.inlineSpendCeiling === undefined
                ? {}
                : { inlineSpendCeiling: request.inlineSpendCeiling }),
            }
          : {
              inlineItemCeiling: Number.MAX_SAFE_INTEGER,
              inlineSpendCeiling: Number.MAX_SAFE_INTEGER,
            }),
        ...(request.jobId === undefined ? {} : { jobId: request.jobId }),
      });

      if (decision.proceed === 'refused') {
        await finishRun(tenant.sql, run.ingestId, {
          outcome: 'failed',
          failureCode: decision.reason === 'cap_exhausted' ? 'budget_exhausted' : 'cancelled',
        });
        await saveState(null);
        return {
          outcome: 'refused',
          mode,
          runId: run.ingestId,
          decision,
          estimate,
          counts,
          widen,
          attemptedItems,
          cursorAdvanced: false,
          cursorInvalidated,
        };
      }

      if (decision.proceed === 'deferred') {
        // The approval is banked on the connector state, keyed by the job that
        // may spend it. `control.job` is content-free and cannot carry an
        // argument, which is the same reason U8 keys its manifest by job id.
        state = {
          ...state,
          lastPullAt: request.now.toISOString(),
          backfill: {
            jobId: decision.jobId,
            approvedMicroUsd: decision.approvedMicroUsd,
            // What a *backfill* would use, not what this pull used. A delta
            // pull runs unwindowed, and banking that as `null` would hand the
            // resumed job an all-time window — which becomes an unbounded
            // re-list the moment its cursor expires, through the one door this
            // whole module exists to keep shut.
            windowDays: windowDaysOf(windowFor('backfill', request.window)),
          },
        };
        await states.write(state);
        await finishRun(tenant.sql, run.ingestId, { outcome: 'ok' });
        return {
          outcome: 'deferred',
          mode,
          runId: run.ingestId,
          decision,
          estimate,
          counts,
          widen,
          attemptedItems,
          cursorAdvanced: false,
          cursorInvalidated,
        };
      }

      approvedMicroUsd = decision.approvedMicroUsd;
    }

    // ------------------------------------------------------------------
    // 6. **One** budget, from the approved amount, for the whole run. This
    //    line is the gate; a fresh budget per item makes every ceiling above
    //    it decoration.
    // ------------------------------------------------------------------
    const budget = createBudget({
      label: `pull:${source.source}`,
      capMicroUsd: approvedMicroUsd,
    });

    // ------------------------------------------------------------------
    // 7. What the provider offered but could not be turned into an item. U4's
    //    counter only advances for what it accepted, so these are counted here
    //    or a run that half-read a mailbox reports a clean pull.
    // ------------------------------------------------------------------
    /**
     * The run did not do all its work, and re-running is the remedy.
     *
     * Kept apart from {@link halted}: a lost item does not stop the rest of the
     * page from importing, and the chunk pass still has to drain what *was*
     * written. What it does do is hold the cursor — see step 10.
     */
    let incomplete: PullStopReason | undefined;

    for (const failure of listed.failures) {
      counts.failed += 1;
      // **A retryable refusal holds the cursor.** Counted-and-forgotten is how
      // a 429 becomes a permanent hole: the run closes `ok`, the cursor moves
      // past the message, and the provider never offers that change again.
      if (failure.retryable) incomplete ??= reasonForCode(failure.reason);
      await countRunItem(tenant.sql, run.ingestId, { written: 0, quarantined: 0 });
      if (failure.externalRef !== null) {
        await recordItem(tenant.sql, {
          originContext,
          sourceType,
          externalRef: failure.externalRef,
          disposition: 'failed',
          failureCode: failure.reason,
        });
      }
    }

    // ------------------------------------------------------------------
    // 7a. The objects this listing carried.
    //
    // Behind the gate and ahead of the items, for the reasons `import/run.ts`
    // step 7 states: acceptance issues no provider call, so it must not be
    // starved by an item loop that ran out of embedding money, and a refused
    // pull stores nothing at all.
    //
    // **Which refusals hold the cursor is the decision no later pull can
    // correct.** A provider offers a change once. If the cursor steps over an
    // object the object *store* refused, that file is never offered again and
    // the user's screenshot is gone from the brain for good — so a failure
    // about us holds, and a failure about the file (an unreadable type, an
    // empty payload, something over the ceiling) does not, because asking again
    // produces the identical refusal and holding would wedge the source.
    // `mediaFailureFor` is the single place that tells them apart.
    // ------------------------------------------------------------------
    for (const { item, quarantine } of gateJunk(
      (listed.media ?? []).map((entry) => ({ ...entry, body: '' })),
    )) {
      if (request.storage === undefined || request.rawStore === undefined) {
        // Objects offered and nowhere to put them. A row each and the cursor
        // holds: this is a fact about how the fleet is wired, and the file is
        // still there to be fetched once it is wired right.
        counts.failed += 1;
        incomplete ??= 'provider_error';
        await countRunItem(tenant.sql, run.ingestId, { written: 0, quarantined: 0 });
        await recordItem(tenant.sql, {
          originContext,
          sourceType,
          externalRef: item.externalRef,
          disposition: 'failed',
          failureCode: 'provider_error',
        });
        continue;
      }

      const outcome = await acceptMedia(
        { sql: tenant.sql, storage: request.storage, store: request.rawStore },
        {
          tenantId: tenant.tenantId,
          caller: tenant.caller,
          originContext,
          mediaType: item.mediaType,
          bytes: item.bytes,
          externalId: item.externalRef,
          quarantine,
        },
      );

      if (!outcome.ok) {
        const failure = mediaFailureFor(outcome.reason);
        counts.failed += 1;
        if (failure.retryable) incomplete ??= 'provider_error';
        await countRunItem(tenant.sql, run.ingestId, { written: 0, quarantined: 0 });
        await recordItem(tenant.sql, {
          originContext,
          sourceType,
          externalRef: item.externalRef,
          disposition: 'failed',
          failureCode: failure.code,
        });
        continue;
      }

      counts.attachments += 1;
      const disposition =
        outcome.status === 'unchanged'
          ? 'unchanged'
          : quarantine !== null
            ? 'quarantined'
            : 'written';
      // `acceptMedia` advances no counter of its own, unlike `ingestDocument`.
      // Without this the run row reports a clean pull of a Drive whose every
      // image it refused.
      await countRunItem(tenant.sql, run.ingestId, {
        written: disposition === 'written' ? 1 : 0,
        quarantined: disposition === 'quarantined' ? 1 : 0,
      });
      await recordItem(tenant.sql, {
        originContext,
        sourceType,
        externalRef: item.externalRef,
        disposition,
      });
    }

    // ------------------------------------------------------------------
    // 8. The items.
    // ------------------------------------------------------------------
    /** Processing stopped part-way, so nothing after this point should run. */
    let halted: PullStopReason | undefined;

    for (const { item, verdict, quarantine } of items) {
      attemptedItems += 1;

      const receipt = await ingestDocument(
        {
          sql: tenant.sql,
          gateway: tenant.gateway,
          tenantId: tenant.tenantId,
          caller: tenant.caller,
          budget,
        },
        {
          originContext,
          sourceType,
          title: item.title,
          body: item.body,
          externalRef: item.externalRef,
          ingestId: run.ingestId,
          // Calendar's is the event *start*, which is the whole reason the
          // briefing can ask "what is happening today" rather than "what
          // arrived today". Provider-asserted, so it orders and windows and
          // decides nothing about access.
          occurredAt: item.occurredAt,
          quarantine,
        },
      );

      if (!receipt.ok) {
        if (receipt.reason === 'embed_failed' && receipt.detail === 'budget_exhausted') {
          // Stop. Collecting one identical refusal per remaining item is the
          // same defect wearing a loop, and re-running costs nothing for what
          // was already written.
          halted = 'budget_exhausted';
          break;
        }
        counts.failed += 1;
        // The fetch worked and the write did not, for a reason that has nothing
        // to do with this item's content. Same rule as a refused fetch.
        if (writeLossIsRetryable(receipt.reason)) incomplete ??= 'provider_error';
        await countRunItem(tenant.sql, run.ingestId, { written: 0, quarantined: 0 });
        await recordItem(tenant.sql, {
          originContext,
          sourceType,
          externalRef: item.externalRef,
          disposition: 'failed',
          failureCode: writeCodeFor(receipt.reason),
        });
        continue;
      }

      if (receipt.status === 'unchanged') {
        counts.unchanged += 1;
        await recordItem(tenant.sql, {
          originContext,
          sourceType,
          externalRef: item.externalRef,
          disposition: 'unchanged',
        });
        continue;
      }

      if (quarantine !== null) counts.quarantined += 1;
      else {
        counts.written += 1;
        if (verdict.visibility === 'warned') counts.warned += 1;
      }

      await recordItem(tenant.sql, {
        originContext,
        sourceType,
        externalRef: item.externalRef,
        disposition: quarantine !== null ? 'quarantined' : 'written',
      });
    }

    // ------------------------------------------------------------------
    // 9. The chunk pass the estimate priced. U4 defers it by design, so a
    //    runner that only writes pages leaves the gate bounding work that
    //    never happens. Quarantined chunks are not in this backlog — which is
    //    the structural half of "the junk gate runs before the meter".
    // ------------------------------------------------------------------
    if (halted === undefined) {
      const backlog = await runChunkEmbedBacklog({
        sql: tenant.sql,
        gateway: tenant.gateway,
        tenantId: tenant.tenantId,
        caller: tenant.caller,
        budget,
      });
      if (backlog.failure === 'budget_exhausted') halted = 'budget_exhausted';
      // Any other backlog failure leaves chunks unembedded. The rows survive
      // (the backlog is a query over `embedding IS NULL`, not a promise this
      // process holds), so nothing is lost — but a run that closed `ok` over it
      // is a brain reporting itself indexed when it is not.
      else if (backlog.failure !== undefined) incomplete ??= 'provider_error';
    }

    // ------------------------------------------------------------------
    // 10. The cursor — last, and only over work that is banked.
    // ------------------------------------------------------------------
    // **Only over work that is banked, and only when nothing was lost.** A
    // cursor that steps over a retryable refusal is the one mistake in this file
    // that no later pull can correct: the provider offers a change once.
    const nextCursor =
      halted === undefined && incomplete === undefined && listed.nextCursor !== null
        ? {
            kind: listed.nextCursor.kind,
            value: listed.nextCursor.value,
            issuedAt: request.now.toISOString(),
          }
        : null;
    const cursorAdvanced = await saveState(nextCursor);

    const stopReason = halted ?? incomplete;
    if (stopReason !== undefined) {
      await finishRun(tenant.sql, run.ingestId, {
        outcome: 'failed',
        failureCode: stopCodeFor(stopReason),
      });
      return {
        outcome: 'stopped',
        mode,
        runId: run.ingestId,
        decision,
        estimate,
        counts,
        widen,
        attemptedItems,
        cursorAdvanced,
        cursorInvalidated,
        stopReason,
      };
    }

    await finishRun(tenant.sql, run.ingestId, { outcome: 'ok' });
    return {
      outcome: 'completed',
      mode,
      runId: run.ingestId,
      decision,
      estimate,
      counts,
      widen,
      attemptedItems,
      cursorAdvanced,
      cursorInvalidated,
    };
  } catch (error) {
    // A run row left `running` makes U6 report an ingest in flight forever, so
    // an unexpected throw closes it on the way out — and then propagates,
    // because a swallowed exception is a job that reports success.
    await finishRun(tenant.sql, run.ingestId, {
      outcome: 'failed',
      failureCode: 'provider_error',
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The `ingest_pull` handler.
// ---------------------------------------------------------------------------

/**
 * One attempt at one source, in the vocabulary each layer already owns.
 *
 * **Two code columns, and neither vocabulary is new.** `ingestFailureCode` is
 * `ingest_log.failure_code`'s (`src/ingest/log.ts`) — the run reached the
 * provider and something said no. `jobFailureCode` is `control.job`'s
 * (`src/worker/jobs.ts`) — there was no run to have a code, so the only thing
 * that can be said is what the runner would say. A third vocabulary invented
 * here would be the thing that makes a failure untranslatable between the log,
 * the queue and the page.
 *
 * **What is deliberately absent: anything a user wrote.** No subject, no sender,
 * no snippet, not the provider's id for the item, and no error message. Counts,
 * codes and an instant. The control-plane column types refuse the rest a second
 * time, but this type is where it stops being possible to try.
 */
export interface ConnectorAttempt {
  readonly tenantId: string;
  readonly source: ConnectorSource;
  readonly at: Date;
  /** What the pull said it did. Null when no pull produced a result. */
  readonly runOutcome: PullOutcome | null;
  readonly ingestFailureCode: IngestFailureCode | null;
  readonly jobFailureCode: JobFailureCode | null;
  readonly itemsWritten: number;
  readonly itemsFailed: number;
}

/**
 * Where the attempt goes, as a port.
 *
 * **Required rather than optional**, which is the opposite of {@link
 * PullHandlerDeps.onResult} and deliberately so. `onResult` is a live
 * notification a deployment may not want; this is the only durable record of
 * *why* a poll failed that anything outside the tenant's own database can read,
 * and a deployment that composed the handler without one would be back to the
 * state this port exists to end — a failure whose cause is written to container
 * stdout and nowhere else. An absent-able dependency is a dependency somebody
 * forgets to wire, and this codebase has paid for that shape more than once.
 *
 * Implementations must not throw: see `src/control/connector-health.ts`. A
 * record of an attempt that already happened is never worth failing the job for.
 */
export interface ConnectorHealthRecorder {
  record(attempt: ConnectorAttempt): Promise<void>;
}

/**
 * A pull that reached the provider and was refused.
 *
 * The job row records this as `handler_error` and that is correct rather than
 * lazy: from the runner's side a handler threw, and `control.job.failure_code`
 * is the runner's vocabulary. The *cause* — which of the provider's refusals it
 * was, or that a budget stopped it — is on the health record, in the ingest
 * log's vocabulary, written before this is thrown.
 */
export class IngestPullFailure extends Error {
  readonly source: ConnectorSource;
  readonly stopReason: PullStopReason | 'unknown';
  /** The ingest-log code the run recorded for itself. */
  readonly failureCode: IngestFailureCode;

  constructor(source: ConnectorSource, stopReason: PullStopReason | undefined) {
    const reason = stopReason ?? 'unknown';
    super(`ingest_pull for '${source}' failed against the provider: ${reason}`);
    this.name = 'IngestPullFailure';
    this.source = source;
    this.stopReason = reason;
    this.failureCode = stopReason === undefined ? 'provider_error' : stopCodeFor(stopReason);
  }
}

/**
 * The brain this job is for could not be opened.
 *
 * **The distinction this exists to make.** Before it, an unreachable tenant
 * database and a bug in the pull path were the same `handler_error` on the job
 * row, and the two have opposite remedies: one is a substrate incident that will
 * clear on its own and must not be chased, the other is ours and will not.
 * `tenant_unavailable` has been in `JOB_FAILURE_CODES` since U10 and nothing
 * ever wrote it.
 *
 * The message names the tenant and the source and nothing else; the original is
 * carried as `cause`, for the fleet's own stderr, because a connection failure's
 * text is the ordinary way a DSN travels.
 */
export class TenantUnreachableError extends Error {
  readonly jobFailureCode = 'tenant_unavailable' as const;
  readonly tenantId: string;

  constructor(tenantId: string, source: ConnectorSource, cause: unknown) {
    super(`the brain for '${tenantId}' could not be opened to poll '${source}'`, { cause });
    this.name = 'TenantUnreachableError';
    this.tenantId = tenantId;
  }
}

/** The attempt a finished pull describes. */
export function attemptFor(
  lease: { readonly tenantId: string },
  source: ConnectorSource,
  at: Date,
  result: PullResult,
): ConnectorAttempt {
  // A completed run has nothing to explain, and the control plane's CHECK
  // refuses a row that claims otherwise. Derived here rather than trusted,
  // because a code left on a recovered connector is a red line nobody can clear.
  const failed = result.outcome !== 'completed' && result.stopReason !== undefined;
  return {
    tenantId: lease.tenantId,
    source,
    at,
    runOutcome: result.outcome,
    ingestFailureCode: failed ? stopCodeFor(result.stopReason as PullStopReason) : null,
    jobFailureCode: null,
    itemsWritten: result.counts.written,
    itemsFailed: result.counts.failed,
  };
}

export interface PullHandlerDeps {
  readonly control: SQL;
  readonly profile: NamedProfile;
  /** Opens the tenant's database and gateway. Closed again by {@link PullHandlerDeps.closeTenant}. */
  readonly openTenant: (tenantId: string) => Promise<TenantRuntime>;
  readonly closeTenant?: (runtime: TenantRuntime) => Promise<void>;
  /**
   * The adapter and the state store for this tenant and source. Injected
   * because only the caller knows how a tenant's credential becomes a client —
   * and because Phase 5's own-OAuth swap replaces exactly this function.
   */
  readonly openSource: (
    tenant: TenantRuntime,
    source: ConnectorSource,
  ) => Promise<{ readonly source: ProviderSource; readonly states: ConnectorStateStore }>;
  /**
   * Where an object goes. Threaded through, because a handler that opened a
   * source capable of offering media and then ran it with nowhere to put the
   * bytes would be the same "built but never reached" shape the media path
   * already spent a unit in: every screenshot a failure row, forever.
   */
  readonly storage?: TenantStorage;
  readonly rawStore?: RawStore;
  readonly priceBook?: PriceBook;
  readonly maxItems?: number;
  /**
   * Where the pull's own result goes.
   *
   * Without it the handler computes `counts.failed`, `stopReason` and the widen
   * numbers and hands them to nobody — the one place in the fleet that knows a
   * pull lost forty messages drops the fact on the floor. The durable record is
   * still the ingest log; this is the live one, for whatever composes the fleet.
   */
  readonly onResult?: (result: PullResult, lease: JobLease) => void | Promise<void>;
  /**
   * Where the attempt's own outcome is banked, so "why is my mail not arriving"
   * has an answer that does not need a shell on the container. See {@link
   * ConnectorHealthRecorder} for why this one is not optional.
   */
  readonly health: ConnectorHealthRecorder;
}

/**
 * Exported and not wired: `src/worker/` is U10's, and the handler map is
 * assembled where the fleet is composed.
 *
 * It never touches the queue — U10's runner completes or fails the job around
 * this call, and a handler that also wrote job state would be a second writer
 * outside the fence.
 */
export function createIngestPullHandler(
  deps: PullHandlerDeps,
): (context: JobContext) => Promise<void> {
  return async (context: JobContext): Promise<void> => {
    const { lease } = context;
    if (!isConnectorSource(lease.target)) {
      // Not an attempt at a connector — it names a target no connector has — so
      // there is no source whose health this could be recorded against.
      throw new Error(`ingest_pull handler claimed a job targeting '${lease.target}'`);
    }
    const source = lease.target;

    /**
     * **Exactly one health record per attempt.** The failure path below rethrows
     * after recording, and the catch has to be able to tell "this attempt has
     * already said what happened" from "this attempt died before it could". A
     * flag rather than an `instanceof`, because the throws it must not
     * double-record are not all of one type.
     */
    let recorded = false;
    const record = async (attempt: ConnectorAttempt): Promise<void> => {
      recorded = true;
      await deps.health.record(attempt);
    };

    let tenant: TenantRuntime;
    try {
      tenant = await deps.openTenant(lease.tenantId);
    } catch (error) {
      // Outside the try below on purpose: there is no tenant handle to close,
      // and this is the one failure whose cause the job row can carry on its own.
      await record({
        tenantId: lease.tenantId,
        source,
        at: context.now,
        runOutcome: null,
        ingestFailureCode: null,
        jobFailureCode: 'tenant_unavailable',
        itemsWritten: 0,
        itemsFailed: 0,
      });
      throw new TenantUnreachableError(lease.tenantId, source, error);
    }

    try {
      const opened = await deps.openSource(tenant, lease.target);
      const state = await opened.states.read(lease.target);

      // An approval belongs to the job that was deferred, and to no other. A
      // handler that spent whichever approval it found would let one deferral
      // fund every later pull.
      const banked = state?.backfill?.jobId === lease.jobId ? state.backfill : null;

      const result = await runPull({
        tenant,
        control: deps.control,
        profile: deps.profile,
        source: opened.source,
        states: opened.states,
        now: context.now,
        interactive: false,
        jobId: lease.jobId,
        ...(deps.storage === undefined ? {} : { storage: deps.storage }),
        ...(deps.rawStore === undefined ? {} : { rawStore: deps.rawStore }),
        ...(banked === null
          ? {}
          : {
              approvedMicroUsd: banked.approvedMicroUsd,
              window: banked.windowDays === null ? 'all' : { days: banked.windowDays },
            }),
        ...(deps.priceBook === undefined ? {} : { priceBook: deps.priceBook }),
        ...(deps.maxItems === undefined ? {} : { maxItems: deps.maxItems }),
      });

      await deps.onResult?.(result, lease);
      // Before the throw below, not after: the record of *why* is the whole
      // point, and a failure that threw its way past this would be the state
      // this port exists to end.
      await record(attemptFor(lease, source, context.now, result));

      // **A pull that never reached the provider is not a job that succeeded.**
      // Returning quietly marks the job complete, and the source then waits a
      // full cadence before anyone asks again — while a revoked grant or a
      // rate-limited listing is exactly the condition a backed-off retry
      // exists for. A `stopped` run is *not* thrown on: its cursor is held, its
      // work is banked, and the next tick resumes it without a retry budget.
      if (result.outcome === 'failed') throw new IngestPullFailure(source, result.stopReason);
    } catch (error) {
      // Everything that did not get as far as a result: the source seam refusing,
      // the runner losing its lease mid-pull, a bug in this path. `handler_error`
      // is honest about all three — the alternative is a code invented here that
      // means "we do not know", which is what `handler_error` already means.
      if (!recorded) {
        await record({
          tenantId: lease.tenantId,
          source,
          at: context.now,
          runOutcome: null,
          ingestFailureCode: null,
          jobFailureCode: 'handler_error',
          itemsWritten: 0,
          itemsFailed: 0,
        });
      }
      throw error;
    } finally {
      await deps.closeTenant?.(tenant);
    }
  };
}

export type { EnqueueRefusal };
