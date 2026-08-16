/**
 * Billing (U15): webhook signature verification, and the tier transition it
 * authorises.
 *
 * **This module is the only thing in the system that may change a tenant's
 * tier**, and a tier is what decides whether the consolidation cycle runs its
 * model phases (R8). So the signature check here is not an integration detail —
 * it is the authorisation check for paid capability, and a forged event that
 * verified would be an attacker granting themselves model spend on somebody
 * else's brain, or removing it from theirs.
 *
 * **No Stripe SDK, no network call, no vendor client.** The verification scheme
 * is documented and is thirty lines of HMAC; importing a client to perform it
 * would add a dependency to do arithmetic. What this module receives is the raw
 * request body, the `Stripe-Signature` header, and a secret its caller resolved
 * from the secret store.
 *
 * **The order is the security property, and it is stated because it is easy to
 * get backwards:**
 *
 *   1. Refuse if there is no signing secret. An absent environment variable
 *      defaulting to `''` yields a deterministic HMAC anyone can compute, and
 *      that is how this control fails without anybody noticing.
 *   2. Verify the signature over the **raw bytes as sent**. A handler that parses
 *      JSON and re-serialises is verifying a string the vendor never signed, and
 *      a handler that parses at all before verifying is running a parser on
 *      unauthenticated input.
 *   3. Only then parse.
 *
 * **Two independent replay controls, because neither covers the other.** The
 * timestamp tolerance refuses a captured request replayed later. The event-id
 * primary key on `account.billing_event` refuses a *genuine* delivery repeated
 * inside the window — which the vendor does on purpose, and which is the
 * ordinary case rather than an attack. A system with only the first applies
 * every retry twice.
 *
 * **Two databases, no distributed transaction, and the ordering chosen for it.**
 * The subscription row lives in the identity store and the tier lives in the
 * control plane. The claim on `billing_event` is taken first so a concurrent
 * duplicate cannot both apply; if applying then fails, the claim is released so
 * the vendor's retry can do the work rather than being deduped into silence.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { SQL } from 'bun';

/**
 * Five minutes, matching Stripe's own recommended default.
 *
 * Applied in **both** directions here. The vendor's libraries bound age only;
 * without a forward bound an attacker-chosen future `t` on a captured request
 * stays replayable for as long as they chose, and clock skew is the excuse that
 * would be offered for it.
 */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type SignatureRefusal =
  | 'no_signing_secret'
  | 'malformed_header'
  | 'bad_signature'
  | 'timestamp_out_of_tolerance';

export type SignatureVerdict =
  | { readonly ok: true; readonly timestamp: number }
  | { readonly ok: false; readonly reason: SignatureRefusal };

interface ParsedHeader {
  readonly timestamp: number;
  readonly signatures: readonly string[];
}

/**
 * `t=<unix seconds>,v1=<hex>[,v1=<hex>]…`
 *
 * Several `v1` entries appear while a secret is being rotated and **any** match
 * is sufficient — a parser that reads only the first refuses every delivery for
 * the length of the rotation, which is a self-inflicted outage that looks like
 * an attack.
 */
function parseSignatureHeader(header: string): ParsedHeader | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === 't') {
      if (!/^[0-9]{1,15}$/.test(value)) return null;
      timestamp = Number.parseInt(value, 10);
      continue;
    }
    // Only `v1`. A future scheme version is not something to guess at, and
    // treating an unknown one as acceptable is how a downgrade lands.
    if (key === 'v1' && /^[a-f0-9]{64}$/.test(value)) signatures.push(value);
  }

  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** Equal-length hex digests, compared in constant time. */
function signatureMatches(expected: string, presented: string): boolean {
  if (expected.length !== presented.length) return false;
  const encoder = new TextEncoder();
  return timingSafeEqual(encoder.encode(expected), encoder.encode(presented));
}

export function verifyStripeSignature(request: {
  /** The **raw** request body, exactly as received. Never a re-serialisation. */
  readonly payload: string;
  readonly header: string;
  readonly secret: string;
  readonly nowMs: number;
  readonly toleranceSeconds?: number;
}): SignatureVerdict {
  if (request.secret.length === 0) return { ok: false, reason: 'no_signing_secret' };

  const parsed = parseSignatureHeader(request.header);
  if (parsed === null) return { ok: false, reason: 'malformed_header' };

  const expected = createHmac('sha256', request.secret)
    .update(`${parsed.timestamp}.${request.payload}`)
    .digest('hex');

  // Signature before timestamp. The timestamp is *inside* the signed material,
  // so checking it first would be deciding on an unauthenticated number — and
  // the refusal would tell an attacker their forged `t` was in range.
  const matched = parsed.signatures.some((candidate) => signatureMatches(expected, candidate));
  if (!matched) return { ok: false, reason: 'bad_signature' };

  const tolerance = request.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const skew = Math.abs(Math.floor(request.nowMs / 1000) - parsed.timestamp);
  if (skew > tolerance) return { ok: false, reason: 'timestamp_out_of_tolerance' };

  return { ok: true, timestamp: parsed.timestamp };
}

// ---------------------------------------------------------------------------
// The event, and what it is allowed to change.
// ---------------------------------------------------------------------------

export type BillingTier = 'free' | 'paid';

export type SubscriptionStatus =
  | 'none'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete';

const KNOWN_STATUSES = new Set<string>([
  'none',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'incomplete',
]);

/**
 * Which statuses keep the model phases.
 *
 * `past_due` does, deliberately: the vendor is still retrying the card, and
 * cutting a user's consolidation the hour a payment bounces produces a support
 * ticket rather than a saved dollar. `canceled` and `incomplete` do not.
 *
 * **An unrecognised status is `free`.** The vendor adds statuses without asking,
 * and the fail-closed direction for a capability gate is off — a new status that
 * silently granted paid model spend to every tenant carrying it is the
 * expensive way to discover it exists.
 */
export function tierForStatus(status: string): BillingTier {
  return status === 'active' || status === 'trialing' || status === 'past_due' ? 'paid' : 'free';
}

function statusColumnValue(status: string): SubscriptionStatus {
  return KNOWN_STATUSES.has(status) ? (status as SubscriptionStatus) : 'incomplete';
}

/** The event shapes this module acts on. Everything else is recorded as ignored. */
const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

const CHECKOUT_COMPLETED = 'checkout.session.completed';

export type ApplyOutcome =
  | {
      readonly ok: true;
      readonly outcome: 'applied';
      readonly tier: BillingTier;
      readonly tenantId: string | null;
    }
  | { readonly ok: true; readonly outcome: 'duplicate' | 'ignored' | 'unknown_customer' }
  | { readonly ok: false; readonly reason: SignatureRefusal | 'malformed_event' };

interface StripeEvent {
  readonly id: string;
  readonly type: string;
  readonly object: Record<string, unknown>;
}

/** Read the fields we use, and refuse anything whose shape we cannot trust. */
function readEvent(payload: string): StripeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const id = record['id'];
  const type = record['type'];
  const data = record['data'];
  if (typeof id !== 'string' || typeof type !== 'string') return null;

  // The alphabets in `account-schema.sql` are narrower than "any string", and a
  // value the column cannot hold must be refused here rather than raising a
  // constraint violation the caller would report as an outage.
  if (!/^[a-z]{1,12}_[A-Za-z0-9]{1,126}$/.test(id)) return null;
  if (!/^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){0,5}$/.test(type)) return null;

  const object =
    typeof data === 'object' && data !== null
      ? (data as Record<string, unknown>)['object']
      : undefined;
  return {
    id,
    type,
    object: typeof object === 'object' && object !== null ? (object as Record<string, unknown>) : {},
  };
}

function stringField(object: Record<string, unknown>, name: string): string | null {
  const value = object[name];
  return typeof value === 'string' && /^[a-z]{1,12}_[A-Za-z0-9]{1,126}$/.test(value) ? value : null;
}

/**
 * Verify, then apply.
 *
 * `sql` is the identity database; `controlSql` is the content-free control
 * plane. Both are required because the two halves of a tier live in different
 * databases on purpose — the consolidation cycle reads the control plane and
 * must not depend on the identity store being reachable.
 */
export async function applyBillingEvent(request: {
  readonly sql: SQL;
  readonly controlSql: SQL;
  readonly payload: string;
  readonly header: string;
  readonly secret: string;
  readonly now: Date;
  readonly toleranceSeconds?: number;
}): Promise<ApplyOutcome> {
  const verdict = verifyStripeSignature({
    payload: request.payload,
    header: request.header,
    secret: request.secret,
    nowMs: request.now.getTime(),
    ...(request.toleranceSeconds === undefined ? {} : { toleranceSeconds: request.toleranceSeconds }),
  });
  // A refused delivery writes nothing — not the tier, and not the dedupe row
  // either. An unauthenticated caller must not be able to burn an event id that
  // the genuine delivery would then be deduped against.
  if (!verdict.ok) return { ok: false, reason: verdict.reason };

  const event = readEvent(request.payload);
  if (event === null) return { ok: false, reason: 'malformed_event' };

  const acts =
    SUBSCRIPTION_EVENTS.has(event.type) || event.type === CHECKOUT_COMPLETED;
  const outcome = acts ? 'applied' : 'ignored';

  // The claim. `ON CONFLICT DO NOTHING` is what makes "applied once" a property
  // of the database rather than of this function being called once: two
  // deliveries racing in two containers collapse onto one row.
  const claimed = await request.sql<{ event_id: string }[]>`
    INSERT INTO account.billing_event (event_id, event_type, outcome, received_at)
    VALUES (${event.id}, ${event.type}, ${outcome}::account.billing_event_outcome, ${request.now})
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id`;
  if (claimed.length === 0) return { ok: true, outcome: 'duplicate' };

  if (!acts) return { ok: true, outcome: 'ignored' };

  try {
    return await applyToSubscription(request, event);
  } catch (error) {
    // Release the claim so the vendor's retry does the work. Deduping a delivery
    // whose effect never landed is the one failure this table must not produce.
    await request.sql`DELETE FROM account.billing_event WHERE event_id = ${event.id}`;
    throw error;
  }
}

async function applyToSubscription(
  request: {
    readonly sql: SQL;
    readonly controlSql: SQL;
    readonly now: Date;
  },
  event: StripeEvent,
): Promise<ApplyOutcome> {
  const customerId =
    event.type === CHECKOUT_COMPLETED
      ? stringField(event.object, 'customer')
      : stringField(event.object, 'customer');
  if (customerId === null) {
    await markOutcome(request.sql, event.id, 'unknown_customer');
    return { ok: true, outcome: 'unknown_customer' };
  }

  const owners = await request.sql<{ account_id: string }[]>`
    SELECT account_id FROM account.subscription WHERE stripe_customer_id = ${customerId}`;
  const owner = owners[0];
  if (owner === undefined) {
    await markOutcome(request.sql, event.id, 'unknown_customer');
    return { ok: true, outcome: 'unknown_customer' };
  }

  // A checkout completion tells us a customer exists and nothing about the
  // subscription's state; the `customer.subscription.*` event that follows is
  // what moves the tier. Recording it and stopping is the honest handling.
  if (event.type === CHECKOUT_COMPLETED) {
    await markOutcome(request.sql, event.id, 'ignored');
    return { ok: true, outcome: 'ignored' };
  }

  const subscriptionId = stringField(event.object, 'id');
  const rawStatus =
    event.type === 'customer.subscription.deleted'
      ? 'canceled'
      : typeof event.object['status'] === 'string'
        ? (event.object['status'] as string)
        : 'canceled';
  const tier = tierForStatus(rawStatus);
  const status = statusColumnValue(rawStatus);

  const periodEnd = event.object['current_period_end'];
  const currentPeriodEnd =
    typeof periodEnd === 'number' && Number.isFinite(periodEnd) ? new Date(periodEnd * 1000) : null;

  await request.sql`
    UPDATE account.subscription
    SET tier = ${tier}::account.subscription_tier,
        status = ${status}::account.subscription_status,
        stripe_subscription_id = ${tier === 'paid' ? subscriptionId : null},
        current_period_end = ${currentPeriodEnd},
        updated_at = ${request.now}
    WHERE account_id = ${owner.account_id}`;

  // The other half, in the other database. `control.tenant.tier` is what the
  // consolidation cycle reads; without this write the subscription would say
  // paid and the brain would keep behaving like a free one.
  const brains = await request.sql<{ tenant_id: string }[]>`
    SELECT tenant_id FROM account.brain WHERE account_id = ${owner.account_id}`;
  const tenantId = brains[0]?.tenant_id ?? null;
  if (tenantId !== null) {
    await request.controlSql`
      UPDATE control.tenant
      SET tier = ${tier}::control.tenant_tier, updated_at = ${request.now}
      WHERE tenant_id = ${tenantId}`;
  }

  return { ok: true, outcome: 'applied', tier, tenantId };
}

async function markOutcome(
  sql: SQL,
  eventId: string,
  outcome: 'applied' | 'duplicate' | 'ignored' | 'unknown_customer',
): Promise<void> {
  await sql`
    UPDATE account.billing_event
    SET outcome = ${outcome}::account.billing_event_outcome
    WHERE event_id = ${eventId}`;
}

// ---------------------------------------------------------------------------
// Reading the current state, for the dashboard and for provisioning.
// ---------------------------------------------------------------------------

export interface SubscriptionView {
  readonly tier: BillingTier;
  readonly status: SubscriptionStatus;
  readonly currentPeriodEnd: Date | null;
  readonly hasCustomer: boolean;
}

export async function subscriptionOf(sql: SQL, accountId: string): Promise<SubscriptionView> {
  const rows = await sql<
    {
      tier: BillingTier;
      status: SubscriptionStatus;
      current_period_end: Date | null;
      stripe_customer_id: string | null;
    }[]
  >`SELECT tier, status, current_period_end, stripe_customer_id
    FROM account.subscription WHERE account_id = ${accountId}`;
  const found = rows[0];
  if (found === undefined) {
    return { tier: 'free', status: 'none', currentPeriodEnd: null, hasCustomer: false };
  }
  return {
    tier: found.tier,
    status: found.status,
    currentPeriodEnd: found.current_period_end,
    hasCustomer: found.stripe_customer_id !== null,
  };
}

/**
 * Which customer this account is, as recorded before checkout starts.
 *
 * **Nothing in `src/` wrote this column.** Every write lived in a test, so a
 * genuine, correctly-signed delivery could never resolve an owner: the webhook
 * looks an account up *by customer id* (`applyToSubscription`), found nothing,
 * and answered `unknown_customer` — a paid subscription that never became a paid
 * tier, silently, for every real customer. This is the writer, and it runs
 * before the user is sent to the vendor rather than after they come back,
 * because the `checkout.session.completed` delivery can arrive first and
 * frequently does.
 *
 * **Idempotent, and it never re-points an existing customer.** The `WHERE`
 * admits a row whose column is null or already this exact id; a row naming a
 * different customer is left alone and reported. Repointing would move a paying
 * customer's subscription onto another account — the direction that cannot be
 * undone by a retry — and the unique index on the column means the alternative
 * failure is a constraint violation rather than a silent swap.
 */
export async function recordCheckoutCustomer(
  sql: SQL,
  request: {
    readonly accountId: string;
    readonly customerId: string;
    readonly now: Date;
  },
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'invalid_customer_id' | 'not_this_account' }
> {
  // The column's own alphabet (`account.stripe_id`), checked here so a malformed
  // id is a typed refusal rather than a constraint violation the caller reports
  // as an outage. Same rule `readEvent` applies to an id off the wire.
  if (!/^[a-z]{1,12}_[A-Za-z0-9]{1,126}$/.test(request.customerId)) {
    return { ok: false, reason: 'invalid_customer_id' };
  }

  const updated = await sql<{ account_id: string }[]>`
    UPDATE account.subscription
       SET stripe_customer_id = ${request.customerId}, updated_at = ${request.now}
     WHERE account_id = ${request.accountId}
       AND (stripe_customer_id IS NULL OR stripe_customer_id = ${request.customerId})
    RETURNING account_id`;

  return updated.length === 0 ? { ok: false, reason: 'not_this_account' } : { ok: true };
}

/** Called when an account is created, so every account has a subscription row. */
export async function openFreeSubscription(
  sql: SQL,
  request: { readonly accountId: string; readonly now: Date },
): Promise<void> {
  await sql`
    INSERT INTO account.subscription (account_id, tier, status, updated_at)
    VALUES (${request.accountId}, 'free', 'none', ${request.now})
    ON CONFLICT (account_id) DO NOTHING`;
}
