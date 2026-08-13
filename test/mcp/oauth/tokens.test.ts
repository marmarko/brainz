/**
 * Grant lifecycle: the provisioned bearer, the derived signing key, and the
 * access tokens minted from it.
 *
 * **Why tokens are derived rather than stored.** The control plane is
 * content-free and holds no grant table; the secret store holds one thing per
 * tenant that this layer may read — the bearer U2 minted at provisioning. So an
 * access token is an HMAC over its own claims, keyed by a value *derived* from
 * that bearer through a one-way step. Two consequences the tests below pin:
 * rotating the bearer invalidates every token that was ever minted for the
 * tenant (the documented revoke-and-reissue step), and the signing key cannot be
 * run backwards into the bearer if a token-minting process is compromised.
 *
 * **The tenant id in a token is a routing hint until the signature verifies.**
 * The Worker reads it to pick a Durable Object; nothing is authorised by it. The
 * test that matters is the one where a token minted for one tenant is presented
 * with another tenant's key.
 */

import { describe, expect, test } from 'bun:test';

import {
  ACCESS_TOKEN_PREFIX,
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  TENANT_BEARER_PREFIX,
  deriveSigningKey,
  mintAccessToken,
  mintTenantBearer,
  tenantOfToken,
  verifyAccessToken,
  verifyTenantBearer,
} from '../../../src/mcp/oauth.ts';

const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

/** What a minter that returned bare entropy would produce. */
function base64ish(): string {
  return 'Q6xR2vN8pL4kT1wY7zA3bC5dE9fG0hJ2';
}

function claimsFor(tenantId: string) {
  return {
    grantId: 'g-0001',
    tenantId,
    origins: ['personal:mail', 'personal:agent'],
    writeOrigin: 'personal:agent',
    endpoint: 'mcp' as const,
    clientId: 'client-abc',
    issuedAt: NOW,
    expiresAt: NOW + DEFAULT_ACCESS_TOKEN_TTL_SECONDS * 1000,
  };
}

describe('the provisioned bearer', () => {
  test('carries its tenant id and enough entropy to be unguessable', () => {
    const bearer = mintTenantBearer('tenant-a');
    expect(bearer.startsWith(TENANT_BEARER_PREFIX)).toBe(true);
    expect(tenantOfToken(bearer)).toBe('tenant-a');
    const secret = bearer.slice(`${TENANT_BEARER_PREFIX}tenant-a_`.length);
    expect(secret.length).toBeGreaterThanOrEqual(32);
    expect(mintTenantBearer('tenant-a')).not.toBe(bearer);
  });

  test('verifies against the stored value and refuses everything else', () => {
    const bearer = mintTenantBearer('tenant-a');
    expect(verifyTenantBearer(bearer, bearer)).toBe(true);
    expect(verifyTenantBearer(`${bearer}x`, bearer)).toBe(false);
    expect(verifyTenantBearer(bearer.slice(0, -1), bearer)).toBe(false);
    expect(verifyTenantBearer('', bearer)).toBe(false);
    expect(verifyTenantBearer(mintTenantBearer('tenant-a'), bearer)).toBe(false);
  });

  test('a bearer in any other shape is unroutable, which is the reason the shape is fixed', () => {
    // U2's `BearerGrantMinter` port returns an opaque string and is right not to
    // care what is in it. This unit does: the Worker reads the tenant id out of
    // the presented credential to pick a Durable Object. Bare entropy produces a
    // grant no request can be routed by, and the symptom is an unreachable
    // brain rather than a format mismatch.
    expect(tenantOfToken(base64ish())).toBeNull();
    expect(tenantOfToken(`tenant-a_${base64ish()}`)).toBeNull();
    expect(tenantOfToken(`${TENANT_BEARER_PREFIX}${base64ish()}`)).toBeNull();
  });

  test('a token naming a tenant id that is not a legal id resolves to nothing', () => {
    expect(tenantOfToken(`${TENANT_BEARER_PREFIX}../../etc_secret`)).toBeNull();
    expect(tenantOfToken(`${TENANT_BEARER_PREFIX}Tenant-A_secret`)).toBeNull();
    expect(tenantOfToken('Bearer nonsense')).toBeNull();
    expect(tenantOfToken('')).toBeNull();
  });
});

describe('the signing key', () => {
  test('is derived one-way from the bearer', () => {
    const bearer = mintTenantBearer('tenant-a');
    const key = deriveSigningKey(bearer);
    expect(key).not.toContain(bearer);
    expect(bearer).not.toContain(key);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveSigningKey(bearer)).toBe(key);
  });

  test('rotating the bearer changes the key — revoke-and-reissue, in one step', () => {
    const before = deriveSigningKey(mintTenantBearer('tenant-a'));
    const after = deriveSigningKey(mintTenantBearer('tenant-a'));
    expect(before).not.toBe(after);
  });
});

describe('access tokens', () => {
  test('round-trip their claims', () => {
    const key = deriveSigningKey(mintTenantBearer('tenant-a'));
    const token = mintAccessToken(claimsFor('tenant-a'), key);
    expect(token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(tenantOfToken(token)).toBe('tenant-a');

    const verdict = verifyAccessToken(token, key, NOW + 1_000);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.claims.origins).toEqual(['personal:mail', 'personal:agent']);
    expect(verdict.claims.writeOrigin).toBe('personal:agent');
    expect(verdict.claims.grantId).toBe('g-0001');
  });

  test('a tampered claim set does not verify', () => {
    const key = deriveSigningKey(mintTenantBearer('tenant-a'));
    const token = mintAccessToken(claimsFor('tenant-a'), key);
    const [prefix, payload, signature] = token.split('.');
    const widened = { ...claimsFor('tenant-a'), origins: ['personal:mail', 'work:mail'] };
    const forged = `${prefix}.${btoa(JSON.stringify(widened)).replace(/=+$/, '')}.${signature}`;
    expect(forged).not.toBe(token);
    expect(verifyAccessToken(forged, key, NOW).ok).toBe(false);
    expect(payload).toBeDefined();
  });

  test('a token minted for one tenant does not verify under another tenant’s key', () => {
    const keyA = deriveSigningKey(mintTenantBearer('tenant-a'));
    const keyB = deriveSigningKey(mintTenantBearer('tenant-b'));
    const token = mintAccessToken(claimsFor('tenant-a'), keyA);
    const verdict = verifyAccessToken(token, keyB, NOW);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('bad_signature');
  });

  test('an expired token is refused before anything else happens', () => {
    const key = deriveSigningKey(mintTenantBearer('tenant-a'));
    const token = mintAccessToken(claimsFor('tenant-a'), key);
    const verdict = verifyAccessToken(token, key, NOW + DEFAULT_ACCESS_TOKEN_TTL_SECONDS * 1000 + 1);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.reason).toBe('expired');
  });

  test('the TTL is bounded — a leaked grant expires without operator action', () => {
    expect(DEFAULT_ACCESS_TOKEN_TTL_SECONDS).toBeGreaterThan(0);
    expect(DEFAULT_ACCESS_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(24 * 60 * 60);
  });

  test('a malformed token is a typed refusal, never a throw', () => {
    const key = deriveSigningKey(mintTenantBearer('tenant-a'));
    for (const bad of ['', 'bza_', 'bza_tenant-a', 'bza_tenant-a.notbase64.sig', 'garbage']) {
      const verdict = verifyAccessToken(bad, key, NOW);
      expect(verdict.ok).toBe(false);
    }
  });
});
