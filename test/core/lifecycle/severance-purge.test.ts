/**
 * What severance tombstones, the purge takes — including the two tables that
 * have no `deleted_at` sweep of their own.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS, AND WHAT IT SETTLES
 * ============================================================================
 *
 * `purgeExpiredTombstones` reaches `commitment` and `attachment` by their own
 * `deleted_at` precisely because neither always has a parent to cascade from —
 * a commitment extraction could not attribute, an attachment on a page that is
 * staying. `severOrigin` tombstones a sixth table those two arguments do not
 * cover: `entity_card`, which the purge reaches only through
 * `entity_card_entity_fkey ... ON DELETE CASCADE`. So the obvious worry is a
 * card tombstoned by a severance whose entity survives it: no cascade to take
 * it, no sweep keyed on its own `deleted_at`, and a soft-deleted summary of a
 * work relationship sitting in the brain in plaintext for the life of the
 * tenant.
 *
 * **That state is unreachable, and the reason is a constraint rather than a
 * convention**, which is why it is worth pinning here rather than trusting.
 * `entity_card_origin_union` (rung 3) refuses any card whose `origin_contexts`
 * do not COVER its entity's. Severance takes rows whose origins are a SUBSET of
 * the severed one. Compose the two: `card ⊆ {origin}` forces
 * `entity ⊆ card ⊆ {origin}`, so any card severance tombstones has an entity
 * severance tombstones in the same statement — and the purge takes the entity by
 * its own `deleted_at` and the card with it.
 *
 * Both halves are asserted, because either one alone is a coincidence:
 *
 *   1. the database **refuses** the mixed-entity / exact-card shape, so the
 *      hazard has no way in; and
 *   2. over the shape that IS reachable, severance plus the purge leaves **no
 *      tombstoned row in any table severance writes to** — asserted as that
 *      general property rather than as a claim about cards, so a seventh table
 *      added to the executor without a purge path fails here.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { severOrigin } from '../../../src/core/lifecycle/severance.ts';
import { purgeExpiredTombstones } from '../../../src/mcp/tombstone.ts';
import { ACTIVE_EMBEDDING_SEAT } from '../../../src/schema/embedding-seat.ts';
import { EMBEDDING_DIMENSIONS } from '../../../src/schema/vector-index.ts';
/** The column a seeded vector goes in — the active seat's, so a fixture
 * cannot outlive the column production writes. */
const SEAT_COLUMN = ACTIVE_EMBEDDING_SEAT.column;

import { connect, dropFixtureDatabase, provisionFixture, type SchemaFixture } from '../../schema/fixture.ts';

import type { SQL } from 'bun';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

const WORK = 'work:mail';
const PERSONAL = 'personal:mail';

/** The severance runs at this instant; the purge runs well past the 72h TTL. */
const SEVERED_AT = new Date('2026-06-10T00:00:00.000Z');
const LONG_AFTER = new Date('2026-06-20T00:00:00.000Z');

/** Every table `tombstoneExactOrigin` writes a `deleted_at` to. */
const SEVERED_TABLES = ['page', 'chunk', 'fact', 'entity', 'entity_card', 'commitment'] as const;

let schema: SchemaFixture;
let sql: SQL;

const EMBEDDING = `('[1' || repeat(',0', ${EMBEDDING_DIMENSIONS - 1}) || ']')::vector(${EMBEDDING_DIMENSIONS})`;

beforeAll(async () => {
  schema = await provisionFixture('severpurge');
  sql = connect(schema);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await sql?.close();
  if (schema !== undefined) await dropFixtureDatabase(schema);
});

async function insertEntity(name: string, origins: readonly string[]): Promise<string> {
  const rows = (await sql`
    INSERT INTO entity (canonical_name, entity_type, origin_contexts)
    VALUES (${name}, 'person', ${pgArray(origins)}::text[])
    RETURNING entity_id::text AS entity_id
  `) as Array<{ entity_id: string }>;
  return rows[0]?.entity_id ?? '';
}

async function insertCard(entityId: string, origins: readonly string[]): Promise<void> {
  await sql`
    INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts)
    VALUES (${entityId}::bigint, 'what enrichment wrote about them', 'model_inferred',
            'model_derived', ${pgArray(origins)}::text[])
  `;
}

function pgArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value}"`).join(',')}}`;
}

describe('the hazard has no way in', () => {
  test(
    'a card scoped to one origin is refused over an entity that carries two',
    async () => {
      const mixed = await insertEntity('Shared Person', [WORK, PERSONAL]);
      // This is the ONLY shape that could leave a tombstoned card under a live
      // entity: severance would take the card (its origins are exactly work)
      // and leave the entity (its origins are not). The database says no.
      let refusal = '';
      try {
        await insertCard(mixed, [WORK]);
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      expect(refusal).toContain('does not carry the origin');
      expect(refusal).toContain(PERSONAL);

      // And the refusal is the constraint's, not a failed insert of some other
      // kind: the covering card over the same entity is accepted.
      await insertCard(mixed, [WORK, PERSONAL]);
      const live = (await sql`SELECT count(*)::int AS n FROM entity_card`) as Array<{ n: number }>;
      expect(live[0]?.n).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('over the shape that is reachable, nothing severance tombstones outlives the purge', () => {
  test(
    'a severance leaves tombstones, and the purge takes every one of them',
    async () => {
      // A pure-work brain fragment: a page, its chunk, a fact, an entity with a
      // card, and a commitment that hangs off nothing.
      await sql.unsafe(`
        INSERT INTO page (origin_context, source_type, title, external_ref, embedding_model,
                          embedding_dimensions, chunker_version, normalizer_version, content_sha256)
        VALUES ('${WORK}', 'email', 'The migration', 'gmail:w1',
                'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64));
        INSERT INTO chunk (origin_context, content, page_id, ordinal)
        SELECT '${WORK}', 'the migration lands on the twelfth', page_id, 0
          FROM page WHERE external_ref = 'gmail:w1';
        INSERT INTO fact (statement, ${SEAT_COLUMN}, origin_contexts, page_id)
        SELECT 'the migration owner is the platform team', ${EMBEDDING}, ARRAY['${WORK}'], page_id
          FROM page WHERE external_ref = 'gmail:w1';
        INSERT INTO commitment (statement, owner_name, trust_level, derivation, origin_contexts)
        VALUES ('send the migration plan', 'the platform team', 'model_extracted',
                'model_derived', ARRAY['${WORK}']);
      `);
      const pure = await insertEntity('Platform Team', [WORK]);
      await insertCard(pure, [WORK]);

      const outcome = await severOrigin(sql, { origin: WORK, confirm: WORK, now: SEVERED_AT });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      // The card went, and — the load-bearing half — so did its entity, in the
      // same statement, because its origins cannot be wider than the card's.
      expect(outcome.receipt.tombstoned.entityCards).toBe(1);
      expect(outcome.receipt.tombstoned.entities).toBe(1);

      const before = await tombstoneCensus();
      // A purge test over a brain with no tombstones passes every assertion
      // below while proving none of them.
      expect(Object.values(before).reduce((sum, n) => sum + n, 0)).toBeGreaterThan(0);
      expect(before['entity_card']).toBe(1);

      await purgeExpiredTombstones(sql, { now: LONG_AFTER });

      const after = await tombstoneCensus();
      // Stated as the general property. A seventh table added to the executor
      // with no purge path fails here rather than in a support ticket.
      expect(after).toEqual(Object.fromEntries(SEVERED_TABLES.map((table) => [table, 0])));

      // The mixed-origin entity and its covering card are untouched throughout:
      // severance is not a delete, and the purge is not a sweep.
      const survivors = (await sql`
        SELECT (SELECT count(*)::int FROM entity WHERE deleted_at IS NULL) AS entities,
               (SELECT count(*)::int FROM entity_card WHERE deleted_at IS NULL) AS cards
      `) as Array<{ entities: number; cards: number }>;
      expect(survivors[0]?.entities).toBe(1);
      expect(survivors[0]?.cards).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

/** How many tombstoned rows each severed table still holds. */
async function tombstoneCensus(): Promise<Record<string, number>> {
  const census: Record<string, number> = {};
  for (const table of SEVERED_TABLES) {
    const rows = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM ${table} WHERE deleted_at IS NOT NULL`,
    )) as Array<{ n: number }>;
    census[table] = Number(rows[0]?.n ?? 0);
  }
  return census;
}
