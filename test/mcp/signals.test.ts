/**
 * The control-plane signals KTD11's trigger consumes, and `search_degraded`.
 *
 * **Dispatch produces these; the scheduler consumes them.** U10's "who is due"
 * query reads `pending_debt`, `last_activity` and `next_due_at` off
 * `control.tenant`. Nothing wrote them until now, which means the debounce has
 * been correct and inert. The three properties that make them safe to write from
 * the request path:
 *
 *   * **Debt increments on writes, not on reads.** A read that accrued debt
 *     would put every tenant with a chatty agent into a consolidation cycle they
 *     have no new content for.
 *   * **`last_activity` stamps user-originated calls only.** Connector polling
 *     accrues debt without resetting the quiet window — otherwise a busy mailbox
 *     starves the debounce forever and the time ceiling becomes the only trigger
 *     that ever fires.
 *   * **They are off the response critical path and throttled.** At most one
 *     stamp per tenant per 30 seconds, and a failing control plane must not turn
 *     a successful read into an error — `entity`'s warm-p99 promise is the thing
 *     these writes must not land on.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { ACTIVITY_THROTTLE_MS, createControlSignals } from '../../src/mcp/control-signals.ts';
import { createMcpFixture, seedPage, type McpFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

let fixture: McpFixture;

interface TenantSignals {
  readonly pending_debt: number;
  readonly last_activity: string | null;
  readonly rank1_score_sum: number;
  readonly rank1_sample_count: number;
}

async function readSignals(): Promise<TenantSignals> {
  const rows = (await fixture.controlSql`
    SELECT pending_debt, last_activity, rank1_score_sum, rank1_sample_count
      FROM control.tenant WHERE tenant_id = ${fixture.tenantId}
  `) as unknown as TenantSignals[];
  const row = rows[0];
  if (row === undefined) throw new Error('no control-plane row for the fixture tenant');
  return row;
}

beforeAll(async () => {
  fixture = await createMcpFixture('mcp_signals');
  await seedPage(fixture.sql, {
    id: 'signal-doc',
    title: 'A document to search for',
    sourceType: 'note',
    origin: 'personal:agent',
    createdAt: '2026-05-01',
    paragraphs: ['The quarterly figure was agreed at the review.'],
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

describe('debt', () => {
  test(
    'a write tool increments it and a read tool does not',
    async () => {
      const before = await readSignals();

      await fixture.call('recall', { query: 'quarterly figure' });
      await fixture.call('entity', { name: 'nobody' });
      await fixture.signals.flush();
      expect((await readSignals()).pending_debt).toBe(before.pending_debt);

      await fixture.call('remember', { statement: 'The review is on the first Tuesday of the month.' });
      await fixture.signals.flush();
      expect((await readSignals()).pending_debt).toBe(before.pending_debt + 1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('last_activity', () => {
  test(
    'is stamped on a user-originated call',
    async () => {
      await fixture.call('recall', { query: 'quarterly figure' });
      await fixture.signals.flush();
      const after = await readSignals();
      expect(after.last_activity).not.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'is throttled to at most one stamp per tenant per 30 seconds',
    async () => {
      const stamps: number[] = [];
      let clock = Date.UTC(2026, 7, 13, 10, 0, 0);
      const signals = createControlSignals({
        now: () => clock,
        sink: {
          apply(_tenantId, delta) {
            if (delta.activityAt !== null) stamps.push(clock);
            return Promise.resolve();
          },
        },
      });

      // Flushed between every call, so the throttle is measured on the writes
      // that actually reach the control plane rather than on one coalesced
      // batch — a batch hides a missing throttle completely.
      for (let i = 0; i < 5; i += 1) {
        signals.record({ tenantId: 't', userOriginated: true, debt: 0 });
        await signals.flush();
        clock += 1_000;
      }
      expect(stamps).toHaveLength(1);

      clock += ACTIVITY_THROTTLE_MS;
      signals.record({ tenantId: 't', userOriginated: true, debt: 0 });
      await signals.flush();
      expect(stamps).toHaveLength(2);
    },
  );

  test('a throttled window still banks the debt that arrived inside it', async () => {
    let clock = 0;
    const applied: number[] = [];
    const signals = createControlSignals({
      now: () => clock,
      sink: {
        apply(_tenantId, delta) {
          applied.push(delta.debt);
          return Promise.resolve();
        },
      },
    });

    signals.record({ tenantId: 't', userOriginated: true, debt: 1 });
    signals.record({ tenantId: 't', userOriginated: true, debt: 1 });
    signals.record({ tenantId: 't', userOriginated: true, debt: 1 });
    await signals.flush();

    expect(applied.reduce((sum, n) => sum + n, 0)).toBe(3);
  });
});

describe('the rank-1 quality sample', () => {
  test(
    'is content-free: a score and a count, never a query or a row',
    async () => {
      const before = await readSignals();
      const result = await fixture.call('recall', { query: 'quarterly figure' });
      expect((result.content as { results: unknown[] }).results.length).toBeGreaterThan(0);
      await fixture.signals.flush();

      const after = await readSignals();
      expect(after.rank1_sample_count).toBeGreaterThan(before.rank1_sample_count);
      expect(after.rank1_score_sum).toBeGreaterThan(before.rank1_score_sum);

      // The whole row, not just the columns this test moved: the control plane
      // holds counters and timestamps for this tenant and no words at all.
      const serialised = JSON.stringify(after);
      expect(serialised).not.toContain('quarterly');
      expect(serialised).not.toContain('figure');
      expect(serialised).not.toContain('review');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('off the critical path', () => {
  test('a flush against a refusing sink resolves rather than rejecting', async () => {
    // Asserted on the recorder itself, not only through dispatch. Dispatch also
    // catches, so a recorder that rethrew would still leave the tool call green
    // — and the next caller of `flush()` (a shutdown hook, a test, U10) would
    // be the one to discover it.
    const signals = createControlSignals({
      now: () => 0,
      sink: {
        apply() {
          return Promise.reject(new Error('the control plane is having a day'));
        },
      },
    });

    signals.record({ tenantId: 't', userOriginated: true, debt: 1 });
    await signals.flush();
    expect(signals.failures).toBe(1);
  });

  test(
    'a control plane that refuses every write does not fail the tool call',
    async () => {
      const broken = await createMcpFixture('mcp_signals_broken', {
        sink: () => ({
          apply() {
            return Promise.reject(new Error('the control plane is having a day'));
          },
        }),
      });
      try {
        const result = await broken.call('remember', { statement: 'A fact that must still be stored.' });
        expect(result.ok).toBe(true);
        await broken.signals.flush();
        expect(broken.signals.failures).toBeGreaterThan(0);
      } finally {
        await broken.close();
      }
    },
    SETUP_TIMEOUT_MS,
  );

  test('the throttle constant is the one KTD11 names', () => {
    expect(ACTIVITY_THROTTLE_MS).toBe(30_000);
  });
});

describe('search_degraded on a real tenant', () => {
  test(
    'a brand-new tenant with nothing indexed gets the named shape, not an empty success',
    async () => {
      const empty = await createMcpFixture('mcp_degraded_empty');
      try {
        const result = await empty.call('recall', { query: 'anything at all' });
        expect(result.ok).toBe(true);
        expect(result.resultClass).toBe('degraded');
        expect(result.envelope.degraded?.kind).toBe('search_degraded');
        expect(result.envelope.degraded?.reasons).toContain('no_content_yet');
        expect((result.content as { results: unknown[] }).results).toHaveLength(0);

        // …and it says what would help, which is the whole point of the shape.
        expect(result.envelope.setup).toBeDefined();
      } finally {
        await empty.close();
      }
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'a tenant mid-import — chunks written, embeddings pending — is degraded, not whole',
    async () => {
      const partial = await createMcpFixture('mcp_degraded_partial');
      try {
        await seedPage(partial.sql, {
          id: 'unembedded',
          title: 'An imported document',
          sourceType: 'email',
          origin: 'personal:mail',
          createdAt: '2026-05-01',
          paragraphs: ['This passage has no embedding yet.'],
        });

        const result = await partial.call('recall', { query: 'imported document' });
        expect(result.ok).toBe(true);
        expect(result.envelope.degraded?.kind).toBe('search_degraded');
        expect(result.envelope.degraded?.reasons).toContain('embedding_backlog');
      } finally {
        await partial.close();
      }
    },
    SETUP_TIMEOUT_MS,
  );

  test(
    'the briefing says its consolidation inputs are not there yet',
    async () => {
      const result = await fixture.call('briefing', {});
      expect(result.ok).toBe(true);
      expect(result.envelope.degraded?.kind).toBe('briefing_degraded');
      expect(result.envelope.degraded?.reasons).toContain('consolidation_pending');
    },
    TEST_TIMEOUT_MS,
  );
});
