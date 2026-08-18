/**
 * Drive is metadata-only, asserted **at the runner seam**.
 *
 * The existing Drive tests (`sources/sources.test.ts`) drive the adapter
 * directly and assert what it returns. Every one of them was green for the
 * whole time Drive had never once recorded a successful run, because the defect
 * was not in the adapter's return value — it was in what the *runner* did with
 * it. Drive was the only adapter that populated `PullPage.media`; this
 * deployment composes the pull handler with neither a `TenantStorage` nor a
 * `RawStore`; step 7a counted every object failed, set `incomplete`, and step 10
 * then refused to save a cursor. Page one of the backfill replayed every thirty
 * minutes forever and no file after it was ever offered.
 *
 * So this file composes the **real** adapter and the **real** runner in
 * **production wiring** — no storage, no raw store, exactly as `worker/serve.ts`
 * builds the handler — and asserts the three things the adapter cannot say
 * about itself:
 *
 *   1. the run completes and **the cursor advances**;
 *   2. no `export` and no `alt=media` call is issued at all, for any file type;
 *   3. the page that lands is findable **by its filename**, which is now the
 *      whole value of the source.
 *
 * A test that asserts `page.media` is empty is not this test. `media` being
 * empty is a fact about one function's return; a cursor that advances is a fact
 * about the brain not being wedged.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { HOSTED_PROFILE } from '../../../src/ai/routing.ts';
import { ftsArm, readFtsLanguage } from '../../../src/core/search/arms.ts';
import {
  connectSource,
  createInMemoryConnectorStore,
  type ConnectorStateStore,
} from '../../../src/ingest/cursor.ts';
import { createPipedreamClient } from '../../../src/ingest/pipedream/client.ts';
import { originContextFor, runPull } from '../../../src/ingest/pipedream/pull.ts';
import { createDriveSource } from '../../../src/ingest/pipedream/sources/drive.ts';
import { externalRefFor } from '../../../src/ingest/pipedream/sources/types.ts';
import { TENANT, createIngestFixture, type IngestFixture } from '../fixture.ts';
import { CONFIG, createScriptedTransport, withToken, type ScriptedTransport } from './fixture.ts';

let fixture: IngestFixture;

const NOW = new Date('2026-08-13T10:00:00.000Z');
const DRIVE_ORIGIN = originContextFor('drive', null);
const UNPACED = { take: () => Promise.resolve() };

beforeAll(async () => {
  fixture = await createIngestFixture('u9drivemeta');
});

afterAll(async () => {
  await fixture.close();
});

function driveSource(transport: ScriptedTransport) {
  return createDriveSource(
    createPipedreamClient({ config: CONFIG, transport, now: () => NOW, rate: UNPACED }),
  );
}

async function driveStore(cursor: { kind: 'delta'; value: string } | null): Promise<ConnectorStateStore> {
  const store = createInMemoryConnectorStore();
  const state = connectSource({ source: 'drive', externalUserId: TENANT, accountId: 'apn_1', now: NOW });
  await store.write(
    cursor === null
      ? state
      : { ...state, cursor: { ...cursor, issuedAt: new Date(NOW.getTime() - 60_000).toISOString() } },
  );
  return store;
}

/**
 * **The production wiring, and the omission is the point.** `worker/serve.ts`
 * builds `createIngestPullHandler` with no `storage` and no `rawStore`. A test
 * that passed them would be testing a fleet nobody deploys — which is exactly
 * how the wedge survived a green suite.
 */
async function pull(transport: ScriptedTransport, states: ConnectorStateStore) {
  return runPull({
    tenant: fixture.runtime,
    control: fixture.controlSql,
    profile: HOSTED_PROFILE,
    source: driveSource(transport),
    states,
    now: NOW,
    interactive: false,
    window: 'all',
  });
}

/** Every upstream URL Google was asked for, decoded out of the proxy segment. */
function targets(transport: ScriptedTransport): readonly string[] {
  return transport.requests
    .filter((request) => request.url.includes('/proxy/'))
    .map((request) => request.target);
}

/**
 * One page of a Drive, in the shape the live listing answers with — measured
 * against a live account on 2026-08-17, with every name and address replaced.
 *
 * The five kinds that matter are all here, because under the old behaviour they
 * took five different routes and only one of them produced a page: a native Doc
 * (exported to text), a native Sheet (exported to CSV), a PDF and a PNG (both
 * fetched as bytes and then refused by a runner with nowhere to put them — the
 * `provider_error` that held the cursor), a video (refused outright), and an
 * empty Doc (exported to nothing and refused as `parse_failed`). Metadata-only
 * collapses all six into one route.
 */
const FILES: ReadonlyArray<Record<string, unknown>> = [
  {
    id: 'file-doc-000000000000000000000001',
    name: 'Widget Co board update',
    mimeType: 'application/vnd.google-apps.document',
    trashed: false,
    createdTime: '2026-01-04T09:00:00.000Z',
    modifiedTime: '2026-08-11T18:41:51.049Z',
    size: '5232',
    webViewLink: 'https://docs.example-drive.test/document/d/file-doc-000000000000000000000001/edit',
    owners: [{ displayName: 'alice-example', emailAddress: 'alice@widget-co.example' }],
  },
  {
    id: 'file-sheet-00000000000000000000001',
    name: 'Runway model 2026',
    mimeType: 'application/vnd.google-apps.spreadsheet',
    trashed: false,
    createdTime: '2025-11-02T09:00:00.000Z',
    modifiedTime: '2026-08-10T04:00:25.665Z',
    size: '142546',
    webViewLink: 'https://docs.example-drive.test/spreadsheets/d/file-sheet-00000000000000000000001/edit',
    owners: [{ displayName: 'charlie-example', emailAddress: 'charlie@acme-example.test' }],
  },
  {
    id: 'file-pdf-000000000000000000000001',
    name: 'Tax registration certificate.pdf',
    mimeType: 'application/pdf',
    trashed: false,
    createdTime: '2026-08-01T18:13:13.409Z',
    modifiedTime: '2026-08-01T18:11:43.000Z',
    size: '216327',
    webViewLink: 'https://drive.example-drive.test/file/d/file-pdf-000000000000000000000001/view',
    owners: [{ displayName: 'the-user', emailAddress: 'you@example.test' }],
  },
  {
    id: 'file-png-000000000000000000000001',
    name: 'wifi-password.png',
    mimeType: 'image/png',
    trashed: false,
    createdTime: '2026-07-01T10:00:00.000Z',
    modifiedTime: '2026-07-01T10:00:00.000Z',
    size: '278',
    webViewLink: 'https://drive.example-drive.test/file/d/file-png-000000000000000000000001/view',
    owners: [{ displayName: 'the-user', emailAddress: 'you@example.test' }],
  },
  {
    id: 'file-video-0000000000000000000001',
    name: 'demo-recording.mp4',
    mimeType: 'video/mp4',
    trashed: false,
    createdTime: '2026-06-01T10:00:00.000Z',
    modifiedTime: '2026-06-01T10:00:00.000Z',
    size: '48210993',
    webViewLink: 'https://drive.example-drive.test/file/d/file-video-0000000000000000000001/view',
    owners: [{ displayName: 'the-user', emailAddress: 'you@example.test' }],
  },
  {
    /**
     * **A file the provider described with nothing but an id.** The changes
     * feed does this for a file whose metadata the grant can no longer read.
     * It is the case that makes "the body is never empty" load-bearing rather
     * than incidental: `chunkDocument` returns no chunks for a blank body,
     * `ingestDocument` answers `empty_document`, and the item fails — the run
     * stops reporting a clean pull and the file is never written.
     */
    id: 'file-bare-0000000000000000000001',
  },
  {
    id: 'file-emptydoc-000000000000000001',
    name: 'Untitled document',
    mimeType: 'application/vnd.google-apps.document',
    trashed: false,
    createdTime: '2026-08-04T18:54:59.623Z',
    modifiedTime: '2026-08-04T19:03:48.357Z',
    size: '1024',
    webViewLink: 'https://docs.example-drive.test/document/d/file-emptydoc-000000000000000001/edit',
    owners: [{ displayName: 'the-user', emailAddress: 'you@example.test' }],
  },
];

const FOLDER = {
  id: 'folder-00000000000000000000000001',
  name: 'Board decks',
  mimeType: 'application/vnd.google-apps.folder',
  trashed: false,
  createdTime: '2024-01-01T00:00:00.000Z',
  modifiedTime: '2026-01-01T00:00:00.000Z',
  webViewLink: 'https://drive.example-drive.test/drive/folders/folder-00000000000000000000000001',
  owners: [{ displayName: 'the-user', emailAddress: 'you@example.test' }],
};

function backfillTransport(): ScriptedTransport {
  const transport = withToken(createScriptedTransport());
  transport.on('/drive/v3/changes/startPageToken', { status: 200, body: { startPageToken: 'p-100' } });
  transport.on('/drive/v3/files?', { status: 200, body: { files: [...FILES, FOLDER] } });
  // Anything else is a call this source must not make. A 500 rather than a 404
  // so a stray fetch fails loudly and is not mistaken for a missing file.
  transport.fallback({ status: 500, body: { error: 'this source asked for something it must not' } });
  return transport;
}

describe('a drive pull is metadata-only, and therefore completes', () => {
  test('the run completes, the cursor advances, and no file body is ever fetched', async () => {
    const transport = backfillTransport();
    const states = await driveStore(null);

    const result = await pull(transport, states);

    // **The whole bug, in two assertions.** Under the old behaviour this run
    // came back `stopped` with `provider_error` and `cursorAdvanced: false`,
    // because the PDF and the PNG arrived as `PullPage.media` and the runner
    // has nowhere to put them.
    expect(result.outcome).toBe('completed');
    expect(result.cursorAdvanced).toBe(true);
    expect(result.counts.failed).toBe(0);

    const saved = (await states.read('drive'))?.cursor ?? null;
    expect(saved?.kind).toBe('delta');
    expect(saved?.value).toBe('p-100');

    // Every non-folder file became a page. Six kinds, one route.
    expect(result.counts.written).toBe(FILES.length);

    // **No export, no download, for any type.** This is the founder's ruling
    // expressed as a property of the transport's own record rather than of a
    // return value: metadata only means the file's contents are never asked
    // for, not that they are asked for and then discarded.
    for (const target of targets(transport)) {
      expect(target).not.toContain('/export');
      expect(target).not.toContain('alt=media');
    }
    // And the count is exact: one token call and one listing. A per-file call
    // of any shape would show up here.
    expect(targets(transport).length).toBe(2);
  });

  test('the listing asks for exactly the fields the page is built from', async () => {
    const transport = backfillTransport();
    await pull(transport, await driveStore(null));

    const listing = targets(transport).find((target) => target.includes('/drive/v3/files?')) ?? '';
    const fields = new URL(listing).searchParams.get('fields') ?? '';
    for (const field of [
      'id',
      'name',
      'mimeType',
      'trashed',
      'createdTime',
      'modifiedTime',
      'size',
      'webViewLink',
      'owners(displayName,emailAddress)',
    ]) {
      expect(fields).toContain(field);
    }
    // A narrower projection is the point of the change: nothing that is not on
    // the page is asked for. `parents` needs a second call to become a name a
    // human recognises; `starred` and `shared` toggle without the file changing,
    // so they would rewrite and re-embed the page for nothing.
    for (const field of ['parents', 'starred', 'shared', 'fileExtension']) {
      expect(fields).not.toContain(field);
    }
  });

  test('a drive page is findable by its filename, and holds no document text', async () => {
    const transport = backfillTransport();
    await pull(transport, await driveStore(null));

    const sheetRef = externalRefFor('drive', 'file-sheet-00000000000000000000001');
    const pages = (await fixture.tenantSql`
      SELECT page_id::text AS page_id FROM page
       WHERE external_ref = ${sheetRef} AND origin_context = ${DRIVE_ORIGIN} AND deleted_at IS NULL
    `) as Array<{ page_id: string }>;
    expect(pages.length).toBe(1);

    const language = await readFtsLanguage(fixture.tenantSql);
    const found = await ftsArm(fixture.tenantSql, {
      query: 'Runway model 2026',
      grant: [DRIVE_ORIGIN],
      limit: 10,
      ftsLanguage: language,
    });

    // **Lexical recall is what makes a bare filename work.** The body is a
    // handful of labelled lines, so there is almost nothing for a vector to
    // hold on to; `content_tsv @@ tsq OR title_tsv @@ tsq` is the arm that
    // answers, and the title is the page's own filename.
    const hit = [...found.candidates.values()].find(
      (candidate) => candidate.pageId === pages[0]?.page_id,
    );
    expect(hit).toBeDefined();
    expect(hit?.title).toBe('Runway model 2026');

    // The page says what it is and where to open it, and says nothing else.
    expect(hit?.content).toContain('Runway model 2026');
    expect(hit?.content).toContain('https://docs.example-drive.test/spreadsheets/d/');
    expect(hit?.content).toContain('charlie-example');

    // And the whole page is small. A metadata page that grew past a few hundred
    // characters would be a content path that came back.
    const rows = (await fixture.tenantSql`
      SELECT coalesce(sum(length(c.content)), 0)::int AS chars
        FROM chunk c JOIN page p ON p.page_id = c.page_id
       WHERE p.origin_context = ${DRIVE_ORIGIN} AND c.deleted_at IS NULL
    `) as Array<{ chars: number }>;
    expect(rows[0]?.chars ?? 0).toBeLessThan(400 * (FILES.length + 1));
  });

  test('a second pull is unchanged, and a trashed file is still tombstoned', async () => {
    const transport = backfillTransport();
    const states = await driveStore(null);
    await pull(transport, states);

    const delta = withToken(createScriptedTransport());
    delta.on('/drive/v3/changes', {
      status: 200,
      body: {
        newStartPageToken: 'p-101',
        changes: [
          // Unchanged: the same metadata, so the same digest, so no rewrite.
          { fileId: FILES[0]!['id'], file: FILES[0] },
          // Trashed upstream: a tombstone, exactly as before.
          { fileId: FILES[1]!['id'], file: { ...FILES[1], trashed: true } },
        ],
      },
    });
    delta.fallback({ status: 500, body: { error: 'this source asked for something it must not' } });

    const second = await pull(delta, states);

    expect(second.outcome).toBe('completed');
    expect(second.cursorAdvanced).toBe(true);
    expect(second.counts.unchanged).toBe(1);
    expect(second.counts.tombstoned).toBe(1);
    // Idempotency has to cost nothing: the delta made one call, and it was the
    // changes feed.
    expect(targets(delta).length).toBe(1);
  });
});
