/**
 * The canonical pricing table, and the arithmetic every cost in the system is
 * computed with.
 *
 * KTD13's rule is "one gateway, one routing table, one pricing table", and the
 * reason it is a rule rather than a preference is upstream history: a second
 * copy of a price produced a 53× cost overrun that surfaced as a bill rather
 * than an error. So this file asserts three things about `src/ai/pricing.ts`:
 *
 * 1. **It carries KTD13's table, in integer micro-USD.** Money never rounds
 *    through a float, and the control plane's `spend_micro_usd` column is
 *    `bigint` for the same reason.
 * 2. **The rounding direction is stated and enforced.** Cost rounds *up*. A
 *    rounding error that under-counts spend is the failure mode this unit
 *    exists to prevent; one that over-counts costs a fraction of a cent.
 * 3. **An overlay may add prices, never shadow one.** A self-hoster supplies
 *    their own cost basis for models the canonical table does not price. If an
 *    overlay could override a canonical entry, "one pricing table" would be
 *    true of the source tree and false at runtime — the same defect wearing a
 *    different hat, and it would be rejected at first call rather than at
 *    construction, which is the wrong end of the run.
 */

import { describe, expect, test } from 'bun:test';

import {
  CANONICAL_PRICE_BOOK,
  CANONICAL_PRICING,
  PricingFaultError,
  PricingOverlayError,
  costMicroUsd,
  createPriceBook,
  type ModelPrice,
} from '../../src/ai/pricing.ts';

/**
 * KTD13's table, re-stated here in the units the plan quotes it in. This is the
 * one legitimate second copy in the repo: a guard needs an independent
 * statement of the value it is guarding, or it only proves the table equals
 * itself. `test/ai/price-drift.test.ts` scans `src/` and not `test/` for
 * exactly that reason — a test may restate a price to check one, and only a
 * shipped module copying a price is drift.
 */
const KTD13_DOLLARS_PER_MILLION: ReadonlyArray<{
  readonly id: string;
  readonly input: number;
  readonly output: number | null;
}> = [
  { id: 'gemini-3.5-flash-lite-2026-07-21', input: 0.3, output: 2.5 },
  { id: '@cf/nvidia/nemotron-3-120b-a12b', input: 0.5, output: 1.5 },
  { id: '@cf/meta/llama-3.2-11b-vision-instruct', input: 0.049, output: 0.676 },
  { id: '@cf/zai-org/glm-5.2', input: 1.4, output: 4.4 },
  { id: '@cf/baai/bge-reranker-base', input: 0.003, output: null },
  { id: 'text-embedding-3-large', input: 0.13, output: null },
];

const MICRO_PER_DOLLAR = 1_000_000;

describe('the canonical table is KTD13, in micro-USD', () => {
  test('every row the plan names is priced, at the price the plan names', () => {
    for (const row of KTD13_DOLLARS_PER_MILLION) {
      const price = CANONICAL_PRICING.get(row.id);
      expect(price, `missing canonical price: ${row.id}`).toBeDefined();
      expect(price?.inputMicroUsdPerMillion).toBe(Math.round(row.input * MICRO_PER_DOLLAR));
      expect(price?.outputMicroUsdPerMillion).toBe(
        row.output === null ? null : Math.round(row.output * MICRO_PER_DOLLAR),
      );
    }
  });

  test('the table holds nothing the plan did not name', () => {
    // A price nobody put in the plan is a price nobody agreed to pay.
    expect([...CANONICAL_PRICING.keys()].sort()).toEqual(
      KTD13_DOLLARS_PER_MILLION.map((row) => row.id).sort(),
    );
  });

  test('every price is a non-negative integer', () => {
    for (const [id, price] of CANONICAL_PRICING) {
      expect(Number.isSafeInteger(price.inputMicroUsdPerMillion), id).toBe(true);
      expect(price.inputMicroUsdPerMillion).toBeGreaterThanOrEqual(0);
      if (price.outputMicroUsdPerMillion !== null) {
        expect(Number.isSafeInteger(price.outputMicroUsdPerMillion), id).toBe(true);
      }
    }
  });
});

describe('cost arithmetic', () => {
  const flashLite = CANONICAL_PRICING.get('gemini-3.5-flash-lite-2026-07-21') as ModelPrice;

  test('a million in and a million out is the table, added up', () => {
    expect(costMicroUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, flashLite)).toBe(
      300_000 + 2_500_000,
    );
  });

  test('a fractional micro-USD rounds up, never down', () => {
    // 1 token of the cheapest model in the table costs 0.000003 micro-USD. A
    // floor would bill it at zero, and ten thousand of those is a free model.
    const reranker = CANONICAL_PRICING.get('@cf/baai/bge-reranker-base') as ModelPrice;
    expect(costMicroUsd({ inputTokens: 1, outputTokens: 0 }, reranker)).toBe(1);
    expect(costMicroUsd({ inputTokens: 0, outputTokens: 0 }, reranker)).toBe(0);
  });

  test('a zero-token call costs nothing, and that is the only free call', () => {
    expect(costMicroUsd({ inputTokens: 0, outputTokens: 0 }, flashLite)).toBe(0);
    expect(costMicroUsd({ inputTokens: 1, outputTokens: 0 }, flashLite)).toBeGreaterThan(0);
  });

  test('output tokens against an input-only price are a fault, not free tokens', () => {
    // The shape that bills a generative model at the reranker's input-only
    // rate and reports zero for everything it wrote.
    const reranker = CANONICAL_PRICING.get('@cf/baai/bge-reranker-base') as ModelPrice;
    expect(() => costMicroUsd({ inputTokens: 10, outputTokens: 10 }, reranker)).toThrow(
      PricingFaultError,
    );
  });

  test('negative or non-integer usage is a fault', () => {
    for (const usage of [
      { inputTokens: -1, outputTokens: 0 },
      { inputTokens: 1.5, outputTokens: 0 },
      { inputTokens: 0, outputTokens: Number.NaN },
    ]) {
      expect(() => costMicroUsd(usage, flashLite)).toThrow(PricingFaultError);
    }
  });
});

describe('the price book', () => {
  test('the canonical book prices exactly the canonical table', () => {
    for (const id of CANONICAL_PRICING.keys()) {
      expect(CANONICAL_PRICE_BOOK.lookup(id)).toBeDefined();
      expect(CANONICAL_PRICE_BOOK.isCanonical(id)).toBe(true);
    }
    expect(CANONICAL_PRICE_BOOK.lookup('self-host/nemotron-3-120b-a12b')).toBeUndefined();
    expect(CANONICAL_PRICE_BOOK.cost('self-host/nemotron-3-120b-a12b', {
      inputTokens: 10,
      outputTokens: 10,
    })).toBeNull();
  });

  test('an overlay may price a model the canonical table does not', () => {
    const book = createPriceBook(
      new Map([
        [
          'self-host/nemotron-3-120b-a12b',
          { inputMicroUsdPerMillion: 40_000, outputMicroUsdPerMillion: 40_000 },
        ],
      ]),
    );
    expect(book.cost('self-host/nemotron-3-120b-a12b', { inputTokens: 1_000_000, outputTokens: 0 }))
      .toBe(40_000);
    // Overlaid, but never canonical: the distinction is what keeps hosted COGS
    // reporting from quietly absorbing a self-hoster's own hardware costs.
    expect(book.isCanonical('self-host/nemotron-3-120b-a12b')).toBe(false);
  });

  test('an overlay that shadows a canonical price is rejected at construction', () => {
    expect(() =>
      createPriceBook(
        new Map([
          ['@cf/zai-org/glm-5.2', { inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: 1 }],
        ]),
      ),
    ).toThrow(PricingOverlayError);
  });

  test('an overlay carrying a malformed price is rejected at construction', () => {
    for (const price of [
      { inputMicroUsdPerMillion: -1, outputMicroUsdPerMillion: null },
      { inputMicroUsdPerMillion: 0.5, outputMicroUsdPerMillion: null },
    ]) {
      expect(() => createPriceBook(new Map([['self-host/x', price]]))).toThrow(PricingOverlayError);
    }
  });

  test('the canonical table cannot be mutated through the book', () => {
    const book = createPriceBook(
      new Map([['self-host/y', { inputMicroUsdPerMillion: 1, outputMicroUsdPerMillion: null }]]),
    );
    expect(book.lookup('self-host/y')).toBeDefined();
    expect(CANONICAL_PRICE_BOOK.lookup('self-host/y')).toBeUndefined();
    expect(CANONICAL_PRICING.get('self-host/y')).toBeUndefined();
  });
});
