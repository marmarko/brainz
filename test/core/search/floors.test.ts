/**
 * The composed stack against U7's committed fixture corpus.
 *
 * **This is the unit's verification, and it is per-question-type, never
 * aggregate-only.** R6 is explicit about why: an aggregate lets a stack that is
 * excellent at named-entity lookup and blind to time report a healthy number.
 * So every floor in `evals/gates.ts` is checked — the aggregate nDCG@10, the
 * three probe-family floors, and the four per-question-type floors — through the
 * same classifier the eval harness uses, which refuses to pass a floor it did
 * not actually measure and treats an under-populated bucket as a violation
 * rather than a skip.
 *
 * **Two of R6's floors are not being measured, and this file says so out loud
 * on every run.** U7's committed vectors are synthetic — hashed lexical
 * projections, not embeddings (`evals/embeddings.ts` says so at length) — so the
 * vector arm is a second keyword arm. The alias and dilution floors turn on
 * probes whose gold this corpus offers no *keyed* path to: no content word the
 * query supplies appears anywhere on the answer's page, and what the answer does
 * carry is shared with more rows than the metric's cutoff has slots. Those
 * floors are reported `deferred`: neither met nor quietly excused.
 *
 * The deferral cannot rot, and the four ways it could are each closed:
 *
 *   - It is **conditional on the manifest**, counted row by row
 *     (`EmbeddingIndex.sources`). One provider vector and every floor is
 *     enforced again, with nobody having to remember anything.
 *   - It is **derived**, by `evals/lexical-reach.ts`, from the corpus. There is
 *     no list of excused probes to edit.
 *   - A **deferred floor that would pass is a failure** (`stale_deferral`), and
 *     so is a deferral set that is not exactly the committed one below. Both a
 *     new deferral and a stale one turn this file red.
 *   - It is **printed**, in full, every run — the way the hazard ledger prints
 *     its unguarded count.
 *
 * **Violations are separate from scores, and they are fatal.** A result outside
 * the query's grant, or a soft-deleted or quarantined chunk, is not a lower
 * score — it is a leak, and `evals/run.ts` counts it as such. The harness hands
 * every ranker the *whole* corpus precisely so that honouring the fence is the
 * ranker's job; the assertion below is that the list is empty. No fixture state
 * excuses a leak.
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
import {
  RANKING_FLOORS,
  classifyFloors,
  renderDeferrals,
  type FloorStatus,
} from '../../../evals/gates.ts';
import { probeReach } from '../../../evals/lexical-reach.ts';
import { MANIFEST_PATH } from '../../../evals/regenerate-embeddings.ts';
import { runEval } from '../../../evals/run.ts';
import { degradedStackRanker, stackRanker } from './corpus-ranker.ts';

const manifest = await Bun.file(`${import.meta.dir}/../../../${MANIFEST_PATH}`).text();
const embeddings = loadEmbeddings(manifest, corpusTexts(CORPUS));
const context = { corpus: CORPUS, embeddings };

const report = runEval(stackRanker, context);
const gate = classifyFloors(report, RANKING_FLOORS, context);

/**
 * The exact state of the gate, committed.
 *
 * **This is the anti-rot mechanism, and it is deliberately a whole-set equality
 * rather than a set of allowances.** A floor that starts being deferred is a
 * regression somebody has to look at; a floor that stops being deferred is a
 * deferral that must be deleted; a probe that quietly joins or leaves a
 * deferral's justification is a change in why the gate is not measuring
 * something. All three are the same edit here, and all three are red until
 * somebody makes it.
 */
const EXPECTED: Readonly<Record<string, FloorStatus>> = {
  'aggregate.ndcg10': 'met',
  'family.title_substring.hit1': 'met',
  'family.alias.hit1': 'deferred',
  'family.dilution.hit3': 'deferred',
  'type.relational.ndcg10': 'met',
  'type.named_entity.ndcg10': 'met',
  'type.temporal.ndcg10': 'met',
  'type.context_fenced.ndcg10': 'met',
};

/** Which probes each deferral rests on, and nothing else. */
/**
 * **Re-recorded when the embedding seat moved.** The committed fixture vectors
 * are synthetic — hashed lexical projections built at the active seat's width —
 * so a seat change of a different width regenerates every one of them and a
 * handful of probes cross the line in each direction. The floors' *statuses* did
 * not move (see {@link EXPECTED}); which probes carry each deferral did.
 *
 * That is exactly what this table is for: a deferral is auditable only if the
 * rows underneath it are written down, so re-recording it is a deliberate act
 * with a reason attached rather than a number that follows the code around.
 */
const EXPECTED_PROBES: Record<string, string[]> = {
  'family.alias.hit1': [
    'q-al-01-sam-current-title',
    'q-al-03-where-does-sam-work',
    'q-al-08-tosh-wants-changed',
    'q-al-14-kq-suppliers',
  ],
  'family.dilution.hit3': ['q-di-06-dpa-signed', 'q-di-09-pilot-brief', 'q-di-10-pilot-went'],
};

// Printed once per run, on stdout, the way `test/hazards/registry-consistency.test.ts`
// prints its unguarded count. A gate that is not measuring two of its floors has
// to say so where somebody reading a green suite will see it.
console.log(renderDeferrals(gate));

describe('the composed stack meets R6\'s deterministic-tier floors', () => {
  test('it leaks nothing: no fence, visibility or unknown-chunk violation', () => {
    expect(report.violations).toEqual([]);
  });

  test('every floor is classified, and none is missed', () => {
    // Printed on failure: a bare boolean here would make a regression a
    // bisecting exercise rather than a reading exercise.
    if (!gate.passed) {
      const lines = gate.violations.map(
        (violation) => `${violation.floorId} [${violation.kind}]: ${violation.detail}`,
      );
      throw new Error(`floors not met:\n  ${lines.join('\n  ')}`);
    }
    expect(gate.passed).toBe(true);
    expect(gate.outcomes.length).toBe(RANKING_FLOORS.length);
  });

  test('the gate is in exactly the state this file records', () => {
    const actual = Object.fromEntries(
      gate.outcomes.map((outcome) => [outcome.floorId, outcome.status]),
    );
    expect(actual).toEqual(EXPECTED);
  });

  test('each deferral rests on exactly the probes recorded here', () => {
    const actual = Object.fromEntries(
      gate.deferrals.map((outcome) => [
        outcome.floorId,
        (outcome.deferred?.probes ?? []).map((probe) => probe.queryId).sort(),
      ]),
    );
    expect(actual).toEqual(EXPECTED_PROBES);
  });

  test('a deferred floor is genuinely below its bar — an excused pass is a failure', () => {
    for (const outcome of gate.deferrals) {
      expect(outcome.value).toBeLessThan(outcome.minimum);
    }
    expect(gate.violations.filter((violation) => violation.kind === 'stale_deferral')).toEqual([]);
  });

  // The per-type floors are named individually as well as checked in bulk, so a
  // failure report names the question type rather than a floor id. None of them
  // is deferrable — a mean has no probe responsible for it.
  for (const type of ['relational', 'named_entity', 'temporal', 'context_fenced'] as const) {
    test(`per-question-type floor: ${type}`, () => {
      const bucket = report.byType[type];
      expect(bucket.count).toBeGreaterThan(0);
      expect(Number.isFinite(bucket.ndcg10)).toBe(true);
      expect(bucket.ndcg10).toBeGreaterThanOrEqual(0.65);
    });
  }

  test('probe families: title substring is met and enforced at full strength', () => {
    expect(report.byFamily.title_substring.hit1).toBeGreaterThanOrEqual(0.95);
  });

  test('the report is bound to the vectors it was produced against', () => {
    expect(report.embeddingManifestDigest).toBe(embeddings.manifestDigest);
  });
});

describe('the deferral is conditional on the fixture, not on the calendar', () => {
  test('one provider vector anywhere and every floor is enforced again', () => {
    // The switch, exercised rather than described. Nothing about the ranking
    // changes — only what the manifest says the vectors are — and both floors
    // come back as failures the moment a real vector exists.
    const withProvider = classifyFloors(report, RANKING_FLOORS, {
      corpus: CORPUS,
      embeddings: { ...embeddings, sources: { synthetic: embeddings.size - 1, provider: 1 } },
    });
    expect(withProvider.deferrals).toEqual([]);
    expect(withProvider.passed).toBe(false);
    const missed = withProvider.outcomes
      .filter((outcome) => outcome.status === 'missed')
      .map((outcome) => outcome.floorId)
      .sort();
    expect(missed).toEqual(['family.alias.hit1', 'family.dilution.hit3']);
  });

  test('every deferred probe is one the corpus offers no keyed path to', () => {
    // The justification, recomputed here from the corpus rather than read off
    // the record the gate produced — so a gate that started fabricating its own
    // evidence would be caught by the evidence.
    for (const outcome of gate.deferrals) {
      for (const probe of outcome.deferred?.probes ?? []) {
        const query = CORPUS.queriesById.get(probe.queryId);
        expect(query).toBeDefined();
        const required = probe.reach.verdicts.map((verdict) => verdict.chunkId);
        const recomputed = probeReach(CORPUS, query!, required, probe.reach.cutoff);
        expect(recomputed.semanticOnly).toBe(true);
        // And the evidence is non-vacuous: something the query said really is
        // unmatchable, and what the gold carries really is shared.
        for (const verdict of recomputed.verdicts) {
          expect(verdict.uncovered.length).toBeGreaterThan(0);
          expect(verdict.dominators.length).toBeGreaterThanOrEqual(verdict.cutoff);
        }
      }
    }
  });

  test('a probe whose gold carries the whole query is never deferrable', () => {
    // The refusal half, on two probes that pass today and that a looser
    // criterion excused: "MV roast contract" ties with a decoy on every key and
    // is separated by the priors, and "Ellie renewal price" has its entity on
    // the page rather than in the chunk. Both are the stack's job.
    for (const queryId of ['q-al-10-mv-roast-contract', 'q-al-13-ellie-renewal-price']) {
      const query = CORPUS.queriesById.get(queryId);
      expect(query).toBeDefined();
      expect(probeReach(CORPUS, query!, query!.answers, 1).semanticOnly).toBe(false);
    }
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
