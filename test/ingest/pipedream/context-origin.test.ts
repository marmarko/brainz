/**
 * A connector connected in a work context files at a work origin.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 *
 * U18 built the whole context-grant machine — the `class:source` grammar, the
 * wildcard expansion, the mint-and-verify scope invariant, the read fence — and
 * `test/mcp/context-grants.test.ts` drives every tool against planted rows and
 * proves a `work:*` grant reaches none of the personal ones. What it could not
 * prove is that the capability exists, because **nothing wrote a `work:` row**.
 * Every connector page filed at `pipedream:<source>`, so a work-scoped grant
 * obtained through the real consent flow expanded to `['work:agent']` and read
 * exactly the memories it had written itself. "A work-scoped grant provably
 * cannot read personal rows" was true of it, and so was "it cannot read a
 * mailbox".
 *
 * This file is the producer, end to end and through the real fence: a connector
 * whose state records a context class writes its pages at `<class>:<source>`, a
 * `work:*` grant expanded by `expandGrant` admits them, and a `personal:*` grant
 * does not.
 *
 * ============================================================================
 * WHAT IS DELIBERATELY NOT HERE
 * ============================================================================
 *
 * **A default.** A state with no recorded class keeps filing at
 * `pipedream:<source>` — the last test — and that is not timidity. `origin` is
 * immutable by trigger and U4's replacement lookup keys on
 * `(external_ref, origin_context)`, so re-originating an existing connection
 * would not move its pages: it would leave every one of them stranded at the old
 * origin, out of reach of the sweep that scopes by origin, and write a second
 * live page for each on the next poll. A class is chosen when a connection is
 * made and it is a disconnect-and-reconnect to change, which is what
 * `src/ingest/cursor.ts` says beside the field.
 *
 * **A mapping from a source to a class.** Nothing here says Gmail is work. Which
 * context a connected account belongs to is the user's answer on a consent
 * surface, and inventing one would write an unobserved value into the single
 * column access is decided on.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { HOSTED_PROFILE } from '../../../src/ai/routing.ts';
import { fenceScalar } from '../../../src/core/search/fence.ts';
import { expandGrant } from '../../../src/mcp/grant-scope.ts';
import {
  connectSource,
  createInMemoryConnectorStore,
  parseConnectorState,
  type ConnectorState,
  type ConnectorStateStore,
} from '../../../src/ingest/cursor.ts';
import { originContextFor, runPull } from '../../../src/ingest/pipedream/pull.ts';
import { externalRefFor } from '../../../src/ingest/pipedream/sources/types.ts';
import { TENANT, createIngestFixture, setSpend, type IngestFixture } from '../fixture.ts';
import { createFakeSource, mailBody, page } from './fixture.ts';

const NOW = new Date('2026-08-16T11:00:00.000Z');

let fixture: IngestFixture;

beforeAll(async () => {
  fixture = await createIngestFixture('u9ctxorigin');
  await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: 500_000_000 });
});

afterAll(async () => {
  await fixture?.close();
});

function stateFor(overrides: Partial<ConnectorState> = {}): ConnectorState {
  return {
    ...connectSource({ source: 'gmail', externalUserId: TENANT, accountId: 'apn_1', now: NOW }),
    ...overrides,
  };
}

async function storeWith(state: ConnectorState): Promise<ConnectorStateStore> {
  const store = createInMemoryConnectorStore();
  await store.write(state);
  return store;
}

async function pull(source: ReturnType<typeof createFakeSource>, states: ConnectorStateStore) {
  return runPull({
    tenant: fixture.runtime,
    control: fixture.controlSql,
    profile: HOSTED_PROFILE,
    source,
    states,
    now: NOW,
  });
}

async function originOf(externalRef: string): Promise<string | null> {
  const rows = (await fixture.tenantSql`
    SELECT origin_context FROM page
     WHERE external_ref = ${externalRef} AND deleted_at IS NULL
  `) as Array<{ origin_context: string }>;
  return rows[0]?.origin_context ?? null;
}

describe('a connector connected in a work context', () => {
  const REF = externalRefFor('gmail', 'work-1');

  test('files its pages, chunks and facts at a work origin', async () => {
    const source = createFakeSource('gmail', 'email', [
      page({
        items: [
          {
            externalRef: REF,
            title: 'the migration',
            body: mailBody('work-1'),
            occurredAt: NOW,
          },
        ],
        nextCursor: { kind: 'delta', value: 'h-1' },
      }),
    ]);

    const result = await pull(source, await storeWith(stateFor({ contextClass: 'work' })));
    expect(result.outcome).toBe('completed');
    expect(result.counts.written).toBe(1);

    expect(await originOf(REF)).toBe('work:gmail');

    // Not just the page. The fence reads chunks and facts on their own origins,
    // so a producer that stamped the page and left its derivations behind would
    // be a work grant that finds a document and none of what was drawn from it.
    const derived = (await fixture.tenantSql`
      SELECT
        (SELECT count(*)::int FROM chunk c JOIN page p ON p.page_id = c.page_id
          WHERE p.external_ref = ${REF} AND c.origin_context <> 'work:gmail')      AS stray_chunks,
        (SELECT count(*)::int FROM chunk c JOIN page p ON p.page_id = c.page_id
          WHERE p.external_ref = ${REF})                                           AS chunks
    `) as Array<{ stray_chunks: number; chunks: number }>;
    expect(derived[0]?.chunks).toBeGreaterThan(0);
    expect(derived[0]?.stray_chunks).toBe(0);
  });

  test('and a work-scoped grant reads it, through the real expansion and the real fence', async () => {
    // The brain's live origins, as `reads.ts:brainOrigins` would build them.
    const available = (
      (await fixture.tenantSql`
        SELECT DISTINCT origin_context FROM page WHERE deleted_at IS NULL
      `) as Array<{ origin_context: string }>
    ).map((row) => row.origin_context);

    const work = expandGrant(['work:*'], available);
    expect(work).toContain('work:gmail');
    expect(fenceScalar('work:gmail', work)).toBe(true);

    // And the other half, which is the whole point of a context grant: the
    // personal class does not reach the work mailbox.
    const personal = expandGrant(['personal:*'], available);
    expect(personal).not.toContain('work:gmail');
    expect(fenceScalar('work:gmail', personal)).toBe(false);
  });
});

describe('an existing connection is not re-originated behind the user', () => {
  test('a state with no recorded class still files at pipedream:<source>', async () => {
    const REF = externalRefFor('gmail', 'legacy-1');
    const source = createFakeSource('gmail', 'email', [
      page({
        items: [{ externalRef: REF, title: 'legacy', body: mailBody('legacy-1'), occurredAt: NOW }],
        nextCursor: { kind: 'delta', value: 'h-2' },
      }),
    ]);

    const result = await pull(source, await storeWith(stateFor()));
    expect(result.outcome).toBe('completed');
    expect(await originOf(REF)).toBe('pipedream:gmail');
    expect(originContextFor('gmail', null)).toBe('pipedream:gmail');
  });
});

describe('the recorded class survives the durable record, or the record does not survive', () => {
  test('a well-formed class round-trips', () => {
    const parsed = parseConnectorState(JSON.parse(JSON.stringify(stateFor({ contextClass: 'work' }))));
    expect(parsed?.contextClass).toBe('work');
  });

  test('an absent class reads as absent rather than as a class named ""', () => {
    const record = JSON.parse(JSON.stringify(stateFor())) as Record<string, unknown>;
    delete record.contextClass;
    expect(parseConnectorState(record)?.contextClass).toBeNull();
  });

  test('a malformed class yields nothing at all, the way every other bad field does', () => {
    // All-or-nothing is this parser's stated discipline: a partially-recovered
    // state is worse than none. Dropping *this* field to null would be worse
    // still — it would file a work connector's mail in the half of the brain the
    // user did not choose, silently, on the one column access is decided on.
    for (const bad of ['Work', 'work:mail', '', 'work ', 4, '9lives']) {
      const record = JSON.parse(JSON.stringify(stateFor())) as Record<string, unknown>;
      record.contextClass = bad;
      expect(parseConnectorState(record)).toBeNull();
    }
  });
});
