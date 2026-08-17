-- ===========================================================================
-- brainz control plane — the connector link
--
-- **What this is for.** A user presses "connect gmail", authorizes at Google,
-- and closes the tab. Nothing about that reaches this fleet unless this fleet
-- goes and asks — and when it does ask, the answer has to be written somewhere
-- both halves of the deployment can read: the WEB fleet records the intent and
-- reconciles on a dashboard load, the WORKER fleet reconciles on its tick, polls
-- on a cadence and advances the cursor. One row per (tenant, source), and both
-- fleets have to see the same one.
--
-- ---------------------------------------------------------------------------
-- WHY HERE, AND NOT WHERE `src/ingest/cursor.ts` SAYS
-- ---------------------------------------------------------------------------
-- That module places connector state under the tenant's own object prefix, and
-- gives the reason: *"not in the control plane, which is content-free by
-- construction and cannot hold a provider token; not in the tenant schema, whose
-- rungs are U3's and append-only."* The first half of that sentence was written
-- before `secret-store.sql` generalised the rule it rests on; the placement it
-- chose is, today, a placement nothing can reach.
--
-- There is **no production `ScopedCredentialMinter` anywhere in `src/`**. Both
-- `src/web/serve.ts` and `src/worker/serve.ts` compose the storage accessor with
-- a minter that refuses, and say so; `wrangler.toml` records that the R2
-- credentials are on no fleet's manifest for the same reason. So the object
-- prefix is not a slower home for this record — it is no home at all, and a
-- connector state written there is a connector state written nowhere. That is
-- exactly why `connectSource` had no production caller.
--
-- The control plane is where this problem was solved once already. A tenant's
-- connection string had to be shared between three container fleets with no
-- volume between them, so `secret-store.sql` put it here **sealed**, and the
-- rule became the thing the old one was buying: **the control plane holds
-- nothing a reader of the control plane can use.** Connector state has that
-- shape exactly, and its two sensitive fields — the provider's own sync token,
-- and the mailbox identity a provider listing later reports — go inside the
-- envelope rather than into a column.
--
-- What that costs, stated: every fleet process holds both the key and this
-- database's URL, so a compromised container reaches connector state as it
-- already reaches every tenant's credentials. It buys exactly what the secret
-- store buys — a dump, a backup, a leaked control-plane DSN or a vendor console
-- yields ciphertext.
--
-- ---------------------------------------------------------------------------
-- THE THREE COLUMNS THAT ARE NOT THE ENVELOPE, AND WHY EACH IS IN THE CLEAR
-- ---------------------------------------------------------------------------
-- * `pending_since` — when the user pressed connect. Reconciliation asks the
--   vendor about pending links and nothing else, so this is a predicate, and a
--   predicate that had to be decrypted would turn an index probe into a
--   decrypt-every-row scan. It is a timestamp: `schema.sql`'s own vocabulary.
--
-- * `fence` — a counter that only advances, bumped by disconnect. It is what
--   makes "the user pressed disconnect while a reconciliation pass was mid-flight
--   at the vendor" lose rather than race: a pass reads the fence, spends its
--   round trip, and writes conditioned on the value it read. `control.job` uses
--   the same shape for the same reason, and states it: an identity string can be
--   reused or duplicated by a redeployed container; a monotonic counter cannot.
--
-- * `source` — an enum. Which of three connectors this is, and a value the
--   cadence pass groups on.
--
-- ---------------------------------------------------------------------------
-- Applied by `src/control/connector-pg.ts:ensureConnectorLinkSchema` at fleet
-- start, under its own advisory lock, once — the pattern `secret-pg.ts` settled
-- and `oauth-pg.ts` repeated, including the catch-and-re-ask a concurrent
-- catalog re-check needs. A separate file from `schema.sql` for the reason those
-- two are separate files: `schema.sql` was applied to the live control plane by
-- hand, and a second copy of DDL is drift. It inherits the content-free guard by
-- living in this directory (`test/control/schema.test.ts` globs `src/**/*.sql`).
--
-- Every domain and type this file uses is declared IN this file, including the
-- ones that restate an alphabet `schema.sql` already declares — the trade
-- `oauth-store.sql` explains: the guard parses each file on its own, and a
-- column typed by a domain declared next door is a column it reports as
-- unclassified.
-- ===========================================================================

-- The tenant this link belongs to. The alphabet `control.tenant_id`,
-- `account.tenant_id` and `secrets.ts:TENANT_ID_PATTERN` all declare, restated
-- here for the reason the header gives.
CREATE DOMAIN control.connector_tenant_id AS varchar(63)
  CONSTRAINT connector_tenant_id_is_a_slug
  CHECK (VALUE ~ '^[a-z0-9][a-z0-9-]{0,62}$');

-- The three alpha connectors, and deliberately the same three labels as
-- `control.job_target`'s connector members and `cursor.ts:CONNECTOR_SOURCES`. A
-- fourth added here and not there is a link whose `ingest_pull` job the database
-- would refuse, discovered on a live tenant.
CREATE TYPE control.connector_source AS ENUM ('gmail', 'calendar', 'drive');

-- The envelope, in the shape `src/control/sealed.ts` writes:
--
--     v1.<nonce, 12 bytes base64url>.<ciphertext‖tag, base64url>
--
-- Under its own name because a domain cannot be declared twice and the files are
-- applied independently. Anchored, so the shape is the whole value: no `:`, no
-- `@`, no `/`, no whitespace, and no `.` but the two the shape requires — so a
-- connection string, a mailbox address and a bare bearer are each unstorable
-- here. Registered in `test/control/schema.test.ts:SEALED_ENVELOPE_DOMAINS`,
-- which runs real DSNs, real prose and real bearer-shaped tokens at it.
--
-- **The bound is 4096 rather than the registry's usual 2048, and the extra is
-- bought with an argument rather than taken.** What this envelope seals is a
-- `ConnectorState`, and one of its fields is a provider continuation token whose
-- length is the provider's business and not ours: a Drive resume cursor is two
-- opaque tokens joined, and base64url expands whatever they are by a third. The
-- CHECK that would fire is on a **cursor advance**, at the end of a successful
-- poll — a connector that works once and then wedges, with a constraint
-- violation as the only evidence. That is the outage class `control.sealed_envelope`
-- widened itself to avoid, one field further along. It is still a bound, and
-- still far below a document: it is sized for one envelope over one small
-- record, not for a payload column that grew.
CREATE DOMAIN control.connector_envelope AS varchar(4096)
  CONSTRAINT connector_envelope_is_a_v1_envelope
  CHECK (VALUE ~ '^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{22,}$');

-- ---------------------------------------------------------------------------
-- One row per (tenant, source), holding both halves of the connector's life:
-- the intent, and the connection.
--
-- **One row rather than two tables**, because the two states are exclusive and
-- the transition between them is the thing that has to be atomic. A pending link
-- becomes a connected one in a single conditional UPDATE, so "reconciled twice"
-- and "reconciled while being disconnected" are decided by the engine rather
-- than by a caller holding two rows in the right order.
-- ---------------------------------------------------------------------------
CREATE TABLE control.connector_link (
  tenant_id      control.connector_tenant_id  NOT NULL,
  source         control.connector_source     NOT NULL,

  -- The `ConnectorState`, sealed under `connector/<tenant_id>/<source>`. NULL
  -- means this source is not connected — which is what a fresh link, an expired
  -- intent and a disconnected source all are.
  state          control.connector_envelope,

  -- When the user asked. Cleared the moment a connection is adopted, and by
  -- disconnect. Reconciliation reads only rows where this is set and `state` is
  -- not, which is the whole bound on how often the vendor is asked.
  pending_since  timestamptz,

  -- Bumped by disconnect, and by nothing else. See the header.
  fence          bigint                       NOT NULL DEFAULT 0,

  created_at     timestamptz                  NOT NULL DEFAULT now(),
  updated_at     timestamptz                  NOT NULL DEFAULT now(),

  CONSTRAINT connector_link_pkey PRIMARY KEY (tenant_id, source),

  -- A link outlives nothing. When a tenant is deleted its connector state goes
  -- with it, rather than becoming a sealed record about somebody who asked to be
  -- forgotten, sitting in the one database an operator dumps.
  CONSTRAINT connector_link_belongs_to_a_tenant FOREIGN KEY (tenant_id)
    REFERENCES control.tenant (tenant_id) ON DELETE CASCADE,

  CONSTRAINT connector_link_fence_is_non_negative CHECK (fence >= 0),

  -- A connected source is not also waiting to be connected. Without this, a link
  -- adopted by one instance while another was mid-reconcile would stay in the
  -- pending set and be asked about forever — a vendor round trip per tick, for a
  -- source that is already polling.
  CONSTRAINT connector_link_is_pending_or_connected CHECK (
    state IS NULL OR pending_since IS NULL
  )
);

-- The reconciliation pass's own index. Partial, because the interesting rows are
-- the few that are waiting: a fleet where every link is connected must not scan
-- them all every tick.
CREATE INDEX connector_link_pending
  ON control.connector_link (pending_since)
  WHERE state IS NULL AND pending_since IS NOT NULL;
