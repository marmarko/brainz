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

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { SQL } from 'bun';

import { ABSOLUTE_SESSION_MS, attachBrain } from '../../src/control/accounts.ts';
import type { ProviderId } from '../../src/ai/keys.ts';
import {
  FTS_LANGUAGE_CHOICES,
  SESSION_COOKIE,
  connectorGate,
  createWebApp,
  readCookie,
  sameOriginRefusal,
} from '../../src/web/app.ts';
import { CONNECT_STEPS, installLink } from '../../src/web/connect.ts';
import { BRAIN_SETUP_PATH, escapeHtml } from '../../src/web/pages.ts';
// The other fleet's page, imported rather than described: the sentence it prints
// is a claim about a page this one serves, and the two are separate processes.
import { noBrainYetPage } from '../../src/mcp/server.ts';
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
/**
 * What the fake provisioner answers. The same id `signedIn` seeds, so a signup
 * that provisions and a fixture that seeds describe one tenant rather than two.
 */
const PROVISIONED_TENANT = TENANT;

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
  severed: { tenantId: string; origin: string; confirm: string }[];
  provisioned: { ftsLanguage: string }[];
};

function app(
  overrides: {
    adminCredential?: string;
    severance?: boolean;
    /**
     * `false` composes the app the way a deployment with no Pipedream
     * configuration composes it. That is a legitimate deployment — chat exports
     * and folder imports need no vendor — so it has to be a state a test can
     * reach, not a comment.
     */
    connectors?: boolean;
    /** Make provisioning fail, so the signup handler's refusal arm is reachable. */
    provisioning?: 'ok' | 'fails';
    /**
     * Hold every provision open until this resolves.
     *
     * Real provisioning takes about fifteen seconds, and the fixture's answers
     * immediately — so without a gate the window a second press lands in does
     * not exist in a test, and a single-flight guard could be deleted with the
     * suite still green. The recording happens *before* the wait, so a test can
     * observe that the first request is inside the window before it makes the
     * second.
     */
    gate?: Promise<void>;
  } = {},
) {
  return createWebApp({
    sql,
    controlSql,
    provisioner: {
      async provision(request: { ftsLanguage: string }) {
        recorded.provisioned.push({ ...request });
        if (overrides.gate !== undefined) await overrides.gate;
        return overrides.provisioning === 'fails'
          ? ({ ok: false, reason: 'no_substrate_configured' } as const)
          : ({ ok: true, tenantId: PROVISIONED_TENANT, via: 'synchronous' } as const);
      },
    },
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
    ...(overrides.connectors === false
      ? {}
      : {
          connectors: {
            mintClaimUrl(request: { tenantId: string; source: string }) {
              recorded.minted.push({ ...request });
              return Promise.resolve({
                claimUrl: `${ORIGIN}/connect/claim/00000000-0000-4000-8000-000000000001#abcdefghijklmnop`,
                expiresAt: new Date(AT.getTime() + 600_000),
              });
            },
            disconnect(request: { tenantId: string; source: string }) {
              recorded.disconnected.push({ ...request });
              return Promise.resolve({ deleted: true, tokensRevoked: 'unverified' as const });
            },
          },
        }),
    // U18. Absent when `severance: false`, so the "no port wired" branch is a
    // state a test can reach rather than a comment — an endpoint that answered
    // ok for a severance nothing performed is the lie this port shape exists to
    // make impossible.
    ...(overrides.severance === false
      ? {}
      : {
          severance: {
            preview() {
              return Promise.resolve({
                removed: { pages: 2, chunks: 5, facts: 1 },
                recomputed: { facts: 3, entities: 2 },
                recomputeRequired: true,
                survivingOrigins: ['personal:mail'],
              });
            },
            execute(request: { tenantId: string; origin: string; confirm: string }) {
              recorded.severed.push({ ...request });
              return Promise.resolve({
                ok: true as const,
                severanceId: '7',
                alreadySevered: false,
              });
            },
          },
        }),
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
  recorded = { byokPuts: [], byokRevokes: [], minted: [], disconnected: [], severed: [], provisioned: [] };
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
  recorded = { byokPuts: [], byokRevokes: [], minted: [], disconnected: [], severed: [], provisioned: [] };
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

/**
 * **A deployment with no connector vendor, which is a legitimate one.**
 *
 * What this replaced: `web/serve.ts` supplied a vendor whose methods threw a
 * bare `Error`, so this route answered a generic 500 — a deployment fact
 * presented to the user as an outage.
 */
describe('a deployment with no connector vendor', () => {
  test('answers a typed 501 rather than a 500, and mints nothing', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const response = await app({ connectors: false })(
      post('/api/connectors', { source: 'gmail' }, { cookie }),
    );

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ ok: false, code: 'unavailable' });
    expect(recorded.minted).toEqual([]);
  });

  /**
   * **The ordering, which is the decision and not an accident of statement
   * order.**
   *
   * `connectorGate` answers 402 with copy that asks the user to pay. On a
   * deployment holding no vendor credential, no amount of paying makes a
   * connector work — so tier-first bills somebody for a capability the
   * deployment does not have and they learn otherwise on the retry. This
   * account is on the free tier and still gets the true answer first.
   */
  test('says so before it says `tier_required`', async () => {
    await reset();
    const cookie = await signedIn('free');
    const response = await app({ connectors: false })(
      post('/api/connectors', { source: 'gmail' }, { cookie }),
    );

    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ code: 'unavailable' });
  });

  test('disconnect refuses too, rather than reporting half of one as done', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const response = await app({ connectors: false })(
      new Request(`${ORIGIN}/api/connectors`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'gmail' }),
      }),
    );

    // `ok: true` with `vendor_deleted: false` would be the `applied: true` lie
    // one unit over, on the operation a user reaches for to make something stop.
    expect(response.status).toBe(501);
    expect(recorded.disconnected).toEqual([]);
  });

  test('the dashboard does not offer a button whose route answers 501', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const page = await (await app({ connectors: false })(get('/dashboard', { cookie }))).text();
    const offered = await (await app()(get('/dashboard', { cookie }))).text();
    // Whatever the page says about connectors, the two renders must differ:
    // a paid tenant on a vendor-less deployment is not a tenant with connectors.
    expect(page).not.toBe(offered);
  });
});

/**
 * **The operator grant (`/admin?op=grant_internal_tier`).**
 *
 * The founder owns this deployment and is blocked by a paywall they own:
 * billing is inert here (a placeholder webhook secret, no checkout trio), so no
 * account can ever become paid through Stripe. The grant is the deliberate way
 * through, and the two properties that make it safe are *who may ask* and
 * *what it is visible as afterwards*.
 */
describe('the operator tier grant', () => {
  const authorized = { authorization: `Bearer ${ADMIN_CREDENTIAL}` };

  /** `/admin` takes its arguments in the query string; the write needs POST. */
  function adminPost(op: string, tenantId?: string): Request {
    const query = tenantId === undefined ? `op=${op}` : `op=${op}&tenant_id=${tenantId}`;
    return new Request(`${ORIGIN}/admin?${query}`, {
      method: 'POST',
      headers: { origin: ORIGIN, ...authorized },
    });
  }

  test('grants the paid capability, and the connector route lets the tenant through', async () => {
    await reset();
    const cookie = await signedIn('free');

    // Free, and refused, before the grant.
    const before = await app()(post('/api/connectors', { source: 'gmail' }, { cookie }));
    expect(before.status).toBe(402);

    const granted = await app()(adminPost('grant_internal_tier', TENANT));
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({
      ok: true,
      content: { tenant_id: TENANT, tier: 'internal' },
    });

    const after = await app()(post('/api/connectors', { source: 'gmail' }, { cookie }));
    expect(after.status).toBe(200);
    expect(recorded.minted).toEqual([{ tenantId: TENANT, source: 'gmail' }]);
  });

  /**
   * **Both readers, because a grant that moves one is half a grant.** The
   * connector gate reads the subscription in the identity database; the
   * consolidation cycle reads `control.tenant.tier`. The row below is what
   * `src/control/tier.ts` reads, and `internal` is what it maps to `paid`.
   */
  test('moves the column the consolidation cycle reads, and leaves billing’s alone', async () => {
    await reset();
    await signedIn('free');
    await app()(adminPost('grant_internal_tier', TENANT));

    const control = await controlSql<{ tier: string }[]>`
      SELECT tier::text AS tier FROM control.tenant WHERE tenant_id = ${TENANT}`;
    expect(control[0]?.tier).toBe('internal');

    // Not `paid`: the identity store's own CHECK says a paid subscription names
    // a vendor object, precisely so a comp cannot be mistaken for one. Nobody
    // subscribed, and the row keeps saying so.
    const subscription = await sql<{ tier: string; status: string }[]>`
      SELECT tier::text AS tier, status::text AS status FROM account.subscription`;
    expect(subscription[0]).toMatchObject({ tier: 'free', status: 'none' });
  });

  test('is visible afterwards, by tenant and in the fleet’s own counts', async () => {
    await reset();
    await signedIn('free');
    await app()(adminPost('grant_internal_tier', TENANT));

    const status = await app()(
      get(`/admin?op=tenant_status&tenant_id=${TENANT}`, authorized),
    );
    expect(await status.json()).toMatchObject({ content: { tenant_id: TENANT, tier: 'internal' } });

    const fleet = (await (await app()(get('/admin?op=fleet_status', authorized))).json()) as {
      content: { tenants: { state: string; tier: string; count: number }[] };
    };
    expect(fleet.content.tenants).toContainEqual({ state: 'ready', tier: 'internal', count: 1 });
  });

  test('is revocable, and a revoke cannot downgrade a paying customer', async () => {
    await reset();
    await signedIn('free');
    await app()(adminPost('grant_internal_tier', TENANT));
    const revoked = await app()(adminPost('revoke_internal_tier', TENANT));
    expect(await revoked.json()).toMatchObject({ ok: true, content: { tier: 'free' } });

    // A tenant the vendor made paid is not this surface's to take back: the
    // webhook only writes on a delivery, so nothing would ever restore it.
    await controlSql`UPDATE control.tenant SET tier = 'paid' WHERE tenant_id = ${TENANT}`;
    const refused = await app()(adminPost('revoke_internal_tier', TENANT));
    expect(refused.status).toBe(400);
    const still = await controlSql<{ tier: string }[]>`
      SELECT tier::text AS tier FROM control.tenant WHERE tenant_id = ${TENANT}`;
    expect(still[0]?.tier).toBe('paid');
  });

  // ---- and the half that matters more: who cannot reach it. ---------------

  test('an ordinary signed-in user cannot grant themselves anything', async () => {
    await reset();
    const cookie = await signedIn('free');
    // A real session, the app's own origin, the exact operation — and no
    // operator credential, which is the only thing `/admin` authenticates on.
    const response = await app()(
      new Request(`${ORIGIN}/admin?op=grant_internal_tier&tenant_id=${TENANT}`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie },
      }),
    );

    expect(response.status).toBe(401);
    const rows = await controlSql<{ tier: string }[]>`
      SELECT tier::text AS tier FROM control.tenant WHERE tenant_id = ${TENANT}`;
    expect(rows[0]?.tier).toBe('free');
  });

  test('a deployment with no admin credential has no grant at all', async () => {
    await reset();
    await signedIn('free');
    const response = await app({ adminCredential: '' })(
      new Request(`${ORIGIN}/admin?op=grant_internal_tier&tenant_id=${TENANT}`, {
        method: 'POST',
        headers: { origin: ORIGIN, authorization: 'Bearer anything' },
      }),
    );
    expect(response.status).toBe(404);
    const rows = await controlSql<{ tier: string }[]>`
      SELECT tier::text AS tier FROM control.tenant WHERE tenant_id = ${TENANT}`;
    expect(rows[0]?.tier).toBe('free');
  });

  /**
   * A grant reachable by GET is a grant a bookmark, a copied URL in a ticket or
   * a shell-history recall can issue — with the tenant id sitting in the query
   * string of each. The credential is a header, so CSRF is not the hazard here;
   * the link is.
   */
  test('a GET cannot grant, however good the credential is', async () => {
    await reset();
    await signedIn('free');
    const response = await app()(
      get(`/admin?op=grant_internal_tier&tenant_id=${TENANT}`, authorized),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_params' });
    const rows = await controlSql<{ tier: string }[]>`
      SELECT tier::text AS tier FROM control.tenant WHERE tenant_id = ${TENANT}`;
    expect(rows[0]?.tier).toBe('free');
  });

  test('refuses a tenant that is not ready, rather than granting spend nobody can use', async () => {
    await reset();
    await signedIn('free');
    // `ready_at` goes with the state: `only_served_tenants_carry_a_ready_at` is
    // the schema refusing exactly the half-built row this case is about.
    await controlSql`
      UPDATE control.tenant SET state = 'provisioning', ready_at = NULL
       WHERE tenant_id = ${TENANT}`;
    const response = await app()(adminPost('grant_internal_tier', TENANT));
    expect(response.status).toBe(400);
    const rows = await controlSql<{ tier: string }[]>`
      SELECT tier::text AS tier FROM control.tenant WHERE tenant_id = ${TENANT}`;
    expect(rows[0]?.tier).toBe('free');
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
      // When the vendor made it. `billing.ts` orders deliveries on this, since
      // the vendor does not promise the order it delivers them in.
      created: Math.floor(AT.getTime() / 1000),
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
      created: Math.floor(AT.getTime() / 1000),
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

  test('AN EMPTY BEARER DOES NOT AUTHENTICATE, WHATEVER THE COMPARISON DOES', async () => {
    // The trap in the fix rather than in the bug. `constantTimeEqual` digests
    // both sides first, so `constantTimeEqual('', '')` is **true** — an empty
    // presented credential against an unset configured one would authenticate
    // if the comparison ran before the unset check. The order below is
    // load-bearing and this is what pins it.
    await reset();
    const missing = await app({ adminCredential: '' })(get('/admin?op=fleet_status', {}));
    expect(missing.status).toBe(404);

    // And with a credential configured, an absent header is a refusal.
    const empty = await app()(get('/admin?op=fleet_status', {}));
    expect(empty.status).toBe(401);
  });

  test('THE CREDENTIAL IS NOT COMPARED IN A WAY THAT LEAKS ITS LENGTH', async () => {
    // **Asserted structurally, because the defect is not observable in a
    // response.** A `!==` on two secrets returns the same 401 as a constant-time
    // compare; what differs is how long it takes, and a timing assertion in a
    // unit suite is a flake generator rather than a proof. What *is* checkable,
    // deterministically, is that the call site routes through the one primitive
    // written for this — `accounts.ts:constantTimeEqual`, whose own comment says
    // `src/web/` needs it — and that no length test on the credential survives
    // beside it. `test/mcp/guards.test.ts` and `test/ai/boundary.test.ts` make
    // the same kind of claim for the same reason: the invariant outlives the
    // reviewer who knows about it.
    //
    // A short-circuiting comparison leaks twice over. `offered.length !==
    // configured.length` answers "how long is the credential" in one request,
    // and `offered !== configured` then walks the bytes and stops at the first
    // difference — which is the classic character-at-a-time recovery, on the
    // one endpoint that reads every tenant's operational state.
    const source = readFileSync(`${import.meta.dir}/../../src/web/app.ts`, 'utf8');
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(executable).toContain('constantTimeEqual(offered, configured)');
    // The length comparison specifically, in either direction.
    expect(executable).not.toMatch(/offered\.length\s*[!=]==\s*configured\.length/);
    expect(executable).not.toMatch(/configured\.length\s*[!=]==\s*offered\.length/);
    // And the raw string comparison it was paired with.
    expect(executable).not.toMatch(/offered\s*[!=]==\s*configured/);
  });
});

// ---------------------------------------------------------------------------
// The pages have to be able to drive the API they post to.
//
// Every test above sends `application/json`, which is what a fetch() would send
// and is not what `pages.ts` sends: an HTML form posts
// `application/x-www-form-urlencoded`. A suite that only ever speaks JSON would
// stay green with the login form permanently broken, which is exactly the shape
// of bug that ships when the deliverable is an API and the pages are an
// afterthought.
// ---------------------------------------------------------------------------

function form(path: string, fields: Record<string, string>, options: { cookie?: string } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    origin: ORIGIN,
  };
  if (options.cookie !== undefined) headers['cookie'] = options.cookie;
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(fields).toString(),
  });
}

describe('the rendered forms can drive the API they post to', () => {
  test('every form on every page posts to a route that exists', async () => {
    await reset();
    const cookie = await signedIn();
    // The recovery page renders for an account with no brain and redirects for
    // one that has it, so it needs a session of its own to be covered here at
    // all — and it is exactly the page whose form nothing was checking.
    const stuckFailed = await app({ provisioning: 'fails' })(
      post('/api/signup', {
        email: 'stranded@example.com',
        password: 'correct horse battery staple',
        fts_language: 'simple',
      }),
    );
    expect(stuckFailed.status).toBe(503);
    const stuck = cookieOf(
      await app()(
        post('/api/login', {
          email: 'stranded@example.com',
          password: 'correct horse battery staple',
        }),
      ),
    );
    const pages = [
      await (await app()(get('/login'))).text(),
      await (await app()(get('/signup'))).text(),
      await (await app()(get('/dashboard', { cookie }))).text(),
      await (await app()(get('/password/reset'))).text(),
      await (await app()(get(BRAIN_SETUP_PATH, { cookie: stuck }))).text(),
    ];

    const actions = new Set<string>();
    for (const page of pages) {
      for (const match of page.matchAll(/<form[^>]*action="([^"]+)"/g)) actions.add(match[1] ?? '');
      for (const match of page.matchAll(/href="(\/[^"]*)"/g)) actions.add(match[1] ?? '');
    }
    expect(actions.size).toBeGreaterThan(3);

    for (const action of actions) {
      if (action.startsWith('/api/')) continue;
      const response = await app()(get(action, { cookie }));
      // A page a link points at must not be the 404 the router falls through to.
      expect(`${action} -> ${response.status}`).not.toContain('-> 404');
    }
  });

  test('a form-encoded signup is accepted and lands the user somewhere', async () => {
    await reset();
    const response = await app()(
      form('/api/signup', {
        email: 'alice@example.com',
        password: 'correct horse battery staple',
        fts_language: 'simple',
      }),
    );
    expect([201, 303]).toContain(response.status);
    expect(response.headers.get('set-cookie') ?? '').toContain('HttpOnly');
  });

  test('a form-encoded login signs in — the JSON-only parser returned invalid_credentials', async () => {
    await reset();
    await signedIn();
    await app()(post('/api/logout', {}, {}));

    const response = await app()(
      form('/api/login', { email: 'alice@example.com', password: 'correct horse battery staple' }),
    );
    expect([200, 303]).toContain(response.status);
    expect(response.headers.get('set-cookie') ?? '').toContain(SESSION_COOKIE);
  });

  /**
   * The return path, which exists for exactly one caller: `/authorize` on the
   * MCP fleet redirects an unauthenticated browser here mid-flow. Without it the
   * user signs in, lands on a dashboard, and the connection they were halfway
   * through authorising is gone with no sign it was ever in progress.
   *
   * The refusals are the interesting half. A login form that redirects wherever
   * it is told is an open redirector, and the classic use is a phishing link
   * that passes through the real sign-in page — same origin, real form — and
   * lands on the attacker's.
   */
  describe('signing in mid-flow', () => {
    const RETURN = '/authorize?client_id=bzc_1&state=s&redirect_uri=https%3A%2F%2Fclaude.ai%2Fcb';

    test('the login page carries the return path through the form', async () => {
      const page = await (
        await app()(get(`/login?next=${encodeURIComponent(RETURN)}`))
      ).text();
      expect(page).toContain('name="next"');
      // Escaped, not interpolated: the value arrives on a query string.
      expect(page).toContain(escapeHtml(RETURN));
    });

    test('and the login lands back there rather than on the dashboard', async () => {
      await reset();
      await signedIn();
      await app()(post('/api/logout', {}, {}));

      const response = await app()(
        form('/api/login', {
          email: 'alice@example.com',
          password: 'correct horse battery staple',
          next: RETURN,
        }),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe(RETURN);
    });

    test.each([
      ['an absolute URL', 'https://evil.example/steal'],
      ['a protocol-relative URL', '//evil.example/steal'],
      ['a backslash host', '/\\evil.example/steal'],
      ['some other page of ours', '/dashboard?x=1'],
      ['a path that merely contains the prefix', '/redirect?to=/authorize?a=b'],
      ['an encoded prefix', '%2Fauthorize%3Fclient_id%3Dx'],
    ])('refuses %s and goes to the dashboard instead', async (_name, next) => {
      await reset();
      await signedIn();
      await app()(post('/api/logout', {}, {}));

      const response = await app()(
        form('/api/login', {
          email: 'alice@example.com',
          password: 'correct horse battery staple',
          next,
        }),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/dashboard');

      // …and the login page does not echo it into the form either.
      const page = await (await app()(get(`/login?next=${encodeURIComponent(next)}`))).text();
      expect(page).not.toContain('name="next"');
    });
  });

  test('the signup page offers the language choice the API requires', async () => {
    // The API refuses a signup with no language, per KTD9. A page with no field
    // for it would make the product unusable through its own front door.
    const page = await (await app()(get('/signup'))).text();
    expect(page).toContain('name="fts_language"');
    expect(page).toContain('action="/api/signup"');
  });
});

describe('the session cookie outlives the idle window', () => {
  test('Max-Age is the absolute window, not the idle one', async () => {
    // The server enforces idle expiry on every read. If the cookie's own Max-Age
    // were the idle window, the browser would delete it at seven days however
    // active the user was, and the thirty-day absolute window would be
    // unreachable — a session policy that never applies.
    await reset();
    const response = await app()(
      post('/api/signup', {
        email: 'alice@example.com',
        password: 'correct horse battery staple',
        fts_language: 'simple',
      }),
    );
    const cookie = response.headers.get('set-cookie') ?? '';
    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)?.[1] ?? '0');
    expect(maxAge).toBe(Math.floor(ABSOLUTE_SESSION_MS / 1000));
  });
});

// ---------------------------------------------------------------------------
// The account a failed signup leaves behind, and the way out of it.
//
// `POST /api/brain` has existed since the retry was written and nothing rendered
// a form or a link to it: the documented recovery was reachable only by hand,
// from a browser console. What that costs is not hypothetical — a founder whose
// brain was destroyed signed in, found a dashboard about a brain they did not
// have, and had no affordance anywhere in the product that could build one.
//
// So these assert the *affordance*, not the route. A test that posted to
// `/api/brain` would have passed on the day the defect shipped.
// ---------------------------------------------------------------------------

describe('a signed-in account with no brain', () => {
  const STUCK = 'stuck@example.com';
  const PASSWORD = 'correct horse battery staple';

  /**
   * The state a failed signup leaves: the address is taken, the password works,
   * and there is no `account.brain` row.
   */
  async function stranded(): Promise<string> {
    const failed = await app({ provisioning: 'fails' })(
      post('/api/signup', { email: STUCK, password: PASSWORD, fts_language: 'simple' }),
    );
    expect(failed.status).toBe(503);
    // No session either — provisioning is refused before the cookie is written.
    expect(failed.headers.get('set-cookie')).toBeNull();

    const signedIn = await app()(post('/api/login', { email: STUCK, password: PASSWORD }));
    expect(signedIn.status).toBe(200);
    // The failed attempt is not the subject of any assertion below.
    recorded.provisioned = [];
    return cookieOf(signedIn);
  }

  test('is offered a brain on the page it actually lands on', async () => {
    await reset();
    const cookie = await stranded();

    // Every page a signed-in user reaches by default. A dashboard about a brain
    // that does not exist is a page whose every button answers `no_brain_yet`,
    // and the connect flow behind it dead-ends at the MCP fleet's 409.
    for (const path of ['/', '/dashboard', '/connect']) {
      const response = await app()(get(path, { cookie }));
      expect({ path, status: response.status }).toEqual({ path, status: 303 });
      expect({ path, to: response.headers.get('location') }).toEqual({ path, to: BRAIN_SETUP_PATH });
    }

    const page = await app()(get(BRAIN_SETUP_PATH, { cookie }));
    expect(page.status).toBe(200);
    const text = await page.text();
    // The affordance itself: a form on the page, posting to the route that
    // provisions. A link to documentation would satisfy a weaker assertion.
    expect(text).toContain('action="/api/brain"');
    expect(text).toContain('method="post"');
  });

  test('and an account that has one is not shown a form to build a second', async () => {
    await reset();
    const cookie = await signedIn();
    const response = await app()(get(BRAIN_SETUP_PATH, { cookie }));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/dashboard');
  });

  describe('the form asks for the language, the way signup does', () => {
    test('it offers the API’s own list rather than a second copy of it', async () => {
      await reset();
      const cookie = await stranded();
      const text = await (await app()(get(BRAIN_SETUP_PATH, { cookie }))).text();

      expect(text).toContain('name="fts_language"');
      for (const language of FTS_LANGUAGE_CHOICES) {
        expect({ value: language.value, offered: text.includes(`value="${language.value}"`) }).toEqual({
          value: language.value,
          offered: true,
        });
      }
    });

    test('and preselects nothing — a default here is KTD9’s anglicisation by other means', async () => {
      await reset();
      const cookie = await stranded();
      const pages = [
        await (await app()(get(BRAIN_SETUP_PATH, { cookie }))).text(),
        // The front door has the same hazard and the same fix: a browser selects
        // the first option of a `select` on its own, so a list whose first entry
        // is a real language *is* a default, however absent the word `selected`.
        await (await app()(get('/signup'))).text(),
      ];
      for (const page of pages) {
        const options = [...page.matchAll(/<option value="([^"]*)"([^>]*)>/g)];
        expect(options.length).toBeGreaterThan(FTS_LANGUAGE_CHOICES.length - 1);
        const first = options[0];
        expect(first?.[1]).toBe('');
        expect(first?.[2] ?? '').toContain('selected');
        // …and no real language is preselected either.
        for (const option of options.slice(1)) {
          expect({ value: option[1], selected: (option[2] ?? '').includes('selected') }).toEqual({
            value: option[1],
            selected: false,
          });
        }
      }
    });

    test('a build with no language is refused, and nothing is provisioned', async () => {
      await reset();
      const cookie = await stranded();

      const refused = await app()(form('/api/brain', {}, { cookie }));
      expect(refused.status).toBe(400);
      // The refusal a browser can read, and the form again so the fix is one
      // press away rather than a back button and a re-typed URL.
      expect(refused.headers.get('content-type')).toContain('text/html');
      const text = await refused.text();
      expect(text).toContain('action="/api/brain"');
      expect(text).not.toContain('"code":');
      // The half that makes the refusal a control rather than a message.
      expect(recorded.provisioned).toEqual([]);

      // A `fetch` still gets the typed body it has always got.
      const asJson = await app()(post('/api/brain', {}, { cookie }));
      expect(asJson.status).toBe(400);
      expect(await asJson.json()).toMatchObject({ code: 'fts_language_required' });
      expect(recorded.provisioned).toEqual([]);
    });
  });

  test('a build that works lands the browser on the connect flow, not on a JSON body', async () => {
    await reset();
    const cookie = await stranded();

    const built = await app()(form('/api/brain', { fts_language: 'french' }, { cookie }));
    expect(built.status).toBe(303);
    expect(built.headers.get('location')).toBe('/connect');
    // The language the user chose, carried through to the thing that was built.
    expect(recorded.provisioned).toEqual([{ ftsLanguage: 'french' }]);

    const me = (await (await app()(get('/api/me', { cookie }))).json()) as {
      brain: { tenant_id: string; fts_language: string } | null;
    };
    expect(me.brain).toEqual({ tenant_id: PROVISIONED_TENANT, fts_language: 'french' });

    // And the page that offered the form now sends them on rather than offering
    // to build a second one.
    const again = await app()(get(BRAIN_SETUP_PATH, { cookie }));
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe('/dashboard');
  });

  test('a build that fails says what to do about it, rather than answering with a body', async () => {
    await reset();
    const cookie = await stranded();

    // One instance for both presses: the in-flight guard lives in the running
    // process, and a guard released only on success would wedge this account
    // into `already building` for the lifetime of the deployment — a worse bug
    // than the double-press it exists to refuse.
    const failing = app({ provisioning: 'fails' });
    const failed = await failing(form('/api/brain', { fts_language: 'french' }, { cookie }));
    expect(failed.status).toBe(503);
    expect(failed.headers.get('content-type')).toContain('text/html');
    const text = await failed.text();
    // Not swallowed: the page says a build was attempted and did not happen.
    expect(text).toContain('could not build your brain');
    // Actionable, and the retry is on the page rather than in a support article.
    expect(text).toContain('action="/api/brain"');
    expect(text).not.toContain('provisioning_unavailable');
    // The copy a signed-in user cannot act on. `Sign in and try again` is the
    // signup path's sentence and it is nonsense to somebody already signed in.
    expect(text).not.toContain('Sign in and try again');

    // Again, on the same instance: still a build that failed, never `409`.
    const retried = await failing(form('/api/brain', { fts_language: 'french' }, { cookie }));
    expect(retried.status).toBe(503);
    expect(recorded.provisioned).toEqual([{ ftsLanguage: 'french' }, { ftsLanguage: 'french' }]);

    const asJson = await app({ provisioning: 'fails' })(
      post('/api/brain', { fts_language: 'french' }, { cookie }),
    );
    expect(asJson.status).toBe(503);
    expect(await asJson.json()).toMatchObject({ code: 'provisioning_unavailable' });
  });

  test('a second press while the first is still building does not buy a second brain', async () => {
    await reset();
    const cookie = await stranded();

    // Provisioning takes about fifteen seconds against a real substrate. A page
    // that appears to hang is one a user presses again, and two pool projects
    // for one account is real money plus an orphan nobody is looking for.
    let build = (): void => {};
    const gate = new Promise<void>((resolve) => {
      build = resolve;
    });
    // One app instance: the guard lives in the running process, and two
    // instances would be two processes as far as it is concerned.
    const handle = app({ gate });

    const first = handle(form('/api/brain', { fts_language: 'french' }, { cookie }));
    // Wait until the first request is genuinely inside the window rather than
    // guessing at a delay.
    while (recorded.provisioned.length === 0) await Bun.sleep(1);

    const second = handle(form('/api/brain', { fts_language: 'german' }, { cookie }));
    // Not awaited yet, and the gate is released below before it is: a press that
    // got through the guard would be *inside* the provisioner right now, and a
    // test that awaited it would report that as a timeout rather than as the
    // second brain it is.
    await Bun.sleep(50);
    // Not a second project, and not the second tab's language quietly
    // substituted for the first tab's either.
    expect(recorded.provisioned).toEqual([{ ftsLanguage: 'french' }]);

    build();
    const refused = await second;
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('already being built');

    const settled = await first;
    expect(settled.status).toBe(303);
    expect(settled.headers.get('location')).toBe('/connect');
    expect(recorded.provisioned).toEqual([{ ftsLanguage: 'french' }]);

    // …and the guard is released, so a later press is answered by the idempotent
    // read rather than by a wedged account.
    const later = await handle(form('/api/brain', { fts_language: 'french' }, { cookie }));
    expect(later.status).toBe(303);
    expect(later.headers.get('location')).toBe('/dashboard');
    expect(recorded.provisioned).toEqual([{ ftsLanguage: 'french' }]);
  });

  /**
   * The two fleets have to agree, and they are two processes.
   *
   * `/authorize` on the MCP fleet renders the no-brain page; the page that can
   * build one is on the web fleet. Today that page says *"Open your dashboard —
   * it can build one"*, and the dashboard cannot: a stuck user is sent to a page
   * with nothing on it for them, which is worse than saying nothing because they
   * stop looking.
   *
   * So this follows the link across the boundary rather than reading either side
   * alone. No redirect hop is allowed: a page that merely *leads* to the
   * affordance is the sentence that was false.
   */
  test('the page the MCP fleet sends a stuck user to is the page that can build one', async () => {
    await reset();
    const cookie = await stranded();

    const rendered = noBrainYetPage(ORIGIN);
    expect(rendered.status).toBe(409);
    const page = await rendered.text();
    // The state it is about, kept in the words `test/mcp/oauth/consent.test.ts`
    // asserts on.
    expect(page.toLowerCase()).toContain('no brain');

    const paths = [...page.matchAll(/href="([^"]+)"/g)]
      .map((match) => match[1] ?? '')
      .filter((href) => href.startsWith(ORIGIN))
      .map((href) => new URL(href).pathname);
    expect(paths.length).toBeGreaterThan(0);

    for (const path of paths) {
      const response = await app()(get(path, { cookie }));
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      expect({ path, offers: (await response.text()).includes('action="/api/brain"') }).toEqual({
        path,
        offers: true,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// U18 — the severance surface.
// ---------------------------------------------------------------------------

describe('context severance', () => {
  beforeEach(reset);

  test(
    'the preview returns BOTH columns, not just what would be removed',
    async () => {
      const cookie = await signedIn();
      const response = await app()(get('/api/severance/preview?origin=work:mail', { cookie }));
      expect(response.status).toBe(200);

      const payload = (await response.json()) as {
        removed: Record<string, number>;
        recomputed: Record<string, number>;
        recompute_required: boolean;
        surviving_origins: string[];
      };
      expect(payload.removed.chunks).toBe(5);
      // The column a preview that only counted deletions would omit — and the
      // one that tells the user severing work also costs them their shared
      // history with everyone they know through both accounts.
      expect(payload.recomputed.facts).toBe(3);
      expect(payload.recompute_required).toBe(true);
      expect(payload.surviving_origins).toEqual(['personal:mail']);
    },
    60_000,
  );

  test(
    'severance refuses without an echo of the origin, and the port is never called',
    async () => {
      const cookie = await signedIn();
      const response = await app()(
        post('/api/severance', { origin: 'work:mail', confirm: 'yes' }, { cookie }),
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe('not_confirmed');
      // The half that matters: a route that refused *after* calling the port
      // would be a route whose refusal is a message rather than a control.
      expect(recorded.severed).toEqual([]);
    },
    60_000,
  );

  test(
    'a confirmed severance reaches the port and stops the polling',
    async () => {
      const cookie = await signedIn();
      await controlSql`
        INSERT INTO control.job (job_id, tenant_id, kind, target, state, trigger_reason,
                                 run_at, created_at, updated_at)
        VALUES (gen_random_uuid(), ${TENANT}, 'ingest_pull', 'gmail', 'due',
                'connector_cadence', ${AT}, ${AT}, ${AT})`;

      const response = await app()(
        post('/api/severance', { origin: 'work:mail', confirm: 'work:mail' }, { cookie }),
      );
      expect(response.status).toBe(200);
      const payload = (await response.json()) as { severance_id: string; polling_stopped: number };
      expect(payload.severance_id).toBe('7');
      expect(recorded.severed).toEqual([
        { tenantId: TENANT, origin: 'work:mail', confirm: 'work:mail' },
      ]);
      // Leaving the pull queued means the next worker re-imports what was just
      // severed, on a cadence, and the user watches their disconnection undo
      // itself.
      expect(payload.polling_stopped).toBe(1);
    },
    60_000,
  );

  test(
    'with no port wired the route refuses rather than reporting a severance nobody performed',
    async () => {
      const cookie = await signedIn();
      const response = await app({ severance: false })(
        post('/api/severance', { origin: 'work:mail', confirm: 'work:mail' }, { cookie }),
      );
      expect(response.status).toBe(501);
      expect(recorded.severed).toEqual([]);
    },
    60_000,
  );
});
