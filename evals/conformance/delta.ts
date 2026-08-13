/**
 * The `memory-verbs-v1-partial` delta, asserted.
 *
 * **What this grades, and why it is not the exit code.** gbrain's conformance
 * runner asserts that all five frozen verbs are advertised and that
 * `synthesize` carries the `[EXPENSIVE` description marker. brainz advertises
 * seven names per endpoint and keeps `synthesize` dispatchable-but-unadvertised,
 * returning `unavailable` with a suggestion (KTD3, and the tool-surface research
 * says so in as many words: brainz "does not pass gbrain's certifier"). So the
 * runner is *expected* to report NOT CONFORMANT. Assumption 2 anticipated
 * exactly this — "U7 builds the delta-asserting wrapper unconditionally and
 * treats a hard fail as expected, not exceptional."
 *
 * What is gradeable is therefore the **delta**: the exact set of non-passing
 * cases, compared against the set `upstream/memory-verbs-v1-partial.json`
 * publishes. Exact-set equality in both directions —
 *
 *   - a case that fails and is not declared is a regression (`undeclared_deviation`);
 *   - a declared case that now passes is a stale publication (`stale_deviation`),
 *     the same anti-rot rule `evals/gates.ts` applies to a deferred floor;
 *   - a declared case the report never mentions means upstream renamed or dropped
 *     it (`absent_deviation`), so the pin gets re-taken deliberately.
 *
 * **The refusals are the load-bearing part.** This gate's failure mode is not
 * being wrongly red; it is being green having compared nothing. A crashed
 * runner, a truncated stdout, or a target that advertised no tools all produce
 * "no failures" under the obvious implementation. Each is a violation here, and
 * the report's own `ok`/`passed`/`failed` fields are re-derived rather than
 * trusted — a runner that mis-tallies is a runner whose verdict means nothing.
 */

export const PARTIAL_PROFILE = 'memory-verbs-v1-partial';

export type CaseStatus = 'pass' | 'fail' | 'skip';

/** One row of gbrain's `ConformanceReport.results`. */
export interface ConformanceCaseResult {
  readonly name: string;
  readonly verb: string;
  readonly status: CaseStatus;
  readonly detail: string;
}

/** gbrain's `--json` report shape (`src/core/verbs/conformance.ts`). */
export interface ConformanceReport {
  readonly protocol_version: number;
  readonly results: readonly ConformanceCaseResult[];
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly ok: boolean;
}

export interface DeclaredDeviation {
  /** Matched against `ConformanceCaseResult.name`, exactly. */
  readonly case: string;
  readonly verb: string;
  /** `pass` is not a deviation; the parser refuses it. */
  readonly status: 'fail' | 'skip';
  readonly reason: string;
}

/**
 * Whether the delta below is a record of a run or a record of a blocker.
 *
 * `blocked` exists because the honest answer today is neither "conformant" nor
 * "these cases deviate": the pinned runner cannot complete the MCP handshake
 * against this server, so no case is graded at all. A delta with an empty
 * deviation list would be indistinguishable from a clean certification —
 * the most expensive false green available here, because the gate would report
 * conformance having never spoken to the surface.
 */
export type DeltaStatus = 'observed' | 'blocked';

export interface DeltaBlocker {
  readonly kind: string;
  readonly detail: string;
}

export interface PublishedDelta {
  readonly profile: typeof PARTIAL_PROFILE;
  readonly protocol_version: number;
  readonly status: DeltaStatus;
  /** Present iff `status` is `blocked`. */
  readonly blocker?: DeltaBlocker;
  /**
   * The gbrain build the delta was observed against. Bound rather than implied:
   * advancing `upstream/gbrain.pin` without re-observing the delta would leave
   * a published deviation set describing a runner that no longer exists.
   */
  readonly gbrain_commit: string;
  readonly observed_on: string;
  readonly rationale: string;
  readonly deviations: readonly DeclaredDeviation[];
}

export type DeltaViolationKind =
  | 'delta_not_observed'
  | 'unreadable_report'
  | 'empty_report'
  | 'inconsistent_report'
  | 'protocol_version_mismatch'
  | 'pin_mismatch'
  | 'undeclared_deviation'
  | 'stale_deviation'
  | 'absent_deviation'
  | 'status_changed'
  | 'duplicate_declaration';

export interface DeltaViolation {
  readonly kind: DeltaViolationKind;
  /** The case name, when the violation is about one. */
  readonly case?: string;
  readonly detail: string;
}

export interface DeltaResult {
  readonly passed: boolean;
  readonly violations: readonly DeltaViolation[];
  /**
   * Declared deviations that were matched against a report case of the declared
   * status. Compared against the declaration count so a gate that quietly
   * skipped one is itself a fault — the same guard `checkFloors` applies.
   */
  readonly checked: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const CASE_STATUSES: readonly string[] = ['pass', 'fail', 'skip'];

/**
 * Structural validation of a runner report.
 *
 * Returns the reason it is unusable, or `null` when it is usable. Deliberately
 * a *reason* rather than a boolean: "unreadable_report" with no explanation
 * sends the next reader to the runner's source.
 */
function reportProblem(value: unknown): string | null {
  if (!isObject(value)) return `expected a JSON object, got ${value === null ? 'null' : typeof value}`;
  if (typeof value['protocol_version'] !== 'number') return 'protocol_version is missing or not a number';
  const results = value['results'];
  if (!Array.isArray(results)) return 'results is missing or not an array';
  for (const [index, row] of results.entries()) {
    if (!isObject(row)) return `results[${index}] is not an object`;
    if (typeof row['name'] !== 'string') return `results[${index}].name is missing`;
    if (typeof row['verb'] !== 'string') return `results[${index}].verb is missing`;
    if (typeof row['status'] !== 'string' || !CASE_STATUSES.includes(row['status'])) {
      return `results[${index}].status is ${JSON.stringify(row['status'])}, not one of ${CASE_STATUSES.join('/')}`;
    }
  }
  return null;
}

function asReport(value: Record<string, unknown>): ConformanceReport {
  const results = (value['results'] as Array<Record<string, unknown>>).map((row) => ({
    name: row['name'] as string,
    verb: row['verb'] as string,
    status: row['status'] as CaseStatus,
    detail: typeof row['detail'] === 'string' ? row['detail'] : '',
  }));
  return {
    protocol_version: value['protocol_version'] as number,
    results,
    passed: typeof value['passed'] === 'number' ? value['passed'] : Number.NaN,
    failed: typeof value['failed'] === 'number' ? value['failed'] : Number.NaN,
    skipped: typeof value['skipped'] === 'number' ? value['skipped'] : Number.NaN,
    ok: value['ok'] === true,
  };
}

/**
 * Pull the runner's JSON report out of its stdout.
 *
 * The runner is a whole CLI: it can print progress, warnings, or engine noise
 * around the document. Rather than guessing at line offsets, this scans for the
 * outermost balanced JSON object and validates that what it found is a report.
 * A stdout with no report throws — the caller turns that into a refusal, never
 * into an empty failure set.
 */
export function parseReport(stdout: string): ConformanceReport {
  const candidates: unknown[] = [];
  for (let start = stdout.indexOf('{'); start >= 0; start = stdout.indexOf('{', start + 1)) {
    // Scan outward to the last closing brace and shrink until it parses. The
    // report is the largest well-formed object at this offset.
    for (let end = stdout.lastIndexOf('}'); end > start; end = stdout.lastIndexOf('}', end - 1)) {
      try {
        candidates.push(JSON.parse(stdout.slice(start, end + 1)));
        break;
      } catch {
        // keep shrinking
      }
    }
    if (candidates.length > 0) break;
  }

  if (candidates.length === 0) {
    throw new Error('conformance runner produced no JSON document on stdout');
  }
  const problem = reportProblem(candidates[0]);
  if (problem !== null) {
    throw new Error(`conformance runner stdout is not a report: ${problem}`);
  }
  return asReport(candidates[0] as Record<string, unknown>);
}

/** Parse and validate `upstream/memory-verbs-v1-partial.json`. Throws on anything unusable. */
export function parseDelta(text: string): PublishedDelta {
  const raw: unknown = JSON.parse(text);
  if (!isObject(raw)) throw new Error('delta file is not a JSON object');

  if (raw['profile'] !== PARTIAL_PROFILE) {
    throw new Error(`delta profile is ${JSON.stringify(raw['profile'])}; this file declares ${PARTIAL_PROFILE}`);
  }
  if (typeof raw['protocol_version'] !== 'number') {
    throw new Error('delta protocol_version is missing or not a number');
  }
  if (typeof raw['gbrain_commit'] !== 'string' || !/^[0-9a-f]{40}$/.test(raw['gbrain_commit'])) {
    throw new Error('delta gbrain_commit must be a full lower-case 40-character sha; a tag moves, a sha does not');
  }
  if (!nonEmpty(raw['observed_on'])) throw new Error('delta observed_on is missing');
  if (!nonEmpty(raw['rationale'])) throw new Error('delta rationale is missing');

  const status = raw['status'];
  if (status !== 'observed' && status !== 'blocked') {
    throw new Error(`delta status is ${JSON.stringify(status)}; it is 'observed' or 'blocked'`);
  }

  const blockerRaw = raw['blocker'];
  let blocker: DeltaBlocker | undefined;
  if (status === 'blocked') {
    if (!isObject(blockerRaw)) {
      throw new Error('a blocked delta must carry a blocker saying what stopped the run');
    }
    if (!nonEmpty(blockerRaw['kind']) || !nonEmpty(blockerRaw['detail'])) {
      throw new Error('delta blocker needs a kind and a detail');
    }
    blocker = { kind: blockerRaw['kind'], detail: blockerRaw['detail'] };
  } else if (blockerRaw !== undefined && blockerRaw !== null) {
    throw new Error('an observed delta must not carry a blocker; the two states are exclusive');
  }

  const deviations = raw['deviations'];
  if (!Array.isArray(deviations)) throw new Error('delta deviations is missing or not an array');
  if (status === 'blocked' && deviations.length > 0) {
    throw new Error(
      'a blocked delta lists deviations it never observed; a prediction recorded as data is indistinguishable ' +
        'from a measurement — keep it in the rationale instead',
    );
  }

  const parsed: DeclaredDeviation[] = deviations.map((row, index) => {
    if (!isObject(row)) throw new Error(`deviations[${index}] is not an object`);
    if (!nonEmpty(row['case'])) throw new Error(`deviations[${index}].case is missing`);
    if (!nonEmpty(row['verb'])) throw new Error(`deviations[${index}].verb is missing`);
    const status = row['status'];
    if (status !== 'fail' && status !== 'skip') {
      throw new Error(`deviations[${index}].status is ${JSON.stringify(status)}; a deviation is fail or skip`);
    }
    if (!nonEmpty(row['reason'])) {
      throw new Error(`deviations[${index}].reason is missing — a deviation nobody justified is a bug nobody noticed`);
    }
    return { case: row['case'], verb: row['verb'], status, reason: row['reason'] };
  });

  return {
    profile: PARTIAL_PROFILE,
    protocol_version: raw['protocol_version'],
    status,
    ...(blocker === undefined ? {} : { blocker }),
    gbrain_commit: raw['gbrain_commit'],
    observed_on: raw['observed_on'],
    rationale: raw['rationale'],
    deviations: parsed,
  };
}

const keyOf = (name: string, verb: string): string => `${verb}::${name}`;

/**
 * How one declared deviation compares to the case the runner actually graded.
 *
 * `null` means "observed exactly as declared". Split out so that
 * {@link tallyDeviations}'s invariant has a seam — see there.
 */
export function deviationOutcome(
  deviation: DeclaredDeviation,
  row: ConformanceCaseResult | undefined,
): DeltaViolation | null {
  if (row === undefined) {
    return {
      kind: 'absent_deviation',
      case: deviation.case,
      detail: `the runner never graded ${deviation.verb}/${deviation.case}; upstream renamed or dropped it, so re-take the pin`,
    };
  }
  if (row.status === 'pass') {
    return {
      kind: 'stale_deviation',
      case: deviation.case,
      detail: `${deviation.verb}/${deviation.case} now passes and is still published as a deviation; remove it from the delta`,
    };
  }
  if (row.status !== deviation.status) {
    return {
      kind: 'status_changed',
      case: deviation.case,
      detail: `${deviation.verb}/${deviation.case} is declared ${deviation.status} but the runner reports ${row.status}: ${row.detail}`,
    };
  }
  return null;
}

/**
 * Fold the per-declaration outcomes, refusing a fold that lost one.
 *
 * **Separated from {@link assertDelta} for the same reason `violationsOf` is
 * separated from `classifyFloors` in `evals/gates.ts`: the invariant is
 * otherwise unreachable and therefore untested.** No input `assertDelta` can
 * construct produces fewer outcomes than declarations — which is exactly why
 * the check has to exist (the defect it catches is a future `continue` that
 * skips a declaration) and exactly why it needs a seam a test can hand a short
 * list to. An assertion nothing can trigger is an assertion nobody has shown to
 * work.
 */
export function tallyDeviations(
  outcomes: readonly (DeltaViolation | null)[],
  declaredCount: number,
): { readonly violations: readonly DeltaViolation[]; readonly checked: number } {
  if (outcomes.length !== declaredCount) {
    throw new Error(
      `accounted for ${outcomes.length} of ${declaredCount} declared deviations; a delta check that skipped one is not a check`,
    );
  }
  const violations = outcomes.filter((outcome): outcome is DeltaViolation => outcome !== null);
  return { violations, checked: outcomes.length - violations.length };
}

/**
 * Compare an observed run against the published delta.
 *
 * `report` is `unknown` on purpose: the caller has just parsed a subprocess's
 * stdout, and the type it *believes* it has is exactly the belief this function
 * exists to check.
 */
export function assertDelta(
  report: unknown,
  delta: PublishedDelta,
  opts: { readonly gbrainCommit: string },
): DeltaResult {
  const violations: DeltaViolation[] = [];

  // First, and before the report is looked at: a delta that records a blocker
  // rather than a run cannot certify anything, whatever the runner said. There
  // is deliberately no branch below that reaches a pass from this state.
  if (delta.status === 'blocked') {
    return {
      passed: false,
      violations: [
        {
          kind: 'delta_not_observed',
          detail:
            `the published delta was never observed — [${delta.blocker?.kind ?? 'unknown'}] ` +
            `${delta.blocker?.detail ?? 'no detail recorded'}; ` +
            'until the runner can reach the surface there is no conformance verdict to give',
        },
      ],
      checked: 0,
    };
  }

  const problem = reportProblem(report);
  if (problem !== null) {
    // Everything downstream would be a comparison against nothing, and every
    // declared deviation would look satisfied. Stop here.
    return {
      passed: false,
      violations: [{ kind: 'unreadable_report', detail: `no gradeable conformance report: ${problem}` }],
      checked: 0,
    };
  }
  const observed = asReport(report as Record<string, unknown>);

  if (observed.results.length === 0) {
    return {
      passed: false,
      violations: [
        {
          kind: 'empty_report',
          detail: 'the runner graded zero cases; a target that answered nothing is not evidence of conformance',
        },
      ],
      checked: 0,
    };
  }

  // Re-derived, never trusted. A runner whose tallies disagree with its own
  // results is a runner whose verdict is not usable either way.
  const tally = { pass: 0, fail: 0, skip: 0 };
  for (const row of observed.results) tally[row.status] += 1;
  if (
    observed.passed !== tally.pass ||
    observed.failed !== tally.fail ||
    observed.skipped !== tally.skip ||
    observed.ok !== (tally.fail === 0)
  ) {
    violations.push({
      kind: 'inconsistent_report',
      detail:
        `the report says ${observed.passed}/${observed.failed}/${observed.skipped} (pass/fail/skip, ok=${observed.ok}) ` +
        `but carries ${tally.pass}/${tally.fail}/${tally.skip}`,
    });
  }

  if (observed.protocol_version !== delta.protocol_version) {
    violations.push({
      kind: 'protocol_version_mismatch',
      detail: `the runner reports MEMORY_VERBS v${observed.protocol_version}; the delta was published against v${delta.protocol_version}`,
    });
  }

  if (opts.gbrainCommit !== delta.gbrain_commit) {
    violations.push({
      kind: 'pin_mismatch',
      detail:
        `the delta was observed against gbrain ${delta.gbrain_commit} but the pinned build is ${opts.gbrainCommit}; ` +
        're-observe the delta as part of advancing the pin',
    });
  }

  const declared = new Map<string, DeclaredDeviation>();
  for (const deviation of delta.deviations) {
    const key = keyOf(deviation.case, deviation.verb);
    if (declared.has(key)) {
      violations.push({
        kind: 'duplicate_declaration',
        case: deviation.case,
        detail: `${deviation.verb}/${deviation.case} is declared more than once`,
      });
      continue;
    }
    declared.set(key, deviation);
  }

  const byKey = new Map<string, ConformanceCaseResult>();
  for (const row of observed.results) byKey.set(keyOf(row.name, row.verb), row);

  const outcomes = [...declared].map(([key, deviation]) => deviationOutcome(deviation, byKey.get(key)));
  const folded = tallyDeviations(outcomes, declared.size);
  violations.push(...folded.violations);
  const checked = folded.checked;

  for (const row of observed.results) {
    if (row.status === 'pass') continue;
    if (declared.has(keyOf(row.name, row.verb))) continue;
    violations.push({
      kind: 'undeclared_deviation',
      case: row.name,
      detail: `${row.verb}/${row.name} is ${row.status} and is not in the published delta: ${row.detail}`,
    });
  }

  return { passed: violations.length === 0, violations, checked };
}

/** One line per violation, for the command's output. */
export function renderDelta(result: DeltaResult, delta: PublishedDelta): string {
  if (result.passed) {
    return (
      `conformance: ${PARTIAL_PROFILE} holds — ${result.checked} published deviation(s) observed exactly as declared\n` +
      `  delta observed on ${delta.observed_on} against gbrain ${delta.gbrain_commit.slice(0, 12)}`
    );
  }
  const lines = [`conformance: ${PARTIAL_PROFILE} does NOT hold`];
  for (const violation of result.violations) {
    lines.push(`  [${violation.kind}] ${violation.detail}`);
  }
  return lines.join('\n');
}
