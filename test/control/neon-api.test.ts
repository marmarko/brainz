/**
 * The Neon adapter, tested against a fetch fake. No network, no credential.
 *
 * What is worth testing in an HTTP adapter is not "does it call the URL". It is
 * the three places this one can hurt someone:
 *
 * 1. **The request carries the cost lever.** `suspend_timeout_seconds` is the
 *    difference between R13's ≈$0.105/month idle tenant and a compute that never
 *    sleeps. It is asserted on the wire, not in a comment.
 * 2. **Errors carry a status, never a body and never the key.** The API key is a
 *    platform credential (R10) and a thrown error is the most casually-logged
 *    object in any system.
 * 3. **A 200 with an unexpected shape is a failure, not a success.** `undefined`
 *    banked as a project id produces a control-plane row that names a project
 *    nobody can delete — the exact orphan the provisioning sequence exists to
 *    prevent.
 *
 * Plus the one thing that will actually bite in production: Neon serialises
 * operations per project, so the role create immediately after a project create
 * is the request most likely to come back `423 Locked`. That retries; a `400`
 * does not.
 */

import { describe, expect, test } from 'bun:test';

import {
  createNeonProjectApi,
  DEFAULT_MAX_ATTEMPTS,
  NeonApiError,
  NEON_API_BASE_URL,
  type FetchLike,
} from '../../src/control/neon-api.ts';

const API_KEY = 'neon-api-key-fake-do-not-use';

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  /** Whether the caller's cancellation actually reached the request. */
  readonly signal: AbortSignal | null | undefined;
}

interface Canned {
  readonly status: number;
  readonly body: unknown;
}

function jsonResponse(canned: Canned): Response {
  return new Response(JSON.stringify(canned.body), {
    status: canned.status,
    headers: { 'content-type': 'application/json' },
  });
}

function fetcher(queue: readonly Canned[]): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let index = 0;

  const fetch: FetchLike = (url, init) => {
    const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
    const rawBody = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      headers,
      body: rawBody === undefined ? undefined : JSON.parse(rawBody),
      signal: init?.signal,
    });

    const canned = queue[index];
    index += 1;
    if (canned === undefined) throw new Error(`test: no canned response for call ${index}`);
    return Promise.resolve(jsonResponse(canned));
  };

  return { fetch, calls };
}

const CREATED_PROJECT: Canned = {
  status: 201,
  body: {
    project: { id: 'proj-fake-1', name: 'brainz-alice' },
    branch: { id: 'br-fake-1', name: 'main' },
    databases: [{ name: 'neondb', owner_name: 'neondb_owner' }],
    roles: [{ name: 'neondb_owner' }],
    endpoints: [{ id: 'ep-fake-1' }],
    connection_uris: [{ connection_uri: 'postgres://fake' }],
  },
};

function api(queue: readonly Canned[]) {
  const { fetch, calls } = fetcher(queue);
  return {
    calls,
    neon: createNeonProjectApi({
      apiKey: API_KEY,
      fetch,
      regionId: 'aws-us-east-2',
      sleep: () => Promise.resolve(),
    }),
  };
}

describe('creating a project', () => {
  test('posts to the projects endpoint with a bearer key', async () => {
    const { neon, calls } = api([CREATED_PROJECT]);

    const created = await neon.createProject({ name: 'brainz-alice', suspendTimeoutSeconds: 60 });

    expect(created).toEqual({ projectId: 'proj-fake-1', branchId: 'br-fake-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${NEON_API_BASE_URL}/projects`);
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${API_KEY}`);
  });

  /**
   * A default is a decision, and this one costs money on every query forever.
   *
   * A caller that names no region gets whatever this adapter last shipped, and
   * for several units that was Neon's own console default — a region no part of
   * this system is in. A tenant database a continent from the fleet pays a
   * cross-country round trip on every statement, which is KTD2's warm-p99
   * promise spent on nothing, and it is invisible to every other test here
   * because they all pass a region explicitly. The major version is pinned to
   * the control plane's for the smaller reason: an operator reading both in one
   * session should not be reading two planners.
   */
  test('places a project beside the fleet when the caller names no region', async () => {
    const { fetch, calls } = fetcher([CREATED_PROJECT]);
    const neon = createNeonProjectApi({ apiKey: API_KEY, fetch, sleep: () => Promise.resolve() });

    await neon.createProject({ name: 'brainz-alice', suspendTimeoutSeconds: 60 });

    const body = calls[0]?.body as { project: { region_id: string; pg_version: number } };
    expect(body.project.region_id).toBe('aws-us-west-2');
    expect(body.project.pg_version).toBe(18);
  });

  test('creates in a personal account when no organisation is named, and in the organisation when one is', async () => {
    const personal = fetcher([CREATED_PROJECT]);
    await createNeonProjectApi({
      apiKey: API_KEY,
      fetch: personal.fetch,
      sleep: () => Promise.resolve(),
    }).createProject({ name: 'brainz-alice', suspendTimeoutSeconds: 60 });
    // Absent, not `undefined`: an `org_id: undefined` serialises to a key Neon
    // has to interpret, and this adapter must send nothing it was not given.
    expect(Object.keys((personal.calls[0]?.body as { project: object }).project)).not.toContain(
      'org_id',
    );

    const orged = fetcher([CREATED_PROJECT]);
    await createNeonProjectApi({
      apiKey: API_KEY,
      fetch: orged.fetch,
      orgId: 'org-fake-do-not-use',
      sleep: () => Promise.resolve(),
    }).createProject({ name: 'brainz-alice', suspendTimeoutSeconds: 60 });
    expect((orged.calls[0]?.body as { project: { org_id: string } }).project.org_id).toBe(
      'org-fake-do-not-use',
    );
  });

  /**
   * The org scope belongs on the *search* too, and leaving it off broke the one
   * path that exists to prevent an orphan.
   *
   * A create that succeeds at the vendor and then fails to return leaves a
   * billable project the control plane cannot name, and
   * `provision.ts:cleanupArtifacts` recovers it the only way left — by its
   * deterministic name, through this call. Against an organisation-scoped API
   * key, `GET /projects` with no `org_id` is a **400** (checked against the live
   * API: `"org_id is required"`), so the recovery threw `NeonApiError` before it
   * could look, and the retry that was supposed to delete the orphan created a
   * second project beside it instead. A create that scopes to an org and a
   * search that does not are also simply asking about two different places.
   */
  test('scopes the recovery search to the same organisation the create used', async () => {
    const { fetch, calls } = fetcher([{ status: 200, body: { projects: [] } }]);
    await createNeonProjectApi({
      apiKey: API_KEY,
      fetch,
      orgId: 'org-fake-do-not-use',
      sleep: () => Promise.resolve(),
    }).searchProjectsByName('brainz-alice');

    const query = new URL(calls[0]?.url ?? '').searchParams;
    expect(query.get('org_id')).toBe('org-fake-do-not-use');
    expect(query.get('search')).toBe('brainz-alice');
  });

  test('and omits it entirely for a personal-account key', async () => {
    const { fetch, calls } = fetcher([{ status: 200, body: { projects: [] } }]);
    await createNeonProjectApi({ apiKey: API_KEY, fetch, sleep: () => Promise.resolve() })
      .searchProjectsByName('brainz-alice');

    // Not `org_id=undefined`, which is a value the API has to interpret.
    expect(new URL(calls[0]?.url ?? '').searchParams.has('org_id')).toBe(false);
  });

  /**
   * The one account shape where sending the cost lever is a hard refusal.
   *
   * Measured against the live API, not guessed: a create carrying
   * `default_endpoint_settings.suspend_timeout_seconds` against a free-plan
   * organisation answers **412** — `"modifying the suspend interval is not
   * permitted on this account"` — and creates nothing. Nothing about the message
   * says which field is at fault; the whole provision fails as
   * `project_create_failed`.
   *
   * **The omission is configuration and must never be a fallback.** Retrying
   * without the field after a 412 would be a plausible-looking adapter fix and
   * the wrong one: the field is R13's idle anchor, so a paid deployment that
   * quietly stopped sending it would be a fleet of computes suspending on
   * whatever the vendor decides, discovered on an invoice. So the caller states
   * that its account cannot take the setting, and the default is to send it.
   */
  test('omits the suspend setting only when the account is declared unable to take one', async () => {
    const sent = fetcher([CREATED_PROJECT]);
    await createNeonProjectApi({
      apiKey: API_KEY,
      fetch: sent.fetch,
      sleep: () => Promise.resolve(),
    }).createProject({ name: 'brainz-alice', suspendTimeoutSeconds: 60 });
    expect(
      (sent.calls[0]?.body as { project: { default_endpoint_settings?: object } }).project
        .default_endpoint_settings,
    ).toEqual({ suspend_timeout_seconds: 60 });

    const omitted = fetcher([CREATED_PROJECT]);
    await createNeonProjectApi({
      apiKey: API_KEY,
      fetch: omitted.fetch,
      suspendTimeoutSettable: false,
      sleep: () => Promise.resolve(),
    }).createProject({ name: 'brainz-alice', suspendTimeoutSeconds: 60 });
    const project = (omitted.calls[0]?.body as { project: Record<string, unknown> }).project;
    // Absent, not an empty object: `default_endpoint_settings: {}` is still a
    // modification of the endpoint settings as far as the 412 is concerned.
    expect(Object.keys(project)).not.toContain('default_endpoint_settings');
    expect(project['name']).toBe('brainz-alice');
  });

  test('carries the one-minute suspend delay onto the wire', async () => {
    const { neon, calls } = api([CREATED_PROJECT]);

    await neon.createProject({ name: 'brainz-alice', suspendTimeoutSeconds: 60 });

    const body = calls[0]?.body as {
      project: { name: string; default_endpoint_settings: { suspend_timeout_seconds: number } };
    };
    expect(body.project.name).toBe('brainz-alice');
    expect(body.project.default_endpoint_settings.suspend_timeout_seconds).toBe(60);
  });

  test('a 200 that does not name a project is a failure, not a project called undefined', async () => {
    const { neon } = api([{ status: 201, body: { project: {}, branch: {} } }]);

    await expect(
      neon.createProject({ name: 'brainz-alice', suspendTimeoutSeconds: 60 }),
    ).rejects.toThrow(NeonApiError);
  });
});

describe('creating the role and database', () => {
  const ROLE: Canned = { status: 201, body: { role: { name: 'brainz_owner' } } };
  const DATABASE: Canned = { status: 201, body: { database: { name: 'brainz' } } };
  const URI: Canned = {
    status: 200,
    body: { uri: 'postgres://brainz_owner:pw-fake@ep-fake.example.invalid/brainz' },
  };

  test('creates the role, then the database it owns, then asks for the URI', async () => {
    const { neon, calls } = api([ROLE, DATABASE, URI]);

    const result = await neon.createRoleAndDatabase({
      projectId: 'proj-fake-1',
      branchId: 'br-fake-1',
      roleName: 'brainz_owner',
      databaseName: 'brainz',
    });

    expect(result.roleName).toBe('brainz_owner');
    expect(result.databaseName).toBe('brainz');
    expect(result.connectionString).toBe(
      'postgres://brainz_owner:pw-fake@ep-fake.example.invalid/brainz',
    );

    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'POST /api/v2/projects/proj-fake-1/branches/br-fake-1/roles',
      'POST /api/v2/projects/proj-fake-1/branches/br-fake-1/databases',
      'GET /api/v2/projects/proj-fake-1/connection_uri',
    ]);

    const query = new URL(calls[2]?.url ?? '').searchParams;
    expect(query.get('branch_id')).toBe('br-fake-1');
    expect(query.get('database_name')).toBe('brainz');
    expect(query.get('role_name')).toBe('brainz_owner');
  });

  test('the database is owned by the role that was just created', async () => {
    const { neon, calls } = api([ROLE, DATABASE, URI]);

    await neon.createRoleAndDatabase({
      projectId: 'proj-fake-1',
      branchId: 'br-fake-1',
      roleName: 'brainz_owner',
      databaseName: 'brainz',
    });

    expect(calls[1]?.body).toEqual({ database: { name: 'brainz', owner_name: 'brainz_owner' } });
  });

  test('a locked project is retried — Neon serialises operations per project', async () => {
    const { neon, calls } = api([
      { status: 423, body: { message: 'project already has an operation in progress' } },
      ROLE,
      DATABASE,
      URI,
    ]);

    const result = await neon.createRoleAndDatabase({
      projectId: 'proj-fake-1',
      branchId: 'br-fake-1',
      roleName: 'brainz_owner',
      databaseName: 'brainz',
    });

    expect(result.roleName).toBe('brainz_owner');
    expect(calls).toHaveLength(4);
  });

  /**
   * The retry budget has to outlast a *fresh project*, and it did not.
   *
   * Measured, on the first live signup this fleet ever ran: `POST /projects`
   * returned, the role create that follows it immediately answered `423`, and
   * the whole budget — three attempts, `500ms` then `1000ms` of backoff — was
   * spent inside the first second and a half. The project's own operations
   * (`create_timeline`, `start_compute`, `apply_config`) took **six seconds** to
   * finish, read back from `GET /projects/{id}/operations`. Neon serialises
   * operations per project, so every attempt in that window is a `423` by
   * construction: the sequence could not succeed, and a first signup on a real
   * account failed `role_create_failed` having created and paid for a project.
   *
   * So the assertion is against the measured window rather than against an
   * attempt count — an attempt count is the thing that was wrong, and a test
   * asserting the number of tries would have passed on the old budget too. The
   * clock is virtual, so this costs nothing and cannot flake.
   */
  test('outlasts the six seconds a freshly created project spends locked', async () => {
    let elapsed = 0;
    const calls: string[] = [];
    // Every request while the project is settling is a 423; the moment it is
    // done, the ordinary responses.
    const queue = [ROLE, DATABASE, URI];
    let index = 0;
    const fetch: FetchLike = (_url, init) => {
      calls.push(String(init?.method ?? 'GET'));
      if (elapsed < 6_000) {
        return Promise.resolve(jsonResponse({ status: 423, body: { message: 'in progress' } }));
      }
      const canned = queue[index];
      index += 1;
      if (canned === undefined) throw new Error('test: ran past the canned responses');
      return Promise.resolve(jsonResponse(canned));
    };

    const neon = createNeonProjectApi({
      apiKey: API_KEY,
      fetch,
      sleep: (ms) => {
        elapsed += ms;
        return Promise.resolve();
      },
    });

    const result = await neon.createRoleAndDatabase({
      projectId: 'proj-fake-1',
      branchId: 'br-fake-1',
      roleName: 'brainz_owner',
      databaseName: 'brainz',
    });

    expect(result.roleName).toBe('brainz_owner');
    // The run deadline is 300s and the signal reaches the socket, so the budget
    // is bounded by something real rather than by this number.
    expect(elapsed).toBeLessThan(60_000);
  });

  test('a bad request is not retried — retrying a rejection is just a slower rejection', async () => {
    const { neon, calls } = api([{ status: 400, body: { message: 'bad role name' } }]);

    await expect(
      neon.createRoleAndDatabase({
        projectId: 'proj-fake-1',
        branchId: 'br-fake-1',
        roleName: 'brainz_owner',
        databaseName: 'brainz',
      }),
    ).rejects.toThrow(NeonApiError);
    expect(calls).toHaveLength(1);
  });
});

/**
 * The deadline provisioning enforces is only a real bound if the HTTP call it
 * wraps can be cut off. A request left hanging on a socket outlives the run's
 * deadline and then the window after which its control-plane row is presumed
 * dead — at which point a second run legitimately takes the tenant over while
 * this one is still in flight, which is the interleave `provision.ts` spends a
 * fencing token surviving. So the signal is asserted on the wire, not in a
 * comment.
 */
describe('the caller can actually cancel', () => {
  // Declared here rather than reused from the block above: these tests are about
  // cancellation, and borrowing another describe's fixtures would couple them.
  const ROLE: Canned = { status: 201, body: { role: { name: 'brainz_owner' } } };
  const DATABASE: Canned = { status: 201, body: { database: { name: 'brainz' } } };
  const URI: Canned = {
    status: 200,
    body: { uri: 'postgres://brainz_owner:pw-fake@ep-fake.example.invalid/brainz' },
  };

  test('the signal is passed into fetch on project create', async () => {
    const controller = new AbortController();
    const { neon, calls } = api([CREATED_PROJECT]);

    await neon.createProject({
      name: 'brainz-alice',
      suspendTimeoutSeconds: 60,
      signal: controller.signal,
    });

    expect(calls[0]?.signal).toBe(controller.signal);
  });

  test('the signal reaches every call the role/database create makes', async () => {
    const controller = new AbortController();
    const { neon, calls } = api([ROLE, DATABASE, URI]);

    await neon.createRoleAndDatabase({
      projectId: 'proj-fake-1',
      branchId: 'br-fake-1',
      roleName: 'brainz_owner',
      databaseName: 'brainz',
      signal: controller.signal,
    });

    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
  });

  test('an aborted run stops retrying instead of sleeping through its backoff', async () => {
    // A `423` is retryable, and ordinarily this makes four calls. Once the run
    // has been cancelled the answer is already known and nobody is waiting for
    // it, so spending the backoff and trying again is pure cost.
    const controller = new AbortController();
    controller.abort();
    const { neon, calls } = api([
      { status: 423, body: { message: 'project already has an operation in progress' } },
      ROLE,
      DATABASE,
      URI,
    ]);

    await expect(
      neon.createRoleAndDatabase({
        projectId: 'proj-fake-1',
        branchId: 'br-fake-1',
        roleName: 'brainz_owner',
        databaseName: 'brainz',
        signal: controller.signal,
      }),
    ).rejects.toThrow(NeonApiError);
    expect(calls).toHaveLength(1);
  });

  test('a request with no signal carries none — the field is not invented', async () => {
    const { neon, calls } = api([CREATED_PROJECT]);

    await neon.createProject({ name: 'brainz-alice', suspendTimeoutSeconds: 60 });

    expect(calls[0]?.signal ?? undefined).toBeUndefined();
  });
});

describe('deleting a project', () => {
  test('deletes by id', async () => {
    const { neon, calls } = api([{ status: 200, body: { project: { id: 'proj-fake-1' } } }]);

    await neon.deleteProject('proj-fake-1');

    expect(calls[0]?.method).toBe('DELETE');
    expect(new URL(calls[0]?.url ?? '').pathname).toBe('/api/v2/projects/proj-fake-1');
  });

  test('an already-absent project is a successful delete', async () => {
    // Cleanup is idempotent by necessity: the retry path deletes a project that
    // a previous retry may already have removed, and that must not fail a
    // provision.
    const { neon } = api([{ status: 404, body: { message: 'not found' } }]);

    await expect(neon.deleteProject('proj-fake-1')).resolves.toBeUndefined();
  });
});

describe('searching for projects by name', () => {
  function pagedApi(queue: readonly Canned[]) {
    const { fetch, calls } = fetcher(queue);
    return {
      calls,
      neon: createNeonProjectApi({ apiKey: API_KEY, fetch, pageSize: 2, sleep: () => Promise.resolve() }),
    };
  }

  test('returns every page, and the caller still gets partial matches', async () => {
    // Neon documents `search` as a partial match on name or id. The adapter does
    // not filter — narrowing here would hide the hazard from the one place that
    // knows what an exact match means.
    const { neon, calls } = pagedApi([
      {
        status: 200,
        body: {
          projects: [
            { id: 'proj-1', name: 'brainz-alice' },
            { id: 'proj-2', name: 'brainz-alice2' },
          ],
          pagination: { cursor: 'cursor-1' },
        },
      },
      { status: 200, body: { projects: [{ id: 'proj-3', name: 'brainz-alice-old' }] } },
    ]);

    const found = await neon.searchProjectsByName('brainz-alice');

    expect(found).toEqual([
      { projectId: 'proj-1', name: 'brainz-alice' },
      { projectId: 'proj-2', name: 'brainz-alice2' },
      { projectId: 'proj-3', name: 'brainz-alice-old' },
    ]);
    expect(new URL(calls[0]?.url ?? '').searchParams.get('search')).toBe('brainz-alice');
    expect(new URL(calls[1]?.url ?? '').searchParams.get('cursor')).toBe('cursor-1');
    expect(calls).toHaveLength(2);
  });

  test('a short page ends the walk even when a cursor comes back with it', async () => {
    // Neon returns a cursor alongside the last page too. Following it because it
    // is present is how a paginator loops forever against a live account.
    const { neon, calls } = pagedApi([
      {
        status: 200,
        body: { projects: [{ id: 'proj-1', name: 'brainz-alice' }], pagination: { cursor: 'c1' } },
      },
    ]);

    await expect(neon.searchProjectsByName('brainz-alice')).resolves.toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  test('no matches is an empty list, not an error', async () => {
    const { neon } = api([{ status: 200, body: { projects: [] } }]);

    await expect(neon.searchProjectsByName('brainz-nobody')).resolves.toEqual([]);
  });
});

describe('what an error is allowed to say', () => {
  test('it names the status and the operation', async () => {
    const { neon } = api([{ status: 402, body: { message: 'payment required' } }]);

    try {
      await neon.createProject({ name: 'brainz-alice', suspendTimeoutSeconds: 60 });
      throw new Error('test: expected a NeonApiError');
    } catch (error) {
      expect(error).toBeInstanceOf(NeonApiError);
      const failure = error as NeonApiError;
      expect(failure.status).toBe(402);
      expect(failure.operation).toBe('createProject');
    }
  });

  test('it never carries the API key, and never the response body', async () => {
    // A thrown error is the most casually-logged object in any system, and this
    // one is thrown while holding a platform credential (R10).
    const { neon } = api([
      { status: 500, body: { message: `internal error for key ${API_KEY}`, request_id: 'req-1' } },
    ]);

    try {
      await neon.createProject({ name: 'brainz-alice', suspendTimeoutSeconds: 60 });
      throw new Error('test: expected a NeonApiError');
    } catch (error) {
      const text = `${String(error)}${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
      expect(text).not.toContain(API_KEY);
      expect(text).not.toContain('req-1');
      expect(text).not.toContain('internal error for key');
    }
  });

  test('a server error is retried, then gives up with the last status', async () => {
    // Derived from the budget rather than written down beside it: the attempt
    // count is a number that has already been wrong once (see the six-second
    // lock test above), and a literal here would have to be found and edited
    // every time it moves, which is how a suite ends up pinning the old value.
    const { neon, calls } = api(
      Array.from({ length: DEFAULT_MAX_ATTEMPTS }, () => ({ status: 500, body: {} })),
    );

    await expect(
      neon.createProject({ name: 'brainz-alice', suspendTimeoutSeconds: 60 }),
    ).rejects.toThrow(NeonApiError);
    expect(calls).toHaveLength(DEFAULT_MAX_ATTEMPTS);
  });
});
