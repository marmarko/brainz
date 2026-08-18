-- ===========================================================================
-- Rung 15 — the tenant's log learns the difference between "your grant is
-- gone" and "this fleet cannot authenticate itself".
--
-- `INGEST_FAILURE_CODES` gains `fleet_auth_failed`, and the reason it had to is
-- in `src/ingest/pipedream/client.ts:classifyTokenFailure`: brainz's own
-- `client_credentials` mint — one client id and secret for the entire fleet —
-- answered `auth_expired` for every refusal that was not a wait or an outage.
-- `auth_expired` is terminal, so a single rotated fleet secret dead-lettered
-- every tenant's every lane and told each owner to reconnect an account that
-- was working perfectly. The two failures have different owners, different
-- remedies and opposite retry policies; they now have different codes.
--
-- ---------------------------------------------------------------------------
-- WHY A DROP IS THE EXPAND-ONLY WAY TO WIDEN A CHECK
-- ---------------------------------------------------------------------------
-- A CHECK constraint cannot be widened in place. Constraints conjoin, so a
-- second, more permissive one changes nothing while the first still stands:
-- the only way to admit a seventh label is to drop the six-label constraint and
-- re-add it wider under the same name.
--
-- That reads as contracting and is the opposite of it, in the precise sense
-- `src/control/migrate.ts` means: what the guard protects is a **previous fleet
-- version still serving a tenant this rung has migrated**, and every statement
-- release 14 issues against `ingest_log` keeps working here. It writes codes
-- from the old six, which the new constraint accepts; it reads the column with
-- no opinion about the alphabet. Nothing it does is narrowed. The scanner
-- admits the pair (drop + same-name re-add in one rung) for that reason and
-- refuses a bare drop, which really would leave a guarantee behind.
--
-- The proof is not the argument: `test/schema/fleet-surface.ts:FLEET_14_SURFACE`
-- freezes release 14's own `ingest_log` statements and
-- `test/schema/rollout.test.ts` runs them against a database migrated to this
-- rung.
--
-- **The residual, stated rather than hidden.** Between the drop and the re-add
-- — the same transaction, microseconds — the column accepts any text. A release
-- writing a code from outside the vocabulary in that window would land it, and
-- no release does: `finishRun` takes its value from `IngestFailureCode`, whose
-- alphabet is this one. The narrower risk of the two was leaving the constraint
-- off entirely, which this does not do.
-- ===========================================================================

ALTER TABLE ingest_log
  DROP CONSTRAINT ingest_log_failure_is_a_code;

-- Satisfiable by both live releases, which is what an `ADD CONSTRAINT` needs
-- and does not get from being additive in shape: it is a strict superset of the
-- constraint it replaces, so every row that already exists passes the
-- validating scan and every code fleet-14 writes still passes on insert.
ALTER TABLE ingest_log
  ADD CONSTRAINT ingest_log_failure_is_a_code CHECK (
    failure_code IS NULL
    OR failure_code IN (
      'auth_expired', 'rate_limited', 'provider_error', 'parse_failed',
      'budget_exhausted', 'cancelled', 'fleet_auth_failed'
    )
  );

COMMENT ON CONSTRAINT ingest_log_failure_is_a_code ON ingest_log IS
  'registry — the alphabet src/ingest/log.ts:INGEST_FAILURE_CODES names, restated so a code this database has never heard of is refused at the write rather than rendered at a user. test/ingest/log.test.ts inserts every code in that constant and fails if one is missing here.';
