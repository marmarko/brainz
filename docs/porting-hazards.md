# Porting hazards

Failures gbrain already paid for, translated into brainz's substrate.

gbrain encodes its production scar tissue as 39 executable `scripts/check-*.sh` guards plus
`docs/incidents/`. None of that ports as code — brainz is a different codebase on a different
substrate — but the *failure mechanisms* do. This file is the ledger.

**Card format.** Each hazard carries: the mechanism, what masked it (why it wasn't caught in
dev), the brainz analog, the guard that would catch it here, and a status. An unported hazard
ships as a **skipped test with a reason string**, so the suite prints the unguarded-hazard count
on every run rather than letting the gap go quiet.

Status values: `guarded` · `accepted(reason)` · `unported`

---

## H1 — Silent candidate-pool truncation via `hnsw.ef_search`

**Status:** `guarded` — `test/hazards/h1-ef-search-truncation.test.ts`, against a real Postgres +
pgvector. Remedy in `src/schema/vector-query.ts`.

**Mechanism.** pgvector defaults `hnsw.ef_search` to **40**. An HNSW index scan returns at most
`ef_search` rows *regardless of what the query's LIMIT asks for* — the GUC sizes the scan's
candidate list, so it caps the row count before LIMIT is ever applied. The GUC's hard ceiling is
1000.

The retrieval stack asks the vector arm for a large candidate pool, not for final results:
`offset + max(limit * 5, 100)` candidates. Against the three search modes that is:

| Mode | searchLimit | Candidates requested | Returned at default `ef_search` |
|---|---|---|---|
| conservative | 10 | 100 | **40** |
| balanced | 25 | 125 | **40** |
| tokenmax | 50 | 250 | **40** |

**Why it is dangerous rather than merely wrong.** Nothing errors. The query succeeds, returns
plausible results, and every downstream stage silently operates on a fraction of the pool it was
designed for:

- **RRF fusion** ranks a truncated universe — the vector arm contributes 40 candidates against a
  full-strength full-text arm, so fusion is systematically biased toward keyword matches.
- **Per-page collapse** dedupes within 40 chunks instead of 250, so a page with many strong
  chunks crowds out pages that would have surfaced.
- **Reranking** reorders 40 items and cannot recover anything that never arrived.
- **Autocut** fires on a score-discontinuity distribution that does not exist at n=40, so
  result-sizing is tuned against noise.

Quality degrades everywhere and no signal points at the cause. It looks like "our ranking is
mediocre," not "one GUC is unset."

**What masked it.** Small dev corpora. Below ~40 matching chunks the truncation is invisible
because the index returns everything anyway — so it passes every local test, every fixture, and
every demo, and only appears on a real user's brain. It is also invisible in the query plan: the
scan is doing exactly what it was configured to do.

**gbrain's own words** — `src/core/vector-index.ts`:

> An HNSW index scan returns at most `hnsw.ef_search` rows (default 40) no matter what the
> query's LIMIT asks for — the GUC sizes the scan's candidate list, so it caps the row count
> before LIMIT is even applied. Both engines' `searchVector` ask the inner CTE for
> `offset + max(limit*5, 100)` candidates; without raising the GUC the pool silently truncates
> at ~40 and everything downstream (per-page collapse, RRF fusion, rerankers) operates on a
> fraction of the pool.

`HNSW_EF_SEARCH_DEFAULT = 40`, `HNSW_EF_SEARCH_MAX = 1000`.

**brainz analog.** Identical — brainz runs Postgres + pgvector on Neon, so this is not an
analogy, it is the same bug in the same extension. The port inherits it exactly.

**The fix.** `SET LOCAL hnsw.ef_search = <candidate_count>` inside the same transaction as the
vector query, sized to the pool the caller actually asked for, clamped to 1000.

Use `SET LOCAL` inside an explicit transaction, not `SET`. On a pooled connection a bare `SET`
either leaks the setting to the next tenant's query on that connection or evaporates before the
query runs, depending on pooling mode — gbrain hit exactly this class of problem with
`statement_timeout` (`src/core/backfill-base.ts`: *"With pooled engine.executeRaw, SET LOCAL
evaporates between calls"*). With a per-tenant connection LRU this is a cross-tenant correctness
issue, not just a correctness issue.

**The guard.** A behavioral test, not a grep:

1. Seed a fixture brain with **> 200 chunks** that all match a single query above threshold.
2. Run the vector arm asking for a 250-candidate pool.
3. Assert the returned candidate count is `>= 200`.

It fails loudly at 40 today and keeps failing if anyone refactors the transaction boundary out
from under the `SET LOCAL`. A lint that greps for `ef_search` near the query would pass while the
setting evaporates on a pooled connection — which is the actual failure mode — so the test has to
exercise behavior.

Worth asserting the fixture size itself: a guard seeded with fewer than 40 chunks silently passes
forever and is worse than no guard.

**What building it changed about the spec.** Two findings, both measured on pgvector 0.8.6 /
PostgreSQL 17.10, both of which would have left a green guard over a live hazard:

1. **The yield assertion cannot isolate this GUC once H3's remedy is present.** With
   `hnsw.iterative_scan` on, deleting the `SET LOCAL hnsw.ef_search` statement changes the guard's
   measured yield by nothing: the scan resumes and refills a 250-row pool out of 40-row batches.
   H3's fix masks H1's. The guard therefore also pins `current_setting('hnsw.ef_search')` *inside
   the helper's transaction*, which is still behaviour a lint cannot see — it reports what is in
   effect for this transaction on this pooled connection, which is exactly what a bare `SET`
   fails to deliver.
2. **At fixture scale the planner does not use the index at all.** `vector(1536)` is stored out of
   line, so the heap looks tiny and the cost model never charges for detoasting; Postgres picks a
   sequential scan, which returns *exact* neighbours and full recall. An unasserted guard passes
   with flying colours while measuring a query path production never takes — H2's mechanism
   surfacing inside H1's guard. The corpus needed for the planner to choose the index unaided
   measures at roughly 50,000 chunks, far too slow for the PR-blocking tier, so the guard forces
   the plan and then asserts, via `EXPLAIN`, that the forcing took.

**Scope, stated so `guarded` is not read as more than it is.** What is pinned is the *helper's*
transaction mechanics — that both GUCs are in effect, at the values asked for, inside the query's
own transaction, and that neither leaks past it. There is no production caller yet (U5 owns the
retrieval arm), so nothing pins that request traffic reaches the helper, and nothing can: a U5 arm
that passes a bare `limit` where the helper expects a *pool* sets `ef_search` to 10 and truncates
below pgvector's own default with every guard here still green. `candidatePoolFor` in
`src/schema/vector-query.ts` is the mitigation — the `offset + max(limit * 5, 100)` arithmetic as a
named function the arm calls rather than a sentence the arm's author has to have read.

---

## H2 — The vector index that quietly isn't there

**Status:** `guarded` — `test/hazards/h2-missing-vector-index.test.ts`. Both halves: the
provisioning-time assertion in `src/schema/apply.ts`, and the dimension-ceiling scanner in
`src/schema/vector-index.ts`. It shares H1's shape: a correct-but-degraded vector arm that no
error points at.

Both halves now cover the whole schema rather than one column and one file, because the
one-column shape was itself an instance of the hazard: a second queried vector column added
later would have inherited a green guard. `INDEXED_VECTOR_COLUMNS` and
`RESERVED_VECTOR_COLUMNS` (`src/schema/vector-index.ts`) name every vector column and which of
the two it is; provisioning asserts an index for each indexed column its schema version has;
the ceiling scan runs on every migration rung's DDL as it is applied, not only on the baseline
file; and `test/schema/tenant-schema.test.ts` enumerates the vector columns the database
actually has and fails on any that appears in neither list. A reserved column carries no index
on purpose — nothing queries it — and moving it to the indexed list is what turns provisioning's
assertion on.

**What a registry buys, and what it does not.** Adversarial review found the first version of that
registry moved the fail-open rather than removing it: from *"a second column added later"* to *"a
second column mis-registered later."* Two single-site edits were accepted with provisioning green
and the hazard live, and both are now closed:

- **A wrong opclass.** `USING hnsw (embedding vector_l2_ops)` on a column the arm reads with cosine
  `<=>` is a valid, healthy-looking index the planner cannot use for that ordering — the plan is a
  sequential scan *even under `enable_seqscan = off`*, because there is no alternative. Each indexed
  column now declares the operator its arm issues, and the provisioning assertion requires an index
  whose opclass family serves that operator (asked of `pg_amop`, not matched against a list of
  opclass names, so a `halfvec` column added later is judged by what it can do).
- **A demotion.** Moving a queried column to the reserved list and deleting its `CREATE INDEX` used
  to satisfy everything, because the reserved rule *is* "carries no index". What catches it: a
  reserved column may not be declared `NOT NULL`. Nothing computes an embedding for every row of a
  column it never reads, so a `NOT NULL` vector column is on somebody's read path by construction.

Plus a plan-level guard that loops over the registry and asserts, from `EXPLAIN`, that every indexed
column can actually be `ORDER BY`-ed through its index. **The residual, stated rather than left to be
found again:** a *nullable* queried column mis-filed as reserved is still invisible to the structural
rule. `chunk.embedding` is nullable and is covered instead by H1's and H3's plan assertions;
`fact.embedding` is covered by the `NOT NULL` rule; a third such column would need its own.

**Mechanism.** pgvector caps *indexable* dimensions well below storable ones:

| Type | Storable | HNSW-indexable |
|---|---|---|
| `vector` | 16,000 | **2,000** |
| `halfvec` | 16,000 | **4,000** |
| `bit` | — | 64,000 |

A `vector(3072)` column — which is what `text-embedding-3-large` produces natively — stores
fine, inserts fine, and queries fine. Only `CREATE INDEX ... USING hnsw` fails, and it fails
loudly. That loud failure is not the hazard.

**Why it is dangerous rather than merely wrong.** The hazard is what happens *after* the index
creation fails or is skipped: **the queries keep working.** Postgres falls back to a sequential
scan, which returns exact nearest neighbours — strictly *better* recall than HNSW, just
O(n). So:

- Every test passes, and the accuracy evals pass *harder* than they will in production, because
  exact search beats approximate search on recall.
- Latency is fine on any corpus small enough to fit a dev fixture.
- `entity`'s p99 promise is met in every environment where it is measured.
- The first real brain with 100k chunks turns every query into a full table scan, and the
  symptom is "search got slow," at the exact moment the corpus becomes worth searching.

An eval suite cannot catch this. Recall goes *up*. The only signal is a query plan nobody reads.

**What masked it (in the general case).** The same thing that masks H1: corpus size. A seq scan
over a 2,000-chunk fixture is a few milliseconds. The index is a scale optimization, so its
absence is invisible at any scale you'd test at by hand — and because it is an *optimization*,
a missing index reads as a performance nit rather than a shipped defect.

**brainz analog.** Direct and current, and it has now been lived through twice. KTD8 selected
`text-embedding-3-large`, natively 3072d, against a `vector` type that indexes to 2,000, and
resolved it by **truncating to 1536d** (Matryoshka) — inside the ceiling with headroom, with
`halfvec(3072)` as the alternative if a future model makes native dimensionality worth the
storage. The seat has since moved to a natively-1024d model whose endpoint ignores the
`dimensions` parameter, so there is nothing to truncate with and nothing to get wrong in that
direction; the ceiling check moved with it, from rung one's DDL to the whole ladder
(`test/hazards/h2-missing-vector-index.test.ts`), because the column the arm reads is now
declared by a later rung and a scan of the baseline would be checking a column nothing queries.
Either resolution is fine; the hazard is shipping *neither* and not noticing.

The multi-tenant shape makes it worse than single-tenant: schema is applied per tenant at
provision time (KTD9). A DDL step that fails on one tenant and succeeds on the next produces a
fleet where *some* brains have a vector index and some don't, with no aggregate signal — the
slow ones just look like unlucky users.

**The guard.** Two assertions, both cheap:

1. **Schema assertion, per tenant:** after `initSchema`, query `pg_indexes` (or
   `pg_class`/`pg_am`) and assert an `hnsw` index exists on the chunk embedding column. Run it
   in provisioning, not just in tests — a tenant without a vector index is a broken tenant and
   should fail provisioning loudly rather than serve slowly.
2. **Dimension assertion at the schema layer:** assert the embedding column's declared dimension
   is `<= 2000` for `vector` (or `<= 4000` for `halfvec`) at migration-definition time, so a
   future embedding-model swap that changes dimension is rejected by the test suite instead of
   by production `CREATE INDEX`.

The second is the one that pays forward: KTD8 already anticipates a model A/B, and the whole
point of preferring same-dimension challengers is that dimension changes are expensive. A guard
that names the ceiling makes that constraint executable instead of remembered.

**Related:** H1. Both are cases where the vector arm silently underperforms its specification
with no error and no failing test — H1 truncates the pool, H2 removes the index. A brain
suffering both would present as "search is slow *and* mediocre," which reads as an
architecture problem rather than two unset knobs.

---

## H3 — Post-filter recall collapse (H1 one layer down)

**Status:** `guarded` — `test/hazards/h3-post-filter-recall.test.ts`. Remedy alongside H1's, in
`src/schema/vector-query.ts`. Discovered by the 2026-08-12 plan review; it is the reason H1's
guard as specified would pass on a production-shaped query.

**Confirmed to reproduce before the guard was written**, because a guard that cannot go red is
worse than none. pgvector 0.8.6 ships `hnsw.iterative_scan` defaulting to `off`, so this is live
and not already fixed upstream. On a 5,000-chunk fixture holding 250 qualifying rows behind 150
nearer rows that the production predicates exclude, a 250-candidate request returns: **0** rows
at pgvector's defaults, **250** unfiltered once `ef_search` is raised, **100** once the predicates
are added — and 250 again with `iterative_scan` set. The collapse is exactly the arithmetic the
mechanism predicts: the scan spends its whole budget on rows the filter then discards.

**The unremedied number is asserted, not just quoted.** The guard's first test is a *control*: the
same query, the same forced index scan, `hnsw.iterative_scan` explicitly off, and an assertion that
the yield is still well below the floor. Without it, "the arm returns ≥200 with the remedy" passes
on any fixture where the predicates stopped biting — including one somebody shrank. The first
version of this guard defended that with an arithmetic tripwire over the fixture constants, and
adversarial review found it calibrated exactly to its own boundary: one step in either constant left
both headline assertions green with the hazard live, and the tripwire was the only red.

**Scope limit, which the source comments carried and this card did not.** The remedy this guard pins
is itself bounded by `hnsw.max_scan_tuples` (default 20,000) — how far an iterative scan will resume
before giving up. What is proven here is that the scan *resumes*, not that it resumes far enough on
a brain whose origin fence excludes most of a large corpus. That is the same hazard one layer
further down; it is named in `src/schema/vector-query.ts` and it is unguarded. This card is
`guarded` for the mechanism it describes, not for that one.

**Mechanism.** pgvector applies a query's `WHERE` predicates **after** the HNSW scan returns its
`ef_search` candidates. So the GUC sizes the *scan*, not the *qualifying yield*. Raising
`hnsw.ef_search` to the requested pool size — H1's fix — buys nothing once a filter is present:
the scan returns N candidates, the filter discards most of them, and the arm yields far fewer
than the pool it was asked for even when the corpus holds plenty of qualifying rows.

**Why brainz is the worst case for this.** Every read on this design carries at least one
predicate, usually three:

| Predicate | Source |
|---|---|
| origin fence (`origin_context` scoping) | R15 / KTD5 — on every read tool |
| soft-deleted rows excluded | R12 |
| junk-quarantined items hidden | U9 |

A brain where the user's work-origin grant is active, some pages are tombstoned, and a
quarantined newsletter backlog exists is not an edge case — it is the ordinary steady state.

**Why H1's guard cannot see it.** H1's guard is specified *unfiltered*: seed >200 matching
chunks, request 250 candidates, assert ≥200 returned. With no `WHERE` clause it passes at any
`ef_search` above the pool size and keeps passing forever, while production — which never issues
an unfiltered vector query — starves RRF, per-page collapse, rerank and autocut exactly as H1
described. The guard proves the GUC is set; it does not prove the arm returns qualifying rows.

**The fix.** `SET LOCAL hnsw.iterative_scan` (pgvector 0.8+) alongside `hnsw.ef_search` in the
same transaction, so the index scan resumes and returns more candidates when the filter discards
them, rather than truncating at the first `ef_search` batch. Both GUCs belong in the one vector
helper (U3), never at a call site.

**The guard.** Re-run H1's fixture **with production-shaped predicates**: seed >200 matching
chunks, add an origin fence plus soft-deleted and junk-quarantined rows that must be excluded,
request a 250-candidate pool, and still assert ≥200 *qualifying* rows returned. A guard that
omits the `WHERE` clause is testing a query the product never issues.

**Related:** H1. Same silent-degradation signature, same invisibility on small dev corpora, and
the same presentation — "our ranking is mediocre" — with no error and no failing test. A brain
suffering H1 and H3 together looks like an accuracy-architecture problem, which is precisely the
misdiagnosis the plan's stop condition (c) is built to avoid.

---

## H4 — Lease renewal starved by the connection it shares with the work

**Status:** `guarded` — `test/worker/lease-renewal.test.ts`, against a real Postgres with a
one-connection work pool. Remedy in `src/worker/locks.ts` (`assertDedicatedLeaseChannel`) and
`src/worker/queue.ts` (`createLeaseChannel`).

**Mechanism.** A long-held job lease is kept alive by a small renewal query on a timer. Route that
query through the same pool the job's own work uses and it is not a timer at all — it is a request
that waits its turn behind whatever the work is doing. Under a pooler that rotates connections, or
simply under a pool the work has saturated, the renewal misses its window, the lease lapses while
the worker is healthy and mid-job, and a reaper hands the job to somebody else. Production upstream
lost roughly 39 worker processes a day to this exact sequence.

**Why it is dangerous rather than merely wrong.** Every query in the sequence succeeds. The renewal
eventually runs; the reaper is doing its job; the second worker completes normally. The only
symptoms are a worker count that drifts down and a queue that quietly does some work twice — and
the duplicate is expensive here, because a doubled consolidation cycle is doubled model spend
against a per-tenant cap.

**brainz analog.** Any long-held lease renewed over a shared pool: `control.job`'s
`lease_expires_at`, and later any per-tenant connection LRU that puts the control plane and the
tenant's own database behind one budget.

**What masked it.** Pool contention. The wiring that fails is character-for-character the wiring
that works, right up until the pool is busy — so it passes every test that runs one job at a time,
which is every test anybody writes first.

**The guard.** Behavioural, and in two halves. Saturate a one-connection work pool with a long
query while a lease is held; assert the renewal on its own channel still lands, and that a reaper
running at an instant which *would* otherwise have taken the lease takes nothing. Then the seeded
regression: same clock, same reaper, renewal routed through the saturated pool — the lease is stolen
from a live worker and the renewal that eventually runs is refused by the fencing token. The second
half is what gives the first one meaning.

**Related.** The fence rather than the lease is what makes the theft safe: `lease_token` is
incremented by the steal, so the dispossessed worker's writes are rejected by the store instead of
merely being discouraged. That is the same correction U2 made after shipping unfenced provisioning
writes, and the reason a starved renewal is a lost job rather than a corrupted one.

---

# Swept from gbrain's guard corpus (U19)

H1–H4 above were written by hand, one incident at a time. The cards below were found by
sweeping every `scripts/check-*` file gbrain ships at the commit in `upstream/gbrain.pin`
against a committed decision table (`src/upstream/hazard-map.ts`), in which a human says of
each upstream guard: an existing card already covers this, brainz has its own guard (named,
and the name is checked to exist), the mechanism cannot fire on this substrate, or **nothing
here would catch it**. The last answer is what produces a card.

The machine's job is completeness, not judgement. A guard upstream adds with no entry in the
table fails the sweep; an entry for a guard upstream deleted fails it too. That is what turns
"gbrain ships 39 guards and we ported four" from a sentence somebody re-checks by hand into a
number the build refuses to be green without.

**The counts, measured rather than repeated.** The header of this file quotes 39 executable
`scripts/check-*.sh` guards. That figure counts shell files; upstream also ships guards in
TypeScript and JavaScript, so the guard count is higher, and the six privacy scanners are
*inside* that set rather than additional to it. `upstream/gbrain-guards.json` carries the
enumeration.

Everything between the markers below is generated. Edit `src/upstream/hazard-map.ts` and
re-run `bun src/upstream/watch.ts --sweep --write-sweep`; do not edit the cards in place.
Their skipped stubs are generated alongside, in `test/hazards/swept.test.ts`, and
`test/hazards/registry-consistency.test.ts` is what fails if the two ever drift.

<!-- BEGIN swept-cards (generated by src/upstream/hazard-sweep.ts) -->

## H5 — A real person reaching a public artifact

**Status:** `unported` — swept from gbrain's guard corpus by `src/upstream/hazard-sweep.ts`.
No brainz counterpart. Upstream source: `scripts/check-fixture-privacy.sh`, `scripts/check-no-pii-in-agent-voice.sh`, `scripts/check-privacy.sh`, `scripts/check-proposal-pii.sh`, `scripts/check-synthetic-corpus-privacy.sh`, `scripts/check-test-real-names.sh`.

**Mechanism.** gbrain's own words, from the guard header at the pinned commit:

> CLAUDE.md forbids the private OpenClaw fork name in public artifacts: … Test fixtures ship in the repo; they ARE public. … SHAPE regex: phone, email, SSN, JWT, bearer token, Luhn-valid credit card. … classes that have surfaced in past RFC drafts … Scans test/fixtures/calibration/ for patterns that look like real-world … Tests are checked-in code distributed with every release and

**What masked it.** Nothing fails. A fixture naming a real contact, a proposal quoting a real thread, a synthetic corpus that memorised a real structure — all of them compile, pass, and ship. The signal arrives from outside the repo, if at all, after the artifact is public and indexed.

**brainz analog.** Sharper here than upstream, because upstream guards a knowledge tool whose fixtures its author wrote, and brainz holds strangers’ mail. Every fixture, every committed eval receipt, every quoted example in `docs/`, and every error string that might carry a subject line is the same surface. `imp.privacy-scanners` records the gap in the concepts ledger and is still `not-yet`.

**The guard.** A scan over committed artifacts for the shapes upstream names — address, phone, bearer, Luhn-valid card, private path prefixes — plus an exact-string blocklist for identifiers a reviewer has flagged. Shape regexes over an allowlist, because a broad corporate-email regex catches legitimate fixture domains and gets switched off.

---

## H6 — A trigger function resolving through the caller’s search_path

**Status:** `guarded` — swept from gbrain's guard corpus by `src/upstream/hazard-sweep.ts`.
brainz guard: `src/schema/search-path.ts`. Upstream source: `scripts/check-search-path.sh`.

**Mechanism.** gbrain's own words, from the guard header at the pinned commit:

> every trigger function in the canonical schema base

**What masked it.** Every test passes: in a database with one schema there is nothing to shadow, so an unqualified reference resolves to the object the author meant. The failure needs a second same-named object in a schema the caller can reach, which no fixture creates.

**brainz analog.** It fired. brainz’s tenant schema defined **eight** trigger functions across `src/schema/migrations/v2-knowledge-core.sql` and `v3-consolidation.sql` and pinned `search_path` on none of them, and seven of the eight are R15’s origin fence — `refuse_origin_change`, `assert_origin_union`, `assert_fact_page_origin`, `assert_edge_origin_union` and their siblings. None was `SECURITY DEFINER` (`prosecdef` false on all eight), so this was never the privilege-escalation form; it was a **working bypass of the fence**. A schema holding an empty table named `page`, placed in front of `public`, made `assert_fact_page_origin` inspect the wrong table and admit a `fact` claiming `{personal}` extracted from a `work` page — and KTD5 fences reads on origin alone, so that row then reads out to a personal-scoped grant. `refuse_origin_change` names no table and fell too, by listing `pg_catalog` *late* and shadowing `to_jsonb`. A fence that resolves its own references through the calling session is a fence whose enforcement is a function of the caller.

**The guard.** Rung 8 (`src/schema/migrations/v8-search-path-pinned.sql`) pins `pg_catalog, public, pg_temp` — `pg_temp` named **last** because an unlisted one is searched first for relation names, which would leave every union check defeatable by a temp table. It expands rather than rewrites, because `ALTER FUNCTION` is not an expand-only statement: each function gets a pinned twin and each trigger a twin trigger, so the unpinned arm can be fooled and the pinned arm cannot. `src/schema/search-path.ts` guards it in two halves — a ladder scan so a ninth function cannot land unpinned, and a catalog scan that sees a twin dropped, disabled, or never written for a later table. The three bypasses above are replayed in `test/schema/search-path.test.ts`, because a structural guard that passes while the exploit works is this card’s own failure mode.

**Related.** H4 — both are cases where the mechanism that enforces a property is itself unprotected.

---

## H7 — A connection string or a secret leaving through a log line or a serializer

**Status:** `unported` — swept from gbrain's guard corpus by `src/upstream/hazard-sweep.ts`.
No brainz counterpart. Upstream source: `scripts/check-pg-url-redaction.sh`, `scripts/check-source-config-leak.sh`.

**Mechanism.** gbrain's own words, from the guard header at the pinned commit:

> CI grep guard (v0.30.1, finding F3): no source file under src/ may emit … without first running it through redactSourceConfig() will leak the secret.

**What masked it.** The leak is in the *error* path and the *debug* path, which is where fixtures are thinnest. A redaction helper that exists and is called at four of five sites tests identically to one called at five, because the fifth is the path that only runs when something has already gone wrong.

**brainz analog.** Direct. The control plane stores `connection_secret_ref` and `bearer_secret_ref` rather than the values, precisely so this cannot happen there — but the request path resolves both, and any exception body, structured log, or `_meta` block that serialises a config object it did not redact carries a per-tenant credential out. `src/control/schema.sql`’s alphabets stop the control plane from *storing* one; nothing stops a handler from *printing* one.

**The guard.** A source scan, in the shape `test/ai/boundary.test.ts` already uses for the gateway boundary: no module may pass a value derived from the secret store, or a whole config object, to a logging surface or a serializer without a named redaction call in between.

---

## H8 — A structured value encoded twice on its way into the database

**Status:** `unported` — swept from gbrain's guard corpus by `src/upstream/hazard-sweep.ts`.
No brainz counterpart. Upstream source: `scripts/check-jsonb-params.mjs`, `scripts/check-jsonb-pattern.sh`.

**Mechanism.** gbrain's own words, from the guard header at the pinned commit:

> that caused the v0.12.0 silent-data-loss bug (JSONB columns stored as … The legacy scripts/check-jsonb-pattern.sh only catches the template-tag form

**What masked it.** The dev engine. Upstream’s embedded Postgres accepted the double-encoded form and read it back as the caller expected; the real engine stored a JSON string scalar. Every local test passed and every sync against the real database aborted. `docs/porting-hazards.md` already names this class under "Candidates for the next pass" as *dev engine masks remote engine*.

**brainz analog.** Not the same bug — brainz has no JSONB column and one engine — but the same *shape*, and it has already bitten once here: `src/core/write/pg-values.ts` exists because Bun’s SQL template spreads a JavaScript array into a value list, so binding `[’personal’]` against a `text[]` column sends a bare string. That module’s own header reaches the same conclusion as upstream’s JSONB rule: bind as text and let the cast parse it, because the driver’s handling is not the one the column wants. The generalisation is unguarded — any future column whose driver encoding differs from its Postgres type is the same hazard.

**The guard.** A scan asserting that every `::text[]`, `::jsonb` or array-typed bind goes through a named serializer rather than an inline literal, plus a round-trip test per such column that reads the value back through SQL and compares it to what was written — the half a type signature cannot do.

---

## H9 — A test hook that times out before the work it sets up can finish

**Status:** `unported` — swept from gbrain's guard corpus by `src/upstream/hazard-sweep.ts`.
No brainz counterpart. Upstream source: `scripts/check-bun-test-timeout.sh`.

**Mechanism.** gbrain's own words, from the guard header at the pinned commit:

> afterAll/afterEach hooks. Hooks do NOT inherit a test

**What masked it.** Nothing, on a fast machine. The hook that provisions a schema finishes inside the default budget locally and misses it on a loaded CI runner, so the failure is a flake attributed to the test rather than to the budget — and per-test timeouts are not inherited by hooks, so a file whose tests all declare a generous timeout still runs its `beforeAll` against the default.

**brainz analog.** Direct and load-bearing. brainz’s database-backed suites do their expensive work in `beforeAll`: `test/schema/fixture.ts`, `test/worker/fixture.ts`, `test/hazards/fixture.ts` and `test/ai/fixture.ts` each provision a throwaway database and apply DDL before a single assertion runs. Those are exactly the hooks the default budget is sized wrong for.

**The guard.** A check that every `bun test` invocation in CI configuration and runner scripts passes an explicit `--timeout`, so the budget is a number somebody chose rather than a default nobody saw.

---

## H10 — Two retry ladders multiplying into one

**Status:** `unported` — swept from gbrain's guard corpus by `src/upstream/hazard-sweep.ts`.
No brainz counterpart. Upstream source: `scripts/check-no-double-retry.sh`.

**Mechanism.** gbrain's own words, from the guard header at the pinned commit:

> Wrapping them ALSO at the call site produces 3

**What masked it.** Both layers are correct in isolation and both are tested in isolation. The product only appears under sustained failure, which is the one condition a green suite never reproduces — and it appears as extra load on a service that is already degraded, which reads as the incident rather than as a contributor to it.

**brainz analog.** Two ladders exist already. `control.job` carries `max_attempts` with backoff, and the model gateway has its own provider-level retry; a handler that retries a gateway call inside a job attempt multiplies them. Worse here than upstream, because the amplified unit is a paid model call against a per-tenant spend cap, not a database write.

**The guard.** A scan asserting no call site wraps a self-retrying primitive in a second retry, plus a test that counts provider invocations across one failing job attempt and pins the number.

---

## H11 — Non-protocol bytes on the channel a client is parsing

**Status:** `unported` — swept from gbrain's guard corpus by `src/upstream/hazard-sweep.ts`.
No brainz counterpart. Upstream source: `scripts/check-progress-to-stdout.sh`.

**Mechanism.** gbrain's own words, from the guard header at the pinned commit:

> piped-output scenario: agents that capture stdout for structured

**What masked it.** Interactive use. A human reading a terminal sees progress output and a result; a parser sees one malformed stream. The bytes are written by code whose job is to be helpful, so the surface that breaks is never the surface being tested.

**brainz analog.** Named already in `docs/porting-hazards.md` under "Candidates for the next pass" as *non-protocol bytes on the MCP stdio stream*; this card is that candidate written up. brainz serves MCP over HTTP rather than stdio, which moves the surface rather than removing it: anything written outside the envelope — a stray `console.log` in a handler, a warning from a library, a progress line — lands in the response body a client is parsing as JSON-RPC.

**The guard.** A scan for writes to stdout from any module reachable from the request path, and a server-level test asserting the response body parses as exactly one JSON-RPC message with no leading or trailing bytes.

---

## H12 — Module-level state leaking between test files in one process

**Status:** `unported` — swept from gbrain's guard corpus by `src/upstream/hazard-sweep.ts`.
No brainz counterpart. Upstream source: `scripts/check-test-isolation.sh`.

**Mechanism.** gbrain's own words, from the guard header at the pinned commit:

> into one bun process per shard; module-level state (env vars, PGLite

**What masked it.** File-at-a-time runs. Every file passes alone; the leak needs the parallel runner that loads several files into one process, and it surfaces as a flake in a file that did not cause it. The test most likely to be blamed is the one least likely to be at fault.

**brainz analog.** brainz mutates process-level state in tests by construction: `DATABASE_URL`, the pace and spend environment knobs, and the module-scoped fixtures that hold a database handle. Bun loads multiple files per process, so any `process.env` assignment at module scope is visible to every other file in the shard.

**The guard.** A scan over non-serial test files for module-scope `process.env` mutation and for module-scope state that outlives a file, with an explicit allowlist for the files that genuinely need it.

---

## H13 — A new union member falling through a switch nobody updated

**Status:** `unported` — swept from gbrain's guard corpus by `src/upstream/hazard-sweep.ts`.
No brainz counterpart. Upstream source: `scripts/check-pagetype-exhaustive.sh`.

**Mechanism.** gbrain's own words, from the guard header at the pinned commit:

> extending PageType (e.g. v0.27.1 adding 'image') silently fell through

**What masked it.** The compiler. TypeScript does not require a `switch` over a union to be exhaustive unless the default branch is typed to reject the leftover, so adding a member type-checks everywhere and silently takes the default path at every site that did not handle it.

**brainz analog.** brainz has several such unions and they carry weight: `control.job_kind` and `control.job_target` in the runner, the page and media types in the write path, the intent labels the ranking plan switches on. `noFallthroughCasesInSwitch` is on in `tsconfig.json`, and it guards a different thing — a missing `break`, not a missing case.

**The guard.** A scan asserting every `switch` over a discriminated union ends in an `assertNever`-shaped default, so the compiler is forced to error when a member is added.

---

## H14 — A symlink in the repository pointing at one machine

**Status:** `unported` — swept from gbrain's guard corpus by `src/upstream/hazard-sweep.ts`.
No brainz counterpart. Upstream source: `scripts/check-no-tracked-symlinks.sh`.

**Mechanism.** gbrain's own words, from the guard header at the pinned commit:

> A symlink committed from a build sandbox points at a path that exists on

**What masked it.** The machine it was committed from, where the link resolves. Everywhere else the checkout produces a dangling path and the first thing to open it fails — upstream lost `bun install` on every fresh clone to exactly this.

**brainz analog.** Identical; nothing about the substrate changes it. Cheapest card in this file and the one most likely to be dismissed, which is roughly why upstream wrote the guard after the incident rather than before it.

**The guard.** A check that `git ls-files -s` reports no entry in mode `120000`.

---

## H15 — A test that claims determinism and reaches the network anyway

**Status:** `unported` — swept from gbrain's guard corpus by `src/upstream/hazard-sweep.ts`.
No brainz counterpart. Upstream source: `scripts/check-fuzz-purity.sh`.

**Mechanism.** gbrain's own words, from the guard header at the pinned commit:

> no transitive imports of `node:fs`, `node:child_process`

**What masked it.** A populated cache and a working network. The reach succeeds, the value matches, the test is green — and the claim it was written to defend ("this tier is deterministic and makes no model calls") is false in a way that only shows up in the one environment nobody runs it in.

**brainz analog.** Partially covered, and the uncovered half is the structural one. `evals/blocking.ts` traps `fetch` so an accidental live call during the blocking tier is a violation rather than a quietly different score — that is the network half, at run time. What upstream additionally checks is *structural* purity: bundling each target to resolve its full transitive import graph and rejecting a filesystem, process or socket import anywhere in it. A module that reads a file at import time passes brainz’s trap and fails upstream’s.

**The guard.** Bundle each determinism-claiming entry point and assert the bundle contains no `node:fs`, `node:child_process`, `node:net`, `node:http` or `node:https` — the transitive check the runtime trap cannot make.

**Related.** The blocking tier’s determinism claim is what U7 puts in the Verification Contract.

<!-- END swept-cards -->

---

## Candidates for the next pass

Not yet written up. From gbrain's guard corpus and incident log, in rough priority order:

- **Dev engine masks remote engine** — PGLite hid a JSONB double-encoding bug that aborted every
  sync on real Postgres. brainz analog: any behavior that differs between a local dev database
  and Neon. Guard: parity tests that must run against a real remote, not a local stand-in.
- **Unhandled rejection in a detached timer** — brainz analog: uncaught async in a scheduled
  consolidation handler, where the failure is invisible because nothing awaits it.
- **Non-protocol bytes on the MCP stdio stream** — gbrain guards progress output escaping to
  stdout. brainz analog: anything non-JSON-RPC on an MCP stdio stream, the most common way a
  local MCP server dies silently.
- **Cost estimate diverging from actual by orders of magnitude** — the $50.71-against-$0.96 run.
  brainz analog: any LLM call whose fan-out is driven by data cardinality rather than a
  configured constant. Guard: estimate before running, refuse over budget, cap mid-run.
- **Job progress that signals liveness as well as completion** — the difference between "still
  working" and "wedged" on a 41,000-email import is a support ticket. U10 ships the wall-clock
  attempt deadline as the backstop; per-item progress is still unported.
