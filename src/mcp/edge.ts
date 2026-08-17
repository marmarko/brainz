/**
 * The edge: tenant resolution and admission control, in front of the fleet.
 *
 * **Separate from `router.ts` on purpose.** The Worker entrypoint imports
 * `@cloudflare/containers`, which imports the `cloudflare:workers` module — a
 * runtime built-in that only exists inside workerd. A blocking test cannot load
 * it, so anything that has to be *tested* cannot live in that file. Splitting the
 * two puts the Container classes (a deployment concern, exercised by deploying)
 * on one side and the request logic (a correctness concern, exercised by tests)
 * on the other.
 *
 * **The tenant comes from the credential.** A tenant id taken from a request
 * parameter is a cross-tenant routing bug, and it would be one the connection
 * LRU then caches. The id read here is a *routing hint*, not authorisation — the
 * signature that makes it one is verified inside the instance, in `dispatch.ts`,
 * against a secret only that tenant's fleet identity can resolve. A forged token
 * therefore reaches an instance and is refused there; it never reaches a
 * database.
 *
 * **Admission runs before the Durable Object is addressed.** Containers bill per
 * 10ms of instance time, so a limiter consulted inside the instance has already
 * paid for it. R14's caps meter model spend; this is the only thing that meters
 * compute.
 *
 * **The table is closed, and it now spans two fleets.** The web app answers on
 * this origin — it has to, because a session cookie is scoped to an origin and
 * `/authorize` has to read the one the login page wrote — so a path here belongs
 * to the web fleet, or to the MCP fleet's shared flow instance, or to a tenant's
 * own MCP instance, or to nobody. Nobody is a 404 this Worker answers itself:
 * under the previous shape "presented a bearer" meant "is an MCP request", so
 * any path at all could wake a container billed per 10ms to be told it does not
 * exist.
 */

import { createHash } from 'node:crypto';

import { tenantOfToken } from './oauth.ts';
import type { EdgeLimiter } from './rate-limit.ts';

/**
 * The paths a connector reaches **before** it holds a credential.
 *
 * Discovery, registration and the token exchange all carry no bearer by
 * construction — that is what they are for — so a tenant-derived routing rule
 * has nothing to route them by, and answering them with the 401 that starts
 * discovery makes discovery a loop. They go to one fixed instance instead.
 */
const PUBLIC_FLOW_PATHS: ReadonlySet<string> = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-authorization-server',
  '/register',
  '/authorize',
  '/token',
  // `/revoke` is deliberately NOT here. It requires the tenant's bearer, so it
  // has a tenant to route by — and it must use it: the revocation list is the
  // one piece of flow state `dispatch` reads, on the *tenant's* instance, on
  // every call. Sent to the shared flow instance a revocation would be recorded
  // somewhere no tool call ever looks, and the endpoint would answer 200 while
  // the grant kept working.
]);

/**
 * The instance every hop of the authorization flow lands on.
 *
 * `/authorize` carries the tenant's bearer and could be routed by tenant like
 * everything else — and must not be. The registration, the single-use code and
 * the refresh record are one store, and a flow whose three hops address three
 * instances fails at the token endpoint as `invalid_grant`: a routing fault
 * wearing a client error, which is the hardest kind to find from the outside.
 * One name for the whole flow is what makes the store's locality a property
 * rather than a coincidence. (It is also the seam a durable store replaces —
 * when one exists, this constant is what stops mattering.)
 */
export const FLOW_INSTANCE = 'oauth-flow';

/**
 * The paths the **web app** answers, enumerated the way the flow paths above
 * are, and for a stricter reason.
 *
 * **Why the web app is on this origin at all.** A session cookie is scoped to an
 * origin. `/authorize` renders consent for a logged-in user, which means it has
 * to read the cookie the login page wrote — and it cannot, if the login page
 * lives on another host. So the web app is not merely *also* deployed here; it
 * is deployed here because that is the only arrangement in which the consent
 * screen has a session to read at all.
 *
 * **Enumerated, not matched.** A prefix rule would be one edit away from
 * swallowing a path the MCP surface owns, and the direction of that mistake is a
 * tool call answered by a router that has never heard of it. These are the exact
 * literals `src/web/app.ts` dispatches on; `test/mcp/router.test.ts` derives that
 * file's own route table and checks this set against it in both directions, so
 * the copy cannot go stale in silence.
 *
 * `/` is here although nothing outside the app requests it: the app routes it —
 * to the dashboard with a session, to the login page without one — and a bare
 * origin answering 404 beside a working `/login` is a papercut with no argument
 * behind it.
 */
const WEB_PATHS: ReadonlySet<string> = new Set([
  // Pages a browser lands on.
  '/',
  '/login',
  '/signup',
  '/dashboard',
  '/connect',
  '/password/reset',
  '/password/sent',
  '/password/complete',
  // The app's own API, which its pages call and nothing else does. Written out
  // one by one rather than as `/api/*` so that adding a route is a decision
  // taken at this layer too — this is the file that says what the public origin
  // exposes, and a wildcard would let a new endpoint become public by being
  // written.
  '/api/signup',
  '/api/login',
  '/api/logout',
  '/api/password/reset',
  '/api/password/complete',
  '/api/me',
  '/api/spend',
  '/api/brain',
  '/api/connect',
  '/api/connectors',
  '/api/byok',
  '/api/export-config',
  '/api/billing/checkout',
  // Authenticated by a vendor signature rather than by a session, and therefore
  // outside every cookie rule — see `applyBillingEvent`.
  '/api/billing/webhook',
  '/api/severance',
  '/api/severance/preview',
  '/api/subject-erasure',
  '/api/subject-erasure/preview',
]);

/**
 * The one prefix, and the reason it is a prefix rather than a list.
 *
 * `src/web/app.ts` dispatches `/admin` with `startsWith` and handles everything
 * under it inside `handleAdmin`, where this layer cannot see the sub-paths. A
 * literal list here would therefore be a guess about a router that does not
 * enumerate itself, and the guess would be wrong the first time an operator
 * route is added. Fidelity to the router being fronted is the rule; this is the
 * one place where being faithful means carrying a prefix.
 *
 * It is safe in the direction that matters because the MCP surface owns no path
 * under `/admin` and never will: its endpoints are `/mcp` and `/openai` plus the
 * OAuth flow paths, all of them named in the discovery documents.
 *
 * Bounded at a segment, which is deliberately *stricter* than the `startsWith`
 * it mirrors: `/admin` and `/admin/anything` are the admin surface, and
 * `/administrator` is not a path anybody meant to expose.
 */
const WEB_PATH_PREFIXES: readonly string[] = ['/admin'];

/**
 * The paths served **inside a tenant's own instance**, addressed by the tenant
 * the credential names.
 *
 * `/health` is here rather than exempted, which is a decision the runbook
 * depends on: an unauthenticated liveness route on a public origin in front of
 * scale-to-zero containers billed per 10ms is a free way for a stranger to wake
 * every instance in the fleet. So it authenticates like everything else, answers
 * `401` to a request with no bearer, and `docs/deploy.md` check 1 reads that 401
 * as the pass. The platform's own readiness probe reaches `pingEndpoint` inside
 * the Durable Object and never crosses this edge.
 */
const TENANT_PATHS: ReadonlySet<string> = new Set(['/mcp', '/openai', '/revoke', '/health']);

/**
 * The instance every web request lands on — one, and the name is the mechanism.
 *
 * **A tenant-derived id would be wrong here**, and not merely unnecessary: the
 * web app serves `/signup`, which runs before any tenant exists, and it
 * authenticates by session cookie rather than by a bearer this layer can read.
 * There is nothing to derive an id from on the request that matters most.
 *
 * **So why one name rather than several?** Because `src/control/secret-file.ts`
 * assumes a single writer, and the web process is it: provisioning writes a new
 * tenant's connection string and bearer into that store. Two web instances are
 * two divergent stores of the same tenants' credentials, which is a data-loss
 * shape rather than a scaling trade. Everything else the app holds is in
 * Postgres — sessions included — so statelessness is not what pins this to one
 * instance; the writer assumption is.
 *
 * **The ceiling, stated rather than discovered.** Every signup, login, dashboard
 * render and billing webhook for the whole deployment is served by one container
 * instance, bounded by its CPU and by the identity pool's handful of
 * connections. At alpha volume that is ample and the wake cost matters more than
 * the throughput. When it stops being ample the fix is not a second instance —
 * that reintroduces the divergent store — it is the managed secret store that
 * removes the single-writer assumption, after which this constant is what stops
 * mattering, exactly as {@link FLOW_INSTANCE} does.
 */
export const WEB_INSTANCE = 'web-singleton';

/**
 * Which fleet, if any, a path belongs to.
 *
 * `unrouted` is the point of the type. The edge used to treat "has a bearer" as
 * "is an MCP request", so every path in the world was an MCP path: a probe, a
 * crawler or a typo woke a container billed per 10ms to be answered `not found`
 * by a process that had to boot first. A path now belongs to a fleet or it
 * belongs to nobody, and nobody is a 404 this Worker answers itself.
 */
export type PathClass = 'web' | 'flow' | 'tenant' | 'unrouted';

export function classifyPath(path: string): PathClass {
  if (WEB_PATHS.has(path)) return 'web';
  for (const prefix of WEB_PATH_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return 'web';
  }
  if (PUBLIC_FLOW_PATHS.has(path)) return 'flow';
  if (TENANT_PATHS.has(path)) return 'tenant';
  return 'unrouted';
}

/**
 * The declared web paths, for a test that checks them against the app's own
 * router. Exported for that check and for nothing else — the routing decision is
 * {@link classifyPath}'s, and a caller reading the set to make its own would be
 * a second router.
 */
export function webPathsDeclared(): readonly string[] {
  return [...WEB_PATHS].sort();
}

/** The shape this file needs from a Durable Object namespace, and no more. */
export interface FleetBinding<Id = unknown> {
  idFromName(name: string): Id;
  get(id: Id): { fetch(request: Request): Promise<Response> };
}

/**
 * Resolve the tenant this request belongs to.
 *
 * Reads the presented bearer and nothing else. A query parameter, a header or a
 * body field naming a tenant is ignored, and the test that matters is the one
 * asserting a request whose query string names another tenant still routes to
 * the credential's.
 */
export function resolveTenant(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null) return null;
  return tenantOfToken(header);
}

/** The request path, without throwing on a URL this Worker cannot parse. */
function pathOf(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return '';
  }
}

/** The client address, as Cloudflare presents it. */
function callerIp(request: Request): string | null {
  const direct = request.headers.get('cf-connecting-ip');
  if (direct !== null && direct.length > 0) return direct;
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded === null) return null;
  const first = forwarded.split(',')[0]?.trim();
  return first === undefined || first.length === 0 ? null : first;
}

/**
 * A stable key for the per-grant lane, without verifying the grant.
 *
 * The edge cannot verify a signature — the secret lives behind the tenant's own
 * identity, inside the instance — so this keys on the credential *as presented*.
 * That is what the lane needs: an attacker replaying one stolen token shares one
 * bucket, and an attacker minting fresh garbage gets a fresh bucket each time and
 * is bounded by the per-IP lane instead. Both are covered; neither pretends this
 * is authentication.
 */
function grantKey(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header === null || header.length === 0) return null;
  // `node:crypto`, not the runtime's fast hash. This module is bundled into the
  // Worker named in `wrangler.toml`, which runs in workerd — where `Bun` is not
  // defined, so a `Bun.hash` here is a ReferenceError on the first production
  // request, thrown from an argument expression *outside* the limiter's own
  // try/catch and therefore not even reaching the fail-closed refusal. The suite
  // could not see it because the suite runs in Bun.
  //
  // A cryptographic digest also keeps the bucket map from retaining a live
  // credential: the map outlives the request by up to `idleEvictionMs`.
  return `presented:${createHash('sha256').update(header).digest('hex').slice(0, 32)}`;
}

/**
 * Forward to one instance, turning an instance that will not answer into an
 * upstream failure rather than a stack trace.
 */
async function forward<Id>(
  fleet: FleetBinding<Id>,
  instance: string,
  request: Request,
): Promise<Response> {
  try {
    return await fleet.get(fleet.idFromName(instance)).fetch(request);
  } catch {
    // An instance that failed to start or died mid-request is an upstream
    // failure, not a client error — and it must not leak the exception text,
    // which is the ordinary way a connection string reaches a response body.
    return Response.json({ error: 'instance_unavailable' }, { status: 502 });
  }
}

export async function handleFleetRequest<Id>(
  request: Request,
  deps: {
    readonly mcp: FleetBinding<Id>;
    readonly web: FleetBinding<Id>;
    readonly limiter: EdgeLimiter;
  },
): Promise<Response> {
  const tenantId = resolveTenant(request);
  const admission = deps.limiter.admit({
    ip: callerIp(request),
    grantId: grantKey(request),
    tenantId,
  });

  if (!admission.ok) {
    return Response.json(
      { error: 'rate_limited', reason: admission.reason ?? 'unavailable' },
      { status: 429, headers: { 'retry-after': String(admission.retryAfterSeconds ?? 1) } },
    );
  }

  try {
    // The table is consulted before the credential, and that ordering is the
    // decision: what a path IS does not depend on what the caller happens to be
    // carrying. A web path presented with a tenant bearer is still the web app's
    // — it authenticates by cookie — and an unrouted path is unrouted whether or
    // not the request holds a valid grant.
    const destination = classifyPath(pathOf(request));

    if (destination === 'unrouted') {
      // Answered here, by the Worker, waking nothing. A container billed per
      // 10ms should not boot to say `not found` on behalf of a crawler.
      return Response.json({ error: 'not_found' }, { status: 404 });
    }

    // The web app has no bearer to present and must not be asked for one: its
    // front door is `/signup`, reached by a stranger, and its session lives in a
    // cookie this layer deliberately does not read. Admission control above is
    // what stands in front of it.
    if (destination === 'web') return await forward(deps.web, WEB_INSTANCE, request);

    if (tenantId === null && destination !== 'flow') {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'www-authenticate':
            'Bearer realm="brainz", resource_metadata="/.well-known/oauth-protected-resource"',
        },
      });
    }

    // The affinity rule, in one line: the DO id is derived from the tenant id,
    // so the same tenant reaches the same instance and its warm connections.
    // The authorization flow is the one exception, and it is an exception in
    // both directions — its unauthenticated hops have no tenant to route by,
    // and its one authenticated hop must not be routed by the tenant it does
    // have, or the code it mints lands somewhere the token endpoint cannot
    // reach.
    return await forward(
      deps.mcp,
      destination === 'flow' ? FLOW_INSTANCE : (tenantId as string),
      request,
    );
  } finally {
    // Released on every path. A ceiling that leaks a slot per crash is a
    // ceiling that closes the tenant's own brain after enough bad days.
    admission.release();
  }
}
