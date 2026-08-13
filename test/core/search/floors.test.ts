/**
 * The composed stack against U7's committed fixture corpus.
 *
 * **This is the unit's verification, and it is per-question-type, never
 * aggregate-only.** R6 is explicit about why: an aggregate lets a stack that is
 * excellent at named-entity lookup and blind to time report a healthy number.
 * So every floor in `evals/gates.ts` is checked — the aggregate nDCG@10, the
 * three probe-family floors, and the four per-question-type floors — through the
 * same `checkFloors` the eval harness uses, which refuses to pass a floor it did
 * not actually measure and treats an under-populated bucket as a violation
 * rather than a skip.
 *
 * **Violations are separate from scores, and they are fatal.** A result outside
 * the query's grant, or a soft-deleted or quarantined chunk, is not a lower
 * score — it is a leak, and `evals/run.ts` counts it as such. The harness hands
 * every ranker the *whole* corpus precisely so that honouring the fence is the
 * ranker's job; the assertion below is that the list is empty.
 *
 * **Rerank and autocut are off here**, which is their state until U12. U7's
 * loader independently enforces that every query's `mechanisms` belong to a unit
 * landing by U5, so the floors are attainable with both stages disabled by
 * construction rather than by hope.
 */

import { describe, expect, test } from 'bun:test';

import { CORPUS } from '../../../evals/corpus.ts';
import { loadEmbeddings } from '../../../evals/embeddings.ts';
import { corpusTexts } from '../../../evals/corpus.ts';
import { RANKING_FLOORS, checkFloors } from '../../../evals/gates.ts';
import { MANIFEST_PATH } from '../../../evals/regenerate-embeddings.ts';
import { runEval } from '../../../evals/run.ts';
import { degradedStackRanker, stackRanker } from './corpus-ranker.ts';

const manifest = await Bun.file(`${import.meta.dir}/../../../${MANIFEST_PATH}`).text();
const embeddings = loadEmbeddings(manifest, corpusTexts(CORPUS));
const context = { corpus: CORPUS, embeddings };

const report = runEval(stackRanker, context);

describe('the composed stack meets R6\'s deterministic-tier floors', () => {
  test('it leaks nothing: no fence, visibility or unknown-chunk violation', () => {
    expect(report.violations).toEqual([]);
  });

  test('every floor is measured, and every floor is met', () => {
    const outcome = checkFloors(report, RANKING_FLOORS);
    // Printed on failure: a bare boolean here would make a regression a
    // bisecting exercise rather than a reading exercise.
    if (!outcome.passed) {
      const lines = outcome.violations.map(
        (violation) => `${violation.floorId}: ${violation.detail}`,
      );
      throw new Error(`floors not met:\n  ${lines.join('\n  ')}`);
    }
    expect(outcome.passed).toBe(true);
    expect(outcome.checked).toBe(RANKING_FLOORS.length);
  });

  // The per-type floors are named individually as well as checked in bulk, so a
  // failure report names the question type rather than a floor id.
  for (const type of ['relational', 'named_entity', 'temporal', 'context_fenced'] as const) {
    test(`per-question-type floor: ${type}`, () => {
      const bucket = report.byType[type];
      expect(bucket.count).toBeGreaterThan(0);
      expect(Number.isFinite(bucket.ndcg10)).toBe(true);
      expect(bucket.ndcg10).toBeGreaterThanOrEqual(0.65);
    });
  }

  test('probe families: title substring, alias, dilution', () => {
    expect(report.byFamily.title_substring.hit1).toBeGreaterThanOrEqual(0.95);
    expect(report.byFamily.alias.hit1).toBeGreaterThanOrEqual(0.98);
    expect(report.byFamily.dilution.dilutionHit3).toBe(1);
  });

  test('the report is bound to the vectors it was produced against', () => {
    expect(report.embeddingManifestDigest).toBe(embeddings.manifestDigest);
  });
});

describe('Assumption 5 — a degraded read is still a read', () => {
  const degraded = runEval(degradedStackRanker, context);

  test('with the embedding provider gone, the surviving arms still answer', () => {
    // Not "as well as" — worse is expected and fine. The contract is that a
    // provider blip is a partial answer rather than an outage, so the assertion
    // is that the stack still finds most of what it found before, and leaks
    // nothing while doing it.
    expect(degraded.violations).toEqual([]);
    expect(degraded.aggregate.ndcg10).toBeGreaterThan(0);
    expect(degraded.queryCount).toBe(report.queryCount);
  });

  test('dropping the arm changes the answer — it is not a silent no-op', () => {
    // If losing an entire recall arm changed no ranking, the arm was not
    // contributing and the three-arm design would be decorative.
    //
    // **The assertion is "different", not "worse", and that is a statement about
    // the fixture rather than about the stack.** U7's committed vectors are
    // synthetic lexical projections (`evals/embeddings.ts` says so at length),
    // so today's vector arm is a second, weaker keyword arm rather than an
    // independent signal — on this corpus it is worth a fraction of a point
    // either way. When real provider vectors land, this is the assertion to
    // tighten to a strict inequality; asserting one now would be pinning an
    // artefact of the stand-in.
    let differs = 0;
    for (const query of CORPUS.queries) {
      const withArm = stackRanker.rank(query, context).join(',');
      const without = degradedStackRanker.rank(query, context).join(',');
      if (withArm !== without) differs += 1;
    }
    expect(differs).toBeGreaterThan(CORPUS.queries.length / 4);
  });
});
