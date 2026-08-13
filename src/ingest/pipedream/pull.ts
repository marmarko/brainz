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
import { runChunkEmbedBacklog } from '../../core/write/embed.ts';
import {
  contentDigest,
  ingestDocument,
  type WriteFailureReason,
} from '../../core/write/write-path.ts';
import type {
  EnqueueOutcome,
  EnqueueRefusal,
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
import { classifyJunk, quarantineMarkerFor, type JunkVerdict } from '../junk.ts';
import { countRunItem, finishRun, openRun, recordItem, type IngestFailureCode } from '../log.ts';
import type { TenantRuntime } from '../import/run.ts';
import type { PullFailureReason } from './client.ts';
import { tombstoneRefs } from './tombstone.ts';
import type { ProviderSource, PulledItem } from './sources/types.ts';

/**
 * R15's origin, credential-derived and immutable: the vendor and the source
 * that fetched the item. Every page, chunk and fact this unit writes carries
 * it, and it is what scopes the tombstone sweep.
 */
export function originContextFor(source: ConnectorSource): string {
  return `pipedream:${source}`;
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
}

export interface PullResult {
  readonly outcome: 'completed' | 'stopped' | 'deferred' | 'refused' | 'failed';
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
};

interface MutableCounts {
  written: number;
  unchanged: number;
  quarantined: number;
  warned: number;
  failed: number;
  tombstoned: number;
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
 */
export async function enqueuePullIfDue(
  queue: JobQueue,
  request: {
    readonly tenantId: string;
    readonly state: ConnectorState;
    readonly now: Date;
    readonly trigger?: JobTrigger;
  },
): Promise<EnqueueOutcome | { readonly enqueued: false; readonly reason: 'not_due' }> {
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
  const originContext = originContextFor(source.source);
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
    const classified: Array<{ item: PulledItem; verdict: JunkVerdict }> = listed.items.map(
      (item) => ({ item, verdict: classifyJunk(item.junk ?? {}) }),
    );

    const candidates: ImportCandidate[] = classified.map(({ item, verdict }) => ({
      externalRef: item.externalRef,
      contentSha256: contentDigest(item.title, item.body),
      occurredAt: item.occurredAt,
      characters: verdict.visibility === 'hidden' ? 0 : item.body.length,
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
    const items = classified.filter((entry) => selected.has(entry.item.externalRef));

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
    // 8. The items.
    // ------------------------------------------------------------------
    /** Processing stopped part-way, so nothing after this point should run. */
    let halted: PullStopReason | undefined;

    for (const { item, verdict } of items) {
      attemptedItems += 1;
      const quarantine = quarantineMarkerFor(verdict);

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
      throw new Error(`ingest_pull handler claimed a job targeting '${lease.target}'`);
    }

    const tenant = await deps.openTenant(lease.tenantId);
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

      // **A pull that never reached the provider is not a job that succeeded.**
      // Returning quietly marks the job complete, and the source then waits a
      // full cadence before anyone asks again — while a revoked grant or a
      // rate-limited listing is exactly the condition a backed-off retry
      // exists for. A `stopped` run is *not* thrown on: its cursor is held, its
      // work is banked, and the next tick resumes it without a retry budget.
      if (result.outcome === 'failed') {
        throw new Error(
          `ingest_pull for '${lease.target}' failed against the provider: ${result.stopReason ?? 'unknown'}`,
        );
      }
    } finally {
      await deps.closeTenant?.(tenant);
    }
  };
}

export type { EnqueueRefusal };
