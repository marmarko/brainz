/**
 * R6's floors as data, R6a's calibration margins as data, and the checker that
 * refuses to pass a floor it did not actually measure.
 *
 * **The three ways a gate fails open, all handled explicitly.**
 *
 *   1. **A floor with no measurement.** If a report is missing the bucket a
 *      floor reads, the obvious implementations either throw at the wrong moment
 *      or treat `undefined` as passing. Here, a floor whose measurement cannot
 *      be located is a violation named `unmeasured`, and {@link checkFloors}
 *      additionally asserts that it evaluated every floor it was given.
 *   2. **A bucket with too few queries.** A per-type mean over one query is not
 *      a measurement, and a mean over zero is `NaN`. Every floor carries a
 *      `minimumQueries`, and a bucket below it is a violation rather than a
 *      skipped check.
 *   3. **A non-finite value.** `NaN <= x` is false and `!(NaN < x)` is true, so
 *      whether a NaN passes depends entirely on which way the comparison was
 *      written. Rather than depending on that, every value is checked with
 *      `Number.isFinite` **first**.
 *
 * **Where each number comes from.** The four absolute floors are R6's, quoted:
 * nDCG@10 ≥ 0.65, title-substring Hit@1 ≥ 0.95, alias Hit@1 ≥ 0.98, dilution
 * Hit@3 = 1.0. R6 also requires per-question-type floors and does **not** give
 * numbers for them. Rather than invent four new constants, the per-type floors
 * are R6's own aggregate bar applied per type — which is the minimal reading of
 * "per-question-type floors, never only an aggregate", and is strictly stronger
 * than the aggregate alone. Any per-type number that is not 0.65 would be a
 * number this unit made up, and it would be indistinguishable from a number
 * chosen to fit whatever the stack turned out to do.
 *
 * **The floors are absolute only once both R6a receipts are in hand**, which is
 * what R6's last sentence says and what `evals/receipts/` carries.
 */

import type { Corpus, QueryFamily, QuestionType } from './corpus.ts';
import type { EmbeddingIndex } from './embeddings.ts';
import { probeReach, type ProbeReach } from './lexical-reach.ts';
import type { EvalReport } from './run.ts';

export type MetricId = 'ndcg@10' | 'hit@1' | 'hit@3' | 'dilution_hit@3';

export type FloorScope =
  | { readonly kind: 'aggregate' }
  | { readonly kind: 'type'; readonly type: QuestionType }
  | { readonly kind: 'family'; readonly family: QueryFamily };

export interface RankingFloor {
  readonly id: string;
  readonly label: string;
  readonly metric: MetricId;
  readonly scope: FloorScope;
  /** R6's bar. A measurement below it fails the gate. */
  readonly minimum: number;
  /**
   * The smallest bucket this floor is meaningful over. Below it, the check is a
   * violation — never a skip, and never a pass by absence.
   */
  readonly minimumQueries: number;
  /**
   * R6a's lower bound: the strongest naive single-arm baseline must score at or
   * below `minimum - calibrationMargin`. "Meaningfully below" is not checkable;
   * a number is.
   */
  readonly calibrationMargin: number;
  readonly source: string;
}

/**
 * The ranking floors. Both R6a receipts scope to exactly this list.
 *
 * **On granularity, recorded here rather than discovered later.** A Hit floor
 * over N queries can only take the values k/N, so the floor's tolerance is a
 * property of N:
 *
 *   - title-substring at N=20 and a 0.95 floor: 19/20 = 0.95 passes, so exactly
 *     one miss is tolerated. This is why N is 20 rather than 14.
 *   - alias at N=14 and a 0.98 floor: 13/14 = 0.929 fails, so the floor is
 *     all-or-nothing. It would still be all-or-nothing at N=20 (0.95 < 0.98);
 *     tolerating one miss would need N ≥ 50, which this corpus is not sized for.
 *     That is a limitation of the fixture, not a property of R6, and it is
 *     stated so nobody later reads a 14/14 requirement as an accident.
 *   - dilution at a floor of exactly 1.0 is all-or-nothing by construction at
 *     any N. R6 wrote it that way.
 */
export const RANKING_FLOORS: readonly RankingFloor[] = [
  {
    id: 'aggregate.ndcg10',
    label: 'nDCG@10 over the whole query set',
    metric: 'ndcg@10',
    scope: { kind: 'aggregate' },
    minimum: 0.65,
    minimumQueries: 60,
    calibrationMargin: 0.1,
    source: 'R6 (blocking tier)',
  },
  {
    id: 'family.title_substring.hit1',
    label: 'title-substring Hit@1',
    metric: 'hit@1',
    scope: { kind: 'family', family: 'title_substring' },
    minimum: 0.95,
    minimumQueries: 20,
    calibrationMargin: 0.5,
    source: 'R6 (blocking tier)',
  },
  {
    id: 'family.alias.hit1',
    label: 'alias Hit@1',
    metric: 'hit@1',
    scope: { kind: 'family', family: 'alias' },
    minimum: 0.98,
    minimumQueries: 14,
    calibrationMargin: 0.5,
    source: 'R6 (blocking tier)',
  },
  {
    id: 'family.dilution.hit3',
    label: 'dilution Hit@3',
    metric: 'dilution_hit@3',
    scope: { kind: 'family', family: 'dilution' },
    minimum: 1,
    minimumQueries: 10,
    calibrationMargin: 0.5,
    source: 'R6 (blocking tier)',
  },
  {
    id: 'type.relational.ndcg10',
    label: 'relational nDCG@10',
    metric: 'ndcg@10',
    scope: { kind: 'type', type: 'relational' },
    minimum: 0.65,
    minimumQueries: 12,
    calibrationMargin: 0.1,
    source: "R6 (per-question-type; bar inherited from R6's aggregate)",
  },
  {
    id: 'type.named_entity.ndcg10',
    label: 'named-entity nDCG@10',
    metric: 'ndcg@10',
    scope: { kind: 'type', type: 'named_entity' },
    minimum: 0.65,
    minimumQueries: 12,
    calibrationMargin: 0.1,
    source: "R6 (per-question-type; bar inherited from R6's aggregate)",
  },
  {
    id: 'type.temporal.ndcg10',
    label: 'temporal nDCG@10',
    metric: 'ndcg@10',
    scope: { kind: 'type', type: 'temporal' },
    minimum: 0.65,
    minimumQueries: 12,
    calibrationMargin: 0.1,
    source: "R6 (per-question-type; bar inherited from R6's aggregate)",
  },
  {
    id: 'type.context_fenced.ndcg10',
    label: 'context-fenced nDCG@10',
    metric: 'ndcg@10',
    scope: { kind: 'type', type: 'context_fenced' },
    minimum: 0.65,
    minimumQueries: 12,
    calibrationMargin: 0.1,
    source: "R6 (per-question-type; bar inherited from R6's aggregate)",
  },
];

/**
 * R6's fifth blocking floor, which this harness deliberately does not score.
 *
 * Deterministic extraction recall is a property of an extractor, and the
 * extractor is U6's. R6a says so explicitly: this floor "records a rule-coverage
 * baseline instead, since a retrieval baseline produces no comparable score".
 * The baseline lives in `evals/extraction.ts` and its number is in the
 * lower-bound receipt; the floor itself binds when U6 ships the extractor.
 *
 * It is declared here rather than omitted so that a reader counting R6's floors
 * against this file finds five, not four.
 */
export const EXTRACTION_FLOOR = {
  id: 'extraction.deterministic-recall',
  label: 'deterministic extraction recall',
  minimum: 0.8,
  source: 'R6 (blocking tier)',
  scoredBy: 'U6 — this unit ships the gold key and the rule-coverage baseline only',
} as const;

export interface Measurement {
  readonly value: number;
  readonly count: number;
}

export type ViolationKind =
  | 'unmeasured'
  | 'insufficient_queries'
  | 'non_finite'
  | 'below_floor'
  | 'leak'
  /** A floor marked not-yet-measurable that is now at or above its bar. */
  | 'stale_deferral';

export interface FloorViolation {
  readonly floorId: string;
  readonly kind: ViolationKind;
  readonly detail: string;
  readonly value?: number;
  readonly minimum?: number;
}

export interface GateResult {
  readonly passed: boolean;
  readonly violations: readonly FloorViolation[];
  /** How many floors were actually evaluated. Compared against the input length. */
  readonly checked: number;
  readonly measurements: Readonly<Record<string, Measurement>>;
}

/**
 * Locate a floor's measurement in a report.
 *
 * Returns `undefined` only when the report genuinely does not carry the bucket —
 * which the caller turns into an `unmeasured` violation. It never invents a
 * value, and it never falls back to the aggregate when a scoped bucket is
 * missing: a per-type floor silently checked against the aggregate is a
 * per-type floor that does not exist.
 */
export function measure(report: EvalReport, floor: RankingFloor): Measurement | undefined {
  const bucket =
    floor.scope.kind === 'aggregate'
      ? report.aggregate
      : floor.scope.kind === 'type'
        ? report.byType[floor.scope.type]
        : report.byFamily[floor.scope.family];

  if (bucket === undefined) return undefined;

  switch (floor.metric) {
    case 'ndcg@10':
      return { value: bucket.ndcg10, count: bucket.count };
    case 'hit@1':
      return { value: bucket.hit1, count: bucket.count };
    case 'hit@3':
      return { value: bucket.hit3, count: bucket.count };
    case 'dilution_hit@3': {
      // Only the family buckets carry it, and asking for it anywhere else is a
      // mistake in the floor definition rather than a missing measurement.
      if (floor.scope.kind !== 'family') return undefined;
      const family = report.byFamily[floor.scope.family];
      if (family === undefined) return undefined;
      return { value: family.dilutionHit3, count: family.count };
    }
  }
}

/**
 * Check a report against a set of floors.
 *
 * Any leak — a fenced chunk, a deleted chunk, a chunk that is not in the corpus
 * — fails the gate on its own, before any score is considered. A stack that
 * returns content the asking credential may not see has not scored badly; it has
 * done something the scores are not equipped to describe.
 */
export function checkFloors(
  report: EvalReport,
  floors: readonly RankingFloor[] = RANKING_FLOORS,
): GateResult {
  if (floors.length === 0) {
    throw new Error('checkFloors was given no floors; an empty gate passes everything');
  }

  const violations: FloorViolation[] = [];
  const measurements: Record<string, Measurement> = {};
  let checked = 0;

  for (const violation of report.violations) {
    violations.push({
      floorId: 'visibility',
      kind: 'leak',
      detail: `${violation.queryId} returned ${violation.chunkId}: ${violation.detail}`,
    });
  }

  for (const floor of floors) {
    checked += 1;
    const measurement = measure(report, floor);

    if (measurement === undefined) {
      violations.push({
        floorId: floor.id,
        kind: 'unmeasured',
        detail: `the report carries no measurement for ${floor.label}`,
      });
      continue;
    }

    measurements[floor.id] = measurement;

    if (measurement.count < floor.minimumQueries) {
      violations.push({
        floorId: floor.id,
        kind: 'insufficient_queries',
        detail: `${floor.label} was measured over ${measurement.count} queries; ${floor.minimumQueries} is the minimum`,
        value: measurement.value,
        minimum: floor.minimum,
      });
      continue;
    }

    // Checked before any comparison, so the outcome does not depend on which
    // direction the comparison happens to be written in.
    if (!Number.isFinite(measurement.value)) {
      violations.push({
        floorId: floor.id,
        kind: 'non_finite',
        detail: `${floor.label} measured ${String(measurement.value)}, which is not a number a floor can be compared against`,
        minimum: floor.minimum,
      });
      continue;
    }

    if (measurement.value < floor.minimum) {
      violations.push({
        floorId: floor.id,
        kind: 'below_floor',
        detail: `${floor.label} is ${measurement.value.toFixed(4)}, below its floor of ${floor.minimum}`,
        value: measurement.value,
        minimum: floor.minimum,
      });
    }
  }

  if (checked !== floors.length) {
    throw new Error(`evaluated ${checked} of ${floors.length} floors; a gate that skipped a floor is not a gate`);
  }

  return { passed: violations.length === 0, violations, checked, measurements };
}

// ---------------------------------------------------------------------------
// The third state: a floor that is neither met nor missed, because the fixture
// cannot yet measure it.
// ---------------------------------------------------------------------------

/**
 * **A gate that quietly excuses itself is worse than a red one**, so this is
 * built to be impossible to abuse and impossible to forget.
 *
 * U7's committed vectors are synthetic (`evals/embeddings.ts`), so the vector
 * arm carries lexical recall and nothing else. A probe whose answer the corpus
 * offers no keyed path to is therefore not being measured — and saying so is
 * honest exactly once and corrosive forever after. Five conditions keep it
 * honest, and every one of them fails *toward enforcement*:
 *
 *   1. **Synthetic-only, counted from the manifest.** `EmbeddingIndex.sources`
 *      counts the rows. One provider vector anywhere and nothing is deferred —
 *      the deferral evaporates on its own the day real embeddings land, with
 *      nobody remembering to remove anything.
 *   2. **All-or-nothing floors only.** A mean has no probe responsible for it:
 *      every query moves it, so "which probes caused the miss" has no answer and
 *      the aggregate and per-type floors are always enforced. Only `hit@k` and
 *      the dilution metric can be deferred.
 *   3. **Every responsible probe must be eligible**, and eligibility is derived
 *      by `evals/lexical-reach.ts` from the corpus — not from a list. One
 *      isolable probe among the misses and the floor is MISSED, in full.
 *   4. **A deferred floor that would pass is a violation** (`stale_deferral`).
 *      A deferral nobody removed is how this becomes permanent, so the state is
 *      only reachable while the measurement is genuinely below the bar.
 *   5. **The evidence is carried, not asserted.** Every deferral names its
 *      probes, the keys their gold could not match, and how many other things in
 *      the corpus carry what it does. `test/core/search/floors.test.ts` prints
 *      the whole block on every run and pins the exact set.
 */
export type FloorStatus = 'met' | 'missed' | 'deferred';

export interface DeferredProbe {
  readonly queryId: string;
  /** Why this probe was on the hook: `hit@1` missed, or these groups crowded out. */
  readonly detail: string;
  readonly reach: ProbeReach;
}

export interface FloorOutcome {
  readonly floorId: string;
  readonly label: string;
  readonly status: FloorStatus;
  readonly value: number;
  readonly minimum: number;
  readonly count: number;
  /** Populated only when `status` is `deferred`. */
  readonly deferred?: {
    readonly reason: string;
    readonly probes: readonly DeferredProbe[];
  };
}

export interface DeferralContext {
  readonly corpus: Corpus;
  readonly embeddings: EmbeddingIndex;
}

/**
 * The rank a floor's metric reads, or `undefined` for the metrics that cannot be
 * deferred at all.
 *
 * **Exported because condition 2 is otherwise only observable through a report
 * that happens to exercise it.** A mutation making `ndcg@10` return a cutoff
 * walks past any behavioural test whose blocked probes happen to be isolable at
 * that cutoff; the structural claim — *a mean has no rank* — has to be assertable
 * on its own.
 */
export function deferrableCutoffFor(metric: MetricId): number | undefined {
  switch (metric) {
    case 'hit@1':
      return 1;
    case 'hit@3':
    case 'dilution_hit@3':
      return 3;
    case 'ndcg@10':
      // A mean over every query. No probe is responsible for it — see condition
      // 2 above — so it is never deferrable.
      return undefined;
  }
}

/** The queries a floor's measurement is taken over. */
function probesFor(report: EvalReport, floor: RankingFloor): readonly EvalReport['perQuery'][number][] {
  switch (floor.scope.kind) {
    case 'aggregate':
      return report.perQuery;
    case 'type': {
      const type = floor.scope.type;
      return report.perQuery.filter((outcome) => outcome.type === type);
    }
    case 'family': {
      const family = floor.scope.family;
      return report.perQuery.filter((outcome) => outcome.family === family);
    }
  }
}

/**
 * Classify one floor: met, missed, or not yet measurable.
 *
 * Returns `missed` for anything it cannot prove is deferrable, including every
 * case where the report does not carry what it would need to decide. There is no
 * branch here that reaches `deferred` by absence.
 */
export function classifyFloor(
  report: EvalReport,
  floor: RankingFloor,
  context: DeferralContext,
): FloorOutcome {
  const measurement = measure(report, floor);
  const base = {
    floorId: floor.id,
    label: floor.label,
    value: measurement?.value ?? Number.NaN,
    minimum: floor.minimum,
    count: measurement?.count ?? 0,
  };

  if (
    measurement === undefined ||
    measurement.count < floor.minimumQueries ||
    !Number.isFinite(measurement.value)
  ) {
    return { ...base, status: 'missed' };
  }
  if (measurement.value >= floor.minimum) return { ...base, status: 'met' };

  // Condition 1. Counted from the manifest rows, never declared.
  if (context.embeddings.sources.provider > 0) return { ...base, status: 'missed' };

  // Condition 2.
  const cutoff = deferrableCutoffFor(floor.metric);
  if (cutoff === undefined) return { ...base, status: 'missed' };

  // Condition 3. Every probe responsible for the miss must be one the corpus
  // offers no keyed path to.
  const responsible: DeferredProbe[] = [];
  for (const outcome of probesFor(report, floor)) {
    const query = context.corpus.queriesById.get(outcome.queryId);
    if (query === undefined) return { ...base, status: 'missed' };

    let required: readonly string[] = [];
    let detail = '';
    if (floor.metric === 'dilution_hit@3') {
      if (outcome.dilutionHit3 !== 0) continue;
      const chunks = outcome.missedGroups.flatMap((group) =>
        [...context.corpus.chunks.keys()].filter((id) => context.corpus.groupOf(id) === group),
      );
      // A dilution miss with no named group is a metric that cannot say what it
      // measured. Refuse rather than guess.
      if (chunks.length === 0) return { ...base, status: 'missed' };
      required = chunks;
      detail = `required duplicate groups crowded out of the top 3: ${outcome.missedGroups.join(', ')}`;
    } else {
      const hit = floor.metric === 'hit@1' ? outcome.hit1 : outcome.hit3;
      if (hit !== 0) continue;
      required = query.answers;
      detail = `no gold answer reached rank ${cutoff}`;
    }

    const reach = probeReach(context.corpus, query, required, cutoff);
    if (!reach.semanticOnly) return { ...base, status: 'missed' };
    responsible.push({ queryId: outcome.queryId, detail, reach });
  }

  // A floor below its bar with nothing responsible for it is arithmetic nobody
  // understands. Enforce it.
  if (responsible.length === 0) return { ...base, status: 'missed' };

  return {
    ...base,
    status: 'deferred',
    deferred: {
      reason:
        'the committed vectors are synthetic, so the vector arm carries lexical recall only; every probe below needs recall this corpus offers no keyed path to',
      probes: responsible,
    },
  };
}

export interface ClassifiedGate {
  readonly outcomes: readonly FloorOutcome[];
  readonly deferrals: readonly FloorOutcome[];
  readonly violations: readonly FloorViolation[];
  readonly passed: boolean;
}

/**
 * The whole gate, with the third state.
 *
 * A leak is still fatal on its own and still comes first: a stack that returned
 * content the asking credential may not see has not scored badly, and no state
 * of the fixture excuses it.
 */
export function classifyFloors(
  report: EvalReport,
  floors: readonly RankingFloor[] = RANKING_FLOORS,
  context: DeferralContext,
): ClassifiedGate {
  if (floors.length === 0) {
    throw new Error('classifyFloors was given no floors; an empty gate passes everything');
  }

  const violations: FloorViolation[] = [];
  for (const violation of report.violations) {
    violations.push({
      floorId: 'visibility',
      kind: 'leak',
      detail: `${violation.queryId} returned ${violation.chunkId}: ${violation.detail}`,
    });
  }

  const outcomes = floors.map((floor) => classifyFloor(report, floor, context));
  violations.push(...violationsOf(outcomes));

  return {
    outcomes,
    deferrals: outcomes.filter((outcome) => outcome.status === 'deferred'),
    violations,
    passed: violations.length === 0,
  };
}

/**
 * Turn classified outcomes into violations.
 *
 * Separated from {@link classifyFloors} for one reason: **condition 4 is
 * otherwise unreachable and therefore untested.** `classifyFloor` only returns
 * `deferred` below the bar, so a deferred-and-passing outcome cannot be produced
 * through the public path — which is exactly why the check has to exist and
 * exactly why it needs a seam a test can hand one to. An assertion nothing can
 * trigger is an assertion nobody has shown to work.
 */
export function violationsOf(outcomes: readonly FloorOutcome[]): FloorViolation[] {
  const violations: FloorViolation[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === 'met') continue;
    if (outcome.status === 'deferred') {
      if (outcome.value >= outcome.minimum) {
        violations.push({
          floorId: outcome.floorId,
          kind: 'stale_deferral',
          detail: `${outcome.label} is ${outcome.value.toFixed(4)}, at or above its floor of ${outcome.minimum}, and is still deferred; remove the deferral`,
          value: outcome.value,
          minimum: outcome.minimum,
        });
      }
      continue;
    }
    violations.push({
      floorId: outcome.floorId,
      kind: 'below_floor',
      detail: `${outcome.label} is ${Number.isFinite(outcome.value) ? outcome.value.toFixed(4) : String(outcome.value)} over ${outcome.count} queries, below its floor of ${outcome.minimum}`,
      value: outcome.value,
      minimum: outcome.minimum,
    });
  }
  return violations;
}

/** The deferral block, for the suite's output. One line per probe, every run. */
export function renderDeferrals(gate: ClassifiedGate): string {
  const lines: string[] = [];
  const rule = '-'.repeat(78);
  lines.push(rule);
  if (gate.deferrals.length === 0) {
    lines.push(' 0 floors deferred — every R6 floor below is being measured and enforced.');
    lines.push(rule);
    return lines.join('\n');
  }

  lines.push(
    ` ${gate.deferrals.length} of ${gate.outcomes.length} R6 floors NOT YET MEASURABLE — the committed vectors are`,
  );
  lines.push(' synthetic (hashed lexical projections), so the vector arm is a second keyword');
  lines.push(' arm. These floors are neither met nor enforced. Regenerate embeddings from a');
  lines.push(' real provider and they enforce themselves again — see evals/README.md.');
  for (const outcome of gate.deferrals) {
    lines.push('');
    lines.push(
      ` [deferred] ${outcome.floorId}: ${outcome.value.toFixed(4)} against a floor of ${outcome.minimum}`,
    );
    for (const probe of outcome.deferred?.probes ?? []) {
      lines.push(`   ${probe.queryId} — ${probe.detail}`);
      for (const verdict of probe.reach.verdicts) {
        lines.push(
          `     ${verdict.chunkId}: query keys it cannot match [${verdict.uncovered.join(', ')}];` +
            ` keys it carries [${verdict.carried.join(', ')}] are shared with ${verdict.dominators.length}` +
            ` other group(s), against a cutoff of ${verdict.cutoff}`,
        );
      }
    }
  }
  lines.push(rule);
  return lines.join('\n');
}

export interface CalibrationRow {
  readonly floorId: string;
  readonly label: string;
  readonly minimum: number;
  readonly margin: number;
  /** `minimum - margin`. The naive baseline must be at or below this. */
  readonly ceiling: number;
  readonly naive: number;
  readonly naiveBy: string;
  readonly clears: boolean;
}

/**
 * R6a's lower bound, as a check rather than as prose.
 *
 * `naiveByFloor` maps a floor id to the **strongest** value any naive arm
 * achieved on it, and the id of the arm that achieved it. A floor with no entry
 * is a hole in the receipt, so it throws rather than being skipped.
 */
export function checkLowerBound(
  naiveByFloor: ReadonlyMap<string, { readonly value: number; readonly ranker: string }>,
  floors: readonly RankingFloor[] = RANKING_FLOORS,
): { readonly rows: readonly CalibrationRow[]; readonly clears: boolean } {
  const rows: CalibrationRow[] = [];

  for (const floor of floors) {
    const naive = naiveByFloor.get(floor.id);
    if (naive === undefined) {
      throw new Error(`no naive baseline value for ${floor.id}; the lower-bound receipt would have a hole in it`);
    }
    if (!Number.isFinite(naive.value)) {
      throw new Error(`naive baseline value for ${floor.id} is not finite`);
    }
    const ceiling = floor.minimum - floor.calibrationMargin;
    rows.push({
      floorId: floor.id,
      label: floor.label,
      minimum: floor.minimum,
      margin: floor.calibrationMargin,
      ceiling,
      naive: naive.value,
      naiveBy: naive.ranker,
      clears: naive.value <= ceiling,
    });
  }

  return { rows, clears: rows.every((row) => row.clears) };
}
