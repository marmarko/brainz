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
 */
export async function main(argv: readonly string[]): Promise<number> {
  const { stackRanker } = await import('../test/core/search/corpus-ranker.ts');
  const result = runBlockingTier({ ranker: stackRanker, context: loadTierContext() });

  if (argv.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ranker: result.ranker,
          digest: result.digest,
          passed: result.passed,
          egress: result.egress,
          outcomes: result.gate.outcomes,
          violations: result.violations,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(`${renderTier(result)}\n`);
  }

  return result.passed ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
