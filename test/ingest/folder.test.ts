/**
 * Folder import: the half of ingestion that idempotency alone does not cover.
 *
 * "Skip what I have already seen" is a correct-looking rule that produces two
 * wrong corpora. A file whose content changed keeps its superseded chunks
 * ranking next to their replacements; a file that was deleted keeps answering
 * queries forever, because a folder emits no delete event — only an absence.
 * Both are worse than a wasted embedding call, and the second one is worse
 * still downstream: U11's contradiction detector reads the stale row against
 * its live replacement and reports a conflict that never existed.
 *
 * So the sweep exists — and the sweep is the most dangerous code in this unit,
 * because its input is *everything I did not see*. A scan that stopped halfway
 * has not observed an absence, it has observed its own failure, and a sweep
 * that cannot tell the difference deletes the user's corpus. That test is the
 * first one below for a reason.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { ingestDocument } from '../../src/core/write/write-path.ts';
import {
  FOLDER_REF_PREFIX,
  decodeEntry,
  externalRefFor,
  isScannableRootId,
  seenRefsFrom,
  tombstoneMissing,
} from '../../src/ingest/import/folder.ts';
import {
  CALLER,
  TENANT,
  countRows,
  createIngestFixture,
  proseOf,
  uncappedBudget,
  type IngestFixture,
} from './fixture.ts';

let fixture: IngestFixture;

const ROOT = 'notes';
const ORIGIN_FOLDER = 'folder:notes';

beforeAll(async () => {
  fixture = await createIngestFixture('u8folder');
});

afterAll(async () => {
  await fixture.close();
});

async function seedFile(path: string, body: string, origin = ORIGIN_FOLDER): Promise<string> {
  const externalRef = externalRefFor(ROOT, path);
  const receipt = await ingestDocument(
    {
      sql: fixture.tenantSql,
      gateway: fixture.gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
    },
    { originContext: origin, sourceType: 'document', title: path, body, externalRef },
  );
  if (!receipt.ok) throw new Error(`fixture ingest failed: ${receipt.reason}`);
  return externalRef;
}

async function livePages(): Promise<number> {
  return countRows(fixture.tenantSql, 'page', 'deleted_at IS NULL');
}

async function reset(): Promise<void> {
  await fixture.tenantSql`DELETE FROM fact_source`;
  await fixture.tenantSql`DELETE FROM entity_edge`;
  await fixture.tenantSql`UPDATE fact SET superseded_by = NULL`;
  await fixture.tenantSql`DELETE FROM fact`;
  await fixture.tenantSql`DELETE FROM entity_alias`;
  await fixture.tenantSql`DELETE FROM entity`;
  await fixture.tenantSql`DELETE FROM chunk`;
  await fixture.tenantSql`UPDATE page SET ingest_id = NULL`;
  await fixture.tenantSql`DELETE FROM page`;
  await fixture.tenantSql`DELETE FROM ingest_log`;
}

describe('an incomplete scan never tombstones anything', () => {
  test('the sweep refuses outright, and says it refused', async () => {
    await reset();
    await seedFile('a.md', proseOf('alpha', 4));
    await seedFile('b.md', proseOf('bravo', 4));
    expect(await livePages()).toBe(2);

    const result = await tombstoneMissing(fixture.tenantSql, {
      rootId: ROOT,
      originContext: ORIGIN_FOLDER,
      // The scan saw nothing at all — an unmounted volume, a permission error.
      seenRefs: [],
      complete: false,
    });

    expect(result.skippedIncompleteScan).toBe(true);
    expect(result.tombstoned).toBe(0);
    expect(result.pageIds).toEqual([]);
    // The corpus that a naive sweep would have deleted in full.
    expect(await livePages()).toBe(2);
  });
});

describe('a completed scan reconciles deletions', () => {
  test('a file that disappeared is tombstoned, with its chunks and facts', async () => {
    await reset();
    const kept = await seedFile('a.md', proseOf('alpha', 4));
    await seedFile('gone.md', proseOf('bravo', 4));
    expect(await livePages()).toBe(2);

    const result = await tombstoneMissing(fixture.tenantSql, {
      rootId: ROOT,
      originContext: ORIGIN_FOLDER,
      seenRefs: [kept],
      complete: true,
    });

    expect(result.skippedIncompleteScan).toBe(false);
    expect(result.tombstoned).toBe(1);
    expect(await livePages()).toBe(1);
    // It drops out of retrieval, which means its chunks go with it.
    expect(
      await countRows(
        fixture.tenantSql,
        'chunk c JOIN page p ON p.page_id = c.page_id',
        `p.external_ref = '${externalRefFor(ROOT, 'gone.md')}' AND c.deleted_at IS NULL`,
      ),
    ).toBe(0);
    expect(
      await countRows(
        fixture.tenantSql,
        'fact f JOIN page p ON p.page_id = f.page_id',
        `p.external_ref = '${externalRefFor(ROOT, 'gone.md')}' AND f.deleted_at IS NULL`,
      ),
    ).toBe(0);
  });

  test('it is scoped to its own root — another folder is untouched', async () => {
    await reset();
    await seedFile('a.md', proseOf('alpha', 4));
    const otherRef = externalRefFor('archive', 'a.md');
    const receipt = await ingestDocument(
      {
        sql: fixture.tenantSql,
        gateway: fixture.gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget(),
      },
      {
        originContext: ORIGIN_FOLDER,
        sourceType: 'document',
        title: 'a.md',
        body: proseOf('charlie', 4),
        externalRef: otherRef,
      },
    );
    expect(receipt.ok).toBe(true);

    const result = await tombstoneMissing(fixture.tenantSql, {
      rootId: ROOT,
      originContext: ORIGIN_FOLDER,
      seenRefs: [],
      complete: true,
    });
    expect(result.tombstoned).toBe(1);
    expect(
      await countRows(fixture.tenantSql, 'page', `external_ref = '${otherRef}' AND deleted_at IS NULL`),
    ).toBe(1);
  });

  test('and to its own origin — a page fetched through another credential stays', async () => {
    await reset();
    await seedFile('a.md', proseOf('alpha', 4), 'folder:other-credential');

    const result = await tombstoneMissing(fixture.tenantSql, {
      rootId: ROOT,
      originContext: ORIGIN_FOLDER,
      seenRefs: [],
      complete: true,
    });
    expect(result.tombstoned).toBe(0);
    expect(await livePages()).toBe(1);
  });

  test('a page already tombstoned is not tombstoned twice', async () => {
    await reset();
    await seedFile('gone.md', proseOf('bravo', 4));
    const first = await tombstoneMissing(fixture.tenantSql, {
      rootId: ROOT,
      originContext: ORIGIN_FOLDER,
      seenRefs: [],
      complete: true,
    });
    const second = await tombstoneMissing(fixture.tenantSql, {
      rootId: ROOT,
      originContext: ORIGIN_FOLDER,
      seenRefs: [],
      complete: true,
    });
    expect(first.tombstoned).toBe(1);
    expect(second.tombstoned).toBe(0);
  });
});

describe('the root id is validated before it reaches a LIKE pattern', () => {
  test('the alphabet excludes both LIKE metacharacters and the separator', () => {
    expect(isScannableRootId('notes')).toBe(true);
    expect(isScannableRootId('notes-2026')).toBe(true);
    expect(isScannableRootId('note%')).toBe(false);
    expect(isScannableRootId('note_s')).toBe(false);
    expect(isScannableRootId('notes/sub')).toBe(false);
    expect(isScannableRootId('Notes')).toBe(false);
    expect(isScannableRootId('')).toBe(false);
    expect(isScannableRootId('-leading')).toBe(false);
  });

  test('a root id that would widen its own sweep is refused, not escaped', async () => {
    await expect(
      tombstoneMissing(fixture.tenantSql, {
        rootId: 'note%',
        originContext: ORIGIN_FOLDER,
        seenRefs: [],
        complete: true,
      }),
    ).rejects.toThrow(/root id/i);
  });

  test('an external ref names its root and its path, and nothing else', () => {
    expect(externalRefFor(ROOT, 'sub/dir/a.md')).toBe(`${FOLDER_REF_PREFIX}notes/sub/dir/a.md`);
    expect(() => externalRefFor('note%', 'a.md')).toThrow(/root id/i);
  });
});

describe('a file that could not be read is not a file that is gone', () => {
  test('the seen set includes the scan failures, so a read error never tombstones', async () => {
    await reset();
    await seedFile('locked.md', proseOf('alpha', 4));
    await seedFile('fine.md', proseOf('bravo', 4));

    // The scan enumerated both and could only read one. `complete` is true —
    // the walk finished — so the sweep runs, and the unreadable file must still
    // be treated as present.
    const scan = {
      complete: true,
      entries: [{ path: 'fine.md', bytes: new Uint8Array(), modifiedAt: null }],
      failures: [{ path: 'locked.md', reason: 'unreadable' as const }],
    };

    const result = await tombstoneMissing(fixture.tenantSql, {
      rootId: ROOT,
      originContext: ORIGIN_FOLDER,
      seenRefs: seenRefsFrom(ROOT, scan),
      complete: scan.complete,
    });

    expect(result.tombstoned).toBe(0);
    expect(await livePages()).toBe(2);
  });

  test('and dropping the failures from the seen set is what deletes it', async () => {
    // The same sweep with the entries only — stated so the guard above has a
    // visible counterfactual rather than being a test that always passes.
    const result = await tombstoneMissing(fixture.tenantSql, {
      rootId: ROOT,
      originContext: ORIGIN_FOLDER,
      seenRefs: [externalRefFor(ROOT, 'fine.md')],
      complete: true,
    });
    expect(result.tombstoned).toBe(1);
  });
});

describe('decoding is text-only, and says so', () => {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

  test('a text file becomes a title and a body', () => {
    const decoded = decodeEntry({
      path: 'sub/notes.md',
      bytes: encode('# Heading\n\nSome content.'),
      modifiedAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    expect(decoded).not.toBeNull();
    expect(decoded!.title).toBe('sub/notes.md');
    expect(decoded!.body).toBe('# Heading\n\nSome content.');
  });

  test('a binary file is null rather than a page of mojibake with a vector on it', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
    expect(decodeEntry({ path: 'chart.png', bytes: png, modifiedAt: null })).toBeNull();
  });

  test('invalid UTF-8 with no NUL byte is still refused', () => {
    // The PNG above carries a NUL, so it is caught twice over. This one is
    // caught only by the strict decode — which is the guard being pinned.
    const latin1 = new Uint8Array([0xff, 0xfe, 0x41, 0x42, 0x43]);
    expect(decodeEntry({ path: 'notes.txt', bytes: latin1, modifiedAt: null })).toBeNull();
  });

  test('an empty file is null: there is nothing to chunk', () => {
    expect(decodeEntry({ path: 'empty.md', bytes: encode('   \n\n'), modifiedAt: null })).toBeNull();
  });
});
