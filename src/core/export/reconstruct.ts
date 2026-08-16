/**
 * Getting a document's text back out of a brain that never stored it.
 *
 * **`page` has no body column.** The only copy of a document's text inside a
 * tenant database is `chunk.content`, and `chunk.content` is not coverage — U4's
 * chunker gives every chunk a {@link CHUNK_OVERLAP_CHARS}-character reach-back
 * into the previous window so a sentence split across a boundary is embedded
 * whole at least once. The coverage intervals that *do* tile the source exactly
 * (`sourceStart`, `sourceEnd`, `contentStart`) are computed at write time and
 * never written down.
 *
 * So the naive export — concatenate `chunk.content` in ordinal order — emits a
 * document with up to 200 duplicated characters at every chunk boundary. It is
 * not the user's file. It is also invisible to any test that compares an export
 * against itself, which is why this module exists as a module rather than as a
 * `join('')` inside the tree writer.
 *
 * ============================================================================
 * TWO MECHANISMS, AND THE SECOND IS THE ONE THAT MATTERS
 * ============================================================================
 *
 * **1. The join is bounded, not greedy.** {@link deoverlap} looks for the
 * longest prefix of the next chunk that the accumulated text already ends with
 * — *within the reach-back the chunker promises* and not one character further.
 * The bound is load-bearing rather than an optimisation: on text that repeats at
 * a period shorter than the window (a log file, a table, a generated document),
 * an unbounded longest match is satisfied by every multiple of that period, the
 * largest one wins, and the join silently deletes a span of the user's document.
 * The ceiling is what makes the longest match the *true* overlap.
 *
 * **2. The digest is the arbiter.** `page.content_sha256` is U4's idempotency
 * key — `contentDigest(title, body)`, written on every page, never stale,
 * because the write path compares against it on every poll to decide whether to
 * re-chunk. So this module does not have to *trust* its join: it recomputes the
 * digest over what it reconstructed and compares.
 *
 * **What happens on a mismatch is a product decision, and it is stated here.** A
 * page whose reconstruction does not verify is returned with `verified: false`
 * and the caller exports it *and marks it*. The two alternatives were both
 * rejected: dropping it hands the user a backup missing a document without
 * saying so, and shipping it unmarked hands them a corrupted one. A backup you
 * cannot tell is wrong is worse than no backup, because it is the thing you find
 * out about on the day you need it.
 */

import { createHash } from 'node:crypto';
import type { SQL } from 'bun';

import { CHUNK_OVERLAP_CHARS } from '../write/chunker.ts';
import { textArrayLiteral } from '../write/pg-values.ts';
import { contentDigest, type SourceType } from '../write/write-path.ts';

/**
 * The furthest back a chunk's stored content may reach.
 *
 * `CHUNK_OVERLAP_CHARS` plus one, and the one is not slack: `alignLeft` in the
 * chunker steps a single code unit further left when the reach-back would
 * otherwise land between the halves of a surrogate pair. A ceiling of exactly
 * 200 would fail to rejoin any document containing an emoji at the wrong offset,
 * and it would fail by producing a *duplicated* character rather than an error.
 */
export const MAX_REACH_BACK = CHUNK_OVERLAP_CHARS + 1;

/**
 * Rejoin stored chunk contents into the document they were cut from.
 *
 * Pure, and separated from the database read so the property it has to hold —
 * `deoverlap(chunkDocument(x).map(c => c.content)) === x` — is testable against
 * the real chunker over any input, with no fixture and no schema.
 */
export function deoverlap(contents: readonly string[]): string {
  const first = contents[0];
  if (first === undefined) return '';

  let joined = first;
  for (let index = 1; index < contents.length; index += 1) {
    const next = contents[index];
    if (next === undefined) continue;
    joined += next.slice(overlapWith(joined, next));
  }
  return joined;
}

/**
 * How many leading characters of `next` are a repeat of the tail of `joined`.
 *
 * Descending from the chunker's own ceiling, so the answer is the longest
 * *legal* overlap rather than the longest coincidence. Zero is always a valid
 * answer and is what a chunk with no reach-back gets.
 */
function overlapWith(joined: string, next: string): number {
  const ceiling = Math.min(MAX_REACH_BACK, next.length, joined.length);
  for (let size = ceiling; size > 0; size -= 1) {
    if (joined.endsWith(next.slice(0, size))) return size;
  }
  return 0;
}

export interface VerifyRequest {
  readonly title: string | null;
  readonly body: string;
  /** `page.content_sha256`. */
  readonly expected: string;
}

export interface VerifyOutcome {
  readonly verified: boolean;
  readonly expected: string;
  readonly actual: string;
}

/**
 * Recompute U4's digest over a reconstruction and say whether it matches.
 *
 * Deliberately calls `contentDigest` from the write path rather than
 * re-implementing sha256 over the same shape: a second implementation of an
 * idempotency key is a second opinion about what a document *is*, and the two
 * disagree on the day somebody changes one of them.
 */
export function verifyReconstruction(request: VerifyRequest): VerifyOutcome {
  const actual = contentDigest(request.title, request.body);
  return { verified: actual === request.expected, expected: request.expected, actual };
}

/**
 * The document's stable identity across replacement.
 *
 * U4 replaces a changed document by tombstoning the previous page and writing a
 * new one, so the page id moves and the `external_ref` does not. A history or an
 * export path keyed on the page id fragments at exactly the moment there is
 * something to remember. Pages with no upstream id — a `remember` note — fall
 * back to their own id, which is stable because nothing replaces them.
 */
export function docKeyFor(page: { readonly pageId: string; readonly externalRef: string | null }): string {
  const ref = page.externalRef?.trim() ?? '';
  return ref.length > 0 ? ref : `page:${page.pageId}`;
}

export interface ReconstructedPage {
  readonly pageId: string;
  readonly docKey: string;
  readonly originContext: string;
  readonly subjectContext: string | null;
  readonly subjectConfidence: number | null;
  readonly sourceType: SourceType;
  readonly externalRef: string | null;
  readonly title: string | null;
  readonly body: string;
  /** False when the join could not reproduce `page.content_sha256`. */
  readonly verified: boolean;
  readonly expectedDigest: string;
  readonly actualDigest: string;
  readonly chunkCount: number;
}

interface PageRow {
  page_id: string;
  origin_context: string;
  subject_context: string | null;
  subject_confidence: number | null;
  source_type: string;
  external_ref: string | null;
  title: string | null;
  content_sha256: string;
}

/**
 * Rebuild one live page. `null` when the page is absent, tombstoned or
 * quarantined.
 *
 * Tombstoned and quarantined rows are excluded here rather than by the caller,
 * and that is the same rule every read path in this repo applies: a retracted
 * document is not part of the corpus, and a backup that resurrects what a user
 * retracted is a `forget` that did not forget.
 */
export async function reconstructPage(
  sql: SQL,
  pageId: string,
  options: {
    readonly origins?: readonly string[];
    /**
     * Read a page the tombstone already took.
     *
     * Off by default and never on for an export — a backup that resurrects what
     * a user retracted is a `forget` that did not forget. The one legitimate
     * caller is U17's superseded-version sweep, which has to rescue a replaced
     * document's text *before* the 72h purge removes it, and by then the row is
     * tombstoned by definition.
     */
    readonly includeTombstoned?: boolean;
  } = {},
): Promise<ReconstructedPage | null> {
  const tombstoned = options.includeTombstoned === true;
  const rows = (await sql`
    SELECT page_id::text AS page_id, origin_context, subject_context, subject_confidence,
           source_type, external_ref, title, content_sha256
      FROM page
     WHERE page_id = ${pageId}::bigint
       AND (${tombstoned} OR deleted_at IS NULL)
       AND quarantined_at IS NULL
  `) as PageRow[];

  const row = rows[0];
  if (row === undefined) return null;
  if (options.origins !== undefined && !options.origins.includes(row.origin_context)) return null;

  return rebuild(sql, row, tombstoned);
}

/**
 * Every live page in the brain, oldest first.
 *
 * Ordered by page id rather than by title or path so two exports of an unchanged
 * brain are byte-identical — the property the file-parity round-trip is built
 * on. `origins` narrows to a fence when a caller has one; absent means the whole
 * brain, which is what a self-export is.
 */
export async function reconstructLivePages(
  sql: SQL,
  options: { readonly origins?: readonly string[] } = {},
): Promise<ReconstructedPage[]> {
  const rows = (await sql`
    SELECT page_id::text AS page_id, origin_context, subject_context, subject_confidence,
           source_type, external_ref, title, content_sha256
      FROM page
     WHERE deleted_at IS NULL AND quarantined_at IS NULL
       AND (${originLiteral(options.origins)}::text[] IS NULL
            OR origin_context = ANY(${originLiteral(options.origins)}::text[]))
     ORDER BY page_id
  `) as PageRow[];

  const pages: ReconstructedPage[] = [];
  for (const row of rows) pages.push(await rebuild(sql, row));
  return pages;
}

/** Bun sends a JS array as a scalar, so a grant crosses the wire as a literal. */
function originLiteral(origins: readonly string[] | undefined): string | null {
  return origins === undefined ? null : textArrayLiteral(origins);
}

async function rebuild(
  sql: SQL,
  row: PageRow,
  includeTombstoned = false,
): Promise<ReconstructedPage> {
  // A tombstoned page's chunks were tombstoned in the same transaction, so the
  // predicate has to move with the page's or the sweep reconstructs an empty
  // document and reports it as unverifiable.
  const chunks = (await sql`
    SELECT content
      FROM chunk
     WHERE page_id = ${row.page_id}::bigint
       AND (${includeTombstoned} OR deleted_at IS NULL)
       AND quarantined_at IS NULL
     ORDER BY ordinal, chunk_id
  `) as Array<{ content: string }>;

  const body = deoverlap(chunks.map((chunk) => chunk.content));
  const outcome = verifyReconstruction({
    title: row.title,
    body,
    expected: row.content_sha256,
  });

  return {
    pageId: row.page_id,
    docKey: docKeyFor({ pageId: row.page_id, externalRef: row.external_ref }),
    originContext: row.origin_context,
    subjectContext: row.subject_context,
    subjectConfidence: row.subject_confidence,
    sourceType: row.source_type as SourceType,
    externalRef: row.external_ref,
    title: row.title,
    body,
    verified: outcome.verified,
    expectedDigest: outcome.expected,
    actualDigest: outcome.actual,
    chunkCount: chunks.length,
  };
}

/** sha256 over a caller-supplied string. Used for the export manifest's own digest. */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
