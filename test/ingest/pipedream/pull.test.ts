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
import {
  enqueuePullIfDue,
  originContextFor,
  runPull,
} from '../../../src/ingest/pipedream/pull.ts';
import { externalRefFor } from '../../../src/ingest/pipedream/sources/types.ts';
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
