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
 *
 * **The cap this hands out is what is *left* of the window, never the column.**
 * `spend_cap_micro_usd` is a ceiling on the rolling window U20's meter
 * accumulates into; passing it through unsubtracted turns it into a per-cycle
 * allowance that resets whenever the scheduler comes round, which bounds
 * nothing. The tier decides *whether* the model phases run; this number decides
 * how far, and both come off the same row in the same read.
 */

import type { SQL } from 'bun';

import { DEFAULT_SPEND_WINDOW_SECONDS, type ModelGateway } from '../ai/gateway.ts';
import type { ConsolidatePorts, TenantWorld } from '../worker/consolidate/cycle.ts';

export type ConsolidationTier = 'free' | 'paid';

export interface TenantBilling {
  readonly tier: ConsolidationTier;
  /**
   * What is **left** of the tenant's rolling cap, not the cap itself.
   *
   * The distinction is the whole of it. `control.tenant.spend_cap_micro_usd` is
   * the ceiling on a window that U20's meter rolls once a billing month; handing
   * the raw column to a cycle makes it a *per-cycle* allowance instead, and a
   * tenant sitting exactly on their cap gets another whole one every time the
   * scheduler comes round. That is not a smaller cap than intended, it is no cap
   * at all, and it fails in the direction that costs money rather than the
   * direction that produces a support ticket.
   *
   * `0` is a real cap of nothing — `budgetsFor` reads it as the free tier's
   * ceiling and refuses every priced call, which is exactly right for a tenant
   * whose window is spent.
   *
   * **`null` is not "the platform default"**, whatever the column's own comment
   * says the *ingest* gate does with it. Nothing here supplies a ceiling for it:
   * a null reaches `budgetsFor` as "no tenant cap", where each phase is bounded
   * by the cycle's own estimate. That is the reading the `internal` tier depends
   * on — the canary and the founders' own brains carry no cap row and are the
   * tenants that most need their phases to run.
   */
  readonly capMicroUsd: number | null;
}

export type TierLookup =
  | { readonly ok: true; readonly billing: TenantBilling }
  | { readonly ok: false; readonly reason: 'unknown_tenant' | 'not_ready' };

/**
 * Read the tier the cycle must run at, and **what is left of the window's cap**.
 *
 * One statement, no cache. A cached tier is a downgrade that has not taken
 * effect yet, and the window is exactly the one an attacker or an unhappy
 * customer would spend. The counter is read in the same statement for the same
 * reason: a spend total fetched separately is a total from before whatever ran
 * in between.
 *
 * **The subtraction is the cap.** The column is the ceiling on a rolling window,
 * which is what `control.tenant`'s own comment says and what
 * `first-import.ts:readHeadroom` already does with it — and this reader used to
 * hand the raw column to every cycle, so a tenant on their cap was refused every
 * import and granted a fresh full budget by every consolidation. One column may
 * not mean two things; the reading that costs money is the one to change.
 *
 * **A lapsed window reads as zero spend, and that is the one unknown that reads
 * *open*.** U20's meter rolls `spend_window_started_at` only inside the UPDATE
 * that accumulates, so a tenant whose last model call was five weeks ago still
 * carries last month's total in a column nobody has reset. Charging them for it
 * would be a wrong refusal rather than a safety property — the same reading
 * `readHeadroom` takes, deliberately, because two readers of one column that
 * disagree about when it expires is the bug this function just had.
 *
 * `now` is injected rather than read off the wall clock so the boundary is
 * testable without the test becoming true by the passage of time.
 */
export async function consolidationTierOf(
  controlSql: SQL,
  tenantId: string,
  options: { readonly now?: Date; readonly windowSeconds?: number } = {},
): Promise<TierLookup> {
  const now = options.now ?? new Date();
  const windowSeconds = options.windowSeconds ?? DEFAULT_SPEND_WINDOW_SECONDS;

  const rows = await controlSql<
    {
      tier: string;
      state: string;
      spend_cap_micro_usd: string | null;
      spend_micro_usd: string;
      spend_window_started_at: Date;
    }[]
  >`
    SELECT tier::text AS tier, state::text AS state, spend_cap_micro_usd,
           spend_micro_usd, spend_window_started_at
    FROM control.tenant WHERE tenant_id = ${tenantId}`;

  const found = rows[0];
  if (found === undefined) return { ok: false, reason: 'unknown_tenant' };
  if (found.state !== 'ready') return { ok: false, reason: 'not_ready' };

  const windowLapsed =
    now.getTime() - found.spend_window_started_at.getTime() >= windowSeconds * 1_000;
  const spent = windowLapsed ? 0 : Number(found.spend_micro_usd);
  const cap = found.spend_cap_micro_usd === null ? null : Number(found.spend_cap_micro_usd);

  return {
    ok: true,
    billing: {
      tier: found.tier === 'free' ? 'free' : 'paid',
      // Floored, and not only for tidiness: `budgetsFor` treats a cap of `<= 0`
      // as the free tier's ceiling, so a negative remainder — an operator
      // lowering the dial under a tenant who has already spent past it — would
      // land on the same branch as zero anyway. Making it explicit means nothing
      // downstream has to know that.
      capMicroUsd: cap === null ? null : Math.max(0, cap - spent),
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
