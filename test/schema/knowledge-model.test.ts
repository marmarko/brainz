/**
 * The knowledge core's invariants, exercised as writes rather than read off the
 * DDL — U3 approach steps 1 and 2.
 *
 * Three of them are the reason this file exists at all, because each is a place
 * where a schema that *looks* right admits a state the plan forbids:
 *
 * **The origin union is checked against the actual inputs.** R15 says a derived
 * row inherits the union of its inputs' origins. A schema can declare an array
 * column and still let a write store `{personal}` on a fact derived from a
 * work-fenced chunk — at which point the access fence, which evaluates origin
 * only (KTD5), hands a personal-scoped reader a work document's content. The
 * check lives where the inputs are recorded.
 *
 * **A slug redirect and a free-text synonym are two primitives.** The audit's
 * point, and it is structural rather than stylistic: redirects share a primary
 * key with canonical slugs so a redirect cannot shadow a live entity, while
 * aliases are deliberately not unique across entities because two people really
 * are called Mike. One table for both forces a choice between a false constraint
 * and a silent resolution order.
 *
 * **A declared inverse must be an involution.** Edges are stored once and
 * traversed both ways through the type registry, so `a → b` whose inverse chain
 * does not return to `a` is a graph walk that quietly changes meaning on the
 * second hop — with no error and no wrong row anywhere to point at.
 */

import type { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { EMBEDDING_DIMENSIONS } from '../../src/schema/vector-index.ts';
import {
  connect,
  dropFixtureDatabase,
  provisionFixture,
  sqlstateOf,
  sqlstateOfFailure,
  type SchemaFixture,
} from './fixture.ts';
import { ACTIVE_EMBEDDING_SEAT } from '../../src/schema/embedding-seat.ts';

/** The column a seeded vector goes in — the active seat's, so a fixture
 * cannot outlive the column production writes. */
const SEAT_COLUMN = ACTIVE_EMBEDDING_SEAT.column;

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

/** A unit vector, built from the declared dimension so it cannot drift from it. */
const EMBEDDING = `('[1' || repeat(',0', ${EMBEDDING_DIMENSIONS - 1}) || ']')::vector(${EMBEDDING_DIMENSIONS})`;

let fixture: SchemaFixture;
let sql: SQL;

beforeAll(async () => {
  fixture = await provisionFixture('model');
  sql = connect(fixture);
}, { timeout: SETUP_TIMEOUT_MS });

afterAll(async () => {
  await sql?.close();
  if (fixture !== undefined) await dropFixtureDatabase(fixture);
}, { timeout: SETUP_TIMEOUT_MS });

/** Runs a transaction and reports the SQLSTATE it failed with, if it failed. */
async function transactionFailure(statements: readonly string[]): Promise<string | undefined> {
  try {
    await sql.begin(async (tx) => {
      for (const statement of statements) await tx.unsafe(statement);
      return { done: true };
    });
    return undefined;
  } catch (error) {
    const state = sqlstateOf(error);
    if (state === undefined) throw error;
    return state;
  }
}

describe('R15 — a derived row cannot be narrower than the rows it came from', () => {
  let personalChunk = 0;
  let workChunk = 0;

  beforeAll(async () => {
    const rows = await sql<{ chunk_id: string; origin_context: string }[]>`
      INSERT INTO chunk (origin_context, content)
      VALUES ('personal', 'a personal chunk'), ('work', 'a work chunk')
      RETURNING chunk_id, origin_context
    `;
    for (const row of rows) {
      if (row.origin_context === 'personal') personalChunk = Number(row.chunk_id);
      else workChunk = Number(row.chunk_id);
    }
    expect(personalChunk).toBeGreaterThan(0);
    expect(workChunk).toBeGreaterThan(0);
  });

  test(
    'a fact derived from two origins may carry both',
    async () => {
      // The control case, and it has to pass first: a union check that refused
      // the legitimate write would be discovered by the write path, not here.
      const state = await transactionFailure([
        `INSERT INTO fact (statement, ${SEAT_COLUMN}, origin_contexts)
         VALUES ('covers both', ${EMBEDDING}, ARRAY['personal','work'])`,
        `INSERT INTO fact_source (fact_id, chunk_id)
         SELECT currval(pg_get_serial_sequence('fact','fact_id')), unnest(ARRAY[${personalChunk}, ${workChunk}])`,
      ]);

      expect(state).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a fact that omits one of its sources’ origins is refused at commit',
    async () => {
      // The whole hazard in one write: the fact claims to be personal-only, one
      // of its sources is work-fenced, and every read that trusts the fact's
      // origin now leaks the work document's content into a personal scope.
      const state = await transactionFailure([
        `INSERT INTO fact (statement, ${SEAT_COLUMN}, origin_contexts)
         VALUES ('claims to be personal only', ${EMBEDDING}, ARRAY['personal'])`,
        `INSERT INTO fact_source (fact_id, chunk_id)
         SELECT currval(pg_get_serial_sequence('fact','fact_id')), unnest(ARRAY[${personalChunk}, ${workChunk}])`,
      ]);

      expect(state).toBe('BZ002');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an empty origin set is not a way around the check',
    async () => {
      // A derived row with no origins passes any "is every source covered"
      // reading of the rule vacuously if the column is allowed to be empty, and
      // is unfenceable besides — there is nothing for the fence to evaluate.
      const state = await sqlstateOfFailure(
        sql,
        `INSERT INTO fact (statement, ${SEAT_COLUMN}, origin_contexts)
         VALUES ('no origins', ${EMBEDDING}, ARRAY[]::text[])`,
      );
      expect(state).toBe('23514'); // check_violation
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the page a fact was extracted from is an input too',
    async () => {
      // `fact_source` is one derivation edge. `fact.page_id` is the other, on the
      // same table — and for a while it was the one nothing checked, which is the
      // shape of gap that survives review precisely because the neighbouring
      // check is prominent.
      const rows = await sql<{ page_id: string }[]>`
        INSERT INTO page (origin_context, source_type, title, embedding_model,
                          embedding_dimensions, chunker_version, normalizer_version, content_sha256)
        VALUES ('work', 'document', 'a work document', 'text-embedding-3-small',
                ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('c', 64))
        RETURNING page_id
      `;
      const workPage = Number(rows[0]?.page_id ?? 0);
      expect(workPage).toBeGreaterThan(0);

      expect(
        await transactionFailure([
          `INSERT INTO fact (statement, ${SEAT_COLUMN}, origin_contexts, page_id)
           VALUES ('extracted from a work page, claims personal', ${EMBEDDING}, ARRAY['personal'], ${workPage})`,
        ]),
      ).toBe('BZ002');

      // And the honest write is accepted, which is what makes this a fence
      // rather than a ban on deriving from pages.
      expect(
        await transactionFailure([
          `INSERT INTO fact (statement, ${SEAT_COLUMN}, origin_contexts, page_id)
           VALUES ('extracted from a work page, says so', ${EMBEDDING}, ARRAY['work'], ${workPage})`,
        ]),
      ).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an edge cannot be narrower than the two entities it connects',
    async () => {
      const rows = await sql<{ entity_id: string }[]>`
        INSERT INTO entity (canonical_name, entity_type, origin_contexts)
        VALUES ('union-personal-entity', 'person', ARRAY['personal']),
               ('union-work-entity', 'organization', ARRAY['work'])
        RETURNING entity_id
      `;
      const [personal, work] = rows.map((row) => Number(row.entity_id));
      expect(personal).toBeGreaterThan(0);
      expect(work).toBeGreaterThan(0);

      // A personal-fenced graph walk that follows this edge arrives at a
      // work-fenced entity, and the fence it consulted said that was fine.
      expect(
        await transactionFailure([
          `INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
           VALUES (${personal}, 'related_to', ${work}, ARRAY['personal'])`,
        ]),
      ).toBe('BZ002');

      expect(
        await transactionFailure([
          `INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
           VALUES (${personal}, 'related_to', ${work}, ARRAY['personal','work'])`,
        ]),
      ).toBeUndefined();

      // Removed again: the edge-registry test further down counts every stored
      // edge to prove a relationship is stored once, and a fixture left lying
      // around by this test would make that assertion mean something else.
      await sql.unsafe(
        `DELETE FROM entity_edge WHERE subject_entity_id = ${personal} AND object_entity_id = ${work}`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a contradiction report cannot be narrower than the two facts it quotes',
    async () => {
      const rows = (await sql.unsafe(
        `INSERT INTO fact (statement, ${SEAT_COLUMN}, origin_contexts)
         VALUES ('a personal claim', ${EMBEDDING}, ARRAY['personal']),
                ('a work claim that contradicts it', ${EMBEDDING}, ARRAY['work'])
         RETURNING fact_id`,
      )) as Array<{ fact_id: string }>;
      const [personalFact, workFact] = rows.map((row) => Number(row.fact_id));
      expect(personalFact).toBeGreaterThan(0);
      expect(workFact).toBeGreaterThan(0);

      // The report carries both facts' statements in what it reports on, so a
      // narrow report is a work fact's content delivered to a personal reader.
      expect(
        await transactionFailure([
          `INSERT INTO contradiction_report (left_fact_id, right_fact_id, kind, origin_contexts)
           VALUES (${personalFact}, ${workFact}, 'value_conflict', ARRAY['personal'])`,
        ]),
      ).toBe('BZ002');

      expect(
        await transactionFailure([
          `INSERT INTO contradiction_report (left_fact_id, right_fact_id, kind, origin_contexts)
           VALUES (${personalFact}, ${workFact}, 'value_conflict', ARRAY['personal','work'])`,
        ]),
      ).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'every derived table with recorded inputs has its union checked — enumerated',
    async () => {
      // The list this file used to encode by testing one of four. A derived
      // table whose inputs are recorded in-row and unchecked is a fence that
      // evaluates a claim rather than a fact, so the roster is asserted rather
      // than trusted to be complete.
      const rows = await sql<{ table_name: string; trigger_name: string }[]>`
        SELECT c.relname AS table_name, t.tgname AS trigger_name
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_proc p ON p.oid = t.tgfoid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND NOT t.tgisinternal
          AND t.tgenabled <> 'D'
          AND p.proname IN ('assert_origin_union', 'assert_fact_page_origin',
                            'assert_edge_origin_union', 'assert_report_origin_union')
        ORDER BY c.relname
      `;

      expect(rows.map((row) => row.table_name)).toEqual([
        'contradiction_report',
        'entity_edge',
        'fact',
        'fact_source',
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the two entity naming primitives are two primitives', () => {
  let alice = 0;
  let alicePrime = 0;

  beforeAll(async () => {
    const rows = await sql<{ entity_id: string }[]>`
      INSERT INTO entity (canonical_name, entity_type, origin_contexts)
      VALUES ('a-founder', 'person', ARRAY['personal']),
             ('a-founder (duplicate record)', 'person', ARRAY['personal'])
      RETURNING entity_id
    `;
    alice = Number(rows[0]?.entity_id ?? 0);
    alicePrime = Number(rows[1]?.entity_id ?? 0);

    await sql.unsafe(`
      INSERT INTO entity_slug (slug, entity_id, kind) VALUES
        ('a-founder', ${alice}, 'canonical'),
        ('a-founder-2', ${alicePrime}, 'canonical')
    `);
  });

  test(
    'a redirect resolves to the entity, through the same lookup as a canonical slug',
    async () => {
      // The merge case: the duplicate's slug is kept as a redirect so old links
      // keep working, and one query answers both kinds.
      await sql.unsafe(
        `UPDATE entity_slug SET entity_id = ${alice}, kind = 'redirect' WHERE slug = 'a-founder-2'`,
      );

      const rows = await sql<{ slug: string; entity_id: string; kind: string }[]>`
        SELECT slug, entity_id, kind FROM entity_slug
        WHERE slug IN ('a-founder', 'a-founder-2') ORDER BY slug
      `;

      expect(rows.map((row) => Number(row.entity_id))).toEqual([alice, alice]);
      expect(rows.map((row) => row.kind)).toEqual(['canonical', 'redirect']);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a redirect cannot shadow a live canonical slug',
    async () => {
      const state = await sqlstateOfFailure(
        sql,
        `INSERT INTO entity_slug (slug, entity_id, kind) VALUES ('a-founder', ${alicePrime}, 'redirect')`,
      );
      // One namespace, one primary key. In two tables this would have been a
      // resolution-order question nobody wrote down.
      expect(state).toBe('23505'); // unique_violation
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an entity has exactly one canonical slug',
    async () => {
      const state = await sqlstateOfFailure(
        sql,
        `INSERT INTO entity_slug (slug, entity_id, kind) VALUES ('a-founder-alt', ${alice}, 'canonical')`,
      );
      expect(state).toBe('23505');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an alias is free text: many per entity, and shared between entities',
    async () => {
      await sql.unsafe(`
        INSERT INTO entity_alias (entity_id, alias, alias_source) VALUES
          (${alice}, 'Mike', 'user'),
          (${alice}, 'Michael', 'user'),
          (${alicePrime}, 'Mike', 'user')
      `);

      const rows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM entity_alias WHERE lower(alias) = 'mike'
      `;
      // The assertion the slug table could not make: the same string names two
      // different entities, and both rows are legitimate.
      expect(rows[0]?.n).toBe(2);

      // An alias is not an address. Nothing resolves through it.
      const slugs = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM entity_slug WHERE slug = 'mike'`;
      expect(slugs[0]?.n).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the same alias is not recorded twice for one entity, and an inferred one is scored',
    async () => {
      expect(
        await sqlstateOfFailure(
          sql,
          `INSERT INTO entity_alias (entity_id, alias, alias_source) VALUES (${alice}, 'Mike', 'user')`,
        ),
      ).toBe('23505');

      // R15's confidence discipline, one layer down: an inference the schema
      // cannot score is an assertion wearing an inference's clothes.
      expect(
        await sqlstateOfFailure(
          sql,
          `INSERT INTO entity_alias (entity_id, alias, alias_source) VALUES (${alice}, 'MJ', 'inferred')`,
        ),
      ).toBe('23514');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('typed edges: the inverse is declared, and it is an involution', () => {
  test(
    'every seeded type’s inverse points back at it',
    async () => {
      const rows = await sql<{ edge_type: string; inverse_type: string; back: string | null }[]>`
        SELECT t.edge_type, t.inverse_type, i.inverse_type AS back
        FROM edge_type t
        LEFT JOIN edge_type i ON i.edge_type = t.inverse_type
        WHERE i.inverse_type IS DISTINCT FROM t.edge_type
      `;

      expect(rows).toEqual([]);

      // And the registry is not empty, or the assertion above proves nothing.
      const count = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM edge_type`;
      expect(count[0]?.n).toBeGreaterThanOrEqual(6);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a non-involutive inverse is refused at commit, even though the type exists',
    async () => {
      // The foreign key is satisfied — `related_to` is a declared type — so this
      // is precisely the case a referential constraint cannot catch.
      const state = await transactionFailure([
        `UPDATE edge_type SET inverse_type = 'related_to' WHERE edge_type = 'mentions'`,
      ]);

      expect(state).toBe('BZ003');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an edge naming an undeclared type is refused outright',
    async () => {
      const rows = await sql<{ entity_id: string }[]>`
        INSERT INTO entity (canonical_name, entity_type, origin_contexts)
        VALUES ('acme-example', 'organization', ARRAY['work']),
               ('widget-co', 'organization', ARRAY['work'])
        RETURNING entity_id
      `;
      const [left, right] = rows.map((row) => Number(row.entity_id));

      expect(
        await sqlstateOfFailure(
          sql,
          `INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
           VALUES (${left}, 'acquired', ${right}, ARRAY['work'])`,
        ),
      ).toBe('23503'); // foreign_key_violation

      // One row, traversed both ways through the declared inverse — there is no
      // mirror row for a graph walk to find disagreeing with this one.
      await sql.unsafe(
        `INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
         VALUES (${left}, 'invested_in', ${right}, ARRAY['work'])`,
      );

      const forward = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM entity_edge
        WHERE subject_entity_id = ${left} AND edge_type = 'invested_in'
      `;
      const backward = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM entity_edge e
        JOIN edge_type t ON t.edge_type = e.edge_type
        WHERE e.object_entity_id = ${right} AND t.inverse_type = 'has_investor'
      `;

      expect(forward[0]?.n).toBe(1);
      expect(backward[0]?.n).toBe(1);
      // Exactly one stored row for the relationship, in both readings.
      const stored = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM entity_edge`;
      expect(stored[0]?.n).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('contradiction reports are stated once and resolved on the record', () => {
  let left = 0;
  let right = 0;

  beforeAll(async () => {
    const rows = (await sql.unsafe(
      `INSERT INTO fact (statement, ${SEAT_COLUMN}, origin_contexts)
       VALUES ('the round was 2m', ${EMBEDDING}, ARRAY['work']),
              ('the round was 3m', ${EMBEDDING}, ARRAY['work'])
       RETURNING fact_id`,
    )) as Array<{ fact_id: string }>;
    left = Number(rows[0]?.fact_id ?? 0);
    right = Number(rows[1]?.fact_id ?? 0);
  });

  test(
    'the same conflict is not reported twice, in either order',
    async () => {
      await sql.unsafe(
        `INSERT INTO contradiction_report (left_fact_id, right_fact_id, kind, origin_contexts)
         VALUES (${left}, ${right}, 'value_conflict', ARRAY['work'])`,
      );

      // Swapped, which is the same conflict and the shape a naive unique index
      // on (left, right) would let through — a consolidation cycle that reports
      // the same pair twice a day is noise the user reads as brokenness.
      expect(
        await sqlstateOfFailure(
          sql,
          `INSERT INTO contradiction_report (left_fact_id, right_fact_id, kind, origin_contexts)
           VALUES (${right}, ${left}, 'value_conflict', ARRAY['work'])`,
        ),
      ).toBe('23505');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a report cannot be marked resolved without saying how',
    async () => {
      expect(
        await sqlstateOfFailure(
          sql,
          `UPDATE contradiction_report SET status = 'resolved' WHERE left_fact_id = ${left}`,
        ),
      ).toBe('23514');

      await sql.unsafe(
        `UPDATE contradiction_report SET status = 'resolved', resolution = 'right', resolved_at = now()
         WHERE left_fact_id = ${left}`,
      );
    },
    TEST_TIMEOUT_MS,
  );
});
