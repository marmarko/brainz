/**
 * The dictionary's only writer.
 *
 * Two properties carry most of the weight. **The erasure consult lives in the
 * sink**, not in the callers, because the contacts lane never passes
 * `partitionErasedSubjects` — it has no items to partition — so a caller-side
 * filter would let the daily address-book walk re-insert an erased person
 * within a day of the receipt saying this brain holds nothing about her. And
 * **the address book can never create anybody**: a book entry carries no page,
 * so it can never insert a sighting, so it can never satisfy an evidence test.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { correspondentsIn, observeCorrespondents } from '../../src/ingest/correspondents.ts';
import { eraseSubject } from '../../src/core/lifecycle/subject-erasure.ts';
import { createTenantFixture, type TenantFixture } from '../consolidate/fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const ORIGIN = 'personal:mail';
const NOW = new Date('2026-08-22T00:00:00.000Z');

let tenant: TenantFixture;
let sql: SQL;

beforeAll(async () => {
  tenant = await createTenantFixture('correspondents');
  sql = tenant.sql;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await tenant?.close();
});

beforeEach(async () => {
  await sql.unsafe(`
    DELETE FROM correspondent_sighting; DELETE FROM correspondent;
    DELETE FROM erased_subject; DELETE FROM chunk; DELETE FROM page;
  `);
});

async function seedPage(ref: string): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO page (origin_context, source_type, title, external_ref, derivation,
                       embedding_model, embedding_dimensions, chunker_version,
                       normalizer_version, content_sha256)
     VALUES ($1, 'email', 'a thread', $2, 'ingested', 'text-embedding-3-small', 1024, 1, 1,
             repeat('a', 64))
     RETURNING page_id::text AS id`,
    [ORIGIN, ref],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

const rows = async (): Promise<Array<Record<string, unknown>>> =>
  (await sql.unsafe(
    `SELECT address_key, display_name, name_key, name_source FROM correspondent
      ORDER BY address_key`,
  )) as Array<Record<string, unknown>>;

describe('parsing what a header states', () => {
  test('a named address keeps both halves; a bare one keeps the address', () => {
    expect(correspondentsIn('Alice Doe <alice@example.test>', 'from')).toEqual([
      { address: 'alice@example.test', name: 'Alice Doe', role: 'from' },
    ]);
    expect(correspondentsIn('bob@example.test', 'to')).toEqual([
      { address: 'bob@example.test', name: null, role: 'to' },
    ]);
  });

  test('a quoted name with a comma survives, which is why the pattern has two arms', () => {
    expect(correspondentsIn('"Doe, Alice" <alice@example.test>', 'from')[0]?.name).toBe(
      'Doe, Alice',
    );
  });

  test('a list yields one per address, de-duplicated', () => {
    const found = correspondentsIn('a@x.test, B <b@x.test>, a@x.test', 'cc');
    expect(found.map((who) => who.address)).toEqual(['b@x.test', 'a@x.test']);
  });
});

describe('observing what the providers said', () => {
  test('a sighting writes the dictionary row and the page that stated it', async () => {
    const page = await seedPage('m-1');
    const outcome = await observeCorrespondents(sql, {
      originContext: ORIGIN,
      at: NOW,
      sightings: [
        {
          pageId: page,
          correspondents: [
            { address: 'Alice@Example.test', name: 'Alice Doe', role: 'from' },
            { address: 'bob@example.test', name: null, role: 'to' },
          ],
        },
      ],
    });

    expect(outcome.addresses).toBe(2);
    expect(outcome.named).toBe(1);
    expect(outcome.sightings).toBe(2);
    const stored = await rows();
    // Keyed by `normalize`, which is what makes the key identical to the one
    // `subjectDigest` hashes.
    expect(stored.map((row) => row.address_key)).toEqual([
      'alice@example.test',
      'bob@example.test',
    ]);
    expect(stored[0]?.name_key).toBe('alice doe');
    expect(stored[0]?.name_source).toBe('headers');
    expect(stored[1]?.display_name).toBeNull();
  }, SETUP_TIMEOUT_MS);

  test('re-observing the same page is idempotent, and a later bare header keeps the name', async () => {
    const page = await seedPage('m-1');
    const state = {
      originContext: ORIGIN,
      at: NOW,
      sightings: [
        {
          pageId: page,
          correspondents: [{ address: 'alice@example.test', name: 'Alice Doe', role: 'from' }],
        },
      ],
    };
    await observeCorrespondents(sql, state);
    // The commonest poll outcome is `unchanged`, so this path runs constantly.
    const second = await observeCorrespondents(sql, state);
    expect(second.sightings).toBe(0);

    // A later message names her with no display name. The spelling must survive.
    await observeCorrespondents(sql, {
      originContext: ORIGIN,
      at: NOW,
      sightings: [
        {
          pageId: page,
          correspondents: [{ address: 'alice@example.test', name: null, role: 'cc' }],
        },
      ],
    });
    const stored = await rows();
    expect(stored[0]?.display_name).toBe('Alice Doe');

    const sightings = (await sql.unsafe(
      `SELECT role FROM correspondent_sighting ORDER BY role`,
    )) as Array<{ role: string }>;
    expect(sightings.map((row) => row.role)).toEqual(['cc', 'from']);
  }, SETUP_TIMEOUT_MS);

  test('the address book states without sighting, so it can never create anybody', async () => {
    const outcome = await observeCorrespondents(sql, {
      originContext: 'pipedream:contacts',
      at: NOW,
      stated: [{ address: 'carol@example.test', name: 'Carol Chen', role: 'book' }],
    });
    expect(outcome.addresses).toBe(1);
    // No page, so no sighting — which is the structural reason a book entry can
    // never satisfy an evidence test.
    expect(outcome.sightings).toBe(0);
    const sightings = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM correspondent_sighting`,
    )) as Array<{ n: number }>;
    expect(sightings[0]?.n).toBe(0);
    expect((await rows())[0]?.name_source).toBe('book');
  }, SETUP_TIMEOUT_MS);

  test('an erased person is dropped by address AND by name', async () => {
    await eraseSubject({ sql }, { identifier: 'gone@example.test', erasedBy: 'app' });
    await eraseSubject({ sql }, { identifier: 'Named Person', erasedBy: 'app' });
    const page = await seedPage('m-1');

    const outcome = await observeCorrespondents(sql, {
      originContext: ORIGIN,
      at: NOW,
      sightings: [
        {
          pageId: page,
          correspondents: [
            { address: 'gone@example.test', name: 'Gone Person', role: 'from' },
            { address: 'other@example.test', name: 'Named Person', role: 'to' },
            { address: 'fine@example.test', name: 'Fine Person', role: 'cc' },
          ],
        },
      ],
    });

    expect(outcome.suppressed).toBe(2);
    // No row and no sighting for either — a suppressed correspondent is not a
    // row with a flag on it.
    expect((await rows()).map((row) => row.address_key)).toEqual(['fine@example.test']);
  }, SETUP_TIMEOUT_MS);

  test('a machine-shaped display name is refused while the address is kept', async () => {
    const page = await seedPage('m-1');
    const outcome = await observeCorrespondents(sql, {
      originContext: ORIGIN,
      at: NOW,
      sightings: [
        {
          pageId: page,
          correspondents: [
            { address: 'a@example.test', name: '=?UTF-8?B?TWFya28=?=', role: 'from' },
            { address: 'b@example.test', name: 'someone@else.test', role: 'to' },
          ],
        },
      ],
    });
    expect(outcome.refusedNames).toBe(2);
    // The address is the useful half and is still recorded; only the name goes.
    const stored = await rows();
    expect(stored).toHaveLength(2);
    for (const row of stored) expect(row.display_name).toBeNull();
  }, SETUP_TIMEOUT_MS);

  test('a mass mailing states no correspondents at all, rather than an arbitrary 25', async () => {
    const page = await seedPage('m-1');
    const many = Array.from({ length: 40 }, (_, at) => ({
      address: `person${at}@example.test`,
      name: null,
      role: 'to' as const,
    }));

    const outcome = await observeCorrespondents(sql, {
      originContext: ORIGIN,
      at: NOW,
      sightings: [
        {
          pageId: page,
          correspondents: [
            { address: 'sender@example.test', name: 'The Sender', role: 'from' },
            ...many,
          ],
        },
      ],
    });

    expect(outcome.droppedByRecipientCap).toBe(1);
    // A 200-recipient blast contains no correspondents, so taking an arbitrary
    // 25 of them would be a silently arbitrary answer. The sender is kept —
    // a blast still has one.
    expect((await rows()).map((row) => row.address_key)).toEqual(['sender@example.test']);
  }, SETUP_TIMEOUT_MS);
});
