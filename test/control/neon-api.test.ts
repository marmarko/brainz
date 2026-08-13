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
    const { neon, calls } = api([
      { status: 500, body: {} },
      { status: 500, body: {} },
      { status: 500, body: {} },
    ]);

    await expect(
      neon.createProject({ name: 'brainz-alice', suspendTimeoutSeconds: 60 }),
    ).rejects.toThrow(NeonApiError);
    expect(calls).toHaveLength(3);
  });
});
