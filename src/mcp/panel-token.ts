/**
 * The two short-TTL credentials U14 needs, which turn out to be one primitive.
 *
 * **The panel nonce and the MRTR `requestState` are the same thing.** SEP-1865
 * wants a nonce minted into a panel view and presented back with the action;
 * SEP-2322 wants an opaque blob the server hands out with `input_required` and
 * the client echoes back unmodified on the retry. Both are "a small, unforgeable,
 * expiring statement this server made about a pending action". Implementing them
 * twice would give the security-critical one two chances to be wrong.
 *
 * **Self-contained, because there is nowhere to put a pending-action table.**
 * Sessions were retired in 2026-07-28 and the fleet is stateless by design
 * (KTD2: any instance, any request). A server-side row would need to be shared
 * across instances, would outlive the conversation that created it, and would be
 * a second store to erase (R12). A signed payload needs none of that: any
 * instance can verify it, and it disappears by expiring.
 *
 * **Bound to four things, and each binding is a specific attack it refuses.**
 *
 *   * `tenantId` — a nonce minted in one brain cannot spend in another. This is
 *     belt-and-braces over the key (each tenant's key is derived from its own
 *     bearer grant), and it is kept because a key-derivation bug and a
 *     cross-tenant write should not be the same bug.
 *   * `callerKey` — the same identity the access log names. One connector's
 *     panel credential is not another connector's, so a leaked nonce is not a
 *     fleet-wide skeleton key for that tenant.
 *   * `purpose` — a panel nonce is not a confirmation and a confirmation is not
 *     a panel nonce. Without this, a `resources/read` on a ui-capable host mints
 *     something that satisfies the fallback branch's confirm gate, which is
 *     exactly the substitution the precedence rule exists to forbid.
 *   * `action` + `value` — for a confirmation, *the exact change the user was
 *     asked about*. Without it the retry is a blank cheque: the user is shown
 *     "pause gmail?", says yes, and the echoed state authorises "set the spend
 *     cap to zero" instead.
 *
 * **The residual, written down rather than discovered.** A token is replayable
 * within its TTL by whoever holds it. Single-use would need the shared store
 * this design exists to avoid; the TTL is the bound, and the actions behind it
 * are reversible by construction — which is also why the review-queue close is
 * *not* behind it (see the re-plan's §3).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How long a minted credential lives.
 *
 * Long enough that a person can read a panel, decide, and click; short enough
 * that a nonce lifted out of a transcript later is worthless. Five minutes is a
 * judgement rather than a measurement, and it is written down here so changing
 * it is a decision.
 */
export const PANEL_NONCE_TTL_MS = 5 * 60_000;

export type PanelTokenPurpose = 'panel' | 'confirm';

export interface PanelTokenClaims {
  readonly purpose: PanelTokenPurpose;
  readonly tenantId: string;
  readonly callerKey: string;
  /** `confirm` only: the action the user was asked about. */
  readonly action?: string;
  /** `confirm` only: the value the user was asked about. */
  readonly value?: string;
  /** Epoch milliseconds. The token is dead **at** this instant, not after it. */
  readonly expiresAt: number;
}

export type PanelTokenRefusal =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'wrong_purpose'
  | 'wrong_tenant'
  | 'wrong_caller'
  | 'action_mismatch';

export type PanelTokenVerdict =
  | { readonly ok: true; readonly claims: PanelTokenClaims }
  | { readonly ok: false; readonly reason: PanelTokenRefusal };

export interface PanelTokenExpectation {
  readonly purpose: PanelTokenPurpose;
  readonly tenantId: string;
  readonly callerKey: string;
  readonly action?: string;
  readonly value?: string;
  readonly nowMs: number;
}

function sign(key: string, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

/**
 * Mint one. `key` is the tenant's derived signing key — the same derivation the
 * access tokens use, so a tenant's credentials all live or die together.
 */
export function mintPanelToken(key: string, claims: PanelTokenClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${sign(key, payload)}`;
}

/**
 * Verify one against what the caller is actually asking to do.
 *
 * **The signature is checked before the payload is believed.** The parse below
 * happens first only because a signature needs a payload to be over; nothing
 * read out of it is acted on until the comparison passes. The comparison is
 * length-checked before `timingSafeEqual`, which throws on a length mismatch —
 * a forged token of the wrong length must be a refusal, not a 500.
 */
export function verifyPanelToken(
  token: string,
  key: string,
  expected: PanelTokenExpectation,
): PanelTokenVerdict {
  const separator = token.indexOf('.');
  if (separator <= 0 || separator === token.length - 1) return { ok: false, reason: 'malformed' };

  const payload = token.slice(0, separator);
  const presented = token.slice(separator + 1);
  if (presented.includes('.')) return { ok: false, reason: 'malformed' };

  const expectedSignature = sign(key, payload);
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expectedSignature, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };

  let claims: PanelTokenClaims;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof decoded !== 'object' || decoded === null) return { ok: false, reason: 'malformed' };
    claims = decoded as PanelTokenClaims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (typeof claims.expiresAt !== 'number' || !Number.isFinite(claims.expiresAt)) {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.purpose !== expected.purpose) return { ok: false, reason: 'wrong_purpose' };
  if (claims.tenantId !== expected.tenantId) return { ok: false, reason: 'wrong_tenant' };
  if (claims.callerKey !== expected.callerKey) return { ok: false, reason: 'wrong_caller' };
  if (expected.nowMs >= claims.expiresAt) return { ok: false, reason: 'expired' };

  // Checked whenever the caller states an expectation, and *unconditionally* for
  // a confirmation — a `confirm` verification that forgot to name the change it
  // is confirming must fail rather than quietly approve whatever the token
  // happens to say. A `panel` verification states none, because a panel nonce is
  // a credential for the view rather than an approval of one change.
  if (expected.purpose === 'confirm' || expected.action !== undefined || expected.value !== undefined) {
    if (claims.action !== expected.action || claims.value !== expected.value) {
      return { ok: false, reason: 'action_mismatch' };
    }
  }

  return { ok: true, claims };
}
