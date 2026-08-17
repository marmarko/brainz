/**
 * The connector vendor the web app is handed, driven through the real client.
 *
 * **What this is defending.** `createPipedreamClient` had no constructor
 * anywhere in `src/`; the vendor `web/serve.ts` supplied threw a bare `Error`
 * from inside the request. So the property under test is not "a client can be
 * built" — it is that the port `app.ts` calls reaches the vendor's own endpoints
 * with the right scope, and that every way it can fail is typed and carries no
 * vendor text.
 *
 * The client is the real one over a scripted transport, not a stub of
 * `PipedreamClient`. A stub would let the adapter and the client disagree about
 * the one thing that matters here — which external user a call is scoped to —
 * and both halves would pass.
 */

import { describe, expect, test } from 'bun:test';

import {
  ConnectorVendorError,
  createPipedreamConnectorVendor,
} from '../../src/web/connectors.ts';
import {
  createPipedreamClient,
  externalUserIdFor,
  ExternalUserIdError,
} from '../../src/ingest/pipedream/client.ts';
import { CONFIG, createScriptedTransport, withToken } from '../ingest/pipedream/fixture.ts';

const NOW = new Date('2026-08-17T09:00:00.000Z');
const TENANT = 't-0123456789abcdef01234567';

function vendorOver(transport: ReturnType<typeof createScriptedTransport>) {
  return createPipedreamConnectorVendor({
    client: createPipedreamClient({ config: CONFIG, transport, now: () => NOW }),
    now: () => NOW,
  });
}

describe('minting a connect link', () => {
  test('the link is the vendor’s own, scoped to this tenant’s external user', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/tokens', {
      status: 200,
      body: {
        token: 'ctok_gmail',
        expires_at: new Date(NOW.getTime() + 600_000).toISOString(),
        connect_link_url: 'https://connect.example.test/start?token=ctok_gmail',
      },
    });

    const minted = await vendorOver(transport).mintClaimUrl({ tenantId: TENANT, source: 'gmail' });

    // The vendor's URL, carried through rather than re-derived — plus the one
    // parameter this side owns, which says which app the page opens on.
    expect(minted.claimUrl).toContain('https://connect.example.test/start');
    expect(minted.claimUrl).toContain('token=ctok_gmail');
    expect(new URL(minted.claimUrl).searchParams.get('app')).toBe('gmail');
    expect(minted.expiresAt.toISOString()).toBe(new Date(NOW.getTime() + 600_000).toISOString());

    const mint = transport.requests.find((request) => request.url.includes('/tokens'));
    expect(JSON.parse(mint?.body ?? '{}').external_user_id).toBe(`${TENANT}-gmail`);
    // A TTL is asked for rather than assumed: the link is a capability, and a
    // capability with the vendor's default lifetime is a decision nobody made.
    expect(JSON.parse(mint?.body ?? '{}').lifetime).toBe(600);
  });

  test('the expiry the port reports is the vendor’s, not a number this side invented', async () => {
    const transport = withToken(createScriptedTransport());
    const vendorExpiry = new Date(NOW.getTime() + 42_000).toISOString();
    transport.on('/tokens', {
      status: 200,
      body: { token: 'ctok_short', expires_at: vendorExpiry, connect_link_url: 'https://c.test/s' },
    });

    const minted = await vendorOver(transport).mintClaimUrl({ tenantId: TENANT, source: 'drive' });
    expect(minted.expiresAt.toISOString()).toBe(vendorExpiry);
  });

  /**
   * **The refusal, and what it is allowed to say.**
   *
   * The port has no failure channel, so a refused mint throws — and the object
   * that gets thrown is the most casually-logged thing in any system. The vendor
   * body below carries a fake credential and an internal hostname on purpose:
   * what is asserted is that neither survives into the error.
   */
  test('a refused mint is a typed error carrying a code, and no vendor text', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/tokens', {
      status: 429,
      body: {
        error: 'slow down',
        request_url: 'https://internal.vendor.test/projects/proj-test?key=sk_live_not_real',
      },
    });

    const failure = await vendorOver(transport)
      .mintClaimUrl({ tenantId: TENANT, source: 'gmail' })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(ConnectorVendorError);
    const typed = failure as ConnectorVendorError;
    expect(typed.operation).toBe('mint_connect_token');
    expect(typed.reason).toBe('rate_limited');
    expect(typed.status).toBe(429);
    expect(typed.message).not.toContain('sk_live');
    expect(typed.message).not.toContain('internal.vendor.test');
    expect(typed.message).not.toContain('slow down');
  });
});

describe('disconnecting', () => {
  /**
   * **The per-source external user id, observed as a deletion that spares the
   * other two sources.**
   *
   * This is the whole reason the id is per source. The vendor offers no
   * per-account revocation — `deleteExternalUser` is the only one — so whatever
   * an external user spans is what a disconnect destroys. With a tenant-wide id
   * this test would still pass every type check and would revoke a user's
   * calendar and drive when they unhooked their mailbox.
   */
  test('deletes the external user of the named source alone', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/users/', { status: 204, body: {} });

    const outcome = await vendorOver(transport).disconnect({ tenantId: TENANT, source: 'gmail' });
    expect(outcome.deleted).toBe(true);

    const deletion = transport.requests.find((request) => request.method === 'DELETE');
    expect(deletion?.url).toContain(`/users/${TENANT}-gmail`);
    expect(deletion?.url).not.toContain(`/users/${TENANT}?`);
    // The other two sources' external users are untouched, which is only true
    // because they are different records at the vendor.
    expect(deletion?.url).not.toContain('calendar');
    expect(deletion?.url).not.toContain('drive');
  });

  /**
   * `tokensRevoked` is carried verbatim. Promoting it to `confirmed` puts a
   * sentence in a privacy policy that no vendor has said — see
   * `docs/vendor/2026-08-12-pipedream-compliance.md`.
   */
  test('reports the vendor’s revocation evidence rather than an upgrade of it', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/users/', { status: 202, body: {} });

    const outcome = await vendorOver(transport).disconnect({ tenantId: TENANT, source: 'calendar' });
    // A 202 says the request was queued, not that the record is gone.
    expect(outcome.deleted).toBe(false);
    expect(outcome.tokensRevoked).toBe('unverified');
  });

  test('a refused deletion is typed too, and names the operation', async () => {
    const transport = withToken(createScriptedTransport());
    transport.on('/users/', { status: 500, body: { error: 'boom' } });

    const failure = await vendorOver(transport)
      .disconnect({ tenantId: TENANT, source: 'drive' })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(failure).toBeInstanceOf(ConnectorVendorError);
    expect((failure as ConnectorVendorError).operation).toBe('delete_external_user');
    expect((failure as ConnectorVendorError).reason).toBe('provider_error');
  });
});

describe('the external user id', () => {
  test('is one record per tenant per source, and they do not collide', () => {
    expect(externalUserIdFor(TENANT, 'gmail')).toBe(`${TENANT}-gmail`);
    const ids = new Set([
      externalUserIdFor(TENANT, 'gmail'),
      externalUserIdFor(TENANT, 'calendar'),
      externalUserIdFor(TENANT, 'drive'),
    ]);
    expect(ids.size).toBe(3);
  });

  /**
   * It becomes a URL path segment on the deletion call, where the consequence of
   * an unanchored value is erasing the wrong person's record or silently erasing
   * nobody. A tenant id long enough to overflow the alphabet is refused where it
   * is derived rather than at the vendor.
   */
  test('refuses a tenant id that would overflow the anchored alphabet', () => {
    const longest = `t-${'a'.repeat(61)}`;
    expect(longest.length).toBe(63);
    expect(() => externalUserIdFor(longest, 'calendar')).toThrow(ExternalUserIdError);
  });
});
