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

import { createWebApp, type ConnectorVendor, type ProviderKeyWriter, type SeverancePort } from './app.ts';
import { createTenantProviderKeyStore, type ProviderId } from '../ai/keys.ts';
import { previewSeverance } from '../core/lifecycle/blast-radius.ts';
import { severOrigin } from '../core/lifecycle/severance.ts';
import { createStripeCheckout, type CheckoutPort } from '../control/checkout.ts';
import { createPostgresControlPlaneStore } from '../control/control-store.ts';
import { createBrainProvisioner } from '../control/provisioner.ts';
import { controlPlaneIdentity, fleetIdentity } from '../control/secrets.ts';
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
    severance: severancePort(secrets),
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
 * U18's severance flow, given the caller it did not have.
 *
 * **The defect this closes.** `severOrigin` was correct, tested and imported by
 * nothing outside its own test; `app.ts` declared `SeverancePort` and no
 * composition root supplied one, so `/api/severance` and its preview answered
 * `501 unavailable` in every deployment. A destructive operation that cannot be
 * performed is a smaller problem than one that lies, which is why the app fails
 * closed on an absent port — but the port has to exist somewhere, and this is
 * the process that owns both halves it needs.
 *
 * **Why the fleet identity is constructed here and not in `app.ts`.** R11 says
 * the web-app identity holds no resolve permission on any tenant namespace, and
 * that stays true: `app.ts` is handed this interface and never the store, so
 * nothing reachable from a request handler can name a namespace or read a
 * connection string. The composition root already holds the store — it builds
 * the write-only BYOK port and the provisioner out of it — and the tenant id it
 * resolves against arrives from `account.brain`, the authenticated mapping,
 * never from request input. That is the same constraint
 * `src/worker/serve.ts` satisfies when it opens a tenant's database to
 * consolidate it, by the same construction.
 *
 * **A connection per call, closed in a `finally`.** Severance is a rare,
 * user-initiated request rather than a loop, so a pool held open for it would be
 * a connection per tenant this process has ever severed for — and the per-tenant
 * LRU those handles come out of is the reason `worker/serve.ts` honours `close`.
 */
function severancePort(secrets: FleetSecrets): SeverancePort {
  async function withTenant<T>(tenantId: string, work: (sql: SQL) => Promise<T>): Promise<T> {
    const resolved = await secrets.store.resolve(fleetIdentity(tenantId), tenantId);
    if (!resolved.ok) {
      // Thrown rather than reported as a refusal: "this brain's connection
      // string is unresolvable" is an outage, and answering the user `400
      // not_confirmed` for it would send them round the confirmation again
      // forever. The entrypoint's error boundary turns it into a generic 500
      // and writes the reason to stderr, where an operator is.
      throw new Error(
        `no resolvable connection secret for ${tenantId} (${resolved.reason}); this process cannot sever for it`,
      );
    }
    const sql = new SQL(resolved.secret.connectionString, { max: 2 });
    try {
      return await work(sql);
    } finally {
      await sql.close();
    }
  }

  return {
    preview: (request) =>
      withTenant(request.tenantId, async (sql) => {
        const preview = await previewSeverance(sql, { origin: request.origin });
        return {
          removed: { ...preview.removed },
          recomputed: { ...preview.recomputed },
          recomputeRequired: preview.recomputeRequired,
          survivingOrigins: preview.survivingOrigins,
        };
      }),
    execute: (request) =>
      withTenant(request.tenantId, async (sql) => {
        // The confirmation is passed through rather than re-derived. `app.ts`
        // checks it too, and deliberately: the echo is the control, and a
        // control checked in exactly one place is one edit away from being
        // checked nowhere. `severOrigin` refuses on a mismatch before it opens
        // a transaction, so the second check costs a string comparison.
        const outcome = await severOrigin(sql, {
          origin: request.origin,
          confirm: request.confirm,
          now: new Date(),
        });
        return outcome.ok
          ? {
              ok: true as const,
              severanceId: outcome.receipt.severanceId,
              alreadySevered: outcome.receipt.alreadySevered,
            }
          : { ok: false as const, reason: outcome.reason };
      }),
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
