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
 * were dated snapshots of the same catalog; production reads this one. They are
 * no longer the same date: the Cloudflare rows were re-verified on 2026-08-16
 * against the account's own model catalog rather than a pricing page, which is
 * what moved the reranker off its rounded figure, added the vision seat's price,
 * and added the judge's cached-input rate. Where the two disagree, this file is
 * the later reading and the research doc is the earlier one — neither is stale
 * in the sense of wrong, and only one of them is billed against.
 */

/** A wire model id, as pinned by `routing.ts`. */
export type ModelId = string;

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /**
   * The part of {@link inputTokens} the provider served from its prompt cache,
   * when it says so. A **subset** of the input count, not a fourth quantity
   * beside it — that is how Cloudflare reports it (`prompt_tokens: 376`,
   * `prompt_tokens_details.cached_tokens: 320`), and the arithmetic below
   * subtracts rather than adds because of it.
   *
   * Absent means "the provider reported no cache detail", which bills every
   * input token at the full rate. That is the opposite of rule 2's usual
   * direction, and deliberately so: here the missing signal's safe reading is
   * the *expensive* one. Defaulting to "all cached" would invent a discount.
   */
  readonly cachedInputTokens?: number;
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
  /**
   * What a cache-hit input token costs, when the vendor publishes a second
   * input rate for one. Absent means no published cached rate, and cached
   * tokens then bill at the full input rate.
   *
   * This exists because one of the seats has a very large one: the judge is
   * $1.40/M in and **$0.26/M cached in**, an 82% discount, and the judge is the
   * op whose prompts share a long fixed prefix by construction. Modelling the
   * hit as if it cost full price would overstate the cost of the eval tier by
   * roughly five times on its dominant token class — and a cost model that is
   * wrong in the *safe* direction still drives the wrong decision about what
   * the canary tier can afford to grade.
   *
   * Absent rather than equal-to-input on the rows without one, for the same
   * reason `outputMicroUsdPerMillion` is `null` rather than `0`: "there is no
   * published cached rate" and "the cached rate happens to equal the full rate"
   * are different facts, and only the second is a price.
   */
  readonly cachedInputMicroUsdPerMillion?: number;
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
  // Extraction, enrichment, contradiction, over Cloudflare's Unified Billing
  // passthrough — $0.30 / $2.50. Cloudflare states it passes third-party
  // inference through at no markup and takes its fee on the credit purchase, so
  // the number is Google's own list price; what changed is the wire id.
  ['google/gemini-3.5-flash-lite', { inputMicroUsdPerMillion: 300_000, outputMicroUsdPerMillion: 2_500_000 }],
  // The same weights reached directly, which is what the self-host profile does
  // with its Google rows. Two keys for one model is not a duplicate price: a
  // pricing key is a *wire id*, and these two strings reach two different
  // endpoints under two different billing relationships. They are equal today
  // because the passthrough is at no markup; the day that stops being true, one
  // moves and the other does not, which is exactly what two rows are for.
  ['gemini-3.5-flash-lite-2026-07-21', { inputMicroUsdPerMillion: 300_000, outputMicroUsdPerMillion: 2_500_000 }],
  // Salience and synopsis — Cloudflare-hosted, $0.500 / $1.500.
  ['@cf/nvidia/nemotron-3-120b-a12b', { inputMicroUsdPerMillion: 500_000, outputMicroUsdPerMillion: 1_500_000 }],
  // Image / PDF → text — Cloudflare-hosted, $0.300 / $1.000. Confirmed against
  // the account's own model catalog, which is what retired the "price
  // unpublished" blocker this seat was declined on.
  ['@cf/moondream/moondream3.1-9B-A2B', { inputMicroUsdPerMillion: 300_000, outputMicroUsdPerMillion: 1_000_000 }],
  // Eval judge (canary tier) — Cloudflare-hosted, $1.400 / $4.400, and $0.260
  // for an input token served from the prompt cache.
  [
    '@cf/zai-org/glm-5.2',
    {
      inputMicroUsdPerMillion: 1_400_000,
      outputMicroUsdPerMillion: 4_400_000,
      cachedInputMicroUsdPerMillion: 260_000,
    },
  ],
  // Rerank — a cross-encoder, input only, $0.00311. Not $0.003: the rounded
  // figure understates by 3.7%, and a reranker is called per candidate per
  // query, which is the highest call-count row in the table.
  ['@cf/baai/bge-reranker-base', { inputMicroUsdPerMillion: 3_110, outputMicroUsdPerMillion: null }],
  // Embedding (KTD8) — third-party (OpenAI), input only, $0.13.
  ['text-embedding-3-large', { inputMicroUsdPerMillion: 130_000, outputMicroUsdPerMillion: null }],
  // Priced but **not routed**: the Cloudflare embedding seat, $0.0118, 1024
  // dimensions. It is here because the price is verified and this is the only
  // file allowed to hold one — not because anything sends to it. Moving the
  // embedding seat is a stored-width change (the column is 1536) plus a
  // re-encode of every chunk in every brain, since a qwen vector and an OpenAI
  // vector are not points in the same space. See
  // `upstream/concepts.jsonl:gap.cloudflare-embedding-seat`.
  ['@cf/qwen/qwen3-embedding-0.6b', { inputMicroUsdPerMillion: 11_800, outputMicroUsdPerMillion: null }],
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

  const cached = usage.cachedInputTokens ?? 0;
  assertCountable(cached, 'cached input');
  if (cached > usage.inputTokens) {
    // Cached tokens are a subset of the input count. If a provider ever
    // reported otherwise, the subtraction below would bill a negative quantity
    // — a call that reduces the bill, which is an unmetered path wearing a
    // discount. Refused rather than clamped, because clamping would hide a
    // provider whose usage block had started meaning something else.
    throw new PricingFaultError(
      `provider reported ${cached} cached input tokens of ${usage.inputTokens} input tokens`,
    );
  }

  // No published cached rate means cached tokens are ordinary input tokens.
  // Assuming a discount nobody published would understate the bill, and this
  // number is what a spend cap fires on.
  const cachedRate = price.cachedInputMicroUsdPerMillion ?? price.inputMicroUsdPerMillion;

  const total =
    BigInt(usage.inputTokens - cached) * BigInt(price.inputMicroUsdPerMillion) +
    BigInt(cached) * BigInt(cachedRate) +
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
  const rates: ReadonlyArray<number | null | undefined> = [
    price.inputMicroUsdPerMillion,
    price.outputMicroUsdPerMillion,
    price.cachedInputMicroUsdPerMillion,
  ];
  for (const rate of rates) {
    if (rate === null || rate === undefined) continue;
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
