/**
 * The classifier, and the one property it exists to have: **it cannot claim
 * coverage.**
 *
 * `test/ledger/coverage-claims.test.ts` already states why, for rows a human
 * wrote: `not-yet` and `omitted` keep a capability visible, `covered` retires it
 * from every list an operator reads. A machine writing `covered` is that failure
 * industrialised — a weekly job that quietly marks capabilities done at the rate
 * upstream ships them.
 *
 * So `covered` is not a status this module can produce. Not discouraged, not
 * gated behind a flag: absent. The tests below assert it over a delta built to
 * make a guessing classifier guess — a release whose every path has an
 * identically-named counterpart already in this repo — because that is the case
 * where "obviously we have this" is most tempting and most wrong.
 *
 * The second failure is subtler and is asserted too: a classifier test passes
 * trivially when the delta is empty. Every test here that asserts something about
 * rows first asserts that rows exist.
 */

import { describe, expect, test } from 'bun:test';

import { parseChangelog } from '../../src/upstream/changelog.ts';
import { classifyReleases, conceptId, REVIEW_WINDOW_DAYS } from '../../src/upstream/classify.ts';

const RUN_ON = '2026-08-13';

/**
 * Every path here has a same-named file in brainz. A classifier that reasoned
 * "the file exists, so we have it" would mark all of this covered.
 */
const TEMPTING = `# Changelog

## [0.45.0.0] - 2026-08-12

**Retrieval reworked end to end.**

### Itemized changes

- \`src/core/search/rrf.ts\` — fusion constant retuned.
- \`src/core/search/autocut.ts\` — the discontinuity window narrows.
- \`src/commands/search.ts\` — CLI flag added.
- \`skills/query.md\` — routing note.

## [0.44.1.0] - 2026-08-11

**Any current model works now.**

### Itemized changes

- \`src/core/ai/gateway.ts\` — the registry is deleted.
`;

const delta = parseChangelog(TEMPTING).filter((release) => release.version !== '0.44.1.0');
const rows = classifyReleases(delta, { run_on: RUN_ON, gbrain_commit: 'a'.repeat(40), from_version: '0.44.1.0' });

describe('the delta this file grades against is not empty', () => {
  test('there is a release, and it produced rows', () => {
    // Without this, every assertion below is a statement about an empty array.
    expect(delta).toHaveLength(1);
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('a discovered concept never arrives covered', () => {
  test('every produced row is `not-yet`', () => {
    for (const row of rows) expect(row.status).toBe('not-yet');
  });

  test('the module exports no way to produce another status', () => {
    // The statuses this module can emit, read off its own output rather than
    // asserted about its source. `omitted` is excluded for the same reason as
    // `covered`: it needs a reason and a revisit date, which are judgements
    // about brainz's roadmap and are not in the artifact being read.
    expect([...new Set(rows.map((row) => row.status))]).toEqual(['not-yet']);
  });

  test('the row says a machine wrote it, and which run', () => {
    for (const row of rows) {
      expect(row.discovered_by.watcher).toBe('u19');
      expect(row.discovered_by.run_on).toBe(RUN_ON);
      expect(row.discovered_by.gbrain_release).toBe('0.45.0.0');
      expect(row.discovered_by.reviewed_by).toBeUndefined();
    }
  });
});

describe('confidence and evidence live in the row', () => {
  test('every row carries a confidence and at least one piece of evidence', () => {
    for (const row of rows) {
      expect(['low', 'medium', 'high']).toContain(row.discovered_by.confidence);
      expect(row.discovered_by.evidence.length).toBeGreaterThan(0);
    }
  });

  test('the evidence names the upstream paths that produced the row', () => {
    const retrieval = rows.find((row) => row.discovered_by.area === 'retrieval');
    expect(retrieval).toBeDefined();
    expect(retrieval?.discovered_by.evidence).toContain('src/core/search/rrf.ts');
    expect(retrieval?.discovered_by.evidence).toContain('src/core/search/autocut.ts');
  });

  test('criticality and priority are recorded as machine-assigned', () => {
    // They are required fields — `check-ledger.ts` rejects a `not-yet` row
    // without a priority — so the watcher has to supply them. Saying which
    // fields it supplied is what stops them reading as a human's judgement.
    for (const row of rows) {
      expect(row.discovered_by.assigned).toContain('criticality');
      expect(row.discovered_by.assigned).toContain('priority');
      expect(row.criticality).toBeDefined();
      expect(row.priority).toBeDefined();
    }
  });
});

describe('the review deadline', () => {
  test('is a real ISO day, one review window after the run', () => {
    for (const row of rows) {
      expect(row.discovered_by.review_by).toBe('2026-08-20');
    }
    expect(REVIEW_WINDOW_DAYS).toBe(7);
  });
});

describe('out-of-scope paths do not become rows', () => {
  test('the CLI and skills bullets produced nothing', () => {
    const areas = rows.map((row) => row.discovered_by.area);
    expect(areas).toContain('retrieval');
    expect(areas).not.toContain('cli');
    // And the evidence of the in-scope row does not smuggle them in.
    for (const row of rows) {
      expect(row.discovered_by.evidence.some((item) => item.startsWith('skills/'))).toBe(false);
    }
  });
});

describe('ids are stable, so a re-run is a no-op', () => {
  test('the same release classified twice produces the same ids', () => {
    const again = classifyReleases(delta, {
      run_on: '2026-09-01',
      gbrain_commit: 'b'.repeat(40),
      from_version: '0.44.1.0',
    });
    expect(again.map((row) => row.id).sort()).toEqual(rows.map((row) => row.id).sort());
  });

  test('the id names the release and the area it came from', () => {
    expect(conceptId('0.45.0.0', 'retrieval')).toBe('up.0-45-0-0.retrieval');
    expect(rows.map((row) => row.id)).toContain('up.0-45-0-0.retrieval');
  });
});

describe('a release with no in-scope change produces no rows', () => {
  test('rather than an empty-evidence row nobody can review', () => {
    const cliOnly = parseChangelog(`# Changelog

## [0.46.0.0] - 2026-08-13

**A CLI flag.**

### Itemized changes

- \`src/commands/search.ts\` — flag added.
`);
    expect(cliOnly).toHaveLength(1);
    expect(
      classifyReleases(cliOnly, { run_on: RUN_ON, gbrain_commit: 'c'.repeat(40), from_version: '0.45.0.0' }),
    ).toEqual([]);
  });
});
