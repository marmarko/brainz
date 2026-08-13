/**
 * The first-import gate (R8a, R14).
 *
 * The gate is one number and four ways of getting it wrong, and each of the
 * four is a guard that fails **open** unless it is built the other way round:
 *
 *  1. The estimate is computed over a different set than the import walks.
 *  2. An item already held is priced as if it were new — or, worse, a *changed*
 *     item is priced as if it were unchanged, which is the direction that
 *     under-counts.
 *  3. The tenant's ceiling is read as unlimited because the column was NULL, or
 *     because there was no row at all.
 *  4. A model the canonical table cannot price is estimated at zero.
 *
 * Each has a test whose failure mode is "the gate approved an import it should
 * have bounded", not "a number came back different".
 *
 * The wrong-refusal direction gets one too: U20's meter rolls the spend window
 * only when it *writes*, so a tenant whose last call was five weeks ago still
 * carries last month's total, and a gate reading it bare would refuse them
 * forever.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { HOSTED_PROFILE, type NamedProfile } from '../../src/ai/routing.ts';
import { backlogSize } from '../../src/core/write/embed.ts';
import { ingestDocument } from '../../src/core/write/write-path.ts';
import {
  DEFAULT_INLINE_ITEM_CEILING,
  DEFAULT_TENANT_SPEND_CEILING,
  DEFAULT_WINDOW_DAYS,
  ESTIMATE_MARGIN_PERCENT,
  estimateImport,
  gateFirstImport,
  readHeadroom,
  selectWindow,
  type ImportCandidate,
} from '../../src/ingest/first-import.ts';
import {
  CALLER,
  ORIGIN,
  TENANT,
  candidateFrom,
  createIngestFixture,
  proseOf,
  setSpend,
  uncappedBudget,
  type IngestFixture,
} from './fixture.ts';

let fixture: IngestFixture;

const NOW = new Date('2026-06-01T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

/** A profile whose embedding route the canonical table cannot price: an
 * operator serving vectors from their own endpoint. `routing.ts` admits it
 * precisely because price is a property of who serves the weights. */
function unpricedEmbeddingProfile(): NamedProfile {
  return {
    name: 'operator',
    routes: {
      ...HOSTED_PROFILE.routes,
      embedding: {
        op: 'embedding',
        alias: 'self-host/embed',
        id: 'self-host/embed-1',
        provider: 'self-host',
        pinnedOn: '2026-08-12',
        maxOutputTokens: 0,
      },
    },
  };
}

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

beforeAll(async () => {
  fixture = await createIngestFixture('u8gate');
});

afterAll(async () => {
  await fixture.close();
});

describe('the window is bounded, and what it left out is visible', () => {
  const candidates: readonly ImportCandidate[] = [
    candidateFrom('recent', 'a', daysAgo(1)),
    candidateFrom('edge-inside', 'b', daysAgo(DEFAULT_WINDOW_DAYS - 1)),
    candidateFrom('old', 'c', daysAgo(DEFAULT_WINDOW_DAYS + 1)),
    candidateFrom('ancient', 'd', daysAgo(900)),
    candidateFrom('undated', 'e', null),
  ];

  test('the default is the last 90 days', () => {
    const selection = selectWindow(candidates, { now: NOW });
    expect(selection.windowDays).toBe(DEFAULT_WINDOW_DAYS);
    expect(selection.selected.map((item) => item.externalRef).sort()).toEqual([
      'edge-inside',
      'recent',
      'undated',
    ]);
    expect(selection.excluded.map((item) => item.externalRef).sort()).toEqual(['ancient', 'old']);
  });

  test('an item with no timestamp is inside every window', () => {
    const selection = selectWindow(candidates, { now: NOW, window: { days: 1 } });
    expect(selection.undated).toBe(1);
    expect(selection.selected.map((item) => item.externalRef)).toContain('undated');
  });

  test("widening re-selects, which is what makes the path a path", () => {
    const widened = selectWindow(candidates, { now: NOW, window: 'all' });
    expect(widened.windowDays).toBeNull();
    expect(widened.selected).toHaveLength(candidates.length);
    expect(widened.excluded).toEqual([]);
  });
});

describe('the estimate is delta-aware', () => {
  const body = proseOf('runway', 6);

  test('an item already held at the same digest costs nothing', async () => {
    const written = await ingestDocument(
      {
        sql: fixture.tenantSql,
        gateway: fixture.gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget(),
      },
      {
        originContext: ORIGIN,
        sourceType: 'chat',
        title: null,
        body,
        externalRef: 'held-unchanged',
      },
    );
    expect(written.ok).toBe(true);

    const outcome = await estimateImport({
      sql: fixture.tenantSql,
      profile: HOSTED_PROFILE,
      candidates: [candidateFrom('held-unchanged', body, NOW)],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.estimate.unchangedItems).toBe(1);
    expect(outcome.estimate.newItems).toBe(0);
    expect(outcome.estimate.changedItems).toBe(0);
    expect(outcome.estimate.tokens).toBe(0);
    expect(outcome.estimate.microUsd).toBe(0);
  });

  test('the same item at a different digest is priced in full, not skipped', async () => {
    const edited = `${body}\n\nAnd then the schedule moved again.`;
    const outcome = await estimateImport({
      sql: fixture.tenantSql,
      profile: HOSTED_PROFILE,
      candidates: [candidateFrom('held-unchanged', edited, NOW)],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The under-counting direction: a changed item re-chunks and re-embeds.
    expect(outcome.estimate.changedItems).toBe(1);
    expect(outcome.estimate.unchangedItems).toBe(0);
    expect(outcome.estimate.tokens).toBeGreaterThan(0);
    expect(outcome.estimate.microUsd).toBeGreaterThan(0);
  });

  test('a resumed import prices the passages a stopped run already banked', async () => {
    // U4 defers the chunk pass, so a run that stopped on its ceiling leaves its
    // pages written and their passages unembedded. Every one of those items is
    // `unchanged` on the next attempt — so an estimate that only prices items
    // returns zero, the gate approves zero, and the resumed run cannot finish
    // the work the first one paid to start. It deadlocks at exactly the moment
    // the user retries.
    const pending = await backlogSize(fixture.tenantSql);
    expect(pending).toBeGreaterThan(0);

    const outcome = await estimateImport({
      sql: fixture.tenantSql,
      profile: HOSTED_PROFILE,
      candidates: [candidateFrom('held-unchanged', body, NOW)],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.estimate.microUsd).toBe(0);
    expect(outcome.estimate.backlogChunks).toBe(pending);
    expect(outcome.estimate.backlogMicroUsd).toBeGreaterThan(0);
    expect(outcome.estimate.requestedMicroUsd).toBeGreaterThan(0);
  });

  test('an item nothing is held for is new', async () => {
    const outcome = await estimateImport({
      sql: fixture.tenantSql,
      profile: HOSTED_PROFILE,
      candidates: [candidateFrom('never-seen', body, NOW)],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.estimate.newItems).toBe(1);
    expect(outcome.estimate.items).toBe(1);
  });

  test('the model comes from the profile, never from a literal at this call site', async () => {
    const outcome = await estimateImport({
      sql: fixture.tenantSql,
      profile: HOSTED_PROFILE,
      candidates: [candidateFrom('never-seen', body, NOW)],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.estimate.modelId).toBe(HOSTED_PROFILE.routes.embedding.id);
  });

  test('R14: an unpriced embedding model yields no estimate at all', async () => {
    const outcome = await estimateImport({
      sql: fixture.tenantSql,
      profile: unpricedEmbeddingProfile(),
      candidates: [candidateFrom('never-seen', body, NOW)],
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('model_not_priced');
    expect(outcome.modelId).toBe('self-host/embed-1');
  });

  test("KTD8's anchor: a 50k-chunk first import is about $2.60", async () => {
    // 50,000 chunks at ~400 tokens each is 20M tokens, and 20M tokens through
    // the canonical embedding price is $2.60. Asserted here rather than in
    // `src/` because the scan that keeps one pricing table forbids the number
    // there — and this is the number the whole gate exists for.
    const outcome = await estimateImport({
      sql: fixture.tenantSql,
      profile: HOSTED_PROFILE,
      candidates: [
        {
          externalRef: 'the-whole-export',
          contentSha256: 'f'.repeat(64),
          occurredAt: NOW,
          characters: 80_000_000,
        },
      ],
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.estimate.tokens).toBe(20_000_000);
    expect(outcome.estimate.microUsd).toBe(2_600_000);
    expect(outcome.estimate.requestedMicroUsd).toBe(
      Math.ceil(
        ((2_600_000 + outcome.estimate.backlogMicroUsd) * (100 + ESTIMATE_MARGIN_PERCENT)) / 100,
      ),
    );
  });
});

describe('the ceiling is read from the control-plane row, and unknowns read closed', () => {
  test('no row is a refusal, not an unbounded budget', async () => {
    const outcome = await readHeadroom(fixture.controlSql, { tenantId: 'ghost', now: NOW });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('tenant_unknown');
  });

  test('a NULL cap is the platform default, which is not "no cap"', async () => {
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: null });
    const outcome = await readHeadroom(fixture.controlSql, { tenantId: TENANT, now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.headroom.capIsPlatformDefault).toBe(true);
    expect(outcome.headroom.capMicroUsd).toBe(DEFAULT_TENANT_SPEND_CEILING);
    expect(Number.isFinite(outcome.headroom.headroomMicroUsd)).toBe(true);
  });

  test('an explicit cap wins, and spend inside the window counts against it', async () => {
    await setSpend(fixture.controlSql, TENANT, {
      spentMicroUsd: 400_000,
      capMicroUsd: 1_000_000,
      windowStartedAt: new Date(NOW.getTime() - 2 * DAY_MS),
    });
    const outcome = await readHeadroom(fixture.controlSql, { tenantId: TENANT, now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.headroom.capMicroUsd).toBe(1_000_000);
    expect(outcome.headroom.spentMicroUsd).toBe(400_000);
    expect(outcome.headroom.headroomMicroUsd).toBe(600_000);
    expect(outcome.headroom.windowLapsed).toBe(false);
  });

  test('a lapsed window reads as zero spend — the meter only rolls when it writes', async () => {
    await setSpend(fixture.controlSql, TENANT, {
      spentMicroUsd: 900_000,
      capMicroUsd: 1_000_000,
      windowStartedAt: new Date(NOW.getTime() - 40 * DAY_MS),
    });
    const outcome = await readHeadroom(fixture.controlSql, { tenantId: TENANT, now: NOW });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.headroom.windowLapsed).toBe(true);
    expect(outcome.headroom.spentMicroUsd).toBe(0);
    expect(outcome.headroom.headroomMicroUsd).toBe(1_000_000);
  });
});

describe('the decision', () => {
  const smallEstimate = {
    items: 3,
    newItems: 3,
    changedItems: 0,
    unchangedItems: 0,
    chunks: 3,
    tokens: 1_000,
    backlogChunks: 0,
    modelId: HOSTED_PROFILE.routes.embedding.id,
    microUsd: 130,
    backlogMicroUsd: 0,
    requestedMicroUsd: 163,
  };

  test('inside the ceiling and inside the headroom, it runs inline', async () => {
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: 1_000_000 });
    const decision = await gateFirstImport({
      control: fixture.controlSql,
      tenantId: TENANT,
      target: 'chat_export',
      estimate: smallEstimate,
      now: NOW,
      queue: fixture.queue,
    });
    expect(decision.proceed).toBe('inline');
    if (decision.proceed !== 'inline') return;
    expect(decision.approvedMicroUsd).toBe(smallEstimate.requestedMicroUsd);
    expect(decision.clamped).toBe(false);
  });

  test('more than the headroom is clamped to the headroom, not waved through', async () => {
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 999_900, capMicroUsd: 1_000_000 });
    const decision = await gateFirstImport({
      control: fixture.controlSql,
      tenantId: TENANT,
      target: 'chat_export',
      estimate: smallEstimate,
      now: NOW,
      queue: fixture.queue,
    });
    expect(decision.proceed).toBe('inline');
    if (decision.proceed !== 'inline') return;
    expect(decision.approvedMicroUsd).toBe(100);
    expect(decision.clamped).toBe(true);
  });

  test('no headroom at all is a refusal', async () => {
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 1_000_000, capMicroUsd: 1_000_000 });
    const decision = await gateFirstImport({
      control: fixture.controlSql,
      tenantId: TENANT,
      target: 'chat_export',
      estimate: smallEstimate,
      now: NOW,
      queue: fixture.queue,
    });
    expect(decision.proceed).toBe('refused');
    if (decision.proceed !== 'refused') return;
    expect(decision.reason).toBe('cap_exhausted');
  });

  test('an unknown tenant is refused before any headroom is invented', async () => {
    const decision = await gateFirstImport({
      control: fixture.controlSql,
      tenantId: 'ghost',
      target: 'chat_export',
      estimate: smallEstimate,
      now: NOW,
      queue: fixture.queue,
    });
    expect(decision.proceed).toBe('refused');
    if (decision.proceed !== 'refused') return;
    expect(decision.reason).toBe('tenant_unknown');
    expect(decision.headroom).toBeNull();
  });

  test('a large import auto-defers to a capped background job', async () => {
    await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: 5_000_000 });
    await fixture.controlSql`DELETE FROM control.job WHERE tenant_id = ${TENANT}`;

    const big = { ...smallEstimate, items: DEFAULT_INLINE_ITEM_CEILING + 1 };
    const decision = await gateFirstImport({
      control: fixture.controlSql,
      tenantId: TENANT,
      target: 'chat_export',
      estimate: big,
      now: NOW,
      queue: fixture.queue,
    });
    expect(decision.proceed).toBe('deferred');
    if (decision.proceed !== 'deferred') return;

    const job = await fixture.queue.get(decision.jobId);
    expect(job).toBeDefined();
    expect(job!.kind).toBe('import');
    expect(job!.target).toBe('chat_export');
    expect(job!.tenantId).toBe(TENANT);
    // The cap travels with the deferral: a background import that re-derived
    // its own ceiling would be an ungated import wearing a job id.
    expect(decision.approvedMicroUsd).toBe(big.requestedMicroUsd);
  });

  test('a second deferral for the same target is refused, not duplicated', async () => {
    const big = { ...smallEstimate, items: DEFAULT_INLINE_ITEM_CEILING + 1 };
    const decision = await gateFirstImport({
      control: fixture.controlSql,
      tenantId: TENANT,
      target: 'chat_export',
      estimate: big,
      now: NOW,
      queue: fixture.queue,
    });
    expect(decision.proceed).toBe('refused');
    if (decision.proceed !== 'refused') return;
    expect(decision.reason).toBe('already_open');
  });

  test('a deferral with nowhere to defer to is a refusal, never an inline run', async () => {
    await fixture.controlSql`DELETE FROM control.job WHERE tenant_id = ${TENANT}`;
    const big = { ...smallEstimate, items: DEFAULT_INLINE_ITEM_CEILING + 1 };
    const decision = await gateFirstImport({
      control: fixture.controlSql,
      tenantId: TENANT,
      target: 'chat_export',
      estimate: big,
      now: NOW,
    });
    expect(decision.proceed).toBe('refused');
    if (decision.proceed !== 'refused') return;
    expect(decision.reason).toBe('no_queue');
  });

  test('a tenant that is not ready has nothing imported into it', async () => {
    await fixture.controlSql`
      UPDATE control.tenant SET state = 'provisioning', ready_at = NULL WHERE tenant_id = ${TENANT}
    `;
    const decision = await gateFirstImport({
      control: fixture.controlSql,
      tenantId: TENANT,
      target: 'chat_export',
      estimate: smallEstimate,
      now: NOW,
      queue: fixture.queue,
    });
    expect(decision.proceed).toBe('refused');
    if (decision.proceed !== 'refused') return;
    expect(decision.reason).toBe('tenant_not_ready');

    await fixture.controlSql`
      UPDATE control.tenant SET state = 'ready', ready_at = now() WHERE tenant_id = ${TENANT}
    `;
  });
});
