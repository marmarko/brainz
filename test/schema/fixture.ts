/**
 * Throwaway tenant databases for the U3 schema suite.
 *
 * Not a `*.test.ts` file, and deliberately separate from
 * `test/hazards/fixture.ts`: that one owns the 5,000-chunk retrieval corpus the
 * three porting hazards are measured against, and nothing here needs it. What
 * the two share is the DSN convention — CI's service container publishes 5432
 * and a local container on another port is selected by exporting
 * `DATABASE_URL` — so that is imported rather than written down twice.
 *
 * These tests are **not** gated behind a flag. The pgvector service container is
 * always present in the blocking tier (`.github/workflows/ci.yml`), and a schema
 * guard that skips itself is an unapplied schema wearing a green tick.
 */

import { SQL } from 'bun';

import { ADMIN_DSN } from '../hazards/fixture.ts';
import { applyFtsLanguage, createTenantSchemaApplier, readTenantDdl } from '../../src/schema/apply.ts';

export { ADMIN_DSN };

/**
 * Deliberately not English. KTD9 forbids an English-default silent fallback, so
 * every fixture in this directory is provisioned in a configuration that would
 * expose one: if a `to_tsvector` call anywhere in the schema quietly says
 * `english`, a test reading the catalog sees it.
 */
export const FIXTURE_FTS_LANGUAGE = 'simple';

export interface SchemaFixture {
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
  return `brainz_schema_${slug}`;
}

/** The state a Neon project is in after `createRoleAndDatabase`: empty. */
export async function createEmptyDatabase(slug: string): Promise<SchemaFixture> {
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
  return { dsn: databaseUrlFor(database), database };
}

export async function dropFixtureDatabase(fixture: SchemaFixture): Promise<void> {
  const admin = new SQL(ADMIN_DSN, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${fixture.database} WITH (FORCE)`);
  } finally {
    await admin.close();
  }
}

/**
 * A tenant database at the schema version the fleet ships — through the real
 * provisioning applier, because a schema guard that applies the DDL its own way
 * is guarding a path production does not take.
 *
 * `targetVersion` pins the ladder partway up. Every migration test needs a
 * database at the version *before* the one under test, and once provisioning
 * applies the baseline and then migrates to head there is no other way to get
 * one.
 */
export async function provisionFixture(
  slug: string,
  options: { readonly targetVersion?: number } = {},
): Promise<SchemaFixture> {
  const fixture = await createEmptyDatabase(slug);
  const applier = createTenantSchemaApplier(
    options.targetVersion === undefined ? {} : { targetVersion: options.targetVersion },
  );
  await applier.apply({ connectionString: fixture.dsn, ftsLanguage: FIXTURE_FTS_LANGUAGE });
  return fixture;
}

/**
 * A **legacy** rung-one tenant: the DDL applied straight, with no ledger table
 * and no recorded version — which is exactly what every tenant provisioned
 * before the migration runner existed looks like.
 *
 * Built by hand rather than through the applier on purpose. The applier now
 * writes a ledger row, so it can no longer produce this state, and this state is
 * the one the runner has to recognise or it replays rung one over a live brain.
 */
export async function provisionLegacyV1(slug: string): Promise<SchemaFixture> {
  const fixture = await createEmptyDatabase(slug);
  const ddl = applyFtsLanguage(await readTenantDdl(), FIXTURE_FTS_LANGUAGE);
  const sql = new SQL(fixture.dsn, { max: 1 });
  try {
    await sql.unsafe(ddl);
  } finally {
    await sql.close();
  }
  return fixture;
}

/** Opens one connection. `max: 1` so `SET LOCAL` and advisory locks are legible. */
export function connect(fixture: SchemaFixture): SQL {
  return new SQL(fixture.dsn, { max: 1 });
}

/** The SQLSTATE Bun surfaces on `errno`, so a test can assert the code not the prose. */
export function sqlstateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const errno = (error as { errno?: unknown }).errno;
  return typeof errno === 'string' ? errno : undefined;
}

/**
 * Runs `statements` and returns the SQLSTATE of the first failure, or
 * `undefined` if all of them succeeded. Used by the guards that assert a write
 * is *refused* — the code is the assertion, the message is commentary.
 */
export async function sqlstateOfFailure(sql: SQL, statement: string): Promise<string | undefined> {
  try {
    await sql.unsafe(statement);
    return undefined;
  } catch (error) {
    const state = sqlstateOf(error);
    if (state === undefined) throw error;
    return state;
  }
}
