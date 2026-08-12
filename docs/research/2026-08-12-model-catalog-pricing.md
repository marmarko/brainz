# Model catalog + pricing research — moving off the Anthropic tiers

**Date:** 2026-08-12
**Question asked:** what's available on Cloudflare's AI catalog, what are the best
alternatives to the Anthropic models KTD13 originally carried, and how do they rank by price.
**Outcome:** KTD13's routing table replaced — `gemini-3.5-flash-lite` for the three
judgment/extraction ops, Cloudflare-hosted open weights (Nemotron-3 Super, GLM-5.2,
Llama-3.2-Vision, bge-reranker) for everything else, so exactly **two** content-touching
processors exist and both are named; KTD8 moved to OpenAI embeddings; KTD4's rerank line item
collapsed; two new verification items (Assumption 5, Workers AI rate limits).

**Reading order note.** §2/§3 rank by price because that was the question asked. §4 is what
actually decided the table — the hosted/third-party split — and §5 carries the picks. A reader
optimizing purely on the §2 ranking will land somewhere different and cheaper; §5 explains why
the plan didn't.

---

## 1. The billing change that reframes the question

Cloudflare shipped **unified billing on 2026-08-07**. Workers AI and partner providers
(OpenAI, Google, xAI, Groq, Anthropic — 350+ models across 6 providers) sit behind one API,
one prepaid credit balance and one bill. BYOK keys live in Cloudflare Secrets Store, and
**spend limits apply "for models with known pricing"** — which is R14's unpriced-model rule,
already implemented upstream.

Consequences for the plan:

- Moving off Anthropic is a **row change in one catalog**, not a vendor migration.
- All of it is plain HTTPS, so a Cloudflare Container calls it without touching KTD2's
  Containers-not-Workers decision.
- U20 gets thinner — Cloudflare does the metering and the cap — but **must keep a
  direct-to-provider path**, because an AGPL self-hoster (KTD7) has no Cloudflare account.

**Constraint found:** Cloudflare's BYOK is **gateway-scoped, not per-request**. Keys are
configured per gateway with a `cf-aig-byok-alias` selector, and unified-billing endpoints
(`env.AI.run()`) consult only the `default` alias. R22 wants a key *per tenant*. Two paths:
per-tenant aliases on direct-passthrough requests, or brainz holding tenant keys in its own
secret store and passing them through. The second keeps R12's erasure leg inside brainz's
control.

**Open question filed:** Workers AI per-model rate limits at fleet scale. The unified-billing
changelog quotes 20 → 50 rpm per account per model on the frontier tier (Kimi K2.6/K2.7,
GLM-5.2). If the standard tier is bounded comparably, bulk consolidation across many tenants
hits a throughput ceiling unrelated to price — that would change U10's scheduler (per-model
queueing), not the model picks.

---

## 2. Price ranking — Cloudflare-hosted (Workers AI, CF-billed)

Neuron conversion: **$0.011 per 1,000 neurons**; **10,000 neurons/day free** on both Free and
Paid plans. Blended column is at **5:1 input:output**, brainz's dominant shape (long chunk in,
small structured JSON out) — a different ratio reorders the middle of this table, so recompute
rather than reuse it for a different workload.

| # | Model | $/M in | $/M out | Blended 5:1 | Notes |
|---|---|---|---|---|---|
| 1 | `@cf/ibm-granite/granite-4.0-h-micro` | 0.017 | 0.112 | **0.033** | 3B hybrid Mamba/transformer, 131k ctx, tuned for instruction-following + tool calling |
| 2 | `@cf/meta/llama-3.2-1b-instruct` | 0.027 | 0.201 | 0.056 | |
| 3 | `@cf/qwen/qwen3-30b-a3b-fp8` | 0.051 | 0.335 | **0.098** | MoE, 3B active / 30B total, 128k ctx |
| 4 | `@cf/meta/llama-3.2-3b-instruct` | 0.051 | 0.335 | 0.098 | |
| 5 | `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | 0.045 | 0.384 | 0.102 | |
| 6 | `@cf/zai-org/glm-4.7-flash` | 0.060 | 0.400 | 0.117 | 131k ctx |
| 7 | `@cf/google/gemma-4-26b-a4b-it` | 0.100 | 0.300 | 0.133 | |
| 8 | `@cf/meta/llama-3.2-11b-vision-instruct` | 0.049 | 0.676 | 0.154 | **vision** |
| 9 | `@cf/openai/gpt-oss-20b` | 0.200 | 0.300 | 0.217 | |
| 10 | `@cf/meta/llama-4-scout-17b-16e-instruct` | 0.270 | 0.850 | 0.367 | MoE |
| 11 | `@cf/mistralai/mistral-small-3.1-24b-instruct` | 0.351 | 0.555 | 0.385 | |
| 12 | `@cf/openai/gpt-oss-120b` | 0.350 | 0.750 | **0.417** | 131k ctx |
| 13 | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 0.293 | 2.253 | 0.620 | |
| 14 | `@cf/nvidia/nemotron-3-120b-a12b` | 0.500 | 1.500 | 0.667 | MoE |
| 15 | `@cf/qwen/qwq-32b` | 0.660 | 1.000 | 0.717 | reasoning |
| 16 | `@cf/qwen/qwen2.5-coder-32b-instruct` | 0.660 | 1.000 | 0.717 | code |
| 17 | `@cf/moonshotai/kimi-k2.5` | 0.600 | 3.000 | 1.000 | 256k ctx; $0.10 cached in |
| 18 | `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | 0.497 | 4.881 | 1.228 | reasoning |
| 19 | `@cf/moonshotai/kimi-k2.6` | 0.950 | 4.000 | 1.458 | 262k ctx; $0.16 cached in |
| 20 | `@cf/moonshotai/kimi-k2.7-code` | 0.950 | 4.000 | 1.458 | 262k ctx; $0.19 cached in |
| 21 | `@cf/zai-org/glm-5.2` | 1.400 | 4.400 | 1.900 | $0.26 cached in |

Also priced but not ranked (different shape or deprecated): `llama-guard-3-8b` (0.484/0.030,
safety), `llama-3.1-8b-instruct-awq` (0.123/0.266), `llama-3.1-8b-instruct-fp8` (0.152/0.287),
`gemma-sea-lion-v4-27b-it` (0.351/0.555), `mistral-7b-instruct-v0.1` (0.110/0.190),
`llama-2-7b-chat-fp16` (0.556/6.667).

### Embeddings (Cloudflare-hosted), per M input tokens

| Model | $/M | Dim |
|---|---|---|
| `@cf/baai/bge-m3` | 0.012 | multi-vector |
| `@cf/qwen/qwen3-embedding-0.6b` | 0.012 | |
| `@cf/pfnet/plamo-embedding-1b` | 0.019 | |
| `@cf/baai/bge-small-en-v1.5` | 0.020 | 384 |
| `@cf/baai/bge-base-en-v1.5` | 0.067 | 768 |
| `@cf/baai/bge-large-en-v1.5` | 0.204 | 1024 |

### Rerank / classification

| Model | $/M in |
|---|---|
| `@cf/baai/bge-reranker-base` | **0.003** |

---

## 3. Price ranking — partner models (provider list price, one Cloudflare bill)

| Model | $/M in | $/M out | Blended 5:1 |
|---|---|---|---|
| `gpt-5.4-nano` | 0.20 | 1.25 | 0.375 |
| `gemini-3.1-flash-lite` | 0.25 | 1.50 | 0.458 |
| `gemini-3.5-flash-lite` | 0.30 | 2.50 | 0.667 |
| `gpt-5.4-mini` | 0.75 | 4.50 | 1.375 |
| `gemini-3.6-flash` | 1.50 | 7.50 | 2.500 |

### Anthropic baseline being replaced

| Model | $/M in | $/M out | Blended 5:1 |
|---|---|---|---|
| Haiku 4.5 | 1.00 | 5.00 | 1.667 |
| Sonnet 5 | 3.00 | 15.00 | 5.000 |
| Opus 5 | 5.00 | 25.00 | 8.333 |

Sonnet 5 carries introductory $2/$10 pricing through 2026-08-31; $3/$15 from 2026-09-01, which
is the figure used. Output is 5× input across the Anthropic line. Cache hits are 10% of base
input and batch is 50% off across all vendors listed here — none of which is folded into the
blended columns, deliberately: a comparison that assumes optimal cache behavior on one side
flatters it.

---

## 4. Hosted vs third-party — the distinction that decided the table

The catalog holds two kinds of row, and the badge is load-bearing:

- **Cloudflare-hosted** — open weights running on Cloudflare's own GPUs, in Cloudflare's data
  centers. `@cf/`-prefixed, priced in neurons on the Workers AI pricing page.
- **Third-party** — proxied. The request crosses Cloudflare's network only long enough to be
  logged and forwarded; **inference happens on the provider's hardware.** Priced at provider
  list. Often carries a zero-data-retention policy, which is not the same as the content not
  crossing.

Verified per model:

| Model | Badge |
|---|---|
| `qwen3-30b-a3b-fp8`, `gpt-oss-120b`, `gpt-oss-20b` | Cloudflare-hosted |
| `kimi-k2.5`, `kimi-k2.6`, `kimi-k2.7-code` | Cloudflare-hosted |
| `glm-4.7-flash`, `glm-5.2`, `nemotron-3-120b-a12b` | Cloudflare-hosted |
| `qwen3.5-397b-a17b`, `qwen3-max` | **Third-party** (Alibaba) |
| `kimi-k3` | **Third-party** (Moonshot) |
| `grok-4.5` | **Third-party** (xAI) |

**Decision (user-directed):** a third-party row means an R10 register entry, a U15
subprocessor-list entry and an R12 erasure leg. The rule is **not** "hosted only" — it is that a
content-touching third party must be a **tier-1 processor with real data-processing terms**, and
each one earns its entry individually. For a product whose pitch is tenant isolation, "strongest
model on the leaderboard" does not automatically earn it.

**Two qualify:**

- **OpenAI** — KTD8 embeddings, which see every chunk.
- **Google** — extraction, enrichment, contradiction. Justified on a fact specific to this
  product: the dominant content sources are Gmail, Calendar and Drive, so text sent to Gemini
  for extraction is text Google already holds. This is close to a non-disclosure rather than a
  new one. It is not unconditional — non-Google sources (chat exports, folder imports) flow
  there too, and consumer-Google is a different contracting entity from Google-Cloud-the-
  processor — so the register entry is real work, not a formality.

**Three were rejected on exactly this test:** `kimi-k3` (Moonshot), `qwen3.5-397b-a17b`
(Alibaba), `grok-4.5` (xAI). All ahead on paper; none a processor whose entry the
highest-volume content ops could justify. Where the hosted plane carries an op at no quality
cost it still does — salience, synopsis, vision, rerank and the judge never leave Cloudflare.

**If the residency line has to move back**, the hosted fallbacks are
`@cf/google/gemma-4-26b-a4b-it` ($0.133 blended, Apache 2.0, 256k ctx, native function calling,
structured output — but AA Intelligence Index 25.7) or `@cf/moonshotai/kimi-k2.6` ($1.458
blended, AA Index 54, the strongest open-weights model in the catalog and Cloudflare-hosted).
K2.6 is the quality-preserving retreat; Gemma 4 is the cheap one.

---

## 5. Per-op picks and why

Quality evidence for the tiers in play:

- **Gemini 3.5 Flash-Lite** (released 2026-07-21 alongside 3.6 Flash, 1M ctx, knowledge cutoff
  March 2026): Google's current budget tier, explicitly succeeding 3.1 Flash-Lite. The
  generation gap is the reason "cheapest Gemini" is not the pick — against 3.1 Flash-Lite it
  scores Terminal-Bench 2.1 **54% vs 31%**, GDM-MRCR v2 **72.2% vs 60.1%**, GDPval-AA v2
  **1140 vs 642**, for 31% more money.
- **Nemotron-3 Super 120B A12B** (hybrid Mamba-Transformer MoE, 12B active, 1M ctx, March 2026):
  IFBench 72.56, Arena-Hard-V2 73.88, Scale Multi-Challenge 55.23. Leads its size class on
  instruction following.
- **GLM-5.2** (1M ctx, released 2026-06-16): top open-weight on SWE-bench Pro at 62.1%, and beats
  Kimi K2.6 on 6 of 8 compared benchmarks — though the wins are AIME 2026, IMO-AnswerBench, GPQA,
  FrontierSWE, SWE-Bench Pro and HLE. Competition math and coding: wasted on a producer here,
  free in a judge.
- **Kimi K2.6** (1T MoE, 32B active, 262k ctx, 2026-04-20) — *not in the table, kept as the
  quality-preserving hosted fallback*: **54 on the Artificial Analysis Intelligence Index,
  highest of any open-weights model**, 54.0% HLE-Full with tools (ahead of GPT-5.4 at 52.1 and
  Claude Opus 4.6 at 53.0), 92.5% F1 DeepSearchQA, and **hallucination on AA-Omniscience down
  65% → 39% against K2.5**.

| Op | Was | Now | Blended | Plane | Reasoning |
|---|---|---|---|---|---|
| Extraction | Haiku 4.5 | `gemini-3.5-flash-lite` | 0.667 | third-party (Google) | Highest volume *and* unrecoverable errors — a fabricated fact enters the brain as truth and every later phase treats it as evidence. Current-generation, 1M context, and the content already originates at Google. |
| Enrichment | Sonnet 5 | `gemini-3.5-flash-lite` | 0.667 | third-party (Google) | Judgment from scattered evidence, and it *writes* the entity card everything else reads. |
| Contradiction | Sonnet 5 | `gemini-3.5-flash-lite` | 0.667 | third-party (Google) | False positives are a trust problem, so the failure mode is fabrication. The op most likely to want `gemini-3.6-flash` ($2.500) if its floor misses. |
| Salience | Haiku 4.5 | `nemotron-3-120b-a12b` | 0.667 | **CF-hosted** | Rubric scoring — instruction following is the whole job, and this leads its size class on it. 1M context scores a page's chunks in one call. |
| Synopsis | Haiku 4.5 | `nemotron-3-120b-a12b` | 0.667 | **CF-hosted** | Short summarization at chunk volume; same model as salience → one warm path, one batching strategy. |
| Image→text | Haiku 4.5 | `llama-3.2-11b-vision-instruct` | 0.154 | **CF-hosted** | Only priced CF-hosted vision model. `moondream3.1-9B-A2B` is the challenger — Moondream2 scores ScreenSpot 80.4 F1 / DocVQA 79.3, exactly U21's screenshot case — pending price confirmation. |
| Judge | Opus 5 | `glm-5.2` | 1.900 | **CF-hosted** | Never the family being judged. Zhipu is a different lab from both producers (Google, NVIDIA) — which is also why no Gemini model can hold this seat while Gemini produces. **Fixed platform cost**, sampled nightly on one canary tenant, so it should hold the best available model. |

### Nemotron-3 vs Gemini 3.5 Flash-Lite — the two producer families, compared

They are far closer than the price table implies, which is why the split costs nothing.

| | AA Intelligence Index | $/M in | $/M out | Context | Speed | Weights |
|---|---|---|---|---|---|---|
| Gemini 3.5 Flash-Lite | **37** | 0.300 | 2.500 | 1M | 391 tok/s (median for tier: 110.6) | proprietary, proxied |
| Nemotron 3 Super 120B A12B | **36** | 0.500 | 1.500 | 1M | slower than even Gemini 3.5 Flash | open, CF-hosted |

Reference points on the same index: Kimi K2.6 = 54, Qwen3.5 122B A10B = 42, gpt-oss-120b = 33.

**Watch for a conflation trap in third-party comparisons.** Several report Gemini 3.5 *Flash*
leading Nemotron by 19.6 on reasoning and 32.4 on coding — that is Flash, a larger and pricier
model, not Flash-Lite. The 37-vs-36 index is the apples-to-apples figure.

**The price shapes are opposite and the crossover is exact.** Gemini is 40% cheaper on input and
67% dearer on output. Solving `r(0.500) + 1.500 = r(0.300) + 2.500` gives **r = 5.0** — the
crossover sits precisely at the 5:1 ratio used for the blended column throughout this document,
which is why the two read as identically priced. The operative rule when reassigning an op:

- **input:output heavier than 5:1 → Gemini is cheaper** (salience, ~30:1 — a long rubric in, a
  score out)
- **lighter than 5:1 → Nemotron is cheaper** (synopsis, nearer 3:1 — a real summary out)

Gemini also has published prompt caching where Workers AI lists no cached rate for Nemotron; at
~70% cache hit on salience's stable rubric prefix that is roughly $1.95 → $1.34/user/month.
Nemotron's counterweights are open weights (portable, self-hostable, no lock-in) and the hosted
plane, which is worth a subprocessor entry.

**Why salience and synopsis stay on Nemotron anyway:** failure-mode diversity. If all five
producer ops run one model, a systematic weakness propagates through every phase identically —
and the eval cannot see it, because no unbiased phase remains to contrast against. At a
one-point index gap and a per-op cost split that cancels out across the pair, two families
across five phases is insurance that costs nothing.

**Caveat on the tie itself:** the AA Index composites reasoning, knowledge, maths and coding.
None of those is "pull entities out of an email thread." A one-point gap establishes that these
are the same class, not which is better at brainz's ops — U7's floors decide that, and the beta
A/B settles it against the real corpus.

**Rejected, and why:** `gemini-3.1-flash-lite` (31% cheaper, a generation behind, and the
benchmark gaps above are not marginal), `kimi-k3` / `qwen3.5-397b-a17b` / `grok-4.5` (all
third-party processors that could not justify a register entry — see §4), `glm-5.2` as a
*producer* (its wins are in domains brainz does not touch), `kimi-k2.5` (65% AA-Omniscience
hallucination rate disqualifies it even at $1.000 blended), `gemma-4-26b-a4b-it` as the
extraction default (hosted and cheap at $0.133, but AA Intelligence Index 25.7 is a real step
down where hallucination is the failure that matters — it stays the cheap hosted fallback).

**Aggregate:** ~$10–11/user/month against ~$39 on the Anthropic table, before prompt-cache
discounts. Order-of-magnitude, derived from published prices and an assumed consolidation volume
(~6,000 items/month at ~1,200 in / 200 out) — not measured.

**This is deliberately not the cheapest table.** A floor-seeking variant
(`granite-4.0-h-micro` / `qwen3-30b-a3b-fp8` / `gpt-oss-120b`) costs ~$3.44/user/month. The gap
buys a diagnostic property for alpha: with a current-generation model in every seat, an R6 floor
miss indicts the architecture rather than the model tier. The cost-down A/B then runs **between
alpha and beta**, stepping each op down against the founder's real corpus and keeping the
cheapest tier that still clears its floor. It is scored on **two** axes, not one: every op a
hosted model can carry at no measured quality cost is also one fewer subprocessor entry, so price
and residency optimize together.

---

## 6. Rerank: the price that changes a decision

KTD4 budgeted **$1.50–3/active user/month** for rerank and carried "self-host a small
cross-encoder on the worker fleet when it matters" as the contingency.

At `bge-reranker-base`'s $0.003/M input:

- 100 candidates × 400 tokens = 40k tokens/query = **$0.00012/query**
- At ~860 queries/month (the plan's single-power-user anchor) = **~$0.10/user/month**
- Roughly **15–30× under the envelope**

The self-hosting contingency is no longer cost-driven. The open question moves to quality:
`bge-reranker-base` is a 278M-parameter cross-encoder, and KTD4 was justified on rerank
reshuffling ~60% of top-1. U12's A/B measures whether this reranker delivers that, with a
stronger reranker as the escalation.

---

## 7. Embeddings: OpenAI

**Decision (user-directed):** OpenAI, replacing gbrain's `zembed-1`.

### The pgvector constraint

| Type | HNSW-indexable dimensions |
|---|---|
| `vector` | 2,000 |
| `halfvec` | 4,000 (16-bit floats, ~50% storage, similar recall) |
| `bit` | 64,000 |

`text-embedding-3-large` is natively **3072d** — it cannot be HNSW-indexed as `vector`. Two
escapes: Matryoshka truncation to 1536d, or `halfvec(3072)`.

### Why truncation wins

| Option | Dim | $/M | MTEB |
|---|---|---|---|
| `text-embedding-3-large` native | 3072 | 0.13 | 64.6% |
| `text-embedding-3-large` truncated | 1536 | 0.13 | ~63.0% (−1.6%) |
| `text-embedding-3-small` | 1536 | 0.02 | 62.3% |

3-large@1536 beats 3-small at **identical index cost**. It also makes KTD8's A/B free of a
column migration, since both candidates are 1536d — which is exactly the "prefer
same-dimension challengers" rule KTD8 already stated.

Both models support Matryoshka truncation to 256/512/1024/1536.

### The cost is latency, not price

Price is noise: embedding is one-time-per-chunk, and a 50k-chunk first import is ~$2.60 on
3-large vs ~$0.40 on 3-small vs ~$1.00 on `zembed-1`.

Latency is not noise. gbrain measured **OpenAI at 973ms vs `zembed-1`'s 442ms**, and query
embedding sits on the read path's critical section where `entity`'s p99 promise lives. There
is no partial mitigation available at the model layer — query and document must share an
embedding space, so a fast local query encoder is a correctness bug, not a latency trade. The
available mitigations are a query-embedding cache and restating the promise. Filed as
**Assumption 5**, verified in U5.

---

## Sources

- [Cloudflare AI model catalog](https://developers.cloudflare.com/ai/models) — 217 models, 6 partner providers + Cloudflare-hosted
- [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) — neuron rate, per-model USD/neuron tables
- [Workers AI + AI Gateway unified billing (2026-08-07)](https://developers.cloudflare.com/changelog/post/2026-08-07-workers-ai-unified-billing/)
- [AI Gateway BYOK / Secrets Store](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
- [pgvector](https://github.com/pgvector/pgvector) + [Supabase HNSW index docs](https://supabase.com/docs/guides/ai/vector-indexes/hnsw-indexes) — 2,000d `vector` / 4,000d `halfvec` index limits
- [OpenAI new embedding models](https://openai.com/index/new-embedding-models-and-api-updates/) — MTEB scores, Matryoshka dimensions
- [OpenAI embedding pricing](https://embeddingcost.com/openai)
- [Anthropic API pricing 2026](https://benchlm.ai/anthropic/api-pricing)
- [OpenAI API pricing 2026](https://pricepertoken.com/pricing-page/provider/openai)
- [Gemini API pricing 2026](https://benchlm.ai/google/api-pricing)
- [Gemini 3.6 Flash + 3.5 Flash-Lite launch, 2026-07-21](https://9to5google.com/2026/07/21/gemini-3-6-flash-launch/) — 3.5 Flash-Lite succeeds 3.1 Flash-Lite as the budget tier
- [Gemini 3.1 vs 3.5 Flash-Lite benchmarks](https://llm-stats.com/models/compare/gemini-3.1-flash-lite-preview-vs-gemini-3.5-flash-lite) — Terminal-Bench 2.1, GDM-MRCR v2, GDPval-AA v2 deltas
- [Gemma 4 26B A4B](https://benchlm.ai/models/gemma-4-26b-a4b) — hosted Google fallback; AA Intelligence Index 25.7, IF 0.724
- [Gemini 3.5 Flash-Lite on Artificial Analysis](https://artificialanalysis.ai/models/gemini-3-5-flash-lite) — AA Index 37, 391 tok/s
- [Nemotron 3 Super on Artificial Analysis](https://artificialanalysis.ai/models/nvidia-nemotron-3-super-120b-a12b) — AA Index 36, ahead of gpt-oss-120b (33), behind Qwen3.5 122B A10B (42)
- [gpt-oss-120b vs Qwen3-30B-A3B benchmarks](https://llm-stats.com/models/compare/gpt-oss-120b-vs-qwen3-30b-a3b)
- [GLM-5.2 vs Kimi K2.6 benchmarks](https://llm-stats.com/models/compare/glm-5.2-vs-kimi-k2.6) — the 6-vs-2 benchmark split, and which benchmarks
- [Kimi K2.6 overview](https://blog.kilo.ai/p/kimi-k26-has-arrived-an-open-weight) — AA Intelligence Index 54, HLE-Full 54.0%, DeepSearchQA 92.5% F1, AA-Omniscience hallucination 65% → 39%
- [NVIDIA Nemotron-3 Super 120B A12B](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16) + [technical report](https://arxiv.org/pdf/2604.12374) — IFBench 72.56, Arena-Hard-V2 73.88
- Third-party alternatives considered and rejected: [Qwen3.5 397B A17B pricing](https://benchlm.ai/alibaba/api-pricing), [Grok 4.5 pricing](https://benchlm.ai/xai/api-pricing), [Kimi K3 pricing](https://pricepertoken.com/pricing-page/model/moonshotai-kimi-k3)
- [Cloudflare partner-model delivery architectures](https://blog.cloudflare.com/ai-platform/) — hosted vs partner vs proxied
- [IBM Granite 4.0 H Micro](https://huggingface.co/ibm-granite/granite-4.0-h-micro) — 3B hybrid, tool calling, 131k ctx
- Vision/OCR comparison: [local vision models 2026](https://www.promptquorum.com/power-local-llm/local-vision-models-llava-ollama-2026), [OCR model rankings 2026](https://ofox.ai/blog/best-ai-model-for-ocr-2026/)
