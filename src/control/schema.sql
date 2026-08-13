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
  -- through a float. NULL cap means "the platform default applies".
  spend_micro_usd          bigint                       NOT NULL DEFAULT 0,
  spend_window_started_at  timestamptz                  NOT NULL DEFAULT now(),
  spend_cap_micro_usd      bigint,

  created_at               timestamptz                  NOT NULL DEFAULT now(),
  updated_at               timestamptz                  NOT NULL DEFAULT now(),

  -- When the *current* provisioning attempt began. Retry moves it forward, so
  -- the reaper index below finds attempts that stopped rather than attempts
  -- that started long ago and finished.
  provisioning_started_at  timestamptz                  NOT NULL DEFAULT now(),
  provisioning_attempts    integer                      NOT NULL DEFAULT 0,
  ready_at                 timestamptz,
  failure_code             control.provisioning_failure,

  CONSTRAINT tenant_pkey PRIMARY KEY (tenant_id),

  CONSTRAINT tenant_counters_are_non_negative CHECK (
    pending_debt >= 0
    AND schema_version >= 0
    AND provisioning_attempts >= 0
    AND spend_micro_usd >= 0
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
