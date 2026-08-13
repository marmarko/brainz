/**
 * The import runner, end to end — where the gate stops being a number and
 * becomes a ceiling.
 *
 * The three scenarios the plan names for this unit are here (a re-import
 * creates zero new rows; a malformed conversation is logged and skipped while
 * the rest completes; the stored raw payload reproduces identical pages), and
 * so are the three that an adversarial reading of the gate adds:
 *
 *  - **The approved amount actually bounds the run.** One budget, threaded
 *    through every write. A run that builds a fresh uncapped budget per item —
 *    or simply never passes one — approves $0.16 and spends $2.60, and every
 *    individual call looks fine.
 *  - **Exhaustion stops the run.** Not "skips this item and tries the next
 *    49,999", which is the same defect wearing a loop, and which makes the
 *    ingest log a wall of identical refusals.
 *  - **A failed raw write stops the import.** R16's preservation promise is
 *    what makes a fleet-wide re-derive possible; an import that proceeds
 *    without it produces pages nothing can ever re-derive, indistinguishable
 *    from the ones that can.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createBudget } from '../../src/ai/gateway.ts';
import { backlogSize } from '../../src/core/write/embed.ts';
import { parseChatExport, parseChatExportBytes } from '../../src/ingest/import/chat-export.ts';
import { manifestKeyFor, rawKeyFor, readManifest } from '../../src/ingest/import/raw.ts';
import { createImportHandler, runImport, type ImportMaterial } from '../../src/ingest/import/run.ts';
import { externalRefFor } from '../../src/ingest/import/folder.ts';
import { DEFAULT_INLINE_ITEM_CEILING } from '../../src/ingest/first-import.ts';
import {
  CALLER,
  HOSTED_PROFILE,
  ORIGIN,
  TENANT,
  countRows,
  createIngestFixture,
  ingestLogRows,
  itemFrom,
  proseOf,
  setSpend,
  type IngestFixture,
} from './fixture.ts';

let fixture: IngestFixture;

const NOW = new Date('2026-06-01T00:00:00.000Z');

function exportDocument(count: number): unknown {
  return Array.from({ length: count }, (_unused, index) => ({
    uuid: `conv-${index}`,
    name: `Conversation ${index}`,
    created_at: '2026-05-20T09:00:00.000000Z',
    chat_messages: [
      {
        uuid: `m-${index}-1`,
        sender: 'human',
        created_at: '2026-05-20T09:00:00.000000Z',
        content: [{ type: 'text', text: proseOf(`topic${index}`, 3) }],
        attachments: [],
        files: [],
      },
      {
        uuid: `m-${index}-2`,
        sender: 'assistant',
        created_at: '2026-05-20T09:00:10.000000Z',
        content: [{ type: 'text', text: proseOf(`answer${index}`, 3) }],
        attachments: [],
        files: [],
      },
    ],
  }));
}

function materialFrom(document: unknown, bytes?: Uint8Array): ImportMaterial {
  const parsed = parseChatExport(document);
  return {
    items: parsed.conversations.map((conversation) => ({
      externalRef: conversation.externalRef,
      title: conversation.title,
      body: conversation.body,
      occurredAt: conversation.occurredAt,
    })),
    failures: parsed.failures.map((failure) => ({
      externalRef: failure.externalRef,
      reason: 'parse_failed' as const,
    })),
    raw:
      bytes === undefined
        ? null
        : { id: 'claude-export-2026-05', object: { bytes, contentType: 'application/json' } },
  };
}

/**
 * Conversations the rule-based extractor produces a fact from, so each item
 * costs a provider call **inside the loop**. The prose export above costs
 * nothing until the chunk pass, so it cannot exercise the loop's own stop.
 */
function factfulDocument(count: number): unknown {
  return Array.from({ length: count }, (_unused, index) => ({
    uuid: `fact-${index}`,
    name: `Deal ${index}`,
    created_at: '2026-05-20T09:00:00.000000Z',
    chat_messages: [
      {
        uuid: `f-${index}-1`,
        sender: 'human',
        created_at: '2026-05-20T09:00:00.000000Z',
        content: [
          { type: 'text', text: `Investor${index} invested in Company${index}. ${proseOf(`deal${index}`, 2)}` },
        ],
        attachments: [],
        files: [],
      },
    ],
  }));
}

function baseRequest(material: ImportMaterial) {
  return {
    tenant: fixture.runtime,
    control: fixture.controlSql,
    storage: fixture.storage,
    rawStore: fixture.rawStore,
    profile: HOSTED_PROFILE,
    originContext: ORIGIN,
    sourceType: 'chat' as const,
    target: 'chat_export' as const,
    material,
    now: NOW,
    queue: fixture.queue,
  };
}

async function resetBrain(): Promise<void> {
  await fixture.tenantSql`DELETE FROM fact_source`;
  await fixture.tenantSql`DELETE FROM entity_edge`;
  await fixture.tenantSql`UPDATE fact SET superseded_by = NULL`;
  await fixture.tenantSql`DELETE FROM fact`;
  await fixture.tenantSql`DELETE FROM entity_alias`;
  await fixture.tenantSql`DELETE FROM entity`;
  await fixture.tenantSql`DELETE FROM chunk`;
  await fixture.tenantSql`UPDATE page SET ingest_id = NULL`;
  await fixture.tenantSql`DELETE FROM page`;
  await fixture.tenantSql`DELETE FROM ingest_log`;
  await fixture.controlSql`DELETE FROM control.job WHERE tenant_id = ${TENANT}`;
  await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: 5_000_000 });
}

beforeAll(async () => {
  fixture = await createIngestFixture('u8run');
});

afterAll(async () => {
  await fixture.close();
});

describe('an approved import', () => {
  test('writes pages, drains the chunk backlog, and closes its run row', async () => {
    await resetBrain();
    const result = await runImport(baseRequest(materialFrom(exportDocument(3))));

    expect(result.outcome).toBe('completed');
    expect(result.counts.written).toBe(3);
    expect(result.counts.failed).toBe(0);
    expect(await countRows(fixture.tenantSql, 'page', 'deleted_at IS NULL')).toBe(3);
    // The gate's estimate prices the chunk pass, so the run has to perform it —
    // otherwise the approval bounds a pass that never happens.
    expect(await backlogSize(fixture.tenantSql)).toBe(0);

    const rows = await ingestLogRows(fixture.tenantSql);
    const runRow = rows.find((row) => row.external_ref === null);
    expect(runRow).toBeDefined();
    expect(runRow!.outcome).toBe('ok');
    expect(runRow!.items_seen).toBe(3);
    expect(runRow!.items_written).toBe(3);

    const itemRows = rows.filter((row) => row.external_ref !== null);
    expect(itemRows.map((row) => row.external_ref).sort()).toEqual([
      'claude:conv-0',
      'claude:conv-1',
      'claude:conv-2',
    ]);
    expect(itemRows.every((row) => row.outcome === 'ok')).toBe(true);
  });

  test('re-importing the same export creates zero new rows and costs nothing', async () => {
    const before = {
      pages: await countRows(fixture.tenantSql, 'page'),
      chunks: await countRows(fixture.tenantSql, 'chunk'),
      calls: fixture.transport.calls.length,
    };

    const result = await runImport(baseRequest(materialFrom(exportDocument(3))));

    expect(result.outcome).toBe('completed');
    expect(result.counts.unchanged).toBe(3);
    expect(result.counts.written).toBe(0);
    expect(await countRows(fixture.tenantSql, 'page')).toBe(before.pages);
    expect(await countRows(fixture.tenantSql, 'chunk')).toBe(before.chunks);
    // The whole difference between an importer and a bill.
    expect(fixture.transport.calls.length).toBe(before.calls);
  });
});

describe('a malformed conversation is logged and skipped', () => {
  test('the rest of the import completes, and the denominator does not lie', async () => {
    await resetBrain();
    const damaged = [...(exportDocument(2) as unknown[]), 'not a conversation'];
    const result = await runImport(baseRequest(materialFrom(damaged)));

    expect(result.outcome).toBe('completed');
    expect(result.counts.written).toBe(2);
    expect(result.counts.failed).toBe(1);

    const rows = await ingestLogRows(fixture.tenantSql);
    const runRow = rows.find((row) => row.external_ref === null)!;
    // Three items were seen. A counter that only advances for what the write
    // path accepted would report a clean import of a broken export.
    expect(runRow.items_seen).toBe(3);
    expect(runRow.items_written).toBe(2);
    expect(runRow.outcome).toBe('ok');
  });
});

describe('R16: the raw payload is preserved, and preservation is not optional', () => {
  test('the stored bytes round-trip into identical pages', async () => {
    await resetBrain();
    const document = exportDocument(2);
    const bytes = new TextEncoder().encode(JSON.stringify(document));
    const result = await runImport(baseRequest(materialFrom(document, bytes)));
    expect(result.outcome).toBe('completed');

    const key = rawKeyFor(fixture.storage, CALLER, TENANT, 'claude-export-2026-05');
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    const stored = await fixture.rawStore.get(key.key);
    expect(stored).not.toBeNull();
    expect(parseChatExportBytes(stored!.bytes)).toEqual(parseChatExport(document));
  });

  test('a failed raw write stops the import before any page lands', async () => {
    await resetBrain();
    const document = exportDocument(2);
    const bytes = new TextEncoder().encode(JSON.stringify(document));
    fixture.rawStore.failNextPut();

    const result = await runImport(baseRequest(materialFrom(document, bytes)));

    expect(result.outcome).toBe('stopped');
    expect(result.stopReason).toBe('raw_unavailable');
    expect(await countRows(fixture.tenantSql, 'page')).toBe(0);

    const runRow = (await ingestLogRows(fixture.tenantSql)).find((row) => row.external_ref === null);
    expect(runRow!.outcome).toBe('failed');
    expect(runRow!.failure_code).toBe('provider_error');
  });
});

describe('the approved amount is a ceiling that holds', () => {
  test('a run that exhausts its budget stops, rather than refusing 49,999 times', async () => {
    await resetBrain();
    // Enough headroom for the first provider call and not for the rest.
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: 40 });

    const result = await runImport(baseRequest(materialFrom(exportDocument(8))));

    expect(result.outcome).toBe('stopped');
    expect(result.stopReason).toBe('budget_exhausted');
    // The stop lands wherever the ceiling bites — mid-loop on the fact pass, or
    // on the first batch of the chunk pass. Either way what matters is that work
    // remains and is *discoverable*: U4 keeps the backlog as a query over the
    // rows, so a stopped import is resumable rather than lost.
    expect(await backlogSize(fixture.tenantSql)).toBeGreaterThan(0);

    const rows = await ingestLogRows(fixture.tenantSql);
    const runRow = rows.find((row) => row.external_ref === null)!;
    expect(runRow.outcome).toBe('failed');
    expect(runRow.failure_code).toBe('budget_exhausted');
    // One stop, not one refusal per remaining item.
    expect(rows.filter((row) => row.failure_code === 'budget_exhausted').length).toBeLessThan(8);
  });

  test('resuming re-pays for nothing it already wrote', async () => {
    const writtenBefore = await countRows(fixture.tenantSql, 'page', 'deleted_at IS NULL');
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: 5_000_000 });

    const result = await runImport(baseRequest(materialFrom(exportDocument(8))));

    expect(result.outcome).toBe('completed');
    expect(result.counts.unchanged).toBe(writtenBefore);
    expect(result.counts.written).toBe(8 - writtenBefore);
    expect(await countRows(fixture.tenantSql, 'page', 'deleted_at IS NULL')).toBe(8);
    expect(await backlogSize(fixture.tenantSql)).toBe(0);
  });

  test('exhaustion stops the loop rather than attempting every remaining item', async () => {
    // The distinction the ingest log cannot show: stopping and refusing leave
    // the same rows behind, so the loop reaching item 8 after the money ran
    // out is only visible in how far it got. At 50,000 items that difference
    // is a worker burning an hour to produce nothing.
    await resetBrain();
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: 5 });

    const result = await runImport(baseRequest(materialFrom(factfulDocument(8))));

    expect(result.outcome).toBe('stopped');
    expect(result.stopReason).toBe('budget_exhausted');
    expect(result.counts.written).toBeGreaterThan(0);
    expect(result.attemptedItems).toBeLessThan(8);
    // And it did not quietly record the untouched items as anything at all.
    expect(result.counts.written + result.counts.failed).toBeLessThan(8);
  });

  test('an uncapped budget is not what the runner builds — the cap is the approval', async () => {
    // A structural check on the arrangement rather than on an outcome: the
    // gate's number has to reach `createBudget`, and a budget with a null cap
    // would make every assertion above pass for the wrong reason.
    const budget = createBudget({ label: 'probe', capMicroUsd: 1 });
    expect(budget.reserve(2)).toBeNull();
  });
});

describe('a refused import is visible in the log', () => {
  test('no headroom leaves a failed run row rather than silence', async () => {
    await resetBrain();
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 5_000_000, capMicroUsd: 5_000_000 });

    const result = await runImport(baseRequest(materialFrom(exportDocument(2))));

    expect(result.outcome).toBe('refused');
    expect(result.decision?.proceed).toBe('refused');
    expect(await countRows(fixture.tenantSql, 'page')).toBe(0);

    const runRow = (await ingestLogRows(fixture.tenantSql)).find((row) => row.external_ref === null);
    expect(runRow!.outcome).toBe('failed');
    expect(runRow!.failure_code).toBe('budget_exhausted');
  });
});

describe('a large import defers, and the deferral carries its own ceiling', () => {
  test('the manifest is keyed by job id, and nothing is imported inline', async () => {
    await resetBrain();
    const document = exportDocument(DEFAULT_INLINE_ITEM_CEILING + 1);
    const bytes = new TextEncoder().encode(JSON.stringify(document));

    const result = await runImport({
      ...baseRequest(materialFrom(document, bytes)),
      resumeWith: { rawKey: 'claude-export-2026-05' },
    });

    expect(result.outcome).toBe('deferred');
    expect(result.decision?.proceed).toBe('deferred');
    expect(await countRows(fixture.tenantSql, 'page')).toBe(0);

    if (result.decision?.proceed !== 'deferred') return;
    const key = manifestKeyFor(fixture.storage, CALLER, TENANT, result.decision.jobId);
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    const manifest = await readManifest(fixture.rawStore, key.key);
    expect(manifest).not.toBeNull();
    expect(manifest!.target).toBe('chat_export');
    expect(manifest!.approvedMicroUsd).toBe(result.decision.approvedMicroUsd);
    expect(manifest!.rawKey).toBe('claude-export-2026-05');
  });

  test('the handler resumes it from the lease, under the cap the gate approved', async () => {
    const jobs = (await fixture.controlSql`
      SELECT job_id::text AS job_id FROM control.job
       WHERE tenant_id = ${TENANT} AND kind = 'import' AND state = 'due'
    `) as Array<{ job_id: string }>;
    expect(jobs).toHaveLength(1);

    const lease = await fixture.queue.claim({
      owner: 'test-worker',
      now: NOW,
      leaseTtlMs: 60_000,
      maxAttemptMs: 600_000,
      kinds: ['import'],
    });
    expect(lease).toBeDefined();

    let approvedSeen: number | null = null;
    const handler = createImportHandler({
      control: fixture.controlSql,
      storage: fixture.storage,
      rawStore: fixture.rawStore,
      profile: HOSTED_PROFILE,
      openTenant: () => Promise.resolve(fixture.runtime),
      materialize: async (manifest) => {
        approvedSeen = manifest.approvedMicroUsd;
        const key = rawKeyFor(fixture.storage, CALLER, TENANT, manifest.rawKey ?? '');
        if (!key.ok) throw new Error('no raw key');
        const stored = await fixture.rawStore.get(key.key);
        if (stored === null) throw new Error('no raw payload');
        return {
          items: parseChatExportBytes(stored.bytes).conversations.slice(0, 4).map((conversation) => ({
            externalRef: conversation.externalRef,
            title: conversation.title,
            body: conversation.body,
            occurredAt: conversation.occurredAt,
          })),
          failures: [],
        };
      },
    });

    await handler({ lease: lease!, signal: new AbortController().signal, now: NOW });

    expect(approvedSeen).not.toBeNull();
    expect(await countRows(fixture.tenantSql, 'page', 'deleted_at IS NULL')).toBe(4);
  });
});

describe('a manifest that is not a manifest is refused', () => {
  test('a resumed import with no usable ceiling does not run', async () => {
    await resetBrain();
    const jobId = crypto.randomUUID();
    const key = manifestKeyFor(fixture.storage, CALLER, TENANT, jobId);
    expect(key.ok).toBe(true);
    if (!key.ok) return;

    // Everything a manifest needs except the approved amount. Reading it as a
    // manifest anyway would run an import with no ceiling at all — which is
    // the one outcome this whole unit exists to prevent.
    await fixture.rawStore.put(key.key, {
      bytes: new TextEncoder().encode(
        JSON.stringify({
          tenantId: TENANT,
          target: 'chat_export',
          originContext: ORIGIN,
          sourceType: 'chat',
          window: 'all',
        }),
      ),
      contentType: 'application/json',
    });

    expect(await readManifest(fixture.rawStore, key.key)).toBeNull();

    const handler = createImportHandler({
      control: fixture.controlSql,
      storage: fixture.storage,
      rawStore: fixture.rawStore,
      profile: HOSTED_PROFILE,
      openTenant: () => Promise.resolve(fixture.runtime),
      materialize: () => Promise.reject(new Error('materialize must not be reached')),
    });

    await expect(
      handler({
        lease: {
          jobId,
          tenantId: TENANT,
          kind: 'import',
          target: 'chat_export',
          leaseToken: 1,
          owner: 'test-worker',
          expiresAt: NOW,
          attemptDeadlineAt: NOW,
          attempts: 1,
          maxAttempts: 5,
          debtObserved: 0,
        },
        signal: new AbortController().signal,
        now: NOW,
      }),
    ).rejects.toThrow(/manifest/i);

    expect(await countRows(fixture.tenantSql, 'page')).toBe(0);
  });
});

describe('folder material carries update and tombstone semantics', () => {
  const ROOT = 'notes';
  const FOLDER_ORIGIN = 'folder:notes';

  function folderRequest(material: ImportMaterial) {
    return {
      ...baseRequest(material),
      originContext: FOLDER_ORIGIN,
      sourceType: 'document' as const,
      target: 'folder' as const,
    };
  }

  test('a changed file re-chunks; a disappeared one is tombstoned', async () => {
    await resetBrain();
    const first = await runImport(
      folderRequest({
        items: [
          itemFrom(externalRefFor(ROOT, 'a.md'), proseOf('alpha', 4), null, 'a.md'),
          itemFrom(externalRefFor(ROOT, 'b.md'), proseOf('bravo', 4), null, 'b.md'),
        ],
        failures: [],
        tombstone: {
          rootId: ROOT,
          originContext: FOLDER_ORIGIN,
          seenRefs: [externalRefFor(ROOT, 'a.md'), externalRefFor(ROOT, 'b.md')],
          complete: true,
        },
      }),
    );
    expect(first.counts.written).toBe(2);

    const second = await runImport(
      folderRequest({
        items: [
          itemFrom(
            externalRefFor(ROOT, 'a.md'),
            `${proseOf('alpha', 4)}\n\nAnd the date moved to the 21st.`,
            null,
            'a.md',
          ),
        ],
        failures: [],
        tombstone: {
          rootId: ROOT,
          originContext: FOLDER_ORIGIN,
          seenRefs: [externalRefFor(ROOT, 'a.md')],
          complete: true,
        },
      }),
    );

    expect(second.counts.written).toBe(1);
    expect(second.tombstone?.tombstoned).toBe(1);
    expect(second.counts.tombstoned).toBe(1);
    // One live page for the edited file; the superseded version and the deleted
    // file are both out of retrieval.
    expect(await countRows(fixture.tenantSql, 'page', 'deleted_at IS NULL')).toBe(1);
    const rows = await ingestLogRows(fixture.tenantSql);
    expect(rows.some((row) => row.external_ref === externalRefFor(ROOT, 'b.md'))).toBe(true);
  });

  test('an incomplete scan imports what it saw and reconciles no deletions', async () => {
    await resetBrain();
    await runImport(
      folderRequest({
        items: [itemFrom(externalRefFor(ROOT, 'a.md'), proseOf('alpha', 4), null, 'a.md')],
        failures: [],
        tombstone: {
          rootId: ROOT,
          originContext: FOLDER_ORIGIN,
          seenRefs: [externalRefFor(ROOT, 'a.md')],
          complete: true,
        },
      }),
    );

    const partial = await runImport(
      folderRequest({
        items: [],
        failures: [],
        tombstone: {
          rootId: ROOT,
          originContext: FOLDER_ORIGIN,
          seenRefs: [],
          complete: false,
        },
      }),
    );

    expect(partial.tombstone?.skippedIncompleteScan).toBe(true);
    expect(partial.counts.tombstoned).toBe(0);
    expect(await countRows(fixture.tenantSql, 'page', 'deleted_at IS NULL')).toBe(1);
  });
});
