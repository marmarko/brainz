/**
 * The five-leg account erasure runbook (R12), and its fourth leg's first caller.
 *
 * ============================================================================
 * THE LEG THAT WAS MISSING
 * ============================================================================
 *
 * `PipedreamClient.deleteExternalUser` has existed since U9 with **no caller
 * anywhere in `src/`**, left deliberately for this unit because half an erasure
 * pipeline would have been worse than the gap. This module is that caller.
 * Without it, live OAuth tokens to the erased user's mailbox persist at a vendor
 * inside the trust boundary, and "no queryable trace" is a false sentence in a
 * privacy policy.
 *
 * **The receipt does not launder the vendor's honesty.** `deleteExternalUser`
 * classifies a 404/410 as `already_absent` rather than `deleted`, and reports
 * `tokensRevoked: 'unverified'` because whether the vendor's deletion revokes
 * the grant *at Google* is a question nobody has answered in writing
 * (`docs/vendor/2026-08-12-pipedream-compliance.md`, Q2). Both travel into the
 * receipt verbatim. When the answer arrives, the literal and its test change
 * together — not this module's summary of them.
 *
 * ============================================================================
 * ORDER, AND WHY IT IS NOT "DELETE THE DATABASE FIRST"
 * ============================================================================
 *
 * **Credentials first, data last.** A run that dropped the Neon project and then
 * died would leave a live OAuth grant polling a mailbox into a tenant that no
 * longer exists — an inflow with nowhere to land and nobody watching. So:
 * connector, provider key, object store, database, and the control-plane row
 * **last**, because that row is the only record of what the other four legs were
 * supposed to target.
 *
 * That ordering has a consequence the tests pin: **a failed leg leaves the
 * control-plane row standing.** The alternative — delete the row anyway — is an
 * erasure that reports success while orphaning whatever the failed leg held,
 * with nothing left in the system that knows the orphan's name. The row survives,
 * the receipt says `complete: false`, and a re-run finishes the job. Erasure is
 * idempotent: every leg treats an already-absent target as success.
 *
 * ============================================================================
 * A SIXTH STORE, NAMED RATHER THAN DISCOVERED LATER
 * ============================================================================
 *
 * The tenant's secret-store entries — the connection string and the fleet bearer
 * — are not one of the five legs the roadmap names, and they are real. They are
 * erased inside leg 5, in the same step as the control-plane row, because they
 * are the control plane's own record of the tenant rather than another party's
 * copy of the user's content. Leaving them behind would leave a credential to a
 * database that no longer exists: harmless in effect, and dishonest in a receipt
 * that claims no trace.
 *
 * **What is deliberately NOT here:** the row in the identity database
 * (`account.brain`). Deleting a brain and closing an account are different acts —
 * a user may erase their brain and keep their login — and the account lifecycle
 * is U15's. This module erases a *brain*; a caller that is closing an account
 * runs both.
 *
 * **The storage wart, inherited knowingly.** `storage.ts` gates prefix derivation
 * on the fleet identity for that tenant, so this module constructs one to derive
 * the prefix it must empty — exactly as `src/control/provision.ts` does, and for
 * the same reason. The dependency declared is `TenantPrefixSource`, which has
 * `prefixFor` and nothing else, so this module is type-incapable of asking for an
 * object-storage credential even though the accessor it is handed can mint one.
 */

import type { SQL } from 'bun';

import type { TenantProviderKeyStore } from '../../ai/keys.ts';
import type { TenantPrefixSource } from '../../control/provision.ts';
import { fleetIdentity, type CallerIdentity, type TenantSecretWriter } from '../../control/secrets.ts';
import type { TenantPrefix } from '../../control/storage.ts';
import type { ClientOutcome, ExternalUserDeletion } from '../../ingest/pipedream/client.ts';

/**
 * The five legs, in the order they run.
 *
 * Exported as a frozen list rather than described in prose so a test can assert
 * the runbook still has five legs — a leg quietly dropped during a refactor is
 * the failure this whole module is about.
 */
export const ERASURE_LEGS = [
  'connector',
  'provider_key',
  'object_store',
  'neon',
  'control_plane',
] as const;

export type ErasureLeg = (typeof ERASURE_LEGS)[number];

/**
 * `already_absent` is not a weaker `done` — it is the honest word for a target
 * that was not there, and it is what makes a re-run reportable. `skipped` says
 * a leg did not run because an earlier one failed, which is a different fact
 * from failing.
 */
export type LegStatus = 'done' | 'already_absent' | 'failed' | 'skipped';

export interface LegOutcome {
  readonly leg: ErasureLeg;
  readonly status: LegStatus;
  /** What was removed, where a count is meaningful. */
  readonly removed?: number;
  /** Why it failed or was skipped. Never a stack, never a credential. */
  readonly detail?: string;
}

export interface ErasureReceipt {
  readonly tenantId: string;
  readonly legs: readonly LegOutcome[];
  /** True only when every leg is `done` or `already_absent`. */
  readonly complete: boolean;
  /**
   * What the connector vendor established about the grant itself.
   *
   * `unverified` until Q2 has a written answer. See the header — this is the
   * sentence that ends up in a privacy policy.
   */
  readonly tokensRevoked: 'confirmed' | 'unverified' | 'not_applicable';
  /**
   * The stated deletion SLA: the platform's point-in-time-recovery window.
   *
   * Rows stop being *queryable* when the leg returns. They stop being
   * *recoverable* when this window rolls, and the second number is the one a
   * data-subject answer has to quote — quoting the first would be claiming an
   * irreversibility the substrate does not provide yet.
   */
  readonly unrecoverableAfterDays: number;
  readonly erasedAt: string;
}

/**
 * The object store, with the two methods erasure needs.
 *
 * Declared here because U8's `RawStore` has only `put` and `get` — it was built
 * for preserving payloads, and nothing in the product had ever needed to enumerate
 * or empty a prefix. Deliberately takes a derived {@link TenantPrefix} rather than
 * a tenant id, exactly as `ScopedCredentialMinter` does, so no implementation of
 * this port can participate in prefix derivation.
 */
export interface ErasableObjectStore {
  list(prefix: TenantPrefix): Promise<readonly string[]>;
  /** Returns how many objects went. Deleting an empty prefix is a success. */
  deletePrefix(prefix: TenantPrefix): Promise<number>;
}

/** The one method erasure needs from U9's client. Narrow on purpose. */
export interface ExternalUserEraser {
  deleteExternalUser(request: {
    readonly externalUserId: string;
  }): Promise<ClientOutcome<ExternalUserDeletion>>;
}

/** The one method erasure needs from the provider. Idempotent by its own contract. */
export interface ProjectEraser {
  deleteProject(projectId: string): Promise<void>;
}

export interface ErasureDeps {
  readonly connect: ExternalUserEraser;
  readonly providerKeys: TenantProviderKeyStore;
  readonly objects: ErasableObjectStore;
  readonly neon: ProjectEraser;
  readonly secrets: TenantSecretWriter;
  readonly storage: TenantPrefixSource;
  /** The control plane's own connection. `accounts.ts` takes the same shape. */
  readonly control: SQL;
  /** Must be the control-plane identity; the secret and key stores enforce it. */
  readonly caller: CallerIdentity;
  readonly now?: () => Date;
}

/**
 * The platform's point-in-time-recovery window, in days.
 *
 * **This number is the Neon plan default, not a value this codebase asserts.**
 * Provisioning does not pin the project's history-retention setting, so an
 * operator changing the plan changes the SLA without changing any code. That is
 * recorded here rather than in a support macro, and pinning retention at
 * provision time is the follow-up that turns the SLA into a property of the
 * system instead of a property of the invoice.
 */
export const PITR_WINDOW_DAYS = 7;

/**
 * Erase one brain across every store that holds any part of it.
 *
 * Each leg is attempted independently and reports its own outcome — a vendor
 * that is down must not hold the user's own database hostage — except the
 * control-plane row, which runs only when everything else succeeded.
 */
export async function eraseAccount(
  deps: ErasureDeps,
  request: { readonly tenantId: string },
): Promise<ErasureReceipt> {
  const at = (deps.now?.() ?? new Date()).toISOString();
  const legs: LegOutcome[] = [];
  let tokensRevoked: ErasureReceipt['tokensRevoked'] = 'not_applicable';

  // ---- Leg 1: the connector vendor. First, so the inflow stops before the
  // stores it was flowing into go away.
  try {
    const outcome = await deps.connect.deleteExternalUser({ externalUserId: request.tenantId });
    if (!outcome.ok) {
      legs.push({ leg: 'connector', status: 'failed', detail: outcome.reason });
    } else {
      tokensRevoked = outcome.value.tokensRevoked;
      legs.push({
        leg: 'connector',
        status: outcome.value.evidence === 'already_absent' ? 'already_absent' : 'done',
        detail: outcome.value.evidence,
      });
    }
  } catch (error) {
    legs.push({ leg: 'connector', status: 'failed', detail: messageOf(error) });
  }

  // ---- Leg 2: the tenant's stored BYOK provider key (R22). Every provider in
  // one call, so none is forgotten by an enumeration that drifted.
  try {
    const outcome = await deps.providerKeys.revokeAll(deps.caller, request.tenantId);
    legs.push(
      outcome.ok
        ? { leg: 'provider_key', status: 'done' }
        : { leg: 'provider_key', status: 'failed', detail: outcome.reason },
    );
  } catch (error) {
    legs.push({ leg: 'provider_key', status: 'failed', detail: messageOf(error) });
  }

  // ---- Leg 3: the object-storage prefix.
  const prefix = deps.storage.prefixFor(fleetIdentity(request.tenantId), request.tenantId);
  if (!prefix.ok) {
    legs.push({ leg: 'object_store', status: 'failed', detail: prefix.reason });
  } else {
    try {
      const before = await deps.objects.list(prefix.prefix);
      const removed = await deps.objects.deletePrefix(prefix.prefix);
      legs.push({
        leg: 'object_store',
        status: before.length === 0 ? 'already_absent' : 'done',
        removed,
      });
    } catch (error) {
      legs.push({ leg: 'object_store', status: 'failed', detail: messageOf(error) });
    }
  }

  // ---- Leg 4: the Neon project. Read from the control-plane row, because the
  // derived name is a fallback for a project whose id was lost and the id is
  // what the vendor actually keys on.
  try {
    const rows = (await deps.control`
      SELECT neon_project_id FROM control.tenant WHERE tenant_id = ${request.tenantId}
    `) as Array<{ neon_project_id: string | null }>;
    const projectId = rows[0]?.neon_project_id ?? null;
    if (rows.length === 0 || projectId === null) {
      legs.push({ leg: 'neon', status: 'already_absent', detail: 'no project recorded' });
    } else {
      await deps.neon.deleteProject(projectId);
      legs.push({ leg: 'neon', status: 'done' });
    }
  } catch (error) {
    legs.push({ leg: 'neon', status: 'failed', detail: messageOf(error) });
  }

  // ---- Leg 5: the control-plane row and the secrets it pointed at. Only when
  // everything above succeeded: this row is the only record of what the other
  // legs were supposed to target, and deleting it after a failure orphans
  // whatever the failed leg held under a name nothing can recover.
  const blocked = legs.find((leg) => leg.status === 'failed');
  if (blocked !== undefined) {
    legs.push({
      leg: 'control_plane',
      status: 'skipped',
      detail: `${blocked.leg} did not complete — this row is the only record of what to retry`,
    });
  } else {
    try {
      const revoked = await deps.secrets.revoke(deps.caller, request.tenantId);
      if (!revoked.ok) {
        legs.push({ leg: 'control_plane', status: 'failed', detail: revoked.reason });
      } else {
        const deleted = (await deps.control`
          DELETE FROM control.tenant WHERE tenant_id = ${request.tenantId} RETURNING tenant_id
        `) as Array<{ tenant_id: string }>;
        legs.push({
          leg: 'control_plane',
          status: deleted.length === 0 ? 'already_absent' : 'done',
          removed: deleted.length,
        });
      }
    } catch (error) {
      legs.push({ leg: 'control_plane', status: 'failed', detail: messageOf(error) });
    }
  }

  return {
    tenantId: request.tenantId,
    legs,
    complete: legs.every((leg) => leg.status === 'done' || leg.status === 'already_absent'),
    tokensRevoked,
    unrecoverableAfterDays: PITR_WINDOW_DAYS,
    erasedAt: at,
  };
}

/** A message, never an object: a thrown vendor error can carry a credential. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown_error';
}
