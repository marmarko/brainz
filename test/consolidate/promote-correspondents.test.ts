/**
 * Deciding that a correspondent is a person.
 *
 * **The refusals carry more weight than the promotions here**, and one of them
 * is a security property rather than a quality one: `findEntitiesByName` has no
 * type predicate and no origin predicate, so an admitted email carrying
 * `From: "Alice Example" <mallory@attacker.test>` would, without the binding
 * gate, latch a binding from the real Alice's entity onto the attacker's
 * address — and that binding is an erasure resolution key.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { corpusEvidence } from '../../src/core/write/entity-admission.ts';
import { resolveOrCreateEntities } from '../../src/core/write/links.ts';
import { promoteCorrespondents } from '../../src/worker/consolidate/promote-correspondents.ts';
import { unboundedAttempt } from '../../src/worker/consolidate/deadline.ts';
import { createTenantFixture, type TenantFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const MAIL = 'personal:mail';
const BOOK = 'pipedream:contacts';

let tenant: TenantFixture;
let sql: SQL;

beforeAll(async () => {
  tenant = await createTenantFixture('promotecorr');
  sql = tenant.sql;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await tenant?.close();
});

beforeEach(async () => {
  await sql.unsafe(`
    DELETE FROM correspondent_sighting; DELETE FROM correspondent;
    DELETE FROM entity_alias; DELETE FROM entity_slug; DELETE FROM entity;
    DELETE FROM chunk; DELETE FROM page;
  `);
});

const promote = () =>
  promoteCorrespondents(sql, {
    taxonomyVersion: 1,
    evidence: corpusEvidence([]),
    budget: unboundedAttempt(),
  });

async function seedPage(ref: string, options: { deleted?: boolean } = {}): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO page (origin_context, source_type, title, external_ref, derivation,
                       embedding_model, embedding_dimensions, chunker_version,
                       normalizer_version, content_sha256, deleted_at)
     VALUES ($1, 'email', 'a thread', $2, 'ingested', 'text-embedding-3-small', 1024, 1, 1,
             repeat('a', 64), $3::timestamptz)
     RETURNING page_id::text AS id`,
    [MAIL, ref, options.deleted === true ? new Date().toISOString() : null],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

async function seedCorrespondent(options: {
  readonly address: string;
  readonly name: string | null;
  readonly origin?: string;
  readonly source?: 'headers' | 'book';
  readonly entityId?: string | null;
  readonly promoted?: boolean;
  readonly retracted?: boolean;
}): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO correspondent (address_key, origin_context, display_name, name_key,
                                name_source, entity_id, promoted_at, retracted_at)
     VALUES ($1, $2, $3, $4, $5, $6::bigint, $7::timestamptz, $8::timestamptz)
     RETURNING correspondent_id::text AS id`,
    [
      options.address,
      options.origin ?? MAIL,
      options.name,
      options.name === null ? null : options.name.toLowerCase(),
      options.name === null ? null : (options.source ?? 'headers'),
      options.entityId ?? null,
      options.promoted === true ? new Date().toISOString() : null,
      options.retracted === true ? new Date().toISOString() : null,
    ],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

const sight = async (correspondentId: string, pageId: string, role: string): Promise<void> => {
  await sql.unsafe(
    `INSERT INTO correspondent_sighting (correspondent_id, page_id, role)
     VALUES ($1::bigint, $2::bigint, $3)`,
    [correspondentId, pageId, role],
  );
};

const entities = async (): Promise<string[]> =>
  (
    (await sql.unsafe(
      `SELECT canonical_name FROM entity WHERE deleted_at IS NULL ORDER BY canonical_name`,
    )) as Array<{ canonical_name: string }>
  ).map((row) => row.canonical_name);

describe('what promotion creates', () => {
  test('one addressed page is enough, because the owner wrote to them', async () => {
    const page = await seedPage('m-1');
    const who = await seedCorrespondent({ address: 'alice@example.test', name: 'Alice Doe' });
    await sight(who, page, 'to');

    const result = await promote();
    expect(result.created).toBe(1);
    expect(await entities()).toEqual(['Alice Doe']);

    // Latched, so a later pass does not re-decide.
    const row = (await sql.unsafe(
      `SELECT entity_id, promoted_at FROM correspondent WHERE correspondent_id = $1::bigint`,
      [who],
    )) as Array<{ entity_id: string | null; promoted_at: Date | null }>;
    expect(row[0]?.entity_id).not.toBeNull();
    expect(row[0]?.promoted_at).not.toBeNull();
  }, SETUP_TIMEOUT_MS);

  test('one FROM page is not enough — anybody who can send mail can arrange that', async () => {
    const page = await seedPage('m-1');
    const who = await seedCorrespondent({ address: 'mallory@attacker.test', name: 'Alice Doe' });
    await sight(who, page, 'from');

    const result = await promote();
    expect(result.created).toBe(0);
    expect(result.refusedBySignal.unattested).toBe(1);
    expect(await entities()).toEqual([]);
  }, SETUP_TIMEOUT_MS);

  test('two FROM pages do clear the floor, and the residual is disclosed', async () => {
    const who = await seedCorrespondent({ address: 'bob@example.test', name: 'Bob Roberts' });
    await sight(who, await seedPage('m-1'), 'from');
    await sight(who, await seedPage('m-2'), 'from');

    const result = await promote();
    expect(result.created).toBe(1);
  }, SETUP_TIMEOUT_MS);

  test('a forgotten page stops counting as evidence', async () => {
    // A `forget` TOMBSTONES the page; no cascade fires until the purge. The join
    // is what makes "evidence shrinks when a page is forgotten" true.
    const who = await seedCorrespondent({ address: 'carol@example.test', name: 'Carol Chen' });
    await sight(who, await seedPage('m-1', { deleted: true }), 'to');

    const result = await promote();
    expect(result.created).toBe(0);
    expect(await entities()).toEqual([]);
  }, SETUP_TIMEOUT_MS);
});

describe('what the address book can and cannot do', () => {
  test('a book entry binds to an entity the corpus already justified', async () => {
    // Through the ordinary resolver: a bare INSERT has no slug and no alias, so
    // `findEntitiesByName` cannot see it and the test would prove nothing.
    await resolveOrCreateEntities(sql, [
      { name: 'Dana Ilves', type: 'person', origins: [MAIL], taxonomyVersion: 1 },
    ]);
    const who = await seedCorrespondent({
      address: 'dana@example.test',
      name: 'Dana Ilves',
      origin: BOOK,
      source: 'book',
    });

    const result = await promote();
    expect(result.bound).toBe(1);
    // Bound, never created — and the roster did not grow.
    expect(result.created).toBe(0);
    expect(await entities()).toEqual(['Dana Ilves']);

    const row = (await sql.unsafe(
      `SELECT entity_id FROM correspondent WHERE correspondent_id = $1::bigint`,
      [who],
    )) as Array<{ entity_id: string | null }>;
    expect(row[0]?.entity_id).not.toBeNull();
  }, SETUP_TIMEOUT_MS);

  test('a book entry the corpus never mentions creates nobody, ever', async () => {
    // 2,512 of a measured 2,525 rows are this case. It has no sightings, so it
    // has no origins, so it can never reach the creation branch — structural
    // rather than a threshold anybody tuned.
    await seedCorrespondent({
      address: 'stranger@example.test',
      name: 'Complete Stranger',
      origin: BOOK,
      source: 'book',
    });

    const result = await promote();
    expect(result.created).toBe(0);
    expect(await entities()).toEqual([]);
  }, SETUP_TIMEOUT_MS);
});

describe('the name gate', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ['encoded_word', 'noisy@example.test', '=?UTF-8?B?TWFya28=?='],
    ['address_shaped', 'weird@example.test', 'someone@else.test'],
    ['machine_sender', 'no-reply@example.test', 'Acme Notifications'],
    ['name_is_the_local_part', 'billing@example.test', 'billing'],
    // The address deliberately does not share its local part with the name:
    // `name_is_the_local_part` runs first and would otherwise claim this one,
    // which is the gate ordering working rather than a miss.
    ['function_words_only', 'contact.person@example.test', 'Here'],
  ];

  for (const [signal, address, name] of cases) {
    test(`${signal}: ${name}`, async () => {
      const who = await seedCorrespondent({ address, name });
      await sight(who, await seedPage('m-1'), 'to');

      const result = await promote();
      expect(result.created).toBe(0);
      expect(result.refusedBySignal[signal]).toBe(1);
      expect(await entities()).toEqual([]);
    }, SETUP_TIMEOUT_MS);
  }
});

describe('a retraction is permanent', () => {
  test('a retracted row is never promoted again', async () => {
    const who = await seedCorrespondent({
      address: 'wrong@example.test',
      name: 'Wrong Person',
      retracted: true,
    });
    await sight(who, await seedPage('m-1'), 'to');

    const result = await promote();
    expect(result.created).toBe(0);
    expect(await entities()).toEqual([]);
  }, SETUP_TIMEOUT_MS);

  test('a binding pointing at a forgotten entity is read as a retraction, not repaired', async () => {
    // `forgetRecord` writes no suppression row of its own — the latched binding
    // IS the record. Rebinding here would resurrect the person 96 hours after
    // the owner retracted them.
    const gone = (await sql.unsafe(
      `INSERT INTO entity (canonical_name, entity_type, origin_contexts, deleted_at)
       VALUES ('Forgotten Person', 'person', ARRAY[$1]::text[], now())
       RETURNING entity_id::text AS id`,
      [MAIL],
    )) as Array<{ id: string }>;
    const who = await seedCorrespondent({
      address: 'forgotten@example.test',
      name: 'Forgotten Person',
      entityId: gone[0]?.id ?? null,
      promoted: true,
    });
    // A second, unlatched row for the same address — the shape a new sighting
    // under another credential would create.
    const second = await seedCorrespondent({
      address: 'forgotten@example.test',
      name: 'Forgotten Person',
      origin: BOOK,
      source: 'book',
    });
    await sight(second, await seedPage('m-1'), 'to');

    const result = await promote();
    expect(result.created).toBe(0);
    expect(result.refusedBySignal.retracted).toBe(1);
    // Still unbound, and no new person.
    const row = (await sql.unsafe(
      `SELECT entity_id FROM correspondent WHERE correspondent_id = $1::bigint`,
      [second],
    )) as Array<{ entity_id: string | null }>;
    expect(row[0]?.entity_id).toBeNull();
    void who;
  }, SETUP_TIMEOUT_MS);
});

/**
 * The starvation this pass was stuck in, found in production.
 *
 * A refused group stays unpromoted on purpose — the unknown reads closed, so a
 * later cycle re-decides when a second page arrives. Clamping the EXAMINATION
 * as well turns those two rules into a pass permanently stuck on whichever keys
 * sort first: measured on a real brain, 2,145 candidates of which 25 were
 * re-examined every cycle and 2,120 were never examined at all.
 */
describe('a key that sorts late is still examined', () => {
  test('a promotable correspondent past the creation cap is not starved by earlier refusals', async () => {
    // Thirty refusable rows that sort BEFORE the real one: named, but with no
    // sighting at all, so they can never promote and never latch.
    for (let at = 0; at < 30; at += 1) {
      await seedCorrespondent({
        address: `aaa${String(at).padStart(2, '0')}@example.test`,
        name: `Book Person ${at}`,
        origin: BOOK,
        source: 'book',
      });
    }
    // And one real correspondent whose address sorts last.
    const real = await seedCorrespondent({ address: 'zoe@example.test', name: 'Zoe Zheng' });
    await sight(real, await seedPage('m-1'), 'to');

    const result = await promote();
    // Examined despite thirty earlier candidates that will never resolve.
    expect(result.created).toBe(1);
    expect(await entities()).toEqual(['Zoe Zheng']);
  }, SETUP_TIMEOUT_MS);

  test('the cap bounds creation, not examination, and takes the best-attested first', async () => {
    // One weakly-attested candidate sorting first, one strongly-attested last.
    const weak = await seedCorrespondent({ address: 'aaa@example.test', name: 'Weak Evidence' });
    await sight(weak, await seedPage('m-1'), 'to');
    const strong = await seedCorrespondent({ address: 'zzz@example.test', name: 'Strong Evidence' });
    for (const ref of ['m-2', 'm-3', 'm-4']) await sight(strong, await seedPage(ref), 'to');

    const result = await promote();
    // Both clear the floor, so both are created — the point is that the one
    // sorting last was seen at all.
    expect(result.created).toBe(2);
    expect((await entities()).sort()).toEqual(['Strong Evidence', 'Weak Evidence']);
  }, SETUP_TIMEOUT_MS);
});
