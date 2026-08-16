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
 *   1. **Keyed on the document, not the page row.** `docKey` is
 *      `<origin>|<external_ref>` — or `<origin>|page:<id>` where there is no
 *      upstream id — because a replaced document is a *new* page row and a
 *      history keyed on the page id fragments at exactly the moment there is
 *      something to remember.
 *
 *      **The origin is in the key**, and it is what makes the number mean
 *      something. `external_ref` is the provider's id and carries no
 *      cross-origin uniqueness: a shared calendar event pulled by a work
 *      connector and a personal one is two live pages at one ref, which is why
 *      `write-path.ts:livePageByRef` narrows replacement to
 *      `(external_ref, origin_context)`. Keyed on the ref alone, the unique
 *      index `(doc_key, version)` made both copies allocate from one sequence,
 *      so each fenced history showed `[1, 3]` where the other origin held `2` —
 *      not a disclosure, since every row is fenced, but a history with a hole in
 *      it and a "revert to version 2" naming a row the caller is refused.
 *
 *      **Rows banked before the fold keep their bare keys, and that is the rule
 *      rather than an oversight.** Rewriting them is a contracting migration:
 *      `UPDATE page_version SET doc_key = …` is refused by the ladder's own
 *      expand-only scanner (`src/control/migrate.ts:findExpandContractViolations`)
 *      because the previous fleet version still reads those rows by the bare
 *      key, and the repo has no waiver list on purpose. A legacy key still
 *      resolves — `parseDocKey` reads a key with no origin half as its own ref,
 *      and `revertPage` fences on the snapshot row's `origin_context` either way
 *      — so what a pre-fold brain has is a document whose history is in two
 *      sequences rather than one. In production that set is empty, because this
 *      module has no caller yet; doing the fold *before* one lands is what keeps
 *      it empty.
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

import { parseDocKey, reconstructPage, type ReconstructedPage } from '../export/reconstruct.ts';
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
    // **One question, because `doc_key` is one document.** "Has this document
    // changed?" and "what number does the next snapshot get?" used to be two
    // queries with two different scopes, and the reason was that `doc_key` was
    // the bare `external_ref`: two credentials legitimately hold the same
    // provider object (`write-path.ts:livePageByRef`), so the digest had to be
    // compared within one origin while the number had to be allocated across
    // both — the unique index is `(doc_key, version)` and allocating per origin
    // collided on the first snapshot of the second copy. The residue was a
    // sequence shared by two mailboxes, so each fenced history showed gaps.
    //
    // `docKeyFor` folds the origin in, so the key names one origin's copy and
    // the head of that key answers both questions at once. Contiguous from 1,
    // which is what the rung's DDL says a version number is.
    const latest = (await tx`
      SELECT version, content_sha256 FROM page_version
       WHERE doc_key = ${page.docKey}
       ORDER BY version DESC LIMIT 1
    `) as Array<{ version: number; content_sha256: string }>;

    const head = latest[0];
    if (head !== undefined && head.content_sha256 === page.expectedDigest) {
      return { ok: true as const, status: 'unchanged' as const, version: head.version, docKey: page.docKey };
    }

    const next = Number(head?.version ?? 0) + 1;
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
 * tombstoned page sharing an `external_ref` **and an origin** with a live one; a
 * page tombstoned by `forget` shares that pair with nothing live and is
 * deliberately *not* swept, because banking a copy of what a user just retracted
 * is a `forget` that did not forget.
 *
 * **The origin half of that pair is load-bearing, not decoration.**
 * `external_ref` is the provider's id and carries no cross-origin uniqueness —
 * the same shared calendar event lives in a work mailbox and a personal one,
 * which is `write-path.ts:livePageByRef`'s whole subject. Keyed on the ref
 * alone, a page the user retracted in one mailbox has a "live partner" in the
 * other, is read as a superseded predecessor, and is banked verbatim into
 * `page_version` — whose foreign key is `ON DELETE SET NULL` precisely so the
 * 72h purge cannot reach it. The retraction would become permanent retention,
 * silently, on a schedule.
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
       AND live.origin_context = dead.origin_context
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

  // **At the snapshot's own origin**, which is the origin the fence above just
  // authorised and the origin `ingestDocument` below will write to. Without it
  // this is `ORDER BY page_id DESC` over every page carrying the ref — that is,
  // whichever mailbox last pulled the shared calendar event — and a work-scoped
  // revert then banks a `pre_revert` snapshot of the *personal* page: a
  // cross-origin read turned into a row by a credential that may not read it,
  // and an `undoVersion` on the receipt that the same credential is refused.
  //
  // The ref comes from the key rather than *being* the key: `doc_key` now folds
  // the origin in, and `parseDocKey` is the one inverse of the one constructor.
  // A key written before the fold has no origin half and parses to itself, so a
  // legacy snapshot still resolves its live page exactly as it always did —
  // `origin_context` above is the authority either way, since it is read off the
  // snapshot row rather than off the caller's string.
  const identity = parseDocKey(request.docKey);
  const live = (await ctx.sql`
    SELECT page_id::text AS page_id, external_ref
      FROM page
     WHERE deleted_at IS NULL
       AND origin_context = ${snapshot.origin_context}
       AND (external_ref = ${identity.ref}
            OR (external_ref IS NULL AND ${identity.ref} = 'page:' || page_id::text))
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
    externalRef: identity.externalRef,
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
