/**
 * The pull runner's absence-of-loss properties.
 *
 * Every case here is one shape: **the brain stops updating and every surface
 * still says healthy.** For a memory product that is worse than crashing — a
 * user cannot tell "nothing happened this week" from "your mail stopped syncing
 * in March", and by the time they can, the provider has stopped offering the
 * changes the cursor walked past.
 *
 * So each test asserts two halves, and a fix for either one alone is not a fix:
 * the work is not lost (the cursor did not move past it), and the loss is
 * visible (the run row, the staleness view, or the handler's own result says
 * so). These are absence properties, which pass trivially when the path never
 * runs — so every one of them provokes the branch first and asserts the
 * provocation landed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { HOSTED_PROFILE } from '../../../src/ai/routing.ts';
import {
  connectSource,
  createInMemoryConnectorStore,
  type ConnectorState,
  type ConnectorStateStore,
} from '../../../src/ingest/cursor.ts';
import { sourceStaleness } from '../../../src/ingest/log.ts';
import {
  createIngestPullHandler,
  originContextFor,
  runPull,
  type PullResult,
} from '../../../src/ingest/pipedream/pull.ts';
import { externalRefFor } from '../../../src/ingest/pipedream/sources/types.ts';
import type { JobLease } from '../../../src/worker/jobs.ts';
import { createGateway } from '../../core/write/fixture.ts';
import { TENANT, countRows, createIngestFixture, type IngestFixture } from '../fixture.ts';
import { createFakeSource, mailBody, page } from './fixture.ts';

let fixture: IngestFixture;

const NOW = new Date('2026-08-13T10:00:00.000Z');
const GMAIL_ORIGIN = originContextFor('gmail');

beforeAll(async () => {
  fixture = await createIngestFixture('u9loss');
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

function item(source: 'gmail' | 'calendar' | 'drive', id: string, body: string, ref?: string) {
  return {
    externalRef: ref ?? externalRefFor(source, id),
    title: `subject ${id}`,
    body,
    occurredAt: NOW,
  };
}

async function pull(
  source: ReturnType<typeof createFakeSource>,
  states: ConnectorStateStore,
  overrides: Partial<Parameters<typeof runPull>[0]> = {},
): Promise<PullResult> {
  return runPull({
    tenant: fixture.runtime,
    control: fixture.controlSql,
    profile: HOSTED_PROFILE,
    source,
    states,
    now: NOW,
    ...overrides,
  });
}

async function runRows(origin: string): Promise<
  Array<{ outcome: string; failure_code: string | null; external_ref: string | null }>
> {
  return (await fixture.tenantSql`
    SELECT outcome, failure_code, external_ref
      FROM ingest_log
     WHERE origin_context = ${origin}
     ORDER BY ingest_id
  `) as Array<{ outcome: string; failure_code: string | null; external_ref: string | null }>;
}

describe('a retryable loss holds the cursor', () => {
  test('a rate-limited item stops the pull and leaves the cursor where it was', async () => {
    const before = { kind: 'delta' as const, value: 'h-before', issuedAt: NOW.toISOString() };
    const states = await storeWith(stateFor('gmail', { cursor: before }));
    const source = createFakeSource('gmail', 'email', [
      page({
        items: [item('gmail', 'ok-1', mailBody('ok-1'))],
        failures: [
          { externalRef: externalRefFor('gmail', 'held-1'), reason: 'rate_limited', retryable: true },
        ],
        nextCursor: { kind: 'delta', value: 'h-after' },
      }),
    ]);

    const result = await pull(source, states);

    // The provocation landed: the item really was refused.
    expect(result.counts.failed).toBe(1);
    // Half one — the change is not lost. The provider will offer it again.
    expect(result.cursorAdvanced).toBe(false);
    expect((await states.read('gmail'))?.cursor?.value).toBe('h-before');
    // Half two — the loss is visible rather than a run that closed clean.
    expect(result.outcome).toBe('stopped');
    expect(result.stopReason).toBe('rate_limited');
    const rows = await runRows(GMAIL_ORIGIN);
    const run = rows.find((row) => row.external_ref === null);
    expect(run?.outcome).toBe('failed');
    expect(run?.failure_code).toBe('rate_limited');
    // And the item it kept is still banked: stopping is not rolling back.
    expect(await countRows(fixture.tenantSql, 'page', `external_ref = '${externalRefFor('gmail', 'ok-1')}'`)).toBe(1);
  });

  test('an item the ceiling never reached holds the cursor and says so', async () => {
    // A page bigger than one pull's item ceiling is not a slice: the ids beyond
    // it come back as rows, the cursor holds, and the run names the reason so
    // an operator reaches for a larger `maxItems` instead of wondering.
    const states = await storeWith(
      stateFor('gmail', { cursor: { kind: 'delta', value: 'c-before', issuedAt: NOW.toISOString() } }),
    );
    const source = createFakeSource('gmail', 'email', [
      page({
        items: [item('gmail', 'ceil-1', mailBody('ceil-1'))],
        failures: [
          { externalRef: externalRefFor('gmail', 'ceil-2'), reason: 'cancelled', retryable: true },
        ],
        nextCursor: { kind: 'delta', value: 'c-after' },
      }),
    ]);

    const result = await pull(source, states);

    expect(result.stopReason).toBe('not_attempted');
    expect(result.cursorAdvanced).toBe(false);
    expect((await states.read('gmail'))?.cursor?.value).toBe('c-before');
  });

  test('a permanently broken item does not wedge the source', async () => {
    // The other direction costs just as much: a message deleted between the
    // listing and the fetch answers 404 forever, and holding the cursor for it
    // stalls every later change behind one id that is never coming back.
    const states = await storeWith(
      stateFor('gmail', { cursor: { kind: 'delta', value: 'p-before', issuedAt: NOW.toISOString() } }),
    );
    const source = createFakeSource('gmail', 'email', [
      page({
        items: [item('gmail', 'ok-2', mailBody('ok-2'))],
        failures: [
          { externalRef: externalRefFor('gmail', 'dead-1'), reason: 'parse_failed', retryable: false },
        ],
        nextCursor: { kind: 'delta', value: 'p-after' },
      }),
    ]);

    const result = await pull(source, states);

    expect(result.counts.failed).toBe(1);
    expect(result.outcome).toBe('completed');
    expect(result.cursorAdvanced).toBe(true);
    expect((await states.read('gmail'))?.cursor?.value).toBe('p-after');
  });

  test('a write that failed on the encoder holds the cursor too', async () => {
    // Same defect, one layer down: the fetch worked and the write did not, for
    // a reason that has nothing to do with the item's content. The body states
    // a fact on purpose — a document that extracts none never reaches the
    // encoder, and the test would pass without provoking anything.
    const broken = createGateway({ failFromCall: 1 });
    const states = await storeWith(stateFor('drive'));
    const source = createFakeSource('drive', 'document', [
      page({
        items: [item('drive', 'enc-1', 'Alice Example is a partner at Widget Co.')],
        nextCursor: { kind: 'delta', value: 'd-after' },
      }),
    ]);

    const result = await pull(source, states, {
      tenant: { ...fixture.runtime, gateway: broken.gateway },
    });

    expect(result.counts.failed).toBe(1);
    expect(result.cursorAdvanced).toBe(false);
    expect((await states.read('drive'))?.cursor).toBeNull();
    expect(result.outcome).toBe('stopped');
    expect(result.stopReason).toBe('provider_error');
  });

  test('a deferred chunk pass that failed leaves the run visibly incomplete', async () => {
    // The pages are banked and the backlog is a query over `embedding IS NULL`,
    // so nothing is lost here — but a run that closed `ok` over it is a brain
    // reporting itself indexed when a slice of it has no vector at all.
    const broken = createGateway({ failFromCall: 1 });
    const states = await storeWith(stateFor('calendar'));
    const source = createFakeSource('calendar', 'calendar', [
      page({
        items: [item('calendar', 'bk-1', mailBody('bk-1'))],
        nextCursor: { kind: 'delta', value: 'sync-bk' },
      }),
    ]);

    const result = await pull(source, states, {
      tenant: { ...fixture.runtime, gateway: broken.gateway },
    });

    expect(result.counts.written).toBe(1);
    expect(result.outcome).toBe('stopped');
    expect(result.stopReason).toBe('provider_error');
    expect(
      await countRows(
        fixture.tenantSql,
        'chunk c JOIN page p ON p.page_id = c.page_id',
        `p.external_ref = '${externalRefFor('calendar', 'bk-1')}' AND c.embedding IS NULL`,
      ),
    ).toBeGreaterThan(0);
  });
});

describe('the loss is visible', () => {
  test('item failures reach the staleness view', async () => {
    const states = await storeWith(stateFor('calendar'));
    const source = createFakeSource('calendar', 'calendar', [
      page({
        items: [item('calendar', 'vis-1', mailBody('vis-1'))],
        failures: [
          { externalRef: externalRefFor('calendar', 'vis-2'), reason: 'rate_limited', retryable: true },
        ],
        nextCursor: { kind: 'delta', value: 'sync-vis' },
      }),
    ]);
    await pull(source, states);

    const view = await sourceStaleness(fixture.tenantSql, { now: NOW });
    const calendar = view.find((row) => row.originContext === originContextFor('calendar'));
    expect(calendar).toBeDefined();
    expect(calendar!.itemsFailed).toBeGreaterThan(0);
    expect(calendar!.lastItemFailureCode).toBe('rate_limited');
  });

  test('one cursor expiry does not poison the source forever', async () => {
    // The expiry writes a failed run row of its own — deliberately, so the
    // event is visible. What must not follow is that row becoming the permanent
    // answer to "why is this source unhappy" after the recovery succeeded.
    const origin = originContextFor('drive');
    const before = (await runRows(origin)).length;
    const states = await storeWith(
      stateFor('drive', { cursor: { kind: 'delta', value: 'gone', issuedAt: NOW.toISOString() } }),
    );
    const source = createFakeSource('drive', 'document', [
      { ok: false, reason: 'cursor_invalid' },
      page({ items: [item('drive', 'rec-1', mailBody('rec-1'))], nextCursor: { kind: 'delta', value: 'fresh' } }),
    ]);

    const result = await pull(source, states);
    expect(result.cursorInvalidated).toBe(true);
    expect(result.outcome).toBe('completed');

    // The event row is there…
    const added = (await runRows(origin)).slice(before);
    expect(added.some((row) => row.outcome === 'failed' && row.external_ref === null)).toBe(true);
    // …and it is not what the source's health now reads as.
    const view = await sourceStaleness(fixture.tenantSql, { now: NOW });
    const drive = view.find((row) => row.originContext === origin);
    expect(drive!.lastFailureCode).toBeNull();
  });

  test('the pull handler does not swallow its own result', async () => {
    const states = await storeWith(stateFor('gmail'));
    const source = createFakeSource('gmail', 'email', [
      page({
        items: [item('gmail', 'han-1', mailBody('han-1'))],
        failures: [
          { externalRef: externalRefFor('gmail', 'han-2'), reason: 'rate_limited', retryable: true },
        ],
        nextCursor: { kind: 'delta', value: 'h-han' },
      }),
    ]);

    const seen: PullResult[] = [];
    const handler = createIngestPullHandler({
      control: fixture.controlSql,
      profile: HOSTED_PROFILE,
      openTenant: () => Promise.resolve(fixture.runtime),
      openSource: () => Promise.resolve({ source, states }),
      onResult: (result) => {
        seen.push(result);
      },
    });

    const lease = {
      jobId: 'job-loss-1',
      tenantId: TENANT,
      kind: 'ingest_pull',
      target: 'gmail',
      attempt: 1,
      leaseUntil: NOW,
    } as unknown as JobLease;

    await handler({ lease, now: NOW, signal: new AbortController().signal });

    expect(seen.length).toBe(1);
    expect(seen[0]?.counts.failed).toBe(1);
    expect(seen[0]?.stopReason).toBe('rate_limited');
  });

  test('a provider that refused the listing fails the job rather than reporting a clean run', async () => {
    const states = await storeWith(stateFor('calendar'));
    const source = createFakeSource('calendar', 'calendar', [
      { ok: false, reason: 'auth_expired' },
    ]);
    const handler = createIngestPullHandler({
      control: fixture.controlSql,
      profile: HOSTED_PROFILE,
      openTenant: () => Promise.resolve(fixture.runtime),
      openSource: () => Promise.resolve({ source, states }),
    });

    const lease = {
      jobId: 'job-loss-2',
      tenantId: TENANT,
      kind: 'ingest_pull',
      target: 'calendar',
      attempt: 1,
      leaseUntil: NOW,
    } as unknown as JobLease;

    expect(
      handler({ lease, now: NOW, signal: new AbortController().signal }),
    ).rejects.toThrow(/auth_expired/);
  });
});

describe('an item belongs to the account that was connected', () => {
  test('the account the provider reports is adopted on first sight', async () => {
    const states = await storeWith(stateFor('gmail'));
    const source = createFakeSource('gmail', 'email', [
      page({
        items: [item('gmail', 'id-1', mailBody('id-1'), 'gmail:owner@example.test:id-1')],
        accountKey: 'owner@example.test',
        nextCursor: { kind: 'delta', value: 'h-id' },
      }),
    ]);

    await pull(source, states);
    expect((await states.read('gmail'))?.accountKey).toBe('owner@example.test');
    // And the runner told the adapter which account it believed in, so the
    // adapter can key its refs by it rather than by the mailbox-local id alone.
    expect(source.requests[0]?.accountKey ?? null).toBeNull();
  });

  test('a different account is refused, never merged into the first one', async () => {
    // Gmail message ids are unique per mailbox, not globally. Left unfenced,
    // account B's colliding id arrives as an *update* to account A's page: A's
    // mail is tombstoned and replaced by a stranger's, and the origin fence
    // cannot tell them apart because both pulls carry the same origin.
    const states = await storeWith(stateFor('gmail', { accountKey: 'first@example.test' }));
    const source = createFakeSource('gmail', 'email', [
      page({
        items: [item('gmail', 'id-2', mailBody('id-2'))],
        accountKey: 'second@example.test',
        nextCursor: { kind: 'delta', value: 'h-id-2' },
      }),
    ]);

    const result = await pull(source, states);

    expect(result.outcome).toBe('refused');
    expect(result.stopReason).toBe('identity_changed');
    expect(result.counts.written).toBe(0);
    expect(await countRows(fixture.tenantSql, 'page', `external_ref = '${externalRefFor('gmail', 'id-2')}'`)).toBe(0);
    // The stored identity is not quietly overwritten by whoever pulled last.
    expect((await states.read('gmail'))?.accountKey).toBe('first@example.test');
    const rows = await runRows(GMAIL_ORIGIN);
    expect(rows.at(-1)?.outcome).toBe('failed');
  });
});

describe('quarantine is reversible', () => {
  const HIDDEN = 'hide-me-please-this-is-a-newsletter-body-of-some-length';

  test('a page hidden by the junk gate comes back when the verdict changes', async () => {
    const states = await storeWith(stateFor('gmail'));
    const ref = externalRefFor('gmail', 'q-1');
    const body = mailBody(HIDDEN, 3);

    const junked = createFakeSource('gmail', 'email', [
      page({
        items: [{ ...item('gmail', 'q-1', body), junk: { headers: { 'list-unsubscribe': '<x>' } } }],
        nextCursor: { kind: 'delta', value: 'h-q1' },
      }),
    ]);
    await pull(junked, states);
    expect(await countRows(fixture.tenantSql, 'page', `external_ref = '${ref}' AND quarantined_at IS NOT NULL`)).toBe(1);

    // Same title, same body — so the digest is identical and the idempotent
    // path fires. The verdict is what moved, and the verdict is not in the
    // digest, so an unchanged-digest shortcut taken before reading it leaves
    // the user's mail unrecallable with no error anywhere.
    const clean = createFakeSource('gmail', 'email', [
      page({
        items: [{ ...item('gmail', 'q-1', body), junk: {} }],
        nextCursor: { kind: 'delta', value: 'h-q2' },
      }),
    ]);
    const result = await pull(clean, states);

    expect(result.counts.quarantined).toBe(0);
    expect(await countRows(fixture.tenantSql, 'page', `external_ref = '${ref}' AND deleted_at IS NULL AND quarantined_at IS NULL`)).toBe(1);
    // And the chunks are back in the backlog the embedder drains.
    expect(
      await countRows(
        fixture.tenantSql,
        'chunk c JOIN page p ON p.page_id = c.page_id',
        `p.external_ref = '${ref}' AND c.deleted_at IS NULL AND c.quarantined_at IS NULL`,
      ),
    ).toBeGreaterThan(0);
  });

  test('and a page that turns out to be junk is hidden even though its body did not change', async () => {
    const states = await storeWith(stateFor('gmail'));
    const ref = externalRefFor('gmail', 'q-2');
    const body = mailBody('a perfectly ordinary message', 3);

    const clean = createFakeSource('gmail', 'email', [
      page({ items: [{ ...item('gmail', 'q-2', body), junk: {} }], nextCursor: { kind: 'delta', value: 'h-q3' } }),
    ]);
    await pull(clean, states);
    expect(await countRows(fixture.tenantSql, 'page', `external_ref = '${ref}' AND quarantined_at IS NULL AND deleted_at IS NULL`)).toBe(1);

    const junked = createFakeSource('gmail', 'email', [
      page({
        items: [{ ...item('gmail', 'q-2', body), junk: { labels: ['SPAM'] } }],
        nextCursor: { kind: 'delta', value: 'h-q4' },
      }),
    ]);
    const result = await pull(junked, states);

    expect(result.counts.quarantined).toBe(1);
    expect(await countRows(fixture.tenantSql, 'page', `external_ref = '${ref}' AND deleted_at IS NULL AND quarantined_at IS NOT NULL`)).toBe(1);
  });
});
