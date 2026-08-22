/**
 * Retyping an entity, and the collision that must refuse the whole run.
 *
 * The interesting assertion is not that an UPDATE updates. It is that a
 * corrected type can move a row into an occupied `mergeEntitiesByRule` bucket —
 * `(normalize(canonical_name), entity_type, originKey(origins))` — and that the
 * damage from missing it lands up to thirty minutes later, by cron, through the
 * one path that hard-deletes an alias vocabulary with no undo. So the refusal
 * is tested before the success is.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { retypeEntities } from '../../src/ops/retype.ts';
import { createTenantFixture, type TenantFixture } from '../consolidate/fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;

let tenant: TenantFixture;
let sql: SQL;

beforeAll(async () => {
  tenant = await createTenantFixture('retypeops');
  sql = tenant.sql;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await tenant?.close();
});

beforeEach(async () => {
  await sql.unsafe(`DELETE FROM entity_edge; DELETE FROM entity_card; DELETE FROM entity;`);
});

async function seed(name: string, type: string, origins: string[] = ['personal']): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO entity (canonical_name, entity_type, origin_contexts)
     VALUES ($1, $2, $3::text[]) RETURNING entity_id::text AS id`,
    [name, type, `{${origins.join(',')}}`],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

const typeOf = async (name: string): Promise<string | null> => {
  const rows = (await sql.unsafe(
    `SELECT entity_type FROM entity WHERE canonical_name = $1 AND deleted_at IS NULL`,
    [name],
  )) as Array<{ entity_type: string }>;
  return rows[0]?.entity_type ?? null;
};

describe('retype', () => {
  test('a dry run writes nothing and says what it would do', async () => {
    await seed('Android', 'person');
    const outcome = await retypeEntities(sql, {
      names: ['Android'],
      to: 'organization',
      confirm: false,
    });
    expect(outcome.retyped.map((row) => row.canonical_name)).toEqual(['Android']);
    expect(outcome.applied).toBe(false);
    expect(await typeOf('Android')).toBe('person');
  }, SETUP_TIMEOUT_MS);

  test('--confirm corrects the type and re-opens the summary for re-derivation', async () => {
    const id = await seed('Android', 'person');
    await sql.unsafe(`UPDATE entity SET enrich_considered_version = 1 WHERE entity_id = $1::bigint`, [id]);

    const outcome = await retypeEntities(sql, {
      names: ['Android'],
      to: 'organization',
      confirm: true,
    });
    expect(outcome.applied).toBe(true);
    expect(await typeOf('Android')).toBe('organization');

    // The old summary described an organization as a person. NULLing the marker
    // is what gets it rewritten rather than left standing.
    const rows = (await sql.unsafe(
      `SELECT enrich_considered_version AS v FROM entity WHERE entity_id = $1::bigint`,
      [id],
    )) as Array<{ v: number | null }>;
    expect(rows[0]?.v).toBeNull();
  }, SETUP_TIMEOUT_MS);

  test('a collision refuses the WHOLE run, not just the offending row', async () => {
    // `Discover` typed person, and a `Discover` organization already there with
    // the same origins. Retyping the first lands it in the second's rule-merge
    // bucket, and the cron would then hard-delete one side's aliases.
    await seed('Discover', 'person');
    await seed('Discover', 'organization');
    await seed('Android', 'person');

    const outcome = await retypeEntities(sql, {
      names: ['Discover', 'Android'],
      to: 'organization',
      confirm: true,
    });

    expect(outcome.applied).toBe(false);
    expect(outcome.collisions.map((clash) => clash.name)).toEqual(['Discover']);
    // And the innocent row in the same run is untouched, because a
    // half-applied correction is a state nobody asked for and nobody watches.
    expect(await typeOf('Android')).toBe('person');
  }, SETUP_TIMEOUT_MS);

  test('a different origin set is not a collision, because the bucket key includes origins', async () => {
    await seed('Discover', 'person', ['personal']);
    await seed('Discover', 'organization', ['work']);

    const outcome = await retypeEntities(sql, {
      names: ['Discover'],
      to: 'organization',
      confirm: true,
    });
    expect(outcome.collisions).toEqual([]);
    expect(outcome.applied).toBe(true);
  }, SETUP_TIMEOUT_MS);

  test('a name that is not there is reported rather than silently ignored', async () => {
    await seed('Android', 'person');
    const outcome = await retypeEntities(sql, {
      names: ['Android', 'Nonesuch'],
      to: 'organization',
      confirm: false,
    });
    expect(outcome.missing).toEqual(['Nonesuch']);
  }, SETUP_TIMEOUT_MS);
});
