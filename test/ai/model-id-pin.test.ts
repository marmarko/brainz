/**
 * The model-id pin guard (U7 approach step 8, KTD13).
 *
 * > A CI check asserts each op's routed model id in `src/ai/routing.ts` matches
 * > the id recorded in that op's last committed eval receipt, failing the build
 * > on drift.
 *
 * **Why this is not paperwork.** KTD13 buys one specific diagnostic property by
 * running a current-generation model in every seat: *a floor miss indicts the
 * architecture, not the model tier.* That property holds only if production runs
 * the model the receipt was scored against. The names in the catalog are moving
 * aliases — `routing.ts` says so at length and pins dated snapshots for exactly
 * this reason — so a vendor advancing an alias silently invalidates the
 * calibration, model-tier and embedding A/B receipts, with no signal anywhere.
 *
 * **The guard's own failure mode is being vacuous**, because today *no* op has a
 * receipt naming a routed id: U7's fixture vectors are synthetic, `rerank` and
 * `judge` have no committed scoring yet, and the consolidation ops are U11
 * deliverables. A guard that iterated over the receipts it found would therefore
 * check nothing and pass forever. So it is exhaustive in the other direction:
 * **every op of every profile must be either pinned by a receipt or carry a
 * deferral naming what it is waiting for and which unit owns it.** An op in
 * neither is red; an op in both is red; a receipt that names an id nobody
 * registered is red. That is the same shape `evals/gates.ts` uses for a deferred
 * floor and `scripts/check-ledger.ts` uses for a capability: a thing may be
 * declined, it may never be silently absent.
 */

import { describe, expect, test } from 'bun:test';

import {
  LEDGER_PATH,
  checkModelIdPins,
  loadPinLedger,
  parsePinLedger,
  receiptClaims,
  renderPinReport,
  type PinLedger,
  type PinViolation,
} from '../../evals/model-pins.ts';
import { MODEL_OPS, PROFILES, type ModelOp, type RoutingProfileName } from '../../src/ai/routing.ts';

const kinds = (violations: readonly PinViolation[]): string[] => violations.map((v) => v.kind);

/** Every op deferred, for every profile — the shipped shape, built by hand. */
function allDeferred(overrides: Partial<Record<RoutingProfileName, unknown>> = {}): PinLedger {
  const profile = {
    pins: [],
    deferrals: [{ ops: [...MODEL_OPS], awaiting: 'a receipt', unit: 'U7', note: 'nothing scored yet' }],
  };
  return parsePinLedger(
    JSON.stringify({
      note: 'fixture',
      profiles: {
        hosted: overrides.hosted ?? profile,
        'self-host': overrides['self-host'] ?? profile,
      },
    }),
  );
}

describe('checkModelIdPins is exhaustive over every op of every profile', () => {
  test('the all-deferred ledger passes and reports what it checked', () => {
    const result = checkModelIdPins({ ledger: allDeferred(), receipts: [] });
    expect(result.violations).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.pinned).toBe(0);
    expect(result.deferred).toBe(MODEL_OPS.length * Object.keys(PROFILES).length);
  });

  test('an op in neither pins nor deferrals is unpinned_op — the vacuous-guard case', () => {
    const ledger = allDeferred({
      hosted: {
        pins: [],
        deferrals: [
          { ops: MODEL_OPS.filter((op) => op !== 'judge'), awaiting: 'a receipt', unit: 'U7', note: 'n' },
        ],
      },
    });
    const result = checkModelIdPins({ ledger, receipts: [] });
    expect(kinds(result.violations)).toEqual(['unpinned_op']);
    expect(result.violations[0]?.detail).toContain('judge');
  });

  test('an op both pinned and deferred is double_declared', () => {
    const judge = PROFILES.hosted.routes.judge;
    const ledger = allDeferred({
      hosted: {
        pins: [{ op: 'judge', model_id: judge.id, receipt: 'evals/receipts/x.json', scored_on: '2026-08-13' }],
        deferrals: [{ ops: [...MODEL_OPS], awaiting: 'a receipt', unit: 'U7', note: 'n' }],
      },
    });
    const result = checkModelIdPins({ ledger, receipts: [] });
    expect(kinds(result.violations)).toContain('double_declared');
  });

  test('a routed id that no longer matches its receipt is pin_drift — the whole point', () => {
    const ledger = allDeferred({
      hosted: {
        pins: [
          {
            op: 'judge',
            model_id: '@cf/zai-org/glm-5.1',
            receipt: 'evals/receipts/x.json',
            scored_on: '2026-08-13',
          },
        ],
        deferrals: [
          { ops: MODEL_OPS.filter((op) => op !== 'judge'), awaiting: 'a receipt', unit: 'U7', note: 'n' },
        ],
      },
    });
    const result = checkModelIdPins({
      ledger,
      receipts: [{ path: 'evals/receipts/x.json', profile: 'hosted', models: { judge: '@cf/zai-org/glm-5.1' } }],
    });
    expect(kinds(result.violations)).toEqual(['pin_drift']);
    expect(result.violations[0]?.detail).toContain(PROFILES.hosted.routes.judge.id);
  });

  test('a pin whose routed id still matches passes', () => {
    const judge = PROFILES.hosted.routes.judge;
    const ledger = allDeferred({
      hosted: {
        pins: [{ op: 'judge', model_id: judge.id, receipt: 'evals/receipts/x.json', scored_on: '2026-08-13' }],
        deferrals: [
          { ops: MODEL_OPS.filter((op) => op !== 'judge'), awaiting: 'a receipt', unit: 'U7', note: 'n' },
        ],
      },
    });
    const result = checkModelIdPins({
      ledger,
      receipts: [{ path: 'evals/receipts/x.json', profile: 'hosted', models: { judge: judge.id } }],
    });
    expect(result.violations).toEqual([]);
    expect(result.pinned).toBe(1);
  });

  test('a profile missing from the ledger is missing_profile, not a smaller check', () => {
    const text = JSON.stringify({
      note: 'fixture',
      profiles: {
        hosted: { pins: [], deferrals: [{ ops: [...MODEL_OPS], awaiting: 'a', unit: 'U7', note: 'n' }] },
      },
    });
    const result = checkModelIdPins({ ledger: parsePinLedger(text), receipts: [] });
    expect(kinds(result.violations)).toEqual(['missing_profile']);
  });

  test('an op declared twice in the same profile is duplicate_declaration', () => {
    const ledger = allDeferred({
      hosted: {
        pins: [],
        deferrals: [
          { ops: [...MODEL_OPS], awaiting: 'a', unit: 'U7', note: 'n' },
          { ops: ['judge'], awaiting: 'b', unit: 'U7', note: 'n' },
        ],
      },
    });
    const result = checkModelIdPins({ ledger, receipts: [] });
    expect(kinds(result.violations)).toContain('duplicate_declaration');
  });
});

describe('a committed receipt cannot name a model id the ledger never registered', () => {
  const judge = PROFILES.hosted.routes.judge;

  test('an unregistered receipt claim is a violation', () => {
    const result = checkModelIdPins({
      ledger: allDeferred(),
      receipts: [{ path: 'evals/receipts/canary.json', profile: 'hosted', models: { judge: judge.id } }],
    });
    expect(kinds(result.violations)).toContain('unregistered_receipt');
  });

  test('a registered claim whose id disagrees with the ledger pin is receipt_conflict', () => {
    const ledger = allDeferred({
      hosted: {
        pins: [{ op: 'judge', model_id: judge.id, receipt: 'evals/receipts/canary.json', scored_on: '2026-08-13' }],
        deferrals: [
          { ops: MODEL_OPS.filter((op) => op !== 'judge'), awaiting: 'a', unit: 'U7', note: 'n' },
        ],
      },
    });
    const result = checkModelIdPins({
      ledger,
      receipts: [{ path: 'evals/receipts/canary.json', profile: 'hosted', models: { judge: '@cf/other/model' } }],
    });
    expect(kinds(result.violations)).toEqual(['receipt_conflict']);
  });

  test('a pin naming a receipt that claims nothing is orphan_pin', () => {
    const ledger = allDeferred({
      hosted: {
        pins: [{ op: 'judge', model_id: judge.id, receipt: 'evals/receipts/gone.json', scored_on: '2026-08-13' }],
        deferrals: [
          { ops: MODEL_OPS.filter((op) => op !== 'judge'), awaiting: 'a', unit: 'U7', note: 'n' },
        ],
      },
    });
    // The receipt exists but does not carry the claim the pin says it does.
    const result = checkModelIdPins({
      ledger,
      receipts: [{ path: 'evals/receipts/gone.json', profile: 'hosted', models: {} }],
    });
    expect(kinds(result.violations)).toEqual(['orphan_pin']);
  });

  test('a matching claim and pin passes', () => {
    const ledger = allDeferred({
      hosted: {
        pins: [{ op: 'judge', model_id: judge.id, receipt: 'evals/receipts/canary.json', scored_on: '2026-08-13' }],
        deferrals: [
          { ops: MODEL_OPS.filter((op) => op !== 'judge'), awaiting: 'a', unit: 'U7', note: 'n' },
        ],
      },
    });
    const result = checkModelIdPins({
      ledger,
      receipts: [{ path: 'evals/receipts/canary.json', profile: 'hosted', models: { judge: judge.id } }],
    });
    expect(result.violations).toEqual([]);
  });
});

describe('parsePinLedger refuses a ledger it cannot trust', () => {
  /** A ledger whose hosted profile carries exactly the rows a case supplies. */
  const withHosted = (hosted: { pins?: unknown[]; deferrals?: unknown[] }): string =>
    JSON.stringify({
      note: 'fixture',
      profiles: {
        hosted: { pins: hosted.pins ?? [], deferrals: hosted.deferrals ?? [] },
        'self-host': { pins: [], deferrals: [] },
      },
    });

  test('an unknown op name is refused rather than ignored', () => {
    const text = withHosted({ deferrals: [{ ops: ['transcribe'], awaiting: 'a', unit: 'U7', note: 'n' }] });
    expect(() => parsePinLedger(text)).toThrow(/transcribe/);
  });

  test('an unknown profile name is refused', () => {
    const text = JSON.stringify({ note: 'f', profiles: { byok: { pins: [], deferrals: [] } } });
    expect(() => parsePinLedger(text)).toThrow(/byok/);
  });

  test('a deferral with no unit is refused — a deferral with no owner is a deferral forever', () => {
    const text = withHosted({ deferrals: [{ ops: ['judge'], awaiting: 'a', note: 'n' }] });
    expect(() => parsePinLedger(text)).toThrow(/unit/);
  });

  test('a deferral with no awaiting clause is refused', () => {
    const text = withHosted({ deferrals: [{ ops: ['judge'], awaiting: '  ', unit: 'U7', note: 'n' }] });
    expect(() => parsePinLedger(text)).toThrow(/awaiting/);
  });

  test('a deferral with an empty ops list is refused — it declares nothing', () => {
    const text = withHosted({ deferrals: [{ ops: [], awaiting: 'a', unit: 'U7', note: 'n' }] });
    expect(() => parsePinLedger(text)).toThrow(/ops/);
  });

  test('a pin with no receipt path is refused', () => {
    const text = withHosted({ pins: [{ op: 'judge', model_id: 'x', scored_on: '2026-08-13' }] });
    expect(() => parsePinLedger(text)).toThrow(/receipt/);
  });
});

describe('receiptClaims reads a receipt without inventing one', () => {
  test('a receipt with no scored_against block claims nothing', () => {
    expect(receiptClaims('evals/receipts/x.json', { receipt: 'R6a lower bound' })).toEqual({
      path: 'evals/receipts/x.json',
      profile: null,
      models: {},
    });
  });

  test('a scored_against block is read as claims', () => {
    expect(
      receiptClaims('evals/receipts/x.json', {
        scored_against: { profile: 'hosted', models: { judge: '@cf/zai-org/glm-5.2' } },
      }),
    ).toEqual({
      path: 'evals/receipts/x.json',
      profile: 'hosted',
      models: { judge: '@cf/zai-org/glm-5.2' },
    });
  });

  test('a malformed scored_against block throws rather than being read as no claim', () => {
    expect(() => receiptClaims('evals/receipts/x.json', { scored_against: { models: 'nope' } })).toThrow();
    // A non-object block is the one that matters most: `!isObject(block)` is the
    // natural place to fall back to "claims nothing", and that fallback turns a
    // receipt whose shape drifted into a receipt that binds no model at all.
    expect(() => receiptClaims('evals/receipts/x.json', { scored_against: 'hosted' })).toThrow(/scored_against/);
    expect(() => receiptClaims('evals/receipts/x.json', { scored_against: null })).toThrow(/scored_against/);
  });
});

describe('the committed ledger, against the routing table that ships', () => {
  const loaded = loadPinLedger();

  test('it is green', () => {
    if (!loaded.result.passed) {
      throw new Error(renderPinReport(loaded.result));
    }
    expect(loaded.result.violations).toEqual([]);
  });

  test('it accounts for every op of every profile exactly once', () => {
    expect(loaded.result.pinned + loaded.result.deferred).toBe(MODEL_OPS.length * Object.keys(PROFILES).length);
  });

  test(`it lives at ${LEDGER_PATH}, next to the receipts it binds`, () => {
    expect(LEDGER_PATH.startsWith('evals/receipts/')).toBe(true);
  });

  test('every deferral names a unit that owns closing it', () => {
    for (const profile of Object.values(loaded.ledger.profiles)) {
      for (const deferral of profile?.deferrals ?? []) {
        expect(deferral.unit.trim().length).toBeGreaterThan(0);
        expect(deferral.awaiting.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('the embedding deferral says why the R6a receipts do not pin it', () => {
    // `synthetic-lexical-v1` is the fixture generator, not a routed model. A
    // reader counting receipts would otherwise assume the embedding op is
    // covered by the committed calibration receipts.
    const hosted = loaded.ledger.profiles.hosted;
    const embedding = hosted?.deferrals.find((d) => (d.ops as readonly ModelOp[]).includes('embedding'));
    expect(embedding?.note).toContain('synthetic-lexical-v1');
  });
});
