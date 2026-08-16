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
 * four tables, `lifecycle/severance.ts:severOrigin` reaches two more
 * (`entity_card`, `commitment`), and `lifecycle/subject-erasure.ts:eraseSubject`
 * a seventh (`attachment`). The restore knew about the first four. So a user who
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
        blocked += (await tombstonedAt(tx, entry.table, request.deletedAt)) - restored;
      }
    }
    return { counts, blocked };
  });

  return {
    ok: true,
    restored: outcome.counts as unknown as TombstoneCounts,
    supersededCards: outcome.blocked,
  };
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

/** Rows still carrying this instant — the denominator for a guarded restore. */
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
export interface PurgeCounts extends TombstoneCounts {}

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
 *   6. entities, whose slugs, aliases and cards cascade.
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
