/**
 * H6 — the fence that was a function of its caller.
 *
 * `docs/porting-hazards.md`'s H6 card says the mechanism plainly: a trigger
 * function that resolves its own references through the calling session's
 * `search_path` is a check whose enforcement belongs to whoever is calling it.
 * brainz's tenant schema declared eight of them and pinned none, and seven of
 * the eight *are* R15's origin fence.
 *
 * **This file leads with the exploit, not with the catalog.** A structural test
 * ("every function declares `SET search_path`") is the guard, and it is written
 * below — but a structural test that passes while the bypass still works is the
 * exact failure the card describes. So the first `describe` shadows the fence's
 * own tables and asserts the database still refuses, three ways:
 *
 *   1. **A shadow schema in front of `public`.** Three statements and
 *      `assert_fact_page_origin` inspects an empty table, finds no uncovered
 *      origin, and admits a fact claiming `{personal}` off a `work` page.
 *   2. **A temp table, with no schema privilege at all.** This is the cheaper
 *      attack and the one a careless pin leaves open: when `pg_temp` is not
 *      *listed* in a `search_path`, Postgres searches it **first** for relation
 *      names — ahead of `pg_catalog`. A pin of `pg_catalog, public` therefore
 *      fixes case 1 and leaves case 2 wide open.
 *   3. **`pg_catalog` demoted.** `refuse_origin_change` names no table, only
 *      `to_jsonb` and `->`, which looks immune because `pg_catalog` is searched
 *      first when it is not listed. Listing it later is what defeats it, so
 *      "names no table" is not the same as "cannot be shadowed".
 *
 * Each of these was measured against the head schema before rung 8 and each one
 * admitted the write. They are the red this unit was written from.
 */

import type { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { HEAD_SCHEMA_VERSION, readLadderDdl } from '../../src/schema/migrations.ts';
import {
  ORIGIN_FENCE_BROKEN_SQLSTATE,
  ORIGIN_IMMUTABLE_SQLSTATE,
} from '../../src/schema/origin-fence.ts';
import {
  PINNED_SEARCH_PATH,
  SEARCH_PATH_PINNED_SINCE,
  SUPERSEDED_UNPINNED_FUNCTIONS,
  SearchPathUnpinnedError,
  assertSearchPathPinned,
  findLadderPinViolations,
  findUnpinnedFunctionDeclarations,
  findUnpinnedFenceCoverage,
} from '../../src/schema/search-path.ts';
import {
  connect,
  dropFixtureDatabase,
  provisionFixture,
  sqlstateOfFailure,
  type SchemaFixture,
} from './fixture.ts';

const ORIGIN_UNION_SQLSTATE = 'BZ002';

/** A 1536-wide zero vector, written once — `fact.embedding` is NOT NULL. */
const ZERO_VECTOR = `'[${new Array(1536).fill(0).join(',')}]'::vector`;
const DIGEST = 'a'.repeat(64);

let fixture: SchemaFixture;
let sql: SQL;

beforeAll(async () => {
  fixture = await provisionFixture('searchpath');
  sql = connect(fixture);
});

afterAll(async () => {
  await sql?.close();
  if (fixture) await dropFixtureDatabase(fixture);
});

/** A `work`-origin page, so a `{personal}` fact off it is a fence violation. */
async function seedWorkPage(): Promise<number> {
  const rows = (await sql.unsafe(`
    INSERT INTO page (origin_context, source_type, embedding_model, embedding_dimensions,
                      chunker_version, normalizer_version, content_sha256)
    VALUES ('work', 'email', 'probe', 1536, 1, 1, '${DIGEST}')
    RETURNING page_id`)) as { page_id: number | string }[];
  return Number(rows[0]?.page_id);
}

/** The write R15 exists to refuse: a derived row narrowing its input's origin. */
function forgedFactStatement(pageId: number, marker: string): string {
  return `INSERT INTO fact (page_id, statement, embedding, origin_contexts)
          VALUES (${pageId}, '${marker}', ${ZERO_VECTOR}, ARRAY['personal'])`;
}

/**
 * Run `body` with `search_path` set, and put it back afterwards even on a throw.
 *
 * `RESET` rather than a saved value: the fixture opens `max: 1`, so this is one
 * real session and a leaked `search_path` would silently change every test after
 * it — which would make a *later* assertion pass or fail for a reason written
 * here. That is the same class of quiet coupling the fence bug itself is.
 */
async function withSearchPath<T>(path: string, body: () => Promise<T>): Promise<T> {
  await sql.unsafe(`SET search_path = ${path}`);
  try {
    return await body();
  } finally {
    await sql.unsafe('RESET search_path');
  }
}

describe('R15’s fence holds against a hostile search_path', () => {
  test('a shadow schema in front of public does not defeat the fact/page union check', async () => {
    const pageId = await seedWorkPage();

    // The baseline, so a green result below cannot come from the fence being
    // absent, the page being wrong, or the insert failing for another reason.
    expect(await sqlstateOfFailure(sql, forgedFactStatement(pageId, 'baseline'))).toBe(
      ORIGIN_UNION_SQLSTATE,
    );

    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS shadow_a');
    await sql.unsafe('CREATE TABLE IF NOT EXISTS shadow_a.page (page_id bigint, origin_context text)');

    const state = await withSearchPath('shadow_a, public', () =>
      sqlstateOfFailure(sql, forgedFactStatement(pageId, 'shadowed')),
    );

    expect(state).toBe(ORIGIN_UNION_SQLSTATE);

    // And the row really is not there. A SQLSTATE assertion alone would pass if
    // the fence raised on the way out of a write it had already made.
    const rows = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM fact WHERE statement = 'shadowed'`,
    )) as { n: number }[];
    expect(rows[0]?.n).toBe(0);
  });

  test('a temp table named page does not defeat it either', async () => {
    const pageId = await seedWorkPage();

    // No CREATE privilege on any schema is needed for this one, which is why a
    // pin that omits pg_temp is a weaker fix than it looks: an unlisted pg_temp
    // is searched ahead of pg_catalog for relation names.
    await sql.unsafe('CREATE TEMP TABLE page (page_id bigint, origin_context text)');
    try {
      expect(await sqlstateOfFailure(sql, forgedFactStatement(pageId, 'temped'))).toBe(
        ORIGIN_UNION_SQLSTATE,
      );
    } finally {
      await sql.unsafe('DROP TABLE IF EXISTS pg_temp.page');
    }
  });

  test('a shadow to_jsonb in public does not defeat origin immutability', async () => {
    await seedWorkPage();

    const mutate = `UPDATE page SET origin_context = 'personal' WHERE origin_context = 'work'`;
    expect(await sqlstateOfFailure(sql, mutate)).toBe(ORIGIN_IMMUTABLE_SQLSTATE);

    // **`public` is the only shadow a pinned function can still see, and the
    // tenant role owns it.** A shadow *schema* is unreachable once the path is
    // pinned — that was this test's first draft, and mutating the pin to demote
    // `pg_catalog` did not kill it, because the shadow sat in a schema the pin
    // excluded entirely. The reachable adversary is a same-named function in
    // `public`, which the fence's own tables oblige the pin to include. What
    // neutralises it is `pg_catalog` being listed FIRST.
    //
    // Returns a constant, so `to_jsonb(NEW)` and `to_jsonb(OLD)` compare equal
    // and the guard sees no change to refuse.
    await sql.unsafe(`
      CREATE OR REPLACE FUNCTION public.to_jsonb(anyelement) RETURNS jsonb
      LANGUAGE sql IMMUTABLE AS $shadow$ SELECT '{}'::jsonb $shadow$`);
    try {
      // The session default (`"$user", public`) is enough: the unpinned legacy
      // arm resolves the shadow and is fooled. The pinned arm is what refuses.
      expect(await sqlstateOfFailure(sql, mutate)).toBe(ORIGIN_IMMUTABLE_SQLSTATE);

      // And with the caller trying to help the shadow along.
      expect(
        await withSearchPath('public, pg_catalog', () => sqlstateOfFailure(sql, mutate)),
      ).toBe(ORIGIN_IMMUTABLE_SQLSTATE);
    } finally {
      await sql.unsafe('DROP FUNCTION IF EXISTS public.to_jsonb(anyelement)');
    }

    const rows = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM page WHERE origin_context = 'personal'`,
    )) as { n: number }[];
    expect(rows[0]?.n).toBe(0);
  });

  test('a shadow entity table does not defeat the edge union check', async () => {
    const entities = (await sql.unsafe(`
      INSERT INTO entity (canonical_name, entity_type, origin_contexts)
      VALUES ('probe-work', 'person', ARRAY['work']),
             ('probe-personal', 'person', ARRAY['personal'])
      RETURNING entity_id`)) as { entity_id: number | string }[];
    const [subject, object] = entities.map((row) => Number(row.entity_id));

    const forgedEdge = `INSERT INTO entity_edge (subject_entity_id, object_entity_id, edge_type, origin_contexts)
                        VALUES (${subject}, ${object}, 'mentions', ARRAY['personal'])`;

    expect(await sqlstateOfFailure(sql, forgedEdge)).toBe(ORIGIN_UNION_SQLSTATE);

    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS shadow_c');
    await sql.unsafe(
      'CREATE TABLE IF NOT EXISTS shadow_c.entity (entity_id bigint, origin_contexts text[])',
    );

    const state = await withSearchPath('shadow_c, public', () =>
      sqlstateOfFailure(sql, forgedEdge),
    );
    expect(state).toBe(ORIGIN_UNION_SQLSTATE);
  });
});

describe('the pin, as the catalog reports it', () => {
  test('every trigger function outside the superseded set pins search_path', async () => {
    expect(await findUnpinnedFenceCoverage(sql)).toEqual([]);
  });

  test('assertSearchPathPinned passes on a head tenant', async () => {
    await assertSearchPathPinned(sql);
  });

  test('a disabled twin trigger is a finding', async () => {
    // The half a static scan cannot see: a pinned function nothing calls. The
    // catalog still renders the trigger definition perfectly.
    await sql.unsafe('ALTER TABLE page DISABLE TRIGGER page_origin_is_immutable_pinned');
    try {
      const findings = await findUnpinnedFenceCoverage(sql);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.join(' ')).toContain('page.origin_context');
      await expect(assertSearchPathPinned(sql)).rejects.toBeInstanceOf(SearchPathUnpinnedError);
    } finally {
      await sql.unsafe('ALTER TABLE page ENABLE TRIGGER page_origin_is_immutable_pinned');
    }
    expect(await findUnpinnedFenceCoverage(sql)).toEqual([]);
  });

  test('the pinned search_path names pg_catalog first and pg_temp last', () => {
    // Both ends are load-bearing and both are easy to get wrong, so the string
    // is asserted rather than trusted to review. See the exploits above.
    expect(PINNED_SEARCH_PATH).toBe('pg_catalog, public, pg_temp');
  });
});

describe('the pin, as the ladder declares it', () => {
  test('no rung declares an unpinned function outside the superseded set', async () => {
    expect(await findLadderPinViolations()).toEqual([]);
  });

  test('the scanner can still go red', () => {
    const findings = findUnpinnedFunctionDeclarations(
      `CREATE FUNCTION brand_new_check() RETURNS trigger
       LANGUAGE plpgsql AS $x$ BEGIN RETURN NULL; END $x$;`,
    );
    expect(findings.length).toBe(1);
    expect(findings[0]).toContain('brand_new_check');
  });

  test('a pinned declaration is accepted', () => {
    expect(
      findUnpinnedFunctionDeclarations(
        `CREATE FUNCTION brand_new_check() RETURNS trigger
         LANGUAGE plpgsql SET search_path = ${PINNED_SEARCH_PATH}
         AS $x$ BEGIN RETURN NULL; END $x$;`,
      ),
    ).toEqual([]);
  });

  test('a superseded name cannot be parked without its pinned successor', async () => {
    // The escape hatch is closed by construction: listing a function as
    // superseded obliges the ladder to declare the pinned twin that supersedes
    // it, so the set cannot be used to wave a new function through.
    const ladder = (await readLadderDdl()).map((rung) => rung.ddl).join('\n');
    for (const name of SUPERSEDED_UNPINNED_FUNCTIONS) {
      expect(ladder).toContain(`CREATE FUNCTION ${name}_pinned(`);
    }
    expect(SUPERSEDED_UNPINNED_FUNCTIONS.length).toBe(8);
  });

  test('the rung that pins is at or below head', () => {
    expect(SEARCH_PATH_PINNED_SINCE).toBeLessThanOrEqual(HEAD_SCHEMA_VERSION);
  });
});

describe('the fence itself still refuses what it always refused', () => {
  test('the shared probe still raises rather than reporting a broken fence', async () => {
    // Rung 8 adds twins beside the originals; if it had replaced them, the
    // origin-fence attestation would be asserting over a function nothing calls.
    // `BZ004` is what a neutered shared function looks like, so its absence is
    // the assertion.
    const state = await sqlstateOfFailure(
      sql,
      `UPDATE chunk SET origin_context = 'work' WHERE origin_context = 'personal'`,
    );
    expect(state).not.toBe(ORIGIN_FENCE_BROKEN_SQLSTATE);
  });
});
