/**
 * The web app (U15): signup, login, subscription, connectors, spend, BYOK, and
 * the guided connect flow.
 *
 * **Shape, and the deviation it represents.** The roadmap files this under
 * `apps/web/`. It is here instead because `tsconfig.json` includes `src`, `test`
 * and `scripts` only, and this unit may not modify it — code under `apps/` would
 * be neither typechecked nor reachable by the guards that scan `src/**`, which is
 * a worse outcome than a differently-named directory. Adding a web app without
 * touching `package.json` also means no bundler and no framework, so the pages
 * are server-rendered from typed data (`src/web/pages.ts`) rather than compiled.
 * The API is the real deliverable; the pages are thin on purpose.
 *
 * **What this module is allowed to hold, which is the interesting part.**
 *
 *  * The identity database and the control plane. Both are its own.
 *  * A **write-only** port for tenant provider keys ({@link ProviderKeyWriter}).
 *    R22's BYOK entry has to write a key the user typed; it must never be able to
 *    read one back. The narrowing is the same one `provision.ts` gets from
 *    `TenantSecretWriter`, applied to the surface where the key arrives.
 *  * No secret store. The web-app identity holds no resolve permission on any
 *    tenant namespace (R11), and the way to keep that true is not to hand this
 *    module a store at all.
 *  * No model gateway, no tenant database handle, no object-storage accessor.
 *
 * **Credentials never come from a request.** The one exception looks like a
 * counter-example and is not: BYOK entry receives a provider key in a request
 * body, because there is no other way for a user to give us one. It is written
 * straight through to the secret store and never echoed, never logged, and never
 * read back — {@link byokStatus} answers "a key is set" and the last four
 * characters the caller just sent, from the request rather than from a store this
 * module cannot query.
 *
 * **CSRF.** `SameSite=Lax` on the session cookie refuses cross-site POSTs, and
 * every state-changing request additionally requires an `Origin` header equal to
 * the app's own. A state-changing request with **no** `Origin` is refused rather
 * than trusted — a header that is absent is not a header that agrees.
 */

import type { SQL } from 'bun';

import {
  ABSOLUTE_SESSION_MS,
  attachBrain,
  beginPasswordReset,
  brainOf,
  completePasswordReset,
  constantTimeEqual,
  createSession,
  logIn,
  normalizeEmail,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  signUpWithPassword,
  type HashCost,
} from '../control/accounts.ts';
import {
  effectiveTierOf,
  openFreeSubscription,
  subscriptionOf,
  type BillingTier,
} from '../control/billing.ts';
import { applyBillingEvent, recordCheckoutCustomer } from '../control/billing.ts';
import type { CheckoutPort } from '../control/checkout.ts';
import type { BrainProvisioner } from '../control/provisioner.ts';
import type { ProviderId } from '../ai/keys.ts';
import {
  fenceConnectorLink,
  markConnectPending,
  readConnectorLinks,
} from '../control/connector-pg.ts';
import { discardConnectorLanes } from '../control/connector-lanes.ts';
import type { ConnectorReconciler } from '../ingest/pipedream/reconcile.ts';
import type { JobTarget } from '../worker/jobs.ts';
import { reviveDeadLane } from '../worker/queue.ts';
import { CONNECT_STEPS, claudeCodeCommand, connectionStatus, installLink } from './connect.ts';
import { adminDispatch, createBrainOwnerDirectory } from './admin.ts';
import { connectorStatuses } from './connector-panel.ts';
import type { CoverageView } from './coverage.ts';
import type { ProcessingView } from './processing.ts';
import type { ReviewView } from './review.ts';
import type { EntityLookup, Roster } from './entity.ts';
import { BRAIN_SETUP_PATH, REVIEW_PATH, renderPage } from './pages.ts';

export const SESSION_COOKIE = 'bz_session';

/** Which connectors the product offers. The closed set the UI iterates. */
export const CONNECTOR_SOURCES = ['gmail', 'calendar', 'drive', 'contacts'] as const;
export type ConnectorSourceName = (typeof CONNECTOR_SOURCES)[number];

/** Providers a user may bring a key for (R22). */
export const BYOK_PROVIDERS = ['openai', 'google'] as const;

/**
 * Write-only access to a tenant's provider keys.
 *
 * Deliberately narrower than `TenantProviderKeyStore`: nothing reached through
 * this type can resolve a key. The implementation is the control plane's, and it
 * is the control plane that holds the write permission.
 */
export interface ProviderKeyWriter {
  put(tenantId: string, provider: ProviderId, key: string): Promise<{ readonly ok: boolean }>;
  revoke(tenantId: string, provider: ProviderId): Promise<{ readonly ok: boolean }>;
}

/** What the connector vendor can be asked to do on disconnect (R12 leg four). */
/**
 * Context severance, as a port (U18).
 *
 * **A port rather than a connection, because R11 forbids the alternative.** The
 * web-app identity cannot resolve a tenant connection string from the secret
 * store — that is the guard `test/control/accessor-boundary.test.ts` and U2's
 * `scope_denied` case exist for — so the tenant-side work of a severance runs
 * where tenant access legitimately lives and arrives here as an interface. Same
 * shape `ConnectorVendor` and `ProviderKeyWriter` already use, for the same
 * reason.
 *
 * **Two methods, and the split is the flow.** `preview` is a read the page
 * renders; `execute` re-runs that preview inside its own transaction and acts on
 * *that*, because the number a user consented to and the number that happened
 * are only the same number if nothing arrived in between.
 */
export interface SeverancePort {
  preview(request: {
    readonly tenantId: string;
    readonly origin: string;
  }): Promise<{
    readonly removed: Readonly<Record<string, number>>;
    readonly recomputed: Readonly<Record<string, number>>;
    readonly recomputeRequired: boolean;
    readonly survivingOrigins: readonly string[];
  }>;
  execute(request: {
    readonly tenantId: string;
    readonly origin: string;
    readonly confirm: string;
  }): Promise<
    | { readonly ok: true; readonly severanceId: string; readonly alreadySevered: boolean }
    | { readonly ok: false; readonly reason: string }
  >;
}

/**
 * Subject-scoped erasure (R12), as a port — and the reason it is on this
 * surface and not on `tools/call`.
 *
 * U15's controller/processor determination (§6.3) fixes four properties for
 * `src/core/lifecycle/subject-erasure.ts`, and the third is that it must be
 * **invocable by the controlling user, out of band**. R12a's rule is the whole
 * argument: the assistant that would issue the erasure is the assistant reading
 * the correspondent's mail, so an MCP tool would put the request and the
 * material it is about behind one credential. The web app is the out-of-band
 * surface this product has, and until this route existed `eraseSubject` had no
 * caller anywhere in `src/` — a correspondent could ask, and nothing in the
 * running system could answer them.
 *
 * **A port for the reason {@link SeverancePort} is one.** The sweep runs
 * against the tenant's own database and R11 forbids this module from resolving
 * a connection string, so the tenant-side half lives where tenant access
 * legitimately lives and arrives here as an interface.
 *
 * **Two methods, and the split is the mitigation.** The module's stated defence
 * against a widened text sweep is the *flow* — the controller reads a preview
 * that names every row rather than counting them, and only then instructs. A
 * shape with one method would make erasure invocable without the preview, which
 * that module's header says re-opens the hazard.
 */
export interface SubjectErasurePort {
  preview(request: { readonly tenantId: string; readonly identifier: string }): Promise<{
    readonly subjectDigest: string;
    readonly entityIds: readonly string[];
    readonly surfaceForms: readonly string[];
    readonly pages: readonly { readonly pageId: string; readonly handle: string }[];
    readonly rows: readonly {
      readonly kind: string;
      readonly id: string;
      readonly excerpt: string;
      readonly handle: string;
    }[];
    readonly removed: Readonly<Record<string, number>>;
    readonly recomputed: Readonly<Record<string, number>>;
    readonly recomputeRequired: boolean;
  }>;
  execute(request: {
    readonly tenantId: string;
    readonly identifier: string;
    readonly confirm: string;
  }): Promise<
    | {
        readonly ok: true;
        readonly subjectDigest: string;
        readonly removed: Readonly<Record<string, number>>;
        readonly recomputeRequired: boolean;
        readonly reingestionTombstoned: boolean;
        readonly rawObjectsRemoved: number;
        readonly rawObjectsUnreachable: number;
        readonly attachmentObjectsRemoved: number;
        readonly attachmentObjectsUnreachable: number;
        readonly unrecoverableAfterDays: number;
        readonly erasedAt: string;
      }
    | { readonly ok: false; readonly reason: string }
  >;
}

/**
 * The undo, as a port — and the reason it is on this surface rather than on
 * `tools/call`.
 *
 * **The gap it closes.** `src/mcp/tombstone.ts:restoreForgotten` has been
 * complete and tested since R12 and had no production caller at all, while
 * `forget` told every user `recoverableUntil = now + 72h`. That was survivable
 * only while nothing hard-deleted; the retention lane is switched on, so the
 * promise on the receipt is now false rather than merely unimplemented.
 *
 * **A session, never a grant, and that is load-bearing rather than
 * incidental.** The listing is whole-brain and unfenced by construction — it
 * reads two ledgers rather than the rows themselves — so a caller holding a
 * credential instead of a session would see the *shape* of a retraction from an
 * origin that credential may not read. `tenantOf(session.accountId)` is the
 * only admission.
 *
 * **Why not an MCP tool, when the executor's sibling `forget` is one.** R12a's
 * argument for subject erasure is that the assistant issuing it is the assistant
 * reading the correspondent's mail; restore is the safe direction, so that
 * argument does not carry over unchanged. The one that does is asymmetry:
 * `severOrigin` requires an out-of-band session and a typed string echo, and an
 * agent-framed "yes" on a chat connection would reverse it — a control requiring
 * out-of-band consent to apply, undone by in-band consent. This repo already
 * refuses that shape for `set_context_policy`. Compounding it, `restoreForgotten`
 * takes no `Grant` at all, unlike every other write executor. The ledger's
 * `origin_contexts` is what would make a *forget-only* MCP restore fenceable
 * later — a subset check against one ledger row, with no fence added to the
 * executor and severance instants absent by construction — and that is a
 * deliberate deferral rather than an oversight.
 *
 * **Two methods, and the split is not severance's.** `SeverancePort` previews
 * because arrivals between consent and execution change the number. Nothing
 * arrives to change what carries an instant, so this reads a plural index rather
 * than a per-item preview — naming it one would promise a re-run that does not
 * happen.
 */
export interface RetractionPort {
  list(request: { readonly tenantId: string }): Promise<{
    readonly retractions: readonly {
      readonly deletedAt: string;
      readonly restorableUntil: string;
      readonly kind: 'record' | 'origin';
      readonly origins: readonly string[];
      readonly targetKind: string | null;
      readonly counts: Readonly<Record<string, number>>;
    }[];
    readonly overflowed: boolean;
    readonly ttlHours: number;
  }>;
  restore(request: {
    readonly tenantId: string;
    readonly deletedAt: string;
    readonly confirm: string;
  }): Promise<
    | {
        readonly ok: true;
        readonly restored: Readonly<Record<string, number>>;
        readonly unarchived: Readonly<Record<string, number>>;
        readonly supersededCards: number;
        readonly supersededAliases: number;
        /** True when the instant was a context severance. Changes the copy. */
        readonly wasOrigin: boolean;
        /** Every count zero: this instant has already been put back. */
        readonly alreadyRestored: boolean;
        /** When the window closes — present so an expiry can be named exactly. */
        readonly restorableUntil: string;
      }
    | {
        readonly ok: false;
        readonly reason: 'ttl_expired' | 'not_confirmed' | 'not_found';
        /** Set on `ttl_expired`: when the window closed. */
        readonly closedAt?: string;
      }
  >;
}

/**
 * What the brain holds, as counts — the first surface that shows a user their
 * own content rather than their plumbing.
 *
 * **The gap it closes.** The dashboard showed connectors and retractions and
 * nothing about the brain, so a user who connected three accounts and waited a
 * week could only find out whether it worked by asking the assistant a question
 * and judging the answer. A ten-hour ingest outage and a multi-day consolidation
 * freeze were both found by somebody reading SQL rather than by the person they
 * were happening to; the connector panel could not have caught either, because
 * it reads *attempts* and every attempt during the outage completed.
 *
 * **A session, never a grant, and the same argument `RetractionPort` makes.**
 * The view is whole-brain and unfenced by construction — it counts rows rather
 * than reading them — so `tenantOf(session.accountId)` is the only admission and
 * a credential must not reach it. What keeps that safe is the *type*:
 * {@link CoverageView}'s every field is a number, an instant, or a string from a
 * set the schema declares in a CHECK. `src/web/coverage.ts` carries the full
 * argument for that rule and the four reasons a name would break it.
 *
 * **One method, and no confirmation.** Nothing here destroys anything, so there
 * is no echo to check and no preview to be stale — the reason `SeverancePort`
 * has two methods does not carry over.
 */
export interface CoveragePort {
  read(request: { readonly tenantId: string }): Promise<CoverageView>;
  /**
   * The sibling view, on the same handle.
   *
   * **A method rather than a second port, and the argument is
   * `test/web/port-supply.test.ts`'s own.** That test exists because a
   * *declared* field can go unsupplied — the defect made three times, twice
   * shipped. A *method* cannot: `coveragePort` is annotated `: CoveragePort` in
   * `serve.ts` and supplied unconditionally there, so an unimplemented method is
   * a compile error rather than a `501` somebody discovers in production. A
   * `ProcessingPort` would add a fresh row to the exact risk class that test was
   * written to close, and would let a deployment be *half* able to read a brain
   * — a state with no meaning, since both reads go through one `withTenant`.
   *
   * **The cost property is unaffected**, because it is about which handler runs
   * and not about how many methods an interface has: `renderCoverage` calls
   * `read`, `renderProcessing` calls `readProcessing`, and neither pays for the
   * other. The read itself lives in `src/web/processing.ts` so coverage's
   * statement budget does not grow.
   *
   * `modelTier` is the READER's plan, never the newest run's `tier`, and it
   * decides whether the six phase counters are asked for at all.
   */
  readProcessing(request: {
    readonly tenantId: string;
    readonly modelTier: 'free' | 'paid';
  }): Promise<ProcessingView>;
}

/**
 * What is waiting on a decision, and the writes that close one.
 *
 * **Four methods on one port, never four sibling ports** — `CoveragePort`'s own
 * argument, one interface up: a declared port field can go unsupplied, while an
 * unimplemented method is a compile error rather than a `501` somebody discovers
 * in production.
 *
 * Absent renders the explanation rather than an empty queue. "Nothing is waiting
 * on you" and "this deployment cannot read your brain" are the two states this
 * page exists to tell apart, and a port-less render would print the first while
 * meaning the second.
 */
export interface ReviewPort {
  read(request: { readonly tenantId: string }): Promise<ReviewView>;

  decide(request: {
    readonly tenantId: string;
    readonly reviewId: string;
    readonly intent: 'apply' | 'dismiss';
    /** The live card the LISTING showed, or null when it showed none. */
    readonly seenCardId: string | null;
  }): Promise<
    | { readonly ok: true; readonly outcome: 'applied'; readonly hadPrior: boolean }
    | { readonly ok: true; readonly outcome: 'dismissed' }
    | { readonly ok: true; readonly outcome: 'target_gone' }
    | { readonly ok: true; readonly outcome: 'already_closed' }
    | {
        readonly ok: false;
        readonly reason:
          | 'no_apply_path'
          | 'needs_an_embedding'
          | 'needs_corroboration'
          | 'origin_severed'
          | 'too_long_to_read'
          | 'card_changed';
      }
  >;

  /** Everything this needs is derived from the review row. No card id crosses the wire. */
  undo(request: {
    readonly tenantId: string;
    readonly reviewId: string;
  }): Promise<
    | { readonly ok: true; readonly restored: boolean }
    | { readonly ok: false; readonly reason: 'nothing_to_undo' }
  >;

  resolve(request: {
    readonly tenantId: string;
    readonly reportId: string;
    readonly intent: 'left' | 'right' | 'both' | 'neither' | 'dismiss';
  }): Promise<
    | { readonly ok: true; readonly outcome: 'recorded' | 'dismissed' | 'already_closed' }
    | { readonly ok: false; readonly reason: 'not_adjudicable' }
  >;
}

/**
 * One named subject, as the owner's own record of them.
 *
 * **A sibling port rather than a method on `CoveragePort`, and that interface's
 * own docstring is the argument against doing it that way — so it is answered
 * rather than cited.** It refuses a second port because a declared field can go
 * unsupplied while a method cannot. What it also says is that what keeps
 * `?view=coverage` safe is *the type*: every field a number, an instant, or a
 * string from a CHECK. A name-bearing method destroys that property, and a port
 * whose methods sit on both sides of the privacy line has no safety property
 * left to state. So the discriminator is the line, not the count —
 * `readProcessing` is counts and belongs there; this crosses, so it is a
 * sibling, exactly as `ReviewPort` is. The risk that argument names is closed by
 * an executable guard instead: `test/web/port-supply.test.ts` fails the build
 * when a declared port has no supplier.
 *
 * Absent renders the explanation rather than an empty result: "nothing is known
 * about this person" and "this deployment cannot read your brain" are two
 * different sentences, and this is the page built to say which is true.
 */
export interface EntityLookupPort {
  read(request: { readonly tenantId: string; readonly name: string }): Promise<EntityLookup>;
  list(request: { readonly tenantId: string; readonly page: number }): Promise<Roster>;
}

export interface ConnectorVendor {
  mintClaimUrl(request: {
    readonly tenantId: string;
    readonly source: ConnectorSourceName;
  }): Promise<{ readonly claimUrl: string; readonly expiresAt: Date }>;
  disconnect(request: {
    readonly tenantId: string;
    readonly source: ConnectorSourceName;
  }): Promise<{ readonly deleted: boolean; readonly tokensRevoked: 'confirmed' | 'unverified' }>;
}

export interface WebAppDeps {
  /** The identity database (`src/control/account-schema.sql`). */
  readonly sql: SQL;
  /** The content-free control plane. */
  readonly controlSql: SQL;
  /** This app's own origin, for the CSRF check and for absolute links. */
  readonly origin: string;
  /** The fleet's `/mcp` URL, for the connect flow's install link. */
  readonly mcpUrl: string;
  readonly byok: ProviderKeyWriter;
  /**
   * The connector vendor. **Absent disables the connector routes rather than
   * faking them**, which is the rule `checkout` and `severance` already follow —
   * and a deployment without one is an ordinary state rather than a
   * misconfiguration: chat exports and folder imports (R8a) need no vendor, and
   * a self-hoster may never connect one.
   *
   * What it replaced is why the shape is this one. `src/web/serve.ts` used to
   * supply a vendor whose every method threw a bare `Error` from inside the
   * request, so the route answered a generic 500 — a deployment fact presented
   * to the user as an outage, and to the operator as a stack trace.
   */
  readonly connectors?: ConnectorVendor;
  /**
   * How this app learns that an authorization actually happened
   * (`src/ingest/pipedream/reconcile.ts`).
   *
   * **A port, and absent-able, for the reason `severance` is both.** It needs
   * the sealing key that opens the control plane's connector store, and R11's
   * rule about what a request handler may hold applies to that key exactly as it
   * applies to a connection string: this module records the *intent* to connect
   * (a timestamp) and clears a link on disconnect (a counter), and holds nothing
   * that can read a connector's cursor back.
   *
   * Absent disables one thing and only one: the dashboard stops reconciling on
   * render. It never disables the connect button, because the worker fleet's
   * tick is the path that does not depend on the user coming back at all — a
   * deployment with a vendor and no key is a deployment where connections are
   * still made, half an hour later.
   */
  readonly reconciler?: ConnectorReconciler;
  /**
   * How a signup becomes a brain (`src/control/provisioner.ts`).
   *
   * A port, for the reason `SeverancePort` and `ProviderKeyWriter` are ports:
   * provisioning resolves connection strings and claims pool projects under the
   * control-plane identity, and R11 says this module holds neither. It takes a
   * language and answers a tenant id; the mapping from account to tenant is
   * written here, in `account.brain`, because the identity database is the only
   * place that mapping is allowed to exist.
   */
  readonly provisioner: BrainProvisioner;
  /**
   * How a user starts paying (`src/control/checkout.ts`).
   *
   * Absent disables `/api/billing/checkout` rather than faking it — the same
   * rule `severance` follows, for a stronger reason: a route that answered with
   * a URL this process invented would send somebody to a page that takes no
   * money and record a customer the vendor has never heard of.
   */
  readonly checkout?: CheckoutPort;
  /**
   * U18's severance flow. Absent disables the routes rather than faking them:
   * an endpoint that answered `ok` for a severance nothing performed is the
   * `applied: true` lie one unit over, on an operation that is destructive.
   */
  readonly severance?: SeverancePort;
  /**
   * R12's subject-scoped erasure. Absent disables the routes for the reason
   * `severance` is absent-able: a `501` is a surface that admits it cannot do
   * the thing, and on an erasure the alternative — answering with a receipt
   * nothing performed — is the worst artifact this system could produce, because
   * it is handed to a third party as the answer to their request.
   */
  readonly subjectErasure?: SubjectErasurePort;
  /**
   * The 72-hour window's own surface. Absent disables the routes rather than
   * faking them — the rule `severance` follows, applied to the one operation
   * here that is *not* destructive, where the failure it prevents is the mirror
   * image: an endpoint that answered `ok` for a restore nothing performed would
   * tell a user their data is back when it is still tombstoned and counting
   * down to a purge.
   *
   * Supplied unconditionally by `src/web/serve.ts`, and
   * `test/web/port-supply.test.ts` fails if any port declared here is not.
   */
  readonly retractions?: RetractionPort;
  /**
   * What the brain holds, as counts. Absent renders the explanation rather than
   * zeroes — and here the rule bites harder than anywhere else it is applied: a
   * coverage page with no port would render `0 documents, 0 facts, 0 people`,
   * which is indistinguishable from an empty brain on the one page whose entire
   * job is telling those two states apart. A `501` that says the deployment
   * cannot read is the only honest absent-state this surface has.
   *
   * Supplied unconditionally by `src/web/serve.ts`, and
   * `test/web/port-supply.test.ts` fails if any port declared here is not.
   */
  readonly coverage?: CoveragePort;
  /**
   * What is waiting on a decision. Supplied unconditionally by `src/web/serve.ts`
   * in the same change that declares it — `test/web/port-supply.test.ts` fails
   * the build if any port declared here is not, and that test exists because
   * this repository shipped an unsupplied port three times.
   */
  readonly review?: ReviewPort;
  /** One named subject. Supplied unconditionally by `src/web/serve.ts`. */
  readonly entityLookup?: EntityLookupPort;
  /** The Stripe endpoint signing secret, resolved from the secret store. */
  readonly stripeWebhookSecret: string;
  /** Set for an operator deployment; absent disables `/admin` entirely. */
  readonly adminCredential?: string;
  readonly now?: () => Date;
  readonly hash?: HashCost;
  /** Where a reset mail would go. Absent in tests; the token is returned instead. */
  readonly sendMail?: (to: string, subject: string, body: string) => Promise<void>;
}

interface Session {
  readonly accountId: string;
}

// ---------------------------------------------------------------------------
// Cookies and CSRF.
// ---------------------------------------------------------------------------

export function readCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

/**
 * **`Max-Age` is the ABSOLUTE window, not the idle one.** The server enforces
 * idle expiry on every read (`resolveSession` has both bounds in its `WHERE`),
 * so a cookie whose own lifetime were the idle window would be deleted by the
 * browser at seven days however active the user had been — and the thirty-day
 * absolute bound would be a policy that never applies. The cookie carries the
 * outer bound; the server carries the inner one.
 */
export function sessionCookie(token: string, maxAgeSeconds: number): string {
  // `Lax` rather than `Strict`: the OAuth consent redirect and the billing
  // checkout return are both top-level cross-site navigations that have to
  // arrive authenticated. `Lax` permits those and refuses cross-site POSTs,
  // which is exactly the shape needed.
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/**
 * What a completed restore says, and the sentence a severance undo must carry.
 *
 * **`was_origin` is not decoration.** Restoring a severance instant returns the
 * rows; it does **not** reconnect the connector, does not undo the discard of
 * the queued `ingest_pull` jobs that severance performed, and does not touch the
 * vendor's tokens. Without the second sentence the button lies about its own
 * scope — the user reads "restored" and expects mail to resume.
 *
 * The replay case is named rather than dressed up as success: a second click on
 * an instant already put back changed nothing, and saying so is what makes the
 * gap between {@link restoreForgotten} and its bookkeeping honest instead of a
 * bug (see `markRetractionRestored`).
 */
export function restoreMessage(outcome: {
  readonly alreadyRestored: boolean;
  readonly wasOrigin: boolean;
}): string {
  if (outcome.alreadyRestored) {
    return 'That retraction has already been restored. Nothing changed.';
  }
  return outcome.wasOrigin
    ? 'Data restored. The account remains disconnected — reconnect it from Connectors if you want it polling again.'
    : 'Restored. It is searchable again.';
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

export function isFormPost(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').startsWith(FORM_CONTENT_TYPE);
}

/**
 * The languages the signup form offers.
 *
 * A short list rather than every Postgres text-search configuration: the field
 * is a choice a non-technical user makes about their own mail, and `pg_catalog`
 * names are not that. `simple` is offered last and honestly — it stems nothing,
 * which is the right answer for a brain in a language the others do not cover.
 */
export const FTS_LANGUAGE_CHOICES: readonly { readonly value: string; readonly label: string }[] = [
  { value: 'english', label: 'English' },
  { value: 'spanish', label: 'Spanish' },
  { value: 'french', label: 'French' },
  { value: 'german', label: 'German' },
  { value: 'portuguese', label: 'Portuguese' },
  { value: 'italian', label: 'Italian' },
  { value: 'dutch', label: 'Dutch' },
  { value: 'russian', label: 'Russian' },
  { value: 'simple', label: 'Something else (no word-stemming)' },
];

/**
 * The origin check. Returns a reason when the request must be refused.
 *
 * **Absent is refused, not trusted.** A state-changing request with no `Origin`
 * is the shape a form post from an old browser takes, and it is also the shape a
 * request forged through one takes; there is no way to tell them apart, and the
 * safe reading of "I cannot tell" is no.
 */
/**
 * The response headers the lookup page carries.
 *
 * Exported so `test/web/entity-route.test.ts` can pin the ABSENCE of a
 * `referrer-policy` — see the note at `renderEntityLookup` for the production
 * bug that absence fixes.
 */
export const ENTITY_HEADERS: Readonly<Record<string, string>> = { 'cache-control': 'no-store' };

export function sameOriginRefusal(request: Request, origin: string): string | null {
  if (!STATE_CHANGING.has(request.method)) return null;
  const presented = request.headers.get('origin');
  if (presented === null) return 'this request carries no Origin header';
  if (presented !== origin) return 'this request came from another origin';
  return null;
}

/**
 * Where a login lands, when something sent the user here mid-flow.
 *
 * **The one caller that matters is the OAuth consent hop.** `/authorize` on the
 * MCP fleet redirects an unauthenticated browser to `/login?next=/authorize?…`;
 * without this the user signs in, arrives at a dashboard, and the connection
 * they were halfway through authorising is simply gone — they have no way of
 * knowing it was ever in progress.
 *
 * **It is an allowlist of one shape, not a URL validator, and that is
 * deliberate.** A login form that redirects to a caller-supplied destination is
 * an open redirector: the classic use is a phishing link that passes through the
 * real sign-in page — same origin, real padlock, real form — and lands on the
 * attacker's. Every generic defence for that is a parser argument (`//evil.example`
 * is protocol-relative, `/\evil.example` is a path some browsers normalise into a
 * host, `%2F%2F` decodes after the check that read it). So this refuses
 * everything that is not literally the one path this product needs to return to.
 */
export const RETURN_PATH_PREFIX = '/authorize?';

export function returnPathAfterLogin(next: string | null): string | null {
  if (next === null) return null;
  return next.startsWith(RETURN_PATH_PREFIX) ? next : null;
}

// ---------------------------------------------------------------------------
// The app.
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * @param extra Headers this one page needs beyond the posture every page has.
 *
 *   **The policy itself is never widened here, and that is the ruling rather
 *   than an omission.** `form-action` is enforced by the document that *carries*
 *   the form — so the only policy that could permit a form post to reach the
 *   connector vendor is the dashboard's, which is rendered long before any
 *   vendor URL exists. `src/mcp/server.ts:htmlPage` can widen because it knows
 *   the registered callback's origin before it renders the consent form; this
 *   surface never does. So no connector page redirects: the vendor is reached
 *   by a link, which no shipped CSP directive governs.
 *
 *   What `extra` is for is the other half — `cache-control: no-store` and a
 *   page-local `referrer-policy` on the one page that carries a capability.
 */
function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The pages carry no third-party anything, so the policy can say so.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      'referrer-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  });
}

/**
 * What a provisioning refusal says, per caller.
 *
 * Two sentences rather than one because the two callers are in different
 * situations, and the difference is not cosmetic: the signup path answers
 * somebody who is not signed in and whose next step genuinely is to sign in,
 * while the retry answers somebody who is *already* signed in and looking at the
 * page — telling them to sign in is an instruction they cannot follow, on the
 * one screen where they are already stuck.
 */
const SIGNUP_PROVISIONING_UNAVAILABLE =
  'Your account exists, but we could not build your brain just now. Sign in and try again.';

const RETRY_PROVISIONING_UNAVAILABLE =
  'We could not build your brain just now. Nothing was half-built and nothing was charged — ' +
  'the fault is on our side. Try again in a few minutes; if it keeps failing, it will keep ' +
  'failing until we fix it, and your account is safe in the meantime.';

const LANGUAGE_REQUIRED = 'Choose the language your notes and mail are mostly written in.';

/**
 * The refusal a second press gets while the first is still working.
 *
 * Provisioning takes about fifteen seconds against a real substrate, which is
 * long enough that a user with no feedback presses again — and two presses that
 * both got through would claim two pool projects for one account: one brain the
 * account points at, one paid for and unreachable by anybody. The idempotent
 * read at the top of the retry does not cover this, because the second press
 * arrives *before* the first has written a row.
 */
const PROVISIONING_IN_PROGRESS =
  'A brain is already being built for this account, from a request a few seconds ago. This press ' +
  'did not start a second one and did not cancel the first. Give it fifteen seconds and reload ' +
  'this page.';

export function createWebApp(deps: WebAppDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());

  /**
   * Accounts with a provision in flight, for {@link PROVISIONING_IN_PROGRESS}.
   *
   * **In the process, and honest about it.** The edge routes every web path to
   * one named instance (`src/mcp/edge.ts:WEB_INSTANCE`), so within this
   * deployment's shape a set in this closure is the whole fleet. It is a guard
   * against a double-press, not a distributed lock: two web processes would need
   * the claim to live in the identity database, and the day that shape arrives
   * this is the line that has to change.
   *
   * **The alternative was worse than the bug.** Coalescing the second press onto
   * the first request's outcome would answer a user who chose German with a
   * brain built in French, and a language substituted silently is the one
   * failure KTD9 exists to refuse.
   */
  const building = new Set<string>();

  async function sessionOf(request: Request): Promise<Session | null> {
    const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
    if (token === null) return null;
    const outcome = await resolveSession(deps.sql, { token, now: now() });
    return outcome.ok ? { accountId: outcome.accountId } : null;
  }

  /** The tenant this account's brain lives in, or `null` before provisioning. */
  async function tenantOf(accountId: string): Promise<string | null> {
    const brain = await brainOf(deps.sql, accountId);
    return brain?.tenantId ?? null;
  }

  /**
   * Read a request body in either shape the app actually receives.
   *
   * A `fetch` sends JSON; an HTML form in `pages.ts` sends
   * `application/x-www-form-urlencoded`. A parser that only did the first
   * returned `{}` for every form post, so the login form answered
   * `invalid_credentials` forever — and a suite that only ever spoke JSON stayed
   * green through all of it. The pages are the product's front door, so the
   * router has to be able to read what they send.
   */
  async function body(request: Request): Promise<Record<string, unknown>> {
    if (isFormPost(request)) {
      try {
        return Object.fromEntries(new URLSearchParams(await request.text()).entries());
      } catch {
        return {};
      }
    }
    try {
      const parsed: unknown = await request.json();
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /**
   * A browser that posted a form wants a page, not a JSON body it will render as
   * text. 303 rather than 302 so the redirect is followed with GET.
   */
  function afterForm(
    request: Request,
    location: string,
    headers: Record<string, string>,
  ): Response | null {
    if (!isFormPost(request)) return null;
    return new Response(null, { status: 303, headers: { location, ...headers } });
  }

  function stringOf(source: Record<string, unknown>, name: string): string {
    const value = source[name];
    return typeof value === 'string' ? value : '';
  }

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- The webhook, first, and outside every cookie rule. ---------------
    //
    // It is authenticated by signature rather than by session, so the CSRF check
    // below must not touch it: a vendor POST carries no `Origin` and never will.
    if (path === '/api/billing/webhook' && request.method === 'POST') {
      const payload = await request.text();
      const outcome = await applyBillingEvent({
        sql: deps.sql,
        controlSql: deps.controlSql,
        payload,
        header: request.headers.get('stripe-signature') ?? '',
        secret: deps.stripeWebhookSecret,
        now: now(),
      });
      // A refusal is a 400, not a 401: the vendor retries on 5xx and gives up on
      // 4xx, and a forged delivery is not something we want retried.
      return outcome.ok ? json(outcome) : json(outcome, 400);
    }

    const refusal = sameOriginRefusal(request, deps.origin);
    if (refusal !== null) return json({ ok: false, code: 'forbidden', message: refusal }, 403);

    // ---- /admin. ----------------------------------------------------------
    if (path.startsWith('/admin')) return handleAdmin(request);

    // ---- Unauthenticated. -------------------------------------------------
    // These four render whether or not a session is present. A signed-in user
    // who follows "forgotten your password?" from a bookmark must reach the
    // page, not the router's 404 — and a reset link arrives in mail, which is
    // exactly where a stale session is likely to be sitting.
    if (path === '/login') {
      // The return path travels through the form as a hidden field, because the
      // form posts to `/api/login` and the query string on this page does not
      // survive that hop. Refused values become absent rather than an error: a
      // login page is not the place to explain that somebody's link was odd.
      const next = returnPathAfterLogin(url.searchParams.get('next'));
      return html(renderPage({ kind: 'login', ...(next === null ? {} : { next }) }));
    }
    if (path === '/signup') return html(renderPage({ kind: 'signup', languages: [...FTS_LANGUAGE_CHOICES] }));
    if (path === '/password/reset') return html(renderPage({ kind: 'reset_request' }));
    if (path === '/password/sent') return html(renderPage({ kind: 'reset_sent' }));
    if (path === '/password/complete') {
      return html(renderPage({ kind: 'reset_complete', token: url.searchParams.get('token') ?? '' }));
    }
    if (path === '/api/signup' && request.method === 'POST') return handleSignup(request);
    if (path === '/api/login' && request.method === 'POST') return handleLogin(request);
    if (path === '/api/password/reset' && request.method === 'POST') return handleBeginReset(request);
    if (path === '/api/password/complete' && request.method === 'POST') return handleCompleteReset(request);

    // ---- Everything below needs a session. --------------------------------
    const session = await sessionOf(request);
    if (session === null) {
      if (path === '/' || path === '/login') return html(renderPage({ kind: 'login' }));
      if (path.startsWith('/api/')) {
        return json({ ok: false, code: 'unauthenticated', message: 'Sign in first.' }, 401);
      }
      return new Response(null, { status: 302, headers: { location: '/login' } });
    }

    if (path === '/api/logout' && request.method === 'POST') return handleLogout(request);
    if (path === '/api/brain' && request.method === 'POST') return handleProvisionRetry(request, session);
    if (path === '/api/me') return handleMe(session);
    if (path === '/api/spend') return handleSpend(session);
    if (path === '/api/connect') return handleConnectInfo(session);
    if (path === '/api/connectors' && request.method === 'POST') return handleConnectors(request, session);
    if (path === '/api/connectors' && request.method === 'DELETE') {
      return handleDisconnect(request, session, await body(request));
    }
    if (path === '/api/byok' && request.method === 'POST') return handleByok(request, session);
    if (path === '/api/byok' && request.method === 'DELETE') return handleByokRevoke(request, session);
    if (path === '/api/billing/checkout' && request.method === 'POST') return handleCheckout(session);
    if (path === '/api/export-config') return handleExportConfig();
    if (path === '/api/severance/preview') return handleSeverancePreview(url, session);
    if (path === '/api/severance' && request.method === 'POST') {
      return handleSeverance(request, session);
    }
    if (path === '/api/subject-erasure/preview') return handleSubjectErasurePreview(url, session);
    if (path === '/api/subject-erasure' && request.method === 'POST') {
      return handleSubjectErasure(request, session);
    }
    if (path === '/api/retractions') return handleRetractions(session);
    if (path === '/api/restore' && request.method === 'POST') {
      return handleRestore(request, session);
    }
    if (path === '/api/review' && request.method === 'POST') {
      return handleReviewDecision(request, session);
    }
    if (path === '/api/contradictions' && request.method === 'POST') {
      return handleContradiction(request, session);
    }

    // ---- The pages. -------------------------------------------------------
    //
    // **An account with no brain is sent to the one page that can give it
    // one**, rather than shown a dashboard about a brain it does not have.
    // Every affordance on that dashboard — connectors, a provider key, spend, an
    // export — is an action whose route answers `no_brain_yet` 409, and the
    // connect flow behind it dead-ends at the MCP fleet's own no-brain page. A
    // page of dead buttons is what turned a recoverable state into a closed loop
    // for a real user: they read it as "there is nothing here for me" and
    // stopped looking, which is exactly what a page with nothing on it for them
    // says.
    //
    // The redirect runs both ways: an account that *has* a brain is not offered
    // a form to build a second one, so a stale bookmark or a back button lands
    // on the dashboard instead of on an affordance whose route would refuse it.
    // **Coverage is a query parameter on the dashboard rather than its own
    // path, and that is a deployment constraint rather than a design taste.**
    // `src/mcp/edge.ts` fronts this app with an *enumerated* set of web paths —
    // never a prefix, so that a new endpoint cannot become public merely by
    // being written — and a path missing from that set is `unrouted` at the
    // edge. A `/coverage` literal added here alone would 404 in every
    // deployment while passing every test in this file: the port-nobody-supplies
    // defect, relocated one layer up. A query parameter needs no entry, so the
    // page is reachable the moment it ships. Promoting it to `/coverage` (with
    // an `/api/coverage` twin) is a two-line addition to `WEB_PATHS`, and the
    // route-parity test in `test/mcp/router.test.ts` is what will hold the two
    // files together when somebody makes it.
    //
    // The default render is unchanged and still opens no tenant database: only
    // the deliberate click does, which is the whole cost argument for a separate
    // view. Tens of thousands of brains are suspended most of the time, and
    // waking one because its owner asked is defensible where waking one because
    // they logged in is not.
    if (path === '/' || path === '/dashboard') {
      // **The lookup posts rather than gets, and that is a deliberate
      // divergence.** A GET form writes every subject the owner ever looks up
      // into browser history and URL-bar autocomplete, which syncs across their
      // devices — after ten lookups, typing the dashboard URL renders ten names
      // in one dropdown. That is the artifact coverage.ts refuses, manufactured
      // outside the product by the product's own form, and `no-store` does not
      // clear it.
      if (request.method === 'POST') {
        const form = await body(request);
        if (form['view'] === 'entity') {
          return renderEntityLookup(session, typeof form['name'] === 'string' ? form['name'] : null);
        }
      }
      const view = url.searchParams.get('view');
      if (view === 'coverage') return renderCoverage(session);
      if (view === 'processing') return renderProcessing(session);
      if (view === 'review') return renderReview(session);
      if (view === 'settings') return renderSettings(session);
      // Idle: renders the form and opens no tenant database.
      if (view === 'entity') {
        // A page number in the query string carries nothing about anybody, so
        // paging is a GET. Opening a subject still posts their name in a body.
        const asked = Number.parseInt(url.searchParams.get('page') ?? '0', 10);
        return renderEntityLookup(session, null, Number.isNaN(asked) ? 0 : asked);
      }
      if (view === 'connectors') return renderConnectors(session);
      return renderDashboard(session);
    }
    if (path === '/brain') return renderBrainSetup(session);
    if (path === '/connect') return renderConnect(session);
    if (path === '/retractions') return renderRetractions(session);

    return json({ ok: false, code: 'not_found', message: 'No such page.' }, 404);

    // -----------------------------------------------------------------------

    async function handleAdmin(request: Request): Promise<Response> {
      // An operator deployment sets a credential. One that does not has no
      // `/admin` at all — an admin surface whose credential is unset is an admin
      // surface open to everybody, and the fail-closed direction is 404.
      const configured = deps.adminCredential;
      if (configured === undefined || configured.length === 0) {
        return json({ ok: false, code: 'not_found', message: 'No such page.' }, 404);
      }
      const presented = request.headers.get('authorization') ?? '';
      const offered = presented.startsWith('Bearer ') ? presented.slice(7) : presented;
      // **Constant time, through the one primitive written for it.** The
      // comparison this replaced short-circuited twice: a length test that
      // answered "how long is the operator credential" in a single request, and
      // then a `!==` that walks the bytes and stops at the first difference —
      // character-at-a-time recovery, on the endpoint that reads every tenant's
      // operational state. `accounts.ts:constantTimeEqual` digests both sides
      // first, so the comparison is over two equal-length buffers whatever
      // arrived and there is nothing left to time.
      //
      // **The unset check above must stay above this.** Digesting means
      // `constantTimeEqual('', '')` is true, so an empty bearer against an unset
      // credential would authenticate if the order were swapped — which is why
      // the fail-closed 404 is a separate, earlier statement rather than a
      // condition folded into this one.
      if (!constantTimeEqual(offered, configured)) {
        return json({ ok: false, code: 'unauthorized', message: 'No.' }, 401);
      }

      const name = url.searchParams.get('op') ?? '';
      const args = Object.fromEntries(url.searchParams.entries());
      // Everything the admin surface may do, and every refusal it owes, lives in
      // `admin.ts`. This handler carries no scope logic of its own — a second
      // place to decide what `/admin` may read is a second place to get it wrong.
      const result = await adminDispatch(
        {
          controlSql: deps.controlSql,
          // **The identity handle stops here.** `deps.sql` reaches every
          // account's address; what is handed across is a port that answers a
          // domain and a digest, so no `/admin` operation — this one or a later
          // one — is given a mailbox to publish. See `admin.ts:BrainOwnerDirectory`.
          owners: createBrainOwnerDirectory(deps.sql),
        },
        // `write` is the request's method and nothing else. The surface's write
        // operations refuse without it (`admin.ts:ADMIN_WRITE_OPERATIONS`), so a
        // grant cannot be issued by following a link.
        { name, args, write: request.method === 'POST', now: now() },
      );
      return result.ok ? json(result) : json(result, result.code === 'scope_denied' ? 403 : 400);
    }

    async function handleSignup(request: Request): Promise<Response> {
      const fields = await body(request);
      const email = stringOf(fields, 'email');
      const password = stringOf(fields, 'password');
      const ftsLanguage = stringOf(fields, 'fts_language');

      // KTD9's choice is made here, by the user, and has no default. A signup
      // that omitted it would be the silent anglicisation the plan forbids —
      // which is why this refuses rather than picking `english`.
      if (ftsLanguage.length === 0) {
        return json(
          {
            ok: false,
            code: 'fts_language_required',
            message: 'Choose the language your notes and mail are mostly written in.',
          },
          400,
        );
      }

      const created = await signUpWithPassword(deps.sql, {
        email,
        password,
        now: now(),
        ...(deps.hash === undefined ? {} : { hash: deps.hash }),
      });
      if (!created.ok) return json({ ok: false, code: created.reason }, 400);

      await openFreeSubscription(deps.sql, { accountId: created.accountId, now: now() });

      // **The brain, before the session.** A signup that answered `201` and
      // handed back a cookie without provisioning is the state this app shipped
      // in: the account existed, the language the user chose was validated and
      // discarded, and every later request that needed a tenant refused with
      // `no_brain_yet` — including the free-tier connector gate, which no caller
      // could ever reach. Provisioning is what makes a signup mean something, so
      // it happens here and its failure is reported rather than deferred to a
      // background job this system does not have.
      const brain = await provisionBrain(created.accountId, ftsLanguage);
      if (!brain.ok) {
        return json(
          { ok: false, code: 'provisioning_unavailable', message: SIGNUP_PROVISIONING_UNAVAILABLE },
          503,
        );
      }

      const session = await createSession(deps.sql, { accountId: created.accountId, now: now() });
      const cookie = { 'set-cookie': sessionCookie(session.token, Math.floor(ABSOLUTE_SESSION_MS / 1000)) };
      return (
        afterForm(request, '/connect', cookie) ??
        json(
          {
            ok: true,
            account_id: created.accountId,
            fts_language: ftsLanguage,
            tenant_id: brain.tenantId,
          },
          201,
          cookie,
        )
      );
    }

    /**
     * Provision, then record the link — in that order, and in the two databases
     * each half belongs to.
     *
     * The tenant is the control plane's and the *mapping* is the identity
     * store's; there is no distributed transaction between them and there is not
     * meant to be. If the link write loses (`tenant_in_use` — a tenant id
     * already claimed by another account), the provisioned tenant is orphaned
     * rather than handed to the wrong owner, which is the direction that cannot
     * produce a cross-account brain. The unique index on `account.brain.tenant_id`
     * is what makes "one brain, one owner" a database fact.
     */
    async function provisionBrain(
      accountId: string,
      ftsLanguage: string,
    ): Promise<{ readonly ok: true; readonly tenantId: string } | { readonly ok: false }> {
      // The reason is never echoed to either caller. It names substrate and pool
      // state, which is deployment shape rather than something the person on the
      // other end can act on, and this is a public origin. The operator's copy
      // goes to stderr in `serve.ts:reportedProvisioner`.
      const provisioned = await deps.provisioner.provision({ ftsLanguage });
      if (!provisioned.ok) return { ok: false };

      const linked = await attachBrain(deps.sql, {
        accountId,
        tenantId: provisioned.tenantId,
        ftsLanguage,
        now: now(),
      });
      if (!linked.ok) return { ok: false };
      return { ok: true, tenantId: provisioned.tenantId };
    }

    /**
     * The retry, for an account whose signup provisioned nothing.
     *
     * Without it the 503 above is terminal: the email is taken, the password
     * works, and there is no route that can ever give that account a brain. It
     * is idempotent by reading `account.brain` first — a second call must not
     * spend a second pool project on an account that already has one.
     *
     * **It answers a browser and a `fetch` differently, and it has to.** The
     * page at {@link BRAIN_SETUP_PATH} is a plain HTML form, because the app's
     * own content-security policy carries no `script-src` and a scripted submit
     * would be blocked by it. So a form post that answered with `{"ok":false,…}`
     * would render that object as text in a browser window: the user who has
     * already had one thing fail is handed a body, on a page with no way back to
     * the form. Form posts therefore get a page and a redirect; JSON callers get
     * the typed body they have always got, unchanged
     * (`test/fleet/signup.test.ts` is one of them).
     */
    async function handleProvisionRetry(request: Request, session: Session): Promise<Response> {
      const existing = await brainOf(deps.sql, session.accountId);
      if (existing !== null) {
        // A press that arrives after the brain exists is not an error — it is
        // the second half of a double-submit, or a refresh. The browser goes to
        // the dashboard, which is now a page about something real.
        return (
          afterForm(request, '/dashboard', {}) ??
          json({ ok: true, tenant_id: existing.tenantId, created: false })
        );
      }

      // **The language is asked again rather than remembered.** A signup whose
      // provisioning failed recorded no `account.brain` row, and that row is the
      // only place the choice is kept — deliberately, because the choice belongs
      // to the brain. So the retry re-asks and refuses without an answer; a
      // retry that defaulted here would be KTD9's silent anglicisation arriving
      // through the back door, on exactly the accounts nobody is watching.
      const chosen = stringOf(await body(request), 'fts_language');
      if (chosen.length === 0) {
        return refusedBuild(request, 'fts_language_required', LANGUAGE_REQUIRED, 400);
      }

      if (building.has(session.accountId)) {
        return refusedBuild(request, 'provisioning_in_progress', PROVISIONING_IN_PROGRESS, 409);
      }

      building.add(session.accountId);
      let brain;
      try {
        brain = await provisionBrain(session.accountId, chosen);
      } finally {
        // In a `finally` so a provisioner that throws leaves the account able to
        // try again. A guard that can wedge an account is a worse bug than the
        // one it prevents.
        building.delete(session.accountId);
      }

      if (!brain.ok) {
        return refusedBuild(request, 'provisioning_unavailable', RETRY_PROVISIONING_UNAVAILABLE, 503);
      }
      // Where signup lands, for the same reason: a brain nothing is connected to
      // is not yet the product.
      return (
        afterForm(request, '/connect', {}) ??
        json({ ok: true, tenant_id: brain.tenantId, created: true }, 201)
      );
    }

    /**
     * One refusal, in the two shapes its two kinds of caller can read.
     *
     * The page is re-rendered with the problem on it rather than redirected to,
     * so the status code survives — a browser that was told `303` would report a
     * failed provision as a success in every log and every dev tools panel — and
     * so the form is one press away rather than a back button.
     */
    function refusedBuild(
      request: Request,
      code: string,
      message: string,
      status: number,
    ): Response {
      if (isFormPost(request)) return html(brainSetupPage(message), status);
      return json({ ok: false, code, message }, status);
    }

    async function handleLogin(request: Request): Promise<Response> {
      const fields = await body(request);
      const outcome = await logIn(deps.sql, {
        email: stringOf(fields, 'email'),
        password: stringOf(fields, 'password'),
        now: now(),
        ...(deps.hash === undefined ? {} : { hash: deps.hash }),
      });
      if (!outcome.ok) return json({ ok: false, code: outcome.reason }, 401);

      // A fresh session id on every login. Session fixation is the attack, and a
      // login that reused a caller-supplied cookie is how it lands.
      const session = await createSession(deps.sql, { accountId: outcome.accountId, now: now() });
      const cookie = { 'set-cookie': sessionCookie(session.token, Math.floor(ABSOLUTE_SESSION_MS / 1000)) };
      // Back to whatever sent them here, when that is the one destination this
      // app returns to — see `returnPathAfterLogin`. Anything else, including
      // anything absolute, becomes the dashboard rather than a refusal.
      const next = returnPathAfterLogin(stringOf(fields, 'next'));
      return afterForm(request, next ?? '/dashboard', cookie) ?? json({ ok: true }, 200, cookie);
    }

    async function handleLogout(request: Request): Promise<Response> {
      const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
      if (token !== null) await revokeSession(deps.sql, token);
      const cleared = { 'set-cookie': clearedSessionCookie() };
      return afterForm(request, '/login', cleared) ?? json({ ok: true }, 200, cleared);
    }

    async function handleBeginReset(request: Request): Promise<Response> {
      const fields = await body(request);
      const begun = await beginPasswordReset(deps.sql, {
        email: stringOf(fields, 'email'),
        now: now(),
      });
      if (begun.token !== null && deps.sendMail !== undefined) {
        await deps.sendMail(
          normalizeEmail(stringOf(fields, 'email')) ?? '',
          'Reset your brainz password',
          `${deps.origin}/password/complete?token=${encodeURIComponent(begun.token)}`,
        );
      }
      // **Identical either way.** A reset endpoint that answered differently for
      // an unknown address is a free account-enumeration oracle, reachable
      // without the account holder doing anything.
      return (
        afterForm(request, '/password/sent', {}) ??
        json({ ok: true, message: 'If that address has an account, a reset link is on its way.' })
      );
    }

    async function handleCompleteReset(request: Request): Promise<Response> {
      const fields = await body(request);
      const done = await completePasswordReset(deps.sql, {
        token: stringOf(fields, 'token'),
        password: stringOf(fields, 'password'),
        now: now(),
        ...(deps.hash === undefined ? {} : { hash: deps.hash }),
      });
      if (!done.ok) return json({ ok: false, code: done.reason }, 400);
      // Every session went with the reset; the browser holding one now gets a
      // cleared cookie rather than a dead one it will keep presenting.
      await revokeAllSessions(deps.sql, done.accountId);
      return json({ ok: true }, 200, { 'set-cookie': clearedSessionCookie() });
    }

    async function handleMe(session: Session): Promise<Response> {
      const subscription = await subscriptionOf(deps.sql, session.accountId);
      const brain = await brainOf(deps.sql, session.accountId);
      return json({
        ok: true,
        tier: subscription.tier,
        status: subscription.status,
        current_period_end: subscription.currentPeriodEnd,
        brain: brain === null ? null : { tenant_id: brain.tenantId, fts_language: brain.ftsLanguage },
      });
    }

    async function handleSpend(session: Session): Promise<Response> {
      const tenantId = await tenantOf(session.accountId);
      // `null`, not zero. An account whose brain has not been provisioned has no
      // spend to report, which is a different sentence from "you have spent
      // nothing" — and a literal here would be a price named outside
      // `src/ai/pricing.ts`, which `test/ai/price-drift.test.ts` refuses on
      // sight. It is right to: the drift guard cannot tell a placeholder from a
      // rate, and the discipline is only worth having if it has no exceptions.
      if (tenantId === null) {
        return json({ ok: true, spend_micro_usd: null, pending_debt: null, brain: null });
      }

      const rows = await deps.controlSql<
        {
          spend_micro_usd: string;
          spend_window_started_at: Date;
          spend_cap_micro_usd: string | null;
          pending_debt: number;
          last_cycle_at: Date | null;
        }[]
      >`
        SELECT spend_micro_usd, spend_window_started_at, spend_cap_micro_usd, pending_debt, last_cycle_at
        FROM control.tenant WHERE tenant_id = ${tenantId}`;
      const row = rows[0];
      return json({
        ok: true,
        spend_micro_usd: Number(row?.spend_micro_usd ?? 0),
        spend_window_started_at: row?.spend_window_started_at ?? null,
        spend_cap_micro_usd: row?.spend_cap_micro_usd === undefined || row.spend_cap_micro_usd === null
          ? null
          : Number(row.spend_cap_micro_usd),
        // R8's upgrade prompt reads the deterministic debt counter, never a
        // contradiction count — that is a paid artifact the free tier cannot see.
        pending_debt: row?.pending_debt ?? 0,
        last_cycle_at: row?.last_cycle_at ?? null,
      });
    }

    async function handleConnectInfo(session: Session): Promise<Response> {
      const tenantId = await tenantOf(session.accountId);
      const status =
        tenantId === null
          ? { state: 'never_connected' as const, firstSeenAt: null, lastSeenAt: null }
          : await connectionStatus(deps.controlSql, tenantId);
      return json({
        ok: true,
        install_link: installLink({ mcpUrl: deps.mcpUrl }),
        organization_install_link: installLink({ mcpUrl: deps.mcpUrl, surface: 'organization' }),
        claude_code_command: claudeCodeCommand(deps.mcpUrl),
        steps: CONNECT_STEPS,
        connection: status,
      });
    }

    /**
     * The refusal a deployment with no connector vendor owes, and it comes
     * **before** the tier gate.
     *
     * The order is the whole of it. `connectorGate` answers `402 tier_required`
     * with copy that asks the user to pay, and on a deployment holding no vendor
     * credential no amount of paying makes a connector work — so tier-first
     * charges somebody for a capability the deployment does not have, and they
     * only learn otherwise on the retry after they have paid. Vendor-first says
     * the true thing first. On a deployment that *is* configured this changes
     * nothing: the check passes and the tier gate is the answer, which is what
     * `test/fleet/signup.test.ts` observes.
     */
    function connectorUnavailable(request: Request): Response {
      return refusedConnector(
        request,
        'unavailable',
        'Connectors are unavailable here',
        'This deployment has no connector vendor configured, so connected accounts are not ' +
          'available on it. Chat exports and folder imports need no connection.',
        501,
      );
    }

    /**
     * One connector refusal, in the two shapes its two kinds of caller can read.
     *
     * `refusedBuild` one section over, for the reason its own comment gives: a
     * form post answered with `{"ok":false,…}` renders that object as text in a
     * browser window. The status is preserved rather than redirected away from,
     * so a refusal is not logged as a success.
     */
    function refusedConnector(
      request: Request,
      code: string,
      heading: string,
      message: string,
      status: number,
    ): Response {
      if (isFormPost(request)) {
        return html(renderPage({ kind: 'connector_notice', heading, message }), status);
      }
      return json({ ok: false, code, message }, status);
    }

    /**
     * `POST /api/connectors`, for both of the things a page can ask it.
     *
     * **An HTML form can send GET and POST and nothing else**, so `DELETE` — the
     * verb the API has always used to disconnect — is unreachable from the
     * product's own front door. The intent travels in the body instead, as the
     * `name`/`value` of whichever submit button was pressed; a browser sends
     * exactly one of those and never the other.
     *
     * **An absent intent is a connect.** A form submitted with the Enter key
     * sends no submit button at all, and every JSON caller that predates this
     * sends `{source}` alone. The default has to be the half that revokes
     * nothing.
     *
     * The body is read **here**, once, and handed down: `Request` bodies are
     * single-use streams, so a dispatcher that re-read it in each arm would give
     * the second arm an empty object.
     */
    async function handleConnectors(request: Request, session: Session): Promise<Response> {
      const fields = await body(request);
      const intent = stringOf(fields, 'intent');
      if (intent === 'disconnect') return handleDisconnect(request, session, fields);
      if (intent === 'retry') return handleRetry(request, session, fields);
      if (intent !== '' && intent !== 'connect') {
        return refusedConnector(
          request,
          'unknown_intent',
          'That is not something this page can do',
          'A connector control asks to connect or to disconnect, and this asked for neither. ' +
            'Nothing was changed.',
          400,
        );
      }
      return handleConnect(request, session, fields);
    }

    /**
     * Whether a URL the vendor answered is one this app is willing to put behind
     * an `href`.
     *
     * **`escapeHtml` is not this check and cannot be.** There is nothing to
     * escape in `javascript:alert(1)` — it survives every one of the five
     * replacements intact and lands in the attribute exactly as written. The
     * scheme is the control, and it is applied to the one string on these pages
     * that a third party chooses.
     */
    function isFollowableLink(url: string): boolean {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
      } catch {
        return false;
      }
    }

    /**
     * `intent=retry` — the way back from a dead lane, for the person it happened
     * to.
     *
     * **Why this exists beside the operator's `requeue_connector`.** Both clear
     * the same wreckage, and they are for different people. The operator's is
     * for a fleet-wide defect: one of ours shipped, dead-lettered every affected
     * brain's connectors, and got fixed — nobody should have to ask each of
     * those users to re-consent at their provider to recover from our bug. This
     * one is for the single user staring at a connector that stopped, who
     * currently has exactly one remedy on this page and it costs them a trip
     * through a consent screen they already completed once.
     *
     * **It reaches no vendor and needs none.** Nothing here revokes, mints or
     * asks: it moves one row in the control plane from `dead` back to `due`. So
     * unlike connect and disconnect it does *not* refuse on a deployment with no
     * connector credential — a fleet that lost its vendor configuration is
     * exactly the fleet whose lanes are full of dead letters, and a recovery
     * that requires the broken thing to be working is not a recovery.
     *
     * **The tier gate is not applied either**, and that is the same argument
     * once more: a lane can only be dead because it was polling, which means it
     * was inside the gate when it was created. Refusing to *un-break* something
     * a downgrade left behind would leave a permanent red line on a page with no
     * control that clears it.
     *
     * `reviveDeadLane` decides, in one statement, whether there was anything to
     * revive. This function does not look first — two presses of the button
     * would both find the same row.
     */
    async function handleRetry(
      request: Request,
      session: Session,
      fields: Record<string, unknown>,
    ): Promise<Response> {
      const source = stringOf(fields, 'source');
      if (!(CONNECTOR_SOURCES as readonly string[]).includes(source)) {
        return refusedConnector(
          request,
          'unknown_source',
          'No such connector',
          'This brain does not offer a connector by that name.',
          400,
        );
      }

      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) {
        return refusedConnector(
          request,
          'no_brain_yet',
          'This account has no brain yet',
          'There is no brain here whose checks could be restarted.',
          409,
        );
      }

      const outcome = await reviveDeadLane(deps.controlSql, {
        tenantId,
        kind: 'ingest_pull',
        target: source as JobTarget,
        now: now(),
      });

      // **Both answers are `ok`, and the copy is what differs.** "There was
      // nothing dead here" is not an error — it is what a second press, a
      // reconnect in another tab, or an operator who got there first all look
      // like, and answering 4xx to any of them would tell the user something
      // went wrong when what happened is that they are already fine.
      if (isFormPost(request)) {
        return html(
          renderPage({
            kind: 'connector_notice',
            heading: outcome.revived ? `Checking ${source} again` : `Nothing to restart`,
            message: outcome.revived
              ? `The checks for ${source} are queued again, from the beginning. The first one runs ` +
                `on this brain's next wake, which is within about half an hour — nothing was ` +
                `disconnected and you did not need to authorize anything again.`
              : `Nothing here had stopped. ${source} is either being checked already or was ` +
                `restarted a moment ago, so there was nothing for this to do.`,
          }),
        );
      }
      return json({
        ok: true,
        revived: outcome.revived,
        ...(outcome.revived ? {} : { reason: outcome.reason }),
      });
    }

    async function handleConnect(
      request: Request,
      session: Session,
      fields: Record<string, unknown>,
    ): Promise<Response> {
      const source = stringOf(fields, 'source');
      if (!(CONNECTOR_SOURCES as readonly string[]).includes(source)) {
        return refusedConnector(
          request,
          'unknown_source',
          'No such connector',
          'This brain does not offer a connector by that name.',
          400,
        );
      }

      const vendor = deps.connectors;
      if (vendor === undefined) return connectorUnavailable(request);

      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) {
        return refusedConnector(
          request,
          'no_brain_yet',
          'This account has no brain yet',
          'A connector attaches an account to a brain, and there is not one here to attach it to.',
          409,
        );
      }

      const subscription = await subscriptionOf(deps.sql, session.accountId);
      const gate = connectorGate(await effectiveTierOf(deps.controlSql, tenantId, subscription.tier));
      if (gate !== null) {
        // The dashboard renders no control for a gated account, so reaching this
        // means the tier changed under a page that was already open. The honest
        // reason travels, not "upgrade for more".
        return isFormPost(request)
          ? html(
              renderPage({
                kind: 'connector_notice',
                heading: 'Connected accounts are on the paid plan',
                message: gate.message,
              }),
              402,
            )
          : json(gate, 402);
      }

      const minted = await vendor.mintClaimUrl({
        tenantId,
        source: source as ConnectorSourceName,
      });

      if (!isFollowableLink(minted.claimUrl)) {
        // A vendor answer this app will not render as a link, and will not pass
        // on as one either. 502 rather than 500: the fault is upstream and the
        // operator reading it should look there.
        return refusedConnector(
          request,
          'unusable_claim_url',
          'The connector vendor answered something unusable',
          'The vendor returned a connect link this app will not follow. Nothing was connected. ' +
            'Try again in a few minutes.',
          502,
        );
      }

      // **The intent is recorded here, and this is the load-bearing line in the
      // whole flow.** The user is about to leave for the vendor's consent screen
      // and owes this origin nothing afterwards: they can authorize and close
      // the tab. This row is what lets the fleet go and *ask* the vendor later
      // which accounts exist under this tenant's external user — the channel
      // that survives a browser that never comes home.
      //
      // After the mint, so a vendor that refused leaves nothing to look for; and
      // before the link is handed over, so the record is durable before the user
      // can act on it. A failure here is a throw into the entrypoint's boundary
      // rather than a link the founder follows into silence.
      await markConnectPending(deps.controlSql, {
        tenantId,
        source: source as ConnectorSourceName,
        now: now(),
      });

      // The claim URL is a capability, not display copy: whoever holds it can
      // attach *their* mailbox to *this* brain. It is returned once, to the
      // authenticated owner, and is never logged.
      //
      // **A browser gets a page, not a redirect.** See `html`'s note: the
      // dashboard's `form-action 'self'` governs this submission and cannot name
      // an origin that did not exist when it was rendered. The page carries the
      // link, `no-store` so nothing keeps it, and `no-referrer` so following it
      // tells the vendor nothing about where it came from.
      if (isFormPost(request)) {
        return html(
          renderPage({
            kind: 'connector_claim',
            source,
            claimUrl: minted.claimUrl,
            expiresAt: minted.expiresAt,
          }),
          200,
          { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
        );
      }
      return json({ ok: true, claim_url: minted.claimUrl, expires_at: minted.expiresAt }, 200, {
        'cache-control': 'no-store',
      });
    }

    async function handleDisconnect(
      request: Request,
      session: Session,
      fields: Record<string, unknown>,
    ): Promise<Response> {
      const source = stringOf(fields, 'source');
      if (!(CONNECTOR_SOURCES as readonly string[]).includes(source)) {
        return refusedConnector(
          request,
          'unknown_source',
          'No such connector',
          'This brain does not offer a connector by that name.',
          400,
        );
      }
      // The same refusal, in the same order, and not because the two routes are
      // symmetrical for symmetry's sake: a disconnect is *tell the vendor and
      // stop the polling*, and a deployment with no vendor can do neither half
      // — no `ingest_pull` job can exist without a connection the vendor
      // brokered. Answering `ok: true` with `vendor_deleted: false` would be the
      // `applied: true` lie one unit over, on the operation a user reaches for
      // when they want something to stop.
      const configured = deps.connectors;
      if (configured === undefined) return connectorUnavailable(request);

      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) {
        return refusedConnector(
          request,
          'no_brain_yet',
          'This account has no brain yet',
          'There is no brain here for a connector to be detached from.',
          409,
        );
      }

      /**
       * **The confirmation, and it is on the POST path only.**
       *
       * A disconnect revokes the vendor's external user and stops the polling.
       * It is not an erasure — nothing already ingested is touched — but it is
       * the kind of thing a stray press should not do, and the POST path is the
       * one a stray press reaches: it exists so that a *button on a page* can
       * get here, and a page has back buttons, double-taps and re-submissions.
       *
       * `DELETE` is deliberately exempt and byte-identical to what it always
       * was. A caller that chose that verb, on that route, with that body, has
       * already been explicit; adding a token for it to echo would be a
       * ceremony, not a safeguard.
       */
      if (request.method === 'POST' && stringOf(fields, 'confirm') !== source) {
        if (isFormPost(request)) {
          return html(renderPage({ kind: 'connector_confirm_disconnect', source }), 200);
        }
        return json(
          {
            ok: false,
            code: 'confirm_required',
            message: `Send "confirm" equal to "${source}" to disconnect it, or use DELETE.`,
          },
          400,
        );
      }

      // ------------------------------------------------------------------
      // **The order below is the whole of whether this button works, and it is
      // local-first: stop polling, then tell the vendor.**
      //
      // The failure a disconnect must never have is this brain polling with a
      // credential we have already asked to have revoked. Telling the vendor
      // first opens exactly that window — and a worse one: a reconciliation pass
      // that listed this account a moment ago is holding a live answer, and
      // between the vendor's delete and our own write it can still commit, which
      // puts the connection back with no vendor account behind it. Clearing the
      // link first closes both, because the reconciler writes under the fence it
      // read and this bumps it.
      //
      // The cost of this order is stated rather than hidden: if the vendor call
      // then fails, this brain has stopped polling a mailbox that is still
      // attached at the vendor. That is the survivable direction — the user sees
      // an error, retries, and the retry finds the state already clean and asks
      // the vendor again — and the reverse direction is a mailbox being read by
      // a brain the user told to stop.
      // ------------------------------------------------------------------
      await fenceConnectorLink(deps.controlSql, {
        tenantId,
        source: source as ConnectorSourceName,
        now: now(),
      });

      // A standing `ingest_pull` job for this source is the cadence already in
      // flight. Clearing the link stops the *next* one; this stops the one
      // standing now — including a dead-lettered one, which used to be left
      // behind and is the member that never drains on its own. A dead row stands
      // in `enqueueDuePulls`'s anti-join forever, so a disconnect that left it
      // there made the reconnect after it permanently silent.
      // `src/control/connector-lanes.ts` owns the statement and the argument.
      const stopped = await discardConnectorLanes(deps.controlSql, {
        tenantId,
        source,
        now: now(),
      });

      const vendor = await configured.disconnect({
        tenantId,
        source: source as ConnectorSourceName,
      });

      if (isFormPost(request)) {
        return html(
          renderPage({
            kind: 'connector_disconnected',
            source,
            pollingStopped: stopped.length,
            vendorDeleted: vendor.deleted,
            tokensRevoked: vendor.tokensRevoked,
          }),
        );
      }
      return json({
        ok: true,
        polling_stopped: stopped.length,
        vendor_deleted: vendor.deleted,
        // Reported as the vendor reported it. `unverified` stays `unverified`
        // until the compliance question is answered in writing, because
        // "no live credential remains anywhere" is a sentence that ends up in a
        // privacy policy.
        tokens_revoked: vendor.tokensRevoked,
      });
    }

    async function handleByok(request: Request, session: Session): Promise<Response> {
      const fields = await body(request);
      const provider = stringOf(fields, 'provider');
      const key = stringOf(fields, 'key');
      if (!(BYOK_PROVIDERS as readonly string[]).includes(provider)) {
        return json({ ok: false, code: 'unknown_provider' }, 400);
      }
      if (key.length < 8) return json({ ok: false, code: 'invalid_key' }, 400);

      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return json({ ok: false, code: 'no_brain_yet' }, 409);

      const written = await deps.byok.put(tenantId, provider as ProviderId, key);
      if (!written.ok) return json({ ok: false, code: 'not_stored' }, 500);

      // The last four characters, from what the caller just sent — not read back
      // from a store this module has no permission to query. The key itself is
      // never echoed and never logged.
      return json({ ok: true, provider, last4: key.slice(-4) });
    }

    async function handleByokRevoke(request: Request, session: Session): Promise<Response> {
      const fields = await body(request);
      const provider = stringOf(fields, 'provider');
      if (!(BYOK_PROVIDERS as readonly string[]).includes(provider)) {
        return json({ ok: false, code: 'unknown_provider' }, 400);
      }
      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return json({ ok: false, code: 'no_brain_yet' }, 409);

      await deps.byok.revoke(tenantId, provider as ProviderId);
      return json({ ok: true, provider });
    }

    /**
     * What severing this origin would cost, in both currencies (U17's two
     * columns). A GET, and a read — the suite asserts a before/after census
     * across every content table, because a preview that mutates is not a
     * preview.
     */
    async function handleSeverancePreview(url: URL, session: Session): Promise<Response> {
      if (deps.severance === undefined) {
        return json({ ok: false, code: 'unavailable' }, 501);
      }
      const origin = url.searchParams.get('origin') ?? '';
      if (origin.length === 0) return json({ ok: false, code: 'origin_required' }, 400);

      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return json({ ok: false, code: 'no_brain_yet' }, 409);

      const preview = await deps.severance.preview({ tenantId, origin });
      return json({
        ok: true,
        origin,
        removed: preview.removed,
        // The column a preview that only counted deletions would omit, and the
        // one the user actually needs: disconnecting work costs them their work
        // mail AND their shared history with everyone they know through both.
        recomputed: preview.recomputed,
        recompute_required: preview.recomputeRequired,
        surviving_origins: preview.survivingOrigins,
      });
    }

    /**
     * Sever it.
     *
     * **The confirmation is an echo of the origin, not a flag**, and this route
     * checks it before the port is called as well as inside it. A boolean
     * `confirm: true` is a field a bug fills in, a retry replays and a model can
     * guess; the exact string is one only something that read the preview can
     * produce. R12a's rule is why this lives here and not on `tools/call` at
     * all: the assistant holding `remember` is the assistant reading the user's
     * mail.
     */
    async function handleSeverance(request: Request, session: Session): Promise<Response> {
      if (deps.severance === undefined) {
        return json({ ok: false, code: 'unavailable' }, 501);
      }
      const fields = await body(request);
      const origin = stringOf(fields, 'origin');
      const confirm = stringOf(fields, 'confirm');
      if (origin.length === 0) return json({ ok: false, code: 'origin_required' }, 400);
      if (confirm !== origin) return json({ ok: false, code: 'not_confirmed' }, 400);

      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return json({ ok: false, code: 'no_brain_yet' }, 409);

      const outcome = await deps.severance.execute({ tenantId, origin, confirm });
      if (!outcome.ok) return json({ ok: false, code: outcome.reason }, 400);

      // Stop the polling for every source of this origin's class, for the reason
      // `handleDisconnect` gives one route over: leaving an `ingest_pull` queued
      // means the next worker re-imports what was just severed, on a cadence,
      // and the user watches their disconnection undo itself.
      const stopped = await deps.controlSql<{ job_id: string }[]>`
        UPDATE control.job
        SET state = 'discarded', finished_at = ${now()}, updated_at = ${now()},
            lease_owner = NULL, lease_expires_at = NULL, attempt_deadline_at = NULL
        WHERE tenant_id = ${tenantId}
          AND kind = 'ingest_pull'
          AND state IN ('due', 'running')
        RETURNING job_id::text AS job_id`;

      return json({
        ok: true,
        origin,
        severance_id: outcome.severanceId,
        already_severed: outcome.alreadySevered,
        polling_stopped: stopped.length,
      });
    }

    /**
     * What erasing this correspondent would take, before anyone instructs it.
     *
     * **The list, not the counts, is the deliverable.** `subject-erasure.ts`
     * matches a *name* through the entity's inferred aliases, and an alias is
     * whatever spelling an outside sender used — a correspondent who signs off
     * `Al` puts a two-character form into the vocabulary this sweep reads. The
     * module's stated mitigation for that is not a filter, it is this flow: the
     * controller reads a preview naming every row with the text that matched,
     * and a preview that reported `facts: 2` as a bare number could not see what
     * it was authorising. So the rows travel to the caller.
     */
    async function handleSubjectErasurePreview(url: URL, session: Session): Promise<Response> {
      if (deps.subjectErasure === undefined) {
        return json({ ok: false, code: 'unavailable' }, 501);
      }
      const identifier = (url.searchParams.get('identifier') ?? '').trim();
      if (identifier.length === 0) return json({ ok: false, code: 'identifier_required' }, 400);

      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return json({ ok: false, code: 'no_brain_yet' }, 409);

      const preview = await deps.subjectErasure.preview({ tenantId, identifier });
      return json({
        ok: true,
        subject_digest: preview.subjectDigest,
        entity_ids: preview.entityIds,
        // Every spelling the sweep will match on, so the widest thing it could
        // reach is visible before it reaches it.
        surface_forms: preview.surfaceForms,
        pages: preview.pages,
        rows: preview.rows,
        removed: preview.removed,
        // The column a preview that only counted deletions would omit: rows that
        // survive having lost an input are wrong rather than gone.
        recomputed: preview.recomputed,
        recompute_required: preview.recomputeRequired,
      });
    }

    /**
     * Erase the correspondent.
     *
     * **The confirmation is an echo of the identifier**, checked here as well as
     * inside the port, for the reason `handleSeverance` gives: a boolean
     * `confirm: true` is a field a bug fills in, a retry replays and a model can
     * guess, and the exact string is one only something that read the preview can
     * produce. The stakes are higher here than on severance — this is the request
     * of a third party who is not the account holder, executed against records
     * about them — which is why the check is the first thing that happens and
     * the port is not reached at all when it fails.
     *
     * **Not on `tools/call`, and this route is why that is affordable.** R12a
     * says the assistant that would issue this is the assistant reading the
     * correspondent's mail. Refusing to register the tool is only honest while
     * some other surface can perform it; before this, refusing the tool meant
     * refusing the request.
     */
    async function handleSubjectErasure(request: Request, session: Session): Promise<Response> {
      if (deps.subjectErasure === undefined) {
        return json({ ok: false, code: 'unavailable' }, 501);
      }
      const fields = await body(request);
      const identifier = stringOf(fields, 'identifier').trim();
      const confirm = stringOf(fields, 'confirm').trim();
      if (identifier.length === 0) return json({ ok: false, code: 'identifier_required' }, 400);
      if (confirm !== identifier) return json({ ok: false, code: 'not_confirmed' }, 400);

      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return json({ ok: false, code: 'no_brain_yet' }, 409);

      const outcome = await deps.subjectErasure.execute({ tenantId, identifier, confirm });
      if (!outcome.ok) return json({ ok: false, code: outcome.reason }, 400);

      return json({
        ok: true,
        // The digest, never the identifier: the receipt for an erasure must not
        // be the one place the address survives.
        subject_digest: outcome.subjectDigest,
        removed: outcome.removed,
        recompute_required: outcome.recomputeRequired,
        // The property U15's determination flags as most likely to be missed. It
        // travels on the receipt because a caller who was told the rows went and
        // not that the re-ingestion is suppressed has been told half of it.
        reingestion_tombstoned: outcome.reingestionTombstoned,
        raw_objects_removed: outcome.rawObjectsRemoved,
        raw_objects_unreachable: outcome.rawObjectsUnreachable,
        attachment_objects_removed: outcome.attachmentObjectsRemoved,
        attachment_objects_unreachable: outcome.attachmentObjectsUnreachable,
        // Rows stop being queryable when the call returns; they stop being
        // recoverable when this window rolls, and it is the second number a
        // data-subject answer has to quote.
        unrecoverable_after_days: outcome.unrecoverableAfterDays,
        erased_at: outcome.erasedAt,
      });
    }

    /**
     * What is still undoable, as JSON.
     *
     * A plural index rather than a preview: nothing arrives between reading this
     * and clicking, because what carries an instant is fixed at the instant.
     */
    async function handleRetractions(session: Session): Promise<Response> {
      if (deps.retractions === undefined) {
        return json({ ok: false, code: 'unavailable' }, 501);
      }
      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return json({ ok: false, code: 'no_brain_yet' }, 409);

      const listing = await deps.retractions.list({ tenantId });
      return json({
        ok: true,
        ttl_hours: listing.ttlHours,
        // "Took exactly the ceiling" and "took the ceiling and there is more"
        // are different facts, and only the second means the user has not been
        // shown everything they may still undo.
        overflowed: listing.overflowed,
        retractions: listing.retractions.map((entry) => ({
          deleted_at: entry.deletedAt,
          restorable_until: entry.restorableUntil,
          kind: entry.kind,
          origins: entry.origins,
          target_kind: entry.targetKind,
          counts: entry.counts,
        })),
      });
    }

    /**
     * Put one retraction back.
     *
     * **The confirmation echoes the instant, and this route checks it as well as
     * the port does**, for the reason `handleSeverance` gives: the echo is the
     * control, and a control checked in exactly one place is one edit away from
     * being checked nowhere.
     *
     * The echo here buys *identity* rather than deliberation, and that is the
     * difference from severance's. A restore is not destructive, so there is no
     * consent to obtain — but the key is a millisecond-precision timestamp
     * arriving as a string, which makes it the one parameter in this system
     * where a typo produces **another valid key**. The listing populates it as a
     * hidden field, so the two agree in the happy path; the check catches a
     * hand-rolled POST, a client that *constructs* an instant instead of copying
     * one, and a future edit that starts accepting the key from somewhere other
     * than the listing.
     *
     * **The refusals are three different statuses on purpose.** 404 for an
     * instant that is not a retraction of theirs; 410 for one whose window has
     * closed, because 410 is "it was here, it is not, and it will not be back";
     * 400 for an echo that does not match. And the success case names
     * `already_restored` rather than reporting a second restore that moved
     * nothing.
     */
    async function handleRestore(request: Request, session: Session): Promise<Response> {
      if (deps.retractions === undefined) {
        return json({ ok: false, code: 'unavailable' }, 501);
      }
      const fields = await body(request);
      const deletedAt = stringOf(fields, 'deleted_at').trim();
      const confirm = stringOf(fields, 'confirm').trim();
      if (deletedAt.length === 0) return json({ ok: false, code: 'instant_required' }, 400);
      if (confirm !== deletedAt) return json({ ok: false, code: 'not_confirmed' }, 400);

      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return json({ ok: false, code: 'no_brain_yet' }, 409);

      const outcome = await deps.retractions.restore({ tenantId, deletedAt, confirm });
      if (!outcome.ok) {
        if (outcome.reason === 'not_found') {
          return answer(
            request,
            404,
            { ok: false, code: 'not_found' },
            'Nothing to restore',
            'No retraction of yours at that instant.',
          );
        }
        if (outcome.reason === 'ttl_expired') {
          // Two sentences, both true at every point on the timeline, and neither
          // making any claim about where the bytes are. "May have been
          // permanently deleted" describes an uncertainty the user cannot
          // resolve; "contact support" implies a back door that does not exist;
          // "this data is gone" is false for up to a day, because the purge's
          // grace band keeps the rows past the TTL — and the band is not
          // mentioned either, since a number a user cannot act on but can appeal
          // to converts a closed window into a support ticket.
          const closed = outcome.closedAt ?? deletedAt;
          return answer(
            request,
            410,
            { ok: false, code: 'ttl_expired' },
            'That window has closed',
            `The 72-hour window for this retraction closed at ${closed}. It can no longer be restored.`,
          );
        }
        return answer(request, 400, { ok: false, code: outcome.reason }, 'Not restored', outcome.reason);
      }

      return answer(
        request,
        200,
        {
          ok: true,
          deleted_at: deletedAt,
          restored: outcome.restored,
          // Reported beside `restored` rather than folded in: one clears a flag,
          // the other re-inserts a row into a table that may have moved on.
          unarchived: outcome.unarchived,
          // The two "came back short" numbers. A response reporting three pages
          // restored while two cards stayed deleted would re-open, one layer up,
          // exactly the partial-success lie those fields exist to prevent.
          superseded_cards: outcome.supersededCards,
          superseded_aliases: outcome.supersededAliases,
          already_restored: outcome.alreadyRestored,
          was_origin: outcome.wasOrigin,
        },
        outcome.alreadyRestored ? 'Nothing changed' : 'Restored',
        restoreMessage(outcome),
      );
    }

    /**
     * One outcome, in whichever language the caller speaks.
     *
     * **A browser posting this form must not be handed a JSON body.** The page
     * carries a plain `<form>` and no script — there is no bundler here — so a
     * click arrives as `application/x-www-form-urlencoded` and an answer of
     * `{"ok":true,…}` renders as text in a window with no way back. That is the
     * failure `pages.ts:connector_notice` names in its own docstring, and it
     * would land on the one surface whose entire justification was that a JSON
     * endpoint alone moves the gap rather than closing it.
     *
     * The message is identical in both, and so is the status: a `fetch` client
     * and a browser must not be able to learn different things about the same
     * restore.
     */
    function answer(
      request: Request,
      status: number,
      payload: Record<string, unknown>,
      heading: string,
      message: string,
    ): Response {
      if (!isFormPost(request)) return json({ ...payload, message }, status);
      return html(renderPage({ kind: 'retraction_notice', heading, message }), status);
    }

    /** The listing, as a page — the destination `forget`'s notice names. */
    async function renderRetractions(session: Session): Promise<Response> {
      if (deps.retractions === undefined) {
        return html(
          renderPage({
            kind: 'retractions',
            available: false,
            retractions: [],
            overflowed: false,
            ttlHours: 0,
          }),
          501,
        );
      }
      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return seeOther(BRAIN_SETUP_PATH);

      const listing = await deps.retractions.list({ tenantId });
      return html(
        renderPage({
          kind: 'retractions',
          available: true,
          retractions: listing.retractions.map((entry) => ({
            deletedAt: entry.deletedAt,
            restorableUntil: entry.restorableUntil,
            kind: entry.kind,
            origins: [...entry.origins],
            targetKind: entry.targetKind,
            counts: { ...entry.counts },
          })),
          overflowed: listing.overflowed,
          ttlHours: listing.ttlHours,
        }),
      );
    }

    /**
     * Start a subscription: create the vendor's customer, **record it**, then
     * hand back the URL.
     *
     * **The record happens before the redirect, and that ordering is the fix.**
     * The webhook resolves an owner by customer id and nothing in this system
     * ever wrote one, so a correctly-signed delivery for a real paying customer
     * answered `unknown_customer` and the tier never moved. Recording after the
     * redirect would leave the same hole for as long as the round trip takes,
     * which is exactly when the first delivery arrives.
     *
     * **A customer that cannot be bound does not get a payment page.** If the
     * account already names a different customer, this refuses rather than
     * sending somebody to pay against an id whose events will land on another
     * row — the unique index makes that a database fact and this makes it a
     * legible refusal.
     */
    async function handleCheckout(session: Session): Promise<Response> {
      const vendor = deps.checkout;
      if (vendor === undefined) {
        return json(
          { ok: false, code: 'not_configured', message: 'This deployment has no billing vendor configured.' },
          501,
        );
      }

      const subscription = await subscriptionOf(deps.sql, session.accountId);
      if (subscription.tier === 'paid') {
        return json({ ok: false, code: 'already_subscribed' }, 409);
      }

      const started = await vendor.start({
        accountId: session.accountId,
        successUrl: `${deps.origin}/dashboard`,
        cancelUrl: `${deps.origin}/dashboard`,
      });
      if (!started.ok) {
        return json({ ok: false, code: 'checkout_unavailable' }, 502);
      }

      const recorded = await recordCheckoutCustomer(deps.sql, {
        accountId: session.accountId,
        customerId: started.customerId,
        now: now(),
      });
      if (!recorded.ok) {
        return json({ ok: false, code: 'checkout_conflict', reason: recorded.reason }, 409);
      }

      return json({ ok: true, url: started.url });
    }

    function handleExportConfig(): Response {
      // R18's scheduled self-export destination is a URL and a credential —
      // unstorable under the control plane's content-free rule, and its home is
      // U17's lifecycle rung, which is a tenant schema rung this unit may not
      // add. The affordance ships; the store does not, and the refusal says so
      // rather than pretending the setting was saved.
      return json(
        {
          ok: false,
          code: 'not_yet',
          unit: 'U17',
          message:
            'Scheduled self-export is not built yet. It lands with U17, which owns the destination ' +
            'store and the export runbook. Manual export is available from the same unit.',
        },
        501,
      );
    }

    /** The recovery page, and the redirect that makes anyone stuck arrive at it. */
    async function renderBrainSetup(session: Session): Promise<Response> {
      if ((await tenantOf(session.accountId)) !== null) return seeOther('/dashboard');
      return html(brainSetupPage());
    }

    function brainSetupPage(problem?: string): string {
      return renderPage({
        kind: 'brain_setup',
        languages: [...FTS_LANGUAGE_CHOICES],
        ...(problem === undefined ? {} : { problem }),
      });
    }

    /** 303, so a browser following it does so with a GET. */
    function seeOther(location: string): Response {
      return new Response(null, { status: 303, headers: { location } });
    }

    async function renderDashboard(session: Session): Promise<Response> {
      const subscription = await subscriptionOf(deps.sql, session.accountId);
      const brain = await brainOf(deps.sql, session.accountId);
      const tenantId = brain?.tenantId ?? null;
      if (tenantId === null) return seeOther(BRAIN_SETUP_PATH);
      // The same two questions `handleConnect` asks, in the same order, so the
      // page cannot offer a button whose route answers 501. A tier that is paid
      // on a deployment holding no vendor is still not a connector.
      const tier =
        tenantId === null
          ? subscription.tier
          : await effectiveTierOf(deps.controlSql, tenantId, subscription.tier);
      const connectorsAvailable = deps.connectors !== undefined && connectorGate(tier) === null;
      // **Reconciling here is what makes a user who DID come back see their
      // connection immediately**, rather than waiting for the worker fleet's
      // half-hourly wake. It is bounded to this tenant's own unfinished
      // connects, so the ordinary dashboard render — nothing pending — reaches
      // the vendor zero times and costs one control-plane query.
      //
      // Failure is swallowed on purpose, and only here: a vendor outage must not
      // turn somebody's dashboard into a 500. The worker's tick reconciles the
      // same link on its own schedule, so the loss is latency rather than the
      // connection.

      // Only asked for when there is a panel to put it in: a gated account is
      // rendered no control and no status, so reading for it would be a
      // control-plane round trip whose answer nothing displays.
      const connectors = connectorsAvailable
        ? await connectorStatuses(deps.controlSql, {
            tenantId,
            sources: CONNECTOR_SOURCES,
            links: await readConnectorLinks(deps.controlSql, { tenantId, now: now() }),
            // The same clock the link read is judged against. Staleness is the
            // one thing on this panel that is a claim about elapsed time, and
            // the two readings disagreeing by a request's worth of drift is a
            // page that contradicts itself.
            now: now(),
          })
        : [];
      return html(
        renderPage({
          kind: 'dashboard',
          tier: subscription.tier,
          status: subscription.status,
          tenantId,
          connectorsAvailable,
          connectors,
        }),
      );
    }

    /**
     * What the brain holds, as a page.
     *
     * **Four states, and the fourth is the one a sketch forgets.** No port is a
     * `501` explanation; no brain is the setup page, for the reason every other
     * handler redirects there; an empty brain **renders** rather than blanking,
     * because "nothing has arrived from this account yet" is the single most
     * useful sentence this page can say to somebody who connected an hour ago.
     * And a brain that will not open is explained rather than 500'd.
     *
     * **Why the throw is caught here.** `withTenant` throws when a connection
     * secret will not resolve, and the entrypoint turns that into a generic 500
     * — right for severance, wrong for the one page whose job is explaining
     * state. A suspended compute, a slow cold start or a genuinely broken tenant
     * would blank the page at the exact moment somebody is trying to find out
     * what is wrong. `renderDashboard` already swallows a reconciler failure for
     * the same reason and writes the same kind of line to stderr, where an
     * operator is.
     *
     * **The tier is read from the control plane, not from the tenant.** It costs
     * no tenant round trip and it is what makes the cold-layer sentence true
     * rather than alarming: on the free tier a brain that has never dreamt is
     * the plan working, and a page that said "not consolidated" without saying
     * that would read as a fault report for every free user.
     */
    async function renderCoverage(session: Session): Promise<Response> {
      const subscription = await subscriptionOf(deps.sql, session.accountId);
      if (deps.coverage === undefined) {
        return html(
          renderPage({
            kind: 'coverage',
            available: false,
            reachable: false,
            tier: subscription.tier,
            view: null,
          }),
          501,
        );
      }
      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return seeOther(BRAIN_SETUP_PATH);
      const tier = await effectiveTierOf(deps.controlSql, tenantId, subscription.tier);

      let view: CoverageView;
      try {
        view = await deps.coverage.read({ tenantId });
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({
            event: 'coverage_unreadable',
            tenant: tenantId,
            message: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
        return html(
          renderPage({ kind: 'coverage', available: true, reachable: false, tier, view: null }),
        );
      }
      return html(renderPage({ kind: 'coverage', available: true, reachable: true, tier, view }));
    }

    /**
     * How far each step has got, as a page.
     *
     * Four states, exactly `renderCoverage`'s, and the throw is caught for the
     * same reason: the entrypoint's generic `500` is right for severance and
     * wrong for the one page whose whole job is explaining state.
     *
     * **`modelTier` fails toward showing, not toward blanking.** Anything that
     * is not literally `'free'` reads as paid — an operator grant resolves
     * through `effectiveTierOf`, and a brain running on one has real model-phase
     * backlog. A `=== 'paid' ? 'paid' : 'free'` here would blank the six
     * counters for exactly the brains an operator is looking at.
     */
    /**
     * What is waiting on a decision, as a page.
     *
     * Four states, `renderCoverage`'s, and the catch is caught for its reason.
     * The one divergence: **the stderr line names a SQLSTATE and a statement
     * label, never `error.message`.** Coverage copies the message and is
     * structurally safe doing so because nothing it touches is content. Every
     * statement behind this page reads `proposal`, `summary` or
     * `canonical_name`, so "a failure reason is a code and a timestamp, not a
     * subject line" has to be true here by construction rather than by luck.
     */
    async function renderReview(session: Session): Promise<Response> {
      const subscription = await subscriptionOf(deps.sql, session.accountId);
      if (deps.review === undefined) {
        return html(
          renderPage({
            kind: 'review',
            available: false,
            reachable: false,
            tier: subscription.tier,
            view: null,
          }),
          501,
        );
      }
      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return seeOther(BRAIN_SETUP_PATH);
      const tier = await effectiveTierOf(deps.controlSql, tenantId, subscription.tier);

      let view: ReviewView;
      try {
        view = await deps.review.read({ tenantId });
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({
            event: 'review_unreadable',
            tenant: tenantId,
            code: (error as { code?: string }).code ?? 'unknown',
          })}\n`,
        );
        return html(
          renderPage({ kind: 'review', available: true, reachable: false, tier, view: null }),
        );
      }
      // `no-store`, because the page renders undecided content and a cached copy
      // outlives the decision it was drawn for.
      return html(
        renderPage({ kind: 'review', available: true, reachable: true, tier, view }),
        200,
        { 'cache-control': 'no-store' },
      );
    }

    /** One decision about one proposal: apply, dismiss, or undo an apply. */
    async function handleReviewDecision(request: Request, session: Session): Promise<Response> {
      if (deps.review === undefined) return json({ ok: false, code: 'unavailable' }, 501);
      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return seeOther(BRAIN_SETUP_PATH);

      const fields = await body(request);
      const reviewId = stringOf(fields, 'review_id');
      const intent = stringOf(fields, 'intent');
      if (!/^[0-9]{1,18}$/.test(reviewId)) {
        return json({ ok: false, code: 'invalid_params' }, 400);
      }

      if (intent === 'undo') {
        const undone = await deps.review.undo({ tenantId, reviewId });
        return afterForm(request, REVIEW_PATH, {}) ?? json(undone, undone.ok ? 200 : 409);
      }
      if (intent !== 'apply' && intent !== 'dismiss') {
        return json({ ok: false, code: 'invalid_params' }, 400);
      }
      const seen = stringOf(fields, 'seen_card_id');
      const decided = await deps.review.decide({
        tenantId,
        reviewId,
        intent,
        seenCardId: /^[0-9]{1,18}$/.test(seen) ? seen : null,
      });
      return afterForm(request, REVIEW_PATH, {}) ?? json(decided, decided.ok ? 200 : 409);
    }

    /** One verdict about one contradiction. It records, and touches no fact. */
    async function handleContradiction(request: Request, session: Session): Promise<Response> {
      if (deps.review === undefined) return json({ ok: false, code: 'unavailable' }, 501);
      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return seeOther(BRAIN_SETUP_PATH);

      const fields = await body(request);
      const reportId = stringOf(fields, 'report_id');
      const intent = stringOf(fields, 'intent');
      const verdicts = ['left', 'right', 'both', 'neither', 'dismiss'] as const;
      if (
        !/^[0-9]{1,18}$/.test(reportId) ||
        !(verdicts as readonly string[]).includes(intent)
      ) {
        return json({ ok: false, code: 'invalid_params' }, 400);
      }
      const resolved = await deps.review.resolve({
        tenantId,
        reportId,
        intent: intent as (typeof verdicts)[number],
      });
      return afterForm(request, REVIEW_PATH, {}) ?? json(resolved, resolved.ok ? 200 : 409);
    }

    /**
     * Where mail and files come in from.
     *
     * Split off the dashboard, so the connector state that used to be a section
     * there is now the whole page. The gate and the statuses are resolved
     * exactly as `renderDashboard` resolved them — this moved the render, not
     * the policy.
     */
    async function renderConnectors(session: Session): Promise<Response> {
      const subscription = await subscriptionOf(deps.sql, session.accountId);
      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return seeOther(BRAIN_SETUP_PATH);
      const tier = await effectiveTierOf(deps.controlSql, tenantId, subscription.tier);
      const available = deps.connectors !== undefined && connectorGate(tier) === null;
      // **The reconcile moved here with the panel, and it had to.** It is what
      // makes a user who DID come back see their connection immediately rather
      // than waiting for the worker fleet's half-hourly wake — and this page's
      // own copy promises exactly that: "loading this page asks about any
      // connect you have started". Left on the dashboard it would have made
      // that sentence false the moment the panel moved off it.
      if (available && deps.reconciler !== undefined) {
        try {
          await deps.reconciler.run({ now: now(), tenantId });
        } catch (error) {
          process.stderr.write(
            `${JSON.stringify({
              event: 'connector_reconcile_failed',
              tenant: tenantId,
              message: error instanceof Error ? error.message : String(error),
            })}\n`,
          );
        }
      }
      // Resolved exactly as `renderDashboard` resolved it: this change moved
      // the render, not the policy. Only asked for when there is a panel to put
      // it in — a gated account is rendered no control and no status.
      const statuses = available
        ? await connectorStatuses(deps.controlSql, {
            tenantId,
            sources: CONNECTOR_SOURCES,
            links: await readConnectorLinks(deps.controlSql, { tenantId, now: now() }),
            now: now(),
          })
        : [];
      return html(
        renderPage({
          kind: 'connectors',
          connectorsAvailable: available,
          connectors: statuses,
        }),
      );
    }

    /**
     * One named subject.
     *
     * **The idle branch returns before `tenantOf`.** With no name submitted the
     * handler renders the form and never asks the port, which is what preserves
     * the ruling that a default render opens no tenant database — waking a
     * suspended brain because its owner asked is defensible, waking one because
     * they navigated is not.
     *
     * The stderr line names a SQLSTATE and nothing else: every statement behind
     * this page reads `canonical_name`, `alias` and `summary`, so "a failure
     * reason is a code and a timestamp, not a subject line" has to hold by
     * construction rather than by care.
     */
    async function renderEntityLookup(
      session: Session,
      name: string | null,
      page = 0,
    ): Promise<Response> {
      // **`no-store` only, and the header that came off is worth a sentence.**
      // Under `Referrer-Policy: no-referrer` a browser sets the `Origin` header
      // of a non-GET request to the literal `null` — Fetch's "append a request
      // Origin header" step switches on the referrer policy and `no-referrer`
      // is the arm that nulls it. This page's whole interaction is a same-origin
      // form POST and `sameOriginRefusal` compares that header against this
      // origin, so the stricter header refused every lookup with "this request
      // came from another origin". Found in production on the first real search.
      //
      // Nothing is lost: the global default is already `same-origin`, which
      // keeps the referrer off every other origin — and the URL carries no
      // subject anyway, which is why this page posts rather than gets.
      const chrome = ENTITY_HEADERS;
      if (deps.entityLookup === undefined) {
        return html(renderPage({ kind: 'entity', available: false, lookup: null }), 501);
      }
      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return seeOther(BRAIN_SETUP_PATH);

      // No name submitted: the roster, one page of it. This is where the page
      // stopped being resting-empty — see `entity.ts`'s header for the argument
      // that was overruled and what still stands.
      if (name === null || name.trim().length === 0) {
        let roster: EntityLookup;
        try {
          roster = { status: 'browsing', roster: await deps.entityLookup.list({ tenantId, page }) };
        } catch (error) {
          process.stderr.write(
            `${JSON.stringify({
              event: 'entity_roster_unreadable',
              tenant: tenantId,
              code: (error as { code?: string }).code ?? 'unknown',
            })}\n`,
          );
          return html(renderPage({ kind: 'entity', available: true, lookup: null }), 200, chrome);
        }
        return html(renderPage({ kind: 'entity', available: true, lookup: roster }), 200, chrome);
      }

      let lookup: EntityLookup;
      try {
        lookup = await deps.entityLookup.read({ tenantId, name });
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({
            event: 'entity_lookup_unreadable',
            tenant: tenantId,
            code: (error as { code?: string }).code ?? 'unknown',
          })}\n`,
        );
        return html(renderPage({ kind: 'entity', available: true, lookup: null }), 200, chrome);
      }
      return html(renderPage({ kind: 'entity', available: true, lookup }), 200, chrome);
    }

    /**
     * Account configuration: the key form, the spend window and the export note.
     *
     * **Reads `control.tenant` and nothing else**, so this page opens no tenant
     * database — the same property `renderDashboard` has and for the same
     * reason. That is what makes it safe to put in the rail beside pages that
     * do open one.
     *
     * The spend figures are the ones `handleSpend` already returns as JSON to a
     * fetch that could never happen: the policy carries no `script-src`, so the
     * dashboard's "Loaded from /api/spend" note has never loaded anything. This
     * renders them.
     */
    async function renderSettings(session: Session): Promise<Response> {
      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return seeOther(BRAIN_SETUP_PATH);

      const rows = await deps.controlSql<
        {
          spend_micro_usd: string;
          spend_window_started_at: Date;
          spend_cap_micro_usd: string | null;
        }[]
      >`
        SELECT spend_micro_usd, spend_window_started_at, spend_cap_micro_usd
        FROM control.tenant WHERE tenant_id = ${tenantId}`;
      const row = rows[0];
      // `null`, not zero — an absent row means nothing has been counted, which
      // is a different sentence from "you have spent nothing".
      const spend =
        row === undefined
          ? null
          : {
              windowStartedAt: row.spend_window_started_at.toISOString(),
              spentMicroUsd: Number(row.spend_micro_usd),
              capMicroUsd: row.spend_cap_micro_usd === null ? null : Number(row.spend_cap_micro_usd),
            };

      return html(
        renderPage({ kind: 'settings', providers: [...BYOK_PROVIDERS], spend }),
        200,
        { 'cache-control': 'no-store' },
      );
    }

    async function renderProcessing(session: Session): Promise<Response> {
      const subscription = await subscriptionOf(deps.sql, session.accountId);
      if (deps.coverage === undefined) {
        return html(
          renderPage({
            kind: 'processing',
            available: false,
            reachable: false,
            tier: subscription.tier,
            view: null,
          }),
          501,
        );
      }
      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return seeOther(BRAIN_SETUP_PATH);
      const tier = await effectiveTierOf(deps.controlSql, tenantId, subscription.tier);

      let view: ProcessingView;
      try {
        view = await deps.coverage.readProcessing({
          tenantId,
          modelTier: tier === 'free' ? 'free' : 'paid',
        });
      } catch (error) {
        process.stderr.write(
          `${JSON.stringify({
            event: 'processing_unreadable',
            tenant: tenantId,
            message: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
        return html(
          renderPage({ kind: 'processing', available: true, reachable: false, tier, view: null }),
        );
      }
      return html(renderPage({ kind: 'processing', available: true, reachable: true, tier, view }));
    }

    async function renderConnect(session: Session): Promise<Response> {
      const tenantId = await tenantOf(session.accountId);
      // Instructions for connecting an assistant to a brain that does not exist
      // end at the MCP fleet's 409 — after the user has installed a connector
      // and granted it consent. The brain comes first.
      if (tenantId === null) return seeOther(BRAIN_SETUP_PATH);
      const status = await connectionStatus(deps.controlSql, tenantId);
      return html(
        renderPage({
          kind: 'connect',
          installLink: installLink({ mcpUrl: deps.mcpUrl }),
          command: claudeCodeCommand(deps.mcpUrl),
          steps: [...CONNECT_STEPS],
          connected: status.state === 'connected',
        }),
      );
    }
  };
}

/**
 * The free-tier connector decision, in one place (re-plan §5).
 *
 * Connectors are paid-only. The reason is unit economics rather than capability:
 * a free user who connects once and never returns costs roughly $2/month at the
 * connector vendor forever — about twenty times R13's idle anchor — on a tenant
 * that generates no signal at all, which invalidates the sentence R13 exists to
 * make true. The free tier keeps chat-export and folder import (R8a), whose spend
 * is bounded and one-time rather than unbounded in time.
 *
 * The copy says that, rather than "upgrade for more". A user told the honest
 * reason can decide; a user told nothing assumes we are withholding a feature.
 */
export function connectorGate(
  tier: BillingTier,
): { readonly ok: false; readonly code: 'tier_required'; readonly message: string } | null {
  if (tier === 'paid') return null;
  return {
    ok: false,
    code: 'tier_required',
    message:
      'Connected accounts are on the paid plan. Each connected mailbox carries a monthly fee from ' +
      'the connector vendor whether or not the brain is used, which the free plan cannot carry. ' +
      'Chat exports and folder imports are included on every plan and need no connection.',
  };
}

/** Whether a provider key is set, without being able to read it. */
export interface ByokStatus {
  readonly provider: ProviderId;
  readonly set: boolean;
}

/**
 * Deliberately takes the answer rather than looking it up. This module holds a
 * write-only port, and the shape of the type is what stops a later edit from
 * "just adding a read" to make a dashboard nicer.
 */
export function byokStatus(provider: ProviderId, set: boolean): ByokStatus {
  return { provider, set };
}

export { attachBrain };
