/**
 * A secret backend a running fleet process can actually read.
 *
 * **Why this exists at all.** `secrets.ts` ships one backend,
 * `createInMemorySecretBackend`, and says of it: *"for tests and local
 * development. Never for production."* Nothing else implemented
 * {@link SecretBackend}, so every entrypoint composed from this repo would have
 * held its tenants' connection strings in a `Map` that dies with the process —
 * which makes "signup provisioned a brain" false on the next restart, and makes
 * the MCP fleet unable to resolve any tenant it did not itself create. A store
 * that does not survive the process is not a store.
 *
 * **What this is, honestly.** A JSON file on a volume the operator controls,
 * created `0600`, rewritten atomically. That is the right backend for a
 * self-hosted deployment and for a single-node alpha; it is **not** the managed
 * secret manager `wrangler.toml` describes, and it does not pretend to be — it
 * offers no rotation log, no per-key audit and no envelope encryption. When the
 * managed store lands it implements the same {@link SecretBackend} port and
 * nothing above this line changes.
 *
 * **Read-through on every get, no in-process cache.** The cache and its TTL
 * belong to `createTenantSecretStore`, which already bounds how long a resolved
 * entry may be served and already invalidates on write. A second cache here
 * would outlive that invalidation — the web process provisions a tenant, and the
 * MCP process serves the previous answer for as long as its own layer chose to.
 *
 * **The file is read-modify-written under an in-process lock**, which is what
 * makes two concurrent provisions in one process safe. Two *processes* writing
 * the same file is not safe and is not the deployment: provisioning happens in
 * the web process alone, and the fleets only read. That boundary is stated
 * because it is the assumption a second writer would silently break.
 */

import { chmodSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';

import type { ProviderKeyBackend } from '../ai/keys.ts';
import type { SecretBackend, TenantSecret } from './secrets.ts';

/** Owner read/write. A secrets file the group can read is not a secrets file. */
const FILE_MODE = 0o600;

interface FileShape {
  /** Namespace (`tenant/…`, `pool/…`) to the pair `secrets.ts` stores. */
  readonly secrets: Record<string, { connectionString: string; bearerGrant: string }>;
  /** Namespace (`provider-key/…`) to the key itself (R22's BYOK entries). */
  readonly providerKeys: Record<string, string>;
}

const EMPTY: FileShape = { secrets: {}, providerKeys: {} };

export interface FileSecretStoreOptions {
  readonly path: string;
}

export interface FileSecretStore {
  readonly secrets: SecretBackend;
  readonly providerKeys: ProviderKeyBackend;
}

/**
 * Both backends over one file.
 *
 * One file rather than two because they share a lifetime, a volume and a
 * permission: an operator who can read one can read the other, so splitting them
 * would buy a second path to get the mode wrong rather than a boundary. The
 * *namespaces* stay separate, which is where the boundary actually is — the
 * provider-key namespace is `keys.ts`'s and the secret namespaces are
 * `secrets.ts`'s, and neither module can address the other's.
 */
export function createFileSecretStore(options: FileSecretStoreOptions): FileSecretStore {
  const { path } = options;

  /** Serialises read-modify-write within this process. See the header. */
  let writes: Promise<void> = Promise.resolve();

  async function read(): Promise<FileShape> {
    const file = Bun.file(path);
    if (!(await file.exists())) return EMPTY;
    const text = await file.text();
    if (text.trim().length === 0) return EMPTY;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      // Not a shrug and not an empty store: a corrupt secrets file read as
      // "no tenants" is a fleet that answers `not_found` for every brain it
      // holds, which reads as data loss and is a parse error.
      throw new Error(
        `the secrets file at ${path} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`the secrets file at ${path} is not a JSON object`);
    }

    const record = parsed as Record<string, unknown>;
    return {
      secrets: sectionOfPairs(record['secrets']),
      providerKeys: sectionOfStrings(record['providerKeys']),
    };
  }

  /**
   * Write through a temporary file in the same directory, then rename.
   *
   * A rename within one filesystem is atomic, so a reader never sees a half
   * written store and a crash mid-write leaves the previous one intact. The mode
   * is set on the temporary file *before* the rename, so the entry is never
   * momentarily world-readable under its real name.
   */
  async function write(next: FileShape): Promise<void> {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: FILE_MODE });
    chmodSync(temporary, FILE_MODE);
    await rename(temporary, path);
  }

  function mutate(change: (current: FileShape) => FileShape): Promise<void> {
    const next = writes.then(async () => {
      await write(change(await read()));
    });
    // The chain must not break on one failed write, or every later write in the
    // process is refused by an already-rejected promise.
    writes = next.catch(() => undefined);
    return next;
  }

  return {
    secrets: {
      async get(namespace: string): Promise<TenantSecret | undefined> {
        const stored = (await read()).secrets[namespace];
        return stored === undefined
          ? undefined
          : { connectionString: stored.connectionString, bearerGrant: stored.bearerGrant };
      },
      put(namespace: string, secret: TenantSecret): Promise<void> {
        return mutate((current) => ({
          ...current,
          secrets: {
            ...current.secrets,
            [namespace]: {
              connectionString: secret.connectionString,
              bearerGrant: secret.bearerGrant,
            },
          },
        }));
      },
      delete(namespace: string): Promise<void> {
        return mutate((current) => {
          const { [namespace]: _removed, ...rest } = current.secrets;
          return { ...current, secrets: rest };
        });
      },
    },

    providerKeys: {
      async get(namespace: string): Promise<string | undefined> {
        return (await read()).providerKeys[namespace];
      },
      put(namespace: string, key: string): Promise<void> {
        return mutate((current) => ({
          ...current,
          providerKeys: { ...current.providerKeys, [namespace]: key },
        }));
      },
      delete(namespace: string): Promise<void> {
        return mutate((current) => {
          const { [namespace]: _removed, ...rest } = current.providerKeys;
          return { ...current, providerKeys: rest };
        });
      },
    },
  };
}

function sectionOfPairs(
  value: unknown,
): Record<string, { connectionString: string; bearerGrant: string }> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, { connectionString: string; bearerGrant: string }> = {};
  for (const [namespace, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const pair = entry as Record<string, unknown>;
    const connectionString = pair['connectionString'];
    const bearerGrant = pair['bearerGrant'];
    // A malformed entry is skipped rather than defaulted: an empty connection
    // string is a DSN the driver would try to dial, and an empty bearer is a
    // credential somebody could present.
    if (typeof connectionString !== 'string' || connectionString.length === 0) continue;
    if (typeof bearerGrant !== 'string') continue;
    out[namespace] = { connectionString, bearerGrant };
  }
  return out;
}

function sectionOfStrings(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return {};
  const out: Record<string, string> = {};
  for (const [namespace, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && entry.length > 0) out[namespace] = entry;
  }
  return out;
}
