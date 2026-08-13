/**
 * The vocabulary every retrieval stage shares.
 *
 * **This file exists so that the accuracy stack is one implementation and not
 * two.** The stack runs over two substrates: a tenant Postgres database (the
 * production read path) and U7's in-memory fixture corpus (the blocking eval).
 * If each substrate carried its own notion of "a candidate", the stack that CI
 * grades and the stack the fleet runs would be different code that happened to
 * agree, and the floors would be measuring the eval adapter.
 *
 * So the split is: **the arms differ per substrate, everything after them does
 * not.** An arm produces a ranked list of ids plus a {@link Candidate} for each;
 * the ordered stages that follow — fusion, alias ladder, boosts, dedup, packing,
 * rerank, autocut — are pure functions of those records and a
 * {@link RankingPlan}. That is also what makes the eval possible at all: U7's
 * `Ranker` interface is *synchronous*, so the post-retrieval stack must be
 * synchronous, and only the arms may await.
 */

import type { Intent, RankingPlan } from './intent.ts';
import type { LadderTier } from './alias-hop.ts';

export type { Intent, RankingPlan, LadderTier };

/** `page_source_type_is_known`, copied from the DDL rather than paraphrased. */
export const SOURCE_TYPES = [
  'email',
  'chat',
  'document',
  'web',
  'note',
  'calendar',
  'transcript',
  'file',
] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * How a row's content got into the brain — the axis R12a's corroboration rule
 * turns on, and deliberately *not* the same axis as `source_type`.
 *
 *   - `external` — an outside party put it there. Mail, calendar invites, chat
 *     messages, web captures. R12a's whole point: the sender who wrote one of
 *     these can write the others too.
 *   - `user_curated` — a document, note or file in the user's own store. Better
 *     than external, and still not an attestation: a shared drive file is
 *     writable by whoever shared it.
 *   - `user_out_of_band` — the user said so, through the web app or panel
 *     (U12/U14/U15). This is what corroborates, because the connected agent
 *     cannot issue it.
 *   - `agent_mcp` — a `remember` that arrived over `/mcp`. Marks a claim
 *     *restated* and clears nothing: the assistant holding `remember` is the
 *     same assistant reading the attacker's mail.
 *   - `internal` — derived by the brain from non-external inputs.
 */
export const ATTESTATION_CHANNELS = [
  'external',
  'user_curated',
  'user_out_of_band',
  'agent_mcp',
  'internal',
] as const;

export type AttestationChannel = (typeof ATTESTATION_CHANNELS)[number];

export interface Attestation {
  readonly channel: AttestationChannel;
  /**
   * Who wrote it, for `external` attestations.
   *
   * R12a: a mail message and the calendar event auto-derived from it are **one**
   * origin, because the same sender produced both. A derived row therefore
   * carries its *root's* sender key, not its own surface's — which is what makes
   * the collapse observable rather than aspirational.
   */
  readonly senderKey?: string;
}

/**
 * One retrievable unit, as every stage after the arms sees it.
 *
 * Chunk-shaped, because the chunk is what both the vector and the full-text arm
 * return and what a citation points at. Page-level facts (`title`, `sourceType`,
 * `createdAt`) are denormalized onto it because four separate stages read them
 * and a join per stage would be four joins per query.
 */
export interface Candidate {
  /** Chunk id. Stable across arms — RRF fuses on it. */
  readonly id: string;
  readonly pageId: string;
  readonly ordinal: number;
  readonly title: string | null;
  readonly content: string;
  /** R15's immutable half. The fence evaluates this and only this. */
  readonly origin: string;
  /** R15's mutable half: inferred, confidence-scored, ranking-only (KTD5). */
  readonly subject?: { readonly context: string; readonly confidence: number };
  readonly sourceType: SourceType;
  /** ISO date or timestamp. The recency stage parses it; a bad value decays to zero tilt. */
  readonly createdAt: string;
  /** False when soft-deleted (R12) or quarantined (U9). Never returned. */
  readonly live: boolean;
  /** Everything that vouches for this row. See {@link Attestation}. */
  readonly attestations: readonly Attestation[];
  /**
   * Entities this row is adjacent to — evidenced *or* merely named.
   *
   * Both, because a chunk that names an entity without evidencing any extracted
   * fact about it is often the answer, and a fact-sources-only derivation cannot
   * see it. Which of the two a given id is comes from {@link evidenceEntityIds}.
   */
  readonly entityIds: readonly string[];
  /**
   * The subset of {@link entityIds} this row is the **source of a fact** about.
   *
   * The distinction is a ranking one and it matters: naming an entity is the
   * weakest statement in the whole stack — the alias ladder scores it as its most
   * speculative rung — while being the evidence a fact was extracted from is the
   * strongest. Paying both the same adjacency boost hands a chat channel that
   * asks about a project the same lift as the status document that reports on it,
   * and does it silently, because the boost's attribution shows the same number
   * for both. Absent means "the substrate did not distinguish", which is treated
   * as evidence-grade rather than as mention-grade only when it is empty and
   * `entityIds` is not — see `boosts.ts:applyBoosts`.
   */
  readonly evidenceEntityIds?: readonly string[];
}

/** One arm's output: its name, its weight's key, and its ranking. */
export interface ArmResult {
  readonly arm: ArmName;
  /** Best first. Ids only; the candidate records travel separately. */
  readonly ranked: readonly string[];
}

export const ARM_NAMES = ['vector', 'fts', 'graph'] as const;
export type ArmName = (typeof ARM_NAMES)[number];

/**
 * Why a read came back partial.
 *
 * Assumption 5's contract, as a value: the query embedding is the read path's
 * only external dependency before U12, and a provider 429 must not read to the
 * user as "the brain is down". The vector arm drops out, RRF fuses what is left,
 * and this field says so through U6's envelope.
 */
export const DEGRADATIONS = ['embedding_unavailable'] as const;
export type Degradation = (typeof DEGRADATIONS)[number];

/** What the arms hand the post-retrieval stack. Substrate-independent by design. */
export interface RecallOutcome {
  /**
   * The plan the arms **actually ran under**, and it is required.
   *
   * `composeRanking` used to take the plan as an optional request field and
   * recompute one from the query text when it was absent. That recomputed plan
   * is the *unrefined* one: it has not seen how many entities the ladder
   * resolved, so it can carry different arm weights, a different alias weight
   * and a different intent from the plan that chose which arms to dispatch. A
   * caller that omitted the field therefore got its recall decided by one plan
   * and its ranking scored by another — no error, no warning, a plausible result
   * list, and a measurably different one. Carrying the plan on the outcome makes
   * the two the same object by construction; `ComposeRequest.plan` remains, as
   * an explicit override for a caller that means it.
   */
  readonly plan: RankingPlan;
  readonly arms: readonly ArmResult[];
  /**
   * Every candidate any arm **or the alias ladder** returned, keyed by id and
   * already fenced.
   *
   * The ladder's half is not optional: it injects candidates no arm recalled, so
   * a substrate that hydrated only the arms' ids would drop exactly the rows the
   * ladder exists to find.
   */
  readonly candidates: ReadonlyMap<string, Candidate>;
  /** The alias ladder's weighted tiers (stage 5). May be empty. */
  readonly aliasLadder: readonly LadderTier[];
  /** Entities the query resolved to, for the graph-adjacency boost. */
  readonly resolvedEntityIds: readonly string[];
  /**
   * The names and aliases **as they appear in the query** that resolved those
   * entities — `MV`, not `Marcus Vandenberg`.
   *
   * Stage 6 needs the typed text rather than the canonical name, because a
   * title run is made of what the user typed. See `boosts.ts:RESOLVED_NAME_RUN`.
   * Optional so a substrate that resolved nothing need not say so twice; absent
   * leaves the guard inert, which is the behaviour that predates it.
   */
  readonly resolvedNames?: readonly string[];
  /** Empty on a complete read. */
  readonly degraded: readonly Degradation[];
}

/** A scored candidate, carried through the ordered stages. */
export interface ScoredCandidate {
  readonly candidate: Candidate;
  /** Weighted-RRF base, before boosts. Zero for an injected candidate. */
  readonly fused: number;
  /** Final score: `fused * (1 + Σ boosts)`. */
  readonly score: number;
  /** Per-term attribution, so a rank can be explained without a debugger. */
  readonly boosts: Readonly<Record<string, number>>;
  /**
   * The cross-encoder's score, or `undefined` when rerank is off.
   *
   * **Autocut reads this and nothing else** (KTD4, and the audit's finding that
   * cutting on the RRF gap cuts on noise). `undefined` is not "zero" and is not
   * "no signal to worry about" — it is the state in which autocut must not run.
   */
  readonly rerankScore?: number;
}

/** What the pipeline returns. U6's envelope wraps this. */
export interface SearchResponse {
  readonly results: readonly ScoredCandidate[];
  readonly intent: Intent;
  readonly plan: RankingPlan;
  readonly degraded: readonly Degradation[];
  /** Which arms actually contributed. Empty means the read fell back entirely. */
  readonly armsUsed: readonly ArmName[];
  /** Token cost of the packed payload (stage 11). */
  readonly tokens: number;
  /** Whether autocut ran. False whenever rerank is off — see {@link ScoredCandidate}. */
  readonly autocutApplied: boolean;
}
