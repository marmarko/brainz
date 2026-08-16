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

/**
 * ===========================================================================
 * WHAT REACHES A CONTAINER, AND WHAT MAY NOT
 * ===========================================================================
 *
 * `@cloudflare/containers` passes environment into a container through the
 * `envVars` property on the Container class, and through nothing else. Both
 * classes below set `defaultPort`, `sleepAfter` and (for the worker) an
 * `entrypoint`, and for a while set no `envVars` at all — so a deployed
 * container's `process.env` held nothing the fleet reads. `compose.ts` refused
 * on `BRAINZ_CONTROL_DATABASE_URL`, the platform restarted it, and the result
 * was a crash loop behind a Worker that had deployed green: healthy-looking
 * infrastructure serving nothing.
 *
 * **The manifests are written out by name rather than forwarded wholesale**, for
 * two independent reasons.
 *
 *   * `env` holds Durable Object namespace bindings, which are live stubs and
 *     not strings. `{ ...env }` is a type error and, worse, an attempt to hand a
 *     namespace across a process boundary.
 *   * A variable a fleet does not need is a variable a compromised container
 *     cannot leak. The MCP fleet parses attacker-supplied content; a blanket
 *     forward would put the identity database's DSN, the billing vendor's secret
 *     key and every unrelated credential the Worker happens to hold inside it.
 *
 * **Required-ness is NOT re-stated here.** `src/fleet/env.ts` refuses at process
 * start and names the missing variable in the container log, which is where an
 * operator is looking. A second check at this layer would answer a different
 * question ("was it set on the Worker") in a different place, and the two would
 * drift. What this layer owns is *which* variables travel; whether a given one
 * is mandatory is the process's own business.
 */

/**
 * Read by both entrypoints, through `src/fleet/compose.ts`.
 *
 * `BRAINZ_SECRETS_JSON` is the odd one out and deliberately so: `compose.ts`
 * requires `BRAINZ_SECRETS_FILE` and `secret-file.ts` reads a *file*, but a
 * secrets file baked into an image is a credential in a build artefact and a
 * path supplied by configuration is a way to point a fleet at one. So the
 * content travels as a secret and the image's bootstrap materialises it, choosing
 * the path itself — see the Dockerfile. `BRAINZ_SECRETS_FILE` is therefore
 * absent from both manifests on purpose.
 */
const SHARED_FLEET_VARIABLES: readonly string[] = [
  // compose.ts `openControlPlane` — and, in the worker, the second handle H4
  // requires for lease renewal.
  'BRAINZ_CONTROL_DATABASE_URL',
  // The secret store, as content rather than as a path.
  'BRAINZ_SECRETS_JSON',
  // compose.ts `openFleetGateway`: which routing profile, and the account whose
  // Unified Billing the Cloudflare seats go through. Both fleets call models —
  // the MCP fleet on the request path, the worker fleet inside a cycle.
  'BRAINZ_ROUTING_PROFILE',
  'BRAINZ_CF_ACCOUNT_ID',
  // compose.ts `hostedKeys`: the operator-supplied pool, per provider. Absent
  // entries stay absent; the key resolver answers `no_key_available` at call
  // time rather than this layer inventing a credential.
  'BRAINZ_HOSTED_KEY_OPENAI',
  'BRAINZ_HOSTED_KEY_GOOGLE',
  'BRAINZ_HOSTED_KEY_CLOUDFLARE',
  'BRAINZ_HOSTED_KEY_SELF_HOST',
];

/**
 * The MCP fleet's own, all four of them the public surface's business.
 *
 * `BRAINZ_PUBLIC_ORIGIN` is the issuer a connector binds to out of the discovery
 * documents; the two `OAUTH` variables are the dynamic-registration allowlist,
 * which is empty and therefore fail-closed when unset; `BRAINZ_WEB_APP_BASE_URL`
 * is where a consent screen sends a user. A batch process answers none of those
 * requests, so none of these travel to it.
 */
export const MCP_FLEET_VARIABLES: readonly string[] = [
  ...SHARED_FLEET_VARIABLES,
  'BRAINZ_PUBLIC_ORIGIN',
  'BRAINZ_OAUTH_REDIRECT_URIS',
  'BRAINZ_OAUTH_MAX_REGISTRATIONS_PER_HOUR',
  'BRAINZ_WEB_APP_BASE_URL',
];

/**
 * The worker fleet's own: how many jobs one instance runs at once, and how often
 * the loop ticks. Both are `src/worker/serve.ts`'s and meaningless to a process
 * that runs no scheduler.
 *
 * Not here, and each for a reason worth reading before adding it back:
 * `BRAINZ_IDENTITY_DATABASE_URL` and the Stripe credentials belong to
 * `src/web/serve.ts`, which is not one of the container classes this config
 * deploys; a Neon API key is read only by the provisioner's optional port, which
 * no fleet entrypoint supplies; R2 credentials are read by nothing in `src/` yet,
 * because `createTenantObjectStore` has no production credential minter. Each
 * joins a manifest when a fleet process actually reads it, and
 * `test/fleet/router-env.test.ts` asserts their absence until then.
 */
export const WORKER_FLEET_VARIABLES: readonly string[] = [
  ...SHARED_FLEET_VARIABLES,
  'BRAINZ_WORKER_CONCURRENCY',
  'BRAINZ_WORKER_TICK_MS',
];

/**
 * The named variables, and only those, as strings.
 *
 * Absent is skipped rather than forwarded as `''`: the container's environment
 * should say what the deployment says and no more, and `optional()` in
 * `env.ts` distinguishes the two for `BRAINZ_ROUTING_PROFILE`'s default.
 *
 * A non-string value is a refusal rather than a coercion. `MCP_FLEET` reads like
 * a variable name, and a manifest that named one would otherwise stringify a
 * Durable Object stub into a container's environment — a binding silently
 * degraded to `"[object Object]"`, which is exactly the class of failure this
 * file exists to stop shipping.
 *
 * The cast is the one seam where the Worker's `env` is treated as a bag of
 * strings, and it is here rather than at each call site. Secrets set with
 * `wrangler secret put` are not declared in `wrangler.toml`, so `wrangler types`
 * cannot know their names — and declaring them under `[vars]` to make it do so
 * would put configuration names *and values* into a file this public repository
 * commits. The type is recovered by the check below instead of by a declaration.
 */
export function selectContainerEnv(
  env: unknown,
  names: readonly string[],
): Record<string, string> {
  const source = env as Record<string, unknown>;
  const selected: Record<string, string> = {};
  for (const name of names) {
    const value = source[name];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      throw new TypeError(
        `${name} is a ${typeof value}, not a string, and may not be passed into a container; ` +
          'Durable Object namespaces and other bindings stay in the Worker',
      );
    }
    selected[name] = value;
  }
  return selected;
}

/** Shared by both fleets — one image, two entrypoints (see Dockerfile). */
abstract class FleetContainer extends Container {
  override defaultPort = 8080;

  /**
   * The container's environment, named variable by variable.
   *
   * Abstract, so a third fleet class cannot be added without deciding what it
   * receives. Inheriting a shared default here is how one fleet quietly acquires
   * the other's credentials.
   */
  abstract override envVars: Record<string, string>;

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

  /**
   * Read off `this.env` in a field initializer, which runs after the base
   * constructor has set it — so the instance carries the deployment's own
   * configuration rather than a copy captured at module scope, and a `wrangler
   * secret put` reaches the next instance to start without a code change.
   */
  override envVars = selectContainerEnv(this.env, MCP_FLEET_VARIABLES);
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

  /**
   * The bootstrap first, then the entrypoint. Cloudflare's `entrypoint` is the
   * container's whole command, not arguments appended to the image's — so this
   * has to name the bootstrap itself or the worker fleet would start with no
   * secret store while the MCP fleet, which inherits the image's `CMD`, started
   * with one. The Dockerfile's `CMD` and this literal are asserted to name the
   * same bootstrap by `test/fleet/image.test.ts`.
   */
  override entrypoint = ['/usr/local/bin/fleet-bootstrap', 'bun', 'run', 'src/worker/serve.ts'];

  override envVars = selectContainerEnv(this.env, WORKER_FLEET_VARIABLES);
}

/**
 * The instance every scheduled wake addresses.
 *
 * One name, so the cron wakes one worker instance rather than a new one per
 * invocation. The job lease ladder tolerates more than one runner — it is built
 * to — but paying for a second instance to contend for the same leases buys
 * nothing, and under tenant affinity a second scheduler is a second cold
 * connection LRU as well.
 */
export const WORKER_WAKE_INSTANCE = 'worker-singleton';

/**
 * Wake the worker fleet and confirm it answered.
 *
 * **The failure this closes.** `WORKER_FLEET` was bound in `wrangler.toml` and
 * addressed by nothing: the Worker's only handler routed to `MCP_FLEET`. A
 * container class nobody addresses never boots, so the deploy succeeded, the MCP
 * surface served, and no consolidation cycle ever ran — the same shape as an
 * unconfigured container, one layer up, and just as invisible.
 *
 * The wake is a request to the readiness route and nothing more. The scheduling
 * policy is `src/worker/serve.ts`'s own tick loop and `ALPHA_SCHEDULER`'s
 * debounce and ceiling; a cron that decided *which* tenants were due would be a
 * second scheduler disagreeing with the first.
 *
 * A refusal propagates rather than being swallowed: a failed cron invocation is
 * recorded and visible, and a handler that logged and returned would leave a
 * cron history full of successful wakes of a fleet that never woke.
 */
export async function wakeWorkerFleet(fleet: FleetBinding<unknown>): Promise<void> {
  const instance = fleet.get(fleet.idFromName(WORKER_WAKE_INSTANCE));
  // The path is what the container's readiness route answers; the host is
  // ignored, because a Durable Object `fetch` is an isolate-to-instance call and
  // never leaves through DNS. Loopback rather than a made-up name on purpose:
  // `src/register/completeness.ts` sweeps `src/` for every `http(s)://` host and
  // requires each one to be a named destination in the register, and this is
  // deliberately not a destination — loopback is the spelling that says so.
  const response = await instance.fetch(new Request('http://127.0.0.1/health'));
  if (!response.ok) {
    throw new Error(`the worker fleet answered its wake with ${response.status}`);
  }
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

  /**
   * The `[triggers]` cron in `wrangler.toml`, arriving here.
   *
   * Awaited rather than handed to `ctx.waitUntil`: the point of the invocation
   * is the wake, so the invocation should not be reported complete before the
   * instance has answered.
   */
  scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    return wakeWorkerFleet(env.WORKER_FLEET as unknown as FleetBinding<unknown>);
  },
};
