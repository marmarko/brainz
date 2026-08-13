/**
 * R21 — the response envelope, and the rules that stop it becoming a hidden
 * API.
 *
 * **Why the envelope is the growth channel.** Of the three ways a capability can
 * grow — a new tool name, a new request parameter, a new response field — only
 * the third is free on every target client. A new tool costs prompt tokens on
 * every request and an entry in the model's selection space; a new *optional
 * parameter* is free on Claude and not free on ChatGPT Work, where a definition
 * change means an admin re-scan. Responses are not part of the definition an
 * admin approves. So the operating rule is: put growth in responses, batch
 * request-schema changes into dated releases.
 *
 * **Which is exactly why it needs rules.** An unbounded response side-channel
 * becomes an undocumented API that models learn and clients depend on. Three,
 * each enforced below:
 *
 *   1. **Closed key set, additive forever.** A key never disappears and never
 *      changes meaning or type. {@link ENVELOPE_KEYS} is the list; the test
 *      pins the current names as a floor, so adding is legal and removing is
 *      not.
 *   2. **Bounded lanes.** `notice` ≤ 2, `next` ≤ 3. The server is speaking into
 *      a model's context on every call; an unbounded advisory list is a prompt
 *      the server did not mean to write.
 *   3. **Request-independence and referential integrity.** A field must be true
 *      independent of the request — if it needs `include_foo: true` it belongs
 *      in an output schema, not here — and every `next[].tool` must be
 *      advertised *on that endpoint* with every `args` key in that tool's own
 *      schema. Otherwise the discovery channel teaches models to call things
 *      that come back `unknown_tool`.
 *
 * **`search_degraded` is defined here because this unit owns the envelope.** A
 * tenant with nothing indexed yet is the ordinary state throughout a first
 * import, and an empty success is the answer that makes a user believe their
 * brain is broken. U8 references this state; defined anywhere else, two units
 * would each invent one and disagree.
 */

import { advertisedTools, toolByName, type Endpoint } from './tools/index.ts';

/** The MCP revision this surface speaks. Sessions were retired in it. */
export const PROTOCOL_VERSION = '2026-07-28';

/**
 * The model-facing keys. Frozen: additive forever.
 *
 * `degraded` — why this read was partial, as a named shape (never a bare bool).
 * `notice`   — at most two short lines worth relaying to the user.
 * `next`     — at most three concrete follow-up calls.
 * `setup`    — something the user could connect to make the brain more useful.
 */
export const ENVELOPE_KEYS = ['protocol_version', 'degraded', 'notice', 'next', 'setup'] as const;

/**
 * The client-facing keys, carried in `_meta` rather than in the model's view.
 *
 * `brainz.app/brain` is the isolation attestation stamped on every response —
 * a property of the connection rather than a claim the caller must remember to
 * ask for. It is invisible to the model, which is why the `brain` tool exists
 * as its model-reachable rendering.
 */
export const META_KEYS = ['brainz.app/brain', 'brainz.app/setup_url'] as const;

export const MAX_NOTICE = 2;
export const MAX_NEXT = 3;

export interface NextCall {
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly why: string;
}

/** What a caller can be told to connect. Request-independent by construction. */
export interface SetupHint {
  readonly kind: 'connect_source' | 'first_memory' | 'import';
  readonly detail: string;
  readonly url?: string;
}

export const DEGRADED_KINDS = ['search_degraded', 'briefing_degraded'] as const;
export type DegradedKind = (typeof DEGRADED_KINDS)[number];

/**
 * Why a read was partial. Additive forever, same rule as the keys.
 *
 * `embedding_unavailable` is U5's own degradation, carried through rather than
 * renamed: the vector arm dropped out and RRF fused what was left.
 */
export const DEGRADED_REASONS = [
  'no_content_yet',
  'import_in_progress',
  'embedding_backlog',
  'embedding_unavailable',
  /**
   * The second external dependency on the read path, from U12 (KTD4).
   *
   * A cross-encoder that could not be reached drops stages 12 and 13 — autocut
   * reads the rerank score and only the rerank score, so it goes with it — and
   * the results come back fused-and-boosted but not re-scored. Named separately
   * from `embedding_unavailable` because they degrade *different* things: one
   * costs an arm's recall, the other costs the ordering of what recall found.
   */
  'rerank_unavailable',
  'consolidation_pending',
] as const;

export type DegradedReason = (typeof DEGRADED_REASONS)[number];

export interface Degraded {
  readonly kind: DegradedKind;
  readonly reasons: readonly DegradedReason[];
  /** One content-free sentence: counts and state names, never a user's words. */
  readonly detail: string;
}

export interface Envelope {
  readonly protocol_version: string;
  readonly degraded?: Degraded;
  readonly notice?: readonly string[];
  readonly next?: readonly NextCall[];
  readonly setup?: SetupHint;
}

export interface EnvelopeInput {
  readonly endpoint: Endpoint;
  readonly degraded?: Degraded | null;
  readonly notice?: readonly string[];
  readonly next?: readonly NextCall[];
  readonly setup?: SetupHint | null;
}

/**
 * Build one, truncating the bounded lanes rather than emitting an over-long
 * one.
 *
 * Truncation rather than a throw: an advisory lane overflowing is a caller bug
 * that must not turn a successful read into an error, and the violation checker
 * below is what makes it visible in tests.
 */
export function buildEnvelope(input: EnvelopeInput): Envelope {
  const notice = (input.notice ?? []).slice(0, MAX_NOTICE);
  const next = (input.next ?? []).slice(0, MAX_NEXT);
  return {
    protocol_version: PROTOCOL_VERSION,
    ...(input.degraded == null ? {} : { degraded: input.degraded }),
    ...(notice.length > 0 ? { notice } : {}),
    ...(next.length > 0 ? { next } : {}),
    ...(input.setup == null ? {} : { setup: input.setup }),
  };
}

/**
 * Everything wrong with an envelope, as findings rather than as a throw.
 *
 * Used by the tests and by `dispatch.ts` in a development assertion. The
 * referential half is the one worth having: a `next` naming a tool the endpoint
 * does not advertise is a discovery channel teaching models to fail.
 */
export function envelopeViolations(envelope: Envelope, endpoint: Endpoint): string[] {
  const findings: string[] = [];

  for (const key of Object.keys(envelope)) {
    if (!(ENVELOPE_KEYS as readonly string[]).includes(key)) {
      findings.push(`envelope key outside the closed set: ${JSON.stringify(key)}`);
    }
  }

  if (envelope.protocol_version !== PROTOCOL_VERSION) {
    findings.push(`protocol_version is ${JSON.stringify(envelope.protocol_version)}`);
  }

  if ((envelope.notice?.length ?? 0) > MAX_NOTICE) {
    findings.push(`notice carries ${envelope.notice?.length} entries, over the ${MAX_NOTICE} ceiling`);
  }

  if ((envelope.next?.length ?? 0) > MAX_NEXT) {
    findings.push(`next carries ${envelope.next?.length} entries, over the ${MAX_NEXT} ceiling`);
  }

  const advertised = new Set(advertisedTools(endpoint).map((tool) => tool.name));
  for (const suggestion of envelope.next ?? []) {
    if (!advertised.has(suggestion.tool as never)) {
      findings.push(
        `next suggests ${JSON.stringify(suggestion.tool)}, which is not advertised on /${endpoint}`,
      );
      continue;
    }
    const def = toolByName(suggestion.tool);
    for (const arg of Object.keys(suggestion.args)) {
      if (def !== undefined && !(arg in def.params)) {
        findings.push(
          `next suggests ${suggestion.tool} with ${JSON.stringify(arg)}, which is not in its schema`,
        );
      }
    }
  }

  for (const reason of envelope.degraded?.reasons ?? []) {
    if (!(DEGRADED_REASONS as readonly string[]).includes(reason)) {
      findings.push(`degraded reason outside the closed set: ${JSON.stringify(reason)}`);
    }
  }

  return findings;
}

/** What the tenant's substrate currently holds. Counts only — content-free. */
export interface IndexState {
  readonly pages: number;
  readonly chunks: number;
  readonly chunksPendingEmbedding: number;
  readonly importInProgress: boolean;
}

/**
 * The `search_degraded` shape, or `null` when the read was whole.
 *
 * Three states produce it, and naming them separately is the point — "no
 * results" and "your mail is still importing" are the same empty list to a
 * caller and completely different sentences to a user:
 *
 *   * nothing indexed at all — a brand-new tenant before its first write;
 *   * an import in flight — U9's bounded first-import window;
 *   * an embedding backlog — chunks written but not yet vectorised, so the
 *     vector arm is answering over part of the corpus;
 *   * and, carried through from the read itself, a vector arm that could not
 *     run because the provider refused.
 */
export function degradedSearch(
  state: IndexState,
  readDegradations: readonly string[] = [],
): Degraded | null {
  const reasons: DegradedReason[] = [];

  if (state.pages === 0 && state.chunks === 0) reasons.push('no_content_yet');
  if (state.importInProgress) reasons.push('import_in_progress');
  if (state.chunksPendingEmbedding > 0) reasons.push('embedding_backlog');
  if (readDegradations.includes('embedding_unavailable')) reasons.push('embedding_unavailable');
  if (readDegradations.includes('rerank_unavailable')) reasons.push('rerank_unavailable');

  if (reasons.length === 0) return null;

  return {
    kind: 'search_degraded',
    reasons,
    detail: detailFor(reasons, state),
  };
}

/**
 * The `briefing` shape, or `null` when the bundle is whole.
 *
 * **Null is now reachable, and that is the U12 change.** Before U11 there was
 * nothing materialised to assemble over, so every briefing was degraded and the
 * handler said so unconditionally. Keeping that after the cycle ships would
 * invert the honesty: a fully consolidated brain would keep announcing that its
 * participant cards are missing while returning them. So the caller passes what
 * the assembler found, and `consolidation_pending` is stamped only on a layer
 * the model tier has genuinely never completed over — which is also the
 * permanent and correct state of a free-tier brain (R8).
 */
export function degradedBriefing(
  state: IndexState,
  input: { readonly materialized: boolean; readonly readDegradations?: readonly string[] },
): Degraded | null {
  const search = degradedSearch(state, input.readDegradations ?? []);
  const reasons: DegradedReason[] = [...(search?.reasons ?? [])];
  if (!input.materialized) reasons.push('consolidation_pending');
  if (reasons.length === 0) return null;

  return {
    kind: 'briefing_degraded',
    reasons,
    detail: input.materialized
      ? detailFor(reasons, state)
      : `${detailFor(reasons, state)} Participant cards, extracted commitments and the synopsis layer ` +
        'are assembled by the consolidation cycle and are not part of this bundle yet.',
  };
}

/**
 * One sentence, built from counts and state names only.
 *
 * This string reaches logs, support tickets and the model's context. It carries
 * no row content and no query text by construction — there is no parameter here
 * that could hold either.
 */
function detailFor(reasons: readonly DegradedReason[], state: IndexState): string {
  const parts: string[] = [];
  if (reasons.includes('no_content_yet')) {
    parts.push('this brain has no indexed content yet');
  } else {
    parts.push(`${state.pages} documents and ${state.chunks} passages are indexed`);
  }
  if (reasons.includes('import_in_progress')) parts.push('a first import is still running');
  if (reasons.includes('embedding_backlog')) {
    parts.push(`${state.chunksPendingEmbedding} passages are not searchable by meaning yet`);
  }
  if (reasons.includes('embedding_unavailable')) {
    parts.push('the meaning-based arm of this search could not run, so results came from text and graph matching only');
  }
  if (reasons.includes('rerank_unavailable')) {
    parts.push('the final re-scoring pass could not run, so these results are ordered by the earlier stages alone');
  }
  if (reasons.includes('consolidation_pending')) parts.push('consolidation has not run over it yet');
  return `${parts.join('; ')}.`;
}
