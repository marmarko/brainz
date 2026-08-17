/**
 * `/admin?op=tenant_directory` — the list an operator reads *before* deleting
 * anything.
 *
 * **The incident this file exists for.** A cleanup deleted every vendor project
 * whose name matched a tenant-id prefix. One of them was a real user's brain.
 * The vendor project name derives from the tenant id and nothing else, so at the
 * moment of deletion a throwaway and a person's brain are the same string; and
 * every fleet operation `/admin` had took a tenant id the operator *already
 * had*, so none of them could answer "whose is this?" or even "what exists?".
 *
 * **What that means for the assertions here, and why a one-tenant test would be
 * worthless.** A listing proves nothing about a list. So the fixture seeds
 * several, and deliberately includes the two shapes a careless join gets wrong:
 *
 *  * a tenant with **no owner at all** — the canary has none, and reporting it
 *    as owned (or dropping it) is a wrong answer in both directions;
 *  * an **account with no brain** — which must appear nowhere in a list of
 *    tenants, and which a `FROM account.account LEFT JOIN account.brain` would
 *    emit as a row with a null tenant id.
 *
 * **And why the privacy assertions are about the shape returned.** "The response
 * does not contain an address" passes trivially if no fixture has one that would
 * leak. Every account below has a distinctive local part, the response is
 * asserted to carry an exact key set rather than merely to omit a string, and
 * the digest is recomputed here from the address so the recipe an operator runs
 * is load-bearing rather than decorative.
 *
 * Driven through the real `Request`/`Response` handler wherever the property is
 * about the surface — the credential gate, the method, what an ordinary session
 * gets — because a test calling `adminDispatch` directly asserts none of that.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { SQL } from 'bun';

import { createWebApp } from '../../src/web/app.ts';
import {
  OWNER_DIGEST_CHARS,
  TENANT_DIRECTORY_LIMIT,
  adminDispatch,
  createBrainOwnerDirectory,
  redactOwnerEmail,
  resolveDirectoryLimit,
} from '../../src/web/admin.ts';
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
const MCP_URL = 'https://mcp.brainz.example/mcp';
const ADMIN_CREDENTIAL = 'bzadm_operator';
const AT = new Date('2026-08-17T09:00:00.000Z');

/**
 * The fixture, and every part of it is doing a job.
 *
 * The local parts are distinctive on purpose: `anna.mailbox` and `brendan` and
 * `carol` appear in no other string this suite produces, so an assertion that
 * one of them is absent from a response is an assertion about the response
 * rather than about a coincidence.
 *
 * `zz-` on the canary is so the ordering assertion has something to say: the
 * directory sorts by tenant id, and a fixture whose seed order and sort order
 * agree cannot tell the two apart.
 */
const ANNA = { account: 'acct-anna', tenant: 't-anna', email: 'anna.mailbox@widget-co.example' };
const BRENDAN = { account: 'acct-brendan', tenant: 't-brendan', email: 'brendan@mailhost.example' };
const CANARY_TENANT = 'zz-canary-probe';
/** An account that never provisioned. It owns nothing, so it is nowhere below. */
const CAROL = { account: 'acct-carol', email: 'carol.no-brain@mailhost.example' };

const ACTIVE_AT = new Date('2026-08-16T12:00:00.000Z');

let identity: IdentityFixture;
let control: ControlFixture;
let sql: SQL;
let controlSql: SQL;

function app(overrides: { adminCredential?: string } = {}) {
  return createWebApp({
    sql,
    controlSql,
    origin: ORIGIN,
    mcpUrl: MCP_URL,
    stripeWebhookSecret: 'whsec_a_secret_this_test_invented_and_stripe_never_saw',
    adminCredential: overrides.adminCredential ?? ADMIN_CREDENTIAL,
    now: () => AT,
    hash: TEST_HASH_COST,
    byok: {
      put: () => Promise.resolve({ ok: true }),
      revoke: () => Promise.resolve({ ok: true }),
    },
    provisioner: {
      provision: () =>
        Promise.resolve({ ok: true as const, tenantId: 't-provisioned', via: 'synchronous' as const }),
    },
  });
}

function get(path: string, options: { cookie?: string; authorization?: string } = {}) {
  const headers: Record<string, string> = {};
  if (options.cookie !== undefined) headers['cookie'] = options.cookie;
  if (options.authorization !== undefined) headers['authorization'] = options.authorization;
  return new Request(`${ORIGIN}${path}`, { headers });
}

const authorized = { authorization: `Bearer ${ADMIN_CREDENTIAL}` };

/** What an operator holding an address computes, exactly as `docs/deploy.md` says. */
function expectedDigest(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 12);
}

interface DirectoryRow {
  readonly tenant_id: string;
  readonly state: string;
  readonly tier: string;
  readonly last_activity: string | null;
  readonly owner: { readonly domain: string; readonly digest: string } | null;
}

async function directory(query = ''): Promise<{
  status: number;
  body: { content?: { tenants?: DirectoryRow[]; total?: number; truncated?: boolean } };
  text: string;
}> {
  const response = await app()(get(`/admin?op=tenant_directory${query}`, authorized));
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) as never, text };
}

async function reset(): Promise<void> {
  await sql`DELETE FROM account.account`;
  await controlSql`DELETE FROM control.job`;
  await controlSql`DELETE FROM control.tenant`;
}

/**
 * Written with raw statements rather than through signup, so the fixture is the
 * *state* being asserted about rather than a by-product of another unit's
 * behaviour — and so "an account with no brain" is a row that exists rather
 * than one produced by deleting half of what signup wrote.
 */
async function seedFleet(): Promise<void> {
  await seedTenant(controlSql, ANNA.tenant, { lastActivity: ACTIVE_AT });
  await controlSql`UPDATE control.tenant SET tier = 'internal' WHERE tenant_id = ${ANNA.tenant}`;
  await seedTenant(controlSql, BRENDAN.tenant, { state: 'provisioning' });
  await seedTenant(controlSql, CANARY_TENANT);

  for (const person of [ANNA, BRENDAN]) {
    await sql`
      INSERT INTO account.account (account_id, email, email_verified)
      VALUES (${person.account}, ${person.email}, true)`;
    await sql`
      INSERT INTO account.brain (account_id, tenant_id, fts_language)
      VALUES (${person.account}, ${person.tenant}, 'simple')`;
  }

  // The account with no brain. It has to be an ordinary, active, verified
  // account — an account in some odd state would be excluded by accident and
  // the join would still be wrong.
  await sql`
    INSERT INTO account.account (account_id, email, email_verified)
    VALUES (${CAROL.account}, ${CAROL.email}, true)`;
}

beforeAll(async () => {
  identity = await createIdentityStore('tenantdirectory');
  control = await createControlPlane('tenantdirectory');
  sql = connectIdentity(identity, 4);
  controlSql = connectControl(control, 4);
}, 120_000);

afterAll(async () => {
  await sql?.close();
  await controlSql?.close();
  if (identity) await dropIdentityStore(identity);
  if (control) await dropControlPlane(control);
});

beforeEach(async () => {
  await reset();
});

// ---------------------------------------------------------------------------

describe('the directory answers what exists, and whose it is', () => {
  test('every tenant is a row, in a stable order, whether or not anybody owns it', async () => {
    await seedFleet();
    const { status, body } = await directory();

    expect(status).toBe(200);
    const tenants = body.content?.tenants ?? [];
    // Sorted by tenant id, which is the order a diff and a `grep` both want.
    // The canary is `zz-` precisely so this is not the seed order.
    expect(tenants.map((row) => row.tenant_id)).toEqual([
      ANNA.tenant,
      BRENDAN.tenant,
      CANARY_TENANT,
    ]);
    expect(body.content?.total).toBe(3);
  });

  test('the operational columns are the tenant’s own, not a default', async () => {
    await seedFleet();
    const { body } = await directory();
    const rows = new Map((body.content?.tenants ?? []).map((row) => [row.tenant_id, row]));

    expect(rows.get(ANNA.tenant)).toMatchObject({
      state: 'ready',
      tier: 'internal',
      last_activity: ACTIVE_AT.toISOString(),
    });
    // A half-provisioned tenant reads as one. The incident's brain was empty and
    // never used, so "this row looks unfinished" must not be read as "this row
    // is disposable" — which is exactly why the owner sits beside it.
    expect(rows.get(BRENDAN.tenant)).toMatchObject({
      state: 'provisioning',
      tier: 'free',
      last_activity: null,
    });
  });

  test('the canary has no owner, and says so rather than being dropped', async () => {
    await seedFleet();
    const { body } = await directory();
    const rows = new Map((body.content?.tenants ?? []).map((row) => [row.tenant_id, row]));

    expect(rows.get(CANARY_TENANT)?.owner).toBeNull();
    expect(rows.get(ANNA.tenant)?.owner).not.toBeNull();
    expect(rows.get(BRENDAN.tenant)?.owner).not.toBeNull();
  });

  test('an account with no brain is not a tenant, and does not become one', async () => {
    await seedFleet();
    const { body, text } = await directory();

    expect(body.content?.tenants).toHaveLength(3);
    for (const row of body.content?.tenants ?? []) {
      expect(typeof row.tenant_id).toBe('string');
      expect(row.tenant_id.length).toBeGreaterThan(0);
    }
    // Carol shares a mail domain with Brendan on purpose: an assertion that her
    // *domain* is absent would be wrong. Her digest is what identifies her, and
    // no row may carry it.
    const digests = (body.content?.tenants ?? []).map((row) => row.owner?.digest);
    expect(digests).not.toContain(expectedDigest(CAROL.email));
    expect(text).not.toContain('carol');
  });
});

describe('what an owner is allowed to be, on a surface with zero content scope', () => {
  test('a row is exactly these keys — an address is not one of them', async () => {
    await seedFleet();
    const { body } = await directory();

    // The length first, because a `for` over an empty list asserts nothing and
    // would keep this case green for a surface that answered no rows at all.
    expect(body.content?.tenants).toHaveLength(3);
    for (const row of body.content?.tenants ?? []) {
      expect(Object.keys(row).sort()).toEqual([
        'last_activity',
        'owner',
        'state',
        'tenant_id',
        'tier',
      ]);
    }
  });

  test('an owner is a domain and a digest, and has no third field to hide one in', async () => {
    await seedFleet();
    const { body } = await directory();
    const owned = (body.content?.tenants ?? []).filter((row) => row.owner !== null);

    expect(owned).toHaveLength(2);
    for (const row of owned) {
      expect(Object.keys(row.owner ?? {}).sort()).toEqual(['digest', 'domain']);
      expect(row.owner?.digest).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  test('the local part never leaves the identity database', async () => {
    await seedFleet();
    const { body, text } = await directory();
    const rows = new Map((body.content?.tenants ?? []).map((row) => [row.tenant_id, row]));

    // The domain is deliberately present — it is the half that says "a real
    // mailbox at a real provider" — and the local part is deliberately not.
    expect(rows.get(ANNA.tenant)?.owner?.domain).toBe('widget-co.example');
    expect(rows.get(BRENDAN.tenant)?.owner?.domain).toBe('mailhost.example');
    expect(text).not.toContain('anna.mailbox');
    expect(text).not.toContain('brendan@');
    expect(text).not.toContain(ANNA.email);
  });

  test('the digest is the one an operator holding the address computes', async () => {
    await seedFleet();
    const { body } = await directory();
    const rows = new Map((body.content?.tenants ?? []).map((row) => [row.tenant_id, row]));

    // This is the whole mechanism by which an operator answers "is this the one
    // I am about to delete?" without any address entering the request, the
    // response, the shell history or the ticket. If it drifts, the recipe in
    // `docs/deploy.md` silently starts producing false negatives — and a false
    // negative here reads as "nobody owns it".
    expect(rows.get(ANNA.tenant)?.owner?.digest).toBe(expectedDigest(ANNA.email));
    expect(rows.get(BRENDAN.tenant)?.owner?.digest).toBe(expectedDigest(BRENDAN.email));
  });
});

describe('the redaction itself, at the function that performs it', () => {
  test('splits at the last @, so a local part containing one cannot smuggle itself out', () => {
    // The column's alphabet permits exactly one `@`, so this is belt to the
    // schema's braces — but the belt is what holds if the alphabet ever widens.
    expect(redactOwnerEmail('odd@thing@mailhost.example').emailDomain).toBe('mailhost.example');
  });

  test('a value with no @ has no domain, rather than being its own domain', () => {
    // The tempting fallback — "no separator, so the whole thing is the domain" —
    // publishes the local part on precisely the input odd enough to reach it.
    const redacted = redactOwnerEmail('not-an-address-at-all');
    expect(redacted.emailDomain).toBe('');
    expect(redacted.emailDigest).not.toContain('not-an-address');
    expect(redacted.emailDigest).toMatch(/^[0-9a-f]+$/);
  });

  test('the digest is case-folded, so an operator’s typing does not decide the answer', () => {
    // A false negative here reads as "nobody owns it", which is the direction
    // that deletes a brain.
    expect(redactOwnerEmail('Anna.Mailbox@Widget-Co.Example').emailDigest).toBe(
      expectedDigest('anna.mailbox@widget-co.example'),
    );
  });

  test('and it is the advertised length', () => {
    expect(redactOwnerEmail(ANNA.email).emailDigest).toHaveLength(OWNER_DIGEST_CHARS);
  });
});

describe('what happens when the owner lookup cannot answer', () => {
  /**
   * **The failure that would recreate the incident.** An operator reads the
   * directory, every row says nobody owns it, and they delete on that. A
   * directory that cannot see owners must refuse — "I don't know" and "nobody"
   * are different answers and only one of them is safe to act on.
   */
  test('a directory that cannot see owners refuses, rather than reporting every brain unowned', async () => {
    await seedFleet();
    const result = await adminDispatch(
      {
        controlSql,
        owners: { owners: () => Promise.resolve({ ok: false as const }) },
      },
      { name: 'tenant_directory' },
    );

    expect(result).toMatchObject({ ok: false });
    // **And refused as this operation failing, not as a name nobody knows.**
    // Without this line the case is green on a surface that has never heard of
    // `tenant_directory` — the same lookup-miss-wearing-a-security-code trap
    // `admin-scope.test.ts` exists to distinguish, one operation over.
    expect(result).not.toMatchObject({ code: 'unknown_operation' });
    // And nothing leaked out through the refusal path either.
    expect(JSON.stringify(result)).not.toContain('tenant_id');
  });

  /**
   * **The failure arm of the real implementation, not of a stub.** Pointed at a
   * database with no `account` schema — which is what a deployment wired to the
   * wrong DSN looks like, and what an identity store mid-migration looks like —
   * the query throws. Answering `{ ok: true, owners: [] }` there would be the
   * incident with the operator's own tooling vouching for it.
   */
  test('the real directory over a database with no accounts in it refuses, rather than finding none', async () => {
    const misconfigured = createBrainOwnerDirectory(controlSql);
    const lookup = await misconfigured.owners();

    expect(lookup.ok).toBe(false);
    // And the refusal carries nothing from the driver's error, which is where a
    // DSN reaches a log.
    expect(Object.keys(lookup)).toEqual(['ok']);
  });

  test('the same directory over the store it is actually for does answer', async () => {
    // The positive control. Without it, the case above is equally consistent
    // with a directory that refuses everywhere.
    await seedFleet();
    const lookup = await createBrainOwnerDirectory(sql).owners();

    expect(lookup.ok).toBe(true);
    expect(lookup.ok && lookup.owners.map((owner) => owner.tenantId).sort()).toEqual([
      ANNA.tenant,
      BRENDAN.tenant,
    ]);
  });

  test('the same call with a working lookup answers, so the refusal is the lookup and not the operation', async () => {
    await seedFleet();
    const result = await adminDispatch(
      { controlSql, owners: { owners: () => Promise.resolve({ ok: true as const, owners: [] }) } },
      { name: 'tenant_directory' },
    );

    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error('unreachable');
    expect((result.content as { tenants: unknown[] }).tenants).toHaveLength(3);
  });
});

describe('it is a read, and it is bounded', () => {
  /**
   * **Deliberately NOT in `ADMIN_WRITE_OPERATIONS`.** That set exists because a
   * *link* can act: a grant reachable by GET is a grant a bookmark or a copied
   * URL issues. A read cannot act, so the method gate buys nothing here — and
   * the hazard a read does carry, the artifact it leaves in shell history and
   * tickets, is answered by the response shape above rather than by the verb.
   */
  test('a plain GET answers it', async () => {
    await seedFleet();
    const { status, body } = await directory();
    expect(status).toBe(200);
    expect(body.content?.tenants).toHaveLength(3);
  });

  test('a limit truncates and says that it did', async () => {
    await seedFleet();
    const { body } = await directory('&limit=1');

    expect(body.content?.tenants).toHaveLength(1);
    // The count is of the fleet, not of the page: "1 of 3" is the answer an
    // operator about to delete things needs, and "1" on its own is the answer
    // that tells them the fleet is smaller than it is.
    expect(body.content?.total).toBe(3);
    expect(body.content?.truncated).toBe(true);
  });

  test('an unbounded ask is bounded anyway, and an untruncated page says so', async () => {
    await seedFleet();
    const { body } = await directory('&limit=999999');
    expect(body.content?.tenants).toHaveLength(3);
    expect(body.content?.truncated).toBe(false);
  });

  /**
   * **The cap, asserted where it can be.** A fleet large enough to hit 500 is
   * not a fixture anybody wants in the blocking tier, so the query-level case
   * above can only show that a silly number is *accepted* — never that it is
   * clamped. This is the assertion that the clamp exists at all.
   */
  test('the cap is a cap, not a suggestion', () => {
    expect(resolveDirectoryLimit(999999)).toBe(TENANT_DIRECTORY_LIMIT);
    expect(resolveDirectoryLimit('999999')).toBe(TENANT_DIRECTORY_LIMIT);
    expect(resolveDirectoryLimit(TENANT_DIRECTORY_LIMIT + 1)).toBe(TENANT_DIRECTORY_LIMIT);
  });

  test('and a nonsense limit is the full page rather than a refusal or one row', () => {
    // Absent, blank and unparseable all mean "the operator did not ask", and the
    // answer to that is the biggest list this surface gives. `Number('')` is 0,
    // so a bare `&limit=` would otherwise answer one row — a fleet of 47 reading
    // as a fleet of 1 is the failure this case exists for.
    expect(resolveDirectoryLimit(undefined)).toBe(TENANT_DIRECTORY_LIMIT);
    expect(resolveDirectoryLimit('')).toBe(TENANT_DIRECTORY_LIMIT);
    expect(resolveDirectoryLimit('not-a-number')).toBe(TENANT_DIRECTORY_LIMIT);
    // And a real ask is honoured, or the three above would be satisfied by a
    // function that ignored its argument.
    expect(resolveDirectoryLimit('2')).toBe(2);
    expect(resolveDirectoryLimit(0)).toBe(1);
    expect(resolveDirectoryLimit(-5)).toBe(1);
  });
});

describe('who cannot read it', () => {
  test('an unauthenticated caller gets nothing', async () => {
    await seedFleet();
    const response = await app()(get('/admin?op=tenant_directory'));
    const text = await response.text();

    expect(response.status).toBe(401);
    expect(text).not.toContain(ANNA.tenant);
    expect(text).not.toContain('widget-co.example');
  });

  test('an ordinary signed-in user gets nothing either', async () => {
    await seedFleet();
    // A real session on the app's own origin. `/admin` authenticates on the
    // operator credential and on nothing else, so a cookie buys no part of it.
    const created = await app()(
      new Request(`${ORIGIN}/api/signup`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'ordinary.user@mailhost.example',
          password: 'correct horse battery staple',
          fts_language: 'simple',
        }),
      }),
    );
    const cookie = (created.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toContain('=');

    const response = await app()(get('/admin?op=tenant_directory', { cookie }));
    const text = await response.text();

    expect(response.status).toBe(401);
    expect(text).not.toContain(ANNA.tenant);
    expect(text).not.toContain('widget-co.example');
  });

  test('a deployment with no operator credential has no directory at all', async () => {
    await seedFleet();
    const response = await app({ adminCredential: '' })(
      get('/admin?op=tenant_directory', { authorization: 'Bearer anything' }),
    );
    const text = await response.text();

    // 404 rather than 401, the way the rest of `/admin` fails closed.
    expect(response.status).toBe(404);
    expect(text).not.toContain(ANNA.tenant);
  });
});
