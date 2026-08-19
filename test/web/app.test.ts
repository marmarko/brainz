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
import { redactClaimUrls } from '../../src/ingest/pipedream/client.ts';
import {
  createPostgresConnectorLinks,
  ensureConnectorLinkSchema,
  markConnectPending,
} from '../../src/control/connector-pg.ts';
import { ensureConnectorHealthSchema } from '../../src/control/connector-health.ts';
import { generateSealingKeyMaterial, importSealingKey } from '../../src/control/sealed.ts';
import { connectSource } from '../../src/ingest/cursor.ts';
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
  /**
   * Each disconnect the vendor port was asked to perform — and, taken at the
   * moment it was asked, what the connector link and the job queue looked like.
   *
   * The snapshot is the ordering proof. A disconnect that told the vendor first
   * and cleared locally afterwards leaves a window in which a reconciliation
   * pass, holding a listing it read a moment ago, can still commit — and the
   * connection comes back with no vendor account behind it. Recording the state
   * *during* the vendor call is the only way to assert which side of that window
   * this app is on; asserting afterwards passes either way.
   */
  disconnected: { tenantId: string; source: string; linkState: string | null; openJobs: number }[];
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
    /**
     * What the vendor answers when asked to mint.
     *
     * A parameter rather than a constant because the claim URL is rendered as an
     * `href` on a page this app serves, and the vendor chooses that string. A
     * suite that only ever sees an `https:` link cannot tell a page that checks
     * the scheme from one that does not — and `escapeHtml` does not stop
     * `javascript:`, because there is nothing to escape in it.
     */
    claimUrl?: string;
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
                claimUrl:
                  overrides.claimUrl ??
                  `${ORIGIN}/connect/claim/00000000-0000-4000-8000-000000000001#abcdefghijklmnop`,
                expiresAt: new Date(AT.getTime() + 600_000),
              });
            },
            async disconnect(request: { tenantId: string; source: string }) {
              const link = (await controlSql`
                SELECT state FROM control.connector_link
                 WHERE tenant_id = ${request.tenantId}
                   AND source = ${request.source}::control.connector_source
              `) as Array<{ state: string | null }>;
              const open = (await controlSql`
                SELECT count(*)::int AS n FROM control.job
                 WHERE tenant_id = ${request.tenantId}
                   AND kind = 'ingest_pull'::control.job_kind
                   AND target = ${request.source}::control.job_target
                   AND state IN ('due', 'running')
              `) as Array<{ n: number }>;
              recorded.disconnected.push({
                ...request,
                linkState: link[0]?.state ?? null,
                openJobs: open[0]?.n ?? -1,
              });
              return { deleted: true, tokensRevoked: 'unverified' as const };
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

/**
 * A source this brain is actually connected to, written the way reconciliation
 * writes one.
 *
 * Through the real store rather than an INSERT, because the panel's whole
 * question is "does a connection exist", and a hand-built row would let the
 * table's shape and the reader's expectation drift apart without either test
 * noticing. The key is local to this suite: nothing here reads a state back.
 */
async function attachSource(source: 'gmail' | 'calendar' | 'drive'): Promise<void> {
  const key = await importSealingKey(generateSealingKeyMaterial());
  const links = createPostgresConnectorLinks({ sql: controlSql, key });
  await markConnectPending(controlSql, { tenantId: TENANT, source, now: AT });
  await links.adopt({
    tenantId: TENANT,
    source,
    fence: 0,
    state: connectSource({ source, externalUserId: `${TENANT}-${source}`, now: AT }),
  });
}

async function reset(): Promise<void> {
  await sql`DELETE FROM account.account`;
  await sql`DELETE FROM account.billing_event`;
  await controlSql`DELETE FROM control.job`;
  await controlSql`DELETE FROM control.connector_link`;
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
  // The connector link table, which `src/web/serve.ts` ensures at boot and this
  // suite composes past. `createControlPlane` applies `schema.sql` alone — the
  // tables a fleet ensures for itself are each ensured by whoever needs them,
  // the same way `oauth-sweep.test.ts` ensures the authorization store.
  await ensureConnectorLinkSchema(controlSql);
  // And the health table beside it, ensured at boot by the same entrypoint:
  // the dashboard reads a connector's last attempt out of it on every render.
  await ensureConnectorHealthSchema(controlSql);
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

  test('the dashboard is the way in to what you can still undo', async () => {
    // **The feature had exactly one door, and it was inside the room.** The only
    // link to `/retractions` in the whole app was on the notice you reach AFTER
    // clicking Restore, so the way to find out what you could undo was to have
    // already undone something. A recovery surface nobody can reach is the same
    // as no recovery surface, which is what the 72-hour promise had before it.
    await reset();
    const cookie = await signedIn();
    const page = await (await app()(get('/dashboard', { cookie }))).text();
    expect(page).toContain('href="/retractions"');
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
    expect(recorded.disconnected).toEqual([
      { tenantId: TENANT, source: 'gmail', linkState: null, openJobs: 0 },
    ]);

    // The calendar cadence is untouched: the unit of disconnection is the source.
    const rows = await controlSql<{ target: string; state: string }[]>`
      SELECT target::text AS target, state::text AS state FROM control.job ORDER BY target`;
    expect(rows).toEqual([
      { target: 'gmail', state: 'discarded' },
      { target: 'calendar', state: 'due' },
    ].sort((a, b) => a.target.localeCompare(b.target)));
  });

  /**
   * **A dead-lettered lane is the one a disconnect must clear, and it was the
   * one a disconnect left standing.**
   *
   * `enqueueDuePulls` counts `dead` as a lane already standing and enqueues
   * nothing over it — so a row this route left behind is not a stale record, it
   * is a permanent stop: the source is never polled again, by the cadence or by
   * anything else, including the reconnect the dashboard tells the user to
   * perform. `src/control/connector-lanes.ts` carries the argument; this is the
   * user-facing half of it.
   */
  test('a dead-lettered lane is cleared too, so a reconnect can actually poll again', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await controlSql`
      INSERT INTO control.job (
        job_id, tenant_id, kind, target, state, trigger_reason, attempts, max_attempts,
        run_at, created_at, updated_at, dead_lettered_at, failure_code)
      VALUES (gen_random_uuid(), ${TENANT}, 'ingest_pull', 'gmail', 'dead', 'connector_cadence',
        5, 5, ${AT}, ${AT}, ${AT}, ${AT}, 'handler_error')`;

    const response = await app()(
      new Request(`${ORIGIN}/api/connectors`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'gmail' }),
      }),
    );

    expect(await response.json()).toMatchObject({ ok: true, polling_stopped: 1 });
    const rows = await controlSql<{ state: string }[]>`
      SELECT state::text AS state FROM control.job WHERE target = 'gmail'`;
    expect(rows).toEqual([{ state: 'discarded' }]);
  });

  /**
   * **The ordering, asserted from inside the vendor call.**
   *
   * By the time the vendor is asked to revoke, this brain has already stopped:
   * the connector link is cleared and the fence advanced, and the queued pull is
   * discarded. Reverse the two and there is a window in which a reconciliation
   * pass — holding an account listing it read a moment ago — commits between the
   * vendor's delete and our own write, putting the connection back with nothing
   * behind it; and a window in which a worker claims the queued pull and polls
   * with a credential we have just asked to have revoked.
   *
   * `linkState` and `openJobs` are read *during* `vendor.disconnect`, because an
   * assertion made afterwards is true whichever order the two ran in.
   */
  test('the polling has already stopped by the time the vendor is asked', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await attachSource('gmail');
    await controlSql`
      INSERT INTO control.job (job_id, tenant_id, kind, target, state, trigger_reason, run_at, created_at, updated_at)
      VALUES (gen_random_uuid(), ${TENANT}, 'ingest_pull', 'gmail', 'due', 'connector_cadence', ${AT}, ${AT}, ${AT})`;

    await app()(
      new Request(`${ORIGIN}/api/connectors`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'gmail' }),
      }),
    );

    expect(recorded.disconnected).toEqual([
      { tenantId: TENANT, source: 'gmail', linkState: null, openJobs: 0 },
    ]);
  });

  /**
   * The fence, which is what a reconciliation pass already in flight loses to.
   * Clearing `pending_since` stops the *next* pass from asking; the fence is
   * what refuses the write of one that asked before any of this happened.
   */
  test('disconnect advances the fence a reconciler in flight is writing under', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await markConnectPending(controlSql, { tenantId: TENANT, source: 'gmail', now: AT });

    await app()(
      new Request(`${ORIGIN}/api/connectors`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'gmail' }),
      }),
    );

    const rows = (await controlSql`
      SELECT fence::text AS fence, pending_since AS pending
        FROM control.connector_link
       WHERE tenant_id = ${TENANT} AND source = 'gmail'::control.connector_source
    `) as Array<{ fence: string; pending: Date | null }>;
    expect(rows).toEqual([{ fence: '1', pending: null }]);
  });
});

describe('pressing connect records the intent before the user leaves', () => {
  /**
   * **The load-bearing write in the whole flow.** The user is about to leave for
   * the vendor's consent screen and owes this origin nothing afterwards — they
   * can authorize and close the tab. This row is what lets the fleet go and ask
   * the vendor later which accounts exist under this tenant's external user.
   * Without it there is no channel at all, which is the state `connectSource`
   * having no production caller describes.
   */
  test('a minted connect link leaves a pending link behind it', async () => {
    await reset();
    const cookie = await signedIn('paid');

    await app()(post('/api/connectors', { source: 'gmail' }, { cookie }));

    const rows = (await controlSql`
      SELECT source::text AS source, state, pending_since IS NOT NULL AS pending
        FROM control.connector_link WHERE tenant_id = ${TENANT}
    `) as Array<{ source: string; state: string | null; pending: boolean }>;
    expect(rows).toEqual([{ source: 'gmail', state: null, pending: true }]);
  });

  /**
   * Pressing connect on a source that is already polling must not un-connect it.
   * Adoption is create-only, so a link knocked back to "pending" would be
   * re-adopted from a *fresh* state — cursor `null` — and the mailbox would be
   * re-imported from scratch.
   */
  test('pressing connect again on a live connection does not disturb it', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await attachSource('gmail');

    await app()(post('/api/connectors', { source: 'gmail' }, { cookie }));

    const rows = (await controlSql`
      SELECT state IS NOT NULL AS connected, pending_since IS NULL AS quiet
        FROM control.connector_link WHERE tenant_id = ${TENANT}
    `) as Array<{ connected: boolean; quiet: boolean }>;
    expect(rows).toEqual([{ connected: true, quiet: true }]);
  });

  /**
   * A refusal writes nothing. The tier gate answers before the mint, so a free
   * account that reached this route leaves no link for a reconciliation pass to
   * find — which is what stops the gate being a front door with an open window.
   */
  test('a gated account leaves no pending link', async () => {
    await reset();
    const cookie = await signedIn('free');

    await app()(post('/api/connectors', { source: 'gmail' }, { cookie }));

    const rows = (await controlSql`
      SELECT count(*)::int AS n FROM control.connector_link WHERE tenant_id = ${TENANT}
    `) as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(0);
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

// ---------------------------------------------------------------------------
// The connector controls on the dashboard.
//
// **What was wrong.** The dashboard rendered `page.sources` as `<li>gmail</li>`
// — three words, no form, no button, no link — beside copy describing an action
// ("connecting opens a consent screen…") that had no control anywhere on the
// page. `POST /api/connectors` worked, the vendor was live, the worker was
// registered, and the founder went to connect Gmail and found nothing to click.
//
// **Why a test asserting the word `gmail` would have stayed green.** It was on
// the page. So every assertion below is about a *control*: a form whose action
// is the route, followed the way the "every form on every page" test above
// follows one — and, for the free tier, the absence of a control rather than
// different copy.
// ---------------------------------------------------------------------------

/** Every `<form action="…">` on a page, with the hidden fields it carries. */
function formsOn(page: string): { action: string; fields: Record<string, string> }[] {
  const found: { action: string; fields: Record<string, string> }[] = [];
  for (const match of page.matchAll(/<form[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    const fields: Record<string, string> = {};
    for (const input of (match[2] ?? '').matchAll(
      /<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"[^>]*>/g,
    )) {
      fields[input[1] ?? ''] = input[2] ?? '';
    }
    found.push({ action: match[1] ?? '', fields });
  }
  return found;
}

const SOURCES = ['gmail', 'calendar', 'drive'] as const;

describe('the dashboard offers a control per connector, not a list of words', () => {
  test('every source has a form whose action is the route that connects it', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const page = await (await app()(get('/dashboard', { cookie }))).text();

    const connectors = formsOn(page).filter((f) => f.action === '/api/connectors');
    // One per source, and each names its own source in a field rather than
    // relying on a button label the server never sees.
    expect(connectors.map((f) => f.fields['source']).sort()).toEqual([...SOURCES].sort());
    // A control, not a word: the page must carry a submit for each direction.
    for (const source of SOURCES) {
      expect(page).toContain(`name="intent" value="connect"`);
      expect(page).toContain(`name="intent" value="disconnect"`);
      expect(page).toContain(`value="${source}"`);
    }
  });

  test('following each rendered form reaches a route that exists', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const page = await (await app()(get('/dashboard', { cookie }))).text();

    for (const rendered of formsOn(page).filter((f) => f.action === '/api/connectors')) {
      const response = await app()(form(rendered.action, rendered.fields, { cookie }));
      // Not the router's 404, and not a 405 for a method the form cannot send.
      expect(`${rendered.fields['source']} -> ${response.status}`).not.toContain('-> 404');
      expect(`${rendered.fields['source']} -> ${response.status}`).not.toContain('-> 405');
    }
  });

  /**
   * **The trap, and the whole reason this is not a five-line change.**
   *
   * The app's policy is `default-src 'none'` with no `script-src` and
   * `form-action 'self'`. A browser enforces `form-action` against the
   * *redirect* a form POST answers, not only against the POST — that is what
   * `src/mcp/server.ts:htmlPage` widens the consent page's policy for. The
   * consent page can widen it because it knows the registered callback's origin
   * *before* it renders the form. This page cannot: the vendor's URL does not
   * exist until the mint, and the mint happens on the POST.
   *
   * So the POST must answer a page carrying the link, never a redirect to it.
   */
  test('a form connect answers a page carrying the link, and never a redirect to it', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const response = await app()(form('/api/connectors', { source: 'gmail' }, { cookie }));

    expect(response.status).toBe(200);
    // The failure this replaces: a 303 to the vendor, minted and undeliverable.
    expect(response.status).toBeLessThan(300);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('content-type')).toContain('text/html');

    const page = await response.text();
    const claim = `${ORIGIN}/connect/claim/00000000-0000-4000-8000-000000000001#abcdefghijklmnop`;
    expect(page).toContain(`href="${escapeHtml(claim)}"`);
    expect(recorded.minted).toEqual([{ tenantId: TENANT, source: 'gmail' }]);
  });

  test('the page carrying a capability refuses to be stored, and names no referrer', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const response = await app()(form('/api/connectors', { source: 'gmail' }, { cookie }));

    // A ten-minute single-use capability in a page a session restore could
    // re-render is the capability handed to whoever gets the machine next.
    expect(response.headers.get('cache-control')).toContain('no-store');
    // The link leaves this origin. `same-origin` already sends nothing
    // cross-origin; this page says it locally so a later relaxation of the
    // global policy cannot quietly start telling the vendor where the user
    // came from.
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    // The attribute rather than the exact string: `noopener` joined it when the
    // link learned to open a tab, and this guarantee is about what the browser
    // is told, not about the order of two tokens.
    expect(await response.text()).toMatch(/rel="[^"]*noreferrer[^"]*"/);
  });

  /**
   * **The vendor's page never comes back, so it must not take the dashboard with
   * it.**
   *
   * Pipedream's consent flow ends on a page that says *"You can now close this
   * window"* and issues no redirect — there is no return leg to wait for. A
   * same-tab navigation therefore leaves the user parked on a dead vendor page
   * with the back button as their only way home, at the exact moment they need
   * the dashboard to tell them whether the connection took.
   *
   * `target="_blank"` with **both** tokens spelled out: `noreferrer` is the
   * pre-existing guarantee and already implies `noopener` in current browsers,
   * and `noopener` is written beside it anyway because the opener handle is the
   * thing a new tab introduces and a later edit that relaxes the referrer rule
   * must not silently hand the vendor's page a handle on ours.
   *
   * No script anywhere near it: the response's CSP forbids inline JavaScript, so
   * a window-opening handler would be a control that does nothing.
   */
  test('the vendor link opens its own tab, and says so, because that page never returns', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const response = await app()(form('/api/connectors', { source: 'gmail' }, { cookie }));
    const page = await response.text();

    const anchor = /<a href="[^"]*claim[^"]*"[^>]*>/.exec(page)?.[0] ?? '';
    expect(anchor).toContain('target="_blank"');
    expect(anchor).toMatch(/rel="[^"]*noreferrer[^"]*"/);
    expect(anchor).toMatch(/rel="[^"]*noopener[^"]*"/);

    // The copy has to carry the same promise the attribute makes, or a new tab
    // is a surprise rather than an instruction.
    expect(page).toContain('new tab');
    expect(page).toContain('close');
    // And it has to say where to come back to, because the vendor will not send
    // them.
    expect(page).toContain('this page');

    // No script did it. A CSP that forbids inline JavaScript makes a scripted
    // opener a control that silently does nothing.
    expect(page).not.toContain('<script');
    expect(page).not.toContain('onclick');
  });

  test('the capability never reaches a URL — not the address bar, not history', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const response = await app()(form('/api/connectors', { source: 'gmail' }, { cookie }));
    expect(response.headers.get('location')).toBeNull();

    // And the dashboard itself never carries one, so the page a browser *does*
    // keep is a page with no capability on it.
    const dashboard = await (await app()(get('/dashboard', { cookie }))).text();
    expect(dashboard).not.toContain('/connect/claim/');
  });

  test('a link the vendor answered that is not http(s) is not rendered as one', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const hostile = app({ claimUrl: 'javascript:alert(document.cookie)' });
    const response = await hostile(form('/api/connectors', { source: 'gmail' }, { cookie }));

    const page = await response.text();
    // `escapeHtml` has nothing to escape in `javascript:` — the scheme check is
    // the control, and without it the vendor chooses what a click on this page
    // executes.
    expect(page).not.toContain('href="javascript:');
    expect(page).not.toContain('javascript:alert');
    expect(response.status).toBe(502);
  });
});

describe('disconnect, from a page that can only GET and POST', () => {
  test('the disconnect control asks before it revokes anything', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const response = await app()(
      form('/api/connectors', { source: 'gmail', intent: 'disconnect' }, { cookie }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const page = await response.text();
    // The confirmation is a form of its own, carrying the answer back.
    const asked = formsOn(page).filter((f) => f.action === '/api/connectors');
    expect(asked.length).toBe(1);
    expect(asked[0]?.fields).toMatchObject({ source: 'gmail', confirm: 'gmail', intent: 'disconnect' });
    // Nothing happened yet: no vendor call, no job touched.
    expect(recorded.disconnected).toEqual([]);
  });

  test('the confirmed disconnect revokes at the vendor and stops the polling', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await controlSql`
      INSERT INTO control.job (job_id, tenant_id, kind, target, state, trigger_reason, run_at, created_at, updated_at)
      VALUES (gen_random_uuid(), ${TENANT}, 'ingest_pull', 'gmail', 'due', 'connector_cadence', ${AT}, ${AT}, ${AT})`;

    const response = await app()(
      form(
        '/api/connectors',
        { source: 'gmail', intent: 'disconnect', confirm: 'gmail' },
        { cookie },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(recorded.disconnected).toMatchObject([{ tenantId: TENANT, source: 'gmail' }]);
    const rows = await controlSql<{ state: string }[]>`
      SELECT state::text AS state FROM control.job WHERE target = 'gmail'`;
    expect(rows[0]?.state).toBe('discarded');
    // And it says what happened rather than handing back a JSON body.
    const page = await response.text();
    expect(page).not.toStartWith('{');
    expect(page).toContain('gmail');
  });

  test('a POST disconnect whose confirmation does not match the source revokes nothing', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const response = await app()(
      post(
        '/api/connectors',
        { source: 'gmail', intent: 'disconnect', confirm: 'drive' },
        { cookie },
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'confirm_required' });
    expect(recorded.disconnected).toEqual([]);
  });

  test('DELETE is unchanged — an API caller that was explicit stays explicit', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const response = await app()(
      new Request(`${ORIGIN}/api/connectors`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'gmail' }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, tokens_revoked: 'unverified' });
    expect(recorded.disconnected).toMatchObject([{ tenantId: TENANT, source: 'gmail' }]);
  });

  test('an absent intent is a connect — the JSON callers that never sent one still work', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const response = await app()(post('/api/connectors', { source: 'gmail' }, { cookie }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true });
    expect(recorded.disconnected).toEqual([]);
  });
});

describe('the tier gate stays, and it is the control that is absent', () => {
  test('a free account is offered no connector control at all', async () => {
    await reset();
    const cookie = await signedIn('free');
    const page = await (await app()(get('/dashboard', { cookie }))).text();

    // Not "different copy" — no control. A button that 402s is the dead
    // affordance this whole change exists to remove.
    expect(formsOn(page).filter((f) => f.action === '/api/connectors')).toEqual([]);
    expect(page).not.toContain('name="intent"');
    // The honest explanation stays.
    expect(page).toContain('monthly fee');
  });

  test('a deployment with no vendor is offered no connector control at all', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const page = await (await app({ connectors: false })(get('/dashboard', { cookie }))).text();
    expect(formsOn(page).filter((f) => f.action === '/api/connectors')).toEqual([]);
  });

  test('and a form post from a free account is refused as a page, not as a body', async () => {
    await reset();
    const cookie = await signedIn('free');
    const response = await app()(form('/api/connectors', { source: 'gmail' }, { cookie }));

    // The status survives — a 303 would report a refusal as a success in every
    // log — and the browser gets a sentence rather than `{"ok":false,…}`.
    expect(response.status).toBe(402);
    expect(response.headers.get('content-type')).toContain('text/html');
    const page = await response.text();
    expect(page).not.toStartWith('{');
    expect(page).toContain('monthly fee');
    expect(recorded.minted).toEqual([]);
  });
});

describe('the status beside each source says only what this brain can know', () => {
  test('with nothing connected it says so', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const page = await (await app()(get('/dashboard', { cookie }))).text();
    expect(page).toContain('Not connected');
  });

  /**
   * **The state the whole reconciliation flow exists to produce, and the one a
   * queue-only panel could not show.** A connection adopted a minute ago is
   * attached and has never been polled — the cadence pass runs on the worker
   * fleet's next wake. A panel that read only the queue would tell this user
   * "not connected", and they would press connect again.
   */
  test('a connection with no poll yet reads as connected and says the check is coming', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await attachSource('gmail');
    const page = await (await app()(get('/dashboard', { cookie }))).text();
    expect(page).toContain('The first check has not run yet');
    expect([...page.matchAll(/Not connected/g)].length).toBe(2);
  });

  /**
   * The other half of the same honesty: a user who pressed connect and has not
   * finished at the provider is told exactly that, rather than being shown a
   * page that looks as though nothing happened.
   */
  /**
   * **The panel's own note has to agree with what the panel now does.**
   *
   * It used to say the consent happens at the vendor and *"nothing tells this
   * page about it"* — true when written, and false the moment a dashboard render
   * began asking the vendor about this tenant's unfinished connects. A user
   * reading it is told the one thing that would make them give up: that coming
   * back here is pointless. That is the same dead affordance the panel exists to
   * stop being, in prose rather than in markup, and prose is where it survives a
   * suite that only asserts per-source status lines.
   *
   * Pinned on the claim rather than the sentence: what must not reappear is the
   * assertion that this page cannot find out.
   */
  test('the panel does not tell the user that coming back here is pointless', async () => {
    await reset();
    const cookie = await signedIn('paid');
    const page = await (await app()(get('/dashboard', { cookie }))).text();
    expect(page).not.toContain('nothing tells this page about it');
    expect(page).toContain('You do not have to come back here after authorizing');
  });

  test('a connect the user has not finished reads as started, not as connected', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await markConnectPending(controlSql, { tenantId: TENANT, source: 'gmail', now: new Date() });
    const page = await (await app()(get('/dashboard', { cookie }))).text();
    expect(page).toContain('You started connecting this');
  });

  test('an open pull on a live connection reads as a check in flight', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await attachSource('gmail');
    await controlSql`
      INSERT INTO control.job (job_id, tenant_id, kind, target, state, trigger_reason, run_at, created_at, updated_at)
      VALUES (gen_random_uuid(), ${TENANT}, 'ingest_pull', 'gmail', 'due', 'connector_cadence', ${AT}, ${AT}, ${AT})`;
    const page = await (await app()(get('/dashboard', { cookie }))).text();
    expect(page).toContain('A check is queued or running now');
  });

  /**
   * **This case used to assert that the page printed `handler_error`, and that
   * was the defect rather than the guarantee.**
   *
   * `handler_error` is `control.job`'s vocabulary for "a handler threw" — the
   * runner's generic bucket, which covers a revoked grant, an exhausted spend
   * cap, an unreachable brain and a bug in our own code in exactly the same
   * five syllables. Printing it at the person whose mail has stopped arriving
   * tells them nothing they can act on, and the instruction that used to follow
   * it — disconnect and connect again — is right for one of those causes and
   * wrong for the rest.
   *
   * So what is asserted now is the **cause**, which arrives from
   * `control.connector_health` in the ingest log's own vocabulary, and the fact
   * that the queue's code does NOT reach the page. A lane with no health record
   * (this one) says so plainly rather than inventing a reason.
   */
  test('a dead-lettered lane reads as failing, and does not print the queue’s own code at the user', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await attachSource('drive');
    await controlSql`
      INSERT INTO control.job (job_id, tenant_id, kind, target, state, trigger_reason,
                               run_at, created_at, updated_at, finished_at, dead_lettered_at, failure_code)
      VALUES (gen_random_uuid(), ${TENANT}, 'ingest_pull', 'drive', 'dead', 'connector_cadence',
              ${AT}, ${AT}, ${AT}, ${AT}, ${AT}, 'handler_error')`;
    const page = await (await app()(get('/dashboard', { cookie }))).text();
    expect(page).toContain('no longer being polled');
    expect(page).not.toContain('handler_error');
    expect(page).toContain('Nothing recorded why');
  });

  test('and when something did record why, the page says what it was', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await attachSource('drive');
    await controlSql`
      INSERT INTO control.job (job_id, tenant_id, kind, target, state, trigger_reason,
                               run_at, created_at, updated_at, finished_at, dead_lettered_at, failure_code)
      VALUES (gen_random_uuid(), ${TENANT}, 'ingest_pull', 'drive', 'dead', 'connector_cadence',
              ${AT}, ${AT}, ${AT}, ${AT}, ${AT}, 'handler_error')`;
    // What the worker banks at the end of a pull the provider refused. The job
    // row is unchanged from the case above — the only difference is that the
    // cause exists somewhere this page can read without a tenant connection.
    await controlSql`
      INSERT INTO control.connector_health (tenant_id, source, last_attempt_at, run_outcome, ingest_failure_code)
      VALUES (${TENANT}, 'drive'::control.connector_health_source, ${AT},
              'failed'::control.connector_run_outcome,
              'auth_expired'::control.connector_ingest_failure)`;
    const page = await (await app()(get('/dashboard', { cookie }))).text();
    expect(page).toContain('The provider stopped accepting our access');
    expect(page).toContain('Disconnecting and connecting again is the fix');
    expect(page).not.toContain('handler_error');
  });

  /**
   * A dead letter outlives a disconnect: `handleDisconnect` discards the `due`
   * and `running` rows and leaves the `dead` one, which is the record of what
   * was refused and is the whole value of a dead letter. Painting it red on a
   * source the user has removed would be a warning with no way to clear it
   * short of connecting the source again.
   */
  test('a dead lane on a source the user disconnected is not still shouting', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await controlSql`
      INSERT INTO control.job (job_id, tenant_id, kind, target, state, trigger_reason,
                               run_at, created_at, updated_at, finished_at, dead_lettered_at, failure_code)
      VALUES (gen_random_uuid(), ${TENANT}, 'ingest_pull', 'drive', 'dead', 'connector_cadence',
              ${AT}, ${AT}, ${AT}, ${AT}, ${AT}, 'handler_error')`;
    const page = await (await app()(get('/dashboard', { cookie }))).text();
    expect(page).not.toContain('handler_error');
    expect([...page.matchAll(/Not connected/g)].length).toBe(3);
  });

  /**
   * The rule `sourceStaleness` states for its own view, applied here: the most
   * recent *terminal* run wins, so a later success clears the code instead of
   * being reached past. A staleness display nobody can clear is one nobody
   * reads.
   */
  test('a success after a dead lane clears it rather than being reached past', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await attachSource('drive');
    await controlSql`
      INSERT INTO control.job (job_id, tenant_id, kind, target, state, trigger_reason,
                               run_at, created_at, updated_at, finished_at, dead_lettered_at, failure_code)
      VALUES (gen_random_uuid(), ${TENANT}, 'ingest_pull', 'drive', 'dead', 'connector_cadence',
              ${AT}, ${AT}, ${AT}, ${AT}, ${AT}, 'handler_error')`;
    await controlSql`
      INSERT INTO control.job (job_id, tenant_id, kind, target, state, trigger_reason,
                               run_at, created_at, updated_at, finished_at)
      VALUES (gen_random_uuid(), ${TENANT}, 'ingest_pull', 'drive', 'done', 'connector_cadence',
              ${AT}, ${AT}, ${AT}, ${new Date(AT.getTime() + 60_000)})`;
    const page = await (await app()(get('/dashboard', { cookie }))).text();
    expect(page).not.toContain('handler_error');
    expect(page).toContain('Last checked');
  });

  /**
   * A disconnect writes `discarded` rows. Reading those as evidence of anything
   * would make the act of disconnecting render as a failure on the next page
   * load — the user pressed stop and is told something is broken.
   */
  /**
   * **The way back from a dead lane, for the person it happened to.**
   *
   * Until this existed, a connector that dead-lettered was recoverable in
   * exactly two ways: an operator with a SQL client, or the user walking through
   * their provider's consent screen again to recover from a failure that had
   * nothing to do with their permission. The first is not a product and the
   * second charges the user for our outage.
   *
   * Three properties, and the third is the one that could go wrong quietly.
   */
  async function deadLane(
    source: 'gmail' | 'calendar' | 'drive',
    counters: { attempts: number; maxAttempts: number },
  ): Promise<void> {
    await controlSql`
      INSERT INTO control.job (job_id, tenant_id, kind, target, state, trigger_reason,
                               attempts, max_attempts,
                               run_at, created_at, updated_at, finished_at, dead_lettered_at, failure_code)
      VALUES (gen_random_uuid(), ${TENANT}, 'ingest_pull', ${source}::control.job_target, 'dead',
              'connector_cadence', ${counters.attempts}, ${counters.maxAttempts},
              ${AT}, ${AT}, ${AT}, ${AT}, ${AT}, 'handler_error')`;
  }

  async function laneRow(source: string): Promise<{ state: string; attempts: number } | undefined> {
    const rows = (await controlSql`
      SELECT state::text AS state, attempts FROM control.job
       WHERE tenant_id = ${TENANT} AND target = ${source}::control.job_target`) as Array<{
      state: string;
      attempts: number;
    }>;
    return rows[0];
  }

  test('a lane that gave up offers a retry control, and it is a POST and not a link', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await attachSource('drive');
    await deadLane('drive', { attempts: 12, maxAttempts: 12 });

    const page = await (await app()(get('/dashboard', { cookie }))).text();
    expect(page).toContain('no longer being polled');
    expect(page).toContain('value="retry"');
    // The control writes, so it cannot be reachable by anything that follows an
    // `href`: a prefetching browser, a crawler, or a chat client unfurling a
    // pasted dashboard link would each silently re-open a lane the fleet closed.
    expect(page).not.toContain('href="/api/connectors');
  });

  test('a lane the provider blocked offers no retry control, because pressing it would do nothing', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await attachSource('drive');
    // Below its budget: only a terminal stop can produce this, and the remedy is
    // the user's rather than a button's.
    await deadLane('drive', { attempts: 1, maxAttempts: 12 });

    const page = await (await app()(get('/dashboard', { cookie }))).text();
    expect(page).toContain('we can no longer read it');
    expect(page).not.toContain('value="retry"');
  });

  test('pressing it puts the lane back in service without touching the connection', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await attachSource('drive');
    await deadLane('drive', { attempts: 12, maxAttempts: 12 });

    const answer = await app()(post('/api/connectors', { source: 'drive', intent: 'retry' }, { cookie }));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ ok: true, revived: true });
    expect(await laneRow('drive')).toEqual({ state: 'due', attempts: 0 });
    // No vendor call: a retry is a control-plane row moving, and a fleet whose
    // vendor configuration is broken is exactly the fleet full of dead lanes.
    expect(recorded.disconnected).toEqual([]);
    expect(recorded.minted).toEqual([]);
  });

  test('pressing it on a lane that is fine is not an error and changes nothing', async () => {
    // The violating case at the route. A second press, a reconnect in another
    // tab, or an operator who got there first all look like this — and each of
    // them must leave a HEALTHY lane's attempt count exactly where it was,
    // because resetting it would hand a connector that is currently failing an
    // unlimited retry budget.
    await reset();
    const cookie = await signedIn('paid');
    await attachSource('drive');
    await controlSql`
      INSERT INTO control.job (job_id, tenant_id, kind, target, state, trigger_reason,
                               attempts, max_attempts, run_at, created_at, updated_at)
      VALUES (gen_random_uuid(), ${TENANT}, 'ingest_pull', 'drive', 'due', 'connector_cadence',
              3, 12, ${AT}, ${AT}, ${AT})`;

    const answer = await app()(post('/api/connectors', { source: 'drive', intent: 'retry' }, { cookie }));
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ ok: true, revived: false, reason: 'no_dead_lane' });
    expect(await laneRow('drive')).toEqual({ state: 'due', attempts: 3 });
  });

  test('the rows a disconnect writes are not read as a failure', async () => {
    await reset();
    const cookie = await signedIn('paid');
    await controlSql`
      INSERT INTO control.job (job_id, tenant_id, kind, target, state, trigger_reason,
                               run_at, created_at, updated_at, finished_at)
      VALUES (gen_random_uuid(), ${TENANT}, 'ingest_pull', 'calendar', 'discarded', 'connector_cadence',
              ${AT}, ${AT}, ${AT}, ${AT})`;
    const page = await (await app()(get('/dashboard', { cookie }))).text();
    // Three sources, and calendar is back to the state it was in before it was
    // ever connected.
    expect([...page.matchAll(/Not connected/g)].length).toBe(3);
  });
});

/**
 * **Why `redactClaimUrls` is not the control on this surface, written down as a
 * check rather than as a comment.**
 *
 * `CLAIM_URL_PATTERN` matches what `client.ts:mintClaimUrl` produces —
 * `/connect/claim/<uuid>#<secret>` — which is brainz's own claim scheme, and
 * `src/web/connectors.ts` deliberately does not use it. What this app hands out
 * is the *vendor's* connect link, and that pattern does not match it. Wiring
 * redaction onto this page would therefore pass the real capability straight
 * through while reading, to the next person, as though it were covered.
 *
 * The controls that do apply are the ones the pages and headers above assert:
 * never logged, ten-minute vendor TTL, `no-store`, `no-referrer`, and never in
 * a URL.
 */
describe('the claim URL is a capability, and the redactor is not what guards it', () => {
  test('the vendor link this app hands out is not what redactClaimUrls matches', () => {
    const vendorLink = 'https://pipedream.com/_static/connect.html?token=ctok_abc&app=gmail';
    expect(redactClaimUrls(vendorLink)).toBe(vendorLink);
    // And the brainz-scheme URL it *does* match, so the assertion above is
    // about the pattern's scope rather than about a broken redactor.
    const brainzClaim = `${ORIGIN}/connect/claim/00000000-0000-4000-8000-000000000001#abcdefghijklmnop`;
    expect(redactClaimUrls(brainzClaim)).toBe('[redacted-claim-url]');
  });
});
