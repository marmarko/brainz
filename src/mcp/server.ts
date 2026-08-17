/**
 * The HTTP surface: stateless streamable HTTP (MCP 2026-07-28) plus the OAuth
 * endpoints a custom connector discovers.
 *
 * **Sessions were retired in this revision and none are implemented.** Not "we
 * do not use them much" — there is no session id, no `Mcp-Session-Id` header, no
 * server-side per-connection state at all. Every request rebuilds its context
 * from the bearer grant. That is what lets a Durable Object route the same
 * tenant to whichever instance is warm, and it is what makes a rolling deploy
 * uneventful. It also removes the place continuity used to live: continuity now
 * comes from the brain (`briefing`), not from the transport.
 *
 * **Two endpoints, one dispatch.** `/mcp` is the portable surface (Claude
 * Desktop, Claude Code, anything unknown); `/openai` is the ChatGPT surface with
 * its mandated `search`/`fetch` pair advertised. The surface is selected by
 * *endpoint*, never by the caller's self-reported `clientInfo`: the spec makes
 * that field a SHOULD, and sniffing it means one missing header rejects a
 * connector outright. Both endpoints dispatch every name; only the advertised
 * list differs.
 *
 * **The OAuth half is here because a connector's first request is unauthorised
 * by design.** A 401 carrying `WWW-Authenticate: Bearer resource_metadata=…` is
 * how discovery starts, and the two well-known documents are what the client
 * reads next. The controls those documents advertise are the ones `oauth.ts`
 * enforces — S256 only, exact redirect matching, single-use codes — and this
 * file's job is not to quietly relax any of them on the wire.
 *
 * **The resource owner arrives one of two ways, and the difference is whether
 * the credential is ambient.** A machine presents the tenant's provisioned
 * bearer in a header — deliberate by construction, since no page can attach one
 * to a navigation it provoked — and gets a code. A *browser* presents the web
 * app's session cookie, which is ambient, so it gets a consent page and the code
 * is minted by the POST that page submits. Both end at one minting function.
 * See {@link handleAuthorize}.
 */

import { dispatch, type DispatchDeps, type DispatchResult } from './dispatch.ts';
import { SERVER_INSTRUCTIONS, INSTRUCTIONS_RELEASE } from './instructions.ts';
import {
  authorize,
  authorizationServerMetadata,
  consentToken,
  deriveSigningKey,
  issueTokens,
  protectedResourceMetadata,
  redeemAuthorizationCode,
  redeemRefreshToken,
  registerClient,
  stripBearer,
  tenantOfToken,
  verifyConsentToken,
  verifyTenantBearer,
  type ClientRecord,
  type RegistrationAllowlist,
} from './oauth.ts';
import { parseRequestedScope, type ScopedClaims } from './grant-scope.ts';
// **The CSRF posture is the web app's, imported rather than re-decided.** The
// session layer already chose it — `SameSite=Lax` plus an `Origin` check where
// *absent* is refused — and a second implementation of that decision on this
// surface is how the two stop agreeing. If this import's module-graph cost ever
// matters (it links the web app into the MCP container), the fix is to move
// `sameOriginRefusal` somewhere both units own, never to write a second one.
import { sameOriginRefusal } from '../web/app.ts';
// The five-character escaper, from the module that already owns it. A local copy
// would be the second implementation of the one primitive standing between a
// database-fed string and a rendered page.
import { escapeHtml } from '../web/pages.ts';
import { PROTOCOL_VERSION } from './envelope.ts';
import { readClientCapabilities, UI_EXTENSION } from './client-capabilities.ts';
import { listResources, readResource } from './resources.ts';
import { inputSchemaFor, listedTools, type Endpoint } from './tools/index.ts';
import { fleetIdentity } from '../control/secrets.ts';
import { DEFAULT_WRITE_ORIGIN } from './dispatch.ts';

/**
 * Who the browser at `/authorize` is, once its session has been resolved.
 *
 * `tenantId` is `null` for an account whose brain has not been provisioned —
 * a real state (`/api/brain` exists to retry it), and the one an
 * `accountId → tenantId` lookup that returned a string would have to invent.
 */
export interface ResolvedOwner {
  readonly accountId: string;
  /** The brain this account owns, or `null` when it has none yet. */
  readonly tenantId: string | null;
  /**
   * An opaque value that changes with the session and never leaves this process.
   *
   * The consent form's anti-CSRF token is derived from it (`oauth.ts:consentToken`),
   * which is the whole reason it is on this type: the token has to be bound to
   * *this* session, and this surface must not hold the session credential to do
   * it. A digest of the session token is the intended implementation.
   */
  readonly sessionKey: string;
}

/**
 * The resource owner, resolved from the web app's session cookie.
 *
 * **A port, and it takes the raw `Cookie` header on purpose.** The cookie's name
 * is the web app's business (`src/web/app.ts:SESSION_COOKIE`), the session table
 * is the identity database's, and this surface holds neither — R11 keeps the
 * identity store off the MCP fleet's manifest. So the composition root supplies
 * an implementation and this file learns only who the browser is.
 *
 * **Absent is not an error, it is a deployment fact.** A fleet wired to no
 * implementation cannot authenticate a browser at all, and `/authorize` answers
 * exactly what it answered before this existed: the `401` that starts discovery.
 * The alternative — a friendly page saying interactive login is unavailable —
 * would be a new sentence describing the same missing capability.
 */
export interface ResourceOwners {
  resolve(cookieHeader: string | null): Promise<ResolvedOwner | null>;
}

export interface ServerDeps extends Omit<DispatchDeps, 'endpoint'> {
  /** The public origin this server is reachable at. Used in discovery documents. */
  readonly issuer: string;
  readonly registrationAllowlist: RegistrationAllowlist;
  /** How a browser's session cookie becomes an account and a brain. */
  readonly resourceOwners?: ResourceOwners;
}

export interface McpServer {
  fetch(request: Request): Promise<Response>;
}

const ENDPOINT_BY_PATH: Readonly<Record<string, Endpoint>> = {
  '/mcp': 'mcp',
  '/openai': 'openai',
};

export function createMcpServer(deps: ServerDeps): McpServer {
  return {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);

      if (url.pathname === '/.well-known/oauth-protected-resource') {
        return Response.json(protectedResourceMetadata(deps.issuer, `${deps.issuer}/mcp`));
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return Response.json(authorizationServerMetadata(deps.issuer));
      }
      if (url.pathname === '/register' && request.method === 'POST') {
        return handleRegister(deps, request);
      }
      if (url.pathname === '/authorize') {
        return handleAuthorize(deps, request, url);
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        return handleToken(deps, request);
      }
      if (url.pathname === '/revoke' && request.method === 'POST') {
        return handleRevoke(deps, request);
      }

      const endpoint = ENDPOINT_BY_PATH[url.pathname];
      if (endpoint === undefined) return new Response('not found', { status: 404 });

      // Streamable HTTP's GET leg carries a server-initiated stream, which a
      // stateless server has nothing to put on. Refusing it is honest; a 200
      // with an idle stream would hold a container open for nothing.
      if (request.method !== 'POST') {
        return new Response('method not allowed', { status: 405, headers: { allow: 'POST' } });
      }

      return handleRpc(deps, request, endpoint);
    },
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC.
// ---------------------------------------------------------------------------

interface RpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

async function handleRpc(deps: ServerDeps, request: Request, endpoint: Endpoint): Promise<Response> {
  let body: RpcRequest;
  try {
    body = (await request.json()) as RpcRequest;
  } catch {
    return rpcError(null, -32700, 'the request body is not JSON');
  }
  if (typeof body?.method !== 'string') {
    return rpcError(body?.id ?? null, -32600, 'the request is not a JSON-RPC call');
  }

  const id = body.id ?? null;
  const authorization = request.headers.get('authorization');

  // 2026-07-28 puts the client's capabilities on **every** request rather than
  // on a handshake, which is what lets a stateless instance decide per call
  // whether this caller can render a panel or be asked a question. Absent reads
  // as absent, and every capability it carries widens what the caller may reach
  // — so the branch that grants least is the default. See
  // `client-capabilities.ts`.
  const clientCapabilities = readClientCapabilities(body.params?._meta);

  switch (body.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        // Resources are advertised because U14's panel is one, and it is the
        // only one: everything readable about the brain goes through the fenced
        // tool handlers. Prompts are user-controlled everywhere, so advertising
        // them would promise a channel this server does not serve.
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
          extensions: { [UI_EXTENSION]: {} },
        },
        serverInfo: { name: 'brainz', version: INSTRUCTIONS_RELEASE },
        instructions: SERVER_INSTRUCTIONS,
      });

    case 'ping':
      return rpcResult(id, {});

    case 'notifications/initialized':
      return new Response(null, { status: 202 });

    case 'tools/list':
      return rpcResult(id, {
        tools: listedTools(endpoint, clientCapabilities).map((listed) => ({
          name: listed.def.name,
          description: listed.def.description,
          inputSchema: inputSchemaFor(listed.def),
          annotations: listed.def.annotations,
          ...(listed.meta === undefined ? {} : { _meta: listed.meta }),
        })),
      });

    case 'resources/list':
      return rpcResult(id, { resources: listResources(clientCapabilities) });

    case 'resources/read': {
      const uri = typeof body.params?.uri === 'string' ? body.params.uri : '';
      const result = await readResource({ ...deps, endpoint }, { authorization, uri, clientCapabilities });
      if (result.error?.code === 'unauthorized') return unauthorized(deps);
      if (!result.ok) {
        return rpcError(id, -32002, result.error?.message ?? 'that resource could not be read');
      }
      return rpcResult(id, { contents: result.contents, _meta: result.meta });
    }

    case 'tools/call': {
      const name = typeof body.params?.name === 'string' ? body.params.name : '';
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;

      const result = await dispatch(
        { ...deps, endpoint },
        {
          authorization,
          tool: name,
          args,
          clientCapabilities,
          // SEP-2322's resume, read off the request rather than out of the
          // tool's arguments: a schema that declared a confirmation parameter
          // would be publishing a control the model gets to fill in.
          resume: {
            ...(typeof body.params?.requestState === 'string'
              ? { requestState: body.params.requestState }
              : {}),
            ...(isObject(body.params?.inputResponses)
              ? { inputResponses: body.params.inputResponses }
              : {}),
          },
        },
      );

      if (result.error?.code === 'unauthorized') return unauthorized(deps);
      return rpcResult(id, toolResult(result));
    }

    default:
      return rpcError(id, -32601, `unknown method ${JSON.stringify(body.method)}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A tool result, in both shapes a 2026-07-28 client may read.
 *
 * `structuredContent` is the machine lane and the text block is the fallback for
 * clients that only render text. They are the same object, serialised twice, on
 * purpose — a text block summarising the structured one is how the two drift.
 */
function toolResult(result: DispatchResult): Record<string, unknown> {
  const payload = result.ok
    ? { ...(result.content as Record<string, unknown>), ...result.envelope }
    : { error: result.error, ...result.envelope };

  return {
    // The `input_required` lift (SEP-2322). It is a *result type*, not an
    // error, so it sits beside the content rather than replacing it — and the
    // content is deliberately still there, because a client that ignores
    // multi-round-trip requests must read a plain sentence saying the change
    // needs confirming and where to make it, rather than an empty success.
    ...(result.inputRequired === undefined
      ? {}
      : {
          resultType: 'input_required',
          inputRequests: result.inputRequired.inputRequests,
          requestState: result.inputRequired.requestState,
        }),
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    _meta: result.meta,
    ...(result.ok ? {} : { isError: true }),
  };
}

function rpcResult(id: string | number | null, result: unknown): Response {
  return Response.json({ jsonrpc: '2.0', id, result });
}

function rpcError(id: string | number | null, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } });
}

/** The 401 that starts discovery. Without the pointer, a connector cannot begin. */
function unauthorized(deps: ServerDeps): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': `Bearer realm="brainz", resource_metadata="${deps.issuer}/.well-known/oauth-protected-resource"`,
    },
  });
}

// ---------------------------------------------------------------------------
// OAuth.
// ---------------------------------------------------------------------------

async function handleRegister(deps: ServerDeps, request: Request): Promise<Response> {
  let body: { client_name?: string; redirect_uris?: string[] };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: 'invalid_client_metadata' }, { status: 400 });
  }

  const outcome = registerClient(
    deps.store,
    { clientName: body.client_name ?? 'unnamed', redirectUris: body.redirect_uris ?? [] },
    { allowlist: deps.registrationAllowlist, now: deps.now().getTime() },
  );

  if (!outcome.ok) {
    return Response.json(
      { error: outcome.error, error_description: outcome.description },
      { status: outcome.error === 'rate_limited' ? 429 : 400 },
    );
  }
  return Response.json(outcome.client, { status: 201 });
}

/**
 * The authorization endpoint — **two ways in, one code-minting function.**
 *
 * **The machine way.** A caller holding the tenant's provisioned bearer presents
 * it in the `Authorization` header and a code is minted. That is how every test
 * in this repo and every non-browser client operates, and it is safe as a `GET`
 * for the reason the browser way is not: an `Authorization` header is not
 * ambient. No page can cause a browser to attach one to a navigation it
 * provoked, so a request carrying a valid bearer was made deliberately.
 *
 * **The browser way, which is what Claude's connector actually does.** It opens
 * `/authorize` in a window. A browser has no bearer, so before this the endpoint
 * answered `401` and the connector could not begin — the whole flow ended at its
 * first hop. It now resolves the web app's session cookie, and:
 *
 *   * **No session → the login page, carrying a return path.** Landing a user on
 *     a dashboard after they were sent somewhere to authorise something is
 *     losing the thing they were doing.
 *   * **A session whose account has no brain → a page that says so.** Not a
 *     `500`, and not a consent screen for a brain that does not exist:
 *     provisioning can fail (`/api/brain` is the retry) and this is the state
 *     that leaves behind.
 *   * **A session with a brain → a consent page, and a `GET` mints nothing.**
 *     A cookie is ambient and `SameSite=Lax` admits top-level cross-site
 *     navigations *by design*, because that is the shape an OAuth redirect has.
 *     So a `GET` that minted because a cookie was present would be a credential
 *     any page could cause a logged-in browser to issue. The code is minted by a
 *     `POST` carrying `oauth.ts:consentToken` — bound to the session, delivered
 *     only inside a page from this origin — and the `Origin` check the session
 *     layer already decided on, where absent is refused.
 *
 * Both ways end at {@link mintAuthorizationCode}. Two mint sites is two places
 * for the redirect check, the PKCE check and the scope decision to drift.
 */
async function handleAuthorize(deps: ServerDeps, request: Request, url: URL): Promise<Response> {
  const params = url.searchParams;

  // ---- The machine way. --------------------------------------------------
  //
  // Anything in the header is treated as an attempt to use it: a malformed or
  // wrong bearer is refused here rather than falling through to the browser
  // path, so a bad credential cannot become an anonymous request that gets a
  // login page instead of the `401` a client is waiting to see.
  const presented = stripBearer(request.headers.get('authorization') ?? '');
  if (presented.length > 0) {
    const tenantId = tenantOfToken(presented);
    if (tenantId === null) return unauthorized(deps);
    const resolved = await deps.secrets.resolve(fleetIdentity(tenantId), tenantId);
    if (!resolved.ok || !verifyTenantBearer(presented, resolved.secret.bearerGrant)) {
      return unauthorized(deps);
    }
    // 302, as it has always been. The machine path is a `GET` and its callers
    // read that status.
    return mintAuthorizationCode(deps, params, tenantId, 302);
  }

  // ---- The browser way. --------------------------------------------------
  const owners = deps.resourceOwners;
  if (owners === undefined) return unauthorized(deps);
  const owner = await owners.resolve(request.headers.get('cookie'));

  if (request.method === 'POST') {
    // The CSRF posture, in the order it has to run: an unacceptable `Origin`
    // is refused before the session is consulted, so a cross-site POST cannot
    // even learn whether the browser it rode in on was signed in.
    const refusal = sameOriginRefusal(request, deps.issuer);
    if (refusal !== null) {
      return oauthError('invalid_request', refusal, 403);
    }
    // An expired session is a sign-in, not a `500` and not a mint. The browser
    // gets the login page and the return path brings it back to this consent.
    if (owner === null) return signIn(deps, url);
    const form = new URLSearchParams(await request.text());
    if (!verifyConsentToken(form.get('consent') ?? '', owner.sessionKey)) {
      return oauthError(
        'invalid_request',
        'this consent was not the one this session was shown',
        403,
      );
    }
    if (owner.tenantId === null) return noBrainYet(deps);
    // 303 rather than 302: the browser must follow this with a `GET`, and the
    // one thing worse than a lost consent is a re-posted one.
    return mintAuthorizationCode(deps, params, owner.tenantId, 303);
  }

  if (request.method !== 'GET') {
    return new Response('method not allowed', { status: 405, headers: { allow: 'GET, POST' } });
  }

  if (owner === null) return signIn(deps, url);

  // **Everything the page will name is validated before the page is rendered.**
  // A consent screen naming an unregistered client, or a redirect target that is
  // not the registered string, is a phishing page this server wrote and signed
  // with its own origin.
  const client = deps.store.getClient(params.get('client_id') ?? '');
  if (client === undefined) return oauthError('invalid_client', 'unknown client_id', 400);
  const redirectUri = params.get('redirect_uri') ?? '';
  if (!client.redirectUris.includes(redirectUri)) {
    return oauthError('invalid_request', 'redirect_uri does not match a registered value', 400);
  }
  const requested = parseRequestedScope(params.get('scope'), deps.writeOrigin ?? DEFAULT_WRITE_ORIGIN);
  if (!requested.ok) return oauthError('invalid_scope', requested.reason, 400);

  if (owner.tenantId === null) return noBrainYet(deps);

  return consentPage({
    client,
    redirectUri,
    query: url.search,
    scoped: requested.scoped,
    sessionKey: owner.sessionKey,
  });
}

/**
 * **The one place a code is minted**, reached by the bearer path and by the
 * consent POST alike.
 *
 * The tenant is a parameter because the two ways in establish it differently —
 * one verifies a bearer, the other resolves a session — and *nothing else*
 * differs. In particular the scope decision happens here, so a consent page
 * cannot describe one grant while the mint issues another.
 */
async function mintAuthorizationCode(
  deps: ServerDeps,
  params: URLSearchParams,
  tenantId: string,
  status: 302 | 303,
): Promise<Response> {
  const endpoint = params.get('resource')?.endsWith('/openai') === true ? 'openai' : 'mcp';

  // **U18: this is where a work-connector grant becomes obtainable.** Before it,
  // every narrowed grant in the codebase was minted by a test helper — the fence
  // was real and nothing could ask for it, which is a fence with no product.
  //
  // `scope` is OAuth's own parameter, so a client asks for a work connector the
  // way it asks for anything else. Absent still means the whole brain, because
  // every connector shipping today sends no scope; an *unrecognised* token is
  // refused rather than defaulted, because a client that asked for a slice and
  // silently received the brain has been over-granted invisibly from both ends.
  const requested = parseRequestedScope(params.get('scope'), deps.writeOrigin ?? DEFAULT_WRITE_ORIGIN);
  if (!requested.ok) return oauthError('invalid_scope', requested.reason, 400);

  const outcome = authorize(deps.store, {
    clientId: params.get('client_id') ?? '',
    redirectUri: params.get('redirect_uri') ?? '',
    codeChallenge: params.get('code_challenge') ?? '',
    codeChallengeMethod: params.get('code_challenge_method') ?? '',
    state: params.get('state') ?? '',
    tenantId,
    // Spread, so the three halves of a scope cannot be assembled inconsistently
    // here: `contextGrant` derives the write origin from the class rather than
    // accepting one, and `authorize` refuses the combination again at mint.
    ...requested.scoped,
    endpoint,
    now: deps.now().getTime(),
  });

  if (!outcome.ok) return oauthError(outcome.error, outcome.description, 400);
  return new Response(null, { status, headers: { location: outcome.redirectTo } });
}

function oauthError(error: string, description: string, status: number): Response {
  return Response.json({ error, error_description: description }, { status });
}

/**
 * Where the browser goes when it has no session, and where it comes back to.
 *
 * **The return path is the requirement.** Without it a user who followed a
 * connector's link signs in and arrives at a dashboard, with no sign that they
 * were halfway through authorising something and no way back to it but the
 * connector's own retry. It is a path rather than a URL because the login page
 * refuses anything else (`src/web/app.ts:returnPathAfterLogin`) — an open
 * redirector on the login form would be a nastier bug than the one being fixed.
 *
 * **The web app is assumed to share this origin**, which is how the deployment
 * is actually shaped: the edge path-routes `/login` and `/authorize` to
 * different containers behind one host, and that is also what makes the session
 * cookie reach this endpoint at all. A split-origin deployment would need a
 * cross-origin handshake, not a redirect, and it would fail visibly here rather
 * than quietly — the cookie would never arrive and this would loop.
 */
function signIn(deps: ServerDeps, url: URL): Response {
  const base = (deps.webAppBaseUrl ?? deps.issuer).replace(/\/+$/, '');
  const next = `${url.pathname}${url.search}`;
  return new Response(null, {
    status: 302,
    headers: { location: `${base}/login?next=${encodeURIComponent(next)}` },
  });
}

/**
 * The honest answer for a session whose account has no brain.
 *
 * A `409` rather than a `500` (nothing failed) and rather than a `200` (the
 * request cannot be satisfied). The page says which of the two states this is —
 * provisioning has not run, or it ran and failed — because the retry lives on
 * the dashboard and a user who is told nothing has no reason to go there.
 */
function noBrainYet(deps: ServerDeps): Response {
  const base = (deps.webAppBaseUrl ?? deps.issuer).replace(/\/+$/, '');
  return htmlPage(
    'No brain to connect — brainz',
    `<h1>There is no brain here yet</h1>
<p>You are signed in, but this account has no brain for a connector to reach. That happens when
provisioning has not finished, or when it failed during signup.</p>
<p><a href="${escapeHtml(`${base}/dashboard`)}">Open your dashboard</a> — it can build one — and then
start the connection again from the beginning.</p>
<p class="note">Nothing was granted, and no connection was made.</p>`,
    409,
  );
}

interface ConsentView {
  readonly client: ClientRecord;
  readonly redirectUri: string;
  /** The original query string, replayed on the form's action. */
  readonly query: string;
  readonly scoped: ScopedClaims;
  readonly sessionKey: string;
}

/**
 * The consent page.
 *
 * **The parameters travel on the form's `action`, not in hidden fields.** For a
 * `POST` the browser keeps the action's query string, so the handler parses one
 * set of parameters from one place on both methods — and a hidden field is no
 * more trustworthy than a query parameter anyway, which is why the `POST` path
 * re-validates every one of them at the mint rather than believing this page.
 *
 * The only thing the form carries is the consent token, which is the only thing
 * on the page an attacker's copy could not have.
 */
function consentPage(view: ConsentView): Response {
  const name = view.client.clientName;
  return htmlPage(
    'Connect to brainz',
    `<h1>Connect ${escapeHtml(name)} to your brain?</h1>
<p><strong>${escapeHtml(name)}</strong> is asking for access to this brain.</p>
<h2>What it will be able to do</h2>
<p>${escapeHtml(scopeSentence(view.scoped))}</p>
<h2>Where you will be sent back to</h2>
<p><code>${escapeHtml(view.redirectUri)}</code></p>
<p class="note">Check that address. It is the only place the resulting credential is delivered, and it
is one this server registered in advance — if it is not somewhere you expect, close this page.</p>
<form method="post" action="/authorize${escapeHtml(view.query)}">
  <input type="hidden" name="consent" value="${escapeHtml(consentToken(view.sessionKey))}">
  <button type="submit">Connect</button>
</form>
<p class="note">Nothing is granted until you press that. Closing this page grants nothing, and so does
arriving here from a link you did not follow deliberately.</p>`,
    200,
  );
}

/** What the grant on offer amounts to, in a sentence a person can act on. */
function scopeSentence(scoped: ScopedClaims): string {
  if (scoped.scope === 'whole_brain') {
    return 'Read everything in this brain, and add to it. This is the whole brain, not a part of it.';
  }
  return (
    `Read and add to these parts of this brain only: ${scoped.origins.join(', ')}. ` +
    `Anything filed anywhere else stays out of reach.`
  );
}

/**
 * An HTML answer from the MCP surface, with the same posture the web app's pages
 * carry: no third-party anything, and a policy that says so.
 */
function htmlPage(title: string, main: string, status: number): Response {
  return new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 44rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.1rem; margin-top: 2rem; }
  button { font: inherit; padding: 0.5rem 1rem; margin-top: 1rem; cursor: pointer; }
  code { padding: 0.15rem 0.35rem; background: rgba(127,127,127,0.15); border-radius: 3px; word-break: break-all; }
  .note { opacity: 0.75; font-size: 0.9rem; }
</style></head>
<body><main>${main}</main></body></html>`,
    {
      status,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
        'referrer-policy': 'same-origin',
        'x-content-type-options': 'nosniff',
        // A consent page is per-session and carries a token bound to it. A cache
        // that kept one would hand the next visitor somebody else's.
        'cache-control': 'no-store',
      },
    },
  );
}

async function handleToken(deps: ServerDeps, request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  const grantType = form.get('grant_type') ?? '';
  const clientId = form.get('client_id') ?? '';
  const now = deps.now().getTime();

  const redeemed =
    grantType === 'authorization_code'
      ? redeemAuthorizationCode(deps.store, {
          code: form.get('code') ?? '',
          codeVerifier: form.get('code_verifier') ?? '',
          redirectUri: form.get('redirect_uri') ?? '',
          clientId,
          now,
        })
      : grantType === 'refresh_token'
        ? redeemRefreshToken(deps.store, { refreshToken: form.get('refresh_token') ?? '', clientId, now })
        : null;

  if (redeemed === null) {
    return Response.json({ error: 'unsupported_grant_type' }, { status: 400 });
  }
  if (!redeemed.ok) {
    return Response.json({ error: redeemed.error, error_description: redeemed.description }, { status: 400 });
  }

  const resolved = await deps.secrets.resolve(fleetIdentity(redeemed.grant.tenantId), redeemed.grant.tenantId);
  if (!resolved.ok) return Response.json({ error: 'invalid_grant' }, { status: 400 });

  const tokens = issueTokens(deps.store, {
    grant: redeemed.grant,
    signingKey: deriveSigningKey(resolved.secret.bearerGrant),
    now,
  });

  return Response.json(tokens, { headers: { 'cache-control': 'no-store' } });
}

/**
 * Revocation, behind the resource owner's credential.
 *
 * **It is a write, and it was reachable by anyone.** The version this replaced
 * took a `grant_id` from an unauthenticated form post and retired it — so any
 * caller holding a grant id, from a support transcript, a client log or a
 * screen share, could close a stranger's connector. Revocation ids are
 * unguessable, which bounds the exposure and does not make an open write
 * endpoint on a public issuer acceptable.
 *
 * **Authenticating says who is asking; it does not say what they may retire.**
 * The version before this one stopped at the first half: it proved the caller
 * held *a* tenant bearer and then acted on a grant id, so an authenticated
 * tenant presenting a stranger's grant id retired the stranger's connector. The
 * unguessability of the id was doing the whole job, and support transcripts,
 * client logs and screen shares are all places it stops being unguessable. So
 * the revocation list is keyed on `(tenant, grant)` and the tenant handed to it
 * is the one this function just authenticated — never one the caller supplied.
 *
 * The answer stays 200 either way. RFC 7009 is explicit that revocation must not
 * report whether a token was known, and a refusal here would turn the endpoint
 * into an oracle for which grant ids exist on which tenant — which is a better
 * disclosure channel than the one being closed.
 */
async function handleRevoke(deps: ServerDeps, request: Request): Promise<Response> {
  const presented = stripBearer(request.headers.get('authorization') ?? '');
  const tenantId = tenantOfToken(presented);
  if (tenantId === null) return unauthorized(deps);

  const resolved = await deps.secrets.resolve(fleetIdentity(tenantId), tenantId);
  if (!resolved.ok || !verifyTenantBearer(presented, resolved.secret.bearerGrant)) {
    return unauthorized(deps);
  }

  const form = new URLSearchParams(await request.text());
  const grantId = form.get('grant_id') ?? '';
  if (grantId.length > 0) deps.store.revokeGrant(tenantId, grantId);
  // RFC 7009: revocation answers 200 whether or not the token was known, so the
  // endpoint is not an oracle for which grant ids exist.
  return new Response(null, { status: 200 });
}
