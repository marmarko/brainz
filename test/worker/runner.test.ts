/**
 * The loop: the concurrency bound, the outcomes it reports, and the two ways a
 * pass can end badly without the job being at fault.
 *
 * The bound is the one KTD11 makes load-bearing. `tenants ÷ (ceiling ÷ cycle) ≤
 * concurrent bound` is only an argument about capacity if the bound is real, and
 * "the fleet claims what it can handle" is not a bound — it is a hope. So this
 * file puts a hundred due jobs in front of a runner sized for twenty and counts
 * how many run at once.
 *
 * The clock is injected and the heartbeat is driven by hand, so nothing here
 * sleeps: lease loss, renewal and supersession are arithmetic against a real
 * Postgres rather than a race against a timer.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { createJobQueue, createLeaseChannel, type PostgresJobQueue } from '../../src/worker/queue.ts';
import { DEFAULT_LEASE_CONFIG, type LeaseConfig } from '../../src/worker/locks.ts';
import { createJobRunner, type JobHandler, type Ticker } from '../../src/worker/runner.ts';
import { nextCeilingDueAt, ALPHA_CEILING_MS } from '../../src/worker/scheduler.ts';
import type { JobLease, JobQueue } from '../../src/worker/jobs.ts';
import { connect, createControlPlane, dropControlPlane, readJobRow, seedTenant, type ControlFixture } from './fixture.ts';

const T0 = new Date('2026-08-12T00:00:00Z');
const CONFIG: LeaseConfig = DEFAULT_LEASE_CONFIG;

let fixture: ControlFixture;
let workSql: SQL;
let leaseSql: SQL;
let sideSql: SQL;
let queue: PostgresJobQueue;
let side: PostgresJobQueue;

beforeAll(async () => {
  fixture = await createControlPlane('runner');
  workSql = connect(fixture, 8);
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function runnerWith(
  handlers: Partial<Record<'consolidate' | 'ingest_pull', JobHandler>>,
  options: {
    readonly concurrency?: number;
    readonly queue?: JobQueue & { connection: unknown };
    readonly onError?: (error: unknown) => void;
    readonly ticker?: Ticker;
  } = {},
) {
  return createJobRunner({
    queue: options.queue ?? queue,
    leases: createLeaseChannel({ sql: leaseSql }),
    handlers,
    owner: 'worker-under-test',
    concurrency: options.concurrency ?? 20,
    config: CONFIG,
    clock: () => T0,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
    ...(options.ticker === undefined ? {} : { ticker: options.ticker }),
  });
}

describe('the concurrency bound', () => {
  test('a hundred due jobs run twenty at a time', async () => {
    // Twenty-five tenants, four lanes each: consolidation plus three connectors.
    for (let i = 0; i < 25; i++) {
      const tenantId = `fleet-${i}`;
      await seedTenant(sideSql, tenantId);
      await side.enqueue({ tenantId, kind: 'consolidate', target: 'whole_brain', trigger: 'time_ceiling', now: T0 });
      for (const target of ['gmail', 'calendar', 'drive'] as const) {
        await side.enqueue({ tenantId, kind: 'ingest_pull', target, trigger: 'connector_cadence', now: T0 });
      }
    }

    let active = 0;
    let peak = 0;
    const handler: JobHandler = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    };

    const runner = runnerWith({ consolidate: handler, ingest_pull: handler }, { concurrency: 20 });

    let drained = 0;
    for (let pass = 0; pass < 6; pass++) {
      const result = await runner.runOnce({ now: T0 });
      expect(result.claimed).toBeLessThanOrEqual(20);
      drained += result.outcomes.completed;
      if (result.claimed === 0) break;
    }

    expect(drained).toBe(100);
    // The assertion the capacity arithmetic rests on.
    expect(peak).toBe(20);
    expect(peak).toBeLessThanOrEqual(20);
  });

  test('a runner claims only the kinds it can run', async () => {
    await seedTenant(sideSql, 'mixed');
    await side.enqueue({ tenantId: 'mixed', kind: 'consolidate', target: 'whole_brain', trigger: 'time_ceiling', now: T0 });
    await side.enqueue({ tenantId: 'mixed', kind: 'ingest_pull', target: 'gmail', trigger: 'connector_cadence', now: T0 });

    const seen: string[] = [];
    const runner = runnerWith({
      ingest_pull: async ({ lease }) => {
        seen.push(lease.kind);
      },
    });

    const result = await runner.runOnce({ now: T0 });
    expect(result.claimed).toBe(1);
    expect(seen).toEqual(['ingest_pull']);

    // The consolidation is untouched and still due — not dead-lettered because
    // this instance happened not to know how to run it.
    const rows = (await sideSql`
      SELECT state FROM control.job WHERE tenant_id = 'mixed' AND kind = 'consolidate'
    `) as unknown as { state: string }[];
    expect(rows[0]?.state).toBe('due');
  });
});

describe('outcomes', () => {
  test('a handler that returns completes the job and settles the tenant', async () => {
    await seedTenant(sideSql, 'settling', { pendingDebt: 7 });
    await side.enqueue({
      tenantId: 'settling',
      kind: 'consolidate',
      target: 'whole_brain',
      trigger: 'debt_debounce',
      now: T0,
      debtObserved: 7,
    });

    const runner = runnerWith({ consolidate: async () => undefined });
    const result = await runner.runOnce({ now: T0 });
    expect(result.outcomes.completed).toBe(1);

    const tenant = (await sideSql`
      SELECT pending_debt, last_cycle_at, next_due_at FROM control.tenant WHERE tenant_id = 'settling'
    `) as unknown as { pending_debt: number; last_cycle_at: Date; next_due_at: Date }[];
    expect(tenant[0]?.pending_debt).toBe(0);
    expect(tenant[0]?.last_cycle_at?.getTime()).toBe(T0.getTime());
    // The next ceiling slot, staggered by this tenant's own hash.
    expect(tenant[0]?.next_due_at?.getTime()).toBe(
      nextCeilingDueAt('settling', T0, ALPHA_CEILING_MS).getTime(),
    );
  });

  test('an ingest job completes without moving the tenant\'s consolidation signals', async () => {
    // A Gmail poll is not a cycle. Settling on it would push the ceiling forward
    // on a tenant whose brain has not been consolidated at all.
    await seedTenant(sideSql, 'polling', { pendingDebt: 9 });
    await side.enqueue({
      tenantId: 'polling',
      kind: 'ingest_pull',
      target: 'gmail',
      trigger: 'connector_cadence',
      now: T0,
    });

    const runner = runnerWith({ ingest_pull: async () => undefined });
    expect((await runner.runOnce({ now: T0 })).outcomes.completed).toBe(1);

    const tenant = (await sideSql`
      SELECT pending_debt, last_cycle_at, next_due_at FROM control.tenant WHERE tenant_id = 'polling'
    `) as unknown as { pending_debt: number; last_cycle_at: Date | null; next_due_at: Date | null }[];
    expect(tenant[0]?.pending_debt).toBe(9);
    expect(tenant[0]?.last_cycle_at).toBeNull();
  });

  test('a handler that throws fails the job, and the error is not swallowed', async () => {
    await seedTenant(sideSql, 'throwing');
    await side.enqueue({
      tenantId: 'throwing',
      kind: 'consolidate',
      target: 'whole_brain',
      trigger: 'time_ceiling',
      now: T0,
    });

    const errors: unknown[] = [];
    const runner = runnerWith(
      {
        consolidate: async () => {
          throw new Error('the model refused');
        },
      },
      { onError: (error) => errors.push(error) },
    );

    const result = await runner.runOnce({ now: T0 });
    expect(result.outcomes.failed).toBe(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('the model refused');

    const rows = (await sideSql`
      SELECT state, failure_code, attempts FROM control.job WHERE tenant_id = 'throwing'
    `) as unknown as { state: string; failure_code: string; attempts: number }[];
    expect(rows[0]).toEqual({ state: 'due', failure_code: 'handler_error', attempts: 1 });
  });

  test('a store failure is reported as a store failure, never as a poison job', async () => {
    // "The control plane is down" recorded on a job as "this job is broken" walks
    // a healthy tenant up the retry ladder and into a quarantine, for an outage
    // that had nothing to do with it.
    await seedTenant(sideSql, 'store-down');
    await side.enqueue({
      tenantId: 'store-down',
      kind: 'consolidate',
      target: 'whole_brain',
      trigger: 'time_ceiling',
      now: T0,
    });

    const broken: JobQueue & { connection: unknown } = {
      ...queue,
      complete: () => Promise.reject(new Error('control plane unreachable')),
    };

    const errors: unknown[] = [];
    const runner = runnerWith({ consolidate: async () => undefined }, { queue: broken, onError: (e) => errors.push(e) });

    const result = await runner.runOnce({ now: T0 });
    expect(result.outcomes.store_error).toBe(1);
    expect(result.outcomes.failed).toBe(0);
    expect(result.storeErrors).toHaveLength(1);
    expect(errors).toHaveLength(1);

    // The job is still running under its lease. The reaper will take it back on
    // its own terms, with the attempt deadline as the backstop.
    const rows = (await sideSql`
      SELECT state, failure_code FROM control.job WHERE tenant_id = 'store-down'
    `) as unknown as { state: string; failure_code: string | null }[];
    expect(rows[0]?.state).toBe('running');
    expect(rows[0]?.failure_code).toBeNull();
  });
});

describe('renewal and lease loss', () => {
  /** Enqueues one job and returns a handler gate the test can open. */
  async function inFlightJob(tenantId: string) {
    await seedTenant(sideSql, tenantId);
    await side.enqueue({
      tenantId,
      kind: 'consolidate',
      target: 'whole_brain',
      trigger: 'time_ceiling',
      now: T0,
    });
    const entered = deferred();
    const gate = deferred();
    let sawAbort = false;
    const handler: JobHandler = async ({ signal }) => {
      entered.resolve();
      await gate.promise;
      sawAbort = signal.aborted;
    };
    return { handler, entered, gate, sawAbort: () => sawAbort };
  }

  test('beat renews every in-flight lease', async () => {
    const job = await inFlightJob('renewing');
    const runner = runnerWith({ consolidate: job.handler });

    const pass = runner.runOnce({ now: T0 });
    await job.entered.promise;
    expect(runner.inFlight()).toBe(1);

    const renewAt = new Date(T0.getTime() + CONFIG.heartbeatIntervalMs);
    expect(await runner.beat(renewAt)).toEqual({ renewed: 1, lost: 0 });

    const rows = (await sideSql`
      SELECT heartbeat_at, lease_expires_at FROM control.job WHERE tenant_id = 'renewing'
    `) as unknown as { heartbeat_at: Date; lease_expires_at: Date }[];
    expect(rows[0]?.heartbeat_at?.getTime()).toBe(renewAt.getTime());
    expect(rows[0]?.lease_expires_at?.getTime()).toBe(renewAt.getTime() + CONFIG.leaseTtlMs);

    job.gate.resolve();
    await pass;
  });

  test('a stolen lease is reported, aborts the handler, and its completion is refused', async () => {
    const job = await inFlightJob('stolen');
    const runner = runnerWith({ consolidate: job.handler });

    const pass = runner.runOnce({ now: T0 });
    await job.entered.promise;

    // The reaper, elsewhere in the fleet, at an instant past expiry and grace.
    const at = new Date(T0.getTime() + CONFIG.leaseTtlMs + CONFIG.stealGraceMs + 1);
    const taken = await side.reclaim({ now: at, stealGraceMs: CONFIG.stealGraceMs });
    expect(taken).toHaveLength(1);

    expect(await runner.beat(at)).toEqual({ renewed: 0, lost: 1 });

    job.gate.resolve();
    const result = await pass;

    // The handler was told …
    expect(job.sawAbort()).toBe(true);
    // … but the guarantee is that the store refused it regardless.
    expect(result.outcomes.superseded).toBe(1);
    expect(result.outcomes.completed).toBe(0);

    const rows = (await sideSql`SELECT job_id FROM control.job WHERE tenant_id = 'stolen'`) as unknown as {
      job_id: string;
    }[];
    const row = await readJobRow(sideSql, rows[0]?.job_id ?? '');
    expect(row['state']).toBe('due');
  });

  test('a renewal that throws does not take the loop down with it', async () => {
    // The detached-timer unhandled-rejection shape. One bad channel call must
    // not end renewal for every other in-flight lease in the process.
    const job = await inFlightJob('resilient');
    const errors: unknown[] = [];
    const runner = createJobRunner({
      queue,
      leases: {
        connection: leaseSql,
        heartbeat: () => Promise.reject(new Error('connection reset')),
      },
      handlers: { consolidate: job.handler },
      owner: 'worker-under-test',
      concurrency: 4,
      config: CONFIG,
      clock: () => T0,
      onError: (error) => errors.push(error),
    });

    const pass = runner.runOnce({ now: T0 });
    await job.entered.promise;

    await expect(runner.beat(T0)).resolves.toEqual({ renewed: 0, lost: 0 });
    expect(errors).toHaveLength(1);

    job.gate.resolve();
    await pass;
  });

  test('start wires the ticker, and stop aborts what is in flight', async () => {
    const job = await inFlightJob('ticking');
    const ticks: (() => void)[] = [];
    const ticker: Ticker = {
      every(_intervalMs, fn) {
        ticks.push(fn);
        return () => {
          const at = ticks.indexOf(fn);
          if (at >= 0) ticks.splice(at, 1);
        };
      },
    };

    const runner = runnerWith({ consolidate: job.handler }, { ticker });
    const stop = runner.start();
    expect(ticks).toHaveLength(1);

    const pass = runner.runOnce({ now: T0 });
    await job.entered.promise;

    stop();
    expect(ticks).toHaveLength(0);

    job.gate.resolve();
    await pass;
    // `stop` aborts in-flight work so a shutting-down process stops spending.
    expect(job.sawAbort()).toBe(true);
  });
});

describe('a runner refuses to be built wrong', () => {
  test('with no handlers', () => {
    expect(() =>
      createJobRunner({
        queue,
        leases: createLeaseChannel({ sql: leaseSql }),
        handlers: {},
        owner: 'w',
        concurrency: 1,
      }),
    ).toThrow(/no handlers/);
  });

  test('with a concurrency bound below one', () => {
    expect(() =>
      createJobRunner({
        queue,
        leases: createLeaseChannel({ sql: leaseSql }),
        handlers: { consolidate: async () => undefined },
        owner: 'w',
        concurrency: 0,
      }),
    ).toThrow(/at least one job/);
  });

  test('with renewal sharing the work connection', () => {
    expect(() =>
      createJobRunner({
        queue,
        leases: createLeaseChannel({ sql: workSql }),
        handlers: { consolidate: async () => undefined },
        owner: 'w',
        concurrency: 1,
      }),
    ).toThrow(/hazard H4/);
  });

  test('with a lease configuration that steals from healthy workers', () => {
    expect(() =>
      createJobRunner({
        queue,
        leases: createLeaseChannel({ sql: leaseSql }),
        handlers: { consolidate: async () => undefined },
        owner: 'w',
        concurrency: 1,
        config: { ...CONFIG, leaseTtlMs: CONFIG.heartbeatIntervalMs },
      }),
    ).toThrow(/heartbeat intervals/);
  });
});

describe('the queue and the schema agree about what a job may be', () => {
  test('every legal kind/target pairing the module declares is one the database accepts', async () => {
    // The TypeScript table and the `job_target_suits_its_kind` CHECK are two
    // statements of one rule. A pairing the table allows and the CHECK refuses is
    // a constraint violation raised on a live enqueue.
    await seedTenant(sideSql, 'pairings');
    const legal: readonly (readonly ['consolidate' | 'ingest_pull' | 'import' | 'export' | 're_embed', JobLease['target']])[] = [
      ['consolidate', 'whole_brain'],
      ['export', 'whole_brain'],
      ['re_embed', 'whole_brain'],
      ['ingest_pull', 'gmail'],
      ['ingest_pull', 'calendar'],
      ['ingest_pull', 'drive'],
      ['import', 'chat_export'],
      ['import', 'folder'],
    ];

    for (const [kind, target] of legal) {
      const outcome = await side.enqueue({
        tenantId: 'pairings',
        kind,
        target,
        trigger: 'user_request',
        now: T0,
      });
      expect(outcome.enqueued).toBe(true);
    }
  });

  test('an illegal pairing is refused by the database too, not only by the module', async () => {
    await seedTenant(sideSql, 'illegal');
    // Straight past the module's own check, to the CHECK constraint underneath.
    let sqlstate: string | undefined;
    try {
      await sideSql`
        INSERT INTO control.job (
          job_id, tenant_id, kind, target, state, trigger_reason,
          attempts, max_attempts, debt_observed, run_at, lease_token, created_at, updated_at
        ) VALUES (
          gen_random_uuid(), 'illegal', 'consolidate', 'gmail', 'due', 'user_request',
          0, 5, 0, ${T0}, 0, ${T0}, ${T0}
        )
      `;
    } catch (error) {
      sqlstate = (error as { errno?: string }).errno;
    }
    expect(sqlstate).toBe('23514');
  });
});
