/**
 * A throwaway **control-plane** database for the U10 job-runner suite.
 *
 * Not a `*.test.ts` file. It is the control plane's analog of
 * `test/schema/fixture.ts`: that one builds tenant databases from
 * `src/schema/tenant.sql`, this one builds the single content-free database
 * `src/control/schema.sql` describes.
 *
 * It also closes a gap `test/control/schema.test.ts` names in its own header:
 * *"nothing in the blocking suite executes this DDL. A Postgres syntax error
 * survives every test here."* From this file on, something does — every job test
 * applies the real control-plane schema to a real Postgres before it asserts
 * anything, so an unbalanced parenthesis or an undeclared type fails the
 * blocking tier rather than the first real provision.
 *
 * Not gated behind a flag, for the same reason U3's fixtures are not: the
 * pgvector service container is always present in the blocking tier, and a lock
 * guard that skips itself is an unheld lock wearing a green tick.
 */

import { SQL } from 'bun';

import { ADMIN_DSN } from '../hazards/fixture.ts';

export { ADMIN_DSN };

const CONTROL_SCHEMA_PATH = `${import.meta.dir}/../../src/control/schema.sql`;

export interface ControlFixture {
  readonly dsn: string;
  readonly database: string;
}

function databaseUrlFor(database: string): string {
  const url = new URL(ADMIN_DSN);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Legal unquoted, unique to one guard, and recognisably ours after a kill. */
export function fixtureDatabaseName(slug: string): string {
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(slug)) throw new Error(`unusable fixture slug: ${slug}`);
  return `brainz_control_${slug}`;
}

/** The control plane, as `src/control/schema.sql` declares it. */
export async function createControlPlane(slug: string): Promise<ControlFixture> {
  const database = fixtureDatabaseName(slug);
  const admin = new SQL(ADMIN_DSN, { max: 1 });
  try {
    // Identifiers cannot be parameters. The name is derived above from a slug
    // matched against an anchored pattern, never from input.
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${database}`);
  } finally {
    await admin.close();
  }

  const fixture: ControlFixture = { dsn: databaseUrlFor(database), database };
  const ddl = await Bun.file(CONTROL_SCHEMA_PATH).text();
  const sql = new SQL(fixture.dsn, { max: 1 });
  try {
    await sql.unsafe(ddl);
  } finally {
    await sql.close();
  }
  return fixture;
}

export async function dropControlPlane(fixture: ControlFixture): Promise<void> {
  const admin = new SQL(ADMIN_DSN, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${fixture.database} WITH (FORCE)`);
  } finally {
    await admin.close();
  }
}

/** Opens one connection. `max: 1` so lock waits and pool saturation are legible. */
export function connect(fixture: ControlFixture, max = 1): SQL {
  return new SQL(fixture.dsn, { max });
}

/**
 * A `ready` tenant, because `control.job` carries a foreign key to one and a
 * queue seeded with tenants that do not exist would be testing a table the
 * production schema refuses to have.
 *
 * The columns set here are the ones the `ready_tenants_are_fully_provisioned`
 * CHECK requires; the scheduling signals default to "nothing has happened yet"
 * and each test moves the ones it is about.
 */
export async function seedTenant(
  sql: SQL,
  tenantId: string,
  signals: {
    readonly pendingDebt?: number;
    readonly lastActivity?: Date | null;
    readonly lastCycleAt?: Date | null;
    readonly nextDueAt?: Date | null;
    readonly state?: 'provisioning' | 'ready' | 'failed' | 'deleting';
  } = {},
): Promise<void> {
  const state = signals.state ?? 'ready';
  const ready = state === 'ready' || state === 'deleting';
  await sql`
    INSERT INTO control.tenant (
      tenant_id, state, tier, schema_version, fts_language,
      neon_project_id, neon_branch_id, neon_database, neon_role,
      connection_secret_ref, bearer_secret_ref, storage_prefix,
      pending_debt, last_activity, last_cycle_at, next_due_at, ready_at
    ) VALUES (
      ${tenantId}, ${state}::control.tenant_state, 'free', ${ready ? 1 : 0}, 'simple',
      ${ready ? `proj-${tenantId}` : null}, ${ready ? `br-${tenantId}` : null},
      ${ready ? 'brainz' : null}, ${ready ? 'brainz_owner' : null},
      ${ready ? `tenant/${tenantId}` : null}, ${ready ? `tenant/${tenantId}` : null},
      ${ready ? `tenants/${tenantId}/` : null},
      ${signals.pendingDebt ?? 0},
      ${signals.lastActivity ?? null},
      ${signals.lastCycleAt ?? null},
      ${signals.nextDueAt ?? null},
      ${ready ? new Date(0) : null}
    )
  `;
}

/** Reads one job row back as the raw record, for assertions about the row. */
export async function readJobRow(sql: SQL, jobId: string): Promise<Record<string, unknown>> {
  const rows = (await sql`
    SELECT * FROM control.job WHERE job_id = ${jobId}::uuid
  `) as unknown as Record<string, unknown>[];
  const row = rows[0];
  if (row === undefined) throw new Error(`no job row ${jobId}`);
  return row;
}

export async function countJobs(sql: SQL, tenantId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS n FROM control.job WHERE tenant_id = ${tenantId}
  `) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
}
