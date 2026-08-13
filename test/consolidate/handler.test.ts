/**
 * The seam between U10 and U11: a `consolidate` job, claimed by a real runner
 * off a real control-plane queue, running a real cycle against a real tenant.
 *
 * **This exists because "the cycle works" and "the cycle runs when the scheduler
 * says so" are different claims**, and the second is the one R3 makes —
 * ingestion and consolidation run without user operation once a source is
 * connected. U10 defined the `consolidate` job kind in Phase 1 and nothing has
 * ever handled it; a cycle with no handler is a scheduler enqueueing work that
 * dead-letters, which looks from the control plane exactly like a poison tenant.
 *
 * The runner, the lease, the fence and the completion settle are all the shipped
 * ones. What is faked is the one thing that has to be: `open` resolves the
 * tenant's world, which is a secret-store read (R11) that belongs to U6's
 * dispatch seam rather than to this module.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { createConsolidateHandler, type CycleResult } from '../../src/worker/consolidate/cycle.ts';
import { createJobRunner, systemTicker } from '../../src/worker/runner.ts';
import { createJobQueue, createLeaseChannel } from '../../src/worker/queue.ts';
import {
  connect as connectControl,
  createControlPlane,
  dropControlPlane,
  readJobRow,
  seedTenant,
  type ControlFixture,
} from '../worker/fixture.ts';
import { createGateway, createTenantFixture, seedPage, type TenantFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;
const NOW = new Date('2026-08-13T09:00:00Z');

let control: ControlFixture;
let workSql: SQL;
let leaseSql: SQL;
let tenant: TenantFixture;

beforeAll(async () => {
  control = await createControlPlane('consolidatehandler');
  workSql = connectControl(control, 4);
  leaseSql = connectControl(control, 1);
  tenant = await createTenantFixture('handler');
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await workSql?.close();
  await leaseSql?.close();
  await tenant?.close();
  if (control !== undefined) await dropControlPlane(control);
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  await workSql`DELETE FROM control.job`;
  await workSql`DELETE FROM control.tenant`;
});

describe('a consolidate job runs a cycle', () => {
  test(
    'the runner claims it, the cycle runs, and the job completes under its own lease',
    async () => {
      await seedTenant(workSql, 'alpha', { pendingDebt: 7 });
      await seedPage(tenant.sql, {
        origin: 'personal:mail',
        sourceType: 'email',
        title: 'thread',
        body: 'Ronan Whitfield joined Verdant Systems.',
      });

      const queue = createJobQueue({ sql: workSql });
      const { gateway, transport } = createGateway({
        chat: {
          extract: () => JSON.stringify({ facts: [] }),
          enrich: () => JSON.stringify({ cards: [] }),
          synopsis: () => JSON.stringify({ summary: 'A note about Verdant Systems.' }),
          contradiction: () => JSON.stringify({ conflicts: [] }),
          salience: () => JSON.stringify({ scores: [] }),
        },
      });

      const seen: CycleResult[] = [];
      let closed = 0;
      const handler = createConsolidateHandler({
        open: () =>
          Promise.resolve({
            sql: tenant.sql,
            gateway,
            tier: 'paid' as const,
            capMicroUsd: null,
            close: () => {
              closed += 1;
              return Promise.resolve();
            },
          }),
        onCycle: (_tenantId, result) => seen.push(result),
      });

      const enqueued = await queue.enqueue({
        tenantId: 'alpha',
        kind: 'consolidate',
        target: 'whole_brain',
        trigger: 'debt_debounce',
        now: NOW,
        debtObserved: 7,
      });
      expect(enqueued.enqueued).toBe(true);

      const runner = createJobRunner({
        queue,
        leases: createLeaseChannel({ sql: leaseSql }),
        handlers: { consolidate: handler },
        owner: 'consolidation-worker',
        concurrency: 1,
        ticker: systemTicker(),
      });

      const pass = await runner.runOnce({ now: NOW });
      expect(pass.claimed).toBe(1);
      expect(pass.outcomes.completed).toBe(1);
      expect(pass.storeErrors).toEqual([]);

      // The cycle really ran, through the gateway, and reported itself.
      expect(seen.length).toBe(1);
      expect(seen[0]?.stopReason).toBe('complete');
      expect(seen[0]?.dreamt).toBe(true);
      expect(transport.calls.length).toBeGreaterThan(0);

      // The tenant's world was closed even on the happy path — a worker that
      // leaked a connection per job exhausts the per-tenant LRU KTD2 is built on.
      expect(closed).toBe(1);

      const job = await readJobRow(workSql, enqueued.enqueued ? enqueued.job.jobId : '');
      expect(job['state']).toBe('done');

      // Completion settled the tenant's scheduling signals under the same fence:
      // the debt this job observed is subtracted rather than the counter zeroed.
      const rows = (await workSql`
        SELECT pending_debt, next_due_at FROM control.tenant WHERE tenant_id = 'alpha'
      `) as Array<{ pending_debt: number; next_due_at: Date | null }>;
      expect(rows[0]?.pending_debt).toBe(0);
      expect(rows[0]?.next_due_at).not.toBeNull();
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'a cycle that throws fails the job rather than completing it, and still closes the tenant',
    async () => {
      await seedTenant(workSql, 'beta', { pendingDebt: 3 });
      const queue = createJobQueue({ sql: workSql });

      let closed = 0;
      const handler = createConsolidateHandler({
        open: () =>
          Promise.resolve({
            sql: tenant.sql,
            gateway: createGateway().gateway,
            tier: 'paid' as const,
            capMicroUsd: null,
            close: () => {
              closed += 1;
              return Promise.resolve();
            },
          }),
        onCycle: () => {
          throw new Error('the fleet-side logger fell over');
        },
      });

      const enqueued = await queue.enqueue({
        tenantId: 'beta',
        kind: 'consolidate',
        target: 'whole_brain',
        trigger: 'time_ceiling',
        now: NOW,
      });
      expect(enqueued.enqueued).toBe(true);

      const runner = createJobRunner({
        queue,
        leases: createLeaseChannel({ sql: leaseSql }),
        handlers: { consolidate: handler },
        owner: 'consolidation-worker',
        concurrency: 1,
        onError: () => undefined,
      });

      const pass = await runner.runOnce({ now: NOW });
      expect(pass.outcomes.failed).toBe(1);
      expect(pass.outcomes.completed).toBe(0);
      // `finally`, not the happy path: a failure that leaked the connection is
      // the shape that only shows up under load.
      expect(closed).toBe(1);

      const job = await readJobRow(workSql, enqueued.enqueued ? enqueued.job.jobId : '');
      expect(job['failure_code']).toBe('handler_error');
    },
    SETUP_TIMEOUT_MS,
  );
});
