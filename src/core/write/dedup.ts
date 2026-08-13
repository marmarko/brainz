/**
 * Write-time near-duplicate detection, on the synchronous side of the split.
 *
 * The ledger row `imp.write-time-dedup` states the cost of deferring it: async
 * dedup means `recall` can return two contradictory versions of one claim,
 * budget-packed against each other, in the whole window before a consolidation
 * cycle runs. So the decision is made before the row exists.
 *
 * **Two signals, and each one covers what the other cannot.**
 *
 *  - **Normalized text** catches the re-send — the same claim with different
 *    punctuation, spacing or quote characters — and costs a comparison.
 *  - **Embedding similarity** bounds the candidate set for the harder question,
 *    which is whether this is the same *claim* stated differently. The pool is
 *    requested through the one vector-query helper, so hazards H1 and H3 are
 *    handled here exactly as they are on the read path: without the `SET LOCAL`
 *    the pool silently truncates to 40 and a duplicate outside that window is
 *    inserted as new, with nothing to point at.
 *
 * **The decision between `duplicate` and `superseded` is structural, not
 * numeric.** The frozen contract's rule is "same entity + same kind +
 * similarity above the threshold + different text", and `fact` carries neither
 * an entity column nor a kind column — so both halves are recovered by
 * re-running the deterministic extractor over the stored statement. Similarity
 * alone cannot make this call: two statements about *different people's* jobs
 * are lexically near-identical, and superseding on that number would overwrite
 * one person's employment with another's.
 *
 * **What this rule knowingly gets wrong**, stated rather than discovered later:
 * two claims that are genuinely simultaneous — one person holding two jobs, one
 * company in two cities — share a subject and a topic, so the later one
 * supersedes the earlier instead of joining it. That is the reference rule's own
 * behaviour and the price of deciding at write time with no model call; the
 * superseded row is retained and `superseded_by` records the chain, so
 * consolidation can undo it with evidence this path does not have.
 *
 * **Dedup is scoped to the incoming origin, and that is a requirement rather
 * than a refinement.** R15 makes `origin_contexts` immutable, so a fact first
 * written under one credential cannot absorb an attestation arriving under
 * another — the widening is refused by the database. Collapsing them anyway
 * would silently discard the second attestation, and R12a's corroboration
 * boost is defined on exactly that: "calendar AND mail attest this" needs two
 * rows carrying two origins to count at all. So the same claim from two
 * credentials is two facts, and the same claim twice from one credential is
 * one.
 */

import type { SQL } from 'bun';

import { candidatePoolFor, withVectorScan } from '../../schema/vector-query.ts';
import { vectorLiteral } from './embed.ts';
import { extractFromStatement } from './extract.ts';
import { normalize } from './normalize.ts';

/**
 * The write statuses of the frozen `remember` contract. `inserted` rather than
 * `stored` — a caller branches on this string, so it is the protocol's spelling
 * and not a local one.
 */
export type WriteStatus = 'inserted' | 'duplicate' | 'superseded';

/**
 * Near enough to be the same claim. High on purpose: everything below it is
 * decided structurally, and a numeric threshold that decides on its own is how
 * two people's job titles get merged.
 */
export const DUPLICATE_SIMILARITY = 0.97;

/**
 * The **candidate gate** for supersession, not the decision. It bounds how far
 * down the neighbour list the structural check looks; the check itself requires
 * the same subject, the same topic and a different value.
 */
export const SUPERSEDE_CANDIDATE_SIMILARITY = 0.5;

/** How many neighbours the structural check considers. Sized through the same
 * helper the retrieval arm uses, so the pool is a pool and not a `LIMIT`. */
export const DEDUP_RESULT_LIMIT = 10;

/**
 * What "live" means for a fact, in one place. U5's fact reads must use the same
 * three predicates: a superseded fact left in the live set is the contradictory
 * second answer this module exists to prevent.
 */
export const LIVE_FACT_PREDICATE =
  'deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL';

export interface DedupVerdict {
  readonly status: WriteStatus;
  /**
   * On `duplicate`, the EXISTING fact's id — the contract's wording, and the
   * whole value of the status: the caller learns what the brain already knows.
   * On `superseded`, the fact being superseded. Null on `inserted`.
   */
  readonly matchedFactId: string | null;
  readonly similarity: number | null;
}

interface Neighbour {
  fact_id: string;
  statement: string;
  similarity: number;
}

/**
 * Classifies a statement against what the brain already holds.
 *
 * Runs **before** the write transaction, on the plain connection, because
 * {@link withVectorScan} opens its own transaction to scope the HNSW GUCs.
 * The snapshot it reads is therefore a moment older than the insert that
 * follows; the cost of that race is a near-duplicate admitted under
 * concurrency, which consolidation collapses, and the alternative is holding a
 * write transaction open across a provider round-trip.
 */
export async function classifyStatement(
  sql: SQL,
  input: {
    readonly statement: string;
    readonly vector: readonly number[];
    /**
     * The credential this write arrived through. Only facts already carrying it
     * are candidates: see the header — a cross-origin collapse throws away the
     * second attestation and cannot be undone, because origin is immutable.
     */
    readonly origin: string;
    /**
     * A page being rewritten is not "what the brain already knows": its own
     * previous facts are about to be tombstoned by the same write, so counting
     * them as duplicates would delete the claim rather than carry it forward.
     */
    readonly excludePageId?: string | null;
  },
): Promise<DedupVerdict> {
  const statement = input.statement.trim();
  const key = normalize(statement);
  const literal = vectorLiteral(input.vector);

  // The cheap exact case first: a client retrying a write it already made.
  const excluded = input.excludePageId ?? null;

  const identical = (await sql`
    SELECT fact_id::text AS fact_id FROM fact
     WHERE deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL
       AND statement = ${statement}
       AND ${input.origin} = ANY (origin_contexts)
       AND (${excluded}::bigint IS NULL OR page_id IS DISTINCT FROM ${excluded}::bigint)
     ORDER BY fact_id
     LIMIT 1
  `) as Array<{ fact_id: string }>;
  if (identical[0] !== undefined) {
    return { status: 'duplicate', matchedFactId: identical[0].fact_id, similarity: 1 };
  }

  const pool = candidatePoolFor({ limit: DEDUP_RESULT_LIMIT });
  const neighbours = await withVectorScan(sql, { candidatePool: pool }, async (tx) => {
    const rows = (await tx`
      SELECT fact_id::text AS fact_id, statement, 1 - (embedding <=> ${literal}::vector) AS similarity
        FROM fact
       WHERE deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL
         AND ${input.origin} = ANY (origin_contexts)
         AND (${excluded}::bigint IS NULL OR page_id IS DISTINCT FROM ${excluded}::bigint)
       ORDER BY embedding <=> ${literal}::vector
       LIMIT ${pool}
    `) as Neighbour[];
    return { rows };
  });

  let supersedes: DedupVerdict | null = null;
  const incoming = extractFromStatement(statement);

  for (const neighbour of neighbours.rows) {
    const similarity = Number(neighbour.similarity);

    if (normalize(neighbour.statement) === key) {
      return { status: 'duplicate', matchedFactId: neighbour.fact_id, similarity };
    }
    if (similarity >= DUPLICATE_SIMILARITY) {
      return { status: 'duplicate', matchedFactId: neighbour.fact_id, similarity };
    }
    if (incoming === null || similarity < SUPERSEDE_CANDIDATE_SIMILARITY) continue;

    const existing = extractFromStatement(neighbour.statement);
    if (existing === null) continue;
    if (normalize(existing.subject) !== normalize(incoming.subject)) continue;
    if (existing.topic !== incoming.topic) continue;
    // No check on the *value*, deliberately. The contract's rule is "different
    // text", and its worked example — "X at acme-example" → "X left
    // acme-example" — keeps the same object while reversing the claim. A
    // value-inequality check would refuse exactly that, leaving both the
    // arrival and the departure live. Text difference is already established:
    // normalized equality returned `duplicate` earlier in this loop.

    // Neighbours arrive nearest-first, so the first structural match is the
    // closest one; later ones are further away by construction.
    if (supersedes === null) {
      supersedes = { status: 'superseded', matchedFactId: neighbour.fact_id, similarity };
    }
  }

  return supersedes ?? { status: 'inserted', matchedFactId: null, similarity: null };
}
