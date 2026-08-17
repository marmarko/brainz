/**
 * A tenant provisioned by the web fleet, resolved by the MCP fleet.
 *
 * **This is the deployment's own failure, reproduced.** Signup works, consent
 * works, the code redeems — and `POST /token` answers `{"error":"invalid_grant"}`
 * with no description, which is the arm at `src/mcp/server.ts` where the *code*
 * was fine and `deps.secrets.resolve` came back empty. The MCP fleet could not
 * see a tenant the web fleet had provisioned seconds earlier.
 *
 * **Why no in-process test could catch it.** Every other suite composes one
 * store and asserts a round trip through it, which passes for any backend that
 * can hold a value in memory. The property that broke is not "a store returns
 * what it was given": it is *a writer in one process and a reader in another
 * agree*, and only two processes can express that. So this file spawns both
 * fleets, exactly as `wrangler` runs them, and asserts across the gap.
 *
 * **Each fleet gets its own secrets file, because that is what the image
 * produces.** The Dockerfile's `fleet-bootstrap` materialises
 * `BRAINZ_SECRETS_JSON` into a fresh `mktemp -d` at every container start; there
 * is no shared volume on Cloudflare Containers. Two files with the same initial
 * content is not a test artefact — it is the deployment, written down.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';

import {
  createTenantSecretStore,
  fleetIdentity,
  poolNamespace,
} from '../../src/control/secrets.ts';
import {
  createPostgresSecretStore,
  ensureSecretStoreSchema,
  type PostgresSecretStore,
} from '../../src/control/secret-pg.ts';
import { importSealingKey } from '../../src/control/sealed.ts';
import { createControlPlane, dropControlPlane, type ControlFixture } from '../worker/fixture.ts';
import {
  createIdentityStore,
  dropIdentityStore,
  type IdentityFixture,
} from '../control/identity-fixture.ts';
import { createEmptyDatabase, dropFixtureDatabase, type SchemaFixture } from '../schema/fixture.ts';
import {
  FAKE_CF_ACCOUNT_ID,
  FAKE_SEALING_KEY,
  startService,
  writeSecretsFile,
  type RunningService,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const WEB_ORIGIN = 'https://app.brainz.test';
const ISSUER_HOST = 'mcp.brainz.test';
const POOL_ID = 'pool-0000000000000002';
const CHOSEN_LANGUAGE = 'simple';
const PASSWORD = 'correct horse battery staple';

let control: ControlFixture;
let identity: IdentityFixture;
let poolProject: SchemaFixture;
let controlSql: SQL;
let scratch: string;
/** The web container's copy. The writer's. */
let webSecretsFile: string;
/** The MCP container's copy. Same bytes at start, and never written to again. */
let mcpSecretsFile: string;
/** The operator's own handle on the durable store — how a pool filler writes. */
let durable: PostgresSecretStore;
const running: RunningService[] = [];

beforeAll(async () => {
  control = await createControlPlane('crossfleet');
  identity = await createIdentityStore('crossfleet');
  poolProject = await createEmptyDatabase('crossfleetpool');
  controlSql = new SQL(control.dsn, { max: 2 });

  // The control plane this fixture built came from `schema.sql`, which is
  // exactly the state of the live one: no secret store until something creates
  // it. `ensureSecretStoreSchema` is what a fleet runs at start.
  await ensureSecretStoreSchema(controlSql);
  durable = createPostgresSecretStore({
    sql: controlSql,
    key: await importSealingKey(FAKE_SEALING_KEY),
  });

  scratch = mkdtempSync(join(tmpdir(), 'brainz-crossfleet-'));
  webSecretsFile = join(scratch, 'web-secrets.json');
  mcpSecretsFile = join(scratch, 'mcp-secrets.json');
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  for (const service of running) await service.stop();
  await controlSql?.close();
  if (control !== undefined) await dropControlPlane(control);
  if (identity !== undefined) await dropIdentityStore(identity);
  if (poolProject !== undefined) await dropFixtureDatabase(poolProject);
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

async function start(entry: string, env: Record<string, string>): Promise<RunningService> {
  const service = await startService({ entry, env });
  running.push(service);
  return service;
}

/**
 * The state a deploy leaves behind: one warm pool project, and the same snapshot
 * in every container's copy of the store.
 */
async function reset(): Promise<void> {
  await controlSql`DELETE FROM control.tenant`;
  await controlSql`DELETE FROM control.pool_project`;
  await controlSql`
    INSERT INTO control.pool_project (
      pool_id, state, neon_project_id, neon_branch_id, neon_database, neon_role,
      connection_secret_ref, created_at, ready_at
    ) VALUES (
      ${POOL_ID}, 'ready', 'proj-pool-2', 'br-pool-2', 'brainz', 'brainz_owner',
      ${poolNamespace(POOL_ID)}, now(), now()
    )`;

  const snapshot = {
    secrets: { [poolNamespace(POOL_ID)]: { connectionString: poolProject.dsn, bearerGrant: '' } },
  };
  await writeSecretsFile(webSecretsFile, snapshot);
  await writeSecretsFile(mcpSecretsFile, snapshot);

  // The same pool entry in the durable store, written the way a filler writes
  // one. A pool project is created out of band and its connection string has to
  // outlive the process that made it, which is the smaller version of the same
  // property this file is about.
  await durable.secrets.put(poolNamespace(POOL_ID), {
    connectionString: poolProject.dsn,
    bearerGrant: '',
  });
}

interface SignedUp {
  readonly tenantId: string;
}

/** A stranger signs up through the running web process, and gets a brain. */
async function signUp(web: RunningService, email: string): Promise<SignedUp> {
  const response = await fetch(`${web.url}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD, fts_language: CHOSEN_LANGUAGE }),
  });
  expect(response.status).toBe(201);

  const rows = await controlSql<{ tenant_id: string; state: string }[]>`
    SELECT tenant_id, state::text AS state FROM control.tenant`;
  expect(rows).toHaveLength(1);
  expect(rows[0]?.state).toBe('ready');
  return { tenantId: rows[0]?.tenant_id ?? '' };
}

/** The tool call a connector makes. The whole point of the deployment. */
async function recall(mcp: RunningService, bearer: string): Promise<Response> {
  return fetch(`${mcp.url}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'recall', arguments: { query: 'anything at all' } },
    }),
  });
}

function webEnv(extra: Record<string, string>): Record<string, string> {
  return {
    BRAINZ_WEB_ORIGIN: WEB_ORIGIN,
    BRAINZ_IDENTITY_DATABASE_URL: identity.dsn,
    BRAINZ_CONTROL_DATABASE_URL: control.dsn,
    BRAINZ_CF_ACCOUNT_ID: FAKE_CF_ACCOUNT_ID,
    BRAINZ_MCP_URL: `https://${ISSUER_HOST}/mcp`,
    BRAINZ_STRIPE_WEBHOOK_SECRET: 'whsec_this_test_invented_it',
    BRAINZ_POOL_TARGET: '1',
    ...extra,
  };
}

function mcpEnv(extra: Record<string, string>): Record<string, string> {
  return {
    BRAINZ_PUBLIC_ORIGIN: `https://${ISSUER_HOST}`,
    BRAINZ_CONTROL_DATABASE_URL: control.dsn,
    BRAINZ_CF_ACCOUNT_ID: FAKE_CF_ACCOUNT_ID,
    ...extra,
  };
}

beforeEach(reset);

describe('the file backend cannot serve a two-container deployment', () => {
  test(
    'a tenant the web fleet provisions is invisible to the MCP fleet',
    async () => {
      const web = await start(
        'src/web/serve.ts',
        webEnv({ BRAINZ_SECRET_BACKEND: 'file', BRAINZ_SECRETS_FILE: webSecretsFile }),
      );
      const mcp = await start(
        'src/mcp/serve.ts',
        mcpEnv({ BRAINZ_SECRET_BACKEND: 'file', BRAINZ_SECRETS_FILE: mcpSecretsFile }),
      );

      const { tenantId } = await signUp(web, 'filebacked@example.com');

      // The writer's own copy has it. The reader's does not, and never will:
      // nothing writes through, and on Cloudflare Containers nothing can.
      const stored = (await Bun.file(webSecretsFile).json()) as {
        secrets: Record<string, { bearerGrant: string }>;
      };
      const bearer = stored.secrets[`tenant/${tenantId}`]?.bearerGrant ?? '';
      expect(bearer.length).toBeGreaterThan(0);

      const answered = await recall(mcp, bearer);

      // **This is the bug, asserted rather than described.** A real bearer,
      // minted by this deployment, for a tenant whose brain exists and whose
      // control-plane row says `ready` — and the fleet that serves connectors
      // answers the 401 that starts discovery, because it cannot resolve the
      // secret. `/token` answers the same fact as `invalid_grant`.
      expect(answered.status).toBe(401);
      expect(await answered.json()).toEqual({ error: 'unauthorized' });

      await web.stop();
      await mcp.stop();
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('the durable backend is shared by both fleets', () => {
  test(
    'a tenant the web fleet provisions is resolvable by an MCP fleet that holds no secrets file',
    async () => {
      const web = await start(
        'src/web/serve.ts',
        webEnv({
          BRAINZ_SECRET_BACKEND: 'postgres',
          BRAINZ_SECRET_ENCRYPTION_KEY: FAKE_SEALING_KEY,
        }),
      );
      // No `BRAINZ_SECRETS_FILE` at all, and no `BRAINZ_SECRETS_JSON` behind
      // it. This process has never been told about any tenant.
      const mcp = await start(
        'src/mcp/serve.ts',
        mcpEnv({
          BRAINZ_SECRET_BACKEND: 'postgres',
          BRAINZ_SECRET_ENCRYPTION_KEY: FAKE_SEALING_KEY,
        }),
      );

      const { tenantId } = await signUp(web, 'durable@example.com');

      // A THIRD store instance, in this process, over its own connection: the
      // operator's view. It reads what the web fleet wrote, which is already
      // the cross-process property, and hands us the bearer to present.
      const reader = new SQL(control.dsn, { max: 1 });
      try {
        const backend = createPostgresSecretStore({
          sql: reader,
          key: await importSealingKey(FAKE_SEALING_KEY),
        });
        const store = createTenantSecretStore({ backend: backend.secrets });
        const resolved = await store.resolve(fleetIdentity(tenantId), tenantId);
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) throw new Error(`unresolvable: ${resolved.reason}`);
        expect(resolved.secret.connectionString).toBe(poolProject.dsn);

        const answered = await recall(mcp, resolved.secret.bearerGrant);
        expect(answered.status).toBe(200);
        const body = (await answered.json()) as { result?: { isError?: boolean } };
        expect(body.result).toBeDefined();
        expect(body.result?.isError).toBeUndefined();
      } finally {
        await reader.close();
      }

      await web.stop();
      await mcp.stop();
    },
    SETUP_TIMEOUT_MS,
  );
});
