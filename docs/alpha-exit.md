# Alpha-exit checklist

**Status: the alpha has not been exited.** Nothing in this document claims it
has. What follows is the checklist itself, derived clause by clause from the
"Alpha done" bullet in
[`docs/plans/2026-08-11-001-feat-brainz-v1-roadmap-plan.md`](plans/2026-08-11-001-feat-brainz-v1-roadmap-plan.md),
with an honest status against each line and a way to check it that is either a
command or a committed file.

Every line falls into one of three groups, and the split is the point:

- **[A] Automated and green today** — a command anyone can run, with a receipt.
- **[B] Automated but deferred, waiting on authorised spend** — the harness is
  built, wired and fails closed; nothing has graded anything because the money
  has not been approved. Each line names what it costs and what it would prove.
- **[C] Only a human can produce it** — the two-week bake and the non-founder
  usability test. These are not gaps in tooling. They are the falsification
  points the whole consumer thesis rests on.

**Counts: 8 in group A, 9 in group B, 5 in group C.**

A line moving from B to A costs money. A line moving from C to A is not
possible; C is where the product stops being a system and starts being a
claim about people.

---

## Group A — automated and green today

Run from the repository root. All eight are observed, not asserted.

### A1. Types

```bash
bun run typecheck
```

Exit 0. Runs in CI as the `Typecheck` step of
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

### A2. Unit tests, hazard guards and isolation cases

```bash
bun test
```

Green in CI, where a Postgres 17 + pgvector service is running and
`DATABASE_URL` points at it. **On a machine without one it is not green** — the
last local run was 1307 pass / 110 fail across 1418 tests, and every failure was
a connection refusal against the default `postgres://postgres@localhost:5432/brainz_test`.
Start a Postgres with pgvector, or read this line off CI. Do not read a local
red as a code failure without checking the error class first.

### A3. Accuracy floors (R6)

```bash
bun run eval:blocking
```

Exit 0, zero model calls, two ranker legs (baseline and the shipped
configuration) plus a briefing leg. Runs in CI as `Accuracy floors (R6)`.

**Green as a command is not the same as "all R6 floors green".** Two of the
five blocking floors report `deferred` rather than met:

| floor | state |
|---|---|
| aggregate nDCG@10 ≥ 0.65 | met and enforced |
| title-substring Hit@1 ≥ 0.95 | met and enforced |
| per-question-type nDCG@10 ≥ 0.65 (relational, named-entity, temporal, context-fenced) | met and enforced |
| alias Hit@1 ≥ 0.98 | **deferred** |
| dilution Hit@3 = 1.0 | **deferred** |
| deterministic-extraction recall ≥ 0.8 | not scored by this tier |

Both deferrals are conditional on the committed embeddings being synthetic, and
both revoke themselves the moment one provider-sourced vector lands — see
[B1](#b1-regenerate-the-embedding-manifest-from-a-real-provider). Until then,
the Alpha-done clause "all R6 floors green" is **not satisfied**, and this
checklist should not be read as saying otherwise.

### A4. Concepts ledger

```bash
bun run ledger:check
```

Exit 0. No unclassified capability, no passed revisit date. Runs in CI as
`Concepts ledger`.

### A5. Wire conformance

```bash
DATABASE_URL=... bun run conformance
```

Runs in CI as the `wire conformance (memory-verbs-v1-partial)` job, against
gbrain's runner at the commit pinned in `upstream/gbrain.pin`. It needs a real
database — without `DATABASE_URL` it refuses by design, on the grounds that a
verdict produced against a stand-in engine is not a conformance verdict.

### A6. Calibration receipts (R6a)

Committed at
[`evals/receipts/r6a-lower-bound.json`](../evals/receipts/r6a-lower-bound.json)
and
[`evals/receipts/r6a-upper-bound.json`](../evals/receipts/r6a-upper-bound.json).
Regenerate with `bun run evals/calibrate.ts`; `test/evals/receipts.test.ts`
recomputes both and fails on any difference.

Lower bound clears every floor by its committed margin. Upper bound attains
every floor. One finding is recorded rather than resolved: deterministic-extraction
rule coverage is **exactly 0.800** against a floor of 0.8, which is a knife
edge — one miss fails it.

### A7. Model-id pins

Committed at [`evals/receipts/model-ids.json`](../evals/receipts/model-ids.json),
guarded by `test/ai/model-id-pin.test.ts` as part of `bun test`. Every op of
every routing profile is either pinned by a receipt or deferred with a named
owner.

### A8. Phase 0 probe receipts

- [`scripts/probes/r2-boundary/RESULT.md`](../scripts/probes/r2-boundary/RESULT.md)
  — the object-storage boundary, with its literal-prefix caveat.
- [`scripts/probes/container-tcp/RESULT.md`](../scripts/probes/container-tcp/RESULT.md)
  — raw outbound TCP from a deployed container.

---

## Group B — automated, deferred, waiting on authorised spend

Each of these is built, wired and **fails closed**: it exits non-zero and names
the reason rather than reporting a green tick for having measured nothing. None
of them has graded anything.

Group B has a dependency order. B1 and B2 are upstream of most of the rest.

### B1. Regenerate the embedding manifest from a real provider

```bash
bun run evals/regenerate-embeddings.ts   # against a reachable provider
bun run evals/calibrate.ts               # both R6a receipts must be recomputed
bun run eval:blocking
```

**Cost:** one embedding pass over the fixture corpus — 332 vectors, the
cheapest line in group B by a wide margin.

**What it would prove:** that the alias and dilution floors ([A3](#a3-accuracy-floors-r6))
are met rather than deferred, at whatever value they turn out to hold. Four
probes across those two families have a gold answer this corpus offers no
keyed path to; they need semantic recall, which synthetic hashed-lexical
vectors do not carry. It also makes [B3](#b3-live-model-parity) able to compare
anything at all.

**What it would cost you to skip:** the Alpha-done clause "all R6 floors green"
stays unsatisfiable, and the two highest-leverage read stages keep having no
live coverage anywhere.

### B2. Regenerate the cross-encoder scores from a real provider

```bash
bun run evals/regenerate-rerank-scores.ts   # against `@cf/baai/bge-reranker-base`
bun run evals/rerank-ab.ts                  # rewrites the A/B receipt
```

**Cost:** one rerank pass over the fixture corpus — 77 queries × the candidate
set. At the measured rate in the committed receipt this is a fraction of a cent.

**What it would prove:** whether reranking helps. Today it is unmeasured and
the committed receipt
([`evals/receipts/u12-rerank-ab.json`](../evals/receipts/u12-rerank-ab.json))
carries `uplift_status: "deferred"` with the reason attached: every committed
score is synthetic, produced by a thirty-line lexical generator standing in for
a 278M-parameter cross-encoder. Used as the stage uses it — as the sole sort key
— the stand-in is **worse** than the stack it reranks: −0.161 aggregate nDCG@10,
with title-substring Hit@1 falling from 1.000 to 0.100.

That number is evidence about the generator and about nothing else. It is also
the reason the rerank leg's floors are currently *reported* rather than
enforced. One provider-sourced score flips the receipt to `measured`, flips the
leg to enforcing, and un-refuses live parity's rerank comparison — with no edit
to anything.

**Read this before treating rerank as a shipped win.** Rerank and autocut are
wired and on in the shipped configuration. Their quality contribution against a
real cross-encoder has never been measured. Autocut reads the rerank score and
nothing else, so the two cannot be separated: turning rerank off to recover
latency also turns off result sizing.

### B3. Live-model parity

```bash
BRAINZ_REAL_SUBSTRATE=1 bun run eval:live-parity
```

Scheduled nightly in
[`.github/workflows/real-substrate.yml`](../.github/workflows/real-substrate.yml),
which asks whether there is anything to compare before invoking it.

**Cost:** re-embedding and re-scoring a sample through the production path.
Small, and gated on B1 and B2 having produced something to compare against.

**What it would prove:** the boundary the blocking tier structurally cannot
see. The blocking tier is deterministic *because* the vectors are committed,
which means it grades the consumers of those numbers and never the invocations
that produce them. A swapped asymmetric prefix, a changed dimension count, or a
client-side truncation that skips renormalisation all score identically there
while real recall degrades. This is the only check that looks.

Today it refuses: nothing provider-sourced exists to compare.

### B4. The KTD13 exit gate — the consolidation ops

```bash
BRAINZ_REAL_SUBSTRATE=1 \
BRAINZ_CANARY_TENANT=<tenant> \
BRAINZ_EXIT_GATE_AUTHORISED=yes \
bun run eval:canary
```

`bun run eval:canary --preflight` prints how many checks are gradeable and
exits 0 without spending anything. Use it first.

**Cost: $1.005484 for one full run**, committed as an estimate at
[`evals/receipts/u11-exit-gate-cost.json`](../evals/receipts/u11-exit-gate-cost.json)
and computed from the canonical pricing table rather than guessed. The estimate
projects every op at its output-token ceiling — the direction a run cannot
exceed while believing it is inside the estimate. The largest single line is
extraction at $0.62; the judge that grades the six is $0.19; the vision seat
folded in from [B5](#b5-the-live-vision-call) is $0.02.

**What it would prove:** that `extract`, `enrich`, `contradiction`, `salience`,
`synopsis` and `vision` each clear the canary-tier floor of 0.8, with a
committed receipt per op naming the pinned model id it was scored against. The table runs
a current-generation model in every seat precisely so that a floor miss indicts
the architecture rather than the model tier — which is only true if the receipt
names the model that actually ran. Extraction is the one to watch: it feeds
every later phase, so its miss is the only one that invalidates downstream
scores as well as its own.

Authorisation is an explicit statement and never an inferred one. "Somebody
exported a key" is not "somebody agreed to the bill", so the gate reads
`BRAINZ_EXIT_GATE_AUTHORISED=yes` and refuses on anything else. Four things
independently stop it passing for having graded nothing: green derives from a
score, an unpinned score cannot be green, no live tenant is a refusal for every
op whatever the scores say, and the cost is committed before the run.

### B5. The live vision call

**Folded into [B4](#b4-the-ktd13-exit-gate--the-consolidation-ops).** The gap
this line recorded — a working, routed, priced `vision` op that no gate covered
and no harness line would ever produce a receipt for — is closed. `vision` is in
`EXIT_GATE_OPS` with its own check, workload row and cost line, and it defers on
the same authorised-spend condition as the other five rather than on nothing at
all.

It is still **not scored**, which is why this stays in group B: it is one of the
six ops B4's command grades, and B4's estimate now includes it.

**What it costs:** $0.022820 of B4's total, derived rather than guessed — eight
committed gold images at `IMAGE_INPUT_TOKENS` plus the transcription prompt, at
the vision seat's price. The gold is at
[`evals/fixtures/transcription.ts`](../evals/fixtures/transcription.ts) and its
one honest limitation is stated there: the images are machine-rendered, so a
model that reads them perfectly has been shown to read clean glyphs, not a
photograph of a screen. Real founder screenshots are what replace it.

**What it would prove:** that a screenshot containing text is findable by its
contents through the ordinary retrieval stack, which is the verification U21 was
written against.

### B6. Request-time p99 from a deployed container

**Cost:** deploying the fleet and replaying the fixture queries against its
public origin, warm.

Recorded as `deferred` in the rerank receipt, with the run that would produce it
named: the R6 fixture queries replayed against a deployed Cloudflare Container
over its public origin, warm, with the rerank op routed through the hosted
gateway.

**What it would prove:** that turning rerank on did not break the warm-p99
promise. Enabling it puts a *second* synchronous external call on the request
path alongside the query embedding. The named dial if the budget misses is the
candidate count, with a floor of 20. The cost side of that envelope is already
measured and inside it — $0.1032 per active user per month at the modelled
volume; it is the latency side that is unmeasured.

**There is no public origin today.** `wrangler.toml` deliberately carries no
route and no custom domain, because binding one before the surrounding units
landed would publish an endpoint that 500s. Everything in this line waits on
that.

### B7. The canary tier's own floors

Same command as [B4](#b4-the-ktd13-exit-gate--the-consolidation-ops).
Model-extraction recall ≥ 0.8, judged nightly and non-blocking, routed so the
judge is never the model that produced the output it is grading.

Deferred for want of a live tenant. The public canary tenant is later work; the
interim is a dedicated internal fixture tenant.

### B8. Cycle wall-clock, model tier

The committed measurement at
[`evals/receipts/u11-cycle-wallclock.json`](../evals/receipts/u11-cycle-wallclock.json)
is **267 ms for the deterministic tier only** — a lower bound on a cycle, not a
cycle. The receipt says so, and the scheduler still carries the reasoned
three-minute estimate rather than this number, deliberately: substituting one
for the other would make fleet capacity look roughly 675× larger than it is.

A full-cycle measurement arrives with B4, because a paid cycle is where the
minutes go.

### B9. Round-trip knowledge parity

```bash
bun run test:roundtrip
```

Exits 1 with a message naming its owning unit. It is declared so the command
name stays stable and unimplemented gates never look green. It is **not an
alpha-exit line** — it blocks the beta release — and it is listed here only so
a reader running every declared command knows why this one refuses.

---

## Group C — only a human can produce it

These cannot be automated, and the plan is explicit about why. The consumer
thesis — that a non-technical person can use this — has no falsification point
anywhere else before the hosted beta, by which time onboarding, the connect
flow, the free tier and the empty state are all built and expensive to change.

### C1. The founder's two-week daily bake

Real Gmail, Calendar and Drive plus chat history in the brain; capture and
consult happening unprompted from the clients actually in use, not from a test
harness.

**Record daily, in a run log:**

- time to a useful answer, subjectively — the number that matters is whether
  you stopped reaching for the brain
- spend for the day, per the metered gateway
- the per-tenant quality signal, and whether it drifted
- every incident, with what you were doing when it happened

**What counts as a silent failure** — the category the exit criterion names,
and the hardest to catch:

- a scheduled briefing that did not fire, and nothing said so
- an ingest source that stopped pulling, and nothing said so
- a consolidation cycle that stopped early on a spend cap and reported
  "consolidated but not dreamt" to nobody
- an answer that was confidently wrong about something the brain holds
  correctly
- a briefing section that was empty when you know it should not have been

> **Detection is manual, and that is a gap rather than a choice.** Three
> supporting capabilities are classified `not-yet` in the ledger: the
> content-free quality-drift telemetry, a fleet-side health rollup, and a
> user-visible upgrade notice. The signal is collected on every ranked read and
> written to the control plane; nothing reads it back. For two weeks, on one
> brain, the founder is the monitoring system. That works at n=1 and is exactly
> what stops working at n=100.

**Exit condition:** two weeks of daily use, spend inside the envelope, and no
silent-failure incident left unexplained. Fix the top friction items, then
re-run every command in group A.

### C2. Two or three non-technical testers reaching a first answer unaided

The single most important line on this page, and the cheapest to run.

**Protocol.**

*Recruit:* two or three people who do not write software and do not work on
this. One of them should be someone who has never used a custom connector.

*Hand over, then stop.* Give each tester exactly two things: the origin URL of
the alpha deployment, and whatever account credential they need. Then help
stops. Do not sit with them. Do not answer questions during the run. Do not
watch over a shoulder in a way that invites a hint.

*Record, per tester:*

- which client they used, and whether they had it installed already
- the timestamp the URL was handed over
- the timestamp of their **first answer grounded in their own data** — an
  answer that came back through `recall`, `entity` or `briefing` and contained
  something the brain had actually stored. Not "the connector connected". Not
  "the assistant said hello."
- **time to first answer** = the difference between those two
- the exact step at which they first abandoned, verbatim, in their words

*What counts as abandonment:* any one of — they ask for help; they stop and do
something else; they hit a time cap you set in advance and state to them at the
start (30 minutes is a reasonable cap). Record the first one that happens, even
if they later recover on their own. First abandonment is the measurement; total
success is a bonus.

*What not to help with,* specifically — because these are the candidates:

- finding the custom-connector setting in their client
- pasting the URL
- the OAuth consent screen
- an empty brain returning nothing on the first question
- knowing that they have to say something before they can ask anything

**The known first-abandonment candidate is the connect step itself.** In the
alpha there is no guided connect flow; getting brainz into a client means
pasting a URL into a settings screen, which is the exact setup question the
product's first requirement forbids. If every tester abandons there, that is a
result, and it is the result the plan predicts. Record it precisely enough to
be actionable: which screen, which wording, what they expected instead.

**Exit condition:** two or three testers run, with time-to-first-answer and
first-abandonment recorded for each. Not "they all succeeded" — the criterion
is that the measurement exists and someone other than the founder has tried.

### C3. Spend reconciliation

Recorded spend from the metered gateway, matched against what the providers
actually invoiced, for the bake period.

**No automated check exists for this.** The gateway meters every call and the
pricing table hard-fails on an unpriced model, but nothing compares the
resulting total to a provider statement. Until something does, this is a human
reading two numbers and confirming they agree — and a divergence is a finding
worth stopping for, because it means the meter is wrong in a system whose
entire cost model rests on it.

### C4. Briefing accuracy against ground truth

The founder's morning briefing, checked against their own week. Nobody else can
grade this, because nobody else knows what the week contained. Judged quality
on the canary tenant ([B7](#b7-the-canary-tiers-own-floors)) measures something
adjacent and is not a substitute.

### C5. Alpha review against the product bar

A deliberate pass over the whole alpha against the bar it was written to reach,
after the bake and after the tester runs — with the friction items fixed and
group A re-run. This is the step where "alpha exited" is either declared or
not, and it is a judgement, not a test result.

---

## Clause-by-clause status against the plan

The Alpha-done bullet, split into what it actually asks for:

| Clause | Status | Where |
|---|---|---|
| Founder's real Gmail / Calendar / Drive + chat history in the brain | human | [C1](#c1-the-founders-two-week-daily-bake) |
| Capture-and-consult works unprompted from the real clients | human | [C1](#c1-the-founders-two-week-daily-bake) |
| All R6 floors green | **not satisfied** — 2 of 5 deferred | [A3](#a3-accuracy-floors-r6), [B1](#b1-regenerate-the-embedding-manifest-from-a-real-provider) |
| Consolidation producing entity cards and report-only contradictions | needs an authorised paid cycle | [B4](#b4-the-ktd13-exit-gate--the-consolidation-ops) |
| Screenshots findable by their text | implemented; gated but **unscored** — the vision op is in the exit gate and deferred with the rest | [B5](#b5-the-live-vision-call), [B4](#b4-the-ktd13-exit-gate--the-consolidation-ops) |
| Every model call routed and metered, recorded spend matching provider usage | routed and metered; reconciliation is human | [C3](#c3-spend-reconciliation) |
| Exit gate green for the consolidation ops, receipt per op naming its pinned model id | deferred, $1.01 to run for all six | [B4](#b4-the-ktd13-exit-gate--the-consolidation-ops) |
| Two or three non-technical testers reaching a first answer unaided | **not run** | [C2](#c2-two-or-three-non-technical-testers-reaching-a-first-answer-unaided) |
| Two-week daily use, spend inside the envelope, no silent failures | **not run**; detection is manual | [C1](#c1-the-founders-two-week-daily-bake) |

## Not part of alpha exit

The **cost-down model A/B** is listed under this unit in the plan and is
deliberately absent from the checklist above. It is a *beta* gate: it steps each
op down toward the price floor and keeps the cheapest tier that still clears it,
scored against the founder's real alpha corpus — which is to say it needs the
alpha corpus to exist first, and it blocks the beta release rather than the
alpha exit. It is also two measurements in one: every op a cheaper hosted model
can carry at no measured quality cost removes a subprocessor entry as well as
cost. Run it after [C1](#c1-the-founders-two-week-daily-bake), not before.

## Related

- [Recipes](recipes/) — the three client setups the alpha ships with:
  [daily briefing](recipes/daily-briefing.md), [capture](recipes/capture.md),
  [weekly review](recipes/weekly-review.md).
- [`evals/README.md`](../evals/README.md) — what each gate measures and what it
  refuses to claim.
- [`evals/receipts/README.md`](../evals/receipts/README.md) — the calibration
  receipts in full.
