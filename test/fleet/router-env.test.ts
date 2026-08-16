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
  readonly MCP_FLEET_VARIABLES: readonly string[];
  readonly WORKER_FLEET_VARIABLES: readonly string[];
  readonly WORKER_WAKE_INSTANCE: string;
  selectContainerEnv(env: unknown, names: readonly string[]): Record<string, string>;
  wakeWorkerFleet(fleet: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(request: Request): Promise<Response> };
  }): Promise<void>;
  readonly default: {
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
 * The last group is the point of the fixture. `BRAINZ_IDENTITY_DATABASE_URL`
 * and the Stripe credentials belong to the web process; `R2_SECRET_ACCESS_KEY`
 * and `NEON_API_KEY` are read by nothing in either fleet. A blanket forward of
 * `env` puts all four inside a container that parses attacker-supplied content,
 * which is the mutation this fixture exists to kill.
 */
const DO_BINDING = { idFromName: () => ({}), get: () => ({ fetch: async () => new Response() }) };

const WORKER_ENV = {
  MCP_FLEET: DO_BINDING,
  WORKER_FLEET: DO_BINDING,

  BRAINZ_CONTROL_DATABASE_URL: 'postgres://fake@127.0.0.1:1/control',
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

  // Read by no fleet process. Present here because a forward of the whole `env`
  // would carry them, and that has to fail.
  BRAINZ_IDENTITY_DATABASE_URL: 'postgres://fake@127.0.0.1:1/identity',
  BRAINZ_STRIPE_SECRET_KEY: 'sk_test_this_test_invented_it',
  BRAINZ_MCP_URL: 'https://mcp.brainz.test/mcp',
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

function envVarsOf(fleet: 'McpFleet' | 'WorkerFleet'): Record<string, string> {
  const Class = fleet === 'McpFleet' ? router.McpFleet : router.WorkerFleet;
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
      // The secret store, as content. The image's bootstrap turns it into the
      // file `compose.ts` reads and chooses the path itself.
      BRAINZ_SECRETS_JSON: WORKER_ENV.BRAINZ_SECRETS_JSON,
      // serve.ts: the OAuth issuer and the registration allowlist.
      BRAINZ_PUBLIC_ORIGIN: WORKER_ENV.BRAINZ_PUBLIC_ORIGIN,
      BRAINZ_OAUTH_REDIRECT_URIS: WORKER_ENV.BRAINZ_OAUTH_REDIRECT_URIS,
      BRAINZ_OAUTH_MAX_REGISTRATIONS_PER_HOUR:
        WORKER_ENV.BRAINZ_OAUTH_MAX_REGISTRATIONS_PER_HOUR,
      BRAINZ_WEB_APP_BASE_URL: WORKER_ENV.BRAINZ_WEB_APP_BASE_URL,
    });
  });

  test('the worker fleet gets the batch half, and none of the MCP surface', () => {
    expect(envVarsOf('WorkerFleet')).toEqual({
      BRAINZ_CONTROL_DATABASE_URL: WORKER_ENV.BRAINZ_CONTROL_DATABASE_URL,
      BRAINZ_ROUTING_PROFILE: WORKER_ENV.BRAINZ_ROUTING_PROFILE,
      BRAINZ_CF_ACCOUNT_ID: WORKER_ENV.BRAINZ_CF_ACCOUNT_ID,
      BRAINZ_HOSTED_KEY_CLOUDFLARE: WORKER_ENV.BRAINZ_HOSTED_KEY_CLOUDFLARE,
      BRAINZ_HOSTED_KEY_OPENAI: WORKER_ENV.BRAINZ_HOSTED_KEY_OPENAI,
      BRAINZ_SECRETS_JSON: WORKER_ENV.BRAINZ_SECRETS_JSON,
      BRAINZ_WORKER_CONCURRENCY: WORKER_ENV.BRAINZ_WORKER_CONCURRENCY,
      BRAINZ_WORKER_TICK_MS: WORKER_ENV.BRAINZ_WORKER_TICK_MS,
    });
  });

  /**
   * The two asymmetries, named rather than left to the `toEqual` above. A future
   * edit that merges the manifests would keep both tests above passing only by
   * accident; these say which direction each variable travels and why.
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
  test('neither manifest names a Durable Object binding', () => {
    for (const manifest of [router.MCP_FLEET_VARIABLES, router.WORKER_FLEET_VARIABLES]) {
      expect(manifest).not.toContain('MCP_FLEET');
      expect(manifest).not.toContain('WORKER_FLEET');
    }
  });

  test('and no binding survives into either fleet, whatever the manifest says', () => {
    for (const fleet of ['McpFleet', 'WorkerFleet'] as const) {
      const vars = envVarsOf(fleet);
      expect(vars['MCP_FLEET']).toBeUndefined();
      expect(vars['WORKER_FLEET']).toBeUndefined();
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

  test('the web process’s own configuration reaches neither fleet', () => {
    for (const fleet of ['McpFleet', 'WorkerFleet'] as const) {
      const vars = envVarsOf(fleet);
      // The identity database is `src/web/serve.ts`'s alone; no fleet entrypoint
      // calls `openIdentityStore`.
      expect(vars['BRAINZ_IDENTITY_DATABASE_URL']).toBeUndefined();
      expect(vars['BRAINZ_STRIPE_SECRET_KEY']).toBeUndefined();
      expect(vars['BRAINZ_MCP_URL']).toBeUndefined();
    }
  });

  test('credentials no fleet process reads are not shipped into one', () => {
    for (const fleet of ['McpFleet', 'WorkerFleet'] as const) {
      const vars = envVarsOf(fleet);
      // Provisioning is the web app's; `createBrainProvisioner`'s Neon port is
      // optional and no fleet entrypoint supplies it.
      expect(vars['NEON_API_KEY']).toBeUndefined();
      // `createTenantObjectStore` has no production composition root — the only
      // minter in `src/` refuses. When one lands the variable joins a manifest
      // and this line changes with it.
      expect(vars['R2_SECRET_ACCESS_KEY']).toBeUndefined();
    }
  });

  /**
   * The path is the image's business, so an operator cannot aim a fleet at a
   * file inside the build context. See the Dockerfile's bootstrap.
   */
  test('the secrets FILE path is never forwarded, only the content', () => {
    for (const fleet of ['McpFleet', 'WorkerFleet'] as const) {
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
