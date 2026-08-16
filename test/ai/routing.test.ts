/**
 * Routing by op, and the pin that makes an eval receipt mean something.
 *
 * Two properties are under test, and both are *startup* properties. The plan
 * says so in as many words — "an op with no routing entry fails at startup, not
 * at first call" — because the alternative is a consolidation phase that runs
 * for twenty minutes and then discovers that `judge` resolves to nothing.
 *
 * **How the startup claim is actually proved.** Calling an exported validator
 * and watching it throw proves the validator works; it proves nothing about the
 * module running it at import time. Someone can delete the module-scope call
 * and every such test stays green. So the tests below *mutate a copy of the
 * real file* — rename an op key, un-pin a model id, point a self-host row at a
 * Cloudflare id — and `await import()` the mutant. If `routing.ts` stops
 * validating at import, those imports start succeeding and this file goes red.
 * The copy lives in a temp directory outside the repo, with its relative
 * imports rewritten to absolute paths, so nothing scan-shaped elsewhere in the
 * suite can see a stray file under `src/`.
 *
 * **Why the pin rule exists** (KTD13): the names in the plan's table are moving
 * aliases. If production silently follows an alias forward, every committed
 * eval receipt — the calibration baseline, the model-tier A/B, the embedding
 * A/B — was scored against a model that is no longer running, with no signal at
 * all. Advancing a pin is a deliberate ledger action, exactly like
 * `upstream/gbrain.pin`.
 *
 * **And why a self-host row may never carry a `@cf/` id:** price is a property
 * of (weights, who serves them). A self-hoster running the same open weights on
 * their own hardware billed at Cloudflare's neuron rate is a wrong number
 * arriving silently, which is the same defect class as an unmetered call.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CANONICAL_PRICE_BOOK, createPriceBook } from '../../src/ai/pricing.ts';
import {
  HOSTED_PROFILE,
  MODEL_OPS,
  OP_KINDS,
  PROFILES,
  RoutingTableError,
  SELF_HOST_PROFILE,
  assertRoutable,
  findRoutingFaults,
  routeFor,
  type ModelOp,
  type Route,
} from '../../src/ai/routing.ts';

const AI_DIR = `${import.meta.dir}/../../src/ai`;
const ROUTING_PATH = `${AI_DIR}/routing.ts`;
const ROUTING_SOURCE = await Bun.file(ROUTING_PATH).text();

const TEMP_ROOTS: string[] = [];

afterAll(() => {
  for (const root of TEMP_ROOTS) rmSync(root, { recursive: true, force: true });
});

/**
 * Import a mutated copy of the real `routing.ts` and return whatever it threw
 * at import time, or `undefined` if it loaded happily. Relative specifiers are
 * rewritten to absolute so the copy resolves the same modules the original
 * does; the mutation is applied to the source text, so a mutation that fails to
 * apply is caught by the caller rather than passing vacuously.
 */
async function importMutant(name: string, mutate: (source: string) => string): Promise<unknown> {
  const patched = mutate(ROUTING_SOURCE);
  if (patched === ROUTING_SOURCE) throw new Error(`mutation '${name}' changed nothing`);
  const mutated = patched
    .split("from '../")
    .join(`from '${AI_DIR}/../`)
    .split("from './")
    .join(`from '${AI_DIR}/`);

  // A fresh directory per mutant, measured rather than assumed: Bun caches the
  // entries of a directory it has resolved from, so a second file written into
  // the same directory resolves as "module not found" — which would have made
  // every assertion below pass for a reason that has nothing to do with the
  // table. (Probed: first import in a directory loads, later ones do not.)
  const root = mkdtempSync(join(tmpdir(), 'brainz-routing-mutant-'));
  TEMP_ROOTS.push(root);
  const path = join(root, `${name}.ts`);
  writeFileSync(path, mutated, 'utf8');
  try {
    await import(path);
    return undefined;
  } catch (error) {
    return error;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The mutant defines its *own* `RoutingTableError` class, so `instanceof`
 * against this module's class is always false — the check that looks strongest
 * here is the one that would pass for any thrown value. Assert on the name the
 * class sets on itself instead.
 */
function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : `not an Error: ${String(error)}`;
}

describe('the table covers KTD13, keyed by op', () => {
  test('nine ops, the nine rows KTD13 names', () => {
    expect([...MODEL_OPS].map(String).sort()).toEqual(
      [
        'contradiction',
        'embedding',
        'enrich',
        'extract',
        'judge',
        'rerank',
        'salience',
        'synopsis',
        'vision',
      ].sort(),
    );
  });

  test('both profiles resolve every op — not one provider per op', () => {
    // The five `@cf/` rows are the reason this matters: a single-profile
    // gateway resolves four of nine for an AGPL self-hoster, and the
    // open-source promise is nominal.
    for (const profile of Object.values(PROFILES)) {
      for (const op of MODEL_OPS) {
        const route: Route = routeFor(profile, op);
        expect(route.op, `${profile.name}/${op}`).toBe(op);
        expect(route.id.length).toBeGreaterThan(0);
      }
    }
  });

  test('the hosted profile is Cloudflare-first, with the two named processors', () => {
    // KTD13's residency decision, as data rather than prose. Since the seat
    // move it is stronger than it was: every op but embedding is billed by
    // Cloudflare, five as open weights it runs itself and three as Google's
    // model passed through its own provider relationship. The two named
    // processors are unchanged — Google still makes the extraction model and
    // OpenAI still serves embedding — but only one of them is now reached with
    // a credential of ours.
    const openWeights: readonly ModelOp[] = ['salience', 'synopsis', 'vision', 'rerank', 'judge'];
    for (const op of openWeights) {
      expect(routeFor(HOSTED_PROFILE, op).provider, op).toBe('cloudflare');
      expect(routeFor(HOSTED_PROFILE, op).id.startsWith('@cf/'), op).toBe(true);
    }
    for (const op of ['extract', 'enrich', 'contradiction'] as const) {
      expect(routeFor(HOSTED_PROFILE, op).provider, op).toBe('cloudflare');
      // Passed through, not open weights: the id names the lab that made it.
      expect(routeFor(HOSTED_PROFILE, op).id.startsWith('google/'), op).toBe(true);
    }
    expect(routeFor(HOSTED_PROFILE, 'embedding').provider).toBe('cloudflare');
  });

  test('the self-host profile replaces every Cloudflare row and nothing else', () => {
    for (const op of MODEL_OPS) {
      const hosted = routeFor(HOSTED_PROFILE, op);
      const selfHost = routeFor(SELF_HOST_PROFILE, op);
      if (hosted.id.startsWith('@cf/')) {
        // Open weights Cloudflare runs: the self-hoster runs the same weights
        // on their own hardware. The crack this closes is that reusing the
        // `@cf/` id would resolve Cloudflare's neuron price for hardware
        // Cloudflare does not own.
        expect(selfHost.provider, op).toBe('self-host');
        expect(selfHost.id.startsWith('self-host/'), op).toBe(true);
        expect(CANONICAL_PRICE_BOOK.lookup(selfHost.id), op).toBeUndefined();
      } else if (hosted.provider === 'cloudflare') {
        // A third-party model passed through Cloudflare's billing. The
        // self-hoster has no such relationship and goes to the lab directly, so
        // the row is a DIFFERENT id on a different provider — `google/…` is a
        // Cloudflare catalog name and means nothing at Google's own endpoint.
        expect(selfHost.provider, op).toBe('google');
        expect(selfHost.id, op).not.toBe(hosted.id);
        expect(selfHost.id.startsWith('google/'), op).toBe(false);
        expect(CANONICAL_PRICE_BOOK.isCanonical(selfHost.id), op).toBe(true);
      } else {
        // OpenAI is reachable directly by anyone; the row is shared.
        expect(selfHost.id, op).toBe(hosted.id);
      }
    }
  });

  test('every op declares the shape of call it is', () => {
    expect(OP_KINDS.rerank).toBe('rerank');
    expect(OP_KINDS.embedding).toBe('embedding');
    for (const op of MODEL_OPS) {
      if (op === 'rerank' || op === 'embedding') continue;
      expect(OP_KINDS[op], op).toBe('chat');
    }
  });

  test('every billed model is priced at startup, not at first call', () => {
    for (const profile of Object.values(PROFILES)) {
      for (const op of MODEL_OPS) {
        const route = routeFor(profile, op);
        if (route.provider === 'self-host') continue;
        expect(CANONICAL_PRICE_BOOK.isCanonical(route.id), `${profile.name}/${op}`).toBe(true);
      }
    }
  });

  test('the shipped profiles are routable against the canonical book', () => {
    for (const profile of Object.values(PROFILES)) {
      expect(findRoutingFaults(profile, CANONICAL_PRICE_BOOK), profile.name).toEqual([]);
    }
  });
});

describe('model ids are pinned, not aliased', () => {
  test('every route names when its pin was taken', () => {
    for (const profile of Object.values(PROFILES)) {
      for (const op of MODEL_OPS) {
        expect(routeFor(profile, op).pinnedOn, `${profile.name}/${op}`).toMatch(
          /^\d{4}-\d{2}-\d{2}$/,
        );
      }
    }
  });

  test('a proprietary id carries a dated snapshot; the alias is only its prefix', () => {
    // Asserted on the self-host row, which is the one that still reaches Google
    // directly and can therefore still name a dated snapshot. The hosted row
    // moved onto a catalog that publishes no dated ids at all and declares
    // itself unpinnable instead — see the test below and `routing.ts`.
    const extract = routeFor(SELF_HOST_PROFILE, 'extract');
    expect(extract.alias).toBe('gemini-3.5-flash-lite');
    expect(extract.id).toMatch(/^gemini-3\.5-flash-lite-\d{4}-\d{2}-\d{2}$/);
    expect(extract.id.startsWith(extract.alias)).toBe(true);
    expect(extract.id).not.toBe(extract.alias);
  });

  test('the one id that cannot be pinned says so on the row', () => {
    // Exactly one seat, and no more: an undeclared moving alias is still a
    // startup fault, and a declaration on a pinnable id is too.
    const declared = Object.values(PROFILES).flatMap((profile) =>
      MODEL_OPS.map((op) => routeFor(profile, op)).filter((route) => route.unpinnable !== undefined),
    );
    expect(new Set(declared.map((route) => route.id))).toEqual(
      new Set(['google/gemini-3.5-flash-lite']),
    );
    for (const route of declared) expect(route.unpinnable?.why.length).toBeGreaterThan(0);
  });

  test('an immutable-weights id is its own pin', () => {
    // `@cf/…`, `self-host/…` and `text-embedding-3-…` name a specific weight
    // release rather than a pointer, so there is no date to append and
    // demanding one would fail startup on a correct entry.
    for (const op of ['salience', 'embedding'] as const) {
      const route = routeFor(HOSTED_PROFILE, op);
      expect(route.id).toBe(route.alias);
    }
  });
});

describe('the validator names every fault', () => {
  function withRoute(op: ModelOp, patch: Partial<Route>) {
    const routes = { ...HOSTED_PROFILE.routes };
    routes[op] = { ...routes[op], ...patch };
    return { name: 'test', routes };
  }

  test('a bare alias where a dated snapshot belongs is a fault', () => {
    // Patched onto `judge`, which carries no unpinnable declaration — the three
    // extraction seats now do, and the whole point of that field is that this
    // fault stops firing for them and only for them.
    const faults = findRoutingFaults(
      withRoute('judge', { alias: 'gemini-3.5-flash-lite', id: 'gemini-3.5-flash-lite' }),
      CANONICAL_PRICE_BOOK,
    );
    expect(faults.join('\n')).toContain('pin');
  });

  test('an id that is not a specialization of its alias is a fault', () => {
    const faults = findRoutingFaults(
      withRoute('extract', { alias: 'gemini-3.6-flash' }),
      CANONICAL_PRICE_BOOK,
    );
    expect(faults.join('\n')).toContain('alias');
  });

  test('a billed model with no canonical price is a fault, at startup', () => {
    const faults = findRoutingFaults(
      withRoute('judge', { id: '@cf/zai-org/glm-5.3', provider: 'cloudflare' }),
      CANONICAL_PRICE_BOOK,
    );
    expect(faults.join('\n')).toContain('price');
  });

  test('a self-host row wearing a canonical id is a fault', () => {
    const faults = findRoutingFaults(
      { name: 'self-host', routes: { ...SELF_HOST_PROFILE.routes,
        salience: { ...SELF_HOST_PROFILE.routes.salience, id: '@cf/nvidia/nemotron-3-120b-a12b' } } },
      CANONICAL_PRICE_BOOK,
    );
    expect(faults.join('\n')).toMatch(/self-host/);
  });

  test('a chat op with no output budget is a fault', () => {
    const faults = findRoutingFaults(withRoute('synopsis', { maxOutputTokens: 0 }), CANONICAL_PRICE_BOOK);
    expect(faults.join('\n')).toContain('maxOutputTokens');
  });

  test('a route filed under the wrong key is a fault', () => {
    const faults = findRoutingFaults(withRoute('judge', { op: 'salience' }), CANONICAL_PRICE_BOOK);
    expect(faults.length).toBeGreaterThan(0);
  });

  test('assertRoutable throws a typed error carrying every fault', () => {
    expect(() =>
      assertRoutable(withRoute('extract', { id: 'gemini-3.5-flash-lite' }), CANONICAL_PRICE_BOOK),
    ).toThrow(RoutingTableError);
  });

  test('an overlay-priced self-host profile is routable', () => {
    // The self-hoster who supplies their own cost basis gets caps back.
    const overlay = new Map(
      Object.values(SELF_HOST_PROFILE.routes)
        .filter((route) => route.provider === 'self-host')
        .map((route) => [
          route.id,
          {
            inputMicroUsdPerMillion: 10,
            outputMicroUsdPerMillion: OP_KINDS[route.op] === 'chat' ? 10 : null,
          },
        ]),
    );
    expect(findRoutingFaults(SELF_HOST_PROFILE, createPriceBook(overlay))).toEqual([]);
  });
});

describe('the real module refuses to load a broken table', () => {
  test('the mutation harness is wired to the real file', async () => {
    // Positive control: the unmutated copy must load. If it does not, every
    // assertion below passes for the wrong reason.
    const error = await importMutant('identity', (source) => `${source}\n// mutation marker\n`);
    expect(error).toBeUndefined();
  });

  test('an op with no routing entry fails at import, not at first call', async () => {
    const error = await importMutant('missing-op', (source) =>
      source.split('\n  judge: {').join('\n  judgeXX: {'),
    );
    expect(nameOf(error)).toBe('RoutingTableError');
    expect(messageOf(error)).toContain('judge');
  });

  test('an unpinned model id fails at import', async () => {
    const error = await importMutant('unpinned', (source) =>
      source.split("'gemini-3.5-flash-lite-2026-07-21'").join("'gemini-3.5-flash-lite'"),
    );
    expect(nameOf(error)).toBe('RoutingTableError');
    expect(messageOf(error)).toContain('pin');
  });

  test('a self-host row pointing at a Cloudflare id fails at import', async () => {
    const error = await importMutant('self-host-cf-id', (source) =>
      source
        .split("'self-host/nemotron-3-120b-a12b'")
        .join("'@cf/nvidia/nemotron-3-120b-a12b'"),
    );
    expect(nameOf(error)).toBe('RoutingTableError');
  });
});
