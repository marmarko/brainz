/**
 * The coupling U12 must not lose: **autocut reads the rerank score and nothing
 * else, so disabling rerank disables autocut.**
 *
 * KTD4 says it plainly. Enabling rerank puts a *second* synchronous external
 * call on a path that promises a warm p99 under 100ms, and the obvious lever
 * when that budget misses is to switch rerank off — which silently takes
 * result-sizing with it. Nothing errors. The lists just get longer and nobody
 * connects the two.
 *
 * So the dependency is a value here rather than a comment, and the named dial is
 * the **candidate count**: `reduceForLatency` shrinks the pool and never
 * disables the stage, reporting `at_floor` when it has nothing left to give
 * rather than falling back to the one move that would cost the product a stage.
 *
 * The end-to-end half is at the bottom: through the real `composeRanking`, a
 * disabled rerank leaves `autocutApplied` false across a fused-score cliff that
 * a gap-based cut would fire on instantly.
 */

import { describe, expect, test } from 'bun:test';

import { AUTOCUT_MINIMUM_KEPT } from '../../../src/core/search/autocut.ts';
import { RANKING_FLOORS } from '../../../evals/gates.ts';
import { composeRanking } from '../../../src/core/search/pipeline.ts';
import { RERANK_DEFAULT_ENABLED } from '../../../src/core/search/rerank.ts';
import {
  AUTOCUT_REQUIRES_RERANK,
  LATENCY_DIAL,
  RERANK_CANDIDATES_DEFAULT,
  RERANK_CANDIDATES_FLOOR,
  disablingRerankAlsoDisables,
  reduceForLatency,
  resolveRerankStage,
  type RerankStagePlan,
} from '../../../src/core/search/rerank-stage.ts';
import { planFor, classifyIntent } from '../../../src/core/search/intent.ts';
import type { Candidate, RecallOutcome } from '../../../src/core/search/types.ts';

describe('U12 flipped the flag', () => {
  test('rerank defaults on', () => {
    expect(RERANK_DEFAULT_ENABLED).toBe(true);
  });

  test('a caller that supplies a scorer and no opinion gets the default', () => {
    expect(resolveRerankStage({ score: () => 1 }).rerank).toBe(true);
  });

  test('a caller that never wired the stage does not run it', () => {
    // Not the same as "off": the eval baselines and the stage-level unit tests
    // compose a ranking without participating in stage 12 at all, and a default
    // that reached into them would make `enabled: true` mean "throw".
    const plan = resolveRerankStage(undefined);
    expect(plan.rerank).toBe(false);
    expect(plan.reason).toBe('stage_not_wired');
  });

  test('enabled with nothing to score with is unavailable, not a thrown request', () => {
    // On the request path this is a provider that refused. A throw here would
    // turn one bad rerank call into a failed read; the read degrades instead.
    const plan = resolveRerankStage({ enabled: true });
    expect(plan.rerank).toBe(false);
    expect(plan.reason).toBe('unavailable');
  });
});

describe('autocut is downstream of rerank, structurally', () => {
  test('the dependency is declared', () => {
    expect(AUTOCUT_REQUIRES_RERANK).toBe(true);
    expect(disablingRerankAlsoDisables()).toContain('autocut');
  });

  test('across every resolvable configuration, autocut tracks rerank exactly', () => {
    const configs = [
      undefined,
      {},
      { enabled: true },
      { enabled: false },
      { score: () => 1 },
      { enabled: true, score: () => 1 },
      { enabled: false, score: () => 1 },
      { enabled: true, score: () => 1, candidates: 1 },
      { enabled: true, score: () => 1, candidates: 10_000 },
    ] as const;

    for (const config of configs) {
      const plan: RerankStagePlan = resolveRerankStage(config);
      expect({ config, autocut: plan.autocut }).toEqual({ config, autocut: plan.rerank });
    }
  });
});

describe('the latency dial is the candidate count, never the stage', () => {
  test('the dial is named', () => {
    expect(LATENCY_DIAL).toBe('candidate_count');
  });

  test('reducing keeps rerank on and shrinks the pool', () => {
    const plan = resolveRerankStage({ score: () => 1 });
    expect(plan.candidates).toBe(RERANK_CANDIDATES_DEFAULT);

    const reduced = reduceForLatency(plan);
    expect(reduced.change).toBe('candidates_reduced');
    expect(reduced.plan.candidates).toBeLessThan(plan.candidates);
    expect(reduced.plan.rerank).toBe(true);
    expect(reduced.plan.autocut).toBe(true);
  });

  test('it bottoms out at the floor and says so rather than switching rerank off', () => {
    let plan = resolveRerankStage({ score: () => 1 });
    let change = '';
    for (let step = 0; step < 50; step += 1) {
      const reduced = reduceForLatency(plan);
      plan = reduced.plan;
      change = reduced.change;
      if (change === 'at_floor') break;
    }
    expect(change).toBe('at_floor');
    expect(plan.candidates).toBe(RERANK_CANDIDATES_FLOOR);
    // The point of the whole module: the escape hatch never reaches the stage.
    expect(plan.rerank).toBe(true);
    expect(plan.autocut).toBe(true);
  });
});

describe("autocut's floor is R6's, not a preference", () => {
  test('it never cuts below the widest Hit@k any committed floor is measured at', () => {
    // R6's dilution floor is Hit@3 = 1.0: three distinct duplicate groups in the
    // top three. An autocut that can return two results makes that floor
    // unsatisfiable by construction whenever it fires, which is a product
    // promise lost to a ranking constant.
    const cutoffs = RANKING_FLOORS.map((floor) =>
      floor.metric === 'hit@1' ? 1 : floor.metric === 'hit@3' || floor.metric === 'dilution_hit@3' ? 3 : 0,
    );
    expect(AUTOCUT_MINIMUM_KEPT).toBeGreaterThanOrEqual(Math.max(...cutoffs));
  });
});

// ---------------------------------------------------------------------------
// End to end, through the shipped pipeline.
// ---------------------------------------------------------------------------

function candidate(id: string): Candidate {
  return {
    id,
    pageId: `page-${id}`,
    ordinal: 0,
    title: null,
    content: `content for ${id}`,
    origin: 'personal:mail',
    sourceType: 'document',
    createdAt: '2026-06-01',
    live: true,
    attestations: [],
    entityIds: [],
  };
}

/** A fused ranking with an enormous gap at position two. */
function outcomeWithCliff(): RecallOutcome {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const candidates = new Map(ids.map((id) => [id, candidate(id)] as const));
  return {
    plan: planFor(classifyIntent('anything at all')),
    arms: [
      { arm: 'fts', ranked: ids },
      { arm: 'vector', ranked: ['a', 'b'] },
    ],
    candidates,
    aliasLadder: [],
    resolvedEntityIds: [],
    degraded: [],
  };
}

describe('through composeRanking', () => {
  const request = { query: 'anything at all', limit: 5, now: new Date('2026-06-02T00:00:00.000Z') };

  test('rerank off leaves the list whole and autocut unapplied', () => {
    const response = composeRanking({ ...request, rerank: { enabled: false, score: () => 1 } }, outcomeWithCliff());
    expect(response.autocutApplied).toBe(false);
    expect(response.rerankApplied).toBe(false);
    expect(response.results).toHaveLength(5);
    for (const result of response.results) expect(result.rerankScore).toBeUndefined();
  });

  test('rerank on scores every result and lets autocut read it', () => {
    const response = composeRanking(
      {
        ...request,
        rerank: { enabled: true, score: (entry) => (entry.candidate.id <= 'c' ? 0.9 : 0.05) },
      },
      outcomeWithCliff(),
    );
    expect(response.rerankApplied).toBe(true);
    expect(response.autocutApplied).toBe(true);
    expect(response.results.map((result) => result.candidate.id)).toEqual(['a', 'b', 'c']);
  });

  test('an unavailable scorer degrades the read rather than failing it', () => {
    const response = composeRanking({ ...request, rerank: { enabled: true } }, outcomeWithCliff());
    expect(response.rerankApplied).toBe(false);
    expect(response.autocutApplied).toBe(false);
    expect(response.results).toHaveLength(5);
  });
});
