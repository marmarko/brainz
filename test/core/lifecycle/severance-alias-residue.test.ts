/**
 * Severance leaves `entity_alias` behind, and the surviving rows are still
 * served. Reproduced here rather than argued, and **not fixed** — see the last
 * section for why, and `upstream/concepts.jsonl:gap.data-lifecycle` for the row
 * that carries it.
 *
 * ============================================================================
 * WHAT SEVERANCE PROMISES, AND WHERE THE ALIAS FALLS OUT OF IT
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
 * and nothing takes it:
 *
 *   * `tombstoneExactOrigin` does not write to `entity_alias`;
 *   * `entity_alias` has **no `deleted_at` column at all**, so there is no
 *     tombstone to write and nothing for `purgeExpiredTombstones` to sweep;
 *   * its only route out is `entity_alias_entity_fkey ... ON DELETE CASCADE`,
 *     and the entity survives *by design* — it is mixed, so severance leaves it.
 *
 * ============================================================================
 * AND IT IS NOT MERELY RETAINED — IT IS STILL ANSWERED WITH
 * ============================================================================
 *
 * The obvious hope is that the fence hides it: `reads.ts:entityCard` admits an
 * alias only when `coalesce(a.origin_contexts, e.origin_contexts) <@ grant`, so
 * a grant without `work:mail` cannot see it.
 *
 * A whole-brain grant still has `work:mail`. `reads.ts:brainOrigins` builds the
 * census from live rows including `SELECT DISTINCT unnest(origin_contexts) FROM
 * entity`, origins are immutable by trigger, and the mixed entity carries the
 * severed origin forever. So after the severance *and* after the purge, the
 * ordinary connector still resolves the origin, still passes the subset fence,
 * and still gets handed the spelling that only ever existed in the account the
 * user disconnected.
 *
 * ============================================================================
 * WHY THIS FILE PINS THE GAP INSTEAD OF CLOSING IT
 * ============================================================================
 *
 * Neither available fix is a small edit, and both embed a decision:
 *
 *   1. **Hard-delete the exact-origin aliases inside `severOrigin`.** Cheap and
 *      wrong on its own terms: severance's own header says it "is not a more
 *      final operation than `forget` — a user who disconnects the wrong account
 *      at 2am must be able to undo it", and `restoreForgotten` now covers every
 *      other table it touches. An eighth class that is destroyed irreversibly
 *      contradicts the guarantee the other seven just gained.
 *
 *   2. **Give `entity_alias` a `deleted_at` (a new rung) and tombstone it.**
 *      The right shape, and it is not one edit: nine read sites resolve aliases
 *      (`reads.ts` ×3, `search/read.ts` ×2, `search/arms.ts`,
 *      `briefing/assemble.ts`, `write/links.ts` ×2, plus `subject-erasure.ts`)
 *      and every one that forgot the predicate would keep serving the retracted
 *      spelling — the defect, one layer down. And
 *      `entity_alias_is_unique_per_entity` is a **total** UNIQUE constraint, not
 *      a partial one over live rows, so a tombstoned alias permanently blocks
 *      re-creating that spelling for that entity: closing this needs either a
 *      contracting constraint change (which the rung discipline forbids) or a
 *      stated un-delete-on-conflict policy in the write path.
 *
 * A third shape — hard-delete the exact-origin aliases *at purge time*, keyed on
 * the `severance` log, so the 72h window is preserved and no column is added —
 * is the cheapest candidate and is still a new destructive sweep on a schedule
 * for rows no preview counts. `previewSeverance` does not count aliases, so
 * whichever fix lands has to decide whether the user is told first.
 *
 * **The assertions below therefore describe today, and they are written to fail
 * the day somebody fixes it.** That is deliberate: a green run here is not
 * approval, it is the gap staying where it was left. Whoever closes it deletes
 * this file's second describe and says so in the ledger row.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { severOrigin } from '../../../src/core/lifecycle/severance.ts';
import { brainOrigins, entityCard } from '../../../src/mcp/reads.ts';
import { purgeExpiredTombstones } from '../../../src/mcp/tombstone.ts';
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

describe('the shape that produces the residue is reachable', () => {
  test(
    'entity_alias has no deleted_at, so there is no tombstone to write',
    async () => {
      const columns = (await sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'entity_alias'
      `) as Array<{ column_name: string }>;
      expect(columns.map((row) => row.column_name)).not.toContain('deleted_at');

      // And the constraint that makes fix (2) more than an ADD COLUMN: the
      // uniqueness is total, so a tombstoned alias would block its own respelling.
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
    },
    TEST_TIMEOUT_MS,
  );
});

describe('THE OPEN GAP — these assertions describe today, not what is wanted', () => {
  test(
    'the work-only alias survives the severance and the purge',
    async () => {
      await purgeExpiredTombstones(sql, { now: LONG_AFTER });

      const aliases = (await sql`SELECT alias FROM entity_alias ORDER BY alias`) as Array<{ alias: string }>;
      // Fails the day a sweep lands. That is the point of writing it down.
      expect(aliases.map((row) => row.alias)).toContain(WORK_ONLY_ALIAS);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and it is still served, because the census still resolves the severed origin',
    async () => {
      // Origins are immutable by trigger and the surviving mixed entity carries
      // the severed one, so `brainOrigins` still reports it and a whole-brain
      // grant still expands to include it.
      const census = await brainOrigins(sql);
      expect(census).toContain(WORK);

      const card = await entityCard(sql, census, 'Shared Person');
      expect(card.status).toBe('ok');
      if (card.status !== 'ok') return;
      // The severity, stated: this is not "retained where nobody can reach it".
      // The ordinary connector is handed the disconnected account's spelling.
      expect(card.card.aliases).toContain(WORK_ONLY_ALIAS);
      expect(card.card.aliases).toContain(SHARED_ALIAS);
    },
    TEST_TIMEOUT_MS,
  );
});
