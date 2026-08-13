/**
 * The cycle's shape, before any of it runs.
 *
 * U11's first sentence is an ordering — "cheap→expensive ... free tier stops
 * here" — and an ordering that lives only in the sequence of statements inside
 * a function is an ordering nothing can check. Three properties are asserted
 * here rather than trusted:
 *
 *   1. **Every deterministic phase precedes every model phase.** If it did not,
 *      budget truncation would stop the cycle before the free work was done —
 *      which is the whole reason the order exists, and it fails silently:
 *      truncation still produces `dreamt: false`, just with less of the free
 *      tier finished.
 *   2. **The free-tier line is the boundary between the two tiers**, not a
 *      separate list that could drift from it.
 *   3. **Every model phase names a KTD13 op**, and the op set is exactly the
 *      five the plan's exit gate grades. A phase that picked a model, or that
 *      routed through an op nobody grades, is the drift KTD13 exists to prevent.
 */

import { describe, expect, test } from 'bun:test';

import { MODEL_OPS, type ModelOp } from '../../src/ai/routing.ts';
import {
  CYCLE_PHASES,
  DETERMINISTIC_PHASES,
  FREE_TIER_PHASES,
  MODEL_PHASES,
  PHASE_OP,
  TIER_OF,
  findPhaseOrderViolations,
  isModelPhase,
  type CyclePhase,
} from '../../src/worker/consolidate/phases.ts';

describe('cheap before expensive', () => {
  test('the shipped order puts every deterministic phase ahead of every model phase', () => {
    expect(findPhaseOrderViolations(CYCLE_PHASES)).toEqual([]);
  });

  test('the check can go red — a model phase moved ahead of a deterministic one', () => {
    const scrambled: CyclePhase[] = [MODEL_PHASES[0], ...DETERMINISTIC_PHASES];
    const findings = findPhaseOrderViolations(scrambled);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.join(' ')).toContain(MODEL_PHASES[0]);
  });

  test('a phase named twice is a finding, because a checkpoint keyed on it is ambiguous', () => {
    expect(findPhaseOrderViolations([...CYCLE_PHASES, CYCLE_PHASES[0]] as CyclePhase[]).length)
      .toBeGreaterThan(0);
  });

  test('a phase missing from the order is a finding', () => {
    expect(findPhaseOrderViolations(CYCLE_PHASES.slice(1) as CyclePhase[]).length).toBeGreaterThan(0);
  });
});

describe('the free-tier line', () => {
  test('is exactly the deterministic tier — one list, not two', () => {
    expect([...FREE_TIER_PHASES]).toEqual([...DETERMINISTIC_PHASES]);
  });

  test('every phase belongs to exactly one tier, and the two partition the cycle', () => {
    expect([...CYCLE_PHASES].sort()).toEqual(
      [...DETERMINISTIC_PHASES, ...MODEL_PHASES].sort(),
    );
    for (const phase of CYCLE_PHASES) {
      expect(TIER_OF[phase]).toBe(isModelPhase(phase) ? 'model' : 'deterministic');
    }
  });
});

describe('KTD13 — the model per phase is the table, not a choice made here', () => {
  test('every model phase routes through a declared op', () => {
    const ops = new Set<string>(MODEL_OPS);
    for (const phase of MODEL_PHASES) {
      expect(ops.has(PHASE_OP[phase])).toBe(true);
    }
  });

  test('the ops are exactly the ones U11 owes an exit-gate receipt for', () => {
    // The plan's U11 verification names five "and U21's `image_to_text` when it
    // lands". It has landed, as the `vision` op — KTD13's "Image / PDF → text"
    // row, which is the table the decision says is the source of truth rather
    // than the prose. So the exit gate owes six receipts, and this list is what
    // says so.
    const expected: ModelOp[] = [
      'extract',
      'enrich',
      'contradiction',
      'salience',
      'synopsis',
      'vision',
    ];
    expect([...new Set(MODEL_PHASES.map((phase) => PHASE_OP[phase]))].sort()).toEqual(
      expected.sort(),
    );
  });
});
