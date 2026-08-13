/**
 * The Neon adapter — the production wiring behind `NeonProjectApi`.
 *
 * **Scope, stated plainly.** This exists so U2's create-to-first-query benchmark
 * can run against real Neon (`test/control/provision.real.test.ts`). It is the
 * real API, not a stub, but nothing on the request path constructs one yet: the
 * fleet does not provision tenants, the control plane does. Treat it as wired
 * for the benchmark and reviewed for production, in that order.
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
 * **`suspend_timeout_seconds` is sent on every create.** It is U2 step 5's cost
 * lever and R13's ≈$0.105/month idle anchor depends on it. Neon's own default is
 * 0 (never suspend, i.e. bill forever), so omitting the field is not a neutral
 * choice — it is the expensive one.
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
export const DEFAULT_NEON_REGION_ID = 'aws-us-east-2';
export const DEFAULT_NEON_PG_VERSION = 17;
export const DEFAULT_MAX_ATTEMPTS = 3;
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
            default_endpoint_settings: {
              // U2 step 5. Neon's own default is 0 — never suspend.
              suspend_timeout_seconds: request.suspendTimeoutSeconds,
            },
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
