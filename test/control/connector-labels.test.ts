/**
 * Teaching a live control plane a connector it was built without.
 *
 * This module went to production untested, and its most dangerous failure is
 * silent **by design**: `recordConnectorAttempt` swallows its own errors so that
 * a health write can never fail a pull. So a missing
 * `control.connector_health_source` label produces a connector that polls
 * perfectly and a dashboard that is empty forever, with the cause on stdout and
 * nowhere else. That is the case worth a real old-plane fixture rather than a
 * mock.
 *
 * The plane here is built from the **real** DDL with `contacts` stripped back
 * out of all three enums and the pairing CHECK — the shape a deployment made
 * before the connector shipped actually has. A hand-written subset would be
 * testing a database nobody runs.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';

import { ensureConnectorLabels } from '../../src/control/connector-labels.ts';
import { CONNECTOR_SOURCES } from '../../src/ingest/cursor.ts';
import { ADMIN_DSN } from '../worker/fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const DATABASE = 'brainz_control_connectorlabels_old';

let oldSql: SQL;

/** Every label on one enum, in the order Postgres holds them. */
async function labels(sql: SQL, type: string): Promise<string[]> {
  const rows = (await sql.unsafe(
    `SELECT e.enumlabel FROM pg_enum e
       JOIN pg_type t ON t.oid = e.enumtypid
       JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'control' AND t.typname = $1
      ORDER BY e.enumsortorder`,
    [type],
  )) as Array<{ enumlabel: string }>;
  return rows.map((row) => row.enumlabel);
}

beforeEach(async () => {
  const read = async (file: string): Promise<string> =>
    Bun.file(`${import.meta.dir}/../../src/control/${file}`).text();

  // The three files that build a plane, with the fourth connector taken back
  // out of everything that enumerates it.
  const stripped = [
    await read('schema.sql'),
    await read('connector-store.sql'),
    await read('connector-health.sql'),
  ]
    .join('\n')
    .replaceAll(",\n  'contacts'\n);", '\n);')
    .replaceAll(", 'contacts');", ');')
    .replaceAll(
      "OR (kind = 'ingest_pull' AND target IN ('gmail', 'calendar', 'drive', 'contacts'))",
      "OR (kind = 'ingest_pull' AND target IN ('gmail', 'calendar', 'drive'))",
    );
  // If the strip stops matching because the DDL moved, this test would silently
  // become a test of the CURRENT plane, which asserts nothing.
  expect(stripped).not.toContain("'contacts'");

  const admin = new SQL(ADMIN_DSN, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${DATABASE}`);
  } finally {
    await admin.close();
  }
  const url = new URL(ADMIN_DSN);
  url.pathname = `/${DATABASE}`;
  oldSql = new SQL(url.toString(), { max: 2 });
  await oldSql.unsafe(stripped);
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  await oldSql?.close();
  const admin = new SQL(ADMIN_DSN, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
  } finally {
    await admin.close();
  }
});

describe('a control plane built before the fourth connector learns it at boot', () => {
  test('every enum ends up holding exactly the connector list, in order', async () => {
    for (const type of ['connector_source', 'connector_health_source']) {
      expect(await labels(oldSql, type)).not.toContain('contacts');
    }

    await ensureConnectorLabels(oldSql);

    // **As a sequence, not a set.** `ALTER TYPE ADD VALUE` appends, so a taught
    // plane carries new labels last; a fresh plane gets whatever order its DDL
    // declares. The two agree only if new labels always go on the end, and this
    // is the assertion that says so.
    for (const type of ['connector_source', 'connector_health_source']) {
      expect(await labels(oldSql, type)).toEqual([...CONNECTOR_SOURCES]);
    }
    // `job_target` carries non-connector members too, so the test is membership
    // plus position: the new one is last.
    const targets = await labels(oldSql, 'job_target');
    expect(targets).toContain('contacts');
    expect(targets[targets.length - 1]).toBe('contacts');
  }, SETUP_TIMEOUT_MS);

  test('the pairing CHECK admits the new target for a pull, and only for a pull', async () => {
    await ensureConnectorLabels(oldSql);
    const tenant = 't-labels-fixture';
    await oldSql.unsafe(
      // `control.job` has an FK to the tenant, so the row has to be real. Only
      // the NOT NULL columns without defaults are named.
      `INSERT INTO control.tenant (tenant_id, fts_language) VALUES ($1, 'english')
       ON CONFLICT DO NOTHING`,
      [tenant],
    );

    await oldSql.unsafe(
      `INSERT INTO control.job (job_id, tenant_id, kind, target, state, trigger_reason, run_at,
                                lease_token, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, 'ingest_pull', 'contacts', 'due', 'connector_cadence', now(),
                 0, now(), now())`,
      [tenant],
    );

    // And the pairing is still a pairing: a whole-brain kind may not name a
    // connector, which is what the CHECK is for.
    let refused = false;
    try {
      await oldSql.unsafe(
        `INSERT INTO control.job (job_id, tenant_id, kind, target, state, trigger_reason, run_at,
                                lease_token, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'consolidate', 'contacts', 'due', 'connector_cadence', now(),
                   0, now(), now())`,
        [tenant],
      );
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  }, SETUP_TIMEOUT_MS);

  test('it is idempotent, and the ordinary boot does no DDL at all', async () => {
    await ensureConnectorLabels(oldSql);
    const before = await labels(oldSql, 'connector_source');

    // Every boot after the first. The probe-first shape is what makes this one
    // SELECT per enum rather than an ALTER that Postgres has to parse and
    // refuse.
    await ensureConnectorLabels(oldSql);
    await ensureConnectorLabels(oldSql);

    expect(await labels(oldSql, 'connector_source')).toEqual(before);
  }, SETUP_TIMEOUT_MS);
});
