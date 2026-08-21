/**
 * The connector path, through the process that serves it.
 *
 * **What this is defending, and why it has to be a spawned process.** The
 * failure it replaces was not a broken function — `createPipedreamClient` was
 * complete and had its own passing suite. It was a **composition**:
 * `src/web/serve.ts` handed `createWebApp` a `ConnectorVendor` whose two methods
 * threw a bare `Error`, and no test in the repo composed the entrypoint. A test
 * that builds `createWebApp` with a fake vendor proves the handler calls a port;
 * it cannot prove a deployed process has one. So this drives the real
 * entrypoint, over HTTP, with the four `BRAINZ_PIPEDREAM_*` variables pointed at
 * a local double — and asserts that the request reached the *vendor's* token
 * endpoint carrying the right scope.
 *
 * **The double is a loopback server, not a mock.** `fetchTransport` is the
 * production transport and it is what the process composes; pointing
 * `BRAINZ_PIPEDREAM_API_BASE` at `127.0.0.1` is the only way to exercise it
 * without reaching the vendor. That is why the base is configuration at all —
 * the same reason Stripe's and Neon's are.
 *
 * **It is also the founder's unblock, end to end.** Billing is inert on this
 * deployment (a placeholder webhook secret, no checkout trio), so no account can
 * become paid through Stripe and the connector gate refuses everyone. The
 * sequence below — sign up, grant the tier through `/admin`, connect — is the
 * runbook, executed.
 *
 * Every credential here is an obvious fake: this repository is public and
 * gitleaks runs on every push.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';

import { poolNamespace } from '../../src/control/secrets.ts';
import { createPostgresSecretStore } from '../../src/control/secret-pg.ts';
import { importSealingKey } from '../../src/control/sealed.ts';
import { spawnArgv } from './fixture.ts';
import {
  createControlPlane,
  dropControlPlane,
  type ControlFixture,
} from '../worker/fixture.ts';
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
const TEST_TIMEOUT_MS = 60_000;
const WEB_ORIGIN = 'https://app.brainz.test';
const ADMIN_CREDENTIAL = 'bzadm-this-test-invented-it';
const POOL_ID = 'pool-0000000000000002';

/** The vendor's two credentials, as this test invented them. */
const PIPEDREAM = {
  projectId: 'proj_this_test_invented_it',
  clientId: 'not-a-real-pipedream-client-id',
  clientSecret: 'not-a-real-pipedream-client-secret',
} as const;

let control: ControlFixture;
let identity: IdentityFixture;
let poolProject: SchemaFixture;
let controlSql: SQL;
let identitySql: SQL;
let scratch: string;
let secretsFile: string;
let web: RunningService;
let vendor: VendorDouble;
/**
 * External user ids the vendor double reports an attached account for.
 *
 * A module-level switch rather than a per-call script, because what turns it on
 * is a user finishing a consent screen at a third party — an event this side
 * never observes, which is the whole reason reconciliation exists.
 */
let attachedAccounts: string[] = [];

// ---------------------------------------------------------------------------
// The vendor, on loopback.
// ---------------------------------------------------------------------------

interface VendorCall {
  readonly method: string;
  readonly path: string;
  /** The query string, because the accounts listing carries its scope there. */
  readonly query: string;
  readonly authorization: string | null;
  readonly body: string;
}

interface VendorDouble {
  readonly base: string;
  /** Cleared between cases, so a case can assert "nothing was dialled". */
  readonly calls: VendorCall[];
  /**
   * Never cleared. The client caches its access token for the vendor's stated
   * lifetime, so the OAuth mint happens once per process — a per-case view
   * cannot see it, and asserting on where the client secret travelled needs
   * every request this process ever made.
   */
  readonly everything: VendorCall[];
  stop(): Promise<void>;
}

/**
 * Enough of the vendor to answer a mint: an OAuth token endpoint and the connect
 * token endpoint. Every request is recorded, because what this file asserts is
 * *what the process sent*, not what it answered.
 */
function startVendorDouble(): VendorDouble {
  const calls: VendorCall[] = [];
  const everything: VendorCall[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.text() : '';
      const call: VendorCall = {
        method: request.method,
        path: url.pathname,
        query: url.search,
        authorization: request.headers.get('authorization'),
        body,
      };
      calls.push(call);
      everything.push(call);

      if (url.pathname.endsWith('/oauth/token')) {
        return Response.json({ access_token: 'vendor-access-token', expires_in: 3600 });
      }
      if (url.pathname.endsWith('/tokens')) {
        return Response.json({
          token: 'ctok_from_the_double',
          expires_at: new Date(Date.now() + 600_000).toISOString(),
          connect_link_url: 'https://connect.example.test/start?token=ctok_from_the_double',
        });
      }
      // The accounts listing — the channel through which this fleet learns that
      // a consent screen was completed. It answers whatever the case in flight
      // set, defaulting to nothing attached, which is what the vendor really
      // does answer for an external user still at the consent screen.
      if (url.pathname.endsWith('/accounts')) {
        return Response.json({
          page_info: { total_count: attachedAccounts.length, count: attachedAccounts.length },
          data: attachedAccounts.map((external) => ({
            id: 'apn_from_the_double',
            external_id: external,
            app: { name_slug: 'gmail' },
            healthy: true,
            dead: false,
            created_at: new Date().toISOString(),
          })),
        });
      }
      return Response.json({ error: 'no rule' }, { status: 404 });
    },
  });

  return {
    base: `http://127.0.0.1:${server.port}/v1`,
    calls,
    everything,
    async stop() {
      await server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------

function webEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    BRAINZ_WEB_ORIGIN: WEB_ORIGIN,
    BRAINZ_IDENTITY_DATABASE_URL: identity.dsn,
    BRAINZ_CONTROL_DATABASE_URL: control.dsn,
    BRAINZ_SECRET_BACKEND: 'file',
    BRAINZ_SECRETS_FILE: secretsFile,
    BRAINZ_CF_ACCOUNT_ID: FAKE_CF_ACCOUNT_ID,
    BRAINZ_MCP_URL: 'https://mcp.brainz.test/mcp',
    BRAINZ_STRIPE_WEBHOOK_SECRET: 'whsec_this_test_invented_it',
    BRAINZ_ADMIN_CREDENTIAL: ADMIN_CREDENTIAL,
    BRAINZ_POOL_TARGET: '1',
    ...overrides,
  };
}

function configured(): Record<string, string> {
  return webEnv({
    BRAINZ_PIPEDREAM_PROJECT_ID: PIPEDREAM.projectId,
    BRAINZ_PIPEDREAM_CLIENT_ID: PIPEDREAM.clientId,
    BRAINZ_PIPEDREAM_CLIENT_SECRET: PIPEDREAM.clientSecret,
    BRAINZ_PIPEDREAM_ENVIRONMENT: 'development',
    BRAINZ_PIPEDREAM_API_BASE: vendor.base,
  });
}

beforeAll(async () => {
  control = await createControlPlane('connectorflow');
  identity = await createIdentityStore('connectorflow');
  poolProject = await createEmptyDatabase('connectorpool');
  controlSql = new SQL(control.dsn, { max: 2 });
  identitySql = new SQL(identity.dsn, { max: 2 });

  scratch = mkdtempSync(join(tmpdir(), 'brainz-connectors-'));
  secretsFile = join(scratch, 'secrets.json');
  vendor = startVendorDouble();

  web = await startService({ entry: 'src/web/serve.ts', env: configured() });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await web?.stop();
  await vendor?.stop();
  await controlSql?.close();
  await identitySql?.close();
  if (control !== undefined) await dropControlPlane(control);
  if (identity !== undefined) await dropIdentityStore(identity);
  if (poolProject !== undefined) await dropFixtureDatabase(poolProject);
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

/** The pool, filled the way a filler fills it: a ready row and a stored string. */
async function fillPool(): Promise<void> {
  await controlSql`DELETE FROM control.pool_project`;
  await controlSql`
    INSERT INTO control.pool_project (
      pool_id, state, neon_project_id, neon_branch_id, neon_database, neon_role,
      connection_secret_ref, created_at, ready_at
    ) VALUES (
      ${POOL_ID}, 'ready', 'proj-pool-2', 'br-pool-2', 'brainz', 'brainz_owner',
      ${poolNamespace(POOL_ID)}, now(), now()
    )`;
  await writeSecretsFile(secretsFile, {
    secrets: { [poolNamespace(POOL_ID)]: { connectionString: poolProject.dsn, bearerGrant: '' } },
  });
}

beforeEach(async () => {
  await identitySql`DELETE FROM account.account`;
  await controlSql`DELETE FROM control.job`;
  await controlSql`DELETE FROM control.tenant`;
  vendor.calls.length = 0;
  attachedAccounts = [];
  await fillPool();
});

async function signUp(email: string): Promise<string> {
  const response = await fetch(`${web.url}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
    body: JSON.stringify({
      email,
      password: 'correct horse battery staple',
      fts_language: 'simple',
    }),
  });
  if (response.status !== 201) throw new Error(`fixture: signup answered ${response.status}`);
  return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function tenantId(): Promise<string> {
  const rows = await controlSql<{ tenant_id: string }[]>`SELECT tenant_id FROM control.tenant`;
  const found = rows[0]?.tenant_id;
  if (found === undefined) throw new Error('fixture: no tenant');
  return found;
}

function connect(cookie: string, source = 'gmail'): Promise<Response> {
  return fetch(`${web.url}/api/connectors`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, cookie },
    body: JSON.stringify({ source }),
  });
}

/**
 * The operator's own command, as a runbook line: a POST, a bearer credential,
 * and an `Origin` the app's CSRF check accepts. Written out here rather than
 * hidden in a helper file, because "how is it invoked" is half of what this
 * grant has to answer.
 */
function grant(tenant: string, operation = 'grant_internal_tier'): Promise<Response> {
  return fetch(`${web.url}/admin?op=${operation}&tenant_id=${tenant}`, {
    method: 'POST',
    headers: { origin: WEB_ORIGIN, authorization: `Bearer ${ADMIN_CREDENTIAL}` },
  });
}

describe('the founder gets past their own paywall and connects a source', () => {
  test(
    'sign up, grant the tier, and the connect route answers with the vendor’s link',
    async () => {
      const cookie = await signUp('founder@example.com');
      const tenant = await tenantId();

      // Billing is inert on this deployment, so this is the refusal every
      // account gets forever without the grant.
      expect((await connect(cookie)).status).toBe(402);

      const granted = await grant(tenant);
      expect(granted.status).toBe(200);

      const connected = await connect(cookie);
      expect(connected.status).toBe(200);
      const body = (await connected.json()) as { ok: boolean; claim_url: string };
      expect(body.ok).toBe(true);
      // The link the *vendor* answered, carried through — not one this process
      // invented, which would attach nothing and report that it had.
      expect(body.claim_url).toContain('ctok_from_the_double');
      expect(new URL(body.claim_url).searchParams.get('app')).toBe('gmail');

      // And what the process actually sent: an OAuth mint against the client
      // credentials, then a connect token scoped to this tenant's own external
      // user for this source.
      const paths = vendor.calls.map((call) => call.path);
      expect(paths.some((path) => path.endsWith('/oauth/token'))).toBe(true);
      const mint = vendor.calls.find((call) => call.path.endsWith('/tokens'));
      expect(mint?.path).toContain(PIPEDREAM.projectId);
      expect(JSON.parse(mint?.body ?? '{}').external_user_id).toBe(`${tenant}-gmail`);
      // The bearer is the minted access token, not the client secret.
      expect(mint?.authorization).toBe('Bearer vendor-access-token');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the client secret never leaves in a URL, only in the token request’s body',
    async () => {
      const cookie = await signUp('secrets@example.com');
      await grant(await tenantId());
      await connect(cookie);

      for (const call of vendor.everything) {
        expect(call.path).not.toContain(PIPEDREAM.clientSecret);
        expect(call.authorization ?? '').not.toContain(PIPEDREAM.clientSecret);
      }
      const token = vendor.everything.find((call) => call.path.endsWith('/oauth/token'));
      // In the body, where a proxy's access log does not reach it.
      expect(token?.body ?? '').toContain(PIPEDREAM.clientSecret);
      // And exactly once for the life of the process: the access token is cached
      // and paced, so a connect does not re-mint one per user.
      expect(vendor.everything.filter((call) => call.path.endsWith('/oauth/token'))).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an ordinary user cannot issue the grant, and the tier does not move',
    async () => {
      const cookie = await signUp('ordinary@example.com');
      const tenant = await tenantId();

      // A real session, the app's own origin, the exact operation — and no
      // operator credential, which is the only thing `/admin` authenticates on.
      const attempted = await fetch(
        `${web.url}/admin?op=grant_internal_tier&tenant_id=${tenant}`,
        { method: 'POST', headers: { origin: WEB_ORIGIN, cookie } },
      );
      expect(attempted.status).toBe(401);

      const rows = await controlSql<{ tier: string }[]>`
        SELECT tier::text AS tier FROM control.tenant WHERE tenant_id = ${tenant}`;
      expect(rows[0]?.tier).toBe('free');
      expect((await connect(cookie)).status).toBe(402);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the grant is visible afterwards, through the surface that issued it',
    async () => {
      await signUp('visible@example.com');
      const tenant = await tenantId();
      await grant(tenant);

      const status = await fetch(`${web.url}/admin?op=tenant_status&tenant_id=${tenant}`, {
        headers: { authorization: `Bearer ${ADMIN_CREDENTIAL}` },
      });
      const body = (await status.json()) as { content: { tier: string } };
      // `internal` rather than `paid`: a comp that recorded itself as a
      // subscription would be indistinguishable from one the vendor granted.
      expect(body.content.tier).toBe('internal');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The other two configuration states.
// ---------------------------------------------------------------------------

describe('a deployment with no connector vendor', () => {
  let bare: RunningService;

  beforeAll(async () => {
    // No `BRAINZ_PIPEDREAM_*` at all — which is what this fleet ran until today,
    // and what a self-hoster who never connects one runs forever.
    bare = await startService({ entry: 'src/web/serve.ts', env: webEnv() });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await bare?.stop();
  });

  test(
    'starts, serves signup, and refuses the connector route in a way that says why',
    async () => {
      const response = await fetch(`${bare.url}/api/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
        body: JSON.stringify({
          email: 'selfhost@example.com',
          password: 'correct horse battery staple',
          fts_language: 'simple',
        }),
      });
      expect(response.status).toBe(201);
      const cookie = (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

      const tenant = await tenantId();
      await fetch(`${bare.url}/admin?op=grant_internal_tier&tenant_id=${tenant}`, {
        method: 'POST',
        headers: { origin: WEB_ORIGIN, authorization: `Bearer ${ADMIN_CREDENTIAL}` },
      });

      const connected = await fetch(`${bare.url}/api/connectors`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, cookie },
        body: JSON.stringify({ source: 'gmail' }),
      });

      // 501 rather than the 500 a throwing stub produced, and rather than the
      // 402 that would ask a paid-up user to pay again.
      expect(connected.status).toBe(501);
      expect(await connected.json()).toMatchObject({ ok: false, code: 'unavailable' });
      // Nothing was dialled: the refusal is composition, not a failed call.
      expect(vendor.calls).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a partially configured connector vendor', () => {
  /**
   * The state the "all four or none" rule exists for. An operator who set three
   * variables meant to have connectors; a `501 unavailable` would tell them they
   * had not configured one, and a silent start would reach the vendor with an
   * empty credential and report the refusal as an outage.
   */
  test(
    'refuses to start, names the missing variable, and never reports listening',
    async () => {
      const env = configured();
      delete (env as Record<string, string | undefined>)['BRAINZ_PIPEDREAM_CLIENT_SECRET'];

      const proc = Bun.spawn([...spawnArgv('src/web/serve.ts')], {
        cwd: `${import.meta.dir}/../..`,
        env: { PATH: process.env['PATH'] ?? '', PORT: '0', ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;

      expect(proc.exitCode).not.toBe(0);
      expect(stderr).toContain('refusing to start');
      expect(stderr).toContain('BRAINZ_PIPEDREAM_CLIENT_SECRET');
      expect(stdout).not.toContain('listening');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and an environment that is not one of the vendor’s two is refused by name',
    async () => {
      const env = { ...configured(), BRAINZ_PIPEDREAM_ENVIRONMENT: 'staging' };

      const proc = Bun.spawn([...spawnArgv('src/web/serve.ts')], {
        cwd: `${import.meta.dir}/../..`,
        env: { PATH: process.env['PATH'] ?? '', PORT: '0', ...env },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;

      expect(proc.exitCode).not.toBe(0);
      // A deployment that believed it was in `production` and was not attaches
      // every user's mailbox to a development project.
      expect(stderr).toContain('BRAINZ_PIPEDREAM_ENVIRONMENT');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The last link: an authorization becoming a connection, through the deployed
// web process.
// ---------------------------------------------------------------------------

/**
 * **The founder authorizes at Google and closes the tab.**
 *
 * Every case above stops at the connect link. What happened next was nothing:
 * `connectSource` had no production caller, no `ConnectorState` was ever
 * written, `enqueueDuePulls` read nothing, and the mailbox was attached at the
 * vendor and invisible here. The link was the end of the flow rather than the
 * middle of it.
 *
 * This block drives the **deployed web process** — a second one, on the durable
 * secret backend, because reconciliation writes a sealed row and the `file`
 * backend the suite above uses has no sealing key at all. That pairing is a real
 * deployment state and is asserted rather than assumed: a self-hoster on the
 * file backend still gets connections, from the worker fleet's own tick.
 */
describe('an authorization the user never came back from becomes a connection', () => {
  let sealed: RunningService;

  beforeAll(async () => {
    sealed = await startService({
      entry: 'src/web/serve.ts',
      env: {
        ...configured(),
        // The durable store. The seed file the suite already writes is imported
        // at boot, so the pool secret provisioning needs is reachable through
        // the same store — which is how a real deployment migrates.
        BRAINZ_SECRET_BACKEND: 'postgres',
        BRAINZ_SECRET_ENCRYPTION_KEY: FAKE_SEALING_KEY,
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await sealed?.stop();
  });

  /**
   * The pool's connection string, back in the **durable** store.
   *
   * The suite's `fillPool` rewrites the seed file, which is the whole store on
   * the `file` backend the other blocks use. On the durable backend the seed is
   * imported once at boot and a claimed pool project's secret is consumed, so
   * every case after the first would answer `provisioning_unavailable`. Writing
   * it through the same store the process reads is what a pool filler does.
   */
  beforeEach(async () => {
    const durable = createPostgresSecretStore({
      sql: controlSql,
      key: await importSealingKey(FAKE_SEALING_KEY),
    });
    await durable.secrets.put(poolNamespace(POOL_ID), {
      connectionString: poolProject.dsn,
      bearerGrant: '',
    });
  });

  function connectOn(cookie: string, source = 'gmail'): Promise<Response> {
    return fetch(`${sealed.url}/api/connectors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, cookie },
      body: JSON.stringify({ source }),
    });
  }

  async function signUpOn(email: string): Promise<string> {
    const response = await fetch(`${sealed.url}/api/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
      body: JSON.stringify({ email, password: 'correct horse battery staple', fts_language: 'simple' }),
    });
    if (response.status !== 201) {
      throw new Error(`fixture: signup answered ${response.status} ${await response.text()}`);
    }
    return (response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  }

  function grantOn(tenant: string): Promise<Response> {
    return fetch(`${sealed.url}/admin?op=grant_internal_tier&tenant_id=${tenant}`, {
      method: 'POST',
      headers: { origin: WEB_ORIGIN, authorization: `Bearer ${ADMIN_CREDENTIAL}` },
    });
  }

  async function linkRow(tenant: string): Promise<{ state: string | null; pending: boolean }> {
    const rows = await controlSql<{ state: string | null; pending: boolean }[]>`
      SELECT state, pending_since IS NOT NULL AS pending
        FROM control.connector_link
       WHERE tenant_id = ${tenant} AND source = 'gmail'::control.connector_source`;
    return rows[0] ?? { state: null, pending: false };
  }

  test(
    'the deployed process records the intent before the user leaves for the vendor',
    async () => {
      const cookie = await signUpOn('intent@example.com');
      const tenant = await tenantId();
      await grantOn(tenant);

      expect((await connectOn(cookie)).status).toBe(200);

      // Pending, not connected. Nothing has happened at the vendor yet, and this
      // row is the only reason anyone will ever go and look.
      expect(await linkRow(tenant)).toEqual({ state: null, pending: true });
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'coming back to the dashboard is enough — no callback, no return URL',
    async () => {
      const cookie = await signUpOn('returned@example.com');
      const tenant = await tenantId();
      await grantOn(tenant);
      await connectOn(cookie);

      // The user finishes at Google. This side is told nothing.
      attachedAccounts = [`${tenant}-gmail`];

      const dashboard = await fetch(`${sealed.url}/dashboard?view=connectors`, { headers: { cookie } });
      const page = await dashboard.text();

      // The process asked the vendor, on the render, under this tenant's own
      // per-source external user.
      const listed = vendor.calls.filter((call) => call.path.endsWith('/accounts'));
      expect(listed).toHaveLength(1);
      // Under this tenant's own per-source external user, which is what makes a
      // later disconnect revoke one source rather than all three.
      expect(new URLSearchParams(listed[0]?.query ?? '').get('external_user_id')).toBe(
        `${tenant}-gmail`,
      );
      // And never for the account's credentials.
      expect(listed[0]?.query ?? '').not.toContain('include_credentials');

      // And the connection exists — sealed, so the control plane holds nothing
      // a reader of it could use.
      const row = await linkRow(tenant);
      expect(row.pending).toBe(false);
      expect(row.state).toMatch(/^v1[.]/);

      // What the founder actually sees, and the number they need to hear.
      expect(page).toContain('The first check has not run yet');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a second dashboard load does not ask the vendor again',
    async () => {
      const cookie = await signUpOn('twice@example.com');
      const tenant = await tenantId();
      await grantOn(tenant);
      await connectOn(cookie);
      attachedAccounts = [`${tenant}-gmail`];

      await fetch(`${sealed.url}/dashboard?view=connectors`, { headers: { cookie } });
      await fetch(`${sealed.url}/dashboard?view=connectors`, { headers: { cookie } });

      // Once. After adoption the link is no longer pending, so an ordinary
      // dashboard render costs one control-plane query and no vendor traffic —
      // which is what makes reconciling on a page render affordable at all.
      expect(vendor.calls.filter((call) => call.path.endsWith('/accounts'))).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a dashboard load with nothing pending never reaches the vendor',
    async () => {
      const cookie = await signUpOn('quiet@example.com');
      await grantOn(await tenantId());

      await fetch(`${sealed.url}/dashboard?view=connectors`, { headers: { cookie } });

      expect(vendor.calls.filter((call) => call.path.endsWith('/accounts'))).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a disconnect the user pressed is not undone by the next render',
    async () => {
      const cookie = await signUpOn('stopped@example.com');
      const tenant = await tenantId();
      await grantOn(tenant);
      await connectOn(cookie);
      // The account is attached at the vendor and stays attached: the double
      // keeps answering with it, which is the hostile version of this race.
      attachedAccounts = [`${tenant}-gmail`];

      await fetch(`${sealed.url}/api/connectors`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, cookie },
        body: JSON.stringify({ source: 'gmail' }),
      });

      const page = await (await fetch(`${sealed.url}/dashboard?view=connectors`, { headers: { cookie } })).text();

      expect(await linkRow(tenant)).toEqual({ state: null, pending: false });
      expect(page).toContain('Not connected');
      // And the render did not go looking: a disconnect clears the intent, so
      // there is nothing for a reconciliation pass to ask about.
      expect(vendor.calls.filter((call) => call.path.endsWith('/accounts'))).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
