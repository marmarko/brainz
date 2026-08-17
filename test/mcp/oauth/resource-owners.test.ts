/**
 * The production `ResourceOwners`, against a real identity database.
 *
 * **Why this file exists separately from `consent.test.ts`.** Every test of the
 * browser leg drives a *fake* session store — which is right, because what those
 * tests are about is the consent mechanics and a database there would only make
 * them slow. But it leaves the implementation the deployed process would
 * actually use — cookie → session → brain → session key — asserted by nothing,
 * and "the port is fine, only the wiring is missing" is a claim somebody would
 * then be making about untested code.
 *
 * The four properties, each written as what breaks without it:
 *
 *   * the cookie is read by NAME, not by taking the whole header — a session
 *     store that matched a substring would authenticate anyone who could get a
 *     string into any cookie on this origin;
 *   * an account with no brain resolves to `tenantId: null` rather than
 *     failing, because `/authorize` owes that state a page and cannot render one
 *     for a `null` it never receives;
 *   * a session the identity store refuses resolves to `null`, so the expiry
 *     policy is the store's one policy and not a second one written here;
 *   * `sessionKey` is not the session token. It travels into an HMAC that ends
 *     up in a rendered page, and a page carrying the session credential is the
 *     credential leak this whole flow exists to avoid.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import {
  ABSOLUTE_SESSION_MS,
  attachBrain,
  createSession,
  signUpWithPassword,
} from '../../../src/control/accounts.ts';
import { sessionResourceOwners } from '../../../src/mcp/serve.ts';
import {
  connect,
  createIdentityStore,
  dropIdentityStore,
  TEST_HASH_COST,
  type IdentityFixture,
} from '../../control/identity-fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;
/**
 * Real wall-clock time, deliberately, and the one place in this repo where that
 * is right. `sessionResourceOwners` reads `new Date()` because the deployed
 * process has no injected clock to read — so a fixture pinned to a written-down
 * date would pass on the day it was written and start failing when the idle
 * window rolled past it, which is a test that expires rather than a test that
 * fails. What must not drift is the *distance* between the timestamps, and that
 * is what these two express.
 */
const AT = new Date();
const LONG_EXPIRED = new Date(AT.getTime() - ABSOLUTE_SESSION_MS - 365 * 24 * 60 * 60 * 1000);
const TENANT = 'owner-fixture-tenant';

let identity: IdentityFixture;
let sql: SQL;

beforeAll(async () => {
  identity = await createIdentityStore('mcp_resource_owners');
  sql = connect(identity);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await sql?.close();
  if (identity !== undefined) await dropIdentityStore(identity);
});

async function account(email: string): Promise<{ accountId: string; token: string }> {
  const created = await signUpWithPassword(sql, {
    email,
    password: 'correct horse battery staple',
    now: AT,
    hash: TEST_HASH_COST,
  });
  if (!created.ok) throw new Error(`fixture signup failed: ${created.reason}`);
  const session = await createSession(sql, { accountId: created.accountId, now: AT });
  return { accountId: created.accountId, token: session.token };
}

describe('the session port the deployed process would use', () => {
  test('resolves a cookie to the account and its brain', async () => {
    const { accountId, token } = await account('with-brain@example.com');
    await attachBrain(sql, { accountId, tenantId: TENANT, ftsLanguage: 'simple', now: AT });

    const owner = await sessionResourceOwners(sql).resolve(
      // A realistic header: ours is not the only cookie on the origin, and not
      // the first one either.
      `other=1; bz_session=${token}; theme=dark`,
    );
    expect(owner?.accountId).toBe(accountId);
    expect(owner?.tenantId).toBe(TENANT);
  });

  test('resolves an account with no brain to a null tenant, not to a refusal', async () => {
    const { accountId, token } = await account('no-brain@example.com');
    const owner = await sessionResourceOwners(sql).resolve(`bz_session=${token}`);
    expect(owner?.accountId).toBe(accountId);
    // The state `/authorize` owes a page rather than a 500. A port that returned
    // `null` here would send the user to sign in again, from a session that is
    // already signed in — the loop.
    expect(owner?.tenantId).toBeNull();
  });

  test('the session key is not the session token', async () => {
    const { token } = await account('key-shape@example.com');
    const owner = await sessionResourceOwners(sql).resolve(`bz_session=${token}`);
    expect(owner?.sessionKey).toBeDefined();
    expect(owner?.sessionKey).not.toBe(token);
    expect(owner?.sessionKey).not.toContain(token);
    // Stable across calls, or the consent token on the page would not verify
    // against the one computed when the form comes back.
    const again = await sessionResourceOwners(sql).resolve(`bz_session=${token}`);
    expect(again?.sessionKey).toBe(owner?.sessionKey ?? '');
  });

  test.each([
    ['no cookie header at all', null],
    ['a header with no session cookie', 'theme=dark; other=1'],
    ['a token that was never issued', 'bz_session=bzs_this-was-never-issued'],
    ['our value under somebody else’s cookie name', 'not_bz_session=PLACEHOLDER'],
    // The substring attack: the real token is present, but not as this cookie.
    ['our token as another cookie’s value', 'decoy=PLACEHOLDER'],
  ])('refuses %s', async (_name, header) => {
    const { token } = await account(`refused-${Math.random().toString(36).slice(2)}@example.com`);
    const owner = await sessionResourceOwners(sql).resolve(
      header === null ? null : header.replace('PLACEHOLDER', token),
    );
    expect(owner).toBeNull();
  });

  test('an expired session is the identity store’s decision, and it is refused', async () => {
    const { accountId } = await account('expired@example.com');
    const stale = await createSession(sql, { accountId, now: LONG_EXPIRED });
    const owner = await sessionResourceOwners(sql).resolve(`bz_session=${stale.token}`);
    expect(owner).toBeNull();
  });
});
