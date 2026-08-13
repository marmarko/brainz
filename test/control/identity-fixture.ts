/**
 * A throwaway **identity** database for the U15 suite.
 *
 * Not a `*.test.ts` file. It is the third of the repo's schema fixtures:
 * `test/schema/fixture.ts` builds tenant databases, `test/worker/fixture.ts`
 * builds the content-free control plane, and this one builds the separate
 * identity + billing store `src/control/account-schema.sql` describes.
 *
 * **It exists as a separate database on purpose**, not as a second schema in the
 * control plane. `src/control/schema.sql` says identity lives in U15's own
 * store, and the whole content-free claim reads better when it is literally
 * true of the database the register names. The cost is that
 * `account.brain.tenant_id` cannot be a foreign key; the benefit is that the two
 * can be deployed, credentialed and rotated apart.
 *
 * It also does for this file what `test/worker/fixture.ts` did for the control
 * plane: something in the blocking tier now executes the DDL, so a syntax error
 * fails a test rather than the first real signup.
 */

import { SQL } from 'bun';

import { ADMIN_DSN } from '../hazards/fixture.ts';

export { ADMIN_DSN };

const ACCOUNT_SCHEMA_PATH = `${import.meta.dir}/../../src/control/account-schema.sql`;

export interface IdentityFixture {
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
  return `brainz_identity_${slug}`;
}

export async function createIdentityStore(slug: string): Promise<IdentityFixture> {
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

  const fixture: IdentityFixture = { dsn: databaseUrlFor(database), database };
  const ddl = await Bun.file(ACCOUNT_SCHEMA_PATH).text();
  const sql = new SQL(fixture.dsn, { max: 1 });
  try {
    await sql.unsafe(ddl);
  } finally {
    await sql.close();
  }
  return fixture;
}

export async function dropIdentityStore(fixture: IdentityFixture): Promise<void> {
  const admin = new SQL(ADMIN_DSN, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${fixture.database} WITH (FORCE)`);
  } finally {
    await admin.close();
  }
}

/** Opens one connection. `max: 1` so lock waits and pool saturation are legible. */
export function connect(fixture: IdentityFixture, max = 1): SQL {
  return new SQL(fixture.dsn, { max });
}

/**
 * Argon2 parameters for tests.
 *
 * Production cost would put ~100ms on every hash and this suite makes dozens.
 * The parameters travel inside the stored hash, so a test-cost hash is still a
 * well-formed one and still exercises the domain's alphabet.
 */
export const TEST_HASH_COST = { memoryCost: 512, timeCost: 1 } as const;
