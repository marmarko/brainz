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
 * **The vendor answers are unverified** (Assumption 1, deliberately deferred to
 * this unit). What is tested here is the shape of the call and the honesty of
 * what it reports back — `tokensRevoked: 'unverified'` is the whole point of
 * that field, and a test pins it so nobody can quietly promote it to
 * `'confirmed'` without a vendor answer in `docs/vendor/`.
 */

import { describe, expect, test } from 'bun:test';

import {
  CLAIM_URL_PATTERN,
  DEFAULT_CLAIM_TTL_MS,
  classifyHttpFailure,
  createInMemoryClaimStore,
  createPipedreamClient,
  createRateBudget,
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
    expect(call?.url).toContain('maxResults=10');
    expect(JSON.stringify(call?.headers)).toContain('tenant-a');
    expect(JSON.stringify(call?.headers)).toContain('apn_1');
  });

  test('the access token is fetched once and reused', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/messages', { status: 200, body: { messages: [] } });
    transport.on('/messages', { status: 200, body: { messages: [] } });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    await client.request({ app: 'gmail', method: 'GET', path: '/messages', externalUserId: 'a' });
    await client.request({ app: 'gmail', method: 'GET', path: '/messages', externalUserId: 'a' });

    const tokenCalls = transport.requests.filter((request) => request.url.includes('/oauth/token'));
    expect(tokenCalls.length).toBe(1);
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

  test('a token refresh failure is auth_expired, not provider_error', async () => {
    // The distinction is the whole staleness story: `provider_error` reads as a
    // hiccup, `auth_expired` reads as "reconnect this source".
    const transport = createScriptedTransport();
    transport.on('/oauth/token', { status: 401, body: { error: 'invalid_client' } });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    const outcome = await client.request({
      app: 'gmail',
      method: 'GET',
      path: '/messages',
      externalUserId: 'a',
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

  test('a deletion that did not happen is not reported as one', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/users/tenant-a', { status: 500, body: { error: 'boom' } });
    const client = createPipedreamClient({ config: CONFIG, transport, now: () => NOW });

    const outcome = await client.deleteExternalUser({ externalUserId: 'tenant-a' });
    expect(outcome.ok).toBe(false);
  });
});
