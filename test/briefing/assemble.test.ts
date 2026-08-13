/**
 * `briefing` over the materialised layer — the flagship read, and the three
 * properties that decide whether it is one.
 *
 * **1. A cold layer degrades; it does not error.** A brain that has never
 * consolidated has no entity cards, no commitments and no synopsis. R8 says the
 * free briefing *names what the paid tier would add* rather than being silently
 * thinner. The trap is that this passes trivially when the fixture can only ever
 * be cold, so every assertion below has a warm twin over the identical brain
 * (`fixture.ts:warmLayer`) — and the warm twin asserts the degraded markers are
 * *gone*, which is the half that actually catches an unconditional return.
 *
 * **2. The delta is per-caller, and the cursor advances.** "A snapshot with no
 * delta is a dashboard, not a briefing." Two briefings with no writes between
 * them must produce an empty second delta — which is only a real assertion if
 * the first one was non-empty, so it is asserted first, every time.
 *
 * **3. Assembly is SQL over what U11 already materialised.** No request-time
 * fan-out that scales with corpus size, and no model call: the whole point is a
 * read that is still fast at 100k pages.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  briefing as assembleOverSql,
  collectBriefing,
  BRIEFING_NOT_INCLUDED,
} from '../../src/core/briefing/assemble.ts';
import { createMcpFixture, type McpFixture } from '../mcp/fixture.ts';
import {
  CALENDAR,
  MAIL,
  WORK,
  contentCensus,
  recordRun,
  seedBrain,
  warmLayer,
  type SeededBrain,
} from './fixture.ts';

const AT = '2026-08-13T09:00:00.000Z';
const SINCE = '2026-08-12T00:00:00.000Z';
const UNTIL = '2026-08-14T00:00:00.000Z';
const GRANT = [CALENDAR, MAIL];

function request(overrides: Record<string, unknown> = {}) {
  return {
    since: SINCE,
    until: UNTIL,
    focus: null,
    callerKey: 'bearer:test',
    now: new Date(UNTIL),
    budgetTokens: 8000,
    ...overrides,
  } as Parameters<typeof assembleOverSql>[2];
}

describe('a cold materialised layer', () => {
  let fixture: McpFixture;
  let brain: SeededBrain;

  beforeAll(async () => {
    fixture = await createMcpFixture('u12_cold');
    brain = await seedBrain(fixture.sql, AT);
  });
  afterAll(async () => {
    await fixture.close();
  });

  test('returns the degraded shape rather than an error', async () => {
    const bundle = await assembleOverSql(fixture.sql, GRANT, request());
    expect(bundle.coverage).toBe('cold');
    expect([...bundle.notIncluded].sort()).toEqual([...BRIEFING_NOT_INCLUDED].sort());
  });

  test("today's meetings are still there — retrieval does not need consolidation", async () => {
    const bundle = await assembleOverSql(fixture.sql, GRANT, request({ callerKey: 'bearer:cold-2' }));
    expect(bundle.meetings.map((meeting) => meeting.title)).toContain('Roadmap review');
    // ...but with nobody attached, because participant cards are U11's output.
    for (const meeting of bundle.meetings) expect(meeting.participants).toEqual([]);
    expect(bundle.commitments).toEqual([]);
  });

  test('a free-tier cycle that ran and did not dream is still a cold layer', async () => {
    // R8's line, exactly: the free tier runs the deterministic phases, so a run
    // record exists and the model-tier artifacts still do not.
    await recordRun(fixture.sql, AT, { tier: 'free', dreamt: false });
    const bundle = await assembleOverSql(fixture.sql, GRANT, request({ callerKey: 'bearer:cold-3' }));
    expect(bundle.coverage).toBe('cold');
    expect(bundle.tier).toBe('free');
  });

  test('the fence holds: a page outside the grant is never in the bundle', async () => {
    const bundle = await assembleOverSql(fixture.sql, GRANT, request({ callerKey: 'bearer:cold-4' }));
    const everything = JSON.stringify(bundle);
    expect(everything).not.toContain('Board packet');
    expect(everything).not.toContain(WORK);
    expect(brain.fencedPageId.length).toBeGreaterThan(0);
  });
});

describe('a warm materialised layer — the same brain, consolidated', () => {
  let fixture: McpFixture;
  let brain: SeededBrain;

  beforeAll(async () => {
    fixture = await createMcpFixture('u12_warm');
    brain = await seedBrain(fixture.sql, AT);
    await warmLayer(fixture.sql, brain, AT, { contradictions: 3, pendingReview: 2 });
  });
  afterAll(async () => {
    await fixture.close();
  });

  test('stops being degraded, and says nothing is missing', async () => {
    const bundle = await assembleOverSql(fixture.sql, GRANT, request());
    expect(bundle.coverage).toBe('materialized');
    expect(bundle.notIncluded).toEqual([]);
  });

  test('the meeting carries its participant card', async () => {
    const bundle = await assembleOverSql(fixture.sql, GRANT, request({ callerKey: 'bearer:warm-2' }));
    const meeting = bundle.meetings.find((entry) => entry.title === 'Roadmap review');
    expect(meeting?.participants.map((person) => person.name)).toEqual(['Priya Raghavan']);
    expect(meeting?.participants[0]?.card).toContain('renewal');
  });

  test('open commitments are carried, closed ones are not', async () => {
    await fixture.sql`UPDATE commitment SET state = 'done' WHERE statement LIKE 'Send Priya%'`;
    const closed = await assembleOverSql(fixture.sql, GRANT, request({ callerKey: 'bearer:warm-3' }));
    expect(closed.commitments).toEqual([]);
    await fixture.sql`UPDATE commitment SET state = 'open' WHERE statement LIKE 'Send Priya%'`;
    const open = await assembleOverSql(fixture.sql, GRANT, request({ callerKey: 'bearer:warm-4' }));
    expect(open.commitments.map((entry) => entry.statement)).toEqual(['Send Priya the renewal redline']);
  });

  test('a stale page is flagged with its relevance rather than dropped', async () => {
    const bundle = await assembleOverSql(fixture.sql, GRANT, request({ callerKey: 'bearer:warm-5' }));
    const stale = bundle.stale.find((entry) => entry.title === 'Cancelled offsite');
    expect(stale).toBeDefined();
    expect(stale?.relevance).toBeCloseTo(0.9, 5);
  });

  test('the contradiction count is a count and nothing more', async () => {
    const bundle = await assembleOverSql(fixture.sql, GRANT, request({ callerKey: 'bearer:warm-6' }));
    expect(bundle.counts.contradictions).toBe(3);
    expect(bundle.counts.pendingReview).toBe(2);
  });

  test('a brain full of contradictions and no debt is never prompted', async () => {
    // R8's rule, behaviourally: the prompt reads `pending_debt`, and a
    // contradiction-gated one would render empty for the tier it exists to
    // convert. Here there is plenty to be alarmed about and nothing to convert.
    const bundle = await assembleOverSql(fixture.sql, GRANT, request({ callerKey: 'bearer:warm-7' }));
    expect(bundle.counts.contradictions).toBeGreaterThan(0);
    expect(bundle.prompt).toBeNull();
  });
});

describe('the per-caller read cursor', () => {
  let fixture: McpFixture;
  let brain: SeededBrain;

  beforeAll(async () => {
    fixture = await createMcpFixture('u12_cursor');
    brain = await seedBrain(fixture.sql, AT);
    await warmLayer(fixture.sql, brain, AT);
  });
  afterAll(async () => {
    await fixture.close();
  });

  test('first read is a first read, and its delta is not empty', async () => {
    const first = await assembleOverSql(fixture.sql, GRANT, request({ callerKey: 'bearer:alice' }));
    expect(first.delta.firstRead).toBe(true);
    // The assertion the empty-second-delta test is worthless without.
    expect(first.delta.changed.length).toBeGreaterThan(0);
  });

  test('SECOND READ WITH NO WRITES HAS AN EMPTY DELTA — the cursor itself', async () => {
    const second = await assembleOverSql(
      fixture.sql,
      GRANT,
      request({ callerKey: 'bearer:alice', now: new Date('2026-08-14T09:00:00.000Z') }),
    );
    expect(second.delta.firstRead).toBe(false);
    expect(second.delta.changed).toEqual([]);
    expect(second.delta.stated).toEqual([]);
  });

  test('a write after the cursor shows up in the next delta', async () => {
    await fixture.sql`
      INSERT INTO page (origin_context, source_type, title, created_at,
                        embedding_model, embedding_dimensions, chunker_version, normalizer_version, content_sha256)
      VALUES (${MAIL}, 'email', 'Redline attached', '2026-08-14T10:00:00Z'::timestamptz,
              'fixture-model', 1536, 1, 1, ${'0'.repeat(64)})
    `;
    const third = await assembleOverSql(
      fixture.sql,
      GRANT,
      request({
        callerKey: 'bearer:alice',
        since: '2026-08-14T00:00:00.000Z',
        until: '2026-08-15T00:00:00.000Z',
        now: new Date('2026-08-15T00:00:00.000Z'),
      }),
    );
    expect(third.delta.changed.map((entry) => entry.title)).toContain('Redline attached');
  });

  test('the cursor is per caller: a second credential still gets its first read', async () => {
    const other = await assembleOverSql(
      fixture.sql,
      GRANT,
      request({ callerKey: 'bearer:bob', now: new Date('2026-08-15T00:00:00.000Z') }),
    );
    expect(other.delta.firstRead).toBe(true);
    expect(other.delta.changed.length).toBeGreaterThan(0);
  });

  test('the cursor never moves backwards', async () => {
    // Two clients of one credential, or a retried scheduled task with a stale
    // clock. A cursor that took the last value it was handed would re-play
    // everything since the older read, forever.
    const before = await readCursor(fixture, 'bearer:alice');
    await assembleOverSql(
      fixture.sql,
      GRANT,
      request({
        callerKey: 'bearer:alice',
        since: '2026-01-01T00:00:00.000Z',
        until: '2026-01-02T00:00:00.000Z',
        now: new Date('2026-01-02T00:00:00.000Z'),
      }),
    );
    const after = await readCursor(fixture, 'bearer:alice');
    expect(Date.parse(after ?? '')).toBeGreaterThanOrEqual(Date.parse(before ?? ''));
  });

  test('a briefing writes nothing but its own bookmark', async () => {
    // `briefing` is annotated `readOnlyHint: true`, and the only thing that
    // keeps that honest is that the cursor rung is the sole table it touches.
    const before = await contentCensus(fixture.sql);
    await assembleOverSql(fixture.sql, GRANT, request({ callerKey: 'bearer:census' }));
    expect(await contentCensus(fixture.sql)).toEqual(before);
  });
});

async function readCursor(fixture: McpFixture, callerKey: string): Promise<string | null> {
  const rows = (await fixture.sql`
    SELECT to_char(last_read_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at
      FROM briefing_cursor WHERE caller_key = ${callerKey}
  `) as Array<{ at: string | null }>;
  return rows[0]?.at ?? null;
}

describe('assembly is SQL over what is already materialised', () => {
  let fixture: McpFixture;

  beforeAll(async () => {
    fixture = await createMcpFixture('u12_shape');
    const brain = await seedBrain(fixture.sql, AT);
    await warmLayer(fixture.sql, brain, AT);
  });
  afterAll(async () => {
    await fixture.close();
  });

  test('collect and assemble are separable, so the pure half can be graded', async () => {
    // The blocking tier grades `assembleBriefing` over fixtures; the database
    // half is what this suite covers. A single monolith would put the briefing
    // outside the zero-model-call tier entirely.
    const source = await collectBriefing(fixture.sql, GRANT, request());
    expect(source.meetings.length).toBeGreaterThan(0);
    expect(source.layer.dreamt).toBe(true);
  });

  test('a focus narrows the bundle', async () => {
    const focused = await assembleOverSql(
      fixture.sql,
      GRANT,
      request({ callerKey: 'bearer:focus', focus: 'Roadmap' }),
    );
    expect(focused.meetings.map((entry) => entry.title)).toEqual(['Roadmap review']);
  });

  test('the token budget drops whole rows from the tail, never half of one', async () => {
    const tiny = await assembleOverSql(
      fixture.sql,
      GRANT,
      request({ callerKey: 'bearer:tiny', budgetTokens: 1 }),
    );
    for (const record of [...tiny.delta.changed, ...tiny.delta.stated]) {
      expect(record.text.length).toBeGreaterThan(0);
    }
    expect(tiny.tokens).toBeGreaterThanOrEqual(0);
  });
});
