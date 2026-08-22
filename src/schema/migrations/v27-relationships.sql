-- ---------------------------------------------------------------------------
-- brainz tenant schema — rung 27, the relationships only the owner can state,
-- and the entity that is the owner
--
-- **Every edge type this schema shipped with is commercial or structural.**
-- `works_at`, `invested_in`, `part_of`, `mentions`, `related_to`. A brain built
-- to answer questions about somebody's life could record that a person works at
-- a company and could not record that a person is their wife. The owner asked
-- for the missing half, and the request is the specification: spouse, child,
-- parent, sibling, colleague, friend — and, separately, ownership.
--
-- **`belongs_to` is not `part_of`, and collapsing them would lose the
-- distinction this brain has spent a day recovering.** A subsidiary is a
-- COMPONENT of its parent, which is what `part_of` says and what the extractor
-- derives from "X is part of Y". A company BELONGS TO the person or holding
-- company that owns it, which nothing here could say. The two also differ in
-- shape: no existing edge type lets an organization point at a person, because
-- every one of them was written for org-to-org or person-to-org.
--
-- **Nothing populates any of these, and that is deliberate rather than
-- unfinished.** The deterministic extractor has no rule for "X is my wife" and
-- must not acquire one: inferring family from correspondence is exactly the
-- confident guess that produced a person called `Here` and twelve months filed
-- as organizations. These are facts only the owner can state, so the surface
-- that states them is the point of the rung, not an afterthought to it.
--
-- **`tenant_setting.self_entity_id` — nullable, no default, no backfill.**
--
-- NULL means the owner has never said which entity is them, and that is a
-- different fact from any guess. The brain currently holds a person called
-- `Marko Vasiljevic` only because the correspondent dictionary bound an address
-- to a name a page happened to state; nothing anywhere knows that row is the
-- owner. Writing a guess into this column would look like a decision the owner
-- made, on a column whose whole purpose is to record a decision the owner made
-- — rung 7's argument, applied a fourth time.
--
-- It heals from an observation and from nothing else. There is no poll that can
-- fill it in.
--
-- **It carries no foreign key**, for the reason `correspondent.entity_id`
-- carries none: the purge hard-DELETEs entities and must never raise,
-- `ON DELETE SET NULL` would make a `forget` of the wrong row read as "never
-- chosen" rather than as a mistake to correct, and `widenEntityOrigins` mints a
-- new id and re-points holders by explicit UPDATE. A pointer at a tombstoned or
-- absent entity reads as unset, which is the honest reading: the owner's
-- statement was about a row that is no longer there.
-- ---------------------------------------------------------------------------

-- Pairs, because `edge_type_inverse_is_declared` is a self-referencing foreign
-- key and `assert_inverse_is_involutive` raises BZ003 unless the inverse points
-- back. Both are DEFERRABLE, so a pair inserted in one statement is legal and a
-- half-pair is not.
INSERT INTO edge_type (edge_type, inverse_type, description) VALUES
  ('spouse_of',    'spouse_of',    'symmetric: the two are married or partnered'),
  ('sibling_of',   'sibling_of',   'symmetric: the two are siblings'),
  ('colleague_of', 'colleague_of', 'symmetric: the two work together, with no employer implied'),
  ('friend_of',    'friend_of',    'symmetric: the two are friends'),
  ('parent_of',    'child_of',     'the subject is a parent of the object'),
  ('child_of',     'parent_of',    'the inverse of parent_of'),
  -- Ownership, deliberately distinct from `part_of`'s composition. The object
  -- may be a person, which no other edge type in this schema permits.
  ('belongs_to',   'owns',         'the subject is owned by the object, which may be a person'),
  ('owns',         'belongs_to',   'the inverse of belongs_to');

ALTER TABLE tenant_setting ADD COLUMN self_entity_id bigint;

COMMENT ON COLUMN tenant_setting.self_entity_id IS
  'Which entity is the owner. NULL means never stated — not a guess, and nothing infers it. No foreign key: a pointer at a tombstoned or absent entity reads as unset.';
