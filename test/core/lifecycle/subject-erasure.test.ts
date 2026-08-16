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
import { docKeyFor } from '../../../src/core/export/reconstruct.ts';
import { captureSupersededVersions, revertPage } from '../../../src/core/lifecycle/versions.ts';
import { contentDigest, type WriteContext } from '../../../src/core/write/write-path.ts';
import { purgeExpiredTombstones } from '../../../src/mcp/tombstone.ts';
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
    DELETE FROM review_queue; DELETE FROM attachment;
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

async function liveStatements(table: 'fact' | 'commitment'): Promise<string[]> {
  const rows = (await sql.unsafe(
    `SELECT statement FROM ${table} WHERE deleted_at IS NULL ORDER BY statement`,
  )) as Array<{ statement: string }>;
  return rows.map((row) => row.statement);
}

/**
 * The alias `resolveOrCreateEntity` writes for **every** surface form the
 * extractor emits (`src/core/write/links.ts` — `normalize(request.name)` as an
 * `inferred` alias, with no length floor). A correspondent who signs off `Al`
 * puts a two-character row in the alias vocabulary through the ordinary write
 * path, and the erasure sweep reads that vocabulary.
 */
async function seedInferredNickname(alias: string): Promise<void> {
  await sql`
    INSERT INTO entity_alias (entity_id, alias, alias_source, confidence)
    SELECT entity_id, ${alias}, 'inferred', 0.5 FROM entity WHERE canonical_name = ${SUBJECT}
  `;
}

/** Three rows about other people that a substring sweep on `al` would take. */
async function seedRowsAboutOtherPeople(): Promise<void> {
  await sql.unsafe(`
    INSERT INTO fact (statement, embedding, origin_contexts, page_id)
    SELECT 'the legal review is with Alvarez & Partners', ${EMBEDDING}, ARRAY['${ORIGIN}'], page_id
      FROM page WHERE external_ref = 'gmail:a3';
    INSERT INTO fact (statement, embedding, origin_contexts, page_id)
    SELECT 'renewal terms are final', ${EMBEDDING}, ARRAY['${ORIGIN}'], page_id
      FROM page WHERE external_ref = 'gmail:a3';
    INSERT INTO commitment (statement, owner_name, trust_level, derivation, origin_contexts)
    VALUES ('send the Alberta numbers to the board', '${BYSTANDER}',
            'model_extracted', 'model_derived', ARRAY['${ORIGIN}']);
  `);
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

// ===========================================================================
// The sweep's width — the hazard this module's own header names.
//
// The header says the mitigation for a short inferred alias "is the flow rather
// than a filter: the controller sees previewSubjectErasure's match list — every
// page, with the handle that found it — before instructing." Two properties
// have to hold for that sentence to be true, and each has its own block below:
// the sweep must not take rows the identifier does not name, and the preview
// must be able to NAME every row the sweep will take. A count of `facts: 2` is
// not a match list.
// ===========================================================================

describe('the text handle matches a name, not a substring', () => {
  test(
    'a two-character inferred alias does not take three other people\'s rows',
    async () => {
      // `al` reaches `legal`, `Alvarez`, `renewal`, `final` and `Alberta` as a
      // substring. Under `statement ILIKE '%al%'` erasing one correspondent
      // soft-deletes another correspondent's commitment and two facts about a
      // law firm — onto a 72h clock, with nothing telling the user to restore
      // rows they do not know were taken.
      await seedInferredNickname('al');
      await seedRowsAboutOtherPeople();

      const preview = await previewSubjectErasure(sql, { identifier: SUBJECT });
      expect(preview.surfaceForms).toContain('al');

      await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });

      const facts = await liveStatements('fact');
      expect(facts).toContain('the legal review is with Alvarez & Partners');
      expect(facts).toContain('renewal terms are final');
      expect(await liveStatements('commitment')).toContain(
        'send the Alberta numbers to the board',
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and a correspondent who really is called Al is still erased by it',
    async () => {
      // The other half, and the reason the fix is a word boundary rather than a
      // length floor: a filter that dropped short aliases would answer the
      // over-deletion by quietly under-erasing, which on this operation is the
      // worse failure of the two.
      await seedInferredNickname('al');
      await sql.unsafe(`
        INSERT INTO fact (statement, embedding, origin_contexts, page_id)
        SELECT 'al owns the deployment window', ${EMBEDDING}, ARRAY['${ORIGIN}'], page_id
          FROM page WHERE external_ref = 'gmail:a3';
      `);

      await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });

      expect(await liveStatements('fact')).not.toContain('al owns the deployment window');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a regex metacharacter in an identifier does not widen the sweep either',
    async () => {
      // The mirror of the LIKE-metacharacter guard above. A sweep that moved to
      // regex matching without moving its escaping would answer `.*` by
      // matching every row in the brain.
      const preview = await previewSubjectErasure(sql, { identifier: '.*' });
      expect(preview.matches).toEqual([]);
      expect(preview.removed.facts).toBe(0);
      expect(preview.removed.commitments).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the preview names what it will take, so the flow can be the mitigation', () => {
  test(
    'every fact and commitment the sweep will remove is named in the preview',
    async () => {
      const preview = await previewSubjectErasure(sql, { identifier: SUBJECT });

      const facts = preview.rows.filter((row) => row.kind === 'fact');
      const commitments = preview.rows.filter((row) => row.kind === 'commitment');

      // The count and the list are the same set, so a receipt cannot report a
      // number nobody can inspect.
      expect(facts).toHaveLength(preview.removed.facts);
      expect(commitments).toHaveLength(preview.removed.commitments);

      expect(facts.map((row) => row.excerpt)).toContain(`${SUBJECT} owns the rollout`);
      // The owner is in the excerpt because the owner is why this row matched:
      // an excerpt that showed only `send the plan` would name a row without
      // showing the controller what named it.
      expect(commitments.map((row) => row.excerpt)).toContain(`${SUBJECT}: send the plan`);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a row found by its own text says so, and one found through its page says that',
    async () => {
      const preview = await previewSubjectErasure(sql, { identifier: SUBJECT });

      // The subject's commitment hangs off no page at all: only its own text
      // names her, and that is the handle a controller has to be able to see.
      const commitment = preview.rows.find((row) => row.kind === 'commitment');
      expect(commitment?.handle).toBe('text');

      // The fact on `gmail:a2` goes because its page goes.
      const fact = preview.rows.find(
        (row) => row.kind === 'fact' && row.excerpt === `${SUBJECT} owns the rollout`,
      );
      expect(fact?.handle).toBe('page');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'what the erasure actually removed is what the receipt names',
    async () => {
      await seedInferredNickname('al');
      await seedRowsAboutOtherPeople();

      const receipt = await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });

      const removedFacts = receipt.rows.filter((row) => row.kind === 'fact').map((row) => row.excerpt);
      const stillLive = await liveStatements('fact');
      for (const statement of removedFacts) expect(stillLive).not.toContain(statement);
      // And nothing went that the receipt did not name.
      const gone = (await sql`
        SELECT statement FROM fact WHERE deleted_at IS NOT NULL
      `) as Array<{ statement: string }>;
      expect(gone.map((row) => row.statement).sort()).toEqual([...removedFacts].sort());
    },
    TEST_TIMEOUT_MS,
  );
});

// ===========================================================================
// The tables nothing else will ever sweep.
//
// `page` rides `forget`'s 72h purge; `page_version`'s foreign key is ON DELETE
// SET NULL and `review_queue` has no foreign key at all, both deliberately, so
// neither is ever reached by it. A subject erasure that does not take them
// itself does not take them.
// ===========================================================================

describe('a document edited after its snapshot was banked', () => {
  const DOC = 'drive:doc1';
  const V1_TITLE = 'Draft, first pass';
  const V1_BODY = `draft reviewed by ${SUBJECT}, reachable on +49 30 111111`;
  const V2_TITLE = 'Draft, first pass';
  const V2_BODY = 'draft reviewed by the reviewer';

  async function seedEditedDocument(): Promise<void> {
    await sql.unsafe(`
      INSERT INTO page (origin_context, source_type, title, external_ref, embedding_model,
                        embedding_dimensions, chunker_version, normalizer_version,
                        content_sha256, deleted_at)
      VALUES ('${ORIGIN}', 'document', ${quoted(V1_TITLE)}, '${DOC}',
              'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1,
              '${contentDigest(V1_TITLE, V1_BODY)}', now());
      INSERT INTO chunk (origin_context, content, page_id, ordinal, deleted_at)
      SELECT '${ORIGIN}', ${quoted(V1_BODY)}, page_id, 0, now()
        FROM page WHERE external_ref = '${DOC}' AND deleted_at IS NOT NULL;

      INSERT INTO page (origin_context, source_type, title, external_ref, embedding_model,
                        embedding_dimensions, chunker_version, normalizer_version, content_sha256)
      VALUES ('${ORIGIN}', 'document', ${quoted(V2_TITLE)}, '${DOC}',
              'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1,
              '${contentDigest(V2_TITLE, V2_BODY)}');
      INSERT INTO chunk (origin_context, content, page_id, ordinal)
      SELECT '${ORIGIN}', ${quoted(V2_BODY)}, page_id, 0
        FROM page WHERE external_ref = '${DOC}' AND deleted_at IS NULL;
    `);

    // Through the shipped capture path, not by hand: this is what the sweep
    // that rescues a predecessor before the 72h purge actually banks.
    const swept = await captureSupersededVersions(sql, {});
    expect(swept.captured).toBe(1);
  }

  test(
    'the snapshot naming the correspondent goes, though no live page names her',
    async () => {
      await seedEditedDocument();
      const banked = (await sql`SELECT body FROM page_version WHERE doc_key = ${`${ORIGIN}|${DOC}`}`) as Array<{
        body: string;
      }>;
      expect(banked[0]?.body).toContain(SUBJECT);

      const preview = await previewSubjectErasure(sql, { identifier: SUBJECT });
      // The live page no longer carries her name, so page discovery does not
      // reach this document at all — and the history is where her mail is.
      expect(preview.matches.map((match) => match.externalRef)).not.toContain(DOC);
      expect(preview.removed.versions).toBeGreaterThan(0);

      await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });

      const rows = (await sql`SELECT doc_key, body FROM page_version`) as Array<{
        doc_key: string;
        body: string;
      }>;
      expect(rows.filter((row) => row.body.includes('alice-example'))).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and a revert cannot re-introduce her, because the snapshot is not there to re-ingest',
    async () => {
      await seedEditedDocument();
      await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });

      // `revertPage` re-ingests a snapshot body through U4 with no erased-subject
      // consult — and it cannot have one, because the tombstone stores a digest
      // and no caller can recover the identifier to hash. The property that
      // closes it is upstream: the snapshot is gone, so the revert refuses at
      // its first statement and never reaches `ingestDocument`.
      const outcome = await revertPage({ sql } as unknown as WriteContext, {
        docKey: `${ORIGIN}|${DOC}`,
        version: 1,
        grant: [ORIGIN],
        now: new Date(),
      });
      expect(outcome).toEqual({ ok: false, reason: 'not_found' });
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a snapshot of her page that does not itself name her', () => {
  const DOC = 'drive:doc2';
  const EARLIER_TITLE = 'Rollout plan, first pass';
  const EARLIER_BODY = 'the plan covers hiring, runway and the migration schedule';

  /**
   * The live page names her; the snapshot banked from an earlier state does not.
   *
   * This is the case the **document-key** arm exists for, and it is not exotic:
   * a version history is a record of a document *before* it said what it says
   * now, so the first snapshot of a page that later came to name a correspondent
   * says nothing about her at all. The text arm cannot reach it — there is
   * nothing in it to match — so if the key arm does not name it, her page is
   * removed and a copy of that document stays in the one table the 72h purge
   * cannot reach, forever.
   */
  async function seedEarlierSnapshot(): Promise<void> {
    await sql.unsafe(`
      INSERT INTO page (origin_context, source_type, title, external_ref, embedding_model,
                        embedding_dimensions, chunker_version, normalizer_version, content_sha256)
      VALUES ('${ORIGIN}', 'document', ${quoted(`Rollout plan reviewed by ${SUBJECT}`)}, '${DOC}',
              'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('c', 64));
      INSERT INTO chunk (origin_context, content, page_id, ordinal)
      SELECT '${ORIGIN}', ${quoted(`the rollout was reviewed by ${SUBJECT} in March`)}, page_id, 0
        FROM page WHERE external_ref = '${DOC}' AND deleted_at IS NULL;
    `);

    const pageId = (
      (await sql`
        SELECT page_id::text AS page_id FROM page
         WHERE external_ref = ${DOC} AND deleted_at IS NULL
      `) as Array<{ page_id: string }>
    )[0]?.page_id;
    if (pageId === undefined) throw new Error('fixture page missing');

    // Banked under the key `versions.ts` would write, through the *constructor*
    // rather than a literal: a fixture that spelled the key by hand would keep
    // passing on the day the two sides stopped agreeing about what one is.
    const key = docKeyFor({ originContext: ORIGIN, pageId, externalRef: DOC });
    await sql`
      INSERT INTO page_version (doc_key, version, page_id, origin_context, source_type,
                                title, body, content_sha256, captured_from)
      VALUES (${key}, 1, ${pageId}::bigint, ${ORIGIN}, 'document',
              ${EARLIER_TITLE}, ${EARLIER_BODY}, ${'d'.repeat(64)}, 'live')
    `;
  }

  test(
    'goes with the page, because the sweep names the key the page would have been banked under',
    async () => {
      await seedEarlierSnapshot();

      const preview = await previewSubjectErasure(sql, { identifier: SUBJECT });

      // The page is reached by the text arm, as any page naming her is.
      expect(preview.matches.map((match) => match.externalRef)).toContain(DOC);

      // And the snapshot is reached by the **page** handle rather than the text
      // one, which is the whole assertion: its own body says nothing about her.
      const snapshot = preview.rows.find(
        (row) => row.kind === 'page_version' && row.excerpt.includes(EARLIER_TITLE),
      );
      expect(snapshot).toBeDefined();
      expect(snapshot?.handle).toBe('page');

      await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });

      const left = (await sql`
        SELECT count(*)::int AS n FROM page_version WHERE title = ${EARLIER_TITLE}
      `) as Array<{ n: number }>;
      expect(left[0]?.n).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('an unreviewed proposal quoting the correspondent', () => {
  async function seedProposals(): Promise<void> {
    await sql.unsafe(`
      INSERT INTO review_queue (kind, target_ref, proposal, confidence, origin_contexts)
      VALUES ('entity_card', 'entity:1',
              'propose card: ${SUBJECT} is the rollout owner and lives in Berlin',
              0.6, ARRAY['${ORIGIN}']);
      INSERT INTO review_queue (kind, target_ref, proposal, confidence, origin_contexts,
                                state, closed_by, closed_at)
      VALUES ('commitment', 'commitment:1',
              'propose commitment: ${SUBJECT} will send the plan',
              0.7, ARRAY['${ORIGIN}'], 'applied', 'user_out_of_band', now());
      INSERT INTO review_queue (kind, target_ref, proposal, confidence, origin_contexts)
      VALUES ('fact', 'fact:9', 'propose fact: ${BYSTANDER} presented the numbers',
              0.6, ARRAY['${ORIGIN}']);
    `);
  }

  test(
    'goes, in every state — the queue has no foreign key, so nothing else ever will',
    async () => {
      await seedProposals();
      const preview = await previewSubjectErasure(sql, { identifier: SUBJECT });
      expect(preview.removed.reviewQueue).toBe(2);
      expect(preview.rows.filter((row) => row.kind === 'review_queue')).toHaveLength(2);

      await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });

      const rows = (await sql`SELECT proposal FROM review_queue`) as Array<{ proposal: string }>;
      expect(rows.map((row) => row.proposal)).toEqual([
        `propose fact: ${BYSTANDER} presented the numbers`,
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the attachment, which is where a signature and an address usually are', () => {
  async function seedAttachments(): Promise<void> {
    await sql.unsafe(`
      INSERT INTO attachment (page_id, origin_context, media_type, object_key, ocr_text)
      SELECT page_id, '${ORIGIN}', 'application/pdf', 'tenants/t/attachments/deck.pdf',
             'signed by ${SUBJECT}, home address included'
        FROM page WHERE external_ref = 'gmail:a2';
      INSERT INTO attachment (page_id, origin_context, media_type, object_key, ocr_text)
      SELECT page_id, '${ORIGIN}', 'application/pdf', 'tenants/t/attachments/scan.pdf',
             'countersigned by ${SUBJECT}'
        FROM page WHERE external_ref = 'gmail:a3';
      INSERT INTO attachment (page_id, origin_context, media_type, object_key, ocr_text)
      SELECT page_id, '${ORIGIN}', 'application/pdf', 'tenants/t/attachments/numbers.pdf',
             'quarterly numbers, presented by ${BYSTANDER}'
        FROM page WHERE external_ref = 'gmail:a3';
    `);
  }

  test(
    'the row goes — whether the page it hangs off is going or only its OCR text names her',
    async () => {
      await seedAttachments();
      const preview = await previewSubjectErasure(sql, { identifier: SUBJECT });
      expect(preview.removed.attachments).toBe(2);

      await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });

      const live = (await sql`
        SELECT object_key, ocr_text FROM attachment WHERE deleted_at IS NULL
      `) as Array<{ object_key: string; ocr_text: string }>;
      expect(live.map((row) => row.object_key)).toEqual(['tenants/t/attachments/numbers.pdf']);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and the stored object goes with it, under the key the row recorded',
    async () => {
      await seedAttachments();
      const deleted: string[] = [];
      const receipt = await eraseSubject(
        {
          sql,
          objects: {
            delete: (key) => {
              deleted.push(key);
              return Promise.resolve(true);
            },
          },
        },
        { identifier: SUBJECT, erasedBy: 'app' },
      );

      expect(deleted.sort()).toEqual([
        'tenants/t/attachments/deck.pdf',
        'tenants/t/attachments/scan.pdf',
      ]);
      expect(receipt.attachmentObjectsRemoved).toBe(2);
      expect(receipt.attachmentObjectsUnreachable).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and a run with no object store says the objects are still there rather than nothing',
    async () => {
      await seedAttachments();
      const receipt = await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app' });
      expect(receipt.attachmentObjectsRemoved).toBe(0);
      expect(receipt.attachmentObjectsUnreachable).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );
});

// ===========================================================================
// What the soft-delete idiom actually promises.
//
// This module soft-deletes so a mis-targeted erasure is recoverable, and the
// rows then ride `forget`'s existing 72h purge. That claim is only true of the
// tables the purge reaches, and this block runs the real purge rather than
// asserting the claim in prose.
// ===========================================================================

describe('the residue the purge is supposed to take, taken', () => {
  const LONG_AGO = new Date(Date.now() - 96 * 3600_000);

  test(
    'the addressing namespace and the recall vocabulary go with the entity',
    async () => {
      // `entity_alias` and `entity_slug` carry the identifier in plaintext and
      // have no `deleted_at` to set. They are not a longer-lived residue than
      // `fact.statement`: both cascade from `entity`, which the purge takes on
      // the same clock as everything else this erasure tombstoned.
      await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app', now: LONG_AGO });

      expect(await count('entity_alias', 'TRUE')).toBe(2);
      await purgeExpiredTombstones(sql, { now: new Date() });

      const aliases = (await sql`SELECT alias FROM entity_alias`) as Array<{ alias: string }>;
      expect(aliases.map((row) => row.alias)).toEqual([BYSTANDER]);
      const slugs = (await sql`SELECT slug FROM entity_slug`) as Array<{ slug: string }>;
      expect(slugs).toHaveLength(1);
      expect(slugs[0]?.slug).not.toContain('alice-example');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a commitment that hangs off no page and no fact is taken too',
    async () => {
      // The commitment this fixture's subject owns has a NULL `page_id` and a
      // NULL `fact_id` — the shape `materialize.ts` writes whenever extraction
      // could not attribute one — so no cascade reaches it. Purged by
      // `deleted_at` or her name sits in `owner_name` for the life of the brain.
      await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app', now: LONG_AGO });
      await purgeExpiredTombstones(sql, { now: new Date() });

      const rows = (await sql`SELECT owner_name FROM commitment`) as Array<{ owner_name: string }>;
      expect(rows.map((row) => row.owner_name)).toEqual([BYSTANDER]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an attachment whose OCR text named her, on a page that is staying, is taken too',
    async () => {
      await sql.unsafe(`
        INSERT INTO attachment (page_id, origin_context, media_type, object_key, ocr_text)
        SELECT page_id, '${ORIGIN}', 'application/pdf', 'tenants/t/attachments/scan.pdf',
               'countersigned by ${SUBJECT}'
          FROM page WHERE external_ref = 'gmail:a3';
      `);

      await eraseSubject({ sql }, { identifier: SUBJECT, erasedBy: 'app', now: LONG_AGO });
      await purgeExpiredTombstones(sql, { now: new Date() });

      expect(await count('attachment', 'TRUE')).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

/** A single-quoted SQL literal for the `unsafe` seeds above. */
function quoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
