/**
 * "There is more to do" as a job outcome, and why it is neither of the two the
 * queue already had.
 *
 * **The incident.** A whole-brain consolidation cycle on a 5,608-page brain
 * outlived the fifteen-minute attempt ceiling five times. Each overrun was a
 * *reap*: the reaper took the lease, charged an attempt, and stamped
 * `attempt_timed_out`. Five of those exhausted `RETRY_POLICY.consolidate`, the
 * lane dead-lettered, and `enqueueDuePulls` counts a dead-lettered lane as one
 * already standing — so nothing, not the cadence and not a redeploy, would ever
 * poll that tenant again until an operator cleared it by hand. 2h46m of wall
 * clock, zero completed cycles, and a brain that had been ingesting for a
 * fortnight with 160 facts to show for it.
 *
 * The handler now stops itself and says it is not finished. That has to land as
 * a **completion**, because:
 *
 *   - a failure charges an attempt, and a job that legitimately needs ten
 *     attempts cannot live under a policy that allows five;
 *   - a plain completion settles the tenant as consolidated — `last_cycle_at`
 *     stamped, `next_due_at` pushed to the next 24-hour ceiling — which is the
 *     brain going to sleep on top of the work it just asked to resume.
 *
 * So the settlement is the interesting part, and it is two columns: the debt
 * still comes off, `next_due_at` goes to *now*, and `last_cycle_at` does not
 * move. The scheduler's rested window and its debounce arm both read that column,
 * and the tests below are about what each of the two settlements does to the very
 * next scheduler tick.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import type { JobLease } from '../../src/worker/jobs.ts';
import { DEFAULT_LEASE_CONFIG } from '../../src/worker/locks.ts';
import { createJobQueue, createLeaseChannel, type PostgresJobQueue } from '../../src/worker/queue.ts';
import { createJobRunner, type JobHandler } from '../../src/worker/runner.ts';
import { ALPHA_SCHEDULER, selectDueTenants } from '../../src/worker/scheduler.ts';
import {
  connect,
  createControlPlane,
  dropControlPlane,
  readJobRow,
  seedTenant,
  type ControlFixture,
} from './fixture.ts';

const T0 = new Date('2026-08-12T00:00:00Z');
/** One tick later. The scheduler's next look at the fleet. */
const T1 = new Date(T0.getTime() + 60_000);

let fixture: ControlFixture;
let workSql: SQL;
let leaseSql: SQL;
let sideSql: SQL;
let queue: PostgresJobQueue;
let side: PostgresJobQueue;

beforeAll(async () => {
  fixture = await createControlPlane('continuation');
  workSql = connect(fixture, 4);
  leaseSql = connect(fixture, 1);
  sideSql = connect(fixture, 1);
  queue = createJobQueue({ sql: workSql });
  side = createJobQueue({ sql: sideSql });
});

afterAll(async () => {
  await workSql.close();
  await leaseSql.close();
  await sideSql.close();
  await dropControlPlane(fixture);
});

beforeEach(async () => {
  await sideSql`DELETE FROM control.job`;
  await sideSql`DELETE FROM control.tenant`;
});

function runnerWith(handler: JobHandler) {
  return createJobRunner({
    queue,
    leases: createLeaseChannel({ sql: leaseSql }),
    handlers: { consolidate: handler },
    owner: 'worker-under-test',
    concurrency: 2,
    config: DEFAULT_LEASE_CONFIG,
    clock: () => T0,
  });
}

interface TenantRow {
  readonly pending_debt: number;
  readonly last_cycle_at: Date | null;
  readonly next_due_at: Date | null;
}

async function tenantRow(tenantId: string): Promise<TenantRow> {
  const rows = (await sideSql`
    SELECT pending_debt, last_cycle_at, next_due_at
      FROM control.tenant WHERE tenant_id = ${tenantId}
  `) as unknown as TenantRow[];
  const row = rows[0];
  if (row === undefined) throw new Error(`no tenant ${tenantId}`);
  return row;
}

/** A tenant the ceiling has just woken, with debt the cycle is running off. */
async function dueTenant(tenantId: string): Promise<string> {
  await seedTenant(sideSql, tenantId, { pendingDebt: 12, nextDueAt: T0 });
  const outcome = await side.enqueue({
    tenantId,
    kind: 'consolidate',
    target: 'whole_brain',
    trigger: 'time_ceiling',
    now: T0,
    debtObserved: 12,
  });
  if (!outcome.enqueued) throw new Error(`could not enqueue: ${outcome.reason}`);
  return outcome.job.jobId;
}

describe('a cycle with work left completes and is woken again at once', () => {
  test(
    'the job is done, not failed, and no attempt is charged against the ladder',
    async () => {
      const jobId = await dueTenant('longbrain');
      const runner = runnerWith(async () => ({ continuation: true }));

      const result = await runner.runOnce({ now: T0 });
      expect(result.outcomes.completed).toBe(1);
      expect(result.outcomes.failed).toBe(0);

      const row = await readJobRow(sideSql, jobId);
      expect(row['state']).toBe('done');
      expect(row['failure_code']).toBeNull();
      expect(row['dead_lettered_at']).toBeNull();
      // One attempt, spent on one attempt's worth of work. The ladder this used
      // to burn through — five reaps in 2h46m — is untouched, and the next slice
      // of the same brain arrives as a fresh row with a fresh ladder.
      expect(row['attempts']).toBe(1);
    },
  );

  test(
    'the tenant is due again on the next tick, with its debt worked off',
    async () => {
      await dueTenant('longbrain');
      const runner = runnerWith(async () => ({ continuation: true }));
      await runner.runOnce({ now: T0 });

      const tenant = await tenantRow('longbrain');
      // The debt does come off: the job observed it and worked against it, and a
      // counter that is only ever added to is not a signal.
      expect(tenant.pending_debt).toBe(0);
      // These two are the settlement. `last_cycle_at` unmoved is what keeps the
      // scheduler's rested window from holding the brain for half an hour, and
      // `next_due_at` at `now` is what makes the ceiling arm fire immediately.
      expect(tenant.last_cycle_at).toBeNull();
      expect(tenant.next_due_at?.getTime()).toBe(T0.getTime());

      const due = await selectDueTenants(sideSql, { now: T1, config: ALPHA_SCHEDULER });
      expect(due.map((row) => row.tenantId)).toEqual(['longbrain']);
    },
  );

  test(
    'a cycle that finished settles the other way and the brain sleeps',
    async () => {
      await dueTenant('donebrain');
      // The control: a handler that returns nothing, which is every handler in
      // the fleet and was the only thing a consolidation cycle could do.
      const runner = runnerWith(async () => undefined);
      await runner.runOnce({ now: T0 });

      const tenant = await tenantRow('donebrain');
      expect(tenant.last_cycle_at?.getTime()).toBe(T0.getTime());
      expect(tenant.next_due_at?.getTime()).toBeGreaterThan(T1.getTime());

      const due = await selectDueTenants(sideSql, { now: T1, config: ALPHA_SCHEDULER });
      expect(due).toEqual([]);
    },
  );

  test(
    'a continuation on a kind that does not settle is still an ordinary completion',
    async () => {
      // `defaultSettle` answers only for `consolidate`, and a connector poll that
      // somehow reported a continuation must not acquire a settlement it never
      // had. Asserted because the flag is on the shared `CompleteRequest`, so
      // "which kinds does this apply to" is a question about one `if`.
      await seedTenant(sideSql, 'poller', { pendingDebt: 4, nextDueAt: T0 });
      const enqueued = await side.enqueue({
        tenantId: 'poller',
        kind: 'ingest_pull',
        target: 'gmail',
        trigger: 'connector_cadence',
        now: T0,
        debtObserved: 4,
      });
      if (!enqueued.enqueued) throw new Error('could not enqueue');

      const runner = createJobRunner({
        queue,
        leases: createLeaseChannel({ sql: leaseSql }),
        handlers: { ingest_pull: async () => ({ continuation: true }) },
        owner: 'worker-under-test',
        concurrency: 1,
        config: DEFAULT_LEASE_CONFIG,
        clock: () => T0,
      });
      const result = await runner.runOnce({ now: T0 });
      expect(result.outcomes.completed).toBe(1);

      const tenant = await tenantRow('poller');
      expect(tenant.pending_debt).toBe(4);
      expect(tenant.last_cycle_at).toBeNull();
      expect(tenant.next_due_at?.getTime()).toBe(T0.getTime());
    },
  );

  test(
    'a custom settle rule is handed the outcome, not left to guess at it',
    async () => {
      await dueTenant('custom');
      const seen: Array<{ kind: string; continuation: boolean | undefined }> = [];
      const runner = createJobRunner({
        queue,
        leases: createLeaseChannel({ sql: leaseSql }),
        handlers: { consolidate: async () => ({ continuation: true }) },
        owner: 'worker-under-test',
        concurrency: 1,
        config: DEFAULT_LEASE_CONFIG,
        clock: () => T0,
        settle: (lease: JobLease, _now: Date, outcome) => {
          seen.push({ kind: lease.kind, continuation: outcome?.continuation });
          return undefined;
        },
      });
      await runner.runOnce({ now: T0 });
      expect(seen).toEqual([{ kind: 'consolidate', continuation: true }]);
    },
  );
});
