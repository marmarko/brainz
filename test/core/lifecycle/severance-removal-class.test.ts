/**
 * `previewSeverance.removed` has eight columns. This file audits the two the
 * executor never touched, and settles which of them was a residue.
 *
 * ============================================================================
 * THE CLAIM UNDER TEST
 * ============================================================================
 *
 * `severance.ts`'s header makes a contract out of the preview: "the numbers the
 * user consented to are the numbers that happened". A measurement found two
 * columns where it did not hold — `previewSeverance` reported
 * `{attachments: 1, edges: 1}` and `tombstoneExactOrigin` touched zero of each.
 * They turn out to be different findings wearing the same symptom, and the
 * difference is a constraint:
 *
 *   * **`attachment` was a real residue.** Scalar-origin, carries its own
 *     `deleted_at`, already swept by `purgeExpiredTombstones` — and absent from
 *     the executor. `attachment.page_id` is **nullable** and carries no
 *     origin-union constraint against its page, so a work attachment can hang
 *     off nothing at all, or off a page that survives, and no cascade reaches
 *     it. The stored object outlived a disconnect the user was told would remove
 *     it. Fixed: it is tombstoned with everything else, on the same instant.
 *
 *   * **`entity_edge` was not.** `entity_edge_origin_union` (rung 2) refuses any
 *     edge that does not carry the origins of BOTH entities it connects. So
 *     `edge ⊆ {severed}` forces `subject ⊆ {severed}` and `object ⊆ {severed}` —
 *     an exact-origin edge has two exactly-severed endpoints, both tombstoned by
 *     the executor's `entities` statement and both hard-deleted by the purge,
 *     which takes the edge with them through `ON DELETE CASCADE`. Meanwhile it
 *     has no live endpoint for `search/arms.ts:graphArm` to seed a neighbourhood
 *     from. The row leaves on the same clock as everything else; only the
 *     *mechanism* differs from what `tombstoned` reports.
 *
 * That is the same argument `severance-purge.test.ts` makes for `entity_card`,
 * and it is asserted the same way — **both halves**, because either alone is a
 * coincidence: the database must REFUSE the shape that would make the residue
 * reachable, and over the shape that IS reachable the purge must leave nothing.
 *
 * Writing a `deleted_at` on the edge instead would have been actively wrong:
 * that column is reserved by `tombstone.ts:DELETED_AT_IS_NOT_A_TOMBSTONE` for a
 * *reconciliation* retraction (`write/links.ts`, `consolidate/deterministic.ts`
 * set it when a later derivation supersedes an edge), and the table is
 * deliberately outside `TOMBSTONED_TABLES` — so severance's tombstone would have
 * been one no sweep ever reaches and one an undo could resurrect as live.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { previewSeverance } from '../../../src/core/lifecycle/blast-radius.ts';
import { recomputeWorklist, severOrigin } from '../../../src/core/lifecycle/severance.ts';
import { purgeExpiredTombstones, restoreForgotten } from '../../../src/mcp/tombstone.ts';
import { EMBEDDING_DIMENSIONS } from '../../../src/schema/vector-index.ts';
import {
  connect,
  dropFixtureDatabase,
  provisionFixture,
  sqlstateOfFailure,
  type SchemaFixture,
} from '../../schema/fixture.ts';

import type { SQL } from 'bun';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

const WORK = 'work:mail';
const PERSONAL = 'personal:mail';

const SEVERED_AT = new Date('2026-06-10T00:00:00.000Z');
const INSIDE_WINDOW = new Date('2026-06-10T02:00:00.000Z');
const SEVERED_AGAIN = new Date('2026-06-11T00:00:00.000Z');
const LONG_AFTER = new Date('2026-06-30T00:00:00.000Z');

let schema: SchemaFixture;
let sql: SQL;

/** Both mixed: the endpoints an exact-origin edge is not allowed to have. */
let mixedA = '';
let mixedB = '';
/** Both exactly work: the only endpoints an exact-origin edge may have. */
let pureA = '';
let pureB = '';

beforeAll(async () => {
  schema = await provisionFixture('severremoval');
  sql = connect(schema);

  await sql.unsafe(`
    INSERT INTO page (origin_context, source_type, title, external_ref, embedding_model,
                      embedding_dimensions, chunker_version, normalizer_version, content_sha256)
    VALUES ('${WORK}', 'email', 'The renewal', 'gmail:w1', 'text-embedding-3-small',
            ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64)),
           ('${PERSONAL}', 'email', 'The invoice', 'gmail:p1', 'text-embedding-3-small',
            ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('b', 64));

    -- Three attachments, and the first two are the ones that matter.
    --   * parentless: extraction could not attribute it, so NOTHING cascades to
    --     it — the shape that survived severance and the purge for the life of
    --     the tenant, in plaintext, with its stored object still in the bucket.
    --   * on a page that SURVIVES: no origin-union constraint ties an attachment
    --     to its page, so a work attachment can hang off the personal one.
    --   * on its own work page: the easy case, and the only one a cascade covers.
    INSERT INTO attachment (page_id, origin_context, media_type, object_key)
    VALUES (NULL, '${WORK}', 'application/pdf', 'tenants/t/att/orphan.pdf');
    INSERT INTO attachment (page_id, origin_context, media_type, object_key)
    SELECT page_id, '${WORK}', 'image/png', 'tenants/t/att/on-personal.png'
      FROM page WHERE external_ref = 'gmail:p1';
    INSERT INTO attachment (page_id, origin_context, media_type, object_key)
    SELECT page_id, '${WORK}', 'application/pdf', 'tenants/t/att/on-work.pdf'
      FROM page WHERE external_ref = 'gmail:w1';
    -- The control: a personal attachment, untouched throughout.
    INSERT INTO attachment (page_id, origin_context, media_type, object_key)
    SELECT page_id, '${PERSONAL}', 'application/pdf', 'tenants/t/att/personal.pdf'
      FROM page WHERE external_ref = 'gmail:p1';
  `);

  mixedA = await insertEntity('Alice Example', [WORK, PERSONAL]);
  mixedB = await insertEntity('Widget Co', [WORK, PERSONAL]);
  pureA = await insertEntity('Platform Team', [WORK]);
  pureB = await insertEntity('Acme Example', [WORK]);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await sql?.close();
  if (schema !== undefined) await dropFixtureDatabase(schema);
});

async function insertEntity(name: string, origins: readonly string[]): Promise<string> {
  const rows = (await sql.unsafe(
    `INSERT INTO entity (canonical_name, entity_type, origin_contexts)
     VALUES ($1, 'organization', $2::text[]) RETURNING entity_id::text AS entity_id`,
    [name, `{${origins.map((origin) => `"${origin}"`).join(',')}}`],
  )) as Array<{ entity_id: string }>;
  return rows[0]?.entity_id ?? '';
}

async function count(from: string): Promise<number> {
  const rows = (await sql.unsafe(`SELECT count(*)::int AS n FROM ${from}`)) as Array<{ n: number }>;
  return Number(rows[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------
// 1. The edge column: the residue has no way in.
// ---------------------------------------------------------------------------

describe('an exact-origin edge cannot have an endpoint severance keeps', () => {
  test(
    'the database refuses the only shape that would strand one',
    async () => {
      // This is the edge equivalent of the tombstoned-card-under-a-live-entity
      // hazard: severance would take the edge (its origins are exactly work) and
      // leave both endpoints (theirs are not). `entity_edge_origin_union` says
      // no, and it is a constraint rather than a convention — which is why the
      // executor needs no statement for this table.
      const state = await sqlstateOfFailure(
        sql,
        `INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
         VALUES (${mixedA}::bigint, 'works_at', ${mixedB}::bigint, ARRAY['${WORK}'])`,
      );
      expect(state).toBe('BZ002');

      // And the refusal is the union trigger's, not some other failure: the same
      // edge carrying both endpoints' origins is accepted — and it is MIXED, so
      // it belongs to the recompute column instead.
      await sql.unsafe(
        `INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
         VALUES (${mixedA}::bigint, 'works_at', ${mixedB}::bigint, ARRAY['${WORK}', '${PERSONAL}'])`,
      );
      expect(await count(`entity_edge WHERE deleted_at IS NULL`)).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'so the reachable shape carries two endpoints the severance takes with it',
    async () => {
      await sql.unsafe(
        `INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
         VALUES (${pureA}::bigint, 'invested_in', ${pureB}::bigint, ARRAY['${WORK}'])`,
      );
      const exact = (await sql`
        SELECT count(*)::int AS n FROM entity_edge
         WHERE origin_contexts <@ ARRAY[${WORK}]::text[] AND deleted_at IS NULL
      `) as Array<{ n: number }>;
      // Not vacuous: the column this describe is about is non-zero.
      expect(exact[0]?.n).toBe(1);

      const endpoints = (await sql`
        SELECT count(*)::int AS n FROM entity
         WHERE entity_id IN (${pureA}::bigint, ${pureB}::bigint)
           AND origin_contexts <@ ARRAY[${WORK}]::text[]
      `) as Array<{ n: number }>;
      expect(endpoints[0]?.n).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. The attachment column: the residue was real.
// ---------------------------------------------------------------------------

describe('every column of the preview is now a column the executor answers for', () => {
  test(
    'the attachments the preview counts are tombstoned, parentless ones included',
    async () => {
      const preview = await previewSeverance(sql, { origin: WORK });
      // Not vacuous, and specifically: more attachments than the work page could
      // ever have cascaded to.
      expect(preview.removed.attachments).toBe(3);
      expect(preview.removed.edges).toBe(1);

      const outcome = await severOrigin(sql, { origin: WORK, confirm: WORK, now: SEVERED_AT });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      // The number the user consented to is the number that happened.
      expect(outcome.receipt.tombstoned.attachments).toBe(preview.removed.attachments);
      expect(outcome.receipt.alreadySevered).toBe(false);

      // On the severance's own instant, which is what makes one undo reach all
      // of them.
      expect(
        await count(`attachment WHERE deleted_at = '${SEVERED_AT.toISOString()}'::timestamptz`),
      ).toBe(3);
      // The personal one is untouched: severance takes an origin, not a table.
      expect(await count(`attachment WHERE deleted_at IS NULL`)).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and the edge column is answered by the constraint rather than by a statement',
    async () => {
      // Zero, and it is the right answer: both endpoints went in the same
      // transaction, which is what the union constraint guarantees.
      const outcome = (await sql`
        SELECT count(*)::int AS n FROM entity
         WHERE entity_id IN (${pureA}::bigint, ${pureB}::bigint)
           AND deleted_at = ${SEVERED_AT.toISOString()}::timestamptz
      `) as Array<{ n: number }>;
      expect(outcome[0]?.n).toBe(2);

      // Stated as the general property, because it is the whole safety argument:
      // no live exact-origin edge has a live endpoint to be reached from.
      const reachable = (await sql`
        SELECT count(*)::int AS n
          FROM entity_edge e
          JOIN entity s ON s.entity_id = e.subject_entity_id
          JOIN entity o ON o.entity_id = e.object_entity_id
         WHERE e.deleted_at IS NULL
           AND e.origin_contexts <@ ARRAY[${WORK}]::text[]
           AND (s.deleted_at IS NULL OR o.deleted_at IS NULL)
      `) as Array<{ n: number }>;
      expect(reachable[0]?.n).toBe(0);

      // The mixed edge is in the other column and stays live, untouched.
      const worklist = await recomputeWorklist(sql);
      expect(worklist.counts.edges).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. The window, and the far side of it.
// ---------------------------------------------------------------------------

describe('the new takes are on forget’s clock like every other one', () => {
  test(
    'a restore inside the window brings the attachments back',
    async () => {
      const restored = await restoreForgotten(sql, {
        deletedAt: SEVERED_AT.toISOString(),
        now: INSIDE_WINDOW,
      });
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.restored.attachments).toBe(3);
      expect(await count('attachment WHERE deleted_at IS NULL')).toBe(4);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and past it the purge takes them, the parentless one included',
    async () => {
      const again = await severOrigin(sql, { origin: WORK, confirm: WORK, now: SEVERED_AGAIN });
      expect(again.ok).toBe(true);
      if (!again.ok) return;
      expect(again.receipt.tombstoned.attachments).toBe(3);

      const purged = await purgeExpiredTombstones(sql, { now: LONG_AFTER });
      expect(purged.attachments).toBe(3);

      // Nothing work-shaped left anywhere: the attachments by their own sweep,
      // the exact-origin edge by its endpoints' cascade.
      expect(await count(`attachment WHERE origin_context = '${WORK}'`)).toBe(0);
      expect(await count(`attachment`)).toBe(1);
      expect(await count(`entity_edge WHERE origin_contexts <@ ARRAY['${WORK}']::text[]`)).toBe(0);
      // And the mixed edge — the recompute class — is still standing.
      expect(await count('entity_edge WHERE deleted_at IS NULL')).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
