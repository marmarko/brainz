/**
 * The one place the write path asks for a vector, and the one place a vector
 * becomes SQL.
 *
 * **Every call goes through U20's gateway as the `embedding` op.** Routing,
 * metering, key resolution and the unpriced-model hard-fail all live there; no
 * provider SDK is imported here and no model is named at a call site. What this
 * module owns is the three decisions the gateway cannot make for it:
 *
 * **1. KTD8's width is a refusal, not a repair.** `text-embedding-3-large` is
 * natively 3072-dimensional; the column is 1536 because that is inside
 * pgvector's HNSW ceiling. Truncation happens through the API's `dimensions`
 * parameter — which **re-normalizes** — and never through client-side slicing,
 * which returns a vector that is no longer unit length and silently changes
 * distance semantics under inner-product operators. A vector that arrives at
 * the wrong width is therefore an error all the way out; there is no branch
 * here that makes one fit. The failure it prevents is invisible to any eval
 * built on committed embeddings, so it is encoded where it cannot be got wrong:
 * {@link vectorLiteral} is the only path from a vector to a statement, and it
 * throws.
 *
 * **2. The contextual wrap is applied to what is encoded, never to what is
 * stored.** The title tier is free — it is text the page already carries — and
 * it is the highest-leverage write-side quality item in the audit (ledger row
 * `stack.contextual-retrieval`), because it disambiguates short fragments,
 * which the empty state produces by the hundred. The synopsis tier costs a
 * model call per chunk and is deferred to consolidation. `chunk.content` keeps
 * the user's own words: a stored wrap would come back in every citation.
 *
 * **3. Chunk embedding is the deferred half of the write, and its backlog is a
 * query rather than a promise.** {@link pendingChunkEmbeddings} is `embedding
 * IS NULL` over live, unquarantined chunks — so a process that dies between the
 * synchronous commit and the backfill loses no work, and "it will be indexed
 * shortly" is a statement someone can check. Quarantined and soft-deleted rows
 * are excluded, which is the junk gate's structural half (R16): a row the gate
 * marked never reaches the provider and never costs a call. The gate's
 * classifier is U9's.
 */

import type { SQL } from 'bun';

import type { Budget, ModelGateway } from '../../ai/gateway.ts';
import { PROFILES, routeFor, type ModelOp, type RoutingProfileName } from '../../ai/routing.ts';
import type { CallerIdentity } from '../../control/secrets.ts';
import { EMBEDDING_DIMENSIONS } from '../../schema/vector-index.ts';

/** KTD13's op name. A caller asks for this, never for a model. */
export const EMBED_OP: ModelOp = 'embedding';

/**
 * Which contextual tier the write path applies. The synopsis tier is
 * consolidation's (U11); naming the tier here is what makes the difference
 * between them auditable from the page's provenance signature.
 */
export const CONTEXTUAL_WRAP_TIER = 'title';

/** How many chunks are encoded per provider call on the backfill. */
export const CHUNK_EMBED_BATCH = 32;

export class EmbeddingWidthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingWidthError';
  }
}

/**
 * The document-side encoding: the title tier, applied at embed time.
 *
 * **Stable by contract.** Changing this re-encodes every chunk in every brain,
 * and `evals/regenerate-embeddings.ts` must apply the same wrap the day real
 * provider vectors replace the synthetic fixture ones — a corpus encoded bare
 * and queried wrapped is a silent recall loss with no error to point at. The
 * format is pinned by a literal assertion in `test/core/write/embed.test.ts`.
 */
export function documentEncoding(input: {
  readonly title: string | null | undefined;
  readonly content: string;
}): string {
  const title = input.title?.trim() ?? '';
  return title.length === 0 ? input.content : `${title}\n\n${input.content}`;
}

/**
 * The query-side encoding (KTD8's asymmetry). U5 issues the query embedding
 * through the same gateway op; the prefix is what makes the two encodings of
 * identical text different vectors in one shared space.
 */
export function queryEncoding(query: string): string {
  return `query: ${query.trim()}`;
}

/**
 * A vector as a pgvector literal, or a throw.
 *
 * Bound as text and cast by the caller (`$n::vector`), because a 1536-element
 * float array is not something to interpolate and pgvector accepts its own
 * literal form. Both checks here are load-bearing: a wrong width is KTD8's
 * silent recall bug, and a `NaN` component makes every distance against the row
 * undefined without failing any insert.
 */
export function vectorLiteral(vector: readonly number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new EmbeddingWidthError(
      `refusing a ${vector.length}-dimension vector: the column is ${EMBEDDING_DIMENSIONS} and truncation belongs to the provider's dimensions parameter, not to this process`,
    );
  }
  for (const component of vector) {
    if (!Number.isFinite(component)) {
      throw new EmbeddingWidthError('refusing a vector with a non-finite component');
    }
  }
  return `[${vector.join(',')}]`;
}

/**
 * The model id the `embedding` op resolves to under a named profile — read from
 * the routing table rather than written down again, so `page.embedding_model`
 * cannot drift from what actually encoded the page. An unknown profile throws:
 * a default here would stamp every page with a model that never ran.
 */
export function embeddingModelFor(profileName: string): string {
  const profile = PROFILES[profileName as RoutingProfileName];
  if (profile === undefined) {
    throw new Error(`no routing profile named '${profileName}'`);
  }
  return routeFor(profile, EMBED_OP).id;
}

export interface EmbedRequest {
  readonly gateway: ModelGateway;
  readonly tenantId: string;
  readonly caller: CallerIdentity;
  readonly budget: Budget;
  readonly texts: readonly string[];
}

export type EmbedOutcome =
  | { readonly ok: true; readonly vectors: ReadonlyArray<readonly number[]>; readonly modelId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * One gateway call per batch, with the outcome passed back as data.
 *
 * A failure is typed rather than thrown because both callers have to branch on
 * it: the synchronous half aborts the whole write (a fact with no vector is a
 * row the database refuses, correctly), and the backfill leaves the chunk in
 * the backlog for the next pass.
 */
export async function embedTexts(request: EmbedRequest): Promise<EmbedOutcome> {
  if (request.texts.length === 0) {
    return { ok: true, vectors: [], modelId: embeddingModelFor(request.gateway.profileName) };
  }

  const result = await request.gateway.call({
    op: EMBED_OP,
    tenantId: request.tenantId,
    caller: request.caller,
    budget: request.budget,
    input: { kind: 'embedding', texts: request.texts },
  });

  if (!result.ok) return { ok: false, reason: result.reason };
  if (result.output.kind !== 'embedding') return { ok: false, reason: 'op_kind_mismatch' };
  if (result.output.vectors.length !== request.texts.length) {
    return { ok: false, reason: 'embedding_count_mismatch' };
  }

  return { ok: true, vectors: result.output.vectors, modelId: result.metering.modelId };
}

// ---------------------------------------------------------------------------
// The deferred half.
// ---------------------------------------------------------------------------

export interface PendingChunk {
  readonly chunkId: string;
  readonly content: string;
  readonly title: string | null;
}

/**
 * The backlog, as a query.
 *
 * Everything about the async half of the split rests on this predicate being
 * the *only* thing that marks a chunk as unembedded. No status column, no queue
 * that can diverge from the rows: a chunk either has a vector or is in the
 * backlog, so a crash anywhere between the commit and the backfill is a resumed
 * loop rather than a lost write.
 */
export async function pendingChunkEmbeddings(sql: SQL, limit: number): Promise<PendingChunk[]> {
  const rows = (await sql`
    SELECT c.chunk_id::text AS chunk_id, c.content, p.title
      FROM chunk c
      LEFT JOIN page p ON p.page_id = c.page_id
     WHERE c.embedding IS NULL
       AND c.deleted_at IS NULL
       AND c.quarantined_at IS NULL
     ORDER BY c.chunk_id
     LIMIT ${Math.max(1, Math.trunc(limit))}
  `) as Array<{ chunk_id: string; content: string; title: string | null }>;

  return rows.map((row) => ({ chunkId: row.chunk_id, content: row.content, title: row.title }));
}

export interface BacklogResult {
  readonly embedded: number;
  readonly remaining: number;
  /** Set when the pass stopped early; the rows stay in the backlog. */
  readonly failure?: string;
}

/**
 * Drains the backlog in batches.
 *
 * Each batch is written before the next is requested, so a failure halfway
 * through a long backfill keeps what it paid for. The write is guarded on
 * `embedding IS NULL` so a concurrent pass cannot overwrite a vector another
 * one just wrote.
 */
export async function runChunkEmbedBacklog(options: {
  readonly sql: SQL;
  readonly gateway: ModelGateway;
  readonly tenantId: string;
  readonly caller: CallerIdentity;
  readonly budget: Budget;
  readonly batchSize?: number;
  /** Stop after this many chunks. Unbounded when absent. */
  readonly limit?: number;
}): Promise<BacklogResult> {
  const batchSize = Math.max(1, Math.trunc(options.batchSize ?? CHUNK_EMBED_BATCH));
  const ceiling = options.limit === undefined ? Number.POSITIVE_INFINITY : options.limit;
  let embedded = 0;

  for (;;) {
    if (embedded >= ceiling) break;
    const take = Math.min(batchSize, ceiling - embedded);
    const pending = await pendingChunkEmbeddings(options.sql, take);
    if (pending.length === 0) break;

    const outcome = await embedTexts({
      gateway: options.gateway,
      tenantId: options.tenantId,
      caller: options.caller,
      budget: options.budget,
      texts: pending.map((chunk) => documentEncoding({ title: chunk.title, content: chunk.content })),
    });

    if (!outcome.ok) {
      return { embedded, remaining: await backlogSize(options.sql), failure: outcome.reason };
    }

    for (const [index, chunk] of pending.entries()) {
      const vector = outcome.vectors[index];
      if (vector === undefined) continue;
      await options.sql`
        UPDATE chunk
           SET embedding = ${vectorLiteral(vector)}::vector
         WHERE chunk_id = ${chunk.chunkId}::bigint
           AND embedding IS NULL
      `;
      embedded += 1;
    }
  }

  return { embedded, remaining: await backlogSize(options.sql) };
}

export async function backlogSize(sql: SQL): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS pending
      FROM chunk
     WHERE embedding IS NULL AND deleted_at IS NULL AND quarantined_at IS NULL
  `) as Array<{ pending: number }>;
  return rows[0]?.pending ?? 0;
}
