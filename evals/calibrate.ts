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
import { loadEmbeddings, SYNTHETIC_GENERATOR, SYNTHETIC_MODEL, type EmbeddingIndex } from './embeddings.ts';
import { probeReach } from './lexical-reach.ts';
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
  readonly embedding_source: EmbeddingSource;
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
  readonly semantic_reach: SemanticReach;
  readonly threats_to_validity: readonly string[];
}

/**
 * What the vectors in the manifest actually are, **counted from its rows**.
 *
 * The previous shape of this field was the string `'synthetic'`, written into
 * the receipt by hand. A hand-written claim about the fixture is a claim that
 * keeps its value after it stops being true, and this one is load-bearing: the
 * gate will only report a floor "not yet measurable" while the vectors really
 * are a stand-in. So it is derived, here and in `evals/gates.ts`, from the same
 * count.
 */
export interface EmbeddingSource {
  readonly kind: 'synthetic' | 'provider' | 'mixed';
  readonly synthetic: number;
  readonly provider: number;
  /** Present while any synthetic vector remains; they are reproducible from text. */
  readonly model?: string;
  readonly generator?: string;
}

/**
 * Which gold answers this corpus offers **no keyed path** to, per all-or-nothing
 * floor.
 *
 * A property of the fixture, not of any ranking: `evals/lexical-reach.ts` reads
 * the corpus, the query and nothing else. It is recorded here so a reader can
 * learn, without running anything, which of R6's floors this corpus can prove
 * today and which of them are waiting on real embeddings — and so that a corpus
 * edit which changes the answer has to change a committed receipt.
 */
export interface SemanticReach {
  readonly note: string;
  readonly rows: readonly {
    readonly floorId: string;
    readonly queryId: string;
    readonly cutoff: number;
    /** Answer chunks, or the chunks of a required duplicate group. */
    readonly required: readonly string[];
    /** Keys the query supplied that the answer's whole page cannot match. */
    readonly uncovered: readonly string[];
    /** How many other groups carry everything the answer carries. */
    readonly dominators: number;
  }[];
  readonly blocked_probes: number;
  readonly total_probes: number;
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

function embeddingSourceOf(embeddings: EmbeddingIndex): EmbeddingSource {
  const { synthetic, provider } = embeddings.sources;
  const kind = provider === 0 ? 'synthetic' : synthetic === 0 ? 'provider' : 'mixed';
  return {
    kind,
    synthetic,
    provider,
    ...(synthetic > 0 ? { model: SYNTHETIC_MODEL, generator: SYNTHETIC_GENERATOR } : {}),
  };
}

/**
 * The reach table: every probe of an all-or-nothing floor whose required answer
 * the corpus offers no keyed path to.
 *
 * Hit floors ask about their answer chunks; the dilution floor asks about each
 * required duplicate group separately, because a probe requiring two clusters
 * can be blocked on one of them and trivially reachable on the other — which is
 * exactly the shape of this corpus's pilot probes.
 */
function semanticReachOf(): SemanticReach {
  const rows: Array<SemanticReach['rows'][number]> = [];
  const blocked = new Set<string>();
  let total = 0;

  for (const query of CORPUS.queries) {
    if (query.family === 'alias' || query.family === 'title_substring') {
      total += 1;
      const reach = probeReach(CORPUS, query, query.answers, 1);
      if (!reach.semanticOnly) continue;
      blocked.add(query.id);
      rows.push({
        floorId: `family.${query.family}.hit1`,
        queryId: query.id,
        cutoff: 1,
        required: [...query.answers],
        uncovered: reach.verdicts.flatMap((verdict) => [...verdict.uncovered]),
        dominators: Math.min(...reach.verdicts.map((verdict) => verdict.dominators.length)),
      });
      continue;
    }
    if (query.family !== 'dilution') continue;
    total += 1;
    for (const group of query.requiredGroups ?? []) {
      const chunks = [...CORPUS.chunks.keys()].filter((id) => CORPUS.groupOf(id) === group);
      if (chunks.length === 0) continue;
      const reach = probeReach(CORPUS, query, chunks, 3);
      if (!reach.semanticOnly) continue;
      blocked.add(query.id);
      rows.push({
        floorId: 'family.dilution.hit3',
        queryId: query.id,
        cutoff: 3,
        required: chunks,
        uncovered: reach.verdicts.flatMap((verdict) => [...verdict.uncovered]),
        dominators: Math.min(...reach.verdicts.map((verdict) => verdict.dominators.length)),
      });
    }
  }

  return {
    note:
      "A probe is listed when the query supplied evidence the answer's whole page cannot match AND what the answer does carry is shared with at least as many other groups as the metric has slots. Under the committed synthetic vectors nothing can supply the missing half, so `evals/gates.ts` reports a floor these probes miss as `deferred` rather than met or failed. Regenerating the manifest from a real provider revokes every deferral automatically — the switch is the provider count in this receipt, not a constant anywhere.",
    rows,
    blocked_probes: blocked.size,
    total_probes: total,
  };
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
    embedding_source: embeddingSourceOf(context.embeddings),
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
    semantic_reach: semanticReachOf(),
    threats_to_validity: [
      'The committed vectors are synthetic (hashed lexical projections), so the vector-arm baseline is today a second lexical arm rather than an independent signal. When real embeddings land it will get stronger, the margin will narrow, and this receipt must be recomputed.',
      'A large share of the corpus\'s difficulty comes from a deliberate population of question-shaped chat and mail rows that lexically mirror the query set and answer nothing. That is a faithful property of conversational memory, but it means part of what the floors reward is telling a question from an answer (source-type priors, intent) rather than ranking alone.',
      'The dilution family draws ten queries from five duplicate clusters at two phrasings each. Two phrasings over one cluster is a weaker signal than two clusters would be.',
      'The corpus was authored to be hard for the naive arms measured here, which is what R6a asks for. It could not be tuned toward the ranking stack, because it was authored before U5 existed — that sequencing is the load-bearing part of U7\'s dependency line, not a convenience.',
      'The alias floor at 0.98 over 14 queries is arithmetically all-or-nothing; see the granularity note in evals/gates.ts.',
      "The blocking tier's stand-in for the full-text arm scores every chunk sharing any query term, while production's `websearch_to_tsquery` ANDs its terms and recalls only chunks carrying all of them. The stand-in therefore recalls strictly more than the fleet does on multi-term queries, and these floors flatter production by that difference. Measured, not estimated: switching the stand-in to conjunctive recall moves the aggregate from 0.8269 to 0.7616 and takes the context-fenced floor below its bar. Closing it is stack work rather than fixture work and is not in this unit.",
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
  lines.push(
    `- embeddings: **${lower.embedding_source.kind}** — ${lower.embedding_source.synthetic} synthetic` +
      `${lower.embedding_source.generator === undefined ? '' : ` (\`${lower.embedding_source.model}\`, generator \`${lower.embedding_source.generator}\`)`}` +
      `, ${lower.embedding_source.provider} from a provider. Counted from the manifest rows, not declared.`,
  );
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
  lines.push('## What these floors can prove today');
  lines.push('');
  lines.push(
    `While the manifest is **${lower.embedding_source.kind}**, the vector arm carries lexical recall and nothing else. ` +
      `${lower.semantic_reach.blocked_probes} of the ${lower.semantic_reach.total_probes} probes behind R6's three all-or-nothing floors ` +
      'have a required answer this corpus offers no keyed path to: the query supplies evidence the answer\'s whole page ' +
      'cannot match, and what the answer does carry is shared with at least as many other groups as the metric has slots. ' +
      'A floor those probes miss is reported `deferred` by `evals/gates.ts` — neither met nor quietly excused — and the ' +
      'suite prints the whole block on every run.',
  );
  lines.push('');
  lines.push('| floor | probe | cutoff | query keys the answer cannot match | other groups carrying what it does |');
  lines.push('|---|---|---|---|---|');
  for (const row of lower.semantic_reach.rows) {
    lines.push(
      `| ${row.floorId} | \`${row.queryId}\` | ${row.cutoff} | ${row.uncovered.map((key) => `\`${key}\``).join(', ')} | ${row.dominators} |`,
    );
  }
  lines.push('');
  lines.push(
    '**Regenerating the manifest from a real provider revokes every deferral**, automatically and without an edit: ' +
      'the switch is the provider count above. Whatever the floors then read is what they read.',
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
