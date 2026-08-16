/**
 * Key resolution (R22): **explicit per-call key → the tenant's stored provider
 * key → the hosted pooled key.**
 *
 * A stored provider key is a new secret class. It therefore inherits, without
 * exception, the rules `src/control/secrets.ts` established for the first one:
 *
 *  1. **The scope check runs before the cache and before the backend.** A cache
 *     hit must not be a side door.
 *  2. **Every accessor takes an explicit caller identity.** Nothing here reads
 *     ambient state to decide who is asking, and this module exports no
 *     pre-built singleton.
 *  3. **Read and write are separate permissions.** The control plane writes and
 *     revokes; the fleet reads its own tenant's key and nobody else's.
 *
 * The identity vocabulary is imported rather than re-declared — one identity
 * model, now three keyspaces (`secrets.ts` owns the connection string and
 * bearer, `storage.ts` owns the object prefix, this file owns provider keys).
 *
 * **Why brainz holds the key rather than Cloudflare** (approach step 6):
 * Cloudflare's BYOK is gateway-scoped, keyed by a `cf-aig-byok-alias` that
 * unified-billing endpoints read only as `default`. R22 wants a key per
 * *tenant*, and a gateway-wide key would silently pool one user's credential
 * across all of them. Holding tenant keys here also keeps R12's erasure leg
 * inside brainz's own control — {@link TenantProviderKeyStore.revokeAll} is
 * that leg.
 *
 * **The key is treated as radioactive.** A resolved key redacts itself under
 * `JSON.stringify`, because stringifying an object is the one thing every
 * logger, error reporter and metrics sink in the world does.
 *
 * Backends are pluggable and no vendor is hardcoded; the in-memory
 * implementation below is for tests and local development.
 */

import { isValidTenantId, type CallerIdentity } from '../control/secrets.ts';
import { PROVIDER_IDS, type ProviderId } from './routing.ts';

export { PROVIDER_IDS };
export type { ProviderId };

/** Where a key came from. The gateway records it; hosted COGS depends on it. */
export type KeySource = 'per-call' | 'byok' | 'hosted';

export type KeyResolveFailureReason = 'scope_denied' | 'not_found' | 'invalid_tenant_id';
export type KeyWriteFailureReason = 'scope_denied' | 'invalid_tenant_id';

export type KeyResolveResult =
  | { readonly ok: true; readonly key: string }
  | { readonly ok: false; readonly reason: KeyResolveFailureReason };

export type KeyWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: KeyWriteFailureReason };

/** Three operations over an opaque namespace: a KMS, a table or the fake below. */
export interface ProviderKeyBackend {
  get(namespace: string): Promise<string | undefined>;
  put(namespace: string, key: string): Promise<void>;
  delete(namespace: string): Promise<void>;
}

export interface TenantProviderKeyStore {
  /**
   * How long a resolved key may be served from **one instance's** cache.
   *
   * Exposed rather than left as an implementation detail because it is the exact
   * bound R12's erasure receipt has to state: revoking clears this process's
   * entry and the backend row, and cannot reach a second container's memory.
   * See {@link createTenantProviderKeyStore}.
   */
  readonly cacheWindowMs: number;
  /** Read a tenant's key for one provider. That tenant's fleet identity only. */
  resolve(caller: CallerIdentity, tenantId: string, provider: ProviderId): Promise<KeyResolveResult>;
  /** Create or rotate. Control plane only; invalidates the cache. */
  put(
    caller: CallerIdentity,
    tenantId: string,
    provider: ProviderId,
    key: string,
  ): Promise<KeyWriteResult>;
  /** Remove one provider's key. Control plane only. */
  revoke(caller: CallerIdentity, tenantId: string, provider: ProviderId): Promise<KeyWriteResult>;
  /** R12's erasure leg: every provider, in one call, so none is forgotten. */
  revokeAll(caller: CallerIdentity, tenantId: string): Promise<KeyWriteResult>;
}

export interface TenantProviderKeyStoreOptions {
  readonly backend: ProviderKeyBackend;
  /**
   * Request-path read, so it caches. **A cache that outlives a revocation is a
   * bug in the process that revoked, and a stated bound in every other one.**
   *
   * Revocation deletes this instance's entry before it touches the backend, so
   * the revoking process is never a side door. It has no way to reach the cache
   * of a second container that resolved the key a moment earlier — closing that
   * needs a shared revocation channel (a pub/sub invalidation, or a generation
   * counter read on the hot path, which is the cache paid for again), and this
   * system has neither. So the window is bounded by this TTL, published as
   * {@link TenantProviderKeyStore.cacheWindowMs}, and carried on R12's erasure
   * receipt rather than being quietly absent from it.
   */
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly maxEntries?: number;
}

export const DEFAULT_TTL_MS = 60_000;
export const DEFAULT_MAX_ENTRIES = 512;

const NAMESPACE_PREFIX = 'provider-key';

/**
 * The single place a tenant id and a provider become a storage key. The
 * provider is drawn from a closed set, so it cannot carry a path.
 */
export function providerKeyNamespace(tenantId: string, provider: ProviderId): string {
  return `${NAMESPACE_PREFIX}/${tenantId}/${provider}`;
}

function canResolve(caller: CallerIdentity, tenantId: string): boolean {
  return caller.kind === 'fleet' && caller.tenantId === tenantId;
}

function canWrite(caller: CallerIdentity): boolean {
  return caller.kind === 'control-plane';
}

interface CacheEntry {
  readonly key: string;
  readonly expiresAt: number;
}

export function createInMemoryProviderKeyBackend(
  seed?: ReadonlyMap<string, string>,
): ProviderKeyBackend {
  const entries = new Map<string, string>(seed);
  return {
    get: (namespace) => Promise.resolve(entries.get(namespace)),
    put: (namespace, key) => {
      entries.set(namespace, key);
      return Promise.resolve();
    },
    delete: (namespace) => {
      entries.delete(namespace);
      return Promise.resolve();
    },
  };
}

export function createTenantProviderKeyStore(
  options: TenantProviderKeyStoreOptions,
): TenantProviderKeyStore {
  const { backend } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  const cache = new Map<string, CacheEntry>();

  function readCache(namespace: string): string | undefined {
    const entry = cache.get(namespace);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= now()) {
      cache.delete(namespace);
      return undefined;
    }
    cache.delete(namespace);
    cache.set(namespace, entry);
    return entry.key;
  }

  function writeCache(namespace: string, key: string): void {
    cache.delete(namespace);
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    cache.set(namespace, { key, expiresAt: now() + ttlMs });
  }

  async function write(
    caller: CallerIdentity,
    tenantId: string,
    providers: readonly ProviderId[],
    key: string | undefined,
  ): Promise<KeyWriteResult> {
    if (!canWrite(caller)) return { ok: false, reason: 'scope_denied' };
    if (!isValidTenantId(tenantId)) return { ok: false, reason: 'invalid_tenant_id' };

    for (const provider of providers) {
      const namespace = providerKeyNamespace(tenantId, provider);
      // Cache first on delete: if the backend throws, the entry is already
      // unserveable from this process rather than live for a TTL after the
      // operator believed it revoked.
      cache.delete(namespace);
      if (key === undefined) await backend.delete(namespace);
      else await backend.put(namespace, key);
    }
    return { ok: true };
  }

  return {
    cacheWindowMs: ttlMs,

    async resolve(caller, tenantId, provider) {
      // Order matters: permission, then id validity, then cache, then backend.
      // A denied caller reaches neither the cache nor the store, and learns
      // nothing about whether the tenant exists.
      if (!canResolve(caller, tenantId)) return { ok: false, reason: 'scope_denied' };
      if (!isValidTenantId(tenantId)) return { ok: false, reason: 'invalid_tenant_id' };

      const namespace = providerKeyNamespace(tenantId, provider);
      const cached = readCache(namespace);
      if (cached !== undefined) return { ok: true, key: cached };

      const stored = await backend.get(namespace);
      // A miss is not cached: a tenant who adds a key must not wait out a TTL.
      if (stored === undefined) return { ok: false, reason: 'not_found' };

      writeCache(namespace, stored);
      return { ok: true, key: stored };
    },

    put(caller, tenantId, provider, key) {
      return write(caller, tenantId, [provider], key);
    },

    revoke(caller, tenantId, provider) {
      return write(caller, tenantId, [provider], undefined);
    },

    revokeAll(caller, tenantId) {
      return write(caller, tenantId, PROVIDER_IDS, undefined);
    },
  };
}

/**
 * The platform's own credentials. Held in a closure rather than on an object,
 * so the request path can ask for one but cannot enumerate them.
 */
export interface HostedKeyPool {
  keyFor(provider: ProviderId): string | undefined;
}

export function createHostedKeyPool(keys: Partial<Record<ProviderId, string>>): HostedKeyPool {
  const held = new Map<ProviderId, string>(
    (Object.entries(keys) as ReadonlyArray<[ProviderId, string | undefined]>).flatMap(
      ([provider, key]) => (key === undefined ? [] : [[provider, key] as [ProviderId, string]]),
    ),
  );
  return { keyFor: (provider) => held.get(provider) };
}

export interface ResolvedKey {
  readonly key: string;
  readonly source: KeySource;
  /**
   * Only a hosted pooled key is the platform's cost of goods. A BYOK or
   * per-call key is still metered — R22 wants the user's own cap and
   * visibility intact — but it is spent on their credential, not ours.
   */
  readonly countsTowardHostedCogs: boolean;
  toJSON(): { readonly source: KeySource; readonly countsTowardHostedCogs: boolean; readonly key: string };
}

const REDACTED = '[redacted]';

function resolved(key: string, source: KeySource): ResolvedKey {
  const countsTowardHostedCogs = source === 'hosted';
  return {
    key,
    source,
    countsTowardHostedCogs,
    toJSON: () => ({ source, countsTowardHostedCogs, key: REDACTED }),
  };
}

export interface ProviderKeyRequest {
  readonly caller: CallerIdentity;
  readonly tenantId: string;
  readonly provider: ProviderId;
  /** R22 tier one: a key supplied by the caller for this single call. */
  readonly explicitKey?: string;
  readonly store: TenantProviderKeyStore;
  readonly hosted: HostedKeyPool;
}

export type KeyResolution =
  | { readonly ok: true; readonly resolved: ResolvedKey }
  | { readonly ok: false; readonly reason: 'scope_denied' | 'invalid_tenant_id' | 'no_key_available' };

/**
 * R22's order, and one deliberate non-fallback: a **scope denial does not fall
 * through to the hosted pool.** A caller the store refuses is a caller whose
 * identity does not match the tenant it named, and handing it the platform's
 * credential would let it spend platform money on someone else's behalf. A
 * backend failure does not fall through either — it propagates, because "the
 * store is down" must never be flattened into "this tenant has no key".
 *
 * **The scope check is here, not only in the store.** Tier one is the one branch
 * that never reaches the store, so a check that lived only inside
 * {@link TenantProviderKeyStore.resolve} would leave the caller-supplied key as
 * the single way to act as a tenant you do not serve: the call runs, and its
 * cost is metered against that tenant's counter. Rule 1 of `secrets.ts` —
 * "the scope check runs before the cache and before the backend" — is really
 * "before anything", and a branch that skips the backend does not skip it.
 */
export async function resolveProviderKey(request: ProviderKeyRequest): Promise<KeyResolution> {
  const { caller, tenantId, provider, explicitKey, store, hosted } = request;

  if (!canResolve(caller, tenantId)) return { ok: false, reason: 'scope_denied' };
  if (!isValidTenantId(tenantId)) return { ok: false, reason: 'invalid_tenant_id' };

  if (explicitKey !== undefined && explicitKey.length > 0) {
    return { ok: true, resolved: resolved(explicitKey, 'per-call') };
  }

  const stored = await store.resolve(caller, tenantId, provider);
  if (stored.ok) return { ok: true, resolved: resolved(stored.key, 'byok') };
  if (stored.reason !== 'not_found') return { ok: false, reason: stored.reason };

  const pooled = hosted.keyFor(provider);
  if (pooled === undefined) return { ok: false, reason: 'no_key_available' };
  return { ok: true, resolved: resolved(pooled, 'hosted') };
}
