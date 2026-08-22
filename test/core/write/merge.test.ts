/**
 * Making two entity rows into one.
 *
 * **The BZ002 case is the one to read first.** It is tempting to think an
 * in-place merge can simply re-point an edge's subject, the way
 * `mergeEntitiesByRule` does — and that function is legal only because its
 * bucket key pins the two rows' origin sets *identical*, which is precisely the
 * property a cross-origin merge gives up. Keeper `{work, personal}`, loser
 * `{work}`, third party `{work}`: the keeper already covers the union so the
 * in-place arm is chosen, and a re-pointed edge carrying `{work}` is refused at
 * commit by `assert_edge_origin_union`. Every edge that moves is retired and
 * re-inserted with the union, on both arms.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { mergeEntities, planMerge } from '../../../src/core/write/merge.ts';
import { createTenantFixture, type TenantFixture } from '../../consolidate/fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;

let tenant: TenantFixture;
let sql: SQL;

beforeAll(async () => {
  tenant = await createTenantFixture('mergeprim');
  sql = tenant.sql;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await tenant?.close();
});

beforeEach(async () => {
  await sql.unsafe(`
    DELETE FROM entity_edge; DELETE FROM entity_card; DELETE FROM entity_alias;
    DELETE FROM entity_slug; DELETE FROM review_queue; DELETE FROM entity;
  `);
});

async function seed(name: string, origins: string[], type = 'organization'): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO entity (canonical_name, entity_type, origin_contexts)
     VALUES ($1, $2, $3::text[]) RETURNING entity_id::text AS id`,
    [name, type, `{${origins.join(',')}}`],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

const apply = async (primary: string, members: string[]) => {
  const planned = await planMerge(sql, { primary, members });
  if (!planned.ok) throw new Error(`refused: ${planned.reason}`);
  return sql.begin(async (tx) =>
    mergeEntities(tx as unknown as SQL, planned.plan, new Date()),
  );
};

describe('the two arms', () => {
  test('in-place keeps the primary id when it already covers the union', async () => {
    const keeper = await seed('Google LLC', ['work', 'personal']);
    const loser = await seed('Google Inc', ['work']);

    const planned = await planMerge(sql, { primary: keeper, members: [loser] });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.arm).toBe('in_place');
    expect([...planned.plan.origins]).toEqual(['personal', 'work']);

    const result = await apply(keeper, [loser]);
    expect(result.entityId).toBe(keeper);
    expect(result.tombstoned).toEqual([loser]);
  }, SETUP_TIMEOUT_MS);

  test('successor mints a new row when the primary does not', async () => {
    const keeper = await seed('Google Inc', ['work']);
    const loser = await seed('Google LLC', ['personal']);

    const planned = await planMerge(sql, { primary: keeper, members: [loser] });
    if (!planned.ok) return;
    expect(planned.plan.arm).toBe('successor');

    const result = await apply(keeper, [loser]);
    expect(result.entityId).not.toBe(keeper);
    expect([...result.tombstoned].sort()).toEqual([keeper, loser].sort());

    const rows = (await sql`
      SELECT canonical_name, origin_contexts FROM entity WHERE deleted_at IS NULL
    `) as Array<{ canonical_name: string; origin_contexts: string[] }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.canonical_name).toBe('Google Inc');
    expect([...(rows[0]?.origin_contexts ?? [])].sort()).toEqual(['personal', 'work']);
  }, SETUP_TIMEOUT_MS);

  test('an edge moved by an IN-PLACE merge still carries the union — the BZ002 case', async () => {
    const keeper = await seed('Google LLC', ['work', 'personal']);
    const loser = await seed('Google Inc', ['work']);
    const third = await seed('Marcus Fell', ['work'], 'person');
    await sql.unsafe(
      `INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts,
                                confidence, derivation)
       VALUES ($1::bigint, 'works_at', $2::bigint, ARRAY['work'], 0.8, 'model_derived')`,
      [third, loser],
    );

    // Commits. Under a naive re-point this raises BZ002 at COMMIT, not at the
    // statement — the trigger is DEFERRABLE INITIALLY DEFERRED.
    await apply(keeper, [loser]);

    const edges = (await sql`
      SELECT origin_contexts, derivation, confidence::float8 AS confidence,
             object_entity_id::text AS object
        FROM entity_edge WHERE deleted_at IS NULL
    `) as Array<{ origin_contexts: string[]; derivation: string; confidence: number; object: string }>;
    expect(edges).toHaveLength(1);
    expect(edges[0]?.object).toBe(keeper);
    expect([...(edges[0]?.origin_contexts ?? [])].sort()).toEqual(['personal', 'work']);
    // And the columns the old re-inserts dropped are still here.
    expect(edges[0]?.derivation).toBe('model_derived');
    expect(edges[0]?.confidence).toBeCloseTo(0.8);
  }, SETUP_TIMEOUT_MS);
});

describe('what a merge refuses and what it carries', () => {
  test('two approved summaries refuse the merge before anything is written', async () => {
    const keeper = await seed('Google LLC', ['work']);
    const loser = await seed('Google Inc', ['work']);
    for (const id of [keeper, loser]) {
      await sql.unsafe(
        `INSERT INTO entity_card (entity_id, summary, trust_level, derivation, confidence,
                                  origin_contexts)
         VALUES ($1::bigint, 'The owner approved this.', 'user_stated', 'model_derived', 1,
                 ARRAY['work'])`,
        [id],
      );
    }

    const planned = await planMerge(sql, { primary: keeper, members: [loser] });
    expect(planned.ok).toBe(false);
    if (planned.ok) return;
    // Two summaries the owner personally approved are two decisions. Picking one
    // silently is the kind of loss discovered months later.
    expect(planned.reason).toBe('two_of_yours');

    // And nothing was written: the aliases are the step with no undo.
    const live = (await sql`SELECT count(*)::int AS n FROM entity WHERE deleted_at IS NULL`) as Array<{ n: number }>;
    expect(live[0]?.n).toBe(2);
  }, SETUP_TIMEOUT_MS);

  test("the owner's card wins over the model's, and carries the union", async () => {
    const keeper = await seed('Google LLC', ['work', 'personal']);
    const loser = await seed('Google Inc', ['work']);
    await sql.unsafe(
      `INSERT INTO entity_card (entity_id, summary, trust_level, derivation, confidence, origin_contexts)
       VALUES ($1::bigint, 'A model sentence.', 'model_inferred', 'model_derived', 0.9, ARRAY['work','personal'])`,
      [keeper],
    );
    await sql.unsafe(
      `INSERT INTO entity_card (entity_id, summary, trust_level, derivation, confidence, origin_contexts)
       VALUES ($1::bigint, 'The owner approved this.', 'user_stated', 'model_derived', 1, ARRAY['work'])`,
      [loser],
    );

    const result = await apply(keeper, [loser]);
    const cards = (await sql`
      SELECT c.summary, c.trust_level, c.origin_contexts, c.entity_id::text AS entity_id
        FROM entity_card c JOIN entity e ON e.entity_id = c.entity_id AND e.deleted_at IS NULL
       WHERE c.deleted_at IS NULL
    `) as Array<{ summary: string; trust_level: string; origin_contexts: string[]; entity_id: string }>;
    expect(cards).toHaveLength(1);
    expect(cards[0]?.summary).toBe('The owner approved this.');
    expect(cards[0]?.entity_id).toBe(result.entityId);
    expect([...(cards[0]?.origin_contexts ?? [])].sort()).toEqual(['personal', 'work']);
  }, SETUP_TIMEOUT_MS);

  test('a shared spelling survives once, with the wider provenance', async () => {
    const keeper = await seed('Google LLC', ['work']);
    const loser = await seed('Google Inc', ['work']);
    await sql.unsafe(
      `INSERT INTO entity_alias (entity_id, alias, alias_source, origin_contexts)
       VALUES ($1::bigint, 'google', 'user', ARRAY['work']),
              ($2::bigint, 'google', 'user', ARRAY['personal']),
              ($2::bigint, 'google inc', 'user', ARRAY['work'])`,
      [keeper, loser],
    );

    const result = await apply(keeper, [loser]);
    const rows = (await sql.unsafe(
      `SELECT alias, origin_contexts FROM entity_alias WHERE entity_id = $1::bigint ORDER BY alias`,
      [result.entityId],
    )) as Array<{ alias: string; origin_contexts: string[] }>;
    expect(rows.map((row) => row.alias)).toEqual(['google', 'google inc']);
    // The unique key on (entity_id, alias) is total, which is why this is a
    // delete-then-insert and not an UPDATE.
    expect([...(rows[0]?.origin_contexts ?? [])].sort()).toEqual(['personal', 'work']);
  }, SETUP_TIMEOUT_MS);

  test('two members pointing at each other do not become a self-loop', async () => {
    const keeper = await seed('Google LLC', ['work']);
    const loser = await seed('Google Inc', ['work']);
    await sql.unsafe(
      `INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
       VALUES ($1::bigint, 'part_of', $2::bigint, ARRAY['work'])`,
      [loser, keeper],
    );

    await apply(keeper, [loser]);
    // The schema refuses a self-loop, and dropping it is the right answer: a
    // thing does not have a relationship with itself.
    const edges = (await sql`SELECT count(*)::int AS n FROM entity_edge WHERE deleted_at IS NULL`) as Array<{ n: number }>;
    expect(edges[0]?.n).toBe(0);
  }, SETUP_TIMEOUT_MS);

  test("the loser's address keeps resolving, as a redirect", async () => {
    const keeper = await seed('Google LLC', ['work']);
    const loser = await seed('Google Inc', ['work']);
    await sql.unsafe(
      `INSERT INTO entity_slug (slug, entity_id, kind) VALUES ('google-llc', $1::bigint, 'canonical'),
                                                             ('google-inc', $2::bigint, 'canonical')`,
      [keeper, loser],
    );

    const result = await apply(keeper, [loser]);
    const slugs = (await sql`
      SELECT slug, kind, entity_id::text AS entity_id FROM entity_slug ORDER BY slug
    `) as Array<{ slug: string; kind: string; entity_id: string }>;
    expect(slugs.map((row) => [row.slug, row.kind])).toEqual([
      ['google-inc', 'redirect'],
      ['google-llc', 'canonical'],
    ]);
    for (const row of slugs) expect(row.entity_id).toBe(result.entityId);
  }, SETUP_TIMEOUT_MS);

  test('an open proposal on the loser follows the survivor', async () => {
    const keeper = await seed('Google LLC', ['work']);
    const loser = await seed('Google Inc', ['work']);
    await sql.unsafe(
      `INSERT INTO review_queue (kind, target_ref, proposal, confidence, origin_contexts)
       VALUES ('entity_card', 'entity:' || $1::text, 'A summary.', 0.6, ARRAY['work'])`,
      [loser],
    );

    const result = await apply(keeper, [loser]);
    const rows = (await sql`SELECT target_ref FROM review_queue WHERE state = 'open'`) as Array<{
      target_ref: string;
    }>;
    expect(rows[0]?.target_ref).toBe(`entity:${result.entityId}`);
  }, SETUP_TIMEOUT_MS);
});
