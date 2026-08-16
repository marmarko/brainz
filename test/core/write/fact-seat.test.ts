/**
 * The other half of the seat, and the half that was never asked: `fact`.
 *
 * **The defect this measures.** `chunk` was made seat-aware — the read arm
 * resolves its column from the model the gateway reported having called, and the
 * backfill refuses a batch whose answering model belongs to another seat. `fact`
 * was not. Two statements named the column as the literal `embedding`: the
 * INSERT in `write-path.ts` and the neighbour scan in `dedup.ts`. That is
 * correct for exactly as long as one model can ever be routed, and the moment
 * one is not it is two selectors disagreeing — the read half of a brain in one
 * vector space and the write half in another, which is a thing no type,
 * constraint or eval notices.
 *
 * **The property under test is not a schema property.** It is: *a query
 * embedded under one model is never served results embedded under another.*
 * There is no query cache in this system to contaminate — nothing on the read
 * path memoizes a result set — so the whole of the guarantee is the resolution
 * chain: the gateway reports what it called, `embeddingSeatFor` maps that to a
 * seat, and the seat's column is the only one any statement touches. This file
 * exercises it with the violating case, which is the only version worth having:
 * a fact written under seat A, looked up under seat B.
 *
 * **What "not served" has to mean here.** A miss or a typed refusal — never a
 * confident wrong answer. The two seats registered today differ in width, so a
 * literal column would fail loudly on one path (pgvector refuses
 * `vector(1024) <=> vector(1536)`) and that loudness is an accident of the
 * current registry rather than the guarantee. So the assertions below are about
 * the *verdict*: the neighbour that comes back is the one written by the seat
 * the incoming vector belongs to, and a fact in the other seat's column is not a
 * candidate at all.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { classifyStatement } from '../../../src/core/write/dedup.ts';
import {
  ACTIVE_EMBEDDING_SEAT,
  EMBEDDING_SEATS,
  requireSeatById,
  seatColumnSql,
} from '../../../src/schema/embedding-seat.ts';
import { createTenantFixture, type TenantFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;

const QWEN = requireSeatById('cf-qwen3-embedding-0.6b-1024');
const OPENAI = requireSeatById('openai-3-large-1536');

/** `[1, 0, 0, …]` at an arbitrary width — cosine 1 against itself. */
function unit(dimensions: number): number[] {
  return [1, ...new Array<number>(dimensions - 1).fill(0)];
}

let fixture: TenantFixture;
let pageId: string;
/** The fact whose vector lives in the 1536 column and nowhere else. */
let openaiFactId: string;
/** The fact whose vector lives in the 1024 column and nowhere else. */
let qwenFactId: string;

async function seedFact(seat: { column: string; dimensions: number }, statement: string): Promise<string> {
  const literal = `[${unit(seat.dimensions).join(',')}]`;
  const rows = (await fixture.sql.unsafe(
    `INSERT INTO fact (page_id, statement, ${seatColumnSql(seat.column)}, origin_contexts, confidence, taxonomy_version)
     VALUES ($1::bigint, $2, $3::vector, ARRAY['personal']::text[], 0.9, 1)
     RETURNING fact_id::text AS fact_id`,
    [pageId, statement, literal],
  )) as Array<{ fact_id: string }>;
  const id = rows[0]?.fact_id;
  if (id === undefined) throw new Error('fact seed failed');
  return id;
}

beforeAll(async () => {
  fixture = await createTenantFixture('factseat');

  const page = (await fixture.sql`
    INSERT INTO page (origin_context, source_type, title, embedding_model, embedding_dimensions,
                      chunker_version, normalizer_version, content_sha256)
    VALUES ('personal', 'note', 'seat page', 'fixture-model', 1024, 1, 1, ${'b'.repeat(64)})
    RETURNING page_id::text AS page_id
  `) as Array<{ page_id: string }>;
  const id = page[0]?.page_id;
  if (id === undefined) throw new Error('page seed failed');
  pageId = id;

  // Two facts, one per seat, each with a vector in its own column and NULL in
  // the other. Between them "which column did you scan" is answerable from the
  // verdict rather than from the source text.
  openaiFactId = await seedFact(OPENAI, 'the spare key is in the blue tin');
  qwenFactId = await seedFact(QWEN, 'the spare key is under the mat');
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

describe('a fact is compared only against facts of its own seat', () => {
  test('the seeded facts really are one per column', async () => {
    // The control. Without it every assertion below could pass because the
    // fixture never wrote what it says it wrote.
    const rows = (await fixture.sql`
      SELECT fact_id::text AS fact_id,
             embedding IS NOT NULL AS has_openai,
             embedding_qwen1024 IS NOT NULL AS has_qwen
        FROM fact ORDER BY fact_id
    `) as Array<{ fact_id: string; has_openai: boolean; has_qwen: boolean }>;
    expect(rows).toEqual([
      { fact_id: openaiFactId, has_openai: true, has_qwen: false },
      { fact_id: qwenFactId, has_openai: false, has_qwen: true },
    ]);
  });

  test('a statement embedded by the 1536 seat matches the 1536 fact', async () => {
    const verdict = await classifyStatement(fixture.sql, {
      statement: 'a differently worded claim about the spare key',
      vector: unit(OPENAI.dimensions),
      origin: 'personal',
      seat: OPENAI,
    });
    expect(verdict.status).toBe('duplicate');
    expect(verdict.matchedFactId).toBe(openaiFactId);
  });

  test('the same vector under the 1024 seat matches the 1024 fact instead', async () => {
    // The column is the only thing that differs between this call and the one
    // above. A literal column here would have answered `openaiFactId` — or
    // thrown, which is the same defect wearing a stack trace.
    const verdict = await classifyStatement(fixture.sql, {
      statement: 'a differently worded claim about the spare key',
      vector: unit(QWEN.dimensions),
      origin: 'personal',
      seat: QWEN,
    });
    expect(verdict.status).toBe('duplicate');
    expect(verdict.matchedFactId).toBe(qwenFactId);
  });

  test('a fact in the other seat’s column is not a candidate — the violating case misses', async () => {
    // The property spelled out. Delete the 1536 fact and ask under the 1536
    // seat: the 1024 fact is *right there*, its vector is identical, and it
    // must not come back. A read that fell back to the shipped column, or a
    // scan that ignored which column carried the value, would return it and be
    // wrong with nothing to report.
    await fixture.sql`DELETE FROM fact WHERE fact_id = ${openaiFactId}::bigint`;
    try {
      const verdict = await classifyStatement(fixture.sql, {
        statement: 'a differently worded claim about the spare key',
        vector: unit(OPENAI.dimensions),
        origin: 'personal',
        seat: OPENAI,
      });
      expect(verdict.status).toBe('inserted');
      expect(verdict.matchedFactId).toBeNull();
    } finally {
      openaiFactId = await seedFact(OPENAI, 'the spare key is in the blue tin');
    }
  });

  test('a column no seat owns never reaches the statement', () => {
    // Same closure the read arm and the chunk backfill go through, asked at the
    // point of interpolation: an identifier cannot be a bound parameter, so
    // "it came from a seat object" is a convention rather than a closed set.
    expect(() => seatColumnSql('embedding; DROP TABLE fact')).toThrow(/not a registered/);
    expect(() => seatColumnSql('statement')).toThrow(/not a registered/);
    for (const seat of EMBEDDING_SEATS) expect(seatColumnSql(seat.column)).toBe(seat.column);
  });

  test('the default is the active seat, and the active seat is one of the registered ones', () => {
    // The one place a default is tolerable — a caller with no model in hand —
    // and it must be a registered seat rather than a string that once was one.
    expect(EMBEDDING_SEATS).toContain(ACTIVE_EMBEDDING_SEAT);
  });
});
