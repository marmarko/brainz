/**
 * The two Container classes are handed their configuration, and only theirs.
 *
 * **The failure this refuses.** `McpFleet` and `WorkerFleet` set `defaultPort`,
 * `sleepAfter` and (for the worker) `entrypoint`, and set no `envVars`.
 * `@cloudflare/containers` passes environment into a container through exactly
 * that property, so the deployed container's `process.env` held nothing:
 * `compose.ts` refused on `BRAINZ_CONTROL_DATABASE_URL`, the platform restarted
 * it, and the fleet was a crash loop behind a Worker that deployed green. A
 * test asserting "envVars is set" would have passed the moment somebody wrote
 * `envVars = {}`, which is the state that shipped — so what is asserted here is
 * the **exact set**, in both directions: every variable the process reads is
 * present, and nothing else is.
 *
 * **Why the classes are constructed rather than read as text.**
 * `src/mcp/router.ts` imports `@cloudflare/containers`, which imports
 * `cloudflare:workers` — a workerd built-in Bun cannot resolve, which is why
 * `image.test.ts` parses that file as a string. `mock.module` supplies the
 * built-in, so the classes can be instantiated against a fake Durable Object
 * context and their `envVars` read the way the platform reads it. That is
 * strictly stronger than a regex: a class field that is declared and never
 * assigned, or assigned before `this.env` exists, is invisible to text and
 * fatal here.
 *
 * The mock is process-wide once registered, so it lives in this file alone and
 * nothing else in the suite imports `cloudflare:workers`.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';

import { REPO_ROOT } from './fixture.ts';

interface RouterModule {
  readonly McpFleet: new (ctx: unknown, env: unknown) => { envVars: Record<string, string> };
  readonly WorkerFleet: new (ctx: unknown, env: unknown) => { envVars: Record<string, string> };
  readonly WebFleet: new (ctx: unknown, env: unknown) => { envVars: Record<string, string> };
  readonly MCP_FLEET_VARIABLES: readonly string[];
  readonly WORKER_FLEET_VARIABLES: readonly string[];
  readonly WEB_FLEET_VARIABLES: readonly string[];
  readonly WORKER_WAKE_INSTANCE: string;
  selectContainerEnv(env: unknown, names: readonly string[]): Record<string, string>;
  wakeWorkerFleet(fleet: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  }): Promise<void>;
  readonly default: {
    fetch(request: Request, env: unknown): Promise<Response>;
    scheduled(
      controller: unknown,
      env: unknown,
      ctx: { waitUntil(promise: Promise<unknown>): void },
    ): Promise<void>;
  };
}

let router: RouterModule;

/**
 * Enough Durable Object context to get through `Container`'s constructor.
 *
 * Deliberately minimal and deliberately not a mock of the platform: what is
 * under test is a class field, and everything below exists only because the
 * base constructor touches it on the way to setting one.
 */
function fakeDurableObjectContext(): unknown {
  const storage = {
    sql: { exec: () => [] },
    kv: { get: () => undefined, put: () => undefined, delete: () => undefined },
    setAlarm: () => undefined,
    getAlarm: () => null,
    sync: async () => undefined,
    transactionSync: (work: () => unknown) => work(),
  };
  return {
    container: { running: false, monitor: () => ({}) },
    storage,
    blockConcurrencyWhile: (work: () => unknown) => {
      void work();
    },
  };
}

/**
 * A Worker `env` shaped like a real one: two Durable Object namespace bindings,
 * every variable either fleet reads, and several a fleet must never receive.
 *
 * The last group is the point of the fixture. The Stripe credentials and the
 * substrate's key belong to the web process alone; `R2_SECRET_ACCESS_KEY` and
 * `NEON_API_KEY` are read by nothing in any fleet. A blanket forward of `env`
 * puts all of them inside a container that parses attacker-supplied content,
 * which is the mutation this fixture exists to kill.
 *
 * `BRAINZ_IDENTITY_DATABASE_URL` is the one that moved, and it is not in that
 * group any more: `/authorize` is routed to the MCP fleet (`edge.ts`), so the
 * process that renders consent has to resolve the browser's session there. It
 * therefore reaches two fleets and is asserted absent from the third.
 */
const DO_BINDING = { idFromName: () => ({}), get: () => ({ fetch: async () => new Response() }) };

const WORKER_ENV = {
  MCP_FLEET: DO_BINDING,
  WORKER_FLEET: DO_BINDING,
  WEB_FLEET: DO_BINDING,

  BRAINZ_CONTROL_DATABASE_URL: 'postgres://fake@127.0.0.1:1/control',
  // The secret store's substrate choice and its key. Both must reach all three
  // fleets: a web fleet writing sealed rows to the control plane while an MCP
  // fleet reads a per-container file — or reads with a different key — is a
  // signup the connector fleet cannot serve, which is the failure the durable
  // store exists to end.
  BRAINZ_SECRET_BACKEND: 'postgres',
  BRAINZ_SECRET_ENCRYPTION_KEY: 'A'.repeat(43),
  // Set in the fixture on purpose, and set to the value that would do damage.
  // It must reach NO container — see the test below. A variable that is merely
  // absent from the fixture would prove nothing, because `selectContainerEnv`
  // copies only what the deployment actually set: a manifest could gain this
  // name and every assertion here would stay green.
  BRAINZ_AUTHORIZATION_BACKEND: 'memory',
  // No longer the store. A bootstrap seed, imported once, deletable afterwards.
  BRAINZ_SECRETS_JSON: '{"secrets":{},"providerKeys":{}}',
  BRAINZ_ROUTING_PROFILE: 'hosted',
  BRAINZ_CF_ACCOUNT_ID: '0'.repeat(32),
  BRAINZ_HOSTED_KEY_CLOUDFLARE: 'not-a-real-key-cloudflare',
  BRAINZ_HOSTED_KEY_OPENAI: 'not-a-real-key-openai',

  BRAINZ_PUBLIC_ORIGIN: 'https://mcp.brainz.test',
  BRAINZ_OAUTH_REDIRECT_URIS: 'https://claude.ai/api/mcp/auth_callback',
  BRAINZ_OAUTH_MAX_REGISTRATIONS_PER_HOUR: '5',
  BRAINZ_WEB_APP_BASE_URL: 'https://app.brainz.test',

  BRAINZ_WORKER_CONCURRENCY: '4',
  BRAINZ_WORKER_TICK_MS: '60000',

  // The web process's own, every one of them. They are the sharpest half of this
  // fixture: identity and billing credentials now travel to a container, so
  // "nothing extra reaches a fleet" has to be asserted against a `WebFleet` that
  // legitimately receives them and an `McpFleet` that must not.
  BRAINZ_IDENTITY_DATABASE_URL: 'postgres://fake@127.0.0.1:1/identity',
  BRAINZ_WEB_ORIGIN: 'https://app.brainz.test',
  BRAINZ_MCP_URL: 'https://mcp.brainz.test/mcp',
  BRAINZ_STRIPE_WEBHOOK_SECRET: 'whsec_this_test_invented_it',
  BRAINZ_STRIPE_API_BASE: 'https://stripe.brainz.test/v1',
  BRAINZ_STRIPE_SECRET_KEY: 'sk_test_this_test_invented_it',
  BRAINZ_STRIPE_PRICE_ID: 'price_this_test_invented_it',
  BRAINZ_NEON_API_KEY: 'not-a-real-neon-key',
  BRAINZ_NEON_ORG_ID: 'org-this-test-invented',
  BRAINZ_NEON_API_BASE: 'https://neon.brainz.test/api/v2',
  BRAINZ_NEON_REGION_ID: 'aws-nowhere-1',
  BRAINZ_NEON_PG_VERSION: '17',
  BRAINZ_NEON_SUSPEND_TIMEOUT: 'vendor-default',
  BRAINZ_POOL_TARGET: '0',
  BRAINZ_TENANT_ID_PREFIX: 'canary',
  BRAINZ_ADMIN_CREDENTIAL: 'not-a-real-admin-credential',
  // The connector vendor's four, plus the base a test points at a double.
  // Obvious fakes: this repository is public and gitleaks runs on every push.
  BRAINZ_PIPEDREAM_PROJECT_ID: 'proj_this_test_invented_it',
  BRAINZ_PIPEDREAM_CLIENT_ID: 'not-a-real-pipedream-client-id',
  BRAINZ_PIPEDREAM_CLIENT_SECRET: 'not-a-real-pipedream-client-secret',
  BRAINZ_PIPEDREAM_ENVIRONMENT: 'development',
  BRAINZ_PIPEDREAM_API_BASE: 'https://pipedream.brainz.test/v1',

  // Read by no fleet process at all. Present here because a forward of the whole
  // `env` would carry them, and that has to fail.
  NEON_API_KEY: 'not-a-real-neon-key',
  R2_SECRET_ACCESS_KEY: 'not-a-real-r2-secret',
  // The image owns this path (see the Dockerfile's bootstrap); a fleet that
  // received it could be pointed at a file baked into a build artefact.
  BRAINZ_SECRETS_FILE: '/app/secrets.json',
};

beforeAll(async () => {
  mock.module('cloudflare:workers', () => ({
    DurableObject: class {
      readonly ctx: unknown;
      readonly env: unknown;
      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    },
    WorkerEntrypoint: class {},
  }));
  router = (await import(`${REPO_ROOT}/src/mcp/router.ts`)) as unknown as RouterModule;
});

afterAll(() => {
  mock.restore();
});

type FleetName = 'McpFleet' | 'WorkerFleet' | 'WebFleet';

/** Every class this config deploys, so a loop over "the fleets" cannot omit one. */
const FLEETS: readonly FleetName[] = ['McpFleet', 'WorkerFleet', 'WebFleet'];

function envVarsOf(fleet: FleetName): Record<string, string> {
  const Class = router[fleet];
  return new Class(fakeDurableObjectContext(), WORKER_ENV).envVars;
}

describe('each fleet receives the configuration its own process reads', () => {
  test('the MCP fleet gets exactly what src/mcp/serve.ts and compose.ts read', () => {
    expect(envVarsOf('McpFleet')).toEqual({
      // compose.ts: openControlPlane, openFleetGateway.
      BRAINZ_CONTROL_DATABASE_URL: WORKER_ENV.BRAINZ_CONTROL_DATABASE_URL,
      BRAINZ_ROUTING_PROFILE: WORKER_ENV.BRAINZ_ROUTING_PROFILE,
      BRAINZ_CF_ACCOUNT_ID: WORKER_ENV.BRAINZ_CF_ACCOUNT_ID,
      BRAINZ_HOSTED_KEY_CLOUDFLARE: WORKER_ENV.BRAINZ_HOSTED_KEY_CLOUDFLARE,
      BRAINZ_HOSTED_KEY_OPENAI: WORKER_ENV.BRAINZ_HOSTED_KEY_OPENAI,
      // The durable secret store: which backend, the key that opens it, and the
      // blob that seeds it once. The image's bootstrap materialises the seed and
      // chooses the path itself.
      BRAINZ_SECRET_BACKEND: WORKER_ENV.BRAINZ_SECRET_BACKEND,
      BRAINZ_SECRET_ENCRYPTION_KEY: WORKER_ENV.BRAINZ_SECRET_ENCRYPTION_KEY,
      BRAINZ_SECRETS_JSON: WORKER_ENV.BRAINZ_SECRETS_JSON,
      // serve.ts: the OAuth issuer and the registration allowlist.
      BRAINZ_PUBLIC_ORIGIN: WORKER_ENV.BRAINZ_PUBLIC_ORIGIN,
      BRAINZ_OAUTH_REDIRECT_URIS: WORKER_ENV.BRAINZ_OAUTH_REDIRECT_URIS,
      BRAINZ_OAUTH_MAX_REGISTRATIONS_PER_HOUR:
        WORKER_ENV.BRAINZ_OAUTH_MAX_REGISTRATIONS_PER_HOUR,
      BRAINZ_WEB_APP_BASE_URL: WORKER_ENV.BRAINZ_WEB_APP_BASE_URL,
      // serve.ts: `sessionResourceOwners`, the browser half of `/authorize`.
      // This endpoint is routed HERE, not to the web fleet, so the session the
      // login page wrote is resolved by this process or by nothing.
      BRAINZ_IDENTITY_DATABASE_URL: WORKER_ENV.BRAINZ_IDENTITY_DATABASE_URL,
    });
  });

  test('the worker fleet gets the batch half, and none of the MCP surface', () => {
    expect(envVarsOf('WorkerFleet')).toEqual({
      BRAINZ_CONTROL_DATABASE_URL: WORKER_ENV.BRAINZ_CONTROL_DATABASE_URL,
      BRAINZ_ROUTING_PROFILE: WORKER_ENV.BRAINZ_ROUTING_PROFILE,
      BRAINZ_CF_ACCOUNT_ID: WORKER_ENV.BRAINZ_CF_ACCOUNT_ID,
      BRAINZ_HOSTED_KEY_CLOUDFLARE: WORKER_ENV.BRAINZ_HOSTED_KEY_CLOUDFLARE,
      BRAINZ_HOSTED_KEY_OPENAI: WORKER_ENV.BRAINZ_HOSTED_KEY_OPENAI,
      BRAINZ_SECRET_BACKEND: WORKER_ENV.BRAINZ_SECRET_BACKEND,
      BRAINZ_SECRET_ENCRYPTION_KEY: WORKER_ENV.BRAINZ_SECRET_ENCRYPTION_KEY,
      BRAINZ_SECRETS_JSON: WORKER_ENV.BRAINZ_SECRETS_JSON,
      BRAINZ_WORKER_CONCURRENCY: WORKER_ENV.BRAINZ_WORKER_CONCURRENCY,
      BRAINZ_WORKER_TICK_MS: WORKER_ENV.BRAINZ_WORKER_TICK_MS,
      // The connector lane. See the test below for why these are here now and
      // were deliberately absent before.
      BRAINZ_PIPEDREAM_PROJECT_ID: WORKER_ENV.BRAINZ_PIPEDREAM_PROJECT_ID,
      BRAINZ_PIPEDREAM_CLIENT_ID: WORKER_ENV.BRAINZ_PIPEDREAM_CLIENT_ID,
      BRAINZ_PIPEDREAM_CLIENT_SECRET: WORKER_ENV.BRAINZ_PIPEDREAM_CLIENT_SECRET,
      BRAINZ_PIPEDREAM_ENVIRONMENT: WORKER_ENV.BRAINZ_PIPEDREAM_ENVIRONMENT,
      BRAINZ_PIPEDREAM_API_BASE: WORKER_ENV.BRAINZ_PIPEDREAM_API_BASE,
    });
  });

  /**
   * The web app, whose manifest is the one that carries credentials the other
   * two are deliberately denied. The exact set matters more here than anywhere:
   * this is the process a stranger reaches at `/signup`, and it is the only one
   * holding the identity database and the billing vendor's key.
   */
  test('the web fleet gets what src/web/serve.ts reads, and no model credential', () => {
    expect(envVarsOf('WebFleet')).toEqual({
      // Shared with the other two, and the only two that are.
      BRAINZ_CONTROL_DATABASE_URL: WORKER_ENV.BRAINZ_CONTROL_DATABASE_URL,
      BRAINZ_SECRET_BACKEND: WORKER_ENV.BRAINZ_SECRET_BACKEND,
      BRAINZ_SECRET_ENCRYPTION_KEY: WORKER_ENV.BRAINZ_SECRET_ENCRYPTION_KEY,
      BRAINZ_SECRETS_JSON: WORKER_ENV.BRAINZ_SECRETS_JSON,
      // Its own.
      BRAINZ_IDENTITY_DATABASE_URL: WORKER_ENV.BRAINZ_IDENTITY_DATABASE_URL,
      BRAINZ_WEB_ORIGIN: WORKER_ENV.BRAINZ_WEB_ORIGIN,
      BRAINZ_MCP_URL: WORKER_ENV.BRAINZ_MCP_URL,
      BRAINZ_STRIPE_WEBHOOK_SECRET: WORKER_ENV.BRAINZ_STRIPE_WEBHOOK_SECRET,
      BRAINZ_STRIPE_API_BASE: WORKER_ENV.BRAINZ_STRIPE_API_BASE,
      BRAINZ_STRIPE_SECRET_KEY: WORKER_ENV.BRAINZ_STRIPE_SECRET_KEY,
      BRAINZ_STRIPE_PRICE_ID: WORKER_ENV.BRAINZ_STRIPE_PRICE_ID,
      BRAINZ_NEON_API_KEY: WORKER_ENV.BRAINZ_NEON_API_KEY,
      BRAINZ_NEON_ORG_ID: WORKER_ENV.BRAINZ_NEON_ORG_ID,
      BRAINZ_NEON_API_BASE: WORKER_ENV.BRAINZ_NEON_API_BASE,
      BRAINZ_NEON_REGION_ID: WORKER_ENV.BRAINZ_NEON_REGION_ID,
      BRAINZ_NEON_PG_VERSION: WORKER_ENV.BRAINZ_NEON_PG_VERSION,
      BRAINZ_NEON_SUSPEND_TIMEOUT: WORKER_ENV.BRAINZ_NEON_SUSPEND_TIMEOUT,
      BRAINZ_POOL_TARGET: WORKER_ENV.BRAINZ_POOL_TARGET,
      BRAINZ_TENANT_ID_PREFIX: WORKER_ENV.BRAINZ_TENANT_ID_PREFIX,
      BRAINZ_ADMIN_CREDENTIAL: WORKER_ENV.BRAINZ_ADMIN_CREDENTIAL,
      BRAINZ_PIPEDREAM_PROJECT_ID: WORKER_ENV.BRAINZ_PIPEDREAM_PROJECT_ID,
      BRAINZ_PIPEDREAM_CLIENT_ID: WORKER_ENV.BRAINZ_PIPEDREAM_CLIENT_ID,
      BRAINZ_PIPEDREAM_CLIENT_SECRET: WORKER_ENV.BRAINZ_PIPEDREAM_CLIENT_SECRET,
      BRAINZ_PIPEDREAM_ENVIRONMENT: WORKER_ENV.BRAINZ_PIPEDREAM_ENVIRONMENT,
      BRAINZ_PIPEDREAM_API_BASE: WORKER_ENV.BRAINZ_PIPEDREAM_API_BASE,
    });
  });

  /**
   * **The connector credential reaches the two fleets that talk to the vendor,
   * and not the one that does not.**
   *
   * This test used to assert the web fleet alone, and gave the reason: the
   * worker *could not poll*, because a pull resumes from a cursor that
   * `src/ingest/cursor.ts` placed in the tenant's object prefix, reaching one
   * needs a `ScopedCredentialMinter`, and `src/` has no production
   * implementation of that port. It then said: *when the pull can run, the four
   * variables join `WORKER_FLEET_VARIABLES` and this test changes with them.
   * That is the point of asserting it rather than leaving it to the `toEqual`
   * above: the change becomes a decision.* This is that change, and this comment
   * is the decision.
   *
   * The pull can run: connector state lives in the control plane, sealed
   * (`src/control/connector-store.sql`), which every fleet already holds a
   * handle to. So the worker fleet composes a real `ConnectorRuntime` and a real
   * reconciler, and both need the vendor client. Withholding the credential now
   * would mean a batch fleet that cannot do the batch work — which is exactly
   * the state the connector lane spent a unit in.
   *
   * **The MCP fleet stays out, and that absence is now the whole of what this
   * test defends.** It is the process that parses attacker-supplied content; it
   * mints no connect link, reconciles nothing and polls nothing, so a vendor
   * credential there would be authority it cannot exercise sitting in the widest
   * surface in the deployment.
   */
  test('the connector credential reaches the vendor-facing fleets, and never the MCP one', () => {
    const web = envVarsOf('WebFleet');
    const worker = envVarsOf('WorkerFleet');
    for (const name of [
      'BRAINZ_PIPEDREAM_PROJECT_ID',
      'BRAINZ_PIPEDREAM_CLIENT_ID',
      'BRAINZ_PIPEDREAM_CLIENT_SECRET',
      'BRAINZ_PIPEDREAM_ENVIRONMENT',
      'BRAINZ_PIPEDREAM_API_BASE',
    ] as const) {
      expect({ name, value: web[name] }).toEqual({ name, value: WORKER_ENV[name] });
      // Both fleets, or the lane is broken in one direction with nothing saying
      // so: a web fleet without it mints no link, a worker without it never
      // notices the authorization and never polls.
      expect({ name, value: worker[name] }).toEqual({ name, value: WORKER_ENV[name] });
      expect({ name, value: envVarsOf('McpFleet')[name] }).toEqual({ name, value: undefined });
    }
  });

  /**
   * The asymmetries, named rather than left to the `toEqual`s above. A future
   * edit that merged the manifests would keep those passing only by accident;
   * these say which direction each variable travels and why.
   */
  test('the OAuth issuer reaches the fleet that mints issuers, and no other', () => {
    expect(envVarsOf('McpFleet')['BRAINZ_PUBLIC_ORIGIN']).toBe(WORKER_ENV.BRAINZ_PUBLIC_ORIGIN);
    // A batch process that never answers a discovery request has no issuer to
    // publish; giving it one only widens what a compromised instance holds.
    expect(envVarsOf('WorkerFleet')['BRAINZ_PUBLIC_ORIGIN']).toBeUndefined();
  });

  test('the tick and concurrency knobs reach the fleet that ticks, and no other', () => {
    expect(envVarsOf('WorkerFleet')['BRAINZ_WORKER_TICK_MS']).toBe(
      WORKER_ENV.BRAINZ_WORKER_TICK_MS,
    );
    expect(envVarsOf('McpFleet')['BRAINZ_WORKER_TICK_MS']).toBeUndefined();
  });
});

describe('a container receives no binding and nothing it does not read', () => {
  /**
   * The constraint that makes this more than a convenience: a Durable Object
   * namespace is not a string, so a blanket forward is both a type error and a
   * live object handed across a process boundary.
   */
  test('no manifest names a Durable Object binding', () => {
    for (const manifest of [
      router.MCP_FLEET_VARIABLES,
      router.WORKER_FLEET_VARIABLES,
      router.WEB_FLEET_VARIABLES,
    ]) {
      expect(manifest).not.toContain('MCP_FLEET');
      expect(manifest).not.toContain('WORKER_FLEET');
      expect(manifest).not.toContain('WEB_FLEET');
    }
  });

  test('and no binding survives into any fleet, whatever the manifest says', () => {
    for (const fleet of FLEETS) {
      const vars = envVarsOf(fleet);
      expect(vars['MCP_FLEET']).toBeUndefined();
      expect(vars['WORKER_FLEET']).toBeUndefined();
      expect(vars['WEB_FLEET']).toBeUndefined();
      for (const value of Object.values(vars)) expect(typeof value).toBe('string');
    }
  });

  /**
   * The guard itself, driven directly. Naming a binding in a manifest is the
   * plausible mistake — `MCP_FLEET` reads like a variable — and it must fail at
   * the seam rather than serialise a namespace stub into a container's
   * environment.
   */
  test('naming a binding in a manifest is refused, and the refusal names it', () => {
    expect(() => router.selectContainerEnv(WORKER_ENV, ['MCP_FLEET'])).toThrow(/MCP_FLEET/);
  });

  /**
   * The billing vendor's key, the substrate's key and the operator credential
   * reach the web fleet and nothing else. Note what is NOT in this list any
   * more: the identity database, which has its own test below because it is the
   * one variable whose blast radius genuinely widened.
   */
  test('the web process’s own configuration reaches the web fleet and no other', () => {
    for (const fleet of ['McpFleet', 'WorkerFleet'] as const) {
      const vars = envVarsOf(fleet);
      expect({ fleet, stripe: vars['BRAINZ_STRIPE_SECRET_KEY'] }).toEqual({ fleet, stripe: undefined });
      expect({ fleet, hook: vars['BRAINZ_STRIPE_WEBHOOK_SECRET'] }).toEqual({ fleet, hook: undefined });
      expect({ fleet, neon: vars['BRAINZ_NEON_API_KEY'] }).toEqual({ fleet, neon: undefined });
      expect({ fleet, mcpUrl: vars['BRAINZ_MCP_URL'] }).toEqual({ fleet, mcpUrl: undefined });
      expect({ fleet, admin: vars['BRAINZ_ADMIN_CREDENTIAL'] }).toEqual({ fleet, admin: undefined });
    }

    const web = envVarsOf('WebFleet');
    expect(web['BRAINZ_STRIPE_SECRET_KEY']).toBe(WORKER_ENV.BRAINZ_STRIPE_SECRET_KEY);
    expect(web['BRAINZ_NEON_API_KEY']).toBe(WORKER_ENV.BRAINZ_NEON_API_KEY);
    expect(web['BRAINZ_ADMIN_CREDENTIAL']).toBe(WORKER_ENV.BRAINZ_ADMIN_CREDENTIAL);
  });

  /**
   * **The identity database reaches two fleets, and that is a widening decided
   * here rather than inherited.**
   *
   * It used to reach the web fleet alone, on the argument that the process
   * parsing attacker-supplied content should not hold the credential store of
   * every account. The argument is still true and the cost is still real. What
   * overrode it is a routing fact: `edge.ts` classifies `/authorize` as `flow`
   * and sends it to `McpFleet`, so `sessionResourceOwners` runs THERE. Withhold
   * the DSN and `deps.resourceOwners` is `undefined`, which makes the browser
   * leg answer `401` — the connector's first hop, and therefore no browser
   * connect flow at all. A deployed consent screen that cannot read a session is
   * not a smaller attack surface, it is a feature that does not exist.
   *
   * The narrower alternative is real and is not this: move the consent surface
   * to the web fleet and have the two exchange a signed assertion over the
   * shared secret store. It needs a new web path and an `edge.ts` entry, so it
   * is a build rather than a manifest line — see `src/mcp/serve.ts`.
   *
   * **The worker fleet stays out**, and that is the half of the old invariant
   * that survives intact: a batch process serves no browser, so a session store
   * on its manifest is credential it holds and cannot use.
   */
  test('the identity database reaches the two fleets that serve a browser, and not the batch one', () => {
    expect(envVarsOf('McpFleet')['BRAINZ_IDENTITY_DATABASE_URL']).toBe(
      WORKER_ENV.BRAINZ_IDENTITY_DATABASE_URL,
    );
    expect(envVarsOf('WebFleet')['BRAINZ_IDENTITY_DATABASE_URL']).toBe(
      WORKER_ENV.BRAINZ_IDENTITY_DATABASE_URL,
    );
    expect(envVarsOf('WorkerFleet')['BRAINZ_IDENTITY_DATABASE_URL']).toBeUndefined();
  });

  /**
   * The widening is bounded to that one variable. Everything else the identity
   * fleet holds — the billing vendor, the substrate, the operator credential —
   * is still the web fleet's alone, so "the MCP fleet got identity" cannot decay
   * into "the manifests were merged".
   */
  test('the MCP fleet gained the session store and nothing else beside it', () => {
    const mcp = envVarsOf('McpFleet');
    for (const name of [
      'BRAINZ_STRIPE_SECRET_KEY',
      'BRAINZ_STRIPE_API_BASE',
      'BRAINZ_STRIPE_PRICE_ID',
      'BRAINZ_STRIPE_WEBHOOK_SECRET',
      'BRAINZ_NEON_API_KEY',
      'BRAINZ_NEON_ORG_ID',
      'BRAINZ_POOL_TARGET',
      'BRAINZ_TENANT_ID_PREFIX',
      'BRAINZ_ADMIN_CREDENTIAL',
      'BRAINZ_WEB_ORIGIN',
      'BRAINZ_MCP_URL',
    ]) {
      expect({ name, value: mcp[name] }).toEqual({ name, value: undefined });
    }
  });

  /**
   * And the other direction, which is the one a "just spread the shared bundle"
   * edit would break. `src/web/serve.ts` composes no gateway: it calls no model,
   * so every hosted key on its manifest would be a credential the widest surface
   * in the deployment holds and cannot use. The issuer is the same shape of
   * mistake — a process that answers no discovery request publishes none.
   */
  test('no model credential and no issuer reaches the web fleet', () => {
    const web = envVarsOf('WebFleet');
    for (const name of [
      'BRAINZ_HOSTED_KEY_CLOUDFLARE',
      'BRAINZ_HOSTED_KEY_OPENAI',
      'BRAINZ_HOSTED_KEY_GOOGLE',
      'BRAINZ_HOSTED_KEY_SELF_HOST',
      'BRAINZ_CF_ACCOUNT_ID',
      'BRAINZ_ROUTING_PROFILE',
      'BRAINZ_PUBLIC_ORIGIN',
      'BRAINZ_OAUTH_REDIRECT_URIS',
      'BRAINZ_WEB_APP_BASE_URL',
      'BRAINZ_WORKER_TICK_MS',
    ]) {
      expect({ name, value: web[name] }).toEqual({ name, value: undefined });
    }
  });

  test('credentials no fleet process reads are not shipped into one', () => {
    for (const fleet of FLEETS) {
      const vars = envVarsOf(fleet);
      // The unprefixed name is the probes' (`.env.example`), read by nothing
      // under `src/`. The web app's substrate credential is
      // `BRAINZ_NEON_API_KEY`, which is on its manifest and on no other.
      expect(vars['NEON_API_KEY']).toBeUndefined();
      // `createTenantObjectStore` has no production composition root — the only
      // minter in `src/` refuses. When one lands the variable joins a manifest
      // and this line changes with it.
      expect(vars['R2_SECRET_ACCESS_KEY']).toBeUndefined();
    }
  });

  /**
   * **The one variable whose whole value is being unreachable.**
   *
   * `BRAINZ_AUTHORIZATION_BACKEND=memory` puts the OAuth flow's clients, codes,
   * refresh tokens and revocations back into one container's memory — which is
   * the incident `src/control/oauth-pg.ts` exists to end: a forgotten client, a
   * refresh token that dies after fifteen idle minutes, and a revocation that
   * comes back to life when the container does. It stays reachable for a
   * single-instance self-hoster running this image, and it must not be settable
   * on a fleet whose containers are replaced — which is every Cloudflare one.
   *
   * `authorization-store.ts` says so in prose ("deliberately absent from
   * `MCP_FLEET_VARIABLES`, so the hosted fleet cannot be configured back into a
   * per-container store, by anybody, including us"). This is the line that makes
   * the sentence true. Without it, adding the name to a manifest is a one-word
   * diff that nothing in this repository notices: the exact-equality assertions
   * above compare against what the fixture sets, and a manifest entry for a
   * variable the deployment has not set copies nothing.
   */
  test('the escape hatch back to a per-container OAuth store reaches no container', () => {
    expect(WORKER_ENV.BRAINZ_AUTHORIZATION_BACKEND).toBe('memory');
    for (const fleet of FLEETS) {
      expect(envVarsOf(fleet)['BRAINZ_AUTHORIZATION_BACKEND']).toBeUndefined();
    }
    for (const manifest of [
      router.MCP_FLEET_VARIABLES,
      router.WORKER_FLEET_VARIABLES,
      router.WEB_FLEET_VARIABLES,
    ]) {
      expect(manifest).not.toContain('BRAINZ_AUTHORIZATION_BACKEND');
    }
  });

  /**
   * The path is the image's business, so an operator cannot aim a fleet at a
   * file inside the build context. See the Dockerfile's bootstrap.
   */
  test('the secrets FILE path is never forwarded, only the content', () => {
    for (const fleet of FLEETS) {
      expect(envVarsOf(fleet)['BRAINZ_SECRETS_FILE']).toBeUndefined();
      expect(envVarsOf(fleet)['BRAINZ_SECRETS_JSON']).toBe(WORKER_ENV.BRAINZ_SECRETS_JSON);
    }
  });

  /**
   * Absent stays absent. `env.ts` reads an empty string as unset, so forwarding
   * `''` for a variable nobody set would be harmless there — and would not be
   * harmless for `BRAINZ_ROUTING_PROFILE`, where `optional()` answers
   * `undefined` and the default applies. Either way the container's environment
   * should say what the deployment says, and no more.
   */
  test('a variable nobody configured is absent rather than empty', () => {
    const sparse = { BRAINZ_CONTROL_DATABASE_URL: 'postgres://fake@127.0.0.1:1/control' };
    const selected = router.selectContainerEnv(sparse, router.WORKER_FLEET_VARIABLES);
    expect(selected).toEqual(sparse);
    expect(Object.keys(selected)).not.toContain('BRAINZ_CF_ACCOUNT_ID');
  });
});

/**
 * The two lines that connect a tested router to real namespaces.
 *
 * `edge.ts` is exhaustively tested against stubs and `router.ts` is not tested at
 * all — it cannot be imported without workerd — so the hand-off between them is
 * the seam with no coverage on either side. Handing `MCP_FLEET` to the edge's
 * `web` argument would pass every test in `test/mcp/router.test.ts` (the stubs
 * are indistinguishable) and serve the MCP surface's 404 at `/signup` in
 * production. The mock that makes the Container classes constructible makes this
 * checkable too, so it is checked.
 */
describe('the Worker hands the edge the bindings it names', () => {
  function bindingSpies(): {
    readonly env: Record<string, unknown>;
    readonly addressed: { mcp: string[]; web: string[] };
  } {
    const addressed: { mcp: string[]; web: string[] } = { mcp: [], web: [] };
    const spy = (into: string[]) => ({
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => {
        into.push(id.name);
        return { fetch: () => Promise.resolve(Response.json({ ok: true })) };
      },
    });
    return {
      env: { MCP_FLEET: spy(addressed.mcp), WEB_FLEET: spy(addressed.web) },
      addressed,
    };
  }

  test('a web path reaches the WEB_FLEET namespace, not the MCP one', async () => {
    const { env, addressed } = bindingSpies();
    const response = await router.default.fetch(
      new Request('https://fleet.brainz.test/signup', {
        headers: { 'cf-connecting-ip': '198.51.100.21' },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(addressed.web).toHaveLength(1);
    expect(addressed.mcp).toEqual([]);
  });

  test('and a discovery path still reaches the MCP namespace', async () => {
    const { env, addressed } = bindingSpies();
    await router.default.fetch(
      new Request('https://fleet.brainz.test/.well-known/oauth-protected-resource', {
        headers: { 'cf-connecting-ip': '198.51.100.22' },
      }),
      env,
    );
    expect(addressed.mcp).toHaveLength(1);
    expect(addressed.web).toEqual([]);
  });
});

describe('the cron wakes the worker fleet', () => {
  /**
   * A container class nobody addresses never boots. `WORKER_FLEET` was bound in
   * `wrangler.toml` and reached by nothing: the deploy would have succeeded, the
   * MCP surface would have served, and no consolidation cycle would ever have
   * run — the same shape as an unconfigured container, one layer up.
   */
  test('a scheduled invocation addresses the worker namespace and dials it', async () => {
    const dialled: { name?: string; url?: string } = {};
    const fleet = {
      idFromName(name: string) {
        dialled.name = name;
        return { name };
      },
      get() {
        return {
          async fetch(request: Request) {
            dialled.url = request.url;
            return Response.json({ ok: true });
          },
        };
      },
    };

    await router.wakeWorkerFleet(fleet);
    // One name, so every wake lands on one instance: two schedulers ticking the
    // same queue is the lease ladder's problem, not the cron's.
    expect(dialled.name).toBe(router.WORKER_WAKE_INSTANCE);
    expect(dialled.url).toContain('/health');
  });

  test('a worker fleet that will not answer makes the cron invocation fail, visibly', async () => {
    const fleet = {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async () => new Response('nope', { status: 503 }),
      }),
    };
    // Reported rather than swallowed: a swallowed failure is a cron history full
    // of successful invocations of a fleet that never woke.
    await expect(router.wakeWorkerFleet(fleet)).rejects.toThrow(/503/);
  });

  test('the scheduled handler is the Worker export the trigger calls', async () => {
    const dialled: string[] = [];
    const env = {
      WORKER_FLEET: {
        idFromName: (name: string) => {
          dialled.push(name);
          return { name };
        },
        get: () => ({ fetch: async () => Response.json({ ok: true }) }),
      },
    };
    await router.default.scheduled({ cron: '*/30 * * * *' }, env, { waitUntil: () => undefined });
    expect(dialled).toEqual([router.WORKER_WAKE_INSTANCE]);
  });
});
