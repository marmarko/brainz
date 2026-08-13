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
 * **The resource owner, in alpha, is whoever holds the tenant's provisioned
 * bearer.** `/authorize` therefore authenticates with it rather than rendering a
 * consent screen: alpha is one founder and two known clients, and a login page
 * with no identity system behind it would be theatre. U15 replaces this step
 * with a real session without changing the token surface.
 */

import { dispatch, type DispatchDeps, type DispatchResult } from './dispatch.ts';
import { SERVER_INSTRUCTIONS, INSTRUCTIONS_RELEASE } from './instructions.ts';
import {
  authorize,
  authorizationServerMetadata,
  deriveSigningKey,
  issueTokens,
  protectedResourceMetadata,
  redeemAuthorizationCode,
  redeemRefreshToken,
  registerClient,
  stripBearer,
  tenantOfToken,
  verifyTenantBearer,
  type RegistrationAllowlist,
} from './oauth.ts';
import { PROTOCOL_VERSION } from './envelope.ts';
import { advertisedTools, inputSchemaFor, type Endpoint } from './tools/index.ts';
import { fleetIdentity } from '../control/secrets.ts';
import { DEFAULT_WRITE_ORIGIN } from './dispatch.ts';

export interface ServerDeps extends Omit<DispatchDeps, 'endpoint'> {
  /** The public origin this server is reachable at. Used in discovery documents. */
  readonly issuer: string;
  readonly registrationAllowlist: RegistrationAllowlist;
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

  switch (body.method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        // Tools only. Resources exist for the panel view (U14) and prompts are
        // user-controlled everywhere, so advertising either here would promise a
        // channel this server does not serve.
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'brainz', version: INSTRUCTIONS_RELEASE },
        instructions: SERVER_INSTRUCTIONS,
      });

    case 'ping':
      return rpcResult(id, {});

    case 'notifications/initialized':
      return new Response(null, { status: 202 });

    case 'tools/list':
      return rpcResult(id, {
        tools: advertisedTools(endpoint).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: inputSchemaFor(tool),
          annotations: tool.annotations,
        })),
      });

    case 'tools/call': {
      const name = typeof body.params?.name === 'string' ? body.params.name : '';
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;

      const result = await dispatch(
        { ...deps, endpoint },
        { authorization, tool: name, args },
      );

      if (result.error?.code === 'unauthorized') return unauthorized(deps);
      return rpcResult(id, toolResult(result));
    }

    default:
      return rpcError(id, -32601, `unknown method ${JSON.stringify(body.method)}`);
  }
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
 * The authorization endpoint.
 *
 * The resource owner authenticates with the tenant's provisioned bearer, and the
 * grant that results carries the **whole brain** — an empty `origins` array is
 * dispatch's marker for that, and narrowing it is U15's consent screen to build.
 * Issuing a narrower grant here without a UI to choose it would be a scope the
 * user never saw and could not change.
 */
async function handleAuthorize(deps: ServerDeps, request: Request, url: URL): Promise<Response> {
  const presented = stripBearer(request.headers.get('authorization') ?? '');
  const tenantId = tenantOfToken(presented);
  if (tenantId === null) return unauthorized(deps);

  const resolved = await deps.secrets.resolve(fleetIdentity(tenantId), tenantId);
  if (!resolved.ok || !verifyTenantBearer(presented, resolved.secret.bearerGrant)) {
    return unauthorized(deps);
  }

  const params = url.searchParams;
  const endpoint = params.get('resource')?.endsWith('/openai') === true ? 'openai' : 'mcp';

  const outcome = authorize(deps.store, {
    clientId: params.get('client_id') ?? '',
    redirectUri: params.get('redirect_uri') ?? '',
    codeChallenge: params.get('code_challenge') ?? '',
    codeChallengeMethod: params.get('code_challenge_method') ?? '',
    state: params.get('state') ?? '',
    tenantId,
    origins: [],
    writeOrigin: deps.writeOrigin ?? DEFAULT_WRITE_ORIGIN,
    endpoint,
    now: deps.now().getTime(),
  });

  if (!outcome.ok) {
    return Response.json({ error: outcome.error, error_description: outcome.description }, { status: 400 });
  }
  return new Response(null, { status: 302, headers: { location: outcome.redirectTo } });
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
 * The residual, written down rather than discovered: the store's revocation
 * list is keyed by grant id alone and holds no tenant, so an *authenticated*
 * tenant presenting another tenant's grant id would still retire it. Closing
 * that needs a tenant column on the revocation record, which belongs with the
 * durable store U15 owns; this is the half that can be closed here.
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
  if (grantId.length > 0) deps.store.revokeGrant(grantId);
  // RFC 7009: revocation answers 200 whether or not the token was known, so the
  // endpoint is not an oracle for which grant ids exist.
  return new Response(null, { status: 200 });
}
