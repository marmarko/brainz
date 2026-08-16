/**
 * The gate, as a connector consumes it (U9 approach 4 + 2a).
 *
 * U8 owns the gate; this unit reuses it rather than building a second one, and
 * the reuse has one seam worth testing on its own: U8's gate defers into the
 * `import` job lane, and a connector backfill has to land in the `ingest_pull`
 * lane instead (the database's own `job_target_suits_its_kind` refuses anything
 * else). So the deferral goes through an adapter, and the adapter is exactly
 * the kind of thing that silently stops working.
 *
 * The other half is the ceiling itself. An approval that never becomes a
 * `Budget` threaded through every write is decoration, and the way to tell the
 * difference is to shrink the tenant's headroom to nearly nothing and check
 * that the run **stops** — and that it does not advance the cursor past work it
 * did not do, which is the connector-specific version of losing an import.
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
import {
  createIngestPullHandler,
  originContextFor,
  runPull,
} from '../../../src/ingest/pipedream/pull.ts';
import { externalRefFor } from '../../../src/ingest/pipedream/sources/types.ts';
import { DEFAULT_WINDOW_DAYS } from '../../../src/ingest/first-import.ts';
import type { JobLease } from '../../../src/worker/jobs.ts';
import {
  CALLER,
  TENANT,
  countRows,
  createIngestFixture,
  setSpend,
  uncappedBudget,
  type IngestFixture,
} from '../fixture.ts';
import { createFakeSource, mailBody, page } from './fixture.ts';

let fixture: IngestFixture;

const NOW = new Date('2026-08-13T10:00:00.000Z');

beforeAll(async () => {
  fixture = await createIngestFixture('u9gate');
});

afterAll(async () => {
  await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: null });
  await fixture.close();
});

function stateFor(
  overrides: Partial<ConnectorState> = {},
  source: 'gmail' | 'calendar' | 'drive' = 'gmail',
): ConnectorState {
  return {
    ...connectSource({ source, externalUserId: TENANT, accountId: 'apn_1', now: NOW }),
    ...overrides,
  };
}

function leaseFor(jobId: string): JobLease {
  return {
    jobId,
    tenantId: TENANT,
    kind: 'ingest_pull',
    target: 'gmail',
    leaseToken: 1,
    owner: 'worker-1',
    expiresAt: new Date(NOW.getTime() + 60_000),
    attemptDeadlineAt: new Date(NOW.getTime() + 600_000),
    attempts: 1,
    maxAttempts: 5,
    debtObserved: 0,
  };
}

async function storeWith(state: ConnectorState): Promise<ConnectorStateStore> {
  const store = createInMemoryConnectorStore();
  await store.write(state);
  return store;
}

function mailbox(count: number, prefix: string) {
  return Array.from({ length: count }, (_, index) => ({
    externalRef: externalRefFor('gmail', `${prefix}-${index}`),
    title: `subject ${prefix}-${index}`,
    body: mailBody(`${prefix}-${index}`, 1),
    occurredAt: NOW,
  }));
}

describe('a first import too big for one pass', () => {
  test('defers into the ingest_pull lane, banks the approval, and imports nothing yet', async () => {
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: null });
    const states = await storeWith(stateFor());
    const source = createFakeSource('gmail', 'email', [
      page({ items: mailbox(600, 'big'), nextCursor: { kind: 'delta', value: 'h-1' }, outsideWindow: 40_000 }),
    ]);

    const result = await runPull({
      tenant: fixture.runtime,
      control: fixture.controlSql,
      profile: HOSTED_PROFILE,
      source,
      states,
      now: NOW,
      queue: fixture.queue,
    });

    expect(result.outcome).toBe('deferred');
    expect(result.decision?.proceed).toBe('deferred');
    expect(result.counts.written).toBe(0);
    expect(
      await countRows(fixture.tenantSql, 'page', `origin_context = '${originContextFor('gmail', null)}'`),
    ).toBe(0);

    // The lane the job landed in is the one the schema admits for a connector.
    const jobId = result.decision?.proceed === 'deferred' ? result.decision.jobId : '';
    const job = await fixture.queue.get(jobId);
    expect(job?.kind).toBe('ingest_pull');
    expect(job?.target).toBe('gmail');
    expect(job?.trigger).toBe('user_request');

    // And the approval is banked where the resumed run will find it.
    const state = await states.read('gmail');
    expect(state?.backfill?.jobId).toBe(jobId);
    expect(state?.backfill?.approvedMicroUsd).toBeGreaterThan(0);
    expect(state?.cursor).toBeNull();
  });

  test('a deferral from a delta pull banks a bounded window, never an all-time one', async () => {
    // A delta pull runs unwindowed, because a delta feed is already bounded by
    // what changed. Its *deferral* is a different animal: the job that redeems
    // it may find the cursor expired and fall back to a re-list, and a banked
    // `windowDays: null` would make that re-list all-time — the unbounded first
    // import, arriving through the one door this module exists to keep shut.
    // Drive, because the gmail lane already holds an open job from the test
    // above and the queue's unique index would refuse a second one.
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: null });
    const states = await storeWith(
      stateFor({ cursor: { kind: 'delta', value: 'p-live', issuedAt: NOW.toISOString() } }, 'drive'),
    );
    const items = Array.from({ length: 600 }, (_, index) => ({
      externalRef: externalRefFor('drive', `delta-defer-${index}`),
      title: `doc ${index}`,
      body: mailBody(`delta-defer-${index}`, 1),
      occurredAt: NOW,
    }));
    const source = createFakeSource('drive', 'document', [
      page({ items, nextCursor: { kind: 'delta', value: 'p-next' } }),
    ]);

    const result = await runPull({
      tenant: fixture.runtime,
      control: fixture.controlSql,
      profile: HOSTED_PROFILE,
      source,
      states,
      now: NOW,
      queue: fixture.queue,
    });

    expect(result.mode).toBe('delta');
    expect(result.outcome).toBe('deferred');
    expect((await states.read('drive'))?.backfill?.windowDays).toBe(DEFAULT_WINDOW_DAYS);
  });

  test('the deferred job resumes under the approved cap without re-gating', async () => {
    const states = await storeWith(
      stateFor({
        backfill: { jobId: 'job-resume-1', approvedMicroUsd: 4_000_000, windowDays: 90 },
      }),
    );
    const source = createFakeSource('gmail', 'email', [
      page({ items: mailbox(2, 'resume'), nextCursor: { kind: 'delta', value: 'h-2' } }),
    ]);

    const handler = createIngestPullHandler({
      control: fixture.controlSql,
      profile: HOSTED_PROFILE,
      openTenant: () => Promise.resolve(fixture.runtime),
      openSource: () => Promise.resolve({ source, states }),
    });

    const lease: JobLease = {
      jobId: 'job-resume-1',
      tenantId: TENANT,
      kind: 'ingest_pull',
      target: 'gmail',
      leaseToken: 1,
      owner: 'worker-1',
      expiresAt: new Date(NOW.getTime() + 60_000),
      attemptDeadlineAt: new Date(NOW.getTime() + 600_000),
      attempts: 1,
      maxAttempts: 5,
      debtObserved: 0,
    };

    await handler({ lease, signal: new AbortController().signal, now: NOW });

    expect(
      await countRows(
        fixture.tenantSql,
        'page',
        `external_ref = '${externalRefFor('gmail', 'resume-0')}' AND deleted_at IS NULL`,
      ),
    ).toBe(1);

    const state = await states.read('gmail');
    // The approval is consumed, not left behind for a second free run.
    expect(state?.backfill).toBeNull();
    expect(state?.cursor?.value).toBe('h-2');
  });

  test('an approval belongs to the job it was deferred for, and to no other', async () => {
    // Spending whichever approval happens to be on the state would let one
    // deferral fund every later pull for that source.
    const banked = { jobId: 'job-resume-1', approvedMicroUsd: 4_000_000, windowDays: 90 };
    const states = await storeWith(stateFor({ backfill: banked }));
    const source = createFakeSource('gmail', 'email', [
      page({ items: mailbox(1, 'stranger'), nextCursor: { kind: 'delta', value: 'h-9' } }),
    ]);

    const handler = createIngestPullHandler({
      control: fixture.controlSql,
      profile: HOSTED_PROFILE,
      openTenant: () => Promise.resolve(fixture.runtime),
      openSource: () => Promise.resolve({ source, states }),
    });

    await handler({
      lease: {
        jobId: 'some-other-job',
        tenantId: TENANT,
        kind: 'ingest_pull',
        target: 'gmail',
        leaseToken: 1,
        owner: 'worker-1',
        expiresAt: new Date(NOW.getTime() + 60_000),
        attemptDeadlineAt: new Date(NOW.getTime() + 600_000),
        attempts: 1,
        maxAttempts: 5,
        debtObserved: 0,
      },
      signal: new AbortController().signal,
      now: NOW,
    });

    // Untouched: this run re-gated on its own account instead.
    expect((await states.read('gmail'))?.backfill).toEqual(banked);
  });

  test('inside the job there is nowhere to defer to, so the run is inline — never refused', async () => {
    // `no_queue` is the right answer for an interactive caller with nothing to
    // defer to. Inside the `ingest_pull` handler it would be a connector that
    // silently never backfills: the job IS the capped background job.
    const states = await storeWith(stateFor());
    const source = createFakeSource('gmail', 'email', [
      page({ items: mailbox(600, 'inline'), nextCursor: { kind: 'delta', value: 'h-3' } }),
    ]);

    const result = await runPull({
      tenant: fixture.runtime,
      control: fixture.controlSql,
      profile: HOSTED_PROFILE,
      source,
      states,
      now: NOW,
      interactive: false,
    });

    expect(result.outcome).not.toBe('refused');
    expect(result.decision?.proceed).toBe('inline');
  });
});

describe('the ceiling actually holds', () => {
  test('an exhausted cap refuses the pull and writes nothing', async () => {
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 900, capMicroUsd: 900 });
    const states = await storeWith(stateFor());
    const source = createFakeSource('gmail', 'email', [
      page({ items: mailbox(2, 'capped'), nextCursor: { kind: 'delta', value: 'h-4' } }),
    ]);

    const result = await runPull({
      tenant: fixture.runtime,
      control: fixture.controlSql,
      profile: HOSTED_PROFILE,
      source,
      states,
      now: NOW,
    });

    expect(result.outcome).toBe('refused');
    expect(result.decision?.proceed).toBe('refused');
    if (result.decision?.proceed === 'refused') expect(result.decision.reason).toBe('cap_exhausted');
    expect(
      await countRows(
        fixture.tenantSql,
        'page',
        `external_ref = '${externalRefFor('gmail', 'capped-0')}'`,
      ),
    ).toBe(0);
    // A refusal is a row in the ingest log, not a silence. Keyed on this run's
    // own id: the log is shared, and "the last row" is whatever ran last.
    expect(
      await countRows(
        fixture.tenantSql,
        'ingest_log',
        `ingest_id = ${result.runId} AND outcome = 'failed' AND failure_code = 'budget_exhausted'`,
      ),
    ).toBe(1);
    // And the cursor did not move over items nobody imported.
    expect((await states.read('gmail'))?.cursor).toBeNull();
  });

  test('a banked approval is re-clamped to the headroom that is actually left', async () => {
    // The deferral **reserved nothing**: `control.tenant` moved by zero when the
    // job was enqueued, because a deferral spends no money. So an approval sat
    // on a connector state is a claim on headroom nobody is holding. A resumed
    // job that spends it without asking again gives every deferred lane its own
    // full copy of the cap — three connectors and a chat-export deferral is four
    // times the ceiling, and each one looks correct on its own.
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 900, capMicroUsd: 900 });
    const states = await storeWith(
      stateFor({ backfill: { jobId: 'job-spent', approvedMicroUsd: 4_000_000, windowDays: 90 } }),
    );
    const source = createFakeSource('gmail', 'email', [
      page({ items: mailbox(2, 'spent'), nextCursor: { kind: 'delta', value: 'h-8' } }),
    ]);

    const handler = createIngestPullHandler({
      control: fixture.controlSql,
      profile: HOSTED_PROFILE,
      openTenant: () => Promise.resolve(fixture.runtime),
      openSource: () => Promise.resolve({ source, states }),
    });
    await handler({ lease: leaseFor('job-spent'), signal: new AbortController().signal, now: NOW });

    // Nothing imported, because there was nothing left to import it with.
    expect(
      await countRows(
        fixture.tenantSql,
        'page',
        `external_ref = '${externalRefFor('gmail', 'spent-0')}'`,
      ),
    ).toBe(0);
    // And the cursor did not move over work nobody paid for.
    expect((await states.read('gmail'))?.cursor).toBeNull();
  });

  test('a banked approval larger than the headroom spends the headroom, not the approval', async () => {
    // The refusal at zero headroom is the easy half. The half that fails
    // *open* is a tenant with a little left: clamp the approval to nothing and
    // the run refuses loudly, forget to clamp at all and it quietly spends the
    // whole banked figure. Both look identical from the outside unless the
    // budget is what actually bounds the writes.
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 899, capMicroUsd: 900 });
    const states = await storeWith(stateFor({}, 'drive'));
    const names = ['Alice Example', 'Bella Example', 'Carla Example'];
    const items = names.map((name, index) => ({
      externalRef: externalRefFor('drive', `clamped-${index}`),
      title: `doc ${index}`,
      // Long enough that ONE of them prices past the headroom below. It was one
      // paragraph against a seat priced eleven times higher; the headroom stayed
      // and the item grew, because the premise this test needs is "a tenant with
      // a little left", not a particular number of characters.
      body: `${name} is a partner at Widget Co. ${mailBody(`clamped-${index}`, 40)}`,
      occurredAt: NOW,
    }));
    const source = createFakeSource('drive', 'document', [
      page({ items, nextCursor: { kind: 'delta', value: 'p-clamped' } }),
    ]);

    const result = await runPull({
      tenant: fixture.runtime,
      control: fixture.controlSql,
      profile: HOSTED_PROFILE,
      source,
      states,
      now: NOW,
      interactive: false,
      approvedMicroUsd: 4_000_000,
    });

    expect(result.outcome).toBe('stopped');
    expect(result.stopReason).toBe('budget_exhausted');

    // **It spent the headroom and stopped, which is the whole claim.** One
    // micro-dollar of headroom buys exactly one fact embedding at the routed
    // seat's price — it bought none at the seat priced eleven times higher, and
    // that is the only thing about this test the seat move changed. What must
    // not happen, and is what "forget to clamp" looks like, is the run
    // proceeding on the banked four dollars: three items in, at most one out,
    // and the cursor left where it was so the rest are re-fetched rather than
    // skipped.
    expect(result.counts.written).toBeLessThan(items.length);
    expect(
      await countRows(
        fixture.tenantSql,
        'page',
        `external_ref = '${externalRefFor('drive', 'clamped-2')}'`,
      ),
    ).toBe(0);
    expect(result.cursorAdvanced).toBe(false);
  });

  test('a refused pull still stops answering with what the provider says is gone', async () => {
    // Deletions cost no provider call, which is why the runner applies them
    // whether or not the budget held. A refusal must obey the same rule: a
    // tenant at its cap that keeps a cancelled meeting live is the stale row
    // U11 reports against its replacement as a genuine contradiction — and the
    // cap is a thirty-day rolling window, so "until next month" is how long
    // that lasts. Worse, if the sync cursor expires in the meantime the
    // recovery re-list carries no tombstones at all and the deletion is lost
    // for good.
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: null });
    const ref = externalRefFor('calendar', 'e-capped');
    const written = await ingestDocument(
      {
        sql: fixture.runtime.sql,
        gateway: fixture.runtime.gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget(),
      },
      {
        originContext: originContextFor('calendar', null),
        sourceType: 'calendar',
        title: 'standup',
        body: mailBody('standup that was later cancelled'),
        externalRef: ref,
      },
    );
    expect(written.ok).toBe(true);

    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 900, capMicroUsd: 900 });
    const states = await storeWith(stateFor({}, 'calendar'));
    const source = createFakeSource('calendar', 'calendar', [
      page({
        items: [
          {
            externalRef: externalRefFor('calendar', 'e-live'),
            title: 'a new event',
            body: mailBody('a new event'),
            occurredAt: NOW,
          },
        ],
        tombstones: [{ externalRef: ref, reason: 'cancelled' }],
        nextCursor: { kind: 'delta', value: 'sync-capped' },
      }),
    ]);

    const result = await runPull({
      tenant: fixture.runtime,
      control: fixture.controlSql,
      profile: HOSTED_PROFILE,
      source,
      states,
      now: NOW,
    });

    expect(result.outcome).toBe('refused');
    expect(result.counts.tombstoned).toBe(1);
    expect(
      await countRows(fixture.tenantSql, 'page', `external_ref = '${ref}' AND deleted_at IS NULL`),
    ).toBe(0);
  });

  test('a run that exhausts its budget mid-pull stops and leaves the cursor alone', async () => {
    // One micro-dollar of headroom: the gate approves it (there IS headroom),
    // the budget refuses the first embedding call, and the run must stop rather
    // than collect one refusal per remaining item. The bodies state a fact each,
    // so the refusal lands in the item loop rather than in the chunk backlog —
    // which is where the `break` this asserts on actually lives.
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: 1 });
    const states = await storeWith(stateFor());
    const names = ['Alice Example', 'Bella Example', 'Carla Example', 'Dana Example'];
    const items = mailbox(4, 'broke').map((entry, index) => ({
      ...entry,
      body: `${names[index]} is a partner at Widget Co. ${entry.body}`,
    }));
    const source = createFakeSource('gmail', 'email', [
      page({ items, nextCursor: { kind: 'delta', value: 'h-5' } }),
    ]);

    const result = await runPull({
      tenant: fixture.runtime,
      control: fixture.controlSql,
      profile: HOSTED_PROFILE,
      source,
      states,
      now: NOW,
    });

    expect(result.outcome).toBe('stopped');
    expect(result.stopReason).toBe('budget_exhausted');
    // The break, not a wall of identical refusals: the loop stopped early and
    // left no failure rows behind it.
    expect(result.attemptedItems).toBeLessThan(4);
    expect(result.counts.failed).toBe(0);
    expect(result.cursorAdvanced).toBe(false);
    expect((await states.read('gmail'))?.cursor).toBeNull();
    // And what it could not pay for was not written: the item the budget
    // refused has no page, so re-running resumes rather than repairing.
    expect(
      await countRows(
        fixture.tenantSql,
        'page',
        `external_ref = '${externalRefFor('gmail', `broke-${result.attemptedItems - 1}`)}'`,
      ),
    ).toBe(0);
  });
});
