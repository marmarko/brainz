/**
 * The rolling spend counter, against the real control plane.
 *
 * R14's counter is a column — `control.tenant.spend_micro_usd`, `bigint`,
 * non-negative by CHECK — and the scheduler reads it. Everything this suite
 * claims about metering is ultimately a claim about that column moving by the
 * right amount, for the right tenant, under concurrency. An in-memory `Map`
 * cannot make that claim: it has no other writers, no transaction boundary and
 * no arithmetic anyone else can interleave with.
 *
 * So this file applies `src/control/schema.sql` to a throwaway database and
 * drives the shipped Postgres meter through it. Two things fall out that are
 * worth stating plainly:
 *
 *  - **`x = x + $1` in one statement, not read-then-write.** Two tenants under
 *    concurrent load is the easy case; the same tenant under concurrent load is
 *    where a read-modify-write loses updates silently and the bill is the only
 *    place it shows up.
 *  - **A missing tenant row is a failure, not a no-op.** `UPDATE … WHERE
 *    tenant_id = $1` that matches nothing reports success at the protocol
 *    level. A meter that shrugs at zero rows is an unmetered path with a green
 *    tick on it, which is exactly the shape this unit exists to prevent.
 *
 * Not gated behind `BRAINZ_REAL_SUBSTRATE`: Postgres is always present in the
 * blocking tier (`test/hazards/fixture.ts` sets that precedent), and no model
 * provider is touched — the transport is the fake.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { fleetIdentity } from '../../src/control/secrets.ts';
import { HOSTED_PROFILE, routeFor } from '../../src/ai/routing.ts';
import { CANONICAL_PRICING } from '../../src/ai/pricing.ts';
import { createHostedKeyPool, createInMemoryProviderKeyBackend, createTenantProviderKeyStore } from '../../src/ai/keys.ts';
import {
  createBudget,
  createModelGateway,
  createPostgresSpendMeter,
  type MeteringRecord,
} from '../../src/ai/gateway.ts';
import { CANARY, createControlPlaneFixture, createFakeTransport, type ControlPlaneFixture } from './fixture.ts';

const ALICE = 'alice';
const BOB = 'bob';
const CALLS_PER_TENANT = 12;

let control: ControlPlaneFixture;

beforeAll(async () => {
  control = await createControlPlaneFixture('spend');
  await control.seedTenant(ALICE);
  await control.seedTenant(BOB);
});

afterAll(async () => {
  await control.close();
});

function gatewayOn(fixture: ControlPlaneFixture) {
  const transport = createFakeTransport();
  const gateway = createModelGateway({
    profile: HOSTED_PROFILE,
    transport,
    meter: createPostgresSpendMeter({ sql: fixture.sql }),
    keys: {
      store: createTenantProviderKeyStore({ backend: createInMemoryProviderKeyBackend() }),
      hosted: createHostedKeyPool({ google: 'hosted-google', openai: 'k', cloudflare: 'k' }),
    },
  });
  return { gateway, transport };
}

/** What one seeded `extract` call costs, derived from the canonical table. */
function costOfOneExtract(): number {
  const price = CANONICAL_PRICING.get(routeFor(HOSTED_PROFILE, 'extract').id);
  if (price === undefined || price.outputMicroUsdPerMillion === null) {
    throw new Error('extract is unpriced — the routing guard should have caught this');
  }
  return Math.ceil(
    (1_000 * price.inputMicroUsdPerMillion + 200 * price.outputMicroUsdPerMillion) / 1_000_000,
  );
}

describe('the control-plane spend counter', () => {
  test('cost accrues to the correct tenant under concurrent calls from two', async () => {
    const { gateway } = gatewayOn(control);
    const aliceBudget = createBudget({ label: 'consolidation', capMicroUsd: null });
    const bobBudget = createBudget({ label: 'consolidation', capMicroUsd: null });

    const calls = Array.from({ length: CALLS_PER_TENANT * 2 }, (_, index) => {
      const tenantId = index % 2 === 0 ? ALICE : BOB;
      return gateway.call({
        op: 'extract',
        tenantId,
        caller: fleetIdentity(tenantId),
        budget: tenantId === ALICE ? aliceBudget : bobBudget,
        input: { kind: 'chat', system: 'You extract facts.', user: CANARY },
      });
    });

    const results = await Promise.all(calls);
    for (const result of results) expect(result.ok).toBe(true);

    const expected = BigInt(costOfOneExtract() * CALLS_PER_TENANT);
    expect(await control.spendOf(ALICE)).toBe(expected);
    expect(await control.spendOf(BOB)).toBe(expected);
  });

  test('a call for a tenant with no control-plane row fails rather than vanishing', async () => {
    const { gateway } = gatewayOn(control);
    const result = await gateway.call({
      op: 'extract',
      tenantId: 'ghost',
      caller: fleetIdentity('ghost'),
      budget: createBudget({ label: 'consolidation', capMicroUsd: null }),
      input: { kind: 'chat', user: CANARY },
    });
    expect(result).toMatchObject({ ok: false, reason: 'metering_unavailable' });
  });

  test('an unknown price still finds the row, and still moves nothing', async () => {
    // The self-host case: the call happened and is on the record, but nothing
    // is added to a counter whose units nobody knows.
    const fixture = await createControlPlaneFixture('unpriced');
    try {
      await fixture.seedTenant(ALICE);
      const meter = createPostgresSpendMeter({ sql: fixture.sql });
      const record: MeteringRecord = {
        tenantId: ALICE,
        op: 'salience',
        profile: 'self-host',
        modelId: 'self-host/nemotron-3-120b-a12b',
        provider: 'self-host',
        inputTokens: 1_000,
        outputTokens: 200,
        price: 'unknown',
        costMicroUsd: null,
        keySource: 'hosted',
        countsTowardHostedCogs: false,
        budgetLabel: 'consolidation',
        atMs: Date.now(),
      };
      await meter.record(record);
      expect(await fixture.spendOf(ALICE)).toBe(0n);

      await expect(meter.record({ ...record, tenantId: 'ghost' })).rejects.toThrow();
    } finally {
      await fixture.close();
    }
  });

  test('the counter rolls: a window older than the period starts again at this call', async () => {
    // R14 says *rolling*. A counter that only ever goes up is a cap every
    // tenant eventually hits and never leaves — and rolling it with a separate
    // read-then-write would race the increment and lose a call's cost each
    // time the window turned over.
    const fixture = await createControlPlaneFixture('window');
    try {
      await fixture.seedTenant(ALICE);
      const meter = createPostgresSpendMeter({ sql: fixture.sql, windowSeconds: 60 });
      const record: MeteringRecord = {
        tenantId: ALICE,
        op: 'extract',
        profile: 'hosted',
        modelId: routeFor(HOSTED_PROFILE, 'extract').id,
        provider: 'google',
        inputTokens: 1_000,
        outputTokens: 200,
        price: 'known',
        costMicroUsd: 700,
        keySource: 'hosted',
        countsTowardHostedCogs: true,
        budgetLabel: 'consolidation',
        atMs: Date.now(),
      };

      await meter.record(record);
      await meter.record(record);
      expect(await fixture.spendOf(ALICE)).toBe(1_400n);

      // Age the window past its period. The next call opens a new one carrying
      // its own cost — not zero, and not the old total plus this call.
      await fixture.sql`
        UPDATE control.tenant
           SET spend_window_started_at = now() - interval '2 hours'
         WHERE tenant_id = ${ALICE}
      `;
      await meter.record(record);
      expect(await fixture.spendOf(ALICE)).toBe(700n);

      await meter.record(record);
      expect(await fixture.spendOf(ALICE)).toBe(1_400n);
    } finally {
      await fixture.close();
    }
  });

  test('A BYOK CALL MOVES THE TENANT COUNTER AND NOT HOSTED COGS', async () => {
    // R22, in the one place it can be checked: *"BYOK calls are still metered
    // (for the user's own visibility and their spend cap) but do not count
    // against hosted COGS."*
    //
    // The gateway computed `countsTowardHostedCogs` correctly and handed it to
    // `meter.record`, which read `costMicroUsd`, read `tenantId`, and dropped
    // the flag on the floor. Every store in `src/` kept the first number and
    // none kept the second — so the exclusion existed as an expression and not
    // as a fact anybody could report, which for a COGS number is the same as
    // not having it. Two calls, identical but for who paid.
    const fixture = await createControlPlaneFixture('cogs');
    try {
      await fixture.seedTenant(ALICE);
      const meter = createPostgresSpendMeter({ sql: fixture.sql });
      const base: MeteringRecord = {
        tenantId: ALICE,
        op: 'extract',
        profile: 'hosted',
        modelId: routeFor(HOSTED_PROFILE, 'extract').id,
        provider: 'google',
        inputTokens: 1_000,
        outputTokens: 200,
        price: 'known',
        costMicroUsd: 700,
        keySource: 'hosted',
        countsTowardHostedCogs: true,
        budgetLabel: 'consolidation',
        atMs: Date.now(),
      };

      await meter.record(base);
      expect(await fixture.spendOf(ALICE)).toBe(700n);
      expect(await fixture.hostedCogsOf(ALICE)).toBe(700n);

      // The same call, on the tenant's own key.
      await meter.record({ ...base, keySource: 'byok', countsTowardHostedCogs: false });
      expect(await fixture.spendOf(ALICE)).toBe(1_400n);
      // The user sees their spend; the platform did not pay for it.
      expect(await fixture.hostedCogsOf(ALICE)).toBe(700n);
    } finally {
      await fixture.close();
    }
  });

  test('both counters roll together, or the exclusion drifts a window at a time', async () => {
    // The two numbers are compared against each other, so they have to be true
    // of the *same* window. A COGS column that accumulated forever beside a
    // spend column that resets monthly would read as a hosted margin collapsing
    // every month, entirely as an artifact of the roll.
    const fixture = await createControlPlaneFixture('cogswindow');
    try {
      await fixture.seedTenant(ALICE);
      const meter = createPostgresSpendMeter({ sql: fixture.sql, windowSeconds: 60 });
      const hosted: MeteringRecord = {
        tenantId: ALICE,
        op: 'extract',
        profile: 'hosted',
        modelId: routeFor(HOSTED_PROFILE, 'extract').id,
        provider: 'google',
        inputTokens: 1_000,
        outputTokens: 200,
        price: 'known',
        costMicroUsd: 700,
        keySource: 'hosted',
        countsTowardHostedCogs: true,
        budgetLabel: 'consolidation',
        atMs: Date.now(),
      };

      await meter.record(hosted);
      await meter.record(hosted);
      expect(await fixture.spendOf(ALICE)).toBe(1_400n);
      expect(await fixture.hostedCogsOf(ALICE)).toBe(1_400n);

      await fixture.sql`
        UPDATE control.tenant
           SET spend_window_started_at = now() - interval '2 hours'
         WHERE tenant_id = ${ALICE}
      `;
      // A BYOK call opens the new window. Spend carries this call's cost;
      // hosted COGS carries nothing, and the old window's total is gone from
      // both rather than from one.
      await meter.record({ ...hosted, keySource: 'byok', countsTowardHostedCogs: false });
      expect(await fixture.spendOf(ALICE)).toBe(700n);
      expect(await fixture.hostedCogsOf(ALICE)).toBe(0n);
    } finally {
      await fixture.close();
    }
  });

  test('the counter never goes backwards, and the schema refuses if it tries', async () => {
    const fixture = await createControlPlaneFixture('negative');
    try {
      await fixture.seedTenant(ALICE);
      const meter = createPostgresSpendMeter({ sql: fixture.sql });
      await expect(
        meter.record({
          tenantId: ALICE,
          op: 'extract',
          profile: 'hosted',
          modelId: 'x',
          provider: 'google',
          inputTokens: 1,
          outputTokens: 1,
          price: 'known',
          costMicroUsd: -5,
          keySource: 'hosted',
          countsTowardHostedCogs: true,
          budgetLabel: 'phase',
          atMs: Date.now(),
        }),
      ).rejects.toThrow();
      expect(await fixture.spendOf(ALICE)).toBe(0n);
    } finally {
      await fixture.close();
    }
  });
});
