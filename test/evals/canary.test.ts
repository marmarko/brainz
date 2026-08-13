/**
 * `bun run eval:canary` — the nightly model-judged tier (U7 approach step 4).
 *
 * **What this unit owns and what it deliberately does not.** R6's canary floor
 * is model-extraction recall ≥ 0.8, and `extract` is a U11 deliverable;
 * briefing coherence needs U12's assembly. So a Phase-1 canary that *graded*
 * anything would be grading ops that do not exist. U7 owns the **harness**: the
 * live-tenant requirement, the judge routing, the scoring shape, and the
 * classification of every check as gradeable-or-deferred-with-an-owner. Gap #19
 * split the KTD13 gate across U7 and U11 for exactly this reason.
 *
 * **The judge is never the family being judged.** KTD13 is explicit: "routed as
 * the `judge` op so the judge is never the model that produced the output being
 * judged; a judge grading its own family measures agreement, not quality."
 * Agreement is the thing a self-judge is *best* at, so this is not a small
 * correction — a judge scoring its own family produces a high number that means
 * nothing, and there is no downstream check that would notice.
 *
 * **The deferral cannot rot**, and it is derived rather than declared: a check
 * is gradeable exactly when its producing op is pinned by a committed receipt in
 * `evals/receipts/model-ids.json`, which is the only evidence in the repo that
 * the op has ever been run and scored. A check still marked deferred once its op
 * is pinned is a `stale_deferral` violation — the same rule `evals/gates.ts`
 * applies to a deferred floor.
 */

import { describe, expect, test } from 'bun:test';

import {
  CANARY_CHECKS,
  judgeIndependence,
  planCanary,
  scoreRecall,
  servingOrgOf,
  type CanaryViolation,
} from '../../evals/canary.ts';
import { loadPinLedger } from '../../evals/model-pins.ts';
import { PROFILES, type ModelOp, type Route } from '../../src/ai/routing.ts';

const kinds = (violations: readonly CanaryViolation[]): string[] => violations.map((v) => v.kind);

const route = (over: Partial<Route>): Route => ({
  op: 'judge',
  alias: 'a',
  id: 'a',
  provider: 'cloudflare',
  pinnedOn: '2026-08-12',
  maxOutputTokens: 1,
  ...over,
});

describe('servingOrgOf', () => {
  test('a Cloudflare-hosted open-weights id names its vendor org, not Cloudflare', () => {
    expect(servingOrgOf(route({ id: '@cf/zai-org/glm-5.2', provider: 'cloudflare' }))).toBe('zai-org');
    expect(servingOrgOf(route({ id: '@cf/nvidia/nemotron-3-120b-a12b', provider: 'cloudflare' }))).toBe('nvidia');
  });

  test('a self-hosted id names the same org as the weights it serves', () => {
    expect(servingOrgOf(route({ id: 'self-host/zai-org/glm-5.2', provider: 'self-host' }))).toBe('zai-org');
  });

  test('a proprietary id falls back to its provider — the vendor IS the family there', () => {
    expect(servingOrgOf(route({ id: 'gemini-3.5-flash-lite-2026-07-21', provider: 'google' }))).toBe('google');
    expect(servingOrgOf(route({ id: 'text-embedding-3-large', provider: 'openai' }))).toBe('openai');
  });
});

describe('judgeIndependence', () => {
  test('the shipped table keeps the judge independent of every op it could grade', () => {
    for (const op of ['extract', 'enrich', 'contradiction', 'salience', 'synopsis', 'vision'] as ModelOp[]) {
      const verdict = judgeIndependence(PROFILES.hosted, op);
      expect(verdict.independent).toBe(true);
    }
  });

  test('a judge routed to the same model as the produced op is refused', () => {
    const profile = {
      name: 'rigged',
      routes: {
        ...PROFILES.hosted.routes,
        judge: PROFILES.hosted.routes.extract,
      },
    };
    const verdict = judgeIndependence(profile, 'extract');
    expect(verdict.independent).toBe(false);
    expect(verdict.reason).toContain('same model');
  });

  test('a judge from the same vendor family as the produced op is refused, even with a different id', () => {
    // The failure mode is agreement, and agreement is a property of the family,
    // not of the exact snapshot. A sibling model is not an independent grader.
    const profile = {
      name: 'rigged',
      routes: {
        ...PROFILES.hosted.routes,
        judge: route({ op: 'judge', id: 'gemini-3.5-pro-2026-07-21', provider: 'google' }),
      },
    };
    const verdict = judgeIndependence(profile, 'extract');
    expect(verdict.independent).toBe(false);
    expect(verdict.reason).toContain('google');
  });

  test('a judge asked to grade its own output is refused outright', () => {
    const verdict = judgeIndependence(PROFILES.hosted, 'judge');
    expect(verdict.independent).toBe(false);
    expect(verdict.reason).toContain('own');
  });
});

describe('planCanary refuses to report a tier it could not run', () => {
  const pinned = new Set<ModelOp>();

  test('no live tenant is a refusal — this tier needs the real substrate by definition', () => {
    const plan = planCanary({ profile: PROFILES.hosted, tenant: null, pinnedOps: pinned });
    expect(plan.passed).toBe(false);
    expect(kinds(plan.violations)).toContain('no_live_tenant');
  });

  test('a live tenant with nothing gradeable is still a refusal, never a green tick', () => {
    const plan = planCanary({ profile: PROFILES.hosted, tenant: 'canary-fixture', pinnedOps: pinned });
    expect(plan.passed).toBe(false);
    expect(kinds(plan.violations)).toContain('nothing_gradeable');
    expect(plan.gradeable).toEqual([]);
    expect(plan.deferred.length).toBe(CANARY_CHECKS.length);
  });

  test('every deferred check names the unit that will make it gradeable', () => {
    const plan = planCanary({ profile: PROFILES.hosted, tenant: 'canary-fixture', pinnedOps: pinned });
    for (const check of plan.deferred) {
      expect(check.unit.trim().length).toBeGreaterThan(0);
      expect(check.awaiting.trim().length).toBeGreaterThan(0);
    }
  });

  test("a check whose op IS pinned becomes gradeable with no edit — the deferral evaporates", () => {
    const plan = planCanary({
      profile: PROFILES.hosted,
      tenant: 'canary-fixture',
      pinnedOps: new Set<ModelOp>(['extract']),
    });
    expect(plan.gradeable.map((c) => c.id)).toEqual(['extraction-recall']);
    expect(kinds(plan.violations)).not.toContain('nothing_gradeable');
  });

  test('a non-independent judge fails the plan before any model is called', () => {
    const profile = {
      name: 'rigged',
      routes: { ...PROFILES.hosted.routes, judge: PROFILES.hosted.routes.extract },
    };
    const plan = planCanary({
      profile,
      tenant: 'canary-fixture',
      pinnedOps: new Set<ModelOp>(['extract']),
    });
    expect(plan.passed).toBe(false);
    expect(kinds(plan.violations)).toContain('judge_not_independent');
  });

  test('the independence check runs per gradeable check, not once globally', () => {
    // `extract` and `synopsis` sit with different vendors in the shipped table,
    // so a judge can be independent of one and not the other. A single global
    // verdict would let the compromised pairing through.
    const profile = {
      name: 'rigged',
      routes: { ...PROFILES.hosted.routes, judge: PROFILES.hosted.routes.synopsis },
    };
    const both = planCanary({
      profile,
      tenant: 'canary-fixture',
      pinnedOps: new Set<ModelOp>(['extract', 'synopsis']),
    });
    expect(kinds(both.violations)).toContain('judge_not_independent');
    const onlyExtract = planCanary({
      profile,
      tenant: 'canary-fixture',
      pinnedOps: new Set<ModelOp>(['extract']),
    });
    expect(kinds(onlyExtract.violations)).not.toContain('judge_not_independent');
  });
});

describe('the committed check set, pinned as a whole', () => {
  // Whole-set equality rather than a subset assertion, for the reason
  // `test/core/search/floors.test.ts` pins its deferrals that way: a check that
  // appears, disappears, or changes owner is a change somebody has to state in
  // writing.
  test('it is exactly these checks, with these owners', () => {
    expect(
      CANARY_CHECKS.map((check) => `${check.id} <- ${check.producedBy} (${check.unit}) floor ${check.floor}`),
    ).toEqual([
      'extraction-recall <- extract (U11) floor 0.8',
      'briefing-coherence <- synopsis (U12) floor 0.8',
    ]);
  });

  test('every check floor is R6-derived and finite', () => {
    for (const check of CANARY_CHECKS) {
      expect(Number.isFinite(check.floor)).toBe(true);
      expect(check.floor).toBeGreaterThan(0);
    }
  });

  test('nothing is gradeable against the committed model-id ledger today, and the plan says so', () => {
    const ledger = loadPinLedger();
    const pinnedOps = new Set<ModelOp>(
      Object.values(ledger.ledger.profiles).flatMap((profile) => (profile?.pins ?? []).map((pin) => pin.op)),
    );
    const plan = planCanary({ profile: PROFILES.hosted, tenant: 'canary-fixture', pinnedOps });
    expect(plan.gradeable).toEqual([]);
    expect(plan.passed).toBe(false);
  });
});

describe('scoreRecall', () => {
  const gold = ['f-1', 'f-2', 'f-3', 'f-4', 'f-5'];

  test('it scores recall over the whole gold key', () => {
    const judgements = gold.map((id, index) => ({ id, recalled: index < 4 }));
    const result = scoreRecall({ gold, judgements, floor: 0.8 });
    expect(result.recall).toBeCloseTo(0.8, 10);
    expect(result.violations).toEqual([]);
  });

  test('below the floor is a violation naming the number', () => {
    const judgements = gold.map((id, index) => ({ id, recalled: index < 3 }));
    const result = scoreRecall({ gold, judgements, floor: 0.8 });
    expect(kinds(result.violations)).toEqual(['below_floor']);
    expect(result.violations[0]?.detail).toContain('0.6');
  });

  test('a gold fact with no judgement is unjudged_item — never dropped from the denominator', () => {
    // Dropping it moves the number in the flattering direction, which is the
    // fail-open shape every other check in this unit is built against.
    const judgements = gold.slice(0, 4).map((id) => ({ id, recalled: true }));
    const result = scoreRecall({ gold, judgements, floor: 0.8 });
    expect(kinds(result.violations)).toContain('unjudged_item');
  });

  test('a judgement for a fact outside the gold key is unknown_item', () => {
    const judgements = [...gold.map((id) => ({ id, recalled: true })), { id: 'f-99', recalled: true }];
    const result = scoreRecall({ gold, judgements, floor: 0.8 });
    expect(kinds(result.violations)).toEqual(['unknown_item']);
  });

  test('a duplicated judgement is a violation, not a second vote', () => {
    const judgements = [...gold.map((id) => ({ id, recalled: true })), { id: 'f-1', recalled: false }];
    const result = scoreRecall({ gold, judgements, floor: 0.8 });
    expect(kinds(result.violations)).toContain('duplicate_judgement');
  });

  test('an empty gold key is a refusal — a recall over nothing is 0/0', () => {
    const result = scoreRecall({ gold: [], judgements: [], floor: 0.8 });
    expect(kinds(result.violations)).toEqual(['empty_gold_key']);
    expect(Number.isFinite(result.recall)).toBe(false);
  });
});
