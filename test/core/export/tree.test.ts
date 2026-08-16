/**
 * The export tree, and the property the whole round-trip rests on: **exporting
 * an imported export gives back the same tree, byte for byte.**
 *
 * The self-host input format is U8's folder import — a directory of UTF-8 text
 * files where `decodeEntry` sets `title = path` and `body = the file's bytes`.
 * There is no frontmatter parser. So the fixed point is not free, and the two
 * decisions that buy it are the ones under test here:
 *
 *   * **The path comes from `external_ref`, not from the title.** A page that
 *     arrived through a folder import already has a path; re-exporting it re-uses
 *     that path with the root id stripped. No parsing, no heuristic, and no way
 *     for a title-derived path to drift on the second generation.
 *   * **A non-folder page's title is written into its body as a heading**, or a
 *     mail subject evaporates on the first round trip — `decodeEntry` would set
 *     the title to the file's path and the subject would exist nowhere.
 *
 * The generation-2 tree is therefore where the fixed point starts, and
 * `gen2 == gen3` is the assertion, not `gen1 == gen2`.
 */

import { describe, expect, test } from 'bun:test';

import {
  bodyFor,
  exportPathFor,
  planTree,
  treeDigest,
  type ExportedFile,
} from '../../../src/core/export/tree.ts';
import { docKeyFor, type ReconstructedPage } from '../../../src/core/export/reconstruct.ts';

function page(overrides: Partial<ReconstructedPage> = {}): ReconstructedPage {
  const pageId = overrides.pageId ?? '1';
  const externalRef = overrides.externalRef ?? null;
  const originContext = overrides.originContext ?? 'personal';
  return {
    pageId,
    // The key folds the origin in: `external_ref` carries no cross-origin
    // uniqueness, so a document is `(origin, ref)` rather than `ref`.
    docKey: docKeyFor({ originContext, pageId, externalRef }),
    originContext,
    subjectContext: null,
    subjectConfidence: null,
    sourceType: 'note',
    externalRef: null,
    title: 'A note',
    body: 'the body',
    verified: true,
    expectedDigest: 'a'.repeat(64),
    actualDigest: 'a'.repeat(64),
    chunkCount: 1,
    ...overrides,
  };
}

/**
 * What U8's folder import would make of an exported tree: one page per file,
 * `title = path`, `body = the bytes`, `external_ref = folder:<root>/<path>`.
 * Deliberately a re-statement of `decodeEntry` + `externalRefFor` rather than a
 * call into them — the point is to pin the *contract* this module round-trips
 * against, so a change on either side shows up here as a failure rather than as
 * two modules quietly agreeing on something new.
 */
function reimport(files: readonly ExportedFile[], rootId = 'restore'): ReconstructedPage[] {
  return files.map((file, index) =>
    page({
      pageId: String(100 + index),
      docKey: `personal|folder:${rootId}/${file.path}`,
      sourceType: 'file',
      externalRef: `folder:${rootId}/${file.path}`,
      title: file.path,
      body: file.body,
    }),
  );
}

describe('path derivation', () => {
  test('a folder page exports at its own relative path, with the root stripped', () => {
    const path = exportPathFor(
      page({ externalRef: 'folder:my-notes/journal/2026-04-03.md', title: 'journal/2026-04-03.md' }),
      new Set(),
    );
    expect(path).toBe('journal/2026-04-03.md');
  });

  test('a connector page gets a slug nested under its source type', () => {
    const path = exportPathFor(
      page({ pageId: '7', sourceType: 'email', externalRef: 'gmail:abc', title: 'Re: Lunch on Friday' }),
      new Set(),
    );
    expect(path).toBe('email/re-lunch-on-friday.md');
  });

  test('two pages that slug identically do not collide', () => {
    const taken = new Set<string>();
    const first = exportPathFor(page({ pageId: '7', sourceType: 'email', title: 'Hello' }), taken);
    taken.add(first);
    const second = exportPathFor(page({ pageId: '9', sourceType: 'email', title: 'Hello' }), taken);
    expect(first).toBe('email/hello.md');
    expect(second).not.toBe(first);
    expect(second).toContain('9');
  });

  test('a folder ref that tries to climb out of the tree is refused, not sanitised', () => {
    // The same rule `src/control/storage.ts` applies to object keys: an
    // untrusted remainder is validated, never cleaned up. A `..` here would put
    // a user's document outside the directory they asked for.
    expect(() =>
      exportPathFor(page({ externalRef: 'folder:root/../../etc/passwd' }), new Set()),
    ).toThrow(/relative path/i);
  });

  test('a page with no title still gets a path', () => {
    const path = exportPathFor(page({ pageId: '3', title: null, sourceType: 'chat' }), new Set());
    expect(path.startsWith('chat/')).toBe(true);
    expect(path.endsWith('.md')).toBe(true);
  });
});

describe('body derivation', () => {
  test('a connector page carries its title as a heading, because the format has nowhere else', () => {
    expect(bodyFor(page({ externalRef: 'gmail:abc', title: 'Lunch', body: 'at one' }))).toBe(
      '# Lunch\n\nat one\n',
    );
  });

  test('a folder page is written verbatim — its heading is already in its bytes', () => {
    expect(
      bodyFor(page({ externalRef: 'folder:r/notes/a.md', title: 'notes/a.md', body: '# Lunch\n\nat one\n' })),
    ).toBe('# Lunch\n\nat one\n');
  });
});

describe('the tree is a fixed point from generation two', () => {
  const brain: ReconstructedPage[] = [
    page({ pageId: '1', sourceType: 'email', externalRef: 'gmail:m1', title: 'Lunch on Friday', body: 'One.' }),
    page({ pageId: '2', sourceType: 'calendar', externalRef: 'gcal:e1', title: 'Standup', body: 'Two.' }),
    page({
      pageId: '3',
      sourceType: 'file',
      externalRef: 'folder:notes/deep/nested/file.md',
      title: 'deep/nested/file.md',
      body: '# Already a file\n\nThree.\n',
    }),
    page({ pageId: '4', sourceType: 'note', externalRef: null, title: 'A remembered thing', body: 'Four.' }),
  ];

  test('generation two and generation three are identical', () => {
    const gen1 = planTree(brain);
    const gen2 = planTree(reimport(gen1.files));
    const gen3 = planTree(reimport(gen2.files));

    expect(gen2.files).toEqual(gen3.files);
    expect(treeDigest(gen2.files)).toBe(treeDigest(gen3.files));
  });

  test('a mail subject survives the round trip, because it was written into the body', () => {
    // The reason the heading transform exists. `decodeEntry` sets `title = path`
    // on import, so a subject that lived only in `page.title` exists nowhere in
    // the re-imported brain. Asserted on generation two — after the round trip —
    // because that is where the loss would happen.
    const gen1 = planTree(brain);
    const gen2 = planTree(reimport(gen1.files));

    const mail = gen2.files.find((file) => file.path === 'email/lunch-on-friday.md');
    expect(mail).toBeDefined();
    expect(mail?.body).toContain('# Lunch on Friday');
  });

  test('the heading is written once, not once per generation', () => {
    // The failure the folder-verbatim branch prevents: a title prepended again
    // on every export grows the document by a line each round trip, forever.
    const gen1 = planTree(brain);
    const gen2 = planTree(reimport(gen1.files));
    const gen3 = planTree(reimport(gen2.files));

    const headings = (files: readonly ExportedFile[]) =>
      files
        .map((file) => file.body.split('\n').filter((line) => line.startsWith('# ')).length)
        .reduce((total, count) => total + count, 0);

    expect(headings(gen2.files)).toBe(headings(gen1.files));
    expect(headings(gen3.files)).toBe(headings(gen2.files));
  });

  test('every page in the brain reaches the tree exactly once', () => {
    const tree = planTree(brain);
    expect(tree.files).toHaveLength(brain.length);
    expect(new Set(tree.files.map((file) => file.path)).size).toBe(brain.length);
  });

  test('the tree is ordered, so two exports of an unchanged brain are the same bytes', () => {
    const forwards = planTree(brain);
    const backwards = planTree([...brain].reverse());
    expect(treeDigest(forwards.files)).toBe(treeDigest(backwards.files));
  });
});

describe('the manifest tells the truth about what could not be verified', () => {
  test('an unverified page is exported and named, not dropped and not hidden', () => {
    const tree = planTree([
      page({ pageId: '1', title: 'Fine', body: 'ok' }),
      page({ pageId: '2', title: 'Damaged', body: 'partial', verified: false }),
    ]);

    expect(tree.files).toHaveLength(2);
    expect(tree.manifest.unverified).toHaveLength(1);
    expect(tree.manifest.unverified[0]?.docKey).toBe('personal|page:2');
    expect(tree.manifest.pages).toBe(2);
  });

  test('a page that reconstructed to nothing is skipped and counted', () => {
    // An empty file is a page U8's importer would refuse (`decodeEntry` returns
    // null on whitespace), so exporting one would break the fixed point by
    // losing a file between generations. It is counted rather than silently
    // dropped.
    const tree = planTree([page({ pageId: '1', title: 'Empty', body: '   \n' })]);
    expect(tree.files).toHaveLength(0);
    expect(tree.manifest.skippedEmpty).toBe(1);
  });

  test('the manifest is not a file in the tree', () => {
    // If it were, re-importing the export would ingest it as a page and the
    // second generation would carry a document the first did not.
    const tree = planTree([page()]);
    expect(tree.files.some((file) => file.path.includes('manifest'))).toBe(false);
  });
});
