/**
 * The connector's last attempt, in the control plane — the durable half of "the
 * poll failed, and this is why".
 *
 * `src/control/connector-health.sql` carries the argument for the placement and
 * for every column. This module is the three statements that make it usable, and
 * each one is written the way it is because the obvious version is wrong:
 *
 * **1. The write is an upsert that OVERWRITES the cause columns, including with
 * NULL.** A `COALESCE(excluded.x, existing.x)` upsert — the shape somebody
 * reaches for when they think of this as "merging what we know" — is how a
 * connector that recovered keeps a red code on the dashboard for the rest of its
 * life. The row is the *current* state of one source; the history is the
 * tenant's own `ingest_log`. `last_success_at` is the single exception, and it
 * is `GREATEST`-shaped rather than overwritten, because "it has failed since
 * March" and "it has never worked" are different emergencies.
 *
 * **2. A failure to record is never allowed to fail the job.** This is
 * observability about an attempt that has already happened; a control-plane blip
 * while writing it must not walk a healthy tenant up the retry ladder for a
 * reason that has nothing to do with their connector. So {@link
 * createControlPlaneConnectorHealth} reports the error to a sink and returns —
 * the same treatment `runner.ts` gives a store failure, for the same reason. The
 * sink is a required argument rather than an optional one: a swallow that
 * defaults to silence is how this record quietly stops being written, which is
 * the exact failure this table exists to end.
 *
 * **3. The reader opens nothing and needs no key.** `readConnectorHealth` is two
 * columns of enum and four of number and timestamp, so the web app can render a
 * cause without holding a tenant connection or the sealing key that opens a
 * connector's cursor — the same narrowing `readConnectorLinks` gets, arrived at
 * the same way: by which statements need what.
 */

import type { SQL } from 'bun';

import { INGEST_FAILURE_CODES, type IngestFailureCode } from '../ingest/log.ts';
import type {
  ConnectorAttempt,
  ConnectorHealthRecorder,
  PullOutcome,
} from '../ingest/pipedream/pull.ts';
import type { JobFailureCode } from '../worker/jobs.ts';

/** Its own advisory lock, after the connector link store's. */
export const CONNECTOR_HEALTH_LOCK_KEY = 80_120_267;

const DDL_PATH = `${import.meta.dir}/connector-health.sql`;

async function storePresent(sql: SQL): Promise<boolean> {
  const rows = (await sql`
    SELECT to_regclass('control.connector_health') IS NOT NULL AS present
  `) as unknown as { present: boolean }[];
  return rows[0]?.present === true;
}

/** The labels one enum in this file's DDL already holds, in declaration order. */
async function enumLabels(sql: SQL, typeName: string): Promise<string[]> {
  const rows = (await sql`
    SELECT enumlabel::text AS label
      FROM pg_enum
     WHERE enumtypid = ${typeName}::regtype
     ORDER BY enumsortorder
  `) as unknown as { label: string }[];
  return rows.map((row) => row.label);
}

/**
 * Teach an existing enum the labels the fleet has since learned.
 *
 * **Why this exists at all — the gap that made it necessary.**
 * {@link ensureConnectorHealthSchema} used to return the moment the table was
 * present, which is correct for a table and silently wrong for everything
 * declared beside it. The DDL is applied *once per deployment, ever*: a control
 * plane that has the table skips the file forever, so no enum in it could ever
 * gain a label. Nothing would have said so, either — the recorder swallows its
 * write errors to a sink by design, so the first attempt to store a new code
 * would have failed quietly, one connector at a time, which is exactly the
 * silence `control.connector_health` exists to end.
 *
 * So the create is now the conditional half and this is unconditional.
 *
 * **`ADD VALUE` rather than a recreate.** A Postgres enum cannot have a label
 * inserted in the middle without dropping the type, and dropping it means
 * dropping the columns typed by it. Appending is the only additive move, which
 * is why the TypeScript constants this mirrors are append-only too — a label
 * added in their middle would order differently here.
 *
 * Each `ALTER` is its own statement, outside any transaction this function
 * opens: Postgres refuses to *use* a value added in the current transaction,
 * and the first thing the caller does with it is store a row. Missing labels
 * are added in the constant's own order so a deployment several labels behind
 * ends up with the same sequence as a fresh one.
 *
 * Fail-open on a lost race and fail-closed on anything else: two instances
 * booting together can both see a label missing, and the loser's `ADD VALUE …
 * IF NOT EXISTS` is a no-op rather than an error — but a permission failure or
 * a missing type is a deployment that cannot record a cause, and that must
 * crash-loop visibly rather than answer a dashboard with a swallowed error.
 */
async function ensureEnumLabels(
  sql: SQL,
  typeName: string,
  labels: readonly string[],
): Promise<void> {
  const present = new Set(await enumLabels(sql, typeName));
  for (const label of labels) {
    if (present.has(label)) continue;
    // **Interpolated, because Postgres refuses a bind parameter here.**
    // `ALTER TYPE` is a utility statement; `$1` is a syntax error in it, not a
    // placeholder. Both operands are this repo's own frozen constants rather
    // than anything a request can reach — but the check is written anyway,
    // because "it cannot be input" is a property of today's callers and the
    // anchored alphabet is a property of the statement.
    if (!/^[a-z][a-z0-9_]*$/.test(label)) {
      throw new Error(`refusing to add an unusable enum label to ${typeName}`);
    }
    try {
      await sql.unsafe(`ALTER TYPE ${typeName} ADD VALUE IF NOT EXISTS '${label}'`);
    } catch (error) {
      // A lost race is a no-op; anything else is a deployment that cannot
      // record a cause, and must crash-loop visibly.
      if (!(await enumLabels(sql, typeName)).includes(label)) throw error;
    }
  }
}

/**
 * Create the table if this deployment does not have it yet, then bring its
 * vocabularies up to what this release can produce.
 *
 * Idempotent and advisory-locked, and the catch-and-re-ask is the shape
 * `secret-pg.ts` settled: two instances racing the catalog check can both pass
 * it, and the loser's `CREATE` fails on a type the winner just made.
 */
export async function ensureConnectorHealthSchema(sql: SQL): Promise<void> {
  if (!(await storePresent(sql))) {
    const ddl = await Bun.file(DDL_PATH).text();
    try {
      await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(${CONNECTOR_HEALTH_LOCK_KEY})`;
        if (await storePresent(tx)) return;
        await tx.unsafe(ddl);
      });
    } catch (error) {
      if (!(await storePresent(sql))) throw error;
    }
  }

  // Unconditional, and after the create rather than inside it: a deployment
  // that already had the table is precisely the one whose enum is behind.
  await ensureEnumLabels(sql, 'control.connector_ingest_failure', INGEST_FAILURE_CODES);
}

/**
 * The recorder the pull handler is given.
 *
 * `onError` receives anything the write itself throws. Production hands it the
 * fleet's stderr sink; a test hands it a collector and asserts the write was
 * clean, which is what stops this becoming a port that silently never works.
 */
export function createControlPlaneConnectorHealth(
  sql: SQL,
  onError: (error: unknown) => void,
): ConnectorHealthRecorder {
  return {
    async record(attempt: ConnectorAttempt): Promise<void> {
      try {
        await sql`
          INSERT INTO control.connector_health (
            tenant_id, source, last_attempt_at, last_success_at,
            run_outcome, ingest_failure_code, job_failure_code,
            items_written, items_failed, updated_at
          ) VALUES (
            ${attempt.tenantId},
            ${attempt.source}::control.connector_health_source,
            ${attempt.at},
            ${attempt.runOutcome === 'completed' ? attempt.at : null},
            ${attempt.runOutcome}::control.connector_run_outcome,
            ${attempt.ingestFailureCode}::control.connector_ingest_failure,
            ${attempt.jobFailureCode}::control.connector_job_failure,
            ${attempt.itemsWritten}, ${attempt.itemsFailed}, ${attempt.at}
          )
          ON CONFLICT (tenant_id, source) DO UPDATE
             SET last_attempt_at     = ${attempt.at},
                 -- The one column a later attempt may not clear. GREATEST over
                 -- the stored value so an out-of-order write — a retry landing
                 -- after the run it superseded — cannot move it backwards.
                 last_success_at     = CASE
                   WHEN ${attempt.runOutcome === 'completed'}::boolean
                   THEN greatest(control.connector_health.last_success_at, ${attempt.at})
                   ELSE control.connector_health.last_success_at
                 END,
                 -- Overwritten, NULL included. See the header: a coalescing
                 -- upsert here is a red line nobody can clear.
                 run_outcome         = ${attempt.runOutcome}::control.connector_run_outcome,
                 ingest_failure_code = ${attempt.ingestFailureCode}::control.connector_ingest_failure,
                 job_failure_code    = ${attempt.jobFailureCode}::control.connector_job_failure,
                 items_written       = ${attempt.itemsWritten},
                 items_failed        = ${attempt.itemsFailed},
                 updated_at          = ${attempt.at}`;
      } catch (error) {
        // Never rethrown. The attempt this describes has already happened, and
        // failing the job over the record of it would turn a control-plane blip
        // into a tenant's connector walking the retry ladder.
        onError(error);
      }
    },
  };
}

/**
 * What one tenant's connectors last did.
 *
 * Every field is a code, a count or an instant — there is nothing on this type
 * that could carry a word a user wrote, which is what lets the dashboard and
 * `/admin` both render a cause without either of them holding a tenant handle.
 */
export interface ConnectorHealthView {
  readonly source: string;
  readonly lastAttemptAt: Date;
  readonly lastSuccessAt: Date | null;
  readonly runOutcome: PullOutcome | null;
  readonly ingestFailureCode: IngestFailureCode | null;
  readonly jobFailureCode: JobFailureCode | null;
  readonly itemsWritten: number;
  readonly itemsFailed: number;
}

/**
 * The cause, whichever layer knew it.
 *
 * The run's own code wins when there is one: `handler_error` on a job whose pull
 * reached the provider and was refused is the runner reporting that a handler
 * threw, which is true and is not the answer anybody wants. `null` means the
 * last attempt had nothing to explain.
 */
export function causeOf(health: ConnectorHealthView | undefined): string | null {
  if (health === undefined) return null;
  return health.ingestFailureCode ?? health.jobFailureCode ?? null;
}

export async function readConnectorHealth(
  sql: SQL,
  request: { readonly tenantId: string },
): Promise<ReadonlyMap<string, ConnectorHealthView>> {
  const rows = (await sql`
    SELECT source::text              AS source,
           last_attempt_at,
           last_success_at,
           run_outcome::text         AS run_outcome,
           ingest_failure_code::text AS ingest_failure_code,
           job_failure_code::text    AS job_failure_code,
           items_written,
           items_failed
      FROM control.connector_health
     WHERE tenant_id = ${request.tenantId}
  `) as unknown as {
    source: string;
    last_attempt_at: Date;
    last_success_at: Date | null;
    run_outcome: string | null;
    ingest_failure_code: string | null;
    job_failure_code: string | null;
    items_written: number;
    items_failed: number;
  }[];

  const health = new Map<string, ConnectorHealthView>();
  for (const row of rows) {
    health.set(row.source, {
      source: row.source,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      // The columns are enums, so these are narrowings rather than validations —
      // but they are casts either way, and a cast is the one place a label the
      // rest of the fleet has never heard of could reach a rendered page.
      runOutcome: (row.run_outcome as PullOutcome | null) ?? null,
      ingestFailureCode: (row.ingest_failure_code as IngestFailureCode | null) ?? null,
      jobFailureCode: (row.job_failure_code as JobFailureCode | null) ?? null,
      itemsWritten: row.items_written,
      itemsFailed: row.items_failed,
    });
  }
  return health;
}
