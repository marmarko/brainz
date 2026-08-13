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
 *
 * ============================================================================
 * AND WHY AN ATTACHMENT IS SWEPT ON TWO HANDLES RATHER THAN ONE
 * ============================================================================
 *
 * A page was the only thing this file could reach, and an object a connector
 * carries is three rows in two tables: the `attachment`, the transcript page the
 * OCR phase writes from it, and that page's chunks. None of them was reachable,
 * because `attachment` had no `external_ref` (rung 6 adds it) and the transcript
 * is keyed `attachment:{id}` — a name no provider will ever say. The visible
 * consequence was a document deleted in Drive that kept answering `recall`
 * through its own transcribed text, with no command that would ever remove it.
 *
 * So an attachment is retired when **either** handle names it:
 *
 *   1. **The provider named the object.** A Drive file *is* the item, so its
 *      deletion arrives as an ordinary ref and matches `attachment.external_ref`.
 *   2. **The page it hangs off went.** A mail attachment is named by nothing the
 *      provider will send — the *message* is deleted, and the picture that
 *      arrived on it is a row nobody mentions. It belongs to that page, so it
 *      goes with it.
 *
 * Both then retire the transcript, by the one spelling `accept.ts` owns. The
 * transcript's chunks go through the same statement as any other page's, so the
 * text stops being retrievable rather than merely stopping being listed.
 *
 * **Rows written before rung 6 carry no ref and are reachable only by (2).**
 * That is stated in the migration and not papered over here: a backfill would
 * have to invent the provider's id, and `object_key` is a hash of it.
 */

import type { SQL } from 'bun';

import { transcriptRefFor } from '../../core/media/accept.ts';
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
  /** Objects retired with them, by either handle. */
  readonly attachments: number;
}

const EMPTY: TombstoneRefsResult = { tombstoned: 0, pageIds: [], externalRefs: [], attachments: 0 };

interface LiveRow {
  readonly page_id: string;
  readonly external_ref: string;
}

interface LiveAttachment {
  readonly attachment_id: string;
  readonly external_ref: string | null;
}

export async function tombstoneRefs(
  sql: SQL,
  request: TombstoneRefsRequest,
): Promise<TombstoneRefsResult> {
  const refs = [...new Set(request.externalRefs)].filter((ref) => ref.trim().length > 0);
  if (refs.length === 0) return EMPTY;
  const refLiteral = textArrayLiteral(refs);

  const live = (await sql`
    SELECT page_id::text AS page_id, external_ref
      FROM page
     WHERE origin_context = ${request.originContext}
       AND external_ref = ANY(${refLiteral}::text[])
       AND deleted_at IS NULL
     ORDER BY page_id
  `) as LiveRow[];

  // Objects the provider named directly. Fenced on origin for the same reason
  // pages are: a connector retires its own rows and no other source's.
  const namedAttachments = (await sql`
    SELECT attachment_id::text AS attachment_id, external_ref
      FROM attachment
     WHERE origin_context = ${request.originContext}
       AND external_ref = ANY(${refLiteral}::text[])
       AND deleted_at IS NULL
     ORDER BY attachment_id
  `) as LiveAttachment[];

  const pageIds = live.map((row) => row.page_id);

  // Objects nobody named, that belong to a page that just went. The mail
  // attachment case: the message is deleted, the picture is mentioned by
  // nothing, and it is still in the brain unless it leaves with its page.
  const orphaned =
    pageIds.length === 0
      ? []
      : ((await sql`
          SELECT attachment_id::text AS attachment_id, external_ref
            FROM attachment
           WHERE page_id = ANY(${textArrayLiteral(pageIds)}::bigint[])
             AND deleted_at IS NULL
           ORDER BY attachment_id
        `) as LiveAttachment[]);

  const attachmentIds = [
    ...new Set([...namedAttachments, ...orphaned].map((row) => row.attachment_id)),
  ];

  if (live.length === 0 && attachmentIds.length === 0) return EMPTY;

  // The transcripts those objects produced. Resolved as pages so they go
  // through the identical retirement path — facts, chunks, page — rather than a
  // second, thinner deletion that leaves the chunks retrievable.
  const transcripts =
    attachmentIds.length === 0
      ? []
      : ((await sql`
          SELECT page_id::text AS page_id, external_ref
            FROM page
           WHERE origin_context = ${request.originContext}
             AND external_ref = ANY(${textArrayLiteral(attachmentIds.map(transcriptRefFor))}::text[])
             AND deleted_at IS NULL
           ORDER BY page_id
        `) as LiveRow[]);

  const allPageIds = [...new Set([...pageIds, ...transcripts.map((row) => row.page_id)])];

  const settings = (await sql`
    SELECT taxonomy_version FROM tenant_setting LIMIT 1
  `) as Array<{ taxonomy_version: number }>;
  const taxonomyVersion = settings[0]?.taxonomy_version ?? 1;

  await sql.begin(async (tx) => {
    const retired: string[] = [];
    for (const pageId of allPageIds) {
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

    // The object row last, inside the same transaction as the text derived from
    // it: an attachment retired while its transcript survived would be a queue
    // entry gone and a searchable page left, which is the defect this file is
    // being changed to close, one table over.
    if (attachmentIds.length > 0) {
      await tx`
        UPDATE attachment SET deleted_at = now()
         WHERE attachment_id = ANY(${textArrayLiteral(attachmentIds)}::bigint[])
           AND deleted_at IS NULL
      `;
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

  // The refs a caller logs: what it asked about and this brain actually held.
  // A named object with no page of its own still gets its row, or a deleted
  // Drive file would be swept and reported as nothing having happened.
  const swept = new Set<string>([
    ...live.map((row) => row.external_ref),
    ...namedAttachments.flatMap((row) => (row.external_ref === null ? [] : [row.external_ref])),
  ]);

  return {
    tombstoned: allPageIds.length,
    pageIds: allPageIds,
    externalRefs: [...swept],
    attachments: attachmentIds.length,
  };
}
