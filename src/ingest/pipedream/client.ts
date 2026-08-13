/**
 * The Pipedream Connect client (U9 approach 1), the per-source rate budget, and
 * the claim URL.
 *
 * **Everything vendor-shaped is behind two ports**, `HttpTransport` and the
 * clock, so this unit's suite touches no network and holds no credential. That
 * is not only a testing convenience: KTD6 makes own-OAuth the Phase 5 exit
 * ramp, and the promise the plan extracts from this file is that the swap
 * changes *the auth layer, not the source logic*. The three adapters under
 * `sources/` therefore depend on {@link ProviderApi} — one method — and never
 * on this module's vendor specifics.
 *
 * **Assumption 1 lands here, and it is still unverified.** The vendor question
 * is drafted at `docs/vendor/2026-08-12-pipedream-compliance.md` and was
 * deliberately deferred to this unit. Two answers change code, and both are
 * marked in place:
 *
 *   * **Q1 — restricted Gmail scopes under their OAuth apps.** If the answer is
 *     no, the fallback is CASA-free scopes plus an MBOX mailbox export through
 *     U8's folder import. Nothing in `sources/gmail.ts` is reused by that path,
 *     and nothing outside it has to change: the pull runner, the gate, the junk
 *     gate, the cursor and the log are all source-agnostic. The fallback is a
 *     new adapter, not a rewrite. (See the note on {@link ProviderApi}.)
 *   * **Q2 — programmatic external-user deletion with token revocation.**
 *     {@link PipedreamClient.deleteExternalUser} makes the call R12's fourth
 *     erasure leg needs. What it reports back is `tokensRevoked: 'unverified'`,
 *     and it will keep saying that until a vendor answer is written into that
 *     file — because "account deletion leaves no live credential anywhere" is a
 *     sentence that ends up in a privacy policy.
 *
 * The exact URL and header shape of the proxy call is the third unverified
 * detail. It is confined to {@link providerUrl} and {@link connectionHeaders};
 * everything above them speaks in `ProviderRequest`.
 *
 * **The claim URL is a capability, not display copy.** Whoever holds it can
 * attach *their* Google account to *this* tenant's brain. So: short TTL,
 * single-use, bound to the authenticated tenant, stored as a hash rather than
 * as itself, compared in constant time, and redacted from anything that can be
 * logged — because the envelope carrying it lands in transcripts that U8 later
 * re-ingests and `recall` could resurface.
 */

import { createHash, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';

import { isCursorInvalidation, type ConnectorSource } from '../cursor.ts';

// ---------------------------------------------------------------------------
// Ports.
// ---------------------------------------------------------------------------

export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface HttpTransport {
  send(request: HttpRequest): Promise<HttpResponse>;
}

/** The production transport. Nothing else in this file knows `fetch` exists. */
export function fetchTransport(): HttpTransport {
  return {
    async send(request) {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      return { status: response.status, body: await response.text() };
    },
  };
}

export interface PipedreamConfig {
  readonly projectId: string;
  readonly environment: 'development' | 'production';
  readonly clientId: string;
  /** Never logged, never placed in a URL. See the test that scans for it. */
  readonly clientSecret: string;
  readonly baseUrl?: string;
}

export const DEFAULT_BASE_URL = 'https://api.pipedream.com/v1';

/**
 * Why a call did not succeed, in the vocabulary the ingest log can hold plus
 * the one code that is not a failure of the *call*: `cursor_invalid`, which the
 * pull runner answers by discarding the cursor and re-gating rather than by
 * giving up.
 */
export type PullFailureReason =
  | 'auth_expired'
  | 'rate_limited'
  | 'cursor_invalid'
  | 'provider_error'
  | 'not_connected';

export interface ClientFailure {
  readonly ok: false;
  readonly reason: PullFailureReason;
  readonly status: number | null;
}

export type ClientOutcome<T> = { readonly ok: true; readonly value: T } | ClientFailure;

/** Which vendor app a provider request is aimed at. */
export type ProviderApp = 'gmail' | 'google_calendar' | 'google_drive';

export const APP_FOR_SOURCE: Readonly<Record<ConnectorSource, ProviderApp>> = {
  gmail: 'gmail',
  calendar: 'google_calendar',
  drive: 'google_drive',
};

export interface ProviderRequest {
  readonly app: ProviderApp;
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly externalUserId: string;
  readonly accountId?: string | null;
  /** Answer as text rather than JSON — a Drive file body, not a metadata blob. */
  readonly raw?: boolean;
}

/**
 * The one method the source adapters depend on.
 *
 * Deliberately narrower than {@link PipedreamClient}: when Phase 5 swaps
 * Pipedream for our own OAuth client, or when Assumption 1's fallback replaces
 * Gmail with an MBOX importer, what changes is an implementation of *this*
 * interface. A source that reached for the connect-token mint would have bound
 * itself to the vendor.
 */
export interface ProviderApi {
  request(request: ProviderRequest): Promise<ClientOutcome<unknown>>;
}

export interface ConnectToken {
  readonly token: string;
  readonly expiresAt: Date;
  readonly connectLinkUrl: string;
}

export interface ExternalUserDeletion {
  readonly deleted: true;
  /**
   * Whether the grant was revoked **at the provider**, which is what R12's leg
   * actually promises. `unverified` until Q2 is answered in writing; promoting
   * it without that answer puts a false sentence in a privacy policy.
   */
  readonly tokensRevoked: 'confirmed' | 'unverified';
}

export interface PipedreamClient extends ProviderApi {
  mintConnectToken(request: {
    readonly externalUserId: string;
    readonly now: Date;
    readonly ttlSeconds?: number;
  }): Promise<ClientOutcome<ConnectToken>>;
  deleteExternalUser(request: {
    readonly externalUserId: string;
  }): Promise<ClientOutcome<ExternalUserDeletion>>;
}

// ---------------------------------------------------------------------------
// Failure classification.
// ---------------------------------------------------------------------------

/**
 * One status → one code, with the cursor case checked first.
 *
 * `auth_expired` and `provider_error` are told apart deliberately: the first
 * reads to a user as "reconnect this source" and the second as "we will retry",
 * and a connector that reports a revoked grant as a hiccup goes quiet forever
 * while claiming to be healthy.
 */
export function classifyHttpFailure(status: number, body: unknown): PullFailureReason {
  if (isCursorInvalidation(status, body)) return 'cursor_invalid';
  if (status === 401 || status === 403) return 'auth_expired';
  if (status === 429) return 'rate_limited';
  return 'provider_error';
}

// ---------------------------------------------------------------------------
// The per-source rate budget.
// ---------------------------------------------------------------------------

export interface RateBudget {
  /** Resolves when this key may spend one request. Never rejects. */
  take(key: string): Promise<void>;
}

/** Deliberately modest: the ceiling is the vendor's, and it is shared. */
export const DEFAULT_QPS = 5;
export const DEFAULT_BURST = 10;

/**
 * A token bucket per key.
 *
 * Per key, because the sources share a vendor quota but not a schedule: a Drive
 * backfill must not stall the mail poll that a user is waiting on. The clock
 * and the sleep are injected so the budget is arithmetic in tests rather than
 * wall-clock time, which is the only way to assert that it waits at all.
 */
export function createRateBudget(options: {
  readonly qps: number;
  readonly burst?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}): RateBudget {
  const qps = Math.max(0.001, options.qps);
  const burst = Math.max(1, options.burst ?? Math.ceil(qps));
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const buckets = new Map<string, { tokens: number; at: number }>();

  function refill(key: string): { tokens: number; at: number } {
    const at = now();
    const bucket = buckets.get(key) ?? { tokens: burst, at };
    const elapsed = Math.max(0, at - bucket.at);
    const tokens = Math.min(burst, bucket.tokens + (elapsed / 1_000) * qps);
    const updated = { tokens, at };
    buckets.set(key, updated);
    return updated;
  }

  return {
    async take(key) {
      const bucket = refill(key);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil(((1 - bucket.tokens) / qps) * 1_000);
      await sleep(waitMs);
      const after = refill(key);
      // Fail open on arithmetic: a budget that could refuse would turn a pacing
      // decision into a lost pull.
      after.tokens = Math.max(0, after.tokens - 1);
    },
  };
}

// ---------------------------------------------------------------------------
// The client.
// ---------------------------------------------------------------------------

/**
 * The same alphabet the control plane pins for a tenant id, applied to the
 * value that becomes a URL **path segment**. A `/` or a `..` here would address
 * another external user's record — including on the deletion call, where the
 * consequence is erasing the wrong person or silently erasing nobody.
 */
const EXTERNAL_USER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class ExternalUserIdError extends Error {
  constructor(externalUserId: string) {
    super(
      `refusing an external user id outside the anchored alphabet: ${JSON.stringify(externalUserId)} — this string becomes a URL path segment`,
    );
    this.name = 'ExternalUserIdError';
  }
}

export function assertExternalUserId(externalUserId: string): void {
  if (!EXTERNAL_USER_ID_PATTERN.test(externalUserId)) throw new ExternalUserIdError(externalUserId);
}

/** How early a cached access token is treated as expired. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function queryString(query: ProviderRequest['query']): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded.length === 0 ? '' : `?${encoded}`;
}

/** Vendor detail #1 — see the header. */
function providerUrl(config: PipedreamConfig, request: ProviderRequest): string {
  const base = config.baseUrl ?? DEFAULT_BASE_URL;
  return `${base}/connect/${config.projectId}/proxy/${request.app}${request.path}${queryString(request.query)}`;
}

/** Vendor detail #2 — see the header. The scope of the call, in headers. */
function connectionHeaders(
  config: PipedreamConfig,
  request: Pick<ProviderRequest, 'externalUserId' | 'accountId'>,
): Record<string, string> {
  assertExternalUserId(request.externalUserId);
  return {
    'x-pd-environment': config.environment,
    'x-pd-external-user-id': request.externalUserId,
    ...(request.accountId == null ? {} : { 'x-pd-account-id': request.accountId }),
  };
}

export function createPipedreamClient(options: {
  readonly config: PipedreamConfig;
  readonly transport: HttpTransport;
  readonly now?: () => Date;
  readonly rate?: RateBudget;
}): PipedreamClient {
  const { config, transport } = options;
  const now = options.now ?? (() => new Date());
  const rate = options.rate ?? createRateBudget({ qps: DEFAULT_QPS, burst: DEFAULT_BURST });
  const base = config.baseUrl ?? DEFAULT_BASE_URL;

  let accessToken: { value: string; expiresAt: number } | null = null;

  /** The vendor's own OAuth, cached. A refusal here is `auth_expired`. */
  async function authorize(): Promise<ClientOutcome<string>> {
    const at = now().getTime();
    if (accessToken !== null && accessToken.expiresAt - TOKEN_SAFETY_MARGIN_MS > at) {
      return { ok: true, value: accessToken.value };
    }

    const response = await transport.send({
      method: 'POST',
      url: `${base}/oauth/token`,
      headers: { 'content-type': 'application/json' },
      // In the body, never the URL: a query parameter is logged by every proxy
      // between here and the vendor.
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
    });

    if (response.status < 200 || response.status >= 300) {
      accessToken = null;
      return { ok: false, reason: 'auth_expired', status: response.status };
    }

    const body = parseJson(response.body) as { access_token?: unknown; expires_in?: unknown } | null;
    const token = body?.access_token;
    if (typeof token !== 'string' || token.length === 0) {
      return { ok: false, reason: 'auth_expired', status: response.status };
    }
    const lifetimeMs = (typeof body?.expires_in === 'number' ? body.expires_in : 3_600) * 1_000;
    accessToken = { value: token, expiresAt: at + lifetimeMs };
    return { ok: true, value: token };
  }

  async function call(
    request: HttpRequest & { readonly rateKey?: string },
  ): Promise<ClientOutcome<{ status: number; body: string }>> {
    const authorized = await authorize();
    if (!authorized.ok) return authorized;

    if (request.rateKey !== undefined) await rate.take(request.rateKey);

    const response = await transport.send({
      method: request.method,
      url: request.url,
      headers: { ...request.headers, authorization: `Bearer ${authorized.value}` },
      ...(request.body === undefined ? {} : { body: request.body }),
    });

    if (response.status < 200 || response.status >= 300) {
      // A 401 from the vendor means the cached token is no longer good; drop it
      // so the next call re-authorizes rather than replaying a dead token.
      if (response.status === 401) accessToken = null;
      return {
        ok: false,
        reason: classifyHttpFailure(response.status, parseJson(response.body)),
        status: response.status,
      };
    }

    return { ok: true, value: { status: response.status, body: response.body } };
  }

  return {
    async mintConnectToken(request) {
      assertExternalUserId(request.externalUserId);
      const outcome = await call({
        method: 'POST',
        url: `${base}/connect/${config.projectId}/tokens`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          external_user_id: request.externalUserId,
          ...(request.ttlSeconds === undefined ? {} : { lifetime: request.ttlSeconds }),
        }),
      });
      if (!outcome.ok) return outcome;

      const body = parseJson(outcome.value.body) as Record<string, unknown> | null;
      const token = body?.token;
      if (typeof token !== 'string' || token.length === 0) {
        return { ok: false, reason: 'provider_error', status: outcome.value.status };
      }
      const expiresRaw = body?.expires_at;
      const expiresAt =
        typeof expiresRaw === 'string' && !Number.isNaN(Date.parse(expiresRaw))
          ? new Date(expiresRaw)
          : new Date(request.now.getTime() + 3_600_000);
      const link = body?.connect_link_url;

      return {
        ok: true,
        value: {
          token,
          expiresAt,
          connectLinkUrl:
            typeof link === 'string' && link.length > 0
              ? link
              : `https://pipedream.com/_static/connect.html?token=${encodeURIComponent(token)}`,
        },
      };
    },

    async request(request) {
      const outcome = await call({
        method: request.method,
        url: providerUrl(config, request),
        headers: connectionHeaders(config, request),
        rateKey: request.app,
      });
      if (!outcome.ok) return outcome;
      return { ok: true, value: request.raw === true ? outcome.value.body : parseJson(outcome.value.body) };
    },

    async deleteExternalUser(request) {
      assertExternalUserId(request.externalUserId);
      const outcome = await call({
        method: 'DELETE',
        url: `${base}/connect/${config.projectId}/users/${request.externalUserId}`,
        headers: {},
      });
      if (!outcome.ok) return outcome;
      // Not `confirmed`: see `ExternalUserDeletion`.
      return { ok: true, value: { deleted: true, tokensRevoked: 'unverified' } };
    },
  };
}

// ---------------------------------------------------------------------------
// The claim URL.
// ---------------------------------------------------------------------------

export interface ClaimRecord {
  readonly claimId: string;
  readonly tenantId: string;
  readonly source: ConnectorSource;
  readonly externalUserId: string;
  /** sha256 of the secret. The secret itself is never stored anywhere. */
  readonly secretHash: string;
  readonly expiresAt: string;
  readonly consumedAt: string | null;
}

export interface ClaimStore {
  put(record: ClaimRecord): Promise<void>;
  get(claimId: string): Promise<ClaimRecord | null>;
  /**
   * Mark consumed **if it is not already**, and answer the record it consumed.
   * `null` means somebody else got there first — a compare-and-set, because
   * "read, check, then write" is two users attaching two accounts to one brain.
   */
  consume(claimId: string, now: Date): Promise<ClaimRecord | null>;
}

export function createInMemoryClaimStore(): ClaimStore {
  const records = new Map<string, ClaimRecord>();
  return {
    put(record) {
      records.set(record.claimId, record);
      return Promise.resolve();
    },
    get(claimId) {
      return Promise.resolve(records.get(claimId) ?? null);
    },
    consume(claimId, now) {
      const record = records.get(claimId);
      if (record === undefined || record.consumedAt !== null) return Promise.resolve(null);
      const consumed = { ...record, consumedAt: now.toISOString() };
      records.set(claimId, consumed);
      return Promise.resolve(consumed);
    },
  };
}

/** Ten minutes: long enough to walk through a consent screen, short enough that
 * a leaked link in a transcript is usually already dead. */
export const DEFAULT_CLAIM_TTL_MS = 10 * 60_000;

/**
 * Matches what {@link mintClaimUrl} produces. Exported so U6's envelope and
 * U8's chat-export parser can skip the value rather than each inventing a
 * pattern — the envelope lands in transcripts this fleet later re-ingests.
 */
export const CLAIM_URL_PATTERN =
  /https?:\/\/[^\s"'<>]*\/connect\/claim\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}#[A-Za-z0-9_-]{16,}/g;

export const CLAIM_REDACTION = '[redacted-claim-url]';

/** Replace every claim URL in a string. A fresh regex per call: a shared global
 * one carries `lastIndex` between callers. */
export function redactClaimUrls(text: string): string {
  return text.replace(new RegExp(CLAIM_URL_PATTERN.source, 'g'), CLAIM_REDACTION);
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function mintClaimUrl(options: {
  readonly store: ClaimStore;
  readonly tenantId: string;
  readonly source: ConnectorSource;
  readonly externalUserId: string;
  readonly baseUrl: string;
  readonly now: Date;
  readonly ttlMs?: number;
  readonly newClaimId?: () => string;
  readonly newSecret?: () => string;
}): Promise<{ readonly claimUrl: string; readonly claimId: string; readonly expiresAt: Date }> {
  const claimId = (options.newClaimId ?? randomUUID)();
  const secret = (options.newSecret ?? (() => Buffer.from(randomBytes(24)).toString('base64url')))();
  const expiresAt = new Date(options.now.getTime() + (options.ttlMs ?? DEFAULT_CLAIM_TTL_MS));

  await options.store.put({
    claimId,
    tenantId: options.tenantId,
    source: options.source,
    externalUserId: options.externalUserId,
    secretHash: sha256Hex(secret),
    expiresAt: expiresAt.toISOString(),
    consumedAt: null,
  });

  // The secret rides in the fragment: fragments are not sent to servers by
  // browsers and are not written to access logs by proxies. The claim id, which
  // is useless on its own, is the part that travels in the path.
  return {
    claimUrl: `${options.baseUrl.replace(/\/+$/, '')}/connect/claim/${claimId}#${secret}`,
    claimId,
    expiresAt,
  };
}

export type RedeemRefusal =
  | 'malformed'
  | 'unknown'
  | 'expired'
  | 'consumed'
  | 'tenant_mismatch'
  | 'secret_mismatch';

export type RedeemOutcome =
  | { readonly ok: true; readonly record: ClaimRecord }
  | { readonly ok: false; readonly reason: RedeemRefusal };

const CLAIM_PATH =
  /\/connect\/claim\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})#([A-Za-z0-9_-]{16,})$/;

function secretsMatch(expectedHex: string, candidate: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(sha256Hex(candidate), 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Redeem a claim, once.
 *
 * Order is the security property. Tenant binding and the secret are checked
 * **before** the compare-and-set, so a guessed or replayed link cannot burn a
 * capability its real holder has not used yet; the CAS is last, so two
 * simultaneous redemptions of a *valid* link produce one attachment and one
 * `consumed`. Every refusal is typed and none of them says which check failed
 * to the outside world — that is the caller's decision, not this function's.
 */
export async function redeemClaimUrl(options: {
  readonly store: ClaimStore;
  readonly tenantId: string;
  readonly claimUrl: string;
  readonly now: Date;
}): Promise<RedeemOutcome> {
  const match = CLAIM_PATH.exec(options.claimUrl);
  const claimId = match?.[1];
  const secret = match?.[2];
  if (claimId === undefined || secret === undefined) return { ok: false, reason: 'malformed' };

  const record = await options.store.get(claimId);
  if (record === null) return { ok: false, reason: 'unknown' };
  if (record.tenantId !== options.tenantId) return { ok: false, reason: 'tenant_mismatch' };
  if (!secretsMatch(record.secretHash, secret)) return { ok: false, reason: 'secret_mismatch' };
  if (record.consumedAt !== null) return { ok: false, reason: 'consumed' };
  if (Date.parse(record.expiresAt) <= options.now.getTime()) return { ok: false, reason: 'expired' };

  const consumed = await options.store.consume(claimId, options.now);
  if (consumed === null) return { ok: false, reason: 'consumed' };
  return { ok: true, record: consumed };
}
