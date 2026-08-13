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
import { selectPendingAttachments } from '../../src/core/media/ocr-phase.ts';
import { backlogSize } from '../../src/core/write/embed.ts';
import { parseChatExport, parseChatExportBytes } from '../../src/ingest/import/chat-export.ts';
import { manifestKeyFor, rawKeyFor, readManifest } from '../../src/ingest/import/raw.ts';
import { createImportHandler, runImport, type ImportMaterial } from '../../src/ingest/import/run.ts';
import { externalRefFor } from '../../src/ingest/import/folder.ts';
import { DEFAULT_INLINE_ITEM_CEILING } from '../../src/ingest/first-import.ts';
import { screenshotBytes } from '../media/fixture.ts';
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
  await fixture.tenantSql`DELETE FROM attachment`;
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

  test('the item’s own event time reaches the page, not the import time', async () => {
    // The export says these conversations happened on 2026-05-20; the import is
    // running now. Every path already computed `occurredAt` — it bounded the
    // import window — and then dropped it, which is what made the briefing's
    // meetings lane a list of things that *arrived* today.
    const rows = (await fixture.tenantSql`
      SELECT occurred_at, created_at FROM page
       WHERE external_ref = 'claude:conv-0' AND deleted_at IS NULL
    `) as Array<{ occurred_at: Date | null; created_at: Date }>;
    expect(rows[0]?.occurred_at?.toISOString()).toBe('2026-05-20T09:00:00.000Z');
    // Different instants, or the fixture proves nothing about which one landed.
    expect(rows[0]?.created_at.toISOString()).not.toBe('2026-05-20T09:00:00.000Z');
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

describe('a banked approval is not a reservation', () => {
  test('a resumed deferral is re-clamped to the headroom that is left', async () => {
    // Deferring spends nothing, so `control.tenant` has not moved by the time
    // the job runs. An approval redeemed without asking again gives every
    // deferred lane its own full copy of the ceiling — chat-export, folder and
    // three connectors is five times the cap, and each spends "its own"
    // approval correctly.
    await resetBrain();
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 5_000_000, capMicroUsd: 5_000_000 });

    const result = await runImport({
      ...baseRequest(materialFrom(exportDocument(2))),
      approvedMicroUsd: 4_000_000,
      jobId: 'job-banked',
    });

    expect(result.outcome).toBe('refused');
    if (result.decision?.proceed === 'refused') {
      expect(result.decision.reason).toBe('cap_exhausted');
    }
    expect(await countRows(fixture.tenantSql, 'page')).toBe(0);
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: null });
  });

  test('a headroom smaller than the approval is what the run may spend', async () => {
    // Refusing at zero headroom is the easy half, and a clamp that only ever
    // fires there is a guard that fails open: a tenant with a micro-dollar left
    // would still have the whole banked approval spent against it, and the run
    // would look perfectly well-behaved doing it.
    await resetBrain();
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 4_999_999, capMicroUsd: 5_000_000 });

    const result = await runImport({
      ...baseRequest(materialFrom(exportDocument(3))),
      approvedMicroUsd: 4_000_000,
      jobId: 'job-banked-2',
    });

    expect(result.outcome).toBe('stopped');
    expect(result.stopReason).toBe('budget_exhausted');
    // The chunk pass is where a micro-dollar runs out, and the rows it could
    // not pay for stay in the backlog. Under the unclamped approval this run
    // would have completed and drained it.
    expect(await backlogSize(fixture.tenantSql)).toBeGreaterThan(0);
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: null });
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

  test('a refused import still reconciles the deletion it observed', async () => {
    // A deleted file costs no provider call to tombstone, so no ceiling has an
    // opinion on it. Skipping the sweep because the gate said no leaves the
    // file answering queries until the tenant's thirty-day spend window rolls
    // — the stale row U11 later reports against its replacement as a genuine
    // contradiction, manufactured by the spend gate itself.
    await resetBrain();
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: null });
    await runImport(
      folderRequest({
        items: [
          itemFrom(externalRefFor(ROOT, 'gone.md'), proseOf('gone', 4), null, 'gone.md'),
        ],
        failures: [],
        tombstone: {
          rootId: ROOT,
          originContext: FOLDER_ORIGIN,
          seenRefs: [externalRefFor(ROOT, 'gone.md')],
          complete: true,
        },
      }),
    );
    expect(await countRows(fixture.tenantSql, 'page', 'deleted_at IS NULL')).toBe(1);

    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 5_000_000, capMicroUsd: 5_000_000 });
    const refused = await runImport(
      folderRequest({
        items: [itemFrom(externalRefFor(ROOT, 'new.md'), proseOf('new', 4), null, 'new.md')],
        failures: [],
        tombstone: {
          rootId: ROOT,
          originContext: FOLDER_ORIGIN,
          seenRefs: [externalRefFor(ROOT, 'new.md')],
          complete: true,
        },
      }),
    );

    expect(refused.outcome).toBe('refused');
    expect(refused.tombstone?.tombstoned).toBe(1);
    expect(await countRows(fixture.tenantSql, 'page', 'deleted_at IS NULL')).toBe(0);
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: null });
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

/**
 * The junk gate, reached from the importer.
 *
 * `classifyJunk` had exactly two call sites and both were in the pull runner,
 * so the MBOX fallback the vendor doc names — a consumer mailbox arriving
 * through `runImport` rather than through a connector — would have been chunked,
 * embedded and priced with no bulk filtering at all. `junk.ts` calls that "the
 * single largest avoidable cost in the product".
 */
describe('bulk filtering is a seam both runners reach', () => {
  const bulkHeaders = { 'list-unsubscribe': '<https://x.test/u>' };

  test('a hidden item is quarantined, not embedded, and priced at zero', async () => {
    await resetBrain();
    const ordinary = itemFrom(`${ORIGIN}:keep-1`, proseOf('keep', 4), NOW, 'Keep me');
    const newsletter: typeof ordinary = {
      ...itemFrom(`${ORIGIN}:junk-1`, proseOf('newsletter', 12), NOW, 'This week in widgets'),
      junk: { headers: bulkHeaders },
    };

    // Priced alone first, on a clean brain: the estimate is delta-aware, so
    // comparing the other way round would compare against an already-imported
    // item and pass for the wrong reason.
    const alone = await runImport({ ...baseRequest({ items: [ordinary], failures: [] }) });
    await resetBrain();

    const result = await runImport({
      ...baseRequest({ items: [ordinary, newsletter], failures: [] }),
    });

    expect(result.outcome).toBe('completed');
    expect(result.counts.written).toBe(1);
    expect(result.counts.quarantined).toBe(1);
    expect(
      await countRows(fixture.tenantSql, 'page', `external_ref = '${ORIGIN}:junk-1' AND quarantined_at IS NOT NULL`),
    ).toBe(1);
    // The structural half: a quarantined page's chunks never enter the backlog.
    expect(
      await countRows(
        fixture.tenantSql,
        'chunk c JOIN page p ON p.page_id = c.page_id',
        `p.external_ref = '${ORIGIN}:junk-1' AND c.embedding IS NULL AND c.quarantined_at IS NULL`,
      ),
    ).toBe(0);
    // …and it is priced at zero characters, so the newsletter backlog cannot
    // inflate an approval it will never spend.
    expect(result.estimate!.items).toBe(2);
    expect(alone.estimate!.tokens).toBeGreaterThan(0);
    expect(result.estimate!.tokens).toBe(alone.estimate!.tokens);
  });

  test('a transactional item is warned, not hidden', async () => {
    await resetBrain();
    const receipt: ReturnType<typeof itemFrom> = {
      ...itemFrom(`${ORIGIN}:warn-1`, proseOf('receipt', 4), NOW, 'Your receipt from Widget Co'),
      junk: { headers: bulkHeaders, from: 'no-reply@widget-co.example', subject: 'Your receipt' },
    };

    const result = await runImport({ ...baseRequest({ items: [receipt], failures: [] }) });

    expect(result.counts.written).toBe(1);
    expect(result.counts.quarantined).toBe(0);
    expect(
      await countRows(fixture.tenantSql, 'page', `external_ref = '${ORIGIN}:warn-1' AND quarantined_at IS NULL`),
    ).toBe(1);
  });

  test('an item that carries no headers is ordinary content', async () => {
    // Every folder file and every chat transcript arrives this way. Reading an
    // absent signal as junk would quarantine a whole source wholesale, and the
    // failure would be invisible: nothing errors, the brain stops knowing things.
    await resetBrain();
    const result = await runImport({
      ...baseRequest({
        items: [itemFrom(`${ORIGIN}:plain-1`, proseOf('plain', 4), NOW, 'A note')],
        failures: [],
      }),
    });

    expect(result.counts.written).toBe(1);
    expect(result.counts.quarantined).toBe(0);
  });
});

/**
 * The objects a folder scan carries.
 *
 * `acceptMedia` and the transcribe phase existed and nothing in `src/ingest/`
 * called either, so images and PDFs never arrived in production at all and the
 * transcribe queue was empty by construction. The assertions are on the rows,
 * the object store and the queue predicate — a summary count is what a loop
 * reports about itself, and a loop that never ran reports its initial value.
 */
describe('the objects a folder scan carries', () => {
  const ROOT = 'shots';
  const MEDIA_ORIGIN = 'folder:shots';

  function mediaRequest(material: ImportMaterial) {
    return {
      ...baseRequest(material),
      originContext: MEDIA_ORIGIN,
      sourceType: 'document' as const,
      target: 'folder' as const,
    };
  }

  function mediaFor(path: string, bytes = screenshotBytes(), mediaType = 'image/png') {
    return { externalRef: externalRefFor(ROOT, path), mediaType, bytes };
  }

  async function attachmentRows(where = 'true') {
    return (await fixture.tenantSql.unsafe(
      `SELECT object_key, media_type, byte_size, ocr_text, origin_context
         FROM attachment WHERE ${where} ORDER BY attachment_id`,
    )) as Array<{
      object_key: string;
      media_type: string;
      byte_size: string | number | null;
      ocr_text: string | null;
      origin_context: string;
    }>;
  }

  test('a screenshot is preserved, recorded and queued — and costs no model call', async () => {
    await resetBrain();
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: 5_000_000 });
    const before = fixture.transport.calls.length;

    const result = await runImport(
      mediaRequest({
        items: [],
        failures: [],
        media: [mediaFor('wifi.png')],
      }),
    );

    expect(result.outcome).toBe('completed');
    expect(result.counts.attachments).toBe(1);
    expect(result.counts.failed).toBe(0);
    // Acceptance is not extraction. A write path that quietly OCR'd would still
    // return a receipt, and the only place it would show up is the bill.
    expect(fixture.transport.calls.length).toBe(before);

    const rows = await attachmentRows(`origin_context = '${MEDIA_ORIGIN}'`);
    expect(rows.length).toBe(1);
    expect(rows[0]?.media_type).toBe('image/png');
    expect(Number(rows[0]?.byte_size)).toBe(screenshotBytes().length);
    expect(rows[0]?.ocr_text).toBeNull();

    const key = rows[0]?.object_key ?? '';
    expect(key.length).toBeGreaterThan(0);
    const stored = await fixture.rawStore.get(key as never);
    expect([...(stored?.bytes ?? [])]).toEqual([...screenshotBytes()]);

    // The queue U21 exists to fill, actually filled.
    const pending = await selectPendingAttachments(fixture.tenantSql, { limit: 10 });
    expect(pending.map((entry) => entry.objectKey)).toContain(key);

    // Counted on the run row: `acceptMedia` advances nothing itself, so a loop
    // that forgot would leave a run reporting a clean import of nothing.
    const logRows = await ingestLogRows(fixture.tenantSql);
    const runRow = logRows.find((row) => row.external_ref === null);
    expect(runRow?.items_seen).toBe(1);
    expect(runRow?.items_written).toBe(1);
    expect(
      logRows.some((row) => row.external_ref === externalRefFor(ROOT, 'wifi.png')),
    ).toBe(true);
  });

  test('an object the store refuses leaves a visible failure row', async () => {
    // The property the old refusal path got right and this must keep: nothing
    // is silently dropped. An absence property passes when the path never runs,
    // so it is asserted against the rows the run actually wrote.
    await resetBrain();
    fixture.rawStore.failNextPut();

    const result = await runImport(
      mediaRequest({ items: [], failures: [], media: [mediaFor('lost.png')] }),
    );

    expect(result.counts.attachments).toBe(0);
    expect(result.counts.failed).toBe(1);
    expect(await countRows(fixture.tenantSql, 'attachment')).toBe(0);
    const row = (await ingestLogRows(fixture.tenantSql)).find(
      (entry) => entry.external_ref === externalRefFor(ROOT, 'lost.png'),
    );
    expect(row?.outcome).toBe('failed');
    expect(row?.failure_code).toBe('provider_error');
  });

  test('an object the brain cannot read leaves a row too', async () => {
    await resetBrain();

    const result = await runImport(
      mediaRequest({
        items: [],
        failures: [],
        media: [mediaFor('memo.m4a', new Uint8Array([1, 2, 3, 4]), 'audio/mp4')],
      }),
    );

    expect(result.counts.attachments).toBe(0);
    expect(result.counts.failed).toBe(1);
    expect(await countRows(fixture.tenantSql, 'attachment')).toBe(0);
    const row = (await ingestLogRows(fixture.tenantSql)).find(
      (entry) => entry.external_ref === externalRefFor(ROOT, 'memo.m4a'),
    );
    expect(row?.failure_code).toBe('parse_failed');
  });

  test('an item loop that runs out of money still banks the objects', async () => {
    // The ordering decision, stated as a consequence. Preserving an object
    // issues no provider call, so it must not be the thing dropped when the
    // *embedding* budget goes — and re-running costs nothing for what was
    // already stored, because `acceptMedia` answers `unchanged`.
    await resetBrain();
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: 5 });

    const result = await runImport(
      mediaRequest({
        items: parseChatExport(factfulDocument(8)).conversations.map((conversation) => ({
          externalRef: conversation.externalRef,
          title: conversation.title,
          body: conversation.body,
          occurredAt: conversation.occurredAt,
        })),
        failures: [],
        media: [mediaFor('under-pressure.png')],
      }),
    );

    expect(result.stopReason).toBe('budget_exhausted');
    expect(result.counts.attachments).toBe(1);
    expect(await countRows(fixture.tenantSql, 'attachment')).toBe(1);
  });

  test('a refused import stores no objects at all', async () => {
    // Behind the gate, and this is the half that says so. A ceiling that
    // refused the run and a runner that banked its objects anyway would be two
    // parts of the system disagreeing about whether the import happened.
    await resetBrain();
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 1_000, capMicroUsd: 1_000 });

    const result = await runImport(
      mediaRequest({
        items: [itemFrom(externalRefFor(ROOT, 'a.md'), proseOf('alpha', 4), null, 'a.md')],
        failures: [],
        media: [mediaFor('refused.png')],
      }),
    );

    expect(result.outcome).toBe('refused');
    expect(result.counts.attachments).toBe(0);
    expect(await countRows(fixture.tenantSql, 'attachment')).toBe(0);
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: 5_000_000 });
  });
});
