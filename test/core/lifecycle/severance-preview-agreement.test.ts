/**
 * The preview, the receipt and the audit row are one description of one event,
 * and this file is where the three are compared.
 *
 * `previewSeverance` is what the user reads before they click; `severOrigin`
 * re-runs it inside the executing transaction and writes *that* into rung 10's
 * append-only `severance` row. So a defect in the preview is not a cosmetic
 * defect: it is the number the user consented to AND the number the audit trail
 * keeps, both wrong in the same direction, with the executor quietly doing
 * something else.
 *
 * Two disagreements are pinned here, and each is a violating fixture rather than
 * an assertion about prose.
 *
 * ============================================================================
 * 1. THE OVER-COUNT: ROWS A PREVIOUS RETRACTION ALREADY HOLDS
 * ============================================================================
 *
 * The `page`, `chunk`, `fact`, `entity`, `entity_card` and `commitment` arms of
 * the preview all filter on `deleted_at IS NULL`. The `attachment` and
 * `entity_edge` arms did not. Both tables can hold retracted rows for reasons
 * that have nothing to do with this severance: a `forget` tombstones an
 * attachment (`src/mcp/tombstone.ts` purges it by its own `deleted_at`, because
 * `attachment.page_id` is nullable and it may have no parent to cascade from),
 * and a consolidation cycle retires an edge by writing `deleted_at` when a later
 * derivation supersedes it — the one column `DELETED_AT_IS_NOT_A_TOMBSTONE`
 * reserves for exactly that.
 *
 * The executor filters regardless, and deliberately: re-stamping a row another
 * retraction took would move it onto this instant and detach it from that call's
 * undo. So the mismatch was the preview's, and it inflated a destructive
 * operation's advertised cost with rows that were never going to move.
 *
 * ============================================================================
 * 2. THE UNDER-COUNT: THE TAKE WITH NO `deleted_at` BEHIND IT
 * ============================================================================
 *
 * Severance takes aliases by MOVING them into rung 12's `severed_alias` — the
 * one row class with no tombstone to write, because rung 11 lets an alias be
 * narrower than its entity and `entity_alias` has no `deleted_at` at all. The
 * receipt reported it as `archived.aliases` from the first commit that shipped
 * it. `RemovalCounts` had no `aliases` column, so the preview never mentioned
 * it and the audit jsonb — which is written *from* the preview — understated
 * every severance by every spelling it took.
 *
 * The three now agree by construction and the last test asserts the equality
 * across all three surfaces. It runs last, because it is the half that mutates.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { previewSeverance } from '../../../src/core/lifecycle/blast-radius.ts';
import { severOrigin } from '../../../src/core/lifecycle/severance.ts';
import { EMBEDDING_DIMENSIONS } from '../../../src/schema/vector-index.ts';
import { connect, dropFixtureDatabase, provisionFixture, type SchemaFixture } from '../../schema/fixture.ts';

import type { SQL } from 'bun';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

const WORK = 'work:mail';
const PERSONAL = 'personal:mail';

/** A retraction that happened before this severance and owns the rows it took. */
const EARLIER_RETRACTION = '2026-06-01T00:00:00.000Z';
const SEVERED_AT = new Date('2026-06-10T00:00:00.000Z');

let schema: SchemaFixture;
let sql: SQL;

beforeAll(async () => {
  schema = await provisionFixture('severpreview');
  sql = connect(schema);

  const embedding = `('[1' || repeat(',0', ${EMBEDDING_DIMENSIONS - 1}) || ']')::vector(${EMBEDDING_DIMENSIONS})`;

  await sql.unsafe(`
    INSERT INTO page (origin_context, source_type, title, embedding_model, embedding_dimensions,
                      chunker_version, normalizer_version, content_sha256)
    VALUES ('${WORK}', 'email', 'work mail', 'text-embedding-3-small',
            ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64)),
           ('${PERSONAL}', 'email', 'personal mail', 'text-embedding-3-small',
            ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('b', 64));

    INSERT INTO chunk (origin_context, content, page_id, ordinal)
    SELECT '${WORK}', 'a work passage', page_id, 0 FROM page WHERE title = 'work mail';
    INSERT INTO chunk (origin_context, content, page_id, ordinal)
    SELECT '${PERSONAL}', 'a personal passage', page_id, 0 FROM page WHERE title = 'personal mail';

    INSERT INTO fact (statement, embedding, origin_contexts, page_id)
    SELECT 'a work-only claim', ${embedding}, ARRAY['${WORK}'], page_id
      FROM page WHERE title = 'work mail';
    INSERT INTO fact (statement, embedding, origin_contexts)
    VALUES ('a claim both accounts attested', ${embedding}, ARRAY['${WORK}', '${PERSONAL}']);

    -- Attachments. One live, one a previous forget already holds. The second is
    -- the violating row: it is work-origin, so an unfiltered count takes it, and
    -- the executor will not touch it.
    INSERT INTO attachment (page_id, origin_context, media_type, object_key)
    SELECT page_id, '${WORK}', 'application/pdf', 'tenant/work/live.pdf'
      FROM page WHERE title = 'work mail';
    INSERT INTO attachment (page_id, origin_context, media_type, object_key, deleted_at)
    SELECT page_id, '${WORK}', 'application/pdf', 'tenant/work/already-retracted.pdf',
           '${EARLIER_RETRACTION}'::timestamptz
      FROM page WHERE title = 'work mail';

    INSERT INTO entity (canonical_name, entity_type, origin_contexts)
    VALUES ('work-only-person', 'person', ARRAY['${WORK}']),
           ('work-only-colleague', 'person', ARRAY['${WORK}']),
           ('mixed-person', 'person', ARRAY['${WORK}', '${PERSONAL}']),
           ('personal-only-person', 'person', ARRAY['${PERSONAL}']);

    -- Edges. A live work-only one and a work-only one a consolidation cycle
    -- already retired; then the same pair for the mixed column. The unique index
    -- over edges is partial (live rows only), so a retired twin is a shape the
    -- schema allows and a cycle actually produces.
    INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
    SELECT (SELECT entity_id FROM entity WHERE canonical_name = 'work-only-person'),
           'related_to',
           (SELECT entity_id FROM entity WHERE canonical_name = 'work-only-colleague'),
           ARRAY['${WORK}'];
    INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts, deleted_at)
    SELECT (SELECT entity_id FROM entity WHERE canonical_name = 'work-only-person'),
           'works_at',
           (SELECT entity_id FROM entity WHERE canonical_name = 'work-only-colleague'),
           ARRAY['${WORK}'], '${EARLIER_RETRACTION}'::timestamptz;

    INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
    SELECT (SELECT entity_id FROM entity WHERE canonical_name = 'mixed-person'),
           'related_to',
           (SELECT entity_id FROM entity WHERE canonical_name = 'personal-only-person'),
           ARRAY['${WORK}', '${PERSONAL}'];
    INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts, deleted_at)
    SELECT (SELECT entity_id FROM entity WHERE canonical_name = 'mixed-person'),
           'works_at',
           (SELECT entity_id FROM entity WHERE canonical_name = 'personal-only-person'),
           ARRAY['${WORK}', '${PERSONAL}'], '${EARLIER_RETRACTION}'::timestamptz;

    -- Aliases. Two are severance's first class and one is not:
    --   * a work-only spelling on a MIXED entity — the residue rung 12 exists
    --     for, since the entity survives and there is no cascade to ride;
    --   * an unstamped legacy spelling on a work-only entity, which the
    --     executor's coalesce reads as its entity's own union;
    --   * a spelling stamped with both origins, which stays.
    INSERT INTO entity_alias (entity_id, alias, alias_source, confidence, origin_contexts)
    SELECT entity_id, 'the work nickname', 'inferred', 0.9, ARRAY['${WORK}']
      FROM entity WHERE canonical_name = 'mixed-person';
    INSERT INTO entity_alias (entity_id, alias, alias_source, confidence, origin_contexts)
    SELECT entity_id, 'shared spelling', 'inferred', 0.9, ARRAY['${WORK}', '${PERSONAL}']
      FROM entity WHERE canonical_name = 'mixed-person';
    INSERT INTO entity_alias (entity_id, alias, alias_source, confidence, origin_contexts)
    SELECT entity_id, 'a spelling from before rung eleven', 'user', NULL, NULL
      FROM entity WHERE canonical_name = 'work-only-person';
  `);
}, { timeout: SETUP_TIMEOUT_MS });

afterAll(async () => {
  await sql?.close();
  if (schema !== undefined) await dropFixtureDatabase(schema);
});

describe('the fixture holds the rows that make each column non-vacuous', () => {
  test(
    'a retracted attachment, a retired edge in each column, and three aliases',
    async () => {
      const rows = (await sql`
        SELECT
          (SELECT count(*)::int FROM attachment WHERE deleted_at IS NOT NULL) AS retracted_attachments,
          (SELECT count(*)::int FROM attachment WHERE deleted_at IS NULL) AS live_attachments,
          (SELECT count(*)::int FROM entity_edge
            WHERE deleted_at IS NOT NULL
              AND origin_contexts <@ ARRAY[${WORK}]::text[]) AS retired_work_edges,
          (SELECT count(*)::int FROM entity_edge
            WHERE deleted_at IS NOT NULL
              AND origin_contexts @> ARRAY[${WORK}]::text[]
              AND NOT (origin_contexts <@ ARRAY[${WORK}]::text[])) AS retired_mixed_edges,
          (SELECT count(*)::int FROM entity_alias) AS aliases
      `) as Array<Record<string, number>>;
      expect(rows[0]).toEqual({
        retracted_attachments: 1,
        live_attachments: 1,
        retired_work_edges: 1,
        retired_mixed_edges: 1,
        aliases: 3,
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the preview counts what this severance will take, not what a previous one already did', () => {
  test(
    'an attachment a forget already holds is not counted again',
    async () => {
      const preview = await previewSeverance(sql, { origin: WORK });
      // One live work attachment. The other is retracted, already inside another
      // call's undo, and outside this severance's reach.
      expect(preview.removed.attachments).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an edge a consolidation cycle retired is in neither column',
    async () => {
      const preview = await previewSeverance(sql, { origin: WORK });
      // `entity_edge.deleted_at` is a reconciliation retraction rather than a
      // user's, so a retired edge is not a row severance removes AND not a row
      // anything has to re-derive. It belongs in neither column. The fixture
      // carries a live and a retired edge on BOTH sides of the origin split, so
      // an unfiltered count reports two in each column and the filtered one
      // reports the live row alone.
      expect(preview.removed.edges).toBe(1);
      expect(preview.recomputed.edges).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the alias take appears in the preview at all',
    async () => {
      const preview = await previewSeverance(sql, { origin: WORK });
      // The work-only spelling on the mixed entity, and the unstamped legacy one
      // whose entity is exactly severed. The spelling carrying both origins is
      // not severance's first class and stays.
      expect(preview.removed.aliases).toBe(2);
      // Zero, and deliberately: a spelling asserts nothing, so it cannot be left
      // wrong by losing an input, and no cycle re-derives one.
      expect(preview.recomputed.aliases).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'it still changes nothing — a preview that mutates is not a preview',
    async () => {
      const before = await census();
      await previewSeverance(sql, { origin: WORK });
      expect(await census()).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('preview, receipt and audit row describe the same severance', () => {
  test(
    'the three agree on every take, including the one with no tombstone — run last, because it mutates',
    async () => {
      const preview = await previewSeverance(sql, { origin: WORK });
      const outcome = await severOrigin(sql, { origin: WORK, confirm: WORK, now: SEVERED_AT });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const receipt = outcome.receipt;

      // The take with no `deleted_at` behind it: what the preview advertised,
      // what the executor moved, and what the archive holds.
      expect(receipt.archived.aliases).toBe(preview.removed.aliases);
      expect(receipt.archived.aliases).toBe(2);
      const archived = (await sql`
        SELECT count(*)::int AS n FROM severed_alias WHERE severed_at = ${SEVERED_AT.toISOString()}::timestamptz
      `) as Array<{ n: number }>;
      expect(archived[0]?.n).toBe(receipt.archived.aliases);

      // The over-count: the executor takes the live attachment and leaves the
      // one another retraction owns, which is what the preview now says.
      expect(receipt.tombstoned.attachments).toBe(preview.removed.attachments);
      expect(receipt.tombstoned.attachments).toBe(1);
      const stillTheirs = (await sql`
        SELECT count(*)::int AS n FROM attachment
         WHERE deleted_at = ${EARLIER_RETRACTION}::timestamptz
      `) as Array<{ n: number }>;
      // Untouched, so the earlier call's undo still reaches it.
      expect(stillTheirs[0]?.n).toBe(1);

      // The audit row is written FROM the preview, so it carries the alias take
      // too — read as a jsonb field rather than as a string, which is where a
      // double-encoded cast would show.
      const audit = (await sql`
        SELECT removed, recomputed FROM severance WHERE severed_at = ${SEVERED_AT.toISOString()}::timestamptz
      `) as Array<{ removed: Record<string, number>; recomputed: Record<string, number> }>;
      expect(audit).toHaveLength(1);
      expect(audit[0]?.removed['aliases']).toBe(receipt.archived.aliases);
      expect(audit[0]?.removed['attachments']).toBe(receipt.tombstoned.attachments);
      expect(audit[0]?.recomputed['aliases']).toBe(0);

      // Not vacuous: the severance really took rows of several kinds.
      expect(receipt.tombstoned.pages).toBe(1);
      expect(receipt.tombstoned.entities).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );
});

async function census(): Promise<Record<string, number>> {
  const rows = (await sql.unsafe(`
    SELECT (SELECT count(*)::int FROM page WHERE deleted_at IS NULL) AS pages,
           (SELECT count(*)::int FROM chunk WHERE deleted_at IS NULL) AS chunks,
           (SELECT count(*)::int FROM attachment WHERE deleted_at IS NULL) AS attachments,
           (SELECT count(*)::int FROM fact WHERE deleted_at IS NULL) AS facts,
           (SELECT count(*)::int FROM entity WHERE deleted_at IS NULL) AS entities,
           (SELECT count(*)::int FROM entity_edge WHERE deleted_at IS NULL) AS edges,
           (SELECT count(*)::int FROM entity_alias) AS aliases,
           (SELECT count(*)::int FROM severed_alias) AS severed_aliases
  `)) as Array<Record<string, number>>;
  return rows[0] ?? {};
}
