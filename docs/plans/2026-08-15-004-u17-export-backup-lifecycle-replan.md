# U17 re-plan — export, backup, lifecycle

**Date:** 2026-08-15 · **Unit:** U17 (Phase 4) · **Requirements:** R18, R12 (lifecycle side), R22, R16
**Roadmap:** `docs/plans/2026-08-11-001-feat-brainz-v1-roadmap-plan.md` §U17 — *"Milestone-grade — re-plan
before execution."* This is that re-plan. It is a sibling document; the roadmap body is unedited.

The paired controller/processor determination is **not** an assumption this unit had to invent: a sibling
settled it at `docs/plans/2026-08-13-003-u15-web-app-identity-billing-replan.md` §6, and §6.3 fixes four
properties the subject-scoped erasure path must have. §5 below is written against that checklist.

---

## 1. What the roadmap asked for, and what it did not say

Six things, and the order below is the order they get built:

1. Slug-nested markdown export identical to the self-host input format, plus scheduled self-export to a
   user-owned destination with a **bounded** nag.
2. Page versions + revert. (Soft-delete with the 72h TTL cascade already shipped at U6 — `src/mcp/tombstone.ts`
   — because `forget` went live in Phase 1. This unit inherits it rather than re-building it.)
3. Blast-radius preview on destructive ops **including context severance**, showing what will be
   **recomputed**, not only what will be removed.
4. A round-trip test that pins **knowledge** parity, not file parity — scheduled and secret-gated, because
   re-consolidation makes model calls. A file-parity-only check stays in the blocking suite.
5. The five-leg account erasure runbook, including the Pipedream leg that has had no caller.
6. A subject-scoped erasure path keyed on a correspondent identifier, with a stated time bound.

What the roadmap did not say, and this re-plan has to decide, is **where the exported bytes come from**.
That question turns out to govern half the unit.

---

## 2. The decision that governs the export: the page body is not stored

`page` has no body column. The only copy of a document's text inside the tenant database is `chunk.content`,
and `chunk.content` **carries U4's 200-character reach-back overlap** — it is context for the embedding, not
coverage. The chunker guarantees its coverage intervals tile the source exactly, but those intervals
(`sourceStart`, `sourceEnd`, `contentStart`) are computed at write time and **never stored**. So:

> A naive export that concatenates `chunk.content` in ordinal order emits a document with up to 200
> duplicated characters at every chunk boundary. It is not the user's file. It would pass a
> "the export is non-empty" test and every file-parity test that compares an export against *itself*.

Three ways out were considered.

| Option | Verdict |
|---|---|
| Add `source_start` / `content_start` columns to `chunk` and have the write path fill them | Correct, and **out of territory** — `src/core/write/write-path.ts` is U4's and a sibling is live in it. Also leaves every pre-rung row unreconstructable, so the fallback below is needed anyway. |
| Export from the R2 raw payload | Only connector/import pages have one. A `remember` note has none, and a raw Gmail payload is provider JSON, not the markdown the self-host format is defined in. |
| **Reconstruct by de-overlapping, and verify the reconstruction against `page.content_sha256`** | **Chosen.** |

`contentDigest(title, body) = sha256(title + "\n" + body)` is already written on every page by U4
(`write-path.ts:contentDigest`), and it is the *idempotency key*, so it is exact and it is never stale. The
export therefore does not have to *trust* its de-overlap: it recomputes the digest over what it reconstructed
and compares.

**The de-overlap is greedy and can be wrong, and that is why the digest is the arbiter.** Chunk *N*'s content
begins with a copy of the text ending at chunk *N−1*'s coverage end. The reconstructor takes the longest
prefix of chunk *N* that the accumulated text ends with, up to the overlap ceiling, and joins there. On text
containing a ≥200-character repeated pattern the longest such prefix is **not** the true overlap and the
join silently drops a span. The digest catches exactly that, and a fixture built from a repeated pattern is
the first red this unit observes.

**Policy on mismatch: neither silence nor omission.** A page whose reconstruction fails to verify is exported
anyway *and* marked in the export manifest as `verified: false`, and the receipt carries a count. Dropping it
would hand the user a backup that is missing a document without saying so; shipping it unmarked would hand
them a corrupted one. A quarantined or tombstoned page is not exported at all — those are not the user's
corpus — and the manifest says how many were skipped for which reason.

---

## 3. The export format, and why the path comes from `external_ref`

The self-host input format is U8's folder import: a directory of UTF-8 text files, where `decodeEntry` sets
`title = path` and `body = the file's bytes`. There is no frontmatter parser, and adding one would be an edit
to U8's module.

**Path derivation.**

- A page whose `external_ref` is a folder ref (`folder:<rootId>/<relative path>`) exports at that *relative
  path*, with the root id stripped. This is what makes export∘import∘export a **fixed point**: the first
  export writes `notes/foo.md`; a re-import under any root id writes `folder:<root>/notes/foo.md`; the second
  export strips the root and writes `notes/foo.md` again. No title parsing, no heuristic.
- Every other page (mail, calendar, `remember` notes) exports at a **slug-nested** path,
  `<source-type>/<slug>.md`, where the slug is derived from the title, with the page id appended when two
  pages slug identically. Deterministic, ordered by page id, so two exports of an unchanged brain are
  byte-identical.

**Titles.** A connector page's title (a mail subject) is not in its path, and `decodeEntry` sets `title = path`
on import, so the subject would evaporate on round-trip. Non-folder pages therefore export with a
`# {title}` heading prepended to the body. That is markdown a human reads and markdown the importer stores
verbatim — and from generation 2 the page is a folder-ref page, so the heading is inside the body and the
transform is not applied twice. The fixed point holds from generation 2 onward, and the file-parity test
asserts exactly that: `export(import(export(brain))) == export(import(export(import(export(brain)))))` is
overkill; `gen2 == gen3` is the property, and it is what the test pins.

**What is not exported.** Model-derived artifacts — entity cards, salience, commitments, edges — per R18.
They are re-derived on import at re-consolidation cost. This is precisely why file parity is not knowledge
parity (§6).

---

## 4. Lifecycle

### 4.1 Versions cannot ride on tombstones

U4 replaces a changed document by tombstoning the previous page and writing a new one, so a predecessor
exists — for 72 hours. `purgeExpiredTombstones` then hard-deletes it. **Version history built on tombstoned
predecessors is version history with a 72-hour memory**, which is not a durability contract.

So rung v9 adds `page_version`: an explicit snapshot table, one row per captured version, carrying the
reconstructed body and the digest it was captured at. Two callers populate it, and both are in this unit:

- `capturePageVersion` — snapshots a live page's current content. Called by `revertPage` *before* it reverts,
  so a revert is itself undoable.
- `captureSupersededVersions` — a sweep that finds tombstoned pages sharing an `external_ref` with a live
  page and banks them as versions **before** the TTL purge can remove them. This is what makes version
  history real for the ordinary case (an edited file, an updated thread) without touching the write path.

`revertPage` re-ingests the chosen snapshot through U4's existing `ingestDocument`. That re-chunks and
re-embeds — the honest cost — and requires **zero** write-path changes.

### 4.2 Blast radius, and the half everyone forgets

Two previews, one shape.

- `previewForget(id)` — the cascade `src/mcp/tombstone.ts` would apply, counted before it applies.
- `previewSeverance(origin)` — and this is the one the roadmap singles out. Severing an origin (disconnecting
  the work account) partitions every derived row by its `origin_contexts`:

  | Row's origins | Outcome |
  |---|---|
  | exactly `{severed}` | **removed** |
  | `{severed} ∪ others` (mixed) | **recomputed** — the row's surviving inputs still support *a* claim, but not this one; it must be re-derived from what is left |

  A preview that reports only the first column tells the user severance costs them their work mail. It costs
  them their work mail **and** every entity card, commitment, fact and edge that mixed work with personal —
  which is the expensive half and the one they would want to know about first. The preview therefore returns
  `removed` and `recomputed` as separate counts per table, plus the re-consolidation the recompute implies.

  **The test for this is the trap.** A severance preview over a fixture where nothing is mixed passes
  trivially and proves nothing. The fixture carries a mixed-origin fact, a mixed-origin entity, a
  mixed-origin entity card and a mixed-origin commitment, and the test asserts each lands in `recomputed`
  and *not* in `removed`.

---

## 5. Erasure

### 5.1 The five legs of account erasure

| # | Leg | Store | Port | Status |
|---|---|---|---|---|
| 1 | Neon project delete | tenant database | `NeonProjectApi.deleteProject` (exists, idempotent) | wired; live call deferred |
| 2 | R2 prefix delete | object storage | `ErasableObjectStore` (**new**, defined here — `RawStore` has only put/get) | wired; live call deferred |
| 3 | Control-plane row | control plane | direct control-plane SQL handle | wired |
| 4 | **Pipedream external-user deletion with token revocation** | connector vendor | `PipedreamClient.deleteExternalUser` | **wired — this unit is its first caller** |
| 5 | Stored BYOK provider key (R22) | secret store | `TenantProviderKeyStore.revokeAll` | wired |

Leg 4 is the one the roadmap calls out and the one that was missing: `deleteExternalUser` has existed since
U9 with **no caller anywhere in `src/`**, deliberately left for this unit. Without it, live OAuth tokens to
the erased user's mailbox persist at a vendor inside the trust boundary and "no queryable trace" is false.

**The receipt does not launder the vendor's honesty.** `deleteExternalUser` returns
`tokensRevoked: 'unverified'` and classifies 404/410 as `already_absent` rather than as `deleted`. Both flow
into the erasure receipt verbatim. The receipt says `tokensRevoked: 'unverified'` until
`docs/vendor/2026-08-12-pipedream-compliance.md` carries a written answer — promoting it would put a false
sentence in a privacy policy.

**A sixth store, named rather than discovered later.** The tenant's secret-store rows — the connection string
and the fleet bearer (`src/control/secrets.ts`) — are not one of the five legs the roadmap names, and they
are real. They are erased as part of **leg 3**, in the same step as the control-plane row, because they are
the control plane's own record of the tenant rather than a separate party's copy of the user's content.
Leaving them would leave a credential to a database that no longer exists — harmless in effect and dishonest
in a receipt that claims no trace. The receipt names them as a sub-step of leg 3 rather than inventing a
sixth leg, so the roadmap's count stays true.

**Ordering, and why it is not "delete the database first".** Legs run **credentials first, data last**:
Pipedream (stop the inflow), BYOK key, R2, Neon, control-plane row. A run that deleted the Neon project first
and then died would leave a live OAuth grant polling a mailbox into a tenant that no longer exists. Each leg
is independently retryable and reports its own outcome; a partial run is reported as partial, never as
success. The control-plane row goes **last** because it is the only record of what the other four legs were
supposed to target.

### 5.2 Subject-scoped erasure (R12, against U15 §6.3's four properties)

| §6.3 property | How this unit implements it |
|---|---|
| **Keyed on a correspondent identifier, not a tenant** | The identifier is an email address or an entity slug, normalised through the *same* normalizer the write path used (`src/core/write/normalize.ts`, re-exported by search) and resolved through `entity_slug` and `entity_alias`. A tenant is never the key. |
| **Spanning derivation, not just rows** | The span is: the resolved `entity`, its slugs, aliases and `entity_edge` rows; its `entity_card`; every `commitment` and `fact` traceable to it; the `chunk`s those facts were extracted from (`fact_source`) and the `page`s those chunks belong to; and the R2 raw payloads keyed from those pages' external refs. |
| **Invocable by the controlling user, out of band** | The module exports a function, not an MCP tool. It is not registered in `src/mcp/tools/`, and R12a's rule is the reason: the assistant that would issue it is the assistant reading the correspondent's mail. |
| **Tombstoned against re-ingestion** | Rung v9's `erased_subject` table. Erasure writes a row per identifier; the pull path is expected to consult it before writing a page. **This half is not wired** — see §7. |

**The honest limit, stated rather than discovered.** The span above reaches content the extractor *linked* to
the correspondent. A message that mentions them and from which no fact was extracted is reachable only if the
page itself carries the identifier. The path therefore takes both handles — the entity graph **and** a
literal-identifier scan over page titles and chunk content — and reports each page's handle in the receipt,
so a user reading it can see which rows were found by derivation and which by text. What no mechanism here
can promise is a mention the extractor missed *and* that does not contain the identifier as text. That is a
limit of extraction, not of erasure, and it is recorded here rather than in a footnote.

**The time bound.** The roadmap fixes the stated deletion SLA as *the platform PITR window* — the point past
which a deleted row is unrecoverable from the substrate's own history, not the point at which the delete
statement returns. Neon's history retention is a project-level setting; the control plane does not currently
set it (grepped: no history-retention field in `src/control/neon-api.ts` or `provision.ts`), so the honest
statement is:

> **Account erasure and subject-scoped erasure both complete within the platform's point-in-time-recovery
> window, stated as 7 days.** Rows stop being queryable immediately; they stop being *recoverable* when the
> retention window rolls. Provisioning does not currently pin the retention setting, so this number is the
> Neon plan default and not a value this codebase asserts — pinning it at provision time is filed as the
> follow-up that makes the SLA a property of the system rather than of the invoice.

Both bounds are the same number and are stated beside each other deliberately: a subject request that took
longer than an account deletion would be a promise made to the party with the least leverage.

---

## 6. The round-trip test, and the line `bun test` may not cross

R18: model-derived artifacts are re-derived on import. So a file diff can be **perfectly green while the
re-imported brain has no entity cards, no salience and no commitments** — every artifact the product is
actually for. Two legs, and the split is a hard constraint, not a preference:

| Leg | Command | Where it runs | What it proves |
|---|---|---|---|
| **File parity** | `bun test` | blocking, every push | export → import → export is a fixed point, byte for byte, and the digest verification held |
| **Knowledge parity** | `bun run test:roundtrip` | scheduled, secret-gated | export → fresh tenant import → **re-consolidate** → the blocking eval scores at its floors |

`bun test`'s defining promise is zero model calls and no egress. Re-consolidation is model calls. So the
knowledge leg lives in `evals/roundtrip.ts`, reached through `scripts/not-yet.ts`'s dispatcher (which
`package.json` already points at, so no `package.json` edit — a hard limit of this session). **Without
secrets it refuses and exits non-zero.** A gate that reports success because it could not run is the exact
failure this whole unit is built against.

---

## 7. What is deferred, and why — no fake passes

- **Live Neon project delete, live R2 prefix delete, live Pipedream `DELETE`.** All three are wired and all
  three are exercised against fakes that record the call and then *report absence*. Running them for real
  needs a live vendor account and would create and destroy cloud resources, which this session may not do.
  The erasure runbook is `deferred` on the live leg, with the reason named, and never a fake pass.
- **The re-ingestion suppression wiring.** `erased_subject` is written by the erasure path and is a table the
  pull path must consult before writing a page. `src/ingest/pipedream/pull.ts` is outside this unit's
  territory, so the *consulting* half is not wired here. This is the property U15 §6.3 flags as "most likely
  to be missed", so it is not left implicit: the ledger row stays `not-yet` and names this exact half.
- **Scheduled self-export delivery to a user-owned destination.** The schedule, the job payload, the bounded
  nag and the state are built; the *transport* to a user's own bucket or Drive is a live-vendor leg.

---

## 8. Build order

1. Rung v9 — new tables only (`page_version`, `export_state`, `erased_subject`). Expand-only.
2. Export: reconstruct + digest verification (red: the repeated-pattern fixture) → tree writer → file-parity.
3. Versions + revert (fixture with **three** versions; a one-version fixture makes revert pass trivially).
4. Previews (severance fixture **must** carry mixed-origin rows).
5. Account erasure — five fakes, each leg seeded then asserted **absent**, each mutated in isolation.
6. Subject-scoped erasure + the suppression tombstone.
7. Export job handler + the bounded nag.
8. `evals/roundtrip.ts`, registered in the dispatcher.

Every guard gets mutated. A guard that is green because the fixture never provoked its branch is this repo's
recorded failure mode — three times.
