/**
 * The three things the migration sweep needs from the world, implemented against
 * the control plane and the secret store.
 *
 * `migrate.ts` declares {@link SweepPorts} and deliberately implements none of
 * them: the sweep's *policy* — how many tenants, in what order, what happens
 * when one fails — is testable without a fleet only if the world is a parameter.
 * This module is the world. It is the seam where a tenant id becomes a
 * connection, and it is small on purpose, because everything interesting about
 * sweeping is on the other side of it.
 *
 * **Warm first, and that is the fan-out policy rather than a sort order.** A
 * fleet is tens of thousands of suspended computes, and waking one to migrate it
 * costs seconds of wall clock and the tenant's own money. A tenant that served a
 * request a minute ago is almost certainly still awake, so visiting it costs a
 * query. Ordering by `last_activity` therefore spends each bounded batch on the
 * tenants that are cheapest to fix, and lets the rest be fixed by the batch that
 * arrives after their next request — which is what "migrate opportunistically on
 * wake" means when nothing may block the wake itself.
 *
 * **The bound is the query's, never a slice.** `LIMIT` in SQL, so a sweep that
 * visits ten tenants also *reads* ten rows; selecting the fleet and then taking
 * the first few is the same wake-everything failure one layer up.
 *
 * **The identity is the tenant's own fleet identity (R11).** Nothing else can
 * resolve that tenant's connection string, and this module holds no ambient
 * credential of its own: it is handed a store and asks it, per tenant, exactly
 * as the request path does. A sweep that could open any tenant with one
 * credential would be the boundary `secrets.ts` exists to prevent, wearing
 * maintenance clothes.
 */

import { SQL } from 'bun';

import {
  FLEET_CONTRACT,
  migrateTenantSchema,
  type FleetSchemaContract,
  type MigrateResult,
  type SweepCandidate,
  type SweepPorts,
} from './migrate.ts';
import { fleetIdentity, type TenantSecretStore } from './secrets.ts';

export interface SchemaSweepOptions {
  /** The control plane. Holds the index (`schema_version`) and nothing else here. */
  readonly control: SQL;
  readonly secrets: TenantSecretStore;
  /** Injected so a test can hand back a fixture connection instead of dialling. */
  readonly open?: (connectionString: string) => SQL;
  /** Defaults to this release's contract; a parameter so a test can shift the head. */
  readonly contract?: FleetSchemaContract;
}

interface BehindRow {
  readonly tenant_id: string;
  readonly schema_version: number;
  readonly fts_language: string;
}

export function createSchemaSweepPorts(options: SchemaSweepOptions): SweepPorts {
  const head = (options.contract ?? FLEET_CONTRACT).head;
  const dial = options.open ?? ((connectionString: string) => new SQL(connectionString, { max: 1 }));

  return {
    async listBehind(limit: number): Promise<readonly SweepCandidate[]> {
      // `ready` only. A `provisioning` row has no secret to resolve yet and runs
      // the ladder itself as its third step; a `deleting` one is U17's, and
      // migrating a brain on its way out is work nobody asked for.
      const rows = (await options.control`
        SELECT tenant_id, schema_version, fts_language
          FROM control.tenant
         WHERE state = 'ready'
           AND schema_version < ${head}
         ORDER BY last_activity DESC NULLS LAST, tenant_id
         LIMIT ${Math.max(0, Math.trunc(limit))}
      `) as unknown as BehindRow[];

      return rows.map((row) => ({
        tenantId: row.tenant_id,
        schemaVersion: row.schema_version,
        ftsLanguage: row.fts_language,
      }));
    },

    async migrate(candidate: SweepCandidate, signal?: AbortSignal): Promise<MigrateResult> {
      const resolved = await options.secrets.resolve(
        fleetIdentity(candidate.tenantId),
        candidate.tenantId,
      );
      // Thrown rather than reported as "nothing to do": the sweep records a
      // failure it can see, and a tenant silently skipped is a tenant that
      // stays behind forever with a green sweep above it.
      if (!resolved.ok) {
        throw new Error(
          `no resolvable connection secret for ${candidate.tenantId} (${resolved.reason}); it cannot be migrated by this instance`,
        );
      }

      const sql = dial(resolved.secret.connectionString);
      try {
        return await migrateTenantSchema(sql, {
          // KTD9's per-tenant choice, off the control-plane row. Never defaulted
          // here: an English fallback would half-migrate a brain indexed in
          // another language, which is the exact failure that column exists for.
          ftsLanguage: candidate.ftsLanguage,
          ...(signal === undefined ? {} : { signal }),
        });
      } finally {
        // Always. The sweep's per-tenant deadline can abandon the call above
        // mid-flight, and a connection left open on a woken compute is the thing
        // that keeps it woken.
        if (options.open === undefined) await sql.close().catch(() => undefined);
      }
    },

    async recordSchemaVersion(tenantId: string, version: number): Promise<void> {
      // Forward only. The tenant database is the truth and this row is an index
      // of it, so the failure worth refusing is an index that goes *backwards* —
      // a sweep racing a wake that already went further would otherwise write a
      // number the database can disprove, and the next sweep would re-visit a
      // tenant that has nothing left to do.
      await options.control`
        UPDATE control.tenant
           SET schema_version = ${version}, updated_at = now()
         WHERE tenant_id = ${tenantId}
           AND schema_version < ${version}
      `;
    },
  };
}
