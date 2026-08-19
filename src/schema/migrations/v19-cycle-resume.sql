-- ===========================================================================
-- brainz tenant schema — rung 19, a cycle that stops on its own clock
--
-- One widened CHECK, and it exists because of a measured incident: a whole-brain
-- consolidation cycle on a 5,608-page brain burned five attempts of a
-- fifteen-minute wall-clock ceiling and completed none of them. Every attempt
-- was reaped rather than returning, so the lane dead-lettered having produced no
-- cycle in 2h46m — and a dead-lettered lane counts as one already standing, so
-- nothing polled that tenant again until an operator cleared it by hand.
--
-- ---------------------------------------------------------------------------
-- **Why `stop_reason` gains a member rather than reusing one.**
--
-- The cause was round trips: salience issued `1 + 2N` sequential statements
-- (11,217 on that brain, fifteen minutes on its own at 36ms) and clustering paid
-- a whole transaction per seed. Both are batched now, and the phases are cheap
-- enough to redo. What the cycle still needs is the ability to *stop* — to read
-- the deadline the lease already stamps, finish the unit of work in flight, and
-- write its own run record — rather than to discover the ceiling by being killed
-- at it. That stop needs a name.
--
-- `budget_exhausted` and `phase_failed` both mean "something went wrong and the
-- run stays open". Running out of the attempt's wall clock is neither: nothing
-- failed, no cap fired, and an operator reading `budget_exhausted` over a cycle
-- that was simply long would go looking for a spend cap that was never involved.
-- The run stays open exactly as it does for those two, and the next cycle
-- resumes into it without re-paying for the model phases that finished.
--
-- The drop-and-re-add under the same name in the same rung is the documented way
-- to widen a CHECK: the constraint is absent for the length of one transaction
-- and comes back strictly more permissive, so the previous fleet version — which
-- writes only the five older values — is never refused.
--
-- ---------------------------------------------------------------------------
-- **What this rung deliberately does not add.**
--
-- An earlier draft carried a resumable position for the deterministic tier — a
-- `completed` flag, a `phase_cursor`, a per-phase timing table and two more stop
-- reasons — so that an interrupted free tier could pick up where it left off.
-- It is not here, and the reason is that the wall it was built to survive was
-- removed by the batching above rather than by any of it. Redoing a free tier
-- that costs seconds is cheaper than a resume protocol, and every draft of that
-- protocol shipped with a state a run could enter and not leave: the same class
-- of defect as the dead lane it existed to prevent. The checkpoint's subject
-- stays what rung 3 made it — money, for the model tier alone.
-- ===========================================================================

ALTER TABLE consolidation_run
  DROP CONSTRAINT consolidation_run_stop_reason_is_known,
  ADD CONSTRAINT consolidation_run_stop_reason_is_known CHECK (
    stop_reason IS NULL
    OR stop_reason IN ('complete', 'free_tier', 'budget_exhausted', 'phase_failed', 'cancelled',
                       'out_of_time')
  );
