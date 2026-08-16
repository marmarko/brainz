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
import { applyBillingEvent } from '../control/billing.ts';
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
    if (path === '/login') return html(renderPage({ kind: 'login' }));
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
    if (path === '/api/me') return handleMe(session);
    if (path === '/api/spend') return handleSpend(session);
    if (path === '/api/connect') return handleConnectInfo(session);
    if (path === '/api/connectors' && request.method === 'POST') return handleConnect(request, session);
    if (path === '/api/connectors' && request.method === 'DELETE') return handleDisconnect(request, session);
    if (path === '/api/byok' && request.method === 'POST') return handleByok(request, session);
    if (path === '/api/byok' && request.method === 'DELETE') return handleByokRevoke(request, session);
    if (path === '/api/export-config') return handleExportConfig();

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
      if (offered.length !== configured.length || offered !== configured) {
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
      const session = await createSession(deps.sql, { accountId: created.accountId, now: now() });
      const cookie = { 'set-cookie': sessionCookie(session.token, Math.floor(ABSOLUTE_SESSION_MS / 1000)) };
      return (
        afterForm(request, '/connect', cookie) ??
        json({ ok: true, account_id: created.accountId, fts_language: ftsLanguage }, 201, cookie)
      );
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
      return afterForm(request, '/dashboard', cookie) ?? json({ ok: true }, 200, cookie);
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
