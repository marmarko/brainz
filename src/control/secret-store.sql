-- ===========================================================================
-- brainz control plane — the durable secret store
--
-- **What this is for.** `src/control/secret-file.ts` writes a JSON file, and on
-- Cloudflare Containers there is no shared volume for it to write through: the
-- web fleet provisions a tenant into its own container's temporary copy, the
-- MCP fleet cannot see it, and the credential dies with the instance. A tenant
-- provisioned at T must be resolvable by a *different* fleet at T+1s and must
-- survive the loss of every running container, so the store has to live where
-- both fleets already look and where nothing is ephemeral.
--
-- **Why here, in the control plane.** Both fleets hold
-- `BRAINZ_CONTROL_DATABASE_URL` already; a Container has no Workers binding, so
-- a Cloudflare-native store (KV, Secrets Store) would mean an account-scoped API
-- token inside the process that parses attacker-supplied content, or a new
-- authenticated hop through the router on every tool call — and KV's eventual
-- consistency (propagation measured in tens of seconds) cannot answer the T+1s
-- requirement at all. Postgres is read-your-writes, transactional with the
-- tenant row it references, and already open in every process.
--
-- ---------------------------------------------------------------------------
-- WHAT "CONTENT-FREE" MEANS NOW, BECAUSE THIS FILE CHANGES IT
-- ---------------------------------------------------------------------------
-- `schema.sql` says the control plane holds "ids, counters, timestamps and
-- references", and specifically that "secrets are absent too". A tenant's DSN
-- and bearer are not a user's words — but they are the key to them, so storing
-- them in the clear would hand a control-plane reader every tenant's brain,
-- which is the property the content-free rule was buying in the first place.
--
-- So the rule generalises rather than bends: **the control plane holds nothing a
-- reader of the control plane can use.** What this table stores is a sealed
-- envelope (`src/control/sealed.ts`), AES-256-GCM under a key that lives only in
-- the fleets' environment and is never written to this database, bound to the
-- namespace it is stored under.
--
-- And the guard expresses it mechanically rather than trusting the sentence
-- above. `control.sealed_envelope`'s alphabet admits no `:`, no `@`, no `/` and
-- no space, so a connection string is **unstorable** in this column — the same
-- trick `control.secret_ref` uses in `schema.sql` — and the required `v1.` +
-- two-segment shape means a bare bearer grant, which is slug-shaped and which no
-- alphabet could exclude, is unstorable too. `test/control/schema.test.ts` runs
-- real DSNs, real prose and real bearer-shaped tokens at this domain and fails
-- if any of them fits.
--
-- What the seal does NOT buy is written where it is decided
-- (`src/control/sealed.ts`): every fleet process holds both the key and this
-- database's URL, so a compromised container still reaches everything. It buys
-- exactly this — a dump, a backup, a leaked DSN or a vendor console yields
-- ciphertext.
--
-- ---------------------------------------------------------------------------
-- Applied by `src/control/secret-pg.ts:ensureSecretStoreSchema` at fleet start,
-- under an advisory lock, once. It is a separate file from `schema.sql` because
-- `schema.sql` was applied to the live control plane by hand before this
-- existed, and a second copy of DDL is drift: this file is the one source, read
-- by the runtime and by the tests. It inherits the content-free guard by living
-- in this directory (`test/control/schema.test.ts` globs `src/**/*.sql`).
-- ===========================================================================

-- The store's key. Same shape as `control.secret_ref` in `schema.sql` — which
-- is what the tenant row records as a *reference* — under its own name, because
-- the two files are applied independently and a domain cannot be declared twice.
-- `/` is admitted because the store namespaces by path (`tenant/<id>`,
-- `pool/<id>`, `provider-key/<id>/<provider>`); `:` and `@` are not.
CREATE DOMAIN control.secret_namespace AS varchar(160)
  CONSTRAINT secret_namespace_is_a_namespace_path
  CHECK (VALUE ~ '^[a-z0-9][a-z0-9/_-]{0,159}$');

-- The envelope, and the whole reason a secret may live here at all.
--
--     v1.<nonce, 12 bytes base64url>.<ciphertext‖tag, base64url>
--
-- Anchored, so the shape is the whole value. The alphabet is base64url plus the
-- two separators: no `:`, no `@`, no `/`, no whitespace, no `.` except the two
-- the shape requires. A DSN cannot be written here; nor can a sentence; nor can
-- the bearer grant itself, because a bare token has no `v1.` prefix and no
-- segments. The ceiling is the `varchar(2048)` rather than a second number
-- inside the pattern: Postgres refuses a regex repetition count above 255, and
-- an upper bound the engine rejects is a CHECK that fails on every insert. The
-- ceiling is generous rather than tight — an envelope is ~360 characters for a
-- tenant pair — because a CHECK violation on a legitimate rotation would be an
-- outage, and `secret-pg.ts` refuses an oversized plaintext with a message
-- before it ever reaches this column.
CREATE DOMAIN control.sealed_envelope AS varchar(2048)
  CONSTRAINT sealed_envelope_is_a_v1_envelope
  CHECK (VALUE ~ '^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{22,}$');

-- A SHA-256 of the bootstrap seed, in hex. See `control.secret_seed`.
CREATE DOMAIN control.seed_digest AS varchar(64)
  CONSTRAINT seed_digest_is_sha256_hex
  CHECK (VALUE ~ '^[a-f0-9]{64}$');

-- ---------------------------------------------------------------------------
-- One row per namespace. The tenant row in `schema.sql` keeps its
-- `connection_secret_ref` and `bearer_secret_ref` — they still point here, and
-- they still cannot hold a secret themselves.
--
-- Deliberately NOT columns on `control.tenant`: the store holds pool entries
-- (no tenant yet) and per-provider BYOK keys (several per tenant) as well, the
-- lifetimes differ — a revoke is a DELETE here and leaves the tenant row intact
-- — and a separate table is what makes a narrower grant possible later without
-- moving data.
-- ---------------------------------------------------------------------------
CREATE TABLE control.tenant_secret (
  namespace   control.secret_namespace  NOT NULL,
  sealed      control.sealed_envelope   NOT NULL,

  created_at  timestamptz               NOT NULL DEFAULT now(),
  updated_at  timestamptz               NOT NULL DEFAULT now(),

  CONSTRAINT tenant_secret_pkey PRIMARY KEY (namespace)
);

-- ---------------------------------------------------------------------------
-- The bootstrap seed's ledger, which is what stops two stores disagreeing.
--
-- `BRAINZ_SECRETS_JSON` used to BE the store. It is now a one-way seed: a fleet
-- imports it once, entry by entry, and never again — the digest of the blob is
-- inserted here in the same transaction, so a restart re-reading the same
-- snapshot is a no-op, and a tenant revoked from the durable store cannot be
-- resurrected by a container that still has the old blob in its environment.
-- Within an import, each entry is `ON CONFLICT DO NOTHING`, so the seed can
-- introduce a tenant the store has never heard of and can never overwrite one it
-- already holds. The durable store is authoritative from its first write.
-- ---------------------------------------------------------------------------
CREATE TABLE control.secret_seed (
  digest      control.seed_digest  NOT NULL,
  -- How many namespaces the import actually inserted, as opposed to how many
  -- the blob held. Zero is the ordinary answer on a store that already knows
  -- every tenant in it.
  entries     integer              NOT NULL DEFAULT 0,
  applied_at  timestamptz          NOT NULL DEFAULT now(),

  CONSTRAINT secret_seed_pkey PRIMARY KEY (digest)
);
