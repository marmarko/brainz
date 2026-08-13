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
 *
 * **The tenant's schema version rides the entry, and that placement is the whole
 * design.** U3's request-path gate has to know what rung a tenant is at before
 * anything queries its tables, and the tenant database is the truth (the
 * control-plane row is an index that a sweep updates afterwards). Asking it per
 * request would put a round trip on every call, on the promise `entity` is
 * measured against; asking it once per *connection* costs the cold path, which
 * is already paying for a Neon wake, and costs the warm path nothing. What that
 * buys is a cache, so what invalidates it is stated rather than assumed: the
 * entry's own TTL, absolute from the resolve — and, for the direction that
 * matters more, {@link TenantConnections.refreshSchemaVersion}, which dispatch
 * calls on the refusal path so a tenant something has just migrated is served on
 * the next call instead of at the next expiry.
 */

import { SQL } from 'bun';

import { readTenantSchemaVersion } from '../control/migrate.ts';
import { fleetIdentity, type TenantSecretStore } from '../control/secrets.ts';

export const DEFAULT_CONNECTION_TTL_MS = 5 * 60 * 1000;

/** Sized against KTD2's ~500 warm tenants per instance, as the secret cache is. */
export const DEFAULT_MAX_CONNECTIONS = 64;

export interface TenantConnection {
  readonly sql: SQL;
  /** True when this request paid for the wake. */
  readonly coldStart: boolean;
  /**
   * The rung this tenant's database is actually at, read from the database
   * rather than from the control-plane row — the row is the fleet's index and a
   * sweep can be mid-flight, the database is the truth. Read once per connection
   * and served from the entry after that; see the module note on what
   * invalidates it.
   */
  readonly schemaVersion: number;
}

export type ConnectionRefusal = 'unknown_tenant' | 'scope_denied' | 'unavailable';

export type OpenOutcome =
  | { readonly ok: true; readonly connection: TenantConnection }
  | { readonly ok: false; readonly reason: ConnectionRefusal };

export interface TenantConnections {
  open(tenantId: string): Promise<OpenOutcome>;
  /**
   * Re-reads the schema version onto a live entry and returns it; `undefined`
   * when there is no entry to refresh or the read failed.
   *
   * The narrow escape hatch for the one case the TTL handles badly: a tenant
   * this instance is about to refuse because the version it banked says the
   * schema is behind. Migrations move that number *while* an entry is warm, so
   * refusing on a cached reading would keep refusing a tenant the fleet has
   * already fixed. Deliberately not called on the success path — that is where
   * the round trip would be a cost rather than a correction.
   */
  refreshSchemaVersion(tenantId: string): Promise<number | undefined>;
  /** Drops every cached connection. Used at shutdown, and by the cold-start test. */
  close(): Promise<void>;
}

interface Entry {
  readonly sql: SQL;
  readonly expiresAt: number;
  /** True for a connection this accessor opened and therefore owns. */
  readonly owned: boolean;
  readonly schemaVersion: number;
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
        return {
          ok: true,
          connection: { sql: cached.sql, coldStart: false, schemaVersion: cached.schemaVersion },
        };
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

      // On the cold path, with the wake already paid for. A database that
      // cannot say what rung it is at is not one this fleet can serve — and
      // answering `unavailable` here rather than guessing a version is the
      // difference between a refused request and a query against tables whose
      // shape is unknown.
      let schemaVersion: number;
      try {
        schemaVersion = await readTenantSchemaVersion(sql);
      } catch {
        if (owned) await sql.close().catch(() => undefined);
        return { ok: false, reason: 'unavailable' };
      }

      cache.set(tenantId, { sql, expiresAt: at + ttlMs, owned, schemaVersion });
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        await evict(oldest);
      }

      return { ok: true, connection: { sql, coldStart: true, schemaVersion } };
    },

    async refreshSchemaVersion(tenantId) {
      const entry = cache.get(tenantId);
      if (entry === undefined) return undefined;
      try {
        const schemaVersion = await readTenantSchemaVersion(entry.sql);
        // The expiry is untouched: this corrects the version, it does not renew
        // the entry, and the secret behind it is still due to be re-read on
        // schedule.
        cache.set(tenantId, { ...entry, schemaVersion });
        return schemaVersion;
      } catch {
        return undefined;
      }
    },

    async close() {
      for (const tenantId of [...cache.keys()]) await evict(tenantId);
    },
  };
}
