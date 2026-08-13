/**
 * `bun run eval:blocking` — R6's floors as a command (U7 approach step 3).
 *
 * The floors themselves are already pinned by `test/core/search/floors.test.ts`.
 * What this file grades is the **tier**: the three properties the Verification
 * Contract claims for the command and that nothing else checks.
 *
 *   1. **Deterministic.** Two runs produce identical scores. Not "similar" —
 *      identical, digest for digest, including every per-query outcome. A gate
 *      whose number moves on its own gets marked flaky and then non-blocking.
 *   2. **Zero model calls.** The tier's determinism *comes from* committed
 *      embeddings, so an accidental live call would both cost money and make
 *      the first property false. `fetch` is the channel every `src/ai/`
 *      transport uses (`FetchLike` in `src/ai/gateway.ts`), so trapping it is
 *      the enforceable version of "zero model calls".
 *   3. **Specific.** A seeded regression fails the floor it belongs to, and the
 *      command says which — R6 requires per-question-type floors precisely so a
 *      collapse in one category cannot hide inside an aggregate.
 *
 * Everything here fails toward enforcement. The failure this gate has is not
 * being wrongly red; it is passing having graded nothing, so an empty query
 * set, an un-run floor and a trapped-but-unreported egress are each violations.
 */

import { describe, expect, test } from 'bun:test';

import { CORPUS, corpusTexts } from '../../evals/corpus.ts';
import { loadEmbeddings } from '../../evals/embeddings.ts';
import { RANKING_FLOORS } from '../../evals/gates.ts';
import { MANIFEST_PATH } from '../../evals/regenerate-embeddings.ts';
import { composeRanking } from '../../src/core/search/pipeline.ts';
import { RESULT_LIMIT, type EvalReport, type Ranker } from '../../evals/run.ts';
import {
  foldViolations,
  loadTierContext,
  reportDigest,
  runBlockingTier,
  withoutNetwork,
  type TierViolation,
} from '../../evals/blocking.ts';
import { RANK_LIMIT, recallOverCorpus, stackRanker } from '../core/search/corpus-ranker.ts';

const manifest = await Bun.file(`${import.meta.dir}/../../${MANIFEST_PATH}`).text();
const embeddings = loadEmbeddings(manifest, corpusTexts(CORPUS));
const context = { corpus: CORPUS, embeddings };

/**
 * The seeded regression R6 asks for: the alias ladder switched off, everything
 * else untouched. Built the way `test/core/search/mechanism-sensitivity.test.ts`
 * builds its ablations — by emptying `aliasLadder` between recall and the
 * composed ranking — so the two files disable the same mechanism the same way.
 */
const aliasBlindRanker: Ranker = {
  name: 'u5-retrieval-stack-without-alias-hop',
  description: 'The composed stack with the alias ladder suppressed. A seeded regression, not a shipped mode.',
  rank(query, ctx) {
    const { outcome, now } = recallOverCorpus(query, ctx, { limit: RANK_LIMIT });
    const response = composeRanking(
      { query: query.text, limit: Math.min(RANK_LIMIT, RESULT_LIMIT), now, plan: outcome.plan },
      { ...outcome, aliasLadder: [] },
    );
    return response.results.map((result) => result.candidate.id);
  },
};

const kinds = (violations: readonly TierViolation[]): string[] => violations.map((v) => v.kind);

describe('the blocking tier as the command runs it', () => {
  const result = runBlockingTier({ ranker: stackRanker, context });

  test('it passes on the shipped stack, and says which floors it did not measure', () => {
    if (!result.passed) {
      throw new Error(`blocking tier failed:\n  ${result.violations.map((v) => `[${v.kind}] ${v.detail}`).join('\n  ')}`);
    }
    expect(result.violations).toEqual([]);
    // The two deferred floors are reported, never silently dropped.
    expect(result.gate.deferrals.map((d) => d.floorId).sort()).toEqual([
      'family.alias.hit1',
      'family.dilution.hit3',
    ]);
  });

  test('every floor was classified — a tier that skipped one is not a tier', () => {
    expect(result.gate.outcomes.length).toBe(RANKING_FLOORS.length);
  });

  test('it graded the whole query set', () => {
    expect(result.report.queryCount).toBe(CORPUS.queries.length);
    expect(result.report.queryCount).toBeGreaterThan(0);
  });

  test('two runs produce identical scores, digest for digest', () => {
    const second = runBlockingTier({ ranker: stackRanker, context });
    expect(second.digest).toBe(result.digest);
    expect(second.report.perQuery).toEqual(result.report.perQuery);
    expect(kinds(second.violations)).not.toContain('nondeterministic');
  });

  test('it made no network call', () => {
    expect(result.egress).toEqual([]);
    expect(kinds(result.violations)).not.toContain('network_egress');
  });
});

describe('the tier is specific: a seeded regression fails its own floor', () => {
  const result = runBlockingTier({ ranker: aliasBlindRanker, context });

  test('disabling the alias hop fails the alias floor, named', () => {
    expect(result.passed).toBe(false);
    const aliasFloor = result.gate.outcomes.find((o) => o.floorId === 'family.alias.hit1');
    expect(aliasFloor?.status).toBe('missed');
    expect(result.violations.some((v) => v.detail.includes('alias'))).toBe(true);
  });

  test('the aggregate floor is not what caught it — an aggregate-only gate would have passed this', () => {
    const aggregate = result.gate.outcomes.find((o) => o.floorId === 'aggregate.ndcg10');
    expect(aggregate?.status).toBe('met');
  });
});

describe('the determinism claim is checked, not asserted', () => {
  /**
   * Returns the same results in a different order on alternate calls. Every
   * bucket mean is identical; only the ranks move. That is the shape a
   * genuinely flaky ranker has — an iteration order that depends on insertion,
   * a `Date.now()` tie-break — and a determinism check that compares only means
   * would call it stable.
   */
  const flakyRanker: Ranker = (() => {
    let call = 0;
    return {
      name: 'flaky',
      description: 'alternates the order of its top two results',
      rank(query, ctx) {
        const ranked = [...stackRanker.rank(query, ctx)];
        call += 1;
        if (call % 2 === 0 && ranked.length >= 2) {
          const [a, b, ...rest] = ranked;
          return [b as string, a as string, ...rest];
        }
        return ranked;
      },
    };
  })();

  test('a ranker whose order moves between runs is nondeterministic, and the tier fails', () => {
    const result = runBlockingTier({ ranker: flakyRanker, context });
    expect(kinds(result.violations)).toContain('nondeterministic');
    expect(result.passed).toBe(false);
  });
});

describe('withoutNetwork traps egress rather than trusting the tier not to make any', () => {
  test('it reports a fetch attempted during the run and does not let it through', async () => {
    const original = globalThis.fetch;
    const trapped = withoutNetwork(() => {
      // The failure has to be observable to the run as well as to the trap: a
      // caller that swallows the rejection must still leave a record.
      void fetch('https://api.openai.com/v1/embeddings').catch(() => undefined);
      return 'done';
    });
    expect(trapped.value).toBe('done');
    expect(trapped.egress.length).toBe(1);
    expect(trapped.egress[0]).toContain('api.openai.com');
    // Restored afterwards: a trap that leaks into the rest of the suite is a
    // worse bug than the one it catches.
    expect(globalThis.fetch).toBe(original);
    // And it never actually issued the request.
    await Promise.resolve();
  });

  test('it restores fetch even when the run throws', () => {
    const original = globalThis.fetch;
    expect(() =>
      withoutNetwork(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(globalThis.fetch).toBe(original);
  });

  test('a Request object target is recorded, not silently allowed', () => {
    const trapped = withoutNetwork(() => {
      void fetch(new Request('https://gateway.ai.cloudflare.com/x')).catch(() => undefined);
    });
    expect(trapped.egress[0]).toContain('gateway.ai.cloudflare.com');
  });
});

describe('foldViolations — the states a healthy fixture cannot reach', () => {
  const clean = runBlockingTier({ ranker: stackRanker, context });
  const base = {
    report: clean.report,
    gate: clean.gate,
    egress: [] as readonly string[],
    digest: 'aaaa',
    secondDigest: 'aaaa',
  };

  test('a healthy run folds to nothing', () => {
    expect(foldViolations(base)).toEqual([]);
  });

  test('a run that graded zero queries is empty_query_set, not a pass', () => {
    const folded = foldViolations({ ...base, report: { ...clean.report, queryCount: 0 } });
    expect(kinds(folded)).toEqual(['empty_query_set']);
  });

  test('recorded egress reaches the verdict — trapping it and not reporting it is the same as not trapping it', () => {
    const folded = foldViolations({ ...base, egress: ['https://api.openai.com/v1/embeddings'] });
    expect(kinds(folded)).toEqual(['network_egress']);
    expect(folded[0]?.detail).toContain('api.openai.com');
  });

  test('differing digests are nondeterministic', () => {
    const folded = foldViolations({ ...base, secondDigest: 'bbbb' });
    expect(kinds(folded)).toEqual(['nondeterministic']);
  });

  test('a leak is reported as a leak, distinct from a low score', () => {
    const folded = foldViolations({
      ...base,
      gate: {
        ...clean.gate,
        violations: [{ floorId: 'visibility', kind: 'leak', detail: 'q-x returned a soft-deleted chunk' }],
      },
    });
    expect(kinds(folded)).toEqual(['leak']);
  });
});

describe('reportDigest', () => {
  const base = runBlockingTier({ ranker: stackRanker, context }).report;

  test('it is stable across identical reports', () => {
    expect(reportDigest(base)).toBe(reportDigest(base));
  });

  test('it moves when a single per-query outcome moves', () => {
    const perQuery = base.perQuery.map((outcome, index) =>
      index === 0 ? { ...outcome, hit1: outcome.hit1 === 1 ? 0 : 1 } : outcome,
    );
    const mutated: EvalReport = { ...base, perQuery };
    expect(reportDigest(mutated)).not.toBe(reportDigest(base));
  });

  test('it moves when an aggregate moves', () => {
    const mutated: EvalReport = { ...base, aggregate: { ...base.aggregate, ndcg10: base.aggregate.ndcg10 + 1e-9 } };
    expect(reportDigest(mutated)).not.toBe(reportDigest(base));
  });

  test('it binds the report to the vectors it was produced against', () => {
    const mutated: EvalReport = { ...base, embeddingManifestDigest: 'different' };
    expect(reportDigest(mutated)).not.toBe(reportDigest(base));
  });
});

describe('loadTierContext', () => {
  test('it loads the committed corpus and the committed manifest', () => {
    const loaded = loadTierContext();
    expect(loaded.corpus.queries.length).toBe(CORPUS.queries.length);
    expect(loaded.embeddings.manifestDigest).toBe(embeddings.manifestDigest);
  });
});
