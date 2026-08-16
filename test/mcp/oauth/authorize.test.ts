/**
 * The authorization surface — a public OAuth issuer standing in front of a
 * mailbox-derived brain.
 *
 * Every control here is one an attacker gets to attempt from the open internet,
 * so each test is written as the attack rather than as the feature:
 *
 *   * a code redeemed with no verifier, or the wrong one (PKCE downgrade),
 *   * a code redeemed against a redirect that merely *starts with* the
 *     registered one (`https://claude.ai/callback.evil.example`),
 *   * a code replayed a second time,
 *   * a code redeemed after its short TTL,
 *   * dynamic client registration from outside the single-tenant allowlist,
 *   * registration used as a free-form write amplifier.
 */

import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_CODE_TTL_SECONDS,
  authorize,
  createInMemoryAuthorizationStore,
  redeemAuthorizationCode,
  registerClient,
  type AuthorizeRequest,
} from '../../../src/mcp/oauth.ts';

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';

function storeWithClient() {
  const store = createInMemoryAuthorizationStore();
  const registered = registerClient(
    store,
    { clientName: 'Claude Desktop', redirectUris: [REDIRECT] },
    { allowlist: { redirectUris: [REDIRECT], maxRegistrationsPerHour: 5 }, now: NOW },
  );
  if (!registered.ok) throw new Error(`fixture client did not register: ${registered.error}`);
  return { store, clientId: registered.client.client_id };
}

function authorizeOnce(overrides: Partial<AuthorizeRequest> = {}) {
  const { store, clientId } = storeWithClient();
  const outcome = authorize(store, {
    clientId,
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    codeChallengeMethod: 'S256',
    state: 'opaque-state-1',
    tenantId: 'tenant-a',
    scope: 'narrowed' as const,
    origins: ['personal:mail', 'personal:agent'],
    writeOrigin: 'personal:agent',
    endpoint: 'mcp',
    now: NOW,
    ...overrides,
  });
  return { store, clientId, outcome };
}

describe('the authorization endpoint', () => {
  test('issues a code bound to the state and the redirect', () => {
    const { outcome } = authorizeOnce();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.code.length).toBeGreaterThanOrEqual(32);
    expect(outcome.redirectTo).toContain(`${REDIRECT}?code=`);
    expect(outcome.redirectTo).toContain('state=opaque-state-1');
  });

  test('refuses a redirect_uri that is not the registered string, exactly', () => {
    for (const attack of [
      `${REDIRECT}.evil.example`,
      `${REDIRECT}/`,
      `${REDIRECT}?x=1`,
      'https://claude.ai/api/mcp/AUTH_CALLBACK',
      'https://evil.example/api/mcp/auth_callback',
    ]) {
      const { outcome } = authorizeOnce({ redirectUri: attack });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error).toBe('invalid_request');
    }
  });

  test('refuses a plain PKCE challenge — S256 is mandatory', () => {
    const { outcome } = authorizeOnce({ codeChallengeMethod: 'plain' });
    expect(outcome.ok).toBe(false);
  });

  test('refuses a missing PKCE challenge outright', () => {
    const { outcome } = authorizeOnce({ codeChallenge: '' });
    expect(outcome.ok).toBe(false);
  });

  test('refuses an unregistered client', () => {
    const { outcome } = authorizeOnce({ clientId: 'client-nobody-registered' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('invalid_client');
  });
});

describe('redeeming the code', () => {
  function issued() {
    const { store, clientId, outcome } = authorizeOnce();
    if (!outcome.ok) throw new Error('fixture authorize failed');
    return { store, clientId, code: outcome.code };
  }

  test('the matching verifier redeems exactly once', () => {
    const { store, clientId, code } = issued();
    const first = redeemAuthorizationCode(store, {
      code,
      codeVerifier: VERIFIER,
      redirectUri: REDIRECT,
      clientId,
      now: NOW + 1_000,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.grant.tenantId).toBe('tenant-a');
    expect(first.grant.origins).toEqual(['personal:mail', 'personal:agent']);

    const replay = redeemAuthorizationCode(store, {
      code,
      codeVerifier: VERIFIER,
      redirectUri: REDIRECT,
      clientId,
      now: NOW + 2_000,
    });
    expect(replay.ok).toBe(false);
    if (replay.ok) return;
    expect(replay.error).toBe('invalid_grant');
  });

  test('a code redeemed without the matching verifier is rejected', () => {
    const { store, clientId, code } = issued();
    for (const verifier of ['', 'not-the-verifier', CHALLENGE]) {
      const outcome = redeemAuthorizationCode(store, {
        code,
        codeVerifier: verifier,
        redirectUri: REDIRECT,
        clientId,
        now: NOW + 1_000,
      });
      expect(outcome.ok).toBe(false);
    }
  });

  test('a code redeemed against an unregistered redirect_uri is rejected', () => {
    const { store, clientId, code } = issued();
    const outcome = redeemAuthorizationCode(store, {
      code,
      codeVerifier: VERIFIER,
      redirectUri: `${REDIRECT}.evil.example`,
      clientId,
      now: NOW + 1_000,
    });
    expect(outcome.ok).toBe(false);
  });

  test('a code redeemed by a different client is rejected', () => {
    const { store, code } = issued();
    const outcome = redeemAuthorizationCode(store, {
      code,
      codeVerifier: VERIFIER,
      redirectUri: REDIRECT,
      clientId: 'client-somebody-else',
      now: NOW + 1_000,
    });
    expect(outcome.ok).toBe(false);
  });

  test('a code past its short TTL is rejected, and the TTL really is short', () => {
    const { store, clientId, code } = issued();
    expect(DEFAULT_CODE_TTL_SECONDS).toBeLessThanOrEqual(600);
    const outcome = redeemAuthorizationCode(store, {
      code,
      codeVerifier: VERIFIER,
      redirectUri: REDIRECT,
      clientId,
      now: NOW + DEFAULT_CODE_TTL_SECONDS * 1000 + 1,
    });
    expect(outcome.ok).toBe(false);
  });

  test('an unknown code is rejected without disclosing why', () => {
    const { store, clientId } = issued();
    const outcome = redeemAuthorizationCode(store, {
      code: 'code-that-was-never-issued',
      codeVerifier: VERIFIER,
      redirectUri: REDIRECT,
      clientId,
      now: NOW,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('invalid_grant');
  });
});

describe('dynamic client registration', () => {
  test('a client whose redirect is outside the allowlist is refused', () => {
    const store = createInMemoryAuthorizationStore();
    const outcome = registerClient(
      store,
      { clientName: 'Someone Else', redirectUris: ['https://evil.example/callback'] },
      { allowlist: { redirectUris: [REDIRECT], maxRegistrationsPerHour: 5 }, now: NOW },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('invalid_redirect_uri');
  });

  test('a client registering one allowed and one disallowed redirect is refused entirely', () => {
    const store = createInMemoryAuthorizationStore();
    const outcome = registerClient(
      store,
      { clientName: 'Mixed', redirectUris: [REDIRECT, 'https://evil.example/callback'] },
      { allowlist: { redirectUris: [REDIRECT], maxRegistrationsPerHour: 5 }, now: NOW },
    );
    expect(outcome.ok).toBe(false);
  });

  test('registration is rate limited', () => {
    const store = createInMemoryAuthorizationStore();
    const options = {
      allowlist: { redirectUris: [REDIRECT], maxRegistrationsPerHour: 2 },
      now: NOW,
    };
    expect(registerClient(store, { clientName: 'a', redirectUris: [REDIRECT] }, options).ok).toBe(true);
    expect(registerClient(store, { clientName: 'b', redirectUris: [REDIRECT] }, options).ok).toBe(true);
    const third = registerClient(store, { clientName: 'c', redirectUris: [REDIRECT] }, options);
    expect(third.ok).toBe(false);
    if (third.ok) return;
    expect(third.error).toBe('rate_limited');

    // …and the window really is a window.
    const later = registerClient(
      store,
      { clientName: 'd', redirectUris: [REDIRECT] },
      { ...options, now: NOW + 61 * 60 * 1000 },
    );
    expect(later.ok).toBe(true);
  });

  test('a registration with no redirect at all is refused', () => {
    const store = createInMemoryAuthorizationStore();
    const outcome = registerClient(
      store,
      { clientName: 'empty', redirectUris: [] },
      { allowlist: { redirectUris: [REDIRECT], maxRegistrationsPerHour: 5 }, now: NOW },
    );
    expect(outcome.ok).toBe(false);
  });
});
