-- ===========================================================================
-- brainz tenant schema — rung 6, the handle a deleted file is deleted by
--
-- One nullable column and one index. It exists because a file the user deleted
-- upstream stayed searchable through the text this brain read off it.
--
-- ---------------------------------------------------------------------------
-- **What was wrong.** `tombstoneRefs` sweeps by `page.external_ref`, and a
-- connector's deletion feed names a *provider object* — a Drive file id, a mail
-- attachment id. An attachment is not a page and had no `external_ref` at all,
-- so nothing a connector could say reached it. Neither half of the object was
-- reachable:
--
--   * the `attachment` row, which is what says the object exists and what the
--     transcribe queue reads; and
--   * the transcript page the OCR phase writes from it, keyed
--     `attachment:{id}` — a different ref, on a table the sweep does search,
--     under a name no provider will ever mention.
--
-- The visible consequence is the second one. A user deletes a document in
-- Drive; its text keeps answering `recall`, keeps landing in briefings, and
-- keeps being evidence a consolidation cycle reasons from. There was no command
-- and no cadence that would ever remove it.
--
-- ---------------------------------------------------------------------------
-- **What happens to rows written before this rung.** They stay NULL, and NULL
-- means "this brain does not know which provider object this is". It is not
-- backfilled, for the reason rung 5 gives about `occurred_at`: the only value
-- available to a backfill would be a guess, and a guess written into a column
-- later readers treat as an assertion is worse than a null, because a null is
-- legible. There is no way to recover the id from `object_key` either — the
-- accessor *hashes* the provider's id on the way in (R9), and a hash does not
-- run backwards.
--
-- **They heal from an observation instead.** `acceptMedia` fills the column
-- whenever it sees the object again — on the first accept, on a replacement,
-- and on the `unchanged` path where nothing else is written. A poller re-offers
-- what it holds on its ordinary cadence, so a pre-rung attachment acquires its
-- ref the next time the provider mentions it, and the value written is one the
-- caller has just observed rather than one this migration invented. The row is
-- only guarded, never overwritten: `WHERE external_ref IS NULL`, so an observed
-- value is never replaced by a later, different claim.
--
-- The gap that leaves, stated rather than hidden: an attachment written before
-- this rung whose upstream object is deleted *before* any later poll still
-- carries no ref, and stays unreachable by the sweep. Its transcript is
-- reachable the moment the attachment is, and not before. The alternative — a
-- fabricated backfill — would make every row look reachable and silently sweep
-- the wrong ones.
--
-- ---------------------------------------------------------------------------
-- **The index is the sweep's, and it is partial on the same predicate.** The
-- sweep asks one question: given this origin and these refs, which live
-- attachments are they. `origin_context` leads because R15's fence is evaluated
-- first and a deletion that ranged across origins would be a connector
-- retiring another source's rows.
--
-- ---------------------------------------------------------------------------
-- **`external_ref` is provider-asserted, exactly like `occurred_at`.** It
-- orders nothing and it decides nothing about access: the fence is
-- `origin_context`, which is credential-derived and immutable by trigger. A
-- sender who could choose an id can, at most, name an object inside the origin
-- their own credential already writes.
--
-- ---------------------------------------------------------------------------
-- **Expand-only, like every rung.** The column is nullable with no default, so
-- the previous fleet version keeps inserting attachments with its own column
-- list and never learns this exists. No DROP, no RENAME, no ALTER COLUMN. The
-- index is non-unique — deliberately: a replaced object keeps its row, and a
-- unique index would be a promise a live previous release could violate by
-- writing a second row for one provider id.
--
-- The `{{FTS_LANGUAGE}}` placeholder is not used here: nothing this rung adds is
-- full-text indexed.
-- ===========================================================================


-- The provider's own id for this object, as the connector named it. NULL means
-- nobody has said — every row written before this rung, until a poll re-offers
-- the object and `acceptMedia` fills it in.
ALTER TABLE attachment ADD COLUMN external_ref text;

COMMENT ON COLUMN attachment.external_ref IS 'the provider''s own id for this object (Drive file id, mail attachment id), as the connector named it. NULL means the brain does not know which provider object this is, including every row written before rung 6; acceptMedia fills it from an observation and never overwrites one. Content, not provenance: it is how a deletion feed reaches this row, and it decides nothing about access — the fence reads origin_context only.';

-- The deletion sweep's lookup: origin first, because the fence is evaluated
-- before the ref. Partial on the same predicate as the sweep, since a row that
-- is already retired is never swept again.
CREATE INDEX attachment_live_by_external_ref
  ON attachment (origin_context, external_ref)
  WHERE deleted_at IS NULL AND external_ref IS NOT NULL;
