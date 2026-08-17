/**
 * The durable authorization store: the OAuth flow's state, in the control plane.
 *
 * **The failure this exists to end.** `src/mcp/serve.ts` composed
 * `createInMemoryAuthorizationStore()`. `McpFleet.sleepAfter` is fifteen minutes
 * and `src/mcp/edge.ts:FLOW_INSTANCE` routes the whole flow to one Durable
 * Object, so the registered clients, the authorization codes, the refresh
 * tokens, the revocation set and the registration rate counter were all one
 * container's memory — gone every time that instance slept, was replaced or was
 * redeployed. The founder connected Claude, came back later, and got *"Your
 * account was authorized, but Brainz returned an error when connecting"*: the
 * server had never heard of the `client_id` its client was re-presenting.
 *
 * **The substrate argument is `secret-pg.ts`'s and is not re-litigated.** The
 * control plane is what both fleets already hold, it is strongly consistent so
 * "registered at T, resolvable at T+1s" is read-your-writes, and a Container
 * holds no Workers bindings so a Cloudflare-native store would put an
 * account-scoped API token inside the process that parses attacker-supplied
 * content. One thing is new: the revocation list is read by `dispatch.ts` on
 * every tool call, on the *tenant's* instance, while `/authorize` and `/token`
 * run on the shared flow instance. Two instances, one list, and the control
 * plane is the only DSN both are guaranteed to hold —
 * `BRAINZ_IDENTITY_DATABASE_URL` is `optional` in `serve.ts`.
 *
 * **What is stored in the clear and what is not** is argued in
 * `src/control/oauth-store.sql`, next to the columns. In one line each: the
 * codes and refresh tokens themselves are never stored, only `sha256` of them;
 * their record bodies are sealed because a body is the grant; the client record
 * is sealed **for storability, not secrecy** — a client here is public by
 * construction and its redirect URI is simply a shape this database refuses to
 * hold in the clear; and a revocation is two ids and a timestamp in the clear,
 * because that is exactly what the control plane says it holds and because the
 * check has to stay an index probe.
 *
 * **There is no cache, deliberately.** `createTenantSecretStore` bounds how long
 * a resolved secret may be served and invalidates on write; nothing equivalent
 * is possible here. A positive cache over `isRevoked` — the only direction worth
 * caching, since the answer is `false` almost always — would bound how quickly a
 * revocation takes effect by its TTL, on every instance that had not written it.
 * That is the hole this module is closing, re-opened for a millisecond.
 */

import type { SQL, TransactionSQL } from 'bun';

import {
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
  hashToken,
  isMintableClientId,
  isMintableGrantId,
  type AuthorizationStore,
  type ClientRecord,
  type CodeRecord,
  type RefreshRecord,
} from '../mcp/oauth.ts';
import type { Endpoint } from '../mcp/tools/index.ts';
import type { GrantScope } from '../mcp/grant-scope.ts';
import { seal, unseal } from './sealed.ts';
import { isValidTenantId } from './secrets.ts';

/**
 * The bound this module refuses at, below the column's own.
 *
 * `control.oauth_envelope` tops out at 2048 characters, which is about 1500
 * ciphertext bytes. Refusing here means an oversized record fails with a
 * sentence naming what it was, rather than as a CHECK violation from a driver.
 * `oauth.ts` refuses an oversized *registration* earlier still, with the RFC's
 * own `invalid_client_metadata`, so this is the backstop rather than the gate.
 */
export const MAX_SEALED_RECORD_BYTES = 1400;

/**
 * The advisory lock the schema ensure takes.
 *
 * A literal distinct from `secret-pg.ts:SECRET_STORE_LOCK_KEY` and from
 * `migrate.ts:SCHEMA_MIGRATION_LOCK_KEY`: two different serialisations sharing a
 * key is a deadlock nobody can find from the code.
 */
export const AUTHORIZATION_STORE_LOCK_KEY = 80_120_265;

/**
 * How long a revocation is kept — **derived, never chosen**.
 *
 * A row may only be swept once no credential naming that grant can verify on its
 * own merits. The longest-lived one is a refresh token, and a revocation blocks
 * rotation (`redeemRefreshToken` consults this list), so the newest refresh that
 * can name a grant revoked at T expires at T + refresh-TTL; the newest access
 * token minted before T expires at T + access-TTL. Deriving it from those two
 * constants means lengthening either TTL lengthens the retention automatically —
 * a retention that is a hand-picked number is a retention that goes stale
 * silently, and going stale in this direction un-revokes a live grant.
 */
export const REVOCATION_RETENTION_SECONDS =
  DEFAULT_REFRESH_TOKEN_TTL_SECONDS + DEFAULT_ACCESS_TOKEN_TTL_SECONDS;

const DDL_PATH = `${import.meta.dir}/oauth-store.sql`;

export interface PostgresAuthorizationStoreOptions {
  /**
   * The control-plane handle. The process's existing one: this is a request-path
   * read, not a reason for a second pool.
   */
  readonly sql: SQL;
  /**
   * From `sealed.ts:importSealingKey`. The **same** key the secret store uses,
   * on purpose: a second key is a second thing to rotate, a second thing to
   * mislay, and a second way for a fleet to boot half-readable. The envelopes
   * cannot be confused because the namespace is the AAD and the namespaces are
   * disjoint: `tenant/…` and `pool/…` there, `oauth-client/…`, `oauth-code/…`
   * and `oauth-refresh/…` here.
   */
  readonly key: CryptoKey;
  /** Injected so the retention case can be tested without waiting thirty days. */
  readonly now?: () => number;
}

export class AuthorizationStoreError extends Error {
  /** What kind of row it was. Never the record, and never a credential. */
  readonly kind: string;

  constructor(kind: string, detail: string) {
    super(`the authorization store cannot hold this ${kind}: ${detail}`);
    this.name = 'AuthorizationStoreError';
    this.kind = kind;
  }
}

/**
 * The namespace each envelope is bound to, which is its own row key.
 *
 * Sealing binds a ciphertext to where it is stored, so a row lifted from one
 * client and pasted over another's fails to open instead of handing over the
 * neighbour's registration. The same property `sealed.ts` already buys for
 * tenants, applied per-row rather than per-table because the rows are what an
 * attacker with SQL access would move.
 */
function clientNamespace(clientId: string): string {
  return `oauth-client/${clientId}`;
}

function codeNamespace(codeDigest: string): string {
  return `oauth-code/${codeDigest}`;
}

function refreshNamespace(tokenDigest: string): string {
  return `oauth-refresh/${tokenDigest}`;
}

export function createPostgresAuthorizationStore(
  options: PostgresAuthorizationStoreOptions,
): AuthorizationStore {
  const { sql, key } = options;
  const now = options.now ?? Date.now;

  async function sealRecord(kind: string, namespace: string, value: unknown): Promise<string> {
    const plaintext = JSON.stringify(value);
    const size = Buffer.byteLength(plaintext, 'utf8');
    if (size > MAX_SEALED_RECORD_BYTES) {
      throw new AuthorizationStoreError(kind, `${size} bytes exceeds ${MAX_SEALED_RECORD_BYTES}`);
    }
    return seal(key, namespace, plaintext);
  }

  /**
   * Open a row, or throw.
   *
   * **Never flattened into `undefined`.** `secrets.ts` settled this once: a
   * backend failure and "this does not exist" are different sentences, and a
   * fleet booted with the wrong key must look like a broken fleet rather than
   * like a database that lost every client. Here it matters twice over, because
   * the caller of `getClient` answers `invalid_client` to an absent row — so a
   * swallowed decrypt failure would tell every connector in the deployment that
   * it had never registered.
   */
  async function openRecord(kind: string, namespace: string, sealed: string): Promise<unknown> {
    const plaintext = await unseal(key, namespace, sealed);
    try {
      return JSON.parse(plaintext);
    } catch (error) {
      throw new AuthorizationStoreError(
        kind,
        `the sealed payload is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    async putClient(record: ClientRecord): Promise<void> {
      if (!isMintableClientId(record.clientId)) {
        throw new AuthorizationStoreError('client', 'the client id is not one this server mints');
      }
      const sealed = await sealRecord('client', clientNamespace(record.clientId), {
        clientName: record.clientName,
        redirectUris: [...record.redirectUris],
      });
      await sql`
        INSERT INTO control.oauth_client (client_id, sealed, registered_at)
        VALUES (${record.clientId}, ${sealed}, ${new Date(record.registeredAt)})
        ON CONFLICT (client_id) DO UPDATE
          SET sealed = EXCLUDED.sealed, registered_at = EXCLUDED.registered_at
      `;
    },

    async getClient(clientId: string): Promise<ClientRecord | undefined> {
      // Refused before the query rather than after: an id outside the minted
      // alphabet cannot name a row, and asking anyway would make this endpoint a
      // way to run arbitrary strings at an indexed column.
      if (!isMintableClientId(clientId)) return undefined;

      const rows = (await sql`
        SELECT sealed, registered_at FROM control.oauth_client WHERE client_id = ${clientId}
      `) as Array<{ sealed: string; registered_at: Date }>;
      const row = rows[0];
      if (row === undefined) return undefined;

      const opened = await openRecord('client', clientNamespace(clientId), row.sealed);
      return clientOf(clientId, row.registered_at, opened);
    },

    async noteRegistration(atMs: number): Promise<void> {
      // A random id rather than a sequence: nothing joins to this row, and a
      // swept monotonic id leaves gaps an operator reads as data loss.
      const id = hashToken(`${atMs}:${crypto.randomUUID()}`);
      await sql`
        INSERT INTO control.oauth_registration (registration_id, registered_at)
        VALUES (${id}, ${new Date(atMs)})
      `;
    },

    async registrationsSince(sinceMs: number): Promise<number> {
      const rows = (await sql`
        SELECT count(*)::int AS n FROM control.oauth_registration
        WHERE registered_at >= ${new Date(sinceMs)}
      `) as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    },

    async putCode(code: string, record: CodeRecord): Promise<void> {
      const digest = hashToken(code);
      const sealed = await sealRecord('authorization code', codeNamespace(digest), record);
      await sql`
        INSERT INTO control.oauth_code (code_digest, sealed, expires_at)
        VALUES (${digest}, ${sealed}, ${new Date(record.expiresAt)})
        ON CONFLICT (code_digest) DO UPDATE
          SET sealed = EXCLUDED.sealed, expires_at = EXCLUDED.expires_at
      `;
    },

    /**
     * **One statement, and that is the whole concurrency argument.**
     *
     * In memory, `get` then `delete` was one turn of the event loop and
     * single-use was free. In SQL the same two steps have a window between them,
     * and two simultaneous redemptions of one consent both read the row — two
     * access tokens from one authorization. A `DELETE … RETURNING` closes it in
     * the engine: under READ COMMITTED the second delete blocks on the row lock,
     * re-evaluates once the first commits, finds the row gone and returns
     * nothing. Exactly one caller can win, with no advisory lock and no
     * transaction of our own.
     *
     * The delete is unconditional on expiry, which matches the in-memory store
     * exactly: a code is taken on the first redeem ATTEMPT whether or not it
     * succeeds, so a wrong verifier burns it. `redeemAuthorizationCode` stays
     * the only place expiry is decided.
     */
    async takeCode(code: string): Promise<CodeRecord | undefined> {
      const digest = hashToken(code);
      const rows = (await sql`
        DELETE FROM control.oauth_code WHERE code_digest = ${digest}
        RETURNING sealed
      `) as Array<{ sealed: string }>;
      const row = rows[0];
      if (row === undefined) return undefined;

      const opened = await openRecord('authorization code', codeNamespace(digest), row.sealed);
      return codeOf(opened);
    },

    async putRefresh(tokenHash: string, record: RefreshRecord): Promise<void> {
      const sealed = await sealRecord('refresh token', refreshNamespace(tokenHash), record);
      await sql`
        INSERT INTO control.oauth_refresh (token_digest, sealed, expires_at)
        VALUES (${tokenHash}, ${sealed}, ${new Date(record.expiresAt)})
        ON CONFLICT (token_digest) DO UPDATE
          SET sealed = EXCLUDED.sealed, expires_at = EXCLUDED.expires_at
      `;
    },

    /** Rotation, and the same `DELETE … RETURNING` for the same reason. */
    async takeRefresh(tokenHash: string): Promise<RefreshRecord | undefined> {
      const rows = (await sql`
        DELETE FROM control.oauth_refresh WHERE token_digest = ${tokenHash}
        RETURNING sealed
      `) as Array<{ sealed: string }>;
      const row = rows[0];
      if (row === undefined) return undefined;

      const opened = await openRecord('refresh token', refreshNamespace(tokenHash), row.sealed);
      return refreshOf(opened);
    },

    /**
     * **Ignored rather than raised for an id no mint could have produced.**
     *
     * `server.ts:handleRevoke` reads `grant_id` off a form body, so an arbitrary
     * caller string reaches this method. RFC 7009 requires the endpoint to
     * answer 200 whether or not the token was known — so a CHECK violation
     * surfacing as a `500` would be the wrong answer twice, and a row would make
     * this table a free write amplifier for anything a caller cared to type.
     * The tenant is not the caller's — `handleRevoke` authenticated it — but it
     * is checked too, because a store that trusts one of its two key columns has
     * only half a key.
     */
    async revokeGrant(tenantId: string, grantId: string): Promise<void> {
      if (!isValidTenantId(tenantId) || !isMintableGrantId(grantId)) return;
      await sql`
        INSERT INTO control.oauth_revocation (tenant_id, grant_id, revoked_at)
        VALUES (${tenantId}, ${grantId}, ${new Date(now())})
        ON CONFLICT (tenant_id, grant_id) DO NOTHING
      `;
    },

    /**
     * **Nothing is caught here, and that is the fail-closed direction.**
     *
     * `dispatch.ts` reads this on every tool call and treats `false` as "carry
     * on". A `try/catch` returning `false` would therefore serve every revoked
     * grant in the deployment for as long as the control plane was unwell — a
     * revocation that is slow to propagate is a bug, and one that is silently
     * dropped is a breach. A rejection propagates out of `authenticate` and the
     * call cannot succeed.
     */
    async isRevoked(tenantId: string, grantId: string): Promise<boolean> {
      if (!isValidTenantId(tenantId) || !isMintableGrantId(grantId)) return false;
      const rows = (await sql`
        SELECT 1 AS present FROM control.oauth_revocation
        WHERE tenant_id = ${tenantId} AND grant_id = ${grantId}
      `) as Array<{ present: number }>;
      return rows.length > 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Reading a sealed payload back into a record.
//
// Every field is checked. These bytes were written by this module, so a shape it
// cannot read means the key or the store is wrong — which is a throw, for the
// reason `secret-pg.ts` gives: answering `not_found` would report a broken fleet
// as an empty one. The checks are also what stops a forged row (someone with
// both the key and SQL access) from widening a grant by hand.
// ---------------------------------------------------------------------------

function asObject(kind: string, opened: unknown): Record<string, unknown> {
  if (typeof opened !== 'object' || opened === null || Array.isArray(opened)) {
    throw new AuthorizationStoreError(kind, 'the sealed payload is not an object');
  }
  return opened as Record<string, unknown>;
}

function stringField(kind: string, record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string') {
    throw new AuthorizationStoreError(kind, `the sealed payload has no ${field}`);
  }
  return value;
}

function numberField(kind: string, record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new AuthorizationStoreError(kind, `the sealed payload has no ${field}`);
  }
  return value;
}

function originsField(kind: string, record: Record<string, unknown>): readonly string[] {
  const value = record['origins'];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new AuthorizationStoreError(kind, 'the sealed payload has no origins');
  }
  return value as string[];
}

function scopeField(kind: string, record: Record<string, unknown>): GrantScope {
  const value = record['scope'];
  if (value !== 'whole_brain' && value !== 'narrowed') {
    throw new AuthorizationStoreError(kind, 'the sealed payload names no grant scope');
  }
  return value;
}

function endpointField(kind: string, record: Record<string, unknown>): Endpoint {
  const value = record['endpoint'];
  if (value !== 'mcp' && value !== 'openai') {
    throw new AuthorizationStoreError(kind, 'the sealed payload names no endpoint');
  }
  return value;
}

function clientOf(clientId: string, registeredAt: Date, opened: unknown): ClientRecord {
  const kind = 'client';
  const record = asObject(kind, opened);
  const redirectUris = record['redirectUris'];
  if (!Array.isArray(redirectUris) || redirectUris.some((uri) => typeof uri !== 'string')) {
    throw new AuthorizationStoreError(kind, 'the sealed payload has no redirect_uris');
  }
  return {
    clientId,
    clientName: stringField(kind, record, 'clientName'),
    redirectUris: redirectUris as string[],
    // Off the column, because `client_id_issued_at` is echoed to the client and
    // has to be the instant the mint decided rather than one re-derived here.
    registeredAt: registeredAt.getTime(),
  };
}

function codeOf(opened: unknown): CodeRecord {
  const kind = 'authorization code';
  const record = asObject(kind, opened);
  return {
    clientId: stringField(kind, record, 'clientId'),
    redirectUri: stringField(kind, record, 'redirectUri'),
    codeChallenge: stringField(kind, record, 'codeChallenge'),
    tenantId: stringField(kind, record, 'tenantId'),
    scope: scopeField(kind, record),
    origins: originsField(kind, record),
    writeOrigin: stringField(kind, record, 'writeOrigin'),
    endpoint: endpointField(kind, record),
    grantId: stringField(kind, record, 'grantId'),
    issuedAt: numberField(kind, record, 'issuedAt'),
    expiresAt: numberField(kind, record, 'expiresAt'),
  };
}

function refreshOf(opened: unknown): RefreshRecord {
  const kind = 'refresh token';
  const record = asObject(kind, opened);
  return {
    clientId: stringField(kind, record, 'clientId'),
    tenantId: stringField(kind, record, 'tenantId'),
    scope: scopeField(kind, record),
    origins: originsField(kind, record),
    writeOrigin: stringField(kind, record, 'writeOrigin'),
    endpoint: endpointField(kind, record),
    grantId: stringField(kind, record, 'grantId'),
    expiresAt: numberField(kind, record, 'expiresAt'),
  };
}

// ---------------------------------------------------------------------------
// Schema.
// ---------------------------------------------------------------------------

/**
 * Create the store's tables if this control plane does not have them yet.
 *
 * The pattern `secret-pg.ts:ensureSecretStoreSchema` settled, including the part
 * that was measured rather than assumed: the advisory lock is necessary and not
 * sufficient, because a transaction that has already issued a statement can
 * evaluate its catalog re-check against a view older than the winner's commit —
 * three concurrent calls produce one success and two `42710 type … already
 * exists`. So the loser's refusal is caught and answered with a question rather
 * than a guess: *is the store there now?* If it is, another process did the work.
 * If it is not, the error was about something else and it is re-thrown, because
 * a fleet that cannot create its authorization store must crash-loop visibly.
 */
export async function ensureAuthorizationStoreSchema(sql: SQL): Promise<void> {
  if (await storePresent(sql)) return;

  const ddl = await Bun.file(DDL_PATH).text();
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${AUTHORIZATION_STORE_LOCK_KEY})`;
      if (await storePresent(tx)) return;
      await tx.unsafe(ddl);
    });
  } catch (error) {
    if (!(await storePresent(sql))) throw error;
  }
}

async function storePresent(sql: SQL | TransactionSQL): Promise<boolean> {
  // The registration table is the probe because it is the last one the DDL
  // creates: a partially-applied file would otherwise report present.
  const rows = (await sql`
    SELECT to_regclass('control.oauth_registration') IS NOT NULL AS present
  `) as Array<{ present: boolean }>;
  return rows[0]?.present === true;
}

// ---------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------

export interface PurgeOutcome {
  readonly codes: number;
  readonly refreshTokens: number;
  readonly registrations: number;
  readonly revocations: number;
}

/**
 * Delete what has aged out.
 *
 * **Correctness never depends on this running.** Every read applies its own
 * bound — `redeemAuthorizationCode` and `redeemRefreshToken` check `expiresAt`
 * on the record, and `registrationsSince` filters by instant — so an unswept row
 * is never honoured. What the sweep buys is that a table which only grows does
 * not become the thing that pages someone at 3am: an abandoned consent screen
 * leaves a code behind, and codes are minted per authorize attempt.
 *
 * **Called from the worker fleet's tick** (`src/worker/serve.ts`), which is the
 * fleet whose job is cadence and which a Cloudflare cron wakes every thirty
 * minutes regardless of whether anybody is using the connector. The MCP fleet
 * deliberately runs no timer of its own: its instances scale to zero, so a
 * sweeper there would only run while the flow was busy, which is exactly when it
 * has better things to do.
 *
 * **The revocation arm keeps its own retention**, and that is the one line here
 * that is a security decision rather than hygiene — see
 * {@link REVOCATION_RETENTION_SECONDS}. Sweeping revocations on the codes'
 * schedule would un-revoke a grant whose refresh token is still live, which is
 * the failure this whole module exists to end, rebuilt inside the fix for it.
 */
export async function purgeExpiredAuthorizationState(
  sql: SQL,
  options: { readonly now: Date; readonly registrationWindowSeconds?: number },
): Promise<PurgeOutcome> {
  const nowMs = options.now.getTime();
  const registrationWindow = (options.registrationWindowSeconds ?? 60 * 60) * 1000;

  const codes = await deleteReturning(
    sql`DELETE FROM control.oauth_code WHERE expires_at < ${options.now} RETURNING code_digest`,
  );
  const refreshTokens = await deleteReturning(
    sql`DELETE FROM control.oauth_refresh WHERE expires_at < ${options.now} RETURNING token_digest`,
  );
  const registrations = await deleteReturning(
    sql`DELETE FROM control.oauth_registration
        WHERE registered_at < ${new Date(nowMs - registrationWindow)}
        RETURNING registration_id`,
  );
  const revocations = await deleteReturning(
    sql`DELETE FROM control.oauth_revocation
        WHERE revoked_at < ${new Date(nowMs - REVOCATION_RETENTION_SECONDS * 1000)}
        RETURNING grant_id`,
  );

  return { codes, refreshTokens, registrations, revocations };
}

async function deleteReturning(query: Promise<unknown>): Promise<number> {
  const rows = (await query) as unknown[];
  return rows.length;
}
