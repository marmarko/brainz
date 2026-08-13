-- ===========================================================================
-- brainz tenant schema — v1, chunk-storage core
--
-- One database per tenant (KTD1), so there is no tenant column in this file and
-- there never will be: isolation is the substrate's, not a predicate's.
--
-- **This file holds the user's own words by design.** The content-free rule is
-- the control plane's (`src/control/schema.sql`), not this file's, and
-- `test/control/schema.test.ts` is told so explicitly rather than left to infer
-- it — an unclassified SQL file under `src/` is a finding there.
--
-- **Scope, stated so the next author does not mistake this for the whole
-- schema.** This is the chunk-storage core: the table the three retrieval
-- hazards in `docs/porting-hazards.md` act on, and nothing else. Every column
-- below is here because a hazard guard exercises it.
--
-- **This file is rung one of a ladder, and it is now frozen.** The rest of U3's
-- schema — pages, facts, entities and their two naming primitives, typed edges,
-- contradiction reports, the ingest log, the taxonomy version, the reserved
-- image-vector column and the `origin_context` immutability trigger — lands in
-- `migrations/v2-knowledge-core.sql`, applied on top of this by
-- `src/control/migrate.ts`. It is a rung rather than more lines here because
-- tenants provisioned against this file already exist: a schema that only exists
-- as a head file can be applied to a fresh database and nowhere else. Editing
-- this file changes what a *new* tenant gets without changing any existing one,
-- which is the drift the ladder exists to prevent. Additions go in a new rung.
--
-- **The placeholder is deliberate.** `{{FTS_LANGUAGE}}` is substituted by
-- `src/schema/apply.ts` at provision time from the tenant's chosen language
-- (KTD9), after that language is checked against `pg_ts_config` in the tenant's
-- own database. There is no default and no fallback: an English default applied
-- to a Spanish brain is the silent-wrong-answer failure KTD9 forbids, and a
-- schema file that could be applied without the substitution is a schema file
-- that will be.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ---------------------------------------------------------------------------
-- chunk — the unit the vector and full-text arms both retrieve.
-- ---------------------------------------------------------------------------
CREATE TABLE chunk (
  chunk_id        bigint GENERATED ALWAYS AS IDENTITY,

  -- R15: immutable and credential-derived. The access fence evaluates this and
  -- only this; the mutable, inferred `subject_context` is a separate column, and
  -- both it and the trigger that makes this one refuse an UPDATE arrive in rung
  -- two. Immutability is enforced by the database from that rung on, not by
  -- convention: KTD5 fences access on origin alone, so a mutable origin is a
  -- privilege-escalation primitive rather than a data-quality nit.
  origin_context  text        NOT NULL,

  content         text        NOT NULL,

  -- KTD8: `text-embedding-3-large` truncated to 1536 through the API's
  -- `dimensions` parameter. 1536 is not a preference — pgvector HNSW-indexes
  -- the `vector` type to 2,000 dimensions and 3-large is natively 3072, so the
  -- number in these parentheses is a hard constraint with headroom.
  -- `src/schema/vector-index.ts` makes that ceiling executable: a future model
  -- swap that pushes this past 2,000 is rejected by the test suite rather than
  -- by production `CREATE INDEX`. Nullable because a chunk is written before it
  -- is embedded; the write path backfills.
  embedding       vector(1536),

  -- R12: soft delete. Every read excludes these, which is half of why hazard H3
  -- exists — the predicate runs after the HNSW scan, not before it.
  deleted_at      timestamptz,

  -- U9: junk quarantine. Hidden from reads, retained for the user to inspect.
  quarantined_at  timestamptz,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chunk_pkey PRIMARY KEY (chunk_id)
);

-- KTD9: the FTS configuration is baked at provision time, per tenant. A
-- generated column rather than a trigger because the expression is immutable
-- once the config name is fixed, and an immutable expression cannot drift from
-- the text it indexes.
ALTER TABLE chunk
  ADD COLUMN content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('{{FTS_LANGUAGE}}'::regconfig, content)) STORED;

CREATE INDEX chunk_content_tsv_gin ON chunk USING gin (content_tsv);

-- ---------------------------------------------------------------------------
-- The vector index (hazard H2).
--
-- Its absence does not break correctness — Postgres falls back to a sequential
-- scan, which returns *exact* neighbours, so recall goes up and every accuracy
-- test passes harder while latency collapses at scale. That is why
-- `src/schema/apply.ts` asserts this index exists before a tenant is handed
-- out, instead of trusting that this line ran.
-- ---------------------------------------------------------------------------
CREATE INDEX chunk_embedding_hnsw ON chunk USING hnsw (embedding vector_cosine_ops);
