/**
 * `bun run evals/calibrate.ts` — recomputes both R6a calibration receipts and
 * writes them to `evals/receipts/`.
 *
 * **Why two receipts, and why one of them is not enough.** R6a is explicit: one
 * receipt proves half of what stop condition (c) leans on.
 *
 *   - **Lower bound.** The strongest naive single-arm baseline scores at or
 *     below `floor − margin` on every ranking floor. Without it, a later green
 *     run proves only that the corpus is easy.
 *   - **Upper bound (attainability).** The gold key, scored through the *same*
 *     metric implementation, reaches the theoretical maximum on every floor;
 *     plus a hand audit, per question type, of why each answer is reachable.
 *     Without it, a floor miss is indistinguishable from a corpus that was
 *     simply harder than gbrain's, and stop condition (c) would read a hard
 *     fixture as an accuracy-architecture failure.
 *
 * **The receipts are committed artifacts, not console output.** They are JSON,
 * with a Markdown companion for humans, and `test/evals/receipts.test.ts`
 * recomputes them and deep-compares. A corpus edit that moves a number and is
 * not accompanied by a regenerated receipt turns the suite red — which is the
 * only mechanism that keeps a receipt honest once it has been written.
 *
 * **No wall-clock timestamps appear in the compared payload.** A date would make
 * every regeneration a diff and would make the drift test compare a clock. The
 * corpus digest and the embedding-manifest digest are the identity; git carries
 * the date.
 */

import { CORPUS, CORPUS_DIGEST, corpusTexts } from './corpus.ts';
import { loadEmbeddings, SYNTHETIC_GENERATOR, SYNTHETIC_MODEL } from './embeddings.ts';
import { ruleCoverage } from './extraction.ts';
import { QUESTION_TYPES } from './fixtures/types.ts';
import {
  checkFloors,
  checkLowerBound,
  EXTRACTION_FLOOR,
  measure,
  RANKING_FLOORS,
  type CalibrationRow,
} from './gates.ts';
import { goldOracle, NAIVE_BASELINES, strongestNaive } from './baselines.ts';
import { runEval, type EvalReport, type RankerContext } from './run.ts';
import { MANIFEST_PATH } from './regenerate-embeddings.ts';

export const LOWER_BOUND_PATH = 'evals/receipts/r6a-lower-bound.json';
export const UPPER_BOUND_PATH = 'evals/receipts/r6a-upper-bound.json';
export const SUMMARY_PATH = 'evals/receipts/README.md';

export interface LowerBoundReceipt {
  readonly receipt: 'R6a lower bound (non-triviality)';
  readonly requirement: string;
  readonly corpus_digest: string;
  readonly embedding_manifest_digest: string;
  readonly embedding_source: { readonly kind: string; readonly model: string; readonly generator: string };
  readonly baselines: readonly { readonly name: string; readonly description: string }[];
  readonly rule: string;
  readonly rows: readonly CalibrationRow[];
  readonly clears: boolean;
  readonly per_baseline: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly extraction_rule_coverage: ReturnType<typeof ruleCoverage> & {
    readonly note: string;
    readonly headroom: number;
    readonly finding: string;
  };
  readonly threats_to_validity: readonly string[];
}

export interface UpperBoundReceipt {
  readonly receipt: 'R6a upper bound (attainability)';
  readonly requirement: string;
  readonly corpus_digest: string;
  readonly embedding_manifest_digest: string;
  readonly oracle: string;
  readonly rows: readonly {
    readonly floorId: string;
    readonly label: string;
    readonly minimum: number;
    readonly oracleValue: number;
    readonly theoreticalMaximum: number;
    readonly attains: boolean;
    readonly queries: number;
    readonly minimumQueries: number;
  }[];
  readonly attains: boolean;
  readonly gate_on_oracle: { readonly passed: boolean; readonly violations: number };
  readonly answerability_audit: {
    readonly audited: number;
    readonly total: number;
    readonly coverage: number;
    readonly by_type: Readonly<Record<string, { readonly queries: number; readonly audited: number }>>;
    readonly mechanism_histogram: Readonly<Record<string, number>>;
    readonly note: string;
  };
  readonly known_limitations: readonly string[];
}

function contextFor(manifest: string): RankerContext {
  return { corpus: CORPUS, embeddings: loadEmbeddings(manifest, corpusTexts(CORPUS)) };
}

function valuesByFloor(report: EvalReport): Record<string, number> {
  const values: Record<string, number> = {};
  for (const floor of RANKING_FLOORS) {
    const measurement = measure(report, floor);
    if (measurement === undefined) {
      throw new Error(`report for ${report.ranker} carries no measurement for ${floor.id}`);
    }
    values[floor.id] = measurement.value;
  }
  return values;
}

export function buildLowerBound(manifest: string): LowerBoundReceipt {
  const context = contextFor(manifest);
  const reports = NAIVE_BASELINES.map((ranker) => ({ ranker, report: runEval(ranker, context) }));

  for (const { ranker, report } of reports) {
    // A naive baseline that leaked would score artificially low and quietly make
    // the lower bound easier to clear. It is refused rather than recorded.
    if (report.violations.length > 0) {
      throw new Error(`naive baseline ${ranker.name} produced ${report.violations.length} violations`);
    }
  }

  const perBaseline: Record<string, Record<string, number>> = {};
  for (const { ranker, report } of reports) perBaseline[ranker.name] = valuesByFloor(report);

  const strongest = new Map<string, { value: number; ranker: string }>();
  for (const floor of RANKING_FLOORS) {
    const candidates = reports.map(({ ranker, report }) => {
      const measurement = measure(report, floor);
      if (measurement === undefined) throw new Error(`no measurement for ${floor.id} from ${ranker.name}`);
      return { value: measurement.value, ranker: ranker.name };
    });
    const best = strongestNaive(candidates.map((candidate) => candidate.value));
    const winner = candidates.find((candidate) => candidate.value === best);
    if (winner === undefined) throw new Error(`could not attribute the strongest naive value for ${floor.id}`);
    strongest.set(floor.id, winner);
  }

  const { rows, clears } = checkLowerBound(strongest);
  const coverage = ruleCoverage(CORPUS);

  return {
    receipt: 'R6a lower bound (non-triviality)',
    requirement:
      'R6a: a naive single-arm baseline scores below each ranking floor by a committed numeric margin, so a later pass proves the stack rather than an easy corpus.',
    corpus_digest: CORPUS_DIGEST,
    embedding_manifest_digest: context.embeddings.manifestDigest,
    embedding_source: { kind: 'synthetic', model: SYNTHETIC_MODEL, generator: SYNTHETIC_GENERATOR },
    baselines: NAIVE_BASELINES.map((ranker) => ({ name: ranker.name, description: ranker.description })),
    rule: 'For each floor, the STRONGEST value achieved by any naive arm must be <= (minimum - margin). Taking the strongest rather than a chosen arm removes the thumb from the scale.',
    rows,
    clears,
    per_baseline: perBaseline,
    extraction_rule_coverage: {
      ...coverage,
      note: `R6a gives the deterministic-extraction floor a rule-coverage baseline instead of a retrieval one, because a rule-free extractor extracts nothing and produces no comparable score. Coverage is the CEILING on deterministic recall over this corpus: ${coverage.reachable} of ${coverage.totalFacts} gold facts are in reach of a declared rule family. R6's floor is ${EXTRACTION_FLOOR.minimum}.`,
      headroom: coverage.coverage - EXTRACTION_FLOOR.minimum,
      finding:
        'FLAGGED: the ceiling equals the floor exactly. R6 asks deterministic extraction for 0.8 recall and this corpus puts only 0.8 of its gold facts within reach of a rule, so U6\'s extractor would have to be perfect on every rule-reachable fact to clear the floor and one miss fails it. That is a knife edge, and it is a fixture property rather than an implementation one. Two ways out, both belonging to the gates half of this unit rather than to the corpus half: widen the deterministic rule families so more of the gold key is reachable, or re-scope the floor to recall-over-rule-reachable-facts, which is the quantity a deterministic extractor can actually be held to. Recorded rather than resolved here, because resolving it by reclassifying facts until the number looks comfortable is the exact failure R6a exists to prevent.',
    },
    threats_to_validity: [
      'The committed vectors are synthetic (hashed lexical projections), so the vector-arm baseline is today a second lexical arm rather than an independent signal. When real embeddings land it will get stronger, the margin will narrow, and this receipt must be recomputed.',
      'A large share of the corpus\'s difficulty comes from a deliberate population of question-shaped chat and mail rows that lexically mirror the query set and answer nothing. That is a faithful property of conversational memory, but it means part of what the floors reward is telling a question from an answer (source-type priors, intent) rather than ranking alone.',
      'The dilution family draws ten queries from five duplicate clusters at two phrasings each. Two phrasings over one cluster is a weaker signal than two clusters would be.',
      'The corpus was authored to be hard for the naive arms measured here, which is what R6a asks for. It could not be tuned toward the ranking stack, because it was authored before U5 existed — that sequencing is the load-bearing part of U7\'s dependency line, not a convenience.',
      'The alias floor at 0.98 over 14 queries is arithmetically all-or-nothing; see the granularity note in evals/gates.ts.',
    ],
  };
}

export function buildUpperBound(manifest: string): UpperBoundReceipt {
  const context = contextFor(manifest);
  const report = runEval(goldOracle, context);
  const gate = checkFloors(report);

  const rows = RANKING_FLOORS.map((floor) => {
    const measurement = measure(report, floor);
    if (measurement === undefined) throw new Error(`oracle report carries no measurement for ${floor.id}`);
    // Every metric in this suite is bounded above by 1, so the theoretical
    // maximum is 1 for all of them. Stated as data rather than assumed, so a
    // future unbounded metric cannot silently inherit the assumption.
    const theoreticalMaximum = 1;
    return {
      floorId: floor.id,
      label: floor.label,
      minimum: floor.minimum,
      oracleValue: measurement.value,
      theoreticalMaximum,
      attains: measurement.value >= theoreticalMaximum,
      queries: measurement.count,
      minimumQueries: floor.minimumQueries,
    };
  });

  const byType: Record<string, { queries: number; audited: number }> = {};
  for (const type of QUESTION_TYPES) byType[type] = { queries: 0, audited: 0 };
  const mechanisms: Record<string, number> = {};
  let audited = 0;

  for (const query of CORPUS.queries) {
    const bucket = byType[query.type];
    if (bucket === undefined) throw new Error(`query ${query.id} has an unbucketed type`);
    bucket.queries += 1;
    if (query.evidence.trim().length > 0 && query.mechanisms.length > 0) {
      bucket.audited += 1;
      audited += 1;
    }
    for (const mechanism of query.mechanisms) {
      mechanisms[mechanism] = (mechanisms[mechanism] ?? 0) + 1;
    }
  }

  return {
    receipt: 'R6a upper bound (attainability)',
    requirement:
      'R6a: the gold answer key scored through the same metric implementation, plus a hand-audited answerability sample per question type, so a miss cannot be misread as an architecture failure on a corpus that was simply harder than gbrain\'s.',
    corpus_digest: CORPUS_DIGEST,
    embedding_manifest_digest: context.embeddings.manifestDigest,
    oracle: goldOracle.description,
    rows,
    attains: rows.every((row) => row.attains),
    gate_on_oracle: { passed: gate.passed, violations: gate.violations.length },
    answerability_audit: {
      audited,
      total: CORPUS.queries.length,
      coverage: audited / CORPUS.queries.length,
      by_type: byType,
      mechanism_histogram: mechanisms,
      note: 'R6a asks for a sample per question type; the audit is 100% because a sample leaves the unaudited remainder as the place a broken gold key hides. Every mechanism id is validated against upstream/concepts.jsonl by test/evals/answerability.test.ts, including that its owning unit lands by U5 — a query answerable only by a U11 or U12 mechanism would be unanswerable by the stack these floors grade. The audit is the corpus author\'s, performed at authoring time; a second-party audit is a separate action and is not claimed here.',
    },
    known_limitations: [
      'The oracle scoring 1.0 is necessary, not sufficient: it proves the gold key is well-formed, visible under each query\'s own grant, and reachable in the top three where dilution requires it. It does not prove a real stack can find those chunks.',
      'Attainability of the deterministic-extraction floor is recorded in the lower-bound receipt instead, as R6a directs, because it is a rule-coverage question rather than a ranking one.',
      'Cross-encoder scores for every (query, candidate) pair — the other half of U7 step 1 — are not in this corpus. They belong to the gates half of the unit, which needs a running server.',
    ],
  };
}

function summaryMarkdown(lower: LowerBoundReceipt, upper: UpperBoundReceipt): string {
  const lines: string[] = [];
  lines.push('# R6a calibration receipts');
  lines.push('');
  lines.push(
    'Generated by `bun run evals/calibrate.ts`. Do not edit by hand — `test/evals/receipts.test.ts` recomputes both and fails on any difference.',
  );
  lines.push('');
  lines.push(`- corpus digest: \`${lower.corpus_digest}\``);
  lines.push(`- embedding manifest digest: \`${lower.embedding_manifest_digest}\``);
  lines.push(`- embeddings: **${lower.embedding_source.kind}** (\`${lower.embedding_source.model}\`, generator \`${lower.embedding_source.generator}\`)`);
  lines.push('');
  lines.push('## Lower bound — the corpus is not trivial');
  lines.push('');
  lines.push(`Verdict: **${lower.clears ? 'CLEARS' : 'DOES NOT CLEAR'}**`);
  lines.push('');
  lines.push('| floor | R6 minimum | margin | ceiling | strongest naive | by | clears |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const row of lower.rows) {
    lines.push(
      `| ${row.label} | ${row.minimum} | ${row.margin} | ${row.ceiling.toFixed(3)} | ${row.naive.toFixed(4)} | \`${row.naiveBy}\` | ${row.clears ? 'yes' : '**NO**'} |`,
    );
  }
  lines.push('');
  lines.push(
    `Deterministic-extraction rule coverage: **${lower.extraction_rule_coverage.reachable}/${lower.extraction_rule_coverage.totalFacts} = ${lower.extraction_rule_coverage.coverage.toFixed(3)}** against R6's floor of ${lower.extraction_rule_coverage.floor} — attainable: **${lower.extraction_rule_coverage.floorIsAttainable ? 'yes' : 'no'}**.`,
  );
  lines.push('');
  lines.push(`> **Finding.** ${lower.extraction_rule_coverage.finding}`);
  lines.push('');
  lines.push('## Upper bound — the corpus is attainable');
  lines.push('');
  lines.push(`Verdict: **${upper.attains ? 'ATTAINABLE' : 'NOT ATTAINABLE'}**`);
  lines.push('');
  lines.push('| floor | R6 minimum | gold key scores | max | queries | attains |');
  lines.push('|---|---|---|---|---|---|');
  for (const row of upper.rows) {
    lines.push(
      `| ${row.label} | ${row.minimum} | ${row.oracleValue.toFixed(4)} | ${row.theoreticalMaximum} | ${row.queries} | ${row.attains ? 'yes' : '**NO**'} |`,
    );
  }
  lines.push('');
  lines.push(
    `Answerability audit: **${upper.answerability_audit.audited}/${upper.answerability_audit.total}** queries carry an evidence chain and at least one named stack mechanism.`,
  );
  lines.push('');
  lines.push('## Threats to validity');
  lines.push('');
  for (const threat of lower.threats_to_validity) lines.push(`- ${threat}`);
  lines.push('');
  lines.push('## Known limitations of the upper bound');
  lines.push('');
  for (const limitation of upper.known_limitations) lines.push(`- ${limitation}`);
  lines.push('');
  return lines.join('\n');
}

export async function readManifest(): Promise<string> {
  return await Bun.file(MANIFEST_PATH).text();
}

export function renderSummary(lower: LowerBoundReceipt, upper: UpperBoundReceipt): string {
  return summaryMarkdown(lower, upper);
}

/** Stable two-space JSON, newline-terminated, so a regeneration diffs cleanly. */
export function renderReceipt(receipt: unknown): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

if (import.meta.main) {
  const manifest = await readManifest();
  const lower = buildLowerBound(manifest);
  const upper = buildUpperBound(manifest);

  await Bun.write(LOWER_BOUND_PATH, renderReceipt(lower));
  await Bun.write(UPPER_BOUND_PATH, renderReceipt(upper));
  await Bun.write(SUMMARY_PATH, renderSummary(lower, upper));

  process.stderr.write(
    `lower bound: ${lower.clears ? 'CLEARS' : 'DOES NOT CLEAR'}; upper bound: ${upper.attains ? 'ATTAINABLE' : 'NOT ATTAINABLE'}\n`,
  );
  // A calibration run that did not calibrate must not exit 0. This script is the
  // thing that would otherwise be read as "the receipts were regenerated, fine".
  if (!lower.clears || !upper.attains) process.exit(1);
}
