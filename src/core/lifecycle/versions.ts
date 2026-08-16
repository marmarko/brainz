/**
 * Page versions and revert (R12's remaining lifecycle leg).
 *
 * **Why this is a table and not a query over tombstones.** U4 replaces a changed
 * document by tombstoning the previous page and writing a new one, so a
 * predecessor really does exist and it would be tempting to call that the
 * history. It is deleted 72 hours later by `purgeExpiredTombstones`. A version
 * history with a three-day memory is worse than no version history, because the
 * user who was told they had one did not keep their own copy.
 *
 * So `page_version` (rung 9) is an explicit snapshot, and three things follow:
 *
 *   1. **Keyed on the document, not the page row.** `docKey` is the
 *      `external_ref` where there is one and `page:<id>` where there is not,
 *      because a replaced document is a *new* page row and a history keyed on
 *      the page id fragments at exactly the moment there is something to
 *      remember.
 *   2. **The snapshot's foreign key to `page` is ON DELETE SET NULL**, so the
 *      TTL purge cannot take the history with it. That is the whole property,
 *      and `test/core/lifecycle/versions.test.ts` purges for real to prove it.
 *   3. **A snapshot that does not verify is refused.** The body is reconstructed
 *      from chunks (`src/core/export/reconstruct.ts`), and the digest U4 wrote
 *      on the page is the arbiter. There is no `verified` column here because a
 *      version a revert cannot trust is not a version — reverting to one would
 *      hand the user a document they never wrote with the product's full
 *      confidence behind it.
 *
 * **Revert re-ingests rather than un-deletes.** It calls U4's `ingestDocument`
 * with the snapshot's title and body, which re-chunks and re-embeds at the
 * honest cost and requires no change to the write path. And it captures the
 * pre-revert state first, so a revert is itself undoable — the failure mode
 * otherwise is a user reverting to the wrong version and losing the one they
 * were on.
 *
 * **Fenced exactly as a read of the same page is** (R15). A grant that cannot
 * see an origin cannot list its history and cannot revert it. A version table
 * outside the fence would be a second, unfenced copy of every document.
 */

import type { SQL } from 'bun';

import { reconstructPage, type ReconstructedPage } from '../export/reconstruct.ts';
import { fenceScalar, type Grant } from '../search/fence.ts';
import { textArrayLiteral } from '../write/pg-values.ts';
import { ingestDocument, type SourceType, type WriteContext } from '../write/write-path.ts';

/** Which sweep banked a snapshot. Mirrors the rung's CHECK. */
export type CaptureSource = 'live' | 'superseded' | 'pre_revert';

export interface PageVersion {
  readonly versionId: string;
  readonly docKey: string;
  readonly version: number;
  readonly pageId: string | null;
  readonly originContext: string;
  readonly sourceType: SourceType;
  readonly title: string | null;
  readonly body: string;
  readonly contentSha256: string;
  readonly capturedFrom: CaptureSource;
  readonly capturedAt: string;
}

export type CaptureRefusal =
  /** The page is absent, tombstoned or quarantined. */
  | 'not_found'
  /** The reconstruction could not reproduce `page.content_sha256`. */
  | 'unverifiable';

export type CaptureOutcome =
  | { readonly ok: true; readonly status: 'captured'; readonly version: number; readonly docKey: string }
  | { readonly ok: true; readonly status: 'unchanged'; readonly version: number; readonly docKey: string }
  | { readonly ok: false; readonly reason: CaptureRefusal };

/**
 * Snapshot one page's current content as the next version of its document.
 *
 * `unchanged` when the latest version already carries this digest: the sweep
 * runs on a schedule and a history that grew a row per sweep would bury the
 * three edits a user actually made under a thousand identical snapshots.
 */
export async function capturePageVersion(
  sql: SQL,
  request: {
    readonly pageId: string;
    readonly capturedFrom: CaptureSource;
    readonly includeTombstoned?: boolean;
  },
): Promise<CaptureOutcome> {
  const page = await reconstructPage(sql, request.pageId, {
    ...(request.includeTombstoned === true ? { includeTombstoned: true } : {}),
  });
  if (page === null) return { ok: false, reason: 'not_found' };
  return captureReconstructed(sql, page, request.capturedFrom);
}

async function captureReconstructed(
  sql: SQL,
  page: ReconstructedPage,
  capturedFrom: CaptureSource,
): Promise<CaptureOutcome> {
  if (!page.verified) return { ok: false, reason: 'unverifiable' };

  return sql.begin(async (tx) => {
    const latest = (await tx`
      SELECT version, content_sha256 FROM page_version
       WHERE doc_key = ${page.docKey}
       ORDER BY version DESC LIMIT 1
    `) as Array<{ version: number; content_sha256: string }>;

    const head = latest[0];
    if (head !== undefined && head.content_sha256 === page.expectedDigest) {
      return { ok: true as const, status: 'unchanged' as const, version: head.version, docKey: page.docKey };
    }

    const next = (head?.version ?? 0) + 1;
    await tx`
      INSERT INTO page_version (doc_key, version, page_id, origin_context, subject_context,
                                subject_confidence, source_type, title, body, content_sha256, captured_from)
      VALUES (${page.docKey}, ${next}, ${page.pageId}::bigint, ${page.originContext},
              ${page.subjectContext}, ${page.subjectConfidence}, ${page.sourceType},
              ${page.title}, ${page.body}, ${page.expectedDigest}, ${capturedFrom})
    `;
    return { ok: true as const, status: 'captured' as const, version: next, docKey: page.docKey };
  });
}

export interface SupersededSweepResult {
  readonly captured: number;
  readonly unchanged: number;
  /** Predecessors whose reconstruction did not verify. Counted, never guessed at. */
  readonly unverifiable: number;
}

/**
 * Bank every tombstoned predecessor as a version **before the TTL purge takes
 * it**.
 *
 * This is what makes history real for the ordinary case — an edited file, an
 * updated thread — without touching U4's write path. A predecessor is a
 * tombstoned page sharing an `external_ref` with a live one; a page tombstoned
 * by `forget` shares its ref with nothing live and is deliberately *not* swept,
 * because banking a copy of what a user just retracted is a `forget` that did
 * not forget.
 *
 * Oldest first, so version numbers run in the order the documents did.
 */
export async function captureSupersededVersions(
  sql: SQL,
  options: { readonly origins?: readonly string[] },
): Promise<SupersededSweepResult> {
  const predecessors = (await sql`
    SELECT dead.page_id::text AS page_id
      FROM page dead
      JOIN page live
        ON live.external_ref = dead.external_ref
       AND live.deleted_at IS NULL
       AND live.page_id <> dead.page_id
     WHERE dead.deleted_at IS NOT NULL
       AND dead.external_ref IS NOT NULL
       AND (${originLiteral(options.origins)}::text[] IS NULL
            OR dead.origin_context = ANY(${originLiteral(options.origins)}::text[]))
     ORDER BY dead.created_at, dead.page_id
  `) as Array<{ page_id: string }>;

  let captured = 0;
  let unchanged = 0;
  let unverifiable = 0;

  for (const row of predecessors) {
    const outcome = await capturePageVersion(sql, {
      pageId: row.page_id,
      capturedFrom: 'superseded',
      includeTombstoned: true,
    });
    if (!outcome.ok) {
      if (outcome.reason === 'unverifiable') unverifiable += 1;
      continue;
    }
    if (outcome.status === 'captured') captured += 1;
    else unchanged += 1;
  }

  return { captured, unchanged, unverifiable };
}

/** Bun sends a JS array as a scalar, so an origin set crosses the wire as a literal. */
function originLiteral(origins: readonly string[] | undefined): string | null {
  return origins === undefined ? null : textArrayLiteral(origins);
}

/** One document's history, oldest first, fenced by the caller's grant. */
export async function listVersions(
  sql: SQL,
  request: { readonly docKey: string; readonly grant: Grant },
): Promise<PageVersion[]> {
  const rows = (await sql`
    SELECT version_id::text AS version_id, doc_key, version, page_id::text AS page_id,
           origin_context, source_type, title, body, content_sha256, captured_from,
           captured_at::text AS captured_at
      FROM page_version
     WHERE doc_key = ${request.docKey}
     ORDER BY version
  `) as Array<Record<string, unknown>>;

  return rows
    .filter((row) => fenceScalar(String(row.origin_context), request.grant))
    .map((row) => ({
      versionId: String(row.version_id),
      docKey: String(row.doc_key),
      version: Number(row.version),
      pageId: row.page_id === null ? null : String(row.page_id),
      originContext: String(row.origin_context),
      sourceType: String(row.source_type) as SourceType,
      title: row.title === null ? null : String(row.title),
      body: String(row.body),
      contentSha256: String(row.content_sha256),
      capturedFrom: String(row.captured_from) as CaptureSource,
      capturedAt: String(row.captured_at),
    }));
}

export type RevertRefusal = 'not_found' | 'scope_denied' | 'write_failed';

export type RevertOutcome =
  | {
      readonly ok: true;
      readonly docKey: string;
      readonly revertedTo: number;
      /** The version the pre-revert state was banked as, so the undo has a name. */
      readonly undoVersion: number | null;
      readonly pageId: string;
    }
  | { readonly ok: false; readonly reason: RevertRefusal; readonly detail?: string };

/**
 * Restore a document to one of its versions.
 *
 * Order matters and is the whole of the safety story:
 *
 *   1. **Resolve and fence** — a grant that cannot read the origin is refused
 *      with the same word it would get for a read.
 *   2. **Bank the current state** as a `pre_revert` version, so reverting to the
 *      wrong version does not lose the one the user was on.
 *   3. **Re-ingest** through U4. For a document with an upstream id this
 *      replaces in place, because the write path keys on `external_ref` and the
 *      digest has moved. For a page with no upstream id the live row is
 *      tombstoned first, since nothing would otherwise supersede it and the
 *      brain would answer with both versions at once.
 */
export async function revertPage(
  ctx: WriteContext,
  request: {
    readonly docKey: string;
    readonly version: number;
    readonly grant: Grant;
    readonly now: Date;
  },
): Promise<RevertOutcome> {
  const rows = (await ctx.sql`
    SELECT origin_context, source_type, title, body
      FROM page_version
     WHERE doc_key = ${request.docKey} AND version = ${request.version}
  `) as Array<{ origin_context: string; source_type: string; title: string | null; body: string }>;

  const snapshot = rows[0];
  if (snapshot === undefined) return { ok: false, reason: 'not_found' };
  if (!fenceScalar(snapshot.origin_context, request.grant)) return { ok: false, reason: 'scope_denied' };

  const live = (await ctx.sql`
    SELECT page_id::text AS page_id, external_ref
      FROM page
     WHERE deleted_at IS NULL
       AND (external_ref = ${request.docKey}
            OR (external_ref IS NULL AND ${request.docKey} = 'page:' || page_id::text))
     ORDER BY page_id DESC LIMIT 1
  `) as Array<{ page_id: string; external_ref: string | null }>;

  let undoVersion: number | null = null;
  const current = live[0];
  if (current !== undefined) {
    const banked = await capturePageVersion(ctx.sql, {
      pageId: current.page_id,
      capturedFrom: 'pre_revert',
    });
    if (banked.ok) undoVersion = banked.version;

    if (current.external_ref === null) {
      // Nothing would supersede it: U4 keys replacement on `external_ref`, and
      // this page has none. Retract it explicitly, or the brain answers with the
      // reverted document *and* the one it replaced.
      await ctx.sql.begin(async (tx) => {
        await tx`UPDATE fact SET deleted_at = now() WHERE page_id = ${current.page_id}::bigint AND deleted_at IS NULL`;
        await tx`UPDATE chunk SET deleted_at = now() WHERE page_id = ${current.page_id}::bigint AND deleted_at IS NULL`;
        await tx`UPDATE page SET deleted_at = now() WHERE page_id = ${current.page_id}::bigint AND deleted_at IS NULL`;
        return { value: null };
      });
    }
  }

  const receipt = await ingestDocument(ctx, {
    originContext: snapshot.origin_context,
    sourceType: snapshot.source_type as SourceType,
    title: snapshot.title,
    body: snapshot.body,
    externalRef: request.docKey.startsWith('page:') ? null : request.docKey,
  });
  if (!receipt.ok) return { ok: false, reason: 'write_failed', detail: receipt.reason };

  return {
    ok: true,
    docKey: request.docKey,
    revertedTo: request.version,
    undoVersion,
    pageId: receipt.pageId,
  };
}
