/**
 * The control plane's migration rung for `control.job_kind`.
 *
 * ============================================================================
 * WHY A FILE EXISTS FOR ONE ENUM VALUE
 * ============================================================================
 *
 * A tenant database has a ladder: `src/schema/migrations.ts` numbers every rung,
 * `src/control/migrate.ts` applies them under a per-tenant advisory lock, and the
 * control-plane row records how far each tenant has climbed. **The control plane
 * itself has none of that.** `src/control/schema.sql` builds one from nothing,
 * and it is run exactly once — when a deployment's control database is created.
 * Every value added to that file afterwards reaches new installs and no existing
 * deployment, silently, because nothing anywhere compares the two.
 *
 * So the house pattern for evolving a live control plane is an idempotent
 * `ensure*` called at boot: `ensureSecretStoreSchema`, `ensureAuthorizationStoreSchema`,
 * `ensureConnectorLinkSchema`, `ensureConnectorHealthSchema`. This is the same
 * shape applied to a *change* rather than to a new table, and it is the first of
 * those. Without it, `JOB_KINDS` gains `purge`, the enqueuer builds a row, and
 * the insert fails on a live fleet with `22P02 invalid input value for enum
 * control.job_kind` — every tick, forever, for the one lane whose whole point is
 * that a promise stops being silently unkept.
 *
 * ============================================================================
 * TWO STATEMENTS, AND WHY THEY CANNOT SHARE A TRANSACTION
 * ============================================================================
 *
 * **1. The enum value.** `ALTER TYPE … ADD VALUE` may run inside a transaction,
 * but the value it adds **cannot be used** by anything else in that same
 * transaction — and the CHECK below uses it, because `kind = 'purge'` coerces
 * that literal to the enum at DDL-parse time. So the two steps are two
 * transactions, in this order, and no amount of tidying may merge them.
 *
 * **2. The CHECK.** `job_target_suits_its_kind` enumerates the legal
 * kind/target pairings, so a new kind is refused by it until it is rewritten.
 * The rewrite is `DROP` + `ADD … NOT VALID` + `VALIDATE`: a plain `ADD
 * CONSTRAINT` takes `ACCESS EXCLUSIVE` and scans every row in `control.job`
 * while holding it, which on a fleet's queue table is a stall on the one lock
 * every enqueue needs. `NOT VALID` skips the scan and still enforces the
 * constraint on new rows; `VALIDATE` then takes the weaker `SHARE UPDATE
 * EXCLUSIVE` and checks the existing ones.
 *
 * ============================================================================
 * IDEMPOTENCE IS THE CONTRACT; THE LOCK IS ONLY FOR THE HALF THAT NEEDS IT
 * ============================================================================
 *
 * Three fleets deploy at once and each has several processes, so concurrent
 * calls are ordinary rather than exotic. Step 1 needs no lock: `ADD VALUE IF NOT
 * EXISTS` is idempotent by its own definition. Step 2 is a drop-then-add, which
 * is not, so it runs under `pg_advisory_xact_lock` with the presence check
 * repeated inside — and the whole thing is still wrapped in the
 * catch-and-re-probe `ensureSecretStoreSchema` settled on, for the reason stated
 * there: a transaction that has already issued a statement can evaluate its
 * catalog re-check against a view older than the winner's commit, so the loser's
 * refusal is answered with a question (*is it there now?*) rather than a guess.
 */

import type { SQL, TransactionSQL } from 'bun';

/**
 * The lock every process racing this rung contends on.
 *
 * A distinct number from the other `ensure*` keys, because two rungs blocking
 * each other at boot is a slow start for no reason. It is written here rather
 * than derived from a name so it is greppable.
 */
const JOB_KIND_LOCK_KEY = 8_311_402;

/**
 * The kind this rung adds, and the whole reason it exists.
 *
 * Written as a constant so the enum value, the CHECK expression and the probe
 * cannot spell it three different ways.
 */
const ADDED_KIND = 'purge';

/**
 * The pairing rule, in the exact words `src/control/schema.sql` uses.
 *
 * **The duplication is real and it is the point.** A fresh install gets this
 * rule from `schema.sql`; a live deployment gets it from here. There is no third
 * place to put it that both reach, because one runs against an empty database
 * and the other against a populated one. What keeps them from drifting is a test
 * rather than a comment: `test/worker/purge-job.test.ts` builds a control plane
 * from a `schema.sql` with this rung's changes stripped back out, applies this
 * migration, and then inserts every pairing `LEGAL_TARGETS` declares.
 */
const JOB_TARGET_SUITS_ITS_KIND = `(
    (kind = 'consolidate' AND target = 'whole_brain')
    OR (kind = 'export' AND target = 'whole_brain')
    OR (kind = 're_embed' AND target = 'whole_brain')
    OR (kind = 'purge' AND target = 'whole_brain')
    OR (kind = 'ingest_pull' AND target IN ('gmail', 'calendar', 'drive'))
    OR (kind = 'import' AND target IN ('chat_export', 'folder'))
  )`;

/**
 * Bring a live control plane's job vocabulary up to what this release enqueues.
 *
 * Called from the worker fleet's boot, beside the other `ensure*` calls, and for
 * the same reason they are called there rather than on first use: a fleet that
 * cannot reach the shape it needs must crash-loop visibly, not discover it one
 * failed enqueue at a time on a tick nobody is reading.
 */
export async function ensurePurgeJobKind(sql: SQL): Promise<void> {
  await ensureEnumValue(sql);
  await ensureTargetCheck(sql);
}

/**
 * Step 1. Its own transaction, because the CHECK in step 2 uses the value.
 *
 * The probe first, so the ordinary case — every boot after the first — is one
 * `SELECT` against `pg_enum` and no DDL at all.
 */
async function ensureEnumValue(sql: SQL): Promise<void> {
  if (await enumValuePresent(sql)) return;
  try {
    // Outside any transaction this module opens: `ADD VALUE` is idempotent under
    // `IF NOT EXISTS`, so the concurrent case needs no lock, and keeping it out
    // of a transaction is also what lets step 2 use the value it added.
    await sql.unsafe(`ALTER TYPE control.job_kind ADD VALUE IF NOT EXISTS '${ADDED_KIND}'`);
  } catch (error) {
    // A fresh statement, so this sees whatever a racing process committed. The
    // contract is the goal state, not which process reached it.
    if (!(await enumValuePresent(sql))) throw error;
  }
}

/** Step 2. Under the lock, because a drop-then-add is not idempotent. */
async function ensureTargetCheck(sql: SQL): Promise<void> {
  if (await targetCheckAdmitsKind(sql)) return;
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${JOB_KIND_LOCK_KEY})`;
      if (await targetCheckAdmitsKind(tx)) return;
      // `NOT VALID` so this does not scan `control.job` under ACCESS EXCLUSIVE.
      // Dropping first is what makes the pair re-runnable after a partial
      // failure; `IF EXISTS` is what makes it survive a control plane that
      // somehow never had the constraint.
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
    if (!(await targetCheckAdmitsKind(sql))) throw error;
  }
}

async function enumValuePresent(sql: SQL | TransactionSQL): Promise<boolean> {
  const rows = (await sql`
    SELECT EXISTS (
      SELECT 1
        FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        JOIN pg_namespace n ON n.oid = t.typnamespace
       WHERE n.nspname = 'control' AND t.typname = 'job_kind' AND e.enumlabel = ${ADDED_KIND}
    ) AS present
  `) as Array<{ present: boolean }>;
  return rows[0]?.present === true;
}

/**
 * Whether the pairing CHECK has heard of the kind.
 *
 * Read off `pg_get_constraintdef` rather than off a version column, because
 * there is no version column — the control plane has no ledger, which is the
 * whole reason this file exists. The definition is the truth about what the
 * database will accept, and asking it directly is the only probe that cannot be
 * wrong about a deployment somebody patched by hand.
 */
async function targetCheckAdmitsKind(sql: SQL | TransactionSQL): Promise<boolean> {
  const rows = (await sql`
    SELECT pg_get_constraintdef(c.oid) LIKE ${`%${ADDED_KIND}%`} AS present
      FROM pg_constraint c
     WHERE c.conname = 'job_target_suits_its_kind'
       AND c.conrelid = 'control.job'::regclass
  `) as Array<{ present: boolean }>;
  return rows[0]?.present === true;
}
