/**
 * `briefing` — the flagship read, assembled by SQL over what U11 already
 * materialised.
 *
 * ============================================================================
 * THE CONSTRAINT THIS FILE IS BUILT AROUND
 * ============================================================================
 *
 * **No request-time fan-out that scales with corpus size.** That is the whole
 * difference between a read that is still fast on a brain of 100k pages and one
 * that degrades into a timeout on exactly the user who has been here longest.
 * Every statement below is bounded by one of three things and never by the
 * document count:
 *
 *   * the **window** — meetings, the delta and the stale list are range scans on
 *     `created_at` / `stale_at`, each with a `LIMIT`;
 *   * the **entity dictionary** — participant resolution is (meetings in window)
 *     × (entity names), which grows with the brain's *people* rather than with
 *     its documents, and the meeting side is already capped;
 *   * a **count** — contradictions, pending review, uncorroborated claims and
 *     the debt counter are aggregates over indexed predicates, and none of them
 *     returns a row.
 *
 * The one thing deliberately *not* done here is what `search/read.ts` does for
 * ranking: materialise every page and resolve mentions in TypeScript. That is
 * correct for a ranked read over a bounded candidate set and would be a full
 * table scan on every morning briefing.
 *
 * **And no model call.** Not a budget decision — an availability one. A briefing
 * that needed a provider would be a briefing that fails on the morning the
 * provider is having a bad day, which is the one morning it matters.
 *
 * ============================================================================
 * COLD IS A SHAPE, NOT AN ERROR
 * ============================================================================
 *
 * A brain that has never consolidated has no entity cards, no commitments and no
 * synopsis layer, and a free-tier brain never will — R8 draws that line and says
 * the free briefing must **name what the paid tier would add** rather than being
 * silently thinner. So `coverage` is a value, `notIncluded` enumerates the
 * missing layers, and the cold path returns the same shape with fewer fields
 * populated. It never throws and it never returns an empty bundle to mean "not
 * ready".
 *
 * The cold decision reads the **run record** rather than counting cards: "has
 * the model tier ever completed over this brain" is a question the run table
 * answers directly, and inferring it from an empty card table would say `cold`
 * for a consolidated brain that happens to know about nobody.
 *
 * ============================================================================
 * THE DELTA NEEDS A CURSOR, AND THE CURSOR IS PER CALLER
 * ============================================================================
 *
 * A briefing without a delta is a dashboard: the same bundle every morning, with
 * no way to tell what is new since *you* last looked. So each credential carries
 * its own `last_read_at` (rung 4), the delta is the window from there, and the
 * cursor advances monotonically — a retried scheduled task with a stale clock
 * must not rewind and replay a week.
 *
 * **But an explicitly-asked-for window beats the bookmark, and does not move
 * it.** `since` used to be overridden by the cursor whenever one existed, which
 * made `briefing(since = 7 days ago)` mean "since your last call" — and since
 * *every* call banked a new bookmark, the two recipes this repo ships consumed
 * each other's delta over one credential. Two rules replace it, and they are one
 * decision seen from both ends:
 *
 *   * a caller who names a window gets that window (`basis: 'window'`), and
 *   * a **query is not a bookmark advance**, so that call banks nothing.
 *
 * A caller who names no window is asking the bookmark ("what is new since I last
 * looked"), gets it (`basis: 'cursor'`), and moves it. So the daily task and the
 * weekly review coexist on one connection: the daily owns the bookmark, and the
 * weekly reads across it without disturbing it.
 *
 * **The prompt bound is banked either way.** `last_read_at` is the only column
 * an explicit window leaves alone; the upgrade prompt's own bookkeeping still
 * lands, because a bound that only recorded itself on cursor reads would let a
 * client that always names a window see the prompt every single morning — which
 * is the daily sales pitch U12 step 3 exists to forbid.
 *
 * **`firstRead` is a stored fact, not an inference.** An empty delta and a
 * never-read cursor produce the same list, and they are opposite situations to a
 * reader. It reports the stored bookmark in both bases, so a windowed read never
 * claims a bookmark the connection does not have.
 *
 * The split below — {@link collectBriefing} does the SQL, {@link assembleBriefing}
 * is pure — exists so the blocking tier can grade the assembly (participant-card
 * completeness, delta correctness) with zero model calls and no database, the
 * same way `pipeline.ts:composeRanking` is gradeable while the arms are not.
 */

import type { SQL } from 'bun';

import { FIRST_PARTY_SURFACES } from '../../mcp/demarcation.ts';
import {
  readContentAge,
  readExportState,
  readNagState,
  recordNagShown,
  selfExportNag,
  type NagState,
  type SelfExportNag,
} from '../export/schedule.ts';
import type { Grant } from '../search/fence.ts';
import { textArrayLiteral } from '../write/pg-values.ts';
import { bandOf, upgradePrompt, type PromptState, type UpgradePrompt } from './prompt.ts';

/**
 * What a cold briefing is missing, named rather than implied.
 *
 * R8's list, quoted: participant cards, extracted commitments, the synopsis
 * layer. Exported so the handler and the tier assert against one list.
 */
export const BRIEFING_NOT_INCLUDED: readonly string[] = [
  'participant_cards',
  'extracted_commitments',
  'synopsis',
];

/** How many rows any one section may carry. Bounds the payload, not the truth. */
const SECTION_LIMIT = 20;

/** Characters per token, matching `search/pipeline.ts:estimateTokens`. */
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// The shapes. Ids are raw and text is unwrapped: the surface layer formats
// opaque ids and applies R2a's demarcation, and a core module that rendered
// either would be a second place those rules live.
//
// The one thing reached for upward is `FIRST_PARTY_SURFACES` — a constant, not
// a renderer. R12a's question is "could an outside sender have written this
// origin", and there must be exactly one answer to it; `materialize.ts` reaches
// for the same module for the same reason.
// ---------------------------------------------------------------------------

export interface BriefingRecord {
  readonly id: string;
  readonly kind: 'doc' | 'fact';
  readonly title: string | null;
  readonly text: string;
  readonly origins: readonly string[];
  readonly sourceType: string | null;
  readonly createdAt: string;
}

export interface BriefingParticipant {
  readonly entityId: string;
  readonly name: string;
  /** U11's card, or `null` when enrichment has not written one. */
  readonly card: string | null;
  /**
   * The entity's **whole** origin union, as a trust input rather than as
   * something a caller is shown.
   *
   * Its only consumer is `tools/read.ts`'s `demarcateIfExternal(person.card, …)`,
   * and the union is the correct input to that question for the reason
   * `fence.ts:visibleOrigins` sets out: a card written over mail an outsider
   * sent is attacker-authored text whether or not this grant holds the origin it
   * came from, and intersecting first can flip the demarcation off. The handler
   * renders `id`, `name` and the wrapped card and does not render this field —
   * a surface that wants to *show* a participant's origins must intersect, the
   * way `reads.ts:entityCard` does.
   */
  readonly origins: readonly string[];
}

export interface BriefingMeeting extends BriefingRecord {
  /**
   * When the meeting *is*, already coalesced — `occurred_at` when the provider
   * asserted one and arrival when it did not, which is the same expression the
   * lane windows and sorts on.
   *
   * It sits beside `createdAt` rather than replacing it because the surface's
   * projection is shared with every other lane: a meetings record that dropped
   * arrival would be a different shape from a delta record for no reason a
   * reader could see. Coalesced rather than nullable because the *sort* is
   * coalesced, and a bundle whose printed times cannot reproduce its own order
   * is the defect this field exists to close.
   */
  readonly occurredAt: string;
  readonly participants: readonly BriefingParticipant[];
}

export interface BriefingCommitment {
  readonly id: string;
  readonly statement: string;
  readonly owner: string | null;
  readonly dueOn: string | null;
  readonly origins: readonly string[];
  /** R12a's admission decision, as stored. Never recomputed here. */
  readonly compiledTruth: boolean;
}

export interface BriefingStale {
  readonly id: string;
  readonly title: string | null;
  readonly staleAt: string;
  /** The salience the deterministic tier scored, or `null` if it never has. */
  readonly relevance: number | null;
  readonly origins: readonly string[];
}

export interface BriefingCounts {
  /** A count and only a count — never the prompt's input (R8). */
  readonly contradictions: number;
  /** R8's deterministic counter: items awaiting extraction and the checks after it. */
  readonly pendingDebt: number;
  readonly pendingReview: number;
  readonly uncorroboratedClaims: number;
}

export interface MaterializedLayer {
  /** True once a completed cycle has run the model phases over this brain. */
  readonly dreamt: boolean;
  /** The most recent completed cycle's tier, or `null` if none has completed. */
  readonly tier: 'free' | 'paid' | null;
  /** When that cycle finished. The debt counter's anchor. */
  readonly at: string | null;
}

/**
 * What R18's backup reminder needs, gathered with everything else.
 *
 * **Why it rides this read rather than a schedule of its own.**
 * `src/core/export/schedule.ts` argues it at length: the reminder is bounded
 * *per caller*, and the caller-keyed bound only means anything on a read a
 * caller actually makes. The morning briefing is that read — the same one the
 * free→paid prompt rides, for the same reason and under the same discipline.
 *
 * **It costs one keyed row, one singleton row and one fenced count**, which is
 * the class the header permits: an aggregate over an indexed predicate that
 * returns no rows. It is the same shape as `pendingDebt`, over the same table.
 */
export interface SelfExportFacts {
  readonly destinationConfigured: boolean;
  readonly lastExportAt: string | null;
  /** A run that was attempted and failed, so silence is not read as "not set up". */
  readonly lastFailure: string | null;
  readonly oldestContentAt: string | null;
  /** Fenced by the grant, like every other count in the bundle. */
  readonly pages: number;
  readonly nag: NagState;
}

export interface BriefingSource {
  readonly cursor: { readonly lastReadAt: string | null; readonly prompt: PromptState };
  readonly selfExport: SelfExportFacts;
  readonly meetings: readonly BriefingMeeting[];
  readonly commitments: readonly BriefingCommitment[];
  readonly changed: readonly BriefingRecord[];
  readonly stated: readonly BriefingRecord[];
  readonly stale: readonly BriefingStale[];
  readonly counts: BriefingCounts;
  readonly layer: MaterializedLayer;
}

export interface BriefingOptions {
  /**
   * The window the caller asked for, or `null` when they asked for none.
   *
   * Nullable rather than pre-defaulted, and that is the whole fix: "the caller
   * named a window" and "the caller named a window that happens to equal the
   * default" have to be distinguishable, because the first one beats the
   * bookmark and leaves it where it was. A resolved string plus a parallel
   * `explicit` flag would be the same information in a shape where the two can
   * disagree.
   */
  readonly since: string | null;
  readonly until: string;
  readonly focus: string | null;
  /** The grant id `mcp/dispatch.ts` derived. Never a request parameter. */
  readonly callerKey: string;
  readonly now: Date;
  readonly budgetTokens: number;
}

/** How far back a briefing looks when the caller does not say. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The window every non-delta lane runs on: what the caller asked for, or the
 * default day ending at `now`.
 *
 * One function because three lanes read it and the reported `window` is a fourth
 * — a default applied at one of those and not the others is a bundle whose
 * header disagrees with its body.
 */
export function briefingWindow(options: BriefingOptions): { readonly since: string; readonly until: string } {
  return {
    since:
      options.since ?? new Date(options.now.getTime() - DEFAULT_WINDOW_MS).toISOString(),
    until: options.until,
  };
}

/** Where the delta starts, and which of the two rules put it there. */
export interface DeltaBasis {
  readonly since: string;
  readonly basis: 'cursor' | 'window';
}

/**
 * The one place the delta's start is decided.
 *
 * Called by both halves — the SQL half needs it to bound its statements and the
 * pure half needs it to report what it did — and a second copy is how a bundle
 * comes to say `since: X` over rows fetched from `Y`.
 */
export function deltaBasisFor(options: BriefingOptions, lastReadAt: string | null): DeltaBasis {
  if (options.since !== null) return { since: options.since, basis: 'window' };
  return { since: lastReadAt ?? briefingWindow(options).since, basis: 'cursor' };
}

export interface Briefing {
  readonly coverage: 'materialized' | 'cold';
  readonly tier: 'free' | 'paid' | null;
  readonly window: { readonly since: string; readonly until: string };
  readonly focus: string | null;
  readonly meetings: readonly BriefingMeeting[];
  readonly commitments: readonly BriefingCommitment[];
  readonly delta: {
    readonly since: string;
    /** Which rule put the delta where it starts. Reported, never inferred. */
    readonly basis: 'cursor' | 'window';
    readonly firstRead: boolean;
    readonly changed: readonly BriefingRecord[];
    readonly stated: readonly BriefingRecord[];
  };
  readonly stale: readonly BriefingStale[];
  readonly counts: BriefingCounts;
  /** Empty on a materialised layer; R8's list on a cold one. */
  readonly notIncluded: readonly string[];
  readonly prompt: UpgradePrompt | null;
  /**
   * R18's backup reminder, or `null` — which is the ordinary answer.
   *
   * A second nullable advisory rather than a field on `prompt`: the two are
   * bounded independently and answer different questions, and folding them into
   * one slot would make a brain that owes both show one of them at random.
   */
  readonly backup: SelfExportNag | null;
  readonly tokens: number;
}

// ---------------------------------------------------------------------------
// The pure half. This is what the blocking tier grades.
// ---------------------------------------------------------------------------

/**
 * Turn what SQL found into the bundle.
 *
 * **Three decisions live here rather than in a statement**, because each is a
 * product rule and not a query:
 *
 *   1. *Participants are dropped on a cold layer.* Not "returned without a
 *      card": R8 says participant cards are not part of the free briefing, and a
 *      list of bare names would be the silently-thinner shape the requirement
 *      exists to forbid.
 *   2. *The delta window starts at the cursor, unless the caller named one.* A
 *      named window wins and banks nothing; an unnamed one reads the bookmark
 *      and moves it. On a first read there is no bookmark, so it falls back to
 *      the default window — the only reading under which a brand-new
 *      connection's first briefing is not empty.
 *   3. *The budget drops whole rows from the tail.* Never a truncated one: a
 *      half-quoted external message is a demarcated region with no closing
 *      marker once the surface wraps it, which is the one shape R2a's wrapper
 *      exists to make impossible.
 */
export function assembleBriefing(source: BriefingSource, options: BriefingOptions): Briefing {
  const materialized = source.layer.dreamt;
  const firstRead = source.cursor.lastReadAt === null;
  const delta = deltaBasisFor(options, source.cursor.lastReadAt);
  const window = briefingWindow(options);

  const meetings = source.meetings.map((meeting) => ({
    ...meeting,
    participants: materialized ? meeting.participants : [],
  }));

  const budget = Math.max(0, Math.trunc(options.budgetTokens));
  const changed: BriefingRecord[] = [];
  const stated: BriefingRecord[] = [];
  let spent = 0;
  for (const [into, records] of [
    [changed, source.changed],
    [stated, source.stated],
  ] as const) {
    for (const record of records) {
      const cost = estimateTokens(record.text) + estimateTokens(record.title ?? '');
      // The first row of each section is always admitted: a budget so small that
      // it empties the delta reports "nothing changed", which is a different
      // sentence from "this did not fit".
      if (spent + cost > budget && into.length > 0) break;
      spent += cost;
      into.push(record);
    }
  }

  return {
    coverage: materialized ? 'materialized' : 'cold',
    tier: source.layer.tier,
    window,
    focus: options.focus,
    meetings,
    commitments: materialized ? source.commitments : [],
    delta: { since: delta.since, basis: delta.basis, firstRead, changed, stated },
    stale: source.stale,
    counts: source.counts,
    notIncluded: materialized ? [] : BRIEFING_NOT_INCLUDED,
    prompt: upgradePrompt({
      tier: source.layer.tier,
      pendingDebt: source.counts.pendingDebt,
      pendingReview: source.counts.pendingReview,
      uncorroboratedClaims: source.counts.uncorroboratedClaims,
      state: source.cursor.prompt,
      now: options.now,
    }),
    // Bounded by its own module, on its own state, against the same clock. This
    // half is deliberately a call rather than a re-implementation: the band
    // ladder, the fortnight and the "nothing to back up is silence" rule are one
    // discipline, and a second copy here is how a reminder comes to fire on a
    // schedule the module it is named after would refuse.
    backup: selfExportNag({
      destinationConfigured: source.selfExport.destinationConfigured,
      lastExportAt: source.selfExport.lastExportAt,
      oldestContentAt: source.selfExport.oldestContentAt,
      pages: source.selfExport.pages,
      lastFailure: source.selfExport.lastFailure,
      state: source.selfExport.nag,
      now: options.now,
    }),
    tokens: spent,
  };
}

// ---------------------------------------------------------------------------
// The SQL half.
// ---------------------------------------------------------------------------

/**
 * When a meeting *is*, as opposed to when this brain heard about it.
 *
 * Rung 5's `page.occurred_at` is what every ingest path already computed and
 * none of them persisted. It is NULL on every row written before that rung and
 * on every source that asserts no event time, so the fallback is arrival — which
 * is precisely the behaviour those rows have today, and the reason adding the
 * column changed nothing that was already visible.
 *
 * **Spelled once.** Rung 5's index is declared on this exact expression; a lane
 * that wrote it any other way would fall back to a sequential scan over every
 * page the tenant owns, on the read that runs every morning.
 */
const OCCURRED_AT = 'coalesce(p.occurred_at, p.created_at)';

/**
 * Today's meetings — the one lane whose window is an event time.
 *
 * Exported, and it is the only statement in this file that is, because
 * `test/briefing/assemble.test.ts` runs `EXPLAIN` over it to prove the window
 * lands in the index condition rather than in a post-scan filter. A copy of the
 * query inside the test would drift the moment this one did.
 *
 * The **delta** lanes below deliberately stay on `created_at`: "what changed
 * since you last looked" is a question about arrival, and re-keying it onto
 * occurrence would hide a meeting minuted this morning for a call held in March.
 * Only this lane asks "what is happening now".
 *
 * It **selects** the occurrence as well as filtering on it, because the surface
 * has to be able to print the time it sorted by. It rendered arrival for one
 * rung, so a briefing ordered by when a call happens listed the moment a poller
 * heard about it — a bundle whose own reader cannot reproduce its order.
 */
export const MEETINGS_STATEMENT = `
    SELECT p.page_id::text AS page_id, p.title, p.source_type, p.origin_context, p.created_at,
           ${OCCURRED_AT} AS occurred_at,
           coalesce(substring(string_agg(c.content, ' ' ORDER BY c.ordinal) for 600), '') AS body
      FROM page p
      LEFT JOIN chunk c ON c.page_id = p.page_id AND c.deleted_at IS NULL AND c.quarantined_at IS NULL
        AND c.origin_context = ANY($1::text[])
     WHERE p.deleted_at IS NULL
       AND p.quarantined_at IS NULL
       AND p.stale_at IS NULL
       AND p.source_type = 'calendar'
       AND p.origin_context = ANY($1::text[])
       AND ${OCCURRED_AT} >= $2::timestamptz
       AND ${OCCURRED_AT} < $3::timestamptz
       AND ($4::text IS NULL OR p.title ILIKE '%' || $4 || '%' OR c.content ILIKE '%' || $4 || '%')
     GROUP BY p.page_id, p.title, p.source_type, p.origin_context, p.created_at
     ORDER BY ${OCCURRED_AT} DESC
     LIMIT ${SECTION_LIMIT}`;

interface PageRow {
  readonly page_id: string;
  readonly title: string | null;
  readonly source_type: string;
  readonly origin_context: string;
  readonly created_at: string;
  readonly body: string;
}

/** A meetings row: a page row plus the coalesced occurrence it sorted on. */
interface MeetingRow extends PageRow {
  readonly occurred_at: string | Date;
}

function isoOf(value: string | Date | null): string {
  if (value === null) return '';
  return typeof value === 'string' ? new Date(value).toISOString() : value.toISOString();
}

/** `null` for an absent or empty focus, so the predicate short-circuits. */
function focusOf(focus: string | null): string | null {
  if (focus === null) return null;
  const trimmed = focus.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Everything the bundle is built from, in seven bounded statements.
 *
 * Separate from {@link assembleBriefing} so the assembly is gradeable without a
 * database — see the header. Nothing here decides a product rule; it fetches.
 */
export async function collectBriefing(
  sql: SQL,
  grant: Grant,
  options: BriefingOptions,
): Promise<BriefingSource> {
  const grantLiteral = textArrayLiteral(grant);
  const focus = focusOf(options.focus);
  const window = briefingWindow(options);

  const cursorRows = (await sql.unsafe(
    `SELECT last_read_at, prompt_last_shown_at, prompt_last_debt
       FROM briefing_cursor WHERE caller_key = $1`,
    [options.callerKey],
  )) as Array<{
    last_read_at: string | Date | null;
    prompt_last_shown_at: string | Date | null;
    prompt_last_debt: number;
  }>;
  const cursorRow = cursorRows[0];
  const lastReadAt = cursorRow?.last_read_at == null ? null : isoOf(cursorRow.last_read_at);

  // The layer. One row, and it is the authority on whether the model tier has
  // ever completed — see the header on why this is not a card count.
  // **`finished_at IS NOT NULL` is a RETURN clock, not a completion clock, and
  // this row is the debt counter's anchor.** Rung 23 made every cycle close its
  // run on the way out — the fix that stopped one failed phase stranding a
  // sibling's checkpoint forever — so from that rung a `phase_failed` cycle has
  // a `finished_at` like any other. Read alone it made `layer.at` (documented as
  // "when that cycle finished") and `layer.tier` ("the most recent COMPLETED
  // cycle's tier") point at a cycle that completed nothing, which silently moved
  // the anchor every failure and re-tiered the layer off a run that did no model
  // work.
  //
  // The stop reason is what still says the cycle finished, so it is what this
  // filters on — the same predicate `src/web/coverage.ts` uses for the same
  // reason. `dreamt` is kept in the disjunct because a run that reached the model
  // tier did the work this row exists to report, whatever stopped it afterwards.
  const runRows = (await sql.unsafe(
    `SELECT tier, dreamt, finished_at
       FROM consolidation_run
      WHERE finished_at IS NOT NULL
        AND (stop_reason IN ('complete', 'free_tier') OR dreamt)
      ORDER BY finished_at DESC, run_id DESC
      LIMIT 1`,
    [],
  )) as Array<{ tier: 'free' | 'paid'; dreamt: boolean; finished_at: string | Date }>;
  const dreamtRows = (await sql.unsafe(
    `SELECT 1 FROM consolidation_run WHERE finished_at IS NOT NULL AND dreamt LIMIT 1`,
    [],
  )) as Array<unknown>;
  const run = runRows[0];
  const layer: MaterializedLayer = {
    dreamt: dreamtRows.length > 0,
    tier: run?.tier ?? null,
    at: run === undefined ? null : isoOf(run.finished_at),
  };

  const meetingRows = (await sql.unsafe(MEETINGS_STATEMENT, [
    grantLiteral,
    window.since,
    window.until,
    focus,
  ])) as MeetingRow[];

  const participants = await readParticipants(
    sql,
    grantLiteral,
    meetingRows.map((row) => row.page_id),
  );

  const commitmentRows = (await sql.unsafe(
    `SELECT commitment_id::text AS commitment_id, statement, owner_name, due_on,
            origin_contexts, compiled_truth
       FROM commitment
      WHERE deleted_at IS NULL
        AND state = 'open'
        AND origin_contexts <@ $1::text[]
        AND ($2::text IS NULL OR statement ILIKE '%' || $2 || '%' OR owner_name ILIKE '%' || $2 || '%')
      ORDER BY due_on NULLS LAST, commitment_id
      LIMIT ${SECTION_LIMIT}`,
    [grantLiteral, focus],
  )) as Array<{
    commitment_id: string;
    statement: string;
    owner_name: string | null;
    due_on: string | Date | null;
    origin_contexts: string[];
    compiled_truth: boolean;
  }>;

  // The delta: from this caller's bookmark when they asked for none, and from
  // the window they named when they did. One helper, shared with the assembly,
  // so the reported `since` and the fetched rows cannot disagree.
  const deltaSince = deltaBasisFor(options, lastReadAt).since;

  const changedRows = (await sql.unsafe(
    `SELECT p.page_id::text AS page_id, p.title, p.source_type, p.origin_context, p.created_at,
            coalesce(substring(string_agg(c.content, ' ' ORDER BY c.ordinal) for 400), '') AS body
       FROM page p
       LEFT JOIN chunk c ON c.page_id = p.page_id AND c.deleted_at IS NULL AND c.quarantined_at IS NULL
         AND c.origin_context = ANY($1::text[])
      WHERE p.deleted_at IS NULL
        AND p.quarantined_at IS NULL
        AND p.origin_context = ANY($1::text[])
        AND p.created_at >= $2::timestamptz
        AND p.created_at < $3::timestamptz
        AND ($4::text IS NULL OR p.title ILIKE '%' || $4 || '%' OR c.content ILIKE '%' || $4 || '%')
      GROUP BY p.page_id, p.title, p.source_type, p.origin_context, p.created_at
      ORDER BY p.created_at DESC
      LIMIT ${SECTION_LIMIT}`,
    [grantLiteral, deltaSince, window.until, focus],
  )) as PageRow[];

  const statedRows = (await sql.unsafe(
    `SELECT fact_id::text AS fact_id, statement, origin_contexts, created_at
       FROM fact
      WHERE deleted_at IS NULL
        AND quarantined_at IS NULL
        AND superseded_by IS NULL
        AND origin_contexts <@ $1::text[]
        AND created_at >= $2::timestamptz
        AND created_at < $3::timestamptz
        AND ($4::text IS NULL OR statement ILIKE '%' || $4 || '%')
      ORDER BY created_at DESC
      LIMIT ${SECTION_LIMIT}`,
    [grantLiteral, deltaSince, window.until, focus],
  )) as Array<{ fact_id: string; statement: string; origin_contexts: string[]; created_at: string | Date }>;

  // Stale *with relevance*: a cancelled meeting or a superseded document that
  // still matters. Ordered by salience so the flag is a short list of things
  // worth knowing are wrong rather than an inventory of everything that rotted.
  //
  // **It went stale inside the window, and that is not a detail.** This lane
  // took a window and ignored it: top 20 by salience at any age, so a briefing
  // asked for today re-flagged a document superseded in April every morning
  // forever, and the seven-day review and the daily read returned an identical
  // list. It also made the header's claim false in both directions — the sort
  // ran over every stale page the tenant owns, which is the corpus-scaling
  // fan-out this whole file is built to avoid. An item ages out of the briefing
  // once the window passes it; a wider `since` is what brings it back.
  const staleRows = (await sql.unsafe(
    `SELECT p.page_id::text AS page_id, p.title, p.stale_at, p.salience, p.origin_context
       FROM page p
      WHERE p.deleted_at IS NULL
        AND p.quarantined_at IS NULL
        AND p.stale_at IS NOT NULL
        AND p.stale_at >= $3::timestamptz
        AND p.stale_at < $4::timestamptz
        AND p.origin_context = ANY($1::text[])
        AND ($2::text IS NULL OR p.title ILIKE '%' || $2 || '%')
      ORDER BY p.salience DESC NULLS LAST, p.stale_at DESC
      LIMIT ${SECTION_LIMIT}`,
    [grantLiteral, focus, window.since, window.until],
  )) as Array<{
    page_id: string;
    title: string | null;
    stale_at: string | Date;
    salience: number | null;
    origin_context: string;
  }>;

  const counts = await readCounts(sql, grantLiteral, layer.at);

  // R18's three facts. Two keyed reads and one fenced count — see
  // `SelfExportFacts` for why they belong on this read and not on a schedule.
  const exportState = await readExportState(sql);
  const nagState = await readNagState(sql, options.callerKey);
  const contentAge = await readContentAge(sql, { origins: grant });

  return {
    cursor: {
      lastReadAt,
      prompt: {
        lastShownAt: cursorRow?.prompt_last_shown_at == null ? null : isoOf(cursorRow.prompt_last_shown_at),
        lastShownDebt: cursorRow?.prompt_last_debt ?? 0,
      },
    },
    selfExport: {
      // "Never chosen a destination" is the column, not an inference from a
      // missing export: a user who configured one and has never had a
      // successful run is in a different state and gets a different sentence.
      destinationConfigured: exportState.destinationKind !== null,
      lastExportAt: exportState.lastExportAt,
      lastFailure: exportState.lastFailure,
      oldestContentAt: contentAge.oldestContentAt,
      pages: contentAge.pages,
      nag: nagState,
    },
    meetings: meetingRows.map((row) => ({
      ...recordOfPage(row),
      occurredAt: isoOf(row.occurred_at),
      participants: participants.get(row.page_id) ?? [],
    })),
    commitments: commitmentRows.map((row) => ({
      id: row.commitment_id,
      statement: row.statement,
      owner: row.owner_name,
      dueOn: row.due_on === null ? null : isoOf(row.due_on).slice(0, 10),
      origins: row.origin_contexts,
      compiledTruth: row.compiled_truth,
    })),
    changed: changedRows.map(recordOfPage),
    stated: statedRows.map((row) => ({
      id: row.fact_id,
      kind: 'fact' as const,
      title: null,
      text: row.statement,
      origins: row.origin_contexts,
      sourceType: null,
      createdAt: isoOf(row.created_at),
    })),
    stale: staleRows.map((row) => ({
      id: row.page_id,
      title: row.title,
      staleAt: isoOf(row.stale_at),
      relevance: row.salience,
      origins: [row.origin_context],
    })),
    counts,
    layer,
  };
}

function recordOfPage(row: PageRow): BriefingRecord {
  return {
    id: row.page_id,
    kind: 'doc',
    title: row.title,
    text: row.body,
    origins: [row.origin_context],
    sourceType: row.source_type,
    createdAt: isoOf(row.created_at),
  };
}

/**
 * Who is on each meeting, and what U11 wrote about them.
 *
 * **Bounded by the meeting list, which is already capped.** The join is
 * (meetings) × (entity names), and it is the one place this file spends anything
 * per row of the corpus — except that entities are people, not documents, so it
 * grows with the brain's address book. Resolving mentions the way
 * `search/read.ts` does, by materialising every page and matching in TypeScript,
 * would be a full scan on the read that runs every morning.
 *
 * The card is a `LEFT JOIN` on purpose: a participant the model tier has not
 * reached yet is still a participant, and the caller decides what to do with a
 * null card. `assembleBriefing` drops the whole list on a cold layer.
 */
async function readParticipants(
  sql: SQL,
  grantLiteral: string,
  pageIds: readonly string[],
): Promise<Map<string, BriefingParticipant[]>> {
  const out = new Map<string, BriefingParticipant[]>();
  if (pageIds.length === 0) return out;

  const rows = (await sql.unsafe(
    `WITH meetings AS (SELECT unnest($2::bigint[]) AS page_id),
     names AS (
       SELECT e.entity_id, e.canonical_name, e.origin_contexts, n.name
         FROM entity e
         CROSS JOIN LATERAL (
           SELECT e.canonical_name AS name
           UNION ALL
           SELECT a.alias AS name FROM entity_alias a WHERE a.entity_id = e.entity_id
         ) n
        WHERE e.deleted_at IS NULL
          AND e.origin_contexts && $1::text[]
          AND length(btrim(n.name)) > 2
     )
     SELECT DISTINCT ON (m.page_id, nm.entity_id)
            m.page_id::text     AS page_id,
            nm.entity_id::text  AS entity_id,
            nm.canonical_name,
            nm.origin_contexts,
            card.summary
       FROM meetings m
       JOIN chunk c ON c.page_id = m.page_id
        AND c.deleted_at IS NULL AND c.quarantined_at IS NULL
        AND c.origin_context = ANY($1::text[])
       JOIN names nm ON c.content ILIKE '%' || nm.name || '%'
       LEFT JOIN entity_card card ON card.entity_id = nm.entity_id
        AND card.deleted_at IS NULL
        AND card.origin_contexts <@ $1::text[]
      ORDER BY m.page_id, nm.entity_id, nm.canonical_name`,
    [grantLiteral, textArrayLiteral(pageIds)],
  )) as Array<{
    page_id: string;
    entity_id: string;
    canonical_name: string;
    origin_contexts: string[];
    summary: string | null;
  }>;

  for (const row of rows) {
    const list = out.get(row.page_id) ?? [];
    list.push({
      entityId: row.entity_id,
      name: row.canonical_name,
      card: row.summary,
      origins: row.origin_contexts,
    });
    out.set(row.page_id, list);
  }
  return out;
}

/**
 * The four numbers, as four aggregates in one statement.
 *
 * **`pendingDebt` is R8's parenthetical, not the control plane's column of the
 * same name.** The control-plane counter accrues on MCP writes and is a
 * *scheduling* hint the worker decrements; a handler cannot reach it at all, and
 * it counts nothing a connector ingested. R8 defines the counter this prompt
 * reads as "items awaiting extraction and contradiction checks", which is a
 * tenant-local question: live ingested pages that arrived **after the last
 * completed cycle**. Anchoring on the cycle is what keeps it a range scan on the
 * partial index rather than an anti-join over every page ever written.
 *
 * **`contradictions` is a count and it goes nowhere near the prompt.** It is in
 * the bundle because a user wants to know; it is not in `PromptInput` because
 * the free tier cannot produce one (R8).
 *
 * **`uncorroborated` counts facts, and that is R8's rule applied a second
 * time.** The obvious reading is `commitment WHERE NOT compiled_truth` — and a
 * commitment is a model-phase artifact, so on the free tier that count is
 * permanently zero and R12a's "here is something you could corroborate" line
 * renders empty for exactly the tier the prompt exists to convert. That is the
 * contradiction-count mistake wearing different clothes. So the count is over
 * **facts whose origin union is entirely external** — which the deterministic
 * extractor produces on both tiers — using the same first-party surface list
 * `demarcation.ts` uses, rather than a second opinion about which origins an
 * outsider can write.
 */
async function readCounts(
  sql: SQL,
  grantLiteral: string,
  lastCycleAt: string | null,
): Promise<BriefingCounts> {
  const rows = (await sql.unsafe(
    `SELECT
       ((SELECT count(*) FROM contradiction_report
          WHERE status = 'open' AND origin_contexts <@ $1::text[])
        + (SELECT count(*) FROM review_queue
            WHERE state = 'open' AND kind = 'contradiction' AND origin_contexts <@ $1::text[]))::int
         AS contradictions,
       (SELECT count(*) FROM page
         WHERE derivation = 'ingested'
           AND deleted_at IS NULL AND quarantined_at IS NULL AND stale_at IS NULL
           AND origin_context = ANY($1::text[])
           AND created_at > coalesce($2::timestamptz, '-infinity'::timestamptz))::int
         AS pending_debt,
       (SELECT count(*) FROM review_queue
         WHERE state = 'open' AND kind <> 'contradiction' AND origin_contexts <@ $1::text[])::int
         AS pending_review,
       (SELECT count(*) FROM fact f
         WHERE f.deleted_at IS NULL AND f.quarantined_at IS NULL AND f.superseded_by IS NULL
           AND f.origin_contexts <@ $1::text[]
           AND NOT EXISTS (
             SELECT 1 FROM unnest(f.origin_contexts) AS o
              WHERE split_part(o, ':', 2) = ANY($3::text[])
           ))::int
         AS uncorroborated`,
    [grantLiteral, lastCycleAt, textArrayLiteral([...FIRST_PARTY_SURFACES])],
  )) as Array<{
    contradictions: number;
    pending_debt: number;
    pending_review: number;
    uncorroborated: number;
  }>;

  const row = rows[0] ?? { contradictions: 0, pending_debt: 0, pending_review: 0, uncorroborated: 0 };
  return {
    contradictions: row.contradictions,
    pendingDebt: row.pending_debt,
    pendingReview: row.pending_review,
    uncorroboratedClaims: row.uncorroborated,
  };
}

/**
 * Bank the read, and the prompt if one fired.
 *
 * **`GREATEST`, always.** Two clients behind one credential, or a retried
 * scheduled task carrying a stale clock, would otherwise rewind the cursor and
 * replay a week of deltas — which reads to the user as the brain having
 * forgotten that they already looked.
 *
 * The read mark is `least(until, now)`: a caller may ask for a window that ends
 * in the future, and banking that would skip everything written between now and
 * then, permanently.
 *
 * **A windowed read passes `null` and moves no bookmark.** It is the same
 * statement rather than a second one because the *prompt* columns still have to
 * bank: the bound on the upgrade notice is per credential, not per basis, and a
 * client that always names a window would otherwise see the prompt every
 * morning. `NULL` here means "leave `last_read_at` where it is" — which on a
 * first call inserts the row with no bookmark at all, so `firstRead` stays the
 * stored fact it claims to be.
 */
export async function advanceBriefingCursor(
  sql: SQL,
  options: BriefingOptions,
  prompt: UpgradePrompt | null,
  banks: boolean,
): Promise<void> {
  const requested = Date.parse(options.until);
  const mark = !banks
    ? null
    : new Date(
        Math.min(
          Number.isFinite(requested) ? requested : options.now.getTime(),
          options.now.getTime(),
        ),
      ).toISOString();

  await sql.unsafe(
    `INSERT INTO briefing_cursor (caller_key, last_read_at, prompt_last_shown_at, prompt_last_debt)
     VALUES ($1, $2::timestamptz, $3::timestamptz, $4)
     ON CONFLICT (caller_key) DO UPDATE
        SET last_read_at =
              CASE WHEN EXCLUDED.last_read_at IS NULL THEN briefing_cursor.last_read_at
                   ELSE GREATEST(COALESCE(briefing_cursor.last_read_at, to_timestamp(0)), EXCLUDED.last_read_at) END,
            prompt_last_shown_at =
              CASE WHEN EXCLUDED.prompt_last_shown_at IS NULL THEN briefing_cursor.prompt_last_shown_at
                   ELSE EXCLUDED.prompt_last_shown_at END,
            prompt_last_debt =
              CASE WHEN EXCLUDED.prompt_last_shown_at IS NULL THEN briefing_cursor.prompt_last_debt
                   ELSE EXCLUDED.prompt_last_debt END,
            updated_at = now()`,
    [
      options.callerKey,
      mark,
      prompt === null ? null : options.now.toISOString(),
      prompt === null ? 0 : bandOf(prompt.pendingDebt),
    ],
  );
}

/** Collect, assemble, bank. The whole read, in the order the header describes. */
export async function briefing(
  sql: SQL,
  grant: Grant,
  options: BriefingOptions,
): Promise<Briefing> {
  const source = await collectBriefing(sql, grant, options);
  const bundle = assembleBriefing(source, options);
  // The bundle's own basis decides, rather than a second reading of `options`:
  // whatever the delta was built from is what the bookmark answers to.
  await advanceBriefingCursor(sql, options, bundle.prompt, bundle.delta.basis === 'cursor');
  // **Banked whether or not the caller named a window**, for the reason the
  // upgrade prompt's bound is: a client that always names one would otherwise
  // see this every single morning, which is the daily nag the module's whole
  // design exists to refuse. It is banked only when one actually fired — a
  // write on a silent read would move the bound the silence was measured from.
  if (bundle.backup !== null) {
    await recordNagShown(sql, {
      callerKey: options.callerKey,
      band: bundle.backup.band,
      at: options.now,
    });
  }
  return bundle;
}
