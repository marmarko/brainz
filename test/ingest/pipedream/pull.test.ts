/**
 * The pull runner: everything a poller does that an importer does not.
 *
 * Four properties, and each one is a different way a connector quietly ruins a
 * brain:
 *
 *   1. **Idempotency.** A poller re-reads the same items on every cadence. If
 *      the second read costs an embedding call, the connector is a bill.
 *   2. **Update and tombstone semantics.** An item whose upstream version moved
 *      re-chunks through U4's reconcile path; an item deleted, trashed or
 *      cancelled upstream is tombstoned. Without the second one a cancelled
 *      meeting keeps appearing in tomorrow's briefing, and U11 reads the stale
 *      row against its replacement and reports a contradiction that never
 *      happened.
 *   3. **A backfill is gated; a delta pull is not a backfill.** Cursor expiry is
 *      not an edge case — Calendar mandates a full re-sync on `410 GONE` and
 *      Gmail's history window expires the same way — so every stalled tenant
 *      arrives at "re-list everything". That path routes through U8's gate or
 *      it is an unbounded first import wearing a poller's clothes.
 *   4. **The junk gate runs in front of the meter.** A newsletter backlog must
 *      not be embedded at full price, and "in front of the meter" is a claim
 *      about the transport's own record, not about a verdict object.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { HOSTED_PROFILE } from '../../../src/ai/routing.ts';
import { ingestDocument } from '../../../src/core/write/write-path.ts';
import {
  connectSource,
  createInMemoryConnectorStore,
  type ConnectorState,
  type ConnectorStateStore,
} from '../../../src/ingest/cursor.ts';
import { sourceStaleness } from '../../../src/ingest/log.ts';
import { pauseSource, readPausedSources, resumeSource } from '../../../src/ingest/pause.ts';
import {
  createIngestPullHandler,
  enqueuePullIfDue,
  originContextFor,
  runPull,
  type PullResult,
} from '../../../src/ingest/pipedream/pull.ts';
import type { JobLease } from '../../../src/worker/jobs.ts';
import {
  externalRefFor,
  type PulledMedia,
} from '../../../src/ingest/pipedream/sources/types.ts';
import { selectPendingAttachments } from '../../../src/core/media/ocr-phase.ts';
import { acceptMedia, transcriptRefFor } from '../../../src/core/media/accept.ts';
import {
  CALLER,
  TENANT,
  contentDigest,
  countRows,
  createIngestFixture,
  ingestLogRows,
  uncappedBudget,
  type IngestFixture,
} from '../fixture.ts';
import { screenshotBytes } from '../../media/fixture.ts';
import { createFakeSource, mailBody, page } from './fixture.ts';

let fixture: IngestFixture;

const NOW = new Date('2026-08-13T10:00:00.000Z');
const GMAIL_ORIGIN = originContextFor('gmail');
const CALENDAR_ORIGIN = originContextFor('calendar');
/** Stands in for a chunk of the user's mail; asserted absent from the encoder. */
const NEWSLETTER_CANARY = 'CANARY-9f2a-newsletter-must-not-be-embedded';

beforeAll(async () => {
  fixture = await createIngestFixture('u9pull');
});

afterAll(async () => {
  await fixture.close();
});

function stateFor(
  source: 'gmail' | 'calendar' | 'drive',
  overrides: Partial<ConnectorState> = {},
): ConnectorState {
  return {
    ...connectSource({ source, externalUserId: TENANT, accountId: 'apn_1', now: NOW }),
    ...overrides,
  };
}

async function storeWith(state: ConnectorState): Promise<ConnectorStateStore> {
  const store = createInMemoryConnectorStore();
  await store.write(state);
  return store;
}

function item(source: 'gmail' | 'calendar' | 'drive', id: string, body: string, occurredAt = NOW) {
  return { externalRef: externalRefFor(source, id), title: `subject ${id}`, body, occurredAt };
}

interface PullOptions {
  readonly window?: { readonly days: number } | 'all';
  readonly interactive?: boolean;
  readonly queue?: IngestFixture['queue'];
  readonly now?: Date;
  /** False runs the pull with nowhere to put an object, which is its own case. */
  readonly withStorage?: boolean;
}

async function pull(
  source: ReturnType<typeof createFakeSource>,
  states: ConnectorStateStore,
  options: PullOptions = {},
) {
  return runPull({
    tenant: fixture.runtime,
    control: fixture.controlSql,
    profile: HOSTED_PROFILE,
    source,
    states,
    now: options.now ?? NOW,
    ...(options.withStorage === false
      ? {}
      : { storage: fixture.storage, rawStore: fixture.rawStore }),
    ...(options.window === undefined ? {} : { window: options.window }),
    ...(options.interactive === undefined ? {} : { interactive: options.interactive }),
    ...(options.queue === undefined ? {} : { queue: options.queue }),
  });
}

async function pageCount(externalRef: string, where = 'deleted_at IS NULL'): Promise<number> {
  return countRows(fixture.tenantSql, 'page', `external_ref = '${externalRef}' AND ${where}`);
}

describe('idempotency and resumption', () => {
  test('an interrupted pull resumes without duplicating items', async () => {
    const source = createFakeSource('gmail', 'email', [
      page({ items: [item('gmail', 'i1', mailBody('i1'))], nextCursor: { kind: 'delta', value: 'h-1' } }),
      page({ items: [item('gmail', 'i1', mailBody('i1'))], nextCursor: { kind: 'delta', value: 'h-2' } }),
    ]);
    const states = await storeWith(stateFor('gmail'));

    const first = await pull(source, states);
    expect(first.outcome).toBe('completed');
    expect(first.counts.written).toBe(1);

    const before = fixture.transport.calls.length;
    const second = await pull(source, states);
    expect(second.counts.unchanged).toBe(1);
    expect(second.counts.written).toBe(0);
    // The idempotent re-read costs no provider call at all.
    expect(fixture.transport.calls.length).toBe(before);
    expect(await pageCount(externalRefFor('gmail', 'i1'))).toBe(1);
  });

  test('the cursor advances only after the work is banked', async () => {
    const source = createFakeSource('gmail', 'email', [
      page({ items: [item('gmail', 'i2', mailBody('i2'))], nextCursor: { kind: 'delta', value: 'h-7' } }),
    ]);
    const states = await storeWith(stateFor('gmail'));

    const result = await pull(source, states);
    expect(result.cursorAdvanced).toBe(true);
    const after = await states.read('gmail');
    expect(after?.cursor).toEqual({ kind: 'delta', value: 'h-7', issuedAt: NOW.toISOString() });
    expect(after?.lastPullAt).toBe(NOW.toISOString());
  });

  test('a provider failure leaves the cursor where it was', async () => {
    const states = await storeWith(
      stateFor('gmail', { cursor: { kind: 'delta', value: 'h-7', issuedAt: NOW.toISOString() } }),
    );
    const source = createFakeSource('gmail', 'email', [{ ok: false, reason: 'provider_error' }]);

    const result = await pull(source, states);
    expect(result.outcome).toBe('failed');
    const after = await states.read('gmail');
    expect(after?.cursor?.value).toBe('h-7');
    // The attempt is stamped even though it failed. Without this the source is
    // due again on the very next tick, which is a poll loop against a provider
    // that has already said no.
    expect(after?.lastPullAt).toBe(NOW.toISOString());
  });
});

describe('update and tombstone semantics', () => {
  test('an edited item re-chunks and its superseded chunks stop ranking', async () => {
    const ref = externalRefFor('drive', 'd1');
    const states = await storeWith(stateFor('drive'));
    const source = createFakeSource('drive', 'document', [
      page({ items: [item('drive', 'd1', mailBody('first version'))], nextCursor: { kind: 'delta', value: 'p1' } }),
      page({ items: [item('drive', 'd1', mailBody('second version'))], nextCursor: { kind: 'delta', value: 'p2' } }),
    ]);

    await pull(source, states);
    const second = await pull(source, states);
    expect(second.counts.written).toBe(1);

    expect(await pageCount(ref)).toBe(1);
    expect(await pageCount(ref, 'deleted_at IS NOT NULL')).toBe(1);
    const liveChunks = await countRows(
      fixture.tenantSql,
      'chunk c',
      `c.deleted_at IS NULL AND c.page_id IN (SELECT page_id FROM page WHERE external_ref = '${ref}' AND deleted_at IS NULL)`,
    );
    const staleChunks = await countRows(
      fixture.tenantSql,
      'chunk c',
      `c.deleted_at IS NULL AND c.page_id IN (SELECT page_id FROM page WHERE external_ref = '${ref}' AND deleted_at IS NOT NULL)`,
    );
    expect(liveChunks).toBeGreaterThan(0);
    expect(staleChunks).toBe(0);
  });

  test('a cancelled calendar event is tombstoned and leaves no live row behind', async () => {
    const ref = externalRefFor('calendar', 'e1');
    const states = await storeWith(stateFor('calendar'));
    const source = createFakeSource('calendar', 'calendar', [
      page({
        // States a fact, deliberately: a page tombstoned with its facts left
        // standing is the stale claim U11 reports as a genuine contradiction,
        // and a body that extracts nothing would assert that vacuously.
        items: [
          item(
            'calendar',
            'e1',
            `Alice Example is a partner at Widget Co. ${mailBody('board meeting agenda')}`,
          ),
        ],
        nextCursor: { kind: 'delta', value: 'sync-1' },
      }),
      page({
        tombstones: [{ externalRef: ref, reason: 'cancelled' }],
        nextCursor: { kind: 'delta', value: 'sync-2' },
      }),
    ]);

    await pull(source, states);
    expect(await pageCount(ref)).toBe(1);
    const factsBefore = await countRows(
      fixture.tenantSql,
      'fact f',
      `f.deleted_at IS NULL AND f.page_id IN (SELECT page_id FROM page WHERE external_ref = '${ref}')`,
    );
    expect(factsBefore).toBeGreaterThan(0);

    const second = await pull(source, states);
    expect(second.counts.tombstoned).toBe(1);
    expect(await pageCount(ref)).toBe(0);

    // The rows U11 would read as a contradiction are gone too, not merely the
    // page: a live fact whose page is tombstoned is exactly the stale claim the
    // contradiction detector reports as a genuine conflict.
    const liveFacts = await countRows(
      fixture.tenantSql,
      'fact f',
      `f.deleted_at IS NULL AND f.page_id IN (SELECT page_id FROM page WHERE external_ref = '${ref}')`,
    );
    const liveChunks = await countRows(
      fixture.tenantSql,
      'chunk c',
      `c.deleted_at IS NULL AND c.page_id IN (SELECT page_id FROM page WHERE external_ref = '${ref}')`,
    );
    expect(liveFacts).toBe(0);
    expect(liveChunks).toBe(0);
  });

  test('a delta pull corrects an item older than the window rather than advancing past it', async () => {
    // The bounded window exists to cap a FIRST import. A delta feed is already
    // bounded — it carries only what changed — so windowing it buys nothing and
    // costs the one thing a poller cannot recover: the edit is dropped AND the
    // cursor advances past it, so the provider never offers that change again.
    // The row is then stale for good, which is precisely the row U11 reads
    // against its live replacement and reports as a genuine contradiction.
    //
    // Calendar makes it concrete because `occurredAt` is the event's start, not
    // the edit's timestamp: a meeting held seven months ago whose notes are
    // added today arrives with a seven-month-old date.
    const ref = externalRefFor('calendar', 'e-old');
    const longAgo = new Date(NOW.getTime() - 200 * 24 * 60 * 60 * 1000);
    const asBooked = `${mailBody('agenda as booked')} The room is Oak.`;
    const corrected = `${mailBody('agenda as booked')} The room is Birch.`;
    const states = await storeWith(stateFor('calendar'));
    const source = createFakeSource('calendar', 'calendar', [
      page({
        items: [item('calendar', 'e-old', asBooked, longAgo)],
        nextCursor: { kind: 'delta', value: 'sync-old-1' },
      }),
      page({
        items: [item('calendar', 'e-old', corrected, longAgo)],
        nextCursor: { kind: 'delta', value: 'sync-old-2' },
      }),
    ]);

    // The first pull is a backfill, widened so the old event lands at all.
    const first = await pull(source, states, { window: 'all' });
    expect(first.counts.written).toBe(1);

    // The second rides the delta cursor, carrying the default window a cadence
    // tick carries.
    const second = await pull(source, states);
    expect(second.mode).toBe('delta');
    expect(second.attemptedItems).toBe(1);
    expect(second.counts.written).toBe(1);
    // Nothing was left out, so nothing is reported as left out.
    expect(second.widen.excludedItems).toBe(0);

    const live = (await fixture.tenantSql`
      SELECT content_sha256 FROM page WHERE external_ref = ${ref} AND deleted_at IS NULL
    `) as Array<{ content_sha256: string }>;
    expect(live.length).toBe(1);
    expect(live[0]?.content_sha256).toBe(contentDigest('subject e-old', corrected));
  });

  test('the event time the adapter computed reaches the page, not the pull time', async () => {
    // `occurredAt` was computed on every pull from the first day and persisted
    // nowhere, so the briefing's "today's meetings" was really "meetings that
    // arrived today" — a call at 10:00 today that synced last night was absent
    // from this morning's briefing. Asserted against the *column*, because the
    // adapter has always produced this value and only the write is new.
    const starts = new Date('2026-08-20T15:30:00.000Z');
    const ref = externalRefFor('calendar', 'e-future');
    const states = await storeWith(stateFor('calendar'));
    const source = createFakeSource('calendar', 'calendar', [
      page({
        items: [item('calendar', 'e-future', mailBody('quarterly planning'), starts)],
        nextCursor: { kind: 'delta', value: 'sync-occ' },
      }),
    ]);

    const outcome = await pull(source, states, { window: 'all' });
    expect(outcome.counts.written).toBe(1);

    const rows = (await fixture.tenantSql`
      SELECT occurred_at, created_at FROM page
       WHERE external_ref = ${ref} AND deleted_at IS NULL
    `) as Array<{ occurred_at: Date | null; created_at: Date }>;
    expect(rows[0]?.occurred_at?.toISOString()).toBe(starts.toISOString());
    // The two must differ, or this fixture cannot tell the columns apart.
    expect(rows[0]?.created_at.toISOString()).not.toBe(starts.toISOString());
  });

  test('a tombstone for an item this brain never held is not an error', async () => {
    const states = await storeWith(stateFor('calendar'));
    const source = createFakeSource('calendar', 'calendar', [
      page({
        tombstones: [{ externalRef: externalRefFor('calendar', 'never-seen'), reason: 'cancelled' }],
        nextCursor: { kind: 'delta', value: 'sync-3' },
      }),
    ]);

    const result = await pull(source, states);
    expect(result.outcome).toBe('completed');
    expect(result.counts.tombstoned).toBe(0);
  });

  test('a tombstone cannot reach across origins', async () => {
    // The connector's own origin is the only thing it may tombstone. A pull
    // that swept by external ref alone would delete a page a different source
    // wrote — R15's fence, at the deletion end.
    const ref = externalRefFor('calendar', 'shared-id');
    const receipt = await ingestDocument(
      {
        sql: fixture.tenantSql,
        gateway: fixture.gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget(),
      },
      {
        originContext: 'folder:notes',
        sourceType: 'note',
        title: 'a note that happens to share an id',
        body: mailBody('unrelated'),
        externalRef: ref,
      },
    );
    expect(receipt.ok).toBe(true);

    const states = await storeWith(stateFor('calendar'));
    const source = createFakeSource('calendar', 'calendar', [
      page({ tombstones: [{ externalRef: ref, reason: 'cancelled' }], nextCursor: { kind: 'delta', value: 's4' } }),
    ]);

    const result = await pull(source, states);
    expect(result.counts.tombstoned).toBe(0);
    expect(await pageCount(ref)).toBe(1);
  });
});

describe('the junk gate runs before the meter', () => {
  test('a newsletter is quarantined-hidden and its body never reaches the encoder', async () => {
    const states = await storeWith(stateFor('gmail'));
    const body = `${NEWSLETTER_CANARY} ${mailBody('weekly roundup')}`;
    const source = createFakeSource('gmail', 'email', [
      page({
        items: [
          {
            ...item('gmail', 'n1', body),
            junk: {
              headers: { 'List-Unsubscribe': '<https://news.example.test/u>' },
              from: 'weekly@news.example.test',
            },
          },
        ],
        nextCursor: { kind: 'delta', value: 'h-11' },
      }),
    ]);

    const result = await pull(source, states);
    expect(result.counts.quarantined).toBe(1);
    expect(result.counts.written).toBe(0);

    // In front of the *estimate*, not only in front of the write: a mailbox of
    // newsletters must not inflate the approval it will never spend.
    expect(result.estimate?.items).toBe(1);
    expect(result.estimate?.chunks).toBe(0);

    // The page is stored — re-derivable, and countable — but hidden.
    expect(
      await countRows(
        fixture.tenantSql,
        'page',
        `external_ref = '${externalRefFor('gmail', 'n1')}' AND quarantined_at IS NOT NULL`,
      ),
    ).toBe(1);
    // And not one character of it was ever sent to be embedded.
    expect(fixture.transport.texts.join('\n')).not.toContain(NEWSLETTER_CANARY);

    const rows = await ingestLogRows(fixture.tenantSql);
    const itemRow = rows.find((row) => row.external_ref === externalRefFor('gmail', 'n1'));
    expect(itemRow?.items_quarantined).toBe(1);
  });

  test('a receipt is warned-but-searchable: embedded, retrievable, not hidden', async () => {
    const states = await storeWith(stateFor('gmail'));
    const source = createFakeSource('gmail', 'email', [
      page({
        items: [
          {
            ...item('gmail', 'r1', mailBody('order 4417 receipt')),
            junk: {
              headers: { 'Auto-Submitted': 'auto-generated' },
              from: 'no-reply@store.example.test',
              subject: 'Your receipt from a store (order 4417)',
            },
          },
        ],
        nextCursor: { kind: 'delta', value: 'h-12' },
      }),
    ]);

    const result = await pull(source, states);
    expect(result.counts.written).toBe(1);
    expect(result.counts.warned).toBe(1);
    expect(
      await countRows(
        fixture.tenantSql,
        'page',
        `external_ref = '${externalRefFor('gmail', 'r1')}' AND quarantined_at IS NULL`,
      ),
    ).toBe(1);
  });
});

describe('staleness events', () => {
  test('a token refresh failure surfaces in the ingest log, not as a silent stop', async () => {
    const states = await storeWith(stateFor('drive'));
    const source = createFakeSource('drive', 'document', [{ ok: false, reason: 'auth_expired' }]);

    const result = await pull(source, states);
    expect(result.outcome).toBe('failed');
    expect(result.stopReason).toBe('auth_expired');

    const staleness = await sourceStaleness(fixture.tenantSql, { now: NOW });
    const drive = staleness.find((row) => row.originContext === originContextFor('drive'));
    expect(drive?.lastFailureCode).toBe('auth_expired');
    expect(drive?.runInProgress).toBe(false);
  });

  test('an invalidated cursor discards the cursor, logs the event, and re-imports through the gate', async () => {
    const states = await storeWith(
      stateFor('gmail', { cursor: { kind: 'delta', value: 'h-old', issuedAt: NOW.toISOString() } }),
    );
    const old = new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000);
    const source = createFakeSource('gmail', 'email', [
      { ok: false, reason: 'cursor_invalid' },
      page({
        items: [
          item('gmail', 'c1', mailBody('inside the window')),
          item('gmail', 'c2', mailBody('older than the window'), old),
        ],
        nextCursor: { kind: 'delta', value: 'h-new' },
        outsideWindow: 40_000,
      }),
    ]);

    const failedRunsBefore = (await ingestLogRows(fixture.tenantSql)).filter(
      (row) =>
        row.origin_context === GMAIL_ORIGIN && row.external_ref === null && row.outcome === 'failed',
    ).length;

    const result = await pull(source, states);

    expect(result.cursorInvalidated).toBe(true);
    expect(result.mode).toBe('backfill');
    // Recovery ran through the gate rather than as a free re-list.
    expect(result.decision?.proceed).toBe('inline');
    expect(result.estimate).not.toBeNull();
    // Bounded: the item outside the default window is reported, not imported.
    expect(result.widen.excludedItems).toBe(1);
    expect(result.widen.outsideWindow).toBe(40_000);
    expect(await pageCount(externalRefFor('gmail', 'c1'))).toBe(1);
    expect(await pageCount(externalRefFor('gmail', 'c2'))).toBe(0);

    // The staleness event is a row, not a log line that nobody keeps — and it
    // is a row of its OWN, because this run goes on to succeed and an event
    // folded into a successful run is an event no display will ever show.
    const events = (await ingestLogRows(fixture.tenantSql)).filter(
      (row) =>
        row.origin_context === GMAIL_ORIGIN && row.external_ref === null && row.outcome === 'failed',
    );
    expect(events.length).toBe(failedRunsBefore + 1);
    expect(
      (await ingestLogRows(fixture.tenantSql)).find((row) => row.ingest_id === result.runId)?.outcome,
    ).toBe('ok');
    // The second listing was asked for as a backfill with no cursor.
    expect(source.requests[1]?.mode).toBe('backfill');
    expect(source.requests[1]?.cursor).toBeNull();
  });

  test('widening the window re-estimates and re-gates', async () => {
    const old = new Date(NOW.getTime() - 400 * 24 * 60 * 60 * 1000);
    const states = await storeWith(stateFor('calendar'));
    const source = createFakeSource('calendar', 'calendar', [
      page({ items: [item('calendar', 'w1', mailBody('ancient'), old)], nextCursor: null }),
      page({ items: [item('calendar', 'w1', mailBody('ancient'), old)], nextCursor: null }),
    ]);

    const bounded = await pull(source, states);
    expect(bounded.widen.excludedItems).toBe(1);
    expect(bounded.widen.windowDays).toBe(90);
    expect(await pageCount(externalRefFor('calendar', 'w1'))).toBe(0);

    const widened = await pull(source, states, { window: 'all' });
    expect(widened.estimate?.items).toBe(1);
    expect(widened.widen.windowDays).toBeNull();
    expect(await pageCount(externalRefFor('calendar', 'w1'))).toBe(1);
  });
});

describe('what refuses', () => {
  test('a source that was never connected does not pull', async () => {
    const empty = createInMemoryConnectorStore();
    const source = createFakeSource('gmail', 'email', [page({ items: [] })]);
    const result = await pull(source, empty);
    expect(result.outcome).toBe('refused');
    expect(result.stopReason).toBe('not_connected');
    expect(result.runId).toBeNull();
  });
});

describe('cadence rides U10, and does not enqueue twice', () => {
  test('a due source enqueues one ingest_pull job; a fresh one enqueues none', async () => {
    const state = stateFor('gmail', { lastPullAt: NOW.toISOString(), cadenceSeconds: 300 });

    const early = await enqueuePullIfDue(fixture.queue, {
      tenantId: TENANT,
      state,
      now: new Date(NOW.getTime() + 60_000),
    });
    expect(early.enqueued).toBe(false);
    if (!early.enqueued) expect(early.reason).toBe('not_due');

    const due = await enqueuePullIfDue(fixture.queue, {
      tenantId: TENANT,
      state,
      now: new Date(NOW.getTime() + 600_000),
    });
    expect(due.enqueued).toBe(true);
    if (due.enqueued) {
      expect(due.job.kind).toBe('ingest_pull');
      expect(due.job.target).toBe('gmail');
      expect(due.job.trigger).toBe('connector_cadence');
    }

    // U10's unique index is the thing that makes this true, not a check here.
    const again = await enqueuePullIfDue(fixture.queue, {
      tenantId: TENANT,
      state,
      now: new Date(NOW.getTime() + 900_000),
    });
    expect(again.enqueued).toBe(false);
    if (!again.enqueued) expect(again.reason).toBe('already_open');
  });

  test('a paused source does not enqueue, and says so rather than looking not-due', async () => {
    // U14's `pause_source` is a setting until something reads it, and this is
    // the read. The source below is *due* — so a `paused` refusal here cannot be
    // the cadence answering, which is the whole point of the two states being
    // named separately: a user who paused their mailbox and watched it keep
    // pulling would be right to conclude the button does nothing, and a pause
    // reported as `not_due` looks exactly like a cadence that has not come round.
    const state = stateFor('drive', { lastPullAt: NOW.toISOString(), cadenceSeconds: 300 });
    const due = new Date(NOW.getTime() + 600_000);

    const paused = await enqueuePullIfDue(fixture.queue, {
      tenantId: TENANT,
      state,
      now: due,
      paused: true,
    });
    expect(paused.enqueued).toBe(false);
    if (!paused.enqueued) expect(paused.reason).toBe('paused');

    // And the same call without the pause enqueues, so the refusal above is the
    // pause rather than anything else about this source.
    const resumed = await enqueuePullIfDue(fixture.queue, {
      tenantId: TENANT,
      state,
      now: due,
      paused: false,
    });
    expect(resumed.enqueued).toBe(true);
  });
});

describe('the pause set is read from the tenant, not assumed', () => {
  test('manage’s row is what the pull path reads back', async () => {
    // The other half of the seam: `readPausedSources` over rung 7's table is
    // what a scheduler passes to `enqueuePullIfDue`. Asserted against a real
    // tenant database rather than a stub, because "the row exists" and "the
    // reader finds it" are two claims and only the second one matters here.
    expect(await readPausedSources(fixture.tenantSql)).toEqual([]);

    await pauseSource(fixture.tenantSql, 'gmail', 'panel');
    expect(await readPausedSources(fixture.tenantSql)).toEqual(['gmail']);

    // Idempotent, and the second authority does not relabel the first.
    await pauseSource(fixture.tenantSql, 'gmail', 'agent_confirmed');
    const rows = (await fixture.tenantSql`
      SELECT paused_by FROM source_pause WHERE source = 'gmail'
    `) as Array<{ paused_by: string }>;
    expect(rows[0]?.paused_by).toBe('panel');

    await resumeSource(fixture.tenantSql, 'gmail');
    expect(await readPausedSources(fixture.tenantSql)).toEqual([]);
  });
});

describe('the ingest log', () => {
  test('every pull opens and closes exactly one run row', async () => {
    const before = (await ingestLogRows(fixture.tenantSql)).filter(
      (row) => row.origin_context === CALENDAR_ORIGIN && row.external_ref === null,
    ).length;

    const states = await storeWith(stateFor('calendar'));
    const source = createFakeSource('calendar', 'calendar', [
      page({ items: [item('calendar', 'l1', mailBody('log run'))], nextCursor: { kind: 'delta', value: 's9' } }),
    ]);
    const result = await pull(source, states);

    const rows = (await ingestLogRows(fixture.tenantSql)).filter(
      (row) => row.origin_context === CALENDAR_ORIGIN && row.external_ref === null,
    );
    expect(rows.length).toBe(before + 1);
    // Keyed on this run's own id rather than on "the last row": the log is
    // shared across sources and the order it comes back in is not this test's.
    const mine = rows.find((row) => row.ingest_id === result.runId);
    expect(mine?.outcome).toBe('ok');
    expect(mine?.finished_at).not.toBeNull();
  });
});

/**
 * The objects a listing carries.
 *
 * U21 built `acceptMedia` and the transcribe phase and nothing in `src/ingest/`
 * called either, so a Drive full of screenshots imported as a Drive full of
 * failure rows and the transcribe queue was empty by construction. What the
 * block below has to prove is *reachability* — an attachment row, its bytes in
 * the store, and the queue predicate actually selecting it — plus the property
 * the refusal path got right and must keep: nothing is silently dropped.
 *
 * The assertions are on the gateway and on the rows. A summary field is what a
 * phase reports about itself, and a phase that never ran reports whatever its
 * initial value was.
 */
describe('the objects a listing carries', () => {
  const DRIVE_ORIGIN = originContextFor('drive');

  function mediaItem(id: string, overrides: Partial<PulledMedia> = {}): PulledMedia {
    return {
      externalRef: externalRefFor('drive', id),
      mediaType: 'image/png',
      bytes: screenshotBytes(),
      ...overrides,
    };
  }

  async function attachments(where = 'true'): Promise<
    Array<{
      object_key: string;
      media_type: string;
      byte_size: string | number | null;
      ocr_text: string | null;
      quarantined: boolean;
      origin_context: string;
    }>
  > {
    return (await fixture.tenantSql.unsafe(
      `SELECT object_key, media_type, byte_size, ocr_text, origin_context,
              (quarantined_at IS NOT NULL) AS quarantined
         FROM attachment WHERE ${where} ORDER BY attachment_id`,
    )) as never;
  }

  async function itemRow(externalRef: string) {
    const rows = await ingestLogRows(fixture.tenantSql);
    return rows.filter((row) => row.external_ref === externalRef).at(-1);
  }

  test('a screenshot is preserved, queued for transcription, and costs no model call', async () => {
    const states = await storeWith(stateFor('drive'));
    const source = createFakeSource('drive', 'document', [
      page({ media: [mediaItem('shot-1')], nextCursor: { kind: 'delta', value: 'd-1' } }),
    ]);

    const before = fixture.transport.calls.length;
    const result = await pull(source, states, { window: 'all' });

    expect(result.outcome).toBe('completed');
    expect(result.counts.attachments).toBe(1);
    expect(result.counts.failed).toBe(0);
    // **Acceptance is not extraction.** Not one provider call: the transcription
    // this queues is U11's, paid out of a phase budget, and a write path that
    // quietly OCR'd would show up only on the bill.
    expect(fixture.transport.calls.length).toBe(before);

    const rows = await attachments(`origin_context = '${DRIVE_ORIGIN}'`);
    expect(rows.length).toBe(1);
    expect(rows[0]?.media_type).toBe('image/png');
    expect(Number(rows[0]?.byte_size)).toBe(screenshotBytes().length);
    // NULL, not '': `ocr_text IS NULL` is what "still queued" means.
    expect(rows[0]?.ocr_text).toBeNull();
    expect(rows[0]?.quarantined).toBe(false);

    // The bytes are actually there, byte for byte. A row pointing at an object
    // that is not there is a transcription the cycle queues, pays a phase stop
    // for, and never resolves.
    const stored = await fixture.rawStore.get(rows[0]!.object_key as never);
    expect([...(stored?.bytes ?? [])]).toEqual([...screenshotBytes()]);

    // And the queue the whole unit exists for actually selects it. This is the
    // assertion that would have failed for the entire life of U21.
    const objectKey = rows[0]?.object_key ?? '';
    expect(objectKey.length).toBeGreaterThan(0);
    const pending = await selectPendingAttachments(fixture.tenantSql, { limit: 10 });
    expect(pending.map((entry) => entry.objectKey)).toContain(objectKey);

    // Counted on the run row: `acceptMedia` advances no counter of its own, so
    // a loop that forgot to would leave the run reporting a clean, empty pull.
    const runRow = (await ingestLogRows(fixture.tenantSql)).find((row) => row.ingest_id === result.runId);
    expect(runRow?.items_seen).toBe(1);
    expect(runRow?.items_written).toBe(1);
    expect((await itemRow(externalRefFor('drive', 'shot-1')))?.outcome).toBe('ok');
  });

  test('the same file offered again costs nothing and creates nothing', async () => {
    const states = await storeWith(stateFor('drive'));
    const source = createFakeSource('drive', 'document', [
      page({ media: [mediaItem('shot-1')], nextCursor: { kind: 'delta', value: 'd-2' } }),
    ]);
    const before = await attachments(`origin_context = '${DRIVE_ORIGIN}'`);

    const result = await pull(source, states, { window: 'all' });

    expect(result.counts.attachments).toBe(1);
    expect((await attachments(`origin_context = '${DRIVE_ORIGIN}'`)).length).toBe(before.length);
    // `unchanged` is `ok` with nothing written — the table's vocabulary has four
    // outcomes over five dispositions, and `items_written` is what tells the
    // second sighting of a file from the first.
    const again = await itemRow(externalRefFor('drive', 'shot-1'));
    expect(again?.outcome).toBe('ok');
    expect(again?.items_written).toBe(0);
    expect(again?.items_quarantined).toBe(0);
  });

  test('an object the store refuses leaves a row AND holds the cursor', async () => {
    // The one mistake in this file no later pull can correct. A provider offers
    // a change once; a cursor that steps over a *preservation* failure means the
    // user's screenshot is gone from the brain for good, over a bad minute in
    // the object store.
    const states = await storeWith(stateFor('drive'));
    const source = createFakeSource('drive', 'document', [
      page({ media: [mediaItem('shot-lost')], nextCursor: { kind: 'delta', value: 'd-lost' } }),
    ]);
    fixture.rawStore.failNextPut();

    const result = await pull(source, states, { window: 'all' });

    expect(result.counts.attachments).toBe(0);
    expect(result.counts.failed).toBe(1);
    expect(result.cursorAdvanced).toBe(false);
    expect(await countRows(fixture.tenantSql, 'attachment', `object_key LIKE '%'`)).toBeGreaterThanOrEqual(0);
    const row = await itemRow(externalRefFor('drive', 'shot-lost'));
    expect(row?.outcome).toBe('failed');
    expect(row?.failure_code).toBe('provider_error');
  });

  test('an object the brain cannot read leaves a row and does NOT hold the cursor', async () => {
    // The other direction, and it is not symmetrical: asking again produces the
    // identical refusal, so holding here would wedge the source forever on a
    // file that is never going to become readable.
    const states = await storeWith(stateFor('drive'));
    const source = createFakeSource('drive', 'document', [
      page({
        media: [mediaItem('memo', { mediaType: 'audio/mp4' })],
        nextCursor: { kind: 'delta', value: 'd-memo' },
      }),
    ]);

    const result = await pull(source, states, { window: 'all' });

    expect(result.counts.failed).toBe(1);
    expect(result.cursorAdvanced).toBe(true);
    const row = await itemRow(externalRefFor('drive', 'memo'));
    expect(row?.outcome).toBe('failed');
    expect(row?.failure_code).toBe('parse_failed');
    expect(await countRows(fixture.tenantSql, 'attachment', `media_type = 'audio/mp4'`)).toBe(0);
  });

  test('nowhere to put an object is a row per object, not a silence', async () => {
    // A fleet wired without an object store must not look like a fleet with
    // nothing to import. The row says what happened and the cursor holds, so the
    // files are still offered once the wiring is fixed.
    const states = await storeWith(stateFor('drive'));
    const source = createFakeSource('drive', 'document', [
      page({ media: [mediaItem('unwired')], nextCursor: { kind: 'delta', value: 'd-unwired' } }),
    ]);

    const result = await pull(source, states, { window: 'all', withStorage: false });

    expect(result.counts.attachments).toBe(0);
    expect(result.counts.failed).toBe(1);
    expect(result.cursorAdvanced).toBe(false);
    expect((await itemRow(externalRefFor('drive', 'unwired')))?.failure_code).toBe('provider_error');
  });

  test('a junk-quarantined object is stored, and stays out of the transcribe queue', async () => {
    // The junk gate in front of the meter, applied to media: a tracking pixel is
    // preserved (R23 — extraction improves, and the fleet cannot re-derive from
    // bytes it no longer has) and never costs a vision call, because the queue
    // predicate excludes it. The structural saving, not a careful caller.
    const states = await storeWith(stateFor('drive'));
    const source = createFakeSource('drive', 'document', [
      page({
        media: [
          mediaItem('pixel', { junk: { headers: { 'List-Unsubscribe': '<https://x.test/u>' } } }),
        ],
        nextCursor: { kind: 'delta', value: 'd-pixel' },
      }),
    ]);

    const result = await pull(source, states, { window: 'all' });

    expect(result.counts.attachments).toBe(1);
    const hidden = await attachments(`quarantined_at IS NOT NULL`);
    expect(hidden.length).toBe(1);
    const hiddenKey = hidden[0]?.object_key ?? '';
    expect(hiddenKey.length).toBeGreaterThan(0);
    const pending = await selectPendingAttachments(fixture.tenantSql, { limit: 50 });
    expect(pending.map((entry) => entry.objectKey)).not.toContain(hiddenKey);
    const row = await itemRow(externalRefFor('drive', 'pixel'));
    expect(row?.outcome).toBe('ok');
    expect(row?.items_quarantined).toBe(1);
    expect(row?.items_written).toBe(0);
  });

  /**
   * A file the user deleted upstream, and the two rows that outlive it.
   *
   * The sweep matched `page.external_ref` only, and an attachment is not a page:
   * neither the attachment row nor the transcript page written from it —
   * `attachment:{id}`, a different ref on a different table — was reachable by
   * any deletion path. So a document a user deleted in Drive stayed searchable
   * through its own transcribed text, indefinitely.
   *
   * **The transcript is asserted separately from the attachment row on
   * purpose.** They are retired by different statements against different
   * tables, and a sweep that retired only the attachment would leave the
   * searchable half standing while every count in this test still read right.
   */
  async function attachmentIdIn(origin: string): Promise<string> {
    const rows = (await fixture.tenantSql`
      SELECT attachment_id::text AS id FROM attachment
       WHERE origin_context = ${origin} AND deleted_at IS NULL
       ORDER BY attachment_id DESC LIMIT 1
    `) as Array<{ id: string }>;
    const id = rows[0]?.id;
    if (id === undefined) throw new Error(`no live attachment on ${origin}`);
    return id;
  }

  /** The transcript the OCR phase writes, through the write path it writes it on. */
  async function writeTranscript(attachmentId: string, origin: string, body: string) {
    const receipt = await ingestDocument(
      {
        sql: fixture.tenantSql,
        gateway: fixture.gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget(),
      },
      {
        originContext: origin,
        sourceType: 'file',
        body,
        externalRef: transcriptRefFor(attachmentId),
      },
    );
    expect(receipt.ok).toBe(true);
  }

  test('A FILE DELETED UPSTREAM RETIRES ITS ATTACHMENT AND ITS TRANSCRIPT', async () => {
    const ref = externalRefFor('drive', 'shot-gone');
    const states = await storeWith(stateFor('drive'));
    const source = createFakeSource('drive', 'document', [
      page({ media: [mediaItem('shot-gone')], nextCursor: { kind: 'delta', value: 'd-gone-1' } }),
      page({
        tombstones: [{ externalRef: ref, reason: 'deleted' }],
        nextCursor: { kind: 'delta', value: 'd-gone-2' },
      }),
    ]);

    await pull(source, states, { window: 'all' });
    const attachmentId = await attachmentIdIn(DRIVE_ORIGIN);
    await writeTranscript(attachmentId, DRIVE_ORIGIN, mailBody('the wifi password is on this page'));

    // Both halves live, or nothing below grades anything.
    const transcriptRef = transcriptRefFor(attachmentId);
    expect(await pageCount(transcriptRef)).toBe(1);
    expect(
      await countRows(fixture.tenantSql, 'attachment', `attachment_id = ${attachmentId} AND deleted_at IS NULL`),
    ).toBe(1);

    const second = await pull(source, states);
    expect(second.counts.tombstoned).toBeGreaterThan(0);

    // The row that says the object exists...
    expect(
      await countRows(fixture.tenantSql, 'attachment', `attachment_id = ${attachmentId} AND deleted_at IS NULL`),
    ).toBe(0);
    // ...and the searchable text derived from it, which is the half a user
    // would actually notice: a deleted file still answering a query.
    expect(await pageCount(transcriptRef)).toBe(0);
    expect(
      await countRows(
        fixture.tenantSql,
        'chunk c',
        `c.deleted_at IS NULL AND c.page_id IN (SELECT page_id FROM page WHERE external_ref = '${transcriptRef}')`,
      ),
    ).toBe(0);
    // The deletion is on the record, so an operator can see it happened.
    expect((await itemRow(ref))?.outcome).toBe('ok');
  });

  test('AN ATTACHMENT WRITTEN BEFORE THE RUNG HEALS FROM THE NEXT SIGHTING', async () => {
    // The migration's backfill story, which is otherwise only a claim in a
    // comment. Rows written before rung 6 carry no ref and are unreachable by
    // the sweep; nothing backfills them, because the only value a migration
    // could write is a guess and `object_key` is a hash that does not run
    // backwards. What fills the column is a *sighting* — and the sighting that
    // matters is the `unchanged` one, because that is a poller's most common
    // outcome and the path on which nothing else is written at all.
    const ref = externalRefFor('drive', 'shot-heal');
    const states = await storeWith(stateFor('drive'));
    const source = createFakeSource('drive', 'document', [
      page({ media: [mediaItem('shot-heal')], nextCursor: { kind: 'delta', value: 'd-heal-1' } }),
      page({ media: [mediaItem('shot-heal')], nextCursor: { kind: 'delta', value: 'd-heal-2' } }),
      page({
        tombstones: [{ externalRef: ref, reason: 'deleted' }],
        nextCursor: { kind: 'delta', value: 'd-heal-3' },
      }),
    ]);

    await pull(source, states, { window: 'all' });
    const attachmentId = await attachmentIdIn(DRIVE_ORIGIN);

    // Put the row back into the shape every pre-rung attachment is in.
    await fixture.tenantSql`
      UPDATE attachment SET external_ref = NULL WHERE attachment_id = ${attachmentId}::bigint
    `;
    expect(
      await countRows(
        fixture.tenantSql,
        'attachment',
        `attachment_id = ${attachmentId} AND external_ref IS NULL`,
      ),
    ).toBe(1);

    // The same file, offered again. Nothing about the object changed, so this
    // is the `unchanged` path: no object written, no row rewritten, one
    // observation recorded.
    const again = await pull(source, states);
    expect(again.counts.attachments).toBe(1);
    expect(
      await countRows(
        fixture.tenantSql,
        'attachment',
        `attachment_id = ${attachmentId} AND external_ref = '${ref}'`,
      ),
    ).toBe(1);

    // ...and the point of healing it: the row is now reachable by the deletion
    // it was invisible to a moment ago.
    const swept = await pull(source, states);
    expect(swept.counts.tombstoned).toBeGreaterThan(0);
    expect(
      await countRows(fixture.tenantSql, 'attachment', `attachment_id = ${attachmentId} AND deleted_at IS NULL`),
    ).toBe(0);
  });

  test('an attachment cannot be retired from another origin', async () => {
    // R15 at the deletion end, on the lane this change added. A Drive pull that
    // swept attachments by ref alone would retire a mail attachment that
    // happens to carry the same provider id.
    const shared = externalRefFor('drive', 'shared-object-id');
    const mailOrigin = originContextFor('gmail');
    const accepted = await acceptMedia(
      { sql: fixture.tenantSql, storage: fixture.storage, store: fixture.rawStore },
      {
        tenantId: TENANT,
        caller: CALLER,
        originContext: mailOrigin,
        mediaType: 'image/png',
        bytes: screenshotBytes(),
        externalId: shared,
      },
    );
    expect(accepted.ok).toBe(true);

    const states = await storeWith(stateFor('drive'));
    const source = createFakeSource('drive', 'document', [
      page({
        tombstones: [{ externalRef: shared, reason: 'deleted' }],
        nextCursor: { kind: 'delta', value: 'd-shared' },
      }),
    ]);
    await pull(source, states);

    expect(
      await countRows(
        fixture.tenantSql,
        'attachment',
        `origin_context = '${mailOrigin}' AND deleted_at IS NULL`,
      ),
    ).toBe(1);
  });

  test('a deleted message takes its attachments and their transcripts with it', async () => {
    // The other way an attachment is orphaned: the *page* it hangs off is
    // tombstoned by its own ref, and the attachment is named by nothing at all.
    // Without this the mail is gone and the picture that arrived on it is still
    // in the brain, with its transcript still answering queries.
    const mailOrigin = originContextFor('gmail');
    const ref = externalRefFor('gmail', 'm-with-shot');
    const states = await storeWith(stateFor('gmail'));
    const source = createFakeSource('gmail', 'email', [
      page({ items: [item('gmail', 'm-with-shot', mailBody('see attached'))], nextCursor: { kind: 'delta', value: 'm-1' } }),
      page({ tombstones: [{ externalRef: ref, reason: 'deleted' }], nextCursor: { kind: 'delta', value: 'm-2' } }),
    ]);

    await pull(source, states, { window: 'all' });
    const pageRows = (await fixture.tenantSql`
      SELECT page_id::text AS id FROM page WHERE external_ref = ${ref} AND deleted_at IS NULL
    `) as Array<{ id: string }>;
    const pageId = pageRows[0]?.id ?? '';
    expect(pageId.length).toBeGreaterThan(0);

    const accepted = await acceptMedia(
      { sql: fixture.tenantSql, storage: fixture.storage, store: fixture.rawStore },
      {
        tenantId: TENANT,
        caller: CALLER,
        originContext: mailOrigin,
        mediaType: 'image/png',
        bytes: screenshotBytes(),
        externalId: externalRefFor('gmail', 'm-with-shot-part-2'),
        pageId,
      },
    );
    expect(accepted.ok).toBe(true);
    const attachmentId = (accepted as { attachmentId: string }).attachmentId;
    await writeTranscript(attachmentId, mailOrigin, mailBody('the agenda, photographed'));
    const transcriptRef = transcriptRefFor(attachmentId);
    expect(await pageCount(transcriptRef)).toBe(1);

    await pull(source, states);

    expect(
      await countRows(fixture.tenantSql, 'attachment', `attachment_id = ${attachmentId} AND deleted_at IS NULL`),
    ).toBe(0);
    expect(await pageCount(transcriptRef)).toBe(0);
  });
});

describe('the ingest_pull handler', () => {
  test('carries the object store through, so a background pull can take media', async () => {
    // The handler is where a connector actually runs in production. One that
    // opened a media-capable source and then ran it with nowhere to put the
    // bytes would reproduce the exact shape this whole change exists to close:
    // working code the fleet never reaches.
    const states = await storeWith(stateFor('drive'));
    const source = createFakeSource('drive', 'document', [
      page({
        media: [
          {
            externalRef: externalRefFor('drive', 'handler-shot'),
            mediaType: 'image/png',
            bytes: screenshotBytes(),
          },
        ],
        nextCursor: { kind: 'delta', value: 'd-handler' },
      }),
    ]);

    let observed: PullResult | null = null;
    const handler = createIngestPullHandler({
      control: fixture.controlSql,
      profile: HOSTED_PROFILE,
      storage: fixture.storage,
      rawStore: fixture.rawStore,
      openTenant: () => Promise.resolve(fixture.runtime),
      openSource: () => Promise.resolve({ source, states }),
      onResult: (result) => {
        observed = result;
      },
    });

    const lease: JobLease = {
      jobId: 'job-media-1',
      tenantId: TENANT,
      kind: 'ingest_pull',
      target: 'drive',
      leaseToken: 1,
      owner: 'worker-1',
      expiresAt: new Date(NOW.getTime() + 60_000),
      attemptDeadlineAt: new Date(NOW.getTime() + 600_000),
      attempts: 1,
      maxAttempts: 5,
      debtObserved: 0,
    };

    await handler({ lease, signal: new AbortController().signal, now: NOW });

    expect(observed).not.toBeNull();
    expect((observed as unknown as PullResult).counts.attachments).toBe(1);
    expect((observed as unknown as PullResult).counts.failed).toBe(0);
    const rows = (await fixture.tenantSql`
      SELECT object_key FROM attachment WHERE media_type = 'image/png' AND ocr_text IS NULL
    `) as Array<{ object_key: string }>;
    expect(rows.length).toBeGreaterThan(0);
  });
});
