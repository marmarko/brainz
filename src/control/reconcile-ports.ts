/**
 * The world `src/control/reconcile.ts` reasons about, against real stores.
 *
 * **Split for the same reason the schema sweep is split.** `migrate.ts` declares
 * `SweepPorts` and `schema-sweep.ts` implements them, so the policy — which
 * tenants, in what order, under what refusal — is testable without a fleet, and
 * the SQL is testable without the policy. A reconciler whose classification
 * rules lived next to its `SELECT`s could only be tested by seeding a control
 * plane into every state the prefix table names, which is the shape that makes a
 * safety rule expensive to assert and therefore under-asserted.
 *
 * Nothing here decides anything. Every function is a read, and the one
 * capability that is not — the teardown — is deliberately **not** composed in
 * this file: it needs a vendor client and a secret writer that the web process
 * may legitimately not hold, and a helper here that built one would make the
 * destructive composition the convenient one.
 */

import type { SQL } from 'bun';

import type { OwnerCensus, ReconcilePorts, TenantResidue } from './reconcile.ts';

/**
 * The owner lookup, reduced to the one question this module may ask.
 *
 * Structural rather than an import of `BrainOwnerDirectory`, so `src/control`
 * does not depend on `src/web` — and narrower than it on purpose: the directory
 * answers a domain and a digest, and a reconciler that held those could publish
 * them into a ticket. `{ tenantId }` is the whole of what a guard needs.
 *
 * The `ok: false` arm travels through unchanged, because "I could not see the
 * owners" and "nobody owns these" must not arrive at a deletion decision looking
 * the same.
 */
export interface OwnerPresence {
  owners(): Promise<
    { readonly ok: true; readonly owners: readonly { readonly tenantId: string }[] } | { readonly ok: false }
  >;
}

export function ownerCensusFrom(directory: OwnerPresence): () => Promise<OwnerCensus> {
  return async (): Promise<OwnerCensus> => {
    const found = await directory.owners();
    if (!found.ok) return { ok: false };
    return { ok: true, ownedTenantIds: new Set(found.owners.map((owner) => owner.tenantId)) };
  };
}

/**
 * Every control-plane row, narrowed to {@link TenantResidue}.
 *
 * The projection is the point: no spend column, no secret reference *value* —
 * `connection_secret_ref IS NOT NULL` rather than the reference itself, because
 * a reference is the namespace an operator would go and ask for, and this
 * module has no reason to name one. What survives is exactly the prefix
 * recognition: which provisioning step this row died after.
 */
export function createReconcilePorts(deps: {
  readonly controlSql: SQL;
  readonly owners: OwnerPresence;
}): ReconcilePorts {
  return {
    async tenants(): Promise<readonly TenantResidue[]> {
      const rows = await deps.controlSql<
        {
          tenant_id: string;
          state: string;
          ready_at: Date | null;
          has_project: boolean;
          has_secret: boolean;
        }[]
      >`
        SELECT tenant_id,
               state::text AS state,
               ready_at,
               neon_project_id IS NOT NULL AS has_project,
               connection_secret_ref IS NOT NULL AS has_secret
          FROM control.tenant
         ORDER BY tenant_id`;
      return rows.map((row) => ({
        tenantId: row.tenant_id,
        state: row.state as TenantResidue['state'],
        readyAt: row.ready_at === null ? null : row.ready_at.getTime(),
        // A placeholder rather than the id: the classifier asks only whether a
        // project exists, and a project id in a report is the string somebody
        // pastes into a vendor console.
        neonProjectId: row.has_project ? 'present' : null,
        connectionSecretRef: row.has_secret ? 'present' : null,
      }));
    },

    /**
     * Tenant ids that have a secret-store entry.
     *
     * **`to_regclass` first, and an empty list is a real answer.** A deployment
     * on the `file` secret backend has no `control.tenant_secret` table at all,
     * so there is genuinely nothing to enumerate — and a reconciler that threw
     * `relation does not exist` there would make the whole report unavailable
     * over a class of residue that deployment cannot have.
     */
    async secretNamespaces(): Promise<readonly string[]> {
      const present = await deps.controlSql<{ present: boolean }[]>`
        SELECT to_regclass('control.tenant_secret') IS NOT NULL AS present`;
      if (present[0]?.present !== true) return [];

      const rows = await deps.controlSql<{ namespace: string }[]>`
        SELECT namespace FROM control.tenant_secret WHERE namespace LIKE 'tenant/%'`;
      return rows.map((row) => row.namespace.slice('tenant/'.length)).filter((id) => id.length > 0);
    },

    owners: ownerCensusFrom(deps.owners),
    // No `teardown`. See the header, and `reconcile.ts`'s: the capability is
    // absent on this composition rather than declined by it.
  };
}
