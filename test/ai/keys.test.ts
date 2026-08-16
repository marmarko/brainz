/**
 * R22's resolution order, and the boundary that makes BYOK safe to offer.
 *
 * The order is fixed: **explicit per-call key → the tenant's stored provider
 * key → the hosted pooled key.** Two properties hang off it, and neither is
 * decided at the tool surface:
 *
 * 1. **A stored provider key is a new secret class**, so it inherits the rules
 *    `src/control/secrets.ts` already established: an explicit caller identity
 *    on every accessor, read and write as separate permissions, per-tenant
 *    namespacing, and a bounded cache that a rotation invalidates rather than
 *    outlives. A key store whose resolve is reachable by any identity other
 *    than the fleet identity serving that tenant is a cross-tenant credential
 *    leak wearing an ordinary function signature.
 *
 * 2. **Hosted COGS is not the same number as the user's spend.** A BYOK call
 *    still meters — the user's cap and their own visibility both need it — but
 *    it is spent on the user's credential, so it must not land in the hosted
 *    cost of goods. That is one boolean, and it is the only thing standing
 *    between a margin model and a fiction.
 *
 * The key itself is treated as radioactive: `ResolvedKey` redacts under
 * `JSON.stringify`, because the one thing every logger, error reporter and
 * metrics sink in the world does to an object is stringify it.
 */

import { describe, expect, test } from 'bun:test';

import {
  adminIdentity,
  controlPlaneIdentity,
  fleetIdentity,
  webAppIdentity,
} from '../../src/control/secrets.ts';
import {
  PROVIDER_IDS,
  createHostedKeyPool,
  createInMemoryProviderKeyBackend,
  createTenantProviderKeyStore,
  resolveProviderKey,
} from '../../src/ai/keys.ts';

const ALICE = 'alice';
const BOB = 'bob';

function storeWith(seed: ReadonlyArray<[string, string, string]> = []) {
  const backend = createInMemoryProviderKeyBackend();
  const store = createTenantProviderKeyStore({ backend });
  return {
    store,
    async seed() {
      for (const [tenantId, provider, key] of seed) {
        const written = await store.put(
          controlPlaneIdentity(),
          tenantId,
          provider as (typeof PROVIDER_IDS)[number],
          key,
        );
        expect(written.ok, `seed ${tenantId}/${provider}`).toBe(true);
      }
    },
  };
}

describe('the provider key store', () => {
  test('only the fleet identity serving this tenant may resolve its key', async () => {
    const { store, seed } = storeWith([[ALICE, 'google', 'alice-google-key']]);
    await seed();

    expect(await store.resolve(fleetIdentity(ALICE), ALICE, 'google')).toEqual({
      ok: true,
      key: 'alice-google-key',
    });

    for (const caller of [
      fleetIdentity(BOB),
      controlPlaneIdentity(),
      adminIdentity(),
      webAppIdentity(),
    ]) {
      expect(await store.resolve(caller, ALICE, 'google'), caller.kind).toEqual({
        ok: false,
        reason: 'scope_denied',
      });
    }
  });

  test('two tenants with different stored keys do not cross-resolve', async () => {
    const { store, seed } = storeWith([
      [ALICE, 'google', 'alice-google-key'],
      [BOB, 'google', 'bob-google-key'],
    ]);
    await seed();

    const alice = await store.resolve(fleetIdentity(ALICE), ALICE, 'google');
    const bob = await store.resolve(fleetIdentity(BOB), BOB, 'google');
    expect(alice).toEqual({ ok: true, key: 'alice-google-key' });
    expect(bob).toEqual({ ok: true, key: 'bob-google-key' });
    // And the cache cannot serve one to the other, in either order.
    expect(await store.resolve(fleetIdentity(ALICE), ALICE, 'google')).toEqual({
      ok: true,
      key: 'alice-google-key',
    });
  });

  test('a key is per provider, not per tenant', async () => {
    const { store, seed } = storeWith([[ALICE, 'google', 'alice-google-key']]);
    await seed();
    expect(await store.resolve(fleetIdentity(ALICE), ALICE, 'openai')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  test('writing is the control plane, and only the control plane', async () => {
    const { store } = storeWith();
    for (const caller of [fleetIdentity(ALICE), adminIdentity(), webAppIdentity()]) {
      expect(await store.put(caller, ALICE, 'google', 'k'), caller.kind).toEqual({
        ok: false,
        reason: 'scope_denied',
      });
    }
    expect(await store.put(controlPlaneIdentity(), ALICE, 'google', 'k')).toEqual({ ok: true });
  });

  test('an unusable tenant id is a typed refusal, not a namespace', async () => {
    const { store } = storeWith();
    for (const bad of ['../bob', 'Alice', '', 'a/b']) {
      expect(await store.put(controlPlaneIdentity(), bad, 'google', 'k'), bad).toEqual({
        ok: false,
        reason: 'invalid_tenant_id',
      });
    }
  });

  test('revocation is immediate, and R12 can erase every provider at once', async () => {
    const { store, seed } = storeWith([
      [ALICE, 'google', 'alice-google-key'],
      [ALICE, 'openai', 'alice-openai-key'],
    ]);
    await seed();
    // Warm the cache first: a revocation that a cache outlives is the bug.
    await store.resolve(fleetIdentity(ALICE), ALICE, 'google');

    expect(await store.revokeAll(controlPlaneIdentity(), ALICE)).toEqual({ ok: true });
    for (const provider of ['google', 'openai'] as const) {
      expect(await store.resolve(fleetIdentity(ALICE), ALICE, provider), provider).toEqual({
        ok: false,
        reason: 'not_found',
      });
    }
  });

  test('rotation invalidates the cache in the same operation', async () => {
    const { store, seed } = storeWith([[ALICE, 'google', 'old']]);
    await seed();
    await store.resolve(fleetIdentity(ALICE), ALICE, 'google');
    await store.put(controlPlaneIdentity(), ALICE, 'google', 'new');
    expect(await store.resolve(fleetIdentity(ALICE), ALICE, 'google')).toEqual({
      ok: true,
      key: 'new',
    });
  });
});

describe('R22 resolution order', () => {
  const hosted = createHostedKeyPool({ google: 'hosted-google', openai: 'hosted-openai' });

  test('an explicit per-call key wins, and is not hosted COGS', async () => {
    const { store, seed } = storeWith([[ALICE, 'google', 'alice-google-key']]);
    await seed();

    const resolution = await resolveProviderKey({
      caller: fleetIdentity(ALICE),
      tenantId: ALICE,
      provider: 'google',
      explicitKey: 'per-call-key',
      store,
      hosted,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.resolved.key).toBe('per-call-key');
    expect(resolution.resolved.source).toBe('per-call');
    expect(resolution.resolved.countsTowardHostedCogs).toBe(false);
  });

  test("the tenant's stored key beats the hosted pool, and is not hosted COGS", async () => {
    const { store, seed } = storeWith([[ALICE, 'google', 'alice-google-key']]);
    await seed();

    const resolution = await resolveProviderKey({
      caller: fleetIdentity(ALICE),
      tenantId: ALICE,
      provider: 'google',
      store,
      hosted,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.resolved.key).toBe('alice-google-key');
    expect(resolution.resolved.source).toBe('byok');
    expect(resolution.resolved.countsTowardHostedCogs).toBe(false);
  });

  test('the hosted pool is the floor, and only it counts as hosted COGS', async () => {
    const { store } = storeWith();
    const resolution = await resolveProviderKey({
      caller: fleetIdentity(BOB),
      tenantId: BOB,
      provider: 'google',
      store,
      hosted,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.resolved.key).toBe('hosted-google');
    expect(resolution.resolved.source).toBe('hosted');
    expect(resolution.resolved.countsTowardHostedCogs).toBe(true);
  });

  test('no key anywhere is a typed refusal, never an unauthenticated call', async () => {
    const { store } = storeWith();
    const resolution = await resolveProviderKey({
      caller: fleetIdentity(ALICE),
      tenantId: ALICE,
      provider: 'self-host',
      store,
      hosted,
    });
    expect(resolution).toEqual({ ok: false, reason: 'no_key_available' });
  });

  test('a store failure is not flattened into "this tenant has no key"', async () => {
    // "The store is down" and "resolve the hosted pooled key instead" are
    // different answers, and silently choosing the second bills the platform
    // for a call the user was supposed to pay for.
    const failing = {
      // A store that has no cache still declares the window it serves from, so
      // R12's receipt has a number to carry for every implementation.
      cacheWindowMs: 0,
      resolve() {
        return Promise.reject(new Error('secret store unreachable'));
      },
      put() {
        return Promise.resolve({ ok: true } as const);
      },
      revoke() {
        return Promise.resolve({ ok: true } as const);
      },
      revokeAll() {
        return Promise.resolve({ ok: true } as const);
      },
    };
    await expect(
      resolveProviderKey({
        caller: fleetIdentity(ALICE),
        tenantId: ALICE,
        provider: 'google',
        store: failing,
        hosted,
      }),
    ).rejects.toThrow('secret store unreachable');
  });

  test('a resolved key redacts itself when stringified', async () => {
    const { store } = storeWith();
    const resolution = await resolveProviderKey({
      caller: fleetIdentity(ALICE),
      tenantId: ALICE,
      provider: 'openai',
      store,
      hosted,
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.resolved.key).toBe('hosted-openai');
    expect(JSON.stringify(resolution.resolved)).not.toContain('hosted-openai');
    expect(JSON.stringify({ nested: resolution })).not.toContain('hosted-openai');
  });

  test('every provider the routing table can name is a provider the pool can hold', () => {
    expect([...PROVIDER_IDS].sort()).toEqual(['cloudflare', 'google', 'openai', 'self-host']);
  });
});
