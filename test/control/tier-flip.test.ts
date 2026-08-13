/**
 * A tier change has to actually flip consolidation capability. This file is the
 * test the roadmap names, and it is written against the way that test usually
 * lies.
 *
 * **The trap.** "A downgrade disables the model phases" is trivially satisfied by
 * a test where the model phases were never going to run — a cycle with no work
 * in it, a handler that never reached the model tier, a corpus that produced no
 * candidates. Asserting that a *flag changed* is worse still: the flag is the
 * thing under test, so asserting on it asserts nothing.
 *
 * **So this asserts on the gateway, differentially, in one run.** The transport
 * records every call. After a downgrade the count must be **zero**; after an
 * upgrade over the same tenant, the same corpus and the same handler it must be
 * **greater than zero**. The second half is what makes the first half mean
 * something: without it, a broken wiring that never runs a cycle at all passes.
 *
 * And the path is the whole path. The tier is not set by a test helper — it is
 * moved by a **signed webhook** through `applyBillingEvent`, into
 * `control.tenant.tier`, read back by `createConsolidateWorld`, and handed to
 * `createConsolidateHandler`, which is U11's own production handler.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { SQL } from 'bun';

import { attachBrain, signUpWithPassword } from '../../src/control/accounts.ts';
import { applyBillingEvent } from '../../src/control/billing.ts';
import { createConsolidateWorld, TenantNotConsolidableError } from '../../src/control/tier.ts';
import { createConsolidateHandler } from '../../src/worker/consolidate/cycle.ts';
import type { JobLease } from '../../src/worker/jobs.ts';
import type { JobContext } from '../../src/worker/runner.ts';
import {
  TENANT,
  createGateway,
  createTenantFixture,
  seedPreConsolidationCorpus,
  type GatewayHarness,
  type TenantFixture,
} from '../consolidate/fixture.ts';
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
} from './identity-fixture.ts';

const SECRET = 'whsec_a_secret_this_test_invented_and_stripe_never_saw';
const AT = new Date('2026-08-13T09:00:00.000Z');
const SETUP_TIMEOUT_MS = 300_000;

let tenant: TenantFixture;
let identity: IdentityFixture;
let control: ControlFixture;
let sql: SQL;
let controlSql: SQL;
let harness: GatewayHarness;

function signedHeader(payload: string): string {
  const t = Math.floor(AT.getTime() / 1000);
  return `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex')}`;
}

function subscriptionEvent(id: string, status: string): string {
  return JSON.stringify({
    id,
    type: status === 'canceled' ? 'customer.subscription.deleted' : 'customer.subscription.updated',
    data: {
      object: {
        id: 'sub_dreamer',
        customer: 'cus_dreamer',
        status,
        current_period_end: Math.floor(AT.getTime() / 1000) + 30 * 86_400,
      },
    },
  });
}

async function deliver(id: string, status: string): Promise<void> {
  const payload = subscriptionEvent(id, status);
  const outcome = await applyBillingEvent({
    sql,
    controlSql,
    payload,
    header: signedHeader(payload),
    secret: SECRET,
    now: AT,
  });
  if (!outcome.ok) throw new Error(`the webhook was refused: ${outcome.reason}`);
  if (outcome.outcome !== 'applied') throw new Error(`the webhook did not apply: ${outcome.outcome}`);
}

/** U10's lease, as the runner would hand it to the handler. */
function jobContext(): JobContext {
  const lease: JobLease = {
    jobId: '00000000-0000-4000-8000-000000000001',
    tenantId: TENANT,
    kind: 'consolidate',
    target: 'whole_brain',
    leaseToken: 1,
    owner: 'tier-flip-test',
    expiresAt: new Date(AT.getTime() + 600_000),
    attemptDeadlineAt: new Date(AT.getTime() + 600_000),
    attempts: 1,
    maxAttempts: 5,
    debtObserved: 0,
  };
  return { lease, now: AT, signal: new AbortController().signal };
}

beforeAll(async () => {
  tenant = await createTenantFixture('tierflip');
  await seedPreConsolidationCorpus(tenant.sql);

  identity = await createIdentityStore('tierflip');
  control = await createControlPlane('tierflip');
  sql = connectIdentity(identity);
  controlSql = connectControl(control);

  const account = await signUpWithPassword(sql, {
    email: 'dreamer@example.com',
    password: 'correct horse battery staple',
    now: AT,
    hash: TEST_HASH_COST,
  });
  if (!account.ok) throw new Error('fixture account was not created');
  await attachBrain(sql, {
    accountId: account.accountId,
    tenantId: TENANT,
    ftsLanguage: 'simple',
    now: AT,
  });
  await sql`
    INSERT INTO account.subscription (account_id, tier, status, stripe_customer_id, stripe_subscription_id, updated_at)
    VALUES (${account.accountId}, 'paid', 'active', 'cus_dreamer', 'sub_dreamer', ${AT})`;

  await seedTenant(controlSql, TENANT);
  await controlSql`UPDATE control.tenant SET tier = 'paid' WHERE tenant_id = ${TENANT}`;

  harness = createGateway();
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await tenant?.close();
  await sql?.close();
  await controlSql?.close();
  if (identity) await dropIdentityStore(identity);
  if (control) await dropControlPlane(control);
}, SETUP_TIMEOUT_MS);

/**
 * The production ports, wired to the fixture's tenant database and gateway. The
 * *tier* is the only thing not injected: it comes out of the control plane, which
 * is the whole point.
 */
function ports() {
  return createConsolidateWorld({
    controlSql,
    connect: () => Promise.resolve({ sql: tenant.sql, close: () => Promise.resolve() }),
    gateway: () => harness.gateway,
  });
}

describe('a tier change flips consolidation capability', () => {
  test('the corpus has model work in it, or neither half below means anything', async () => {
    const rows = await tenant.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM page`;
    expect(rows[0]?.n ?? 0).toBeGreaterThan(0);
  });

  test('after a downgrade the gateway is not called at all', async () => {
    await deliver('evt_downgrade', 'canceled');

    const tiers = await controlSql<{ tier: string }[]>`
      SELECT tier::text AS tier FROM control.tenant WHERE tenant_id = ${TENANT}`;
    expect(tiers[0]?.tier).toBe('free');

    const before = harness.transport.calls.length;
    await createConsolidateHandler(ports())(jobContext());

    // Not "a flag says free". Not "the result reports free_tier". The model
    // gateway — the thing that spends money — received nothing.
    expect(harness.transport.calls.length).toBe(before);
    expect(harness.transport.calls.length).toBe(0);
  }, SETUP_TIMEOUT_MS);

  test('and after an upgrade, over the same tenant and the same corpus, it is', async () => {
    // The differential. Without this the assertion above is satisfied by a
    // handler that never ran, a corpus with nothing in it, or a port that threw
    // and was swallowed.
    await deliver('evt_upgrade', 'active');

    const tiers = await controlSql<{ tier: string }[]>`
      SELECT tier::text AS tier FROM control.tenant WHERE tenant_id = ${TENANT}`;
    expect(tiers[0]?.tier).toBe('paid');

    await createConsolidateHandler(ports())(jobContext());

    expect(harness.transport.calls.length).toBeGreaterThan(0);
  }, SETUP_TIMEOUT_MS);
});

describe('the tier is read per cycle, from the control plane', () => {
  test('a tenant that is not ready is refused rather than consolidated for free', async () => {
    await controlSql`
      INSERT INTO control.tenant (tenant_id, state, tier, schema_version, fts_language)
      VALUES ('halfbuilt', 'provisioning', 'free', 0, 'simple')`;

    await expect(ports().open('halfbuilt')).rejects.toThrow(TenantNotConsolidableError);
  });

  test('an unknown tenant is refused, and does not silently become a free one', async () => {
    await expect(ports().open('nobody')).rejects.toThrow(TenantNotConsolidableError);
  });
});
