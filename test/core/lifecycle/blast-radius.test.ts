/**
 * Blast-radius preview, and the half a preview built by the obvious method
 * leaves out.
 *
 * A destructive op's preview is easy to write and easy to write *wrongly*: count
 * the rows the delete statement would touch and show the number. For a `forget`
 * that is right. For **context severance** it is a preview that tells the user
 * severing their work account costs them their work mail — when it also costs
 * them every entity card, commitment, fact and edge that mixed work with
 * personal, because a derived row carries the union of its inputs' origins (R15)
 * and losing one input does not leave the row standing, it leaves it *wrong*.
 *
 * So the preview has two columns, and the second is the expensive one:
 *
 *   * **removed** — rows whose origins are exactly the severed one.
 *   * **recomputed** — rows whose origins are the severed one *plus others*.
 *     They survive, and every one of them has to be re-derived from what is
 *     left before it can be trusted again.
 *
 * **The trap this file is written against:** *"a severance preview passes
 * trivially if nothing mixed exists."* The fixture below therefore carries a
 * mixed-origin fact, a mixed-origin entity, a mixed-origin entity card, a
 * mixed-origin commitment and a mixed-origin edge, and every test asserts each
 * one lands in `recomputed` and **not** in `removed`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { previewForget, previewSeverance } from '../../../src/core/lifecycle/blast-radius.ts';
import { parseId } from '../../../src/mcp/ids.ts';
import { forgetRecord } from '../../../src/mcp/tombstone.ts';
import { EMBEDDING_DIMENSIONS } from '../../../src/schema/vector-index.ts';
import { connect, dropFixtureDatabase, provisionFixture, type SchemaFixture } from '../../schema/fixture.ts';

import type { SQL } from 'bun';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

const WORK = 'work';
const PERSONAL = 'personal';

let schema: SchemaFixture;
let sql: SQL;
let workPageId = '';

beforeAll(async () => {
  schema = await provisionFixture('u17blast');
  sql = connect(schema);

  const embedding = `('[1' || repeat(',0', ${EMBEDDING_DIMENSIONS - 1}) || ']')::vector(${EMBEDDING_DIMENSIONS})`;

  await sql.unsafe(`
    INSERT INTO page (origin_context, source_type, title, embedding_model, embedding_dimensions,
                      chunker_version, normalizer_version, content_sha256)
    VALUES ('${WORK}', 'email', 'work mail', 'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64)),
           ('${PERSONAL}', 'email', 'personal mail', 'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('b', 64));

    INSERT INTO chunk (origin_context, content, page_id, ordinal)
    SELECT '${WORK}', 'a work passage', page_id, 0 FROM page WHERE title = 'work mail';
    INSERT INTO chunk (origin_context, content, page_id, ordinal)
    SELECT '${PERSONAL}', 'a personal passage', page_id, 0 FROM page WHERE title = 'personal mail';

    -- Pure-work: removed by severance.
    INSERT INTO fact (statement, embedding, origin_contexts, page_id)
    SELECT 'a work-only claim', ${embedding}, ARRAY['${WORK}'], page_id FROM page WHERE title = 'work mail';

    -- MIXED: survives severance and must be re-derived. This row is the entire
    -- point of the file; without it every assertion below is vacuous.
    INSERT INTO fact (statement, embedding, origin_contexts)
    VALUES ('a claim both accounts attested', ${embedding}, ARRAY['${WORK}', '${PERSONAL}']);

    -- Pure-personal: untouched by severing work.
    INSERT INTO fact (statement, embedding, origin_contexts)
    VALUES ('a personal-only claim', ${embedding}, ARRAY['${PERSONAL}']);

    INSERT INTO entity (canonical_name, entity_type, origin_contexts)
    VALUES ('work-only-person', 'person', ARRAY['${WORK}']),
           ('mixed-person', 'person', ARRAY['${WORK}', '${PERSONAL}']),
           ('personal-only-person', 'person', ARRAY['${PERSONAL}']);

    INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
    SELECT (SELECT entity_id FROM entity WHERE canonical_name = 'mixed-person'),
           'related_to',
           (SELECT entity_id FROM entity WHERE canonical_name = 'personal-only-person'),
           ARRAY['${WORK}', '${PERSONAL}'];

    INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts)
    SELECT entity_id, 'a card built from both accounts', 'model_inferred', 'model_derived',
           ARRAY['${WORK}', '${PERSONAL}']
      FROM entity WHERE canonical_name = 'mixed-person';
    INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts)
    SELECT entity_id, 'a card built from work alone', 'model_inferred', 'model_derived', ARRAY['${WORK}']
      FROM entity WHERE canonical_name = 'work-only-person';

    INSERT INTO commitment (fact_id, statement, trust_level, derivation, origin_contexts)
    SELECT fact_id, 'owed, and both accounts saw it', 'model_extracted', 'model_derived',
           ARRAY['${WORK}', '${PERSONAL}']
      FROM fact WHERE statement = 'a claim both accounts attested';
    INSERT INTO commitment (statement, trust_level, derivation, origin_contexts)
    VALUES ('owed, work only', 'model_extracted', 'model_derived', ARRAY['${WORK}']);
  `);

  const rows = (await sql`SELECT page_id::text AS page_id FROM page WHERE title = 'work mail'`) as Array<{
    page_id: string;
  }>;
  workPageId = rows[0]?.page_id ?? '';
}, { timeout: SETUP_TIMEOUT_MS });

afterAll(async () => {
  await sql?.close();
  if (schema !== undefined) await dropFixtureDatabase(schema);
});

describe('the fixture actually contains the mixed rows the preview is about', () => {
  test(
    'if this fails, every assertion below is vacuous',
    async () => {
      const mixed = (await sql.unsafe(`
        SELECT
          (SELECT count(*)::int FROM fact WHERE origin_contexts @> ARRAY['${WORK}'] AND cardinality(origin_contexts) > 1) AS facts,
          (SELECT count(*)::int FROM entity WHERE origin_contexts @> ARRAY['${WORK}'] AND cardinality(origin_contexts) > 1) AS entities,
          (SELECT count(*)::int FROM entity_card WHERE origin_contexts @> ARRAY['${WORK}'] AND cardinality(origin_contexts) > 1) AS cards,
          (SELECT count(*)::int FROM commitment WHERE origin_contexts @> ARRAY['${WORK}'] AND cardinality(origin_contexts) > 1) AS commitments,
          (SELECT count(*)::int FROM entity_edge WHERE origin_contexts @> ARRAY['${WORK}'] AND cardinality(origin_contexts) > 1) AS edges
      `)) as Array<Record<string, number>>;
      expect(mixed[0]).toEqual({ facts: 1, entities: 1, cards: 1, commitments: 1, edges: 1 });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('severance preview', () => {
  test(
    'it reports what will be REMOVED',
    async () => {
      const preview = await previewSeverance(sql, { origin: WORK });
      expect(preview.removed.pages).toBe(1);
      expect(preview.removed.chunks).toBe(1);
      expect(preview.removed.facts).toBe(1);
      expect(preview.removed.entities).toBe(1);
      expect(preview.removed.entityCards).toBe(1);
      expect(preview.removed.commitments).toBe(1);
      expect(preview.removed.edges).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and it reports what will be RECOMPUTED, which is the half a row count misses',
    async () => {
      const preview = await previewSeverance(sql, { origin: WORK });
      expect(preview.recomputed.facts).toBe(1);
      expect(preview.recomputed.entities).toBe(1);
      expect(preview.recomputed.entityCards).toBe(1);
      expect(preview.recomputed.commitments).toBe(1);
      expect(preview.recomputed.edges).toBe(1);
      expect(preview.recomputeRequired).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a mixed row is in exactly one column — recomputed, never removed',
    async () => {
      const preview = await previewSeverance(sql, { origin: WORK });
      // Two work-touching facts exist: one pure, one mixed. If the mixed one
      // were counted as removed the totals would still add up, so the columns
      // are asserted against each other rather than against a total.
      expect(preview.removed.facts + preview.recomputed.facts).toBe(2);
      expect(preview.removed.facts).toBe(1);
      expect(preview.recomputed.facts).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'severing an origin nothing uses removes nothing and recomputes nothing',
    async () => {
      const preview = await previewSeverance(sql, { origin: 'an-origin-that-never-existed' });
      expect(preview.removed.pages).toBe(0);
      expect(preview.recomputed.facts).toBe(0);
      expect(preview.recomputeRequired).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the preview names the surviving origins the recompute will run against',
    async () => {
      const preview = await previewSeverance(sql, { origin: WORK });
      expect(preview.survivingOrigins).toEqual([PERSONAL]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'it changes nothing — a preview that mutates is not a preview',
    async () => {
      const before = await census();
      await previewSeverance(sql, { origin: WORK });
      expect(await census()).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('forget preview', () => {
  test(
    'retracting a document names the passages and facts that go with it',
    async () => {
      const preview = await previewForget(sql, {
        id: parseId(`doc:${workPageId}`)!,
        grant: [WORK],
      });
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      expect(preview.cascade.pages).toBe(1);
      expect(preview.cascade.chunks).toBe(1);
      expect(preview.cascade.facts).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a grant that cannot read the document cannot preview its blast radius either',
    async () => {
      const preview = await previewForget(sql, {
        id: parseId(`doc:${workPageId}`)!,
        grant: [PERSONAL],
      });
      expect(preview.ok).toBe(false);
      if (!preview.ok) expect(preview.reason).toBe('scope_denied');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'it changes nothing either',
    async () => {
      const before = await census();
      await previewForget(sql, { id: parseId(`doc:${workPageId}`)!, grant: [WORK] });
      expect(await census()).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the preview matches what the retraction actually does — run last, because it mutates',
    async () => {
      // The preview is a *mirror* of `forgetRecord`, not a shared helper: the
      // two run at different times against different states, and a preview that
      // shared the retraction's statements would be one edit from being it. A
      // mirror is only worth anything while somebody compares the two, so this
      // is that comparison — same fixture, both code paths, same numbers.
      const id = parseId(`doc:${workPageId}`)!;
      const preview = await previewForget(sql, { id, grant: [WORK] });
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;

      const receipt = await forgetRecord(sql, { id, grant: [WORK], now: new Date() });
      expect(receipt.ok).toBe(true);
      if (!receipt.ok) return;

      expect(receipt.cascade.pages).toBe(preview.cascade.pages);
      expect(receipt.cascade.chunks).toBe(preview.cascade.chunks);
      expect(receipt.cascade.facts).toBe(preview.cascade.facts);
      // Not vacuous: the cascade really reached three kinds of row.
      expect(receipt.cascade.pages + receipt.cascade.chunks + receipt.cascade.facts).toBe(3);
    },
    TEST_TIMEOUT_MS,
  );
});

async function census(): Promise<Record<string, number>> {
  const rows = (await sql.unsafe(`
    SELECT (SELECT count(*)::int FROM page WHERE deleted_at IS NULL) AS pages,
           (SELECT count(*)::int FROM chunk WHERE deleted_at IS NULL) AS chunks,
           (SELECT count(*)::int FROM fact WHERE deleted_at IS NULL) AS facts,
           (SELECT count(*)::int FROM entity WHERE deleted_at IS NULL) AS entities,
           (SELECT count(*)::int FROM entity_card WHERE deleted_at IS NULL) AS cards,
           (SELECT count(*)::int FROM commitment WHERE deleted_at IS NULL) AS commitments,
           (SELECT count(*)::int FROM entity_edge) AS edges
  `)) as Array<Record<string, number>>;
  return rows[0] ?? {};
}
