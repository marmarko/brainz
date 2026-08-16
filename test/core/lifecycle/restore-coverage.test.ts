/**
 * What tombstoning reaches, restoring reaches — pinned against the schema, not
 * against a list somebody kept up to date.
 *
 * ============================================================================
 * THE DEFECT
 * ============================================================================
 *
 * `forget` advertises a 72-hour recoverable window and `restoreForgotten` is
 * what makes it true. It un-deleted four tables: `page`, `chunk`, `fact`,
 * `entity`. Three more carry a `forget`-family tombstone:
 *
 *   * `severOrigin` (`lifecycle/severance.ts`) tombstones `entity_card` and
 *     `commitment` at the same instant as the other four, and its header states
 *     plainly that severance "is not a more final operation than `forget` — a
 *     user who disconnects the wrong account at 2am must be able to undo it";
 *   * `eraseSubject` (`lifecycle/subject-erasure.ts`) tombstones `attachment`
 *     as well, and its header states that it soft-deletes *because* the 72-hour
 *     cascade "already carries the recovery window a mistaken erasure needs" —
 *     otherwise "an erasure instructed against the wrong `alice`" would be
 *     "unrecoverable within the same second it was issued".
 *
 * Both promises were false. A restore returned `ok: true` with counts for the
 * four it knew about and left the user's entity cards, their commitments and
 * their attachments deleted — no error, no partial-restore flag, a brain quietly
 * missing three table classes.
 *
 * A sibling found the mirror of this in `purgeExpiredTombstones` and closed it
 * one table at a time. This closes the other direction and, more to the point,
 * makes the correspondence structural: `TOMBSTONED_TABLES` is one ordered list,
 * the purge and the restore both iterate it, and the census below refuses any
 * table in the schema that carries `deleted_at` and appears in neither that list
 * nor the named exclusions.
 *
 * ============================================================================
 * WHAT A RESTORE STILL CANNOT UNDO, STATED RATHER THAN IMPLIED
 * ============================================================================
 *
 * `eraseSubject` **hard-deletes** `page_version`, `review_queue` and
 * `entity_edge`, and removes stored objects — deliberately, because a snapshot
 * is a verbatim second copy and a proposal quotes the correspondent identically
 * whatever state it is in. Restoring an erasure therefore brings back the
 * tombstoned rows and not those. That is a real limit and it is asserted below
 * rather than left for somebody to discover, because "the undo works" and "the
 * undo restores everything" are different claims and only the first is true.
 *
 * ============================================================================
 * AND THE ONE COLLISION A RESTORE CAN MEET
 * ============================================================================
 *
 * `entity_card_one_live_per_entity` is a UNIQUE index over live cards, and
 * `writeEntityCard` inserts under `ON CONFLICT (entity_id) WHERE deleted_at IS
 * NULL` — so a consolidation cycle can write a fresh card for an entity whose
 * previous card is tombstoned. Un-deleting the old one then raises `23505` and
 * takes the whole restore transaction with it: an advertised undo turning into
 * an unhandled error, which is the failure this file exists to close arriving
 * from the other side. The newer card is the newer summary of the same entity,
 * so the stale one stays deleted — and the outcome *says so* rather than
 * reporting a whole restore.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { severOrigin } from '../../../src/core/lifecycle/severance.ts';
import { eraseSubject } from '../../../src/core/lifecycle/subject-erasure.ts';
import {
  DELETED_AT_IS_NOT_A_TOMBSTONE,
  TOMBSTONED_TABLES,
  purgeExpiredTombstones,
  restoreForgotten,
} from '../../../src/mcp/tombstone.ts';
import { EMBEDDING_DIMENSIONS } from '../../../src/schema/vector-index.ts';
import { connect, dropFixtureDatabase, provisionFixture, type SchemaFixture } from '../../schema/fixture.ts';

import type { SQL } from 'bun';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

const WORK = 'work:mail';
const PERSONAL = 'personal:mail';

const EMBEDDING = `('[1' || repeat(',0', ${EMBEDDING_DIMENSIONS - 1}) || ']')::vector(${EMBEDDING_DIMENSIONS})`;

let schema: SchemaFixture;
let sql: SQL;

beforeAll(async () => {
  schema = await provisionFixture('restorecov');
  sql = connect(schema);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await sql?.close();
  if (schema !== undefined) await dropFixtureDatabase(schema);
});

/** How many tombstoned rows each table the executors write to still holds. */
async function tombstoneCensus(): Promise<Record<string, number>> {
  const census: Record<string, number> = {};
  for (const entry of TOMBSTONED_TABLES) {
    const rows = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM ${entry.table} WHERE deleted_at IS NOT NULL`,
    )) as Array<{ n: number }>;
    census[entry.table] = Number(rows[0]?.n ?? 0);
  }
  return census;
}

async function liveCount(table: string): Promise<number> {
  const rows = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE deleted_at IS NULL`,
  )) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// 1. The correspondence, against the schema rather than against a memory.
// ---------------------------------------------------------------------------

describe('every table that carries a tombstone is accounted for', () => {
  test(
    'the schema has no deleted_at column outside the two declared lists',
    async () => {
      const rows = (await sql`
        SELECT table_name FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name = 'deleted_at'
         ORDER BY table_name
      `) as Array<{ table_name: string }>;
      const found = rows.map((row) => row.table_name);

      // The census is not vacuous: the schema really does carry these columns.
      expect(found.length).toBeGreaterThanOrEqual(7);

      const declared = [
        ...TOMBSTONED_TABLES.map((entry) => entry.table),
        ...DELETED_AT_IS_NOT_A_TOMBSTONE.map((entry) => entry.table),
      ].sort();

      // Both directions. A new table with a `deleted_at` fails here rather than
      // in a support ticket about a restore that came back short; and a table
      // that lost its column fails here rather than leaving a claim about a
      // sweep nothing performs.
      expect(found).toEqual(declared);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the exclusions each carry a reason, so the list cannot become a dumping ground',
    () => {
      expect(DELETED_AT_IS_NOT_A_TOMBSTONE.length).toBeGreaterThan(0);
      for (const entry of DELETED_AT_IS_NOT_A_TOMBSTONE) {
        expect(entry.because.length).toBeGreaterThan(40);
      }
      // The specific one this repo has: `entity_edge`'s `deleted_at` is written
      // by reconciliation (`write/links.ts`, `consolidate/deterministic.ts`) when
      // a later derivation supersedes an edge. Restoring one by instant would
      // resurrect a relationship a cycle retired.
      expect(DELETED_AT_IS_NOT_A_TOMBSTONE.map((entry) => entry.table)).toContain('entity_edge');
    },
  );

  test(
    'every UNIQUE-over-live index on a tombstoned table has a restore guard',
    async () => {
      // The reason `restorableWhen` exists, checked against the catalog rather
      // than against the comment that describes it. A UNIQUE index whose
      // predicate is `deleted_at IS NULL` means the slot a row was tombstoned
      // out of can be taken while it is gone — and un-deleting into that raises
      // 23505 and aborts the whole restore, every other table with it. A second
      // such index added later, with no guard on its table, fails here.
      const rows = (await sql`
        SELECT tablename FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexdef ILIKE '%UNIQUE%'
           AND indexdef ILIKE '%WHERE (deleted_at IS NULL)%'
         ORDER BY tablename
      `) as Array<{ tablename: string }>;

      // Not vacuous: the catalog really does carry indexes of this shape.
      expect(rows.length).toBeGreaterThan(0);

      const tombstoned = new Set(TOMBSTONED_TABLES.map((entry) => entry.table));
      const guarded = new Set(
        TOMBSTONED_TABLES.filter((entry) => entry.restorableWhen !== undefined).map((e) => e.table),
      );
      const unguarded = rows
        .map((row) => row.tablename)
        .filter((table) => tombstoned.has(table) && !guarded.has(table));
      expect(unguarded).toEqual([]);

      // And the guard is not decoration on a table that never needed one.
      for (const table of guarded) {
        expect(`${table} has a unique-over-live index`).toBe(
          rows.some((row) => row.tablename === table)
            ? `${table} has a unique-over-live index`
            : `${table} carries a restore guard for no constraint`,
        );
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. The violating case: severance.
// ---------------------------------------------------------------------------

describe('undoing a severance gives the whole brain back', () => {
  const SEVERED_AT = new Date('2026-06-10T00:00:00.000Z');

  test(
    'entity cards and commitments come back, not just pages and facts',
    async () => {
      await sql.unsafe(`
        INSERT INTO page (origin_context, source_type, title, external_ref, embedding_model,
                          embedding_dimensions, chunker_version, normalizer_version, content_sha256)
        VALUES ('${WORK}', 'email', 'The migration', 'gmail:w1',
                'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64));
        INSERT INTO chunk (origin_context, content, page_id, ordinal)
        SELECT '${WORK}', 'the migration lands on the twelfth', page_id, 0
          FROM page WHERE external_ref = 'gmail:w1';
        INSERT INTO fact (statement, embedding, origin_contexts, page_id)
        SELECT 'the migration owner is the platform team', ${EMBEDDING}, ARRAY['${WORK}'], page_id
          FROM page WHERE external_ref = 'gmail:w1';
        INSERT INTO commitment (statement, owner_name, trust_level, derivation, origin_contexts)
        VALUES ('send the migration plan', 'the platform team', 'model_extracted',
                'model_derived', ARRAY['${WORK}']);
        INSERT INTO entity (canonical_name, entity_type, origin_contexts)
        VALUES ('Platform Team', 'person', ARRAY['${WORK}']);
        INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts)
        SELECT entity_id, 'what enrichment wrote about them', 'model_inferred', 'model_derived',
               ARRAY['${WORK}']
          FROM entity WHERE canonical_name = 'Platform Team';
      `);

      const outcome = await severOrigin(sql, { origin: WORK, confirm: WORK, now: SEVERED_AT });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      // The fixture assertion. A restore test over a severance that tombstoned
      // no card and no commitment would pass every assertion below it while
      // proving none of them.
      expect(outcome.receipt.tombstoned.entityCards).toBe(1);
      expect(outcome.receipt.tombstoned.commitments).toBe(1);

      const restored = await restoreForgotten(sql, {
        deletedAt: SEVERED_AT.toISOString(),
        now: new Date(SEVERED_AT.getTime() + 3600_000),
      });
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;

      // The two the old restore never touched, named because they are the point.
      expect(restored.restored.entityCards).toBe(1);
      expect(restored.restored.commitments).toBe(1);

      // And stated as the general property, over every table the executors
      // write to, from the database rather than from the receipt: an undo that
      // reports six numbers and leaves a row deleted is the bug wearing the
      // fix's clothes.
      expect(await tombstoneCensus()).toEqual(
        Object.fromEntries(TOMBSTONED_TABLES.map((entry) => [entry.table, 0])),
      );
      expect(await liveCount('entity_card')).toBe(1);
      expect(await liveCount('commitment')).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a row tombstoned at a different instant is left alone',
    async () => {
      // Restore is keyed on the deletion instant, and that is the whole reason
      // there is no ledger table. A restore that swept every tombstone would
      // undo retractions the user never asked about.
      const other = '2026-06-01T00:00:00.000Z';
      await sql.unsafe(`
        INSERT INTO commitment (statement, owner_name, trust_level, derivation, origin_contexts, deleted_at)
        VALUES ('an unrelated retraction', 'somebody', 'model_extracted', 'model_derived',
                ARRAY['${PERSONAL}'], '${other}'::timestamptz)
      `);

      const restored = await restoreForgotten(sql, {
        deletedAt: '2026-06-10T00:00:00.000Z',
        now: new Date('2026-06-10T01:00:00.000Z'),
      });
      expect(restored.ok).toBe(true);

      const rows = (await sql`
        SELECT count(*)::int AS n FROM commitment WHERE deleted_at = ${other}::timestamptz
      `) as Array<{ n: number }>;
      expect(rows[0]?.n).toBe(1);

      // Clean up so the census in later tests reads only what those tests wrote.
      await sql`DELETE FROM commitment WHERE deleted_at = ${other}::timestamptz`;
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. The violating case: a mis-targeted subject erasure.
// ---------------------------------------------------------------------------

describe('undoing an erasure gives back what it tombstoned', () => {
  const ERASED_AT = new Date('2026-06-12T00:00:00.000Z');

  test(
    'the attachment comes back, and the hard-deleted residue honestly does not',
    async () => {
      await sql.unsafe(`
        INSERT INTO page (origin_context, source_type, title, external_ref, embedding_model,
                          embedding_dimensions, chunker_version, normalizer_version, content_sha256)
        VALUES ('${PERSONAL}', 'email', 'A note from Alice Example', 'gmail:p1',
                'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('b', 64));
        INSERT INTO chunk (origin_context, content, page_id, ordinal)
        SELECT '${PERSONAL}', 'Alice Example asked about the invoice.', page_id, 0
          FROM page WHERE external_ref = 'gmail:p1';
        INSERT INTO attachment (origin_context, page_id, object_key, media_type, byte_size, ocr_text)
        SELECT '${PERSONAL}', page_id, 'tenants/t/att/alice.pdf', 'application/pdf', 2048,
               'signed by Alice Example'
          FROM page WHERE external_ref = 'gmail:p1';
        INSERT INTO review_queue (kind, target_ref, proposal, confidence, state, origin_contexts)
        VALUES ('entity_card', 'entity:0',
                'Alice Example may be the same person as A. Example', 0.5, 'open',
                ARRAY['${PERSONAL}']);
      `);

      const receipt = await eraseSubject({ sql }, {
        identifier: 'Alice Example',
        erasedBy: 'operator',
        now: ERASED_AT,
      });
      // The fixture assertion again: an erasure that took no attachment proves
      // nothing about restoring one.
      expect(receipt.removed.attachments).toBe(1);
      expect(receipt.removed.reviewQueue).toBe(1);

      const restored = await restoreForgotten(sql, {
        deletedAt: ERASED_AT.toISOString(),
        now: new Date(ERASED_AT.getTime() + 3600_000),
      });
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;

      expect(restored.restored.attachments).toBe(1);
      expect(await liveCount('attachment')).toBe(1);
      expect(await liveCount('page')).toBeGreaterThan(0);

      // The honest half. `review_queue` was hard-deleted on purpose — a proposal
      // quotes the correspondent in every state — so the undo cannot bring it
      // back and this file says so rather than implying an erasure is fully
      // reversible.
      const proposals = (await sql`SELECT count(*)::int AS n FROM review_queue`) as Array<{ n: number }>;
      expect(proposals[0]?.n).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 4. The collision the restore can meet, reported rather than thrown.
// ---------------------------------------------------------------------------

describe('a card written after the tombstone is not overwritten by the undo', () => {
  test(
    'the restore reports the superseded card instead of raising a unique violation',
    async () => {
      const at = '2026-06-14T00:00:00.000Z';
      const rows = (await sql.unsafe(`
        INSERT INTO entity (canonical_name, entity_type, origin_contexts)
        VALUES ('Collision Example', 'person', ARRAY['${WORK}'])
        RETURNING entity_id::text AS entity_id
      `)) as Array<{ entity_id: string }>;
      const entityId = rows[0]?.entity_id ?? '';

      await sql.unsafe(`
        INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts, deleted_at)
        VALUES (${entityId}::bigint, 'the summary that was retracted', 'model_inferred',
                'model_derived', ARRAY['${WORK}'], '${at}'::timestamptz);
        INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts)
        VALUES (${entityId}::bigint, 'the summary a later cycle wrote', 'model_inferred',
                'model_derived', ARRAY['${WORK}']);
      `);

      const restored = await restoreForgotten(sql, {
        deletedAt: at,
        now: new Date('2026-06-14T01:00:00.000Z'),
      });
      // Not a throw, which is what an unguarded `SET deleted_at = NULL` does
      // here: `entity_card_one_live_per_entity` raises 23505 and takes the whole
      // transaction — every other table's restore — down with it.
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.supersededCards).toBe(1);
      expect(restored.restored.entityCards).toBe(0);

      // The live card is the newer one, untouched.
      const live = (await sql.unsafe(
        `SELECT summary FROM entity_card WHERE entity_id = ${entityId}::bigint AND deleted_at IS NULL`,
      )) as Array<{ summary: string }>;
      expect(live).toHaveLength(1);
      expect(live[0]?.summary).toBe('the summary a later cycle wrote');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 5. Both directions over one list.
// ---------------------------------------------------------------------------

describe('the purge reaches every table the restore does', () => {
  test(
    'a row tombstoned in each declared table is purged past the TTL',
    async () => {
      const at = '2026-06-16T00:00:00.000Z';
      await sql.unsafe(`
        UPDATE page SET deleted_at = '${at}'::timestamptz WHERE deleted_at IS NULL;
        UPDATE chunk SET deleted_at = '${at}'::timestamptz WHERE deleted_at IS NULL;
        UPDATE fact SET deleted_at = '${at}'::timestamptz WHERE deleted_at IS NULL;
        UPDATE attachment SET deleted_at = '${at}'::timestamptz WHERE deleted_at IS NULL;
        UPDATE commitment SET deleted_at = '${at}'::timestamptz WHERE deleted_at IS NULL;
        UPDATE entity_card SET deleted_at = '${at}'::timestamptz WHERE deleted_at IS NULL;
        UPDATE entity SET deleted_at = '${at}'::timestamptz WHERE deleted_at IS NULL;
      `);

      const before = await tombstoneCensus();
      // A purge test over a brain with no tombstones passes every assertion
      // below while proving none of them.
      for (const entry of TOMBSTONED_TABLES) {
        expect(`${entry.table}: ${before[entry.table]}`).not.toBe(`${entry.table}: 0`);
      }

      const purged = await purgeExpiredTombstones(sql, { now: new Date('2026-06-30T00:00:00.000Z') });
      expect(purged.entityCards).toBeGreaterThan(0);

      expect(await tombstoneCensus()).toEqual(
        Object.fromEntries(TOMBSTONED_TABLES.map((entry) => [entry.table, 0])),
      );
      for (const entry of TOMBSTONED_TABLES) {
        expect(`${entry.table} rows: ${await liveCount(entry.table)}`).toBe(`${entry.table} rows: 0`);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
