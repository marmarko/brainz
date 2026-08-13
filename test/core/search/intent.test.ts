/**
 * Stage 2 — the zero-LLM intent classifier.
 *
 * The ledger row (`stack.intent-classification`) says the design commits intent
 * as a *router* only, and that the ranking role is the part that makes "who is
 * Bob" and "what did I say last week" rank differently. So this suite tests two
 * things that are easy to conflate:
 *
 *   1. **The label.** Which of the five intents a query gets.
 *   2. **The plan.** That the label actually moves the four ranking knobs it is
 *      supposed to move — arm weights, RRF k, exact-match boost, recency tilt.
 *
 * A classifier that produced perfect labels and one constant plan would pass (1)
 * and fail (2), and it is (2) that the retrieval quality depends on. The
 * end-to-end half — that two intents produce *different rankings on the same
 * corpus* — is in `pipeline.test.ts`, because it needs a corpus.
 *
 * KTD4 is the standing constraint: no model call. Every assertion here runs
 * against pure string work, which is also why the classifier can be exhaustively
 * tested at all.
 */

import { describe, expect, test } from 'bun:test';

import { INTENTS, classifyIntent, planFor } from '../../../src/core/search/intent.ts';

function plan(text: string) {
  return planFor(classifyIntent(text));
}

describe('the label', () => {
  test('"who is X" is an entity lookup', () => {
    expect(classifyIntent('who is Sam').intent).toBe('entity_lookup');
    expect(classifyIntent('who is MV').intent).toBe('entity_lookup');
    expect(classifyIntent('Dana Ilves who she is').intent).toBe('entity_lookup');
  });

  test('a relation between two things is relational, not a lookup', () => {
    expect(classifyIntent('who invested in Verdant Loom').intent).toBe('relational');
    expect(classifyIntent('where does Sam work').intent).toBe('relational');
    expect(classifyIntent('which company employs Elena Barros').intent).toBe('relational');
    expect(classifyIntent('what is Project Saltmarsh part of').intent).toBe('relational');
    expect(classifyIntent('who else has Tessellate backed').intent).toBe('relational');
  });

  test('time words make a query temporal', () => {
    expect(classifyIntent('what did I say last week').intent).toBe('temporal');
    expect(classifyIntent("Sam's current title").intent).toBe('temporal');
    expect(classifyIntent('is the firmware battery drain fixed').intent).toBe('temporal');
    expect(classifyIntent('where is Kettle and Quill based now').intent).toBe('temporal');
    expect(classifyIntent('did the renewal price change').intent).toBe('temporal');
  });

  test('a bare noun phrase is lexical', () => {
    expect(classifyIntent('Saltmarsh launch retro').intent).toBe('lexical');
    expect(classifyIntent('data processing addendum').intent).toBe('lexical');
  });

  test('an empty query is classified rather than crashing', () => {
    // A read surface takes whatever arrives. A throw here would be a 500 on a
    // stray keystroke; the fail-closed answer is the least-committed plan.
    expect(classifyIntent('   ').intent).toBe('exploratory');
  });

  test('every intent in the union has a plan, and every plan is well formed', () => {
    for (const intent of INTENTS) {
      const p = planFor({ intent, signals: [], schedule: false, relations: [] });
      expect(p.rrfK).toBeGreaterThan(0);
      expect(p.armWeights.vector).toBeGreaterThanOrEqual(0);
      expect(p.armWeights.fts).toBeGreaterThanOrEqual(0);
      expect(p.armWeights.graph).toBeGreaterThanOrEqual(0);
      expect(p.armWeights.vector + p.armWeights.fts + p.armWeights.graph).toBeGreaterThan(0);
      expect(p.recencyTilt).toBeGreaterThanOrEqual(0);
      expect(p.exactMatchBoost).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('the plan — the classifier is a ranking input, not only a router', () => {
  test('an entity lookup runs the graph arm and weights it', () => {
    const entity = plan('who is Sam');
    expect(entity.useGraphArm).toBe(true);
    expect(entity.armWeights.graph).toBeGreaterThan(0);
  });

  test('a relational query weights the graph arm above the vector arm', () => {
    const relational = plan('who invested in Verdant Loom');
    expect(relational.useGraphArm).toBe(true);
    expect(relational.armWeights.graph).toBeGreaterThan(relational.armWeights.vector);
  });

  test('a lexical query does not run the graph arm at all', () => {
    // The arm costs a fan-out query per call. An intent that cannot use it must
    // not pay for it — and a graph arm that always runs is a graph arm whose
    // routing has never been exercised.
    const lexical = plan('data processing addendum');
    expect(lexical.useGraphArm).toBe(false);
    expect(lexical.armWeights.graph).toBe(0);
  });

  test('recency tilt is the temporal intent, and near zero elsewhere', () => {
    const temporal = plan('what did I say last week');
    const lexical = plan('Saltmarsh launch retro');
    const relational = plan('who founded Kettle and Quill');

    expect(temporal.recencyTilt).toBeGreaterThan(lexical.recencyTilt);
    expect(temporal.recencyTilt).toBeGreaterThan(relational.recencyTilt);
    // Not merely lower: a standing relational fact is often the oldest page in
    // the brain, so a tilt that leaked into it would rank the newest mention of
    // a founder above the profile that states the founding.
    expect(relational.recencyTilt).toBe(0);
  });

  test('a lexical query leans on the exact-match boost', () => {
    const lexical = plan('Saltmarsh launch retro');
    const exploratory = plan('   ');
    expect(lexical.exactMatchBoost).toBeGreaterThan(exploratory.exactMatchBoost);
  });

  test('RRF k differs by intent', () => {
    // k controls how quickly rank advantage decays. One constant k for every
    // intent is the shape that makes the classifier decorative.
    const ks = new Set(INTENTS.map((intent) => planFor({ intent, signals: [], schedule: false, relations: [] }).rrfK));
    expect(ks.size).toBeGreaterThan(1);
  });
});

describe('schedule cues', () => {
  test('a calendar-shaped question is marked, and lifts the calendar prior', () => {
    expect(classifyIntent('what is happening on 3 September').schedule).toBe(true);
    expect(classifyIntent('the dentist appointment').schedule).toBe(true);
    expect(classifyIntent('self assessment deadline').schedule).toBe(true);
    expect(classifyIntent('who invested in Verdant Loom').schedule).toBe(false);

    expect(plan('what is happening on 3 September').calendarLift).toBeGreaterThan(0);
    expect(plan('who invested in Verdant Loom').calendarLift).toBe(0);
  });
});

describe('the classifier is deterministic and explains itself', () => {
  test('the same text always classifies the same way', () => {
    const first = classifyIntent('where does Sam work');
    const second = classifyIntent('where does Sam work');
    expect(second).toEqual(first);
  });

  test('classification is normalized, so typography does not change the route', () => {
    expect(classifyIntent('Sam’s current title').intent).toBe(
      classifyIntent("Sam's current title").intent,
    );
  });

  test('a classification names the cues that fired', () => {
    // Attribution is what makes a misroute debuggable without a model.
    expect(classifyIntent('who invested in Verdant Loom').signals.length).toBeGreaterThan(0);
  });
});
