-- ===========================================================================
-- brainz control plane — the durable authorization store
--
-- **The failure this exists to end.** `src/mcp/serve.ts` composed
-- `createInMemoryAuthorizationStore()`: registered clients, authorization
-- codes, refresh tokens, the revocation set and the registration rate counter
-- were `Map`s and a `Set` inside one container. `McpFleet.sleepAfter` is 15
-- minutes and `src/mcp/edge.ts:FLOW_INSTANCE` routes the whole flow to one
-- Durable Object, so all of it was lost every time that instance slept, was
-- replaced, or was redeployed. The founder connected Claude, came back later,
-- and was told the account was authorized but the connector could not connect:
-- the server had never heard of the `client_id` its client was re-presenting.
--
-- Four consequences, and the fourth is the one that is not merely an outage:
-- a forgotten client, a dead refresh token (an established connector breaks
-- after 15 idle minutes, which for a personal brain is most of the day), a
-- wiped store on every deploy — and **a forgotten revocation**, which is a
-- security property failing OPEN. A grant the user retired came back to life
-- when the container did.
--
-- **Why the control plane.** The identical class was already settled once, for
-- tenant secrets (`src/control/secret-store.sql`), and the argument is not
-- re-litigated here: it is the substrate both fleets already hold
-- (`BRAINZ_CONTROL_DATABASE_URL`), reachable over ordinary outbound TCP from a
-- Container, strongly consistent — so "registered at T, resolvable at T+1s" is
-- read-your-writes rather than a propagation promise — and a Container holds no
-- Workers bindings, so a Cloudflare-native store would mean an account-scoped
-- API token inside the process that parses attacker-supplied content.
--
-- It matters here for one extra reason that did not apply to secrets: the
-- revocation list is read by `src/mcp/dispatch.ts` on **every tool call**, on
-- the *tenant's* instance, while `/authorize` and `/token` run on the shared
-- flow instance. Two instances, one list. The control plane is the only DSN
-- both of them are guaranteed to hold — `BRAINZ_IDENTITY_DATABASE_URL` is
-- `optional` in `src/mcp/serve.ts` and absent in a bearer-only self-host.
--
-- ---------------------------------------------------------------------------
-- WHAT IS SEALED, WHAT IS IN THE CLEAR, AND WHY THEY ARE DIFFERENT ARGUMENTS
-- ---------------------------------------------------------------------------
-- **Codes and refresh tokens are never stored.** Only `sha256` of them is —
-- the rule `account.session` already applies to session tokens and
-- `src/mcp/oauth.ts:hashToken` already applies to refresh tokens. A bearer
-- credential is usable by whoever holds the row, so the row must not hold one.
-- A dump of this database redeems nothing.
--
-- **Their record bodies are sealed, for confidentiality.** A `CodeRecord`
-- carries the tenant, the fence origins, the write origin and the endpoint —
-- the whole grant that is about to be minted. That is not a credential, but it
-- is a statement about who granted what to whom, and the seal costs one
-- AES-GCM open on a flow hop that is already doing a database round trip.
--
-- **The client record is sealed for a DIFFERENT reason, and conflating the two
-- would be dishonest.** A client here is PUBLIC by construction:
-- `token_endpoint_auth_method: none`, no client secret, and its redirect URIs
-- are already in the deployment's own environment as the registration
-- allowlist. There is nothing to keep secret about it. It is sealed because
-- **this database cannot hold it in the clear**: a `redirect_uri` is a URL and
-- a `client_name` is prose, and the content-free guard below makes both
-- structurally unstorable. The sealed envelope is the one registered exception,
-- so it is the encoding the substrate leaves available — a storability ruling,
-- not a confidentiality one.
--
-- **Revocations are in the clear, deliberately.** A revocation is a tenant id,
-- a grant id and a timestamp — exactly what `schema.sql` says the control plane
-- holds ("ids, counters, timestamps and references"). Sealing them would buy
-- nothing (the row records the ABSENCE of access) and would cost the one thing
-- that must stay cheap: `dispatch.ts` probes this table on every tool call, and
-- an unsealable predicate turns an index probe into a decrypt-every-row scan.
--
-- ---------------------------------------------------------------------------
-- Applied by `src/control/oauth-pg.ts:ensureAuthorizationStoreSchema` at fleet
-- start, under its own advisory lock, once — the pattern `secret-pg.ts` settled,
-- including the catch-and-re-ask that a concurrent catalog re-check needs. It is
-- a separate file from `schema.sql` for the same reason `secret-store.sql` is:
-- `schema.sql` was applied to the live control plane by hand, and a second copy
-- of DDL is drift. It inherits the content-free guard by living in this
-- directory (`test/control/schema.test.ts` globs `src/**/*.sql`).
--
-- Every domain this file uses is declared IN this file, including the ones that
-- restate an alphabet `schema.sql` already declares. That is not duplication for
-- its own sake: a domain cannot be declared twice, the two files are applied
-- independently, and the guard parses each file on its own — a column typed by a
-- domain declared next door is a column the guard reports as unclassified. The
-- same trade `secret-store.sql` made for `control.secret_namespace`.
-- ===========================================================================

-- The client handle `registerClient` mints: `bzc_` + base64url(16 bytes).
-- Pinned to the minted shape rather than bounded loosely, so this column cannot
-- hold a name, a URL or a sentence even if a caller supplied one.
CREATE DOMAIN control.oauth_client_id AS varchar(96)
  CONSTRAINT oauth_client_id_is_a_minted_handle
  CHECK (VALUE ~ '^bzc_[A-Za-z0-9_-]{16,80}$');

-- The grant handle `authorize` mints: `g_` + base64url(12 bytes).
--
-- **This alphabet is load-bearing in BOTH directions and that is why it is
-- pinned to the minter.** `/revoke` takes `grant_id` from a form body, so an
-- arbitrary caller string reaches this column: too LOOSE and the revocation
-- table becomes a free write amplifier for prose; too TIGHT and a real
-- revocation of a real grant is silently dropped by a CHECK violation, which is
-- the security property failing open in a new place. `src/mcp/oauth.ts` exports
-- `mintGrantId` and `isMintableGrantId` over one pattern, the store refuses a
-- non-mintable id BEFORE the insert (RFC 7009 says revocation answers 200
-- either way, so a 500 from a constraint would be the wrong answer twice), and
-- `test/mcp/oauth/durable-store.test.ts` mints a thousand ids and asserts every
-- one of them round-trips.
CREATE DOMAIN control.oauth_grant_id AS varchar(96)
  CONSTRAINT oauth_grant_id_is_a_minted_handle
  CHECK (VALUE ~ '^g_[A-Za-z0-9_-]{8,80}$');

-- The tenant whose grant was retired. The alphabet `control.tenant_id`,
-- `account.tenant_id` and `secrets.ts:TENANT_ID_PATTERN` all declare, restated
-- here for the reason the header gives.
CREATE DOMAIN control.oauth_tenant_id AS varchar(63)
  CONSTRAINT oauth_tenant_id_is_a_slug
  CHECK (VALUE ~ '^[a-z0-9][a-z0-9-]{0,62}$');

-- SHA-256, hex. Authorization codes and refresh tokens are stored **only** as
-- this — the rule `account.token_digest` applies to sessions, for the same
-- reason: the store never holds a credential a reader could present.
CREATE DOMAIN control.oauth_digest AS varchar(64)
  CONSTRAINT oauth_digest_is_sha256_hex
  CHECK (VALUE ~ '^[a-f0-9]{64}$');

-- The envelope, in the shape `src/control/sealed.ts` writes:
--
--     v1.<nonce, 12 bytes base64url>.<ciphertext‖tag, base64url>
--
-- The same pattern `control.sealed_envelope` carries, under its own name
-- because a domain cannot be declared twice and the two files are applied
-- independently. Anchored, so the shape is the whole value: no `:`, no `@`, no
-- `/`, no whitespace, and no `.` but the two the shape requires — so a redirect
-- URI, a client name and a bare bearer are each unstorable here. Registered in
-- `test/control/schema.test.ts:SEALED_ENVELOPE_DOMAINS`, which runs real DSNs,
-- real prose and real bearer-shaped tokens at it and fails if any of them fits.
CREATE DOMAIN control.oauth_envelope AS varchar(2048)
  CONSTRAINT oauth_envelope_is_a_v1_envelope
  CHECK (VALUE ~ '^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{22,}$');

-- ---------------------------------------------------------------------------
-- The registered client (RFC 7591).
--
-- One row per dynamic registration. `registered_at` is the value the record
-- carries rather than the row's insert time: `client_id_issued_at` is echoed to
-- the client and re-derived on every read, so it has to be the number the mint
-- decided, not the number the database happened to observe.
-- ---------------------------------------------------------------------------
CREATE TABLE control.oauth_client (
  client_id      control.oauth_client_id  NOT NULL,
  -- {clientName, redirectUris}, sealed under `oauth-client/<client_id>`.
  sealed         control.oauth_envelope   NOT NULL,
  registered_at  timestamptz              NOT NULL,
  created_at     timestamptz              NOT NULL DEFAULT now(),

  CONSTRAINT oauth_client_pkey PRIMARY KEY (client_id)
);

-- ---------------------------------------------------------------------------
-- The single-use authorization code.
--
-- **`takeCode` is a `DELETE … RETURNING` and that is the whole concurrency
-- story.** In memory, "read it and remove it" was one turn of the event loop
-- and single-use was free. In SQL a `SELECT` followed by a `DELETE` is two
-- statements with a window between them, and two simultaneous redemptions both
-- read the row — so the code is spent twice and two access tokens are minted
-- from one consent. A conditional `DELETE … RETURNING` closes it in the engine:
-- under READ COMMITTED the second delete blocks on the row lock, re-evaluates
-- after the first commits, finds nothing, and returns zero rows. Exactly one
-- caller can win. `test/mcp/oauth/durable-store.test.ts` fires both redemptions
-- concurrently and counts the winners.
--
-- The delete is unconditional on expiry, matching the in-memory store exactly:
-- a code is taken on the first redeem ATTEMPT whether or not it succeeds, so a
-- wrong verifier burns it rather than licensing a brute force.
-- `redeemAuthorizationCode` is where the expiry check lives, and it stays the
-- only place that decides it.
-- ---------------------------------------------------------------------------
CREATE TABLE control.oauth_code (
  code_digest  control.oauth_digest    NOT NULL,
  -- The `CodeRecord`, sealed under `oauth-code/<code_digest>`.
  sealed       control.oauth_envelope  NOT NULL,
  expires_at   timestamptz             NOT NULL,
  created_at   timestamptz             NOT NULL DEFAULT now(),

  CONSTRAINT oauth_code_pkey PRIMARY KEY (code_digest)
);

-- The sweep's index. Codes live 60 seconds and are mostly taken, so this table
-- holds the abandoned ones — a consent screen a user closed, a redirect that
-- never came back — and without a sweep it is a table that only grows.
CREATE INDEX oauth_code_expires_at ON control.oauth_code (expires_at);

-- ---------------------------------------------------------------------------
-- The refresh token, keyed on the digest the caller already computes.
--
-- `AuthorizationStore.putRefresh` has always taken a `tokenHash`, so this table
-- inherits the property rather than introducing it: the store has never been
-- offered the token itself.
-- ---------------------------------------------------------------------------
CREATE TABLE control.oauth_refresh (
  token_digest  control.oauth_digest    NOT NULL,
  -- The `RefreshRecord`, sealed under `oauth-refresh/<token_digest>`.
  sealed        control.oauth_envelope  NOT NULL,
  expires_at    timestamptz             NOT NULL,
  created_at    timestamptz             NOT NULL DEFAULT now(),

  CONSTRAINT oauth_refresh_pkey PRIMARY KEY (token_digest)
);

CREATE INDEX oauth_refresh_expires_at ON control.oauth_refresh (expires_at);

-- ---------------------------------------------------------------------------
-- The revocation list — the row this whole file exists for.
--
-- **Keyed on `(tenant_id, grant_id)`, never on the grant id alone.** The
-- revocation endpoint receives a grant id from its caller and nothing else, so
-- a list keyed on that id is a list any authenticated tenant can write into a
-- stranger's row of. `src/mcp/oauth.ts` states the rule; the primary key is
-- what makes it a schema fact.
--
-- **It has a retention, and the retention is derived rather than chosen.** A
-- row here may only be swept once no credential naming that grant can verify on
-- its own merits: the longest-lived one is a refresh token, and a revocation
-- blocks rotation, so the newest refresh that can name a grant revoked at T
-- expires at T + refresh-TTL, and the newest access token minted before the
-- revocation expires at T + access-TTL. `src/control/oauth-pg.ts` computes the
-- cutoff from those two constants, so lengthening a TTL lengthens the retention
-- automatically. Purging on the codes' schedule would un-revoke a live grant.
-- ---------------------------------------------------------------------------
CREATE TABLE control.oauth_revocation (
  tenant_id   control.oauth_tenant_id  NOT NULL,
  grant_id    control.oauth_grant_id   NOT NULL,
  revoked_at  timestamptz              NOT NULL,

  CONSTRAINT oauth_revocation_pkey PRIMARY KEY (tenant_id, grant_id)
);

CREATE INDEX oauth_revocation_revoked_at ON control.oauth_revocation (revoked_at);

-- ---------------------------------------------------------------------------
-- The registration rate window.
--
-- One row per accepted dynamic registration. It is a separate table from
-- `oauth_client` rather than a `count(*)` over it, because the two have
-- different lifetimes: a client is kept for as long as it is usable, and the
-- rate window is an hour wide and is swept. Counting registrations out of the
-- client table would make the limiter loosen every time the client table was
-- tidied, which is the wrong direction for a limiter.
--
-- The id is random rather than a sequence: a `bigserial` is a counter this
-- database would then hold, and a sweep of a monotonic id leaves a gap an
-- operator reads as data loss. Nothing joins to this row.
-- ---------------------------------------------------------------------------
CREATE TABLE control.oauth_registration (
  registration_id  control.oauth_digest  NOT NULL,
  registered_at    timestamptz           NOT NULL,

  CONSTRAINT oauth_registration_pkey PRIMARY KEY (registration_id)
);

CREATE INDEX oauth_registration_registered_at ON control.oauth_registration (registered_at);
