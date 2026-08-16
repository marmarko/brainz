/**
 * The vector arm scans the column the query's own model wrote.
 *
 * **The defect this measures.** `vectorArmSql()` used to spell `c.embedding`
 * twice, as a literal. That is correct for exactly as long as one model is ever
 * routed to the `embedding` op. With two seats registered, the column a read
 * must scan is a property of *which model embedded the query* — and resolving it
 * from anything else is a read that ranks one model's query against another
 * model's vectors. Two vectors of different models are not points in the same
 * space, so every distance computes, every row ranks, and the answer is wrong
 * with nothing to report it.
 *
 * The two seats registered today differ in width, which makes the failure loud
 * rather than silent — pgvector refuses `vector(1024) <=> vector(1536)` — and
 * loud is not the same as handled: the arm throws, `runArms` does not catch it,
 * and a read that should have degraded to two arms 500s instead. So the seeded
 * case below asserts the *answer*, not the absence of an exception: the row that
 * comes back must be the one embedded by the seat the query was embedded by.
 *
 * The same-width case — the one that would be silent — is covered by the
 * resolution being keyed on the model id and never on the width: the last test
 * below asserts the two registered models resolve to two different columns
 * without anything consulting a dimension. A guard that keyed on width would
 * pass on the dangerous case and fail only on the safe one.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { embeddingSeatFor } from '../../../src/ai/routing.ts';
import { vectorArm, vectorArmSql } from '../../../src/core/search/arms.ts';
import { ACTIVE_EMBEDDING_SEAT, requireSeatById } from '../../../src/schema/embedding-seat.ts';
import { createSearchFixture, seedPage, type SearchFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;
const GRANT = ['personal'] as const;

/** The other seat — the one the fleet is not provisioned at. */
const QWEN = requireSeatById('cf-qwen3-embedding-0.6b-1024');

/** `[1, 0, 0, …]` at an arbitrary width. */
function unitQuery(dimensions: number): number[] {
  return [1, ...new Array<number>(dimensions - 1).fill(0)];
}

function unitLiteral(dimensions: number): string {
  return `[${unitQuery(dimensions).join(',')}]`;
}

let fixture: SearchFixture;
/** The chunk whose vector lives in the 1024 column and nowhere else. */
let qwenChunkId: string;
/** The chunk whose vector lives in the 1536 column and nowhere else. */
let openaiChunkId: string;

beforeAll(async () => {
  fixture = await createSearchFixture('seat');

  const [openai] = await seedPage(fixture.sql, {
    id: 'p-openai',
    title: 'a page embedded by the shipped seat',
    sourceType: 'note',
    origin: 'personal',
    createdAt: '2026-01-01T00:00:00Z',
    paragraphs: ['written under the 1536-dimension seat'],
    ladder: [0],
  });
  if (openai === undefined) throw new Error('seed failed');
  openaiChunkId = openai;

  const [qwen] = await seedPage(fixture.sql, {
    id: 'p-qwen',
    title: 'a page embedded by the other seat',
    sourceType: 'note',
    origin: 'personal',
    createdAt: '2026-01-01T00:00:00Z',
    paragraphs: ['written under the 1024-dimension seat'],
  });
  if (qwen === undefined) throw new Error('seed failed');
  qwenChunkId = qwen;

  // Only the 1024 column, so a read that scanned the other one cannot find it
  // by accident — and the 1536 row above has NULL here, so it cannot be found
  // by this one either. Between them the two rows make "which column did you
  // scan" answerable from the result rather than from the source text.
  await fixture.sql.unsafe(
    `UPDATE chunk SET ${QWEN.column} = $1::vector WHERE chunk_id = $2::bigint`,
    [unitLiteral(QWEN.dimensions), qwenChunkId],
  );
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

describe('the vector arm reads the seat that wrote the vectors', () => {
  test('a query embedded by the 1024 seat recalls the 1024 row', async () => {
    const result = await vectorArm(fixture.sql, {
      queryVector: unitQuery(QWEN.dimensions),
      column: QWEN.column,
      grant: [...GRANT],
      limit: 10,
    });

    expect(result.ranked).toContain(qwenChunkId);
    expect(result.ranked).not.toContain(openaiChunkId);
  });

  test('a query embedded by the shipped seat recalls the shipped row', async () => {
    const result = await vectorArm(fixture.sql, {
      queryVector: unitQuery(ACTIVE_EMBEDDING_SEAT.dimensions),
      column: ACTIVE_EMBEDDING_SEAT.column,
      grant: [...GRANT],
      limit: 10,
    });

    expect(result.ranked).toContain(openaiChunkId);
    expect(result.ranked).not.toContain(qwenChunkId);
  });

  test('the statement names the column it was given, not a literal', () => {
    expect(vectorArmSql(QWEN.column)).toContain(`c.${QWEN.column} <=>`);
    expect(vectorArmSql(QWEN.column)).not.toContain('c.embedding <=>');
    expect(vectorArmSql(ACTIVE_EMBEDDING_SEAT.column)).toContain(
      `c.${ACTIVE_EMBEDDING_SEAT.column} <=>`,
    );
  });

  test('a column no seat owns never reaches the statement', () => {
    // The column is interpolated — there is no parameter form for an identifier
    // — so the closure has to be asked at the point of interpolation. Asserting
    // it here rather than trusting that the value came from a seat object is
    // the difference between a closed set and a convention.
    expect(() => vectorArmSql('embedding; DROP TABLE chunk')).toThrow(/not a registered/);
    expect(() => vectorArmSql('content')).toThrow(/not a registered/);
  });

  test('an unregistered model has no seat, so it has no column', () => {
    expect(embeddingSeatFor('text-embedding-3-small')).toBeUndefined();
    expect(embeddingSeatFor(null)).toBeUndefined();
    // And the two registered ones resolve to different columns, which is what
    // makes a same-width swap catchable: nothing here consults a width.
    expect(embeddingSeatFor('@cf/qwen/qwen3-embedding-0.6b')?.column).toBe(QWEN.column);
    expect(embeddingSeatFor('text-embedding-3-large')?.column).toBe(ACTIVE_EMBEDDING_SEAT.column);
  });
});
