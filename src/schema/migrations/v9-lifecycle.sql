-- ===========================================================================
-- brainz tenant schema — rung 9, the durability contract's own state (U17)
--
-- Four tables. Each one exists because a promise U17 makes has nowhere to land
-- otherwise, and each one is stated below with the promise it is behind.
--
-- ---------------------------------------------------------------------------
-- **`page_version` — because version history cannot ride on tombstones.**
--
-- U4 replaces a changed document by tombstoning the previous page and writing a
-- new one, so a predecessor does exist. For 72 hours. `purgeExpiredTombstones`
-- (`src/mcp/tombstone.ts`) then hard-deletes it, which makes "we keep your
-- versions" a claim with a three-day memory — not a durability contract, and
-- worse than saying nothing because the user would have kept their own copy.
--
-- So versions are an explicit snapshot rather than an inference over deleted
-- rows, and three consequences follow from that sentence:
--
--   1. **Keyed on `doc_key`, not on `page_id`.** A replaced document is a NEW
--      page row, so a history keyed on the page id fragments at exactly the
--      moment there is something to remember. `doc_key` is the document's stable
--      identity — its `external_ref` where it has one, `page:<id>` where it does
--      not (a `remember` note names nothing upstream).
--   2. **`page_id` is nullable and its foreign key is ON DELETE SET NULL.**
--      The purge that removes the tombstoned predecessor must not take the
--      snapshot with it. A CASCADE here would rebuild the 72-hour memory this
--      table exists to escape, one indirection further away where nobody would
--      look for it.
--   3. **The body is stored, and the digest it was captured at is stored beside
--      it.** `page` has no body column — the only copy of a document's text in
--      this database is `chunk.content`, which carries U4's 200-character
--      reach-back overlap and is therefore not the user's file. A snapshot is
--      reconstructed and then *verified* against `page.content_sha256` before it
--      is written (`src/core/export/reconstruct.ts`), and the digest recorded
--      here is the one it verified against. A snapshot nobody could verify is
--      not written; there is no `verified` flag to be false, because a version a
--      revert cannot trust is not a version.
--
-- R15 applies to it exactly as it applies to `page`: this table holds the user's
-- document text, it arrived through one credential, so it carries a NOT NULL
-- scalar `origin_context` and the shared immutability trigger. A snapshot table
-- outside the fence would be a second, unfenced copy of every page in the brain.
--
-- ---------------------------------------------------------------------------
-- **`self_export` — the scheduled export's own record, one row.**
--
-- Singleton by primary key rather than by convention, because "the last export"
-- is a fact about the brain and two rows claiming it would make the nag below a
-- coin toss. Every column that records an *observation* is nullable with no
-- default and no backfill: a brain that has never exported has `NULL`, which is
-- a different fact from "exported at the epoch". That is rung 5's, 6's and 7's
-- rule applied a fourth time — never write an unobserved value into a column a
-- later reader takes as an assertion.
--
-- ---------------------------------------------------------------------------
-- **`self_export_nag` — bounded per caller, for U12's reason, not per tenant.**
--
-- The self-export reminder rides the same daily read the free→paid prompt does,
-- and an unconditional reminder on a daily path is a daily sales pitch. The
-- bound is therefore the one `src/core/briefing/prompt.ts` already established:
-- once per band crossing, or once per interval, with a stated dismissal.
--
-- Per *caller*, keyed on the same grant-derived `caller_key` `briefing_cursor`
-- uses, and for the same reason U12 gives: binding it to the tenant would mean a
-- second client's first-ever briefing is silent because the scheduled task used
-- up the tenant's one reminder. The key is credential-derived and content-free.
--
-- ---------------------------------------------------------------------------
-- **`erased_subject` — R12's subject-scoped erasure, tombstoned against
-- re-ingestion.**
--
-- The property U15's determination (§6.3) flags as most likely to be missed:
-- the next connector poll will happily re-ingest the same correspondent's
-- messages from the same mailbox, and a receipt handed to a third party becomes
-- false within the hour. So erasure writes a row here and the pull path is
-- expected to consult it before writing a page.
--
-- **It stores a digest, never the identifier.** Keeping `alice@example.com` in
-- a table whose entire purpose is that we no longer hold anything about her is
-- the failure wearing the fix's clothes. The pull path hashes the sender it is
-- about to write and looks the digest up; a stored plaintext address would be
-- the one piece of a correspondent's data that erasure created rather than
-- removed. `subject_digest` is sha256 over the identifier normalised through the
-- same normalizer the write path used, so the comparison is the one the brain
-- would have made.
--
-- **No origin column, and that is a decision.** A data-subject erasure request
-- is not scoped to one of the user's credentials — a correspondent asking to be
-- forgotten is not asking to be forgotten from the work mailbox only. Erasure
-- spans every origin in the brain, so there is no per-origin row to fence, and
-- a nullable origin here would invite a partial erasure that reports as whole.
--
-- ---------------------------------------------------------------------------
-- **Expand-only, like every rung.** Four CREATE TABLEs and their indexes. No
-- DROP, no RENAME, no ALTER COLUMN, no NOT NULL added to an existing table. A
-- fleet instance running the previous release never learns any of them exists;
-- the unique indexes are on tables this rung creates, so no live writer can be
-- failing on a duplicate it wrote before the constraint existed.
--
-- The `{{FTS_LANGUAGE}}` placeholder is not used here: nothing this rung adds is
-- full-text indexed. A version snapshot is deliberately not searchable — it is
-- the copy a revert reads, not a document `recall` should be ranking against a
-- live page that supersedes it.
-- ===========================================================================


CREATE TABLE page_version (
  version_id         bigint      GENERATED ALWAYS AS IDENTITY,

  -- The document's stable identity across replacement: `external_ref` when the
  -- page has one, `page:<id>` when it does not.
  doc_key            text        NOT NULL,
  -- Contiguous from 1 per doc_key, oldest first.
  version            integer     NOT NULL,

  -- The page this was captured from, while that page still exists. SET NULL on
  -- delete: the 72h purge of a tombstoned predecessor must not take the history
  -- with it.
  page_id            bigint,

  -- R15: the credential this text arrived through. Immutable, fenced, and the
  -- same shape `page` carries — a snapshot outside the fence would be a second
  -- unfenced copy of every document in the brain.
  origin_context     text        NOT NULL,
  subject_context    text,
  subject_confidence real,

  source_type        text        NOT NULL,
  title              text,
  -- What a revert re-ingests. Reconstructed from the chunks and verified
  -- against the page's own digest before it was written.
  body               text        NOT NULL,
  -- `contentDigest(title, body)` as U4 computes it. The snapshot verified
  -- against this; a reconstruction that did not verify is never written here.
  content_sha256     text        NOT NULL,

  -- Which sweep banked it, so an operator reading history can tell a snapshot
  -- taken of a live page from one rescued off a predecessor before the purge.
  captured_from      text        NOT NULL,
  captured_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT page_version_pkey PRIMARY KEY (version_id),
  CONSTRAINT page_version_page_fkey FOREIGN KEY (page_id) REFERENCES page (page_id) ON DELETE SET NULL,
  CONSTRAINT page_version_key_is_not_empty CHECK (length(btrim(doc_key)) > 0),
  CONSTRAINT page_version_number_is_positive CHECK (version >= 1),
  CONSTRAINT page_version_digest_is_a_digest CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT page_version_source_type_is_known CHECK (
    source_type IN ('email', 'chat', 'document', 'web', 'note', 'calendar', 'transcript', 'file')
  ),
  CONSTRAINT page_version_capture_is_known CHECK (
    captured_from IN ('live', 'superseded', 'pre_revert')
  ),
  CONSTRAINT page_version_subject_is_scored CHECK (
    subject_context IS NULL
    OR (subject_confidence IS NOT NULL AND subject_confidence >= 0 AND subject_confidence <= 1)
  )
);

COMMENT ON TABLE page_version IS 'content:ingested — one snapshot of one document as it stood, keyed on the document rather than on the page row so a replacement does not fragment its history; the body is verified against the page digest before it is written.';

-- Two versions claiming the same number for one document make "revert to
-- version 2" ambiguous. Free here: this rung creates the table.
CREATE UNIQUE INDEX page_version_is_numbered_per_doc ON page_version (doc_key, version);
CREATE INDEX page_version_by_doc ON page_version (doc_key, version DESC);
CREATE INDEX page_version_by_page ON page_version (page_id) WHERE page_id IS NOT NULL;

CREATE TRIGGER page_version_origin_is_immutable
  BEFORE UPDATE OF origin_context ON page_version
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_context');


-- ---------------------------------------------------------------------------
-- The scheduled self-export's record. One row, or none before the first run.
-- ---------------------------------------------------------------------------

CREATE TABLE self_export (
  -- Singleton by primary key. Two rows claiming "the last export" would make
  -- the staleness the nag reads a coin toss.
  singleton          boolean     NOT NULL DEFAULT true,

  -- Where the user chose to send it. NULL means they never chose, which is a
  -- different fact from every named destination and is exactly what the nag is
  -- about. No backfill, no default.
  destination_kind   text,

  -- The last run that actually delivered. NULL until one has.
  last_export_at     timestamptz,
  last_export_pages  integer,
  -- The digest of the exported tree's manifest, so two exports of an unchanged
  -- brain are visibly the same export.
  last_export_digest text,

  -- The last run that was attempted, whatever it did. Separate from the line
  -- above because "we tried and failed for six weeks" and "we have not tried"
  -- are the two states a backup product must never confuse.
  last_attempt_at    timestamptz,
  last_failure       text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT self_export_pkey PRIMARY KEY (singleton),
  CONSTRAINT self_export_is_a_singleton CHECK (singleton),
  CONSTRAINT self_export_destination_is_known CHECK (
    destination_kind IS NULL OR destination_kind IN ('object_store', 'user_bucket', 'download')
  ),
  CONSTRAINT self_export_page_count_is_non_negative CHECK (
    last_export_pages IS NULL OR last_export_pages >= 0
  ),
  -- A delivered export has a time and a count, or there was no delivered
  -- export. Two fields that can disagree make "when was my last backup" a guess.
  CONSTRAINT self_export_delivery_is_whole CHECK (
    (last_export_at IS NULL AND last_export_pages IS NULL AND last_export_digest IS NULL)
    OR (last_export_at IS NOT NULL AND last_export_pages IS NOT NULL AND last_export_digest IS NOT NULL)
  )
);

COMMENT ON TABLE self_export IS 'operational — one row recording where the scheduled export sends and when it last delivered; carries no content and no inference, and distinguishes "never tried" from "tried and failed".';


-- ---------------------------------------------------------------------------
-- The reminder's bound, per caller. U12's shape, U12's reason.
-- ---------------------------------------------------------------------------

CREATE TABLE self_export_nag (
  -- The grant id `mcp/dispatch.ts` derives from the credential — the same key
  -- `briefing_cursor` uses. Never a request parameter: a caller that could name
  -- its own key could reset the bound at will.
  caller_key    text        NOT NULL,

  last_shown_at timestamptz,
  -- The staleness band it was last shown at, in days, rather than the raw age,
  -- so days accruing inside one band are silence. `src/core/export/schedule.ts`
  -- owns the ladder.
  last_band     integer     NOT NULL DEFAULT 0,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT self_export_nag_pkey PRIMARY KEY (caller_key),
  CONSTRAINT self_export_nag_key_is_not_empty CHECK (length(btrim(caller_key)) > 0),
  CONSTRAINT self_export_nag_band_is_non_negative CHECK (last_band >= 0),
  CONSTRAINT self_export_nag_is_whole CHECK (
    (last_shown_at IS NULL AND last_band = 0) OR (last_shown_at IS NOT NULL AND last_band > 0)
  )
);

COMMENT ON TABLE self_export_nag IS 'operational — one row per credential that has been reminded to set up a backup, and the staleness band it was reminded at. Content-free by shape: a grant-derived key, a timestamp and a band number.';


-- ---------------------------------------------------------------------------
-- R12's subject-scoped erasure tombstone. Digests, never identifiers.
-- ---------------------------------------------------------------------------

CREATE TABLE erased_subject (
  -- sha256 over the identifier normalised the way the write path normalises,
  -- so the pull path's comparison is the one the brain would have made. The
  -- identifier itself is never stored: keeping it would be the one piece of the
  -- correspondent's data that erasure created rather than removed.
  subject_digest text        NOT NULL,

  erased_at      timestamptz NOT NULL DEFAULT now(),

  -- Which surface instructed it. The R12a distinction `review_queue.closed_by`
  -- and `source_pause.paused_by` both make: the authorising channel is the
  -- fact, and `agent_mcp` is deliberately absent — the assistant that would
  -- issue this is the assistant reading the correspondent's mail.
  erased_by      text        NOT NULL,

  -- What the run actually removed, so a receipt can be re-read later. Counts
  -- only; nothing here names a row that no longer exists.
  pages_removed       integer NOT NULL DEFAULT 0,
  facts_removed       integer NOT NULL DEFAULT 0,
  entities_removed    integer NOT NULL DEFAULT 0,
  artifacts_recomputed integer NOT NULL DEFAULT 0,

  CONSTRAINT erased_subject_pkey PRIMARY KEY (subject_digest),
  CONSTRAINT erased_subject_digest_is_a_digest CHECK (subject_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT erased_subject_authority_is_known CHECK (erased_by IN ('app', 'panel', 'operator')),
  CONSTRAINT erased_subject_counts_are_non_negative CHECK (
    pages_removed >= 0 AND facts_removed >= 0 AND entities_removed >= 0 AND artifacts_recomputed >= 0
  )
);

COMMENT ON TABLE erased_subject IS 'operational — one row per correspondent erased from this brain, keyed on a digest so the tombstone holds no identifier; the pull path consults it so the next poll cannot undo the erasure on a cadence.';
