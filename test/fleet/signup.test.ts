/**
 * A stranger signs up, through the process, and gets a brain.
 *
 * **What this is defending.** A full signup through the real `createWebApp`
 * completed with no tenant: the account existed, the session existed, and
 * `account.brain` did not. Three pieces of shipped work were unreachable behind
 * that one missing call — the warm pool (`src/control/pool.ts`), KTD9's
 * per-tenant FTS language (collected on the form, validated, then discarded),
 * and the free-tier connector gate, which no request could ever reach because
 * `tenantOf` answered `null` and every connect stopped at `no_brain_yet` first.
 *
 * **It is driven against the spawned entrypoint, not `createWebApp`.** A test
 * that composes the app in memory and hands it a fake provisioner proves the
 * handler calls a port; it cannot prove a deployed process has one wired. The
 * effects asserted below are read from the databases afterwards — a control-plane
 * row, an identity row, a claimed pool project, a bearer in the secrets file —
 * so what passes is what the process did, not what it answered.
 *
 * **The pool is on (`BRAINZ_POOL_TARGET=1`) and pre-filled by this test**, the
 * way a filler or an operator fills it: a `ready` row in `control.pool_project`
 * and its connection string in the secret store. That is the only path that
 * provisions without a vendor credential, and it is the path the pool exists for.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';

import { poolNamespace, tenantNamespace } from '../../src/control/secrets.ts';
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
  startService,
  writeSecretsFile,
  type RunningService,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const WEB_ORIGIN = 'https://app.brainz.test';
const POOL_ID = 'pool-0000000000000001';

/** Deliberately not English: KTD9's forbidden failure is a silent anglicisation. */
const CHOSEN_LANGUAGE = 'spanish';

let control: ControlFixture;
let identity: IdentityFixture;
let poolProject: SchemaFixture;
/**
 * A second, untouched pool database for the retry case.
 *
 * Not fastidiousness: the schema ladder refuses to migrate a tenant indexed in
 * one language as another (KTD9's guard, and it fired the first time this case
 * reused the shared project), so a case that picks a different language needs a
 * project no earlier case has already indexed. Which is exactly true of a real
 * pool: every project is claimed once.
 */
let secondPoolProject: SchemaFixture;
let controlSql: SQL;
let identitySql: SQL;
let scratch: string;
let secretsFile: string;
let web: RunningService;

beforeAll(async () => {
  control = await createControlPlane('signupflow');
  identity = await createIdentityStore('signupflow');
  // An empty database is exactly the state a pool project is in: created,
  // reachable, and carrying no schema, because KTD9 forbids applying one before
  // the tenant's language is known.
  poolProject = await createEmptyDatabase('signuppool');
  secondPoolProject = await createEmptyDatabase('signuppooltwo');
  controlSql = new SQL(control.dsn, { max: 2 });
  identitySql = new SQL(identity.dsn, { max: 2 });

  scratch = mkdtempSync(join(tmpdir(), 'brainz-signup-'));
  secretsFile = join(scratch, 'secrets.json');

  web = await startService({
    entry: 'src/web/serve.ts',
    env: {
      BRAINZ_WEB_ORIGIN: WEB_ORIGIN,
      BRAINZ_IDENTITY_DATABASE_URL: identity.dsn,
      BRAINZ_CONTROL_DATABASE_URL: control.dsn,
      BRAINZ_SECRET_BACKEND: 'file',
      BRAINZ_SECRETS_FILE: secretsFile,
      BRAINZ_CF_ACCOUNT_ID: FAKE_CF_ACCOUNT_ID,
      BRAINZ_MCP_URL: 'https://mcp.brainz.test/mcp',
      BRAINZ_STRIPE_WEBHOOK_SECRET: 'whsec_this_test_invented_it',
      BRAINZ_POOL_TARGET: '1',
      // A connector vendor is configured — obvious fakes, and nothing below
      // dials it — so that the free-tier case observes the **tier** gate rather
      // than the vendor-absent refusal that now precedes it. A deployment with
      // no vendor answers `501 unavailable` first, deliberately: no amount of
      // paying makes a connector work there. That ordering has its own cases in
      // `test/fleet/connectors.test.ts`.
      BRAINZ_PIPEDREAM_PROJECT_ID: 'proj_this_test_invented_it',
      BRAINZ_PIPEDREAM_CLIENT_ID: 'not-a-real-pipedream-client-id',
      BRAINZ_PIPEDREAM_CLIENT_SECRET: 'not-a-real-pipedream-client-secret',
      BRAINZ_PIPEDREAM_ENVIRONMENT: 'development',
      BRAINZ_PIPEDREAM_API_BASE: 'http://127.0.0.1:1/v1',
    },
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await web?.stop();
  await controlSql?.close();
  await identitySql?.close();
  if (control !== undefined) await dropControlPlane(control);
  if (identity !== undefined) await dropIdentityStore(identity);
  if (poolProject !== undefined) await dropFixtureDatabase(poolProject);
  if (secondPoolProject !== undefined) await dropFixtureDatabase(secondPoolProject);
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

/** Refill the pool the way a filler does: a `ready` row plus a stored string. */
async function fillPool(project: SchemaFixture = poolProject): Promise<void> {
  await controlSql`DELETE FROM control.pool_project`;
  await controlSql`
    INSERT INTO control.pool_project (
      pool_id, state, neon_project_id, neon_branch_id, neon_database, neon_role,
      connection_secret_ref, created_at, ready_at
    ) VALUES (
      ${POOL_ID}, 'ready', 'proj-pool-1', 'br-pool-1', 'brainz', 'brainz_owner',
      ${poolNamespace(POOL_ID)}, now(), now()
    )`;
  await writeSecretsFile(secretsFile, {
    secrets: { [poolNamespace(POOL_ID)]: { connectionString: project.dsn, bearerGrant: '' } },
  });
}

async function reset(): Promise<void> {
  await identitySql`DELETE FROM account.account`;
  await identitySql`DELETE FROM account.billing_event`;
  await controlSql`DELETE FROM control.job`;
  await controlSql`DELETE FROM control.tenant`;
  // The pool project's database is reused across cases; the schema apply is
  // idempotent up the ladder, so what is reset is the claim, not the data.
  await fillPool();
}

interface SignupResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly cookie: string;
}

async function signUp(email: string, language = CHOSEN_LANGUAGE): Promise<SignupResponse> {
  const response = await fetch(`${web.url}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password: 'correct horse battery staple', fts_language: language }),
  });
  const header = response.headers.get('set-cookie') ?? '';
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    cookie: header.split(';')[0] ?? '',
  };
}

beforeEach(reset);

describe('signup provisions a brain', () => {
  test(
    'the control plane gains a ready tenant in the language the form chose',
    async () => {
      const created = await signUp('stranger@example.com');
      expect(created.status).toBe(201);

      const tenants = await controlSql<
        { tenant_id: string; state: string; fts_language: string; schema_version: number; tier: string }[]
      >`SELECT tenant_id, state::text AS state, fts_language::text AS fts_language, schema_version, tier::text AS tier
          FROM control.tenant`;
      expect(tenants).toHaveLength(1);
      expect(tenants[0]?.state).toBe('ready');
      // KTD9. The language the stranger picked, on the row, not `english`.
      expect(tenants[0]?.fts_language).toBe(CHOSEN_LANGUAGE);
      expect(Number(tenants[0]?.schema_version)).toBeGreaterThan(0);
      expect(tenants[0]?.tier).toBe('free');
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'the account is linked to that tenant, and the session can read it back',
    async () => {
      const created = await signUp('linked@example.com');
      const tenants = await controlSql<{ tenant_id: string }[]>`SELECT tenant_id FROM control.tenant`;
      const tenantId = tenants[0]?.tenant_id ?? '';
      expect(tenantId.length).toBeGreaterThan(0);

      const links = await identitySql<{ tenant_id: string; fts_language: string }[]>`
        SELECT tenant_id, fts_language FROM account.brain`;
      expect(links).toEqual([{ tenant_id: tenantId, fts_language: CHOSEN_LANGUAGE }]);

      const me = await fetch(`${web.url}/api/me`, { headers: { cookie: created.cookie } });
      const body = (await me.json()) as { brain: { tenant_id: string } | null };
      expect(body.brain).not.toBeNull();
      expect(body.brain?.tenant_id).toBe(tenantId);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'the pool project is claimed and its connection string moves to the tenant',
    async () => {
      await signUp('pooled@example.com');
      const tenants = await controlSql<{ tenant_id: string }[]>`SELECT tenant_id FROM control.tenant`;
      const tenantId = tenants[0]?.tenant_id ?? '';

      const pool = await controlSql<{ state: string; claimed_by: string | null }[]>`
        SELECT state::text AS state, claimed_by FROM control.pool_project`;
      expect(pool[0]?.state).toBe('claimed');
      expect(pool[0]?.claimed_by).toBe(tenantId);

      const stored = (await Bun.file(secretsFile).json()) as {
        secrets: Record<string, { connectionString: string; bearerGrant: string }>;
      };
      // The pool entry is gone and the tenant's own entry exists — the order
      // `assignPoolProject` requires, observed from the file rather than a mock.
      expect(stored.secrets[poolNamespace(POOL_ID)]).toBeUndefined();
      const tenantSecret = stored.secrets[tenantNamespace(tenantId)];
      expect(tenantSecret?.connectionString).toBe(poolProject.dsn);
      // A bearer the edge can route: the tenant id has to be *in* the token,
      // because Durable Object affinity is derived from it before anything is
      // verified. A bare random grant would be unroutable.
      expect(tenantSecret?.bearerGrant.includes(tenantId)).toBe(true);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'the free-tier connector gate is now the answer, where `no_brain_yet` used to be',
    async () => {
      const created = await signUp('gated@example.com');
      const response = await fetch(`${web.url}/api/connectors`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, cookie: created.cookie },
        body: JSON.stringify({ source: 'gmail' }),
      });

      // 402 with `tier_required`, not 409 with `no_brain_yet`. The unit
      // economics decision U15 recorded — connectors are paid-only — is
      // unreachable until a signup provisions, because the missing brain
      // refuses first.
      expect(response.status).toBe(402);
      const body = (await response.json()) as { code: string; message: string };
      expect(body.code).toBe('tier_required');
      expect(body.message).toContain('paid plan');
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'an empty pool with no substrate configured refuses the signup rather than half-completing it',
    async () => {
      await controlSql`DELETE FROM control.pool_project`;
      const created = await signUp('unlucky@example.com');

      // 503, because the account exists and the brain does not — a state the
      // rest of the app already models (`/api/me` answers `brain: null`) and a
      // 201 would lie about.
      expect(created.status).toBe(503);
      expect(created.body['code']).toBe('provisioning_unavailable');
      expect(await controlSql`SELECT tenant_id FROM control.tenant`).toHaveLength(0);
      expect(await identitySql`SELECT tenant_id FROM account.brain`).toHaveLength(0);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'the account left without a brain can still get one, and asking twice does not take two',
    async () => {
      // Without a retry the 503 above is terminal: the email is taken, the
      // password works, and no route in the app can ever give that account a
      // brain.
      await controlSql`DELETE FROM control.pool_project`;
      expect((await signUp('retrying@example.com')).status).toBe(503);

      const signedIn = await fetch(`${web.url}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
        body: JSON.stringify({
          email: 'retrying@example.com',
          password: 'correct horse battery staple',
        }),
      });
      expect(signedIn.status).toBe(200);
      const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

      await fillPool(secondPoolProject);
      const retry = async (): Promise<Response> =>
        fetch(`${web.url}/api/brain`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, cookie },
          // Asked again, never remembered: the row that keeps the choice is the
          // one the failed signup did not write, and defaulting here would be
          // KTD9's silent anglicisation arriving through the back door.
          body: JSON.stringify({ fts_language: 'french' }),
        });

      const first = await retry();
      expect(first.status).toBe(201);
      const created = (await first.json()) as { tenant_id: string; created: boolean };
      expect(created.created).toBe(true);

      const tenants = await controlSql<{ tenant_id: string; fts_language: string }[]>`
        SELECT tenant_id, fts_language::text AS fts_language FROM control.tenant`;
      expect(tenants).toEqual([{ tenant_id: created.tenant_id, fts_language: 'french' }]);

      const second = await retry();
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ tenant_id: created.tenant_id, created: false });
      // One brain, and one pool project spent on it. A retry that provisioned
      // again would leave the account pointing at the first tenant and the
      // second paid for and unreachable.
      expect(await controlSql`SELECT tenant_id FROM control.tenant`).toHaveLength(1);
      expect(await identitySql`SELECT tenant_id FROM account.brain`).toHaveLength(1);
    },
    SETUP_TIMEOUT_MS,
  );
});
