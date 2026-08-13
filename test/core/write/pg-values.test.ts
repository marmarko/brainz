/**
 * The array-literal serializer, and the reason it is not a formatting detail.
 *
 * `origin_contexts` is the column KTD5 fences access on. It is `text[]`, and
 * Bun's SQL template spreads a JavaScript array into a value list rather than
 * binding one — so this repo serializes the literal itself. A serializer that
 * drops, merges or mangles an element writes a derived row whose origin set is
 * not the one the write intended, and R15's whole point is that such a row is a
 * personal-fenced reader holding a work document's content.
 *
 * The escaping cases below look pedantic until you notice what an origin
 * actually is: a credential label, chosen by whoever provisioned the connector.
 * `work "primary"` and `domain\\account` are ordinary strings for that, and both
 * break an unescaped literal — one silently, by ending an element early.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { textArrayLiteral } from '../../../src/core/write/pg-values.ts';
import { ingestDocument } from '../../../src/core/write/write-path.ts';
import {
  CALLER,
  TENANT,
  createGateway,
  createTenantFixture,
  uncappedBudget,
  type TenantFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;

let tenant: TenantFixture;

beforeAll(async () => {
  tenant = await createTenantFixture('writevalues');
}, { timeout: SETUP_TIMEOUT_MS });

afterAll(async () => {
  if (tenant !== undefined) await tenant.close();
}, { timeout: SETUP_TIMEOUT_MS });

describe('the literal is quoted and escaped', () => {
  test('ordinary values', () => {
    expect(textArrayLiteral(['personal'])).toBe('{"personal"}');
    expect(textArrayLiteral(['personal', 'work'])).toBe('{"personal","work"}');
    expect(textArrayLiteral([])).toBe('{}');
  });

  test('a value containing a quote does not end its own element', () => {
    expect(textArrayLiteral(['work "primary"'])).toBe('{"work \\"primary\\""}');
  });

  test('a value containing a backslash keeps it', () => {
    expect(textArrayLiteral(['domain\\account'])).toBe('{"domain\\\\account"}');
  });

  test('a value containing a comma stays one element', () => {
    expect(textArrayLiteral(['a,b'])).toBe('{"a,b"}');
  });
});

describe('the round trip through the database is exact', () => {
  test('an origin with a quote, a backslash and a comma survives as one element', async () => {
    // Written through the real write path rather than a hand-built INSERT: the
    // question is whether *this* code puts the origin in the column intact.
    const awkward = 'work "primary", domain\\account';
    const harness = createGateway();
    const receipt = await ingestDocument(
      {
        sql: tenant.sql,
        gateway: harness.gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget(),
      },
      {
        originContext: awkward,
        sourceType: 'document',
        title: null,
        body: 'Marcus Fell founded Kettle Works.',
      },
    );

    expect(receipt.ok).toBe(true);

    const facts = (await tenant.sql`
      SELECT origin_contexts AS origins FROM fact
    `) as Array<{ origins: string[] }>;
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) expect(fact.origins).toEqual([awkward]);

    const entities = (await tenant.sql`
      SELECT origin_contexts AS origins FROM entity WHERE deleted_at IS NULL
    `) as Array<{ origins: string[] }>;
    expect(entities.length).toBeGreaterThan(0);
    for (const entity of entities) expect(entity.origins).toEqual([awkward]);

    const edges = (await tenant.sql`
      SELECT origin_contexts AS origins FROM entity_edge WHERE deleted_at IS NULL
    `) as Array<{ origins: string[] }>;
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) expect(edge.origins).toEqual([awkward]);
  }, TEST_TIMEOUT_MS);
});
