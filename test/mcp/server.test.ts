/**
 * The HTTP surface: stateless streamable HTTP per MCP 2026-07-28, plus the
 * OAuth endpoints a custom connector discovers.
 *
 * **Statelessness is a property to test, not a design note.** Sessions were
 * retired in the 2026-07-28 revision, and the failure mode of "we kept a little
 * state anyway" is invisible until a second container instance answers a request
 * the first one thought it owned. So the guard asserts the absence of a session
 * header, and that two calls carrying nothing but the bearer both work.
 *
 * **The OAuth endpoints are tested here as HTTP**, because the flow's controls
 * live half in `oauth.ts` (asserted directly in `test/mcp/oauth/`) and half in
 * how this file wires them — a discovery document advertising `plain`, or a
 * token endpoint that skips the PKCE check, would leave `oauth.ts` green.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { createMcpServer } from '../../src/mcp/server.ts';
import { createMcpFixture, type McpFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');

let fixture: McpFixture;
let server: { fetch(request: Request): Promise<Response> };

beforeAll(async () => {
  fixture = await createMcpFixture('mcp_server');
  server = createMcpServer({
    ...fixture.deps,
    issuer: 'https://mcp.brainz.test',
    registrationAllowlist: { redirectUris: [REDIRECT], maxRegistrationsPerHour: 10 },
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

function rpc(method: string, params: unknown, options: { readonly path?: string; readonly bearer?: string | null } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const bearer = options.bearer === undefined ? fixture.bearer : options.bearer;
  if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
  return new Request(`https://mcp.brainz.test${options.path ?? '/mcp'}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
}

describe('stateless streamable HTTP', () => {
  test('initialize answers with the protocol version and the instructions', async () => {
    const response = await server.fetch(rpc('initialize', { protocolVersion: '2026-07-28' }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: Record<string, any> };
    expect(body.result.protocolVersion).toBe('2026-07-28');
    expect(body.result.instructions).toContain('CONSULT IT FIRST');
    expect(body.result.capabilities.tools).toBeDefined();
  });

  test('no session id is minted, on any response', async () => {
    const initialize = await server.fetch(rpc('initialize', {}));
    expect(initialize.headers.get('mcp-session-id')).toBeNull();
    const listed = await server.fetch(rpc('tools/list', {}));
    expect(listed.headers.get('mcp-session-id')).toBeNull();
    const body = await listed.text();
    expect(body.toLowerCase()).not.toContain('sessionid');
  });

  test('a request carrying only the bearer works twice in a row, in either order', async () => {
    const first = await server.fetch(rpc('tools/list', {}));
    const second = await server.fetch(rpc('tools/list', {}));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  test('tools/list names seven for a model, and the endpoint decides which seven', async () => {
    // **The seven is now a property of the *host*, not of the list.** U14 lists
    // `manage` with `_meta.ui.visibility: ["app"]` to a client that declared the
    // MCP Apps extension, because a conformant host MUST reject an app's call to
    // a tool that does not carry it — so the tool has to be in the list for the
    // panel to reach it, and the host is what keeps it out of the model's view.
    // The assertion below is therefore "seven model-visible", not "seven rows".
    const uiMeta = {
      'io.modelcontextprotocol/clientCapabilities': {
        extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } },
      },
    };
    type Listed = { name: string; _meta?: { ui?: { visibility?: string[] } } };

    const portable = (await (await server.fetch(rpc('tools/list', { _meta: uiMeta }))).json()) as {
      result: { tools: Listed[] };
    };
    const openai = (await (
      await server.fetch(rpc('tools/list', { _meta: uiMeta }, { path: '/openai' }))
    ).json()) as { result: { tools: Listed[] } };

    const modelVisible = (tools: Listed[]): string[] =>
      tools
        .filter((tool) => tool._meta?.ui?.visibility?.includes('model') !== false)
        .map((tool) => tool.name);

    const portableNames = modelVisible(portable.result.tools);
    const openaiNames = modelVisible(openai.result.tools);

    expect(portableNames).toHaveLength(7);
    expect(openaiNames).toHaveLength(7);
    expect(portableNames).toContain('recall');
    expect(portableNames).not.toContain('search');
    expect(openaiNames).toContain('search');
    expect(openaiNames).not.toContain('recall');
    for (const names of [portableNames, openaiNames]) {
      expect(names).not.toContain('manage');
      expect(names).not.toContain('synthesize');
    }

    // The panel's carrier: a host preloads the view from a tool the model can
    // call, and `manage` is app-only by construction.
    const brain = portable.result.tools.find((tool) => tool.name === 'brain');
    expect((brain?._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri).toBe(
      'ui://brainz/panel',
    );
  });

  test('a client without the ui extension sees manage as an ordinary eighth name', async () => {
    // The roadmap's stated fallback cost, asserted rather than assumed. The
    // replacement control is not the listing — it is the confirm gate, which
    // `test/mcp/manage.test.ts` walks.
    const body = (await (await server.fetch(rpc('tools/list', {}))).json()) as {
      result: { tools: { name: string; _meta?: unknown }[] };
    };
    const names = body.result.tools.map((tool) => tool.name);
    expect(names).toHaveLength(8);
    expect(names).toContain('manage');
    expect(body.result.tools.find((tool) => tool.name === 'manage')?._meta).toBeUndefined();

    const openai = (await (
      await server.fetch(rpc('tools/list', {}, { path: '/openai' }))
    ).json()) as { result: { tools: { name: string }[] } };
    // `/openai` never dispatches it, so it is never listed there either.
    expect(openai.result.tools.map((tool) => tool.name)).not.toContain('manage');
  });

  test('every advertised tool ships a schema and annotations on the wire', async () => {
    const body = (await (await server.fetch(rpc('tools/list', {}))).json()) as {
      result: { tools: { name: string; inputSchema: Record<string, unknown>; annotations: Record<string, unknown> }[] };
    };
    for (const tool of body.result.tools) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.annotations.openWorldHint).toBe(false);
    }
  });

  test('tools/call reaches dispatch and returns both content shapes', async () => {
    const response = await server.fetch(rpc('tools/call', { name: 'brain', arguments: {} }));
    const body = (await response.json()) as {
      result: { content: { type: string; text: string }[]; structuredContent: Record<string, unknown>; _meta: Record<string, unknown> };
    };
    expect(body.result.structuredContent).toBeDefined();
    expect(body.result.content[0]?.type).toBe('text');
    expect(body.result._meta['brainz.app/brain']).toBeDefined();
  });

  test('a tool error is a tool result with isError, not a JSON-RPC error', async () => {
    const response = await server.fetch(rpc('tools/call', { name: 'synthesize', arguments: {} }));
    const body = (await response.json()) as { result?: { isError?: boolean }; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(true);
  });

  /**
   * The failure this pins: the error code was reachable only by unwrapping.
   *
   * brainz deliberately adopted the memory-verbs error vocabulary — `ErrorCode`
   * in `tools/context.ts` is that enum — and then shipped it inside a container
   * nothing else parses. Every reader of this surface, including the protocol's
   * own conformance runner, reads `body.error` as the code STRING with
   * `message` and `suggestion` as its siblings; brainz answered with
   * `body.error = {code, message}`, so a caller checking `error === 'not_found'`
   * saw `[object Object]` and could not branch on any refusal at all. The
   * nesting was never argued anywhere: it is not in `ENVELOPE_KEYS`, not in the
   * tool-surface design's error contract, and was bolted on at serialisation.
   */
  test('an error result names its code at the top level, beside message', async () => {
    const response = await server.fetch(rpc('tools/call', { name: 'synthesize', arguments: {} }));
    const body = (await response.json()) as {
      result: { content: { text: string }[]; structuredContent: Record<string, unknown> };
    };
    const payload = body.result.structuredContent;
    expect(payload.error).toBe('unavailable');
    expect(typeof payload.message).toBe('string');
    expect(payload.protocol_version).toBe(1);
    // The text lane is the same object serialised, never a summary of it — a
    // client reading only text must be able to branch on the same code.
    expect(JSON.parse(body.result.content[0]?.text ?? '{}')).toEqual(payload);
  });

  test('an unparseable body is a JSON-RPC parse error, not a 500', async () => {
    const response = await server.fetch(
      new Request('https://mcp.brainz.test/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${fixture.bearer}` },
        body: '{not json',
      }),
    );
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });
});

describe('the 401 points at discovery', () => {
  test('an unauthenticated tools/call answers 401 with a resource-metadata pointer', async () => {
    const response = await server.fetch(rpc('tools/call', { name: 'brain', arguments: {} }, { bearer: null }));
    expect(response.status).toBe(401);
    const header = response.headers.get('www-authenticate') ?? '';
    expect(header).toContain('Bearer');
    expect(header).toContain('resource_metadata=');
  });

  test('protected-resource metadata names this issuer', async () => {
    const response = await server.fetch(
      new Request('https://mcp.brainz.test/.well-known/oauth-protected-resource'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { authorization_servers: string[] };
    expect(body.authorization_servers).toContain('https://mcp.brainz.test');
  });

  test('authorization-server metadata advertises S256 and refuses to advertise plain', async () => {
    const response = await server.fetch(
      new Request('https://mcp.brainz.test/.well-known/oauth-authorization-server'),
    );
    const body = (await response.json()) as {
      code_challenge_methods_supported: string[];
      grant_types_supported: string[];
    };
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.code_challenge_methods_supported).not.toContain('plain');
    expect(body.grant_types_supported).toContain('refresh_token');
  });
});

describe('the flow, over HTTP', () => {
  async function register(): Promise<string> {
    const response = await server.fetch(
      new Request('https://mcp.brainz.test/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Claude Desktop', redirect_uris: [REDIRECT] }),
      }),
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as { client_id: string };
    return body.client_id;
  }

  test('register → authorize → token → call, end to end', async () => {
    const clientId = await register();

    const authorizeUrl = new URL('https://mcp.brainz.test/authorize');
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', REDIRECT);
    authorizeUrl.searchParams.set('code_challenge', CHALLENGE);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', 'state-1');
    authorizeUrl.searchParams.set('response_type', 'code');

    const authorized = await server.fetch(
      new Request(authorizeUrl.toString(), { headers: { authorization: `Bearer ${fixture.bearer}` } }),
    );
    expect(authorized.status).toBe(302);
    const location = new URL(authorized.headers.get('location') ?? '');
    expect(location.searchParams.get('state')).toBe('state-1');
    const code = location.searchParams.get('code') ?? '';
    expect(code.length).toBeGreaterThan(0);

    const tokenResponse = await server.fetch(
      new Request('https://mcp.brainz.test/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: VERIFIER,
          redirect_uri: REDIRECT,
          client_id: clientId,
        }).toString(),
      }),
    );
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as { access_token: string; refresh_token: string; expires_in: number };
    expect(tokens.expires_in).toBeGreaterThan(0);

    const called = await server.fetch(
      rpc('tools/call', { name: 'brain', arguments: {} }, { bearer: tokens.access_token }),
    );
    const body = (await called.json()) as { result: { isError?: boolean } };
    expect(body.result.isError).toBeUndefined();
  });

  test('authorize without the resource owner’s credential does not mint a code', async () => {
    const clientId = await register();
    const url = new URL('https://mcp.brainz.test/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', REDIRECT);
    url.searchParams.set('code_challenge', CHALLENGE);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', 'state-2');

    const response = await server.fetch(new Request(url.toString()));
    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
  });

  test('the token endpoint refuses a mismatched verifier over HTTP too', async () => {
    const clientId = await register();
    const url = new URL('https://mcp.brainz.test/authorize');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', REDIRECT);
    url.searchParams.set('code_challenge', CHALLENGE);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', 'state-3');
    const authorized = await server.fetch(
      new Request(url.toString(), { headers: { authorization: `Bearer ${fixture.bearer}` } }),
    );
    const code = new URL(authorized.headers.get('location') ?? '').searchParams.get('code') ?? '';

    const response = await server.fetch(
      new Request('https://mcp.brainz.test/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: 'not-the-verifier-at-all-not-even-close-x',
          redirect_uri: REDIRECT,
          client_id: clientId,
        }).toString(),
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe('invalid_grant');
  });

  test('registration outside the allowlist is refused over HTTP', async () => {
    const response = await server.fetch(
      new Request('https://mcp.brainz.test/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Evil', redirect_uris: ['https://evil.example/cb'] }),
      }),
    );
    expect(response.status).toBe(400);
  });
});

/**
 * The handshake a connector actually performs, as opposed to the one this suite
 * used to perform on its behalf.
 *
 * Every test above asked for the revision the server already served, so the
 * whole negotiation branch was exercised by nothing: `initialize` answered
 * `PROTOCOL_VERSION` unconditionally and the suite agreed with it unconditionally.
 * A client built against an older revision was therefore told it was talking to
 * something it could not speak, and its disconnect during discovery renders in a
 * connector list as an empty tool list rather than as an error — which is the
 * shape this pair of gaps was reported in.
 */
describe('the discovery handshake', () => {
  test('a revision this surface can serve is echoed rather than overridden', async () => {
    for (const requested of ['2025-06-18', '2025-11-25', '2026-07-28']) {
      const response = await server.fetch(rpc('initialize', { protocolVersion: requested }));
      const body = (await response.json()) as { result: { protocolVersion: string } };
      expect(body.result.protocolVersion).toBe(requested);
    }
  });

  test('a revision this surface cannot serve is answered with the one it does', async () => {
    // `2025-03-26` and everything before it made JSON-RPC batching mandatory,
    // and this surface has never decoded a batch. Echoing it would promise a
    // framing we do not parse — the spec's fallback is to name our own revision
    // and let the client decide whether it can proceed.
    for (const requested of ['2024-11-05', '2025-03-26', 'not-a-version']) {
      const response = await server.fetch(rpc('initialize', { protocolVersion: requested }));
      const body = (await response.json()) as { result: { protocolVersion: string } };
      expect(body.result.protocolVersion).toBe('2026-07-28');
    }
  });

  test('a missing protocolVersion is answered, not thrown on', async () => {
    const response = await server.fetch(rpc('initialize', {}));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe('2026-07-28');
  });

  test('both halves of the advertised resources capability answer', async () => {
    // The capability advertised in `initialize` is what invites both calls.
    // `-32601` to one half of a capability the server itself claimed is a
    // contradiction, and a client resolves it by abandoning discovery.
    const initialize = await server.fetch(rpc('initialize', { protocolVersion: '2026-07-28' }));
    const capabilities = (await initialize.json()) as { result: { capabilities: Record<string, unknown> } };
    expect(capabilities.result.capabilities.resources).toBeDefined();

    for (const method of ['resources/list', 'resources/templates/list']) {
      const response = await server.fetch(rpc(method, {}));
      const body = (await response.json()) as { result?: unknown; error?: unknown };
      expect(body.error).toBeUndefined();
      expect(body.result).toBeDefined();
    }
  });

  test('templates are an empty list under the key the spec names', async () => {
    const response = await server.fetch(rpc('resources/templates/list', {}));
    const body = (await response.json()) as { result: { resourceTemplates: unknown[] } };
    expect(body.result.resourceTemplates).toEqual([]);
  });
});
