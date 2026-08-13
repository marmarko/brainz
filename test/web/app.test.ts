/**
 * The web app end to end: sessions, the CSRF origin check, the free-tier
 * connector gate, BYOK entry, disconnect, and the connect flow.
 *
 * Driven through the real `Request`/`Response` handler rather than through the
 * handlers underneath it, because the things being asserted — a cookie's
 * attributes, a 403 on a cross-origin POST, a webhook path that is deliberately
 * outside the cookie rules — are properties of the routing, and a test that
 * called the handlers directly would assert none of them.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { SQL } from 'bun';

import { attachBrain } from '../../src/control/accounts.ts';
import type { ProviderId } from '../../src/ai/keys.ts';
import {
  SESSION_COOKIE,
  connectorGate,
  createWebApp,
  readCookie,
  sameOriginRefusal,
} from '../../src/web/app.ts';
import { CONNECT_STEPS, installLink } from '../../src/web/connect.ts';
import { escapeHtml } from '../../src/web/pages.ts';
import {
  connect as connectControl,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from '../worker/fixture.ts';
import {
  connect as connectIdentity,
  createIdentityStore,
  dropIdentityStore,
  TEST_HASH_COST,
  type IdentityFixture,
} from '../control/identity-fixture.ts';

const ORIGIN = 'https://app.brainz.example';
const MCP_URL = 'https://mcp.brainz.example/mcp';
const WEBHOOK_SECRET = 'whsec_a_secret_this_test_invented_and_stripe_never_saw';
const ADMIN_CREDENTIAL = 'bzadm_operator';
const AT = new Date('2026-08-13T09:00:00.000Z');
const TENANT = 'alice';

let identity: IdentityFixture;
let control: ControlFixture;
let sql: SQL;
let controlSql: SQL;

/** Everything the vendor ports recorded, so a test can assert on what was asked. */
let recorded: {
  byokPuts: { tenantId: string; provider: string; key: string }[];
  byokRevokes: { tenantId: string; provider: string }[];
  minted: { tenantId: string; source: string }[];
  disconnected: { tenantId: string; source: string }[];
};

function app(overrides: { adminCredential?: string } = {}) {
  return createWebApp({
    sql,
    controlSql,
    origin: ORIGIN,
    mcpUrl: MCP_URL,
    stripeWebhookSecret: WEBHOOK_SECRET,
    adminCredential: overrides.adminCredential ?? ADMIN_CREDENTIAL,
    now: () => AT,
    hash: TEST_HASH_COST,
    byok: {
      put(tenantId: string, provider: ProviderId, key: string) {
        recorded.byokPuts.push({ tenantId, provider, key });
        return Promise.resolve({ ok: true });
      },
      revoke(tenantId: string, provider: ProviderId) {
        recorded.byokRevokes.push({ tenantId, provider });
        return Promise.resolve({ ok: true });
      },
    },
    connectors: {
      mintClaimUrl(request) {
        recorded.minted.push({ ...request });
        return Promise.resolve({
          claimUrl: `${ORIGIN}/connect/claim/00000000-0000-4000-8000-000000000001#abcdefghijklmnop`,
          expiresAt: new Date(AT.getTime() + 600_000),
        });
      },
      disconnect(request) {
        recorded.disconnected.push({ ...request });
        return Promise.resolve({ deleted: true, tokensRevoked: 'unverified' as const });
      },
    },
  });
}

function post(path: string, fields: unknown, options: { cookie?: string; origin?: string | null } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.origin !== null) headers['origin'] = options.origin ?? ORIGIN;
  if (options.cookie !== undefined) headers['cookie'] = options.cookie;
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: JSON.stringify(fields) });
}

function get(path: string, options: { cookie?: string; authorization?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers['cookie'] = options.cookie;
  if (options.authorization !== undefined) headers['authorization'] = options.authorization;
  return new Request(`${ORIGIN}${path}`, { headers });
}

function cookieOf(response: Response): string {
  const header = response.headers.get('set-cookie') ?? '';
  const token = readCookie(header.split(';')[0] ?? '', SESSION_COOKIE) ?? '';
  return `${SESSION_COOKIE}=${token}`;
}

async function reset(): Promise<void> {
  await sql`DELETE FROM account.account`;
  await sql`DELETE FROM account.billing_event`;
  await controlSql`DELETE FROM control.job`;
  await controlSql`DELETE FROM control.tenant`;
  recorded = { byokPuts: [], byokRevokes: [], minted: [], disconnected: [] };
}

/** A signed-in account whose brain is a seeded tenant. */
async function signedIn(tier: 'free' | 'paid' = 'free'): Promise<string> {
  const handle = app();
  const created = await handle(
    post('/api/signup', {
      email: 'alice@example.com',
      password: 'correct horse battery staple',
      fts_language: 'simple',
    }),
  );
  const cookie = cookieOf(created);
  const body = (await created.json()) as { account_id: string };

  await seedTenant(controlSql, TENANT);
  await attachBrain(sql, {
    accountId: body.account_id,
    tenantId: TENANT,
    ftsLanguage: 'simple',
    now: AT,
  });
  if (tier === 'paid') {
    await sql`
      UPDATE account.subscription SET tier = 'paid', status = 'active',
        stripe_customer_id = 'cus_alice', stripe_subscription_id = 'sub_alice'
      WHERE account_id = ${body.account_id}`;
  }
  return cookie;
}

beforeAll(async () => {
  identity = await createIdentityStore('webapp');
  control = await createControlPlane('webapp');
  sql = connectIdentity(identity);
  controlSql = connectControl(control);
  recorded = { byokPuts: [], byokRevokes: [], minted: [], disconnected: [] };
}, 60_000);

afterAll(async () => {
  await sql?.close();
  await controlSql?.close();
  if (identity) await dropIdentityStore(identity);
  if (control) await dropControlPlane(control);
});

// ---------------------------------------------------------------------------

describe('the CSRF origin check', () => {
  test('a state-changing request from another origin is refused', () => {
    const foreign = post('/api/logout', {}, { origin: 'https://evil.example' });
    expect(sameOriginRefusal(foreign, ORIGIN)).toContain('another origin');
  });

  test('a state-changing request with NO Origin is refused, not trusted', () => {
    // The case a naive check misses: absent is not the same as agreeing, and
    // there is no way to tell an old browser from a forged request.
    const bare = post('/api/logout', {}, { origin: null });
    expect(sameOriginRefusal(bare, ORIGIN)).toContain('no Origin header');
  });

  test('a GET is not refused, whatever it carries', () => {
    expect(sameOriginRefusal(get('/api/me'), ORIGIN)).toBeNull();
  });

  test('the router enforces it, not only the helper', async () => {
    await reset();
    const response = await app()(post('/api/signup', {}, { origin: 'https://evil.example' }));
    expect(response.status).toBe(403);
  });
});

describe('signup and session', () => {
  test('a signup opens a session in an httpOnly, SameSite=Lax cookie', async () => {
    await reset();
    const response = await app()(
      post('/api/signup', {
        email: 'alice@example.com',
        password: 'correct horse battery staple',
        fts_language: 'simple',
      }),
    );
    expect(response.status).toBe(201);

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    // The cookie is a random token, not the account id or the address.
    expect(cookie).not.toContain('alice@example.com');
  });

  test('signup refuses without a language, rather than choosing English', async () => {
    // KTD9's forbidden failure, one layer up from the schema: the language is
    // the user's choice and a default would quietly anglicise every tenant whose
    // form field was missed.
    await reset();
    const response = await app()(
      post('/api/signup', { email: 'alice@example.com', password: 'correct horse battery staple' }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'fts_language_required' });
  });

  test('an API call with no session is 401, and a page redirects', async () => {
    await reset();
    expect((await app()(get('/api/me'))).status).toBe(401);
    expect((await app()(get('/dashboard'))).status).toBe(302);
  });

  test('logout revokes the session it was presented with', async () => {
    await reset();
    const cookie = await signedIn();
    expect((await app()(get('/api/me', { cookie }))).status).toBe(200);

    await app()(post('/api/logout', {}, { cookie }));
    expect((await app()(get('/api/me', { cookie }))).status).toBe(401);
  });
});

describe('the free-tier connector decision', () => {
  test('the gate is a stated decision with the actual reason in it', () => {
    expect(connectorGate('paid')).toBeNull();
    const refused = connectorGate('free');
    expect(refused).toMatchObject({ code: 'tier_required' });
    // The copy names the vendor fee rather than saying "upgrade for more". A
    // user told the reason can weigh it; a user told nothing assumes we are
    // withholding a feature.
    expect(refused?.message).toContain('monthly fee');
    expect(refused?.message).toContain('Chat exports and folder imports are included');
  });

  test('a free account cannot connect a source, and no claim URL is minted', async () => {
    await reset();
    const cookie = await signedIn('free');
    const response = await app()(post('/api/connectors', { source: 'gmail' }, { cookie }));

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ code: 'tier_required' });
    // The gate runs before the vendor call, so a refused connect costs nothing
    // and creates no external user to be billed for.
    expect(recorded.minted).toEqual([]);
  });

  test('a paid account gets a claim URL, once, for the authenticated tenant', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const response = await app()(post('/api/connectors', { source: 'gmail' }, { cookie }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    // The tenant is the authenticated one — never a field from the request body.
    expect(recorded.minted).toEqual([{ tenantId: TENANT, source: 'gmail' }]);
  });
});

describe('disconnect revokes polling', () => {
  test('an open ingest_pull job for that source is discarded', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await controlSql`
      INSERT INTO control.job (job_id, tenant_id, kind, target, state, trigger_reason, run_at, created_at, updated_at)
      VALUES (gen_random_uuid(), ${TENANT}, 'ingest_pull', 'gmail', 'due', 'connector_cadence', ${AT}, ${AT}, ${AT})`;
    await controlSql`
      INSERT INTO control.job (job_id, tenant_id, kind, target, state, trigger_reason, run_at, created_at, updated_at)
      VALUES (gen_random_uuid(), ${TENANT}, 'ingest_pull', 'calendar', 'due', 'connector_cadence', ${AT}, ${AT}, ${AT})`;

    const response = await app()(
      new Request(`${ORIGIN}/api/connectors`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'gmail' }),
      }),
    );

    expect(await response.json()).toMatchObject({
      ok: true,
      polling_stopped: 1,
      // Reported as the vendor reported it, and it stays `unverified` until the
      // compliance question is answered in writing.
      tokens_revoked: 'unverified',
    });
    expect(recorded.disconnected).toEqual([{ tenantId: TENANT, source: 'gmail' }]);

    // The calendar cadence is untouched: the unit of disconnection is the source.
    const rows = await controlSql<{ target: string; state: string }[]>`
      SELECT target::text AS target, state::text AS state FROM control.job ORDER BY target`;
    expect(rows).toEqual([
      { target: 'gmail', state: 'discarded' },
      { target: 'calendar', state: 'due' },
    ].sort((a, b) => a.target.localeCompare(b.target)));
  });
});

describe('BYOK entry', () => {
  test('a key is written through and never echoed back', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const response = await app()(
      post('/api/byok', { provider: 'openai', key: 'sk-a-key-the-user-typed-1234' }, { cookie }),
    );

    const payload = await response.text();
    expect(response.status).toBe(200);
    expect(payload).toContain('"last4":"1234"');
    // The whole key is never in a response body. The last four came from what
    // the caller just sent, not from a store this module can read.
    expect(payload).not.toContain('sk-a-key-the-user-typed-1234');

    expect(recorded.byokPuts).toEqual([
      { tenantId: TENANT, provider: 'openai', key: 'sk-a-key-the-user-typed-1234' },
    ]);
  });

  test('an unknown provider is refused before anything is written', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const response = await app()(post('/api/byok', { provider: 'acme', key: 'sk-x-1234' }, { cookie }));
    expect(response.status).toBe(400);
    expect(recorded.byokPuts).toEqual([]);
  });

  test('a key can be revoked', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await app()(
      new Request(`${ORIGIN}/api/byok`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai' }),
      }),
    );
    expect(recorded.byokRevokes).toEqual([{ tenantId: TENANT, provider: 'openai' }]);
  });
});

describe('spend and usage', () => {
  test('the view reads the deterministic debt counter, per R8', async () => {
    await reset();
    const cookie = await signedIn('free');
    await controlSql`
      UPDATE control.tenant SET spend_micro_usd = 12345, pending_debt = 7 WHERE tenant_id = ${TENANT}`;

    const payload = (await (await app()(get('/api/spend', { cookie }))).json()) as Record<string, unknown>;
    expect(payload).toMatchObject({ ok: true, spend_micro_usd: 12345, pending_debt: 7 });
    // R8 is explicit that the free tier's upgrade prompt must never read a
    // contradiction count, which is a paid artifact the free tier cannot see.
    expect(Object.keys(payload)).not.toContain('contradictions');
  });
});

describe('the connect flow', () => {
  test('the install link is the vendor-documented prefill URL', () => {
    const link = installLink({ mcpUrl: MCP_URL });
    const parsed = new URL(link);
    expect(parsed.origin + parsed.pathname).toBe('https://claude.ai/customize/connectors');
    expect(parsed.searchParams.get('modal')).toBe('add-custom-connector');
    expect(parsed.searchParams.get('connectorName')).toBe('brainz');
    expect(parsed.searchParams.get('connectorUrl')).toBe(MCP_URL);
  });

  test('the page says Add, then Connect, then authorize — not "one click"', async () => {
    await reset();
    const cookie = await signedIn();
    const page = await (await app()(get('/connect', { cookie }))).text();

    expect(page).toContain(escapeHtml(installLink({ mcpUrl: MCP_URL })));
    // The vendor's docs say the link only prefills. Copy that promised one click
    // and delivered three would be its own abandonment point.
    expect(page).toContain('Click Add');
    expect(page).toContain('Click Connect');
    expect(page).toContain('external link');
    expect(CONNECT_STEPS).toHaveLength(3);
  });

  test('the flow has an observable end state, not just instructions', async () => {
    await reset();
    const cookie = await signedIn();

    const before = (await (await app()(get('/api/connect', { cookie }))).json()) as {
      connection: { state: string };
    };
    expect(before.connection.state).toBe('never_connected');

    // U6's dispatch stamps `last_activity` on a user-originated call. That IS the
    // event the connect flow waits for; a second counter would be a second thing
    // to keep true.
    await controlSql`UPDATE control.tenant SET last_activity = ${AT} WHERE tenant_id = ${TENANT}`;

    const after = (await (await app()(get('/api/connect', { cookie }))).json()) as {
      connection: { state: string };
    };
    expect(after.connection.state).toBe('connected');
  });
});

describe('export config', () => {
  test('the affordance answers not_yet and names its owner rather than pretending', async () => {
    await reset();
    const cookie = await signedIn();
    const response = await app()(get('/api/export-config', { cookie }));
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ ok: false, code: 'not_yet', unit: 'U17' });
  });
});

describe('the webhook route is outside every cookie rule', () => {
  function signed(payload: string): string {
    const t = Math.floor(AT.getTime() / 1000);
    return `t=${t},v1=${createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex')}`;
  }

  test('a genuine delivery with no Origin and no cookie is accepted', async () => {
    // The CSRF check must not touch this route: a vendor POST carries no Origin
    // and never will, and a route that refused it would silently stop every
    // upgrade from landing.
    await reset();
    const cookie = await signedIn('free');
    expect(cookie.length).toBeGreaterThan(0);
    await sql`UPDATE account.subscription SET stripe_customer_id = 'cus_alice'`;

    const payload = JSON.stringify({
      id: 'evt_web',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_alice', customer: 'cus_alice', status: 'active' } },
    });
    const response = await app()(
      new Request(`${ORIGIN}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'stripe-signature': signed(payload) },
        body: payload,
      }),
    );

    expect(response.status).toBe(200);
    const tiers = await controlSql<{ tier: string }[]>`
      SELECT tier::text AS tier FROM control.tenant WHERE tenant_id = ${TENANT}`;
    expect(tiers[0]?.tier).toBe('paid');
  });

  test('a forged delivery is a 400 and changes nothing', async () => {
    await reset();
    await signedIn('free');
    await sql`UPDATE account.subscription SET stripe_customer_id = 'cus_alice'`;

    const payload = JSON.stringify({
      id: 'evt_forged_web',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_alice', customer: 'cus_alice', status: 'active' } },
    });
    const t = Math.floor(AT.getTime() / 1000);
    const forged = `t=${t},v1=${createHmac('sha256', 'whsec_not_the_secret').update(`${t}.${payload}`).digest('hex')}`;

    const response = await app()(
      new Request(`${ORIGIN}/api/billing/webhook`, {
        method: 'POST',
        headers: { 'stripe-signature': forged },
        body: payload,
      }),
    );

    expect(response.status).toBe(400);
    const tiers = await controlSql<{ tier: string }[]>`
      SELECT tier::text AS tier FROM control.tenant WHERE tenant_id = ${TENANT}`;
    expect(tiers[0]?.tier).toBe('free');
  });
});

describe('/admin over HTTP', () => {
  test('a wrong credential is refused', async () => {
    await reset();
    const response = await app()(get('/admin?op=fleet_status', { authorization: 'Bearer wrong' }));
    expect(response.status).toBe(401);
  });

  test('the operator credential runs fleet operations and is refused a content read', async () => {
    await reset();
    await seedTenant(controlSql, TENANT);

    const allowed = await app()(
      get('/admin?op=fleet_status', { authorization: `Bearer ${ADMIN_CREDENTIAL}` }),
    );
    expect(allowed.status).toBe(200);

    const denied = await app()(get('/admin?op=recall', { authorization: `Bearer ${ADMIN_CREDENTIAL}` }));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'scope_denied', tool: 'recall' });
  });

  test('a deployment with no admin credential has no /admin at all', async () => {
    await reset();
    const response = await app({ adminCredential: '' })(
      get('/admin?op=fleet_status', { authorization: 'Bearer anything' }),
    );
    // 404 rather than 401: an admin surface whose credential is unset is an
    // admin surface open to everybody, and the fail-closed direction is to not
    // be there.
    expect(response.status).toBe(404);
  });
});
