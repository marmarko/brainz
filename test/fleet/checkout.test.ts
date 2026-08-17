/**
 * From checkout to a paid tier, through the running web process.
 *
 * **The gap this closes.** `account.subscription.stripe_customer_id` had no
 * production writer — every write in the repo was in a test — and there was no
 * checkout route to produce one. The webhook resolves an owner *by customer id*,
 * so a genuine, correctly-signed delivery for a real paying customer found
 * nothing and answered `unknown_customer`: the money moved and the tier did not.
 * The first case below is that state, asserted deliberately so the chain has a
 * documented "before".
 *
 * **The vendor is a local server, not the vendor.** The API base is
 * configuration rather than a literal (`src/control/checkout.ts` explains why),
 * which is what lets this drive the real entrypoint, the real route and the real
 * writer without a live call — while still exercising the two requests in the
 * order that matters: the customer exists *before* the user is redirected, so
 * whichever delivery arrives first has an owner.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';

import { poolNamespace } from '../../src/control/secrets.ts';
import { createControlPlane, dropControlPlane, type ControlFixture } from '../worker/fixture.ts';
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
const WEBHOOK_SECRET = 'whsec_a_secret_this_test_invented_and_stripe_never_saw';
const POOL_ID = 'pool-0000000000000002';
const CUSTOMER = 'cus_thistestinventedit';
const SUBSCRIPTION = 'sub_thistestinventedit';

let control: ControlFixture;
let identity: IdentityFixture;
let poolProject: SchemaFixture;
let controlSql: SQL;
let identitySql: SQL;
let scratch: string;
let vendor: ReturnType<typeof Bun.serve>;
let web: RunningService;
let sessionCookie = '';
let tenantId = '';

/** Every request the fake vendor received, so the order can be asserted. */
const vendorCalls: { path: string; form: Record<string, string> }[] = [];

beforeAll(async () => {
  control = await createControlPlane('checkoutflow');
  identity = await createIdentityStore('checkoutflow');
  poolProject = await createEmptyDatabase('checkoutpool');
  controlSql = new SQL(control.dsn, { max: 2 });
  identitySql = new SQL(identity.dsn, { max: 2 });

  scratch = mkdtempSync(join(tmpdir(), 'brainz-checkout-'));
  const secretsFile = join(scratch, 'secrets.json');

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

  vendor = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const form = Object.fromEntries(new URLSearchParams(await request.text()).entries());
      vendorCalls.push({ path, form });
      if (path === '/v1/customers') return Response.json({ id: CUSTOMER, object: 'customer' });
      if (path === '/v1/checkout/sessions') {
        return Response.json({ id: 'cs_test', url: `${WEB_ORIGIN}/pay/cs_test`, customer: CUSTOMER });
      }
      return new Response('not found', { status: 404 });
    },
  });

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
      BRAINZ_STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      BRAINZ_POOL_TARGET: '1',
      BRAINZ_STRIPE_API_BASE: `http://127.0.0.1:${vendor.url.port}`,
      BRAINZ_STRIPE_SECRET_KEY: 'sk_this_test_invented_it',
      BRAINZ_STRIPE_PRICE_ID: 'price_alpha',
    },
  });

  const created = await fetch(`${web.url}/api/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
    body: JSON.stringify({
      email: 'payer@example.com',
      password: 'correct horse battery staple',
      fts_language: 'simple',
    }),
  });
  expect(created.status).toBe(201);
  sessionCookie = (created.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const rows = await controlSql<{ tenant_id: string }[]>`SELECT tenant_id FROM control.tenant`;
  tenantId = rows[0]?.tenant_id ?? '';
  expect(tenantId.length).toBeGreaterThan(0);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await web?.stop();
  vendor?.stop(true);
  await controlSql?.close();
  await identitySql?.close();
  if (control !== undefined) await dropControlPlane(control);
  if (identity !== undefined) await dropIdentityStore(identity);
  if (poolProject !== undefined) await dropFixtureDatabase(poolProject);
  if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
});

/** A delivery signed exactly as the vendor signs one, over the raw bytes sent. */
async function deliver(event: Record<string, unknown>): Promise<Record<string, unknown>> {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const signature = `t=${t},v1=${createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex')}`;
  const response = await fetch(`${web.url}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
  return (await response.json()) as Record<string, unknown>;
}

function subscriptionEvent(id: string): Record<string, unknown> {
  return {
    id,
    type: 'customer.subscription.created',
    // The vendor stamps every event with when it made it; `billing.ts` orders
    // deliveries on it, and a body without one is not one of their events.
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: SUBSCRIPTION,
        customer: CUSTOMER,
        status: 'active',
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
      },
    },
  };
}

describe('the checkout route is what makes a webhook resolvable', () => {
  test(
    'before checkout, a genuine signed delivery has no owner to attribute it to',
    async () => {
      // Not a bug being asserted — the "before" of the chain. The signature is
      // valid, the event is well formed, and the tier does not move because
      // nothing has ever bound this customer to an account.
      expect(await deliver(subscriptionEvent('evt_beforecheckout'))).toMatchObject({
        ok: true,
        outcome: 'unknown_customer',
      });
      const tiers = await controlSql<{ tier: string }[]>`
        SELECT tier::text AS tier FROM control.tenant WHERE tenant_id = ${tenantId}`;
      expect(tiers[0]?.tier).toBe('free');
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'checkout creates the customer, records it, and redirects to the vendor',
    async () => {
      const response = await fetch(`${web.url}/api/billing/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, cookie: sessionCookie },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; url: string };
      expect(body.ok).toBe(true);
      expect(body.url).toContain('/pay/');

      // The customer exists before the session that sends the user away — so a
      // `checkout.session.completed` that beats the user home still has an owner.
      expect(vendorCalls.map((call) => call.path)).toEqual([
        '/v1/customers',
        '/v1/checkout/sessions',
      ]);
      expect(vendorCalls[1]?.form['customer']).toBe(CUSTOMER);

      const rows = await identitySql<{ stripe_customer_id: string | null }[]>`
        SELECT stripe_customer_id FROM account.subscription`;
      expect(rows[0]?.stripe_customer_id).toBe(CUSTOMER);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'the same delivery now resolves the owner and moves both halves of the tier',
    async () => {
      expect(await deliver(subscriptionEvent('evt_aftercheckout'))).toMatchObject({
        ok: true,
        outcome: 'applied',
        tier: 'paid',
        tenantId,
      });

      const billing = await identitySql<{ tier: string; status: string }[]>`
        SELECT tier::text AS tier, status::text AS status FROM account.subscription`;
      expect(billing[0]).toMatchObject({ tier: 'paid', status: 'active' });

      // The half the consolidation cycle reads. The identity row is what a
      // dashboard shows; this column is what decides whether model phases run.
      const tenants = await controlSql<{ tier: string }[]>`
        SELECT tier::text AS tier FROM control.tenant WHERE tenant_id = ${tenantId}`;
      expect(tenants[0]?.tier).toBe('paid');
    },
    SETUP_TIMEOUT_MS,
  );
});
