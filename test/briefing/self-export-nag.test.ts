/**
 * R18's backup reminder, over the wire — the reader `src/core/export/schedule.ts`
 * was written for and did not have.
 *
 * **What this is defending.** `selfExportNag` was a complete, tested, bounded
 * reminder whose own header says it "rides the same daily read the free→paid
 * prompt does". Nothing called it. `readExportState`, `readNagState`,
 * `readContentAge` and `recordNagShown` were likewise imported by nothing
 * outside their own test, so a user whose brain had never been backed up
 * anywhere they control was never told — while the module claimed in prose to be
 * riding a read that had never heard of it.
 *
 * **The three properties, and why each is here.**
 *
 *   1. **It fires, in `notice`.** Not in the payload: a reminder in the content
 *      lane is a reminder an agent has to decide whether to repeat, and R2a's
 *      advisory lane exists so it does not have to.
 *   2. **It is bounded.** The whole design of the module is that it is silent
 *      the next morning. A daily backup nag is worse than a daily sales pitch,
 *      because it is a nag about something the user cannot dismiss by buying
 *      anything — so the bound is asserted over the wire, on a second read, the
 *      way `test/briefing/handler.test.ts` asserts the upgrade prompt's.
 *   3. **It is fenced.** A credential that can read one origin must not be told
 *      how many documents the whole brain holds. Every other count in the
 *      briefing is fenced by the grant and this one is a count of pages, which
 *      is the most direct statement about corpus size the surface makes.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { collectBriefing } from '../../src/core/briefing/assemble.ts';
import { NAG_INTERVAL_DAYS, STALENESS_BANDS } from '../../src/core/export/schedule.ts';
import { createMcpFixture, type McpFixture } from '../mcp/fixture.ts';
import { CALENDAR, MAIL, WORK, seedBrain } from './fixture.ts';

const SEEDED_AT = '2026-08-13T09:00:00.000Z';
/** Far enough past the first band that the brain is unambiguously stale. */
const CLOCK = Date.parse('2026-09-20T09:00:00.000Z');
const WINDOW = { since: '2026-09-19T00:00:00.000Z', until: '2026-09-21T00:00:00.000Z' };

let fixture: McpFixture;

beforeAll(async () => {
  fixture = await createMcpFixture('u17_export_nag', { startAt: CLOCK });
  await seedBrain(fixture.sql, SEEDED_AT);
});

afterAll(async () => {
  await fixture?.close();
});

describe('a brain nobody has ever backed up says so, once', () => {
  test('the fixture is actually stale — otherwise every assertion below is vacuous', async () => {
    const rows = (await fixture.sql`
      SELECT count(*)::int AS pages, min(created_at)::text AS oldest
        FROM page WHERE deleted_at IS NULL AND quarantined_at IS NULL
    `) as Array<{ pages: number; oldest: string }>;
    expect(rows[0]?.pages ?? 0).toBeGreaterThan(0);
    const days = (CLOCK - Date.parse(rows[0]?.oldest ?? '')) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(STALENESS_BANDS[0] as number);
    // And nothing has ever been exported, which is the state being reported.
    const state = (await fixture.sql`SELECT singleton FROM self_export`) as Array<unknown>;
    expect(state).toHaveLength(0);
  });

  test('it rides the daily read, in the advisory lane', async () => {
    const result = await fixture.call('briefing', WINDOW);
    expect(result.ok).toBe(true);

    const notices = (result.envelope.notice ?? []) as readonly string[];
    const backup = notices.find((line) => line.includes('export'));
    expect(backup).toBeDefined();
    // The honest sentence for "never tried", which is a different fact from
    // "tried and failed" — the distinction the module refuses to lose.
    expect(backup).toContain('only here');
    expect(backup).toContain('markdown');
    // The dismissal travels with it: a bound nobody is told about is a bound
    // that reads as a promise nobody made.
    expect(backup).toContain(String(NAG_INTERVAL_DAYS));
  });

  test('and it is banked against the caller that saw it, not the tenant', async () => {
    const rows = (await fixture.sql`
      SELECT caller_key, last_band FROM self_export_nag
    `) as Array<{ caller_key: string; last_band: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.caller_key.length ?? 0).toBeGreaterThan(0);
    expect(Number(rows[0]?.last_band)).toBe(STALENESS_BANDS[1] as number);
  });

  test('THE NEXT MORNING IT IS SILENT — the bound, over the wire', async () => {
    fixture.advance(24 * 60 * 60 * 1000);
    const second = await fixture.call('briefing', {
      since: '2026-09-20T00:00:00.000Z',
      until: '2026-09-22T00:00:00.000Z',
    });
    const notices = (second.envelope.notice ?? []) as readonly string[];
    expect(notices.find((line) => line.includes('export'))).toBeUndefined();
  });
});

describe('the reminder is fenced like every other count in the bundle', () => {
  test('a grant that can read no pages is not told the brain holds any', async () => {
    const request = {
      since: WINDOW.since,
      until: WINDOW.until,
      focus: null,
      callerKey: 'bearer:fenced-export',
      now: new Date(WINDOW.until),
      budgetTokens: 4000,
    };
    // `seedBrain` puts nothing under this origin, so a fenced count is zero and
    // "nothing to back up is silence" applies — while an unfenced one would
    // report the whole corpus to a credential that cannot read a line of it.
    const blind = await collectBriefing(fixture.sql, ['personal:nothing'], request);
    expect(blind.selfExport.pages).toBe(0);

    const seeing = await collectBriefing(fixture.sql, [CALENDAR, MAIL, WORK], request);
    expect(seeing.selfExport.pages).toBeGreaterThan(0);
  });
});
