/**
 * Folder import — the file-drop path, and the one place in this unit where
 * **idempotency is not enough**.
 *
 * "Skip what I have already seen" is the obvious design and it is wrong in two
 * directions, both of which corrupt retrieval rather than merely wasting work:
 *
 *   * **A file whose content changed must re-chunk and re-embed.** U4's
 *     `ingestDocument` already does exactly this when the digest moves — it
 *     tombstones the previous page and its chunks and facts, then writes the new
 *     one — so the requirement here is only that this module *asks*, on every
 *     scan, rather than short-circuiting on "I have this external ref". Skipping
 *     leaves superseded chunks ranking alongside their replacements.
 *   * **A file that has disappeared must be tombstoned.** Nothing else will ever
 *     do it: there is no delete event on a folder, only an absence. A page whose
 *     file is gone keeps answering queries, and — worse — U11's contradiction
 *     detector will later read that stale row against its live replacement and
 *     report a genuine-looking conflict, which is precisely the fabrication R8's
 *     upgrade prompt is built on.
 *
 * **The tombstone sweep runs only on a complete scan, and that is the single
 * most dangerous line in this unit.** A scan that stopped halfway — a permission
 * error, an unmounted volume, a cancelled job — reports fewer files than exist,
 * and a sweep keyed on "everything I did not see" would then tombstone the
 * user's entire corpus. So {@link FolderScan} carries `complete`, and
 * {@link tombstoneMissing} refuses outright when it is false. The refusal is
 * reported, not silent: an import that could not reconcile deletions has to say
 * so.
 *
 * **The sweep is scoped by origin *and* by an external-ref prefix**, and the
 * root id is validated against an anchored alphabet before it reaches the LIKE
 * pattern. `%` and `_` are LIKE metacharacters; a root id carrying one would
 * widen its own sweep across other roots — the same shape as R2's literal-prefix
 * hazard, one store over.
 *
 * **The filesystem is behind a port.** Not because a filesystem is a vendor, but
 * because `complete` is the property the whole module turns on and a test has to
 * be able to produce a scan that stopped.
 */

import type { SQL } from 'bun';

import { reconcileEdges } from '../../core/write/links.ts';

/** Every folder page's external ref starts here. */
export const FOLDER_REF_PREFIX = 'folder:';

/**
 * The root id alphabet. Anchored, and deliberately narrower than a filename:
 * this string is concatenated into a LIKE pattern, so it may not contain `%`,
 * `_`, or a path separator. It is a caller-chosen label for a folder, not the
 * folder's path.
 */
/** A file bigger than this is not a document somebody wrote. */
export const DEFAULT_MAX_FILE_BYTES = 2_000_000;

export const ROOT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface FolderEntry {
  /** Path relative to the scan root, `/`-separated. Part of the external ref. */
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly modifiedAt: Date | null;
}

export interface FolderScanFailure {
  readonly path: string;
  readonly reason: 'unreadable' | 'too_large' | 'not_text';
}

export interface FolderScan {
  /**
   * Whether the walk finished. **False disables the tombstone sweep.** A scan
   * that stopped early has not observed an absence, only its own failure.
   */
  readonly complete: boolean;
  readonly entries: readonly FolderEntry[];
  readonly failures: readonly FolderScanFailure[];
}

export interface FolderSource {
  scan(): Promise<FolderScan>;
}

export interface DecodedFile {
  readonly path: string;
  readonly title: string;
  readonly body: string;
  readonly modifiedAt: Date | null;
}

export interface TombstoneRequest {
  readonly rootId: string;
  readonly originContext: string;
  /** External refs the completed scan observed. Everything else under the root
   * prefix is gone. */
  readonly seenRefs: readonly string[];
  /** {@link FolderScan.complete}. False is a refusal, not a no-op to be ignored. */
  readonly complete: boolean;
}

export interface TombstoneResult {
  readonly tombstoned: number;
  /** True when the sweep declined to run because the scan was incomplete. */
  readonly skippedIncompleteScan: boolean;
  readonly pageIds: readonly string[];
  /** The refs that went, so the caller can write one ingest-log row each. */
  readonly externalRefs: readonly string[];
}

export class RootIdError extends Error {
  constructor(rootId: string) {
    super(
      `refusing a root id outside the anchored alphabet: ${JSON.stringify(rootId)} — this string is concatenated into a LIKE pattern, and '%' or '_' in it would widen the sweep across other roots`,
    );
    this.name = 'RootIdError';
  }
}

export function isScannableRootId(rootId: string): boolean {
  return ROOT_ID_PATTERN.test(rootId);
}

function assertScannableRootId(rootId: string): void {
  if (!isScannableRootId(rootId)) throw new RootIdError(rootId);
}

/** `folder:<rootId>/<relative path>`. The path is data, never a storage key —
 * `src/control/storage.ts` is the only place a key is derived. */
export function externalRefFor(rootId: string, relativePath: string): string {
  assertScannableRootId(rootId);
  const normalized = relativePath.split('\\').join('/').replace(/^\/+/, '');
  return `${FOLDER_REF_PREFIX}${rootId}/${normalized}`;
}

/** The prefix every page under this root shares. */
export function refPrefixFor(rootId: string): string {
  assertScannableRootId(rootId);
  return `${FOLDER_REF_PREFIX}${rootId}/`;
}

/**
 * What a scan observed — entries **and** the files it enumerated but could not
 * read.
 *
 * The failures belong in this set, and leaving them out is the subtle version
 * of the incomplete-scan hazard: a file whose read failed is present on disk,
 * so treating it as unseen tombstones a document over a transient permission
 * error. Absence is the only thing that may tombstone.
 */
export function seenRefsFrom(rootId: string, scan: FolderScan): string[] {
  return [
    ...scan.entries.map((entry) => externalRefFor(rootId, entry.path)),
    ...scan.failures.map((failure) => externalRefFor(rootId, failure.path)),
  ];
}

/**
 * Turn a scanned entry into a page's title and body.
 *
 * Text only, and the refusal is explicit: a binary file decoded leniently
 * becomes a page of replacement characters with a vector attached to it, which
 * costs an embedding call and pollutes retrieval with a document that says
 * nothing. `fatal: true` is what makes that a refusal rather than mojibake.
 * U21 owns the media path; what belongs here is the honest `null`.
 */
export function decodeEntry(entry: FolderEntry): DecodedFile | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(entry.bytes);
  } catch {
    return null;
  }
  // A NUL byte is legal UTF-8 and never appears in a document a human wrote.
  if (text.includes('\u0000')) return null;
  if (text.trim().length === 0) return null;

  return {
    path: entry.path,
    title: entry.path,
    body: text,
    modifiedAt: entry.modifiedAt,
  };
}

/**
 * Soft-delete the pages under this root that a **completed** scan did not see.
 *
 * Mirrors `commitWrite`'s replace order — facts, then chunks, then the page —
 * inside one transaction, and then reconciles the edges those facts implied
 * against what is left. A tombstoned page whose edges survive is a graph that
 * still answers with the deleted file's claims, which is exactly the stale row
 * U11's contradiction detector would later report as a genuine conflict.
 */
export async function tombstoneMissing(
  sql: SQL,
  request: TombstoneRequest,
): Promise<TombstoneResult> {
  assertScannableRootId(request.rootId);

  if (!request.complete) {
    // The whole point. A scan that stopped has observed its own failure, not an
    // absence, and "everything I did not see" is then the user's entire corpus.
    return { tombstoned: 0, skippedIncompleteScan: true, pageIds: [], externalRefs: [] };
  }

  const prefix = refPrefixFor(request.rootId);
  const live = (await sql`
    SELECT page_id::text AS page_id, external_ref
      FROM page
     WHERE origin_context = ${request.originContext}
       AND external_ref LIKE ${`${prefix}%`}
       AND deleted_at IS NULL
     ORDER BY page_id
  `) as Array<{ page_id: string; external_ref: string }>;

  const seen = new Set(request.seenRefs);
  const missing = live.filter((row) => !seen.has(row.external_ref));
  if (missing.length === 0) {
    return { tombstoned: 0, skippedIncompleteScan: false, pageIds: [], externalRefs: [] };
  }

  const settings = (await sql`
    SELECT taxonomy_version FROM tenant_setting LIMIT 1
  `) as Array<{ taxonomy_version: number }>;
  const taxonomyVersion = settings[0]?.taxonomy_version ?? 1;

  const pageIds = missing.map((row) => row.page_id);

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

    // Asked of the state this sweep is leaving behind: an edge is removed only
    // when no *live* fact still implies it, so a claim two files made survives
    // the deletion of one of them.
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
    skippedIncompleteScan: false,
    pageIds,
    externalRefs: missing.map((row) => row.external_ref),
  };
}

/**
 * A `FolderSource` over a real directory. Production wiring; the suite uses an
 * in-memory scan value, because `complete: false` has to be producible and a
 * real directory cannot be made to half-fail on demand.
 *
 * **`complete` is false only when the enumeration itself failed.** A file that
 * was listed and then could not be read is a *failure*, not an absence — it
 * goes in `failures`, {@link seenRefsFrom} keeps it out of the sweep, and the
 * scan is still complete.
 */
export function createDirectoryFolderSource(options: {
  readonly root: string;
  readonly maxBytes?: number;
}): FolderSource {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;

  return {
    async scan(): Promise<FolderScan> {
      let paths: string[];
      try {
        paths = [
          ...new Bun.Glob('**/*').scanSync({ cwd: options.root, onlyFiles: true }),
        ].sort();
      } catch {
        return { complete: false, entries: [], failures: [] };
      }

      const entries: FolderEntry[] = [];
      const failures: FolderScanFailure[] = [];

      for (const relative of paths) {
        const path = relative.split('\\').join('/');
        try {
          const file = Bun.file(`${options.root}/${relative}`);
          if (file.size > maxBytes) {
            failures.push({ path, reason: 'too_large' });
            continue;
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
          const modified = file.lastModified;
          entries.push({
            path,
            bytes,
            modifiedAt: Number.isFinite(modified) && modified > 0 ? new Date(modified) : null,
          });
        } catch {
          failures.push({ path, reason: 'unreadable' });
        }
      }

      return { complete: true, entries, failures };
    },
  };
}
