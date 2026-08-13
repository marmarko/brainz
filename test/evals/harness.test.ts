/**
 * The harness and the gate, exercised with rankers built to cheat.
 *
 * **This is the file that targets the recurring defect directly.** A gate fails
 * open when it is satisfied by a missing signal, by a swallowed error, or by a
 * check that runs after the value it protects has already been used. So every
 * ranker here is a specific cheat:
 *
 *   - one that reaches across the origin fence and would otherwise be rewarded
 *     for it, because the chunk it leaked is genuinely relevant;
 *   - one that returns a soft-deleted page that is a better lexical match than
 *     anything live;
 *   - one that answers nothing, to check that empty buckets surface as `NaN` and
 *     under-populated ones as violations rather than as passes;
 *   - one that returns the same chunk three times, to check that a duplicate
 *     cannot be counted three times.
 *
 * The `emptyReport` cases are the sharpest: a report with zero queries in a
 * bucket must **fail** the gate. An implementation that compares a `NaN` mean
 * against a floor passes or fails depending only on which direction the
 * comparison was written in, and neither direction is a decision anyone made.
 */

import { test, expect, describe } from 'bun:test';

import { CORPUS, corpusTexts } from '../../evals/corpus.ts';
import { loadEmbeddings } from '../../evals/embeddings.ts';
import { goldOracle, lexicalBaseline, strongestNaive, vectorBaseline } from '../../evals/baselines.ts';
import { checkFloors, checkLowerBound, measure, RANKING_FLOORS, type RankingFloor } from '../../evals/gates.ts';
import { runEval, RESULT_LIMIT, type EvalReport, type Ranker, type RankerContext } from '../../evals/run.ts';
import { MANIFEST_PATH } from '../../evals/regenerate-embeddings.ts';
import { QUERY_FAMILIES, QUESTION_TYPES } from '../../evals/fixtures/types.ts';

const manifest = await Bun.file(MANIFEST_PATH).text();
const context: RankerContext = { corpus: CORPUS, embeddings: loadEmbeddings(manifest, corpusTexts(CORPUS)) };

function rankerReturning(pick: (queryId: string) => readonly string[]): Ranker {
  return { name: 'test-ranker', description: 'a ranker written to misbehave', rank: (query) => pick(query.id) };
}

describe('the harness', () => {
  test('scores every query, never a subset', () => {
    const report = runEval(goldOracle, context);
    expect(report.queryCount).toBe(CORPUS.queries.length);
    let bucketed = 0;
    for (const type of QUESTION_TYPES) bucketed += report.byType[type].count;
    expect(bucketed).toBe(CORPUS.queries.length);
    let familyBucketed = 0;
    for (const family of QUERY_FAMILIES) familyBucketed += report.byFamily[family].count;
    expect(familyBucketed).toBe(CORPUS.queries.length);
  });

  test('is deterministic: two runs of the same ranker produce identical numbers', () => {
    const first = runEval(lexicalBaseline, context);
    const second = runEval(lexicalBaseline, context);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  test('binds every report to the vectors it was computed against', () => {
    const report = runEval(vectorBaseline, context);
    expect(report.embeddingManifestDigest).toBe(context.embeddings.manifestDigest);
    expect(report.embeddingManifestDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('records a fence violation and refuses to reward the leak', () => {
    // A work-origin chunk returned to a personal-grant query. It is a genuinely
    // good answer to the *other* half of the pair, which is precisely why a
    // scoring rule that let it earn relevance would make leaking profitable.
    const leaky = rankerReturning((queryId) =>
      queryId === 'q-cf-01b-renewal-price-personal'
        ? ['p-halcyon-renewal-2026#0', 'p-gym-renewal#0']
        : goldOracle.rank(CORPUS.queriesById.get(queryId)!, context),
    );
    const report = runEval(leaky, context);

    const fence = report.violations.filter((violation) => violation.kind === 'fence');
    expect(fence.length).toBe(1);
    expect(fence[0]?.queryId).toBe('q-cf-01b-renewal-price-personal');

    // The leaking query scores zero even though its second result is the right
    // answer at rank 2.
    expect(report.byType.context_fenced.hit3).toBeLessThan(1);
    expect(checkFloors(report).passed).toBe(false);
    expect(checkFloors(report).violations.some((violation) => violation.kind === 'leak')).toBe(true);
  });

  test('records a visibility violation for a soft-deleted chunk', () => {
    const necromancer = rankerReturning((queryId) =>
      queryId === 'q-cf-01a-renewal-price-work'
        ? ['p-deleted-old-renewal#0']
        : goldOracle.rank(CORPUS.queriesById.get(queryId)!, context),
    );
    const report = runEval(necromancer, context);
    const visibility = report.violations.filter((violation) => violation.kind === 'visibility');
    expect(visibility.length).toBe(1);
    expect(visibility[0]?.chunkId).toBe('p-deleted-old-renewal#0');
  });

  test('records a visibility violation for a quarantined chunk', () => {
    const spammer = rankerReturning((queryId) =>
      queryId === 'q-ts-08-firmware-hotfix'
        ? ['p-quarantined-spam#0', 'p-firmware-fix#0']
        : goldOracle.rank(CORPUS.queriesById.get(queryId)!, context),
    );
    const report = runEval(spammer, context);
    expect(report.violations.some((violation) => violation.chunkId === 'p-quarantined-spam#0')).toBe(true);
  });

  test('records a violation for a chunk id that is not in the corpus', () => {
    const inventor = rankerReturning(() => ['p-invented#0']);
    const report = runEval(inventor, context);
    expect(report.violations.every((violation) => violation.kind === 'unknown_chunk')).toBe(true);
    expect(report.violations.length).toBe(CORPUS.queries.length);
  });

  test('refuses a ranker that returns the same chunk twice', () => {
    const stutterer = rankerReturning(() => ['p-verdant-overview#0', 'p-verdant-overview#0']);
    expect(() => runEval(stutterer, context)).toThrow(/twice/);
  });

  test('refuses a ranker that returns more than the result limit', () => {
    const firehose = rankerReturning(() => CORPUS.chunkIds.slice(0, RESULT_LIMIT + 1));
    expect(() => runEval(firehose, context)).toThrow(/the limit is/);
  });

  test('a ranker that answers nothing scores zero, and the gate says so', () => {
    const mute = rankerReturning(() => []);
    const report = runEval(mute, context);
    expect(report.aggregate.ndcg10).toBe(0);
    expect(report.violations.length).toBe(0); // returning nothing is not a leak
    const gate = checkFloors(report);
    expect(gate.passed).toBe(false);
    expect(gate.violations.every((violation) => violation.kind === 'below_floor')).toBe(true);
  });
});

describe('the gate', () => {
  const oracleReport = runEval(goldOracle, context);

  test('the gold oracle clears every floor — the attainability ceiling', () => {
    const gate = checkFloors(oracleReport);
    expect(gate.passed).toBe(true);
    expect(gate.checked).toBe(RANKING_FLOORS.length);
    expect(Object.keys(gate.measurements).sort()).toEqual(RANKING_FLOORS.map((floor) => floor.id).sort());
  });

  test('a floor whose measurement is missing is a violation, not a pass', () => {
    const crippled = {
      ...oracleReport,
      byFamily: { ...oracleReport.byFamily, alias: undefined },
    } as unknown as EvalReport;
    const gate = checkFloors(crippled);
    expect(gate.passed).toBe(false);
    expect(gate.violations.some((violation) => violation.kind === 'unmeasured')).toBe(true);
  });

  test('an empty bucket is a violation, and its NaN mean never reaches a comparison', () => {
    const emptied = {
      ...oracleReport,
      byType: {
        ...oracleReport.byType,
        temporal: { count: 0, ndcg10: Number.NaN, hit1: Number.NaN, hit3: Number.NaN },
      },
    } as EvalReport;
    const gate = checkFloors(emptied);
    expect(gate.passed).toBe(false);
    const violation = gate.violations.find((candidate) => candidate.floorId === 'type.temporal.ndcg10');
    expect(violation?.kind).toBe('insufficient_queries');
  });

  test('a non-finite value in a well-populated bucket is a violation on its own', () => {
    const poisoned = {
      ...oracleReport,
      byType: {
        ...oracleReport.byType,
        temporal: { ...oracleReport.byType.temporal, ndcg10: Number.NaN },
      },
    } as EvalReport;
    const gate = checkFloors(poisoned);
    const violation = gate.violations.find((candidate) => candidate.floorId === 'type.temporal.ndcg10');
    expect(violation?.kind).toBe('non_finite');
  });

  test('an under-populated bucket fails even when its score is perfect', () => {
    const thin = {
      ...oracleReport,
      byFamily: {
        ...oracleReport.byFamily,
        dilution: { ...oracleReport.byFamily.dilution, count: 1 },
      },
    } as EvalReport;
    const gate = checkFloors(thin);
    const violation = gate.violations.find((candidate) => candidate.floorId === 'family.dilution.hit3');
    expect(violation?.kind).toBe('insufficient_queries');
  });

  test('a per-type floor is never silently satisfied by the aggregate', () => {
    // A report whose aggregate is perfect and whose relational bucket is not.
    const lopsided = {
      ...oracleReport,
      byType: {
        ...oracleReport.byType,
        relational: { ...oracleReport.byType.relational, ndcg10: 0.1 },
      },
    } as EvalReport;
    const gate = checkFloors(lopsided);
    expect(gate.passed).toBe(false);
    expect(gate.violations.some((violation) => violation.floorId === 'type.relational.ndcg10')).toBe(true);
  });

  test('checkFloors refuses an empty floor list rather than passing everything', () => {
    expect(() => checkFloors(oracleReport, [])).toThrow(/no floors/);
  });

  test('every floor R6 names is present, with R6\'s own numbers', () => {
    const byId = new Map(RANKING_FLOORS.map((floor) => [floor.id, floor] as const));
    expect(byId.get('aggregate.ndcg10')?.minimum).toBe(0.65);
    expect(byId.get('family.title_substring.hit1')?.minimum).toBe(0.95);
    expect(byId.get('family.alias.hit1')?.minimum).toBe(0.98);
    expect(byId.get('family.dilution.hit3')?.minimum).toBe(1);
    for (const type of QUESTION_TYPES) {
      expect(byId.get(`type.${type}.ndcg10`)?.minimum).toBe(0.65);
    }
  });
});

describe('the lower-bound check', () => {
  test('refuses a floor it has no naive value for, rather than skipping it', () => {
    const partial = new Map([['aggregate.ndcg10', { value: 0.1, ranker: 'x' }]]);
    expect(() => checkLowerBound(partial)).toThrow(/no naive baseline value for/);
  });

  test('refuses a non-finite naive value', () => {
    const poisoned = new Map(
      RANKING_FLOORS.map((floor) => [floor.id, { value: Number.NaN, ranker: 'x' }] as const),
    );
    expect(() => checkLowerBound(poisoned)).toThrow(/not finite/);
  });

  test('a naive value sitting exactly on the ceiling clears; one above it does not', () => {
    const floor: RankingFloor = {
      id: 'test.floor',
      label: 'test',
      metric: 'ndcg@10',
      scope: { kind: 'aggregate' },
      minimum: 0.65,
      minimumQueries: 1,
      calibrationMargin: 0.1,
      source: 'test',
    };
    const onCeiling = checkLowerBound(new Map([['test.floor', { value: 0.55, ranker: 'x' }]]), [floor]);
    expect(onCeiling.clears).toBe(true);
    const above = checkLowerBound(new Map([['test.floor', { value: 0.5501, ranker: 'x' }]]), [floor]);
    expect(above.clears).toBe(false);
  });

  test('strongestNaive takes the maximum and refuses an empty or non-finite set', () => {
    expect(strongestNaive([0.1, 0.4, 0.2])).toBe(0.4);
    expect(() => strongestNaive([])).toThrow(/vacuous/);
    expect(() => strongestNaive([0.1, Number.NaN])).toThrow(/non-finite/);
  });
});

describe('both naive baselines, as shipped', () => {
  test('respect the fence and the visibility rules — naive about ranking only', () => {
    for (const ranker of [lexicalBaseline, vectorBaseline]) {
      const report = runEval(ranker, context);
      expect(report.violations).toEqual([]);
    }
  });

  test('score below every floor, which is what makes the lower bound mean anything', () => {
    for (const ranker of [lexicalBaseline, vectorBaseline]) {
      const report = runEval(ranker, context);
      for (const floor of RANKING_FLOORS) {
        const measurement = measure(report, floor);
        expect(measurement).toBeDefined();
        expect(measurement!.value).toBeLessThan(floor.minimum);
      }
    }
  });
});
