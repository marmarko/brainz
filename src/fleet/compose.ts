/**
 * The pieces every fleet process builds the same way.
 *
 * Three entrypoints (`src/mcp/serve.ts`, `src/worker/serve.ts`,
 * `src/web/serve.ts`) need the same control-plane handle, the same secret store
 * and — for two of them — the same model gateway. Building each independently is
 * how the MCP fleet ends up metering spend to a different place than the worker
 * fleet, or reading a different secret store than the one signup writes to. One
 * builder each, here, so a change to how a dependency is composed lands on every
 * process at once.
 *
 * **This module composes; it does not decide.** Every policy it touches lives
 * somewhere else — the spend counter is `gateway.ts`'s, the resolve boundary is
 * `secrets.ts`'s, the routing profile is `routing.ts`'s. What is decided here is
 * only which implementation of each port a deployed process receives.
 */

import { SQL } from 'bun';

import { createHostedKeyPool, createTenantProviderKeyStore } from '../ai/keys.ts';
import type { ProviderKeyBackend } from '../ai/keys.ts';
import { createDirectTransport, createModelGateway, createPostgresSpendMeter } from '../ai/gateway.ts';
import type { ModelGateway } from '../ai/gateway.ts';
import { PROFILES, type ProviderId, type RoutingProfileName } from '../ai/routing.ts';
import { createFileSecretStore } from '../control/secret-file.ts';
import { createTenantSecretStore } from '../control/secrets.ts';
import type { PoolSecretStore, TenantSecretStore } from '../control/secrets.ts';
import { FleetConfigError, optional, required, type Environment } from './env.ts';

/**
 * The control plane, as a handle.
 *
 * `max` is small on purpose: the control plane serves short bookkeeping
 * statements from every instance of every fleet, and a generous per-instance
 * pool multiplied by the instance ceiling is how a database sized for
 * bookkeeping runs out of connections during a traffic spike it is not even
 * serving.
 */
export function openControlPlane(env: Environment): SQL {
  return new SQL(required(env, 'BRAINZ_CONTROL_DATABASE_URL'), { max: 4 });
}

/** The identity database (`src/control/account-schema.sql`). The web app's alone. */
export function openIdentityStore(env: Environment): SQL {
  return new SQL(required(env, 'BRAINZ_IDENTITY_DATABASE_URL'), { max: 8 });
}

export interface FleetSecrets {
  readonly store: TenantSecretStore & PoolSecretStore;
  readonly providerKeys: ProviderKeyBackend;
}

/**
 * The secret store, over the file backend.
 *
 * `secrets.ts` ships only an in-memory backend and calls it unfit for
 * production, so a process composed without this would hold every tenant's
 * connection string in memory and lose them all on restart. See
 * `src/control/secret-file.ts` for what the file backend is and is not.
 */
export function openSecretStore(env: Environment): FleetSecrets {
  const file = createFileSecretStore({ path: required(env, 'BRAINZ_SECRETS_FILE') });
  return {
    store: createTenantSecretStore({ backend: file.secrets }),
    providerKeys: file.providerKeys,
  };
}

export interface GatewayDeps {
  readonly controlSql: SQL;
  readonly keys: ProviderKeyBackend;
}

/**
 * The pooled keys an operator supplied, and only those.
 *
 * Built by omission rather than by writing `undefined`: an entry present and
 * undefined is not the same as an entry absent under
 * `exactOptionalPropertyTypes`, and the pool must hold no key it was not given.
 */
function hostedKeys(env: Environment): Partial<Record<ProviderId, string>> {
  const named: Readonly<Record<ProviderId, string>> = {
    openai: 'BRAINZ_HOSTED_KEY_OPENAI',
    google: 'BRAINZ_HOSTED_KEY_GOOGLE',
    cloudflare: 'BRAINZ_HOSTED_KEY_CLOUDFLARE',
    'self-host': 'BRAINZ_HOSTED_KEY_SELF_HOST',
  };
  const out: Partial<Record<ProviderId, string>> = {};
  for (const [provider, variable] of Object.entries(named) as [ProviderId, string][]) {
    const key = optional(env, variable);
    if (key !== undefined) out[provider] = key;
  }
  return out;
}

/**
 * The single model gateway (`src/README.md`: every model call goes through it).
 *
 * The transport is the **direct** one rather than the hosted gateway: a self
 * hoster has no Cloudflare account, and KTD13 requires the direct path to work
 * regardless. An operator on the hosted plane sets the profile to `hosted` and
 * supplies pooled keys; one with neither supplies none, and the key resolver
 * answers `no_key_available` at call time rather than this file inventing a
 * credential at startup.
 */
export function openFleetGateway(env: Environment, deps: GatewayDeps): ModelGateway {
  const name = (optional(env, 'BRAINZ_ROUTING_PROFILE') ?? 'hosted') as RoutingProfileName;
  const profile = PROFILES[name];
  if (profile === undefined) {
    throw new FleetConfigError(
      'BRAINZ_ROUTING_PROFILE',
      `names no routing profile; known profiles are ${Object.keys(PROFILES).join(', ')}`,
    );
  }

  return createModelGateway({
    profile,
    transport: createDirectTransport({}),
    meter: createPostgresSpendMeter({ sql: deps.controlSql }),
    keys: {
      store: createTenantProviderKeyStore({ backend: deps.keys }),
      // Absent entries are absent, not empty strings: `createHostedKeyPool`
      // drops `undefined`, and a pool holding `''` would present an empty
      // credential to a provider and read the refusal as a provider outage.
      hosted: createHostedKeyPool(hostedKeys(env)),
    },
  });
}
