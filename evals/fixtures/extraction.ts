/**
 * Which deterministic rule family would extract each fact in the corpus, and
 * which facts no deterministic rule can reach.
 *
 * **This is the deterministic-extraction floor's calibration, and it is a
 * different shape from the ranking floors' on purpose.** R6a: the extraction
 * floor "records a rule-coverage baseline instead, since a retrieval baseline
 * produces no comparable score". A naive ranker can be run against a ranking
 * floor and produce a number; there is no naive *extractor* whose score means
 * anything, because a rule-free extractor extracts nothing. What can be
 * measured instead is the ceiling: of the facts the corpus expects to be
 * extracted, what fraction is even in reach of a rule rather than a model?
 *
 * That number is the thing R6's 0.8 has to be read against. If deterministic
 * rules can reach only 60% of the gold key, a deterministic extractor cannot
 * clear 0.8 no matter how well it is written, and a miss would be a fixture
 * property misread as an implementation failure — the same misreading R6a's
 * upper bound prevents on the retrieval side.
 *
 * **Every fact must be classified.** There is no default and no omission: the
 * loader in `evals/extraction.ts` fails if a fact has no assignment or if an
 * assignment names a fact that does not exist. An unclassified fact would
 * silently leave the denominator, which flatters the coverage number in exactly
 * the direction that makes the floor look attainable when it is not.
 *
 * The rule families are named for what a deterministic extractor would actually
 * pattern-match on, not for the fact's subject matter. They are U6's to
 * implement; naming them here is what lets U6's extractor be graded against a
 * gold key that predates it.
 */

/**
 * The deterministic rule families, plus the one honest escape hatch.
 *
 * `model_only` is not a rule. It is the label for a fact whose extraction needs
 * the model phase, and it counts against coverage rather than being excused
 * from the denominator.
 */
export const RULE_FAMILIES = [
  /** "X founded Y", "X advises Y" — a known relation verb between two named things. */
  'relation_verb_sentence',
  /** "X is <role> of Y", "X is the <role> at Y" — a copula plus a role noun. */
  'role_copula_sentence',
  /** "X is based in Y", "moved to Y" — a copula or motion verb plus a place. */
  'location_sentence',
  /** "the price is N euro", "N euro for the year" — a currency amount in a stated scope. */
  'currency_amount_sentence',
  /** "shipped on 9 April", "signed on 5 June" — an event verb plus an explicit date. */
  'dated_event_sentence',
  /** A defect or advisory stated against a named version string. */
  'versioned_defect_sentence',
  /** Needs the model phase: implicit, inferred, or spread across sentences. */
  'model_only',
] as const;
export type RuleFamily = (typeof RULE_FAMILIES)[number];

/**
 * fact id → the rule family that would extract it.
 *
 * Assignments are made by reading the source chunk and asking "could a pattern
 * match this without understanding it?" — deliberately conservative, because an
 * optimistic assignment inflates the coverage ceiling and makes the 0.8 floor
 * look more attainable than it is.
 */
export const FACT_RULES: Readonly<Record<string, RuleFamily>> = {
  'f-tessellate-invested-verdant': 'model_only',
  'f-tessellate-invested-brackish': 'model_only',
  'f-sam-works-verdant': 'role_copula_sentence',
  'f-tosh-works-verdant': 'role_copula_sentence',
  'f-dana-works-northwind': 'role_copula_sentence',
  'f-trelawney-works-northwind': 'relation_verb_sentence',
  'f-elena-works-halcyon': 'model_only',
  'f-priya-works-tessellate': 'role_copula_sentence',
  'f-marcus-founded-kettle': 'relation_verb_sentence',
  'f-priya-advises-kettle': 'relation_verb_sentence',
  'f-sam-collab-dana': 'model_only',
  'f-saltmarsh-part-of-verdant': 'relation_verb_sentence',
  'f-windbreak-part-of-northwind': 'model_only',
  'f-sam-title-old': 'role_copula_sentence',
  'f-sam-title-current': 'role_copula_sentence',
  'f-kettle-base-old': 'location_sentence',
  'f-kettle-base-current': 'location_sentence',
  'f-halcyon-price-old': 'currency_amount_sentence',
  'f-halcyon-price-current': 'currency_amount_sentence',
  'f-saltmarsh-ship-old': 'dated_event_sentence',
  'f-saltmarsh-ship-actual': 'dated_event_sentence',
  'f-firmware-advisory': 'versioned_defect_sentence',
  'f-firmware-fixed': 'versioned_defect_sentence',
  'f-series-a-amount-memo': 'currency_amount_sentence',
  'f-series-a-amount-recap': 'currency_amount_sentence',
};
