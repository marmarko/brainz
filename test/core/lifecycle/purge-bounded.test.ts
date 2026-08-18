/**
 * The purge, as the thing that is about to run in production for the first time.
 *
 * ============================================================================
 * WHAT THIS FILE IS ACTUALLY ABOUT
 * ============================================================================
 *
 * `purgeExpiredTombstones` has existed since R12 and has **never run**. Every
 * mention of it outside its own definition is a comment. So `forget` never hard-
 * deleted anything, superseded page versions lived forever, and the first sweep
 * — whenever somebody finally wired one — was always going to meet an entire
 * accumulated backlog at once, irreversibly, in one transaction. Three
 * properties have to hold before that is a safe thing to schedule, and this file
 * is one case for each.
 *
 * **1. It must not raise on the first real batch.** `fact_page_fkey` is
 * `ON DELETE CASCADE` and `fact_superseded_fkey` has no `ON DELETE` action at
 * all. The original pointer clear covered *tombstoned* facts only, which is not
 * the set the page delete removes: a live cross-origin fact on a retracted page
 * is taken by the cascade, and any live fact still pointing `superseded_by` at
 * it raises `23503`. That shape is not exotic — `forgetRecord`'s `doc` case and
 * `severOrigin` both retract a page unconditionally while fencing its facts on
 * origin, which is to say both *produce* it deliberately. And because the sweep
 * is a transaction, one such row anywhere in the brain rolls the entire purge
 * back on every run forever, which is the module header's own definition of the
 * failure: "a purge that always raises is a 72-hour TTL that is silently
 * forever."
 *
 * **2. The ceiling must be a ceiling.** Not a default a caller can talk its way
 * past — `Infinity`, a mis-parsed `1e9`, a typo with an extra zero.
 *
 * **3. It must be countable before it is trusted**, and the count must include
 * the rows nobody retracted. Those are the majority of what a real page delete
 * removes and the receipt never mentioned them.
 *
 * ============================================================================
 * WHY THE BATCH BOUNDARY IS TESTED SEPARATELY FROM THE FOREIGN KEY
 * ============================================================================
 *
 * The pointer clear is scoped to the batch, and it has to be: left global while
 * the deletes are batched, it durably nulls a live fact's pointer to a fact a
 * later batch has not taken yet, and a run that dies in between has destroyed a
 * relationship between two rows that both still exist. Scoped, an aborted run
 * has only nulled pointers into rows it already deleted. The second case below
 * forces the two pages into different batches (`rowsPerBatch: 1`) so a fix that
 * only worked when everything shared one transaction fails here.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  FORGET_TTL_HOURS,
  PURGE_GRACE_HOURS,
  PURGE_MAX_BATCHES_CEILING,
  PURGE_ROWS_PER_BATCH_CEILING,
  previewTombstonePurge,
  purgeExpiredTombstones,
  resolvePurgeBudget,
} from '../../../src/mcp/tombstone.ts';
import { ACTIVE_EMBEDDING_SEAT } from '../../../src/schema/embedding-seat.ts';
import { EMBEDDING_DIMENSIONS } from '../../../src/schema/vector-index.ts';
import { connect, dropFixtureDatabase, provisionFixture, type SchemaFixture } from '../../schema/fixture.ts';

import type { SQL } from 'bun';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const SEAT_COLUMN = ACTIVE_EMBEDDING_SEAT.column;
const EMBEDDING = `('[1' || repeat(',0', ${EMBEDDING_DIMENSIONS - 1}) || ']')::vector(${EMBEDDING_DIMENSIONS})`;

const WORK = 'work:mail';
const PERSONAL = 'personal:mail';

/** When the retraction happened, and when a sweep that takes it must run. */
const RETRACTED_AT = new Date('2026-06-10T00:00:00.000Z');
const HOUR = 3600_000;
/** Past the TTL *and* its grace band — the instant the sweep is eligible. */
const AFTER_THE_SWEEP = new Date(
  RETRACTED_AT.getTime() + (FORGET_TTL_HOURS + PURGE_GRACE_HOURS + 1) * HOUR,
);

let schema: SchemaFixture;
let sql: SQL;

beforeAll(async () => {
  schema = await provisionFixture('purge_bounded');
  sql = connect(schema);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await sql?.close();
  if (schema !== undefined) await dropFixtureDatabase(schema);
});

beforeEach(async () => {
  // Order matters even here: `page_version` holds a reference the page delete
  // would only SET NULL, and the archive hangs off `entity`.
  await sql.unsafe(`
    DELETE FROM page_version;
    DELETE FROM severed_alias;
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

// ---------------------------------------------------------------------------
// Seeding. Every helper returns the key it wrote, because the assertions are
// about specific rows rather than about totals.
// ---------------------------------------------------------------------------

async function insertPage(ref: string, origin = WORK): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO page (origin_context, source_type, title, external_ref, embedding_model,
                       embedding_dimensions, chunker_version, normalizer_version, content_sha256)
     VALUES ($1, 'email', $2, $2, 'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64))
     RETURNING page_id::text AS id`,
    [origin, ref],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

async function insertFact(pageId: string | null, statement: string, origins: readonly string[]): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO fact (statement, ${SEAT_COLUMN}, origin_contexts, page_id)
     VALUES ($1, ${EMBEDDING}, $2::text[], $3::bigint)
     RETURNING fact_id::text AS id`,
    [statement, pgArray(origins), pageId],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

async function insertChunk(pageId: string, content: string, ordinal: number, origin = WORK): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO chunk (origin_context, content, page_id, ordinal)
     VALUES ($1, $2, $3::bigint, $4) RETURNING chunk_id::text AS id`,
    [origin, content, pageId, ordinal],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

async function insertVersion(pageId: string, docKey: string, version: number): Promise<void> {
  await sql.unsafe(
    `INSERT INTO page_version (doc_key, version, page_id, origin_context, source_type, title, body,
                               content_sha256, captured_from)
     VALUES ($1, $2, $3::bigint, '${WORK}', 'email', 'a superseded draft',
             'the full verbatim body of the document that was retracted', repeat('b', 64), 'superseded')`,
    [docKey, version, pageId],
  );
}

async function retract(table: string, key: string, id: string, at: Date): Promise<void> {
  await sql.unsafe(`UPDATE ${table} SET deleted_at = $2::timestamptz WHERE ${key} = $1::bigint`, [
    id,
    at.toISOString(),
  ]);
}

function pgArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value}"`).join(',')}}`;
}

async function count(fragment: string): Promise<number> {
  const rows = (await sql.unsafe(`SELECT count(*)::int AS n FROM ${fragment}`)) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// 1. The foreign key that would have aborted the first production run.
// ---------------------------------------------------------------------------

describe('the pointer clear covers what the page delete takes, not what the tombstone flags', () => {
  test(
    'a live fact superseded by a live fact on a retracted page does not abort the purge',
    async () => {
      // The shape `forgetRecord`'s `doc` case produces on purpose: the page is
      // retracted whole, and the cross-origin fact on it is left live because a
      // work-scoped grant may not retract a fact it may not read.
      const staying = await insertPage('gmail:staying');
      const going = await insertPage('gmail:going');
      const successor = await insertFact(going, 'the figure was two hundred', [WORK, PERSONAL]);
      const predecessor = await insertFact(staying, 'the figure was one hundred', [WORK]);
      await sql.unsafe('UPDATE fact SET superseded_by = $2::bigint WHERE fact_id = $1::bigint', [
        predecessor,
        successor,
      ]);
      await retract('page', 'page_id', going, RETRACTED_AT);

      // Neither fact is tombstoned. The old clear looked only at tombstoned
      // facts, found nothing, and left the pointer standing into a row the page
      // delete was about to cascade away.
      expect(await count(`fact WHERE deleted_at IS NOT NULL`)).toBe(0);

      const purged = await purgeExpiredTombstones(sql, { now: AFTER_THE_SWEEP });

      expect(purged.counts.pages).toBe(1);
      // Taken by `fact_page_fkey`, and reported — it was never retracted.
      expect(purged.cascaded.facts).toBe(1);
      expect(await count(`fact WHERE fact_id = ${successor}`)).toBe(0);

      const survivor = (await sql.unsafe('SELECT superseded_by FROM fact WHERE fact_id = $1::bigint', [
        predecessor,
      ])) as Array<{ superseded_by: string | null }>;
      expect(survivor).toHaveLength(1);
      expect(survivor[0]?.superseded_by).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and it still holds when the two pages land in different batches',
    async () => {
      // A global clear passes the case above and fails this one: batch 1 would
      // null a pointer into a fact batch 2 has not taken yet, and a run that
      // died between the two commits would have destroyed a live relationship
      // between two rows that both still exist.
      const staying = await insertPage('gmail:staying');
      const pointers: string[] = [];
      for (const ref of ['gmail:first', 'gmail:second']) {
        const going = await insertPage(ref);
        const successor = await insertFact(going, `the ${ref} figure`, [WORK, PERSONAL]);
        const predecessor = await insertFact(staying, `the older ${ref} figure`, [WORK]);
        await sql.unsafe('UPDATE fact SET superseded_by = $2::bigint WHERE fact_id = $1::bigint', [
          predecessor,
          successor,
        ]);
        await retract('page', 'page_id', going, RETRACTED_AT);
        pointers.push(predecessor);
      }

      const purged = await purgeExpiredTombstones(sql, {
        now: AFTER_THE_SWEEP,
        budget: { rowsPerBatch: 1, maxBatches: 5 },
      });

      expect(purged.counts.pages).toBe(2);
      expect(purged.batches).toBeGreaterThan(2);
      for (const pointer of pointers) {
        const row = (await sql.unsafe('SELECT superseded_by FROM fact WHERE fact_id = $1::bigint', [
          pointer,
        ])) as Array<{ superseded_by: string | null }>;
        expect(row[0]?.superseded_by).toBeNull();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. The ceiling.
// ---------------------------------------------------------------------------

describe('the per-run ceiling is a bound, not a default', () => {
  test('a budget nobody can raise', () => {
    // Clamped rather than refused, which is the opposite direction from the
    // retention window and for a stated reason: "as much as possible" is a
    // coherent ask with a correct answer, and refusing it only produces a
    // second call with a smaller number.
    expect(resolvePurgeBudget({ rowsPerBatch: 1e9, maxBatches: 1e9 })).toEqual({
      rowsPerBatch: PURGE_ROWS_PER_BATCH_CEILING,
      maxBatches: PURGE_MAX_BATCHES_CEILING,
    });
    expect(resolvePurgeBudget({ rowsPerBatch: Number.POSITIVE_INFINITY })).toEqual({
      rowsPerBatch: PURGE_ROWS_PER_BATCH_CEILING,
      maxBatches: expect.any(Number),
    });
    // And it cannot be argued down to nothing either — a zero-row batch is a
    // run that reports `exhausted: false` forever while doing no work.
    expect(resolvePurgeBudget({ rowsPerBatch: 0, maxBatches: -4 })).toEqual({
      rowsPerBatch: 1,
      maxBatches: 1,
    });
  });

  test(
    'a run stops at its budget, says it is not finished, and the next one resumes',
    async () => {
      for (const ref of ['a', 'b', 'c', 'd', 'e']) {
        const page = await insertPage(`gmail:${ref}`);
        await retract('page', 'page_id', page, RETRACTED_AT);
      }

      const first = await purgeExpiredTombstones(sql, {
        now: AFTER_THE_SWEEP,
        budget: { rowsPerBatch: 1, maxBatches: 2 },
      });
      expect(first.counts.pages).toBe(2);
      expect(first.batches).toBe(2);
      // The fact that matters to a caller deciding whether to come back: "took
      // exactly the ceiling" and "took the ceiling and there is more" are
      // different, and only this field tells them apart.
      expect(first.exhausted).toBe(false);
      expect(await count('page')).toBe(3);

      const second = await purgeExpiredTombstones(sql, {
        now: AFTER_THE_SWEEP,
        budget: { rowsPerBatch: 10, maxBatches: 10 },
      });
      // Resumed with no state carried between the runs: the cutoff predicate is
      // idempotent, so a row the first run took simply no longer matches.
      expect(second.counts.pages).toBe(3);
      expect(second.exhausted).toBe(true);
      expect(await count('page')).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the budget a caller asks for is reported back as the one that was used',
    async () => {
      const purged = await purgeExpiredTombstones(sql, {
        now: AFTER_THE_SWEEP,
        budget: { rowsPerBatch: Number.MAX_SAFE_INTEGER, maxBatches: Number.MAX_SAFE_INTEGER },
      });
      expect(purged.budget).toEqual({
        rowsPerBatch: PURGE_ROWS_PER_BATCH_CEILING,
        maxBatches: PURGE_MAX_BATCHES_CEILING,
      });
      // An empty brain costs one batch, not fifty: the batch that claims nothing
      // is the one that proves the backlog is gone, and it does no work.
      expect(purged.batches).toBe(1);
      expect(purged.exhausted).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. The window.
// ---------------------------------------------------------------------------

describe('the retention window is respected at both edges', () => {
  test(
    'a retraction inside the window and inside the grace band is left alone',
    async () => {
      const page = await insertPage('gmail:fresh');
      await retract('page', 'page_id', page, RETRACTED_AT);

      // Inside the user's own 72 hours: untouched, obviously.
      const early = await purgeExpiredTombstones(sql, {
        now: new Date(RETRACTED_AT.getTime() + (FORGET_TTL_HOURS - 1) * HOUR),
      });
      expect(early.counts.pages).toBe(0);

      // Past the 72 hours but inside the grace band: still untouched, and this
      // is the edge the grace band exists for. `restoreForgotten` has already
      // stopped admitting an undo here; what the band buys is that a batched
      // purge and a restore admitted a moment before the boundary cannot be
      // running against the same rows.
      const grace = await purgeExpiredTombstones(sql, {
        now: new Date(RETRACTED_AT.getTime() + (FORGET_TTL_HOURS + 1) * HOUR),
      });
      expect(grace.counts.pages).toBe(0);
      expect(await count('page')).toBe(1);

      const late = await purgeExpiredTombstones(sql, { now: AFTER_THE_SWEEP });
      expect(late.counts.pages).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 4. The dry run.
// ---------------------------------------------------------------------------

describe('the preview describes the run and does not perform it', () => {
  /**
   * A brain fragment with one of every shape the purge distinguishes: a
   * retracted page carrying live and retracted children, a parentless retracted
   * commitment, a retracted entity with a live card, and a snapshot that
   * survives its page as an orphan.
   */
  async function seedTheWholeShape(): Promise<void> {
    const going = await insertPage('gmail:going');
    await insertChunk(going, 'a passage nobody retracted', 0);
    const doomedChunk = await insertChunk(going, 'a passage somebody did', 1);
    await retract('chunk', 'chunk_id', doomedChunk, RETRACTED_AT);
    await insertFact(going, 'a cross-origin fact left live on purpose', [WORK, PERSONAL]);
    await insertVersion(going, 'gmail:going', 1);
    await sql.unsafe(
      `INSERT INTO attachment (page_id, origin_context, media_type, object_key)
       VALUES ($1::bigint, '${WORK}', 'image/png', 'tenants/x/attachments/1')`,
      [going],
    );
    await retract('page', 'page_id', going, RETRACTED_AT);

    // The parentless commitment the purge reaches by its own `deleted_at`,
    // because extraction could attribute it to neither a page nor a fact.
    const orphan = (await sql.unsafe(
      `INSERT INTO commitment (statement, owner_name, trust_level, derivation, origin_contexts)
       VALUES ('send the plan', 'the platform team', 'model_extracted', 'model_derived', '${pgArray([WORK])}'::text[])
       RETURNING commitment_id::text AS id`,
    )) as Array<{ id: string }>;
    await retract('commitment', 'commitment_id', orphan[0]?.id ?? '', RETRACTED_AT);

    const entity = (await sql.unsafe(
      `INSERT INTO entity (canonical_name, entity_type, origin_contexts)
       VALUES ('Platform Team', 'person', '${pgArray([WORK])}'::text[])
       RETURNING entity_id::text AS id`,
    )) as Array<{ id: string }>;
    const entityId = entity[0]?.id ?? '';
    await sql.unsafe(
      `INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts)
       VALUES ($1::bigint, 'what enrichment wrote about them', 'model_inferred', 'model_derived',
               '${pgArray([WORK])}'::text[])`,
      [entityId],
    );
    await retract('entity', 'entity_id', entityId, RETRACTED_AT);
  }

  test(
    'it removes nothing, and it counts the rows nobody retracted',
    async () => {
      await seedTheWholeShape();
      const before = {
        pages: await count('page'),
        chunks: await count('chunk'),
        facts: await count('fact'),
        versions: await count('page_version'),
      };

      const preview = await previewTombstonePurge(sql, { now: AFTER_THE_SWEEP });

      // Nothing moved. A dry run that deletes is not a dry run.
      expect(await count('page')).toBe(before.pages);
      expect(await count('chunk')).toBe(before.chunks);
      expect(await count('fact')).toBe(before.facts);
      expect(await count('page_version')).toBe(before.versions);

      expect(preview.tombstoned.pages).toBe(1);
      expect(preview.tombstoned.chunks).toBe(1);
      expect(preview.tombstoned.commitments).toBe(1);
      expect(preview.tombstoned.entities).toBe(1);

      // The half the receipt never mentioned. These rows were never retracted
      // and they are the majority of what a page delete actually removes.
      expect(preview.cascaded.chunks).toBe(1);
      expect(preview.cascaded.facts).toBe(1);
      expect(preview.cascaded.attachments).toBe(1);
      expect(preview.cascaded.entityCards).toBe(1);

      // And the disclosure that is easiest to leave off a consent screen: the
      // snapshot is NOT deleted. `page_version_page_fkey` is ON DELETE SET NULL,
      // so the full verbatim body of the retracted document stays standing.
      expect(preview.cascaded.pageVersionsOrphaned).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and the run that follows it removes exactly what it described',
    async () => {
      await seedTheWholeShape();
      const preview = await previewTombstonePurge(sql, { now: AFTER_THE_SWEEP });

      // Deliberately batched small, because the agreement is the property that
      // is easiest to break by batching: a row counted as direct in one budget
      // and as an uncounted cascade in another is a receipt whose numbers depend
      // on how big the batches were.
      const purged = await purgeExpiredTombstones(sql, {
        now: AFTER_THE_SWEEP,
        budget: { rowsPerBatch: 1, maxBatches: 20 },
      });

      expect(purged.exhausted).toBe(true);
      expect(purged.cutoff).toBe(preview.cutoff);
      expect(purged.counts).toEqual(preview.tombstoned);
      expect(purged.cascaded).toEqual(preview.cascaded);

      // The orphan the preview promised: still there, with its page gone.
      expect(await count('page_version')).toBe(1);
      expect(await count('page_version WHERE page_id IS NULL')).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
