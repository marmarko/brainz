/**
 * The harness the U11 consolidation suite runs against. Not a `*.test.ts` file.
 *
 * Three things live here, and each one exists because the obvious stand-in
 * would make the suite green for the wrong reason.
 *
 * **A real tenant database at the head of the ladder.** The cycle writes derived
 * rows into tables whose origin-union triggers, confidence CHECKs and
 * `derivation` constraints are the actual enforcement. A consolidation test
 * against a hand-rolled subset of the schema proves nothing about the cycle the
 * fleet runs — most of what U11 promises (R15 inheritance, report-only
 * contradictions, the anti-loop marker) is enforced by the database or by
 * nothing.
 *
 * **A scripted model transport, never a live provider.** Every model phase goes
 * through `src/ai/gateway.ts`, so a fake at the *transport* seam exercises
 * routing, metering, budgets and the per-phase cap exactly as production does,
 * while making zero paid calls. The script is keyed by op, because that is what
 * the gateway hands the transport, and a script keyed by anything else would
 * pass while KTD13's routing was broken.
 *
 * **The eval corpus seeded into its PRE-consolidation state.** The free-tier
 * measurement needs a brain that consolidation can measurably improve, and the
 * honest one is not a brain with duplicates planted in it. It is the corpus as
 * the write path leaves it *with the two steps consolidation owns removed*:
 * facts inserted per occurrence with no dedup verdict consulted, and edges
 * projected from every fact with no reconciliation pass. That is the documented
 * residue — `src/core/write/dedup.ts` says in as many words that a near
 * duplicate admitted under concurrency is one "which consolidation collapses" —
 * reproduced deterministically instead of raced for.
 */

import { SQL } from 'bun';

import {
  createBudget,
  createInMemorySpendMeter,
  createModelGateway,
  type Budget,
  type InMemorySpendMeter,
  type ModelGateway,
  type ModelTransport,
  type TransportRequest,
  type TransportResponse,
} from '../../src/ai/gateway.ts';
import {
  createHostedKeyPool,
  createInMemoryProviderKeyBackend,
  createTenantProviderKeyStore,
} from '../../src/ai/keys.ts';
import { HOSTED_PROFILE, type ModelOp } from '../../src/ai/routing.ts';
import { fleetIdentity } from '../../src/control/secrets.ts';
import { extractFacts } from '../../src/core/write/extract.ts';
import { textArrayLiteral } from '../../src/core/write/pg-values.ts';
import { CORPUS } from '../../evals/corpus.ts';
import { seedCorpusPagesAndChunks } from '../../evals/seed-tenant.ts';
import { lexicalVector } from '../core/write/fixture.ts';
import {
  connect,
  dropFixtureDatabase,
  provisionFixture,
  type SchemaFixture,
} from '../schema/fixture.ts';

export { CORPUS };

export const TENANT = 'dreamer';
export const CALLER = fleetIdentity(TENANT);

export function uncappedBudget(label: string): Budget {
  return createBudget({ label, capMicroUsd: null });
}

// ---------------------------------------------------------------------------
// The scripted transport.
// ---------------------------------------------------------------------------

export interface ScriptedTransport extends ModelTransport {
  readonly calls: readonly TransportRequest[];
  /** Every prompt this transport was handed, in order. Assertable verbatim. */
  readonly prompts: readonly string[];
  callsFor(op: ModelOp): readonly TransportRequest[];
}

export type ChatScript = (request: TransportRequest) => string;

export interface ScriptOptions {
  /** Per-op chat replies. An op with no entry answers `{}`. */
  readonly chat?: Partial<Record<ModelOp, ChatScript>>;
  /** Throw for this op instead of answering. */
  readonly failOn?: ModelOp;
  readonly failWith?: Error;
  /** Tokens each chat reply claims to have written. Drives the metered cost. */
  readonly outputTokens?: number;
}

/**
 * A transport that answers from a script and records everything.
 *
 * It reports usage on every call, because a transport that reported none would
 * make the gateway answer `usage_unreported` — a correct refusal that would
 * silently turn every phase test into a test of the refusal path.
 */
export function createScriptedTransport(options: ScriptOptions = {}): ScriptedTransport {
  const calls: TransportRequest[] = [];
  const prompts: string[] = [];
  const outputTokens = options.outputTokens ?? 16;

  return {
    id: 'consolidate-fake',
    get calls() {
      return calls;
    },
    get prompts() {
      return prompts;
    },
    callsFor(op) {
      return calls.filter((call) => call.op === op);
    },
    invoke(request: TransportRequest): Promise<TransportResponse> {
      calls.push(request);
      if (request.input.kind === 'chat') {
        prompts.push(`${request.input.system ?? ''}\n${request.input.user}`);
      }

      if (options.failOn === request.op) {
        return Promise.reject(options.failWith ?? new Error('scripted failure'));
      }

      if (request.input.kind === 'embedding') {
        const texts = request.input.texts;
        return Promise.resolve({
          output: { kind: 'embedding', vectors: texts.map((text) => lexicalVector(text)) },
          usage: { inputTokens: texts.reduce((sum, text) => sum + text.length, 0), outputTokens: 0 },
        });
      }
      if (request.input.kind === 'rerank') {
        return Promise.resolve({
          output: { kind: 'rerank', scores: request.input.candidates.map(() => 0) },
          usage: { inputTokens: 1, outputTokens: 0 },
        });
      }

      const script = options.chat?.[request.op];
      const text = script === undefined ? '{}' : script(request);
      return Promise.resolve({
        output: { kind: 'chat', text },
        usage: { inputTokens: Math.ceil(request.input.user.length / 4), outputTokens },
      });
    },
  };
}

export interface GatewayHarness {
  readonly gateway: ModelGateway;
  readonly transport: ScriptedTransport;
  readonly meter: InMemorySpendMeter;
}

export function createGateway(options: ScriptOptions = {}): GatewayHarness {
  const transport = createScriptedTransport(options);
  const meter = createInMemorySpendMeter();
  const gateway = createModelGateway({
    profile: HOSTED_PROFILE,
    transport,
    meter,
    keys: {
      store: createTenantProviderKeyStore({ backend: createInMemoryProviderKeyBackend() }),
      hosted: createHostedKeyPool({
        openai: 'hosted-openai',
        google: 'hosted-google',
        cloudflare: 'hosted-cloudflare',
        'self-host': 'hosted-self-host',
      }),
    },
  });
  return { gateway, transport, meter };
}

// ---------------------------------------------------------------------------
// The tenant.
// ---------------------------------------------------------------------------

export interface TenantFixture {
  readonly schema: SchemaFixture;
  readonly sql: SQL;
  close(): Promise<void>;
}

export async function createTenantFixture(slug: string): Promise<TenantFixture> {
  const schema = await provisionFixture(slug);
  const sql = connect(schema);
  return {
    schema,
    sql,
    async close() {
      await sql.close();
      await dropFixtureDatabase(schema);
    },
  };
}

export async function countRows(sql: SQL, table: string, where = 'true'): Promise<number> {
  const rows = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

function vectorLiteralOf(text: string): string {
  return `[${lexicalVector(text).join(',')}]`;
}

// ---------------------------------------------------------------------------
// Writing a page by hand, for the guards that need one exact shape.
// ---------------------------------------------------------------------------

export interface SeedPageInput {
  readonly origin: string;
  readonly sourceType: string;
  readonly title: string;
  readonly body: string;
  readonly externalRef?: string;
  readonly createdAt?: string;
  readonly derivation?: string;
}

export interface SeededPage {
  readonly pageId: string;
  readonly chunkIds: readonly string[];
}

/**
 * One page, its single chunk, and the deterministic facts that chunk states.
 *
 * Deliberately not `ingestDocument`: several guards need a page in a shape the
 * write path refuses to produce (a second copy of a statement it would have
 * called a duplicate, a model-derived page), and the point of those guards is
 * what consolidation does with such a row.
 */
export async function seedPage(sql: SQL, input: SeedPageInput): Promise<SeededPage> {
  const digest = new Bun.CryptoHasher('sha256').update(input.body).digest('hex');
  const pageRows = (await sql`
    INSERT INTO page (origin_context, source_type, title, external_ref, derivation,
                      embedding_model, embedding_dimensions, chunker_version,
                      normalizer_version, content_sha256, created_at)
    VALUES (${input.origin}, ${input.sourceType}, ${input.title}, ${input.externalRef ?? null},
            ${input.derivation ?? 'ingested'},
            'synthetic-lexical-v1', 1536, 1, 1, ${digest},
            ${input.createdAt ?? new Date().toISOString()})
    RETURNING page_id::text AS page_id
  `) as Array<{ page_id: string }>;
  const pageId = pageRows[0]?.page_id;
  if (pageId === undefined) throw new Error('page did not insert');

  const chunkRows = (await sql`
    INSERT INTO chunk (origin_context, content, embedding, page_id, ordinal)
    VALUES (${input.origin}, ${input.body}, ${vectorLiteralOf(input.body)}::vector, ${pageId}::bigint, 0)
    RETURNING chunk_id::text AS chunk_id
  `) as Array<{ chunk_id: string }>;
  const chunkId = chunkRows[0]?.chunk_id;
  if (chunkId === undefined) throw new Error('chunk did not insert');

  return { pageId, chunkIds: [chunkId] };
}

/** Inserts one fact with its source chunk and origin union. No dedup verdict. */
export async function seedFact(
  sql: SQL,
  input: {
    readonly statement: string;
    readonly origins: readonly string[];
    readonly pageId?: string | null;
    readonly chunkIds?: readonly string[];
    readonly derivation?: string;
    readonly trustLevel?: string | null;
    readonly confidence?: number | null;
  },
): Promise<string> {
  const rows = (await sql`
    INSERT INTO fact (statement, embedding, origin_contexts, page_id, derivation, trust_level, confidence)
    VALUES (${input.statement}, ${vectorLiteralOf(input.statement)}::vector,
            ${textArrayLiteral([...input.origins].sort())}::text[],
            ${input.pageId ?? null}, ${input.derivation ?? 'ingested'},
            ${input.trustLevel ?? null}, ${input.confidence ?? null})
    RETURNING fact_id::text AS fact_id
  `) as Array<{ fact_id: string }>;
  const factId = rows[0]?.fact_id;
  if (factId === undefined) throw new Error('fact did not insert');

  for (const chunkId of input.chunkIds ?? []) {
    await sql`INSERT INTO fact_source (fact_id, chunk_id) VALUES (${factId}::bigint, ${chunkId}::bigint)`;
  }
  return factId;
}

// ---------------------------------------------------------------------------
// The eval corpus, in its pre-consolidation state.
// ---------------------------------------------------------------------------

export interface PreConsolidationSeed {
  readonly pages: number;
  readonly chunks: number;
  readonly facts: number;
}

/**
 * The eval corpus with the two consolidation-owned write-path steps removed.
 *
 * **What is removed, and why each removal is faithful rather than convenient.**
 *
 *  - **The dedup verdict.** Every live chunk's deterministic facts go in
 *    **twice**. That is not "plant some duplicates": it is the racing writer
 *    `src/core/write/dedup.ts` documents in its own header — `classifyStatement`
 *    reads a snapshot taken before the insert that follows it, so a second writer
 *    whose snapshot predates the first's commit inserts the same claim again.
 *    The header's own words for what happens next are "which consolidation
 *    collapses". Both copies carry the same origin, because a cross-credential
 *    duplicate is two attestations R12a needs and is not a defect at all.
 *  - **Edge reconciliation.** No edges are projected. `reconcile_edges` is a
 *    write-path phase whose consolidation-wide counterpart is the phase under
 *    measurement, so a pre-state that already had the right edges would be a
 *    pre-state with the phase's output in it.
 *
 * Nothing is invented: every fact is one the shipped extractor finds in a
 * committed corpus chunk, and every missing edge is one the shipped projection
 * says those facts imply.
 */
export async function seedPreConsolidationCorpus(sql: SQL): Promise<PreConsolidationSeed> {
  const seeded = await seedCorpusPagesAndChunks(sql, CORPUS);

  let facts = 0;
  for (const [pageKey, chunkRows] of seeded.chunksByPage) {
    const page = CORPUS.pages.get(pageKey);
    if (page === undefined) throw new Error(`seeded a chunk for unknown page ${pageKey}`);
    if (page.deletedAt !== undefined || page.quarantinedAt !== undefined) continue;

    const pageId = seeded.pageIds.get(pageKey);
    if (pageId === undefined) throw new Error(`page ${pageKey} has no row`);

    for (const chunk of chunkRows) {
      const extracted = extractFacts([
        {
          ordinal: chunk.ordinal,
          content: chunk.content,
          contentStart: 0,
          sourceStart: 0,
          sourceEnd: chunk.content.length,
        },
      ]);
      // Twice: the first writer, and the one whose dedup snapshot predates it.
      for (const pass of [0, 1]) {
        void pass;
        for (const fact of extracted) {
          await seedFact(sql, {
            statement: fact.statement,
            origins: [page.origin],
            pageId,
            chunkIds: [chunk.chunkId],
            confidence: fact.confidence,
          });
          facts += 1;
        }
      }
    }
  }

  return { pages: seeded.pageIds.size, chunks: seeded.chunkCount, facts };
}
