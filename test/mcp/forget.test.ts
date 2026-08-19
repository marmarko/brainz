/**
 * R12's soft-delete leg, landed here rather than at U17.
 *
 * **Why this cannot wait for the unit that owns versions.** `forget` goes live
 * in Phase 1 and U13 then bakes for two weeks against real mail with injection
 * live and demarcation being an instruction to a model rather than an
 * enforcement boundary. A `forget` that erased would make an unrecoverable
 * destructive call reachable by a crafted email — the one failure the plan
 * cannot take back. So the tombstone and its 72-hour TTL cascade are here, and
 * U17 keeps versions, revert, blast-radius preview and the erasure runbook.
 *
 * **Recovery is exercised, not assumed.** A test that only asserts `deleted_at
 * IS NOT NULL` proves the row stopped being returned; it proves nothing about
 * whether it can come back. So every case below restores and then reads the row
 * through the real tool.
 *
 * **The purge is where the FK traps are.** `fact.superseded_by` references
 * `fact` with no `ON DELETE` action, so hard-deleting a superseded fact raises a
 * constraint violation rather than cascading — which would leave a purge that
 * silently never completes and a "72-hour TTL" that is in fact forever.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  FORGET_TTL_HOURS,
  PURGE_GRACE_HOURS,
  purgeExpiredTombstones,
  restoreForgotten,
} from '../../src/mcp/tombstone.ts';
import { createMcpFixture, seedFact, seedPage, type McpFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;
const ORIGIN = 'personal:mail';
const HOUR = 60 * 60 * 1000;

let fixture: McpFixture;

beforeAll(async () => {
  fixture = await createMcpFixture('mcp_forget');
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

async function seedDocument(id: string): Promise<{ chunkIds: string[]; factId: string }> {
  const chunkIds = await seedPage(fixture.sql, {
    id,
    title: `Document ${id}`,
    sourceType: 'email',
    origin: ORIGIN,
    createdAt: '2026-05-01',
    paragraphs: [`The ${id} body mentions the quarterly figure.`, `More about ${id}.`],
  });
  const factId = await seedFact(fixture.sql, {
    statement: `The ${id} quarterly figure was agreed.`,
    origins: [ORIGIN],
    chunkIds: [chunkIds[0] ?? ''],
  });
  return { chunkIds, factId };
}

async function liveCount(table: string, column: string, value: string): Promise<number> {
  const rows = (await fixture.sql.unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1::bigint AND deleted_at IS NULL`,
    [value],
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

describe('forget is a tombstone', () => {
  test(
    'retracting a chunk hides it from every read and leaves the row in place',
    async () => {
      const { chunkIds } = await seedDocument('tombstone-chunk');
      const id = `chunk:${chunkIds[0]}`;

      const before = await fixture.call('fetch', { id });
      expect(before.ok).toBe(true);

      const forgotten = await fixture.call('forget', { id });
      expect(forgotten.ok).toBe(true);
      const receipt = forgotten.content as {
        id: string;
        deleted_at: string;
        recoverable_until: string;
        cascade: Record<string, number>;
      };
      expect(receipt.id).toBe(id);
      expect(receipt.cascade.chunks).toBe(1);

      const after = await fixture.call('fetch', { id });
      expect(after.ok).toBe(false);
      expect(after.error?.code).toBe('not_found');

      const rows = (await fixture.sql.unsafe(
        'SELECT deleted_at FROM chunk WHERE chunk_id = $1::bigint',
        [chunkIds[0] ?? ''],
      )) as Array<{ deleted_at: string | null }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.deleted_at).not.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'retracting a document cascades to its chunks and its facts',
    async () => {
      const { chunkIds, factId } = await seedDocument('tombstone-doc');
      const pageRows = (await fixture.sql.unsafe(
        'SELECT page_id::text AS page_id FROM chunk WHERE chunk_id = $1::bigint',
        [chunkIds[0] ?? ''],
      )) as Array<{ page_id: string }>;
      const pageId = pageRows[0]?.page_id ?? '';

      const forgotten = await fixture.call('forget', { id: `doc:${pageId}` });
      expect(forgotten.ok).toBe(true);
      const receipt = forgotten.content as { cascade: Record<string, number> };
      expect(receipt.cascade.pages).toBe(1);
      expect(receipt.cascade.chunks).toBe(2);
      expect(receipt.cascade.facts).toBe(1);

      expect(await liveCount('chunk', 'page_id', pageId)).toBe(0);
      expect(await liveCount('fact', 'fact_id', factId)).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test('forget is idempotent — retracting twice is not an error', async () => {
    const { chunkIds } = await seedDocument('tombstone-twice');
    const id = `chunk:${chunkIds[0]}`;
    expect((await fixture.call('forget', { id })).ok).toBe(true);
    const second = await fixture.call('forget', { id });
    expect(second.ok).toBe(true);
    expect((second.content as { cascade: Record<string, number> }).cascade.chunks).toBe(0);
  }, TEST_TIMEOUT_MS);

  /**
   * **An id this brain never issued is `not_found`, however it is malformed.**
   *
   * This used to split three ways: `chunk:999999999` was `not_found` and
   * `chunk:not-a-number` was `invalid_params`. The split was grammar leakage.
   * `forget`'s schema declares `id` as a plain `string` with no pattern — the
   * grammar is deliberately unpublished, because ids are minted here and a
   * caller that could construct one would be addressing rows rather than
   * quoting them back. So a caller's string is never the wrong *type*; whether
   * it names a record is a lookup, and a lookup that finds nothing is
   * `not_found`. Reporting the grammar violation separately told a caller
   * exactly which shapes brainz parses, in the vocabulary reserved for
   * parameters the schema itself rejects.
   *
   * From the caller's side "that is not one of my ids" and "I have no such id"
   * are the same fact and have the same fix, which is what the suggestion says.
   *
   * A MISSING `id` is still `invalid_params` — the schema marks it required, so
   * that one really is a parameter error, and the two halves are pinned
   * together here so the collapse cannot go one step too far.
   */
  test('an id this brain never issued is not_found, however it is malformed', async () => {
    for (const id of ['chunk:999999999', 'chunk:not-a-number', 'nonsense']) {
      const refused = await fixture.call('forget', { id });
      expect(refused.error?.code, id).toBe('not_found');
    }
    expect((await fixture.call('forget', {})).error?.code).toBe('invalid_params');
  }, TEST_TIMEOUT_MS);
});

describe('recovery inside the TTL', () => {
  test(
    'a retracted document comes back, and reads see it again',
    async () => {
      const { chunkIds } = await seedDocument('restore-doc');
      const id = `chunk:${chunkIds[0]}`;
      const forgotten = await fixture.call('forget', { id });
      const receipt = forgotten.content as { deleted_at: string };

      const restored = await restoreForgotten(fixture.sql, {
        deletedAt: receipt.deleted_at,
        now: new Date(fixture.now() + 71 * HOUR),
      });
      expect(restored.ok).toBe(true);
      if (!restored.ok) return;
      expect(restored.restored.chunks).toBeGreaterThan(0);

      const after = await fixture.call('fetch', { id });
      expect(after.ok).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'restore does not resurrect rows a different call retracted',
    async () => {
      const first = await seedDocument('restore-scope-a');
      const second = await seedDocument('restore-scope-b');

      const forgottenA = await fixture.call('forget', { id: `chunk:${first.chunkIds[0]}` });
      fixture.advance(1_000);
      await fixture.call('forget', { id: `chunk:${second.chunkIds[0]}` });

      const receiptA = forgottenA.content as { deleted_at: string };
      const restored = await restoreForgotten(fixture.sql, {
        deletedAt: receiptA.deleted_at,
        now: new Date(fixture.now() + HOUR),
      });
      expect(restored.ok).toBe(true);

      expect((await fixture.call('fetch', { id: `chunk:${first.chunkIds[0]}` })).ok).toBe(true);
      expect((await fixture.call('fetch', { id: `chunk:${second.chunkIds[0]}` })).ok).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'restore past the TTL is refused rather than silently doing nothing',
    async () => {
      const { chunkIds } = await seedDocument('restore-expired');
      const forgotten = await fixture.call('forget', { id: `chunk:${chunkIds[0]}` });
      const receipt = forgotten.content as { deleted_at: string };

      const outcome = await restoreForgotten(fixture.sql, {
        deletedAt: receipt.deleted_at,
        now: new Date(fixture.now() + (FORGET_TTL_HOURS + 1) * HOUR),
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.reason).toBe('ttl_expired');
    },
    TEST_TIMEOUT_MS,
  );
});

/**
 * The purge sweeps at `FORGET_TTL_HOURS + PURGE_GRACE_HOURS`, not at the TTL.
 *
 * The 72 hours is the window the *user* is promised and `restoreForgotten` still
 * admits an undo for exactly that long. The grace band is the far edge: a
 * batched purge commits between batches, so a restore admitted at the boundary
 * could otherwise land mid-cascade. See `PURGE_GRACE_HOURS`. The cases below
 * therefore run the sweep past both, and the one asserting that a fresh
 * tombstone survives is unchanged — it was always about the near edge.
 */
const PAST_THE_SWEEP = FORGET_TTL_HOURS + PURGE_GRACE_HOURS + 1;

describe('the 72-hour purge', () => {
  test(
    'leaves a tombstone younger than the TTL alone',
    async () => {
      const { chunkIds } = await seedDocument('purge-young');
      await fixture.call('forget', { id: `chunk:${chunkIds[0]}` });

      const purged = await purgeExpiredTombstones(fixture.sql, {
        now: new Date(fixture.now() + (FORGET_TTL_HOURS - 1) * HOUR),
      });
      expect(purged.counts.chunks).toBe(0);

      const rows = (await fixture.sql.unsafe('SELECT count(*)::int AS n FROM chunk WHERE chunk_id = $1::bigint', [
        chunkIds[0] ?? '',
      ])) as Array<{ n: number }>;
      expect(rows[0]?.n).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'removes a tombstone past the TTL and its grace band, and the row is gone for good',
    async () => {
      const { chunkIds } = await seedDocument('purge-old');
      await fixture.call('forget', { id: `chunk:${chunkIds[0]}` });

      const purged = await purgeExpiredTombstones(fixture.sql, {
        now: new Date(fixture.now() + PAST_THE_SWEEP * HOUR),
      });
      expect(purged.counts.chunks).toBeGreaterThan(0);

      const rows = (await fixture.sql.unsafe('SELECT count(*)::int AS n FROM chunk WHERE chunk_id = $1::bigint', [
        chunkIds[0] ?? '',
      ])) as Array<{ n: number }>;
      expect(rows[0]?.n).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'purges a superseded fact without tripping its self-referencing foreign key',
    async () => {
      const chunkIds = await seedPage(fixture.sql, {
        id: 'purge-superseded',
        title: 'Superseded facts',
        sourceType: 'email',
        origin: ORIGIN,
        createdAt: '2026-05-02',
        paragraphs: ['The figure was revised twice.'],
      });
      const older = await seedFact(fixture.sql, {
        statement: 'The figure was one hundred.',
        origins: [ORIGIN],
        chunkIds: [chunkIds[0] ?? ''],
      });
      const newer = await seedFact(fixture.sql, {
        statement: 'The figure was two hundred.',
        origins: [ORIGIN],
        chunkIds: [chunkIds[0] ?? ''],
      });
      await fixture.sql.unsafe('UPDATE fact SET superseded_by = $2::bigint WHERE fact_id = $1::bigint', [
        older,
        newer,
      ]);

      // Only the SUCCESSOR is retracted. The still-live older row points at it,
      // and `fact_superseded_fkey` declares no `ON DELETE` action — so without
      // the pointer clear this delete raises, the purge never completes, and the
      // "72-hour TTL" is silently forever. Retracting both together would hide
      // it: Postgres checks the constraint at statement end and two rows leaving
      // in one statement satisfy each other.
      await fixture.call('forget', { id: `fact:${newer}` });

      const purged = await purgeExpiredTombstones(fixture.sql, {
        now: new Date(fixture.now() + PAST_THE_SWEEP * HOUR),
      });
      expect(purged.counts.facts).toBeGreaterThanOrEqual(1);

      const gone = (await fixture.sql.unsafe(
        'SELECT count(*)::int AS n FROM fact WHERE fact_id = $1::bigint',
        [newer],
      )) as Array<{ n: number }>;
      expect(gone[0]?.n).toBe(0);

      const survivor = (await fixture.sql.unsafe(
        'SELECT superseded_by FROM fact WHERE fact_id = $1::bigint',
        [older],
      )) as Array<{ superseded_by: string | null }>;
      expect(survivor).toHaveLength(1);
      expect(survivor[0]?.superseded_by).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test('the TTL really is the one R12 promises', () => {
    expect(FORGET_TTL_HOURS).toBe(72);
  });
});

describe('forget is fenced like every other tool', () => {
  test(
    'a grant that cannot read a row cannot retract it either',
    async () => {
      const { deriveSigningKey, mintAccessToken } = await import('../../src/mcp/oauth.ts');
      const { chunkIds } = await seedDocument('forget-fence');
      const token = mintAccessToken(
        {
          grantId: 'g-forget-fence',
          tenantId: fixture.tenantId,
          scope: 'narrowed',
          // U18: a narrowed grant's write origin must be inside it, so this
          // work-scoped fixture writes at `work:agent` rather than planting
          // personal rows it could never read back.
          origins: ['work:mail', 'work:agent'],
          writeOrigin: 'work:agent',
          endpoint: 'mcp',
          clientId: 'client-test',
          issuedAt: fixture.now(),
          expiresAt: fixture.now() + 3_600_000,
        },
        deriveSigningKey(fixture.bearer),
      );

      const result = await fixture.call(
        'forget',
        { id: `chunk:${chunkIds[0]}` },
        { authorization: `Bearer ${token}` },
      );
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('scope_denied');

      const rows = (await fixture.sql.unsafe('SELECT deleted_at FROM chunk WHERE chunk_id = $1::bigint', [
        chunkIds[0] ?? '',
      ])) as Array<{ deleted_at: string | null }>;
      expect(rows[0]?.deleted_at).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});
