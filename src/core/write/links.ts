/**
 * Entities, their two naming primitives, and edges as a projection of live
 * facts.
 *
 * **Two primitives, because the audit says so and the schema is built for it.**
 * `entity_slug` is the addressing namespace — canonical slugs and redirects
 * share one primary key, so a redirect cannot shadow a live entity and a
 * collision is a unique violation rather than a resolution order nobody wrote
 * down. `entity_alias` is recall vocabulary — many per entity, deliberately not
 * unique across entities, because two people really are called Mike. This
 * module writes both, differently: one slug per entity, and an alias for every
 * surface form the corpus has used. Aliases are stored **normalized**, because
 * the read path looks them up with the same normalizer; storing the surface
 * form is the drift the plan names as U5's first failure.
 *
 * **Origin widening is a new row, and that is the schema's instruction rather
 * than a design choice made here.** `origin_contexts` is immutable (R15) and
 * the trigger's own hint says it: "a row whose origin would change is a
 * different row: write a new one and tombstone this one". An entity first seen
 * under one credential and re-mentioned under another therefore gets a
 * successor carrying the union, with its slug and aliases moved onto it and its
 * live edges rewritten. Leaving the entity narrow instead would be worse than
 * untidy — KTD5 fences access on origin alone, so a work document reachable
 * through a personal-fenced entity is knowledge escaping its source's fence.
 *
 * **Edges reconcile because they are derived, not stored opinions.**
 * `entity_edge` carries no page provenance — there is no column saying which
 * page asserted it — so "remove the edges this page no longer states" cannot be
 * answered by deleting the page's edges. It is answered by recomputing: an edge
 * is live exactly when some live fact still implies it. That gives the property
 * a page-scoped delete gets wrong, which is that an edge attested by two pages
 * survives one of them dropping it.
 */

import type { SQL } from 'bun';

import { admitEntityName, corpusEvidence, type NameEvidence } from './entity-admission.ts';
import { extractFromStatement, type ExtractedFact, type Predicate } from './extract.ts';
import { normalize, slugify } from './normalize.ts';
import { numericArrayLiteral, textArrayLiteral } from './pg-values.ts';

/** `entity_type_is_known` in the schema. Repeating the closed set is the point:
 * a type outside it fails at commit, at the end of an otherwise good write. */
export type EntityType =
  | 'person'
  | 'organization'
  | 'place'
  | 'project'
  | 'product'
  | 'event'
  | 'topic'
  | 'other';

/**
 * What each predicate implies about its endpoints, and which declared edge type
 * carries it.
 *
 * **`related_to` is not a shrug.** The schema's registry describes it as "an
 * unlabelled association in both directions", which is exactly what a predicate
 * with no declared type is. Promoting `founded` or `based_in` to its own type
 * is a schema rung — a new `edge_type` pair, through the involution trigger —
 * not an edit here, and the fact keeps the precise predicate either way.
 *
 * `left` maps to **no** edge on purpose: "X left Y" asserts the *absence* of
 * employment, and because edges are a projection of live facts, superseding
 * "X joined Y" with it is what removes the edge.
 */
export const PREDICATE_LINKS: Readonly<
  Record<
    Predicate,
    {
      readonly subjectType: EntityType;
      readonly objectType: EntityType | null;
      readonly edgeType: string | null;
    }
  >
> = Object.freeze({
  works_at: { subjectType: 'person', objectType: 'organization', edgeType: 'works_at' },
  left: { subjectType: 'person', objectType: 'organization', edgeType: null },
  invested_in: { subjectType: 'organization', objectType: 'organization', edgeType: 'invested_in' },
  part_of: { subjectType: 'organization', objectType: 'organization', edgeType: 'part_of' },
  founded: { subjectType: 'person', objectType: 'organization', edgeType: 'related_to' },
  advises: { subjectType: 'person', objectType: 'organization', edgeType: 'related_to' },
  acquired: { subjectType: 'organization', objectType: 'organization', edgeType: 'related_to' },
  based_in: { subjectType: 'organization', objectType: 'place', edgeType: 'related_to' },
  amount: { subjectType: 'other', objectType: null, edgeType: null },
  dated_event: { subjectType: 'other', objectType: null, edgeType: null },
  defect: { subjectType: 'product', objectType: null, edgeType: null },
  assertion: { subjectType: 'other', objectType: null, edgeType: null },
});

/**
 * How sure an alias derived from a surface form is. Hoisted out of the two SQL
 * statements that use it, and that is not tidiness: the repo's price-drift
 * scanner treats a decimal on a line carrying a `$` as a copied price, and every
 * line of a tagged SQL template carries `${...}`. A named constant keeps the
 * number off those lines and tells the next reader what it is.
 */
const INFERRED_ALIAS_CONFIDENCE = 0.5;

/** Types whose two directions are the same statement (`related_to ↔ related_to`). */
const SYMMETRIC_EDGE_TYPES: ReadonlySet<string> = new Set(['related_to']);

export interface ImpliedEdge {
  readonly subject: { readonly name: string; readonly type: EntityType };
  readonly object: { readonly name: string; readonly type: EntityType };
  readonly edgeType: string;
  readonly confidence: number;
}

/** The edges a set of extracted facts asserts. Facts with no declared edge type
 * and facts whose object is a value rather than a thing contribute none. */
export function impliedEdges(facts: readonly ExtractedFact[]): ImpliedEdge[] {
  const edges: ImpliedEdge[] = [];
  for (const fact of facts) {
    const link = PREDICATE_LINKS[fact.predicate];
    if (link.edgeType === null || link.objectType === null) continue;
    if (normalize(fact.subject) === normalize(fact.object)) continue;
    edges.push({
      subject: { name: fact.subject, type: link.subjectType },
      object: { name: fact.object, type: link.objectType },
      edgeType: link.edgeType,
      confidence: fact.confidence,
    });
  }
  return edges;
}

export interface EntityRow {
  readonly entityId: string;
  readonly canonicalName: string;
  readonly originContexts: readonly string[];
}

interface RawEntity {
  entity_id: string;
  canonical_name: string;
  origin_contexts: string[];
}

function toEntity(row: RawEntity): EntityRow {
  return {
    entityId: row.entity_id,
    canonicalName: row.canonical_name,
    originContexts: row.origin_contexts,
  };
}

/**
 * Names per statement in every batched read and write below.
 *
 * Large enough that a whole consolidation pass over a 5,608-page brain is a
 * couple of dozen statements rather than tens of thousands; small enough that
 * one batch's array literal stays a comfortable parameter and a name list built
 * from a corpus cannot grow into a megabyte-long bind.
 */
export const ENTITY_BATCH = 500;

/** `xs` in runs of at most {@link ENTITY_BATCH}. */
function batched<T>(xs: readonly T[], size = ENTITY_BATCH): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < xs.length; index += size) out.push(xs.slice(index, index + size));
  return out;
}

/**
 * Alias first, then the slug namespace, for a whole set of names at once.
 *
 * **One ladder, expressed once.** This is the read path's resolution order —
 * alias, then the slug namespace in which a redirect resolves exactly as a
 * canonical slug does — and both the singular {@link findEntityByName} and the
 * batched {@link resolveOrCreateEntities} go through it. A second copy written
 * for the batched caller would be the failure this module's header names about
 * the normalizer, one layer up: two ladders that agree today, disagree after one
 * edit, and disagree *silently*, because a name that resolves one way on the
 * write path and another way in consolidation does not throw. It forks the
 * entity.
 *
 * Keyed by {@link normalize}, which is what the caller has to key its own
 * bookkeeping by anyway. A name whose key is empty is not asked about.
 */
export async function findEntitiesByName(
  db: SQL,
  names: readonly string[],
): Promise<Map<string, EntityRow>> {
  const wanted = new Map<string, string>();
  for (const name of names) {
    const key = normalize(name);
    // Same key implies the same slug — `slugify` is a function of `normalize` —
    // so the first spelling seen may stand for every later one.
    if (key.length > 0 && !wanted.has(key)) wanted.set(key, slugify(name));
  }

  const found = new Map<string, EntityRow>();
  for (const chunk of batched([...wanted])) {
    // `DISTINCT ON (key) ... ORDER BY key, entity_id` is the batched spelling of
    // the singular lookup's `ORDER BY e.entity_id LIMIT 1`: two people really are
    // called Mike, aliases are deliberately not unique across entities, and the
    // tie has to break the same way for both callers or they fork the entity.
    const rows = (await db.unsafe(
      `WITH wanted AS (
         SELECT * FROM unnest($1::text[], $2::text[]) AS w(key, slug)
       ),
       by_alias AS (
         SELECT DISTINCT ON (w.key)
                w.key AS key, e.entity_id::text AS entity_id, e.canonical_name, e.origin_contexts
           FROM wanted w
           JOIN entity_alias a ON lower(a.alias) = w.key
           JOIN entity e ON e.entity_id = a.entity_id
          WHERE e.deleted_at IS NULL
          ORDER BY w.key, e.entity_id
       ),
       by_slug AS (
         SELECT w.key AS key, e.entity_id::text AS entity_id, e.canonical_name, e.origin_contexts
           FROM wanted w
           JOIN entity_slug s ON s.slug = w.slug
           JOIN entity e ON e.entity_id = s.entity_id
          WHERE e.deleted_at IS NULL
       )
       SELECT w.key,
              coalesce(a.entity_id, s.entity_id) AS entity_id,
              coalesce(a.canonical_name, s.canonical_name) AS canonical_name,
              coalesce(a.origin_contexts, s.origin_contexts) AS origin_contexts
         FROM wanted w
         LEFT JOIN by_alias a ON a.key = w.key
         LEFT JOIN by_slug s ON s.key = w.key
        WHERE a.entity_id IS NOT NULL OR s.entity_id IS NOT NULL`,
      [
        textArrayLiteral(chunk.map(([key]) => key)),
        textArrayLiteral(chunk.map(([, slug]) => slug)),
      ],
    )) as Array<RawEntity & { key: string }>;
    for (const row of rows) found.set(row.key, toEntity(row));
  }
  return found;
}

/**
 * Alias first, then the slug namespace — the read path's ladder, applied on the
 * write side so that both sides resolve a name the same way. A redirect
 * resolves here exactly as a canonical slug does, which is the whole reason
 * redirects share the namespace.
 */
export async function findEntityByName(db: SQL, name: string): Promise<EntityRow | null> {
  const key = normalize(name);
  if (key.length === 0) return null;
  return (await findEntitiesByName(db, [name])).get(key) ?? null;
}

function union(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].sort();
}

/**
 * Replaces a set of entities with successors carrying wider origin unions.
 *
 * The cascade is the price of R15's immutability and every step of it is
 * load-bearing: the slug moves so the entity keeps its address, the aliases
 * move so recall keeps working, and the live edges are rewritten because
 * `entity_edge.origin_contexts` is immutable too *and* the union trigger would
 * refuse an edge narrower than its new endpoint. A live edge left pointing at
 * the tombstoned row is a graph walk into a row nothing else can reach.
 *
 * **It takes a set, and that is the whole of the change.** This ran per entity,
 * at `5 + 2·degree` round trips each, and it was the one shape in the
 * consolidation pass that could still overrun an attempt: the edge-rewrite loop
 * is charged per EDGE, so a well-connected corpus pays for the graph twice over.
 * The measurement that reassured everyone about the pass as a whole was taken on
 * the one fixture that structurally cannot widen, so the term was never in it.
 * Seven statements now, whatever the set's size and whatever its degree — the
 * same treatment `reconcileAllEdges` gave the phase around it.
 *
 * **Widening is bounded by entities, never by facts, and this is still worth
 * batching.** In steady state it fires for nothing at all: the write path widens
 * as it ingests, so consolidation re-derives a union that is already correct. It
 * fires in bulk exactly once — the pass where a second connector meets a corpus
 * this brain already knows — and that pass is where the attempt is tightest.
 *
 * **Ordering inside the batch is what keeps it legal.** Every replacement edge
 * is tombstoned before any is inserted, because `entity_edge_is_stated_once` is
 * a partial unique index over live rows and a replacement cannot sit beside the
 * row it replaces. Two statements, not two per edge.
 *
 * **An edge between two widened entities is handled once rather than twice.**
 * The per-entity version met such an edge in both passes — the second pass
 * finding the row the first one had just written — and unioned each endpoint's
 * origins in turn. Reading every affected edge once and unioning whichever of
 * its endpoints are in the set reaches the same row in one write, and cannot
 * depend on the order the entities happen to come in.
 */
async function widenEntityOrigins(
  db: SQL,
  wanted: ReadonlyMap<string, { readonly entity: EntityRow; readonly missing: readonly string[] }>,
): Promise<Map<string, EntityRow>> {
  const successors = new Map<string, EntityRow>();
  if (wanted.size === 0) return successors;

  const oldIds = [...wanted.keys()];
  const widenedBy = new Map<string, string[]>();
  for (const [oldId, group] of wanted) {
    widenedBy.set(oldId, union(group.entity.originContexts, group.missing));
  }

  // 1. Every successor, and the old→new mapping, in one statement.
  //
  // **The id is drawn before the insert rather than read back after it**, and
  // that is what makes the mapping a fact rather than an assumption. `entity_id`
  // is `GENERATED ALWAYS AS IDENTITY`, so an `INSERT … SELECT … RETURNING`
  // returns the new ids with nothing on them tying each back to the row it
  // succeeds: `canonical_name` is not unique (two entities of different types
  // share one), and the order rows come back in is promised by nothing. Taking
  // `nextval` in a MATERIALIZED CTE gives both sides the same number. The CTE is
  // materialized twice over — it is referenced twice AND holds a volatile
  // function — and it is said out loud anyway, because the correctness of every
  // statement below rests on `src` being evaluated exactly once.
  const mapped = (await db.unsafe(
    `WITH src AS MATERIALIZED (
       SELECT u.old_id, u.origins::text[] AS origins,
              nextval(pg_get_serial_sequence('entity', 'entity_id')) AS new_id
         FROM unnest($1::bigint[], $2::text[]) AS u(old_id, origins)
     ), born AS (
       INSERT INTO entity (entity_id, canonical_name, entity_type, taxonomy_version,
                           origin_contexts, subject_context, subject_confidence)
       OVERRIDING SYSTEM VALUE
       SELECT s.new_id, e.canonical_name, e.entity_type, e.taxonomy_version,
              s.origins, e.subject_context, e.subject_confidence
         FROM src s JOIN entity e ON e.entity_id = s.old_id
       RETURNING entity_id, canonical_name, origin_contexts
     )
     SELECT s.old_id::text AS old_id, b.entity_id::text AS entity_id,
            b.canonical_name, b.origin_contexts
       FROM src s JOIN born b ON b.entity_id = s.new_id`,
    [
      numericArrayLiteral(oldIds),
      textArrayLiteral(oldIds.map((oldId) => textArrayLiteral(widenedBy.get(oldId) ?? []))),
    ],
  )) as Array<RawEntity & { old_id: string }>;

  const newIdOf = new Map<string, string>();
  for (const row of mapped) {
    newIdOf.set(row.old_id, row.entity_id);
    successors.set(row.old_id, toEntity(row));
  }
  if (newIdOf.size !== wanted.size) {
    throw new Error(`could not widen ${wanted.size - newIdOf.size} of ${wanted.size} entities`);
  }

  const pairs: [string, string] = [
    numericArrayLiteral(oldIds),
    numericArrayLiteral(oldIds.map((oldId) => newIdOf.get(oldId) ?? '0')),
  ];

  // 2 and 3. The address and the alias set follow the entity.
  await db.unsafe(
    `UPDATE entity_slug s SET entity_id = m.new_id
       FROM unnest($1::bigint[], $2::bigint[]) AS m(old_id, new_id)
      WHERE s.entity_id = m.old_id`,
    pairs,
  );
  await db.unsafe(
    `UPDATE entity_alias a SET entity_id = m.new_id
       FROM unnest($1::bigint[], $2::bigint[]) AS m(old_id, new_id)
      WHERE a.entity_id = m.old_id`,
    pairs,
  );

  // 4. Every live edge touching anything in the set, read once.
  const edges = (await db.unsafe(
    `SELECT edge_id::text AS edge_id, subject_entity_id::text AS subject_entity_id,
            edge_type, object_entity_id::text AS object_entity_id,
            origin_contexts, confidence
       FROM entity_edge
      WHERE deleted_at IS NULL
        AND (subject_entity_id = ANY($1::bigint[]) OR object_entity_id = ANY($1::bigint[]))`,
    [numericArrayLiteral(oldIds)],
  )) as Array<{
    edge_id: string;
    subject_entity_id: string;
    edge_type: string;
    object_entity_id: string;
    origin_contexts: string[];
    confidence: number | null;
  }>;

  if (edges.length > 0) {
    // 5. Tombstone every one of them BEFORE inserting any replacement.
    await db.unsafe(`UPDATE entity_edge SET deleted_at = now() WHERE edge_id = ANY($1::bigint[])`, [
      numericArrayLiteral(edges.map((edge) => edge.edge_id)),
    ]);

    // 6. And write them back, re-pointed and re-unioned. An edge whose two
    // endpoints are both in the set takes both unions here, in one row.
    const replacements = edges.map((edge) => {
      let widened = edge.origin_contexts;
      const fromSubject = widenedBy.get(edge.subject_entity_id);
      if (fromSubject !== undefined) widened = union(widened, fromSubject);
      const fromObject = widenedBy.get(edge.object_entity_id);
      if (fromObject !== undefined) widened = union(widened, fromObject);
      return {
        subject: newIdOf.get(edge.subject_entity_id) ?? edge.subject_entity_id,
        edgeType: edge.edge_type,
        object: newIdOf.get(edge.object_entity_id) ?? edge.object_entity_id,
        origins: textArrayLiteral(widened),
        // `NULL` unquoted is how a Postgres array literal spells an absent
        // element; the empty string `numericArrayLiteral` would otherwise
        // produce is not a `float8` and would fail the whole statement.
        confidence: edge.confidence === null ? 'NULL' : String(edge.confidence),
      };
    });

    for (const chunk of batched(replacements)) {
      await db.unsafe(
        `INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id,
                                  origin_contexts, confidence)
         SELECT u.subject, u.edge_type, u.object, u.origins::text[], u.confidence
           FROM unnest($1::bigint[], $2::text[], $3::bigint[], $4::text[], $5::float8[])
                AS u(subject, edge_type, object, origins, confidence)`,
        [
          numericArrayLiteral(chunk.map((row) => row.subject)),
          textArrayLiteral(chunk.map((row) => row.edgeType)),
          numericArrayLiteral(chunk.map((row) => row.object)),
          textArrayLiteral(chunk.map((row) => row.origins)),
          numericArrayLiteral(chunk.map((row) => row.confidence)),
        ],
      );
    }
  }

  // 7. The predecessors leave.
  await db.unsafe(`UPDATE entity SET deleted_at = now() WHERE entity_id = ANY($1::bigint[])`, [
    numericArrayLiteral(oldIds),
  ]);

  return successors;
}

export interface ResolveEntityRequest {
  readonly name: string;
  readonly type: EntityType;
  readonly origins: readonly string[];
  readonly taxonomyVersion: number;
}

/** One spelling, folded across every request in the batch that used it. */
interface WantedName {
  readonly key: string;
  /** The first spelling seen — what a created row's `canonical_name` becomes. */
  readonly name: string;
  readonly type: EntityType;
  readonly slug: string;
  readonly taxonomyVersion: number;
  /** Every origin any request for this spelling carried. The widening target. */
  readonly origins: Set<string>;
  /** The first request's origins — what the alias row is stamped with. */
  readonly aliasOrigins: readonly string[];
}

/**
 * The entities a whole set of names refers to, creating what the brain has not
 * seen, in a number of statements that does not grow with the set.
 *
 * **This exists because a phase that cannot yield had to become cheap.**
 * Consolidation's `link_reconcile` resolves both endpoints of every implied
 * edge, and resolving them one at a time cost 8.42 round trips per live fact —
 * about 94,000 on a 5,608-page brain, four times what a 14-minute attempt buys
 * at the incident fleet's latency. It is the one phase that cannot stop on the
 * clock (an edge missing from a half-built desired set is an edge the diff
 * deletes), so overrunning it is not a slow phase but a *reaped* attempt against
 * a ladder that dead-letters after five. The fix is the one salience took: batch
 * the work, do not checkpoint it.
 *
 * **Every path still leaves the same three things true** — the entity exists,
 * its origin union covers every write that mentioned it, and the normalized
 * surface form is in its alias vocabulary — and the order below is what keeps
 * them true together:
 *
 *   1. **Resolve** every name through the one ladder.
 *   2. **Widen** each found entity ONCE, to the union of every origin this batch
 *      needs, remapping the spellings that landed on it to the successor. R15
 *      makes widening a new row and a tombstone, so a batch that widened the same
 *      entity twice would write the second successor from a row it had just
 *      killed.
 *   3. **Create** what is left, with the full union up front rather than the
 *      first mention's origins and a widen per mention afterwards. Same end
 *      state, without the intermediate tombstones.
 *   4. **Slugs**, then **aliases** — aliases last, and after the remap, because
 *      an alias planted on a tombstoned predecessor is a spelling that silently
 *      stops resolving (`deleted_at IS NULL` is in the ladder) and gets the
 *      entity re-created on the next pass.
 *
 * **Creation folds by slug, not by key**, which is the one place batching could
 * have changed identity. `Acme, Inc.` and `Acme Inc` are two normalize keys and
 * one slug: resolved one at a time, the first creates the entity and the second
 * *finds* it through the slug namespace. Resolved as a set against one snapshot,
 * both miss and both would create — two entities that no rule-based merge would
 * ever collapse, because their canonical names differ. So the unresolved names
 * are folded by slug and the leader's entity stands for the group, which is
 * exactly what the sequential fold produced.
 */
export async function resolveOrCreateEntities(
  db: SQL,
  requests: readonly ResolveEntityRequest[],
): Promise<Map<string, EntityRow>>;
export async function resolveOrCreateEntities(
  db: SQL,
  requests: readonly ResolveEntityRequest[],
  admission: EntityAdmission,
): Promise<GatedEntities>;
export async function resolveOrCreateEntities(
  db: SQL,
  requests: readonly ResolveEntityRequest[],
  admission?: EntityAdmission,
): Promise<Map<string, EntityRow> | GatedEntities> {
  const wanted = new Map<string, WantedName>();
  for (const request of requests) {
    const key = normalize(request.name);
    if (key.length === 0) throw new Error('an entity needs a name');
    const seen = wanted.get(key);
    if (seen !== undefined) {
      for (const origin of request.origins) seen.origins.add(origin);
      continue;
    }
    wanted.set(key, {
      key,
      name: request.name,
      type: request.type,
      slug: slugify(request.name),
      taxonomyVersion: request.taxonomyVersion,
      origins: new Set(request.origins),
      aliasOrigins: [...new Set(request.origins)].sort(),
    });
  }
  if (wanted.size === 0) return admission === undefined ? new Map() : { entities: new Map(), refused: [] };

  const resolved = new Map<string, EntityRow>(
    await findEntitiesByName(db, [...wanted.values()].map((name) => name.name)),
  );

  // ------------------------------------------------------------------
  // 1a. The admission fence — creations only, and only when asked for.
  // ------------------------------------------------------------------
  //
  // Placed here and nowhere else: after resolution, before the slug fold. A
  // name that already resolves is never asked about, which is what makes the
  // fence unable to remove anything — see `entity-admission.ts`'s header for
  // why that property is the whole design rather than a nicety.
  const refused: RefusedName[] = [];
  if (admission !== undefined) {
    for (const [key, name] of wanted) {
      if (resolved.has(key)) continue;
      const verdict = admitEntityName(name.name, admission.evidence);
      if (verdict.verdict === 'admit') continue;
      refused.push({ name: name.name, signals: verdict.signals });
      wanted.delete(key);
    }
    if (wanted.size === 0) return { entities: resolved, refused };
  }

  // ------------------------------------------------------------------
  // 2. Widen, once per entity.
  // ------------------------------------------------------------------

  const perEntity = new Map<string, { entity: EntityRow; keys: string[]; origins: Set<string> }>();
  for (const [key, entity] of resolved) {
    const name = wanted.get(key);
    if (name === undefined) continue;
    const group = perEntity.get(entity.entityId) ?? { entity, keys: [], origins: new Set<string>() };
    group.keys.push(key);
    for (const origin of name.origins) group.origins.add(origin);
    perEntity.set(entity.entityId, group);
  }

  // Collected first and widened as a set: the cascade is seven statements for
  // the whole batch, and it used to be `5 + 2·degree` for each entity in it.
  // See {@link widenEntityOrigins} for why the edge term is the dangerous half.
  const widening = new Map<string, { entity: EntityRow; missing: string[]; keys: string[] }>();
  for (const group of perEntity.values()) {
    const missing = [...group.origins].filter(
      (origin) => !group.entity.originContexts.includes(origin),
    );
    // In steady state this is every entity, and the batch below is empty: the
    // write path widens as it ingests, so consolidation re-derives a union that
    // is already correct.
    if (missing.length === 0) continue;
    widening.set(group.entity.entityId, { entity: group.entity, missing, keys: group.keys });
  }

  if (widening.size > 0) {
    const successors = await widenEntityOrigins(db, widening);
    for (const [oldId, group] of widening) {
      const successor = successors.get(oldId);
      if (successor === undefined) continue;
      for (const key of group.keys) resolved.set(key, successor);
    }
  }

  // ------------------------------------------------------------------
  // 3. Create what is left, folded by slug.
  // ------------------------------------------------------------------

  const leaders: WantedName[] = [];
  const bySlug = new Map<string, WantedName>();
  const followers = new Map<string, string[]>();
  for (const name of wanted.values()) {
    if (resolved.has(name.key)) continue;
    const leader = bySlug.get(name.slug);
    if (leader === undefined) {
      bySlug.set(name.slug, name);
      followers.set(name.slug, []);
      leaders.push(name);
      continue;
    }
    followers.get(leader.slug)?.push(name.key);
    for (const origin of name.origins) leader.origins.add(origin);
  }

  const born: Array<{ leader: WantedName; entity: EntityRow }> = [];
  for (const group of groupByOrigins(leaders)) {
    for (const chunk of batched(group.members)) {
      const rows = (await db.unsafe(
        `INSERT INTO entity (canonical_name, entity_type, taxonomy_version, origin_contexts)
         SELECT u.name, u.type, $3::int, $4::text[]
           FROM unnest($1::text[], $2::text[]) AS u(name, type)
         RETURNING entity_id::text AS entity_id, canonical_name, origin_contexts`,
        [
          textArrayLiteral(chunk.map((member) => member.name)),
          textArrayLiteral(chunk.map((member) => member.type)),
          group.taxonomyVersion,
          textArrayLiteral(group.origins),
        ],
      )) as RawEntity[];
      // Correlated by `canonical_name` rather than by the order rows come back
      // in, which nothing promises. It is a key here because two spellings that
      // produce the same name produce the same normalize key, and this list holds
      // one member per key.
      const byName = new Map(chunk.map((member) => [member.name, member]));
      for (const row of rows) {
        const leader = byName.get(row.canonical_name);
        if (leader === undefined) continue;
        born.push({ leader, entity: toEntity(row) });
      }
    }
  }
  for (const { leader, entity } of born) {
    resolved.set(leader.key, entity);
    for (const key of followers.get(leader.slug) ?? []) resolved.set(key, entity);
  }
  if (born.length !== leaders.length) {
    const missed = leaders.find((leader) => !resolved.has(leader.key));
    throw new Error(`could not create entity '${missed?.name ?? ''}'`);
  }

  await allocateSlugs(db, born);
  await plantAliases(db, wanted, resolved);
  return admission === undefined ? resolved : { entities: resolved, refused };
}

/**
 * Groups by origin set, so each write binds one `text[]` literal for the lot
 * rather than one per row — and the group carries the values it was keyed on, so
 * the bind reads them from the group rather than from some member of it.
 *
 * There are as many groups as there are distinct credential unions among these
 * names, which is a property of how many connectors somebody installed rather
 * than of how many names the corpus mentions.
 */
interface OriginGroup {
  readonly origins: readonly string[];
  /** Keyed on too: it is a column of the same INSERT, so a batch that mixed two
   * versions would have to bind one of them wrongly. */
  readonly taxonomyVersion: number;
  readonly members: WantedName[];
}

function groupByOrigins(names: readonly WantedName[]): OriginGroup[] {
  const groups = new Map<string, OriginGroup>();
  for (const name of names) {
    const origins = [...name.origins].sort();
    const key = JSON.stringify([origins, name.taxonomyVersion]);
    const group = groups.get(key) ?? {
      origins,
      taxonomyVersion: name.taxonomyVersion,
      members: [],
    };
    group.members.push(name);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * A canonical slug for every entity just created.
 *
 * **The probe loop was a per-name round-trip multiplier.** Asking `is this slug
 * taken` before every insert is one statement per new entity on top of the
 * insert itself, and the answer is one the database can give by refusing. So
 * the whole round is offered at once and the namespace's own primary key
 * arbitrates: `ON CONFLICT (slug) DO NOTHING` settles collisions with rows that
 * already exist *and* between two candidates inside the same statement, and
 * `RETURNING` says who won. The losers try the next suffix, so a round is one
 * statement rather than one per name and the common case is a single round.
 *
 * The candidate shape (`base`, then `base-2` … `base-64`) is the shape it always
 * was. A collision is rarer than it looks: a slug taken by a *live* entity is
 * resolved through the slug namespace long before anything reaches here, so what
 * remains are the addresses of tombstoned rows, which keep their slugs on
 * purpose.
 */
async function allocateSlugs(
  db: SQL,
  born: ReadonlyArray<{ leader: WantedName; entity: EntityRow }>,
): Promise<void> {
  let pending = [...born];
  for (let attempt = 0; attempt < 64 && pending.length > 0; attempt += 1) {
    const candidate = (leader: WantedName): string =>
      attempt === 0 ? leader.slug : `${leader.slug.slice(0, 120)}-${attempt + 1}`;

    const stillPending: typeof pending = [];
    for (const chunk of batched(pending)) {
      const rows = (await db.unsafe(
        `INSERT INTO entity_slug (slug, entity_id, kind)
         SELECT u.slug, u.entity_id, 'canonical'
           FROM unnest($1::text[], $2::bigint[]) AS u(slug, entity_id)
         ON CONFLICT (slug) DO NOTHING
         RETURNING entity_id::text AS entity_id`,
        [
          textArrayLiteral(chunk.map((row) => candidate(row.leader))),
          numericArrayLiteral(chunk.map((row) => row.entity.entityId)),
        ],
      )) as Array<{ entity_id: string }>;
      const addressed = new Set(rows.map((row) => row.entity_id));
      for (const row of chunk) if (!addressed.has(row.entity.entityId)) stillPending.push(row);
    }
    pending = stillPending;
  }
  const stuck = pending[0];
  if (stuck !== undefined) {
    throw new Error(`no free slug for '${stuck.leader.name}' after 64 attempts`);
  }
}

/**
 * The normalized surface form of every spelling in the batch, on the entity it
 * resolved to.
 *
 * **The origins of the write that planted the spelling, not the entity's.** An
 * entity accumulates origins as more of the brain mentions it; an alias is one
 * string from one write, and R15 fences on where a row came from. Stamped at
 * insert because it is immutable afterwards, and because the read
 * (`mcp/reads.ts:entityCard`) has nothing else to fence on.
 *
 * `ON CONFLICT DO NOTHING` means a spelling first seen at one origin keeps that
 * origin when a second origin restates it. That under-shows — a grant holding
 * only the second origin will not see a name it could legitimately have been
 * told — and it is the fail-closed direction, which is the one to be wrong in.
 */
async function plantAliases(
  db: SQL,
  wanted: ReadonlyMap<string, WantedName>,
  resolved: ReadonlyMap<string, EntityRow>,
): Promise<void> {
  const groups = new Map<
    string,
    { origins: readonly string[]; rows: Array<{ entityId: string; alias: string }> }
  >();
  for (const name of wanted.values()) {
    const entity = resolved.get(name.key);
    if (entity === undefined) continue;
    const key = JSON.stringify(name.aliasOrigins);
    const group = groups.get(key) ?? { origins: name.aliasOrigins, rows: [] };
    group.rows.push({ entityId: entity.entityId, alias: name.key });
    groups.set(key, group);
  }

  for (const { origins, rows } of groups.values()) {
    for (const chunk of batched(rows)) {
      await db.unsafe(
        `INSERT INTO entity_alias (entity_id, alias, alias_source, confidence, origin_contexts)
         SELECT u.entity_id, u.alias, 'inferred', $3::real, $4::text[]
           FROM unnest($1::bigint[], $2::text[]) AS u(entity_id, alias)
         ON CONFLICT (entity_id, alias) DO NOTHING`,
        [
          numericArrayLiteral(chunk.map((row) => row.entityId)),
          textArrayLiteral(chunk.map((row) => row.alias)),
          INFERRED_ALIAS_CONFIDENCE,
          textArrayLiteral([...origins]),
        ],
      );
    }
  }
}

/**
 * Opting {@link resolveOrCreateEntities} into the admission fence.
 *
 * Optional, and its absence is the compatibility contract: with no `admission`
 * the function behaves exactly as it did before the fence existed, which is
 * what lets {@link resolveOrCreateEntity} and every test that predates this
 * stay honest. The invariant that replaces it: **every path in `src/` that
 * creates an entity from extracted text passes `admission`.**
 */
export interface EntityAdmission {
  /**
   * The corpus door. Absent is the strict reading — the write path has one page
   * in hand rather than a corpus, so it gets the strict one.
   */
  readonly evidence?: NameEvidence;
}

/** A name the fence declined to create, with the rules that fired. */
export interface RefusedName {
  readonly name: string;
  readonly signals: readonly string[];
}

export interface GatedEntities {
  readonly entities: Map<string, EntityRow>;
  /**
   * Refusals, so a fence nobody can see does not become a brain that quietly
   * stops knowing things. Folded into `link_reconcile`'s log line and counted
   * on `/coverage`.
   */
  readonly refused: readonly RefusedName[];
}

/**
 * The entity a name refers to, creating it if the brain has not seen it.
 *
 * Every path leaves the same three things true: the entity exists, its origin
 * union covers the write that mentioned it, and the normalized surface form is
 * in its alias vocabulary. A batch of one, so that the write path and
 * consolidation cannot disagree about what a name resolves to — see
 * {@link resolveOrCreateEntities}.
 *
 * **It has no callers in `src/` any more**, and it is kept deliberately: it is
 * the documented batch-of-one, it is what several tests are written against,
 * and it is the compatibility pin that keeps the two-argument form of
 * {@link resolveOrCreateEntities} honest. The invariant it must not be used to
 * break: **every path in `src/` that creates an entity from extracted text
 * passes `admission`.** This one does not, so nothing in `src/` may call it on
 * a name that came out of the extractor.
 */
export async function resolveOrCreateEntity(
  db: SQL,
  request: ResolveEntityRequest,
): Promise<EntityRow> {
  const key = normalize(request.name);
  if (key.length === 0) throw new Error('an entity needs a name');
  const entity = (await resolveOrCreateEntities(db, [request])).get(key);
  if (entity === undefined) throw new Error(`could not create entity '${request.name}'`);
  return entity;
}

interface ResolvedEdge {
  readonly subjectId: string;
  readonly objectId: string;
  readonly edgeType: string;
  readonly confidence: number;
  readonly origins: readonly string[];
}

/** Symmetric edges are stored in one direction so the pair cannot disagree. */
function orient(subjectId: string, objectId: string, edgeType: string): [string, string] {
  if (!SYMMETRIC_EDGE_TYPES.has(edgeType)) return [subjectId, objectId];
  return BigInt(subjectId) <= BigInt(objectId) ? [subjectId, objectId] : [objectId, subjectId];
}

function edgeKey(edge: { subjectId: string; objectId: string; edgeType: string }): string {
  const [subject, object] = orient(edge.subjectId, edge.objectId, edge.edgeType);
  return `${subject}|${edge.edgeType}|${object}`;
}

/**
 * How many live statements the reconciler reads before it stops asking and
 * keeps the edge — a bound on one removal check's runtime, not a tuning knob.
 * See {@link stillImplied} for why the give-up answer is "keep".
 */
export const RECONCILE_SCAN_LIMIT = 200_000;

/** Rows per round trip on that scan. */
const RECONCILE_SCAN_BATCH = 500;

/**
 * Is this edge still asserted by some live fact?
 *
 * **The filter is the normalizer, and it has to run where the normalizer
 * lives.** The obvious implementation — probe the statements in SQL with
 * `statement ILIKE '%' || alias || '%'` — reads as a harmless prefilter and is
 * not one, because the two sides of that comparison are normalized differently:
 * aliases are stored as {@link normalize} keys and statements are stored raw.
 * The moment the surviving page spells a name the way a mail client does
 * (`O’Brien`) and the alias holds the way a keyboard does (`o'brien`), the probe
 * returns nothing, this function answers "no", and reconciliation **deletes an
 * edge another live page still states**. It is silent — no error, no log, one
 * fewer answer to "who does Ronan work with" — which is exactly the drift the
 * normalizer's own docstring names as the failure with no symptom. A second
 * normalizer written in SQL to close it would be that same failure one layer
 * down, so the comparison is done here, in JavaScript, against the one module.
 *
 * **The scan is bounded, and running out is not a licence to delete.** Nothing
 * links a fact to an edge — that is the schema's deliberate choice and the
 * reason edges are recomputed rather than page-deleted — so the exact question
 * is a scan over live statements. It stops at {@link RECONCILE_SCAN_LIMIT} and
 * answers **true** when it does: an edge kept without proof is a stale answer
 * the next edit reconsiders, and an edge deleted without proof is knowledge
 * gone. The two are not symmetric, so the give-up branch takes the recoverable
 * one.
 */
async function stillImplied(db: SQL, edge: ResolvedEdge, scanLimit: number): Promise<boolean> {
  const keysFor = async (entityId: string): Promise<string[]> => {
    const rows = (await db`
      SELECT alias FROM entity_alias WHERE entity_id = ${entityId}::bigint
      UNION
      SELECT canonical_name FROM entity WHERE entity_id = ${entityId}::bigint
    `) as Array<{ alias: string }>;
    const keys = new Set<string>();
    for (const row of rows) {
      const key = normalize(row.alias);
      if (key.length > 0) keys.add(key);
    }
    return [...keys];
  };

  const subjectKeys = await keysFor(edge.subjectId);
  const objectKeys = await keysFor(edge.objectId);
  if (subjectKeys.length === 0 || objectKeys.length === 0) return false;

  const target = edgeKey(edge);
  let after = '0';
  let scanned = 0;

  for (;;) {
    // Checked before the read, so "gave up" and "found nothing" are distinct
    // states rather than the same `false` arrived at two ways.
    if (scanned >= scanLimit) return true;

    const rows = (await db`
      SELECT fact_id::text AS fact_id, statement FROM fact
       WHERE deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL
         AND fact_id > ${after}::bigint
       ORDER BY fact_id
       LIMIT ${RECONCILE_SCAN_BATCH}
    `) as Array<{ fact_id: string; statement: string }>;
    if (rows.length === 0) return false;

    for (const row of rows) {
      after = row.fact_id;
      scanned += 1;
      // The cheap half of the exact test: a statement that implies this edge
      // must mention a name of each endpoint, and "mention" is a question about
      // keys, not about bytes.
      const key = normalize(row.statement);
      if (!subjectKeys.some((name) => key.includes(name))) continue;
      if (!objectKeys.some((name) => key.includes(name))) continue;

      // Re-extraction is the decider, exactly as before: string overlap is a
      // filter, never a verdict.
      const fact = extractFromStatement(row.statement);
      if (fact === null) continue;
      for (const implied of impliedEdges([fact])) {
        const subject = await findEntityByName(db, implied.subject.name);
        const object = await findEntityByName(db, implied.object.name);
        if (subject === null || object === null) continue;
        const found = edgeKey({
          subjectId: subject.entityId,
          objectId: object.entityId,
          edgeType: implied.edgeType,
        });
        if (found === target) return true;
      }
    }
  }
}

export interface ReconcileRequest {
  /** The facts the page states now. */
  readonly facts: readonly ExtractedFact[];
  /** The statements it stated before this write. Empty for a new page. */
  readonly previousStatements: readonly string[];
  readonly origins: readonly string[];
  readonly taxonomyVersion: number;
  /**
   * Fires as the two declared phases begin, so the write path's phase recorder
   * reflects what this function actually did rather than bracketing the call.
   */
  readonly onPhase?: (phase: 'resolve_entities' | 'reconcile_edges') => void;
  /**
   * Live statements one removal check may read before it gives up and keeps the
   * edge. Defaults to {@link RECONCILE_SCAN_LIMIT}; present so the give-up
   * branch is reachable from a test without building a corpus that size, since
   * a branch nothing has watched fire is not a branch.
   */
  readonly scanLimit?: number;
}

export interface ReconcileResult {
  readonly added: number;
  readonly removed: number;
  readonly kept: number;
  /** Names the admission fence declined to create on this pass. */
  readonly refused: number;
  /** Which rules did the declining, so the vocabulary is auditable from a log line. */
  readonly refusedBySignal: Readonly<Record<string, number>>;
}

/** Folds a refusal list into the two counters {@link ReconcileResult} carries. */
export function countRefusals(refused: readonly RefusedName[]): {
  refused: number;
  refusedBySignal: Record<string, number>;
} {
  const refusedBySignal: Record<string, number> = {};
  for (const row of refused) {
    for (const signal of row.signals) {
      refusedBySignal[signal] = (refusedBySignal[signal] ?? 0) + 1;
    }
  }
  return { refused: refused.length, refusedBySignal };
}

/**
 * Brings the edge set into agreement with the live facts.
 *
 * Must run **after** the page's new facts are written and its old ones are
 * superseded or tombstoned: {@link stillImplied} reads the live fact set, so
 * running it earlier would ask the question of a state that no longer exists.
 */
export async function reconcileEdges(db: SQL, request: ReconcileRequest): Promise<ReconcileResult> {
  const desired = new Map<string, ResolvedEdge>();
  request.onPhase?.('resolve_entities');

  // One batched, gated resolution for the whole page rather than two round
  // trips per implied edge. Two dividends: the fence reaches the write path,
  // and the cost shape `docs/deploy.md` complains about — `2 x (2..6)` per
  // edge — collapses to the batch `resolveOrCreateEntities` was written for.
  const implied = impliedEdges(request.facts);
  const evidence = corpusEvidence([
    ...request.facts.map((fact) => fact.statement),
    ...request.previousStatements,
  ]);
  const { entities, refused } = await resolveOrCreateEntities(
    db,
    implied.flatMap((edge) => [
      {
        name: edge.subject.name,
        type: edge.subject.type,
        origins: request.origins,
        taxonomyVersion: request.taxonomyVersion,
      },
      {
        name: edge.object.name,
        type: edge.object.type,
        origins: request.origins,
        taxonomyVersion: request.taxonomyVersion,
      },
    ]),
    { evidence },
  );

  for (const edge of implied) {
    const subject = entities.get(normalize(edge.subject.name));
    const object = entities.get(normalize(edge.object.name));
    // An endpoint the fence refused takes its edge with it. Nothing is removed
    // by this: an edge whose endpoint does not exist never existed either.
    if (subject === undefined || object === undefined) continue;
    // The schema refuses a self-loop; two surface forms of one thing resolving
    // to the same entity is the ordinary way one is reached.
    if (subject.entityId === object.entityId) continue;
    const resolved: ResolvedEdge = {
      subjectId: subject.entityId,
      objectId: object.entityId,
      edgeType: edge.edgeType,
      confidence: edge.confidence,
      origins: union(subject.originContexts, object.originContexts),
    };
    desired.set(edgeKey(resolved), resolved);
  }

  request.onPhase?.('reconcile_edges');

  // What this page used to say. Resolution is lookup-only: an entity that no
  // longer exists cannot be the endpoint of an edge that still does.
  const previous = new Map<string, ResolvedEdge>();
  for (const statement of request.previousStatements) {
    const fact = extractFromStatement(statement);
    if (fact === null) continue;
    for (const implied of impliedEdges([fact])) {
      const subject = await findEntityByName(db, implied.subject.name);
      const object = await findEntityByName(db, implied.object.name);
      if (subject === null || object === null || subject.entityId === object.entityId) continue;
      const resolved: ResolvedEdge = {
        subjectId: subject.entityId,
        objectId: object.entityId,
        edgeType: implied.edgeType,
        confidence: implied.confidence,
        origins: union(subject.originContexts, object.originContexts),
      };
      previous.set(edgeKey(resolved), resolved);
    }
  }

  const scanLimit = request.scanLimit ?? RECONCILE_SCAN_LIMIT;
  let removed = 0;
  for (const [key, edge] of previous) {
    if (desired.has(key)) continue;
    if (await stillImplied(db, edge, scanLimit)) continue;
    const [subject, object] = orient(edge.subjectId, edge.objectId, edge.edgeType);
    const result = (await db`
      UPDATE entity_edge SET deleted_at = now()
       WHERE deleted_at IS NULL
         AND subject_entity_id = ${subject}::bigint
         AND edge_type = ${edge.edgeType}
         AND object_entity_id = ${object}::bigint
      RETURNING edge_id
    `) as unknown[];
    removed += result.length;
  }

  let added = 0;
  let kept = 0;
  for (const edge of desired.values()) {
    const [subject, object] = orient(edge.subjectId, edge.objectId, edge.edgeType);
    const inserted = (await db`
      INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts, confidence)
      SELECT ${subject}::bigint, ${edge.edgeType}, ${object}::bigint, ${textArrayLiteral([...edge.origins])}::text[], ${edge.confidence}
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

  return { added, removed, kept, ...countRefusals(refused) };
}
