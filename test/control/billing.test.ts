/**
 * Stripe webhook signature verification, and the replay controls beside it.
 *
 * **No live Stripe account, no live keys, no test-mode API call.** Every
 * signature below is computed in this file from a synthetic secret, against the
 * documented scheme: `Stripe-Signature: t=<unix>,v1=<hex>`, where the signed
 * payload is `` `${t}.${rawBody}` `` and the signature is HMAC-SHA256 of that
 * string under the endpoint secret. What is therefore established is that the
 * verifier implements the documented contract; what is not established, and is
 * reported `deferred`, is that Stripe's production header matches it in some
 * detail the documentation omits.
 *
 * **The trap this file is written against:** a suite that only asserts a *valid*
 * signature verifies passes trivially on a verifier that returns `true`
 * unconditionally. So the cases that carry the weight are the forged one (right
 * shape, wrong secret), the tampered body, the two out-of-tolerance timestamps,
 * and the duplicate delivery — and each of them is mutated in the report.
 *
 * The two replay controls are independent and both are tested, because neither
 * covers the other: the timestamp tolerance refuses a *captured* request replayed
 * later, and the event-id primary key refuses a *genuine* delivery repeated
 * inside the window — which the vendor does on purpose and is the ordinary case
 * rather than the attack.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { SQL } from 'bun';

import {
  DEFAULT_TOLERANCE_SECONDS,
  applyBillingEvent,
  tierForStatus,
  verifyStripeSignature,
} from '../../src/control/billing.ts';
import { signUpWithPassword, attachBrain } from '../../src/control/accounts.ts';
import {
  connect,
  createIdentityStore,
  dropIdentityStore,
  TEST_HASH_COST,
  type IdentityFixture,
} from './identity-fixture.ts';
import {
  connect as connectControl,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from '../worker/fixture.ts';

const SECRET = 'whsec_a_secret_this_test_invented_and_stripe_never_saw';
const OTHER_SECRET = 'whsec_the_secret_an_attacker_guessed_at_instead';
const AT = new Date('2026-08-13T09:00:00.000Z');
const NOW_SECONDS = Math.floor(AT.getTime() / 1000);

function sign(payload: string, timestamp: number, secret: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

function header(payload: string, options: { t?: number; secret?: string } = {}): string {
  const t = options.t ?? NOW_SECONDS;
  return `t=${t},v1=${sign(payload, t, options.secret ?? SECRET)}`;
}

function subscriptionEvent(options: {
  readonly id: string;
  readonly type: string;
  readonly customer: string;
  readonly subscription: string;
  readonly status: string;
  /** When the *vendor* made the event. Not when it was delivered — the two come
   * apart on exactly the delivery this file's ordering test is about. */
  readonly created?: number;
}): string {
  return JSON.stringify({
    id: options.id,
    type: options.type,
    created: options.created ?? NOW_SECONDS,
    data: {
      object: {
        id: options.subscription,
        customer: options.customer,
        status: options.status,
        current_period_end: NOW_SECONDS + 30 * 86_400,
      },
    },
  });
}

// ---------------------------------------------------------------------------

describe('signature verification', () => {
  const payload = subscriptionEvent({
    id: 'evt_one',
    type: 'customer.subscription.updated',
    customer: 'cus_alice',
    subscription: 'sub_alice',
    status: 'active',
  });

  test('a signature this secret produced verifies', () => {
    expect(
      verifyStripeSignature({
        payload,
        header: header(payload),
        secret: SECRET,
        nowMs: AT.getTime(),
      }),
    ).toEqual({ ok: true, timestamp: NOW_SECONDS });
  });

  test('A FORGED SIGNATURE IS REFUSED — right shape, wrong secret', () => {
    // The case a verifier that returns `true` would pass. It is spelled out
    // rather than folded into a loop so that a future edit cannot delete it
    // without noticing what it deleted.
    const forged = header(payload, { secret: OTHER_SECRET });
    expect(forged).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);

    expect(
      verifyStripeSignature({ payload, header: forged, secret: SECRET, nowMs: AT.getTime() }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  test('a body altered after signing is refused', () => {
    // The attack the signature exists for: the header is genuine, the body is
    // not. A verifier that hashed a re-serialised parse would accept this.
    const tampered = payload.replace('"status":"active"', '"status":"canceled"');
    expect(tampered).not.toBe(payload);
    expect(
      verifyStripeSignature({
        payload: tampered,
        header: header(payload),
        secret: SECRET,
        nowMs: AT.getTime(),
      }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  test('A REPLAY FROM OUTSIDE THE WINDOW IS REFUSED', () => {
    const old = NOW_SECONDS - DEFAULT_TOLERANCE_SECONDS - 1;
    expect(
      verifyStripeSignature({
        payload,
        header: header(payload, { t: old }),
        secret: SECRET,
        nowMs: AT.getTime(),
      }),
    ).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  test('a far-future timestamp is refused too, in the direction Stripe does not check', () => {
    // Stripe's own libraries bound age only. An attacker-chosen future `t` on a
    // captured request would otherwise stay replayable for as long as they chose.
    const ahead = NOW_SECONDS + DEFAULT_TOLERANCE_SECONDS + 1;
    expect(
      verifyStripeSignature({
        payload,
        header: header(payload, { t: ahead }),
        secret: SECRET,
        nowMs: AT.getTime(),
      }),
    ).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  test('a timestamp inside the window on either side is accepted', () => {
    for (const t of [NOW_SECONDS - DEFAULT_TOLERANCE_SECONDS + 1, NOW_SECONDS + DEFAULT_TOLERANCE_SECONDS - 1]) {
      expect(
        verifyStripeSignature({
          payload,
          header: header(payload, { t }),
          secret: SECRET,
          nowMs: AT.getTime(),
        }).ok,
      ).toBe(true);
    }
  });

  test('the signed payload includes the timestamp, so `t` cannot be edited in flight', () => {
    const genuine = header(payload);
    const moved = genuine.replace(/^t=\d+/, `t=${NOW_SECONDS - 1}`);
    expect(
      verifyStripeSignature({ payload, header: moved, secret: SECRET, nowMs: AT.getTime() }),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  test('a rotation header carrying one stale and one current v1 is accepted', () => {
    // Stripe sends several `v1` entries while a secret is being rotated, and any
    // match is sufficient. A verifier that reads only the first would refuse
    // every delivery for the length of a rotation.
    const rotating = `t=${NOW_SECONDS},v1=${sign(payload, NOW_SECONDS, OTHER_SECRET)},v1=${sign(payload, NOW_SECONDS, SECRET)}`;
    expect(
      verifyStripeSignature({ payload, header: rotating, secret: SECRET, nowMs: AT.getTime() }).ok,
    ).toBe(true);
  });

  test('a header with no v1 at all is refused as malformed, not as a bad signature', () => {
    expect(
      verifyStripeSignature({
        payload,
        header: `t=${NOW_SECONDS},v0=${sign(payload, NOW_SECONDS, SECRET)}`,
        secret: SECRET,
        nowMs: AT.getTime(),
      }),
    ).toEqual({ ok: false, reason: 'malformed_header' });
  });

  test('a missing or unparseable header is refused', () => {
    for (const bad of ['', 'nonsense', `v1=${sign(payload, NOW_SECONDS, SECRET)}`, 't=abc,v1=deadbeef']) {
      expect(
        verifyStripeSignature({ payload, header: bad, secret: SECRET, nowMs: AT.getTime() }).ok,
      ).toBe(false);
    }
  });

  test('an empty signing secret refuses everything rather than verifying anything', () => {
    // The way this control fails silently: a missing environment variable
    // defaulting to `''` gives a deterministic HMAC an attacker can compute.
    expect(
      verifyStripeSignature({
        payload,
        header: header(payload, { secret: '' }),
        secret: '',
        nowMs: AT.getTime(),
      }),
    ).toEqual({ ok: false, reason: 'no_signing_secret' });
  });
});

describe('status to tier', () => {
  test('the vendor lifecycle maps to two tiers, and past_due keeps the paid one', () => {
    expect(tierForStatus('active')).toBe('paid');
    expect(tierForStatus('trialing')).toBe('paid');
    // The vendor is still retrying the card. Cutting model phases the hour a
    // payment bounces is a support ticket, not a control.
    expect(tierForStatus('past_due')).toBe('paid');
    expect(tierForStatus('canceled')).toBe('free');
    expect(tierForStatus('incomplete')).toBe('free');
    expect(tierForStatus('unrecognised_future_status')).toBe('free');
  });
});

// ---------------------------------------------------------------------------

describe('applying an event', () => {
  let identity: IdentityFixture;
  let control: ControlFixture;
  let sql: SQL;
  let controlSql: SQL;

  beforeAll(async () => {
    identity = await createIdentityStore('billing');
    control = await createControlPlane('billing');
    sql = connect(identity);
    controlSql = connectControl(control);
  }, 60_000);

  afterAll(async () => {
    await sql?.close();
    await controlSql?.close();
    if (identity) await dropIdentityStore(identity);
    if (control) await dropControlPlane(control);
  });

  async function aPayingCustomer(): Promise<{ accountId: string; tenantId: string }> {
    await sql`DELETE FROM account.account`;
    await sql`DELETE FROM account.billing_event`;
    await controlSql`DELETE FROM control.tenant`;

    const created = await signUpWithPassword(sql, {
      email: 'alice@example.com',
      password: 'correct horse battery staple',
      now: AT,
      hash: TEST_HASH_COST,
    });
    if (!created.ok) throw new Error('fixture account was not created');
    const tenantId = 'alice';
    await attachBrain(sql, { accountId: created.accountId, tenantId, ftsLanguage: 'simple', now: AT });
    await sql`
      INSERT INTO account.subscription (account_id, tier, status, stripe_customer_id, updated_at)
      VALUES (${created.accountId}, 'free', 'none', 'cus_alice', ${AT})`;
    await seedTenant(controlSql, tenantId);
    return { accountId: created.accountId, tenantId };
  }

  test('a forged event changes nothing at all', async () => {
    const { tenantId } = await aPayingCustomer();
    const payload = subscriptionEvent({
      id: 'evt_forged',
      type: 'customer.subscription.updated',
      customer: 'cus_alice',
      subscription: 'sub_alice',
      status: 'active',
    });

    const outcome = await applyBillingEvent({
      sql,
      controlSql,
      payload,
      header: header(payload, { secret: OTHER_SECRET }),
      secret: SECRET,
      now: AT,
    });
    expect(outcome).toEqual({ ok: false, reason: 'bad_signature' });

    // Nothing written — not the tier, and not even the event record. A refused
    // delivery must not be able to fill the dedupe table either.
    const tenants = await controlSql<{ tier: string }[]>`
      SELECT tier FROM control.tenant WHERE tenant_id = ${tenantId}`;
    expect(tenants[0]?.tier).toBe('free');
    expect(await sql`SELECT 1 FROM account.billing_event`).toHaveLength(0);
  });

  test('a genuine upgrade moves both the subscription and the control-plane tier', async () => {
    const { tenantId } = await aPayingCustomer();
    const payload = subscriptionEvent({
      id: 'evt_upgrade',
      type: 'customer.subscription.updated',
      customer: 'cus_alice',
      subscription: 'sub_alice',
      status: 'active',
    });

    expect(
      await applyBillingEvent({
        sql,
        controlSql,
        payload,
        header: header(payload),
        secret: SECRET,
        now: AT,
      }),
    ).toEqual({ ok: true, outcome: 'applied', tier: 'paid', tenantId });

    const subs = await sql<{ tier: string; status: string; stripe_subscription_id: string }[]>`
      SELECT tier, status, stripe_subscription_id FROM account.subscription`;
    expect(subs[0]).toMatchObject({ tier: 'paid', status: 'active', stripe_subscription_id: 'sub_alice' });

    const tenants = await controlSql<{ tier: string }[]>`
      SELECT tier FROM control.tenant WHERE tenant_id = ${tenantId}`;
    expect(tenants[0]?.tier).toBe('paid');
  });

  test('A REPEATED DELIVERY OF THE SAME EVENT APPLIES NOTHING', async () => {
    const { tenantId } = await aPayingCustomer();
    const upgrade = subscriptionEvent({
      id: 'evt_same',
      type: 'customer.subscription.updated',
      customer: 'cus_alice',
      subscription: 'sub_alice',
      status: 'active',
    });
    await applyBillingEvent({ sql, controlSql, payload: upgrade, header: header(upgrade), secret: SECRET, now: AT });

    // Somebody downgrades out of band — an operator, a support action. The
    // repeated delivery must not undo it.
    await controlSql`UPDATE control.tenant SET tier = 'free' WHERE tenant_id = ${tenantId}`;

    const again = await applyBillingEvent({
      sql,
      controlSql,
      payload: upgrade,
      header: header(upgrade),
      secret: SECRET,
      now: AT,
    });
    expect(again).toEqual({ ok: true, outcome: 'duplicate' });

    const tenants = await controlSql<{ tier: string }[]>`
      SELECT tier FROM control.tenant WHERE tenant_id = ${tenantId}`;
    expect(tenants[0]?.tier).toBe('free');
  });

  test('a duplicate is distinguished from a re-signed copy carrying a new event id', async () => {
    // The dedupe key is the event id, and it has to be: a genuine second event
    // that happens to say the same thing is a real state change to apply.
    const { tenantId } = await aPayingCustomer();
    const first = subscriptionEvent({
      id: 'evt_a',
      type: 'customer.subscription.updated',
      customer: 'cus_alice',
      subscription: 'sub_alice',
      status: 'active',
    });
    const second = subscriptionEvent({
      id: 'evt_b',
      type: 'customer.subscription.deleted',
      customer: 'cus_alice',
      subscription: 'sub_alice',
      status: 'canceled',
    });

    await applyBillingEvent({ sql, controlSql, payload: first, header: header(first), secret: SECRET, now: AT });
    expect(
      await applyBillingEvent({ sql, controlSql, payload: second, header: header(second), secret: SECRET, now: AT }),
    ).toEqual({ ok: true, outcome: 'applied', tier: 'free', tenantId });

    const tenants = await controlSql<{ tier: string }[]>`
      SELECT tier FROM control.tenant WHERE tenant_id = ${tenantId}`;
    expect(tenants[0]?.tier).toBe('free');
  });

  test('an event for a customer we do not know is recorded and applied to nobody', async () => {
    await aPayingCustomer();
    const payload = subscriptionEvent({
      id: 'evt_stranger',
      type: 'customer.subscription.updated',
      customer: 'cus_somebody_else',
      subscription: 'sub_somebody_else',
      status: 'active',
    });

    expect(
      await applyBillingEvent({ sql, controlSql, payload, header: header(payload), secret: SECRET, now: AT }),
    ).toEqual({ ok: true, outcome: 'unknown_customer' });

    const subs = await sql<{ tier: string }[]>`SELECT tier FROM account.subscription`;
    expect(subs[0]?.tier).toBe('free');
  });

  test('an event type we do not act on is recorded as ignored, not as an error', async () => {
    await aPayingCustomer();
    const payload = JSON.stringify({
      id: 'evt_invoice',
      type: 'invoice.payment_succeeded',
      data: { object: { id: 'in_x', customer: 'cus_alice' } },
    });
    expect(
      await applyBillingEvent({ sql, controlSql, payload, header: header(payload), secret: SECRET, now: AT }),
    ).toEqual({ ok: true, outcome: 'ignored' });

    const rows = await sql<{ outcome: string; event_type: string }[]>`
      SELECT outcome, event_type FROM account.billing_event WHERE event_id = 'evt_invoice'`;
    expect(rows[0]).toEqual({ outcome: 'ignored', event_type: 'invoice.payment_succeeded' });
  });

  test('no event body is stored — only its id, its type and when it arrived', async () => {
    await aPayingCustomer();
    const payload = subscriptionEvent({
      id: 'evt_body',
      type: 'customer.subscription.updated',
      customer: 'cus_alice',
      subscription: 'sub_alice',
      status: 'active',
    });
    await applyBillingEvent({ sql, controlSql, payload, header: header(payload), secret: SECRET, now: AT });

    const columns = await sql<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'account' AND table_name = 'billing_event'
      ORDER BY column_name`;
    expect(columns.map((c) => c.column_name)).toEqual([
      'event_id',
      'event_type',
      'outcome',
      'received_at',
    ]);
  });

  test('a body that is not JSON is refused after the signature, not before it', async () => {
    // Order matters: parsing first would run a JSON parser on unauthenticated
    // input. A validly signed non-JSON body is what proves the order.
    await aPayingCustomer();
    const payload = 'not json at all';
    expect(
      await applyBillingEvent({ sql, controlSql, payload, header: header(payload), secret: SECRET, now: AT }),
    ).toEqual({ ok: false, reason: 'malformed_event' });
  });

  test('A LATE DELIVERY DOES NOT RE-UPGRADE A CANCELLED TENANT', async () => {
    // **The vendor does not promise order.** Everything the signature check
    // establishes is still true of this delivery: right secret, right body,
    // inside the tolerance, an event id nothing has claimed. It is genuine and
    // it is stale, and those are not the same question — so the two replay
    // controls this module already has cannot answer it. The tolerance admits
    // it (it was signed a moment ago), the event-id primary key admits it (a
    // different event), and without a third control the cancellation is undone
    // by an upgrade the vendor emitted *before* it, with no path back: nothing
    // else ever writes that tier down again.
    const { tenantId } = await aPayingCustomer();

    const cancelled = subscriptionEvent({
      id: 'evt_cancel',
      type: 'customer.subscription.updated',
      customer: 'cus_alice',
      subscription: 'sub_alice',
      status: 'canceled',
      created: NOW_SECONDS,
    });
    expect(
      await applyBillingEvent({
        sql,
        controlSql,
        payload: cancelled,
        header: header(cancelled),
        secret: SECRET,
        now: AT,
      }),
    ).toEqual({ ok: true, outcome: 'applied', tier: 'free', tenantId });

    // Emitted a minute *earlier*, delivered now.
    const late = subscriptionEvent({
      id: 'evt_late_active',
      type: 'customer.subscription.updated',
      customer: 'cus_alice',
      subscription: 'sub_alice',
      status: 'active',
      created: NOW_SECONDS - 60,
    });
    expect(
      await applyBillingEvent({
        sql,
        controlSql,
        payload: late,
        header: header(late),
        secret: SECRET,
        now: AT,
      }),
    ).toEqual({ ok: true, outcome: 'superseded' });

    // Both halves of the tier, because a stale event that moved only one of
    // them would be the worse bug: a free subscription over a paid brain.
    const subs = await sql<{ tier: string; status: string }[]>`
      SELECT tier::text AS tier, status::text AS status FROM account.subscription`;
    expect(subs[0]).toMatchObject({ tier: 'free', status: 'canceled' });

    const tenants = await controlSql<{ tier: string }[]>`
      SELECT tier::text AS tier FROM control.tenant WHERE tenant_id = ${tenantId}`;
    expect(tenants[0]?.tier).toBe('free');

    // Recorded, not silently dropped: an operator asking why an upgrade did not
    // land needs the delivery to be in the table with a reason on it.
    const rows = await sql<{ outcome: string }[]>`
      SELECT outcome::text AS outcome FROM account.billing_event WHERE event_id = 'evt_late_active'`;
    expect(rows[0]?.outcome).toBe('superseded');
  });

  test('a later delivery still applies, or the control above is just a stop', async () => {
    // The half that makes the half above mean something. Same tenant, same
    // shape, `created` moved forward instead of back.
    const { tenantId } = await aPayingCustomer();

    const cancelled = subscriptionEvent({
      id: 'evt_first_cancel',
      type: 'customer.subscription.updated',
      customer: 'cus_alice',
      subscription: 'sub_alice',
      status: 'canceled',
      created: NOW_SECONDS - 60,
    });
    await applyBillingEvent({
      sql,
      controlSql,
      payload: cancelled,
      header: header(cancelled),
      secret: SECRET,
      now: AT,
    });

    const resubscribed = subscriptionEvent({
      id: 'evt_then_active',
      type: 'customer.subscription.updated',
      customer: 'cus_alice',
      subscription: 'sub_alice',
      status: 'active',
      created: NOW_SECONDS,
    });
    expect(
      await applyBillingEvent({
        sql,
        controlSql,
        payload: resubscribed,
        header: header(resubscribed),
        secret: SECRET,
        now: AT,
      }),
    ).toEqual({ ok: true, outcome: 'applied', tier: 'paid', tenantId });

    const tenants = await controlSql<{ tier: string }[]>`
      SELECT tier::text AS tier FROM control.tenant WHERE tenant_id = ${tenantId}`;
    expect(tenants[0]?.tier).toBe('paid');
  });

  test('an event carrying no `created` at all is refused, rather than applied out of order', async () => {
    // `created` is as required a field of the vendor's event object as `id` and
    // `type`, and the same refusal covers all three. Reading its absence as
    // "apply unconditionally" would leave the ordering control switched off for
    // exactly the bodies that carry no way to order them.
    await aPayingCustomer();
    const payload = JSON.stringify({
      id: 'evt_undated',
      type: 'customer.subscription.updated',
      data: { object: { id: 'sub_alice', customer: 'cus_alice', status: 'active' } },
    });
    expect(
      await applyBillingEvent({ sql, controlSql, payload, header: header(payload), secret: SECRET, now: AT }),
    ).toEqual({ ok: false, reason: 'malformed_event' });
  });

  test('AN ID CARRYING AN UNDERSCORE AFTER ITS PREFIX IS APPLIED, NOT DISCARDED', async () => {
    // The vendor's id alphabet is not `[A-Za-z0-9]` after the prefix, and never
    // was: `cs_test_…`, `cs_live_…` and `sub_sched_…` are ordinary ids. A
    // narrower alphabet here is not a safety property — the signature has
    // already proved the delivery came from the vendor — it is a genuine
    // upgrade being thrown away, and `src/web/app.ts` answers the refusal with
    // the 400 its own comment says the vendor gives up on. So a delivery this
    // system cannot *store* is a column to widen, not a delivery to drop.
    const { tenantId } = await aPayingCustomer();
    const payload = subscriptionEvent({
      id: 'evt_stale_active',
      type: 'customer.subscription.updated',
      customer: 'cus_alice',
      subscription: 'sub_sched_alice',
      status: 'active',
    });

    expect(
      await applyBillingEvent({ sql, controlSql, payload, header: header(payload), secret: SECRET, now: AT }),
    ).toEqual({ ok: true, outcome: 'applied', tier: 'paid', tenantId });

    // Both halves land, which is what exercises the column's own domain: a
    // widened regex over an unwidened `account.stripe_id` would be a constraint
    // violation rather than a refusal, and the claim-release path would hand the
    // vendor a retry that fails the same way forever.
    const events = await sql<{ event_id: string }[]>`
      SELECT event_id FROM account.billing_event WHERE event_id = 'evt_stale_active'`;
    expect(events).toHaveLength(1);

    const subs = await sql<{ stripe_subscription_id: string | null }[]>`
      SELECT stripe_subscription_id FROM account.subscription WHERE stripe_customer_id = 'cus_alice'`;
    expect(subs[0]?.stripe_subscription_id).toBe('sub_sched_alice');
  });
});
