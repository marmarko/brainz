/**
 * The Worker seam — tenant affinity (U1's decision), the edge limiter that
 * sits in front of it (U6 approach 6), and the closed route table that puts the
 * web app on this origin alongside the MCP surface.
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
 *
 * **The third thing, and the reason a second binding appears in every call
 * below.** A session cookie is scoped to an origin, so the web app has to answer
 * on the same origin as `/authorize` or the consent screen has no session to
 * read. That makes the edge a router between two fleets rather than a doorman in
 * front of one, and the property under test is that the table is **closed**: a
 * path is web, or flow, or tenant-addressed, or it is a 404 that wakes nothing.
 * A fallthrough into either fleet is what this suite exists to refuse — in both
 * directions, since a web path that reached the MCP fleet is a login page that
 * 404s and an MCP path that reached the web fleet is a tool call answered by a
 * router that has never heard of it.
 */

import { describe, expect, test } from 'bun:test';

import { DEFAULT_EDGE_LIMITS, createEdgeLimiter } from '../../src/mcp/rate-limit.ts';
import { mintTenantBearer } from '../../src/mcp/oauth.ts';
import {
  FLOW_INSTANCE,
  WEB_INSTANCE,
  classifyPath,
  handleFleetRequest,
  resolveTenant,
  webPathsDeclared,
} from '../../src/mcp/edge.ts';

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

/** The two bindings the edge routes between, fresh per test. */
function fleets(): { readonly mcp: FleetStub; readonly web: FleetStub } {
  return { mcp: fleetStub(), web: fleetStub() };
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

/** A request to `path` on the origin, so a test reads as a path rather than a URL. */
function at(path: string, init: { readonly bearer?: string | null } = {}): Request {
  return request({ ...init, url: `https://mcp.brainz.app${path}` });
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
    const { mcp, web } = fleets();
    const limiter = createEdgeLimiter({ now: () => 0 });
    await handleFleetRequest(request(), { mcp, web, limiter });
    await handleFleetRequest(request({ ip: '203.0.113.9' }), { mcp, web, limiter });
    expect(mcp.reached).toEqual(['tenant-a', 'tenant-a']);
    expect(web.addressed).toEqual([]);
  });
});

describe('the limiter runs before the container', () => {
  test('a refused request never reaches the fleet', async () => {
    const { mcp, web } = fleets();
    const limiter = createEdgeLimiter({
      now: () => 0,
      limits: { ...DEFAULT_EDGE_LIMITS, perIpBurst: 1 },
    });

    const first = await handleFleetRequest(request(), { mcp, web, limiter });
    expect(first.status).toBe(200);

    const second = await handleFleetRequest(request(), { mcp, web, limiter });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).not.toBeNull();
    expect(mcp.reached).toHaveLength(1);
    // The instance was never even addressed on the refused call.
    expect(mcp.addressed).toHaveLength(1);

    const body = (await second.json()) as { error: string; reason: string };
    expect(body.error).toBe('rate_limited');
    expect(body.reason).toBe('per_ip');
  });

  test('an unauthenticated flood is refused on the IP lane without waking anything', async () => {
    const { mcp, web } = fleets();
    const limiter = createEdgeLimiter({
      now: () => 0,
      limits: { ...DEFAULT_EDGE_LIMITS, perIpBurst: 0 },
    });
    const response = await handleFleetRequest(request({ bearer: null }), { mcp, web, limiter });
    expect(response.status).toBe(429);
    expect(mcp.reached).toHaveLength(0);
    expect(mcp.addressed).toHaveLength(0);
  });

  /**
   * The web fleet is behind the same door, and it is the one that needs it most:
   * `/signup` is reachable without any credential at all, so the limiter is the
   * only thing between a stranger and a container that provisions databases.
   */
  test('a flood at the signup page is refused without waking the web fleet', async () => {
    const { mcp, web } = fleets();
    const limiter = createEdgeLimiter({
      now: () => 0,
      limits: { ...DEFAULT_EDGE_LIMITS, perIpBurst: 0 },
    });
    const response = await handleFleetRequest(at('/signup', { bearer: null }), { mcp, web, limiter });
    expect(response.status).toBe(429);
    expect(web.addressed).toHaveLength(0);
    expect(mcp.addressed).toHaveLength(0);
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

    const first = await handleFleetRequest(request(), { mcp: exploding, web: fleetStub(), limiter });
    expect(first.status).toBe(502);
    expect(limiter.inFlight('tenant-a')).toBe(0);

    // If the slot had leaked, this second call would be refused on concurrency.
    const second = await handleFleetRequest(request(), { mcp: exploding, web: fleetStub(), limiter });
    expect(second.status).toBe(502);
  });

  test('an unauthenticated request that clears the limiter is refused, not routed', async () => {
    const { mcp, web } = fleets();
    const limiter = createEdgeLimiter({ now: () => 0 });
    const response = await handleFleetRequest(request({ bearer: null }), { mcp, web, limiter });
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    expect(mcp.reached).toHaveLength(0);
    expect(web.reached).toHaveLength(0);
  });
});

describe('the web app answers on this origin', () => {
  /**
   * The reason the web app is here at all rather than on a host of its own: a
   * cookie is scoped to an origin. `/authorize` cannot read a session written by
   * a login page on another host, so the consent screen the founder chose is only
   * possible if these paths and that one share an origin.
   */
  test('every declared web path reaches the web fleet, with no credential at all', async () => {
    for (const path of webPathsDeclared()) {
      const { mcp, web } = fleets();
      const limiter = createEdgeLimiter({ now: () => 0 });
      const response = await handleFleetRequest(at(path, { bearer: null }), { mcp, web, limiter });
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      expect({ path, addressed: web.addressed }).toEqual({ path, addressed: [WEB_INSTANCE] });
      expect({ path, mcp: mcp.addressed }).toEqual({ path, mcp: [] });
    }
  });

  /**
   * `/admin` is the one entry declared as a prefix, and it is a prefix because
   * the app it fronts dispatches it as one: everything under it is handled
   * inside `handleAdmin`, where this layer cannot see the sub-paths.
   */
  test('the admin surface reaches the web fleet including its sub-paths', async () => {
    for (const path of ['/admin', '/admin/tenants', '/admin/spend?days=7']) {
      const { mcp, web } = fleets();
      const limiter = createEdgeLimiter({ now: () => 0 });
      await handleFleetRequest(at(path, { bearer: null }), { mcp, web, limiter });
      expect({ path, addressed: web.addressed }).toEqual({ path, addressed: [WEB_INSTANCE] });
      expect({ path, mcp: mcp.addressed }).toEqual({ path, mcp: [] });
    }
  });

  /**
   * The path decides, never the credential. A browser arriving at `/dashboard`
   * with a stale MCP bearer in some extension's header, or a connector that
   * points at the wrong path, must not have its request re-aimed by what it
   * happens to be carrying — the web app authenticates by cookie and would be
   * handed a request the MCP fleet had already claimed.
   */
  test('a tenant bearer does not move a web path onto the MCP fleet', async () => {
    const { mcp, web } = fleets();
    const limiter = createEdgeLimiter({ now: () => 0 });
    await handleFleetRequest(at('/dashboard'), { mcp, web, limiter });
    expect(web.addressed).toEqual([WEB_INSTANCE]);
    expect(mcp.addressed).toEqual([]);
  });

  /**
   * One instance, and the name is the mechanism. The web process is
   * `src/control/secret-file.ts`'s single writer by assumption; two instances
   * are two divergent stores of the same tenants' connection strings.
   */
  test('every web request lands on one named instance', async () => {
    const { mcp, web } = fleets();
    const limiter = createEdgeLimiter({ now: () => 0 });
    await handleFleetRequest(at('/login', { bearer: null }), { mcp, web, limiter });
    await handleFleetRequest(at('/signup', { bearer: null, }), { mcp, web, limiter });
    await handleFleetRequest(at('/api/me'), { mcp, web, limiter });
    expect(new Set(web.reached)).toEqual(new Set([WEB_INSTANCE]));
    expect(web.reached).toHaveLength(3);
    // And it is not the flow instance, which is a name on the *other* binding.
    expect(WEB_INSTANCE).not.toBe(FLOW_INSTANCE);
  });
});

describe('the route table is closed', () => {
  /**
   * The failure this refuses: a path nobody routed reaching a fleet by default.
   * Under the previous shape every path with a bearer was an MCP path, so a
   * typo, a probe or a crawler woke a container billed per 10ms to be answered
   * `not found` by a process that had to boot first.
   */
  test('an unrouted path is a 404 that addresses no fleet at all', async () => {
    for (const path of ['/wp-login.php', '/mcp/extra', '/apifoo', '/.well-known/openid-configuration', '/loginn']) {
      const { mcp, web } = fleets();
      const limiter = createEdgeLimiter({ now: () => 0 });
      const response = await handleFleetRequest(at(path, { bearer: null }), { mcp, web, limiter });
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      expect({ path, mcp: mcp.addressed, web: web.addressed }).toEqual({ path, mcp: [], web: [] });
    }
  });

  /**
   * And a credential does not open one. If the 404 were only the 401 wearing a
   * different number, presenting a valid bearer would let the request through —
   * which is exactly how a fallthrough survives a test suite.
   */
  test('a valid tenant bearer does not turn an unrouted path into a routed one', async () => {
    const { mcp, web } = fleets();
    const limiter = createEdgeLimiter({ now: () => 0 });
    const response = await handleFleetRequest(at('/not-a-route'), { mcp, web, limiter });
    expect(response.status).toBe(404);
    expect(mcp.addressed).toEqual([]);
    expect(web.addressed).toEqual([]);
  });

  /**
   * `docs/deploy.md` check 1 is "the origin is up and refuses correctly", and
   * the pass condition it documents is `401` on `/health` — the edge
   * authenticating before it routes. A closed table must not quietly turn the
   * runbook's liveness check into a 404, which would read as "the deploy is
   * broken" to the next person following it.
   */
  test('the runbook’s liveness check still answers 401, not 404', async () => {
    const { mcp, web } = fleets();
    const limiter = createEdgeLimiter({ now: () => 0 });
    const response = await handleFleetRequest(at('/health', { bearer: null }), { mcp, web, limiter });
    expect(response.status).toBe(401);
    expect(mcp.addressed).toEqual([]);
    expect(web.addressed).toEqual([]);
  });

  test('and with a credential it reaches the tenant’s own instance', async () => {
    const { mcp, web } = fleets();
    const limiter = createEdgeLimiter({ now: () => 0 });
    await handleFleetRequest(at('/health'), { mcp, web, limiter });
    expect(mcp.addressed).toEqual(['tenant-a']);
    expect(web.addressed).toEqual([]);
  });

  /**
   * The authorization flow keeps its own instance on the MCP binding: its three
   * hops share one store, and a flow whose hops address three instances fails at
   * the token endpoint as `invalid_grant`.
   */
  test('the unauthenticated flow paths still reach the MCP fleet’s flow instance', async () => {
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
      '/register',
      '/authorize',
      '/token',
    ]) {
      const { mcp, web } = fleets();
      const limiter = createEdgeLimiter({ now: () => 0 });
      const response = await handleFleetRequest(at(path, { bearer: null }), { mcp, web, limiter });
      expect({ path, status: response.status }).toEqual({ path, status: 200 });
      expect({ path, addressed: mcp.addressed }).toEqual({ path, addressed: [FLOW_INSTANCE] });
      expect({ path, web: web.addressed }).toEqual({ path, web: [] });
    }
  });

  test('the MCP surface still routes by tenant, and never to the web fleet', async () => {
    for (const path of ['/mcp', '/openai', '/revoke']) {
      const { mcp, web } = fleets();
      const limiter = createEdgeLimiter({ now: () => 0 });
      await handleFleetRequest(at(path), { mcp, web, limiter });
      expect({ path, addressed: mcp.addressed }).toEqual({ path, addressed: ['tenant-a'] });
      expect({ path, web: web.addressed }).toEqual({ path, web: [] });
    }
  });

  test('a URL this Worker cannot parse routes nowhere', () => {
    expect(classifyPath('')).toBe('unrouted');
  });
});

describe('the edge’s web table is the web app’s own table', () => {
  /**
   * **The drift this refuses.** The edge enumerates the web app's paths, and an
   * enumeration in one file of a router in another is a copy that goes stale:
   * a route added to `src/web/app.ts` would answer 404 at the edge while the app
   * behind it served it perfectly, which presents as a dead button rather than
   * as a routing bug. So the table is checked against the router it fronts,
   * derived from that file rather than restated here.
   *
   * Read as text, in both directions. A path the app routes and the edge does
   * not is unreachable; a path the edge routes and the app no longer has is an
   * entry nobody re-read, and it forwards a request to be 404'd one layer deeper
   * after waking a container to do it.
   */
  const APP = `${import.meta.dir}/../../src/web/app.ts`;

  /** Every literal `path === '…'` the web app's router dispatches on. */
  async function appRoutes(): Promise<string[]> {
    const text = await Bun.file(APP).text();
    const found = [...text.matchAll(/path === '([^']+)'/g)].map((match) => match[1] as string);
    return [...new Set(found)].sort();
  }

  test('the extraction finds the app’s real routes rather than nothing', async () => {
    const routes = await appRoutes();
    // Vacuity first: a regex that matches nothing would make both directions
    // below pass while asserting about an empty set.
    expect(routes.length).toBeGreaterThan(20);
    expect(routes).toContain('/signup');
    expect(routes).toContain('/api/billing/webhook');
  });

  test('every path the web app routes is routed to the web fleet', async () => {
    for (const path of await appRoutes()) {
      expect({ path, destination: classifyPath(path) }).toEqual({ path, destination: 'web' });
    }
  });

  test('and every path the edge sends to the web fleet is one the app still has', async () => {
    const routes = new Set(await appRoutes());
    for (const path of webPathsDeclared()) {
      expect({ path, known: routes.has(path) }).toEqual({ path, known: true });
    }
  });
});
