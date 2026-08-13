-- ===========================================================================
-- brainz tenant schema — rung 2, the knowledge core (U3)
--
-- Rung one (`../tenant.sql`) is chunk storage: the table the three retrieval
-- hazards act on. This rung is everything the plan's approach step 1 names —
-- pages, facts, entities and their two naming primitives, typed edges with
-- declared inverses, contradiction reports, the ingest log, the per-page
-- provenance signature, the reserved image-vector column and the taxonomy
-- version — plus approach step 2's origin/subject pair on every content row.
--
-- **This file holds the user's own words by design.** The content-free rule is
-- the control plane's (`src/control/schema.sql`), and `test/control/schema.test.ts`
-- is told so explicitly: an unclassified SQL file under `src/` is a finding
-- there, so this file is named in that guard's list with its reason.
--
-- ---------------------------------------------------------------------------
-- Three properties this file is written to hold, none of which is obvious from
-- reading any single table:
--
-- **1. Expand-only.** No DROP, no RENAME, no ALTER COLUMN, and no
-- `ADD COLUMN ... NOT NULL` without a DEFAULT. During every rolling deploy the
-- previous fleet version is still serving, and it is still issuing INSERTs that
-- name rung one's column list. `findExpandContractViolations` in
-- `src/control/migrate.ts` scans this file for those shapes and
-- `test/schema/rollout.test.ts` re-runs the previous release's literal
-- statements against a database this rung has already migrated. That is why
-- `chunk.page_id` is nullable: a NOT NULL foreign key here would be a schema
-- that only the new code can write to, which is an outage of exactly the length
-- of a deploy.
--
-- **2. Origin is the database's invariant, not the write path's.** R15 calls it
-- immutable and KTD5 fences access on it alone, so a mutable origin is a
-- privilege-escalation primitive rather than a data-quality nit. One trigger
-- function, attached to every origin column, refuses the change — and refuses
-- only the change, so inference can still write the mutable half.
--
-- **3. Ingested rows carry one origin; derived rows carry the union.** A chunk
-- or a page arrived through exactly one credential, so its origin is a scalar
-- (and rung one already declared it that way). A fact, an entity, an edge or a
-- contradiction is computed from other rows, so its origin is the set of its
-- inputs' origins — an array, checked against the actual inputs **everywhere the
-- inputs are recorded**, not merely asserted in prose. That is four derivation
-- edges, and each one has its own trigger below because each one records its
-- inputs differently:
--
--   * `fact_source`   → the chunks a fact was extracted from.
--   * `fact.page_id`  → the page a fact was extracted from. A second edge on the
--                       same table as the first, which is why it is easy to miss.
--   * `entity_edge`   → its two endpoint entities.
--   * `contradiction_report` → its two facts.
--
-- `entity` is the one derived table with no checkable inputs: nothing records
-- which rows mentioned an entity, so its union is asserted by the write path and
-- by nothing else. Stated here rather than left as an apparent oversight.
--
-- A derived row with narrower origins than its inputs is not a data-quality nit:
-- KTD5 fences access on origin alone, so it is how a personal-fenced reader ends
-- up holding a work document's content, one derivation removed.
--
-- **What none of this reaches: row identity reuse.** `DELETE FROM chunk WHERE
-- chunk_id = 2` followed by an `OVERRIDING SYSTEM VALUE` insert of a new row at
-- id 2 with a different origin fires no trigger, because no origin moved — a
-- different row now answers to that id. Nothing here can prevent it: the tenant
-- role owns the table, and an actor who can DELETE and override an identity can
-- also drop the table. What the schema does buy is that the derivation edges are
-- destroyed first (`fact_source` cascades from `chunk`), so existing derived rows
-- are not retroactively re-pointed at the substituted row, and the union checks
-- above catch the next derivation that names it. Citations and caches keyed on
-- the bare id are the exposure, and they are U5's and U11's to reason about.
--
-- Each table declares which of those it is in its own `COMMENT ON TABLE`, in
-- the vocabulary `test/schema/tenant-schema.test.ts` enumerates: a table that
-- declares nothing fails that guard, so a future table cannot join this schema
-- without saying whether the origin fence applies to it.
--
-- The `{{FTS_LANGUAGE}}` placeholder is substituted at apply time from the
-- tenant's chosen language (KTD9). There is no default and no fallback.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- What the tenant knows about itself.
-- ---------------------------------------------------------------------------

CREATE TABLE tenant_setting (
  -- Singleton. "The tenant's language" stops meaning anything the moment two
  -- rows can answer it, which is the shape KTD9's silent fallback takes once
  -- there is more than one candidate.
  only_row          boolean     NOT NULL DEFAULT true,

  -- The same value that was substituted into every generated tsvector column
  -- below. Recorded so a later rung can read it back instead of trusting its
  -- caller; `src/schema/fts-language.ts` cross-checks it against the catalog,
  -- which is the only witness that cannot drift.
  fts_language      text        NOT NULL,

  -- KTD9's taxonomy version. Rows classified under an older taxonomy keep their
  -- own version (see `page`, `entity`), so a taxonomy change is a re-classify
  -- job with a queryable backlog rather than a silent reinterpretation of
  -- everything already stored.
  taxonomy_version  integer     NOT NULL DEFAULT 1,

  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT tenant_setting_pkey PRIMARY KEY (only_row),
  CONSTRAINT tenant_setting_is_a_singleton CHECK (only_row),
  CONSTRAINT tenant_setting_taxonomy_version_is_positive CHECK (taxonomy_version >= 1)
);

COMMENT ON TABLE tenant_setting IS 'registry — the tenant''s own provision-time decisions (KTD9), one row, no user content.';

INSERT INTO tenant_setting (fts_language) VALUES ('{{FTS_LANGUAGE}}');


-- ---------------------------------------------------------------------------
-- R15's enforcement, once, for every origin column in the schema.
--
-- `to_jsonb(NEW) -> TG_ARGV[0]` rather than a per-table function body: the
-- scalar and the array shapes then share one implementation, and adding a table
-- means attaching a trigger rather than copying logic that can drift.
--
-- Attached as `BEFORE UPDATE OF <column>`, which fires only when the column
-- appears in the statement's SET list — so an embedding backfill, which rewrites
-- a 1536-dimension vector on every chunk, never pays to serialize the row.
-- The value comparison stays inside the function so that a write path which
-- re-writes whole rows (naming origin_context with the value it already has) is
-- not refused for a change it did not make.
-- ---------------------------------------------------------------------------

CREATE FUNCTION refuse_origin_change() RETURNS trigger
LANGUAGE plpgsql AS $refuse_origin_change$
BEGIN
  IF to_jsonb(NEW) -> TG_ARGV[0] IS DISTINCT FROM to_jsonb(OLD) -> TG_ARGV[0] THEN
    RAISE EXCEPTION
      'origin is immutable: %.% may not be changed by an UPDATE (R15)', TG_TABLE_NAME, TG_ARGV[0]
      USING ERRCODE = 'BZ001',
            HINT = 'a row whose origin would change is a different row: write a new one and tombstone this one';
  END IF;
  RETURN NEW;
END;
$refuse_origin_change$;


-- ---------------------------------------------------------------------------
-- ingest_log — how a page got here. Carries an origin (it was fetched with a
-- credential) and no inference, so it is operational rather than content.
-- ---------------------------------------------------------------------------

CREATE TABLE ingest_log (
  ingest_id          bigint      GENERATED ALWAYS AS IDENTITY,
  origin_context     text        NOT NULL,
  source_type        text        NOT NULL,

  -- The provider's own id for what was fetched. Opaque to us: never joined to a
  -- storage key (`src/control/storage.ts` is the one place a key is derived).
  external_ref       text,

  outcome            text        NOT NULL DEFAULT 'running',
  failure_code       text,

  items_seen         integer     NOT NULL DEFAULT 0,
  items_written      integer     NOT NULL DEFAULT 0,
  items_quarantined  integer     NOT NULL DEFAULT 0,

  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,

  CONSTRAINT ingest_log_pkey PRIMARY KEY (ingest_id),
  CONSTRAINT ingest_log_outcome_is_known CHECK (outcome IN ('running', 'ok', 'failed', 'cancelled')),
  CONSTRAINT ingest_log_failure_is_a_code CHECK (
    failure_code IS NULL
    OR failure_code IN ('auth_expired', 'rate_limited', 'provider_error', 'parse_failed', 'budget_exhausted', 'cancelled')
  ),
  CONSTRAINT ingest_log_failed_runs_name_a_code CHECK (outcome <> 'failed' OR failure_code IS NOT NULL),
  CONSTRAINT ingest_log_counts_are_non_negative CHECK (
    items_seen >= 0 AND items_written >= 0 AND items_quarantined >= 0
  )
);

COMMENT ON TABLE ingest_log IS 'operational — one row per ingestion run; carries the credential-derived origin of what it fetched, no inference.';

CREATE TRIGGER ingest_log_origin_is_immutable
  BEFORE UPDATE OF origin_context ON ingest_log
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_context');


-- ---------------------------------------------------------------------------
-- page — the document a chunk came from, and the row that carries KTD8's
-- provenance signature.
-- ---------------------------------------------------------------------------

CREATE TABLE page (
  page_id              bigint      GENERATED ALWAYS AS IDENTITY,

  -- R15: immutable and credential-derived. The fence evaluates this only.
  origin_context       text        NOT NULL,

  -- R15's other half: inferred, mutable, and scored. KTD5 lets it inform
  -- ranking; it never widens access.
  subject_context      text,
  subject_confidence   real,

  -- R5's source-type priors read this. A closed set rather than free text: a
  -- prior keyed on a typo silently ranks nothing.
  source_type          text        NOT NULL,
  external_ref         text,
  ingest_id            bigint,

  title                text,
  -- KTD9, and R5's title-phrase boost. Generated rather than triggered: an
  -- immutable expression cannot drift from the text it indexes.
  title_tsv            tsvector    GENERATED ALWAYS AS (to_tsvector('{{FTS_LANGUAGE}}'::regconfig, coalesce(title, ''))) STORED,

  taxonomy_version     integer     NOT NULL DEFAULT 1,

  -- KTD8's per-page provenance signature, stored as its parts. U10's `re_embed`
  -- job selects on the signature; the parts are what tell an operator *which*
  -- half of the pipeline moved. A losing embedding A/B is a fleet re-embed keyed
  -- on exactly this, so it is written at ingestion rather than reconstructed.
  embedding_model      text        NOT NULL,
  embedding_dimensions integer     NOT NULL,
  chunker_version      integer     NOT NULL,
  normalizer_version   integer     NOT NULL,
  content_sha256       text        NOT NULL,

  -- Derived, so the signature and its parts cannot disagree.
  provenance_signature text
    GENERATED ALWAYS AS (
      embedding_model || '@' || embedding_dimensions::text
      || '/c' || chunker_version::text
      || '.n' || normalizer_version::text
      || ':' || content_sha256
    ) STORED,

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- R12 / U9: excluded from every read. Two of the three predicates behind H3.
  deleted_at           timestamptz,
  quarantined_at       timestamptz,

  CONSTRAINT page_pkey PRIMARY KEY (page_id),
  CONSTRAINT page_ingest_fkey FOREIGN KEY (ingest_id) REFERENCES ingest_log (ingest_id),
  CONSTRAINT page_source_type_is_known CHECK (
    source_type IN ('email', 'chat', 'document', 'web', 'note', 'calendar', 'transcript', 'file')
  ),
  CONSTRAINT page_content_sha256_is_a_digest CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT page_embedding_dimensions_are_positive CHECK (embedding_dimensions > 0),
  CONSTRAINT page_taxonomy_version_is_positive CHECK (taxonomy_version >= 1),
  -- An inference with no confidence is an assertion wearing an inference's
  -- clothes, and R15 says the subject half is confidence-scored.
  CONSTRAINT page_subject_is_scored CHECK (
    subject_context IS NULL
    OR (subject_confidence IS NOT NULL AND subject_confidence >= 0 AND subject_confidence <= 1)
  )
);

COMMENT ON TABLE page IS 'content:ingested — one document as it arrived through one credential; carries the immutable origin and the per-page provenance signature (KTD8).';

CREATE INDEX page_title_tsv_gin ON page USING gin (title_tsv);
CREATE INDEX page_provenance ON page (provenance_signature);
CREATE INDEX page_live_by_origin ON page (origin_context, created_at DESC)
  WHERE deleted_at IS NULL AND quarantined_at IS NULL;

CREATE TRIGGER page_origin_is_immutable
  BEFORE UPDATE OF origin_context ON page
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_context');


-- ---------------------------------------------------------------------------
-- chunk — rung one's table, joined to its page and given R15's mutable half.
--
-- Every addition here is nullable or defaulted, and that is a rollout
-- requirement rather than a preference: the previous fleet version is still
-- inserting chunks with rung one's column list while this rung is live.
-- ---------------------------------------------------------------------------

ALTER TABLE chunk ADD COLUMN page_id bigint;
ALTER TABLE chunk ADD COLUMN ordinal integer;
ALTER TABLE chunk ADD COLUMN subject_context text;
ALTER TABLE chunk ADD COLUMN subject_confidence real;

ALTER TABLE chunk ADD CONSTRAINT chunk_page_fkey FOREIGN KEY (page_id) REFERENCES page (page_id) ON DELETE CASCADE;
ALTER TABLE chunk ADD CONSTRAINT chunk_subject_is_scored CHECK (
  subject_context IS NULL
  OR (subject_confidence IS NOT NULL AND subject_confidence >= 0 AND subject_confidence <= 1)
);

COMMENT ON TABLE chunk IS 'content:ingested — the retrieval unit; one credential-derived origin, the text the vector and full-text arms both read.';

CREATE INDEX chunk_by_page ON chunk (page_id, ordinal) WHERE page_id IS NOT NULL;

CREATE TRIGGER chunk_origin_is_immutable
  BEFORE UPDATE OF origin_context ON chunk
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_context');


-- ---------------------------------------------------------------------------
-- attachment — the media path's row (U21), and KTD8's reserved image vector.
-- ---------------------------------------------------------------------------

CREATE TABLE attachment (
  attachment_id      bigint      GENERATED ALWAYS AS IDENTITY,
  page_id            bigint,

  origin_context     text        NOT NULL,
  subject_context    text,
  subject_confidence real,

  media_type         text        NOT NULL,

  -- What `src/control/storage.ts` derived. Recorded here, never re-derived
  -- here: one accessor per boundary is the invariant `src/README.md` states and
  -- `test/control/accessor-boundary.test.ts` enforces.
  object_key         text        NOT NULL,
  byte_size          bigint,
  content_sha256     text,

  -- U21 fills these. Reserved now (KTD8) so the media path is a job rather than
  -- a column migration across a fleet of suspended databases.
  ocr_text           text,
  -- Deliberately unindexed: nothing queries it yet, so an HNSW build would cost
  -- storage and write latency for no read. The dimension is a placeholder until
  -- U21 picks a model — free to change while the column is empty and unqueried,
  -- and pinned meanwhile by the same ceiling scan that guards the chunk column.
  -- `RESERVED_VECTOR_COLUMNS` in `src/schema/vector-index.ts` is where that is
  -- written down; the day something reads this column, its entry moves.
  image_embedding    vector(1152),

  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  quarantined_at     timestamptz,

  CONSTRAINT attachment_pkey PRIMARY KEY (attachment_id),
  CONSTRAINT attachment_page_fkey FOREIGN KEY (page_id) REFERENCES page (page_id) ON DELETE CASCADE,
  CONSTRAINT attachment_object_key_is_not_empty CHECK (length(object_key) > 0),
  CONSTRAINT attachment_byte_size_is_non_negative CHECK (byte_size IS NULL OR byte_size >= 0),
  CONSTRAINT attachment_subject_is_scored CHECK (
    subject_context IS NULL
    OR (subject_confidence IS NOT NULL AND subject_confidence >= 0 AND subject_confidence <= 1)
  )
);

COMMENT ON TABLE attachment IS 'content:ingested — one stored object belonging to a page; the reserved image-vector column (KTD8) lives here until U21 uses it.';

CREATE INDEX attachment_by_page ON attachment (page_id);

CREATE TRIGGER attachment_origin_is_immutable
  BEFORE UPDATE OF origin_context ON attachment
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_context');


-- ---------------------------------------------------------------------------
-- fact — derived, embedded on the write path, and origin-unioned.
-- ---------------------------------------------------------------------------

CREATE TABLE fact (
  fact_id            bigint       GENERATED ALWAYS AS IDENTITY,
  page_id            bigint,

  statement          text         NOT NULL,

  -- NOT NULL, and the asymmetry with `chunk.embedding` is the design: a chunk is
  -- written before it is embedded and backfilled, so its column is nullable; a
  -- fact is embedded synchronously on the write path (U3 approach step 1), so an
  -- unembedded fact is a bug the database refuses rather than a row the vector
  -- arm silently skips forever.
  embedding          vector(1536) NOT NULL,

  -- R15: the union of the origins of the rows this was derived from. An array
  -- rather than a scalar because narrowing it would be the moment a work-fenced
  -- reader inherits a personal chunk's content. `fact_source` is where the union
  -- stops being a claim.
  origin_contexts    text[]       NOT NULL,

  subject_context    text,
  subject_confidence real,

  -- How sure the extraction is, which is not the same question as which
  -- inference produced the subject.
  confidence         real,
  taxonomy_version   integer      NOT NULL DEFAULT 1,

  -- U11's consolidation supersedes rather than rewrites: origin is immutable,
  -- so a fact whose inputs changed is a new row pointing at the old one.
  superseded_by      bigint,

  created_at         timestamptz  NOT NULL DEFAULT now(),
  deleted_at         timestamptz,
  quarantined_at     timestamptz,

  CONSTRAINT fact_pkey PRIMARY KEY (fact_id),
  CONSTRAINT fact_page_fkey FOREIGN KEY (page_id) REFERENCES page (page_id) ON DELETE CASCADE,
  CONSTRAINT fact_superseded_fkey FOREIGN KEY (superseded_by) REFERENCES fact (fact_id),
  CONSTRAINT fact_is_not_its_own_successor CHECK (superseded_by IS NULL OR superseded_by <> fact_id),
  CONSTRAINT fact_origins_are_a_non_empty_set CHECK (
    cardinality(origin_contexts) > 0 AND array_position(origin_contexts, NULL) IS NULL
  ),
  CONSTRAINT fact_confidence_is_a_probability CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT fact_subject_is_scored CHECK (
    subject_context IS NULL
    OR (subject_confidence IS NOT NULL AND subject_confidence >= 0 AND subject_confidence <= 1)
  )
);

COMMENT ON TABLE fact IS 'content:derived — an extracted statement; its origin is the union of its inputs'' origins (R15) and its embedding is written synchronously.';

CREATE INDEX fact_embedding_hnsw ON fact USING hnsw (embedding vector_cosine_ops);
CREATE INDEX fact_origins ON fact USING gin (origin_contexts);
CREATE INDEX fact_live ON fact (created_at DESC) WHERE deleted_at IS NULL AND quarantined_at IS NULL;

CREATE TRIGGER fact_origin_is_immutable
  BEFORE UPDATE OF origin_contexts ON fact
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_contexts');

-- `page_id` is a fact's *second* derivation edge, and the easier one to forget:
-- the docstring above celebrates checking the union where the inputs are
-- recorded, and for most of this file's life that meant `fact_source` only. A
-- fact extracted from a work-fenced page while claiming `{personal}` leaks the
-- same content as one extracted from a work-fenced chunk, on the same table.
CREATE FUNCTION assert_fact_page_origin() RETURNS trigger
LANGUAGE plpgsql AS $assert_fact_page_origin$
DECLARE uncovered text;
BEGIN
  SELECT p.origin_context INTO uncovered
  FROM page p
  WHERE p.page_id = NEW.page_id
    AND NOT (p.origin_context = ANY (NEW.origin_contexts))
  LIMIT 1;

  IF uncovered IS NOT NULL THEN
    RAISE EXCEPTION
      'fact % does not carry the origin % of the page it was extracted from (R15)', NEW.fact_id, uncovered
      USING ERRCODE = 'BZ002',
            HINT = 'a derived row inherits the union of its inputs'' origins; origin is immutable, so write the fact with the full union';
  END IF;

  RETURN NULL;
END;
$assert_fact_page_origin$;

CREATE CONSTRAINT TRIGGER fact_page_origin_union
  AFTER INSERT OR UPDATE ON fact
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_fact_page_origin();


-- ---------------------------------------------------------------------------
-- fact_source — which chunks a fact was derived from, and the place R15's union
-- becomes checkable instead of merely asserted.
--
-- The trigger is a DEFERRED constraint trigger because a fact and its sources
-- are written in one transaction and the check only means anything once both
-- exist. It looks at the whole fact, not just the row being inserted, so adding
-- a source with an uncovered origin fails even when the fact was correct a
-- moment earlier.
-- ---------------------------------------------------------------------------

CREATE TABLE fact_source (
  fact_id  bigint NOT NULL,
  chunk_id bigint NOT NULL,

  CONSTRAINT fact_source_pkey PRIMARY KEY (fact_id, chunk_id),
  CONSTRAINT fact_source_fact_fkey FOREIGN KEY (fact_id) REFERENCES fact (fact_id) ON DELETE CASCADE,
  CONSTRAINT fact_source_chunk_fkey FOREIGN KEY (chunk_id) REFERENCES chunk (chunk_id) ON DELETE CASCADE
);

COMMENT ON TABLE fact_source IS 'operational — the derivation edge from a fact to the chunks it came from; it carries no origin of its own because it asserts nothing beyond the join.';

CREATE INDEX fact_source_by_chunk ON fact_source (chunk_id);

CREATE FUNCTION assert_origin_union() RETURNS trigger
LANGUAGE plpgsql AS $assert_origin_union$
DECLARE uncovered text;
BEGIN
  SELECT c.origin_context INTO uncovered
  FROM fact_source fs
  JOIN chunk c ON c.chunk_id = fs.chunk_id
  JOIN fact f ON f.fact_id = fs.fact_id
  WHERE fs.fact_id = NEW.fact_id
    AND NOT (c.origin_context = ANY (f.origin_contexts))
  LIMIT 1;

  IF uncovered IS NOT NULL THEN
    RAISE EXCEPTION
      'fact % does not carry the origin % of one of its source chunks (R15)', NEW.fact_id, uncovered
      USING ERRCODE = 'BZ002',
            HINT = 'a derived row inherits the union of its inputs'' origins; origin is immutable, so write the fact with the full union';
  END IF;

  RETURN NULL;
END;
$assert_origin_union$;

CREATE CONSTRAINT TRIGGER fact_source_origin_union
  AFTER INSERT OR UPDATE ON fact_source
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_origin_union();


-- ---------------------------------------------------------------------------
-- entity, and its TWO naming primitives.
--
-- The audit's point, made structural: a slug redirect and a free-text synonym
-- are not the same thing wearing different names.
--
--   * `entity_slug` is the addressing namespace. Every canonical slug and every
--     redirect lives in ONE table with the slug as its primary key, so a
--     redirect can never shadow a live entity's slug — the collision is a unique
--     violation rather than a resolution order nobody wrote down. A partial
--     unique index gives each entity exactly one canonical row.
--   * `entity_alias` is recall vocabulary: many per entity, deliberately NOT
--     unique across entities (two people are called Mike), scored when inferred.
--     R5's alias hop reads this; nothing addresses an entity by it.
--
-- Collapsing them into one table forces a choice between "aliases must be
-- globally unique" (false) and "a redirect may collide with a live slug"
-- (silently wrong).
-- ---------------------------------------------------------------------------

CREATE TABLE entity (
  entity_id          bigint      GENERATED ALWAYS AS IDENTITY,
  canonical_name     text        NOT NULL,
  entity_type        text        NOT NULL,
  taxonomy_version   integer     NOT NULL DEFAULT 1,

  origin_contexts    text[]      NOT NULL,
  subject_context    text,
  subject_confidence real,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,

  CONSTRAINT entity_pkey PRIMARY KEY (entity_id),
  CONSTRAINT entity_type_is_known CHECK (
    entity_type IN ('person', 'organization', 'place', 'project', 'product', 'event', 'topic', 'other')
  ),
  CONSTRAINT entity_taxonomy_version_is_positive CHECK (taxonomy_version >= 1),
  CONSTRAINT entity_origins_are_a_non_empty_set CHECK (
    cardinality(origin_contexts) > 0 AND array_position(origin_contexts, NULL) IS NULL
  ),
  CONSTRAINT entity_subject_is_scored CHECK (
    subject_context IS NULL
    OR (subject_confidence IS NOT NULL AND subject_confidence >= 0 AND subject_confidence <= 1)
  )
);

COMMENT ON TABLE entity IS 'content:derived — a resolved thing the brain knows about; origin is the union of every row that mentioned it (R15).';

CREATE INDEX entity_origins ON entity USING gin (origin_contexts);

CREATE TRIGGER entity_origin_is_immutable
  BEFORE UPDATE OF origin_contexts ON entity
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_contexts');


CREATE TABLE entity_slug (
  slug       text        NOT NULL,
  entity_id  bigint      NOT NULL,
  kind       text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT entity_slug_pkey PRIMARY KEY (slug),
  CONSTRAINT entity_slug_entity_fkey FOREIGN KEY (entity_id) REFERENCES entity (entity_id) ON DELETE CASCADE,
  CONSTRAINT entity_slug_kind_is_known CHECK (kind IN ('canonical', 'redirect')),
  CONSTRAINT entity_slug_is_a_slug CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,127}$')
);

COMMENT ON TABLE entity_slug IS 'operational — the entity addressing namespace: canonical slugs and redirects share one primary key so a redirect cannot shadow a live slug.';

CREATE UNIQUE INDEX entity_has_one_canonical_slug ON entity_slug (entity_id) WHERE kind = 'canonical';


CREATE TABLE entity_alias (
  alias_id     bigint      GENERATED ALWAYS AS IDENTITY,
  entity_id    bigint      NOT NULL,
  alias        text        NOT NULL,
  alias_source text        NOT NULL,
  confidence   real,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT entity_alias_pkey PRIMARY KEY (alias_id),
  CONSTRAINT entity_alias_entity_fkey FOREIGN KEY (entity_id) REFERENCES entity (entity_id) ON DELETE CASCADE,
  CONSTRAINT entity_alias_is_not_empty CHECK (length(btrim(alias)) > 0),
  CONSTRAINT entity_alias_source_is_known CHECK (alias_source IN ('user', 'inferred')),
  CONSTRAINT entity_alias_inferred_is_scored CHECK (
    alias_source <> 'inferred' OR (confidence IS NOT NULL AND confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT entity_alias_is_unique_per_entity UNIQUE (entity_id, alias)
);

COMMENT ON TABLE entity_alias IS 'operational — free-text synonyms for R5''s alias hop; many per entity and deliberately not unique across entities.';

CREATE INDEX entity_alias_lookup ON entity_alias (lower(alias));


-- ---------------------------------------------------------------------------
-- Typed edges, with inverses DECLARED rather than materialised.
--
-- One row per relationship. Traversal in the other direction reads the type's
-- declared inverse instead of a mirrored row, so a graph walk cannot find the
-- two halves of one relationship disagreeing — there is only one half.
--
-- The registry is therefore only useful if every declared inverse is itself
-- declared and points back: `invested_in ↔ has_investor` is an involution, and
-- `invested_in → has_investor → mentions` is a traversal that silently changes
-- meaning. The foreign key gets the first half; a deferred constraint trigger
-- gets the second, deferred because a pair is inserted in one statement and
-- neither row can be complete before the other exists.
-- ---------------------------------------------------------------------------

CREATE TABLE edge_type (
  edge_type    text        NOT NULL,
  inverse_type text        NOT NULL,
  description  text        NOT NULL,
  -- `is_symmetric` rather than `symmetric`: the bare word is reserved.
  is_symmetric boolean     GENERATED ALWAYS AS (edge_type = inverse_type) STORED,
  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT edge_type_pkey PRIMARY KEY (edge_type),
  CONSTRAINT edge_type_inverse_is_declared FOREIGN KEY (inverse_type) REFERENCES edge_type (edge_type)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT edge_type_is_a_slug CHECK (edge_type ~ '^[a-z][a-z0-9_]{1,63}$')
);

COMMENT ON TABLE edge_type IS 'registry — the closed set of edge types and their declared inverses; no user content, one row per relationship kind.';

CREATE FUNCTION assert_inverse_is_involutive() RETURNS trigger
LANGUAGE plpgsql AS $assert_inverse_is_involutive$
DECLARE back text;
BEGIN
  SELECT t.inverse_type INTO back FROM edge_type t WHERE t.edge_type = NEW.inverse_type;

  IF back IS DISTINCT FROM NEW.edge_type THEN
    RAISE EXCEPTION
      'edge type % declares % as its inverse, but % declares % — an inverse that is not an involution silently changes meaning on the second hop',
      NEW.edge_type, NEW.inverse_type, NEW.inverse_type, coalesce(back, '<undeclared>')
      USING ERRCODE = 'BZ003';
  END IF;

  RETURN NULL;
END;
$assert_inverse_is_involutive$;

CREATE CONSTRAINT TRIGGER edge_type_inverse_is_involutive
  AFTER INSERT OR UPDATE ON edge_type
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_inverse_is_involutive();

INSERT INTO edge_type (edge_type, inverse_type, description) VALUES
  ('mentions',     'mentioned_by', 'the subject names the object in its text'),
  ('mentioned_by', 'mentions',     'the inverse of mentions'),
  ('works_at',     'employs',      'the subject is employed by the object'),
  ('employs',      'works_at',     'the inverse of works_at'),
  ('invested_in',  'has_investor', 'the subject put money into the object'),
  ('has_investor', 'invested_in',  'the inverse of invested_in'),
  ('part_of',      'has_part',     'the subject is a component of the object'),
  ('has_part',     'part_of',      'the inverse of part_of'),
  ('related_to',   'related_to',   'symmetric: an unlabelled association in both directions');


CREATE TABLE entity_edge (
  edge_id            bigint      GENERATED ALWAYS AS IDENTITY,
  subject_entity_id  bigint      NOT NULL,
  edge_type          text        NOT NULL,
  object_entity_id   bigint      NOT NULL,

  origin_contexts    text[]      NOT NULL,
  subject_context    text,
  subject_confidence real,
  confidence         real,

  created_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz,

  CONSTRAINT entity_edge_pkey PRIMARY KEY (edge_id),
  CONSTRAINT entity_edge_subject_fkey FOREIGN KEY (subject_entity_id) REFERENCES entity (entity_id) ON DELETE CASCADE,
  CONSTRAINT entity_edge_object_fkey FOREIGN KEY (object_entity_id) REFERENCES entity (entity_id) ON DELETE CASCADE,
  CONSTRAINT entity_edge_type_fkey FOREIGN KEY (edge_type) REFERENCES edge_type (edge_type),
  CONSTRAINT entity_edge_is_not_a_self_loop CHECK (subject_entity_id <> object_entity_id),
  CONSTRAINT entity_edge_origins_are_a_non_empty_set CHECK (
    cardinality(origin_contexts) > 0 AND array_position(origin_contexts, NULL) IS NULL
  ),
  CONSTRAINT entity_edge_confidence_is_a_probability CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  CONSTRAINT entity_edge_subject_is_scored CHECK (
    subject_context IS NULL
    OR (subject_confidence IS NOT NULL AND subject_confidence >= 0 AND subject_confidence <= 1)
  )
);

COMMENT ON TABLE entity_edge IS 'content:derived — one typed relationship between two entities; traversed in both directions through the type''s declared inverse.';

CREATE UNIQUE INDEX entity_edge_is_stated_once
  ON entity_edge (subject_entity_id, edge_type, object_entity_id)
  WHERE deleted_at IS NULL;

CREATE INDEX entity_edge_by_object ON entity_edge (object_entity_id, edge_type) WHERE deleted_at IS NULL;

CREATE TRIGGER entity_edge_origin_is_immutable
  BEFORE UPDATE OF origin_contexts ON entity_edge
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_contexts');

-- An edge's inputs are its two endpoints, and both are NOT NULL columns on the
-- row itself — so the union is fully checkable in-row, which is exactly why
-- leaving it unchecked is indefensible rather than merely unfortunate. An edge
-- claiming `{personal}` between a personal entity and a work one tells a
-- personal-fenced graph walk that the work entity is reachable.
CREATE FUNCTION assert_edge_origin_union() RETURNS trigger
LANGUAGE plpgsql AS $assert_edge_origin_union$
DECLARE uncovered text;
BEGIN
  SELECT endpoint.origin INTO uncovered
  FROM (
    SELECT unnest(e.origin_contexts) AS origin
    FROM entity e
    WHERE e.entity_id IN (NEW.subject_entity_id, NEW.object_entity_id)
  ) AS endpoint
  WHERE NOT (endpoint.origin = ANY (NEW.origin_contexts))
  LIMIT 1;

  IF uncovered IS NOT NULL THEN
    RAISE EXCEPTION
      'edge % does not carry the origin % of one of the entities it connects (R15)', NEW.edge_id, uncovered
      USING ERRCODE = 'BZ002',
            HINT = 'a derived row inherits the union of its inputs'' origins; origin is immutable, so write the edge with the full union';
  END IF;

  RETURN NULL;
END;
$assert_edge_origin_union$;

CREATE CONSTRAINT TRIGGER entity_edge_origin_union
  AFTER INSERT OR UPDATE ON entity_edge
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_edge_origin_union();


-- ---------------------------------------------------------------------------
-- contradiction_report — two facts that cannot both be true, and what was done
-- about it. Derived, so it carries the union of both facts' origins.
-- ---------------------------------------------------------------------------

CREATE TABLE contradiction_report (
  report_id          bigint      GENERATED ALWAYS AS IDENTITY,
  left_fact_id       bigint      NOT NULL,
  right_fact_id      bigint      NOT NULL,

  kind               text        NOT NULL,
  status             text        NOT NULL DEFAULT 'open',
  resolution         text,

  origin_contexts    text[]      NOT NULL,
  subject_context    text,
  subject_confidence real,

  detected_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,

  CONSTRAINT contradiction_report_pkey PRIMARY KEY (report_id),
  CONSTRAINT contradiction_left_fkey FOREIGN KEY (left_fact_id) REFERENCES fact (fact_id) ON DELETE CASCADE,
  CONSTRAINT contradiction_right_fkey FOREIGN KEY (right_fact_id) REFERENCES fact (fact_id) ON DELETE CASCADE,
  CONSTRAINT contradiction_is_between_two_facts CHECK (left_fact_id <> right_fact_id),
  CONSTRAINT contradiction_kind_is_known CHECK (
    kind IN ('value_conflict', 'temporal_conflict', 'duplicate')
  ),
  CONSTRAINT contradiction_status_is_known CHECK (status IN ('open', 'resolved', 'dismissed')),
  CONSTRAINT contradiction_resolution_is_known CHECK (
    resolution IS NULL OR resolution IN ('left', 'right', 'both', 'neither')
  ),
  CONSTRAINT contradiction_resolved_reports_say_how CHECK (
    status <> 'resolved' OR (resolution IS NOT NULL AND resolved_at IS NOT NULL)
  ),
  CONSTRAINT contradiction_origins_are_a_non_empty_set CHECK (
    cardinality(origin_contexts) > 0 AND array_position(origin_contexts, NULL) IS NULL
  ),
  CONSTRAINT contradiction_subject_is_scored CHECK (
    subject_context IS NULL
    OR (subject_confidence IS NOT NULL AND subject_confidence >= 0 AND subject_confidence <= 1)
  )
);

COMMENT ON TABLE contradiction_report IS 'content:derived — a detected conflict between two facts; origin is the union of both sides (R15).';

CREATE UNIQUE INDEX contradiction_is_reported_once
  ON contradiction_report (least(left_fact_id, right_fact_id), greatest(left_fact_id, right_fact_id), kind);

CREATE INDEX contradiction_open ON contradiction_report (detected_at DESC) WHERE status = 'open';

CREATE TRIGGER contradiction_report_origin_is_immutable
  BEFORE UPDATE OF origin_contexts ON contradiction_report
  FOR EACH ROW EXECUTE FUNCTION refuse_origin_change('origin_contexts');

-- Both sides are NOT NULL columns on the row, so this union is checkable in-row
-- too. A report quotes the content of both facts it names; one claiming
-- `{personal}` over a work fact hands a personal-fenced reader that fact's
-- statement inside the report.
CREATE FUNCTION assert_report_origin_union() RETURNS trigger
LANGUAGE plpgsql AS $assert_report_origin_union$
DECLARE uncovered text;
BEGIN
  SELECT side.origin INTO uncovered
  FROM (
    SELECT unnest(f.origin_contexts) AS origin
    FROM fact f
    WHERE f.fact_id IN (NEW.left_fact_id, NEW.right_fact_id)
  ) AS side
  WHERE NOT (side.origin = ANY (NEW.origin_contexts))
  LIMIT 1;

  IF uncovered IS NOT NULL THEN
    RAISE EXCEPTION
      'contradiction report % does not carry the origin % of one of the facts it quotes (R15)', NEW.report_id, uncovered
      USING ERRCODE = 'BZ002',
            HINT = 'a derived row inherits the union of its inputs'' origins; origin is immutable, so write the report with the full union';
  END IF;

  RETURN NULL;
END;
$assert_report_origin_union$;

CREATE CONSTRAINT TRIGGER contradiction_report_origin_union
  AFTER INSERT OR UPDATE ON contradiction_report
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_report_origin_union();
