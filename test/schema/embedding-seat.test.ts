/**
 * A seat may be registered and still be unservable, and provisioning is where
 * that has to be discovered.
 *
 * **The failure this prevents.** Moving the `embedding` op to the 1024 seat is
 * one line in a routing table. `fact.embedding` is `vector(1536) NOT NULL` — a
 * fact is embedded synchronously on the write path, so an unembedded fact is a
 * row the database refuses — and no 1024-dimension model can produce a value for
 * it. So the one-line edit produces a fleet that provisions cleanly, serves
 * reads, and fails its first *write* under a user, from a stack trace naming a
 * NOT NULL constraint several layers below the routing row that caused it.
 *
 * The blocker is computed from the tenant's own catalog rather than asserted in
 * this file, which is the property that matters most about it: it is a statement
 * that stops being true when the schema changes, instead of a comment that has
 * to be remembered. Today the remedy is a contract rung —
 * `ALTER COLUMN ... DROP NOT NULL` is refused by
 * `src/control/migrate.ts:findExpandContractViolations`, with no waiver list, on
 * purpose — so this test is also the record of why the seat is not live.
 */

import type { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  ACTIVE_EMBEDDING_SEAT,
  EMBEDDING_SEATS,
  UnknownEmbeddingSeatError,
  UnservableEmbeddingSeatError,
  findSeatWriteBlockers,
  isSeatColumn,
  requireSeatById,
  seatById,
} from '../../src/schema/embedding-seat.ts';
import { HEAD_SCHEMA_VERSION } from '../../src/schema/migrations.ts';
import {
  INDEXED_VECTOR_COLUMNS,
  assertVectorColumns,
  listVectorColumns,
} from '../../src/schema/vector-index.ts';
import { connect, dropFixtureDatabase, provisionFixture, type SchemaFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;

const QWEN = requireSeatById('cf-qwen3-embedding-0.6b-1024');

let schema: SchemaFixture;
let sql: SQL;

beforeAll(async () => {
  schema = await provisionFixture('seatblock');
  sql = connect(schema);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await sql?.close();
  if (schema !== undefined) await dropFixtureDatabase(schema);
});

describe('the registry is a closed set, and resolves by name', () => {
  test('an unregistered seat name is a throw, never a default', () => {
    expect(seatById('no-such-seat')).toBeUndefined();
    expect(seatById(null)).toBeUndefined();
    expect(() => requireSeatById('no-such-seat')).toThrow(UnknownEmbeddingSeatError);
  });

  test('every registered seat owns a distinct column, and only those are columns', () => {
    const columns = EMBEDDING_SEATS.map((seat) => seat.column);
    expect(new Set(columns).size).toBe(columns.length);
    for (const column of columns) expect(isSeatColumn(column)).toBe(true);
    expect(isSeatColumn('content')).toBe(false);
  });

  test('every seat column is registered as indexed on both embedding tables', () => {
    for (const seat of EMBEDDING_SEATS) {
      for (const table of ['chunk', 'fact']) {
        const entry = INDEXED_VECTOR_COLUMNS.find(
          (column) => column.table === table && column.column === seat.column,
        );
        expect({ table, column: seat.column, registered: entry !== undefined }).toEqual({
          table,
          column: seat.column,
          registered: true,
        });
        expect(entry?.operator).toBe('<=>');
      }
    }
  });
});

describe('a seat is servable only if the tenant can be written under it', () => {
  test('the tenant really carries both seats’ columns, indexed', async () => {
    // The control. Without it every assertion below could be passing because
    // the rung never ran.
    const present = await listVectorColumns(sql);
    const named = present.map((column) => `${column.table}.${column.column}`);
    for (const seat of EMBEDDING_SEATS) {
      expect(named).toContain(`chunk.${seat.column}`);
      expect(named).toContain(`fact.${seat.column}`);
    }
    await expect(assertVectorColumns(sql, HEAD_SCHEMA_VERSION)).resolves.toBeArray();
  });

  test('the shipped seat has no write blockers', async () => {
    expect(findSeatWriteBlockers(ACTIVE_EMBEDDING_SEAT, await listVectorColumns(sql))).toEqual([]);
  });

  test('rung 14 removed the blocker the 1024 seat was held on', async () => {
    // This assertion used to read the other way round, and the reversal is the
    // whole of the rung: `fact.embedding` was `vector(1536) NOT NULL`, which no
    // 1024-dimension model could fill, so the seat was refused at provisioning
    // naming the constraint. Asked of the catalog, so it is the schema that
    // answers rather than this file.
    expect(findSeatWriteBlockers(QWEN, await listVectorColumns(sql))).toEqual([]);
    await expect(assertVectorColumns(sql, HEAD_SCHEMA_VERSION, QWEN)).resolves.toBeArray();
  });

  test('and the blocker can still fire — the guard did not become a formality', async () => {
    // The remedy was a rung, not a relaxed rule. A NOT NULL vector column of the
    // wrong width is still a seat that provisioning must refuse, or the next
    // width change discovers it at the first write under a user.
    const stillBlocking = [
      ...(await listVectorColumns(sql)),
      { table: 'fact', column: 'embedding_future', type: 'vector(3072)', notNull: true },
    ];
    const blockers = findSeatWriteBlockers(QWEN, stillBlocking);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('fact.embedding_future');
    expect(() => {
      throw new UnservableEmbeddingSeatError(QWEN, blockers);
    }).toThrow(UnservableEmbeddingSeatError);
  });

  test('a fact still cannot be written unembedded — the NOT NULL, restated across both seats', async () => {
    // What rung 14 gave up and what it put back. The NOT NULL said "a fact
    // always arrives embedded"; that is a real invariant — an unembedded fact is
    // invisible to every similarity query for as long as it lives, and nothing
    // reports it — so the rung replaced it with a CHECK that asks the same
    // question of both seats at once.
    const page = (await sql`
      INSERT INTO page (origin_context, source_type, title, embedding_model, embedding_dimensions,
                        chunker_version, normalizer_version, content_sha256)
      VALUES ('personal', 'note', 'seat check', 'fixture-model', 1024, 1, 1, ${'a'.repeat(64)})
      RETURNING page_id::text AS page_id
    `) as Array<{ page_id: string }>;
    const pageId = page[0]?.page_id;
    expect(pageId).toBeDefined();

    let refusal = '';
    try {
      await sql.unsafe(
        `INSERT INTO fact (page_id, statement, origin_contexts, confidence, taxonomy_version)
         VALUES ($1::bigint, 'a fact nobody embedded', ARRAY['personal']::text[], 0.9, 1)`,
        [pageId],
      );
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain('fact_embedded_in_some_seat');

    // And either seat satisfies it, which is the half that makes the rung
    // usable rather than a NOT NULL by another name.
    for (const seat of EMBEDDING_SEATS) {
      const literal = `[${Array.from({ length: seat.dimensions }, (_, index) => (index === 0 ? 1 : 0)).join(',')}]`;
      const written = (await sql.unsafe(
        `INSERT INTO fact (page_id, statement, ${seat.column}, origin_contexts, confidence, taxonomy_version)
         VALUES ($1::bigint, $2, $3::vector, ARRAY['personal']::text[], 0.9, 1)
         RETURNING fact_id::text AS fact_id`,
        [pageId, `a fact embedded under ${seat.id}`, literal],
      )) as Array<{ fact_id: string }>;
      expect(written[0]?.fact_id).toBeDefined();
    }
  });

  test('the CHECK names every registered seat, so a third one cannot be added silently', async () => {
    // The trap this closes: register a third seat, route to it, and every fact
    // INSERT fails the constraint above — at the first write, under a user, on
    // a tenant that provisioned cleanly. The constraint cannot be widened
    // without a rung (dropping one is contracting), so the moment a seat is
    // registered that it does not name, this goes red and the rung is written.
    const expression = (await sql`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conname = 'fact_embedded_in_some_seat'
    `) as Array<{ definition: string }>;
    const definition = expression[0]?.definition;
    expect(definition).toBeDefined();
    for (const seat of EMBEDDING_SEATS) {
      expect(definition).toContain(seat.column);
    }
  });

  test('the blocker follows the catalog, not this file', () => {
    // The same seat against a catalog where the constraint has been lifted is
    // servable. That is what makes this a computed blocker rather than a
    // hardcoded refusal: the contract rung removes it without editing the guard.
    const lifted = [
      { table: 'chunk', column: 'embedding', type: 'vector(1536)', notNull: false },
      { table: 'fact', column: 'embedding', type: 'vector(1536)', notNull: false },
      { table: 'chunk', column: QWEN.column, type: 'vector(1024)', notNull: false },
      { table: 'fact', column: QWEN.column, type: 'vector(1024)', notNull: false },
    ];
    expect(findSeatWriteBlockers(QWEN, lifted)).toEqual([]);

    // And a NOT NULL column at the seat's OWN width is not a blocker either —
    // otherwise the rule would be "any NOT NULL vector column blocks", which
    // would refuse the shipped seat as well and be trivially true.
    const ownWidth = [{ table: 'fact', column: QWEN.column, type: 'vector(1024)', notNull: true }];
    expect(findSeatWriteBlockers(QWEN, ownWidth)).toEqual([]);
  });
});
