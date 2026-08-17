/**
 * The authorization store's sweep, driven by the process that actually runs it.
 *
 * **Why this file exists rather than a unit test of the purge.** The purge
 * itself is covered where it lives (`test/mcp/oauth/durable-store.test.ts`:
 * what it deletes, what it keeps, and the retention the revocation arm keeps).
 * What that cannot show is whether *any deployed process ever calls it* — which
 * is the shape `test/worker/export-job.test.ts` already had to close for the
 * export lane, after a capability sat composed-but-unreachable for two units. A
 * sweep nothing calls is a table that only grows, wearing a green test.
 *
 * **It also pins the schema ensure.** The control fixture applies `schema.sql`
 * alone — the live control plane's state — so a worker that boots before any MCP
 * instance ever has finds no `control.oauth_*` tables at all. Without
 * `ensureAuthorizationStoreSchema` in the worker's own startup, the tick below
 * fails on `relation does not exist`, and it fails on every subsequent tick
 * forever. That is why the ensure is in two fleets rather than one, and this is
 * what makes the second one necessary rather than remembered.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQL } from 'bun';

import { startWorkerFleet } from '../../src/worker/serve.ts';
import { REVOCATION_RETENTION_SECONDS } from '../../src/control/oauth-pg.ts';
import { FAKE_CF_ACCOUNT_ID, writeSecretsFile } from '../fleet/fixture.ts';
import { connect, createControlPlane, dropControlPlane, type ControlFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;

const NOW = new Date(Date.UTC(2026, 7, 17, 12, 0, 0));
const TENANT = 't-sweep0000000000000001';
const GRANT = 'g_sweptgrant000000';
const LIVE_GRANT = 'g_livegrant0000000';

/** An envelope the sealing module's shape admits. The bytes are never opened. */
const ENVELOPE = `v1.${'A'.repeat(16)}.${'B'.repeat(40)}`;

let control: ControlFixture;
let controlSql: SQL;
let scratch: string;
let secretsFile: string;

beforeAll(async () => {
  control = await createControlPlane('oauthsweep');
  controlSql = connect(control, 2);
  scratch = mkdtempSync(join(tmpdir(), 'brainz-oauth-sweep-'));
  secretsFile = join(scratch, 'secrets.json');
  await writeSecretsFile(secretsFile, { secrets: {} });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await controlSql?.close();
  if (control !== undefined) await dropControlPlane(control);
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  // Deliberately NOT creating the tables: whether they exist after the fleet
  // starts is half of what this file is asserting.
  await controlSql`DROP TABLE IF EXISTS control.oauth_code`;
  await controlSql`DROP TABLE IF EXISTS control.oauth_refresh`;
  await controlSql`DROP TABLE IF EXISTS control.oauth_client`;
  await controlSql`DROP TABLE IF EXISTS control.oauth_revocation`;
  await controlSql`DROP TABLE IF EXISTS control.oauth_registration`;
  await controlSql`DROP DOMAIN IF EXISTS control.oauth_client_id`;
  await controlSql`DROP DOMAIN IF EXISTS control.oauth_grant_id`;
  await controlSql`DROP DOMAIN IF EXISTS control.oauth_tenant_id`;
  await controlSql`DROP DOMAIN IF EXISTS control.oauth_digest`;
  await controlSql`DROP DOMAIN IF EXISTS control.oauth_envelope`;
});

async function startFleet() {
  return startWorkerFleet({
    PORT: '0',
    BRAINZ_CONTROL_DATABASE_URL: control.dsn,
    BRAINZ_SECRET_BACKEND: 'file',
    BRAINZ_SECRETS_FILE: secretsFile,
    BRAINZ_CF_ACCOUNT_ID: FAKE_CF_ACCOUNT_ID,
    // Long enough that the only tick is the one driven below.
    BRAINZ_WORKER_TICK_MS: '3600000',
  });
}

describe('the running worker fleet is what sweeps the authorization store', () => {
  test(
    'it creates the tables it sweeps, because it may boot before any MCP instance ever has',
    async () => {
      const fleet = await startFleet();
      try {
        const rows = (await controlSql`
          SELECT count(*)::int AS n FROM pg_tables
          WHERE schemaname = 'control' AND tablename LIKE 'oauth\\_%'
        `) as Array<{ n: number }>;
        expect(rows[0]?.n).toBe(5);
      } finally {
        await fleet.stop();
      }
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'one tick of the real entrypoint deletes what has aged out and keeps what has not',
    async () => {
      const fleet = await startFleet();
      try {
        const stale = new Date(NOW.getTime() - 60_000);
        const fresh = new Date(NOW.getTime() + 60_000);
        await controlSql`
          INSERT INTO control.oauth_code (code_digest, sealed, expires_at) VALUES
            (${'a'.repeat(64)}, ${ENVELOPE}, ${stale}),
            (${'b'.repeat(64)}, ${ENVELOPE}, ${fresh})
        `;
        await controlSql`
          INSERT INTO control.oauth_refresh (token_digest, sealed, expires_at) VALUES
            (${'c'.repeat(64)}, ${ENVELOPE}, ${stale}),
            (${'d'.repeat(64)}, ${ENVELOPE}, ${fresh})
        `;
        await controlSql`
          INSERT INTO control.oauth_registration (registration_id, registered_at) VALUES
            (${'e'.repeat(64)}, ${new Date(NOW.getTime() - 2 * 60 * 60 * 1000)}),
            (${'f'.repeat(64)}, ${new Date(NOW.getTime() - 30 * 60 * 1000)})
        `;
        // One revocation far past its own retention, one just inside it. The
        // second is the case that matters: swept on the codes' schedule, a
        // grant the user retired would start working again.
        await controlSql`
          INSERT INTO control.oauth_revocation (tenant_id, grant_id, revoked_at) VALUES
            (${TENANT}, ${GRANT}, ${new Date(NOW.getTime() - (REVOCATION_RETENTION_SECONDS + 60) * 1000)}),
            (${TENANT}, ${LIVE_GRANT}, ${new Date(NOW.getTime() - 60_000)})
        `;

        await fleet.tick(NOW);

        expect(await digests('oauth_code', 'code_digest')).toEqual(['b'.repeat(64)]);
        expect(await digests('oauth_refresh', 'token_digest')).toEqual(['d'.repeat(64)]);
        expect(await digests('oauth_registration', 'registration_id')).toEqual(['f'.repeat(64)]);
        expect(await digests('oauth_revocation', 'grant_id')).toEqual([LIVE_GRANT]);
      } finally {
        await fleet.stop();
      }
    },
    SETUP_TIMEOUT_MS,
  );
});

async function digests(table: string, column: string): Promise<string[]> {
  // Identifiers cannot be parameters; both arguments are literals in this file.
  const rows = (await controlSql.unsafe(
    `SELECT ${column} AS value FROM control.${table} ORDER BY ${column}`,
  )) as unknown as Array<{ value: string }>;
  return rows.map((row) => row.value);
}
