/**
 * Connector state: the cursor, the cadence, and the one predicate that decides
 * whether a pull is a delta or a first import (U9 approach 2, 2a).
 *
 * **Cursor expiry is a first-class path, because providers force it.** Google
 * Calendar answers `410 GONE` on an expired sync token and mandates a full
 * re-sync; Gmail's history window expires the same way. Any tenant whose
 * polling stalls long enough — spend cap hit, poison-job quarantine, token
 * revoked and later restored — can only resume with a full re-list. That is
 * precisely the unbounded first import U8's gate exists to prevent, arriving
 * through a door marked "routine poll".
 *
 * So the whole module turns on {@link pullModeFor}, and it is written to fail
 * **closed**: anything other than a present, non-blank, `delta`-kind cursor is
 * a backfill, and a backfill is gated. A missing cursor, an empty string, a
 * truncated state file, a continuation token from a half-finished first import
 * — every one of them reads as "estimate this and ask the gate", because the
 * alternative reads as "re-list the mailbox for free".
 *
 * **Two cursor kinds, and the distinction is the gate.** A `delta` cursor is a
 * provider sync token: the next pull fetches only what changed, which is
 * bounded by how much actually changed. A `backfill` cursor is the
 * continuation token of a first import that stopped part-way; the next slice is
 * re-estimated and re-gated, which costs nothing extra because U4 is a no-op on
 * everything already held and the delta-aware estimate prices exactly that.
 *
 * **Where this record lives.** Not in the control plane, which is content-free
 * by construction and cannot hold a provider token; not in the tenant schema,
 * whose rungs are U3's and append-only. It goes in the tenant's own object
 * prefix beside the raw payloads, through the same accessor
 * (`src/control/storage.ts`) that derives every other key — and it is
 * **validated on read, never cast**, for the reason U8's manifest is: a worker
 * spends money on what this record says.
 *
 * **Ordering, and why a non-transactional store is sound here.** The cursor is
 * advanced only *after* the items it covers are banked. A crash in between
 * re-pulls items the brain already holds, which U4 answers with `unchanged` at
 * zero provider cost. The opposite order — advance, then import — silently
 * skips whatever was in flight, and nothing downstream can tell.
 */

import type { CallerIdentity } from '../control/secrets.ts';
import type { TenantStorage } from '../control/storage.ts';
import type { SourceType } from '../core/write/write-path.ts';
import type { RawObject, RawStore } from './import/raw.ts';

/**
 * The three alpha sources. Deliberately the same three strings as U10's
 * `ingest_pull` job targets — a connector whose name is not a legal job target
 * cannot be scheduled, and discovering that at enqueue time is a constraint
 * violation on a live tenant.
 */
export const CONNECTOR_SOURCES = ['gmail', 'calendar', 'drive'] as const;
export type ConnectorSource = (typeof CONNECTOR_SOURCES)[number];

export function isConnectorSource(value: string): value is ConnectorSource {
  return (CONNECTOR_SOURCES as readonly string[]).includes(value);
}

/** What each source's items are, in U4's vocabulary. */
export const SOURCE_TYPE_FOR: Readonly<Record<ConnectorSource, SourceType>> = {
  gmail: 'email',
  calendar: 'calendar',
  drive: 'document',
};

/**
 * Polling cadence, declared at connect and feeding staleness (KTD6's accepted
 * cost: polling, not webhooks). Mail moves fastest and is the one a user
 * notices; documents move slowest and are the most expensive to re-list.
 */
export const DEFAULT_CADENCE_SECONDS: Readonly<Record<ConnectorSource, number>> = {
  gmail: 300,
  calendar: 900,
  drive: 1800,
};

/**
 * The floor, and it is the per-source rate budget expressed as a schedule: a
 * caller asking for a one-second cadence is asking to be rate-limited by the
 * vendor, on every tenant at once.
 */
export const MIN_CADENCE_SECONDS = 60;

export function normalizeCadenceSeconds(source: ConnectorSource, requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_CADENCE_SECONDS[source];
  return Math.max(MIN_CADENCE_SECONDS, Math.trunc(requested));
}

export const CURSOR_KINDS = ['delta', 'backfill'] as const;
export type CursorKind = (typeof CURSOR_KINDS)[number];

export interface SourceCursor {
  /** `delta` resumes a sync; `backfill` continues a first import, still gated. */
  readonly kind: CursorKind;
  /** The provider's own opaque token. Never parsed, never joined to a key. */
  readonly value: string;
  readonly issuedAt: string;
}

/**
 * A backfill the gate deferred to a background job: what it approved, and which
 * job may spend it. This is the connector's manifest — U8 keys its own by job
 * id in object storage for the same reason, and the reason is that
 * `control.job` is content-free and cannot carry an argument.
 */
export interface PendingBackfill {
  readonly jobId: string;
  readonly approvedMicroUsd: number;
  /** Null means the caller widened to all time. */
  readonly windowDays: number | null;
}

export interface ConnectorState {
  readonly source: ConnectorSource;
  /** Pipedream's `external_user_id`. The scope every minted token carries. */
  readonly externalUserId: string;
  /** The connected account, once a claim has been redeemed. */
  readonly accountId: string | null;
  readonly cadenceSeconds: number;
  readonly cursor: SourceCursor | null;
  readonly connectedAt: string;
  readonly lastPullAt: string | null;
  /** When a provider last told us the cursor was gone. Feeds staleness. */
  readonly lastCursorInvalidatedAt: string | null;
  readonly backfill: PendingBackfill | null;
}

export function connectSource(input: {
  readonly source: ConnectorSource;
  readonly externalUserId: string;
  readonly accountId?: string | null;
  readonly cadenceSeconds?: number;
  readonly now: Date;
}): ConnectorState {
  return {
    source: input.source,
    externalUserId: input.externalUserId,
    accountId: input.accountId ?? null,
    cadenceSeconds: normalizeCadenceSeconds(input.source, input.cadenceSeconds),
    cursor: null,
    connectedAt: input.now.toISOString(),
    lastPullAt: null,
    lastCursorInvalidatedAt: null,
    backfill: null,
  };
}

export type PullMode = 'delta' | 'backfill';

/**
 * **The guard.** Anything that is not a live delta cursor is a first import.
 *
 * Written as a positive test rather than as `cursor === null`, because the
 * failure modes are all the *other* falsy-ish shapes: an empty token from a
 * provider, a whitespace value from a truncated record, a continuation token
 * from a backfill that stopped half-way. Each of those, read as "resume", skips
 * the gate and re-lists a mailbox at full price.
 */
export function pullModeFor(state: ConnectorState): PullMode {
  const cursor = state.cursor;
  if (cursor === null) return 'backfill';
  if (cursor.kind !== 'delta') return 'backfill';
  return cursor.value.trim().length === 0 ? 'backfill' : 'delta';
}

/** Drop the cursor and remember when. Returns a new state; never mutates. */
export function discardCursor(state: ConnectorState, at: Date): ConnectorState {
  return { ...state, cursor: null, lastCursorInvalidatedAt: at.toISOString() };
}

export function nextPullAt(state: ConnectorState): Date {
  const last = state.lastPullAt === null ? null : Date.parse(state.lastPullAt);
  if (last === null || Number.isNaN(last)) return new Date(0);
  return new Date(last + state.cadenceSeconds * 1_000);
}

export function isPullDue(state: ConnectorState, now: Date): boolean {
  return now.getTime() >= nextPullAt(state).getTime();
}

// ---------------------------------------------------------------------------
// Invalidation.
// ---------------------------------------------------------------------------

const FULL_SYNC_REASONS = new Set(['fullsyncrequired', 'expired', 'gone']);

/** Substrings that appear in the provider's own message for an expired cursor. */
const EXPIRED_CURSOR_TEXT =
  /(sync\s*token|start\s*history\s*id|historyid|page\s*token|starttoken)[^.]{0,40}?(no longer valid|invalid|expired|too old|not found)|full\s*sync\s*required/i;

function bodyText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body === null || typeof body !== 'object') return '';
  try {
    return JSON.stringify(body);
  } catch {
    return '';
  }
}

function reasonsIn(body: unknown): readonly string[] {
  if (body === null || typeof body !== 'object') return [];
  const error = (body as { error?: unknown }).error;
  if (error === null || typeof error !== 'object') return [];
  const errors = (error as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .map((entry) =>
      entry !== null && typeof entry === 'object' && typeof (entry as { reason?: unknown }).reason === 'string'
        ? ((entry as { reason: string }).reason.toLowerCase())
        : '',
    )
    .filter((reason) => reason.length > 0);
}

/**
 * Is this provider failure the cursor being gone?
 *
 * `410 GONE` is unambiguous and is what both Calendar and Drive answer. The
 * other two shapes are Google's older `fullSyncRequired` reason code and
 * Gmail's `404` on a `startHistoryId` past the retention window.
 *
 * Everything else is **not** an invalidation, and that direction matters: a
 * 500, a 429 or an unparseable body read as "cursor gone" would discard a live
 * cursor on every hiccup and re-run a gated backfill each time — turning a
 * transient provider blip into a repeated full re-list.
 */
export function isCursorInvalidation(status: number, body: unknown): boolean {
  if (status === 410) return true;

  const reasons = reasonsIn(body);
  if (reasons.some((reason) => FULL_SYNC_REASONS.has(reason))) return true;

  if (status === 400 || status === 404) {
    return EXPIRED_CURSOR_TEXT.test(bodyText(body));
  }

  return false;
}

// ---------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------

/** `{tenant}/connectors/<source>`. */
export const CONNECTOR_COLLECTION = 'connectors';

export interface ConnectorStateStore {
  read(source: ConnectorSource): Promise<ConnectorState | null>;
  write(state: ConnectorState): Promise<void>;
}

function isCursor(value: unknown): value is SourceCursor {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== 'string' || !(CURSOR_KINDS as readonly string[]).includes(record.kind)) {
    return false;
  }
  if (typeof record.value !== 'string') return false;
  return typeof record.issuedAt === 'string' || record.issuedAt === undefined;
}

function isBackfill(value: unknown): value is PendingBackfill {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.jobId !== 'string' || record.jobId.length === 0) return false;
  if (!Number.isSafeInteger(record.approvedMicroUsd) || (record.approvedMicroUsd as number) < 0) {
    return false;
  }
  const days = record.windowDays;
  return days === null || (Number.isFinite(days) && (days as number) >= 0);
}

/**
 * Validate a stored record into a state, or answer `null`.
 *
 * A partially-recovered state is worse than none: a record whose cursor
 * survived but whose cadence did not would poll at whatever the default is,
 * and a record whose `source` was corrupted would pull the wrong mailbox into
 * the wrong origin. So every field is checked and a single failure yields
 * nothing at all — which reads, through {@link pullModeFor}, as a gated
 * backfill rather than as a free re-list.
 */
export function parseConnectorState(parsed: unknown): ConnectorState | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  const source = record.source;
  if (typeof source !== 'string' || !isConnectorSource(source)) return null;

  const externalUserId = record.externalUserId;
  if (typeof externalUserId !== 'string' || externalUserId.length === 0) return null;

  const cadence = record.cadenceSeconds;
  if (!Number.isFinite(cadence) || (cadence as number) < MIN_CADENCE_SECONDS) return null;

  const connectedAt = record.connectedAt;
  if (typeof connectedAt !== 'string' || Number.isNaN(Date.parse(connectedAt))) return null;

  const accountId = record.accountId;
  if (accountId !== null && typeof accountId !== 'string') return null;

  const cursor = record.cursor;
  if (cursor !== null && !isCursor(cursor)) return null;

  const backfill = record.backfill;
  if (backfill !== null && backfill !== undefined && !isBackfill(backfill)) return null;

  const lastPullAt = record.lastPullAt;
  if (lastPullAt !== null && lastPullAt !== undefined && typeof lastPullAt !== 'string') return null;

  const invalidatedAt = record.lastCursorInvalidatedAt;
  if (invalidatedAt !== null && invalidatedAt !== undefined && typeof invalidatedAt !== 'string') {
    return null;
  }

  return {
    source,
    externalUserId,
    accountId: accountId ?? null,
    cadenceSeconds: Math.trunc(cadence as number),
    cursor:
      cursor === null
        ? null
        : {
            kind: (cursor as SourceCursor).kind,
            value: (cursor as SourceCursor).value,
            issuedAt: (cursor as SourceCursor).issuedAt ?? connectedAt,
          },
    connectedAt,
    lastPullAt: (lastPullAt as string | undefined) ?? null,
    lastCursorInvalidatedAt: (invalidatedAt as string | undefined) ?? null,
    backfill: (backfill as PendingBackfill | undefined) ?? null,
  };
}

export function createInMemoryConnectorStore(
  seed: readonly ConnectorState[] = [],
): ConnectorStateStore {
  const states = new Map<ConnectorSource, ConnectorState>();
  for (const state of seed) states.set(state.source, state);

  return {
    read(source) {
      return Promise.resolve(states.get(source) ?? null);
    },
    write(state) {
      states.set(state.source, { ...state });
      return Promise.resolve();
    },
  };
}

export class ConnectorKeyError extends Error {
  constructor(source: ConnectorSource, reason: string) {
    super(`no connector-state key for '${source}': ${reason}`);
    this.name = 'ConnectorKeyError';
  }
}

/**
 * The durable store: one small JSON object per source under the tenant's own
 * prefix, through the storage accessor.
 *
 * A key that cannot be derived is a **throw**, not a `null` read: `null` means
 * "this source is not connected", and answering that when the accessor refused
 * would present a live connector as a disconnected one and lose its cursor on
 * the next write.
 */
export function createObjectConnectorStore(options: {
  readonly store: RawStore;
  readonly storage: TenantStorage;
  readonly caller: CallerIdentity;
  readonly tenantId: string;
}): ConnectorStateStore {
  const { store, storage, caller, tenantId } = options;

  function keyFor(source: ConnectorSource) {
    const key = storage.keyFor(caller, tenantId, [CONNECTOR_COLLECTION, source]);
    if (!key.ok) throw new ConnectorKeyError(source, key.reason);
    return key.key;
  }

  return {
    async read(source) {
      const stored = await store.get(keyFor(source));
      if (stored === null) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(stored.bytes));
      } catch {
        return null;
      }
      const state = parseConnectorState(parsed);
      // A record that fails validation must not be half-adopted: the source
      // reads as unconnected, and a re-connect writes a clean one.
      return state === null || state.source !== source ? null : state;
    },

    async write(state) {
      const object: RawObject = {
        bytes: new TextEncoder().encode(JSON.stringify(state)),
        contentType: 'application/json',
      };
      await store.put(keyFor(state.source), object);
    },
  };
}
