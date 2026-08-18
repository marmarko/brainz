/**
 * Synchronous tenant provisioning (U2 approach steps 2, 5 and 6).
 *
 * One call turns a tenant id and a language choice into a ready tenant: a Neon
 * project, a role and database, the tenant schema applied under that language, a
 * verified first query, a stored bearer grant, and a control-plane row that says
 * `ready`. Synchronous and single-tenant on purpose — KTD1's alpha provisions one
 * at a time, and KTD9's per-tenant language choice is only coherent because the
 * user and their choice exist before the schema is applied. The warm pool that
 * makes this constant-time under concurrent signups is U15's.
 *
 * **The interesting states are all partial**, so the design here is about them
 * rather than about the happy path. Provisioning creates real, billable,
 * externally-visible resources in a specific order, and a run can die between
 * any two of them:
 *
 * | Died after… | What exists | What a retry does |
 * |---|---|---|
 * | validation | nothing at all | starts fresh; no row was written |
 * | the row claim | a `provisioning` row | re-claims it once it is stale |
 * | project create, response lost | a Neon project **nothing references** | finds it by its deterministic name and deletes it |
 * | project create, id banked | project + row that names it | deletes the project by id, recreates |
 * | role/database create | project, role, database | same — the project is the unit of cleanup |
 * | schema apply | a database with a schema | same |
 * | bearer mint + secret write | a grant nobody can route to | revokes it, mints a new one |
 * | mark ready | nothing partial — this is the end | nothing; `ready` is an absolute stop |
 *
 * Three rules follow from that table, and each is pinned by a test:
 *
 * 1. **Bank the id before using it.** Every provider id is written to the
 *    control-plane row before the next call is made, because a retry can only
 *    delete what it can name. The one case where that is impossible — a create
 *    that succeeded at the vendor and then failed to return — is why the project
 *    name is derived from the tenant id and never random: the deterministic name
 *    is the second handle on a resource whose id was lost.
 * 2. **The retry is the only thing that cleans up.** The failure path banks a
 *    code and leaves the artifacts recorded. Two cleanup implementations would
 *    drift, and the one that runs less often would be the wrong one.
 * 3. **`ready` is an absolute stop.** The idempotence that cleans up after a
 *    failure would delete a live user's database if it ran one state further, so
 *    a ready tenant short-circuits before any provider is touched.
 *
 * **Rule 3 is enforced by a lease, not by that short-circuit.** The short-circuit
 * is a *read*, taken once, at the top of a run; every state-changing write below
 * it used to be an unconditional patch keyed on the tenant id alone. Those two
 * facts together destroy a live tenant, and the interleave needs no bug to
 * reach: the deadline is cooperative, so a hung provider call outlives it and
 * then outlives the stale window, a second run legitimately takes the row over
 * and completes, and the straggler wakes up and banks `failed` on top of a
 * `ready` row. A `failed` row is retryable at once — by design — so the next
 * ordinary retry sweeps the live user's project by its deterministic name.
 *
 * So the row carries `provisioningLease`, and **every write a run makes is a
 * compare-and-set against the lease it holds**. A run that has been taken over
 * is not asked to behave: its writes are refused by the store, it is told
 * (`superseded`), and it stops. The claim itself is the same CAS, which is what
 * makes two simultaneous retries of a `failed` row converge on one billable
 * project instead of two. `schema.sql` adds the matching constraint, so the
 * row the old code produced — `state='failed'` carrying a `ready_at` — is not
 * merely unwritten but unrepresentable.
 *
 * **The deadline reaches into the ports.** Every port call is handed the run's
 * `AbortSignal`, which fires when the caller cancels *or* when the wall-clock
 * deadline elapses. Without that, `stopped()` is consulted only between phases
 * and a call that never returns overruns both bounds — which is precisely what
 * makes the takeover above legitimate. The cooperative checks stay: they are
 * what a port that ignores its signal still cannot escape.
 *
 * **The bearer grant is stored before the tenant is marked ready** (step 6). A
 * ready tenant without a grant is unreachable — U6 has nothing to authenticate
 * against and the user's brain is a billed resource nobody can open. A grant
 * without a ready tenant is inert, because nothing routes to a tenant that is not
 * ready, and the retry rotates it away. The asymmetry is the whole reason for the
 * order.
 *
 * **The FTS language is applied before the first write is accepted** (KTD9), and
 * an English-default silent fallback is forbidden. So the language is a required
 * field with no default, a missing or malformed one is refused before any
 * resource exists, and the first-query verification compares the language the
 * database *reports* against the one that was chosen. That last check is the one
 * that matters: a silent fallback produces a working tenant that stems every
 * document it will ever index with the wrong language, and nothing errors.
 *
 * **Failure codes are an enum, not a message.** Every reason maps onto a value
 * `control.provisioning_failure` can hold, pinned to `schema.sql` by test. A
 * driver error quoting the DSN it was handed is the ordinary way a connection
 * string lands in a content-free database; a code cannot carry one.
 *
 * **A note on the storage seam.** `storage.ts` gates prefix derivation on the
 * fleet identity for that tenant, so provisioning constructs one to derive the
 * prefix it must record. That is a real wart and it is contained deliberately:
 * the dependency this module declares is `TenantPrefixSource`, which has
 * `prefixFor` and nothing else, so provisioning is *type-incapable* of asking for
 * an object-storage credential even though the accessor it is handed can mint
 * one. The parent R2 credential stays out of this path as it stays out of the
 * request path (R10/R11).
 */

import {
  controlPlaneIdentity,
  fleetIdentity,
  isValidTenantId,
  tenantNamespace,
  type CallerIdentity,
  type TenantSecretWriter,
} from './secrets.ts';
import type { PrefixResult } from './storage.ts';

/**
 * Every value `control.provisioning_failure` can hold. Frozen here and pinned to
 * `schema.sql` by test: a code this module can produce but the column cannot
 * store is a constraint violation raised on a tenant mid-failure, which is the
 * worst possible moment to discover it.
 */
export const PROVISIONING_FAILURE_CODES = [
  'project_create_failed',
  'role_create_failed',
  'schema_apply_failed',
  'first_query_failed',
  'secret_write_failed',
  'storage_prefix_failed',
  'timed_out',
  'cancelled',
] as const;

export type ProvisioningFailureCode = (typeof PROVISIONING_FAILURE_CODES)[number];

export const TENANT_STATES = ['provisioning', 'ready', 'failed', 'deleting'] as const;
export type TenantState = (typeof TENANT_STATES)[number];

export type TenantTier = 'free' | 'paid' | 'internal';

/**
 * Why a request was refused *before* anything was created. Deliberately a
 * different set from the failure codes: nothing was written, so nothing carries
 * a code, and a caller can tell "you asked for something impossible" apart from
 * "we tried and it broke".
 */
export const PROVISION_REJECTIONS = [
  'invalid_tenant_id',
  'missing_fts_language',
  'invalid_fts_language',
  'tenant_deleting',
  'provisioning_in_progress',
  'cancelled',
  /**
   * Another run holds the row now, and this one's writes were refused. It is a
   * rejection rather than a failure on purpose: nothing was recorded on the
   * tenant, because recording anything is exactly what a superseded run must not
   * do. The tenant's real state is whatever the run that owns it says.
   */
  'superseded',
] as const;

export type ProvisionRejection = (typeof PROVISION_REJECTIONS)[number];

/** The `control.fts_language` domain's alphabet, pinned to `schema.sql` by test. */
export const FTS_LANGUAGE_PATTERN = /^[a-z][a-z_]{0,31}$/;

/**
 * The Postgres text-search configurations a stock server ships. Advisory: it is
 * exported so a signup form can offer a list, and U3 owns the authoritative one
 * once the tenant schema exists. Provisioning validates the *shape* against the
 * schema domain and lets an unlisted-but-legal name through rather than blocking
 * a tenant whose language a newer Postgres knows about and this list does not.
 */
export const KNOWN_FTS_LANGUAGES = [
  'simple',
  'arabic',
  'armenian',
  'basque',
  'catalan',
  'danish',
  'dutch',
  'english',
  'finnish',
  'french',
  'german',
  'greek',
  'hindi',
  'hungarian',
  'indonesian',
  'irish',
  'italian',
  'lithuanian',
  'nepali',
  'norwegian',
  'portuguese',
  'romanian',
  'russian',
  'serbian',
  'spanish',
  'swedish',
  'tamil',
  'turkish',
  'yiddish',
] as const;

/**
 * Step 5, and a pure cost lever: a tenant compute suspends one minute after its
 * last query. R13's idle anchor (≈$0.105/month, storage only) assumes it.
 */
export const TENANT_SUSPEND_TIMEOUT_SECONDS = 60;

/** The wall-clock ceiling on one run. Overrunning is a recorded `timed_out`. */
export const DEFAULT_PROVISION_DEADLINE_MS = 300_000;

/**
 * How long a `provisioning` row is presumed live. **Must exceed the deadline**: a
 * window shorter than the longest legal run declares a running attempt dead and
 * lets a second run delete the first one's project out from under it.
 */
export const DEFAULT_STALE_PROVISIONING_MS = 600_000;

export const DEFAULT_TENANT_TIER: TenantTier = 'free';

/** Constant per project, so a connection string never carries a tenant id. */
export const TENANT_ROLE_NAME = 'brainz_owner';
export const TENANT_DATABASE_NAME = 'brainz';

const PROJECT_NAME_PREFIX = 'brainz-';

/**
 * The control-plane row, as provisioning sees it. Content-free by construction:
 * ids, counters, timestamps and *references* into the secret store. Mirrors the
 * columns of `control.tenant` that this unit writes.
 */
export interface TenantRecord {
  readonly tenantId: string;
  readonly state: TenantState;
  readonly tier: TenantTier;
  readonly schemaVersion: number;
  readonly ftsLanguage: string;
  readonly neonProjectId: string | null;
  readonly neonBranchId: string | null;
  readonly neonDatabase: string | null;
  readonly neonRole: string | null;
  readonly connectionSecretRef: string | null;
  readonly bearerSecretRef: string | null;
  readonly storagePrefix: string | null;
  readonly provisioningStartedAt: number;
  readonly provisioningAttempts: number;
  /**
   * **The fencing token.** Which attempt owns this row: taking the row over
   * increments it, and every write a run makes names the lease it believes it
   * holds. A run that was taken over therefore cannot write at all — not
   * because it checks, but because the store refuses it.
   *
   * A monotonic counter rather than a random id on purpose: it is an integer, so
   * the content-free schema needs no new alphabet to hold it, and "greater than
   * mine" is a readable answer to "who won".
   */
  readonly provisioningLease: number;
  readonly readyAt: number | null;
  readonly failureCode: ProvisioningFailureCode | null;
}

/**
 * Whether this row ever served a user, and therefore whether destroying what it
 * names is forbidden.
 *
 * **Lifted out of {@link cleanUpAfterFailedAttempt} so a second caller reuses
 * the rule rather than restating it.** `src/control/reconcile.ts` sweeps residue
 * left by runs that never finished, which is the same question asked from the
 * other end of time — and the failure it is guarding against is the one that
 * already happened once, when a deployment's tenants were deleted by name
 * prefix and one of them was a real user's brain. Two spellings of "is this
 * live?" is one spelling too many when the answer decides a deletion.
 *
 * **`readyAt` is checked as well as `state`, and that is not belt-and-braces.**
 * The row that used to make the cleanup path reachable was one whose `state` had
 * been overwritten by a straggling run while its `readyAt` stayed — a shape
 * `schema.sql` now refuses to store (`only_served_tenants_carry_a_ready_at`),
 * but the check is what noticed it, and a constraint that exists today is not a
 * reason to stop asking the question that found it.
 *
 * Takes the two fields rather than a whole {@link TenantRecord} so a caller
 * holding a narrower projection can still ask.
 */
export function hasReachedReady(record: {
  readonly state: TenantState;
  readonly readyAt: number | null;
}): boolean {
  return record.state === 'ready' || record.readyAt !== null;
}

/** An absent key means "leave that column alone"; `null` means "clear it". */
export interface TenantPatch {
  readonly state?: TenantState;
  readonly schemaVersion?: number;
  readonly ftsLanguage?: string;
  readonly neonProjectId?: string | null;
  readonly neonBranchId?: string | null;
  readonly neonDatabase?: string | null;
  readonly neonRole?: string | null;
  readonly connectionSecretRef?: string | null;
  readonly bearerSecretRef?: string | null;
  readonly storagePrefix?: string | null;
  readonly provisioningStartedAt?: number;
  readonly provisioningAttempts?: number;
  /** Only a claim writes this, and only to `expectedLease + 1`. */
  readonly provisioningLease?: number;
  readonly readyAt?: number | null;
  readonly failureCode?: ProvisioningFailureCode | null;
}

/**
 * `inserted: false` means the row already existed — the shape of
 * `INSERT … ON CONFLICT DO NOTHING`, which is how two racing signups for one id
 * resolve without either of them creating a second Neon project.
 */
export type InsertOutcome =
  | { readonly inserted: true; readonly record: TenantRecord }
  | { readonly inserted: false; readonly record: TenantRecord };

/**
 * `applied: false` is not an error and not a store failure — it is the store
 * telling a run that it no longer owns the row. `current` is what the row says
 * now, so the caller can see who it lost to (and, at most, undo something it
 * created itself). It is `undefined` only if the row is gone.
 */
export type UpdateOutcome =
  | { readonly applied: true; readonly record: TenantRecord }
  | { readonly applied: false; readonly current: TenantRecord | undefined };

/**
 * The control-plane database, behind a port. A store failure is **not** flattened
 * into a provisioning failure: it propagates, exactly as `secrets.ts` propagates
 * a backend failure, because "the control plane is down" must never be recorded
 * on a tenant row as "this tenant is broken".
 *
 * **`update` is a compare-and-set, and that is the whole point of this port.**
 * `expectedLease` is not advisory: an implementation MUST apply the patch only
 * while `provisioning_lease` still equals it, in one atomic statement —
 *
 *     UPDATE control.tenant SET … WHERE tenant_id = $1 AND provisioning_lease = $2
 *
 * — and report `applied: false` otherwise. A blind partial patch keyed on
 * `tenant_id` alone lets a run that was declared stale bank `failed` over a live
 * user's `ready` row, and the retry that follows deletes their database. The
 * lease is passed positionally rather than hidden in the patch so that no write
 * site can omit it and still compile.
 *
 * **An empty patch is still a compare-and-set** — it is how a run asks "do I
 * still hold this row?" atomically, immediately before writing to a store that
 * has no lease of its own. An implementation that short-circuits an empty patch
 * to `applied: true` answers a question it was not asked.
 */
export interface ControlPlaneStore {
  get(tenantId: string): Promise<TenantRecord | undefined>;
  /** The only unconditional claim: `INSERT … ON CONFLICT DO NOTHING`. */
  insert(record: TenantRecord): Promise<InsertOutcome>;
  update(tenantId: string, expectedLease: number, patch: TenantPatch): Promise<UpdateOutcome>;
}

/**
 * Every request into a port carries the run's signal. Optional on the type so an
 * in-memory fake need not model interruption, but **a port that reaches a
 * network MUST forward it**: without it the run's deadline is advisory, a hung
 * call overruns the stale window, and a second run legitimately takes the row
 * over while the first is still holding a connection open. That is the
 * interleave the lease exists to survive, and the signal is what keeps it rare.
 */
export interface CancellableRequest {
  readonly signal?: AbortSignal;
}

export interface CreateProjectRequest extends CancellableRequest {
  readonly name: string;
  readonly suspendTimeoutSeconds: number;
}

export interface CreatedProject {
  readonly projectId: string;
  readonly branchId: string;
}

export interface CreateRoleAndDatabaseRequest extends CancellableRequest {
  readonly projectId: string;
  readonly branchId: string;
  readonly roleName: string;
  readonly databaseName: string;
}

export interface CreatedRoleAndDatabase {
  readonly roleName: string;
  readonly databaseName: string;
  /** Request-path secret. It goes to the secret store and nowhere else. */
  readonly connectionString: string;
}

export interface NeonProjectSummary {
  readonly projectId: string;
  readonly name: string;
}

/**
 * The provider, behind a port; no vendor is hardcoded in this module.
 *
 * `searchProjectsByName` is named for what it is. Neon's list-projects `search`
 * matches *partial* names ("You can specify partial `name` or `id` values"), so
 * it returns candidates and the caller filters. A sweep that trusted it would
 * delete `brainz-alice2` while cleaning up after `alice` — the same
 * literal-substring hazard the R2 probe measured, in a second store, except here
 * the consequence is a deleted database rather than a leaked read.
 */
export interface NeonProjectApi {
  createProject(request: CreateProjectRequest): Promise<CreatedProject>;
  createRoleAndDatabase(request: CreateRoleAndDatabaseRequest): Promise<CreatedRoleAndDatabase>;
  /** Idempotent: deleting an already-absent project is a success. */
  deleteProject(projectId: string): Promise<void>;
  searchProjectsByName(name: string): Promise<readonly NeonProjectSummary[]>;
}

export interface SchemaApplyRequest extends CancellableRequest {
  readonly connectionString: string;
  readonly ftsLanguage: string;
}

/**
 * What the tenant database itself reports. The language comes back from the
 * database rather than being echoed by the applier, because the failure KTD9
 * forbids is precisely a database quietly disagreeing with what was requested.
 */
export type FirstQueryResult =
  | { readonly ok: true; readonly ftsLanguage: string }
  | { readonly ok: false };

/** U3 owns the real one (`src/schema/tenant.sql` + its migration runner). */
export interface TenantSchemaApplier {
  apply(request: SchemaApplyRequest): Promise<{ readonly schemaVersion: number }>;
  verifyFirstQuery(
    request: CancellableRequest & { readonly connectionString: string },
  ): Promise<FirstQueryResult>;
}

export interface BearerGrantMinter {
  /**
   * The signal is on this port too even though the shipped minter is a local
   * CSPRNG call with nothing to interrupt: the port is what a later KMS- or
   * HSM-backed minter implements, and that one is a network call on the same
   * critical path as the rest.
   */
  mint(tenantId: string, signal?: AbortSignal): Promise<string>;
}

/**
 * Deliberately narrower than `TenantStorage`. `TenantStorage` satisfies it
 * structurally, but nothing reached through this type can mint an
 * object-storage credential — the method is not on the type to call.
 */
export interface TenantPrefixSource {
  prefixFor(caller: CallerIdentity, tenantId: string): PrefixResult;
}

export interface ProvisionDeps {
  readonly neon: NeonProjectApi;
  readonly schema: TenantSchemaApplier;
  readonly store: ControlPlaneStore;
  /**
   * The write half only. Provisioning creates and rotates entries; it must not
   * be able to *read* any tenant's connection string or bearer, and the narrowed
   * port is what makes that a type property rather than a habit — the same
   * discipline `TenantPrefixSource` applies below.
   */
  readonly secrets: TenantSecretWriter;
  readonly storage: TenantPrefixSource;
  readonly bearer: BearerGrantMinter;
  /** Injectable clock. Tests advance it; production passes nothing. */
  readonly now?: () => number;
  readonly deadlineMs?: number;
  readonly staleAfterMs?: number;
}

export interface ProvisionRequest {
  readonly tenantId: string;
  /** Required, with no default. A default is KTD9's forbidden silent fallback. */
  readonly ftsLanguage: string;
  readonly signal?: AbortSignal;
}

export type ProvisionResult =
  | { readonly ok: true; readonly tenant: TenantRecord; readonly alreadyReady: boolean }
  | { readonly ok: false; readonly reason: ProvisionRejection; readonly recorded: false }
  | { readonly ok: false; readonly reason: ProvisioningFailureCode; readonly recorded: true };

/**
 * The second handle on a project whose id was lost. Derived from the tenant id
 * and never random, because a create that succeeds at the vendor and then fails
 * to return leaves a resource that nothing in the control plane can name.
 */
export function neonProjectName(tenantId: string): string {
  return `${PROJECT_NAME_PREFIX}${tenantId}`;
}

/**
 * 256 bits from the platform CSPRNG, hex-encoded. Production default; tests
 * inject a fake. Web Crypto rather than `node:crypto` because the fleet runs on
 * Cloudflare's runtime, where this is the primitive that exists everywhere.
 */
export function createRandomBearerGrantMinter(): BearerGrantMinter {
  return {
    mint: () => {
      const bytes = new Uint8Array(32);
      crypto.getRandomValues(bytes);
      return Promise.resolve(
        Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
      );
    },
  };
}

function isValidFtsLanguage(language: string): boolean {
  return FTS_LANGUAGE_PATTERN.test(language);
}

/** A run stops for one of two reasons that are nobody's fault but the clock's. */
type StopReason = 'timed_out' | 'cancelled';

/**
 * The run's deadline, as a signal rather than as a clock reading.
 *
 * Two bounds, one signal: the caller's cancellation and the wall-clock deadline.
 * It is handed to every port, because a check between phases cannot end a call
 * that never returns — and a call that never returns is exactly what lets a live
 * run be declared stale and taken over while it is still working.
 *
 * `elapsed()` is kept separate from `signal.aborted` because the *reason* is
 * recorded on the tenant row: an interrupted call must be banked as `timed_out`,
 * never as the provider failure it superficially resembles.
 */
interface RunDeadline {
  readonly signal: AbortSignal;
  elapsed(): boolean;
  dispose(): void;
}

function startRunDeadline(caller: AbortSignal | undefined, deadlineMs: number): RunDeadline {
  const controller = new AbortController();
  let elapsed = false;

  const timer = setTimeout(() => {
    elapsed = true;
    controller.abort();
  }, deadlineMs);
  // A deadline timer that outlives its run would hold the process open for the
  // rest of the window after the answer is already known.
  (timer as unknown as { unref?: () => void }).unref?.();

  const onCallerAbort = (): void => controller.abort();
  if (caller !== undefined) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener('abort', onCallerAbort, { once: true });
  }

  return {
    signal: controller.signal,
    elapsed: () => elapsed,
    dispose: () => {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/** The lease an insert claims. Nothing is ever written under lease 0. */
const FIRST_LEASE = 1;

/** What a fenced write returns: the new row, or who holds the row instead. */
type BankResult =
  | { readonly ok: true; readonly record: TenantRecord }
  | { readonly ok: false; readonly current: TenantRecord | undefined };

export async function provisionTenant(
  deps: ProvisionDeps,
  request: ProvisionRequest,
): Promise<ProvisionResult> {
  const { neon, schema, store, secrets, storage, bearer } = deps;
  const now = deps.now ?? Date.now;
  const deadlineMs = deps.deadlineMs ?? DEFAULT_PROVISION_DEADLINE_MS;
  const staleAfterMs = deps.staleAfterMs ?? DEFAULT_STALE_PROVISIONING_MS;
  const { tenantId, ftsLanguage } = request;

  // Checked here, on the values actually in force, rather than asserted for the
  // two defaults and assumed for every injected pair. A stale window shorter
  // than the deadline declares running attempts dead and manufactures the
  // takeover this module spends the lease defending against; it is a
  // misconfiguration of the dependencies, so it must never be recorded on a
  // tenant row as "this tenant is broken".
  if (staleAfterMs <= deadlineMs) {
    throw new Error(
      'invariant: the stale window must outlive the provisioning deadline, or a live run is declared dead',
    );
  }

  const startedAt = now();
  const deadline = startedAt + deadlineMs;

  // -------------------------------------------------------------------------
  // Phase A — validate. Nothing external is touched and no row is written, so
  // an impossible request never leaves a billable resource behind. The language
  // rules live here for that reason: KTD9's tenant must fail loudly at the
  // cheapest possible moment, not quietly at the most expensive one.
  // -------------------------------------------------------------------------
  if (!isValidTenantId(tenantId)) {
    return { ok: false, reason: 'invalid_tenant_id', recorded: false };
  }
  if (ftsLanguage.length === 0) {
    return { ok: false, reason: 'missing_fts_language', recorded: false };
  }
  if (!isValidFtsLanguage(ftsLanguage)) {
    return { ok: false, reason: 'invalid_fts_language', recorded: false };
  }
  if (request.signal?.aborted === true) {
    return { ok: false, reason: 'cancelled', recorded: false };
  }

  const run = startRunDeadline(request.signal, deadlineMs);
  try {
    // -----------------------------------------------------------------------
    // Phase B — claim the row, or triage the one already there.
    // -----------------------------------------------------------------------
    const existing = await store.get(tenantId);
    let record: TenantRecord;
    /** The fence this run writes under. Nothing below writes without it. */
    let lease: number;

    if (existing === undefined) {
      const claimed = await store.insert({
        tenantId,
        state: 'provisioning',
        tier: DEFAULT_TENANT_TIER,
        schemaVersion: 0,
        ftsLanguage,
        neonProjectId: null,
        neonBranchId: null,
        neonDatabase: null,
        neonRole: null,
        connectionSecretRef: null,
        bearerSecretRef: null,
        storagePrefix: null,
        provisioningStartedAt: startedAt,
        provisioningAttempts: 1,
        provisioningLease: FIRST_LEASE,
        readyAt: null,
        failureCode: null,
      });

      // Lost the insert race: whoever won it is provisioning this tenant right now.
      if (!claimed.inserted) {
        return { ok: false, reason: 'provisioning_in_progress', recorded: false };
      }
      record = claimed.record;
      lease = record.provisioningLease;
    } else {
      // The absolute stop. A ready tenant holds a live user's data, so the cleanup
      // below must never see one.
      if (existing.state === 'ready') {
        return { ok: true, tenant: existing, alreadyReady: true };
      }
      if (existing.state === 'deleting') {
        return { ok: false, reason: 'tenant_deleting', recorded: false };
      }
      // A `provisioning` row that was touched recently may be a run still going.
      // A `failed` row is a run that finished and said so — retryable at once,
      // because a user waiting at a signup form should not serve a stale window.
      if (
        existing.state === 'provisioning' &&
        now() - existing.provisioningStartedAt < staleAfterMs
      ) {
        return { ok: false, reason: 'provisioning_in_progress', recorded: false };
      }

      // **Take the row over before anything is deleted or created.** The claim is
      // the same compare-and-set every other write uses, so two retries of a
      // `failed` row both reach this line and exactly one of them applies — the
      // loser stops here, having created nothing. With an unconditional claim
      // both went on to create a real, billable project, and the loser's was
      // referenced by no row and swept by no cleanup: orphaned for good, because
      // once the winner is ready cleanup never runs again.
      const claim = await store.update(tenantId, existing.provisioningLease, {
        state: 'provisioning',
        provisioningLease: existing.provisioningLease + 1,
        ftsLanguage,
        provisioningStartedAt: startedAt,
        provisioningAttempts: existing.provisioningAttempts + 1,
        readyAt: null,
        failureCode: null,
      });
      if (!claim.applied) {
        return { ok: false, reason: 'provisioning_in_progress', recorded: false };
      }
      lease = claim.record.provisioningLease;

      // The one cleanup owner, now holding a lease nobody else can write under.
      // It works from the *pre-claim* snapshot, and the row still names those
      // artifacts while it runs: a cleanup that dies leaves them recorded for the
      // next attempt rather than stranding a resource nothing can name.
      await cleanUpAfterFailedAttempt(neon, secrets, existing);

      const cleared = await store.update(tenantId, lease, {
        schemaVersion: 0,
        neonProjectId: null,
        neonBranchId: null,
        neonDatabase: null,
        neonRole: null,
        connectionSecretRef: null,
        bearerSecretRef: null,
        storagePrefix: null,
      });
      // Nothing has been created under this lease yet, so there is nothing to
      // undo — this run simply stops.
      if (!cleared.applied) {
        return { ok: false, reason: 'superseded', recorded: false };
      }
      record = cleared.record;
    }

    /** The project this run created, so a superseded run can undo its own work. */
    let createdProjectId: string | undefined;

    /**
     * Every write this run makes, fenced. The lease is what the store compares
     * against; `ok: false` means another run owns the row and this one's write
     * was refused rather than applied.
     */
    async function bank(patch: TenantPatch): Promise<BankResult> {
      const outcome = await store.update(tenantId, lease, patch);
      if (!outcome.applied) return { ok: false, current: outcome.current };
      return { ok: true, record: outcome.record };
    }

    /**
     * "Do I still hold this row?", asked atomically, immediately before a write
     * to a store that has no lease of its own. An empty patch is still a
     * compare-and-set (see `ControlPlaneStore.update`).
     */
    async function stillOwned(): Promise<BankResult> {
      return bank({});
    }

    /**
     * This run has been taken over. It writes nothing — recording anything is
     * precisely what a superseded run must not do — and it undoes only what it
     * can prove is its own: the project it created itself, and only while the
     * row does not name it. The owner's artifacts are never touched here.
     */
    async function superseded(current: TenantRecord | undefined): Promise<ProvisionResult> {
      if (createdProjectId !== undefined && current?.neonProjectId !== createdProjectId) {
        try {
          await neon.deleteProject(createdProjectId);
        } catch {
          // Best effort. The deterministic name is the backstop, and a failure
          // here must not become the caller's answer.
        }
      }
      return { ok: false, reason: 'superseded', recorded: false };
    }

    /** Bank a code on the row and stop. Artifacts stay recorded for the retry. */
    async function fail(code: ProvisioningFailureCode): Promise<ProvisionResult> {
      const banked = await bank({ state: 'failed', failureCode: code });
      // The write this fence exists for. Unfenced, a straggler banks `failed`
      // over a live user's `ready` row, and the retry that a recorded failure
      // invites deletes their database.
      if (!banked.ok) return superseded(banked.current);
      return { ok: false, reason: code, recorded: true };
    }

    function stopped(): StopReason | undefined {
      if (request.signal?.aborted === true) return 'cancelled';
      if (run.elapsed() || now() > deadline) return 'timed_out';
      return undefined;
    }

    /**
     * A port call that threw after the run was stopped was interrupted, not
     * refused. Recording the provider's code for it would name the wrong cause
     * and, worse, make a cancelled run look like a broken provider.
     */
    function failAfterCall(code: ProvisioningFailureCode): Promise<ProvisionResult> {
      return fail(stopped() ?? code);
    }

    // -----------------------------------------------------------------------
    // Phase C — derive the prefix. Local and free, and it happens before anything
    // billable exists, so `storage_prefix_failed` is always the cheapest failure.
    // -----------------------------------------------------------------------
    const prefix = storage.prefixFor(fleetIdentity(tenantId), tenantId);
    if (!prefix.ok) return fail('storage_prefix_failed');
    const bankedPrefix = await bank({ storagePrefix: prefix.prefix });
    if (!bankedPrefix.ok) return superseded(bankedPrefix.current);
    record = bankedPrefix.record;

    // -----------------------------------------------------------------------
    // Phase D — create the tenant's substrate. Every id is banked on the row
    // before the next call is made.
    // -----------------------------------------------------------------------
    const stopBeforeProject = stopped();
    if (stopBeforeProject !== undefined) return fail(stopBeforeProject);

    let project: CreatedProject;
    try {
      project = await neon.createProject({
        name: neonProjectName(tenantId),
        suspendTimeoutSeconds: TENANT_SUSPEND_TIMEOUT_SECONDS,
        signal: run.signal,
      });
    } catch {
      // The error is deliberately not read. A provider error quoting the DSN it was
      // handed is the ordinary way a connection string reaches a content-free
      // database, and a code cannot carry one.
      return failAfterCall('project_create_failed');
    }
    createdProjectId = project.projectId;
    const bankedProject = await bank({
      neonProjectId: project.projectId,
      neonBranchId: project.branchId,
    });
    if (!bankedProject.ok) return superseded(bankedProject.current);
    record = bankedProject.record;

    const stopBeforeRole = stopped();
    if (stopBeforeRole !== undefined) return fail(stopBeforeRole);

    let roleAndDatabase: CreatedRoleAndDatabase;
    try {
      roleAndDatabase = await neon.createRoleAndDatabase({
        projectId: project.projectId,
        branchId: project.branchId,
        roleName: TENANT_ROLE_NAME,
        databaseName: TENANT_DATABASE_NAME,
        signal: run.signal,
      });
    } catch {
      return failAfterCall('role_create_failed');
    }
    const bankedRole = await bank({
      neonDatabase: roleAndDatabase.databaseName,
      neonRole: roleAndDatabase.roleName,
    });
    if (!bankedRole.ok) return superseded(bankedRole.current);
    record = bankedRole.record;

    // Held in memory only, until the single secret write below.
    const connectionString = roleAndDatabase.connectionString;

    // -----------------------------------------------------------------------
    // Phase E — apply the schema under this tenant's language, then make the
    // database prove it (KTD9).
    // -----------------------------------------------------------------------
    const stopBeforeSchema = stopped();
    if (stopBeforeSchema !== undefined) return fail(stopBeforeSchema);

    let applied: { readonly schemaVersion: number };
    try {
      applied = await schema.apply({ connectionString, ftsLanguage, signal: run.signal });
    } catch {
      return failAfterCall('schema_apply_failed');
    }
    // `ready` requires `schema_version > 0` in the schema's own CHECK, so an
    // applier reporting 0 has not produced a servable tenant.
    if (applied.schemaVersion <= 0) return fail('schema_apply_failed');
    const bankedVersion = await bank({ schemaVersion: applied.schemaVersion });
    if (!bankedVersion.ok) return superseded(bankedVersion.current);
    record = bankedVersion.record;

    const stopBeforeVerify = stopped();
    if (stopBeforeVerify !== undefined) return fail(stopBeforeVerify);

    let verified: FirstQueryResult;
    try {
      verified = await schema.verifyFirstQuery({ connectionString, signal: run.signal });
    } catch {
      return failAfterCall('first_query_failed');
    }
    if (!verified.ok) return fail('first_query_failed');
    // The silent fallback, caught. A tenant that asked for Spanish and got English
    // works perfectly and indexes everything wrong, forever.
    if (verified.ftsLanguage !== ftsLanguage) return fail('schema_apply_failed');

    // -----------------------------------------------------------------------
    // Phase F — the grant, stored BEFORE ready. Both halves of the tenant's secret
    // go in one write: the store replaces whole entries, so a two-step write would
    // publish an entry carrying a placeholder for whichever half came second.
    // -----------------------------------------------------------------------
    const stopBeforeGrant = stopped();
    if (stopBeforeGrant !== undefined) return fail(stopBeforeGrant);

    let bearerGrant: string;
    try {
      bearerGrant = await bearer.mint(tenantId, run.signal);
    } catch {
      return failAfterCall('secret_write_failed');
    }

    // The secret store keys on the tenant, not on the lease, so a superseded run
    // writing here would silently rotate away the grant the owning run already
    // handed the user. The fence is checked immediately before the write, which
    // narrows that window to a single statement; closing it entirely needs a
    // conditional write in `secrets.ts`, whose port U6 shares.
    const ownedBeforeWrite = await stillOwned();
    if (!ownedBeforeWrite.ok) return superseded(ownedBeforeWrite.current);

    const written = await secrets.put(controlPlaneIdentity(), tenantId, {
      connectionString,
      bearerGrant,
    });
    if (!written.ok) return fail('secret_write_failed');

    const secretRef = tenantNamespace(tenantId);
    const bankedRefs = await bank({
      connectionSecretRef: secretRef,
      bearerSecretRef: secretRef,
    });
    if (!bankedRefs.ok) return superseded(bankedRefs.current);
    record = bankedRefs.record;

    // -----------------------------------------------------------------------
    // Phase G — ready. The last write, and the only one that makes the tenant
    // routable.
    // -----------------------------------------------------------------------
    const bankedReady = await bank({
      state: 'ready',
      readyAt: now(),
      failureCode: null,
    });
    if (!bankedReady.ok) return superseded(bankedReady.current);
    record = bankedReady.record;

    return { ok: true, tenant: record, alreadyReady: false };
  } finally {
    run.dispose();
  }
}

/**
 * Undo whatever the previous attempt managed to create. Reached only from the
 * retry path, and never for a `ready` tenant.
 *
 * The name sweep is the half that needs care. Neon's `search` is a substring
 * match, so cleaning up after `alice` gets `brainz-alice2` in the candidate list
 * — a sibling tenant's entire database, one careless `for` loop from deletion.
 * Only an exact name match is deleted.
 *
 * Note what the two deletion vectors have in common: this tenant's project is
 * created under the deterministic name, so the banked id and the exact-name
 * sweep are ordinarily *the same project*. Guarding one and not the other closes
 * nothing, which is why rule 3 is enforced above this function rather than
 * inside it — and why the state check below is a throw, not a filter.
 */
async function cleanUpAfterFailedAttempt(
  neon: NeonProjectApi,
  secrets: TenantSecretWriter,
  record: TenantRecord,
): Promise<void> {
  // Rule 3, made mechanical. A ready tenant reaching this function means the
  // lease failed to hold and a live user is about to lose their database; that
  // must abort loudly rather than proceed on a suspicion.
  if (hasReachedReady(record)) {
    throw new Error('invariant: cleanup must never run against a tenant that reached ready');
  }

  if (record.neonProjectId !== null) {
    await neon.deleteProject(record.neonProjectId);
  }

  // The project whose id never arrived. Its deterministic name is the only
  // handle left on it.
  const wanted = neonProjectName(record.tenantId);
  const candidates = await neon.searchProjectsByName(wanted);
  for (const candidate of candidates) {
    if (candidate.name !== wanted) continue;
    await neon.deleteProject(candidate.projectId);
  }

  // A grant from a run that never finished routes to nothing, but it is live
  // credential material and the next attempt mints a fresh one.
  await secrets.revoke(controlPlaneIdentity(), record.tenantId);
}
