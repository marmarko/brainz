/**
 * Teaching a **live** control plane a connector it was built without.
 *
 * `src/control/schema.sql`, `connector-store.sql` and `connector-health.sql`
 * build a control plane from nothing and are each run **once, ever**. A label
 * added to one of their enums therefore reaches every fresh install and **no
 * running deployment** — and the control plane has no migration ledger, which
 * is the whole reason files like this one exist (`job-kinds.ts` is the
 * precedent, and this is modelled on it line for line).
 *
 * Three enums and one CHECK stand between a fourth connector and a live plane,
 * and they fail in three different ways — one loud, two quiet:
 *
 *   * **`control.connector_source`** — `markConnectPending`, `fenceConnectorLink`
 *     and `adopt` all cast `${source}::control.connector_source`. Missing label,
 *     `22P02`, and the user's connect button answers 500. Loud, at least.
 *   * **`control.job_target`** and **`job_target_suits_its_kind`** — the
 *     `ingest_pull` enqueue is refused, so a connector that *did* link never
 *     polls. Quieter: nothing is obviously broken, the source simply never
 *     produces anything.
 *   * **`control.connector_health_source`** — and this is the dangerous one.
 *     `recordConnectorAttempt` swallows its own errors **by design**, because a
 *     health write must never be able to fail a pull. So a missing label here
 *     produces a connector that polls perfectly well and a dashboard that shows
 *     nothing about it, forever, with the cause on stdout and nowhere else.
 *
 * Called from **both** composition roots, unlike `ensurePurgeJobKind` which the
 * worker alone needs: `markConnectPending` runs in the web fleet, so a web
 * instance that booted against an untaught plane would answer the connect
 * button with a cast error no matter how healthy the worker was.
 */

import type { SQL, TransactionSQL } from 'bun';

import { CONNECTOR_SOURCES } from '../ingest/cursor.ts';

/**
 * Its own key, not `job-kinds.ts`'s.
 *
 * Two boot rungs sharing an advisory key would serialise against each other for
 * no reason, and — since both fleets run both — would make a slow VALIDATE in
 * one of them a boot delay in the other.
 */
const CONNECTOR_LABEL_LOCK_KEY = 8_311_403;

/**
 * The enums that must know every connector, and the column each is worn by.
 *
 * Kept as data rather than three near-identical functions so that a fifth
 * connector is a label in `CONNECTOR_SOURCES` and nothing here at all.
 */
const LABELLED_ENUMS: ReadonlyArray<{ readonly type: string; readonly why: string }> = [
  { type: 'connector_source', why: 'the connect button casts to it' },
  { type: 'connector_health_source', why: 'the health recorder swallows its own errors' },
  { type: 'job_target', why: 'the ingest_pull enqueue names it' },
];

/**
 * `job_target_suits_its_kind`, restated — the fourth copy of this predicate in
 * the tree, and the comment `job-kinds.ts` carries about that applies here too:
 * a pairing the code allows and the CHECK refuses is a constraint violation
 * raised on a live enqueue, which is the worst place to find a disagreement.
 */
const INGEST_PULL_TARGETS = CONNECTOR_SOURCES.map((source) => `'${source}'`).join(', ');
const JOB_TARGET_SUITS_ITS_KIND = `(
    (kind = 'consolidate' AND target = 'whole_brain')
    OR (kind = 'export' AND target = 'whole_brain')
    OR (kind = 're_embed' AND target = 'whole_brain')
    OR (kind = 'purge' AND target = 'whole_brain')
    OR (kind = 'ingest_pull' AND target IN (${INGEST_PULL_TARGETS}))
    OR (kind = 'import' AND target IN ('chat_export', 'folder'))
  )`;

export async function ensureConnectorLabels(sql: SQL): Promise<void> {
  for (const enumeration of LABELLED_ENUMS) {
    for (const source of CONNECTOR_SOURCES) {
      await ensureLabel(sql, enumeration.type, source);
    }
  }
  await ensureTargetCheck(sql);
}

/**
 * One label, on one enum.
 *
 * The probe first, so the ordinary case — every boot after the first — is one
 * `SELECT` against `pg_enum` and no DDL at all. `ADD VALUE` runs outside any
 * transaction this module opens: it is idempotent under `IF NOT EXISTS`, so the
 * concurrent case needs no lock, and keeping it out of a transaction is also
 * what lets the CHECK below use a value that was just added.
 *
 * The interpolation is safe by construction and not by inspection:
 * `CONNECTOR_SOURCES` is a `readonly [...]` of string literals and the type
 * names are literals in this file. Nothing here is reachable from a request.
 */
async function ensureLabel(sql: SQL, type: string, label: string): Promise<void> {
  if (await labelPresent(sql, type, label)) return;
  try {
    await sql.unsafe(`ALTER TYPE control.${type} ADD VALUE IF NOT EXISTS '${label}'`);
  } catch (error) {
    // A fresh statement, so this sees whatever a racing process committed. The
    // contract is the goal state, not which process reached it.
    if (!(await labelPresent(sql, type, label))) throw error;
  }
}

async function labelPresent(sql: SQL | TransactionSQL, type: string, label: string): Promise<boolean> {
  const rows = (await sql`
    SELECT EXISTS (
      SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'control' AND t.typname = ${type} AND e.enumlabel = ${label}
    ) AS present
  `) as Array<{ present: boolean }>;
  return rows[0]?.present === true;
}

/** Under the lock, because a drop-then-add is not idempotent. */
async function ensureTargetCheck(sql: SQL): Promise<void> {
  if (await targetCheckAdmitsEvery(sql)) return;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${CONNECTOR_LABEL_LOCK_KEY})`;
      if (await targetCheckAdmitsEvery(tx)) return;
      // `NOT VALID` so this does not scan `control.job` under ACCESS EXCLUSIVE.
      // Dropping first is what makes the pair re-runnable after a partial
      // failure; `IF EXISTS` is what makes it survive a plane that somehow
      // never had the constraint.
      await tx.unsafe(`
        ALTER TABLE control.job DROP CONSTRAINT IF EXISTS job_target_suits_its_kind;
        ALTER TABLE control.job ADD CONSTRAINT job_target_suits_its_kind
          CHECK ${JOB_TARGET_SUITS_ITS_KIND} NOT VALID;
      `);
    });
    // Outside the transaction above: `VALIDATE` takes SHARE UPDATE EXCLUSIVE and
    // scans, and holding that inside the same transaction as the ADD would put
    // the scan back under the lock the NOT VALID was chosen to avoid.
    await sql.unsafe('ALTER TABLE control.job VALIDATE CONSTRAINT job_target_suits_its_kind');
  } catch (error) {
    if (!(await targetCheckAdmitsEvery(sql))) throw error;
  }
}

/**
 * Whether the pairing CHECK has heard of every connector.
 *
 * Read off `pg_get_constraintdef` rather than off a version column, because the
 * control plane has no version column — which is the reason this file exists.
 * The definition is the truth about what the database will accept.
 */
async function targetCheckAdmitsEvery(sql: SQL | TransactionSQL): Promise<boolean> {
  const rows = (await sql`
    SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'control' AND t.relname = 'job' AND c.conname = 'job_target_suits_its_kind'
  `) as Array<{ definition: string }>;
  const definition = rows[0]?.definition;
  if (definition === undefined) return false;
  return CONNECTOR_SOURCES.every((source) => definition.includes(`'${source}'`));
}
