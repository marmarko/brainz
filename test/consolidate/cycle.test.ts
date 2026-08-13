/**
 * The cycle as a whole: what it costs before it starts, where it stops, and what
 * the next one does not pay for again.
 *
 * "Consolidated but not dreamt" is the phrase U11 uses, and it has to be a
 * *state a reader can find*, not a mood. Three ways to reach it are exercised
 * here — the free tier, an exhausted cap, and a phase whose provider was
 * unavailable — because each leaves a different reason on the run record and a
 * different amount of work banked.
 *
 * The resume half is the one that would rot quietly. A cycle that re-ran a
 * completed model phase would still be correct, still be green, and would
 * simply cost twice — which is invisible in a test that only checks outputs. So
 * the assertion is on the **call count at the transport**, before and after.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runConsolidationCycle } from '../../src/worker/consolidate/cycle.ts';
import { MODEL_PHASES } from '../../src/worker/consolidate/phases.ts';
import {
  CALLER,
  TENANT,
  countRows,
  createGateway,
  createTenantFixture,
  seedFact,
  seedPage,
  type TenantFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;

let tenant: TenantFixture;

beforeEach(async () => {
  tenant = await createTenantFixture('cycle');
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  await tenant?.close();
}, SETUP_TIMEOUT_MS);

/** Enough of a brain that every phase has something to do. */
async function seedSmallBrain(): Promise<void> {
  const { sql } = tenant;
  const page = await seedPage(sql, {
    origin: 'personal:mail',
    sourceType: 'email',
    title: 'Verdant thread',
    body: 'Ronan Whitfield joined Verdant Systems. Verdant Systems is based in Trieste.',
  });
  await seedFact(sql, {
    statement: 'Ronan Whitfield joined Verdant Systems.',
    origins: ['personal:mail'],
    pageId: page.pageId,
    chunkIds: page.chunkIds,
    confidence: 0.8,
  });
  // The same claim a second time, from the same credential: the residue the
  // write path's own docstring says a concurrent writer leaves behind.
  await seedFact(sql, {
    statement: 'Ronan Whitfield joined Verdant Systems.',
    origins: ['personal:mail'],
    pageId: page.pageId,
    chunkIds: page.chunkIds,
    confidence: 0.8,
  });
}

const FULL_SCRIPT = {
  extract: () => JSON.stringify({ facts: [] }),
  enrich: () => JSON.stringify({ cards: [] }),
  synopsis: () => JSON.stringify({ summary: 'Verdant Systems, a roastery holding company.' }),
  contradiction: () => JSON.stringify({ conflicts: [] }),
  salience: () => JSON.stringify({ scores: [] }),
};

describe('the free tier is a stopping point, not a failure', () => {
  test(
    'a free-tier cycle finishes the deterministic phases and makes no model call at all',
    async () => {
      await seedSmallBrain();
      const { gateway, transport } = createGateway({ chat: FULL_SCRIPT });

      const result = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'free', now: new Date() },
      );

      expect(result.dreamt).toBe(false);
      expect(result.stopReason).toBe('free_tier');
      expect(transport.calls.length).toBe(0);
      expect(result.spentMicroUsd).toBe(0);

      const ran = result.phases.filter((phase) => phase.ran).map((phase) => phase.phase);
      for (const phase of MODEL_PHASES) expect(ran).not.toContain(phase);
      expect(ran.length).toBeGreaterThan(0);

      const rows = (await tenant.sql`
        SELECT dreamt, stop_reason, tier FROM consolidation_run ORDER BY run_id DESC LIMIT 1
      `) as Array<{ dreamt: boolean; stop_reason: string; tier: string }>;
      expect(rows[0]).toEqual({ dreamt: false, stop_reason: 'free_tier', tier: 'free' });
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'a paid cycle under a zero cap reaches the same state by a different road',
    async () => {
      await seedSmallBrain();
      const { gateway, transport } = createGateway({ chat: FULL_SCRIPT });

      const result = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', capMicroUsd: 0, now: new Date() },
      );

      expect(result.dreamt).toBe(false);
      expect(result.stopReason).toBe('budget_exhausted');
      // The cap is refused *before* the provider, so nothing was billed.
      expect(transport.calls.length).toBe(0);
      expect(result.phases.filter((phase) => phase.ran).length).toBeGreaterThan(0);
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('a full cycle', () => {
  test(
    'dreams, records what it spent, and reports a wall-clock',
    async () => {
      await seedSmallBrain();
      const { gateway, transport } = createGateway({ chat: FULL_SCRIPT });

      const result = await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now: new Date() },
      );

      expect(result.stopReason).toBe('complete');
      expect(result.dreamt).toBe(true);
      expect(transport.calls.length).toBeGreaterThan(0);
      expect(result.wallClockMs).toBeGreaterThanOrEqual(0);
      expect(result.spentMicroUsd).toBeGreaterThan(0);

      // The estimate is taken before the work, and banked on the run record —
      // "estimate before running" is only a discipline if the number survives.
      const rows = (await tenant.sql`
        SELECT estimated_micro_usd, spent_micro_usd, dreamt
          FROM consolidation_run ORDER BY run_id DESC LIMIT 1
      `) as Array<{ estimated_micro_usd: string; spent_micro_usd: string; dreamt: boolean }>;
      expect(Number(rows[0]?.estimated_micro_usd ?? 0)).toBeGreaterThan(0);
      expect(Number(rows[0]?.spent_micro_usd ?? -1)).toBe(result.spentMicroUsd);
      expect(rows[0]?.dreamt).toBe(true);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'every model phase spends through its own budget, at its own op',
    async () => {
      await seedSmallBrain();
      const { gateway, transport, meter } = createGateway({ chat: FULL_SCRIPT });

      await runConsolidationCycle(
        { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now: new Date() },
      );

      const labels = new Set(meter.records().map((record) => record.budgetLabel));
      const ops = new Set(meter.records().map((record) => record.op));
      // One label per phase that ran, and each names its phase.
      expect(labels.size).toBeGreaterThan(1);
      for (const label of labels) expect(label.startsWith('consolidate.')).toBe(true);
      expect(ops.has('extract')).toBe(true);

      // Metering carries no content: the record type has no field for it, and
      // the transport saw the user's sentence.
      expect(transport.prompts.join('\n')).toContain('Ronan Whitfield');
      expect(JSON.stringify(meter.records())).not.toContain('Ronan Whitfield');
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('checkpoints — the next cycle does not re-pay', () => {
  test(
    'a cycle stopped by an unavailable provider resumes without re-calling what it finished',
    async () => {
      await seedSmallBrain();

      const failing = createGateway({
        chat: FULL_SCRIPT,
        failOn: 'enrich',
      });
      const first = await runConsolidationCycle(
        { sql: tenant.sql, gateway: failing.gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now: new Date() },
      );

      expect(first.dreamt).toBe(false);
      expect(first.stopReason).toBe('phase_failed');
      const extractCallsFirst = failing.transport.callsFor('extract').length;
      expect(extractCallsFirst).toBeGreaterThan(0);

      // The run is still open, so the checkpoint has something to resume into.
      expect(await countRows(tenant.sql, 'consolidation_run', 'finished_at IS NULL')).toBe(1);

      const healthy = createGateway({ chat: FULL_SCRIPT });
      const second = await runConsolidationCycle(
        { sql: tenant.sql, gateway: healthy.gateway, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now: new Date() },
      );

      expect(second.resumed).toBe(true);
      expect(second.runId).toBe(first.runId);
      expect(second.dreamt).toBe(true);
      expect(second.stopReason).toBe('complete');

      // The whole point: extraction was banked, so the second run never asked
      // for it again.
      expect(healthy.transport.callsFor('extract').length).toBe(0);
      const extractPhase = second.phases.find((phase) => phase.phase === 'extract');
      expect(extractPhase?.ran).toBe(false);
      expect(extractPhase?.skipped).toBe('checkpointed');

      // ...and enrich, which failed, did run this time.
      expect(healthy.transport.callsFor('enrich').length).toBeGreaterThan(0);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'a completed cycle leaves nothing to resume — the next one starts clean',
    async () => {
      await seedSmallBrain();
      const { gateway } = createGateway({ chat: FULL_SCRIPT });
      const deps = { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER };

      const first = await runConsolidationCycle(deps, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now: new Date(),
      });
      const second = await runConsolidationCycle(deps, {
        trigger: 'time_ceiling',
        tier: 'paid',
        now: new Date(),
      });

      expect(second.resumed).toBe(false);
      expect(second.runId).not.toBe(first.runId);
      expect(second.phases.every((phase) => phase.skipped === null)).toBe(true);
      expect(await countRows(tenant.sql, 'consolidation_run')).toBe(2);
    },
    SETUP_TIMEOUT_MS,
  );
});
