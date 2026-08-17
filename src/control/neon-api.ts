/**
 * The Neon adapter — the production wiring behind `NeonProjectApi`.
 *
 * **Scope, stated plainly.** This began as the adapter U2's create-to-first-query
 * benchmark runs against (`test/control/provision.real.test.ts`), and for several
 * units that was its only constructor anywhere — the web app composed a
 * provisioner with no `neon` port at all, so the synchronous branch every
 * default deployment takes refused `no_substrate_configured` at signup. It is
 * constructed on the request path now: `src/web/serve.ts` builds one from
 * `BRAINZ_NEON_*` and hands it to `createBrainProvisioner`. The MCP and worker
 * fleets still hold no vendor credential and still must not.
 *
 * Endpoints and payload shapes are transcribed from the Neon API v2 reference
 * (`https://api-docs.neon.tech/reference/`), read 2026-08-12:
 *
 *   POST   /projects                                   → project, branch, roles, databases
 *   POST   /projects/{id}/branches/{branch}/roles      → role
 *   POST   /projects/{id}/branches/{branch}/databases  → database
 *   GET    /projects/{id}/connection_uri?…             → { uri }
 *   GET    /projects?search=&limit=&cursor=            → { projects, pagination }
 *   DELETE /projects/{id}                              → project
 *
 * Three behaviours are deliberate rather than incidental:
 *
 * **`suspend_timeout_seconds` is sent on every create, unless the account cannot
 * take it.** It is U2 step 5's cost lever and R13's ≈$0.105/month idle anchor
 * depends on it. This note used to say that omitting the field means *never
 * suspend, i.e. bill forever*; that is wrong, and the correction is measured
 * rather than read: a project created without it comes back carrying
 * `suspend_timeout_seconds: 0` on its endpoint, and `0` is the API's "use the
 * default", which is 300 seconds. So omitting is not catastrophic — it is five
 * minutes of idle compute per wake instead of one, which is the cost difference
 * R13's anchor is drawn against and still worth sending.
 *
 * The exception is real and it is the self-hoster's: a free-plan account refuses
 * the field outright (`412 modifying the suspend interval is not permitted on
 * this account`) and creates nothing, so the setting is declared by the operator
 * — see {@link NeonApiOptions.suspendTimeoutSettable} — and never inferred from
 * that refusal.
 *
 * **A 2xx with an unexpected body is an error.** An id read as `undefined` and
 * banked on a control-plane row produces a tenant naming a project nobody can
 * delete: the exact orphan the provisioning sequence exists to prevent.
 *
 * **An error carries a status and an operation name, and nothing else.** Not the
 * response body, not the URL, never the key. This adapter holds a platform
 * credential (R10) and a thrown error is the most casually-logged object in any
 * system; `console.error(err)` must not be able to print a secret.
 *
 * Retries cover the one failure that is normal rather than exceptional: Neon
 * serialises operations per project, so the role create immediately after a
 * project create can come back `423 Locked`. `423`, `429` and 5xx retry with
 * exponential backoff; every other 4xx is final, because retrying a rejection is
 * just a slower rejection.
 *
 * **The caller's signal reaches the socket.** Provisioning's deadline is only a
 * real bound if the HTTP call it wraps can actually be cut off; a request left
 * hanging on a socket outlives the run's deadline and then the window after
 * which its control-plane row is presumed dead, at which point a second run
 * legitimately takes the tenant over while this one is still in flight. So the
 * signal is passed into `fetch`, and an aborted run stops retrying rather than
 * sleeping through its backoff.
 */

import type {
  CreateProjectRequest,
  CreatedProject,
  CreateRoleAndDatabaseRequest,
  CreatedRoleAndDatabase,
  NeonProjectApi,
  NeonProjectSummary,
} from './provision.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const NEON_API_BASE_URL = 'https://console.neon.tech/api/v2';

/**
 * Where a tenant database is created when nothing says otherwise, and on what.
 *
 * **Both values are "where the fleet already is", not "what Neon suggests".**
 * The default used to be `aws-us-east-2` on Postgres 17, which is Neon's own
 * console default and a fact about nothing in this system. The control plane
 * this fleet runs against answers from `…us-west-2.aws.neon.tech` and reports
 * `server_version` 18.4 — checked, not assumed — so `aws-us-west-2` and `18` are
 * the values that put a tenant beside the fleet rather than a continent away.
 *
 * **Why the region is the more expensive of the two to get wrong.** Every read
 * the request path performs is a round trip from the container to the tenant's
 * own database, and KTD2's promise is a warm p99. A cross-country round trip is
 * tens of milliseconds *per statement*, paid on every query for the life of the
 * tenant, and it is invisible in every test in this repo because they all run
 * against localhost. It also lands on the benchmark that is supposed to size the
 * warm pool (`test/control/provision.real.test.ts`): a create-to-first-query
 * number measured in a region no tenant is created in is a number about nothing.
 *
 * **Why the major version is pinned to the control plane's rather than floated.**
 * They are separate databases and nothing joins them, so drift is survivable —
 * but the operator debugging a tenant is reading the control plane in the same
 * session, and an extension or a planner behaviour that differs between majors
 * turns that into two investigations. A deployment that wants otherwise sets
 * `BRAINZ_NEON_PG_VERSION`; this is a default, not a constraint.
 */
export const DEFAULT_NEON_REGION_ID = 'aws-us-west-2';
export const DEFAULT_NEON_PG_VERSION = 18;
/**
 * How many times a retryable status is tried, and therefore how long the
 * backoff spans: `500ms · 2^(n-1)` summed over `n-1` waits, which is **15.5
 * seconds** at six attempts.
 *
 * It was three (1.5 seconds), and that is below the floor of the failure it
 * exists for. Neon serialises operations per project, so the role create that
 * immediately follows a project create answers `423` until the project's own
 * operations finish — measured at **6 seconds** on this fleet's first live
 * signup, read from `GET /projects/{id}/operations`. Every attempt in that
 * window is a `423` by construction, so the old budget could not succeed: it
 * created a billable project and then failed `role_create_failed` on it.
 *
 * The bound on this is not the attempt count — it is the run's deadline, which
 * reaches the socket through the signal, so a longer budget cannot outlive the
 * window after which a run's row is presumed dead.
 */
export const DEFAULT_MAX_ATTEMPTS = 6;
export const DEFAULT_PAGE_SIZE = 100;
export const DEFAULT_BACKOFF_MS = 500;

/** A guard against a cursor that never terminates, not a real page ceiling. */
const MAX_PAGES = 50;

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([423, 429]);

/**
 * Carries a status and an operation. Deliberately carries nothing else — see the
 * module note.
 */
export class NeonApiError extends Error {
  readonly status: number;
  readonly operation: string;

  constructor(operation: string, status: number) {
    super(`neon api: ${operation} failed with status ${status}`);
    this.name = 'NeonApiError';
    this.operation = operation;
    this.status = status;
  }
}

export interface NeonApiOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly regionId?: string;
  readonly pgVersion?: number;
  /** Creates the project inside an organisation rather than a personal account. */
  readonly orgId?: string;
  /**
   * Whether this account's plan permits setting the suspend interval at all.
   *
   * Default `true`, which is the fleet's shape and the expensive one to get
   * wrong. Neon's free plan refuses the field outright — a create carrying it
   * answers `412 modifying the suspend interval is not permitted on this
   * account` and creates nothing, which is how a self-hoster's very first
   * signup fails with a vendor code naming no field. Declaring `false` sends
   * the create without it and takes whatever the account's plan enforces.
   *
   * **It is declared, never inferred.** Dropping the field automatically on a
   * 412 would look like a fix and be a regression on every account that can
   * take the setting: `suspend_timeout_seconds` is R13's ≈$0.105/month idle
   * anchor, and a fleet that silently stopped sending it would take the vendor
   * default of 300 seconds — five times the idle compute per wake, on every
   * tenant, discovered on an invoice rather than in a log.
   */
  readonly suspendTimeoutSettable?: boolean;
  readonly fetch?: FetchLike;
  /** Injectable, so retry behaviour is testable without waiting. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly pageSize?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Reads a nested string, or throws — an absent id must never become `undefined`. */
function readString(operation: string, body: unknown, path: readonly string[]): string {
  let current: unknown = body;
  for (const key of path) {
    if (!isRecord(current)) throw new NeonApiError(operation, 200);
    current = current[key];
  }
  if (typeof current !== 'string' || current.length === 0) throw new NeonApiError(operation, 200);
  return current;
}

export function createNeonProjectApi(options: NeonApiOptions): NeonProjectApi {
  const baseUrl = (options.baseUrl ?? NEON_API_BASE_URL).replace(/\/$/, '');
  const regionId = options.regionId ?? DEFAULT_NEON_REGION_ID;
  const pgVersion = options.pgVersion ?? DEFAULT_NEON_PG_VERSION;
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

  async function call(
    operation: string,
    method: string,
    path: string,
    body?: unknown,
    okStatuses?: ReadonlySet<number>,
    signal?: AbortSignal,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    let lastStatus = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const init: RequestInit = {
        method,
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
      };

      const response = await doFetch(`${baseUrl}${path}`, init);
      lastStatus = response.status;

      if (response.ok || okStatuses?.has(response.status) === true) {
        // A body that is not JSON is as much a failure as a 500: the caller is
        // about to read an id out of it.
        const parsed: unknown = await response.json().catch(() => undefined);
        return { status: response.status, body: parsed };
      }

      const retryable = RETRYABLE_STATUSES.has(response.status) || response.status >= 500;
      // An aborted run must not spend its backoff sleeping and then try again:
      // the answer is already known and nobody is waiting for it.
      if (!retryable || attempt === maxAttempts || signal?.aborted === true) break;

      await sleep(DEFAULT_BACKOFF_MS * 2 ** (attempt - 1));
    }

    throw new NeonApiError(operation, lastStatus);
  }

  return {
    async createProject(request: CreateProjectRequest): Promise<CreatedProject> {
      const { body } = await call(
        'createProject',
        'POST',
        '/projects',
        {
          project: {
            name: request.name,
            region_id: regionId,
            pg_version: pgVersion,
            ...(options.orgId === undefined ? {} : { org_id: options.orgId }),
            // U2 step 5, and R13's idle anchor. Sent unless the account's plan
            // forbids the setting entirely — see `suspendTimeoutSettable`, which
            // an operator declares and this adapter never infers.
            ...(options.suspendTimeoutSettable === false
              ? {}
              : {
                  default_endpoint_settings: {
                    suspend_timeout_seconds: request.suspendTimeoutSeconds,
                  },
                }),
          },
        },
        undefined,
        request.signal,
      );

      return {
        projectId: readString('createProject', body, ['project', 'id']),
        branchId: readString('createProject', body, ['branch', 'id']),
      };
    },

    async createRoleAndDatabase(
      request: CreateRoleAndDatabaseRequest,
    ): Promise<CreatedRoleAndDatabase> {
      const branchPath = `/projects/${encodeURIComponent(request.projectId)}/branches/${encodeURIComponent(request.branchId)}`;

      const role = await call(
        'createRole',
        'POST',
        `${branchPath}/roles`,
        { role: { name: request.roleName } },
        undefined,
        request.signal,
      );
      const roleName = readString('createRole', role.body, ['role', 'name']);

      const database = await call(
        'createDatabase',
        'POST',
        `${branchPath}/databases`,
        { database: { name: request.databaseName, owner_name: roleName } },
        undefined,
        request.signal,
      );
      const databaseName = readString('createDatabase', database.body, ['database', 'name']);

      const query = new URLSearchParams({
        branch_id: request.branchId,
        database_name: databaseName,
        role_name: roleName,
      });
      const uri = await call(
        'connectionUri',
        'GET',
        `/projects/${encodeURIComponent(request.projectId)}/connection_uri?${query.toString()}`,
        undefined,
        undefined,
        request.signal,
      );

      return {
        roleName,
        databaseName,
        connectionString: readString('connectionUri', uri.body, ['uri']),
      };
    },

    async deleteProject(projectId: string): Promise<void> {
      // Idempotent by necessity: the retry path deletes projects a previous
      // retry may already have removed. Deliberately un-signalled: cleanup is
      // what makes a cancelled run cheap, so cancelling the cancellation is the
      // one place an abort would leave a billable resource behind.
      await call(
        'deleteProject',
        'DELETE',
        `/projects/${encodeURIComponent(projectId)}`,
        undefined,
        new Set([404]),
      );
    },

    async searchProjectsByName(name: string): Promise<readonly NeonProjectSummary[]> {
      const found: NeonProjectSummary[] = [];
      let cursor: string | undefined;

      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = new URLSearchParams({ search: name, limit: String(pageSize) });
        // The same organisation the create used, and for two reasons. An
        // organisation-scoped API key is refused outright without it — the live
        // API answers `400 org_id is required` — and this call is the recovery
        // path for a project whose id was lost, so a refusal here is the moment
        // an orphan becomes permanent. Even against a key that would tolerate
        // the omission, a create scoped to an org and a search that is not are
        // asking about two different places.
        if (options.orgId !== undefined) query.set('org_id', options.orgId);
        if (cursor !== undefined) query.set('cursor', cursor);

        const { body } = await call('searchProjects', 'GET', `/projects?${query.toString()}`);
        const projects = isRecord(body) && Array.isArray(body['projects']) ? body['projects'] : [];

        for (const project of projects) {
          // No filtering here. Neon's `search` matches partial names and the
          // caller is the only place that knows what an exact match means —
          // narrowing here would hide the hazard from the code that owns it.
          found.push({
            projectId: readString('searchProjects', project, ['id']),
            name: readString('searchProjects', project, ['name']),
          });
        }

        const nextCursor =
          isRecord(body) && isRecord(body['pagination']) ? body['pagination']['cursor'] : undefined;
        if (projects.length < pageSize || typeof nextCursor !== 'string' || nextCursor.length === 0) {
          break;
        }
        cursor = nextCursor;
      }

      return found;
    },
  };
}
