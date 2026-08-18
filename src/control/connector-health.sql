-- ===========================================================================
-- brainz control plane — the connector's last attempt
--
-- **The question this table exists to answer: "my mail is not arriving — why?"**
--
-- Before it, the fleet's answer was nothing, anywhere, without a container
-- shell. The run's own detail (`ingest_log` — what was written, what was lost,
-- and the code the run recorded for itself) lives in the TENANT's database. The
-- job row (`control.job`) lives here and carries `failure_code`, whose whole
-- vocabulary for a handler that threw is the single label `handler_error`. So a
-- vendor that revoked a grant, a spend cap that stopped the import, a tenant
-- database nobody could reach and a bug in our own code all arrived at the same
-- five-syllable shrug, and the one process that knew the difference wrote it to
-- container stdout, which `wrangler tail` does not capture.
--
-- ---------------------------------------------------------------------------
-- WHY THE DETAIL COMES HERE RATHER THAN A PORT INTO THE TENANT
-- ---------------------------------------------------------------------------
-- The other shape was available and is the one `src/web/connector-panel.ts`
-- named: a port like `SeverancePort`, supplied by a composition root that holds
-- the secret store, running `sourceStaleness` against the tenant's own database
-- and handing the web app a projection. Three reasons it is not what this is.
--
--   1. **A port cannot report a tenant it cannot open.** "The tenant database
--      was unreachable" is one of the four causes an operator has to be able to
--      tell apart, and it is precisely the case in which a read-through port
--      returns an error instead of an answer. The record has to be written by
--      the process that already holds the tenant handle, at the moment it either
--      got one or did not — which is the worker, mid-attempt.
--   2. **`/admin` keeps a structural property instead of a remembered one.**
--      `src/web/admin.ts` opens by stating that it never receives a tenant
--      database handle, and that this is a fact about its dependencies rather
--      than about a handler's discipline. Handing that surface a tenant-reading
--      port trades that for a type it is easy to widen later. This trades
--      nothing: `/admin` reads one more content-free control-plane table.
--   3. **It answers when the compute is asleep.** Tens of thousands of tenant
--      databases are suspended most of the time. An operator diagnosing a
--      connector at 3am should not wake a brain to find out why it is failing,
--      and a user's dashboard certainly should not.
--
-- What that costs, stated rather than glossed: the control plane learns two
-- per-source counters and two codes it did not hold before. The per-ITEM record
-- — which message, which provider id — stays in the tenant's `ingest_log`, and
-- nothing here can reach it. See the column notes.
--
-- ---------------------------------------------------------------------------
-- TWO VOCABULARIES, NEITHER OF THEM NEW
-- ---------------------------------------------------------------------------
-- A failed attempt has a cause at one of two layers, and this table records
-- whichever layer knew:
--
--   * `ingest_failure_code` is `ingest_log.failure_code`'s own vocabulary
--     (`src/ingest/log.ts:INGEST_FAILURE_CODES`) — the run reached the provider
--     and the provider, the budget or the parser said no.
--   * `job_failure_code` is `control.job.failure_code`'s
--     (`src/worker/jobs.ts:JOB_FAILURE_CODES`) — no run happened at all, so the
--     only thing that can be said is what the runner would say.
--
-- Both are restated here rather than invented, and `test/control/connector-
-- health.test.ts` parses this file and compares each enum's labels to the
-- TypeScript constant it mirrors. A third vocabulary would be the thing that
-- makes a failure code untranslatable between the log, the queue and the page.
--
-- Applied by `src/control/connector-health.ts:ensureConnectorHealthSchema` at
-- fleet start, under its own advisory lock — the pattern `secret-pg.ts` settled
-- and `connector-pg.ts` repeated, catch-and-re-ask included. A separate file
-- from `schema.sql` for the reason those are separate files: `schema.sql` was
-- applied to the live control plane by hand, and a second copy of DDL is drift.
-- It inherits the content-free guard by living in this directory
-- (`test/control/schema.test.ts` globs `src/**/*.sql`).
--
-- Every domain and type this file uses is declared IN this file, including the
-- ones that restate an alphabet `schema.sql` and `connector-store.sql` already
-- declare — the trade those two explain: the guard parses each file on its own,
-- and a column typed by a domain declared next door is a column it reports as
-- unclassified. A type cannot be declared twice, so each carries its own name.
-- ===========================================================================

-- The tenant this record belongs to. The alphabet `control.tenant_id`,
-- `control.connector_tenant_id` and `secrets.ts:TENANT_ID_PATTERN` all declare.
CREATE DOMAIN control.connector_health_tenant_id AS varchar(63)
  CONSTRAINT connector_health_tenant_id_is_a_slug
  CHECK (VALUE ~ '^[a-z0-9][a-z0-9-]{0,62}$');

-- The same three labels as `control.connector_source`, `control.job_target`'s
-- connector members and `cursor.ts:CONNECTOR_SOURCES`. A fourth added there and
-- not here is a connector whose attempts this table would refuse to record.
CREATE TYPE control.connector_health_source AS ENUM ('gmail', 'calendar', 'drive');

-- What the pull itself said it did — `PullResult.outcome` in
-- `src/ingest/pipedream/pull.ts`, restated. NULL means the attempt produced no
-- result at all, which is a different sentence from any of these five and the
-- reason the column is nullable: the handler threw before, or instead of,
-- reaching one.
CREATE TYPE control.connector_run_outcome AS ENUM (
  'completed',
  'stopped',
  'deferred',
  'refused',
  'failed'
);

-- `ingest_log.failure_code`'s vocabulary (`INGEST_FAILURE_CODES`). This is the
-- cause when there was a run to have one.
--
-- **Append-only, and the order matters.** A control plane created before a
-- label existed grows it through `ALTER TYPE … ADD VALUE`
-- (`connector-health.ts:ensureEnumLabels`), which appends — so a label inserted
-- in the middle here would leave fresh and upgraded deployments holding the
-- same labels in different orders, and the pin in
-- `test/control/connector-health.test.ts` compares the sequence.
--
-- `fleet_auth_failed` is the seventh: brainz's own fleet-wide credential
-- failing to mint, which is a different failure from `auth_expired` — a
-- *user's* grant being gone — with a different owner and the opposite retry
-- policy. Sharing one code marked every tenant's every lane dead the first time
-- the fleet secret was wrong.
CREATE TYPE control.connector_ingest_failure AS ENUM (
  'auth_expired',
  'rate_limited',
  'provider_error',
  'parse_failed',
  'budget_exhausted',
  'cancelled',
  'fleet_auth_failed'
);

-- `control.job.failure_code`'s vocabulary (`JOB_FAILURE_CODES`). This is the
-- cause when there was not.
CREATE TYPE control.connector_job_failure AS ENUM (
  'handler_error',
  'attempt_timed_out',
  'lease_stolen',
  'tenant_unavailable',
  'cancelled'
);

-- ---------------------------------------------------------------------------
-- One row per (tenant, source): the most recent attempt, overwritten in place.
--
-- **Overwritten rather than appended**, and the panel's own rule is why: a
-- source that failed on Tuesday and has worked every day since is a source that
-- recovered, and a display that reaches past the recoveries to find the failure
-- shows a red line nobody can clear. The append-only record of every attempt is
-- the tenant's `ingest_log`, which is where a history belongs; this is the
-- current state, which is what a dashboard and an operator both actually ask
-- for. `last_success_at` is the one fact that survives being overwritten,
-- because "it is failing now" and "it has never worked" are different
-- emergencies.
--
-- **The unit is (tenant, source) rather than (tenant, job)**, because that is
-- the unit of scheduling, of quarantine and of the user's mental model. Job rows
-- churn — a `done` row lands after a `dead` one, a requeue mints a new id — and
-- a health record keyed on one would answer for whichever row a reader happened
-- to find.
-- ---------------------------------------------------------------------------
CREATE TABLE control.connector_health (
  tenant_id            control.connector_health_tenant_id  NOT NULL,
  source               control.connector_health_source     NOT NULL,

  -- When this source was last attempted at all, successfully or not.
  last_attempt_at      timestamptz                         NOT NULL,

  -- When an attempt last completed. Never cleared by a later failure: it is the
  -- staleness clock, and a connector that worked in March and has failed since
  -- is a different report from one that has never worked.
  last_success_at      timestamptz,

  run_outcome          control.connector_run_outcome,
  ingest_failure_code  control.connector_ingest_failure,
  job_failure_code     control.connector_job_failure,

  -- What the last attempt moved. Counts, and deliberately only counts: **a
  -- failure reason is a code and a timestamp, not a subject line**, and the
  -- provider's own id for an item is `ingest_log.external_ref`'s business in the
  -- tenant's own database. `items_failed` is the number that separates "nothing
  -- happened this week" from "your mail stopped syncing", which is exactly the
  -- fact `ingest_log`'s run rows can state and a queue-only view cannot.
  items_written        integer                             NOT NULL DEFAULT 0,
  items_failed         integer                             NOT NULL DEFAULT 0,

  updated_at           timestamptz                         NOT NULL DEFAULT now(),

  CONSTRAINT connector_health_pkey PRIMARY KEY (tenant_id, source),

  -- A health record outlives nothing. When a tenant is deleted, what its
  -- connectors were doing goes with it.
  CONSTRAINT connector_health_belongs_to_a_tenant FOREIGN KEY (tenant_id)
    REFERENCES control.tenant (tenant_id) ON DELETE CASCADE,

  CONSTRAINT connector_health_counters_are_non_negative CHECK (
    items_written >= 0 AND items_failed >= 0
  ),

  -- **An attempt says what it did, or why it could not.** Without this, the
  -- storable row is one where every explanatory column is NULL — a record that
  -- an attempt happened and nothing else, which is the state this whole table
  -- exists to stop the fleet being in.
  CONSTRAINT connector_health_says_what_happened CHECK (
    run_outcome IS NOT NULL OR job_failure_code IS NOT NULL
  ),

  -- A run that completed has no cause to name. Enforced rather than trusted to
  -- the writer, because the one thing a health display must not do is keep
  -- showing a code for a connector that is working.
  CONSTRAINT connector_health_completed_runs_name_no_cause CHECK (
    run_outcome IS DISTINCT FROM 'completed'
    OR (ingest_failure_code IS NULL AND job_failure_code IS NULL)
  )
);
