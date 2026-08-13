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
}

export interface MigrateResult {
  readonly from: number;
  readonly to: number;
  /** The rungs this call actually applied — empty when another waker got there first. */
  readonly applied: readonly number[];
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
  for (const migration of migrationsBetween(from, target)) {
    const ddl = await ddlFor(migration, options);
    if (await applyRung(sql, migration, ddl)) applied.push(migration.version);
  }

  return { from, to: await readTenantSchemaVersion(sql), applied };
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
async function applyRung(sql: SQL, migration: TenantMigration, ddl: string): Promise<boolean> {
  const outcome = (await sql.begin(async (tx) => {
    // Inside the transaction, before the version is read: the lock is what makes
    // the read-then-write below safe against a second instance waking the same
    // suspended tenant, and an xact lock has no release path to forget.
    await tx.unsafe(`SELECT pg_advisory_xact_lock(${SCHEMA_MIGRATION_LOCK_KEY})`);

    const current = await readTenantSchemaVersion(tx);
    if (current >= migration.version) return { value: false };

    await tx.unsafe(ddl);
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
  migrate(candidate: SweepCandidate): Promise<MigrateResult>;
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
export async function sweepTenantSchemas(
  ports: SweepPorts,
  options: { readonly limit: number },
): Promise<SweepOutcome[]> {
  const candidates = await ports.listBehind(options.limit);
  const outcomes: SweepOutcome[] = [];

  for (const candidate of candidates) {
    try {
      const result = await ports.migrate(candidate);
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
      outcomes.push({
        tenantId: candidate.tenantId,
        from: candidate.schemaVersion,
        to: candidate.schemaVersion,
        status: 'failed',
        error,
      });
    }
  }

  return outcomes;
}

// ---------------------------------------------------------------------------
// Expand/contract, as a scanner.
// ---------------------------------------------------------------------------

/**
 * Statement shapes a rung may contain. An allowlist rather than a list of
 * forbidden verbs: a scanner that hunts for `DROP` passes anything it has not
 * thought of, and the whole point is to catch the destructive statement nobody
 * anticipated. Anything unrecognized is a finding.
 */
const EXPAND_ONLY_STATEMENTS: readonly RegExp[] = [
  /^CREATE TABLE\b/i,
  /^CREATE UNIQUE INDEX\b/i,
  /^CREATE INDEX\b/i,
  /^CREATE TYPE\b/i,
  /^CREATE DOMAIN\b/i,
  /^CREATE (OR REPLACE )?FUNCTION\b/i,
  /^CREATE (CONSTRAINT )?TRIGGER\b/i,
  /^CREATE EXTENSION\b/i,
  /^COMMENT ON\b/i,
  /^INSERT INTO\b/i,
  /^ALTER TABLE\s+\S+\s+ADD COLUMN\b/i,
  /^ALTER TABLE\s+\S+\s+ADD CONSTRAINT\b/i,
];

/**
 * A rung that a previous fleet version could not survive.
 *
 * Two rules, and the second is the subtle one:
 *
 *   * The statement kind must be additive. `DROP`, `RENAME` and `ALTER COLUMN`
 *     rewrite what the previous release already queries.
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

  for (const statement of splitStatements(ddl)) {
    const head = statement.replace(/\s+/g, ' ').trim();
    if (head.length === 0) continue;

    if (!EXPAND_ONLY_STATEMENTS.some((shape) => shape.test(head))) {
      findings.push(
        `not an additive statement: ${JSON.stringify(head.slice(0, 80))} — the previous fleet version still queries what this rewrites`,
      );
      continue;
    }

    if (/\bADD COLUMN\b/i.test(head) && /\bNOT NULL\b/i.test(head) && !/\bDEFAULT\b/i.test(head)) {
      findings.push(
        `NOT NULL without DEFAULT: ${JSON.stringify(head.slice(0, 80))} — every INSERT naming the previous column list fails the moment this commits`,
      );
    }
  }

  if (findings.length === 0 && splitStatements(ddl).length === 0) {
    findings.push('the rung contains no statements — an empty migration is a version bump with no schema behind it');
  }

  return findings;
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
