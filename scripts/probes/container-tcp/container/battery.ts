/**
 * The session-semantics battery.
 *
 * WHY A TCP HANDSHAKE IS NOT THE ANSWER
 * -------------------------------------
 * KTD2 does not rest on "a socket opened". It rests on pooled TCP, prepared
 * statements, a per-tenant `postgres.js` connection LRU and `SET LOCAL`
 * discipline for GUCs. Every one of those is a claim about a *session* being
 * held across round trips. A half-open socket, a transparent proxy, or a
 * connection silently re-established per statement would all pass a handshake
 * check and then fail the thing the architecture actually needs.
 *
 * So the same battery runs over all three channels, and its result — not
 * reachability — is what decides the verdict:
 *
 *   set_local_readback   `SET LOCAL` inside an explicit transaction is visible
 *                        to the next statement. Proves the two statements share
 *                        a session.
 *   same_backend_in_txn  `pg_backend_pid()` is unchanged inside the
 *                        transaction. Proves it is the same *backend*, not just
 *                        a connection that happens to answer.
 *   local_scoped_out     after COMMIT the GUC is gone. Proves the value was
 *                        transaction-scoped rather than sticky global state,
 *                        which is the property `SET LOCAL hnsw.ef_search`
 *                        depends on for per-request tuning.
 *   prepared_statement   a named prepared statement created by one statement is
 *                        executed by a later one.
 *
 * WHY SQL-LEVEL `PREPARE`/`EXECUTE`
 * ---------------------------------
 * `postgres.js` uses protocol-level named statements (Parse/Bind/Execute).
 * SQL-level `PREPARE`/`EXECUTE` proves the identical underlying property — a
 * named statement persisting in backend session state between round trips — and
 * needs no extended-query implementation to get wrong. If SQL-level PREPARE
 * survives on a transport, protocol-level prepared statements do too.
 *
 * A NOTE ON POOLERS
 * -----------------
 * Every assertion above is deliberately false under PgBouncer transaction
 * pooling, which is why the runner refuses a `-pooler` DSN. That refusal is a
 * correctness control, not a convenience: a pooler endpoint would fail this
 * battery on a working raw TCP connection and report (b) or (c) when the answer
 * is (a).
 */

import { firstCell, type QueryResult, type SqlChannel } from './pg-wire.ts';
import type { Redactor, StageResult, StageStatus } from './report.ts';

export interface BatteryAssertions {
  selectOne: boolean;
  setLocalReadback: boolean;
  sameBackendInTxn: boolean;
  localScopedOut: boolean;
  preparedStatement: boolean;
}

export interface BatteryResult {
  stages: StageResult[];
  assertions: BatteryAssertions;
  /** All four session assertions held. This is what the verdict reads. */
  sessionSemantics: boolean;
  authenticated: boolean;
}

export interface BatteryOptions {
  /** Prefix for stage ids, e.g. `tcp`. */
  prefix: string;
  /**
   * False for the one-shot HTTP channel, where losing the session is the
   * expected and informative outcome rather than a failure.
   */
  expectSession: boolean;
  redact: Redactor;
}

export async function runSessionBattery(
  channel: SqlChannel,
  options: BatteryOptions,
): Promise<BatteryResult> {
  const stages: StageResult[] = [];
  const assertions: BatteryAssertions = {
    selectOne: false,
    setLocalReadback: false,
    sameBackendInTxn: false,
    localScopedOut: false,
    preparedStatement: false,
  };

  // Fresh per run, so a stale value from an earlier run can never satisfy a
  // readback, and so concurrent runs cannot alias.
  const nonce = `probe-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  const statementName = `brainz_probe_ps_${Math.random().toString(36).slice(2, 10)}`;

  const step = async (
    id: string,
    proves: string,
    fn: () => Promise<{ ok: boolean; detail: Record<string, string | number | boolean | null> }>,
    isSessionAssertion: boolean,
  ): Promise<boolean> => {
    const started = Date.now();
    try {
      const { ok, detail } = await fn();
      const status: StageStatus = ok
        ? 'ok'
        : isSessionAssertion && !options.expectSession
          ? 'expected_failure'
          : 'failed';
      stages.push({
        id: `${options.prefix}.${id}`,
        proves,
        status,
        ms: Date.now() - started,
        detail,
        error: null,
      });
      return ok;
    } catch (error) {
      const message = options.redact(error instanceof Error ? error.message : String(error));
      stages.push({
        id: `${options.prefix}.${id}`,
        proves,
        status: isSessionAssertion && !options.expectSession ? 'expected_failure' : 'failed',
        ms: Date.now() - started,
        detail: {},
        error: message,
      });
      return false;
    }
  };

  assertions.selectOne = await step(
    'select_1',
    'the channel carries a real query and a real answer, not just bytes.',
    async () => {
      const result = await channel.query('SELECT 1 AS one');
      const value = firstCell(result);
      return { ok: value === '1', detail: { returned: value } };
    },
    false,
  );

  if (!assertions.selectOne) {
    return { stages, assertions, sessionSemantics: false, authenticated: false };
  }

  let pidBefore: string | null = null;
  await step(
    'backend_pid',
    'the backend process id, recorded so a later statement can be shown to reach the same backend.',
    async () => {
      const result = await channel.query('SELECT pg_backend_pid()::text');
      pidBefore = firstCell(result);
      return { ok: pidBefore !== null, detail: { backend_pid_observed: pidBefore !== null } };
    },
    false,
  );

  await step(
    'txn_begin',
    'an explicit transaction can be opened.',
    async () => {
      const result = await channel.query('BEGIN');
      return { ok: true, detail: { command_tag: result.commandTags[0] ?? null } };
    },
    false,
  );

  await step(
    'set_local',
    'SET LOCAL is accepted inside the transaction.',
    async () => {
      // A dot-qualified custom GUC needs no extension and cannot collide with a
      // real setting, so this works on any Postgres and leaves nothing behind.
      await channel.query(`SET LOCAL brainz.probe_token = '${nonce}'`);
      return { ok: true, detail: {} };
    },
    false,
  );

  assertions.setLocalReadback = await step(
    'set_local_readback',
    'the value set by the previous statement is visible to this one — the two share a session.',
    async () => {
      // current_setting(name, true) rather than SHOW: SHOW raises
      // "unrecognized configuration parameter" when the GUC was never set,
      // which would make the one-shot HTTP channel fail for the wrong reason
      // and blur the very comparison this battery exists to make.
      const result = await channel.query(`SELECT current_setting('brainz.probe_token', true)`);
      const value = firstCell(result);
      return { ok: value === nonce, detail: { matched_nonce: value === nonce, was_empty: !value } };
    },
    true,
  );

  assertions.sameBackendInTxn = await step(
    'same_backend_in_txn',
    'the statement landed on the same backend process as before the transaction.',
    async () => {
      const result = await channel.query('SELECT pg_backend_pid()::text');
      const pidNow = firstCell(result);
      const ok = pidBefore !== null && pidNow !== null && pidNow === pidBefore;
      return { ok, detail: { same_backend: ok } };
    },
    true,
  );

  await step(
    'txn_commit',
    'the transaction commits.',
    async () => {
      const result = await channel.query('COMMIT');
      return { ok: true, detail: { command_tag: result.commandTags[0] ?? null } };
    },
    false,
  );

  assertions.localScopedOut = await step(
    'local_scoped_out',
    'after COMMIT the SET LOCAL value is gone — it was transaction-scoped, which is what per-request GUC tuning depends on.',
    async () => {
      const result = await channel.query(`SELECT current_setting('brainz.probe_token', true)`);
      const value = firstCell(result);
      // Only meaningful if the readback worked in the first place; otherwise
      // "not the nonce" is trivially true on a channel with no session at all.
      const ok = assertions.setLocalReadback && value !== nonce;
      return { ok, detail: { still_set: value === nonce, value_present: !!value } };
    },
    true,
  );

  assertions.preparedStatement = await step(
    'prepared_statement',
    'a named prepared statement created by one round trip is executable by a later one — the property the per-tenant connection LRU is built on.',
    async () => {
      await channel.query(`PREPARE ${statementName}(int) AS SELECT $1::int * 2`);
      const result = await channel.query(`EXECUTE ${statementName}(21)`);
      const value = firstCell(result);
      try {
        await channel.query(`DEALLOCATE ${statementName}`);
      } catch {
        // Cleanup only; the connection is about to be dropped anyway.
      }
      return { ok: value === '42', detail: { returned: value } };
    },
    true,
  );

  await stepEfSearch(channel, options, stages);

  const sessionSemantics =
    assertions.setLocalReadback &&
    assertions.sameBackendInTxn &&
    assertions.localScopedOut &&
    assertions.preparedStatement;

  return { stages, assertions, sessionSemantics, authenticated: assertions.selectOne };
}

/**
 * Informational only, and skipped unless the `vector` extension happens to be
 * installed in the throwaway database.
 *
 * It is here because `hnsw.ef_search` is the single most load-bearing GUC in
 * this project — pgvector defaults it to 40 and silently truncates the
 * candidate pool, a failure that presents as "our ranking is mediocre" and
 * never as an error. `SET LOCAL hnsw.ef_search` is the fix, so seeing it work
 * over the surviving transport is worth one row in the report. It never
 * influences the verdict.
 */
async function stepEfSearch(
  channel: SqlChannel,
  options: BatteryOptions,
  stages: StageResult[],
): Promise<void> {
  const started = Date.now();
  const id = `${options.prefix}.ef_search_guc`;
  const proves =
    'SET LOCAL hnsw.ef_search survives on this transport (informational; never affects the verdict).';
  try {
    const installed: QueryResult = await channel.query(
      `SELECT 1 FROM pg_extension WHERE extname = 'vector'`,
    );
    if (installed.rows.length === 0) {
      stages.push({
        id,
        proves,
        status: 'skipped',
        ms: Date.now() - started,
        detail: { reason: 'the vector extension is not installed in this database' },
        error: null,
      });
      return;
    }
    await channel.query('BEGIN');
    await channel.query('SET LOCAL hnsw.ef_search = 137');
    const readback = firstCell(await channel.query(`SELECT current_setting('hnsw.ef_search', true)`));
    await channel.query('COMMIT');
    stages.push({
      id,
      proves,
      status: readback === '137' ? 'ok' : 'failed',
      ms: Date.now() - started,
      detail: { readback },
      error: null,
    });
  } catch (error) {
    stages.push({
      id,
      proves,
      status: 'skipped',
      ms: Date.now() - started,
      detail: {},
      error: options.redact(error instanceof Error ? error.message : String(error)),
    });
  }
}
