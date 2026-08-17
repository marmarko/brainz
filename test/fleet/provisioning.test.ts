/**
 * The deployed web process builds a substrate, or refuses to run.
 *
 * **The defect this is written against.** `src/web/serve.ts` composed
 * `createBrainProvisioner({ controlSql, store, secrets, prefixes, poolTarget })`
 * and never supplied `neon`. The port is optional on
 * `BrainProvisionerDeps` — legitimately, because an operator running entirely
 * off a pre-filled pool has no vendor credential — and `BRAINZ_POOL_TARGET`
 * defaults to `0`, which means *provision synchronously*. So the shipped default
 * took the one branch that cannot work: `deps.neon === undefined`, refusal
 * `no_substrate_configured`, `503` for every signup in every deployment that had
 * not pre-filled a pool. `createNeonProjectApi` was complete, reviewed and
 * constructed by nothing under `src/`.
 *
 * **Why this suite is not `signup.test.ts`.** That file drives the pool path,
 * which is the path that provisions *without* a vendor. Nothing there can see a
 * missing Neon port, because nothing there takes the branch that needs one.
 *
 * **Why a fake HTTP vendor rather than a fake `NeonProjectApi`.** A test that
 * hands the app a stub port proves a handler calls a port; it cannot prove the
 * process constructs one. The subject here is the composition root, so the only
 * seam this test is allowed to use is the one an operator uses — the
 * environment. Everything below is read off the wire the spawned process
 * actually opened: the request bodies it sent, the rows it wrote, the file it
 * banked a bearer into. `BRAINZ_NEON_API_BASE` points at a local server exactly
 * the way `BRAINZ_STRIPE_API_BASE` does in `checkout.test.ts`.
 *
 * **The region, the version and the org id are deliberately not the defaults.**
 * A test that passed the shipped values would pass just as well against a
 * composition root that hardcoded them, which is the specific failure this
 * whole file is about — a value that looks configured and is not.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';

import { neonProjectName, TENANT_DATABASE_NAME, TENANT_ROLE_NAME } from '../../src/control/provision.ts';
import { tenantNamespace } from '../../src/control/secrets.ts';
import { TENANT_SCHEMA_VERSION } from '../../src/schema/apply.ts';
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

/** Deliberately not English: KTD9's forbidden failure is a silent anglicisation. */
const CHOSEN_LANGUAGE = 'spanish';

/**
 * Obvious fakes, every one. This repository is public and gitleaks runs on
 * every push; the live values live in `.env` and reach the process at run time.
 */
const FAKE_NEON_KEY = 'neon_api_key_this_test_invented';
const FAKE_NEON_ORG = 'org-this-test-invented';

/**
 * Neither is a shipped default (`aws-us-west-2` / `18`). If the composition root
 * hardcoded the substrate's placement instead of reading it, the two assertions
 * on the create body below are what notices.
 */
const CHOSEN_REGION = 'aws-eu-west-1';
const CHOSEN_PG_VERSION = 17;

/** What makes a deliberately-created tenant recognisable in the vendor console. */
const TENANT_PREFIX = 'canary-';

const PROJECT_ID = 'proj-fake-substrate';
const BRANCH_ID = 'br-fake-substrate';

let control: ControlFixture;
let identity: IdentityFixture;
/** The database the fake vendor hands back as the new project's own. */
let tenantProject: SchemaFixture;
let controlSql: SQL;
let identitySql: SQL;
let scratch: string;
let secretsFile: string;
let neon: ReturnType<typeof Bun.serve>;
let web: RunningService;

interface VendorCall {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
}

let vendorCalls: VendorCall[] = [];

/** Set by the one case that needs the vendor to refuse. `null` is the happy path. */
let refuseCreateWith: number | null = null;

beforeAll(async () => {
  control = await createControlPlane('websubstrate');
  identity = await createIdentityStore('websubstrate');
  // The state a Neon project is in immediately after `createRoleAndDatabase`:
  // reachable and carrying no schema, because KTD9 forbids applying one before
  // the tenant's language is known.
  tenantProject = await createEmptyDatabase('websubstrate');
  controlSql = new SQL(control.dsn, { max: 2 });
  identitySql = new SQL(identity.dsn, { max: 2 });

  scratch = mkdtempSync(join(tmpdir(), 'brainz-substrate-'));
  secretsFile = join(scratch, 'secrets.json');
  await writeSecretsFile(secretsFile, {});

  neon = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const raw = await request.text();
      let body: Record<string, unknown> | null = null;
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = null;
        }
      }
      vendorCalls.push({ method: request.method, path: url.pathname, body });

      if (request.method === 'POST' && url.pathname === '/projects') {
        if (refuseCreateWith !== null) {
          // A body the adapter must not put anywhere: it holds a platform
          // credential and an error is the most casually-logged object there is.
          return Response.json(
            { message: `quota exceeded for ${FAKE_NEON_ORG}`, key: FAKE_NEON_KEY },
            { status: refuseCreateWith },
          );
        }
        return Response.json(
          { project: { id: PROJECT_ID, name: String((body?.['project'] as { name?: string })?.name ?? '') },
            branch: { id: BRANCH_ID } },
          { status: 201 },
        );
      }
      if (request.method === 'POST' && url.pathname.endsWith('/roles')) {
        return Response.json({ role: { name: TENANT_ROLE_NAME } }, { status: 201 });
      }
      if (request.method === 'POST' && url.pathname.endsWith('/databases')) {
        return Response.json({ database: { name: TENANT_DATABASE_NAME } }, { status: 201 });
      }
      if (request.method === 'GET' && url.pathname.endsWith('/connection_uri')) {
        // The one value that matters: the new project's own connection string.
        // A local fixture database stands in for it, so the schema apply and the
        // first-query verification below run for real.
        return Response.json({ uri: tenantProject.dsn });
      }
      if (request.method === 'GET' && url.pathname === '/projects') {
        return Response.json({ projects: [], pagination: {} });
      }
      if (request.method === 'DELETE') return Response.json({ project: { id: PROJECT_ID } });
      return new Response('not found', { status: 404 });
    },
  });

  web = await startService({
    entry: 'src/web/serve.ts',
    env: {
      BRAINZ_WEB_ORIGIN: WEB_ORIGIN,
      BRAINZ_IDENTITY_DATABASE_URL: identity.dsn,
      BRAINZ_CONTROL_DATABASE_URL: control.dsn,
      BRAINZ_SECRETS_FILE: secretsFile,
      BRAINZ_CF_ACCOUNT_ID: FAKE_CF_ACCOUNT_ID,
      BRAINZ_MCP_URL: 'https://mcp.brainz.test/mcp',
      BRAINZ_STRIPE_WEBHOOK_SECRET: 'whsec_this_test_invented_it',
      // `0` is the shipped default and means "provision synchronously" — the
      // branch that needs a substrate and the branch that was unreachable.
      BRAINZ_POOL_TARGET: '0',
      BRAINZ_NEON_API_KEY: FAKE_NEON_KEY,
      BRAINZ_NEON_API_BASE: `http://127.0.0.1:${neon.url.port}`,
      BRAINZ_NEON_ORG_ID: FAKE_NEON_ORG,
      BRAINZ_NEON_REGION_ID: CHOSEN_REGION,
      BRAINZ_NEON_PG_VERSION: String(CHOSEN_PG_VERSION),
      BRAINZ_TENANT_ID_PREFIX: TENANT_PREFIX,
    },
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await web?.stop();
  neon?.stop(true);
  await controlSql?.close();
  await identitySql?.close();
  if (control !== undefined) await dropControlPlane(control);
  if (identity !== undefined) await dropIdentityStore(identity);
  if (tenantProject !== undefined) await dropFixtureDatabase(tenantProject);
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  vendorCalls = [];
  refuseCreateWith = null;
  await identitySql`DELETE FROM account.account`;
  await controlSql`DELETE FROM control.job`;
  await controlSql`DELETE FROM control.tenant`;
});

async function signUp(email: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${web.url}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
    body: JSON.stringify({
      email,
      password: 'correct horse battery staple',
      fts_language: CHOSEN_LANGUAGE,
    }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function createProjectBody(): { name: string; region_id: string; pg_version: number; org_id?: string } {
  const call = vendorCalls.find((entry) => entry.method === 'POST' && entry.path === '/projects');
  expect(call).toBeDefined();
  return (call?.body?.['project'] ?? {}) as {
    name: string;
    region_id: string;
    pg_version: number;
    org_id?: string;
  };
}

describe('a signup on the shipped default reaches the substrate', () => {
  test(
    'the process creates a project at the vendor and the tenant reaches ready at head',
    async () => {
      const created = await signUp('substrate@example.com');
      expect(created.status).toBe(201);

      // Read off the wire: the spawned process actually opened a connection to
      // the configured API base and posted a create.
      expect(vendorCalls.some((call) => call.method === 'POST' && call.path === '/projects')).toBe(
        true,
      );

      const tenants = await controlSql<
        { tenant_id: string; state: string; fts_language: string; schema_version: number; neon_project_id: string }[]
      >`SELECT tenant_id, state::text AS state, fts_language::text AS fts_language,
               schema_version, neon_project_id
          FROM control.tenant`;
      expect(tenants).toHaveLength(1);
      expect(tenants[0]?.state).toBe('ready');
      expect(tenants[0]?.fts_language).toBe(CHOSEN_LANGUAGE);
      // At head, not merely non-zero: a synchronous provision runs the real
      // ladder, and a tenant stopped partway up is one no fleet version serves.
      expect(Number(tenants[0]?.schema_version)).toBe(TENANT_SCHEMA_VERSION);
      // The id the vendor returned, banked — the handle a cleanup needs.
      expect(tenants[0]?.neon_project_id).toBe(PROJECT_ID);

      // And the tenant is reachable: its connection string and a routable bearer
      // are in the store the fleet reads, under the tenant's own namespace.
      const tenantId = tenants[0]?.tenant_id ?? '';
      const stored = (await Bun.file(secretsFile).json()) as {
        secrets: Record<string, { connectionString: string; bearerGrant: string }>;
      };
      const secret = stored.secrets[tenantNamespace(tenantId)];
      expect(secret?.connectionString).toBe(tenantProject.dsn);
      expect(secret?.bearerGrant.includes(tenantId)).toBe(true);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'the project is placed where the environment says, not where the adapter defaults',
    async () => {
      await signUp('placed@example.com');
      const project = createProjectBody();

      // KTD2: a tenant database in a different region from the fleet pays a
      // cross-region round trip on every query. The placement is configuration,
      // and this is the assertion a hardcoded region fails.
      expect(project.region_id).toBe(CHOSEN_REGION);
      expect(project.pg_version).toBe(CHOSEN_PG_VERSION);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'the project is created inside the configured organisation',
    async () => {
      await signUp('orged@example.com');
      // Never a literal in `src/`: a project created outside the org is billed
      // to a personal account and invisible to everyone else who can see the
      // fleet's projects.
      expect(createProjectBody().org_id).toBe(FAKE_NEON_ORG);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'the project name carries the tenant id, prefix and all, so it is recoverable by name',
    async () => {
      await signUp('named@example.com');
      const tenants = await controlSql<{ tenant_id: string }[]>`
        SELECT tenant_id FROM control.tenant`;
      const tenantId = tenants[0]?.tenant_id ?? '';

      // The prefix is what makes a deliberately-created tenant recognisable in
      // the vendor console, which is where the orphan history in this project
      // happened.
      expect(tenantId.startsWith(TENANT_PREFIX)).toBe(true);
      // The deterministic name is the second handle on a project whose id was
      // lost, so it has to be derived from the id the control plane banked.
      expect(createProjectBody().name).toBe(neonProjectName(tenantId));
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('when the vendor refuses', () => {
  /**
   * The refusal an operator can act on, without the one they must never see.
   *
   * `provisionTenant` catches every vendor throw and banks a code —
   * `project_create_failed` — which is the right thing to put in a content-free
   * database and useless on its own: it is the same code for a quota that ran
   * out, a key that was revoked, and a region that was retired. The status and
   * the operation are what separate those three, and `NeonApiError` is built to
   * carry exactly them and nothing else, which is what makes writing it down
   * safe. Observed by running it: the first live signup on this fleet answered
   * `project_create_failed` and the process said nothing else at all.
   *
   * The fake answers with a body holding the org id and the API key, because the
   * property worth pinning is what is NOT written: the adapter never reads an
   * error body, and this asserts the whole stderr stream is clean of both.
   */
  test(
    'the process writes the vendor status and operation to stderr, and never the body',
    async () => {
      refuseCreateWith = 403;
      const refused = await signUp('refused@example.com');
      expect(refused.status).toBe(503);

      const stderr = await web.stderrText();
      expect(stderr).toContain('neon_api_failed');
      expect(stderr).toContain('createProject');
      expect(stderr).toContain('403');
      // The code the tenant row carries is still what the user's 503 is built
      // from; the status is additional, not a replacement.
      expect(stderr).toContain('project_create_failed');

      expect(stderr).not.toContain(FAKE_NEON_KEY);
      expect(stderr).not.toContain('quota exceeded');

      // And nothing half-built survives: the row records the failure, names no
      // project, and is not `ready`.
      const rows = await controlSql<{ state: string; neon_project_id: string | null }[]>`
        SELECT state::text AS state, neon_project_id FROM control.tenant`;
      expect(rows[0]?.state).toBe('failed');
      expect(rows[0]?.neon_project_id).toBeNull();
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('a deployment with no substrate at all', () => {
  /** Every variable the entrypoint needs, minus whatever a case removes. */
  function baseEnv(): Record<string, string> {
    return {
      BRAINZ_WEB_ORIGIN: WEB_ORIGIN,
      BRAINZ_IDENTITY_DATABASE_URL: identity.dsn,
      BRAINZ_CONTROL_DATABASE_URL: control.dsn,
      BRAINZ_SECRETS_FILE: secretsFile,
      BRAINZ_CF_ACCOUNT_ID: FAKE_CF_ACCOUNT_ID,
      BRAINZ_MCP_URL: 'https://mcp.brainz.test/mcp',
      BRAINZ_STRIPE_WEBHOOK_SECRET: 'whsec_this_test_invented_it',
    };
  }

  /**
   * The account whose plan cannot take the cost lever — a self-hoster, and, as
   * it turned out, this fleet's own organisation on its first live signup.
   *
   * Free-plan Neon answers `412` to a create carrying
   * `default_endpoint_settings`, so the shipped configuration cannot provision
   * there at all. The escape hatch is one variable, and it is asserted here on
   * the wire rather than in the adapter alone, because the property that matters
   * is that a *deployed process* can be configured into that shape — which is
   * exactly the class of claim this whole file exists to stop being taken on
   * trust.
   */
  test(
    'omits the suspend interval when the deployment declares its plan cannot set one',
    async () => {
      const service = await startService({
        entry: 'src/web/serve.ts',
        env: {
          ...baseEnv(),
          BRAINZ_POOL_TARGET: '0',
          BRAINZ_NEON_API_KEY: FAKE_NEON_KEY,
          BRAINZ_NEON_API_BASE: `http://127.0.0.1:${neon.url.port}`,
          BRAINZ_NEON_SUSPEND_TIMEOUT: 'vendor-default',
        },
      });
      try {
        const response = await fetch(`${service.url}/api/signup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
          body: JSON.stringify({
            email: 'freeplan@example.com',
            password: 'correct horse battery staple',
            fts_language: CHOSEN_LANGUAGE,
          }),
        });
        expect(response.status).toBe(201);
      } finally {
        await service.stop();
      }

      const project = createProjectBody() as unknown as Record<string, unknown>;
      expect(Object.keys(project)).not.toContain('default_endpoint_settings');
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'refuses to start on any other value for it, rather than sending the fleet default anyway',
    async () => {
      // A misspelling that read as "off" would be the expensive direction: the
      // process would keep sending the setting while the operator believed it
      // had been suppressed, or the reverse. Two legal states, named.
      await expect(
        startService({
          entry: 'src/web/serve.ts',
          env: {
            ...baseEnv(),
            BRAINZ_POOL_TARGET: '0',
            BRAINZ_NEON_API_KEY: FAKE_NEON_KEY,
            BRAINZ_NEON_API_BASE: `http://127.0.0.1:${neon.url.port}`,
            BRAINZ_NEON_SUSPEND_TIMEOUT: 'default',
          },
          timeoutMs: 20_000,
        }),
      ).rejects.toThrow('BRAINZ_NEON_SUSPEND_TIMEOUT');
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'refuses to start when the pool is off and no vendor credential is set',
    async () => {
      // Zero suppliers: the pool provides none and the vendor provides none, so
      // every signup this process could ever serve answers 503. `env.ts`'s own
      // doctrine — a process that will not start is an outage somebody fixes in
      // a minute; one that starts misconfigured is an incident nobody notices.
      await expect(
        startService({ entry: 'src/web/serve.ts', env: baseEnv(), timeoutMs: 20_000 }),
      ).rejects.toThrow('BRAINZ_NEON_API_KEY');
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'refuses to start on a tenant-id prefix that cannot make a legal tenant id',
    async () => {
      // `control.tenant_id` is a slug domain and the secret store addresses a
      // namespace by the same alphabet, so an uppercase or punctuated prefix
      // mints ids the database refuses and the store cannot address. Checked
      // once at startup naming the variable, rather than arriving as a failed
      // signup on an origin where nobody is reading the configuration.
      await expect(
        startService({
          entry: 'src/web/serve.ts',
          env: { ...baseEnv(), BRAINZ_POOL_TARGET: '1', BRAINZ_TENANT_ID_PREFIX: 'Canary_' },
          timeoutMs: 20_000,
        }),
      ).rejects.toThrow('BRAINZ_TENANT_ID_PREFIX');
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'starts on a pool-backed deployment, and says on stderr why a signup could not provision',
    async () => {
      // A warm pool IS a substrate, so this shape is legal and starts. With the
      // pool empty the fallback is the vendor, and there is none — the refusal
      // the user sees is deliberately generic, and the operator's copy of it has
      // to exist somewhere or a deployment 503ing every signup names no cause at
      // all.
      const service = await startService({
        entry: 'src/web/serve.ts',
        env: { ...baseEnv(), BRAINZ_POOL_TARGET: '1' },
      });
      try {
        const response = await fetch(`${service.url}/api/signup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
          body: JSON.stringify({
            email: 'nosubstrate@example.com',
            password: 'correct horse battery staple',
            fts_language: CHOSEN_LANGUAGE,
          }),
        });
        expect(response.status).toBe(503);
        // The reason is a code, never a message: a driver error quoting the DSN
        // it was handed is the ordinary way a connection string reaches a log.
        expect(await service.stderrText()).toContain('no_substrate_configured');
      } finally {
        await service.stop();
      }
    },
    SETUP_TIMEOUT_MS,
  );
});
