-- ---------------------------------------------------------------------------
-- brainz tenant schema — rung 26, the correspondent dictionary
--
-- **What this is for, and the measurement that decided it.** The founder's
-- address book holds 2,525 contacts and 2,131 distinct email addresses. Of
-- those addresses, THIRTEEN appear anywhere in a 10,036-page corpus. The
-- address book and the correspondence graph are, as datasets, very nearly
-- disjoint.
--
-- So this is not a second roster. It answers exactly one question — *given an
-- address this brain has independently seen, what is this person called?* — and
-- never *does this person exist?*, which the corpus answers. An entity is
-- created only where a live page independently stated the address; on today's
-- numbers the book will bind at most thirteen and create none.
--
-- **One row per address per origin, and the compound key is R15 doing the
-- design rather than being worked around.** `origin_context` is immutable by
-- trigger, so a dictionary that widened its origins would need `entity`'s
-- successor-row dance — with an address as its key, which cannot carry two
-- rows. Making the origin part of identity means the origin never changes: a
-- correspondent seen under two credentials is two rows, which is also the
-- honest reading, and it makes the severance arm an exact predicate.
--
-- **Two permanence facts, stated because neither has a door.** `applyRung`
-- compares only the version number and never the name, so once one live tenant
-- records `26 / correspondent`, a different rung 26 is silently skipped on that
-- tenant forever. And there is no `DROP TABLE` anywhere in this ladder, nor on
-- the expand-only allowlist: an abandoned feature can empty these tables, it
-- can never remove them.
-- ---------------------------------------------------------------------------

CREATE TABLE correspondent (
  correspondent_id bigint      GENERATED ALWAYS AS IDENTITY,

  -- normalize(address). The same key `subjectDigest` hashes, so
  -- sha256(address_key) IS the erasure tombstone's key by construction.
  address_key      text        NOT NULL,

  -- Scalar, not an array: identity, not a union. Rung 1's spelling.
  origin_context   text        NOT NULL,

  -- The best display name this origin has stated for this address, or NULL.
  -- NULL is ordinary: a To: header is frequently a bare addr-spec.
  display_name     text,

  -- normalize(display_name), and it exists because lower() is NOT normalize.
  -- The erasure's name arm compares against forms run through the write path's
  -- normalizer, which also does NFKC, folds typographic quotes and dashes,
  -- strips invisibles and collapses whitespace. Computing that in SQL with
  -- lower() would miss O’Brien against o'brien — a silent near-miss on a
  -- data-subject-rights path.
  name_key         text,

  -- Which feed named it. Read at promotion, where 'book' outranks 'headers': a
  -- From: display name is sender-chosen text and an address-book entry is the
  -- owner's own curation. It is the only thing distinguishing a name an
  -- attacker chose from a name the owner did.
  name_source      text,

  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),

  -- **The binding, and it deliberately carries NO FOREIGN KEY.**
  --
  -- Three things must hold at once and only this shape holds all three. The
  -- purge must never raise, which rules out a plain FK. A `forget` must stick,
  -- which rules out ON DELETE SET NULL: `forgetRecord` writes no suppression
  -- row, so a nulled binding reads as never-bound and live sightings would
  -- re-promote the person 96 hours after the owner retracted them. And a widen
  -- must still rebind, which `widenEntityOrigins` does by explicit UPDATE,
  -- exactly as it already does for `entity_slug` and `entity_alias`.
  --
  -- So a binding pointing at a tombstoned or absent entity is READ as a user
  -- retraction. The precedent for the soft reference is `review_queue.target_ref`.
  entity_id        bigint,

  -- Set once on any outcome that binds, cleared only by a severance undoing its
  -- own tombstone. The anti-resurrection latch.
  promoted_at      timestamptz,

  -- **"This address is not a person, and stop asking."**
  --
  -- The dead-binding rule above covers `forget`, which kills the ENTITY. It
  -- cannot express the failure this feature invents: a real entity bound to the
  -- wrong address, where nothing is wrong with the entity at all. Without this
  -- column there is no way to say it, because the promotion CHECK forbids a set
  -- `promoted_at` beside a null `entity_id`, so unbinding and latching cannot
  -- both happen. Never cleared by anything.
  retracted_at     timestamptz,

  CONSTRAINT correspondent_pkey PRIMARY KEY (correspondent_id),
  CONSTRAINT correspondent_is_unique_per_origin UNIQUE (address_key, origin_context),
  CONSTRAINT correspondent_key_is_not_empty CHECK (length(btrim(address_key)) > 0),
  CONSTRAINT correspondent_key_is_an_address
    CHECK (address_key ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  CONSTRAINT correspondent_name_source_is_known
    CHECK (name_source IS NULL OR name_source IN ('headers', 'book')),
  CONSTRAINT correspondent_named_when_sourced
    CHECK ((display_name IS NULL) = (name_source IS NULL)),
  CONSTRAINT correspondent_name_key_follows_the_name
    CHECK ((display_name IS NULL) = (name_key IS NULL)),
  -- Enforceable only because there is no FK above: nothing can null a latched
  -- binding, so a set `promoted_at` implies a binding forever. It permits BOTH
  -- columns null at once, which is what makes the severance reset legal — that
  -- is the point, not an oversight.
  CONSTRAINT correspondent_promotion_is_bound
    CHECK (promoted_at IS NULL OR entity_id IS NOT NULL)
);

-- R15's immutability. `origin-fence.ts` scans the catalog for every table in
-- `public` carrying an origin column, so a new table with either spelling and
-- fewer than both triggers FAILS PROVISIONING for the whole fleet. The pinned
-- twin also keeps the ladder-pin check quiet by reusing the shared functions.
CREATE TRIGGER correspondent_origin_is_immutable
  BEFORE UPDATE OF origin_context ON correspondent
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_context');

CREATE TRIGGER correspondent_origin_is_immutable_pinned
  BEFORE UPDATE OF origin_context ON correspondent
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change_pinned('origin_context');

CREATE INDEX correspondent_by_key ON correspondent (address_key);

-- The promotion candidate scan. Indexed on the key rather than on `promoted_at`,
-- because inside the partial index every `promoted_at` is NULL and the useful
-- ordering is the one promotion groups by.
CREATE INDEX correspondent_unpromoted ON correspondent (address_key)
  WHERE promoted_at IS NULL;

-- The erasure's name arm reads this, on the STORED key rather than an
-- expression over `display_name`, so the index and the predicate cannot
-- disagree about which normalizer is meant.
CREATE INDEX correspondent_by_name_key ON correspondent (name_key);

-- EVIDENCE IS A JOIN, NOT A COUNTER.
--
-- A stored `stated_pages` integer is wrong three ways, all silent: a cursor loss
-- re-backfills and re-increments over `unchanged` receipts; a Cc edit arrives as
-- `replaced` and increments again for the same page; and a forget or an erasure
-- that takes the page leaves the count standing, so a correspondent keeps
-- evidence from mail the brain no longer holds. Sightings make observation
-- idempotent by primary key, and make evidence SHRINK when pages go.
CREATE TABLE correspondent_sighting (
  correspondent_id bigint NOT NULL,
  page_id          bigint NOT NULL,
  role             text   NOT NULL,

  CONSTRAINT correspondent_sighting_pkey
    PRIMARY KEY (correspondent_id, page_id, role),
  -- **'book' is absent, and that is the structural half of the whole design.**
  -- A book entry is a STATEMENT and a header is a SIGHTING; the book carries no
  -- page, so it can never insert here, so the address book can never satisfy the
  -- evidence test and can never create a person. It can only ever supply a name
  -- for somebody the corpus already justified. Enforced by this CHECK rather
  -- than by a policy comment somewhere else.
  CONSTRAINT correspondent_sighting_role_is_known
    CHECK (role IN ('from', 'to', 'cc', 'attendee', 'organizer')),
  CONSTRAINT correspondent_sighting_correspondent_fkey FOREIGN KEY (correspondent_id)
    REFERENCES correspondent (correspondent_id) ON DELETE CASCADE,
  CONSTRAINT correspondent_sighting_page_fkey FOREIGN KEY (page_id)
    REFERENCES page (page_id) ON DELETE CASCADE
);

CREATE INDEX correspondent_sighting_by_page ON correspondent_sighting (page_id);

-- No origin column here, deliberately: the sighting's origin is the page's, and
-- a second copy is a second thing to keep true. It also keeps this table out of
-- the origin-fence catalog scan.
--
-- No `deleted_at` on either table, also deliberately: both are hard-deleted by
-- the erasure and severance arms, which is what keeps a plaintext address from
-- sitting verbatim for the life of the brain in a table where presence IS the
-- record. That is a cost as well as a saving — neither table gets automatic
-- enrolment in any lifecycle census, so the two hard-delete arms are held in
-- place by their own tests and by nothing else.
COMMENT ON TABLE correspondent IS
  'operational — a resolution dictionary of address -> display name, per origin. NOT a person: an entity exists only where promotion made one, and 2,512 of a measured 2,525 address-book rows never will. Holds nothing the provider does not already hold.';
COMMENT ON TABLE correspondent_sighting IS
  'operational — one row per (correspondent, live page, role) that stated it. The evidence count is COUNT(*) over this rather than a stored integer, so it is idempotent under re-poll and shrinks when a page is forgotten.';
