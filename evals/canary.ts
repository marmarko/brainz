/**
 * `bun run eval:canary` — the nightly, model-judged tier (U7 approach step 4).
 *
 * > Sampled model-judged tier — extraction recall (R6's canary-tier floor),
 * > briefing coherence — runs nightly, routed as the `judge` op so the judge is
 * > never the model that produced the output being judged (KTD13); a judge
 * > grading its own family measures agreement, not quality. It needs a live
 * > tenant on the real substrate.
 *
 * **This unit ships the harness, not the grades.** `extract` is a U11
 * deliverable and briefing assembly is U12's, so a Phase-1 canary that returned
 * scores would be scoring ops that do not exist — the unsatisfiable-gate problem
 * Gap #19 split across U7 and U11. What lands here is everything that must be
 * true *before* a grade means anything: a live tenant, an independent judge, a
 * gold key with no silent holes, and a classification of every check as
 * gradeable or deferred-with-an-owner.
 *
 * **Independence is checked by serving org, not by model id.** The failure being
 * prevented is *agreement*, and agreement is a property of the family: a sibling
 * snapshot from the same vendor is not an independent grader, and swapping the
 * date suffix would defeat an id-equality check while changing nothing about the
 * shared training lineage. So the comparison is `@cf/<org>/…` → `<org>`,
 * `self-host/<org>/…` → `<org>`, and a proprietary id → its provider, where the
 * vendor *is* the family.
 *
 * **The deferral is derived, so it cannot rot.** A check is gradeable exactly
 * when its producing op is pinned by a committed receipt in
 * `evals/receipts/model-ids.json` — the only artifact in the repo that is
 * evidence an op has been run and scored at all. Nothing has to be remembered or
 * deleted when U11 lands: the pin appears and the check becomes gradeable. A
 * check still listed as deferred once its op is pinned is a violation, the way
 * `evals/gates.ts` treats a deferred floor that would pass.
 *
 * **It refuses rather than reporting a tier it could not run.** No tenant, or
 * nothing gradeable, exits non-zero. The nightly workflow decides whether to
 * invoke it and marks itself non-blocking; the command never returns a green
 * tick for having graded nothing.
 */

import { routeFor, type ModelOp, type NamedProfile, type Route } from '../src/ai/routing.ts';

export interface CanaryCheck {
  readonly id: string;
  /** The op whose output is graded. The judge must not share its family. */
  readonly producedBy: ModelOp;
  /** R6's canary-tier bar. */
  readonly floor: number;
  readonly unit: string;
  readonly awaiting: string;
  readonly note: string;
}

/**
 * The canary tier's checks, as data.
 *
 * Both are R6's: "model-extraction recall ≥ 0.8, alerting on breach and gating
 * the beta release" plus briefing coherence, which R6 names without a number —
 * so it inherits the same 0.8 bar rather than acquiring a number this unit
 * invented, exactly as the per-question-type floors inherit R6's aggregate.
 */
export const CANARY_CHECKS: readonly CanaryCheck[] = [
  {
    id: 'extraction-recall',
    producedBy: 'extract',
    floor: 0.8,
    unit: 'U11',
    awaiting: "a committed pin for the `extract` op — U11's exit gate",
    note:
      'R6 puts model-extraction recall in the canary tier rather than the blocking one because the blocking tier ' +
      'makes zero model calls. Extraction is the floor to watch: it feeds every later phase, so its miss is the ' +
      'only one that invalidates downstream scores rather than just its own.',
  },
  {
    id: 'briefing-coherence',
    producedBy: 'synopsis',
    floor: 0.8,
    unit: 'U12',
    awaiting: 'a committed pin for the `synopsis` op — U12 assembles the briefing that would be judged',
    note:
      'R6 names briefing coherence without a number, so it inherits R6\'s bar rather than a number invented here. ' +
      'Until U12 assembles a briefing there is no artifact to grade.',
  },
];

export type CanaryViolationKind =
  | 'no_live_tenant'
  | 'nothing_gradeable'
  | 'judge_not_independent'
  | 'stale_deferral'
  | 'unjudged_item'
  | 'unknown_item'
  | 'duplicate_judgement'
  | 'empty_gold_key'
  | 'below_floor';

export interface CanaryViolation {
  readonly kind: CanaryViolationKind;
  readonly detail: string;
}

/**
 * Who serves the weights, for the independence comparison.
 *
 * `@cf/zai-org/glm-5.2` is Cloudflare *hosting* a Z.ai model; the family is
 * `zai-org`, not `cloudflare`. Returning the provider there would make every
 * Cloudflare-hosted op look like one family and every Google op like another,
 * which is backwards.
 */
export function servingOrgOf(route: Route): string {
  for (const prefix of ['@cf/', 'self-host/']) {
    if (route.id.startsWith(prefix)) {
      const org = route.id.slice(prefix.length).split('/')[0];
      if (org !== undefined && org.length > 0) return org;
    }
  }
  return route.provider;
}

export interface IndependenceVerdict {
  readonly independent: boolean;
  readonly reason: string;
}

export function judgeIndependence(profile: NamedProfile, producedBy: ModelOp): IndependenceVerdict {
  if (producedBy === 'judge') {
    return {
      independent: false,
      reason: 'the judge op cannot grade its own output; that measures self-consistency, not quality',
    };
  }

  const judge = routeFor(profile, 'judge');
  const produced = routeFor(profile, producedBy);

  if (judge.id === produced.id) {
    return {
      independent: false,
      reason: `judge and ${producedBy} route to the same model (${judge.id}); a judge grading itself measures agreement`,
    };
  }

  const judgeOrg = servingOrgOf(judge);
  const producedOrg = servingOrgOf(produced);
  if (judgeOrg === producedOrg) {
    return {
      independent: false,
      reason:
        `judge (${judge.id}) and ${producedBy} (${produced.id}) are both ${judgeOrg} models; ` +
        'a sibling snapshot shares the lineage that produces agreement, so it is not an independent grader',
    };
  }

  return { independent: true, reason: `judge is ${judgeOrg}; ${producedBy} is ${producedOrg}` };
}

export interface CanaryPlan {
  readonly passed: boolean;
  readonly violations: readonly CanaryViolation[];
  readonly gradeable: readonly CanaryCheck[];
  readonly deferred: readonly CanaryCheck[];
}

/**
 * Decide what this run can honestly grade, and refuse if the answer is nothing.
 *
 * `pinnedOps` comes from `evals/receipts/model-ids.json` rather than from a
 * hand-maintained list in this file. That is the whole anti-rot mechanism: the
 * set is evidence, not a claim, and it changes when the receipts change.
 */
export function planCanary(input: {
  readonly profile: NamedProfile;
  /** The live tenant this tier runs against. `null` when none was resolved. */
  readonly tenant: string | null;
  readonly pinnedOps: ReadonlySet<ModelOp>;
  readonly checks?: readonly CanaryCheck[];
}): CanaryPlan {
  const checks = input.checks ?? CANARY_CHECKS;
  const violations: CanaryViolation[] = [];

  if (input.tenant === null || input.tenant.trim().length === 0) {
    violations.push({
      kind: 'no_live_tenant',
      detail:
        'the canary tier needs a live tenant on the real substrate; until U16 provisions the public canary, ' +
        'point it at the dedicated internal fixture tenant',
    });
  }

  const gradeable: CanaryCheck[] = [];
  const deferred: CanaryCheck[] = [];
  for (const check of checks) {
    if (input.pinnedOps.has(check.producedBy)) gradeable.push(check);
    else deferred.push(check);
  }

  if (gradeable.length === 0) {
    violations.push({
      kind: 'nothing_gradeable',
      detail:
        `none of the ${checks.length} canary checks has a producing op with a committed model-id pin, so this run ` +
        `would grade nothing: ${deferred.map((check) => `${check.id} awaits ${check.unit}`).join('; ')}`,
    });
  }

  // Per gradeable check, not once globally: the shipped table puts `extract`
  // with one vendor and `synopsis` with another, so a judge can be independent
  // of one and compromised against the other.
  for (const check of gradeable) {
    const verdict = judgeIndependence(input.profile, check.producedBy);
    if (!verdict.independent) {
      violations.push({
        kind: 'judge_not_independent',
        detail: `${check.id}: ${verdict.reason}`,
      });
    }
  }

  return { passed: violations.length === 0, violations, gradeable, deferred };
}

export interface Judgement {
  readonly id: string;
  readonly recalled: boolean;
}

export interface RecallScore {
  /** `NaN` when the gold key is empty. Deliberately not 0 and deliberately not 1. */
  readonly recall: number;
  readonly violations: readonly CanaryViolation[];
}

/**
 * Score a judged run against the gold key.
 *
 * Every hole is a violation rather than a smaller denominator. A gold item with
 * no judgement, quietly dropped, moves recall in the flattering direction — the
 * same fail-open shape `evals/extraction.ts` refuses when a fact has no rule
 * assignment, and the same one `evals/run.ts` refuses when a query has no gold.
 */
export function scoreRecall(input: {
  readonly gold: readonly string[];
  readonly judgements: readonly Judgement[];
  readonly floor: number;
}): RecallScore {
  const violations: CanaryViolation[] = [];

  if (input.gold.length === 0) {
    return {
      recall: Number.NaN,
      violations: [
        { kind: 'empty_gold_key', detail: 'recall over an empty gold key is 0/0; there is nothing to score' },
      ],
    };
  }

  const goldSet = new Set(input.gold);
  const seen = new Map<string, boolean>();

  for (const judgement of input.judgements) {
    if (!goldSet.has(judgement.id)) {
      violations.push({
        kind: 'unknown_item',
        detail: `${judgement.id} was judged but is not in the gold key; the judge graded something nobody asked about`,
      });
      continue;
    }
    if (seen.has(judgement.id)) {
      violations.push({
        kind: 'duplicate_judgement',
        detail: `${judgement.id} was judged twice; a second verdict is a disagreement, not a second vote`,
      });
      continue;
    }
    seen.set(judgement.id, judgement.recalled);
  }

  let recalled = 0;
  for (const id of input.gold) {
    const verdict = seen.get(id);
    if (verdict === undefined) {
      violations.push({
        kind: 'unjudged_item',
        detail: `${id} is in the gold key and was never judged; dropping it would flatter the score`,
      });
      continue;
    }
    if (verdict) recalled += 1;
  }

  const recall = recalled / input.gold.length;
  if (Number.isFinite(recall) && recall < input.floor) {
    violations.push({
      kind: 'below_floor',
      detail: `recall is ${recall.toFixed(4)}, below the canary floor of ${input.floor}`,
    });
  }

  return { recall, violations };
}

export function renderCanary(plan: CanaryPlan): string {
  const lines = [`canary tier — ${plan.gradeable.length} gradeable, ${plan.deferred.length} deferred`];
  for (const check of plan.gradeable) lines.push(`  gradeable  ${check.id} (floor ${check.floor})`);
  for (const check of plan.deferred) {
    lines.push(`  deferred   ${check.id} — awaits ${check.unit}: ${check.awaiting}`);
  }
  for (const violation of plan.violations) lines.push(`  [${violation.kind}] ${violation.detail}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The command.
// ---------------------------------------------------------------------------

/**
 * `bun run eval:canary`.
 *
 * `--preflight` answers the one question a nightly workflow needs before it
 * decides whether to run anything: how many checks are gradeable. It prints the
 * count and exits 0 regardless, because it is a question rather than a gate. The
 * tier itself always fails closed — no tenant, or nothing gradeable, is a
 * non-zero exit — and the workflow marks its job non-blocking rather than the
 * command marking itself green.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  const { PROFILES } = await import('../src/ai/routing.ts');
  const { loadPinLedger } = await import('./model-pins.ts');

  // Derived, not declared: an op is gradeable once a committed receipt pins it,
  // which is the only evidence in the repo that it has been run and scored.
  const ledger = loadPinLedger();
  const pinnedOps = new Set<ModelOp>(
    Object.values(ledger.ledger.profiles).flatMap((profile) => (profile?.pins ?? []).map((pin) => pin.op)),
  );

  const tenant = process.env['BRAINZ_CANARY_TENANT'] ?? null;
  const plan = planCanary({ profile: PROFILES.hosted, tenant, pinnedOps });

  if (argv.includes('--preflight')) {
    out(`gradeable=${plan.gradeable.length}`);
    out(`deferred=${plan.deferred.length}`);
    out(`tenant=${tenant === null ? '' : tenant}`);
    return 0;
  }

  if (!process.env['BRAINZ_REAL_SUBSTRATE']) {
    out('eval:canary: NOT RUN — BRAINZ_REAL_SUBSTRATE is not set.');
    out('  The judged tier calls real models against a live tenant. It is nightly and');
    out('  secret-gated; the blocking tier is what runs on a pull request.');
    return 1;
  }

  out(renderCanary(plan));
  if (argv.includes('--json')) out(JSON.stringify(plan, null, 2));

  // Nothing below this line runs today: `plan.passed` is false while every
  // check is deferred. The scoring path lands with the first gradeable check,
  // and `scoreRecall` is already the shape it will be called in.
  return plan.passed ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
