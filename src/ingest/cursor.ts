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
 * **Where this record lives, and the placement moved once.** It is not in the
 * tenant schema, whose rungs are U3's and append-only — that has not changed.
 * It was placed in the tenant's own object prefix, beside the raw payloads,
 * on the reasoning that the control plane *"is content-free by construction and
 * cannot hold a provider token"*.
 *
 * Both halves of that sentence were overtaken. `src/control/secret-store.sql`
 * generalised the rule to **the control plane holds nothing a reader of the
 * control plane can use**, and sealed a tenant's connection string there for
 * exactly the reason connector state needs: a record two fleets must share, with
 * no volume between them. And the object prefix turned out to be unreachable —
 * `src/control/storage.ts` has no production `ScopedCredentialMinter`, both
 * entrypoints compose a refusing one, so a connector state written there is a
 * connector state written nowhere. That is why `connectSource` had no production
 * caller for as long as it did.
 *
 * So the durable home is `control.connector_link`, sealed under
 * `connector/<tenant>/<source>` (`src/control/connector-store.sql` carries the
 * whole argument, `src/control/connector-pg.ts` the four statements). This
 * module is unchanged by that: {@link ConnectorStateStore} is a port,
 * {@link createObjectConnectorStore} remains the implementation for a deployment
 * that gains a credential minter, and the state is still **validated on read,
 * never cast**, for the reason U8's manifest is — a worker spends money on what
 * this record says.
 *
 * **Ordering, and why a non-transactional store is sound here.** The cursor is
 * advanced only *after* the items it covers are banked. A crash in between
 * re-pulls items the brain already holds, which U4 answers with `unchanged` at
 * zero provider cost. The opposite order — advance, then import — silently
 * skips whatever was in flight, and nothing downstream can tell.
 */

import type { CallerIdentity } from '../control/secrets.ts';
import type { TenantStorage } from '../control/storage.ts';
import { ORIGIN_SEPARATOR, classOf } from '../mcp/grant-scope.ts';
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
  /**
   * **Which mailbox this is**, in the provider's own terms — Gmail's
   * `emailAddress`, and null for a source that does not cheaply say.
   *
   * `accountId` above is the *connection's* id, which a reconnect replaces; this
   * is the identity behind it, which a reconnect can silently change. The
   * distinction is not academic: Gmail message ids are unique per mailbox, not
   * globally, so reconnecting a different Google account makes account B's
   * colliding id arrive as an **update** to account A's page — A's mail
   * tombstoned and replaced by a stranger's, with both pulls carrying the same
   * origin so the origin fence cannot tell them apart.
   *
   * Adopted from the first listing that reports one, and never quietly
   * overwritten: a listing that reports a *different* account is refused.
   */
  readonly accountKey: string | null;
  /**
   * **Which half of the brain this connection belongs to**, as U18's context
   * class — `work`, `personal`, or null for a connection that predates the
   * choice.
   *
   * This field is the *producer* U18's context grants did not have. The grammar,
   * the wildcard expansion, the mint-and-verify invariant and the read fence
   * were all real and all tested; what no production path did was write a
   * `work:` row. Every connector page filed at `pipedream:<source>`, so a
   * `work:*` grant obtained through the real consent flow expanded to
   * `['work:agent']` and read back exactly the memories it had written itself.
   * Recorded here, it becomes `<class>:<source>` on every page, chunk and fact
   * the source produces ({@link import('./pipedream/pull.ts').originContextFor}).
   *
   * **Null is the honest default and not a shrug.** A connection with no
   * recorded class keeps filing at the vendor class, which no context grant can
   * name — so it is unreadable by a narrowed grant rather than misfiled into one.
   * Defaulting it to `personal` would be an unobserved value written into the
   * one column access is decided on.
   *
   * **Chosen at connect, and a change is a disconnect-and-reconnect.** `origin`
   * is immutable by trigger and U4's replacement lookup keys on
   * `(external_ref, origin_context)`, so re-classing a live connection does not
   * move its pages: it strands every one of them at the old origin, out of reach
   * of a tombstone sweep that scopes by origin, and writes a second live page
   * for each on the next poll. Nothing in this module overwrites the field —
   * {@link parseConnectorState} preserves it and the pull runner only ever
   * spreads it — and a caller that means to re-class a source must disconnect it
   * first, which is a decision with an owner rather than a silent re-file.
   */
  readonly contextClass: string | null;
  readonly cadenceSeconds: number;
  readonly cursor: SourceCursor | null;
  readonly connectedAt: string;
  readonly lastPullAt: string | null;
  /** When a provider last told us the cursor was gone. Feeds staleness. */
  readonly lastCursorInvalidatedAt: string | null;
  readonly backfill: PendingBackfill | null;
}

/**
 * Is this a context class U18's grammar admits?
 *
 * Asked through `classOf` rather than with a regex of its own. A second spelling
 * of the class grammar is a second answer to "what may this credential read",
 * and the one in `grant-scope.ts` is the one the fence, the wildcard expansion
 * and the OAuth scope parser already agree on.
 */
export function isContextClass(value: unknown): value is string {
  return typeof value === 'string' && classOf(`${value}${ORIGIN_SEPARATOR}x`) === value;
}

export class ConnectorContextError extends Error {
  constructor(value: unknown) {
    super(`${JSON.stringify(value)} is not a context class`);
    this.name = 'ConnectorContextError';
  }
}

export function connectSource(input: {
  readonly source: ConnectorSource;
  readonly externalUserId: string;
  readonly accountId?: string | null;
  readonly accountKey?: string | null;
  /**
   * U18's context class for this connection. Absent means the vendor class —
   * see {@link ConnectorState.contextClass} for why that is the default and why
   * it is not `personal`.
   */
  readonly contextClass?: string | null;
  readonly cadenceSeconds?: number;
  readonly now: Date;
}): ConnectorState {
  // **A throw, not a fallback.** A caller that asked for a class the grammar
  // does not admit meant something by it; filing that connection at the vendor
  // class instead would put a user's work mail in a half of the brain nobody
  // chose, and the fence would then be doing exactly what it was told.
  if (input.contextClass !== undefined && input.contextClass !== null && !isContextClass(input.contextClass)) {
    throw new ConnectorContextError(input.contextClass);
  }

  return {
    source: input.source,
    externalUserId: input.externalUserId,
    accountId: input.accountId ?? null,
    accountKey: normalizeAccountKey(input.accountKey ?? null),
    contextClass: input.contextClass ?? null,
    cadenceSeconds: normalizeCadenceSeconds(input.source, input.cadenceSeconds),
    cursor: null,
    connectedAt: input.now.toISOString(),
    lastPullAt: null,
    lastCursorInvalidatedAt: null,
    backfill: null,
  };
}

/**
 * The account identity, in one canonical spelling.
 *
 * It becomes half of an `external_ref`, so `Owner@Example.test` and
 * `owner@example.test` must not produce two pages for one message — and a blank
 * one must read as "no observation" rather than as an account named "".
 */
export function normalizeAccountKey(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length === 0 ? null : trimmed;
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

  const accountKey = record.accountKey;
  if (accountKey !== null && accountKey !== undefined && typeof accountKey !== 'string') return null;

  // All-or-nothing, like every other field — and this one earns it twice over.
  // Dropping a malformed class to null would file a work connector's mail at the
  // vendor class, where the user's work grant cannot see it; coercing it would
  // write an unobserved value into the column access is decided on.
  const contextClass = record.contextClass;
  if (contextClass !== null && contextClass !== undefined && !isContextClass(contextClass)) return null;

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
    accountKey: normalizeAccountKey((accountKey as string | undefined) ?? null),
    contextClass: (contextClass as string | undefined) ?? null,
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
