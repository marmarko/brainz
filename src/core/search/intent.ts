/**
 * Stage 2 — intent classification, with no model call and no network.
 *
 * **The classifier is a ranking input, not only a router.** That distinction is
 * the ledger row's whole content: routing the graph arm on "who invested in X"
 * is the obvious half, and the half that actually separates "who is Bob" from
 * "what did I say last week" is that the same classification also sets the
 * fusion weights, the RRF k, the exact-match boost and the recency tilt. A
 * classifier that returned a perfect label and one constant plan would look
 * correct in every unit test of the label and change no ranking at all.
 *
 * **Zero-LLM is KTD4's constraint, and it is also what makes this testable.**
 * The read path admits bounded scoring over a fixed candidate set (the U12
 * cross-encoder) and no unbounded generative call. Intent runs before there is a
 * candidate set at all, so it gets neither — it is string work, exhaustively
 * enumerable, and deterministic by construction. Every cue below is matched
 * against the *normalized* query, so a curly apostrophe cannot route a question
 * differently from a typed one.
 *
 * **Why five intents and not more.** Each one exists because it moves a knob a
 * different direction:
 *
 *   - `entity_lookup` — "who is Sam". The graph arm and the alias ladder are the
 *     mechanisms; term overlap is nearly useless, because the answer page rarely
 *     repeats the question's words.
 *   - `relational` — "who invested in X", "where does Sam work". The answer is
 *     an *edge*, so the graph arm outweighs the vector arm rather than merely
 *     running.
 *   - `temporal` — "current", "now", "still", "did X change". Recency tilt is
 *     the knob, and it is the only intent that gets a meaningful one: a standing
 *     relational fact is frequently the oldest page in the brain.
 *   - `lexical` — a bare noun phrase, usually a title fragment. The exact-match
 *     boost carries it.
 *   - `exploratory` — the fallback, including the empty query. Least-committed
 *     plan; no graph fan-out, no tilt.
 *
 * **Precedence is explicit and ordered**, because real queries fire several
 * cues: "Sam's current title" is both a name and a time word, and "where is
 * Kettle and Quill based now" is both a relation and a time word. Time wins over
 * relation, and relation wins over lookup — a stale edge answered confidently is
 * the failure mode users report as "it lied to me", while a fresh page reached
 * by the wrong arm is merely a worse rank.
 */

import { normalizeQuery, tokens } from './normalize.ts';

export const INTENTS = [
  'entity_lookup',
  'relational',
  'temporal',
  'lexical',
  'exploratory',
] as const;

export type Intent = (typeof INTENTS)[number];

export interface Classification {
  readonly intent: Intent;
  /** Which cues fired. Attribution is what makes a misroute debuggable. */
  readonly signals: readonly string[];
  /** A calendar-shaped question: "what is happening on 3 September". */
  readonly schedule: boolean;
  /**
   * Edge types the question is asking about, when the cue names one.
   *
   * "Where does Sam work" and "who does Sam work with" both resolve the same
   * seed and fan out over the same neighbourhood; what separates them is
   * `works_at` versus `collaborates_with`. Without this the graph arm ranks the
   * neighbourhood by recency, and the most recently recorded relation wins
   * whatever the question was. Empty when no cue named a relation.
   */
  readonly relations: readonly string[];
}

export interface ArmWeights {
  readonly vector: number;
  readonly fts: number;
  readonly graph: number;
}

export interface RankingPlan {
  readonly intent: Intent;
  readonly armWeights: ArmWeights;
  /**
   * RRF's k. Small k makes the top ranks dominate; large k flattens the
   * contribution curve so agreement across arms matters more than any one arm's
   * ordering. Lookup and relational queries want the sharp end; exploratory ones
   * want the flat one.
   */
  readonly rrfK: number;
  /** Multiplier on the title-phrase boost (stage 6). */
  readonly exactMatchBoost: number;
  /** Multiplier on the recency term (stage 7). Zero means "time is not evidence here". */
  readonly recencyTilt: number;
  /** Whether the graph arm is dispatched at all — it costs a fan-out query. */
  readonly useGraphArm: boolean;
  /** Weight the alias ladder folds in with (stage 5). */
  readonly aliasWeight: number;
  /** Extra source-type prior for calendar pages when the question is a schedule one. */
  readonly calendarLift: number;
  /** Edge types to prefer in the graph arm. See {@link Classification.relations}. */
  readonly relations: readonly string[];
}

// ---------------------------------------------------------------------------
// Cues. Every pattern is matched against normalized text (lowercased, folded).
// ---------------------------------------------------------------------------

/** Time words. Presence of any one of these makes the question about *when*. */
const TEMPORAL_CUES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(now|current|currently|latest|today|tonight)\b/, 'now'],
  [/\bstill\b/, 'still'],
  [/\b(yet|already)\b/, 'yet'],
  [/\b(last|this|next) (week|month|year|quarter)\b/, 'relative-window'],
  [/\bwhen (did|does|is|was|will)\b/, 'when'],
  [/\b(changed?|changes|moved?|updated?)\b/, 'change'],
  [/\b(fixed|resolved|paid|signed|shipped|closed|done|ended)\b/, 'state-change'],
  [/\bhow did .* (go|end)\b/, 'outcome'],
  [/\bhas .* been\b/, 'has-been'],
  [/\bwas .* (paid|signed|fixed|sent)\b/, 'was-done'],
];

/**
 * Relation cues: the question asks for the *other end* of an edge.
 *
 * Deliberately verb-anchored rather than "starts with who". "who is Sam" and
 * "who works at Northwind" both start with `who` and want different arms.
 */
/**
 * Which typed edges a relational cue is asking about.
 *
 * Both directions of each pair, because the schema stores one half of a
 * relationship and the question may be asked from either end: "who invested in
 * X" and "who are X's investors" walk the same row.
 */
const CUE_RELATIONS: Readonly<Record<string, readonly string[]>> = {
  investment: ['invested_in', 'has_investor'],
  'works-at': ['works_at', 'employs'],
  employment: ['works_at', 'employs'],
  founding: ['founded', 'founded_by'],
  advisory: ['advises', 'advised_by'],
  membership: ['part_of', 'has_part'],
  'where-does': ['works_at', 'employs'],
  collaboration: ['collaborates_with'],
};

const RELATIONAL_CUES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(invested|invests|investor|backed|backs|funded|funds)\b/, 'investment'],
  [/\b(works?|working|worked) (at|for|with|on)\b/, 'works-at'],
  [/\b(employs|employed|employer|hires?|hired)\b/, 'employment'],
  [/\b(founded|founder|founders|co-founded)\b/, 'founding'],
  [/\b(advises|advisor|advisers?|advises|advising)\b/, 'advisory'],
  [/\b(part of|belongs to|has part|owned by|owns)\b/, 'membership'],
  [/\bwhere does\b/, 'where-does'],
  [/\bwhich (company|fund|firm|team|project|organisation|organization)\b/, 'which-org'],
  [/\bwho (else|does|works|runs|chairs|sponsored|negotiates|joined|owns)\b/, 'who-verb'],
  [/\b(collaborat|jointly|together with)/, 'collaboration'],
  [/\bassociated with\b/, 'association'],
];

/** Lookup cues: the question asks *about a thing*, by name. */
const LOOKUP_CUES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bwho (is|are|was|were)\b/, 'who-is'],
  [/\bwhat (is|are) (a|an|the)?\s*[a-z0-9]/, 'what-is'],
  [/\bwho (he|she|they) (is|are)\b/, 'who-pronoun'],
  [/\btell me about\b/, 'tell-me-about'],
];

/** Schedule cues: the answer is a calendar entry rather than a document. */
const SCHEDULE_CUES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(happening|scheduled|calendar|agenda|diary)\b/, 'calendar-word'],
  [/\b(appointment|meeting|invite|standup|review cycle)\b/, 'event-word'],
  [/\bdeadline\b/, 'deadline'],
  [
    /\b\d{1,2} (january|february|march|april|may|june|july|august|september|october|november|december)\b/,
    'day-month',
  ],
  [
    /\b(january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2}\b/,
    'month-day',
  ],
  [/\bon (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/, 'weekday'],
];

function fired(
  text: string,
  cues: ReadonlyArray<readonly [RegExp, string]>,
  into: string[],
  prefix: string,
): boolean {
  let any = false;
  for (const [pattern, name] of cues) {
    if (pattern.test(text)) {
      into.push(`${prefix}:${name}`);
      any = true;
    }
  }
  return any;
}

/**
 * Classify. Pure, deterministic, and total — every string gets an intent,
 * including the empty one.
 */
export function classifyIntent(query: string): Classification {
  const text = normalizeQuery(query);
  const signals: string[] = [];

  if (tokens(text).length === 0) {
    return { intent: 'exploratory', signals: ['empty'], schedule: false, relations: [] };
  }

  const schedule = fired(text, SCHEDULE_CUES, signals, 'schedule');
  const temporal = fired(text, TEMPORAL_CUES, signals, 'temporal');
  const relational = fired(text, RELATIONAL_CUES, signals, 'relational');
  const lookup = fired(text, LOOKUP_CUES, signals, 'lookup');

  const relations: string[] = [];
  for (const signal of signals) {
    if (!signal.startsWith('relational:')) continue;
    for (const edgeType of CUE_RELATIONS[signal.slice('relational:'.length)] ?? []) {
      if (!relations.includes(edgeType)) relations.push(edgeType);
    }
  }

  // Ordered, and the order is the decision. See the header.
  if (temporal) return { intent: 'temporal', signals, schedule, relations };
  if (relational) return { intent: 'relational', signals, schedule, relations };
  if (lookup) return { intent: 'entity_lookup', signals, schedule, relations };

  // No cue fired. A short phrase is a title fragment being looked up; a long
  // sentence with no cue is an open question with nothing to route on.
  const wordCount = tokens(text).length;
  if (wordCount <= 8) {
    signals.push('lexical:bare-phrase');
    return { intent: 'lexical', signals, schedule, relations };
  }
  signals.push('exploratory:no-cue');
  return { intent: 'exploratory', signals, schedule, relations };
}

/**
 * The knobs each intent sets.
 *
 * **On the recency tilt specifically.** Only `relational` gets zero, and that is
 * the load-bearing zero: a standing relational fact ("who founded X") is
 * frequently the oldest page in the brain, so any tilt at all ranks the newest
 * mention of a founder above the profile that states the founding. Every other
 * intent gets a *mild* tilt, because for a bare noun phrase newer really is a
 * weak prior — two pages titled "Halcyon Grid renewal terms" a year apart differ
 * only in date, and the older one repeats the query's words more often. The tilt
 * is an order of magnitude below the title term, so it breaks ties rather than
 * deciding matches.
 *
 * **These numbers are the unit's tuning surface and they are stated once.** A
 * later stage that wants a different weight asks for a different intent; it does
 * not reach past this table. The floors harness
 * (`test/core/search/floors.test.ts`) is the only arbiter of what the numbers
 * should be — changing one and watching the per-type floors is the intended
 * workflow, and changing one to fix a single query is how a stack becomes
 * fixture-shaped.
 */
const PLANS: Readonly<Record<Intent, Omit<RankingPlan, 'intent' | 'calendarLift' | 'relations'>>> = {
  entity_lookup: {
    // The lexical arms are nearly weightless here on purpose, and it is the same
    // reason the header gives: the page that answers "who is Sam" rarely repeats
    // the question's words, while every page that *mentions* Sam matches the
    // query's one content token. Leaving the arms at parity means the answer is
    // decided by whichever chunk happens to name her most often.
    armWeights: { vector: 0.25, fts: 0.3, graph: 1.6 },
    // Small k: for a lookup, being the alias ladder's *first* answer is a much
    // stronger statement than being its second, and a flat curve erases that.
    // At k=20 the two differ by 5%, which any source-type prior overturns.
    rrfK: 3,
    exactMatchBoost: 1.1,
    recencyTilt: 0.1,
    useGraphArm: true,
    aliasWeight: 3.5,
  },
  relational: {
    armWeights: { vector: 0.7, fts: 1, graph: 1.6 },
    rrfK: 12,
    exactMatchBoost: 0.7,
    recencyTilt: 0,
    useGraphArm: true,
    aliasWeight: 1.5,
  },
  temporal: {
    armWeights: { vector: 0.9, fts: 1.2, graph: 0.9 },
    rrfK: 12,
    exactMatchBoost: 0.9,
    recencyTilt: 0.3,
    useGraphArm: true,
    aliasWeight: 1.7,
  },
  lexical: {
    armWeights: { vector: 1, fts: 1.3, graph: 0 },
    rrfK: 12,
    exactMatchBoost: 1.6,
    recencyTilt: 0.12,
    useGraphArm: false,
    aliasWeight: 1.4,
  },
  exploratory: {
    armWeights: { vector: 1, fts: 1, graph: 0 },
    rrfK: 60,
    exactMatchBoost: 0.5,
    recencyTilt: 0.1,
    useGraphArm: false,
    aliasWeight: 1,
  },
};

/** How much a schedule-shaped question lifts calendar pages (stage 8's prior). */
export const CALENDAR_LIFT = 0.35;

export function planFor(classification: Classification): RankingPlan {
  const base = PLANS[classification.intent];
  return {
    intent: classification.intent,
    ...base,
    calendarLift: classification.schedule ? CALENDAR_LIFT : 0,
    relations: classification.relations,
  };
}

/**
 * Refine a plan once entity resolution has run.
 *
 * **A query that names two entities is a relational question, whatever its
 * grammar.** "S. Okonkwo Verdant Loom" has no verb at all, so the cue table
 * classifies it as a bare noun phrase and never dispatches the graph arm — and
 * the answer is the chunk that states the employment relation between exactly
 * those two entities. The signal is available and zero-LLM: it is the *number of
 * entities the ladder resolved*, which the pipeline knows before it calls the
 * arms.
 *
 * A refinement rather than a re-classification: the intent keeps its label and
 * its knobs, and only the graph arm is switched on, with the relational weight.
 * Re-labelling would also change the recency tilt and the exact-match boost,
 * neither of which the entity count says anything about.
 */
export function refinePlan(
  plan: RankingPlan,
  resolved: { readonly entityCount: number },
): RankingPlan {
  if (plan.useGraphArm || resolved.entityCount < 2) return plan;
  return {
    ...plan,
    useGraphArm: true,
    armWeights: { ...plan.armWeights, graph: PLANS.relational.armWeights.graph },
  };
}

/** Classify and plan in one step, which is how the pipeline uses it. */
export function planForQuery(query: string): { classification: Classification; plan: RankingPlan } {
  const classification = classifyIntent(query);
  return { classification, plan: planFor(classification) };
}
