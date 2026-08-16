/**
 * Grant lifecycle and the OAuth surface — owned here rather than at U15.
 *
 * **Why this unit and not the identity unit.** Claude Desktop's custom connector
 * authenticates by OAuth *discovery*, not by a static header pasted into a
 * settings box. So the moment `/mcp` is reachable at all, this server is a
 * public OAuth issuer standing in front of a mailbox-derived brain — and the
 * controls below are not detail to be filled in later, they are the difference
 * between a connector and an open door. U15 grows an identity system behind this
 * without changing the token surface.
 *
 * **Two token shapes, one dispatch.** Alpha mints a per-tenant high-entropy
 * bearer at provisioning (U2 step 6) which Claude Code can present directly;
 * Desktop obtains a short-TTL access token through the flow below. Both resolve
 * to the same {@link GrantClaims} before any handler runs.
 *
 * **Access tokens are derived, not stored, and that is a consequence of the
 * substrate rather than a preference.** The control plane is content-free and
 * holds no grant table; the only per-tenant secret this layer may read is the
 * bearer. So a token is an HMAC over its own claims, keyed by a value derived
 * one-way from that bearer. Three properties follow:
 *
 *   * **Revoke-and-reissue is one step.** Rotating the bearer changes the
 *     signing key, which invalidates every token ever minted for the tenant.
 *     That is the documented operator action.
 *   * **A leaked signing key does not yield the bearer.** The derivation is
 *     `HMAC(bearer, "brainz/mcp/access-token/v1")`, not the bearer itself.
 *   * **Per-grant revocation needs a list**, because a self-contained token
 *     cannot be individually withdrawn. {@link AuthorizationStore} carries one,
 *     and dispatch consults it on every call.
 *
 * **The tenant id inside a token is a routing hint, never an authorisation.**
 * The Worker reads it to pick a Durable Object before anything is verified
 * (KTD2's affinity). Nothing is granted by it: a token minted for one tenant
 * does not verify under another tenant's key, and that is the test that matters.
 *
 * **The controls, each written as the attack it refuses.**
 *
 *   * *PKCE S256, mandatory.* `plain` is refused outright — a downgrade to
 *     `plain` is the same as no PKCE at all.
 *   * *Exact-string `redirect_uri` matching.* Prefix matching is how
 *     `https://claude.ai/callback.evil.example` gets an authorization code.
 *   * *`state` binding*, echoed on the redirect.
 *   * *Single-use, short-TTL codes.* Taken from the store on the first redeem
 *     attempt whether or not it succeeds, so a wrong verifier burns the code
 *     rather than licensing a brute force.
 *   * *DCR behind a single-tenant allowlist and a registration rate limit.*
 *     Open dynamic registration on a public issuer is a free write amplifier.
 *
 * **The store is an interface with an in-memory implementation.** The durable
 * binding is deliberately absent: the control plane's alphabets cannot hold a
 * redirect URI or a code challenge, and U15 owns the identity store those rows
 * belong in. What is fixed here is the *shape* — every operation the flow needs,
 * expressed so a durable backend is a drop-in rather than a redesign.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { isValidTenantId } from '../control/secrets.ts';
import { grantScopeViolations, type GrantScope } from './grant-scope.ts';
import type { Endpoint } from './tools/index.ts';

// ---------------------------------------------------------------------------
// Tokens.
// ---------------------------------------------------------------------------

/** The provisioned per-tenant bearer: `bzk_<tenant>_<secret>`. */
export const TENANT_BEARER_PREFIX = 'bzk_';

/** A minted access token: `bza_<tenant>.<claims>.<signature>`. */
export const ACCESS_TOKEN_PREFIX = 'bza_';

/**
 * One hour.
 *
 * Bounded rather than eternal is the whole requirement: a grant that leaks out
 * of a client's config, a log, or a screen share expires without anyone noticing
 * it leaked. The refresh token is what keeps that invisible to the user.
 */
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/** Thirty days. Rotated on every use, so a stolen refresh token is detectable. */
export const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** One minute. A code is redeemed by a client that just received it, or never. */
export const DEFAULT_CODE_TTL_SECONDS = 60;

/** The domain-separated label the signing key is derived under. */
const SIGNING_KEY_LABEL = 'brainz/mcp/access-token/v1';

export interface GrantClaims {
  /** Stable id for this grant. The access log's actor column, and nothing else. */
  readonly grantId: string;
  readonly tenantId: string;
  /**
   * Whether this credential holds the brain or a slice of it (U18).
   *
   * **Required, and explicit.** Before U18 the marker was `origins.length === 0`
   * — a convention `dispatch.ts` read as "the whole brain", which is the one
   * place this system inverted `fence.ts`'s "an empty grant sees nothing (not
   * everything)". With narrowed grants real, a list that filters to empty would
   * have *widened* to the whole brain silently and above every fence. The
   * invariant `scope === 'narrowed' ⟺ origins.length > 0` is now checked at mint
   * and again at verify — see `grant-scope.ts`.
   */
  readonly scope: GrantScope;
  /** R15's fence, as the grant holds it. Reads see these origins and no others. */
  readonly origins: readonly string[];
  /**
   * Where this grant's writes land. Never taken from a request parameter, and —
   * since U18 — never outside {@link origins}: a grant that writes where it
   * cannot read plants rows it can never see.
   */
  readonly writeOrigin: string;
  readonly endpoint: Endpoint;
  readonly clientId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

/**
 * The provisioned bearer, and **the implementation U2's `BearerGrantMinter`
 * port must use**.
 *
 * That port takes a tenant id and returns an opaque string, and U2 is right not
 * to care what is in it — but this unit does, because the Worker reads the
 * tenant id out of the presented credential to pick a Durable Object before
 * anything is verified. A minter that returned bare entropy would produce a
 * grant no request could be routed by, and the failure would look like a tenant
 * whose brain is unreachable rather than like a format mismatch. The format is
 * therefore stated here, next to the parser that consumes it.
 */
export function mintTenantBearer(tenantId: string, random: (n: number) => Uint8Array = randomBytes): string {
  return `${TENANT_BEARER_PREFIX}${tenantId}_${base64url(random(32))}`;
}

/**
 * The tenant a token *claims* to belong to.
 *
 * Used by the Worker for Durable Object affinity before any verification has
 * happened, which is why it validates the id's alphabet: an id that reached
 * `idFromName` unchecked would let a caller aim a request at an arbitrary
 * instance name, and a malformed one would reach the secret store's namespace
 * derivation.
 */
export function tenantOfToken(token: string): string | null {
  const raw = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();

  if (raw.startsWith(TENANT_BEARER_PREFIX)) {
    const rest = raw.slice(TENANT_BEARER_PREFIX.length);
    const separator = rest.indexOf('_');
    if (separator <= 0) return null;
    const tenantId = rest.slice(0, separator);
    return isValidTenantId(tenantId) ? tenantId : null;
  }

  if (raw.startsWith(ACCESS_TOKEN_PREFIX)) {
    const rest = raw.slice(ACCESS_TOKEN_PREFIX.length);
    const separator = rest.indexOf('.');
    if (separator <= 0) return null;
    const tenantId = rest.slice(0, separator);
    return isValidTenantId(tenantId) ? tenantId : null;
  }

  return null;
}

export type TokenShape = 'tenant_bearer' | 'access_token' | 'unknown';

export function classifyToken(token: string): TokenShape {
  const raw = token.startsWith('Bearer ') ? token.slice(7).trim() : token.trim();
  if (raw.startsWith(TENANT_BEARER_PREFIX)) return 'tenant_bearer';
  if (raw.startsWith(ACCESS_TOKEN_PREFIX)) return 'access_token';
  return 'unknown';
}

/** Strip the `Bearer ` prefix an Authorization header carries. */
export function stripBearer(header: string): string {
  return header.startsWith('Bearer ') ? header.slice(7).trim() : header.trim();
}

/**
 * Constant-time comparison of a presented bearer against the stored one.
 *
 * Digests rather than raw strings, so the comparison is over two equal-length
 * buffers whatever the caller sent — `timingSafeEqual` throws on a length
 * mismatch, and catching that throw would itself be the length oracle.
 */
export function verifyTenantBearer(presented: string, stored: string): boolean {
  if (presented.length === 0 || stored.length === 0) return false;
  const a = createHash('sha256').update(stripBearer(presented)).digest();
  const b = createHash('sha256').update(stored).digest();
  return timingSafeEqual(a, b);
}

/** One-way derivation of the access-token signing key from the tenant bearer. */
export function deriveSigningKey(bearerGrant: string): string {
  return createHmac('sha256', bearerGrant).update(SIGNING_KEY_LABEL).digest('hex');
}

export function mintAccessToken(claims: GrantClaims, signingKey: string): string {
  const header = `${ACCESS_TOKEN_PREFIX}${claims.tenantId}`;
  const payload = base64urlOfText(JSON.stringify(claims));
  return `${header}.${payload}.${sign(`${header}.${payload}`, signingKey)}`;
}

/**
 * `bad_scope` is U18's, and it is a distinct reason on purpose: a signed token
 * whose scope is incoherent is a *minting* bug or a forged claims payload, not a
 * malformed string, and the two want different investigations. The wire still
 * says one sentence — `dispatch.ts` collapses every refusal into
 * `UNAUTHORIZED_MESSAGE`, because distinguishing them to a caller is an oracle.
 */
export type TokenRefusal = 'malformed' | 'bad_signature' | 'expired' | 'wrong_tenant' | 'bad_scope';

export type TokenVerdict =
  | { readonly ok: true; readonly claims: GrantClaims }
  | { readonly ok: false; readonly reason: TokenRefusal };

/**
 * Verify a token and return its claims.
 *
 * Order matters and it is signature-before-everything: expiry, tenant and scope
 * are all claims *in* the payload, so reading them before the signature has
 * verified is reading attacker-controlled JSON.
 */
export function verifyAccessToken(token: string, signingKey: string, nowMs: number): TokenVerdict {
  const raw = stripBearer(token);
  if (!raw.startsWith(ACCESS_TOKEN_PREFIX)) return { ok: false, reason: 'malformed' };

  const parts = raw.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [header, payload, signature] = parts as [string, string, string];

  const expected = sign(`${header}.${payload}`, signingKey);
  if (!constantTimeEqual(signature, expected)) return { ok: false, reason: 'bad_signature' };

  let claims: GrantClaims;
  try {
    claims = JSON.parse(textOfBase64url(payload)) as GrantClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof claims?.tenantId !== 'string' || !isValidTenantId(claims.tenantId)) {
    return { ok: false, reason: 'malformed' };
  }
  if (`${ACCESS_TOKEN_PREFIX}${claims.tenantId}` !== header) return { ok: false, reason: 'wrong_tenant' };
  if (!Array.isArray(claims.origins) || typeof claims.writeOrigin !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims.expiresAt !== 'number' || claims.expiresAt <= nowMs) {
    return { ok: false, reason: 'expired' };
  }

  // U18. **Checked here, at verify, and not only at mint.** A signer is a thing
  // an attacker might obtain and a mint is a thing a future caller might route
  // around; a token whose scope is incoherent is refused before a tenant
  // database is opened. `scope: 'narrowed'` with no origins is the specific
  // shape that used to widen to the whole brain — see `grant-scope.ts`.
  if (grantScopeViolations(claims).length > 0) return { ok: false, reason: 'bad_scope' };

  return { ok: true, claims };
}

function sign(material: string, signingKey: string): string {
  return createHmac('sha256', signingKey).update(material).digest('hex');
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

/**
 * base64url, spelled out rather than delegated to `Buffer.toString('base64url')`.
 *
 * Two runtimes' type declarations are in scope here — Bun's and the Workers
 * platform's — and they disagree about what `Buffer` is. Writing the encoding by
 * hand costs four lines and removes an ambient-type dependency from the one
 * module whose output is a credential.
 */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlOfText(text: string): string {
  return base64url(new TextEncoder().encode(text));
}

function textOfBase64url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

// ---------------------------------------------------------------------------
// The authorization flow.
// ---------------------------------------------------------------------------

export type OAuthError =
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_redirect_uri'
  | 'invalid_client_metadata'
  | 'unsupported_grant_type'
  /** U18: a consent step asked for a scope this server refuses to sign. */
  | 'invalid_scope'
  | 'rate_limited';

export interface ClientRecord {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly registeredAt: number;
}

export interface CodeRecord {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly tenantId: string;
  /** U18. Carried through the flow so a redeem cannot re-decide it. */
  readonly scope: GrantScope;
  readonly origins: readonly string[];
  readonly writeOrigin: string;
  readonly endpoint: Endpoint;
  readonly grantId: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface RefreshRecord {
  readonly clientId: string;
  readonly tenantId: string;
  /** U18. A refresh re-issues the grant it was given, never a wider one. */
  readonly scope: GrantScope;
  readonly origins: readonly string[];
  readonly writeOrigin: string;
  readonly endpoint: Endpoint;
  readonly grantId: string;
  readonly expiresAt: number;
}

export interface AuthorizationStore {
  putClient(record: ClientRecord): void;
  getClient(clientId: string): ClientRecord | undefined;
  noteRegistration(atMs: number): void;
  registrationsSince(sinceMs: number): number;
  putCode(code: string, record: CodeRecord): void;
  /** Single-use: the record is removed by this call, successful redeem or not. */
  takeCode(code: string): CodeRecord | undefined;
  putRefresh(tokenHash: string, record: RefreshRecord): void;
  takeRefresh(tokenHash: string): RefreshRecord | undefined;
  revokeGrant(grantId: string): void;
  isRevoked(grantId: string): boolean;
}

export function createInMemoryAuthorizationStore(): AuthorizationStore {
  const clients = new Map<string, ClientRecord>();
  const codes = new Map<string, CodeRecord>();
  const refresh = new Map<string, RefreshRecord>();
  const revoked = new Set<string>();
  const registrations: number[] = [];

  return {
    putClient(record) {
      clients.set(record.clientId, record);
    },
    getClient(clientId) {
      return clients.get(clientId);
    },
    noteRegistration(atMs) {
      registrations.push(atMs);
    },
    registrationsSince(sinceMs) {
      return registrations.filter((at) => at >= sinceMs).length;
    },
    putCode(code, record) {
      codes.set(code, record);
    },
    takeCode(code) {
      const record = codes.get(code);
      codes.delete(code);
      return record;
    },
    putRefresh(tokenHash, record) {
      refresh.set(tokenHash, record);
    },
    takeRefresh(tokenHash) {
      const record = refresh.get(tokenHash);
      refresh.delete(tokenHash);
      return record;
    },
    revokeGrant(grantId) {
      revoked.add(grantId);
    },
    isRevoked(grantId) {
      return revoked.has(grantId);
    },
  };
}

export interface RegistrationAllowlist {
  /**
   * Every redirect a client may register, as exact strings.
   *
   * The single-tenant gate KTD-wise: alpha serves one founder and two known
   * clients, so an open registration endpoint has no use case and one obvious
   * abuse case.
   */
  readonly redirectUris: readonly string[];
  readonly maxRegistrationsPerHour: number;
}

/** RFC 7591's client-information response, as this server issues it. */
export interface RegisteredClient {
  readonly client_id: string;
  readonly client_name: string;
  readonly redirect_uris: readonly string[];
  readonly client_id_issued_at: number;
  readonly token_endpoint_auth_method: 'none';
  readonly grant_types: readonly string[];
  readonly response_types: readonly string[];
}

export type RegistrationOutcome =
  | { readonly ok: true; readonly client: RegisteredClient }
  | { readonly ok: false; readonly error: OAuthError; readonly description: string };

export function registerClient(
  store: AuthorizationStore,
  request: { readonly clientName: string; readonly redirectUris: readonly string[] },
  options: { readonly allowlist: RegistrationAllowlist; readonly now: number; readonly random?: (n: number) => Uint8Array },
): RegistrationOutcome {
  const random = options.random ?? randomBytes;

  if (request.redirectUris.length === 0) {
    return { ok: false, error: 'invalid_client_metadata', description: 'at least one redirect_uri is required' };
  }

  const allowed = new Set(options.allowlist.redirectUris);
  // Every URI, not any: a registration that mixes an allowed redirect with a
  // disallowed one is refused whole. Accepting the allowed subset would hand
  // the client a working registration that also carries the attacker's URI.
  for (const uri of request.redirectUris) {
    if (!allowed.has(uri)) {
      return { ok: false, error: 'invalid_redirect_uri', description: 'redirect_uri is not on the allowlist' };
    }
  }

  const windowStart = options.now - 60 * 60 * 1000;
  if (store.registrationsSince(windowStart) >= options.allowlist.maxRegistrationsPerHour) {
    return { ok: false, error: 'rate_limited', description: 'too many registrations in the last hour' };
  }

  const clientId = `bzc_${base64url(random(16))}`;
  store.putClient({
    clientId,
    clientName: request.clientName,
    redirectUris: [...request.redirectUris],
    registeredAt: options.now,
  });
  store.noteRegistration(options.now);

  return {
    ok: true,
    client: {
      client_id: clientId,
      client_name: request.clientName,
      redirect_uris: [...request.redirectUris],
      client_id_issued_at: Math.floor(options.now / 1000),
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  };
}

export interface AuthorizeRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly codeChallengeMethod: string;
  readonly state: string;
  /**
   * The resource owner, already authenticated by the caller.
   *
   * In alpha the login credential is the tenant's provisioned bearer, verified
   * by `server.ts` before this function is reached. U15 replaces that step with
   * a real session without changing anything below.
   */
  readonly tenantId: string;
  /** U18's explicit marker. `narrowed` with no origins is refused below. */
  readonly scope: GrantScope;
  readonly origins: readonly string[];
  readonly writeOrigin: string;
  readonly endpoint: Endpoint;
  readonly now: number;
  readonly random?: (n: number) => Uint8Array;
  readonly ttlSeconds?: number;
}

export type AuthorizeOutcome =
  | { readonly ok: true; readonly code: string; readonly redirectTo: string }
  | { readonly ok: false; readonly error: OAuthError; readonly description: string };

export function authorize(store: AuthorizationStore, request: AuthorizeRequest): AuthorizeOutcome {
  const client = store.getClient(request.clientId);
  if (client === undefined) {
    return { ok: false, error: 'invalid_client', description: 'unknown client_id' };
  }

  // Exact string, not prefix, not normalised, not case-folded. The whole
  // control is that `https://claude.ai/cb` and `https://claude.ai/cb.evil` are
  // different strings, and every relaxation of this comparison has a published
  // exploit behind it.
  if (!client.redirectUris.includes(request.redirectUri)) {
    return { ok: false, error: 'invalid_request', description: 'redirect_uri does not match a registered value' };
  }

  if (request.codeChallengeMethod !== 'S256') {
    return { ok: false, error: 'invalid_request', description: 'code_challenge_method must be S256' };
  }
  if (request.codeChallenge.length < 43) {
    return { ok: false, error: 'invalid_request', description: 'code_challenge is required' };
  }
  if (request.state.length === 0) {
    return { ok: false, error: 'invalid_request', description: 'state is required' };
  }
  if (!isValidTenantId(request.tenantId)) {
    return { ok: false, error: 'invalid_request', description: 'unroutable tenant' };
  }

  // U18. **Refused at mint as well as at verify**, and the duplication is the
  // design: verify is the backstop against a forged or hand-assembled claims
  // payload, and mint is what stops this server from ever putting its own
  // signature on an incoherent scope. A code that cannot become a valid token
  // must not be issued, or the failure surfaces at the client as a broken
  // connector rather than here as a refused consent.
  const scopeFindings = grantScopeViolations({
    scope: request.scope,
    origins: request.origins,
    writeOrigin: request.writeOrigin,
  });
  if (scopeFindings.length > 0) {
    return { ok: false, error: 'invalid_scope', description: scopeFindings.join('; ') };
  }

  const random = request.random ?? randomBytes;
  const code = base64url(random(32));
  const ttl = (request.ttlSeconds ?? DEFAULT_CODE_TTL_SECONDS) * 1000;

  store.putCode(code, {
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    tenantId: request.tenantId,
    scope: request.scope,
    origins: [...request.origins],
    writeOrigin: request.writeOrigin,
    endpoint: request.endpoint,
    grantId: `g_${base64url(random(12))}`,
    issuedAt: request.now,
    expiresAt: request.now + ttl,
  });

  const redirectTo = `${request.redirectUri}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(request.state)}`;
  return { ok: true, code, redirectTo };
}

export interface RedeemRequest {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
  readonly clientId: string;
  readonly now: number;
}

export type RedeemOutcome =
  | { readonly ok: true; readonly grant: Omit<GrantClaims, 'issuedAt' | 'expiresAt'> }
  | { readonly ok: false; readonly error: OAuthError; readonly description: string };

export function redeemAuthorizationCode(
  store: AuthorizationStore,
  request: RedeemRequest,
): RedeemOutcome {
  // Taken unconditionally: a wrong verifier burns the code rather than leaving
  // it available for the next guess.
  const record = store.takeCode(request.code);
  const refused: RedeemOutcome = {
    ok: false,
    error: 'invalid_grant',
    description: 'the authorization code is not redeemable',
  };

  if (record === undefined) return refused;
  if (record.expiresAt <= request.now) return refused;
  if (record.clientId !== request.clientId) return refused;
  if (record.redirectUri !== request.redirectUri) return refused;
  if (request.codeVerifier.length === 0) return refused;
  if (!verifyPkce(request.codeVerifier, record.codeChallenge)) return refused;

  return {
    ok: true,
    grant: {
      grantId: record.grantId,
      tenantId: record.tenantId,
      // Read off the record, never re-decided here: a redeem that recomputed
      // the scope would be a second place the fence is chosen.
      scope: record.scope,
      origins: record.origins,
      writeOrigin: record.writeOrigin,
      endpoint: record.endpoint,
      clientId: record.clientId,
    },
  };
}

/** S256 only: `base64url(sha256(verifier)) === challenge`. */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = base64url(createHash('sha256').update(codeVerifier, 'ascii').digest());
  if (computed.length !== codeChallenge.length) return false;
  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(computed), encoder.encode(codeChallenge));
}

// ---------------------------------------------------------------------------
// The token endpoint's two grant types.
// ---------------------------------------------------------------------------

export interface IssuedTokens {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
}

export function issueTokens(
  store: AuthorizationStore,
  options: {
    readonly grant: Omit<GrantClaims, 'issuedAt' | 'expiresAt'>;
    readonly signingKey: string;
    readonly now: number;
    readonly accessTtlSeconds?: number;
    readonly refreshTtlSeconds?: number;
    readonly random?: (n: number) => Uint8Array;
  },
): IssuedTokens {
  const random = options.random ?? randomBytes;
  const accessTtl = options.accessTtlSeconds ?? DEFAULT_ACCESS_TOKEN_TTL_SECONDS;
  const refreshTtl = options.refreshTtlSeconds ?? DEFAULT_REFRESH_TOKEN_TTL_SECONDS;

  const claims: GrantClaims = {
    ...options.grant,
    issuedAt: options.now,
    expiresAt: options.now + accessTtl * 1000,
  };

  const refreshToken = `bzr_${base64url(random(32))}`;
  store.putRefresh(hashToken(refreshToken), {
    clientId: options.grant.clientId,
    tenantId: options.grant.tenantId,
    scope: options.grant.scope,
    origins: [...options.grant.origins],
    writeOrigin: options.grant.writeOrigin,
    endpoint: options.grant.endpoint,
    grantId: options.grant.grantId,
    expiresAt: options.now + refreshTtl * 1000,
  });

  return {
    access_token: mintAccessToken(claims, options.signingKey),
    token_type: 'Bearer',
    expires_in: accessTtl,
    refresh_token: refreshToken,
    scope: options.grant.origins.join(' '),
  };
}

export function redeemRefreshToken(
  store: AuthorizationStore,
  request: { readonly refreshToken: string; readonly clientId: string; readonly now: number },
): RedeemOutcome {
  // Rotation: taken on use, and a new one is issued alongside the next access
  // token. A refresh token presented twice is therefore refused, which is what
  // makes theft detectable instead of silent.
  const record = store.takeRefresh(hashToken(request.refreshToken));
  const refused: RedeemOutcome = {
    ok: false,
    error: 'invalid_grant',
    description: 'the refresh token is not redeemable',
  };

  if (record === undefined) return refused;
  if (record.expiresAt <= request.now) return refused;
  if (record.clientId !== request.clientId) return refused;
  if (store.isRevoked(record.grantId)) return refused;

  return {
    ok: true,
    grant: {
      grantId: record.grantId,
      tenantId: record.tenantId,
      // Read off the record, never re-decided here: a redeem that recomputed
      // the scope would be a second place the fence is chosen.
      scope: record.scope,
      origins: record.origins,
      writeOrigin: record.writeOrigin,
      endpoint: record.endpoint,
      clientId: record.clientId,
    },
  };
}

/** Refresh tokens are stored hashed: the store never holds a usable credential. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// Discovery metadata.
// ---------------------------------------------------------------------------

/** RFC 9728 — what a 401 points a client at. */
export function protectedResourceMetadata(issuer: string, resource: string): Record<string, unknown> {
  return {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: ['brain.read', 'brain.write'],
  };
}

/** RFC 8414 — what the client reads to run the flow. */
export function authorizationServerMetadata(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    // S256 alone, deliberately: advertising `plain` invites a downgrade that
    // `authorize` would refuse anyway, and an advertised option a server
    // refuses is a bug report waiting to happen.
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    /**
     * U18's context grants, advertised so a client can discover the vocabulary
     * rather than guess it. Omitting `scope` still grants the whole brain —
     * which is why these are advertised as *supported* rather than required.
     */
    scopes_supported: ['brainz:context:personal', 'brainz:context:work'],
  };
}
