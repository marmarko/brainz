/**
 * Tombstoning items a provider says are gone.
 *
 * **Why this is not U8's folder sweep.** That one is keyed on *absence*: it
 * lists a root, and everything under the prefix it did not see is gone — which
 * is why it refuses to run on an incomplete scan. A delta feed never enumerates
 * what still exists, so absence means nothing here; what a connector has is the
 * opposite and better signal, an explicit list of ids that were deleted,
 * trashed or cancelled. The two cannot share an implementation because they do
 * not share a premise. What they do share is the *order* of the writes, and
 * that part is copied deliberately rather than re-derived: facts, then chunks,
 * then the page, inside one transaction, then reconcile the edges those facts
 * implied against what is left.
 *
 * **Scoped by origin (R15).** A connector may only tombstone what its own
 * credential fetched. Sweeping by external ref alone would let a Calendar pull
 * soft-delete a note some other source wrote that happens to share an id — the
 * origin fence, at the deletion end, where it is least visible and most
 * expensive to get wrong.
 *
 * **Why the fact rows must go too, and not only the page.** U11's contradiction
 * detector reads live facts. A page tombstoned with its facts left standing is
 * a claim the brain still believes and can no longer trace, and the detector
 * reports it against its live replacement as a genuine conflict — manufacturing
 * exactly the fabrication R8's upgrade prompt is built on.
 */

import type { SQL } from 'bun';

import { reconcileEdges } from '../../core/write/links.ts';
import { textArrayLiteral } from '../../core/write/pg-values.ts';

export interface TombstoneRefsRequest {
  readonly originContext: string;
  readonly externalRefs: readonly string[];
}

export interface TombstoneRefsResult {
  readonly tombstoned: number;
  readonly pageIds: readonly string[];
  /** The refs that actually went, so the caller writes one log row each. */
  readonly externalRefs: readonly string[];
}

const EMPTY: TombstoneRefsResult = { tombstoned: 0, pageIds: [], externalRefs: [] };

export async function tombstoneRefs(
  sql: SQL,
  request: TombstoneRefsRequest,
): Promise<TombstoneRefsResult> {
  const refs = [...new Set(request.externalRefs)].filter((ref) => ref.trim().length > 0);
  if (refs.length === 0) return EMPTY;

  const live = (await sql`
    SELECT page_id::text AS page_id, external_ref
      FROM page
     WHERE origin_context = ${request.originContext}
       AND external_ref = ANY(${textArrayLiteral(refs)}::text[])
       AND deleted_at IS NULL
     ORDER BY page_id
  `) as Array<{ page_id: string; external_ref: string }>;

  if (live.length === 0) return EMPTY;

  const settings = (await sql`
    SELECT taxonomy_version FROM tenant_setting LIMIT 1
  `) as Array<{ taxonomy_version: number }>;
  const taxonomyVersion = settings[0]?.taxonomy_version ?? 1;

  const pageIds = live.map((row) => row.page_id);

  await sql.begin(async (tx) => {
    const retired: string[] = [];
    for (const pageId of pageIds) {
      const statements = (await tx`
        SELECT statement FROM fact
         WHERE page_id = ${pageId}::bigint
           AND deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL
      `) as Array<{ statement: string }>;
      for (const row of statements) retired.push(row.statement);

      await tx`UPDATE fact SET deleted_at = now() WHERE page_id = ${pageId}::bigint AND deleted_at IS NULL`;
      await tx`UPDATE chunk SET deleted_at = now() WHERE page_id = ${pageId}::bigint AND deleted_at IS NULL`;
      await tx`UPDATE page SET deleted_at = now() WHERE page_id = ${pageId}::bigint AND deleted_at IS NULL`;
    }

    // Asked of the state this leaves behind: an edge survives while any *live*
    // fact still implies it, so a claim two sources made outlives one of them.
    await reconcileEdges(tx, {
      facts: [],
      previousStatements: retired,
      origins: [request.originContext],
      taxonomyVersion,
    });

    return { value: null };
  });

  return {
    tombstoned: pageIds.length,
    pageIds,
    externalRefs: live.map((row) => row.external_ref),
  };
}
