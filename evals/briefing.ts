/**
 * Briefing-shaped fixtures for the blocking tier (U12 approach step 4).
 *
 * **Why the briefing can be in a zero-model-call, zero-database tier at all.**
 * `core/briefing/assemble.ts` is split at the seam that makes it possible:
 * `collectBriefing` issues the SQL, `assembleBriefing` is a pure function of
 * what it found. The database half is covered by `test/briefing/`, against a
 * real tenant at the head of the ladder. The half graded here is the one that
 * decides the *shape* — which is where the two properties the plan names live:
 *
 *   - **participant-card completeness** — a materialised meeting carries a card
 *     for every participant it resolved, and a cold layer carries no
 *     participants at all rather than a list of bare names. R8 draws that line:
 *     the free briefing names what the paid tier would add instead of being
 *     silently thinner, and a nameless-card list is precisely the silently
 *     thinner shape.
 *   - **delta correctness** — a caller who asks for no window gets one that
 *     opens at their cursor, and a caller who is caught up sees an empty one. A
 *     briefing whose delta ignores the cursor is a dashboard. A caller who *does*
 *     ask for a window gets the window they asked for: this leg pinned the
 *     opposite for one release, which is how the shipped daily and weekly
 *     recipes came to consume each other's delta over one credential with a
 *     green blocking tier.
 *
 * **The fixtures are built in pairs.** Every cold case has a warm twin over the
 * *same* rows and every caught-up case has a first-read twin, because a check
 * whose fixture can only reach one branch is a check an unconditional
 * implementation passes. That is the same discipline `test/briefing/fixture.ts`
 * applies to the database half, for the same reason.
 */

import {
  assembleBriefing,
  BRIEFING_NOT_INCLUDED,
  type Briefing,
  type BriefingOptions,
  type BriefingSource,
} from '../src/core/briefing/assemble.ts';
import { DEBT_THRESHOLDS } from '../src/core/briefing/prompt.ts';

const SINCE = '2026-08-12T00:00:00.000Z';
const UNTIL = '2026-08-14T00:00:00.000Z';
const NOW = new Date(UNTIL);

function options(overrides: Partial<BriefingOptions> = {}): BriefingOptions {
  return {
    since: SINCE,
    until: UNTIL,
    focus: null,
    callerKey: 'fixture',
    now: NOW,
    budgetTokens: 8000,
    ...overrides,
  };
}

function record(id: string, title: string, text: string) {
  return {
    id,
    kind: 'doc' as const,
    title,
    text,
    origins: ['personal:mail'],
    sourceType: 'email',
    createdAt: '2026-08-13T09:00:00.000Z',
  };
}

/** The one brain every fixture below is a projection of. */
function source(overrides: Partial<BriefingSource> = {}): BriefingSource {
  return {
    cursor: { lastReadAt: null, prompt: { lastShownAt: null, lastShownDebt: 0 } },
    // R18's reminder is bounded on its own state and graded by its own suite;
    // an empty brain is the one input under which it is unconditionally silent,
    // so every case below measures the lanes it is actually about.
    selfExport: {
      destinationConfigured: false,
      lastExportAt: null,
      lastFailure: null,
      oldestContentAt: null,
      pages: 0,
      nag: { lastShownAt: null, lastBand: 0 },
    },
    meetings: [
      {
        ...record('m1', 'Roadmap review', 'Attendees: priya@example.com'),
        sourceType: 'calendar',
        // When the call *is*, distinct from when the row arrived — the pair the
        // surface renders and the lane sorts on.
        occurredAt: '2026-08-13T14:00:00.000Z',
        participants: [
          { entityId: 'e1', name: 'Priya Raghavan', card: 'Runs the renewal.', origins: ['personal:mail'] },
          { entityId: 'e2', name: 'Tomas Berg', card: 'Owns the pilot.', origins: ['personal:mail'] },
        ],
      },
    ],
    commitments: [
      {
        id: 'c1',
        statement: 'Send Priya the renewal redline',
        owner: 'you',
        dueOn: '2026-08-15',
        origins: ['personal:mail'],
        compiledTruth: true,
      },
    ],
    changed: [record('p1', 'Renewal terms', 'The renewal lands in October.')],
    stated: [record('f1', 'stated', 'Priya confirmed the renewal.')],
    stale: [
      {
        id: 'p2',
        title: 'Cancelled offsite',
        staleAt: '2026-08-13T09:00:00.000Z',
        relevance: 0.9,
        origins: ['personal:calendar'],
      },
    ],
    counts: { contradictions: 3, pendingDebt: 0, pendingReview: 2, uncorroboratedClaims: 1 },
    layer: { dreamt: true, tier: 'paid', at: '2026-08-13T08:00:00.000Z' },
    ...overrides,
  };
}

export interface BriefingViolation {
  readonly check: string;
  readonly detail: string;
}

export interface BriefingCase {
  readonly id: string;
  readonly what: string;
  run(): readonly BriefingViolation[];
}

function expect(check: string, condition: boolean, detail: string): BriefingViolation[] {
  return condition ? [] : [{ check, detail }];
}

const warm = (): Briefing => assembleBriefing(source(), options());
const cold = (): Briefing =>
  assembleBriefing(source({ layer: { dreamt: false, tier: 'free', at: null } }), options());

export const BRIEFING_CASES: readonly BriefingCase[] = [
  {
    id: 'participants.card_completeness',
    what: 'every participant of a materialised meeting carries a card',
    run() {
      const bundle = warm();
      const meeting = bundle.meetings[0];
      const missing = (meeting?.participants ?? []).filter((person) => person.card === null);
      return [
        ...expect(
          'participants.present',
          (meeting?.participants.length ?? 0) === 2,
          `a materialised meeting resolved ${meeting?.participants.length ?? 0} participants, expected 2`,
        ),
        ...expect(
          'participants.card_completeness',
          missing.length === 0,
          `${missing.length} participant(s) came back without a card: ${missing.map((p) => p.name).join(', ')}`,
        ),
      ];
    },
  },
  {
    id: 'participants.cold_drops_the_list',
    what: 'a cold layer carries no participants, rather than names with no cards',
    run() {
      const bundle = cold();
      return [
        ...expect(
          'participants.cold_drops_the_list',
          (bundle.meetings[0]?.participants.length ?? -1) === 0,
          'a cold layer returned participants; R8 says the free briefing names what is missing instead',
        ),
        // The pair: the same rows, warm, DO produce participants. Without this
        // the check above passes for a fixture that never had any.
        ...expect(
          'participants.cold_is_a_branch',
          (warm().meetings[0]?.participants.length ?? 0) > 0,
          'the warm twin produced no participants either, so the cold check graded nothing',
        ),
      ];
    },
  },
  {
    id: 'coverage.cold_names_what_is_missing',
    what: 'a cold layer is labelled and enumerates the layers it lacks',
    run() {
      const bundle = cold();
      return [
        ...expect('coverage.cold', bundle.coverage === 'cold', `coverage was ${bundle.coverage}`),
        ...expect(
          'coverage.not_included',
          [...bundle.notIncluded].sort().join(',') === [...BRIEFING_NOT_INCLUDED].sort().join(','),
          `not_included was ${JSON.stringify(bundle.notIncluded)}`,
        ),
        ...expect(
          'coverage.cold_drops_commitments',
          bundle.commitments.length === 0,
          'a cold layer returned extracted commitments, which the free tier cannot produce',
        ),
        ...expect(
          'coverage.warm_claims_nothing_missing',
          warm().coverage === 'materialized' && warm().notIncluded.length === 0,
          'the warm twin still reported missing layers, so the cold label is unconditional',
        ),
      ];
    },
  },
  {
    id: 'delta.first_read_opens_at_the_window',
    what: 'a caller with no cursor gets a window either way, marked as a first read',
    run() {
      const bundle = warm();
      // The other half of "no cursor": no window asked for either, so the
      // fallback is the default day rather than nothing at all. A brand-new
      // connection's first briefing must not be empty.
      const unasked = assembleBriefing(source(), options({ since: null }));
      const day = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();
      return [
        ...expect('delta.first_read', bundle.delta.firstRead, 'a cursorless caller was not marked first-read'),
        ...expect(
          'delta.first_read_window',
          bundle.delta.since === SINCE,
          `the delta opened at ${bundle.delta.since}, expected the window's ${SINCE}`,
        ),
        ...expect(
          'delta.first_read_is_not_empty',
          bundle.delta.changed.length > 0,
          'a first read produced an empty delta, so the caught-up check below grades nothing',
        ),
        ...expect(
          'delta.first_read_falls_back_to_a_day',
          unasked.delta.since === day && unasked.delta.basis === 'cursor',
          `a cursorless caller who named no window opened at ${unasked.delta.since}, expected ${day}`,
        ),
      ];
    },
  },
  {
    id: 'delta.cursor_governs_an_unasked_window',
    what: 'a returning caller who names no window gets one that opens at their cursor',
    run() {
      const at = '2026-08-13T12:00:00.000Z';
      const bundle = assembleBriefing(
        source({ cursor: { lastReadAt: at, prompt: { lastShownAt: null, lastShownDebt: 0 } } }),
        options({ since: null }),
      );
      return [
        ...expect('delta.not_first_read', !bundle.delta.firstRead, 'a caller with a cursor was marked first-read'),
        ...expect(
          'delta.cursor_governs',
          bundle.delta.since === at,
          `the delta opened at ${bundle.delta.since}, expected the cursor's ${at}`,
        ),
        ...expect(
          'delta.cursor_basis',
          bundle.delta.basis === 'cursor',
          `the delta reported basis ${bundle.delta.basis}, expected cursor`,
        ),
      ];
    },
  },
  {
    id: 'delta.an_asked_for_window_beats_the_cursor',
    what: 'the same returning caller, asking for a week, gets the week',
    run() {
      // The twin of the case above over the *same* cursor, because that is the
      // only shape in which the rule is testable: a caller with no cursor gets
      // the window either way, so a fixture without one grades nothing. This is
      // the weekly review running on the connection the daily task just moved.
      const at = '2026-08-13T12:00:00.000Z';
      const week = '2026-08-07T00:00:00.000Z';
      const bundle = assembleBriefing(
        source({ cursor: { lastReadAt: at, prompt: { lastShownAt: null, lastShownDebt: 0 } } }),
        options({ since: week }),
      );
      return [
        ...expect(
          'delta.window_wins',
          bundle.delta.since === week,
          `the delta opened at ${bundle.delta.since}, expected the asked-for ${week}`,
        ),
        ...expect(
          'delta.window_basis',
          bundle.delta.basis === 'window',
          `the delta reported basis ${bundle.delta.basis}, expected window`,
        ),
        ...expect(
          'delta.window_still_reports_the_bookmark',
          !bundle.delta.firstRead,
          'a windowed read claimed a first read for a connection that has one',
        ),
      ];
    },
  },
  {
    id: 'delta.caught_up_is_empty',
    what: 'a caller whose cursor covers the window sees nothing new',
    run() {
      // `collectBriefing` windows the rows; the pure half is handed what SQL
      // found, so the caught-up case is an empty pair of lists arriving with a
      // cursor. What is graded here is that they stay empty and that the bundle
      // still reports the rest of itself.
      const bundle = assembleBriefing(
        source({
          cursor: { lastReadAt: UNTIL, prompt: { lastShownAt: null, lastShownDebt: 0 } },
          changed: [],
          stated: [],
        }),
        options({ since: null }),
      );
      return [
        ...expect('delta.caught_up', bundle.delta.changed.length === 0, 'a caught-up delta carried rows'),
        ...expect(
          'delta.caught_up_keeps_the_rest',
          bundle.meetings.length > 0 && bundle.commitments.length > 0,
          'an empty delta emptied the rest of the bundle; the window lanes are not cursor-relative',
        ),
      ];
    },
  },
  {
    id: 'budget.drops_whole_rows',
    what: 'a tiny ceiling drops rows from the tail and never truncates one',
    run() {
      const bundle = assembleBriefing(
        source({
          changed: [
            record('p1', 'One', 'a'.repeat(400)),
            record('p2', 'Two', 'b'.repeat(400)),
            record('p3', 'Three', 'c'.repeat(400)),
          ],
        }),
        options({ budgetTokens: 1 }),
      );
      const truncated = bundle.delta.changed.filter((row) => row.text.length !== 400);
      return [
        ...expect(
          'budget.drops_rows',
          bundle.delta.changed.length === 1,
          `a one-token ceiling kept ${bundle.delta.changed.length} rows`,
        ),
        ...expect(
          'budget.never_truncates',
          truncated.length === 0,
          'a row came back shorter than it was written; a half-quoted external row is a demarcated region with no close',
        ),
      ];
    },
  },
  {
    id: 'prompt.reads_debt_not_contradictions',
    what: 'the upgrade prompt fires on debt and is deaf to the contradiction count',
    run() {
      const alarming = assembleBriefing(
        source({
          layer: { dreamt: false, tier: 'free', at: null },
          counts: { contradictions: 99, pendingDebt: 0, pendingReview: 0, uncorroboratedClaims: 0 },
        }),
        options(),
      );
      const indebted = assembleBriefing(
        source({
          layer: { dreamt: false, tier: 'free', at: null },
          counts: {
            contradictions: 0,
            pendingDebt: DEBT_THRESHOLDS[0]!,
            pendingReview: 2,
            uncorroboratedClaims: 1,
          },
        }),
        options(),
      );
      return [
        ...expect(
          'prompt.deaf_to_contradictions',
          alarming.prompt === null,
          'a brain with contradictions and no debt was prompted; R8 says the free tier cannot produce one',
        ),
        ...expect(
          'prompt.fires_on_debt',
          indebted.prompt !== null,
          'a brain that crossed the first debt threshold was not prompted, so the check above grades nothing',
        ),
        ...expect(
          'prompt.never_for_paid',
          assembleBriefing(
            source({ counts: { contradictions: 0, pendingDebt: 10_000, pendingReview: 0, uncorroboratedClaims: 0 } }),
            options(),
          ).prompt === null,
          'a paid tenant carrying a backlog was prompted to upgrade',
        ),
      ];
    },
  },
];

export interface BriefingLegResult {
  readonly cases: number;
  readonly violations: readonly BriefingViolation[];
  readonly passed: boolean;
}

/**
 * Run every case. Deterministic, no database, no model, no clock — `now` is a
 * fixture value like every other input.
 */
export function runBriefingLeg(cases: readonly BriefingCase[] | undefined = BRIEFING_CASES): BriefingLegResult {
  // `undefined` is the shipped set, not an empty one: an optional dependency
  // that defaulted to `[]` would turn an omitted argument into a passing leg.
  if (cases.length === 0) {
    throw new Error('the briefing leg was given no cases; an empty leg passes everything');
  }
  const violations: BriefingViolation[] = [];
  for (const entry of cases) violations.push(...entry.run());
  return { cases: cases.length, violations, passed: violations.length === 0 };
}

export function renderBriefingLeg(leg: BriefingLegResult): string {
  const lines = [`briefing leg — ${leg.cases} cases, ${leg.passed ? 'clean' : `${leg.violations.length} violations`}`];
  for (const violation of leg.violations) lines.push(`  [${violation.check}] ${violation.detail}`);
  return lines.join('\n');
}
