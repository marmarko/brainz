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


/**
 * The vision seat answering — **over the streaming path**, recorded live on
 * 2026-08-16 from the same account, the same `/run/` URL and the same body as
 * {@link MOONDREAM_EMPTY}, differing in exactly one field: `stream: true`.
 *
 * This is the whole of `imp.vision-seat-empty-result`. The model is not
 * broken and the request was not malformed — Cloudflare's **non-streaming
 * aggregation** for this model is, and it answers `{"result":{}}` with
 * `success: true` for every input form. Ask the same question with `stream`
 * set and the answer arrives, with a `metrics` block, and the transcription is
 * exact: the image was a 640x360 screenshot of a settings panel and every line
 * of it came back verbatim.
 *
 * Three properties of this transcript are load-bearing, and each is a way an
 * aggregator goes quietly wrong:
 *
 *  1. **The `chunk.answer` values are CUMULATIVE, not deltas.** `"Network"`
 *     then `"Network Sett"` then the whole answer. A reader that concatenates
 *     them produces a plausible-looking garble that no test asserting
 *     "contains the password" would catch.
 *  2. **The terminal event is the authority.** One event carries
 *     `status: "succeeded"`, and its `output` array's last item is exactly the
 *     `result` object the non-streaming path was supposed to return —
 *     `answer`, `reasoning`, `finish_reason` and `metrics` — so the parser
 *     and the usage reader need to know nothing about streams.
 *  3. **The usage is real and is in `metrics`.** 749 input tokens, 54 output.
 *     A stream that ends without the terminal event is therefore a transport
 *     failure and not an empty answer, or the seat's own worst failure mode
 *     comes back through the door the fix opened.
 *
 * **Truncated in one place, stated here:** the live stream carried 43 `chunk`
 * events and a 43-element `output` array. Two chunks and the first and last
 * `output` items are kept — the first because it shows the cumulative shape,
 * the last because it is what the transport reads. Nothing else is edited; the
 * `id` values are the provider's own request ids and the account id appears
 * nowhere (it is in the URL, which is not recorded). The image was generated
 * for this probe and its contents are invented.
 */
export const MOONDREAM_STREAMED_ANSWER = String.raw`data: {"id":"d2e32443-1931-4f56-a470-6660730653c3","status":"processing","usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0,"prompt_tokens_details":{"cached_tokens":0},"neurons":0}}

data: {"mode":"replace","name":"task","value":"query","usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0,"prompt_tokens_details":{"cached_tokens":0},"neurons":0}}

data: {"mode":"replace","name":"input_tokens","value":749,"usage":{"prompt_tokens":749,"completion_tokens":0,"total_tokens":749,"prompt_tokens_details":{"cached_tokens":0},"neurons":20.42727279663086}}

data: {"mode":"replace","name":"output_tokens","value":54,"usage":{"prompt_tokens":749,"completion_tokens":54,"total_tokens":803,"prompt_tokens_details":{"cached_tokens":0},"neurons":25.33636474609375}}

data: {"chunk":{"answer":"Network","caption":null,"finish_reason":"","metrics":{"decode_time_ms":0,"input_tokens":0,"output_tokens":0,"prefill_time_ms":0,"ttft_ms":0},"objects":null,"points":null,"reasoning":null},"index":0,"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0,"prompt_tokens_details":{"cached_tokens":0},"neurons":0}}

data: {"chunk":{"answer":"Network Sett","caption":null,"finish_reason":"","metrics":{"decode_time_ms":0,"input_tokens":0,"output_tokens":0,"prefill_time_ms":0,"ttft_ms":0},"objects":null,"points":null,"reasoning":null},"index":1,"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0,"prompt_tokens_details":{"cached_tokens":0},"neurons":0}}

data: {"id":"d2e32443-1931-4f56-a470-6660730653c3","logs":"","metrics":{"input_tokens":749,"output_tokens":54,"predict_time":0.725636991,"task":"query"},"output":[{"answer":"Network","caption":null,"finish_reason":"","metrics":{"decode_time_ms":0,"input_tokens":0,"output_tokens":0,"prefill_time_ms":0,"ttft_ms":0},"objects":null,"points":null,"reasoning":null},{"answer":"Network Settings\n\nNetwork name: HARBOUR-GUEST\nWi-Fi password: tangerine-42-lamp\nSecurity: WPA2\nRoom 214 - printer code 8891","caption":null,"finish_reason":"stop","metrics":{"decode_time_ms":591.5433469926938,"input_tokens":749,"output_tokens":54,"prefill_time_ms":49.720089067704976,"ttft_ms":54.697179002687335},"objects":null,"points":null,"reasoning":{"grounding":[],"text":"I need to transcribe every word from the image exactly."}}],"status":"succeeded","usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0,"prompt_tokens_details":{"cached_tokens":0},"neurons":0}}

data: {"response":"","usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0,"prompt_tokens_details":{"cached_tokens":0},"neurons":45.76363754272461}}

data: [DONE]`;

/** What {@link MOONDREAM_STREAMED_ANSWER} transcribed, as the assertions read it. */
export const MOONDREAM_STREAMED_TEXT =
  'Network Settings\n\nNetwork name: HARBOUR-GUEST\nWi-Fi password: tangerine-42-lamp\nSecurity: WPA2\nRoom 214 - printer code 8891';

/**
 * `@cf/qwen/qwen3-embedding-0.6b` via `/run/{modelId}`, recorded live on
 * 2026-08-16. The vectors are elided — 1024 floats say nothing a reader needs —
 * and `shape` is the provider's own.
 *
 * **This is the whole of `imp.cloudflare-embedding-seat-unmetered`.** The same
 * model on the OpenAI-compatible `/v1/embeddings` path (below) returns a body
 * whose only keys are `object`, `data` and `model`: no usage block anywhere, so
 * every call through it is refused `usage_unreported` before the width check
 * even runs. The native path reports usage in the same place the reranker does
 * — nested under `result` — and the two paths return **the same vectors**,
 * component for component, so this is a transport change and not a model
 * change.
 */
export const QWEN_EMBEDDING_RUN = {
  result: {
    data: [[-0.014760761521756649, 0.0037299322895705700]],
    shape: [1, 1024],
    usage: {
      prompt_tokens: 3,
      completion_tokens: 0,
      total_tokens: 3,
      prompt_tokens_details: { cached_tokens: 0 },
      neurons: 0.0032237636062470423,
    },
  },
  success: true,
  errors: [],
  messages: [],
} as const;

/**
 * The same model on `/v1/embeddings`, same account, same minute. Recorded so
 * the absence is evidence rather than a claim: three keys, and none of them is
 * a usage block.
 */
export const QWEN_EMBEDDING_COMPAT_UNMETERED = {
  object: 'list',
  data: [{ object: 'embedding', embedding: [-0.014760761521756649, 0.0037299322895705700], index: 0 }],
  model: '@cf/qwen/qwen3-embedding-0.6b',
} as const;

/**
 * A reply cut off at the output ceiling.
 *
 * `finish_reason: 'length'` is the OpenAI-compatible spelling and the one every
 * Cloudflare seat uses; `MAX_TOKENS` is what the Gemini family reports through
 * the same field, and `extract` routes there — a reader that knew only the first
 * would trust every truncated Gemini answer.
 *
 * The content is deliberately WELL-FORMED-LOOKING and short of the answer: JSON
 * that fails to parse is already caught downstream, and the case that needed
 * naming is the reply that parses and is missing most of what was asked for.
 */
export const GLM_TRUNCATED = {
  id: 'id-1786911857900',
  object: 'chat.completion',
  created: 1786911858,
  model: '@cf/zai-org/glm-5.2',
  choices: [
    {
      finish_reason: 'length',
      index: 0,
      logprobs: null,
      message: { content: '{"facts":[{"statement":"a"},{"statement":"b"}', role: 'assistant' },
    },
  ],
  usage: { prompt_tokens: 4000, completion_tokens: 4096, total_tokens: 8096 },
} as const;

/** The same cut, spelled the way the Gemini-family seats spell it. */
export const GEMINI_TRUNCATED = {
  id: 'id-1786911860999',
  object: 'chat.completion',
  created: 1786911861,
  model: 'google/gemini-3.5-flash-lite',
  choices: [
    {
      finish_reason: 'MAX_TOKENS',
      index: 0,
      message: { content: '{"facts":[{"statement":"a"}', role: 'assistant' },
    },
  ],
  usage: { prompt_tokens: 4000, completion_tokens: 4096, total_tokens: 8096 },
} as const;
