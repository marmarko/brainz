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

/**
 * The other seat — the one the fleet is not provisioned at.
 *
 * It is the 1536 one now; rung 14 made the 1024 seat active. Which member is
 * which is deliberately not what any assertion below turns on: the property is
 * that a query embedded by one seat reads that seat's column and no other, and
 * a test that named a particular model would have had to be rewritten to keep
 * saying the same thing.
 */
const OTHER = requireSeatById('openai-3-large-1536');

/** `[1, 0, 0, …]` at an arbitrary width. */
function unitQuery(dimensions: number): number[] {
  return [1, ...new Array<number>(dimensions - 1).fill(0)];
}

function unitLiteral(dimensions: number): string {
  return `[${unitQuery(dimensions).join(',')}]`;
}

let fixture: SearchFixture;
/** The chunk whose vector lives in the OTHER seat's column and nowhere else. */
let otherSeatChunkId: string;
/** The chunk whose vector lives in the ACTIVE seat's column and nowhere else. */
let activeSeatChunkId: string;

beforeAll(async () => {
  fixture = await createSearchFixture('seat');

  const [active] = await seedPage(fixture.sql, {
    id: 'p-active-seat',
    title: 'a page embedded by the active seat',
    sourceType: 'note',
    origin: 'personal',
    createdAt: '2026-01-01T00:00:00Z',
    paragraphs: ['written under the active seat'],
    ladder: [0],
  });
  if (active === undefined) throw new Error('seed failed');
  activeSeatChunkId = active;

  const [other] = await seedPage(fixture.sql, {
    id: 'p-other-seat',
    title: 'a page embedded by the other seat',
    sourceType: 'note',
    origin: 'personal',
    createdAt: '2026-01-01T00:00:00Z',
    paragraphs: ['written under the other seat'],
  });
  if (other === undefined) throw new Error('seed failed');
  otherSeatChunkId = other;

  // Only the other seat's column, so a read that scanned the active one cannot
  // find it by accident — and the row above has NULL here, so it cannot be
  // found by this one either. Between them the two rows make "which column did you
  // scan" answerable from the result rather than from the source text.
  await fixture.sql.unsafe(
    `UPDATE chunk SET ${OTHER.column} = $1::vector WHERE chunk_id = $2::bigint`,
    [unitLiteral(OTHER.dimensions), otherSeatChunkId],
  );
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

describe('the vector arm reads the seat that wrote the vectors', () => {
  test('a query embedded by the other seat recalls the other seat’s row', async () => {
    const result = await vectorArm(fixture.sql, {
      queryVector: unitQuery(OTHER.dimensions),
      column: OTHER.column,
      grant: [...GRANT],
      limit: 10,
    });

    expect(result.ranked).toContain(otherSeatChunkId);
    expect(result.ranked).not.toContain(activeSeatChunkId);
  });

  test('a query embedded by the active seat recalls the active seat’s row', async () => {
    const result = await vectorArm(fixture.sql, {
      queryVector: unitQuery(ACTIVE_EMBEDDING_SEAT.dimensions),
      column: ACTIVE_EMBEDDING_SEAT.column,
      grant: [...GRANT],
      limit: 10,
    });

    expect(result.ranked).toContain(activeSeatChunkId);
    expect(result.ranked).not.toContain(otherSeatChunkId);
  });

  test('the statement names the column it was given, not a literal', () => {
    expect(vectorArmSql(OTHER.column)).toContain(`c.${OTHER.column} <=>`);
    expect(vectorArmSql(OTHER.column)).not.toContain(`c.${ACTIVE_EMBEDDING_SEAT.column} <=>`);
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
    expect(embeddingSeatFor('text-embedding-3-large')?.column).toBe(OTHER.column);
    expect(embeddingSeatFor('@cf/qwen/qwen3-embedding-0.6b')?.column).toBe(ACTIVE_EMBEDDING_SEAT.column);
  });
});
