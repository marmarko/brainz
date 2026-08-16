/**
 * U18 §4 — the severance flow: the caller U17's preview never had.
 *
 * ============================================================================
 * WHAT SEVERANCE IS, AND WHAT IT IS NOT
 * ============================================================================
 *
 * A user disconnects their work account. R15 says every row carries an
 * immutable, credential-derived origin and derived rows carry the **union** of
 * their inputs' origins. So the corpus divides in three, not two:
 *
 *   * rows whose origins are **exactly** the severed one — these go;
 *   * rows whose origins **include** it and others — these stay, and are now
 *     *wrong*: they assert something over evidence half of which is gone;
 *   * rows that never touched it — untouched.
 *
 * `blast-radius.ts:previewSeverance` (U17) counts the first two. This module is
 * what happens when the user says yes.
 *
 * **It is a tombstone, not an erasure.** R12 gives `forget` a 72-hour
 * recoverable window and severance is not a more final operation than `forget` —
 * a user who disconnects the wrong account at 2am must be able to undo it. The
 * hard purge that follows is the one that already exists
 * (`src/mcp/tombstone.ts:purgeExpiredTombstones`), on the same clock.
 *
 * **Two mechanisms, because one table cannot use the first.** Seven tables carry
 * a `deleted_at` a user retraction may write, and the first class is tombstoned
 * in place. `entity_alias` carries none — and is the one derived table this
 * schema deliberately allows to be *narrower* than its parent (rung 11), so it
 * is also the only one where an exact-origin row can outlive a severance that
 * keeps the parent. Those rows are **moved** into rung 12's `severed_alias`,
 * carrying the same instant, so the same undo and the same purge reach them. The
 * receipt reports the two separately (`tombstoned`, `archived`) rather than
 * summing them, because a caller that could not tell which happened could not
 * tell what an undo would do.
 *
 * **It does not re-derive.** Re-derivation is a consolidation cycle and belongs
 * to U11. What this unit owes is that the *need* for it is recorded honestly and
 * is discoverable, which is what the `severance` row (rung 10) is for, and that
 * the numbers the user consented to are the numbers that happened.
 *
 * ============================================================================
 * WHY THE PREVIEW IS RE-RUN INSIDE THE TRANSACTION
 * ============================================================================
 *
 * The obvious implementation takes the preview the page rendered and stores it.
 * That number was computed when the user opened the dialog; by the time they
 * click, a connector poll may have added forty rows. Storing the rendered number
 * would make the audit record a description of a state that no longer existed
 * when the deletes ran — and the two-column preview exists precisely so a user
 * can weigh a cost, so the recorded cost has to be the one incurred.
 *
 * So `previewSeverance` runs again against the transaction that is about to do
 * the deleting, and *that* is what is recorded. The rendered preview is
 * advisory; this one is the receipt.
 *
 * ============================================================================
 * THE AUTHORITY, AND WHY IT IS NOT A BOOLEAN
 * ============================================================================
 *
 * R12a: the assistant holding `remember` is the assistant reading the user's
 * mail, and approving a model-proposed mutation is exactly the class that must
 * never execute unconfirmed. Severance is irreversible-in-practice and
 * destructive, so it is **not** on `tools/call` at all — `manage`'s enum is four
 * reversible settings and severance is not one of them.
 *
 * The confirmation is an **echo of the origin string**, not a flag. A boolean
 * `confirm: true` is a field a bug fills in, a retry replays and a model can
 * guess; the exact origin being severed is a string only something that read the
 * preview can produce.
 */

import type { SQL, TransactionSQL } from 'bun';

import { previewSeverance, type RemovalCounts } from './blast-radius.ts';
import { classOf, expandGrant } from '../../mcp/grant-scope.ts';

export type { SeverancePreview } from './blast-radius.ts';

export interface SeveranceRequest {
  readonly origin: string;
  /**
   * The origin string again, as the user typed or clicked it.
   *
   * See the header: a boolean is a field a bug fills in. This is the control,
   * not a nicety, and {@link severOrigin} refuses on a mismatch before it opens
   * a transaction.
   */
  readonly confirm: string;
  readonly now: Date;
}

export interface SeveranceReceipt {
  readonly severanceId: string;
  readonly origin: string;
  readonly severedAt: string;
  /** What the preview said *inside the executing transaction*. */
  readonly removed: RemovalCounts;
  readonly recomputed: RemovalCounts;
  readonly survivingOrigins: readonly string[];
  /** Rows actually tombstoned, per table. Compared against `removed` by the suite. */
  readonly tombstoned: TombstonedCounts;
  /**
   * Rows severance took by **moving** them, because they have no `deleted_at` to
   * write and no cascade to ride.
   *
   * Separate from {@link tombstoned} rather than folded into it, because the two
   * are different mechanisms with different failure modes and a caller reading
   * one number could not tell which happened. Same clock, same undo key: see
   * {@link archiveExactOriginAliases}.
   */
  readonly archived: ArchivedCounts;
  /** True when this origin had already been severed and nothing was left to take. */
  readonly alreadySevered: boolean;
}

export interface TombstonedCounts {
  readonly pages: number;
  readonly chunks: number;
  /**
   * **Counted by the preview since U17 and taken by nothing until now.**
   *
   * An attachment is scalar-origin like a page, carries its own `deleted_at`,
   * and is already swept by `purgeExpiredTombstones` — it was simply absent from
   * the executor, so `removed.attachments` was a number the user consented to
   * that did not happen and the stored object outlived the disconnect. It is not
   * covered by the page cascade either: `attachment.page_id` is **nullable** and
   * carries no origin-union constraint against its page, so a work attachment
   * can hang off nothing at all or off a page that survives.
   */
  readonly attachments: number;
  readonly facts: number;
  readonly entities: number;
  readonly entityCards: number;
  readonly commitments: number;
}

export interface ArchivedCounts {
  readonly aliases: number;
}

export type SeveranceOutcome =
  | { readonly ok: true; readonly receipt: SeveranceReceipt }
  | { readonly ok: false; readonly reason: 'not_confirmed' | 'unknown_origin' };

/**
 * Sever one origin. Preview, tombstone, record — in one transaction.
 *
 * **The order inside the transaction is not arbitrary.** The preview runs first
 * so it describes the state the deletes are about to change; the deletes run
 * next; the record is written last with the preview's numbers, so a record
 * exists only for a severance that completed. A crash between any two of them
 * rolls the whole thing back, which is the property that makes the flow safe to
 * retry — and retrying is the normal case, because the surface that calls this
 * is a web request.
 */
export async function severOrigin(sql: SQL, request: SeveranceRequest): Promise<SeveranceOutcome> {
  if (request.confirm !== request.origin) return { ok: false, reason: 'not_confirmed' };
  // A severance of something with no class is a severance of a string nobody
  // could have granted. Refused before a transaction opens, so a typo costs
  // nothing rather than writing an audit row about an event that cannot happen.
  if (classOf(request.origin) === null) return { ok: false, reason: 'unknown_origin' };

  const at = request.now.toISOString();

  return sql.begin(async (tx) => {
    // The receipt's numbers, computed against the state the deletes are about to
    // change rather than against whatever the dialog rendered minutes ago.
    const preview = await previewSeverance(tx as unknown as SQL, { origin: request.origin });

    const tombstoned = await tombstoneExactOrigin(tx, request.origin, at);
    const archived = await archiveExactOriginAliases(tx, request.origin, at);

    const rows = (await tx`
      INSERT INTO severance (origin_context, severed_at, removed, recomputed, surviving_origins)
      VALUES (${request.origin}, ${at}::timestamptz,
              ${countsJson(preview.removed)}, ${countsJson(preview.recomputed)},
              ${pgTextArray(preview.survivingOrigins)}::text[])
      RETURNING severance_id::text AS severance_id
    `) as Array<{ severance_id: string }>;

    return {
      ok: true as const,
      receipt: {
        severanceId: rows[0]?.severance_id ?? '',
        origin: request.origin,
        severedAt: at,
        removed: preview.removed,
        recomputed: preview.recomputed,
        survivingOrigins: preview.survivingOrigins,
        tombstoned,
        archived,
        // Idempotency, reported rather than hidden: a second severance of the
        // same origin is a no-op that still writes a record, and the caller can
        // tell the two apart.
        //
        // **Every take, not four of them.** The sum used to name `pages`,
        // `chunks`, `facts` and `entities`, which reported "nothing left" over a
        // severance that took a parentless attachment or an alias off a
        // surviving mixed entity — the two rows that have no parent to have gone
        // with the first four. Derived from the objects so a table added to
        // either mechanism joins the sum without anyone remembering to.
        alreadySevered: totalOf(tombstoned) + totalOf(archived) === 0,
      },
    };
  });
}

/**
 * Tombstone every row whose origins are **exactly** the severed one.
 *
 * The predicates mirror `previewSeverance`'s `exact` mode statement for
 * statement, and that mirroring is the point of the last test in
 * `test/core/lifecycle/severance.test.ts`: the preview's `removed` column and
 * these counts are compared against each other over the same fixture, so the
 * preview is *checked* rather than trusted.
 *
 * **`<@ ARRAY[origin]` on the derived tables, never `@>`.** The column is a
 * non-empty set by CHECK, so a subset of a singleton *is* that singleton — which
 * is "nothing but this origin". `@>` would be "includes this origin", and would
 * tombstone every mixed row: the user disconnects work and loses their shared
 * history with everyone they know through both accounts, silently, having been
 * shown a preview that said those rows would survive.
 *
 * **`entity_edge` is the one column of `removed` with no statement here, and the
 * omission is a schema fact rather than an oversight.** `entity_edge_origin_union`
 * (rung 2) refuses any edge that does not carry the origins of both entities it
 * connects, so an edge whose origins are exactly the severed one has two
 * exactly-severed endpoints — both tombstoned by the `entities` statement below,
 * both hard-deleted by the purge, and the edge leaves with them through
 * `entity_edge_subject_fkey ... ON DELETE CASCADE`. Until then it has no live
 * endpoint to be reached from, which is what `search/arms.ts:graphArm` seeds its
 * neighbourhood off. Writing a `deleted_at` here instead would overload the one
 * column `tombstone.ts:DELETED_AT_IS_NOT_A_TOMBSTONE` reserves for a
 * *reconciliation* retraction, and would leave a tombstone no sweep reaches.
 * `test/core/lifecycle/severance-removal-class.test.ts` asserts the constraint
 * refuses the shape that would make this wrong, rather than trusting this
 * paragraph.
 */
async function tombstoneExactOrigin(
  tx: TransactionSQL,
  origin: string,
  at: string,
): Promise<TombstonedCounts> {
  const count = async (statement: string): Promise<number> => {
    const rows = (await tx.unsafe(statement, [origin, at])) as Array<unknown>;
    return rows.length;
  };

  return {
    pages: await count(
      `UPDATE page SET deleted_at = $2::timestamptz
        WHERE origin_context = $1 AND deleted_at IS NULL RETURNING page_id`,
    ),
    chunks: await count(
      `UPDATE chunk SET deleted_at = $2::timestamptz
        WHERE origin_context = $1 AND deleted_at IS NULL RETURNING chunk_id`,
    ),
    // `deleted_at IS NULL`, like every statement here, and here it is doing more
    // than skipping work: re-stamping a row a `forget` already retracted would
    // move it onto *this* instant and quietly detach it from the undo of the
    // call that took it. (`previewSeverance`'s attachment arm carries no such
    // filter, so `removed.attachments` over-counts by any attachment a prior
    // retraction already holds — reported rather than repaired, since the
    // preview is not this module's.)
    attachments: await count(
      `UPDATE attachment SET deleted_at = $2::timestamptz
        WHERE origin_context = $1 AND deleted_at IS NULL RETURNING attachment_id`,
    ),
    facts: await count(
      `UPDATE fact SET deleted_at = $2::timestamptz
        WHERE origin_contexts <@ ARRAY[$1]::text[] AND deleted_at IS NULL RETURNING fact_id`,
    ),
    entities: await count(
      `UPDATE entity SET deleted_at = $2::timestamptz
        WHERE origin_contexts <@ ARRAY[$1]::text[] AND deleted_at IS NULL RETURNING entity_id`,
    ),
    entityCards: await count(
      `UPDATE entity_card SET deleted_at = $2::timestamptz
        WHERE origin_contexts <@ ARRAY[$1]::text[] AND deleted_at IS NULL RETURNING card_id`,
    ),
    commitments: await count(
      `UPDATE commitment SET deleted_at = $2::timestamptz
        WHERE origin_contexts <@ ARRAY[$1]::text[] AND deleted_at IS NULL RETURNING commitment_id`,
    ),
  };
}

/**
 * Move every alias whose origins are exactly the severed one into rung 12's
 * holding pen.
 *
 * **Why this table needs a statement of its own.** Every other derived table in
 * this schema is protected from the exact-origin residue by a covering
 * constraint — a card must carry its entity's origins, an edge both its
 * endpoints', a commitment its fact's and page's — so an exact-origin row of
 * those kinds always has an exactly-severed parent that the statements above
 * tombstone. `entity_alias` has no such constraint **on purpose**: rung 11's
 * whole argument is that a spelling one sender used in one mailbox must be
 * allowed to be narrower than the person it names. That is what makes a
 * work-only alias on a *mixed* entity reachable, and what leaves it with no
 * `deleted_at` to be written and no cascade to ride.
 *
 * **Moved rather than flagged.** Nine sites in this repository read aliases; a
 * tombstone is only honoured by the ones that remember its predicate, and the
 * one that forgets keeps serving the spelling the user disconnected. A row that
 * is not in `entity_alias` is invisible to a query against `entity_alias`
 * whether or not its author has heard of severance. It also occupies no slot,
 * which matters because `entity_alias_is_unique_per_entity` is a **total**
 * unique constraint — a tombstoned alias would block its own respelling until
 * the purge, and making that index partial is a contracting change.
 *
 * **`coalesce(a.origin_contexts, e.origin_contexts)`, the read fence's own
 * expression.** `reads.ts:entityCard` admits an alias when that value is a
 * subset of the grant; this takes it when that value is a subset of the severed
 * singleton. So what leaves is exactly the set of spellings only a grant holding
 * the severed origin could ever have been shown — the same rule read forwards
 * and backwards, rather than a second definition free to disagree. The
 * `coalesce` also decides the pre-rung-11 rows: an unstamped alias is judged by
 * its entity's whole union, so it is taken only when the entity itself is
 * exactly severed (and would have cascaded anyway), never on a guess about
 * provenance nobody recorded.
 *
 * **Same clock, same key.** `severed_at` is the severance instant every other
 * row in this transaction carries, so `restoreForgotten` un-does all of them
 * together and `purgeExpiredTombstones` sweeps them on the same 72-hour cutoff.
 * Severance stays no more final than `forget`, which is the guarantee that ruled
 * out a hard delete here.
 */
async function archiveExactOriginAliases(
  tx: TransactionSQL,
  origin: string,
  at: string,
): Promise<ArchivedCounts> {
  // One statement, so the row cannot exist in both tables or in neither: the
  // DELETE's output is the INSERT's input rather than two statements agreeing.
  const rows = (await tx.unsafe(
    `WITH taken AS (
       DELETE FROM entity_alias a
        USING entity e
        WHERE e.entity_id = a.entity_id
          AND coalesce(a.origin_contexts, e.origin_contexts) <@ ARRAY[$1]::text[]
       RETURNING a.entity_id, a.alias, a.alias_source, a.confidence,
                 a.origin_contexts, a.created_at
     )
     INSERT INTO severed_alias (entity_id, alias, alias_source, confidence,
                                origin_contexts, created_at, severed_at)
     SELECT entity_id, alias, alias_source, confidence, origin_contexts,
            created_at, $2::timestamptz
       FROM taken
     RETURNING severed_alias_id`,
    [origin, at],
  )) as Array<unknown>;

  return { aliases: rows.length };
}

/**
 * Every take in one object's worth of counts, summed.
 *
 * Takes the object rather than a list of field names, so a table added to either
 * mechanism is counted by construction. `interface` types carry no index
 * signature, hence `object` and the runtime narrowing rather than
 * `Record<string, number>`.
 */
function totalOf(counts: object): number {
  return Object.values(counts).reduce<number>(
    (sum, value) => sum + (typeof value === 'number' ? value : 0),
    0,
  );
}

/**
 * Rows a consolidation cycle has to re-derive, as a query rather than a flag.
 *
 * Rung 10's header argues the design; this is the reader. A row needs
 * re-deriving exactly when its origins **contain** a severed origin and are not
 * **contained by** it — the same two predicates the preview's second column
 * counts, evaluated against the severance log rather than against one origin the
 * caller happened to name.
 *
 * Derived rather than stored, so the answer cannot go stale, cannot disagree
 * between two tables, and is never wrong for a row written after the severance.
 */
export async function recomputeWorklist(
  sql: SQL,
  options: { readonly since?: Date } = {},
): Promise<{ readonly severedOrigins: readonly string[]; readonly counts: RemovalCounts }> {
  const since = options.since?.toISOString() ?? null;
  const severed = (await sql`
    SELECT DISTINCT origin_context FROM severance
     WHERE ${since === null ? sql`true` : sql`severed_at >= ${since}::timestamptz`}
     ORDER BY origin_context
  `) as Array<{ origin_context: string }>;

  const origins = severed.map((row) => row.origin_context);
  if (origins.length === 0) {
    return { severedOrigins: [], counts: emptyCounts() };
  }

  const literal = pgTextArray(origins);
  const rows = (await sql`
    SELECT
      (SELECT count(*)::int FROM fact
        WHERE deleted_at IS NULL AND origin_contexts && ${literal}::text[]
          AND NOT (origin_contexts <@ ${literal}::text[])) AS facts,
      (SELECT count(*)::int FROM entity
        WHERE deleted_at IS NULL AND origin_contexts && ${literal}::text[]
          AND NOT (origin_contexts <@ ${literal}::text[])) AS entities,
      (SELECT count(*)::int FROM entity_card
        WHERE deleted_at IS NULL AND origin_contexts && ${literal}::text[]
          AND NOT (origin_contexts <@ ${literal}::text[])) AS entity_cards,
      (SELECT count(*)::int FROM commitment
        WHERE deleted_at IS NULL AND origin_contexts && ${literal}::text[]
          AND NOT (origin_contexts <@ ${literal}::text[])) AS commitments,
      (SELECT count(*)::int FROM entity_edge
        WHERE origin_contexts && ${literal}::text[]
          AND NOT (origin_contexts <@ ${literal}::text[])) AS edges
  `) as Array<Record<string, number>>;

  const row = rows[0] ?? {};
  return {
    severedOrigins: origins,
    counts: {
      pages: 0,
      chunks: 0,
      attachments: 0,
      // Zero, and it is the same statement `RemovalCounts.aliases` makes: a
      // spelling asserts nothing, so losing an input cannot leave it wrong, and
      // no phase of consolidation re-derives one. A worklist that counted them
      // would be asking a cycle for work that has no producer.
      aliases: 0,
      facts: Number(row.facts ?? 0),
      entities: Number(row.entities ?? 0),
      entityCards: Number(row.entity_cards ?? 0),
      commitments: Number(row.commitments ?? 0),
      edges: Number(row.edges ?? 0),
    },
  };
}

/**
 * Which of a set of grants must be revoked because severance emptied them.
 *
 * Pure, and separate from the database work, because it is the half that has to
 * be right for a reason the tenant schema knows nothing about: **a grant scoped
 * entirely inside the severed set is a credential that now reads nothing**, and
 * `grant-scope.ts` argues at length why a credential that resolves to nothing
 * must never be one step away from resolving to everything. Leaving it live is
 * that hazard arriving from the other direction — through a later change rather
 * than through this one.
 *
 * A grant that *straddles* the boundary is kept: severing `work:mail` from a
 * grant holding `work:*` leaves it holding `work:agent` and any other work
 * origin, which is a smaller but real scope, and revoking it would disconnect a
 * connector the user did not disconnect.
 */
export function grantsEmptiedBy(
  grants: readonly { readonly grantId: string; readonly origins: readonly string[] }[],
  severedOrigins: readonly string[],
  surviving: readonly string[],
): string[] {
  const severed = new Set(severedOrigins);
  const live = surviving.filter((origin) => !severed.has(origin));

  return grants
    .filter((grant) => {
      if (grant.origins.length === 0) return false; // a whole-brain grant is never emptied
      // **`expandGrant` decides this, not a second rule written here.** The
      // question "what does this grant still reach" already has exactly one
      // answer in this system, and it is the one the fence uses on every
      // request. A separate predicate would be a second definition free to
      // disagree — and the disagreement would be either a live credential that
      // reads nothing or a revoked one that should not have been.
      //
      // The severed origins are subtracted from the expansion as well as from
      // the census, because `expandGrant`'s class floor re-adds the agent origin
      // unconditionally — which is right for a fence and wrong here, where the
      // agent origin may itself have been severed.
      const reaches = expandGrant(grant.origins, live).filter((origin) => !severed.has(origin));
      return reaches.length === 0;
    })
    .map((grant) => grant.grantId);
}

function emptyCounts(): RemovalCounts {
  return {
    pages: 0,
    chunks: 0,
    attachments: 0,
    aliases: 0,
    facts: 0,
    entities: 0,
    entityCards: 0,
    commitments: 0,
    edges: 0,
  };
}

/**
 * The counts, as an object bound for a `jsonb` column.
 *
 * **A raw object, never `JSON.stringify` into a `::jsonb` cast.** The driver
 * double-encodes a stringified value into a jsonb *string scalar* — the defect
 * class this repo has a standing rule about, and one that is invisible until
 * something tries to read a field out of it.
 */
function countsJson(counts: RemovalCounts): Record<string, number> {
  return { ...counts };
}

/**
 * A Postgres `text[]` literal, bound as text and cast in SQL.
 *
 * Bun binds a JS array as a comma-joined string, which `array_in` rejects. Same
 * shape the rest of the repository uses.
 */
function pgTextArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replace(/(["\\])/g, '\\$1')}"`).join(',')}}`;
}
