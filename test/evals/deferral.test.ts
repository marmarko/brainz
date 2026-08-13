/**
 * The third gate state — "not yet measurable" — and every way it could become a
 * silent exemption.
 *
 * **A deferral is the most dangerous thing in a measurement apparatus**, because
 * it converts a red number into a green suite and then stays. So this file is
 * written the way `test/evals/harness.test.ts` is written: every case is an
 * attempt to obtain a deferral that should not be granted, and the assertion is
 * that the gate refuses.
 *
 *   - **A provider vector anywhere revokes it.** Not a flag, not a constant: the
 *     manifest rows are counted, and the committed provider sample is used to
 *     produce a mixed index rather than a hand-built object.
 *   - **A mean is never deferrable.** No probe is responsible for an average, so
 *     the aggregate and per-type floors can only be met or missed.
 *   - **One reachable probe among the misses revokes it**, in full. A floor
 *     missed for two reasons, one of them the stack's fault, is missed.
 *   - **A deferral that would pass is a violation.** Reached through
 *     `violationsOf`, which exists so this check has a seam — `classifyFloor`
 *     cannot produce the state, which is the point of checking for it.
 *   - **A leak is fatal whatever the fixture is.** No state of the vectors
 *     excuses returning a chunk the asking credential may not see.
 *
 * The criterion itself (`evals/lexical-reach.ts`) is tested through its refusals
 * too: a probe whose gold carries everything the query supplied is isolable, and
 * therefore never deferrable, however badly the stack ranks it.
 */

import { describe, expect, test } from 'bun:test';

import { CORPUS, corpusTexts } from '../../evals/corpus.ts';
import { loadEmbeddings } from '../../evals/embeddings.ts';
import {
  RANKING_FLOORS,
  classifyFloor,
  classifyFloors,
  deferrableCutoffFor,
  renderDeferrals,
  violationsOf,
  type DeferralContext,
  type FloorOutcome,
  type RankingFloor,
} from '../../evals/gates.ts';
import { isolationOf, probeReach, queryKeys } from '../../evals/lexical-reach.ts';
import { MANIFEST_PATH, PROVIDER_SAMPLE_PATH } from '../../evals/regenerate-embeddings.ts';
import type { EvalReport, QueryOutcome } from '../../evals/run.ts';

const manifest = await Bun.file(MANIFEST_PATH).text();
const embeddings = loadEmbeddings(manifest, corpusTexts(CORPUS));
const context: DeferralContext = { corpus: CORPUS, embeddings };

const ALIAS_FLOOR = RANKING_FLOORS.find((floor) => floor.id === 'family.alias.hit1')!;
const DILUTION_FLOOR = RANKING_FLOORS.find((floor) => floor.id === 'family.dilution.hit3')!;
const AGGREGATE_FLOOR = RANKING_FLOORS.find((floor) => floor.id === 'aggregate.ndcg10')!;

/**
 * A report in which the named queries missed and every other query in the corpus
 * scored perfectly.
 *
 * Built from the real corpus rather than from invented queries, because the
 * whole criterion is a function of the corpus: a synthetic query would be a
 * query nothing can be looked up in.
 */
function reportMissing(missing: ReadonlyMap<string, readonly string[]>): EvalReport {
  const perQuery: QueryOutcome[] = CORPUS.queries.map((query) => {
    const missedGroups = missing.get(query.id);
    const missed = missedGroups !== undefined;
    return {
      queryId: query.id,
      family: query.family,
      type: query.type,
      ndcg10: missed ? 0 : 1,
      hit1: missed ? 0 : 1,
      hit3: missed ? 0 : 1,
      dilutionHit3: query.family === 'dilution' ? (missed ? 0 : 1) : undefined,
      missedGroups: missedGroups ?? [],
    };
  });

  const bucketOf = (subset: readonly QueryOutcome[]) => ({
    count: subset.length,
    ndcg10: subset.reduce((total, one) => total + one.ndcg10, 0) / subset.length,
    hit1: subset.reduce((total, one) => total + one.hit1, 0) / subset.length,
    hit3: subset.reduce((total, one) => total + one.hit3, 0) / subset.length,
  });
  const familyBucketOf = (subset: readonly QueryOutcome[]) => {
    const dilution = subset
      .map((one) => one.dilutionHit3)
      .filter((value): value is number => value !== undefined);
    return {
      ...bucketOf(subset),
      dilutionHit3: dilution.reduce((total, one) => total + one, 0) / dilution.length,
      duplicateOccupancy3: 0,
    };
  };

  const byFamily = Object.fromEntries(
    (['title_substring', 'alias', 'dilution', 'general'] as const).map((family) => [
      family,
      familyBucketOf(perQuery.filter((one) => one.family === family)),
    ]),
  ) as EvalReport['byFamily'];
  const byType = Object.fromEntries(
    (['relational', 'named_entity', 'temporal', 'context_fenced'] as const).map((type) => [
      type,
      bucketOf(perQuery.filter((one) => one.type === type)),
    ]),
  ) as EvalReport['byType'];

  return {
    ranker: 'synthetic-report',
    queryCount: perQuery.length,
    aggregate: bucketOf(perQuery),
    byType,
    byFamily,
    violations: [],
    embeddingManifestDigest: embeddings.manifestDigest,
    perQuery,
  };
}

/** The two alias probes the real gate defers, and nothing else. */
const BLOCKED_ALIAS = new Map<string, readonly string[]>([
  ['q-al-03-where-does-sam-work', []],
  ['q-al-08-tosh-wants-changed', []],
]);

describe('the deferral is conditional on the manifest, counted row by row', () => {
  test('the committed manifest is entirely synthetic, and says so from its rows', () => {
    expect(embeddings.sources.provider).toBe(0);
    expect(embeddings.sources.synthetic).toBe(embeddings.size);
  });

  test('a manifest carrying real provider rows revokes every deferral', async () => {
    // The provider sample is the committed two-row file in the shape real
    // vectors arrive in, so this is the actual parse path rather than an object
    // built to look like one.
    const sample = await Bun.file(PROVIDER_SAMPLE_PATH).text();
    const providerRows = sample.split('\n').filter((line) => line.trim().length > 0);
    expect(providerRows.length).toBeGreaterThan(0);

    // The sample re-encodes rows the committed manifest already carries, which
    // is exactly the shape of a real migration: the synthetic row for a text is
    // replaced by the provider's, one text at a time.
    const replaced = new Set(
      providerRows.map((line) => {
        const row = JSON.parse(line) as { id: string; encoding: string };
        return `${row.id}|${row.encoding}`;
      }),
    );
    const kept = manifest
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .filter((line) => {
        const row = JSON.parse(line) as { id: string; encoding: string };
        return !replaced.has(`${row.id}|${row.encoding}`);
      });

    const mixed = loadEmbeddings([...kept, ...providerRows].join('\n'), corpusTexts(CORPUS));
    expect(mixed.sources.provider).toBe(providerRows.length);

    const before = classifyFloor(reportMissing(BLOCKED_ALIAS), ALIAS_FLOOR, context);
    expect(before.status).toBe('deferred');

    const after = classifyFloor(reportMissing(BLOCKED_ALIAS), ALIAS_FLOOR, {
      corpus: CORPUS,
      embeddings: mixed,
    });
    expect(after.status).toBe('missed');
  });
});

describe('what can never be deferred', () => {
  test('a mean has no rank to be judged at, so no nDCG metric is deferrable', () => {
    // The structural half of condition 2. A behavioural test alone walks past a
    // mutation that gives `ndcg@10` a cutoff, because whether the probes behind
    // it are isolable *at that cutoff* is an accident of the corpus.
    expect(deferrableCutoffFor('ndcg@10')).toBeUndefined();
    expect(deferrableCutoffFor('hit@1')).toBe(1);
    expect(deferrableCutoffFor('hit@3')).toBe(3);
    expect(deferrableCutoffFor('dilution_hit@3')).toBe(3);
  });

  test('a mean has no probe responsible for it, so nDCG floors are never deferred', () => {
    // Every query in the corpus missing — the most deferrable-looking report
    // there could be — and the aggregate floor is still simply missed.
    const everything = new Map<string, readonly string[]>(
      CORPUS.queries.map((query) => [
        query.id,
        query.family === 'dilution' ? (query.requiredGroups ?? []) : [],
      ]),
    );
    const outcome = classifyFloor(reportMissing(everything), AGGREGATE_FLOOR, context);
    expect(outcome.status).toBe('missed');
  });

  test('one probe the corpus does offer a keyed path to revokes the whole deferral', () => {
    const withReachable = new Map<string, readonly string[]>([
      ...BLOCKED_ALIAS,
      // Its gold carries every key the query supplied — the stack's job.
      ['q-al-10-mv-roast-contract', []],
    ]);
    expect(classifyFloor(reportMissing(withReachable), ALIAS_FLOOR, context).status).toBe('missed');
  });

  test('a floor below its bar with no probe missing is missed, not deferred', () => {
    // Arithmetic nobody understands: the bucket says the floor is missed and no
    // probe says why. Enforce rather than excuse.
    const report = reportMissing(new Map());
    const impossible: RankingFloor = { ...ALIAS_FLOOR, minimum: 2 };
    expect(classifyFloor(report, impossible, context).status).toBe('missed');
  });

  test('an under-populated bucket is missed rather than deferred', () => {
    const report = reportMissing(BLOCKED_ALIAS);
    const demanding: RankingFloor = { ...ALIAS_FLOOR, minimumQueries: 1000 };
    expect(classifyFloor(report, demanding, context).status).toBe('missed');
  });

  test('a dilution miss that names no crowded-out group is missed, not deferred', () => {
    // The metric is all-or-nothing, so a zero with no group behind it is a
    // measurement that cannot say what it measured — which is the shape a leaked
    // query produces. Refuse rather than guess.
    const nameless = new Map<string, readonly string[]>([['q-di-09-pilot-brief', []]]);
    expect(classifyFloor(reportMissing(nameless), DILUTION_FLOOR, context).status).toBe('missed');

    // And it revokes a deferral the *other* misses would have earned. Skipping
    // the unexplained one instead of refusing on it is the fail-open shape: the
    // floor would come back deferred on the strength of the probes that could be
    // explained, with one it could not quietly dropped from the reckoning.
    const mixed = new Map<string, readonly string[]>([
      ['q-di-09-pilot-brief', ['dup-pilot-outcome']],
      ['q-di-10-pilot-went', []],
    ]);
    expect(classifyFloor(reportMissing(mixed), DILUTION_FLOOR, context).status).toBe('missed');

    // The control: with both explained, the same floor IS deferred — so the
    // assertion above is about the missing group rather than about the report.
    const explained = new Map<string, readonly string[]>([
      ['q-di-09-pilot-brief', ['dup-pilot-outcome']],
      ['q-di-10-pilot-went', ['dup-pilot-outcome']],
    ]);
    expect(classifyFloor(reportMissing(explained), DILUTION_FLOOR, context).status).toBe('deferred');
  });

  test('a leak is fatal whatever the vectors are', () => {
    const report = reportMissing(BLOCKED_ALIAS);
    const leaked: EvalReport = {
      ...report,
      violations: [
        {
          queryId: 'q-al-03-where-does-sam-work',
          kind: 'fence',
          chunkId: 'p-verdant-overview#2',
          detail: 'result origin work:files is outside the query\'s grant',
        },
      ],
    };
    const gate = classifyFloors(leaked, [ALIAS_FLOOR], context);
    expect(gate.passed).toBe(false);
    expect(gate.violations.some((violation) => violation.kind === 'leak')).toBe(true);
  });
});

describe('a deferral that would now pass is itself a failure', () => {
  test('violationsOf reports a stale deferral', () => {
    const stale: FloorOutcome = {
      floorId: 'family.alias.hit1',
      label: 'alias Hit@1',
      status: 'deferred',
      value: 1,
      minimum: 0.98,
      count: 14,
      deferred: { reason: 'stale', probes: [] },
    };
    const violations = violationsOf([stale]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.kind).toBe('stale_deferral');
  });

  test('a deferral genuinely below its bar is not reported', () => {
    const honest: FloorOutcome = {
      floorId: 'family.alias.hit1',
      label: 'alias Hit@1',
      status: 'deferred',
      value: 0.857,
      minimum: 0.98,
      count: 14,
      deferred: { reason: 'synthetic vectors', probes: [] },
    };
    expect(violationsOf([honest])).toEqual([]);
  });
});

describe('the eligibility criterion refuses more than it grants', () => {
  test('a gold carrying every key the query supplied is isolable', () => {
    // "MV roast contract": the alias resolves the person, and the gold carries
    // the person and both residual words. It ties with a decoy on keys and the
    // priors separate them — which is ranking, not a missing arm.
    const query = CORPUS.queriesById.get('q-al-10-mv-roast-contract')!;
    const verdict = isolationOf(CORPUS, query, 'p-kettle-supplier-list#1', 1);
    expect(verdict.uncovered).toEqual([]);
    expect(verdict.isolable).toBe(true);
  });

  test('a gold whose page carries the entity, even when its own chunk does not', () => {
    // "Ellie renewal price": the chunk with the price names nobody; the page's
    // other paragraph names her. Coverage is a question about the document.
    const query = CORPUS.queriesById.get('q-al-13-ellie-renewal-price')!;
    expect(isolationOf(CORPUS, query, 'p-halcyon-renewal-2026#0', 1).isolable).toBe(true);
  });

  test('a gold sharing nothing but a crowded token is not isolable', () => {
    // "Windbreak pilot brief": the outcome page is the one page about the pilot
    // that never says Windbreak.
    const query = CORPUS.queriesById.get('q-di-09-pilot-brief')!;
    const verdict = isolationOf(CORPUS, query, 'p-pilot-outcome#0', 3);
    expect(verdict.uncovered).toContain('entity:project-windbreak');
    expect(verdict.carried).toEqual(['token:pilot']);
    expect(verdict.dominators.length).toBeGreaterThanOrEqual(3);
    expect(verdict.isolable).toBe(false);
  });

  test('the cutoff is the metric\'s, and a wider one grants less', () => {
    // The same chunk, judged for a Hit@1 floor and for a top-3 one. A bigger
    // cutoff means more slots, so more dominators are needed to block it — the
    // criterion has to get harder as the metric gets easier, not the reverse.
    const query = CORPUS.queriesById.get('q-al-08-tosh-wants-changed')!;
    const tight = isolationOf(CORPUS, query, 'p-tosh-review#0', 1);
    const wide = isolationOf(CORPUS, query, 'p-tosh-review#0', 1000);
    expect(tight.isolable).toBe(false);
    expect(wide.isolable).toBe(true);
  });

  test('one reachable chunk among a probe\'s required set refuses the probe', () => {
    const query = CORPUS.queriesById.get('q-di-09-pilot-brief')!;
    const blocked = probeReach(CORPUS, query, ['p-pilot-outcome#0'], 3);
    expect(blocked.semanticOnly).toBe(true);
    // The brief itself is titled with the query and trivially reachable, so a
    // probe required to find both is not semantically blocked.
    const both = probeReach(CORPUS, query, ['p-pilot-outcome#0', 'p-pilot-brief-file#0'], 3);
    expect(both.semanticOnly).toBe(false);
  });

  test('a gold key naming a chunk outside the corpus throws rather than excusing it', () => {
    const query = CORPUS.queriesById.get('q-al-08-tosh-wants-changed')!;
    expect(() => isolationOf(CORPUS, query, 'p-not-a-page#9', 1)).toThrow(/not a chunk/);
  });

  test('an entity alias in the query is the entity key, not a residual token', () => {
    // The residual split the stack computes: the name says which subject, the
    // rest says which of that subject's documents. Counting `mv` as a residual
    // token would make every page failing to say `MV` look unreachable.
    const keys = queryKeys(CORPUS, CORPUS.queriesById.get('q-al-10-mv-roast-contract')!);
    expect(keys.entities).toContain('marcus-vandenberg');
    expect(keys.residual).toEqual(['contract', 'roast']);
  });
});

describe('the deferral is visible', () => {
  test('the rendered block names every deferred floor and every probe', () => {
    const gate = classifyFloors(reportMissing(BLOCKED_ALIAS), [ALIAS_FLOOR, DILUTION_FLOOR], context);
    const rendered = renderDeferrals(gate);
    expect(rendered).toContain('family.alias.hit1');
    expect(rendered).toContain('q-al-03-where-does-sam-work');
    expect(rendered).toContain('q-al-08-tosh-wants-changed');
    // The derived evidence, not a slogan.
    expect(rendered).toContain('token:work');
  });

  test('with nothing deferred the block says zero rather than nothing', () => {
    const gate = classifyFloors(reportMissing(new Map()), [ALIAS_FLOOR], context);
    expect(renderDeferrals(gate)).toContain('0 floors deferred');
  });
});
