/**
 * The three provider adapters.
 *
 * They are deliberately thin — KTD6 makes own-OAuth the Phase 5 exit ramp, so
 * the auth layer must be swappable without touching source logic — and they
 * carry exactly one hard responsibility each: **say which items are gone.**
 *
 * A pull that only inserts produces a brain where a cancelled meeting still
 * appears in tomorrow's briefing, an edited document keeps its superseded
 * chunks ranking, and trashed mail stays recallable. Worse than any of those:
 * U11 reads the stale row against its live replacement and reports a
 * contradiction that never happened. So a `status: cancelled` event, a
 * `TRASH`-labelled message and a `removed` Drive change all have to arrive here
 * as tombstones, not as absences.
 */

import { describe, expect, test } from 'bun:test';

import { MAX_MEDIA_BYTES } from '../../../../src/core/media/accept.ts';
import {
  PROVIDER_API_BASE,
  createPipedreamClient,
} from '../../../../src/ingest/pipedream/client.ts';
import { createCalendarSource } from '../../../../src/ingest/pipedream/sources/calendar.ts';
import { createDriveSource } from '../../../../src/ingest/pipedream/sources/drive.ts';
import { createGmailSource } from '../../../../src/ingest/pipedream/sources/gmail.ts';
import { externalRefFor } from '../../../../src/ingest/pipedream/sources/types.ts';
import { screenshotBytes } from '../../../media/fixture.ts';
import { CONFIG, createScriptedTransport, withToken, type ScriptedResponse } from '../fixture.ts';

const NOW = new Date('2026-08-13T10:00:00.000Z');
const SINCE = new Date('2026-05-15T00:00:00.000Z');

/**
 * A client whose pacing is a no-op.
 *
 * These are adapter tests: what they assert is what the adapter makes of a
 * response, and the shared process budget would otherwise make them sleep
 * against a real clock for reasons none of them are about. `client.test.ts`
 * owns the budget's own behaviour.
 */
const UNPACED = { take: () => Promise.resolve() };

function client(transport: ReturnType<typeof createScriptedTransport>) {
  return createPipedreamClient({ config: CONFIG, transport, now: () => NOW, rate: UNPACED });
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

const CONNECTION = { externalUserId: 'tenant-a', accountId: 'apn_1' } as const;

/**
 * Every upstream URL an adapter asked the proxy for, decoded.
 *
 * The OAuth mint is filtered out — it is a call to the vendor's own endpoint
 * and names no upstream — so what is left is exactly the set of things Google
 * was asked for.
 */
function proxyTargets(transport: ReturnType<typeof createScriptedTransport>): readonly string[] {
  return transport.requests
    .filter((request) => request.url.includes('/proxy/'))
    .map((request) => request.target);
}

describe('gmail', () => {
  test('a backfill maps messages, headers and the history cursor', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/users/me/profile', { status: 200, body: { historyId: '5500' } });
    transport.on('/users/me/messages?', {
      status: 200,
      body: { messages: [{ id: 'm1' }], resultSizeEstimate: 40_000 },
    });
    transport.on('/messages/m1', {
      status: 200,
      body: {
        id: 'm1',
        internalDate: `${Date.UTC(2026, 6, 1)}`,
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'Subject', value: 'Term sheet questions' },
            { name: 'From', value: 'a-founder@widget-co.example' },
            { name: 'List-Unsubscribe', value: '<https://x.test/u>' },
          ],
          body: { data: base64url('the body of the message, at some length') },
        },
      },
    });

    const source = createGmailSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'backfill',
      cursor: null,
      since: SINCE,
      maxItems: 100,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const item = outcome.page.items[0];
    expect(item?.externalRef).toBe(externalRefFor('gmail', 'm1'));
    expect(item?.title).toBe('Term sheet questions');
    expect(item?.body).toContain('the body of the message');
    expect(item?.occurredAt?.getUTCFullYear()).toBe(2026);
    // The headers the junk gate reads are carried, not dropped.
    expect(item?.junk?.headers?.['list-unsubscribe']).toBe('<https://x.test/u>');
    // A completed backfill hands back a delta cursor, taken BEFORE the listing
    // so nothing that arrived mid-list is skipped.
    expect(outcome.page.nextCursor).toEqual({ kind: 'delta', value: '5500' });
    expect(outcome.page.outsideWindow).toBe(40_000);
    // The window is pushed to the provider rather than filtered locally.
    expect(transport.requests.some((request) => request.target.includes('after%3A2026%2F05%2F15'))).toBe(
      true,
    );
    // And the id was taken BEFORE the listing: a message that arrives mid-list
    // must land in the delta that follows rather than in the gap between them.
    const profileAt = transport.requests.findIndex((request) =>
      request.target.includes('/users/me/profile'),
    );
    const listAt = transport.requests.findIndex((request) =>
      request.target.includes('/users/me/messages?'),
    );
    expect(profileAt).toBeGreaterThanOrEqual(0);
    expect(profileAt).toBeLessThan(listAt);
  });

  test('a trashed message arrives as a tombstone', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/history?', {
      status: 200,
      body: {
        historyId: '5600',
        history: [
          { labelsAdded: [{ message: { id: 'm2' }, labelIds: ['TRASH'] }] },
          { messagesDeleted: [{ message: { id: 'm3' } }] },
        ],
      },
    });

    const source = createGmailSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'delta',
      cursor: '5500',
      since: null,
      maxItems: 100,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.tombstones.map((tombstone) => tombstone.externalRef).sort()).toEqual([
      externalRefFor('gmail', 'm2'),
      externalRefFor('gmail', 'm3'),
    ]);
    expect(outcome.page.nextCursor).toEqual({ kind: 'delta', value: '5600' });
  });

  test('a message added and trashed in the same page is gone, not new', async () => {
    // Writing it would leave a page the next pull has no event left to
    // tombstone: the deletion already went past in this very response.
    const transport = withToken(createScriptedTransport());
    transport.on('/history?', {
      status: 200,
      body: {
        historyId: '5700',
        history: [
          { messagesAdded: [{ message: { id: 'm5' } }] },
          { labelsAdded: [{ message: { id: 'm5' }, labelIds: ['TRASH'] }] },
        ],
      },
    });

    const source = createGmailSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'delta',
      cursor: '5600',
      since: null,
      maxItems: 100,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.items.length).toBe(0);
    expect(outcome.page.tombstones.map((tombstone) => tombstone.externalRef)).toEqual([
      externalRefFor('gmail', 'm5'),
    ]);
    // And no message fetch was attempted for it.
    expect(transport.requests.some((request) => request.target.includes('/messages/m5'))).toBe(false);
  });

  test('a message untrashed upstream comes back, rather than staying tombstoned for good', async () => {
    // `messagesAdded` fires once, when the message first arrives. A message
    // that was only ever *trashed* is still in the mailbox, so nothing will
    // ever re-add it — `labelsRemoved: [TRASH]` is the only event that says it
    // is back. Read as nothing, the page stays soft-deleted and the message is
    // unrecallable permanently, while the user can see it in Gmail.
    const transport = withToken(createScriptedTransport());
    transport.on('/history?', {
      status: 200,
      body: {
        historyId: '5800',
        history: [{ labelsRemoved: [{ message: { id: 'm7' }, labelIds: ['TRASH'] }] }],
      },
    });
    transport.on('/messages/m7', {
      status: 200,
      body: {
        id: 'm7',
        internalDate: `${Date.UTC(2026, 6, 1)}`,
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'Subject', value: 'back from the bin' }],
          body: { data: base64url('the message the user restored') },
        },
      },
    });

    const source = createGmailSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'delta',
      cursor: '5700',
      since: null,
      maxItems: 100,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.items.map((entry) => entry.externalRef)).toEqual([
      externalRefFor('gmail', 'm7'),
    ]);
    expect(outcome.page.tombstones).toEqual([]);
  });

  test('within one history page the last event wins, in both directions', async () => {
    // Trashed-then-untrashed is live; untrashed-then-trashed is gone. A rule
    // that answers "gone" whenever a trash event appears anywhere in the page
    // gets the first one wrong, and one that answers "live" whenever an
    // untrash appears gets the second one wrong. Only order settles it.
    const transport = withToken(createScriptedTransport());
    transport.on('/history?', {
      status: 200,
      body: {
        historyId: '5900',
        history: [
          { labelsAdded: [{ message: { id: 'm8' }, labelIds: ['TRASH'] }] },
          { labelsRemoved: [{ message: { id: 'm8' }, labelIds: ['TRASH'] }] },
          { messagesAdded: [{ message: { id: 'm9' } }] },
          { labelsAdded: [{ message: { id: 'm9' }, labelIds: ['TRASH'] }] },
        ],
      },
    });
    transport.on('/messages/m8', {
      status: 200,
      body: {
        id: 'm8',
        internalDate: `${Date.UTC(2026, 6, 2)}`,
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'text/plain',
          headers: [{ name: 'Subject', value: 'restored' }],
          body: { data: base64url('restored body') },
        },
      },
    });

    const source = createGmailSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'delta',
      cursor: '5800',
      since: null,
      maxItems: 100,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.items.map((entry) => entry.externalRef)).toEqual([
      externalRefFor('gmail', 'm8'),
    ]);
    expect(outcome.page.tombstones.map((tombstone) => tombstone.externalRef)).toEqual([
      externalRefFor('gmail', 'm9'),
    ]);
  });

  test('a label change that is not a trash change fetches nothing', async () => {
    // Marking a message read must not cost a message fetch on every poll.
    const transport = withToken(createScriptedTransport());
    transport.on('/history?', {
      status: 200,
      body: {
        historyId: '6000',
        history: [{ labelsRemoved: [{ message: { id: 'm10' }, labelIds: ['UNREAD'] }] }],
      },
    });

    const source = createGmailSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'delta',
      cursor: '5900',
      since: null,
      maxItems: 100,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.items.length).toBe(0);
    expect(outcome.page.tombstones.length).toBe(0);
    expect(transport.requests.some((request) => request.target.includes('/messages/m10'))).toBe(false);
  });

  test('an expired history window is a cursor invalidation, not a provider error', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/history?', { status: 404, body: { error: { message: 'startHistoryId not found' } } });

    const source = createGmailSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'delta',
      cursor: '1',
      since: null,
      maxItems: 100,
      now: NOW,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('cursor_invalid');
  });

  test('a truncated backfill hands back a continuation cursor, never a delta one', async () => {
    // The distinction is the gate: a continuation is re-gated on the next tick,
    // a delta cursor is not. Mislabelling here imports the rest of a 40k
    // mailbox with no ceiling.
    const transport = withToken(createScriptedTransport());
    transport.on('/users/me/profile', { status: 200, body: { historyId: '5500' } });
    transport.on('/users/me/messages?', {
      status: 200,
      body: { messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'p-2', resultSizeEstimate: 900 },
    });
    for (const id of ['m1', 'm2']) {
      transport.on(`/messages/${id}`, {
        status: 200,
        body: {
          id,
          internalDate: `${Date.UTC(2026, 6, 1)}`,
          labelIds: ['INBOX'],
          payload: { mimeType: 'text/plain', headers: [], body: { data: base64url(`body ${id}`) } },
        },
      });
    }

    const source = createGmailSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'backfill',
      cursor: null,
      since: SINCE,
      maxItems: 2,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.nextCursor).toEqual({ kind: 'backfill', value: 'p-2~5500' });
  });

  test('a message that will not decode is a failure row, not a silent skip', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/users/me/profile', { status: 200, body: { historyId: '1' } });
    transport.on('/users/me/messages?', { status: 200, body: { messages: [{ id: 'm9' }] } });
    transport.on('/messages/m9', { status: 500, body: { error: 'boom' } });

    const source = createGmailSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'backfill',
      cursor: null,
      since: SINCE,
      maxItems: 10,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.items.length).toBe(0);
    expect(outcome.page.failures[0]?.externalRef).toBe(externalRefFor('gmail', 'm9'));
  });
});

describe('calendar', () => {
  test('a cancelled event arrives as a tombstone and the rest as items', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/events?', {
      status: 200,
      body: {
        nextSyncToken: 'sync-2',
        items: [
          {
            id: 'e1',
            status: 'confirmed',
            summary: 'Board meeting',
            description: 'agenda: hiring, runway',
            start: { dateTime: '2026-08-14T15:00:00Z' },
            attendees: [{ email: 'a-founder@widget-co.example' }],
          },
          { id: 'e2', status: 'cancelled' },
        ],
      },
    });

    const source = createCalendarSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'delta',
      cursor: 'sync-1',
      since: null,
      maxItems: 100,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.items.map((item) => item.externalRef)).toEqual([
      externalRefFor('calendar', 'e1'),
    ]);
    expect(outcome.page.tombstones).toEqual([
      { externalRef: externalRefFor('calendar', 'e2'), reason: 'cancelled' },
    ]);
    expect(outcome.page.nextCursor).toEqual({ kind: 'delta', value: 'sync-2' });
  });

  test('an unfinished listing hands back a continuation cursor, not a sync token', async () => {
    // A page token means "there is more of this page"; a sync token means
    // "caught up". Storing the first as the second skips the gate on the rest
    // of a calendar the run never finished reading.
    const transport = withToken(createScriptedTransport());
    transport.on('/events?', {
      status: 200,
      body: {
        nextPageToken: 'page-2',
        items: [
          {
            id: 'e9',
            status: 'confirmed',
            summary: 'Standup',
            start: { dateTime: '2026-08-14T09:00:00Z' },
          },
        ],
      },
    });

    const source = createCalendarSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'backfill',
      cursor: null,
      since: SINCE,
      maxItems: 100,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.nextCursor).toEqual({ kind: 'backfill', value: 'page-2' });
  });

  test('410 on a sync token is a cursor invalidation', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/events?', { status: 410, body: { error: { message: 'Sync token is no longer valid' } } });

    const source = createCalendarSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'delta',
      cursor: 'sync-1',
      since: null,
      maxItems: 100,
      now: NOW,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('cursor_invalid');
  });
});

describe('drive', () => {
  test('a removed or trashed file arrives as a tombstone', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/changes?', {
      status: 200,
      body: {
        newStartPageToken: 'p-9',
        changes: [
          { fileId: 'f1', removed: true },
          { fileId: 'f2', removed: false, file: { id: 'f2', name: 'notes.txt', trashed: true } },
          {
            fileId: 'f3',
            removed: false,
            file: {
              id: 'f3',
              name: 'strategy.txt',
              mimeType: 'text/plain',
              trashed: false,
              modifiedTime: '2026-08-12T09:00:00Z',
            },
          },
        ],
      },
    });
    transport.on('/files/f3', { status: 200, body: 'the strategy document body' });

    const source = createDriveSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'delta',
      cursor: 'p-8',
      since: null,
      maxItems: 100,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.tombstones.map((tombstone) => tombstone.externalRef).sort()).toEqual([
      externalRefFor('drive', 'f1'),
      externalRefFor('drive', 'f2'),
    ]);
    expect(outcome.page.items[0]?.externalRef).toBe(externalRefFor('drive', 'f3'));
    expect(outcome.page.items[0]?.body).toContain('strategy document');
    expect(outcome.page.nextCursor).toEqual({ kind: 'delta', value: 'p-9' });
  });

  function changeFor(file: Record<string, unknown>): ScriptedResponse {
    return {
      status: 200,
      body: { newStartPageToken: 'p-9', changes: [{ fileId: file.id, file }] },
    };
  }

  const delta = { ...CONNECTION, mode: 'delta', cursor: 'p-8', since: null, maxItems: 100, now: NOW } as const;

  /**
   * **A file id of the everyday Drive length, and the length is the point.**
   *
   * `https://www.googleapis.com/drive/v3/files/{id}?alt=media` puts the `?` at
   * index `42 + len(id)`, and when that index is ≡ 2 (mod 3) — which 44
   * characters is, and 44 is what an ordinary Drive id has — standard base64
   * encodes it as a raw `/`. A raw `/` splits the proxy's single path segment
   * and the vendor answers `404` before Google is ever reached. So this id is
   * what makes an encoding regression fail *here*, in the adapter that
   * downloads, rather than only in the builder's alphabet assertion.
   */
  const EVERYDAY_FILE_ID = 'fake-drive-file-id-at-the-everyday-44-length';

  test('a screenshot arrives as media, byte for byte', async () => {
    // It is never decoded leniently into a page of noise — that much was always
    // right. What was wrong is that the honest failure row was the *end* of it:
    // a Drive full of screenshots imported as a Drive full of failures, and
    // U21's transcribe queue stayed permanently empty.
    const transport = withToken(createScriptedTransport());
    transport.on(
      '/changes?',
      changeFor({
        id: EVERYDAY_FILE_ID,
        name: 'photo.png',
        mimeType: 'image/png',
        trashed: false,
        size: '278',
      }),
    );
    const bytes = screenshotBytes();
    transport.on(`/files/${EVERYDAY_FILE_ID}`, { status: 200, body: '', bytes });

    const outcome = await createDriveSource(client(transport)).list(delta);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.items.length).toBe(0);
    expect(outcome.page.failures.length).toBe(0);
    const media = outcome.page.media?.[0];
    expect(media?.externalRef).toBe(externalRefFor('drive', EVERYDAY_FILE_ID));
    expect(media?.mediaType).toBe('image/png');
    // Byte-for-byte, and the fixture carries a NUL, a lone 0xFF and an illegal
    // UTF-8 pair precisely so a string round trip cannot survive this.
    expect([...(media?.bytes ?? [])]).toEqual([...bytes]);
    // Fetched as bytes, not as text: the request that produced them said so.
    const fetched = transport.requests.find((request) =>
      request.target.includes(`/files/${EVERYDAY_FILE_ID}`),
    );
    expect(fetched?.binary).toBe(true);
    // And the segment that carried it stayed inside the URL-safe alphabet. This
    // exact download is the one a standard-base64 encoder breaks.
    const segment = new URL(fetched?.url ?? '').pathname.split('/proxy/')[1] ?? '';
    expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('a voice memo is still refused, and visibly', async () => {
    // The closed set is the point of `classifyMedia`: opening the media door
    // must not open it to everything. A user who sends a voice memo has asked
    // for a feature that does not exist, and the row is what says so.
    const transport = withToken(createScriptedTransport());
    transport.on(
      '/changes?',
      changeFor({ id: 'f5', name: 'memo.m4a', mimeType: 'audio/mp4', trashed: false, size: '900' }),
    );

    const outcome = await createDriveSource(client(transport)).list(delta);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.media ?? []).toEqual([]);
    expect(outcome.page.failures[0]?.externalRef).toBe(externalRefFor('drive', 'f5'));
    expect(outcome.page.failures[0]?.reason).toBe('parse_failed');
    // And it was never downloaded. A refusal that fetches first is a refusal
    // that already paid for the thing it refused.
    expect(transport.requests.some((request) => request.target.includes('/files/f5'))).toBe(false);
  });

  test('an oversize file is refused from the listing, before it is fetched', async () => {
    // Nothing here streams, so an unbounded object is the whole file in memory
    // on the way to the object store. The listing already states the size; a
    // two-gigabyte PDF must never become a request.
    const transport = withToken(createScriptedTransport());
    transport.on(
      '/changes?',
      changeFor({
        id: 'f6',
        name: 'scans.pdf',
        mimeType: 'application/pdf',
        trashed: false,
        size: String(MAX_MEDIA_BYTES + 1),
      }),
    );

    const outcome = await createDriveSource(client(transport)).list(delta);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.media ?? []).toEqual([]);
    expect(outcome.page.failures[0]?.reason).toBe('parse_failed');
    expect(outcome.page.failures[0]?.retryable).toBe(false);
    expect(transport.requests.some((request) => request.target.includes('/files/f6'))).toBe(false);
  });

  test('a client that cannot answer in bytes holds the cursor rather than skipping the file', async () => {
    // This is a fact about how the fleet is wired, not about the file. A
    // non-retryable row here would advance the cursor past a change the
    // provider offers exactly once, and the user's screenshots would be gone
    // for good because of a transport nobody noticed was text-only.
    const transport = withToken(createScriptedTransport());
    transport.on(
      '/changes?',
      changeFor({ id: 'f7', name: 'wifi.png', mimeType: 'image/png', trashed: false }),
    );
    // No `bytes` on the answer: a transport that only speaks text.
    transport.on('/files/f7', { status: 200, body: 'not the bytes' });

    const outcome = await createDriveSource(client(transport)).list(delta);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.media ?? []).toEqual([]);
    expect(outcome.page.failures[0]?.reason).toBe('provider_error');
    expect(outcome.page.failures[0]?.retryable).toBe(true);
  });
});

/**
 * What a truncated page and a refused item must not lose.
 *
 * Every case below is the same defect wearing three provider costumes: the
 * adapter answers something the runner reads as "this item is finished with",
 * the cursor moves past it, and the change is never offered again. The brain
 * goes quiet while every surface reports it healthy, which for a memory product
 * is worse than crashing — the user cannot tell "nothing happened this week"
 * from "your mail stopped syncing in March".
 */
describe('a page that could not be finished', () => {
  test('a 429 on a message fetch is rate-limited and retryable, not a broken item', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/users/me/profile', { status: 200, body: { historyId: '1' } });
    transport.on('/users/me/messages?', { status: 200, body: { messages: [{ id: 'mr1' }] } });
    transport.on('/messages/mr1', { status: 429, body: { error: 'slow down' } });

    const source = createGmailSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'backfill',
      cursor: null,
      since: SINCE,
      maxItems: 10,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const failure = outcome.page.failures[0];
    expect(failure?.reason).toBe('rate_limited');
    // The whole point: the runner must not advance the cursor past this id.
    expect(failure?.retryable).toBe(true);
  });

  test('a 404 on a message fetch is permanent, so one dead id cannot wedge the source', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/users/me/profile', { status: 200, body: { historyId: '1' } });
    transport.on('/users/me/messages?', { status: 200, body: { messages: [{ id: 'mr2' }] } });
    transport.on('/messages/mr2', { status: 404, body: { error: 'not found' } });

    const source = createGmailSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'backfill',
      cursor: null,
      since: SINCE,
      maxItems: 10,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.failures[0]?.retryable).toBe(false);
  });

  test('a 429 on a drive file fetch is rate-limited and retryable', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/changes?', {
      status: 200,
      body: {
        newStartPageToken: 'p-9',
        changes: [
          {
            fileId: 'fr1',
            file: { id: 'fr1', name: 'plan.txt', mimeType: 'text/plain', trashed: false },
          },
        ],
      },
    });
    transport.on('/files/fr1', { status: 429, body: { error: 'slow down' } });

    const source = createDriveSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'delta',
      cursor: 'p-8',
      since: null,
      maxItems: 10,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.failures[0]?.reason).toBe('rate_limited');
    expect(outcome.page.failures[0]?.retryable).toBe(true);
  });

  test('a truncated history page resumes the page rather than jumping to the mailbox head', async () => {
    // `historyId` in the response is the mailbox's CURRENT record, not the last
    // one on this page. Storing it while a `nextPageToken` is outstanding skips
    // every change between the two, permanently.
    const transport = withToken(createScriptedTransport());
    transport.on('/history?', {
      status: 200,
      body: {
        historyId: '5600',
        nextPageToken: 'hp-2',
        history: [{ messagesAdded: [{ message: { id: 'mh1' } }] }],
      },
    });
    transport.on('/messages/mh1', {
      status: 200,
      body: {
        id: 'mh1',
        internalDate: `${Date.UTC(2026, 6, 2)}`,
        payload: { mimeType: 'text/plain', body: { data: base64url('a message body worth keeping') } },
      },
    });

    const source = createGmailSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'delta',
      cursor: '5500',
      since: null,
      maxItems: 100,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.nextCursor?.kind).toBe('delta');
    expect(outcome.page.nextCursor?.value).toBe('hp-2~5500');

    // And the cursor it produced drives the next page off the SAME start, so the
    // window between the page and the mailbox head is never skipped.
    const next = withToken(createScriptedTransport());
    next.on('/history?', { status: 200, body: { historyId: '5600', history: [] } });
    const resumed = await createGmailSource(client(next)).list({
      ...CONNECTION,
      mode: 'delta',
      cursor: 'hp-2~5500',
      since: null,
      maxItems: 100,
      now: NOW,
    });
    expect(resumed.ok).toBe(true);
    const url = next.requests.find((request) => request.target.includes('/history?'))?.target ?? '';
    expect(url).toContain('startHistoryId=5500');
    expect(url).toContain('pageToken=hp-2');
  });

  test('history changes beyond the item ceiling are failure rows, never a silent slice', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/history?', {
      status: 200,
      body: {
        historyId: '5700',
        history: [
          { messagesAdded: [{ message: { id: 'mc1' } }] },
          { messagesAdded: [{ message: { id: 'mc2' } }] },
        ],
      },
    });
    transport.on('/messages/mc1', {
      status: 200,
      body: {
        id: 'mc1',
        internalDate: `${Date.UTC(2026, 6, 3)}`,
        payload: { mimeType: 'text/plain', body: { data: base64url('the first of two messages') } },
      },
    });

    const source = createGmailSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'delta',
      cursor: '5600',
      since: null,
      maxItems: 1,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.items.length).toBe(1);
    const dropped = outcome.page.failures.find(
      (failure) => failure.externalRef === externalRefFor('gmail', 'mc2'),
    );
    expect(dropped).toBeDefined();
    expect(dropped?.retryable).toBe(true);
  });

  test('a pulled message is bound to the mailbox it came from', async () => {
    // `users.getProfile` carries the address beside the history id, and this
    // adapter used to read one and drop the other. Message ids are unique per
    // *mailbox*: unbound, account B's colliding id arrives as an update to
    // account A's page, under the same origin, where the tombstone fence
    // cannot tell the two apart.
    const transport = withToken(createScriptedTransport());
    transport.on('/users/me/profile', {
      status: 200,
      body: { historyId: '900', emailAddress: 'Owner@Example.test' },
    });
    transport.on('/users/me/messages?', { status: 200, body: { messages: [{ id: 'mb1' }] } });
    transport.on('/messages/mb1', {
      status: 200,
      body: {
        id: 'mb1',
        internalDate: `${Date.UTC(2026, 6, 4)}`,
        payload: { mimeType: 'text/plain', body: { data: base64url('a message in one mailbox') } },
      },
    });

    const source = createGmailSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'backfill',
      cursor: null,
      since: SINCE,
      maxItems: 10,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Normalised, because `Owner@` and `owner@` must not be two pages.
    expect(outcome.page.accountKey).toBe('owner@example.test');
    expect(outcome.page.items[0]?.externalRef).toBe(
      externalRefFor('gmail', 'mb1', 'owner@example.test'),
    );
    expect(outcome.page.items[0]?.externalRef).not.toBe(externalRefFor('gmail', 'mb1'));
  });

  test('a delta keys its refs by the account the first slice adopted', async () => {
    // A history walk does not re-observe the mailbox, so the runner hands the
    // adopted identity down. Without it the delta writes unnamespaced refs and
    // every update lands on a page the backfill never created.
    const transport = withToken(createScriptedTransport());
    transport.on('/history?', {
      status: 200,
      body: {
        historyId: '910',
        history: [{ labelsAdded: [{ message: { id: 'md1' }, labelIds: ['TRASH'] }] }],
      },
    });

    const source = createGmailSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      accountKey: 'owner@example.test',
      mode: 'delta',
      cursor: '900',
      since: null,
      maxItems: 10,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.accountKey).toBe('owner@example.test');
    expect(outcome.page.tombstones[0]?.externalRef).toBe(
      externalRefFor('gmail', 'md1', 'owner@example.test'),
    );
  });

  test('a truncated drive change page is a delta cursor, and it replays against /changes', async () => {
    // A `backfill` kind here is read by `pullModeFor` as a first import, and the
    // backfill leg hands a changes-feed token to `/drive/v3/files` — a token the
    // wrong endpoint cannot use, on a listing the window has already re-bounded.
    const transport = withToken(createScriptedTransport());
    transport.on('/changes?', {
      status: 200,
      body: { nextPageToken: 'cp-2', changes: [] },
    });

    const source = createDriveSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'delta',
      cursor: 'cp-1',
      since: null,
      maxItems: 100,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.nextCursor).toEqual({ kind: 'delta', value: 'cp-2' });

    const next = withToken(createScriptedTransport());
    next.on('/changes?', { status: 200, body: { newStartPageToken: 'cp-3', changes: [] } });
    await createDriveSource(client(next)).list({
      ...CONNECTION,
      mode: 'delta',
      cursor: 'cp-2',
      since: null,
      maxItems: 100,
      now: NOW,
    });
    const url = next.requests.find((request) => request.target.includes('/drive/v3/'))?.target ?? '';
    expect(url).toContain('/drive/v3/changes');
    expect(url).toContain('pageToken=cp-2');
  });

  test('a truncated calendar sync page carries its sync token forward', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/events?', {
      status: 200,
      body: { nextPageToken: 'ep-2', items: [] },
    });

    const source = createCalendarSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'delta',
      cursor: 'sync-1',
      since: null,
      maxItems: 100,
      now: NOW,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.nextCursor).toEqual({ kind: 'delta', value: 'ep-2~sync-1' });

    const next = withToken(createScriptedTransport());
    next.on('/events?', { status: 200, body: { nextSyncToken: 'sync-2', items: [] } });
    await createCalendarSource(client(next)).list({
      ...CONNECTION,
      mode: 'delta',
      cursor: 'ep-2~sync-1',
      since: null,
      maxItems: 100,
      now: NOW,
    });
    const url = next.requests.find((request) => request.target.includes('/events?'))?.target ?? '';
    expect(url).toContain('syncToken=sync-1');
    expect(url).toContain('pageToken=ep-2');
  });
});

/**
 * **Which upstream each adapter actually talks to.**
 *
 * The proxy forwards to an absolute URL, so the host is part of every request
 * these adapters make — and it is not interchangeable. Calendar under
 * `calendar.googleapis.com` answers Google's own `404`, which would reach the
 * runner as an empty calendar rather than as a mistake; Gmail is on a host of
 * its own. `PROVIDER_API_BASE` is the single place any of them is named, and
 * this is the test that stops it from being renamed without a vendor check:
 * each entry below was verified against the live project on 2026-08-17.
 *
 * Asserted over EVERY request an adapter makes, not a sampled one. The Drive
 * download and the Gmail per-message fetch are separate calls from the listing
 * that found them, and a base that was right for the listing and wrong for the
 * fetch is a connector that lists everything and imports nothing.
 */
describe('each adapter names its verified upstream', () => {
  const upstreams = [
    { name: 'gmail', base: 'https://gmail.googleapis.com', prefix: '/gmail/v1/' },
    { name: 'google_calendar', base: 'https://www.googleapis.com', prefix: '/calendar/v3/' },
    { name: 'google_drive', base: 'https://www.googleapis.com', prefix: '/drive/v3/' },
  ] as const;

  test('the table is the only place a host is named, and it says what was measured', () => {
    for (const upstream of upstreams) {
      expect(PROVIDER_API_BASE[upstream.name]).toBe(upstream.base);
    }
    // Gmail does not share the other two's host. Collapsing them is a one-line
    // edit that answers 404 for one source and 200 for the others.
    expect(PROVIDER_API_BASE.gmail).not.toBe(PROVIDER_API_BASE.google_drive);
  });

  test('gmail addresses every call to its own host', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/users/me/profile', { status: 200, body: { historyId: '5500', emailAddress: 'a@b.test' } });
    transport.on('/users/me/messages?', { status: 200, body: { messages: [{ id: 'm1' }] } });
    transport.on('/messages/m1', {
      status: 200,
      body: {
        id: 'm1',
        internalDate: `${Date.UTC(2026, 6, 1)}`,
        payload: { mimeType: 'text/plain', body: { data: base64url('a message body worth keeping') } },
      },
    });

    await createGmailSource(client(transport)).list({
      ...CONNECTION,
      mode: 'backfill',
      cursor: null,
      since: SINCE,
      maxItems: 100,
      now: NOW,
    });

    const targets = proxyTargets(transport);
    // The profile, the listing and the per-message fetch: three calls, one host.
    expect(targets.length).toBe(3);
    for (const target of targets) {
      expect(target.startsWith('https://gmail.googleapis.com/gmail/v1/')).toBe(true);
    }
  });

  test('calendar addresses its call to the host that answers it', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/events?', { status: 200, body: { nextSyncToken: 'sync-1', items: [] } });

    await createCalendarSource(client(transport)).list({
      ...CONNECTION,
      mode: 'backfill',
      cursor: null,
      since: SINCE,
      maxItems: 100,
      now: NOW,
    });

    const targets = proxyTargets(transport);
    expect(targets.length).toBe(1);
    expect(targets[0]?.startsWith('https://www.googleapis.com/calendar/v3/')).toBe(true);
    // The host that does NOT answer, named so the mistake is a failing test
    // rather than an empty calendar.
    expect(targets[0]).not.toContain('calendar.googleapis.com');
  });

  test('drive addresses the listing and the download alike', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/changes/startPageToken', { status: 200, body: { startPageToken: 'p-1' } });
    transport.on('/drive/v3/files?', {
      status: 200,
      body: {
        files: [
          { id: 'doc-1', name: 'strategy', mimeType: 'application/vnd.google-apps.document', trashed: false },
        ],
      },
    });
    transport.on('/files/doc-1/export', { status: 200, body: 'the strategy document, at some length' });

    await createDriveSource(client(transport)).list({
      ...CONNECTION,
      mode: 'backfill',
      cursor: null,
      since: SINCE,
      maxItems: 100,
      now: NOW,
    });

    const targets = proxyTargets(transport);
    expect(targets.length).toBe(3);
    for (const target of targets) {
      expect(target.startsWith('https://www.googleapis.com/drive/v3/')).toBe(true);
    }
  });
});
