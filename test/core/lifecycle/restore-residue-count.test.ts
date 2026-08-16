/**
 * What an undo says it could NOT bring back, and the arithmetic that lied about
 * it.
 *
 * `restoreForgotten` returns two residue counters beside its restore counts:
 * `supersededCards` for a tombstoned card whose entity has a live one again, and
 * `supersededAliases` for an archived spelling that is live again for that
 * entity. Both exist because the alternative is silence — the row cannot come
 * back, and `src/mcp/tombstone.ts` says in both places that a restore quietly
 * returning less than it restored is the defect the function was fixed for.
 *
 * **Both counters were computed by subtracting the numerator from a denominator
 * measured after it had already been consumed.** The restore runs first:
 * `touched` clears the flag on every restorable row, `unarchived` INSERTs the
 * movable rows into the live table and DELETEs them from the archive. Whatever
 * still carries the instant afterwards IS the residue — and the code then
 * subtracted the rows it had just taken away from that remainder. So the
 * reported number was `residue − restored` rather than `residue`:
 *
 *   | rows at the instant | actually left behind | reported |
 *   |---------------------|----------------------|----------|
 *   | 2, both blocked     | 2                    | 2  ✓     |
 *   | 2, one blocked      | 1                    | 0        |
 *   | 2, none blocked     | 0                    | −2       |
 *
 * The first row is why this survived: every existing case in
 * `severance-alias-residue.test.ts` and `restore-coverage.test.ts` blocks
 * *everything* at its instant, where the subtrahend is zero and the wrong
 * expression is accidentally right. The shapes that matter are the mixed ones —
 * a caller told `supersededAliases: 0` has in fact had a spelling not come back,
 * and one told `−2` is reading a number that cannot describe a count of rows.
 *
 * **Why the rows here are planted rather than severed.** The executors that
 * write them are pinned elsewhere and by suites that run them for real:
 * `severance-alias-residue.test.ts` proves `severOrigin` moves a work-only alias
 * into `severed_alias`, and `restore-coverage.test.ts` proves the seven-table
 * census and the blocked-card case. What is under test here is one expression in
 * `restoreForgotten`, evaluated over a residue that is neither empty nor total —
 * and a planted fixture is the only way to hold that ratio still.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { restoreForgotten } from '../../../src/mcp/tombstone.ts';
import { connect, dropFixtureDatabase, provisionFixture, type SchemaFixture } from '../../schema/fixture.ts';

import type { SQL } from 'bun';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

const WORK = 'work:mail';

/** One instant per case: a restore un-does everything that carries one. */
const PARTLY_SQUATTED = '2026-06-10T00:00:00.000Z';
const NOT_SQUATTED = '2026-06-10T01:00:00.000Z';
const PARTLY_BLOCKED = '2026-06-10T02:00:00.000Z';
const NOT_BLOCKED = '2026-06-10T03:00:00.000Z';

/** Inside the 72h window for every instant above. */
const NOW = new Date('2026-06-10T04:00:00.000Z');

let schema: SchemaFixture;
let sql: SQL;

beforeAll(async () => {
  schema = await provisionFixture('restoreresidue');
  sql = connect(schema);

  await sql.unsafe(`
    INSERT INTO entity (canonical_name, entity_type, origin_contexts)
    VALUES ('squatted-alias-holder', 'person', ARRAY['${WORK}']),
           ('free-alias-holder', 'person', ARRAY['${WORK}']),
           ('free-alias-holder-two', 'person', ARRAY['${WORK}']),
           ('free-alias-holder-three', 'person', ARRAY['${WORK}']),
           ('blocked-card-holder', 'person', ARRAY['${WORK}']),
           ('free-card-holder', 'person', ARRAY['${WORK}']),
           ('free-card-holder-two', 'person', ARRAY['${WORK}']),
           ('free-card-holder-three', 'person', ARRAY['${WORK}']);

    -- Case one: two aliases archived at one instant, ONE of whose spellings has
    -- been written again while the row was away. The unique constraint over
    -- (entity_id, alias) is total, so that row cannot come back; the other can.
    INSERT INTO severed_alias (entity_id, alias, alias_source, confidence,
                               origin_contexts, created_at, severed_at)
    SELECT entity_id, 'the work nickname', 'inferred', 0.9, ARRAY['${WORK}'],
           now(), '${PARTLY_SQUATTED}'::timestamptz
      FROM entity WHERE canonical_name = 'squatted-alias-holder';
    INSERT INTO severed_alias (entity_id, alias, alias_source, confidence,
                               origin_contexts, created_at, severed_at)
    SELECT entity_id, 'the other work nickname', 'inferred', 0.9, ARRAY['${WORK}'],
           now(), '${PARTLY_SQUATTED}'::timestamptz
      FROM entity WHERE canonical_name = 'free-alias-holder';

    -- The squatter: consolidation, a re-ingest or the user re-connecting the
    -- account wrote the same spelling back for that entity.
    INSERT INTO entity_alias (entity_id, alias, alias_source, confidence, origin_contexts)
    SELECT entity_id, 'the work nickname', 'inferred', 0.9, ARRAY['${WORK}']
      FROM entity WHERE canonical_name = 'squatted-alias-holder';

    -- Case two: two aliases archived at another instant, neither squatted. Both
    -- come back, and NOTHING was superseded.
    INSERT INTO severed_alias (entity_id, alias, alias_source, confidence,
                               origin_contexts, created_at, severed_at)
    SELECT entity_id, 'a spelling nobody retook', 'inferred', 0.9, ARRAY['${WORK}'],
           now(), '${NOT_SQUATTED}'::timestamptz
      FROM entity WHERE canonical_name = 'free-alias-holder-two';
    INSERT INTO severed_alias (entity_id, alias, alias_source, confidence,
                               origin_contexts, created_at, severed_at)
    SELECT entity_id, 'another spelling nobody retook', 'inferred', 0.9, ARRAY['${WORK}'],
           now(), '${NOT_SQUATTED}'::timestamptz
      FROM entity WHERE canonical_name = 'free-alias-holder-three';

    -- Case three: two cards tombstoned at one instant, on two entities, ONE of
    -- which a later cycle has written a fresh live card for. Two same-instant
    -- cards on ONE entity is not a reachable shape — the unique index over live
    -- cards would refuse the second the moment both were restored.
    INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts, deleted_at)
    SELECT entity_id, 'the card the severance took', 'model_inferred', 'model_derived',
           ARRAY['${WORK}'], '${PARTLY_BLOCKED}'::timestamptz
      FROM entity WHERE canonical_name = 'blocked-card-holder';
    INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts, deleted_at)
    SELECT entity_id, 'the other card the severance took', 'model_inferred', 'model_derived',
           ARRAY['${WORK}'], '${PARTLY_BLOCKED}'::timestamptz
      FROM entity WHERE canonical_name = 'free-card-holder';

    INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts)
    SELECT entity_id, 'the newer summary of the same person', 'model_inferred', 'model_derived',
           ARRAY['${WORK}']
      FROM entity WHERE canonical_name = 'blocked-card-holder';

    -- Case four: two cards tombstoned at another instant, neither blocked.
    INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts, deleted_at)
    SELECT entity_id, 'a card nothing replaced', 'model_inferred', 'model_derived',
           ARRAY['${WORK}'], '${NOT_BLOCKED}'::timestamptz
      FROM entity WHERE canonical_name = 'free-card-holder-two';
    INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts, deleted_at)
    SELECT entity_id, 'another card nothing replaced', 'model_inferred', 'model_derived',
           ARRAY['${WORK}'], '${NOT_BLOCKED}'::timestamptz
      FROM entity WHERE canonical_name = 'free-card-holder-three';
  `);
}, { timeout: SETUP_TIMEOUT_MS });

afterAll(async () => {
  await sql?.close();
  if (schema !== undefined) await dropFixtureDatabase(schema);
});

describe('the fixture holds a residue that is neither empty nor total', () => {
  test(
    'if this fails, the arithmetic under test is being asked the one question it gets right',
    async () => {
      const rows = (await sql`
        SELECT
          (SELECT count(*)::int FROM severed_alias
            WHERE severed_at = ${PARTLY_SQUATTED}::timestamptz) AS archived_partly,
          (SELECT count(*)::int FROM severed_alias
            WHERE severed_at = ${NOT_SQUATTED}::timestamptz) AS archived_free,
          (SELECT count(*)::int FROM entity_card
            WHERE deleted_at = ${PARTLY_BLOCKED}::timestamptz) AS carded_partly,
          (SELECT count(*)::int FROM entity_card
            WHERE deleted_at = ${NOT_BLOCKED}::timestamptz) AS carded_free,
          (SELECT count(*)::int FROM entity_alias) AS squatters,
          (SELECT count(*)::int FROM entity_card WHERE deleted_at IS NULL) AS live_cards
      `) as Array<Record<string, number>>;
      // Two rows at each instant, exactly one squatter and exactly one live
      // card: every case below is a mix, which is the whole point of the file.
      expect(rows[0]).toEqual({
        archived_partly: 2,
        archived_free: 2,
        carded_partly: 2,
        carded_free: 2,
        squatters: 1,
        live_cards: 1,
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('supersededAliases counts the spellings that did not come back', () => {
  test(
    'one of two archived aliases is squatted: the undo says one, not zero',
    async () => {
      const outcome = await restoreForgotten(sql, { deletedAt: PARTLY_SQUATTED, now: NOW });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      // One row moved back, and one is still sitting in the archive.
      expect(outcome.unarchived.aliases).toBe(1);
      // The number a caller acts on. Reported as `0` — "nothing was superseded" —
      // over a user whose spelling is gone until the purge takes it.
      expect(outcome.supersededAliases).toBe(1);

      const left = (await sql`
        SELECT count(*)::int AS n FROM severed_alias
         WHERE severed_at = ${PARTLY_SQUATTED}::timestamptz
      `) as Array<{ n: number }>;
      // The counter is checked against the database rather than against itself.
      expect(left[0]?.n).toBe(outcome.supersededAliases);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'neither of two archived aliases is squatted: the undo says zero, not a negative number',
    async () => {
      const outcome = await restoreForgotten(sql, { deletedAt: NOT_SQUATTED, now: NOW });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      expect(outcome.unarchived.aliases).toBe(2);
      // A count of rows cannot be less than zero, and −2 is what a caller
      // rendering "N spellings could not be restored" was handed.
      expect(outcome.supersededAliases).toBe(0);
      expect(outcome.supersededAliases).toBeGreaterThanOrEqual(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('supersededCards counts the cards that stayed deleted', () => {
  test(
    'one of two tombstoned cards is blocked by a newer one: the undo says one, not zero',
    async () => {
      const outcome = await restoreForgotten(sql, { deletedAt: PARTLY_BLOCKED, now: NOW });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      expect(outcome.restored.entityCards).toBe(1);
      expect(outcome.supersededCards).toBe(1);

      const left = (await sql`
        SELECT count(*)::int AS n FROM entity_card
         WHERE deleted_at = ${PARTLY_BLOCKED}::timestamptz
      `) as Array<{ n: number }>;
      expect(left[0]?.n).toBe(outcome.supersededCards);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'neither of two tombstoned cards is blocked: the undo says zero, not a negative number',
    async () => {
      const outcome = await restoreForgotten(sql, { deletedAt: NOT_BLOCKED, now: NOW });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      expect(outcome.restored.entityCards).toBe(2);
      expect(outcome.supersededCards).toBe(0);
      expect(outcome.supersededCards).toBeGreaterThanOrEqual(0);
    },
    TEST_TIMEOUT_MS,
  );
});
