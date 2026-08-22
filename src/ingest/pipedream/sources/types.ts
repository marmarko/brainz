/**
 * What a provider adapter is, and what it must say.
 *
 * Three adapters, one shape, and the shape is chosen so that the Phase 5
 * own-OAuth swap (KTD6's exit ramp) and Assumption 1's MBOX fallback are each a
 * new implementation of {@link ProviderSource} rather than a change to the pull
 * runner. Nothing above this interface knows what Gmail is.
 *
 * **The part that is easy to leave out is `tombstones`.** A pull that only
 * reports what exists produces a brain where a cancelled meeting still appears
 * in tomorrow's briefing and an edited document keeps its superseded chunks
 * ranking — and then U11 reads the stale row against its live replacement and
 * reports a contradiction that never happened, which is exactly the fabrication
 * R8's upgrade prompt is built on. So "gone" is part of the return type, not an
 * absence the runner is expected to infer. The runner cannot infer it: unlike
 * U8's folder scan, a delta feed never enumerates what still exists.
 */

import { normalizeAccountKey, type ConnectorSource, type CursorKind, type PullMode } from '../../cursor.ts';
import type { SourceType } from '../../../core/write/write-path.ts';
import type { IngestFailureCode } from '../../log.ts';
import type { Correspondent } from '../../correspondents.ts';
import type { JunkInput } from '../../junk.ts';
import type { PullFailureReason } from '../client.ts';

/**
 * `<source>:<account>:<the provider's own id>`, or `<source>:<id>` when the
 * provider does not cheaply say which account this is. The idempotency key's
 * first half.
 *
 * **The account is in the key because provider ids are not global.** A Gmail
 * message id is unique within one mailbox; two Google accounts can and do carry
 * the same id. Without the account in the ref, reconnecting a different account
 * makes B's colliding message arrive as an *update* to A's page — A's mail
 * tombstoned and replaced by a stranger's, silently, with the origin fence
 * unable to tell the two apart because both pulls carry the same origin.
 */
export function externalRefFor(
  source: ConnectorSource,
  providerId: string,
  accountKey?: string | null,
): string {
  const id = providerId.trim();
  if (id.length === 0) throw new Error(`refusing an empty provider id for '${source}'`);
  const account = normalizeAccountKey(accountKey);
  return account === null ? `${source}:${id}` : `${source}:${account}:${id}`;
}

/**
 * A ceiling on one item's body.
 *
 * Not a correctness rule — a rate limiter for a single pathological item. A
 * 40MB mail thread would otherwise chunk into thousands of passages and spend a
 * tenant's whole approval on one message, and the gate's estimate is computed
 * from these same characters, so bounding here bounds both.
 */
export const MAX_ITEM_CHARACTERS = 200_000;

export function boundBody(text: string): string {
  return text.length <= MAX_ITEM_CHARACTERS ? text : text.slice(0, MAX_ITEM_CHARACTERS);
}

/**
 * A truncated backfill has two things to remember: where the listing stopped,
 * and the delta token that was captured *before* it started. Both travel in one
 * opaque cursor value, joined by a delimiter neither Google page tokens nor
 * history ids can contain (they are base64url / digits).
 *
 * Without the second half, the delta that follows a multi-slice first import
 * starts where the *last* slice started, and every edit made to
 * already-imported items during the backfill is invisible forever.
 */
export const RESUME_DELIMITER = '~';

export function joinResumeCursor(pageToken: string, deltaToken: string | null): string {
  return `${pageToken}${RESUME_DELIMITER}${deltaToken ?? ''}`;
}

export function splitResumeCursor(cursor: string | null): {
  readonly pageToken: string | null;
  readonly deltaToken: string | null;
} {
  if (cursor === null) return { pageToken: null, deltaToken: null };
  const index = cursor.indexOf(RESUME_DELIMITER);
  if (index < 0) return { pageToken: cursor, deltaToken: null };
  return {
    pageToken: cursor.slice(0, index) || null,
    deltaToken: cursor.slice(index + 1) || null,
  };
}

export interface PulledItem {
  readonly externalRef: string;
  readonly title: string | null;
  readonly body: string;
  readonly occurredAt: Date | null;
  /** What the junk gate reads. Absent for sources that carry no headers. */
  readonly junk?: JunkInput;
  /**
   * Who this item is between, as the provider stated it. Absent for Drive.
   *
   * Structured rather than prose, deliberately: Calendar already flattens its
   * `attendees[].email` into body text for a regex to re-parse downstream, and
   * that round trip is where a name becomes a guess.
   */
  readonly correspondents?: readonly Correspondent[];
}

export type TombstoneReason = 'deleted' | 'trashed' | 'cancelled' | 'removed';

export interface PulledTombstone {
  readonly externalRef: string;
  readonly reason: TombstoneReason;
}

export interface PulledFailure {
  readonly externalRef: string | null;
  readonly reason: IngestFailureCode;
  /**
   * **Could asking again succeed?** The runner reads this and nothing else to
   * decide whether the cursor may move past the item.
   *
   * A rate-limited fetch is the case that decides the field exists: collapsed
   * into `provider_error` it reads as "this item is broken", the cursor advances
   * over it, and the provider never offers that message again — a permanent hole
   * in a mailbox, produced by a 429 the vendor expected us to retry. The other
   * direction is a real cost too, which is why this is not simply "always hold":
   * a message deleted between the listing and the fetch answers 404 forever, and
   * holding the cursor for it stalls the source until somebody notices.
   *
   * Required, not optional. A default here would be a decision nobody made at
   * the one place that knows the provider's status code.
   */
  readonly retryable: boolean;
}

/**
 * Statuses on which asking again is worth anything: a transport that never
 * answered, a server that failed, a timeout. Every other 4xx is the provider
 * telling us something stable about that item.
 */
function statusIsWorthRetrying(status: number | null): boolean {
  return status === null || status === 408 || status >= 500;
}

/**
 * One provider refusal of one item, in the vocabulary the ingest log holds plus
 * the retry verdict the cursor turns on.
 *
 * Written once and shared, because three adapters that each decided for
 * themselves is three chances to collapse a 429 into "broken item" — which is
 * exactly how this was wrong before.
 */
export function itemFailureFor(
  externalRef: string | null,
  failure: { readonly reason: PullFailureReason; readonly status: number | null },
): PulledFailure {
  switch (failure.reason) {
    case 'rate_limited':
      return { externalRef, reason: 'rate_limited', retryable: true };
    case 'auth_expired':
      return { externalRef, reason: 'auth_expired', retryable: true };
    // **Named, because the default would lose the item.** A mint refusal
    // carries the token endpoint's status — a 401 — and the default's verdict
    // is `statusIsWorthRetrying`, which reads a 401 as a fact about the item
    // and writes it off. It is not: this fleet never asked the provider about
    // this message at all, so nothing whatever is known about it and the cursor
    // must not move past it.
    case 'fleet_auth_failed':
      return { externalRef, reason: 'fleet_auth_failed', retryable: true };
    case 'not_connected':
      return { externalRef, reason: 'cancelled', retryable: true };
    case 'cursor_invalid':
      // On a *single item* this is not the cursor: a 410 or a 404 on one message
      // is that message being gone. Holding the cursor for it would wedge the
      // source forever on an id that is never coming back.
      return { externalRef, reason: 'provider_error', retryable: false };
    default:
      return {
        externalRef,
        reason: 'provider_error',
        retryable: statusIsWorthRetrying(failure.status),
      };
  }
}

/**
 * An item the page found but this pull's ceiling had no room to fetch.
 *
 * Not a slice and not a silence: the runner holds the cursor on it, so the
 * change is offered again next time rather than being skipped for good. The
 * remedy an operator has is a larger `maxItems`, and the row is what tells them
 * to reach for it.
 */
export function ceilingFailureFor(externalRef: string): PulledFailure {
  return { externalRef, reason: 'cancelled', retryable: true };
}

/** What the adapter hands back as the next cursor. `issuedAt` is the runner's. */
export interface CursorSeed {
  readonly kind: CursorKind;
  readonly value: string;
}

/**
 * **There is no `media` field, and its absence is a decision.**
 *
 * There used to be one, and Drive was the only adapter that ever populated it.
 * Every deployment of this fleet composes the pull handler with no object store,
 * so the runner counted each object failed and refused to advance the cursor —
 * and Drive, the source the field existed for, never once recorded a successful
 * run. The founder's ruling then made Drive metadata-only, which left the field,
 * the runner's step 7a, and the client's binary seam with no producer and no
 * consumer anywhere in `src/`.
 *
 * They were removed rather than left unreachable. An unreachable branch that
 * fails closed is exactly the shape the wedge lived in: green tests, a
 * production path nobody ran, and a cursor held by machinery the composer never
 * wired. Gmail attachments would reintroduce all three deliberately, with a
 * composer that passes a store — `git log` is the shelf, `acceptMedia` and the
 * folder-import seam (`src/ingest/import/run.ts`) are untouched and still carry
 * the storage half.
 */
export interface PullPage {
  readonly items: readonly PulledItem[];
  readonly tombstones: readonly PulledTombstone[];
  /** Items the provider offered but could not be turned into a page. */
  readonly failures: readonly PulledFailure[];
  /**
   * `null` means "no cursor to save" — the run stays a backfill. A `backfill`
   * kind means this listing stopped part-way and the next slice is re-gated; a
   * `delta` kind means the source is caught up.
   */
  readonly nextCursor: CursorSeed | null;
  /**
   * The provider's estimate of what the window left out — the widen path's
   * number ("importing 1,204 of 40,000"). Null when the provider does not say.
   */
  readonly outsideWindow: number | null;
  /**
   * Correspondents a listing states that carry NO page — the address book.
   *
   * Absent for every source whose items ARE the content. A statement rather
   * than a sighting, which is exactly why it cannot create anybody:
   * `correspondent_sighting` has no row to take without a page.
   */
  readonly correspondents?: readonly Correspondent[];
  /**
   * **Which account this listing came from**, when the provider says cheaply.
   * The runner adopts it on first sight and refuses a listing that reports a
   * different one — see {@link ConnectorState.accountKey}.
   *
   * Null means "not observed", never "no account": a source that cannot answer
   * must not be read as having answered.
   */
  readonly accountKey?: string | null;
}

export interface ProviderListRequest {
  readonly mode: PullMode;
  /** The stored cursor value, whatever kind it was. Null on a first import. */
  readonly cursor: string | null;
  /** The window boundary a backfill must not reach past. */
  readonly since: Date | null;
  readonly maxItems: number;
  readonly now: Date;
  readonly externalUserId: string;
  readonly accountId?: string | null;
  /**
   * The account the runner believes is connected, so an adapter that cannot
   * re-observe it on this call (a delta, a resumed slice) still keys its refs
   * the same way the first slice did.
   */
  readonly accountKey?: string | null;
}

export type ProviderListOutcome =
  | { readonly ok: true; readonly page: PullPage }
  | { readonly ok: false; readonly reason: PullFailureReason };

export interface ProviderSource {
  readonly source: ConnectorSource;
  readonly sourceType: SourceType;
  list(request: ProviderListRequest): Promise<ProviderListOutcome>;
}

// ---------------------------------------------------------------------------
// Shared parsing helpers. Small, and shared so three adapters cannot disagree
// about what a missing field means.
// ---------------------------------------------------------------------------

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A timestamp the provider gave us, or null. Never `new Date()` as a default:
 * an invented occurrence date puts an item inside a window it does not belong
 * to, and the window is what bounds the import. */
export function asDate(value: unknown): Date | null {
  if (typeof value === 'number') return new Date(value);
  if (typeof value !== 'string' || value.length === 0) return null;
  const numeric = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  const parsed = Number.isFinite(numeric) ? numeric : Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}
