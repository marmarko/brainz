-- ===========================================================================
-- brainz tenant schema — rung 7, the settings a panel action changes
--
-- U14 gives `manage` four actions. Two of them need somewhere in the tenant's
-- own database to land: a context policy the user chose, and the set of
-- connector sources they have paused. (The third store, the rolling spend cap,
-- already exists on the control-plane row; the fourth action is its inverse.)
--
-- Both are added here rather than invented at the handler, because a settings
-- write with no column behind it is the shape that makes `applied: true` a lie
-- — and `manage` is the one tool on this surface that changes anything.
--
-- ---------------------------------------------------------------------------
-- **`tenant_setting.context_policy` — nullable, no default, no backfill.**
--
-- NULL means "the user has never chosen", and that is a different fact from
-- every named policy including the permissive one. Writing `'unrestricted'`
-- into every existing row would look like a decision the user made, on a column
-- whose whole purpose is to record a decision the user made — and a later
-- reader (U15's dashboard, a support answer, an export) has no way to tell an
-- observed choice from a migration's guess.
--
-- That is rung 5's `occurred_at` rule and rung 6's `external_ref` rule applied a
-- third time, and it is the same sentence each time: never write an unobserved
-- value into a column a later reader takes as an assertion. A null is legible;
-- a fabricated default is not.
--
-- **It heals from an observation and from nothing else** — the user choosing,
-- through the panel (U14) or the web app (U15). There is no poll that can fill
-- it in, which is the honest difference from rung 6: `external_ref` had a
-- provider that would re-offer the object, and a preference has no such source.
-- Until then the platform default applies and the reader can see that it is a
-- default.
--
-- **What it does NOT do, stated so nobody has to infer it.** This column is a
-- record, not a fence. Nothing in the read path consults it in this rung, and
-- `manage`'s response says so in as many words. Access fencing evaluates
-- `origin_context` only (R15/KTD5), and a tenant-set narrowing wired into
-- dispatch's fence derivation would be a change to the mechanism the entire
-- isolation claim rests on — reachable, in the configuration that actually
-- ships, from nowhere at all, because the panel branch does not render on the
-- target client today (see docs/plans/2026-08-13-002-u14-panel-manage-replan.md
-- §1.2). An unreachable modification of the fence is how a fence acquires a bug
-- nobody can see. U15 owns wiring it, with the read path in front of it.
--
-- The CHECK is a closed set on purpose. The alternative — accept any scope name
-- — means a typo silently narrows a brain to nothing, and the failure is a user
-- reporting that their memory is gone.
--
-- ---------------------------------------------------------------------------
-- **`source_pause` — a row exists only while a source is paused.**
--
-- No `paused`/`resumed` boolean and no `resumed_at`: absence is the unambiguous
-- "not paused", which is what lets a previous fleet release that has never
-- heard of this table keep behaving exactly as it does today. A boolean column
-- would need a backfill; a table that starts empty needs none, and "empty means
-- nothing is paused" is true on the first day and every day after.
--
-- **`paused_by` records which surface authorised it, not who.** The same call
-- `review_queue.closed_by` makes one table over, for the same R12a reason: the
-- authorising channel *is* the fact. A panel click and a confirmation the
-- connected agent prompted for are different events, and collapsing them into
-- "the user" is precisely how R12a's distinction gets lost. The set here is
-- deliberately disjoint from `review_queue`'s: nothing in it says
-- `user_out_of_band`, because none of these channels is.
--
-- `source` is CHECK-constrained to the three alpha connectors rather than
-- foreign-keyed, because there is no source table to point at — connector state
-- lives in object storage (`src/ingest/cursor.ts`). The constraint is what stops
-- a pause row naming something no poller will ever read.
--
-- ---------------------------------------------------------------------------
-- **Expand-only, like every rung.** One nullable column with no default, one
-- new table. No DROP, no RENAME, no ALTER COLUMN, no NOT NULL on an existing
-- table. A fleet instance running the previous release keeps inserting
-- `tenant_setting` with its own column list and never learns either exists.
--
-- The `{{FTS_LANGUAGE}}` placeholder is not used here: nothing this rung adds is
-- full-text indexed.
-- ===========================================================================


-- The user's chosen default reading posture. NULL means they never chose.
ALTER TABLE tenant_setting ADD COLUMN context_policy text;

ALTER TABLE tenant_setting
  ADD CONSTRAINT tenant_setting_context_policy_is_known
  CHECK (context_policy IS NULL OR context_policy IN ('unrestricted', 'personal_only', 'work_only'));

COMMENT ON COLUMN tenant_setting.context_policy IS 'the reading posture the user chose, or NULL when they never have — including every row written before rung 7, which is deliberately not backfilled because a fabricated choice is indistinguishable from a real one. A record, not a fence: nothing in the read path consults it in this rung, and access fencing evaluates origin_context only (R15/KTD5).';


-- ---------------------------------------------------------------------------
-- Which connector sources are paused, and by which surface.
-- ---------------------------------------------------------------------------

CREATE TABLE source_pause (
  -- One of `src/ingest/cursor.ts:CONNECTOR_SOURCES`. Same three strings as
  -- U10's `ingest_pull` job targets, for the same reason that list gives: a
  -- source whose name is not a legal job target cannot be scheduled either.
  source     text        NOT NULL,

  paused_at  timestamptz NOT NULL DEFAULT now(),

  -- Which surface authorised the pause. NOT who: the channel is the fact.
  --   `panel`           — an MCP Apps panel action holding a short-TTL nonce.
  --   `agent_confirmed` — the connected agent asked, the client elicited, the
  --                       user said yes. Deliberately NOT `user_out_of_band`.
  --   `app`             — the web app (U15).
  paused_by  text        NOT NULL,

  CONSTRAINT source_pause_pkey PRIMARY KEY (source),
  CONSTRAINT source_pause_source_is_a_connector CHECK (source IN ('gmail', 'calendar', 'drive')),
  CONSTRAINT source_pause_authority_is_known CHECK (paused_by IN ('panel', 'agent_confirmed', 'app'))
);

COMMENT ON TABLE source_pause IS 'operational — one row per paused connector source; absence means running. Carries no origin and no inference: it names a source and the surface that paused it, never content.';
