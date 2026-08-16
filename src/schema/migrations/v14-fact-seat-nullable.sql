-- ===========================================================================
-- Rung 14 — the last thing standing between the 1024 seat and a live tenant.
--
-- Rung 13 put a nullable `embedding_qwen1024 vector(1024)` beside the existing
-- column on both `chunk` and `fact`, and stopped there. It stopped because of a
-- blocker it computed from the tenant's own catalog rather than asserting in
-- prose: `fact.embedding` is `vector(1536) NOT NULL`, and no 1024-dimension
-- model can produce a value for it, so under the new seat **every fact INSERT
-- would fail** — at the first write, under a user, naming a constraint rather
-- than the routing row that caused it.
--
-- **Why this is expand-only and not a contract.** `ALTER COLUMN` is refused by
-- `src/control/migrate.ts:findExpandContractViolations` as a class, and that
-- refusal was right for every action it had seen: `TYPE` rewrites the table
-- under a previous release that is still querying it, `SET NOT NULL` breaks
-- every INSERT that release issues, `SET DEFAULT` changes what its writes mean.
-- `DROP NOT NULL` is the one action in the family that does none of those. It
-- **widens** what the table accepts and narrows nothing: a fleet-13 instance
-- serving a tenant this rung has migrated still writes `embedding` on every
-- fact, still reads it, and cannot tell the difference. That claim is not left
-- as an argument — `test/schema/fleet-surface.ts:FLEET_13_SURFACE` freezes the
-- statements release 13 actually issued against `fact`, and the rollout test
-- runs them against a database migrated to this rung.
--
-- **The invariant the NOT NULL was carrying is restated, not dropped.** "A fact
-- is embedded synchronously, so an unembedded fact is a row the database
-- refuses" is a real property and worth keeping: without it a write-path bug
-- inserts facts no similarity query can ever reach, and nothing reports it. The
-- CHECK below says the same thing across both seats — a fact must carry a
-- vector in *one* of them — which is exactly what the NOT NULL meant while
-- there was only one seat, and is satisfiable by the previous release's writes
-- (it always fills `embedding`) and by this one's (it fills whichever column the
-- model that answered belongs to).
--
-- **The residual, stated rather than hidden.** A fact written by a fleet-13
-- instance during the rollout window carries a 1536 vector and no 1024 one, and
-- **there is no backfill for facts** — `runChunkEmbedBacklog` drains chunks,
-- because a chunk is written before it is embedded by design, while a fact
-- never was. Such a fact is invisible to the new seat's similarity arm for as
-- long as it lives. Two things bound that: the window is one rolling deploy
-- long, and there is no corpus yet — which is the same reason this whole seat
-- move is cheap today and expensive later. A brain with a year of facts in it
-- would need a fact backfill written before this rung, not after.
-- ===========================================================================

ALTER TABLE fact
  ALTER COLUMN embedding DROP NOT NULL;

COMMENT ON COLUMN fact.embedding IS
  'The 1536-dimension embedding seat for facts. Nullable since rung 14: a fact embedded under the 1024 seat has NULL here, and a vector of the wrong width is not a value this column can honestly hold. The invariant the NOT NULL carried — a fact always arrives embedded — is now fact_embedded_in_some_seat, which asks it of both seats at once.';

-- Satisfiable by both live releases, which is the property an `ADD CONSTRAINT`
-- needs and does not get from being additive in shape: fleet-13 fills
-- `embedding` on every fact it writes, fleet-14 fills the column belonging to
-- the model that answered. Every row that already exists was written by the
-- former, so the validating scan passes on every tenant.
ALTER TABLE fact
  ADD CONSTRAINT fact_embedded_in_some_seat
  CHECK (embedding IS NOT NULL OR embedding_qwen1024 IS NOT NULL);

COMMENT ON CONSTRAINT fact_embedded_in_some_seat ON fact IS
  'registry — a fact carries a vector in one of the registered embedding seats. Names every column in src/schema/embedding-seat.ts:EMBEDDING_SEATS; test/schema/embedding-seat.test.ts fails if a seat is registered that this constraint does not name, because a third seat writing only its own column would fail every INSERT here.';
