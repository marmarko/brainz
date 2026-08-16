/**
 * The write half of the seat: a vector goes in the column its own model owns.
 *
 * **Three defects, and they compound.** `vectorLiteral` measured every vector
 * against one global width, so a correct vector from the second seat was refused
 * as malformed. `pendingChunkEmbeddings` asked one column `IS NULL`, so under a
 * second seat the backlog was empty on the first day and every chunk was
 * "already embedded" — by a model whose vectors the arm would not be reading.
 * And the backfill wrote into a column it never checked against the model that
 * answered, which is how one seat's vector reaches another seat's column: not as
 * a wrong answer but as a constraint violation halfway through a backfill, or —
 * the same width, some future seat — as no error at all.
 *
 * The last test is the one that matters most, because it is the case no type can
 * catch: the backlog was drained for one seat and the gateway answered as
 * another. Nothing about that is malformed. It is only wrong.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  EmbeddingWidthError,
  backlogSize,
  pendingChunkEmbeddings,
  runChunkEmbedBacklog,
  vectorLiteral,
} from '../../../src/core/write/embed.ts';
import { ACTIVE_EMBEDDING_SEAT, requireSeatById } from '../../../src/schema/embedding-seat.ts';
import {
  CALLER,
  TENANT,
  createGateway,
  createTenantFixture,
  lexicalVector,
  uncappedBudget,
  type TenantFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;

/**
 * The seat the fleet is NOT provisioned at, and whose column is empty.
 *
 * It is the 1536 one now: rung 14 made the 1024 seat active, so "the other
 * seat" changed sides and every assertion below is about the pair rather than
 * about either member. That is the point — the mechanism is symmetric, and a
 * test that named one of them would have had to be rewritten to say the same
 * thing.
 */
const OTHER = requireSeatById('openai-3-large-1536');

let fixture: TenantFixture;

beforeAll(async () => {
  fixture = await createTenantFixture('embedseat');
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

async function seedChunk(content: string): Promise<string> {
  const rows = (await fixture.sql`
    INSERT INTO chunk (origin_context, content)
    VALUES ('personal', ${content})
    RETURNING chunk_id::text AS chunk_id
  `) as Array<{ chunk_id: string }>;
  const id = rows[0]?.chunk_id;
  if (id === undefined) throw new Error('seed failed');
  return id;
}

describe('a vector is measured against its own seat', () => {
  test('the shipped seat still refuses a vector of the other width', () => {
    expect(() => vectorLiteral(lexicalVector('x', OTHER.dimensions), ACTIVE_EMBEDDING_SEAT)).toThrow(
      EmbeddingWidthError,
    );
  });

  test('the other seat accepts its own width and refuses the active one', () => {
    const narrow = lexicalVector('x', OTHER.dimensions);
    expect(vectorLiteral(narrow, OTHER)).toStartWith('[');
    expect(() =>
      vectorLiteral(lexicalVector('x', ACTIVE_EMBEDDING_SEAT.dimensions), OTHER),
    ).toThrow(EmbeddingWidthError);
  });

  test('a non-finite component is refused under either seat', () => {
    const poisoned = lexicalVector('x', OTHER.dimensions);
    poisoned[0] = Number.NaN;
    expect(() => vectorLiteral(poisoned, OTHER)).toThrow(EmbeddingWidthError);
  });
});

describe('the backlog is per seat', () => {
  test('a chunk embedded by one seat is still pending for the other', async () => {
    const id = await seedChunk('a passage embedded under the shipped seat only');
    await fixture.sql.unsafe(
      `UPDATE chunk SET ${ACTIVE_EMBEDDING_SEAT.column} = $1::vector WHERE chunk_id = $2::bigint`,
      [vectorLiteral(lexicalVector('anything', ACTIVE_EMBEDDING_SEAT.dimensions), ACTIVE_EMBEDDING_SEAT), id],
    );

    const shipped = await pendingChunkEmbeddings(fixture.sql, 50, ACTIVE_EMBEDDING_SEAT.column);
    const other = await pendingChunkEmbeddings(fixture.sql, 50, OTHER.column);

    expect(shipped.map((chunk) => chunk.chunkId)).not.toContain(id);
    // The whole point: "already embedded" is a claim about a space, not about a
    // row. Reading it as a property of the row is what makes a seat move look
    // finished on the day it starts.
    expect(other.map((chunk) => chunk.chunkId)).toContain(id);
    expect(await backlogSize(fixture.sql, OTHER.column)).toBeGreaterThan(
      await backlogSize(fixture.sql, ACTIVE_EMBEDDING_SEAT.column),
    );
  });
});

describe('the backfill will not write a vector into another seat’s column', () => {
  test('draining the other seat’s backlog against the active gateway writes nothing', async () => {
    await seedChunk('a passage nothing has embedded yet');
    const { gateway } = createGateway();

    const before = await backlogSize(fixture.sql, OTHER.column);
    const result = await runChunkEmbedBacklog({
      sql: fixture.sql,
      gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
      seat: OTHER,
    });

    // The gateway routes `embedding` to the shipped seat, so what came back is
    // not a vector for the column that was drained. Refused as a typed failure
    // with the rows left in the backlog, rather than written somewhere it fits.
    expect(result.embedded).toBe(0);
    expect(result.failure).toBe('embedding_seat_mismatch');
    expect(await backlogSize(fixture.sql, OTHER.column)).toBe(before);
  });

  test('draining the shipped backlog against the same gateway does write', async () => {
    // The control. Without it the assertion above would pass on a backfill that
    // never writes anything at all.
    const id = await seedChunk('a passage the shipped seat will embed');
    const { gateway } = createGateway();

    const result = await runChunkEmbedBacklog({
      sql: fixture.sql,
      gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
    });

    expect(result.failure).toBeUndefined();
    expect(result.embedded).toBeGreaterThan(0);

    const rows = (await fixture.sql.unsafe(
      `SELECT ${ACTIVE_EMBEDDING_SEAT.column} IS NOT NULL AS shipped,
              ${OTHER.column} IS NOT NULL AS other
         FROM chunk WHERE chunk_id = $1::bigint`,
      [id],
    )) as Array<{ shipped: boolean; other: boolean }>;
    expect(rows[0]).toEqual({ shipped: true, other: false });
  });
});
