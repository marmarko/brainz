/**
 * The delta assertion: brainz declares `memory-verbs-v1-partial`, and this is
 * the check that the declaration is exactly true.
 *
 * **Assumption 2 is why this exists as a wrapper rather than as a pass/fail
 * read of gbrain's exit code.** The runner asserts all five frozen verbs are
 * advertised and that `synthesize` carries the `[EXPENSIVE` marker; brainz
 * advertises neither, on purpose (KTD3). So the runner is *expected* to report
 * NOT CONFORMANT and exit non-zero, and a wrapper that read the exit code would
 * be permanently red on a correct implementation. What is gradeable is the
 * **delta**: the exact set of cases that do not pass, matched against the set
 * this repo publishes.
 *
 * Every check below fails toward enforcement, because the failure mode this
 * gate has is not "wrongly red" — it is "green having compared nothing":
 *
 *   1. A report that cannot be read is `unreadable_report`, never an empty
 *      failure set. The obvious implementation (`report?.results ?? []`) turns a
 *      crashed runner into a clean pass on every declared deviation.
 *   2. A report with zero cases is `empty_report`. A runner that connected,
 *      listed nothing and exited is not evidence of conformance.
 *   3. A report whose own counts disagree with its results is
 *      `inconsistent_report` — the tallies are re-derived here rather than
 *      trusted, and `ok` is never read as the verdict.
 *   4. A declared deviation that now passes is `stale_deviation`, the same
 *      anti-rot rule `evals/gates.ts` applies to a deferred floor. A published
 *      delta nobody removed is how "partial" becomes permanent.
 *   5. A declared deviation that is absent from the report entirely is
 *      `absent_deviation` — upstream renamed or dropped the case, so the pin
 *      must be re-taken deliberately rather than silently satisfied.
 *   6. The delta is bound to the gbrain commit it was observed against. A pin
 *      advanced without re-observing the delta is `pin_mismatch`.
 */

import { describe, expect, test } from 'bun:test';

import {
  assertDelta,
  deviationOutcome,
  parseDelta,
  parseReport,
  tallyDeviations,
  type ConformanceReport,
  type PublishedDelta,
} from '../../evals/conformance/delta.ts';

const COMMIT = '0'.repeat(40);

function report(
  results: ReadonlyArray<{ name: string; verb: string; status: 'pass' | 'fail' | 'skip'; detail?: string }>,
  overrides: Partial<ConformanceReport> = {},
): ConformanceReport {
  const full = results.map((r) => ({ ...r, detail: r.detail ?? '' }));
  const failed = full.filter((r) => r.status === 'fail').length;
  return {
    protocol_version: 1,
    results: full,
    passed: full.filter((r) => r.status === 'pass').length,
    failed,
    skipped: full.filter((r) => r.status === 'skip').length,
    ok: failed === 0,
    ...overrides,
  };
}

function delta(
  deviations: ReadonlyArray<{ case: string; verb: string; status: 'fail' | 'skip'; reason?: string }>,
): PublishedDelta {
  return {
    profile: 'memory-verbs-v1-partial',
    protocol_version: 1,
    gbrain_commit: COMMIT,
    observed_on: '2026-08-13',
    status: 'observed',
    rationale: 'test fixture',
    deviations: deviations.map((d) => ({ ...d, reason: d.reason ?? 'because' })),
  };
}

/** A delta that could not be observed, because the runner never reached the cases. */
function blockedDelta(): PublishedDelta {
  return {
    ...delta([]),
    status: 'blocked',
    blocker: {
      kind: 'handshake_incompatible',
      detail: "the pinned runner's SDK caps at 2025-11-25 and this server declares 2026-07-28",
    },
  };
}

const PASSING = report([
  { name: 'tools/list advertises recall', verb: 'recall', status: 'pass' },
  { name: 'recall returns results', verb: 'recall', status: 'pass' },
]);

describe('assertDelta grades the published delta, not the exit code', () => {
  test('a report matching the declared delta exactly passes', () => {
    const observed = report([
      { name: 'tools/list advertises recall', verb: 'recall', status: 'pass' },
      { name: 'tools/list advertises synthesize', verb: 'synthesize', status: 'fail' },
      { name: 'synthesize is marked expensive ([EXPENSIVE prefix)', verb: 'synthesize', status: 'fail' },
    ]);
    const declared = delta([
      { case: 'tools/list advertises synthesize', verb: 'synthesize', status: 'fail' },
      { case: 'synthesize is marked expensive ([EXPENSIVE prefix)', verb: 'synthesize', status: 'fail' },
    ]);

    const result = assertDelta(observed, declared, { gbrainCommit: COMMIT });
    expect(result.violations).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.checked).toBe(2);
  });

  test('a NEW failure that is not in the delta is undeclared_deviation', () => {
    const observed = report([
      { name: 'recall returns results', verb: 'recall', status: 'fail', detail: 'missing $.results' },
      { name: 'tools/list advertises synthesize', verb: 'synthesize', status: 'fail' },
    ]);
    const declared = delta([{ case: 'tools/list advertises synthesize', verb: 'synthesize', status: 'fail' }]);

    const result = assertDelta(observed, declared, { gbrainCommit: COMMIT });
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(['undeclared_deviation']);
    expect(result.violations[0]?.case).toBe('recall returns results');
    // The runner's own detail has to survive: a gate that says "something
    // changed" without saying what is a bisecting exercise.
    expect(result.violations[0]?.detail).toContain('missing $.results');
  });

  test('a NEW skip that is not in the delta is a deviation too — a skip can hide a dropped case', () => {
    const observed = report([
      { name: 'remember writes a fact', verb: 'remember', status: 'skip', detail: 'no seeding path' },
    ]);
    const result = assertDelta(observed, delta([]), { gbrainCommit: COMMIT });
    expect(result.violations.map((v) => v.kind)).toEqual(['undeclared_deviation']);
  });

  test('a declared deviation that now passes is stale_deviation', () => {
    const observed = report([
      { name: 'tools/list advertises synthesize', verb: 'synthesize', status: 'pass' },
    ]);
    const declared = delta([{ case: 'tools/list advertises synthesize', verb: 'synthesize', status: 'fail' }]);

    const result = assertDelta(observed, declared, { gbrainCommit: COMMIT });
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(['stale_deviation']);
  });

  test('a declared deviation the report never mentions is absent_deviation', () => {
    const declared = delta([{ case: 'a case upstream renamed', verb: 'synthesize', status: 'fail' }]);
    const result = assertDelta(PASSING, declared, { gbrainCommit: COMMIT });
    expect(result.violations.map((v) => v.kind)).toEqual(['absent_deviation']);
  });

  test('a deviation declared as skip but observed as fail is status_changed', () => {
    const observed = report([{ name: 'synthesize costs money', verb: 'synthesize', status: 'fail' }]);
    const declared = delta([{ case: 'synthesize costs money', verb: 'synthesize', status: 'skip' }]);

    const result = assertDelta(observed, declared, { gbrainCommit: COMMIT });
    expect(result.violations.map((v) => v.kind)).toEqual(['status_changed']);
  });

  test('a deviation declared against a different verb does not match by name alone', () => {
    const observed = report([{ name: 'shared name', verb: 'recall', status: 'fail' }]);
    const declared = delta([{ case: 'shared name', verb: 'synthesize', status: 'fail' }]);

    const result = assertDelta(observed, declared, { gbrainCommit: COMMIT });
    expect(result.violations.map((v) => v.kind).sort()).toEqual(['absent_deviation', 'undeclared_deviation']);
  });

  test('the same deviation declared twice is duplicate_declaration', () => {
    const observed = report([{ name: 'dup', verb: 'synthesize', status: 'fail' }]);
    const declared = delta([
      { case: 'dup', verb: 'synthesize', status: 'fail' },
      { case: 'dup', verb: 'synthesize', status: 'fail' },
    ]);
    const result = assertDelta(observed, declared, { gbrainCommit: COMMIT });
    expect(result.violations.map((v) => v.kind)).toContain('duplicate_declaration');
  });
});

describe('assertDelta refuses to grade a report it cannot trust', () => {
  test('undefined is unreadable_report, NOT an empty failure set', () => {
    const declared = delta([{ case: 'x', verb: 'synthesize', status: 'fail' }]);
    const result = assertDelta(undefined, declared, { gbrainCommit: COMMIT });
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(['unreadable_report']);
    // Nothing was compared, and the result must say so rather than reporting
    // the declared count.
    expect(result.checked).toBe(0);
  });

  test('a delta with no deviations still refuses an unreadable report', () => {
    const result = assertDelta(null, delta([]), { gbrainCommit: COMMIT });
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(['unreadable_report']);
  });

  test('a report whose results are not case objects is unreadable_report', () => {
    const result = assertDelta({ protocol_version: 1, results: ['nope'] }, delta([]), {
      gbrainCommit: COMMIT,
    });
    expect(result.violations.map((v) => v.kind)).toEqual(['unreadable_report']);
  });

  test('a case carrying an unknown status is unreadable_report, not a silently uncounted case', () => {
    // Without this, an upstream that introduces a fourth status ships a case
    // that is neither a pass nor a deviation: it falls out of the tally and out
    // of the undeclared sweep, and the delta reads clean.
    const result = assertDelta(
      {
        protocol_version: 1,
        results: [{ name: 'a', verb: 'recall', status: 'error', detail: 'boom' }],
        passed: 0,
        failed: 0,
        skipped: 0,
        ok: true,
      },
      delta([]),
      { gbrainCommit: COMMIT },
    );
    expect(result.violations.map((v) => v.kind)).toEqual(['unreadable_report']);
    expect(result.violations[0]?.detail).toContain('error');
  });

  test('a report with zero cases is empty_report — a runner that graded nothing is not evidence', () => {
    const result = assertDelta(report([]), delta([]), { gbrainCommit: COMMIT });
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(['empty_report']);
  });

  test('counts are re-derived, never trusted: a lying tally is inconsistent_report', () => {
    const observed = report([{ name: 'a', verb: 'recall', status: 'fail' }], { failed: 0, ok: true });
    const result = assertDelta(observed, delta([{ case: 'a', verb: 'recall', status: 'fail' }]), {
      gbrainCommit: COMMIT,
    });
    expect(result.violations.map((v) => v.kind)).toContain('inconsistent_report');
  });

  test("a report claiming ok:true while carrying a failure is inconsistent_report", () => {
    const observed = report([{ name: 'a', verb: 'recall', status: 'fail' }], { ok: true });
    const result = assertDelta(observed, delta([{ case: 'a', verb: 'recall', status: 'fail' }]), {
      gbrainCommit: COMMIT,
    });
    expect(result.violations.map((v) => v.kind)).toContain('inconsistent_report');
  });

  test('a protocol version the delta was not written against is a violation', () => {
    const observed = report([{ name: 'a', verb: 'recall', status: 'pass' }], { protocol_version: 2 });
    const result = assertDelta(observed, delta([]), { gbrainCommit: COMMIT });
    expect(result.violations.map((v) => v.kind)).toEqual(['protocol_version_mismatch']);
  });

  test('a delta observed against a different gbrain build is pin_mismatch', () => {
    const result = assertDelta(PASSING, delta([]), { gbrainCommit: 'f'.repeat(40) });
    expect(result.violations.map((v) => v.kind)).toEqual(['pin_mismatch']);
  });
});

describe('the fold refuses to lose a declaration', () => {
  // No input `assertDelta` can build reaches this branch, which is why it is a
  // separate function: the assertion exists against a future `continue` that
  // skips a declaration, and an assertion nothing can trigger is an assertion
  // nobody has shown to work.
  test('fewer outcomes than declarations throws rather than reporting a short pass', () => {
    expect(() => tallyDeviations([], 1)).toThrow(/accounted for 0 of 1/);
    expect(() => tallyDeviations([null, null], 3)).toThrow(/skipped one is not a check/);
  });

  test('a matching set folds to zero violations and a full checked count', () => {
    expect(tallyDeviations([null, null], 2)).toEqual({ violations: [], checked: 2 });
  });

  test('deviationOutcome returns null only for an exact match', () => {
    const deviation = { case: 'c', verb: 'synthesize', status: 'fail' as const, reason: 'r' };
    expect(deviationOutcome(deviation, { name: 'c', verb: 'synthesize', status: 'fail', detail: '' })).toBeNull();
    expect(deviationOutcome(deviation, undefined)?.kind).toBe('absent_deviation');
    expect(deviationOutcome(deviation, { name: 'c', verb: 'synthesize', status: 'pass', detail: '' })?.kind).toBe(
      'stale_deviation',
    );
    expect(deviationOutcome(deviation, { name: 'c', verb: 'synthesize', status: 'skip', detail: '' })?.kind).toBe(
      'status_changed',
    );
  });
});

describe('a delta that was never observed cannot certify anything', () => {
  // The state this repo is actually in: the pinned gbrain build's MCP SDK caps
  // at an older protocol version than brainz declares, so its client refuses the
  // handshake and no case is ever graded. A published delta with an empty
  // deviation list would otherwise be indistinguishable from a clean run — the
  // most expensive possible false green, since the whole gate would report
  // conformance while never having spoken to the server.
  test('a blocked delta refuses, whatever the report says', () => {
    const result = assertDelta(PASSING, blockedDelta(), { gbrainCommit: COMMIT });
    expect(result.passed).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(['delta_not_observed']);
    expect(result.violations[0]?.detail).toContain('handshake_incompatible');
    expect(result.checked).toBe(0);
  });

  test('a blocked delta refuses even when the report is a perfect pass', () => {
    const perfect = report([
      { name: 'tools/list advertises recall', verb: 'recall', status: 'pass' },
      { name: 'tools/list advertises synthesize', verb: 'synthesize', status: 'pass' },
    ]);
    expect(assertDelta(perfect, blockedDelta(), { gbrainCommit: COMMIT }).passed).toBe(false);
  });

  test('parseDelta requires a blocker on a blocked delta, and refuses one on an observed delta', () => {
    // Asserted on the exact sentence, not on the word "blocker": the variable
    // holding the raw value is called `blockerRaw`, so a TypeError from
    // dereferencing it also contains the word, and a loose regex would let a
    // deleted presence check pass while the parser crashed instead of refusing.
    const noBlocker = JSON.stringify({ ...blockedDelta(), blocker: undefined });
    expect(() => parseDelta(noBlocker)).toThrow('a blocked delta must carry a blocker saying what stopped the run');

    const notAnObject = JSON.stringify({ ...blockedDelta(), blocker: 'handshake' });
    expect(() => parseDelta(notAnObject)).toThrow('a blocked delta must carry a blocker saying what stopped the run');

    const strayBlocker = JSON.stringify({
      ...delta([]),
      blocker: { kind: 'handshake_incompatible', detail: 'x' },
    });
    expect(() => parseDelta(strayBlocker)).toThrow(/blocker/);
  });

  test('parseDelta refuses an unknown status', () => {
    expect(() => parseDelta(JSON.stringify({ ...delta([]), status: 'probably-fine' }))).toThrow(/status/);
  });

  test('a blocked delta may not also publish deviations it never saw', () => {
    const bad = JSON.stringify({
      ...blockedDelta(),
      deviations: [{ case: 'x', verb: 'synthesize', status: 'fail', reason: 'predicted' }],
    });
    expect(() => parseDelta(bad)).toThrow(/deviations/);
  });
});

describe('parseReport pulls the JSON report out of a noisy stdout', () => {
  const body: ConformanceReport = report([{ name: 'a', verb: 'recall', status: 'pass' }]);

  test('it reads a bare JSON document', () => {
    expect(parseReport(JSON.stringify(body, null, 2))).toEqual(body);
  });

  test('it reads a report preceded by runner noise on stderr-shaped lines', () => {
    const noisy = `loading brain…\nwarning: PGLite is slow\n${JSON.stringify(body, null, 2)}\n`;
    expect(parseReport(noisy)).toEqual(body);
  });

  test('it reads a report followed by trailing noise', () => {
    const noisy = `${JSON.stringify(body, null, 2)}\nforcing exit\n`;
    expect(parseReport(noisy)).toEqual(body);
  });

  test('stdout with no JSON at all throws rather than returning an empty report', () => {
    expect(() => parseReport('CONFORMANT\n')).toThrow(/no JSON/i);
  });

  test('stdout carrying a JSON object that is not a report throws', () => {
    expect(() => parseReport('{"hello":"world"}')).toThrow(/report/i);
  });

  test('empty stdout throws', () => {
    expect(() => parseReport('')).toThrow();
  });
});

describe('parseDelta refuses a delta file it cannot trust', () => {
  const good = JSON.stringify(delta([{ case: 'x', verb: 'synthesize', status: 'fail' }]));

  test('it round-trips a well-formed delta', () => {
    expect(parseDelta(good).deviations.length).toBe(1);
  });

  test('a wrong profile name is refused — this file declares one specific profile', () => {
    const bad = JSON.stringify({ ...JSON.parse(good), profile: 'memory-verbs-v1' });
    expect(() => parseDelta(bad)).toThrow(/profile/);
  });

  test('a deviation with no reason is refused: a deviation nobody justified is a bug nobody noticed', () => {
    const bad = JSON.stringify({
      ...JSON.parse(good),
      deviations: [{ case: 'x', verb: 'synthesize', status: 'fail', reason: '  ' }],
    });
    expect(() => parseDelta(bad)).toThrow(/reason/);
  });

  test('a deviation declared with status "pass" is refused — that is not a deviation', () => {
    const bad = JSON.stringify({
      ...JSON.parse(good),
      deviations: [{ case: 'x', verb: 'synthesize', status: 'pass', reason: 'r' }],
    });
    expect(() => parseDelta(bad)).toThrow(/status/);
  });

  test('a commit that is not a full sha is refused — a tag moves, a sha does not', () => {
    const bad = JSON.stringify({ ...JSON.parse(good), gbrain_commit: 'v0.44.1.0' });
    expect(() => parseDelta(bad)).toThrow(/commit/);
  });

  test('malformed JSON throws', () => {
    expect(() => parseDelta('{')).toThrow();
  });
});
