/**
 * "Estimate before run", and where the numbers come from.
 *
 * U11 says per-phase caps are "computed from the canonical pricing table rather
 * than guessed". That is checkable in a way a comment is not: the estimate for a
 * phase must equal what `src/ai/pricing.ts` says its routed model costs for the
 * workload the estimator was given. If it does not, some second number is in the
 * loop — which is exactly the drift `test/ai/price-drift.test.ts` scans the tree
 * for, arriving through arithmetic instead of through a literal.
 *
 * The other half is that a cap has to be able to *fire*. An estimate that
 * assumes the cheapest possible answer produces a cap that is reached after the
 * money is gone, so the projection uses the route's own output ceiling — the
 * same conservative direction the gateway's pre-call estimate takes.
 */

import { describe, expect, test } from 'bun:test';

import { CANONICAL_PRICE_BOOK, costMicroUsd } from '../../src/ai/pricing.ts';
import { HOSTED_PROFILE, IMAGE_INPUT_TOKENS, routeFor } from '../../src/ai/routing.ts';
import { MODEL_PHASES, PHASE_OP } from '../../src/worker/consolidate/phases.ts';
import {
  budgetsFor,
  estimateCycle,
  type PhaseWorkload,
} from '../../src/worker/consolidate/estimate.ts';

const WORKLOAD: Readonly<Record<string, PhaseWorkload>> = Object.freeze({
  // U21's phase. An image is a short prompt and a large picture, so its
  // per-item figure is the picture's — taken from the one place that number
  // lives rather than restated, since a fixture that disagreed with the
  // estimator would assert the estimator against itself.
  transcribe: { items: 6, inputTokensPerItem: IMAGE_INPUT_TOKENS + 100 },
  extract: { items: 10, inputTokensPerItem: 400 },
  enrich: { items: 4, inputTokensPerItem: 800 },
  synopsis: { items: 10, inputTokensPerItem: 400 },
  contradiction: { items: 3, inputTokensPerItem: 600 },
  salience_refine: { items: 5, inputTokensPerItem: 1_200 },
});

describe('the estimate derives from the canonical table and nothing else', () => {
  test('each phase costs what its routed model charges for the projected work', () => {
    const estimate = estimateCycle({ profile: HOSTED_PROFILE, workload: WORKLOAD });

    for (const phase of MODEL_PHASES) {
      const route = routeFor(HOSTED_PROFILE, PHASE_OP[phase]);
      const price = CANONICAL_PRICE_BOOK.lookup(route.id);
      expect(price).toBeDefined();
      const work = WORKLOAD[phase];
      expect(work).toBeDefined();
      if (price === undefined || work === undefined) return;

      const expected = costMicroUsd(
        {
          inputTokens: work.items * work.inputTokensPerItem,
          // The ceiling, not a guess: an estimate that assumes a short answer is
          // a cap that fires after the money is spent.
          outputTokens: work.items * route.maxOutputTokens,
        },
        price,
      );
      expect(estimate.perPhase[phase]).toBe(expected);
      expect(estimate.modelIds[phase]).toBe(route.id);
    }
  });

  test('the total is the sum of the phases, and a zero workload estimates zero', () => {
    const estimate = estimateCycle({ profile: HOSTED_PROFILE, workload: WORKLOAD });
    const summed = MODEL_PHASES.reduce((total, phase) => total + estimate.perPhase[phase], 0);
    expect(estimate.totalMicroUsd).toBe(summed);

    const idle = estimateCycle({
      profile: HOSTED_PROFILE,
      workload: Object.fromEntries(
        MODEL_PHASES.map((phase) => [phase, { items: 0, inputTokensPerItem: 0 }]),
      ),
    });
    expect(idle.totalMicroUsd).toBe(0);
  });
});

describe('per-phase caps', () => {
  test('each phase gets its own budget object, labelled with the phase', () => {
    const estimate = estimateCycle({ profile: HOSTED_PROFILE, workload: WORKLOAD });
    const budgets = budgetsFor(estimate, { headroom: 1 });

    for (const phase of MODEL_PHASES) {
      const budget = budgets[phase];
      expect(budget.label).toContain(phase);
      expect(budget.capMicroUsd).toBe(estimate.perPhase[phase]);
      expect(budget.spentMicroUsd()).toBe(0);
    }

    // Distinct objects, not one budget handed round: a shared budget is one
    // phase spending another's cap, which is the thing per-phase caps prevent.
    const seen = new Set(MODEL_PHASES.map((phase) => budgets[phase]));
    expect(seen.size).toBe(MODEL_PHASES.length);
  });

  test('a cycle cap smaller than the estimate scales every phase down proportionally', () => {
    const estimate = estimateCycle({ profile: HOSTED_PROFILE, workload: WORKLOAD });
    const budgets = budgetsFor(estimate, { capMicroUsd: Math.floor(estimate.totalMicroUsd / 4) });
    const total = MODEL_PHASES.reduce((sum, phase) => sum + (budgets[phase].capMicroUsd ?? 0), 0);
    expect(total).toBeLessThanOrEqual(Math.floor(estimate.totalMicroUsd / 4));
    for (const phase of MODEL_PHASES) {
      expect(budgets[phase].capMicroUsd).toBeLessThanOrEqual(estimate.perPhase[phase]);
    }
  });

  test('a zero cycle cap is a zero cap on every phase — the free tier, exactly', () => {
    const estimate = estimateCycle({ profile: HOSTED_PROFILE, workload: WORKLOAD });
    const budgets = budgetsFor(estimate, { capMicroUsd: 0 });
    for (const phase of MODEL_PHASES) {
      expect(budgets[phase].capMicroUsd).toBe(0);
      // A zero cap must refuse a priced call rather than admit a free one.
      expect(budgets[phase].reserve(1)).toBeNull();
    }
  });
});
