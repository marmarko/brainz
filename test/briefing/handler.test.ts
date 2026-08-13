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
import { CALENDAR, MAIL, seedBrain, warmLayer, type SeededBrain } from './fixture.ts';

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
