/**
 * Entities, their two naming primitives, and edge reconciliation.
 *
 * **Two primitives, not one.** `entity_slug` is the addressing namespace, where
 * a redirect and a canonical slug share a primary key so a redirect cannot
 * shadow a live entity. `entity_alias` is recall vocabulary, deliberately not
 * unique across entities because two people really are called Mike. The write
 * path has to populate both, and populate them differently.
 *
 * **Reconcile, not accumulate.** The ledger row `imp.link-reconciliation` says
 * edges must be *removed* when they stop being stated, and the schema gives
 * edges no page provenance to remove them by — so edges here are a deterministic
 * **projection of the live facts**. Editing a page re-extracts it, and an edge
 * that no live fact anywhere still implies is tombstoned. That is what keeps an
 * edge attested by two pages alive when one of them drops it, which a
 * page-scoped delete would get wrong in the other direction.
 *
 * **Origin widening is a new row, because the database says so.** R15 makes
 * `origin_contexts` immutable and the trigger's own hint names the mechanism: a
 * row whose origin would change is a different row. So an entity first seen
 * under one credential and re-mentioned under another is *superseded* — new row
 * carrying the union, slug and aliases moved onto it, live edges rewritten,
 * old row tombstoned. Anything less either fails the trigger or leaves an
 * entity narrower than the rows it descends from, which is knowledge escaping
 * its source's fence.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  findEntityByName,
  reconcileEdges,
  resolveOrCreateEntity,
} from '../../../src/core/write/links.ts';
import { normalize, slugify } from '../../../src/core/write/normalize.ts';
import { ingestDocument, remember } from '../../../src/core/write/write-path.ts';
import {
  CALLER,
  TENANT,
  createGateway,
  createTenantFixture,
  uncappedBudget,
  type TenantFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

let tenant: TenantFixture;

beforeAll(async () => {
  tenant = await createTenantFixture('writelinks');
}, { timeout: SETUP_TIMEOUT_MS });

afterAll(async () => {
  if (tenant !== undefined) await tenant.close();
}, { timeout: SETUP_TIMEOUT_MS });

function context() {
  return {
    sql: tenant.sql,
    gateway: createGateway().gateway,
    tenantId: TENANT,
    caller: CALLER,
    budget: uncappedBudget(),
  };
}

async function reset(): Promise<void> {
  await tenant.sql.unsafe(`
    DELETE FROM entity_edge;
    DELETE FROM contradiction_report;
    DELETE FROM fact_source;
    DELETE FROM fact;
    DELETE FROM entity_alias;
    DELETE FROM entity_slug;
    DELETE FROM entity;
    DELETE FROM chunk;
    DELETE FROM page;
  `);
}

async function write(options: {
  readonly origin: string;
  readonly ref: string;
  readonly body: string;
}) {
  return ingestDocument(context(), {
    originContext: options.origin,
    sourceType: 'document',
    title: null,
    body: options.body,
    externalRef: options.ref,
  });
}

/** `remember`, which writes its own page and has no external ref to edit. */
async function say(statement: string, origin = 'personal') {
  return remember(context(), { originContext: origin, statement });
}

async function liveEdges(): Promise<Array<{ subject: string; type: string; object: string }>> {
  const rows = (await tenant.sql`
    SELECT s.canonical_name AS subject, e.edge_type AS type, o.canonical_name AS object
      FROM entity_edge e
      JOIN entity s ON s.entity_id = e.subject_entity_id
      JOIN entity o ON o.entity_id = e.object_entity_id
     WHERE e.deleted_at IS NULL
     ORDER BY 1, 2, 3
  `) as Array<{ subject: string; type: string; object: string }>;
  return rows;
}

async function liveEntities(): Promise<Array<{ name: string; origins: string[]; slug: string }>> {
  const rows = (await tenant.sql`
    SELECT e.canonical_name AS name, e.origin_contexts AS origins, s.slug
      FROM entity e
      LEFT JOIN entity_slug s ON s.entity_id = e.entity_id AND s.kind = 'canonical'
     WHERE e.deleted_at IS NULL
     ORDER BY 1
  `) as Array<{ name: string; origins: string[]; slug: string }>;
  return rows;
}

describe('entities are addressed by slug and recalled by alias', () => {
  test('a first mention creates the entity, one canonical slug and an alias', async () => {
    await reset();
    await write({
      origin: 'personal',
      ref: 'doc-1',
      body: 'Samantha Okonkwo is the head of platform at Verdant Systems.',
    });

    const entities = await liveEntities();
    expect(entities.map((entity) => entity.name).sort()).toEqual([
      'Samantha Okonkwo',
      'Verdant Systems',
    ]);
    for (const entity of entities) expect(entity.slug).toBe(slugify(entity.name));

    const aliases = (await tenant.sql`
      SELECT alias, alias_source FROM entity_alias ORDER BY alias
    `) as Array<{ alias: string; alias_source: string }>;
    // Aliases are stored normalized, because the read path looks them up with
    // the same normalizer. Storing the surface form is the drift the plan names.
    expect(aliases.map((row) => row.alias)).toEqual([
      normalize('Samantha Okonkwo'),
      normalize('Verdant Systems'),
    ]);
    for (const row of aliases) expect(row.alias_source).toBe('inferred');
  }, TEST_TIMEOUT_MS);

  test('a second spelling resolves to the same entity rather than creating one', async () => {
    // Curly apostrophe on the way in, ASCII on the way back: the normalizer's
    // named failure, exercised through the write path rather than in isolation.
    await reset();
    await write({ origin: 'personal', ref: 'doc-a', body: "O'Brien Systems is based in Lisbon." });
    await write({ origin: 'personal', ref: 'doc-b', body: 'O’Brien Systems is based in Porto.' });

    const named = (await liveEntities()).filter((entity) =>
      normalize(entity.name).startsWith("o'brien"),
    );
    expect(named).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  test('one entity has exactly one canonical slug', async () => {
    const rows = (await tenant.sql`
      SELECT entity_id::text AS id, count(*)::int AS n
        FROM entity_slug WHERE kind = 'canonical' GROUP BY 1 HAVING count(*) > 1
    `) as Array<{ id: string; n: number }>;
    expect(rows).toEqual([]);
  }, TEST_TIMEOUT_MS);

  test('two entities may share an alias — aliases are not an addressing namespace', async () => {
    await reset();
    await write({ origin: 'personal', ref: 'doc-c', body: 'Mike Ashford founded Kettle Works.' });
    await write({ origin: 'personal', ref: 'doc-d', body: 'Mike Trelawney founded Windbreak Ltd.' });

    // Both are addressable, both distinct: the slug namespace disambiguates
    // what the alias vocabulary deliberately does not.
    const slugs = (await tenant.sql`
      SELECT slug FROM entity_slug WHERE kind = 'canonical' ORDER BY slug
    `) as Array<{ slug: string }>;
    expect(new Set(slugs.map((row) => row.slug)).size).toBe(slugs.length);

    const inserted = await tenant.sql`
      INSERT INTO entity_alias (entity_id, alias, alias_source, confidence)
      SELECT entity_id, 'mike', 'inferred', 0.4 FROM entity WHERE deleted_at IS NULL
      RETURNING alias_id
    `;
    expect((inserted as unknown[]).length).toBeGreaterThan(1);
  }, TEST_TIMEOUT_MS);

  test('a slug collision with a live entity is refused by the namespace, not resolved silently', async () => {
    const rows = (await tenant.sql`
      SELECT slug, entity_id::text AS id FROM entity_slug WHERE kind = 'canonical' LIMIT 1
    `) as Array<{ slug: string; id: string }>;
    const existing = rows[0];
    expect(existing).toBeDefined();

    let refused = false;
    try {
      await tenant.sql`
        INSERT INTO entity_slug (slug, entity_id, kind)
        VALUES (${existing?.slug ?? ''}, ${existing?.id ?? ''}::bigint, 'redirect')
      `;
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  }, TEST_TIMEOUT_MS);
});

describe('a redirect resolves to the entity it points at', () => {
  test('an entity reached through a redirect slug is not created a second time', async () => {
    // The two primitives, exercised on the half nothing else reaches: a
    // redirect shares the addressing namespace with canonical slugs, so it must
    // resolve like one. If it did not, renaming an entity would silently fork
    // it — the old address creating a duplicate on the next mention.
    await reset();
    await write({ origin: 'personal', ref: 'redir-1', body: 'Marcus Fell founded Kettle Works.' });

    const rows = (await tenant.sql`
      SELECT entity_id::text AS id FROM entity_slug
       WHERE slug = ${slugify('Kettle Works')} AND kind = 'canonical'
    `) as Array<{ id: string }>;
    const entityId = rows[0]?.id;
    expect(entityId).toBeDefined();

    await tenant.sql`
      INSERT INTO entity_slug (slug, entity_id, kind)
      VALUES ('kettle-works-old', ${entityId ?? ''}::bigint, 'redirect')
    `;

    const resolved = await findEntityByName(tenant.sql, 'kettle works old');
    expect(resolved?.entityId).toBe(entityId ?? '');

    const before = await liveEntities();
    await resolveOrCreateEntity(tenant.sql, {
      name: 'kettle-works-old',
      type: 'organization',
      origins: ['personal'],
      taxonomyVersion: 1,
    });
    expect((await liveEntities()).length).toBe(before.length);
  }, TEST_TIMEOUT_MS);
});

describe('origin widening writes a new row rather than mutating an immutable one', () => {
  test('an entity re-mentioned under a second credential carries both origins', async () => {
    await reset();
    await write({
      origin: 'personal',
      ref: 'personal-1',
      body: 'Marcus Fell founded Kettle Works.',
    });
    await write({
      origin: 'work',
      ref: 'work-1',
      body: 'Kettle Works is based in Lisbon.',
    });

    const kettle = (await liveEntities()).find((entity) => entity.name === 'Kettle Works');
    expect(kettle).toBeDefined();
    expect([...(kettle?.origins ?? [])].sort()).toEqual(['personal', 'work']);
  }, TEST_TIMEOUT_MS);

  test('the widened entity keeps its address and the old row is tombstoned', async () => {
    const slug = slugify('Kettle Works');
    const rows = (await tenant.sql`
      SELECT e.deleted_at IS NULL AS live, e.origin_contexts AS origins
        FROM entity_slug s JOIN entity e ON e.entity_id = s.entity_id
       WHERE s.slug = ${slug} AND s.kind = 'canonical'
    `) as Array<{ live: boolean; origins: string[] }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.live).toBe(true);
    expect([...(rows[0]?.origins ?? [])].sort()).toEqual(['personal', 'work']);

    const tombstoned = (await tenant.sql`
      SELECT count(*)::int AS n FROM entity WHERE deleted_at IS NOT NULL
    `) as Array<{ n: number }>;
    expect(tombstoned[0]?.n).toBeGreaterThan(0);
  }, TEST_TIMEOUT_MS);

  test('edges follow the widened entity and carry the wider union', async () => {
    const rows = (await tenant.sql`
      SELECT e.origin_contexts AS edge_origins,
             s.origin_contexts AS subject_origins,
             o.origin_contexts AS object_origins,
             s.deleted_at IS NULL AS subject_live,
             o.deleted_at IS NULL AS object_live
        FROM entity_edge e
        JOIN entity s ON s.entity_id = e.subject_entity_id
        JOIN entity o ON o.entity_id = e.object_entity_id
       WHERE e.deleted_at IS NULL
    `) as Array<{
      edge_origins: string[];
      subject_origins: string[];
      object_origins: string[];
      subject_live: boolean;
      object_live: boolean;
    }>;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // A live edge pointing at a tombstoned entity is a graph walk into a row
      // nothing else can reach.
      expect(row.subject_live).toBe(true);
      expect(row.object_live).toBe(true);
      for (const origin of [...row.subject_origins, ...row.object_origins]) {
        expect(row.edge_origins).toContain(origin);
      }
    }
  }, TEST_TIMEOUT_MS);
});

describe('editing a page removes the edges it no longer states', () => {
  test('an edge stated by one page disappears when that page stops stating it', async () => {
    await reset();
    await write({
      origin: 'personal',
      ref: 'edit-1',
      body: 'Samantha Okonkwo is the head of platform at Verdant Systems.',
    });
    expect(await liveEdges()).toEqual([
      { subject: 'Samantha Okonkwo', type: 'works_at', object: 'Verdant Systems' },
    ]);

    await write({
      origin: 'personal',
      ref: 'edit-1',
      body: 'Nothing about anyone at all, just a paragraph of prose.',
    });
    // Accumulating rather than reconciling leaves this edge behind, and "who
    // does Samantha work with" answers with a job she no longer has.
    expect(await liveEdges()).toEqual([]);
  }, TEST_TIMEOUT_MS);

  test('an edge two pages state survives one of them dropping it', async () => {
    await reset();
    await write({
      origin: 'personal',
      ref: 'both-1',
      body: 'Samantha Okonkwo is the head of platform at Verdant Systems.',
    });
    await write({
      origin: 'work',
      ref: 'both-2',
      body: 'Samantha Okonkwo is the head of platform at Verdant Systems.',
    });
    expect(await liveEdges()).toHaveLength(1);

    await write({ origin: 'personal', ref: 'both-1', body: 'A paragraph about nothing much.' });
    // Still attested by the second page — a page-scoped delete would be wrong
    // in the other direction, and this is the assertion that says so.
    expect(await liveEdges()).toHaveLength(1);

    await write({ origin: 'work', ref: 'both-2', body: 'Also a paragraph about nothing much.' });
    expect(await liveEdges()).toEqual([]);
  }, TEST_TIMEOUT_MS);

  test('it survives when the page that still states it typed the name differently', async () => {
    // The test above states the claim with byte-identical typography on both
    // pages, so it never exercises the question this module is built around:
    // aliases are stored **normalized** and statements are stored **raw**, and
    // "is this edge still implied" compares one against the other.
    //
    // Two pages, one claim, one keystroke apart — the first typed on a
    // keyboard, the second arriving through a mail client that substitutes
    // U+2019. `normalize` folds them to one key, which is the whole reason both
    // resolve to a single entity rather than creating two. Reconciliation has to
    // fold them the same way, or dropping the ASCII page silently deletes an
    // edge the curly page still states, and "who does Ronan work with" answers
    // with nothing the moment an unrelated page is edited.
    await reset();
    await write({
      origin: 'personal',
      ref: 'quote-1',
      body: "Ronan O'Brien joined Verdant Systems.",
    });
    await write({
      origin: 'work',
      ref: 'quote-2',
      body: 'Ronan O’Brien joined Verdant Systems.',
    });
    // One entity, one edge: the normalizer already did its job on the write side.
    expect(await liveEdges()).toHaveLength(1);
    expect((await liveEntities()).map((entity) => entity.name).sort()).toEqual([
      "Ronan O'Brien",
      'Verdant Systems',
    ]);

    await write({ origin: 'personal', ref: 'quote-1', body: 'A paragraph about nothing much.' });
    expect(await liveEdges()).toHaveLength(1);

    await write({ origin: 'work', ref: 'quote-2', body: 'Also a paragraph about nothing much.' });
    expect(await liveEdges()).toEqual([]);
  }, TEST_TIMEOUT_MS);

  test('running out of scan keeps the edge rather than deleting it', async () => {
    // Nothing links a fact to an edge — that is the schema's choice and the
    // reason edges are recomputed rather than page-deleted — so "is this still
    // implied" is a scan, and a scan on a large brain has to stop somewhere.
    // What matters is which way it fails when it does. Keeping an unproven edge
    // is a stale answer the next edit reconsiders; deleting one is knowledge
    // gone, from a write that never looked at the page still asserting it. Both
    // arms are driven here on identical state, so "gave up" cannot quietly
    // become "found nothing".
    const statement = 'Samantha Okonkwo is the head of platform at Verdant Systems.';
    await reset();
    await write({ origin: 'personal', ref: 'scan-1', body: statement });
    expect(await liveEdges()).toHaveLength(1);

    // Nothing live states it any more, so an exhaustive scan would remove it.
    await tenant.sql`UPDATE fact SET deleted_at = now()`;

    const request = {
      facts: [],
      previousStatements: [statement],
      origins: ['personal'],
      taxonomyVersion: 1,
    };

    const gaveUp = await reconcileEdges(tenant.sql, { ...request, scanLimit: 0 });
    expect(gaveUp.removed).toBe(0);
    expect(await liveEdges()).toHaveLength(1);

    const looked = await reconcileEdges(tenant.sql, request);
    expect(looked.removed).toBe(1);
    expect(await liveEdges()).toEqual([]);
  }, TEST_TIMEOUT_MS);

  test('leaving a job removes the employment edge without deleting the entities', async () => {
    await reset();
    await write({ origin: 'personal', ref: 'job-1', body: 'Dana Whitlock joined Northwind Labs.' });
    expect(await liveEdges()).toEqual([
      { subject: 'Dana Whitlock', type: 'works_at', object: 'Northwind Labs' },
    ]);

    await write({ origin: 'personal', ref: 'job-1', body: 'Dana Whitlock left Northwind Labs.' });
    expect(await liveEdges()).toEqual([]);
    expect((await liveEntities()).map((entity) => entity.name).sort()).toEqual([
      'Dana Whitlock',
      'Northwind Labs',
    ]);
  }, TEST_TIMEOUT_MS);

  test('correcting a claim through remember retires the edge it replaced', async () => {
    // The page-edit path is not the only way a claim changes. `remember` writes
    // a *new* page, so nothing about the old page is being rewritten — the only
    // signal that the old edge is stale is the supersession itself. Without
    // that, "who does Samantha work with" answers with both jobs immediately
    // after the user corrected it, which is the scenario the reconciliation
    // ledger row names.
    await reset();
    await say('Samantha Okonkwo is the head of platform at Verdant Systems.');
    expect(await liveEdges()).toEqual([
      { subject: 'Samantha Okonkwo', type: 'works_at', object: 'Verdant Systems' },
    ]);

    const corrected = await say('Samantha Okonkwo is the head of platform at Northwind Labs.');
    expect(corrected.ok === true ? corrected.status : '').toBe('superseded');
    expect(await liveEdges()).toEqual([
      { subject: 'Samantha Okonkwo', type: 'works_at', object: 'Northwind Labs' },
    ]);
  }, TEST_TIMEOUT_MS);

  test('leaving a job through remember supersedes it and removes the edge', async () => {
    // The frozen contract's own worked example: "X at acme-example" → "X left
    // acme-example". Same entity, same kind, different text — the object is the
    // same company, which is exactly why the rule is stated on the text and not
    // on the value.
    await reset();
    await say('Dana Whitlock joined Northwind Labs.');
    expect(await liveEdges()).toEqual([
      { subject: 'Dana Whitlock', type: 'works_at', object: 'Northwind Labs' },
    ]);

    const departure = await say('Dana Whitlock left Northwind Labs.');
    expect(departure.ok === true ? departure.status : '').toBe('superseded');
    expect(await liveEdges()).toEqual([]);
  }, TEST_TIMEOUT_MS);

  test('a symmetric edge between the SAME pair is one row, stated either way round', async () => {
    // The orientation has to be exercised on one pair, not on two different
    // ones: `related_to` declares itself as its own inverse, so two rows for it
    // are the two halves of one relationship that can then disagree — which is
    // the state the schema's involution rule exists to make unreachable.
    await reset();
    await write({
      origin: 'personal',
      ref: 'sym-1',
      body: 'Kettle Works acquired Windbreak Ltd.',
    });
    expect(await liveEdges()).toHaveLength(1);

    await write({
      origin: 'personal',
      ref: 'sym-2',
      body: 'Windbreak Ltd acquired Kettle Works.',
    });

    const symmetric = (await liveEdges()).filter((edge) => edge.type === 'related_to');
    expect(symmetric).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  test('a symmetric edge across different pairs is still one row per pair', async () => {
    await reset();
    await write({ origin: 'personal', ref: 'sym-3', body: 'Marcus Fell founded Kettle Works.' });
    await write({ origin: 'personal', ref: 'sym-4', body: 'Kettle Works is based in Lisbon.' });

    const edges = await liveEdges();
    const symmetric = edges.filter((edge) => edge.type === 'related_to');
    const pairs = symmetric.map((edge) => [edge.subject, edge.object].sort().join('|'));
    expect(new Set(pairs).size).toBe(symmetric.length);
  }, TEST_TIMEOUT_MS);

  test('an edge is never a self-loop even when a sentence names one thing twice', async () => {
    await reset();
    await write({ origin: 'personal', ref: 'self-1', body: 'Kettle Works acquired Kettle Works.' });
    expect(await liveEdges()).toEqual([]);
  }, TEST_TIMEOUT_MS);
});
