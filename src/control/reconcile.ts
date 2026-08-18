/**
 * What the fleet is paying for that nothing is going to finish, and whose it is.
 *
 * ============================================================================
 * THE GAP: TWO OF THE THREE LIFECYCLE STATES ARE UNREACHABLE
 * ============================================================================
 *
 * `control.tenant_state` declares four values and the schema's own gloss says
 * what each is for: `provisioning` is where every row starts and where a crashed
 * run leaves it, `failed` is a run that stopped and said why, `deleting` is
 * U17's teardown. Read against `src/`:
 *
 *   * **`deleting` has no writer anywhere.** Three consumers read it — a claim
 *     refuses one, the schema sweep skips one, the tier lane denies one a cycle
 *     — and nothing in `src/` ever writes it. The only write in the tree is a
 *     test fixture.
 *   * **`eraseAccount` has no production caller.** The five-leg teardown is
 *     fully built and fully unwired.
 *   * **`failed` rows are permanent orphans by construction.** The retry that
 *     was supposed to claim one and clean up after it (`cleanUpAfterFailedAttempt`)
 *     is reached only when a caller re-invokes provisioning with the *same*
 *     tenant id, and the one production caller mints a fresh id every time. The
 *     product's own copy says so: "provisioning failed while you were signing up
 *     — the account was created, the brain was not. This page is how you get
 *     one." A new brain, under a new id. The old row, and the Neon project it
 *     names, stay forever.
 *
 * So a failed signup leaves a billable database nothing will ever reach, a
 * half-torn-down account leaves a row nothing will ever finish, and the only
 * tool anybody had for either was the vendor's console — where a project's name
 * is derived from a tenant id and nothing else, and a throwaway and a person's
 * brain are the same string. That is not hypothetical. A deployment's worth of
 * tenants was once deleted by prefix on exactly that basis and one of them was a
 * real user's.
 *
 * ============================================================================
 * THIS REPORTS. IT DOES NOT SWEEP.
 * ============================================================================
 *
 * The argument is already written down twice in this codebase and both halves
 * apply here.
 *
 * `src/web/admin.ts` on why the directory is a GET: *"the safe step is the easy
 * one. An operator who has to construct a POST to find out whose brain a tenant
 * is will skip finding out."* A reconciler that acts by default inverts exactly
 * that — it makes the destructive step the easy one, on the surface whose
 * comments are a postmortem of a destructive step taken too easily.
 *
 * And the first run of any sweep meets the entire accumulated backlog at once.
 * The deletion floor underneath it is the platform's point-in-time-recovery
 * window and nothing before that. A default-act reconciler's first output is a
 * fleet-wide deletion nobody reviewed.
 *
 * So {@link reconcileTenants} classifies and proposes; acting is opt-in, needs
 * an explicit id list, and needs a `teardown` port the reporting composition
 * does not pass. **That last part is the containment that matters**: `/admin`
 * does not merely decline to act, it is handed a `ReconcilePorts` with no
 * teardown on it at all, so the capability is absent rather than unused — the
 * same shape `worker/serve.ts` uses for the export destinations it cannot build
 * and `web/serve.ts` for the credential minter it will not fake.
 *
 * ============================================================================
 * FOUR GUARDS, EACH WITH A PRECEDENT
 * ============================================================================
 *
 * 1. **Resolve to an owner first, and refuse if the lookup is unavailable.**
 *    "I could not see the owners" and "nobody owns these" are different
 *    sentences and an operator acts on them identically if the surface prints
 *    the same thing for both. Since the thing they act on is a deletion, the
 *    difference is the whole safety property. {@link OwnerCensus} makes it a
 *    typed answer and {@link reconcileTenants} refuses rather than guessing.
 * 2. **Refuse anything that reached ready**, through {@link hasReachedReady} —
 *    `provision.ts`'s own guard, imported rather than restated, checking
 *    `readyAt` as well as `state` for the reason stated there.
 * 3. **Act only on an explicit id list.** No prefix, no pattern, no "every
 *    `failed` row older than N days". `BRAINZ_TENANT_ID_PREFIX` marks the
 *    tenants a *deployment* mints and cannot separate two tenants it gives the
 *    same prefix to; the vendor's own project search is a substring match. A
 *    pattern may **report**. Only an id an operator typed may destroy.
 * 4. **Grade nothing.** There is no `safe_to_delete` field here and there will
 *    not be one. The brain that was deleted had never been used — no activity,
 *    no content, a `last_activity` of never — so every heuristic such a field
 *    could be built from would have said *disposable*, and it was the founder's.
 *    The one fact that separated it from the throwaways beside it is that
 *    somebody owned it. This puts the owner next to the id and stops.
 *
 * ============================================================================
 * WHY THE TEARDOWN IS `eraseAccount` AND NOT `cleanUpAfterFailedAttempt`
 * ============================================================================
 *
 * `cleanUpAfterFailedAttempt` is *retry*-shaped: it keeps the control-plane row
 * so the next attempt can use it. A reconciler running long after a signup has
 * no next attempt — the user either never came back or already has a different
 * brain under a fresh id. `eraseAccount` is teardown-shaped: every leg treats an
 * already-absent target as success, the row is deleted last because it is the
 * only record of what the other legs were supposed to target, and a failed leg
 * leaves it standing with `complete: false` so a re-run finishes the job. That
 * is what a sweep wants, and `provision.ts` already states the rule against
 * writing a second one: "Two cleanup implementations would drift, and the one
 * that runs less often would be the wrong one."
 */

import { hasReachedReady, type TenantState } from './provision.ts';

/**
 * One control-plane row, narrowed to what a classification needs.
 *
 * Deliberately not `TenantRecord`. Every field here is a state, an instant or a
 * boolean-shaped presence check; nothing on this type can carry a connection
 * string, a project name or a spend figure, so no future field on the row
 * becomes reachable from this module by accident.
 */
export interface TenantResidue {
  readonly tenantId: string;
  readonly state: TenantState;
  readonly readyAt: number | null;
  readonly neonProjectId: string | null;
  readonly connectionSecretRef: string | null;
}

/**
 * What kind of leftover this is, named after the provisioning prefix that
 * produced it.
 *
 * The classes are the observable residue of each step in the two provisioning
 * lanes, and the recognition is exact rather than heuristic:
 * `neon_project_id IS NULL` means the run died before the vendor call;
 * `connection_secret_ref IS NULL` means it died before the credential; a `ready`
 * row with no owner means it died at the hand-off to the identity database.
 */
export type ResidueClass =
  /** Reached ready. Not residue at all, and reported so it is visibly excluded. */
  | 'live'
  /** A run may still be moving. Only a lease-aware caller can know; this one is not. */
  | 'provisioning_in_flight'
  /** U17's teardown started and stopped. The legs are idempotent; resume it. */
  | 'teardown_interrupted'
  /** Failed before the vendor was called. A row, and nothing billable. */
  | 'failed_before_project'
  /** Failed after the project was created. **A database nobody is reaching.** */
  | 'failed_with_project'
  /** Failed after the credential was written. A project and live credential material. */
  | 'failed_with_credential'
  /** A secret namespace with no control-plane row behind it. */
  | 'orphan_secret'
  /** An `account.brain` row naming a tenant the control plane has never heard of. */
  | 'orphan_brain_link';

/** What still exists under this id, so a receipt can say what a teardown would reach. */
export type ResidueHolding = 'control_row' | 'neon_project' | 'connection_secret' | 'brain_link';

/** What this reconciler would do about it, if asked. */
export type ResidueProposal =
  /** Tear it down. Nothing owns it and it never served anybody. */
  | 'teardown'
  /** Finish what U17 started. The legs are idempotent and the decision is recorded. */
  | 'resume_teardown'
  /** Nothing, and {@link ReconcileFinding.refusedBecause} says why. */
  | 'none';

export type ResidueRefusal =
  /** Guard 2. This row served a user. */
  | 'reached_ready'
  /** Guard 1. Somebody's `account.brain` row names it. */
  | 'owned'
  /** A run may still be finishing. A sweep is not the thing that decides. */
  | 'provisioning_in_flight'
  /**
   * A namespace or a link with no row behind it. There is no record of what else
   * it pointed at, so a human decides. See {@link classifyResidue}.
   */
  | 'no_control_row';

export interface ReconcileFinding {
  readonly tenantId: string;
  readonly residue: ResidueClass;
  /**
   * Whether an `account.brain` row names this tenant. **Never who.** The owner
   * lookup this module is given has already reduced an address to a presence,
   * so nothing downstream of it can publish a domain, a digest or a mailbox —
   * the same narrowing `admin.ts` applies one layer up, applied again here
   * because a reconciler's output is the artifact that ends up in a ticket.
   */
  readonly owned: boolean;
  readonly holds: readonly ResidueHolding[];
  readonly proposal: ResidueProposal;
  readonly refusedBecause?: ResidueRefusal;
}

/**
 * Who owns what, reduced to a set of ids.
 *
 * **`ok: false` is a first-class answer and not an error to swallow.** It is the
 * reason `tenantDirectory` refuses rather than reporting every tenant as
 * unowned, and it is load-bearing for exactly the same reason here.
 *
 * Ids and nothing else: this module needs to know *whether* a brain is
 * somebody's, never whose, so it is given a type that cannot answer the second
 * question.
 */
export type OwnerCensus =
  | { readonly ok: true; readonly ownedTenantIds: ReadonlySet<string> }
  | { readonly ok: false };

/**
 * What the reconciler is given. Two reads, one optional destructive port.
 *
 * The teardown is optional **and that is the whole containment**: a reporting
 * composition passes an object without it, so `act` is not merely declined but
 * unrepresentable for that caller. See the header.
 */
export interface ReconcilePorts {
  /** Every control-plane row, narrowed. */
  tenants(): Promise<readonly TenantResidue[]>;
  /**
   * Tenant ids that have a secret-store namespace.
   *
   * **List-only, no `get`.** Finding an orphaned namespace needs an enumeration
   * the secret store does not currently expose, and the narrow port is what
   * keeps this module type-incapable of reading a connection string — the same
   * discipline `TenantSecretWriter` and `TenantPrefixSource` already apply.
   */
  secretNamespaces(): Promise<readonly string[]>;
  owners(): Promise<OwnerCensus>;
  /** Absent on any composition that may only report. */
  readonly teardown?: (tenantId: string) => Promise<TeardownReceipt>;
}

/**
 * What a teardown reported. Structurally `eraseAccount`'s receipt, declared here
 * so this module depends on the shape rather than on the module.
 */
export interface TeardownReceipt {
  readonly tenantId: string;
  /** `false` means a leg did not finish and the row is deliberately still there. */
  readonly complete: boolean;
}

export interface ReconcileRequest {
  /**
   * The ids to act on. **Required to act and ignored when reporting** — guard 3.
   * A report is over the whole fleet because a list an operator reads before
   * deciding must not be filtered by the decision.
   */
  readonly ids?: readonly string[];
  readonly act?: boolean;
  readonly limit?: number;
}

export type ReconcileOutcome =
  | {
      readonly ok: true;
      readonly findings: readonly ReconcileFinding[];
      /** The fleet's count, not the page's — the number somebody about to delete needs. */
      readonly total: number;
      readonly truncated: boolean;
      readonly acted: readonly TeardownReceipt[];
    }
  | {
      readonly ok: false;
      readonly reason:
        /** Guard 1: reporting every tenant as unowned is the incident again. */
        | 'owner_lookup_unavailable'
        /** Guard 3: a sweep without an explicit id list is a sweep by pattern. */
        | 'act_needs_an_explicit_id_list'
        /** This composition holds no teardown. Not a refusal of policy — of capability. */
        | 'teardown_unavailable';
    };

/**
 * How many findings one report returns.
 *
 * The same cap and the same argument as `TENANT_DIRECTORY_LIMIT`: this answer
 * grows with the fleet, and an operator endpoint that materialises every tenant
 * into one JSON body is a container that falls over on the day it is most
 * needed.
 */
export const RECONCILE_LIMIT = 500;

/**
 * Classify one row against the two provisioning lanes' creation order.
 *
 * Pure, and exported so the prefix table is a tested property rather than a
 * paragraph. The order of the branches is the safety order: reaching ready is
 * checked before anything else, because a row that served a user is not residue
 * whatever else is true of it.
 */
export function classifyResidue(row: TenantResidue): ResidueClass {
  if (hasReachedReady(row)) return 'live';
  if (row.state === 'deleting') return 'teardown_interrupted';
  if (row.state === 'provisioning') return 'provisioning_in_flight';
  if (row.neonProjectId === null) return 'failed_before_project';
  if (row.connectionSecretRef === null) return 'failed_with_project';
  return 'failed_with_credential';
}

/**
 * What one classified row holds, so a receipt names what a teardown would reach
 * rather than implying it.
 */
function holdingsOf(row: TenantResidue, owned: boolean): readonly ResidueHolding[] {
  const holds: ResidueHolding[] = ['control_row'];
  if (row.neonProjectId !== null) holds.push('neon_project');
  if (row.connectionSecretRef !== null) holds.push('connection_secret');
  if (owned) holds.push('brain_link');
  return holds;
}

/**
 * Decide what to propose, and refuse out loud rather than by omission.
 *
 * **Ownership blocks a `failed` teardown and deliberately does NOT block a
 * `deleting` one.** The two are different questions. A `failed` row with an
 * owner is somebody's half-made brain and the sweep has no business touching it.
 * A `deleting` row with an owner is an account closure that already started and
 * stopped — refusing on ownership there would strand exactly the rows U17's
 * teardown was designed to be resumable for, forever, and the decision to delete
 * is recorded in the state itself.
 */
function proposalFor(
  residue: ResidueClass,
  owned: boolean,
): { proposal: ResidueProposal; refusedBecause?: ResidueRefusal } {
  switch (residue) {
    case 'live':
      return { proposal: 'none', refusedBecause: 'reached_ready' };
    case 'provisioning_in_flight':
      // A run holding a lease may still be moving, and a lease is a thing this
      // module cannot see. The reaper and the retry are the mechanisms that
      // decide a provisioning row's fate; a sweep guessing at it would race
      // exactly the interleave the lease exists to survive.
      return { proposal: 'none', refusedBecause: 'provisioning_in_flight' };
    case 'teardown_interrupted':
      return { proposal: 'resume_teardown' };
    case 'orphan_secret':
    case 'orphan_brain_link':
      // Reported, never proposed. The control-plane row is the only record of
      // what the other stores held, so a residue with no row behind it is a
      // residue whose blast radius nothing can compute — and the one live
      // example of this class is the leftover of a hand-deletion, which is the
      // argument for a human reading it rather than a sweep guessing.
      return { proposal: 'none', refusedBecause: 'no_control_row' };
    default:
      return owned ? { proposal: 'none', refusedBecause: 'owned' } : { proposal: 'teardown' };
  }
}

/**
 * The one entry point. Reports by default; acts only on an explicit id list, and
 * only through a port the caller was given.
 */
export async function reconcileTenants(
  ports: ReconcilePorts,
  request: ReconcileRequest = {},
): Promise<ReconcileOutcome> {
  const act = request.act === true;
  const ids = request.ids ?? [];

  // Guard 3, checked before either read: a sweep with no id list is a sweep by
  // pattern, and the refusal costs nothing when it happens first.
  if (act && ids.length === 0) {
    return { ok: false, reason: 'act_needs_an_explicit_id_list' };
  }
  if (act && ports.teardown === undefined) {
    return { ok: false, reason: 'teardown_unavailable' };
  }

  // Guard 1, and it is the read that may refuse the whole operation.
  const census = await ports.owners();
  if (!census.ok) return { ok: false, reason: 'owner_lookup_unavailable' };
  const owned = census.ownedTenantIds;

  const rows = await ports.tenants();
  const known = new Set(rows.map((row) => row.tenantId));

  const findings: ReconcileFinding[] = rows.map((row) => {
    const residue = classifyResidue(row);
    const isOwned = owned.has(row.tenantId);
    return {
      tenantId: row.tenantId,
      residue,
      owned: isOwned,
      holds: holdingsOf(row, isOwned),
      ...proposalFor(residue, isOwned),
    };
  });

  // The two reverse classes: residue that survives its control-plane row. Both
  // exist in the wild, and neither is reachable from the loop above because the
  // loop is driven by rows.
  for (const tenantId of await ports.secretNamespaces()) {
    if (known.has(tenantId)) continue;
    known.add(tenantId);
    findings.push({
      tenantId,
      residue: 'orphan_secret',
      owned: owned.has(tenantId),
      holds: ['connection_secret', ...(owned.has(tenantId) ? (['brain_link'] as const) : [])],
      ...proposalFor('orphan_secret', owned.has(tenantId)),
    });
  }
  for (const tenantId of owned) {
    if (known.has(tenantId)) continue;
    findings.push({
      tenantId,
      residue: 'orphan_brain_link',
      owned: true,
      holds: ['brain_link'],
      ...proposalFor('orphan_brain_link', true),
    });
  }

  // Sorted by id, because a stable order is what a `diff` and a `grep` both
  // want — and because ordering by any notion of risk would be the discredited
  // heuristic of guard 4 wearing a different hat.
  findings.sort((left, right) => left.tenantId.localeCompare(right.tenantId));

  const total = findings.length;
  const limit = Math.min(Math.max(1, Math.floor(request.limit ?? RECONCILE_LIMIT)), RECONCILE_LIMIT);
  const page = act ? findings : findings.slice(0, limit);

  const acted: TeardownReceipt[] = [];
  if (act && ports.teardown !== undefined) {
    const wanted = new Set(ids);
    for (const finding of findings) {
      if (!wanted.has(finding.tenantId)) continue;
      // The guards again, at the moment of acting rather than only at the moment
      // of proposing. A caller that read a report, then named an id whose row
      // moved to `ready` in between, must not be honoured on the strength of the
      // older answer — which is the same staleness `provision.ts` fences with a
      // lease and for the same reason.
      if (finding.proposal !== 'teardown' && finding.proposal !== 'resume_teardown') continue;
      acted.push(await ports.teardown(finding.tenantId));
    }
  }

  return {
    ok: true,
    findings: act ? page.filter((finding) => ids.includes(finding.tenantId)) : page,
    total,
    truncated: total > page.length,
    acted,
  };
}
