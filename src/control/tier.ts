/**
 * The seam between billing and consolidation (U15).
 *
 * U11 shipped `createConsolidateHandler` behind a `ConsolidatePorts.open` port
 * that hands back a {@link TenantWorld} carrying a `tier`, and nothing in `src/`
 * ever implemented it — the fleet wiring was the missing half. This module is
 * that half, and it is the reason a subscription change means anything: **the
 * tier the cycle reads comes from the control-plane row, and
 * `src/control/billing.ts` is the only thing that writes it.**
 *
 * Without this module the two facts are unrelated. A tier column that changes
 * while the cycle keeps calling models is not a billing bug that shows up on a
 * dashboard; it is the paid feature being given away, and the failure is silent
 * in the direction that costs money.
 *
 * **`internal` maps to `paid`.** `control.tenant_tier` carries a third value for
 * tenants nobody subscribed for — the canary, the founder's own brain — and they
 * are the tenants that most need the model phases to run. Mapping it to `free`
 * would quietly stop consolidating exactly the brains the fleet is measured on.
 *
 * **A tenant that is not `ready` gets no cycle at all**, and that is a refusal
 * rather than a `free`: a provisioning or deleting tenant is not a free-tier
 * tenant, and running the deterministic phases against a half-built database is
 * the shape of bug that leaves a checkpoint nobody can interpret.
 */

import type { SQL } from 'bun';

import type { ModelGateway } from '../ai/gateway.ts';
import type { ConsolidatePorts, TenantWorld } from '../worker/consolidate/cycle.ts';

export type ConsolidationTier = 'free' | 'paid';

export interface TenantBilling {
  readonly tier: ConsolidationTier;
  /** `null` means the platform default applies; `0` is a real cap of nothing. */
  readonly capMicroUsd: number | null;
}

export type TierLookup =
  | { readonly ok: true; readonly billing: TenantBilling }
  | { readonly ok: false; readonly reason: 'unknown_tenant' | 'not_ready' };

/**
 * Read the tier the cycle must run at.
 *
 * One statement, no cache. A cached tier is a downgrade that has not taken
 * effect yet, and the window is exactly the one an attacker or an unhappy
 * customer would spend.
 */
export async function consolidationTierOf(
  controlSql: SQL,
  tenantId: string,
): Promise<TierLookup> {
  const rows = await controlSql<{ tier: string; state: string; spend_cap_micro_usd: string | null }[]>`
    SELECT tier::text AS tier, state::text AS state, spend_cap_micro_usd
    FROM control.tenant WHERE tenant_id = ${tenantId}`;

  const found = rows[0];
  if (found === undefined) return { ok: false, reason: 'unknown_tenant' };
  if (found.state !== 'ready') return { ok: false, reason: 'not_ready' };

  return {
    ok: true,
    billing: {
      tier: found.tier === 'free' ? 'free' : 'paid',
      capMicroUsd: found.spend_cap_micro_usd === null ? null : Number(found.spend_cap_micro_usd),
    },
  };
}

/**
 * How the fleet opens a tenant's database. Deliberately a port: resolving a
 * connection string is `secrets.ts`'s business and R11's boundary, and this
 * module has no resolve permission of its own.
 */
export interface TenantConnection {
  readonly sql: SQL;
  close(): Promise<void>;
}

export interface ConsolidateWorldDeps {
  /** The control plane, where the tier lives. */
  readonly controlSql: SQL;
  readonly connect: (tenantId: string) => Promise<TenantConnection>;
  /** One gateway per tenant, so BYOK resolution stays per-tenant (R22). */
  readonly gateway: (tenantId: string) => ModelGateway;
  readonly onCycle?: ConsolidatePorts['onCycle'];
}

/**
 * Thrown when a tenant cannot be consolidated at all. A throw rather than a
 * `free` cycle, because the runner's dead-letter ladder is the right place for
 * "this tenant is not servable" and a silently-free cycle would look like
 * success.
 */
export class TenantNotConsolidableError extends Error {
  readonly reason: 'unknown_tenant' | 'not_ready';

  constructor(tenantId: string, reason: 'unknown_tenant' | 'not_ready') {
    super(`tenant ${JSON.stringify(tenantId)} cannot be consolidated: ${reason}`);
    this.name = 'TenantNotConsolidableError';
    this.reason = reason;
  }
}

/**
 * The production `ConsolidatePorts`.
 *
 * The tier is read **at open time, per cycle** — not passed in by the caller,
 * not carried on the job row. A tier on the job row would be the tier that was
 * true when the job was enqueued, which for a queue with a retry ladder can be
 * days before the cycle runs.
 */
export function createConsolidateWorld(deps: ConsolidateWorldDeps): ConsolidatePorts {
  return {
    async open(tenantId: string): Promise<TenantWorld> {
      const lookup = await consolidationTierOf(deps.controlSql, tenantId);
      if (!lookup.ok) throw new TenantNotConsolidableError(tenantId, lookup.reason);

      const connection = await deps.connect(tenantId);
      return {
        sql: connection.sql,
        gateway: deps.gateway(tenantId),
        tier: lookup.billing.tier,
        capMicroUsd: lookup.billing.capMicroUsd,
        close: () => connection.close(),
      };
    },
    ...(deps.onCycle === undefined ? {} : { onCycle: deps.onCycle }),
  };
}
