/**
 * Blast-radius preview on destructive operations (R12), including context
 * severance.
 *
 * ============================================================================
 * THE HALF A ROW COUNT MISSES
 * ============================================================================
 *
 * The obvious preview counts the rows a delete statement would touch. For a
 * `forget` that is the whole answer. For **severance** — the user disconnecting
 * their work account (R15's origins, U18's severance flow) — it is an answer
 * that quietly understates the cost by the most expensive term.
 *
 * A derived row carries the **union** of its inputs' origins (R15): a fact
 * extracted from a work chunk and a personal chunk claims both, and so does the
 * entity built from it, the card written about that entity and the commitment
 * read off it. Severing `work` does not delete those rows. It leaves them
 * **wrong** — asserting something over evidence half of which no longer exists —
 * and every one of them has to be re-derived from the origins that survive
 * before it can be trusted again.
 *
 * So the preview has two columns and the second is the one the user actually
 * needs to see before they click:
 *
 *   * **removed** — origins are exactly the severed one. These go.
 *   * **recomputed** — origins are the severed one *plus others*. These stay,
 *     and their content is provisional until a consolidation cycle re-derives
 *     them.
 *
 * A preview showing only the first column tells a user that disconnecting work
 * costs them their work mail. It costs them their work mail *and* their shared
 * history with everyone they know through both accounts.
 *
 * **Nothing here writes.** Every statement is a SELECT, and the suite asserts a
 * before/after census across every content table — because a preview that
 * mutates is not a preview, and the shape of this module (counting queries that
 * mirror the delete's own predicates) is exactly the shape that acquires an
 * `UPDATE` by accident during a refactor.
 */

import type { SQL } from 'bun';

import { fenceEntity, fenceRow, fenceScalar, type Grant } from '../search/fence.ts';
import { textArrayLiteral } from '../write/pg-values.ts';
import type { OpaqueId } from '../../mcp/ids.ts';

export interface RemovalCounts {
  readonly pages: number;
  readonly chunks: number;
  readonly attachments: number;
  readonly facts: number;
  readonly entities: number;
  readonly entityCards: number;
  readonly commitments: number;
  readonly edges: number;
}

export interface SeverancePreview {
  readonly origin: string;
  /** Rows whose origins are exactly the severed one. */
  readonly removed: RemovalCounts;
  /** Rows that survive with a hole in their evidence and must be re-derived. */
  readonly recomputed: RemovalCounts;
  /** True when anything at all has to be re-derived. */
  readonly recomputeRequired: boolean;
  /** The origins a recompute would run against. Named so the user can see them. */
  readonly survivingOrigins: readonly string[];
}

/**
 * What severing one origin costs, in both currencies.
 *
 * The two predicates are deliberately written so a row can satisfy exactly one:
 * `origin_contexts <@ ARRAY[origin]` is "nothing but this origin" (the column is
 * a non-empty set by CHECK, so a subset of a singleton *is* that singleton), and
 * the recompute predicate adds `NOT` to the same expression. A row cannot be
 * counted twice, and — more to the point — a mixed row cannot be counted as
 * removed while the totals still add up.
 */
export async function previewSeverance(
  sql: SQL,
  request: { readonly origin: string },
): Promise<SeverancePreview> {
  const origin = request.origin;

  const removed = await counts(sql, origin, 'exact');
  const recomputed = await counts(sql, origin, 'mixed');

  const surviving = (await sql`
    SELECT DISTINCT origin_context FROM page WHERE deleted_at IS NULL AND origin_context <> ${origin}
     ORDER BY origin_context
  `) as Array<{ origin_context: string }>;

  const recomputeRequired =
    recomputed.facts + recomputed.entities + recomputed.entityCards + recomputed.commitments + recomputed.edges > 0;

  return {
    origin,
    removed,
    recomputed,
    recomputeRequired,
    survivingOrigins: surviving.map((row) => row.origin_context),
  };
}

/**
 * One query per mode, and the mode is the only difference.
 *
 * `exact` scopes the ingested tables by their scalar origin (a page arrived
 * through one credential, so "mixed" is not a state it can be in) and the
 * derived tables by set equality. `mixed` reports zero for the ingested tables
 * for the same reason, and set difference for the derived ones.
 */
async function counts(sql: SQL, origin: string, mode: 'exact' | 'mixed'): Promise<RemovalCounts> {
  const derived = mode === 'exact' ? sql`origin_contexts <@ ARRAY[${origin}]::text[]` : sql`NOT (origin_contexts <@ ARRAY[${origin}]::text[])`;
  const ingested = mode === 'exact';

  const rows = (await sql`
    SELECT
      (SELECT count(*)::int FROM page
        WHERE deleted_at IS NULL AND ${ingested} AND origin_context = ${origin}) AS pages,
      (SELECT count(*)::int FROM chunk
        WHERE deleted_at IS NULL AND ${ingested} AND origin_context = ${origin}) AS chunks,
      (SELECT count(*)::int FROM attachment
        WHERE ${ingested} AND origin_context = ${origin}) AS attachments,
      (SELECT count(*)::int FROM fact
        WHERE deleted_at IS NULL AND origin_contexts @> ARRAY[${origin}]::text[] AND ${derived}) AS facts,
      (SELECT count(*)::int FROM entity
        WHERE deleted_at IS NULL AND origin_contexts @> ARRAY[${origin}]::text[] AND ${derived}) AS entities,
      (SELECT count(*)::int FROM entity_card
        WHERE deleted_at IS NULL AND origin_contexts @> ARRAY[${origin}]::text[] AND ${derived}) AS entity_cards,
      (SELECT count(*)::int FROM commitment
        WHERE deleted_at IS NULL AND origin_contexts @> ARRAY[${origin}]::text[] AND ${derived}) AS commitments,
      (SELECT count(*)::int FROM entity_edge
        WHERE origin_contexts @> ARRAY[${origin}]::text[] AND ${derived}) AS edges
  `) as Array<Record<string, number>>;

  const row = rows[0] ?? {};
  return {
    pages: Number(row.pages ?? 0),
    chunks: Number(row.chunks ?? 0),
    attachments: Number(row.attachments ?? 0),
    facts: Number(row.facts ?? 0),
    entities: Number(row.entities ?? 0),
    entityCards: Number(row.entity_cards ?? 0),
    commitments: Number(row.commitments ?? 0),
    edges: Number(row.edges ?? 0),
  };
}

export interface ForgetCascadePreview {
  readonly pages: number;
  readonly chunks: number;
  readonly facts: number;
  readonly entities: number;
}

export type ForgetPreviewOutcome =
  | { readonly ok: true; readonly cascade: ForgetCascadePreview }
  | { readonly ok: false; readonly reason: 'not_found' | 'scope_denied' };

/**
 * What `forget` would take, counted before it takes it.
 *
 * Mirrors `src/mcp/tombstone.ts:forgetRecord` — the same cascade, the same
 * origin predicates on the rows the cascade reaches, and the same refusal
 * vocabulary. It is a mirror rather than a shared helper because the two run at
 * different times against different states, and a preview that shared the
 * retraction's statements would be one edit away from *being* the retraction.
 * The suite pins the mirror by asserting the counts against the same fixture the
 * cascade runs on.
 */
export async function previewForget(
  sql: SQL,
  request: { readonly id: OpaqueId; readonly grant: Grant },
): Promise<ForgetPreviewOutcome> {
  const permitted = await mayTouch(sql, request.grant, request.id);
  if (permitted !== 'ok') return { ok: false, reason: permitted };

  // Bun sends a JS array as a scalar parameter, so the grant crosses the wire
  // as the literal every other fenced write in this repo uses.
  const grantLiteral = textArrayLiteral(request.grant);

  switch (request.id.kind) {
    case 'chunk':
      return { ok: true, cascade: { pages: 0, chunks: 1, facts: 0, entities: 0 } };
    case 'ent':
      return { ok: true, cascade: { pages: 0, chunks: 0, facts: 0, entities: 1 } };
    case 'fact':
      return { ok: true, cascade: { pages: 0, chunks: 0, facts: 1, entities: 0 } };
    case 'doc': {
      const rows = (await sql`
        SELECT
          (SELECT count(*)::int FROM page
            WHERE page_id = ${request.id.key}::bigint AND deleted_at IS NULL) AS pages,
          (SELECT count(*)::int FROM chunk
            WHERE page_id = ${request.id.key}::bigint AND deleted_at IS NULL
              AND origin_context = ANY(${grantLiteral}::text[])) AS chunks,
          (SELECT count(*)::int FROM fact f
            WHERE f.deleted_at IS NULL
              AND f.origin_contexts <@ ${grantLiteral}::text[]
              AND (f.page_id = ${request.id.key}::bigint
                   OR f.fact_id IN (SELECT fs.fact_id FROM fact_source fs
                                      JOIN chunk c ON c.chunk_id = fs.chunk_id
                                     WHERE c.page_id = ${request.id.key}::bigint))) AS facts
      `) as Array<Record<string, number>>;
      const row = rows[0] ?? {};
      return {
        ok: true,
        cascade: {
          pages: Number(row.pages ?? 0),
          chunks: Number(row.chunks ?? 0),
          facts: Number(row.facts ?? 0),
          entities: 0,
        },
      };
    }
  }
}

/** The three fence rules a read of this row would apply — the same as `forgetRecord`'s. */
async function mayTouch(sql: SQL, grant: Grant, id: OpaqueId): Promise<'ok' | 'not_found' | 'scope_denied'> {
  switch (id.kind) {
    case 'chunk': {
      const rows = (await sql`SELECT origin_context FROM chunk WHERE chunk_id = ${id.key}::bigint`) as Array<{
        origin_context: string;
      }>;
      const row = rows[0];
      if (row === undefined) return 'not_found';
      return fenceScalar(row.origin_context, grant) ? 'ok' : 'scope_denied';
    }
    case 'doc': {
      const rows = (await sql`SELECT origin_context FROM page WHERE page_id = ${id.key}::bigint`) as Array<{
        origin_context: string;
      }>;
      const row = rows[0];
      if (row === undefined) return 'not_found';
      return fenceScalar(row.origin_context, grant) ? 'ok' : 'scope_denied';
    }
    case 'fact': {
      const rows = (await sql`SELECT origin_contexts FROM fact WHERE fact_id = ${id.key}::bigint`) as Array<{
        origin_contexts: string[];
      }>;
      const row = rows[0];
      if (row === undefined) return 'not_found';
      return fenceRow(row.origin_contexts, grant) ? 'ok' : 'scope_denied';
    }
    case 'ent': {
      const rows = (await sql`SELECT origin_contexts FROM entity WHERE entity_id = ${id.key}::bigint`) as Array<{
        origin_contexts: string[];
      }>;
      const row = rows[0];
      if (row === undefined) return 'not_found';
      return fenceEntity(row.origin_contexts, grant) ? 'ok' : 'scope_denied';
    }
  }
}
