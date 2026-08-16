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

  test('the 1024 seat is blocked by fact.embedding, named from the catalog', async () => {
    const blockers = findSeatWriteBlockers(QWEN, await listVectorColumns(sql));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toContain('fact.embedding');
    expect(blockers[0]).toContain('NOT NULL');
  });

  test('provisioning refuses a tenant under the blocked seat', async () => {
    await expect(assertVectorColumns(sql, HEAD_SCHEMA_VERSION, QWEN)).rejects.toThrow(
      UnservableEmbeddingSeatError,
    );
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
