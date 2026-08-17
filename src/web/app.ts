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
import { openFreeSubscription, subscriptionOf, type BillingTier } from '../control/billing.ts';
import { applyBillingEvent, recordCheckoutCustomer } from '../control/billing.ts';
import type { CheckoutPort } from '../control/checkout.ts';
import type { BrainProvisioner } from '../control/provisioner.ts';
import type { ProviderId } from '../ai/keys.ts';
import { CONNECT_STEPS, claudeCodeCommand, connectionStatus, installLink } from './connect.ts';
import { adminDispatch } from './admin.ts';
import { renderPage } from './pages.ts';

export const SESSION_COOKIE = 'bz_session';

/** Which connectors the product offers. The closed set the UI iterates. */
export const CONNECTOR_SOURCES = ['gmail', 'calendar', 'drive'] as const;
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
  readonly connectors: ConnectorVendor;
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

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      // The pages carry no third-party anything, so the policy can say so.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      'referrer-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
    },
  });
}

export function createWebApp(deps: WebAppDeps): (request: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());

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
    if (path === '/api/connectors' && request.method === 'POST') return handleConnect(request, session);
    if (path === '/api/connectors' && request.method === 'DELETE') return handleDisconnect(request, session);
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

    if (path === '/' || path === '/dashboard') return renderDashboard(session);
    if (path === '/connect') return renderConnect(session);

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
      const result = await adminDispatch({ controlSql: deps.controlSql }, { name, args });
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
      if (!brain.ok) return brain.response;

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
    ): Promise<{ readonly ok: true; readonly tenantId: string } | { readonly ok: false; readonly response: Response }> {
      const provisioned = await deps.provisioner.provision({ ftsLanguage });
      if (!provisioned.ok) {
        // The reason is not echoed. It names substrate and pool state, which is
        // deployment shape rather than something the person signing up can act
        // on, and this is a public origin.
        return {
          ok: false,
          response: json(
            {
              ok: false,
              code: 'provisioning_unavailable',
              message: 'Your account exists, but we could not build your brain just now. Sign in and try again.',
            },
            503,
          ),
        };
      }

      const linked = await attachBrain(deps.sql, {
        accountId,
        tenantId: provisioned.tenantId,
        ftsLanguage,
        now: now(),
      });
      if (!linked.ok) {
        return {
          ok: false,
          response: json(
            {
              ok: false,
              code: 'provisioning_unavailable',
              message: 'Your account exists, but we could not build your brain just now. Sign in and try again.',
            },
            503,
          ),
        };
      }
      return { ok: true, tenantId: provisioned.tenantId };
    }

    /**
     * The retry, for an account whose signup provisioned nothing.
     *
     * Without it the 503 above is terminal: the email is taken, the password
     * works, and there is no route that can ever give that account a brain. It
     * is idempotent by reading `account.brain` first — a second call must not
     * spend a second pool project on an account that already has one.
     */
    async function handleProvisionRetry(request: Request, session: Session): Promise<Response> {
      const existing = await brainOf(deps.sql, session.accountId);
      if (existing !== null) {
        return json({ ok: true, tenant_id: existing.tenantId, created: false });
      }

      // **The language is asked again rather than remembered.** A signup whose
      // provisioning failed recorded no `account.brain` row, and that row is the
      // only place the choice is kept — deliberately, because the choice belongs
      // to the brain. So the retry re-asks and refuses without an answer; a
      // retry that defaulted here would be KTD9's silent anglicisation arriving
      // through the back door, on exactly the accounts nobody is watching.
      const chosen = stringOf(await body(request), 'fts_language');
      if (chosen.length === 0) {
        return json(
          {
            ok: false,
            code: 'fts_language_required',
            message: 'Choose the language your notes and mail are mostly written in.',
          },
          400,
        );
      }

      const brain = await provisionBrain(session.accountId, chosen);
      return brain.ok ? json({ ok: true, tenant_id: brain.tenantId, created: true }, 201) : brain.response;
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

    async function handleConnect(request: Request, session: Session): Promise<Response> {
      const fields = await body(request);
      const source = stringOf(fields, 'source');
      if (!(CONNECTOR_SOURCES as readonly string[]).includes(source)) {
        return json({ ok: false, code: 'unknown_source' }, 400);
      }

      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return json({ ok: false, code: 'no_brain_yet' }, 409);

      const subscription = await subscriptionOf(deps.sql, session.accountId);
      const gate = connectorGate(subscription.tier);
      if (gate !== null) return json(gate, 402);

      const minted = await deps.connectors.mintClaimUrl({
        tenantId,
        source: source as ConnectorSourceName,
      });
      // The claim URL is a capability, not display copy: whoever holds it can
      // attach *their* mailbox to *this* brain. It is returned once, to the
      // authenticated owner, and is never logged.
      return json({ ok: true, claim_url: minted.claimUrl, expires_at: minted.expiresAt });
    }

    async function handleDisconnect(request: Request, session: Session): Promise<Response> {
      const fields = await body(request);
      const source = stringOf(fields, 'source');
      if (!(CONNECTOR_SOURCES as readonly string[]).includes(source)) {
        return json({ ok: false, code: 'unknown_source' }, 400);
      }
      const tenantId = await tenantOf(session.accountId);
      if (tenantId === null) return json({ ok: false, code: 'no_brain_yet' }, 409);

      const vendor = await deps.connectors.disconnect({
        tenantId,
        source: source as ConnectorSourceName,
      });

      // **Disconnect has to stop the polling, not only tell the vendor.** An open
      // `ingest_pull` job for this source is the cadence; leaving it queued means
      // the next worker picks it up and pulls with a credential we have just
      // asked to have revoked.
      const stopped = await deps.controlSql<{ job_id: string }[]>`
        UPDATE control.job
        SET state = 'discarded', finished_at = ${now()}, updated_at = ${now()},
            lease_owner = NULL, lease_expires_at = NULL, attempt_deadline_at = NULL
        WHERE tenant_id = ${tenantId}
          AND kind = 'ingest_pull'
          AND target = ${source}::control.job_target
          AND state IN ('due', 'running')
        RETURNING job_id::text AS job_id`;

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

    async function renderDashboard(session: Session): Promise<Response> {
      const subscription = await subscriptionOf(deps.sql, session.accountId);
      const brain = await brainOf(deps.sql, session.accountId);
      return html(
        renderPage({
          kind: 'dashboard',
          tier: subscription.tier,
          status: subscription.status,
          tenantId: brain?.tenantId ?? null,
          connectorsAvailable: connectorGate(subscription.tier) === null,
          sources: [...CONNECTOR_SOURCES],
          providers: [...BYOK_PROVIDERS],
        }),
      );
    }

    async function renderConnect(session: Session): Promise<Response> {
      const tenantId = await tenantOf(session.accountId);
      const status =
        tenantId === null
          ? { state: 'never_connected' as const, firstSeenAt: null, lastSeenAt: null }
          : await connectionStatus(deps.controlSql, tenantId);
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
