/**
 * The secret store is where R11's boundary is actually decided.
 *
 * R11's CI case asserts `scope_denied` on `recall` for the `/admin` credential.
 * That proves nothing on its own: secret resolution bypasses tool dispatch
 * entirely, so a credential that cannot call `recall` but *can* read a tenant's
 * connection string simply connects to the database directly. These tests are
 * the half of R11 the tool surface cannot enforce.
 */

import { beforeEach, describe, expect, test } from 'bun:test';

import {
  adminIdentity,
  controlPlaneIdentity,
  createInMemorySecretBackend,
  createTenantSecretStore,
  fleetIdentity,
  tenantNamespace,
  webAppIdentity,
  type SecretBackend,
  type TenantSecret,
  type TenantSecretStore,
} from '../../src/control/secrets.ts';

const SECRET_A: TenantSecret = {
  connectionString: 'postgres://tenant-a:pw-a@ep-a.example.neon.tech/brainz',
  bearerGrant: 'grant-a',
};

const SECRET_B: TenantSecret = {
  connectionString: 'postgres://tenant-b:pw-b@ep-b.example.neon.tech/brainz',
  bearerGrant: 'grant-b',
};

const TTL_MS = 60_000;

/** Records every namespace the store actually asked the backend for. */
interface ObservedBackend extends SecretBackend {
  readonly reads: string[];
}

function observe(inner: SecretBackend): ObservedBackend {
  const reads: string[] = [];
  return {
    reads,
    get: async (namespace) => {
      reads.push(namespace);
      return inner.get(namespace);
    },
    put: (namespace, secret) => inner.put(namespace, secret),
    delete: (namespace) => inner.delete(namespace),
  };
}

describe('tenant secret store', () => {
  let clockMs: number;
  let inner: SecretBackend;
  let backend: ObservedBackend;
  let store: TenantSecretStore;

  beforeEach(async () => {
    clockMs = 1_000;
    inner = createInMemorySecretBackend();
    backend = observe(inner);
    store = createTenantSecretStore({
      backend,
      ttlMs: TTL_MS,
      now: () => clockMs,
    });

    await store.put(controlPlaneIdentity(), 'tenant-a', SECRET_A);
    await store.put(controlPlaneIdentity(), 'tenant-b', SECRET_B);
  });

  describe('per-tenant namespacing', () => {
    test('two tenants with different stored values do not cross-resolve', async () => {
      const a = await store.resolve(fleetIdentity('tenant-a'), 'tenant-a');
      const b = await store.resolve(fleetIdentity('tenant-b'), 'tenant-b');

      expect(a).toEqual({ ok: true, secret: SECRET_A });
      expect(b).toEqual({ ok: true, secret: SECRET_B });
    });

    test('a fleet identity serving tenant A cannot resolve tenant B', async () => {
      const crossed = await store.resolve(fleetIdentity('tenant-a'), 'tenant-b');

      expect(crossed).toEqual({ ok: false, reason: 'scope_denied' });
    });

    test('a cross-tenant resolve never reaches the backend', async () => {
      backend.reads.length = 0;
      await store.resolve(fleetIdentity('tenant-a'), 'tenant-b');

      expect(backend.reads).toEqual([]);
    });

    test('entries live under a per-tenant namespace', async () => {
      backend.reads.length = 0;
      await store.resolve(fleetIdentity('tenant-a'), 'tenant-a');

      expect(backend.reads).toEqual([tenantNamespace('tenant-a')]);
      expect(tenantNamespace('tenant-a')).not.toBe(tenantNamespace('tenant-b'));
    });
  });

  describe('the /admin and web-app identities hold no resolve permission', () => {
    test('admin cannot resolve any tenant connection string or bearer', async () => {
      for (const tenantId of ['tenant-a', 'tenant-b']) {
        const result = await store.resolve(adminIdentity(), tenantId);

        expect(result).toEqual({ ok: false, reason: 'scope_denied' });
      }
    });

    test('the web-app identity cannot resolve either', async () => {
      const result = await store.resolve(webAppIdentity(), 'tenant-a');

      expect(result).toEqual({ ok: false, reason: 'scope_denied' });
    });

    test('the control plane can write but cannot resolve', async () => {
      const result = await store.resolve(controlPlaneIdentity(), 'tenant-a');

      expect(result).toEqual({ ok: false, reason: 'scope_denied' });
    });

    test('a warm cache does not open a side door for admin', async () => {
      // Warm the entry through a permitted caller first, then re-ask as admin.
      // A cache consulted before the scope check would answer this.
      await store.resolve(fleetIdentity('tenant-a'), 'tenant-a');
      backend.reads.length = 0;

      const result = await store.resolve(adminIdentity(), 'tenant-a');

      expect(result).toEqual({ ok: false, reason: 'scope_denied' });
      expect(backend.reads).toEqual([]);
    });

    test('admin cannot write or revoke a tenant entry', async () => {
      const written = await store.put(adminIdentity(), 'tenant-a', SECRET_B);
      const revoked = await store.revoke(adminIdentity(), 'tenant-a');

      expect(written).toEqual({ ok: false, reason: 'scope_denied' });
      expect(revoked).toEqual({ ok: false, reason: 'scope_denied' });
      expect(await inner.get(tenantNamespace('tenant-a'))).toEqual(SECRET_A);
    });

    test('a fleet identity cannot write or revoke, even its own tenant', async () => {
      const written = await store.put(fleetIdentity('tenant-a'), 'tenant-a', SECRET_B);
      const revoked = await store.revoke(fleetIdentity('tenant-a'), 'tenant-a');

      expect(written).toEqual({ ok: false, reason: 'scope_denied' });
      expect(revoked).toEqual({ ok: false, reason: 'scope_denied' });
      expect(await inner.get(tenantNamespace('tenant-a'))).toEqual(SECRET_A);
    });
  });

  describe('revocation outruns the cache', () => {
    test('a revoked entry is not served from cache afterwards', async () => {
      const warm = await store.resolve(fleetIdentity('tenant-a'), 'tenant-a');
      expect(warm).toEqual({ ok: true, secret: SECRET_A });

      await store.revoke(controlPlaneIdentity(), 'tenant-a');

      // Same instant — the TTL has not moved. A cache that outlives a
      // revocation is the security bug this test exists to prevent.
      const after = await store.resolve(fleetIdentity('tenant-a'), 'tenant-a');

      expect(after).toEqual({ ok: false, reason: 'not_found' });
    });

    test('revocation does not disturb another tenant', async () => {
      await store.resolve(fleetIdentity('tenant-b'), 'tenant-b');
      await store.revoke(controlPlaneIdentity(), 'tenant-a');

      const b = await store.resolve(fleetIdentity('tenant-b'), 'tenant-b');

      expect(b).toEqual({ ok: true, secret: SECRET_B });
    });

    test('an out-of-band rotation is picked up once invalidation is called', async () => {
      await store.resolve(fleetIdentity('tenant-a'), 'tenant-a');

      // A rotation performed against the store directly (another process,
      // the rotation owner's runbook) leaves this instance's cache stale.
      await inner.put(tenantNamespace('tenant-a'), SECRET_B);
      expect(await store.resolve(fleetIdentity('tenant-a'), 'tenant-a')).toEqual({
        ok: true,
        secret: SECRET_A,
      });

      await store.invalidate(controlPlaneIdentity(), 'tenant-a');

      expect(await store.resolve(fleetIdentity('tenant-a'), 'tenant-a')).toEqual({
        ok: true,
        secret: SECRET_B,
      });
    });

    test('a rewrite through the store invalidates the cached value', async () => {
      await store.resolve(fleetIdentity('tenant-a'), 'tenant-a');
      await store.put(controlPlaneIdentity(), 'tenant-a', SECRET_B);

      expect(await store.resolve(fleetIdentity('tenant-a'), 'tenant-a')).toEqual({
        ok: true,
        secret: SECRET_B,
      });
    });

    test('admin cannot invalidate', async () => {
      expect(await store.invalidate(adminIdentity(), 'tenant-a')).toEqual({
        ok: false,
        reason: 'scope_denied',
      });
    });
  });

  describe('the cache is bounded in time', () => {
    test('a cached entry is served without a backend read inside the TTL', async () => {
      await store.resolve(fleetIdentity('tenant-a'), 'tenant-a');
      backend.reads.length = 0;

      clockMs += TTL_MS - 1;
      await store.resolve(fleetIdentity('tenant-a'), 'tenant-a');

      expect(backend.reads).toEqual([]);
    });

    test('the entry is re-read from the backend once the TTL lapses', async () => {
      await store.resolve(fleetIdentity('tenant-a'), 'tenant-a');
      await inner.put(tenantNamespace('tenant-a'), SECRET_B);

      clockMs += TTL_MS + 1;
      const after = await store.resolve(fleetIdentity('tenant-a'), 'tenant-a');

      expect(after).toEqual({ ok: true, secret: SECRET_B });
    });
  });

  describe('a miss is typed, not thrown and not another tenant', () => {
    test('an unknown tenant resolves to a typed miss', async () => {
      const result = await store.resolve(fleetIdentity('tenant-zzz'), 'tenant-zzz');

      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });

    test('an unknown tenant never yields a stored value', async () => {
      // Warm both real tenants first, so a cache keyed on anything weaker than
      // the tenant namespace would have something wrong to hand back.
      await store.resolve(fleetIdentity('tenant-a'), 'tenant-a');
      await store.resolve(fleetIdentity('tenant-b'), 'tenant-b');

      const result = await store.resolve(fleetIdentity('tenant-zzz'), 'tenant-zzz');

      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('pw-a');
      expect(JSON.stringify(result)).not.toContain('pw-b');
    });

    test('a miss is not cached, so provisioning is visible immediately', async () => {
      expect(await store.resolve(fleetIdentity('tenant-c'), 'tenant-c')).toEqual({
        ok: false,
        reason: 'not_found',
      });

      await store.put(controlPlaneIdentity(), 'tenant-c', SECRET_A);

      expect(await store.resolve(fleetIdentity('tenant-c'), 'tenant-c')).toEqual({
        ok: true,
        secret: SECRET_A,
      });
    });

    test('a malformed tenant id is rejected rather than joined into a namespace', async () => {
      for (const bad of ['', '../tenant-a', 'tenant-a/../tenant-b', 'TENANT A']) {
        const result = await store.resolve(fleetIdentity(bad), bad);

        expect(result).toEqual({ ok: false, reason: 'invalid_tenant_id' });
      }
    });

    test('scope denial outranks a malformed id, so denial leaks nothing', async () => {
      const result = await store.resolve(adminIdentity(), '../tenant-a');

      expect(result).toEqual({ ok: false, reason: 'scope_denied' });
    });
  });

  describe('the resolved secret cannot be mutated through the cache', () => {
    test('a caller mutating its copy does not poison the next resolve', async () => {
      const first = await store.resolve(fleetIdentity('tenant-a'), 'tenant-a');
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      expect(() => {
        (first.secret as { connectionString: string }).connectionString = 'postgres://attacker/';
      }).toThrow();

      const second = await store.resolve(fleetIdentity('tenant-a'), 'tenant-a');
      expect(second).toEqual({ ok: true, secret: SECRET_A });
    });
  });
});
