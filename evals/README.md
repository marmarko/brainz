# The eval corpus (U7, corpus half)

This directory is the **measurement apparatus** R6, R6a and KTD10 call for: an
owned fixture corpus, a gold answer key, per-question-type query sets, the metric
implementations the floors are expressed in, and both R6a calibration receipts.

It is deliberately **only the corpus half of U7**. The gates half — CI wiring for
`bun run eval:blocking`, the gbrain conformance wrapper, the nightly canary tier,
the model and embedding A/Bs, the live-model parity job, and the model-id pin
guard — needs a running server (U6) and lands later. `eval:blocking` is still the
failing `scripts/not-yet.ts` stub, on purpose: an unimplemented gate must never
look green.

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
| `corpus.ts` | The loader, which is really the validator. Fails closed, in both directions. |
| `metrics.ts` | nDCG@10, Hit@k, the dilution metric, duplicate-occupancy. |
| `embeddings.ts` | The embedding fixture format, the synthetic generator, the verifying loader. |
| `run.ts` | The harness and the `Ranker` interface U5 implements. |
| `baselines.ts` | Two naive single-arm baselines and the gold oracle. |
| `gates.ts` | R6's floors and R6a's margins, as data, plus the checker. |
| `extraction.ts` | The rule-coverage baseline for R6's deterministic-extraction floor. |
| `calibrate.ts` | Regenerates both receipts. |
| `receipts/` | The committed R6a receipts. |

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

Cross-encoder scores for every (query, candidate) pair are the other half of
U7 step 1. They are **not** here: they belong to the gates half, which needs a
running server. Their absence is a sequencing decision, not an oversight.

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
- **The origin fence is the ranker's job, not the harness's.** The harness hands
  every ranker the whole corpus; the query carries its grant; a result outside it
  is counted, named and fatal at the gate. If the harness filtered, a ranker that
  ignored R15 entirely would score identically to one that honoured it.
