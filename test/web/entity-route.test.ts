/**
 * The page built instead of the roster, and the properties that make it not one.
 *
 * ============================================================================
 * WHAT IS ACTUALLY UNDER TEST
 * ============================================================================
 *
 * The owner asked for a list of the people and companies their brain knows.
 * `src/web/coverage.ts` refuses that page in four arguments, and this one exists
 * instead — so almost every assertion here pins an *absence*. The page is only
 * defensible while these hold:
 *
 *   * **The steady state renders nothing and reads nothing.** Idle is the
 *     mechanism by which this reaches the property review reaches by draining.
 *     If the idle branch ever touched the port it would wake a suspended brain
 *     on a navigation, which the dashboard's own ruling forbids.
 *   * **A found render emits no name the querent did not supply**, except the
 *     handful of outbound neighbours. That is what the inbound/outbound split
 *     and the census-without-statements exist for, and each is asserted.
 *   * **No suggestions, ever.** A miss that offered near-matches would be a
 *     roster reached one typo at a time.
 *
 * The composition half drives the real read against a real schema, because the
 * predicates are the design: an edge with a tombstoned endpoint, an alias behind
 * a soft-deleted entity, and a name below the substring floor are each a row
 * shape a plausible wrong query returns and the right one does not.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { textArrayLiteral } from '../../src/core/write/pg-values.ts';
import { ACTIVE_EMBEDDING_SEAT } from '../../src/schema/embedding-seat.ts';
import { EMBEDDING_DIMENSIONS } from '../../src/schema/vector-index.ts';
import {
  MENTION_NAME_FLOOR,
  OUTBOUND_EDGE_CEILING,
  listEntities,
  lookupEntity,
} from '../../src/web/entity.ts';
import { ENTITY_PATH, renderPage } from '../../src/web/pages.ts';
import { ENTITY_HEADERS } from '../../src/web/app.ts';
import {
  connect as connectTenant,
  dropFixtureDatabase,
  provisionFixture,
  type SchemaFixture,
} from '../schema/fixture.ts';

const WORK = 'work:mail';
const VECTOR = `[${new Array(EMBEDDING_DIMENSIONS).fill(0).join(',')}]`;

// ---------------------------------------------------------------------------
// The render, and the absences.
// ---------------------------------------------------------------------------

/**
 * **These two tests used to assert the opposite, and that is the point.** This
 * page shipped as a resting-empty lookup on `coverage.ts`'s refusal of a roster;
 * the owner asked for the list twice and it now renders one. `entity.ts`'s
 * header records the reversal. What is asserted here is what survived it: the
 * list carries names and types and nothing else, and opening a subject still
 * posts rather than gets.
 */
describe('the roster shows who, and only who', () => {
  const ROSTER = {
    status: 'browsing' as const,
    roster: {
      entries: [
        { name: 'Acme', truncated: false, type: 'organization' as const, hasCard: true },
        { name: 'Priya Raman', truncated: false, type: 'person' as const, hasCard: false },
      ],
      total: 2,
      page: 0,
      pages: 1,
    },
  };

  test('it lists names and types, and nothing the brain says about them', () => {
    const page = renderPage({ kind: 'entity', available: true, lookup: ROSTER });
    expect(page).toContain('Acme');
    expect(page).toContain('Priya Raman');
    expect(page).toContain('has a summary');
    expect(page).toContain('no summary yet');
    // The line the detail view is on the other side of.
    expect(page).toContain('names and types only');
    // And the warning that is more load-bearing now than when it was written
    // for a one-subject page.
    expect(page).toContain('not safe to screenshot');
  });

  test('a row is a form, so no name is written into browser history', () => {
    const page = renderPage({ kind: 'entity', available: true, lookup: ROSTER });
    // A link would carry the name in a query string, into history and URL-bar
    // autocomplete, which sync across devices and outlive the session.
    expect(page).toContain('<input type="hidden" name="name" value="Priya Raman">');
    expect(page).not.toContain('href="/dashboard?view=entity&amp;name=');
    expect(page).not.toContain('method="get"');
  });

  test('paging is a GET, because a page number is not a name', () => {
    const page = renderPage({
      kind: 'entity',
      available: true,
      lookup: { status: 'browsing', roster: { ...ROSTER.roster, total: 60, page: 1, pages: 3 } },
    });
    expect(page).toContain('page=0');
    expect(page).toContain('page=2');
    expect(page).toContain('page 2 of 3');
  });

  test('an empty brain says so rather than rendering an empty list', () => {
    const page = renderPage({
      kind: 'entity',
      available: true,
      lookup: { status: 'browsing', roster: { entries: [], total: 0, page: 0, pages: 1 } },
    });
    expect(page).toContain('does not know about anybody yet');
  });

  test('a miss offers no suggestions, which would be a roster one typo at a time', () => {
    const page = renderPage({ kind: 'entity', available: true, lookup: { status: 'not_found' } });
    expect(page).toContain('Nothing in your brain answers to that name');
    expect(page).toContain('no suggestions here, deliberately');
  });

  test('ambiguity is stated without a count, a type, a name or a slug', () => {
    const page = renderPage({ kind: 'entity', available: true, lookup: { status: 'ambiguous' } });
    expect(page).toContain('More than one person or company');
    // `LIMIT 2` cannot produce a truthful count, so none is claimed; and nothing
    // in the product ever shows an owner a slug.
    expect(page).not.toContain('slug');
    expect(page).not.toMatch(/\d+ (people|companies|entities)/);
  });

  test('no port explains itself rather than answering "nothing is known"', () => {
    const page = renderPage({ kind: 'entity', available: false, lookup: null });
    expect(page).toContain('cannot read your brain');
    expect(page).toContain('which is a different');
  });

  test('the lookup page sends no referrer-policy, because it would null the Origin', () => {
    // **A production bug, pinned.** Under `Referrer-Policy: no-referrer` a
    // browser sets the `Origin` header of a NON-GET request to the literal
    // `null` — Fetch's "append a request Origin header" step switches on the
    // referrer policy and `no-referrer` is the arm that nulls it. This page's
    // whole interaction is a same-origin form POST, and `sameOriginRefusal`
    // compares that header against this origin, so the stricter header refused
    // every lookup with "this request came from another origin".
    //
    // Asserted on the handler's header set rather than the markup, because that
    // is where the mistake was and where it would come back: somebody adding
    // "the stricter statement for the one page that renders a third party" is a
    // very reasonable-looking change.
    expect(ENTITY_HEADERS).toEqual({ 'cache-control': 'no-store' });
  });

  test('the path is idle by construction — it names no subject', () => {
    expect(ENTITY_PATH).toBe('/dashboard?view=entity');
  });
});

// ---------------------------------------------------------------------------
// The read.
// ---------------------------------------------------------------------------

describe('the read that is actually wired', () => {
  let sql: SQL;
  let schema: SchemaFixture;

  beforeAll(async () => {
    schema = await provisionFixture('entityroute');
    sql = connectTenant(schema);
  }, 180_000);

  afterAll(async () => {
    await sql?.close();
    if (schema !== undefined) await dropFixtureDatabase(schema);
  });

  afterEach(async () => {
    await sql.unsafe(`
      DELETE FROM entity_edge;
      DELETE FROM entity_card;
      DELETE FROM entity_alias;
      DELETE FROM entity_slug;
      DELETE FROM entity;
      DELETE FROM fact;
    `);
  });

  async function entity(name: string, type = 'person', deleted = false): Promise<string> {
    const rows = (await sql.unsafe(
      `INSERT INTO entity (canonical_name, entity_type, origin_contexts, deleted_at)
       VALUES ($1, $2, $3::text[], $4::timestamptz) RETURNING entity_id::text AS id`,
      [name, type, textArrayLiteral([WORK]), deleted ? new Date().toISOString() : null],
    )) as Array<{ id: string }>;
    const id = rows[0]?.id ?? '';
    await sql.unsafe(
      `INSERT INTO entity_alias (entity_id, alias, alias_source, confidence, origin_contexts)
       VALUES ($1::bigint, $2, 'inferred', 0.9, $3::text[])`,
      [id, name.toLowerCase(), textArrayLiteral([WORK])],
    );
    return id;
  }

  async function fact(statement: string): Promise<void> {
    await sql.unsafe(
      `INSERT INTO fact (statement, ${ACTIVE_EMBEDDING_SEAT.column}, origin_contexts, trust_level)
       VALUES ($1, $2::vector, $3::text[], 'model_extracted')`,
      [statement, VECTOR, textArrayLiteral([WORK])],
    );
  }

  test('the roster pages, alphabetically, with a stable total', async () => {
    for (const name of ['Zeta', 'alpha', 'Mid']) await entity(name);
    const first = await listEntities(sql, 0);
    expect(first.total).toBe(3);
    expect(first.pages).toBe(1);
    // `lower()` ordering, so case does not scatter the list.
    expect(first.entries.map((e) => e.name)).toEqual(['alpha', 'Mid', 'Zeta']);
  });

  test('a page past the end lands on the last one rather than rendering empty', async () => {
    await entity('Only');
    const far = await listEntities(sql, 99);
    expect(far.page).toBe(0);
    expect(far.entries.length).toBe(1);
  });

  test('a soft-deleted entity is not in the roster', async () => {
    await entity('Visible');
    await entity('Gone', 'person', true);
    const page = await listEntities(sql, 0);
    expect(page.total).toBe(1);
    expect(page.entries.map((e) => e.name)).toEqual(['Visible']);
  });

  test('the roster reports whether a summary exists, never its text', async () => {
    const id = await entity('Priya Raman');
    await sql.unsafe(
      `INSERT INTO entity_card (entity_id, summary, trust_level, derivation, confidence, origin_contexts)
       VALUES ($1::bigint, 'Leads the renewal desk.', 'model_inferred', 'model_derived', 0.9, $2::text[])`,
      [id, textArrayLiteral([WORK])],
    );
    const page = await listEntities(sql, 0);
    expect(page.entries[0]?.hasCard).toBe(true);
    // A boolean crosses, the prose does not.
    expect(JSON.stringify(page)).not.toContain('renewal desk');
  });

  test('an exact name resolves; a near miss does not', async () => {
    await entity('Priya Raman');
    expect((await lookupEntity(sql, 'Priya Raman')).status).toBe('found');
    // No prefix, no trigram, no LIKE anywhere on this page.
    expect((await lookupEntity(sql, 'Priya')).status).toBe('not_found');
    expect((await lookupEntity(sql, '   ')).status).toBe('not_found');
  });

  test('a soft-deleted entity is gone, even though its alias row survives', async () => {
    // `entity_alias` carries no `deleted_at` and holds the name in plaintext —
    // it goes when the purge takes the entity. Without the live join an erased
    // correspondent renders for the whole 72 hours before that.
    await entity('Gone Person', 'person', true);
    expect((await lookupEntity(sql, 'Gone Person')).status).toBe('not_found');
  });

  test('two subjects answering to one name render ambiguous, not the first one', async () => {
    await sql.unsafe(
      `INSERT INTO entity (canonical_name, entity_type, origin_contexts)
       VALUES ('Acme', 'organization', $1::text[]), ('acme', 'organization', $1::text[])`,
      [textArrayLiteral([WORK])],
    );
    expect((await lookupEntity(sql, 'Acme')).status).toBe('ambiguous');
  });

  test('inbound edges are counted by declared inverse and never named', async () => {
    const acme = await entity('Acme', 'organization');
    const a = await entity('Ann');
    const b = await entity('Bo');
    for (const person of [a, b]) {
      await sql.unsafe(
        `INSERT INTO entity_edge (subject_entity_id, object_entity_id, edge_type, origin_contexts)
         VALUES ($1::bigint, $2::bigint, 'works_at', $3::text[])`,
        [person, acme, textArrayLiteral([WORK])],
      );
    }
    const found = await lookupEntity(sql, 'Acme');
    if (found.status !== 'found') throw new Error('expected found');
    // The whole colleague-roster refusal, in one assertion.
    expect(found.subject.outbound.length).toBe(0);
    expect(found.subject.inbound).toEqual([{ type: 'employs', count: 2 }]);
    const rendered = renderPage({ kind: 'entity', available: true, lookup: found });
    expect(rendered).not.toContain('Ann');
    expect(rendered).not.toContain('Bo<');
  });

  test('an edge with a tombstoned endpoint is in neither arm', async () => {
    const acme = await entity('Acme', 'organization');
    const gone = await entity('Severed Person', 'person', true);
    // Severance writes no `deleted_at` on `entity_edge`: it relies on both
    // endpoints being tombstoned and the row leaving at purge by cascade. So
    // between severance and purge the edge is live with a dead endpoint.
    await sql.unsafe(
      `INSERT INTO entity_edge (subject_entity_id, object_entity_id, edge_type, origin_contexts)
       VALUES ($1::bigint, $2::bigint, 'works_at', $3::text[])`,
      [gone, acme, textArrayLiteral([WORK])],
    );
    const found = await lookupEntity(sql, 'Acme');
    if (found.status !== 'found') throw new Error('expected found');
    expect(found.subject.inbound).toEqual([]);
  });

  test('outbound names its neighbour, and the ceiling is a real bound', async () => {
    const subject = await entity('Ann');
    for (let i = 0; i < OUTBOUND_EDGE_CEILING + 2; i++) {
      const other = await entity(`Org ${i}`, 'organization');
      await sql.unsafe(
        `INSERT INTO entity_edge (subject_entity_id, object_entity_id, edge_type, origin_contexts)
         VALUES ($1::bigint, $2::bigint, 'part_of', $3::text[])`,
        [subject, other, textArrayLiteral([WORK])],
      );
    }
    const found = await lookupEntity(sql, 'Ann');
    if (found.status !== 'found') throw new Error('expected found');
    expect(found.subject.outbound.length).toBe(OUTBOUND_EDGE_CEILING);
    expect(found.subject.outboundOverflowed).toBe(true);
  });

  test('the census counts sentences and renders none of them', async () => {
    await entity('Priya Raman');
    await fact('Priya Raman confirmed the renewal, and so did Bob Other.');
    await fact('Nothing to do with anyone.');
    const found = await lookupEntity(sql, 'Priya Raman');
    if (found.status !== 'found') throw new Error('expected found');
    if (found.subject.mentions.kind !== 'counted') throw new Error('expected a census');
    expect(found.subject.mentions.total).toBe(1);
    expect(found.subject.mentions.byTrust).toEqual([{ level: 'model_extracted', count: 1 }]);

    const rendered = renderPage({ kind: 'entity', available: true, lookup: found });
    // The statement names a third party. Rendering it would put people the
    // querent never asked about onto the page.
    expect(rendered).not.toContain('Bob Other');
    expect(rendered).not.toContain('confirmed the renewal');
    expect(rendered).toContain('not everything it knows about them');
  });

  test('the census matches at word boundaries, not as a substring', async () => {
    await entity('Al');
    await entity('Ann');
    await fact('The legal renewal in Alberta is done.');
    const al = await lookupEntity(sql, 'Al');
    if (al.status !== 'found') throw new Error('expected found');
    // Two characters is below the floor: a short name is a substring, and the
    // page says so rather than printing a number it cannot stand behind.
    expect(al.subject.mentions.kind).toBe('name_too_short');
    expect('Al'.length).toBeLessThan(MENTION_NAME_FLOOR);

    const ann = await lookupEntity(sql, 'Ann');
    if (ann.status !== 'found') throw new Error('expected found');
    if (ann.subject.mentions.kind !== 'counted') throw new Error('expected a census');
    // `\m…\M` is what keeps Ann out of "renewal" and "Alberta".
    expect(ann.subject.mentions.total).toBe(0);
  });

  test('a card renders with its provenance, and its absence is its own sentence', async () => {
    const id = await entity('Priya Raman');
    let found = await lookupEntity(sql, 'Priya Raman');
    if (found.status !== 'found') throw new Error('expected found');
    expect(found.subject.card).toBeNull();
    expect(renderPage({ kind: 'entity', available: true, lookup: found })).toContain(
      'has not written a summary',
    );

    await sql.unsafe(
      `INSERT INTO entity_card (entity_id, summary, trust_level, derivation, confidence, origin_contexts)
       VALUES ($1::bigint, 'Leads the renewal desk.', 'model_inferred', 'model_derived', 0.9, $2::text[])`,
      [id, textArrayLiteral([WORK])],
    );
    found = await lookupEntity(sql, 'Priya Raman');
    if (found.status !== 'found') throw new Error('expected found');
    expect(found.subject.card?.summary).toBe('Leads the renewal desk.');
    const rendered = renderPage({ kind: 'entity', available: true, lookup: found });
    expect(rendered).toContain('Leads the renewal desk.');
    // Model output derived from a stranger's mail is quoted, never presented as
    // the product's own voice.
    expect(rendered).toContain('class="quoted"');
    expect(rendered).toContain('not checked by anyone');
  });
});
