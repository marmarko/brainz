-- ===========================================================================
-- Rung 17 — the tenant's log learns WHICH way the embedder was unreachable.
--
-- Rung 16 separated "the whole brain cannot be indexed" from "one item was
-- refused". That was the distinction that mattered while the question was
-- *which subsystem*. The moment it was answered, the next question — a
-- credential we cannot resolve, or a provider that refused the request — had no
-- room to be answered in, and those two have different owners and opposite
-- remedies: one is an operator's configuration and waiting never fixes it, the
-- other is the vendor's and usually fixes itself.
--
-- `embed_unavailable` is kept rather than replaced. It is the honest answer for
-- an embed failure that is neither, and rewriting existing rows to a cause this
-- release inferred after the fact would be inventing history.
--
-- The expand-only argument is rung 15's and rung 16's, unchanged: a CHECK cannot
-- be widened in place, so the only way to admit a ninth and tenth label is to
-- drop the eight-label constraint and re-add it wider under the same name. Every
-- statement release 16 issues against `ingest_log` keeps working — it writes
-- codes from the old eight, which the new constraint accepts.
-- ===========================================================================

ALTER TABLE ingest_log
  DROP CONSTRAINT ingest_log_failure_is_a_code;

ALTER TABLE ingest_log
  ADD CONSTRAINT ingest_log_failure_is_a_code CHECK (
    failure_code IS NULL
    OR failure_code IN (
      'auth_expired', 'rate_limited', 'provider_error', 'parse_failed',
      'budget_exhausted', 'cancelled', 'fleet_auth_failed', 'embed_unavailable',
      'embed_key_unavailable', 'embed_transport_failed'
    )
  );

COMMENT ON CONSTRAINT ingest_log_failure_is_a_code ON ingest_log IS
  'registry — the alphabet src/ingest/log.ts:INGEST_FAILURE_CODES names, restated so a code this database has never heard of is refused at the write rather than rendered at a user. test/ingest/log.test.ts inserts every code in that constant and fails if one is missing here.';
