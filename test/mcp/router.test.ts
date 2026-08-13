/**
 * The Worker seam — tenant affinity (U1's decision) and the edge limiter that
 * now sits in front of it (U6 approach 6).
 *
 * **The whole point is the ordering.** A rate limiter that runs inside the
 * container has already paid for the container: Cloudflare Containers bill per
 * 10ms of instance time, and a flood against a public origin fronting
 * scale-to-zero instances is a bill rather than an outage. So the fleet stub
 * below records whether it was reached at all, and the refusal test asserts the
 * count is zero — not merely that the response was a 429.
 *
 * **And the affinity, which U1 could only half-express.** `resolveTenant`
 * returned `null` because there was no auth layer; now the tenant comes from the
 * grant. The test that matters is the negative one: a tenant id taken from a
 * request parameter is a cross-tenant routing bug that the connection LRU then
 * caches, so a query string naming another tenant must not move the request.
 */

import { describe, expect, test } from 'bun:test';

import { DEFAULT_EDGE_LIMITS, createEdgeLimiter } from '../../src/mcp/rate-limit.ts';
import { mintTenantBearer } from '../../src/mcp/oauth.ts';
import { handleFleetRequest, resolveTenant } from '../../src/mcp/edge.ts';

interface FleetStub {
  /** Instances whose `fetch` ran. */
  readonly reached: string[];
  /**
   * Instances that were *addressed* — `get()` on a Durable Object namespace is
   * what wakes an instance, so this is the count that corresponds to money. A
   * limiter consulted after the address is a limiter that saved nothing.
   */
  readonly addressed: string[];
  idFromName(name: string): { readonly name: string };
  get(id: { readonly name: string }): { fetch(request: Request): Promise<Response> };
}

function fleetStub(): FleetStub {
  const reached: string[] = [];
  const addressed: string[] = [];
  return {
    reached,
    addressed,
    idFromName(name: string) {
      return { name };
    },
    get(id: { readonly name: string }) {
      addressed.push(id.name);
      return {
        fetch(): Promise<Response> {
          reached.push(id.name);
          return Promise.resolve(Response.json({ ok: true }));
        },
      };
    },
  };
}

const BEARER = mintTenantBearer('tenant-a');

function request(init: { readonly bearer?: string | null; readonly ip?: string; readonly url?: string } = {}): Request {
  const headers: Record<string, string> = {};
  const bearer = init.bearer === undefined ? BEARER : init.bearer;
  if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
  headers['cf-connecting-ip'] = init.ip ?? '198.51.100.7';
  return new Request(init.url ?? 'https://mcp.brainz.app/mcp', {
    method: 'POST',
    headers,
    body: '{}',
  });
}

describe('tenant affinity', () => {
  test('the tenant comes from the credential', () => {
    expect(resolveTenant(request())).toBe('tenant-a');
  });

  test('a request parameter never names the tenant', () => {
    expect(resolveTenant(request({ url: 'https://mcp.brainz.app/mcp?tenant=tenant-b' }))).toBe('tenant-a');
    expect(resolveTenant(request({ bearer: null, url: 'https://mcp.brainz.app/mcp?tenant=tenant-b' }))).toBeNull();
  });

  test('a malformed credential routes nowhere rather than somewhere arbitrary', () => {
    expect(resolveTenant(request({ bearer: 'bzk_../../etc_secret' }))).toBeNull();
    expect(resolveTenant(request({ bearer: 'not-a-brainz-token' }))).toBeNull();
  });

  test('the same tenant always reaches the same instance name', async () => {
    const fleet = fleetStub();
    const limiter = createEdgeLimiter({ now: () => 0 });
    await handleFleetRequest(request(), { fleet, limiter });
    await handleFleetRequest(request({ ip: '203.0.113.9' }), { fleet, limiter });
    expect(fleet.reached).toEqual(['tenant-a', 'tenant-a']);
  });
});

describe('the limiter runs before the container', () => {
  test('a refused request never reaches the fleet', async () => {
    const fleet = fleetStub();
    const limiter = createEdgeLimiter({
      now: () => 0,
      limits: { ...DEFAULT_EDGE_LIMITS, perIpBurst: 1 },
    });

    const first = await handleFleetRequest(request(), { fleet, limiter });
    expect(first.status).toBe(200);

    const second = await handleFleetRequest(request(), { fleet, limiter });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).not.toBeNull();
    expect(fleet.reached).toHaveLength(1);
    // The instance was never even addressed on the refused call.
    expect(fleet.addressed).toHaveLength(1);

    const body = (await second.json()) as { error: string; reason: string };
    expect(body.error).toBe('rate_limited');
    expect(body.reason).toBe('per_ip');
  });

  test('an unauthenticated flood is refused on the IP lane without waking anything', async () => {
    const fleet = fleetStub();
    const limiter = createEdgeLimiter({
      now: () => 0,
      limits: { ...DEFAULT_EDGE_LIMITS, perIpBurst: 0 },
    });
    const response = await handleFleetRequest(request({ bearer: null }), { fleet, limiter });
    expect(response.status).toBe(429);
    expect(fleet.reached).toHaveLength(0);
    expect(fleet.addressed).toHaveLength(0);
  });

  test('the concurrency slot is released even when the instance throws', async () => {
    const limiter = createEdgeLimiter({
      now: () => 0,
      limits: { ...DEFAULT_EDGE_LIMITS, tenantConcurrency: 1 },
    });
    const exploding: FleetStub = {
      reached: [],
      addressed: [],
      idFromName: (name) => ({ name }),
      get: () => ({
        fetch(): Promise<Response> {
          return Promise.reject(new Error('the instance fell over'));
        },
      }),
    };

    const first = await handleFleetRequest(request(), { fleet: exploding, limiter });
    expect(first.status).toBe(502);
    expect(limiter.inFlight('tenant-a')).toBe(0);

    // If the slot had leaked, this second call would be refused on concurrency.
    const second = await handleFleetRequest(request(), { fleet: exploding, limiter });
    expect(second.status).toBe(502);
  });

  test('an unauthenticated request that clears the limiter is refused, not routed', async () => {
    const fleet = fleetStub();
    const limiter = createEdgeLimiter({ now: () => 0 });
    const response = await handleFleetRequest(request({ bearer: null }), { fleet, limiter });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(fleet.reached).toHaveLength(0);
  });
});
