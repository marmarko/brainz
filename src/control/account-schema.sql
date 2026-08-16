-- ===========================================================================
-- brainz identity + billing — schema v1 (U15)
--
-- **This is a different database from `control/schema.sql`.** That file's header
-- says so in as many words: *"What is deliberately absent: any email address,
-- display name or human label. Identity is U15's, in U15's own store. The
-- control plane knows tenants by id."* This is that store. It carries its own
-- DSN, its own role, and no cross-database foreign key — which is why
-- `account.tenant_id` is redeclared here rather than imported, and why the link
-- between an account and its brain is a value this schema constrains rather than
-- a reference the database enforces.
--
-- **It is held to the control plane's content-free rule anyway**, because it
-- lives under `src/control/` and `test/control/schema.test.ts` guards every SQL
-- file in that directory without being told to. That is deliberate: identity is
-- the place a `display_name varchar(200)` or a `support_note text` arrives, and
-- the whole point of the mechanism is that the pressure is refused by a check
-- rather than by whoever is reviewing that week. Every textual column below is
-- typed by a domain that bounds its length and pins its alphabet, or by an enum
-- declared here.
--
-- **What it holds that the control plane does not, and the argument for it.**
-- One human label: the email address. It is the login identifier, the collision
-- key OAuth linking is decided on, and the only channel that exists for a breach
-- notification — a duty that cannot be discharged at a moment when the user
-- happens to be present. Storing only an HMAC of the address was considered and
-- rejected on exactly that: it would survive login, reset and linking, and it
-- would make notifying users impossible. The alphabet below is what keeps the
-- concession to one column of one shape: no whitespace, no `:`, no `/`, so
-- prose and connection strings are both unstorable, and a 254-character bound.
--
-- **What it deliberately does not hold:** any brain content, any raw webhook
-- payload, any IP address or user agent, any password (only an argon2id digest),
-- any session or reset token (only their SHA-256 digests), and any Stripe object
-- beyond an id and a dotted event type. `account.brain.tenant_id` is the entire
-- surface between identity and the brain.
-- ===========================================================================

CREATE SCHEMA account;

-- ---------------------------------------------------------------------------
-- Domains.
-- ---------------------------------------------------------------------------

-- The account id. Same alphabet as a tenant id, and deliberately NOT the same
-- value: an account may outlive a brain (U17 deletes a tenant, the account stays
-- to be billed and closed), and one identifier serving both would make that
-- sequence unrepresentable.
CREATE DOMAIN account.account_id AS varchar(63)
  CONSTRAINT account_id_is_a_slug
  CHECK (VALUE ~ '^[a-z0-9][a-z0-9-]{0,62}$');

-- The tenant this account's brain lives in. The same alphabet
-- `control.tenant_id` and `secrets.ts:TENANT_ID_PATTERN` declare, restated
-- because this is a separate database; `test/control/account-schema.test.ts`
-- pins the three together, since an id legal in one and not the others would be
-- an account whose brain is unaddressable.
CREATE DOMAIN account.tenant_id AS varchar(63)
  CONSTRAINT tenant_id_is_a_slug
  CHECK (VALUE ~ '^[a-z0-9][a-z0-9-]{0,62}$');

-- The login identifier, normalised to lowercase before it is written.
--
-- The alphabet is the concession's boundary. It admits the ASCII local-part
-- characters that ordinary consumer mail uses and refuses everything that would
-- turn this into a text column: no space, no `:` and no `/` (so neither prose
-- nor a connection string is storable), exactly one `@`, and a domain part that
-- must contain a dot and end in a letter.
--
-- **The limitation this creates is real and is not hidden.** An address outside
-- this alphabet — an internationalised local part, an uppercase-significant
-- mailbox — cannot be stored, so signup refuses it with a typed error rather
-- than mangling it into something that no longer reaches the user. That is the
-- right failure for a login identifier and the wrong one for a contact field,
-- which is a second reason there is no contact field here.
CREATE DOMAIN account.email AS varchar(254)
  CONSTRAINT email_is_a_lowercase_ascii_mailbox
  CHECK (VALUE ~ '^[a-z0-9][a-z0-9._%+-]{0,62}@[a-z0-9][a-z0-9-]{0,62}([.][a-z0-9][a-z0-9-]{0,62}){1,4}$');

-- An argon2id PHC string exactly as `Bun.password` produces it. Pinned to the
-- shape rather than bounded loosely, so a column that somehow received a
-- plaintext password would be refused by the database: a plaintext password is
-- shaped like a word, and a word is not this.
--
-- The parameters are IN the value, which is what makes a later cost bump a
-- re-hash on next successful login rather than a fleet-wide password reset.
CREATE DOMAIN account.password_hash AS varchar(256)
  CONSTRAINT password_hash_is_an_argon2id_phc_string
  CHECK (VALUE ~ '^[$]argon2id[$]v=[0-9]{1,3}[$]m=[0-9]{1,9},t=[0-9]{1,3},p=[0-9]{1,3}[$][A-Za-z0-9+/]{16,86}[$][A-Za-z0-9+/]{16,128}$');

-- SHA-256, hex. Session tokens and verification tokens are stored **only** as
-- this: the store never holds a credential a reader could present, which is the
-- rule `src/mcp/oauth.ts` applies to refresh tokens for the same reason.
CREATE DOMAIN account.token_digest AS varchar(64)
  CONSTRAINT token_digest_is_sha256_hex
  CHECK (VALUE ~ '^[a-f0-9]{64}$');

-- An identifier minted by the billing vendor: `cus_…`, `sub_…`, `evt_…`,
-- `price_…`. Opaque, printable, and incapable of holding a URL or a sentence.
--
-- **The suffix admits underscores, because the vendor's does.** `cs_test_…`,
-- `cs_live_…` and `sub_sched_…` are ordinary ids, and this alphabet is the one
-- `src/control/billing.ts` refuses a delivery against *before* it reaches the
-- column. Narrower than the vendor is not safer here: the signature has already
-- established the delivery is genuine, so an id this column cannot hold is a
-- correctly-signed upgrade discarded with a 400 the vendor gives up on. What the
-- alphabet is actually for — no URL, no sentence, no whitespace, bounded — is
-- unchanged, and the first character after the prefix is still alphanumeric so
-- the separator cannot be doubled into something that reads as two prefixes.
CREATE DOMAIN account.stripe_id AS varchar(140)
  CONSTRAINT stripe_id_is_a_prefixed_opaque_handle
  CHECK (VALUE ~ '^[a-z]{1,12}_[A-Za-z0-9][A-Za-z0-9_]{0,125}$');

-- A dotted event name (`customer.subscription.updated`). A closed set would be
-- better and is not available: the vendor adds event types without asking, and a
-- delivery whose type this column cannot hold would be a delivery we could not
-- record as ignored. So: a bounded dotted slug, which cannot be a sentence.
CREATE DOMAIN account.event_type AS varchar(96)
  CONSTRAINT event_type_is_a_dotted_slug
  CHECK (VALUE ~ '^[a-z][a-z0-9_]{0,31}([.][a-z][a-z0-9_]{0,31}){0,5}$');

-- The `sub` claim an identity provider mints. **This, with the issuer, is the
-- link key** — never the email, which the provider may change under us.
CREATE DOMAIN account.oauth_subject AS varchar(128)
  CONSTRAINT oauth_subject_is_opaque_and_printable
  CHECK (VALUE ~ '^[A-Za-z0-9][A-Za-z0-9._|-]{0,127}$');

-- The tenant's chosen full-text configuration (KTD9), carried on the account's
-- brain row because the *account* is where the user chose it and the warm pool
-- needs it at assignment time.
CREATE DOMAIN account.fts_language AS varchar(32)
  CONSTRAINT fts_language_is_a_postgres_config_name
  CHECK (VALUE ~ '^[a-z][a-z_]{0,31}$');

-- ---------------------------------------------------------------------------
-- Enumerations.
-- ---------------------------------------------------------------------------

CREATE TYPE account.account_state AS ENUM ('active', 'suspended', 'closing');

-- Two, not three. `control.tenant_tier` carries a third value (`internal`) that
-- billing has no opinion about; a subscription is free or paid, and an internal
-- tenant is one nobody subscribed for.
CREATE TYPE account.subscription_tier AS ENUM ('free', 'paid');

-- The vendor's lifecycle, reduced to what changes our behaviour. `past_due`
-- exists separately from `canceled` because the two mean different things to a
-- consolidation cycle: a past-due subscription keeps model phases during the
-- vendor's own retry window, a canceled one does not.
CREATE TYPE account.subscription_status AS ENUM (
  'none',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete'
);

CREATE TYPE account.identity_provider AS ENUM ('google', 'microsoft');

-- What a verification token is for. One table, one enum, rather than two tables
-- that would drift: the consume-once mechanics are identical and the difference
-- is entirely in what the caller may do afterwards.
CREATE TYPE account.verification_purpose AS ENUM ('email_verify', 'password_reset');

-- What happened to a webhook delivery. `duplicate` is a first-class outcome
-- rather than an error: a correctly signed, in-window, repeated delivery is
-- ordinary vendor behaviour, and recording it as a failure would hide the one
-- case that matters — a tier transition applied twice.
--
-- `superseded` is the third replay control's outcome, and it is deliberately not
-- `ignored`: a delivery we chose not to act on and a *genuine* delivery that
-- arrived after a newer one are different events to whoever is asking why an
-- upgrade did not land, and folding them together makes the ordering control
-- invisible in the one table that records it.
CREATE TYPE account.billing_event_outcome AS ENUM (
  'applied',
  'duplicate',
  'ignored',
  'superseded',
  'unknown_customer'
);

-- ---------------------------------------------------------------------------
-- The account.
-- ---------------------------------------------------------------------------

CREATE TABLE account.account (
  account_id      account.account_id     NOT NULL,

  -- Lowercased before it is written; the domain refuses anything else, so the
  -- normalisation is enforced by the database rather than remembered by callers.
  email           account.email          NOT NULL,

  -- **Load-bearing for account takeover, not a nicety.** An unverified address
  -- never auto-links an OAuth identity and never absorbs one, because the
  -- attacker in the re-plan's §4.1 owns the account and not the mailbox.
  email_verified  boolean                NOT NULL DEFAULT false,

  state           account.account_state  NOT NULL DEFAULT 'active',

  created_at      timestamptz            NOT NULL DEFAULT now(),
  updated_at      timestamptz            NOT NULL DEFAULT now(),

  CONSTRAINT account_pkey PRIMARY KEY (account_id)
);

-- One account per address. This is the collision the OAuth linking rules exist
-- to resolve safely rather than to prevent — two people cannot both hold
-- `a@b.example`, and which of them gets it is decided by proof of mailbox
-- control, never by arrival order.
CREATE UNIQUE INDEX account_email_is_exclusive ON account.account (email);

-- ---------------------------------------------------------------------------
-- The password credential, separate from the account.
--
-- Separate because an account may have none: an account created through an
-- identity provider has no password until the user sets one, and modelling that
-- as an empty string or a sentinel hash is how "no password" becomes a password
-- somebody can guess.
-- ---------------------------------------------------------------------------

CREATE TABLE account.password_credential (
  account_id     account.account_id     NOT NULL,
  password_hash  account.password_hash  NOT NULL,
  updated_at     timestamptz            NOT NULL DEFAULT now(),

  CONSTRAINT password_credential_pkey PRIMARY KEY (account_id),
  CONSTRAINT password_credential_belongs_to_an_account FOREIGN KEY (account_id)
    REFERENCES account.account (account_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- Linked identity-provider identities.
--
-- **The primary key is `(provider, subject)` and that is the security property.**
-- Keying on the email instead would mean a provider-side address change
-- re-points the link, and — the attack that matters — it would make "this
-- provider asserts the same address" sufficient to enter an existing account.
-- The email is not on this table at all, so no code path can accidentally read
-- one from it.
-- ---------------------------------------------------------------------------

CREATE TABLE account.identity (
  provider    account.identity_provider  NOT NULL,
  subject     account.oauth_subject      NOT NULL,
  account_id  account.account_id         NOT NULL,
  linked_at   timestamptz                NOT NULL DEFAULT now(),

  CONSTRAINT identity_pkey PRIMARY KEY (provider, subject),
  CONSTRAINT identity_belongs_to_an_account FOREIGN KEY (account_id)
    REFERENCES account.account (account_id) ON DELETE CASCADE
);

CREATE INDEX identity_by_account ON account.identity (account_id);

-- ---------------------------------------------------------------------------
-- Sessions.
--
-- Two expiries, not one. `absolute_expires_at` bounds a stolen cookie's whole
-- life; `last_seen_at` plus the idle window bounds an abandoned one. Either
-- alone leaves one of the two cases open.
-- ---------------------------------------------------------------------------

CREATE TABLE account.session (
  token_digest         account.token_digest  NOT NULL,
  account_id           account.account_id    NOT NULL,
  created_at           timestamptz           NOT NULL DEFAULT now(),
  last_seen_at         timestamptz           NOT NULL DEFAULT now(),
  absolute_expires_at  timestamptz           NOT NULL,

  CONSTRAINT session_pkey PRIMARY KEY (token_digest),
  CONSTRAINT session_belongs_to_an_account FOREIGN KEY (account_id)
    REFERENCES account.account (account_id) ON DELETE CASCADE
);

-- "Every session for this account", which is what a password reset and a
-- password change both have to be able to say.
CREATE INDEX session_by_account ON account.session (account_id);

-- ---------------------------------------------------------------------------
-- Verification tokens (email verification and password reset).
-- ---------------------------------------------------------------------------

CREATE TABLE account.verification (
  token_digest  account.token_digest          NOT NULL,
  account_id    account.account_id            NOT NULL,
  purpose       account.verification_purpose  NOT NULL,
  created_at    timestamptz                   NOT NULL DEFAULT now(),
  expires_at    timestamptz                   NOT NULL,
  consumed_at   timestamptz,

  CONSTRAINT verification_pkey PRIMARY KEY (token_digest),
  CONSTRAINT verification_belongs_to_an_account FOREIGN KEY (account_id)
    REFERENCES account.account (account_id) ON DELETE CASCADE
);

CREATE INDEX verification_by_account ON account.verification (account_id, purpose);

-- ---------------------------------------------------------------------------
-- The account's brain.
--
-- One row, one tenant, and the whole surface between this database and the
-- control plane. There is no foreign key because there is no shared database —
-- the reconciliation guard in `src/control/accounts.ts` is what stands in for
-- one, and it is named here so a reader does not go looking for a constraint
-- that cannot exist.
-- ---------------------------------------------------------------------------

CREATE TABLE account.brain (
  account_id    account.account_id    NOT NULL,
  tenant_id     account.tenant_id     NOT NULL,

  -- KTD9's choice, recorded where the user made it. The warm pool provisions
  -- language-neutral and applies this at assignment; a NULL here would be the
  -- silent English fallback KTD9 forbids, one layer up.
  fts_language  account.fts_language  NOT NULL,

  linked_at     timestamptz           NOT NULL DEFAULT now(),

  CONSTRAINT brain_pkey PRIMARY KEY (account_id),
  CONSTRAINT brain_belongs_to_an_account FOREIGN KEY (account_id)
    REFERENCES account.account (account_id) ON DELETE CASCADE
);

-- A brain has one owner. Without this a second account could name a tenant that
-- already belongs to somebody, and every access decision below it would be
-- correct about a link that was wrong.
CREATE UNIQUE INDEX brain_tenant_is_exclusive ON account.brain (tenant_id);

-- ---------------------------------------------------------------------------
-- The subscription.
--
-- `tier` here is the *billing* fact. `control.tenant.tier` is the fact the
-- consolidation cycle reads, and the two are kept in step by
-- `src/control/billing.ts` writing the second whenever it writes the first —
-- deliberately not by one of them being derived from the other at read time,
-- because the cycle runs in a worker that must not depend on the identity
-- database being reachable.
-- ---------------------------------------------------------------------------

CREATE TABLE account.subscription (
  account_id              account.account_id           NOT NULL,
  tier                    account.subscription_tier    NOT NULL DEFAULT 'free',
  status                  account.subscription_status  NOT NULL DEFAULT 'none',

  stripe_customer_id      account.stripe_id,
  stripe_subscription_id  account.stripe_id,

  -- When the paid period the vendor last told us about ends. Used for display
  -- and for the "you keep model phases until" copy, never as the authority on
  -- whether to run them — that is `status`, which the vendor moves.
  current_period_end      timestamptz,

  -- **`created` of the newest delivery this row has been moved by, and the
  -- reason it is a column rather than a variable.** The vendor does not promise
  -- delivery order, so a cancellation and the upgrade that preceded it can
  -- arrive the other way round — both correctly signed, both inside the
  -- tolerance, both carrying event ids nothing has claimed. Neither existing
  -- replay control can see it: the tolerance is about *when it was sent* and the
  -- `billing_event` primary key is about *whether we have seen this one*.
  --
  -- Compared inside the `UPDATE`'s own `WHERE` (`src/control/billing.ts`), never
  -- read and then written: two containers holding two different deliveries would
  -- both pass a read-then-write and the later write would win by luck.
  --
  -- NULL on every row that predates the control and on every row no subscription
  -- event has touched, and NULL admits the next delivery — the alternative would
  -- be a column that refuses every tenant's first upgrade.
  last_event_created_at   timestamptz,

  updated_at              timestamptz                  NOT NULL DEFAULT now(),

  CONSTRAINT subscription_pkey PRIMARY KEY (account_id),
  CONSTRAINT subscription_belongs_to_an_account FOREIGN KEY (account_id)
    REFERENCES account.account (account_id) ON DELETE CASCADE,

  -- A paid subscription names the vendor object it was granted by. Without this
  -- a row could say `paid` with nothing behind it — which is what a bug in the
  -- webhook handler looks like, and it would be indistinguishable from a
  -- deliberate comp.
  CONSTRAINT paid_subscriptions_name_a_vendor_object CHECK (
    tier <> 'paid' OR stripe_subscription_id IS NOT NULL
  ),

  -- And the other direction: a subscription id implies a customer it belongs to.
  CONSTRAINT subscriptions_belong_to_a_customer CHECK (
    stripe_subscription_id IS NULL OR stripe_customer_id IS NOT NULL
  )
);

-- The webhook's lookup: a delivery names a customer, not an account.
CREATE UNIQUE INDEX subscription_customer_is_exclusive
  ON account.subscription (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

CREATE UNIQUE INDEX subscription_subscription_is_exclusive
  ON account.subscription (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Webhook deliveries.
--
-- **This table is the replay control that the timestamp tolerance is not.** A
-- captured request replayed outside the tolerance window is refused by the
-- signature check; a genuine delivery repeated inside it — which the vendor does
-- on purpose, and which is the ordinary case rather than the attack — is refused
-- here, by a primary key.
--
-- No payload column. The content-free guard would refuse a `jsonb` one, and the
-- reason it is right to is that a Stripe event body carries the customer's email
-- and billing address.
-- ---------------------------------------------------------------------------

CREATE TABLE account.billing_event (
  event_id      account.stripe_id                NOT NULL,
  event_type    account.event_type               NOT NULL,
  outcome       account.billing_event_outcome    NOT NULL,
  received_at   timestamptz                      NOT NULL DEFAULT now(),

  CONSTRAINT billing_event_pkey PRIMARY KEY (event_id)
);

CREATE INDEX billing_event_by_time ON account.billing_event (received_at);
