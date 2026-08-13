/**
 * Identity for the web app (U15): accounts, sessions, password reset, and the
 * OAuth linking rule.
 *
 * It speaks to the **identity database** (`src/control/account-schema.sql`),
 * which is a different database from the content-free control plane. Nothing
 * here reads a tenant's connection string or bearer: `secrets.ts` gives the
 * web-app identity no resolve permission on any tenant namespace (R11), and
 * this module never asks.
 *
 * **The linking rule is the security content of this file**, so it is stated
 * before the code rather than discovered inside it.
 *
 * The attack: an attacker signs up with the *victim's* email address and a
 * password of their own. They never verify it — they hold the account, not the
 * mailbox. Later the victim clicks "Sign in with Google", and a system that
 * links provider identities *by email equality* signs them into the attacker's
 * account. The victim then connects their real Gmail and the brain fills with
 * their mail, under a password the attacker chose.
 *
 * The rules that refuse it:
 *
 *  1. **The link key is `(provider, subject)`, never the email.** A `sub` is
 *     stable; an email is an attribute the provider may change under us. The
 *     `account.identity` table has no email column at all, so no code path can
 *     read one from it by accident.
 *  2. **Email equality never auto-links.** A known-provider identity signs in. An
 *     unknown one whose email already belongs to an account produces
 *     `link_required` — full stop, in both directions, verified or not. The user
 *     must authenticate into the existing account before an identity is attached.
 *  3. **`email_verified` is required to attach.** Even after the user has proved
 *     they hold the account, a provider that does not assert it cannot attach an
 *     identity. A provider's assertion does not substitute for our verification
 *     and ours does not substitute for theirs.
 *  4. **A fresh signup through a provider inherits the provider's verification**
 *     and nothing more. An account created by an unverified identity starts
 *     unverified, so it can never later absorb a colliding one.
 *
 * **Two refusals are deliberately uniform, and one is deliberately not.** Login
 * says `invalid_credentials` whether the address is unknown or the password is
 * wrong, and runs a hash verification either way so the two do not differ in
 * time. Password reset answers identically whether or not the address exists —
 * that oracle is the dangerous one, because it is reachable without the account
 * holder doing anything. Signup does report that an address is taken: a uniform
 * signup makes the product unusable for the person who simply forgot they had an
 * account, and it does not close the enumeration channel anyway, since the
 * attacker learns the same thing from the reset flow's absence of mail.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { SQL } from 'bun';

/**
 * The same alphabet `account.email` declares, restated here so signup refuses an
 * unsupported address with a typed error rather than letting the database raise
 * a constraint violation. Two declarations of one rule is a drift risk, and
 * `test/control/account-schema.test.ts` pins them together.
 */
export const EMAIL_PATTERN =
  /^[a-z0-9][a-z0-9._%+-]{0,62}@[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62}){1,4}$/;

/**
 * Twelve. A length floor rather than a composition rule, because composition
 * rules produce `Passw0rd!` and a floor produces a passphrase. Argon2id is what
 * carries the rest.
 */
export const MIN_PASSWORD_LENGTH = 12;

/** Bounded so a megabyte of "password" cannot be turned into a memory-hard DoS. */
export const MAX_PASSWORD_LENGTH = 256;

/** Seven days without being seen. Ends the abandoned session. */
export const IDLE_SESSION_MS = 7 * 24 * 60 * 60 * 1_000;

/** Thirty days from issue, however busy. Ends the stolen one. */
export const ABSOLUTE_SESSION_MS = 30 * 24 * 60 * 60 * 1_000;

/** Long enough to read the mail, short enough that a leaked one is usually dead. */
export const RESET_TOKEN_TTL_MS = 30 * 60 * 1_000;

/** A day: verification is not urgent and the mail may sit in a queue. */
export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1_000;

export const SESSION_TOKEN_PREFIX = 'bzs_';
export const RESET_TOKEN_PREFIX = 'bzp_';
export const VERIFY_TOKEN_PREFIX = 'bzv_';

export type IdentityProvider = 'google' | 'microsoft';

/**
 * Argon2id parameters. Absent means Bun's defaults, which is what production
 * uses; tests pass something cheap so a suite making dozens of hashes does not
 * spend a minute on key derivation. The parameters travel *inside* the stored
 * hash, so a later bump re-hashes on next successful login rather than forcing a
 * fleet-wide reset.
 */
export interface HashCost {
  readonly memoryCost?: number;
  readonly timeCost?: number;
}

function hashOptions(cost: HashCost | undefined): Parameters<typeof Bun.password.hash>[1] {
  return {
    algorithm: 'argon2id',
    ...(cost?.memoryCost === undefined ? {} : { memoryCost: cost.memoryCost }),
    ...(cost?.timeCost === undefined ? {} : { timeCost: cost.timeCost }),
  };
}

/**
 * A hash of a password nobody has. Login verifies against this when the address
 * is unknown, so "no such account" and "wrong password" cost the same work — the
 * refusal is already uniform in wording, and this makes it uniform in time.
 *
 * Computed once, lazily, at the caller's cost parameters.
 */
const DECOY_HASHES = new Map<string, Promise<string>>();

function decoyHash(cost: HashCost | undefined): Promise<string> {
  const key = `${cost?.memoryCost ?? 0}:${cost?.timeCost ?? 0}`;
  const existing = DECOY_HASHES.get(key);
  if (existing !== undefined) return existing;
  const created = Bun.password.hash('the password of an account that does not exist', hashOptions(cost));
  DECOY_HASHES.set(key, created);
  return created;
}

// ---------------------------------------------------------------------------
// Identifiers and tokens.
// ---------------------------------------------------------------------------

function randomSlug(bytes = 16): string {
  return Buffer.from(randomBytes(bytes)).toString('hex');
}

/** Matches `account.account_id`'s alphabet. Never derived from the email. */
export function newAccountId(): string {
  return `a-${randomSlug()}`;
}

function newToken(prefix: string): string {
  return `${prefix}${Buffer.from(randomBytes(32)).toString('base64url')}`;
}

/** The store holds this and never the token, exactly as `oauth.ts` does. */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Lowercase, trim, and refuse anything the column cannot hold.
 *
 * **Deliberately not "canonicalising"**: no dot-stripping, no `+tag` removal, no
 * provider-specific folding. Treating `a.b@gmail.com` and `ab@gmail.com` as one
 * address is a decision about somebody else's mail routing, and getting it wrong
 * in the permissive direction merges two people's accounts.
 */
export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 254) return null;
  return EMAIL_PATTERN.test(trimmed) ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Signup and login.
// ---------------------------------------------------------------------------

export type SignupRefusal = 'email_unsupported' | 'weak_password' | 'email_taken';

export type SignupOutcome =
  | { readonly ok: true; readonly accountId: string }
  | { readonly ok: false; readonly reason: SignupRefusal };

export async function signUpWithPassword(
  sql: SQL,
  request: {
    readonly email: string;
    readonly password: string;
    readonly now: Date;
    readonly hash?: HashCost;
  },
): Promise<SignupOutcome> {
  const email = normalizeEmail(request.email);
  if (email === null) return { ok: false, reason: 'email_unsupported' };
  if (
    request.password.length < MIN_PASSWORD_LENGTH ||
    request.password.length > MAX_PASSWORD_LENGTH
  ) {
    return { ok: false, reason: 'weak_password' };
  }

  const accountId = newAccountId();
  const inserted = await sql<{ account_id: string }[]>`
    INSERT INTO account.account (account_id, email, email_verified, created_at, updated_at)
    VALUES (${accountId}, ${email}, false, ${request.now}, ${request.now})
    ON CONFLICT (email) DO NOTHING
    RETURNING account_id`;
  if (inserted.length === 0) return { ok: false, reason: 'email_taken' };

  // Hashed after the row is claimed, so a burst of signups on one taken address
  // does not buy an attacker one memory-hard hash each.
  const digest = await Bun.password.hash(request.password, hashOptions(request.hash));
  await sql`
    INSERT INTO account.password_credential (account_id, password_hash, updated_at)
    VALUES (${accountId}, ${digest}, ${request.now})`;

  return { ok: true, accountId };
}

export type LoginOutcome =
  | { readonly ok: true; readonly accountId: string }
  | { readonly ok: false; readonly reason: 'invalid_credentials' };

const INVALID_CREDENTIALS: LoginOutcome = { ok: false, reason: 'invalid_credentials' };

export async function logIn(
  sql: SQL,
  request: {
    readonly email: string;
    readonly password: string;
    readonly now: Date;
    readonly hash?: HashCost;
  },
): Promise<LoginOutcome> {
  const email = normalizeEmail(request.email);

  const rows =
    email === null
      ? []
      : await sql<{ account_id: string; password_hash: string; state: string }[]>`
          SELECT a.account_id, c.password_hash, a.state
          FROM account.account a
          JOIN account.password_credential c ON c.account_id = a.account_id
          WHERE a.email = ${email}`;

  const found = rows[0];
  if (found === undefined) {
    // Same work, same answer. An early return here is a timing oracle for
    // "does this address have an account", which is the enumeration channel the
    // uniform wording exists to close.
    await Bun.password.verify(request.password, await decoyHash(request.hash));
    return INVALID_CREDENTIALS;
  }

  const matched = await Bun.password.verify(request.password, found.password_hash);
  if (!matched) return INVALID_CREDENTIALS;
  if (found.state !== 'active') return INVALID_CREDENTIALS;

  return { ok: true, accountId: found.account_id };
}

/** Replace a password in place — used by reset and by an authenticated change. */
export async function setPassword(
  sql: SQL,
  request: {
    readonly accountId: string;
    readonly password: string;
    readonly now: Date;
    readonly hash?: HashCost;
  },
): Promise<{ readonly ok: boolean }> {
  if (
    request.password.length < MIN_PASSWORD_LENGTH ||
    request.password.length > MAX_PASSWORD_LENGTH
  ) {
    return { ok: false };
  }
  const digest = await Bun.password.hash(request.password, hashOptions(request.hash));
  await sql`
    INSERT INTO account.password_credential (account_id, password_hash, updated_at)
    VALUES (${request.accountId}, ${digest}, ${request.now})
    ON CONFLICT (account_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = EXCLUDED.updated_at`;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Sessions.
// ---------------------------------------------------------------------------

export interface IssuedSession {
  /** Handed to the browser once, in an httpOnly cookie, and never stored. */
  readonly token: string;
  readonly absoluteExpiresAt: Date;
}

export async function createSession(
  sql: SQL,
  request: { readonly accountId: string; readonly now: Date },
): Promise<IssuedSession> {
  const token = newToken(SESSION_TOKEN_PREFIX);
  const absoluteExpiresAt = new Date(request.now.getTime() + ABSOLUTE_SESSION_MS);
  await sql`
    INSERT INTO account.session (token_digest, account_id, created_at, last_seen_at, absolute_expires_at)
    VALUES (${tokenDigest(token)}, ${request.accountId}, ${request.now}, ${request.now}, ${absoluteExpiresAt})`;
  return { token, absoluteExpiresAt };
}

/**
 * One refusal reason for every way a session is not usable.
 *
 * A cookie that names an unknown session, an expired one and an idled-out one
 * all answer `expired`, because the browser's remedy is identical and the
 * distinctions are only useful to somebody probing for valid tokens.
 */
export type SessionOutcome =
  | { readonly ok: true; readonly accountId: string }
  | { readonly ok: false; readonly reason: 'expired' };

const SESSION_EXPIRED: SessionOutcome = { ok: false, reason: 'expired' };

/**
 * Resolve and touch, in one statement.
 *
 * Both windows are in the `WHERE`, so a session that fails either is not
 * refreshed by the read that discovered it — the "read it, decide, then update"
 * shape would extend the idle window of a session it was about to reject.
 */
export async function resolveSession(
  sql: SQL,
  request: { readonly token: string; readonly now: Date },
): Promise<SessionOutcome> {
  if (!request.token.startsWith(SESSION_TOKEN_PREFIX)) return SESSION_EXPIRED;

  const idleFloor = new Date(request.now.getTime() - IDLE_SESSION_MS);
  const rows = await sql<{ account_id: string }[]>`
    UPDATE account.session
    SET last_seen_at = ${request.now}
    WHERE token_digest = ${tokenDigest(request.token)}
      AND absolute_expires_at > ${request.now}
      AND last_seen_at > ${idleFloor}
    RETURNING account_id`;

  const found = rows[0];
  return found === undefined ? SESSION_EXPIRED : { ok: true, accountId: found.account_id };
}

export async function revokeSession(sql: SQL, token: string): Promise<void> {
  await sql`DELETE FROM account.session WHERE token_digest = ${tokenDigest(token)}`;
}

/** Every session, which is what a reset and a password change both must say. */
export async function revokeAllSessions(sql: SQL, accountId: string): Promise<void> {
  await sql`DELETE FROM account.session WHERE account_id = ${accountId}`;
}

// ---------------------------------------------------------------------------
// Verification tokens: password reset and email verification.
// ---------------------------------------------------------------------------

type VerificationPurpose = 'email_verify' | 'password_reset';

async function issueVerification(
  sql: SQL,
  request: {
    readonly accountId: string;
    readonly purpose: VerificationPurpose;
    readonly prefix: string;
    readonly ttlMs: number;
    readonly now: Date;
  },
): Promise<string> {
  const token = newToken(request.prefix);
  await sql`
    INSERT INTO account.verification (token_digest, account_id, purpose, created_at, expires_at)
    VALUES (
      ${tokenDigest(token)}, ${request.accountId}, ${request.purpose}::account.verification_purpose,
      ${request.now}, ${new Date(request.now.getTime() + request.ttlMs)}
    )`;
  return token;
}

/**
 * Consume a token if it is live, once.
 *
 * A compare-and-set rather than read-then-write: two clicks on the same mail, or
 * a mail client that prefetches the link, must produce one consumption. The
 * purpose is part of the predicate, so a reset token cannot be spent as a
 * verification token.
 */
async function consumeVerification(
  sql: SQL,
  request: { readonly token: string; readonly purpose: VerificationPurpose; readonly now: Date },
): Promise<string | null> {
  const rows = await sql<{ account_id: string }[]>`
    UPDATE account.verification
    SET consumed_at = ${request.now}
    WHERE token_digest = ${tokenDigest(request.token)}
      AND purpose = ${request.purpose}::account.verification_purpose
      AND consumed_at IS NULL
      AND expires_at > ${request.now}
    RETURNING account_id`;
  return rows[0]?.account_id ?? null;
}

/**
 * Begin a reset. **The response shape does not depend on whether the account
 * exists** — `token` is `null` when there is nothing to send, and the caller
 * renders the same page either way.
 */
export async function beginPasswordReset(
  sql: SQL,
  request: { readonly email: string; readonly now: Date },
): Promise<{ readonly ok: true; readonly token: string | null; readonly accountId: string | null }> {
  const email = normalizeEmail(request.email);
  if (email === null) return { ok: true, token: null, accountId: null };

  const rows = await sql<{ account_id: string }[]>`
    SELECT account_id FROM account.account WHERE email = ${email} AND state = 'active'`;
  const found = rows[0];
  if (found === undefined) return { ok: true, token: null, accountId: null };

  const token = await issueVerification(sql, {
    accountId: found.account_id,
    purpose: 'password_reset',
    prefix: RESET_TOKEN_PREFIX,
    ttlMs: RESET_TOKEN_TTL_MS,
    now: request.now,
  });
  return { ok: true, token, accountId: found.account_id };
}

export type ResetOutcome =
  | { readonly ok: true; readonly accountId: string }
  | { readonly ok: false; readonly reason: 'invalid_token' | 'weak_password' };

export async function completePasswordReset(
  sql: SQL,
  request: {
    readonly token: string;
    readonly password: string;
    readonly now: Date;
    readonly hash?: HashCost;
  },
): Promise<ResetOutcome> {
  if (
    request.password.length < MIN_PASSWORD_LENGTH ||
    request.password.length > MAX_PASSWORD_LENGTH
  ) {
    // Checked before the token is spent: a user who typed a short password gets
    // to click the same link again rather than having to ask for a new mail.
    return { ok: false, reason: 'weak_password' };
  }

  const accountId = await consumeVerification(sql, {
    token: request.token,
    purpose: 'password_reset',
    now: request.now,
  });
  if (accountId === null) return { ok: false, reason: 'invalid_token' };

  const set = await setPassword(sql, {
    accountId,
    password: request.password,
    now: request.now,
    ...(request.hash === undefined ? {} : { hash: request.hash }),
  });
  if (!set.ok) return { ok: false, reason: 'weak_password' };

  // Every session, not just the current one. This is the whole reason a reset is
  // a security event rather than a convenience.
  await revokeAllSessions(sql, accountId);

  // **The address is NOT promoted to verified.** Argued in the re-plan: the
  // attacker who signed up with somebody else's address holds the account and
  // not the mailbox, so a design where finishing a reset confers verification is
  // one where their half-account gains status from a flow they cannot complete.
  return { ok: true, accountId };
}

export async function beginEmailVerification(
  sql: SQL,
  request: { readonly accountId: string; readonly now: Date },
): Promise<string> {
  return issueVerification(sql, {
    accountId: request.accountId,
    purpose: 'email_verify',
    prefix: VERIFY_TOKEN_PREFIX,
    ttlMs: EMAIL_VERIFY_TTL_MS,
    now: request.now,
  });
}

export async function verifyEmail(
  sql: SQL,
  request: { readonly token: string; readonly now: Date },
): Promise<
  { readonly ok: true; readonly accountId: string } | { readonly ok: false; readonly reason: 'invalid_token' }
> {
  const accountId = await consumeVerification(sql, {
    token: request.token,
    purpose: 'email_verify',
    now: request.now,
  });
  if (accountId === null) return { ok: false, reason: 'invalid_token' };

  await sql`
    UPDATE account.account SET email_verified = true, updated_at = ${request.now}
    WHERE account_id = ${accountId}`;
  return { ok: true, accountId };
}

// ---------------------------------------------------------------------------
// OAuth identities. See the header: this is the takeover surface.
// ---------------------------------------------------------------------------

export type IdentityOutcome =
  | { readonly kind: 'signed_in'; readonly accountId: string }
  | { readonly kind: 'created'; readonly accountId: string }
  /**
   * The address already belongs to an account and this identity is not attached
   * to it. **Never an auto-link**, in either direction: the caller must
   * authenticate the user into the existing account and then call
   * {@link linkIdentity}.
   */
  | { readonly kind: 'link_required'; readonly reason: 'email_in_use' }
  | { readonly kind: 'refused'; readonly reason: 'email_unsupported' };

export async function resolveIdentity(
  sql: SQL,
  request: {
    readonly provider: IdentityProvider;
    readonly subject: string;
    readonly email: string;
    readonly emailVerified: boolean;
    readonly now: Date;
  },
): Promise<IdentityOutcome> {
  // 1. The link key, and only the link key. An email is never consulted to
  //    decide that an identity *is* an account.
  const linked = await sql<{ account_id: string }[]>`
    SELECT account_id FROM account.identity
    WHERE provider = ${request.provider}::account.identity_provider AND subject = ${request.subject}`;
  const existing = linked[0];
  if (existing !== undefined) return { kind: 'signed_in', accountId: existing.account_id };

  const email = normalizeEmail(request.email);
  if (email === null) return { kind: 'refused', reason: 'email_unsupported' };

  // 2. A colliding address is a stop, not a merge — whichever side is verified.
  const collision = await sql<{ account_id: string }[]>`
    SELECT account_id FROM account.account WHERE email = ${email}`;
  if (collision.length > 0) return { kind: 'link_required', reason: 'email_in_use' };

  // 3. A fresh address becomes a new account, verified only if the provider says
  //    so. An unverified one can never later absorb a collision, by rule 2.
  const accountId = newAccountId();
  const inserted = await sql<{ account_id: string }[]>`
    INSERT INTO account.account (account_id, email, email_verified, created_at, updated_at)
    VALUES (${accountId}, ${email}, ${request.emailVerified}, ${request.now}, ${request.now})
    ON CONFLICT (email) DO NOTHING
    RETURNING account_id`;
  // Lost a race with a concurrent signup on the same address: that is the
  // collision case, arriving a moment later. It gets the collision answer.
  if (inserted.length === 0) return { kind: 'link_required', reason: 'email_in_use' };

  await sql`
    INSERT INTO account.identity (provider, subject, account_id, linked_at)
    VALUES (${request.provider}::account.identity_provider, ${request.subject}, ${accountId}, ${request.now})`;
  return { kind: 'created', accountId };
}

export type LinkOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'provider_email_unverified' | 'identity_in_use' | 'unknown_account';
    };

/**
 * Attach a provider identity to an account the caller has **already
 * authenticated**. This function does not authenticate anything; it is the
 * second half of `link_required` and its caller owes the first.
 */
export async function linkIdentity(
  sql: SQL,
  request: {
    readonly accountId: string;
    readonly provider: IdentityProvider;
    readonly subject: string;
    readonly emailVerified: boolean;
    readonly now: Date;
  },
): Promise<LinkOutcome> {
  // Rule 3: authenticating into the account is necessary and not sufficient.
  if (request.emailVerified !== true) return { ok: false, reason: 'provider_email_unverified' };

  const account = await sql<{ account_id: string }[]>`
    SELECT account_id FROM account.account WHERE account_id = ${request.accountId} AND state = 'active'`;
  if (account.length === 0) return { ok: false, reason: 'unknown_account' };

  const inserted = await sql<{ account_id: string }[]>`
    INSERT INTO account.identity (provider, subject, account_id, linked_at)
    VALUES (${request.provider}::account.identity_provider, ${request.subject}, ${request.accountId}, ${request.now})
    ON CONFLICT (provider, subject) DO NOTHING
    RETURNING account_id`;
  if (inserted.length === 0) return { ok: false, reason: 'identity_in_use' };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// The account's brain.
// ---------------------------------------------------------------------------

export interface BrainLink {
  readonly tenantId: string;
  readonly ftsLanguage: string;
}

/**
 * Record which tenant this account's brain lives in.
 *
 * There is no foreign key — the control plane is a different database — so this
 * is the reconciliation point the schema comment points at. The unique index on
 * `tenant_id` is what makes "one brain, one owner" a database fact rather than a
 * habit; a second account naming a claimed tenant is refused here.
 */
export async function attachBrain(
  sql: SQL,
  request: {
    readonly accountId: string;
    readonly tenantId: string;
    readonly ftsLanguage: string;
    readonly now: Date;
  },
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: 'tenant_in_use' }> {
  const inserted = await sql<{ account_id: string }[]>`
    INSERT INTO account.brain (account_id, tenant_id, fts_language, linked_at)
    VALUES (${request.accountId}, ${request.tenantId}, ${request.ftsLanguage}, ${request.now})
    ON CONFLICT DO NOTHING
    RETURNING account_id`;
  return inserted.length === 0 ? { ok: false, reason: 'tenant_in_use' } : { ok: true };
}

export async function brainOf(sql: SQL, accountId: string): Promise<BrainLink | null> {
  const rows = await sql<{ tenant_id: string; fts_language: string }[]>`
    SELECT tenant_id, fts_language FROM account.brain WHERE account_id = ${accountId}`;
  const found = rows[0];
  return found === undefined ? null : { tenantId: found.tenant_id, ftsLanguage: found.fts_language };
}

/**
 * Constant-time string comparison, for the places a caller compares a secret it
 * was handed against one it holds. Digested first, so the comparison is over two
 * equal-length buffers whatever the caller passed — `timingSafeEqual` throws on a
 * length mismatch, and catching that throw would itself be the length oracle.
 *
 * Exported because `src/web/` needs it and there must not be a second copy.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}
