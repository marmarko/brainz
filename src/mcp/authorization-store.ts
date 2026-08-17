/**
 * Which authorization store a fleet composes, and what it refuses.
 *
 * **The decision under test is a default.** The in-memory store cannot serve a
 * deployment whose containers are replaced — `McpFleet.sleepAfter` is fifteen
 * minutes, `edge.ts:FLOW_INSTANCE` puts the whole flow on one Durable Object,
 * and every deploy destroys it. A registered client is forgotten, an established
 * connector's refresh token dies, and a revocation the user asked for comes back
 * to life. So the durable store has to be what a process gets when **nobody
 * chose**, and the in-memory one has to be something an operator asks for by
 * name.
 *
 * That is the whole reason this file exists rather than a ternary at the
 * composition root. A previous pass on the secret store learned it the hard way:
 * a mutation flipping the default backend survived, because every test named its
 * backend explicitly and nothing anywhere asserted what an *unconfigured* process
 * does. `test/mcp/authorization-store.test.ts` asserts exactly that, by the tell
 * it leaves behind — which variable the refusal names.
 *
 * **Every wrong configuration refuses rather than downgrades.** The shape to
 * fear is a fleet that finds no sealing key, quietly falls back to a per-container
 * `Map`, starts green and forgets the founder's connector — the original incident
 * wearing a fallback's clothes.
 *
 * **No new environment variable.** The durable backend needs the sealing key the
 * MCP fleet's manifest already carries (`BRAINZ_SECRET_ENCRYPTION_KEY`) and the
 * control-plane handle every process already opens, so a deployment that is
 * serving tenants today gets a durable authorization store by upgrading, with no
 * operator step. `BRAINZ_AUTHORIZATION_BACKEND` exists only to opt *out*.
 *
 * **And it is deliberately absent from `router.ts:MCP_FLEET_VARIABLES`.** A
 * Container only receives the variables that manifest names, so the opt-out is
 * unreachable in the Cloudflare deployment: the hosted fleet *cannot* be
 * configured back into a per-container store, by anybody, including us. The
 * escape hatch is for someone running this image themselves, which is the only
 * deployment where it is the right answer.
 */

import type { SQL } from 'bun';

import {
  createPostgresAuthorizationStore,
  ensureAuthorizationStoreSchema,
} from '../control/oauth-pg.ts';
import { importSealingKey } from '../control/sealed.ts';
import { FleetConfigError, optional, required, type Environment } from '../fleet/env.ts';
import { createInMemoryAuthorizationStore, type AuthorizationStore } from './oauth.ts';

/** The backends a deployment may choose between. Anything else is a refusal. */
export const AUTHORIZATION_BACKENDS = ['postgres', 'memory'] as const;
export type AuthorizationBackendName = (typeof AUTHORIZATION_BACKENDS)[number];

export const DEFAULT_AUTHORIZATION_BACKEND: AuthorizationBackendName = 'postgres';

/**
 * The authorization store, over whichever backend this deployment configured.
 *
 * **`memory` stays reachable, and is chosen by name.** A self-hoster running one
 * container with no control plane worth the name is exactly the deployment it
 * fits, and KTD13's open-source promise depends on the non-Cloudflare path
 * working. What it must never be is fallen *into*: a deployment that quietly
 * downgraded because a variable was missing is the failure this store was built
 * to end, rediscovered by a user in production.
 */
export async function openAuthorizationStore(
  env: Environment,
  controlSql: SQL,
): Promise<AuthorizationStore> {
  const name = (optional(env, 'BRAINZ_AUTHORIZATION_BACKEND') ?? DEFAULT_AUTHORIZATION_BACKEND) as
    | AuthorizationBackendName
    | string;

  if (name === 'memory') return createInMemoryAuthorizationStore();

  if (name !== 'postgres') {
    throw new FleetConfigError(
      'BRAINZ_AUTHORIZATION_BACKEND',
      `names no authorization backend; known backends are ${AUTHORIZATION_BACKENDS.join(', ')}`,
    );
  }

  const key = await sealingKey(env);
  // At start, not at the first `/register`: the live control plane was created
  // before this table existed, and a fleet that cannot create or reach its
  // authorization store must crash-loop visibly rather than answer one user's
  // connect flow with a 500 an hour later.
  await ensureAuthorizationStoreSchema(controlSql);

  return createPostgresAuthorizationStore({ sql: controlSql, key });
}

/**
 * The same key the secret store imports, and the same refusal shape.
 *
 * Re-thrown as a config refusal so the container log names the variable rather
 * than a module. The detail never carries the value.
 */
async function sealingKey(env: Environment): Promise<CryptoKey> {
  const configured = required(env, 'BRAINZ_SECRET_ENCRYPTION_KEY');
  try {
    return await importSealingKey(configured);
  } catch (error) {
    throw new FleetConfigError(
      'BRAINZ_SECRET_ENCRYPTION_KEY',
      error instanceof Error ? error.message.replace(/^the sealing key /, '') : String(error),
    );
  }
}
