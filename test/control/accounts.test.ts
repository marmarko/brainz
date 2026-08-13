/**
 * Identity, sessions, password reset — and the OAuth linking rule the whole
 * unit exists to get right.
 *
 * **The attack this file is built around** (re-plan §4.1): an attacker signs up
 * with the *victim's* email address and a password of their own. They never
 * verify it — they cannot, they do not hold the mailbox. Later the victim
 * arrives and clicks "Sign in with Google". A system that links provider
 * identities by email equality now signs the victim into the attacker's account:
 * the victim connects their real Gmail, the brain fills with their mail, and the
 * attacker logs in with the password they set.
 *
 * So the test that matters here is the **colliding-email** one. A linking suite
 * that only exercises a fresh address passes while the attack is live, in
 * exactly the way `test/control/storage.test.ts` records for the `alice`/`bob`
 * prefix case: the two names share no substring, so the guard never touches the
 * hazard.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import {
  IDLE_SESSION_MS,
  ABSOLUTE_SESSION_MS,
  MIN_PASSWORD_LENGTH,
  RESET_TOKEN_TTL_MS,
  beginPasswordReset,
  completePasswordReset,
  createSession,
  linkIdentity,
  logIn,
  normalizeEmail,
  resolveIdentity,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  signUpWithPassword,
  verifyEmail,
} from '../../src/control/accounts.ts';
import {
  connect,
  createIdentityStore,
  dropIdentityStore,
  TEST_HASH_COST,
  type IdentityFixture,
} from './identity-fixture.ts';

let fixture: IdentityFixture;
let sql: SQL;

const AT = new Date('2026-08-13T09:00:00.000Z');

beforeAll(async () => {
  fixture = await createIdentityStore('accounts');
  sql = connect(fixture);
}, 60_000);

afterAll(async () => {
  await sql?.close();
  if (fixture) await dropIdentityStore(fixture);
});

/** Every test gets a clean slate; the account cascade takes the rest with it. */
async function reset(): Promise<void> {
  await sql`DELETE FROM account.account`;
}

const HASH = { hash: TEST_HASH_COST };

// ---------------------------------------------------------------------------

describe('email normalisation is the database alphabet, not a second opinion', () => {
  test('addresses are lowercased and trimmed', () => {
    expect(normalizeEmail('  Alice.Example@Example.COM ')).toBe('alice.example@example.com');
  });

  test('an address the column cannot hold is refused rather than mangled', () => {
    // The limitation is real and stated in the schema header: a login identifier
    // that has been silently rewritten no longer reaches its owner, which is a
    // worse failure than a refusal at signup.
    for (const bad of ['not-an-address', 'a@b', 'a b@example.com', 'a@@example.com', '']) {
      expect(normalizeEmail(bad)).toBeNull();
    }
  });

  test('a connection string is not an email address', () => {
    expect(normalizeEmail('postgres://tenant:redacted@db.example.invalid/brainz')).toBeNull();
  });
});

describe('signup and login', () => {
  test('a new account can sign in with its password', async () => {
    await reset();
    const created = await signUpWithPassword(sql, {
      email: 'alice@example.com',
      password: 'correct horse battery staple',
      now: AT,
      ...HASH,
    });
    expect(created.ok).toBe(true);

    const signedIn = await logIn(sql, {
      email: 'ALICE@example.com',
      password: 'correct horse battery staple',
      now: AT,
    });
    expect(signedIn).toEqual({ ok: true, accountId: created.ok ? created.accountId : '' });
  });

  test('a new account starts unverified — nothing has proved mailbox control', async () => {
    await reset();
    const created = await signUpWithPassword(sql, {
      email: 'alice@example.com',
      password: 'correct horse battery staple',
      now: AT,
      ...HASH,
    });
    const rows = await sql<{ email_verified: boolean }[]>`
      SELECT email_verified FROM account.account WHERE account_id = ${created.ok ? created.accountId : ''}`;
    expect(rows[0]?.email_verified).toBe(false);
  });

  test('a short password is refused before anything is written', async () => {
    await reset();
    const created = await signUpWithPassword(sql, {
      email: 'alice@example.com',
      password: 'a'.repeat(MIN_PASSWORD_LENGTH - 1),
      now: AT,
      ...HASH,
    });
    expect(created).toEqual({ ok: false, reason: 'weak_password' });
    expect(await sql`SELECT 1 FROM account.account`).toHaveLength(0);
  });

  test('a wrong password and an unknown address are the same refusal', async () => {
    await reset();
    await signUpWithPassword(sql, {
      email: 'alice@example.com',
      password: 'correct horse battery staple',
      now: AT,
      ...HASH,
    });

    const wrongPassword = await logIn(sql, {
      email: 'alice@example.com',
      password: 'incorrect horse battery staple',
      now: AT,
    });
    const noSuchAccount = await logIn(sql, {
      email: 'nobody@example.com',
      password: 'correct horse battery staple',
      now: AT,
    });

    expect(wrongPassword).toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(noSuchAccount).toEqual(wrongPassword);
  });

  test('an account created through a provider has no password to guess', async () => {
    await reset();
    const outcome = await resolveIdentity(sql, {
      provider: 'google',
      subject: 'sub-alice',
      email: 'alice@example.com',
      emailVerified: true,
      now: AT,
    });
    expect(outcome.kind).toBe('created');

    // No password credential row at all — not an empty string, not a sentinel.
    expect(await sql`SELECT 1 FROM account.password_credential`).toHaveLength(0);
    const attempted = await logIn(sql, {
      email: 'alice@example.com',
      password: '',
      now: AT,
    });
    expect(attempted).toEqual({ ok: false, reason: 'invalid_credentials' });
  });
});

describe('sessions', () => {
  async function anAccount(): Promise<string> {
    const created = await signUpWithPassword(sql, {
      email: 'alice@example.com',
      password: 'correct horse battery staple',
      now: AT,
      ...HASH,
    });
    if (!created.ok) throw new Error('fixture account was not created');
    return created.accountId;
  }

  test('the store holds a digest, never a usable token', async () => {
    await reset();
    const accountId = await anAccount();
    const session = await createSession(sql, { accountId, now: AT });

    const rows = await sql<{ token_digest: string }[]>`SELECT token_digest FROM account.session`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_digest).not.toBe(session.token);
    expect(rows[0]?.token_digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test('a live session resolves to its account and stamps last seen', async () => {
    await reset();
    const accountId = await anAccount();
    const session = await createSession(sql, { accountId, now: AT });

    const later = new Date(AT.getTime() + 60_000);
    expect(await resolveSession(sql, { token: session.token, now: later })).toEqual({
      ok: true,
      accountId,
    });

    const rows = await sql<{ last_seen_at: Date }[]>`SELECT last_seen_at FROM account.session`;
    expect(rows[0]?.last_seen_at.getTime()).toBe(later.getTime());
  });

  test('an idle session expires even though its absolute deadline has not passed', async () => {
    await reset();
    const accountId = await anAccount();
    const session = await createSession(sql, { accountId, now: AT });

    const idle = new Date(AT.getTime() + IDLE_SESSION_MS + 1_000);
    expect(idle.getTime()).toBeLessThan(AT.getTime() + ABSOLUTE_SESSION_MS);
    expect(await resolveSession(sql, { token: session.token, now: idle })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  test('a session kept warm still dies at its absolute deadline', async () => {
    await reset();
    const accountId = await anAccount();
    const session = await createSession(sql, { accountId, now: AT });

    // Touched every day, so the idle window never lapses. The absolute bound is
    // the only thing that ends this session, which is the whole reason it exists.
    let at = AT.getTime();
    while (at < AT.getTime() + ABSOLUTE_SESSION_MS - 86_400_000) {
      at += 86_400_000;
      expect((await resolveSession(sql, { token: session.token, now: new Date(at) })).ok).toBe(true);
    }

    const past = new Date(AT.getTime() + ABSOLUTE_SESSION_MS + 1_000);
    expect(await resolveSession(sql, { token: session.token, now: past })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  test('an unknown token is refused without saying whether it ever existed', async () => {
    await reset();
    expect(await resolveSession(sql, { token: 'bzs_nothing', now: AT })).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  test('revoking one session leaves the others', async () => {
    await reset();
    const accountId = await anAccount();
    const first = await createSession(sql, { accountId, now: AT });
    const second = await createSession(sql, { accountId, now: AT });

    await revokeSession(sql, first.token);
    expect((await resolveSession(sql, { token: first.token, now: AT })).ok).toBe(false);
    expect((await resolveSession(sql, { token: second.token, now: AT })).ok).toBe(true);
  });

  test('revoking all of them leaves none', async () => {
    await reset();
    const accountId = await anAccount();
    const first = await createSession(sql, { accountId, now: AT });
    const second = await createSession(sql, { accountId, now: AT });

    await revokeAllSessions(sql, accountId);
    expect((await resolveSession(sql, { token: first.token, now: AT })).ok).toBe(false);
    expect((await resolveSession(sql, { token: second.token, now: AT })).ok).toBe(false);
  });
});

describe('password reset', () => {
  async function anAccount(email = 'alice@example.com'): Promise<string> {
    const created = await signUpWithPassword(sql, {
      email,
      password: 'correct horse battery staple',
      now: AT,
      ...HASH,
    });
    if (!created.ok) throw new Error('fixture account was not created');
    return created.accountId;
  }

  test('a reset for an unknown address is indistinguishable from one for a real account', async () => {
    await reset();
    await anAccount();

    const real = await beginPasswordReset(sql, { email: 'alice@example.com', now: AT });
    const unknown = await beginPasswordReset(sql, { email: 'nobody@example.com', now: AT });

    // The caller sends mail only when a token came back; the *response* it hands
    // the browser is identical either way, which is the property that matters.
    expect(real.ok).toBe(true);
    expect(unknown.ok).toBe(true);
    expect(typeof real.token).toBe('string');
    expect(unknown.token).toBeNull();
  });

  test('a reset replaces the password, and the old one stops working', async () => {
    await reset();
    await anAccount();
    const begun = await beginPasswordReset(sql, { email: 'alice@example.com', now: AT });

    const done = await completePasswordReset(sql, {
      token: begun.token ?? '',
      password: 'a different long enough password',
      now: AT,
      ...HASH,
    });
    expect(done.ok).toBe(true);

    expect(
      await logIn(sql, { email: 'alice@example.com', password: 'correct horse battery staple', now: AT }),
    ).toEqual({ ok: false, reason: 'invalid_credentials' });
    expect(
      (await logIn(sql, { email: 'alice@example.com', password: 'a different long enough password', now: AT }))
        .ok,
    ).toBe(true);
  });

  test('a reset token is single use', async () => {
    await reset();
    await anAccount();
    const begun = await beginPasswordReset(sql, { email: 'alice@example.com', now: AT });

    const first = await completePasswordReset(sql, {
      token: begun.token ?? '',
      password: 'a different long enough password',
      now: AT,
      ...HASH,
    });
    const second = await completePasswordReset(sql, {
      token: begun.token ?? '',
      password: 'a third long enough password here',
      now: AT,
      ...HASH,
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: 'invalid_token' });
  });

  test('a reset token expires', async () => {
    await reset();
    await anAccount();
    const begun = await beginPasswordReset(sql, { email: 'alice@example.com', now: AT });

    const late = new Date(AT.getTime() + RESET_TOKEN_TTL_MS + 1_000);
    expect(
      await completePasswordReset(sql, {
        token: begun.token ?? '',
        password: 'a different long enough password',
        now: late,
        ...HASH,
      }),
    ).toEqual({ ok: false, reason: 'invalid_token' });
  });

  test('a reset ends every session the account had', async () => {
    await reset();
    const accountId = await anAccount();
    const session = await createSession(sql, { accountId, now: AT });
    const begun = await beginPasswordReset(sql, { email: 'alice@example.com', now: AT });

    await completePasswordReset(sql, {
      token: begun.token ?? '',
      password: 'a different long enough password',
      now: AT,
      ...HASH,
    });

    // "I changed my password so I am safe now" is the belief this makes true.
    expect((await resolveSession(sql, { token: session.token, now: AT })).ok).toBe(false);
  });

  test('a completed reset does not promote the address to verified', async () => {
    // Deliberate, and argued in the re-plan: the attacker of §4.1 holds the
    // account and not the mailbox, so a design where finishing a reset confers
    // verification is one where their half-account gains status from a flow they
    // can never complete. Verification stays its own flow.
    await reset();
    const accountId = await anAccount();
    const begun = await beginPasswordReset(sql, { email: 'alice@example.com', now: AT });
    await completePasswordReset(sql, {
      token: begun.token ?? '',
      password: 'a different long enough password',
      now: AT,
      ...HASH,
    });

    const rows = await sql<{ email_verified: boolean }[]>`
      SELECT email_verified FROM account.account WHERE account_id = ${accountId}`;
    expect(rows[0]?.email_verified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The one that matters.
// ---------------------------------------------------------------------------

describe('OAuth linking, tested against a colliding email', () => {
  async function attackerHoldsTheAddress(): Promise<string> {
    const created = await signUpWithPassword(sql, {
      email: 'victim@example.com',
      password: 'the attackers own password',
      now: AT,
      ...HASH,
    });
    if (!created.ok) throw new Error('fixture account was not created');
    return created.accountId;
  }

  test('a verified provider identity does NOT enter an existing account by email', async () => {
    await reset();
    const attackerAccount = await attackerHoldsTheAddress();

    const outcome = await resolveIdentity(sql, {
      provider: 'google',
      subject: 'google-subject-for-the-real-victim',
      email: 'victim@example.com',
      emailVerified: true,
      now: AT,
    });

    // Not `signed_in`, and specifically not signed in as the attacker.
    expect(outcome).toEqual({ kind: 'link_required', reason: 'email_in_use' });
    expect(outcome).not.toMatchObject({ kind: 'signed_in' });

    // Nothing was attached, and the attacker's account is untouched.
    expect(await sql`SELECT 1 FROM account.identity`).toHaveLength(0);
    const rows = await sql<{ account_id: string; email_verified: boolean }[]>`
      SELECT account_id, email_verified FROM account.account`;
    expect(rows).toEqual([{ account_id: attackerAccount, email_verified: false }]);
  });

  test('the collision holds even when the existing account IS verified', async () => {
    // The mirror case: a real, verified user, and a provider identity nobody has
    // proved belongs to them. Auto-linking here would be an account takeover in
    // the other direction.
    await reset();
    await attackerHoldsTheAddress();
    await sql`UPDATE account.account SET email_verified = true`;

    expect(
      await resolveIdentity(sql, {
        provider: 'google',
        subject: 'some-other-subject',
        email: 'victim@example.com',
        emailVerified: true,
        now: AT,
      }),
    ).toEqual({ kind: 'link_required', reason: 'email_in_use' });
  });

  test('a fresh address creates its own account, and a second sign-in returns to it', async () => {
    await reset();
    const created = await resolveIdentity(sql, {
      provider: 'google',
      subject: 'sub-alice',
      email: 'alice@example.com',
      emailVerified: true,
      now: AT,
    });
    expect(created.kind).toBe('created');

    const again = await resolveIdentity(sql, {
      provider: 'google',
      subject: 'sub-alice',
      email: 'alice@example.com',
      emailVerified: true,
      now: AT,
    });
    expect(again).toEqual({
      kind: 'signed_in',
      accountId: created.kind === 'created' ? created.accountId : '',
    });
  });

  test('the link key is the subject, so a provider-side email change does not move it', async () => {
    await reset();
    const created = await resolveIdentity(sql, {
      provider: 'google',
      subject: 'sub-alice',
      email: 'alice@example.com',
      emailVerified: true,
      now: AT,
    });

    const renamed = await resolveIdentity(sql, {
      provider: 'google',
      subject: 'sub-alice',
      email: 'alice.new@example.com',
      emailVerified: true,
      now: AT,
    });
    expect(renamed).toEqual({
      kind: 'signed_in',
      accountId: created.kind === 'created' ? created.accountId : '',
    });
  });

  test('the same subject at a different provider is a different identity', async () => {
    await reset();
    const google = await resolveIdentity(sql, {
      provider: 'google',
      subject: 'shared-subject-string',
      email: 'alice@example.com',
      emailVerified: true,
      now: AT,
    });
    expect(google.kind).toBe('created');

    const microsoft = await resolveIdentity(sql, {
      provider: 'microsoft',
      subject: 'shared-subject-string',
      email: 'alice@example.com',
      emailVerified: true,
      now: AT,
    });
    expect(microsoft).toEqual({ kind: 'link_required', reason: 'email_in_use' });
  });

  test('an unverified provider email creates an account that cannot absorb another', async () => {
    await reset();
    const created = await resolveIdentity(sql, {
      provider: 'google',
      subject: 'sub-alice',
      email: 'alice@example.com',
      emailVerified: false,
      now: AT,
    });
    expect(created.kind).toBe('created');

    const rows = await sql<{ email_verified: boolean }[]>`SELECT email_verified FROM account.account`;
    expect(rows[0]?.email_verified).toBe(false);
  });
});

describe('linking after the user has authenticated into the account', () => {
  async function anAuthenticatedAccount(): Promise<string> {
    const created = await signUpWithPassword(sql, {
      email: 'victim@example.com',
      password: 'the real users password',
      now: AT,
      ...HASH,
    });
    if (!created.ok) throw new Error('fixture account was not created');
    return created.accountId;
  }

  test('an authenticated account may attach a verified provider identity', async () => {
    await reset();
    const accountId = await anAuthenticatedAccount();

    expect(
      await linkIdentity(sql, {
        accountId,
        provider: 'google',
        subject: 'sub-victim',
        emailVerified: true,
        now: AT,
      }),
    ).toEqual({ ok: true });

    expect(
      await resolveIdentity(sql, {
        provider: 'google',
        subject: 'sub-victim',
        email: 'victim@example.com',
        emailVerified: true,
        now: AT,
      }),
    ).toEqual({ kind: 'signed_in', accountId });
  });

  test('an unverified provider identity may not be attached even by the account owner', async () => {
    await reset();
    const accountId = await anAuthenticatedAccount();

    expect(
      await linkIdentity(sql, {
        accountId,
        provider: 'google',
        subject: 'sub-victim',
        emailVerified: false,
        now: AT,
      }),
    ).toEqual({ ok: false, reason: 'provider_email_unverified' });
    expect(await sql`SELECT 1 FROM account.identity`).toHaveLength(0);
  });

  test('an identity already attached to somebody else is not stolen', async () => {
    await reset();
    const owner = await anAuthenticatedAccount();
    await linkIdentity(sql, {
      accountId: owner,
      provider: 'google',
      subject: 'sub-victim',
      emailVerified: true,
      now: AT,
    });

    const other = await signUpWithPassword(sql, {
      email: 'somebody@example.com',
      password: 'another long enough password',
      now: AT,
      ...HASH,
    });
    expect(
      await linkIdentity(sql, {
        accountId: other.ok ? other.accountId : '',
        provider: 'google',
        subject: 'sub-victim',
        emailVerified: true,
        now: AT,
      }),
    ).toEqual({ ok: false, reason: 'identity_in_use' });

    const rows = await sql<{ account_id: string }[]>`SELECT account_id FROM account.identity`;
    expect(rows).toEqual([{ account_id: owner }]);
  });
});

describe('email verification', () => {
  test('a verification token proves mailbox control once', async () => {
    await reset();
    const created = await signUpWithPassword(sql, {
      email: 'alice@example.com',
      password: 'correct horse battery staple',
      now: AT,
      ...HASH,
    });
    const accountId = created.ok ? created.accountId : '';

    const begun = await beginPasswordReset(sql, { email: 'alice@example.com', now: AT });
    // A reset token is NOT a verification token: different purpose, and the
    // verifier must refuse one presented in the other's place.
    expect(await verifyEmail(sql, { token: begun.token ?? '', now: AT })).toEqual({
      ok: false,
      reason: 'invalid_token',
    });

    const rows = await sql<{ email_verified: boolean }[]>`
      SELECT email_verified FROM account.account WHERE account_id = ${accountId}`;
    expect(rows[0]?.email_verified).toBe(false);
  });
});
