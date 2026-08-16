-- ===========================================================================
-- brainz tenant schema — rung 10, the severance record (U18)
--
-- One table, and it exists because U17 built a preview with nobody to act on it.
-- `src/core/lifecycle/blast-radius.ts:previewSeverance` reports two columns —
-- what severing an origin **removes** and what it leaves **needing recompute** —
-- and the ledger row `gap.data-lifecycle` says in those words that "the severance
-- flow that consumes the second one is U18's". This is where the second column
-- goes when the user clicks.
--
-- ---------------------------------------------------------------------------
-- **Why a table rather than a column on five tables.**
--
-- The obvious design marks each surviving mixed row: a `recompute_required_at`
-- on `fact`, `entity`, `entity_card`, `commitment` and `entity_edge`. Five
-- `ALTER TABLE`s, five backfill decisions, and — the reason it is not done —
-- five columns whose value a later reader takes as an assertion about a row it
-- did not see. Rungs 5, 6, 7 and 9 all record the same rule: never write an
-- unobserved value into a column a later reader takes as an assertion.
--
-- What actually happened is one event: an origin was severed at an instant. Every
-- "needs recompute" verdict is *derivable* from that event plus the row's own
-- immutable `origin_contexts` — a row needs re-deriving exactly when its origins
-- contain a severed origin and are not contained by it. Deriving it means the
-- answer cannot go stale, cannot disagree between two tables, and cannot be
-- wrong for a row written after the severance (which has no business being
-- marked at all, and which a backfilled column would mark anyway if the write
-- path forgot to clear it).
--
-- So: one append-only row per severance, and the worklist is a query.
--
-- ---------------------------------------------------------------------------
-- **Every column records something that was observed.**
--
--   * `origin` — what the user severed. Immutable by the same trigger every
--     other origin column carries (R15): a severance record whose origin could
--     be edited is an audit trail that can be made to describe a different event.
--   * `severed_at` — when. NOT NULL, because a row exists only because it
--     happened.
--   * `removed` / `recomputed` — the two count objects **as the preview computed
--     them inside the executing transaction**, not as the page rendered them
--     minutes earlier. A user consents to a number; this is the number that
--     happened, and the difference between the two is the whole reason the
--     preview is re-run rather than passed in.
--   * `surviving_origins` — what a recompute would run against. Named so the
--     record is readable without reconstructing the brain's state at the time.
--
-- There is deliberately no `recompute_completed_at`. Re-derivation is a
-- consolidation cycle and belongs to U11; a column for it here would be this
-- unit asserting something about work it does not do, which is the exact rule
-- above. When U11 grows a consumer it adds its own rung.
--
-- ---------------------------------------------------------------------------
-- **Expand-only, like every rung.** One CREATE TABLE, one trigger, two indexes.
-- Nothing here alters an existing table, so a fleet instance that predates this
-- rung serves a tenant carrying it without noticing — which is what makes a
-- rolling deploy uneventful (`test/schema/rollout.test.ts`).
-- ===========================================================================

CREATE TABLE severance (
  severance_id      bigint GENERATED ALWAYS AS IDENTITY,
  origin_context    text        NOT NULL,
  severed_at        timestamptz NOT NULL,
  removed           jsonb       NOT NULL,
  recomputed        jsonb       NOT NULL,
  surviving_origins text[]      NOT NULL,

  CONSTRAINT severance_pkey PRIMARY KEY (severance_id),
  -- **No format CHECK on the origin, deliberately.** The grammar
  -- `src/mcp/grant-scope.ts` enforces on a *credential* belongs there and only
  -- there. Copying it here would (a) put a second copy of one rule in a place
  -- that can drift from the first, and (b) make a severance of a legacy or
  -- unusually-shaped origin literally unrecordable — turning a data-quality nit
  -- into a destructive operation that cannot be audited, which is much worse
  -- than the nit. No other origin column in this schema carries one either.
  CONSTRAINT severance_counts_are_objects
    CHECK (jsonb_typeof(removed) = 'object' AND jsonb_typeof(recomputed) = 'object')
);

COMMENT ON TABLE severance IS
  'operational — one append-only row per context severance (U18). The recompute worklist is DERIVED from this row plus each row''s own immutable origin_contexts, never stored as a per-row flag that could go stale or disagree between tables.';

-- R15's immutability, applied to this table for the same reason it is applied to
-- every other origin column: access is fenced on origin alone, so an origin that
-- can move is a privilege-escalation primitive. `src/schema/origin-fence.ts`
-- discovers this trigger by catalog scan, so the fence attestation covers it
-- from the moment the rung lands rather than from the moment somebody remembers.
-- **Both arms, per rung 8 (H6).** The unpinned original resolves its own names
-- through the calling session's `search_path`; the pinned twin cannot be fooled.
-- A new table carrying only the original would put the newest fence in the
-- schema behind the weakest arm in it, which is what
-- `test/schema/search-path.test.ts` exists to refuse.
CREATE TRIGGER severance_origin_is_immutable
  BEFORE UPDATE OF origin_context ON severance
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_context');

CREATE TRIGGER severance_origin_is_immutable_pinned
  BEFORE UPDATE OF origin_context ON severance
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change_pinned('origin_context');

-- The two reads this table has: "has this origin been severed" (the flow's own
-- idempotency check) and "what has been severed lately" (the recompute worklist
-- a consolidation cycle will scan).
CREATE INDEX severance_by_origin ON severance (origin_context, severed_at DESC);
CREATE INDEX severance_by_time ON severance (severed_at DESC);
