/**
 * Turning a signup into a brain — the caller `provision.ts` and `pool.ts` never
 * had.
 *
 * **What was missing.** U2 shipped `provisionTenant`, U15 shipped
 * `assignPoolProject`, and nothing in `src/` called either. A full signup
 * through the real web app therefore completed with no tenant, which made three
 * separate pieces of shipped work unreachable at once: the warm pool, KTD9's
 * per-tenant FTS language (chosen on the form, validated, and then discarded),
 * and the free-tier connector gate — which could never be reached because
 * `tenantOf` answered `null` first and every connect attempt stopped at
 * `no_brain_yet`.
 *
 * **The pool is tried first, and an empty pool is a fallback rather than a
 * failure.** That is exactly the sentence `pool.ts`'s header makes — *"the loser
 * gets `pool_empty` and falls back to synchronous provisioning"* — and until this
 * module existed there was no code that could take either branch. A pool sized
 * `0` is the shipped default and means "provision synchronously", which is U2's
 * behaviour; it is a legal, meaningful configuration and not a disabled feature.
 *
 * **The bearer minter is not `createRandomBearerGrantMinter`, and that is
 * load-bearing.** A tenant bearer has to carry its own tenant id
 * (`bz…_<tenant>_<secret>`) because the edge derives Durable Object affinity from
 * the token *before* anything is verified (`oauth.ts:tenantOfToken`). The random
 * hex minter shipped in `provision.ts` produces a grant nothing can route: it
 * would be written to the secret store, returned to the user, and refused by the
 * first request that presented it. `mintTenantBearer` is the minter a deployed
 * fleet needs, and this is where that choice belongs — the composition root, not
 * the module's default.
 *
 * **The account id never reaches here.** The port takes a language and answers a
 * tenant id; the mapping between the two lives in `account.brain`, in the
 * identity database, which is the one place it is supposed to live. A control
 * plane that carried an account id would be a content-free database holding an
 * identifier that resolves to a person.
 */

import type { SQL } from 'bun';

import { mintTenantBearer } from '../mcp/oauth.ts';
import { createTenantSchemaApplier } from '../schema/apply.ts';
import { assignPoolProject } from './pool.ts';
import {
  provisionTenant,
  type NeonProjectApi,
  type TenantPrefixSource,
  type TenantRecord,
  type ControlPlaneStore,
} from './provision.ts';
import {
  controlPlaneIdentity,
  fleetIdentity,
  tenantNamespace,
  type PoolSecretStore,
  type TenantSecretStore,
} from './secrets.ts';

/** `t-`: an ordinary tenant, minted by a signup nobody was watching. */
export const DEFAULT_TENANT_ID_PREFIX = 't-';

/**
 * A prefix plus 96 bits of hex: inside `control.tenant_id`'s alphabet, and not
 * an account id.
 *
 * **The prefix is a parameter because the tenant id is the only thing that
 * reaches the vendor console.** `neonProjectName` derives the Neon project's
 * name from it and nothing else, so a deliberately-created tenant — a canary, an
 * internal fixture, a staging brain — is otherwise indistinguishable from a
 * stranger's in the one list an operator uses to decide what is safe to delete.
 * That is the failure this repository has already paid for once: a probe left
 * eighteen orphaned buckets behind, and what made them expensive was that
 * nothing named them. `provision.real.test.ts` reserves `bench-` and sweeps it
 * for the same reason; this makes the mechanism available to the composition
 * root rather than to one test.
 *
 * The caller is responsible for the composed id being legal — `isValidTenantId`
 * is the check, and `src/web/serve.ts` runs it at startup so an unusable prefix
 * is a refusal naming the variable rather than a signup that fails later.
 */
export function newTenantId(
  prefix: string = DEFAULT_TENANT_ID_PREFIX,
  random: (bytes: number) => Uint8Array = defaultRandom,
): string {
  return `${prefix}${Buffer.from(random(12)).toString('hex')}`;
}

function defaultRandom(bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return out;
}

export type ProvisionBrainOutcome =
  | { readonly ok: true; readonly tenantId: string; readonly via: 'pool' | 'synchronous' }
  | { readonly ok: false; readonly reason: string };

/**
 * The port the web app declares (U15's `WebAppDeps.provisioner`).
 *
 * A port rather than a store, for the reason every other boundary the web app
 * touches is one: R11 says that module holds no secret store and no tenant
 * connection, and provisioning needs both. The implementation runs in the
 * composition root, where the control-plane identity legitimately lives.
 */
export interface BrainProvisioner {
  provision(request: { readonly ftsLanguage: string }): Promise<ProvisionBrainOutcome>;
}

export interface BrainProvisionerDeps {
  readonly controlSql: SQL;
  readonly store: ControlPlaneStore;
  readonly secrets: TenantSecretStore & PoolSecretStore;
  readonly prefixes: TenantPrefixSource;
  /**
   * How many `ready` pool projects the deployment keeps. `0` means "provision
   * synchronously" and is the shipped default — the pool is sized by U2's
   * committed benchmark, which has not been run.
   */
  readonly poolTarget: number;
  /**
   * The substrate, when one is configured.
   *
   * Absent is a real deployment state, not an oversight: an operator running
   * entirely off a pre-filled pool has no vendor credential in the web process.
   * The refusal it produces names it rather than throwing a vendor error out of
   * a signup handler.
   */
  readonly neon?: NeonProjectApi;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export function createBrainProvisioner(deps: BrainProvisionerDeps): BrainProvisioner {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => newTenantId());
  const applier = createTenantSchemaApplier();

  return {
    async provision(request): Promise<ProvisionBrainOutcome> {
      // KTD9, at the cheapest possible moment. `provisionTenant` and
      // `assignPoolProject` both refuse an empty language, but a refusal here
      // costs no vendor call and no pool project.
      if (request.ftsLanguage.length === 0) return { ok: false, reason: 'missing_fts_language' };

      const tenantId = newId();

      if (deps.poolTarget > 0) {
        const assigned = await assignPoolProject(
          {
            sql: deps.controlSql,
            secrets: deps.secrets,
            caller: controlPlaneIdentity(),
            applySchema: (apply) => applier.apply(apply),
            mintBearer: (id) => Promise.resolve(mintTenantBearer(id)),
          },
          { tenantId, ftsLanguage: request.ftsLanguage, now: now() },
        );

        if (assigned.ok) {
          const banked = await bankPoolTenant(deps, {
            tenantId,
            ftsLanguage: request.ftsLanguage,
            project: assigned.project,
            schemaVersion: assigned.schemaVersion,
            at: now(),
          });
          return banked.ok ? { ok: true, tenantId, via: 'pool' } : banked;
        }

        // `pool_empty` is the documented fallback and nothing else is. A
        // `secret_unreadable` or an invalid id is a fault, and falling through
        // to a vendor call would spend money papering over it.
        if (assigned.reason !== 'pool_empty') return { ok: false, reason: assigned.reason };
      }

      if (deps.neon === undefined) {
        return { ok: false, reason: 'no_substrate_configured' };
      }

      const provisioned = await provisionTenant(
        {
          neon: deps.neon,
          schema: applier,
          store: deps.store,
          secrets: deps.secrets,
          storage: deps.prefixes,
          // See the header: the random hex minter shipped as `provision.ts`'s
          // default produces a grant the edge cannot route.
          bearer: { mint: (id) => Promise.resolve(mintTenantBearer(id)) },
          now: () => now().getTime(),
        },
        { tenantId, ftsLanguage: request.ftsLanguage },
      );

      return provisioned.ok
        ? { ok: true, tenantId, via: 'synchronous' }
        : { ok: false, reason: provisioned.reason };
    },
  };
}

/**
 * Write the control-plane row for a tenant the pool just handed over.
 *
 * `assignPoolProject` deliberately does not do this: it owns the *ordering* of
 * the claim, the schema and the secret, and the tenant row is the control
 * plane's. Two writes rather than one — `provisioning`, then `ready` under the
 * lease — because that is the shape `provisionTenant` uses and the shape the
 * `ready_tenants_are_fully_provisioned` CHECK is written against; a single
 * insert that went straight to `ready` would work today and would be the first
 * write site to skip the fence.
 *
 * **The reconcilable window, stated.** If this fails after the claim, the pool
 * row is `claimed` and names this tenant in `claimed_by`, and the tenant's secret
 * exists. Nothing is lost and nothing is served: the row an operator needs to
 * reconcile names exactly what to reconcile, which is why `pool_state` keeps
 * `claimed` and `retired` as states rather than deleting.
 */
async function bankPoolTenant(
  deps: BrainProvisionerDeps,
  request: {
    readonly tenantId: string;
    readonly ftsLanguage: string;
    readonly project: {
      readonly neonProjectId: string;
      readonly neonBranchId: string;
      readonly neonDatabase: string;
      readonly neonRole: string;
    };
    readonly schemaVersion: number;
    readonly at: Date;
  },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const prefix = deps.prefixes.prefixFor(fleetIdentity(request.tenantId), request.tenantId);
  if (!prefix.ok) return { ok: false, reason: 'storage_prefix_failed' };

  const claimed: TenantRecord = {
    tenantId: request.tenantId,
    state: 'provisioning',
    tier: 'free',
    schemaVersion: 0,
    ftsLanguage: request.ftsLanguage,
    neonProjectId: request.project.neonProjectId,
    neonBranchId: request.project.neonBranchId,
    neonDatabase: request.project.neonDatabase,
    neonRole: request.project.neonRole,
    connectionSecretRef: tenantNamespace(request.tenantId),
    bearerSecretRef: tenantNamespace(request.tenantId),
    storagePrefix: prefix.prefix,
    provisioningStartedAt: request.at.getTime(),
    provisioningAttempts: 1,
    // The first lease. Every write below names it, so a second run cannot
    // overwrite this one's `ready` with its own failure.
    provisioningLease: 1,
    readyAt: null,
    failureCode: null,
  };

  const inserted = await deps.store.insert(claimed);
  if (!inserted.inserted) return { ok: false, reason: 'tenant_id_in_use' };

  const ready = await deps.store.update(request.tenantId, claimed.provisioningLease, {
    state: 'ready',
    schemaVersion: request.schemaVersion,
    readyAt: request.at.getTime(),
  });
  return ready.applied ? { ok: true } : { ok: false, reason: 'lease_lost' };
}
