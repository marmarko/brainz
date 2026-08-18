-- ===========================================================================
-- Rung 16 — the tenant's log learns the difference between "the provider
-- refused this item" and "this brain cannot embed at all".
--
-- `INGEST_FAILURE_CODES` gains `embed_unavailable`. The reason it had to is an
-- outage that ran for six hours without anyone being able to name it: every
-- connector on a tenant reported `provider_error`, which is also what a single
-- malformed message reports, so the one code could not distinguish "one item
-- was bad" from "nothing in this brain can be indexed". The embed backlog is a
-- query over the whole `chunk` table with no source filter, so a gateway that
-- cannot answer wedges gmail, calendar and drive at once — and the operator
-- surfaces showed three sources each blaming the provider, which is the same
-- picture three unrelated bad items would paint.
--
-- The argument is `fleet_auth_failed`'s, one rung up: a failure whose blast
-- radius is the whole tenant and whose remedy is an operator's does not belong
-- in the bucket that holds every 502. `provider_error` stays exactly what it
-- was for per-item refusals.
--
-- ---------------------------------------------------------------------------
-- WHY A DROP IS THE EXPAND-ONLY WAY TO WIDEN A CHECK
-- ---------------------------------------------------------------------------
-- Unchanged from rung 15, and true for the same reason: constraints conjoin, so
-- a second permissive one changes nothing while the first stands. The only way
-- to admit an eighth label is to drop the seven-label constraint and re-add it
-- wider under the same name. Every statement release 15 issues against
-- `ingest_log` keeps working — it writes codes from the old seven, which the new
-- constraint accepts, and reads the column with no opinion about the alphabet.
-- The scanner admits the pair (drop + same-name re-add in one rung) for that
-- reason and refuses a bare drop.
--
-- **The residual, stated rather than hidden.** Between the drop and the re-add
-- — the same transaction, microseconds — the column accepts any text. A release
-- writing a code from outside the vocabulary in that window would land it, and
-- no release does: `finishRun` takes its value from `IngestFailureCode`, whose
-- alphabet is this one.
-- ===========================================================================

ALTER TABLE ingest_log
  DROP CONSTRAINT ingest_log_failure_is_a_code;

-- A strict superset of the constraint it replaces, so every existing row passes
-- the validating scan and every code fleet-15 writes still passes on insert.
ALTER TABLE ingest_log
  ADD CONSTRAINT ingest_log_failure_is_a_code CHECK (
    failure_code IS NULL
    OR failure_code IN (
      'auth_expired', 'rate_limited', 'provider_error', 'parse_failed',
      'budget_exhausted', 'cancelled', 'fleet_auth_failed', 'embed_unavailable'
    )
  );

COMMENT ON CONSTRAINT ingest_log_failure_is_a_code ON ingest_log IS
  'registry — the alphabet src/ingest/log.ts:INGEST_FAILURE_CODES names, restated so a code this database has never heard of is refused at the write rather than rendered at a user. test/ingest/log.test.ts inserts every code in that constant and fails if one is missing here.';
