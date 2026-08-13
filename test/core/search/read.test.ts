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
import { recall, recallArms } from '../../../src/core/search/read.ts';
import {
  EMBEDDING_DIMENSIONS,
  createSearchFixture,
  seedEntity,
  seedFact,
  seedPage,
  type SearchFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const GRANT = ['personal:files', 'personal:mail'];
const TENANT = 'u5read';
const CALLER: CallerIdentity = fleetIdentity(TENANT);

let fixture: SearchFixture;
let sql: SQL;

interface TransportOptions {
  /** Refuse the embedding call — Assumption 5's availability half. */
  readonly refuse: boolean;
  /**
   * Refuse the *rerank* call, independently.
   *
   * From U12 this path has two external dependencies (KTD4) and they fail on
   * their own schedules: a reranker that rate-limits costs the ordering while
   * the vector arm keeps answering. One flag cannot express that.
   */
  readonly refuseRerank?: boolean;
}

/** A transport that answers, or refuses, and records what it was asked to encode. */
function transportThat(options: TransportOptions): ModelTransport & {
  readonly texts: string[];
  readonly rerankCalls: number;
} {
  const texts: string[] = [];
  let rerankCalls = 0;
  return {
    id: 'u5-read-fake',
    get texts() {
      return texts;
    },
    get rerankCalls() {
      return rerankCalls;
    },
    invoke(request: TransportRequest): Promise<TransportResponse> {
      if (request.input.kind === 'rerank') {
        rerankCalls += 1;
        if (options.refuseRerank === true) {
          return Promise.reject(new Error('the reranker is having a day'));
        }
        const count = request.input.candidates.length;
        // Descending and smooth: this file is about availability, not ranking,
        // and a cliff here would make autocut's truncation the thing under test.
        return Promise.resolve({
          output: { kind: 'rerank', scores: request.input.candidates.map((_text, index) => 1 - index * 0.01 / Math.max(count, 1)) },
          usage: { inputTokens: 8, outputTokens: 0 },
        });
      }
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

function gatewayThat(options: TransportOptions): {
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
    'the reranker refusing costs the ordering, not the read (U12, KTD4)',
    async () => {
      const { gateway, transport } = gatewayThat({ refuse: false, refuseRerank: true });

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

      // The read succeeds, the vector arm is unaffected, and the two coupled
      // stages sit out together — autocut reads the rerank score and only the
      // rerank score, so it cannot run either.
      expect(response.degraded).toEqual(['rerank_unavailable']);
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.armsUsed).toContain('vector');
      expect(response.rerankApplied).toBe(false);
      expect(response.autocutApplied).toBe(false);
      for (const result of response.results) expect(result.rerankScore).toBeUndefined();
      // It really was attempted; a path that skipped the call would pass every
      // assertion above having proved nothing.
      expect(transport.rerankCalls).toBe(1);
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
      // U12: the second external call ran, and both stages are on.
      expect(response.rerankApplied).toBe(true);
      expect(transport.rerankCalls).toBe(1);
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

/**
 * **A boost whose input nothing populates is a stage that does not exist.**
 *
 * `Candidate.entityIds` is documented at length in `types.ts` and read by two
 * terms in `boosts.ts` — the graph-adjacency boost, and the title-phrase boost's
 * residual-run rule. Every production call site of `arms.ts:toCandidate` took
 * the parameter's `[]` default, so on the fleet both terms were inert while U7's
 * eval adapter populated the field and graded them. Same failure class as the
 * graph arm's missing relation key, one stage further down: the blocking tier
 * measured a boost the fleet never applied.
 *
 * The wiring reuses the ladder lookup that has already been materialised — the
 * mention rung's pages and the evidence rung's chunks are exactly the two halves
 * `types.ts` describes — so it costs no extra query, and the two derivations of
 * "does this row name the entity" stay one derivation.
 */
describe('the resolved entities reach the candidates the boosts score', () => {
  test(
    'a hydrated candidate carries the entities its page names, split by evidence grade',
    async () => {
      const barnacle = await seedEntity(sql, {
        slug: 'adjacency-person',
        name: 'Ptolemy Quillfeather',
        type: 'person',
        origins: ['personal:files'],
      });
      const [named, unnamed] = await seedPage(sql, {
        id: 'p-adjacency',
        title: 'Studio notes',
        sourceType: 'note',
        origin: 'personal:files',
        createdAt: '2026-05-09',
        paragraphs: [
          'Ptolemy Quillfeather keeps the kiln at eleven hundred degrees.',
          'The second paragraph names nobody at all and carries the number.',
        ],
      });
      await seedFact(sql, {
        statement: 'Ptolemy Quillfeather keeps the kiln at eleven hundred degrees.',
        origins: ['personal:files'],
        chunkIds: [named!],
        createdAt: '2026-05-09',
      });

      const { gateway } = gatewayThat({ refuse: true });
      const outcome = await recallArms({
        sql,
        gateway,
        tenantId: TENANT,
        caller: CALLER,
        query: 'Ptolemy Quillfeather kiln',
        grant: GRANT,
        limit: 10,
        now: new Date('2026-06-01T00:00:00Z'),
      });

      expect(outcome.resolvedEntityIds).toContain(barnacle);

      const carrier = outcome.candidates.get(named!);
      const sibling = outcome.candidates.get(unnamed!);

      // Adjacency is chunk-granular: a paragraph that names nobody is evidence
      // about nobody, and widening it to the page hands every paragraph of a
      // profile the same lift as the row that answers the question.
      expect(carrier?.entityIds).toContain(barnacle);
      expect(sibling?.entityIds ?? []).not.toContain(barnacle);

      // The page-level set is the separate one, for the title rule — a title is
      // the page's, so the question "is this document about the subject" has to
      // be asked of the document.
      expect(carrier?.pageEntityIds).toContain(barnacle);
      expect(sibling?.pageEntityIds).toContain(barnacle);

      // Evidence is the strongest grade and narrower still: only the chunk the
      // fact was extracted from carries it.
      expect(carrier?.evidenceEntityIds).toContain(barnacle);
      expect(sibling?.evidenceEntityIds ?? []).not.toContain(barnacle);
    },
    TEST_TIMEOUT_MS,
  );
});
