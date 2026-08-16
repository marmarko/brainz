/**
 * Shared harness for the U4 write-path suite. Not a `*.test.ts` file.
 *
 * Two things live here, and both exist because a weaker stand-in would make the
 * suite green for the wrong reason.
 *
 * **A real tenant database, through the real applier.** `provisionFixture` runs
 * the same migration ladder provisioning runs, so the origin-immutability
 * trigger, the four origin-union constraint triggers, the `NOT NULL` on
 * `fact.embedding` and the slug CHECK are all present and all enforcing. A
 * write-path test against a hand-written subset of the schema proves nothing
 * about the write path the fleet runs.
 *
 * **An embedding transport whose vectors mean something.** The gateway suite's
 * fake answers with all-zero vectors, which is right for metering and wrong
 * here: cosine distance against a zero vector is undefined, so a dedup test
 * built on it would measure pgvector's NaN handling rather than similarity.
 * This one is a deterministic lexical projection — the same trick
 * `evals/embeddings.ts` uses — so texts that share words are near each other,
 * texts that do not are far apart, and every run is identical. It is not a
 * semantic encoder and nothing here pretends otherwise; what it has to be is
 * *ordered the way a real one is*, and for the write path's near-duplicate
 * question lexical overlap is the right signal to test against.
 */

import { createHash } from 'node:crypto';
import { SQL } from 'bun';

import {
  createBudget,
  createInMemorySpendMeter,
  createModelGateway,
  TransportError,
  type Budget,
  type InMemorySpendMeter,
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
import { fleetIdentity } from '../../../src/control/secrets.ts';
import { ACTIVE_EMBEDDING_SEAT } from '../../../src/schema/embedding-seat.ts';
import { EMBEDDING_DIMENSIONS } from '../../../src/schema/vector-index.ts';
import {
  connect,
  dropFixtureDatabase,
  provisionFixture,
  type SchemaFixture,
} from '../../schema/fixture.ts';

export { EMBEDDING_DIMENSIONS };

/**
 * The column the write path actually fills — the active seat's, so a test that
 * reads a vector back is reading the one production wrote rather than the one
 * this file was written against.
 */
export const SEAT_COLUMN = ACTIVE_EMBEDDING_SEAT.column;

export const TENANT = 'writer';
export const CALLER = fleetIdentity(TENANT);

/** Stands in for a chunk of the user's mail; asserted absent from every record. */
export const CANARY = 'CANARY-9c1e-write-path-do-not-retain';

export function uncappedBudget(label = 'write'): Budget {
  return createBudget({ label, capMicroUsd: null });
}

export interface EmbeddingTransportOptions {
  /** Vector width to answer with. Defaults to the pinned dimension. */
  readonly width?: number;
  /** Throw instead of answering, from the Nth call onwards (1-based). */
  readonly failFromCall?: number;
  readonly failWith?: Error;
  /**
   * Refuse every `rerank` call, leaving the embedding half working.
   *
   * From U12 the read path has **two** external dependencies (KTD4), and they
   * fail independently: a reranker that rate-limits must degrade the ordering
   * while the vector arm keeps running. `failFromCall` cannot express that,
   * because it counts calls rather than naming a stage.
   */
  readonly failRerank?: boolean;
}

export interface RecordingTransport extends ModelTransport {
  readonly calls: readonly TransportRequest[];
  /** Every text this transport was asked to encode, in order. */
  readonly texts: readonly string[];
}

/**
 * Deterministic unit vectors from a text's tokens. Two texts sharing most of
 * their words land close together; unrelated texts land near-orthogonal.
 *
 * The vector is normalized to unit length **here, where the vector is made** —
 * which is what a provider's `dimensions` parameter does and what client-side
 * slicing famously does not (KTD8). Nothing downstream re-normalizes, and
 * `test/core/write/embed.test.ts` scans the write path to keep it that way.
 */
export function lexicalVector(text: string, width = EMBEDDING_DIMENSIONS): number[] {
  const vector = new Array<number>(width).fill(0);
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) {
    const digest = createHash('sha256').update(token).digest();
    for (let projection = 0; projection < 8; projection += 1) {
      const high = digest[projection * 2] ?? 0;
      const low = digest[projection * 2 + 1] ?? 0;
      const slot = ((high << 8) | low) % width;
      const sign = (digest[projection] ?? 0) % 2 === 0 ? 1 : -1;
      vector[slot] = (vector[slot] ?? 0) + sign;
    }
  }
  let magnitude = 0;
  for (const value of vector) magnitude += value * value;
  if (magnitude === 0) {
    // A text with no tokens at all still needs a usable vector: a zero vector
    // makes cosine distance undefined and every comparison against it NaN.
    vector[0] = 1;
    return vector;
  }
  const scale = 1 / Math.sqrt(magnitude);
  return vector.map((value) => value * scale);
}

export function createEmbeddingTransport(
  options: EmbeddingTransportOptions = {},
): RecordingTransport {
  const calls: TransportRequest[] = [];
  const texts: string[] = [];
  const width = options.width ?? EMBEDDING_DIMENSIONS;

  return {
    id: 'write-path-fake',
    get calls() {
      return calls;
    },
    get texts() {
      return texts;
    },
    invoke(request: TransportRequest): Promise<TransportResponse> {
      calls.push(request);
      if (request.input.kind === 'embedding') texts.push(...request.input.texts);

      if (options.failFromCall !== undefined && calls.length >= options.failFromCall) {
        return Promise.reject(options.failWith ?? new TransportError('provider refused', 503));
      }

      if (request.input.kind === 'rerank') {
        if (options.failRerank === true) {
          return Promise.reject(new TransportError('the reranker refused', 429));
        }
        // A deterministic joint score: how much of the query the passage
        // carries. Ordered the way a cross-encoder's output is — best first is
        // most-covered first — without pretending to be one.
        const query = new Set(
          request.input.query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [],
        );
        const scores = request.input.candidates.map((text) => {
          const tokens = new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
          if (query.size === 0) return 0;
          let hit = 0;
          for (const term of query) if (tokens.has(term)) hit += 1;
          return hit / query.size;
        });
        return Promise.resolve({
          output: { kind: 'rerank', scores },
          usage: {
            inputTokens: request.input.candidates.reduce((sum, text) => sum + text.length, 0),
            outputTokens: 0,
          },
        });
      }

      if (request.input.kind !== 'embedding') {
        return Promise.resolve({
          output: { kind: 'chat', text: 'ok' },
          usage: { inputTokens: 10, outputTokens: 2 },
        });
      }

      const inputs = request.input.texts;
      return Promise.resolve({
        output: { kind: 'embedding', vectors: inputs.map((text) => lexicalVector(text, width)) },
        usage: { inputTokens: inputs.reduce((sum, text) => sum + text.length, 0), outputTokens: 0 },
      });
    },
  };
}

export interface GatewayHarness {
  readonly gateway: ModelGateway;
  readonly transport: RecordingTransport;
  readonly meter: InMemorySpendMeter;
}

export function createGateway(options: EmbeddingTransportOptions = {}): GatewayHarness {
  const transport = createEmbeddingTransport(options);
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

export interface TenantFixture {
  readonly schema: SchemaFixture;
  readonly sql: SQL;
  close(): Promise<void>;
}

/** A tenant database at the head of the ladder, opened on one connection. */
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

/** Sets the tenant's taxonomy version, which every written row must stamp. */
export async function setTaxonomyVersion(sql: SQL, version: number): Promise<void> {
  await sql`UPDATE tenant_setting SET taxonomy_version = ${version}`;
}

export async function countRows(sql: SQL, table: string): Promise<number> {
  const rows = (await sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`)) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
