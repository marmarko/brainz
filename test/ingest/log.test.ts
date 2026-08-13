/**
 * The ingest log: two row shapes over one table, and the properties that make
 * staleness derivable from it.
 *
 * The load-bearing assertions here are the ones about what a row must *never*
 * be, because each of them is a way a later promise goes quietly wrong:
 *
 *  - **An item row is never `running`.** U6's `search_degraded` counts running
 *    rows to decide whether an import is in flight, so an item row that opens
 *    running and is updated terminal makes a brain claim to be importing for as
 *    long as it takes something to crash between the two statements.
 *  - **A sweep never closes a live run.** The reverse failure, and the more
 *    damaging one: a brain that stops reporting an import that is still running.
 *  - **A run row exists even when nothing was imported.** "Checked and found
 *    nothing" and "never checked" are different sentences, and only the run row
 *    can say the first.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  ABANDONED_RUN_AFTER_MS,
  INGEST_FAILURE_CODES,
  countRunItem,
  finishRun,
  openRun,
  recordItem,
  sourceStaleness,
  sweepAbandonedRuns,
  type ItemDisposition,
} from '../../src/ingest/log.ts';
import { ORIGIN, createIngestFixture, ingestLogRows, type IngestFixture } from './fixture.ts';

let fixture: IngestFixture;

beforeAll(async () => {
  fixture = await createIngestFixture('u8log');
});

afterAll(async () => {
  await fixture.close();
});

async function reset(): Promise<void> {
  await fixture.tenantSql`UPDATE page SET ingest_id = NULL`;
  await fixture.tenantSql`DELETE FROM ingest_log`;
}

describe('a run row', () => {
  test('opens running with no external ref, and closes terminal', async () => {
    await reset();
    const run = await openRun(fixture.tenantSql, { originContext: ORIGIN, sourceType: 'chat' });
    expect(run.sweptAbandoned).toBe(0);

    let rows = await ingestLogRows(fixture.tenantSql);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.external_ref).toBeNull();
    expect(rows[0]!.outcome).toBe('running');
    expect(rows[0]!.finished_at).toBeNull();

    await finishRun(fixture.tenantSql, run.ingestId, { outcome: 'ok' });
    rows = await ingestLogRows(fixture.tenantSql);
    expect(rows[0]!.outcome).toBe('ok');
    expect(rows[0]!.finished_at).not.toBeNull();
  });

  test('records a failure as a code, never a message', async () => {
    await reset();
    const run = await openRun(fixture.tenantSql, { originContext: ORIGIN, sourceType: 'chat' });
    await finishRun(fixture.tenantSql, run.ingestId, {
      outcome: 'failed',
      failureCode: 'budget_exhausted',
    });
    const rows = await ingestLogRows(fixture.tenantSql);
    expect(rows[0]!.outcome).toBe('failed');
    expect(rows[0]!.failure_code).toBe('budget_exhausted');
  });

  test('counts an item the write path never saw', async () => {
    await reset();
    const run = await openRun(fixture.tenantSql, { originContext: ORIGIN, sourceType: 'chat' });
    await countRunItem(fixture.tenantSql, run.ingestId, { written: 0, quarantined: 0 });
    await countRunItem(fixture.tenantSql, run.ingestId, { written: 1, quarantined: 0 });
    const rows = await ingestLogRows(fixture.tenantSql);
    expect(rows[0]!.items_seen).toBe(2);
    expect(rows[0]!.items_written).toBe(1);
  });

  test('every failure code this module names is one the schema accepts', async () => {
    await reset();
    for (const code of INGEST_FAILURE_CODES) {
      const run = await openRun(fixture.tenantSql, { originContext: ORIGIN, sourceType: 'chat' });
      await finishRun(fixture.tenantSql, run.ingestId, { outcome: 'failed', failureCode: code });
    }
    const rows = await ingestLogRows(fixture.tenantSql);
    expect(rows.map((row) => row.failure_code)).toEqual([...INGEST_FAILURE_CODES]);
  });
});

describe('an item row', () => {
  const cases: ReadonlyArray<
    readonly [ItemDisposition, string, { seen: number; written: number; quarantined: number }]
  > = [
    ['written', 'ok', { seen: 1, written: 1, quarantined: 0 }],
    ['unchanged', 'ok', { seen: 1, written: 0, quarantined: 0 }],
    ['quarantined', 'ok', { seen: 1, written: 0, quarantined: 1 }],
    ['tombstoned', 'ok', { seen: 1, written: 0, quarantined: 0 }],
    ['failed', 'failed', { seen: 1, written: 0, quarantined: 0 }],
  ];

  test('carries the provider item id and lands already terminal', async () => {
    await reset();
    for (const [disposition, outcome, counts] of cases) {
      await recordItem(fixture.tenantSql, {
        originContext: ORIGIN,
        sourceType: 'chat',
        externalRef: `item-${disposition}`,
        disposition,
        ...(disposition === 'failed' ? { failureCode: 'parse_failed' as const } : {}),
      });
      const rows = await ingestLogRows(fixture.tenantSql);
      const row = rows.find((candidate) => candidate.external_ref === `item-${disposition}`);
      expect(row).toBeDefined();
      expect(row!.outcome).toBe(outcome);
      expect(row!.finished_at).not.toBeNull();
      expect(row!.items_seen).toBe(counts.seen);
      expect(row!.items_written).toBe(counts.written);
      expect(row!.items_quarantined).toBe(counts.quarantined);
    }
  });

  test('is never running, whatever the disposition — U6 counts running rows', async () => {
    await reset();
    for (const [disposition] of cases) {
      await recordItem(fixture.tenantSql, {
        originContext: ORIGIN,
        sourceType: 'chat',
        externalRef: `never-running-${disposition}`,
        disposition,
        ...(disposition === 'failed' ? { failureCode: 'parse_failed' as const } : {}),
      });
    }
    const rows = await ingestLogRows(fixture.tenantSql);
    expect(rows.filter((row) => row.outcome === 'running')).toEqual([]);
  });
});

describe('the abandoned-run sweep', () => {
  test('closes wreckage older than the threshold as cancelled, not failed', async () => {
    await reset();
    const stale = await openRun(fixture.tenantSql, { originContext: ORIGIN, sourceType: 'chat' });
    await fixture.tenantSql`
      UPDATE ingest_log SET started_at = now() - interval '7 hours'
       WHERE ingest_id = ${stale.ingestId}::bigint
    `;

    const swept = await sweepAbandonedRuns(fixture.tenantSql, {
      originContext: ORIGIN,
      sourceType: 'chat',
      olderThanMs: ABANDONED_RUN_AFTER_MS,
    });
    expect(swept).toBe(1);

    const rows = await ingestLogRows(fixture.tenantSql);
    expect(rows[0]!.outcome).toBe('cancelled');
    expect(rows[0]!.failure_code).toBe('cancelled');
    expect(rows[0]!.finished_at).not.toBeNull();
  });

  test('leaves a live run alone — the failure in the other direction', async () => {
    await reset();
    const live = await openRun(fixture.tenantSql, { originContext: ORIGIN, sourceType: 'chat' });
    const swept = await sweepAbandonedRuns(fixture.tenantSql, {
      originContext: ORIGIN,
      sourceType: 'chat',
      olderThanMs: ABANDONED_RUN_AFTER_MS,
    });
    expect(swept).toBe(0);

    const rows = await ingestLogRows(fixture.tenantSql);
    expect(rows.find((row) => row.ingest_id === live.ingestId)!.outcome).toBe('running');
  });

  test('is scoped to its own source', async () => {
    await reset();
    const other = await openRun(fixture.tenantSql, {
      originContext: 'folder:notes',
      sourceType: 'document',
    });
    await fixture.tenantSql`UPDATE ingest_log SET started_at = now() - interval '7 hours'`;

    const swept = await sweepAbandonedRuns(fixture.tenantSql, {
      originContext: ORIGIN,
      sourceType: 'chat',
      olderThanMs: ABANDONED_RUN_AFTER_MS,
    });
    expect(swept).toBe(0);
    const rows = await ingestLogRows(fixture.tenantSql);
    expect(rows.find((row) => row.ingest_id === other.ingestId)!.outcome).toBe('running');
  });

  test('opening a run cleans up after a crashed one, and never after itself', async () => {
    await reset();
    const crashed = await openRun(fixture.tenantSql, { originContext: ORIGIN, sourceType: 'chat' });
    await fixture.tenantSql`
      UPDATE ingest_log SET started_at = now() - interval '7 hours'
       WHERE ingest_id = ${crashed.ingestId}::bigint
    `;

    const fresh = await openRun(fixture.tenantSql, { originContext: ORIGIN, sourceType: 'chat' });
    expect(fresh.sweptAbandoned).toBe(1);

    const rows = await ingestLogRows(fixture.tenantSql);
    expect(rows.find((row) => row.ingest_id === crashed.ingestId)!.outcome).toBe('cancelled');
    expect(rows.find((row) => row.ingest_id === fresh.ingestId)!.outcome).toBe('running');
  });
});

describe('staleness is derived from the log, per source', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');

  test('a source that produced nothing recently is stale by its last write', async () => {
    await reset();
    const run = await openRun(fixture.tenantSql, { originContext: ORIGIN, sourceType: 'chat' });
    await countRunItem(fixture.tenantSql, run.ingestId, { written: 1, quarantined: 0 });
    await finishRun(fixture.tenantSql, run.ingestId, { outcome: 'ok' });
    await fixture.tenantSql`
      UPDATE ingest_log SET finished_at = ${new Date('2026-05-09T00:00:00.000Z')}
       WHERE ingest_id = ${run.ingestId}::bigint
    `;

    const [source] = await sourceStaleness(fixture.tenantSql, { now });
    expect(source).toBeDefined();
    expect(source!.originContext).toBe(ORIGIN);
    expect(source!.sourceType).toBe('chat');
    expect(source!.itemsWritten).toBe(1);
    expect(source!.staleSeconds).toBe(23 * 24 * 60 * 60);
    expect(source!.runInProgress).toBe(false);
  });

  test('checked-and-found-nothing is not the same as never-checked', async () => {
    await reset();
    const run = await openRun(fixture.tenantSql, { originContext: ORIGIN, sourceType: 'chat' });
    await finishRun(fixture.tenantSql, run.ingestId, { outcome: 'ok' });

    const [source] = await sourceStaleness(fixture.tenantSql, { now });
    expect(source!.lastCheckedAt).not.toBeNull();
    expect(source!.lastWriteAt).toBeNull();
    expect(source!.staleSeconds).toBeNull();
    expect(source!.itemsWritten).toBe(0);
  });

  test('a run still in flight says so, and a failed one says why', async () => {
    await reset();
    await openRun(fixture.tenantSql, { originContext: ORIGIN, sourceType: 'chat' });
    let [source] = await sourceStaleness(fixture.tenantSql, { now });
    expect(source!.runInProgress).toBe(true);

    const failed = await openRun(fixture.tenantSql, {
      originContext: 'folder:notes',
      sourceType: 'document',
    });
    await finishRun(fixture.tenantSql, failed.ingestId, {
      outcome: 'failed',
      failureCode: 'budget_exhausted',
    });
    const sources = await sourceStaleness(fixture.tenantSql, { now });
    source = sources.find((candidate) => candidate.originContext === 'folder:notes');
    expect(source!.lastFailureCode).toBe('budget_exhausted');
  });

  test('an item nobody could import is visible, not filtered out of the view', async () => {
    // The run row says the run succeeded; the loss is entirely in the item
    // rows. A staleness view keyed on `external_ref IS NULL` cannot see it, so
    // the brain reports itself healthy while a slice of the mailbox is missing.
    await reset();
    const run = await openRun(fixture.tenantSql, { originContext: ORIGIN, sourceType: 'chat' });
    await countRunItem(fixture.tenantSql, run.ingestId, { written: 0, quarantined: 0 });
    await recordItem(fixture.tenantSql, {
      originContext: ORIGIN,
      sourceType: 'chat',
      externalRef: 'claude:conv-lost',
      disposition: 'failed',
      failureCode: 'rate_limited',
    });
    await finishRun(fixture.tenantSql, run.ingestId, { outcome: 'ok' });

    const [source] = await sourceStaleness(fixture.tenantSql, { now });
    expect(source!.itemsFailed).toBe(1);
    expect(source!.lastItemFailureCode).toBe('rate_limited');
  });

  test('a later success clears the last failure code', async () => {
    // One cursor expiry writes a failed run row. Reading "the most recent
    // failure ever" rather than "the most recent outcome" makes that row the
    // permanent answer to `why is this source unhappy`, months after it healed.
    await reset();
    const failed = await openRun(fixture.tenantSql, { originContext: ORIGIN, sourceType: 'chat' });
    await finishRun(fixture.tenantSql, failed.ingestId, {
      outcome: 'failed',
      failureCode: 'provider_error',
    });
    let [source] = await sourceStaleness(fixture.tenantSql, { now });
    expect(source!.lastFailureCode).toBe('provider_error');

    const recovered = await openRun(fixture.tenantSql, {
      originContext: ORIGIN,
      sourceType: 'chat',
    });
    await finishRun(fixture.tenantSql, recovered.ingestId, { outcome: 'ok' });

    [source] = await sourceStaleness(fixture.tenantSql, { now });
    expect(source!.lastFailureCode).toBeNull();
  });

  test('item rows and run rows are not double counted', async () => {
    await reset();
    const run = await openRun(fixture.tenantSql, { originContext: ORIGIN, sourceType: 'chat' });
    await countRunItem(fixture.tenantSql, run.ingestId, { written: 1, quarantined: 0 });
    await recordItem(fixture.tenantSql, {
      originContext: ORIGIN,
      sourceType: 'chat',
      externalRef: 'claude:conv-1',
      disposition: 'written',
    });
    await finishRun(fixture.tenantSql, run.ingestId, { outcome: 'ok' });

    const [source] = await sourceStaleness(fixture.tenantSql, { now });
    // One item was imported. Two rows describe it; the count is still one.
    expect(source!.itemsSeen).toBe(1);
    expect(source!.itemsWritten).toBe(1);
  });
});
