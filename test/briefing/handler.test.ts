/**
 * `briefing` over the wire: the envelope, the demarcation, and the notice lane.
 *
 * **The assertion this file exists for is the one that runs in both
 * directions.** Before U11 there was nothing materialised to assemble over, so
 * the handler stamped `briefing_degraded` unconditionally and the envelope was
 * always right by accident. Keeping that after the cycle ships inverts the
 * honesty: a fully consolidated brain would keep announcing that its participant
 * cards are missing while returning them. So a cold brain is asserted degraded
 * **and** a warm one is asserted not degraded, over the same seeded rows.
 *
 * The rest is the surface's own rules, applied to lanes U12 added: a
 * participant card is a model's summary of mail an outsider wrote, so it is
 * demarcated like any other row content, and the upgrade prompt rides the
 * bounded advisory lane rather than the payload.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { collectBriefing } from '../../src/core/briefing/assemble.ts';
import { DEBT_THRESHOLDS } from '../../src/core/briefing/prompt.ts';
import { createMcpFixture, type McpFixture } from '../mcp/fixture.ts';
import { CALENDAR, MAIL, seedBrain, seedMeeting, warmLayer, type SeededBrain } from './fixture.ts';

const AT = '2026-08-13T09:00:00.000Z';
const WINDOW = { since: '2026-08-12T00:00:00.000Z', until: '2026-08-14T00:00:00.000Z' };

describe('the envelope tells the truth in both directions', () => {
  let fixture: McpFixture;
  let brain: SeededBrain;

  beforeAll(async () => {
    fixture = await createMcpFixture('u12_handler', { startAt: Date.parse('2026-08-13T18:00:00.000Z') });
    brain = await seedBrain(fixture.sql, AT);
  });
  afterAll(async () => {
    await fixture.close();
  });

  test('a cold brain is marked degraded and names what is missing', async () => {
    const result = await fixture.call('briefing', WINDOW);
    expect(result.ok).toBe(true);
    expect(result.envelope.degraded?.kind).toBe('briefing_degraded');
    expect(result.envelope.degraded?.reasons).toContain('consolidation_pending');
    expect(result.resultClass).toBe('degraded');

    const content = result.content as { coverage: string; not_included: string[] };
    expect(content.coverage).toBe('cold');
    expect(content.not_included).toContain('participant_cards');
  });

  test('THE SAME BRAIN, CONSOLIDATED, IS NOT DEGRADED', async () => {
    // The half an unconditional stamp passes without. `degradedBriefing` used to
    // return a value rather than a nullable one, so this could not be written.
    await warmLayer(fixture.sql, brain, AT);
    // Consolidation embeds nothing, so the embedding backlog would keep this
    // response degraded for a reason that has nothing to do with U12's question.
    await fixture.sql`UPDATE chunk SET embedding = ${`[1${',0'.repeat(1535)}]`}::vector WHERE embedding IS NULL`;
    await fixture.sql`DELETE FROM briefing_cursor`;

    const result = await fixture.call('briefing', WINDOW);
    expect(result.ok).toBe(true);
    expect(result.envelope.degraded).toBeUndefined();
    expect(result.resultClass).toBe('ok');

    const content = result.content as { coverage: string; not_included: string[] };
    expect(content.coverage).toBe('materialized');
    expect(content.not_included).toEqual([]);
  });

  test('a participant card is demarcated like any other external row content', async () => {
    await fixture.sql`DELETE FROM briefing_cursor`;
    const result = await fixture.call('briefing', WINDOW);
    const content = result.content as {
      meetings: Array<{ participants: Array<{ name: string; card: string | null }> }>;
    };
    const card = content.meetings.flatMap((meeting) => meeting.participants)[0]?.card ?? '';
    expect(card.length).toBeGreaterThan(0);
    // A card is a model's summary of mail an outsider wrote. Returning it
    // outside the untrusted region is the same laundering R2a's wrapper exists
    // to prevent, one derivation removed.
    expect(card).toContain('UNTRUSTED-CONTENT');
  });

  test('the counts ride the payload and the ids are opaque', async () => {
    await fixture.sql`DELETE FROM briefing_cursor`;
    const result = await fixture.call('briefing', WINDOW);
    const content = result.content as {
      counts: Record<string, number>;
      commitments: Array<{ id: string; corroborated: boolean }>;
      stale: Array<{ id: string; relevance: number | null }>;
    };
    expect(Object.keys(content.counts).sort()).toEqual([
      'contradictions',
      'pending_debt',
      'pending_review',
      'uncorroborated_claims',
    ]);
    for (const commitment of content.commitments) expect(commitment.id).toMatch(/^fact:/);
    for (const entry of content.stale) expect(entry.id).toMatch(/^doc:/);
  });
});

/**
 * What the envelope says a meeting's time is.
 *
 * The lane keys and sorts on `coalesce(occurred_at, created_at)` — when the call
 * *is* — and the envelope rendered `created_at`, when the poller heard about it.
 * A briefing that sorts by one time and prints the other is a bundle whose order
 * its own reader cannot reproduce, and the gap is exactly one overnight sync.
 *
 * The fixture sets the two times to different instants for the same reason the
 * assembler's does: with `occurred_at == created_at` the two renderings are
 * indistinguishable, which is how this survived the rung that introduced it.
 */
describe('a meeting is rendered at the time it happens', () => {
  const OCCURRED = '2026-08-13T14:00:00.000Z';
  const ARRIVED = '2026-08-12T02:30:00.000Z';
  let fixture: McpFixture;

  beforeAll(async () => {
    fixture = await createMcpFixture('u12_occurred', {
      startAt: Date.parse('2026-08-13T18:00:00.000Z'),
    });
    await seedMeeting(fixture.sql, {
      origin: CALENDAR,
      title: 'Roadmap review',
      body: 'Roadmap review\nAttendees: priya@example.com',
      createdAt: ARRIVED,
      occurredAt: OCCURRED,
    });
    // A page the provider asserted no time for: the fallback has to render as
    // arrival rather than as null, the same way the lane windows it.
    await seedMeeting(fixture.sql, {
      origin: CALENDAR,
      title: 'Undated sync',
      body: 'Undated sync\nAttendees: nobody',
      createdAt: '2026-08-13T11:00:00.000Z',
      occurredAt: null,
    });
  });
  afterAll(async () => {
    await fixture.close();
  });

  test('the envelope carries the occurrence, not the arrival', async () => {
    const result = await fixture.call('briefing', {
      since: '2026-08-13T00:00:00.000Z',
      until: '2026-08-14T00:00:00.000Z',
    });
    const content = result.content as {
      meetings: Array<{ title: string; occurred_at: string; created_at: string }>;
    };
    const review = content.meetings.find((meeting) => meeting.title.includes('Roadmap review'));
    expect(review).toBeDefined();
    expect(review?.occurred_at).toBe(OCCURRED);
    // Arrival stays, under its own name. It is the projection's field and every
    // other lane renders it; dropping it here would make one lane's records a
    // different shape from the rest.
    expect(review?.created_at).toBe(ARRIVED);
  });

  test('a meeting the provider gave no time for falls back to arrival', async () => {
    const result = await fixture.call('briefing', {
      since: '2026-08-13T00:00:00.000Z',
      until: '2026-08-14T00:00:00.000Z',
    });
    const content = result.content as {
      meetings: Array<{ title: string; occurred_at: string; created_at: string }>;
    };
    const undated = content.meetings.find((meeting) => meeting.title.includes('Undated sync'));
    expect(undated?.occurred_at).toBe('2026-08-13T11:00:00.000Z');
    expect(undated?.occurred_at).toBe(undated?.created_at ?? '');
  });

  test('and the order the bundle prints is the order it sorted', async () => {
    // The 14:00 call arrived before the 11:00 one. Sorted by occurrence it is
    // first; sorted by arrival it is last, and a reader sorting the printed
    // `occurred_at` themselves would disagree with the server.
    const result = await fixture.call('briefing', {
      since: '2026-08-13T00:00:00.000Z',
      until: '2026-08-14T00:00:00.000Z',
    });
    const content = result.content as { meetings: Array<{ occurred_at: string }> };
    const printed = content.meetings.map((meeting) => meeting.occurred_at);
    // Without this the whole assertion passes on a list of `undefined`, which
    // is precisely the state the field is missing in.
    expect(printed.length).toBe(2);
    for (const at of printed) expect(Number.isNaN(Date.parse(at))).toBe(false);
    expect(printed).toEqual([...printed].sort().reverse());
  });
});

describe('the upgrade prompt rides the advisory lane, bounded', () => {
  let fixture: McpFixture;

  beforeAll(async () => {
    fixture = await createMcpFixture('u12_prompt', { startAt: Date.parse('2026-08-13T18:00:00.000Z') });
    await seedBrain(fixture.sql, AT);
    // Enough ingested pages, after no completed cycle, to cross the first band.
    for (let index = 0; index < DEBT_THRESHOLDS[0]!; index += 1) {
      await fixture.sql`
        INSERT INTO page (origin_context, source_type, title, created_at,
                          embedding_model, embedding_dimensions, chunker_version, normalizer_version, content_sha256)
        VALUES (${MAIL}, 'email', ${`Backlog ${index}`}, ${AT}::timestamptz,
                'fixture-model', 1536, 1, 1, ${'0'.repeat(64)})
      `;
    }
  });
  afterAll(async () => {
    await fixture.close();
  });

  test('it fires once on the crossing, in `notice` rather than in the payload', async () => {
    const first = await fixture.call('briefing', WINDOW);
    expect(first.envelope.notice?.length).toBe(1);
    const notice = first.envelope.notice?.[0] ?? '';
    expect(notice).toContain('waiting');
    // R12a's reachable path, and R8's rule about which counter it reads.
    expect(notice).toContain('remember');
    expect(notice.toLowerCase()).not.toContain('contradict');
  });

  test('AND IS SILENT THE NEXT MORNING — the bound, over the wire', async () => {
    fixture.advance(24 * 60 * 60 * 1000);
    const second = await fixture.call('briefing', {
      since: '2026-08-14T00:00:00.000Z',
      until: '2026-08-15T00:00:00.000Z',
    });
    expect(second.envelope.notice).toBeUndefined();
  });

  test('the debt counter is fenced: another origin\'s backlog is not yours', async () => {
    // The whole seeded backlog is mail. A credential that can read only the
    // calendar must not be told it owes for it — a debt counter that ignored
    // the grant would prompt every narrow connection about work it cannot see,
    // and would do it on the count of a brain it is not looking at.
    const window = {
      since: WINDOW.since,
      until: WINDOW.until,
      focus: null,
      callerKey: 'bearer:fenced',
      now: new Date(WINDOW.until),
      budgetTokens: 4000,
    };
    const narrow = await collectBriefing(fixture.sql, [CALENDAR], window);
    const wide = await collectBriefing(fixture.sql, [CALENDAR, MAIL], window);

    expect(wide.counts.pendingDebt).toBeGreaterThanOrEqual(DEBT_THRESHOLDS[0]!);
    expect(narrow.counts.pendingDebt).toBeLessThan(DEBT_THRESHOLDS[0]!);
    // ...and it is not simply zero everywhere: the calendar's own live page is
    // still this credential's backlog.
    expect(narrow.counts.pendingDebt).toBeGreaterThan(0);
  });
});
