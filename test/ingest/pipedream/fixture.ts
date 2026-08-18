/**
 * Shared harness for the U9 connector suite. Not a `*.test.ts` file.
 *
 * Everything vendor-shaped is a port with an in-memory implementation: the
 * Pipedream API is an injected {@link HttpTransport} answering scripted
 * responses, the provider adapters are driven through that same transport, and
 * the connector state store is the in-memory one. The database half comes from
 * U8's fixture unchanged — the gate is theirs, and a second fixture for it
 * would be a second arrangement to keep true.
 *
 * No network, no model call, no credential.
 */

import {
  createInMemoryCredentialMinter,
  createTenantStorage,
  type TenantStorage,
} from '../../../src/control/storage.ts';
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
  PipedreamConfig,
} from '../../../src/ingest/pipedream/client.ts';
import type {
  ProviderListOutcome,
  ProviderListRequest,
  ProviderSource,
  PullPage,
} from '../../../src/ingest/pipedream/sources/types.ts';
import type { ConnectorSource } from '../../../src/ingest/cursor.ts';
import type { SourceType } from '../../../src/core/write/write-path.ts';

/** A vendor config with no credential in it that anything could use. */
export const CONFIG: PipedreamConfig = {
  projectId: 'proj-test',
  environment: 'development',
  clientId: 'client-test',
  clientSecret: 'secret-test-not-a-credential',
  baseUrl: 'https://api.example-connect.test/v1',
};

/** A storage accessor over the in-process minter. No network, no parent secret. */
export function testStorage(): TenantStorage {
  return createTenantStorage({
    minter: createInMemoryCredentialMinter({
      parentAccessKeyId: 'fixture-key',
      parentSecretAccessKey: 'fixture-secret',
    }),
  });
}

export interface ScriptedResponse {
  readonly status: number;
  readonly body: unknown;
  /**
   * What a `binary: true` request gets back.
   *
   * Separate from `body` on purpose: a screenshot that arrived as a JS string
   * has already been through a UTF-8 round trip and is no longer that
   * screenshot, so a fixture that let bytes come from `body` would be unable to
   * fail the very corruption it is meant to catch.
   */
  readonly bytes?: Uint8Array;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * A request as it went out, plus **what the vendor would read out of it**.
 *
 * `target` is the decoded upstream URL for a proxy call and the URL itself for
 * everything else. It exists because a proxy call no longer *contains* the
 * upstream path — it carries it base64url-encoded in one path segment — so a
 * test that asserts on `url` can only assert that the builder agrees with
 * itself. Asserting on `target` asserts on what Google is actually asked for,
 * which is the thing that was wrong.
 */
export interface RecordedRequest extends HttpRequest {
  readonly target: string;
}

export interface ScriptedTransport extends HttpTransport {
  readonly requests: readonly RecordedRequest[];
  /** Queue one response for the next matching request. Matched against {@link RecordedRequest.target}. */
  on(match: string | RegExp, response: ScriptedResponse | (() => ScriptedResponse)): void;
  /** What every unmatched request gets. Defaults to a 404. */
  fallback(response: ScriptedResponse): void;
}

/** The proxy shape's own refusals, as the live vendor spells them. */
interface ProxyRead {
  /** The decoded upstream URL, when the call is routable at all. */
  readonly target: string;
  /** Set when the vendor would refuse before the upstream is ever reached. */
  readonly refusal?: ScriptedResponse;
}

const PROXY_MARKER = '/proxy/';

/**
 * What the vendor makes of a proxy URL — **measured against the live project on
 * 2026-08-17**, not reasoned about. Each refusal below is a status and a body
 * this fake was seen to receive:
 *
 *   * a path with more than one segment after `/proxy/` → `404 {"error":"Route
 *     not found"}`. That is both the app-relative shape this repo shipped
 *     (`/proxy/gmail/gmail/v1/users/me/profile`) and a standard-base64 segment
 *     whose alphabet emits a raw `/` — the two mistakes land on the same 404.
 *   * no `external_user_id` → `400 {"error":"External user ID missing"}`.
 *   * no `account_id` → `400 {"error":"Account ID missing"}`.
 *
 * **One deliberate deviation from the vendor, and it is the important one.** An
 * upstream query parameter placed on the *proxy* URL is silently dropped by the
 * vendor: the call answers `200` with data that ignored `maxResults` and `q`
 * entirely — the worst failure shape available, because it looks like a working
 * connector reading the wrong thing. A faithful fake would reproduce that
 * silence and no test could catch it, so this one throws and names the
 * parameter instead. Do not "fix" this to match the vendor.
 */
function readProxyUrl(url: string): ProxyRead | null {
  const parsed = new URL(url);
  const at = parsed.pathname.indexOf(PROXY_MARKER);
  if (at < 0) return null;

  const segment = parsed.pathname.slice(at + PROXY_MARKER.length);
  const unroutable = { status: 404, body: { error: 'Route not found' } } as const;
  if (segment.length === 0 || segment.includes('/')) {
    return { target: url, refusal: unroutable };
  }

  // Lenient about the alphabet, exactly as the vendor is: a padded, standard
  // base64 segment decodes fine here and answered 200 there. What the vendor
  // cannot survive is a raw `/`, and that is caught above as a routing failure
  // rather than as a decoding one — which is what it is.
  const decoded = Buffer.from(segment, 'base64url').toString('utf8');

  const scope = parsed.searchParams;
  const extra = [...scope.keys()].filter((key) => key !== 'external_user_id' && key !== 'account_id');
  if (extra.length > 0) {
    throw new Error(
      `the proxy URL carries '${extra.join("', '")}', which the vendor drops: an upstream query ` +
        'belongs inside the encoded target, or the call returns 200 with unfiltered data',
    );
  }
  if ((scope.get('external_user_id') ?? '').length === 0) {
    return { target: decoded, refusal: { status: 400, body: { error: 'External user ID missing' } } };
  }
  if ((scope.get('account_id') ?? '').length === 0) {
    return { target: decoded, refusal: { status: 400, body: { error: 'Account ID missing' } } };
  }

  // The fake routes by upstream URL, so it cannot resolve a target that does not
  // name one. The live vendor is more forgiving — it resolves a relative target
  // against the connected app's own base — but that base is a vendor default
  // this repo cannot see, and Calendar proves the host is load-bearing
  // (`calendar.googleapis.com` answers Google's own 404; `www.googleapis.com`
  // answers the calendar). So an unverifiable target is refused here.
  if (!decoded.startsWith('https://') && !decoded.startsWith('http://')) {
    return { target: decoded, refusal: unroutable };
  }
  return { target: decoded };
}

/**
 * The transport, scripted by **decoded upstream URL** substring. Order matters:
 * the first rule whose matcher hits and still has an answer wins, so a test can
 * queue `[410, 200]` for the same path and assert the recovery.
 */
export function createScriptedTransport(): ScriptedTransport {
  const requests: RecordedRequest[] = [];
  const rules: Array<{
    match: string | RegExp;
    answer: ScriptedResponse | (() => ScriptedResponse);
    used: boolean;
  }> = [];
  let missing: ScriptedResponse = { status: 404, body: { error: 'no rule' } };

  function matches(match: string | RegExp, url: string): boolean {
    return typeof match === 'string' ? url.includes(match) : match.test(url);
  }

  return {
    get requests() {
      return requests;
    },
    on(match, answer) {
      rules.push({ match, answer, used: false });
    },
    fallback(response) {
      missing = response;
    },
    send(request: HttpRequest): Promise<HttpResponse> {
      const proxy = readProxyUrl(request.url);
      const target = proxy === null ? request.url : proxy.target;
      requests.push({ ...request, target });

      if (proxy?.refusal !== undefined) {
        return Promise.resolve({
          status: proxy.refusal.status,
          body: JSON.stringify(proxy.refusal.body),
        });
      }

      const rule = rules.find((candidate) => !candidate.used && matches(candidate.match, target));
      const chosen = rule === undefined ? missing : typeof rule.answer === 'function' ? rule.answer() : rule.answer;
      if (rule !== undefined) rule.used = true;
      const text = typeof chosen.body === 'string' ? chosen.body : JSON.stringify(chosen.body);
      const ok = chosen.status >= 200 && chosen.status < 300;
      return Promise.resolve({
        status: chosen.status,
        // The production transport answers a successful binary fetch with an
        // empty `body` and the bytes beside it; a failed one still carries the
        // provider's JSON, because that is what the 429-vs-dead-file classifier
        // reads. Mirrored here so a test cannot pass against a shape the fleet
        // does not produce.
        body: request.binary === true && ok ? '' : text,
        ...(request.binary === true && chosen.bytes !== undefined ? { bytes: chosen.bytes } : {}),
        ...(chosen.headers === undefined ? {} : { headers: chosen.headers }),
      });
    },
  };
}

/** A transport that answers the OAuth token endpoint and nothing else. */
export function withToken(transport: ScriptedTransport): ScriptedTransport {
  transport.on('/oauth/token', {
    status: 200,
    body: { access_token: 'test-access-token', expires_in: 3600, token_type: 'Bearer' },
  });
  return transport;
}

// ---------------------------------------------------------------------------
// A provider source driven by a script rather than by HTTP, for the pull tests.
// ---------------------------------------------------------------------------

export type SourceStep = ProviderListOutcome;

export interface FakeSource extends ProviderSource {
  readonly requests: readonly ProviderListRequest[];
}

export function emptyPage(overrides: Partial<PullPage> = {}): PullPage {
  return {
    items: [],
    tombstones: [],
    failures: [],
    nextCursor: null,
    outsideWindow: null,
    ...overrides,
  };
}

export function page(overrides: Partial<PullPage>): ProviderListOutcome {
  return { ok: true, page: emptyPage(overrides) };
}

/**
 * Answers each `list` call with the next scripted step; the last step repeats,
 * so a test that only cares about the first call does not have to script the
 * recovery call it does not assert on.
 */
export function createFakeSource(
  source: ConnectorSource,
  sourceType: SourceType,
  steps: readonly SourceStep[],
): FakeSource {
  const requests: ProviderListRequest[] = [];
  let index = 0;

  return {
    source,
    sourceType,
    get requests() {
      return requests;
    },
    list(request: ProviderListRequest): Promise<ProviderListOutcome> {
      requests.push(request);
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      return Promise.resolve(step ?? { ok: true, page: emptyPage() });
    },
  };
}

/** Deterministic prose, long enough to chunk, distinct per seed. */
export function mailBody(seed: string, paragraphs = 2): string {
  const lines: string[] = [];
  for (let index = 0; index < paragraphs; index += 1) {
    lines.push(
      `${seed} paragraph ${index}: the review covered hiring, runway and the ` +
        `pricing change, and the follow-up was assigned to the same owner as last time.`,
    );
  }
  return lines.join('\n\n');
}
