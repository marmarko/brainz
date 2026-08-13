/**
 * Applying the tenant schema — and the provisioning half of hazard H2.
 *
 * `src/control/provision.ts` declares `TenantSchemaApplier` and calls it as the
 * third step of provisioning; a throw from `apply` is recorded as
 * `schema_apply_failed` and the tenant is never marked `ready`. This module is
 * the real implementation of that port, and it is more than a `sql.unsafe(ddl)`
 * call for two reasons:
 *
 * **A tenant whose vector index did not get created is broken, not slow (H2).**
 * It answers every query correctly, by sequential scan, which returns *exact*
 * nearest neighbours — so recall goes up, nothing errors, and no test anywhere
 * can tell. Schema is applied per tenant, so a DDL step that fails on one and
 * succeeds on the next produces a fleet where some brains have a vector index
 * and some do not, with no aggregate signal: the slow ones just look like
 * unlucky users. The only moment that failure is cheap to catch is before the
 * tenant is handed out, which is here.
 *
 * **A fresh tenant must arrive at the version the fleet serves.** So
 * provisioning does not apply a head file — it runs the same ladder an existing
 * tenant is migrated along (`src/control/migrate.ts`), and returns the rung it
 * reached. One code path, exercised by every provision as well as every upgrade;
 * a provisioning-only DDL path is a path the migration tests never cover.
 */

import { SQL } from 'bun';

import { migrateTenantSchema } from '../control/migrate.ts';
import {
  type CancellableRequest,
  type FirstQueryResult,
  type SchemaApplyRequest,
  type TenantSchemaApplier,
} from '../control/provision.ts';
import { assertTextSearchConfigExists } from './fts-language.ts';
import { HEAD_SCHEMA_VERSION, MIGRATIONS, type TenantMigration } from './migrations.ts';
import { assertVectorColumns } from './vector-index.ts';

export { FTS_LANGUAGE_PLACEHOLDER, applyFtsLanguage } from './fts-language.ts';

/** The version `control.tenant.schema_version` records for a fresh tenant. */
export const TENANT_SCHEMA_VERSION = HEAD_SCHEMA_VERSION;

const BASELINE: TenantMigration | undefined = MIGRATIONS[0];

/** Rung one's DDL — the file the H2 guard mutilates to simulate a fleet failure. */
export async function readTenantDdl(): Promise<string> {
  if (BASELINE === undefined) throw new Error('the migration ladder is empty');
  return Bun.file(`${import.meta.dir}/${BASELINE.file}`).text();
}

export interface TenantSchemaApplierOptions {
  /**
   * Overrides rung one's DDL. The seam exists because a guard has to be able to
   * hand this a baseline with a step missing, which is exactly the fleet failure
   * H2 describes.
   */
  readonly ddl?: string;
  /**
   * Stop partway up the ladder. Provisioning never does; the migration tests
   * always do, because a database at the version *before* the rung under test
   * cannot be built any other way once provisioning runs the whole ladder.
   */
  readonly targetVersion?: number;
}

function throwIfAborted(request: CancellableRequest): void {
  if (request.signal?.aborted === true) {
    throw new Error('schema apply aborted: the provisioning run was cancelled or timed out');
  }
}

export function createTenantSchemaApplier(
  options: TenantSchemaApplierOptions = {},
): TenantSchemaApplier {
  return {
    async apply(request: SchemaApplyRequest): Promise<{ readonly schemaVersion: number }> {
      throwIfAborted(request);

      const sql = new SQL(request.connectionString, { max: 1 });
      try {
        await assertTextSearchConfigExists(sql, request.ftsLanguage);
        throwIfAborted(request);

        const result = await migrateTenantSchema(sql, {
          ftsLanguage: request.ftsLanguage,
          // Threaded down rather than checked around the outside. The two
          // `throwIfAborted` calls either side of this used to be the whole
          // story, because `MigrateOptions` had nowhere to put a signal — which
          // is the cooperative-deadline shape U2 already paid for: the deadline
          // elapses, the call does not notice, and the lease becomes stealable
          // while the transaction is still live. The migration observes it
          // between rungs; `lockTimeoutMs` bounds the wait that actually blocks.
          ...(request.signal === undefined ? {} : { signal: request.signal }),
          ...(options.targetVersion === undefined ? {} : { to: options.targetVersion }),
          ...(options.ddl === undefined ? {} : { baselineDdl: options.ddl }),
        });
        throwIfAborted(request);

        // The load-bearing line. Asks the catalog, not the DDL: presence of
        // `CREATE INDEX` in the text is what a grep would confirm, and a grep
        // cannot see the tenant on which that statement did not run. It checks
        // the registry against the catalog before it checks the indexes, so a
        // queried column quietly re-filed as reserved fails here rather than
        // being skipped by a loop that no longer knows about it.
        await assertVectorColumns(sql, result.to);

        return { schemaVersion: result.to };
      } finally {
        await sql.close();
      }
    },

    async verifyFirstQuery(
      request: CancellableRequest & { readonly connectionString: string },
    ): Promise<FirstQueryResult> {
      const sql = new SQL(request.connectionString, { max: 1 });
      try {
        // Reported by the database rather than echoed back from the request:
        // the failure KTD9 forbids is precisely a database quietly disagreeing
        // with what was asked for.
        const rows = await sql.unsafe<{ default_text_search_config: string }[]>(
          'SHOW default_text_search_config',
        );
        const configured = rows[0]?.default_text_search_config;
        if (configured === undefined) return { ok: false };
        return { ok: true, ftsLanguage: configured.replace(/^pg_catalog\./, '') };
      } catch {
        return { ok: false };
      } finally {
        await sql.close();
      }
    },
  };
}
