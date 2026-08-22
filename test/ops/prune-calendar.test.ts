/**
 * Retiring the calendar entries a recurrence rule invented.
 *
 * The assertion that matters is the boundary: the horizon is read from the
 * connector's own constant, so the cleanup and the fetch agree by construction.
 * A cleanup with a horizon of its own would leave a band of pages one half
 * re-fetches and the other half deletes, forever.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { CALENDAR_HORIZON_DAYS } from '../../src/ingest/pipedream/sources/calendar.ts';
import { previewPrune } from '../../src/ops/prune-calendar.ts';
import { createTenantFixture, type TenantFixture } from '../consolidate/fixture.ts';
import { ACTIVE_EMBEDDING_SEAT } from '../../src/schema/embedding-seat.ts';

const SETUP_TIMEOUT_MS = 180_000;
const NOW = new Date('2026-08-22T00:00:00.000Z');

let tenant: TenantFixture;
let sql: SQL;

beforeAll(async () => {
  tenant = await createTenantFixture('prunecal');
  sql = tenant.sql;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await tenant?.close();
});

beforeEach(async () => {
  await sql.unsafe(`DELETE FROM fact_source; DELETE FROM fact; DELETE FROM chunk; DELETE FROM page;`);
});

async function seedPage(options: {
  readonly title: string;
  readonly daysAhead: number;
  readonly sourceType?: string;
}): Promise<string> {
  const at = new Date(NOW.getTime() + options.daysAhead * 86_400_000).toISOString();
  const rows = (await sql.unsafe(
    `INSERT INTO page (origin_context, source_type, title, derivation, embedding_model,
                       embedding_dimensions, chunker_version, normalizer_version, content_sha256,
                       occurred_at)
     VALUES ('pipedream:calendar', $1, $2, 'ingested', 'text-embedding-3-small', 1024, 1, 1,
             repeat('a', 64), $3::timestamptz)
     RETURNING page_id::text AS id`,
    [options.sourceType ?? 'calendar', options.title, at],
  )) as Array<{ id: string }>;
  return rows[0]?.id ?? '';
}

describe('the prune horizon', () => {
  test('an occurrence inside the horizon is kept and one past it is not', async () => {
    // The whole point of 400 days rather than 365: the NEXT instance of an
    // annual event survives, which is what makes "when is it next" answerable.
    await seedPage({ title: 'Mama BDay', daysAhead: 300 });
    await seedPage({ title: 'Mama BDay', daysAhead: 300 + 365 });
    await seedPage({ title: 'Marko / Jim 1:1', daysAhead: CALENDAR_HORIZON_DAYS + 1 });

    const preview = await previewPrune(sql, NOW);
    expect(preview.pages).toHaveLength(2);
    expect(preview.byTitle.map((row) => row.title).sort()).toEqual(['Mama BDay', 'Marko / Jim 1:1']);
    // The one inside the horizon is untouched.
    const kept = (await sql.unsafe(
      `SELECT count(*)::int AS n FROM page WHERE deleted_at IS NULL AND occurred_at <= $1::timestamptz`,
      [preview.horizon.toISOString()],
    )) as Array<{ n: number }>;
    expect(kept[0]?.n).toBe(1);
  }, SETUP_TIMEOUT_MS);

  test('it touches nothing that is not a calendar page', async () => {
    // A mail thread dated far ahead is not a recurrence rule, and this script
    // has no business with it.
    await seedPage({ title: 'A far-future email', daysAhead: 5000, sourceType: 'email' });
    const preview = await previewPrune(sql, NOW);
    expect(preview.pages).toEqual([]);
  }, SETUP_TIMEOUT_MS);

  test('the preview counts the chunks and facts that would go with the pages', async () => {
    const page = await seedPage({ title: 'Marko <> Eric', daysAhead: CALENDAR_HORIZON_DAYS + 30 });
    await sql.unsafe(
      `INSERT INTO chunk (page_id, ordinal, content, origin_context)
       VALUES ($1::bigint, 0, 'a meeting in 2056', 'pipedream:calendar')`,
      [page],
    );
    // A fact must be embedded in some seat -- `fact_embedded_in_some_seat`.
    await sql.unsafe(
      `INSERT INTO fact (statement, page_id, origin_contexts, ${ACTIVE_EMBEDDING_SEAT.column})
       VALUES ('A meeting is set for 2056.', $1::bigint, ARRAY['pipedream:calendar'], $2::vector)`,
      [page, `[${new Array(ACTIVE_EMBEDDING_SEAT.dimensions).fill(0).join(",")}]`],
    );

    const preview = await previewPrune(sql, NOW);
    expect(preview.pages).toHaveLength(1);
    expect(preview.chunks).toBe(1);
    expect(preview.facts).toBe(1);
  }, SETUP_TIMEOUT_MS);
});
