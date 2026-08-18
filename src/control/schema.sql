-- ===========================================================================
-- brainz control plane — schema v1 (U2)
--
-- One ordinary Postgres database, one row per tenant, and one defining
-- property: **it is content-free.** It holds ids, counters, timestamps, tier
-- and references. It never holds a user's words. R10's register and U16's
-- attestation both lean on that being true, so it is checked mechanically by
-- `test/control/schema.test.ts` rather than asserted in review.
--
-- The mechanism, because it constrains how this file may grow: every textual
-- column must be typed by a domain or enum declared *here*, and every text
-- domain must bound its length and pin its alphabet with an anchored regex.
-- The guard then compiles those regexes and runs prose at them. A future
-- `note varchar(200)` fails; so does `summary text`; so does a `jsonb`
-- payload. That last one is the pressure point to expect — U10's typed job
-- table lands in this file and will want one. It gets typed columns instead.
--
-- What is deliberately absent: any email address, display name or human label.
-- Identity is U15's, in U15's own store. The control plane knows tenants by id.
--
-- Secrets are absent too. `connection_secret_ref` and `bearer_secret_ref` are
-- *references* into the secret store (`src/control/secrets.ts`); the store is
-- where R11's boundary is decided, and the alphabets below cannot even hold a
-- connection string — no `:`, no `@`.
--
-- This file is applied once, by the control plane's own bootstrap. Per-tenant
-- schema and its migration runner are U3's (`src/schema/tenant.sql`); the
-- `schema_version` column below is the control-plane half of that mechanism.
-- ===========================================================================

CREATE SCHEMA control;

-- ---------------------------------------------------------------------------
-- Domains. Each one names an alphabet, and the name is the point: a column
-- typed `control.secret_ref` cannot become a free-text column by accident, and
-- a reader can see what may be stored without reading the write path.
-- ---------------------------------------------------------------------------

-- The tenant id. This pattern is the same one `secrets.ts` uses to turn an id
-- into a secret-store namespace, and a test pins the two together: an id that
-- is legal here but not there would be provisionable and then unaddressable.
CREATE DOMAIN control.tenant_id AS varchar(63)
  CONSTRAINT tenant_id_is_a_slug
  CHECK (VALUE ~ '^[a-z0-9][a-z0-9-]{0,62}$');

-- Opaque identifiers minted by a provider (Neon project, branch, database,
-- role). Printable, punctuation-free apart from the three characters providers
-- actually use, so a provider id can never arrive carrying a path or a URL.
CREATE DOMAIN control.provider_id AS varchar(128)
  CONSTRAINT provider_id_is_opaque_and_printable
  CHECK (VALUE ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$');

-- A key into the secret store, never the secret. `/` is admitted because the
-- store namespaces by path (`tenant/<id>`); `:` and `@` are not, which is what
-- makes a connection string unstorable here.
CREATE DOMAIN control.secret_ref AS varchar(160)
  CONSTRAINT secret_ref_is_a_namespace_path
  CHECK (VALUE ~ '^[a-z0-9][a-z0-9/_-]{0,159}$');

-- The tenant's object-storage prefix, and the trailing `/` is a REQUIRED
-- control rather than tidiness. Measured, not theorised
-- (`scripts/probes/r2-boundary/RESULT.md`): R2 matches `prefixes` literally, so
-- a credential scoped to `tenant-a` read `tenant-abc/` and returned the sibling
-- tenant's object. The platform enforces the string it was given, not a
-- boundary at the separator. A prefix without its terminator is therefore not a
-- value this column is allowed to hold.
--
-- The alphabet admits interior separators because the *layout* belongs to the
-- storage accessor (`src/control/storage.ts`), which per `src/README.md` is the
-- single place a tenant id becomes a prefix; this column records what that
-- accessor derived and does not re-derive it. What it still refuses: a missing
-- terminator, a doubled separator, a leading separator, and `.` in any position
-- — so no traversal shape is storable.
CREATE DOMAIN control.object_prefix AS varchar(128)
  CONSTRAINT object_prefix_terminates_with_a_separator
  CHECK (VALUE ~ '^[a-z0-9][a-z0-9-]*(/[a-z0-9][a-z0-9-]*)*/$');

-- The tenant's full-text-search configuration name (KTD9). Chosen at
-- provisioning, before the first write is accepted, and never defaulted — see
-- the column note below.
CREATE DOMAIN control.fts_language AS varchar(32)
  CONSTRAINT fts_language_is_a_postgres_config_name
  CHECK (VALUE ~ '^[a-z][a-z_]{0,31}$');

-- ---------------------------------------------------------------------------
-- Enumerations. A finite set of labels written down in this file is the other
-- shape a string column may take: it cannot carry a payload.
-- ---------------------------------------------------------------------------

-- Provisioning is a sequence, so the row exists before the sequence finishes.
-- `provisioning` is where every row starts and where a crashed run leaves it;
-- `failed` is a run that stopped and said why; `deleting` is U17's lifecycle.
CREATE TYPE control.tenant_state AS ENUM ('provisioning', 'ready', 'failed', 'deleting');

CREATE TYPE control.tenant_tier AS ENUM ('free', 'paid', 'internal');

-- Why provisioning stopped, as a code rather than a message. The obvious
-- design is `failure_reason text`, and it is exactly how a filename, a query or
-- a connection string in an error body gets into a content-free database.
CREATE TYPE control.provisioning_failure AS ENUM (
  'project_create_failed',
  'role_create_failed',
  'schema_apply_failed',
  'first_query_failed',
  'secret_write_failed',
  'storage_prefix_failed',
  'timed_out',
  'cancelled'
);

-- ---------------------------------------------------------------------------
-- The tenant row.
-- ---------------------------------------------------------------------------

CREATE TABLE control.tenant (
  tenant_id                control.tenant_id            NOT NULL,
  state                    control.tenant_state         NOT NULL DEFAULT 'provisioning',
  tier                     control.tenant_tier          NOT NULL DEFAULT 'free',

  -- The per-tenant schema version U3's migration runner reads. 0 means the
  -- tenant database exists but carries no schema yet, which is why `ready`
  -- requires it to have moved.
  schema_version           integer                      NOT NULL DEFAULT 0,

  -- No default on purpose. KTD9's point is that provisioning *chooses* the
  -- language and applies it before the first write; a default would quietly
  -- anglicise every tenant whose choice was missed.
  fts_language             control.fts_language         NOT NULL,

  -- Provisioning artifacts. Each is NULL until its step succeeds, which is what
  -- makes a half-provisioned tenant expressible: a run that dies mid-sequence
  -- leaves a row saying exactly how far it got, and the retry knows what to
  -- clean up. The `ready` CHECK below is what stops a half row being served.
  neon_project_id          control.provider_id,
  neon_branch_id           control.provider_id,
  neon_database            control.provider_id,
  neon_role                control.provider_id,
  connection_secret_ref    control.secret_ref,
  bearer_secret_ref        control.secret_ref,
  storage_prefix           control.object_prefix,

  -- Consolidation signals. U6's dispatch writes them off the response critical
  -- path; U10's scheduler reads them. `last_activity` is stamped on
  -- user-originated calls only — connector polling accrues debt without
  -- resetting the quiet window, or a busy mailbox would starve the debounce.
  pending_debt             integer                      NOT NULL DEFAULT 0,
  last_activity            timestamptz,
  last_cycle_at            timestamptz,
  next_due_at              timestamptz,

  -- The content-free quality sample (U6). Sum and count rather than a stored
  -- average, because the writer increments and never reads.
  rank1_score_sum          double precision             NOT NULL DEFAULT 0,
  rank1_sample_count       integer                      NOT NULL DEFAULT 0,

  -- U20's rolling spend counter, in integer micro-USD so money never rounds
  -- through a float.
  --
  -- **The cap is a ceiling on the window, not an allowance per unit of work.**
  -- Every reader subtracts `spend_micro_usd` from it before spending against it
  -- (`src/ingest/first-import.ts:readHeadroom`,
  -- `src/control/tier.ts:consolidationTierOf`); a reader that hands the raw
  -- column to a repeating job grants a fresh cap every time the job runs, which
  -- is not a smaller cap than intended but no cap at all.
  --
  -- The window rolls inside the same UPDATE that accumulates, and *only* when
  -- that UPDATE runs — so a lapsed `spend_window_started_at` is read as zero
  -- spend rather than as last month's total, by both readers, on purpose.
  --
  -- NULL cap means "no ceiling from this column". The ingest gate substitutes a
  -- platform default of its own (`DEFAULT_TENANT_SPEND_CEILING`) because an
  -- unbounded first import is the largest single spend in the system; the
  -- consolidation reader does not, because a cycle is already bounded by its own
  -- estimate and the `internal` tier carries no cap row.
  spend_micro_usd          bigint                       NOT NULL DEFAULT 0,
  spend_window_started_at  timestamptz                  NOT NULL DEFAULT now(),
  spend_cap_micro_usd      bigint,

  -- **What the platform actually paid, as opposed to what the tenant spent.**
  -- R22: a call on the tenant's own key is still metered — they want to see it
  -- and it counts against their cap — but it does not count against hosted
  -- COGS, because nobody here bought those tokens. The gateway decides which is
  -- which (`hosted` key source, and a canonical price rather than a
  -- self-hoster's overlay); this column is where the decision is *kept*, and
  -- without it the exclusion is an expression evaluated and dropped.
  --
  -- Same window as `spend_micro_usd`, rolled in the same statement, because the
  -- two numbers are only ever read against each other: a COGS total that
  -- accumulated forever beside a spend total that resets monthly would show a
  -- margin collapsing every month as a pure artifact of the roll.
  --
  -- Not derivable after the fact. Nothing else stores a per-call row — that is
  -- deliberate, the control plane is content-free — so a counter not incremented
  -- at metering time is a number that cannot be reconstructed later.
  hosted_cogs_micro_usd    bigint                       NOT NULL DEFAULT 0,

  created_at               timestamptz                  NOT NULL DEFAULT now(),
  updated_at               timestamptz                  NOT NULL DEFAULT now(),

  -- When the *current* provisioning attempt began. Retry moves it forward, so
  -- the reaper index below finds attempts that stopped rather than attempts
  -- that started long ago and finished.
  provisioning_started_at  timestamptz                  NOT NULL DEFAULT now(),
  provisioning_attempts    integer                      NOT NULL DEFAULT 0,

  -- The fencing token: which attempt owns this row. Taking the row over
  -- increments it, and every write a provisioning run makes is conditional on
  -- it (`… WHERE tenant_id = $1 AND provisioning_lease = $2`). Without it,
  -- "`ready` is an absolute stop" is a read taken once at the top of a run and
  -- every write below it is unconditional — so a run that was declared stale
  -- and taken over can still bank `failed` on top of a live tenant's `ready`
  -- row, and the retry that a recorded failure invites deletes their database.
  -- An integer rather than an opaque id on purpose: this table's alphabets are
  -- for text it must be *unable* to hold, and a counter needs none of them.
  provisioning_lease       integer                      NOT NULL DEFAULT 0,

  ready_at                 timestamptz,
  failure_code             control.provisioning_failure,

  CONSTRAINT tenant_pkey PRIMARY KEY (tenant_id),

  CONSTRAINT tenant_counters_are_non_negative CHECK (
    pending_debt >= 0
    AND schema_version >= 0
    AND provisioning_attempts >= 0
    AND provisioning_lease >= 0
    AND spend_micro_usd >= 0
    AND hosted_cogs_micro_usd >= 0
    AND rank1_sample_count >= 0
    AND (spend_cap_micro_usd IS NULL OR spend_cap_micro_usd >= 0)
  ),

  -- The line between a half-provisioned tenant and a servable one. Every
  -- artifact present, a schema actually applied, and a moment it became true.
  CONSTRAINT ready_tenants_are_fully_provisioned CHECK (
    state <> 'ready' OR (
      neon_project_id       IS NOT NULL
      AND neon_branch_id    IS NOT NULL
      AND neon_database     IS NOT NULL
      AND neon_role         IS NOT NULL
      AND connection_secret_ref IS NOT NULL
      AND bearer_secret_ref IS NOT NULL
      AND storage_prefix    IS NOT NULL
      AND schema_version    > 0
      AND ready_at          IS NOT NULL
    )
  ),

  CONSTRAINT failed_tenants_name_a_code CHECK (
    state <> 'failed' OR failure_code IS NOT NULL
  ),

  -- `ready_at` is the moment this tenant became servable, so a row that is not
  -- being served cannot carry one. `deleting` is admitted because U17's
  -- lifecycle moves a tenant that *was* ready; `provisioning` and `failed` are
  -- not, and that is the point.
  --
  -- This is the contradiction the fencing token exists to prevent, written down
  -- where the database can refuse it: a row saying `failed` while still holding
  -- the `ready_at` of a live tenant is what a straggling run produced when its
  -- writes were unconditional, and it is what the next ordinary retry read
  -- before deleting a user's database. Detectable states should be
  -- unrepresentable, not merely unwritten.
  CONSTRAINT only_served_tenants_carry_a_ready_at CHECK (
    ready_at IS NULL OR state IN ('ready', 'deleting')
  ),

  -- The prefix belongs to this tenant, and that is all this constraint claims.
  -- The layout above the final segment is the storage accessor's to choose —
  -- re-deriving it here would make the schema a second derivation site, which
  -- is exactly what `src/README.md`'s one-accessor-per-boundary invariant
  -- exists to prevent. What is pinned is the part that kills the sibling
  -- hazard: the prefix must END with this tenant's own id, so a row for
  -- `alice` can never carry `…/alice2/`. NULL-safe — during provisioning the
  -- prefix is absent, the comparison yields NULL, and a CHECK accepts NULL.
  --
  -- The LIKE pattern is built from `tenant_id`, which is sound only because the
  -- tenant-id alphabet excludes `%` and `_`; a crafted id would otherwise widen
  -- its own constraint. A test pins that alphabet, and pins it to `secrets.ts`.
  CONSTRAINT storage_prefix_belongs_to_this_tenant CHECK (
    storage_prefix = tenant_id || '/'
    OR storage_prefix LIKE '%/' || tenant_id || '/'
  ),

  CONSTRAINT rank1_average_has_a_denominator CHECK (
    rank1_sample_count > 0 OR rank1_score_sum = 0
  )
);

-- ---------------------------------------------------------------------------
-- Indexes. Two of them are isolation invariants rather than access paths: they
-- make "one Neon project per tenant" and "one object prefix per tenant" facts
-- the database enforces, not conventions the provisioning code remembers.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX tenant_neon_project_is_exclusive
  ON control.tenant (neon_project_id)
  WHERE neon_project_id IS NOT NULL;

CREATE UNIQUE INDEX tenant_storage_prefix_is_exclusive
  ON control.tenant (storage_prefix)
  WHERE storage_prefix IS NOT NULL;

-- U10's "who is due" query. Partial, because a fleet of mostly-suspended
-- tenants means most rows are never due and should not be in the index.
CREATE INDEX tenant_due_for_consolidation
  ON control.tenant (next_due_at)
  WHERE state = 'ready'::control.tenant_state AND next_due_at IS NOT NULL;

-- Finds provisioning runs that stopped, so U2's idempotent retry can clean up
-- after a mid-sequence failure instead of leaving an orphaned half-tenant.
CREATE INDEX tenant_stale_provisioning
  ON control.tenant (provisioning_started_at)
  WHERE state = 'provisioning'::control.tenant_state;

-- ===========================================================================
-- The typed job table (U10).
--
-- The header of this file predicted this table and predicted what it would want:
-- a `jsonb` payload. It does not get one. Every job argument is a typed column
-- — an enum where the value is one of a set written down here, a bounded
-- alphabet-pinned domain where it is an identifier — because the control plane
-- holds every tenant's scheduling state and none of their words. A payload
-- column would carry a filename, a mailbox query, or a provider error body into
-- the one database R10's register says has no content in it.
--
-- **How this table grows.** A later unit that needs a new argument adds a
-- nullable, typed column and a CHECK tying it to the kind that uses it. That is
-- an additive rung, and it is the only shape allowed: `import` will want to name
-- the raw payload it reads, and the answer is a `varchar` domain over hex
-- digits, never the filename.
-- ===========================================================================

-- What a job *is*. Fixed at U10 because U8 and U9 consume `import` and
-- `ingest_pull` in Phase 2 and a queue whose type set is still moving is a queue
-- every consumer re-implements.
--
-- **This file builds a control plane from nothing; a live one is migrated by
-- `src/control/job-kinds.ts`.** There is no migration ladder for the control
-- plane the way `src/schema/migrations.ts` is one for a tenant, so a value added
-- here reaches a fresh install and no existing deployment. `ensurePurgeJobKind`
-- is the idempotent boot-time rung that reaches the other one, and the two must
-- carry the same value set and the same CHECK expression — a `purge` job the
-- code enqueues against an enum that has never heard of it is a `22P02` on a
-- live insert.
CREATE TYPE control.job_kind AS ENUM (
  'consolidate',
  'ingest_pull',
  'import',
  'export',
  're_embed',
  -- The 72-hour retention sweep against the tenant's own database, and the first
  -- caller `src/mcp/tombstone.ts:purgeExpiredTombstones` has ever had.
  'purge'
);

-- What the job acts on, and the reason it is one NOT NULL enum rather than a
-- nullable column per kind: it is half of the dedupe key, and a nullable column
-- in a unique index is not a key at all — Postgres holds NULLs distinct, so
-- every "one open job per tenant" claim would be silently false for the kinds
-- that left it empty. `whole_brain` is the tenant's brain taken as a whole.
CREATE TYPE control.job_target AS ENUM (
  'whole_brain',
  'gmail',
  'calendar',
  'drive',
  'chat_export',
  'folder'
);

-- `due` is claimable, `running` is leased, and the rest are terminal.
--
-- `dead` is the visible place an exhausted job lands: dead-lettering by deleting
-- the row would make a poison job indistinguishable from a job that never
-- existed, and the tenant's quarantine is read from these rows. `discarded` is
-- an operator's answer to one — "this work is not to be done" — and it is a
-- state rather than a `DELETE` for the same reason: the record of what was
-- refused, and when, is the whole value of a dead letter.
CREATE TYPE control.job_state AS ENUM ('due', 'running', 'done', 'dead', 'discarded');

-- Which of KTD11's triggers put this job here. Recorded because the three
-- triggers have different failure modes and "why did this tenant cycle" is
-- otherwise unanswerable: a fleet cycling on the ceiling alone means the
-- debounce is broken, and that looks exactly like a fleet that is working.
CREATE TYPE control.job_trigger AS ENUM (
  'debt_debounce',
  'time_ceiling',
  'user_request',
  'connector_cadence'
);

-- Why the last attempt ended. A code, for the same reason
-- `provisioning_failure` is a code: a handler's exception message is the
-- ordinary way a user's filename or a connection string reaches this database.
CREATE TYPE control.job_failure AS ENUM (
  'handler_error',
  'attempt_timed_out',
  'lease_stolen',
  'tenant_unavailable',
  'cancelled'
);

-- Which worker process holds a lease. Observability only — **the fence is the
-- token, not this column**. An identity string can be reused, guessed, or
-- duplicated by a redeployed container; a monotonic counter cannot.
CREATE DOMAIN control.worker_id AS varchar(64)
  CONSTRAINT worker_id_is_an_opaque_handle
  CHECK (VALUE ~ '^[a-z0-9][a-z0-9._-]{0,63}$');

CREATE TABLE control.job (
  job_id                uuid                    NOT NULL,
  tenant_id             control.tenant_id       NOT NULL,
  kind                  control.job_kind        NOT NULL,
  target                control.job_target      NOT NULL,
  state                 control.job_state       NOT NULL DEFAULT 'due',
  trigger_reason        control.job_trigger     NOT NULL,

  -- The retry ladder. `attempts` counts attempts *started*, so a worker that
  -- dies without ever reporting still advances it — poison-job protection has
  -- to cover the crash loop, not only the caught exception, or a handler that
  -- kills its process is retried forever.
  attempts              integer                 NOT NULL DEFAULT 0,
  max_attempts          integer                 NOT NULL DEFAULT 5,

  -- The debt this job was enqueued to work off. Completion subtracts *this*
  -- rather than zeroing the counter, because U6 increments it concurrently and
  -- a blind `= 0` silently discards everything that arrived mid-cycle.
  debt_observed         integer                 NOT NULL DEFAULT 0,

  -- When the job becomes claimable. Backoff moves it forward; it is never in
  -- the past for a job that has just failed.
  run_at                timestamptz             NOT NULL,

  -- The lease. `lease_token` is the fencing token and the reason this table can
  -- be trusted: every write a worker makes is conditional on the token it
  -- believes it holds, so a worker whose lease was stolen is not *asked* to
  -- stop — its writes are refused. U2 shipped this table's mistake first (a
  -- blind patch keyed on the row id alone) and a straggling run banked `failed`
  -- over a live tenant. The same shape here would let a zombie worker mark a
  -- job done that another worker is still running.
  lease_token           integer                 NOT NULL DEFAULT 0,
  lease_owner           control.worker_id,
  lease_expires_at      timestamptz,
  heartbeat_at          timestamptz,

  -- The stall backstop, and it is separate from the lease on purpose. The lease
  -- is renewed by the runner, not by the handler, so a wedged handler on a
  -- healthy worker heartbeats forever and holds its job forever: the liveness
  -- signal is exactly what masks the stall. This is the wall-clock ceiling on a
  -- single attempt, stamped at claim, and reclaim honours it whether or not the
  -- lease still looks alive.
  attempt_deadline_at   timestamptz,

  created_at            timestamptz             NOT NULL,
  updated_at            timestamptz             NOT NULL,
  finished_at           timestamptz,
  dead_lettered_at      timestamptz,
  failure_code          control.job_failure,

  CONSTRAINT job_pkey PRIMARY KEY (job_id),

  -- A job outlives nothing. When U17 deletes a tenant its queue goes with it,
  -- rather than becoming rows that name a tenant no connection string reaches.
  CONSTRAINT job_belongs_to_a_tenant FOREIGN KEY (tenant_id)
    REFERENCES control.tenant (tenant_id) ON DELETE CASCADE,

  CONSTRAINT job_counters_are_non_negative CHECK (
    attempts >= 0
    AND debt_observed >= 0
    AND lease_token >= 0
    AND max_attempts >= 1
  ),

  -- The kind decides which targets are legal. Without this the enum is two
  -- independent columns and `('consolidate', 'gmail')` is a storable job that
  -- no handler will ever recognise.
  CONSTRAINT job_target_suits_its_kind CHECK (
    (kind = 'consolidate' AND target = 'whole_brain')
    OR (kind = 'export' AND target = 'whole_brain')
    OR (kind = 're_embed' AND target = 'whole_brain')
    OR (kind = 'purge' AND target = 'whole_brain')
    OR (kind = 'ingest_pull' AND target IN ('gmail', 'calendar', 'drive'))
    OR (kind = 'import' AND target IN ('chat_export', 'folder'))
  ),

  -- A running job holds a real lease, with a token, an owner, an expiry and an
  -- attempt deadline. The state and the lease cannot drift apart, so "running
  -- but unleased" — the row a crashed claim would leave, and the row a reaper
  -- would skip forever — is not storable.
  CONSTRAINT running_jobs_hold_a_lease CHECK (
    state <> 'running' OR (
      lease_token > 0
      AND lease_owner IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND attempt_deadline_at IS NOT NULL
    )
  ),

  -- And the other direction: releasing a job clears its lease. A `due` row
  -- still naming an owner reads as claimed to every human looking at it.
  CONSTRAINT released_jobs_hold_no_lease CHECK (
    state = 'running' OR (
      lease_owner IS NULL
      AND lease_expires_at IS NULL
      AND attempt_deadline_at IS NULL
    )
  ),

  CONSTRAINT dead_jobs_name_a_code_and_a_moment CHECK (
    state <> 'dead' OR (failure_code IS NOT NULL AND dead_lettered_at IS NOT NULL)
  ),

  CONSTRAINT finished_jobs_carry_a_finished_at CHECK (
    state <> 'done' OR finished_at IS NOT NULL
  ),

  -- The mirror of `only_served_tenants_carry_a_ready_at` above: a row that is
  -- neither dead nor discarded cannot carry the moment it was dead-lettered.
  -- Requeueing out of quarantine has to clear the evidence with it, or the next
  -- reader sees a live job that still looks quarantined — and `enqueue` reads
  -- exactly that to decide whether a tenant is quarantined.
  CONSTRAINT only_dead_jobs_carry_a_dead_lettered_at CHECK (
    dead_lettered_at IS NULL OR state IN ('dead', 'discarded')
  )
);

-- **One open job per tenant, kind and target.** This is what makes "re-enqueued
-- once, not duplicated" a property of the database rather than of the enqueue
-- code being careful: a debounce that fires on every quiet tick, two schedulers
-- running during a rolling deploy, and a retry racing a reclaim all collapse
-- onto one row. Partial, because `done` and `dead` rows accumulate and must not
-- block the next cycle.
CREATE UNIQUE INDEX job_one_open_per_tenant_kind_target
  ON control.job (tenant_id, kind, target)
  WHERE state IN ('due', 'running');

-- The claim query's access path.
CREATE INDEX job_claimable
  ON control.job (run_at)
  WHERE state = 'due'::control.job_state;

-- The reaper's. Both reclaim conditions — an expired lease and an overrun
-- attempt deadline — are read from running rows only.
CREATE INDEX job_reclaimable
  ON control.job (lease_expires_at)
  WHERE state = 'running'::control.job_state;

-- The quarantine lookup. `enqueue` consults it on every insert, so it is on the
-- write path, not only on an operator's dashboard. Keyed on the same triple as
-- the dedupe index above, because **the unit of quarantine is the unit of
-- scheduling**: a Gmail pull that poisons a worker must not stop that tenant's
-- calendar, and a poisoned consolidation must stop the tenant's consolidation
-- (its target is the whole brain, so it does).
CREATE INDEX job_dead_letters
  ON control.job (tenant_id, kind, target)
  WHERE state = 'dead'::control.job_state;

-- ===========================================================================
-- Per-tenant feature flags (U19; the mechanism P13 asks for, P6 places here).
--
-- Without them a new chunker or a revised extractor prompt can only ship
-- all-at-once across every isolated project — no canary, no staged rollout, no
-- way to compare. `gap.per-tenant-feature-flags` in the concepts ledger has said
-- so since U1, and named this table's absence as the gap.
--
-- **Why it is content-free even though it stages user-visible changes.** A flag
-- is a name from a committed registry (`src/control/flags.ts`) and a stage from
-- a three-value enum. The *change record* the flag stages — headline, what
-- changed, what you can do — is a fleet-wide committed file under
-- `upstream/changes/`, identical for every tenant. And the half that names a
-- tenant's own memory ("41 of your pages still hold the old chunking, including
-- …") is rendered from the tenant's own database at read time and stored
-- nowhere. Three parts, three homes, and the only one that could carry a user's
-- words is the one that never lands in a database at all.
--
-- The alphabet is the same control this file applies to every textual column:
-- a flag name cannot be a sentence, so a "flag" carrying a note is unstorable.
-- ===========================================================================

CREATE DOMAIN control.feature_flag AS varchar(64)
  CONSTRAINT feature_flag_is_a_slug
  CHECK (VALUE ~ '^[a-z][a-z0-9_]{0,63}$');

-- `off` is the absence of the change for this tenant; `canary` is the staged
-- cohort; `on` is the fleet default once it has been rolled out. Three values
-- rather than a boolean because a canary a user cannot distinguish from the
-- general release cannot tell them they are early, and P13's channel is a
-- consent surface before it is a rollout mechanism.
CREATE TYPE control.flag_stage AS ENUM ('off', 'canary', 'on');

CREATE TABLE control.tenant_flag (
  tenant_id  control.tenant_id     NOT NULL,
  flag       control.feature_flag  NOT NULL,
  stage      control.flag_stage    NOT NULL DEFAULT 'off',
  set_at     timestamptz           NOT NULL DEFAULT now(),

  CONSTRAINT tenant_flag_pkey PRIMARY KEY (tenant_id, flag),

  -- A flag outlives nothing. U17's erasure takes the tenant's staging state with
  -- the tenant, rather than leaving rows naming an id no connection string
  -- reaches.
  CONSTRAINT tenant_flag_belongs_to_a_tenant FOREIGN KEY (tenant_id)
    REFERENCES control.tenant (tenant_id) ON DELETE CASCADE
);

-- "Who is in the canary cohort for this flag" — the query a staged rollout is
-- steered by, and the one an operator asks before widening it.
CREATE INDEX tenant_flag_by_stage
  ON control.tenant_flag (flag, stage);

-- ===========================================================================
-- The warm pool (U15).
--
-- KTD1 says the pool is beta machinery and U2 provisions synchronously; KTD9
-- says pool projects provision **language-neutral** and take their FTS config at
-- assignment. That second rule is not a preference here, it is forced:
-- `src/schema/fts-language.ts` substitutes the tenant's language into the DDL and
-- refuses DDL that still carries the placeholder, so a pool project *cannot*
-- have the tenant schema applied in advance. What the pool pre-pays is the slow
-- half — Neon project, branch, role, database — and what happens at assignment is
-- the schema, the first query and the bearer.
--
-- **Why it is its own table rather than tenant rows in a `pool` state.** A tenant
-- row must name an `fts_language` (NOT NULL, no default, which is KTD9's whole
-- point), and a pool project by construction has none. Expressing the pool as
-- tenants would mean either defaulting that column — the silent anglicisation
-- KTD9 forbids — or making it nullable for everybody.
--
-- Content-free by the same rule as the rest of this file: ids, states, timestamps
-- and a secret reference.
-- ===========================================================================

-- `filling` is a row that exists before the vendor call returns, so a crash
-- leaves a claim on the project name rather than an orphan nothing names.
-- `ready` is claimable. `claimed` has become a tenant. `retired` is a project
-- withdrawn from the pool — a failed fill, or a drain — and it is a state rather
-- than a `DELETE` for the reason `job_state` keeps `discarded`: the record of
-- what was withdrawn, and when, is what a reader needs to reconcile against the
-- vendor's own list of projects we are paying for.
CREATE TYPE control.pool_state AS ENUM ('filling', 'ready', 'claimed', 'retired');

CREATE TABLE control.pool_project (
  pool_id                control.tenant_id     NOT NULL,
  state                  control.pool_state    NOT NULL DEFAULT 'filling',

  neon_project_id        control.provider_id,
  neon_branch_id         control.provider_id,
  neon_database          control.provider_id,
  neon_role              control.provider_id,

  -- The pool project's connection string lives in the secret store under a
  -- `pool/` namespace, which is the ONE namespace the control-plane identity may
  -- resolve (`src/control/secrets.ts`). A pool project has no tenant, no user and
  -- no content; the moment it is claimed the string is rewritten under the
  -- tenant's own namespace and this entry is revoked.
  connection_secret_ref  control.secret_ref,

  -- Which tenant took it. Set in the same compare-and-set that moves `state`, so
  -- "claimed by nobody" is not a state a reader can observe.
  claimed_by             control.tenant_id,

  created_at             timestamptz           NOT NULL DEFAULT now(),
  ready_at               timestamptz,
  claimed_at             timestamptz,

  CONSTRAINT pool_project_pkey PRIMARY KEY (pool_id),

  -- A claimable project is a complete one. Without this a half-filled row could
  -- be handed to a signup, which would fail at schema apply with a tenant row
  -- already written.
  CONSTRAINT ready_pool_projects_are_complete CHECK (
    state <> 'ready' OR (
      neon_project_id           IS NOT NULL
      AND neon_branch_id        IS NOT NULL
      AND neon_database         IS NOT NULL
      AND neon_role             IS NOT NULL
      AND connection_secret_ref IS NOT NULL
      AND ready_at              IS NOT NULL
    )
  ),

  -- And a claimed one names its tenant and the moment. The mirror of
  -- `only_served_tenants_carry_a_ready_at`: the two halves of a claim cannot
  -- drift apart, so a project that looks taken by nobody is unrepresentable.
  CONSTRAINT claimed_pool_projects_name_a_tenant CHECK (
    (state = 'claimed') = (claimed_by IS NOT NULL AND claimed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX pool_project_neon_project_is_exclusive
  ON control.pool_project (neon_project_id)
  WHERE neon_project_id IS NOT NULL;

-- A pool project becomes exactly one tenant.
CREATE UNIQUE INDEX pool_project_claimant_is_exclusive
  ON control.pool_project (claimed_by)
  WHERE claimed_by IS NOT NULL;

-- The claim query's access path, and the fill loop's "how many are ready".
-- Partial, because claimed rows accumulate for the life of the fleet and must
-- not be scanned to answer either question.
CREATE INDEX pool_project_claimable
  ON control.pool_project (created_at)
  WHERE state = 'ready'::control.pool_state;
