/**
 * The **file-parity** leg of R18's round trip, and the test that states in code
 * why it is not enough.
 *
 * This one runs in `bun test`: it exports a real brain through the real write
 * path's chunks, re-imports the tree through U8's real `runImport`, exports the
 * fresh tenant, and compares the two trees byte for byte. Zero model calls
 * beyond the fixture's deterministic embedding transport, no egress — the
 * defining promise of the blocking suite.
 *
 * **And it deliberately proves its own insufficiency.** R18 says model-derived
 * artifacts are re-derived on import rather than carried in the export. So the
 * last test here seeds an entity card and a commitment in the source brain,
 * round-trips, and asserts the destination has **neither** — while the file
 * digests match exactly. That is the failure mode the knowledge-parity leg
 * exists for, written down as a passing test rather than as a warning in a
 * docstring: a green file diff over a brain with no entity cards, no salience
 * and no commitments.
 *
 * `bun run test:roundtrip` is the other leg. It re-consolidates and scores the
 * blocking eval, it makes model calls, and it therefore cannot live here.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { planTree, treeDigest, type ExportTree } from '../../../src/core/export/tree.ts';
import { reconstructLivePages } from '../../../src/core/export/reconstruct.ts';
import { externalRefFor } from '../../../src/ingest/import/folder.ts';
import { runImport, type ImportMaterial } from '../../../src/ingest/import/run.ts';
import { EMBEDDING_DIMENSIONS } from '../../../src/schema/vector-index.ts';
import {
  HOSTED_PROFILE,
  ORIGIN,
  TENANT,
  createIngestFixture,
  proseOf,
  setSpend,
  type IngestFixture,
} from '../../ingest/fixture.ts';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 120_000;

let source: IngestFixture;
let destination: IngestFixture;

function request(
  fixture: IngestFixture,
  material: ImportMaterial,
  sourceType: 'email' | 'file',
  target: 'chat_export' | 'folder',
) {
  return {
    tenant: fixture.runtime,
    control: fixture.controlSql,
    storage: fixture.storage,
    rawStore: fixture.rawStore,
    profile: HOSTED_PROFILE,
    originContext: ORIGIN,
    sourceType,
    target,
    material,
    now: NOW,
    queue: fixture.queue,
  };
}

/** Long enough that the real chunker cuts each document into several windows. */
function document(seed: string, paragraphs = 40): string {
  return proseOf(seed, paragraphs);
}

async function exportOf(fixture: IngestFixture): Promise<ExportTree> {
  return planTree(await reconstructLivePages(fixture.tenantSql));
}

/** The tree, turned back into the material U8's folder path would hand the runner. */
function materialFromTree(tree: ExportTree, rootId: string): ImportMaterial {
  return {
    items: tree.files.map((file) => ({
      externalRef: externalRefFor(rootId, file.path),
      title: file.path,
      body: file.body,
      occurredAt: null,
    })),
    failures: [],
    raw: null,
  };
}

beforeAll(async () => {
  source = await createIngestFixture('u17src');
  destination = await createIngestFixture('u17dst');

  await setSpend(source.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: 50_000_000 });
  await setSpend(destination.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: 50_000_000 });

  // A brain with both shapes in it: pages that arrived with an upstream id and
  // a subject (mail), and pages that arrived as files at a path (a folder).
  await runImport(
    request(
      source,
      {
        items: [
          {
            externalRef: 'gmail:m1',
            title: 'Lunch on Friday',
            body: document('lunch'),
            occurredAt: null,
          },
          {
            externalRef: 'gmail:m2',
            title: 'Re: the quarterly numbers',
            body: document('numbers'),
            occurredAt: null,
          },
        ],
        failures: [],
        raw: null,
      },
      'email',
      'chat_export',
    ),
  );

  await runImport(
    request(
      source,
      {
        items: [
          {
            externalRef: externalRefFor('notes', 'deep/nested/journal.md'),
            title: 'deep/nested/journal.md',
            body: `# A journal entry\n\n${document('journal')}`,
            occurredAt: null,
          },
        ],
        failures: [],
        raw: null,
      },
      'file',
      'folder',
    ),
  );
}, { timeout: SETUP_TIMEOUT_MS });

afterAll(async () => {
  await source?.close();
  await destination?.close();
});

describe('export → import → export is a fixed point on real chunked pages', () => {
  test(
    'every page reconstructs to something that verifies against its own digest',
    async () => {
      // The end-to-end check on the reconstructor: these chunks were produced by
      // the real write path from real prose, overlap and all, and the digest the
      // write path recorded is the arbiter.
      const pages = await reconstructLivePages(source.tenantSql);
      expect(pages.length).toBe(3);
      expect(pages.filter((page) => !page.verified)).toEqual([]);
      // And it is not vacuous: these documents really did take several chunks.
      expect(pages.every((page) => page.chunkCount > 1)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the re-imported brain exports the identical tree',
    async () => {
      const first = await exportOf(source);
      expect(first.files.length).toBe(3);
      expect(first.manifest.unverified).toEqual([]);

      const imported = await runImport(
        request(destination, materialFromTree(first, 'restore'), 'file', 'folder'),
      );
      expect(imported.outcome).toBe('completed');
      expect(imported.counts.written).toBe(3);
      expect(imported.counts.failed).toBe(0);

      const second = await exportOf(destination);

      expect(second.files.map((file) => file.path).sort()).toEqual(
        first.files.map((file) => file.path).sort(),
      );
      expect(treeDigest(second.files)).toBe(treeDigest(first.files));
      expect(second.manifest.unverified).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the mail subject is still in the re-imported brain, and it is in the body',
    async () => {
      const bodies = (await reconstructLivePages(destination.tenantSql)).map((page) => page.body);
      expect(bodies.some((body) => body.includes('# Lunch on Friday'))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('file parity is green while the knowledge is gone — which is why it is not the gate', () => {
  test(
    'an entity card and a commitment do not survive the round trip, and the digests still match',
    async () => {
      const embedding = `('[1' || repeat(',0', ${EMBEDDING_DIMENSIONS - 1}) || ']')::vector(${EMBEDDING_DIMENSIONS})`;
      await source.tenantSql.unsafe(`
        INSERT INTO entity (canonical_name, entity_type, origin_contexts)
        VALUES ('roundtrip-subject', 'person', ARRAY['${ORIGIN}']);
        INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts)
        SELECT entity_id, 'what consolidation knew about them', 'model_inferred', 'model_derived',
               ARRAY['${ORIGIN}']
          FROM entity WHERE canonical_name = 'roundtrip-subject';
        INSERT INTO fact (statement, embedding, origin_contexts)
        VALUES ('roundtrip commitment source', ${embedding}, ARRAY['${ORIGIN}']);
        INSERT INTO commitment (fact_id, statement, trust_level, derivation, origin_contexts)
        SELECT fact_id, 'send the deck by Friday', 'model_extracted', 'model_derived', ARRAY['${ORIGIN}']
          FROM fact WHERE statement = 'roundtrip commitment source';
      `);

      const cardsBefore = await count(source, 'entity_card');
      const commitmentsBefore = await count(source, 'commitment');
      expect(cardsBefore).toBe(1);
      expect(commitmentsBefore).toBe(1);

      // The export is unchanged by their existence — they are not in it (R18).
      const tree = await exportOf(source);
      expect(treeDigest(tree.files)).toBe(treeDigest((await exportOf(destination)).files));

      // And the destination, which just passed file parity, holds neither.
      expect(await count(destination, 'entity_card')).toBe(0);
      expect(await count(destination, 'commitment')).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

async function count(fixture: IngestFixture, table: string): Promise<number> {
  const rows = (await fixture.tenantSql.unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE deleted_at IS NULL`,
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
