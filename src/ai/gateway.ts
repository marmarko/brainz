/**
 * The single seam every model call in the system passes through (U20).
 *
 * One sentence is the whole unit: **no model call anywhere escapes metering.**
 * Its absence produced a 53× cost overrun upstream, and the reason that number
 * got so large before anyone noticed is that an unmetered path does not surface
 * as an error — it surfaces as a bill.
 *
 * Everything below is arranged around the ways that sentence goes quietly
 * false. Each is a guard that fails *open* unless it is built the other way
 * round, so each is stated as an ordering rule rather than a check:
 *
 *  1. **The estimate leaves the budget before the provider is called, and is
 *     reconciled after.** Checking a counter and incrementing it later is not a
 *     cap — it is a cap divided by the concurrency, because every call that
 *     starts before the first one finishes reads the same empty budget. A phase
 *     that fans out forty embeds overshoots forty-fold, and no sequential test
 *     can see it. So a call takes a *reservation* out of the budget in one
 *     synchronous step, before its first `await`, and settles it afterwards.
 *  2. **A missing signal is a failure, not a zero.** A provider that reports no
 *     usage is `usage_unreported`, never a free call. A model with no price is
 *     `price: unknown` with a `null` cost, never a cost of zero.
 *  2a. **A call the provider ran but whose cost cannot be computed is charged at
 *     its estimate.** This is rule 2 for the *ceiling* rather than the ledger,
 *     and the two jobs pull opposite ways: the bill must never carry an invented
 *     number, and the cap must never assume the cheapest one. A typed failure
 *     that leaves the budget where it found it lets the same call be made
 *     forever under a live cap — a provider whose usage block goes missing, or a
 *     gateway returning 504 after the model ran, spends without limit and every
 *     individual call looks like a well-handled error.
 *  3. **A metering write that fails takes the answer down with it.** Returning
 *     a completion whose cost was never recorded *is* the unmetered path. The
 *     completion is dropped instead; losing one answer is cheaper than losing
 *     the count, and U11 checkpoints on typed failures anyway.
 *  4. **Budgets are passed in, never read from ambient state**, so a
 *     consolidation phase can carry a per-phase cap while a request-path rerank
 *     carries a different one, in the same process, with no coordination.
 *
 * **Retention posture, decided here rather than in a console setting nobody
 * owns.** Every chunk of the user's mail transits this module. AI Gateway
 * retains request and response bodies when logging is on, so the transport
 * sends `cf-aig-collect-log: false` on every request and the metadata header
 * carries op, model, tenant and profile — never content. The metering record
 * has no field that can hold a prompt, and no failure carries a provider's
 * error body outward: a provider that echoes the request in its error message
 * would otherwise write the user's words into a log line.
 */

import type { SQL } from 'bun';

import { isValidTenantId, type CallerIdentity } from '../control/secrets.ts';
import {
  CANONICAL_PRICE_BOOK,
  PricingFaultError,
  costMicroUsd,
  createPriceBook,
  type ModelId,
  type ModelPrice,
  type PriceBook,
  type TokenUsage,
} from './pricing.ts';
import {
  EMBEDDING_PIN,
  OP_KINDS,
  assertRoutable,
  routeFor,
  type ModelOp,
  type NamedProfile,
  type OpKind,
  type ProviderId,
  type Route,
} from './routing.ts';
import {
  resolveProviderKey,
  type HostedKeyPool,
  type KeySource,
  type TenantProviderKeyStore,
} from './keys.ts';

// ---------------------------------------------------------------------------
// Budgets.
// ---------------------------------------------------------------------------

/**
 * Money taken out of a budget for a call that has not finished yet.
 *
 * The point of the type is that there is no way to spend without holding one,
 * and no way to hold one without the cap having already been checked. A
 * `wouldExceed()` followed later by a `commit()` reads correctly, tests
 * correctly one call at a time, and lets N concurrent callers through a cap
 * sized for one.
 *
 * Exactly one of the three closers runs; the rest are ignored, so a path that
 * settles and then releases on the way out cannot double-count.
 */
export interface Reservation {
  /** What was held. Zero when no price was available to estimate from. */
  readonly estimateMicroUsd: number;
  /** The call completed and cost this much. */
  settle(actualMicroUsd: number): void;
  /**
   * The provider did the work and the cost cannot be computed. The estimate
   * stands as the charge — see rule 2a: the ledger declines to invent a number,
   * the ceiling declines to assume the cheapest one.
   */
  settleAtEstimate(): void;
  /** The provider was never reached, or told us it did no work. */
  release(): void;
}

export interface Budget {
  /** The phase this budget belongs to; carried into the typed failure. */
  readonly label: string;
  /** `null` means no cap. It does not mean "unlimited money" — it means the
   * caller has taken responsibility for the ceiling somewhere else. */
  readonly capMicroUsd: number | null;
  /** Settled money: calls that finished. */
  spentMicroUsd(): number;
  /** Money held by calls in flight. Nonzero only while calls are outstanding. */
  reservedMicroUsd(): number;
  /**
   * Take `estimateMicroUsd` out of what is left, or refuse. `null` is the
   * refusal, and it is the only way this module learns a cap was reached.
   *
   * Synchronous on purpose, and called before the first `await` on the request
   * path: that is what makes it atomic on a single-threaded runtime. An `async`
   * reserve would reintroduce exactly the interleaving it exists to prevent.
   */
  reserve(estimateMicroUsd: number): Reservation | null;
}

export function createBudget(options: {
  readonly label: string;
  readonly capMicroUsd: number | null;
}): Budget {
  let spent = 0;
  let reserved = 0;
  const cap = options.capMicroUsd;

  /** Negative or non-integer money is refused rather than trusted: it would
   * otherwise be a way to give a budget back more than was taken from it. */
  const countable = (amount: number): number =>
    Number.isSafeInteger(amount) && amount > 0 ? amount : 0;

  return {
    label: options.label,
    capMicroUsd: cap,
    spentMicroUsd: () => spent,
    reservedMicroUsd: () => reserved,
    reserve(estimateMicroUsd) {
      const held = countable(estimateMicroUsd);
      if (cap !== null && spent + reserved + held > cap) return null;
      reserved += held;

      let open = true;
      const close = (charge: number): void => {
        if (!open) return;
        open = false;
        reserved -= held;
        spent += charge;
      };

      return {
        estimateMicroUsd: held,
        settle: (actual) => close(countable(actual)),
        settleAtEstimate: () => close(held),
        release: () => close(0),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// What a call looks like on either side of the transport.
// ---------------------------------------------------------------------------

export type ModelInput =
  | { readonly kind: 'chat'; readonly system?: string; readonly user: string }
  | { readonly kind: 'embedding'; readonly texts: readonly string[] }
  | { readonly kind: 'rerank'; readonly query: string; readonly candidates: readonly string[] };

export type ModelOutput =
  | { readonly kind: 'chat'; readonly text: string }
  | { readonly kind: 'embedding'; readonly vectors: ReadonlyArray<readonly number[]> }
  | { readonly kind: 'rerank'; readonly scores: readonly number[] };

/** Metadata a transport may attach to a request. Content is not in this type. */
export interface CallMetadata {
  readonly op: ModelOp;
  readonly tenantId: string;
  readonly profile: string;
  readonly budgetLabel: string;
}

export interface TransportRequest {
  readonly modelId: ModelId;
  readonly provider: ProviderId;
  readonly op: ModelOp;
  readonly kind: OpKind;
  readonly input: ModelInput;
  readonly apiKey: string;
  readonly maxOutputTokens: number;
  /** KTD8's `dimensions` parameter for embeddings; `null` for other kinds. */
  readonly embeddingDimensions: number | null;
  readonly metadata: CallMetadata;
}

export interface TransportResponse {
  readonly output: ModelOutput;
  /**
   * Absent when the provider reported none. Deliberately optional rather than
   * defaulted to zero: a default here is a free call in unlimited quantity.
   */
  readonly usage?: TokenUsage;
}

export interface ModelTransport {
  readonly id: string;
  invoke(request: TransportRequest): Promise<TransportResponse>;
}

/** Carries a status and nothing else — never a provider's response body. */
export class TransportError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'TransportError';
    this.status = status;
  }
}

export class GatewayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewayConfigError';
  }
}

// ---------------------------------------------------------------------------
// Metering.
// ---------------------------------------------------------------------------

/**
 * What is recorded for every call: op name, model, token counts, cost, tenant
 * id, and how it was paid for. There is deliberately no field a prompt, a
 * completion or a provider message could be put in.
 */
export interface MeteringRecord {
  readonly tenantId: string;
  readonly op: ModelOp;
  readonly profile: string;
  readonly modelId: ModelId;
  readonly provider: ProviderId;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** `unknown` when no price exists for this model. Never a silent zero. */
  readonly price: 'known' | 'unknown';
  readonly costMicroUsd: number | null;
  readonly keySource: KeySource;
  readonly countsTowardHostedCogs: boolean;
  readonly budgetLabel: string;
  readonly atMs: number;
}

export interface SpendMeter {
  record(record: MeteringRecord): Promise<void>;
}

export interface InMemorySpendMeter extends SpendMeter {
  totalFor(tenantId: string): number;
  records(): readonly MeteringRecord[];
}

/** For tests and local development. Never for production. */
export function createInMemorySpendMeter(): InMemorySpendMeter {
  const written: MeteringRecord[] = [];
  const totals = new Map<string, number>();

  return {
    record(record) {
      written.push(record);
      totals.set(record.tenantId, (totals.get(record.tenantId) ?? 0) + (record.costMicroUsd ?? 0));
      return Promise.resolve();
    },
    totalFor: (tenantId) => totals.get(tenantId) ?? 0,
    records: () => written,
  };
}

/**
 * A billing month. The window R14's counter rolls on, stated once here because
 * a window nobody names is a counter that only ever goes up.
 */
export const DEFAULT_SPEND_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/**
 * The production meter: R14's **rolling** counter on the control-plane row.
 *
 * Three properties, each of which is a way the counter goes quietly wrong:
 *
 *  - **`x = x + $1` in one statement, not read-then-write.** Two tenants under
 *    concurrent load is the easy case; the same tenant under concurrent load is
 *    where a read-modify-write loses updates silently, and the bill is the only
 *    place that shows up.
 *  - **The window rolls in the same statement it accumulates in.** A counter
 *    that never resets is a cap every tenant eventually hits and never leaves;
 *    a window rolled by a separate read-then-write races the increment and
 *    loses a call's cost every time it fires. `CASE` in one `UPDATE` does both
 *    atomically: either this call opens a new window carrying its own cost, or
 *    it adds to the open one.
 *  - **A zero-row update is an error, not a no-op.** `UPDATE … WHERE tenant_id
 *    = $1` that matches nothing succeeds at the protocol level, so a meter that
 *    shrugs at it is an unmetered path with a green tick on it.
 */
export function createPostgresSpendMeter(options: {
  readonly sql: SQL;
  readonly windowSeconds?: number;
}): SpendMeter {
  const { sql } = options;
  const windowSeconds = options.windowSeconds ?? DEFAULT_SPEND_WINDOW_SECONDS;

  return {
    async record(record) {
      const delta = record.costMicroUsd ?? 0;
      if (!Number.isSafeInteger(delta) || delta < 0) {
        // The schema's own CHECK would refuse a negative total; refusing the
        // delta here means the counter never even attempts to go backwards.
        throw new Error(`refusing to meter a non-countable cost: ${String(record.costMicroUsd)}`);
      }

      const rows = (await sql`
        UPDATE control.tenant
           SET spend_micro_usd = CASE
                 WHEN spend_window_started_at <= now() - make_interval(secs => ${windowSeconds})
                 THEN ${delta}
                 ELSE spend_micro_usd + ${delta}
               END,
               spend_window_started_at = CASE
                 WHEN spend_window_started_at <= now() - make_interval(secs => ${windowSeconds})
                 THEN now()
                 ELSE spend_window_started_at
               END,
               updated_at = now()
         WHERE tenant_id = ${record.tenantId}
        RETURNING tenant_id
      `) as ReadonlyArray<{ tenant_id: string }>;

      if (rows.length !== 1) {
        throw new Error(`metering found no control-plane row for tenant '${record.tenantId}'`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Results.
// ---------------------------------------------------------------------------

export type GatewayFailureReason =
  | 'scope_denied'
  | 'invalid_tenant_id'
  | 'op_kind_mismatch'
  | 'key_unavailable'
  | 'model_not_priced'
  | 'usage_unreported'
  | 'price_fault'
  | 'embedding_dimension_mismatch'
  | 'transport_failed'
  | 'budget_exhausted'
  | 'metering_unavailable';

export type GatewayResult =
  | {
      readonly ok: true;
      readonly output: ModelOutput;
      readonly usage: TokenUsage;
      readonly metering: MeteringRecord;
    }
  | {
      readonly ok: false;
      readonly reason: Exclude<
        GatewayFailureReason,
        'transport_failed' | 'budget_exhausted' | 'metering_unavailable'
      >;
    }
  | { readonly ok: false; readonly reason: 'transport_failed'; readonly providerStatus: number | null }
  | {
      readonly ok: false;
      readonly reason: 'budget_exhausted';
      readonly budgetLabel: string;
      readonly capMicroUsd: number;
      readonly spentMicroUsd: number;
      /** Held by calls still in flight. A burst exhausts on this, not on spend,
       * so a diagnosis that reads only `spentMicroUsd` sees a cap fire at zero. */
      readonly reservedMicroUsd: number;
      readonly estimatedMicroUsd: number;
    }
  | { readonly ok: false; readonly reason: 'metering_unavailable'; readonly spentMicroUsd: number };

export interface ModelCall {
  readonly op: ModelOp;
  readonly tenantId: string;
  readonly caller: CallerIdentity;
  readonly budget: Budget;
  readonly input: ModelInput;
  /** R22 tier one. Absent on almost every call. */
  readonly apiKey?: string;
}

export interface ModelGatewayOptions {
  readonly profile: NamedProfile;
  readonly transport: ModelTransport | ((provider: ProviderId) => ModelTransport);
  readonly meter: SpendMeter;
  readonly keys: { readonly store: TenantProviderKeyStore; readonly hosted: HostedKeyPool };
  /** A self-hoster's own cost basis. Add-only; it cannot shadow a canonical price. */
  readonly priceOverlay?: ReadonlyMap<ModelId, ModelPrice>;
  readonly now?: () => number;
  /** Receives every metering record after it is durably recorded. */
  readonly observer?: (record: MeteringRecord) => void;
}

export interface ModelGateway {
  readonly profileName: string;
  call(request: ModelCall): Promise<GatewayResult>;
}

/** Rough, deterministic, and deliberately not a tokenizer: the estimate exists
 * to make a cap fire *early*, and a tokenizer per provider would be a second
 * thing to keep in sync for a number that is compared against a ceiling. */
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function estimateUsage(input: ModelInput, route: Route): TokenUsage {
  switch (input.kind) {
    case 'chat':
      return {
        inputTokens: estimateTokens((input.system ?? '') + input.user),
        // The ceiling, not a guess: an estimate that assumes a short answer is
        // a cap that fires after the money is gone.
        outputTokens: route.maxOutputTokens,
      };
    case 'embedding':
      return {
        inputTokens: input.texts.reduce((total, text) => total + estimateTokens(text), 0),
        outputTokens: 0,
      };
    case 'rerank':
      return {
        inputTokens:
          estimateTokens(input.query) +
          input.candidates.reduce((total, text) => total + estimateTokens(text), 0),
        outputTokens: 0,
      };
  }
}

/**
 * Did the provider tell us it did no work?
 *
 * The question is asked this way round on purpose. "Was it billed?" is
 * unknowable from a status code, so the rule is conservative in the direction
 * that protects money: a call is charged unless the provider said it never ran
 * the model. A 4xx is that statement — a malformed request, a bad credential, a
 * rate limit — with `408` excepted, because a request timeout is work that
 * started. A 5xx, and a failure with no status at all (a socket that died, a
 * fetch that hung, a bug in a transport), are all charged: none of them rules
 * out a provider that accepted the request and metered it.
 *
 * The cost of being wrong is asymmetric and that is the whole argument. Charging
 * for a call that was free stops a phase early. Releasing a call that was billed
 * is an infinite loop with an invoice at the end of it.
 */
function providerRefusedBeforeWorking(status: number | null): boolean {
  return status !== null && status >= 400 && status < 500 && status !== 408;
}

export function createModelGateway(options: ModelGatewayOptions): ModelGateway {
  const { profile, meter, keys, observer } = options;
  const now = options.now ?? Date.now;

  // Everything an operator hands in is validated here, at construction. The
  // module-scope gate in `routing.ts` covers the two shipped profiles; a
  // custom profile or an overlay is *their* startup, and it gets the same
  // treatment rather than failing at the first call of a long phase.
  let priceBook: PriceBook;
  try {
    priceBook =
      options.priceOverlay === undefined ? CANONICAL_PRICE_BOOK : createPriceBook(options.priceOverlay);
  } catch (error) {
    throw new GatewayConfigError(
      `price overlay rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    assertRoutable(profile, priceBook);
  } catch (error) {
    throw new GatewayConfigError(
      `routing profile rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const transportFor =
    typeof options.transport === 'function' ? options.transport : () => options.transport as ModelTransport;

  return {
    profileName: profile.name,

    async call(request: ModelCall): Promise<GatewayResult> {
      const { op, tenantId, caller, budget, input } = request;

      // --- Everything before the transport call is a refusal that costs nothing.

      if (caller.kind !== 'fleet' || caller.tenantId !== tenantId) {
        return { ok: false, reason: 'scope_denied' };
      }
      if (!isValidTenantId(tenantId)) return { ok: false, reason: 'invalid_tenant_id' };

      const route = routeFor(profile, op);
      const kind = OP_KINDS[op];
      if (input.kind !== kind) return { ok: false, reason: 'op_kind_mismatch' };

      const price = priceBook.lookup(route.id);
      if (price === undefined && budget.capMicroUsd !== null) {
        // R14, in one line: a model absent from the pricing table hard-fails
        // when a cap is active. A cap over a cost nobody can compute is not a
        // cap, and finding that out from an invoice is the failure this unit
        // exists to prevent.
        return { ok: false, reason: 'model_not_priced' };
      }

      // The estimate is computed whether or not a cap is active: with no cap it
      // has nothing to refuse, but it is still what an unknowable cost settles
      // at, and a number that only exists when someone is watching is a number
      // that rots.
      const estimated = price === undefined ? 0 : costMicroUsd(estimateUsage(input, route), price);

      // The last synchronous statement before the first `await`. Everything
      // after this point can interleave with another call on the same budget;
      // nothing before it can. That ordering is the cap.
      const reservation = budget.reserve(estimated);
      if (reservation === null) {
        return {
          ok: false,
          reason: 'budget_exhausted',
          budgetLabel: budget.label,
          // Non-null by construction: `reserve` refuses only when a cap exists.
          capMicroUsd: budget.capMicroUsd ?? 0,
          spentMicroUsd: budget.spentMicroUsd(),
          reservedMicroUsd: budget.reservedMicroUsd(),
          estimatedMicroUsd: estimated,
        };
      }

      const key = await resolveProviderKey({
        caller,
        tenantId,
        provider: route.provider,
        ...(request.apiKey === undefined ? {} : { explicitKey: request.apiKey }),
        store: keys.store,
        hosted: keys.hosted,
      });
      if (!key.ok) {
        reservation.release();
        return { ok: false, reason: key.reason === 'scope_denied' ? 'scope_denied' : 'key_unavailable' };
      }

      // --- From here the money is spent whatever happens next, so every exit
      // below closes the reservation rather than dropping it.

      let response: TransportResponse;
      try {
        response = await transportFor(route.provider).invoke({
          modelId: route.id,
          provider: route.provider,
          op,
          kind,
          input,
          apiKey: key.resolved.key,
          maxOutputTokens: route.maxOutputTokens,
          embeddingDimensions: kind === 'embedding' ? EMBEDDING_PIN.dimensions : null,
          metadata: { op, tenantId, profile: profile.name, budgetLabel: budget.label },
        });
      } catch (error) {
        const providerStatus = error instanceof TransportError ? error.status : null;
        // A failed call is not a free call. A 504 arrives *after* the model ran
        // and is billed; releasing its estimate turns a flapping provider into
        // an unbounded retry loop under a live cap, with every individual
        // attempt looking like a well-handled error. So the estimate stands
        // unless the provider told us it did no work — which is what a 4xx
        // says, 408 excepted, since a request timeout is work that started.
        if (providerRefusedBeforeWorking(providerStatus)) reservation.release();
        else reservation.settleAtEstimate();
        // The status, and nothing else. A provider that echoes the request in
        // its error body would otherwise write the user's words into a log.
        return { ok: false, reason: 'transport_failed', providerStatus };
      }

      let outcome: Exclude<
        GatewayFailureReason,
        'transport_failed' | 'budget_exhausted' | 'metering_unavailable'
      > | null = null;
      const usage: TokenUsage = response.usage ?? { inputTokens: 0, outputTokens: 0 };
      let cost: number | null = null;

      if (response.usage === undefined) {
        // A provider that reports nothing is not a provider that charged
        // nothing. Recorded as unknown, refused as a result.
        outcome = 'usage_unreported';
      } else if (price === undefined) {
        // Uncapped and unpriced: the call is allowed, the cost is not invented.
        cost = null;
      } else {
        try {
          cost = costMicroUsd(usage, price);
        } catch (error) {
          if (!(error instanceof PricingFaultError)) throw error;
          outcome = 'price_fault';
          cost = null;
        }
      }

      if (outcome === null && kind === 'embedding' && response.output.kind === 'embedding') {
        const wrong = response.output.vectors.some(
          (vector) => vector.length !== EMBEDDING_PIN.dimensions,
        );
        // KTD8: the width is a property of the column as much as the vector, and
        // a mismatched vector degrades recall with no error anywhere.
        if (wrong) outcome = 'embedding_dimension_mismatch';
      }

      // Rule 2a. A cost we could compute is charged exactly; one we could not is
      // charged at the estimate. The alternative — charging nothing — is what
      // makes `usage_unreported` and `price_fault` repeatable without limit.
      if (cost !== null) reservation.settle(cost);
      else reservation.settleAtEstimate();

      const record: MeteringRecord = {
        tenantId,
        op,
        profile: profile.name,
        modelId: route.id,
        provider: route.provider,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        price: cost === null ? 'unknown' : 'known',
        costMicroUsd: cost,
        keySource: key.resolved.source,
        countsTowardHostedCogs: key.resolved.countsTowardHostedCogs && priceBook.isCanonical(route.id),
        budgetLabel: budget.label,
        atMs: now(),
      };

      try {
        await meter.record(record);
      } catch {
        // Rule 3. The answer goes down with the count — and the error is not
        // re-thrown with its message, which could carry a query fragment.
        return { ok: false, reason: 'metering_unavailable', spentMicroUsd: budget.spentMicroUsd() };
      }

      observer?.(record);

      if (outcome !== null) return { ok: false, reason: outcome };
      return { ok: true, output: response.output, usage, metering: record };
    },
  };
}

// ---------------------------------------------------------------------------
// Transports.
//
// Both speak the OpenAI-compatible wire shape: Cloudflare's unified endpoint,
// Google's compatibility endpoint and every self-hosted server worth the name
// accept it, and one shape means one place to get the usage parsing right.
// The exact paths belong to the vendors and are exercised only under the
// real-substrate workflow; nothing here reads a credential or opens a socket at
// module scope.
// ---------------------------------------------------------------------------

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Cloudflare AI Gateway, per KTD13: the hosted transport, not the abstraction. */
export const CLOUDFLARE_AI_GATEWAY_BASE = 'https://gateway.ai.cloudflare.com/v1';

/** Direct-to-provider bases, for the self-host profile and any operator without
 * a Cloudflare account. `self-host` has no default: it is the operator's own. */
export const PROVIDER_DIRECT_BASES: Readonly<Record<ProviderId, string | null>> = Object.freeze({
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
  openai: 'https://api.openai.com/v1',
  cloudflare: null,
  'self-host': null,
});

/**
 * Paths relative to an OpenAI-compatible root, which is what every base above
 * is. Spelled without the version segment because the vendors disagree about
 * where it sits (`/v1` for OpenAI, `/v1beta/openai` for Google) and the root is
 * the part an operator configures.
 */
const CHAT_PATH = '/chat/completions';
const EMBEDDINGS_PATH = '/embeddings';
const RERANK_PATH = '/rerank';

interface UnknownRecord {
  readonly [key: string]: unknown;
}

function asRecord(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as UnknownRecord) : undefined;
}

function readUsage(body: UnknownRecord): TokenUsage | undefined {
  const usage = asRecord(body['usage']) ?? asRecord(asRecord(body['result'])?.['usage']);
  if (usage === undefined) return undefined;
  const input = usage['prompt_tokens'] ?? usage['input_tokens'];
  const output = usage['completion_tokens'] ?? usage['output_tokens'] ?? 0;
  if (typeof input !== 'number' || typeof output !== 'number') return undefined;
  return { inputTokens: input, outputTokens: output };
}

function buildBody(request: TransportRequest): unknown {
  if (request.input.kind === 'chat') {
    const messages: Array<{ role: string; content: string }> = [];
    if (request.input.system !== undefined) {
      messages.push({ role: 'system', content: request.input.system });
    }
    messages.push({ role: 'user', content: request.input.user });
    return { model: request.modelId, messages, max_tokens: request.maxOutputTokens };
  }
  if (request.input.kind === 'embedding') {
    return {
      model: request.modelId,
      input: request.input.texts,
      // KTD8: truncation is the API's job. Slicing client-side returns a vector
      // that is not unit-length, which changes distance semantics silently.
      dimensions: request.embeddingDimensions,
    };
  }
  return {
    model: request.modelId,
    query: request.input.query,
    contexts: request.input.candidates.map((text) => ({ text })),
  };
}

function parseOutput(request: TransportRequest, body: UnknownRecord): ModelOutput {
  if (request.kind === 'chat') {
    const choices = body['choices'];
    const first = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
    const message = asRecord(first?.['message']);
    const content = message?.['content'];
    return { kind: 'chat', text: typeof content === 'string' ? content : '' };
  }
  if (request.kind === 'embedding') {
    const data = body['data'];
    const vectors = Array.isArray(data)
      ? data.map((entry) => {
          const embedding = asRecord(entry)?.['embedding'];
          return Array.isArray(embedding) ? (embedding as number[]) : [];
        })
      : [];
    return { kind: 'embedding', vectors };
  }
  const result = asRecord(body['result']);
  const ranked = result?.['response'] ?? body['response'];
  const scores = Array.isArray(ranked)
    ? ranked.map((entry) => {
        const score = asRecord(entry)?.['score'];
        return typeof score === 'number' ? score : 0;
      })
    : [];
  return { kind: 'rerank', scores };
}

async function send(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  request: TransportRequest,
): Promise<TransportResponse> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(buildBody(request)),
  });

  if (!response.ok) {
    // The body is deliberately not read: providers echo the request in error
    // payloads, and this message reaches logs.
    throw new TransportError(`provider refused the request`, response.status);
  }

  const body = asRecord(await response.json());
  if (body === undefined) throw new TransportError('provider returned a non-object body', null);

  const usage = readUsage(body);
  const output = parseOutput(request, body);
  return usage === undefined ? { output } : { output, usage };
}

/**
 * Metadata-only headers. `cf-aig-collect-log: false` is the load-bearing one:
 * AI Gateway retains request and response bodies when logging is on, so an
 * unstated default turns the transport itself into a content store sitting
 * outside every erasure leg.
 */
function metadataHeaders(request: TransportRequest): Record<string, string> {
  return {
    'cf-aig-collect-log': 'false',
    'cf-aig-metadata': JSON.stringify({
      op: request.metadata.op,
      tenant: request.metadata.tenantId,
      profile: request.metadata.profile,
      budget: request.metadata.budgetLabel,
      model: request.modelId,
    }),
  };
}

export function createCloudflareGatewayTransport(options: {
  readonly accountId: string;
  readonly gatewayId: string;
  readonly fetchImpl?: FetchLike;
}): ModelTransport {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const base = `${CLOUDFLARE_AI_GATEWAY_BASE}/${options.accountId}/${options.gatewayId}`;

  return {
    id: 'cloudflare-ai-gateway',
    invoke(request) {
      const path =
        request.kind === 'chat'
          ? `/compat${CHAT_PATH}`
          : request.kind === 'embedding'
            ? `/compat${EMBEDDINGS_PATH}`
            : `/workers-ai/${request.modelId}`;
      return send(
        fetchImpl,
        `${base}${path}`,
        { authorization: `Bearer ${request.apiKey}`, ...metadataHeaders(request) },
        request,
      );
    },
  };
}

/**
 * The direct path KTD13 requires regardless: an AGPL self-hoster has no
 * Cloudflare account, and a routing layer that only works on the hosted plane
 * would make the open-source promise nominal.
 */
export function createDirectTransport(options: {
  readonly bases?: Partial<Record<ProviderId, string>>;
  readonly fetchImpl?: FetchLike;
}): ModelTransport {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const overrides = options.bases ?? {};

  return {
    id: 'direct',
    invoke(request) {
      const base = overrides[request.provider] ?? PROVIDER_DIRECT_BASES[request.provider];
      if (base === null || base === undefined) {
        throw new TransportError(`no direct endpoint configured for '${request.provider}'`, null);
      }
      const path =
        request.kind === 'embedding'
          ? EMBEDDINGS_PATH
          : request.kind === 'rerank'
            ? RERANK_PATH
            : CHAT_PATH;
      return send(fetchImpl, `${base}${path}`, { authorization: `Bearer ${request.apiKey}` }, request);
    },
  };
}
