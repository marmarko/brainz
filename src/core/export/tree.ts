/**
 * The exported tree: slug-nested markdown, identical to the self-host input
 * format (R18).
 *
 * "Identical to the self-host input format" is a testable claim rather than a
 * description, and this module is built around making it one. The self-host
 * format is U8's folder import: a directory of UTF-8 text files where
 * `decodeEntry` sets `title = path` and `body = the file's bytes`, and an
 * `external_ref` of `folder:<rootId>/<relative path>` is written for each. There
 * is no frontmatter parser on that path, and adding one would be an edit to
 * another unit's module.
 *
 * ============================================================================
 * THE FIXED POINT, AND THE TWO DECISIONS THAT BUY IT
 * ============================================================================
 *
 * **The path comes from `external_ref`.** A page that arrived through a folder
 * import already *has* a path; re-exporting it re-uses that path with the root
 * id stripped. That is what makes export∘import∘export a fixed point without any
 * title parsing: the first export writes `notes/foo.md`, a re-import under any
 * root writes `folder:<root>/notes/foo.md`, and the second export strips the
 * root and writes `notes/foo.md` again. Everything else — mail, calendar,
 * `remember` notes — has no path, so it gets a slug nested under its source
 * type.
 *
 * **A non-folder page's title becomes a heading in its body.** Otherwise a mail
 * subject evaporates on the first round trip: `decodeEntry` sets the title to
 * the file's path, and the subject exists nowhere in the re-imported brain. The
 * transform is not applied twice, because from generation two every page *is* a
 * folder page and is written verbatim. So `gen2 == gen3` is the property, and it
 * is what `test/core/export/tree.test.ts` asserts — not `gen1 == gen2`, which is
 * false by design and would be "fixed" by deleting the heading.
 *
 * **The manifest is not a file in the tree.** If it were, re-importing the export
 * would ingest it as a page and the second generation would carry a document the
 * first did not. It is returned beside the tree, and a destination writer places
 * it outside the import root.
 *
 * **What is not here: model-derived artifacts.** Entity cards, salience,
 * commitments and edges are re-derived on import at re-consolidation cost (R18).
 * That is exactly why file parity is not knowledge parity, and why
 * `bun run test:roundtrip` exists as a second, model-calling leg.
 */

import { slugify } from '../write/normalize.ts';
import { sha256, type ReconstructedPage } from './reconstruct.ts';

/** Where a folder page's `external_ref` starts. U8 owns the constant; this is the read side. */
const FOLDER_REF_PREFIX = 'folder:';

export interface ExportedFile {
  /** Relative to the export root, `/`-separated. Never absolute, never `..`. */
  readonly path: string;
  readonly body: string;
}

export interface UnverifiedPage {
  readonly docKey: string;
  readonly path: string;
  readonly expectedDigest: string;
  readonly actualDigest: string;
}

export interface ExportManifest {
  readonly pages: number;
  /**
   * Pages whose reconstruction could not reproduce `page.content_sha256`.
   * They ARE in the tree — a backup missing a document without saying so is
   * worse than one that marks it — and they are named here so the user finds
   * out before the day they need it.
   */
  readonly unverified: readonly UnverifiedPage[];
  /** Pages that reconstructed to nothing, which U8's importer would refuse. */
  readonly skippedEmpty: number;
  /** sha256 over the whole tree. Two exports of an unchanged brain match. */
  readonly digest: string;
}

export interface ExportTree {
  readonly files: readonly ExportedFile[];
  readonly manifest: ExportManifest;
}

export class ExportPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportPathError';
  }
}

/**
 * The relative path a page exports at.
 *
 * `taken` is the set of paths already claimed by this run; a page whose slug
 * collides gets its page id appended rather than overwriting its neighbour. The
 * caller owns the set, because uniqueness is a property of the tree and not of
 * any one page.
 */
export function exportPathFor(page: ReconstructedPage, taken: ReadonlySet<string>): string {
  const folderPath = folderRelativePath(page.externalRef);
  if (folderPath !== null) return folderPath;

  const slug = slugify(page.title ?? page.docKey);
  const base = `${page.sourceType}/${slug}`;
  const candidate = `${base}.md`;
  if (!taken.has(candidate)) return candidate;
  return `${base}-${page.pageId}.md`;
}

/**
 * The relative path inside a folder ref, or `null` when the page has none.
 *
 * **Validated, never sanitised** — the same rule `src/control/storage.ts`
 * applies to an object key. A ref carrying `..` would write a user's document
 * outside the directory they asked to export into, and a sanitiser is a losing
 * game against every encoding nobody has thought of yet.
 */
function folderRelativePath(externalRef: string | null): string | null {
  if (externalRef === null || !externalRef.startsWith(FOLDER_REF_PREFIX)) return null;

  const withoutPrefix = externalRef.slice(FOLDER_REF_PREFIX.length);
  const separator = withoutPrefix.indexOf('/');
  if (separator < 0) return null;

  const relative = withoutPrefix.slice(separator + 1);
  if (relative.length === 0) {
    throw new ExportPathError(`folder ref ${JSON.stringify(externalRef)} names no relative path`);
  }
  if (
    relative.startsWith('/') ||
    relative.includes('\\') ||
    relative.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')
  ) {
    throw new ExportPathError(
      `folder ref ${JSON.stringify(externalRef)} is not a safe relative path — a traversal here writes outside the export root`,
    );
  }
  return relative;
}

/**
 * The bytes a page exports as.
 *
 * A folder page is verbatim: whatever heading it has is already inside its own
 * text, and prepending a second one on every generation would make the tree grow
 * a title per round trip. Everything else gets its title as an H1, because the
 * format has nowhere else to put one.
 */
export function bodyFor(page: ReconstructedPage): string {
  const body = page.body;
  if (folderRelativePath(page.externalRef) !== null) return body;

  const title = page.title?.trim() ?? '';
  if (title.length === 0) return endsWithNewline(body);
  return endsWithNewline(`# ${title}\n\n${body}`);
}

function endsWithNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * Turn reconstructed pages into the tree and its manifest.
 *
 * Pure — it takes pages and returns files — so the fixed-point property is
 * testable without a database, and so the destination writer (object store,
 * user bucket, a zip a browser downloads) is a separate concern that cannot
 * change what the tree *is*.
 *
 * **Ordered by doc key**, not by insertion, so two exports of an unchanged brain
 * are byte-identical whatever order the rows came back in.
 */
export function planTree(pages: readonly ReconstructedPage[]): ExportTree {
  const ordered = [...pages].sort((left, right) => (left.docKey < right.docKey ? -1 : left.docKey > right.docKey ? 1 : 0));

  const files: ExportedFile[] = [];
  const unverified: UnverifiedPage[] = [];
  const taken = new Set<string>();
  let skippedEmpty = 0;

  for (const page of ordered) {
    if (page.body.trim().length === 0) {
      // U8's `decodeEntry` refuses a whitespace-only file, so exporting one
      // would lose a document between generations and break the fixed point.
      skippedEmpty += 1;
      continue;
    }

    const path = exportPathFor(page, taken);
    taken.add(path);
    files.push({ path, body: bodyFor(page) });

    if (!page.verified) {
      unverified.push({
        docKey: page.docKey,
        path,
        expectedDigest: page.expectedDigest,
        actualDigest: page.actualDigest,
      });
    }
  }

  return {
    files,
    manifest: {
      pages: files.length,
      unverified,
      skippedEmpty,
      digest: treeDigest(files),
    },
  };
}

/**
 * One digest over the whole tree.
 *
 * Path and body length are both folded in, so two files whose contents
 * concatenate to the same bytes cannot produce the same digest as one file —
 * the length prefix is what stops `a.md`+`b` and `a.mdb`+`` from colliding.
 */
export function treeDigest(files: readonly ExportedFile[]): string {
  const parts = [...files]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map((file) => `${file.path}\u0000${file.body.length}\u0000${file.body}`);
  return sha256(parts.join('\u0001'));
}
