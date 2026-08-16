# The eval corpus and the gates (U7)

This directory is the **measurement apparatus** R6, R6a and KTD10 call for: an
owned fixture corpus, a gold answer key, per-question-type query sets, the metric
implementations the floors are expressed in, both R6a calibration receipts —
and, since U6 landed, the gates that turn all of it into commands.

The two halves were built in that order on purpose (see "Why the corpus is here
before U5 exists" below). The gates half needed a running server, so it lands
here now:

| Command | What it is | Where it runs |
|---|---|---|
| `bun run eval:blocking` | R6's floors, plus U12's rerank leg (the shipped configuration) and briefing leg. Deterministic, zero model calls. | CI, every PR |
| `bun run conformance` | gbrain's runner at the pinned commit, graded against the published `memory-verbs-v1-partial` delta. | CI, self-skipping while the delta records a blocker |
| `bun run eval:live-parity` | Re-embeds and re-scores a sample through the production `src/ai/` path. | scheduled, secret-gated |
| `bun run eval:canary` | The nightly model-judged tier, routed as the `judge` op. | nightly, non-blocking |
| model-id pin guard | Every op of every profile is pinned by a receipt or deferred with an owner. | part of `bun test` |

`package.json` is unchanged: U1 pointed every declared command at
`scripts/not-yet.ts` so that "only the script body" would change when an
implementation landed, and that file is now the router. A command still owned by
a later unit (`test:roundtrip`, U17) prints exactly what it always printed and
exits non-zero — a stub that passes makes an unimplemented gate look green.

**Every one of these commands fails closed.** No provider vectors to compare, no
gradeable canary check, no resolvable runner, a delta that was never observed:
each is a non-zero exit naming the reason, never a green tick for having measured
nothing. The *workflows* decide whether a run is worth invoking, using the
precondition-step pattern `real-substrate.yml` already shipped. That split is
deliberate — a gate that quietly excuses itself is the failure mode this whole
unit exists to prevent, and a scheduled job that fails by design is one everybody
learns to ignore.

## Why the corpus is here before U5 exists

From U7's dependency line, and it is the load-bearing part:

> The corpus half … is authored **before U5** so the definition of "accurate"
> cannot drift toward whatever the ranking stack already does.

R6a's lower-bound receipt guards against a *trivially easy* corpus. It cannot
guard against an *implementation-shaped* one — a corpus that is hard for a naive
baseline and still quietly tuned to the arms that were just built. Sequence is
the only defence against that, so this corpus was authored, calibrated and
committed with no ranking stack in the repository to tune toward.

## What is in here

| File | What it is |
|---|---|
| `fixtures/types.ts` | The shapes, with every closed set copied from the tenant DDL. |
| `fixtures/brain.ts` | The seeded synthetic brain: 64 pages, 7 people, 6 organisations, 2 projects, a typed edge graph, superseded temporal facts, one contradiction, five cross-origin duplicate clusters, one soft-deleted page and one quarantined one. |
| `fixtures/queries.ts` | 77 queries with gold keys and per-query answerability audits. |
| `fixtures/extraction.ts` | Which deterministic rule family would extract each fact. |
| `fixtures/embeddings.manifest.jsonl` | The committed embedding manifest (see below). |
| `fixtures/embeddings.provider-sample.jsonl` | Two rows in the shape real provider vectors arrive in. |
| `fixtures/rerank-scores.manifest.jsonl` | The committed cross-encoder scores (see below). |
| `fixtures/rerank-scores.provider-sample.jsonl` | One row in the shape real cross-encoder scores arrive in. |
| `corpus.ts` | The loader, which is really the validator. Fails closed, in both directions. |
| `metrics.ts` | nDCG@10, Hit@k, the dilution metric, duplicate-occupancy. |
| `lexical-reach.ts` | Which gold answers this corpus offers a **keyed** path to, and which ones only meaning can reach. |
| `embeddings.ts` | The embedding fixture format, the synthetic generator, the verifying loader. |
| `run.ts` | The harness and the `Ranker` interface U5 implements. |
| `baselines.ts` | Two naive single-arm baselines and the gold oracle. |
| `gates.ts` | R6's floors and R6a's margins, as data, plus the checker and the three-state classifier. |
| `extraction.ts` | The rule-coverage baseline for R6's deterministic-extraction floor. |
| `calibrate.ts` | Regenerates both receipts. |
| `blocking.ts` | The blocking tier as a command: two runs, one digest, `fetch` trapped, three legs. |
| `rerank-scores.ts` | The committed cross-encoder score format, its generator, and the verifying loader. |
| `rerank-ab.ts` | U12's rerank on/off A/B, the cost line from the canonical table, and the two deferrals. |
| `briefing.ts` | Briefing-shaped fixtures: participant-card completeness and delta correctness, over the pure assembler. |
| `live-parity.ts` | The scheduled parity job and its comparison rules. |
| `live-parity-tolerance.json` | The divergence thresholds, as committed data with their rationale. |
| `canary.ts` | The judged tier's harness: judge independence, gradeability, recall scoring. |
| `model-pins.ts` | The model-id pin guard (KTD13). |
| `conformance/` | The gbrain wrapper: pin verification, checkout resolution, the local server, the delta assertion. |
| `receipts/` | The committed R6a receipts and `model-ids.json`, the pin ledger. |

## Running it

```bash
bun run evals/regenerate-embeddings.ts   # rewrite the embedding manifest
bun run evals/calibrate.ts               # recompute both R6a receipts
bun test test/evals/                     # the guards, including a real-Postgres seed
```

`calibrate.ts` exits non-zero if either receipt fails to clear. `test/evals/`
recomputes both receipts and diffs them against what is committed, so a corpus
edit that moves a number and is not accompanied by a regenerated receipt turns
the suite red.

## The two calibration receipts

Read `receipts/README.md` for the tables. In summary:

- **Lower bound.** The strongest of two naive single-arm baselines (BM25 over
  chunk content; cosine over the committed vectors) sits at or below every floor
  minus a committed margin. Taking the *strongest* arm rather than a chosen one
  is deliberate — picking the weaker arm would make the receipt whose job is to
  prove the corpus is hard into the thing that is easy.
- **Upper bound.** The gold key, scored through the same metric functions, hits
  the theoretical maximum on every floor, and every query in every question type
  carries an evidence chain naming stack mechanisms that are validated against
  `upstream/concepts.jsonl` — including that each mechanism's owning unit lands
  by U5. A query answerable only by U11's or U12's machinery would make a U5
  floor miss look like an architecture failure, which is precisely the misreading
  R6a exists to prevent.

One open finding is recorded rather than resolved: the deterministic-extraction
rule coverage is **exactly 0.80** against R6's 0.8 floor, so that floor is a
knife edge on this corpus. See the `finding` field in the lower-bound receipt.

## Which floors are provable today

**Two of R6's five blocking floors are not currently being measured, and the
suite says so on every run.** They are reported `deferred`: neither met nor
quietly excused.

| floor | state | why |
|---|---|---|
| aggregate nDCG@10 ≥ 0.65 | **met and enforced** | |
| title-substring Hit@1 ≥ 0.95 | **met and enforced** | |
| relational / named-entity / temporal / context-fenced nDCG@10 ≥ 0.65 | **met and enforced** | a mean has no probe responsible for it, so these can never be deferred |
| alias Hit@1 ≥ 0.98 | **deferred** | two of the fourteen probes need semantic recall (`q-al-03`, `q-al-08`) |
| dilution Hit@3 = 1.0 | **deferred** | two of the ten probes need semantic recall (`q-di-09`, `q-di-10`) |
| deterministic extraction recall ≥ 0.8 | **not scored here** | it belongs to U6's extractor; the rule-coverage baseline is in the lower-bound receipt |

**Why those four probes.** The committed vectors are synthetic (see the next
section), so the vector arm is a second keyword arm. Each of the four has a gold
answer this corpus offers no *keyed* path to: some content word the query
supplies appears nowhere on the answer's page, and what the answer does carry is
shared with at least as many other things as the metric has slots. The clearest
case is `p-pilot-outcome`, the only page about the Windbreak pilot that never
contains the word "Windbreak" — with lexical recall alone there is no route to
it at all. The full derivation is `lexical-reach.ts`; the per-probe evidence is
printed by the suite and recorded in the lower-bound receipt.

**The deferral cannot rot.** It is conditional on `EmbeddingIndex.sources`,
counted row by row from the manifest: one provider vector anywhere and every
floor is enforced again, with no edit and nothing to remember. It is refused for
any floor whose metric is a mean, for any floor with one reachable probe among
its misses, and for any floor that would pass — a deferred floor at or above its
bar is a `stale_deferral` violation. And the exact set is pinned in
`test/core/search/floors.test.ts`, so a floor that starts or stops being deferred
is red until somebody says so in writing.

**What regenerating embeddings will change.** The four probes above become
answerable by the vector arm — that is the whole point of the arm — and both
floors are enforced at their full value, whatever it turns out to be. It may be
lower than 0.98 and 1.0 on the first run; that is a real measurement of the stack
and the honest place to start. Both R6a receipts must be recomputed at the same
time, because the vector-arm baseline is a function of the vectors.

## Embeddings: what is real and what is a stand-in

**No embedding provider is reachable from this environment.** U7 step 1 requires
committed embeddings under KTD8's model with both asymmetric encodings, so the
corpus half ships the **format** in full, a **deterministic synthetic generator**,
and per-vector digests in the manifest. Regenerating produces byte-identical
files; there is no network call anywhere in the eval path.

The synthetic vectors are hashed lexical projections. **They carry lexical signal
and not semantic signal.** A real `text-embedding-3-large` vector places "who is
Sam" near a page about Samantha Okonkwo; a synthetic one does not, because the
strings share no tokens. Under this fixture the alias, relational and paraphrase
probes must therefore be reached by the alias hop and the graph arm.

**When a provider becomes reachable:**

1. Re-encode every chunk and fact with the `document` input type and every query
   with the `query` input type, truncating to 1536 through the API's `dimensions`
   parameter — **never by slicing client-side**, which returns a vector that is
   no longer unit length and silently changes distance semantics.
2. Write the rows with `source: "provider"` and a populated `vector_b64`.
   Provider vectors cannot be regenerated from committed text, so from then on
   the floats themselves are the committed artifact and the manifest grows by
   roughly 8 KB per vector.
3. **Recompute both R6a receipts.** The vector-arm baseline is a function of the
   vectors; it will get stronger and the margins will narrow. The upper bound
   will not move, because it does not read vectors.
4. Re-run `test/evals/` — the freshness and drift guards are what make steps 1–3
   impossible to forget.

## The floors and the embedding seat

The fixture's vector width is not a constant: `evals/embeddings.ts` builds every
synthetic vector at `EMBEDDING_DIMENSIONS`, which is now derived from the active
embedding seat (`src/schema/embedding-seat.ts`). A second seat is registered, at
1024 dimensions, and this section records what that does and does not mean for
the numbers above.

**The committed floors were NOT re-baselined, and that is the honest choice
rather than the lazy one.** The active seat is still the 1536 one — the 1024 seat
is refused at provisioning while `fact.embedding` is `vector(1536) NOT NULL`, see
`upstream/concepts.jsonl:gap.cloudflare-embedding-seat` — so the committed numbers
are the numbers of the configuration that actually runs. Replacing them with
numbers from a seat no tenant is provisioned at would be committing a measurement
that describes nothing.

**What the floors read at 1024 was measured, and it is recorded here rather than
committed as a receipt**, because a receipt is a claim about a configuration and
there is no configuration this would be a claim about. Procedure: set the active
seat's `dimensions` to 1024, run `bun run evals/regenerate-embeddings.ts`, then
`bun run eval:blocking`. Measured on the corpus at manifest digest `fabb3db916ae`:

| floor | at 1536 | at 1024 | status at both |
|---|---|---|---|
| aggregate.ndcg10 | 0.8269 | 0.8157 | MET |
| family.title_substring.hit1 | 1.0000 | 1.0000 | MET |
| family.alias.hit1 | 0.8571 | 0.7143 | DEFERRED |
| family.dilution.hit3 | 0.8000 | 0.7000 | DEFERRED |
| type.relational.ndcg10 | 0.7992 | 0.7882 | MET |
| type.named_entity.ndcg10 | 0.9005 | 0.8884 | MET |
| type.temporal.ndcg10 | 0.8214 | 0.7916 | MET |
| type.context_fenced.ndcg10 | 0.7397 | 0.7446 | MET |

**No floor changed status, and in particular no deferral became a pass.** That
was the thing worth checking: the two deferred floors are deferred on the
provider count being zero, which a width change cannot move, and both got *worse*
rather than better.

**What these numbers are not.** They are not a comparison of two models. Every
vector on both sides is synthetic — a hashed lexical projection at the stated
width — so the movement is the fixture's own hash spreading over fewer buckets,
and nothing here has observed `@cf/qwen/qwen3-embedding-0.6b` at all. Reading the
1024 column as "the new seat is slightly worse" would be reading a property of
`evals/embeddings.ts` as a property of a model. The A/B that
`gap.cloudflare-embedding-seat` waits on is a comparison of two *provider*
manifests, and it stays unowed until step 1 above has been run twice.

## Cross-encoder scores: what U12 committed, and what it refused to claim

The other half of U7 step 1 landed at U12, and the objection U7 recorded against
committing it — "an artifact nothing reads, in the shape of a measurement" — was
answered by the first half of it and not the second.

**What reads it now.** `fixtures/rerank-scores.manifest.jsonl` carries one
verified score vector per query over every candidate in corpus order, and the
blocking tier's **rerank leg** replays it on every run: the shipped
configuration, stages 12 and 13 on, over the same corpus as the baseline leg.
That is what stops the nDCG floor measuring a pipeline production no longer
runs.

**What it still does not claim.** Every row is `source: "synthetic"`, produced by
a thirty-line joint-lexical generator standing in for a 278M-parameter
cross-encoder. Stage 12 sorts by that score *and nothing else*, so an A/B over a
stand-in measures the stand-in — and it does: the committed receipt
(`receipts/u12-rerank-ab.json`) records a delta of **−0.161 aggregate nDCG@10**,
with title-substring Hit@1 falling from 1.000 to 0.100. That is evidence about
the generator, not about `@cf/baai/bge-reranker-base`, so `uplift_status` is
`deferred` and the number is carried as the reason.

Three things therefore hang off one switch — `sources.provider`, counted from
the manifest rather than declared:

| while `provider` is 0 | on the first provider-sourced row |
|---|---|
| the rerank leg's floors are **reported**, the baseline leg carries the enforced ones | the rerank leg's floors **enforce** |
| the A/B receipt says `deferred` | it says `measured` |
| `eval:live-parity`'s rerank leg refuses | it compares |

None of them needs an edit. Regenerate with
`bun run evals/regenerate-rerank-scores.ts`; the receipt with
`bun run evals/rerank-ab.ts`. Both are idempotent, both make no network call,
and `test/evals/rerank-leg.test.ts` / `test/evals/briefing-leg.test.ts` fail on a
stale one.

**The p99 latency KTD4 asks for is not here and cannot be**: it is a measurement
from a deployed container. The receipt records it `deferred` and names the run
that would produce it.

## What the gates cannot see, and what watches that

The blocking tier is deterministic **because** the vectors are committed, which
means it grades the *consumers* of those numbers and never the invocations that
produce them. A swapped asymmetric prefix, a changed `dimensions` value, or a
client-side truncation that skips re-normalisation all score identically here
while real recall degrades — that is Gap #16, and it is the price of the
zero-model-call promise rather than a bug in it.

`bun run eval:live-parity` is what watches that boundary: it re-invokes both read-path
model stages through the production `src/ai/` path and fails on divergence beyond
`live-parity-tolerance.json`. Today it refuses — the manifest carries no
provider-sourced vector, so there is nothing to compare — and **that refusal is
the honest state of the two highest-leverage read stages: they have no live
coverage anywhere.** The scheduled workflow asks before invoking, so this is a
notice rather than a nightly red.

## Notes on how the corpus is built

- **Every person, company and address is invented**, and every email address is
  on `example.com`. The repository is public and the corpus is committed.
- **The corpus is adversarial on purpose.** Title-substring probes have body-text
  decoys denser than the titled page; alias probes collide with a literal lexical
  match (there is a second, different person called Sam); temporal probes put the
  *stale* answer in the denser page; relational probes never state the
  relationship next to the query's terms; dilution probes have the same content
  arriving through two or three credentials.
- **A large population of question-shaped chat and mail rows** mirrors the query
  set and answers nothing. That is what conversational memory actually looks
  like, and it is also the most effective decoy against a keyword arm — which is
  recorded as a threat to validity in the lower-bound receipt, because part of
  what the floors then reward is telling a question from an answer.
- **Two pages are invisible on purpose** — one soft-deleted (R12), one
  quarantined (U9) — and both are strong lexical matches for live queries.
  Returning either is a *violation*, not a low score.
- **A probe's `mechanisms` list is a claim, and it is checked behaviourally.**
  `test/core/search/mechanism-sensitivity.test.ts` turns each named mechanism off
  and re-grades the probe; a probe whose ranking is unchanged with all of them
  off is not grading any of them, whatever its evidence sentence says. Twenty
  probes are in that position and are listed there with reasons — ten
  title-substring probes are answered by the alias ladder's exact-title rung
  rather than by the title boost they name. The file also records that
  `stack.corroboration-boost` cannot fire anywhere in this corpus, because no
  fixture row carries an attestation kind that corroborates.
- **The full-text stand-in recalls more than production does.** The fixture's
  BM25 arm scores every chunk sharing any query term; production's
  `websearch_to_tsquery` ANDs its terms and recalls only chunks carrying all of
  them. These floors therefore flatter the fleet on multi-term queries — measured
  at 0.8269 → 0.7616 aggregate, with the context-fenced floor going below its bar.
  Recorded in the lower-bound receipt's threats to validity; closing it is stack
  work rather than fixture work.
- **The origin fence is the ranker's job, not the harness's.** The harness hands
  every ranker the whole corpus; the query carries its grant; a result outside it
  is counted, named and fatal at the gate. If the harness filtered, a ranker that
  ignored R15 entirely would score identically to one that honoured it.
