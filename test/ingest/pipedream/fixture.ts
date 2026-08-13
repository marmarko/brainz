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
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ScriptedTransport extends HttpTransport {
  readonly requests: readonly HttpRequest[];
  /** Queue one response for the next matching request. */
  on(match: string | RegExp, response: ScriptedResponse | (() => ScriptedResponse)): void;
  /** What every unmatched request gets. Defaults to a 404. */
  fallback(response: ScriptedResponse): void;
}

/**
 * The transport, scripted by URL substring. Order matters: the first rule whose
 * matcher hits and still has an answer wins, so a test can queue `[410, 200]`
 * for the same path and assert the recovery.
 */
export function createScriptedTransport(): ScriptedTransport {
  const requests: HttpRequest[] = [];
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
      requests.push(request);
      const rule = rules.find((candidate) => !candidate.used && matches(candidate.match, request.url));
      const chosen = rule === undefined ? missing : typeof rule.answer === 'function' ? rule.answer() : rule.answer;
      if (rule !== undefined) rule.used = true;
      return Promise.resolve({
        status: chosen.status,
        body: typeof chosen.body === 'string' ? chosen.body : JSON.stringify(chosen.body),
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
