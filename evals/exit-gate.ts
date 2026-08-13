/**
 * U11's exit gate — the KTD13 model-tier check for the five consolidation ops.
 *
 * Gap Register #19 split KTD13's gate in two: U7 owns the harness, and the ops
 * that do not exist in Phase 1 are graded "at U11's exit gate ... with a
 * committed receipt per op naming the model id it was scored against". This is
 * that harness. It lands in the state the rest of U7's gates are in — built,
 * wired into `eval:canary`, and **deferred with a reason** — because grading
 * these five means live paid calls and that spend is not authorised.
 *
 * **The failure this file is written against is a gate that passes for having
 * graded nothing.** Four things stop it, and none of them is a comment:
 *
 *   1. `green` is derived from a score. There is no branch that reaches it from
 *      permission, from a pin, or from the absence of a violation.
 *   2. A score with no committed model-id pin cannot be green. KTD13's whole
 *      diagnostic property — "a floor miss indicts the architecture, not the
 *      model tier" — is a claim about *which model ran*, so a grade that did not
 *      name one grades nothing in particular.
 *   3. No live tenant is a refusal for every op, whatever the scores say. The
 *      canary tier's own rule, applied here for the same reason: these ops read
 *      real content, and a fixture tenant is where that is allowed to happen.
 *   4. The cost of running it is committed as a receipt computed from
 *      `src/ai/pricing.ts`, so "estimate before run" has a number attached
 *      rather than a promise.
 *
 * **Why the checks are not new canary checks.** R6 puts exactly two floors in
 * the canary tier and `evals/canary.ts` pins that set as a whole. The exit gate
 * is U11's, it grades five ops against the same 0.8 bar, and it reports through
 * `eval:canary` rather than being smuggled into R6's list — so a reader counting
 * R6's floors still finds R6's floors.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CANONICAL_PRICE_BOOK, costMicroUsd, type PriceBook } from '../src/ai/pricing.ts';
import { routeFor, type ModelOp, type NamedProfile } from '../src/ai/routing.ts';

/** The five U11 builds and therefore owes a receipt for (KTD13, Gap #19). */
export const EXIT_GATE_OPS = [
  'extract',
  'enrich',
  'contradiction',
  'salience',
  'synopsis',
] as const;

export type ExitGateOp = (typeof EXIT_GATE_OPS)[number];

export const COST_RECEIPT_PATH = 'evals/receipts/u11-exit-gate-cost.json';

export interface ExitGateCheck {
  readonly op: ExitGateOp;
  /** R6's canary bar. The same 0.8 for all five — see the note on each. */
  readonly floor: number;
  readonly metric: string;
  /** What the op would be scored against. Named so a reader can find it. */
  readonly gold: string;
  readonly note: string;
}

/**
 * The five checks.
 *
 * Every floor is 0.8 and none of them is a number invented here: R6 gives
 * model-extraction recall ≥ 0.8 in the canary tier and gives the rest no number,
 * so they inherit R6's bar exactly as the per-question-type ranking floors
 * inherit R6's aggregate. A different number per op would be indistinguishable
 * from a number chosen to fit whatever the ops turned out to do.
 */
export const EXIT_GATE_CHECKS: readonly ExitGateCheck[] = [
  {
    op: 'extract',
    floor: 0.8,
    metric: 'recall against the gold fact key, judged',
    gold: 'evals/fixtures/extraction.ts — every fact assigned to a rule family, plus the model_only rows',
    note:
      'R6 names this one explicitly and puts it in the canary tier because the blocking tier makes zero model ' +
      'calls. It is the floor to watch: extraction feeds every later phase, so its miss invalidates downstream ' +
      'scores rather than only its own.',
  },
  {
    op: 'enrich',
    floor: 0.8,
    metric: 'card-claim precision against the gold entity key',
    gold: 'evals/fixtures/brain.ts — the entities and the facts that evidence them',
    note:
      'Enrichment writes the card every later phase reads about an entity, so its failure mode is a fabricated ' +
      'judgement about a person that nothing downstream re-checks. Precision rather than recall for that reason.',
  },
  {
    op: 'contradiction',
    floor: 0.8,
    metric: 'precision on the seeded conflict pairs, with edits scored as negatives',
    gold: 'evals/corpus.ts — the committed contradiction pairs, against the supersession chains as negatives',
    note:
      'R8 makes this count the paid-upgrade prompt, so its failure mode is fabrication rather than quality. The ' +
      'supersession chains are in the negative set on purpose: a change over time reported as a conflict is the ' +
      'exact fabrication Gap #18 describes.',
  },
  {
    op: 'salience',
    floor: 0.8,
    metric: 'rank correlation against the gold ordering, normalised to [0,1]',
    gold: 'evals/fixtures/brain.ts — the pages ordered by the gold key’s answer density',
    note:
      'Scoring against a rubric, so instruction-following is the whole job. It also decides what truncation keeps, ' +
      'which is why a miss here degrades every later cycle rather than one report.',
  },
  {
    op: 'synopsis',
    floor: 0.8,
    metric: 'faithfulness — claims in the summary that the page supports',
    gold: 'evals/corpus.ts — each page’s own chunks as the supporting set',
    note:
      'The summary is the compiled-truth surface, so an unfaithful one is a fabrication with a ranking boost ' +
      'pointed at it. Faithfulness rather than coverage for that reason.',
  },
];

export type ExitGateStatus = 'green' | 'red' | 'deferred';

export interface ExitGateOutcome {
  readonly op: ExitGateOp;
  readonly status: ExitGateStatus;
  readonly reason: string;
  readonly floor: number;
  readonly modelId: string;
  readonly score: number | null;
}

export type ExitGateViolationKind = 'no_live_tenant' | 'not_authorised' | 'unscored' | 'unpinned' | 'below_floor';

export interface ExitGateViolation {
  readonly kind: ExitGateViolationKind;
  readonly detail: string;
}

export interface ExitGatePlan {
  readonly outcomes: readonly ExitGateOutcome[];
  readonly deferred: readonly ExitGateOutcome[];
  readonly violations: readonly ExitGateViolation[];
  readonly passed: boolean;
}

export interface ExitGateInput {
  readonly profile: NamedProfile;
  /** The live tenant these ops would run against. `null` when none resolved. */
  readonly tenant: string | null;
  /** Ops with a committed model-id pin, from `evals/receipts/model-ids.json`. */
  readonly pinnedOps: ReadonlySet<ModelOp>;
  /**
   * Whether a live, paid run has been authorised.
   *
   * Explicit rather than inferred from an environment variable being present:
   * "somebody exported a key" is not "somebody agreed to the bill", and the
   * plan's own discipline is estimate-before-run.
   */
  readonly liveCallsAuthorised: boolean;
  /** Scores from a run that actually happened. Empty until one does. */
  readonly scores: ReadonlyMap<ExitGateOp, number>;
  readonly checks?: readonly ExitGateCheck[];
}

/**
 * Classify each op.
 *
 * The order of the tests is the order of the reasons, and it is chosen so the
 * most honest answer wins: unauthorised before unscored, unscored before
 * unpinned, and a score only ever compared against the floor once everything
 * else has already been established.
 */
export function planExitGate(input: ExitGateInput): ExitGatePlan {
  const checks = input.checks ?? EXIT_GATE_CHECKS;
  const violations: ExitGateViolation[] = [];

  const noTenant = input.tenant === null || input.tenant.trim().length === 0;
  if (noTenant) {
    violations.push({
      kind: 'no_live_tenant',
      detail:
        'the exit gate runs these ops against a live tenant on the real substrate; until U16 provisions the ' +
        'public canary, point it at the dedicated internal fixture tenant',
    });
  }

  const outcomes: ExitGateOutcome[] = checks.map((check) => {
    const modelId = routeFor(input.profile, check.op).id;
    const base = { op: check.op, floor: check.floor, modelId };

    if (!input.liveCallsAuthorised) {
      return {
        ...base,
        status: 'deferred' as const,
        score: null,
        reason:
          'live paid calls are not authorised, so this op has not been scored — the plan\'s discipline is ' +
          `estimate before run, and the estimate is committed at ${COST_RECEIPT_PATH}`,
      };
    }

    const score = input.scores.get(check.op);
    if (score === undefined || !Number.isFinite(score)) {
      violations.push({ kind: 'unscored', detail: `${check.op}: authorised but no score was produced` });
      return { ...base, status: 'red' as const, score: null, reason: 'authorised, but no score was produced' };
    }

    if (!input.pinnedOps.has(check.op)) {
      violations.push({
        kind: 'unpinned',
        detail: `${check.op}: scored ${score.toFixed(4)} against ${modelId}, which no committed receipt pins`,
      });
      return {
        ...base,
        status: 'red' as const,
        score,
        reason:
          `scored against ${modelId}, which no committed receipt pins — a grade that cannot name the model it ` +
          'graded proves nothing about the model tier',
      };
    }

    if (score < check.floor) {
      violations.push({
        kind: 'below_floor',
        detail: `${check.op}: ${score.toFixed(4)} against a floor of ${check.floor}`,
      });
      return {
        ...base,
        status: 'red' as const,
        score,
        reason: `${score.toFixed(4)} is below R6's canary floor of ${check.floor}`,
      };
    }

    return {
      ...base,
      status: 'green' as const,
      score,
      reason: `${score.toFixed(4)} clears ${check.floor} against ${modelId}`,
    };
  });

  const deferred = outcomes.filter((outcome) => outcome.status === 'deferred');
  if (deferred.length > 0) {
    violations.push({
      kind: 'not_authorised',
      detail:
        `${deferred.length} of ${outcomes.length} consolidation ops are deferred pending an authorised live run; ` +
        'nothing here reports a pass it did not measure',
    });
  }

  return {
    outcomes,
    deferred,
    violations,
    passed: violations.length === 0 && outcomes.every((outcome) => outcome.status === 'green'),
  };
}

export function renderExitGate(plan: ExitGatePlan): string {
  const lines = [
    `U11 exit gate — ${plan.outcomes.filter((o) => o.status === 'green').length} met, ` +
      `${plan.outcomes.filter((o) => o.status === 'red').length} missed, ${plan.deferred.length} deferred`,
  ];
  for (const outcome of plan.outcomes) {
    lines.push(`  [${outcome.status}] ${outcome.op} (${outcome.modelId}): ${outcome.reason}`);
  }
  for (const violation of plan.violations) lines.push(`  [${violation.kind}] ${violation.detail}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// What a run would cost.
// ---------------------------------------------------------------------------

export interface OpWorkload {
  readonly items: number;
  readonly inputTokensPerItem: number;
}

/**
 * The sample a scoring run would send, per op.
 *
 * Sized from the committed fixture corpus rather than chosen: `extract` and
 * `synopsis` are per-chunk and per-page over that corpus, `enrich` is per
 * entity, `contradiction` is one batched call over the live fact set, and
 * `salience` is one batched call over the pages. A number nobody derived would
 * make the receipt an opinion about cost rather than a computation of it.
 */
export const EXIT_GATE_WORKLOAD: Readonly<Record<ExitGateOp, OpWorkload>> = Object.freeze({
  extract: { items: 60, inputTokensPerItem: 500 },
  enrich: { items: 24, inputTokensPerItem: 1_000 },
  contradiction: { items: 1, inputTokensPerItem: 12_000 },
  salience: { items: 1, inputTokensPerItem: 24_000 },
  synopsis: { items: 24, inputTokensPerItem: 500 },
});

/**
 * The grading call, which is a cost line and not a footnote.
 *
 * Four of the five metrics above are model-judged, so a run that priced only the
 * producers would be pricing half of it. The judge reads each op's output
 * alongside its gold set, which is why its input is the largest single figure in
 * the receipt — and why it routes through the `judge` op, never the family being
 * graded (KTD13).
 */
export const JUDGE_WORKLOAD: OpWorkload = Object.freeze({ items: 5, inputTokensPerItem: 20_000 });

export interface CostRow {
  readonly op: ExitGateOp | 'judge';
  readonly modelId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly microUsd: number;
}

export interface ExitGateCost {
  readonly rows: readonly CostRow[];
  readonly totalMicroUsd: number;
  readonly profile: string;
}

/**
 * What one full exit-gate run costs, from the canonical table and nothing else.
 *
 * Output is projected at the route's own ceiling, the same conservative
 * direction the gateway's pre-call estimate takes: an estimate that assumed a
 * short answer would be an estimate somebody could exceed while believing they
 * were inside it.
 */
export function estimateExitGateCost(profile: NamedProfile, priceBook: PriceBook = CANONICAL_PRICE_BOOK): ExitGateCost {
  const rows: CostRow[] = [];
  let total = 0;

  const priced: ReadonlyArray<readonly [ExitGateOp | 'judge', OpWorkload]> = [
    ...EXIT_GATE_OPS.map((op) => [op, EXIT_GATE_WORKLOAD[op]] as const),
    ['judge', JUDGE_WORKLOAD] as const,
  ];

  for (const [op, work] of priced) {
    const route = routeFor(profile, op);
    const price = priceBook.lookup(route.id);
    if (price === undefined) {
      throw new Error(
        `op '${op}' routes to '${route.id}', which the canonical pricing table does not price; ` +
          'an unpriced op cannot be estimated and must not be run under a cap (R14)',
      );
    }
    const inputTokens = work.items * work.inputTokensPerItem;
    const outputTokens = work.items * route.maxOutputTokens;
    const microUsd = costMicroUsd({ inputTokens, outputTokens }, price);
    rows.push({ op, modelId: route.id, inputTokens, outputTokens, microUsd });
    total += microUsd;
  }

  return { rows, totalMicroUsd: total, profile: profile.name };
}

/** The committed estimate, for the command and for the drift guard. */
export function readCostReceipt(): unknown {
  const root = new URL('..', import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(new URL(COST_RECEIPT_PATH, root)), 'utf8'));
}
