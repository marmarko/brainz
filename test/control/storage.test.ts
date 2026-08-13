/**
 * The storage accessor is where R9's file-storage claim is actually decided.
 *
 * R9 now reads: the R2 boundary is **platform-enforced, conditional on correct
 * prefix derivation**. The conditional is the whole reason this file exists.
 * `scripts/probes/r2-boundary/RESULT.md` measured it: R2 matches `prefixes`
 * LITERALLY, so a credential scoped to `tenant-a` read `tenant-abc/` at HTTP 200
 * and the body was the sibling tenant's fixture. The platform enforces the
 * string it was given; it does not enforce a boundary at the separator.
 *
 * So the assertion that matters here is the **sibling** case — `alice` must not
 * reach `alice2/`. A test comparing `alice` against `bob` passes while the
 * hazard is live, because `bob` shares no leading substring with `alice`. Every
 * cross-tenant test below therefore uses a sibling, not a stranger.
 *
 * No network, no credentials, no live R2. The minter is behind an interface with
 * an in-memory fake, exactly as `secrets.ts` does for its backend, and the
 * object store is a local fake that enforces scope the way R2 was measured to —
 * by literal `startsWith` — so a missing terminator fails these tests the same
 * way it would fail in production.
 */

import { beforeEach, describe, expect, test } from 'bun:test';

import {
  adminIdentity,
  controlPlaneIdentity,
  fleetIdentity,
  webAppIdentity,
} from '../../src/control/secrets.ts';
import {
  createInMemoryCredentialMinter,
  createTenantStorage,
  hashUntrustedSegment,
  prefixCovers,
  type KeyFailureReason,
  type KeyResult,
  type MintRequest,
  type ObjectKey,
  type PrefixResult,
  type ScopedCredential,
  type ScopedCredentialMinter,
  type TenantPrefix,
  type TenantStorage,
} from '../../src/control/storage.ts';

/**
 * Obviously-fake credential material. The repo is public and gitleaks runs in
 * CI, so nothing here is shaped like a real key id, account id, bucket name or
 * endpoint host.
 */
const PARENT_ACCESS_KEY_ID = 'parent-key-id-fake';
const PARENT_SECRET_ACCESS_KEY = 'parent-secret-fake-do-not-use';

/** Siblings by construction: one id is a strict prefix of the other. */
const TENANT = 'alice';
const SIBLING = 'alice2';

const CREDENTIAL_TTL_SECONDS = 900;
const CACHE_TTL_MS = 300_000;

interface RecordingMinter extends ScopedCredentialMinter {
  readonly requests: MintRequest[];
}

function record(inner: ScopedCredentialMinter): RecordingMinter {
  const requests: MintRequest[] = [];
  return {
    requests,
    mint: (request) => {
      requests.push(request);
      return inner.mint(request);
    },
  };
}

/**
 * The object store fake, modelling R2's MEASURED semantics and nothing kinder:
 * access is a literal `startsWith` against the credential's prefix. If the
 * accessor ever hands out an unterminated prefix, this fake grants the sibling
 * exactly as the real platform did in the probe run.
 */
type StoreResult =
  | { readonly ok: true; readonly status: 200; readonly body: string }
  | { readonly ok: false; readonly status: 403 | 404 };

interface LiteralPrefixStore {
  seed(key: string, body: string): void;
  get(credential: ScopedCredential, key: string): StoreResult;
  put(credential: ScopedCredential, key: string, body: string): StoreResult;
}

function createLiteralPrefixStore(): LiteralPrefixStore {
  const objects = new Map<string, string>();

  return {
    seed(key, body) {
      objects.set(key, body);
    },
    get(credential, key) {
      if (!key.startsWith(credential.prefix)) return { ok: false, status: 403 };
      const body = objects.get(key);
      if (body === undefined) return { ok: false, status: 404 };
      return { ok: true, status: 200, body };
    },
    put(credential, key, body) {
      if (credential.permission !== 'object-read-write') return { ok: false, status: 403 };
      if (!key.startsWith(credential.prefix)) return { ok: false, status: 403 };
      objects.set(key, body);
      return { ok: true, status: 200, body };
    },
  };
}

function unwrapPrefix(result: PrefixResult): TenantPrefix {
  if (!result.ok) throw new Error(`expected a prefix, got ${result.reason}`);
  return result.prefix;
}

function unwrapKey(result: KeyResult): ObjectKey {
  if (!result.ok) throw new Error(`expected a key, got ${result.reason}`);
  return result.key;
}

function unwrapCredential(
  result: Awaited<ReturnType<TenantStorage['credentialFor']>>,
): ScopedCredential {
  if (!result.ok) throw new Error(`expected a credential, got ${result.reason}`);
  return result.credential;
}

describe('tenant storage accessor', () => {
  let clockMs: number;
  let minter: RecordingMinter;
  let storage: TenantStorage;
  let store: LiteralPrefixStore;

  beforeEach(() => {
    clockMs = 1_000_000;
    minter = record(
      createInMemoryCredentialMinter({
        parentAccessKeyId: PARENT_ACCESS_KEY_ID,
        parentSecretAccessKey: PARENT_SECRET_ACCESS_KEY,
        now: () => clockMs,
      }),
    );
    storage = createTenantStorage({
      minter,
      credentialTtlSeconds: CREDENTIAL_TTL_SECONDS,
      cacheTtlMs: CACHE_TTL_MS,
      now: () => clockMs,
    });
    store = createLiteralPrefixStore();
  });

  describe('every derived prefix terminates with a separator', () => {
    test('a prefix ends in exactly one separator, for every valid id', () => {
      for (const tenantId of [TENANT, SIBLING, 'a', 'tenant-0', 'x'.repeat(63)]) {
        const prefix = unwrapPrefix(storage.prefixFor(fleetIdentity(tenantId), tenantId));

        expect(prefix.endsWith('/')).toBe(true);
        expect(prefix.endsWith('//')).toBe(false);
        expect(prefix).toContain(tenantId);
      }
    });

    test('an id that already ends in a separator is rejected, never normalised', () => {
      // Append-if-missing would alias `alice/` and `alice` onto one prefix: two
      // accepted ids, one keyspace. Rejecting keeps the mapping injective.
      const result = storage.prefixFor(fleetIdentity(`${TENANT}/`), `${TENANT}/`);

      expect(result).toEqual({ ok: false, reason: 'invalid_tenant_id' });
    });

    test('a traversal-shaped id never becomes a prefix', () => {
      for (const bad of ['', '../alice', 'alice/../alice2', 'ALICE', 'alice ', '.']) {
        expect(storage.prefixFor(fleetIdentity(bad), bad)).toEqual({
          ok: false,
          reason: 'invalid_tenant_id',
        });
      }
    });

    test('a derived key always sits under the derived prefix', () => {
      const prefix = unwrapPrefix(storage.prefixFor(fleetIdentity(TENANT), TENANT));
      const key = unwrapKey(storage.keyFor(fleetIdentity(TENANT), TENANT, ['notes', 'a.md']));

      expect(key.startsWith(prefix)).toBe(true);
      expect(prefixCovers(prefix, key)).toBe(true);
    });
  });

  describe('THE sibling case — alice must not reach alice2', () => {
    /**
     * WHY A SIBLING AND NOT A STRANGER. R2 matches `prefixes` literally: in the
     * probe run a credential scoped to `tenant-a` read `tenant-abc/` at HTTP 200.
     * `alice` vs `bob` cannot detect that — `bob` shares no leading substring, so
     * that pairing passes whether or not the terminator is present. `alice` vs
     * `alice2` is the only pairing that fails when the terminator is dropped.
     */
    test('a credential derived for alice does not grant the sibling prefix', async () => {
      const credential = unwrapCredential(await storage.credentialFor(fleetIdentity(TENANT), TENANT));
      const siblingKey = unwrapKey(
        storage.keyFor(fleetIdentity(SIBLING), SIBLING, ['notes', 'secret.md']),
      );
      store.seed(siblingKey, 'the sibling tenant fixture');

      expect(store.get(credential, siblingKey)).toEqual({ ok: false, status: 403 });
    });

    test('nor may it write into the sibling prefix', async () => {
      const credential = unwrapCredential(await storage.credentialFor(fleetIdentity(TENANT), TENANT));
      const siblingKey = unwrapKey(storage.keyFor(fleetIdentity(SIBLING), SIBLING, ['x.md']));

      expect(store.put(credential, siblingKey, 'landed')).toEqual({ ok: false, status: 403 });
      expect(store.get(credential, siblingKey)).toEqual({ ok: false, status: 403 });
    });

    test('positive control: the credential does read its own object', async () => {
      // A boundary that denies everything proves nothing. The probe ran this
      // control for the same reason.
      const credential = unwrapCredential(await storage.credentialFor(fleetIdentity(TENANT), TENANT));
      const ownKey = unwrapKey(storage.keyFor(fleetIdentity(TENANT), TENANT, ['notes', 'a.md']));
      store.seed(ownKey, 'own fixture');

      expect(store.get(credential, ownKey)).toEqual({ ok: true, status: 200, body: 'own fixture' });
    });

    test("the guard's own model: dropping the terminator WOULD reach the sibling", () => {
      // Guards the guard. If this ever fails, the fake stopped modelling the
      // measured platform and every denial above became vacuous.
      const prefix = unwrapPrefix(storage.prefixFor(fleetIdentity(TENANT), TENANT));
      const unterminated = prefix.slice(0, -1);
      const siblingKey = unwrapKey(storage.keyFor(fleetIdentity(SIBLING), SIBLING, ['x.md']));

      expect(siblingKey.startsWith(unterminated)).toBe(true);
      expect(prefixCovers(prefix, siblingKey)).toBe(false);
    });

    test('two tenants derive prefixes neither of which covers the other', () => {
      const a = unwrapPrefix(storage.prefixFor(fleetIdentity(TENANT), TENANT));
      const b = unwrapPrefix(storage.prefixFor(fleetIdentity(SIBLING), SIBLING));

      expect(a).not.toBe(b);
      expect(prefixCovers(a, b)).toBe(false);
      expect(prefixCovers(b, a)).toBe(false);
    });
  });

  describe('the caller-supplied remainder is validated, not sanitised', () => {
    const cases: ReadonlyArray<readonly [string, KeyFailureReason]> = [
      ['notes/secret.md', 'separator_in_segment'],
      ['..', 'traversal_in_segment'],
      ['../alice2', 'separator_in_segment'],
      ['..\\alice2', 'separator_in_segment'],
      ['a..b', 'traversal_in_segment'],
      ['%2f', 'encoded_separator'],
      ['%2F', 'encoded_separator'],
      ['%5c', 'encoded_separator'],
      ['..%2falice2', 'encoded_separator'],
      ['%252f', 'encoded_separator'],
      ['%25252f', 'encoded_separator'],
      ['%2e%2e', 'traversal_in_segment'],
      ['%2E%2E%2Falice2', 'encoded_separator'],
      ['', 'empty_segment'],
      ['a b', 'illegal_character'],
      ['a b', 'illegal_character'],
      ['réunion', 'illegal_character'],
      ['.hidden', 'illegal_character'],
      ['%', 'illegal_character'],
      ['x'.repeat(129), 'segment_too_long'],
    ];

    for (const [segment, reason] of cases) {
      test(`rejects ${JSON.stringify(segment)} as ${reason}`, () => {
        expect(storage.keyFor(fleetIdentity(TENANT), TENANT, [segment])).toEqual({
          ok: false,
          reason,
        });
      });
    }

    test('an empty remainder is rejected rather than yielding the bare prefix', () => {
      expect(storage.keyFor(fleetIdentity(TENANT), TENANT, [])).toEqual({
        ok: false,
        reason: 'empty_remainder',
      });
    });

    test('a hostile segment anywhere in the remainder is rejected', () => {
      expect(storage.keyFor(fleetIdentity(TENANT), TENANT, ['notes', '../../etc', 'a.md'])).toEqual(
        { ok: false, reason: 'separator_in_segment' },
      );
    });

    test('an over-long key is rejected even when every segment is legal', () => {
      const many = Array.from({ length: 32 }, () => 'x'.repeat(64));

      expect(storage.keyFor(fleetIdentity(TENANT), TENANT, many)).toEqual({
        ok: false,
        reason: 'key_too_long',
      });
    });

    test('an ordinary remainder is accepted', () => {
      const key = unwrapKey(
        storage.keyFor(fleetIdentity(TENANT), TENANT, ['attachments', 'report-v2.pdf']),
      );

      expect(key as string).toBe(
        `${unwrapPrefix(storage.prefixFor(fleetIdentity(TENANT), TENANT))}attachments/report-v2.pdf`,
      );
    });

    test('no crafted remainder can produce a key the sibling credential could serve', async () => {
      const credential = unwrapCredential(await storage.credentialFor(fleetIdentity(TENANT), TENANT));
      const hostile = [
        '../alice2',
        '..%2falice2',
        '%2e%2e%2falice2',
        '....//alice2',
        'alice2',
      ];

      for (const segment of hostile) {
        const result = storage.keyFor(fleetIdentity(TENANT), TENANT, [segment]);
        if (!result.ok) continue;
        // Anything that IS accepted must still land under this tenant's prefix.
        expect(prefixCovers(credential.prefix, result.key)).toBe(true);
      }
    });
  });

  describe('untrusted ids are hashed, not sanitised', () => {
    test('an id containing a traversal still yields a key inside the prefix', async () => {
      const credential = unwrapCredential(await storage.credentialFor(fleetIdentity(TENANT), TENANT));
      const key = unwrapKey(
        storage.keyForUntrusted(fleetIdentity(TENANT), TENANT, 'attachments', '../../alice2/x.md'),
      );

      expect(prefixCovers(credential.prefix, key)).toBe(true);
      expect(key).not.toContain('..');
      expect(key).not.toContain('alice2');
    });

    test('the raw untrusted id never appears in the key', () => {
      const raw = 'Q3-board-deck FINAL (2).pdf';
      const key = unwrapKey(
        storage.keyForUntrusted(fleetIdentity(TENANT), TENANT, 'attachments', raw),
      );

      expect(key).not.toContain(raw);
      expect(key).not.toContain('board');
    });

    test('the hash is stable for one input and separates two inputs', () => {
      const first = unwrapKey(
        storage.keyForUntrusted(fleetIdentity(TENANT), TENANT, 'attachments', 'file-a'),
      );
      const again = unwrapKey(
        storage.keyForUntrusted(fleetIdentity(TENANT), TENANT, 'attachments', 'file-a'),
      );
      const other = unwrapKey(
        storage.keyForUntrusted(fleetIdentity(TENANT), TENANT, 'attachments', 'file-b'),
      );

      expect(again).toBe(first);
      expect(other).not.toBe(first);
      expect(hashUntrustedSegment('file-a')).toBe(hashUntrustedSegment('file-a'));
      expect(hashUntrustedSegment('file-a')).not.toBe(hashUntrustedSegment('file-b'));
    });

    test('the collection segment is validated the same way caller input is', () => {
      expect(
        storage.keyForUntrusted(fleetIdentity(TENANT), TENANT, '../alice2', 'file-a'),
      ).toEqual({ ok: false, reason: 'separator_in_segment' });
    });

    test('an empty untrusted id is rejected rather than hashed into a stable key', () => {
      expect(storage.keyForUntrusted(fleetIdentity(TENANT), TENANT, 'attachments', '')).toEqual({
        ok: false,
        reason: 'empty_segment',
      });
    });
  });

  describe('scope: only the fleet identity serving this tenant', () => {
    test('the admin, web-app and control-plane identities get no credential', async () => {
      for (const caller of [adminIdentity(), webAppIdentity(), controlPlaneIdentity()]) {
        expect(await storage.credentialFor(caller, TENANT)).toEqual({
          ok: false,
          reason: 'scope_denied',
        });
      }
    });

    test('a fleet identity for the sibling cannot obtain this tenant credential', async () => {
      expect(await storage.credentialFor(fleetIdentity(SIBLING), TENANT)).toEqual({
        ok: false,
        reason: 'scope_denied',
      });
    });

    test('nor derive this tenant prefix or key', () => {
      expect(storage.prefixFor(fleetIdentity(SIBLING), TENANT)).toEqual({
        ok: false,
        reason: 'scope_denied',
      });
      expect(storage.keyFor(fleetIdentity(SIBLING), TENANT, ['a.md'])).toEqual({
        ok: false,
        reason: 'scope_denied',
      });
      expect(storage.keyForUntrusted(fleetIdentity(SIBLING), TENANT, 'attachments', 'x')).toEqual({
        ok: false,
        reason: 'scope_denied',
      });
    });

    test('scope denial outranks a malformed id, so denial leaks nothing', async () => {
      expect(storage.prefixFor(adminIdentity(), '../alice')).toEqual({
        ok: false,
        reason: 'scope_denied',
      });
      expect(await storage.credentialFor(adminIdentity(), '../alice')).toEqual({
        ok: false,
        reason: 'scope_denied',
      });
    });

    test('a denied caller never reaches the minter', async () => {
      minter.requests.length = 0;
      await storage.credentialFor(adminIdentity(), TENANT);
      await storage.credentialFor(fleetIdentity(SIBLING), TENANT);

      expect(minter.requests).toEqual([]);
    });

    test('two tenants credentials do not cross-resolve', async () => {
      const a = unwrapCredential(await storage.credentialFor(fleetIdentity(TENANT), TENANT));
      const b = unwrapCredential(await storage.credentialFor(fleetIdentity(SIBLING), SIBLING));

      expect(a.prefix).not.toBe(b.prefix);
      expect(a.sessionToken).not.toBe(b.sessionToken);
      expect(a.secretAccessKey).not.toBe(b.secretAccessKey);

      const aKey = unwrapKey(storage.keyFor(fleetIdentity(TENANT), TENANT, ['a.md']));
      const bKey = unwrapKey(storage.keyFor(fleetIdentity(SIBLING), SIBLING, ['a.md']));
      store.seed(aKey, 'a');
      store.seed(bKey, 'b');

      expect(store.get(a, bKey)).toEqual({ ok: false, status: 403 });
      expect(store.get(b, aKey)).toEqual({ ok: false, status: 403 });
    });

    test('the minted credential is object-scoped, never admin-scoped', async () => {
      const credential = unwrapCredential(await storage.credentialFor(fleetIdentity(TENANT), TENANT));

      expect(credential.permission.startsWith('object-')).toBe(true);
      expect(minter.requests.every((r) => r.permission.startsWith('object-'))).toBe(true);
    });

    test('the minter is only ever asked for a terminated prefix', async () => {
      await storage.credentialFor(fleetIdentity(TENANT), TENANT);
      await storage.credentialFor(fleetIdentity(SIBLING), SIBLING);

      expect(minter.requests.length).toBeGreaterThan(0);
      for (const request of minter.requests) {
        expect(request.prefix.endsWith('/')).toBe(true);
      }
    });
  });

  describe('the parent credential is not reachable from the request path', () => {
    test('nothing the fleet identity can obtain contains the parent secret', async () => {
      const obtainable: unknown[] = [
        storage.prefixFor(fleetIdentity(TENANT), TENANT),
        storage.keyFor(fleetIdentity(TENANT), TENANT, ['a.md']),
        storage.keyForUntrusted(fleetIdentity(TENANT), TENANT, 'attachments', 'x'),
        await storage.credentialFor(fleetIdentity(TENANT), TENANT),
        await storage.invalidate(fleetIdentity(TENANT), TENANT),
      ];

      expect(JSON.stringify(obtainable)).not.toContain(PARENT_SECRET_ACCESS_KEY);
    });

    test('the accessor exposes methods only — no minter, no parent handle', () => {
      for (const [name, value] of Object.entries(storage as unknown as Record<string, unknown>)) {
        expect(typeof value).toBe('function');
        expect(name).not.toContain('parent');
        expect(name).not.toContain('minter');
      }
    });

    test('the scoped secret is not the parent secret and does not disclose it', async () => {
      const credential = unwrapCredential(await storage.credentialFor(fleetIdentity(TENANT), TENANT));

      expect(credential.secretAccessKey).not.toBe(PARENT_SECRET_ACCESS_KEY);
      expect(credential.sessionToken).not.toContain(PARENT_SECRET_ACCESS_KEY);
      expect(JSON.stringify(credential)).not.toContain(PARENT_SECRET_ACCESS_KEY);
    });
  });

  describe('the credential cache is bounded below the credential itself', () => {
    test('a second call inside the window is served without a re-mint', async () => {
      await storage.credentialFor(fleetIdentity(TENANT), TENANT);
      minter.requests.length = 0;

      clockMs += 1_000;
      await storage.credentialFor(fleetIdentity(TENANT), TENANT);

      expect(minter.requests).toEqual([]);
    });

    test('the cache never outlives the credential, even when configured longer', async () => {
      // Cache TTL deliberately set LONGER than the credential's own lifetime. A
      // cache that outlives its credential hands the request path a 403 machine.
      const longCache = createTenantStorage({
        minter,
        credentialTtlSeconds: 60,
        cacheTtlMs: 10 * 60 * 1_000,
        now: () => clockMs,
      });

      const first = unwrapCredential(await longCache.credentialFor(fleetIdentity(TENANT), TENANT));
      minter.requests.length = 0;

      // Step to just before the credential expires. A cache honouring its own
      // configured TTL would still be serving the now-nearly-dead credential.
      clockMs = first.expiresAtMs - 1;
      const second = unwrapCredential(await longCache.credentialFor(fleetIdentity(TENANT), TENANT));

      expect(minter.requests.length).toBe(1);
      expect(second.expiresAtMs).toBeGreaterThan(first.expiresAtMs);
    });

    test('a served credential always has time left on it', async () => {
      const first = unwrapCredential(await storage.credentialFor(fleetIdentity(TENANT), TENANT));

      for (let step = 0; step < 20; step++) {
        clockMs += 60_000;
        const served = unwrapCredential(
          await storage.credentialFor(fleetIdentity(TENANT), TENANT),
        );
        expect(served.expiresAtMs).toBeGreaterThan(clockMs);
      }

      expect(minter.requests.length).toBeGreaterThan(1);
      expect(first.expiresAtMs).toBeLessThan(clockMs + CREDENTIAL_TTL_SECONDS * 1_000);
    });
  });

  describe('invalidation outruns the cache', () => {
    test('an invalidated credential is not served from cache afterwards', async () => {
      const first = unwrapCredential(await storage.credentialFor(fleetIdentity(TENANT), TENANT));
      minter.requests.length = 0;

      expect(await storage.invalidate(controlPlaneIdentity(), TENANT)).toEqual({ ok: true });

      // Same instant — the TTL has not moved. A cache that outlives an
      // invalidation is the security bug this test exists to prevent.
      const second = unwrapCredential(await storage.credentialFor(fleetIdentity(TENANT), TENANT));

      expect(minter.requests.length).toBe(1);
      expect(second.sessionToken).not.toBe(first.sessionToken);
    });

    test('invalidating one tenant does not disturb its sibling', async () => {
      await storage.credentialFor(fleetIdentity(TENANT), TENANT);
      const before = unwrapCredential(
        await storage.credentialFor(fleetIdentity(SIBLING), SIBLING),
      );

      await storage.invalidate(controlPlaneIdentity(), TENANT);
      minter.requests.length = 0;

      const after = unwrapCredential(await storage.credentialFor(fleetIdentity(SIBLING), SIBLING));

      expect(minter.requests).toEqual([]);
      expect(after.sessionToken).toBe(before.sessionToken);
    });

    test('invalidation is control-plane only', async () => {
      for (const caller of [fleetIdentity(TENANT), adminIdentity(), webAppIdentity()]) {
        expect(await storage.invalidate(caller, TENANT)).toEqual({
          ok: false,
          reason: 'scope_denied',
        });
      }
    });

    test('a denied invalidation leaves the cached credential in place', async () => {
      const before = unwrapCredential(await storage.credentialFor(fleetIdentity(TENANT), TENANT));
      await storage.invalidate(adminIdentity(), TENANT);
      minter.requests.length = 0;

      const after = unwrapCredential(await storage.credentialFor(fleetIdentity(TENANT), TENANT));

      expect(minter.requests).toEqual([]);
      expect(after.sessionToken).toBe(before.sessionToken);
    });

    test('invalidating an unknown tenant is a no-op success, not an error', async () => {
      expect(await storage.invalidate(controlPlaneIdentity(), 'never-provisioned')).toEqual({
        ok: true,
      });
    });

    test('a malformed id cannot be invalidated', async () => {
      expect(await storage.invalidate(controlPlaneIdentity(), '../alice')).toEqual({
        ok: false,
        reason: 'invalid_tenant_id',
      });
    });
  });
});
