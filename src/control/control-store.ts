/**
 * `ControlPlaneStore`, over the control plane.
 *
 * **This port had no implementation in `src/`.** `provisionTenant` declares it,
 * `schema.sql` describes the table it writes, and every implementation lived in a
 * test file — so provisioning was a function nothing in a running process could
 * call. That is the shape of gap this module closes: not a behaviour change, a
 * missing half.
 *
 * **`update` is a compare-and-set and the lease is in the `WHERE`.** The port's
 * own contract says an implementation MUST apply the patch only while
 * `provisioning_lease` still equals the expected value, in one statement. It is
 * repeated here because the consequence is not a stale write: a run that was
 * declared stale and taken over can otherwise bank `failed` on top of a live
 * user's `ready` row, and the retry a recorded failure invites deletes their
 * database. Every write below therefore carries `AND provisioning_lease = $n`,
 * including the empty patch — which is how a run asks "do I still hold this
 * row?" and must not be short-circuited to `applied: true`.
 *
 * **A patch is assembled by column, never by spreading the caller's object.**
 * The distinction the port draws is `undefined` (leave the column alone) versus
 * `null` (clear it), and a `SET` list built from `Object.entries` would write
 * every column the type has every time — which turns "advance the schema
 * version" into "clear every provisioning artifact this run has not re-derived".
 */

import type { SQL } from 'bun';

import type {
  ControlPlaneStore,
  InsertOutcome,
  ProvisioningFailureCode,
  TenantPatch,
  TenantRecord,
  TenantState,
  TenantTier,
  UpdateOutcome,
} from './provision.ts';

interface TenantRow {
  readonly tenant_id: string;
  readonly state: string;
  readonly tier: string;
  readonly schema_version: number;
  readonly fts_language: string;
  readonly neon_project_id: string | null;
  readonly neon_branch_id: string | null;
  readonly neon_database: string | null;
  readonly neon_role: string | null;
  readonly connection_secret_ref: string | null;
  readonly bearer_secret_ref: string | null;
  readonly storage_prefix: string | null;
  readonly provisioning_started_at: Date;
  readonly provisioning_attempts: number;
  readonly provisioning_lease: number;
  readonly ready_at: Date | null;
  readonly failure_code: string | null;
}

const COLUMNS = `
  tenant_id, state::text AS state, tier::text AS tier, schema_version, fts_language::text AS fts_language,
  neon_project_id, neon_branch_id, neon_database, neon_role,
  connection_secret_ref, bearer_secret_ref, storage_prefix,
  provisioning_started_at, provisioning_attempts, provisioning_lease,
  ready_at, failure_code::text AS failure_code`;

function recordOf(row: TenantRow): TenantRecord {
  return {
    tenantId: row.tenant_id,
    state: row.state as TenantState,
    tier: row.tier as TenantTier,
    schemaVersion: Number(row.schema_version),
    ftsLanguage: row.fts_language,
    neonProjectId: row.neon_project_id,
    neonBranchId: row.neon_branch_id,
    neonDatabase: row.neon_database,
    neonRole: row.neon_role,
    connectionSecretRef: row.connection_secret_ref,
    bearerSecretRef: row.bearer_secret_ref,
    storagePrefix: row.storage_prefix,
    provisioningStartedAt: row.provisioning_started_at.getTime(),
    provisioningAttempts: Number(row.provisioning_attempts),
    provisioningLease: Number(row.provisioning_lease),
    readyAt: row.ready_at === null ? null : row.ready_at.getTime(),
    failureCode: row.failure_code as ProvisioningFailureCode | null,
  };
}

/**
 * Which columns a patch key writes, and how its value reaches the column.
 *
 * A table rather than a `switch` so the two directions cannot drift: a new field
 * on `TenantPatch` that nobody adds here is a compile error at the `satisfies`
 * below, not a column that silently stops being written.
 */
const PATCH_COLUMNS = {
  state: 'state',
  schemaVersion: 'schema_version',
  ftsLanguage: 'fts_language',
  neonProjectId: 'neon_project_id',
  neonBranchId: 'neon_branch_id',
  neonDatabase: 'neon_database',
  neonRole: 'neon_role',
  connectionSecretRef: 'connection_secret_ref',
  bearerSecretRef: 'bearer_secret_ref',
  storagePrefix: 'storage_prefix',
  provisioningStartedAt: 'provisioning_started_at',
  provisioningAttempts: 'provisioning_attempts',
  provisioningLease: 'provisioning_lease',
  readyAt: 'ready_at',
  failureCode: 'failure_code',
} as const satisfies Readonly<Record<keyof TenantPatch, string>>;

/** The enum and domain columns need their cast; the rest bind plainly. */
const PATCH_CASTS: Partial<Readonly<Record<keyof TenantPatch, string>>> = {
  state: '::control.tenant_state',
  ftsLanguage: '::control.fts_language',
  failureCode: '::control.provisioning_failure',
};

/** Epoch milliseconds on the record, `timestamptz` in the column. */
const PATCH_INSTANTS: ReadonlySet<keyof TenantPatch> = new Set([
  'provisioningStartedAt',
  'readyAt',
]);

export function createPostgresControlPlaneStore(sql: SQL): ControlPlaneStore {
  async function readOne(tenantId: string): Promise<TenantRecord | undefined> {
    const rows = (await sql.unsafe(`SELECT ${COLUMNS} FROM control.tenant WHERE tenant_id = $1`, [
      tenantId,
    ])) as unknown as TenantRow[];
    const found = rows[0];
    return found === undefined ? undefined : recordOf(found);
  }

  return {
    get: readOne,

    async insert(record: TenantRecord): Promise<InsertOutcome> {
      const rows = (await sql.unsafe(
        `INSERT INTO control.tenant (
           tenant_id, state, tier, schema_version, fts_language,
           neon_project_id, neon_branch_id, neon_database, neon_role,
           connection_secret_ref, bearer_secret_ref, storage_prefix,
           provisioning_started_at, provisioning_attempts, provisioning_lease,
           ready_at, failure_code
         ) VALUES (
           $1, $2::control.tenant_state, $3::control.tenant_tier, $4, $5::control.fts_language,
           $6, $7, $8, $9,
           $10, $11, $12,
           $13, $14, $15,
           $16, $17::control.provisioning_failure
         )
         ON CONFLICT (tenant_id) DO NOTHING
         RETURNING ${COLUMNS}`,
        [
          record.tenantId,
          record.state,
          record.tier,
          record.schemaVersion,
          record.ftsLanguage,
          record.neonProjectId,
          record.neonBranchId,
          record.neonDatabase,
          record.neonRole,
          record.connectionSecretRef,
          record.bearerSecretRef,
          record.storagePrefix,
          new Date(record.provisioningStartedAt),
          record.provisioningAttempts,
          record.provisioningLease,
          record.readyAt === null ? null : new Date(record.readyAt),
          record.failureCode,
        ],
      )) as unknown as TenantRow[];

      const inserted = rows[0];
      if (inserted !== undefined) return { inserted: true, record: recordOf(inserted) };

      // The conflict arm. Re-read rather than echo what was offered: the caller
      // needs what the row *says*, which is another run's state, not its own.
      const existing = await readOne(record.tenantId);
      if (existing === undefined) {
        // `DO NOTHING` with no row and no conflicting row afterwards means the
        // row was deleted between the two statements. A throw, because silently
        // reporting either arm would be inventing an answer.
        throw new Error(
          `control.tenant row for ${JSON.stringify(record.tenantId)} neither inserted nor present; it was deleted concurrently`,
        );
      }
      return { inserted: false, record: existing };
    },

    async update(tenantId: string, expectedLease: number, patch: TenantPatch): Promise<UpdateOutcome> {
      const assignments: string[] = [];
      const values: unknown[] = [tenantId, expectedLease];

      for (const [field, column] of Object.entries(PATCH_COLUMNS) as [keyof TenantPatch, string][]) {
        // `in` rather than `!== undefined`: the port distinguishes an absent key
        // from a key set to `undefined`, and only the former means "leave it".
        if (!(field in patch)) continue;
        const raw = patch[field];
        const value =
          PATCH_INSTANTS.has(field) && typeof raw === 'number' ? new Date(raw) : (raw ?? null);
        values.push(value);
        assignments.push(`${column} = $${values.length}${PATCH_CASTS[field] ?? ''}`);
      }

      // `updated_at` moves on every applied write, including the empty patch:
      // the lease probe is a write that happened, and a row whose timestamp did
      // not move is a row an operator reads as untouched.
      assignments.push('updated_at = now()');

      const rows = (await sql.unsafe(
        `UPDATE control.tenant SET ${assignments.join(', ')}
          WHERE tenant_id = $1 AND provisioning_lease = $2
          RETURNING ${COLUMNS}`,
        values,
      )) as unknown as TenantRow[];

      const applied = rows[0];
      if (applied !== undefined) return { applied: true, record: recordOf(applied) };
      return { applied: false, current: await readOne(tenantId) };
    },
  };
}
