/**
 * Which column a vector goes in, decided by **which model produced it**.
 *
 * KTD8 used to be one number in one place: `EMBEDDING_DIMENSIONS`, the width of
 * `chunk.embedding`, true because exactly one model was ever routed to the
 * `embedding` op. The moment a second embedding model exists that stops being a
 * property of the schema and becomes a property of the *call* — and a constant
 * that used to be right becomes a constant that is right for one of two answers.
 *
 * **Two vectors of different models are not points in the same space, and two
 * vectors of the same width from different models are not either.** The width
 * mismatch is the loud half: pgvector refuses `vector(1024) <=> vector(1536)`
 * and the query errors. The same-width case is the silent half — every distance
 * computes, every row ranks, and recall collapses with nothing to point at.
 * A guard that keys on width therefore guards the case that was never dangerous.
 * The seat is keyed on the **model** instead, so the same-width swap is caught by
 * the same mechanism as the different-width one.
 *
 * **Which model owns which seat is NOT written here**, and that is KTD13's
 * boundary rather than a filing preference: `test/ai/boundary.test.ts` fails any
 * file outside `src/ai` that names a model id, because a caller that can name a
 * model is a caller that can pick one. So this file holds the seats — a column,
 * a width, the rung that created it — and `src/ai/routing.ts:embeddingSeatFor`
 * holds the binding from a routed model id to one of them. A read resolves its
 * column by handing that function the id the gateway **reported having called**,
 * from its own metering record: an operator hands the gateway a `NamedProfile`,
 * so a profile *called* `hosted` need not route `embedding` where the shipped
 * table routes it, and only the record of the call that happened is a record of
 * which space the query vector is in.
 *
 * **An unregistered model resolves to nothing, and nothing is not a default.**
 * The caller drops the vector arm rather than falling back to the shipped
 * column, because a fallback is precisely the silent misread: the vectors would
 * be scanned, the answer would look ordinary, and the only thing wrong with it
 * would be that it was computed in the wrong space.
 *
 * **A seat is not servable merely because it is registered.**
 * {@link findSeatWriteBlockers} asks the tenant's own catalog whether every
 * `NOT NULL` vector column can be written by this seat. `fact.embedding` is
 * `vector(1536) NOT NULL` — a fact is embedded synchronously, so an unembedded
 * fact is a row the database refuses — and no 1024-dimension model can produce a
 * value for it. Removing that `NOT NULL` is an `ALTER COLUMN`, which
 * `src/control/migrate.ts:findExpandContractViolations` refuses with no waiver
 * list, so the seat is blocked on a contract rung that does not exist yet. The
 * blocker is computed from the catalog rather than declared here, so it stops
 * being true by itself on the day the schema changes.
 */

/** A place vectors of one width live, and the rung that created it. */
export interface EmbeddingSeat {
  /**
   * Stable seat name. This is what `src/ai/routing.ts` binds a model id to, and
   * what an eval receipt names when it says which space it measured.
   */
  readonly id: string;
  /** The column on `chunk` and on `fact`. One name, two tables. */
  readonly column: string;
  readonly dimensions: number;
  /**
   * The schema rung that creates the column. A tenant part-way up the ladder
   * does not have it, and a read that scanned a column the tenant lacks would
   * fail as an outage rather than as a misconfiguration.
   */
  readonly since: number;
  /** Why this seat exists, in one line. */
  readonly why: string;
}

/**
 * Every embedding space this codebase knows how to store.
 *
 * Registering a seat is not the same act as routing to it: this says where a
 * model's vectors would go, `src/ai/routing.ts` says which model goes here and
 * whether anything asks for it, and {@link findSeatWriteBlockers} says whether
 * the tenant schema can hold them. All three have to agree before a seat is
 * live, and they are three because they fail for three different reasons.
 */
export const EMBEDDING_SEATS: readonly EmbeddingSeat[] = [
  {
    id: 'openai-3-large-1536',
    column: 'embedding',
    dimensions: 1536,
    since: 1,
    why: "KTD8's original seat: 3-large truncated to 1536 through the API's dimensions parameter, which is inside pgvector's HNSW ceiling of 2000",
  },
  {
    id: 'cf-qwen3-embedding-0.6b-1024',
    column: 'embedding_qwen1024',
    dimensions: 1024,
    since: 13,
    why: "the Cloudflare seat, so one credential pays for every model op; natively 1024 and the dimensions parameter is ignored on that endpoint, so the width is the model's rather than a choice",
  },
];

/**
 * The seat a tenant is provisioned at, and the one every constant derived from
 * "the embedding column" still means.
 *
 * It is the OpenAI seat, and it is not a preference — see
 * {@link findSeatWriteBlockers}. Written as a lookup rather than as a second
 * copy of the row so that "the active seat" and "the seat registry" cannot
 * disagree.
 */
export const ACTIVE_EMBEDDING_SEAT: EmbeddingSeat = requireSeatById('openai-3-large-1536');

export class UnknownEmbeddingSeatError extends Error {
  readonly seatId: string;

  constructor(seatId: string) {
    super(
      `no embedding seat named '${seatId}' is registered: vectors bound to it have no column to go in and no column to be read from. Falling back to the shipped column would scan vectors a different model wrote — every distance computes, every row ranks, and the answer is wrong in a way nothing reports.`,
    );
    this.name = 'UnknownEmbeddingSeatError';
    this.seatId = seatId;
  }
}

/** The seat of that name, or `undefined`. Never a fallback. */
export function seatById(id: string | null | undefined): EmbeddingSeat | undefined {
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return EMBEDDING_SEATS.find((seat) => seat.id === id);
}

/** {@link seatById}, throwing {@link UnknownEmbeddingSeatError} instead. */
export function requireSeatById(id: string | null | undefined): EmbeddingSeat {
  const seat = seatById(id);
  if (seat === undefined) throw new UnknownEmbeddingSeatError(id ?? '');
  return seat;
}

/** Every distinct column any registered seat writes. */
export function seatColumns(): readonly string[] {
  return [...new Set(EMBEDDING_SEATS.map((seat) => seat.column))];
}

/**
 * True for a column some registered seat owns.
 *
 * The read path interpolates the column name into SQL — there is no parameter
 * form for an identifier — so the value has to come from somewhere closed. This
 * is that closure, asked at the point of interpolation rather than assumed from
 * the fact that the value came from a seat object.
 */
export function isSeatColumn(column: string): boolean {
  return seatColumns().includes(column);
}

/** One vector column, as the tenant's catalog reports it. Mirrors
 * `vector-index.ts:CatalogVectorColumn`, restated as a structural type so this
 * module imports nothing and the two files cannot form a cycle. */
export interface VectorColumnFacts {
  readonly table: string;
  readonly column: string;
  /** `format_type`, so it arrives spelled as declared: `vector(1536)`. */
  readonly type: string;
  readonly notNull: boolean;
}

const DECLARED_WIDTH = /^(?:vector|halfvec)\s*\(\s*(\d+)\s*\)$/i;

/**
 * Why a registered seat cannot be made active on this tenant, as findings.
 *
 * **The rule is one line: a `NOT NULL` vector column must be one this seat can
 * fill.** `NOT NULL` on a vector column is a promise that the write path
 * produces a value for every row — nothing pays an embedding call per row for a
 * column it never reads — so a column of a width this seat does not produce is a
 * column every INSERT will fail on. That failure would arrive at the first
 * write under a live user, from a stack trace naming a constraint, long after
 * the routing row that caused it was edited.
 *
 * Findings rather than a throw, and asked of the **catalog** rather than of a
 * list in this file, for the same reason `findVectorRegistryViolations` is:
 * a hand-written blocker keeps its value after it stops being true, and the
 * whole point of a blocker is that it goes away when the thing blocking is
 * removed.
 */
export function findSeatWriteBlockers(
  seat: EmbeddingSeat,
  columns: readonly VectorColumnFacts[],
): string[] {
  const findings: string[] = [];

  for (const column of columns) {
    if (!column.notNull) continue;
    const width = DECLARED_WIDTH.exec(column.type.trim());
    if (width === null) continue;
    const declared = Number.parseInt(width[1] ?? '', 10);
    if (!Number.isSafeInteger(declared) || declared === seat.dimensions) continue;

    findings.push(
      `${column.table}.${column.column} is ${column.type} NOT NULL and seat '${seat.id}' produces ${seat.dimensions} dimensions — every INSERT would have to supply a vector this seat cannot compute. Making the column nullable is an ALTER COLUMN, which the expand-only rule in src/control/migrate.ts refuses with no waiver, so this seat is blocked on a contract rung rather than on a routing edit.`,
    );
  }

  return findings;
}

/** Thrown when provisioning is asked to serve a tenant under a blocked seat. */
export class UnservableEmbeddingSeatError extends Error {
  readonly seat: EmbeddingSeat;
  readonly findings: readonly string[];

  constructor(seat: EmbeddingSeat, findings: readonly string[]) {
    super(
      `embedding seat '${seat.id}' (${seat.dimensions}d, column ${seat.column}) is not servable on this tenant: ${findings.join('; ')}`,
    );
    this.name = 'UnservableEmbeddingSeatError';
    this.seat = seat;
    this.findings = findings;
  }
}
