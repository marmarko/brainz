-- ===========================================================================
-- brainz tenant schema — rung 18, the retraction ledger
--
-- One table, and it exists because the 72-hour window had a key and no index.
--
-- ---------------------------------------------------------------------------
-- **What was actually broken.**
--
-- `src/mcp/tombstone.ts:restoreForgotten` has been complete, correct and tested
-- since R12, and had zero production callers: not a tool in `TOOL_NAMES`, not an
-- op in `ADMIN_OPERATIONS`, nothing in the web app. So `forget` told every user
-- `recoverableUntil = now + 72h` and no surface in the running system could
-- honour it. That was survivable only while nothing hard-deleted; the retention
-- lane is now switched on, so a retraction is irreversible in fact and the
-- promise on the receipt is false rather than merely unimplemented.
--
-- A restore surface needs two things. The first exists: `restoreForgotten` keys
-- on the **severance instant**, so "undo this" is answerable from a timestamp
-- alone. The second does not exist anywhere: **"what may I undo?"** — the
-- distinct instants inside the window, with enough shape for a human to tell one
-- retraction from another. That question has no answer derivable from the
-- content tables, and this rung is where the answer goes.
--
-- ---------------------------------------------------------------------------
-- **Why the module header's "there is no ledger table" survives this rung.**
--
-- `tombstone.ts`'s header says recovery keys on the deletion instant, "which is
-- why there is no ledger table". That is still true and is not what this table
-- does. The recovery key is unchanged: `restoreForgotten` still takes an instant
-- and still un-deletes rows whose `deleted_at` equals it, and nothing here is
-- read on the restore path's way to a row. This is a **discovery index** — it
-- answers which instants exist and what shape each one had — and it carries
-- exactly one thing the instant cannot carry: provenance.
--
-- **Provenance is the reason this could not be derived.** The obvious listing is
-- a `UNION` of `SELECT DISTINCT deleted_at` over the tombstoned tables, and it is
-- wrong in a way that is invisible until it ships: `lifecycle/subject-erasure.ts`
-- stamps its own instant on all seven of those tables, so every erasure of a
-- correspondent — requested by a third party, about a third party, and NOT
-- undoable by `restoreForgotten` because it also hard-deleted `page_version`,
-- `review_queue` and `entity_edge` — would appear to the account holder as an
-- ordinary restorable retraction with a button next to it. The obvious repair,
-- "filter out instants present in `erased_subject`", is unsound too:
-- `erased_subject`'s upsert is `ON CONFLICT (subject_digest) DO UPDATE SET
-- erased_at`, so a second erasure of one correspondent overwrites the first
-- erasure's instant while that erasure's tombstones are still inside the window,
-- and the orphaned instant reappears in the listing.
--
-- Provenance therefore has to be **positively sourced**: a retraction is
-- listable because this table says a `forget` produced it, never because a
-- filter failed to exclude it. A row here is written by exactly one call site.
--
-- ---------------------------------------------------------------------------
-- **The column set is shape, never substance.**
--
-- This table records that a retraction happened *so it can be found again*, and
-- nothing about what it was about. There is no title, no statement, no excerpt,
-- no external reference, and no `target_id`.
--
-- **`target_id` is absent deliberately**, and it is the omission most likely to
-- be re-proposed. The id points into the thing the user asked to be rid of, it
-- tells a human nothing they could recognise, and putting it here would invite a
-- per-record restore — which `restoreForgotten` cannot perform, because its unit
-- is the instant and one instant is a whole cascade.
--
--   * `retracted_at` — the restore key, and the only thing a caller sends back.
--   * `target_kind`  — `doc` / `chunk` / `fact` / `ent`, the four `forget`
--     reaches. Constrained, because a fifth kind means somebody widened the tool
--     and this table should refuse the write rather than render a word no page
--     knows how to say.
--   * `origin_contexts` — where the retracted material came from, as
--     `forgetRecord`'s fence already read it. Safe to render: these are the
--     credential labels the user chose, already on the connectors panel and
--     already the string `/api/severance` demands as its own confirmation echo.
--     Load-bearing beyond rendering — it is what makes a future forget-only MCP
--     restore fenceable by a subset check against one row, without adding a
--     fence to `restoreForgotten`.
--   * `removed` — the cascade counts exactly as the cascade counted them, so the
--     listing and the receipt cannot describe different events.
--
-- **`retracted_at`, NOT `deleted_at`, and that is a hard requirement rather than
-- taste.** `test/core/lifecycle/restore-coverage.test.ts` scans
-- `information_schema.columns` for `deleted_at` in `public` and fails in both
-- directions on any table that appears in neither `TOMBSTONED_TABLES` nor
-- `DELETED_AT_IS_NOT_A_TOMBSTONE`. This table carries no tombstone — it *is* the
-- record of one — so naming its column `deleted_at` would turn that census red
-- for a table that is not a tombstone, and the cure would be an exclusion entry
-- that makes the census weaker for every future table. `severance.severed_at`
-- set the precedent one rung over.
--
-- ---------------------------------------------------------------------------
-- **Lifetime: exactly the lifetime of what it describes.**
--
-- A ledger that outlives its tombstones is the failure this fix is supposed to
-- prevent, wearing the fix's clothes — a table of instants for retractions whose
-- rows the purge already took, which is a durable record of what a user asked to
-- be rid of, kept after the thing itself was destroyed. So the purge sweeps this
-- table on its own cutoff (`purgeExpiredTombstones`, `retractionsSwept` on the
-- receipt), and that sweep is the reason this table is permitted to exist at all
-- against the module header's argument.
--
-- ---------------------------------------------------------------------------
-- **`severance.restored_at`, and why the two arms differ.**
--
-- A restored instant must leave the listing, or the surface offers a button
-- whose second click does nothing. The record arm deletes its ledger row: this
-- is a discovery index rather than audit, and a row whose tombstones are back
-- has nothing left to discover. The origin arm cannot do that — `severance` is
-- append-only audit with a derived recompute worklist hanging off it
-- (`v10-severance.sql`) — so it gets a nullable stamp instead and the listing
-- filters on it. Nullable `ADD COLUMN`, so the previous fleet version keeps
-- writing severances that never mention it.
--
-- ---------------------------------------------------------------------------
-- **Expand-only, like every rung.** One CREATE TABLE, one index, two triggers,
-- one nullable ADD COLUMN. Nothing here rewrites a table the previous release
-- queries (`test/schema/rollout.test.ts`).
-- ===========================================================================

CREATE TABLE retraction (
  retraction_id   bigint GENERATED ALWAYS AS IDENTITY,
  retracted_at    timestamptz NOT NULL,
  target_kind     text        NOT NULL,
  origin_contexts text[]      NOT NULL,
  removed         jsonb       NOT NULL,

  CONSTRAINT retraction_pkey PRIMARY KEY (retraction_id),
  -- The four kinds `src/mcp/ids.ts` issues and `forget` accepts. A fifth means
  -- the tool grew a target this table cannot describe, and the honest place to
  -- find that out is the write.
  CONSTRAINT retraction_target_kind_is_known
    CHECK (target_kind IN ('doc', 'chunk', 'fact', 'ent')),
  CONSTRAINT retraction_removed_is_an_object CHECK (jsonb_typeof(removed) = 'object'),
  -- The same shape every other origin array in this schema carries. An empty
  -- array here would be a retraction from nowhere, which is a fence that read
  -- nothing rather than a fence that read an empty answer.
  CONSTRAINT retraction_origins_are_present
    CHECK (cardinality(origin_contexts) > 0 AND array_position(origin_contexts, NULL) IS NULL)
);

COMMENT ON TABLE retraction IS
  'operational — one row per `forget`, written in the same transaction as the tombstones it describes, so the 72-hour window can be LISTED and not merely keyed. It records that a retraction happened so it can be found again, never what it was about: no title, no statement, no excerpt, no target id. Swept by purgeExpiredTombstones on the same cutoff as the rows it describes, so it cannot outlive its subject.';

COMMENT ON COLUMN retraction.retracted_at IS
  'the retraction instant — the key restoreForgotten un-does by, and the only value a restore request sends back.';

COMMENT ON COLUMN retraction.target_kind IS
  'shape, not substance: which of the four id kinds the user retracted, so two retractions in one window are distinguishable without naming either.';

COMMENT ON COLUMN retraction.origin_contexts IS
  'where the retracted material came from, as the forget''s own fence read it. Immutable (R15) like every other origin column, and positively sourced: presence of a row here is what makes an instant listable, so an instant written by subject erasure is absent by construction rather than by a filter.';

COMMENT ON COLUMN retraction.removed IS
  'the cascade counts as the cascade counted them, so the listing and the receipt cannot describe different events.';

-- The one read this table has: "what is restorable right now", newest first.
CREATE INDEX retraction_by_time ON retraction (retracted_at DESC);

-- R15's immutability, applied here for the same reason it is applied to every
-- other origin column: `src/schema/origin-fence.ts` discovers origin columns by
-- catalog scan, so a new table carrying one and no enabled trigger fails the
-- attestation inside this rung's own transaction.
-- **Both arms, per rung 8 (H6):** the unpinned original is what
-- `findOriginFenceViolations` matches by name, the pinned twin is what
-- `findUnpinnedFenceCoverage` requires of every unpinned fence trigger.
CREATE TRIGGER retraction_origin_is_immutable
  BEFORE UPDATE OF origin_contexts ON retraction
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_contexts');

CREATE TRIGGER retraction_origin_is_immutable_pinned
  BEFORE UPDATE OF origin_contexts ON retraction
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change_pinned('origin_contexts');

-- The origin arm's "already undone" marker. Nullable and never back-filled: a
-- severance recorded before this rung was not restored, and a column asserting
-- anything about one would be this rung claiming to have observed something it
-- did not (the rule `v10-severance.sql` states for its own columns).
ALTER TABLE severance ADD COLUMN restored_at timestamptz;

COMMENT ON COLUMN severance.restored_at IS
  'when this severance''s rows were put back, or NULL. The listing filters on it so a restored severance stops being offered; the audit row itself is never deleted, because the recompute worklist is derived from it.';
