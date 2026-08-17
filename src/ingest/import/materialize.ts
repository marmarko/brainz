/**
 * Rebuilding what a deferred import named, so the `import` job kind has a
 * handler that can do something.
 *
 * `ImportHandlerDeps.materialize` is the seam `run.ts` declares and leaves to
 * the composition root: *"Injected because only the caller knows how to reach a
 * root, and because a resumed import should see the source as it is now."* Until
 * this module existed there was no implementation of it anywhere in `src/`, so
 * `createImportHandler` was a function with no production caller — one instance
 * of the defect this repo has produced more than any other.
 *
 * ============================================================================
 * ONE DISPATCHER, ONE MATERIALIZER PER TARGET, AND THE JUNK FIELD IS WHY
 * ============================================================================
 *
 * `gateJunk` lives in `src/ingest/junk.ts` at a seam **both** runners reach, and
 * `run.ts` calls it in front of the estimate. Nothing here re-implements that,
 * re-checks it, or falls back to a default when it is absent — the gate is
 * `runImport`'s and it is unconditional. What this module owes it is the input:
 * `ImportItem.junk` *is* the field an importer fills, and an item that arrives
 * without one is priced and embedded as ordinary correspondence.
 *
 * So {@link createImportMaterializer} is a dispatcher and nothing else. It
 * chooses a materializer by target and returns **that materializer's own**
 * `ImportMaterial`, untouched. It does not rebuild items, does not project
 * fields, and therefore cannot drop `junk` on the way past — which is exactly
 * how a mailbox arriving through the folder door (Assumption 1's MBOX fallback)
 * would lose its bulk filtering and be embedded at full price, the cost
 * `junk.ts` calls the single largest avoidable one in the product. A new
 * importer is a new entry in the map; it is not an edit here.
 *
 * ============================================================================
 * WHAT IS REACHABLE TODAY, NAMED RATHER THAN IMPLIED
 * ============================================================================
 *
 *   * **`chat_export` is complete.** The manifest names an object key under the
 *     tenant's own prefix; this reads those bytes back and re-parses them, which
 *     is R16's raw-payload promise being spent rather than merely stored.
 *   * **`folder` has no materializer in a fleet container**, and the refusal is
 *     the honest answer rather than a gap left open. `createDirectoryFolderSource`
 *     walks a local directory; a worker instance has no access to the user's
 *     filesystem, and no upload path exists that would put one inside the
 *     container. A materializer that scanned *something* would import an empty
 *     root — and an empty completed scan tombstones every page under it
 *     (`folder.ts:tombstoneMissing`), which is the user's corpus deleted by a
 *     wiring convenience. So the target refuses, loudly, and the job walks the
 *     runner's dead-letter ladder rather than succeeding at nothing.
 */

import { parseChatExportBytes } from './chat-export.ts';
import type { ImportItem, ImportMaterial, TenantRuntime } from './run.ts';
import { rawKeyFor, type DeferredImport, type RawStore } from './raw.ts';
import type { ImportTarget } from '../first-import.ts';
import type { TenantStorage } from '../../control/storage.ts';

/**
 * How one target's material is rebuilt. Returns `ImportMaterial` whole, because
 * the dispatcher must have nothing to project — see the header.
 */
export type TargetMaterializer = (
  manifest: DeferredImport,
  tenant: TenantRuntime,
) => Promise<ImportMaterial>;

/**
 * Thrown when a job names a target this deployment cannot rebuild.
 *
 * A throw rather than empty material, and the difference is a corpus. Empty
 * material with a tombstone request is a completed scan that saw nothing, which
 * soft-deletes every page under the root; empty material without one is a job
 * that reports success having imported nothing, so the user's export is marked
 * done and never retried. The runner's ladder is the surface for "this cannot be
 * served", the same one `TenantNotConsolidableError` uses.
 */
export class ImportTargetUnavailableError extends Error {
  readonly target: ImportTarget;

  constructor(target: ImportTarget, detail: string) {
    super(`no materializer for import target '${target}' on this deployment: ${detail}`);
    this.name = 'ImportTargetUnavailableError';
    this.target = target;
  }
}

/** Why a target is absent, in one sentence an operator can act on. */
const ABSENT_TARGET_DETAIL: Readonly<Record<ImportTarget, string>> = {
  chat_export:
    'no object store is configured, so the stored export cannot be read back — see `src/control/storage.ts`, which has no production credential minter',
  folder:
    'a fleet container has no access to the user’s filesystem and this deployment has no upload path, so there is no root to re-scan',
};

export function createImportMaterializer(
  targets: Partial<Record<ImportTarget, TargetMaterializer>>,
): TargetMaterializer {
  return async (manifest, tenant) => {
    const materialize = targets[manifest.target];
    if (materialize === undefined) {
      throw new ImportTargetUnavailableError(manifest.target, ABSENT_TARGET_DETAIL[manifest.target]);
    }
    // Returned as it came back. The dispatcher owns the choice and owns nothing
    // about the content — see the header on why that is load-bearing.
    return await materialize(manifest, tenant);
  };
}

export interface ChatExportMaterializerDeps {
  readonly rawStore: RawStore;
  /** The accessor. The only place a key is derived — `src/README.md`'s second invariant. */
  readonly storage: TenantStorage;
}

/**
 * A stored chat export, parsed again.
 *
 * **The bytes are re-read rather than carried.** `DeferredImport` names *where*
 * the material is and never the material, so a resumed import re-derives its
 * pages from the payload the first pass preserved. `test/ingest/chat-export.test.ts`
 * already pins that re-parsing the stored bytes reproduces identical pages,
 * which is what makes this a resume rather than a second import.
 *
 * **`raw` is null on the way back out.** The bytes are already under the
 * tenant's prefix — that is how this function found them — and handing them to
 * `runImport` again would re-run the preservation step it performs before the
 * gate, paying for a write of an object that is already there.
 *
 * **No `junk`, and it is absent rather than defaulted.** A transcript carries no
 * provider headers, and `ImportItem` documents an absent signal as ordinary
 * content on purpose: reading "no headers" as junk would quarantine every chat
 * export wholesale, and nothing would report it.
 */
export function createChatExportMaterializer(
  deps: ChatExportMaterializerDeps,
): TargetMaterializer {
  return async (manifest, tenant) => {
    const rawId = manifest.rawKey;
    if (rawId === undefined || rawId.length === 0) {
      throw new ImportTargetUnavailableError(
        'chat_export',
        'the manifest names no stored payload, so there is nothing to re-parse',
      );
    }

    const key = rawKeyFor(deps.storage, tenant.caller, tenant.tenantId, rawId);
    if (!key.ok) {
      throw new ImportTargetUnavailableError(
        'chat_export',
        `the accessor refused a key for the stored payload (${key.reason})`,
      );
    }

    const stored = await deps.rawStore.get(key.key);
    if (stored === null) {
      // Not an empty import. The gate approved a ceiling for material that is
      // now missing, and completing the job would mark the user's export
      // imported when nothing was.
      throw new ImportTargetUnavailableError(
        'chat_export',
        'the preserved payload is no longer in the object store',
      );
    }

    const parsed = parseChatExportBytes(stored.bytes);
    const items: ImportItem[] = parsed.conversations.map((conversation) => ({
      externalRef: conversation.externalRef,
      title: conversation.title,
      body: conversation.body,
      occurredAt: conversation.occurredAt,
    }));

    return {
      items,
      // Carried rather than dropped: a conversation the parser could not read is
      // a row in the ingest log, and an export whose failures vanished on resume
      // would look complete to the user who is missing nine thousand pages.
      failures: parsed.failures.map((failure) => ({
        externalRef: failure.externalRef,
        reason: 'parse_failed' as const,
      })),
      raw: null,
    };
  };
}
