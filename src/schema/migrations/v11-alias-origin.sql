-- ===========================================================================
-- brainz tenant schema — rung 11, provenance for the alias vocabulary (R15)
--
-- One column, and it exists because `entity_alias` was the one derived table in
-- the knowledge core with no origin on it.
--
-- ---------------------------------------------------------------------------
-- **Why an entity's fence does not cover its aliases.**
--
-- `src/core/search/fence.ts` fences `entity` on **intersect**, deliberately and
-- with the reasoning written down: an entity is a *name*, and a subset rule
-- would refuse to resolve any entity appearing under more than one credential —
-- which, on a brain with a work mailbox and a personal one, is most of the
-- interesting ones. The licence for that looser rule is the sentence beside it:
-- "resolving a name is not reading a row. Every row the fan-out then produces —
-- the edges, the facts, the chunks — goes back through the subset and scalar
-- rules above."
--
-- An alias is a row, and it was not going back through anything. It is also
-- *content*: `resolveOrCreateEntity` plants the normalized surface form taken
-- from the text of the page being written, so an alias is a spelling somebody
-- wrote in a message. On a personal-origin message, that spelling is a personal
-- row — and `entityCard` handed every one of them to any grant that could
-- resolve the entity by intersect.
--
-- ---------------------------------------------------------------------------
-- **Nullable, and the read fence is what makes that safe.**
--
-- Every rung is expand-only, so this column arrives without a backfill: the
-- previous fleet version is still inserting `entity_alias` rows that name the
-- old column list, and a `NOT NULL` would fail every one of them the moment
-- this commits. Rows written before this rung — and rows written by a previous
-- release during a rolling deploy — therefore carry NULL.
--
-- NULL means "nobody recorded where this came from", which is not a licence to
-- show it. The read (`src/mcp/reads.ts:entityCard`) reads
-- `coalesce(a.origin_contexts, e.origin_contexts)`, so an unstamped alias is
-- judged as though it carried its entity's whole union — the strongest thing
-- that can honestly be said about it, and the fail-closed direction: a grant
-- sees an unstamped alias only when it holds every origin the entity has.
--
-- ---------------------------------------------------------------------------
-- **Both triggers, per rung 9 and rung 10.**
--
-- The unpinned one is what `findOriginFenceViolations` requires (it matches on
-- `refuse_origin_change('<column>')` by name); the `_pinned` twin is what
-- `findUnpinnedFenceCoverage` requires, because rung 8's rule is that every
-- unpinned fence trigger has a pinned twin of the same shape on the same table.
-- A new origin column with one and not the other fails provisioning, which is
-- the guards working rather than a hazard.
--
-- Immutability applies here for the same reason it applies everywhere else: a
-- row whose origin can change is a privilege-escalation primitive. It also means
-- this column can never be backfilled by an UPDATE, which is why the read's
-- `coalesce` is the mechanism rather than a migration nobody could write.
-- ===========================================================================

ALTER TABLE entity_alias ADD COLUMN origin_contexts text[];

-- The same shape the other origin-union columns carry, weakened by exactly one
-- disjunct: an unstamped row is legal, an empty or NULL-bearing array is not.
-- Without the disjunct this constraint would reject rows the previous release is
-- still writing while the deploy rolls.
ALTER TABLE entity_alias
  ADD CONSTRAINT entity_alias_origins_are_a_non_empty_set CHECK (
    origin_contexts IS NULL
    OR (cardinality(origin_contexts) > 0 AND array_position(origin_contexts, NULL) IS NULL)
  );

COMMENT ON COLUMN entity_alias.origin_contexts IS
  'R15 — the origins of the write that planted this spelling. NULL on rows written before rung 11; readers coalesce to the entity''s own union, which is the fail-closed reading.';

CREATE INDEX entity_alias_origins ON entity_alias USING gin (origin_contexts);

CREATE TRIGGER entity_alias_origin_is_immutable
  BEFORE UPDATE OF origin_contexts ON entity_alias
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_contexts');

CREATE TRIGGER entity_alias_origin_is_immutable_pinned
  BEFORE UPDATE OF origin_contexts ON entity_alias
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change_pinned('origin_contexts');
