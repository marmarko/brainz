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
 * THREE FLEETS, ONE ORIGIN, AND WHY THE WEB APP IS NOT SOMEWHERE ELSE
 * -------------------------------------------------------------------
 * A session cookie is scoped to an origin. The consent screen `/authorize`
 * renders reads the session the login page wrote, so the web app has to answer
 * on this origin or there is nothing for it to read — put it on a host of its
 * own and the cookie is simply not sent. `WebFleet` below is therefore a third
 * Container class on the same Worker, reached by path (`edge.ts`) rather than by
 * tenant, because the surface that matters most (`/signup`) runs before any
 * tenant exists.
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
 * **The secret store travels as a substrate, not as content.** It used to be
 * `BRAINZ_SECRETS_JSON` alone: a snapshot of every tenant's connection string
 * and bearer, materialised into each container's own temporary file at start.
 * That is why a signup served by the web fleet was invisible to the MCP fleet —
 * there is no shared volume, so the writer's copy was the only copy and it died
 * with the instance. The store is now the control-plane database both fleets
 * already hold, and what travels is the key that opens it
 * (`BRAINZ_SECRET_ENCRYPTION_KEY`) plus the choice of backend.
 *
 * `BRAINZ_SECRETS_JSON` stays on the manifests as a **bootstrap seed** — the
 * tenants that only ever existed inside it are imported once, by the first fleet
 * that starts, and it can never overwrite a durable entry. Once
 * `control.secret_seed` carries the blob's digest the secret can be deleted from
 * the Worker and nothing changes. `BRAINZ_SECRETS_FILE` is still absent from
 * every manifest on purpose: a path supplied by configuration is a way to point
 * a fleet at a file baked into the image, so the image's bootstrap chooses it.
 */
const SHARED_FLEET_VARIABLES: readonly string[] = [
  // compose.ts `openControlPlane` — and, in the worker, the second handle H4
  // requires for lease renewal. Also the durable secret store's substrate.
  'BRAINZ_CONTROL_DATABASE_URL',
  // Which secret backend this deployment runs. Absent means `postgres`, which
  // is the durable one; `file` is the self-hoster's, and must be asked for.
  'BRAINZ_SECRET_BACKEND',
  // What opens the sealed rows. Never written to the database it opens — that
  // separation is the whole of what encryption at rest buys here.
  'BRAINZ_SECRET_ENCRYPTION_KEY',
  // The bootstrap seed, imported once. Not the store any more.
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
 * The MCP fleet's own — the public surface's business, plus the one credential
 * that is here against the grain of everything above.
 *
 * `BRAINZ_PUBLIC_ORIGIN` is the issuer a connector binds to out of the discovery
 * documents; the two `OAUTH` variables are the dynamic-registration allowlist,
 * which is empty and therefore fail-closed when unset; `BRAINZ_WEB_APP_BASE_URL`
 * is where a consent screen sends a user. A batch process answers none of those
 * requests, so none of these travel to it.
 *
 * **`BRAINZ_IDENTITY_DATABASE_URL` is a deliberate widening, and the argument it
 * overrode is the one written at the top of this file.** That argument — the
 * process parsing attacker-supplied content must not hold the credential store
 * of every account — is still true, and the cost of this line is exactly what it
 * says: a compromise of an MCP instance now reaches accounts, password digests
 * and sessions, which it previously could not.
 *
 * What overrode it is a routing fact rather than a preference. `edge.ts`
 * classifies `/authorize` as a `flow` path and sends it to `McpFleet`, because
 * the authorization store its three hops share lives on one instance there. So
 * `src/mcp/serve.ts:sessionResourceOwners` — the function that turns the web
 * app's session cookie into a resource owner — runs in THIS process. Withhold
 * the DSN and it is never constructed, `deps.resourceOwners` is `undefined`, and
 * the browser leg of `/authorize` answers `401`: the connector's first hop, so
 * no browser can complete a connect flow at all. A consent screen that is
 * deployed and cannot read a session is not a narrower attack surface; it is a
 * feature that does not exist.
 *
 * **The narrower design is real and is not this one.** Move the consent surface
 * to the web fleet and have the two fleets exchange a signed assertion over the
 * shared secret store, and this line comes back out. That needs a new web path
 * and an `edge.ts` entry, which is a build rather than a manifest edit; it is
 * written up beside the code that would consume it, in `serve.ts`.
 *
 * **The widening is one variable wide.** Billing, the substrate's key and the
 * operator credential stay on {@link WEB_FLEET_VARIABLES} alone, and
 * `test/fleet/router-env.test.ts` asserts that in both directions so this does
 * not decay into a merged manifest.
 */
export const MCP_FLEET_VARIABLES: readonly string[] = [
  ...SHARED_FLEET_VARIABLES,
  'BRAINZ_PUBLIC_ORIGIN',
  'BRAINZ_OAUTH_REDIRECT_URIS',
  'BRAINZ_OAUTH_MAX_REGISTRATIONS_PER_HOUR',
  'BRAINZ_WEB_APP_BASE_URL',
  // Read the paragraph above before deleting this line — and before copying it
  // onto another manifest.
  'BRAINZ_IDENTITY_DATABASE_URL',
];

/**
 * The worker fleet's own: how many jobs one instance runs at once, and how often
 * the loop ticks. Both are `src/worker/serve.ts`'s and meaningless to a process
 * that runs no scheduler.
 *
 * **And the connector vendor's four, which are on TWO manifests and are the one
 * duplication here that is deliberate.** The web fleet mints connect links; this
 * fleet reconciles authorizations on its tick and polls the connections that
 * result, and both halves talk to the same vendor project. Withholding them here
 * is what the connector lane looked like before it worked: `enqueueDuePulls`
 * composed no runtime, so an attached mailbox was never polled by anyone. The
 * cost is that a compromise of this fleet reaches the vendor credential as well
 * as the web fleet's — accepted, because the alternative is a batch fleet that
 * cannot do the batch work.
 *
 * Not here, and each for a reason worth reading before adding it back: the
 * Stripe credentials belong to `src/web/serve.ts` and travel on
 * {@link WEB_FLEET_VARIABLES} alone; a Neon API key is read by the provisioner,
 * which likewise only the web process composes; R2 credentials are read by
 * nothing in `src/` yet, because `createTenantObjectStore` has no production
 * credential minter.
 *
 * `BRAINZ_IDENTITY_DATABASE_URL` is absent for a different reason than it used
 * to be, and the difference matters. It is no longer "the web fleet's alone" —
 * {@link MCP_FLEET_VARIABLES} now carries it, because `/authorize` is routed
 * there. It is absent *here* because this process serves no browser: it answers
 * no request that could present a session cookie, so a session store on this
 * manifest would be a credential it holds and cannot use.
 *
 * Each joins a manifest when the process that reads it is deployed, and
 * `test/fleet/router-env.test.ts` asserts the absences in both directions.
 */
export const WORKER_FLEET_VARIABLES: readonly string[] = [
  ...SHARED_FLEET_VARIABLES,
  'BRAINZ_WORKER_CONCURRENCY',
  // The retention lane's switch. Absent reads as off in `purgeEnqueueEnabled`,
  // which is the whole point: a hard-delete lane must not arrive switched on
  // because a container was rebuilt.
  'BRAINZ_PURGE_ENABLED',
  'BRAINZ_WORKER_TICK_MS',
  // `compose.ts:openConnectorClient` — the connector lane's vendor. Read the
  // paragraph above before deleting these four.
  'BRAINZ_PIPEDREAM_PROJECT_ID',
  'BRAINZ_PIPEDREAM_CLIENT_ID',
  'BRAINZ_PIPEDREAM_CLIENT_SECRET',
  'BRAINZ_PIPEDREAM_ENVIRONMENT',
  'BRAINZ_PIPEDREAM_API_BASE',
];

/**
 * The web fleet's own — `src/web/serve.ts` and nothing else reads any of these.
 *
 * **Written flat rather than spread over {@link SHARED_FLEET_VARIABLES}**, which
 * is not tidiness. That bundle exists for the two fleets that call models: it
 * carries the routing profile, the billing account and the hosted key pool, and
 * the web app composes no gateway at all. Spreading it here to save two lines
 * would put every model credential inside the process that serves a public
 * signup form — the widest surface in the deployment — in exchange for nothing
 * it can use. The two variables the three fleets genuinely share are named
 * individually below, with the reason each is needed.
 *
 * **The billing secrets, the substrate's key and the operator credential live
 * here and nowhere else.** The MCP fleet parses attacker-supplied content, so a
 * credential it cannot use is a credential a compromise cannot leak — and it can
 * use none of these: it takes no payment, provisions no project and serves no
 * operator route.
 *
 * **The identity database is no longer in that sentence, and it is the one
 * exception worth naming here rather than only where it was added.** It travels
 * to {@link MCP_FLEET_VARIABLES} as well, because `edge.ts` routes `/authorize`
 * to the MCP fleet and the consent screen there has to resolve the session this
 * app's login page wrote. Two processes now hold the session store. The reasons,
 * the cost and the narrower design that would take it back out are written
 * against the manifest that gained it.
 */
export const WEB_FLEET_VARIABLES: readonly string[] = [
  // Shared with the other two fleets, and only these two.
  //
  // `compose.ts:openControlPlane` — accounts, tiers, spend counters, the
  // provisioner's own bookkeeping, and the durable secret store's substrate.
  'BRAINZ_CONTROL_DATABASE_URL',
  // The web process is the secret store's WRITER: provisioning banks a new
  // tenant's connection string and bearer through it. Which backend, and the
  // key that seals what it writes. A web fleet on the `postgres` backend and an
  // MCP fleet on `file` — or on a different key — is a signup the connector
  // fleet cannot serve, which is why both variables travel to all three.
  'BRAINZ_SECRET_BACKEND',
  'BRAINZ_SECRET_ENCRYPTION_KEY',
  // The bootstrap seed (see {@link SHARED_FLEET_VARIABLES}). Imported once,
  // never authoritative, deletable once it has been.
  'BRAINZ_SECRETS_JSON',

  // `compose.ts:openIdentityStore` — accounts, password digests, sessions. The
  // one database the fleets deliberately cannot reach.
  'BRAINZ_IDENTITY_DATABASE_URL',

  // The app's own origin. It is the same-origin refusal's reference value, so a
  // wrong one is a CSRF check comparing against a host nobody uses.
  'BRAINZ_WEB_ORIGIN',
  // What `/connect` hands the user to paste into their client. Not the issuer:
  // that is `BRAINZ_PUBLIC_ORIGIN`, which is the MCP fleet's.
  'BRAINZ_MCP_URL',

  // The billing webhook's signature secret. Required by the process: a webhook
  // route that cannot verify is a route that accepts, so it fails closed at
  // start rather than at the first forged delivery.
  'BRAINZ_STRIPE_WEBHOOK_SECRET',
  // The checkout trio — all three or none, refused at start if partial, because
  // a half-configured vendor is a checkout that reaches the network with an
  // empty credential and reports the refusal as a vendor outage.
  'BRAINZ_STRIPE_API_BASE',
  'BRAINZ_STRIPE_SECRET_KEY',
  'BRAINZ_STRIPE_PRICE_ID',

  // The substrate a signup provisions onto. Without a key AND without a warm
  // pool the process refuses to start, because every signup it could serve would
  // answer 503 — see `neonSubstrate`. The rest are the knobs that decide where
  // the project lands, on whose organisation it bills, and whether this
  // account's plan lets the suspend interval be set at all.
  'BRAINZ_NEON_API_KEY',
  'BRAINZ_NEON_ORG_ID',
  'BRAINZ_NEON_API_BASE',
  'BRAINZ_NEON_REGION_ID',
  'BRAINZ_NEON_PG_VERSION',
  'BRAINZ_NEON_SUSPEND_TIMEOUT',
  'BRAINZ_POOL_TARGET',
  'BRAINZ_TENANT_ID_PREFIX',

  // The connector vendor's project and OAuth client. All four or none, refused
  // at start if partial (`web/serve.ts:connectorVendor`); none at all is a
  // legitimate deployment whose connector routes answer `501 unavailable`.
  //
  // **They travel to this fleet and to no other, and the reason is the same one
  // the Stripe key gets.** The MCP fleet parses attacker-supplied content, and
  // this credential mints capabilities that attach a stranger's mailbox to a
  // brain — the widest blast radius of anything on these manifests after the
  // identity store. The *worker* fleet is the interesting absence: it is the
  // fleet that would poll a connected account, and it is denied the credential
  // deliberately, because the cursor a poll needs lives in a tenant's object
  // prefix and `src/` has no production `ScopedCredentialMinter` to reach one
  // with. A credential a process cannot use is a credential a compromise can
  // leak, so it joins that manifest on the day the pull can run, and
  // `test/fleet/router-env.test.ts` asserts the absence in both directions
  // until then.
  'BRAINZ_PIPEDREAM_PROJECT_ID',
  'BRAINZ_PIPEDREAM_CLIENT_ID',
  'BRAINZ_PIPEDREAM_CLIENT_SECRET',
  'BRAINZ_PIPEDREAM_ENVIRONMENT',
  // Consumed, never published, and carrying a version path — an API base rather
  // than an origin, exactly like Stripe's and Neon's. Optional: absent takes the
  // vendor's own, and setting it is how a test points the process at a double.
  'BRAINZ_PIPEDREAM_API_BASE',

  // The operator surface's credential. Unset means `/admin` answers 404 — an
  // admin surface whose credential is unset is one open to everybody, and the
  // fail-closed direction is to not exist.
  'BRAINZ_ADMIN_CREDENTIAL',
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
 * The web app — signup, login, dashboard, billing, BYOK, erasure — as the third
 * fleet on this origin.
 *
 * **The failure this closes.** `src/web/serve.ts` was a complete process that no
 * deployment started: no Container class, no route, no manifest. U15's
 * verification sentence is *"a stranger can sign up"* and there was nowhere for
 * a stranger to do it. The consent screen the OAuth flow needs is the second
 * half of the same gap: `/authorize` reads a session cookie, a cookie is scoped
 * to an origin, so a web app hosted anywhere else can be perfectly healthy and
 * still leave `/authorize` with nothing to read.
 *
 * **Same image, third entrypoint.** One dependency closure, one set of base
 * layers, one bootstrap materialising the secret store — and a `sleepAfter` that
 * matches the MCP fleet's rather than inventing a third number: both are
 * interactive surfaces where the wake cost is paid by a person waiting on a
 * page, which is the only property that value encodes.
 */
export class WebFleet extends FleetContainer {
  override sleepAfter = '15m';

  /** The bootstrap first, then the entrypoint — see {@link WorkerFleet}. */
  override entrypoint = ['/usr/local/bin/fleet-bootstrap', 'bun', 'run', 'src/web/serve.ts'];

  override envVars = selectContainerEnv(this.env, WEB_FLEET_VARIABLES);
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
      mcp: env.MCP_FLEET as unknown as FleetBinding<unknown>,
      web: env.WEB_FLEET as unknown as FleetBinding<unknown>,
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
