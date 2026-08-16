/**
 * Subject-scoped erasure (R12's second axis), against the four properties
 * U15's controller/processor determination fixes for it (§6.3).
 *
 * The fixture is a brain holding two correspondents and one bystander, so every
 * assertion has something to be wrong about:
 *
 *   * `alice-example` — the requester. Named in a page title, in a passage, in a
 *     fact, in a commitment, and resolved to an entity with a card and an edge.
 *   * `charlie-example` — a second correspondent who must survive intact. An
 *     erasure that deleted the brain is not an erasure.
 *   * A surviving fact derived from *both* correspondents' passages, which is
 *     the row that must be reported as **recomputed** rather than removed.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  eraseSubject,
  isErasedSubject,
  previewSubjectErasure,
  subjectDigest,
} from '../../../src/core/lifecycle/subject-erasure.ts';
import { EMBEDDING_DIMENSIONS } from '../../../src/schema/vector-index.ts';
import { connect, dropFixtureDatabase, provisionFixture, type SchemaFixture } from '../../schema/fixture.ts';

import type { SQL } from 'bun';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

const ORIGIN = 'personal';
const SUBJECT = 'alice-example@widget-co.test';
const BYSTANDER = 'charlie-example@acme-example.test';

let schema: SchemaFixture;
let sql: SQL;

const EMBEDDING = `('[1' || repeat(',0', ${EMBEDDING_DIMENSIONS - 1}) || ']')::vector(${EMBEDDING_DIMENSIONS})`;

async function seed(): Promise<void> {
  await sql.unsafe(`
    DELETE FROM erased_subject;
    DELETE FROM page_version;
    DELETE FROM fact_source; DELETE FROM entity_edge; UPDATE fact SET superseded_by = NULL;
    DELETE FROM commitment; DELETE FROM entity_card;
    DELETE FROM fact; DELETE FROM entity_alias; DELETE FROM entity_slug; DELETE FROM entity;
    DELETE FROM chunk; DELETE FROM page;

    INSERT INTO page (origin_context, source_type, title, external_ref, embedding_model,
                      embedding_dimensions, chunker_version, normalizer_version, content_sha256)
    VALUES ('${ORIGIN}', 'email', 'Lunch with ${SUBJECT}', 'gmail:a1',
            'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64)),
           ('${ORIGIN}', 'email', 'A thread about the rollout', 'gmail:a2',
            'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('b', 64)),
           ('${ORIGIN}', 'email', 'Unrelated: quarterly numbers', 'gmail:a3',
            'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('c', 64));

    INSERT INTO chunk (origin_context, content, page_id, ordinal)
    SELECT '${ORIGIN}', 'we agreed a date', page_id, 0 FROM page WHERE external_ref = 'gmail:a1';
    INSERT INTO chunk (origin_context, content, page_id, ordinal)
    SELECT '${ORIGIN}', 'the rollout owner is ${SUBJECT} and nobody disputed it', page_id, 0
      FROM page WHERE external_ref = 'gmail:a2';
    INSERT INTO chunk (origin_context, content, page_id, ordinal)
    SELECT '${ORIGIN}', 'revenue was up and ${BYSTANDER} presented it', page_id, 0
      FROM page WHERE external_ref = 'gmail:a3';

    INSERT INTO entity (canonical_name, entity_type, origin_contexts)
    VALUES ('${SUBJECT}', 'person', ARRAY['${ORIGIN}']),
           ('${BYSTANDER}', 'person', ARRAY['${ORIGIN}']);

    INSERT INTO entity_slug (slug, entity_id, kind)
    SELECT 'alice-example-widget-co-test', entity_id, 'canonical'
      FROM entity WHERE canonical_name = '${SUBJECT}';
    INSERT INTO entity_slug (slug, entity_id, kind)
    SELECT 'charlie-example-acme-example-test', entity_id, 'canonical'
      FROM entity WHERE canonical_name = '${BYSTANDER}';

    INSERT INTO entity_alias (entity_id, alias, alias_source)
    SELECT entity_id, '${SUBJECT}', 'user' FROM entity WHERE canonical_name = '${SUBJECT}';
    INSERT INTO entity_alias (entity_id, alias, alias_source)
    SELECT entity_id, '${BYSTANDER}', 'user' FROM entity WHERE canonical_name = '${BYSTANDER}';

    INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
    SELECT (SELECT entity_id FROM entity WHERE canonical_name = '${SUBJECT}'),
           'related_to',
           (SELECT entity_id FROM entity WHERE canonical_name = '${BYSTANDER}'),
           ARRAY['${ORIGIN}'];

    INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts)
    SELECT entity_id, 'runs the rollout', 'model_inferred', 'model_derived', ARRAY['${ORIGIN}']
      FROM entity WHERE canonical_name = '${SUBJECT}';
    INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts)
    SELECT entity_id, 'presents the numbers', 'model_inferred', 'model_derived', ARRAY['${ORIGIN}']
      FROM entity WHERE canonical_name = '${BYSTANDER}';

    -- A fact naming the subject: removed.
    INSERT INTO fact (statement, embedding, origin_contexts, page_id)
    SELECT '${SUBJECT} owns the rollout', ${EMBEDDING}, ARRAY['${ORIGIN}'], page_id
      FROM page WHERE external_ref = 'gmail:a2';
    -- A fact naming nobody, on a surviving page, but derived partly from a
    -- passage that is going: RECOMPUTED, not removed.
    INSERT INTO fact (statement, embedding, origin_contexts, page_id)
    SELECT 'the rollout is owned', ${EMBEDDING}, ARRAY['${ORIGIN}'], page_id
      FROM page WHERE external_ref = 'gmail:a3';
    INSERT INTO fact_source (fact_id, chunk_id)
    SELECT (SELECT fact_id FROM fact WHERE statement = 'the rollout is owned'),
           (SELECT c.chunk_id FROM chunk c JOIN page p ON p.page_id = c.page_id
             WHERE p.external_ref = 'gmail:a2');

    -- A fact about the bystander alone, sourced from the bystander's OWN chunk.
    -- This is the shape U4's write path creates for every extracted fact, and
    -- it is what makes the over-deletion below observable: in a single-origin
    -- brain every fact's origins overlap every edge's origins, so a page
    -- discovery keyed on origin overlap matches this page too.
    INSERT INTO fact (statement, embedding, origin_contexts, page_id)
    SELECT '${BYSTANDER} presented the numbers', ${EMBEDDING}, ARRAY['${ORIGIN}'], page_id
      FROM page WHERE external_ref = 'gmail:a3';
    INSERT INTO fact_source (fact_id, chunk_id)
    SELECT (SELECT fact_id FROM fact WHERE statement = '${BYSTANDER} presented the numbers'),
           (SELECT c.chunk_id FROM chunk c JOIN page p ON p.page_id = c.page_id
             WHERE p.external_ref = 'gmail:a3');

    INSERT INTO commitment (statement, owner_name, trust_level, derivation, origin_contexts)
    VALUES ('send the plan', '${SUBJECT}', 'model_extracted', 'model_derived', ARRAY['${ORIGIN}']),
           ('file the report', '${BYSTANDER}', 'model_extracted', 'model_derived', ARRAY['${ORIGIN}']);
  `);
}

async function count(table: string, where = 'deleted_at IS NULL'): Promise<number> {
  const rows = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

beforeEach(async () => {
  if (schema === undefined) {
    schema = await provisionFixture('u17subject');
    sql = connect(schema);
  }
  await seed();
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await sql?.close();
  if (schema !== undefined) await dropFixtureDatabase(schema);
});

describe('the fixture holds what the erasure is about', () => {
  test(
    'if this fails, every assertion below is vacuous',
    async () => {
      expect(await count('page')).toBe(3);
      expect(await count('entity')).toBe(2);
      expect(await count('entity_card')).toBe(2);
      expect(await count('commitment')).toBe(2);
      expect(await count('fact')).toBe(3);
      expect(await count('entity_edge', 'TRUE')).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the identifier resolves through the brain, not through a string match alone', () => {
  test(
    'the entity is found through its alias',
    async () => {
      const preview = await previewSubjectErasure(sql, { identifier: SUBJECT });
      expect(preview.entityIds).toHaveLength(1);
      expect(preview.surfaceForms).toContain(SUBJECT);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an identifier nobody in the brain matches resolves to nothing, and says so',
    async () => {
      const preview = await previewSubjectErasure(sql, { identifier: 'nobody@nowhere.test' });
      expect(preview.entityIds).toEqual([]);
      expect(preview.matches).toEqual([]);
      expect(preview.removed.pages).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a LIKE metacharacter in an identifier does not widen the sweep',
    async () => {
      // `%` is a wildcard, and a correspondent's name is theirs. Without the
      // escape this erases the whole brain on a one-character request.
      const preview = await previewSubjectErasure(sql, { identifier: '%' });
      expect(preview.matches).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the span reaches derivation, not only rows', () => {
  test(
    'the subject leaves: their pages, entity, card, edge, facts and commitments',
    async () => {
      await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });

      expect(await count('page')).toBe(1);
      expect(await count('entity')).toBe(1);
      expect(await count('entity_card')).toBe(1);
      expect(await count('entity_edge', 'TRUE')).toBe(0);

      const facts = (await sql`
        SELECT statement FROM fact WHERE deleted_at IS NULL ORDER BY statement
      `) as Array<{ statement: string }>;
      expect(facts.map((row) => row.statement)).toEqual([
        `${BYSTANDER} presented the numbers`,
        'the rollout is owned',
      ]);

      const commitments = (await sql`
        SELECT owner_name FROM commitment WHERE deleted_at IS NULL
      `) as Array<{ owner_name: string }>;
      expect(commitments.map((row) => row.owner_name)).toEqual([BYSTANDER]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the other correspondent survives — an erasure that deletes the brain is not an erasure',
    async () => {
      await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });

      const survivors = (await sql`
        SELECT canonical_name FROM entity WHERE deleted_at IS NULL
      `) as Array<{ canonical_name: string }>;
      expect(survivors.map((row) => row.canonical_name)).toEqual([BYSTANDER]);
      expect(await isErasedSubject(sql, BYSTANDER)).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a page found by text rather than by the graph is reported as such',
    async () => {
      const preview = await previewSubjectErasure(sql, { identifier: SUBJECT });
      const handles = new Set(preview.matches.map((match) => match.handle));
      expect(handles.has('text')).toBe(true);
      expect(preview.matches.map((match) => match.externalRef).sort()).toEqual([
        'gmail:a1',
        'gmail:a2',
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the sweep does not widen past the person it is about', () => {
  test(
    'a page that only ever mentioned the OTHER correspondent survives',
    async () => {
      // The failure this is written against: `entity_edge.origin_contexts &&
      // fact.origin_contexts` looks like a derivation edge and is not one. In a
      // single-origin brain — the ordinary alpha shape, everything `personal` —
      // every fact overlaps every edge, so once the subject has one edge, every
      // fact-bearing page in the brain matches. Erasing one correspondent would
      // delete the brain.
      await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });

      const survivors = (await sql`
        SELECT external_ref FROM page WHERE deleted_at IS NULL ORDER BY external_ref
      `) as Array<{ external_ref: string }>;
      expect(survivors.map((row) => row.external_ref)).toEqual(['gmail:a3']);

      const facts = (await sql`
        SELECT statement FROM fact WHERE deleted_at IS NULL ORDER BY statement
      `) as Array<{ statement: string }>;
      expect(facts.map((row) => row.statement)).toEqual([
        `${BYSTANDER} presented the numbers`,
        'the rollout is owned',
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a captured version does not keep the erased correspondent\'s document text',
    async () => {
      // `page_version` is a second copy of every document — this unit's own rung
      // says so — and the 72h purge cannot reach it by design (ON DELETE SET
      // NULL is what keeps history alive across a purge). A subject erasure that
      // tombstoned the page and left the snapshot would hand a requester a
      // receipt while her mail sat verbatim in the table the same unit created.
      const [{ page_id: pageId } = { page_id: '' }] = (await sql`
        SELECT page_id::text AS page_id FROM page WHERE external_ref = 'gmail:a2'
      `) as Array<{ page_id: string }>;
      await sql`
        INSERT INTO page_version (doc_key, version, page_id, origin_context, source_type,
                                  title, body, content_sha256, captured_from)
        VALUES ('gmail:a2', 1, ${pageId}::bigint, ${ORIGIN}, 'email',
                ${`A thread about the rollout`},
                ${`the rollout owner is ${SUBJECT} and nobody disputed it`},
                ${'f'.repeat(64)}, 'live')
      `;
      expect(await count('page_version', 'TRUE')).toBe(1);

      await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });

      const rows = (await sql`SELECT doc_key, body FROM page_version`) as Array<{
        doc_key: string;
        body: string;
      }>;
      expect(rows.filter((row) => row.body.includes('alice-example'))).toEqual([]);
      expect(rows.map((row) => row.doc_key)).not.toContain('gmail:a2');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('what survives is not automatically correct', () => {
  test(
    'a surviving fact that lost a source passage is reported as recomputed',
    async () => {
      const preview = await previewSubjectErasure(sql, { identifier: SUBJECT });
      expect(preview.recomputed.facts).toBe(1);
      expect(preview.recomputeRequired).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a surviving entity that was linked to the erased one has a card to re-derive',
    async () => {
      const preview = await previewSubjectErasure(sql, { identifier: SUBJECT });
      expect(preview.recomputed.entityCards).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the recomputed row is not also counted as removed',
    async () => {
      const preview = await previewSubjectErasure(sql, { identifier: SUBJECT });
      expect(preview.removed.facts).toBe(1);
      expect(preview.recomputed.facts).toBe(1);
      expect(preview.removed.entityCards).toBe(1);
      expect(preview.recomputed.entityCards).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('tombstoned against re-ingestion', () => {
  test(
    'the brain will refuse to re-ingest this correspondent, and the tombstone holds no address',
    async () => {
      expect(await isErasedSubject(sql, SUBJECT)).toBe(false);
      const receipt = await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });

      expect(receipt.reingestionTombstoned).toBe(true);
      expect(await isErasedSubject(sql, SUBJECT)).toBe(true);

      // The tombstone stores a digest. Keeping the address would be the one
      // piece of her data that erasure *created*.
      const rows = (await sql`SELECT * FROM erased_subject`) as Array<Record<string, unknown>>;
      expect(JSON.stringify(rows)).not.toContain('alice-example');
      expect(rows[0]?.subject_digest).toBe(subjectDigest(SUBJECT));
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the tombstone recognises the identifier however it is spelled',
    async () => {
      await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });
      // Normalised through the write path's own normalizer, so the comparison
      // is the one the brain would have made.
      expect(await isErasedSubject(sql, SUBJECT.toUpperCase())).toBe(true);
      expect(await isErasedSubject(sql, `  ${SUBJECT}  `)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an MCP-issued authority is not expressible — R12a, applied where it matters most',
    async () => {
      // The schema refuses it. The assistant that would issue this erasure is
      // the assistant reading the correspondent's mail.
      let refused = false;
      try {
        await sql.unsafe(
          `INSERT INTO erased_subject (subject_digest, erased_by) VALUES ('${'d'.repeat(64)}', 'agent_mcp')`,
        );
      } catch {
        refused = true;
      }
      expect(refused).toBe(true);
      // And the refusal is the CHECK rather than a missing row: the same insert
      // with an out-of-band authority succeeds.
      await sql.unsafe(
        `INSERT INTO erased_subject (subject_digest, erased_by) VALUES ('${'e'.repeat(64)}', 'panel')`,
      );
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the receipt', () => {
  test(
    'carries the same time bound account erasure states',
    async () => {
      const receipt = await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });
      // Beside the account-erasure SLA and deliberately not longer than it: a
      // subject request answered more slowly than a user's own deletion would
      // be the party with the least leverage waiting the longest.
      expect(receipt.unrecoverableAfterDays).toBe(7);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'names the raw payloads it could not reach when no object store was supplied',
    async () => {
      const receipt = await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });
      // Two matched pages carry an external ref, and without a store and a key
      // deriver this run removed neither. Reported, never assumed away.
      expect(receipt.rawObjectsRemoved).toBe(0);
      expect(receipt.rawObjectsUnreachable).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'removes the raw payloads when it is given the means to',
    async () => {
      const deleted: string[] = [];
      const receipt = await eraseSubject(
        {
          sql,
          rawKeyOf: (ref) => `tenants/t/raw/${ref}`,
          objects: {
            delete: (key) => {
              deleted.push(key);
              return Promise.resolve(true);
            },
          },
        },
        { identifier: SUBJECT, erasedBy: 'app' },
      );
      expect(receipt.rawObjectsRemoved).toBe(2);
      expect(receipt.rawObjectsUnreachable).toBe(0);
      expect(deleted.sort()).toEqual(['tenants/t/raw/gmail:a1', 'tenants/t/raw/gmail:a2']);
    },
    TEST_TIMEOUT_MS,
  );
});
