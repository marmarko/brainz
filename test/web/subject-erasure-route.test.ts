/**
 * R12's subject-scoped erasure, and the surface a correspondent's request can
 * actually be executed through.
 *
 * **What was missing.** `src/core/lifecycle/subject-erasure.ts` is complete: it
 * resolves a correspondent through the entity graph and the identifier as text,
 * names every row it will take, sweeps the three residue classes the 72h purge
 * cannot reach, and writes the re-ingestion tombstone. Its header says it is
 * *"invocable by the controlling user, out of band"* and that it *"exports a
 * function and registers no MCP tool"*. Both halves of that were true and the
 * second half had swallowed the first: `eraseSubject` and
 * `previewSubjectErasure` were imported by their own test and by nothing else
 * in `src/`. There was no out of band. A correspondent could ask, and the only
 * way to answer them was to run a test harness against somebody's brain.
 *
 * **The route is driven through the real handler**, the way `app.test.ts`
 * drives the rest of the app, because the properties under test — a 501 on an
 * unwired port, a 403 on a request carrying no `Origin`, a 401 before any of it
 * — are properties of the routing and a test that called the handler underneath
 * would assert none of them.
 *
 * **The assertion that matters most is a negative one.** On every refusal the
 * port must not have been *reached*. A route that checked the confirmation
 * after calling `execute` would pass a test that only read the status code, and
 * would have erased the correspondent before deciding it should not have.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { attachBrain } from '../../src/control/accounts.ts';
import {
  SESSION_COOKIE,
  createWebApp,
  readCookie,
  type SubjectErasurePort,
} from '../../src/web/app.ts';
import {
  connect as connectControl,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from '../worker/fixture.ts';
import {
  connect as connectIdentity,
  createIdentityStore,
  dropIdentityStore,
  TEST_HASH_COST,
  type IdentityFixture,
} from '../control/identity-fixture.ts';

const ORIGIN = 'https://app.brainz.example';
const AT = new Date('2026-08-16T09:00:00.000Z');
const TENANT = 'erasure-route-alice';
/** A correspondent, not the account holder. The whole point of the axis. */
const SUBJECT = 'charlie-example@example.com';

let identity: IdentityFixture;
let control: ControlFixture;
let sql: SQL;
let controlSql: SQL;

/** What the port was asked. A refusal that reached it is the failure here. */
let asked: { previews: unknown[]; executions: unknown[] };

const PREVIEW = {
  subjectDigest: 'a'.repeat(64),
  entityIds: ['41'],
  surfaceForms: [SUBJECT, 'Charlie', 'Al'],
  pages: [{ pageId: '7', handle: 'text' }],
  rows: [{ kind: 'fact', id: '3', excerpt: 'Charlie asked about the lease', handle: 'text' }],
  removed: { pages: 1, chunks: 2, facts: 1 },
  recomputed: { facts: 2, entityCards: 1 },
  recomputeRequired: true,
} as const;

function port(options: { readonly refuse?: string } = {}): SubjectErasurePort {
  return {
    preview(request) {
      asked.previews.push({ ...request });
      return Promise.resolve(PREVIEW);
    },
    execute(request) {
      asked.executions.push({ ...request });
      if (options.refuse !== undefined) {
        return Promise.resolve({ ok: false as const, reason: options.refuse });
      }
      return Promise.resolve({
        ok: true as const,
        subjectDigest: PREVIEW.subjectDigest,
        removed: PREVIEW.removed,
        recomputeRequired: true,
        reingestionTombstoned: true,
        rawObjectsRemoved: 1,
        rawObjectsUnreachable: 0,
        attachmentObjectsRemoved: 0,
        attachmentObjectsUnreachable: 2,
        unrecoverableAfterDays: 7,
        erasedAt: AT.toISOString(),
      });
    },
  };
}

function app(options: { readonly wired?: boolean; readonly refuse?: string } = {}) {
  return createWebApp({
    sql,
    controlSql,
    origin: ORIGIN,
    mcpUrl: 'https://mcp.brainz.example/mcp',
    stripeWebhookSecret: 'whsec_invented_here',
    now: () => AT,
    hash: TEST_HASH_COST,
    provisioner: {
      provision: () => Promise.resolve({ ok: true as const, tenantId: TENANT, via: 'synchronous' as const }),
    },
    byok: {
      put: () => Promise.resolve({ ok: true }),
      revoke: () => Promise.resolve({ ok: true }),
    },
    connectors: {
      mintClaimUrl: () => Promise.reject(new Error('not used here')),
      disconnect: () => Promise.reject(new Error('not used here')),
    },
    // Absent when `wired: false`, so the "no port" branch is a state a test can
    // reach rather than a comment.
    ...(options.wired === false
      ? {}
      : { subjectErasure: port(options.refuse === undefined ? {} : { refuse: options.refuse }) }),
  });
}

function get(path: string, cookie?: string): Request {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers['cookie'] = cookie;
  return new Request(`${ORIGIN}${path}`, { headers });
}

function post(
  path: string,
  fields: unknown,
  options: { readonly cookie?: string; readonly origin?: string | null } = {},
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.origin !== null) headers['origin'] = options.origin ?? ORIGIN;
  if (options.cookie !== undefined) headers['cookie'] = options.cookie;
  return new Request(`${ORIGIN}${path}`, { method: 'POST', headers, body: JSON.stringify(fields) });
}

/** A signed-in account whose brain is a seeded tenant. */
async function signedIn(options: { readonly withBrain?: boolean } = {}): Promise<string> {
  const handle = app();
  const created = await handle(
    post('/api/signup', {
      email: 'alice@example.com',
      password: 'correct horse battery staple',
      fts_language: 'simple',
    }),
  );
  const header = created.headers.get('set-cookie') ?? '';
  const token = readCookie(header.split(';')[0] ?? '', SESSION_COOKIE) ?? '';
  const body = (await created.json()) as { account_id: string };

  if (options.withBrain === false) {
    // Signup provisions, so the only way to reach the "no brain yet" arm is to
    // take the mapping away again — which is also the real state it models: an
    // account whose provisioning never completed.
    await sql`DELETE FROM account.brain WHERE account_id = ${body.account_id}::account.account_id`;
  } else {
    await seedTenant(controlSql, TENANT);
    await attachBrain(sql, {
      accountId: body.account_id,
      tenantId: TENANT,
      ftsLanguage: 'simple',
      now: AT,
    });
  }
  return `${SESSION_COOKIE}=${token}`;
}

beforeAll(async () => {
  identity = await createIdentityStore('erasureroute');
  control = await createControlPlane('erasureroute');
  sql = connectIdentity(identity);
  controlSql = connectControl(control);
}, 120_000);

afterAll(async () => {
  await sql?.close();
  await controlSql?.close();
  if (identity !== undefined) await dropIdentityStore(identity);
  if (control !== undefined) await dropControlPlane(control);
});

beforeEach(async () => {
  await sql`DELETE FROM account.account`;
  await controlSql`DELETE FROM control.job`;
  await controlSql`DELETE FROM control.tenant`;
  asked = { previews: [], executions: [] };
});

describe('the surface exists at all', () => {
  test('a signed-in controller can read what erasing a correspondent would take', async () => {
    const cookie = await signedIn();
    const response = await app()(get(`/api/subject-erasure/preview?identifier=${encodeURIComponent(SUBJECT)}`, cookie));

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    // Named rows, not a count. The module's own mitigation is that the
    // controller can see what they are authorising.
    expect(body.rows).toEqual([
      { kind: 'fact', id: '3', excerpt: 'Charlie asked about the lease', handle: 'text' },
    ]);
    // Every spelling the sweep will match on, including the two-character
    // inferred alias that is the widest thing it could reach.
    expect(body.surface_forms).toEqual([SUBJECT, 'Charlie', 'Al']);
    // The expensive half a removal-only preview would omit.
    expect(body.recomputed).toEqual({ facts: 2, entityCards: 1 });
    expect(body.recompute_required).toBe(true);
    expect(asked.previews).toEqual([{ tenantId: TENANT, identifier: SUBJECT }]);
  });

  test('and can then instruct it, and is handed a receipt that names the tombstone', async () => {
    const cookie = await signedIn();
    const response = await app()(
      post('/api/subject-erasure', { identifier: SUBJECT, confirm: SUBJECT }, { cookie }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(asked.executions).toEqual([
      { tenantId: TENANT, identifier: SUBJECT, confirm: SUBJECT },
    ]);
    // The digest, never the address: a receipt for an erasure must not be the
    // one place the identifier survives.
    expect(body.subject_digest).toBe(PREVIEW.subjectDigest);
    expect(String(JSON.stringify(body))).not.toContain(SUBJECT);
    // The property U15's determination flags as most likely to be missed, and
    // the bound a data-subject answer has to quote.
    expect(body.reingestion_tombstoned).toBe(true);
    expect(body.unrecoverable_after_days).toBe(7);
    // Objects this run could not reach are reported rather than rounded down.
    expect(body.attachment_objects_unreachable).toBe(2);
  });

  test('a refusal from the port is the port’s word, not a 200 with a sad payload', async () => {
    const cookie = await signedIn();
    const response = await app({ refuse: 'not_confirmed' })(
      post('/api/subject-erasure', { identifier: SUBJECT, confirm: SUBJECT }, { cookie }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, code: 'not_confirmed' });
  });
});

describe('every refusal happens before the port is reached', () => {
  test('a confirmation that is not an exact echo erases nothing', async () => {
    const cookie = await signedIn();

    for (const confirm of ['', 'yes', 'true', SUBJECT.toUpperCase(), `${SUBJECT} `.trim().slice(0, -1)]) {
      const response = await app()(
        post('/api/subject-erasure', { identifier: SUBJECT, confirm }, { cookie }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ ok: false, code: 'not_confirmed' });
    }

    // The load-bearing assertion. A route that checked the echo *after* calling
    // the port would satisfy every status assertion above and would already have
    // erased the correspondent.
    expect(asked.executions).toEqual([]);
  });

  test('a request with no identifier is refused before anything is resolved', async () => {
    const cookie = await signedIn();

    const preview = await app()(get('/api/subject-erasure/preview', cookie));
    const execute = await app()(post('/api/subject-erasure', { confirm: '' }, { cookie }));

    expect(preview.status).toBe(400);
    expect(await preview.json()).toEqual({ ok: false, code: 'identifier_required' });
    expect(execute.status).toBe(400);
    // Not `not_confirmed`: an empty identifier with an empty confirm is an echo
    // of nothing, and answering that it was unconfirmed would send the caller
    // round a loop they cannot exit.
    expect(await execute.json()).toEqual({ ok: false, code: 'identifier_required' });
    expect(asked).toEqual({ previews: [], executions: [] });
  });

  test('a state-changing request carrying no Origin is refused, as every other one is', async () => {
    const cookie = await signedIn();
    const response = await app()(
      post('/api/subject-erasure', { identifier: SUBJECT, confirm: SUBJECT }, { cookie, origin: null }),
    );

    expect(response.status).toBe(403);
    expect(asked.executions).toEqual([]);
  });

  test('a stranger gets nothing at all', async () => {
    const preview = await app()(get(`/api/subject-erasure/preview?identifier=${SUBJECT}`));
    const execute = await app()(post('/api/subject-erasure', { identifier: SUBJECT, confirm: SUBJECT }));

    expect(preview.status).toBe(401);
    expect(execute.status).toBe(401);
    expect(asked).toEqual({ previews: [], executions: [] });
  });

  test('an account with no brain yet is a 409 rather than an erasure of nobody', async () => {
    const cookie = await signedIn({ withBrain: false });
    const response = await app()(
      post('/api/subject-erasure', { identifier: SUBJECT, confirm: SUBJECT }, { cookie }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, code: 'no_brain_yet' });
    expect(asked.executions).toEqual([]);
  });
});

describe('a deployment with no port wired says so', () => {
  test('both routes answer 501 rather than a receipt nothing performed', async () => {
    const cookie = await signedIn();
    const preview = await app({ wired: false })(
      get(`/api/subject-erasure/preview?identifier=${SUBJECT}`, cookie),
    );
    const execute = await app({ wired: false })(
      post('/api/subject-erasure', { identifier: SUBJECT, confirm: SUBJECT }, { cookie }),
    );

    expect(preview.status).toBe(501);
    expect(execute.status).toBe(501);
    expect(await execute.json()).toEqual({ ok: false, code: 'unavailable' });
  });
});
