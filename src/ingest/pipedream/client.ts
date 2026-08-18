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
 * **The proxy call's URL and header shape was the third unverified detail, and
 * it was wrong.** It is now measured, against the live project on 2026-08-17
 * with real connected accounts, and it is confined to {@link providerUrl},
 * {@link PROVIDER_API_BASE} and {@link proxyHeaders}; everything above them
 * still speaks in `ProviderRequest`.
 *
 * What "wrong" cost, so the next person weighs an unverified vendor detail
 * properly: the shipped shape put the app and an app-relative path in the URL
 * (`/proxy/gmail/gmail/v1/users/me/profile`) and the scope in `x-pd-*` headers.
 * The vendor answers that with `404 {"error":"Route not found"}`. Every
 * connector poll in production failed on it — eight consecutive runs, all three
 * sources, `provider_error`, `items_seen: 0`, each dying in ~450ms at the
 * provider call. Zero pages, zero chunks, for as long as it was deployed. The
 * tests were green throughout, because the transport fake matched the URL the
 * builder produced and the builder produced what the fake matched. The fake now
 * decodes the target the way the vendor does and reproduces the vendor's own
 * refusals, which is what makes this suite evidence rather than agreement.
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
  /**
   * Answer in bytes rather than in text.
   *
   * A screenshot decoded as UTF-8 and re-encoded is not that screenshot: every
   * byte that is not a legal sequence becomes U+FFFD, and the object stored
   * under the tenant's prefix is a corrupted file that no decoder will ever
   * open. So a media fetch asks for {@link HttpResponse.bytes}, and a transport
   * that cannot supply them says so by leaving the field absent rather than by
   * handing back a mangled string.
   */
  readonly binary?: boolean;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
  /** Present only for a `binary` request, and only from a transport that can. */
  readonly bytes?: Uint8Array;
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
      if (request.binary !== true) return { status: response.status, body: await response.text() };

      const bytes = new Uint8Array(await response.arrayBuffer());
      // A failed binary fetch answers with a JSON error, and the classifier
      // upstream reads `body` to tell a 429 from a dead file. A successful one
      // is a picture, and decoding it to a string to throw the string away is
      // the whole payload in memory twice.
      const ok = response.status >= 200 && response.status < 300;
      return { status: response.status, body: ok ? '' : new TextDecoder().decode(bytes), bytes };
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
  /**
   * **This fleet could not authenticate itself.** Not the user's grant — the
   * `client_credentials` mint against the vendor's own `/oauth/token`, with the
   * fleet-wide client id and secret. See {@link classifyTokenFailure} for why
   * it is not `auth_expired` and {@link classifyHttpFailure} for the one that
   * is.
   */
  | 'fleet_auth_failed'
  | 'rate_limited'
  | 'cursor_invalid'
  | 'provider_error'
  | 'not_connected';

export interface ClientFailure {
  readonly ok: false;
  readonly reason: PullFailureReason;
  readonly status: number | null;
  /**
   * A sentence a human needs, when the code alone does not carry it (U18).
   *
   * Optional and additive. `reason` is the closed set every caller branches on
   * and stays the contract; this is for the failures that share a code and not a
   * cause — a `provider_error` from a 502 and a `provider_error` from "brainz's
   * own OAuth application has not cleared CASA" are the same code and completely
   * different work, and an erasure receipt that could not tell them apart would
   * report a leg as failed without saying what to do about it.
   *
   * It must never carry row content: these strings reach logs and receipts.
   */
  readonly detail?: string;
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
  /**
   * Answer as bytes. The value is a `Uint8Array`, or `null` when the transport
   * in use cannot produce one — never a string, because a string is a
   * screenshot that has been through a UTF-8 round trip and is no longer that
   * screenshot.
   */
  readonly binary?: boolean;
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

/**
 * What the vendor's answer actually establishes.
 *
 * `accepted` is the one that stops this from being a claim about evidence
 * nobody has: a `202` says the request was queued, not that the record is gone,
 * and reporting `deleted: true` over it puts a sentence in an erasure receipt
 * that the vendor never said.
 */
export type DeletionEvidence = 'deleted' | 'already_absent' | 'accepted';

export interface ExternalUserDeletion {
  /** True only when the vendor said the record is gone, or already was. */
  readonly deleted: boolean;
  readonly evidence: DeletionEvidence;
  /**
   * Whether the grant was revoked **at the provider**, which is what R12's leg
   * actually promises. `unverified` until Q2 is answered in writing; promoting
   * it without that answer puts a false sentence in a privacy policy.
   */
  readonly tokensRevoked: 'confirmed' | 'unverified';
}

/**
 * One account attached at the vendor, as its accounts listing reports it — and
 * deliberately four fields rather than the row.
 *
 * **What is absent is the interesting part.** No label, no email, no owner.
 * `ConnectorState.accountKey` is *the provider's own spelling* of the mailbox,
 * adopted from the first provider listing that reports one and refused if a
 * later one disagrees — a stop the runner calls `identity_changed`. The vendor's
 * account record speaks a different vocabulary, so copying its label into that
 * field would wedge the first real pull against a mailbox that never changed.
 * Reconciliation therefore learns *that* an account exists and *which
 * connection id* to call it by, and claims nothing about whose it is.
 *
 * `dead` is the vendor's own verdict on the grant. It is read as `false` when
 * the vendor does not say, because an account listed without a health field is
 * an account the vendor is offering, and treating silence as death would
 * disconnect every user the day a field is renamed.
 */
export interface ConnectedAccount {
  /** The vendor's connection id, which is what the proxy's `account_id` takes. */
  readonly accountId: string;
  /** Which app it is, when the listing says. Null means the listing did not. */
  readonly appSlug: string | null;
  /** The vendor's own verdict on the grant. */
  readonly dead: boolean;
  /** When it was attached, if the listing says. Orders two live accounts. */
  readonly createdAt: string | null;
}

export interface PipedreamClient extends ProviderApi {
  /**
   * Every account attached under one external user — the channel through which
   * this fleet learns that a consent screen was completed.
   *
   * **It is a read, and it asks for no credential.** The vendor offers an
   * `include_credentials` parameter on this endpoint; it is not sent, and must
   * not be. Nothing in the reconciliation path needs a provider token — the
   * proxy call carries the scope in headers — and a request that asked for one
   * would put a live Google credential in this process's memory and in whatever
   * logged the response.
   */
  listAccounts(request: {
    readonly externalUserId: string;
  }): Promise<ClientOutcome<readonly ConnectedAccount[]>>;
  mintConnectToken(request: {
    readonly externalUserId: string;
    readonly now: Date;
    readonly ttlSeconds?: number;
    /**
     * Which app the connect page should offer, when the caller knows.
     *
     * The token is not app-scoped — it authorises *this external user* to attach
     * *something* — so this only decides what the vendor's page opens on. A
     * caller that omits it hands the user a page where they choose, which is a
     * worse product and not a wrong one.
     */
    readonly app?: ProviderApp;
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
  /** One waiter per key at a time — see {@link RateBudget.take}. */
  const queues = new Map<string, Promise<void>>();

  function refill(key: string): { tokens: number; at: number } {
    const at = now();
    const bucket = buckets.get(key) ?? { tokens: burst, at };
    const elapsed = Math.max(0, at - bucket.at);
    const tokens = Math.min(burst, bucket.tokens + (elapsed / 1_000) * qps);
    const updated = { tokens, at };
    buckets.set(key, updated);
    return updated;
  }

  /**
   * How many sleeps one caller will sit through before it is let past anyway.
   *
   * Fail-open on arithmetic: a budget that could refuse would turn a pacing
   * decision into a lost pull. High enough that the ceiling is real, finite so
   * a clock that never advances cannot wedge a worker.
   */
  const MAX_WAITS = 64;

  async function spend(key: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_WAITS; attempt += 1) {
      const bucket = refill(key);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }
      await sleep(Math.max(1, Math.ceil(((1 - bucket.tokens) / qps) * 1_000)));
    }
    const bucket = refill(key);
    bucket.tokens = Math.max(0, bucket.tokens - 1);
  }

  return {
    /**
     * **Waiters are serialized per key, and every one re-checks after it
     * sleeps.** Sleeping and then decrementing unconditionally let N callers
     * queued behind one token all wake and all spend it: the bucket goes
     * negative, the burst is however many callers happened to be waiting, and
     * the pacing this exists for never happened.
     */
    take(key) {
      const previous = queues.get(key) ?? Promise.resolve();
      const mine = previous.then(() => spend(key));
      // The chain must never carry a rejection forward, or one failed sleep
      // poisons every later caller on this key.
      queues.set(
        key,
        mine.then(
          () => undefined,
          () => undefined,
        ),
      );
      return mine;
    },
  };
}

// ---------------------------------------------------------------------------
// The client.
// ---------------------------------------------------------------------------

let processRateBudget: RateBudget | null = null;

/**
 * The one budget every client in this process shares unless told otherwise.
 *
 * **The vendor ceiling is per project, not per tenant.** A private default per
 * client means N tenants each hold the full 5 QPS, every one of them reports
 * itself within budget, and the project is throttled anyway. This makes the
 * bound hold across one process.
 *
 * It does **not** bound the fleet. Several worker processes, or several
 * machines, still multiply this by their count — a real ceiling needs shared
 * state (a control-plane counter or a token service), which is a rung this unit
 * does not own. Stated rather than implied, because a budget that looks global
 * and is not is worse than one that is obviously local.
 */
export function sharedRateBudget(): RateBudget {
  processRateBudget ??= createRateBudget({ qps: DEFAULT_QPS, burst: DEFAULT_BURST });
  return processRateBudget;
}

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

/**
 * The vendor's external user for one tenant's one source — **per source, and
 * that is a revocation decision rather than a naming convention.**
 *
 * The only revocation this vendor offers is
 * {@link PipedreamClient.deleteExternalUser}: there is no per-account delete, so
 * whatever an external user id spans is what a disconnect destroys. Bind it to
 * the tenant alone and `ConnectorVendor.disconnect({source: 'gmail'})` silently
 * revokes that tenant's calendar and drive at the vendor too — a per-source port
 * whose implementation is per-tenant, which is the shape where a user unhooks
 * their mailbox and loses their meetings a fortnight later with nothing in the
 * product having said so. Per source, `deleteExternalUser` means exactly
 * "disconnect this source" and the port's contract is the vendor call's.
 *
 * The accepted cost, stated: three connected sources are three external users at
 * the vendor for one person, so a vendor-side per-user fee is paid per source
 * rather than per tenant. That is the same arithmetic `connectorGate` is built on
 * (a fee per connected account, whether used or not) rather than a new one.
 *
 * **The result is a URL path segment**, so it is checked against the same
 * anchored alphabet every other one is, and a tenant id long enough to overflow
 * it is a refusal here rather than a malformed request at the vendor. In
 * practice `newTenantId` yields 26 characters and the longest source suffix is
 * six; the bound only bites a deployment that set an extravagant
 * `BRAINZ_TENANT_ID_PREFIX`, which is a configuration mistake worth naming at
 * the moment it is made.
 */
export function externalUserIdFor(tenantId: string, source: ConnectorSource): string {
  const id = `${tenantId}-${source}`;
  assertExternalUserId(id);
  return id;
}

/** How early a cached access token is treated as expired. */
const TOKEN_SAFETY_MARGIN_MS = 60_000;

/**
 * The floor and ceiling on a token lifetime the vendor reports.
 *
 * A vendor answering `200` with `expires_in: 0` is taken at its word by a
 * client that trusts the number: the cache is stale the moment it is written,
 * so every single call re-mints — an unbounded mint loop against a vendor that
 * is already unhappy. The floor has to clear the safety margin, or the clamp
 * changes nothing.
 */
const MIN_TOKEN_LIFETIME_MS = 5 * 60_000;
const MAX_TOKEN_LIFETIME_MS = 24 * 60 * 60_000;
const DEFAULT_TOKEN_LIFETIME_MS = 3_600_000;

/** The rate-budget key the vendor's own OAuth endpoint spends. */
export const OAUTH_RATE_KEY = 'oauth';

/**
 * Why the token endpoint refused.
 *
 * Deliberately **not** {@link classifyHttpFailure}: that one checks the cursor
 * case first, which is meaningless on a mint, and it would answer
 * `auth_expired` for a 429 — a code that reads to a user as "reconnect this
 * source" when the vendor merely asked us to wait. A connector that tells
 * somebody their Google grant died because the vendor was busy has lost their
 * trust for a reason that fixes itself in a second.
 *
 * ============================================================================
 * WHY THE RESIDUAL IS `fleet_auth_failed` AND NOT `auth_expired`
 * ============================================================================
 * **This request has no user in it.** It is `grant_type=client_credentials`
 * carrying `BRAINZ_PIPEDREAM_CLIENT_ID` and `BRAINZ_PIPEDREAM_CLIENT_SECRET` —
 * one pair, shared by every tenant in the fleet — and it is aimed at the
 * vendor's own endpoint rather than at anybody's Google account. Every answer
 * it can give is a statement about *us*: 400 is a malformed body, 401 and 403
 * are a rotated or mistyped secret, 404 is a `baseUrl` pointing at nothing, 422
 * is a body the vendor parsed and rejected. None of them is evidence about a
 * grant, because no grant was consulted.
 *
 * While this answered `auth_expired`, and `auth_expired` is terminal, a single
 * rotated fleet credential marked **every tenant's every lane** dead — each one
 * telling its owner to reconnect an account that was working perfectly, with no
 * retry that could ever recover it once the credential was fixed. The failure
 * the user could not cause, could not see, and could not repair was reported to
 * them as their fault.
 *
 * So the residual bucket is the fleet's own, and it is **retryable**
 * (`pull.ts:pullStopIsTerminal`): the remedy is an operator's — a redeploy, a
 * secret rotation — and the lane must be alive to notice when it lands.
 *
 * **The two neighbours stay where they were**, and they are the reason this is
 * a bucket rather than a status list. A 429 is the vendor asking us to wait and
 * a 5xx or 408 is the vendor failing; both are the vendor's own condition,
 * neither implicates our credential, and both already had the right code.
 */
export function classifyTokenFailure(status: number): PullFailureReason {
  if (status === 429) return 'rate_limited';
  if (status >= 500 || status === 408) return 'provider_error';
  return 'fleet_auth_failed';
}

/**
 * What a `DELETE /users/{id}` answer means.
 *
 * `classifyHttpFailure` is wrong here in two directions and both matter for an
 * erasure leg: it answers `cursor_invalid` for the ordinary 410 that means
 * "already deleted" (a code about a sync token, on a call that has none), and
 * retryable `provider_error` for the 404 that means the same thing. An erasure
 * that retries forever against an absent record reports failure on a deletion
 * that is complete.
 */
export function classifyDeletion(
  status: number,
): { readonly deleted: boolean; readonly evidence: DeletionEvidence } | null {
  if (status === 404 || status === 410) return { deleted: true, evidence: 'already_absent' };
  if (status === 202) return { deleted: false, evidence: 'accepted' };
  if (status >= 200 && status < 300) return { deleted: true, evidence: 'deleted' };
  return null;
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/**
 * The accounts listing, read defensively.
 *
 * **Every field but the id is optional, and an entry with no id is dropped.**
 * The id is the only thing a later proxy call cannot proceed without — it
 * becomes the proxy's `account_id`, which the vendor requires — so an entry
 * missing it is not an account this
 * fleet can address, and adopting one would write a `ConnectorState` whose every
 * poll fails. Everything else degrades: an unnamed app is `null` and the caller
 * decides what silence means, an unparseable timestamp is `null` and orders
 * nothing.
 *
 * Written as a loop over a shape rather than a cast, for the reason
 * `parseConnectorState` is: a vendor's JSON is the other side of a network, and
 * this fleet spends money on what it says.
 */
export function parseAccounts(body: unknown): readonly ConnectedAccount[] {
  const data = body === null || typeof body !== 'object' ? undefined : (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const accounts: ConnectedAccount[] = [];
  for (const entry of data) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const id = record['id'];
    if (typeof id !== 'string' || id.length === 0) continue;

    const app = record['app'];
    const slug =
      app !== null && typeof app === 'object' ? (app as Record<string, unknown>)['name_slug'] : undefined;
    const createdAt = record['created_at'];

    accounts.push({
      accountId: id,
      appSlug: typeof slug === 'string' && slug.length > 0 ? slug : null,
      // Either spelling of "this grant is finished". Absent means alive: an
      // account listed with no health field is one the vendor is offering, and
      // reading silence as death would disconnect everyone the day it is
      // renamed.
      dead: record['dead'] === true || record['healthy'] === false,
      createdAt:
        typeof createdAt === 'string' && !Number.isNaN(Date.parse(createdAt)) ? createdAt : null,
    });
  }
  return accounts;
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

/**
 * **Which upstream each app is addressed to**, and the only place any of them
 * is named.
 *
 * The proxy forwards to an absolute URL, so the host is now part of every
 * request this fleet makes and is no longer the vendor's business to guess.
 * Keyed by {@link ProviderApp} rather than repeated in the three adapters
 * because the two would then be able to disagree — `app: 'gmail'` pointed at
 * Drive's host is a mistake this table makes unrepresentable, and the adapters
 * already name their app on every call.
 *
 * **The host is load-bearing, and was measured rather than assumed.** Calendar
 * answers `200` under `www.googleapis.com` and Google's own HTML `404` under
 * `calendar.googleapis.com` — same path, same account, same request. Gmail is
 * the other way round and lives on its own host. Every entry below was checked
 * against the live project on 2026-08-17 with the founder's connected accounts;
 * changing one without re-checking it is how this file got here.
 */
export const PROVIDER_API_BASE: Readonly<Record<ProviderApp, string>> = {
  gmail: 'https://gmail.googleapis.com',
  google_calendar: 'https://www.googleapis.com',
  google_drive: 'https://www.googleapis.com',
};

/** The absolute upstream URL a provider request names, query and all. */
function upstreamUrl(request: ProviderRequest): string {
  return `${PROVIDER_API_BASE[request.app]}${request.path}${queryString(request.query)}`;
}

/**
 * Vendor detail #1, **measured against the live project on 2026-08-17** rather
 * than reasoned about — which is what the header used to admit it had not been.
 *
 * The proxy takes the whole upstream URL as a single **base64url** path segment
 * and the connection's scope as **query parameters**:
 *
 *     /connect/{project}/proxy/{base64url(the absolute upstream URL, query and all)}
 *       ?external_user_id={id}&account_id={apn_…}
 *
 * Three things about that are each a way to get a wrong answer rather than an
 * error, so each is deliberate:
 *
 *   * **base64url, padding stripped.** `+`, `/` and `=` are not path
 *     characters. A raw `/` splits the segment and the vendor answers
 *     `404 {"error":"Route not found"}` — the same 404 the app-relative shape
 *     answered, reached a completely different way. This is not hypothetical
 *     for one file in a thousand: a 44-character Drive id (the everyday length)
 *     puts the `?` at an offset where standard base64 emits one, so every
 *     `alt=media` download of an ordinary document would break.
 *   * **the upstream's own query goes INSIDE the encoded target.** Left on the
 *     proxy URL it is silently dropped: the vendor answers `200` and Google
 *     never sees `maxResults` or `q`. An unfiltered mailbox read that reports
 *     itself as a healthy pull is worse than any outage, because nothing
 *     upstream of it can tell.
 *   * **the scope goes on the proxy URL, not in headers.** See
 *     {@link proxyHeaders}.
 */
function providerUrl(config: PipedreamConfig, request: ProviderRequest, accountId: string): string {
  // The id reaches a URL now rather than a header, so it is checked against the
  // anchored alphabet here — the same reason `listAccounts` checks it.
  assertExternalUserId(request.externalUserId);
  const base = config.baseUrl ?? DEFAULT_BASE_URL;
  const scope = new URLSearchParams({
    external_user_id: request.externalUserId,
    account_id: accountId,
  });
  const target = Buffer.from(upstreamUrl(request), 'utf8').toString('base64url');
  return `${base}/connect/${config.projectId}/proxy/${target}?${scope.toString()}`;
}

/**
 * Vendor detail #4 — see the header, which names the first three.
 *
 * The connect page takes the app it should open on as a query parameter. It is
 * appended here, to whatever URL the mint answered, rather than being built into
 * a URL of our own: the vendor supplies `connect_link_url` and may change its
 * shape, and a caller that re-derived the whole link would be pinning the part
 * the vendor owns in order to add the part we own.
 *
 * A URL the vendor answered that we cannot parse is returned untouched. An
 * unparseable link with no `app` still works — the user picks — and a link this
 * function mangled does not.
 */
export function connectLinkFor(url: string, app: ProviderApp | undefined): string {
  if (app === undefined) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('app', app);
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Vendor detail #2 — see the header. **The environment, and nothing else.**
 *
 * The scope used to travel here as `x-pd-external-user-id` and
 * `x-pd-account-id`. It does not: the proxy reads both from the query string
 * (see {@link providerUrl}), and it answers `400 {"error":"External user ID
 * missing"}` / `400 {"error":"Account ID missing"}` when they are absent from
 * there — whatever the headers say. So the two headers are removed rather than
 * left in place: a header that reads as the thing scoping the request, and
 * isn't, is harmless today and misleading for as long as the file lives.
 *
 * `x-pd-environment` stays on every call to this vendor, here and on the
 * accounts listing and the external-user delete, because development and
 * production are separate keyspaces and the vendor refuses rather than guesses.
 */
function proxyHeaders(config: PipedreamConfig): Record<string, string> {
  return { 'x-pd-environment': config.environment };
}

export function createPipedreamClient(options: {
  readonly config: PipedreamConfig;
  readonly transport: HttpTransport;
  readonly now?: () => Date;
  readonly rate?: RateBudget;
}): PipedreamClient {
  const { config, transport } = options;
  const now = options.now ?? (() => new Date());
  // Shared by default: the vendor ceiling is per project, so a private budget
  // per client is N tenants each holding the whole quota. See the note there
  // about what this still does not bound.
  const rate = options.rate ?? sharedRateBudget();
  const base = config.baseUrl ?? DEFAULT_BASE_URL;

  let accessToken: { value: string; expiresAt: number } | null = null;

  /**
   * The vendor's own OAuth, cached and **paced**.
   *
   * The mint is a request to the same vendor under the same project quota. A
   * call that spends it without asking the budget is a hole in the ceiling, and
   * the hole is widest exactly when it hurts — a token endpoint answering
   * short-lived tokens is minted against on every call.
   */
  async function authorize(): Promise<ClientOutcome<string>> {
    const at = now().getTime();
    if (accessToken !== null && accessToken.expiresAt - TOKEN_SAFETY_MARGIN_MS > at) {
      return { ok: true, value: accessToken.value };
    }

    await rate.take(OAUTH_RATE_KEY);
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
      return {
        ok: false,
        reason: classifyTokenFailure(response.status),
        status: response.status,
      };
    }

    const body = parseJson(response.body) as { access_token?: unknown; expires_in?: unknown } | null;
    const token = body?.access_token;
    if (typeof token !== 'string' || token.length === 0) {
      // **A third case, filed with the second.** The vendor answered
      // successfully and gave us nothing usable — so this is not a refusal, and
      // it is certainly not a statement about anybody's grant. What decides the
      // code is the consequence, and the consequence is identical to a refused
      // mint: this fleet holds no token, every tenant's next call fails, and no
      // tenant can do anything about it. `provider_error` would be the other
      // candidate and it would bury this in the same bucket as every 502 the
      // vendor ever answers, which is the one place an operator would never
      // find it.
      //
      // What the code cannot carry, `detail` does — a static sentence, never a
      // word of the body: these strings reach logs and erasure receipts.
      return {
        ok: false,
        reason: 'fleet_auth_failed',
        status: response.status,
        detail: 'the vendor’s token endpoint answered 2xx with no access_token',
      };
    }
    const reported =
      typeof body?.expires_in === 'number' && Number.isFinite(body.expires_in)
        ? body.expires_in * 1_000
        : DEFAULT_TOKEN_LIFETIME_MS;
    const lifetimeMs = Math.min(
      MAX_TOKEN_LIFETIME_MS,
      Math.max(MIN_TOKEN_LIFETIME_MS, reported),
    );
    accessToken = { value: token, expiresAt: at + lifetimeMs };
    return { ok: true, value: token };
  }

  async function call(
    request: HttpRequest & { readonly rateKey?: string },
  ): Promise<ClientOutcome<{ status: number; body: string; bytes?: Uint8Array }>> {
    const authorized = await authorize();
    if (!authorized.ok) return authorized;

    if (request.rateKey !== undefined) await rate.take(request.rateKey);

    const response = await transport.send({
      method: request.method,
      url: request.url,
      headers: { ...request.headers, authorization: `Bearer ${authorized.value}` },
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.binary === true ? { binary: true } : {}),
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

    return {
      ok: true,
      value: {
        status: response.status,
        body: response.body,
        ...(response.bytes === undefined ? {} : { bytes: response.bytes }),
      },
    };
  }

  return {
    /**
     * Vendor detail #5: `GET /connect/{project}/accounts` filtered by
     * `external_user_id`, which answers `200` with an empty `data` array for an
     * external user that has attached nothing. That is the answer the
     * reconciler sees for every user still sitting on a consent screen, so it
     * has to be an ordinary success rather than a `404`.
     *
     * **This is the vendor's own listing, not a proxy call**, and the
     * distinction is the whole reason the two are spelled out separately here.
     * A proxy call is scoped by `external_user_id` *and* `account_id` on the
     * URL and forwards to Google; this one is scoped by `external_user_id`
     * alone, is answered by the vendor itself, and is where the `account_id`
     * every proxy call needs comes from in the first place. The id is checked
     * against the anchored alphabet because it reaches a URL, the same as
     * there.
     */
    async listAccounts(request) {
      assertExternalUserId(request.externalUserId);
      const outcome = await call({
        method: 'GET',
        url: `${base}/connect/${config.projectId}/accounts?external_user_id=${encodeURIComponent(request.externalUserId)}`,
        headers: { 'x-pd-environment': config.environment },
        rateKey: 'connect',
      });
      if (!outcome.ok) return outcome;
      return { ok: true, value: parseAccounts(parseJson(outcome.value.body)) };
    },

    async mintConnectToken(request) {
      assertExternalUserId(request.externalUserId);
      const outcome = await call({
        method: 'POST',
        url: `${base}/connect/${config.projectId}/tokens`,
        headers: { 'content-type': 'application/json' },
        // The connect endpoint is the vendor's, under the same project quota.
        // Pacing only the OAuth mint leaves a burst of these unpaced from the
        // second call onwards, which is when the access token is cached.
        rateKey: 'connect',
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
          connectLinkUrl: connectLinkFor(
            typeof link === 'string' && link.length > 0
              ? link
              : `https://pipedream.com/_static/connect.html?token=${encodeURIComponent(token)}`,
            request.app,
          ),
        },
      };
    },

    async request(request) {
      /**
       * **A proxy call without a connection id cannot succeed**, so it is not
       * made. The vendor answers `400 {"error":"Account ID missing"}`, which
       * classifies as `provider_error` — the code that reads as "the provider
       * had a problem, we will retry" — for a source that has nothing connected
       * to retry against. Refused here, it says the true thing (`not_connected`,
       * which the ingest log holds as `cancelled`) and spends no vendor quota
       * saying it.
       *
       * Reported rather than thrown, and reported as a *typed* failure, because
       * every caller of this method already branches on `reason` and none of
       * them expects an exception.
       */
      const accountId = request.accountId ?? null;
      if (accountId === null || accountId.length === 0) {
        return {
          ok: false,
          reason: 'not_connected',
          status: null,
          detail: 'the proxy call needs the connection id this source has not been given yet',
        };
      }

      const outcome = await call({
        method: request.method,
        url: providerUrl(config, request, accountId),
        headers: proxyHeaders(config),
        rateKey: request.app,
        ...(request.binary === true ? { binary: true } : {}),
      });
      if (!outcome.ok) return outcome;
      // `null` rather than the text body when a transport cannot answer in
      // bytes: the caller must be able to tell "no bytes" from "here are some
      // bytes", and a decoded string would look exactly like the second one.
      if (request.binary === true) return { ok: true, value: outcome.value.bytes ?? null };
      return { ok: true, value: request.raw === true ? outcome.value.body : parseJson(outcome.value.body) };
    },

    /**
     * R12's fourth erasure leg.
     *
     * **Its one caller is the disconnect button** (`src/web/connectors.ts`),
     * which revokes the external user for one source. Wiring it into the
     * *erasure* pipeline — where an account deletion revokes every source a
     * subject ever connected — is still U17's, and building half of that
     * pipeline here would be worse than the gap. See the header and
     * `docs/vendor/2026-08-12-pipedream-compliance.md`.
     */
    async deleteExternalUser(request) {
      assertExternalUserId(request.externalUserId);
      const authorized = await authorize();
      if (!authorized.ok) return authorized;

      await rate.take('connect');
      const response = await transport.send({
        method: 'DELETE',
        url: `${base}/connect/${config.projectId}/users/${request.externalUserId}`,
        // **`x-pd-environment`, and its absence was not a subtlety.** Every
        // other call to this vendor names the environment because the two are
        // separate keyspaces; this one did not, and the vendor does not guess —
        // it refuses with `400 {"error":"Environment missing"}`. That is no
        // verdict at all to `classifyDeletion`, so the client reported
        // `provider_error`, `ConnectorVendor.disconnect` threw, and
        // `/api/connectors DELETE` answered `500` to every user who pressed
        // disconnect. The mailbox stayed attached at the vendor and stayed
        // billed. Observed against the live project on 2026-08-17: the same
        // external user answers `400` without this header and `204` with it.
        headers: {
          authorization: `Bearer ${authorized.value}`,
          'x-pd-environment': config.environment,
        },
      });
      if (response.status === 401) accessToken = null;

      // Classified here rather than through `call`, because the shared
      // classifier reads a 410 as an expired cursor — see `classifyDeletion`.
      const verdict = classifyDeletion(response.status);
      if (verdict === null) {
        return {
          ok: false,
          reason: classifyHttpFailure(response.status, parseJson(response.body)),
          status: response.status,
        };
      }

      // Never `confirmed`: whether deletion revokes the grant AT GOOGLE is a
      // vendor answer nobody has yet. See `ExternalUserDeletion`.
      return { ok: true, value: { ...verdict, tokensRevoked: 'unverified' } };
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
