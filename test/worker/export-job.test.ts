/**
 * The `export` job kind, from the scheduler tick to the row it writes.
 *
 * **What was missing.** `JOB_KINDS` has declared `export` since U10 and
 * `LEGAL_TARGETS.export = ['whole_brain']` since the same commit;
 * `src/core/export/schedule.ts` has run the export and banked the attempt since
 * U17. Between them, nothing: `src/worker/serve.ts` registered
 * `{ consolidate }` and `runSchedulerTick` enqueued `consolidate` and nothing
 * else, so the scheduled self-export was a function with no caller and a job
 * kind with no handler. The ledger's own words for it: *"exactly one kind has a
 * production handler … exactly one kind is ever enqueued by a running fleet."*
 *
 * **The two halves are tested as two halves, on purpose.** An end-to-end test
 * that seeds a queue and asserts a row appeared cannot say *which* of the two
 * gaps it closed, and either one alone leaves the capability unreachable.
 *
 * **The assertion that matters most is the one about doing nothing.**
 * `schedule.ts` exists to keep "never set up" and "failing for six weeks" apart
 * — two columns, `last_export_at` and `last_attempt_at`, and a reminder that
 * says which. A handler that banked an attempt for a tenant who has chosen no
 * destination collapses them: every brain in the fleet would report a failing
 * scheduled export from the first tick, and the reminder that was supposed to
 * say *"N documents live only here"* says *"your export has been failing for
 * 40 days"* instead. So the no-destination branch writes **nothing**, and that
 * is asserted against the columns rather than against a return value.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { createExportHandler, enqueueDueExports } from '../../src/worker/export.ts';
import { createJobQueue, createLeaseChannel } from '../../src/worker/queue.ts';
import { createJobRunner } from '../../src/worker/runner.ts';
import { ALPHA_CEILING_MS, nextCeilingDueAt } from '../../src/worker/scheduler.ts';
import { readExportState, type SelfExportDestination } from '../../src/core/export/schedule.ts';
import { EMBEDDING_DIMENSIONS } from '../../src/schema/vector-index.ts';
import {
  connect as connectControl,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from './fixture.ts';
import {
  connect as connectTenant,
  dropFixtureDatabase,
  provisionFixture,
  type SchemaFixture,
} from '../schema/fixture.ts';

import type { SQL } from 'bun';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const TENANT = 'export-alice';
const OTHER = 'export-bob';
const NOW = new Date('2026-08-16T09:00:00.000Z');

let control: ControlFixture;
let controlSql: SQL;
let leaseSql: SQL;
let brain: SchemaFixture;
let brainSql: SQL;

beforeAll(async () => {
  control = await createControlPlane('exportjob');
  controlSql = connectControl(control, 4);
  leaseSql = connectControl(control, 2);
  brain = await provisionFixture('exportjob_brain');
  brainSql = connectTenant(brain);
  await brainSql.unsafe(`
    INSERT INTO page (origin_context, source_type, title, embedding_model, embedding_dimensions,
                      chunker_version, normalizer_version, content_sha256)
    VALUES ('personal', 'note', 'a note', 'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64));
    INSERT INTO chunk (origin_context, content, page_id, ordinal)
    SELECT 'personal', 'something worth keeping', page_id, 0 FROM page WHERE title = 'a note';
  `);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await brainSql?.close();
  await controlSql?.close();
  await leaseSql?.close();
  if (brain !== undefined) await dropFixtureDatabase(brain);
  if (control !== undefined) await dropControlPlane(control);
});

beforeEach(async () => {
  await controlSql`DELETE FROM control.job`;
  await controlSql`DELETE FROM control.tenant`;
  await brainSql`DELETE FROM self_export`;
});

// ---------------------------------------------------------------------------
// Half one: something enqueues it.
// ---------------------------------------------------------------------------

describe('the scheduler enqueues a whole-brain export for every ready tenant', () => {
  test('one job per ready tenant, and none for a tenant that is not', async () => {
    await seedTenant(controlSql, TENANT);
    await seedTenant(controlSql, OTHER);
    await seedTenant(controlSql, 'export-unprovisioned', { state: 'provisioning' });

    const queue = createJobQueue({ sql: controlSql });
    const result = await enqueueDueExports({ sql: controlSql, queue }, { now: NOW });

    expect(result.enqueued.map((row) => row.tenantId).sort()).toEqual([TENANT, OTHER].sort());
    const rows = (await controlSql`
      SELECT tenant_id, kind::text AS kind, target::text AS target, state::text AS state
        FROM control.job ORDER BY tenant_id
    `) as Array<Record<string, string>>;
    expect(rows.map((row) => `${row.tenant_id}/${row.kind}/${row.target}/${row.state}`)).toEqual([
      `${TENANT}/export/whole_brain/due`,
      `${OTHER}/export/whole_brain/due`,
    ]);
  });

  test('it lands on the tenant’s own consolidation slot, so it rides a wake already paid for', async () => {
    await seedTenant(controlSql, TENANT);
    const queue = createJobQueue({ sql: controlSql });

    const result = await enqueueDueExports({ sql: controlSql, queue }, { now: NOW });

    // Not "now", and not a slot of its own: the same staggered instant the
    // consolidation ceiling uses. A separate salt would double the number of
    // times a suspended tenant compute is woken, for a read that is one row.
    expect(result.enqueued[0]?.runAt.toISOString()).toBe(
      nextCeilingDueAt(TENANT, NOW, ALPHA_CEILING_MS).toISOString(),
    );
    // And it is in the future, so `claim` — which filters `run_at <= now` —
    // cannot pick it up on the tick that created it.
    expect(result.enqueued[0]?.runAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test('a second tick does not stack a second export on the same tenant', async () => {
    await seedTenant(controlSql, TENANT);
    const queue = createJobQueue({ sql: controlSql });

    await enqueueDueExports({ sql: controlSql, queue }, { now: NOW });
    const second = await enqueueDueExports(
      { sql: controlSql, queue },
      { now: new Date(NOW.getTime() + 60_000) },
    );

    // Skipped in SQL rather than attempted and refused: the anti-join is what
    // keeps a minute-cadence tick from issuing one insert per tenant per minute
    // for the whole fleet, forever.
    expect(second.due).toBe(0);
    expect(second.enqueued).toEqual([]);
    expect(second.refused).toEqual([]);
    const count = (await controlSql`SELECT count(*)::int AS n FROM control.job`) as Array<{ n: number }>;
    expect(count[0]?.n).toBe(1);
  });

  test('a dead-lettered export lane is left alone rather than re-enqueued every tick', async () => {
    await seedTenant(controlSql, TENANT);
    const queue = createJobQueue({ sql: controlSql });
    await enqueueDueExports({ sql: controlSql, queue }, { now: NOW });
    await controlSql`
      UPDATE control.job
         SET state = 'dead', dead_lettered_at = ${NOW}, finished_at = ${NOW},
             failure_code = 'handler_error'`;

    const again = await enqueueDueExports({ sql: controlSql, queue }, { now: NOW });

    expect(again.due).toBe(0);
    expect(again.enqueued).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Half two: something runs it.
// ---------------------------------------------------------------------------

interface Recorded {
  readonly files: number;
  readonly pages: number;
}

function destination(
  kind: SelfExportDestination['kind'],
  options: { readonly fail?: boolean } = {},
): { readonly port: SelfExportDestination; readonly writes: Recorded[] } {
  const writes: Recorded[] = [];
  return {
    writes,
    port: {
      kind,
      write(request) {
        if (options.fail === true) {
          const error = new Error('the destination refused');
          error.name = 'DestinationRefused';
          return Promise.reject(error);
        }
        writes.push({ files: request.files.length, pages: request.manifest.pages });
        return Promise.resolve();
      },
    },
  };
}

/** The runner, wired as `worker/serve.ts` wires it, with only the export kind. */
function runnerFor(destinations: Record<string, () => SelfExportDestination>, seen: unknown[]) {
  return createJobRunner({
    queue: createJobQueue({ sql: controlSql }),
    leases: createLeaseChannel({ sql: leaseSql }),
    handlers: {
      export: createExportHandler({
        open: () => Promise.resolve({ sql: brainSql, close: () => Promise.resolve() }),
        destinations,
        onExport: (tenantId, outcome) => seen.push({ tenantId, ...outcome }),
      }),
    },
    owner: 'export-test',
    concurrency: 2,
  });
}

/** Enqueue an export that is claimable now rather than at tomorrow's slot. */
async function enqueueClaimable(): Promise<void> {
  const queue = createJobQueue({ sql: controlSql });
  const outcome = await queue.enqueue({
    tenantId: TENANT,
    kind: 'export',
    target: 'whole_brain',
    trigger: 'time_ceiling',
    now: NOW,
  });
  if (!outcome.enqueued) throw new Error(`fixture: could not enqueue (${outcome.reason})`);
}

describe('the handler runs the export the schedule module already knew how to run', () => {
  beforeEach(async () => {
    await seedTenant(controlSql, TENANT);
    await enqueueClaimable();
  });

  test(
    'a tenant who has chosen no destination is left with both columns NULL',
    async () => {
      const seen: unknown[] = [];
      const pass = await runnerFor({}, seen).runOnce({ now: NOW });

      expect(pass.claimed).toBe(1);
      expect(pass.outcomes.completed).toBe(1);
      expect(seen).toEqual([{ tenantId: TENANT, result: 'no_destination' }]);

      // The whole point. `last_attempt_at` moving here would turn every brain in
      // the fleet into one whose scheduled export "has been failing" since the
      // day the fleet learned to enqueue.
      const state = await readExportState(brainSql);
      expect(state.destinationKind).toBeNull();
      expect(state.lastAttemptAt).toBeNull();
      expect(state.lastExportAt).toBeNull();
      expect(state.lastFailure).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a tenant whose destination this fleet can serve gets the export delivered',
    async () => {
      await brainSql`
        INSERT INTO self_export (singleton, destination_kind) VALUES (true, 'object_store')`;
      const store = destination('object_store');
      const seen: unknown[] = [];

      const pass = await runnerFor({ object_store: () => store.port }, seen).runOnce({ now: NOW });

      expect(pass.outcomes.completed).toBe(1);
      // The tree really was built from the brain rather than delivered empty.
      expect(store.writes).toEqual([{ files: 1, pages: 1 }]);
      const state = await readExportState(brainSql);
      expect(state.lastExportAt).not.toBeNull();
      expect(state.lastExportPages).toBe(1);
      expect(state.lastFailure).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a destination this fleet has no implementation for is banked as a failure, not as silence',
    async () => {
      await brainSql`
        INSERT INTO self_export (singleton, destination_kind) VALUES (true, 'user_bucket')`;
      const seen: unknown[] = [];

      const pass = await runnerFor({}, seen).runOnce({ now: NOW });

      expect(pass.outcomes.completed).toBe(1);
      expect(seen).toEqual([
        { tenantId: TENANT, result: 'destination_unavailable', destinationKind: 'user_bucket' },
      ]);
      // The user chose somewhere and nothing is going there. Reported through
      // the two columns the reminder reads, so they hear it rather than an
      // operator reading a log they do not have.
      const state = await readExportState(brainSql);
      expect(state.lastAttemptAt).not.toBeNull();
      expect(state.lastFailure).toBe('destination_unavailable');
      expect(state.lastExportAt).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a destination that throws does not dead-letter the lane',
    async () => {
      await brainSql`
        INSERT INTO self_export (singleton, destination_kind) VALUES (true, 'object_store')`;
      const store = destination('object_store', { fail: true });
      const seen: unknown[] = [];

      const pass = await runnerFor({ object_store: () => store.port }, seen).runOnce({ now: NOW });

      // A destination that was down for an hour must not walk a healthy tenant
      // up the retry ladder into a quarantine only an operator can clear — the
      // failure is a product fact the reminder already knows how to say.
      expect(pass.outcomes.failed).toBe(0);
      expect(pass.outcomes.completed).toBe(1);
      const state = await readExportState(brainSql);
      expect(state.lastFailure).toBe('DestinationRefused');
      expect(state.lastExportAt).toBeNull();
      const job = (await controlSql`SELECT state::text AS state FROM control.job`) as Array<{
        state: string;
      }>;
      expect(job[0]?.state).toBe('done');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'finishing an export settles nothing on the tenant row',
    async () => {
      await controlSql`
        UPDATE control.tenant SET pending_debt = 9, next_due_at = ${NOW} WHERE tenant_id = ${TENANT}`;

      await runnerFor({}, []).runOnce({ now: NOW });

      // `defaultSettle` returns undefined for every kind but `consolidate`, and
      // an export that subtracted a debt it did not work off — or stamped a new
      // ceiling slot — would silently postpone the tenant's next consolidation.
      const rows = (await controlSql`
        SELECT pending_debt, next_due_at FROM control.tenant WHERE tenant_id = ${TENANT}
      `) as Array<{ pending_debt: number; next_due_at: Date }>;
      expect(rows[0]?.pending_debt).toBe(9);
      expect(rows[0]?.next_due_at.toISOString()).toBe(NOW.toISOString());
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the tenant connection is closed whatever the run did',
    async () => {
      // A handler that opened a connection per job and leaked one exhausts the
      // per-tenant LRU the whole runtime choice was made around — the reason
      // `worker/serve.ts` honours `close` on the consolidation world.
      let closed = 0;
      const runner = createJobRunner({
        queue: createJobQueue({ sql: controlSql }),
        leases: createLeaseChannel({ sql: leaseSql }),
        handlers: {
          export: createExportHandler({
            open: () =>
              Promise.resolve({
                sql: brainSql,
                close: () => {
                  closed += 1;
                  return Promise.resolve();
                },
              }),
            destinations: {},
          }),
        },
        owner: 'export-close-test',
        concurrency: 1,
      });

      await runner.runOnce({ now: NOW });
      expect(closed).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
