-- ===========================================================================
-- brainz tenant schema — rung 12, the holding pen for severed aliases (U18)
--
-- One table, and it exists because `entity_alias` is the **one** derived table in
-- this schema whose origins are allowed to be a strict subset of its parent's —
-- which makes it the one table with a severance residue nothing could reach.
--
-- ---------------------------------------------------------------------------
-- **Why the residue is unique to this table.**
--
-- Severance's first class is "rows whose origins are exactly the severed one —
-- these go". For every other derived table the schema already guarantees such a
-- row cannot outlive the severance, and it guarantees it with a *constraint*
-- rather than with a sweep:
--
--   * `entity_card_origin_union` (rung 3) refuses a card whose origins do not
--     COVER its entity's, so `card ⊆ {severed}` forces `entity ⊆ {severed}` and
--     severance tombstones the entity in the same statement.
--   * `entity_edge_origin_union` (rung 2) refuses an edge that does not carry
--     both endpoints' origins, so an exact-origin edge has two exactly-severed
--     endpoints — both tombstoned, both purged, and the edge leaves with them
--     through `entity_edge_subject_fkey ... ON DELETE CASCADE`.
--   * `commitment_origin_union` says the same of a commitment's fact and page.
--
-- `entity_alias` has **no covering constraint, deliberately**. Rung 11's whole
-- argument is that an alias must be allowed to be *narrower* than its entity:
-- `resolveOrCreateEntity` plants the normalized surface form taken from the text
-- being ingested, so an alias is a spelling one outside sender chose in one
-- mailbox, and judging it by the entity's whole union is what rung 11 fixed.
--
-- The consequence is the residue. A work-only alias on a **mixed** entity is
-- exactly severance's first class, and the entity survives by design — so there
-- is no cascade to ride, and `entity_alias` carries no `deleted_at` for a
-- tombstone to be written to.
--
-- ---------------------------------------------------------------------------
-- **Why the row MOVES rather than gaining a `deleted_at`.**
--
-- `ALTER TABLE entity_alias ADD COLUMN deleted_at` is additive and is still the
-- wrong shape, for two reasons that are facts about this repository rather than
-- preferences:
--
--   1. **Nine sites read aliases** (`mcp/reads.ts` ×3, `core/search/read.ts` ×2,
--      `core/search/arms.ts`, `core/briefing/assemble.ts`, `core/write/links.ts`
--      ×2, `core/lifecycle/subject-erasure.ts`). A tombstone is only honoured by
--      the sites that remember its predicate; the one that forgets keeps serving
--      the retracted spelling, which is the defect one layer down and in eight
--      more places. A row that is not in `entity_alias` is invisible to a query
--      against `entity_alias` whether or not its author knew about severance.
--   2. **`entity_alias_is_unique_per_entity` is a TOTAL unique constraint**, not
--      a partial one over live rows. A tombstoned alias would hold its own
--      spelling's slot against re-creation for as long as it sat there, and
--      making that constraint partial is a contracting change the rung
--      discipline forbids. An archived row occupies no slot.
--
-- ---------------------------------------------------------------------------
-- **`severed_at`, not `deleted_at`, and the name is load-bearing.**
--
-- `test/core/lifecycle/restore-coverage.test.ts` reads `information_schema` and
-- refuses any table carrying `deleted_at` that is not classified in
-- `src/mcp/tombstone.ts` as either a user tombstone or a reasoned exclusion.
-- That census is right and this table is neither: presence in it IS the
-- retraction, so a nullable flag beside it would be a second, disagreeable
-- answer to the same question. The column records **when the severance took the
-- row**, which is the key `restoreForgotten` un-does by — the same instant every
-- other row in that severance carries, so one undo reaches all of them.
--
-- ---------------------------------------------------------------------------
-- **No uniqueness here, on purpose.** The same spelling can be severed, restored
-- or re-written, and severed again; two archive rows for one (entity, alias) at
-- two instants is a correct history, and a unique key over them would make the
-- second severance raise instead.
--
-- **Expand-only, like every rung.** One CREATE TABLE, one index, two triggers.
-- Nothing here alters an existing table, so a fleet instance that predates this
-- rung serves a tenant carrying it without noticing.
-- ===========================================================================

CREATE TABLE severed_alias (
  severed_alias_id bigint      GENERATED ALWAYS AS IDENTITY,
  entity_id        bigint      NOT NULL,

  -- The alias, verbatim. Restoring re-inserts these columns unchanged: the
  -- archive is a holding pen, not a re-derivation, and R15 makes the origins
  -- unwritable anyway.
  alias            text        NOT NULL,
  alias_source     text        NOT NULL,
  confidence       real,
  origin_contexts  text[],

  -- The alias's own birth instant, carried across so a restored row is the row
  -- that was taken rather than a copy that claims to be new.
  created_at       timestamptz NOT NULL,
  -- The severance instant. The undo key, and the purge's cutoff.
  severed_at       timestamptz NOT NULL,

  CONSTRAINT severed_alias_pkey PRIMARY KEY (severed_alias_id),
  -- The entity may still be purged out from under the archive — a mixed entity
  -- that is later erased or forgotten. The row goes with it, exactly as the live
  -- alias would have.
  CONSTRAINT severed_alias_entity_fkey FOREIGN KEY (entity_id) REFERENCES entity (entity_id) ON DELETE CASCADE,
  -- The live table's own CHECKs, repeated, so a restore cannot put back a row
  -- `entity_alias` would refuse — which would abort the whole undo transaction
  -- at the last table rather than at this one.
  CONSTRAINT severed_alias_is_not_empty CHECK (length(btrim(alias)) > 0),
  CONSTRAINT severed_alias_source_is_known CHECK (alias_source IN ('user', 'inferred')),
  CONSTRAINT severed_alias_inferred_is_scored CHECK (
    alias_source <> 'inferred' OR (confidence IS NOT NULL AND confidence >= 0 AND confidence <= 1)
  ),
  -- Nullable for the same reason rung 11's is: rows written before that rung
  -- carry no provenance, and one of them can still reach this table by way of
  -- its entity's union.
  CONSTRAINT severed_alias_origins_are_a_non_empty_set CHECK (
    origin_contexts IS NULL
    OR (cardinality(origin_contexts) > 0 AND array_position(origin_contexts, NULL) IS NULL)
  )
);

COMMENT ON TABLE severed_alias IS
  'operational — aliases a context severance took, held for the same 72h `forget` promises. Presence IS the retraction: there is no `deleted_at` here, so the tombstone census in `src/mcp/tombstone.ts` does not and must not claim it.';

COMMENT ON COLUMN severed_alias.severed_at IS
  'the severance instant — the key `restoreForgotten` un-does by and the cutoff `purgeExpiredTombstones` sweeps on, the same instant every other row that severance took carries.';

-- The two reads: "undo the severance at this instant" and "sweep everything
-- older than the cutoff". One index serves both.
CREATE INDEX severed_alias_by_instant ON severed_alias (severed_at);

-- R15's immutability, applied here for the same reason it is applied to every
-- other origin column: `src/schema/origin-fence.ts` discovers origin columns by
-- catalog scan, so a new table carrying one and no trigger fails provisioning.
-- **Both arms, per rung 8 (H6):** the unpinned original is what
-- `findOriginFenceViolations` matches by name, the pinned twin is what
-- `findUnpinnedFenceCoverage` requires of every unpinned fence trigger.
CREATE TRIGGER severed_alias_origin_is_immutable
  BEFORE UPDATE OF origin_contexts ON severed_alias
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_contexts');

CREATE TRIGGER severed_alias_origin_is_immutable_pinned
  BEFORE UPDATE OF origin_contexts ON severed_alias
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change_pinned('origin_contexts');
