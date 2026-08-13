/**
 * The named secret store and its accessor (U1 step 6).
 *
 * It holds, per tenant, a database connection string *and* a bearer grant, and
 * it is read on the request path. Platform environment variables cannot do that
 * at the target scale — which is why a real store exists rather than a config
 * block.
 *
 * **R11 is decided here, not at the tool surface.** R11's CI case asserts
 * `scope_denied` on `recall` for the web app's `/admin` credential. Secret
 * resolution bypasses tool dispatch entirely, so that assertion proves nothing
 * if the same credential can read a connection string and connect to the
 * database directly. Therefore: entries are namespaced per tenant and
 * resolvable only by the fleet request-path identity serving that tenant's own
 * authenticated bearer. The `/admin` and web-app identities hold no resolve
 * permission on any tenant namespace.
 *
 * Three rules hold this together, and each is pinned by a test:
 *
 * 1. **The scope check runs before the cache and before the backend.** A cache
 *    hit must not be a side door — `src/README.md` puts the scope check below
 *    the handlers precisely so no call site can forget it.
 * 2. **Every accessor takes an explicit caller identity.** Nothing here reads
 *    ambient or global state to decide who is asking, and this module exports
 *    no pre-built singleton. An accessor that infers its caller is an accessor
 *    whose boundary disappears at the first refactor.
 * 3. **Read and write are separate permissions.** Provisioning (U2) must be
 *    able to write and revoke entries without thereby gaining the ability to
 *    read them; the fleet must be able to read its own without being able to
 *    write anyone's.
 *
 * Backends are pluggable and no vendor is hardcoded. The production backend
 * (Cloudflare Secrets Store or equivalent) is wired in a later unit; the
 * in-memory implementation below is for tests.
 *
 * Rotation owner (feeds R10's credential register): the control-plane operator
 * on call for the tenant provisioning service. Rotation is a `put` through this
 * module, which invalidates the cached entry as part of the same operation; a
 * rotation performed out of band is bounded by `DEFAULT_TTL_MS` or ended early
 * by `invalidate`.
 */

/** What the store holds for one tenant. Both halves are request-path secrets. */
export interface TenantSecret {
  /** Direct Neon connection string for this tenant's database (KTD2/KTD1). */
  readonly connectionString: string;
  /** The bearer grant the MCP fleet presents/verifies for this tenant. */
  readonly bearerGrant: string;
}

/**
 * The fleet request-path identity, derived from a verified bearer by the MCP
 * auth layer. It must never be constructed from request input — the tenant id
 * it carries is the authenticated one, and it is the only thing standing
 * between a tenant and its neighbour's connection string.
 */
export interface FleetIdentity {
  readonly kind: 'fleet';
  readonly tenantId: string;
}

/** Tenant provisioning and rotation (U2). Writes entries; cannot read them. */
export interface ControlPlaneIdentity {
  readonly kind: 'control-plane';
}

/** The web app's `/admin` credential (R11). No resolve, no write. */
export interface AdminIdentity {
  readonly kind: 'admin';
}

/** An end-user web-app session. No resolve, no write. */
export interface WebAppIdentity {
  readonly kind: 'web-app';
}

export type CallerIdentity =
  | FleetIdentity
  | ControlPlaneIdentity
  | AdminIdentity
  | WebAppIdentity;

export function fleetIdentity(tenantId: string): FleetIdentity {
  return { kind: 'fleet', tenantId };
}

export function controlPlaneIdentity(): ControlPlaneIdentity {
  return { kind: 'control-plane' };
}

export function adminIdentity(): AdminIdentity {
  return { kind: 'admin' };
}

export function webAppIdentity(): WebAppIdentity {
  return { kind: 'web-app' };
}

/**
 * Why a resolve did not return a secret.
 *
 * - `scope_denied` — the caller holds no resolve permission on that namespace.
 * - `not_found` — permitted caller, no entry. A typed miss, deliberately: a
 *   thrown error here reads as an outage and gets retried or swallowed, and a
 *   returned default reads as someone else's tenant.
 * - `invalid_tenant_id` — the id could not be turned into a namespace safely.
 *
 * A backend failure is not in this union. It propagates, because "the store is
 * down" must never be flattened into "this tenant does not exist".
 */
export type ResolveFailureReason = 'scope_denied' | 'not_found' | 'invalid_tenant_id';

export type ResolveResult =
  | { readonly ok: true; readonly secret: TenantSecret }
  | { readonly ok: false; readonly reason: ResolveFailureReason };

export type WriteFailureReason = 'scope_denied' | 'invalid_tenant_id';

export type WriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: WriteFailureReason };

/**
 * The pluggable backend. Deliberately vendor-neutral: three operations over an
 * opaque namespace string, which a secrets manager, a KMS-fronted table or the
 * in-memory fake below can all satisfy.
 */
export interface SecretBackend {
  get(namespace: string): Promise<TenantSecret | undefined>;
  put(namespace: string, secret: TenantSecret): Promise<void>;
  delete(namespace: string): Promise<void>;
}

/**
 * The write half, on its own, because rule 3 above is a real boundary and not a
 * comment: a module that writes entries has no business being *able* to read
 * them. Provisioning (U2) declares this and never the full store, so it is
 * type-incapable of resolving any tenant's connection string or bearer — the
 * same narrowing `provision.ts` applies to the storage accessor via
 * `TenantPrefixSource`, applied here at the higher-stakes seam.
 *
 * `TenantSecretStore` extends it, so the real store satisfies it structurally
 * and there is still exactly one declaration of what a write is.
 */
export interface TenantSecretWriter {
  /** Create or rotate an entry. Control plane only. Invalidates the cache. */
  put(caller: CallerIdentity, tenantId: string, secret: TenantSecret): Promise<WriteResult>;
  /** Remove an entry. Control plane only. Invalidates the cache. */
  revoke(caller: CallerIdentity, tenantId: string): Promise<WriteResult>;
}

export interface TenantSecretStore extends TenantSecretWriter {
  /** Read a tenant's secret. Permitted only for that tenant's fleet identity. */
  resolve(caller: CallerIdentity, tenantId: string): Promise<ResolveResult>;
  /** Drop a cached entry without touching the backend. Control plane only. */
  invalidate(caller: CallerIdentity, tenantId: string): Promise<WriteResult>;
}

export interface TenantSecretStoreOptions {
  readonly backend: SecretBackend;
  /**
   * How long a resolved entry may be served from memory. The cache exists
   * because this is a request-path read; the bound exists because a cache that
   * outlives a revocation is a security bug. Revocation and rotation through
   * this module do not wait for it — the TTL is the backstop for changes made
   * out of band, not the primary invalidation path.
   */
  readonly ttlMs?: number;
  /** Injectable clock. Tests advance it; production passes nothing. */
  readonly now?: () => number;
  /** Cache size ceiling, so a long-lived fleet process cannot grow unbounded. */
  readonly maxEntries?: number;
}

export const DEFAULT_TTL_MS = 60_000;

/**
 * Sized against KTD2's ~500 warm tenants per instance under Durable-Object
 * tenant affinity. Without affinity this number is wrong in a way that costs
 * money rather than correctness — see the routing note in `wrangler.toml`.
 */
export const DEFAULT_MAX_ENTRIES = 512;

const NAMESPACE_PREFIX = 'tenant';

/**
 * Tenant ids are lowercase alphanumeric with dashes. The pattern is a namespace
 * safety property, not a style rule: `..`, `/` or whitespace in an id would let
 * one tenant's key address another tenant's entry in a backend that treats the
 * namespace as a path.
 */
const TENANT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function isValidTenantId(tenantId: string): boolean {
  return TENANT_ID_PATTERN.test(tenantId);
}

/**
 * The single place a tenant id becomes a storage key. Per `src/README.md`, no
 * call site constructs this itself.
 */
export function tenantNamespace(tenantId: string): string {
  return `${NAMESPACE_PREFIX}/${tenantId}`;
}

/** Resolve permission: the fleet identity serving exactly this tenant. */
function canResolve(caller: CallerIdentity, tenantId: string): boolean {
  return caller.kind === 'fleet' && caller.tenantId === tenantId;
}

/** Write permission: the control plane, and nothing else. */
function canWrite(caller: CallerIdentity): boolean {
  return caller.kind === 'control-plane';
}

function frozenSecret(secret: TenantSecret): TenantSecret {
  return Object.freeze({
    connectionString: secret.connectionString,
    bearerGrant: secret.bearerGrant,
  });
}

interface CacheEntry {
  readonly secret: TenantSecret;
  readonly expiresAt: number;
}

/** In-memory backend for tests and local development. Never for production. */
export function createInMemorySecretBackend(
  seed?: ReadonlyMap<string, TenantSecret>,
): SecretBackend {
  const entries = new Map<string, TenantSecret>();
  if (seed) {
    for (const [namespace, secret] of seed) entries.set(namespace, frozenSecret(secret));
  }

  return {
    get: (namespace) => Promise.resolve(entries.get(namespace)),
    put: (namespace, secret) => {
      entries.set(namespace, frozenSecret(secret));
      return Promise.resolve();
    },
    delete: (namespace) => {
      entries.delete(namespace);
      return Promise.resolve();
    },
  };
}

export function createTenantSecretStore(options: TenantSecretStoreOptions): TenantSecretStore {
  const { backend } = options;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  /** Keyed on the namespace, so nothing weaker than a tenant boundary is cached. */
  const cache = new Map<string, CacheEntry>();

  function readCache(namespace: string): TenantSecret | undefined {
    const entry = cache.get(namespace);
    if (entry === undefined) return undefined;

    if (entry.expiresAt <= now()) {
      cache.delete(namespace);
      return undefined;
    }

    // Refresh recency without extending the deadline: eviction is
    // least-recently-used, expiry stays absolute from the write.
    cache.delete(namespace);
    cache.set(namespace, entry);
    return entry.secret;
  }

  function writeCache(namespace: string, secret: TenantSecret): void {
    cache.delete(namespace);
    while (cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    cache.set(namespace, { secret, expiresAt: now() + ttlMs });
  }

  return {
    async resolve(caller, tenantId) {
      // Order matters and is asserted by test: permission, then id validity,
      // then cache, then backend. A denied caller reaches neither the cache nor
      // the store, and learns nothing about whether the id or the tenant exists.
      if (!canResolve(caller, tenantId)) return { ok: false, reason: 'scope_denied' };
      if (!isValidTenantId(tenantId)) return { ok: false, reason: 'invalid_tenant_id' };

      const namespace = tenantNamespace(tenantId);

      const cached = readCache(namespace);
      if (cached !== undefined) return { ok: true, secret: cached };

      const stored = await backend.get(namespace);
      // A miss is not cached: the next call after provisioning must see the new
      // entry, and a negative cache would hold a brand-new tenant out for a TTL.
      if (stored === undefined) return { ok: false, reason: 'not_found' };

      const secret = frozenSecret(stored);
      writeCache(namespace, secret);
      return { ok: true, secret };
    },

    async put(caller, tenantId, secret) {
      if (!canWrite(caller)) return { ok: false, reason: 'scope_denied' };
      if (!isValidTenantId(tenantId)) return { ok: false, reason: 'invalid_tenant_id' };

      const namespace = tenantNamespace(tenantId);
      await backend.put(namespace, frozenSecret(secret));
      cache.delete(namespace);
      return { ok: true };
    },

    async revoke(caller, tenantId) {
      if (!canWrite(caller)) return { ok: false, reason: 'scope_denied' };
      if (!isValidTenantId(tenantId)) return { ok: false, reason: 'invalid_tenant_id' };

      const namespace = tenantNamespace(tenantId);
      // Cache first, then backend. If the backend delete fails and throws, the
      // entry is already unserveable from this process rather than live for a
      // TTL after the operator believed it revoked.
      cache.delete(namespace);
      await backend.delete(namespace);
      return { ok: true };
    },

    invalidate(caller, tenantId) {
      if (!canWrite(caller)) return Promise.resolve({ ok: false, reason: 'scope_denied' });
      if (!isValidTenantId(tenantId)) {
        return Promise.resolve({ ok: false, reason: 'invalid_tenant_id' });
      }

      cache.delete(tenantNamespace(tenantId));
      return Promise.resolve({ ok: true });
    },
  };
}
