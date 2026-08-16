/**
 * The tenant schema as a ladder, not as a file.
 *
 * `tenant.sql` is rung one — the chunk-storage core the three retrieval hazards
 * in `docs/porting-hazards.md` are measured against. Everything U3 adds on top
 * of it is rung two, and it arrives as a *migration* rather than as more lines
 * in the baseline for one reason that is worth stating plainly:
 *
 * **The fleet already has v1 tenants.** A schema that only exists as a head file
 * can be applied to a fresh database and nowhere else, so the first tenant
 * provisioned before the change has no path to the schema after it. Expressing
 * the change as a rung means provisioning and upgrading run the *same* DDL in
 * the same order, and the migration runner is exercised by every fixture in the
 * suite rather than by one test that remembers to call it.
 *
 * It also makes U3's rollout-safety property testable at all: "the previous
 * fleet version still serves a tenant migrated to the current version" has no
 * meaning while there is only one version. See `test/schema/rollout.test.ts`.
 *
 * **Every rung is expand-only.** No `DROP`, no `RENAME`, no `NOT NULL` without a
 * default on a table that already exists. That is not a style preference — it is
 * the property that lets an instance running the previous release keep serving a
 * tenant a newer instance has already migrated, which is the difference between
 * a rolling deploy and an outage of the length of a rolling deploy. It is
 * enforced, not requested: `findExpandContractViolations` in
 * `src/control/migrate.ts` scans each rung's DDL and the frozen fleet surface
 * re-runs the previous release's literal statements against a migrated database.
 */

export interface TenantMigration {
  /** Contiguous from 1. The number recorded on the control-plane row. */
  readonly version: number;
  /** What the rung is for, so an operator reading a version gap sees a change. */
  readonly name: string;
  /** Path relative to this directory. */
  readonly file: string;
}

/**
 * Rung one: the file provisioning has always applied. Listed here rather than
 * special-cased so that "apply the baseline" and "apply a migration" are the
 * same operation — a baseline that took a different code path would be a second
 * implementation of the step the whole unit is about.
 */
export const MIGRATIONS: readonly TenantMigration[] = [
  { version: 1, name: 'chunk-storage-core', file: 'tenant.sql' },
  { version: 2, name: 'knowledge-core', file: 'migrations/v2-knowledge-core.sql' },
  { version: 3, name: 'consolidation', file: 'migrations/v3-consolidation.sql' },
  { version: 4, name: 'briefing-cursor', file: 'migrations/v4-briefing.sql' },
  { version: 5, name: 'page-occurred-at', file: 'migrations/v5-occurred-at.sql' },
  { version: 6, name: 'attachment-external-ref', file: 'migrations/v6-attachment-external-ref.sql' },
  { version: 7, name: 'panel-settings', file: 'migrations/v7-panel-settings.sql' },
  { version: 8, name: 'search-path-pinned', file: 'migrations/v8-search-path-pinned.sql' },
  { version: 9, name: 'lifecycle', file: 'migrations/v9-lifecycle.sql' },
  { version: 10, name: 'severance', file: 'migrations/v10-severance.sql' },
  { version: 11, name: 'alias-origin', file: 'migrations/v11-alias-origin.sql' },
  { version: 12, name: 'severed-alias', file: 'migrations/v12-severed-alias.sql' },
  { version: 13, name: 'embedding-seat-1024', file: 'migrations/v13-embedding-seat-1024.sql' },
];

/** The version this code applies to a fresh tenant, derived rather than typed twice. */
export const HEAD_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

/**
 * The ladder's own invariants, as findings rather than as throws.
 *
 * A gap or a repeat makes "the tenant is at version N" ambiguous, and an
 * out-of-order list makes it wrong; both are cheap to write by accident when a
 * rung is added on a branch. Exported so a test asserts the real ladder is clean
 * *and* that the check itself can still go red — a validator nobody points at a
 * broken input is a validator that has never run.
 */
export function findLadderViolations(migrations: readonly TenantMigration[]): string[] {
  const findings: string[] = [];
  let expected = 1;

  for (const migration of migrations) {
    if (migration.version !== expected) {
      findings.push(
        `migration ${JSON.stringify(migration.name)} is version ${migration.version}, expected ${expected} — versions must run 1..N with no gap and no repeat`,
      );
    }
    expected = migration.version + 1;
    if (migration.name.trim().length < 4) {
      findings.push(`migration ${migration.version} has no usable name`);
    }
  }

  if (migrations.length === 0) findings.push('the ladder is empty — there is no schema to apply');
  return findings;
}

/** The rungs that take a tenant from `from` (exclusive) to `to` (inclusive). */
export function migrationsBetween(from: number, to: number): TenantMigration[] {
  return MIGRATIONS.filter((migration) => migration.version > from && migration.version <= to);
}

export function migrationAt(version: number): TenantMigration | undefined {
  return MIGRATIONS.find((migration) => migration.version === version);
}

/** The DDL text of one rung. Read at call time; these files are not large. */
export async function readMigrationDdl(migration: TenantMigration): Promise<string> {
  return Bun.file(`${import.meta.dir}/${migration.file}`).text();
}

/** Every rung's DDL, for the scanners that must see the whole ladder at once. */
export async function readLadderDdl(): Promise<{ migration: TenantMigration; ddl: string }[]> {
  return Promise.all(
    MIGRATIONS.map(async (migration) => ({ migration, ddl: await readMigrationDdl(migration) })),
  );
}
