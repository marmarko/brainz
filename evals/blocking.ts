/**
 * `bun run eval:blocking` — R6's floors, deterministic, zero model calls, in CI.
 *
 * **This is the gate `evals/gates.ts` was built for.** The floors, the margins
 * and the three-state classifier already exist and are already pinned by
 * `test/core/search/floors.test.ts`. What was missing was the *command*: the
 * Verification Contract's `bun run eval:blocking` row, which had been a
 * deliberately-failing placeholder since U1 because an unimplemented gate must
 * never look green.
 *
 * **Three claims are made about this tier, and all three are checked here rather
 * than asserted in prose.**
 *
 *   - *Deterministic.* The tier runs twice and compares a digest over every
 *     bucket and every per-query outcome. A gate whose number moves on its own
 *     gets marked flaky and then non-blocking, which is how a measurement
 *     apparatus quietly stops being one.
 *   - *Zero model calls.* The determinism comes from committed embeddings, so a
 *     live call would break the first claim as well as costing money. `fetch`
 *     is the channel every `src/ai/` transport uses (`FetchLike`), so it is
 *     trapped for the duration of the run and any attempt is a violation. This
 *     is the enforceable reading of "no network egress during the run".
 *   - *Specific.* Every floor is classified, per family and per question type;
 *     `evals/gates.ts` refuses to pass one it did not measure, and the command
 *     prints the deferral block on every run so a floor that is not being
 *     measured says so where a reader of a green run will see it.
 *
 * **`classifyFloors`, not `checkFloors`.** The three-state classifier is the one
 * that reports a floor the fixture cannot yet measure as `deferred` rather than
 * failing it — and it is *stricter*, not laxer, in the direction that matters: a
 * deferred floor that would pass is a `stale_deferral` violation. Using the
 * two-state checker would make this command red today on two floors whose
 * misses `evals/lexical-reach.ts` derives, from the corpus, to be unreachable
 * with synthetic vectors. Wiring a gate that is red on every PR is how a gate
 * gets ignored.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  renderBriefingLeg,
  runBriefingLeg,
  type BriefingCase,
  type BriefingLegResult,
} from './briefing.ts';
import { CORPUS, corpusTexts, type Corpus } from './corpus.ts';
import { loadEmbeddings, type EmbeddingIndex } from './embeddings.ts';
import {
  RANKING_FLOORS,
  classifyFloors,
  renderDeferrals,
  type ClassifiedGate,
  type RankingFloor,
} from './gates.ts';
import { MANIFEST_PATH } from './regenerate-embeddings.ts';
import { RERANK_MANIFEST_PATH, scoreCorpus } from './regenerate-rerank-scores.ts';
import { loadRerankScores, type RerankScoreIndex } from './rerank-scores.ts';
import { runEval, type EvalReport, type Ranker } from './run.ts';

export type TierViolationKind =
  | 'floor'
  | 'leak'
  | 'nondeterministic'
  | 'network_egress'
  | 'empty_query_set';

export interface TierViolation {
  readonly kind: TierViolationKind;
  readonly detail: string;
}

export interface TierContext {
  readonly corpus: Corpus;
  readonly embeddings: EmbeddingIndex;
}

export interface BlockingTierResult {
  readonly ranker: string;
  readonly report: EvalReport;
  readonly gate: ClassifiedGate;
  readonly violations: readonly TierViolation[];
  readonly passed: boolean;
  /** Every network target the run reached for. Empty is the only passing value. */
  readonly egress: readonly string[];
  readonly digest: string;
}

/**
 * Load the committed corpus and the committed manifest. No network, no database.
 *
 * Synchronous on purpose, so the tier is callable from a test's module scope the
 * same way `test/core/search/floors.test.ts` already loads it, and so nothing in
 * the gate's own path is a promise that could resolve out of order between runs.
 * `loadEmbeddings` verifies every vector's digest before it is reachable, so a
 * tampered manifest fails here rather than scoring.
 */
export function loadTierContext(): TierContext {
  const manifest = readFileSync(fileURLToPath(new URL(`../${MANIFEST_PATH}`, import.meta.url)), 'utf8');
  return { corpus: CORPUS, embeddings: loadEmbeddings(manifest, corpusTexts(CORPUS)) };
}

/**
 * The committed cross-encoder scores, verified before any of them is reachable.
 *
 * Separate from {@link loadTierContext} because the rerank leg is separate: a
 * tier that could not load the scores must still grade the baseline leg, and a
 * failure here is a failure of one leg rather than of the command.
 */
export function loadRerankScoreIndex(): RerankScoreIndex {
  const manifest = readFileSync(
    fileURLToPath(new URL(`../${RERANK_MANIFEST_PATH}`, import.meta.url)),
    'utf8',
  );
  return loadRerankScores(manifest, scoreCorpus());
}

/**
 * Digest over everything a floor can read.
 *
 * Deliberately includes `perQuery`: two runs whose means agree while individual
 * probes moved in compensating directions are not the same run, and the
 * difference is exactly what a per-question-type floor exists to notice. The
 * manifest digest is folded in so a report can never be compared against one
 * produced from different vectors.
 */
export function reportDigest(report: EvalReport): string {
  const canonical = JSON.stringify({
    ranker: report.ranker,
    queryCount: report.queryCount,
    manifest: report.embeddingManifestDigest,
    aggregate: report.aggregate,
    byType: report.byType,
    byFamily: report.byFamily,
    violations: report.violations,
    perQuery: report.perQuery,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Run `fn` with `fetch` trapped, returning whatever it reached for.
 *
 * The trap **rejects** rather than returning a stub response: a caller that
 * silently degrades on a failed model call would otherwise turn an accidental
 * live dependency into a quiet score change. The attempt is recorded either
 * way, so a caller that swallows the rejection still leaves evidence.
 *
 * `fetch` is restored in a `finally`. A trap that leaks into the rest of the
 * process is a worse bug than the one it catches.
 */
export function withoutNetwork<T>(fn: () => T): { readonly value: T; readonly egress: readonly string[] } {
  const original = globalThis.fetch;
  const egress: string[] = [];
  const trap = ((input: unknown, ..._rest: unknown[]) => {
    const target =
      typeof input === 'string'
        ? input
        : input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : String(input);
    egress.push(target);
    return Promise.reject(
      new Error(`the blocking tier attempted network egress to ${target}; this tier makes zero model calls`),
    );
  }) as unknown as typeof globalThis.fetch;

  globalThis.fetch = trap;
  try {
    return { value: fn(), egress };
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * Turn one graded run into the tier's verdict.
 *
 * **Separated from {@link runBlockingTier} for the reason `violationsOf` is
 * separated from `classifyFloors` in `evals/gates.ts`.** Three of the four
 * checks below are unreachable through the public path on a healthy fixture —
 * the committed corpus is never empty, and a clean run never records egress —
 * so a test driving them has nowhere to stand. That is not an argument for
 * dropping them: an empty query set and a live model call are precisely the
 * states in which this gate would otherwise report a confident green having
 * measured nothing. It is an argument for a seam.
 */
export function foldViolations(input: {
  readonly report: EvalReport;
  readonly gate: ClassifiedGate;
  readonly egress: readonly string[];
  readonly digest: string;
  readonly secondDigest: string;
}): TierViolation[] {
  const violations: TierViolation[] = [];

  if (input.report.queryCount === 0) {
    violations.push({
      kind: 'empty_query_set',
      detail: 'the tier graded zero queries; a mean over nothing is not a measurement',
    });
  }

  for (const target of input.egress) {
    violations.push({
      kind: 'network_egress',
      detail: `the run reached for ${target}; the blocking tier makes zero model calls`,
    });
  }

  if (input.digest !== input.secondDigest) {
    violations.push({
      kind: 'nondeterministic',
      detail:
        `two runs of the same ranker over the same corpus digested to ` +
        `${input.digest.slice(0, 12)} and ${input.secondDigest.slice(0, 12)}`,
    });
  }

  for (const violation of input.gate.violations) {
    violations.push({
      kind: violation.kind === 'leak' ? 'leak' : 'floor',
      detail: `${violation.floorId} [${violation.kind}]: ${violation.detail}`,
    });
  }

  return violations;
}

/**
 * Run the tier once, twice, and grade it.
 *
 * The second run is not a nicety: the *only* reason this tier can block CI is
 * that its number does not move, and a claim nothing checks is a claim that
 * stops being true without anybody noticing.
 */
export function runBlockingTier(options: {
  readonly ranker: Ranker;
  readonly context: TierContext;
  readonly floors?: readonly RankingFloor[];
}): BlockingTierResult {
  const { ranker, context } = options;
  const floors = options.floors ?? RANKING_FLOORS;

  const { value: runs, egress } = withoutNetwork(() => [
    runEval(ranker, context),
    runEval(ranker, context),
  ]);
  const [first, second] = runs;
  if (first === undefined || second === undefined) {
    throw new Error('the tier produced fewer than two runs; determinism was not compared');
  }

  const gate = classifyFloors(first, floors, context);
  const digest = reportDigest(first);
  const violations = foldViolations({
    report: first,
    gate,
    egress,
    digest,
    secondDigest: reportDigest(second),
  });

  return {
    ranker: ranker.name,
    report: first,
    gate,
    violations,
    passed: violations.length === 0,
    egress,
    digest,
  };
}

// ---------------------------------------------------------------------------
// The rerank leg (U12).
// ---------------------------------------------------------------------------

/**
 * Why the shipped configuration's floors are reported rather than enforced.
 *
 * Stated as a value so the condition is one expression that a test can drive
 * from both sides, rather than a branch that only ever runs one way.
 */
export const SYNTHETIC_SCORES_REASON =
  'every committed (query, candidate) cross-encoder score is synthetic, and the generator is a ' +
  'thirty-line lexical function standing in for a 278M-parameter model. Used as stage 12 uses it — ' +
  'as the sole sort key — it is weaker than the stack it reranks, so its floor scores measure the ' +
  'stand-in rather than the stage. One provider-sourced score anywhere and this leg enforces.';

export interface RerankLegResult {
  readonly result: BlockingTierResult;
  /** True once a provider-sourced score exists. Counted from the manifest. */
  readonly enforced: boolean;
  readonly reason: string;
  /**
   * The violations that bind whatever the scores are.
   *
   * Determinism, network egress and leaks are properties of the *stages*, not of
   * the numbers they read: a rerank that returned a fenced chunk, reached the
   * network, or scored differently on two identical runs is broken regardless of
   * how good the cross-encoder is. Only the floor violations are held back.
   */
  readonly binding: readonly TierViolation[];
}

/**
 * Run the shipped configuration — stages 12 and 13 on — over the same corpus.
 *
 * **Why this leg exists.** Without it the nDCG floor keeps measuring a pipeline
 * production no longer runs: the two highest-leverage read stages would be
 * verified once by this unit's A/B and never again. With it, every CI run
 * exercises the stages the fleet actually executes, in the order it executes
 * them, and any change to either is graded.
 *
 * **Why its floors are not enforced yet, and why that cannot rot.** See
 * {@link SYNTHETIC_SCORES_REASON}. The switch is `sources.provider`, counted row
 * by row from the manifest — the same mechanism `gates.ts` uses for a floor the
 * synthetic *vectors* cannot reach, one level up. Nothing has to be remembered
 * and nothing has to be removed.
 */
export function runRerankLeg(options: {
  readonly ranker: Ranker;
  readonly context: TierContext;
  readonly scores: RerankScoreIndex;
  readonly floors?: readonly RankingFloor[];
}): RerankLegResult {
  const result = runBlockingTier({
    ranker: options.ranker,
    context: options.context,
    ...(options.floors === undefined ? {} : { floors: options.floors }),
  });
  const enforced = options.scores.sources.provider > 0;
  const binding = enforced
    ? result.violations
    : result.violations.filter((violation) => violation.kind !== 'floor');

  return {
    result,
    enforced,
    reason: enforced
      ? 'a provider-sourced cross-encoder score exists, so the shipped configuration carries the floors'
      : SYNTHETIC_SCORES_REASON,
    binding,
  };
}

export function renderRerankLeg(leg: RerankLegResult): string {
  const lines: string[] = [];
  lines.push(
    `rerank leg — ranker: ${leg.result.ranker}, floors ${leg.enforced ? 'ENFORCED' : 'REPORTED (not enforced)'}`,
  );
  lines.push(`  ${leg.reason}`);
  lines.push('');
  for (const outcome of leg.result.gate.outcomes) {
    const mark = leg.enforced
      ? outcome.status === 'met'
        ? 'MET     '
        : outcome.status === 'deferred'
          ? 'DEFERRED'
          : 'MISSED  '
      : 'REPORTED';
    lines.push(
      `  ${mark} ${outcome.floorId.padEnd(32)} ${outcome.value.toFixed(4)} / ${outcome.minimum} over ${outcome.count} queries`,
    );
  }
  if (leg.binding.length > 0) {
    lines.push('');
    lines.push('BINDING VIOLATIONS (independent of score quality)');
    for (const violation of leg.binding) lines.push(`  [${violation.kind}] ${violation.detail}`);
  }
  return lines.join('\n');
}

/** Human output. The deferral block prints on every run, pass or fail. */
export function renderTier(result: BlockingTierResult): string {
  const lines: string[] = [];
  lines.push(`blocking tier — ranker: ${result.ranker}, ${result.report.queryCount} queries`);
  lines.push(`  manifest ${result.report.embeddingManifestDigest.slice(0, 12)} · run digest ${result.digest.slice(0, 12)}`);
  lines.push('');
  for (const outcome of result.gate.outcomes) {
    const mark = outcome.status === 'met' ? 'MET     ' : outcome.status === 'deferred' ? 'DEFERRED' : 'MISSED  ';
    lines.push(
      `  ${mark} ${outcome.floorId.padEnd(32)} ${outcome.value.toFixed(4)} / ${outcome.minimum} over ${outcome.count} queries`,
    );
  }
  lines.push('');
  lines.push(renderDeferrals(result.gate));
  if (!result.passed) {
    lines.push('');
    lines.push('VIOLATIONS');
    for (const violation of result.violations) lines.push(`  [${violation.kind}] ${violation.detail}`);
  }
  return lines.join('\n');
}

/**
 * `bun run eval:blocking`.
 *
 * The ranker is imported from `test/core/search/corpus-ranker.ts` rather than
 * rebuilt here, and that is deliberate: it is the one adapter that turns U5's
 * shipped stages into a `Ranker`, and its own header explains why a second
 * implementation would make the floors say nothing about what the fleet runs.
 * A gate scoring a copy of the stack is a gate scoring the copy.
 *
 * **`deps` exists so the non-zero exit is reachable from a test.** The number
 * this function returns is the whole reason the CI step is a gate rather than a
 * log line, and on the shipped stack every floor is met — so without a seam the
 * only exit code any test can observe is 0, and `return result.passed ? 0 : 1`
 * could be edited to `return 0` with the entire suite still green. A mutation
 * run proved exactly that. The seam is the smallest thing that makes the
 * failing branch observable; nothing in the command's own path passes it.
 */
export async function main(
  argv: readonly string[],
  deps?: {
    readonly ranker?: Ranker;
    readonly context?: TierContext;
    readonly scores?: RerankScoreIndex;
    /**
     * Injected for the same reason `ranker` is: on the shipped cases the
     * briefing leg is clean, so its contribution to the exit code has no
     * reachable failing branch and `&& briefing.passed` could be deleted with
     * the suite still green. A mutation run proved exactly that.
     */
    readonly briefingCases?: readonly BriefingCase[];
  },
): Promise<number> {
  const { stackRanker, rerankedStackRanker } = await import('../test/core/search/corpus-ranker.ts');
  const context = deps?.context ?? loadTierContext();
  const result = runBlockingTier({ ranker: deps?.ranker ?? stackRanker, context });

  // The shipped configuration, on the same corpus, every run. Its floors bind
  // only once a provider-sourced score exists; its determinism, egress and leak
  // checks bind always. See `runRerankLeg`.
  const scores = deps?.scores ?? loadRerankScoreIndex();
  const leg = runRerankLeg({ ranker: rerankedStackRanker(scores), context, scores });

  // U12's third leg: the briefing's assembly, over fixtures. Fully enforced —
  // participant-card completeness and delta correctness are properties of the
  // pure function and depend on no model, no database and no committed score.
  const briefing: BriefingLegResult = runBriefingLeg(deps?.briefingCases);

  const passed = result.passed && leg.binding.length === 0 && briefing.passed;

  if (argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ranker: result.ranker,
          digest: result.digest,
          passed,
          egress: result.egress,
          outcomes: result.gate.outcomes,
          violations: result.violations,
          rerank_leg: {
            ranker: leg.result.ranker,
            digest: leg.result.digest,
            enforced: leg.enforced,
            reason: leg.reason,
            score_sources: scores.sources,
            outcomes: leg.result.gate.outcomes,
            binding_violations: leg.binding,
          },
          briefing_leg: {
            cases: briefing.cases,
            passed: briefing.passed,
            violations: briefing.violations,
          },
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(
      `${renderTier(result)}\n\n${renderRerankLeg(leg)}\n\n${renderBriefingLeg(briefing)}\n`,
    );
  }

  return passed ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
