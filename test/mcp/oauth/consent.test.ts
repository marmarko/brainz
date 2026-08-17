/**
 * The authorization hop, as a browser walks it.
 *
 * **The two defects this started from, both live in production.** Claude's
 * connector opens `/authorize` in a *browser*; a browser carries no
 * `Authorization` header, so `handleAuthorize` answered `401` and the connector
 * never got past its first hop. And the two discovery documents advertised
 * different vocabularies, so the moment that was fixed the same flow failed
 * `invalid_scope` on the scope Claude actually sends.
 *
 * **Every test below is written as the thing that must not happen**, because the
 * happy path here proves almost nothing:
 *
 *   * a `GET` that mints is a credential any page can cause a signed-in browser
 *     to issue (`SameSite=Lax` admits top-level cross-site navigations *by
 *     design* — that is the shape an OAuth redirect has), so the assertion is
 *     that a `GET` mints **nothing**, counted at the store rather than inferred
 *     from a status code;
 *   * a CSRF test that only sends the right token proves the field is read, not
 *     that it is checked, so the token is sent missing, wrong, and bound to
 *     somebody else's session;
 *   * a redirect check tested with one client cannot fail, so client A is
 *     registered with URI A and asked to be sent to client B's URI;
 *   * "the session resolves to a tenant" is easy while every session has one, so
 *     one here has none.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { createMcpServer, type ResolvedOwner, type ResourceOwners } from '../../../src/mcp/server.ts';
import {
  consentToken,
  registerClient,
  type AuthorizationStore,
  type CodeRecord,
} from '../../../src/mcp/oauth.ts';
import { createMcpFixture, type McpFixture } from '../fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const ISSUER = 'https://brainz.test';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const OTHER_REDIRECT = 'https://claude.ai/api/mcp/other_callback';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER, 'ascii').digest('base64url');
const STATE = 'opaque-state-the-client-chose';

/** The session token the fake identity store recognises. */
const SESSION = 'bzs_a-session-token-this-test-invented';
const SESSION_KEY = 'session-key-for-the-signed-in-browser';
const COOKIE = `bz_session=${SESSION}`;

let fixture: McpFixture;
let clientId: string;
let otherClientId: string;

/**
 * A store that counts what was written to it.
 *
 * The point of the wrapper: "this response is a page" is not the same claim as
 * "no code was issued", and only the second one is the security property. A
 * `GET` that rendered a page *and* banked a code would pass every status-code
 * assertion in this file.
 */
function counting(store: AuthorizationStore): {
  readonly store: AuthorizationStore;
  readonly codes: { code: string; record: CodeRecord }[];
} {
  const codes: { code: string; record: CodeRecord }[] = [];
  return {
    codes,
    store: {
      ...store,
      putClient: (record) => store.putClient(record),
      getClient: (id) => store.getClient(id),
      async putCode(code, record) {
        codes.push({ code, record });
        await store.putCode(code, record);
      },
      takeCode: (code) => store.takeCode(code),
    },
  };
}

/** A session store the flow can be asked about, with no identity database. */
function owners(owner: Partial<ResolvedOwner> | null = {}): ResourceOwners {
  return {
    async resolve(cookieHeader) {
      if (owner === null) return null;
      if (cookieHeader === null || !cookieHeader.includes(SESSION)) return null;
      return {
        accountId: 'account-1',
        tenantId: fixture.tenantId,
        sessionKey: SESSION_KEY,
        ...owner,
      };
    },
  };
}

function serverWith(options: { owners?: ResourceOwners; store?: AuthorizationStore } = {}) {
  return createMcpServer({
    ...fixture.deps,
    ...(options.store === undefined ? {} : { store: options.store }),
    issuer: ISSUER,
    registrationAllowlist: {
      redirectUris: [REDIRECT, OTHER_REDIRECT],
      maxRegistrationsPerHour: 50,
    },
    ...(options.owners === undefined ? {} : { resourceOwners: options.owners }),
  });
}

function query(extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: STATE,
    ...extra,
  }).toString();
}

function browse(extra: Record<string, string> = {}, cookie: string | null = COOKIE): Request {
  return new Request(`${ISSUER}/authorize?${query(extra)}`, {
    headers: cookie === null ? {} : { cookie },
  });
}

function consent(
  options: {
    readonly token?: string;
    readonly origin?: string | null;
    readonly cookie?: string | null;
    readonly extra?: Record<string, string>;
  } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  const origin = options.origin === undefined ? ISSUER : options.origin;
  if (origin !== null) headers.origin = origin;
  const cookie = options.cookie === undefined ? COOKIE : options.cookie;
  if (cookie !== null) headers.cookie = cookie;
  return new Request(`${ISSUER}/authorize?${query(options.extra ?? {})}`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({
      consent: options.token === undefined ? consentToken(SESSION_KEY) : options.token,
    }).toString(),
  });
}

beforeAll(async () => {
  fixture = await createMcpFixture('mcp_consent');
  const allowlist = {
    allowlist: { redirectUris: [REDIRECT, OTHER_REDIRECT], maxRegistrationsPerHour: 50 },
    now: fixture.now(),
  };
  const registered = await registerClient(
    fixture.deps.store,
    { clientName: 'Claude', redirectUris: [REDIRECT] },
    allowlist,
  );
  const other = await registerClient(
    fixture.deps.store,
    { clientName: 'Another Connector', redirectUris: [OTHER_REDIRECT] },
    allowlist,
  );
  if (!registered.ok || !other.ok) throw new Error('fixture clients did not register');
  clientId = registered.client.client_id;
  otherClientId = other.client.client_id;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

// ---------------------------------------------------------------------------
// The browser reaches a consent page — the defect this unit started from.
// ---------------------------------------------------------------------------

describe('a signed-in browser', () => {
  test('reaches a consent page rather than the 401 it used to get', async () => {
    const response = await serverWith({ owners: owners() }).fetch(browse());
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const page = await response.text();
    // The three facts a consent screen owes the person reading it.
    expect(page).toContain('Claude');
    expect(page).toContain(REDIRECT);
    expect(page.toLowerCase()).toContain('whole brain');
    expect(page).toContain('method="post"');
  });

  /**
   * **Submit the page's own form, not one the test wrote.** Every other POST
   * here constructs its own URL and its own token, which asserts the handler
   * and leaves the page unchecked: a form whose `action` dropped the query
   * string, or whose token field was misnamed, would pass all of them and fail
   * for every real browser.
   */
  test('the form it renders is one that actually completes the flow', async () => {
    const server = serverWith({ owners: owners() });
    const page = await (await server.fetch(browse())).text();

    const action = /<form[^>]*action="([^"]+)"/.exec(page)?.[1] ?? '';
    const token = /name="consent" value="([^"]+)"/.exec(page)?.[1] ?? '';
    expect(action.length).toBeGreaterThan(0);
    expect(token.length).toBeGreaterThan(0);

    // The browser un-escapes the attribute before it uses it.
    const target = new URL(action.replaceAll('&amp;', '&'), ISSUER);
    const submitted = await server.fetch(
      new Request(target.toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: ISSUER,
          cookie: COOKIE,
        },
        body: new URLSearchParams({ consent: token }).toString(),
      }),
    );
    expect(submitted.status).toBe(303);
    const location = new URL(submitted.headers.get('location') ?? '');
    expect(location.searchParams.get('state')).toBe(STATE);
  });

  test('is shown a page whose CSP admits no third party and no other form target', async () => {
    const response = await serverWith({ owners: owners() }).fetch(browse());
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(policy).toContain("default-src 'none'");
    // A cached consent page is the next visitor holding this session's token.
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  /**
   * **`form-action` is checked against the redirect, not just the POST.**
   *
   * The consent form posts to this origin, so `'self'` looks sufficient and is
   * not: the POST answers `303` to the client's registered callback, and a
   * browser enforces `form-action` against the *redirect target* as well. Under
   * `form-action 'self'` alone the code is minted, banked and then never
   * delivered — the user sees "the request has been blocked" from their own
   * browser and the flow dies one hop from done, with nothing wrong on the
   * server. Observed against the live deployment on 2026-08-17.
   *
   * The origin comes from `view.redirectUri`, which is the value already checked
   * against the *registered* client — so this widens the policy to exactly the
   * place this server had already agreed to send the credential, and nowhere
   * else. Taking it from the request instead would let an attacker name their
   * own origin and have the policy bless it.
   */
  test('admits the registered callback as a form target, because the 303 goes there', async () => {
    const response = await serverWith({ owners: owners() }).fetch(browse());
    const policy = response.headers.get('content-security-policy') ?? '';
    const formAction = policy.split(';').map((d) => d.trim()).find((d) => d.startsWith('form-action'));
    expect(formAction).toBeDefined();
    expect(formAction).toContain("'self'");
    expect(formAction).toContain(new URL(REDIRECT).origin);
  });

  test('and admits nothing beyond that origin — not the whole web, not a bare scheme', async () => {
    const response = await serverWith({ owners: owners() }).fetch(browse());
    const policy = response.headers.get('content-security-policy') ?? '';
    const formAction = policy.split(';').map((d) => d.trim()).find((d) => d.startsWith('form-action')) ?? '';
    expect(formAction).not.toContain('*');
    expect(formAction).not.toMatch(/\bhttps:(?!\/\/)/);
    // Exactly two sources: `'self'` and the one registered origin.
    expect(formAction.split(/\s+/).slice(1)).toHaveLength(2);
  });

  /**
   * **The assertion the whole design rests on.** Counted at the store: a `GET`
   * that rendered a page and also banked a code would satisfy every other
   * assertion in this file and would be the CSRF-minted credential.
   */
  test('mints NOTHING on the GET — the page is not the grant', async () => {
    const recorder = counting(fixture.deps.store);
    const response = await serverWith({ owners: owners(), store: recorder.store }).fetch(browse());
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(recorder.codes).toHaveLength(0);
  });
});

describe('a browser with no session', () => {
  test('is sent to sign in, and carries the whole flow back with it', async () => {
    const recorder = counting(fixture.deps.store);
    const response = await serverWith({ owners: owners(null), store: recorder.store }).fetch(
      browse({}, null),
    );
    expect(response.status).toBe(302);

    const location = new URL(response.headers.get('location') ?? '', ISSUER);
    expect(location.pathname).toBe('/login');
    const next = location.searchParams.get('next') ?? '';
    expect(next.startsWith('/authorize?')).toBe(true);
    // Round trip, not a truncation: everything the connector sent survives, so
    // the user lands back on the consent step rather than on a dashboard.
    const returned = new URLSearchParams(next.slice(next.indexOf('?') + 1));
    expect(returned.get('client_id')).toBe(clientId);
    expect(returned.get('state')).toBe(STATE);
    expect(returned.get('code_challenge')).toBe(CHALLENGE);

    expect(recorder.codes).toHaveLength(0);
  });

  test('a POST with no session mints nothing either, and does not 500', async () => {
    const recorder = counting(fixture.deps.store);
    const response = await serverWith({ owners: owners(null), store: recorder.store }).fetch(
      consent({ cookie: null }),
    );
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get('location') ?? '', ISSUER).pathname).toBe('/login');
    expect(recorder.codes).toHaveLength(0);
  });
});

/**
 * A session whose account has no brain. The state is real — provisioning can
 * fail at signup and `/api/brain` exists to retry it — and the honest answer is
 * neither a `500` nor a consent screen for a brain that is not there.
 */
describe('a session whose account has no brain', () => {
  test('is told so, and nothing is minted', async () => {
    const recorder = counting(fixture.deps.store);
    const server = serverWith({ owners: owners({ tenantId: null }), store: recorder.store });

    const rendered = await server.fetch(browse());
    expect(rendered.status).toBe(409);
    expect(rendered.headers.get('content-type')).toContain('text/html');
    expect((await rendered.text()).toLowerCase()).toContain('no brain');

    const posted = await server.fetch(consent());
    expect(posted.status).toBe(409);
    expect(recorder.codes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Consent is explicit, and the POST is the only thing that mints.
// ---------------------------------------------------------------------------

describe('the consent POST', () => {
  test('mints exactly one code, at the registered redirect, with the state intact', async () => {
    const recorder = counting(fixture.deps.store);
    const response = await serverWith({ owners: owners(), store: recorder.store }).fetch(consent());

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe(STATE);
    expect((location.searchParams.get('code') ?? '').length).toBeGreaterThan(0);

    expect(recorder.codes).toHaveLength(1);
    const record = recorder.codes[0]?.record;
    // PKCE and state round-trip unchanged: a challenge this server rewrote is a
    // challenge no verifier can satisfy, and a state it rewrote is a client
    // that cannot match the answer to its own request.
    expect(record?.codeChallenge).toBe(CHALLENGE);
    expect(record?.redirectUri).toBe(REDIRECT);
    expect(record?.clientId).toBe(clientId);
  });

  test('takes the tenant from the session, never from the request', async () => {
    const recorder = counting(fixture.deps.store);
    // Every shape a caller could use to name a tenant, all at once.
    const response = await serverWith({ owners: owners(), store: recorder.store }).fetch(
      consent({ extra: { tenant_id: 'somebody-elses-tenant', tenant: 'somebody-elses-tenant' } }),
    );
    expect(response.status).toBe(303);
    expect(recorder.codes[0]?.record.tenantId).toBe(fixture.tenantId);
  });

  test.each([
    ['missing', ''],
    ['wrong', 'not-the-consent-token'],
    // The realistic one: a token that is genuinely this server's, for a
    // different session. A comparison against "some valid token" rather than
    // against *this* session's would pass everything above and fail here.
    ['bound to another session', consentToken('a-different-sessions-key')],
  ])('is refused when the consent token is %s — and mints nothing', async (_name, token) => {
    const recorder = counting(fixture.deps.store);
    const response = await serverWith({ owners: owners(), store: recorder.store }).fetch(
      consent({ token }),
    );
    expect(response.status).toBe(403);
    expect(recorder.codes).toHaveLength(0);
  });

  test.each([
    ['absent', null],
    ['another site', 'https://evil.example'],
    // A near miss, because a check written with `startsWith` or `includes`
    // would admit this one.
    ['a lookalike host', `${ISSUER}.evil.example`],
  ])('is refused when the Origin header is %s — and mints nothing', async (_name, origin) => {
    const recorder = counting(fixture.deps.store);
    const response = await serverWith({ owners: owners(), store: recorder.store }).fetch(
      consent({ origin }),
    );
    expect(response.status).toBe(403);
    expect(recorder.codes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The redirect target belongs to the client that registered it.
// ---------------------------------------------------------------------------

describe('the redirect_uri is checked against the registered client', () => {
  /**
   * The attack in one sentence: a code minted for client A and delivered to
   * client B's URI. Both URIs are on the registration allowlist, so an
   * allowlist-only check passes it — which is why there are two clients here.
   */
  test('client A cannot be sent to client B’s registered URI', async () => {
    const recorder = counting(fixture.deps.store);
    const server = serverWith({ owners: owners(), store: recorder.store });

    const rendered = await server.fetch(browse({ redirect_uri: OTHER_REDIRECT }));
    expect(rendered.status).toBe(400);
    // And the page that was refused named nobody: a consent screen carrying
    // another client's callback is a phishing page signed with this origin.
    expect(await rendered.text()).not.toContain(OTHER_REDIRECT);

    const posted = await server.fetch(consent({ extra: { redirect_uri: OTHER_REDIRECT } }));
    expect(posted.status).toBe(400);
    expect(recorder.codes).toHaveLength(0);
  });

  test('the other client can still use its own', async () => {
    const response = await serverWith({ owners: owners() }).fetch(
      consent({ extra: { client_id: otherClientId, redirect_uri: OTHER_REDIRECT } }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get('location') ?? '').toContain(OTHER_REDIRECT);
  });

  test('an unregistered client gets no consent page and no code', async () => {
    const recorder = counting(fixture.deps.store);
    const server = serverWith({ owners: owners(), store: recorder.store });
    const rendered = await server.fetch(browse({ client_id: 'bzc_nobody_registered_this' }));
    expect(rendered.status).toBe(400);
    expect(((await rendered.json()) as { error: string }).error).toBe('invalid_client');
    expect(await server.fetch(consent({ extra: { client_id: 'bzc_nobody' } })).then((r) => r.status)).toBe(
      400,
    );
    expect(recorder.codes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The machine path, which existed first and must keep working.
// ---------------------------------------------------------------------------

describe('the bearer path', () => {
  test('still mints on a GET, with no session and no consent page', async () => {
    const recorder = counting(fixture.deps.store);
    const response = await serverWith({ owners: owners(), store: recorder.store }).fetch(
      new Request(`${ISSUER}/authorize?${query()}`, {
        headers: { authorization: `Bearer ${fixture.bearer}` },
      }),
    );
    expect(response.status).toBe(302);
    expect(response.headers.get('location') ?? '').toContain(`${REDIRECT}?code=`);
    expect(recorder.codes).toHaveLength(1);
  });

  test('a wrong bearer is a 401, not a login page — a client is waiting on that status', async () => {
    const response = await serverWith({ owners: owners() }).fetch(
      new Request(`${ISSUER}/authorize?${query()}`, {
        headers: { authorization: 'Bearer bzk_someone-else_not-the-secret', cookie: COOKIE },
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
  });

  test('a fleet wired to no session store answers exactly what it answered before', async () => {
    // Absent `resourceOwners` is the deployed shape today. The browser leg has
    // to degrade to the 401 that starts discovery, not to a new sentence.
    const response = await serverWith().fetch(browse());
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate') ?? '').toContain('resource_metadata=');
  });
});
