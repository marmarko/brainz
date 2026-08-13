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

  test('tools/list advertises seven names and the endpoint decides which seven', async () => {
    const portable = (await (await server.fetch(rpc('tools/list', {}))).json()) as {
      result: { tools: { name: string }[] };
    };
    const openai = (await (
      await server.fetch(rpc('tools/list', {}, { path: '/openai' }))
    ).json()) as { result: { tools: { name: string }[] } };

    const portableNames = portable.result.tools.map((tool) => tool.name);
    const openaiNames = openai.result.tools.map((tool) => tool.name);

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
