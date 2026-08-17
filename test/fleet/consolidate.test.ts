/**
 * The billing → consolidation seam, with a caller.
 *
 * **What was wrong.** `createConsolidateWorld` (`src/control/tier.ts`) is the
 * thing that reads `control.tenant.tier` — the column `src/control/billing.ts`
 * is the only writer of — and hands it to the cycle as the tier that decides
 * whether the model phases run. Its only caller in the repo was its own test, so
 * the tier flip held inside that test and nowhere else: a subscription change
 * moved a column no running process read. Nothing constructed a job runner to
 * hand the ports to, because nothing constructed a job runner at all.
 *
 * **How this proves it, without spending a cent.** The worker entrypoint is
 * spawned, the scheduler enqueues a due tenant, the runner claims it and the
 * handler opens the world. On a **free** tenant the model phases are skipped and
 * the run banks `free_tier`. Flip the column to `paid` and the next cycle banks
 * `complete` instead — the same code, the same empty brain, a different stop
 * reason, and the only input that changed is the control-plane column. Both runs
 * make **zero** model calls, which is asserted rather than assumed: the brain is
 * empty, so the paid cycle's phases have nothing to send.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';

import { mintTenantBearer } from '../../src/mcp/oauth.ts';
import { tenantNamespace } from '../../src/control/secrets.ts';
import { TENANT_SCHEMA_VERSION } from '../../src/schema/apply.ts';
import {
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from '../worker/fixture.ts';
import { dropFixtureDatabase, provisionFixture, type SchemaFixture } from '../schema/fixture.ts';
import {
  FAKE_CF_ACCOUNT_ID,
  startService,
  writeSecretsFile,
  type RunningService,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TENANT = 'consolidate-seam';

let control: ControlFixture;
let tenant: SchemaFixture;
let controlSql: SQL;
let tenantSql: SQL;
let scratch: string;
let worker: RunningService;

beforeAll(async () => {
  control = await createControlPlane('consolidateseam');
  tenant = await provisionFixture('consolidateseam');
  controlSql = new SQL(control.dsn, { max: 2 });
  tenantSql = new SQL(tenant.dsn, { max: 2 });

  await seedTenant(controlSql, TENANT);
  await controlSql`
    UPDATE control.tenant
       SET schema_version = ${TENANT_SCHEMA_VERSION}
     WHERE tenant_id = ${TENANT}`;

  scratch = mkdtempSync(join(tmpdir(), 'brainz-consolidate-'));
  const secretsFile = join(scratch, 'secrets.json');
  await writeSecretsFile(secretsFile, {
    secrets: {
      [tenantNamespace(TENANT)]: {
        connectionString: tenant.dsn,
        bearerGrant: mintTenantBearer(TENANT),
      },
    },
  });

  worker = await startService({
    entry: 'src/worker/serve.ts',
    env: {
      BRAINZ_CONTROL_DATABASE_URL: control.dsn,
      BRAINZ_SECRET_BACKEND: 'file',
      BRAINZ_SECRETS_FILE: secretsFile,
      BRAINZ_CF_ACCOUNT_ID: FAKE_CF_ACCOUNT_ID,
      // Fast enough that a case does not wait a minute for its tick.
      BRAINZ_WORKER_TICK_MS: '400',
      BRAINZ_WORKER_CONCURRENCY: '1',
    },
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await worker?.stop();
  await controlSql?.close();
  await tenantSql?.close();
  if (control !== undefined) await dropControlPlane(control);
  if (tenant !== undefined) await dropFixtureDatabase(tenant);
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

interface RunRow {
  readonly tier: string;
  readonly stop_reason: string;
  readonly model_calls: number;
  readonly spent_micro_usd: string;
}

/** Make the tenant due again, and clear what a previous cycle banked. */
async function makeDue(tier: 'free' | 'paid'): Promise<void> {
  await tenantSql`DELETE FROM consolidation_checkpoint`;
  await tenantSql`DELETE FROM consolidation_run`;
  await controlSql`DELETE FROM control.job`;
  await controlSql`
    UPDATE control.tenant
       SET tier = ${tier}::control.tenant_tier,
           next_due_at = now() - interval '1 hour',
           last_cycle_at = NULL,
           pending_debt = 0
     WHERE tenant_id = ${TENANT}`;
}

/** Wait for the worker's own loop to bank a finished cycle. No sleeping past it. */
async function waitForFinishedRun(timeoutMs = 60_000): Promise<RunRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await tenantSql<RunRow[]>`
      SELECT tier, stop_reason, model_calls, spent_micro_usd
        FROM consolidation_run
       WHERE finished_at IS NOT NULL
       ORDER BY run_id DESC LIMIT 1`;
    const found = rows[0];
    if (found !== undefined) return found;
    if (Date.now() > deadline) {
      throw new Error(
        `no consolidation run finished within ${timeoutMs}ms; worker stderr:\n${await worker.stderrText()}`,
      );
    }
    await Bun.sleep(200);
  }
}

describe('the worker fleet runs the seam', () => {
  test(
    'a free tenant is consolidated and stops at the free-tier line',
    async () => {
      await makeDue('free');
      const run = await waitForFinishedRun();

      // `free_tier` can only be reached through `options.tier === 'free'`, which
      // the handler took from `consolidationTierOf` reading the control-plane
      // row. Nothing else in the cycle can produce it.
      expect(run.stop_reason).toBe('free_tier');
      expect(run.tier).toBe('free');
      expect(Number(run.model_calls)).toBe(0);
      expect(Number(run.spent_micro_usd)).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'the same fleet, the same brain, a paid column: the cycle stops somewhere else',
    async () => {
      await makeDue('paid');
      const run = await waitForFinishedRun();

      // The tier travelled from the column into the cycle. It is read at open
      // time, per cycle — not carried on the job row, which for a queue with a
      // retry ladder can be days out of date by the time the cycle runs.
      expect(run.tier).toBe('paid');
      expect(run.stop_reason).not.toBe('free_tier');
      expect(run.stop_reason).toBe('complete');
      // An empty brain has nothing to send, so a paid cycle costs nothing here.
      // Asserted rather than assumed: a paid path that had started calling
      // models would show up as a number, in a test that may not make one.
      expect(Number(run.model_calls)).toBe(0);
      expect(Number(run.spent_micro_usd)).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'a tenant that is not ready gets no cycle at all',
    async () => {
      await makeDue('free');
      await controlSql`
        UPDATE control.tenant SET state = 'provisioning', ready_at = NULL, schema_version = 0
         WHERE tenant_id = ${TENANT}`;

      // `selectDueTenants` only considers `ready` rows, so nothing is enqueued —
      // and `consolidationTierOf` is the second refusal behind it. Either way the
      // observable is the same and it is the one that matters: a half-built brain
      // is not consolidated.
      await Bun.sleep(2_000);
      expect(await tenantSql`SELECT run_id FROM consolidation_run`).toHaveLength(0);

      await controlSql`
        UPDATE control.tenant
           SET state = 'ready', ready_at = now(), schema_version = ${TENANT_SCHEMA_VERSION}
         WHERE tenant_id = ${TENANT}`;
    },
    SETUP_TIMEOUT_MS,
  );
});
