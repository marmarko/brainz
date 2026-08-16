/**
 * The production `ErasableObjectStore` — the port R12's third leg had no
 * implementation of.
 *
 * `src/core/lifecycle/erasure.ts` says it in its own header: *"There is no
 * production implementation of this port in `src/` yet, so nothing but this
 * re-list constrains the one somebody writes."* This file is the other half of
 * that sentence — the implementation, and the constraints made into tests
 * rather than left as a paragraph the implementer may not read.
 *
 * **The wire is real; the vendor is not.** Every test below runs
 * `Bun.S3Client` against a loopback `Bun.serve` that speaks ListObjectsV2 and
 * `DELETE`. That is deliberately not a hand-rolled fake of *our own* code: the
 * failure the erasure header names — an implementation that lists a page,
 * deletes a page, and reports success over a prefix it only partly emptied —
 * lives in the continuation-token protocol, and a fake with no protocol cannot
 * provoke it. What is NOT proven here is R2 itself; no leg of erasure has run
 * against a live vendor, and the ledger says so.
 *
 * **Three controls, and each has a test that dies without it.**
 *
 *  1. **The drain.** `list` follows `nextContinuationToken` until the store
 *     says it is done. One page is the naive shape and is the one that reports
 *     a prefix emptied when it is not.
 *  2. **Nothing outside the prefix is ever deleted.** R2 was *measured* to match
 *     prefixes literally (`scripts/probes/r2-boundary/RESULT.md`), so a
 *     mis-scoped or ignored `prefix` parameter returns a sibling tenant's keys
 *     and the obvious implementation deletes them. The store refuses the whole
 *     call rather than filtering quietly — a listing that came back wrong is not
 *     a listing to act on part of.
 *  3. **The credential is the authority, the argument is only a claim.** The
 *     store is handed a prefix per call and a credential per tenant; if the
 *     credential is scoped somewhere else, the call is refused before a single
 *     request goes out.
 *
 * No prefix is constructed here — `createTenantStorage().prefixFor` derives
 * every one of them, exactly as `erasure.ts` does, which is what keeps this file
 * on the right side of `test/control/accessor-boundary.test.ts`'s rule.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { createTenantObjectStore } from '../../src/control/object-store.ts';
import { fleetIdentity } from '../../src/control/secrets.ts';
import {
  createInMemoryCredentialMinter,
  createTenantStorage,
  type ScopedCredential,
  type TenantPrefix,
} from '../../src/control/storage.ts';

const BUCKET = 'brainz-test';
const TENANT = 'objects-alice';
/** A sibling, not a stranger: `alice2/` is what a literal prefix match reaches. */
const SIBLING = 'objects-alice2';

const storage = createTenantStorage({
  minter: createInMemoryCredentialMinter({
    parentAccessKeyId: 'parent-key-id',
    parentSecretAccessKey: 'parent-secret',
  }),
});

function prefixOf(tenantId: string): TenantPrefix {
  const derived = storage.prefixFor(fleetIdentity(tenantId), tenantId);
  if (!derived.ok) throw new Error(`fixture: could not derive a prefix (${derived.reason})`);
  return derived.prefix;
}

async function credentialOf(tenantId: string): Promise<ScopedCredential> {
  const minted = await storage.credentialFor(fleetIdentity(tenantId), tenantId);
  if (!minted.ok) throw new Error(`fixture: could not mint a credential (${minted.reason})`);
  return minted.credential;
}

// ---------------------------------------------------------------------------
// A loopback object store that speaks enough S3 to be wrong in the ways R2 is.
// ---------------------------------------------------------------------------

interface FakeOptions {
  /** Keys per ListObjectsV2 page. Small, so pagination is reachable in a test. */
  readonly pageSize?: number;
  /**
   * Ignore the `prefix` parameter and list the whole bucket. Models a
   * mis-scoped endpoint, a proxy that drops query parameters, and the class of
   * bug the literal-prefix measurement makes expensive.
   */
  readonly ignorePrefix?: boolean;
  /** Refuse every DELETE, so a partly-emptied prefix can be observed. */
  readonly refuseDeletes?: boolean;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function startFakeObjectStore(options: FakeOptions = {}) {
  const objects = new Set<string>();
  const pageSize = options.pageSize ?? 2;
  let listCalls = 0;
  let deleteCalls = 0;

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request: Request): Response {
      const url = new URL(request.url);
      const path = decodeURIComponent(url.pathname);

      if (request.method === 'GET' && url.searchParams.get('list-type') === '2') {
        listCalls += 1;
        const prefix = url.searchParams.get('prefix') ?? '';
        const after = url.searchParams.get('continuation-token');
        const all = [...objects]
          .filter((key) => (options.ignorePrefix === true ? true : key.startsWith(prefix)))
          .sort();
        const start = after === null ? 0 : all.indexOf(after) + 1;
        const page = all.slice(start, start + pageSize);
        const truncated = start + pageSize < all.length;
        const next = truncated ? page[page.length - 1] : undefined;

        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>\n` +
            `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
            `<Name>${BUCKET}</Name><Prefix>${escapeXml(prefix)}</Prefix>` +
            `<KeyCount>${page.length}</KeyCount><MaxKeys>${pageSize}</MaxKeys>` +
            `<IsTruncated>${truncated ? 'true' : 'false'}</IsTruncated>` +
            (next === undefined
              ? ''
              : `<NextContinuationToken>${escapeXml(next)}</NextContinuationToken>`) +
            page
              .map(
                (key) =>
                  `<Contents><Key>${escapeXml(key)}</Key><Size>1</Size>` +
                  `<LastModified>2026-01-01T00:00:00.000Z</LastModified>` +
                  `<ETag>&quot;e&quot;</ETag><StorageClass>STANDARD</StorageClass></Contents>`,
              )
              .join('') +
            `</ListBucketResult>`,
          { headers: { 'content-type': 'application/xml' } },
        );
      }

      if (request.method === 'DELETE') {
        deleteCalls += 1;
        if (options.refuseDeletes === true) {
          return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
        }
        objects.delete(path.replace(`/${BUCKET}/`, ''));
        return new Response(null, { status: 204 });
      }

      return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    },
  });

  return {
    endpoint: `http://127.0.0.1:${server.port}`,
    objects,
    put(...keys: string[]) {
      for (const key of keys) objects.add(key);
    },
    get listCalls() {
      return listCalls;
    },
    get deleteCalls() {
      return deleteCalls;
    },
    stop: () => server.stop(true),
  };
}

type Fake = ReturnType<typeof startFakeObjectStore>;

const running: Fake[] = [];

function fake(options: FakeOptions = {}): Fake {
  const started = startFakeObjectStore(options);
  running.push(started);
  return started;
}

afterAll(async () => {
  for (const server of running) await server.stop();
});

/** The store under test, wired the way a composition root wires it. */
function storeFor(server: Fake, tenantId: string = TENANT) {
  return createTenantObjectStore({
    bucket: BUCKET,
    endpoint: server.endpoint,
    credentialFor: () => credentialOf(tenantId),
  });
}

/** How many objects a fixture seeds: enough that one page cannot be all of them. */
const SEEDED = 5;

function seed(server: Fake): void {
  for (let i = 0; i < SEEDED; i += 1) server.put(`${prefixOf(TENANT)}raw/object-${i}`);
}

describe('the fake is a real enough object store to be wrong in the interesting way', () => {
  let server: Fake;
  beforeEach(() => {
    server = fake({ pageSize: 2 });
  });

  test('it pages, and one page is not all of it', async () => {
    seed(server);
    const client = new Bun.S3Client({
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      bucket: BUCKET,
      region: 'auto',
      endpoint: server.endpoint,
    });
    const first = await client.list({ prefix: prefixOf(TENANT) });
    // The whole premise: a single call sees two of five and says so.
    expect(first.contents?.length).toBe(2);
    expect(first.isTruncated).toBe(true);
    expect(first.nextContinuationToken).toBeDefined();
  });
});

describe('list drains every page', () => {
  test('it returns all five objects, not the first page of two', async () => {
    const server = fake({ pageSize: 2 });
    seed(server);

    const listed = await storeFor(server).list(prefixOf(TENANT));

    expect(listed.length).toBe(SEEDED);
    expect([...listed].sort()).toEqual([...server.objects].sort());
    // And it really paged rather than asking for everything at once, which is
    // the only way the assertion above is about the drain.
    expect(server.listCalls).toBeGreaterThan(1);
  });

  test('an empty prefix lists nothing and is not an error', async () => {
    const server = fake();
    expect(await storeFor(server).list(prefixOf(TENANT))).toEqual([]);
  });
});

describe('deletePrefix empties the prefix and nothing else', () => {
  test('it removes every page, and the re-list erasure performs comes back empty', async () => {
    const server = fake({ pageSize: 2 });
    seed(server);
    const store = storeFor(server);
    const prefix = prefixOf(TENANT);

    // The exact sequence `eraseAccount` runs: list for evidence, delete, re-list
    // because the count a delete returns answers a different question.
    const before = await store.list(prefix);
    const removed = await store.deletePrefix(prefix);
    const after = await store.list(prefix);

    expect(before.length).toBe(SEEDED);
    expect(removed).toBe(SEEDED);
    expect(after).toEqual([]);
  });

  test('a sibling tenant keeps every object', async () => {
    const server = fake({ pageSize: 2 });
    seed(server);
    // `alice2/` is not under `alice/`, and R2's literal match is why that has to
    // be asserted with a sibling rather than a stranger.
    server.put(`${prefixOf(SIBLING)}raw/kept-0`, `${prefixOf(SIBLING)}raw/kept-1`);

    await storeFor(server).deletePrefix(prefixOf(TENANT));

    expect([...server.objects].sort()).toEqual([
      `${prefixOf(SIBLING)}raw/kept-0`,
      `${prefixOf(SIBLING)}raw/kept-1`,
    ]);
  });

  test('deletes that fail are counted honestly, and the re-list is the evidence', async () => {
    const server = fake({ pageSize: 2, refuseDeletes: true });
    seed(server);
    const store = storeFor(server);
    const prefix = prefixOf(TENANT);

    const removed = await store.deletePrefix(prefix);

    // Nothing went, and nothing is claimed to have gone. `eraseAccount` reads
    // the re-list, sees five objects standing, and reports the leg `failed`.
    expect(removed).toBe(0);
    expect((await store.list(prefix)).length).toBe(SEEDED);
  });
});

describe('a listing that came back wrong is not a listing to act on part of', () => {
  test('list refuses when the store returns a key the prefix does not cover', async () => {
    const server = fake({ pageSize: 10, ignorePrefix: true });
    seed(server);
    server.put(`${prefixOf(SIBLING)}raw/kept-0`);

    // Not "filter it out and carry on": a store that ignored the scope it was
    // given may equally have ignored it on the delete.
    await expect(storeFor(server).list(prefixOf(TENANT))).rejects.toThrow(/outside the prefix/);
  });

  test('deletePrefix refuses for the same reason, before it deletes anything', async () => {
    const server = fake({ pageSize: 10, ignorePrefix: true });
    seed(server);
    server.put(`${prefixOf(SIBLING)}raw/kept-0`);

    await expect(storeFor(server).deletePrefix(prefixOf(TENANT))).rejects.toThrow(
      /outside the prefix/,
    );
    expect(server.deleteCalls).toBe(0);
    expect(server.objects.size).toBe(SEEDED + 1);
  });
});

describe('the credential is the authority; the argument is only a claim', () => {
  test('a credential scoped to another tenant refuses before a request goes out', async () => {
    const server = fake();
    seed(server);
    const store = createTenantObjectStore({
      bucket: BUCKET,
      endpoint: server.endpoint,
      // The composition root closed over the wrong tenant. Nothing about the
      // argument below can detect that; the credential's own scope can.
      credentialFor: () => credentialOf(SIBLING),
    });

    await expect(store.list(prefixOf(TENANT))).rejects.toThrow(/scoped to a different prefix/);
    await expect(store.deletePrefix(prefixOf(TENANT))).rejects.toThrow(
      /scoped to a different prefix/,
    );
    expect(server.listCalls).toBe(0);
  });

  test('the matching credential is accepted, so the check above is not refusing everything', async () => {
    // The positive control. Without it the assertion pair above passes for a
    // store that refuses every call it is ever handed.
    const server = fake();
    seed(server);
    expect((await storeFor(server).list(prefixOf(TENANT))).length).toBe(SEEDED);
  });
});
