/**
 * The migration sweep, and the scheduled caller it did not have.
 *
 * `control/migrate.ts` shipped `sweepTenantSchemas` with a bound, a per-tenant
 * deadline and failure isolation — and with three ports and no implementation of
 * them, so the only thing that ever swept anything was a test. A fleet of tens
 * of thousands of mostly-suspended databases with a migration runner nothing
 * calls is a fleet that never migrates: every tenant sits behind the code that
 * serves it until somebody notices.
 *
 * **The sweep is not a job, and that is a reading of `worker/jobs.ts` rather
 * than a preference.** The job kinds are fixed at five and a job runs *for* a
 * tenant, under a lease, against that tenant's own brain. Migrating is fleet
 * maintenance — the same class of work as reclaiming a dead worker's lease and
 * stamping a due time on a tenant that has none, both of which the scheduler
 * tick already does directly. So the sweep goes where they are, ahead of the
 * enqueue: a tenant whose schema this fleet cannot read is a tenant whose
 * consolidation cannot run either, and enqueueing it first manufactures work
 * that can only fail and walk a healthy tenant up the retry ladder.
 */

import type { SQL } from 'bun';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  FLEET_SCHEMA_VERSION,
  readTenantSchemaVersion,
  type MigrateResult,
  type SweepCandidate,
  type SweepPorts,
} from '../../src/control/migrate.ts';
import { createSchemaSweepPorts } from '../../src/control/schema-sweep.ts';
import {
  controlPlaneIdentity,
  createInMemorySecretBackend,
  createTenantSecretStore,
  type TenantSecretStore,
} from '../../src/control/secrets.ts';
import { ALPHA_SCHEDULER, runSchedulerTick } from '../../src/worker/scheduler.ts';
import { createJobQueue, type PostgresJobQueue } from '../../src/worker/queue.ts';
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

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 120_000;
const NOW = new Date('2026-08-12T12:00:00Z');
const MINUTE = 60_000;

let control: ControlFixture;
let sql: SQL;
let queue: PostgresJobQueue;
/** Tenant databases left at rung one, the state every suspended tenant is in. */
const tenants: SchemaFixture[] = [];

beforeAll(async () => {
  control = await createControlPlane('schemasweep');
  sql = connectControl(control, 2);
  queue = createJobQueue({ sql });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await sql?.close();
  await dropControlPlane(control);
  for (const tenant of tenants) await dropFixtureDatabase(tenant);
});

beforeEach(async () => {
  await sql`DELETE FROM control.job`;
  await sql`DELETE FROM control.tenant`;
});

/** A `ready` tenant with a real rung-one database and a resolvable secret. */
async function seedBehindTenant(
  secrets: TenantSecretStore,
  tenantId: string,
  slug: string,
  signals: { readonly lastActivity?: Date | null } = {},
): Promise<SchemaFixture> {
  const schema = await provisionFixture(slug, { targetVersion: 1 });
  tenants.push(schema);
  await seedTenant(sql, tenantId, {
    ...(signals.lastActivity === undefined ? {} : { lastActivity: signals.lastActivity }),
  });
  await secrets.put(controlPlaneIdentity(), tenantId, {
    connectionString: schema.dsn,
    bearerGrant: `bearer-${tenantId}`,
  });
  return schema;
}

function newSecrets(): TenantSecretStore {
  return createTenantSecretStore({ backend: createInMemorySecretBackend() });
}

function tickDeps(schemas: SweepPorts) {
  return { sql, queue, config: ALPHA_SCHEDULER, stealGraceMs: 15_000, schemas };
}

describe('the tick is the sweep\'s caller', () => {
  test(
    'every tick sweeps, at the tick\'s own bound, and reports what it did',
    async () => {
      const visited: number[] = [];
      const migrated: string[] = [];
      const recording: SweepPorts = {
        listBehind: (limit) => {
          visited.push(limit);
          return Promise.resolve([
            { tenantId: 'behind-1', schemaVersion: 1, ftsLanguage: 'simple' },
          ]);
        },
        migrate: (candidate: SweepCandidate): Promise<MigrateResult> => {
          migrated.push(candidate.tenantId);
          return Promise.resolve({ from: 1, to: FLEET_SCHEMA_VERSION, applied: [FLEET_SCHEMA_VERSION] });
        },
        recordSchemaVersion: () => Promise.resolve(),
      };

      const result = await runSchedulerTick(tickDeps(recording), { now: NOW });

      // The claim this pins is "it is called now", which is exactly the claim
      // that passes without being true: the port has to have been *asked*, at
      // the configured bound, and the outcome has to come back out of the tick
      // rather than being swallowed inside it.
      expect(visited).toEqual([ALPHA_SCHEDULER.schemaSweepLimit]);
      expect(migrated).toEqual(['behind-1']);
      expect(result.schemas).toEqual([
        { tenantId: 'behind-1', from: 1, to: FLEET_SCHEMA_VERSION, status: 'migrated' },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'migrates a real tenant to the fleet\'s head and banks the version',
    async () => {
      const secrets = newSecrets();
      const behind = await seedBehindTenant(secrets, 'sweep-real', 'sweeprealone');
      const ports = createSchemaSweepPorts({ control: sql, secrets });

      const result = await runSchedulerTick(tickDeps(ports), { now: NOW });

      expect(result.schemas).toEqual([
        { tenantId: 'sweep-real', from: 1, to: FLEET_SCHEMA_VERSION, status: 'migrated' },
      ]);

      // The tenant database is the truth …
      const tenantSql = connectTenant(behind);
      try {
        expect(await readTenantSchemaVersion(tenantSql)).toBe(FLEET_SCHEMA_VERSION);
      } finally {
        await tenantSql.close();
      }

      // … and the control-plane row is the index the next sweep reads.
      const rows = (await sql`
        SELECT schema_version FROM control.tenant WHERE tenant_id = 'sweep-real'
      `) as unknown as { schema_version: number }[];
      expect(rows[0]?.schema_version).toBe(FLEET_SCHEMA_VERSION);

      // Idempotent: a second tick has nothing to do and does not re-bank.
      const again = await runSchedulerTick(tickDeps(ports), { now: new Date(NOW.getTime() + MINUTE) });
      expect(again.schemas).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the ports the sweep is given', () => {
  test(
    'list the tenants behind the fleet, warmest first, and stop at the bound',
    async () => {
      const secrets = newSecrets();
      await seedBehindTenant(secrets, 'warm-recent', 'sweepwarm', {
        lastActivity: new Date(NOW.getTime() - MINUTE),
      });
      await seedBehindTenant(secrets, 'warm-older', 'sweepolder', {
        lastActivity: new Date(NOW.getTime() - 60 * MINUTE),
      });
      await seedBehindTenant(secrets, 'never-used', 'sweepnever', { lastActivity: null });

      const ports = createSchemaSweepPorts({ control: sql, secrets });
      const candidates = await ports.listBehind(2);

      // Warm-compute-opportunistic, which is the whole reason the order is not
      // arbitrary: a tenant that was active a minute ago is almost certainly
      // still awake, so migrating it costs a query rather than a wake. The bound
      // is passed to the query — a sweep that read the fleet and then sliced it
      // would have woken the fleet to decide it did not need to.
      expect(candidates.map((c) => c.tenantId)).toEqual(['warm-recent', 'warm-older']);
      expect(candidates[0]?.ftsLanguage).toBe('simple');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'report the tenant whose secret will not resolve, and keep going',
    async () => {
      const secrets = newSecrets();
      // Two tenants, one of which the fleet identity cannot open. The ordinary
      // reason a sweep meets one of these is a rotation mid-flight, and it must
      // not cost every tenant behind it in the batch their migration.
      await seedBehindTenant(secrets, 'has-secret', 'sweepsecret', {
        lastActivity: new Date(NOW.getTime() - MINUTE),
      });
      await seedTenant(sql, 'no-secret', { lastActivity: new Date(NOW.getTime() - 2 * MINUTE) });

      const ports = createSchemaSweepPorts({ control: sql, secrets });
      const result = await runSchedulerTick(tickDeps(ports), { now: NOW });

      const byTenant = new Map(result.schemas.map((outcome) => [outcome.tenantId, outcome]));
      expect(byTenant.get('no-secret')?.status).toBe('failed');
      expect(byTenant.get('has-secret')?.status).toBe('migrated');
    },
    TEST_TIMEOUT_MS,
  );
});
