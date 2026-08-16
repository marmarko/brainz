-- ===========================================================================
-- Rung 13 — a second embedding seat, beside the first.
--
-- The `embedding` op's model changed width. `text-embedding-3-large` is stored
-- at 1536 (KTD8, inside pgvector's HNSW ceiling of 2000);
-- `@cf/qwen/qwen3-embedding-0.6b` is natively 1024 and its endpoint **ignores**
-- the `dimensions` parameter, so there is nothing to truncate with and KTD8's
-- "truncation belongs to the provider's parameter, never to client-side
-- slicing" has nothing to reach for.
--
-- **Changing `chunk.embedding`'s type would be a contract, and it would be the
-- wrong shape of change even if it were allowed.** `ALTER COLUMN ... TYPE`
-- rewrites the table under a previous fleet version that is still querying it,
-- and — more to the point — it would silently reinterpret every vector already
-- stored: two vectors of different models are not points in the same space,
-- whatever their widths. So the second seat gets its own column, the two live
-- side by side, and which one a statement touches is decided by which model
-- produced the vector (`src/schema/embedding-seat.ts`).
--
-- **These columns are queried, not reserved**, and therefore indexed. They are
-- queried only under a configuration that routes the `embedding` op to the seat
-- that owns them — but "queried under a configuration" is queried, and a column
-- the arm can scan without an index is hazard H2 with a green guard over it
-- (`src/schema/vector-index.ts`). The build is free today because the columns
-- are empty on every existing tenant.
--
-- **What this rung deliberately does NOT do.** It does not make the new seat
-- active. `fact.embedding` is `vector(1536) NOT NULL` — a fact is embedded
-- synchronously, so an unembedded fact is a row the database refuses — and a
-- 1024-dimension model cannot produce a value for it. Dropping that NOT NULL is
-- an `ALTER COLUMN`, which the expand-only rule refuses with no waiver list, so
-- the seat is blocked on a contract rung that does not exist yet.
-- `findSeatWriteBlockers` computes that blocker from this catalog rather than
-- asserting it in prose, so it disappears by itself when the schema changes.
-- ===========================================================================

ALTER TABLE chunk
  ADD COLUMN embedding_qwen1024 vector(1024);

COMMENT ON COLUMN chunk.embedding_qwen1024 IS
  'The 1024-dimension embedding seat, beside the 1536 one. Nullable for the same reason chunk.embedding is: a chunk is written before it is embedded and the write path backfills. A chunk embedded under one seat has NULL in the other, which is what keeps a read from fusing two vector spaces.';

-- `fact.embedding` is NOT NULL; this one cannot be, because every fact that
-- already exists was embedded by the other seat and there is no value to
-- backfill it with that would not be a lie. The invariant it gives up — "the
-- database refuses an unembedded fact" — is stated here rather than lost
-- quietly, and restoring it is part of the contract rung that removes the other
-- column's NOT NULL, not something to bolt on now with a CHECK that is
-- vacuously true while that NOT NULL stands.
ALTER TABLE fact
  ADD COLUMN embedding_qwen1024 vector(1024);

COMMENT ON COLUMN fact.embedding_qwen1024 IS
  'The 1024-dimension embedding seat for facts. Nullable, unlike fact.embedding: existing facts were embedded by the other seat and no honest value backfills this one.';

CREATE INDEX chunk_embedding_qwen1024_hnsw
  ON chunk USING hnsw (embedding_qwen1024 vector_cosine_ops);

CREATE INDEX fact_embedding_qwen1024_hnsw
  ON fact USING hnsw (embedding_qwen1024 vector_cosine_ops);
