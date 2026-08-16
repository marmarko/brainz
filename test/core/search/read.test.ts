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
  createBudget,
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
import { embedQuery, recall, recallArms } from '../../../src/core/search/read.ts';
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
      const encoded = (request.input as { texts: readonly string[] }).texts;
      // **Usage proportional to the input, the way a provider reports it.** A
      // flat count here is a fake that charges the same for a word and for a
      // novel, which makes every budget assertion in this file vacuous: a
      // reservation is *released* and replaced by the settled cost, so a
      // constant-cost transport can never fill a budget however much it is
      // asked to encode. The gateway's own estimator uses four characters to
      // the token; matching it keeps the settled cost near the reserved one.
      const inputTokens = encoded.reduce((total, text) => total + Math.ceil(text.length / 4), 0);
      return Promise.resolve({
        output: { kind: 'embedding', vectors: encoded.map(() => vector) },
        usage: { inputTokens, outputTokens: 0 },
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
    'A READ THAT WOULD COST TOO MUCH NEVER REACHES THE PROVIDER',
    async () => {
      // **The request path had no ceiling at all.** `RecallRequest.budget` is
      // optional and nothing in `src/` ever supplied one, so every read ran on a
      // module-level `capMicroUsd: null` budget — justified in a comment that
      // said the caps that mattered were "the tenant-level ones the gateway's
      // meter enforces". No such layer exists: the meter accumulates
      // `spend_micro_usd` and has no way to refuse anything.
      //
      // A caller-sized query is the shape of the hole, because the estimate is
      // computed from the caller's own bytes. This one prices past the default
      // ceiling, and the assertion that matters is on the **transport**: the cap
      // has to fire before the provider is reached, or it is a record of the
      // money rather than a limit on it.
      //
      // Asserted through `embedQuery` rather than `recall` because a query this
      // size never survives the FTS arm — `websearch_to_tsquery` exhausts
      // Postgres's parser stack somewhere above 100kB, which is a separate
      // unbounded-input hazard on this path and not the one under test here.
      const { gateway, transport } = gatewayThat({ refuse: false });

      // Comfortably past `READ_PATH_SPEND_CEILING` (4,000): 150k chars is ~37.5k
      // tokens, which the embedder prices near 4,900.
      const enormous = 'widget '.repeat(21_500);
      expect(enormous.length).toBeGreaterThan(150_000);

      const embedded = await embedQuery({
        gateway,
        tenantId: TENANT,
        caller: CALLER,
        // No `budget`. That is the point: this is what the *default* does.
        query: enormous,
      });

      // Never asked. Not "asked and refused" — the difference is the whole cap.
      expect(transport.texts).toEqual([]);
      expect(embedded.vector).toBeNull();
      expect(embedded.degraded).toEqual(['embedding_unavailable']);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'THE CEILING IS PER REQUEST, NOT PER PROCESS',
    async () => {
      // **The way a finite cap goes wrong is worse than having none.** The
      // budget this replaced was a module-level constant, and writing a cap into
      // it in place would have made it a *process-lifetime* budget: it
      // accumulates across every request the instance ever serves, and once
      // full, every read from that instance degrades forever with nothing in the
      // response saying why. A restart would fix it; nothing else would.
      //
      // Two reads, each priced at about three quarters of the ceiling. Under a
      // per-request budget both reach the provider. Under one shared object the
      // second is refused, and the difference is exactly the bug.
      const { gateway, transport } = gatewayThat({ refuse: false });

      // ~70k chars is ~17.5k tokens, ~2,275 against a ceiling of 4,000: one fits,
      // two do not. Driven through `embedQuery` rather than `recall`
      // for the reason the test above gives — a query this size does not survive
      // the FTS arm.
      const costly = 'widget '.repeat(10_000);

      const first = await embedQuery({ gateway, tenantId: TENANT, caller: CALLER, query: costly });
      expect(first.vector).not.toBeNull();
      expect(transport.texts).toHaveLength(1);

      const second = await embedQuery({ gateway, tenantId: TENANT, caller: CALLER, query: costly });
      expect(second.vector).not.toBeNull();
      expect(transport.texts).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'AND A CAP THAT FIRES DEGRADES THE READ RATHER THAN FAILING IT',
    async () => {
      // The half that makes a finite ceiling shippable on this path at all. A
      // budget refusal has to reach the user as the same event a provider
      // refusal does — a partial answer, flagged — because a cap that turns an
      // expensive read into a 500 is a search outage with a spend rationale.
      // A cap of one micro-dollar is the cheapest way to observe the exhausted
      // branch. Only the embedding call is reached: this corpus packs fewer
      // candidates than `RERANK_CANDIDATES_FLOOR`, so the cross-encoder stage
      // resolves off before it can be refused — which the test above ("the
      // reranker refusing costs the ordering, not the read") already covers on
      // the other side of the same conversion.
      const { gateway } = gatewayThat({ refuse: false });

      const response = await recall({
        sql,
        gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: createBudget({ label: 'spent', capMicroUsd: 1 }),
        query: 'widget calibration advisory',
        grant: GRANT,
        limit: 5,
        now: new Date('2026-06-01T00:00:00Z'),
      });

      expect(response.degraded).toContain('embedding_unavailable');
      // Still an answer. The FTS arm never needed the provider.
      expect(response.results.length).toBeGreaterThan(0);
      expect(response.armsUsed).toContain('fts');
      expect(response.armsUsed).not.toContain('vector');
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
