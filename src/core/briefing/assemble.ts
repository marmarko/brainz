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
 * **`firstRead` is a stored fact, not an inference.** An empty delta and a
 * never-read cursor produce the same list, and they are opposite situations to a
 * reader.
 *
 * The split below — {@link collectBriefing} does the SQL, {@link assembleBriefing}
 * is pure — exists so the blocking tier can grade the assembly (participant-card
 * completeness, delta correctness) with zero model calls and no database, the
 * same way `pipeline.ts:composeRanking` is gradeable while the arms are not.
 */

import type { SQL } from 'bun';

import { FIRST_PARTY_SURFACES } from '../../mcp/demarcation.ts';
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
  readonly origins: readonly string[];
}

export interface BriefingMeeting extends BriefingRecord {
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

export interface BriefingSource {
  readonly cursor: { readonly lastReadAt: string | null; readonly prompt: PromptState };
  readonly meetings: readonly BriefingMeeting[];
  readonly commitments: readonly BriefingCommitment[];
  readonly changed: readonly BriefingRecord[];
  readonly stated: readonly BriefingRecord[];
  readonly stale: readonly BriefingStale[];
  readonly counts: BriefingCounts;
  readonly layer: MaterializedLayer;
}

export interface BriefingOptions {
  readonly since: string;
  readonly until: string;
  readonly focus: string | null;
  /** The grant id `mcp/dispatch.ts` derived. Never a request parameter. */
  readonly callerKey: string;
  readonly now: Date;
  readonly budgetTokens: number;
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
    readonly firstRead: boolean;
    readonly changed: readonly BriefingRecord[];
    readonly stated: readonly BriefingRecord[];
  };
  readonly stale: readonly BriefingStale[];
  readonly counts: BriefingCounts;
  /** Empty on a materialised layer; R8's list on a cold one. */
  readonly notIncluded: readonly string[];
  readonly prompt: UpgradePrompt | null;
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
 *   2. *The delta window starts at the cursor.* On a first read there is no
 *      cursor, so it starts at the requested window — which is the only reading
 *      under which a brand-new connection's first briefing is not empty.
 *   3. *The budget drops whole rows from the tail.* Never a truncated one: a
 *      half-quoted external message is a demarcated region with no closing
 *      marker once the surface wraps it, which is the one shape R2a's wrapper
 *      exists to make impossible.
 */
export function assembleBriefing(source: BriefingSource, options: BriefingOptions): Briefing {
  const materialized = source.layer.dreamt;
  const firstRead = source.cursor.lastReadAt === null;
  const deltaSince = source.cursor.lastReadAt ?? options.since;

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
    window: { since: options.since, until: options.until },
    focus: options.focus,
    meetings,
    commitments: materialized ? source.commitments : [],
    delta: { since: deltaSince, firstRead, changed, stated },
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
    tokens: spent,
  };
}

// ---------------------------------------------------------------------------
// The SQL half.
// ---------------------------------------------------------------------------

interface PageRow {
  readonly page_id: string;
  readonly title: string | null;
  readonly source_type: string;
  readonly origin_context: string;
  readonly created_at: string;
  readonly body: string;
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
  const runRows = (await sql.unsafe(
    `SELECT tier, dreamt, finished_at
       FROM consolidation_run
      WHERE finished_at IS NOT NULL
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

  const meetingRows = (await sql.unsafe(
    `SELECT p.page_id::text AS page_id, p.title, p.source_type, p.origin_context, p.created_at,
            coalesce(substring(string_agg(c.content, ' ' ORDER BY c.ordinal) for 600), '') AS body
       FROM page p
       LEFT JOIN chunk c ON c.page_id = p.page_id AND c.deleted_at IS NULL AND c.quarantined_at IS NULL
         AND c.origin_context = ANY($1::text[])
      WHERE p.deleted_at IS NULL
        AND p.quarantined_at IS NULL
        AND p.stale_at IS NULL
        AND p.source_type = 'calendar'
        AND p.origin_context = ANY($1::text[])
        AND p.created_at >= $2::timestamptz
        AND p.created_at < $3::timestamptz
        AND ($4::text IS NULL OR p.title ILIKE '%' || $4 || '%' OR c.content ILIKE '%' || $4 || '%')
      GROUP BY p.page_id, p.title, p.source_type, p.origin_context, p.created_at
      ORDER BY p.created_at DESC
      LIMIT ${SECTION_LIMIT}`,
    [grantLiteral, options.since, options.until, focus],
  )) as PageRow[];

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

  // The delta: from this caller's cursor, not from the window's opening. On a
  // first read there is no cursor and the window is the honest fallback.
  const deltaSince = lastReadAt ?? options.since;

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
    [grantLiteral, deltaSince, options.until, focus],
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
    [grantLiteral, deltaSince, options.until, focus],
  )) as Array<{ fact_id: string; statement: string; origin_contexts: string[]; created_at: string | Date }>;

  // Stale *with relevance*: a cancelled meeting or a superseded document that
  // still matters. Ordered by salience so the flag is a short list of things
  // worth knowing are wrong rather than an inventory of everything that rotted.
  const staleRows = (await sql.unsafe(
    `SELECT p.page_id::text AS page_id, p.title, p.stale_at, p.salience, p.origin_context
       FROM page p
      WHERE p.deleted_at IS NULL
        AND p.quarantined_at IS NULL
        AND p.stale_at IS NOT NULL
        AND p.origin_context = ANY($1::text[])
        AND ($2::text IS NULL OR p.title ILIKE '%' || $2 || '%')
      ORDER BY p.salience DESC NULLS LAST, p.stale_at DESC
      LIMIT ${SECTION_LIMIT}`,
    [grantLiteral, focus],
  )) as Array<{
    page_id: string;
    title: string | null;
    stale_at: string | Date;
    salience: number | null;
    origin_context: string;
  }>;

  const counts = await readCounts(sql, grantLiteral, layer.at);

  return {
    cursor: {
      lastReadAt,
      prompt: {
        lastShownAt: cursorRow?.prompt_last_shown_at == null ? null : isoOf(cursorRow.prompt_last_shown_at),
        lastShownDebt: cursorRow?.prompt_last_debt ?? 0,
      },
    },
    meetings: meetingRows.map((row) => ({
      ...recordOfPage(row),
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
 */
export async function advanceBriefingCursor(
  sql: SQL,
  options: BriefingOptions,
  prompt: UpgradePrompt | null,
): Promise<void> {
  const requested = Date.parse(options.until);
  const mark = new Date(
    Math.min(Number.isFinite(requested) ? requested : options.now.getTime(), options.now.getTime()),
  ).toISOString();

  await sql.unsafe(
    `INSERT INTO briefing_cursor (caller_key, last_read_at, prompt_last_shown_at, prompt_last_debt)
     VALUES ($1, $2::timestamptz, $3::timestamptz, $4)
     ON CONFLICT (caller_key) DO UPDATE
        SET last_read_at = GREATEST(COALESCE(briefing_cursor.last_read_at, to_timestamp(0)), EXCLUDED.last_read_at),
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
  await advanceBriefingCursor(sql, options, bundle.prompt);
  return bundle;
}
