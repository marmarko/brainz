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
 * **Nothing here collapses across credentials.** R15 makes `origin_contexts`
 * immutable, so a row cannot absorb a second credential's attestation — and
 * R12a's corroboration is *defined* on there being two rows with two origins.
 * Every grouping key below therefore includes the origin set, and a same-name
 * collision across credentials is left standing on purpose.
 */

import type { SQL } from 'bun';

import { RECENCY_HALF_LIFE_DAYS, SOURCE_TYPE_PRIOR } from '../../core/search/boosts.ts';
import type { SourceType } from '../../core/search/types.ts';
import { extractFromStatement } from '../../core/write/extract.ts';
import { impliedEdges, resolveOrCreateEntity } from '../../core/write/links.ts';
import { normalize } from '../../core/write/normalize.ts';
import { textArrayLiteral } from '../../core/write/pg-values.ts';
import { candidatePoolFor, withVectorScan } from '../../schema/vector-query.ts';

/** What `live` means for a fact, matching `src/core/write/dedup.ts`. */
const LIVE_FACT = 'deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL';

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
export async function collapseDuplicateFacts(sql: SQL): Promise<DedupResult> {
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
  }

  return { collapsed, groups: collapsedGroups };
}

// ---------------------------------------------------------------------------
// 2. Link reconciliation.
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  readonly added: number;
  readonly removed: number;
  readonly kept: number;
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
 */
export async function reconcileAllEdges(
  sql: SQL,
  options: { readonly taxonomyVersion: number },
): Promise<ReconcileResult> {
  const facts = (await sql.unsafe(`
    SELECT statement, origin_contexts FROM fact WHERE ${LIVE_FACT} ORDER BY fact_id
  `)) as Array<{ statement: string; origin_contexts: string[] }>;

  const desired = new Map<string, { subjectId: string; objectId: string; edgeType: string; confidence: number; origins: string[] }>();

  for (const fact of facts) {
    const extracted = extractFromStatement(fact.statement);
    if (extracted === null) continue;
    for (const implied of impliedEdges([extracted])) {
      const subject = await resolveOrCreateEntity(sql, {
        name: implied.subject.name,
        type: implied.subject.type,
        origins: fact.origin_contexts,
        taxonomyVersion: options.taxonomyVersion,
      });
      const object = await resolveOrCreateEntity(sql, {
        name: implied.object.name,
        type: implied.object.type,
        origins: fact.origin_contexts,
        taxonomyVersion: options.taxonomyVersion,
      });
      if (subject.entityId === object.entityId) continue;
      desired.set(edgeKey(subject.entityId, implied.edgeType, object.entityId), {
        subjectId: subject.entityId,
        objectId: object.entityId,
        edgeType: implied.edgeType,
        confidence: implied.confidence,
        origins: [...new Set([...subject.originContexts, ...object.originContexts])].sort(),
      });
    }
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

  let removed = 0;
  let kept = 0;
  const present = new Set<string>();
  for (const edge of live) {
    const key = edgeKey(edge.subject_entity_id, edge.edge_type, edge.object_entity_id);
    if (desired.has(key)) {
      present.add(key);
      kept += 1;
      continue;
    }
    await sql`UPDATE entity_edge SET deleted_at = now() WHERE edge_id = ${edge.edge_id}::bigint`;
    removed += 1;
  }

  let added = 0;
  for (const [key, edge] of desired) {
    if (present.has(key)) continue;
    const [subject, object] = orient(edge.subjectId, edge.objectId, edge.edgeType);
    const inserted = (await sql`
      INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts, confidence)
      SELECT ${subject}::bigint, ${edge.edgeType}, ${object}::bigint,
             ${textArrayLiteral(edge.origins)}::text[], ${edge.confidence}
       WHERE NOT EXISTS (
         SELECT 1 FROM entity_edge
          WHERE deleted_at IS NULL
            AND subject_entity_id = ${subject}::bigint
            AND edge_type = ${edge.edgeType}
            AND object_entity_id = ${object}::bigint
       )
      RETURNING edge_id
    `) as unknown[];
    if (inserted.length > 0) added += 1;
    else kept += 1;
  }

  return { added, removed, kept };
}

// ---------------------------------------------------------------------------
// 3. Staleness.
// ---------------------------------------------------------------------------

export interface StalenessResult {
  readonly staled: number;
  readonly factsInvalidated: number;
}

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
  options: { readonly now: Date },
): Promise<StalenessResult> {
  const superseded = (await sql`
    SELECT older.page_id::text AS stale_page_id, newer.page_id::text AS live_page_id
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
  `) as Array<{ stale_page_id: string; live_page_id: string }>;

  let staled = 0;
  let factsInvalidated = 0;

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

  return { staled, factsInvalidated };
}

// ---------------------------------------------------------------------------
// 4. Rule-based entity merge.
// ---------------------------------------------------------------------------

export interface MergeResult {
  readonly merged: number;
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
export async function mergeEntitiesByRule(sql: SQL): Promise<MergeResult> {
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
  }

  return { merged };
}

// ---------------------------------------------------------------------------
// 5. Deterministic salience.
// ---------------------------------------------------------------------------

export interface SalienceResult {
  readonly scored: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

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
 */
export async function computeDeterministicSalience(
  sql: SQL,
  options: { readonly now: Date },
): Promise<SalienceResult> {
  const pages = (await sql`
    SELECT p.page_id::text AS page_id, p.source_type, p.created_at
      FROM page p
     WHERE p.deleted_at IS NULL AND p.quarantined_at IS NULL
     ORDER BY p.page_id
  `) as Array<{ page_id: string; source_type: SourceType; created_at: Date }>;

  let scored = 0;
  for (const page of pages) {
    const facts = (await sql.unsafe(
      `SELECT statement FROM fact WHERE ${LIVE_FACT} AND page_id = $1::bigint`,
      [page.page_id],
    )) as Array<{ statement: string }>;

    const subjects = new Set<string>();
    for (const fact of facts) {
      const extracted = extractFromStatement(fact.statement);
      if (extracted === null) continue;
      subjects.add(normalize(extracted.subject));
      if (extracted.object.length > 0) subjects.add(normalize(extracted.object));
    }

    const ageDays = Math.max(0, (options.now.getTime() - new Date(page.created_at).getTime()) / DAY_MS);
    const halfLife = RECENCY_HALF_LIFE_DAYS[page.source_type] ?? 30;
    const recency = 0.5 ** (ageDays / halfLife);
    const prior = clamp01(0.5 + (SOURCE_TYPE_PRIOR[page.source_type] ?? 0) * 2);

    const salience = clamp01(
      0.45 * saturate(facts.length, 3) +
        0.2 * saturate(subjects.size, 3) +
        0.25 * recency +
        0.1 * prior,
    );

    await sql`
      UPDATE page
         SET salience = ${salience}, salience_source = 'deterministic', salience_at = ${options.now}
       WHERE page_id = ${page.page_id}::bigint
    `;
    scored += 1;
  }

  return { scored };
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
 */
export async function clusterByEmbedding(
  sql: SQL,
  options: {
    readonly runId: string | null;
    readonly threshold?: number;
    readonly limit?: number;
  },
): Promise<ClusterResult> {
  const threshold = options.threshold ?? CLUSTER_THRESHOLD;
  const limit = options.limit ?? 2_000;

  // A cycle recomputes clusters from scratch: membership is a function of the
  // current corpus, and an incremental version would carry a chunk's cluster
  // across an edit that moved it.
  await sql`DELETE FROM cluster_member`;
  await sql`DELETE FROM content_cluster`;

  const seeds = (await sql`
    SELECT chunk_id::text AS chunk_id
      FROM chunk
     WHERE embedding IS NOT NULL AND deleted_at IS NULL AND quarantined_at IS NULL
     ORDER BY chunk_id
     LIMIT ${limit}
  `) as Array<{ chunk_id: string }>;

  const assigned = new Set<string>();
  const pool = candidatePoolFor({ limit: CLUSTER_POOL });
  let clusters = 0;
  let members = 0;

  for (const seed of seeds) {
    if (assigned.has(seed.chunk_id)) continue;

    const neighbours = await withVectorScan(sql, { candidatePool: pool }, async (tx) => {
      const rows = (await tx`
        WITH probe AS (SELECT embedding FROM chunk WHERE chunk_id = ${seed.chunk_id}::bigint)
        SELECT c.chunk_id::text AS chunk_id,
               1 - (c.embedding <=> (SELECT embedding FROM probe)) AS similarity
          FROM chunk c
         WHERE c.embedding IS NOT NULL AND c.deleted_at IS NULL AND c.quarantined_at IS NULL
           AND c.chunk_id <> ${seed.chunk_id}::bigint
         ORDER BY c.embedding <=> (SELECT embedding FROM probe)
         LIMIT ${pool}
      `) as Array<{ chunk_id: string; similarity: number }>;
      return { rows };
    });

    const group = neighbours.rows.filter(
      (row) => !assigned.has(row.chunk_id) && Number(row.similarity) >= threshold,
    );
    // A cluster of one is not a pattern; leaving the seed unassigned lets a
    // later, denser seed pick it up.
    if (group.length === 0) continue;

    const created = (await sql`
      INSERT INTO content_cluster (method, run_id, member_count)
      VALUES ('embedding_greedy',
              ${options.runId === null ? null : `${options.runId}`}::bigint,
              ${group.length + 1})
      RETURNING cluster_id::text AS cluster_id
    `) as Array<{ cluster_id: string }>;
    const clusterId = created[0]?.cluster_id;
    if (clusterId === undefined) throw new Error('could not create a cluster');
    clusters += 1;

    await sql`
      INSERT INTO cluster_member (cluster_id, chunk_id, similarity)
      VALUES (${clusterId}::bigint, ${seed.chunk_id}::bigint, 1)
    `;
    assigned.add(seed.chunk_id);
    members += 1;

    for (const row of group) {
      await sql`
        INSERT INTO cluster_member (cluster_id, chunk_id, similarity)
        VALUES (${clusterId}::bigint, ${row.chunk_id}::bigint, ${Number(row.similarity)})
      `;
      assigned.add(row.chunk_id);
      members += 1;
    }
  }

  return { clusters, members };
}
