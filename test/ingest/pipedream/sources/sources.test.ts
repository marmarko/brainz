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

import { createPipedreamClient } from '../../../../src/ingest/pipedream/client.ts';
import { createCalendarSource } from '../../../../src/ingest/pipedream/sources/calendar.ts';
import { createDriveSource } from '../../../../src/ingest/pipedream/sources/drive.ts';
import { createGmailSource } from '../../../../src/ingest/pipedream/sources/gmail.ts';
import { externalRefFor } from '../../../../src/ingest/pipedream/sources/types.ts';
import { CONFIG, createScriptedTransport, withToken } from '../fixture.ts';

const NOW = new Date('2026-08-13T10:00:00.000Z');
const SINCE = new Date('2026-05-15T00:00:00.000Z');

function client(transport: ReturnType<typeof createScriptedTransport>) {
  return createPipedreamClient({ config: CONFIG, transport, now: () => NOW });
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

const CONNECTION = { externalUserId: 'tenant-a', accountId: 'apn_1' } as const;

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
    expect(transport.requests.some((request) => request.url.includes('after%3A2026%2F05%2F15'))).toBe(
      true,
    );
    // And the id was taken BEFORE the listing: a message that arrives mid-list
    // must land in the delta that follows rather than in the gap between them.
    const profileAt = transport.requests.findIndex((request) =>
      request.url.includes('/users/me/profile'),
    );
    const listAt = transport.requests.findIndex((request) =>
      request.url.includes('/users/me/messages?'),
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
    expect(transport.requests.some((request) => request.url.includes('/messages/m5'))).toBe(false);
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
    expect(transport.requests.some((request) => request.url.includes('/messages/m10'))).toBe(false);
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

  test('a binary file is not decoded leniently into a page of noise', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/changes?', {
      status: 200,
      body: {
        newStartPageToken: 'p-9',
        changes: [
          {
            fileId: 'f4',
            file: { id: 'f4', name: 'photo.png', mimeType: 'image/png', trashed: false },
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
    expect(outcome.page.items.length).toBe(0);
    // U21 owns the media path; what belongs here is the honest skip.
    expect(outcome.page.failures[0]?.reason).toBe('parse_failed');
  });
});
