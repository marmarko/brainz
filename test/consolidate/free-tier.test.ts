/**
 * U11's free-tier claim, as a measurement.
 *
 * > free-tier simulation (cap=0 model spend) still improves dedup/links
 * > measurably on the eval corpus
 *
 * The word doing the work is *measurably*, so this file takes two numbers before
 * and after and asserts on the difference. It also asserts on what did **not**
 * move, because both of the phases being measured are deletions and a pass that
 * removed everything would improve both defect counts to zero.
 *
 * The wall-clock number KTD11 wants as a capacity input is taken here too, for
 * the same reason it belongs with this fixture rather than with a benchmark: the
 * deterministic tier is the only tier that can be timed without spending money,
 * and this is the only place a real corpus goes through it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { CORPUS_DIGEST } from '../../evals/corpus.ts';
import { measureConsolidationQuality, type QualityReport } from '../../evals/consolidation-quality.ts';
import { runConsolidationCycle } from '../../src/worker/consolidate/cycle.ts';
import {
  CALLER,
  TENANT,
  createGateway,
  createTenantFixture,
  seedPreConsolidationCorpus,
  type TenantFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 300_000;

const RECEIPT_PATH = 'evals/receipts/u11-cycle-wallclock.json';

let tenant: TenantFixture;
let before: QualityReport;
let after: QualityReport;
let wallClockMs = 0;
let seeded = { pages: 0, chunks: 0, facts: 0 };

beforeAll(async () => {
  tenant = await createTenantFixture('freetier');
  seeded = await seedPreConsolidationCorpus(tenant.sql);
  before = await measureConsolidationQuality(tenant.sql);

  const { gateway, transport } = createGateway();
  const result = await runConsolidationCycle(
    { sql: tenant.sql, gateway, tenantId: TENANT, caller: CALLER },
    { trigger: 'time_ceiling', tier: 'free', now: new Date() },
  );
  if (transport.calls.length !== 0) {
    throw new Error('the free tier made a model call; the measurement below would be meaningless');
  }
  wallClockMs = result.wallClockMs;
  after = await measureConsolidationQuality(tenant.sql);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await tenant?.close();
}, SETUP_TIMEOUT_MS);

describe('the corpus arrives with something to fix', () => {
  test('the pre-consolidation state has both classes of defect', () => {
    expect(seeded.facts).toBeGreaterThan(0);
    // Without these the improvement assertions below would be vacuously true.
    expect(before.duplicateGroups).toBeGreaterThan(0);
    expect(before.missingEdges).toBeGreaterThan(0);
    // Nothing projected an edge, so there is nothing yet for the graph to be
    // wrong about in the other direction.
    expect(before.liveEdges).toBe(0);
  });
});

describe('a cap=0 cycle improves dedup and links, measurably', () => {
  test('duplicate facts strictly decrease', () => {
    expect(after.duplicateFacts).toBeLessThan(before.duplicateFacts);
    // Deterministic dedup is exact — same normalized claim, same credential —
    // so it has no excuse for leaving one behind.
    expect(after.duplicateFacts).toBe(0);
  });

  test('the edges the facts imply are all present, and none is unsupported', () => {
    expect(after.missingEdges).toBeLessThan(before.missingEdges);
    expect(after.missingEdges).toBe(0);
    // The removal half of reconciliation has nothing to remove on this corpus,
    // and saying so is the honest form: it is covered directly, on a fixture
    // built for it, in `test/consolidate/deterministic.test.ts`.
    expect(after.unsupportedEdges).toBe(0);
  });

  test('it did not get there by deleting the brain', () => {
    // Exactly the duplicates went: every claim the corpus states once survives.
    expect(after.liveFacts).toBe(before.liveFacts - before.duplicateFacts);
    expect(after.supportedEdges).toBeGreaterThan(before.supportedEdges);
    expect(after.liveEdges).toBe(after.supportedEdges);
  });

  test('the improvement is reported as a percentage a reader can quote', () => {
    const dedup = (before.duplicateFacts - after.duplicateFacts) / before.duplicateFacts;
    const links = (before.missingEdges - after.missingEdges) / before.missingEdges;
    // Printed rather than only asserted: the number is the deliverable.
    console.log(
      `[U11 free-tier] duplicate facts ${before.duplicateFacts} → ${after.duplicateFacts} ` +
        `(${(dedup * 100).toFixed(1)}% removed); missing edges ${before.missingEdges} → ` +
        `${after.missingEdges} (${(links * 100).toFixed(1)}% closed); ` +
        `${seeded.pages} pages, ${seeded.chunks} chunks, ${before.liveFacts} facts in; ` +
        `deterministic tier ${wallClockMs}ms`,
    );
    expect(dedup).toBeGreaterThan(0);
    expect(links).toBeGreaterThan(0);
  });
});

describe('the wall-clock receipt', () => {
  test('is committed, names its method, and is bound to the corpus it was taken on', async () => {
    const receipt = (await Bun.file(RECEIPT_PATH).json()) as {
      corpus_digest: string;
      tier: string;
      measured_ms: number;
      method: string;
      caveat: string;
    };

    // Bound to the corpus: a corpus edit invalidates the number rather than
    // silently keeping a measurement of something else.
    expect(receipt.corpus_digest).toBe(CORPUS_DIGEST);
    expect(receipt.tier).toBe('deterministic');
    expect(receipt.measured_ms).toBeGreaterThan(0);
    expect(receipt.method).toContain('evals/corpus.ts');
    // The caveat is load-bearing: this is a lower bound on a full cycle, and a
    // capacity number that read it as the whole cycle would be optimistic.
    expect(receipt.caveat.toLowerCase()).toContain('lower bound');
  });

  test('this run is the same order of magnitude as the committed one', async () => {
    const receipt = (await Bun.file(RECEIPT_PATH).json()) as { measured_ms: number };
    // Machines differ; an order of magnitude is what a receipt of this kind can
    // honestly promise, and it still catches a phase that started doing a
    // hundred times more work.
    expect(wallClockMs).toBeLessThan(receipt.measured_ms * 10 + 1_000);
  });
});
