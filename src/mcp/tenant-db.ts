/**
 * The one place a request reaches a tenant's database.
 *
 * **The connection string is never in the request.** It is resolved from the
 * secret store by the fleet identity for *this* tenant and no other — R11's
 * boundary, one layer below the tool surface, where a `scope_denied` on `recall`
 * proves nothing if the same identity can read the connection string and connect
 * directly. `open()` therefore takes an authenticated tenant id and nothing else.
 *
 * **The cache is what KTD2's affinity is for, and `cold_start` is its miss.**
 * A Durable Object routes one tenant's requests to one instance so its warm
 * connection pays off; a miss here is exactly the first-touch wake that
 * `entity`'s latency promise has to be honest about. So the flag is the
 * accessor's own observation rather than a value a handler sets: it cannot drift
 * from the thing it describes.
 *
 * **The TTL is a security bound, not a performance one.** A cached connection
 * that outlives a revoked secret is a revocation that did not happen, so the
 * entry expires whether or not it is busy, and the LRU ceiling keeps a
 * long-lived instance from holding every tenant it has ever served.
 */

import { SQL } from 'bun';

import { fleetIdentity, type TenantSecretStore } from '../control/secrets.ts';

export const DEFAULT_CONNECTION_TTL_MS = 5 * 60 * 1000;

/** Sized against KTD2's ~500 warm tenants per instance, as the secret cache is. */
export const DEFAULT_MAX_CONNECTIONS = 64;

export interface TenantConnection {
  readonly sql: SQL;
  /** True when this request paid for the wake. */
  readonly coldStart: boolean;
}

export type ConnectionRefusal = 'unknown_tenant' | 'scope_denied' | 'unavailable';

export type OpenOutcome =
  | { readonly ok: true; readonly connection: TenantConnection }
  | { readonly ok: false; readonly reason: ConnectionRefusal };

export interface TenantConnections {
  open(tenantId: string): Promise<OpenOutcome>;
  /** Drops every cached connection. Used at shutdown, and by the cold-start test. */
  close(): Promise<void>;
}

interface Entry {
  readonly sql: SQL;
  readonly expiresAt: number;
  /** True for a connection this accessor opened and therefore owns. */
  readonly owned: boolean;
}

export function createTenantConnections(options: {
  readonly secrets: TenantSecretStore;
  readonly now: () => number;
  /** Injected so tests can hand back a fixture connection instead of dialling. */
  readonly open?: (connectionString: string) => SQL;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
}): TenantConnections {
  const ttlMs = options.ttlMs ?? DEFAULT_CONNECTION_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_CONNECTIONS;
  const dial = options.open ?? ((connectionString: string) => new SQL(connectionString, { max: 4 }));
  const cache = new Map<string, Entry>();

  async function evict(tenantId: string): Promise<void> {
    const entry = cache.get(tenantId);
    cache.delete(tenantId);
    if (entry?.owned === true) await entry.sql.close().catch(() => undefined);
  }

  return {
    async open(tenantId) {
      const at = options.now();
      const cached = cache.get(tenantId);
      if (cached !== undefined && cached.expiresAt > at) {
        // Refresh recency without extending the deadline: the expiry is
        // absolute from the resolve, so a busy tenant's secret is still
        // re-read on schedule.
        cache.delete(tenantId);
        cache.set(tenantId, cached);
        return { ok: true, connection: { sql: cached.sql, coldStart: false } };
      }
      if (cached !== undefined) await evict(tenantId);

      const resolved = await options.secrets.resolve(fleetIdentity(tenantId), tenantId);
      if (!resolved.ok) {
        return { ok: false, reason: resolved.reason === 'scope_denied' ? 'scope_denied' : 'unknown_tenant' };
      }

      let sql: SQL;
      let owned = true;
      try {
        sql = dial(resolved.secret.connectionString);
        owned = options.open === undefined;
      } catch {
        return { ok: false, reason: 'unavailable' };
      }

      cache.set(tenantId, { sql, expiresAt: at + ttlMs, owned });
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        await evict(oldest);
      }

      return { ok: true, connection: { sql, coldStart: true } };
    },

    async close() {
      for (const tenantId of [...cache.keys()]) await evict(tenantId);
    },
  };
}
