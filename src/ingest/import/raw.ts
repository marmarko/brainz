/**
 * Raw-payload preservation (R16) and the deferred-import manifest.
 *
 * **Why the raw bytes are kept.** Extraction improves. A parser that learns to
 * read ChatGPT's `multimodal_text` parts, or a chunker that stops splitting
 * mid-sentence, is worth nothing on content the fleet no longer has — and a
 * user exports their chat history once. So the export is stored under the
 * tenant's own prefix before it is parsed, and re-deriving is a job rather than
 * an apology.
 *
 * **A failed raw write stops the import.** It is not a warning and it is not
 * best-effort: an import that proceeds when preservation failed produces pages
 * that can never be re-derived, and nothing downstream can tell them apart from
 * pages that can. The typed stop is the whole value of the promise.
 *
 * **No key is built here.** `src/control/storage.ts` is the one place a tenant
 * id becomes a prefix or a key (`src/README.md`'s second invariant), and R2's
 * measured semantics — a *literal* leading-substring match, so `tenant-a` reads
 * `tenant-abc/` — are why that is enforced by a scan rather than agreed. This
 * module asks that accessor for keys and holds nothing but the resulting
 * branded values.
 *
 * **The manifest is keyed by job id, and by nothing else.** A deferred import
 * has to survive the gap between "enqueued" and "some worker claims it", and
 * `control.job` is content-free by construction — it cannot hold a folder path
 * or an object key. It can hold the job id, because it *is* the job id, and
 * `job_one_open_per_tenant_kind_target` already guarantees at most one open
 * import per tenant and target. So the manifest lands at
 * `{tenant}/imports/{jobId}` and the handler reads it from the lease it was
 * given. No pointer in either database.
 */

import type { CallerIdentity } from '../../control/secrets.ts';
import type { KeyResult, ObjectKey, TenantStorage } from '../../control/storage.ts';
import type { SourceType } from '../../core/write/write-path.ts';
import type { ImportTarget, ImportWindow } from '../first-import.ts';

/** The collection segment R16 names: `{tenant}/raw/`. */
export const RAW_COLLECTION = 'raw';

/** Where a deferred import's manifest lives: `{tenant}/imports/{jobId}`. */
export const MANIFEST_COLLECTION = 'imports';

export interface RawObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/**
 * The object store, behind a port. The production implementation talks to R2
 * with a credential minted by `src/control/storage.ts`; tests get the in-memory
 * one below, which is why nothing in this unit's suite touches the network.
 */
export interface RawStore {
  put(key: ObjectKey, object: RawObject): Promise<void>;
  get(key: ObjectKey): Promise<RawObject | null>;
}

export interface InMemoryRawStore extends RawStore {
  readonly keys: readonly string[];
  /** Make the next `put` fail, so the typed stop can be observed. */
  failNextPut(error?: Error): void;
}

/**
 * What a deferred import needs to resume, and nothing more.
 *
 * It names *where the material is*, never the material: a chat export is an
 * object key under the tenant's own prefix, a folder is a root id the caller's
 * source resolver understands. Both are re-read at resume time, so a manifest
 * is small and a resumed import sees the world as it is now rather than as it
 * was when the gate ran.
 */
export interface DeferredImport {
  readonly tenantId: string;
  readonly target: ImportTarget;
  readonly originContext: string;
  readonly sourceType: SourceType;
  readonly window: ImportWindow;
  /** Chat export: the stored payload. */
  readonly rawKey?: string;
  /** Folder: the root the caller's resolver can re-scan. */
  readonly rootId?: string;
  /** What the gate approved. The resumed run's budget cap, not a suggestion. */
  readonly approvedMicroUsd: number;
}

export function createInMemoryRawStore(): InMemoryRawStore {
  const objects = new Map<string, RawObject>();
  let failure: Error | null = null;

  return {
    get keys() {
      return [...objects.keys()].sort();
    },
    failNextPut(error?: Error) {
      failure = error ?? new Error('raw store unavailable');
    },
    put(key, object) {
      if (failure !== null) {
        const thrown = failure;
        failure = null;
        return Promise.reject(thrown);
      }
      objects.set(key, { bytes: new Uint8Array(object.bytes), contentType: object.contentType });
      return Promise.resolve();
    },
    get(key) {
      const found = objects.get(key);
      return Promise.resolve(
        found === undefined
          ? null
          : { bytes: new Uint8Array(found.bytes), contentType: found.contentType },
      );
    },
  };
}

/** `{tenant}/raw/<digest of the untrusted id>`. The id is hashed, not sanitised:
 * an export's own name is the user's, and a sanitiser is a losing game against
 * percent-encoding. */
export function rawKeyFor(
  storage: TenantStorage,
  caller: CallerIdentity,
  tenantId: string,
  untrustedId: string,
): KeyResult {
  return storage.keyForUntrusted(caller, tenantId, RAW_COLLECTION, untrustedId);
}

/**
 * `{tenant}/imports/<jobId>`.
 *
 * A uuid is already inside the accessor's segment alphabet, so this is a
 * trusted segment rather than a hashed one — and it has to be, because the
 * handler derives the same key from the lease it was given and would have no
 * way to reproduce a hash of something it never saw.
 */
export function manifestKeyFor(
  storage: TenantStorage,
  caller: CallerIdentity,
  tenantId: string,
  jobId: string,
): KeyResult {
  return storage.keyFor(caller, tenantId, [MANIFEST_COLLECTION, jobId]);
}

export async function writeManifest(
  store: RawStore,
  key: ObjectKey,
  manifest: DeferredImport,
): Promise<void> {
  await store.put(key, {
    bytes: new TextEncoder().encode(JSON.stringify(manifest)),
    contentType: 'application/json',
  });
}

/**
 * Null when nothing is stored there, or when what is stored is not a manifest.
 *
 * Validated rather than cast: this object is read back by a worker that will
 * spend money on what it says, and "trust the bytes under our own prefix" is
 * exactly the assumption that makes a storage bug into a billing bug.
 */
export async function readManifest(
  store: RawStore,
  key: ObjectKey,
): Promise<DeferredImport | null> {
  const stored = await store.get(key);
  if (stored === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(stored.bytes));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Readonly<Record<string, unknown>>;

  const tenantId = record.tenantId;
  const target = record.target;
  const originContext = record.originContext;
  const sourceType = record.sourceType;
  const approved = record.approvedMicroUsd;
  const window = record.window;

  if (typeof tenantId !== 'string' || tenantId.length === 0) return null;
  if (target !== 'chat_export' && target !== 'folder') return null;
  if (typeof originContext !== 'string' || originContext.length === 0) return null;
  if (typeof sourceType !== 'string' || sourceType.length === 0) return null;
  if (!Number.isSafeInteger(approved) || (approved as number) < 0) return null;

  const resolvedWindow: ImportWindow =
    window === 'all'
      ? 'all'
      : typeof window === 'object' &&
          window !== null &&
          Number.isFinite((window as { days?: unknown }).days)
        ? { days: Number((window as { days: number }).days) }
        : 'all';

  return {
    tenantId,
    target,
    originContext,
    sourceType: sourceType as SourceType,
    window: resolvedWindow,
    ...(typeof record.rawKey === 'string' ? { rawKey: record.rawKey } : {}),
    ...(typeof record.rootId === 'string' ? { rootId: record.rootId } : {}),
    approvedMicroUsd: approved as number,
  };
}
