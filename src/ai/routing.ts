/**
 * Routing by **op**, never by caller (KTD13).
 *
 * A caller asks for `op: 'extract'`. It never asks for a model, does not know
 * which vendor answers, and cannot pick one. Two things follow, and they are
 * the whole reason this is a module rather than a constant:
 *
 *  - **Retuning a phase is a config change.** Moving extraction to a different
 *    model is a row in this table, not an edit at nine call sites, so no call
 *    site can drift away from the others.
 *  - **An op with no entry fails at STARTUP.** The validator below runs at
 *    module scope. A consolidation cycle must not run for twenty minutes and
 *    then discover that `judge` resolves to nothing, and a request-path op must
 *    not discover it under a user.
 *
 * **Model identity is pinned, not aliased.** The names KTD13 prints are moving
 * aliases — `gemini-3.5-flash-lite` succeeded a predecessor weeks before this
 * was written — so what goes on the wire is a *dated snapshot*. Without that,
 * every committed eval receipt (the calibration baseline, the model-tier A/B,
 * the embedding A/B) can be invalidated by a vendor with no signal at all, and
 * KTD13's diagnostic property — "a floor miss indicts the architecture, not the
 * model tier" — becomes unenforceable. Advancing a pin is a deliberate ledger
 * action, exactly like `upstream/gbrain.pin`.
 *
 * Some ids are their own pin. `@cf/…` and `self-host/…` name a specific open
 * weights release, and `text-embedding-3-large` is itself a snapshot; demanding
 * a date suffix there would fail startup on a correct entry. So the rule is by
 * *family*, named in {@link IMMUTABLE_ID_FAMILIES}, and everything outside those
 * families must carry a date.
 *
 * **Two profiles, not two implementations** (approach step 5a). Five of the
 * nine rows are Cloudflare-hosted open weights, and there is no "direct
 * provider" for a `@cf/` id — a single-profile gateway would resolve four of
 * nine ops for an AGPL self-hoster, and the open-source promise would be
 * nominal. The `self-host` profile remaps exactly those five to a non-Cloudflare
 * endpoint serving the same weights. Google and OpenAI rows are unchanged,
 * because both are reachable directly by anyone.
 *
 * **A self-host row may never carry the `@cf/` id.** Price is a property of
 * (weights, who serves them). Reusing the Cloudflare id would resolve
 * Cloudflare's neuron price for hardware Cloudflare does not own — a silently
 * wrong number, which is the same defect class as an unmetered call. The
 * validator refuses it.
 */

import { ACTIVE_EMBEDDING_SEAT, seatById, type EmbeddingSeat } from '../schema/embedding-seat.ts';
import { EMBEDDING_DIMENSIONS } from '../schema/vector-index.ts';
import { CANONICAL_PRICE_BOOK, billsOutput, type PriceBook } from './pricing.ts';

/** KTD13's nine rows, as ops. Declared independently of any table, so that a
 * table missing one of them is a fault rather than a narrower type. */
export const MODEL_OPS = [
  'extract',
  'enrich',
  'contradiction',
  'salience',
  'synopsis',
  'vision',
  'judge',
  'rerank',
  'embedding',
] as const;

export type ModelOp = (typeof MODEL_OPS)[number];

/** The shape of call an op makes. The gateway refuses a mismatched input. */
export type OpKind = 'chat' | 'rerank' | 'embedding';

export const OP_KINDS: Readonly<Record<ModelOp, OpKind>> = Object.freeze({
  extract: 'chat',
  enrich: 'chat',
  contradiction: 'chat',
  salience: 'chat',
  synopsis: 'chat',
  vision: 'chat',
  judge: 'chat',
  rerank: 'rerank',
  embedding: 'embedding',
});

/**
 * Which ops may be handed a picture (U21).
 *
 * `vision` is KTD13's "Image / PDF → text" row — the op the plan's prose calls
 * `image_to_text` — and it is the only seat in the table pointed at a
 * vision-language model. The rest are text models, and a text model handed a
 * prompt whose image it never received does not fail: it answers *something*,
 * priced, metered and plausible. So the refusal is a table, alongside
 * {@link OP_KINDS}, rather than a check each call site could forget.
 *
 * Declared as a total record so a tenth op cannot be added without deciding.
 */
export const OP_ACCEPTS_IMAGES: Readonly<Record<ModelOp, boolean>> = Object.freeze({
  extract: false,
  enrich: false,
  contradiction: false,
  salience: false,
  synopsis: false,
  vision: true,
  judge: false,
  rerank: false,
  embedding: false,
});

/**
 * Which ops have an answer that may legitimately be empty.
 *
 * For eight of the nine, an empty answer is never information: a judge that
 * grades nothing, an extractor that extracts nothing and a synopsis of nothing
 * are all failures wearing the costume of a result, and the gateway refuses
 * them (`empty_output`) rather than handing back an empty string that reads as
 * a successful answer one layer up.
 *
 * `vision` is the exception, and it is an exception because a *protocol* says
 * so: the transcription prompt in `core/media/ocr-phase.ts` instructs the model
 * to "return an empty response" when an image contains no legible text, and a
 * photograph of a cat has no text in it. Refusing that answer would leave every
 * text-free attachment queued and re-sent on every cycle for the life of the
 * brain — the exact standing charge U21 recorded an empty `ocr_text` to stop.
 *
 * The exemption is narrow on purpose. It does NOT cover a vision model that
 * returned a reasoning trace and no answer — a model that thought and then said
 * nothing has not told you the image is blank — and it does not cover a model
 * that reported no usage at all, which is `usage_unreported` and is what the
 * seat returns today. It covers exactly one thing: a model that ran, billed,
 * and deliberately said "nothing here".
 *
 * A total record so a tenth op cannot be added without deciding which it is.
 */
export const OP_ADMITS_EMPTY_ANSWER: Readonly<Record<ModelOp, boolean>> = Object.freeze({
  extract: false,
  enrich: false,
  contradiction: false,
  salience: false,
  synopsis: false,
  vision: true,
  judge: false,
  rerank: false,
  embedding: false,
});

/**
 * What one image costs in input tokens, for the pre-call estimate.
 *
 * **This is an assumption, not a measurement**, and it is written down here so
 * it has one home rather than one per caller: the gateway reserves against it
 * and U11's cycle estimate budgets against it. The number is the vision seat's
 * per-tile encoding for a single-tile image — a screenshot, which is what U21
 * says the dominant payload is — rounded to a flat figure.
 *
 * Being wrong is survivable in one direction only, which is why it is not zero
 * and not small. The gateway's first rule is that the estimate leaves the budget
 * *before* the provider is called; its estimator counts characters, and an image
 * carries almost none. Reserving nothing for a picture is a cap that fires after
 * the money is gone. Metering reconciles to the provider's own count afterwards,
 * so this figure bounds the reservation and never the bill —
 * `docs/research/2026-08-13-ocr-phase-cost.md` states the assumption and what
 * would settle it.
 */
export const IMAGE_INPUT_TOKENS = 1_600;

/**
 * Who serves the model. `cloudflare` is the hosted plane; `google` and `openai`
 * are the two content-touching third parties KTD13 admits, each with a register
 * entry; `self-host` is the operator's own endpoint.
 */
export const PROVIDER_IDS = ['cloudflare', 'google', 'openai', 'self-host'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface Route {
  readonly op: ModelOp;
  /** The moving name KTD13's table prints. Never sent on the wire. */
  readonly alias: string;
  /** The pinned id that is sent. Always a specialization of {@link alias}. */
  readonly id: string;
  readonly provider: ProviderId;
  /** When this pin was taken. Advancing it is a deliberate ledger action. */
  readonly pinnedOn: string;
  /**
   * Declared only on a row whose id **cannot** carry a date, with the reason.
   *
   * The pin rule above assumes every proprietary model has a dated snapshot to
   * pin. One does not: Cloudflare's Unified Billing catalog exposes
   * `google/gemini-3.5-flash-lite` and nothing else — the dated id KTD13 pinned
   * resolves nowhere on that endpoint, and `google-ai-studio/` and `google-ai/`
   * are 404s. So the choice is between a rule that cannot be satisfied and a
   * rule with a hole in it.
   *
   * This is the hole, made narrow and loud. It is *not* a new entry in
   * {@link IMMUTABLE_ID_FAMILIES}: adding `google/` there would state that the
   * id names an immutable artifact, which is false, and would silently exempt
   * every future `google/`-prefixed id anybody adds. A per-row declaration
   * exempts exactly one row, carries the reason in the source, and is itself
   * checked — declaring it on a row that *could* have been pinned is a fault,
   * so it cannot quietly become the way new rows are added.
   */
  readonly unpinnable?: { readonly why: string };
  /**
   * The output ceiling a chat op is called with, and the basis of the
   * pre-call cost estimate — a cap that estimates optimistically is a cap that
   * fires after the money is gone. Zero for input-only ops.
   */
  readonly maxOutputTokens: number;
}

export type RoutingProfile = Readonly<Record<ModelOp, Route>>;

export interface NamedProfile {
  readonly name: string;
  readonly routes: RoutingProfile;
}

export class RoutingTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingTableError';
  }
}

/**
 * KTD8's embedding pin, kept here so the one thing that must never drift —
 * the width of the vector and the width of the column — has a single source.
 * The dimension is imported from the schema rather than restated.
 *
 * Truncation goes through the API's `dimensions` parameter and never through
 * client-side slicing: the parameter re-normalizes the returned vector, and a
 * hand-sliced vector is not unit-length, which silently changes distance
 * semantics under inner-product operators and degrades recall with no error.
 */
export const EMBEDDING_PIN = Object.freeze({
  dimensions: EMBEDDING_DIMENSIONS,
  /** Query and document are encoded differently; they share one space. */
  encoding: 'asymmetric' as const,
});

/**
 * Which stored embedding space each embedding model's vectors belong to.
 *
 * **This table is here and not in `src/schema/` because of KTD13's boundary.**
 * `test/ai/boundary.test.ts` fails any file outside this directory that names a
 * model id — a caller that can name a model is a caller that can pick one — so
 * the seats themselves (a column, a width, the rung that created them) live in
 * `src/schema/embedding-seat.ts` and the binding lives here, in the one file
 * whose job is model identity.
 *
 * **A model absent from this table cannot be routed to the `embedding` op**, and
 * {@link findRoutingFaults} refuses the profile at construction rather than at
 * first call. That is the same discipline as the unpriced-model rule beside it:
 * a vector with no seat has no column to be written to and no column to be read
 * from, so a call producing one is a call that is paid for and cannot be used.
 */
const EMBEDDING_SEAT_BY_MODEL: Readonly<Record<string, string>> = Object.freeze({
  'text-embedding-3-large': 'openai-3-large-1536',
  '@cf/qwen/qwen3-embedding-0.6b': 'cf-qwen3-embedding-0.6b-1024',
});

/**
 * The stored space a routed embedding model's vectors live in, or `undefined`.
 *
 * The read path calls this with the id the gateway **reported having called**,
 * not with a routed id it looked up itself: an operator supplies the profile, so
 * those are two different claims and only the first one is a record of what
 * happened.
 */
export function embeddingSeatFor(modelId: string | null | undefined): EmbeddingSeat | undefined {
  if (typeof modelId !== 'string') return undefined;
  const registered = seatById(EMBEDDING_SEAT_BY_MODEL[modelId]);
  if (registered !== undefined) return registered;

  // **An operator's own endpoint, which no shipped table can enumerate.** A
  // `self-host/` id is the operator's own name for their own weights, so
  // requiring it in the table above would forbid the case the whole self-host
  // profile exists for. It resolves to the seat their tenants were provisioned
  // at, because that is the only column their fleet has — and the width check
  // in the gateway still holds their model to that column's width, which is the
  // failure that would otherwise reach the database.
  //
  // The residual, stated rather than hidden: two *different* operator models
  // both resolve here, so swapping one for the other is not caught by this
  // function. It is caught by nothing else either — the remedy is to register
  // the second one as its own seat, which is an edit an AGPL self-hoster can
  // make and a hosted user cannot need.
  if (modelId.startsWith(SELF_HOST_PREFIX)) return ACTIVE_EMBEDDING_SEAT;
  return undefined;
}

/** Id families that name an immutable artifact and so need no date suffix. */
const IMMUTABLE_ID_FAMILIES: readonly string[] = ['@cf/', 'self-host/', 'text-embedding-3-'];

/** What a pinned proprietary id looks like: the alias plus its release date. */
const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const SELF_HOST_PREFIX = 'self-host/';

/** The date this catalog was taken from the vendors' pricing pages. */
const PIN_DATE = '2026-08-12';

/** The date every seat below was confirmed with a real call to the account. */
const CLOUDFLARE_PIN_DATE = '2026-08-16';

/** The one declaration, written once so the three rows that share it agree. */
const UNPINNABLE_UNIFIED_GEMINI = Object.freeze({
  why:
    "Cloudflare's Unified Billing catalog exposes only the undated alias; the dated " +
    'snapshot KTD13 pinned resolves nowhere on that endpoint, and google-ai-studio/ ' +
    'and google-ai/ are both 404. The self-host profile keeps the dated id, so the ' +
    'pin discipline still holds everywhere it can be held.',
});

/**
 * The Google rows as they are reached **directly**, which is what an operator
 * without a Cloudflare account does. Named separately rather than shared by
 * reference with the hosted table: these two profiles used to point at the same
 * three objects, so editing the hosted rows in place silently moved self-host
 * onto Cloudflare too — and the open-source promise would have been broken by a
 * change that read as touching one profile.
 */
const GOOGLE_DIRECT_ROUTES = {
  extract: Object.freeze({
    op: 'extract',
    alias: 'gemini-3.5-flash-lite',
    id: 'gemini-3.5-flash-lite-2026-07-21',
    provider: 'google',
    pinnedOn: PIN_DATE,
    maxOutputTokens: 4_096,
  }),
  enrich: Object.freeze({
    op: 'enrich',
    alias: 'gemini-3.5-flash-lite',
    id: 'gemini-3.5-flash-lite-2026-07-21',
    provider: 'google',
    pinnedOn: PIN_DATE,
    maxOutputTokens: 2_048,
  }),
  contradiction: Object.freeze({
    op: 'contradiction',
    alias: 'gemini-3.5-flash-lite',
    id: 'gemini-3.5-flash-lite-2026-07-21',
    provider: 'google',
    pinnedOn: PIN_DATE,
    maxOutputTokens: 1_024,
  }),
} as const satisfies Record<'extract' | 'enrich' | 'contradiction', Route>;

/**
 * The hosted plane, on one Cloudflare credential.
 *
 * Eight of the nine seats resolve through `…/accounts/{id}/ai`: five are `@cf/`
 * open weights Cloudflare serves itself, three are Google's model reached over
 * Unified Billing, where Cloudflare holds the provider relationship and passes
 * inference through at no markup. One credential, no per-provider keys, one
 * invoice.
 *
 * **The ninth is `embedding`, and it deliberately did not move.** The
 * Cloudflare embedding seat returns 1024 dimensions, the stored column is 1536,
 * and the `dimensions` parameter is ignored — so the move is a schema rung plus
 * a re-encode of every chunk in every brain, not a row in this table. Two
 * vectors of the same width from different models are still not points in the
 * same space, so even a width-compatible swap would silently destroy recall on
 * everything already indexed. `upstream/concepts.jsonl:gap.cloudflare-embedding-seat`
 * carries what would close it; the price is already in the canonical table.
 */
const HOSTED_ROUTES: RoutingProfile = {
  extract: {
    op: 'extract',
    alias: 'google/gemini-3.5-flash-lite',
    id: 'google/gemini-3.5-flash-lite',
    provider: 'cloudflare',
    pinnedOn: CLOUDFLARE_PIN_DATE,
    maxOutputTokens: 4_096,
    unpinnable: UNPINNABLE_UNIFIED_GEMINI,
  },
  enrich: {
    op: 'enrich',
    alias: 'google/gemini-3.5-flash-lite',
    id: 'google/gemini-3.5-flash-lite',
    provider: 'cloudflare',
    pinnedOn: CLOUDFLARE_PIN_DATE,
    maxOutputTokens: 2_048,
    unpinnable: UNPINNABLE_UNIFIED_GEMINI,
  },
  contradiction: {
    op: 'contradiction',
    alias: 'google/gemini-3.5-flash-lite',
    id: 'google/gemini-3.5-flash-lite',
    provider: 'cloudflare',
    pinnedOn: CLOUDFLARE_PIN_DATE,
    maxOutputTokens: 1_024,
    unpinnable: UNPINNABLE_UNIFIED_GEMINI,
  },
  salience: {
    op: 'salience',
    alias: '@cf/nvidia/nemotron-3-120b-a12b',
    id: '@cf/nvidia/nemotron-3-120b-a12b',
    provider: 'cloudflare',
    pinnedOn: PIN_DATE,
    maxOutputTokens: 1_024,
  },
  synopsis: {
    op: 'synopsis',
    alias: '@cf/nvidia/nemotron-3-120b-a12b',
    id: '@cf/nvidia/nemotron-3-120b-a12b',
    provider: 'cloudflare',
    pinnedOn: PIN_DATE,
    maxOutputTokens: 512,
  },
  /**
   * The screenshot specialist, in place of Cloudflare's hosted llama-3.2-vision.
   *
   * The swap is a licence decision before it is a quality one: the llama seat
   * requires submitting the prompt 'agree' to Meta's licence and representing
   * non-EU domicile, which is not a condition a hosted plane can accept on its
   * users' behalf. `oos.moondream-screenshot-specialist` declined moondream
   * only because it had no published price; it now has one, verified against
   * the account's own catalog and entered in `pricing.ts`.
   *
   * What this seat does **not** yet have is a working answer — see the ledger
   * row `imp.vision-seat-empty-result`. It is routed here rather than left on a
   * licence-gated model because an empty result is a typed failure that leaves
   * the attachment queued, and a licence violation is neither typed nor
   * recoverable.
   */
  vision: {
    op: 'vision',
    alias: '@cf/moondream/moondream3.1-9B-A2B',
    id: '@cf/moondream/moondream3.1-9B-A2B',
    provider: 'cloudflare',
    pinnedOn: CLOUDFLARE_PIN_DATE,
    maxOutputTokens: 4_096,
  },
  judge: {
    op: 'judge',
    alias: '@cf/zai-org/glm-5.2',
    id: '@cf/zai-org/glm-5.2',
    provider: 'cloudflare',
    pinnedOn: PIN_DATE,
    maxOutputTokens: 2_048,
  },
  rerank: {
    op: 'rerank',
    alias: '@cf/baai/bge-reranker-base',
    id: '@cf/baai/bge-reranker-base',
    provider: 'cloudflare',
    pinnedOn: PIN_DATE,
    maxOutputTokens: 0,
  },
  embedding: {
    op: 'embedding',
    alias: 'text-embedding-3-large',
    id: 'text-embedding-3-large',
    provider: 'openai',
    pinnedOn: PIN_DATE,
    maxOutputTokens: 0,
  },
};

/**
 * The same nine ops with every Cloudflare-hosted row served from the operator's
 * own endpoint. The ids are deliberately *not* the `@cf/` ones: the weights are
 * the same, the cost basis is not, and the canonical table must not answer for
 * hardware it does not bill.
 */
const SELF_HOST_ROUTES: RoutingProfile = {
  // The direct rows, NOT the hosted ones. `google/gemini-3.5-flash-lite` is a
  // Cloudflare catalog id; sent to Google's own endpoint it names nothing.
  extract: GOOGLE_DIRECT_ROUTES.extract,
  enrich: GOOGLE_DIRECT_ROUTES.enrich,
  contradiction: GOOGLE_DIRECT_ROUTES.contradiction,
  salience: {
    op: 'salience',
    alias: 'self-host/nemotron-3-120b-a12b',
    id: 'self-host/nemotron-3-120b-a12b',
    provider: 'self-host',
    pinnedOn: PIN_DATE,
    maxOutputTokens: 1_024,
  },
  synopsis: {
    op: 'synopsis',
    alias: 'self-host/nemotron-3-120b-a12b',
    id: 'self-host/nemotron-3-120b-a12b',
    provider: 'self-host',
    pinnedOn: PIN_DATE,
    maxOutputTokens: 512,
  },
  vision: {
    op: 'vision',
    alias: 'self-host/llama-3.2-11b-vision-instruct',
    id: 'self-host/llama-3.2-11b-vision-instruct',
    provider: 'self-host',
    pinnedOn: PIN_DATE,
    maxOutputTokens: 4_096,
  },
  judge: {
    op: 'judge',
    alias: 'self-host/glm-5.2',
    id: 'self-host/glm-5.2',
    provider: 'self-host',
    pinnedOn: PIN_DATE,
    maxOutputTokens: 2_048,
  },
  rerank: {
    op: 'rerank',
    alias: 'self-host/bge-reranker-base',
    id: 'self-host/bge-reranker-base',
    provider: 'self-host',
    pinnedOn: PIN_DATE,
    maxOutputTokens: 0,
  },
  embedding: HOSTED_ROUTES.embedding,
};

export const HOSTED_PROFILE: NamedProfile = Object.freeze({
  name: 'hosted',
  routes: HOSTED_ROUTES,
});

export const SELF_HOST_PROFILE: NamedProfile = Object.freeze({
  name: 'self-host',
  routes: SELF_HOST_ROUTES,
});

export type RoutingProfileName = 'hosted' | 'self-host';

export const PROFILES: Readonly<Record<RoutingProfileName, NamedProfile>> = Object.freeze({
  hosted: HOSTED_PROFILE,
  'self-host': SELF_HOST_PROFILE,
});

/**
 * Every reason a profile is not safe to serve, as strings. Returned rather than
 * thrown so that a caller validating an operator-supplied profile can report
 * all of them at once — an operator who fixes one fault per restart gives up.
 *
 * The checks deliberately do not trust the types. `RoutingProfile` says every
 * op is present; a hand-written object, a JSON config or a table with a
 * mistyped key says otherwise at runtime, and that is precisely the case this
 * function exists for.
 */
export function findRoutingFaults(profile: NamedProfile, priceBook: PriceBook): string[] {
  const faults: string[] = [];
  const routes = profile.routes as Readonly<Record<string, Route | undefined>>;
  const label = (op: string): string => `${profile.name}/${op}`;

  for (const key of Object.keys(routes)) {
    if (!(MODEL_OPS as readonly string[]).includes(key)) {
      faults.push(`${label(key)}: not one of the nine ops KTD13 names`);
    }
  }

  for (const op of MODEL_OPS) {
    const route = routes[op];
    if (route === undefined) {
      faults.push(`${label(op)}: no routing entry — an op with no route must fail at startup`);
      continue;
    }
    if (route.op !== op) {
      faults.push(`${label(op)}: entry is filed under '${op}' but declares op '${route.op}'`);
    }

    if (!ISO_DATE.test(route.pinnedOn)) {
      faults.push(`${label(op)}: pinnedOn '${route.pinnedOn}' is not an ISO date`);
    }

    // Whether this id can carry a pin at all: an immutable-artifact family
    // needs no date, and anything else is pinnable by taking a dated snapshot.
    const immutableFamily = IMMUTABLE_ID_FAMILIES.some((family) => route.id.startsWith(family));
    const pinnable = immutableFamily || DATED_SNAPSHOT.test(route.id);

    if (!route.id.startsWith(route.alias)) {
      faults.push(
        `${label(op)}: id '${route.id}' is not a specialization of alias '${route.alias}'`,
      );
    } else if (!pinnable && route.unpinnable === undefined) {
      faults.push(
        `${label(op)}: '${route.id}' is a moving alias — pin a dated snapshot, or every eval receipt is unfalsifiable`,
      );
    }

    if (route.unpinnable !== undefined) {
      // Both halves matter. Without the first, the field is a blanket exemption
      // and the pin rule is over the day someone reaches for it out of
      // convenience; without the second, the exemption is undocumented, which
      // is the state the whole ledger discipline exists to forbid.
      if (pinnable) {
        faults.push(
          `${label(op)}: '${route.id}' declares itself unpinnable but a pin is available for it — the declaration is for ids that cannot carry one, not for rows nobody scored`,
        );
      }
      if (route.unpinnable.why.trim().length === 0) {
        faults.push(
          `${label(op)}: an unpinnable declaration needs a reason naming what makes the id unpinnable`,
        );
      }
    }

    if (route.provider === 'self-host') {
      if (!route.id.startsWith(SELF_HOST_PREFIX)) {
        faults.push(`${label(op)}: a self-host route must carry a '${SELF_HOST_PREFIX}' id`);
      }
      if (priceBook.isCanonical(route.id)) {
        faults.push(
          `${label(op)}: a self-host route carries the canonical id '${route.id}' — price is a property of who serves the weights`,
        );
      }
    } else if (!priceBook.isCanonical(route.id)) {
      faults.push(
        `${label(op)}: '${route.id}' has no canonical price — a billed model is priced at startup, not at first call`,
      );
    }

    const kind = OP_KINDS[op];
    if (kind === 'embedding' && embeddingSeatFor(route.id) === undefined) {
      // Refused at construction, not at first call: a vector with no registered
      // seat has no column to be written to and no column to be read from, so
      // the call is paid for and unusable. Same failure shape as an unpriced
      // model, and refused in the same breath for the same reason.
      faults.push(
        `${label(op)}: '${route.id}' has no registered embedding seat — its vectors would have no column to live in, and a read would have nothing to compare a query against`,
      );
    }
    if (kind === 'chat' && route.maxOutputTokens <= 0) {
      faults.push(`${label(op)}: a chat op needs a positive maxOutputTokens to estimate against`);
    }
    if (kind !== 'chat' && route.maxOutputTokens !== 0) {
      faults.push(`${label(op)}: a ${kind} op writes no tokens, so maxOutputTokens must be zero`);
    }

    const price = priceBook.lookup(route.id);
    if (price !== undefined) {
      if (kind === 'chat' && !billsOutput(price)) {
        faults.push(`${label(op)}: a chat op is priced input-only — its output would bill at zero`);
      }
      if (kind !== 'chat' && billsOutput(price)) {
        faults.push(`${label(op)}: a ${kind} op is priced as if it wrote tokens`);
      }
    }
  }

  return faults;
}

/** {@link findRoutingFaults}, as the startup gate. */
export function assertRoutable(profile: NamedProfile, priceBook: PriceBook): void {
  const faults = findRoutingFaults(profile, priceBook);
  if (faults.length > 0) {
    throw new RoutingTableError(
      `routing profile '${profile.name}' is not servable:\n  ${faults.join('\n  ')}`,
    );
  }
}

export function routeFor(profile: NamedProfile, op: ModelOp): Route {
  const route = (profile.routes as Readonly<Record<string, Route | undefined>>)[op];
  if (route === undefined) {
    throw new RoutingTableError(`routing profile '${profile.name}' has no entry for op '${op}'`);
  }
  return route;
}

// The startup gate, at module scope and not in a function anyone can forget to
// call: importing this module is what proves the shipped profiles are servable.
for (const profile of Object.values(PROFILES)) {
  assertRoutable(profile, CANONICAL_PRICE_BOOK);
}
