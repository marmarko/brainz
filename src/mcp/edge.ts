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
 */

import { tenantOfToken } from './oauth.ts';
import type { EdgeLimiter } from './rate-limit.ts';

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
  return `presented:${Bun.hash(header).toString(16)}`;
}

export async function handleFleetRequest<Id>(
  request: Request,
  deps: { readonly fleet: FleetBinding<Id>; readonly limiter: EdgeLimiter },
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
    if (tenantId === null) {
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
    const id = deps.fleet.idFromName(tenantId);
    try {
      return await deps.fleet.get(id).fetch(request);
    } catch {
      // An instance that failed to start or died mid-request is an upstream
      // failure, not a client error — and it must not leak the exception text,
      // which is the ordinary way a connection string reaches a response body.
      return Response.json({ error: 'instance_unavailable' }, { status: 502 });
    }
  } finally {
    // Released on every path. A ceiling that leaks a slot per crash is a
    // ceiling that closes the tenant's own brain after enough bad days.
    admission.release();
  }
}
