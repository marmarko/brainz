/**
 * The row that makes a retraction findable, and the transaction it has to be in.
 *
 * ============================================================================
 * WHY THERE IS A LEDGER AT ALL, GIVEN THE MODULE HEADER SAYS THERE IS NOT
 * ============================================================================
 *
 * `src/mcp/tombstone.ts` argues — correctly, and this file does not disturb it —
 * that recovery keys on the deletion instant and therefore needs no table. That
 * answers "undo THIS". It does not answer "what may I undo?", and until
 * something answered the second one the 72-hour window was decorative: `forget`
 * promised `recoverableUntil` and no surface in the running system could name a
 * single restorable instant.
 *
 * The derived answer — `SELECT DISTINCT deleted_at` over the tombstoned tables —
 * is not merely inconvenient, it is wrong. `lifecycle/subject-erasure.ts` stamps
 * its instant on all seven of those tables, so every erasure of a correspondent
 * would appear to the account holder as an ordinary restorable retraction with a
 * button beside it — and `restoreForgotten` cannot undo an erasure, because the
 * erasure also hard-deleted `page_version`, `review_queue` and `entity_edge` and
 * left a live suppression row behind. So provenance has to be POSITIVELY
 * sourced: an instant is listable because a `forget` wrote a row saying so.
 *
 * ============================================================================
 * WHAT THIS FILE PINS, AND WHY EACH ONE IS A FAILURE RATHER THAN A PREFERENCE
 * ============================================================================
 *
 * **The row is inside `forgetRecord`'s own transaction.** A ledger row for a
 * retraction that rolled back offers an undo for tombstones that do not exist;
 * a retraction with no ledger row is a retraction the user cannot find. Both are
 * silent. `severance.ts` makes the same ordering argument for its own audit row
 * and this is the same property one module over.
 *
 * **`origin_contexts` is what the fence actually read**, for all four kinds.
 * `mayTouch` already reads the origin of every id it admits and used to throw it
 * away; the ledger's copy is that value rather than a re-read, because a second
 * read is a second answer — and this column is what would let a future MCP
 * restore be fenced by a subset check against one row.
 *
 * **`removed` equals the cascade the receipt reported.** The listing and the
 * receipt describe one event; two independent counts are two events that agree
 * until the day they do not.
 *
 * **Both origin triggers refuse an UPDATE.** R15 applies here for a reason
 * sharper than uniformity: this table is what a restore surface reads to decide
 * what it may offer, so an editable origin re-labels a retraction on the one row
 * an access decision would be made from.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { forgetRecord } from '../../../src/mcp/tombstone.ts';
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
const AT = new Date('2026-06-10T00:00:00.000Z');

let schema: SchemaFixture;
let sql: SQL;

beforeAll(async () => {
  schema = await provisionFixture('retraction_ledger');
  sql = connect(schema);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await sql?.close();
  if (schema !== undefined) await dropFixtureDatabase(schema);
});

beforeEach(async () => {
  await sql.unsafe(`
    DELETE FROM retraction;
    DELETE FROM commitment;
    DELETE FROM entity_card;
    UPDATE fact SET superseded_by = NULL;
    DELETE FROM fact;
    DELETE FROM chunk;
    DELETE FROM page;
    DELETE FROM entity;
  `);
});

interface LedgerRow {
  readonly retracted_at: string;
  readonly target_kind: string;
  readonly origin_contexts: string[];
  readonly removed: Record<string, number>;
}

async function ledger(): Promise<LedgerRow[]> {
  return (await sql.unsafe(
    `SELECT to_char(retracted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS retracted_at,
            target_kind, origin_contexts, removed
       FROM retraction ORDER BY retraction_id`,
  )) as unknown as LedgerRow[];
}

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

async function insertChunk(pageId: string, ordinal: number, origin = WORK): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO chunk (origin_context, content, page_id, ordinal)
     VALUES ($1, 'a passage of the document', $2::bigint, $3) RETURNING chunk_id::text AS id`,
    [origin, pageId, ordinal],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

async function insertFact(pageId: string | null, origins: readonly string[]): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO fact (statement, ${SEAT_COLUMN}, origin_contexts, page_id)
     VALUES ('the migration lands on the twelfth', ${EMBEDDING}, $1::text[], $2::bigint)
     RETURNING fact_id::text AS id`,
    [`{${origins.join(',')}}`, pageId],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

async function insertEntity(name: string, origins: readonly string[]): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO entity (canonical_name, entity_type, origin_contexts)
     VALUES ($1, 'person', $2::text[]) RETURNING entity_id::text AS id`,
    [name, `{${origins.join(',')}}`],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

// ---------------------------------------------------------------------------
// 1. A retraction is findable at all.
// ---------------------------------------------------------------------------

describe('a forget writes the row that makes it findable', () => {
  test(
    'the instant, the kind, the fence origins and the cascade counts',
    async () => {
      const pageId = await insertPage('gmail:w1');
      await insertChunk(pageId, 0);
      await insertFact(pageId, [WORK]);

      const outcome = await forgetRecord(sql, {
        id: { kind: 'doc', key: pageId },
        grant: [WORK],
        now: AT,
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      const rows = await ledger();
      expect(rows.length).toBe(1);
      const row = rows[0];
      expect(row).toBeDefined();
      if (row === undefined) return;

      // The restore key, byte-identical to the one the receipt handed the user.
      // A listing that emitted a differently-spelled instant would hand back a
      // string `restoreForgotten` parses to a different microsecond.
      expect(row.retracted_at).toBe(outcome.deletedAt);
      expect(row.target_kind).toBe('doc');
      expect(row.origin_contexts).toEqual([WORK]);
      // The counts the receipt reported, not a second census that agrees today.
      expect(row.removed).toEqual({ ...outcome.cascade });
      expect(row.removed.pages).toBe(1);
      expect(row.removed.chunks).toBe(1);
      expect(row.removed.facts).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'every kind `forget` reaches, with the origins that kind is fenced on',
    async () => {
      const pageId = await insertPage('gmail:w2');
      const chunkId = await insertChunk(pageId, 0);
      const factId = await insertFact(null, [WORK, PERSONAL]);
      const entityId = await insertEntity('Platform Team', [PERSONAL]);

      const grant = [WORK, PERSONAL];
      for (const [kind, key] of [
        ['chunk', chunkId],
        ['fact', factId],
        ['ent', entityId],
        ['doc', pageId],
      ] as const) {
        const outcome = await forgetRecord(sql, {
          id: { kind, key },
          grant,
          now: new Date(AT.getTime() + ['chunk', 'fact', 'ent', 'doc'].indexOf(kind) * 1000),
        });
        expect(outcome.ok).toBe(true);
      }

      const rows = await ledger();
      expect(rows.map((row) => row.target_kind)).toEqual(['chunk', 'fact', 'ent', 'doc']);
      // A scalar-origin kind records the one origin its row carries; a union
      // kind records the union the subset rule admitted it under. Neither is
      // the grant — a ledger that recorded the credential would describe the
      // caller rather than the material.
      expect(rows[0]?.origin_contexts).toEqual([WORK]);
      expect(rows[1]?.origin_contexts).toEqual([WORK, PERSONAL]);
      expect(rows[2]?.origin_contexts).toEqual([PERSONAL]);
      expect(rows[3]?.origin_contexts).toEqual([WORK]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a refused forget writes no row at all',
    async () => {
      // Both refusals, because the two leave the brain in different states and
      // a ledger row for either is an offer to restore something that was never
      // retracted. `scope_denied` is the one that matters: the row exists.
      const pageId = await insertPage('gmail:p1', PERSONAL);

      const denied = await forgetRecord(sql, {
        id: { kind: 'doc', key: pageId },
        grant: [WORK],
        now: AT,
      });
      expect(denied.ok).toBe(false);

      const missing = await forgetRecord(sql, {
        id: { kind: 'doc', key: '999999' },
        grant: [WORK],
        now: AT,
      });
      expect(missing.ok).toBe(false);

      expect(await ledger()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a second forget of the same record is recorded, and its counts say nothing came back',
    async () => {
      // An already-tombstoned record produces a cascade of zeros. The row is
      // still written, deliberately: the retraction happened as far as the user
      // is concerned, and the surface renders an all-zero restore as "already
      // restored" rather than as a miss. Suppressing the row here would make
      // the second retraction unfindable while the first one's instant sits in
      // a receipt the user no longer has.
      const pageId = await insertPage('gmail:w3');

      const first = await forgetRecord(sql, { id: { kind: 'doc', key: pageId }, grant: [WORK], now: AT });
      expect(first.ok).toBe(true);
      const second = await forgetRecord(sql, {
        id: { kind: 'doc', key: pageId },
        grant: [WORK],
        now: new Date(AT.getTime() + 60_000),
      });
      expect(second.ok).toBe(true);

      const rows = await ledger();
      expect(rows.length).toBe(2);
      expect(rows[1]?.removed).toEqual({ pages: 0, chunks: 0, facts: 0, entities: 0 });
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. The transaction boundary, exercised rather than described.
// ---------------------------------------------------------------------------

describe('the ledger row and the tombstones commit together', () => {
  test(
    'a cascade that raises leaves neither the tombstone nor the row',
    async () => {
      // The failure is induced through the database rather than through a mock:
      // a BEFORE UPDATE trigger on `chunk` that raises turns `forgetRecord`'s
      // `doc` cascade into an aborted transaction, which is exactly the shape a
      // constraint violation mid-cascade would produce in production. If the
      // ledger insert were outside `sql.begin` — or committed on its own
      // connection — the row would survive the rollback and the listing would
      // offer an undo for a retraction that never happened.
      const pageId = await insertPage('gmail:w4');
      await insertChunk(pageId, 0);

      await sql.unsafe(`
        CREATE FUNCTION refuse_the_cascade() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'the cascade could not complete'; END $$;
        CREATE TRIGGER refuse_the_cascade BEFORE UPDATE ON chunk
          FOR EACH ROW EXECUTE FUNCTION refuse_the_cascade();
      `);
      try {
        await expect(
          forgetRecord(sql, { id: { kind: 'doc', key: pageId }, grant: [WORK], now: AT }),
        ).rejects.toThrow();
      } finally {
        await sql.unsafe(`
          DROP TRIGGER refuse_the_cascade ON chunk;
          DROP FUNCTION refuse_the_cascade();
        `);
      }

      expect(await ledger()).toEqual([]);
      const live = (await sql.unsafe(
        `SELECT count(*)::int AS n FROM page WHERE deleted_at IS NOT NULL`,
      )) as Array<{ n: number }>;
      expect(live[0]?.n).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. R15, on the table an access decision would be made from.
// ---------------------------------------------------------------------------

describe('the ledger origins are as immutable as every other origin column', () => {
  test(
    'both trigger arms refuse an UPDATE with BZ001',
    async () => {
      const pageId = await insertPage('gmail:w5');
      await forgetRecord(sql, { id: { kind: 'doc', key: pageId }, grant: [WORK], now: AT });

      let raised: unknown;
      try {
        await sql.unsafe(`UPDATE retraction SET origin_contexts = ARRAY['${PERSONAL}']`);
      } catch (error) {
        raised = error;
      }
      expect(raised).toBeDefined();
      expect((raised as { errno?: string }).errno).toBe('BZ001');

      // And the row is untouched, which is the property the SQLSTATE is
      // evidence for rather than a substitute for.
      const rows = await ledger();
      expect(rows[0]?.origin_contexts).toEqual([WORK]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the pinned twin is attached too, so the fence does not rest on search_path',
    async () => {
      const rows = (await sql.unsafe(`
        SELECT tgname FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'retraction' AND NOT t.tgisinternal
        ORDER BY tgname
      `)) as Array<{ tgname: string }>;
      expect(rows.map((row) => row.tgname)).toEqual([
        'retraction_origin_is_immutable',
        'retraction_origin_is_immutable_pinned',
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});
