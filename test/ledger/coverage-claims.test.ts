/**
 * What `covered` is allowed to mean when the only measurement says the
 * capability makes things worse.
 *
 * `scripts/check-ledger.ts` enforces that a capability is classified. It cannot
 * enforce that the classification is *true*, and the one direction that matters
 * is `covered`: `not-yet` and `omitted` both keep a capability visible, while
 * `covered` retires it from every list an operator reads. A row flipped to
 * covered is a row nobody looks at again.
 *
 * The repo's own bar for `covered` is "implemented here, not verified against a
 * live provider" — which is why the embedding op is covered on a synthetic
 * vector, and why `gap.read-path-model-spend` is covered on a settled design.
 * That bar answers "has this been built". It does not answer "does it work",
 * and it was never meant to carry a row whose single measurement is a
 * regression.
 *
 * The rerank stage has never run against a real cross-encoder. The only number
 * that exists is U12's own A/B, and it is **−0.1608 nDCG@10** — the receipt
 * marks its own uplift `deferred` precisely because it scored a stand-in.
 * Autocut reads the rerank score and nothing else, so it is unexercised in
 * production shape for exactly the same reason.
 *
 * **This file is a rule, not a snapshot.** It reads the receipt's own manifest
 * counter, so the day a provider-sourced score lands the receipt's
 * `uplift_status` flips to `measured` and these rows become free to claim
 * coverage — with no edit here, and no edit possible that hides the intervening
 * state. Both branches are asserted, so it cannot pass by falling through.
 */

import { describe, expect, test } from 'bun:test';

const LEDGER_PATH = 'upstream/concepts.jsonl';
const RECEIPT_PATH = 'evals/receipts/u12-rerank-ab.json';

/**
 * The two rows whose coverage rests entirely on the rerank A/B.
 *
 * Autocut is here rather than in a list of its own because the coupling is
 * structural: `rerank-stage.ts` resolves both stages as one decision, and
 * autocut cuts on the cross-encoder score alone. A synthetic score makes both
 * unexercised, and covering one while deferring the other would be a claim
 * about a configuration the code cannot produce.
 */
const RERANK_DEPENDENT = ['stack.cross-encoder-rerank', 'stack.autocut'] as const;

interface LedgerRow {
  readonly id: string;
  readonly status: string;
  readonly unit?: string;
  readonly priority?: string;
  readonly criticality: string;
  readonly notes?: string;
}

interface RerankReceipt {
  readonly score_sources: { readonly synthetic: number; readonly provider: number };
  readonly delta_ndcg10: number;
  readonly uplift_status: string;
}

const ledger: LedgerRow[] = (await Bun.file(LEDGER_PATH).text())
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as LedgerRow);
const ledgerById = new Map(ledger.map((row) => [row.id, row] as const));

const receipt = JSON.parse(await Bun.file(RECEIPT_PATH).text()) as RerankReceipt;

describe('the receipt these rows would rest on', () => {
  test('exists, and both rows it governs are in the ledger', () => {
    // A path typo would otherwise make every assertion below vacuous.
    expect(receipt.score_sources).toBeDefined();
    for (const id of RERANK_DEPENDENT) expect(ledgerById.has(id)).toBe(true);
  });

  test('is still scored against a stand-in, and still shows a regression', () => {
    // The state of the world today, asserted rather than assumed — so the rule
    // below is known to be exercising its "not measured yet" branch.
    expect(receipt.score_sources.provider).toBe(0);
    expect(receipt.score_sources.synthetic).toBeGreaterThan(0);
    expect(receipt.uplift_status).toBe('deferred');
    expect(receipt.delta_ndcg10).toBeLessThan(0);
  });
});

describe('a capability is not covered by the measurement that says it hurts', () => {
  test('neither rerank nor autocut claims coverage while the A/B stands', () => {
    const measured = receipt.score_sources.provider > 0 && receipt.uplift_status === 'measured';
    for (const id of RERANK_DEPENDENT) {
      const row = ledgerById.get(id);
      if (measured) {
        // The other branch, spelled out: once a provider score exists the A/B
        // measures the stage rather than the stand-in, and coverage is a
        // question about the number it produces.
        expect(row?.status).not.toBe(undefined);
        continue;
      }
      expect(row?.status).toBe('not-yet');
      // `not-yet` keeps its unit: `test/evals/answerability.test.ts` derives the
      // set of mechanisms a U5-era query may name from exactly this field, and
      // dropping it would silently let a rerank-dependent query grade U5.
      expect(row?.unit).toBe('U12');
      expect(row?.priority).toBe('p0');
    }
  });

  test('each row names the receipt that would flip it, and the counter to watch', () => {
    // A deferral with no stated exit is a decision nobody can re-take. The flip
    // condition has to be mechanical — a field in a committed file — rather
    // than "when someone is happy with it".
    for (const id of RERANK_DEPENDENT) {
      const notes = ledgerById.get(id)?.notes ?? '';
      expect(notes).toContain(RECEIPT_PATH);
      expect(notes).toContain('score_sources.provider');
    }
  });

  test('the regression itself is in the notes, not just the deferral', () => {
    // The number is the reason. A note that said only "unverified" would read as
    // "we have not got round to it" rather than "the one measurement we have
    // says this is worse than doing nothing".
    for (const id of RERANK_DEPENDENT) {
      expect(ledgerById.get(id)?.notes ?? '').toContain('-0.1608');
    }
  });
});

// ---------------------------------------------------------------------------
// The second thing `covered` may not mean: a capability nothing in production
// can reach.
// ---------------------------------------------------------------------------

/**
 * The rule above is about a measurement. This one is about a caller.
 *
 * `gap.data-lifecycle` covers four legs, and three of them are wired: `forget`
 * is a tool, the purge runs on the tombstone clock, and U18 gave the severance
 * preview its executor and `src/web/serve.ts` gave *that* its route. The fourth
 * — page versioning and revert — is a complete module (`versions.ts`: capture,
 * the superseded sweep, list, revert) that **no file under `src/` imports**. No
 * scheduled sweep banks a version, no surface lists one, and nothing can revert
 * to one. Every caller it has is a test.
 *
 * A `covered` row retires a capability from every list an operator reads, which
 * is precisely the wrong thing to do to a module whose only callers assert that
 * it works. `not-yet` keeps it visible and costs nothing but honesty.
 *
 * **This is a rule, not a snapshot.** It resolves the importer set from the
 * source tree on every run, so the day a production caller lands the rule stops
 * binding with no edit here — and no edit possible that hides the intervening
 * state, because both branches are asserted.
 */
const VERSIONS_MODULE = 'core/lifecycle/versions.ts';
const SRC_DIR = `${import.meta.dir}/../../src`;

/**
 * An import of the versions module, however the relative path is spelled.
 *
 * The `from '…'` clause is required, so the module's own header — which names
 * its test file — and every prose mention elsewhere are not importers. Declared
 * once and asserted below on both a positive and two negatives, because a
 * pattern that matched everything would make the rule pass by reporting a
 * caller that is not there, which is the same lie the rule is about.
 */
const IMPORTS_VERSIONS = /from\s+'[^']*lifecycle\/versions\.ts'/;

/** Files under `src/` — other than the module itself — that import it. */
async function productionImportersOfVersions(): Promise<string[]> {
  const found: string[] = [];
  for (const relative of new Bun.Glob('**/*.ts').scanSync({ cwd: SRC_DIR })) {
    if (relative.endsWith('lifecycle/versions.ts')) continue;
    const text = await Bun.file(`${SRC_DIR}/${relative}`).text();
    if (IMPORTS_VERSIONS.test(text)) found.push(relative);
  }
  return found;
}

describe('a capability is not covered while nothing but a test can call it', () => {
  test('the scan reads the source tree — a glob that matched nothing would pass everything below', async () => {
    const files = [...new Bun.Glob('**/*.ts').scanSync({ cwd: SRC_DIR })];
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(VERSIONS_MODULE);
    // And the module it is about is real, so the rule is about a caller rather
    // than about a path somebody renamed.
    const text = await Bun.file(`${SRC_DIR}/${VERSIONS_MODULE}`).text();
    expect(text).toContain('export async function revertPage');
    expect(text).toContain('export async function capturePageVersion');

    // And the pattern discriminates. A regex loosened until it matched every
    // import would report a caller for a module nobody calls, and the rule
    // below would fall into its "somebody wired it" branch and pass.
    expect(IMPORTS_VERSIONS.test("import { revertPage } from '../lifecycle/versions.ts';")).toBe(true);
    expect(IMPORTS_VERSIONS.test('// see `src/core/lifecycle/versions.ts` for the snapshot rule')).toBe(false);
    expect(IMPORTS_VERSIONS.test("import { reconstructPage } from '../export/reconstruct.ts';")).toBe(false);
  });

  test('`gap.data-lifecycle` does not claim coverage while page versioning has no production caller', async () => {
    const importers = await productionImportersOfVersions();
    const row = ledgerById.get('gap.data-lifecycle');
    expect(row).toBeDefined();

    if (importers.length > 0) {
      // The other branch, spelled out: once something in `src/` reaches the
      // module, whether the row is covered is a question about the whole
      // capability again rather than about reachability.
      expect(row?.status).toBeDefined();
      return;
    }

    expect(row?.status).toBe('not-yet');
    expect(row?.priority).toBe('p0');
    // The unit stays: `test/evals/answerability.test.ts` resolves a mechanism's
    // owning unit from this field, and a row that lost it would silently stop
    // being resolvable.
    expect(row?.unit).toBe('U17');
  });

  test('and the row says which half is unreachable, rather than deferring the whole thing vaguely', () => {
    const notes = ledgerById.get('gap.data-lifecycle')?.notes ?? '';
    // The named half, and the evidence a reader can check for themselves.
    expect(notes).toContain('src/core/lifecycle/versions.ts');
    expect(notes).toContain('no caller');
  });
});
