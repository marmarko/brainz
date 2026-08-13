# U19 re-plan — upstream watcher, hazard sweep, change channel

Sibling to `docs/plans/2026-08-11-001-feat-brainz-v1-roadmap-plan.md`. That plan's U19
carries an execution note — *"Milestone-grade — re-plan before execution. Until then the
ledger + conformance CI from U1/U7 carry the discipline manually."* This is that re-plan.
The roadmap's U19 body is left as written; what follows is what gets built, what stays
manual, and how a wrong answer is caught.

---

## 1. The thing being automated is not parsing

A CHANGELOG parser is an afternoon. The reason this unit is milestone-grade is that the
artifact it writes into is a **trust ledger**, and the ledger's whole value is that
`covered` means something. R7 permits a capability to be declined; it forbids one being
forgotten. `not-yet` and `omitted` both keep a capability on every list an operator reads.
`covered` retires it. A row flipped to `covered` is a row nobody looks at again —
`test/ledger/coverage-claims.test.ts` already says this in prose, and it exists because
four rows in this repo claimed coverage they did not have.

So the design constraint is not accuracy. It is **asymmetry of error**: a watcher that
guesses `not-yet` about something already built costs a human two minutes at review. A
watcher that guesses `covered` about something absent costs the ledger its meaning, and
nothing downstream ever complains.

Everything below follows from that.

---

## 2. What is automated

| Automated | Where | What it emits |
|---|---|---|
| Reading the pinned gbrain build | `src/upstream/gbrain-repo.ts` | Blobs and trees read with git plumbing at the pinned **commit**, never the working tree |
| CHANGELOG delta since the pin | `src/upstream/changelog.ts` | Releases newer than the pinned version, parsed from the pinned file and the head file |
| Path gate | `src/upstream/path-gate.ts` | Per itemized change: in-scope brainz area, or out-of-scope with a stated reason |
| Classification into candidate rows | `src/upstream/classify.ts` | `not-yet` rows only, each carrying confidence, evidence and a review deadline |
| Guard sweep over upstream `scripts/check-*` | `src/upstream/hazard-sweep.ts` | An inventory receipt, hazard cards for the unanalogued, and the skipped-test stubs those cards oblige |
| Completeness of the guard decision table | `src/upstream/hazard-map.ts` + its test | A new upstream guard with no entry is a hard failure |
| Per-tenant change records | `src/upstream/change-channel.ts` | The `brain` payload block, rendered per tenant, persisted nowhere |
| Per-tenant staging flags | `src/control/flags.ts`, `control.tenant_flag` | `off` / `canary` / `on`, per tenant, per flag |
| Enforcement of all of the above | `scripts/check-ledger.ts` (`bun run ledger:check`) | Exit 1 on an unreviewed row past its deadline, on a watcher row claiming coverage, on a covered row citing a repo path that does not exist |

The runnable entry point is `bun src/upstream/watch.ts`. It reads; it writes only when
asked (`--apply`, `--write-sweep`), and it never advances `upstream/gbrain.pin`.

## 3. What stays manual, and why

**Advancing the pin.** The watcher will *recommend* — it can see that the checkout is
ahead of the pin, and whether that ahead-ness contains a release. It will not act.
Advancing the pin changes the build `bun run conformance` grades against, and
`upstream/memory-verbs-v1-partial.json` binds itself to the pinned commit and refuses to
grade against any other. The pin file says it in its own `advanced_by` field: *"Advancing
the pin is a deliberate U19 ledger action and requires re-observing the published delta in
the same change."* A watcher that advances the pin would silently invalidate the published
delta — a mechanised version of the exact failure the delta file exists to prevent.

**The flip to `covered`.** Structurally impossible for the watcher, not merely discouraged:
`classify.ts` has no code path that produces the string, and `check-ledger.ts` fails on a
watcher-discovered row that carries it without a human's `reviewed_by`. A human flips it,
names themselves, and cites a path that exists.

**The flip to `omitted`.** Same reason plus one more: `omitted` requires a `reason` and a
`revisit_by`. Both are judgements about brainz's roadmap, which is not in the artifact the
watcher reads.

**The prose in a hazard card's *brainz analog* and *guard* sections.** The sweep quotes the
upstream guard's own header — upstream's words, attributed — and takes the brainz half from
the committed decision table, where a human wrote it. The generator never invents a
mechanism. A card that could be generated end-to-end from an upstream filename would be a
card asserting something nobody checked.

**The weekly cron.** The roadmap names `.github/workflows/upstream.yml`. This session may
not write to `.github/` or to `package.json`, so no schedule is wired and no script alias is
added. The invocation is recorded here instead:

```
bun src/upstream/watch.ts --report upstream/watch/$(date +%F).json
bun src/upstream/watch.ts --sweep --write-sweep      # refresh the guard inventory + cards
bun run ledger:check                                  # the gate that makes the above matter
```

The gate is the load-bearing half and it is already wired into CI (`bun run ledger:check`,
Verification Contract). A missed cron run delays discovery; it does not make anything green
that should be red, because the deadline rule is evaluated against the row's own date at
every `ledger:check`, not at watch time.

**Model-assisted classification: deliberately not built.** The deterministic path gate maps
an itemized bullet's gbrain source path to a brainz area. It is precise where a path exists
and blind where a release describes a behaviour without naming a file — roughly the
prose-only entries, which the watcher records at `confidence: "low"` rather than dropping.
A model reading the release prose would classify those, and would also propose which
existing ledger row a change *modifies* rather than adds. What it would cost, priced against
this repo's own routing table: a release's prose plus its itemized list is ~2–6k input
tokens; a weekly run over a handful of releases is well under a cent at any tier in
`src/ai/routing.ts`. Cost is not the objection. The objection is that a model's output would
enter the ledger as a row whose evidence is a sentence rather than a path, and the evidence
rule below — *a covered row's cited paths must exist* — has nothing to bite on. If a model
is added later it belongs on the `confidence: "low"` residue only, writing into the same
`not-yet` + `review_by` shape, and its rows should carry `classified_by: "model:<id>"` so a
human reviewing them knows which reading produced the claim. No live call is made by
anything in this unit.

---

## 4. How a wrong classification is caught

Four rules, in `scripts/check-ledger.ts`, each with its own test and each mutated to
confirm it dies for the right reason.

1. **The watcher cannot claim coverage.** A row carrying `discovered_by.watcher` and no
   `reviewed_by` may be `not-yet` and nothing else. Not a convention — the check reads the
   row and fails.

2. **A discovery has a deadline.** `discovered_by.review_by` is an ISO day, seven days
   after the run. Past it, with no `reviewed_by`, `ledger:check` exits 1. This is the
   roadmap's own verification — *"within a week the ledger has classified rows for its
   concepts, and CI enforces them"* — expressed as the row's own data rather than as a
   promise about someone's calendar. The grace window is deliberate and has in-repo
   precedent: `upstream/memory-verbs-v1-partial.json` declines to wire a CI job that would
   be red on every PR, because *"a gate red on every PR trains people to ignore it."* A
   fresh discovery is not yet a violation; an ignored one is.

3. **Evidence must exist.** Every repo path a `covered` row cites in `notes` must be a file
   that is present. Measured before adopting: of the 36 `covered` rows, 18 cite a
   repo-root-prefixed path — 28 paths between them — and every one resolves, so the rule is
   adopted repo-wide rather than scoped to new rows. A row that claims coverage by naming a
   module nobody wrote is the precise shape of the four bad rows this session found, and it is
   now a build failure. **Its stated limit:** the notes also use a shorthand
   (`search/arms.ts` for `src/core/search/arms.ts`), and the rule does not try to resolve it.
   Guessing a prefix would turn a hard check into a heuristic, and a heuristic that
   occasionally accuses a real file is a check somebody switches off.

4. **A reviewed watcher row must cite something.** Flipping a discovery to `covered`
   requires `reviewed_by` *and* at least one existing repo path in `notes`. Rule 3 makes a
   fabricated path fail; rule 4 makes an empty justification fail.

Confidence lives in the row (`discovered_by.confidence`, one of `low` / `medium` / `high`)
together with the `evidence` that produced it, so a reviewer sorting a queue can see which
rows the machine was guessing at. Confidence orders the queue. It never grants a status.

**Traps this design is built against**, named so the tests can be checked against them:

- *An empty delta makes a classifier test pass trivially.* The parser must find the pinned
  version's own header in the pinned file; failing to find it is an error, not an empty
  result. And the classifier is exercised against a real, non-empty historical delta from
  gbrain's committed CHANGELOG, not only against the current pin.
- *"CI enforces them" passes trivially if no row is ever unclassified.* The deadline rule is
  tested by constructing the red state and observing it, in both directions — a row inside
  its window is green, the same row past it is red.
- *A content-free claim is an absence claim, and absence passes when nothing is written.*
  The change-channel test asserts the distinctive string **is** in the rendered record
  first, then that it is in no textual column of the control plane, enumerated from
  `information_schema` rather than from a list of tables someone remembered to update.

---

## 5. The change channel, under two constraints

P13 asks for a change record per tenant — *what shipped, what it did to your memory, what
you can do about it* — model-reachable through `brain`, staged by per-tenant flags.

**Constraint one: the control plane is content-free.** So the record is assembled from three
parts that live in three different places, and the part naming a tenant's content is
persisted nowhere:

| Part | Lives | Why there |
|---|---|---|
| What shipped | `upstream/changes/*.json`, committed | Fleet-wide, authored, identical for every tenant. Not user content in any tenant's sense. |
| Whether this tenant sees it | `control.tenant_flag` | A flag name from a committed registry and a three-value stage. No prose can reach it — the column's domain has an anchored alphabet, like every other textual column in that file. |
| What it did to *your* memory | Rendered at read time from the tenant's own database | Counts and examples drawn from the tenant's own rows. It names content, so it is never written back — not to the control plane, and not to the committed record either. |

The committed record is a **template**; the tenant's numbers are substituted on the way out.
`test/upstream/change-channel.test.ts` asserts the record's bytes are unchanged after
rendering for two different tenants, which is the property that keeps the fleet-wide file
from becoming a place tenant content accumulates.

**Constraint two: `src/mcp/` is owned by a concurrent unit this session may not touch.** So
the channel ships as `changeChannel()`, returning exactly the block `brain` will embed under
`content.changes`, with its shape pinned by test. The one-line wiring into
`src/mcp/tools/meta.ts` is the remaining step and is recorded as such — `imp.upgrade-notice`
stays `not-yet` in the ledger until it is a surface a user can reach, because its capability
statement says *user-visible* and a function nobody calls is not that.

---

## 6. What this unit does not do

- It does not advance `upstream/gbrain.pin`, and says so in its report when it thinks the
  pin should move.
- It does not re-observe the conformance delta. That is bound to the pin and moves with it.
- It does not port a single upstream guard. It finds the ones with no counterpart here and
  makes their absence countable — which is what turns "gbrain has 39 guards" from a number
  in a document into a number the test suite prints.
- It makes no model call.
