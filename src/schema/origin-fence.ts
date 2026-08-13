/**
 * R15's fence, attested rather than assumed.
 *
 * `migrations/v2-knowledge-core.sql` says origin is immutable and enforces it
 * with one trigger function attached to every origin column. That holds against
 * every DML shape an adversarial review could find — `UPDATE`, the `ON CONFLICT
 * DO UPDATE` path, `COPY`, and an `ALTER COLUMN TYPE` rewrite (which Postgres
 * refuses outright because `BEFORE UPDATE OF <column>` registers a catalog
 * dependency on the column).
 *
 * It does **not** hold against DDL, and that is what this module is for. The
 * tenant role owns its own tables (`src/control/provision.ts` creates the
 * database with `owner_name: roleName`, one role for schema and requests alike),
 * so two single statements defeat the whole fence across every table at once:
 *
 *   * `CREATE OR REPLACE FUNCTION refuse_origin_change() … RETURN NEW;` — the
 *     seven triggers still exist, still read correctly in `pg_get_triggerdef`,
 *     and no longer do anything. A catalog guard sees nothing wrong.
 *   * `ALTER TABLE … DISABLE TRIGGER …` — the row is mutated permanently and the
 *     trigger is re-enabled afterwards, leaving a clean catalog behind it.
 *
 * So the fence is checked two ways, because each is blind to the other's
 * failure:
 *
 *   * {@link findOriginFenceViolations} reads the catalog and requires every
 *     origin column to carry an **enabled** `BEFORE UPDATE OF` trigger calling
 *     the shared function *with that column's own name as its argument*. This is
 *     what sees a disabled or dropped trigger. It cannot see a neutered function
 *     body.
 *   * {@link assertOriginFence} additionally makes the function *prove itself*:
 *     it attaches the real trigger to a throwaway temp table, issues the update
 *     the fence exists to refuse, and fails if `BZ001` does not come back. This
 *     is what sees a neutered body. It cannot see a per-table disable.
 *
 * **Where this runs, and what that buys.** `src/control/migrate.ts` calls it
 * inside each rung's own transaction, so a migration that breaks the fence rolls
 * back and is never recorded — the shape review 03 found passing both the
 * expand/contract scanner and the frozen fleet surface. It also runs at the end
 * of every `migrateTenantSchema`, which is what every wake of a behind tenant and
 * every provision goes through, so a tenant whose fence was tampered with out of
 * band fails the next time anything migrates it rather than serving quietly.
 *
 * **The residual, stated.** A tenant already at head that nothing migrates is
 * not re-checked, and the tenant credential can still disable a trigger between
 * two checks. Closing that needs either a second role (Neon gives the tenant
 * database one owner) or a periodic fleet-side attestation — this module exports
 * the attestation so that sweep can be written; it does not pretend to be one.
 */

import type { SQL, TransactionSQL } from 'bun';

/**
 * The rung that introduces the fence. Rung one is chunk storage: it declares
 * `origin_context` and no trigger, so asserting the fence over a v1 tenant would
 * fail for a reason that is not tampering.
 */
export const ORIGIN_FENCE_SINCE = 2;

/** The two spellings of origin — scalar for ingested rows, union for derived. */
export const ORIGIN_COLUMNS = ['origin_context', 'origin_contexts'] as const;

/** The one function every origin trigger calls. */
export const ORIGIN_TRIGGER_FUNCTION = 'refuse_origin_change';

/** What the fence raises. The write path answers `scope_denied` on this code. */
export const ORIGIN_IMMUTABLE_SQLSTATE = 'BZ001';

/** What this module raises when the fence itself is gone. */
export const ORIGIN_FENCE_BROKEN_SQLSTATE = 'BZ004';

export class OriginFenceError extends Error {
  readonly findings: readonly string[];

  constructor(findings: readonly string[]) {
    super(
      `R15's origin fence is not enforced on this tenant: ${findings.join('; ')}. Access is fenced on origin alone (KTD5), so an origin that can move is a privilege-escalation primitive rather than a data-quality nit.`,
    );
    this.name = 'OriginFenceError';
    this.findings = findings;
  }
}

/**
 * Every origin column whose trigger is missing, disabled, or attached wrong.
 *
 * `tgenabled` is the column that matters and the one a `pg_get_triggerdef`-based
 * guard cannot see: a disabled trigger still renders as a perfectly correct
 * `CREATE TRIGGER` statement. The argument is checked too — the shared function
 * reads `TG_ARGV[0]` to decide which field to compare, so a trigger attached to
 * `origin_contexts` while passing `'origin_context'` compares a field that does
 * not exist and refuses nothing.
 */
export async function findOriginFenceViolations(
  sql: SQL | TransactionSQL,
): Promise<string[]> {
  // `unsafe` with no caller input: every interpolation below is a constant
  // declared in this file. The alternative — binding the column list — would put
  // the regexes through a parameter, and the escaping of a regex that has to
  // match a quoted SQL argument is exactly the kind of detail that silently
  // matches nothing and turns this whole function green.
  const originColumns = ORIGIN_COLUMNS.map((column) => `'${column}'`).join(', ');
  const rows = await sql.unsafe<{ table_name: string; column_name: string; fenced: boolean }[]>(`
    SELECT c.relname AS table_name,
           a.attname AS column_name,
           EXISTS (
             SELECT 1
             FROM pg_trigger t
             WHERE t.tgrelid = c.oid
               AND NOT t.tgisinternal
               -- 'D' is DISABLED. The one bit of trigger state that does not
               -- show up in the trigger's own definition text.
               AND t.tgenabled <> 'D'
               AND pg_get_triggerdef(t.oid) ~ ('BEFORE UPDATE OF ' || a.attname || ' ON ')
               AND pg_get_triggerdef(t.oid) ~
                   ('${ORIGIN_TRIGGER_FUNCTION}\\(''' || a.attname || '''\\)')
           ) AS fenced
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attname IN (${originColumns})
    ORDER BY c.relname, a.attname
  `);

  const findings = rows
    .filter((row) => !row.fenced)
    .map(
      (row) =>
        `${row.table_name}.${row.column_name}: no enabled BEFORE UPDATE OF trigger calling ${ORIGIN_TRIGGER_FUNCTION}('${row.column_name}')`,
    );

  // A schema with no origin columns at all would otherwise report a clean sheet,
  // which is the vacuous pass this whole file exists to refuse.
  if (rows.length === 0) {
    findings.push(
      'no origin column found in this database — either the schema is not applied or R15 has been removed wholesale',
    );
  }

  return findings;
}

/**
 * The behavioural half: make the shared function refuse a change, here and now.
 *
 * A temp table rather than a real row, so the attestation can run inside a
 * migration's own transaction without writing to user data and without needing
 * one of every content row to exist. `ON COMMIT DROP` because it must not
 * survive into the session that follows, and the whole thing is one statement so
 * it costs one round trip. The `EXCEPTION` block is what lets a *failed* update
 * be the success condition without aborting the caller's transaction.
 */
const FENCE_PROBE = `
DO $origin_fence_probe$
DECLARE refused boolean := false;
BEGIN
  CREATE TEMP TABLE origin_fence_probe (origin_context text NOT NULL, payload integer) ON COMMIT DROP;
  CREATE TRIGGER origin_fence_probe_guard
    BEFORE UPDATE OF origin_context ON origin_fence_probe
    FOR EACH ROW EXECUTE FUNCTION ${ORIGIN_TRIGGER_FUNCTION}('origin_context');

  INSERT INTO origin_fence_probe (origin_context, payload) VALUES ('personal', 1);
  BEGIN
    UPDATE origin_fence_probe SET origin_context = 'work';
  EXCEPTION WHEN SQLSTATE '${ORIGIN_IMMUTABLE_SQLSTATE}' THEN refused := true;
  END;

  IF NOT refused THEN
    RAISE EXCEPTION
      '${ORIGIN_TRIGGER_FUNCTION}() no longer refuses an origin change: every origin trigger in this database is attached to a function that returns NEW unconditionally (R15)'
      USING ERRCODE = '${ORIGIN_FENCE_BROKEN_SQLSTATE}',
            HINT = 'CREATE OR REPLACE FUNCTION on the shared trigger function disables the fence on every table at once and leaves every trigger definition reading correctly';
  END IF;
END
$origin_fence_probe$`;

/**
 * Both halves, in one call. Throws {@link OriginFenceError} on the catalog half
 * and lets the probe's own `BZ004` propagate — the two failures want different
 * words, because one means "a table lost its trigger" and the other means "every
 * table lost its trigger at once and the catalog still says otherwise".
 */
export async function assertOriginFence(sql: SQL | TransactionSQL): Promise<void> {
  const findings = await findOriginFenceViolations(sql);
  if (findings.length > 0) throw new OriginFenceError(findings);
  await sql.unsafe(FENCE_PROBE);
}
