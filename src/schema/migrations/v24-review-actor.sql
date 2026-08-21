-- ---------------------------------------------------------------------------
-- brainz tenant schema — rung 24, who closed a contradiction report
--
-- `contradiction_report` gains the column `review_queue` has carried since rung
-- three, and the reason is R12a rather than symmetry.
--
-- `review_queue.closed_by` puts R12a in a CHECK: an out-of-band action or an
-- internally-derived one, never the agent (`v3-consolidation.sql`). One table
-- over, the same question is unanswerable — a resolution written by the owner's
-- own session and one written by some future automated pass are byte-identical
-- rows. That was harmless while nothing could write a non-open row. It stops
-- being harmless the moment a second writer exists, and `/dashboard?view=review`
-- is that second writer.
--
-- What the screen does is write a VERDICT and touch neither fact, which is what
-- keeps R12's "contradiction handling is report-only" true. This column is what
-- lets the next reader **verify** that rather than take it on trust: a report
-- closed by a session says so, and a report closed by anything else says that
-- instead.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE, AND WHY THE OMISSION IS THE CAREFUL CHOICE
-- ---------------------------------------------------------------------------
--
-- The obvious companion — `CHECK (status = 'open' OR resolved_by IS NOT NULL)`,
-- the mirror of `review_queue_closed_entries_say_who` — is **not** shipped.
--
-- Nothing in `src/` has ever been able to write a non-open row, so any that
-- exist were written by hand. `ADD CONSTRAINT` validates against every existing
-- row, so that constraint would fail its scan on the first tenant holding one —
-- and a rung that fails on one tenant stops the ladder for the whole fleet.
-- Trading a fleet-wide migration stall for a check on a state no code can
-- produce is the wrong side of that bargain.
--
-- It is an obvious later rung once the existing rows are stamped, and it is
-- named here rather than left for somebody to notice as missing.
-- ---------------------------------------------------------------------------

ALTER TABLE contradiction_report ADD COLUMN resolved_by text;

ALTER TABLE contradiction_report
  ADD CONSTRAINT contradiction_resolved_by_is_out_of_band
  CHECK (resolved_by IS NULL OR resolved_by IN ('user_out_of_band', 'internal'));

COMMENT ON COLUMN contradiction_report.resolved_by IS
  'operational — R12a: who closed this report. The same closed vocabulary review_queue.closed_by carries, and for the same reason: the assistant holding `remember` is the assistant reading the attacker''s mail, so `agent_mcp` is not a value here.';
