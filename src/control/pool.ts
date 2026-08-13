/**
 * The warm pool (U15), and the number it is deliberately missing.
 *
 * **What the pool is for.** U2 provisions synchronously and says so: a founder
 * never races themselves. A public signup does, and the slow half of a provision
 * is the vendor call that creates a Neon project. The pool pre-pays that half so
 * a signup is schema-apply plus a first query rather than project-create plus
 * everything else.
 *
 * **KTD9 decides the shape, and it is not a preference.** Pool projects are
 * provisioned *language-neutral*: `src/schema/fts-language.ts` substitutes the
 * tenant's FTS configuration into the DDL and refuses DDL that still carries the
 * placeholder, so a pool project **cannot** have the tenant schema applied in
 * advance. The language is a mandatory assignment-time step, executed before the
 * tenant accepts its first write — which is exactly what {@link claimPoolProject}
 * requires of its caller and what `assignPoolProject` does.
 *
 * **The pool ships unsized, on purpose.** The roadmap says the pool is "sized by
 * U2's committed benchmark", and there is no committed benchmark: the harness
 * exists (`src/control/benchmark.ts`), the hundred-provision run exists
 * (`test/control/provision.real.test.ts`), and it is gated on
 * `BRAINZ_REAL_SUBSTRATE` because every run creates billable Neon projects. So
 * {@link PoolOptions.target} has **no default**. A pool sized by a number nobody
 * chose is KTD9's silent fallback wearing different clothes; `0` is a legal and
 * meaningful value meaning "provision synchronously", which is U2's behaviour and
 * is what the web app runs with until a receipt exists.
 *
 * **The claim is a compare-and-set, for the same reason every other claim in
 * this directory is.** Two signups arriving together, or one signup racing a
 * drain, must produce one tenant per project. `UPDATE … WHERE state = 'ready'`
 * with a `RETURNING` is the whole mechanism: a reader that selected a candidate
 * and then updated it would hand the same project to both.
 */

import type { SQL } from 'bun';

import {
  isValidTenantId,
  poolNamespace,
  tenantNamespace,
  type CallerIdentity,
  type PoolSecretStore,
  type TenantSecretStore,
} from './secrets.ts';

export const POOL_ID_PREFIX = 'pool-';

export type PoolState = 'filling' | 'ready' | 'claimed' | 'retired';

export interface PoolProject {
  readonly poolId: string;
  readonly neonProjectId: string;
  readonly neonBranchId: string;
  readonly neonDatabase: string;
  readonly neonRole: string;
  readonly connectionSecretRef: string;
}

export interface PoolOptions {
  /**
   * How many `ready` projects to keep. **Required, no default** — see the header.
   * `0` disables the pool and is a legal choice.
   */
  readonly target: number;
}

export class PoolNotSizedError extends Error {
  constructor() {
    super(
      'the warm pool has no target size. Pass one explicitly: it is sized by U2\'s ' +
        'create-to-first-query benchmark, which has not been run, and a default here would ' +
        'be a number nobody chose. 0 means "provision synchronously", which is U2\'s behaviour.',
    );
    this.name = 'PoolNotSizedError';
  }
}

export function assertPoolSized(options: Partial<PoolOptions>): asserts options is PoolOptions {
  if (typeof options.target !== 'number' || !Number.isInteger(options.target) || options.target < 0) {
    throw new PoolNotSizedError();
  }
}

/** Matches `control.tenant_id`'s alphabet, which the pool column reuses. */
export function newPoolId(random: (bytes: number) => Uint8Array = defaultRandom): string {
  return `${POOL_ID_PREFIX}${Buffer.from(random(12)).toString('hex')}`;
}

function defaultRandom(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return out;
}

// ---------------------------------------------------------------------------
// Filling.
// ---------------------------------------------------------------------------

export interface PoolFillDeps {
  readonly sql: SQL;
  /**
   * Creates the vendor resources for one pool project. Deliberately a port: this
   * module knows nothing about Neon, and `src/control/provision.ts` owns the API
   * client that does.
   */
  readonly create: (poolId: string) => Promise<{
    readonly neonProjectId: string;
    readonly neonBranchId: string;
    readonly neonDatabase: string;
    readonly neonRole: string;
    readonly connectionString: string;
  }>;
  readonly secrets: PoolSecretStore;
  readonly caller: CallerIdentity;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface FillReport {
  readonly created: number;
  readonly failed: number;
  readonly ready: number;
}

/** How many projects are claimable right now. */
export async function poolDepth(sql: SQL): Promise<number> {
  const rows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM control.pool_project WHERE state = 'ready'`;
  return rows[0]?.n ?? 0;
}

/**
 * Bring the pool up to its target.
 *
 * The row is written **before** the vendor call, in `filling`, so a crash between
 * the two leaves a record naming the project we may have created rather than an
 * orphan nothing in the control plane can find. That is the same lesson
 * `provision.ts` records about `neonProjectName`, applied to a resource that has
 * no tenant to derive a name from.
 */
export async function fillPool(deps: PoolFillDeps, options: Partial<PoolOptions>): Promise<FillReport> {
  assertPoolSized(options);
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => newPoolId());

  let created = 0;
  let failed = 0;

  for (let depth = await poolDepth(deps.sql); depth + created < options.target; ) {
    const poolId = newId();
    if (!isValidTenantId(poolId)) throw new Error(`pool id is not addressable: ${JSON.stringify(poolId)}`);

    await deps.sql`
      INSERT INTO control.pool_project (pool_id, state, created_at)
      VALUES (${poolId}, 'filling', ${now()})`;

    try {
      const vendor = await deps.create(poolId);
      const written = await deps.secrets.putPool(deps.caller, poolId, {
        connectionString: vendor.connectionString,
      });
      if (!written.ok) throw new Error(`the pool secret could not be written: ${written.reason}`);

      await deps.sql`
        UPDATE control.pool_project
        SET state = 'ready',
            neon_project_id = ${vendor.neonProjectId},
            neon_branch_id = ${vendor.neonBranchId},
            neon_database = ${vendor.neonDatabase},
            neon_role = ${vendor.neonRole},
            connection_secret_ref = ${poolNamespace(poolId)},
            ready_at = ${now()}
        WHERE pool_id = ${poolId} AND state = 'filling'`;
      created += 1;
    } catch {
      // Retired rather than deleted: the row is the only record that we may be
      // paying for a project at the vendor, and a reconciliation sweep needs it.
      await deps.sql`
        UPDATE control.pool_project SET state = 'retired' WHERE pool_id = ${poolId} AND state = 'filling'`;
      failed += 1;
      // One failure per fill run. A vendor that is refusing will refuse the next
      // one too, and a loop that keeps asking is how a rate limit becomes a ban.
      break;
    }
  }

  return { created, failed, ready: await poolDepth(deps.sql) };
}

// ---------------------------------------------------------------------------
// Claiming.
// ---------------------------------------------------------------------------

export type ClaimOutcome =
  | { readonly ok: true; readonly project: PoolProject }
  | { readonly ok: false; readonly reason: 'pool_empty' | 'invalid_tenant_id' };

/**
 * Take one ready project for a tenant, atomically.
 *
 * **`WHERE state = 'ready'` inside the subquery is the control, and `FOR UPDATE
 * SKIP LOCKED` is not.** That distinction was established by mutation rather than
 * assumed: removing `SKIP LOCKED` leaves the concurrent-claim test green, because
 * Postgres re-evaluates the `UPDATE`'s qualification after it acquires the row
 * lock and the subquery then finds nothing `ready`. Removing the state predicate
 * makes the test fail immediately. So `SKIP LOCKED` is a throughput choice — the
 * loser is answered rather than made to wait for the winner's transaction — and
 * the state predicate is what makes two signups collapse onto one row.
 *
 * The loser gets `pool_empty` and falls back to synchronous provisioning, rather
 * than being handed a project somebody else is already applying a schema to.
 */
export async function claimPoolProject(
  sql: SQL,
  request: { readonly tenantId: string; readonly now: Date },
): Promise<ClaimOutcome> {
  if (!isValidTenantId(request.tenantId)) return { ok: false, reason: 'invalid_tenant_id' };

  const rows = await sql<
    {
      pool_id: string;
      neon_project_id: string;
      neon_branch_id: string;
      neon_database: string;
      neon_role: string;
      connection_secret_ref: string;
    }[]
  >`
    UPDATE control.pool_project
    SET state = 'claimed', claimed_by = ${request.tenantId}, claimed_at = ${request.now}
    WHERE pool_id = (
      SELECT pool_id FROM control.pool_project
      WHERE state = 'ready'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING pool_id, neon_project_id, neon_branch_id, neon_database, neon_role, connection_secret_ref`;

  const claimed = rows[0];
  if (claimed === undefined) return { ok: false, reason: 'pool_empty' };

  return {
    ok: true,
    project: {
      poolId: claimed.pool_id,
      neonProjectId: claimed.neon_project_id,
      neonBranchId: claimed.neon_branch_id,
      neonDatabase: claimed.neon_database,
      neonRole: claimed.neon_role,
      connectionSecretRef: claimed.connection_secret_ref,
    },
  };
}

export interface AssignDeps {
  readonly sql: SQL;
  readonly secrets: TenantSecretStore & PoolSecretStore;
  readonly caller: CallerIdentity;
  /**
   * KTD9's mandatory step. Applies the tenant schema with **this tenant's**
   * language and answers the version it reached. A port, because U3 owns the
   * applier and this module owns only the ordering.
   */
  readonly applySchema: (request: {
    readonly connectionString: string;
    readonly ftsLanguage: string;
  }) => Promise<{ readonly schemaVersion: number }>;
  readonly mintBearer: (tenantId: string) => Promise<string>;
}

export type AssignOutcome =
  | {
      readonly ok: true;
      readonly project: PoolProject;
      readonly schemaVersion: number;
      readonly connectionSecretRef: string;
      readonly bearerSecretRef: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'pool_empty' | 'invalid_tenant_id' | 'secret_unreadable' | 'missing_fts_language';
    };

/**
 * Claim a project and make it a tenant's, in KTD9's order.
 *
 * The order is the contract: **claim, read the string, apply the schema with the
 * chosen language, mint the bearer, rewrite the secret under the tenant's own
 * namespace, revoke the pool entry.** Nothing accepts a write before the language
 * is applied, because the schema is what accepts writes and it does not exist
 * until this function has applied it.
 *
 * The language is required with no default, as `provisionTenant` requires it: a
 * defaulted language here would reintroduce the silent anglicisation for exactly
 * the tenants the pool serves, which is all of them once the pool is on.
 */
export async function assignPoolProject(
  deps: AssignDeps,
  request: { readonly tenantId: string; readonly ftsLanguage: string; readonly now: Date },
): Promise<AssignOutcome> {
  if (request.ftsLanguage.length === 0) return { ok: false, reason: 'missing_fts_language' };

  const claim = await claimPoolProject(deps.sql, { tenantId: request.tenantId, now: request.now });
  if (!claim.ok) return { ok: false, reason: claim.reason };

  const resolved = await deps.secrets.resolvePool(deps.caller, claim.project.poolId);
  if (!resolved.ok) return { ok: false, reason: 'secret_unreadable' };

  const applied = await deps.applySchema({
    connectionString: resolved.secret.connectionString,
    ftsLanguage: request.ftsLanguage,
  });

  const bearerGrant = await deps.mintBearer(request.tenantId);
  const written = await deps.secrets.put(deps.caller, request.tenantId, {
    connectionString: resolved.secret.connectionString,
    bearerGrant,
  });
  if (!written.ok) return { ok: false, reason: 'secret_unreadable' };

  // The pool entry is revoked only after the tenant's own entry exists. The
  // other order loses the connection string if the write fails, and the project
  // is then a resource we pay for and cannot reach.
  await deps.secrets.revokePool(deps.caller, claim.project.poolId);

  return {
    ok: true,
    project: claim.project,
    schemaVersion: applied.schemaVersion,
    connectionSecretRef: tenantNamespace(request.tenantId),
    bearerSecretRef: tenantNamespace(request.tenantId),
  };
}
