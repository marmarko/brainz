-- ===========================================================================
-- brainz tenant schema — rung 19, resuming a cycle that ran out of time
--
-- Two columns and one widened CHECK, and all three exist because of the same
-- measured incident: a whole-brain consolidation cycle on a 5,608-page brain
-- burned five attempts of a fifteen-minute wall-clock ceiling and completed
-- none of them. Every attempt was reaped rather than returning, so the lane
-- dead-lettered having produced no cycle in 2h46m of wall clock.
--
-- ---------------------------------------------------------------------------
-- **Why `completed` and `phase_cursor` are on the checkpoint.**
--
-- `consolidation_checkpoint` recorded a phase's *completion* and nothing else,
-- and rung 3's comment says why: its subject was money — "so a killed cycle
-- resumes without re-paying for model work it already did". Presence of a row
-- meant done, and the cycle consulted those rows for model phases only.
--
-- That is sound for a phase whose cost is a provider invoice. It is not enough
-- for a phase whose cost is wall clock. The deterministic tier re-ran in full on
-- every attempt: the writes it made committed, but its *position* did not, so
-- attempt N+1 walked the same rows in the same order as attempt N and never
-- reached the work attempt N had not done. Repeated identical work, not slow
-- progress — and under a finite attempt ceiling it never terminates.
--
-- So the checkpoint's subject widens from "which phases are paid for" to "where
-- is this brain up to", which is what rung 3's own table comment already claimed
-- the row answered. `phase_cursor` is the position inside a phase that was
-- interrupted — a keyset, opaque to this table, written and read only by the
-- phase that owns it — and `completed` is what tells a partially banked row from
-- a finished one now that presence alone no longer can.
--
-- **`completed` defaults to `true`, and the default is the rollout.** Every row
-- the previous fleet version writes is a completion (it has no other kind), and
-- every row it reads it treats as one. Defaulting to `true` therefore makes the
-- old writer's rows mean what the old writer meant, without it knowing this
-- column exists. The converse direction — a partial row written by this release
-- and read by the previous one — is handled in code rather than here: partial
-- rows are written for deterministic phases only, and the previous release
-- ignores deterministic checkpoints entirely, so the one row it would misread as
-- "paid for, skip it" is a row this release never writes.
--
-- ---------------------------------------------------------------------------
-- **Why `stop_reason` gains a member rather than reusing one.**
--
-- `budget_exhausted` and `phase_failed` both mean "something went wrong and the
-- run stays open". Running out of the attempt's wall clock is neither: nothing
-- failed, no cap fired, and the correct response is not to wait for a provider
-- or for a spend window to roll over but to run the very same cycle again
-- immediately. An operator reading `budget_exhausted` over a cycle that was
-- simply long would go looking for a spend cap that was never involved.
--
-- The drop-and-re-add under the same name in the same rung is the documented way
-- to widen a CHECK: the constraint is absent for the length of one transaction
-- and comes back strictly more permissive, so the previous fleet version — which
-- writes only the four older values — is never refused.
--
-- ---------------------------------------------------------------------------
-- **And `abandoned`, which is what stops the resume from being a trap.**
--
-- The free work banked against a run is honoured only while that run is being
-- *continued* — attempts seconds apart over a brain nothing has ingested into.
-- Past one ceiling period the argument for skipping it ("nothing has changed
-- since") is no longer one anybody can make, so the checkpoints stop counting.
--
-- Written that way alone, the horizon absorbs: `started_at` never moves, nothing
-- but a completed cycle sets `finished_at`, and there is no sweep. A run that
-- crossed it therefore never left it — no deterministic checkpoint honoured
-- again, ever, the whole tier restarting from zero on every attempt for as long
-- as the run stayed open, which on a brain whose free tier outlives one attempt
-- is precisely the non-terminating loop this rung was cut to end.
--
-- Crossing the horizon now *closes* the run. The next cycle opens a fresh one,
-- which gets a fresh `started_at` and legitimately re-runs the free work — which
-- is what the horizon wanted — instead of an un-closeable run that re-runs it
-- for ever. `abandoned` is the label on the closed row: it did not complete, it
-- did not fail, and nobody spent anything discovering that. Its spend and its
-- counters are left exactly as the last attempt recorded them, because the
-- tenant's bill is not a thing a sweep gets to rewrite.
-- ===========================================================================

ALTER TABLE consolidation_checkpoint
  ADD COLUMN completed boolean NOT NULL DEFAULT true;

ALTER TABLE consolidation_checkpoint
  ADD COLUMN phase_cursor text;

COMMENT ON COLUMN consolidation_checkpoint.completed IS 'false while a phase is banked mid-flight — the row records a position, not a completion. Only ever false for a deterministic phase.';

COMMENT ON COLUMN consolidation_checkpoint.phase_cursor IS 'where inside the phase the last attempt stopped. Opaque here; its shape is the owning phase''s business.';

ALTER TABLE consolidation_checkpoint
  ADD CONSTRAINT consolidation_checkpoint_incomplete_rows_carry_a_position CHECK (
    completed OR phase_cursor IS NOT NULL
  );

ALTER TABLE consolidation_run
  DROP CONSTRAINT consolidation_run_stop_reason_is_known,
  ADD CONSTRAINT consolidation_run_stop_reason_is_known CHECK (
    stop_reason IS NULL
    OR stop_reason IN ('complete', 'free_tier', 'budget_exhausted', 'phase_failed', 'cancelled',
                       'out_of_time', 'abandoned')
  );
