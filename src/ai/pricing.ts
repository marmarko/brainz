/**
 * The canonical pricing table (KTD13, R14).
 *
 * **This is the only file under `src/` that may contain a price.** Not a
 * convention — `test/ai/price-drift.test.ts` scans the tree for a second copy
 * and fails the build on one. The rule exists because the failure it prevents
 * is silent: two copies of a number do not diverge until the day a vendor moves
 * one of them, and the first symptom is an invoice. Upstream reached this
 * discipline after a 53× overrun; the plan's judgement is that adopting it on
 * day one is cheaper than retrofitting it.
 *
 * Everything downstream derives from here: per-phase budget caps (U11), the
 * first-import estimate (U9), the rolling per-tenant counter (U2's column), and
 * eval cost receipts (U7/U13). None of them carries its own number.
 *
 * **Units.** Integer micro-USD per million tokens. Two decisions, both load
 * bearing:
 *
 *  - *Integer*, because money must never round through a float, and the
 *    control-plane column is `bigint` for the same reason.
 *  - *Per million tokens*, because that is the unit every vendor quotes, so a
 *    price can be checked against a pricing page without arithmetic. KTD13's
 *    dollars-per-million is this number divided by a million.
 *
 * **Rounding is up, and the direction is a decision.** A per-call cost is
 * usually fractional. Rounding down would bill a one-token rerank at zero, and
 * ten thousand of those is a free model — the exact shape of an unmetered path.
 * Rounding up costs a fraction of a cent per call and can only ever make the
 * cap fire early, which is the safe direction for a spend limit.
 *
 * **Ids are pinned ids, not aliases.** The keys below are what `routing.ts`
 * actually sends on the wire (see the pin rule there). Pricing an alias would
 * mean the price silently follows a model the eval receipts were never scored
 * against.
 *
 * Prices drift. This table and `docs/research/2026-08-12-model-catalog-pricing.md`
 * are dated snapshots of the same catalog; production reads this one.
 */

/** A wire model id, as pinned by `routing.ts`. */
export type ModelId = string;

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelPrice {
  readonly inputMicroUsdPerMillion: number;
  /**
   * `null` for input-only models — a reranker and an embedding model bill on
   * what you send them and nothing else. It is `null` rather than `0` on
   * purpose: zero is a price, and "this model does not bill output" and "this
   * model's output is free" must not be the same value, or output tokens
   * arriving from a model that should not produce them get billed at nothing.
   */
  readonly outputMicroUsdPerMillion: number | null;
}

/** Raised when usage and price cannot be multiplied together honestly. */
export class PricingFaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingFaultError';
  }
}

/** Raised when an overlay would make "one pricing table" false at runtime. */
export class PricingOverlayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingOverlayError';
  }
}

/**
 * KTD13's table. Every row is `$/M` from the plan, multiplied by a million to
 * land in micro-USD: `$0.30/M` is `300_000` micro-USD per million tokens.
 */
const CANONICAL_ENTRIES: ReadonlyArray<readonly [ModelId, ModelPrice]> = [
  // Extraction, enrichment, contradiction — third-party (Google), $0.30 / $2.50.
  ['gemini-3.5-flash-lite-2026-07-21', { inputMicroUsdPerMillion: 300_000, outputMicroUsdPerMillion: 2_500_000 }],
  // Salience and synopsis — Cloudflare-hosted, $0.500 / $1.500.
  ['@cf/nvidia/nemotron-3-120b-a12b', { inputMicroUsdPerMillion: 500_000, outputMicroUsdPerMillion: 1_500_000 }],
  // Image / PDF → text — Cloudflare-hosted, $0.049 / $0.676.
  ['@cf/meta/llama-3.2-11b-vision-instruct', { inputMicroUsdPerMillion: 49_000, outputMicroUsdPerMillion: 676_000 }],
  // Eval judge (canary tier) — Cloudflare-hosted, $1.400 / $4.400.
  ['@cf/zai-org/glm-5.2', { inputMicroUsdPerMillion: 1_400_000, outputMicroUsdPerMillion: 4_400_000 }],
  // Rerank — a cross-encoder, input only, $0.003.
  ['@cf/baai/bge-reranker-base', { inputMicroUsdPerMillion: 3_000, outputMicroUsdPerMillion: null }],
  // Embedding (KTD8) — third-party (OpenAI), input only, $0.13.
  ['text-embedding-3-large', { inputMicroUsdPerMillion: 130_000, outputMicroUsdPerMillion: null }],
];

export const CANONICAL_PRICING: ReadonlyMap<ModelId, ModelPrice> = new Map(
  CANONICAL_ENTRIES.map(([id, price]) => [id, Object.freeze({ ...price })]),
);

/** Tokens in one priced unit. The vendors' quoting unit, not a magic number. */
const TOKENS_PER_QUOTED_UNIT = 1_000_000n;

/** Does this model bill for what it writes? Asked without naming the unit. */
export function billsOutput(price: ModelPrice): boolean {
  return price.outputMicroUsdPerMillion !== null;
}

function assertCountable(tokens: number, side: string): void {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new PricingFaultError(`${side} token count is not a countable quantity: ${tokens}`);
  }
}

/**
 * What a call costs, in integer micro-USD, rounded up.
 *
 * Arithmetic is in `BigInt` end to end: token counts times a per-million rate
 * exceeds nothing a double cannot hold today, but "money never touches a float"
 * is a rule that survives the day someone embeds a corpus.
 */
export function costMicroUsd(usage: TokenUsage, price: ModelPrice): number {
  assertCountable(usage.inputTokens, 'input');
  assertCountable(usage.outputTokens, 'output');

  const outputRate = price.outputMicroUsdPerMillion;
  if (usage.outputTokens > 0 && outputRate === null) {
    // A generative answer from a model priced as input-only. Billing it at zero
    // is how an unmetered path looks from the inside.
    throw new PricingFaultError(
      `model reported ${usage.outputTokens} output tokens but is priced input-only`,
    );
  }

  const total =
    BigInt(usage.inputTokens) * BigInt(price.inputMicroUsdPerMillion) +
    BigInt(usage.outputTokens) * BigInt(outputRate ?? 0);

  // Ceiling division, in integers. See the header: the direction is a decision.
  return Number((total + TOKENS_PER_QUOTED_UNIT - 1n) / TOKENS_PER_QUOTED_UNIT);
}

/**
 * What one caller may price. The canonical table plus, optionally, an overlay
 * for models the canonical table does not price — a self-hoster's own cost
 * basis for open weights running on their own hardware.
 */
export interface PriceBook {
  lookup(modelId: ModelId): ModelPrice | undefined;
  /**
   * True only for rows of the canonical table. An overlaid price is real money
   * to whoever pays it, but it is not the hosted plane's cost of goods, and
   * conflating the two is how a margin model becomes a fiction.
   */
  isCanonical(modelId: ModelId): boolean;
  /** `null` when the model has no price at all — never `0`. */
  cost(modelId: ModelId, usage: TokenUsage): number | null;
}

function assertUsablePrice(modelId: ModelId, price: ModelPrice): void {
  const rates: ReadonlyArray<number | null> = [
    price.inputMicroUsdPerMillion,
    price.outputMicroUsdPerMillion,
  ];
  for (const rate of rates) {
    if (rate === null) continue;
    if (!Number.isSafeInteger(rate) || rate < 0) {
      throw new PricingOverlayError(
        `overlay price for '${modelId}' is not a non-negative integer rate: ${rate}`,
      );
    }
  }
}

/**
 * An **add-only** overlay. An overlay that shadows a canonical price is refused
 * here rather than at first call: "one pricing table" would otherwise be true
 * of the source tree and false at runtime, which is the same defect wearing a
 * different hat.
 */
export function createPriceBook(overlay?: ReadonlyMap<ModelId, ModelPrice>): PriceBook {
  const merged = new Map<ModelId, ModelPrice>(CANONICAL_PRICING);

  if (overlay !== undefined) {
    for (const [modelId, price] of overlay) {
      if (CANONICAL_PRICING.has(modelId)) {
        throw new PricingOverlayError(
          `overlay would shadow the canonical price of '${modelId}' — the table is the only source`,
        );
      }
      assertUsablePrice(modelId, price);
      merged.set(modelId, Object.freeze({ ...price }));
    }
  }

  return {
    lookup: (modelId) => merged.get(modelId),
    isCanonical: (modelId) => CANONICAL_PRICING.has(modelId),
    cost(modelId, usage) {
      const price = merged.get(modelId);
      if (price === undefined) return null;
      return costMicroUsd(usage, price);
    },
  };
}

/** The book with no overlay: what the hosted plane runs on. */
export const CANONICAL_PRICE_BOOK: PriceBook = createPriceBook();
