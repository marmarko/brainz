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

import {
  PROVIDER_API_BASE,
  createPipedreamClient,
} from '../../../../src/ingest/pipedream/client.ts';
import {
  CALENDAR_HORIZON_DAYS,
  createCalendarSource,
} from '../../../../src/ingest/pipedream/sources/calendar.ts';
import { createDriveSource } from '../../../../src/ingest/pipedream/sources/drive.ts';
import { createGmailSource } from '../../../../src/ingest/pipedream/sources/gmail.ts';
import { externalRefFor } from '../../../../src/ingest/pipedream/sources/types.ts';
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

  test('a backfill asks for a bounded window, not everything after timeMin', async () => {
    // `singleEvents: true` expands a recurring event into one item per
    // occurrence. Without a ceiling that is unbounded, and it was not
    // hypothetical: the founder's brain held 875 calendar pages dated after
    // 2027, the furthest in 2056, from two weekly meetings.
    const transport = withToken(createScriptedTransport());
    transport.on('/events?', { status: 200, body: { items: [], nextSyncToken: 'sync-9' } });

    await createCalendarSource(client(transport), () => NOW).list({
      ...CONNECTION,
      mode: 'backfill',
      cursor: null,
      since: SINCE,
      maxItems: 100,
      now: NOW,
    });

    const target = proxyTargets(transport)[0] ?? '';
    const asked = new URL(target);
    expect(asked.searchParams.get('singleEvents')).toBe('true');
    expect(asked.searchParams.get('timeMin')).toBe(SINCE.toISOString());
    // NOW + CALENDAR_HORIZON_DAYS, and nothing further.
    expect(asked.searchParams.get('timeMax')).toBe(
      new Date(NOW.getTime() + CALENDAR_HORIZON_DAYS * 86_400_000).toISOString(),
    );
  });

  test('a delta enforces the same horizon on the items, because it may not ask for it', async () => {
    // Measured against the live project: `syncToken` + `timeMax` answers 400.
    // Google refuses a window on an incremental sync, so the delta branch must
    // not send one — and must therefore apply it to what comes back.
    const transport = withToken(createScriptedTransport());
    const beyond = new Date(NOW.getTime() + (CALENDAR_HORIZON_DAYS + 30) * 86_400_000);
    const inside = new Date(NOW.getTime() + 10 * 86_400_000);
    transport.on('/events?', {
      status: 200,
      body: {
        nextSyncToken: 'sync-2',
        items: [
          { id: 'near', status: 'confirmed', summary: 'Standup', start: { dateTime: inside.toISOString() } },
          { id: 'far', status: 'confirmed', summary: 'Standup', start: { dateTime: beyond.toISOString() } },
          // All-day events carry `date`, not `dateTime` — a birthday thirty
          // years out arrives in this shape and must be bounded too.
          { id: 'far-allday', status: 'confirmed', summary: 'Birthday', start: { date: '2056-04-22' } },
        ],
      },
    });

    const outcome = await createCalendarSource(client(transport), () => NOW).list({
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
      externalRefFor('calendar', 'near'),
    ]);
    // Skipped, not failed and not tombstoned. A failure is retryable and would
    // hold the cursor on an event that is never going to become wanted; a
    // tombstone would be permanent, and a delta feed never re-offers an
    // unchanged event, so the occurrence would never return when it came close.
    expect(outcome.page.failures).toEqual([]);
    expect(outcome.page.tombstones).toEqual([]);
    // And the delta request carried no window, because the vendor refuses one.
    const asked = new URL(proxyTargets(transport)[0] ?? '');
    expect(asked.searchParams.get('timeMax')).toBeNull();
    expect(asked.searchParams.get('syncToken')).toBe('sync-1');
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
    // The page is the file's name and metadata, and the fetch that used to
    // produce a body is gone: no `/export`, no `alt=media`, no request for this
    // file at all.
    expect(outcome.page.items[0]?.title).toBe('strategy.txt');
    expect(outcome.page.items[0]?.body).toContain('strategy.txt');
    expect(proxyTargets(transport).some((target) => target.includes('/files/f3'))).toBe(false);
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
   * **Every file type is now one route, and it issues no per-file call.**
   *
   * These four used to be four: a native Doc exported to `text/plain`, a
   * spreadsheet to `text/csv`, a PDF and a PNG fetched as bytes, a voice memo
   * refused outright, and a two-gigabyte file refused from the listing so it
   * never became a request. The founder's ruling collapses all of them —
   * "we shouldn't be storing files from the drive, just filename and metadata"
   * — and the collapse is asserted as an absence of requests rather than as an
   * absence of media, because the requests are what cost money and what wedged
   * the source.
   *
   * The byte-fidelity test and the base64url path-segment test that stood here
   * were deleted rather than adapted: with no download there is no path segment
   * to guard and no bytes to round-trip. `client.test.ts` still owns the
   * encoder's own alphabet.
   */
  test('a doc, a sheet, a pdf, an image and a video are all just metadata', async () => {
    const files = [
      { id: 'f-doc', name: 'Board update', mimeType: 'application/vnd.google-apps.document' },
      { id: 'f-sheet', name: 'Runway model', mimeType: 'application/vnd.google-apps.spreadsheet' },
      { id: 'f-pdf', name: 'certificate.pdf', mimeType: 'application/pdf', size: '216327' },
      { id: 'f-png', name: 'wifi.png', mimeType: 'image/png', size: '278' },
      { id: 'f-video', name: 'demo.mp4', mimeType: 'video/mp4', size: String(4 * 1024 ** 3) },
    ].map((file) => ({
      ...file,
      trashed: false,
      createdTime: '2026-01-04T09:00:00.000Z',
      modifiedTime: '2026-08-12T09:00:00.000Z',
      webViewLink: `https://drive.example-drive.test/file/d/${file.id}/view`,
      owners: [{ displayName: 'alice-example', emailAddress: 'alice@widget-co.example' }],
    }));

    const transport = withToken(createScriptedTransport());
    transport.on('/changes?', {
      status: 200,
      body: { newStartPageToken: 'p-9', changes: files.map((file) => ({ fileId: file.id, file })) },
    });

    const outcome = await createDriveSource(client(transport)).list(delta);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.failures).toEqual([]);
    expect(outcome.page.items.map((item) => item.title)).toEqual(files.map((file) => file.name));
    // A four-gigabyte video is a page now, and it cost nothing: the size that
    // used to refuse it from the listing is a line on the page instead.
    expect(outcome.page.items[4]?.body).toContain('4 GB');
    // One call — the changes feed. Not one per file.
    expect(proxyTargets(transport).length).toBe(1);
  });

  test('the body carries what a person needs to recognise the file and open it', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on(
      '/changes?',
      changeFor({
        id: 'f-recognise',
        name: 'Q3 board deck',
        mimeType: 'application/vnd.google-apps.presentation',
        trashed: false,
        size: '57600544',
        createdTime: '2013-01-09T08:46:49.002Z',
        modifiedTime: '2026-08-04T04:06:32.913Z',
        webViewLink: 'https://docs.example-drive.test/presentation/d/f-recognise/edit',
        owners: [{ displayName: 'alice-example', emailAddress: 'alice@widget-co.example' }],
      }),
    );

    const outcome = await createDriveSource(client(transport)).list(delta);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const body = outcome.page.items[0]?.body ?? '';
    // The filename first and unlabelled, because it is the whole value of the
    // source and the full-text arm ranks on the chunk body.
    expect(body.startsWith('Q3 board deck\n')).toBe(true);
    // A word a person searches with, beside the type only a machine reads.
    expect(body).toContain('Google Slides presentation (application/vnd.google-apps.presentation)');
    expect(body).toContain('Owner: alice-example (alice@widget-co.example)');
    expect(body).toContain('Size: 55 MB');
    expect(body).toContain('Created: 2013-01-09T08:46:49.002Z');
    expect(body).toContain('Modified: 2026-08-04T04:06:32.913Z');
    expect(body).toContain('Link: https://docs.example-drive.test/presentation/d/f-recognise/edit');
    // `occurredAt` is the provider's own modified time, so the page orders and
    // windows by when the file last moved.
    expect(outcome.page.items[0]?.occurredAt?.toISOString()).toBe('2026-08-04T04:06:32.913Z');
  });

  test('a file described by nothing but an id still has a body, because an empty one is not a page', async () => {
    // `chunkDocument` returns no chunks for a blank body and `ingestDocument`
    // answers `empty_document`, so a body that can come out empty is an item
    // the runner counts failed. The changes feed returns exactly this shape for
    // a file whose metadata the grant can no longer read.
    const transport = withToken(createScriptedTransport());
    transport.on('/changes?', {
      status: 200,
      body: { newStartPageToken: 'p-9', changes: [{ fileId: 'f-bare', file: { id: 'f-bare' } }] },
    });

    const outcome = await createDriveSource(client(transport)).list(delta);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.failures).toEqual([]);
    expect(outcome.page.items[0]?.title).toBeNull();
    expect((outcome.page.items[0]?.body ?? '').trim().length).toBeGreaterThan(0);
  });

  test('a file the provider named nothing cannot become a page, and asking again will not help', async () => {
    // There is no idempotency key without an id, so this is the one refusal the
    // metadata path still has — and it must not hold the cursor, or the source
    // wedges on a row that is never going to grow an id.
    const transport = withToken(createScriptedTransport());
    transport.on('/changes?', {
      status: 200,
      body: { newStartPageToken: 'p-9', changes: [{ fileId: 'f-nameless', file: { name: 'x' } }] },
    });

    const outcome = await createDriveSource(client(transport)).list(delta);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.page.items).toEqual([]);
    expect(outcome.page.failures).toEqual([
      { externalRef: null, reason: 'parse_failed', retryable: false },
    ]);
  });

  /**
   * **A folder is not a document that failed to parse — it is not a document.**
   *
   * Measured against the founder's live Drive on 2026-08-17: page one of
   * `/drive/v3/files` carried 4 folders among 26 entries. Every one of them
   * reached `classifyMedia`, was refused for a content type that is not a
   * content type, and became a `parse_failed` row in `ingest_log` — four bogus
   * refusals per run, forever, against a Drive whose folder tree never changes.
   *
   * Two separate costs, so two separate guards below. The rows are the first:
   * `items_failed` is the number the connector panel shows an operator, and a
   * source that reports 18 failures when 14 files were genuinely refused is a
   * diagnosis surface lying about its own subject. The second is the page
   * budget — see the test after this one.
   */
  test('a folder is skipped, not recorded as a document that would not parse', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on(
      '/changes?',
      changeFor({
        id: 'folder-1',
        name: 'Board decks',
        mimeType: 'application/vnd.google-apps.folder',
        trashed: false,
      }),
    );

    const outcome = await createDriveSource(client(transport)).list(delta);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Not a failure, not an item, not an object: a folder has no content, and
    // the adapter's job is to turn provider objects into pages.
    expect(outcome.page.failures).toEqual([]);
    expect(outcome.page.items).toEqual([]);
    // And it cost no request. A folder has no bytes to download and no export
    // to ask for, so reaching the network for one is a call that can only fail.
    expect(proxyTargets(transport).some((target) => target.includes('folder-1'))).toBe(false);
  });

  /**
   * **The listing refuses folders at the provider, so they never cost a slice.**
   *
   * The changes feed takes no `q`, which is why the guard above exists at all;
   * the backfill listing does, and a folder that arrives is a slot of
   * `maxItems` spent on something that can never become a page. Live on
   * 2026-08-17 the same account answered 4 folders + 22 files unfiltered and 26
   * files with the clause below — 15% of a first import's page budget, on every
   * page, for the life of the backfill.
   */
  test('the backfill listing asks the provider not to send folders at all', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/changes/startPageToken', { status: 200, body: { startPageToken: 'p-1' } });
    transport.on('/drive/v3/files?', { status: 200, body: { files: [] } });

    await createDriveSource(client(transport)).list({
      ...CONNECTION,
      mode: 'backfill',
      cursor: null,
      since: SINCE,
      maxItems: 100,
      now: NOW,
    });

    const listing = proxyTargets(transport).find((target) => target.includes('/drive/v3/files?')) ?? '';
    const q = new URL(listing).searchParams.get('q') ?? '';
    expect(q).toContain('trashed = false');
    // The window clause is still there: refusing folders must not cost the
    // bound that keeps a first import inside the tenant's window.
    expect(q).toContain(`modifiedTime > '${SINCE.toISOString()}'`);
    expect(q).toContain("mimeType != 'application/vnd.google-apps.folder'");
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

  test('a 429 on the drive listing is rate-limited, and there is no per-file fetch to rate-limit', async () => {
    // Drive used to have two places a 429 could land — the listing and the
    // per-file fetch — and the second one had to be told apart from a dead file
    // or the change was never offered again. Metadata-only leaves exactly one:
    // the listing itself, whose refusal is the whole page's, so the cursor is
    // untouched and the pull retries.
    const transport = withToken(createScriptedTransport());
    transport.on('/changes?', { status: 429, body: { error: 'slow down' } });

    const source = createDriveSource(client(transport));
    const outcome = await source.list({
      ...CONNECTION,
      mode: 'delta',
      cursor: 'p-8',
      since: null,
      maxItems: 10,
      now: NOW,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('rate_limited');
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

  test('drive addresses the change token and the listing, and nothing else', async () => {
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

    await createDriveSource(client(transport)).list({
      ...CONNECTION,
      mode: 'backfill',
      cursor: null,
      since: SINCE,
      maxItems: 100,
      now: NOW,
    });

    const targets = proxyTargets(transport);
    // Two, not three: the export that used to follow every native document is
    // gone. A first import of a thousand files is still two calls per page.
    expect(targets.length).toBe(2);
    for (const target of targets) {
      expect(target.startsWith('https://www.googleapis.com/drive/v3/')).toBe(true);
    }
  });
});
