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
import {
  createCloudflareUnifiedTransport,
  createDirectTransport,
  createModelGateway,
  createPostgresSpendMeter,
} from '../ai/gateway.ts';
import type { ModelGateway, ModelTransport } from '../ai/gateway.ts';
import {
  PROFILES,
  type NamedProfile,
  type ProviderId,
  type RoutingProfileName,
} from '../ai/routing.ts';
import { createFileSecretStore } from '../control/secret-file.ts';
import {
  createPostgresSecretStore,
  ensureSecretStoreSchema,
  importSecretSeed,
} from '../control/secret-pg.ts';
import { importSealingKey } from '../control/sealed.ts';
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

/** The backends a deployment may choose between. Anything else is a refusal. */
export const SECRET_BACKENDS = ['postgres', 'file'] as const;
export type SecretBackendName = (typeof SECRET_BACKENDS)[number];

export const DEFAULT_SECRET_BACKEND: SecretBackendName = 'postgres';

/**
 * The secret store, over whichever backend this deployment configured.
 *
 * **`postgres` is the default, and that is the whole point.** The file backend
 * cannot serve a deployment whose processes do not share a volume: the web fleet
 * banks a new tenant's connection string into its own container's temporary
 * copy, the MCP fleet never sees it, and the credential dies with the instance
 * — which is a real signup answering `invalid_grant` on `/token` and a paid Neon
 * project holding a brain nobody can open. `src/control/secret-pg.ts` is the
 * durable backend and this is where the deployed default points.
 *
 * **The file backend stays, and stays reachable.** A self-hoster with a real
 * volume is exactly the deployment it fits, and KTD13's open-source promise
 * depends on the non-Cloudflare path working. It is chosen by name
 * (`BRAINZ_SECRET_BACKEND=file`), never fallen back into: a deployment that
 * quietly downgraded to a per-container store because a variable was missing is
 * the bug above, rediscovered by an operator in production.
 *
 * **Fail-closed in both directions.** An unknown backend name refuses; the
 * `postgres` backend refuses without a sealing key; the `file` backend refuses
 * without a path. Every refusal names the variable, because the operator reading
 * it is looking at a container log with no other context.
 */
export async function openSecretStore(env: Environment, controlSql: SQL): Promise<FleetSecrets> {
  const name = (optional(env, 'BRAINZ_SECRET_BACKEND') ?? DEFAULT_SECRET_BACKEND) as
    | SecretBackendName
    | string;

  if (name === 'file') {
    const file = createFileSecretStore({ path: required(env, 'BRAINZ_SECRETS_FILE') });
    return {
      store: createTenantSecretStore({ backend: file.secrets }),
      providerKeys: file.providerKeys,
    };
  }

  if (name !== 'postgres') {
    throw new FleetConfigError(
      'BRAINZ_SECRET_BACKEND',
      `names no secret backend; known backends are ${SECRET_BACKENDS.join(', ')}`,
    );
  }

  const key = await sealingKey(env);
  // At start, not at the first resolve: the live control plane was created from
  // `schema.sql` before this table existed, and a fleet that cannot create or
  // reach its store must crash-loop visibly rather than answer one user's tool
  // call with a 500.
  await ensureSecretStoreSchema(controlSql);
  const backend = createPostgresSecretStore({ sql: controlSql, key });

  await importSeed(env, controlSql, key);

  return {
    store: createTenantSecretStore({ backend: backend.secrets }),
    providerKeys: backend.providerKeys,
  };
}

async function sealingKey(env: Environment): Promise<CryptoKey> {
  const configured = required(env, 'BRAINZ_SECRET_ENCRYPTION_KEY');
  try {
    return await importSealingKey(configured);
  } catch (error) {
    // Re-thrown as a config refusal so the log names the variable rather than a
    // module. The detail never carries the value.
    throw new FleetConfigError(
      'BRAINZ_SECRET_ENCRYPTION_KEY',
      error instanceof Error ? error.message.replace(/^the sealing key /, '') : String(error),
    );
  }
}

/**
 * Import `BRAINZ_SECRETS_JSON`, if this deployment still carries one.
 *
 * The variable is no longer a store — it is a one-way bootstrap seed, imported
 * once ever per blob and never able to overwrite an entry the durable store
 * already holds (`secret-pg.ts:importSecretSeed`). It is read through the file
 * the image's bootstrap materialises, because that bootstrap unsets the variable
 * before handing over, and the seed is *optional*: a deployment that has already
 * migrated deletes the secret and starts with nothing to import.
 */
async function importSeed(env: Environment, controlSql: SQL, key: CryptoKey): Promise<void> {
  const path = optional(env, 'BRAINZ_SECRETS_FILE');
  if (path === undefined) return;
  const file = Bun.file(path);
  if (!(await file.exists())) return;

  await importSecretSeed({
    sql: controlSql,
    key,
    text: await file.text(),
    source: `the secret seed at ${path}`,
  });
}

export interface GatewayDeps {
  readonly controlSql: SQL;
  readonly keys: ProviderKeyBackend;
}

/**
 * Which transport each provider's calls go out on.
 *
 * Exported because it is the one decision in this file worth asserting rather
 * than reading: it had been `createDirectTransport({})` for everything, and
 * `PROVIDER_DIRECT_BASES.cloudflare` is `null`, so every `@cf/` seat was a
 * `TransportError` at first call — per tenant, inside a paid consolidation
 * cycle, on a fleet that booted green.
 *
 * **The account id is required at startup, not at first call**, and only for a
 * profile that actually routes something to Cloudflare. A self-hoster composes
 * this with an empty environment and gets a working direct transport for every
 * seat, which is KTD13's open-source promise stated as code rather than as
 * prose. It is read from `BRAINZ_CF_ACCOUNT_ID`; the repo is public and a
 * literal here is the incident.
 */
export function selectFleetTransport(
  env: Environment,
  profile: NamedProfile,
): (provider: ProviderId) => ModelTransport {
  const direct = createDirectTransport({});
  const usesCloudflare = Object.values(profile.routes).some(
    (route) => route.provider === 'cloudflare',
  );
  if (!usesCloudflare) return () => direct;

  const unified = createCloudflareUnifiedTransport({
    accountId: required(env, 'BRAINZ_CF_ACCOUNT_ID'),
  });
  return (provider) => (provider === 'cloudflare' ? unified : direct);
}

/**
 * The pooled keys an operator supplied, and only those.
 *
 * Still per-provider, and still says something true — but it says a smaller
 * thing than it used to. On the hosted profile one credential now pays for
 * eight of the nine seats, because Unified Billing holds the provider
 * relationship for the third-party models too: `BRAINZ_HOSTED_KEY_GOOGLE` is
 * no longer read by any hosted route, and serves only a self-hoster reaching
 * Google directly. `BRAINZ_HOSTED_KEY_OPENAI` still pays for the embedding
 * seat, which did not move.
 *
 * Collapsing the pool to one key would therefore be wrong twice over: it would
 * break the self-host profile, which needs two provider credentials and no
 * Cloudflare one, and it would break the embedding seat on the hosted plane.
 * The pool is per-**provider** because a key is a fact about a provider
 * relationship, and the hosted plane having fewer of those than it used to is a
 * change in the routing table, not in what a key is.
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
 * The transport is chosen per provider by {@link selectFleetTransport}: the
 * Cloudflare seats go out over Unified Billing, everything else direct. A self
 * hoster has no Cloudflare account, and KTD13 requires the direct path to work
 * regardless — the `self-host` profile routes nothing to Cloudflare, so it
 * composes with no Cloudflare configuration at all. An operator with neither
 * supplies no keys, and the key resolver answers `no_key_available` at call
 * time rather than this file inventing a credential at startup.
 */
/**
 * Which routing profile this deployment runs.
 *
 * Lifted out of {@link openFleetGateway} because a second consumer arrived: the
 * ingest runners take a `NamedProfile` directly — the first-import estimate
 * prices the profile's own embedding seat, so a runner composed against a
 * different profile than the gateway would gate on one price and spend at
 * another. One reader, one refusal, one profile per process.
 */
export function fleetRoutingProfile(env: Environment): NamedProfile {
  const name = (optional(env, 'BRAINZ_ROUTING_PROFILE') ?? 'hosted') as RoutingProfileName;
  const profile = PROFILES[name];
  if (profile === undefined) {
    throw new FleetConfigError(
      'BRAINZ_ROUTING_PROFILE',
      `names no routing profile; known profiles are ${Object.keys(PROFILES).join(', ')}`,
    );
  }
  return profile;
}

export function openFleetGateway(env: Environment, deps: GatewayDeps): ModelGateway {
  const profile = fleetRoutingProfile(env);

  return createModelGateway({
    profile,
    transport: selectFleetTransport(env, profile),
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
