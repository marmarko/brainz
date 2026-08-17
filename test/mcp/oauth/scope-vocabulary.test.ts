/**
 * The scope vocabulary: what the discovery documents advertise, and what the
 * parser will actually sign.
 *
 * **The defect this pins.** Two documents described one resource and disagreed:
 * `/.well-known/oauth-protected-resource` published `['brain.read',
 * 'brain.write']` while `/.well-known/oauth-authorization-server` published
 * `['brainz:context:personal', 'brainz:context:work']`, and
 * `parseRequestedScope` honoured neither list — it accepted only the second
 * family, one token at a time. Claude reads the resource document, concatenated
 * what it found, and was refused `invalid_scope` by its own issuer.
 *
 * So the load-bearing test here is not "the lists are equal". It is **a client
 * that asks for exactly what a document advertises gets a grant** — which is the
 * behaviour that was broken, and which stays broken under any fix that only
 * makes two arrays match.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { createMcpServer } from '../../../src/mcp/server.ts';
import {
  CONTEXT_SCOPES_METADATA_FIELD,
  SUPPORTED_SCOPES,
  authorizationServerMetadata,
  createInMemoryAuthorizationStore,
  issueTokens,
  protectedResourceMetadata,
  registerClient,
  type CodeRecord,
} from '../../../src/mcp/oauth.ts';
import {
  ACCESS_SCOPES,
  ACCESS_SCOPE_READ,
  ACCESS_SCOPE_WRITE,
  CONTEXT_SCOPES,
  parseRequestedScope,
} from '../../../src/mcp/grant-scope.ts';
import { createMcpFixture, type McpFixture } from '../fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const ISSUER = 'https://brainz.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const CHALLENGE = createHash('sha256').update('verifier', 'ascii').digest('base64url');
const WHOLE_BRAIN_WRITE = 'personal:agent';

let fixture: McpFixture;
let clientId: string;

beforeAll(async () => {
  fixture = await createMcpFixture('mcp_scope_vocab');
  const registered = registerClient(
    fixture.deps.store,
    { clientName: 'Claude', redirectUris: [REDIRECT] },
    { allowlist: { redirectUris: [REDIRECT], maxRegistrationsPerHour: 50 }, now: fixture.now() },
  );
  if (!registered.ok) throw new Error('fixture client did not register');
  clientId = registered.client.client_id;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

/** Run the flow the way a connector does, and hand back the banked record. */
async function flow(scope: string | null): Promise<{ status: number; record?: CodeRecord }> {
  const server = createMcpServer({
    ...fixture.deps,
    issuer: ISSUER,
    registrationAllowlist: { redirectUris: [REDIRECT], maxRegistrationsPerHour: 50 },
  });
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'state-1',
    ...(scope === null ? {} : { scope }),
  });
  const response = await server.fetch(
    new Request(`${ISSUER}/authorize?${params.toString()}`, {
      headers: { authorization: `Bearer ${fixture.bearer}` },
    }),
  );
  if (response.status !== 302) return { status: response.status };
  const code = new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const record = fixture.deps.store.takeCode(code);
  return { status: response.status, ...(record === undefined ? {} : { record }) };
}

describe('the two discovery documents', () => {
  test('advertise the same scopes, because they describe one resource', () => {
    const resource = protectedResourceMetadata(ISSUER, `${ISSUER}/mcp`);
    const server = authorizationServerMetadata(ISSUER);
    expect(resource.scopes_supported).toEqual(server.scopes_supported);
    expect(resource.scopes_supported).toEqual([...SUPPORTED_SCOPES]);
  });

  /**
   * **The one that would have caught the live failure.** Claude concatenates
   * `scopes_supported` into its request — that is how `brain.read` and
   * `brain.write` arrived together — so every advertised list has to be a
   * request this server answers.
   */
  test('a client that asks for exactly what a document advertises is granted, not refused', () => {
    for (const document of [
      protectedResourceMetadata(ISSUER, `${ISSUER}/mcp`),
      authorizationServerMetadata(ISSUER),
    ]) {
      const advertised = document.scopes_supported as string[];
      const asked = advertised.join(' ');
      const parsed = parseRequestedScope(asked, WHOLE_BRAIN_WRITE);
      expect(parsed.ok, asked).toBe(true);
    }
  });

  /**
   * And the reason the context scopes are on their own field rather than in
   * `scopes_supported`: concatenating them asks for two contexts at once, which
   * the parser refuses on purpose. An advertised vocabulary that cannot be
   * requested as advertised is worse than one a client is told about elsewhere.
   */
  test('the context vocabulary is discoverable, and deliberately not concatenable', () => {
    const server = authorizationServerMetadata(ISSUER);
    expect(server[CONTEXT_SCOPES_METADATA_FIELD]).toEqual([...CONTEXT_SCOPES]);
    expect(server.scopes_supported).not.toContain(CONTEXT_SCOPES[0]);

    // Each one alone is a request this server answers…
    for (const scope of CONTEXT_SCOPES) {
      expect(parseRequestedScope(scope, WHOLE_BRAIN_WRITE).ok, scope).toBe(true);
    }
    // …and all of them together is the refusal that keeps them off the other list.
    expect(parseRequestedScope(CONTEXT_SCOPES.join(' '), WHOLE_BRAIN_WRITE).ok).toBe(false);
  });
});

describe('the access pair', () => {
  test('is the grant a scope-less request already got — nothing new became mintable', async () => {
    const named = await flow(ACCESS_SCOPES.join(' '));
    const silent = await flow(null);

    expect(named.status).toBe(302);
    expect(named.record?.scope).toBe('whole_brain');
    expect(named.record?.origins).toEqual([]);
    // The same credential, arrived at two ways. That equality is the argument
    // that recognising the pair is not a widening.
    expect(named.record?.scope).toBe(silent.record?.scope ?? 'whole_brain');
    expect(named.record?.writeOrigin).toBe(silent.record?.writeOrigin ?? WHOLE_BRAIN_WRITE);
  });

  test.each([ACCESS_SCOPE_READ, ACCESS_SCOPE_WRITE])(
    '%s alone is refused — an answer would grant more than was asked for',
    async (scope) => {
      const outcome = await flow(scope);
      expect(outcome.status).toBe(400);
      expect(outcome.record).toBeUndefined();
    },
  );

  test('composes with a context, and the context still narrows', async () => {
    const outcome = await flow(`${ACCESS_SCOPES.join(' ')} brainz:context:work`);
    expect(outcome.status).toBe(302);
    expect(outcome.record?.scope).toBe('narrowed');
    expect(outcome.record?.origins).toEqual(['work:*']);
    expect(outcome.record?.writeOrigin).toBe('work:agent');
  });

  test('an unknown token beside the pair is still refused, not skipped', async () => {
    // The rule that did not move: a client that asked for something and
    // silently received something else has been over-granted invisibly.
    const outcome = await flow(`openid ${ACCESS_SCOPES.join(' ')}`);
    expect(outcome.status).toBe(400);
    expect(outcome.record).toBeUndefined();
  });

  test('half the pair beside a context is refused too — the halves are not independent', async () => {
    const outcome = await flow(`${ACCESS_SCOPE_READ} brainz:context:work`);
    expect(outcome.status).toBe(400);
  });
});

describe('the token response', () => {
  /**
   * It used to echo `origins.join(' ')` — a client that asked for
   * `brainz:context:work` was answered `work:*`, this server's internal fence
   * grammar, which is not a string it can interpret or ask for again.
   */
  test('speaks the vocabulary the documents publish, not the fence grammar', () => {
    const store = createInMemoryAuthorizationStore();
    const base = {
      grantId: 'g-1',
      tenantId: 'tenant-a',
      clientId: 'bzc_1',
      endpoint: 'mcp' as const,
    };

    const whole = issueTokens(store, {
      grant: { ...base, scope: 'whole_brain', origins: [], writeOrigin: 'personal:agent' },
      signingKey: 'k',
      now: 0,
    });
    expect(whole.scope).toBe(ACCESS_SCOPES.join(' '));

    const narrowed = issueTokens(store, {
      grant: { ...base, scope: 'narrowed', origins: ['work:*'], writeOrigin: 'work:agent' },
      signingKey: 'k',
      now: 0,
    });
    expect(narrowed.scope).toBe(`${ACCESS_SCOPES.join(' ')} brainz:context:work`);
    expect(narrowed.scope).not.toContain('work:*');

    // And what it answers is a request it would accept — the round trip that
    // makes the echo usable rather than decorative.
    expect(parseRequestedScope(narrowed.scope, WHOLE_BRAIN_WRITE).ok).toBe(true);
    expect(parseRequestedScope(whole.scope, WHOLE_BRAIN_WRITE).ok).toBe(true);
  });
});
