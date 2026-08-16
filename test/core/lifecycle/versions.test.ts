/**
 * Page versions and revert (R12), and the reason they cannot be an inference
 * over tombstoned rows.
 *
 * U4 replaces a changed document by tombstoning the previous page and writing a
 * new one, so a predecessor exists — for 72 hours, until
 * `purgeExpiredTombstones` hard-deletes it. A version history built on that is a
 * version history with a three-day memory, which is worse than none because the
 * user would otherwise have kept their own copy.
 *
 * **The trap this file is written against:** *"version revert passes trivially
 * with one version."* Every revert test below runs against a document with
 * **three** versions and reverts to the **first**, so a revert that quietly
 * restored "the most recent snapshot" — or "the only one" — fails.
 *
 * The second trap is subtler and is the reason `capturePageVersion` refuses:
 * a snapshot whose reconstruction did not verify against `page.content_sha256`
 * is not a version. Reverting to one would hand the user a document they never
 * wrote, with the product's full confidence behind it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { contentDigest, ingestDocument } from '../../../src/core/write/write-path.ts';
import {
  capturePageVersion,
  captureSupersededVersions,
  listVersions,
  revertPage,
} from '../../../src/core/lifecycle/versions.ts';
import {
  createIngestFixture,
  ORIGIN,
  proseOf,
  setSpend,
  TENANT,
  uncappedBudget,
  type IngestFixture,
} from '../../ingest/fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 120_000;
const REF = 'gmail:thread-1';
const GRANT = [ORIGIN];

let fixture: IngestFixture;

function body(marker: string): string {
  return `${marker}\n\n${proseOf(marker, 30)}`;
}

async function write(marker: string): Promise<void> {
  const receipt = await ingestDocument(
    { ...fixture.runtime, budget: uncappedBudget('revert') },
    {
      originContext: ORIGIN,
      sourceType: 'email',
      title: 'The thread',
      body: body(marker),
      externalRef: REF,
    },
  );
  if (!receipt.ok) throw new Error(`fixture write failed: ${receipt.reason}`);
}

async function livePageId(): Promise<string> {
  const rows = (await fixture.tenantSql`
    SELECT page_id::text AS page_id FROM page WHERE external_ref = ${REF} AND deleted_at IS NULL
  `) as Array<{ page_id: string }>;
  const row = rows[0];
  if (row === undefined) throw new Error('no live page');
  return row.page_id;
}

beforeAll(async () => {
  fixture = await createIngestFixture('u17ver');
  await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: 500_000_000 });

  // Three generations of one document. Each write tombstones its predecessor,
  // which is exactly the state the superseded sweep has to rescue.
  await write('one');
  await captureSupersededVersions(fixture.tenantSql, {});
  await capturePageVersion(fixture.tenantSql, { pageId: await livePageId(), capturedFrom: 'live' });

  await write('two');
  await captureSupersededVersions(fixture.tenantSql, {});

  await write('three');
  await captureSupersededVersions(fixture.tenantSql, {});
  // The sweep banks *predecessors*; the live head is captured explicitly, which
  // is what the scheduled export path does before it writes a tree.
  await capturePageVersion(fixture.tenantSql, { pageId: await livePageId(), capturedFrom: 'live' });
}, { timeout: SETUP_TIMEOUT_MS });

/** Set by the revert test and read by the undo test — the version the revert banked. */
let undoVersion: number | null = null;

afterAll(async () => {
  await fixture?.close();
});

describe('history is captured, and it is more than one deep', () => {
  test(
    'the document has three versions, oldest first',
    async () => {
      const versions = await listVersions(fixture.tenantSql, { docKey: REF, grant: GRANT });
      expect(versions.map((version) => version.version)).toEqual([1, 2, 3]);
      expect(versions[0]?.body).toContain('one');
      expect(versions[1]?.body).toContain('two');
      expect(versions[2]?.body).toContain('three');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'every captured body verifies against the digest it was captured at',
    async () => {
      const versions = await listVersions(fixture.tenantSql, { docKey: REF, grant: GRANT });
      for (const version of versions) {
        expect(contentDigest(version.title, version.body)).toBe(version.contentSha256);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'capturing the same content twice does not grow the history',
    async () => {
      const before = await listVersions(fixture.tenantSql, { docKey: REF, grant: GRANT });
      const outcome = await capturePageVersion(fixture.tenantSql, {
        pageId: await livePageId(),
        capturedFrom: 'live',
      });
      expect(outcome.ok).toBe(true);
      if (outcome.ok) expect(outcome.status).toBe('unchanged');
      const after = await listVersions(fixture.tenantSql, { docKey: REF, grant: GRANT });
      expect(after).toHaveLength(before.length);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a grant that cannot read the origin cannot read its history',
    async () => {
      expect(await listVersions(fixture.tenantSql, { docKey: REF, grant: ['work'] })).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a snapshot that will not verify is refused rather than written',
    async () => {
      // A chunk removed by hand stands in for a purge, a partial write, or a
      // row somebody deleted. The join still produces *a* document.
      const pageId = await livePageId();
      const [{ chunk_id: doomed } = { chunk_id: '' }] = (await fixture.tenantSql`
        SELECT chunk_id::text AS chunk_id FROM chunk
         WHERE page_id = ${pageId}::bigint AND deleted_at IS NULL
         ORDER BY ordinal OFFSET 1 LIMIT 1
      `) as Array<{ chunk_id: string }>;
      expect(doomed).not.toBe('');

      await fixture.tenantSql`UPDATE chunk SET deleted_at = now() WHERE chunk_id = ${doomed}::bigint`;
      try {
        const outcome = await capturePageVersion(fixture.tenantSql, { pageId, capturedFrom: 'live' });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.reason).toBe('unverifiable');
      } finally {
        await fixture.tenantSql`UPDATE chunk SET deleted_at = NULL WHERE chunk_id = ${doomed}::bigint`;
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a version outlives the 72h purge of the page it was captured from',
    async () => {
      // The whole reason this table exists. The predecessors are tombstoned;
      // age them past the TTL and purge, and the history must still be there.
      await fixture.tenantSql`
        UPDATE page SET deleted_at = now() - interval '96 hours'
         WHERE external_ref = ${REF} AND deleted_at IS NOT NULL
      `;
      const { purgeExpiredTombstones } = await import('../../../src/mcp/tombstone.ts');
      await purgeExpiredTombstones(fixture.tenantSql, { now: new Date() });

      const survivors = await listVersions(fixture.tenantSql, { docKey: REF, grant: GRANT });
      expect(survivors.map((version) => version.version)).toEqual([1, 2, 3]);
      // And the rows they came from really are gone, or the test proves nothing.
      const remaining = (await fixture.tenantSql`
        SELECT count(*)::int AS n FROM page WHERE external_ref = ${REF} AND deleted_at IS NOT NULL
      `) as Array<{ n: number }>;
      expect(remaining[0]?.n).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('revert', () => {
  test(
    'reverting to the FIRST of three versions restores the first, not the last',
    async () => {
      const outcome = await revertPage(
        { ...fixture.runtime, budget: uncappedBudget('revert') },
        { docKey: REF, version: 1, grant: GRANT, now: new Date() },
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      undoVersion = outcome.undoVersion;

      const { reconstructPage } = await import('../../../src/core/export/reconstruct.ts');
      const live = await reconstructPage(fixture.tenantSql, await livePageId());
      expect(live?.body).toContain('one');
      expect(live?.body).not.toContain('three');
      expect(live?.verified).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the revert names the version holding the state it replaced, and that undo works',
    async () => {
      // Not "a row labelled pre_revert exists" — that is a claim about a column.
      // The property is that the state the user was on is still reachable and
      // that going back to it restores what they had.
      expect(undoVersion).not.toBeNull();
      const banked = (await listVersions(fixture.tenantSql, { docKey: REF, grant: GRANT })).find(
        (version) => version.version === undoVersion,
      );
      expect(banked?.body).toContain('three');

      const undone = await revertPage(
        { ...fixture.runtime, budget: uncappedBudget('revert') },
        { docKey: REF, version: undoVersion!, grant: GRANT, now: new Date() },
      );
      expect(undone.ok).toBe(true);

      const { reconstructPage } = await import('../../../src/core/export/reconstruct.ts');
      const live = await reconstructPage(fixture.tenantSql, await livePageId());
      expect(live?.body).toContain('three');
      expect(live?.body).not.toContain('one\n');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a grant that cannot read the origin cannot revert it',
    async () => {
      const outcome = await revertPage(
        { ...fixture.runtime, budget: uncappedBudget('revert') },
        { docKey: REF, version: 2, grant: ['work'], now: new Date() },
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe('scope_denied');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a version that does not exist is a typed refusal, not a silent no-op',
    async () => {
      const outcome = await revertPage(
        { ...fixture.runtime, budget: uncappedBudget('revert') },
        { docKey: REF, version: 99, grant: GRANT, now: new Date() },
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toBe('not_found');
    },
    TEST_TIMEOUT_MS,
  );
});
