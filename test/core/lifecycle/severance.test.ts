/**
 * U18 §4 — the severance flow, and the read property that follows it.
 *
 * ============================================================================
 * THE THREE THINGS THIS FILE HAS TO PROVE
 * ============================================================================
 *
 *   1. **The preview is not a guess.** U17 built two columns and had no caller;
 *      the last test here runs the preview and then the executor over the same
 *      fixture and asserts the `removed` column and the rows actually tombstoned
 *      agree. A preview that is merely *plausible* is what lets a user consent
 *      to a cost that is not the cost.
 *
 *   2. **The mixed rows survive.** This is the whole reason severance is not a
 *      delete. A row whose origins are `{work, personal}` is not the work
 *      account's to take. The fixture therefore contains such rows and asserts
 *      up front that it does — because a severance test over a brain with no
 *      mixed rows passes every assertion below while proving none of them.
 *
 *   3. **The post-severance read property**, which is the third leg of the
 *      ledger's `gap.context-injection-gate`: after severance, **no read path
 *      returns a row whose origin is the severed one, under any grant —
 *      including the whole-brain bearer.** It is asserted through the real MCP
 *      surface, tool by tool, rather than by re-running the same SQL the
 *      executor used, because "the delete worked" and "no reader can still see
 *      it" are different claims and only the second one is the promise.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { previewSeverance } from '../../../src/core/lifecycle/blast-radius.ts';
import {
  grantsEmptiedBy,
  recomputeWorklist,
  severOrigin,
} from '../../../src/core/lifecycle/severance.ts';
import { agentOriginFor } from '../../../src/mcp/grant-scope.ts';
import { deriveSigningKey, mintAccessToken, type GrantClaims } from '../../../src/mcp/oauth.ts';
import { TOOL_NAMES } from '../../../src/mcp/tools/index.ts';
import {
  createMcpFixture,
  seedEntity,
  seedFact,
  seedPage,
  type McpFixture,
} from '../../mcp/fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const WORK = 'work:mail';
const PERSONAL = 'personal:mail';

/** Planted in every pure-work row. After severance it must be unreachable. */
const SEVERED_MARKER = 'SEVERED-WORK-3fa91c';
/** Planted in the mixed rows. These SURVIVE — severance is not a delete. */
const MIXED_MARKER = 'MIXED-ROW-77c204';
/** Planted in the pure-personal rows. Untouched throughout. */
const KEPT_MARKER = 'KEPT-PERSONAL-b1e058';

let fixture: McpFixture;
let workChunkId = '';
let mixedFactId = '';

beforeAll(async () => {
  fixture = await createMcpFixture('lifecycle_severance');
  const { sql } = fixture;

  const workChunks = await seedPage(sql, {
    id: 'work-thread',
    title: `Work thread ${SEVERED_MARKER}`,
    sourceType: 'email',
    origin: WORK,
    createdAt: '2026-06-01',
    paragraphs: [`${SEVERED_MARKER}: the platform migration lands on the twelfth.`],
  });
  workChunkId = workChunks[0] ?? '';

  const personalChunks = await seedPage(sql, {
    id: 'personal-thread',
    title: `Personal thread ${KEPT_MARKER}`,
    sourceType: 'email',
    origin: PERSONAL,
    createdAt: '2026-06-02',
    paragraphs: [`${KEPT_MARKER}: the flight home is on the fourteenth.`],
  });

  // Pure-work derived row: goes with the account.
  await seedFact(sql, {
    statement: `${SEVERED_MARKER} the migration owner is the platform team.`,
    origins: [WORK],
    chunkIds: [workChunkId],
    createdAt: '2026-06-03',
  });

  // MIXED: the row the second preview column is about. Survives, and is wrong
  // until something re-derives it.
  mixedFactId = await seedFact(sql, {
    statement: `${MIXED_MARKER} the migration lands the day before the flight home.`,
    origins: [WORK, PERSONAL],
    chunkIds: [workChunkId, personalChunks[0] ?? ''],
    createdAt: '2026-06-04',
  });

  await seedEntity(sql, {
    slug: 'platform-team',
    name: `Platform Team ${SEVERED_MARKER}`,
    type: 'organization',
    origins: [WORK],
  });
  await seedEntity(sql, {
    slug: 'shared-person',
    name: `Shared Person ${MIXED_MARKER}`,
    type: 'person',
    origins: [WORK, PERSONAL],
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

function wholeBrainToken(): string {
  const claims: GrantClaims = {
    grantId: 'g-whole',
    tenantId: fixture.tenantId,
    scope: 'whole_brain',
    origins: [],
    writeOrigin: agentOriginFor('personal'),
    endpoint: 'mcp',
    clientId: 'client-severance',
    issuedAt: fixture.now(),
    expiresAt: fixture.now() + 3_600_000,
  };
  return mintAccessToken(claims, deriveSigningKey(fixture.bearer));
}

const ARGS_FOR: Readonly<Record<string, () => Record<string, unknown>>> = {
  recall: () => ({ query: 'platform migration twelfth' }),
  search: () => ({ query: 'platform migration twelfth' }),
  fetch: () => ({ id: `chunk:${workChunkId}` }),
  entity: () => ({ name: `Platform Team ${SEVERED_MARKER}` }),
  briefing: () => ({}),
  remember: () => ({ statement: 'A memory written after the severance.' }),
  // Deliberately the already-severed chunk, not the mixed fact: the sweep must
  // exercise `forget` without *itself* retracting the row the next test proves
  // survived. A destructive argument in a read-property sweep is a test that
  // creates the state it then observes.
  forget: () => ({ id: `chunk:${workChunkId}` }),
  brain: () => ({}),
  manage: () => ({ action: 'set_spend_cap', value: '1000' }),
  synthesize: () => ({ query: 'anything' }),
};

// ---------------------------------------------------------------------------
// 0. The fixture. A severance test over a brain with no mixed rows proves nothing.
// ---------------------------------------------------------------------------

describe('the fixture has a mixed-origin half', () => {
  test(
    'the brain holds pure-work, pure-personal AND mixed rows before anything is severed',
    async () => {
      const census = (await fixture.sql`
        SELECT
          (SELECT count(*)::int FROM chunk WHERE origin_context = ${WORK} AND deleted_at IS NULL) AS work_chunks,
          (SELECT count(*)::int FROM chunk WHERE origin_context = ${PERSONAL} AND deleted_at IS NULL) AS personal_chunks,
          (SELECT count(*)::int FROM fact
            WHERE deleted_at IS NULL AND origin_contexts @> ARRAY[${WORK}]::text[]
              AND NOT (origin_contexts <@ ARRAY[${WORK}]::text[])) AS mixed_facts
      `) as Array<{ work_chunks: number; personal_chunks: number; mixed_facts: number }>;

      expect(census[0]?.work_chunks ?? 0).toBeGreaterThan(0);
      expect(census[0]?.personal_chunks ?? 0).toBeGreaterThan(0);
      // The one that makes every later assertion mean something.
      expect(census[0]?.mixed_facts ?? 0).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and the whole-brain grant can read all three right now',
    async () => {
      const authorization = `Bearer ${wholeBrainToken()}`;
      const work = await fixture.call('fetch', { id: `chunk:${workChunkId}` }, { authorization });
      expect(work.ok).toBe(true);
      expect(JSON.stringify(work.content)).toContain(SEVERED_MARKER);

      const mixed = await fixture.call('fetch', { id: `fact:${mixedFactId}` }, { authorization });
      expect(mixed.ok).toBe(true);
      expect(JSON.stringify(mixed.content)).toContain(MIXED_MARKER);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 1. The confirmation.
// ---------------------------------------------------------------------------

describe('severance will not run without an echo of what is being severed', () => {
  test(
    'a mismatched confirmation refuses and changes nothing',
    async () => {
      const before = await census(fixture);
      const outcome = await severOrigin(fixture.sql, {
        origin: WORK,
        confirm: 'yes',
        now: new Date(fixture.now()),
      });
      expect(outcome.ok).toBe(false);
      expect(outcome).toMatchObject({ reason: 'not_confirmed' });
      expect(await census(fixture)).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an origin with no class is refused before a transaction opens',
    async () => {
      const before = await census(fixture);
      const outcome = await severOrigin(fixture.sql, {
        origin: 'work',
        confirm: 'work',
        now: new Date(fixture.now()),
      });
      expect(outcome.ok).toBe(false);
      expect(outcome).toMatchObject({ reason: 'unknown_origin' });
      expect(await census(fixture)).toEqual(before);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. The severance itself, and the preview it is measured against.
// ---------------------------------------------------------------------------

describe('severing an origin', () => {
  test(
    'takes exactly what the preview said it would, and leaves the mixed rows standing',
    async () => {
      // The preview, taken BEFORE — this is the number a user would have been
      // shown, and the assertion below is that it was honest.
      const preview = await previewSeverance(fixture.sql, { origin: WORK });
      expect(preview.removed.chunks).toBeGreaterThan(0);
      // The second column is the one U17 built and nobody consumed.
      expect(preview.recomputeRequired).toBe(true);
      expect(preview.recomputed.facts).toBeGreaterThan(0);

      const outcome = await severOrigin(fixture.sql, {
        origin: WORK,
        confirm: WORK,
        now: new Date(fixture.now()),
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;

      // **The preview is checked, not trusted.** `removed` is what the preview
      // promised; `tombstoned` is what the deletes took.
      expect(outcome.receipt.tombstoned.pages).toBe(preview.removed.pages);
      expect(outcome.receipt.tombstoned.chunks).toBe(preview.removed.chunks);
      expect(outcome.receipt.tombstoned.facts).toBe(preview.removed.facts);
      expect(outcome.receipt.tombstoned.entities).toBe(preview.removed.entities);
      expect(outcome.receipt.alreadySevered).toBe(false);

      // The mixed fact is still live, and its origins are untouched — R15 makes
      // them immutable, so severance cannot rewrite history to tidy up after
      // itself.
      const mixed = (await fixture.sql`
        SELECT deleted_at, origin_contexts FROM fact WHERE fact_id = ${mixedFactId}::bigint
      `) as Array<{ deleted_at: string | null; origin_contexts: string[] }>;
      expect(mixed[0]?.deleted_at).toBeNull();
      expect([...(mixed[0]?.origin_contexts ?? [])].sort()).toEqual([PERSONAL, WORK]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'writes one append-only record carrying the numbers that actually happened',
    async () => {
      const rows = (await fixture.sql`
        SELECT origin_context, removed, recomputed, surviving_origins
          FROM severance ORDER BY severance_id DESC LIMIT 1
      `) as Array<{
        origin_context: string;
        removed: Record<string, number>;
        recomputed: Record<string, number>;
        surviving_origins: string[];
      }>;

      const record = rows[0];
      expect(record?.origin_context).toBe(WORK);
      // A jsonb *object*, not a string scalar — which is what `JSON.stringify`
      // into a `::jsonb` cast silently produces, and what nothing notices until
      // a reader asks for a field.
      expect(typeof record?.removed).toBe('object');
      expect(record?.removed.chunks).toBeGreaterThan(0);
      expect(record?.recomputed.facts).toBeGreaterThan(0);
      expect(record?.surviving_origins).toContain(PERSONAL);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the recompute worklist is derived from the record, not stored on the rows',
    async () => {
      const worklist = await recomputeWorklist(fixture.sql);
      expect(worklist.severedOrigins).toContain(WORK);
      // Exactly the rows the preview's second column counted: mixed, live, and
      // now standing on evidence that is gone.
      expect(worklist.counts.facts).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'severing the same origin again takes nothing and says so',
    async () => {
      const outcome = await severOrigin(fixture.sql, {
        origin: WORK,
        confirm: WORK,
        now: new Date(fixture.now() + 1000),
      });
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.receipt.alreadySevered).toBe(true);
      expect(outcome.receipt.tombstoned.chunks).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. The read property. The third leg of gap.context-injection-gate.
// ---------------------------------------------------------------------------

describe('after severance, no read path returns a severed row', () => {
  test(
    'not through any tool, on either endpoint, even under the whole-brain grant',
    async () => {
      const authorization = `Bearer ${wholeBrainToken()}`;

      for (const endpoint of ['mcp', 'openai'] as const) {
        for (const tool of TOOL_NAMES) {
          const result = await fixture.call(tool, ARGS_FOR[tool]?.() ?? {}, {
            authorization,
            endpoint,
          });
          const serialised = JSON.stringify(result);
          expect(
            serialised.includes(SEVERED_MARKER),
            `${tool} on /${endpoint} still returns a severed row: ${serialised.slice(0, 400)}`,
          ).toBe(false);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the surviving halves are still there — severance is not a purge of the brain',
    async () => {
      const authorization = `Bearer ${wholeBrainToken()}`;
      // Without this the test above is satisfied by a brain that returns
      // nothing at all, which is the trivial pass every absence assertion has.
      const mixed = await fixture.call('fetch', { id: `fact:${mixedFactId}` }, { authorization });
      expect(mixed.ok).toBe(true);
      expect(JSON.stringify(mixed.content)).toContain(MIXED_MARKER);

      const kept = await fixture.call('recall', { query: 'flight home fourteenth' }, { authorization });
      expect(kept.ok).toBe(true);
      expect(JSON.stringify(kept.content)).toContain(KEPT_MARKER);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 4. The credentials severance empties.
// ---------------------------------------------------------------------------

describe('grants emptied by a severance are named for revocation', () => {
  const grants = [
    { grantId: 'g-work-only', origins: ['work:mail'] },
    { grantId: 'g-work-class', origins: ['work:*'] },
    { grantId: 'g-personal', origins: ['personal:*'] },
    { grantId: 'g-whole-brain', origins: [] },
    { grantId: 'g-straddling', origins: ['work:mail', 'personal:mail'] },
  ];

  test('a grant scoped entirely inside the severed set is named', () => {
    expect(grantsEmptiedBy(grants, ['work:mail'], ['personal:mail'])).toEqual(['g-work-only']);
  });

  test('a class grant survives while its class still has anything live in it', () => {
    // `work:*` still resolves to `work:agent` — `expandGrant`'s floor — so the
    // user's work connector is not disconnected by severing one work source.
    expect(grantsEmptiedBy(grants, ['work:mail'], ['work:agent', 'personal:mail'])).toEqual([
      'g-work-only',
    ]);
  });

  test('a class grant IS named once nothing of its class survives', () => {
    expect(grantsEmptiedBy(grants, ['work:mail', 'work:agent'], ['personal:mail'])).toEqual([
      'g-work-only',
      'g-work-class',
    ]);
  });

  test('a whole-brain grant is never emptied, and a straddling grant is never revoked', () => {
    const named = grantsEmptiedBy(grants, ['work:mail', 'work:agent'], ['personal:mail']);
    expect(named).not.toContain('g-whole-brain');
    expect(named).not.toContain('g-straddling');
    expect(named).not.toContain('g-personal');
  });
});

/** Live-row counts across every table severance can touch. */
async function census(f: McpFixture): Promise<Record<string, number>> {
  const rows = (await f.sql`
    SELECT
      (SELECT count(*)::int FROM page   WHERE deleted_at IS NULL) AS pages,
      (SELECT count(*)::int FROM chunk  WHERE deleted_at IS NULL) AS chunks,
      (SELECT count(*)::int FROM fact   WHERE deleted_at IS NULL) AS facts,
      (SELECT count(*)::int FROM entity WHERE deleted_at IS NULL) AS entities,
      (SELECT count(*)::int FROM severance) AS severances
  `) as Array<Record<string, number>>;
  return rows[0] ?? {};
}
