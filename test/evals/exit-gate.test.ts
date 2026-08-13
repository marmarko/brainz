/**
 * U11's exit gate: the harness, its refusals, and the price of running it.
 *
 * Gap #19 split KTD13's model-tier check in two because a Phase-1 gate over ops
 * that did not exist would have been "signed off empty". U11 is where the five
 * consolidation ops exist, so this is where their gate lives — and it lands in
 * the same state U7's other gates are in: **built, wired, and honestly
 * deferred**, because grading these ops means live paid calls and nobody has
 * authorised that spend.
 *
 * The failure mode this file is written against is a gate that reports green
 * for having graded nothing. Four separate assertions attack it:
 *
 *   1. Every one of the five ops has a check. A harness that quietly covers
 *      three is a gate with two holes and a green tick.
 *   2. Unauthorised is `deferred` with a reason, never `green`.
 *   3. `green` is unreachable without a measurement, even when everything else
 *      is in place — the state is derived from a score, not from permission.
 *   4. The committed cost estimate is recomputed here from the canonical pricing
 *      table. A receipt whose numbers were typed in is a receipt that will
 *      disagree with the bill.
 */

import { describe, expect, test } from 'bun:test';

import { CANONICAL_PRICE_BOOK, costMicroUsd } from '../../src/ai/pricing.ts';
import { PROFILES, routeFor, type ModelOp } from '../../src/ai/routing.ts';
import {
  COST_RECEIPT_PATH,
  EXIT_GATE_CHECKS,
  EXIT_GATE_OPS,
  EXIT_GATE_WORKLOAD,
  estimateExitGateCost,
  planExitGate,
  renderExitGate,
} from '../../evals/exit-gate.ts';
import { loadPinLedger } from '../../evals/model-pins.ts';

const profile = PROFILES.hosted;

describe('the harness covers the ops U11 owes a receipt for', () => {
  test('all five, exactly', () => {
    expect([...EXIT_GATE_OPS].sort().join(',')).toBe(
      'contradiction,enrich,extract,salience,synopsis',
    );
    expect([...new Set(EXIT_GATE_CHECKS.map((check) => check.op))].sort()).toEqual(
      [...EXIT_GATE_OPS].sort(),
    );
  });

  test('every check carries R6’s canary floor and a gold key it would score against', () => {
    for (const check of EXIT_GATE_CHECKS) {
      expect(check.floor).toBe(0.8);
      expect(check.metric.trim().length).toBeGreaterThan(0);
      expect(check.gold.trim().length).toBeGreaterThan(0);
      expect(check.note.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('unauthorised spend defers; it never passes', () => {
  const plan = planExitGate({
    profile,
    tenant: 'canary-fixture',
    pinnedOps: new Set<ModelOp>(),
    liveCallsAuthorised: false,
    scores: new Map(),
  });

  test('every op is deferred, and each names the spend as the reason', () => {
    expect(plan.outcomes.length).toBe(EXIT_GATE_OPS.length);
    for (const outcome of plan.outcomes) {
      expect(outcome.status).toBe('deferred');
      expect(outcome.reason.toLowerCase()).toContain('authoris');
    }
    expect(plan.passed).toBe(false);
    expect(plan.deferred.length).toBe(EXIT_GATE_OPS.length);
  });

  test('the rendering says so out loud rather than printing a tick', () => {
    const text = renderExitGate(plan);
    expect(text).toContain('deferred');
    expect(text).not.toContain('green');
  });

  test('the committed model-id ledger agrees: none of the five is pinned', () => {
    const ledger = loadPinLedger();
    const pinned = new Set<ModelOp>(
      Object.values(ledger.ledger.profiles).flatMap((entry) =>
        (entry?.pins ?? []).map((pin) => pin.op),
      ),
    );
    for (const op of EXIT_GATE_OPS) expect(pinned.has(op)).toBe(false);
    // The guard that keeps the two in step: an op nobody pinned and nobody
    // deferred fails `bun test`.
    expect(ledger.result.passed).toBe(true);
  });
});

describe('green is derived from a score, not from permission', () => {
  const authorised = {
    profile,
    tenant: 'canary-fixture',
    pinnedOps: new Set<ModelOp>(EXIT_GATE_OPS),
    liveCallsAuthorised: true,
  };

  test('authorised with no scores is still not green', () => {
    const plan = planExitGate({ ...authorised, scores: new Map() });
    for (const outcome of plan.outcomes) {
      expect(outcome.status).not.toBe('green');
      expect(outcome.reason.toLowerCase()).toContain('no score');
    }
    expect(plan.passed).toBe(false);
  });

  test('a score below the floor is red, and above it is green', () => {
    const below = planExitGate({
      ...authorised,
      scores: new Map(EXIT_GATE_OPS.map((op) => [op, 0.5])),
    });
    expect(below.outcomes.every((outcome) => outcome.status === 'red')).toBe(true);
    expect(below.passed).toBe(false);

    const above = planExitGate({
      ...authorised,
      scores: new Map(EXIT_GATE_OPS.map((op) => [op, 0.9])),
    });
    expect(above.outcomes.every((outcome) => outcome.status === 'green')).toBe(true);
    expect(above.passed).toBe(true);
    // Each green names the pinned id it was scored against — KTD13's whole
    // diagnostic property depends on that binding.
    for (const outcome of above.outcomes) {
      expect(outcome.modelId).toBe(routeFor(profile, outcome.op).id);
    }
  });

  test('a scored op whose id is not pinned cannot be green', () => {
    const plan = planExitGate({
      profile,
      tenant: 'canary-fixture',
      pinnedOps: new Set<ModelOp>(),
      liveCallsAuthorised: true,
      scores: new Map(EXIT_GATE_OPS.map((op) => [op, 0.99])),
    });
    for (const outcome of plan.outcomes) {
      expect(outcome.status).not.toBe('green');
      expect(outcome.reason.toLowerCase()).toContain('pin');
    }
  });

  test('no tenant is a refusal for every op, whatever the scores say', () => {
    const plan = planExitGate({
      ...authorised,
      tenant: null,
      scores: new Map(EXIT_GATE_OPS.map((op) => [op, 0.99])),
    });
    expect(plan.passed).toBe(false);
    expect(plan.violations.some((violation) => violation.kind === 'no_live_tenant')).toBe(true);
  });
});

describe('the cost estimate, recomputed rather than trusted', () => {
  test('each op costs what its routed model charges for the declared workload', () => {
    const estimate = estimateExitGateCost(profile);

    for (const op of EXIT_GATE_OPS) {
      const route = routeFor(profile, op);
      const price = CANONICAL_PRICE_BOOK.lookup(route.id);
      const work = EXIT_GATE_WORKLOAD[op];
      expect(price).toBeDefined();
      if (price === undefined) return;

      const expected = costMicroUsd(
        {
          inputTokens: work.items * work.inputTokensPerItem,
          outputTokens: work.items * route.maxOutputTokens,
        },
        price,
      );
      const row = estimate.rows.find((candidate) => candidate.op === op);
      expect(row?.microUsd).toBe(expected);
      expect(row?.modelId).toBe(route.id);
    }

    expect(estimate.totalMicroUsd).toBe(
      estimate.rows.reduce((total, row) => total + row.microUsd, 0),
    );
  });

  test('the committed receipt is what this computation produces today', async () => {
    const receipt = (await Bun.file(COST_RECEIPT_PATH).json()) as {
      profile: string;
      total_micro_usd: number;
      per_op: Record<string, { model_id: string; micro_usd: number }>;
      workload: Record<string, { items: number; input_tokens_per_item: number }>;
    };
    const estimate = estimateExitGateCost(profile);

    expect(receipt.profile).toBe('hosted');
    expect(receipt.total_micro_usd).toBe(estimate.totalMicroUsd);
    for (const row of estimate.rows) {
      expect(receipt.per_op[row.op]?.micro_usd).toBe(row.microUsd);
      expect(receipt.per_op[row.op]?.model_id).toBe(row.modelId);
    }
    for (const op of EXIT_GATE_OPS) {
      expect(receipt.workload[op]?.items).toBe(EXIT_GATE_WORKLOAD[op].items);
      expect(receipt.workload[op]?.input_tokens_per_item).toBe(
        EXIT_GATE_WORKLOAD[op].inputTokensPerItem,
      );
    }
  });

  test('the receipt claims no model was scored — because none was', async () => {
    const receipt = (await Bun.file(COST_RECEIPT_PATH).json()) as Record<string, unknown>;
    // `scored_against` is what pins an op in `evals/receipts/model-ids.json`. An
    // estimate that carried one would pin a model nothing ran.
    expect(receipt['scored_against']).toBeUndefined();
    expect(String(receipt['note'])).toContain('estimate');
  });
});
