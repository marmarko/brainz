/**
 * The rules that make an automated discovery safe to put in the ledger.
 *
 * U19 lets a machine write ledger rows. That is only defensible if the machine
 * cannot write the one status that retires a capability from view, and if a row
 * it wrote cannot sit unreviewed forever. Both are enforced here, in
 * `bun run ledger:check`, which already blocks every PR — so the enforcement is
 * wired before the watcher has produced a single row.
 *
 * Four rules, and the failure each one is against:
 *
 *   1. **A watcher row cannot claim coverage.** `covered` is the status nobody
 *      re-reads; a weekly job that can write it marks capabilities done at the
 *      rate upstream ships them. Until a human puts their name in `reviewed_by`,
 *      the row may be `not-yet` and nothing else.
 *   2. **A discovery has a deadline.** Past `review_by` with no reviewer, the
 *      check goes red. This is the roadmap's *"within a week ... and CI enforces
 *      them"* expressed as the row's own data rather than as somebody's calendar.
 *   3. **Evidence must exist.** Every repo path a `covered` row cites in `notes`
 *      must be a file that is there. Adopted repo-wide, not just for watcher
 *      rows, because it was measured before it was adopted: of the 36 covered
 *      rows, 18 cite a repo-root-prefixed path — 28 paths between them — and
 *      every one resolves. So the rule costs nothing today and closes the exact
 *      shape of the four bad rows this repo has already had.
 *   4. **A reviewed watcher row must cite something.** Rule 3 makes a fabricated
 *      path fail; this makes an empty justification fail.
 *
 * The trap: "CI enforces them" passes trivially if no row is ever unclassified.
 * Every rule below is therefore tested from *both* sides — the state that must
 * be red is constructed and observed red, and the neighbouring state that must
 * stay green is constructed too.
 */

import { describe, expect, test } from 'bun:test';

import { checkLedger, citedRepoPaths } from '../../scripts/check-ledger.ts';

const TODAY = new Date('2026-08-13T00:00:00Z');

/** Every path in these fixtures resolves, so a finding is never about the stub. */
const everythingExists = () => true;

function check(lines: string[], pathExists: (path: string) => boolean = everythingExists) {
  return checkLedger(lines.join('\n'), { today: TODAY, pathExists });
}

interface RowOverrides {
  readonly status?: string;
  readonly notes?: string;
  readonly reviewed_by?: string;
  readonly review_by?: string;
  readonly confidence?: string;
  readonly evidence?: readonly string[];
  readonly unit?: string;
}

function watcherRow(overrides: RowOverrides = {}): string {
  const {
    status = 'not-yet',
    notes = 'Discovered by the U19 upstream watcher.',
    reviewed_by,
    review_by = '2026-08-20',
    confidence = 'medium',
    evidence = ['src/core/search/rrf.ts'],
    unit = 'U19-review',
  } = overrides;

  return JSON.stringify({
    id: 'up.0-45-0-0.retrieval',
    capability: 'Retrieval reworked — the retrieval part of gbrain 0.45.0.0',
    criticality: 'critical',
    status,
    priority: 'p1',
    unit,
    source: 'upstream-watcher',
    notes,
    discovered_by: {
      watcher: 'u19',
      run_on: '2026-08-13',
      gbrain_release: '0.45.0.0',
      gbrain_commit: 'a'.repeat(40),
      area: 'retrieval',
      confidence,
      evidence,
      assigned: ['criticality', 'priority', 'unit'],
      review_by,
      ...(reviewed_by === undefined ? {} : { reviewed_by }),
    },
  });
}

describe('rule 1 — a watcher row cannot claim coverage', () => {
  test('an unreviewed discovery is fine as `not-yet`', () => {
    expect(check([watcherRow()]).ok).toBe(true);
  });

  test('an unreviewed discovery claiming `covered` is refused', () => {
    const report = check([watcherRow({ status: 'covered', unit: 'U5' })]);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toMatch(/reviewed_by/);
  });

  test('an unreviewed discovery claiming `omitted` is refused too', () => {
    // Same reason from the other end: `omitted` needs a reason and a revisit
    // date, which are judgements about this roadmap and not about upstream.
    const report = check([
      JSON.stringify({
        ...JSON.parse(watcherRow()),
        status: 'omitted',
        reason: 'not wanted',
        revisit_by: '2027-01-01',
      }),
    ]);
    expect(report.ok).toBe(false);
    expect(report.findings.some((finding) => /reviewed_by/.test(finding.message))).toBe(true);
  });

  test('a human who reviewed it may flip it, and says so in the row', () => {
    const report = check([
      watcherRow({
        status: 'covered',
        unit: 'U5',
        reviewed_by: 'a-maintainer',
        notes: 'Already here: `src/core/search/rrf.ts` is the fusion stage.',
      }),
    ]);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe('rule 2 — a discovery has a deadline', () => {
  test('inside the window it is green', () => {
    expect(check([watcherRow({ review_by: '2026-08-14' })]).ok).toBe(true);
  });

  test('the day it is due it is still green', () => {
    // The boundary, asserted rather than assumed: "due today" is not yet late.
    expect(check([watcherRow({ review_by: '2026-08-13' })]).ok).toBe(true);
  });

  test('one day past, unreviewed, it is red', () => {
    const report = check([watcherRow({ review_by: '2026-08-12' })]);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toMatch(/2026-08-12 has passed/);
  });

  test('past its date but reviewed, it is green — the deadline is on the review, not on the row', () => {
    expect(check([watcherRow({ review_by: '2020-01-01', reviewed_by: 'a-maintainer' })]).ok).toBe(true);
  });

  test('a discovery block with no review date at all is refused', () => {
    const row = JSON.parse(watcherRow()) as { discovered_by: Record<string, unknown> };
    delete row.discovered_by['review_by'];
    const report = check([JSON.stringify(row)]);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toMatch(/review_by/);
  });
});

describe('the discovery block must be well-formed, or the rules above have nothing to read', () => {
  test('confidence is one of three values', () => {
    const report = check([watcherRow({ confidence: 'pretty sure' })]);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toMatch(/confidence/);
  });

  test('evidence cannot be empty — a discovery nobody can check is not a discovery', () => {
    const report = check([watcherRow({ evidence: [] })]);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toMatch(/evidence/);
  });
});

describe('rule 3 — a covered row may not cite a path that does not exist', () => {
  const missing = (path: string) => path !== 'src/core/search/nowhere.ts';

  test('a covered row citing a real path is green', () => {
    const report = check(
      [
        JSON.stringify({
          id: 'a.covered',
          capability: 'RRF fusion',
          criticality: 'critical',
          status: 'covered',
          unit: 'U5',
          notes: 'Shipped as `src/core/search/rrf.ts`.',
        }),
      ],
      missing,
    );
    expect(report.ok).toBe(true);
  });

  test('a covered row citing a module nobody wrote is red', () => {
    const report = check(
      [
        JSON.stringify({
          id: 'a.covered',
          capability: 'RRF fusion',
          criticality: 'critical',
          status: 'covered',
          unit: 'U5',
          notes: 'Shipped as `src/core/search/nowhere.ts`.',
        }),
      ],
      missing,
    );
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toMatch(/nowhere\.ts/);
  });

  test('the rule reads a covered row only — a not-yet row may name what it plans to write', () => {
    const report = check(
      [
        JSON.stringify({
          id: 'a.later',
          capability: 'Autocut',
          criticality: 'critical',
          status: 'not-yet',
          priority: 'p1',
          unit: 'U12',
          notes: 'Will land as `src/core/search/nowhere.ts`.',
        }),
      ],
      missing,
    );
    expect(report.ok).toBe(true);
  });
});

describe('rule 4 — a reviewed watcher row must cite something', () => {
  test('flipping to covered with no path in the notes is refused', () => {
    const report = check([
      watcherRow({ status: 'covered', unit: 'U5', reviewed_by: 'a-maintainer', notes: 'We have this.' }),
    ]);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toMatch(/cite/);
  });

  test('flipping to not-yet needs no citation — nothing is being claimed', () => {
    expect(
      check([watcherRow({ reviewed_by: 'a-maintainer', notes: 'Real, not built yet.' })]).ok,
    ).toBe(true);
  });
});

describe('citedRepoPaths', () => {
  test('finds backticked repo paths and ignores everything else', () => {
    expect(
      citedRepoPaths(
        'See `src/core/search/rrf.ts` and `test/core/search/rrf.test.ts:fuses`, but not ' +
          '`websearch_to_tsquery`, not `--flag=value/thing`, and not `src/schema/**/*.sql`.',
      ),
    ).toEqual(['src/core/search/rrf.ts', 'test/core/search/rrf.test.ts']);
  });

  test('finds nothing in prose with no paths, which is what makes rule 4 bite', () => {
    expect(citedRepoPaths('We have this already, obviously.')).toEqual([]);
  });
});

describe('the committed ledger obeys the new rules', () => {
  test('every path cited by a covered row exists on disk', async () => {
    const report = checkLedger(await Bun.file('upstream/concepts.jsonl').text(), { today: TODAY });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('and there are covered rows citing paths, so the check above is not vacuous', async () => {
    // 18 of the 36 covered rows cite a repo-root-prefixed path, between them 28
    // paths, and every one resolves. The other half cite a shorthand the notes
    // use freely (`search/arms.ts` for `src/core/search/arms.ts`), which this
    // rule deliberately does not try to resolve — guessing a prefix would turn a
    // hard check into a heuristic. Pinned so the rule cannot quietly stop
    // matching and keep passing.
    const rows = (await Bun.file('upstream/concepts.jsonl').text())
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { status: string; notes?: string });
    const citing = rows.filter((row) => row.status === 'covered' && citedRepoPaths(row.notes ?? ''));
    const withPaths = citing.filter((row) => citedRepoPaths(row.notes ?? '').length > 0);
    expect(withPaths.length).toBeGreaterThanOrEqual(18);
    expect(withPaths.flatMap((row) => citedRepoPaths(row.notes ?? '')).length).toBeGreaterThanOrEqual(28);
  });
});
