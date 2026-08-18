/**
 * The Connect client (U9 approach 1) and the claim URL.
 *
 * **The claim URL is a capability, not display copy.** Whoever holds it can
 * attach *their* Google account to *this* tenant's brain, which makes it the
 * highest-consequence string this unit produces. So it is short-TTL,
 * single-use, bound to the authenticated tenant, stored as a hash rather than
 * as itself, and redacted from anything that could be logged or re-ingested.
 * Every one of those is a test below, and each of them fails open in a
 * different way if it is written carelessly: a redeem that consumes on the
 * *wrong* secret is a denial-of-service, a redeem that does not consume at all
 * is a permanent grant, and a redeem that skips the tenant binding hands one
 * user's mailbox to another user's brain.
 *
 * **The proxy call's shape is no longer unverified** — it was measured against
 * the live project on 2026-08-17, after the shape this repo guessed turned out
 * to be one the vendor answers `404` to, and it is pinned by its own describe
 * block below. The rest of Assumption 1 still is unverified, and the honesty of
 * what this client reports back is the other half of what is tested here:
 * `tokensRevoked: 'unverified'` is the whole point of that field, and a test
 * pins it so nobody can quietly promote it to `'confirmed'` without a vendor
 * answer in `docs/vendor/`.
 */

import { describe, expect, test } from 'bun:test';

import {
  CLAIM_URL_PATTERN,
  DEFAULT_CLAIM_TTL_MS,
  classifyHttpFailure,
  createInMemoryClaimStore,
  createPipedreamClient,
  DEFAULT_BURST,
  createRateBudget,
  sharedRateBudget,
  mintClaimUrl,
  redactClaimUrls,
  redeemClaimUrl,
} from '../../../src/ingest/pipedream/client.ts';
import { CONFIG, createScriptedTransport, withToken } from './fixture.ts';

const NOW = new Date('2026-08-13T10:00:00.000Z');
const APP_BASE = 'https://app.example-brainz.test';

describe('the Connect token mint', () => {
  test('mints a token scoped to the external user id', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/tokens', {
      status: 200,
      body: {
        token: 'ctok_abc',
        expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
        connect_link_url: 'https://connect.example.test/start?token=ctok_abc',
      },
    });

    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });
    const outcome = await client.mintConnectToken({ externalUserId: 'tenant-a', now: NOW });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.token).toBe('ctok_abc');
    expect(outcome.value.connectLinkUrl).toContain('ctok_abc');

    const mint = transport.requests.find((request) => request.url.includes('/tokens'));
    expect(mint?.body).toContain('tenant-a');
    // The scope is the whole security property: a token minted without an
    // external user id is a token that can attach any account to any brain.
    expect(JSON.parse(mint?.body ?? '{}').external_user_id).toBe('tenant-a');
  });

  test('a refused mint is a typed failure, never an exception', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/tokens', { status: 403, body: { error: 'forbidden' } });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    const outcome = await client.mintConnectToken({ externalUserId: 'tenant-a', now: NOW });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('auth_expired');
  });

  test('the client secret never appears in a request path or query', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/tokens', { status: 200, body: { token: 't', expires_at: NOW.toISOString() } });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });
    await client.mintConnectToken({ externalUserId: 'tenant-a', now: NOW });

    for (const request of transport.requests) {
      expect(request.url).not.toContain(CONFIG.clientSecret);
    }
  });
});

describe('provider requests', () => {
  test('a provider call carries the external user id and the account', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/gmail/v1/users/me/messages', { status: 200, body: { messages: [] } });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    const outcome = await client.request({
      app: 'gmail',
      method: 'GET',
      path: '/gmail/v1/users/me/messages',
      query: { maxResults: 10 },
      externalUserId: 'tenant-a',
      accountId: 'apn_1',
    });

    expect(outcome.ok).toBe(true);
    const call = transport.requests.at(-1);
    // The scope is on the proxy URL and the upstream's own query is inside the
    // encoded target. This test used to read both out of the headers, which is
    // where they were sent and not where the vendor reads them; the shape is
    // pinned properly by the describe block below.
    const url = new URL(call?.url ?? '');
    expect(url.searchParams.get('external_user_id')).toBe('tenant-a');
    expect(url.searchParams.get('account_id')).toBe('apn_1');
    expect(call?.target).toContain('maxResults=10');
  });

  test('the access token is fetched once and reused', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/messages', { status: 200, body: { messages: [] } });
    transport.on('/messages', { status: 200, body: { messages: [] } });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    await client.request({ app: 'gmail', method: 'GET', path: '/messages', externalUserId: 'a', accountId: 'apn_1' });
    await client.request({ app: 'gmail', method: 'GET', path: '/messages', externalUserId: 'a', accountId: 'apn_1' });

    const tokenCalls = transport.requests.filter((request) => request.url.includes('/oauth/token'));
    expect(tokenCalls.length).toBe(1);
  });
});

/**
 * **The proxy call's shape, measured against the live project on 2026-08-17.**
 *
 * This is the detail the file header called unverified for four days while
 * every connector poll in production died on it: eight consecutive runs,
 * `provider_error`, `items_seen: 0`, across all three sources, each dying in
 * ~450ms at the provider call. The shape that was shipped —
 * `/proxy/{app}{path}` with the scope in `x-pd-*` headers — answers
 * `404 {"error":"Route not found"}`. The shape below answers `200`.
 *
 * Every assertion here was checked against the live vendor first, and the
 * transport fake reproduces the refusals it was seen to give, so the two halves
 * cannot drift back into agreeing with each other while both are wrong. The
 * measurements, in the order they were taken:
 *
 *   * `/proxy/{base64url(absolute upstream URL)}?external_user_id&account_id`
 *     → `200`, the real mailbox profile.
 *   * `/proxy/gmail/gmail/v1/users/me/profile` + `x-pd-external-user-id` +
 *     `x-pd-account-id` → `404 {"error":"Route not found"}`.
 *   * the upstream's own query INSIDE the encoded target → `200`, and the
 *     result is filtered (`maxResults=2` returned 2).
 *   * the same query on the PROXY URL → `200`, and the result IGNORED it. That
 *     is the failure this file guards hardest: not an outage, a connector that
 *     looks healthy and reads the wrong thing.
 *   * no `external_user_id` → `400 {"error":"External user ID missing"}`;
 *     no `account_id` → `400 {"error":"Account ID missing"}`.
 */
describe('the proxy call is shaped the way the vendor answers', () => {
  const GMAIL_PROFILE = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

  /** The proxy URL's own path segment, decoded the way the vendor decodes it. */
  function encodedTarget(url: string): string {
    const path = new URL(url).pathname;
    return path.slice(path.indexOf('/proxy/') + '/proxy/'.length);
  }

  function decode(segment: string): string {
    return Buffer.from(segment, 'base64url').toString('utf8');
  }

  test('the target is one absolute upstream URL, base64url-encoded into one path segment', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on(GMAIL_PROFILE, { status: 200, body: { emailAddress: 'someone@example.test' } });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    const outcome = await client.request({
      app: 'gmail',
      method: 'GET',
      path: '/gmail/v1/users/me/profile',
      externalUserId: 'tenant-a',
      accountId: 'apn_1',
    });
    expect(outcome.ok).toBe(true);

    const call = transport.requests.at(-1);
    const url = new URL(call?.url ?? '');
    const segment = encodedTarget(call?.url ?? '');

    // One segment, not several: a second `/` is what the vendor's router answers
    // `404 Route not found` to, and it is exactly what the app-relative shape
    // and a standard-base64 alphabet both produce.
    expect(segment).not.toContain('/');
    // base64**url**, padding stripped. `+`, `/` and `=` are each fatal in a URL
    // path segment, and a 44-character Drive file id — the everyday length —
    // puts the `?` at an offset where standard base64 emits a raw `/`.
    expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    // Asserted by DECODING what was built, never by re-deriving it.
    expect(decode(segment)).toBe(GMAIL_PROFILE);
    expect(url.pathname).toBe(`/v1/connect/${CONFIG.projectId}/proxy/${segment}`);
  });

  test('the scope is on the proxy URL and the upstream query is inside the target', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/gmail/v1/users/me/messages', { status: 200, body: { messages: [] } });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    await client.request({
      app: 'gmail',
      method: 'GET',
      path: '/gmail/v1/users/me/messages',
      query: { maxResults: 2, q: 'after:2026/08/01' },
      externalUserId: 'tenant-a',
      accountId: 'apn_1',
    });

    const call = transport.requests.at(-1);
    const url = new URL(call?.url ?? '');

    // **Exact set equality, not presence.** A `maxResults` that leaked onto the
    // proxy URL alongside the scope would still pass a presence check, and the
    // vendor answers 200 to it having silently dropped the parameter — an
    // unfiltered mailbox read that reports itself as a healthy pull.
    expect([...url.searchParams.keys()].sort()).toEqual(['account_id', 'external_user_id']);
    expect(url.searchParams.get('external_user_id')).toBe('tenant-a');
    expect(url.searchParams.get('account_id')).toBe('apn_1');

    const target = new URL(decode(encodedTarget(call?.url ?? '')));
    expect(target.origin).toBe('https://gmail.googleapis.com');
    expect(target.pathname).toBe('/gmail/v1/users/me/messages');
    expect(target.searchParams.get('maxResults')).toBe('2');
    expect(target.searchParams.get('q')).toBe('after:2026/08/01');
  });

  test('a query value carrying + and / survives the round trip intact', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/gmail/v1/users/me/messages', { status: 200, body: { messages: [] } });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    // Drive's own listing query is the real case: `URLSearchParams` renders its
    // spaces as `+` and its slashes as `%2F`, so both characters are already in
    // every target this fleet builds.
    const awkward = "trashed = false and name contains 'a+b/c'";
    await client.request({
      app: 'gmail',
      method: 'GET',
      path: '/gmail/v1/users/me/messages',
      query: { q: awkward },
      externalUserId: 'tenant-a',
      accountId: 'apn_1',
    });

    const segment = encodedTarget(transport.requests.at(-1)?.url ?? '');
    expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    // Parsed, not string-compared: what has to survive is the VALUE Google
    // reads, and a `+` that arrives as a space is a different query.
    expect(new URL(decode(segment)).searchParams.get('q')).toBe(awkward);
  });

  test('the scope headers the proxy no longer takes are gone, not merely unused', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on(GMAIL_PROFILE, { status: 200, body: {} });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    await client.request({
      app: 'gmail',
      method: 'GET',
      path: '/gmail/v1/users/me/profile',
      externalUserId: 'tenant-a',
      accountId: 'apn_1',
    });

    const headers = transport.requests.at(-1)?.headers ?? {};
    // A stale header on this call is harmless today and misleading forever: it
    // reads as the thing that scopes the request, and it is not.
    expect(headers['x-pd-external-user-id']).toBeUndefined();
    expect(headers['x-pd-account-id']).toBeUndefined();
    // The environment header stays — the two environments are separate
    // keyspaces and the vendor does not guess between them.
    expect(headers['x-pd-environment']).toBe(CONFIG.environment);
    expect(headers.authorization).toBe('Bearer test-access-token');
  });

  test('a proxy call with no connection id is refused here, not spent at the vendor', async () => {
    const transport = withToken(createScriptedTransport());
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    const outcome = await client.request({
      app: 'gmail',
      method: 'GET',
      path: '/gmail/v1/users/me/profile',
      externalUserId: 'tenant-a',
      accountId: null,
    });

    // The vendor answers `400 {"error":"Account ID missing"}`, which classifies
    // as `provider_error` — "we will retry" — for a source that has nothing
    // connected to retry against. Refusing before the send says the true thing
    // and spends no quota doing it.
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('not_connected');
    expect(transport.requests.some((request) => request.url.includes('/proxy/'))).toBe(false);
  });

  test('the transport fake refuses exactly what the live vendor refused', async () => {
    // The fake is the only thing standing between this file and a second
    // unverified guess, so its fidelity is asserted rather than assumed.
    const transport = createScriptedTransport();
    const project = `/v1/connect/${CONFIG.projectId}/proxy`;
    const scope = 'external_user_id=tenant-a&account_id=apn_1';
    const encoded = Buffer.from(GMAIL_PROFILE, 'utf8').toString('base64url');

    // The shape this repo shipped.
    const shipped = await transport.send({
      method: 'GET',
      url: `https://api.example-connect.test${project}/gmail/gmail/v1/users/me/profile`,
      headers: { 'x-pd-external-user-id': 'tenant-a', 'x-pd-account-id': 'apn_1' },
    });
    expect(shipped.status).toBe(404);
    expect(shipped.body).toContain('Route not found');

    // A standard-base64 segment, whose alphabet puts a raw `/` in the path.
    // **The URL is the Drive listing this fleet makes on every backfill**, with
    // the `fields` projection the adapter asks for, because that is a call that
    // still happens: Drive is metadata-only and downloads nothing, so a
    // per-file `alt=media` example would guard a request nobody sends.
    const standard = Buffer.from(
      'https://www.googleapis.com/drive/v3/files?pageSize=100&fields=' +
        encodeURIComponent(
          'nextPageToken,files(id,name,mimeType,trashed,createdTime,modifiedTime,size,' +
            'webViewLink,owners(displayName,emailAddress))',
        ),
      'utf8',
    ).toString('base64');
    expect(standard).toContain('/');
    const mangled = await transport.send({
      method: 'GET',
      url: `https://api.example-connect.test${project}/${standard}?${scope}`,
      headers: {},
    });
    expect(mangled.status).toBe(404);

    for (const [partial, missing] of [
      ['external_user_id=tenant-a', 'Account ID missing'],
      ['account_id=apn_1', 'External user ID missing'],
    ] as const) {
      const answer = await transport.send({
        method: 'GET',
        url: `https://api.example-connect.test${project}/${encoded}?${partial}`,
        headers: {},
      });
      expect(answer.status).toBe(400);
      expect(answer.body).toContain(missing);
    }

    // And the one deliberate deviation: the vendor drops an upstream parameter
    // left on the proxy URL and answers 200 with unfiltered data. A fake that
    // reproduced that silence could not fail the test that matters.
    expect(() =>
      transport.send({
        method: 'GET',
        url: `https://api.example-connect.test${project}/${encoded}?${scope}&maxResults=2`,
        headers: {},
      }),
    ).toThrow('maxResults');
  });
});

describe('failure classification', () => {
  test('each status maps to the code the ingest log can hold', () => {
    expect(classifyHttpFailure(401, { error: 'invalid_grant' })).toBe('auth_expired');
    expect(classifyHttpFailure(403, {})).toBe('auth_expired');
    expect(classifyHttpFailure(429, {})).toBe('rate_limited');
    expect(classifyHttpFailure(410, {})).toBe('cursor_invalid');
    expect(classifyHttpFailure(500, {})).toBe('provider_error');
    expect(classifyHttpFailure(418, {})).toBe('provider_error');
  });

  test('a refused token mint is the fleet’s failure, not the user’s expired grant', async () => {
    // **This case used to assert the opposite, and the opposite was a fleet-wide
    // outage waiting to happen.** It read: a refused mint is `auth_expired`, not
    // `provider_error` — the reasoning being that a mint failure is an auth
    // failure and `provider_error` reads as a hiccup. Both halves of that were
    // right and the conclusion was still wrong, because there is no user in this
    // request: it is `client_credentials` with the fleet-wide client id and
    // secret. Once `auth_expired` became terminal, one rotated fleet secret
    // dead-lettered every tenant's every lane and told each owner to reconnect
    // an account that was working perfectly.
    //
    // `test/ingest/pipedream/fleet-auth.test.ts` carries the split in full —
    // the retry policies, the panel copy and the operator's signal. What stays
    // here is the classification at the seam that produces it.
    const transport = createScriptedTransport();
    transport.on('/oauth/token', { status: 401, body: { error: 'invalid_client' } });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    const outcome = await client.request({
      app: 'gmail',
      method: 'GET',
      path: '/messages',
      externalUserId: 'a',
      // A connection id, because this test is about the token and the client
      // refuses a proxy call with no connection before it ever mints one — the
      // vendor requires `account_id` on the proxy URL, so a source with nothing
      // attached is `not_connected` rather than a failed refresh.
      accountId: 'apn_1',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('fleet_auth_failed');
  });

  test('a proxy refusal after a good mint is still the user’s expired grant', async () => {
    // The half the split must not move. Same client, same shape, one difference:
    // the token minted, so the 401 came back from a call made *with* it against
    // an account this user attached. That is a revoked grant, it is terminal,
    // and the panel asks for a reconnection.
    const transport = withToken(createScriptedTransport());
    transport.on('/messages', { status: 403, body: { error: 'insufficient scope' } });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    const outcome = await client.request({
      app: 'gmail',
      method: 'GET',
      path: '/messages',
      externalUserId: 'a',
      accountId: 'apn_1',
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('auth_expired');
  });
});

describe('the per-source rate budget', () => {
  test('a burst beyond the bucket waits rather than being dropped', async () => {
    let clock = 0;
    const slept: number[] = [];
    const budget = createRateBudget({
      qps: 2,
      burst: 2,
      now: () => clock,
      sleep: (ms) => {
        slept.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });

    await budget.take('gmail');
    await budget.take('gmail');
    await budget.take('gmail');

    expect(slept.length).toBe(1);
    expect(slept[0]).toBeGreaterThan(0);
  });

  test('the budget is per key: one source does not spend another source’s', async () => {
    let clock = 0;
    const slept: number[] = [];
    const budget = createRateBudget({
      qps: 1,
      burst: 1,
      now: () => clock,
      sleep: (ms) => {
        slept.push(ms);
        clock += ms;
        return Promise.resolve();
      },
    });

    await budget.take('gmail');
    await budget.take('calendar');
    expect(slept.length).toBe(0);
  });
});

describe('the claim URL is a capability', () => {
  const claimDeps = () => ({
    store: createInMemoryClaimStore(),
    tenantId: 'tenant-a',
    source: 'gmail' as const,
    externalUserId: 'tenant-a',
    baseUrl: APP_BASE,
  });

  test('a fresh claim redeems exactly once', async () => {
    const deps = claimDeps();
    const minted = await mintClaimUrl({ ...deps, now: NOW });
    expect(minted.claimUrl.startsWith(APP_BASE)).toBe(true);
    expect(minted.expiresAt.getTime()).toBe(NOW.getTime() + DEFAULT_CLAIM_TTL_MS);

    const first = await redeemClaimUrl({
      store: deps.store,
      tenantId: 'tenant-a',
      claimUrl: minted.claimUrl,
      now: NOW,
    });
    expect(first.ok).toBe(true);

    const second = await redeemClaimUrl({
      store: deps.store,
      tenantId: 'tenant-a',
      claimUrl: minted.claimUrl,
      now: NOW,
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('consumed');
  });

  test('two simultaneous redemptions attach exactly one account', async () => {
    // The check-then-write shape passes both callers through: each reads the
    // record before either has written to it. Only the store's compare-and-set
    // can decide, which is why `consume` is one operation and not a read
    // followed by a put.
    const deps = claimDeps();
    const minted = await mintClaimUrl({ ...deps, now: NOW });
    const [first, second] = await Promise.all([
      redeemClaimUrl({ store: deps.store, tenantId: 'tenant-a', claimUrl: minted.claimUrl, now: NOW }),
      redeemClaimUrl({ store: deps.store, tenantId: 'tenant-a', claimUrl: minted.claimUrl, now: NOW }),
    ]);
    expect([first.ok, second.ok].filter(Boolean).length).toBe(1);
  });

  test('an expired claim cannot attach an account', async () => {
    const deps = claimDeps();
    const minted = await mintClaimUrl({ ...deps, now: NOW, ttlMs: 60_000 });
    const outcome = await redeemClaimUrl({
      store: deps.store,
      tenantId: 'tenant-a',
      claimUrl: minted.claimUrl,
      now: new Date(NOW.getTime() + 60_001),
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('expired');
  });

  test('a claim minted for one tenant cannot be redeemed by another', async () => {
    const deps = claimDeps();
    const minted = await mintClaimUrl({ ...deps, now: NOW });
    const outcome = await redeemClaimUrl({
      store: deps.store,
      tenantId: 'tenant-b',
      claimUrl: minted.claimUrl,
      now: NOW,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('tenant_mismatch');
  });

  test('a wrong secret is refused AND does not consume the claim', async () => {
    const deps = claimDeps();
    const minted = await mintClaimUrl({ ...deps, now: NOW });
    const forged = `${minted.claimUrl.split('#')[0]}#deadbeefdeadbeefdeadbeefdeadbeef`;

    const attack = await redeemClaimUrl({
      store: deps.store,
      tenantId: 'tenant-a',
      claimUrl: forged,
      now: NOW,
    });
    expect(attack.ok).toBe(false);
    if (attack.ok) return;
    expect(attack.reason).toBe('secret_mismatch');

    // The real holder can still use it: a guess must not burn the capability.
    const real = await redeemClaimUrl({
      store: deps.store,
      tenantId: 'tenant-a',
      claimUrl: minted.claimUrl,
      now: NOW,
    });
    expect(real.ok).toBe(true);
  });

  test('the store holds a hash, never the secret itself', async () => {
    const deps = claimDeps();
    const minted = await mintClaimUrl({ ...deps, now: NOW });
    const secret = minted.claimUrl.split('#')[1] ?? '';
    const stored = await deps.store.get(minted.claimId);
    expect(secret.length).toBeGreaterThan(16);
    expect(JSON.stringify(stored)).not.toContain(secret);
  });

  test('an unknown claim id is refused', async () => {
    const deps = claimDeps();
    const outcome = await redeemClaimUrl({
      store: deps.store,
      tenantId: 'tenant-a',
      claimUrl: `${APP_BASE}/connect/claim/00000000-0000-4000-8000-000000000000#abcdefabcdefabcdefabcdef`,
      now: NOW,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('unknown');
  });

  test('a malformed URL is refused rather than parsed leniently', async () => {
    const deps = claimDeps();
    for (const claimUrl of [`${APP_BASE}/connect/claim/abc`, 'not a url', `${APP_BASE}/connect/claim/`]) {
      const outcome = await redeemClaimUrl({
        store: deps.store,
        tenantId: 'tenant-a',
        claimUrl,
        now: NOW,
      });
      expect(outcome.ok).toBe(false);
    }
  });
});

describe('the external user id becomes a URL path segment', () => {
  test('an id outside the anchored alphabet is refused, not encoded', async () => {
    // It addresses another external user's record — and on the deletion call
    // that means erasing the wrong person, or silently erasing nobody.
    const transport = withToken(createScriptedTransport());
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });
    for (const bad of ['../tenant-b', 'tenant/b', 'Tenant-A', '']) {
      expect(client.deleteExternalUser({ externalUserId: bad })).rejects.toThrow(/external user id/);
    }
  });

  test('the accounts listing refuses one too — it reaches a URL as well', async () => {
    // Not the path here but the query string, which is the same problem wearing
    // a different punctuation: an unchecked id is a caller choosing which
    // external user's accounts this fleet reads, and the answer decides whose
    // mailbox gets attached to this brain.
    const transport = withToken(createScriptedTransport());
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });
    for (const bad of ['../tenant-b', 'tenant/b', 'Tenant-A', '']) {
      expect(client.listAccounts({ externalUserId: bad })).rejects.toThrow(/external user id/);
    }
    // And nothing was dialled: the refusal is before the request, not after it.
    expect(transport.requests.filter((request) => request.url.includes('/accounts'))).toEqual([]);
  });
});

/**
 * The accounts listing — how this fleet learns that a consent screen was
 * finished, since nothing tells it.
 *
 * **The shape of this call was checked against the live vendor** rather than
 * reasoned about: it answers `200` with an empty `data` array for an external
 * user that has attached nothing, which is what every user still sitting on the
 * consent screen looks like. A client that read that as an error would refuse
 * the ordinary case.
 */
describe('the accounts listing', () => {
  function listingClient(response: unknown, status = 200) {
    const transport = withToken(createScriptedTransport());
    transport.on('/accounts', { status, body: response });
    return {
      transport,
      client: createPipedreamClient({ config: CONFIG, transport, now: () => NOW }),
    };
  }

  test('it asks for the accounts of one external user, and never for a credential', async () => {
    // **`include_credentials` is the parameter this must not send.** The vendor
    // offers it on this endpoint and nothing in reconciliation needs it — a
    // proxy call carries its scope in headers — so asking would put a live
    // Google credential in this process's memory and in whatever logged the
    // response, for no capability at all.
    const { transport, client } = listingClient({ data: [] });
    await client.listAccounts({ externalUserId: 'tenant-a-gmail' });

    const asked = transport.requests.find((request) => request.url.includes('/accounts'));
    const url = new URL(asked?.url ?? 'https://nowhere.test');
    expect(asked?.method).toBe('GET');
    expect(url.searchParams.get('external_user_id')).toBe('tenant-a-gmail');
    expect(url.searchParams.get('include_credentials')).toBeNull();
    expect(asked?.url).not.toContain('include_credentials');
    expect(asked?.url).not.toContain(CONFIG.clientSecret);
    // The environment travels, because the vendor's two keyspaces are separate
    // and a listing read against the wrong one is empty rather than wrong.
    expect(asked?.headers['x-pd-environment']).toBe(CONFIG.environment);
  });

  test('nothing attached is an ordinary success, not a failure', async () => {
    const { client } = listingClient({ page_info: { total_count: 0, count: 0 }, data: [] });
    const outcome = await client.listAccounts({ externalUserId: 'tenant-a-gmail' });
    expect(outcome).toEqual({ ok: true, value: [] });
  });

  test('an account is read down to the four fields a connection needs', async () => {
    const { client } = listingClient({
      data: [
        {
          id: 'apn_this_test_invented_it',
          app: { name_slug: 'gmail', name: 'Gmail' },
          healthy: true,
          dead: false,
          created_at: '2026-08-13T09:00:00.000Z',
          // Everything below is deliberately ignored: the vendor's label for an
          // account is not the provider's own spelling of the mailbox, and
          // copying it into `accountKey` would stop the first real pull on
          // `identity_changed` against a mailbox that never changed.
          name: 'Gmail — owner@example.test',
          external_id: 'tenant-a-gmail',
        },
      ],
    });

    const outcome = await client.listAccounts({ externalUserId: 'tenant-a-gmail' });
    expect(outcome).toEqual({
      ok: true,
      value: [
        {
          accountId: 'apn_this_test_invented_it',
          appSlug: 'gmail',
          dead: false,
          createdAt: '2026-08-13T09:00:00.000Z',
        },
      ],
    });
  });

  test('either spelling of a finished grant reads as dead, and silence reads as alive', async () => {
    const { client } = listingClient({
      data: [
        { id: 'apn_one', dead: true },
        { id: 'apn_two', healthy: false },
        { id: 'apn_three' },
      ],
    });
    const outcome = await client.listAccounts({ externalUserId: 'tenant-a-gmail' });
    expect(outcome.ok && outcome.value.map((account) => account.dead)).toEqual([true, true, false]);
  });

  test('an entry with no id is dropped rather than adopted', async () => {
    // The id becomes the proxy's `account_id` on every later call, so an entry
    // without one is not an account this fleet can address — adopting it would
    // write a connection whose every poll fails.
    const { client } = listingClient({
      data: [{ app: { name_slug: 'gmail' } }, { id: '' }, { id: 42 }, { id: 'apn_ok' }],
    });
    const outcome = await client.listAccounts({ externalUserId: 'tenant-a-gmail' });
    expect(outcome.ok && outcome.value.map((account) => account.accountId)).toEqual(['apn_ok']);
  });

  test('a body that is not a listing is an empty listing, not a crash', async () => {
    const { client } = listingClient('not json at all');
    const outcome = await client.listAccounts({ externalUserId: 'tenant-a-gmail' });
    expect(outcome).toEqual({ ok: true, value: [] });
  });

  test('a refused listing is a typed failure carrying no vendor text', async () => {
    const { client } = listingClient({ error: 'nope' }, 503);
    const outcome = await client.listAccounts({ externalUserId: 'tenant-a-gmail' });
    expect(outcome).toEqual({ ok: false, reason: 'provider_error', status: 503 });
  });
});

describe('redaction — the envelope lands in transcripts U8 re-ingests', () => {
  test('a claim URL is replaced wherever it appears', () => {
    const line = `open ${APP_BASE}/connect/claim/6f1c2b3a-4d5e-4f60-8a91-b2c3d4e5f607#s3cr3ts3cr3ts3cr3t and sign in`;
    const redacted = redactClaimUrls(line);
    expect(redacted).not.toContain('s3cr3ts3cr3ts3cr3t');
    expect(redacted).toContain('[redacted-claim-url]');
  });

  test('the pattern matches the URL the minter actually produces', async () => {
    const minted = await mintClaimUrl({
      store: createInMemoryClaimStore(),
      tenantId: 'tenant-a',
      source: 'gmail',
      externalUserId: 'tenant-a',
      baseUrl: APP_BASE,
      now: NOW,
    });
    expect(CLAIM_URL_PATTERN.test(minted.claimUrl)).toBe(true);
    expect(redactClaimUrls(minted.claimUrl)).toBe('[redacted-claim-url]');
  });
});

describe("R12's erasure leg", () => {
  test('external-user deletion is a real call, and it reports revocation as unverified', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/users/tenant-a', { status: 204, body: '' });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    const outcome = await client.deleteExternalUser({ externalUserId: 'tenant-a' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.deleted).toBe(true);
    // Assumption 1 is unverified: whether deletion revokes the grant AT GOOGLE
    // is a vendor answer nobody has yet. Saying `confirmed` here would put a
    // false sentence in a privacy policy.
    expect(outcome.value.tokensRevoked).toBe('unverified');

    const call = transport.requests.at(-1);
    expect(call?.method).toBe('DELETE');
    expect(call?.url).toContain('tenant-a');
  });

  /**
   * **The header this call omitted, and what the omission cost.**
   *
   * The listing sends `x-pd-environment` and this did not. Against the live
   * vendor that is not a keyspace mix-up that quietly deletes the wrong record —
   * it is a flat refusal, `400 {"error":"Environment missing"}`, which
   * `classifyDeletion` reads as no verdict and the client reports as
   * `provider_error`. So `ConnectorVendor.disconnect` threw on every call and
   * `/api/connectors DELETE` answered `500` for every user, on every deployment:
   * the disconnect button could not reach the vendor at all, and the mailbox it
   * was pressed for stayed attached and stayed billed.
   *
   * Observed live on 2026-08-17 against the production project — the same
   * external user answers `400` without the header and `204` with it.
   *
   * A scripted-transport case cannot see a missing header (the double answers
   * whatever it was told to), which is exactly how this survived a suite that
   * already asserted the method, the URL and the reported evidence. So the
   * assertion is on what is *sent*, the way the listing's is.
   */
  test('the deletion names the environment it is deleting in', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/users/tenant-a', { status: 204, body: '' });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    await client.deleteExternalUser({ externalUserId: 'tenant-a' });

    const call = transport.requests.at(-1);
    expect(call?.headers['x-pd-environment']).toBe(CONFIG.environment);
  });

  test('a deletion that did not happen is not reported as one', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/users/tenant-a', { status: 500, body: { error: 'boom' } });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    const outcome = await client.deleteExternalUser({ externalUserId: 'tenant-a' });
    expect(outcome.ok).toBe(false);
  });
});

/**
 * The vendor edges this client got wrong: a mint that could not be paced, a
 * deletion that reported evidence it did not have, and a budget that bounded
 * one pull rather than the fleet.
 */
describe('the token mint is part of the traffic it authorizes', () => {
  test('the mint is paced by the budget, not exempt from it', async () => {
    const taken: string[] = [];
    const transport = withToken(createScriptedTransport());
    transport.on('https://gmail.googleapis.com/messages', { status: 200, body: { ok: true } });
    const client = createPipedreamClient({
      config: CONFIG,
      transport,
      now: () => NOW,
      rate: {
        take(key) {
          taken.push(key);
          return Promise.resolve();
        },
      },
    });

    await client.request({ app: 'gmail', method: 'GET', path: '/messages', externalUserId: 'a', accountId: 'apn_1' });

    // The mint is a request to the same vendor under the same project quota; a
    // call that spends it without asking is a hole in the ceiling.
    expect(taken.length).toBe(2);
    expect(taken[0]).toBe('oauth');

    // And the connect-token mint is one too. Pacing only the OAuth call leaves
    // a burst of them unpaced the moment the access token is cached — which is
    // every time after the first.
    taken.length = 0;
    transport.on('/tokens', { status: 200, body: { token: 'ct-1' } });
    await client.mintConnectToken({ externalUserId: 'a', now: NOW });
    expect(taken).toEqual(['connect']);
  });

  test('a token the vendor says expires immediately does not become a mint loop', async () => {
    // `expires_in: 0` is answered verbatim: the cache is stale the moment it is
    // written, so every call re-mints — unpaced, forever, against a vendor that
    // is already unhappy.
    let clock = NOW.getTime();
    let mints = 0;
    const transport = createScriptedTransport();
    transport.fallback({ status: 200, body: { ok: true } });
    for (let index = 0; index < 8; index += 1) {
      transport.on('/oauth/token', () => {
        mints += 1;
        return { status: 200, body: { access_token: `t-${mints}`, expires_in: 0 } };
      });
    }
    const client = createPipedreamClient({
      config: CONFIG,
      transport,
      now: () => new Date(clock),
    });

    for (let index = 0; index < 4; index += 1) {
      clock += 1_000;
      await client.request({ app: 'gmail', method: 'GET', path: '/messages', externalUserId: 'a', accountId: 'apn_1' });
    }

    expect(mints).toBe(1);
  });

  test('a rate-limited mint is not reported as a dead grant', async () => {
    // `auth_expired` reads to a user as "reconnect this source". Answering it
    // for a 429 or a 500 tells them their Google grant died when the vendor
    // merely asked us to wait.
    const throttled = createScriptedTransport();
    throttled.on('/oauth/token', { status: 429, body: { error: 'slow down' } });
    const rateLimited = await createPipedreamClient({
      config: CONFIG,
      transport: throttled,
      now: () => NOW,
    }).request({ app: 'gmail', method: 'GET', path: '/messages', externalUserId: 'a', accountId: 'apn_1' });
    expect(rateLimited.ok).toBe(false);
    if (rateLimited.ok) return;
    expect(rateLimited.reason).toBe('rate_limited');

    const broken = createScriptedTransport();
    broken.on('/oauth/token', { status: 503, body: { error: 'down' } });
    const serverError = await createPipedreamClient({
      config: CONFIG,
      transport: broken,
      now: () => NOW,
    }).request({ app: 'gmail', method: 'GET', path: '/messages', externalUserId: 'a', accountId: 'apn_1' });
    expect(serverError.ok).toBe(false);
    if (serverError.ok) return;
    expect(serverError.reason).toBe('provider_error');
  });
});

describe('the erasure leg reports only what it observed', () => {
  test('a 410 on the delete is "already gone", not an expired cursor', async () => {
    // `classifyHttpFailure` checks the cursor case first, on every call. On a
    // DELETE that means the ordinary idempotent answer comes back as
    // `cursor_invalid` — a code about a sync token, on a call that has none.
    const transport = withToken(createScriptedTransport());
    transport.on('/users/tenant-a', { status: 410, body: { error: 'gone' } });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    const outcome = await client.deleteExternalUser({ externalUserId: 'tenant-a' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.deleted).toBe(true);
    expect(outcome.value.evidence).toBe('already_absent');
    expect(outcome.value.tokensRevoked).toBe('unverified');
  });

  test('a 404 for a user who is already gone is not a retryable provider error', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/users/tenant-a', { status: 404, body: { error: 'no such user' } });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    const outcome = await client.deleteExternalUser({ externalUserId: 'tenant-a' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.evidence).toBe('already_absent');
  });

  test('an accepted-but-not-done deletion does not claim the record is gone', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/users/tenant-a', { status: 202, body: { status: 'queued' } });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    const outcome = await client.deleteExternalUser({ externalUserId: 'tenant-a' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.evidence).toBe('accepted');
    expect(outcome.value.deleted).toBe(false);
  });
});

describe('the rate budget bounds more than one pull', () => {
  test('two clients built without an explicit budget share one', async () => {
    // The vendor ceiling is per project, not per tenant. A private default per
    // client means N tenants hold N times the quota and every one of them is
    // "within budget" while the project is being throttled.
    //
    // `google_calendar` is this file's only user of that bucket, so the burst
    // it starts with is known and the assertion is not a race with whatever ran
    // before it.
    expect(sharedRateBudget()).toBe(sharedRateBudget());

    const clientOn = () => {
      const transport = createScriptedTransport();
      transport.on('/oauth/token', { status: 200, body: { access_token: 't', expires_in: 3600 } });
      transport.fallback({ status: 200, body: {} });
      return createPipedreamClient({ config: CONFIG, transport, now: () => new Date() });
    };

    const first = clientOn();
    const second = clientOn();
    const call = (client: ReturnType<typeof clientOn>) =>
      client.request({
        app: 'google_calendar',
        method: 'GET',
        path: '/events',
        externalUserId: 'a',
        accountId: 'apn_1',
      });

    // The first client spends the whole burst…
    for (let index = 0; index < DEFAULT_BURST; index += 1) await call(first);

    // …and the second one, which never met it, has to wait for a refill.
    const started = Date.now();
    await call(second);
    expect(Date.now() - started).toBeGreaterThan(50);
  });

  test('only one caller per key waits on a timer at a time', async () => {
    // With a shared budget the waiters on one key are the whole fleet, not one
    // pull. Unserialized, every refill wakes all of them, one wins and the rest
    // sleep again — O(waiters) wakeups per token, re-forming each round.
    let clock = 0;
    let sleeps = 0;
    const pending: Array<() => void> = [];
    const budget = createRateBudget({
      qps: 1,
      burst: 1,
      now: () => clock,
      sleep: () => {
        sleeps += 1;
        return new Promise<void>((resolve) => pending.push(resolve));
      },
    });

    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

    await budget.take('gmail');
    const waiting = [budget.take('gmail'), budget.take('gmail'), budget.take('gmail')];
    await settle();

    expect(sleeps).toBe(1);

    // Drain, so nothing is left pending on the loop.
    for (let round = 0; round < 16 && pending.length > 0; round += 1) {
      clock += 1_000;
      for (const resolve of pending.splice(0)) resolve();
      await settle();
    }
    await Promise.all(waiting);
  });

  test('a sleep that returned early does not leak a token', async () => {
    // `sleep` is not a promise that the clock advanced by what was asked: a
    // timer can fire early, a clock can be coarse, and the injected one in a
    // test certainly is. Sleeping once and then decrementing regardless hands
    // out a token the bucket never refilled — the pacing simply does not happen.
    let clock = 0;
    let sleeps = 0;
    const budget = createRateBudget({
      qps: 1,
      burst: 1,
      now: () => clock,
      sleep: (ms) => {
        sleeps += 1;
        clock += Math.floor(ms / 2);
        return Promise.resolve();
      },
    });

    await budget.take('gmail');
    const started = clock;
    await budget.take('gmail');

    expect(sleeps).toBeGreaterThan(1);
    // One sleep's worth is exactly what the leaking version waits before it
    // hands the token over anyway. (Integer division keeps this a hair under a
    // full second, which is the point: the caller waited nearly twice as long.)
    expect(clock - started).toBeGreaterThan(500);
  });

  test('waiters do not all proceed on one refill', async () => {
    // `take` slept and then decremented unconditionally, so N callers queued
    // behind one token all woke and all spent it. The bucket goes negative and
    // the pacing it was supposed to do never happened.
    let clock = 0;
    const budget = createRateBudget({
      qps: 1,
      burst: 1,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    });

    await budget.take('gmail');
    const started = clock;
    await Promise.all([budget.take('gmail'), budget.take('gmail'), budget.take('gmail')]);

    // Three more at 1 qps cannot happen inside one second's worth of refill.
    expect(clock - started).toBeGreaterThanOrEqual(3_000);
  });
});
