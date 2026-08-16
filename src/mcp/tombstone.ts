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
  | { readonly ok: true; readonly restored: CascadeCounts }
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

  const restored = await sql.begin(async (tx) => ({
    pages: await touched(tx, 'page', 'page_id', request.deletedAt),
    chunks: await touched(tx, 'chunk', 'chunk_id', request.deletedAt),
    facts: await touched(tx, 'fact', 'fact_id', request.deletedAt),
    entities: await touched(tx, 'entity', 'entity_id', request.deletedAt),
  }));

  return { ok: true, restored };
}

async function touched(tx: SQL, table: string, key: string, deletedAt: string): Promise<number> {
  const rows = (await tx.unsafe(
    `UPDATE ${table} SET deleted_at = NULL WHERE deleted_at = $1::timestamptz RETURNING ${key}`,
    [deletedAt],
  )) as Array<Record<string, unknown>>;
  return rows.length;
}

/**
 * What a purge removed. A superset of {@link CascadeCounts}, because the purge
 * reaches two tables no single `forget` cascade writes to.
 */
export interface PurgeCounts extends CascadeCounts {
  readonly commitments: number;
  readonly attachments: number;
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

    const commitments = await deleted(tx, 'commitment', 'commitment_id', cutoff);
    const attachments = await deleted(tx, 'attachment', 'attachment_id', cutoff);
    const facts = await deleted(tx, 'fact', 'fact_id', cutoff);
    const chunks = await deleted(tx, 'chunk', 'chunk_id', cutoff);
    const pages = await deleted(tx, 'page', 'page_id', cutoff);
    const entities = await deleted(tx, 'entity', 'entity_id', cutoff);

    return { pages, chunks, facts, entities, commitments, attachments };
  });
}

async function deleted(tx: SQL, table: string, key: string, cutoff: string): Promise<number> {
  const rows = (await tx.unsafe(
    `DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at <= $1::timestamptz RETURNING ${key}`,
    [cutoff],
  )) as Array<Record<string, unknown>>;
  return rows.length;
}
