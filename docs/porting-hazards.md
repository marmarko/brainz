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

**brainz analog.** Direct and current. KTD8 selects `text-embedding-3-large`, natively 3072d,
against a `vector` type that indexes to 2,000. The plan resolves it by **truncating to 1536d**
(Matryoshka), which sits inside the ceiling with headroom — `halfvec(3072)` is the alternative
if a future model makes native dimensionality worth the storage. Either resolution is fine; the
hazard is shipping *neither* and not noticing.

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
- **Lock renewal starved by connection rotation** — production lost ~39 worker processes/day when
  the pooler rotated connections mid-`renewLock`. brainz analog: any long-held lease renewed over
  a pooled connection.
