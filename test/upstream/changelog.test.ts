/**
 * Parsing gbrain's CHANGELOG, and refusing to report an empty delta that is
 * really a broken parser.
 *
 * The failure this file is built against is not a wrong release list. It is a
 * *right-looking empty one*: a regex that stops matching after an upstream
 * formatting change reports "no new releases since the pin", which is exactly
 * what a correctly-pinned repo also reports. The watcher would then run green
 * every week while classifying nothing, which is the same
 * green-that-means-nothing disease the ledger exists to kill.
 *
 * So the contract is: {@link releasesSince} must LOCATE the pinned version's own
 * header. Not finding it is an error. An empty delta is only ever reported from a
 * file the parser demonstrably understood.
 */

import { describe, expect, test } from 'bun:test';

import { compareVersions, parseChangelog, releasesSince } from '../../src/upstream/changelog.ts';

const FIXTURE = `# Changelog

All notable changes to GBrain will be documented in this file.

## [0.44.1.0] - 2026-08-11

**Any current model works now.**

Prose about the release.

### Itemized changes

- \`src/core/ai/model-resolver.ts\` — the allowlist throw is removed.
- \`src/core/ai/gateway.ts\` — the extended-models registry is deleted.
- Tests — \`test/gateway-tier-extended-models.test.ts\` deleted.

## [0.44.0.0] - 2026-06-12

**BrainBench: agent memory now has a scorecard.**

Four suites, scored per harness seam.

## [0.43.0.0] - 2026-08-08

**Five memory verbs.**

### Itemized changes

- \`src/core/search/rrf.ts\` — fusion reworked.
`;

describe('parseChangelog', () => {
  test('reads every release header, newest first, with its date', () => {
    const releases = parseChangelog(FIXTURE);
    expect(releases.map((release) => release.version)).toEqual(['0.44.1.0', '0.44.0.0', '0.43.0.0']);
    expect(releases[0]?.released_on).toBe('2026-08-11');
  });

  test('carries the headline and the whole body of the section', () => {
    const [latest] = parseChangelog(FIXTURE);
    expect(latest?.headline).toBe('Any current model works now.');
    // The body must stop at the next release, or every classification would be
    // attributed to the newest release in the file.
    expect(latest?.body).toContain('model-resolver');
    expect(latest?.body).not.toContain('BrainBench');
  });

  test('extracts itemized bullets with the upstream paths they name', () => {
    const [latest] = parseChangelog(FIXTURE);
    expect(latest?.itemized).toHaveLength(3);
    expect(latest?.itemized[0]?.paths).toEqual(['src/core/ai/model-resolver.ts']);
    expect(latest?.itemized[2]?.paths).toEqual(['test/gateway-tier-extended-models.test.ts']);
  });

  test('a release with no itemized section is still a release', () => {
    const middle = parseChangelog(FIXTURE).find((release) => release.version === '0.44.0.0');
    expect(middle).toBeDefined();
    expect(middle?.itemized).toEqual([]);
    expect(middle?.headline).toBe('BrainBench: agent memory now has a scorecard.');
  });
});

describe('compareVersions', () => {
  test('orders by numeric segment, with a missing MICRO reading as zero', () => {
    expect(compareVersions('0.44.1.0', '0.44.0.0')).toBeGreaterThan(0);
    expect(compareVersions('0.44.1', '0.44.1.0')).toBe(0);
    expect(compareVersions('0.9.0.0', '0.10.0.0')).toBeLessThan(0);
    // Lexical comparison would call 0.42.9 newer than 0.42.10.
    expect(compareVersions('0.42.9.0', '0.42.10.0')).toBeLessThan(0);
  });
});

describe('releasesSince', () => {
  test('returns only releases strictly newer than the pin', () => {
    const delta = releasesSince(FIXTURE, '0.44.0.0');
    expect(delta.map((release) => release.version)).toEqual(['0.44.1.0']);
  });

  test('an up-to-date pin yields an empty delta — from a file it understood', () => {
    expect(releasesSince(FIXTURE, '0.44.1.0')).toEqual([]);
  });

  test('a pinned version absent from the file is an ERROR, not an empty delta', () => {
    // The whole point. A parser that stopped matching, a truncated file, and a
    // pin naming a release that was never published all land here — and none of
    // them may be reported as "nothing new upstream".
    expect(() => releasesSince(FIXTURE, '0.44.2.0')).toThrow(/0\.44\.2\.0/);
  });

  test('a file whose headers no longer parse is an ERROR even for a real pin', () => {
    const mangled = FIXTURE.split('## [').join('## ');
    expect(() => releasesSince(mangled, '0.44.0.0')).toThrow();
  });
});
