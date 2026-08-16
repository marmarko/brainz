/**
 * Response bodies **recorded from the live Cloudflare endpoint**, 2026-08-16.
 *
 * Not a `*.test.ts` file: it is evidence, shared by the suites that assert on
 * it. Every object below was returned by a real call to
 * `…/accounts/{account}/ai` and pasted here unchanged except for two edits:
 * the account id never appears (it is in the URL, which is not recorded), and
 * one long provider-internal blob was truncated where the comment says so.
 *
 * **Why recorded rather than written.** The trap these fixtures exist for is a
 * parser that reads a field the provider does not send. An invented fixture is
 * written by the same understanding that wrote the parser, so it agrees with
 * the parser by construction and can only ever confirm it — which is how a
 * reasoning model's empty `content` came to read as a successful empty answer.
 * The only fixture that can contradict the parser is one the provider wrote.
 *
 * The four findings these encode, each of which changed the code:
 *
 *  1. **Two spellings of the reasoning field.** glm-5.2 returns
 *     `message.reasoning_content` beside an empty-string `content`; nemotron
 *     returns `message.reasoning` beside a **null** `content`. A parser that
 *     knew one spelling, or that only guarded `''`, passes on one model and
 *     silently returns an empty answer on the other.
 *  2. **The tokens are billed either way.** Both carry a non-zero
 *     `completion_tokens`. "Empty answer" and "free call" are different
 *     statements and only one of them is true.
 *  3. **`cached_tokens` is real on this endpoint**, and is a *subset* of
 *     `prompt_tokens` — 320 of 376 on the second of two identical-prefix
 *     calls. That is the discount `pricing.ts` models; without a recorded
 *     example there would be no evidence it is ever non-zero.
 *  4. **`/run/` reports usage in a different place.** The reranker nests it
 *     under `result.usage`; moondream's published schema puts it under
 *     `result.metrics` with `input_tokens`/`output_tokens` names. A reader
 *     that knows only top-level `usage.prompt_tokens` reports
 *     `usage_unreported` for every call on that path.
 */

/**
 * `@cf/zai-org/glm-5.2` via `/v1/chat/completions`, `max_tokens: 16`.
 *
 * The judge seat's exact failure shape: the model spent its whole ceiling
 * thinking, `content` is the empty string, and 16 completion tokens are billed.
 */
export const GLM_REASONING_ONLY = {
  id: 'id-1786911855701',
  object: 'chat.completion',
  created: 1786911855,
  model: '@cf/zai-org/glm-5.2',
  choices: [
    {
      finish_reason: 'length',
      index: 0,
      logprobs: null,
      message: {
        content: '',
        reasoning_content: '1.  **Analyze the Request:** The user wants me to reply with',
        role: 'assistant',
      },
    },
  ],
  usage: {
    prompt_tokens: 19,
    completion_tokens: 16,
    total_tokens: 35,
    prompt_tokens_details: { cached_tokens: 0 },
    neurons: 8.818181991577148,
  },
} as const;

/**
 * `@cf/nvidia/nemotron-3-120b-a12b` via `/v1/chat/completions`, `max_tokens: 16`.
 *
 * The salience/synopsis seat, and the reason the guard is not a `=== ''` check:
 * this model spells the trace `reasoning` and sends `content: null`.
 */
export const NEMOTRON_REASONING_ONLY = {
  id: 'id-1786911857845',
  object: 'chat.completion',
  created: 1786911857,
  model: '@cf/nvidia/nemotron-3-120b-a12b',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        refusal: null,
        annotations: null,
        audio: null,
        function_call: null,
        tool_calls: [],
        reasoning: 'We need to reply with the single word "ok". Ensure no extra punctuation',
      },
      logprobs: null,
      finish_reason: 'length',
      stop_reason: null,
      token_ids: null,
    },
  ],
  usage: {
    prompt_tokens: 23,
    completion_tokens: 16,
    total_tokens: 39,
    prompt_tokens_details: { cached_tokens: 0 },
    neurons: 3.2110000000000003,
  },
} as const;

/** The same seat answering normally — the case that must stay a success. */
export const GLM_ANSWERED = {
  id: 'id-1786911857176',
  object: 'chat.completion',
  created: 1786911857,
  model: '@cf/zai-org/glm-5.2',
  choices: [
    { finish_reason: 'stop', index: 0, logprobs: null, message: { content: 'ok', role: 'assistant' } },
  ],
  usage: {
    prompt_tokens: 376,
    completion_tokens: 3,
    total_tokens: 379,
    // The second of two calls sharing a 360-token system prefix. This is the
    // 82% discount, observed rather than assumed.
    prompt_tokens_details: { cached_tokens: 320 },
    neurons: 15.890909194946289,
  },
} as const;

/**
 * `google/gemini-3.5-flash-lite` via `/v1/chat/completions` — Unified Billing
 * passthrough, no Google credential involved.
 *
 * Two things worth keeping: the id carries no date (see `routing.ts`'s
 * unpinnable declaration) and the usage block has **no** `prompt_tokens_details`
 * at all, so the cached-token reader has to treat absence as "none cached"
 * rather than as a malformed usage block.
 */
export const GEMINI_PASSTHROUGH = {
  id: 'id-1786911860232',
  object: 'chat.completion',
  created: 1786911860,
  model: 'google/gemini-3.5-flash-lite',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: 'ok',
        // Truncated here; the provider returns a much longer opaque blob.
        extra_content: { google: { thought_signature: 'AY89a184TUqc831…' } },
      },
      finish_reason: 'stop',
      logprobs: null,
    },
  ],
  usage: {
    prompt_tokens: 7,
    completion_tokens: 1,
    total_tokens: 8,
    extra_properties: { google: { traffic_type: 'ON_DEMAND' } },
  },
} as const;

/**
 * `@cf/baai/bge-reranker-base` via `/run/{modelId}`.
 *
 * The compat path refuses this model outright (HTTP 400, "required properties
 * at '/' are 'query,contexts'"), which is why the transport routes rerank to
 * `/run/`. Note `usage` is nested under `result`, and `completion_tokens` is 0
 * — a cross-encoder writes nothing, and the input-only price depends on that
 * staying true.
 */
export const RERANK_RUN = {
  result: {
    response: [
      { id: 0, score: 0.7441944479942322 },
      { id: 1, score: 0.000037429923395393416 },
    ],
    usage: {
      prompt_tokens: 34,
      completion_tokens: 0,
      total_tokens: 34,
      prompt_tokens_details: { cached_tokens: 0 },
      neurons: 0.009609379270889618,
    },
  },
  success: true,
  errors: [],
  messages: [],
} as const;

/**
 * `@cf/moondream/moondream3.1-9B-A2B` via `/run/{modelId}` — **every** call,
 * for every documented input form, on 2026-08-16.
 *
 * `success: true`, an empty result, no answer, no metrics, no usage. Recorded
 * because it is the shape the vision seat actually returns today, and because a
 * transcription phase that reads it as "this image contains no text" writes an
 * empty transcription and never retries the attachment. See
 * `upstream/concepts.jsonl:imp.vision-seat-empty-result` for the evidence trail.
 */
export const MOONDREAM_EMPTY = {
  result: {},
  success: true,
  errors: [],
  messages: [],
} as const;

/**
 * What a working `/run/` vision model returns, from `@cf/llava-hf/llava-1.5-7b-hf`
 * called on the same account, in the same way, in the same minute — the control
 * that makes the moondream result a finding about the seat rather than about the
 * request. Note it reports no usage at all.
 */
export const LLAVA_ANSWERED = {
  result: { description: ' The text "Google" appears in the image.' },
  success: true,
  errors: [],
  messages: [],
} as const;

/**
 * Moondream's published input schema, abridged to the parts that constrain the
 * request body. Fetched from `…/ai/models/schema?model=…` on 2026-08-16.
 *
 * The three that changed the transport: the question field is `question` and
 * not `prompt`; `image` is a **string** (public HTTPS URL or base64 data URI)
 * and not the byte array every other Workers AI image-to-text model takes; and
 * `reasoning` defaults to **true**, so the vision seat is a third reasoning
 * model and not an exception to the trap above.
 */
export const MOONDREAM_INPUT_SCHEMA = {
  task: { type: 'string', enum: ['query', 'caption', 'point', 'detect'], default: 'query' },
  image: {
    type: 'string',
    description:
      'Input image as a public HTTPS URL or base64 data URI. Optional for `query`; required for `caption`, `point`, and `detect`.',
  },
  question: { type: 'string', default: "What's in this image?" },
  reasoning: { type: 'boolean', default: true },
  max_tokens: { type: 'integer', minimum: 1, maximum: 28672, default: 8192 },
} as const;

/**
 * Moondream's published *output* schema, same fetch. The answer is `answer`
 * (query task) or `caption` (caption task), and usage arrives as
 * `metrics.input_tokens` / `metrics.output_tokens` — neither of which is where
 * an OpenAI-shaped reader looks.
 */
export const MOONDREAM_OUTPUT_FIELDS = [
  'finish_reason',
  'metrics',
  'answer',
  'caption',
  'points',
  'objects',
  'reasoning',
] as const;

/**
 * A moondream response as its schema says a working one looks. Marked clearly
 * as **constructed from the published schema, not recorded** — the live seat
 * never produced one. It is here so the parser's success path is exercised at
 * all; the assertions that matter for today's behaviour use
 * {@link MOONDREAM_EMPTY}, which is real.
 */
export const MOONDREAM_SCHEMA_SHAPED_ANSWER = {
  result: {
    answer: 'the wifi password is on the fridge',
    caption: null,
    reasoning: null,
    finish_reason: 'stop',
    metrics: { input_tokens: 1612, output_tokens: 9, prefill_time_ms: 40, decode_time_ms: 90, ttft_ms: 50 },
  },
  success: true,
  errors: [],
  messages: [],
} as const;
