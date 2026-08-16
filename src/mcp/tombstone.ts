/**
 * R12's soft-delete leg: `forget` is tombstone-only from the first phase it is
 * dispatchable.
 *
 * **Why this is here and not at U17.** R12 promises versions, soft-delete with a
 * TTL and a blast-radius preview, and U17 ships them at Phase 4 — while `forget`
 * goes live in Phase 1, and U13 then bakes for two weeks against real mail with
 * injection live and demarcation being an instruction to a model rather than an
 * enforcement boundary. A `forget` that erased would put an unrecoverable
 * destructive call one crafted email away from the user's assistant. That is the
 * one failure the plan cannot take back, so the tombstone and the 72-hour TTL
 * land with the tool; U17 keeps versions, revert, preview and the erasure
 * runbook.
 *
 * **Recovery keys on the deletion instant, which is why there is no ledger
 * table.** One `forget` runs in one transaction with one `now`, and every row it
 * tombstones carries exactly that timestamp. Restoring is therefore "un-delete
 * the rows whose `deleted_at` is this instant" — precise to the call, blind to
 * every row a different call retracted, and requiring no schema this unit does
 * not own. The receipt the caller gets back carries the instant, so a retraction
 * is undoable by a party that never saw the row ids.
 *
 * **The cascade is chosen, not inherited.** Retracting a document takes its
 * passages and the facts extracted from it, because leaving a fact whose source
 * the user just retracted is the failure a user would describe as "it did not
 * actually forget". Retracting one passage takes only that passage: the
 * surrounding document was not what they asked about. Retracting a fact takes
 * the fact.
 *
 * **The purge is where the foreign keys bite.** `fact.superseded_by` references
 * `fact` with no `ON DELETE` action, so deleting a superseded fact while its
 * successor still points at it raises a constraint violation — and a purge that
 * always raises is a 72-hour TTL that is silently forever. The pointer is
 * cleared first, inside the same transaction.
 */

import type { SQL } from 'bun';

import { fenceEntity, fenceRow, fenceScalar, type Grant } from '../core/search/fence.ts';
import { textArrayLiteral } from '../core/write/pg-values.ts';
import { formatId, type OpaqueId } from './ids.ts';

/** R12's window, and U17's runbook inherits it. */
export const FORGET_TTL_HOURS = 72;

/** One table the `forget`-family tombstone reaches, and how to name it. */
export interface TombstonedTable {
  readonly table: string;
  readonly key: string;
  /** The field this table's count appears under on a receipt. */
  readonly field: string;
  /**
   * An extra predicate a row must satisfy to be **restorable**, or absent when
   * un-deleting is unconditional.
   *
   * Exists for exactly one shape and it is a schema fact rather than a policy:
   * a UNIQUE index over *live* rows means the state a row was tombstoned from
   * may have been taken by another row since. Un-deleting into that is a
   * constraint violation that aborts the whole restore transaction, so the row
   * that cannot come back is skipped and counted rather than raised.
   *
   * `entity_card` is the only such table today, and
   * `test/core/lifecycle/restore-coverage.test.ts` asserts that against
   * `pg_indexes` rather than against this comment.
   */
  readonly restorableWhen?: string;
}

/**
 * Every table a `deleted_at` may be written to by a user-facing retraction, in
 * **purge order**.
 *
 * ONE list, iterated by {@link restoreForgotten} and {@link purgeExpiredTombstones}
 * both, and that is the whole point of its existing. Three executors write these
 * tombstones and they do not write the same set: `forgetRecord` below reaches
 * four tables, `lifecycle/severance.ts:severOrigin` reaches three more
 * (`entity_card`, `commitment` and — since the removal class was audited against
 * the preview column by column — `attachment`), and
 * `lifecycle/subject-erasure.ts:eraseSubject` that same seventh. The restore knew about the first four. So a user who
 * disconnected the wrong account, or erased the wrong correspondent, pressed
 * undo, got `ok: true`, and got a brain with its entity cards, its commitments
 * and its attachments still deleted — no error and no partial flag, which is
 * strictly worse than a refusal.
 *
 * The order is FK order and is not arbitrary: `commitment` references `fact` and
 * `page`, `attachment` and `entity_card` reference `page` and `entity`, and a
 * parent deleted first would cascade rows out from under the count that is about
 * to be reported for them. Restoring is order-free — an `UPDATE … SET deleted_at
 * = NULL` has no referential order — so the restore iterates the same list and
 * simply does not care.
 *
 * `test/core/lifecycle/restore-coverage.test.ts` reads `information_schema` and
 * refuses any table carrying `deleted_at` that appears in neither this list nor
 * {@link DELETED_AT_IS_NOT_A_TOMBSTONE}. An eighth table cannot be tombstoned
 * without somebody deciding, in writing, which of the two it belongs to.
 */
export const TOMBSTONED_TABLES: readonly TombstonedTable[] = [
  { table: 'commitment', key: 'commitment_id', field: 'commitments' },
  { table: 'attachment', key: 'attachment_id', field: 'attachments' },
  {
    table: 'entity_card',
    key: 'card_id',
    field: 'entityCards',
    // `entity_card_one_live_per_entity` is UNIQUE over live cards.
    restorableWhen:
      'NOT EXISTS (SELECT 1 FROM entity_card live ' +
      'WHERE live.entity_id = entity_card.entity_id AND live.deleted_at IS NULL)',
  },
  { table: 'fact', key: 'fact_id', field: 'facts' },
  { table: 'chunk', key: 'chunk_id', field: 'chunks' },
  { table: 'page', key: 'page_id', field: 'pages' },
  { table: 'entity', key: 'entity_id', field: 'entities' },
];

/**
 * Tables whose `deleted_at` means something else, with the reason each is out.
 *
 * A list of exclusions with no reasons is a list that grows every time the
 * census goes red, which would turn the guard into the thing it exists to
 * prevent. Each entry has to say what its column *is*, and the suite asserts the
 * sentence is there.
 */
export const DELETED_AT_IS_NOT_A_TOMBSTONE: readonly { readonly table: string; readonly because: string }[] = [
  {
    table: 'entity_edge',
    because:
      'a reconciliation retraction, not a user retraction: `core/write/links.ts` and ' +
      '`worker/consolidate/deterministic.ts` set it to now() when a later derivation supersedes an edge, ' +
      'so restoring one by instant would resurrect a relationship a cycle deliberately retired. ' +
      'The rows go when their entity goes, through `entity_edge`’s ON DELETE CASCADE, and ' +
      '`subject-erasure.ts` hard-deletes them outright rather than tombstoning for the same reason.',
  },
];

/**
 * The tables a retraction takes by **moving the row out**, with the archive it
 * moves into.
 *
 * A third list beside {@link TOMBSTONED_TABLES} and
 * {@link DELETED_AT_IS_NOT_A_TOMBSTONE}, and it exists for exactly one shape:
 * a table with rows in severance's removal class and **no `deleted_at` to write
 * to**. `entity_alias` is the only one, and it is the only one for a reason the
 * schema states — rung 11 deliberately allows an alias's origins to be *narrower*
 * than its entity's, where `entity_card`, `entity_edge` and `commitment` all
 * carry covering constraints that force an exact-origin row to have an
 * exactly-severed parent. So the residue exists here and nowhere else.
 *
 * Why a move rather than a new `deleted_at` column: nine sites in this repo read
 * aliases, and a tombstone is only honoured by the sites that remember its
 * predicate. A row that is not in `entity_alias` cannot be returned by a query
 * against `entity_alias`. And `entity_alias_is_unique_per_entity` is a **total**
 * unique constraint, so a tombstoned alias would hold its own spelling's slot
 * against re-creation; an archived one holds nothing.
 *
 * Walked by {@link restoreForgotten} and {@link purgeExpiredTombstones} both, for
 * the same reason {@link TOMBSTONED_TABLES} is: what one retraction mechanism
 * takes, both sweeps must reach.
 */
export interface ArchivedTable {
  /** Where the row lives while it is retracted. */
  readonly archive: string;
  /** Where it goes back to. */
  readonly live: string;
  /** The archive's own key, for counting what moved. */
  readonly key: string;
  /** The field these counts appear under on a receipt. */
  readonly field: string;
  /** The columns copied back, in order. Identical on both tables by construction. */
  readonly columns: readonly string[];
  /**
   * What must NOT already exist in the live table for the row to come back.
   *
   * The archive's counterpart to {@link TombstonedTable.restorableWhen}, and the
   * same schema fact one step further along: the slot an archived row vacated is
   * free, so anything may have taken it while the row was away. Un-archiving into
   * an occupied slot raises `23505` and aborts the whole restore transaction —
   * every other table's rows with it — so the row that cannot come back is left
   * archived and counted rather than raised.
   */
  readonly blockedWhen: string;
}

export const ARCHIVED_TABLES: readonly ArchivedTable[] = [
  {
    archive: 'severed_alias',
    live: 'entity_alias',
    key: 'severed_alias_id',
    field: 'aliases',
    columns: ['entity_id', 'alias', 'alias_source', 'confidence', 'origin_contexts', 'created_at'],
    // `entity_alias_is_unique_per_entity UNIQUE (entity_id, alias)` — total, not
    // partial, which is the whole reason this table is archived rather than
    // flagged.
    blockedWhen:
      'EXISTS (SELECT 1 FROM entity_alias live ' +
      'WHERE live.entity_id = severed_alias.entity_id AND live.alias = severed_alias.alias)',
  },
];

/** Counts per archive, keyed by the field names {@link ARCHIVED_TABLES} declares. */
export interface ArchiveCounts {
  readonly aliases: number;
}

/** Counts per table, keyed by the field names {@link TOMBSTONED_TABLES} declares. */
export interface TombstoneCounts {
  readonly pages: number;
  readonly chunks: number;
  readonly facts: number;
  readonly entities: number;
  readonly entityCards: number;
  readonly commitments: number;
  readonly attachments: number;
}

function noCounts(): Record<string, number> {
  return Object.fromEntries(TOMBSTONED_TABLES.map((entry) => [entry.field, 0]));
}

function noArchiveCounts(): Record<string, number> {
  return Object.fromEntries(ARCHIVED_TABLES.map((entry) => [entry.field, 0]));
}

export interface CascadeCounts {
  readonly pages: number;
  readonly chunks: number;
  readonly facts: number;
  readonly entities: number;
}

export interface ForgetReceipt {
  readonly ok: true;
  readonly id: string;
  /** The instant every row in this cascade carries. The undo key. */
  readonly deletedAt: string;
  readonly recoverableUntil: string;
  readonly cascade: CascadeCounts;
}

export type ForgetRefusal = 'not_found' | 'scope_denied';

export type ForgetOutcome = ForgetReceipt | { readonly ok: false; readonly reason: ForgetRefusal };

/**
 * Retract one record.
 *
 * Fenced exactly as the read of the same row is: a grant that cannot see a row
 * cannot retract it, and it learns the same thing it would have learned by
 * reading — `scope_denied` on a row it may not touch, `not_found` on one that is
 * not there.
 */
export async function forgetRecord(
  sql: SQL,
  request: { readonly id: OpaqueId; readonly grant: Grant; readonly now: Date },
): Promise<ForgetOutcome> {
  const at = request.now.toISOString();
  const grantLiteral = textArrayLiteral(request.grant);
  const permitted = await mayTouch(sql, request.grant, request.id);
  if (permitted !== 'ok') return { ok: false, reason: permitted };

  const cascade = await sql.begin(async (tx) => {
    switch (request.id.kind) {
      case 'chunk': {
        const chunks = await tombstone(
          tx,
          'UPDATE chunk SET deleted_at = $2::timestamptz WHERE chunk_id = $1::bigint AND deleted_at IS NULL',
          [request.id.key, at],
        );
        return { pages: 0, chunks, facts: 0, entities: 0 };
      }
      case 'doc': {
        const pages = await tombstone(
          tx,
          'UPDATE page SET deleted_at = $2::timestamptz WHERE page_id = $1::bigint AND deleted_at IS NULL',
          [request.id.key, at],
        );
        // The cascade carries the fence with it, and that is the whole of this
        // block's security content. `mayTouch` above authorised **the page** —
        // one scalar origin. Every row the cascade then reaches has an origin of
        // its own: a passage may carry a different one, and a fact is a synthesis
        // whose union the subset rule refuses to a credential holding only part
        // of it. Without these two predicates a work-scoped grant retracts a
        // cross-origin fact it is not permitted to *read*, by naming one of its
        // sources — a read refusal converted into a write, which is strictly
        // worse than the read it was refused.
        const chunks = await tombstone(
          tx,
          `UPDATE chunk SET deleted_at = $2::timestamptz
            WHERE page_id = $1::bigint
              AND deleted_at IS NULL
              AND origin_context = ANY($3::text[])`,
          [request.id.key, at, grantLiteral],
        );
        // Facts reach their page two ways — directly, and through the chunks
        // they were extracted from. Both, or a fact sourced from a retracted
        // document keeps answering questions about it.
        const facts = await tombstone(
          tx,
          `UPDATE fact SET deleted_at = $2::timestamptz
            WHERE deleted_at IS NULL
              AND origin_contexts <@ $3::text[]
              AND (page_id = $1::bigint
                   OR fact_id IN (SELECT fs.fact_id FROM fact_source fs
                                    JOIN chunk c ON c.chunk_id = fs.chunk_id
                                   WHERE c.page_id = $1::bigint))`,
          [request.id.key, at, grantLiteral],
        );
        return { pages, chunks, facts, entities: 0 };
      }
      case 'fact': {
        const facts = await tombstone(
          tx,
          'UPDATE fact SET deleted_at = $2::timestamptz WHERE fact_id = $1::bigint AND deleted_at IS NULL',
          [request.id.key, at],
        );
        return { pages: 0, chunks: 0, facts, entities: 0 };
      }
      case 'ent': {
        const entities = await tombstone(
          tx,
          'UPDATE entity SET deleted_at = $2::timestamptz WHERE entity_id = $1::bigint AND deleted_at IS NULL',
          [request.id.key, at],
        );
        return { pages: 0, chunks: 0, facts: 0, entities };
      }
    }
  });

  return {
    ok: true,
    id: formatId(request.id.kind, request.id.key),
    deletedAt: at,
    recoverableUntil: new Date(request.now.getTime() + FORGET_TTL_HOURS * 3600_000).toISOString(),
    cascade,
  };
}

/** The same three fence rules the read of this row would apply. */
async function mayTouch(sql: SQL, grant: Grant, id: OpaqueId): Promise<'ok' | ForgetRefusal> {
  switch (id.kind) {
    case 'chunk': {
      const rows = (await sql.unsafe('SELECT origin_context FROM chunk WHERE chunk_id = $1::bigint', [
        id.key,
      ])) as Array<{ origin_context: string }>;
      const row = rows[0];
      if (row === undefined) return 'not_found';
      return fenceScalar(row.origin_context, grant) ? 'ok' : 'scope_denied';
    }
    case 'doc': {
      const rows = (await sql.unsafe('SELECT origin_context FROM page WHERE page_id = $1::bigint', [
        id.key,
      ])) as Array<{ origin_context: string }>;
      const row = rows[0];
      if (row === undefined) return 'not_found';
      return fenceScalar(row.origin_context, grant) ? 'ok' : 'scope_denied';
    }
    case 'fact': {
      const rows = (await sql.unsafe('SELECT origin_contexts FROM fact WHERE fact_id = $1::bigint', [
        id.key,
      ])) as Array<{ origin_contexts: string[] }>;
      const row = rows[0];
      if (row === undefined) return 'not_found';
      return fenceRow(row.origin_contexts, grant) ? 'ok' : 'scope_denied';
    }
    case 'ent': {
      const rows = (await sql.unsafe('SELECT origin_contexts FROM entity WHERE entity_id = $1::bigint', [
        id.key,
      ])) as Array<{ origin_contexts: string[] }>;
      const row = rows[0];
      if (row === undefined) return 'not_found';
      return fenceEntity(row.origin_contexts, grant) ? 'ok' : 'scope_denied';
    }
  }
}

async function tombstone(tx: SQL, statement: string, params: readonly unknown[]): Promise<number> {
  const rows = (await tx.unsafe(`${statement} RETURNING 1 AS touched`, [...params])) as Array<{ touched: number }>;
  return rows.length;
}

export type RestoreOutcome =
  | {
      readonly ok: true;
      readonly restored: TombstoneCounts;
      /**
       * Rows moved back out of an archive — {@link ARCHIVED_TABLES}.
       *
       * Reported beside `restored` rather than folded into it because the two
       * are different operations: one clears a flag, the other re-inserts a row
       * into a table that may have moved on without it.
       */
      readonly unarchived: ArchiveCounts;
      /**
       * Aliases left archived because the spelling is live again for that entity.
       *
       * The archive vacates the slot — that is the point of it — so a
       * consolidation merge, a re-ingest, or the user re-connecting the account
       * can write the same `(entity_id, alias)` while the row is away. An
       * unguarded re-insert then raises `23505` on
       * `entity_alias_is_unique_per_entity` and takes the whole restore
       * transaction with it. The live spelling is the current one; the archived
       * row stays archived and the purge takes it at the TTL. What must not
       * happen is that being silent — the same rule `supersededCards` states one
       * table over.
       */
      readonly supersededAliases: number;
      /**
       * Cards left deleted because the entity has a live one again.
       *
       * `entity_card_one_live_per_entity` is a UNIQUE index over live cards and
       * `writeEntityCard` inserts under `ON CONFLICT (entity_id) WHERE
       * deleted_at IS NULL`, so a consolidation cycle can write a fresh card for
       * an entity whose previous card is tombstoned. An unguarded un-delete then
       * raises `23505` and takes the whole restore transaction — every other
       * table's rows with it. The newer card is the newer summary of the same
       * entity, so the stale one stays deleted; what must not happen is that
       * being silent, because a restore that quietly returns less than it
       * restored is the defect this function was fixed for.
       */
      readonly supersededCards: number;
    }
  | { readonly ok: false; readonly reason: 'ttl_expired' };

/**
 * Undo one retraction, by its instant.
 *
 * Refuses past the TTL rather than restoring what it can: after 72 hours the
 * purge may already have removed part of the cascade, and a partial restore that
 * reported success would put the brain in a state neither the user nor the
 * operator asked for. A typed refusal is the honest answer.
 */
export async function restoreForgotten(
  sql: SQL,
  request: { readonly deletedAt: string; readonly now: Date; readonly ttlHours?: number },
): Promise<RestoreOutcome> {
  const ttl = (request.ttlHours ?? FORGET_TTL_HOURS) * 3600_000;
  if (request.now.getTime() - Date.parse(request.deletedAt) > ttl) {
    return { ok: false, reason: 'ttl_expired' };
  }

  const outcome = await sql.begin(async (tx) => {
    const counts = noCounts();
    let blocked = 0;
    // **The same list the purge walks**, so a table cannot be tombstoned by one
    // of the three executors and reachable by only one of the two sweeps. Order
    // is irrelevant here — an `UPDATE … SET deleted_at = NULL` has no
    // referential order — and the list is walked in its declared order anyway so
    // there is one reading of it rather than two.
    for (const entry of TOMBSTONED_TABLES) {
      const restored = await touched(tx, entry, request.deletedAt);
      counts[entry.field] = restored;
      if (entry.restorableWhen !== undefined) {
        blocked += await tombstonedAt(tx, entry.table, request.deletedAt);
      }
    }

    // The second mechanism, walked from its own declaration for the same reason:
    // a row severance took by moving must be reachable by the same undo as the
    // rows it took by flagging, or the receipt's `archived` count is a promise
    // the undo does not keep.
    const archives = noArchiveCounts();
    let squatted = 0;
    for (const entry of ARCHIVED_TABLES) {
      const moved = await unarchived(tx, entry, request.deletedAt);
      archives[entry.field] = moved;
      squatted += await archivedAt(tx, entry.archive, request.deletedAt);
    }
    return { counts, blocked, archives, squatted };
  });

  return {
    ok: true,
    restored: outcome.counts as unknown as TombstoneCounts,
    unarchived: outcome.archives as unknown as ArchiveCounts,
    supersededAliases: outcome.squatted,
    supersededCards: outcome.blocked,
  };
}

/**
 * Move one archive's rows for this instant back into their live table.
 *
 * `INSERT … SELECT` then `DELETE`, in one transaction and in that order, so a
 * row blocked by {@link ArchivedTable.blockedWhen} stays in the archive for the
 * purge to take at the TTL rather than being deleted by an undo that could not
 * complete it. Identifiers and the guard predicate are module constants, never
 * input.
 */
async function unarchived(tx: SQL, entry: ArchivedTable, severedAt: string): Promise<number> {
  const columns = entry.columns.join(', ');
  const rows = (await tx.unsafe(
    `WITH restorable AS (
       SELECT ${entry.key}, ${columns} FROM ${entry.archive}
        WHERE severed_at = $1::timestamptz AND NOT (${entry.blockedWhen})
     ),
     put_back AS (
       INSERT INTO ${entry.live} (${columns})
       SELECT ${columns} FROM restorable
     )
     DELETE FROM ${entry.archive}
      WHERE ${entry.key} IN (SELECT ${entry.key} FROM restorable)
     RETURNING ${entry.key}`,
    [severedAt],
  )) as Array<Record<string, unknown>>;
  return rows.length;
}

/**
 * Rows still archived at this instant — **read after the un-archive, and it is
 * the answer rather than a term in one.**
 *
 * {@link unarchived} DELETEs every row it moved, so what still carries the
 * instant afterwards is exactly the set {@link ArchivedTable.blockedWhen}
 * refused. Subtracting the moved rows from this — which is what it used to do —
 * measures a denominator that has already had its numerator taken out of it, and
 * reports `residue − moved`: zero over a partly-squatted archive, and a negative
 * count over one where everything came back.
 */
async function archivedAt(tx: SQL, archive: string, severedAt: string): Promise<number> {
  const rows = (await tx.unsafe(
    `SELECT count(*)::int AS n FROM ${archive} WHERE severed_at = $1::timestamptz`,
    [severedAt],
  )) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

async function touched(tx: SQL, entry: TombstonedTable, deletedAt: string): Promise<number> {
  // Identifiers and the guard predicate are module constants, never input.
  const guard = entry.restorableWhen === undefined ? '' : ` AND ${entry.restorableWhen}`;
  const rows = (await tx.unsafe(
    `UPDATE ${entry.table} SET deleted_at = NULL
      WHERE deleted_at = $1::timestamptz${guard} RETURNING ${entry.key}`,
    [deletedAt],
  )) as Array<Record<string, unknown>>;
  return rows.length;
}

/**
 * Rows still carrying this instant — **read after the restore**, for the reason
 * {@link archivedAt} states: {@link touched} has already cleared the flag on
 * everything {@link TombstonedTable.restorableWhen} admitted, so the remainder
 * IS the blocked set and subtracting the restored rows from it under-reports by
 * exactly the number that came back.
 */
async function tombstonedAt(tx: SQL, table: string, deletedAt: string): Promise<number> {
  const rows = (await tx.unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE deleted_at = $1::timestamptz`,
    [deletedAt],
  )) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

/**
 * What a purge removed. A superset of {@link CascadeCounts}, because the purge
 * reaches two tables no single `forget` cascade writes to.
 */
export interface PurgeCounts extends TombstoneCounts {
  /** Rows hard-deleted out of {@link ARCHIVED_TABLES}, by their `severed_at`. */
  readonly aliases: number;
}

/**
 * Hard-delete every tombstone past the TTL.
 *
 * Ordered, and the order is the whole of the FK story:
 *
 *   1. clear `superseded_by` pointers into the doomed set, because that FK has
 *      no `ON DELETE` action and would otherwise refuse the delete;
 *   2. commitments and attachments, **by their own `deleted_at`** (see below);
 *   3. facts, whose `fact_source` rows cascade with them;
 *   4. chunks;
 *   5. pages, which cascade to any chunk or fact still referencing them;
 *   6. entities, whose slugs, aliases and cards cascade;
 *   7. the archives ({@link ARCHIVED_TABLES}), by their own `severed_at` — last,
 *      so an archived alias whose entity step 6 already took is counted as that
 *      cascade's rather than as this step's.
 *
 * **Why steps 2 exists rather than being left to the cascades.** A commitment
 * cascades from its fact and its page, and an attachment from its page — so for
 * most rows the later steps would take them anyway. Not for all of them:
 * extraction writes a commitment with a NULL `page_id` *and* a NULL `fact_id`
 * whenever it could not attribute one, and U17's subject erasure tombstones an
 * attachment whose OCR text names a correspondent while the page it hangs off
 * stays live. Neither has a parent to cascade from, so without this step a row
 * the product told a user was deleted sits in the brain in plaintext for its
 * whole life. Tombstoning is a promise about a 72-hour window; a table the purge
 * does not reach makes that promise false rather than slow.
 *
 * A caller runs this on a schedule (U10's job types are fixed at U10, so the
 * scheduled binding lands with the unit that owns the queue); it is exported as
 * a function so the TTL is testable without one.
 */
export async function purgeExpiredTombstones(
  sql: SQL,
  request: { readonly now: Date; readonly ttlHours?: number },
): Promise<PurgeCounts> {
  const cutoff = new Date(request.now.getTime() - (request.ttlHours ?? FORGET_TTL_HOURS) * 3600_000).toISOString();

  return sql.begin(async (tx) => {
    await tx.unsafe(
      `UPDATE fact SET superseded_by = NULL
        WHERE superseded_by IN (SELECT fact_id FROM fact WHERE deleted_at IS NOT NULL AND deleted_at <= $1::timestamptz)`,
      [cutoff],
    );

    // In the list's declared order, which IS the FK order — see
    // {@link TOMBSTONED_TABLES}. Walking the same list the restore walks is what
    // makes "what tombstoning reaches, both sweeps reach" a property of one
    // declaration rather than of two functions agreeing.
    const counts = noCounts();
    for (const entry of TOMBSTONED_TABLES) {
      counts[entry.field] = await deleted(tx, entry.table, entry.key, cutoff);
    }

    // The archives, on the same cutoff and after the tables they hang off, so an
    // archive row whose entity the loop above already took is counted as the
    // cascade's rather than raising on a row that is no longer there.
    for (const entry of ARCHIVED_TABLES) {
      const rows = (await tx.unsafe(
        `DELETE FROM ${entry.archive} WHERE severed_at <= $1::timestamptz RETURNING ${entry.key}`,
        [cutoff],
      )) as Array<Record<string, unknown>>;
      counts[entry.field] = rows.length;
    }
    return counts as unknown as PurgeCounts;
  });
}

async function deleted(tx: SQL, table: string, key: string, cutoff: string): Promise<number> {
  const rows = (await tx.unsafe(
    `DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at <= $1::timestamptz RETURNING ${key}`,
    [cutoff],
  )) as Array<Record<string, unknown>>;
  return rows.length;
}
