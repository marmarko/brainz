/**
 * The Worker entrypoint in front of both container fleets (U1 step 6, KTD2).
 *
 * Cloudflare Containers are reached *through* a Worker: a Durable Object routes
 * to instances, so the shape is Worker -> DO -> Container, not Worker-instead-of-
 * Container. This file is that Worker plus the two DO classes.
 *
 * WHY THIS IS U1 AND NOT U6
 * -------------------------
 * The MCP protocol handling is U6's. What lives here is the routing seam, and
 * it belongs to Phase 0 for two reasons. First, the plan makes the deployed
 * runtime a Phase 0 deliverable rather than an assumption — U6's connector
 * connection, U9's week of polling and U13's two-week bake all verify against a
 * continuously running fleet, and a wrangler config whose entry point does not
 * exist deploys nothing. Second, tenant affinity is a KTD2 decision, not an
 * implementation detail, and the decision has to be expressed in code before
 * anything routes.
 *
 * TENANT AFFINITY IS THE WHOLE POINT
 * ----------------------------------
 * Instances are addressed by a Durable Object id derived from the tenant id, so
 * repeated calls for one tenant land on one instance. That is what makes the
 * per-tenant connection LRU pay off. Route by load instead and every instance
 * opens its own connections to the same Neon compute — connection amplification
 * across the fleet — while most calls take a cold LRU miss, which lands directly
 * on the warm-p99 promise KTD2 exists to defend.
 *
 * The accepted cost, written down rather than discovered: one tenant's
 * throughput is bounded by one container instance. For a personal brain that is
 * the right trade; it would not be for a shared workspace.
 *
 * NOT YET SERVING TRAFFIC
 * -----------------------
 * `fetch` below resolves a tenant and proves the routing seam, then returns 501
 * rather than pretending to speak MCP. U6 replaces the placeholder with the real
 * surface. Returning 501 is deliberate: a stub that returned 200 would make an
 * unimplemented server look healthy to every uptime check pointed at it.
 */

import { Container } from '@cloudflare/containers';

/** Shared by both fleets — one image, two entrypoints (see Dockerfile). */
abstract class FleetContainer extends Container {
  override defaultPort = 8080;

  /**
   * How long an idle instance stays warm before scale-to-zero.
   *
   * This is a cost/latency trade, not a default worth inheriting silently. The
   * MCP fleet is interactive — a user is waiting on the wake — so it holds
   * longer. The worker fleet is batch; nobody is waiting, so it sheds sooner.
   * Both values are reasoned rather than measured; U13's two-week bake is the
   * revisit point, with observed cold-start frequency as the evidence.
   */
  abstract override sleepAfter: string;
}

export class McpFleet extends FleetContainer {
  override sleepAfter = '15m';
}

export class WorkerFleet extends FleetContainer {
  override sleepAfter = '5m';
}

/*
 * `Env` is NOT declared here. `wrangler types` generates it in
 * worker-configuration.d.ts directly from wrangler.toml, so the bindings a
 * handler sees are derived from the bindings the config actually declares. A
 * hand-written copy would compile happily after someone renames a binding in
 * the config and forgets to update it — the failure would land at runtime, on
 * the request path, as an undefined namespace. Regenerate with
 * `bunx wrangler types` after any wrangler.toml change.
 */

/**
 * Resolve the tenant this request belongs to.
 *
 * U6 owns the real resolution: the tenant comes from the authenticated bearer
 * grant, never from a request parameter. That direction matters more than the
 * placeholder — a tenant id taken from user-supplied input is a cross-tenant
 * routing bug, and it would be one that the connection LRU then caches.
 *
 * Until U6 lands there is no auth layer, so this returns null and the request
 * is refused rather than being routed somewhere arbitrary.
 */
function resolveTenant(_request: Request): string | null {
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const tenantId = resolveTenant(request);

    if (tenantId === null) {
      return Response.json(
        {
          error: 'not_implemented',
          detail:
            'The MCP surface lands in U6. This Worker currently proves the ' +
            'routing seam only: no bearer grant can be resolved yet, so no ' +
            'request can be attributed to a tenant, so nothing is routed.',
        },
        { status: 501 },
      );
    }

    // The affinity rule, in one line: the DO id is derived from the tenant id,
    // so the same tenant reaches the same instance and its warm connections.
    const id = env.MCP_FLEET.idFromName(tenantId);
    return env.MCP_FLEET.get(id).fetch(request);
  },
};
