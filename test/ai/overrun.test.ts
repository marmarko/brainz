/**
 * The overrun suite: **every way a cap is real in a test and decorative in
 * production.**
 *
 * `gateway.test.ts` proves the cap fires. It proves it the way a cap is usually
 * proved — one call at a time, against a provider that answers correctly — and
 * every one of the paths below passes that shape of test while spending without
 * limit. Each is the 53× failure in miniature: no error, no log, a plausible
 * result, and an invoice.
 *
 *  1. **Calls that start together all read the same counter.** A check followed
 *     later by a commit is not a cap; it is a cap divided by the concurrency. A
 *     phase that fans out forty embeds overshoots forty-fold, and nothing in a
 *     sequential test can see it. The estimate has to leave the budget *before*
 *     the transport is touched and be reconciled after — a reservation, not a
 *     lookup.
 *  2. **A call whose cost cannot be computed must still be charged.** A provider
 *     that reports no usage, or one whose price is unknown, spends real money
 *     and returns a typed failure. If that failure leaves the budget where it
 *     found it, the cap can never fire and the loop runs forever. The ledger
 *     must not invent a number for the bill; the *ceiling* must assume the worst
 *     one. Those are different jobs and this suite holds them apart.
 *  3. **A provider that accepted the work and then failed is charged.** A 504
 *     after the model ran is billed by the vendor. Releasing that estimate turns
 *     a flapping provider into an unbounded retry loop under a live cap. A 401
 *     is the opposite case and must NOT be charged, or a misconfigured key
 *     silently eats a phase's budget.
 *  4. **The estimate carries the whole cap for input-only ops.** Chat estimates
 *     are dominated by `maxOutputTokens`, so a badly broken input estimator
 *     still looks correct on a chat op. Embedding and rerank have no output
 *     term: there, the input estimate *is* the cap.
 *  5. **A key the caller brought skips the store, and the store is where the
 *     scope check lives.** The explicit per-call key is the one branch of R22
 *     that never consults the tenant's key store, so it is the one branch where
 *     nothing checks that the caller may spend as this tenant.
 */

import { describe, expect, test } from 'bun:test';

import { fleetIdentity } from '../../src/control/secrets.ts';
import { HOSTED_PROFILE } from '../../src/ai/routing.ts';
import {
  createHostedKeyPool,
  createInMemoryProviderKeyBackend,
  createTenantProviderKeyStore,
  resolveProviderKey,
} from '../../src/ai/keys.ts';
import {
  TransportError,
  createBudget,
  createInMemorySpendMeter,
  createModelGateway,
  type ModelGatewayOptions,
} from '../../src/ai/gateway.ts';
import { CANARY, createFakeTransport } from './fixture.ts';

const ALICE = 'alice';
const BOB = 'bob';

const HOSTED_KEYS = createHostedKeyPool({
  google: 'hosted-google',
  openai: 'hosted-openai',
  cloudflare: 'hosted-cloudflare',
  'self-host': 'hosted-self-host',
});

function emptyKeyStore() {
  return createTenantProviderKeyStore({ backend: createInMemoryProviderKeyBackend() });
}

function gatewayWith(overrides: Partial<ModelGatewayOptions> = {}) {
  const meter = createInMemorySpendMeter();
  const transport = createFakeTransport();
  const gateway = createModelGateway({
    profile: HOSTED_PROFILE,
    transport,
    meter,
    keys: { store: emptyKeyStore(), hosted: HOSTED_KEYS },
    ...overrides,
  });
  return { gateway, meter, transport };
}

const CHAT = { kind: 'chat', system: 'You extract facts.', user: CANARY } as const;

/**
 * A cap with room for exactly one `extract`: the estimate is ~10_246 micro-USD
 * (the 4_096-token output ceiling dominates), so a second call cannot fit.
 * Sized deliberately tight — a generous cap hides the very overshoot under test.
 */
const ONE_EXTRACT = 11_000;

/** Enough attempts that an unbounded loop is unmistakable in the assertion. */
const MANY = 200;

describe('a cap that many calls enter at once', () => {
  test('forty calls starting together do not each read an empty budget', async () => {
    const { gateway, transport } = gatewayWith();
    const budget = createBudget({ label: 'consolidation', capMicroUsd: ONE_EXTRACT });

    const results = await Promise.all(
      Array.from({ length: 40 }, () =>
        gateway.call({
          op: 'extract',
          tenantId: ALICE,
          caller: fleetIdentity(ALICE),
          budget,
          input: CHAT,
        }),
      ),
    );

    // The only observation that separates a real cap from a cap divided by the
    // concurrency: how many calls actually reached the provider.
    expect(transport.calls).toHaveLength(1);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(budget.spentMicroUsd()).toBeLessThanOrEqual(ONE_EXTRACT);
    for (const result of results) {
      if (!result.ok && result.reason !== 'budget_exhausted') {
        throw new Error(`expected budget_exhausted, got ${JSON.stringify(result)}`);
      }
    }
  });

  test('a reservation is given back when the call never happens', async () => {
    // The companion failure: a reservation that is taken and never released
    // turns a cap into a one-shot fuse, and a phase dies after one refusal.
    const { gateway, transport } = gatewayWith();
    const budget = createBudget({ label: 'consolidation', capMicroUsd: ONE_EXTRACT * 4 });

    const denied = await gateway.call({
      op: 'extract',
      tenantId: ALICE,
      caller: fleetIdentity(BOB),
      budget,
      input: CHAT,
    });
    expect(denied).toMatchObject({ ok: false, reason: 'scope_denied' });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await gateway.call({
        op: 'extract',
        tenantId: ALICE,
        caller: fleetIdentity(ALICE),
        budget,
        input: CHAT,
      });
      expect(result.ok, `attempt ${attempt}`).toBe(true);
    }
    expect(transport.calls).toHaveLength(3);
  });
});

describe('a reservation is closed exactly once', () => {
  test('settling and then releasing does not hand the money back', async () => {
    // `Reservation` is public: U11 holds one across a phase, and a caller that
    // settles on the way out of a `try` and releases in a `finally` is an
    // ordinary mistake. Double-closing must be inert, not a refund.
    const budget = createBudget({ label: 'phase', capMicroUsd: 1_000 });
    const reservation = budget.reserve(400);
    if (reservation === null) throw new Error('the first reservation must fit');

    reservation.settle(400);
    reservation.release();
    reservation.settleAtEstimate();

    expect(budget.spentMicroUsd()).toBe(400);
    expect(budget.reservedMicroUsd()).toBe(0);
  });

  test('a budget with no cap still accounts, so a phase can report what it used', async () => {
    const budget = createBudget({ label: 'phase', capMicroUsd: null });
    const reservation = budget.reserve(50);
    if (reservation === null) throw new Error('an uncapped budget refuses nothing');
    reservation.settle(70);
    expect(budget.spentMicroUsd()).toBe(70);
    expect(budget.reservedMicroUsd()).toBe(0);
  });
});

describe('a call whose cost cannot be computed still spends', () => {
  test('a provider that reports no usage cannot be called forever under a cap', async () => {
    const transport = createFakeTransport({ usage: null });
    const { gateway, meter } = gatewayWith({ transport });
    const budget = createBudget({ label: 'consolidation', capMicroUsd: ONE_EXTRACT });

    let exhausted = false;
    for (let attempt = 0; attempt < MANY && !exhausted; attempt += 1) {
      const result = await gateway.call({
        op: 'extract',
        tenantId: ALICE,
        caller: fleetIdentity(ALICE),
        budget,
        input: CHAT,
      });
      exhausted = !result.ok && result.reason === 'budget_exhausted';
    }

    expect(exhausted).toBe(true);
    expect(transport.calls).toHaveLength(1);
    // And the two jobs stay apart: the ceiling assumed the worst, the ledger
    // still refuses to invent a number for the bill.
    expect(meter.records()[0]?.costMicroUsd).toBeNull();
    expect(meter.records()[0]?.price).toBe('unknown');
    expect(budget.spentMicroUsd()).toBeGreaterThan(0);
  });

  test('an unpriced model under no cap still charges nothing it cannot know', async () => {
    // The other direction of the same rule. With no cap there is no ceiling to
    // protect, so nothing is assumed and nothing is invented.
    const { gateway } = gatewayWith();
    const budget = createBudget({ label: 'consolidation', capMicroUsd: null });
    const result = await gateway.call({
      op: 'extract',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget,
      input: CHAT,
    });
    expect(result.ok).toBe(true);
    expect(budget.spentMicroUsd()).toBe(800);
  });
});

describe('a provider that fails after it has done the work', () => {
  test('a 504 is charged, so a flapping provider cannot retry past the cap', async () => {
    const transport = createFakeTransport({ failWith: new TransportError('gateway timeout', 504) });
    const { gateway } = gatewayWith({ transport });
    const budget = createBudget({ label: 'consolidation', capMicroUsd: ONE_EXTRACT });

    let exhausted = false;
    for (let attempt = 0; attempt < MANY && !exhausted; attempt += 1) {
      const result = await gateway.call({
        op: 'extract',
        tenantId: ALICE,
        caller: fleetIdentity(ALICE),
        budget,
        input: CHAT,
      });
      exhausted = !result.ok && result.reason === 'budget_exhausted';
    }

    expect(exhausted).toBe(true);
    expect(transport.calls).toHaveLength(1);
  });

  test('a 401 is not charged, so a bad credential does not eat the phase budget', async () => {
    // The false positive that would make the rule above unusable: a provider
    // that refused the request before running it billed nothing, and charging
    // for it would take a phase down over a config error.
    const transport = createFakeTransport({ failWith: new TransportError('unauthorized', 401) });
    const { gateway } = gatewayWith({ transport });
    const budget = createBudget({ label: 'consolidation', capMicroUsd: ONE_EXTRACT });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await gateway.call({
        op: 'extract',
        tenantId: ALICE,
        caller: fleetIdentity(ALICE),
        budget,
        input: CHAT,
      });
      expect(result).toMatchObject({ ok: false, reason: 'transport_failed' });
    }
    expect(transport.calls).toHaveLength(5);
    expect(budget.spentMicroUsd()).toBe(0);
  });
});

describe('the input estimate is the whole cap for an input-only op', () => {
  test('an embedding whose input alone exceeds the cap is refused before the call', async () => {
    // No output term exists here, so `maxOutputTokens` cannot mask a broken
    // input estimator the way it does on every chat op.
    const { gateway, transport } = gatewayWith();
    const budget = createBudget({ label: 'backfill', capMicroUsd: 5_000 });
    const result = await gateway.call({
      op: 'embedding',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      // ~100_000 tokens at $0.13/M is ~13_000 micro-USD: comfortably over.
      budget,
      input: { kind: 'embedding', texts: ['x'.repeat(400_000)] },
    });

    expect(result).toMatchObject({ ok: false, reason: 'budget_exhausted' });
    expect(transport.calls).toHaveLength(0);
  });

  test('a rerank whose candidate set exceeds the cap is refused before the call', async () => {
    const { gateway, transport } = gatewayWith();
    const budget = createBudget({ label: 'request', capMicroUsd: 2 });
    const result = await gateway.call({
      op: 'rerank',
      tenantId: ALICE,
      caller: fleetIdentity(ALICE),
      budget,
      input: {
        kind: 'rerank',
        query: 'q',
        candidates: Array.from({ length: 200 }, () => 'y'.repeat(20_000)),
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'budget_exhausted' });
    expect(transport.calls).toHaveLength(0);
  });
});

describe('a key the caller brought does not skip the scope check', () => {
  test('an explicit per-call key is refused for a tenant the caller does not serve', async () => {
    // The one R22 branch that never consults the key store — and the store is
    // where the scope check lives. Charged to ALICE, spent by BOB's fleet.
    const resolution = await resolveProviderKey({
      caller: fleetIdentity(BOB),
      tenantId: ALICE,
      provider: 'google',
      explicitKey: 'bobs-own-key',
      store: emptyKeyStore(),
      hosted: HOSTED_KEYS,
    });
    expect(resolution).toMatchObject({ ok: false, reason: 'scope_denied' });
  });

  test('an explicit key for a tenant id that is not one is refused', async () => {
    const resolution = await resolveProviderKey({
      caller: fleetIdentity('../../etc'),
      tenantId: '../../etc',
      provider: 'google',
      explicitKey: 'k',
      store: emptyKeyStore(),
      hosted: HOSTED_KEYS,
    });
    expect(resolution).toMatchObject({ ok: false, reason: 'invalid_tenant_id' });
  });

  test('a scope denial never falls through to the platform credential', async () => {
    // Stated in the module header as a deliberate non-fallback, and until now
    // observable only through the gateway's own duplicate check.
    const store = emptyKeyStore();
    const resolution = await resolveProviderKey({
      caller: fleetIdentity(BOB),
      tenantId: ALICE,
      provider: 'google',
      store,
      hosted: HOSTED_KEYS,
    });
    if (resolution.ok) {
      throw new Error(`a denied caller was handed a '${resolution.resolved.source}' key`);
    }
    expect(resolution.reason).toBe('scope_denied');
  });

  test('a store that denies for its own reasons is not overridden by the pool', async () => {
    // `TenantProviderKeyStore` is a pluggable interface, so a deployment's own
    // backend may refuse a caller this module would have allowed — a per-tenant
    // policy, a revoked fleet, a KMS that says no. That refusal must reach the
    // caller, not be converted into "then use the platform's credential".
    const denying = {
      ...emptyKeyStore(),
      resolve: () => Promise.resolve({ ok: false as const, reason: 'scope_denied' as const }),
    };
    const resolution = await resolveProviderKey({
      caller: fleetIdentity(ALICE),
      tenantId: ALICE,
      provider: 'google',
      store: denying,
      hosted: HOSTED_KEYS,
    });
    if (resolution.ok) {
      throw new Error(`a denied caller was handed a '${resolution.resolved.source}' key`);
    }
    expect(resolution.reason).toBe('scope_denied');
  });

  test('the gateway refuses a mismatched caller even when it carries its own key', async () => {
    const { gateway, transport, meter } = gatewayWith();
    const result = await gateway.call({
      op: 'extract',
      tenantId: ALICE,
      caller: fleetIdentity(BOB),
      budget: createBudget({ label: 'phase', capMicroUsd: null }),
      input: CHAT,
      apiKey: 'bobs-own-key',
    });
    expect(result).toMatchObject({ ok: false, reason: 'scope_denied' });
    expect(transport.calls).toHaveLength(0);
    expect(meter.records()).toHaveLength(0);
  });

  test('an unusable tenant id is refused even when the caller carries its own key', async () => {
    const { gateway, transport } = gatewayWith();
    const result = await gateway.call({
      op: 'extract',
      tenantId: 'not a tenant id',
      caller: fleetIdentity('not a tenant id'),
      budget: createBudget({ label: 'phase', capMicroUsd: null }),
      input: CHAT,
      apiKey: 'k',
    });
    expect(result).toMatchObject({ ok: false, reason: 'invalid_tenant_id' });
    expect(transport.calls).toHaveLength(0);
  });
});
