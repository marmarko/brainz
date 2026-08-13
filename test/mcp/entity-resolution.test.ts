/**
 * The `entity` tool's name resolution — the ladder, and the normalizer under it.
 *
 * **Why this file exists at all.** `stack.shared-normalizer` is the ledger row
 * that says the alias table is queried the way it was populated, and the whole
 * point of it is that drift between the two sides has *no symptom*: an alias
 * stored the way `write/links.ts` files it (a {@link normalize} key, punctuation
 * folded) and looked up the way a phone keyboard spells it (a curly apostrophe,
 * a fullwidth letter) simply does not match. Nothing throws, nothing is logged,
 * the entity is merely not found — on the one tool whose entire justification
 * for having a name is that it is the fast entity lookup.
 *
 * So the assertions below are *parity* assertions, not behaviour assertions:
 * the same spelling that reaches an entity through `recall`'s alias ladder must
 * reach the same entity through `entity`. A test that only checked `entity` in
 * isolation would go green the moment someone gave it a second normalizer of
 * its own, which is the failure one layer down.
 *
 * **Everything is written through the real write path.** `resolveOrCreateEntity`
 * is what files an entity's names, so a fixture that inserted alias rows its own
 * way would be testing a lookup against keys production never writes.
 */

import type { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { fleetIdentity } from '../../src/control/secrets.ts';
import { recallArms } from '../../src/core/search/read.ts';
import { resolveOrCreateEntity } from '../../src/core/write/links.ts';
import { textArrayLiteral } from '../../src/core/write/pg-values.ts';
import { formatId } from '../../src/mcp/ids.ts';
import { entityCard } from '../../src/mcp/reads.ts';
import { createMcpFixture, type McpFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const PERSONAL = 'personal:mail';
const GRANT = [PERSONAL];

/**
 * The name as a keyboard types it — a straight apostrophe. This is what the
 * write path stores, and the queries below are the same name as everything
 * *else* spells it.
 */
const TYPED_NAME = "O'Brien Ltd";

/** What a phone keyboard, a mail client and a word processor all produce. */
const CURLY_QUERY = 'O’Brien Ltd';

/** A fullwidth paste: NFKC's own territory, which `toLowerCase` cannot reach. */
const FULLWIDTH_QUERY = 'Ｏ＇Ｂｒｉｅｎ　Ｌｔｄ';

let fixture: McpFixture;
let sql: SQL;
let obrienId: string;
let mailSpelledId: string;
let renamedId: string;
let aliasedId: string;
let seededId: string;

beforeAll(async () => {
  fixture = await createMcpFixture('entityres');
  sql = fixture.sql;

  const obrien = await resolveOrCreateEntity(sql, {
    name: TYPED_NAME,
    type: 'organization',
    origins: [PERSONAL],
    taxonomyVersion: 1,
  });
  obrienId = obrien.entityId;

  // The other direction, and the one only a key-to-key comparison answers: the
  // corpus spelled the name the way a mail client does, so `canonical_name`
  // holds a curly apostrophe and the alias holds the fold of it. A query typed
  // straight matches the stored *key* and cannot match `lower(canonical_name)`.
  const mailSpelled = await resolveOrCreateEntity(sql, {
    name: 'Dunne’s Bakery',
    type: 'organization',
    origins: [PERSONAL],
    taxonomyVersion: 1,
  });
  mailSpelledId = mailSpelled.entityId;

  // An entity with a *declared* alias that shares no token with its canonical
  // name — the rung the ladder's first step is for.
  const aliased = await resolveOrCreateEntity(sql, {
    name: 'Widget Co International',
    type: 'organization',
    origins: [PERSONAL],
    taxonomyVersion: 1,
  });
  aliasedId = aliased.entityId;
  await sql`
    INSERT INTO entity_alias (entity_id, alias, alias_source, confidence)
    VALUES (${aliasedId}::bigint, ${'wci'}, 'user', 0.9)
  `;

  // A renamed entity: the old address stays in the namespace as a redirect,
  // which is the reason redirects and canonical slugs share one primary key.
  const renamed = await resolveOrCreateEntity(sql, {
    name: 'Northwind Trading',
    type: 'organization',
    origins: [PERSONAL],
    taxonomyVersion: 1,
  });
  renamedId = renamed.entityId;
  await sql`
    INSERT INTO entity_slug (slug, entity_id, kind)
    VALUES (${'northwind-imports'}, ${renamedId}::bigint, 'redirect')
  `;

  // An entity filed by a path that wrote no alias row at all. Nothing in the
  // schema requires one, so the tool must still answer for its canonical name.
  const seeded = (await sql`
    INSERT INTO entity (canonical_name, entity_type, origin_contexts)
    VALUES (${'Aliasless Holdings'}, 'organization', ${textArrayLiteral([PERSONAL])}::text[])
    RETURNING entity_id::text AS entity_id
  `) as Array<{ entity_id: string }>;
  seededId = seeded[0]?.entity_id ?? '';
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

/** The entity ids `recall` resolves for a query, through the read path's ladder. */
async function resolvedByRecall(query: string): Promise<readonly string[]> {
  const outcome = await recallArms({
    sql,
    gateway: fixture.gateway.gateway,
    tenantId: fixture.tenantId,
    caller: fleetIdentity(fixture.tenantId),
    query,
    grant: GRANT,
    limit: 10,
    now: new Date(fixture.now()),
  });
  return outcome.resolvedEntityIds;
}

describe('one normalizer, both resolvers', () => {
  for (const [label, query] of [
    ['a curly apostrophe', CURLY_QUERY],
    ['a fullwidth paste', FULLWIDTH_QUERY],
  ] as const) {
    test(
      `${label} reaches the same entity through \`entity\` as through \`recall\``,
      async () => {
        // The ranked read resolves it: `materialiseLadder` compares keys the
        // shared normalizer produced, on both sides.
        expect(await resolvedByRecall(query)).toContain(obrienId);

        // The tool must agree. It used to compare `name.trim().toLowerCase()`
        // against `lower(alias)`, which is a second normalizer with different
        // rules — it folds case and nothing else, so the fold the write path
        // applied is invisible to it.
        const outcome = await entityCard(sql, GRANT, query);
        expect(outcome.status).toBe('ok');
        if (outcome.status !== 'ok') return;
        expect(outcome.card.id).toBe(formatId('ent', obrienId));
        expect(outcome.card.name).toBe(TYPED_NAME);
      },
      TEST_TIMEOUT_MS,
    );
  }

  test(
    'the tool surface answers the same way the function does',
    async () => {
      const result = await fixture.call('entity', { name: CURLY_QUERY });
      expect(result.ok).toBe(true);
      const content = result.content as { found: boolean; card?: { name: string } };
      expect(content.found).toBe(true);
      expect(content.card?.name).toBe(TYPED_NAME);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a near miss suggests through the same keys',
    async () => {
      // The suggestion arm is the tool's honest degradation, so it has to fold
      // the query the same way the resolution arm does — a prefix taken from a
      // normalized key and matched against an unnormalized column suggests
      // nothing precisely when the user needed the hint.
      const outcome = await entityCard(sql, GRANT, 'O’Brien Consulting Partners');
      expect(outcome.status).toBe('not_found');
      if (outcome.status !== 'not_found') return;
      expect(outcome.suggestions).toContain(TYPED_NAME);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the rungs below exact match', () => {
  test(
    'a name the corpus spelled with a curly apostrophe answers a query typed straight',
    async () => {
      // `lower(canonical_name)` cannot answer this one: the stored spelling is
      // the curly one. Only the alias column holds a key both sides compute the
      // same way, which is why the comparison is made against it rather than
      // against a fold expressed in SQL.
      const outcome = await entityCard(sql, GRANT, "Dunne's Bakery");
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      expect(outcome.card.id).toBe(formatId('ent', mailSpelledId));
      expect(outcome.card.name).toBe('Dunne’s Bakery');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a declared alias resolves',
    async () => {
      const outcome = await entityCard(sql, GRANT, 'WCI');
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      expect(outcome.card.id).toBe(formatId('ent', aliasedId));
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a retired name resolves through the addressing namespace',
    async () => {
      // `Northwind Imports` is nobody's canonical name and nobody's alias. It is
      // an address, and the redirect is what keeps it reachable after a rename —
      // the same rung `links.ts:findEntityByName` uses on the write side.
      const outcome = await entityCard(sql, GRANT, 'Northwind Imports');
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      expect(outcome.card.id).toBe(formatId('ent', renamedId));
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an entity with no alias row still answers for its canonical name',
    async () => {
      const outcome = await entityCard(sql, GRANT, 'aliasless holdings');
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      expect(outcome.card.id).toBe(formatId('ent', seededId));
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and answers for it folded, because the fold is done to the question',
    async () => {
      // Neither key column can help here — there is no alias row and no slug —
      // so the only thing standing between a fullwidth paste and a miss is that
      // the asked name went through the shared normalizer before the comparison
      // rather than through `toLowerCase`, which leaves every fullwidth letter
      // exactly where it found it.
      const outcome = await entityCard(sql, GRANT, 'Ａｌｉａｓｌｅｓｓ　Ｈｏｌｄｉｎｇｓ');
      expect(outcome.status).toBe('ok');
      if (outcome.status !== 'ok') return;
      expect(outcome.card.id).toBe(formatId('ent', seededId));
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a name the brain has never heard is a miss, not an error',
    async () => {
      const outcome = await entityCard(sql, GRANT, 'Nobody At All Example');
      expect(outcome.status).toBe('not_found');
    },
    TEST_TIMEOUT_MS,
  );
});
