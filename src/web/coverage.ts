/**
 * What a brain holds, as counts — the read behind `/dashboard?view=coverage`.
 *
 * ===========================================================================
 * THE GAP THIS CLOSES
 * ===========================================================================
 *
 * The dashboard rendered the plumbing and nothing else: plan, connect link,
 * connected accounts, a key form, a spend note. A user who connected three
 * accounts and waited a week had exactly one way to learn whether any of it
 * worked — ask the assistant something and judge the answer. That is why a
 * ten-hour ingest outage and a multi-day consolidation freeze were both found by
 * somebody reading SQL rather than by the person they were happening to.
 *
 * The connector panel could not have caught either, and the reason is worth
 * stating because it is the argument for opening a tenant database at all:
 * `control.connector_health` records *attempts*, and during the outage every
 * attempt completed — so the panel said `connected` and was right to. Arrivals
 * exist only in the tenant's own database. This is the reading of arrivals.
 *
 * ===========================================================================
 * THE PRIVACY LINE, WHICH IS THE SHARP PART, AND WHERE IT IS ENFORCED
 * ===========================================================================
 *
 * This is the first surface in the product that deliberately shows
 * content-derived information back to its owner. It is legitimate — it is their
 * brain, behind their session — but it means the rule has to be written where
 * the next person edits, and it is this:
 *
 *   **Counts, closed-vocabulary codes, and instants. No names, no titles, no
 *   statements — including the user's own.**
 *
 * `control.connector_health` states the same rule for failures ("a failure
 * reason is a code and a timestamp, not a subject line") and `src/mcp/panel.ts`
 * states it for the panel view. Four arguments carry it here:
 *
 *   1. **A title is the most dangerous string in the system.** `src/mcp/reads.ts`
 *      says why: a title is row content and a mail subject is attacker-authored.
 *      A page listing recent document titles renders strings a stranger chose.
 *   2. **This page's job is to be looked at.** It gets screenshotted into support
 *      threads, cast to a meeting-room display, left open on a desk. A count
 *      survives all three; a list of forty names does not — and it is the
 *      *aggregation* that does the damage, because any one name is in the user's
 *      mail anyway while this page would be the only artifact that renders their
 *      whole address book in one screenful.
 *   3. **The web session carries no grant.** Every content read in this system is
 *      fenced by origin: MCP reads carry a `Grant`, `fenceRow` is a subset rule.
 *      `app.ts` is explicit that a session is admission to *ledgers* — records of
 *      shape — precisely because a whole-brain unfenced listing is not something
 *      a cookie should reach. Counts and codes stay on the ledger side of that
 *      line. Names cross it, and would make this the product's first fence-free
 *      content read.
 *   4. **The useful half is a different product.** "Your brain knows 340 people"
 *      answers *is it working*. "Here are their names" answers *what does it know
 *      about Alice*, which is retrieval — it needs a fence, a grant and
 *      pagination that this page has none of. The assistant is that product.
 *
 * So every field on {@link CoverageView} is a number, an instant, or a string
 * from a set the schema declares in a CHECK. `origin_context` is the one string
 * that looks like content and is not: it is `<class>:<source>` — the U18 context
 * class and one of three schema-declared source labels — carrying no address, no
 * display name and no account key, and it is already on the connectors panel and
 * already what `/api/severance` demands as its own echo.
 *
 * A consequence, deliberately taken: the entity histogram is **not** broken down
 * per origin. A count of one is a name — "1 person, from work:mail, first arrival
 * 14:32" is a fingerprint — and a cross-tab is where cells go to one.
 *
 * **And the honest limit of that refusal, because an earlier draft of this
 * paragraph forbade what the page does.** Not building the cross-tab keeps the
 * cells from going to one on a brain with several sources. It does not, and
 * cannot, keep them from going to one on a brain with **one** source: there,
 * every whole-brain number this page prints — the histogram, the facts, the
 * entities, the edges — *is* that source's number, standing a few lines under
 * that source's label and its last-arrival instant. A reader recombines them by
 * reading down the page. No narrowing removes that, because the only narrowing
 * that would is rendering no derived numbers at all, which is the page.
 *
 * So the line this module actually holds is the one stated above — counts,
 * codes and instants, never a name — and not a stronger claim about what those
 * counts can be recombined into. What a single-source screenshot discloses is a
 * count per type attached to an origin label the reader already has on the
 * connectors panel: a shape, and the identity of nobody. That is a disclosure
 * worth naming here rather than one worth denying, because the alternative — a
 * page that withholds its derived numbers from exactly the users most likely to
 * have one source, who are the new ones this page was built for — trades the
 * whole purpose for an exposure the product does not have.
 *
 * ===========================================================================
 * WHY EACH NUMBER IS AFFORDABLE, WHICH IS NOT THE SAME AS "SMALL"
 * ===========================================================================
 *
 * This is a page load, not a report, and it runs against a database that may be
 * cold. Each statement below is named by the mechanism that actually bounds it,
 * and **"the predicate matches" and "an index answers it" are kept apart** —
 * they are different claims and only the second one is cheap. An earlier draft
 * of this list ran them together and made three of six statements sound like
 * index lookups when they are passes:
 *
 *   * per-origin documents  → a pass over the brain's **live pages**.
 *                             `page_live_by_origin` (v2:261) matches the
 *                             predicate exactly and its leading column is the
 *                             `GROUP BY` key, but every `FILTER` here reads
 *                             `derivation`, which the index does not carry — so
 *                             each live page is visited on the heap whichever
 *                             plan wins;
 *   * documents behind      → `page_ingested_live` (v3:533): predicate matched
 *                             exactly and `created_at` is the key, so this one
 *                             is a true range scan — and the only statement here
 *                             that gets cheaper the healthier the brain is;
 *   * the latest run        → primary-key backward scan, one row. **The two
 *                             scalars beside it are not.** `last_completed_at`
 *                             and `ever_dreamt` both filter `finished_at IS NOT
 *                             NULL`, and the table's only non-PK index
 *                             (`consolidation_run_open`, v3:129) is partial on
 *                             `finished_at IS NULL` — the complement, which
 *                             serves neither. They are scans, affordable because
 *                             the table holds one row per cycle, not because
 *                             anything indexes them;
 *   * facts                 → a pass over live facts. Two partial indexes cover
 *                             two of the three predicates each and neither
 *                             covers the third: `fact_live` (v2:411) has no
 *                             `superseded_by`, `fact_by_derivation` (v3:536) has
 *                             no `quarantined_at`, and the query names no
 *                             `derivation` to seek on. Every candidate is fetched
 *                             from the heap either way. This is the statement to
 *                             watch as `fact` grows;
 *   * entities by type      → a sequential scan of `entity`, which is the one
 *                             small table this page makes hot, and the number to
 *                             watch if it ever stops being small;
 *   * edges / contradictions / review → `entity_edge_by_object` (v2:701),
 *                             `contradiction_open` (v2:791), `review_queue_open`
 *                             (v3:416). These three are the index-answered ones:
 *                             each query matches its partial index's predicate
 *                             exactly and needs no column the index lacks.
 *
 * **What is deliberately not here.** `sourceStaleness` (`src/ingest/log.ts`) is
 * the richest per-source view in the system and it is a `GROUP BY` over the whole
 * of `ingest_log`, which has no indexes at all and holds one row per item — the
 * fastest-growing table in the tenant. Chunk-level embed backlog is worse and is
 * worst in the healthy case: proving zero pending means scanning every chunk,
 * and it is per embedding *seat*, so a count of `embedding IS NULL` reports the
 * entire brain as unembedded the day the active seat moves
 * (`src/schema/embedding-seat.ts`). Both need a schema rung before any page can
 * carry them. Embed failure already reaches the dashboard as a connector-health
 * code.
 *
 * A composite "brain score" is absent on purpose: it is a number with no attached
 * action. Every figure below either names an incident it would have made visible
 * or sits beside one that does.
 */

import type { SQL } from 'bun';

import { cycleFreshnessOf, type CycleFreshness } from '../control/cycle-staleness.ts';
import { admitEntityName, corpusEvidence } from '../core/write/entity-admission.ts';
import { extractFromStatement } from '../core/write/extract.ts';
import { impliedEdges } from '../core/write/links.ts';

/** How far back "recently" reaches. One number, so the page and the query agree. */
export const COVERAGE_WINDOW_DAYS = 7;

/**
 * The four closed vocabularies this page renders, restated from the schema
 * rather than imported.
 *
 * **Restated, because a web page reading a closed vocabulary should break at
 * compile time when the vocabulary changes** and the alternative — importing
 * `src/worker/consolidate/phases.ts` — pulls the cycle's module graph into a
 * page render. The schema is the source of truth for all four.
 *
 * **Declared as data rather than only as types, for the reason `PHASE_STOPS` is:
 * a union cannot be enumerated at runtime, and a restatement that cannot be
 * enumerated is one nothing can check.** Two of these four had already drifted
 * behind the schema by a member each while reading as though they were current —
 * `out_of_time` (rung 19) and `input_rejected` (rung 21) — and a stale
 * restatement is worse than an import, because it type-checks. The arrays below
 * are asserted equal to the database's own CHECKs, in both directions, by
 * `test/web/coverage-route.test.ts`, so the next widening fails a test here
 * instead of arriving as a value this page has no name for.
 */

/** `entity.entity_type`'s CHECK (`v2-knowledge-core.sql:537`). */
export const ENTITY_KINDS = [
  'person',
  'organization',
  'place',
  'project',
  'product',
  'event',
  'topic',
  'other',
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

/**
 * `edge_type`'s seeded registry (`v2-knowledge-core.sql`), restated here for
 * the reason every vocabulary in this file is: a page must not import the
 * schema, and a CHECK — here a foreign key to a seeded table — is what a test
 * asserts the restatement against, in both directions.
 *
 * Counts keyed on these are coverage-clean: the registry's own COMMENT reads
 * "no user content", so a histogram over it is codes and numbers, exactly like
 * the entity-type one above. It is emphatically NOT the per-origin cross-tab
 * this file refuses — that refusal is about cells going to one, and a
 * whole-brain histogram has no origin axis to cross.
 */
export const EDGE_KINDS = [
  'mentions',
  'mentioned_by',
  'works_at',
  'employs',
  'invested_in',
  'has_investor',
  'part_of',
  'has_part',
  'related_to',
] as const;

export type EdgeKind = (typeof EDGE_KINDS)[number];

/**
 * `consolidation_run.stop_reason`'s CHECK, as rung 19 left it
 * (`v19-cycle-resume.sql:50`, widening `v3-consolidation.sql:109`).
 */
export const CYCLE_STOP_REASONS = [
  'complete',
  'free_tier',
  'budget_exhausted',
  'phase_failed',
  'cancelled',
  'out_of_time',
] as const;

export type CycleStopReason = (typeof CYCLE_STOP_REASONS)[number];

/** `consolidation_run.stopped_phase`'s CHECK (`v20-stopped-phase.sql:71`). */
export const CYCLE_PHASE_NAMES = [
  'dedup',
  'link_reconcile',
  'staleness',
  'entity_merge',
  'salience',
  'cluster',
  'transcribe',
  'extract',
  'enrich',
  'synopsis',
  'contradiction',
  'salience_refine',
] as const;

export type CyclePhaseName = (typeof CYCLE_PHASE_NAMES)[number];

/**
 * `consolidation_run.stopped_phase_code`'s CHECK, as rung 21 left it
 * (`v21-unreadable-page.sql:132`, widening `v20-stopped-phase.sql:81`).
 */
export const CYCLE_PHASE_STOPS = [
  'budget_exhausted',
  'model_unavailable',
  'input_rejected',
  'bad_output',
  'payload_unavailable',
  'out_of_time',
] as const;

export type CyclePhaseStop = (typeof CYCLE_PHASE_STOPS)[number];

/**
 * One credential's contribution, and the only place on this page where a source
 * is named.
 *
 * `origin` is `<class>:<source>` and is structural rather than content — see the
 * header. `documents` counts **ingested** pages only: `page` also holds the
 * brain's own model-written summaries (`src/worker/consolidate/materialize.ts`
 * writes them with an `origin_context`), and counting those would report the
 * brain's own writing back to the user as mail that arrived from their mailbox.
 */
export interface CoverageSource {
  readonly origin: string;
  readonly documents: number;
  /** When the most recent document from this credential arrived. */
  readonly lastArrivedAt: string | null;
  /** How many arrived inside {@link COVERAGE_WINDOW_DAYS}. */
  readonly thisWeek: number;
}

/**
 * The last consolidation cycle, as the run record states it.
 *
 * **`finishedAt === null` does not mean "running now", and reading it that way
 * is what made this page lie about the one state it was built to expose.** A
 * cycle that stops short banks its reason and leaves the run open, so an open
 * run is any of: a cycle in flight, a cycle that stopped and said why, or a
 * cycle killed before it could write anything. `stopReason` is what separates
 * the second from the other two, and nothing here separates the first from the
 * third — so `pages.ts` reads the pair and says so rather than choosing.
 *
 * The half of "honest when the brain is thin" this carries is unchanged: a small
 * fact count under an unfinished cycle is a snapshot rather than a verdict, and
 * that is true whichever of the three the open run turns out to be.
 */
export interface CoverageCycle {
  readonly tier: 'free' | 'paid';
  readonly dreamt: boolean;
  readonly stopReason: CycleStopReason | null;
  readonly stoppedPhase: CyclePhaseName | null;
  readonly stoppedPhaseCode: CyclePhaseStop | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/**
 * What the brain holds. **Every field is a number, an instant, or a string from a
 * set the schema declares** — see this module's header for why that is the type's
 * job and not a habit.
 */
export interface CoverageView {
  readonly sources: readonly CoverageSource[];
  /** Live ingested pages, all origins. The sum of {@link sources}. */
  readonly documents: number;
  readonly documentsThisWeek: number;
  /** The most recent run, finished or not. `null` before the first cycle. */
  readonly latestCycle: CoverageCycle | null;
  /**
   * When a cycle last **completed** — the backlog's anchor, and the clock the
   * staleness reading is judged against.
   *
   * Decided by the run's own `stop_reason`, never by `finished_at` alone: from
   * rung 23 every returning cycle closes its run, so `finished_at` says a cycle
   * came back rather than that it finished. `readCoverage` carries the argument.
   */
  readonly lastCompletedAt: string | null;
  /**
   * Whether this brain is *finishing* its cycles.
   *
   * **The one field on this page that a returning-but-never-completing cycle
   * cannot make look healthy.** Every other clock — `last_cycle_at`,
   * `next_due_at`, the job's own `finished_at`, this run's `started_at` —
   * advanced normally through a multi-day freeze, because a cycle that stops
   * short still returns and a job that returns is `done`.
   */
  readonly cycleFreshness: CycleFreshness;
  /**
   * Documents that arrived after {@link lastCompletedAt}, or every document when
   * no cycle has ever completed — which is the truth in that state rather than a
   * missing value.
   */
  readonly documentsSinceLastCycle: number;
  /** Whether the model tier has ever completed. Decides the two counts below. */
  readonly everDreamt: boolean;
  /** Live, unquarantined, and **not superseded**. The label matches exactly. */
  readonly facts: number;
  readonly entities: number;
  readonly edges: number;
  readonly entityTypes: readonly { readonly type: EntityKind; readonly count: number }[];
  /** `null` — not `0` — when no model tier has run: absent rather than empty. */
  readonly openContradictions: number | null;
  readonly openReview: number | null;
  /**
   * Relationships by kind — the direct answer to "what does it know they are
   * connected to", without naming anybody.
   */
  readonly edgeKinds: readonly { readonly kind: string; readonly count: number }[];
  /**
   * How many entities carry a summary the brain wrote.
   *
   * The number that makes the entity count checkable: "53 people and companies"
   * says nothing about whether the brain has anything to say about them.
   */
  readonly entitiesWithCard: number;
  /**
   * What the admission fence would decline, over a bounded sample of the live
   * statements — and the sample size, printed beside it.
   *
   * A fence nobody can see is a brain that quietly stops knowing things. This
   * runs the same {@link admitEntityName} over the same kind of input the phase
   * does, so it cannot drift from the phase's behaviour; it is computed on read
   * and writes nothing.
   */
  readonly declinedNames: DeclinedNames;
  readonly windowDays: number;
}

export interface DeclinedNames {
  /** Distinct names refused across the sample. */
  readonly names: number;
  /** Which rules did the refusing, most-fired first. */
  readonly bySignal: readonly { readonly signal: string; readonly count: number }[];
  /** Live statements examined. */
  readonly sampled: number;
}

/**
 * Live statements the declined-names panel reads.
 *
 * Bounded because this is a page render rather than a phase, and printed on the
 * page because a number computed over a sample that the reader cannot see the
 * size of is not a number they can act on.
 */
const COVERAGE_DECLINE_SAMPLE = 1000;

/**
 * What the fence would decline across a set of statements.
 *
 * The endpoints are re-projected exactly as `reconcileAllEdges` projects them —
 * `extractFromStatement` then `impliedEdges` — rather than by matching capitals
 * directly, because it is the *endpoints* the phase would try to create, and
 * the difference between those two readings is most of the noise.
 */
function declineOf(statements: readonly string[]): DeclinedNames {
  const evidence = corpusEvidence(statements);
  const refused = new Map<string, readonly string[]>();
  for (const statement of statements) {
    const extracted = extractFromStatement(statement);
    if (extracted === null) continue;
    for (const implied of impliedEdges([extracted])) {
      for (const end of [implied.subject, implied.object]) {
        if (refused.has(end.name)) continue;
        const verdict = admitEntityName(end.name, evidence);
        if (verdict.verdict === 'refuse') refused.set(end.name, verdict.signals);
      }
    }
  }
  const counts = new Map<string, number>();
  for (const signals of refused.values()) {
    for (const signal of signals) counts.set(signal, (counts.get(signal) ?? 0) + 1);
  }
  return {
    names: refused.size,
    bySignal: [...counts]
      .map(([signal, count]) => ({ signal, count }))
      .sort((left, right) => right.count - left.count || left.signal.localeCompare(right.signal)),
    sampled: statements.length,
  };
}

/** Bun's SQL returns `timestamptz` as a `Date`; a `text` cast would return a string. */
function isoOf(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * The whole page, in five statements plus one conditional sixth.
 *
 * **Unfenced, and that is deliberate rather than an omission.** Every other
 * content read in this system takes a `Grant`. This one is admitted by
 * `tenantOf(session.accountId)` alone, for the reason the retractions listing is:
 * it is whole-brain by construction and it reads shape rather than rows. There is
 * no origin to fence *to* — the caller is the brain's owner, and the answer is a
 * count.
 *
 * **One connection, one clock.** The backlog anchor is read from the run record
 * in this same connection rather than from `control.tenant.last_cycle_at`: the
 * control-plane counter of that name accrues on MCP writes and counts nothing a
 * connector ingested, so the two are different quantities that would agree just
 * often enough to hide the bug.
 */
export async function readCoverage(sql: SQL, options: { readonly now: Date }): Promise<CoverageView> {
  const since = new Date(options.now.getTime() - COVERAGE_WINDOW_DAYS * 86_400_000).toISOString();

  // One scan of `page_live_by_origin`, three aggregates. The `FILTER` clauses are
  // what keep model-written summaries out of a documents count without a second
  // pass over the same rows.
  const sourceRows = (await sql.unsafe(
    `SELECT origin_context,
            count(*) FILTER (WHERE derivation = 'ingested')::int AS documents,
            max(created_at) FILTER (WHERE derivation = 'ingested') AS last_arrived_at,
            count(*) FILTER (WHERE derivation = 'ingested' AND created_at > $1::timestamptz)::int AS this_week
       FROM page
      WHERE deleted_at IS NULL AND quarantined_at IS NULL
      GROUP BY origin_context
      ORDER BY origin_context`,
    [since],
  )) as Array<{
    origin_context: string;
    documents: number;
    last_arrived_at: Date | string | null;
    this_week: number;
  }>;

  const sources: CoverageSource[] = sourceRows
    // An origin whose only live rows are the brain's own summaries has no
    // documents, and a source row reading "0 documents" for a credential that was
    // never connected would be a panel inventing a connection.
    .filter((row) => row.documents > 0)
    .map((row) => ({
      origin: row.origin_context,
      documents: row.documents,
      lastArrivedAt: isoOf(row.last_arrived_at),
      thisWeek: row.this_week,
    }));

  // The most recent run, open or finished. `run_id DESC` rather than
  // `finished_at DESC` on purpose: an open run has no `finished_at` to order by
  // and is exactly the row a user needs to see, because an unfinished cycle is
  // the state in which a small number below is a snapshot rather than a verdict.
  // Both columns of the stop are selected because the sentence branches on the
  // PAIR — an open run is not the same claim as a running one. See `CoverageCycle`.
  const cycleRows = (await sql.unsafe(
    `SELECT tier, dreamt, stop_reason, stopped_phase, stopped_phase_code, started_at, finished_at
       FROM consolidation_run
      ORDER BY run_id DESC
      LIMIT 1`,
    [],
  )) as Array<{
    tier: 'free' | 'paid';
    dreamt: boolean;
    stop_reason: CycleStopReason | null;
    stopped_phase: CyclePhaseName | null;
    stopped_phase_code: CyclePhaseStop | null;
    started_at: Date | string;
    finished_at: Date | string | null;
  }>;
  const cycleRow = cycleRows[0];
  const latestCycle: CoverageCycle | null =
    cycleRow === undefined
      ? null
      : {
          tier: cycleRow.tier,
          dreamt: cycleRow.dreamt,
          stopReason: cycleRow.stop_reason,
          stoppedPhase: cycleRow.stopped_phase,
          stoppedPhaseCode: cycleRow.stopped_phase_code,
          startedAt: isoOf(cycleRow.started_at) ?? '',
          finishedAt: isoOf(cycleRow.finished_at),
        };

  // The anchor and the two derived totals, in one round trip.
  //
  // `everDreamt` comes from the run record and never from a card count: an empty
  // card table says "cold" for a fully consolidated brain that happens to know
  // about nobody, which is the inference `briefing/assemble.ts` refuses for the
  // same reason.
  //
  // **`finished_at IS NOT NULL` is NOT the completion test, and rung 23 is why.**
  // It used to be equivalent: only `finishRun` wrote that column, and only two of
  // the six stop reasons reached it. Rung 23 closes the run on **every** exit —
  // a cycle that returns has finished its pass whatever stopped it, and leaving
  // the run open was what let one page's provider 500 skip extraction forever.
  // The consequence here is exact: from that rung on, `finished_at` is a RETURN
  // clock. Anchoring the backlog on it would reset "how much has piled up" to
  // roughly zero on every cycle of a permanently frozen brain — the same class of
  // mistake as reading `control.tenant.last_cycle_at`, one table over.
  //
  // So the predicate is the reason. `dreamt` is ORed in for the legacy rows the
  // schema still permits: a completed run written before `stop_reason` was always
  // set carries NULL there, and the `dreamt_runs_completed` CHECK guarantees
  // `dreamt` implies `complete`. No stopped cycle satisfies either arm.
  //
  // `cycling_since` is the first run's start: how long this brain has been
  // consolidating without ever finishing, which is the only clock that separates
  // "still chewing through its first import" from "has never once worked".
  const scalarRows = (await sql.unsafe(
    `SELECT
       (SELECT finished_at FROM consolidation_run
         WHERE finished_at IS NOT NULL
           AND (stop_reason IN ('complete', 'free_tier') OR dreamt)
         ORDER BY finished_at DESC, run_id DESC LIMIT 1) AS last_completed_at,
       (SELECT min(started_at) FROM consolidation_run) AS cycling_since,
       EXISTS (SELECT 1 FROM consolidation_run WHERE finished_at IS NOT NULL AND dreamt) AS ever_dreamt,
       (SELECT count(*) FROM fact
         WHERE deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL)::int AS facts,
       (SELECT count(*) FROM entity_edge WHERE deleted_at IS NULL)::int AS edges,
       -- **Joined to a live entity, because a card can outlive one.** Entities
       -- are tombstoned by \`UPDATE ... SET deleted_at\`, never DELETEd, so the
       -- \`ON DELETE CASCADE\` on this table's foreign key never fires; and
       -- nothing in \`src/\` ever re-points \`entity_card.entity_id\`, so a merge
       -- or an origin-widen leaves the card behind on the row it replaced.
       -- Counting those made this page report cards no surface can return:
       -- measured on a production brain, 84 live card rows of which 29 pointed
       -- at tombstoned entities. The page whose whole job is being honest about
       -- what the brain holds was the one over-reporting it.
       (SELECT count(*) FROM entity_card c
          JOIN entity e ON e.entity_id = c.entity_id AND e.deleted_at IS NULL
         WHERE c.deleted_at IS NULL)::int AS entities_with_card`,
    [],
  )) as Array<{
    last_completed_at: Date | string | null;
    cycling_since: Date | string | null;
    ever_dreamt: boolean;
    facts: number;
    edges: number;
    entities_with_card: number;
  }>;
  const scalars = scalarRows[0] ?? {
    last_completed_at: null,
    cycling_since: null,
    ever_dreamt: false,
    facts: 0,
    edges: 0,
    entities_with_card: 0,
  };
  const lastCompletedAt = isoOf(scalars.last_completed_at);

  // The staleness reading, from the completion clock and the newest run's own
  // claim. This page is the only surface in the system that can compute it: the
  // pair it needs lives in `consolidation_run`, in this database, and the fleet
  // health surface holds no tenant handle. See the report's own header.
  // Counts plus closed-vocabulary codes, in the shape the entity-type histogram
  // already ships. Whole-brain, with no origin axis: the cross-tab this file
  // refuses is refused because cells go to one, and this has no second axis.
  const edgeRows = (await sql.unsafe(
    `SELECT edge_type, count(*)::int AS n
       FROM entity_edge WHERE deleted_at IS NULL
      GROUP BY edge_type ORDER BY n DESC, edge_type`,
    [],
  )) as Array<{ edge_type: string; n: number }>;
  const edgeKinds = edgeRows.map((row) => ({ kind: row.edge_type, count: row.n }));

  // The fence, run on read over the newest statements. Newest rather than a
  // random sample: what an owner wants to know is whether the vocabulary is
  // still right for the mail arriving now.
  const declineRows = (await sql.unsafe(
    `SELECT statement FROM fact
      WHERE deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL
      ORDER BY fact_id DESC LIMIT $1`,
    [COVERAGE_DECLINE_SAMPLE],
  )) as Array<{ statement: string }>;
  const declinedNames = declineOf(declineRows.map((row) => row.statement));

  const cycleFreshness = cycleFreshnessOf({
    completion:
      latestCycle === null
        ? undefined
        : {
            lastCompleteCycleAt: lastCompletedAt === null ? null : new Date(lastCompletedAt),
            latestStopReason: latestCycle.stopReason,
          },
    cyclingSince: scalars.cycling_since === null ? null : new Date(isoOf(scalars.cycling_since) ?? 0),
    now: options.now,
  }).state;

  // `page_ingested_live`'s predicate, restated exactly — including `stale_at IS
  // NULL`, which is what makes this a range scan on that partial index rather
  // than an anti-join over every page ever written. `-infinity` is the honest
  // anchor for a brain that has never consolidated: everything is behind.
  const behindRows = (await sql.unsafe(
    `SELECT count(*)::int AS behind
       FROM page
      WHERE derivation = 'ingested'
        AND deleted_at IS NULL AND quarantined_at IS NULL AND stale_at IS NULL
        AND created_at > coalesce($1::timestamptz, '-infinity'::timestamptz)`,
    [lastCompletedAt],
  )) as Array<{ behind: number }>;

  const typeRows = (await sql.unsafe(
    `SELECT entity_type, count(*)::int AS n
       FROM entity
      WHERE deleted_at IS NULL
      GROUP BY entity_type
      ORDER BY n DESC, entity_type`,
    [],
  )) as Array<{ entity_type: EntityKind; n: number }>;
  const entityTypes = typeRows.map((row) => ({ type: row.entity_type, count: row.n }));

  // Asked only when the model tier has completed. A count that is structurally
  // zero for the tier the reader is on is a dead panel — it teaches them the
  // feature is broken rather than that it has not run.
  let openContradictions: number | null = null;
  let openReview: number | null = null;
  if (scalars.ever_dreamt) {
    const openRows = (await sql.unsafe(
      `SELECT
         (SELECT count(*) FROM contradiction_report WHERE status = 'open')::int AS contradictions,
         (SELECT count(*) FROM review_queue WHERE state = 'open')::int AS review`,
      [],
    )) as Array<{ contradictions: number; review: number }>;
    openContradictions = openRows[0]?.contradictions ?? 0;
    openReview = openRows[0]?.review ?? 0;
  }

  return {
    sources,
    documents: sources.reduce((total, source) => total + source.documents, 0),
    documentsThisWeek: sources.reduce((total, source) => total + source.thisWeek, 0),
    latestCycle,
    lastCompletedAt,
    cycleFreshness,
    documentsSinceLastCycle: behindRows[0]?.behind ?? 0,
    everDreamt: scalars.ever_dreamt,
    facts: scalars.facts,
    entities: entityTypes.reduce((total, bucket) => total + bucket.count, 0),
    edges: scalars.edges,
    edgeKinds,
    entitiesWithCard: scalars.entities_with_card,
    declinedNames,
    entityTypes,
    openContradictions,
    openReview,
    windowDays: COVERAGE_WINDOW_DAYS,
  };
}
