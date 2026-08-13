/**
 * Gmail, thin.
 *
 * Two shapes, because Gmail has two: `messages.list` for a bounded first
 * import, `history.list` for everything after. The second is the one that
 * expires — the history window is finite, and a mailbox that has not been
 * polled for long enough answers `404`/`410` on its own `startHistoryId`. That
 * is not an error path, it is *the* path (U9 approach 2a), and it arrives here
 * as `cursor_invalid` so the runner can discard the cursor and re-gate.
 *
 * **The delta is a fold over events in order, not a scan for keywords.** A
 * message can be trashed and restored inside one history page, so the last
 * event for an id is the only thing that says where it ended up. The event that
 * is easy to leave out is `labelsRemoved: [TRASH]` — `messagesAdded` fires once
 * when the mail first arrives and will never fire again for a message that was
 * merely binned, so an untrash read as nothing leaves the page soft-deleted
 * while the user can plainly see the message in Gmail, permanently and with
 * nothing left to correct it.
 *
 * **The history id is captured before the listing, not after.** A message that
 * arrives while the backfill is running would otherwise fall in the gap between
 * "what the list returned" and "where the delta starts", and be invisible
 * forever. Taking the id first makes the overlap a duplicate rather than a
 * hole, and a duplicate costs nothing: U4 answers `unchanged`.
 *
 * **A truncated backfill carries that id forward.** The continuation cursor is
 * `<pageToken>~<historyId>`, so the delta that eventually follows a multi-slice
 * first import starts where the *first* slice started rather than where the
 * last one did. Without it, edits made to already-imported mail during a long
 * backfill are never seen. `~` is the delimiter because Google's page tokens
 * are base64url (`[A-Za-z0-9_-]`) and cannot contain one.
 *
 * **Assumption 1 lives closest to this file.** If Pipedream's OAuth apps do not
 * cover production restricted Gmail scopes, this adapter is what gets replaced
 * — by CASA-free scopes plus an MBOX export through U8's folder import — and
 * nothing outside it changes: the cursor, the junk gate, the gate, the log and
 * the runner never mention Gmail.
 */

import type { JunkInput } from '../../junk.ts';
import type { ProviderApi } from '../client.ts';
import {
  RESUME_DELIMITER,
  asArray,
  asDate,
  asRecord,
  asString,
  boundBody,
  ceilingFailureFor,
  externalRefFor,
  itemFailureFor,
  joinResumeCursor,
  splitResumeCursor,
  type ProviderListOutcome,
  type ProviderListRequest,
  type ProviderSource,
  type PulledFailure,
  type PulledItem,
  type PulledTombstone,
  type TombstoneReason,
} from './types.ts';

const APP = 'gmail' as const;
const PAGE_SIZE = 100;

/**
 * Labels that mean "this message is gone from the mailbox the user sees".
 *
 * The same set answers both directions: adding one takes the message away,
 * removing one brings it back. Keeping one set is what stops the two halves
 * from disagreeing about what "gone" is.
 */
const REMOVING_LABELS = new Set(['TRASH', 'SPAM']);

/** The message id inside a `messagesAdded` / `labelsRemoved` / … change. */
function messageIdOf(change: unknown): string | null {
  return asString(asRecord(asRecord(change)?.message ?? null)?.id ?? null);
}

/** Does this label change mention a label that hides a message? */
function touchesRemovingLabel(change: unknown): boolean {
  return asArray(asRecord(change)?.labelIds).some((label) => {
    const name = asString(label);
    return name !== null && REMOVING_LABELS.has(name);
  });
}

/**
 * A delta cursor, read.
 *
 * Two shapes, and the second one only exists because a history walk can be
 * longer than one page: a bare `<historyId>` is a caught-up source, and
 * `<pageToken>~<historyId>` is a walk that stopped part-way and must resume from
 * the id it *started* at rather than from wherever the mailbox has got to. The
 * delimiter is safe because Google's page tokens are base64url and its history
 * ids are digits; neither can contain a `~`.
 */
function readDeltaCursor(cursor: string | null): {
  readonly startHistoryId: string | null;
  readonly pageToken: string | null;
} {
  if (cursor === null) return { startHistoryId: null, pageToken: null };
  const index = cursor.indexOf(RESUME_DELIMITER);
  if (index < 0) return { startHistoryId: cursor, pageToken: null };
  return {
    pageToken: cursor.slice(0, index) || null,
    startHistoryId: cursor.slice(index + 1) || null,
  };
}

/** `after:YYYY/MM/DD` — Gmail's own query syntax, in UTC. */
function afterQuery(since: Date): string {
  const year = since.getUTCFullYear();
  const month = `${since.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${since.getUTCDate()}`.padStart(2, '0');
  return `after:${year}/${month}/${day}`;
}

function decodeBody(data: string): string {
  try {
    return Buffer.from(data, 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

/** Prefer `text/plain`; fall back to stripped HTML. Recursive, because Gmail
 * nests `multipart/alternative` inside `multipart/mixed` routinely. */
function extractBody(payload: Record<string, unknown> | null): string {
  if (payload === null) return '';

  const mime = asString(payload.mimeType) ?? '';
  const body = asRecord(payload.body);
  const data = body === null ? null : asString(body.data);

  if (data !== null && mime.startsWith('text/')) {
    const text = decodeBody(data);
    return mime === 'text/html' ? stripHtml(text) : text;
  }

  const parts = asArray(payload.parts).map(asRecord);
  const plain = parts.find((part) => part !== null && asString(part.mimeType) === 'text/plain');
  if (plain !== undefined && plain !== null) return extractBody(plain);

  for (const part of parts) {
    if (part === null) continue;
    const text = extractBody(part);
    if (text.trim().length > 0) return text;
  }

  return data === null ? '' : decodeBody(data);
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function headerMap(payload: Record<string, unknown> | null): Record<string, string> {
  const headers: Record<string, string> = {};
  if (payload === null) return headers;
  for (const entry of asArray(payload.headers)) {
    const record = asRecord(entry);
    const name = record === null ? null : asString(record.name);
    const value = record === null ? null : asString(record.value);
    if (name !== null && value !== null) headers[name.toLowerCase()] = value;
  }
  return headers;
}

function toItem(message: Record<string, unknown>, accountKey: string | null): PulledItem | null {
  const id = asString(message.id);
  if (id === null) return null;

  const payload = asRecord(message.payload);
  const headers = headerMap(payload);
  const body = boundBody(extractBody(payload).trim() || (asString(message.snippet) ?? ''));
  if (body.trim().length === 0) return null;

  const labels = asArray(message.labelIds)
    .map((label) => asString(label))
    .filter((label): label is string => label !== null);

  const junk: JunkInput = {
    headers,
    from: headers.from ?? null,
    subject: headers.subject ?? null,
    labels,
  };

  return {
    externalRef: externalRefFor('gmail', id, accountKey),
    title: headers.subject ?? null,
    body,
    occurredAt: asDate(message.internalDate),
    junk,
  };
}

export function createGmailSource(api: ProviderApi): ProviderSource {
  async function fetchMessage(
    request: ProviderListRequest,
    id: string,
    accountKey: string | null,
  ): Promise<PulledItem | PulledFailure> {
    const outcome = await api.request({
      app: APP,
      method: 'GET',
      path: `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
      query: { format: 'full' },
      externalUserId: request.externalUserId,
      accountId: request.accountId ?? null,
    });

    if (!outcome.ok) {
      // A message that would not fetch is a *failure row*, not a silent skip:
      // an item nobody can account for is how a run reports a clean import of
      // a mailbox it half-read. The provider's own status decides whether the
      // cursor may move past it — a 429 read as "broken item" loses the message
      // for good.
      return itemFailureFor(externalRefFor('gmail', id, accountKey), outcome);
    }

    const record = asRecord(outcome.value);
    const item = record === null ? null : toItem(record, accountKey);
    // A body this adapter cannot make prose out of will not become prose on the
    // next attempt either, so this one does not hold the cursor.
    return (
      item ?? {
        externalRef: externalRefFor('gmail', id, accountKey),
        reason: 'parse_failed',
        retryable: false,
      }
    );
  }

  /**
   * Fetch what this pull's ceiling has room for, and **account for the rest**.
   *
   * The ids beyond the ceiling are not sliced away: they come back as retryable
   * failure rows, which holds the cursor, which is what makes the change be
   * offered again instead of skipped forever.
   */
  async function collect(
    request: ProviderListRequest,
    ids: readonly string[],
    accountKey: string | null,
  ): Promise<{ items: PulledItem[]; failures: PulledFailure[] }> {
    const items: PulledItem[] = [];
    const failures: PulledFailure[] = [];
    const ceiling = Math.max(0, request.maxItems);
    for (const id of ids.slice(ceiling)) {
      failures.push(ceilingFailureFor(externalRefFor('gmail', id, accountKey)));
    }
    for (const id of ids.slice(0, ceiling)) {
      const fetched = await fetchMessage(request, id, accountKey);
      if ('reason' in fetched) failures.push(fetched);
      else items.push(fetched);
    }
    return { items, failures };
  }

  async function backfill(request: ProviderListRequest): Promise<ProviderListOutcome> {
    const resume = splitResumeCursor(request.cursor);

    // Before the listing, always — see the header.
    let historyId = resume.deltaToken;
    // What the runner believes, until the profile says otherwise.
    let accountKey = request.accountKey ?? null;
    if (historyId === null) {
      const profile = await api.request({
        app: APP,
        method: 'GET',
        path: '/gmail/v1/users/me/profile',
        externalUserId: request.externalUserId,
        accountId: request.accountId ?? null,
      });
      if (!profile.ok) return { ok: false, reason: profile.reason };
      const record = asRecord(profile.value);
      historyId = asString(record?.historyId ?? null);
      // The same response already carries **which mailbox this is**. Dropping it
      // is what leaves a pulled message bound to nothing but a per-mailbox id.
      accountKey = asString(record?.emailAddress ?? null) ?? accountKey;
    }

    const listed = await api.request({
      app: APP,
      method: 'GET',
      path: '/gmail/v1/users/me/messages',
      query: {
        maxResults: Math.min(PAGE_SIZE, Math.max(1, request.maxItems)),
        ...(request.since === null ? {} : { q: afterQuery(request.since) }),
        ...(resume.pageToken === null ? {} : { pageToken: resume.pageToken }),
      },
      externalUserId: request.externalUserId,
      accountId: request.accountId ?? null,
    });
    if (!listed.ok) return { ok: false, reason: listed.reason };

    const body = asRecord(listed.value);
    const ids = asArray(body?.messages)
      .map((entry) => asString(asRecord(entry)?.id ?? null))
      .filter((id): id is string => id !== null)
      .slice(0, request.maxItems);

    const { items, failures } = await collect(request, ids, accountKey);
    const nextPageToken = asString(body?.nextPageToken ?? null);
    const estimate = body?.resultSizeEstimate;

    return {
      ok: true,
      page: {
        items,
        tombstones: [],
        failures,
        nextCursor:
          nextPageToken !== null
            ? { kind: 'backfill', value: joinResumeCursor(nextPageToken, historyId) }
            : historyId === null
              ? null
              : { kind: 'delta', value: historyId },
        outsideWindow: typeof estimate === 'number' ? estimate : null,
        accountKey,
      },
    };
  }

  async function delta(request: ProviderListRequest): Promise<ProviderListOutcome> {
    const resume = readDeltaCursor(request.cursor);
    // A history walk does not re-observe the mailbox; it keys its refs by what
    // the first slice adopted, which is what the runner hands down here.
    const accountKey = request.accountKey ?? null;
    const listed = await api.request({
      app: APP,
      method: 'GET',
      path: '/gmail/v1/users/me/history',
      query: {
        startHistoryId: resume.startHistoryId ?? '',
        maxResults: Math.min(PAGE_SIZE, Math.max(1, request.maxItems)),
        ...(resume.pageToken === null ? {} : { pageToken: resume.pageToken }),
      },
      externalUserId: request.externalUserId,
      accountId: request.accountId ?? null,
    });
    if (!listed.ok) return { ok: false, reason: listed.reason };

    const body = asRecord(listed.value);
    /**
     * Where each id ended up, **in event order**.
     *
     * History entries arrive oldest-first, so the last event for a message is
     * the current truth and this is a fold rather than a set of predicates. The
     * shape matters in both directions: a rule that answers "gone" whenever a
     * trash event appears anywhere in the page loses a message the user
     * restored, and one that answers "live" whenever an untrash appears
     * resurrects one they threw away.
     */
    const settled = new Map<string, { readonly live: boolean; readonly reason: TombstoneReason }>();
    const gone = (id: string, reason: TombstoneReason) => settled.set(id, { live: false, reason });
    const back = (id: string) => settled.set(id, { live: true, reason: 'deleted' });

    for (const entry of asArray(body?.history)) {
      const record = asRecord(entry);
      if (record === null) continue;

      for (const change of asArray(record.messagesAdded)) {
        const id = messageIdOf(change);
        if (id !== null) back(id);
      }

      for (const change of asArray(record.messagesDeleted)) {
        const id = messageIdOf(change);
        if (id !== null) gone(id, 'deleted');
      }

      for (const change of asArray(record.labelsAdded)) {
        const id = messageIdOf(change);
        if (id !== null && touchesRemovingLabel(change)) gone(id, 'trashed');
      }

      // **The event that says a message is back.** `messagesAdded` fires once,
      // when the message first arrives, so nothing will ever re-add a message
      // that was merely trashed — this is the only signal there is. Read as
      // nothing, the page stays soft-deleted while the user can plainly see the
      // mail in Gmail, and no later pull will ever correct it.
      //
      // Only a TRASH/SPAM removal counts: every other label change (read,
      // starred, moved) leaves the content alone, and treating it as news would
      // re-fetch the whole mailbox every time somebody clears their unreads.
      for (const change of asArray(record.labelsRemoved)) {
        const id = messageIdOf(change);
        if (id !== null && touchesRemovingLabel(change)) back(id);
      }
    }

    const live: string[] = [];
    const tombstones: PulledTombstone[] = [];
    for (const [id, state] of settled) {
      if (state.live) live.push(id);
      else tombstones.push({ externalRef: externalRefFor('gmail', id, accountKey), reason: state.reason });
    }

    const { items, failures } = await collect(request, live, accountKey);
    const nextPageToken = asString(body?.nextPageToken ?? null);
    const historyId = asString(body?.historyId ?? null);

    /**
     * **`body.historyId` is the mailbox's current record, not this page's last
     * one.** Taking it while a `nextPageToken` is still outstanding declares the
     * source caught up to *now* and skips every change on the pages nobody read
     * — silently, permanently, and with the run still closing `ok`.
     *
     * So a truncated history walk resumes itself: the cursor stays `delta`
     * (a `backfill` kind would send the next pull to `messages.list`, which
     * cannot use a history page token) and carries the page token beside the
     * start it was walking from.
     */
    const nextCursor =
      nextPageToken !== null
        ? resume.startHistoryId === null
          ? null
          : { kind: 'delta' as const, value: joinResumeCursor(nextPageToken, resume.startHistoryId) }
        : historyId === null
          ? null
          : { kind: 'delta' as const, value: historyId };

    return {
      ok: true,
      page: { items, tombstones, failures, nextCursor, outsideWindow: null, accountKey },
    };
  }

  return {
    source: 'gmail',
    sourceType: 'email',
    list(request) {
      return request.mode === 'delta' && request.cursor !== null ? delta(request) : backfill(request);
    },
  };
}
