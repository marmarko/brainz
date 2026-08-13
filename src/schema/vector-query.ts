/**
 * The one helper every vector query goes through — and the only place the two
 * HNSW GUCs are set.
 *
 * It exists because of two hazards in `docs/porting-hazards.md` that share a
 * signature: the vector arm silently underperforms its specification, with no
 * error, no failing test, and no signal except a query plan nobody reads.
 *
 * **H1 — `hnsw.ef_search` sizes the candidate list.** pgvector defaults it to
 * {@link HNSW_EF_SEARCH_DEFAULT}, and an HNSW scan returns at most that many
 * rows *regardless of what the query's LIMIT asks for*. The retrieval stack asks
 * the vector arm for a pool, not for final results — `offset + max(limit * 5,
 * 100)` candidates — so at every search mode the pool truncates to 40 and RRF
 * fusion, per-page collapse, rerank and autocut all operate on a fraction of
 * what they were designed for. Measured on this substrate: a 250-candidate
 * request returns 40.
 *
 * **H3 — the predicates run afterwards.** pgvector applies `WHERE` after the
 * HNSW scan returns its `ef_search` candidates, so the GUC sizes the *scan* and
 * not the *qualifying yield*. Every read here carries an origin fence (R15), a
 * soft-delete exclusion (R12) and a junk-quarantine filter (U9), so H1's fix on
 * its own buys nothing in production. Measured on this substrate, same fixture:
 * with `ef_search` raised and iterative scan off, that 250-candidate request
 * yields **150** qualifying rows. `hnsw.iterative_scan` is what makes the scan
 * resume instead of stopping at the first batch.
 *
 * **Why both belong here and not at a call site.** They have to be `SET LOCAL`
 * inside the query's own transaction. A bare `SET` on a pooled connection either
 * leaks the setting to whatever runs next on that connection or evaporates
 * before the query does — and with a per-tenant connection LRU, the first of
 * those is a cross-tenant correctness bug, not merely a correctness bug. A call
 * site that sets the GUC itself is one refactor away from moving the statement
 * out of the transaction, which is why there is one helper and why its guard is
 * behavioural rather than a lint. `test/hazards/h1-ef-search-truncation.test.ts`
 * pins the transaction scoping directly.
 */

import type { SQL, TransactionSQL } from 'bun';

/** pgvector's default. The number the pool silently truncates to. */
export const HNSW_EF_SEARCH_DEFAULT = 40;

/** pgvector's hard ceiling on the GUC. Requests above it are clamped, not rejected. */
export const HNSW_EF_SEARCH_MAX = 1000;

/**
 * `relaxed_order` rather than `strict_order`.
 *
 * Strict ordering makes the scan re-sort to guarantee results arrive in exact
 * distance order, at a cost. Nothing downstream needs that: this is a candidate
 * *pool*, fused with the full-text and graph arms by RRF and then reranked, so
 * the index's internal ordering is overwritten before anything is shown. Both
 * modes return the full pool — the choice is about cost, not about yield.
 */
export const HNSW_ITERATIVE_SCAN_MODE = 'relaxed_order';

/**
 * The next ceiling down this path, named rather than discovered later:
 * `hnsw.max_scan_tuples` (default 20,000) bounds how far an iterative scan will
 * resume before giving up. On a brain whose origin fence excludes most of the
 * corpus, a pool request can still come back short once the corpus is large
 * enough — same silent-degradation signature, one layer further down. It is not
 * set here because 20,000 is roughly 80× the largest pool the retrieval stack
 * asks for, and a knob set without a measurement is how the first two GUCs got
 * their defaults wrong in the first place.
 */
export const HNSW_MAX_SCAN_TUPLES_DEFAULT = 20_000;

export interface VectorScanOptions {
  /**
   * How many candidates the caller wants back. Sized to the pool the retrieval
   * stack actually asked for, not to the final result count — the whole hazard
   * is the gap between those two numbers. {@link candidatePoolFor} is how a
   * caller gets that number right.
   */
  readonly candidatePool: number;
}

/**
 * The pool size the retrieval stack asks the vector arm for, as a function
 * rather than as a sentence in a doc comment.
 *
 * **No production caller exists yet — U5 owns the retrieval arm — and that is
 * exactly why this is here.** Every guard in `test/hazards/` calls
 * {@link withVectorScan} directly, so what they pin is the helper's transaction
 * mechanics: they cannot pin that the arm passes a *pool* rather than a final
 * `limit`. A caller that writes `withVectorScan(sql, { candidatePool: limit },
 * …)` with `limit = 10` sets `ef_search = 10`, truncates the pool below even
 * pgvector's own default of 40, and leaves every hazard guard green — H1's
 * mechanism reintroduced through the front door by code that looks correct.
 *
 * So the arithmetic gbrain paid for lives here, named, and the U5 arm calls this
 * instead of doing the multiplication at the call site:
 *
 *     offset + max(limit * 5, 100)
 *
 * The floor matters as much as the multiplier: at `limit = 10` the multiplier
 * alone gives 50, which is a pool barely above the default this whole module
 * exists to raise.
 */
export function candidatePoolFor(request: {
  readonly limit: number;
  readonly offset?: number;
}): number {
  const limit = Math.max(Math.trunc(request.limit), 1);
  const offset = Math.max(Math.trunc(request.offset ?? 0), 0);
  if (!Number.isFinite(limit) || !Number.isFinite(offset)) {
    throw new TypeError('limit and offset must be finite numbers');
  }
  return offset + Math.max(limit * 5, 100);
}

/**
 * Clamps a requested pool to something `SET LOCAL` will accept.
 *
 * Exported so the clamp is testable on its own, and because a caller that asked
 * for more than {@link HNSW_EF_SEARCH_MAX} should be able to find out it will
 * not get it. A non-finite request throws rather than clamping: silently
 * treating `NaN` as 1 would reintroduce the hazard through the front door.
 */
export function clampCandidatePool(requested: number): number {
  if (!Number.isFinite(requested)) {
    throw new TypeError(`candidatePool must be a finite number, got ${String(requested)}`);
  }
  return Math.min(Math.max(Math.trunc(requested), 1), HNSW_EF_SEARCH_MAX);
}

/**
 * Runs `run` inside a transaction with both HNSW GUCs set for its duration.
 *
 * Neither value is interpolated from caller text: the `ef_search` is an integer
 * that has been through {@link clampCandidatePool}, and the scan mode is a
 * module constant. GUC values cannot be bound as parameters, so that is the
 * property that has to hold instead.
 */
export async function withVectorScan<T>(
  sql: SQL,
  options: VectorScanOptions,
  run: (tx: TransactionSQL) => Promise<T>,
): Promise<T> {
  const efSearch = clampCandidatePool(options.candidatePool);

  // Wrapped in an object, and cast: `begin`'s return type is a conditional that
  // unwraps arrays of promises, and TypeScript cannot resolve it while `T` is
  // still generic. The wrapper is what makes the runtime behaviour unambiguous
  // — an array return would otherwise be treated as a promise list.
  const outcome = (await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL hnsw.ef_search = ${efSearch}`);
    await tx.unsafe(`SET LOCAL hnsw.iterative_scan = ${HNSW_ITERATIVE_SCAN_MODE}`);
    return { value: await run(tx) };
  })) as { value: T };

  return outcome.value;
}
