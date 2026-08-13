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
  asArray,
  asDate,
  asRecord,
  asString,
  boundBody,
  externalRefFor,
  joinResumeCursor,
  splitResumeCursor,
  type ProviderListOutcome,
  type ProviderListRequest,
  type ProviderSource,
  type PulledFailure,
  type PulledItem,
  type PulledTombstone,
} from './types.ts';

const APP = 'gmail' as const;
const PAGE_SIZE = 100;

/** Labels that mean "this message is gone from the mailbox the user sees". */
const REMOVING_LABELS = new Set(['TRASH', 'SPAM']);

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

function toItem(message: Record<string, unknown>): PulledItem | null {
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
    externalRef: externalRefFor('gmail', id),
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
      // a mailbox it half-read.
      return { externalRef: externalRefFor('gmail', id), reason: 'provider_error' };
    }

    const record = asRecord(outcome.value);
    const item = record === null ? null : toItem(record);
    return item ?? { externalRef: externalRefFor('gmail', id), reason: 'parse_failed' };
  }

  async function collect(
    request: ProviderListRequest,
    ids: readonly string[],
  ): Promise<{ items: PulledItem[]; failures: PulledFailure[] }> {
    const items: PulledItem[] = [];
    const failures: PulledFailure[] = [];
    for (const id of ids) {
      const fetched = await fetchMessage(request, id);
      if ('reason' in fetched) failures.push(fetched);
      else items.push(fetched);
    }
    return { items, failures };
  }

  async function backfill(request: ProviderListRequest): Promise<ProviderListOutcome> {
    const resume = splitResumeCursor(request.cursor);

    // Before the listing, always — see the header.
    let historyId = resume.deltaToken;
    if (historyId === null) {
      const profile = await api.request({
        app: APP,
        method: 'GET',
        path: '/gmail/v1/users/me/profile',
        externalUserId: request.externalUserId,
        accountId: request.accountId ?? null,
      });
      if (!profile.ok) return { ok: false, reason: profile.reason };
      historyId = asString(asRecord(profile.value)?.historyId ?? null);
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

    const { items, failures } = await collect(request, ids);
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
      },
    };
  }

  async function delta(request: ProviderListRequest): Promise<ProviderListOutcome> {
    const listed = await api.request({
      app: APP,
      method: 'GET',
      path: '/gmail/v1/users/me/history',
      query: {
        startHistoryId: request.cursor ?? '',
        maxResults: Math.min(PAGE_SIZE, Math.max(1, request.maxItems)),
      },
      externalUserId: request.externalUserId,
      accountId: request.accountId ?? null,
    });
    if (!listed.ok) return { ok: false, reason: listed.reason };

    const body = asRecord(listed.value);
    const added = new Set<string>();
    const tombstones = new Map<string, PulledTombstone>();

    for (const entry of asArray(body?.history)) {
      const record = asRecord(entry);
      if (record === null) continue;

      for (const change of asArray(record.messagesAdded)) {
        const id = asString(asRecord(asRecord(change)?.message ?? null)?.id ?? null);
        if (id !== null) added.add(id);
      }

      for (const change of asArray(record.messagesDeleted)) {
        const id = asString(asRecord(asRecord(change)?.message ?? null)?.id ?? null);
        if (id !== null) {
          tombstones.set(id, { externalRef: externalRefFor('gmail', id), reason: 'deleted' });
        }
      }

      for (const change of asArray(record.labelsAdded)) {
        const labelChange = asRecord(change);
        const id = asString(asRecord(labelChange?.message ?? null)?.id ?? null);
        const labels = asArray(labelChange?.labelIds).map((label) => asString(label));
        if (id !== null && labels.some((label) => label !== null && REMOVING_LABELS.has(label))) {
          tombstones.set(id, { externalRef: externalRefFor('gmail', id), reason: 'trashed' });
        }
      }
    }

    // A message that was added and then trashed inside one history page is
    // gone, not new: fetching and writing it would leave a page the next pull
    // has no event left to tombstone.
    for (const id of tombstones.keys()) added.delete(id);

    const { items, failures } = await collect(request, [...added].slice(0, request.maxItems));
    const historyId = asString(body?.historyId ?? null);

    return {
      ok: true,
      page: {
        items,
        tombstones: [...tombstones.values()],
        failures,
        nextCursor: historyId === null ? null : { kind: 'delta', value: historyId },
        outsideWindow: null,
      },
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
