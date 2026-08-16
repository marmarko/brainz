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

import {
  createWebApp,
  type ConnectorVendor,
  type ProviderKeyWriter,
  type SeverancePort,
  type SubjectErasurePort,
} from './app.ts';
import { createTenantProviderKeyStore, type ProviderId } from '../ai/keys.ts';
import { previewSeverance } from '../core/lifecycle/blast-radius.ts';
import { severOrigin } from '../core/lifecycle/severance.ts';
import { eraseSubject, previewSubjectErasure } from '../core/lifecycle/subject-erasure.ts';
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

  // One resolver for both tenant-side ports, so "how this process reaches a
  // brain" has one implementation rather than two that can drift on the
  // question R11 cares about — which identity resolves the namespace, and where
  // the tenant id came from.
  const withTenant = tenantDatabases(secrets);

  const handle = createWebApp({
    sql,
    controlSql,
    origin: appOrigin,
    mcpUrl: required(env, 'BRAINZ_MCP_URL'),
    stripeWebhookSecret: required(env, 'BRAINZ_STRIPE_WEBHOOK_SECRET'),
    byok: writeOnlyProviderKeys(secrets),
    connectors: connectorVendor(),
    severance: severancePort(withTenant),
    subjectErasure: subjectErasurePort(withTenant),
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
 * Running one piece of work against one tenant's own database.
 *
 * **Why the fleet identity is constructed here and not in `app.ts`.** R11 says
 * the web-app identity holds no resolve permission on any tenant namespace, and
 * that stays true: `app.ts` is handed the ports below and never the store, so
 * nothing reachable from a request handler can name a namespace or read a
 * connection string. The composition root already holds the store — it builds
 * the write-only BYOK port and the provisioner out of it — and the tenant id it
 * resolves against arrives from `account.brain`, the authenticated mapping,
 * never from request input. That is the same constraint
 * `src/worker/serve.ts` satisfies when it opens a tenant's database to
 * consolidate it, by the same construction.
 *
 * **A connection per call, closed in a `finally`.** Severance and subject
 * erasure are rare, user-initiated requests rather than loops, so a pool held
 * open for them would be a connection per tenant this process has ever acted
 * for — and the per-tenant LRU those handles come out of is the reason
 * `worker/serve.ts` honours `close`.
 *
 * **One resolver, two ports.** This was inside `severancePort` until
 * {@link subjectErasurePort} needed the same thing. Two copies of "resolve a
 * namespace under the fleet identity and open a connection" are two places for
 * the R11 constraint to be true, and only one of them has to be edited for it
 * to stop being.
 */
interface TenantWork {
  <T>(tenantId: string, work: (sql: SQL) => Promise<T>): Promise<T>;
}

function tenantDatabases(secrets: FleetSecrets): TenantWork {
  return async function withTenant<T>(tenantId: string, work: (sql: SQL) => Promise<T>): Promise<T> {
    const resolved = await secrets.store.resolve(fleetIdentity(tenantId), tenantId);
    if (!resolved.ok) {
      // Thrown rather than reported as a refusal: "this brain's connection
      // string is unresolvable" is an outage, and answering the user `400
      // not_confirmed` for it would send them round the confirmation again
      // forever. The entrypoint's error boundary turns it into a generic 500
      // and writes the reason to stderr, where an operator is.
      throw new Error(
        `no resolvable connection secret for ${tenantId} (${resolved.reason}); this process cannot reach that brain`,
      );
    }
    const sql = new SQL(resolved.secret.connectionString, { max: 2 });
    try {
      return await work(sql);
    } finally {
      await sql.close();
    }
  };
}

/**
 * U18's severance flow, given the caller it did not have.
 *
 * **The defect this closed.** `severOrigin` was correct, tested and imported by
 * nothing outside its own test; `app.ts` declared `SeverancePort` and no
 * composition root supplied one, so `/api/severance` and its preview answered
 * `501 unavailable` in every deployment. A destructive operation that cannot be
 * performed is a smaller problem than one that lies, which is why the app fails
 * closed on an absent port — but the port has to exist somewhere, and this is
 * the process that owns both halves it needs.
 */
function severancePort(withTenant: TenantWork): SeverancePort {
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
 * R12's subject-scoped erasure, given the caller it did not have.
 *
 * **The defect this closes, which is the severance one a second time.**
 * `src/core/lifecycle/subject-erasure.ts` is complete: it resolves a
 * correspondent through the entity graph and the identifier as text, names every
 * row it will take, sweeps the three residue classes the 72h purge cannot reach,
 * and writes the re-ingestion tombstone. Its header says the erasure is
 * *"invocable by the controlling user, out of band"* and that the module
 * *"exports a function and registers no MCP tool"* — and the second half had
 * swallowed the first: `eraseSubject` and `previewSubjectErasure` were imported
 * by their own test and by nothing else in `src/`, so `app.ts`'s
 * `/api/subject-erasure` routes answered `501 unavailable` in every deployment.
 * A correspondent could ask, and the only way to answer them was to run a test
 * harness against somebody's brain. R12a is why the answer is not an MCP tool:
 * the assistant that would issue the erasure is the assistant reading the
 * correspondent's mail. Refusing to register that tool is only honest while some
 * other surface can perform it, and this is the process that owns it.
 *
 * **The echo is checked here as well as in the route.** `eraseSubject` takes no
 * confirmation of its own — it is the executor, and its caller is expected to
 * have obtained consent — so unlike `severOrigin` there is no third check
 * underneath this one. That makes the check here the last one, on the most
 * destructive operation this system performs against records about a third
 * party. `app.ts` checks it before the port is reached and this refuses again,
 * for the reason `severancePort` gives: a control checked in exactly one place
 * is one edit away from being checked nowhere.
 *
 * **No object store is passed, and the receipt says so rather than rounding
 * down.** `ErasableObjectStore` has no production implementation in `src/`
 * (`upstream/concepts.jsonl:gap.erasure-path` is where that is recorded), and
 * `rawKeyOf` may only come from the one accessor allowed to derive a raw key.
 * A run without either reports every raw payload and every stored attachment as
 * *unreachable* — counted, named on the receipt, and surfaced by the route —
 * which is what a data-subject answer needs in order to be true. Inventing a
 * key here would be a second key-derivation site, which `src/README.md` forbids
 * for exactly the reason that it would eventually disagree with the first.
 *
 * **The preview is projected, not passed through.** `SubjectMatch` carries the
 * page's `external_ref` and `origin_context` because the sweep needs them to
 * name a snapshot's document key; the port declares `{ pageId, handle }` and
 * that is what crosses, along with the row list minus its `objectKey`. What the
 * controller needs is which rows go and what text named her.
 */
function subjectErasurePort(withTenant: TenantWork): SubjectErasurePort {
  return {
    preview: (request) =>
      withTenant(request.tenantId, async (sql) => {
        const preview = await previewSubjectErasure(sql, { identifier: request.identifier });
        return {
          subjectDigest: preview.subjectDigest,
          entityIds: preview.entityIds,
          surfaceForms: preview.surfaceForms,
          pages: preview.matches.map((match) => ({ pageId: match.pageId, handle: match.handle })),
          rows: preview.rows.map((row) => ({
            kind: row.kind,
            id: row.id,
            excerpt: row.excerpt,
            handle: row.handle,
          })),
          removed: { ...preview.removed },
          recomputed: { ...preview.recomputed },
          recomputeRequired: preview.recomputeRequired,
        };
      }),
    execute: (request) => {
      // Before the connection, not after: an erasure whose confirmation does not
      // echo the identifier must not reach a brain at all, and a check inside
      // `withTenant` would already have resolved a namespace and opened one.
      if (request.confirm !== request.identifier) {
        return Promise.resolve({ ok: false as const, reason: 'not_confirmed' });
      }
      return withTenant(request.tenantId, async (sql) => {
        const receipt = await eraseSubject({ sql }, { identifier: request.identifier, erasedBy: 'app' });
        return {
          ok: true as const,
          // The digest, never the identifier. The receipt for an erasure must
          // not be the one place the address survives.
          subjectDigest: receipt.subjectDigest,
          removed: { ...receipt.removed },
          recomputeRequired: receipt.recomputeRequired,
          reingestionTombstoned: receipt.reingestionTombstoned,
          rawObjectsRemoved: receipt.rawObjectsRemoved,
          rawObjectsUnreachable: receipt.rawObjectsUnreachable,
          attachmentObjectsRemoved: receipt.attachmentObjectsRemoved,
          attachmentObjectsUnreachable: receipt.attachmentObjectsUnreachable,
          unrecoverableAfterDays: receipt.unrecoverableAfterDays,
          erasedAt: receipt.erasedAt,
        };
      });
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
