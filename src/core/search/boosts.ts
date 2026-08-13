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

import { longestPhraseRun, normalizeQuery, phraseOverlap, tokens } from './normalize.ts';
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

/** What a chunk evidencing a resolved entity gains. */
export const GRAPH_ADJACENCY_BOOST = 0.2;

/** Extra credit when the title contains the whole query phrase, in order. */
export const TITLE_FULL_PHRASE_BONUS = 0.5;

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
 * **English only, and that is a stated limitation.** KTD9 makes the FTS
 * configuration a per-tenant provision-time decision, so a Spanish brain wants a
 * Spanish list here; the alpha is English and this list is small enough to be
 * obviously incomplete rather than quietly wrong. It affects a ranking boost and
 * never a fence or a filter, so the failure mode of a missing language is a
 * slightly worse ordering, not a wrong answer.
 */
export const PHRASE_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'did', 'do',
  'does', 'for', 'from', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'in',
  'is', 'it', 'its', 'me', 'my', 'not', 'of', 'on', 'or', 'our', 's', 'she',
  'that', 'the', 'their', 'them', 'they', 'this', 'to', 'was', 'we', 'were',
  'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'will', 'with', 'you',
  'your',
]);

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
   * R12a's gate, for U11's compiled-truth boost: externally-sourced claims are
   * excluded until corroborated. Computed here rather than in U11 so that one
   * reading of the rule exists.
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
  let hasExternal = false;

  for (const attestation of attestations) {
    switch (attestation.channel) {
      case 'agent_mcp':
        restated = true;
        continue;
      case 'external':
        hasExternal = true;
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
    eligibleForCompiledTruth: corroborated || !hasExternal,
  };
}

// ---------------------------------------------------------------------------
// The envelope.
// ---------------------------------------------------------------------------

export interface BoostOptions {
  readonly corroborationBoost: number;
  readonly graphAdjacencyBoost: number;
}

export interface BoostInputs extends Partial<BoostOptions> {
  readonly fused: ReadonlyMap<string, number>;
  readonly candidates: ReadonlyMap<string, Candidate>;
  readonly query: string;
  readonly plan: RankingPlan;
  /** Injected. Never the wall clock — see the header. */
  readonly now: Date;
  readonly resolvedEntityIds: readonly string[];
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

function titleTerm(candidate: Candidate, query: string, plan: RankingPlan): number {
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

  return plan.exactMatchBoost * (overlap + (complete ? TITLE_FULL_PHRASE_BONUS : 0));
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
  const resolved = new Set(inputs.resolvedEntityIds);

  const scored: ScoredCandidate[] = [];

  for (const [id, candidate] of inputs.candidates) {
    const fused = inputs.fused.get(id) ?? 0;

    const title = titleTerm(candidate, inputs.query, inputs.plan);
    const recency = recencyTerm(candidate, inputs.now, inputs.plan.recencyTilt);
    const sourceType = sourceTypeTerm(candidate, inputs.plan);
    const trust = trustTerm(candidate);
    const verdict = corroborationOf(candidate.attestations);
    const corroboration = verdict.corroborated ? corroborationBoost : 0;
    const graph =
      resolved.size > 0 && candidate.entityIds.some((entityId) => resolved.has(entityId))
        ? graphAdjacencyBoost
        : 0;

    const envelope = Math.max(
      MIN_ENVELOPE,
      1 + title + recency + sourceType + trust + corroboration + graph,
    );

    scored.push({
      candidate,
      fused,
      score: fused * envelope,
      boosts: { title, recency, source_type: sourceType, trust, corroboration, graph },
    });
  }

  return scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.candidate.id < b.candidate.id ? -1 : a.candidate.id > b.candidate.id ? 1 : 0),
  );
}
