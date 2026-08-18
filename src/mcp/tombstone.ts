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

/**
 * How long past the TTL a tombstone waits before the purge may take it.
 *
 * **The overlap this closes was a single instant wide and is now a day wide.**
 * {@link restoreForgotten} admits a retraction while `now − deletedAt <= ttl`;
 * the purge takes rows where `deleted_at <= now − ttl`. At exact equality both
 * admit the same rows, and READ COMMITTED plus a shared row-lock order was the
 * only thing keeping them apart — an accident of both functions walking
 * {@link TOMBSTONED_TABLES} in the same order inside one transaction each.
 *
 * The purge is no longer one transaction (see {@link purgeExpiredTombstones}),
 * so that accident is gone: a restore landing between two committed batches
 * produces exactly the half-restored brain `restoreForgotten` refuses to
 * produce. A grace band is the fix that survives batching, needs no lock, and
 * costs one constant — for a restore to reach a row a purge is eligible to take,
 * the two calls would have to be a *day* apart in wall clock while overlapping
 * in execution.
 *
 * **What it does not change.** The recovery window the product promises is still
 * {@link FORGET_TTL_HOURS}: a user is told `recoverableUntil = now + 72h` and
 * that is still exactly when an undo stops being admitted. What moves is the
 * far edge — a row that is no longer restorable is not yet gone, for one day.
 * Retaining a retracted row slightly longer is the direction to be wrong in;
 * deleting one somebody is mid-restore of is not.
 */
export const PURGE_GRACE_HOURS = 24;

/**
 * The retention window, validated. **Throws rather than returning a default.**
 *
 * `(request.ttlHours ?? FORGET_TTL_HOURS)` was the whole of the old arithmetic,
 * and `??` falls back only on `null` and `undefined`. So `ttlHours: 0` passed
 * through and collapsed the window to zero — a purge that hard-deletes
 * tombstones written seconds earlier, against the `recoverableUntil` the receipt
 * had already promised. `Number('')` is `0`, so a configuration value that
 * failed to parse arrived looking exactly like a deliberate choice. A negative
 * value is worse: it moves the cutoff into the future, so the purge takes rows
 * that have not been retracted long enough to be past anything.
 *
 * **A refusal rather than a clamp**, because every one of these inputs means the
 * caller does not know what window it is asking for, and silently substituting
 * 72 hours for a `0` somebody typed hides the misconfiguration until the day it
 * matters. `NaN` used to fail closed by accident — every comparison against it
 * is false — and an accident is not a guard.
 */
export function retentionHoursOf(ttlHours: number | undefined): number {
  if (ttlHours === undefined) return FORGET_TTL_HOURS;
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) {
    // The value is a number the caller supplied, never a word a user wrote, so
    // naming it is safe and is the only thing that makes the misconfiguration
    // findable.
    throw new Error(
      `invalid retention window: ttlHours must be a positive finite number of hours, got ${String(ttlHours)}`,
    );
  }
  return ttlHours;
}

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
  // Validated before the transaction opens, and validated here as well as in the
  // purge because the two read the same parameter to answer opposite questions:
  // a zero here refuses every undo and reports the TTL as the reason.
  const ttl = retentionHoursOf(request.ttlHours) * 3600_000;
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
 * Rows the purge removes that **were never retracted**, taken by a foreign key
 * rather than by a predicate.
 *
 * ============================================================================
 * WHY THIS TYPE HAD TO EXIST BEFORE THE PURGE COULD RUN FOR REAL
 * ============================================================================
 *
 * Every count on {@link PurgeCounts} is `rows.length` from that statement's own
 * `RETURNING`. Rows removed by cascade are counted by nobody — and the cascade
 * set is not a rounding error, because it contains **live rows**:
 * `chunk`, `fact`, `attachment` and `commitment` all cascade from `page`, and
 * both retraction executors deliberately take a parent whole while fencing its
 * children on origin. `forgetRecord`'s `doc` case tombstones the page
 * unconditionally and its facts only where the grant covers them; `severOrigin`
 * does the same. So a receipt reading `chunks: 4` could sit above a statement
 * that had just cascaded nine hundred live passages out through `DELETE FROM
 * page`, and nothing anywhere would say so.
 *
 * A first production run meets an entire accumulated backlog at once and cannot
 * be undone. "Countable before it is trusted" is the whole reason
 * {@link previewTombstonePurge} exists, and a preview that reported only the
 * nine direct predicates would have been the same lie, computed in advance.
 *
 * **The depth is one hop from the two roots, stated rather than implied.** These
 * are the rows a person would recognise — passages, facts, attachments,
 * commitments, entity cards, archived aliases — plus the page snapshots that
 * survive as orphans. What is removed and NOT counted here is the machinery one
 * hop further out: `fact_source`, `contradiction_report`, `cluster_member`,
 * `entity_slug`, `entity_alias`, `entity_edge`. Counting those would mean
 * materialising a transitive closure per batch for rows that are derived
 * indices rather than anything a user wrote.
 */
export interface PurgeCascadeCounts {
  /** Live passages on a retracted page. */
  readonly chunks: number;
  /** Live facts on a retracted page — the cross-origin ones left live on purpose. */
  readonly facts: number;
  readonly attachments: number;
  /** Live commitments whose page or whose fact is going. */
  readonly commitments: number;
  /** Live cards on a retracted entity. */
  readonly entityCards: number;
  /** Archived aliases whose entity is going, whatever their own `severed_at`. */
  readonly aliases: number;
  /**
   * `page_version` rows about to lose their `page_id`, **not** rows about to be
   * deleted.
   *
   * `page_version_page_fkey` is `ON DELETE SET NULL` deliberately, so history
   * outlives the purge. The consequence is the disclosure that most needs to be
   * on a consent screen and is easiest to leave off one: a `page_version` holds
   * the page's **full verbatim body**, so the purge hard-deletes a document and
   * leaves a complete second copy of its text standing. `forget` is not content
   * removal for any document that was ever snapshotted; `eraseSubject` is the
   * function that reaches those rows. This number is how many of them a run
   * would leave behind.
   */
  readonly pageVersionsOrphaned: number;
}

/**
 * How much one invocation may take. Every field is a ceiling, and every ceiling
 * is clamped by {@link resolvePurgeBudget} — a caller cannot ask for more.
 */
export interface PurgeBudget {
  /**
   * How many rows of any one table one batch may claim directly.
   *
   * It bounds **roots**, not rows: a retracted page takes its passages, facts,
   * attachments and commitments with it whatever this says, because that is what
   * `ON DELETE CASCADE` means and bounding it would mean committing a parent
   * whose children are still there — which the foreign keys refuse.
   */
  readonly rowsPerBatch?: number;
  /** How many batches — that is, how many transactions — one invocation runs. */
  readonly maxBatches?: number;
}

/**
 * The defaults, and they are deliberately small.
 *
 * This has never run in production, so its first sweep meets an entire
 * accumulated backlog at once and irreversibly. A first run that takes two
 * thousand roots and stops, reports what it took and says it is not finished, is
 * a run somebody can read before the next one. A first run that takes everything
 * is a decision nobody got to make.
 */
export const PURGE_ROWS_PER_BATCH = 200;
export const PURGE_MAX_BATCHES = 10;

/**
 * The ceilings a caller cannot raise, which is the difference between a default
 * and a bound.
 *
 * A budget is an argument, and an argument arrives from somewhere — a handler
 * that read a column, a test, a future operator surface. `Infinity`,
 * `Number('1e9')` and a typo with an extra zero are all ordinary things for a
 * number to be, and the failure mode of honouring one is a single transaction
 * holding row locks on every table in the brain for as long as it takes. So the
 * knob is clamped rather than trusted, and the clamp is a module constant rather
 * than a parameter, so there is no argument that widens it.
 */
export const PURGE_ROWS_PER_BATCH_CEILING = 2_000;
export const PURGE_MAX_BATCHES_CEILING = 50;

export interface ResolvedPurgeBudget {
  readonly rowsPerBatch: number;
  readonly maxBatches: number;
}

/**
 * Clamp, do not refuse — the opposite direction from {@link retentionHoursOf},
 * and the two differ because the failures differ.
 *
 * A retention window that is not a window means the caller does not know what it
 * is asking for, and substituting a default would hide that. A budget that is
 * too large means the caller wants *as much as possible*, which is a coherent
 * ask with a correct answer: the maximum. Refusing it would only produce a
 * second call with a smaller number.
 *
 * **`Infinity` and `NaN` are not the same input and do not get the same answer.**
 * `Infinity` is "no limit", which this function is entitled to read as "the
 * limit"; `NaN` is the absence of an opinion, which is what `undefined` already
 * means. Collapsing the two — the obvious `!Number.isFinite` guard — would
 * quietly hand the *default* to a caller who explicitly asked for everything,
 * which is a different run than either party expected.
 */
export function resolvePurgeBudget(budget: PurgeBudget | undefined): ResolvedPurgeBudget {
  return {
    rowsPerBatch: clamp(budget?.rowsPerBatch, PURGE_ROWS_PER_BATCH, PURGE_ROWS_PER_BATCH_CEILING),
    maxBatches: clamp(budget?.maxBatches, PURGE_MAX_BATCHES, PURGE_MAX_BATCHES_CEILING),
  };
}

function clamp(asked: number | undefined, fallback: number, ceiling: number): number {
  if (asked === undefined || Number.isNaN(asked)) return fallback;
  // `Math.floor(Infinity)` is `Infinity` and `Math.min` then answers the ceiling;
  // `-Infinity` and `0` both floor into the `Math.max(1, …)` arm, because a
  // zero-row batch is a run that reports "not finished" forever while doing no
  // work at all.
  return Math.min(Math.max(1, Math.floor(asked)), ceiling);
}

export interface PurgeRunResult {
  /** The instant a row must have been retracted at or before to be taken. */
  readonly cutoff: string;
  readonly counts: PurgeCounts;
  readonly cascaded: PurgeCascadeCounts;
  /** Transactions committed. Each is a durable step a killed run resumes after. */
  readonly batches: number;
  /**
   * `false` means the budget ran out with work still expired and waiting, which
   * is the ordinary outcome of a first run against a real backlog. Carried on
   * the result rather than inferred from the counts, because "took exactly the
   * ceiling" and "took the ceiling and there is more" are different facts and a
   * caller deciding whether to come back needs the second one.
   */
  readonly exhausted: boolean;
  readonly budget: ResolvedPurgeBudget;
}

/**
 * What a purge would remove, computed without removing it.
 *
 * **A separate function rather than a `dryRun: boolean`**, which is the pattern
 * this repo already settled on for "show the user what they are agreeing to":
 * `previewForget`, `previewSeverance` and `previewSubjectErasure` are each their
 * own entry point returning a counts struct the destructive call mirrors. A flag
 * would put a branch inside a transaction whose statement *ordering* is the
 * correctness argument, which is the one place a branch must not be.
 *
 * **Two count sets, and the second is the one that is not obvious.**
 * `tombstoned` is the nine direct predicates. `cascaded` is what the foreign
 * keys take alongside them, including rows that were never retracted — see
 * {@link PurgeCascadeCounts}. A preview reporting only the first would be the
 * receipt's own blind spot, computed in advance and presented as reassurance.
 *
 * Every predicate here is the predicate the purge uses, spelled once in
 * {@link EXPIRED} / {@link DOOMED_PAGE} / {@link DOOMED_ENTITY} and read by both,
 * so the preview and the run cannot describe different events.
 * `test/core/lifecycle/purge-preview-agreement.test.ts` runs one then the other
 * and asserts the two agree.
 */
export interface PurgePreview {
  readonly cutoff: string;
  readonly tombstoned: PurgeCounts;
  readonly cascaded: PurgeCascadeCounts;
}

/** A row this sweep is eligible to take, in the spelling both halves use. */
const EXPIRED = (alias: string): string =>
  `(${alias}.deleted_at IS NOT NULL AND ${alias}.deleted_at <= $1::timestamptz)`;

/** The page a row hangs off is going. */
const DOOMED_PAGE = (column: string): string =>
  `EXISTS (SELECT 1 FROM page dp WHERE dp.page_id = ${column} AND ${EXPIRED('dp')})`;

/** The entity a row hangs off is going. */
const DOOMED_ENTITY = (column: string): string =>
  `EXISTS (SELECT 1 FROM entity de WHERE de.entity_id = ${column} AND ${EXPIRED('de')})`;

/**
 * The fact set a purge removes: every expired fact, **plus every fact on a
 * retracted page whether it was retracted or not**.
 *
 * The second arm is the one whose absence would abort the first real run.
 * `fact_page_fkey` is `ON DELETE CASCADE`, so `DELETE FROM page` takes a live
 * fact with it; `fact_superseded_fkey` has no `ON DELETE` action at all. A live
 * fact C on a page that is staying, pointing `superseded_by` at a live fact D on
 * a page that is going, is therefore a `23503` on the page delete — and because
 * the sweep is a transaction, the violation rolls the whole thing back, for
 * every tenant, on every run, forever. That is precisely the failure the module
 * header names ("a purge that always raises is a 72-hour TTL that is silently
 * forever") arriving through the one door the original clear did not cover: it
 * nulled pointers into *tombstoned* facts only, and D is not tombstoned.
 *
 * It is reachable by design rather than by accident. `forgetRecord`'s `doc` case
 * tombstones the page unconditionally and its facts only where the grant covers
 * their origins; `severOrigin` does the same. A cross-origin fact on a retracted
 * page is deliberately left live — and it is exactly D.
 */
const DOOMED_FACT = 'df';
const DOOMED_FACT_SET = `SELECT ${DOOMED_FACT}.fact_id FROM fact ${DOOMED_FACT} WHERE ${EXPIRED(DOOMED_FACT)} OR ${DOOMED_PAGE(`${DOOMED_FACT}.page_id`)}`;

export async function previewTombstonePurge(
  sql: SQL,
  request: { readonly now: Date; readonly ttlHours?: number },
): Promise<PurgePreview> {
  const cutoff = purgeCutoff(request);

  const rows = (await sql.unsafe(
    `SELECT
       (SELECT count(*)::int FROM commitment t WHERE ${EXPIRED('t')}) AS commitments,
       (SELECT count(*)::int FROM attachment t WHERE ${EXPIRED('t')}) AS attachments,
       (SELECT count(*)::int FROM entity_card t WHERE ${EXPIRED('t')}) AS entity_cards,
       (SELECT count(*)::int FROM fact t WHERE ${EXPIRED('t')}) AS facts,
       (SELECT count(*)::int FROM chunk t WHERE ${EXPIRED('t')}) AS chunks,
       (SELECT count(*)::int FROM page t WHERE ${EXPIRED('t')}) AS pages,
       (SELECT count(*)::int FROM entity t WHERE ${EXPIRED('t')}) AS entities,
       -- The archive is swept last, so an alias whose entity is going has
       -- already been taken by that cascade and is counted there, not here.
       (SELECT count(*)::int FROM severed_alias t
         WHERE t.severed_at <= $1::timestamptz AND NOT ${DOOMED_ENTITY('t.entity_id')}) AS aliases,

       (SELECT count(*)::int FROM chunk t
         WHERE NOT ${EXPIRED('t')} AND ${DOOMED_PAGE('t.page_id')}) AS cascade_chunks,
       (SELECT count(*)::int FROM fact t
         WHERE NOT ${EXPIRED('t')} AND ${DOOMED_PAGE('t.page_id')}) AS cascade_facts,
       (SELECT count(*)::int FROM attachment t
         WHERE NOT ${EXPIRED('t')} AND ${DOOMED_PAGE('t.page_id')}) AS cascade_attachments,
       (SELECT count(*)::int FROM commitment t
         WHERE NOT ${EXPIRED('t')}
           AND (${DOOMED_PAGE('t.page_id')} OR t.fact_id IN (${DOOMED_FACT_SET}))) AS cascade_commitments,
       (SELECT count(*)::int FROM entity_card t
         WHERE NOT ${EXPIRED('t')} AND ${DOOMED_ENTITY('t.entity_id')}) AS cascade_entity_cards,
       (SELECT count(*)::int FROM severed_alias t
         WHERE ${DOOMED_ENTITY('t.entity_id')}) AS cascade_aliases,
       (SELECT count(*)::int FROM page_version t
         WHERE ${DOOMED_PAGE('t.page_id')}) AS page_versions_orphaned`,
    [cutoff],
  )) as Array<Record<string, number>>;

  const row = rows[0] ?? {};
  return {
    cutoff,
    tombstoned: {
      pages: n(row['pages']),
      chunks: n(row['chunks']),
      facts: n(row['facts']),
      entities: n(row['entities']),
      entityCards: n(row['entity_cards']),
      commitments: n(row['commitments']),
      attachments: n(row['attachments']),
      aliases: n(row['aliases']),
    },
    cascaded: {
      chunks: n(row['cascade_chunks']),
      facts: n(row['cascade_facts']),
      attachments: n(row['cascade_attachments']),
      commitments: n(row['cascade_commitments']),
      entityCards: n(row['cascade_entity_cards']),
      aliases: n(row['cascade_aliases']),
      pageVersionsOrphaned: n(row['page_versions_orphaned']),
    },
  };
}

/**
 * Hard-delete every tombstone past the TTL, in bounded, resumable batches.
 *
 * ============================================================================
 * THE ORDER IS THE CORRECTNESS ARGUMENT, AND BATCHING MUST NOT TOUCH IT
 * ============================================================================
 *
 * Within one batch the statements run in {@link TOMBSTONED_TABLES}' declared
 * order, which is FK order:
 *
 *   0. clear `superseded_by` pointers into the doomed fact set, because that FK
 *      has no `ON DELETE` action and would otherwise refuse the delete;
 *   1. commitments and attachments, **by their own `deleted_at`** (see below);
 *   2. entity cards;
 *   3. facts, whose `fact_source` rows cascade with them;
 *   4. chunks;
 *   5. pages, which cascade to any chunk, fact, attachment or commitment still
 *      referencing them;
 *   6. entities, whose slugs, aliases, edges and cards cascade;
 *   7. the archives ({@link ARCHIVED_TABLES}), by their own `severed_at` — last,
 *      so an archived alias whose entity step 6 already took is counted as that
 *      cascade's rather than as this step's.
 *
 * **Why a per-statement `LIMIT` would have broken it, and why this does not.**
 * A cap applied to each statement independently makes successive statements'
 * row sets *incoherent with each other*: cap `fact` but not the `superseded_by`
 * clear and the next run raises; cap `page` but not `chunk` and parents and
 * children desynchronise. Batching by a claimed **id set** keeps every statement
 * derived from the same set, so coherence is preserved by construction rather
 * than by every statement remembering the same number.
 *
 * Each batch therefore claims ids first — `FOR UPDATE`, so two workers racing
 * one tenant cannot pick the same roots — and then every delete names that
 * claim. The claims are ordered (`deleted_at`, then the key), which is what buys
 * resumability: each committed batch is a durable step, the cutoff predicate is
 * idempotent so a row already taken no longer matches, and a killed run resumes
 * with no state to carry.
 *
 * **The trap that is sharpest and least visible: the pointer clear must be
 * batch-scoped too.** Left global while the deletes are batched, it durably
 * nulls a live fact's pointer to a fact that a later batch has not taken yet —
 * and if the run dies in between, that pointer is lost against a row that still
 * exists. Scoped to the batch, an aborted run has only nulled pointers into rows
 * it already deleted, which is correct rather than lossy.
 *
 * **The roots are pages and entities; everything else is claimed on its own
 * too.** Bounding by page alone would leave four classes unbounded because they
 * are reachable from no page: a `fact` with a NULL `page_id`, an `entity`, an
 * `entity_card` severance took while its entity stayed, and the parentless
 * `commitment`/`attachment` the paragraph below is about. So each table claims
 * its own expired rows up to the budget **and** takes every expired row hanging
 * off this batch's pages or entities — the second arm keeps the counts honest,
 * since those rows are going regardless and would otherwise be reported as
 * cascade in one run and as direct in another.
 *
 * **Why steps 1 and 2 exist rather than being left to the cascades.** A
 * commitment cascades from its fact and its page, and an attachment from its
 * page — so for most rows the later steps would take them anyway. Not for all of
 * them: extraction writes a commitment with a NULL `page_id` *and* a NULL
 * `fact_id` whenever it could not attribute one, and U17's subject erasure
 * tombstones an attachment whose OCR text names a correspondent while the page
 * it hangs off stays live. Neither has a parent to cascade from, so without
 * these steps a row the product told a user was deleted sits in the brain in
 * plaintext for its whole life. Tombstoning is a promise about a 72-hour window;
 * a table the purge does not reach makes that promise false rather than slow.
 *
 * The scheduled caller is `src/worker/purge.ts`. It is still exported as a
 * function so the window is testable without a queue.
 */
export async function purgeExpiredTombstones(
  sql: SQL,
  request: {
    readonly now: Date;
    readonly ttlHours?: number;
    readonly budget?: PurgeBudget;
  },
): Promise<PurgeRunResult> {
  const cutoff = purgeCutoff(request);
  const budget = resolvePurgeBudget(request.budget);

  const counts = noCounts();
  const cascaded: Record<string, number> = {
    chunks: 0,
    facts: 0,
    attachments: 0,
    commitments: 0,
    entityCards: 0,
    aliases: 0,
    pageVersionsOrphaned: 0,
  };

  let batches = 0;
  let exhausted = false;

  while (batches < budget.maxBatches) {
    // One transaction per batch. The commit is what makes the batch a durable
    // step; the alternative — one transaction for the whole run — is the long
    // lock hold this change exists to end.
    const batch = await sql.begin((tx) => runPurgeBatch(tx as SQL, cutoff, budget.rowsPerBatch));
    batches += 1;
    for (const [field, value] of Object.entries(batch.counts)) {
      counts[field] = (counts[field] ?? 0) + value;
    }
    for (const [field, value] of Object.entries(batch.cascaded)) {
      cascaded[field] = (cascaded[field] ?? 0) + value;
    }
    if (batch.claimed === 0) {
      // Nothing was expired and waiting, so the backlog is gone rather than the
      // budget. This is the batch that proves it and it did no work.
      exhausted = true;
      break;
    }
  }

  return {
    cutoff,
    counts: counts as unknown as PurgeCounts,
    cascaded: cascaded as unknown as PurgeCascadeCounts,
    batches,
    exhausted,
    budget,
  };
}

/**
 * The cutoff both halves compute, in one place.
 *
 * The grace band is here rather than at the call sites for the reason
 * {@link PURGE_GRACE_HOURS} states, and it is applied to the preview as well —
 * a preview that described a wider set than the run would take is a preview that
 * asks somebody to consent to more than happens.
 */
function purgeCutoff(request: { readonly now: Date; readonly ttlHours?: number }): string {
  const hours = retentionHoursOf(request.ttlHours) + PURGE_GRACE_HOURS;
  return new Date(request.now.getTime() - hours * 3600_000).toISOString();
}

interface PurgeBatchResult {
  readonly counts: Record<string, number>;
  readonly cascaded: Record<string, number>;
  /** Rows this batch claimed directly. Zero means the backlog is empty. */
  readonly claimed: number;
}

async function runPurgeBatch(tx: SQL, cutoff: string, rowsPerBatch: number): Promise<PurgeBatchResult> {
  // ---- Claims. Every one of them ordered and bounded, and every delete below
  // names one. `FOR UPDATE` so two workers on one tenant cannot claim the same
  // roots and then block each other mid-cascade.
  const pages = await claim(tx, 'page', 'page_id', cutoff, rowsPerBatch);
  const entities = await claim(tx, 'entity', 'entity_id', cutoff, rowsPerBatch);
  const facts = await claim(tx, 'fact', 'fact_id', cutoff, rowsPerBatch);
  const chunks = await claim(tx, 'chunk', 'chunk_id', cutoff, rowsPerBatch);
  const commitments = await claim(tx, 'commitment', 'commitment_id', cutoff, rowsPerBatch);
  const attachments = await claim(tx, 'attachment', 'attachment_id', cutoff, rowsPerBatch);
  const cards = await claim(tx, 'entity_card', 'card_id', cutoff, rowsPerBatch);
  // The archive's own claim excludes anything whose entity is expired anywhere in
  // the brain — not merely in this batch. An alias whose entity lands in a later
  // batch is taken by that entity's cascade, and claiming it here would count the
  // same row as direct in one run and as cascade in another.
  const aliases = await claimIds(
    tx,
    `SELECT t.severed_alias_id::text AS id FROM severed_alias t
      WHERE t.severed_at <= $1::timestamptz AND NOT ${DOOMED_ENTITY('t.entity_id')}
      ORDER BY t.severed_at, t.severed_alias_id
      LIMIT ${literalLimit(rowsPerBatch)}
      FOR UPDATE`,
    [cutoff],
  );

  const claimed =
    pages.length +
    entities.length +
    facts.length +
    chunks.length +
    commitments.length +
    attachments.length +
    cards.length +
    aliases.length;

  const counts = noCounts();
  const cascaded: Record<string, number> = {
    chunks: 0,
    facts: 0,
    attachments: 0,
    commitments: 0,
    entityCards: 0,
    aliases: 0,
    pageVersionsOrphaned: 0,
  };
  if (claimed === 0) return { counts, cascaded, claimed };

  // ---- What the foreign keys will take alongside the claim, counted BEFORE any
  // delete runs. Every one of these predicates selects rows that are NOT expired,
  // and nothing in the sequence below removes a live row until its parent goes —
  // so reading them up front is exact, and reading them afterwards would be
  // reading an empty table.
  const cascadeRows = (await tx.unsafe(
    `SELECT
       (SELECT count(*)::int FROM chunk t
         WHERE t.page_id = ANY($2::bigint[]) AND NOT ${EXPIRED('t')}) AS chunks,
       (SELECT count(*)::int FROM fact t
         WHERE t.page_id = ANY($2::bigint[]) AND NOT ${EXPIRED('t')}) AS facts,
       (SELECT count(*)::int FROM attachment t
         WHERE t.page_id = ANY($2::bigint[]) AND NOT ${EXPIRED('t')}) AS attachments,
       (SELECT count(*)::int FROM commitment t
         WHERE NOT ${EXPIRED('t')}
           AND (t.page_id = ANY($2::bigint[])
                OR t.fact_id IN (SELECT f.fact_id FROM fact f
                                  WHERE f.fact_id = ANY($3::bigint[]) OR f.page_id = ANY($2::bigint[])))) AS commitments,
       (SELECT count(*)::int FROM entity_card t
         WHERE t.entity_id = ANY($4::bigint[]) AND NOT ${EXPIRED('t')}) AS entity_cards,
       (SELECT count(*)::int FROM severed_alias t
         WHERE t.entity_id = ANY($4::bigint[])) AS aliases,
       (SELECT count(*)::int FROM page_version t
         WHERE t.page_id = ANY($2::bigint[])) AS page_versions_orphaned`,
    [cutoff, idArray(pages), idArray(facts), idArray(entities)],
  )) as Array<Record<string, number>>;
  const seen = cascadeRows[0] ?? {};
  cascaded['chunks'] = n(seen['chunks']);
  cascaded['facts'] = n(seen['facts']);
  cascaded['attachments'] = n(seen['attachments']);
  cascaded['commitments'] = n(seen['commitments']);
  cascaded['entityCards'] = n(seen['entity_cards']);
  cascaded['aliases'] = n(seen['aliases']);
  cascaded['pageVersionsOrphaned'] = n(seen['page_versions_orphaned']);

  // ---- Step 0. The pointer clear, scoped to exactly the facts this batch
  // removes — its own claim plus every fact riding a claimed page out through
  // `fact_page_fkey`, retracted or not. See {@link DOOMED_FACT_SET}.
  await tx.unsafe(
    `UPDATE fact SET superseded_by = NULL
      WHERE superseded_by IN (
        SELECT f.fact_id FROM fact f
         WHERE f.fact_id = ANY($1::bigint[]) OR f.page_id = ANY($2::bigint[]))`,
    [idArray(facts), idArray(pages)],
  );

  // ---- Steps 1-6, in TOMBSTONED_TABLES' declared order, which IS the FK order.
  // Walking the same list the restore walks is what makes "what tombstoning
  // reaches, both sweeps reach" a property of one declaration rather than of two
  // functions agreeing.
  const claims: Record<string, readonly string[]> = {
    commitment: commitments,
    attachment: attachments,
    entity_card: cards,
    fact: facts,
    chunk: chunks,
    page: pages,
    entity: entities,
  };
  for (const entry of TOMBSTONED_TABLES) {
    counts[entry.field] = await deleteClaimed(tx, entry, claims[entry.table] ?? [], {
      pages,
      entities,
      facts,
      cutoff,
    });
  }

  // ---- Step 7. The archives, after the tables they hang off.
  for (const entry of ARCHIVED_TABLES) {
    const rows = (await tx.unsafe(
      `DELETE FROM ${entry.archive} WHERE ${entry.key} = ANY($1::bigint[]) RETURNING ${entry.key}`,
      [idArray(aliases)],
    )) as Array<Record<string, unknown>>;
    counts[entry.field] = rows.length;
  }

  return { counts, cascaded, claimed };
}

/**
 * One table's delete: its own claim, **plus** every expired row hanging off this
 * batch's pages or entities.
 *
 * The second arm is not an optimisation. Those rows are removed by the cascade
 * whatever this statement does; what it decides is whether they are *counted* —
 * and a row that is reported as direct when its page happens to share a batch
 * and as an uncounted cascade when it does not is a receipt whose numbers depend
 * on the budget. The preview computes the same partition (every expired row is
 * direct, every live one is cascade), so this is also what makes the two agree.
 *
 * `page` and `entity` are the roots and take only their own claim; the
 * identifiers and the column names are module constants, never input.
 */
async function deleteClaimed(
  tx: SQL,
  entry: TombstonedTable,
  ids: readonly string[],
  batch: {
    readonly pages: readonly string[];
    readonly entities: readonly string[];
    readonly facts: readonly string[];
    readonly cutoff: string;
  },
): Promise<number> {
  const { pages, entities, cutoff } = batch;
  if (entry.table === 'page' || entry.table === 'entity') {
    const rows = (await tx.unsafe(
      `DELETE FROM ${entry.table} WHERE ${entry.key} = ANY($1::bigint[]) RETURNING ${entry.key}`,
      [idArray(ids)],
    )) as Array<Record<string, unknown>>;
    return rows.length;
  }

  // The parameter list is built alongside the predicate rather than passed whole.
  // Postgres refuses a prepared statement carrying a placeholder no expression
  // references — `42P18, could not determine data type of parameter $4` — so a
  // fixed four-argument call is a runtime error for every table that needs three
  // of them.
  const params: unknown[] = [cutoff, idArray(ids)];
  const reachable: string[] = [`${entry.key} = ANY($2::bigint[])`];

  if (
    entry.table === 'chunk' ||
    entry.table === 'fact' ||
    entry.table === 'attachment' ||
    entry.table === 'commitment'
  ) {
    params.push(idArray(pages));
    const claimedPages = `$${params.length}::bigint[]`;
    reachable.push(`page_id = ANY(${claimedPages})`);
    if (entry.table === 'commitment') {
      // **`commitment` is the only table with two parents, and the second one is
      // where the count leaks.** It cascades from its fact as well as from its
      // page, so the arm has to be the batch's whole doomed-fact set — the same
      // one step 0 nulls pointers into and the same one the cascade count reads.
      // A narrower arm (facts that are themselves expired, or facts on claimed
      // pages only) leaves two shapes deleted-but-uncounted: an expired
      // commitment on a **live** fact riding a claimed page out, and an expired
      // commitment on an expired orphan fact this batch claimed when the
      // commitment's own claim was already full. Both were retracted, so the
      // preview counts them; a receipt that did not is the "countable before it
      // is trusted" property failing in exactly the multi-batch case it exists
      // for. The expiry filter stays on the *commitment* (`EXPIRED(t)` below),
      // never on the fact.
      params.push(idArray(batch.facts));
      reachable.push(
        `fact_id IN (SELECT f.fact_id FROM fact f
                      WHERE f.fact_id = ANY($${params.length}::bigint[])
                         OR f.page_id = ANY(${claimedPages}))`,
      );
    }
  }
  if (entry.table === 'entity_card') {
    params.push(idArray(entities));
    reachable.push(`entity_id = ANY($${params.length}::bigint[])`);
  }

  const rows = (await tx.unsafe(
    `DELETE FROM ${entry.table} t
      WHERE ${EXPIRED('t')} AND (${reachable.join(' OR ')})
      RETURNING ${entry.key}`,
    params,
  )) as Array<Record<string, unknown>>;
  return rows.length;
}

/** One table's expired rows, ordered and bounded. The order is the resume key. */
function claim(
  tx: SQL,
  table: string,
  key: string,
  cutoff: string,
  rowsPerBatch: number,
): Promise<readonly string[]> {
  return claimIds(
    tx,
    `SELECT t.${key}::text AS id FROM ${table} t
      WHERE ${EXPIRED('t')}
      ORDER BY t.deleted_at, t.${key}
      LIMIT ${literalLimit(rowsPerBatch)}
      FOR UPDATE`,
    [cutoff],
  );
}

async function claimIds(tx: SQL, statement: string, params: readonly unknown[]): Promise<readonly string[]> {
  const rows = (await tx.unsafe(statement, [...params])) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

/**
 * The budget, inlined rather than bound.
 *
 * `LIMIT $n` is bindable, but every claim already carries the cutoff as `$1` and
 * threading a second parameter through eight call sites for a number this
 * function computed itself is more places to get an index wrong than it is
 * safety. {@link resolvePurgeBudget} has already clamped it to an integer inside
 * a module-constant range, and this re-derives that rather than trusting it.
 */
function literalLimit(rowsPerBatch: number): number {
  return Math.min(Math.max(1, Math.floor(rowsPerBatch)), PURGE_ROWS_PER_BATCH_CEILING);
}

/**
 * A claimed id set, as a Postgres array literal.
 *
 * Bun's SQL template **spreads** a JavaScript array into a value list, which is
 * wrong for `= ANY($n::bigint[])` — the same reason `textArrayLiteral` exists.
 * The digits check is defence in depth rather than input validation: these ids
 * were read out of the database by this transaction three statements ago, and a
 * value that is not a bare integer means something upstream is returning
 * something other than a `bigint` key, which must fail here rather than reach a
 * `DELETE`.
 */
function idArray(ids: readonly string[]): string {
  for (const id of ids) {
    if (!/^\d+$/.test(id)) throw new Error('invariant: a claimed row key is not an integer');
  }
  return `{${ids.join(',')}}`;
}

function n(value: number | undefined): number {
  return Number(value ?? 0);
}
