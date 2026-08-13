/**
 * The rule-coverage baseline: what fraction of the extraction gold key a
 * deterministic extractor could reach at best.
 *
 * R6's blocking tier requires deterministic-extraction recall ≥ 0.8, and R6a
 * says this floor gets a rule-coverage baseline rather than a retrieval one.
 * This file computes that baseline and, more importantly, states whether the
 * floor is **attainable at all** on this corpus — the deterministic half of the
 * upper-bound question. A ceiling below 0.8 would mean U6's extractor is being
 * asked for something the fixture cannot supply.
 *
 * The check is bidirectional, like every other reference check in this unit:
 * a fact with no rule assignment and a rule assignment for a fact that does not
 * exist are both errors. A missing assignment silently leaving the denominator
 * is the fail-open shape here, and it moves the number in the flattering
 * direction.
 */

import { FACT_RULES, RULE_FAMILIES, type RuleFamily } from './fixtures/extraction.ts';
import type { Corpus } from './corpus.ts';
import { EXTRACTION_FLOOR } from './gates.ts';

export interface RuleCoverage {
  readonly totalFacts: number;
  /** Facts a deterministic rule family could reach. */
  readonly reachable: number;
  /** Facts that need the model phase. */
  readonly modelOnly: number;
  /** `reachable / totalFacts` — the ceiling on deterministic recall. */
  readonly coverage: number;
  readonly byFamily: Readonly<Record<RuleFamily, number>>;
  /** Whether R6's 0.8 floor is reachable at all given that ceiling. */
  readonly floorIsAttainable: boolean;
  readonly floor: number;
}

export function ruleCoverage(corpus: Corpus): RuleCoverage {
  const assigned = new Set(Object.keys(FACT_RULES));
  const familySet = new Set<string>(RULE_FAMILIES);

  for (const factId of corpus.facts.keys()) {
    if (!assigned.has(factId)) {
      throw new Error(
        `fact ${factId} has no extraction rule assignment; an unclassified fact would leave the coverage denominator`,
      );
    }
  }
  for (const factId of assigned) {
    if (!corpus.facts.has(factId)) {
      throw new Error(`extraction rules assign ${factId}, which is not a fact in the corpus`);
    }
  }

  const byFamily = {} as Record<RuleFamily, number>;
  for (const family of RULE_FAMILIES) byFamily[family] = 0;

  let reachable = 0;
  let modelOnly = 0;

  for (const [factId, family] of Object.entries(FACT_RULES)) {
    if (!familySet.has(family)) throw new Error(`fact ${factId} names unknown rule family ${family}`);
    byFamily[family] += 1;
    if (family === 'model_only') modelOnly += 1;
    else reachable += 1;
  }

  const totalFacts = corpus.facts.size;
  if (totalFacts === 0) throw new Error('extraction coverage over a corpus with no facts');

  const coverage = reachable / totalFacts;

  return {
    totalFacts,
    reachable,
    modelOnly,
    coverage,
    byFamily,
    floorIsAttainable: coverage >= EXTRACTION_FLOOR.minimum,
    floor: EXTRACTION_FLOOR.minimum,
  };
}
