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
  CHUNK_EMBED_MAX_CHARS,
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

/**
 * **The batch the provider refused, and the wedge it made.**
 *
 * `CHUNK_EMBED_BATCH` bounds how MANY strings go in a request. The provider's
 * limit is on how BIG the request is: over it the answer is `HTTP 400 /
 * AiError 3030, "input too big"`. Thirty-two ordinary chunks fit; thirty-two
 * large ones did not — and the backlog re-selects exactly the rows it failed to
 * embed, so every pass rebuilt the identical oversized request and every pass
 * was refused. Three connectors on one brain stopped for hours behind it,
 * because the backlog spans every source.
 *
 * The measurement behind `CHUNK_EMBED_MAX_CHARS`: against the live model,
 * 69,676 encoded characters were accepted and 73,808 were refused. The budget
 * sits well under that because the real limit is in tokens and characters-per-
 * token varies with the text.
 *
 * The assertion is per-REQUEST, not per-run. A run that splits into two calls
 * of legal size is the fix working; a run that makes one call of illegal size
 * is the bug, and both embed the same number of chunks.
 */
describe('a batch is bounded by what it weighs, not only by how many it holds', () => {
  test('no single gateway call exceeds the size budget, however large the chunks are', async () => {
    // Each chunk is a fifth of the budget, so a count-bounded batch of 32 would
    // build one request roughly six times over it.
    const big = 'x'.repeat(Math.floor(CHUNK_EMBED_MAX_CHARS / 5));
    for (let i = 0; i < 12; i += 1) {
      await seedChunk(`${big} ${i}`);
    }

    const { gateway, transport } = createGateway();
    const result = await runChunkEmbedBacklog({
      sql: fixture.sql,
      gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
    });

    expect(result.failure).toBeUndefined();
    expect(transport.calls.length).toBeGreaterThan(1);
    for (const call of transport.calls) {
      const input = call.input;
      if (input.kind !== 'embedding') continue;
      const chars = input.texts.reduce((total, text) => total + text.length, 0);
      expect(chars).toBeLessThanOrEqual(CHUNK_EMBED_MAX_CHARS);
    }
  });

  test('one chunk larger than the whole budget is still attempted, not stranded', async () => {
    // The alternative to attempting it is a row no pass can ever route around —
    // a permanent hole that stops the backlog behind it forever. It fails
    // loudly instead of silently blocking everything else.
    const huge = 'y'.repeat(CHUNK_EMBED_MAX_CHARS + 5_000);
    await seedChunk(huge);

    const { gateway, transport } = createGateway();
    await runChunkEmbedBacklog({
      sql: fixture.sql,
      gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
    });

    const sent = transport.calls.flatMap((call) =>
      call.input.kind === 'embedding' ? call.input.texts : [],
    );
    expect(sent.some((text) => text.length > CHUNK_EMBED_MAX_CHARS)).toBe(true);
  });
});

/**
 * **No character budget can be right, so the batch has to get smaller.**
 *
 * The provider's limit is in tokens and characters-per-token varies by more than
 * a factor of two across one brain's own content: 69,676 encoded characters were
 * accepted in one sample and 30,566 refused in another. A budget tuned on the
 * first wedges on the second — which is what happened in production, where the
 * first fix drained 9,285 chunks and then stopped dead on the remaining 358.
 *
 * The refusal is a bare 400 the transport reads no body from, so the pass cannot
 * ask why. It can only try smaller, and that same walk absorbs a transient 429
 * instead of turning it into a stalled backlog.
 */
describe('a refused batch is halved until it is accepted', () => {
  test('a backlog whose natural batch is refused still drains completely', async () => {
    for (let i = 0; i < 20; i += 1) await seedChunk(`a passage the provider will weigh ${i}`);
    const before = await backlogSize(fixture.sql, ACTIVE_EMBEDDING_SEAT.column);
    expect(before).toBeGreaterThanOrEqual(20);

    // Small enough that the natural batch is refused and only a halved one lands.
    const { gateway, transport } = createGateway({ refuseBatchesLargerThan: 4 });
    const result = await runChunkEmbedBacklog({
      sql: fixture.sql,
      gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
    });

    // The assertion that fails without the halving: the pass returns a failure
    // and the backlog is untouched, every time, forever.
    expect(result.failure).toBeUndefined();
    expect(result.embedded).toBeGreaterThanOrEqual(before);
    expect(await backlogSize(fixture.sql, ACTIVE_EMBEDDING_SEAT.column)).toBe(0);
    // The refused attempts are legitimately large — that is the walk working, not
    // a leak. What proves the halving is that it reached a size the provider
    // accepts, and that it took more than one call to get there.
    const sizes = transport.calls
      .filter((call) => call.input.kind === 'embedding')
      .map((call) => (call.input.kind === 'embedding' ? call.input.texts.length : 0));
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.min(...sizes)).toBeLessThanOrEqual(4);
  });

  test('a single text the provider always refuses is reported, not retried forever', async () => {
    await seedChunk('the one the provider will never take');
    const { gateway } = createGateway({ refuseBatchesLargerThan: 0 });
    const result = await runChunkEmbedBacklog({
      sql: fixture.sql,
      gateway,
      tenantId: TENANT,
      caller: CALLER,
      budget: uncappedBudget(),
    });
    // Halving stops at one. A real failure stays a real failure.
    expect(result.failure).toBeDefined();
  });
});
