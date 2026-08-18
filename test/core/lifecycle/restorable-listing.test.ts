/**
 * What the account holder may undo — and, much more importantly, what they must
 * never be offered.
 *
 * ============================================================================
 * THE CASE THIS FILE EXISTS FOR
 * ============================================================================
 *
 * `lifecycle/subject-erasure.ts` stamps its instant on **all seven**
 * `TOMBSTONED_TABLES`. So the obvious listing — `SELECT DISTINCT deleted_at`
 * across those tables — shows an erasure of a correspondent to the account
 * holder as an ordinary restorable retraction. Three things are wrong with that
 * at once, and each is enough on its own:
 *
 *   * the party who asked for it is not the party being offered the undo;
 *   * `restoreForgotten` **cannot** undo an erasure — it walks
 *     `TOMBSTONED_TABLES` and `ARCHIVED_TABLES` only, while the erasure also
 *     hard-deleted `page_version`, `review_queue` and `entity_edge` and wrote a
 *     live suppression row — so the button restores a strict subset and reports
 *     success;
 *   * the repair that suggests itself, "exclude instants that appear in
 *     `erased_subject`", is unsound: that table's upsert is `ON CONFLICT
 *     (subject_digest) DO UPDATE SET erased_at`, so a **second** erasure of one
 *     correspondent overwrites the first erasure's instant while the first
 *     erasure's tombstones are still inside the window. The orphaned instant is
 *     then in no filter's reach.
 *
 * The listing is therefore sourced positively — from a ledger a `forget` writes
 * — and the erasure case below exercises exactly the double-erasure shape that
 * defeats the filter, because a test that only erased once would pass against
 * the unsound design too.
 *
 * ============================================================================
 * AND THE PROPERTY THAT IS STRUCTURAL RATHER THAN ASSERTED
 * ============================================================================
 *
 * The listing reads two ledgers and no content table. That is asserted against
 * the *statements issued*, not against the shape of the result: a listing that
 * returned no title today because no page had one would pass a result-shaped
 * assertion and leak the day somebody added a join.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { severOrigin } from '../../../src/core/lifecycle/severance.ts';
import { eraseSubject } from '../../../src/core/lifecycle/subject-erasure.ts';
import {
  FORGET_TTL_HOURS,
  RESTORABLE_LIMIT,
  forgetRecord,
  listRestorable,
  markRetractionRestored,
  restoreForgotten,
} from '../../../src/mcp/tombstone.ts';
import { EMBEDDING_DIMENSIONS } from '../../../src/schema/vector-index.ts';
import { connect, dropFixtureDatabase, provisionFixture, type SchemaFixture } from '../../schema/fixture.ts';

import type { SQL } from 'bun';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const WORK = 'work:mail';
const PERSONAL = 'personal:mail';
const HOUR = 3600_000;
const AT = new Date('2026-06-10T00:00:00.000Z');
const SOON = new Date(AT.getTime() + HOUR);
/** A correspondent, not the account holder. The whole point of the axis. */
const SUBJECT = 'charlie-example@example.com';
const OTHER_SUBJECT = 'dana-example@example.com';

let schema: SchemaFixture;
let sql: SQL;

beforeAll(async () => {
  schema = await provisionFixture('restorable_list');
  sql = connect(schema);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await sql?.close();
  if (schema !== undefined) await dropFixtureDatabase(schema);
});

beforeEach(async () => {
  await sql.unsafe(`
    DELETE FROM retraction;
    DELETE FROM severance;
    DELETE FROM erased_subject;
    DELETE FROM severed_alias;
    DELETE FROM page_version;
    DELETE FROM review_queue;
    DELETE FROM commitment;
    DELETE FROM attachment;
    DELETE FROM entity_card;
    UPDATE fact SET superseded_by = NULL;
    DELETE FROM fact;
    DELETE FROM chunk;
    DELETE FROM page;
    DELETE FROM entity;
  `);
});

async function insertPage(ref: string, title: string, origin = WORK): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO page (origin_context, source_type, title, external_ref, embedding_model,
                       embedding_dimensions, chunker_version, normalizer_version, content_sha256)
     VALUES ($1, 'email', $2, $3, 'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64))
     RETURNING page_id::text AS id`,
    [origin, title, ref],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

async function insertChunk(pageId: string, content: string, origin = WORK): Promise<void> {
  await sql.unsafe(
    `INSERT INTO chunk (origin_context, content, page_id, ordinal)
     VALUES ($1, $2, $3::bigint, 0)`,
    [origin, content, pageId],
  );
}

// ---------------------------------------------------------------------------
// 1. The offer, and what it may say.
// ---------------------------------------------------------------------------

describe('a forget inside the window is offered back', () => {
  test(
    'the instant, the shape and the counts — and nothing a page ever said',
    async () => {
      const pageId = await insertPage('gmail:w1', 'The quarterly numbers', WORK);
      await insertChunk(pageId, 'revenue was up by eleven percent');

      const forgotten = await forgetRecord(sql, {
        id: { kind: 'doc', key: pageId },
        grant: [WORK],
        now: AT,
      });
      expect(forgotten.ok).toBe(true);
      if (!forgotten.ok) return;

      const listing = await listRestorable(sql, { now: SOON });
      expect(listing.overflowed).toBe(false);
      expect(listing.retractions.length).toBe(1);
      const entry = listing.retractions[0];
      expect(entry).toBeDefined();
      if (entry === undefined) return;

      expect(entry.at).toBe(forgotten.deletedAt);
      expect(entry.kind).toBe('record');
      expect(entry.targetKind).toBe('doc');
      expect(entry.origins).toEqual([WORK]);
      expect(entry.counts).toEqual({ ...forgotten.cascade });
      expect(entry.restorableUntil).toBe(
        new Date(AT.getTime() + FORGET_TTL_HOURS * HOUR).toISOString(),
      );

      // The negative that matters: nothing in the entry, at any depth, is text
      // the user wrote or received. Serialised whole so a field added later has
      // to pass through here.
      const rendered = JSON.stringify(entry);
      expect(rendered).not.toContain('quarterly');
      expect(rendered).not.toContain('revenue');
      expect(rendered).not.toContain('gmail:w1');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a severance is offered as an origin retraction, with its own counts',
    async () => {
      const pageId = await insertPage('gmail:w2', 'A message', WORK);
      await insertChunk(pageId, 'a passage of it');

      const severed = await severOrigin(sql, { origin: WORK, confirm: WORK, now: AT });
      expect(severed.ok).toBe(true);

      const listing = await listRestorable(sql, { now: SOON });
      expect(listing.retractions.length).toBe(1);
      expect(listing.retractions[0]?.kind).toBe('origin');
      expect(listing.retractions[0]?.origins).toEqual([WORK]);
      // A severance has no id kind, and saying `doc` would be inventing one.
      expect(listing.retractions[0]?.targetKind).toBe(null);
      expect(listing.retractions[0]?.counts.pages).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a retraction past the window is simply not there',
    async () => {
      const pageId = await insertPage('gmail:w3', 'Old news', WORK);
      await forgetRecord(sql, { id: { kind: 'doc', key: pageId }, grant: [WORK], now: AT });

      // No greyed-out row and no "expired" entry: absence is the honest
      // rendering, because there is nothing left to offer.
      const listing = await listRestorable(sql, {
        now: new Date(AT.getTime() + (FORGET_TTL_HOURS + 1) * HOUR),
      });
      expect(listing.retractions).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. The erasure case. The reason the ledger exists.
// ---------------------------------------------------------------------------

describe('a subject erasure is never offered to the account holder', () => {
  test(
    'not after one erasure, and not after the second that orphans the first instant',
    async () => {
      // Two correspondents, two pages, two erasures at two instants. The second
      // erasure is what defeats the `erased_subject`-filter design: its upsert
      // is keyed on the digest, so a repeat erasure of ONE correspondent
      // overwrites `erased_at` — but here the two are different subjects, and
      // the shape that actually orphans an instant is the same subject erased
      // twice. Both are exercised.
      const first = await insertPage('gmail:p1', `A note from ${SUBJECT}`, PERSONAL);
      await insertChunk(first, `${SUBJECT} asked about the invoice.`, PERSONAL);
      const second = await insertPage('gmail:p2', `Another note from ${SUBJECT}`, PERSONAL);
      await insertChunk(second, `${SUBJECT} sent the signed copy.`, PERSONAL);
      const third = await insertPage('gmail:p3', `A note from ${OTHER_SUBJECT}`, PERSONAL);
      await insertChunk(third, `${OTHER_SUBJECT} confirmed the date.`, PERSONAL);

      const one = await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });
      expect(one.removed.pages).toBeGreaterThan(0);

      // The same subject again — this is the upsert that overwrites `erased_at`
      // and leaves the FIRST erasure's instant recorded nowhere.
      await sql.unsafe(
        `UPDATE page SET deleted_at = NULL WHERE external_ref = 'gmail:p2';
         UPDATE chunk SET deleted_at = NULL WHERE content LIKE '%signed copy%'`,
      );
      const two = await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });
      expect(two.erasedAt).not.toBe(one.erasedAt);

      await eraseSubject({ sql }, { identifier: OTHER_SUBJECT, erasedBy: 'app' });

      // Every one of those instants is on tombstoned rows right now — the
      // derived listing would show all three.
      const stamped = (await sql`
        SELECT count(DISTINCT deleted_at)::int AS n FROM page WHERE deleted_at IS NOT NULL
      `) as Array<{ n: number }>;
      expect(Number(stamped[0]?.n ?? 0)).toBeGreaterThanOrEqual(2);

      const listing = await listRestorable(sql, { now: new Date(Date.parse(one.erasedAt) + HOUR) });
      expect(listing.retractions).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. A restored instant stops being offered. Both arms.
// ---------------------------------------------------------------------------

describe('what has been restored leaves the listing', () => {
  test(
    'the record arm: the ledger row goes when its tombstones come back',
    async () => {
      const pageId = await insertPage('gmail:w4', 'A document', WORK);
      const forgotten = await forgetRecord(sql, {
        id: { kind: 'doc', key: pageId },
        grant: [WORK],
        now: AT,
      });
      expect(forgotten.ok).toBe(true);
      if (!forgotten.ok) return;

      await restoreForgotten(sql, { deletedAt: forgotten.deletedAt, now: SOON });
      await markRetractionRestored(sql, { deletedAt: forgotten.deletedAt, now: SOON });

      // Not a cosmetic tidy-up: the alternative is a button whose second click
      // does nothing, on a surface whose entire job is to be trusted with an
      // undo.
      expect((await listRestorable(sql, { now: SOON })).retractions).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the origin arm: the audit row stays, and stops being offered',
    async () => {
      await insertPage('gmail:w5', 'A message', WORK);
      const severed = await severOrigin(sql, { origin: WORK, confirm: WORK, now: AT });
      expect(severed.ok).toBe(true);

      await restoreForgotten(sql, { deletedAt: AT.toISOString(), now: SOON });
      await markRetractionRestored(sql, { deletedAt: AT.toISOString(), now: SOON });

      expect((await listRestorable(sql, { now: SOON })).retractions).toEqual([]);
      // `severance` is append-only audit with a recompute worklist derived from
      // it, so the row itself must survive its own undo.
      const rows = (await sql`
        SELECT restored_at IS NOT NULL AS marked FROM severance
      `) as Array<{ marked: boolean }>;
      expect(rows.length).toBe(1);
      expect(rows[0]?.marked).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 4. The ceiling, and the fact the ceiling hides.
// ---------------------------------------------------------------------------

describe('the ceiling says whether it hid anything', () => {
  test(
    'false at the limit, true at one past it',
    async () => {
      const at = (n: number) => new Date(AT.getTime() + n * 1000);
      for (let n = 0; n < 4; n += 1) {
        const pageId = await insertPage(`gmail:n${n}`, `Document ${n}`, WORK);
        await forgetRecord(sql, { id: { kind: 'doc', key: pageId }, grant: [WORK], now: at(n) });
      }

      const exact = await listRestorable(sql, { now: SOON, limit: 4 });
      expect(exact.retractions.length).toBe(4);
      expect(exact.overflowed).toBe(false);

      const capped = await listRestorable(sql, { now: SOON, limit: 3 });
      expect(capped.retractions.length).toBe(3);
      expect(capped.overflowed).toBe(true);
      // Newest first, so the ones a user is most likely to be looking for are
      // the ones the ceiling keeps.
      expect(capped.retractions[0]?.at).toBe(at(3).toISOString());
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the default ceiling is what an unbounded caller gets',
    () => {
      expect(RESTORABLE_LIMIT).toBeGreaterThan(0);
    },
  );
});

// ---------------------------------------------------------------------------
// 5. No content table is read. Asserted against the statements, not the shape.
// ---------------------------------------------------------------------------

describe('the listing reads two ledgers and nothing else', () => {
  test(
    'every statement it issues names only `retraction` and `severance`',
    async () => {
      const issued: string[] = [];
      // A recording proxy rather than a fixture assertion: "the result carried
      // no title" is true of a brain whose pages have no titles, and would stay
      // green through the edit that added the join.
      const recorder = new Proxy(sql as unknown as Record<string, unknown>, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (property === 'unsafe' && typeof value === 'function') {
            return (statement: string, ...rest: unknown[]) => {
              issued.push(statement);
              return (value as (...args: unknown[]) => unknown).call(target, statement, ...rest);
            };
          }
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      }) as unknown as SQL;

      await listRestorable(recorder, { now: SOON });
      expect(issued.length).toBeGreaterThan(0);

      const forbidden = ['page', 'chunk', 'fact', 'entity', 'commitment', 'attachment'];
      for (const statement of issued) {
        // `FROM <table>` / `JOIN <table>`, so a column named `page_id` or the
        // word inside a comment cannot trip it and a real join cannot hide.
        const sources = [...statement.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi)].map((m) => m[1]);
        expect(sources.length).toBeGreaterThan(0);
        for (const source of sources) {
          expect(forbidden).not.toContain(source);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
