/**
 * `page_version` keys on `external_ref`, and `external_ref` is not a document.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 *
 * `external_ref` is the provider's own id. Nothing makes it unique across
 * origins — the schema carries no unique index on it, and two credentials
 * legitimately fetch the same object: a shared calendar event pulled by both a
 * work connector and a personal one is the ordinary case. `write-path.ts` says
 * exactly that above `livePageByRef`, and narrows its own replacement lookup to
 * `(external_ref, origin_context)` for it.
 *
 * `versions.ts` did not. Three of its statements treat "the row with this
 * `external_ref`" as "this document", and each one is a different failure:
 *
 *   1. **The superseded sweep's join.** `dead JOIN live ON external_ref` with no
 *      origin predicate. The module's own header says a page tombstoned by
 *      `forget` "shares its ref with nothing live and is deliberately *not*
 *      swept, because banking a copy of what a user just retracted is a `forget`
 *      that did not forget." That sentence is false the moment a *different*
 *      origin holds a live page with the same ref — the retracted document then
 *      has a live partner, is read as a predecessor, and is banked verbatim into
 *      `page_version`, whose foreign key is `ON DELETE SET NULL` precisely so the
 *      72h purge cannot reach it. A retraction becomes permanent retention.
 *
 *   2. **The capture's head lookup.** `SELECT … FROM page_version WHERE doc_key
 *      = $1 ORDER BY version DESC` and then "unchanged when the digest matches".
 *      Across origins that reads as: your document already has a version,
 *      because somebody else's identical document does. A shared calendar event
 *      is byte-identical in both mailboxes by construction, so this is the
 *      *typical* case rather than a contrived one, and the result is a document
 *      with no snapshot at all and an `ok: true, status: 'unchanged'` receipt
 *      naming a version number its owner cannot read.
 *
 *   3. **The revert's live-page lookup.** `WHERE external_ref = $docKey … ORDER
 *      BY page_id DESC LIMIT 1` — the newest page carrying the ref, in any
 *      origin. A work-scoped revert therefore banks a `pre_revert` snapshot of
 *      the *personal* page, which is a cross-origin read materialised into a new
 *      row by a credential that may not read it, and hands back an `undoVersion`
 *      the caller is then refused.
 *
 * Latent rather than live only because `versions.ts` has no production caller
 * (`upstream/concepts.jsonl:gap.data-lifecycle` is the row that says so). It is
 * fixed while the reason is fresh rather than when a caller lands.
 *
 * ============================================================================
 * WHAT THIS FILE DOES NOT CLAIM
 * ============================================================================
 *
 * **`doc_key` is still the bare `external_ref`, so one version *sequence* spans
 * both origins.** After the fences below, no row is banked from the wrong
 * origin and no digest is compared against the wrong origin's — but the numbers
 * are still allocated from a chain both share, so a fenced `listVersions` shows
 * `[1, 3]` where the other origin holds `2`. Closing that means folding the
 * origin into `doc_key`, which is a new rung (the unique index is
 * `(doc_key, version)`), a renumbering of existing rows, and a matching change
 * in `export/reconstruct.ts:docKeyFor` and `subject-erasure.ts:docKeyOf`. The
 * last test below pins the gap as an observed fact rather than leaving it to be
 * rediscovered, and the ledger row names it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  capturePageVersion,
  captureSupersededVersions,
  listVersions,
  revertPage,
} from '../../../src/core/lifecycle/versions.ts';
import { ingestDocument } from '../../../src/core/write/write-path.ts';
import {
  createIngestFixture,
  proseOf,
  setSpend,
  TENANT,
  uncappedBudget,
  type IngestFixture,
} from '../../ingest/fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 120_000;

const WORK = 'work:calendar';
const PERSONAL = 'personal:calendar';

let fixture: IngestFixture;

function body(marker: string): string {
  return `${marker}\n\n${proseOf(marker, 12)}`;
}

async function write(origin: string, ref: string, marker: string): Promise<string> {
  const receipt = await ingestDocument(
    { ...fixture.runtime, budget: uncappedBudget('versions-fence') },
    {
      originContext: origin,
      sourceType: 'calendar',
      title: 'The standup',
      body: body(marker),
      externalRef: ref,
    },
  );
  if (!receipt.ok) throw new Error(`fixture write failed: ${receipt.reason}`);
  return receipt.pageId;
}

async function livePageId(origin: string, ref: string): Promise<string> {
  const rows = (await fixture.tenantSql`
    SELECT page_id::text AS page_id FROM page
     WHERE external_ref = ${ref} AND origin_context = ${origin} AND deleted_at IS NULL
  `) as Array<{ page_id: string }>;
  const row = rows[0];
  if (row === undefined) throw new Error(`no live page for ${origin}/${ref}`);
  return row.page_id;
}

async function versionRows(
  ref: string,
): Promise<Array<{ version: number; origin_context: string; body: string; captured_from: string }>> {
  return (await fixture.tenantSql`
    SELECT version, origin_context, body, captured_from FROM page_version
     WHERE doc_key = ${ref} ORDER BY version
  `) as never;
}

beforeAll(async () => {
  fixture = await createIngestFixture('u17verfence');
  await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: 500_000_000 });
}, { timeout: SETUP_TIMEOUT_MS });

afterAll(async () => {
  await fixture?.close();
});

// ---------------------------------------------------------------------------
// 1. The sweep must not bank a retraction because another origin shares the ref.
// ---------------------------------------------------------------------------

describe('the superseded sweep does not cross an origin', () => {
  const REF = 'gcal:evt-retracted';

  test(
    'a page retracted by forget is not banked because a personal page shares its ref',
    async () => {
      // Both mailboxes hold the same shared event. Two live pages, one ref —
      // legal since the write path narrowed its replacement lookup to the origin.
      const workPage = await write(WORK, REF, 'work original');
      await write(PERSONAL, REF, 'personal original');

      // The user retracts the *work* copy. `forget` is a tombstone with a 72h
      // window; nothing about it says "and keep a verbatim copy forever".
      await fixture.tenantSql`
        UPDATE page SET deleted_at = now() WHERE page_id = ${workPage}::bigint`;
      await fixture.tenantSql`
        UPDATE chunk SET deleted_at = now() WHERE page_id = ${workPage}::bigint`;

      // The sweep runs on its ordinary schedule, over every origin.
      const swept = await captureSupersededVersions(fixture.tenantSql, {});

      const banked = await versionRows(REF);
      // The load-bearing assertion is the *absence*, and it is stated as the
      // property rather than as a count: nothing the user retracted may appear
      // in a table the TTL purge cannot reach.
      expect(banked.map((row) => row.body)).not.toContainEqual(
        expect.stringContaining('work original'),
      );
      expect(banked).toEqual([]);
      expect(swept.captured).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and a genuine same-origin predecessor is still swept, so the fence is not a mute button',
    async () => {
      const REF_REAL = 'gcal:evt-edited';
      await write(WORK, REF_REAL, 'work v1');
      await write(PERSONAL, REF_REAL, 'personal v1');
      // An edit in the work mailbox: U4 tombstones the predecessor and writes a
      // new page at the same ref and the same origin. That IS a supersession.
      await write(WORK, REF_REAL, 'work v2');

      const swept = await captureSupersededVersions(fixture.tenantSql, {});
      expect(swept.captured).toBe(1);

      const banked = await versionRows(REF_REAL);
      expect(banked).toHaveLength(1);
      expect(banked[0]?.origin_context).toBe(WORK);
      expect(banked[0]?.body).toContain('work v1');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. A document's first snapshot is not skipped because another origin's
//    identical document already has one.
// ---------------------------------------------------------------------------

describe('the capture compares a digest against its own origin', () => {
  const REF = 'gcal:evt-identical';

  test(
    'two identical copies of one shared event each get a version',
    async () => {
      // Byte-identical bodies. This is what a shared calendar event *is* — the
      // same event text pulled by two connectors — not a contrived collision.
      await write(WORK, REF, 'shared standup');
      await write(PERSONAL, REF, 'shared standup');

      const first = await capturePageVersion(fixture.tenantSql, {
        pageId: await livePageId(WORK, REF),
        capturedFrom: 'live',
      });
      expect(first.ok).toBe(true);

      const second = await capturePageVersion(fixture.tenantSql, {
        pageId: await livePageId(PERSONAL, REF),
        capturedFrom: 'live',
      });
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      // `unchanged` here means "you already have this version" said to somebody
      // who has none.
      expect(second.status).toBe('captured');

      const banked = await versionRows(REF);
      expect(banked.map((row) => row.origin_context).sort()).toEqual([PERSONAL, WORK]);

      // And each origin can actually read its own, which is the user-visible
      // half: a grant on one mailbox has a history for its own document.
      const personalOnly = await listVersions(fixture.tenantSql, { docKey: REF, grant: [PERSONAL] });
      expect(personalOnly).toHaveLength(1);
      expect(personalOnly[0]?.originContext).toBe(PERSONAL);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a second capture of the same page at the same digest is still unchanged',
    async () => {
      // The fence must not turn every scheduled sweep into a new row: the
      // `unchanged` short-circuit exists so a history is the three edits a user
      // made rather than a thousand identical snapshots.
      const again = await capturePageVersion(fixture.tenantSql, {
        pageId: await livePageId(WORK, REF),
        capturedFrom: 'live',
      });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.status).toBe('unchanged');
      expect(await versionRows(REF)).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. A revert reads the live page at the snapshot's own origin.
// ---------------------------------------------------------------------------

describe('revert resolves the live page inside the fence', () => {
  const REF = 'gcal:evt-revert';

  test(
    'a work-scoped revert banks the work page, not whichever page has the higher id',
    async () => {
      await write(WORK, REF, 'work first');
      const workVersion = await capturePageVersion(fixture.tenantSql, {
        pageId: await livePageId(WORK, REF),
        capturedFrom: 'live',
      });
      expect(workVersion.ok).toBe(true);
      if (!workVersion.ok) return;

      // Written second, so it carries the higher `page_id` — which is exactly
      // what the unfenced `ORDER BY page_id DESC LIMIT 1` selects.
      await write(PERSONAL, REF, 'personal newer');

      // The work grant edits its own copy, so there is something to revert *to*
      // and something distinguishable to revert *from*.
      await write(WORK, REF, 'work second');

      const outcome = await revertPage(
        { ...fixture.runtime, budget: uncappedBudget('versions-fence') },
        { docKey: REF, version: workVersion.version, grant: [WORK], now: new Date() },
      );
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      const preRevert = (await versionRows(REF)).filter((row) => row.captured_from === 'pre_revert');
      expect(preRevert).toHaveLength(1);
      // The whole assertion: the state the revert banked is the *work* state.
      // Unfenced, this row carries `personal:calendar` and the personal body —
      // a cross-origin read turned into a row by a credential that cannot read
      // it, and an `undoVersion` the caller is then refused.
      expect(preRevert[0]?.origin_context).toBe(WORK);
      expect(preRevert[0]?.body).toContain('work second');
      expect(preRevert[0]?.body).not.toContain('personal newer');

      // And the undo the receipt names is one this grant can actually read.
      const undo = outcome.undoVersion;
      expect(undo).not.toBeNull();
      if (undo === null) return;
      const readable = await listVersions(fixture.tenantSql, { docKey: REF, grant: [WORK] });
      expect(readable.map((version) => version.version)).toContain(undo);

      // The personal page is untouched throughout: a revert in one mailbox is
      // not an edit in another.
      const personal = (await fixture.tenantSql`
        SELECT count(*)::int AS n FROM page
         WHERE external_ref = ${REF} AND origin_context = ${PERSONAL} AND deleted_at IS NULL
      `) as Array<{ n: number }>;
      expect(personal[0]?.n).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 4. The half this change does NOT close, pinned rather than described.
// ---------------------------------------------------------------------------

describe('what is still shared across origins', () => {
  test(
    'the version SEQUENCE is one per external_ref, so a fenced history has gaps',
    async () => {
      const REF = 'gcal:evt-sequence';
      await write(WORK, REF, 'work only');
      await write(PERSONAL, REF, 'personal only');

      await capturePageVersion(fixture.tenantSql, {
        pageId: await livePageId(WORK, REF),
        capturedFrom: 'live',
      });
      await capturePageVersion(fixture.tenantSql, {
        pageId: await livePageId(PERSONAL, REF),
        capturedFrom: 'live',
      });

      // Both banked — that is the fix above. What is NOT fixed is the numbering:
      // `doc_key` is the bare `external_ref` and the unique index is
      // `(doc_key, version)`, so the two origins allocate from one sequence.
      const all = await versionRows(REF);
      expect(all.map((row) => row.version)).toEqual([1, 2]);

      // A grant on one mailbox therefore sees a history whose numbers skip. It
      // is not a disclosure — every row is fenced, and the bodies are not
      // readable — but "revert to version 2" is a number this caller can see
      // referenced and cannot use. Closing it is a rung, not an edit; see the
      // header and `upstream/concepts.jsonl:gap.data-lifecycle`.
      const workOnly = await listVersions(fixture.tenantSql, { docKey: REF, grant: [WORK] });
      expect(workOnly).toHaveLength(1);
      expect(workOnly[0]?.version).toBe(1);

      const personalOnly = await listVersions(fixture.tenantSql, { docKey: REF, grant: [PERSONAL] });
      expect(personalOnly).toHaveLength(1);
      expect(personalOnly[0]?.version).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );
});
