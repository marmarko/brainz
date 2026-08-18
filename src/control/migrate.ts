/**
 * Migration runner v0 — U3 approach step 4.
 *
 * The shape of the problem is not "apply DDL". It is: tens of thousands of
 * mostly-suspended databases, each of which must reach the version the fleet
 * understands before it serves a request, while several stateless instances may
 * wake the same tenant at the same moment and while a rolling deploy has two
 * fleet versions live at once.
 *
 * Four decisions follow from that, and each one is load-bearing.
 *
 * **1. The tenant database is the truth; the control-plane row is the index.**
 * `schema_version` lives on the control-plane row (U2 put it there) and that is
 * what the scheduler and the request path read. But the only place a version can
 * be recorded *atomically with the DDL it describes* is inside the tenant's own
 * transaction — Postgres DDL is transactional, so a rung and its ledger row
 * commit together or not at all. A ledger in the tenant and an index in the
 * control plane cannot drift into a state where the tenant is migrated and
 * nobody knows: the next wake re-reads the tenant and re-banks the number.
 * Banking the other way round — control plane first — is what produces a row
 * claiming v2 over a database that is still v1.
 *
 * **2. One advisory lock per tenant database, taken inside the transaction.**
 * Two instances waking one suspended tenant is the ordinary case here, not the
 * exotic one. `pg_advisory_xact_lock` releases on commit or rollback with no
 * cleanup path to forget, and the version is re-read *after* the lock so the
 * second waker sees the first waker's work and no-ops instead of replaying it.
 *
 * **3. The request path refuses a schema it does not understand.** A typed
 * error, not a best-effort query against unknown columns. Two of them, because
 * the caller's remedy differs: a tenant *behind* the fleet is migrated and
 * retried; a tenant *ahead* of it cannot be fixed by this instance at all.
 *
 * **4. Expand/contract, enforced rather than requested.** During every rolling
 * deploy old and new instances serve concurrently, so a tenant migrated by a new
 * instance and routed to an old one must still be servable — the retry loop
 * cannot resolve that case, because the old instance never will understand a
 * version its code has not shipped. Hence: deploy first, migrate second (the
 * ordering rule, checkable as data by {@link findRolloutViolations}), and every
 * rung additive-only so the previous release's statements keep working
 * ({@link findExpandContractViolations}, plus the frozen fleet surface in
 * `test/schema/rollout.test.ts` that runs those statements for real).
 */

import type { SQL, TransactionSQL } from 'bun';

import {
  applyFtsLanguage,
  assertFtsLanguageMatches,
  assertTextSearchConfigExists,
  needsFtsLanguage,
} from '../schema/fts-language.ts';
import {
  HEAD_SCHEMA_VERSION,
  MIGRATIONS,
  migrationsBetween,
  readMigrationDdl,
  type TenantMigration,
} from '../schema/migrations.ts';
import { ORIGIN_FENCE_SINCE, assertOriginFence } from '../schema/origin-fence.ts';
import { findIndexableDimensionViolations } from '../schema/vector-index.ts';

/**
 * The version this code migrates a tenant to, and the version it writes onto the
 * control-plane row. One number, derived from the ladder.
 */
export const FLEET_SCHEMA_VERSION = HEAD_SCHEMA_VERSION;

/**
 * How far *ahead* of its own head this release will still serve a tenant.
 *
 * Exactly one rung, and the number is licensed rather than chosen: U3's rollout
 * rule promises that every migration leaves **the previous fleet version** able
 * to serve a migrated tenant, and `test/schema/rollout.test.ts` pays for that
 * promise by running the previous release's frozen statements against a migrated
 * database. One rung of promise buys one rung of tolerance. Raising this number
 * without extending that test would be asserting compatibility nobody measured.
 *
 * Without the tolerance, the refusal below turns every rolling deploy into an
 * outage for whichever tenants a new instance migrated first.
 */
export const SCHEMA_LOOKAHEAD = 1;

/** The tenant-local ledger. Runner infrastructure, not one of U3's tables. */
export const SCHEMA_LEDGER_TABLE = 'schema_migration';

/**
 * The advisory-lock key every migrating instance takes on a tenant database.
 * A constant, because the lock is per database and a database is one tenant
 * (KTD1) — there is no tenant id to mix in and nothing else to collide with.
 */
export const SCHEMA_MIGRATION_LOCK_KEY = 80_120_263;

/** SQLSTATE Postgres raises when a concurrent `CREATE TABLE` won the race. */
const DUPLICATE_TABLE = '42P07';
const UNIQUE_VIOLATION = '23505';

function sqlstateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const errno = (error as { errno?: unknown }).errno;
  return typeof errno === 'string' ? errno : undefined;
}

// ---------------------------------------------------------------------------
// The refusal.
// ---------------------------------------------------------------------------

/** Base class so a dispatcher can catch "not servable" without listing both. */
export abstract class UnservableTenantSchemaError extends Error {
  readonly tenantSchemaVersion: number;
  readonly fleetSchemaVersion: number;
  /** Whether migrating this tenant is a remedy this instance can perform. */
  abstract readonly migratable: boolean;

  protected constructor(message: string, tenantSchemaVersion: number, fleetSchemaVersion: number) {
    super(message);
    this.tenantSchemaVersion = tenantSchemaVersion;
    this.fleetSchemaVersion = fleetSchemaVersion;
  }
}

/**
 * The tenant's schema predates what this code queries. Ordinary and expected —
 * it is what every suspended tenant looks like after a deploy. The caller
 * migrates and retries.
 */
export class TenantSchemaBehindError extends UnservableTenantSchemaError {
  override readonly migratable = true;

  constructor(tenantSchemaVersion: number, fleetSchemaVersion: number) {
    super(
      `tenant schema v${tenantSchemaVersion} is behind this fleet's v${fleetSchemaVersion}; migrate before serving`,
      tenantSchemaVersion,
      fleetSchemaVersion,
    );
    this.name = 'TenantSchemaBehindError';
  }
}

/**
 * The tenant has been migrated past anything this release can be responsible
 * for. Retrying will not help and neither will migrating: this instance is the
 * old one. It resolves when the instance is replaced, which is what
 * deploy-first-migrate-second is for.
 */
export class TenantSchemaAheadError extends UnservableTenantSchemaError {
  override readonly migratable = false;

  constructor(tenantSchemaVersion: number, fleetSchemaVersion: number, lookahead: number) {
    super(
      `tenant schema v${tenantSchemaVersion} is more than ${lookahead} rung(s) ahead of this fleet's v${fleetSchemaVersion}. This instance predates the migration and cannot serve it; deploy first, migrate second.`,
      tenantSchemaVersion,
      fleetSchemaVersion,
    );
    this.name = 'TenantSchemaAheadError';
  }
}

export interface FleetSchemaContract {
  /** The version this release migrates tenants to. */
  readonly head: number;
  /** How many rungs above `head` it will still serve. See {@link SCHEMA_LOOKAHEAD}. */
  readonly lookahead: number;
}

export const FLEET_CONTRACT: FleetSchemaContract = {
  head: FLEET_SCHEMA_VERSION,
  lookahead: SCHEMA_LOOKAHEAD,
};

export function isServableSchema(
  tenantSchemaVersion: number,
  contract: FleetSchemaContract = FLEET_CONTRACT,
): boolean {
  return (
    tenantSchemaVersion >= contract.head && tenantSchemaVersion <= contract.head + contract.lookahead
  );
}

/**
 * The request path's gate. Throws one of the two typed errors above, so a
 * dispatcher can answer "migrate and retry" or "this instance is stale" without
 * parsing a message.
 */
export function assertServableSchema(
  tenantSchemaVersion: number,
  contract: FleetSchemaContract = FLEET_CONTRACT,
): void {
  if (isServableSchema(tenantSchemaVersion, contract)) return;
  if (tenantSchemaVersion < contract.head) {
    throw new TenantSchemaBehindError(tenantSchemaVersion, contract.head);
  }
  throw new TenantSchemaAheadError(tenantSchemaVersion, contract.head, contract.lookahead);
}

// ---------------------------------------------------------------------------
// Reading where a tenant is.
// ---------------------------------------------------------------------------

async function tableExists(sql: SQL | TransactionSQL, table: string): Promise<boolean> {
  const rows = await sql<{ found: boolean }[]>`
    SELECT true AS found
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ${table}
  `;
  return rows.length > 0;
}

/**
 * What version a tenant database is actually at, asked of the database.
 *
 * Three answers, and the middle one is the reason this function exists rather
 * than a `SELECT max(version)`:
 *
 *   0 — empty. A Neon project after `createRoleAndDatabase`, before any DDL.
 *   1 — a **legacy** tenant: provisioned by the applier that shipped before this
 *       runner existed, so it has the rung-one tables and no ledger to say so.
 *       Inferring it from `chunk` is what lets those tenants migrate at all;
 *       without it the runner would replay rung one over a live brain.
 *   N — the ledger's highest recorded rung.
 */
export async function readTenantSchemaVersion(sql: SQL | TransactionSQL): Promise<number> {
  if (await tableExists(sql, SCHEMA_LEDGER_TABLE)) {
    const rows = await sql<{ version: number | null }[]>`
      SELECT max(version)::int AS version FROM schema_migration
    `;
    const recorded = rows[0]?.version;
    if (recorded !== null && recorded !== undefined) return recorded;
  }
  return (await tableExists(sql, 'chunk')) ? 1 : 0;
}

/**
 * Creates the ledger if it is absent. Idempotent, and tolerant of losing the
 * race to another instance doing the same thing on the same wake.
 */
async function ensureLedger(sql: SQL): Promise<void> {
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        version    integer     NOT NULL,
        name       text        NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT schema_migration_pkey PRIMARY KEY (version)
      );
      COMMENT ON TABLE schema_migration IS 'registry — one row per applied schema rung, written in the same transaction as the rung''s DDL so a version can never claim a migration that did not commit.';
    `);
  } catch (error) {
    const state = sqlstateOf(error);
    if (state !== DUPLICATE_TABLE && state !== UNIQUE_VIOLATION) throw error;
  }
}

/**
 * Writes the ledger row a legacy tenant never got.
 *
 * A tenant provisioned before this runner existed has rung one's tables and an
 * empty ledger. Leaving it that way works — {@link readTenantSchemaVersion}
 * infers the version from `chunk` — but it leaves every such tenant dependent on
 * a heuristic forever, and it leaves the ledger, which is the thing an operator
 * reads to see what a tenant has had done to it, silently missing its first
 * entry. Adopting is idempotent and safe under a race: the version is the
 * primary key.
 *
 * Marked `(adopted)` rather than written as if it had been applied here. The
 * difference is real — nobody watched that DDL run — and it is exactly what an
 * operator diffing two tenants' ledgers wants to see.
 */
async function adoptLegacyBaseline(sql: SQL, baseline: TenantMigration): Promise<void> {
  const ledger = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM schema_migration`;
  if ((ledger[0]?.n ?? 0) > 0) return;
  if (!(await tableExists(sql, 'chunk'))) return;

  await sql.unsafe(
    `INSERT INTO schema_migration (version, name) VALUES (${baseline.version}, '${baseline.name.replaceAll("'", "''")} (adopted)') ON CONFLICT (version) DO NOTHING`,
  );
}

// ---------------------------------------------------------------------------
// Running the ladder.
// ---------------------------------------------------------------------------

/**
 * How long a rung waits for a lock before giving up.
 *
 * Not "how long a rung holds one" — that is a different problem with a different
 * remedy. This is the one adversarial review reproduced: rung two issues four
 * `ALTER TABLE chunk ADD COLUMN`, which take `ACCESS EXCLUSIVE`. One ordinary
 * open transaction holding `ACCESS SHARE` on `chunk` — a woken tenant mid-request
 * — is enough to queue the rung indefinitely, **and every read arriving after it
 * queues behind the exclusive request**. So one long query plus one opportunistic
 * wake-time migration takes the whole tenant's read path down for the length of
 * the long query, and the migration waits forever.
 *
 * Five seconds converts that from an indefinite outage into a retryable failure:
 * the rung aborts with `lock_not_available`, the tenant keeps serving, and the
 * next wake tries again. A rung that cannot get its lock is not an emergency —
 * there is another wake along in a moment.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

export interface MigrateOptions {
  /** KTD9's per-tenant configuration. Required: there is no default (see fts-language.ts). */
  readonly ftsLanguage: string;
  /** Stop at this rung. Defaults to the fleet's head. */
  readonly to?: number;
  /**
   * Overrides rung one's DDL. The seam H2's guard uses to hand provisioning a
   * baseline with a step missing, which is the fleet failure that card is about.
   */
  readonly baselineDdl?: string;
  /**
   * The caller's deadline, threaded down rather than checked around the outside.
   * Provisioning owns a run deadline (`src/control/provision.ts`) and used to
   * check it before and after this call because there was nowhere to put it —
   * which is precisely the cooperative-deadline shape U2 paid for: a call that
   * outlives the deadline it was given, and a lease that becomes stealable while
   * the transaction is still live.
   *
   * Honest about its reach: it is observed between rungs, so it cannot interrupt
   * a rung already executing. {@link MigrateOptions.lockTimeoutMs} is what bounds
   * the case that actually blocks, and `statementTimeoutMs` is available for the
   * caller who wants a hard ceiling on the work itself.
   */
  readonly signal?: AbortSignal;
  /** See {@link DEFAULT_LOCK_TIMEOUT_MS}. 0 disables, which is the old behaviour. */
  readonly lockTimeoutMs?: number;
  /**
   * A ceiling on each statement in a rung. **Off by default**, deliberately: an
   * HNSW build on a large tenant legitimately takes minutes, and killing it
   * halfway costs more than it saves — the pathology this module found is the
   * *waiting*, not the working. A caller that knows its rungs are small can set
   * one.
   */
  readonly statementTimeoutMs?: number;
}

export interface MigrateResult {
  readonly from: number;
  readonly to: number;
  /** The rungs this call actually applied — empty when another waker got there first. */
  readonly applied: readonly number[];
}

/**
 * A ladder that got part-way and then failed, carrying where it actually got to.
 *
 * Rungs commit one at a time on purpose, so a ladder that fails on rung three
 * leaves a tenant genuinely at rung two. Throwing a bare error loses that: the
 * sweep then reports `from`/`to` as the version it *started* with and banks
 * nothing, so the outcome record and the control-plane row both state something
 * the database can disprove. It self-heals on the next wake — the tenant DB is
 * truth — but an operator reading sweep output is told a falsehood in the
 * meantime, and "the migration did nothing" is the wrong thing to be told when
 * deciding whether to roll back.
 *
 * Only raised when at least one rung committed. A ladder that failed on its first
 * rung has no partial state to report, and wrapping there would bury the original
 * error behind a second one for no gain.
 */
export class PartialMigrationError extends Error {
  /** Where the tenant really is, read from the tenant database after the failure. */
  readonly result: MigrateResult;
  /** What went wrong on the rung that did not commit. */
  readonly failure: unknown;

  constructor(result: MigrateResult, failure: unknown) {
    const detail = failure instanceof Error ? failure.message : String(failure);
    super(
      `tenant migration stopped at v${result.to} after applying ${result.applied.join(', ') || 'nothing'}: ${detail}`,
    );
    this.name = 'PartialMigrationError';
    this.result = result;
    this.failure = failure;
  }
}

/** One tenant's turn in the sweep ran past its deadline. */
export class TenantMigrationTimeoutError extends Error {
  readonly tenantId: string;
  readonly timeoutMs: number;

  constructor(tenantId: string, timeoutMs: number) {
    super(
      `migrating ${tenantId} exceeded its ${timeoutMs}ms budget; the sweep moved on. A sweep bounded in count but not in time stalls forever on the first tenant that blocks, and every tenant behind it stays behind.`,
    );
    this.name = 'TenantMigrationTimeoutError';
    this.tenantId = tenantId;
    this.timeoutMs = timeoutMs;
  }
}

function throwIfAborted(signal: AbortSignal | undefined, what: string): void {
  if (signal?.aborted === true) {
    throw new Error(`${what} aborted: the caller's deadline elapsed or the run was cancelled`);
  }
}

/** A non-negative integer of milliseconds, or 0 for "no timeout". */
function timeoutMilliseconds(requested: number | undefined, fallback: number): number {
  if (requested === undefined) return fallback;
  if (!Number.isFinite(requested) || requested < 0) {
    throw new TypeError(`timeout must be a non-negative number of milliseconds, got ${String(requested)}`);
  }
  return Math.trunc(requested);
}

/**
 * Brings one tenant database up to `to`, and records where it got to.
 *
 * Each rung runs in its own transaction: a ladder that applied three rungs in
 * one transaction would roll all three back on the third's failure, and a run
 * killed mid-ladder would then have banked nothing at all. Per-rung commits mean
 * a killed run resumes from where it stopped, which is the same reasoning that
 * makes the ledger row commit with its DDL.
 */
export async function migrateTenantSchema(
  sql: SQL,
  options: MigrateOptions,
): Promise<MigrateResult> {
  const target = options.to ?? FLEET_SCHEMA_VERSION;

  await assertTextSearchConfigExists(sql, options.ftsLanguage);
  // Before any DDL: a tenant already indexed in another language must not be
  // half-migrated into this one.
  await assertFtsLanguageMatches(sql, options.ftsLanguage);
  await ensureLedger(sql);

  const baseline = MIGRATIONS[0];
  if (baseline !== undefined) await adoptLegacyBaseline(sql, baseline);

  const from = await readTenantSchemaVersion(sql);
  if (from > target) {
    // Not an error: a sweep can race a wake, and the wake may have gone further.
    return { from, to: from, applied: [] };
  }

  const applied: number[] = [];
  try {
    for (const migration of migrationsBetween(from, target)) {
      // Between rungs, which is where a tenant is on a rung boundary and a
      // stopped run costs nothing. Mid-rung there is nothing useful to do: the
      // transaction either commits or does not.
      throwIfAborted(options.signal, 'tenant migration');
      const ddl = await ddlFor(migration, options);
      if (await applyRung(sql, migration, ddl, options)) applied.push(migration.version);
    }
  } catch (error) {
    if (applied.length === 0) throw error;
    // Asked of the database rather than inferred from `applied`: the point of
    // the report is to say where the tenant actually is.
    const stopped = await readTenantSchemaVersion(sql).catch(() => Math.max(from, ...applied));
    throw new PartialMigrationError({ from, to: stopped, applied }, error);
  }

  const reached = await readTenantSchemaVersion(sql);

  // Every wake of a tenant behind the fleet, and every provision, comes through
  // here — including the no-op path where another instance did the work. So this
  // is the closest thing the design has to a standing attestation that R15 is
  // still enforced on a tenant, and it costs two statements. A tenant whose
  // fence was disabled out of band fails to migrate rather than serving with
  // KTD5's access check evaluating a column anybody can move.
  if (reached >= ORIGIN_FENCE_SINCE) await assertOriginFence(sql);

  return { from, to: reached, applied };
}

async function ddlFor(migration: TenantMigration, options: MigrateOptions): Promise<string> {
  const raw =
    migration.version === 1 && options.baselineDdl !== undefined
      ? options.baselineDdl
      : await readMigrationDdl(migration);

  // The ceiling check runs on the DDL that is about to execute, not on the file
  // in the tree — the two differ exactly when a caller supplied one. H2: a
  // dimension past the type's HNSW ceiling stores, inserts and queries fine and
  // fails only at `CREATE INDEX`, leaving a tenant that answers by sequential
  // scan.
  const violations = findIndexableDimensionViolations(raw);
  if (violations.length > 0) {
    const detail = violations
      .map((v) => `${v.declaration} exceeds the HNSW ceiling of ${v.ceiling} for ${v.type}`)
      .join('; ');
    throw new Error(
      `migration ${migration.version} (${migration.name}) declares a dimension that cannot be HNSW-indexed: ${detail}. It would store and query fine and only fail at CREATE INDEX, leaving a tenant that answers by sequential scan.`,
    );
  }

  // The runner enforces expand/contract, not just CI. Until adversarial review
  // pointed it out, `findExpandContractViolations` had exactly one caller —
  // `test/schema/rollout.test.ts` — which means it checked the committed ladder
  // and nothing else. The seam right above is the problem: `baselineDdl` lets a
  // caller hand this function arbitrary DDL, and that DDL used to get the
  // dimension check and not this one. A rule enforced over the tree but not over
  // what actually executes is a convention with a test next to it.
  const contracting = findExpandContractViolations(raw);
  if (contracting.length > 0) {
    throw new Error(
      `migration ${migration.version} (${migration.name}) is not expand-only: ${contracting.join('; ')}. During a rolling deploy the previous fleet version is still serving tenants this rung has migrated, and it cannot be taught anything.`,
    );
  }

  if (!needsFtsLanguage(raw)) return raw;
  const applied = applyFtsLanguage(raw, options.ftsLanguage);
  if (needsFtsLanguage(applied)) {
    throw new Error(
      `migration ${migration.version} still carries the FTS language placeholder after substitution`,
    );
  }
  return applied;
}

/**
 * Applies one rung under the tenant's advisory lock. Returns whether this call
 * was the one that applied it — `false` means another instance had already got
 * there, which is a no-op and not a failure.
 */
async function applyRung(
  sql: SQL,
  migration: TenantMigration,
  ddl: string,
  options: MigrateOptions = { ftsLanguage: '' },
): Promise<boolean> {
  const lockTimeoutMs = timeoutMilliseconds(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const statementTimeoutMs = timeoutMilliseconds(options.statementTimeoutMs, 0);

  const outcome = (await sql.begin(async (tx) => {
    // First, before anything that can wait. Both the advisory lock below and the
    // rung's own `ALTER TABLE`s are lock waits, and an unbounded wait on either
    // is an outage rather than a slow migration — see DEFAULT_LOCK_TIMEOUT_MS.
    await tx.unsafe(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);
    if (statementTimeoutMs > 0) {
      await tx.unsafe(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
    }

    // Inside the transaction, before the version is read: the lock is what makes
    // the read-then-write below safe against a second instance waking the same
    // suspended tenant, and an xact lock has no release path to forget.
    await tx.unsafe(`SELECT pg_advisory_xact_lock(${SCHEMA_MIGRATION_LOCK_KEY})`);

    const current = await readTenantSchemaVersion(tx);
    if (current >= migration.version) return { value: false };

    await tx.unsafe(ddl);

    // Inside the rung's own transaction, after its DDL and before its ledger
    // row: a rung that leaves R15 unenforced rolls back and is never recorded.
    // This is the one net that sees `CREATE OR REPLACE FUNCTION
    // refuse_origin_change() … RETURN NEW;` — an "additive" statement the
    // expand/contract scanner allows and the frozen fleet surface runs
    // successfully, which disables the origin fence on every table at once.
    if (migration.version >= ORIGIN_FENCE_SINCE) await assertOriginFence(tx);

    await tx.unsafe(
      `INSERT INTO schema_migration (version, name) VALUES (${migration.version}, '${migration.name.replaceAll("'", "''")}')`,
    );
    return { value: true };
  })) as { value: boolean };

  return outcome.value;
}

// ---------------------------------------------------------------------------
// The bounded sweep.
// ---------------------------------------------------------------------------

/** One tenant the control plane reports as behind, with what migrating it needs. */
export interface SweepCandidate {
  readonly tenantId: string;
  readonly schemaVersion: number;
  /** KTD9's per-tenant configuration, off the control-plane row. */
  readonly ftsLanguage: string;
}

/**
 * The three things a sweep needs from the world, as ports rather than as a
 * control-plane import.
 *
 * Connecting to a tenant means resolving a connection string from the secret
 * store (R11), which is U6's dispatch seam and not this module's business. Ports
 * keep the sweep's *policy* — how many, in what order, what happens when one
 * fails — testable without a fleet.
 */
export interface SweepPorts {
  /** At most `limit` tenants behind the fleet's head. The bound is the point. */
  listBehind(limit: number): Promise<readonly SweepCandidate[]>;
  /**
   * The signal carries the per-tenant deadline. A port that ignores it is still
   * correct — the sweep stops waiting either way — but a port that honours it
   * stops *working* too, which is the difference between a sweep that moves on
   * and a sweep that moves on while leaving a connection wedged behind it.
   */
  migrate(candidate: SweepCandidate, signal?: AbortSignal): Promise<MigrateResult>;
  /** Banks the version onto the control-plane row — the fleet's index. */
  recordSchemaVersion(tenantId: string, version: number): Promise<void>;
}

export interface SweepOutcome {
  readonly tenantId: string;
  readonly from: number;
  readonly to: number;
  readonly status: 'migrated' | 'already-current' | 'failed';
  readonly error?: unknown;
}

/**
 * Migrates up to `limit` tenants that are behind, one at a time.
 *
 * **Bounded**, because the fleet is tens of thousands of suspended computes and
 * a sweep that walks all of them wakes all of them — an availability event
 * dressed as maintenance. The bound is passed to the *query*, not applied after
 * it.
 *
 * **Sequential and failure-isolated**, because the ordinary reason one tenant
 * fails is that its compute did not wake in time. Aborting the run there leaves
 * every tenant after it behind and the next sweep starts on the same one.
 *
 * **Only banks a version it moved.** A tenant another instance already migrated
 * comes back with nothing applied and is reported rather than re-written, so a
 * sweep racing a wake does not turn into a write storm on the control plane.
 */
export interface SweepOptions {
  /** How many tenants to visit. Passed to the query, not applied after it. */
  readonly limit: number;
  /**
   * How long any one tenant may take before the sweep gives up on it.
   *
   * The bound that was missing. `listBehind` bounds the sweep in *count*, which
   * stops it waking the whole fleet — but one tenant whose rung is queued behind
   * a long-running read stalls the run indefinitely, every tenant behind it in
   * the batch stays unmigrated, and the next sweep starts on the same one. That
   * is the "bounded sweep that never finishes" case exactly. 0 disables.
   */
  readonly perTenantTimeoutMs?: number;
  /** Stops the sweep between tenants. The run's own deadline, threaded in. */
  readonly signal?: AbortSignal;
}

/** The default per-tenant budget: generous for a rung, finite for a sweep. */
export const DEFAULT_SWEEP_TENANT_TIMEOUT_MS = 60_000;

/** Rejects when `signal` aborts, and cleans its listener up either way. */
function rejectOnAbort(signal: AbortSignal, reason: Error): { promise: Promise<never>; done: () => void } {
  let onAbort: () => void = () => {};
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  return { promise, done: () => signal.removeEventListener('abort', onAbort) };
}

export async function sweepTenantSchemas(
  ports: SweepPorts,
  options: SweepOptions,
): Promise<SweepOutcome[]> {
  const candidates = await ports.listBehind(options.limit);
  const outcomes: SweepOutcome[] = [];
  const budgetMs = timeoutMilliseconds(options.perTenantTimeoutMs, DEFAULT_SWEEP_TENANT_TIMEOUT_MS);

  for (const candidate of candidates) {
    // Between tenants, where stopping is free. A cancelled sweep reports what it
    // did rather than inventing outcomes for tenants it never visited.
    if (options.signal?.aborted === true) break;

    try {
      const result = await migrateWithinBudget(ports, candidate, budgetMs, options.signal);
      if (result.applied.length === 0 && result.to === candidate.schemaVersion) {
        outcomes.push({
          tenantId: candidate.tenantId,
          from: result.from,
          to: result.to,
          status: 'already-current',
        });
        continue;
      }
      await ports.recordSchemaVersion(candidate.tenantId, result.to);
      outcomes.push({
        tenantId: candidate.tenantId,
        from: result.from,
        to: result.to,
        status: 'migrated',
      });
    } catch (error) {
      // A ladder that got part-way really did move the tenant. Reporting it at
      // the version it started from is a statement the database disproves, and
      // banking nothing leaves the control-plane row lying until the next wake.
      const partial = error instanceof PartialMigrationError ? error.result : undefined;
      if (partial !== undefined && partial.to > candidate.schemaVersion) {
        try {
          await ports.recordSchemaVersion(candidate.tenantId, partial.to);
        } catch {
          // Banking is best-effort here: the tenant database is the truth and
          // the next wake re-reads it. Losing the outcome record as well would
          // turn one bad row into a silent sweep.
        }
      }
      outcomes.push({
        tenantId: candidate.tenantId,
        from: partial?.from ?? candidate.schemaVersion,
        to: partial?.to ?? candidate.schemaVersion,
        status: 'failed',
        error,
      });
    }
  }

  return outcomes;
}

async function migrateWithinBudget(
  ports: SweepPorts,
  candidate: SweepCandidate,
  budgetMs: number,
  outer: AbortSignal | undefined,
): Promise<MigrateResult> {
  if (budgetMs === 0 && outer === undefined) return ports.migrate(candidate);

  const controller = new AbortController();
  const expiry = new TenantMigrationTimeoutError(candidate.tenantId, budgetMs);
  const timer =
    budgetMs > 0 ? setTimeout(() => controller.abort(expiry), budgetMs) : undefined;
  const cancelOuter = (): void => controller.abort(expiry);
  outer?.addEventListener('abort', cancelOuter, { once: true });

  const abort = rejectOnAbort(controller.signal, expiry);
  try {
    return await Promise.race([ports.migrate(candidate, controller.signal), abort.promise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    outer?.removeEventListener('abort', cancelOuter);
    abort.done();
  }
}

// ---------------------------------------------------------------------------
// Expand/contract, as a scanner.
// ---------------------------------------------------------------------------

/**
 * Statement shapes a rung may contain. An allowlist rather than a list of
 * forbidden verbs: a scanner that hunts for `DROP` passes anything it has not
 * thought of, and the whole point is to catch the destructive statement nobody
 * anticipated. Anything unrecognized is a finding.
 *
 * `ALTER TABLE` is deliberately absent from this list — it is handled separately
 * below, action by action, because Postgres accepts several actions in one
 * statement and a head-anchored pattern reads only the first of them.
 *
 * `CREATE OR REPLACE FUNCTION` is absent for a different reason: replacing a
 * function body is by definition a change to behaviour the previous release is
 * already relying on, which is the one thing an expand-only rule exists to
 * forbid. Adversarial review got `CREATE OR REPLACE FUNCTION
 * refuse_origin_change() … RETURN NEW;` — a rung that silently disables R15
 * fleet-wide — past this scanner *and* the frozen fleet surface. A rung that
 * needs different behaviour adds a new function and points new triggers at it.
 */
const EXPAND_ONLY_STATEMENTS: readonly RegExp[] = [
  /^CREATE TABLE\b/i,
  /^CREATE UNIQUE INDEX\b/i,
  /^CREATE INDEX\b/i,
  /^CREATE TYPE\b/i,
  /^CREATE DOMAIN\b/i,
  /^CREATE FUNCTION\b/i,
  /^CREATE (CONSTRAINT )?TRIGGER\b/i,
  /^CREATE EXTENSION\b/i,
  /^COMMENT ON\b/i,
  /^INSERT INTO\b/i,
];

/**
 * The `ALTER TABLE` actions that only add.
 *
 * Checked per action rather than per statement. `ALTER TABLE chunk ADD COLUMN x
 * int, DROP COLUMN content;` is one statement whose head matches `ADD COLUMN`
 * perfectly, and adversarial review used exactly that to launder a `DROP
 * COLUMN`, an `ALTER COLUMN … TYPE` and a `DROP CONSTRAINT` past the scanner.
 *
 * **`DROP NOT NULL` is the third entry, and it is not a waiver.** `ALTER COLUMN`
 * was refused as a family, and that was right for every action the family had
 * ever contained: `TYPE` rewrites the table under a release still querying it,
 * `SET NOT NULL` breaks every INSERT that release issues, `SET DEFAULT` changes
 * what its writes mean. Dropping a NOT NULL does none of those — it is the one
 * action here that strictly *widens* what the table accepts, so every statement
 * the previous release makes keeps working unchanged and unchanged in meaning.
 * Refusing it was a property of the scanner never having enumerated the family,
 * not a property of rollouts.
 *
 * The shape is anchored end to end for the same reason the family was refused
 * wholesale: `SET NOT NULL`, `TYPE`, `SET DEFAULT` and `DROP DEFAULT` are one
 * token away from this and none of them may pass. Postgres accepts `ALTER
 * COLUMN x` and the bare `ALTER x`, so both spellings are matched — a rule that
 * only knew the long form would refuse correct DDL, and a guard that cries wolf
 * is one somebody switches off.
 *
 * What this still does NOT license: nulling a column something reads without
 * saying what now guarantees the value. Rung 14 pays that with a CHECK across
 * both embedding seats, and the frozen fleet surface proves the previous
 * release survives both halves.
 *
 * **`DROP CONSTRAINT` is not in this list and never will be**, because on its
 * own it is exactly what it looks like. It is admitted only as half of a pair —
 * see {@link constraintsAddedBy} — and the pairing is checked before this
 * allowlist runs, so a lone drop still falls through to here and is refused.
 */
const EXPAND_ONLY_ALTER_ACTIONS: readonly RegExp[] = [
  /^ADD COLUMN\b/i,
  /^ADD CONSTRAINT\b/i,
  /^ALTER (?:COLUMN\s+)?\S+\s+DROP NOT NULL$/i,
];

/**
 * A rung that a previous fleet version could not survive.
 *
 * Two rules, and the second is the subtle one:
 *
 *   * The statement kind must be additive. `DROP`, `RENAME` and every
 *     `ALTER COLUMN` action except `DROP NOT NULL` rewrite what the previous
 *     release already queries — see {@link EXPAND_ONLY_ALTER_ACTIONS} for why
 *     that one action is different in kind rather than merely in degree.
 *   * `ADD COLUMN ... NOT NULL` must carry a `DEFAULT`. Without one, every
 *     INSERT the previous release issues — which names the old column list —
 *     starts failing the moment the rung commits. That is the exact shape of
 *     outage the rollout rule exists to prevent, and it is invisible in review
 *     because the new code always names the new column.
 *
 * There is no waiver list, on purpose. A genuinely contracting change (dropping
 * a column no release still reads) needs a second mechanism — a contract rung
 * gated on every instance having been replaced — and the honest place to notice
 * that is when someone first needs it, not a flag that lets the first one
 * through quietly.
 *
 * **What this does not check, stated so it is not mistaken for covered:** how
 * long a rung *holds a lock*. `CREATE INDEX` without `CONCURRENTLY` blocks writes
 * for the length of the build, and on a large tenant that is an outage even
 * though every statement here is additive. It is a different failure with a
 * different remedy (and `CREATE INDEX CONCURRENTLY` cannot run inside the
 * transaction this runner depends on), so it wants its own guard rather than a
 * clause bolted onto this one.
 */
export function findExpandContractViolations(ddl: string): string[] {
  const findings: string[] = [];
  const statements = splitStatements(ddl);
  // A uniqueness promise is only free on a table the previous release has never
  // heard of. Collected first because the two facts arrive in either order
  // inside one rung.
  const createdHere = tablesCreatedBy(statements);
  // The other fact that arrives in either order: a constraint dropped in one
  // statement and re-added in the next.
  const readdedHere = constraintsAddedBy(statements);

  for (const statement of statements) {
    const head = statement.replace(/\s+/g, ' ').trim();
    if (head.length === 0) continue;

    const alter = /^ALTER TABLE\s+(?:IF EXISTS\s+)?(?:ONLY\s+)?(\S+)\s+([\s\S]+)$/i.exec(head);
    if (alter) {
      findings.push(
        ...alterTableFindings(head, alter[1] ?? '', alter[2] ?? '', createdHere, readdedHere),
      );
      continue;
    }

    if (!EXPAND_ONLY_STATEMENTS.some((shape) => shape.test(head))) {
      findings.push(
        `not an additive statement: ${JSON.stringify(head.slice(0, 80))} — the previous fleet version still queries what this rewrites`,
      );
      continue;
    }

    // A unique index on a table that already has rows in it — and, more to the
    // point, a live previous release still writing to it — does not fail now. It
    // fails on the first duplicate that release writes, on a schema it can
    // neither understand nor retry past. On a table this rung creates, nothing
    // else can be writing to it yet, so the promise costs nothing.
    const unique = /^CREATE UNIQUE INDEX\s+(?:CONCURRENTLY\s+)?(?:IF NOT EXISTS\s+)?\S+\s+ON\s+(?:ONLY\s+)?(\S+)/i.exec(head);
    const onTable = normalizeTableName(unique?.[1] ?? '');
    if (unique && !createdHere.has(onTable)) {
      findings.push(
        `uniqueness added to a pre-existing table: ${JSON.stringify(head.slice(0, 80))} — the previous fleet version keeps working until the first duplicate it writes, and then starts failing on a schema it cannot retry past`,
      );
    }
  }

  if (findings.length === 0 && statements.length === 0) {
    findings.push('the rung contains no statements — an empty migration is a version bump with no schema behind it');
  }

  return findings;
}

/** `public.chunk` and `chunk` are the same table to a rollout. */
function normalizeTableName(raw: string): string {
  const bare = raw.replace(/"/g, '').toLowerCase();
  return bare.startsWith('public.') ? bare.slice('public.'.length) : bare;
}

function tablesCreatedBy(statements: readonly string[]): Set<string> {
  const created = new Set<string>();
  for (const statement of statements) {
    const match = /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\S+)/i.exec(
      statement.replace(/\s+/g, ' ').trim(),
    );
    if (match?.[1] !== undefined) created.add(normalizeTableName(match[1]));
  }
  return created;
}

/** One key for "this table's constraint of this name". Names are case-folded. */
function constraintKey(table: string, name: string): string {
  // Joined on an escaped NUL, spelled rather than embedded: a raw one in a
  // source file is what `test/ai/boundary.test.ts` refuses, and it is right to.
  return `${normalizeTableName(table)}\u0000${name.replace(/"/g, '').toLowerCase()}`;
}

/**
 * Every `(table, constraint)` this rung ADDs — the half that licenses a drop.
 *
 * **Why a rung may drop a constraint at all, when it may not drop anything
 * else.** A CHECK cannot be widened in place: constraints conjoin, so a second
 * permissive one changes nothing while the first still stands. Admitting a
 * seventh label to `ingest_log.failure_code` means dropping the six-label
 * constraint and re-adding it wider under the same name — and rung 15 needed
 * exactly that, to stop a fleet-credential failure being recorded as a user's
 * revoked grant.
 *
 * That pair is not a contraction in the sense this guard protects. What it
 * protects is a **previous fleet version still serving a tenant this rung has
 * migrated**, and a strictly wider constraint narrows none of that release's
 * statements: its writes still pass, its reads never had an opinion about the
 * alphabet. The same reasoning that admitted `DROP NOT NULL` — the one action
 * that widens rather than rewrites — admits this one.
 *
 * **What the pairing rule buys, and what it does not.** It refuses the shape
 * that really does leave a guarantee behind: a lone `DROP CONSTRAINT`, with
 * nothing put back. It cannot check that the replacement is *wider* — a rung
 * could re-add a narrower constraint under the same name and pass here, and
 * that would break the previous release's writes on the first row it refuses.
 * That is the same residual `ADD CONSTRAINT` has always carried (this file's
 * header names it), and it is paid by the same thing: the frozen fleet surface
 * in `test/schema/rollout.test.ts`, which runs the previous release's own
 * statements against a database this rung has migrated.
 *
 * `DROP CONSTRAINT … CASCADE` is not matched by the pairing shape and so is
 * refused: the cascade reaches objects this rung never names, and re-adding the
 * constraint does not bring them back.
 */
function constraintsAddedBy(statements: readonly string[]): Set<string> {
  const added = new Set<string>();
  for (const statement of statements) {
    const head = statement.replace(/\s+/g, ' ').trim();
    const alter = /^ALTER TABLE\s+(?:IF EXISTS\s+)?(?:ONLY\s+)?(\S+)\s+([\s\S]+)$/i.exec(head);
    if (alter === null) continue;
    for (const action of splitTopLevelCommas(alter[2] ?? '')) {
      const match = /^ADD CONSTRAINT\s+(\S+)/i.exec(action);
      if (match?.[1] !== undefined) added.add(constraintKey(alter[1] ?? '', match[1]));
    }
  }
  return added;
}

/**
 * One `ALTER TABLE`, judged action by action.
 *
 * The `NOT NULL`/`DEFAULT` rule is per action for the same reason the allowlist
 * is: `ADD COLUMN a int DEFAULT 0, ADD COLUMN b int NOT NULL` satisfies a
 * statement-wide reading — there is a `DEFAULT` in there somewhere — while `b`
 * breaks every INSERT the previous release issues.
 *
 * **What this still does not decide, stated so it is not mistaken for covered:**
 * whether an `ADD CONSTRAINT` is *satisfiable* by the previous release's writes.
 * `ADD CONSTRAINT … CHECK (page_id IS NOT NULL)` is additive in shape and an
 * outage in effect, and no static rule separates it from the null-permissive
 * checks this rung legitimately adds to `chunk`. The frozen fleet surface in
 * `test/schema/rollout.test.ts` is what pays for that one, by running the
 * previous release's own INSERTs against the migrated schema.
 */
function alterTableFindings(
  head: string,
  table: string,
  body: string,
  createdHere: ReadonlySet<string>,
  readdedHere: ReadonlySet<string>,
): string[] {
  const findings: string[] = [];
  const actions = splitTopLevelCommas(body);

  for (const action of actions) {
    // Before the allowlist, because a paired drop is the one shape that is
    // additive in effect and subtractive in spelling. Anchored end to end so
    // `CASCADE` and `RESTRICT` fall through to the refusal below rather than
    // riding along on a name that happens to match.
    const dropped = /^DROP CONSTRAINT\s+(?:IF EXISTS\s+)?(\S+)\s*$/i.exec(action);
    if (dropped !== null) {
      if (!readdedHere.has(constraintKey(table, dropped[1] ?? ''))) {
        findings.push(
          `constraint dropped and not put back on ${normalizeTableName(table)}: ${JSON.stringify(action.slice(0, 80))} — a rung may drop a constraint only to re-add it under the same name in the same rung, which is how a CHECK is widened; a drop with nothing after it removes a guarantee the previous fleet version was written against`,
        );
      }
      continue;
    }

    if (!EXPAND_ONLY_ALTER_ACTIONS.some((shape) => shape.test(action))) {
      findings.push(
        `not an additive ALTER TABLE action on ${normalizeTableName(table)}: ${JSON.stringify(action.slice(0, 80))} in ${JSON.stringify(head.slice(0, 80))} — a multi-action ALTER is judged action by action, because the previous fleet version experiences each of them`,
      );
      continue;
    }

    if (/^ADD COLUMN\b/i.test(action) && /\bNOT NULL\b/i.test(action) && !/\bDEFAULT\b/i.test(action)) {
      findings.push(
        `NOT NULL without DEFAULT: ${JSON.stringify(action.slice(0, 80))} — every INSERT naming the previous column list fails the moment this commits`,
      );
    }

    // Same table test as the index form, and for the same reason: on a table
    // this rung creates, nothing else can be writing to it yet. Without it the
    // rule fires on a legitimate create-then-constrain rung, and a guard that
    // cries wolf on correct DDL is one someone switches off.
    const unique = /^ADD CONSTRAINT\s+\S+\s+(UNIQUE|PRIMARY KEY)\b/i.exec(action);
    if (unique && !createdHere.has(normalizeTableName(table))) {
      findings.push(
        `uniqueness added to a pre-existing table: ${JSON.stringify(action.slice(0, 80))} — same hazard as a unique index, through the constraint door: the previous fleet version fails on the first duplicate it writes`,
      );
    }
  }

  if (actions.length === 0) {
    findings.push(`ALTER TABLE with no action: ${JSON.stringify(head.slice(0, 80))}`);
  }

  return findings;
}

/**
 * Splits an `ALTER TABLE` body on the commas that separate its actions.
 *
 * Depth- and quote-aware, because the commas that do NOT separate actions are
 * everywhere: `ADD COLUMN a int DEFAULT 0`, `ADD CONSTRAINT c CHECK (x IN ('a',
 * 'b'))`, `ADD CONSTRAINT f FOREIGN KEY (a, b) REFERENCES t (a, b)`. Splitting
 * naively would report a wall of false findings, and a guard that cries wolf is
 * a guard someone switches off.
 */
export function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let index = 0;

  while (index < body.length) {
    const character = body[index] ?? '';
    if (character === "'") {
      const close = findQuoteEnd(body, index);
      current += body.slice(index, close);
      index = close;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      if (current.trim().length > 0) parts.push(current.trim());
      current = '';
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }

  if (current.trim().length > 0) parts.push(current.trim());
  return parts;
}

/**
 * Splits SQL into statements, ignoring semicolons inside string literals,
 * dollar-quoted function bodies and comments. Small, but it has to understand
 * `$$` or every trigger function reads as a dozen broken statements.
 */
export function splitStatements(ddl: string): string[] {
  const statements: string[] = [];
  let current = '';
  let index = 0;

  while (index < ddl.length) {
    const rest = ddl.slice(index);

    const lineComment = /^--[^\n]*/.exec(rest);
    if (lineComment) {
      index += lineComment[0].length;
      continue;
    }
    const blockComment = /^\/\*[\s\S]*?\*\//.exec(rest);
    if (blockComment) {
      index += blockComment[0].length;
      continue;
    }
    const dollarOpen = /^\$([A-Za-z_]*)\$/.exec(rest);
    if (dollarOpen) {
      const tag = dollarOpen[0];
      const close = ddl.indexOf(tag, index + tag.length);
      const end = close === -1 ? ddl.length : close + tag.length;
      current += ddl.slice(index, end);
      index = end;
      continue;
    }
    const character = ddl[index] ?? '';
    if (character === "'") {
      const close = findQuoteEnd(ddl, index);
      current += ddl.slice(index, close);
      index = close;
      continue;
    }
    if (character === ';') {
      if (current.trim().length > 0) statements.push(current.trim());
      current = '';
      index += 1;
      continue;
    }
    current += character;
    index += 1;
  }

  if (current.trim().length > 0) statements.push(current.trim());
  return statements;
}

function findQuoteEnd(ddl: string, start: number): number {
  let index = start + 1;
  while (index < ddl.length) {
    if (ddl[index] === "'") {
      if (ddl[index + 1] === "'") {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return ddl.length;
}

// ---------------------------------------------------------------------------
// Deploy first, migrate second — as data.
// ---------------------------------------------------------------------------

export interface FleetRelease {
  /** A release of the fleet's *code*, not of the schema. */
  readonly release: string;
  /** The schema version that release's code understands and migrates to. */
  readonly head: number;
  /**
   * Whether that release will actually run migrations. The ordering rule needs
   * this to be separable from `head`: a release must be able to ship
   * understanding a rung *before* any instance starts applying it, because
   * during the rollout that introduces it, instances of both releases are live.
   */
  readonly migrationsEnabled: boolean;
}

/**
 * Whether a proposed release may be rolled out over its predecessor.
 *
 * The rule the plan states, made checkable: a release may not enable migrations
 * to a version the release it replaces cannot serve. Two consecutive releases
 * that each move the head by one rung are fine only when the first ships with
 * migrations off — otherwise, for the length of the rollout, a tenant migrated
 * by a new instance lands on an old one that has no path to understanding it.
 */
export function findRolloutViolations(previous: FleetRelease, next: FleetRelease): string[] {
  const findings: string[] = [];

  if (next.head < previous.head) {
    findings.push(
      `${next.release} rolls the schema head back from v${previous.head} to v${next.head}; a released rung cannot be un-shipped`,
    );
  }

  // Deliberately not `!isServableSchema(...)`: that predicate is also false for
  // a version *behind* the contract, so a rollback would be reported twice —
  // once as the rollback it is, once as an ordering violation it is not. The
  // ordering rule is about running ahead of what the predecessor can serve.
  if (next.migrationsEnabled && next.head > previous.head + SCHEMA_LOOKAHEAD) {
    findings.push(
      `${next.release} enables migrations to v${next.head} while ${previous.release} can serve at most v${previous.head + SCHEMA_LOOKAHEAD} — deploy first, migrate second`,
    );
  }

  return findings;
}
