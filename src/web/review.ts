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

import { textArrayLiteral } from '../core/write/pg-values.ts';
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

export type ProposalOutcome =
  | { readonly ok: true; readonly action: 'applied' | 'dismissed'; readonly hadPrior: boolean }
  | { readonly ok: false; readonly reason: 'already_closed' | 'target_gone' | 'card_changed' | ProposalRefusal };

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
