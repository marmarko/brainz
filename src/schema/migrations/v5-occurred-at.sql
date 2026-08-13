-- ===========================================================================
-- brainz tenant schema — rung 5, when the thing actually happened
--
-- One nullable column and one index. It exists because the briefing's flagship
-- lane could not tell the difference between a meeting and the moment a poller
-- noticed one.
--
-- ---------------------------------------------------------------------------
-- **What was wrong.** Every ingest path already computes an event time —
-- `ImportItem.occurredAt`, and Calendar's is the event *start* — and no path
-- persisted it. `page.created_at` is when the row was written, so "today's
-- meetings" was really "meetings that arrived today": a call at 10:00 today
-- that synced last night was absent from this morning's briefing, and a March
-- meeting re-fetched this morning led it. On the flagship read that is wrong on
-- day one, and it is wrong in the direction the user notices.
--
-- **What happens to rows written before this rung.** They stay NULL, and every
-- read that keys on occurrence spells it `coalesce(occurred_at, created_at)`.
-- So an existing page keeps *exactly* the behaviour it has today — arrival
-- time — and nothing that appears in a briefing this morning disappears from
-- tomorrow's. There is deliberately **no** `UPDATE page SET occurred_at =
-- created_at`: that would write a value nobody observed into a column whose
-- whole meaning is "the provider said so", and a later reader could never tell
-- a real assertion from a backfilled guess. A backfill that fabricates
-- provenance is worse than a null, because a null is legible.
--
-- The same fallback covers the sources that have no event time at all — a
-- folder file, a `remember`, an OCR transcript. They are not meetings and the
-- lane is calendar-scoped, but the coalesce means their absence costs nothing
-- and reads no differently than it does now.
--
-- ---------------------------------------------------------------------------
-- **The index is the point of the rung, not a nicety.** U12 built the meetings
-- lane as a bounded *range scan* — the header of `core/briefing/assemble.ts`
-- names the window as one of the three things that bound the whole read — and a
-- lane re-keyed onto an unindexed expression is a sequential scan over every
-- page the tenant owns, on the read that runs every morning. So the index is
-- declared on the identical expression the lane sorts and filters by; spell it
-- any other way in a query and the index is decoration.
--
-- It is partial on the same two predicates as `page_live_by_origin` (rung 2),
-- because a deleted or quarantined page is excluded from every read that could
-- use this index and there is no reason to carry it.
--
-- ---------------------------------------------------------------------------
-- **`occurred_at` is provider-asserted content and must never carry a security
-- decision.** It is a `Date:` header, a Drive `modifiedTime`, a calendar
-- `start.dateTime` — an outside sender chooses it, exactly as they choose a
-- subject line. It orders and it windows, and that is all it may ever do:
--
--   * it is NOT part of the origin fence — `origin_context` is, it is
--     credential-derived, and rung 2's trigger refuses to let it move;
--   * it does not decide visibility, quarantine, or corroboration;
--   * it is not compared against anything that grants access.
--
-- The concrete hazard it is *not* allowed to become: a sender who backdates or
-- postdates a message must be able to move it around inside a listing and
-- nothing else. Every lane that reads it is already bounded on both sides by a
-- caller-supplied window, so a spoofed year 2099 falls outside the window
-- rather than pinning itself to the top of every briefing forever.
--
-- ---------------------------------------------------------------------------
-- **Expand-only, like every rung.** The column is nullable with no default, so
-- the previous fleet version keeps inserting pages with its own column list and
-- never learns this exists. No DROP, no RENAME, no ALTER COLUMN. The index is
-- non-unique, so it makes no promise a live previous release can violate.
--
-- The `{{FTS_LANGUAGE}}` placeholder is not used here: nothing this rung adds is
-- full-text indexed.
-- ===========================================================================


-- When the thing happened, as the provider asserted it. NULL means "nobody
-- said" — which is every row written before this rung, and every source that
-- carries no event time.
ALTER TABLE page ADD COLUMN occurred_at timestamptz;

COMMENT ON COLUMN page.occurred_at IS 'provider-asserted event time (mail Date, calendar start, Drive modifiedTime). NULL means the source did not say, including every row written before rung 5; readers spell the fallback coalesce(occurred_at, created_at). Content, not provenance: it orders and windows, and it decides nothing about access — the fence reads origin_context only.';

-- The meetings lane's range scan. The expression is the one the lane must use
-- verbatim; a query that spells the fallback differently gets a sequential scan
-- over every page in the brain.
CREATE INDEX page_live_by_occurrence
  ON page (origin_context, (coalesce(occurred_at, created_at)) DESC)
  WHERE deleted_at IS NULL AND quarantined_at IS NULL;
