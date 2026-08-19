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

/**
 * The MCP revision this surface speaks. Sessions were retired in it.
 *
 * **Named `MCP_` rather than left bare, and that prefix is the fix.** A constant
 * called `PROTOCOL_VERSION` in a file that owns a response envelope reads as
 * "the version of the envelope", and it was used as both — see
 * {@link MEMORY_VERBS_VERSION} for the failure that produced. The bare name is
 * what invited the reuse; leaving it bare invites the next one.
 */
export const MCP_PROTOCOL_VERSION = '2026-07-28';

/**
 * The revisions `initialize` may answer with, newest first.
 *
 * **The failure this closes.** `initialize` used to answer `MCP_PROTOCOL_VERSION`
 * whatever the client asked for. The spec is the other way round: a server that
 * can serve the requested revision MUST echo it, and a client that receives a
 * revision it does not know SHOULD disconnect. So a connector built against an
 * older revision was told, correctly and fatally, that it was talking to
 * something it could not speak — and a disconnect during discovery renders as an
 * empty tool list rather than as an error, which is why this surfaced as "this
 * connector has no tools available" and not as a failure anyone could read.
 *
 * **Why the list starts at 2025-06-18 rather than at the first revision.**
 * JSON-RPC batching was mandatory before it and removed in it; this surface has
 * never decoded a batch. Echoing an older revision would be a promise of a
 * framing we do not parse, which trades a legible refusal for a wrong answer.
 * Anything outside the list is answered with `MCP_PROTOCOL_VERSION` — the spec's
 * own fallback, and the branch that lets a client decide for itself whether it
 * can proceed.
 *
 * Everything this surface adds beyond the base is additive `_meta` and named
 * extensions, which an older client ignores by construction. That is what makes
 * echoing an older revision honest rather than merely accommodating.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  MCP_PROTOCOL_VERSION,
  '2025-11-25',
  '2025-06-18',
];

/**
 * The revision to answer a given `initialize` with.
 *
 * Deliberately total: a missing, non-string or unknown `protocolVersion` all
 * resolve to `MCP_PROTOCOL_VERSION`, because the one thing this must never do is
 * throw on the first message of every session.
 */
export function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : MCP_PROTOCOL_VERSION;
}

/**
 * The version of the envelope's own shape. An integer, and not a date.
 *
 * **The failure this closes.** `buildEnvelope` used to stamp
 * {@link MCP_PROTOCOL_VERSION} here, because one constant carried two unrelated
 * dimensions: a dated MCP wire revision negotiated per connection, and the
 * version of this response body. They move on different cadences, are read by
 * different parties, and have different types. Reusing one for both was
 * survivable only while `initialize` answered the same literal unconditionally
 * — the moment revision negotiation landed, the field became false under *both*
 * readings at once: a client that negotiated `2025-11-25` was told `2025-11-25`
 * at `initialize` and then handed `"2026-07-28"` in every envelope of that same
 * connection. That is neither the envelope's version nor the revision the
 * connection agreed on, and there is no reader for whom it was ever true.
 *
 * `1` because this is the shape brainz publishes as `memory-verbs-v1-partial`
 * (`upstream/memory-verbs-v1-partial.json`), whose profile is v1.
 */
export const MEMORY_VERBS_VERSION = 1;

/**
 * The model-facing keys. Frozen: additive forever.
 *
 * `protocol_version` — {@link MEMORY_VERBS_VERSION}, the version of this body's
 *                      shape. Never the MCP wire revision, which is negotiated
 *                      per connection and answered at `initialize`. It was the
 *                      only frozen key with no line here, which is how the two
 *                      came to be the same constant.
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
  /**
   * The text arm dropped out because the database refused to parse the query.
   *
   * Not a provider failure and not a refusal: a caller that pastes a document
   * into `query` blows `websearch_to_tsquery` past `max_stack_depth` (SQLSTATE
   * `54001`) or past the tsquery value limit (`54000`). The vector and graph
   * arms never see the query text, so the read still answers — this is what
   * tells the caller the keyword half of it did not.
   */
  'query_too_complex',
  'consolidation_pending',
  /**
   * The corpus is indexed and the layer built from it is not.
   *
   * **The failure this closes.** A brain with thousands of embedded documents
   * and a few dozen facts answered every read as a clean success: nothing was
   * importing, nothing was unembedded, every arm ran, so no reason fired,
   * `degraded` was omitted and `resultClass` stayed `ok`. What came back was
   * raw passages where the caller had asked a question the consolidated layer
   * exists to answer. The user reads that as a weak product rather than as an
   * index that is behind, which is the one misreading this surface can prevent
   * and could not express.
   *
   * **Named separately from `consolidation_pending`, because "never" and
   * "behind" are different sentences.** `consolidation_pending` is a claim about
   * the *layer*: the model tier has never completed over this brain, which is
   * also the permanent and correct state of a free-tier one. This is a claim
   * about the *gap*: consolidation exists, has run, and has not kept pace with
   * what has arrived since. One of them is answered by upgrading and the other
   * by waiting, and a caller that could not tell them apart would say the wrong
   * one to a paying user.
   */
  'consolidation_behind',
] as const;

export type DegradedReason = (typeof DEGRADED_REASONS)[number];

export interface Degraded {
  readonly kind: DegradedKind;
  readonly reasons: readonly DegradedReason[];
  /** One content-free sentence: counts and state names, never a user's words. */
  readonly detail: string;
}

export interface Envelope {
  /**
   * Typed `number` rather than the literal `1` on purpose: the violation check
   * below exists to catch a builder that stamped the wrong value, and a literal
   * type would make the only input that triggers it unconstructable — an
   * assertion nothing can reach is an assertion nobody has shown to work.
   */
  readonly protocol_version: number;
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
    protocol_version: MEMORY_VERBS_VERSION,
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

  if (envelope.protocol_version !== MEMORY_VERBS_VERSION) {
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
  /**
   * Live, un-superseded facts in grant: the size of the layer consolidation
   * builds.
   *
   * **Superseded rows are excluded, and that is the difference between a
   * measurement and a number.** Consolidation supersedes rather than rewrites —
   * origin is immutable, so a claim whose inputs changed becomes a new row
   * pointing at the old one. Counting the old ones would make a mature brain's
   * layer look several times larger than the knowledge it can actually answer
   * from, which is the exact direction that would hide the gap below.
   */
  readonly facts: number;
  /**
   * Ingestion runs recorded in grant, any outcome: whether a source has ever
   * delivered anything this connection can read.
   *
   * Fenced like every other counter here, which gives it a precise meaning
   * rather than an approximate one: a run whose origin this grant cannot reach
   * is not this connection's source, and a hint built on it would name a brain
   * the caller cannot act on.
   */
  readonly ingestRuns: number;
  /**
   * Live facts carrying the grant's own write origin — what the connected agent
   * has been told to remember, as opposed to what a connector delivered.
   *
   * Facts rather than pages because `remember` is the only path that reaches
   * this origin and every successful one writes exactly one fact, while the page
   * beside it is an implementation detail of the write path that has been
   * nullable in the response shape from the start.
   *
   * **This counts inside the fence, which is only sound because a grant always
   * contains the origin it writes to.** `grant-scope.ts` refuses a credential
   * whose `writeOrigin` sits outside its own origins, at mint and again at
   * verify — "a grant that writes where it cannot read plants rows it can never
   * see" — and `expandGrant` floors every class wildcard with that class's agent
   * origin. Were that ever relaxed, a user's own captures would fall outside the
   * subset fence, this would read zero forever, and {@link setupHint} would ask
   * a user who HAS captured to start capturing, with no action able to stop it.
   */
  readonly capturedByAgent: number;
}

/**
 * The corpus below which the fact ratio has no opinion.
 *
 * A brain in the first minute of its first import has a handful of documents
 * and no facts, and it is *new* rather than *behind* — `import_in_progress` and
 * `no_content_yet` are the reasons that describe it. Without a floor the ratio
 * would call every brain behind on the way up from zero, which is how a signal
 * that means something becomes one a reader learns to ignore.
 */
export const CONSOLIDATION_CORPUS_FLOOR = 50;

/**
 * Documents per fact, above which the layer is behind the corpus.
 *
 * A deliberately loose ratio. Extraction over a real corpus yields facts in the
 * same order as documents, so one fact per ten documents is not a tuning
 * parameter sitting near the true rate — it is an order of magnitude below any
 * of them, which is what makes tripping it evidence of a gap rather than
 * evidence of a thin week. The cost of being wrong is asymmetric: a false
 * positive is a sentence on every read of a healthy brain, and a false negative
 * is only the silence this surface already had.
 */
export const CONSOLIDATION_DOCUMENTS_PER_FACT = 10;

/**
 * Whether the corpus has outrun the layer built from it.
 *
 * Both counts are fenced, so this is a claim about the brain the caller can
 * actually read. It deliberately does NOT consult the last cycle's timestamp:
 * `consolidation_run` is brain-wide operational state while everything else in
 * {@link IndexState} is grant-fenced, and mixing the two would make a per-grant
 * sentence out of a fact about origins the grant may not reach.
 */
function consolidationBehind(state: IndexState): boolean {
  if (state.pages < CONSOLIDATION_CORPUS_FLOOR) return false;
  return state.facts * CONSOLIDATION_DOCUMENTS_PER_FACT < state.pages;
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
  if (consolidationBehind(state)) reasons.push('consolidation_behind');
  if (readDegradations.includes('embedding_unavailable')) reasons.push('embedding_unavailable');
  if (readDegradations.includes('rerank_unavailable')) reasons.push('rerank_unavailable');
  if (readDegradations.includes('query_too_complex')) reasons.push('query_too_complex');

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
  // **Silenced by `consolidation_pending`, because the two would say the same
  // news twice with the weaker half second.** A layer that has never completed
  // is behind by construction, so a cold brain fires both reasons; "consolidation
  // has not run over it yet" is the whole story and a ratio sentence appended to
  // it reads as a second, separate problem.
  if (reasons.includes('consolidation_behind') && !reasons.includes('consolidation_pending')) {
    parts.push(`only ${state.facts} of them have been turned into facts`);
  }
  // **The two arm-availability reasons are answered together, because each
  // sentence names the arms that *did* answer.** Written one reason at a time
  // they contradict each other the moment both fire: the vector sentence says
  // the result came from text and graph, the keyword sentence says it came from
  // meaning and graph, and a read that lost both — a caller pasting a document
  // as a query loses the embedding to the read's spend ceiling and the keyword
  // arm to Postgres's tsquery parser in the same call — emitted both. One of
  // them is always false and the reader has no way to tell which.
  const noVectorArm = reasons.includes('embedding_unavailable');
  const noKeywordArm = reasons.includes('query_too_complex');
  if (noVectorArm && noKeywordArm) {
    parts.push(
      'neither the meaning-based nor the keyword arm of this search could run, so results came ' +
        'from graph matching alone',
    );
  } else if (noVectorArm) {
    parts.push('the meaning-based arm of this search could not run, so results came from text and graph matching only');
  }
  if (reasons.includes('rerank_unavailable')) {
    parts.push('the final re-scoring pass could not run, so these results are ordered by the earlier stages alone');
  }
  if (noKeywordArm && !noVectorArm) {
    // No length, no excerpt, no count of anything the caller typed: this
    // sentence reaches logs and support tickets, and the query is the user's own
    // words — a pasted document, in the case that produced this reason.
    parts.push(
      'the keyword arm of this search could not run because the query was too large for the ' +
        'text index to parse, so results came from meaning and graph matching only',
    );
  }
  if (reasons.includes('consolidation_pending')) parts.push('consolidation has not run over it yet');
  return `${parts.join('; ')}.`;
}

/**
 * The order the notice table is read in, and the argument for it.
 *
 * **Widest cause first, because that is the one that explains the thinness the
 * user is noticing.** A standing gap — material still arriving, material
 * indexed but not consolidated, material indexed but not embedded — hides part
 * of the brain from every read. A per-call arm loss weakens one answer. Told
 * only that "part of the search could not run" while three quarters of their
 * brain has never been consolidated, a user fixes the wrong thing, or worse,
 * concludes the product is simply like this.
 *
 * **`no_content_yet` is deliberately absent.** The sentence an empty brain
 * needs names an action, and naming actions is {@link setupHint}'s slot. Saying
 * it in both lanes is one piece of news twice in one response, which is how a
 * two-line lane becomes a paragraph.
 *
 * **`consolidation_pending` is deliberately absent too, and that one is a
 * promise problem rather than a duplication one.** Every line here tells the
 * user the state is temporary. On the free tier a layer that has never
 * consolidated is the permanent and correct state (R8), so the same sentence
 * would be a promise the product does not keep — and `briefing`, the only read
 * that can produce the reason, already carries the bounded upgrade prompt
 * written for exactly that state.
 */
const NOTICE_LINES: readonly (readonly [DegradedReason, string])[] = [
  [
    'import_in_progress',
    'Your brain is still filling up — an import is running, so some of what you are asking about may not be in here yet.',
  ],
  [
    'consolidation_behind',
    'Most of what is indexed here has not been turned into facts yet, so this answer leans on raw passages — it sharpens as consolidation catches up.',
  ],
  [
    'embedding_backlog',
    'Some of what is indexed here is not searchable by meaning yet, so this answer may have missed things — that backlog clears on its own.',
  ],
  [
    'query_too_complex',
    'That query was too long for the keyword half of the search, so this answer came from meaning-matching alone — a shorter question will do better.',
  ],
  [
    'embedding_unavailable',
    'Part of the search could not run just now, so this is a weaker answer than usual — worth asking again in a moment.',
  ],
  [
    'rerank_unavailable',
    'The final ranking pass could not run just now, so these results are ordered more roughly than usual — worth asking again in a moment.',
  ],
];

/**
 * One sentence a person can hear about why this read was thin, or nothing.
 *
 * **The failure this closes.** `degraded` was already computed, already
 * correct, and already on the wire — and it is a named shape with a closed
 * reason set, which is to say it is addressed to a parser. The server
 * instructions tell the model that `notice` is the lane worth relaying to the
 * user; the degradations never used it, so whether the user heard anything
 * depended on whether a model chose to narrate a status code. On a brain that
 * was materially behind, most of the time it did not, and the user concluded
 * the brain had nothing rather than that it had not caught up.
 *
 * **Exactly one line, however many reasons fired.** Not a summary of the
 * `reasons` array: the array is the machine-readable half and already carries
 * every cause. The lane holds two entries and `briefing` can already own both
 * with advisories that bank themselves as shown when they fire — a degradation
 * that spent the lane on itself would push a bounded, scheduled notice out of a
 * response that had already recorded delivering it, and the user would never
 * see it again.
 */
export function degradedNotice(degraded: Degraded | null): readonly string[] {
  if (degraded === null) return [];

  const reasons = new Set<DegradedReason>(degraded.reasons);
  // The same precedence `detailFor` applies: a layer that has never completed is
  // behind by construction, and the line for "behind" promises a catching-up
  // that a brain which has never consolidated is not doing.
  if (reasons.has('consolidation_pending')) reasons.delete('consolidation_behind');

  for (const [reason, line] of NOTICE_LINES) {
    if (reasons.has(reason)) return [line];
  }
  return [];
}

/**
 * The one thing this user could do next, or nothing — and nothing is the
 * ordinary answer.
 *
 * **The rule, stated once so it can be argued with: `setup` names a stage of
 * the loop that has never happened, and every hint it can emit is ended
 * permanently by one call the user's own agent makes.** Connecting a source
 * ends the first; a single `remember` ends the second. That is what keeps this
 * from being advice — advice recurs, and a lane that recurs is one a user
 * silences by disconnecting the brain, after which nothing works at all.
 *
 * **The honest cost of that rule, said out loud.** It bounds a hint's
 * *lifetime*, not its per-call frequency: while a stage really has never
 * happened, the hint rides every ranked read. The alternative is a per-caller
 * bound like the one `briefing` keeps in `briefing_cursor` — which means a
 * table and a write on the read path, for a state that by construction ends the
 * first time anyone uses the product as intended. That trade is the reason this
 * ladder has exactly two rungs and no third one for anything merely advisable.
 *
 * **A brain that is behind gets no hint at all**, which is the rung worth
 * naming for what it refuses: there is nothing to connect and nothing to
 * capture that makes consolidation catch up faster, so asking the user for
 * something here would be asking them to fix a queue they do not own.
 * {@link degradedNotice} carries that news instead.
 */
export function setupHint(state: IndexState, webAppBaseUrl: string): SetupHint | null {
  // Rung one: nothing has ever arrived and nothing has ever been stored. One
  // connect brings in years of material and one `remember` brings in one line,
  // so on a brain with neither, the connector is the higher-value ask — which
  // is why this rung answers `connect_source` where the read path used to
  // answer `first_memory` for the same state.
  if (state.pages === 0 && state.chunks === 0 && state.ingestRuns === 0) {
    return {
      kind: 'connect_source',
      detail:
        'This brain has nothing in it and nothing connected to it, so there is nothing to search ' +
        'yet. Connecting an account is what fills it.',
      // The destination is the hint. A suggestion the user cannot act on is the
      // same artifact `forget`'s notice was rewritten to stop being: a real
      // promise with nowhere to keep it.
      url: `${webAppBaseUrl.replace(/\/+$/, '')}/connect`,
    };
  }

  // Rung two: a source has delivered, and the user has never told this brain
  // anything directly. The capture half of the loop is the half that decides
  // whether the brain knows anything a connector could not have fetched.
  if (state.ingestRuns > 0 && state.capturedByAgent === 0) {
    return {
      kind: 'first_memory',
      detail:
        'This brain holds what its connected accounts have delivered and nothing this person has ' +
        'told you. Store what they say about themselves, their people and their decisions with ' +
        '`remember`, in their own words, as it comes up.',
    };
  }

  return null;
}
