/**
 * The decisions waiting on the owner — the read and the writes behind
 * `/dashboard?view=review`.
 *
 * ===========================================================================
 * THE GAP THIS CLOSES, AND WHY IT COULD ONLY EVER BE THIS SURFACE
 * ===========================================================================
 *
 * `review_queue` has been **write-only since it shipped.** Its one writer is
 * `enqueueReview`; every other touch in `src/` is a count on a dashboard, a
 * count in the briefing, or the hard DELETE in subject erasure. No UPDATE has
 * ever existed. The table's own schema declares `state IN
 * ('open','applied','dismissed')` and an index over the open rows ordered
 * newest-first — a listing query nothing runs — so the feature was designed,
 * indexed, and then never given a surface.
 *
 * Meanwhile the dashboard tells its owner "N proposals are open. **Ask your
 * assistant about them**", and the briefing tells the assistant's reader the
 * same. That instruction names the one actor the database forbids:
 * `review_queue_closed_by_is_out_of_band` admits `user_out_of_band` and
 * `internal` and nothing else, under a header stating that `agent_mcp` is absent
 * because *the assistant holding `remember` is the assistant reading the
 * attacker's mail*. So this is not one possible home for the feature. It is the
 * only one the schema permits, and the copy that pointed elsewhere moves in the
 * same commit.
 *
 * There is a larger fact underneath. `user_out_of_band` is defined in
 * `src/core/search/types.ts` as "the user said so, through the web app or
 * panel"; it is one of only two attestations that corroborate under R12a; and
 * **nothing in this codebase has ever written it.** Every other call site that
 * touches the vocabulary is a comment explaining why *it* is not that value.
 * This module is the first thing in the product to speak in that voice.
 *
 * ===========================================================================
 * THE PRIVACY LINE, AND THE ONE PLACE THIS PRODUCT CROSSES IT
 * ===========================================================================
 *
 * `src/web/coverage.ts` states the rule every owner-facing surface obeys:
 * **counts, closed-vocabulary codes, and instants. No names, no titles, no
 * statements — including the user's own.** `?view=processing` obeys it. This
 * page does not, and the crossing is the point rather than an oversight:
 *
 *   **A decision about a sentence is impossible without the sentence.** A row
 *   reading `entity #418, confidence 0.63` asks somebody to authorise text they
 *   cannot see, which is the exact failure the subject-erasure preview exists to
 *   avoid — it renders excerpts *because* a controller authorising a deletion
 *   must see what they are deleting.
 *
 * What makes the crossing defensible is that coverage's four arguments are all
 * arguments about **ambient aggregation**: a page that renders forty names in
 * one screenful, left open on a desk, is the only artifact that ever holds the
 * owner's address book at once. This page is the opposite artifact. It is
 * navigated to, it holds only what is undecided, its steady state is **empty**,
 * and every row on it is a question the system asked and cannot answer alone.
 *
 * Note the precedent honestly: the erasure preview is API-only, so it is a
 * *route* precedent and not a *page* one. This is the first rendered page in the
 * product to carry a brain-derived sentence, and the commitments that make that
 * safe are enforced by the queries below rather than by care:
 *
 *   * **Only undecided rows.** `state = 'open'` and `status = 'open'`. A decided
 *     proposal is never rendered again by anything.
 *   * **A ceiling, and the honesty about it.** {@link REVIEW_CEILING} rows per
 *     section, read with `LIMIT ceiling + 1` so "exactly the ceiling" and "the
 *     ceiling and there is more" stay different facts on the page.
 *   * **Every rendered string is capped**, and the cap is a fact the row
 *     carries: `proposal`, `entity_card.summary` and `entity.canonical_name` all
 *     have no length CHECK behind them, so an uncapped render puts however many
 *     kilobytes a model wrote into a page heading.
 *   * **Severed prose is withheld, not re-printed.** Severance sweeps seven
 *     content tables and `review_queue` is in none of them, so a proposal
 *     quoting a disconnected account's mail survives with its text intact. The
 *     owner asked for that account's content to be gone; this page honours that
 *     even though the sweep did not reach the row. Tested against the *instant*
 *     rather than membership, because `severance` is append-only history and a
 *     proposal enqueued after a reconnect quotes live content.
 *   * **Erased statements are withheld.** Subject erasure soft-deletes facts and
 *     never touches `contradiction_report`, so a plain join would re-render an
 *     erased sentence for the whole 72 hours before the purge.
 *
 * ===========================================================================
 * WHAT THIS SCREEN REFUSES TO DO, AND THE ARGUMENT FOR EACH
 * ===========================================================================
 *
 * **It never supersedes a fact.** The obvious design for a contradiction is a
 * button reading "this one is right" that writes `fact.superseded_by`. It is
 * refused three times over. R12 says contradiction handling is *report-only* —
 * in the roadmap, twice more in the plan, and restated in the phase that writes
 * these rows. The `resolution` CHECK admits `'neither'`, which has no successor
 * row to point at, which is only coherent if the column records a **verdict**
 * rather than triggering a mutation. And it would be the only unrecoverable act
 * in the product: nothing in `src/` ever clears `superseded_by`, while `forget`
 * on the losing fact writes a `retraction` row with a 72-hour undo. A page must
 * not offer a worse remedy than the one already built.
 *
 * So a contradiction here records what the owner concluded and touches neither
 * statement. Both stay live, searchable, and in the briefing.
 *
 * **Apply is offered for one kind, and refused in prose for the rest.** A `fact`
 * proposal needs an embedding, and `fact.embedding` is NOT NULL — the
 * consolidate path buys the vector with a gateway and a budget, and this module
 * holds neither. A `commitment` needs `compiled_truth`, decided once at write
 * from an attestation set, which is the most trust-sensitive flag in the system
 * and not a form field. Three more kinds are declared in the CHECK and written
 * by nothing. Every refusal renders as a **sentence beside the row**, never as a
 * disabled button: a form whose route would refuse it is the dead affordance the
 * connector panel exists to stop being.
 *
 * **Apply retires the card it replaces rather than overwriting it.**
 * `writeEntityCard` is `ON CONFLICT … DO UPDATE SET summary`, which destroys the
 * prior text in place with no version row anywhere. Retire-and-insert is the
 * same write without the destruction, it needs no migration — `entity_card`
 * already carries `deleted_at` and its uniqueness promise is partial over live
 * rows — and it is what makes the undo possible at all.
 *
 * **The undo takes no card id from the caller.** Every target is derived from
 * the claimed review row and the instant it was closed at. A form that named a
 * card could hard-DELETE another entity's live card with no ledger row possible
 * to restore it, and could resurrect erased content by naming an erasure
 * instant the product hands out in a receipt.
 */

import type { SQL } from 'bun';

import { mergeEntities, planMerge } from '../core/write/merge.ts';
import { textArrayLiteral } from '../core/write/pg-values.ts';
import { mergeProposalPair } from '../worker/consolidate/deterministic.ts';
import type { ReviewKind } from '../worker/consolidate/materialize.ts';

/** One screenful of decisions, plus the row that answers "is there more". */
export const REVIEW_CEILING = 50;

/**
 * The longest sentence this page will put a decision button under.
 *
 * Not the erasure preview's excerpt length, and the difference is the verb: that
 * excerpt exists so a controller can *recognise* a row, and this text exists so
 * an owner can *decide about* one. A truncated proposal under an Apply button is
 * a button that writes bytes its presser never read — so a row over the ceiling
 * keeps its excerpt and loses its Apply.
 */
export const REVIEWABLE_CHARACTERS = 2000;

/** A name is a label, not a paragraph; `entity.canonical_name` has no length CHECK. */
export const NAME_CHARACTERS = 200;

export type ProposalRefusal =
  | 'origin_severed'
  | 'no_apply_path'
  | 'needs_an_embedding'
  | 'needs_corroboration'
  | 'too_long_to_read'
  | 'target_gone';

export interface Proposal {
  readonly reviewId: string;
  readonly kind: ReviewKind;
  readonly subjectName: string | null;
  readonly nameTruncated: boolean;
  readonly current: string | null;
  readonly currentTruncated: boolean;
  /** The pin the apply checks. Null exactly when {@link Proposal.current} is null. */
  readonly currentCardId: string | null;
  /** True when the card this would replace is one the owner already approved. */
  readonly currentIsYours: boolean;
  /** Null exactly when the refusal is `origin_severed`: severed prose is not re-printed. */
  readonly proposal: string | null;
  readonly truncated: boolean;
  readonly confidence: number;
  readonly origins: readonly string[];
  readonly createdAt: string;
  /** Null means Apply is offered. Non-null renders as a sentence, never a dead button. */
  readonly refusal: ProposalRefusal | null;
  /**
   * For a merge: the two entity ids this listing resolved, comma-separated.
   *
   * The merge's equivalent of {@link Proposal.currentCardId} — the pin that says
   * *these are the two rows you were shown*. Null for every other kind, and for
   * a merge whose pair no longer resolves to exactly two live rows.
   */
  readonly seenPair: string | null;
}

export type SideState = 'live' | 'superseded' | 'withdrawn';

export interface Side {
  readonly factId: string;
  /** Null exactly when withdrawn. An erased sentence is not re-printed. */
  readonly statement: string | null;
  readonly state: SideState;
  readonly truncated: boolean;
}

export interface Conflict {
  readonly reportId: string;
  readonly kind: string;
  readonly left: Side;
  readonly right: Side;
  readonly origins: readonly string[];
  readonly detectedAt: string;
  /** Both statements renderable. False renders the explanation and a close, nothing else. */
  readonly adjudicable: boolean;
}

export interface ReviewView {
  /** Coverage's gate, for coverage's reason: an empty queue on a brain that never dreamt is the plan, not a clean bill. */
  readonly everDreamt: boolean;
  readonly proposals: readonly Proposal[];
  readonly contradictions: readonly Conflict[];
  readonly proposalsOverflowed: boolean;
  readonly contradictionsOverflowed: boolean;
}

function isoOf(value: Date | string | null): string {
  if (value === null) return '';
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Which refusal applies, in the one order that produces sensible prose.
 *
 * **The precedence is load-bearing and cannot be expressed in the query.**
 * `fact` and `commitment` proposals carry `chunk:<id>` targets, so the
 * `entity:` parse yields NULL and `targetLive` is false for every one of them.
 * Without this ordering the single `fact` row in production would draw "the
 * person or company this was about is no longer in your brain", which is
 * nonsense about a chunk.
 */
export function refusalFor(row: {
  readonly severed: boolean;
  readonly kind: ReviewKind;
  readonly truncated: boolean;
  readonly targetLive: boolean;
}): ProposalRefusal | null {
  if (row.severed) return 'origin_severed';
  if (row.kind === 'fact') return 'needs_an_embedding';
  if (row.kind === 'commitment') return 'needs_corroboration';
  // Before the `entity_card` test, and after the kinds carrying `chunk:` refs.
  // An `entity_merge` row DOES carry a parseable entity ref, so it must go
  // through `targetLive` — but its prose is the pair key rather than a summary
  // to read, so truncation means something different and is applied first.
  if (row.kind === 'entity_merge') {
    if (row.truncated) return 'too_long_to_read';
    return row.targetLive ? null : 'target_gone';
  }
  if (row.kind !== 'entity_card') return 'no_apply_path';
  if (row.truncated) return 'too_long_to_read';
  if (!row.targetLive) return 'target_gone';
  return null;
}

export async function readReview(sql: SQL): Promise<ReviewView> {
  // Written to land on `review_queue_open (created_at DESC) WHERE state='open'`
  // — an index shipped in the same rung as the table and never run until now.
  const proposalRows = (await sql.unsafe(
    `WITH open_rows AS (
       SELECT review_id, kind, target_ref, confidence, origin_contexts, created_at,
              length(proposal) > $1::int AS truncated,
              left(proposal, $1::int)    AS excerpt,
              -- target_ref is deliberately not a foreign key, so it is parsed
              -- rather than joined, and a malformed one becomes NULL rather than
              -- an error. Digits are capped so a crafted ref cannot overflow
              -- bigint on the way to a page render.
              nullif(substring(target_ref from '^entity:([0-9]{1,18})$'), '')::bigint AS entity_id,
              -- severance is append-only history, so the INSTANT is the test
              -- and not membership: a proposal enqueued before a severance
              -- quotes evidence that severance tombstoned, while one enqueued
              -- after a reconnect quotes live content and must not be withheld.
              EXISTS (
                SELECT 1 FROM severance s
                 WHERE s.origin_context = ANY (review_queue.origin_contexts)
                   AND s.severed_at >= review_queue.created_at
              ) AS severed
         FROM review_queue
        WHERE state = 'open'
        ORDER BY created_at DESC
        LIMIT $2::int
     )
     SELECT r.review_id::text AS review_id,
            r.kind,
            CASE WHEN r.severed THEN NULL ELSE r.excerpt END AS proposal,
            r.truncated,
            r.severed,
            r.confidence,
            r.origin_contexts,
            r.created_at,
            left(e.canonical_name, $3::int)  AS subject_name,
            length(e.canonical_name) > $3::int AS name_truncated,
            e.entity_id IS NOT NULL          AS target_live,
            left(c.summary, $1::int)         AS current_summary,
            length(c.summary) > $1::int      AS current_truncated,
            c.card_id::text                  AS current_card_id,
            coalesce(c.trust_level = 'user_stated', false) AS current_is_yours
       FROM open_rows r
       -- deleted_at IS NULL is the half that would otherwise succeed SILENTLY:
       -- the live-card uniqueness index is partial over live rows, so inserting
       -- a card against a soft-deleted entity works and lands a live card on a
       -- dead person. A hard-deleted one raises instead. Two mechanisms, one
       -- user-visible outcome, and only one announces itself.
       LEFT JOIN entity e ON e.entity_id = r.entity_id AND e.deleted_at IS NULL
       LEFT JOIN entity_card c ON c.entity_id = e.entity_id AND c.deleted_at IS NULL
      ORDER BY r.created_at DESC`,
    [REVIEWABLE_CHARACTERS, REVIEW_CEILING + 1, NAME_CHARACTERS],
  )) as Array<{
    review_id: string;
    kind: ReviewKind;
    proposal: string | null;
    truncated: boolean;
    severed: boolean;
    confidence: number;
    origin_contexts: string[];
    created_at: Date | string;
    subject_name: string | null;
    name_truncated: boolean | null;
    target_live: boolean;
    current_summary: string | null;
    current_truncated: boolean | null;
    current_card_id: string | null;
    current_is_yours: boolean;
  }>;

  const proposalsOverflowed = proposalRows.length > REVIEW_CEILING;

  // **The pin a merge needs, resolved once for the whole listing.**
  //
  // A card's pin is the id it displayed; a merge's is *these are the two rows
  // you were shown*, and the pair lives in the proposal's PROSE as names rather
  // than in a column — a consequence of proposals being keyed on names, which
  // is what stops a widen re-asking every question the owner already dismissed.
  //
  // One statement for every merge row on the page, not one per row: this is a
  // page render, and the listing is already bounded by `REVIEW_CEILING`.
  const pairNames = new Map<string, readonly [string, string]>();
  for (const row of proposalRows.slice(0, REVIEW_CEILING)) {
    if (row.kind !== 'entity_merge' || row.proposal === null) continue;
    const pair = mergeProposalPair(row.proposal);
    if (pair !== null) pairNames.set(row.review_id, pair);
  }
  const idByName = new Map<string, string[]>();
  if (pairNames.size > 0) {
    const wanted = [...new Set([...pairNames.values()].flat())];
    const rows = (await sql.unsafe(
      `SELECT entity_id::text AS entity_id, lower(canonical_name) AS key
         FROM entity WHERE deleted_at IS NULL AND lower(canonical_name) = ANY($1::text[])`,
      [textArrayLiteral(wanted.map((name) => name.toLowerCase()))],
    )) as Array<{ entity_id: string; key: string }>;
    for (const row of rows) {
      idByName.set(row.key, [...(idByName.get(row.key) ?? []), row.entity_id]);
    }
  }
  const seenPairOf = (reviewId: string): string | null => {
    const pair = pairNames.get(reviewId);
    if (pair === undefined) return null;
    const ids = pair.map((name) => idByName.get(name.toLowerCase()) ?? []);
    // Exactly one live row per name, or there is no honest pin to give: zero
    // means the pair is gone, and more than one is a question this screen
    // cannot answer because it cannot know which row was meant.
    if (ids.some((hits) => hits.length !== 1)) return null;
    return ids.map((hits) => hits[0]).join(',');
  };

  const proposals: Proposal[] = proposalRows.slice(0, REVIEW_CEILING).map((row) => ({
    reviewId: row.review_id,
    kind: row.kind,
    subjectName: row.subject_name,
    nameTruncated: row.name_truncated === true,
    current: row.current_summary,
    currentTruncated: row.current_truncated === true,
    currentCardId: row.current_card_id,
    currentIsYours: row.current_is_yours,
    proposal: row.proposal,
    truncated: row.truncated,
    confidence: row.confidence,
    origins: row.origin_contexts,
    createdAt: isoOf(row.created_at),
    refusal: refusalFor({
      severed: row.severed,
      kind: row.kind,
      truncated: row.truncated,
      targetLive: row.target_live,
    }),
    seenPair: seenPairOf(row.review_id),
  }));

  // Lands on `contradiction_open (detected_at DESC) WHERE status='open'`, the
  // sibling index that has also never been run.
  //
  // **The CASE is the erased-text guard and it is not optional.** Subject
  // erasure soft-deletes facts and never touches this table — it is not in the
  // module's sweep list — so a plain join would re-render a correspondent's
  // erased sentence for the full 72 hours between the erasure and the purge.
  const conflictRows = (await sql.unsafe(
    `SELECT r.report_id::text AS report_id,
            r.kind,
            r.origin_contexts,
            r.detected_at,
            l.fact_id::text AS left_fact_id,
            CASE WHEN l.deleted_at IS NULL AND l.quarantined_at IS NULL
                 THEN left(l.statement, $1::int) END AS left_statement,
            (l.deleted_at IS NOT NULL OR l.quarantined_at IS NOT NULL) AS left_withdrawn,
            l.superseded_by IS NOT NULL AS left_superseded,
            length(l.statement) > $1::int AS left_truncated,
            f.fact_id::text AS right_fact_id,
            CASE WHEN f.deleted_at IS NULL AND f.quarantined_at IS NULL
                 THEN left(f.statement, $1::int) END AS right_statement,
            (f.deleted_at IS NOT NULL OR f.quarantined_at IS NOT NULL) AS right_withdrawn,
            f.superseded_by IS NOT NULL AS right_superseded,
            length(f.statement) > $1::int AS right_truncated
       FROM contradiction_report r
       JOIN fact l ON l.fact_id = r.left_fact_id
       JOIN fact f ON f.fact_id = r.right_fact_id
      WHERE r.status = 'open'
      ORDER BY r.detected_at DESC
      LIMIT $2::int`,
    [REVIEWABLE_CHARACTERS, REVIEW_CEILING + 1],
  )) as Array<Record<string, unknown>>;

  const sideOf = (
    row: Record<string, unknown>,
    prefix: 'left' | 'right',
  ): Side => {
    const withdrawn = row[`${prefix}_withdrawn`] === true;
    return {
      factId: String(row[`${prefix}_fact_id`] ?? ''),
      statement: withdrawn ? null : ((row[`${prefix}_statement`] as string | null) ?? null),
      state: withdrawn ? 'withdrawn' : row[`${prefix}_superseded`] === true ? 'superseded' : 'live',
      truncated: row[`${prefix}_truncated`] === true,
    };
  };

  const contradictionsOverflowed = conflictRows.length > REVIEW_CEILING;
  const contradictions: Conflict[] = conflictRows.slice(0, REVIEW_CEILING).map((row) => {
    const left = sideOf(row, 'left');
    const right = sideOf(row, 'right');
    return {
      reportId: String(row['report_id'] ?? ''),
      kind: String(row['kind'] ?? 'value_conflict'),
      left,
      right,
      origins: (row['origin_contexts'] as string[] | undefined) ?? [],
      detectedAt: isoOf((row['detected_at'] as Date | string | null) ?? null),
      // A verdict about text the page withheld is a verdict nobody made.
      adjudicable: left.state !== 'withdrawn' && right.state !== 'withdrawn',
    };
  });

  // Coverage's own predicate, for coverage's own reason: a count that is
  // structurally zero for the reader's tier is a dead panel that teaches them
  // the feature is broken rather than that it has not run.
  const dreamtRows = (await sql.unsafe(
    `SELECT EXISTS (
       SELECT 1 FROM consolidation_run WHERE finished_at IS NOT NULL AND dreamt
     ) AS ever_dreamt`,
    [],
  )) as Array<{ ever_dreamt: boolean }>;

  return {
    everDreamt: dreamtRows[0]?.ever_dreamt ?? false,
    proposals,
    contradictions,
    proposalsOverflowed,
    contradictionsOverflowed,
  };
}

/**
 * Apply one merge proposal, inside the caller's transaction.
 *
 * **The pair is re-resolved from the proposal's own prose**, using the function
 * that wrote it, rather than from `target_ref` — which names only one of the
 * two. That is a consequence of the proposal being keyed on NAMES: an id-keyed
 * one would re-enqueue every dismissal under a new keeper after any widen.
 *
 * **`pair_changed` is the merge's `card_changed`.** Between the listing and the
 * press, a widen can mint new ids for either row, or a rule merge can absorb
 * one. Applying then would merge two rows the owner never saw. The listing
 * emits both ids it displayed and this refuses on any mismatch.
 */
async function applyMerge(
  tx: SQL,
  input: { readonly proposal: string; readonly seenPair: string | null },
): Promise<
  | { readonly ok: true; readonly entityId: string }
  | { readonly ok: false; readonly reason: 'target_gone' | 'pair_changed' | 'two_of_yours' }
> {
  const pair = mergeProposalPair(input.proposal);
  if (pair === null) return { ok: false, reason: 'target_gone' } as const;

  // Resolved by canonical name against the live set, never through
  // `findEntitiesByName`: that hops aliases first and collapses with
  // `DISTINCT ON` over a vocabulary the schema itself calls "deliberately not
  // unique across entities", so it could answer with a different entity than
  // the one the proposal named.
  const resolved: string[] = [];
  for (const name of pair) {
    const rows = (await tx.unsafe(
      `SELECT entity_id::text AS entity_id FROM entity
        WHERE deleted_at IS NULL AND lower(canonical_name) = lower($1)
        ORDER BY entity_id
          FOR UPDATE`,
      [name],
    )) as Array<{ entity_id: string }>;
    // Zero is a pair that no longer exists; more than one is a question this
    // screen cannot answer, because it cannot know which was meant.
    if (rows.length !== 1) return { ok: false, reason: 'target_gone' } as const;
    resolved.push(rows[0]?.entity_id ?? '');
  }

  // **An absent pin refuses, and the reason is the shape of when it is absent.**
  //
  // The first version skipped the comparison when `seenPair` was null, which
  // reads as lenient and is the opposite: the listing emits null exactly when a
  // name resolves to zero or more than one live row — the KNOWN-AMBIGUOUS case
  // — so the one situation with no pin was the one situation where the page
  // could not say which two rows it had shown. It applied anyway.
  //
  // A merge cannot be undone, so the missing claim is refused rather than
  // assumed. Reload and the listing either offers a pin or refuses the row.
  if (input.seenPair === null) return { ok: false, reason: 'pair_changed' } as const;
  const seen = input.seenPair.split(',').sort();
  if (JSON.stringify(seen) !== JSON.stringify([...resolved].sort())) {
    return { ok: false, reason: 'pair_changed' } as const;
  }

  const [primary, other] = resolved;
  if (primary === undefined || other === undefined) {
    return { ok: false, reason: 'target_gone' } as const;
  }
  const planned = await planMerge(tx, { primary, members: [other] });
  if (!planned.ok) {
    // `two_of_yours` is the only refusal the owner can act on; the rest mean
    // the rows moved, which is `target_gone` from this surface.
    return {
      ok: false,
      reason: planned.reason === 'two_of_yours' ? 'two_of_yours' : 'target_gone',
    } as const;
  }
  const merged = await mergeEntities(tx, planned.plan, new Date());
  return { ok: true, entityId: merged.entityId } as const;
}

export type ProposalOutcome =
  | { readonly ok: true; readonly action: 'applied' | 'dismissed'; readonly hadPrior: boolean }
  | {
      readonly ok: false;
      readonly reason:
        | 'already_closed'
        | 'target_gone'
        | 'card_changed'
        /** The two rows are not the two the listing showed. */
        | 'pair_changed'
        /** Two summaries the owner approved are two decisions; it will not pick. */
        | 'two_of_yours'
        | ProposalRefusal;
    };

/**
 * Close one proposal, and for `entity_card` write the card it proposes.
 *
 * One transaction. The `state = 'open'` predicate on the close **is** the
 * concurrency control; `FOR UPDATE` only removes the interleave.
 */
export async function decideProposal(
  sql: SQL,
  input: {
    readonly reviewId: string;
    readonly intent: 'apply' | 'dismiss';
    readonly seenCardId: string | null;
    /**
     * The two entity ids the listing showed for a merge, comma-separated.
     *
     * The card path re-checks the card id it displayed; a merge needs the
     * equivalent for *these are still the two rows you looked at*. It cannot be
     * derived from the row, because the pair lives in the proposal PROSE as
     * names — see `mergeProposalPair`.
     */
    readonly seenPair: string | null;
    readonly now: Date;
  },
): Promise<ProposalOutcome> {
  return (await sql.begin(async (tx: SQL) => {
    const claimed = (await tx.unsafe(
      `SELECT kind, target_ref, proposal, confidence, run_id::text AS run_id, origin_contexts,
              length(proposal) AS n,
              nullif(substring(target_ref from '^entity:([0-9]{1,18})$'), '')::bigint AS entity_id,
              -- Read here rather than trusted from the listing, and never
              -- hardcoded: the listing withholds a severed row's prose, so
              -- applying one would act on text the owner was deliberately not
              -- shown. The instant is the test, not membership -- see the
              -- listing's own note.
              EXISTS (
                SELECT 1 FROM severance s
                 WHERE s.origin_context = ANY (review_queue.origin_contexts)
                   AND s.severed_at >= review_queue.created_at
              ) AS severed
         FROM review_queue
        WHERE review_id = $1::bigint AND state = 'open'
          FOR UPDATE`,
      [input.reviewId],
    )) as Array<{
      kind: ReviewKind;
      proposal: string;
      confidence: number;
      run_id: string | null;
      origin_contexts: string[];
      n: number;
      entity_id: string | null;
      severed: boolean;
    }>;
    const row = claimed[0];
    if (row === undefined) return { ok: false, reason: 'already_closed' } as const;

    const close = async (state: 'applied' | 'dismissed', by: 'user_out_of_band' | 'internal') => {
      // `origin_contexts` is never in the SET list: its immutability trigger is
      // `BEFORE UPDATE OF origin_contexts` and fires only when named.
      await tx.unsafe(
        `UPDATE review_queue
            SET state = $2, closed_by = $3, closed_at = $4::timestamptz
          WHERE review_id = $1::bigint AND state = 'open'`,
        [input.reviewId, state, by, input.now.toISOString()],
      );
    };

    if (input.intent === 'dismiss') {
      await close('dismissed', 'user_out_of_band');
      return { ok: true, action: 'dismissed', hadPrior: false } as const;
    }

    const refusal = refusalFor({
      severed: row.severed,
      kind: row.kind,
      truncated: row.n > REVIEWABLE_CHARACTERS,
      targetLive: row.entity_id !== null,
    });
    if (refusal !== null && refusal !== 'target_gone') return { ok: false, reason: refusal } as const;
    if (row.entity_id === null) {
      // The owner pressed Apply, so the row must not stay open forever — nothing
      // else in `src/` ever closes a superseded proposal. But nothing about the
      // SENTENCE was judged, and `user_out_of_band` has to keep meaning "a
      // person judged this", because that attestation is this screen's product.
      await close('dismissed', 'internal');
      return { ok: false, reason: 'target_gone' } as const;
    }

    if (row.kind === 'entity_merge') {
      const applied = await applyMerge(tx, {
        proposal: row.proposal,
        seenPair: input.seenPair,
      });
      if (!applied.ok) {
        // `target_gone` closes the row: a pair that no longer resolves is a
        // question about rows that are not there, and leaving it open would ask
        // it forever. Everything else leaves the row OPEN, because the answer
        // may differ next time the owner looks.
        if (applied.reason === 'target_gone') {
          await close('dismissed', 'internal');
          return { ok: false, reason: 'target_gone' } as const;
        }
        return { ok: false, reason: applied.reason } as const;
      }
      await close('applied', 'user_out_of_band');
      return { ok: true, action: 'applied', hadPrior: false } as const;
    }

    const entityRows = (await tx.unsafe(
      `SELECT origin_contexts FROM entity WHERE entity_id = $1::bigint AND deleted_at IS NULL`,
      [row.entity_id],
    )) as Array<{ origin_contexts: string[] }>;
    const entity = entityRows[0];
    if (entity === undefined) {
      await close('dismissed', 'internal');
      return { ok: false, reason: 'target_gone' } as const;
    }

    // The card the LISTING showed, pinned. This is what makes `card_changed`
    // mean something rather than being a promise the SQL does not keep.
    const liveRows = (await tx.unsafe(
      `SELECT card_id::text AS card_id FROM entity_card
        WHERE entity_id = $1::bigint AND deleted_at IS NULL
          FOR UPDATE`,
      [row.entity_id],
    )) as Array<{ card_id: string }>;
    const liveId = liveRows[0]?.card_id ?? null;
    if (liveId !== input.seenCardId) return { ok: false, reason: 'card_changed' } as const;

    if (liveId !== null) {
      // Retire it, keeping its bytes. This is the version row the schema never
      // got, and it needs no migration.
      await tx.unsafe(
        `UPDATE entity_card SET deleted_at = $2::timestamptz
          WHERE card_id = $1::bigint AND deleted_at IS NULL`,
        [liveId, input.now.toISOString()],
      );
    }

    const origins = [...new Set([...entity.origin_contexts, ...row.origin_contexts])].sort();
    await tx.unsafe(
      `INSERT INTO entity_card (entity_id, summary, trust_level, derivation, confidence,
                                model_id, run_id, origin_contexts, created_at)
       VALUES ($1::bigint, $2, 'user_stated', 'model_derived', $3, NULL, $4::bigint, $5::text[], $6::timestamptz)`,
      [
        row.entity_id,
        row.proposal,
        row.confidence,
        row.run_id,
        textArrayLiteral(origins),
        input.now.toISOString(),
      ],
    );

    // The entity, re-read: this closes the window opened by the first check.
    const still = (await tx.unsafe(
      `SELECT deleted_at FROM entity WHERE entity_id = $1::bigint`,
      [row.entity_id],
    )) as Array<{ deleted_at: Date | null }>;
    if (still[0]?.deleted_at != null) throw new ReviewRollback('target_gone');

    await close('applied', 'user_out_of_band');
    return { ok: true, action: 'applied', hadPrior: liveId !== null } as const;
  })) as ProposalOutcome;
}

/** Thrown to roll a transaction back with a typed reason rather than a 500. */
export class ReviewRollback extends Error {
  constructor(readonly reason: 'target_gone' | 'card_changed') {
    super(reason);
  }
}

export type UndoOutcome =
  | { readonly ok: true; readonly restored: boolean }
  | { readonly ok: false; readonly reason: 'nothing_to_undo' };

/**
 * Undo one apply.
 *
 * **No card id crosses the wire.** Every target is derived from the claimed
 * review row and the instant it was closed at — a form that named a card could
 * hard-DELETE another entity's live card with no ledger row able to restore it.
 */
export async function undoProposal(
  sql: SQL,
  input: { readonly reviewId: string },
): Promise<UndoOutcome> {
  return (await sql.begin(async (tx: SQL) => {
    // The instant is read BEFORE anything nulls it: `UPDATE … RETURNING` returns
    // NEW values, so the reopen cannot be the gate. The lock also blocks subject
    // erasure's DELETE for the length of this transaction.
    const claimed = (await tx.unsafe(
      `SELECT closed_at,
              nullif(substring(target_ref from '^entity:([0-9]{1,18})$'), '')::bigint AS entity_id
         FROM review_queue
        WHERE review_id = $1::bigint AND state = 'applied' AND closed_by = 'user_out_of_band'
          -- A server gate, not a copy change. This function knows exactly one
          -- reversal: delete a user_stated card and un-retire the one beneath
          -- it. Any other appliable kind closes into the same claim, and aimed
          -- at one of those this would restore nothing while reopening the row
          -- for a second apply. The two extra predicates on the DELETE below
          -- make that unreachable today; this makes it unreachable by
          -- construction.
          AND kind = 'entity_card'
          FOR UPDATE`,
      [input.reviewId],
    )) as Array<{ closed_at: Date | string | null; entity_id: string | null }>;
    const row = claimed[0];
    if (row === undefined || row.entity_id === null || row.closed_at === null) {
      return { ok: false, reason: 'nothing_to_undo' } as const;
    }
    const closedAt = isoOf(row.closed_at);

    // Identified by the entity and the instant, never by anything the caller
    // sent. Matching `created_at` is what makes a stale notice for an EARLIER
    // apply of the same entity refuse rather than delete the newer one's card.
    const removed = (await tx.unsafe(
      `DELETE FROM entity_card
        WHERE entity_id = $1::bigint AND created_at = $2::timestamptz
          AND trust_level = 'user_stated' AND deleted_at IS NULL
       RETURNING card_id::text AS card_id`,
      [row.entity_id, closedAt],
    )) as Array<{ card_id: string }>;
    if (removed.length === 0) return { ok: false, reason: 'nothing_to_undo' } as const;

    // And only then the one it replaced. The live-card uniqueness index is a
    // plain partial UNIQUE — not deferrable, checked per statement — so clearing
    // `deleted_at` first would put two live cards on one entity and abort.
    //
    // Zero rows here is NOT a failure: there may have been no prior card, or the
    // retention purge may have taken it after its 72 hours.
    const restored = (await tx.unsafe(
      `UPDATE entity_card SET deleted_at = NULL
        WHERE entity_id = $1::bigint AND deleted_at = $2::timestamptz
       RETURNING card_id::text AS card_id`,
      [row.entity_id, closedAt],
    )) as Array<{ card_id: string }>;

    await tx.unsafe(
      `UPDATE review_queue
          SET state = 'open', closed_by = NULL, closed_at = NULL
        WHERE review_id = $1::bigint AND state = 'applied'`,
      [input.reviewId],
    );

    return { ok: true, restored: restored.length > 0 } as const;
  })) as UndoOutcome;
}

export type ConflictVerdict = 'left' | 'right' | 'both' | 'neither';

export type ConflictOutcome =
  | { readonly ok: true; readonly action: 'resolved' | 'dismissed' }
  | { readonly ok: false; readonly reason: 'already_closed' | 'not_adjudicable' };

/**
 * Record what the owner concluded about one contradiction.
 *
 * **Nothing else happens.** No `superseded_by`, no `deleted_at`, no
 * `quarantined_at`. Both statements stay live, searchable, and in the briefing —
 * see the header for the three arguments that settle this.
 */
export async function decideConflict(
  sql: SQL,
  input: {
    readonly reportId: string;
    readonly verdict: ConflictVerdict | null;
    readonly now: Date;
  },
): Promise<ConflictOutcome> {
  const sides = (await sql.unsafe(
    `SELECT (l.deleted_at IS NOT NULL OR l.quarantined_at IS NOT NULL) AS left_withdrawn,
            (f.deleted_at IS NOT NULL OR f.quarantined_at IS NOT NULL) AS right_withdrawn
       FROM contradiction_report r
       JOIN fact l ON l.fact_id = r.left_fact_id
       JOIN fact f ON f.fact_id = r.right_fact_id
      WHERE r.report_id = $1::bigint AND r.status = 'open'`,
    [input.reportId],
  )) as Array<{ left_withdrawn: boolean; right_withdrawn: boolean }>;
  const side = sides[0];
  if (side === undefined) return { ok: false, reason: 'already_closed' };
  if (input.verdict !== null && (side.left_withdrawn || side.right_withdrawn)) {
    return { ok: false, reason: 'not_adjudicable' };
  }

  // A dismiss writes `resolution` NULL and `resolved_at` anyway: a permanent
  // mute with no instant is a shape this table already has too much of.
  const done = (await sql.unsafe(
    `UPDATE contradiction_report
        SET status = $2, resolution = $3, resolved_at = $4::timestamptz,
            resolved_by = 'user_out_of_band'
      WHERE report_id = $1::bigint AND status = 'open'
     RETURNING report_id::text AS report_id`,
    [
      input.reportId,
      input.verdict === null ? 'dismissed' : 'resolved',
      input.verdict,
      input.now.toISOString(),
    ],
  )) as Array<{ report_id: string }>;
  if (done.length === 0) return { ok: false, reason: 'already_closed' };
  return { ok: true, action: input.verdict === null ? 'dismissed' : 'resolved' };
}
