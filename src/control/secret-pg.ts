/**
 * The durable secret backend: one row per namespace, in the control plane.
 *
 * **The failure this exists to end.** `secret-file.ts` writes a JSON file, and
 * the deployment has no shared volume — the image materialises
 * `BRAINZ_SECRETS_JSON` into a fresh temporary file at every container start.
 * So a signup served by the web fleet banked its tenant's connection string and
 * bearer into *that container's own copy*: the MCP fleet answered
 * `{"error":"invalid_grant"}` on `/token` for a brain that demonstrably existed,
 * and the only copy of the credential died with the instance. Both halves are
 * one property — a writer in one process and a reader in another must agree —
 * and a store that cannot express it is not a store.
 *
 * **Why the control plane.** It is the substrate both fleets already hold
 * (`BRAINZ_CONTROL_DATABASE_URL`), reachable over ordinary outbound TCP from a
 * Container (settled by probe), strongly consistent — so "provisioned at T,
 * resolvable at T+1s" is read-your-writes rather than a propagation promise —
 * and transactional with the tenant row that references these entries. The
 * alternatives were weighed and lost for structural reasons, not taste: a
 * Container holds no Workers bindings, so KV or Secrets Store would mean an
 * account-scoped API token inside the process that parses attacker-supplied
 * content (or a new authenticated hop through the router on every tool call),
 * and KV's eventual consistency cannot answer the requirement at all.
 *
 * **Every value is sealed.** `sealed.ts` holds the argument; the short version
 * is that a plaintext DSN here would make a control-plane dump equal to every
 * tenant's brain, which is precisely what the content-free rule was buying. The
 * envelope is bound to its namespace, so a row copied from one tenant onto
 * another fails to open rather than handing over the neighbour's database.
 *
 * **A read is a read-through, and the cache above it stays the only cache.**
 * `createTenantSecretStore` bounds how long a resolved entry may be served and
 * invalidates on write; a second cache here would outlive that invalidation,
 * which is the same mistake in a new place.
 *
 * **What is deliberately NOT here: a `not_found` for a broken row.** An absent
 * row is `undefined`. A row that will not open — wrong key, wrong namespace,
 * altered bytes — throws. `secrets.ts` says a backend failure must never be
 * flattened into "this tenant does not exist", and a fleet booted with the wrong
 * key must look like a broken fleet, not like a database that lost everybody.
 */

import type { SQL, TransactionSQL } from 'bun';

import type { ProviderKeyBackend } from '../ai/keys.ts';
import { parseSecretStoreJson, type SecretStoreShape } from './secret-file.ts';
import { seal, unseal } from './sealed.ts';
import type { SecretBackend, TenantSecret } from './secrets.ts';

/**
 * The bound this module refuses at, below the column's own.
 *
 * `control.sealed_envelope` tops out at 2048 characters, which is about 1500
 * ciphertext bytes. Refusing here means an oversized value fails with a sentence
 * naming the namespace, rather than as a CHECK violation from a driver.
 */
export const MAX_SEALED_PLAINTEXT_BYTES = 1400;

/**
 * The advisory lock the schema ensure takes. A literal, distinct from
 * `migrate.ts:SCHEMA_MIGRATION_LOCK_KEY`: two different serialisations sharing a
 * key is a deadlock nobody can find from the code.
 */
export const SECRET_STORE_LOCK_KEY = 80_120_264;

const DDL_PATH = `${import.meta.dir}/secret-store.sql`;

export interface PostgresSecretStoreOptions {
  /**
   * The control-plane handle. The process's existing one — this store is a
   * request-path read behind a cache, not a reason for a second pool.
   */
  readonly sql: SQL;
  /** From `sealed.ts:importSealingKey`. Never a raw string: a key is imported once. */
  readonly key: CryptoKey;
}

export interface PostgresSecretStore {
  readonly secrets: SecretBackend;
  readonly providerKeys: ProviderKeyBackend;
}

export class SecretStoreError extends Error {
  readonly namespace: string;

  constructor(namespace: string, detail: string) {
    super(`the secret store cannot hold ${JSON.stringify(namespace)}: ${detail}`);
    this.name = 'SecretStoreError';
    this.namespace = namespace;
  }
}

/**
 * Both backends over one table, split by namespace prefix.
 *
 * The same arrangement `secret-file.ts` makes with two sections of one file, for
 * the same reason: they share a lifetime, a substrate and a key, so a second
 * table would buy a second way to get the sealing wrong rather than a boundary.
 * The boundary is the namespace — `secrets.ts` owns `tenant/` and `pool/`,
 * `keys.ts` owns `provider-key/`, and neither module can address the other's.
 */
export function createPostgresSecretStore(
  options: PostgresSecretStoreOptions,
): PostgresSecretStore {
  const { sql, key } = options;

  async function readPlaintext(namespace: string): Promise<string | undefined> {
    const rows = (await sql`
      SELECT sealed FROM control.tenant_secret WHERE namespace = ${namespace}
    `) as Array<{ sealed: string }>;
    const row = rows[0];
    if (row === undefined) return undefined;
    return unseal(key, namespace, row.sealed);
  }

  async function writePlaintext(namespace: string, plaintext: string): Promise<void> {
    const size = Buffer.byteLength(plaintext, 'utf8');
    if (size > MAX_SEALED_PLAINTEXT_BYTES) {
      throw new SecretStoreError(namespace, `${size} bytes exceeds ${MAX_SEALED_PLAINTEXT_BYTES}`);
    }
    const sealed = await seal(key, namespace, plaintext);
    await sql`
      INSERT INTO control.tenant_secret (namespace, sealed) VALUES (${namespace}, ${sealed})
      ON CONFLICT (namespace) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = now()
    `;
  }

  async function remove(namespace: string): Promise<void> {
    await sql`DELETE FROM control.tenant_secret WHERE namespace = ${namespace}`;
  }

  return {
    secrets: {
      async get(namespace: string): Promise<TenantSecret | undefined> {
        const plaintext = await readPlaintext(namespace);
        if (plaintext === undefined) return undefined;
        return pairOf(namespace, plaintext);
      },
      put(namespace: string, secret: TenantSecret): Promise<void> {
        return writePlaintext(namespace, encodePair(secret));
      },
      delete: remove,
    },

    providerKeys: {
      async get(namespace: string): Promise<string | undefined> {
        const plaintext = await readPlaintext(namespace);
        if (plaintext === undefined) return undefined;
        return keyOf(namespace, plaintext);
      },
      put(namespace: string, providerKey: string): Promise<void> {
        return writePlaintext(namespace, JSON.stringify(providerKey));
      },
      delete: remove,
    },
  };
}

/**
 * The two shapes a sealed plaintext may take, and the one place they are read.
 *
 * JSON in both cases, so the sealed bytes are self-describing and a namespace
 * read under the wrong adapter is a typed refusal rather than a string that
 * happens to parse. A malformed payload **throws** — unlike the file backend,
 * which skips a malformed entry because a file is hand-editable and a typo there
 * is one entry's problem. A row here was written by this module, so a shape it
 * cannot read means the key or the store is wrong, and answering `not_found`
 * would report that as an empty brain.
 */
function encodePair(secret: TenantSecret): string {
  return JSON.stringify({
    connectionString: secret.connectionString,
    bearerGrant: secret.bearerGrant,
  });
}

function pairOf(namespace: string, plaintext: string): TenantSecret {
  const parsed = parseJson(namespace, plaintext);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SecretStoreError(namespace, 'the sealed payload is not an object');
  }
  const record = parsed as Record<string, unknown>;
  const connectionString = record['connectionString'];
  const bearerGrant = record['bearerGrant'];
  // Same admission rule as the file backend: an empty connection string is a DSN
  // a driver would dial, and an empty bearer is legal (a pool entry has none).
  if (typeof connectionString !== 'string' || connectionString.length === 0) {
    throw new SecretStoreError(namespace, 'the sealed payload carries no connection string');
  }
  if (typeof bearerGrant !== 'string') {
    throw new SecretStoreError(namespace, 'the sealed payload carries no bearer grant');
  }
  return { connectionString, bearerGrant };
}

function keyOf(namespace: string, plaintext: string): string {
  const parsed = parseJson(namespace, plaintext);
  if (typeof parsed !== 'string' || parsed.length === 0) {
    throw new SecretStoreError(namespace, 'the sealed payload is not a provider key');
  }
  return parsed;
}

function parseJson(namespace: string, plaintext: string): unknown {
  try {
    return JSON.parse(plaintext);
  } catch (error) {
    throw new SecretStoreError(
      namespace,
      `the sealed payload is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Schema.
// ---------------------------------------------------------------------------

/**
 * Create the store's tables if this control plane does not have them yet.
 *
 * **Why at runtime rather than in `schema.sql`.** The live control plane was
 * created from `schema.sql` by hand, before this table existed; a deployment
 * that needs an operator to remember a `psql` step is a deployment that fails
 * for the next person. The DDL is read from `secret-store.sql` — the file the
 * content-free guard scans — so there is exactly one copy of it.
 *
 * **Called at process start, not lazily.** `env.ts` puts the whole weight on
 * refusing to start rather than failing at the first request: a fleet that
 * cannot create or reach its secret store should crash-loop visibly, not answer
 * one user's tool call with a 500.
 *
 * Concurrent starts are ordinary here — three fleets deploy at once, and each
 * has three entrypoints' worth of processes — so the create runs under an
 * advisory lock with the existence check repeated inside it. `CREATE DOMAIN` has
 * no `IF NOT EXISTS`, which is exactly why the guard is a lock and a re-check
 * rather than a hopeful `IF NOT EXISTS` on the table.
 *
 * **And the lock is still not sufficient, which was measured rather than
 * assumed.** A transaction that has already issued a statement can evaluate its
 * catalog re-check against a view of the catalog older than the winner's commit
 * — three concurrent calls produce one success and two `42710 type … already
 * exists`. So the loser's refusal is caught and answered with a question rather
 * than a guess: *is the store there now?* If it is, another process did the work
 * and this one is finished. If it is not, the error was about something else and
 * it is re-thrown, because a fleet that cannot create its secret store must
 * crash-loop rather than start without one.
 */
export async function ensureSecretStoreSchema(sql: SQL): Promise<void> {
  if (await storePresent(sql)) return;

  const ddl = await Bun.file(DDL_PATH).text();
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${SECRET_STORE_LOCK_KEY})`;
      if (await storePresent(tx)) return;
      await tx.unsafe(ddl);
    });
  } catch (error) {
    // A fresh statement on a fresh transaction, so this sees whatever the
    // winner committed. The contract is the goal state, not the mechanism.
    if (!(await storePresent(sql))) throw error;
  }
}

async function storePresent(sql: SQL | TransactionSQL): Promise<boolean> {
  const rows = (await sql`
    SELECT to_regclass('control.tenant_secret') IS NOT NULL AS present
  `) as Array<{ present: boolean }>;
  return rows[0]?.present === true;
}

// ---------------------------------------------------------------------------
// The bootstrap seed.
// ---------------------------------------------------------------------------

export interface SeedOutcome {
  /** False when this exact blob has already been imported, by anyone, ever. */
  readonly applied: boolean;
  readonly digest: string;
  /** Namespaces actually inserted. Zero is the ordinary answer on a warm store. */
  readonly entries: number;
}

export interface SeedOptions {
  readonly sql: SQL;
  readonly key: CryptoKey;
  /** The seed file's bytes, exactly as written. The digest is taken over these. */
  readonly text: string;
  /** For the error message when the blob is not JSON. */
  readonly source: string;
}

/**
 * Import `BRAINZ_SECRETS_JSON` once, ever.
 *
 * **This is what `BRAINZ_SECRETS_JSON` is now.** It was the store; two stores
 * that disagree about a tenant's bearer is the failure this whole change is
 * about, so it is demoted to a one-way seed with two properties that make
 * disagreement structurally impossible:
 *
 *   * **Once, ever, per blob.** The digest is claimed with `ON CONFLICT DO
 *     NOTHING` in the same transaction as the entries, so a container restarting
 *     with a stale snapshot in its environment cannot resurrect a tenant that was
 *     revoked from the durable store. A blob that *changes* (an operator adds an
 *     entry) has a new digest and is imported once too.
 *   * **Never an overwrite.** Each entry is `ON CONFLICT DO NOTHING`, so the seed
 *     can introduce a namespace the store has never held and can never replace
 *     one it holds. The durable store is authoritative from its first write.
 *
 * The canary tenant — whose credentials only ever existed inside that blob — is
 * therefore migrated by the first fleet that starts, with no operator step. Once
 * `control.secret_seed` has a row, the secret can be deleted from the Worker and
 * nothing changes.
 */
export async function importSecretSeed(options: SeedOptions): Promise<SeedOutcome> {
  const { sql, key, text, source } = options;
  const digest = new Bun.CryptoHasher('sha256').update(text).digest('hex');
  const seed = parseSecretStoreJson(text, source);

  return sql.begin(async (tx) => {
    const claimed = (await tx`
      INSERT INTO control.secret_seed (digest) VALUES (${digest})
      ON CONFLICT (digest) DO NOTHING
      RETURNING digest
    `) as Array<{ digest: string }>;
    if (claimed.length === 0) return { applied: false, digest, entries: 0 };

    let entries = 0;
    for (const [namespace, pair] of Object.entries(seed.secrets)) {
      entries += await insertIfAbsent(tx, key, namespace, encodePair(pair));
    }
    for (const [namespace, providerKey] of Object.entries(seed.providerKeys)) {
      entries += await insertIfAbsent(tx, key, namespace, JSON.stringify(providerKey));
    }

    await tx`UPDATE control.secret_seed SET entries = ${entries} WHERE digest = ${digest}`;
    return { applied: true, digest, entries };
  }) as Promise<SeedOutcome>;
}

async function insertIfAbsent(
  tx: TransactionSQL,
  key: CryptoKey,
  namespace: string,
  plaintext: string,
): Promise<number> {
  const sealed = await seal(key, namespace, plaintext);
  const inserted = (await tx`
    INSERT INTO control.tenant_secret (namespace, sealed) VALUES (${namespace}, ${sealed})
    ON CONFLICT (namespace) DO NOTHING
    RETURNING namespace
  `) as Array<{ namespace: string }>;
  return inserted.length;
}

export type { SecretStoreShape };
