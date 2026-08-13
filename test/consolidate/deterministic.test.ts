/**
 * The free half of the cycle, phase by phase.
 *
 * Each of these runs on a real tenant database because each of them is mostly
 * SQL, and because the two that could do real damage — collapsing facts and
 * removing edges — are only safe by virtue of predicates the database enforces.
 *
 * **The recurring shape is "improves without destroying".** Every phase here is
 * a deletion or a supersession of something, so each test asserts both halves:
 * the thing that should go, went; and the thing that must survive, survived. A
 * dedup pass that collapsed everything would satisfy the first assertion alone.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  clusterByEmbedding,
  collapseDuplicateFacts,
  computeDeterministicSalience,
  markStaleness,
  mergeEntitiesByRule,
  reconcileAllEdges,
} from '../../src/worker/consolidate/deterministic.ts';
import {
  countRows,
  createTenantFixture,
  seedFact,
  seedPage,
  type TenantFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;

let tenant: TenantFixture;

beforeEach(async () => {
  tenant = await createTenantFixture('determ');
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  await tenant?.close();
}, SETUP_TIMEOUT_MS);

describe('dedup', () => {
  test(
    'collapses the same claim from the same credential and keeps the oldest',
    async () => {
      const { sql } = tenant;
      const first = await seedFact(sql, {
        statement: 'Ronan Whitfield joined Verdant Systems.',
        origins: ['personal:mail'],
      });
      const second = await seedFact(sql, {
        // Same claim, a mail client's punctuation. The normalizer is what makes
        // these one claim; byte equality would miss it.
        statement: 'Ronan Whitfield joined Verdant Systems. ',
        origins: ['personal:mail'],
      });
      await seedFact(sql, {
        statement: 'Ronan Whitfield joined Trieste Roasters.',
        origins: ['personal:mail'],
      });

      const result = await collapseDuplicateFacts(sql);
      expect(result.collapsed).toBe(1);

      const rows = (await sql`
        SELECT fact_id::text AS fact_id, superseded_by::text AS superseded_by FROM fact ORDER BY fact_id
      `) as Array<{ fact_id: string; superseded_by: string | null }>;
      const byId = new Map(rows.map((row) => [row.fact_id, row.superseded_by]));
      // The survivor is the earliest row; the duplicate points at it rather than
      // being deleted, so the chain is auditable.
      expect(byId.get(first)).toBeNull();
      expect(byId.get(second)).toBe(first);
      expect(await countRows(sql, 'fact', 'superseded_by IS NULL')).toBe(2);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'never collapses across credentials — that would discard an attestation R12a needs',
    async () => {
      const { sql } = tenant;
      await seedFact(sql, {
        statement: 'Ronan Whitfield joined Verdant Systems.',
        origins: ['personal:mail'],
      });
      await seedFact(sql, {
        statement: 'Ronan Whitfield joined Verdant Systems.',
        origins: ['work:calendar'],
      });

      const result = await collapseDuplicateFacts(sql);
      expect(result.collapsed).toBe(0);
      expect(await countRows(sql, 'fact', 'superseded_by IS NULL')).toBe(2);
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('link reconciliation', () => {
  test(
    'removes an edge no live fact implies and keeps one that is still stated',
    async () => {
      const { sql } = tenant;
      const page = await seedPage(sql, {
        origin: 'personal:mail',
        sourceType: 'email',
        title: 'thread',
        body: 'Ronan Whitfield joined Verdant Systems.',
      });
      await seedFact(sql, {
        statement: 'Ronan Whitfield joined Verdant Systems.',
        origins: ['personal:mail'],
        pageId: page.pageId,
        chunkIds: page.chunkIds,
        confidence: 0.8,
      });
      // An entity pair whose supporting fact is gone — the residue an unreconciled
      // write path leaves behind.
      await sql.unsafe(`
        INSERT INTO entity (canonical_name, entity_type, origin_contexts)
        VALUES ('Dana Ilves', 'person', ARRAY['personal:mail']),
               ('Trieste Roasters', 'organization', ARRAY['personal:mail']);
        INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts)
        SELECT (SELECT entity_id FROM entity WHERE canonical_name = 'Dana Ilves'),
               'works_at',
               (SELECT entity_id FROM entity WHERE canonical_name = 'Trieste Roasters'),
               ARRAY['personal:mail'];
      `);

      const before = await countRows(sql, 'entity_edge', 'deleted_at IS NULL');
      expect(before).toBe(1);

      const result = await reconcileAllEdges(sql, { taxonomyVersion: 1 });
      expect(result.removed).toBe(1);
      expect(result.added).toBe(1);

      const live = (await sql`
        SELECT e.edge_type, s.canonical_name AS subject, o.canonical_name AS object
          FROM entity_edge e
          JOIN entity s ON s.entity_id = e.subject_entity_id
          JOIN entity o ON o.entity_id = e.object_entity_id
         WHERE e.deleted_at IS NULL
      `) as Array<{ edge_type: string; subject: string; object: string }>;
      expect(live).toEqual([
        { edge_type: 'works_at', subject: 'Ronan Whitfield', object: 'Verdant Systems' },
      ]);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'an edge this projection could not have produced is left alone',
    async () => {
      const { sql } = tenant;
      await seedFact(sql, {
        statement: 'Ronan Whitfield joined Verdant Systems.',
        origins: ['personal:mail'],
        confidence: 0.8,
      });
      // The shape U9 is about to add: an edge derived from connector metadata —
      // an attendee join, a sender/recipient pair — that no deterministic
      // statement implies. Whole-graph reconciliation is stronger than the write
      // path's page-scoped one and would delete every one of these on the first
      // cycle after they were written.
      await sql.unsafe(`
        INSERT INTO entity (canonical_name, entity_type, origin_contexts) VALUES
          ('Dana Ilves', 'person', ARRAY['personal:mail']),
          ('Trieste Roasters', 'organization', ARRAY['personal:mail']);
        INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts, derivation)
        SELECT (SELECT entity_id FROM entity WHERE canonical_name = 'Dana Ilves'),
               'works_at',
               (SELECT entity_id FROM entity WHERE canonical_name = 'Trieste Roasters'),
               ARRAY['personal:mail'],
               'ingested';
      `);

      const result = await reconcileAllEdges(sql, { taxonomyVersion: 1 });
      // It still did its job on the edges it owns...
      expect(result.added).toBe(1);
      // ...and touched nothing it did not.
      expect(result.removed).toBe(0);
      expect(await countRows(sql, 'entity_edge', `deleted_at IS NULL AND derivation = 'ingested'`)).toBe(1);
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'a superseded fact stops supporting its edge',
    async () => {
      const { sql } = tenant;
      const joined = await seedFact(sql, {
        statement: 'Ronan Whitfield joined Verdant Systems.',
        origins: ['personal:mail'],
        confidence: 0.8,
      });
      await reconcileAllEdges(sql, { taxonomyVersion: 1 });
      expect(await countRows(sql, 'entity_edge', 'deleted_at IS NULL')).toBe(1);

      const left = await seedFact(sql, {
        statement: 'Ronan Whitfield left Verdant Systems.',
        origins: ['personal:mail'],
        confidence: 0.8,
      });
      await sql`UPDATE fact SET superseded_by = ${left}::bigint WHERE fact_id = ${joined}::bigint`;

      const result = await reconcileAllEdges(sql, { taxonomyVersion: 1 });
      expect(result.removed).toBe(1);
      expect(await countRows(sql, 'entity_edge', 'deleted_at IS NULL')).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('staleness', () => {
  test(
    'an older version of an upstream item is marked stale and its facts stop being live',
    async () => {
      const { sql } = tenant;
      const older = await seedPage(sql, {
        origin: 'personal:mail',
        sourceType: 'email',
        title: 'invite v1',
        body: 'The Halcyon review is on 3 April.',
        externalRef: 'gmail:msg-1',
        createdAt: '2026-04-01T00:00:00Z',
      });
      const newer = await seedPage(sql, {
        origin: 'personal:mail',
        sourceType: 'email',
        title: 'invite v2',
        body: 'The Halcyon review is on 9 April.',
        externalRef: 'gmail:msg-1',
        createdAt: '2026-04-02T00:00:00Z',
      });
      const staleFact = await seedFact(sql, {
        statement: 'Halcyon shipped on 3 April.',
        origins: ['personal:mail'],
        pageId: older.pageId,
        chunkIds: older.chunkIds,
      });
      const liveFact = await seedFact(sql, {
        statement: 'Halcyon shipped on 9 April.',
        origins: ['personal:mail'],
        pageId: newer.pageId,
        chunkIds: newer.chunkIds,
      });

      const result = await markStaleness(sql, { now: new Date('2026-04-03T00:00:00Z') });
      expect(result.staled).toBe(1);
      expect(result.factsInvalidated).toBe(1);

      const rows = (await sql`
        SELECT fact_id::text AS fact_id, superseded_by::text AS superseded_by FROM fact
      `) as Array<{ fact_id: string; superseded_by: string | null }>;
      const byId = new Map(rows.map((row) => [row.fact_id, row.superseded_by]));
      expect(byId.get(staleFact)).not.toBeNull();
      expect(byId.get(liveFact)).toBeNull();

      // The replacement is untouched; only the superseded version is marked.
      const pages = (await sql`
        SELECT page_id::text AS page_id, stale_at FROM page ORDER BY page_id
      `) as Array<{ page_id: string; stale_at: Date | null }>;
      expect(pages.find((page) => page.page_id === older.pageId)?.stale_at).not.toBeNull();
      expect(pages.find((page) => page.page_id === newer.pageId)?.stale_at).toBeNull();
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('rule-based entity merge', () => {
  test(
    'two entities with the same name under the same origins merge; two different ones do not',
    async () => {
      const { sql } = tenant;
      await sql.unsafe(`
        INSERT INTO entity (canonical_name, entity_type, origin_contexts) VALUES
          ('Verdant Systems', 'organization', ARRAY['personal:mail']),
          ('verdant  systems', 'organization', ARRAY['personal:mail']),
          ('Trieste Roasters', 'organization', ARRAY['personal:mail']);
        INSERT INTO entity_slug (slug, entity_id, kind)
        SELECT 'verdant-systems', entity_id, 'canonical' FROM entity WHERE canonical_name = 'Verdant Systems';
        INSERT INTO entity_slug (slug, entity_id, kind)
        SELECT 'verdant-systems-2', entity_id, 'canonical' FROM entity WHERE canonical_name = 'verdant  systems';
      `);

      const result = await mergeEntitiesByRule(sql);
      expect(result.merged).toBe(1);

      expect(await countRows(sql, 'entity', 'deleted_at IS NULL')).toBe(2);
      // The loser's address survives as a redirect rather than dangling.
      const slugs = (await sql`
        SELECT slug, kind FROM entity_slug ORDER BY slug
      `) as Array<{ slug: string; kind: string }>;
      expect(slugs.find((row) => row.slug === 'verdant-systems-2')?.kind).toBe('redirect');
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'a name collision across credentials is left alone — merging would widen an origin',
    async () => {
      const { sql } = tenant;
      await sql.unsafe(`
        INSERT INTO entity (canonical_name, entity_type, origin_contexts) VALUES
          ('Verdant Systems', 'organization', ARRAY['personal:mail']),
          ('Verdant Systems', 'organization', ARRAY['work:files']);
      `);
      const result = await mergeEntitiesByRule(sql);
      expect(result.merged).toBe(0);
      expect(await countRows(sql, 'entity', 'deleted_at IS NULL')).toBe(2);
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('deterministic salience', () => {
  test(
    'a page that facts and entities point at scores above one nothing points at',
    async () => {
      const { sql } = tenant;
      const dense = await seedPage(sql, {
        origin: 'personal:mail',
        sourceType: 'email',
        title: 'Verdant thread',
        body: 'Ronan Whitfield joined Verdant Systems. Verdant Systems is based in Trieste.',
        createdAt: '2026-04-02T00:00:00Z',
      });
      const sparse = await seedPage(sql, {
        origin: 'personal:mail',
        sourceType: 'email',
        title: 'lunch',
        body: 'ok',
        createdAt: '2026-04-02T00:00:00Z',
      });
      await seedFact(sql, {
        statement: 'Ronan Whitfield joined Verdant Systems.',
        origins: ['personal:mail'],
        pageId: dense.pageId,
        chunkIds: dense.chunkIds,
      });
      await seedFact(sql, {
        statement: 'Verdant Systems is based in Trieste.',
        origins: ['personal:mail'],
        pageId: dense.pageId,
        chunkIds: dense.chunkIds,
      });

      const result = await computeDeterministicSalience(sql, {
        now: new Date('2026-04-03T00:00:00Z'),
      });
      expect(result.scored).toBe(2);

      const rows = (await sql`
        SELECT page_id::text AS page_id, salience, salience_source FROM page
      `) as Array<{ page_id: string; salience: number; salience_source: string }>;
      const byId = new Map(rows.map((row) => [row.page_id, row]));
      const denseScore = byId.get(dense.pageId);
      const sparseScore = byId.get(sparse.pageId);
      expect(denseScore?.salience_source).toBe('deterministic');
      expect(denseScore?.salience ?? 0).toBeGreaterThan(sparseScore?.salience ?? 1);
      // Bounded, so a later model refinement is comparable against it.
      for (const row of rows) {
        expect(row.salience).toBeGreaterThanOrEqual(0);
        expect(row.salience).toBeLessThanOrEqual(1);
      }
    },
    SETUP_TIMEOUT_MS,
  );
});

describe('embedding-space clustering', () => {
  test(
    'near-identical chunks land in one cluster and an unrelated one does not join it',
    async () => {
      const { sql } = tenant;
      await seedPage(sql, {
        origin: 'personal:mail',
        sourceType: 'email',
        title: 'a',
        body: 'Verdant Systems roastery contract renewal terms',
      });
      await seedPage(sql, {
        origin: 'personal:mail',
        sourceType: 'email',
        title: 'b',
        body: 'Verdant Systems roastery contract renewal terms again',
      });
      await seedPage(sql, {
        origin: 'personal:mail',
        sourceType: 'email',
        title: 'c',
        body: 'Firmware advisory affects 2.1.0 on the espresso grinder',
      });

      const result = await clusterByEmbedding(sql, { runId: null, threshold: 0.6 });
      expect(result.clusters).toBeGreaterThanOrEqual(1);

      const sizes = (await sql`
        SELECT cluster_id::text AS cluster_id, count(*)::int AS n
          FROM cluster_member GROUP BY cluster_id ORDER BY n DESC
      `) as Array<{ cluster_id: string; n: number }>;
      expect(sizes[0]?.n).toBe(2);
      // Every member is a distinct chunk: a cluster that listed one chunk twice
      // would report the same "pattern" from one row.
      const members = (await sql`SELECT count(DISTINCT chunk_id)::int AS n FROM cluster_member`) as Array<{
        n: number;
      }>;
      expect(members[0]?.n).toBe(result.members);
    },
    SETUP_TIMEOUT_MS,
  );
});
