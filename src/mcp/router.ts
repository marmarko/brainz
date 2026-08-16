/**
 * The Worker entrypoint in front of both container fleets (U1 step 6, KTD2),
 * now carrying U6's auth layer and the edge limiter.
 *
 * Cloudflare Containers are reached *through* a Worker: a Durable Object routes
 * to instances, so the shape is Worker -> DO -> Container, not Worker-instead-of-
 * Container. This file is that Worker plus the two DO classes.
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
 * WHY THE REQUEST LOGIC IS NOT IN THIS FILE
 * -----------------------------------------
 * `@cloudflare/containers` imports `cloudflare:workers`, a runtime built-in that
 * exists only inside workerd — so nothing importing this module can be loaded by
 * a blocking test. The routing and admission logic therefore lives in
 * `edge.ts`, which imports no platform module and is exercised directly by
 * `test/mcp/router.test.ts`. What stays here is the deployment surface: the two
 * Container classes and the binding hand-off, which are exercised by deploying.
 *
 * THE TENANT COMES FROM THE CREDENTIAL, AND ONLY FROM THE CREDENTIAL
 * -----------------------------------------------------------------
 * U1 left `resolveTenant` returning `null` because no auth layer existed. It now
 * reads the tenant id **out of the presented token** (`edge.ts`), and the direction matters
 * more than the mechanism: a tenant id taken from a request parameter is a
 * cross-tenant routing bug, and it would be one the connection LRU then caches.
 * The id is a routing hint and nothing more — it is not authorisation, and the
 * signature that makes it one is checked inside the container, in `dispatch.ts`,
 * against a secret only the fleet identity for that tenant can resolve. A
 * request holding a forged token therefore reaches an instance and is refused
 * there; it never reaches a database.
 *
 * THE LIMITER RUNS BEFORE THE INSTANCE
 * ------------------------------------
 * `/mcp` is a public origin in front of scale-to-zero containers billed per 10ms.
 * A limiter consulted inside the instance has already paid for the instance, so
 * a flood is billed and then rejected — R14's caps meter model spend and nothing
 * else meters compute. Admission happens here, before the Durable Object is
 * addressed, and the concurrency slot is released in a `finally` so an instance
 * that falls over does not leak the tenant's ceiling.
 */

import { Container } from '@cloudflare/containers';

import { handleFleetRequest, type FleetBinding } from './edge.ts';
import { createEdgeLimiter, type EdgeLimiter } from './rate-limit.ts';

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

/**
 * The MCP fleet runs the image's own `CMD`, so it names no entrypoint — one
 * default in one place, rather than the same command written twice and drifting.
 */
export class McpFleet extends FleetContainer {
  override sleepAfter = '15m';
}

/**
 * The worker fleet is the same image with a different entrypoint, which is the
 * mechanism that makes "one image, two fleets" real rather than a packaging
 * claim. **Without this override the worker fleet would run the MCP server**:
 * every instance would serve an HTTP surface nobody routes to it, and no
 * consolidation cycle would ever run — a fleet that is up, healthy, and doing
 * none of its work. `test/fleet/image.test.ts` reads this literal and the
 * Dockerfile's `CMD` and refuses either naming a module that does not listen.
 */
export class WorkerFleet extends FleetContainer {
  override sleepAfter = '5m';
  override entrypoint = ['bun', 'run', 'src/worker/serve.ts'];
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
 * One limiter per isolate. The state is per-isolate rather than global, which is
 * a real weakening under a distributed flood and the accepted alpha shape: the
 * alternative is a Durable Object round-trip on every unauthenticated request,
 * which is itself the billed work the limiter exists to avoid.
 */
const limiter: EdgeLimiter = createEdgeLimiter({ now: () => Date.now() });

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleFleetRequest(request, {
      fleet: env.MCP_FLEET as unknown as FleetBinding<unknown>,
      limiter,
    });
  },
};
