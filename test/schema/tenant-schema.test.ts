/**
 * The tenant schema, as the database reports it — U3's approach steps 1 and 2.
 *
 * Two properties carry this file, and neither is "the DDL parsed".
 *
 * **R15, enumerated rather than spot-checked.** Every row carries an immutable,
 * credential-derived origin and a separate mutable, confidence-scored subject.
 * A per-table assertion would guard the tables that exist on the day it is
 * written; the guard below instead enumerates every table in the tenant
 * database, reads the class each one declares in its own `COMMENT ON TABLE`,
 * and fails closed on a table that declares nothing. A future table cannot skip
 * the origin fence by being new — it can only skip it by writing down a false
 * class, which is a reviewable act rather than an omission.
 *
 * **Immutability is the database's, not the write path's.** R15 calls origin
 * "immutable"; a convention that says so is a convention one careless UPDATE
 * defeats, and access fencing evaluates origin only (KTD5), so a mutable origin
 * is a privilege-escalation primitive rather than a data-quality nit. So the
 * guard issues the UPDATE and asserts the database refuses it — and, in the same
 * breath, asserts that an UPDATE of `subject_context` succeeds, because a
 * trigger that refused every UPDATE would pass the first assertion while
 * breaking inference.
 */

import type { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { HEAD_SCHEMA_VERSION } from '../../src/schema/migrations.ts';
import {
  ORIGIN_IMMUTABLE_SQLSTATE,
  OriginFenceError,
  assertOriginFence,
  findOriginFenceViolations,
} from '../../src/schema/origin-fence.ts';
import {
  CHUNK_EMBEDDING_COLUMN,
  CHUNK_TABLE,
  EMBEDDING_DIMENSIONS,
  INDEXED_VECTOR_COLUMNS,
  RESERVED_VECTOR_COLUMNS,
  assertHnswIndex,
  findIndexesOnColumn,
  findVectorRegistryViolations,
  listVectorColumns,
} from '../../src/schema/vector-index.ts';
import {
  generatedExpression,
  listColumns,
  listIndexes,
  listTables,
  listTriggers,
  type ColumnRecord,
} from './catalog.ts';
import {
  FIXTURE_FTS_LANGUAGE,
  connect,
  dropFixtureDatabase,
  provisionFixture,
  sqlstateOfFailure,
  type SchemaFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

/**
 * The class every table declares in its own comment, and the whole legal set.
 *
 * `content:ingested` — arrived through exactly one credential, so its origin is
 * a scalar. `content:derived` — computed from other rows, so its origin is the
 * UNION of its inputs' origins and therefore an array (R15).
 * `operational` — a log or an artifact record: it may carry an origin, it
 * carries no inference. `registry` — schema's own bookkeeping, no user rows.
 */
const TABLE_CLASSES = ['content:ingested', 'content:derived', 'operational', 'registry'] as const;
type TableClass = (typeof TABLE_CLASSES)[number];

/**
 * The tables U3 ships, and what each one is. Compared as a set in both
 * directions: a table that disappears fails, and so does a table that appears
 * without being written down here. The second half is the one that matters —
 * it is what makes the R15 enumeration below unable to go quiet.
 */
const EXPECTED_TABLES: ReadonlyMap<string, TableClass> = new Map([
  ['schema_migration', 'registry'],
  ['tenant_setting', 'registry'],
  ['edge_type', 'registry'],

  ['page', 'content:ingested'],
  ['chunk', 'content:ingested'],
  ['attachment', 'content:ingested'],

  ['fact', 'content:derived'],
  ['fact_source', 'operational'],
  ['entity', 'content:derived'],
  ['entity_slug', 'operational'],
  ['entity_alias', 'operational'],
  ['entity_edge', 'content:derived'],
  ['contradiction_report', 'content:derived'],

  ['ingest_log', 'operational'],

  // U11's rung. The two artifact tables carry an origin union because they quote
  // what they were derived from; the run record, the checkpoint and the two
  // cluster tables carry none, for the reason `fact_source` carries none — they
  // assert nothing beyond the join, and every read of them goes through a row
  // that is fenced.
  ['consolidation_run', 'operational'],
  ['consolidation_checkpoint', 'operational'],
  ['entity_card', 'content:derived'],
  ['commitment', 'content:derived'],
  ['review_queue', 'content:derived'],
  ['content_cluster', 'operational'],
  ['cluster_member', 'operational'],

  // U12's rung. One table, no origin column and no origin trigger: it holds a
  // grant-derived caller key, two timestamps and a band number, and it asserts
  // nothing about anybody's content. A fence over a bookmark would be a second
  // copy of a fence that already holds on every row the bookmark points at.
  ['briefing_cursor', 'operational'],

  // U14's rung. One table, no origin column and no origin trigger: it names a
  // connector source, a moment, and which surface authorised the pause. It
  // asserts nothing about anybody's content, and the thing it does assert — the
  // authorising channel — is the R12a distinction `review_queue.closed_by`
  // makes one table over, kept rather than flattened into "the user".
  ['source_pause', 'operational'],

  // U17's rung. `page_version` holds the user's own document text — one
  // credential, one scalar origin — so it is fenced exactly as `page` is; a
  // snapshot table outside the fence would be a second, unfenced copy of every
  // document in the brain. The other three carry no origin and no content: an
  // export record, a per-caller reminder bound, and an erasure tombstone that
  // stores a digest rather than the correspondent's identifier.
  ['page_version', 'content:ingested'],
  ['self_export', 'operational'],
  ['self_export_nag', 'operational'],
  ['erased_subject', 'operational'],

  // U18's rung. One append-only row per context severance: an origin, an
  // instant, and the two count objects the preview computed inside the
  // executing transaction. No content, no inference — the recompute worklist is
  // derived from this row and each row's own origins rather than stored as a
  // per-row flag that could go stale.
  ['severance', 'operational'],
]);

const SHARED_ORIGIN_TRIGGER_FUNCTION = 'refuse_origin_change';

let fixture: SchemaFixture;
let sql: SQL;

beforeAll(async () => {
  fixture = await provisionFixture('head');
  sql = connect(fixture);
}, { timeout: SETUP_TIMEOUT_MS });

afterAll(async () => {
  await sql?.close();
  if (fixture !== undefined) await dropFixtureDatabase(fixture);
}, { timeout: SETUP_TIMEOUT_MS });

function columnsOf(columns: readonly ColumnRecord[], table: string): Map<string, ColumnRecord> {
  return new Map(columns.filter((c) => c.table === table).map((c) => [c.column, c]));
}

describe('the tenant schema is applied whole, and says which version it is', () => {
  test(
    'provisioning leaves a ledger naming every migration that ran',
    async () => {
      const rows = await sql<{ version: number; name: string }[]>`
        SELECT version, name FROM schema_migration ORDER BY version
      `;

      expect(rows.map((row) => row.version)).toEqual(
        Array.from({ length: HEAD_SCHEMA_VERSION }, (_, i) => i + 1),
      );
      // Names, not just numbers: a ledger of bare integers cannot tell an
      // operator which change a tenant is missing.
      for (const row of rows) expect(row.name.length).toBeGreaterThan(3);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'every table that exists was declared here, and every declared table exists',
    async () => {
      const tables = await listTables(sql);
      const present = tables.map((t) => t.table).sort();

      expect(present).toEqual([...EXPECTED_TABLES.keys()].sort());
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'every table declares a legal class in its own comment — fail-closed',
    async () => {
      const tables = await listTables(sql);
      const findings: string[] = [];

      for (const { table, comment } of tables) {
        const declared = comment?.split(/\s|—/)[0];
        if (declared === undefined || !TABLE_CLASSES.includes(declared as TableClass)) {
          findings.push(
            `${table}: comment does not open with one of ${TABLE_CLASSES.join(', ')} — an unclassified table is a table no R15 guard covers`,
          );
          continue;
        }
        const expected = EXPECTED_TABLES.get(table);
        if (declared !== expected) findings.push(`${table}: declares ${declared}, expected ${expected}`);
      }

      expect(findings).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the tenant records its own FTS language and taxonomy version',
    async () => {
      const rows = await sql<{ fts_language: string; taxonomy_version: number }[]>`
        SELECT fts_language, taxonomy_version FROM tenant_setting
      `;

      expect(rows).toHaveLength(1);
      expect(rows[0]?.fts_language).toBe(FIXTURE_FTS_LANGUAGE);
      expect(rows[0]?.taxonomy_version).toBeGreaterThanOrEqual(1);

      // A second row would make "the tenant's language" ambiguous, which is the
      // shape KTD9's silent fallback takes once there is more than one answer.
      const second = await sqlstateOfFailure(
        sql,
        `INSERT INTO tenant_setting (fts_language, taxonomy_version) VALUES ('english', 1)`,
      );
      expect(second).toBeDefined();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('R15 — origin and subject, on every content row, enumerated', () => {
  test(
    'each class carries the origin shape its class implies',
    async () => {
      const columns = await listColumns(sql);
      const findings: string[] = [];

      for (const [table, klass] of EXPECTED_TABLES) {
        const cols = columnsOf(columns, table);
        const scalar = cols.get('origin_context');
        const union = cols.get('origin_contexts');

        if (klass === 'content:ingested') {
          if (scalar === undefined || scalar.type !== 'text' || !scalar.notNull) {
            findings.push(`${table}: an ingested row needs a NOT NULL scalar origin_context`);
          }
          if (union !== undefined) {
            findings.push(`${table}: an ingested row arrives through one credential, not a union`);
          }
        }

        if (klass === 'content:derived') {
          // R15: derived rows inherit the union of their inputs' origins, so the
          // column has to be able to hold more than one.
          if (union === undefined || union.type !== 'text[]' || !union.notNull) {
            findings.push(`${table}: a derived row needs a NOT NULL origin_contexts text[]`);
          }
          if (scalar !== undefined) {
            findings.push(`${table}: a derived row cannot narrow its origins to a scalar`);
          }
        }

        if (klass === 'registry' && (scalar !== undefined || union !== undefined)) {
          findings.push(`${table}: declares registry but carries an origin — reclassify it`);
        }
      }

      expect(findings).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'content rows carry a mutable, confidence-scored subject; nothing else does',
    async () => {
      const columns = await listColumns(sql);
      const findings: string[] = [];

      for (const [table, klass] of EXPECTED_TABLES) {
        const cols = columnsOf(columns, table);
        const subject = cols.get('subject_context');
        const confidence = cols.get('subject_confidence');
        const isContent = klass.startsWith('content:');

        if (isContent) {
          // Nullable on purpose: inference has not run yet on a freshly written
          // row, and "not yet inferred" must be distinguishable from "inferred
          // as nothing". Confidence is what makes it *scored* rather than
          // asserted — KTD5 lets it inform ranking, never access.
          if (subject === undefined || subject.notNull) {
            findings.push(`${table}: content rows need a nullable subject_context`);
          }
          if (confidence === undefined) findings.push(`${table}: subject_context needs a confidence`);
        } else if (subject !== undefined || confidence !== undefined) {
          findings.push(`${table}: is not content but carries a subject — reclassify or drop it`);
        }
      }

      expect(findings).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'every origin column in the database is protected by the shared trigger',
    async () => {
      const columns = await listColumns(sql);
      const triggers = await listTriggers(sql);
      const findings: string[] = [];

      const originColumns = columns.filter(
        (c) => c.column === 'origin_context' || c.column === 'origin_contexts',
      );

      // A vacuous scan would report a clean sheet for a schema with no fences at
      // all, which is exactly the failure the enumeration exists to catch. The
      // floor is stated against the tables that are *supposed* to carry a fence
      // — every table this file classes `content:*` — rather than as a fraction
      // of the whole catalog. The fraction was a proxy for the same thing and it
      // drifts: adding one deliberately origin-free table (U14's `source_pause`)
      // moved the denominator and nearly failed a schema in which nothing had
      // changed about origins at all. This form cannot drift, and it is
      // strictly stronger: it names which tables must appear, not how many.
      const mustBeFenced = [...EXPECTED_TABLES]
        .filter(([, klass]) => klass.startsWith('content:'))
        .map(([table]) => table)
        .sort();
      expect(mustBeFenced.length).toBeGreaterThanOrEqual(8);
      const fenced = new Set(originColumns.map((c) => c.table));
      expect([...mustBeFenced].filter((table) => !fenced.has(table))).toEqual([]);

      for (const column of originColumns) {
        const guarding = triggers.filter(
          (t) =>
            t.table === column.table &&
            t.definition.includes(SHARED_ORIGIN_TRIGGER_FUNCTION) &&
            t.definition.includes(`UPDATE OF ${column.column}`),
        );
        if (guarding.length === 0) {
          findings.push(
            `${column.table}.${column.column}: no BEFORE UPDATE OF trigger calling ${SHARED_ORIGIN_TRIGGER_FUNCTION}`,
          );
          continue;
        }
        for (const trigger of guarding) {
          if (!trigger.definition.startsWith('CREATE TRIGGER') || !trigger.definition.includes('BEFORE')) {
            findings.push(`${column.table}: ${trigger.trigger} is not a BEFORE trigger`);
          }
        }
      }

      expect(findings).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * One seeded row per origin-carrying table, and the tamper each one must refuse.
 *
 * Every table, not two of them. The previous version of this suite exercised the
 * fence behaviourally on `chunk` and `fact` and left the other six to a catalog
 * check — which meant a trigger disabled on `page`, `attachment`, `entity`,
 * `entity_edge`, `ingest_log` or `contradiction_report` was seen by nothing that
 * actually issues a write. The loop below is enumerated from the catalog and
 * cross-checked against this map, so a future origin column has to arrive with a
 * fixture or fail this file.
 */
const ORIGIN_FIXTURES: ReadonlyMap<string, { readonly where: string; readonly tamper: string }> =
  new Map([
    ['ingest_log', { where: `source_type = 'note'`, tamper: `origin_context = 'work'` }],
    ['page', { where: `title = 'fence fixture'`, tamper: `origin_context = 'work'` }],
    ['chunk', { where: `content = 'immutability fixture'`, tamper: `origin_context = 'work'` }],
    [
      'attachment',
      { where: `object_key = 'fence/fixture.png'`, tamper: `origin_context = 'work'` },
    ],
    [
      'fact',
      {
        where: `statement = 'derived fixture'`,
        // Widening in place is the interesting shape: it is how an inference
        // would silently grant a work-fenced reader a personal fact.
        tamper: `origin_contexts = ARRAY['personal','work']`,
      },
    ],
    [
      'entity',
      {
        where: `canonical_name = 'fence-subject'`,
        tamper: `origin_contexts = ARRAY['personal','work']`,
      },
    ],
    [
      'entity_edge',
      { where: `edge_type = 'related_to'`, tamper: `origin_contexts = ARRAY['personal','work']` },
    ],
    // Rung 11. An alias is a spelling somebody wrote in a message, so widening
    // it in place is how a personal-origin nickname would become readable to a
    // work-scoped grant that can already resolve the entity by intersect.
    [
      'entity_alias',
      { where: `alias = 'fence alias'`, tamper: `origin_contexts = ARRAY['personal','work']` },
    ],
    [
      'contradiction_report',
      {
        where: `kind = 'value_conflict'`,
        tamper: `origin_contexts = ARRAY['personal','work']`,
      },
    ],
    [
      'entity_card',
      { where: `summary = 'fence card'`, tamper: `origin_contexts = ARRAY['personal','work']` },
    ],
    [
      'commitment',
      {
        where: `statement = 'fence commitment'`,
        tamper: `origin_contexts = ARRAY['personal','work']`,
      },
    ],
    [
      'review_queue',
      { where: `target_ref = 'entity:fence'`, tamper: `origin_contexts = ARRAY['personal','work']` },
    ],
    ['page_version', { where: `doc_key = 'fence:version'`, tamper: `origin_context = 'work'` }],
    // U18. The audit record of a destructive operation: an origin that could be
    // edited afterwards is a trail that can be made to describe a different event.
    ['severance', { where: `origin_context = 'personal'`, tamper: `origin_context = 'work'` }],
  ]);

describe('R15 — the database refuses to let an origin move, on every table that has one', () => {
  beforeAll(async () => {
    const embedding = `('[1' || repeat(',0', ${EMBEDDING_DIMENSIONS - 1}) || ']')::vector(${EMBEDDING_DIMENSIONS})`;
    await sql.unsafe(`
      INSERT INTO ingest_log (origin_context, source_type) VALUES ('personal', 'note');
      INSERT INTO page (origin_context, source_type, title, embedding_model, embedding_dimensions,
                        chunker_version, normalizer_version, content_sha256)
      VALUES ('personal', 'note', 'fence fixture', 'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('b', 64));
      INSERT INTO chunk (origin_context, content) VALUES ('personal', 'immutability fixture');
      INSERT INTO attachment (origin_context, media_type, object_key)
      VALUES ('personal', 'image/png', 'fence/fixture.png');
      INSERT INTO fact (statement, embedding, origin_contexts)
      VALUES ('derived fixture', ${embedding}, ARRAY['personal']),
             ('derived fixture, the second', ${embedding}, ARRAY['personal']);
      INSERT INTO entity (canonical_name, entity_type, origin_contexts)
      VALUES ('fence-subject', 'person', ARRAY['personal']),
             ('fence-object', 'organization', ARRAY['personal']);
      INSERT INTO entity_alias (entity_id, alias, alias_source, origin_contexts)
      SELECT (SELECT entity_id FROM entity WHERE canonical_name = 'fence-subject'),
             'fence alias', 'user', ARRAY['personal'];
      INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
      SELECT (SELECT entity_id FROM entity WHERE canonical_name = 'fence-subject'),
             'related_to',
             (SELECT entity_id FROM entity WHERE canonical_name = 'fence-object'),
             ARRAY['personal'];
      INSERT INTO contradiction_report (left_fact_id, right_fact_id, kind, origin_contexts)
      SELECT (SELECT fact_id FROM fact WHERE statement = 'derived fixture'),
             (SELECT fact_id FROM fact WHERE statement = 'derived fixture, the second'),
             'value_conflict',
             ARRAY['personal'];
      INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts)
      SELECT (SELECT entity_id FROM entity WHERE canonical_name = 'fence-subject'),
             'fence card', 'model_inferred', 'model_derived', ARRAY['personal'];
      INSERT INTO commitment (fact_id, statement, trust_level, derivation, origin_contexts)
      SELECT (SELECT fact_id FROM fact WHERE statement = 'derived fixture'),
             'fence commitment', 'model_extracted', 'model_derived', ARRAY['personal'];
      INSERT INTO review_queue (kind, target_ref, proposal, confidence, origin_contexts)
      VALUES ('entity_merge', 'entity:fence', 'merge the fence entities', 0.6, ARRAY['personal']);
      INSERT INTO page_version (doc_key, version, origin_context, source_type, title, body,
                                content_sha256, captured_from)
      VALUES ('fence:version', 1, 'personal', 'note', 'fence fixture', 'the body as it stood',
              repeat('d', 64), 'live');
      INSERT INTO severance (origin_context, severed_at, removed, recomputed, surviving_origins)
      VALUES ('personal', now(), '{}'::jsonb, '{}'::jsonb, ARRAY['work']);
    `);
  });

  test(
    'every origin column in the database refuses the write, and the fixture covers every one',
    async () => {
      const columns = await listColumns(sql);
      const originColumns = columns.filter(
        (c) => c.column === 'origin_context' || c.column === 'origin_contexts',
      );

      // The half that makes the loop unable to go quiet: an origin column with
      // no fixture is a table this test would otherwise skip in silence.
      expect([...new Set(originColumns.map((c) => c.table))].sort()).toEqual(
        [...ORIGIN_FIXTURES.keys()].sort(),
      );

      for (const column of originColumns) {
        const fixture = ORIGIN_FIXTURES.get(column.table);
        expect(fixture).toBeDefined();
        if (fixture === undefined) continue;

        // The row has to be there, or a refused UPDATE proves nothing: an UPDATE
        // matching no rows also "fails to change the origin".
        const before = await sql.unsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM ${column.table} WHERE ${fixture.where}`,
        );
        expect(before[0]?.n).toBe(1);

        const state = await sqlstateOfFailure(
          sql,
          `UPDATE ${column.table} SET ${fixture.tamper} WHERE ${fixture.where}`,
        );

        // The code, not the message: the write path has to be able to tell this
        // apart from an ordinary constraint violation and answer `scope_denied`.
        expect(`${column.table}: ${state}`).toBe(`${column.table}: BZ001`);
      }

      // And the fence is enforced as the runner checks it, on this same
      // database — the catalog half and the behavioural probe both.
      await expect(assertOriginFence(sql)).resolves.toBeUndefined();
      expect(await findOriginFenceViolations(sql)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the origin the tamper tried to move is still what it was',
    async () => {
      const rows = await sql<{ origin_context: string }[]>`
        SELECT origin_context FROM chunk WHERE content = 'immutability fixture'
      `;
      expect(rows[0]?.origin_context).toBe('personal');

      const derived = await sql<{ origin_contexts: string[] }[]>`
        SELECT origin_contexts FROM fact WHERE statement = 'derived fixture'
      `;
      expect(derived[0]?.origin_contexts).toEqual(['personal']);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a disabled trigger is a finding, even though its definition still reads correctly',
    async () => {
      // `ALTER TABLE … DISABLE TRIGGER` mutates the row permanently and leaves a
      // clean catalog behind it: `pg_get_triggerdef` renders the trigger exactly
      // as written, so a guard that reads definitions sees nothing. `tgenabled`
      // is the column that tells the truth.
      await sql.unsafe('ALTER TABLE page DISABLE TRIGGER page_origin_is_immutable');
      try {
        const findings = await findOriginFenceViolations(sql);
        expect(findings).toHaveLength(1);
        expect(findings[0]).toContain('page.origin_context');
        await expect(assertOriginFence(sql)).rejects.toThrow(OriginFenceError);

        // **Rung 8 changed what happens next, and the change is the dividend.**
        // Before H6 was pinned, disabling this one trigger moved the row. Now
        // the same column carries a second, search-path-pinned trigger, so one
        // arm going down is a *finding* rather than a hole: the catalog half
        // above still reports it, and the write is still refused.
        expect(
          await sqlstateOfFailure(
            sql,
            `UPDATE page SET origin_context = 'work' WHERE title = 'fence fixture'`,
          ),
        ).toBe(ORIGIN_IMMUTABLE_SQLSTATE);

        // The tamper this finding is a finding about now costs both arms — and
        // with both down the row moves, and moves permanently.
        await sql.unsafe('ALTER TABLE page DISABLE TRIGGER page_origin_is_immutable_pinned');
        try {
          await sql.unsafe(`UPDATE page SET origin_context = 'work' WHERE title = 'fence fixture'`);
          const moved = await sql<{ origin_context: string }[]>`
            SELECT origin_context FROM page WHERE title = 'fence fixture'
          `;
          expect(moved[0]?.origin_context).toBe('work');
        } finally {
          await sql.unsafe('ALTER TABLE page ENABLE TRIGGER page_origin_is_immutable_pinned');
        }
      } finally {
        await sql.unsafe('ALTER TABLE page ENABLE TRIGGER page_origin_is_immutable');
        await sql.unsafe(`DELETE FROM page WHERE title = 'fence fixture'`);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a neutered shared function is a finding, which the catalog alone cannot see',
    async () => {
      // One statement, no DDL on any table, and every origin trigger calling
      // this function stops doing anything. This is the failure the behavioural
      // probe exists for: the catalog half reports a clean sheet throughout.
      const bodyOf = async (name: string): Promise<string> => {
        const rows = await sql<{ body: string }[]>`
          SELECT pg_get_functiondef(oid) AS body FROM pg_proc WHERE proname = ${name}
        `;
        const body = rows[0]?.body;
        expect(body).toBeDefined();
        return body ?? '';
      };
      const neuter = (name: string): string =>
        `CREATE OR REPLACE FUNCTION ${name}() RETURNS trigger
         LANGUAGE plpgsql AS $neutered$ BEGIN RETURN NEW; END; $neutered$`;

      const restore = await bodyOf('refuse_origin_change');
      const restorePinned = await bodyOf('refuse_origin_change_pinned');

      await sql.unsafe(neuter('refuse_origin_change'));
      try {
        // Blind, and that is the point of having two halves.
        expect(await findOriginFenceViolations(sql)).toEqual([]);

        await expect(assertOriginFence(sql)).rejects.toThrow(/no longer refuses an origin change/);

        // **And rung 8's dividend, stated where it is measured.** One
        // `CREATE OR REPLACE` used to take every table's fence with it. It no
        // longer does: the pinned twin H6 added is a *different* function, so
        // the same statement now costs one arm rather than the fence.
        expect(
          await sqlstateOfFailure(
            sql,
            `UPDATE chunk SET origin_context = 'work' WHERE content = 'immutability fixture'`,
          ),
        ).toBe(ORIGIN_IMMUTABLE_SQLSTATE);

        // Two statements, then, rather than one — and only then is the fence
        // really gone while the catalog still says otherwise.
        await sql.unsafe(neuter('refuse_origin_change_pinned'));
        try {
          expect(await findOriginFenceViolations(sql)).toEqual([]);
          expect(
            await sqlstateOfFailure(
              sql,
              `UPDATE chunk SET origin_context = 'work' WHERE content = 'immutability fixture'`,
            ),
          ).toBeUndefined();
        } finally {
          // The row goes back BEFORE either function does. Once the fence is
          // restored, moving this origin back is itself a change it refuses —
          // which is the finding stated as a cleanup problem: a tamper window
          // leaves rows the database will not let anyone put back.
          await sql.unsafe(
            `UPDATE chunk SET origin_context = 'personal' WHERE content = 'immutability fixture'`,
          );
          await sql.unsafe(restorePinned);
        }
      } finally {
        await sql.unsafe(restore);
      }

      // Restored: the fence is back, and it refuses again.
      await expect(assertOriginFence(sql)).resolves.toBeUndefined();
      expect(
        await sqlstateOfFailure(
          sql,
          `UPDATE chunk SET origin_context = 'work' WHERE content = 'immutability fixture'`,
        ),
      ).toBe('BZ001');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the trigger refuses a change, not every UPDATE',
    async () => {
      // Without this, a trigger that raised unconditionally would pass every
      // assertion above while making inference (R15's mutable half) impossible.
      await sql.unsafe(
        `UPDATE chunk SET subject_context = 'travel', subject_confidence = 0.7 WHERE content = 'immutability fixture'`,
      );
      const rows = await sql<{ subject_context: string | null }[]>`
        SELECT subject_context FROM chunk WHERE content = 'immutability fixture'
      `;
      expect(rows[0]?.subject_context).toBe('travel');

      // And a SET of the same value is not a change. The write path re-writes
      // whole rows; a trigger keyed on "the column appeared in the SET list"
      // rather than on the value would break every such write.
      await sql.unsafe(
        `UPDATE chunk SET origin_context = 'personal' WHERE content = 'immutability fixture'`,
      );
    },
    TEST_TIMEOUT_MS,
  );
});

describe('KTD8 / H2 — every vector column is accounted for', () => {
  test(
    'the schema declares no vector column that is neither indexed nor reserved',
    async () => {
      const columns = await listColumns(sql);
      const vectorColumns = columns
        .filter((c) => c.type.startsWith('vector(') || c.type.startsWith('halfvec('))
        .map((c) => `${c.table}.${c.column}`)
        .sort();

      const registered = [
        ...INDEXED_VECTOR_COLUMNS.map((c) => `${c.table}.${c.column}`),
        ...RESERVED_VECTOR_COLUMNS.map((c) => `${c.table}.${c.column}`),
      ].sort();

      // Fail-closed both ways. An unregistered vector column is H2 waiting to
      // happen — it answers by sequential scan, exactly, forever.
      expect(vectorColumns).toEqual(registered);
      expect(vectorColumns.length).toBeGreaterThan(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'every column registered as indexed really has a valid hnsw index the arm can use',
    async () => {
      for (const column of INDEXED_VECTOR_COLUMNS) {
        const index = await assertHnswIndex(sql, column.table, column.column, column.operator);
        expect(index.method).toBe('hnsw');
        expect(index.valid).toBe(true);
        // An hnsw index whose opclass cannot serve the operator the arm issues
        // is an index the planner will not use, which is the missing index this
        // guard exists to catch wearing a healthy catalog row.
        expect(index.servesOperator).toBe(true);
      }

      // The one the hazard suite pins, named explicitly so a refactor that
      // renamed it would have to come through here too.
      expect(
        INDEXED_VECTOR_COLUMNS.some(
          (c) => c.table === CHUNK_TABLE && c.column === CHUNK_EMBEDDING_COLUMN,
        ),
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the reserved image column is reserved: unfilled, unindexed, inside the ceiling',
    async () => {
      const columns = await listColumns(sql);

      for (const column of RESERVED_VECTOR_COLUMNS) {
        const indexes = await findIndexesOnColumn(sql, column.table, column.column);
        // Reserved means nothing queries it. An index on an unqueried column is
        // a build cost and a promise the U21 model has not made yet — and the
        // moment something *does* query it, the registry entry has to move.
        expect(indexes).toEqual([]);

        // And the property that makes "nothing queries it" checkable rather than
        // asserted: nothing *fills* it either. A NOT NULL vector column means
        // every insert must produce an embedding, and no write path pays an
        // embedding call per row for a column no read ever touches — so a
        // queried column quietly re-filed as reserved fails here.
        const declared = columnsOf(columns, column.table).get(column.column);
        expect(declared?.notNull).toBe(false);
      }

      expect(findVectorRegistryViolations(await listVectorColumns(sql))).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'facts are embedded synchronously — the column cannot be NULL',
    async () => {
      const columns = await listColumns(sql);
      const factEmbedding = columnsOf(columns, 'fact').get('embedding');
      const chunkEmbedding = columnsOf(columns, 'chunk').get('embedding');

      // The asymmetry is the design (U3 approach step 1): a chunk is written
      // before it is embedded and backfilled, so its column is nullable; a fact
      // is embedded on the write path, so an unembedded fact is a bug the
      // database can refuse rather than a row the vector arm silently skips.
      expect(factEmbedding?.notNull).toBe(true);
      expect(chunkEmbedding?.notNull).toBe(false);

      const state = await sqlstateOfFailure(
        sql,
        `INSERT INTO fact (statement, origin_contexts) VALUES ('unembedded', ARRAY['personal'])`,
      );
      expect(state).toBe('23502'); // not_null_violation
    },
    TEST_TIMEOUT_MS,
  );
});

describe('KTD9 — the tenant’s language reaches every generated column', () => {
  test(
    'no generated text-search column silently says english',
    async () => {
      const columns = await listColumns(sql);
      const generated = columns.filter((c) => c.generated && c.type === 'tsvector');

      // Two of them today (chunk body, page title); the assertion is over
      // whatever exists, so a third added later is covered by construction.
      expect(generated.length).toBeGreaterThanOrEqual(2);

      for (const column of generated) {
        const expression = await generatedExpression(sql, column.table, column.column);
        expect(expression).toContain(`'${FIXTURE_FTS_LANGUAGE}'::regconfig`);
        expect(expression).not.toContain('english');
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the full-text arm has an index to read on both of them',
    async () => {
      const columns = await listColumns(sql);
      const generated = columns.filter((c) => c.generated && c.type === 'tsvector');

      for (const column of generated) {
        const indexes = await listIndexes(sql, column.table);
        const covering = indexes.filter(
          (index) => index.method === 'gin' && index.definition.includes(column.column),
        );
        expect(covering.length).toBeGreaterThanOrEqual(1);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('KTD8 — the per-page provenance signature a re-embed keys on', () => {
  test(
    'a page names the model, the dimension and the pipeline that produced it',
    async () => {
      const columns = columnsOf(await listColumns(sql), 'page');

      for (const name of [
        'embedding_model',
        'embedding_dimensions',
        'chunker_version',
        'normalizer_version',
        'content_sha256',
      ]) {
        expect(columns.get(name)?.notNull).toBe(true);
      }

      // Derived rather than stored twice: U10's `re_embed` job selects on this
      // one value, and a hand-assembled signature drifts from its parts.
      expect(columns.get('provenance_signature')?.generated).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the signature changes when any part of the pipeline changes',
    async () => {
      const rows = await sql<{ signature: string }[]>`
        INSERT INTO page (origin_context, source_type, title, embedding_model,
                          embedding_dimensions, chunker_version, normalizer_version, content_sha256)
        VALUES ('personal', 'note', 'provenance', 'text-embedding-3-large',
                ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64)),
               ('personal', 'note', 'provenance', 'text-embedding-3-small',
                ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64))
        RETURNING provenance_signature AS signature
      `;

      expect(rows).toHaveLength(2);
      expect(rows[0]?.signature).not.toBe(rows[1]?.signature);
      expect(rows[0]?.signature).toContain('text-embedding-3-large');
      expect(rows[0]?.signature).toContain(String(EMBEDDING_DIMENSIONS));
    },
    TEST_TIMEOUT_MS,
  );
});
