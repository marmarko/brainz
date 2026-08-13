/**
 * Stages 6–9 — every ranking signal that is not recall.
 *
 * **One multiplicative envelope over the fused base:**
 *
 *     score = fused × (1 + Σ terms)
 *
 * Multiplicative rather than additive, for a reason that matters at the edges: a
 * boost is a statement about *how much better* a candidate is than its peers,
 * not a fixed number of points. An additive boost large enough to matter at the
 * bottom of the pool would swamp the fusion at the top, and one small enough not
 * to would do nothing where it is needed. The envelope is floored at
 * {@link MIN_ENVELOPE} so no combination of negative priors can invert an
 * ordering by taking a score through zero.
 *
 * **A candidate with a fused base of zero stays at zero, deliberately.** That is
 * what makes the alias ladder's *injection* (`rrf.ts:foldRanked`) load-bearing:
 * a boost cannot rescue a row nothing recalled, so the ladder has to put it into
 * the fusion rather than multiply it afterwards.
 *
 * **`now` is a parameter, never `Date.now()`.** The half-lives below differ by
 * source type, so a wall-clock anchor changes *cross-class* ordering as real
 * time passes: a ranking that satisfies the floors today would drift out of them
 * in six months with no code change and no failing test in between. That is the
 * exact silent-drift shape this stack exists to eliminate, so the clock is
 * injected and the eval anchors it to the corpus.
 *
 * **KTD5 governs what may be read here.** Source type, trust level and subject
 * inference are *ranking* inputs. None of them is consulted for access — that
 * happened in `fence.ts`, on `origin_context` alone, before any of this ran.
 */

import {
  longestPhraseRun,
  normalizeQuery,
  phraseOverlap,
  tokens,
  PHRASE_STOPWORDS,
} from './normalize.ts';
import type { Attestation, Candidate, RankingPlan, ScoredCandidate, SourceType } from './types.ts';

/** The envelope's floor. Priors adjust a ranking; they never annihilate a row. */
export const MIN_ENVELOPE = 0.05;

/**
 * Half-lives in days, per source type — the "per-prefix recency decay" the plan
 * names, keyed on the axis brainz actually has.
 *
 * gbrain keys this on slug prefix (`meetings/`, `notes/`) because its pages are
 * addressed by path. brainz has no such path: the equivalent statement about how
 * fast a surface churns is its `source_type`. Chat is the fastest-moving surface
 * a brain ingests and the least likely to be the durable record of anything;
 * documents, notes and files are the slowest.
 */
export const RECENCY_HALF_LIFE_DAYS: Readonly<Record<SourceType, number>> = {
  chat: 14,
  email: 21,
  calendar: 21,
  web: 30,
  transcript: 30,
  note: 60,
  file: 60,
  document: 60,
};

/**
 * Source-type priors. Small, bounded, and stated as one table.
 *
 * These encode one claim: a document the user keeps is more likely to be the
 * answer than a line of chat, at equal term match. They are deliberately an
 * order of magnitude smaller than the title and alias terms — a prior that can
 * outvote evidence is not a prior, it is a rule.
 */
export const SOURCE_TYPE_PRIOR: Readonly<Record<SourceType, number>> = {
  document: 0.06,
  note: 0.06,
  file: 0.05,
  email: 0.02,
  transcript: 0.0,
  web: 0.0,
  calendar: 0.0,
  chat: -0.1,
};

/** Trust priors, by the strongest attestation a row carries (KTD5: ranking only). */
export const TRUST_PRIOR: Readonly<Record<Attestation['channel'], number>> = {
  user_out_of_band: 0.08,
  internal: 0.06,
  user_curated: 0.03,
  agent_mcp: 0,
  external: 0,
};

/** What a corroborated row gains. See {@link corroborationOf} for what earns it. */
export const CORROBORATION_BOOST = 0.12;

/**
 * What a chunk that restates the question instead of answering it loses.
 *
 * **Telling a question from an answer is a ranking problem a conversational
 * brain cannot avoid**, and it is the one signal in this table that is about the
 * *shape* of a chunk rather than about its provenance or its age. A brain fed
 * from chat and mail is full of rows that mirror a query's wording exactly and
 * assert nothing — "did the renewal price change? has the renewal price changed
 * at all?" is the single densest lexical match for "renewal price" in a corpus
 * that also contains the renewal terms. Every arm ranks on term overlap, so
 * every arm ranks it first; no amount of fusion fixes that, because all three
 * arms are wrong in the same direction.
 *
 * Deliberately larger than the source-type priors and deliberately smaller than
 * the title term: a surface prior is a weak claim about where a row came from,
 * while "this row is the question typed back" is a strong claim about the row —
 * and still not strong enough to outvote a page whose title is the phrase asked
 * for.
 */
export const RESTATEMENT_PENALTY = 0.25;

/**
 * What a chunk adjacent to a resolved entity gains — evidenced or merely named.
 *
 * **One number for both, and it was measured rather than assumed.** Paying a
 * bare mention less than a fact's source chunk is the obvious refinement: the
 * alias ladder scores a mention as its most speculative rung, so the boost
 * "should" agree. Splitting the term was implemented and graded across the whole
 * corpus at three ratios; at the ladder's own ratio it moved the aggregate by
 * 0.0001 and no floor at all, and at a sharper one it cost an alias probe. A
 * knob that does not move a measurement is a knob that will be tuned by
 * somebody later without one, so it is not here. `Candidate.evidenceEntityIds`
 * carries the distinction for the stage that finds a use for it.
 */
export const GRAPH_ADJACENCY_BOOST = 0.2;

/** Extra credit when the title contains the whole query phrase, in order. */
export const TITLE_FULL_PHRASE_BONUS = 0.5;

/**
 * Why a **partial** title run made only of a resolved name earns nothing.
 *
 * **This is a double-count, not a preference.** When the alias ladder resolves
 * `MV` to Marcus Vandenberg, that one query token is already paid three times
 * over: both lexical arms recall every row containing it, the ladder's mention
 * rung injects every page naming him, and {@link GRAPH_ADJACENCY_BOOST} lifts
 * every chunk adjacent to him. The title-phrase boost is the fourth payment,
 * and it is the one that decides — a load-test rig whose document is titled
 * "MV load test results" takes a 53% envelope lift for sharing one token with
 * "MV roast contract", and outranks the row that states what Marcus actually
 * does with the roast contract. The stage's own header says a boost that fires
 * on unordered word overlap is "a second keyword arm under another name"; a
 * one-token run is unordered by definition, and when that token is a name the
 * ladder has already spent, the stage is a second *alias* arm.
 *
 * **Confined to partial runs, and that confinement is the whole rule.** A title
 * that *is* the asked phrase is the user naming a document, whatever the phrase
 * is made of — "Marcus Vandenberg" asked of the page titled *Marcus
 * Vandenberg*, or "Dana Ilves who she is" asked of the note titled that. Those
 * reach `complete` and are untouched. What is refused is the fragment: a run
 * that covers part of the query, and covers it with nothing but the name.
 *
 * **Exactly parallel to {@link PHRASE_STOPWORDS}**, one line above it in
 * {@link titleTerm}: a run of pure grammar carries no subject, and a run of
 * pure name carries no *document*. Both say the title matched on something that
 * cannot distinguish which page was meant.
 */
export const RESOLVED_NAME_RUN = 'partial title runs made only of a resolved name earn no title credit';

/**
 * Function words a matched run may not consist *entirely* of.
 *
 * Without this the title boost fires on grammar: "who is Sam" against a page
 * titled "Dana Ilves who she is" shares the single token `who`, scores a third
 * of the query, and promotes the wrong person's profile above the right one's.
 *
 * A minimum run *length* was the first attempt and it is the wrong rule — it
 * also refuses "Invoice 2026-114" and "Pilot outcome", which are two-token
 * titles that a query legitimately matches in part. What distinguishes the bad
 * case is not the run's length but that it carries no content.
 *
 * Re-exported rather than defined here: the alias ladder's mention rung needs
 * the same list for the same reason, and the list lives with the rest of the
 * shared read-side vocabulary in `normalize.ts` so it cannot exist twice.
 */
export { PHRASE_STOPWORDS };

// ---------------------------------------------------------------------------
// R12a — corroboration.
// ---------------------------------------------------------------------------

export interface CorroborationVerdict {
  /**
   * Distinct origins, after collapse. External attestations collapse by sender,
   * so a mail message and the calendar event derived from it count once.
   *
   * **This number never feeds the boost.** It is metadata — for the review queue
   * and for U11 — and it is exposed precisely so the collapse rule is observable
   * without making a forgeable quantity into a ranking input.
   */
  readonly independentOrigins: number;
  /** True iff some origin exists that the external sender cannot also write. */
  readonly corroborated: boolean;
  /** True iff a `remember` arrived over MCP. Clears nothing (R12a). */
  readonly restated: boolean;
  /**
   * R12a's gate, for U11's compiled-truth boost.
   *
   * **It is `corroborated`, and asking anything else is a forgery.** The obvious
   * reading — "externally-sourced claims are excluded until corroborated", so
   * admit anything that is not externally sourced — was implemented and is
   * wrong, because *whether a row looks externally sourced is a property the
   * sender influences*. `CHANNEL_BY_SOURCE_TYPE` derives the channel from
   * `source_type`, so an outsider whose content arrives as a shared drive
   * document or a mail attachment produces `user_curated`, which carries no
   * `external` attestation and cleared the gate with nobody having attested to
   * anything. Two more rows cleared it the same way: an `agent_mcp` restatement,
   * which R12a says clears nothing, and a row with no attestations at all.
   *
   * So the gate asks the question that has an answer an outsider cannot write:
   * did an origin the external sender cannot produce vouch for this. That is
   * exactly {@link CorroborationVerdict.corroborated}, and the two fields are
   * the same value on purpose rather than by accident — `test/core/search/
   * corroboration.test.ts` pins each forgery separately so a future widening
   * has to defeat a named attack rather than a tautology.
   */
  readonly eligibleForCompiledTruth: boolean;
}

/**
 * Score a row's attestations against R12a.
 *
 * **Only `user_out_of_band` and `internal` corroborate.** Not "two connected
 * accounts agree", at any count: every alpha source is writable by an
 * unauthenticated outsider and `From:` is free, so a boost keyed on distinct
 * external senders would be a ranking primitive an emailer controls. The
 * requirement enumerates exactly two corroborating kinds and this function
 * implements exactly those two.
 *
 * **`agent_mcp` is excluded from the origin count as well as from the gate.** A
 * restatement over MCP is the same assistant that read the attacker's mail
 * repeating what it read; counting it as an origin would let a crafted message
 * inflate its own claim's independence.
 */
export function corroborationOf(attestations: readonly Attestation[]): CorroborationVerdict {
  const keys = new Set<string>();
  let corroborated = false;
  let restated = false;

  for (const attestation of attestations) {
    switch (attestation.channel) {
      case 'agent_mcp':
        restated = true;
        continue;
      case 'external':
        keys.add(attestation.senderKey ?? 'external:unattributed');
        break;
      case 'user_out_of_band':
        corroborated = true;
        keys.add('user_out_of_band');
        break;
      case 'internal':
        corroborated = true;
        keys.add('internal');
        break;
      case 'user_curated':
        keys.add('user_curated');
        break;
    }
  }

  return {
    independentOrigins: keys.size,
    corroborated,
    restated,
    eligibleForCompiledTruth: corroborated,
  };
}

// ---------------------------------------------------------------------------
// The envelope.
// ---------------------------------------------------------------------------

export interface BoostOptions {
  readonly corroborationBoost: number;
  readonly graphAdjacencyBoost: number;
  /** See {@link RESTATEMENT_PENALTY}. Zero turns the term off, for the mutation. */
  readonly restatementPenalty: number;
}

export interface BoostInputs extends Partial<BoostOptions> {
  readonly fused: ReadonlyMap<string, number>;
  readonly candidates: ReadonlyMap<string, Candidate>;
  readonly query: string;
  readonly plan: RankingPlan;
  /** Injected. Never the wall clock — see the header. */
  readonly now: Date;
  readonly resolvedEntityIds: readonly string[];
  /**
   * The names and aliases **in the query** that caused an entity to resolve.
   *
   * Not the canonical names: what {@link titleTerm} has to recognise is the
   * text the user typed, because that is what a title run is made of. `MV` and
   * `Marcus Vandenberg` resolve the same entity and only one of them appears in
   * `MV roast contract`. Absent or empty means "resolution found nothing", which
   * leaves the guard inert — the fail-open direction is the pre-existing
   * behaviour, and a caller that cannot supply this is a caller whose ladder
   * resolved nothing to double-count.
   */
  readonly resolvedNames?: readonly string[];
  readonly aliasLadder: readonly string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Exponential decay with a per-source-type half-life, returned as a value in
 * (0, 1] that the tilt scales.
 *
 * A *tilt*, not a penalty: recent content gains up to `recencyTilt`, old content
 * gains nothing. Expressing it as a penalty would mean every non-temporal query
 * quietly demotes everything old, which is how a brain forgets that the founding
 * of a company happened in 2019.
 */
function recencyTerm(candidate: Candidate, now: Date, tilt: number): number {
  if (tilt === 0) return 0;
  const at = Date.parse(candidate.createdAt);
  // An unparseable date contributes no tilt rather than a wrong one: `NaN` here
  // would propagate into the score and sort unpredictably.
  if (!Number.isFinite(at)) return 0;
  const ageDays = Math.max(0, (now.getTime() - at) / DAY_MS);
  const halfLife = RECENCY_HALF_LIFE_DAYS[candidate.sourceType] ?? 30;
  return tilt * Math.pow(0.5, ageDays / halfLife);
}

function titleTerm(
  candidate: Candidate,
  query: string,
  plan: RankingPlan,
  resolvedNameTokens: ReadonlySet<string>,
): number {
  if (plan.exactMatchBoost === 0) return 0;
  const title = candidate.title;
  if (title === null || title.trim().length === 0) return 0;

  const run = longestPhraseRun(title, query);
  if (run.length === 0) return 0;
  // See PHRASE_STOPWORDS: a run of pure grammar is not a phrase match.
  if (!run.some((token) => !PHRASE_STOPWORDS.has(token))) return 0;
  const overlap = phraseOverlap(title, query);

  // Full ordered containment is a materially stronger statement than a partial
  // run, so it earns a step rather than the next increment of a linear ramp.
  const titleTokens = tokens(title);
  const queryTokens = tokens(query);
  const complete =
    overlap === 1 ||
    (titleTokens.length > 0 &&
      queryTokens.length > 0 &&
      normalizeQuery(title) === normalizeQuery(query));

  // **A run of pure name is not a title match either**, and the reason is the
  // same shape as the stopword rule above: the run carries nothing that says
  // *which document*. See {@link RESOLVED_NAME_RUN} for why this is a
  // double-count rather than a tuning preference, and why it is confined to
  // partial runs.
  if (
    !complete &&
    resolvedNameTokens.size > 0 &&
    run.every((token) => resolvedNameTokens.has(token))
  ) {
    return 0;
  }

  return plan.exactMatchBoost * (overlap + (complete ? TITLE_FULL_PHRASE_BONUS : 0));
}

/**
 * Sentences, for the interrogative half of {@link restatementTerm}.
 *
 * Terminator-based and nothing cleverer. A sentence splitter that handles
 * abbreviations and quotations is a language-specific dependency on a path that
 * takes whatever arrives; over-splitting "e.g." costs a fraction of a ranking
 * prior, which is the direction to be wrong in.
 */
function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * How much this chunk looks like the question rather than its answer, in [0, 1].
 *
 * **Two detectors, because the failure arrives in two shapes and neither catches
 * the other.**
 *
 *   1. **Interrogative.** Half or more of the chunk's sentences are questions.
 *      "where does toshiro abe work now? toshiro abe works where these days?" is
 *      not an answer about Toshiro Abe under any reading.
 *   2. **Echo.** The chunk repeats the query's *own* content words far more often
 *      than it says anything else — three occurrences per distinct matched word,
 *      filling a third of the chunk. That is the shape of a backlog item ("ask
 *      X about the renewal price, X has the renewal price somewhere"), which
 *      carries no question mark at all and which every arm ranks first precisely
 *      because the repetition is what term overlap measures.
 *
 * **This is a ranking prior and only a ranking prior** (KTD5). It never fences,
 * never filters, and cannot remove a row: a chunk that genuinely answers by
 * asking — a quoted question in a meeting note — loses a quarter of an envelope
 * and stays in the result set.
 */
function restatementTerm(candidate: Candidate, query: string, penalty: number): number {
  if (penalty === 0) return 0;

  const sentences = sentencesOf(candidate.content);
  if (sentences.length > 0) {
    const questions = sentences.filter((sentence) => sentence.endsWith('?')).length;
    if (questions * 2 >= sentences.length) return -penalty;
  }

  const asked = new Set(
    tokens(query).filter((token) => !PHRASE_STOPWORDS.has(token)),
  );
  if (asked.size === 0) return 0;

  const body = tokens(candidate.content);
  if (body.length === 0) return 0;

  const matchedDistinct = new Set<string>();
  let occurrences = 0;
  for (const token of body) {
    if (!asked.has(token)) continue;
    matchedDistinct.add(token);
    occurrences += 1;
  }
  if (matchedDistinct.size === 0) return 0;

  const perDistinct = occurrences / matchedDistinct.size;
  const share = occurrences / body.length;
  return perDistinct >= 3 && share >= 1 / 3 ? -penalty : 0;
}

function sourceTypeTerm(candidate: Candidate, plan: RankingPlan): number {
  const base = SOURCE_TYPE_PRIOR[candidate.sourceType] ?? 0;
  const lift = candidate.sourceType === 'calendar' ? plan.calendarLift : 0;
  return base + lift;
}

function trustTerm(candidate: Candidate): number {
  let best = 0;
  for (const attestation of candidate.attestations) {
    best = Math.max(best, TRUST_PRIOR[attestation.channel] ?? 0);
  }
  return best;
}

/**
 * Apply every term and return a total order.
 *
 * The per-term attribution rides along on each result. That is not a debugging
 * nicety — it is what lets a floors regression be localised to one stage without
 * bisecting the tuning table, and what lets `boosts.test.ts` assert that a term
 * is *inert* rather than merely outvoted.
 */
export function applyBoosts(inputs: BoostInputs): ScoredCandidate[] {
  const corroborationBoost = inputs.corroborationBoost ?? CORROBORATION_BOOST;
  const graphAdjacencyBoost = inputs.graphAdjacencyBoost ?? GRAPH_ADJACENCY_BOOST;
  const restatementPenalty = inputs.restatementPenalty ?? RESTATEMENT_PENALTY;
  const resolved = new Set(inputs.resolvedEntityIds);
  const resolvedNameTokens = new Set<string>();
  for (const name of inputs.resolvedNames ?? []) {
    for (const token of tokens(name)) resolvedNameTokens.add(token);
  }

  const scored: ScoredCandidate[] = [];

  for (const [id, candidate] of inputs.candidates) {
    const fused = inputs.fused.get(id) ?? 0;

    const title = titleTerm(candidate, inputs.query, inputs.plan, resolvedNameTokens);
    const recency = recencyTerm(candidate, inputs.now, inputs.plan.recencyTilt);
    const sourceType = sourceTypeTerm(candidate, inputs.plan);
    const trust = trustTerm(candidate);
    const verdict = corroborationOf(candidate.attestations);
    const corroboration = verdict.corroborated ? corroborationBoost : 0;
    const graph =
      resolved.size > 0 && candidate.entityIds.some((entityId) => resolved.has(entityId))
        ? graphAdjacencyBoost
        : 0;
    const restatement = restatementTerm(candidate, inputs.query, restatementPenalty);

    const envelope = Math.max(
      MIN_ENVELOPE,
      1 + title + recency + sourceType + trust + corroboration + graph + restatement,
    );

    scored.push({
      candidate,
      fused,
      score: fused * envelope,
      boosts: {
        title,
        recency,
        source_type: sourceType,
        trust,
        corroboration,
        graph,
        restatement,
      },
    });
  }

  return scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0),
  );
}
