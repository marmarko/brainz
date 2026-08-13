-- ===========================================================================
-- brainz tenant schema — rung 4, the briefing's own bookkeeping (U12)
--
-- One table, and it holds no user content at all: a grant-derived key, two
-- timestamps and a number.
--
-- ---------------------------------------------------------------------------
-- **Why a rung rather than reusing something.** Three existing homes were
-- considered and each is wrong for a specific reason:
--
--   * `control.tenant.pending_debt` is in the control plane, which a tool
--     handler cannot reach by construction (`mcp/dispatch.ts` hands a handler
--     the tenant's connection and nothing else) — and it is per *tenant*, while
--     a read cursor is per *caller*. Two clients pulling one brain's briefing
--     each need their own idea of "since I last looked"; a shared cursor means
--     the first one to run every morning eats the second one's delta.
--   * `consolidation_checkpoint` is keyed on a phase and belongs to the run in
--     progress. A briefing cursor outlives every run.
--   * `tenant_setting` is the provision-time registry: one row, decided once.
--     A cursor is written on every read.
--
-- So: a new table, and the smallest one that answers both questions.
--
-- ---------------------------------------------------------------------------
-- **The caller key is credential-derived and content-free.** It is the grant id
-- `mcp/dispatch.ts` already computes — a hash prefix for a provisioned bearer,
-- the signed grant id for an OAuth token. It is not a user identifier, it
-- carries no address and no name, and it is exactly as stable as the credential
-- it belongs to: revoke the grant and the cursor stops being reachable, which is
-- the correct lifetime for "how far has this connection read".
--
-- **Why the nag state lives here too.** The free→paid prompt is bounded per
-- *caller* for the same reason the cursor is: `briefing` runs every morning
-- through one scheduled task, and that task is one caller. Binding the bound to
-- the tenant instead would mean a second client's first-ever briefing could be
-- silent because the scheduled task used up the tenant's one prompt.
--
-- **This table is written on a read**, which is the one thing worth flagging
-- about a tool annotated `readOnlyHint: true`. The annotation is about the
-- user's knowledge, and the guard that keeps it honest is behavioural rather
-- than declared: `test/briefing/assemble.test.ts` censuses every content table
-- around a briefing call and fails on any change.
--
-- ---------------------------------------------------------------------------
-- **Expand-only, like every rung.** No DROP, no RENAME, no ALTER COLUMN, no
-- `ADD COLUMN … NOT NULL` without a DEFAULT. This rung only creates, so the
-- previous fleet version keeps serving a migrated tenant untouched — it does
-- not know this table exists and nothing it writes depends on it.
--
-- The table declares its class in `COMMENT ON TABLE`, in the vocabulary
-- `test/schema/tenant-schema.test.ts` enumerates. It carries no origin column,
-- so it takes no origin-immutability trigger: it asserts nothing about anybody's
-- content, and a fence over a bookmark would be a second copy of a fence that
-- already holds on every row the bookmark points at.
--
-- The `{{FTS_LANGUAGE}}` placeholder is not used here: nothing this rung adds is
-- full-text indexed.
-- ===========================================================================


CREATE TABLE briefing_cursor (
  -- The grant id, as `mcp/dispatch.ts` derives it from the credential. Never a
  -- request parameter: a caller that could name its own cursor could read
  -- another connection's delta, and could reset the prompt bound at will.
  caller_key            text        NOT NULL,

  -- How far this caller has read. NULL until the first briefing completes,
  -- which is what makes "first read" a state rather than an inference from an
  -- empty delta — an empty delta is also what a caught-up caller sees.
  last_read_at          timestamptz,

  -- The free→paid prompt's bound (R8). `prompt_last_debt` is the *band* it was
  -- last shown at rather than the raw counter, so debt accruing inside one band
  -- is silence; `src/core/briefing/prompt.ts:bandOf` owns the ladder.
  prompt_last_shown_at  timestamptz,
  prompt_last_debt      integer     NOT NULL DEFAULT 0,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT briefing_cursor_pkey PRIMARY KEY (caller_key),
  CONSTRAINT briefing_cursor_key_is_not_empty CHECK (length(btrim(caller_key)) > 0),
  CONSTRAINT briefing_cursor_prompt_band_is_non_negative CHECK (prompt_last_debt >= 0),
  -- A shown prompt has a time and a band, or there was no prompt. Two fields
  -- that can disagree about whether a caller has been prompted make the bound
  -- a coin toss.
  CONSTRAINT briefing_cursor_prompt_is_whole CHECK (
    (prompt_last_shown_at IS NULL AND prompt_last_debt = 0)
    OR (prompt_last_shown_at IS NOT NULL AND prompt_last_debt > 0)
  )
);

COMMENT ON TABLE briefing_cursor IS 'operational — one row per credential that has pulled a briefing: how far it has read and when it was last prompted to upgrade. Content-free by shape: a grant-derived key, timestamps and a band number, with nowhere to put a user''s words.';
