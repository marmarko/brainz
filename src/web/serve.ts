#!/usr/bin/env bun
/**
 * The web app's process entrypoint.
 *
 * **The whole app was unreachable.** `createWebApp` had exactly one importer in
 * the repo — its own test — and an import-graph walk from the declared
 * production roots never reached `src/web/` at all. U15's verification sentence
 * is *"a stranger can sign up"*, and no process served that page. This file is
 * the process.
 *
 * **What this composition root may hold, and the narrowing is the point.** The
 * identity database and the control plane are the app's own. The provider-key
 * port handed to it is the **write half only** (`ProviderKeyWriter`), built here
 * from a store this file holds and the app does not — R22's BYOK entry has to
 * write a key the user typed and must never be able to read one back. The secret
 * store and the provisioner live at this layer for the same reason: R11 says the
 * web-app identity holds no resolve permission on any tenant namespace, so it is
 * handed ports, not stores.
 *
 * **The error boundary is here because a handler throw has nowhere else to
 * land.** `createWebApp` returns a bare `(Request) => Promise<Response>`; an
 * exception out of it becomes whatever the server runtime decides, which is a
 * stack trace on a public origin. The wrapper answers a generic 500 and writes
 * the detail to stderr — the operator gets the message, the stranger does not.
 */

import { SQL } from 'bun';

import { createWebApp, type ConnectorVendor, type ProviderKeyWriter } from './app.ts';
import { createTenantProviderKeyStore, type ProviderId } from '../ai/keys.ts';
import { createStripeCheckout, type CheckoutPort } from '../control/checkout.ts';
import { createPostgresControlPlaneStore } from '../control/control-store.ts';
import { createBrainProvisioner } from '../control/provisioner.ts';
import { controlPlaneIdentity } from '../control/secrets.ts';
import { createTenantStorage } from '../control/storage.ts';
import {
  openControlPlane,
  openIdentityStore,
  openSecretStore,
  type FleetSecrets,
} from '../fleet/compose.ts';
import {
  announceListening,
  integer,
  optional,
  origin,
  port,
  refuseToStart,
  required,
  type Environment,
} from '../fleet/env.ts';

export interface WebProcess {
  readonly port: number;
  stop(): Promise<void>;
}

export async function startWebApp(env: Environment): Promise<WebProcess> {
  const appOrigin = origin(env, 'BRAINZ_WEB_ORIGIN');
  const sql = openIdentityStore(env);
  const controlSql = openControlPlane(env);
  const secrets = openSecretStore(env);

  const handle = createWebApp({
    sql,
    controlSql,
    origin: appOrigin,
    mcpUrl: required(env, 'BRAINZ_MCP_URL'),
    stripeWebhookSecret: required(env, 'BRAINZ_STRIPE_WEBHOOK_SECRET'),
    byok: writeOnlyProviderKeys(secrets),
    connectors: connectorVendor(),
    provisioner: createBrainProvisioner({
      controlSql,
      store: createPostgresControlPlaneStore(controlSql),
      secrets: secrets.store,
      prefixes: prefixSource(),
      // No default. `pool.ts` refuses a construction that omits the target, and
      // `0` — provision synchronously, which is U2's behaviour — is what this
      // runs until the create-to-first-query benchmark produces a receipt.
      poolTarget: integer(env, 'BRAINZ_POOL_TARGET', 0),
    }),
    ...checkoutPort(env),
    ...(optional(env, 'BRAINZ_ADMIN_CREDENTIAL') === undefined
      ? {}
      : { adminCredential: optional(env, 'BRAINZ_ADMIN_CREDENTIAL') as string }),
  });

  const http = Bun.serve({
    port: port(env),
    hostname: '0.0.0.0',
    async fetch(request: Request): Promise<Response> {
      if (new URL(request.url).pathname === '/health') {
        return Response.json({ ok: true, service: 'web' });
      }
      try {
        return await handle(request);
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({
            event: 'request_failed',
            path: new URL(request.url).pathname,
            message: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
        // Deliberately says nothing. An error message on this surface is the
        // ordinary way a DSN, a stack path or a fragment of somebody's data
        // reaches a stranger's browser.
        return Response.json({ ok: false, code: 'internal_error' }, { status: 500 });
      }
    },
  });

  // The port the socket actually bound, off the server's own URL: with `PORT=0`
  // the OS chooses it, so a caller that echoed the configured value would report
  // `0` and a harness would dial nothing.
  const bound = Number(http.url.port);
  announceListening({ service: 'web', port: bound });

  return {
    port: bound,
    async stop() {
      await http.stop(true);
      await sql.close();
      await controlSql.close();
    },
  };
}

/**
 * The BYOK port, narrowed on construction.
 *
 * The store this closes over can resolve keys; the object handed to the app
 * cannot, because `resolve` is not on {@link ProviderKeyWriter}. That is the
 * same narrowing `provision.ts` gets from `TenantSecretWriter`, applied at the
 * surface where a user's key arrives.
 */
function writeOnlyProviderKeys(secrets: FleetSecrets): ProviderKeyWriter {
  const store = createTenantProviderKeyStore({ backend: secrets.providerKeys });
  const caller = controlPlaneIdentity();
  return {
    async put(tenantId: string, provider: ProviderId, key: string) {
      return { ok: (await store.put(caller, tenantId, provider, key)).ok };
    },
    async revoke(tenantId: string, provider: ProviderId) {
      return { ok: (await store.revoke(caller, tenantId, provider)).ok };
    },
  };
}

/**
 * The tenant's object-storage prefix, and nothing else.
 *
 * `TenantPrefixSource` has `prefixFor` alone, so what provisioning receives is
 * type-incapable of minting a credential. The minter below refuses rather than
 * standing in: `createInMemoryCredentialMinter` says in its own header that it
 * is not R2's scheme, and a fleet that wired it as production would be handing
 * out credentials no object store honours. Deriving a prefix needs no minter,
 * and this is the seam where that stays true.
 */
function prefixSource(): ReturnType<typeof createTenantStorage> {
  return createTenantStorage({
    minter: {
      mint() {
        return Promise.reject(
          new Error(
            'no object-storage credential minter is configured; provisioning derives a prefix and never mints',
          ),
        );
      },
    },
  });
}

/**
 * The billing vendor, when one is configured.
 *
 * **All three variables or none.** A partially configured vendor is the shape
 * that produces a checkout route which reaches the network with an empty
 * credential and reports the refusal as a vendor outage; naming the missing
 * variable at startup is the version of that an operator can fix. The API base
 * is configuration rather than a literal — see `src/control/checkout.ts`.
 */
function checkoutPort(env: Environment): { readonly checkout?: CheckoutPort } {
  const apiBase = optional(env, 'BRAINZ_STRIPE_API_BASE');
  const secretKey = optional(env, 'BRAINZ_STRIPE_SECRET_KEY');
  const priceId = optional(env, 'BRAINZ_STRIPE_PRICE_ID');
  if (apiBase === undefined && secretKey === undefined && priceId === undefined) return {};

  return {
    checkout: createStripeCheckout({
      apiBase: origin(env, 'BRAINZ_STRIPE_API_BASE'),
      secretKey: required(env, 'BRAINZ_STRIPE_SECRET_KEY'),
      priceId: required(env, 'BRAINZ_STRIPE_PRICE_ID'),
    }),
  };
}

/**
 * The connector vendor, when one is configured — and an honest refusal when not.
 *
 * Connectors are paid-only (U15 §5) and the free-tier gate refuses before this
 * is ever reached, so a deployment with no vendor credential is a real and
 * common state. What it must not be is a silent success: a `claimUrl` this
 * process invented is a link that attaches nothing and reports that it did.
 */
function connectorVendor(): ConnectorVendor {
  const unconfigured = (): never => {
    throw new Error('no connector vendor is configured on this deployment');
  };
  return { mintClaimUrl: unconfigured, disconnect: unconfigured };
}

if (import.meta.main) {
  try {
    await startWebApp(process.env);
  } catch (error) {
    refuseToStart(error);
  }
}

/** Re-exported so a reader of the entrypoint can see the handle types it composes. */
export type { SQL };
