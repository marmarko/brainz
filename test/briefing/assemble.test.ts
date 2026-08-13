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
  MEETINGS_STATEMENT,
} from '../../src/core/briefing/assemble.ts';
import { textArrayLiteral } from '../../src/core/write/pg-values.ts';
import { createMcpFixture, type McpFixture } from '../mcp/fixture.ts';
import {
  CALENDAR,
  MAIL,
  WORK,
  contentCensus,
  recordRun,
  seedBrain,
  seedMeeting,
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

  test('the meetings lane carries its own fence', async () => {
    // Its own statement, its own grant predicate. The assertion above passes
    // with that predicate deleted, because its out-of-grant row is an email.
    const bundle = await assembleOverSql(fixture.sql, GRANT, request({ callerKey: 'bearer:cold-5' }));
    expect(bundle.meetings.map((meeting) => meeting.title)).not.toContain('Board session');
    // ...and the in-grant meeting IS there, so this is a fence rather than an
    // empty lane.
    expect(bundle.meetings.map((meeting) => meeting.title)).toContain('Roadmap review');

    const wide = await assembleOverSql(fixture.sql, [...GRANT, WORK], request({ callerKey: 'bearer:cold-6' }));
    expect(wide.meetings.map((meeting) => meeting.title)).toContain('Board session');
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

  test('pending debt is anchored on the last completed cycle', async () => {
    // Without the anchor this is a count of every page the brain has ever held,
    // which grows forever and crosses every prompt threshold on a brain that is
    // fully consolidated. The completed run in `warmLayer` sits at AT, so a page
    // written before it is already accounted for and one written after is not.
    await fixture.sql`
      INSERT INTO page (origin_context, source_type, title, created_at,
                        embedding_model, embedding_dimensions, chunker_version, normalizer_version, content_sha256)
      VALUES (${MAIL}, 'email', 'Before the cycle', '2026-08-13T07:00:00Z'::timestamptz,
              'fixture-model', 1536, 1, 1, ${'0'.repeat(64)})
    `;
    const settled = await assembleOverSql(fixture.sql, GRANT, request({ callerKey: 'bearer:warm-debt-1' }));
    expect(settled.counts.pendingDebt).toBe(0);

    await fixture.sql`
      INSERT INTO page (origin_context, source_type, title, created_at,
                        embedding_model, embedding_dimensions, chunker_version, normalizer_version, content_sha256)
      VALUES (${MAIL}, 'email', 'After the cycle', '2026-08-13T11:00:00Z'::timestamptz,
              'fixture-model', 1536, 1, 1, ${'0'.repeat(64)})
    `;
    const owed = await assembleOverSql(fixture.sql, GRANT, request({ callerKey: 'bearer:warm-debt-2' }));
    expect(owed.counts.pendingDebt).toBe(1);
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

/**
 * The meetings lane, keyed on when the meeting *is*.
 *
 * The whole point of this block is a fixture that can tell the two times apart.
 * Every row below sets `occurred_at` and `created_at` to different instants, and
 * the window is one day wide — narrow enough that "arrived yesterday" is outside
 * it on arrival and inside it on occurrence. With a two-day window, or with
 * `occurred_at == created_at` on every row, a lane keyed on arrival passes every
 * assertion here, which is how it stayed keyed on arrival.
 */
describe("today's meetings are the ones happening today", () => {
  const TODAY_SINCE = '2026-08-13T00:00:00.000Z';
  const TODAY_UNTIL = '2026-08-14T00:00:00.000Z';
  const today = (overrides: Record<string, unknown> = {}) =>
    request({ since: TODAY_SINCE, until: TODAY_UNTIL, now: new Date(TODAY_UNTIL), ...overrides });

  let fixture: McpFixture;

  beforeAll(async () => {
    fixture = await createMcpFixture('u12_occurrence');
    // 'Roadmap review' arrives here with occurred_at NULL — the pre-rung-5 row,
    // and the fixture for the fallback.
    await seedBrain(fixture.sql, AT);

    // The headline case: synced last night, happening this morning. Outside the
    // window on arrival, inside it on occurrence.
    await seedMeeting(fixture.sql, {
      origin: CALENDAR,
      title: 'Standup',
      body: 'Standup\nWhen: 2026-08-13T10:00:00Z',
      createdAt: '2026-08-12T18:00:00.000Z',
      occurredAt: '2026-08-13T10:00:00.000Z',
    });

    // The inverse, and the half a one-sided fixture misses: an old meeting
    // re-fetched this morning. Inside the window on arrival, outside on
    // occurrence.
    await seedMeeting(fixture.sql, {
      origin: CALENDAR,
      title: 'Retro from Tuesday',
      body: 'Retro\nWhen: 2026-08-11T10:00:00Z',
      createdAt: '2026-08-13T09:30:00.000Z',
      occurredAt: '2026-08-11T10:00:00.000Z',
    });

    // Provider-asserted, so it must not widen anything: a meeting behind a
    // fence this grant does not carry, occurring squarely inside the window.
    await seedMeeting(fixture.sql, {
      origin: WORK,
      title: 'Board session today',
      body: 'Board session\nWhen: 2026-08-13T11:00:00Z',
      createdAt: '2026-08-13T08:00:00.000Z',
      occurredAt: '2026-08-13T11:00:00.000Z',
    });
  });
  afterAll(async () => {
    await fixture.close();
  });

  test('a meeting that arrived yesterday for a call today is in this morning’s briefing', async () => {
    const bundle = await assembleOverSql(fixture.sql, GRANT, today({ callerKey: 'bearer:occ-1' }));
    expect(bundle.meetings.map((meeting) => meeting.title)).toContain('Standup');
  });

  test('a meeting that arrived today for a call on Tuesday is not', async () => {
    const bundle = await assembleOverSql(fixture.sql, GRANT, today({ callerKey: 'bearer:occ-2' }));
    expect(bundle.meetings.map((meeting) => meeting.title)).not.toContain('Retro from Tuesday');
  });

  test('a page written before the rung keeps the behaviour it has today', async () => {
    // The backfill story, pinned: rows with no occurred_at fall back to
    // created_at, so nothing that appears in a briefing this morning disappears
    // from tomorrow's. There is no data backfill — see rung 5's header on why
    // writing created_at into a provider-asserted column is worse than a null.
    const bundle = await assembleOverSql(fixture.sql, GRANT, today({ callerKey: 'bearer:occ-3' }));
    expect(bundle.meetings.map((meeting) => meeting.title)).toContain('Roadmap review');

    const rows = (await fixture.sql`
      SELECT count(*)::int AS n FROM page WHERE title = 'Roadmap review' AND occurred_at IS NULL
    `) as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(1);
  });

  test('the lane sorts by occurrence too, not just filters by it', async () => {
    // Standup occurs at 10:00 and arrived at 18:00 yesterday; the roadmap review
    // falls back to its 09:00 arrival. Sorted by arrival, Standup is last.
    const bundle = await assembleOverSql(fixture.sql, GRANT, today({ callerKey: 'bearer:occ-4' }));
    const titles = bundle.meetings.map((meeting) => meeting.title);
    // Both present first: `indexOf` returns -1 for an absent title, and -1 is
    // less than everything, so an ordering assertion on its own is green for a
    // lane that dropped the row entirely.
    expect(titles).toContain('Standup');
    expect(titles).toContain('Roadmap review');
    expect(titles.indexOf('Standup')).toBeLessThan(titles.indexOf('Roadmap review'));
  });

  test('an event time cannot reach across the fence', async () => {
    // `occurred_at` is a value an outside sender chooses. It orders and it
    // windows; it decides nothing about access.
    const bundle = await assembleOverSql(fixture.sql, GRANT, today({ callerKey: 'bearer:occ-5' }));
    expect(bundle.meetings.map((meeting) => meeting.title)).not.toContain('Board session today');
    const wide = await assembleOverSql(
      fixture.sql,
      [CALENDAR, MAIL, WORK],
      today({ callerKey: 'bearer:occ-6' }),
    );
    expect(wide.meetings.map((meeting) => meeting.title)).toContain('Board session today');
  });

  test('the lane is a range scan on the index rung 5 declares', async () => {
    // U12 kept this lane a bounded range scan on purpose — the payload is
    // bounded by the window, not by the corpus. Re-keying it onto an expression
    // no index carries would make the flagship read a sequential scan over every
    // page in the brain, and nothing but the clock would say so.
    const text = await fixture.sql.begin(async (tx) => {
      // A fixture brain is small enough that the planner would take a
      // sequential scan on cost alone. Penalising it does not *create* an index
      // scan — if the lane's expression matched no index, the plan would still
      // be a scan of `page` — so the assertion still fails when the two spellings
      // drift apart.
      await tx.unsafe('SET LOCAL enable_seqscan = off');
      const plan = (await tx.unsafe(`EXPLAIN ${MEETINGS_STATEMENT}`, [
        textArrayLiteral(GRANT),
        TODAY_SINCE,
        TODAY_UNTIL,
        null,
      ])) as Array<Record<string, string>>;
      return plan.map((row) => Object.values(row).join(' ')).join('\n');
    });
    expect(text).toContain('page_live_by_occurrence');
    // Naming the index is not enough: it leads on `origin_context`, so the
    // planner reaches for it on the fence predicate alone even while the window
    // is a post-scan filter on a different column. What makes this a range scan
    // is the window living in the *index condition*.
    const conditions = text.split('\n').filter((line) => line.includes('Index Cond'));
    expect(conditions.some((line) => line.includes('COALESCE'))).toBe(true);
  });
});

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
