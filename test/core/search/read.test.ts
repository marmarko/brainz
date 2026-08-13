/**
 * The request path: the query embedding, and what happens when it does not
 * arrive.
 *
 * **This file exists because the degraded contract had no failure to survive.**
 * `runArms` takes `queryVector: readonly number[] | null` and skips the vector
 * arm on `null`, and a test that calls it with `null` is green in a codebase
 * where nothing ever *produces* the `null` — it exercises the branch and says
 * nothing about the contract. Assumption 5's promise is about a provider that
 * fails: "a failing embed call yields fused FTS+graph results carrying the
 * degraded flag, not a request error". So the guard below drives U20's gateway
 * through its **injected transport**, makes the transport refuse, and asserts on
 * what the read returns — which is the only shape in which the promise is
 * testable at all.
 *
 * **And the second guard is the plan.** `composeRanking` takes the plan as an
 * *optional* request field and recomputes an unrefined one when it is absent.
 * The arms, meanwhile, are dispatched from the refined plan — the one that saw
 * how many entities resolved. A caller that forgets the field therefore gets its
 * arms chosen by one plan and its ranking scored by another, silently, with no
 * error and a plausible-looking result list. It is exactly the failure mode this
 * unit is supposed to be hardened against, and it caught the author of the
 * unit's own debugging tool.
 */

import { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  createInMemorySpendMeter,
  createModelGateway,
  type ModelGateway,
  type ModelTransport,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/ai/gateway.ts';
import {
  createHostedKeyPool,
  createInMemoryProviderKeyBackend,
  createTenantProviderKeyStore,
} from '../../../src/ai/keys.ts';
import { HOSTED_PROFILE } from '../../../src/ai/routing.ts';
import { fleetIdentity, type CallerIdentity } from '../../../src/control/secrets.ts';
import { queryEncoding } from '../../../src/core/write/embed.ts';
import { recall } from '../../../src/core/search/read.ts';
import { EMBEDDING_DIMENSIONS, createSearchFixture, seedPage, type SearchFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const GRANT = ['personal:files', 'personal:mail'];
const TENANT = 'u5read';
const CALLER: CallerIdentity = fleetIdentity(TENANT);

let fixture: SearchFixture;
let sql: SQL;

/** A transport that answers, or refuses, and records what it was asked to encode. */
function transportThat(options: { readonly refuse: boolean }): ModelTransport & {
  readonly texts: string[];
} {
  const texts: string[] = [];
  return {
    id: 'u5-read-fake',
    get texts() {
      return texts;
    },
    invoke(request: TransportRequest): Promise<TransportResponse> {
      if (request.input.kind === 'embedding') texts.push(...request.input.texts);
      if (options.refuse) return Promise.reject(new Error('provider is having a day'));
      // A unit vector along the first axis. Nothing in this file depends on
      // where it lands — only on whether the arm ran.
      const vector = [1, ...new Array<number>(EMBEDDING_DIMENSIONS - 1).fill(0)];
      return Promise.resolve({
        output: {
          kind: 'embedding',
          vectors: (request.input as { texts: readonly string[] }).texts.map(() => vector),
        },
        usage: { inputTokens: 8, outputTokens: 0 },
      });
    },
  };
}

function gatewayThat(options: { readonly refuse: boolean }): {
  readonly gateway: ModelGateway;
  readonly transport: ReturnType<typeof transportThat>;
} {
  const transport = transportThat(options);
  return {
    transport,
    gateway: createModelGateway({
      profile: HOSTED_PROFILE,
      transport,
      meter: createInMemorySpendMeter(),
      keys: {
        store: createTenantProviderKeyStore({ backend: createInMemoryProviderKeyBackend() }),
        hosted: createHostedKeyPool({
          openai: 'hosted-openai',
          google: 'hosted-google',
          cloudflare: 'hosted-cloudflare',
          'self-host': 'hosted-self-host',
        }),
      },
    }),
  };
}

beforeAll(async () => {
  fixture = await createSearchFixture('u5read');
  sql = fixture.sql;
  await seedPage(sql, {
    id: 'p-advisory',
    title: 'Widget calibration advisory',
    sourceType: 'document',
    origin: 'personal:files',
    createdAt: '2026-05-02',
    paragraphs: [
      'Widget calibration advisory. The calibration jig is out by two millimetres.',
      'Re-run the calibration before the next batch ships.',
    ],
    ladder: [0.1, 0.2],
  });
}, { timeout: SETUP_TIMEOUT_MS });

afterAll(async () => {
  await fixture?.close();
}, { timeout: SETUP_TIMEOUT_MS });

describe('Assumption 5 — a provider failure is a partial answer, not an outage', () => {
  test(
    'the embedding provider refusing still returns fused results, flagged',
    async () => {
      const { gateway, transport } = gatewayThat({ refuse: true });

      const response = await recall({
        sql,
        gateway,
        tenantId: TENANT,
        caller: CALLER,
        query: 'widget calibration advisory',
        grant: GRANT,
        limit: 5,
        now: new Date('2026-06-01T00:00:00Z'),
      });

      // Not an error. That is the entire contract.
      expect(response.degraded).toEqual(['embedding_unavailable']);
      expect(response.results.length).toBeGreaterThan(0);
      // The surviving arm answered; the failed one is absent rather than empty.
      expect(response.armsUsed).toContain('fts');
      expect(response.armsUsed).not.toContain('vector');
      // The gateway really was asked — a read that never called the provider
      // would satisfy every assertion above while proving nothing.
      expect(transport.texts).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a working provider runs the vector arm and reports no degradation',
    async () => {
      const { gateway, transport } = gatewayThat({ refuse: false });

      const response = await recall({
        sql,
        gateway,
        tenantId: TENANT,
        caller: CALLER,
        query: 'widget calibration advisory',
        grant: GRANT,
        limit: 5,
        now: new Date('2026-06-01T00:00:00Z'),
      });

      expect(response.degraded).toEqual([]);
      expect(response.armsUsed).toContain('vector');
      // KTD8's asymmetry: the query is encoded as a query, not as a document.
      expect(transport.texts[0]).toBe(queryEncoding('widget calibration advisory'));
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the fence still holds on the degraded path',
    async () => {
      const { gateway } = gatewayThat({ refuse: true });
      const response = await recall({
        sql,
        gateway,
        tenantId: TENANT,
        caller: CALLER,
        query: 'widget calibration advisory',
        grant: ['work:files'],
        limit: 5,
        now: new Date('2026-06-01T00:00:00Z'),
      });
      expect(response.degraded).toEqual(['embedding_unavailable']);
      expect(response.results).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
