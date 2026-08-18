/**
 * Severance used to leave `entity_alias` behind, and the surviving rows were
 * still served. This file reproduced that; it now pins the closure.
 *
 * **This file's second describe used to assert the broken behaviour on purpose,
 * written to fail the day somebody fixed it. That day is this commit**, and the
 * ledger row `gap.data-lifecycle` says so in the same words. What follows is the
 * fixed behaviour, plus the two decisions that shape it.
 *
 * ============================================================================
 * WHAT THE RESIDUE WAS
 * ============================================================================
 *
 * `severance.ts` divides the corpus in three and the first class is "rows whose
 * origins are **exactly** the severed one — these go". Rung 11 gave
 * `entity_alias` its own `origin_contexts`, precisely so an alias can be
 * narrower than the entity it hangs off: `resolveOrCreateEntity` plants the
 * normalized surface form taken from the text being ingested, so an alias is a
 * spelling an outside sender chose, in one mailbox.
 *
 * A work-only alias on a *mixed* entity is therefore exactly the first class —
 * and nothing took it. `tombstoneExactOrigin` did not write to `entity_alias`;
 * `entity_alias` has no `deleted_at` column at all, so there was no tombstone to
 * write and nothing for `purgeExpiredTombstones` to sweep; and its only route
 * out is `entity_alias_entity_fkey ... ON DELETE CASCADE`, which never fires
 * because the entity is mixed and severance keeps it *by design*.
 *
 * It was not merely retained, it was still answered with. `reads.ts:brainOrigins`
 * builds the census from live rows including the mixed entity's own immutable
 * `origin_contexts`, so a whole-brain grant still resolved `work:mail`, still
 * passed `entityCard`'s subset fence on the alias, and was still handed the
 * spelling that only ever existed in the account the user disconnected.
 *
 * ============================================================================
 * WHY THE ROW IS MOVED RATHER THAN FLAGGED
 * ============================================================================
 *
 * The obvious fix — `ALTER TABLE entity_alias ADD COLUMN deleted_at` — is the
 * wrong shape here, for two reasons the first describe below asserts against the
 * catalog rather than asserting in prose:
 *
 *   * **Nine read sites resolve aliases** (`reads.ts` ×3, `search/read.ts` ×2,
 *     `search/arms.ts`, `briefing/assemble.ts`, `write/links.ts` ×2, plus
 *     `subject-erasure.ts`). Every one that forgot a `deleted_at IS NULL`
 *     predicate would keep serving the retracted spelling — the defect, one
 *     layer down, in eight places that would each have to remember.
 *   * **`entity_alias_is_unique_per_entity` is a TOTAL unique constraint**, not a
 *     partial one over live rows. A tombstoned alias would permanently block
 *     re-creating that spelling for that entity, and making the constraint
 *     partial is a contracting change the rung discipline forbids.
 *
 * Moving the row to `severed_alias` (rung 12) dissolves both. A row that is not
 * in `entity_alias` cannot be returned by a query against `entity_alias`, so no
 * read site needs to be taught anything; and it occupies no slot, so the
 * spelling is free to be written again the moment the user re-connects.
 *
 * And it keeps the guarantee that made a hard delete unacceptable: severance is
 * **not a more final operation than `forget`**. The archive is restorable by the
 * same instant for the same 72 hours, and the purge empties it on the same
 * clock.
 *
 * ============================================================================
 * WHAT IS DELIBERATELY *NOT* FIXED: `brainOrigins` STILL RESOLVES `work:mail`
 * ============================================================================
 *
 * The census reports a severed origin forever, because origins are immutable and
 * the surviving mixed rows carry it. That reads like the third residual and it
 * is not one — the last describe below is the evidence.
 *
 * Subtracting severed origins from the census is the only way to stop it
 * resolving, and it is the same knob as "may a whole-brain grant read a mixed
 * row". `fenceRow` is a *subset* rule, so a fact or an alias carrying
 * `{work, personal}` is refused the moment `work:mail` leaves the grant. That
 * would reverse the other half of the very promise this file is about —
 * `severance.ts`: "rows whose origins **include** it and others — **these
 * stay**", pinned by `test/core/lifecycle/severance.test.ts`'s "the surviving
 * halves are still there — severance is not a purge of the brain".
 *
 * So: once the exact-origin rows are gone, `work:mail` in the census is
 * load-bearing for exactly the rows severance promised to keep, and for nothing
 * else. The last describe asserts both halves of that sentence.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { severOrigin } from '../../../src/core/lifecycle/severance.ts';
import { brainOrigins, entityCard } from '../../../src/mcp/reads.ts';
import { purgeExpiredTombstones, restoreForgotten } from '../../../src/mcp/tombstone.ts';
import { EMBEDDING_DIMENSIONS } from '../../../src/schema/vector-index.ts';
import { connect, dropFixtureDatabase, provisionFixture, type SchemaFixture } from '../../schema/fixture.ts';

import type { SQL } from 'bun';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

const WORK = 'work:mail';
const PERSONAL = 'personal:mail';

/** A spelling that only ever existed in the account the user disconnects. */
const WORK_ONLY_ALIAS = 'the work nickname';
const SHARED_ALIAS = 'shared person';

const SEVERED_AT = new Date('2026-06-10T00:00:00.000Z');
const INSIDE_WINDOW = new Date('2026-06-10T02:00:00.000Z');
const SEVERED_AGAIN = new Date('2026-06-11T00:00:00.000Z');
const LONG_AFTER = new Date('2026-06-30T00:00:00.000Z');

let schema: SchemaFixture;
let sql: SQL;

beforeAll(async () => {
  schema = await provisionFixture('severalias');
  sql = connect(schema);

  await sql.unsafe(`
    INSERT INTO page (origin_context, source_type, title, external_ref, embedding_model,
                      embedding_dimensions, chunker_version, normalizer_version, content_sha256)
    VALUES ('${WORK}', 'email', 'The renewal', 'gmail:w1', 'text-embedding-3-small',
            ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64)),
           ('${PERSONAL}', 'email', 'The invoice', 'gmail:p1', 'text-embedding-3-small',
            ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('b', 64));
  `);

  const rows = (await sql.unsafe(`
    INSERT INTO entity (canonical_name, entity_type, origin_contexts)
    VALUES ('Shared Person', 'person', ARRAY['${WORK}', '${PERSONAL}'])
    RETURNING entity_id::text AS entity_id
  `)) as Array<{ entity_id: string }>;
  const entityId = rows[0]?.entity_id ?? '';

  await sql.unsafe(`
    INSERT INTO entity_alias (entity_id, alias, alias_source, origin_contexts)
    VALUES (${entityId}::bigint, '${SHARED_ALIAS}', 'user', ARRAY['${WORK}', '${PERSONAL}']),
           (${entityId}::bigint, '${WORK_ONLY_ALIAS}', 'user', ARRAY['${WORK}']);
    INSERT INTO entity_slug (slug, entity_id, kind)
    VALUES ('shared-person', ${entityId}::bigint, 'canonical');
  `);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await sql?.close();
  if (schema !== undefined) await dropFixtureDatabase(schema);
});

async function aliases(): Promise<string[]> {
  const rows = (await sql`SELECT alias FROM entity_alias ORDER BY alias`) as Array<{ alias: string }>;
  return rows.map((row) => row.alias);
}

describe('the shape that forced a move rather than a tombstone', () => {
  test(
    'entity_alias still has no deleted_at, and its uniqueness is still total',
    async () => {
      // Both facts are unchanged by this commit, and both are the *reason* for
      // the archive: there is no tombstone to write, and a tombstoned row would
      // hold the spelling's slot against its own re-creation. Asserted against
      // the catalog so the argument cannot drift from the schema.
      const columns = (await sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'entity_alias'
      `) as Array<{ column_name: string }>;
      expect(columns.map((row) => row.column_name)).not.toContain('deleted_at');

      const unique = (await sql`
        SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'entity_alias_is_unique_per_entity'
      `) as Array<{ indexdef: string }>;
      expect(unique).toHaveLength(1);
      expect(unique[0]?.indexdef ?? '').not.toContain('WHERE');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a work-only alias sits on an entity severance deliberately keeps',
    async () => {
      const outcome = await severOrigin(sql, { origin: WORK, confirm: WORK, now: SEVERED_AT });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      // The entity is mixed, so it survives — that is the documented behaviour,
      // and it is what leaves the alias with no cascade to ride.
      expect(outcome.receipt.tombstoned.entities).toBe(0);
      expect(outcome.receipt.recomputed.entities).toBe(1);
      // And the alias went anyway, which is what this file used to say could not
      // happen.
      expect(outcome.receipt.archived.aliases).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the residue is taken, and taking it does not out-live the undo', () => {
  test(
    'the work-only alias leaves entity_alias at the severance, and the shared one stays',
    async () => {
      expect(await aliases()).toEqual([SHARED_ALIAS]);
      // Moved, not destroyed: the row is in the archive carrying the severance
      // instant, which is the key `restoreForgotten` undoes by.
      const archived = (await sql`
        SELECT alias, origin_contexts, severed_at FROM severed_alias
      `) as Array<{ alias: string; origin_contexts: string[]; severed_at: string }>;
      expect(archived).toHaveLength(1);
      expect(archived[0]?.alias).toBe(WORK_ONLY_ALIAS);
      expect(archived[0]?.origin_contexts).toEqual([WORK]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and it is no longer served, while the shared spelling still is',
    async () => {
      // The whole-brain census — the strongest grant this brain issues, and the
      // one that used to be handed the disconnected account's spelling.
      const census = await brainOrigins(sql);
      const card = await entityCard(sql, census, 'Shared Person');
      expect(card.status).toBe('ok');
      if (card.status !== 'ok') return;

      expect(card.card.aliases).not.toContain(WORK_ONLY_ALIAS);
      // Without this the assertion above is satisfied by a card with no aliases
      // at all, which is the trivial pass every absence assertion has.
      expect(card.card.aliases).toContain(SHARED_ALIAS);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a restore inside the window puts the spelling back verbatim',
    async () => {
      const restored = await restoreForgotten(sql, {
        deletedAt: SEVERED_AT.toISOString(),
        now: INSIDE_WINDOW,
      });
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.unarchived.aliases).toBe(1);

      expect(await aliases()).toEqual([SHARED_ALIAS, WORK_ONLY_ALIAS]);
      const back = (await sql`
        SELECT origin_contexts, alias_source FROM entity_alias WHERE alias = ${WORK_ONLY_ALIAS}
      `) as Array<{ origin_contexts: string[]; alias_source: string }>;
      // Verbatim: the archive is a holding pen, not a re-derivation. Its origins
      // come back as they were, which R15 requires — they were never editable.
      expect(back[0]?.origin_contexts).toEqual([WORK]);
      expect(back[0]?.alias_source).toBe('user');
      expect((await sql`SELECT count(*)::int AS n FROM severed_alias`) as Array<{ n: number }>).toEqual([
        { n: 0 },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a slot the archive vacated can be re-used while the row is away',
    async () => {
      // The constraint objection, answered by measurement. Sever again, then
      // write the same spelling for the same entity: a tombstoned row would
      // raise 23505 here, an archived one is not in the table to collide with.
      const again = await severOrigin(sql, { origin: WORK, confirm: WORK, now: SEVERED_AGAIN });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.receipt.archived.aliases).toBe(1);

      await sql.unsafe(`
        INSERT INTO entity_alias (entity_id, alias, alias_source, origin_contexts)
        SELECT entity_id, '${WORK_ONLY_ALIAS}', 'user', ARRAY['${PERSONAL}']
          FROM entity WHERE canonical_name = 'Shared Person'
      `);
      expect(await aliases()).toEqual([SHARED_ALIAS, WORK_ONLY_ALIAS]);

      // And the restore that now cannot come back says so rather than raising a
      // 23505 that would abort every other table's undo — the same policy
      // `supersededCards` states for `entity_card`.
      const blocked = await restoreForgotten(sql, {
        deletedAt: SEVERED_AGAIN.toISOString(),
        now: new Date(SEVERED_AGAIN.getTime() + 3600_000),
      });
      expect(blocked.ok).toBe(true);
      if (!blocked.ok) return;
      expect(blocked.unarchived.aliases).toBe(0);
      expect(blocked.supersededAliases).toBe(1);

      // Clean up the squatter so the purge case below reads only its own rows.
      await sql`DELETE FROM entity_alias WHERE origin_contexts = ARRAY[${PERSONAL}]::text[]`;
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and past the window the purge empties the archive for good',
    async () => {
      const purged = await purgeExpiredTombstones(sql, { now: LONG_AFTER });
      expect(purged.counts.aliases).toBe(1);

      expect(await aliases()).toEqual([SHARED_ALIAS]);
      expect((await sql`SELECT count(*)::int AS n FROM severed_alias`) as Array<{ n: number }>).toEqual([
        { n: 0 },
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the census still resolves the severed origin, and that is load-bearing', () => {
  test(
    'brainOrigins reports work:mail after the severance AND after the purge',
    async () => {
      // Put the brain in the state the claim is about — severed, window closed,
      // purge run. The cases above deliberately exercised the undo, which is
      // what put the work rows back.
      const finally_ = new Date('2026-07-01T00:00:00.000Z');
      const wellAfter = new Date('2026-07-20T00:00:00.000Z');
      const last = await severOrigin(sql, { origin: WORK, confirm: WORK, now: finally_ });
      expect(last.ok).toBe(true);
      await purgeExpiredTombstones(sql, { now: wellAfter });

      // Reported as an observed fact rather than fixed. Origins are immutable by
      // trigger and the surviving mixed entity carries the severed one, so the
      // census resolves it for as long as that row lives — which is until U11
      // re-derives it.
      const census = await brainOrigins(sql);
      expect(census).toContain(WORK);
      expect(census).toContain(PERSONAL);

      // And it is not coming from anything severance was supposed to take:
      // every live row that carries it is a MIXED row.
      const carriers = (await sql`
        SELECT
          (SELECT count(*)::int FROM page  WHERE deleted_at IS NULL AND origin_context = ${WORK}) AS pages,
          (SELECT count(*)::int FROM chunk WHERE deleted_at IS NULL AND origin_context = ${WORK}) AS chunks,
          (SELECT count(*)::int FROM fact  WHERE deleted_at IS NULL
             AND origin_contexts <@ ARRAY[${WORK}]::text[]) AS exact_facts,
          (SELECT count(*)::int FROM entity WHERE deleted_at IS NULL
             AND origin_contexts <@ ARRAY[${WORK}]::text[]) AS exact_entities,
          (SELECT count(*)::int FROM entity WHERE deleted_at IS NULL
             AND origin_contexts @> ARRAY[${WORK}]::text[]
             AND NOT (origin_contexts <@ ARRAY[${WORK}]::text[])) AS mixed_entities
      `) as Array<Record<string, number>>;
      const row = carriers[0] ?? {};
      expect([row.pages, row.chunks, row.exact_facts, row.exact_entities]).toEqual([0, 0, 0, 0]);
      expect(row.mixed_entities).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'because subtracting it would refuse the mixed rows severance promised to keep',
    async () => {
      // The measurement behind "this is not the third residual". `fenceRow` is a
      // subset rule: drop `work:mail` from the grant and the SHARED alias — a
      // row severance deliberately left standing — stops being served, along
      // with every mixed fact and card in the brain.
      const census = await brainOrigins(sql);
      const narrowed = census.filter((origin) => origin !== WORK);

      const whole = await entityCard(sql, census, 'Shared Person');
      expect(whole.status).toBe('ok');
      if (whole.status !== 'ok') return;
      expect(whole.card.aliases).toContain(SHARED_ALIAS);

      const withoutWork = await entityCard(sql, narrowed, 'Shared Person');
      expect(withoutWork.status).toBe('ok');
      if (withoutWork.status !== 'ok') return;
      // The cost, stated: this is what "fixing" the census would do to the half
      // of the corpus the preview's second column is about.
      expect(withoutWork.card.aliases).not.toContain(SHARED_ALIAS);
    },
    TEST_TIMEOUT_MS,
  );
});
