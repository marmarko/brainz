/**
 * The three fleet entrypoints, as processes.
 *
 * **Why this file exists.** The fleet image's `CMD` was
 * `bun run src/mcp/server.ts`, a module that only *exports* `createMcpServer`.
 * Backgrounded and given five seconds it exited `0` with an empty stdout and
 * nothing listening on :8080, and no test in the repo could tell — every suite
 * built the server in-process and called `fetch` on the object. So the assertion
 * here is deliberately the one those suites cannot make: **spawn the entrypoint
 * the image names, and get an HTTP answer out of the process.**
 *
 * Readiness comes from the process (`test/fleet/fixture.ts` waits for the
 * `listening` line), never from a sleep. A sleep is what makes "it started" a
 * claim about timing rather than about the process.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';

import { TENANT_SCHEMA_VERSION } from '../../src/schema/apply.ts';
import { mintTenantBearer } from '../../src/mcp/oauth.ts';
import { tenantNamespace } from '../../src/control/secrets.ts';
import {
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from '../worker/fixture.ts';
import {
  createIdentityStore,
  dropIdentityStore,
  type IdentityFixture,
} from '../control/identity-fixture.ts';
import { dropFixtureDatabase, provisionFixture, type SchemaFixture } from '../schema/fixture.ts';
import {
  FAKE_CF_ACCOUNT_ID,
  startService,
  writeSecretsFile,
  type RunningService,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;
const TENANT = 'entrypoint-tenant';
const ISSUER_HOST = 'mcp.brainz.test';

let control: ControlFixture;
let identity: IdentityFixture;
let tenant: SchemaFixture;
let controlSql: SQL;
let scratch: string;
let secretsFile: string;
let bearer: string;

const running: RunningService[] = [];

beforeAll(async () => {
  control = await createControlPlane('entrypoints');
  identity = await createIdentityStore('entrypoints');
  tenant = await provisionFixture('entrypoints');
  controlSql = new SQL(control.dsn, { max: 1 });
  await seedTenant(controlSql, TENANT);
  await controlSql`
    UPDATE control.tenant SET schema_version = ${TENANT_SCHEMA_VERSION} WHERE tenant_id = ${TENANT}`;

  scratch = mkdtempSync(join(tmpdir(), 'brainz-entrypoint-'));
  secretsFile = join(scratch, 'secrets.json');
  bearer = mintTenantBearer(TENANT);
  await writeSecretsFile(secretsFile, {
    secrets: { [tenantNamespace(TENANT)]: { connectionString: tenant.dsn, bearerGrant: bearer } },
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  for (const service of running) await service.stop();
  await controlSql?.close();
  if (control !== undefined) await dropControlPlane(control);
  if (identity !== undefined) await dropIdentityStore(identity);
  if (tenant !== undefined) await dropFixtureDatabase(tenant);
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

async function start(entry: string, env: Record<string, string>): Promise<RunningService> {
  const service = await startService({ entry, env });
  running.push(service);
  return service;
}

function mcpEnv(): Record<string, string> {
  return {
    BRAINZ_PUBLIC_ORIGIN: `https://${ISSUER_HOST}`,
    BRAINZ_CONTROL_DATABASE_URL: control.dsn,
    BRAINZ_SECRET_BACKEND: 'file',
    BRAINZ_SECRETS_FILE: secretsFile,
      BRAINZ_CF_ACCOUNT_ID: FAKE_CF_ACCOUNT_ID,
  };
}

describe('the MCP fleet entrypoint serves', () => {
  test(
    'the process listens, answers its health probe, and dispatches a real tool call',
    async () => {
      const service = await start('src/mcp/serve.ts', mcpEnv());
      expect(service.service).toBe('mcp');

      // Cloudflare's readiness is a port poll against the class's
      // `pingEndpoint`; an entrypoint with no cheap route to answer it is an
      // instance that never reports ready.
      const health = await fetch(`${service.url}/health`);
      expect(health.status).toBe(200);

      // Discovery: a connector's first request is unauthorised by design, and
      // the two well-known documents are what it reads next. They have to carry
      // the origin this process was configured with, not the socket it bound.
      const metadata = await fetch(`${service.url}/.well-known/oauth-protected-resource`);
      expect(metadata.status).toBe(200);
      const document = (await metadata.json()) as { resource: string };
      expect(document.resource).toContain(ISSUER_HOST);

      // And the whole stack: the bearer resolves a tenant through the file
      // secret store, the connection accessor dials the tenant database, and
      // dispatch answers. Nothing here is in this process's memory by fiat.
      const called = await fetch(`${service.url}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'recall', arguments: { query: 'anything at all' } },
        }),
      });
      expect(called.status).toBe(200);
      const answered = (await called.json()) as { result?: { isError?: boolean } };
      expect(answered.result).toBeDefined();
      expect(answered.result?.isError).toBeUndefined();
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'a missing required variable is a refusal to start, not a process serving nothing',
    async () => {
      const { BRAINZ_CONTROL_DATABASE_URL: _dropped, ...withoutControl } = mcpEnv();
      await expect(start('src/mcp/serve.ts', withoutControl)).rejects.toThrow(
        /BRAINZ_CONTROL_DATABASE_URL/,
      );
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('the worker fleet entrypoint serves', () => {
  test(
    'the process listens and answers its health probe',
    async () => {
      const service = await start('src/worker/serve.ts', {
        BRAINZ_CONTROL_DATABASE_URL: control.dsn,
        BRAINZ_SECRET_BACKEND: 'file',
        BRAINZ_SECRETS_FILE: secretsFile,
      BRAINZ_CF_ACCOUNT_ID: FAKE_CF_ACCOUNT_ID,
        // Long enough that no tick fires during the assertion below: this test
        // is about the process serving, and the seam it runs is its own test.
        BRAINZ_WORKER_TICK_MS: '3600000',
      });
      expect(service.service).toBe('worker');

      const health = await fetch(`${service.url}/health`);
      expect(health.status).toBe(200);
      const body = (await health.json()) as { service: string };
      expect(body.service).toBe('worker');
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('the web entrypoint serves', () => {
  test(
    'a stranger reaches the signup page from the running process',
    async () => {
      const service = await start('src/web/serve.ts', {
        BRAINZ_WEB_ORIGIN: 'https://app.brainz.test',
        BRAINZ_IDENTITY_DATABASE_URL: identity.dsn,
        BRAINZ_CONTROL_DATABASE_URL: control.dsn,
        BRAINZ_SECRET_BACKEND: 'file',
        BRAINZ_SECRETS_FILE: secretsFile,
      BRAINZ_CF_ACCOUNT_ID: FAKE_CF_ACCOUNT_ID,
        BRAINZ_MCP_URL: `https://${ISSUER_HOST}/mcp`,
        BRAINZ_STRIPE_WEBHOOK_SECRET: 'whsec_this_test_invented_it',
        // A pool-backed deployment, which is one of the two shapes that can
        // actually provision. The third shape — no pool AND no vendor
        // credential — no longer starts, because every signup it could serve
        // would answer 503; `test/fleet/provisioning.test.ts` owns that refusal.
        // Named here rather than left at the default so this file says which
        // deployment it is serving a page for.
        BRAINZ_POOL_TARGET: '1',
      });
      expect(service.service).toBe('web');

      const page = await fetch(`${service.url}/signup`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      const html = await page.text();
      // KTD9's choice is the one thing the signup page may not omit.
      expect(html).toContain('fts_language');
    },
    SETUP_TIMEOUT_MS,
  );
});
