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

/** Id families that name an immutable artifact and so need no date suffix. */
const IMMUTABLE_ID_FAMILIES: readonly string[] = ['@cf/', 'self-host/', 'text-embedding-3-'];

/** What a pinned proprietary id looks like: the alias plus its release date. */
const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const SELF_HOST_PREFIX = 'self-host/';

/** The date this catalog was taken from the vendors' pricing pages. */
const PIN_DATE = '2026-08-12';

const HOSTED_ROUTES: RoutingProfile = {
  extract: {
    op: 'extract',
    alias: 'gemini-3.5-flash-lite',
    id: 'gemini-3.5-flash-lite-2026-07-21',
    provider: 'google',
    pinnedOn: PIN_DATE,
    maxOutputTokens: 4_096,
  },
  enrich: {
    op: 'enrich',
    alias: 'gemini-3.5-flash-lite',
    id: 'gemini-3.5-flash-lite-2026-07-21',
    provider: 'google',
    pinnedOn: PIN_DATE,
    maxOutputTokens: 2_048,
  },
  contradiction: {
    op: 'contradiction',
    alias: 'gemini-3.5-flash-lite',
    id: 'gemini-3.5-flash-lite-2026-07-21',
    provider: 'google',
    pinnedOn: PIN_DATE,
    maxOutputTokens: 1_024,
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
  vision: {
    op: 'vision',
    alias: '@cf/meta/llama-3.2-11b-vision-instruct',
    id: '@cf/meta/llama-3.2-11b-vision-instruct',
    provider: 'cloudflare',
    pinnedOn: PIN_DATE,
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
  extract: HOSTED_ROUTES.extract,
  enrich: HOSTED_ROUTES.enrich,
  contradiction: HOSTED_ROUTES.contradiction,
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

    if (!route.id.startsWith(route.alias)) {
      faults.push(
        `${label(op)}: id '${route.id}' is not a specialization of alias '${route.alias}'`,
      );
    } else if (!IMMUTABLE_ID_FAMILIES.some((family) => route.id.startsWith(family))) {
      if (!DATED_SNAPSHOT.test(route.id)) {
        faults.push(
          `${label(op)}: '${route.id}' is a moving alias — pin a dated snapshot, or every eval receipt is unfalsifiable`,
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
