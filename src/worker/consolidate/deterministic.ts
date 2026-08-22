/**
 * The free half of the cycle. Six phases, no model call, and every one of them
 * a deletion or a supersession of something.
 *
 * That last property is why each function below returns counts rather than
 * `void`, and why every test of them asserts on what *survived* as well as on
 * what went: a pass that collapsed every fact and removed every edge improves
 * both defect measures to zero.
 *
 * **Two things are shared rather than re-implemented, and both were the
 * documented failure when they were not.**
 *
 *  - The **normalizer**. Dedup and entity merge both ask "is this the same
 *    thing", and `src/core/write/normalize.ts` is the answer on both the write
 *    and the read side. A SQL-side `lower(btrim(...))` would be a second
 *    normalizer, and `links.ts` names exactly that as the drift with no symptom:
 *    the surviving page spells a name the way a mail client does and the alias
 *    holds the way a keyboard does, so the comparison silently misses.
 *  - The **deterministic extractor**. Edges are a projection of live facts, and
 *    the projection is `extractFromStatement` + `impliedEdges`. Reconciliation
 *    therefore recomputes rather than remembers, which is what gives an edge
 *    attested by two pages the property of surviving one of them dropping it.
 *
 * **Every phase is interruptible, and none of them resumes.** The cycle runs
 * under a wall-clock ceiling it did not choose (`locks.ts`), so a phase that
 * cannot be stopped can only be *reaped* — mid-write, with nothing on the run
 * record to say what happened. Each function below therefore takes an
 * {@link AttemptBudget}, consults it between units of work, and returns a
 * {@link PhaseProgress} saying whether it finished. A phase that stopped starts
 * again from the top on the next attempt, and that is the design: see the phase
 * loop in `cycle.ts` for the measurement that makes redoing it affordable.
 *
 * **What a phase may yield to is a question about whether restarting costs
 * anything**, and it splits them two ways.
 *
 *   `dedup` and `entity_merge` are **monotone**: a collapsed fact gets a
 *   `superseded_by` and a merged entity gets a `deleted_at`, so both leave the
 *   set the next attempt reads. Restarting costs one whole-set read and finds
 *   strictly less to do, so these yield to the clock and converge by repetition
 *   — progress banked in the rows rather than in a checkpoint. `staleness` is
 *   monotone for the same reason: a page already marked is not selected again.
 *
 *   `link_reconcile` is **not**: the desired edge set has to be complete before
 *   anything is diffed against it, because an edge missing from a half-built
 *   set is an edge the diff deletes. It restarts identically however many
 *   attempts it is given, so it yields to a lost lease (`cancelled`) and never
 *   to the clock — stopping it on the clock would buy nothing and cost the
 *   whole pass.
 *
 * That is affordable only because none of these costs round trips per row, and
 * `link_reconcile` is the one that had to be *made* that way rather than being
 * born it. It is not the cheap phase this header used to call it: the 214ms it
 * was measured at was measured on a brain holding 160 facts, because extraction
 * had dead-lettered, so it said nothing about the 11,200-fact brain it was
 * quoted about. Counted instead of timed, it cost 8.42 round trips per live fact
 * — and being the phase that refuses the clock, overrunning is a reap rather
 * than a stop. See {@link reconcileAllEdges}.
 *
 * **Round trips, not rows, were the wall.** Salience issued `1 + 2N` sequential
 * statements — a per-page fact query and a per-page UPDATE — which is 11,217 on
 * that brain, and at a worker-to-database latency of 36ms that alone is fifteen
 * minutes. It now reads and writes in batches, which is the same work in ~2
 * statements per {@link SALIENCE_BATCH} pages. Clustering paid a whole
 * transaction (`BEGIN`, two `SET LOCAL`, `COMMIT`) per seed and one INSERT per
 * member; it now amortizes the transaction over a batch of seeds and writes each
 * cluster with its members in one statement. Reconciliation resolved both
 * endpoints of every implied edge one call at a time and diffed one edge per
 * statement; it now resolves the pass's whole name set together and diffs
 * set-wise.
 *
 * **Nothing here collapses across credentials.** R15 makes `origin_contexts`
 * immutable, so a row cannot absorb a second credential's attestation — and
 * R12a's corroboration is *defined* on there being two rows with two origins.
 * Every grouping key below therefore includes the origin set, and a same-name
 * collision across credentials is left standing on purpose.
 */

import type { SQL } from 'bun';

import { RECENCY_HALF_LIFE_DAYS, SOURCE_TYPE_PRIOR } from '../../core/search/boosts.ts';
import type { SourceType } from '../../core/search/types.ts';
import { corpusEvidence } from '../../core/write/entity-admission.ts';
import { extractFromStatement } from '../../core/write/extract.ts';
import {
  countRefusals,
  impliedEdges,
  resolveOrCreateEntities,
  type EntityType,
} from '../../core/write/links.ts';
import { normalize } from '../../core/write/normalize.ts';
import { numericArrayLiteral, textArrayLiteral } from '../../core/write/pg-values.ts';
import { ACTIVE_EMBEDDING_SEAT, seatColumnSql } from '../../schema/embedding-seat.ts';
import { candidatePoolFor, withVectorScan } from '../../schema/vector-query.ts';
import { unboundedAttempt, type AttemptBudget } from './deadline.ts';

/** What `live` means for a fact, matching `src/core/write/dedup.ts`. */
const LIVE_FACT = 'deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL';

/**
 * Whether the phase ran to the end.
 *
 * `done: true` is what lets the cycle bank a completion. `false` means the
 * attempt's clock ran out or its lease went, and the phase will be run again
 * from the beginning — there is no position to hand over, deliberately, because
 * a position is only worth banking if something reads it and nothing does. See
 * the phase loop in `cycle.ts`.
 */
export interface PhaseProgress {
  readonly done: boolean;
}

/** Finished. Written out so both shapes are visible at every return site. */
const FINISHED: PhaseProgress = Object.freeze({ done: true });

/** Stopped part-way. The next attempt starts this phase over. */
const RESTARTS: PhaseProgress = Object.freeze({ done: false });

/**
 * The floor for every keyset walk here.
 *
 * The columns walked are `GENERATED ALWAYS AS IDENTITY`, which start at 1, so
 * "before the first row" is expressible as a value rather than as a null — which
 * keeps every batch after the first and the batch before it the *same* statement
 * instead of two that can drift.
 */
const CURSOR_START = '0';

/** `xs` in runs of at most `size`, for the batched writes below. */
function chunked<T>(xs: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < xs.length; index += size) out.push(xs.slice(index, index + size));
  return out;
}

/**
 * A grouping key over a set of origins.
 *
 * `JSON.stringify` rather than a joined string, and the reason is not style: the
 * separator has to be one an origin cannot contain, and every printable choice
 * is one somebody can. A control character satisfies that and makes the file
 * unreadable to the tooling that scans `src/` as text -- the provider-boundary
 * and price-drift guards both do.
 */
function originKey(origins: readonly string[]): string {
  return JSON.stringify([...origins].sort());
}

// ---------------------------------------------------------------------------
// 1. Dedup.
// ---------------------------------------------------------------------------

export interface DedupResult {
  readonly collapsed: number;
  readonly groups: number;
}

/**
 * Collapse facts that state the same claim through the same credential.
 *
 * The write path already refuses most of these; what reaches here is the residue
 * its own docstring names — "a near-duplicate admitted under concurrency, which
 * consolidation collapses" — because `classifyStatement` reads a snapshot taken
 * a moment before the insert that follows it.
 *
 * **Superseded, not deleted.** The survivor is the earliest row, and the rest
 * point at it, so the collapse is auditable and reversible. Deleting would make
 * "these two were the same claim" a fact only this run ever knew.
 */
export async function collapseDuplicateFacts(
  sql: SQL,
  options: { readonly budget?: AttemptBudget } = {},
): Promise<DedupResult & PhaseProgress> {
  const budget = options.budget ?? unboundedAttempt();
  const rows = (await sql.unsafe(`
    SELECT fact_id::text AS fact_id, statement, origin_contexts
      FROM fact
     WHERE ${LIVE_FACT}
     ORDER BY fact_id
  `)) as Array<{ fact_id: string; statement: string; origin_contexts: string[] }>;

  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const key = JSON.stringify([normalize(row.statement), originKey(row.origin_contexts)]);
    const bucket = groups.get(key) ?? [];
    bucket.push(row.fact_id);
    groups.set(key, bucket);
  }

  let collapsed = 0;
  let collapsedGroups = 0;
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    collapsedGroups += 1;
    const [keeper, ...losers] = bucket;
    if (keeper === undefined) continue;
    for (const loser of losers) {
      await sql`
        UPDATE fact SET superseded_by = ${keeper}::bigint
         WHERE fact_id = ${loser}::bigint AND superseded_by IS NULL
      `;
      collapsed += 1;
    }
    // **`stop`, not `cancelled`, because this phase is monotone.** It has no
    // cursor, and the argument against yielding to the clock without one is that
    // the next attempt redoes the same prefix and stops in the same place. That
    // argument does not hold here: a collapsed fact carries a `superseded_by`
    // and is therefore not `LIVE_FACT`, so the read at the top of the next
    // attempt is *strictly smaller* and the groups already collapsed come back
    // as singletons the loop skips. The prefix shrinks. Progress is banked in
    // the rows rather than in a checkpoint, and the phase converges by
    // repetition — which is what makes stopping cleanly better than being
    // reaped somewhere inside the write below.
    if (budget.stop() !== null) {
      return { collapsed, groups: collapsedGroups, ...RESTARTS };
    }
  }

  return { collapsed, groups: collapsedGroups, ...FINISHED };
}

// ---------------------------------------------------------------------------
// 2. Link reconciliation.
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  readonly added: number;
  readonly removed: number;
  readonly kept: number;
  /** Names the admission fence declined to create on this pass. */
  readonly refused: number;
  /** Which rules did the declining, so the vocabulary is auditable from a log line. */
  readonly refusedBySignal: Readonly<Record<string, number>>;
}

const SYMMETRIC_EDGE_TYPES: ReadonlySet<string> = new Set(['related_to']);

function orient(subjectId: string, objectId: string, edgeType: string): [string, string] {
  if (!SYMMETRIC_EDGE_TYPES.has(edgeType)) return [subjectId, objectId];
  return BigInt(subjectId) <= BigInt(objectId) ? [subjectId, objectId] : [objectId, subjectId];
}

function edgeKey(subjectId: string, edgeType: string, objectId: string): string {
  const [subject, object] = orient(subjectId, objectId, edgeType);
  return `${subject}|${edgeType}|${object}`;
}

/** One edge the live facts assert, with the endpoints this pass settled on. */
interface DesiredEdge {
  readonly subjectId: string;
  readonly objectId: string;
  readonly edgeType: string;
  readonly confidence: number;
  readonly origins: readonly string[];
}

/**
 * Edges per statement in the diff below. Same trade as {@link SALIENCE_BATCH}:
 * large enough that the write is per pass rather than per edge, small enough
 * that one array literal stays a comfortable bind.
 */
export const RECONCILE_EDGE_BATCH = 500;

/**
 * Bring the whole edge set into agreement with the live facts.
 *
 * The write path's reconciler is *page-scoped* and therefore has to ask, for
 * every edge it wants to remove, whether some other live fact still implies it —
 * a bounded scan whose give-up answer is "keep". Consolidation has no such
 * problem: it computes the desired set from **every** live fact, so an edge
 * absent from that set is absent because nothing states it, and the question is
 * answered rather than sampled.
 *
 * The desired set is built first, on purpose. Resolving an entity can *widen*
 * its origins, which under R15's immutability means a successor row and a rewrite
 * of its live edges — so reading the live edges before that happens would diff
 * against rows that no longer exist.
 *
 * **This phase yields to a lost lease and never to the clock, and the reason has
 * changed.** It was "affordable because it is small: 214ms on a 5,608-page
 * brain" — a measurement taken on a brain holding 160 facts *because* extraction
 * had dead-lettered, and therefore evidence for nothing about the brain it was
 * quoted about. Counted rather than timed, the old shape cost **8.42 round trips
 * per live fact** cold and 4.01 warm: two `resolveOrCreateEntity` calls per
 * implied edge, each two to six statements, plus a probe loop per new slug, plus
 * one statement per diffed edge. On 11,200 facts that is ~94,000 sequential round
 * trips, and a 14-minute attempt at the incident fleet's 36ms latency buys about
 * 23,300 for the *whole* prefix. A phase that cannot stop on the clock does not
 * overrun politely — it is reaped, and a reap charges an attempt against a ladder
 * that dead-letters after five.
 *
 * So it was made cheap rather than stoppable, which is what salience's fix was
 * too. The names of every endpoint the pass needs are knowable before any of them
 * is resolved, so they are resolved as a set
 * (`write/links.ts:resolveOrCreateEntities`); the diff's removals and insertions
 * are set-based writes. What is left is a handful of statements per pass plus one
 * per {@link RECONCILE_EDGE_BATCH}. The per-fact term is gone **for a pass in
 * which no entity's origin set grows** — which is every steady-state pass, and
 * is not the pass where a second connector meets a corpus this brain already
 * knows. That pass widens, and `widenEntityOrigins` used to run unbatched there
 * — `5 + 2·degree` round trips per widened entity, charged per EDGE, the one
 * shape left that could overrun an attempt. It takes the whole set now, at seven
 * statements however large the set and however dense the graph: measured on both
 * trees, `30 → 86` statements as that corpus tripled before, `9 → 9` after
 * (`test/core/write/links.test.ts`). It is called out here rather than left
 * implicit because the measurement that reassured everyone about this pass was
 * taken on the one fixture that structurally cannot widen, so the term it missed
 * was the only one still growing — which is the property
 * `test/consolidate/convergence.test.ts` asserts, by doubling the corpus and
 * watching the statement count stand still.
 */
export async function reconcileAllEdges(
  sql: SQL,
  options: { readonly taxonomyVersion: number; readonly budget?: AttemptBudget },
): Promise<ReconcileResult & PhaseProgress> {
  const budget = options.budget ?? unboundedAttempt();
  const nothingDone = {
    added: 0,
    removed: 0,
    kept: 0,
    refused: 0,
    refusedBySignal: {},
    ...RESTARTS,
  };
  const facts = (await sql.unsafe(`
    SELECT statement, origin_contexts FROM fact WHERE ${LIVE_FACT} ORDER BY fact_id
  `)) as Array<{ statement: string; origin_contexts: string[] }>;

  // **No derivation predicate here, and it was measured rather than assumed.**
  // This pass reads model-written prose as well as parsed assertions, which is
  // what produced entities called `Here` and `Thursday` — and the one-line
  // remedy (`AND derivation = 'ingested'`) was counterfactualled against the
  // production corpus before being refused: it keeps only 0.537 of the distinct
  // endpoints and 0.460 of the projected edges, and among what it drops are the
  // owner's own name, a colleague's, and `Fair Isaac Corporation`. The
  // model-derived half carries real recall, so the fence below is the
  // instrument and the filter is not. Re-run the counterfactual before
  // re-litigating this.
  const evidence = corpusEvidence(facts.map((fact) => fact.statement));

  // The projection, computed entirely in memory. Every name the pass will need
  // is knowable here, which is what makes resolving them as a set possible at
  // all — and the endpoints are carried by normalize key rather than by entity
  // id because the ids do not exist yet.
  const endpoints: Array<{
    readonly name: string;
    readonly type: EntityType;
    readonly origins: readonly string[];
    readonly taxonomyVersion: number;
  }> = [];
  const projected: Array<{
    readonly subject: string;
    readonly object: string;
    readonly edgeType: string;
    readonly confidence: number;
  }> = [];

  for (const fact of facts) {
    // **The desired set has to be complete before anything is diffed against
    // it**, so this phase cannot bank a partial position: an edge missing from a
    // half-built desired set is an edge the diff below would *delete*. It
    // therefore yields to a lost lease and not to the clock — abandoning it on
    // the clock would make it the phase the cycle can never get past.
    if (budget.cancelled() !== null) return nothingDone;
    const extracted = extractFromStatement(fact.statement);
    if (extracted === null) continue;
    for (const implied of impliedEdges([extracted])) {
      for (const end of [implied.subject, implied.object]) {
        endpoints.push({
          name: end.name,
          type: end.type,
          origins: fact.origin_contexts,
          taxonomyVersion: options.taxonomyVersion,
        });
      }
      projected.push({
        subject: normalize(implied.subject.name),
        object: normalize(implied.object.name),
        edgeType: implied.edgeType,
        confidence: implied.confidence,
      });
    }
  }

  // Checked once more, unconditionally, because the loop above is skipped
  // entirely on a brain whose facts state no edges — and a dispossessed pass that
  // reached the diff with an empty desired set would tombstone every rule-derived
  // edge the brain has, with an unfenced write, on its way out.
  if (budget.cancelled() !== null) return nothingDone;

  const { entities, refused } = await resolveOrCreateEntities(sql, endpoints, { evidence });

  const desired = new Map<string, DesiredEdge>();
  for (const edge of projected) {
    const subject = entities.get(edge.subject);
    const object = entities.get(edge.object);
    // The refusal path. A name the fence declined has no row, so its edge is
    // not in the desired set — and cannot be *removed* from the live set
    // either, because an endpoint that already exists always resolves and is
    // therefore never gated. See `entity-admission.ts`.
    if (subject === undefined || object === undefined) continue;
    if (subject.entityId === object.entityId) continue;
    // **The origins come from the entity rows the pass settled on**, which is
    // also the repair of a bug the sequential shape carried: an endpoint widened
    // by a later fact left every edge derived from an earlier one pointing at the
    // predecessor this pass had already tombstoned.
    desired.set(edgeKey(subject.entityId, edge.edgeType, object.entityId), {
      subjectId: subject.entityId,
      objectId: object.entityId,
      edgeType: edge.edgeType,
      confidence: edge.confidence,
      origins: [...new Set([...subject.originContexts, ...object.originContexts])].sort(),
    });
  }

  // **Only edges this projection could itself have produced are candidates for
  // removal.** Whole-graph reconciliation is stronger than the write path's
  // page-scoped one, and without this predicate it is also indiscriminate: a
  // connector-derived edge (U9) or a model-proposed one is not implied by any
  // deterministic statement, so an unfiltered pass would delete it on the first
  // cycle after it was created. The column's default is `rule_derived` because
  // every edge that exists today came from exactly this projection.
  const live = (await sql`
    SELECT edge_id::text AS edge_id, subject_entity_id::text AS subject_entity_id,
           edge_type, object_entity_id::text AS object_entity_id
      FROM entity_edge WHERE deleted_at IS NULL AND derivation = 'rule_derived'
  `) as Array<{ edge_id: string; subject_entity_id: string; edge_type: string; object_entity_id: string }>;

  let kept = 0;
  const present = new Set<string>();
  const doomed: string[] = [];
  for (const edge of live) {
    const key = edgeKey(edge.subject_entity_id, edge.edge_type, edge.object_entity_id);
    if (desired.has(key)) {
      present.add(key);
      kept += 1;
      continue;
    }
    doomed.push(edge.edge_id);
  }

  let removed = 0;
  for (const chunk of chunked(doomed, RECONCILE_EDGE_BATCH)) {
    const gone = (await sql.unsafe(
      `UPDATE entity_edge SET deleted_at = now()
        WHERE edge_id = ANY($1::bigint[]) AND deleted_at IS NULL
       RETURNING edge_id`,
      [numericArrayLiteral(chunk)],
    )) as unknown[];
    removed += gone.length;
  }

  // Grouped by origin set so each statement binds one `text[]` literal rather
  // than a literal per row — and there are as many groups as the brain has
  // distinct credential unions, which is a property of the connectors somebody
  // installed rather than of how many facts they wrote.
  const groups = new Map<string, { origins: readonly string[]; edges: DesiredEdge[] }>();
  for (const [key, edge] of desired) {
    if (present.has(key)) continue;
    const group = groups.get(originKey(edge.origins)) ?? { origins: edge.origins, edges: [] };
    group.edges.push(edge);
    groups.set(originKey(edge.origins), group);
  }

  let added = 0;
  for (const { origins, edges } of groups.values()) {
    for (const chunk of chunked(edges, RECONCILE_EDGE_BATCH)) {
      const oriented = chunk.map((edge) => {
        const [subject, object] = orient(edge.subjectId, edge.objectId, edge.edgeType);
        return { subject, object, edgeType: edge.edgeType, confidence: edge.confidence };
      });
      // `WHERE NOT EXISTS` rather than `ON CONFLICT`, unchanged: the unique index
      // it races is partial over live rows, and the row already there may be one
      // this pass just tombstoned. What each surviving row costs is a `kept`
      // rather than an `added`, which is why the count comes from `RETURNING`.
      const inserted = (await sql.unsafe(
        `INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts, confidence)
         SELECT u.subject, u.edge_type, u.object, $5::text[], u.confidence
           FROM unnest($1::bigint[], $2::text[], $3::bigint[], $4::float8[])
                AS u(subject, edge_type, object, confidence)
          WHERE NOT EXISTS (
            SELECT 1 FROM entity_edge e
             WHERE e.deleted_at IS NULL
               AND e.subject_entity_id = u.subject
               AND e.edge_type = u.edge_type
               AND e.object_entity_id = u.object
          )
         RETURNING edge_id`,
        [
          numericArrayLiteral(oriented.map((edge) => edge.subject)),
          textArrayLiteral(oriented.map((edge) => edge.edgeType)),
          numericArrayLiteral(oriented.map((edge) => edge.object)),
          numericArrayLiteral(oriented.map((edge) => edge.confidence)),
          textArrayLiteral([...origins]),
        ],
      )) as unknown[];
      added += inserted.length;
      kept += chunk.length - inserted.length;
    }
  }

  return { added, removed, kept, ...countRefusals(refused), ...FINISHED };
}

// ---------------------------------------------------------------------------
// 3. Staleness.
// ---------------------------------------------------------------------------

export interface StalenessResult {
  readonly staled: number;
  readonly factsInvalidated: number;
}

/** Superseded pages per staleness batch. Bounds the walk, not the corpus. */
export const STALENESS_BATCH = 500;

/**
 * Mark superseded versions of an upstream item, and retire the claims they made.
 *
 * Gap #18: "a cancelled meeting persists in the briefing; U11 then reports stale
 * rows as genuine contradictions". Both halves of that sentence are why this
 * runs *before* the contradiction phase — a value conflict between an item and
 * its own replacement is not a conflict, it is an edit, and reporting it would
 * manufacture exactly the fabrication R8's upgrade prompt is built on.
 *
 * **A fact is retired only when something replaced it.** The replacement is
 * found through the extractor's own supersession key — same subject, same topic
 * — which is the key the write path uses, so the two agree by construction. A
 * claim on a stale page that nothing replaced is left live: it is the last thing
 * anybody said on the subject, and deleting it would be consolidation losing
 * knowledge on the strength of a filename.
 */
export async function markStaleness(
  sql: SQL,
  options: {
    readonly now: Date;
    readonly budget?: AttemptBudget;
    readonly batch?: number;
  },
): Promise<StalenessResult & PhaseProgress> {
  const budget = options.budget ?? unboundedAttempt();
  const batch = Math.max(1, Math.trunc(options.batch ?? STALENESS_BATCH));
  let cursor = CURSOR_START;
  let staled = 0;
  let factsInvalidated = 0;

  for (;;) {
    // **`DISTINCT ON` is the difference between linear and quadratic.** The
    // join emits every `(older, newer)` pair, so K versions of one upstream item
    // produce K(K-1)/2 rows and the loop below paid a round trip to discover
    // that all but one of them named a page it had already marked. One row per
    // superseded page, and the `newer` it carries is the *newest* live version
    // rather than whichever the planner happened to emit first — which is also
    // the more correct choice for the replacement search that follows.
    const superseded = (await sql.unsafe(
      `SELECT DISTINCT ON (older.page_id)
              older.page_id::text AS stale_page_id, newer.page_id::text AS live_page_id
         FROM page older
         JOIN page newer
           ON newer.external_ref = older.external_ref
          AND newer.page_id <> older.page_id
          AND newer.deleted_at IS NULL AND newer.quarantined_at IS NULL AND newer.stale_at IS NULL
          AND (newer.created_at, newer.page_id) > (older.created_at, older.page_id)
        WHERE older.external_ref IS NOT NULL
          AND older.stale_at IS NULL
          AND older.deleted_at IS NULL
          AND older.derivation = 'ingested'
          AND older.page_id > $1::bigint
        ORDER BY older.page_id, newer.created_at DESC, newer.page_id DESC
        LIMIT ${batch}`,
      [cursor],
    )) as Array<{ stale_page_id: string; live_page_id: string }>;

    if (superseded.length === 0) return { staled, factsInvalidated, ...FINISHED };

    for (const pair of superseded) {
      const marked = (await sql`
        UPDATE page SET stale_at = ${options.now}, updated_at = ${options.now}
         WHERE page_id = ${pair.stale_page_id}::bigint AND stale_at IS NULL
        RETURNING page_id
      `) as unknown[];
      if (marked.length === 0) continue;
      staled += 1;

      const stale = (await sql.unsafe(
        `SELECT fact_id::text AS fact_id, statement FROM fact WHERE ${LIVE_FACT} AND page_id = $1::bigint`,
        [pair.stale_page_id],
      )) as Array<{ fact_id: string; statement: string }>;
      const replacements = (await sql.unsafe(
        `SELECT fact_id::text AS fact_id, statement FROM fact WHERE ${LIVE_FACT} AND page_id = $1::bigint`,
        [pair.live_page_id],
      )) as Array<{ fact_id: string; statement: string }>;

      const byKey = new Map<string, string>();
      for (const row of replacements) {
        const extracted = extractFromStatement(row.statement);
        if (extracted === null) continue;
        byKey.set(JSON.stringify([normalize(extracted.subject), extracted.topic]), row.fact_id);
      }

      for (const row of stale) {
        const extracted = extractFromStatement(row.statement);
        if (extracted === null) continue;
        const replacement = byKey.get(
          JSON.stringify([normalize(extracted.subject), extracted.topic]),
        );
        if (replacement === undefined || replacement === row.fact_id) continue;
        await sql`
          UPDATE fact SET superseded_by = ${replacement}::bigint
           WHERE fact_id = ${row.fact_id}::bigint AND superseded_by IS NULL
        `;
        factsInvalidated += 1;
      }
    }

    cursor = superseded[superseded.length - 1]?.stale_page_id ?? cursor;
    if (superseded.length < batch) return { staled, factsInvalidated, ...FINISHED };
    // Monotone, so stopping here is safe without a position: every page this
    // pass marked now has a `stale_at` and drops out of the query above, so the
    // next attempt's walk starts at the beginning over strictly fewer rows.
    if (budget.stop() !== null) return { staled, factsInvalidated, ...RESTARTS };
  }
}

// ---------------------------------------------------------------------------
// 4. Rule-based entity merge.
// ---------------------------------------------------------------------------

export interface MergeResult {
  readonly merged: number;
  /** Merge proposals newly enqueued for the owner to decide. */
  readonly proposed: number;
}

/**
 * Corporate designators, stripped to compare what a name is *of*.
 *
 * `Google Inc` and `Google LLC` are two normalize keys, two slugs, two entities
 * and — because {@link mergeEntitiesByRule} buckets on the key itself — two
 * entities forever. No rule will ever collapse them, so the only honest move is
 * to say so and let the owner decide.
 */
const CORPORATE_DESIGNATORS: ReadonlySet<string> = new Set([
  'inc', 'inc.', 'llc', 'llp', 'ltd', 'ltd.', 'limited', 'corp', 'corp.',
  'corporation', 'co', 'co.', 'company', 'plc', 'gmbh', 'ag', 'sa', 's.a.',
  'nv', 'bv', 'ab', 'oy', 'pty', 'group', 'holdings', 'bank', 'bancorp',
  'sarl', 'kk',
]);

/** Confidence a designator-stripped identity is proposed at. R12's review band. */
const MERGE_PROPOSAL_CONFIDENCE = 0.75;

/**
 * How many merge proposals one cycle may add.
 *
 * Deliberately far below `REVIEW_CEILING`, which is what the review listing
 * shows. This is the one review kind with **no apply path** — the queue renders
 * it with a sentence saying so instead of a button — so a proposer allowed to
 * fill the page would push every `entity_card` proposal, the only kind that can
 * actually be applied, off it.
 */
const ENTITY_MERGE_PROPOSAL_CEILING = 12;

/**
 * Two live entities that are the same thing under different corporate
 * designators, offered to the owner as a decision.
 *
 * **One rule, and the reason it is one.** `core(name)` is the normalize key with
 * trailing {@link CORPORATE_DESIGNATORS} removed; two live rows sharing a
 * non-empty core of at least two characters, with **equal `entity_type`** and
 * differing full keys, get a proposal. On the production brain that is exactly
 * two: `Google Inc`/`Google LLC` and `JPMorgan Chase`/`JPMorgan Chase Bank`. It
 * emits nothing for `Morgan Stanley`/`Morgan Wealth Management`, `Google
 * Inc`/`Google Play`, `JPMorgan Chase`/`Chase Payment Solutions` or
 * `Every`/`Everyone`.
 *
 * **A prefix-containment rule was specified and rejected.** It emits only the
 * four Anthem pairs, every one of them cross-type — `Anthem` is a `person`,
 * `Anthem HP` an `organization` — which {@link mergeEntitiesByRule}'s bucket key
 * can never collapse, so with no apply path the owner's only possible action
 * would be dismissal. It also decomposes one six-row clustering decision into
 * four pairwise ones while giving two of the rows no proposal at all. That is a
 * decision for a human looking at a roster, not four queue rows. The same-type
 * predicate is why `X`/`X Corp` emits nothing either.
 *
 * **Read, diff, insert — rather than `enqueueReview` per candidate.**
 * `enqueueReview` ends `if (id === undefined) throw`, so a `WHERE NOT EXISTS`
 * insert that correctly writes nothing — which is every cycle after the first —
 * would *throw*, and the phase loop has no `catch`: it would escape the cycle,
 * leave the run open, and charge an attempt against a ladder that dead-letters
 * after five. It would also scan: `review_queue`'s only index is partial on
 * `state='open'`, and this diff has to consider dismissed rows too or every
 * dismissal comes straight back.
 *
 * **The idempotence key is the sorted pair of canonical names, never entity
 * ids.** `widenEntityOrigins` mints a *new* `entity_id` and tombstones the
 * predecessor whenever a second connector meets a corpus the brain already
 * knows, so an id-keyed proposal would re-enqueue everything the owner had
 * already dismissed, under a new keeper.
 */
export async function proposeEntityMerges(sql: SQL, runId: string | null): Promise<number> {
  const rows = (await sql`
    SELECT entity_id::text AS entity_id, canonical_name, entity_type, origin_contexts
      FROM entity WHERE deleted_at IS NULL ORDER BY entity_id
  `) as Array<{
    entity_id: string;
    canonical_name: string;
    entity_type: string;
    origin_contexts: string[];
  }>;

  const byCore = new Map<string, typeof rows>();
  for (const row of rows) {
    const core = designatorStrippedCore(row.canonical_name);
    if (core.length < 2) continue;
    const bucket = byCore.get(`${core}|${row.entity_type}`) ?? [];
    bucket.push(row);
    byCore.set(`${core}|${row.entity_type}`, bucket);
  }

  const candidates: Array<{ key: string; left: (typeof rows)[number]; right: (typeof rows)[number] }> =
    [];
  for (const bucket of byCore.values()) {
    if (bucket.length < 2) continue;
    const distinct = [...new Map(bucket.map((row) => [normalize(row.canonical_name), row])).values()];
    if (distinct.length < 2) continue;
    // Sorted by name so the pair key is stable whichever order the rows came in.
    const ordered = [...distinct].sort((a, b) =>
      normalize(a.canonical_name).localeCompare(normalize(b.canonical_name)),
    );
    for (let i = 0; i < ordered.length - 1; i += 1) {
      const left = ordered[i];
      const right = ordered[i + 1];
      if (left === undefined || right === undefined) continue;
      candidates.push({
        key: mergeProposalKey(left.canonical_name, right.canonical_name),
        left,
        right,
      });
    }
  }
  if (candidates.length === 0) return 0;

  // Every state, because a dismissed proposal must stay dismissed.
  const existing = (await sql`
    SELECT proposal FROM review_queue WHERE kind = 'entity_merge'
  `) as Array<{ proposal: string }>;
  const seen = new Set(existing.map((row) => proposalKeyOf(row.proposal)));

  const fresh = candidates
    .filter((candidate) => !seen.has(candidate.key))
    .slice(0, ENTITY_MERGE_PROPOSAL_CEILING);
  if (fresh.length === 0) return 0;

  await sql.unsafe(
    `INSERT INTO review_queue (kind, target_ref, proposal, confidence, run_id, origin_contexts)
     SELECT 'entity_merge', u.target_ref, u.proposal, $4::numeric, $5::bigint, u.origins::text[]
       FROM unnest($1::text[], $2::text[], $3::text[]) AS u(target_ref, proposal, origins)`,
    [
      textArrayLiteral(
        fresh.map(
          (candidate) =>
            `entity:${
              BigInt(candidate.left.entity_id) <= BigInt(candidate.right.entity_id)
                ? candidate.left.entity_id
                : candidate.right.entity_id
            }`,
        ),
      ),
      textArrayLiteral(fresh.map((candidate) => mergeProposalText(candidate.key))),
      textArrayLiteral(
        fresh.map((candidate) =>
          textArrayLiteral(
            [...new Set([...candidate.left.origin_contexts, ...candidate.right.origin_contexts])].sort(),
          ),
        ),
      ),
      MERGE_PROPOSAL_CONFIDENCE,
      runId,
    ],
  );
  return fresh.length;
}

/** The normalize key with trailing corporate designators taken off it. */
function designatorStrippedCore(name: string): string {
  const parts = normalize(name).split(' ').filter((part) => part.length > 0);
  while (parts.length > 1 && CORPORATE_DESIGNATORS.has(parts[parts.length - 1] ?? '')) parts.pop();
  return parts.join(' ');
}

/** The two names, sorted, which is the identity a proposal is deduplicated on. */
export function mergeProposalKey(left: string, right: string): string {
  return [left, right].sort((a, b) => normalize(a).localeCompare(normalize(b))).join(' \u2194 ');
}

/**
 * The sentence the owner reads.
 *
 * The key is embedded verbatim so {@link proposalKeyOf} can read it back without
 * a column: `review_queue` has no idempotence key of its own and adding one is a
 * schema rung, which this does not need.
 */
function mergeProposalText(key: string): string {
  return `These look like the same thing under two names: ${key}. Merging them is not something your brain will do on its own \u2014 the two rows have different names, so no rule will ever collapse them.`;
}

/**
 * The two names back out of a stored proposal sentence.
 *
 * Exported because the review surface has to act on this proposal and the pair
 * lives in the PROSE rather than in a column — which is deliberate, and the
 * reason is one rung up: an id-keyed proposal would re-enqueue everything the
 * owner had already dismissed, under a new keeper, after any widen. So the
 * apply path re-derives the pair the same way, from the same text, using the
 * same function that wrote it.
 */
export function mergeProposalPair(proposal: string): readonly [string, string] | null {
  const key = proposalKeyOf(proposal);
  const halves = key.split(' \u2194 ');
  if (halves.length !== 2) return null;
  const [left, right] = halves;
  if (left === undefined || right === undefined) return null;
  if (left.trim().length === 0 || right.trim().length === 0) return null;
  return [left.trim(), right.trim()];
}

/** The pair key back out of a stored proposal sentence. */
export function proposalKeyOf(proposal: string): string {
  const match = /two names: (.+?)\. Merging/u.exec(proposal);
  return match?.[1] ?? proposal;
}

/**
 * Merge entities that are the same name under the same credentials.
 *
 * **Rule-based means the confidence is 1 and the gate is not consulted.** Two
 * rows whose normalized canonical names are byte-identical and whose origin sets
 * are identical are one entity that got written twice; there is no judgement in
 * it. Anything softer — a nickname, a shared surname, an email local-part — is
 * the model tier's, and it goes through the confidence gate like everything else
 * the model proposes.
 *
 * The loser's slug survives as a **redirect** rather than being dropped, which
 * is the whole reason `entity_slug` holds both kinds in one namespace: an address
 * that used to resolve keeps resolving.
 */
export async function mergeEntitiesByRule(
  sql: SQL,
  options: { readonly budget?: AttemptBudget; readonly runId?: string | null } = {},
): Promise<MergeResult & PhaseProgress> {
  const budget = options.budget ?? unboundedAttempt();

  // **Proposals first, off their own read, before the merge loop.** Not at the
  // end: the loop below returns from inside itself whenever `budget.stop()`
  // fires, so a trailing proposer would never run on exactly the cycles a large
  // brain is having. And not off the loop's read either, because by then this
  // call may have tombstoned a row the proposal would name.
  const proposed = await proposeEntityMerges(sql, options.runId ?? null);

  const rows = (await sql`
    SELECT entity_id::text AS entity_id, canonical_name, entity_type, origin_contexts
      FROM entity WHERE deleted_at IS NULL ORDER BY entity_id
  `) as Array<{ entity_id: string; canonical_name: string; entity_type: string; origin_contexts: string[] }>;

  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const key = JSON.stringify([
      normalize(row.canonical_name),
      row.entity_type,
      originKey(row.origin_contexts),
    ]);
    const bucket = groups.get(key) ?? [];
    bucket.push(row.entity_id);
    groups.set(key, bucket);
  }

  let merged = 0;
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    const [keeper, ...losers] = bucket;
    if (keeper === undefined) continue;

    for (const loser of losers) {
      // Aliases first: recall vocabulary is additive and the unique key is
      // (entity, alias), so a name both rows knew is not a conflict.
      // `origin_contexts` travels with the spelling. A merge moves a name from
      // one row to another; it does not change where the name came from, and a
      // copy that dropped the provenance would arrive at the keeper unstamped —
      // which the card then judges against the keeper's whole union.
      await sql`
        INSERT INTO entity_alias (entity_id, alias, alias_source, confidence, origin_contexts)
        SELECT ${keeper}::bigint, alias, alias_source, confidence, origin_contexts
          FROM entity_alias WHERE entity_id = ${loser}::bigint
        ON CONFLICT (entity_id, alias) DO NOTHING
      `;
      await sql`DELETE FROM entity_alias WHERE entity_id = ${loser}::bigint`;

      // The address keeps resolving, as a redirect. `entity_has_one_canonical_slug`
      // is what makes this the only legal shape: the keeper already has one.
      await sql`
        UPDATE entity_slug SET entity_id = ${keeper}::bigint, kind = 'redirect'
         WHERE entity_id = ${loser}::bigint
      `;

      const edges = (await sql`
        SELECT edge_id::text AS edge_id, subject_entity_id::text AS subject_entity_id,
               edge_type, object_entity_id::text AS object_entity_id,
               origin_contexts, confidence
          FROM entity_edge
         WHERE deleted_at IS NULL
           AND (subject_entity_id = ${loser}::bigint OR object_entity_id = ${loser}::bigint)
      `) as Array<{
        edge_id: string;
        subject_entity_id: string;
        edge_type: string;
        object_entity_id: string;
        origin_contexts: string[];
        confidence: number | null;
      }>;

      for (const edge of edges) {
        // Tombstone first: `entity_edge_is_stated_once` is a partial unique index
        // over live rows, so the replacement cannot sit beside it.
        await sql`UPDATE entity_edge SET deleted_at = now() WHERE edge_id = ${edge.edge_id}::bigint`;
        const subject = edge.subject_entity_id === loser ? keeper : edge.subject_entity_id;
        const object = edge.object_entity_id === loser ? keeper : edge.object_entity_id;
        // The merge can turn an edge between the two duplicates into a self-loop,
        // which the schema refuses and which asserts nothing anyway.
        if (subject === object) continue;
        await sql`
          INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts, confidence)
          SELECT ${subject}::bigint, ${edge.edge_type}, ${object}::bigint,
                 ${textArrayLiteral([...edge.origin_contexts].sort())}::text[], ${edge.confidence}
           WHERE NOT EXISTS (
             SELECT 1 FROM entity_edge
              WHERE deleted_at IS NULL
                AND subject_entity_id = ${subject}::bigint
                AND edge_type = ${edge.edge_type}
                AND object_entity_id = ${object}::bigint
           )
        `;
      }

      await sql`UPDATE entity SET deleted_at = now() WHERE entity_id = ${loser}::bigint`;
      merged += 1;
    }
    // Between groups, never mid-merge: a merge is aliases, then the slug
    // redirect, then the edges, then the tombstone, and stopping between two of
    // those leaves an entity half-absorbed. It yields to the clock as well as to
    // a lost lease for the same reason dedup does — the loser is tombstoned, so
    // it is gone from the next attempt's `deleted_at IS NULL` read and the group
    // comes back one row shorter. The prefix shrinks, so a clean stop here costs
    // one whole-set read and cannot starve the phase.
    if (budget.stop() !== null) return { merged, proposed, ...RESTARTS };
  }

  return { merged, proposed, ...FINISHED };
}

// ---------------------------------------------------------------------------
// 5. Deterministic salience.
// ---------------------------------------------------------------------------

export interface SalienceResult {
  readonly scored: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pages per salience batch.
 *
 * Two statements per batch, so this is the constant that turns `2N + 1` round
 * trips into `2N/500 + 1`. Large enough that a 5,608-page brain costs 24 round
 * trips rather than 11,217; small enough that one batch's rows and one `unnest`
 * literal stay a comfortable object, and that a stop between batches loses at
 * most this many pages' arithmetic.
 */
export const SALIENCE_BATCH = 500;

/** A saturating count: the tenth fact on a page says less than the second. */
function saturate(count: number, scale: number): number {
  return 1 - Math.exp(-count / scale);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Score every live page from signals that can be counted.
 *
 * The four terms are evidence (how many claims the page states), breadth (how
 * many distinct things those claims are about), recency against the source
 * type's own half-life, and the source-type prior. The last two are **imported
 * from `src/core/search/boosts.ts`** rather than restated: a second table of
 * per-source-type numbers would drift from the ranking stage's, and a salience
 * that disagreed with recency decay about what a chat message is worth would be
 * two opinions the brain holds at once.
 *
 * Bounded to [0, 1] so the model refinement that follows is comparable against
 * it rather than living on a different scale.
 *
 * **It walks in batches on a keyset, and that is the whole of why the cycle
 * fits its attempt.** The scoring arithmetic is unchanged — every page it scores
 * is scored on every pass, because the recency term decays with wall clock and a
 * "changed since last time" filter would leave a year-old page carrying a
 * year-old score. What changed is the shape: one read and one write per
 * {@link SALIENCE_BATCH} pages instead of two statements per page. That is the
 * 11,217-round-trip phase that was fifteen minutes on its own, in twenty-four.
 *
 * **It does not touch a page the model has already scored, and that clause is
 * newer than it looks.** `salience_refine` overwrites this score and stamps
 * `salience_source = 'model_refined'`; the note on that phase says the
 * deterministic pass "runs first in every cycle, so the previous value is one
 * phase old rather than lost". That was true while the model re-scored the whole
 * candidate set every cycle. Rung 22 gave the phase a consideration stamp, so it
 * now scores a page **once, ever** — and this pass, running first and
 * unconditionally, overwrote that score on the next cycle and every cycle after.
 * Measured over three cycles on four pages: `model_refined` on all four
 * throughout, before; after, `model_refined` on the first cycle and
 * `deterministic` on all four permanently thereafter. The paid phase's answers
 * survived less than one cycle, which is a ranking change — salience orders the
 * extraction candidate set and drives budget truncation — that was carried in as
 * a cost-only one.
 *
 * **What the clause costs, stated rather than buried.** A model-scored page
 * stops decaying with recency: its score is the model's judgement of the page,
 * frozen at the moment it was made. That is a real loss and it is the smaller
 * one. The alternative is not "the model's score plus decay" — it is the model's
 * score being discarded within a day of being paid for, permanently, on every
 * page, which makes the whole phase a recurring invoice for nothing. When a
 * refresh IS wanted, the designed lever is the one rung 22 built: bump
 * `CONSIDERATION_VERSION.salience_refine` and every page becomes a candidate
 * again, once.
 */
export async function computeDeterministicSalience(
  sql: SQL,
  options: {
    readonly now: Date;
    readonly budget?: AttemptBudget;
    /** Pages per read/write pair. Bounds memory, not correctness. */
    readonly batch?: number;
  },
): Promise<SalienceResult & PhaseProgress> {
  const budget = options.budget ?? unboundedAttempt();
  const batch = Math.max(1, Math.trunc(options.batch ?? SALIENCE_BATCH));
  let cursor = CURSOR_START;
  let scored = 0;

  for (;;) {
    // One statement for the page *and* its facts. The per-page fact query this
    // replaces was the single most expensive thing in the cycle: 5,608 pages
    // meant 5,608 sequential round trips before a single score was written.
    // `LEFT JOIN` rather than a join, because a page with no live facts still
    // has a recency and a source-type prior and must still be scored — an inner
    // join would silently leave those pages carrying whatever score they had.
    const pages = (await sql.unsafe(
      `SELECT p.page_id::text AS page_id, p.source_type, p.created_at,
              coalesce(
                array_agg(f.statement) FILTER (WHERE f.fact_id IS NOT NULL),
                ARRAY[]::text[]
              ) AS statements
         FROM page p
         LEFT JOIN fact f
           ON f.page_id = p.page_id
          AND f.deleted_at IS NULL AND f.quarantined_at IS NULL AND f.superseded_by IS NULL
        WHERE p.deleted_at IS NULL AND p.quarantined_at IS NULL
          AND p.salience_source IS DISTINCT FROM 'model_refined'
          AND p.page_id > $1::bigint
        GROUP BY p.page_id, p.source_type, p.created_at
        ORDER BY p.page_id
        LIMIT ${batch}`,
      [cursor],
    )) as Array<{
      page_id: string;
      source_type: SourceType;
      created_at: Date;
      statements: string[];
    }>;

    if (pages.length === 0) return { scored, ...FINISHED };

    const ids: string[] = [];
    const scores: number[] = [];

    for (const page of pages) {
      const subjects = new Set<string>();
      for (const statement of page.statements) {
        const extracted = extractFromStatement(statement);
        if (extracted === null) continue;
        subjects.add(normalize(extracted.subject));
        if (extracted.object.length > 0) subjects.add(normalize(extracted.object));
      }

      const ageDays = Math.max(
        0,
        (options.now.getTime() - new Date(page.created_at).getTime()) / DAY_MS,
      );
      const halfLife = RECENCY_HALF_LIFE_DAYS[page.source_type] ?? 30;
      const recency = 0.5 ** (ageDays / halfLife);
      const prior = clamp01(0.5 + (SOURCE_TYPE_PRIOR[page.source_type] ?? 0) * 2);

      ids.push(page.page_id);
      scores.push(
        clamp01(
          0.45 * saturate(page.statements.length, 3) +
            0.2 * saturate(subjects.size, 3) +
            0.25 * recency +
            0.1 * prior,
        ),
      );
    }

    // One write for the whole batch, through `unnest` rather than a statement
    // per page. The scores are computed here rather than in SQL on purpose: the
    // subject count goes through `extractFromStatement` and `normalize`, and a
    // SQL-side reimplementation of either would be the second normalizer this
    // module's header refuses.
    await sql.unsafe(
      `UPDATE page p
          SET salience = u.salience,
              salience_source = 'deterministic',
              salience_at = $3
         FROM unnest($1::bigint[], $2::float8[]) AS u(page_id, salience)
        WHERE p.page_id = u.page_id`,
      [numericArrayLiteral(ids), numericArrayLiteral(scores), options.now],
    );

    scored += pages.length;
    cursor = pages[pages.length - 1]?.page_id ?? cursor;

    // A short read means the last batch, and the phase is done regardless of the
    // clock: checking the budget first would report an unfinished phase that had
    // in fact scored every page there is.
    if (pages.length < batch) return { scored, ...FINISHED };
    if (budget.stop() !== null) return { scored, ...RESTARTS };
  }
}

// ---------------------------------------------------------------------------
// 6. Embedding-space clustering.
// ---------------------------------------------------------------------------

export interface ClusterResult {
  readonly clusters: number;
  readonly members: number;
}

/** Default cosine similarity for two chunks to be "about the same thing". */
export const CLUSTER_THRESHOLD = 0.8;

/** How many neighbours one seed considers. Sized through the vector helper. */
export const CLUSTER_POOL = 50;

/**
 * Seeds per amortized vector scan.
 *
 * `withVectorScan` is a transaction — `BEGIN`, two `SET LOCAL`s, `COMMIT` — and
 * it used to wrap **one** seed, so four fifths of the phase's round trips bought
 * nothing but the GUCs that were already correct from the seed before. Batching
 * the probes inside one transaction removes that overhead; the batch stays small
 * because the other half of the trade is how long a transaction is held open
 * against the tenant's database while the lease reaper is watching.
 *
 * **What batching bought, measured, and what it did not.** The probes are now
 * one `LATERAL` statement per batch instead of one round trip per seed: on a
 * live brain of 9,357 embedded chunks, 181ms per seed became 130ms, a 28% cut.
 * The remainder is not network — it is the ANN scan itself at
 * `candidatePoolFor(CLUSTER_POOL)` = 250 neighbours per seed, which is server
 * time and is the price of the recall this clustering is supposed to have.
 * Dropping the pool would buy speed by silently narrowing what a cluster can
 * see, which is the truncation hazard `vector-query.ts` exists to prevent.
 *
 * **So the phase still does not converge on a corpus this size, and that is
 * stated rather than implied.** ~130ms × 9,357 seeds is ~20 minutes against a
 * share of a 14-minute attempt, and because the pass must delete before it
 * rebuilds (see the body), a pass that cannot finish leaves the corpus less
 * clustered than it found it, every cycle, indefinitely. Three things would
 * each close it and none is a change to this function: relax
 * `cluster_member_belongs_to_one_cluster` to admit a generation column so the
 * rebuild can be non-destructive; give the phase a persisted cursor so one pass
 * may span cycles; or stop running it. The third is not flippant —
 * `content_cluster` and `cluster_member` are read by nothing in `src/` outside
 * the erasure sweep, so this is currently the most expensive phase in the cycle
 * and the only one with no consumer.
 */
export const CLUSTER_SEED_BATCH = 100;

/**
 * Greedy agglomeration over the chunk vectors.
 *
 * Greedy rather than k-means because there is no k: "what keeps coming up" is a
 * question about whichever groups exist, and a fixed k either invents themes or
 * merges them. Seeds are taken in id order so the result is deterministic across
 * runs, which is what lets a test assert on it at all.
 *
 * **The neighbour query goes through `withVectorScan`.** Hazards H1 and H3 apply
 * here exactly as they do on the read path: without the `SET LOCAL`, pgvector
 * silently truncates the candidate pool to 40, and every cluster is quietly
 * smaller than it should be with nothing to point at.
 *
 * **And it reads one seat's column, resolved through the seat registry.** This
 * was the fourth statement in the repository naming `embedding` as a literal,
 * and the only one on a path nobody is watching: a consolidation cycle that
 * clusters an empty column produces zero clusters, which is indistinguishable
 * from a corpus with no themes in it. Under a seat move it would have gone on
 * producing nothing, nightly, with every test green. There is no gateway call
 * here to report a model, so the seat is the one the tenant is provisioned at —
 * which is the same thing the chunk backfill fills and the same thing the read
 * arm scans when the routed model is the shipped one.
 */
export async function clusterByEmbedding(
  sql: SQL,
  options: {
    readonly runId: string | null;
    readonly threshold?: number;
    /**
     * A ceiling on seeds considered per call. Absent means the whole corpus,
     * which is the cycle's caller and the correction to a real bug: the old
     * default of 2,000 meant 14,913 of one brain's 16,913 chunks could never be
     * a seed, so cluster coverage was permanently capped at the oldest 2,000
     * however many cycles ran.
     *
     * A call that hits this ceiling reports `done: false` — it stopped, and
     * there is more — which is the same shape as running out of time and is
     * honest for both.
     */
    readonly limit?: number;
    readonly budget?: AttemptBudget;
    /** Seeds per amortized vector-scan transaction. */
    readonly batch?: number;
  },
): Promise<ClusterResult & PhaseProgress> {
  const threshold = options.threshold ?? CLUSTER_THRESHOLD;
  const budget = options.budget ?? unboundedAttempt();
  const batch = Math.max(1, Math.trunc(options.batch ?? CLUSTER_SEED_BATCH));
  const ceiling =
    options.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(1, Math.trunc(options.limit));

  const column = seatColumnSql(ACTIVE_EMBEDDING_SEAT.column);
  const assigned = new Set<string>();

  // **A cycle recomputes clusters from scratch, and it must delete first.**
  //
  // Membership is a function of the current corpus, and an incremental version
  // would carry a chunk's cluster across an edit that moved it. The consequence
  // is that a pass which stops part-way is strictly destructive: it has already
  // deleted the previous clustering and will not finish this one.
  //
  // **Building the new generation beside the old and swapping at the end was
  // tried here and does not fit the schema.** `cluster_member_belongs_to_one_cluster`
  // says a chunk is in exactly one cluster, so two generations cannot coexist
  // for even one statement — the second insert of any shared chunk is a
  // constraint violation, which is what `test/consolidate/convergence.test.ts`
  // reported within a minute of the attempt. Non-destructive rebuild needs that
  // constraint relaxed to (generation, chunk_id), which is a migration and a
  // decision about what a reader of these tables is entitled to see, not a
  // change to this loop.
  //
  // So the destructiveness stands, and what bounds it is the phase finishing.
  // See {@link CLUSTER_SEED_BATCH} for the measured cost and for the part of
  // this that is not yet solved.
  await sql`DELETE FROM cluster_member`;
  await sql`DELETE FROM content_cluster`;

  const pool = candidatePoolFor({ limit: CLUSTER_POOL });
  let cursor = CURSOR_START;
  let clusters = 0;
  let members = 0;
  let seen = 0;

  for (;;) {
    const seeds = (await sql.unsafe(
      `SELECT chunk_id::text AS chunk_id
         FROM chunk
        WHERE ${column} IS NOT NULL AND deleted_at IS NULL AND quarantined_at IS NULL
          AND chunk_id > $1::bigint
        ORDER BY chunk_id
        LIMIT ${Math.min(batch, Number.isFinite(ceiling) ? Math.max(1, ceiling - seen) : batch)}`,
      [cursor],
    )) as Array<{ chunk_id: string }>;

    if (seeds.length === 0) return { clusters, members, ...FINISHED };

    const pending = seeds.filter((seed) => !assigned.has(seed.chunk_id));

    // **One transaction for the batch, not one per seed.** `withVectorScan` is a
    // `BEGIN`, two `SET LOCAL`s and a `COMMIT` — five round trips of overhead
    // that used to be paid for every single seed. The GUCs it sets are what stop
    // pgvector truncating the candidate pool to 40 (hazards H1 and H3), and they
    // hold for the transaction, so a batch shares them correctly.
    const groups: Array<{ seed: string; rows: Array<{ chunk_id: string; similarity: number }> }> = [];
    if (pending.length > 0) {
      // **One statement for the whole batch's probes, not one per seed.** The
      // scan is a `LATERAL` per seed rather than a loop of round trips: each
      // seed's neighbourhood is still its own top-`pool` ANN lookup against its
      // own vector — the semantics are identical, one row per (seed, neighbour)
      // — and the network cost falls from `batch` round trips to one.
      //
      // That is the difference between a phase that finishes and a phase that
      // cannot. Measured on a brain of 8,893 chunks at 22 seeds a second, the
      // per-seed loop needed ~6.7 minutes against a 14-minute attempt, and since
      // this phase deletes its own output at the start of every call, a pass that
      // does not finish banks nothing and the next cycle recomputes the same
      // prefix and stops in the same place. It did not converge slowly; it did
      // not converge at all, and it spent the model tier's clock proving it.
      // This is `salience`'s fix and `reconcileAllEdges`'s fix applied to the one
      // phase that still paid per item.
      const scanned = await withVectorScan(sql, { candidatePool: pool }, async (tx) => {
        const rows = (await tx.unsafe(
          `SELECT s.seed_id::text AS seed_id, n.chunk_id::text AS chunk_id, n.similarity
             FROM unnest($1::bigint[]) AS s(seed_id)
             JOIN chunk probe ON probe.chunk_id = s.seed_id
             CROSS JOIN LATERAL (
               SELECT c.chunk_id, 1 - (c.${column} <=> probe.${column}) AS similarity
                 FROM chunk c
                WHERE c.${column} IS NOT NULL AND c.deleted_at IS NULL
                  AND c.quarantined_at IS NULL AND c.chunk_id <> s.seed_id
                ORDER BY c.${column} <=> probe.${column}
                LIMIT ${pool}
             ) n`,
          [numericArrayLiteral(pending.map((seed) => seed.chunk_id))],
        )) as Array<{ seed_id: string; chunk_id: string; similarity: number }>;

        // Regrouped in insertion order so the greedy walk below still meets
        // seeds in `chunk_id` order — the order decides which seed wins a
        // contested neighbour, so it is part of the phase's output, not a
        // detail of how the rows arrived.
        const bySeed = new Map<string, Array<{ chunk_id: string; similarity: number }>>();
        for (const seed of pending) bySeed.set(seed.chunk_id, []);
        for (const row of rows) {
          bySeed.get(row.seed_id)?.push({ chunk_id: row.chunk_id, similarity: row.similarity });
        }
        return pending.map((seed) => ({
          seed: seed.chunk_id,
          rows: bySeed.get(seed.chunk_id) ?? [],
        }));
      });
      groups.push(...scanned);
    }

    // The writes are outside that transaction on purpose. Holding it open across
    // them would lengthen exactly the window the lease reaper is watching, and
    // the reads it exists for are already done. What each write must still be is
    // *atomic in itself* — hence one statement per cluster below.
    for (const group of groups) {
      if (assigned.has(group.seed)) continue;
      const members_ = group.rows.filter(
        (row) => !assigned.has(row.chunk_id) && Number(row.similarity) >= threshold,
      );
      // A cluster of one is not a pattern; leaving the seed unassigned lets a
      // later, denser seed pick it up.
      if (members_.length === 0) continue;

      // The cluster and every one of its members in **one** statement. Before,
      // this was one INSERT for the cluster and one per member — up to 250 —
      // and an attempt reaped in the middle of that left a `content_cluster` row
      // claiming a `member_count` its `cluster_member` rows did not support.
      const chunkIds = [group.seed, ...members_.map((row) => row.chunk_id)];
      const similarities = [1, ...members_.map((row) => Number(row.similarity))];
      await sql.unsafe(
        `WITH created AS (
           INSERT INTO content_cluster (method, run_id, member_count)
           VALUES ('embedding_greedy', $1::bigint, $2::int)
           RETURNING cluster_id
         )
         INSERT INTO cluster_member (cluster_id, chunk_id, similarity)
         SELECT created.cluster_id, u.chunk_id, u.similarity
           FROM created, unnest($3::bigint[], $4::float8[]) AS u(chunk_id, similarity)`,
        [
          options.runId,
          chunkIds.length,
          numericArrayLiteral(chunkIds),
          numericArrayLiteral(similarities),
        ],
      );

      clusters += 1;
      for (const chunkId of chunkIds) assigned.add(chunkId);
      members += chunkIds.length;
    }

    seen += seeds.length;
    cursor = seeds[seeds.length - 1]?.chunk_id ?? cursor;

    if (seen >= ceiling) return { clusters, members, ...RESTARTS };
    if (budget.stop() !== null) return { clusters, members, ...RESTARTS };
  }
}
