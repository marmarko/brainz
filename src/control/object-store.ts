/**
 * The production `ErasableObjectStore` (R12 leg 3) — and the first
 * implementation of an object store in `src/` that talks to a real one.
 *
 * **What was here before this file: nothing.** `src/core/lifecycle/erasure.ts`
 * declares the port and says so in its own header — *"There is no production
 * implementation of this port in `src/` yet, so nothing but this re-list
 * constrains the one somebody writes."* U8's `RawStore` has `put` and `get` and
 * also no implementation; the entire object layer was a port set and two
 * in-memory fakes. An erasure receipt that says `object_store: done` was
 * therefore a sentence about a `Map`.
 *
 * ============================================================================
 * IT DERIVES NOTHING
 * ============================================================================
 *
 * `src/README.md`'s second invariant — one derivation site for prefixes and
 * keys — is what R9's whole file-storage claim rests on, and
 * `test/control/accessor-boundary.test.ts` enforces it by scanning this tree.
 * So this module:
 *
 *   * **accepts** a {@link TenantPrefix} and never constructs one. The brand
 *     means the only way to hold the argument is to have obtained it from
 *     `storage.ts`, which is exactly how `eraseAccount` obtains it;
 *   * **never spells the layout.** The root segment is `storage.ts`'s private
 *     business and appears nowhere below;
 *   * **treats every key as opaque.** Listing returns whatever the store says is
 *     there; nothing here parses a key, splits it on a separator, or rebuilds
 *     one.
 *
 * ============================================================================
 * THE THREE CONTROLS
 * ============================================================================
 *
 * **1. The drain.** `list` follows `nextContinuationToken` to exhaustion. S3 and
 * R2 answer 1,000 keys per page, so the obvious implementation — one list, one
 * delete pass — empties a page of a prefix and reports the page's count.
 * `erasure.ts` re-lists afterwards precisely because it could not trust that
 * count, and this is the half that makes the re-list come back empty.
 *
 * **2. Nothing outside the prefix is ever deleted, and a wrong listing is
 * refused whole.** `scripts/probes/r2-boundary/RESULT.md` measured R2 matching
 * prefixes **literally** — a credential scoped to `tenant-a` read `tenant-abc/`
 * at HTTP 200 — so "the store returned a key I did not ask for" is a real state
 * with a measured mechanism behind it, not a hypothetical. The response is to
 * refuse the call rather than to filter the offending keys out and carry on: a
 * store that ignored the scope on the read may equally ignore it on the delete,
 * and the failure mode of guessing wrong is another tenant's objects. The
 * refusal propagates; `eraseAccount` records the leg `failed` and leaves the
 * control-plane row standing, which is the state a re-run can finish from.
 *
 * **3. The credential is the authority; the prefix argument is only a claim.**
 * The port hands a prefix per call and the composition root closes over one
 * tenant's credential, so the two can disagree — a factory built for the wrong
 * tenant is an ordinary wiring mistake and no argument can detect it. A
 * credential carries its own scope (`storage.ts` puts it there so a holder can
 * never re-derive it), so the two are compared and a mismatch refuses before a
 * single request leaves the process.
 *
 * ============================================================================
 * WHAT THIS DOES NOT PROVE
 * ============================================================================
 *
 * No leg of erasure has run against a live vendor. This module is exercised
 * against a loopback server that speaks ListObjectsV2 and `DELETE`
 * (`test/control/erasable-object-store.test.ts`), which proves the pagination
 * protocol and the scope arithmetic and proves nothing about R2's own
 * behaviour. The ledger row (`gap.erasure-path`) carries that gap; this header
 * is not the place it gets quietly promoted.
 *
 * **Deletes are one call each, sequentially.** S3's batch `DeleteObjects` is a
 * POST with a signed XML body and Bun's client does not offer it, so a batch
 * would mean hand-rolling SigV4 over a payload — new machinery on the path that
 * removes somebody's data, to make a rare operation faster. Erasure is not a
 * loop; it runs once per account, ever.
 */

import { S3Client } from 'bun';

import type { ErasableObjectStore } from '../core/lifecycle/erasure.ts';
import { prefixCovers, type ScopedCredential, type TenantPrefix } from './storage.ts';

/**
 * Where the credential for this store's tenant comes from.
 *
 * A callback rather than the accessor itself, because `credentialFor` is keyed
 * on a caller identity and a tenant id and this module holds neither — it is
 * handed a prefix. The composition root owns the mapping and closes over it;
 * what arrives here is a credential that says what it is scoped to, and that is
 * the only thing checked.
 */
export type ScopedCredentialSource = (prefix: TenantPrefix) => Promise<ScopedCredential>;

export interface TenantObjectStoreOptions {
  /** The bucket. Configuration, never a literal in this tree. */
  readonly bucket: string;
  /** The S3-compatible endpoint. Configuration, for the same reason. */
  readonly endpoint: string;
  /** R2 wants `auto`; a real region is accepted for any other implementation. */
  readonly region?: string;
  readonly credentialFor: ScopedCredentialSource;
}

/** R2's own default and S3's maximum. Named so the drain's page count is legible. */
const PAGE_SIZE = 1000;

/**
 * A bound on the drain, so a store that answers every page with the same
 * continuation token cannot spin this process forever. At a thousand keys a
 * page this is ten million objects, which is far past any tenant and far short
 * of an infinite loop.
 */
const MAX_PAGES = 10_000;

export function createTenantObjectStore(options: TenantObjectStoreOptions): ErasableObjectStore {
  /**
   * A client per call rather than one held open: a scoped credential expires
   * (`storage.ts` mints 900s by default and caches strictly below that), and a
   * client built once at construction would carry a dead credential into every
   * later call. The accessor's own cache is what stops this being a mint per
   * request.
   */
  async function clientFor(prefix: TenantPrefix): Promise<S3Client> {
    const credential = await options.credentialFor(prefix);

    // Control 3. Before anything reaches the network: the caller asked to empty
    // one prefix and the composition root supplied authority over another.
    if (credential.prefix !== prefix) {
      throw new Error(
        'invariant: the object-store credential is scoped to a different prefix than the one asked for',
      );
    }

    return new S3Client({
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      sessionToken: credential.sessionToken,
      bucket: options.bucket,
      endpoint: options.endpoint,
      region: options.region ?? 'auto',
    });
  }

  /**
   * Every key under the prefix, across every page.
   *
   * Takes the client so `deletePrefix` can drain and delete under one
   * credential check rather than two — and so the keys it deletes are the keys
   * this same call verified.
   */
  async function drain(client: S3Client, prefix: TenantPrefix): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await client.list({
        prefix,
        maxKeys: PAGE_SIZE,
        ...(continuationToken === undefined ? {} : { continuationToken }),
      });

      for (const entry of response.contents ?? []) {
        // Control 2. `prefixCovers` is the accessor's own model of what the
        // platform enforces, used here as the model of what the platform
        // answered — the same function, so the two can never drift apart.
        if (!prefixCovers(prefix, entry.key)) {
          throw new Error(
            'invariant: the object store listed a key outside the prefix it was asked for',
          );
        }
        keys.push(entry.key);
      }

      // Control 1. `isTruncated` alone is not enough to continue on: a store
      // that says truncated and supplies no token would loop on page one
      // forever, listing the same keys.
      if (response.isTruncated !== true || response.nextContinuationToken === undefined) {
        return keys;
      }
      continuationToken = response.nextContinuationToken;
    }

    throw new Error('invariant: the object-store listing did not terminate within its page bound');
  }

  return {
    async list(prefix: TenantPrefix): Promise<readonly string[]> {
      return await drain(await clientFor(prefix), prefix);
    },

    async deletePrefix(prefix: TenantPrefix): Promise<number> {
      const client = await clientFor(prefix);
      // The whole listing first, and only then any deletion: a refusal from the
      // drain has to happen before the first object goes, or "refuse rather than
      // filter" is a rule that fires after the damage.
      const keys = await drain(client, prefix);

      let removed = 0;
      for (const key of keys) {
        try {
          await client.delete(key);
          removed += 1;
        } catch {
          // Counted as not-removed rather than thrown. `erasure.ts` states the
          // rule this implements: "The listing is the evidence, not
          // `deletePrefix`'s return value." A throw here would abandon the keys
          // after the failing one and report nothing about the ones already
          // gone; returning an honest count lets the caller's re-list say
          // exactly how much of the prefix is still standing.
        }
      }
      return removed;
    },
  };
}
