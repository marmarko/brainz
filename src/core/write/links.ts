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

import { extractFromStatement, type ExtractedFact, type Predicate } from './extract.ts';
import { normalize, slugify } from './normalize.ts';
import { textArrayLiteral } from './pg-values.ts';

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
 * Alias first, then the slug namespace — the read path's ladder, applied on the
 * write side so that both sides resolve a name the same way. A redirect
 * resolves here exactly as a canonical slug does, which is the whole reason
 * redirects share the namespace.
 */
export async function findEntityByName(db: SQL, name: string): Promise<EntityRow | null> {
  const key = normalize(name);
  if (key.length === 0) return null;

  const byAlias = (await db`
    SELECT e.entity_id::text AS entity_id, e.canonical_name, e.origin_contexts
      FROM entity_alias a
      JOIN entity e ON e.entity_id = a.entity_id
     WHERE lower(a.alias) = ${key}
       AND e.deleted_at IS NULL
     ORDER BY e.entity_id
     LIMIT 1
  `) as RawEntity[];
  if (byAlias[0] !== undefined) return toEntity(byAlias[0]);

  const bySlug = (await db`
    SELECT e.entity_id::text AS entity_id, e.canonical_name, e.origin_contexts
      FROM entity_slug s
      JOIN entity e ON e.entity_id = s.entity_id
     WHERE s.slug = ${slugify(name)}
       AND e.deleted_at IS NULL
     LIMIT 1
  `) as RawEntity[];
  return bySlug[0] === undefined ? null : toEntity(bySlug[0]);
}

/** A free slug in the addressing namespace, derived from the name. */
async function availableSlug(db: SQL, name: string): Promise<string> {
  const base = slugify(name);
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base.slice(0, 120)}-${attempt + 1}`;
    const taken = (await db`SELECT 1 AS taken FROM entity_slug WHERE slug = ${candidate}`) as Array<{
      taken: number;
    }>;
    if (taken.length === 0) return candidate;
  }
  throw new Error(`no free slug for '${name}' after 64 attempts`);
}

function union(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])].sort();
}

/**
 * Replaces an entity with a successor carrying the wider origin union.
 *
 * The cascade is the price of R15's immutability and every step of it is
 * load-bearing: the slug moves so the entity keeps its address, the aliases
 * move so recall keeps working, and the live edges are rewritten because
 * `entity_edge.origin_contexts` is immutable too *and* the union trigger would
 * refuse an edge narrower than its new endpoint. A live edge left pointing at
 * the tombstoned row is a graph walk into a row nothing else can reach.
 */
async function widenEntityOrigins(
  db: SQL,
  entity: EntityRow,
  origins: readonly string[],
): Promise<EntityRow> {
  const widened = union(entity.originContexts, origins);

  const created = (await db`
    INSERT INTO entity (canonical_name, entity_type, taxonomy_version, origin_contexts,
                        subject_context, subject_confidence)
    SELECT canonical_name, entity_type, taxonomy_version, ${textArrayLiteral(widened)}::text[],
           subject_context, subject_confidence
      FROM entity WHERE entity_id = ${entity.entityId}::bigint
    RETURNING entity_id::text AS entity_id, canonical_name, origin_contexts
  `) as RawEntity[];

  const successor = created[0];
  if (successor === undefined) throw new Error(`could not widen entity ${entity.entityId}`);

  await db`UPDATE entity_slug SET entity_id = ${successor.entity_id}::bigint WHERE entity_id = ${entity.entityId}::bigint`;
  await db`UPDATE entity_alias SET entity_id = ${successor.entity_id}::bigint WHERE entity_id = ${entity.entityId}::bigint`;

  const edges = (await db`
    SELECT edge_id::text AS edge_id, subject_entity_id::text AS subject_entity_id,
           edge_type, object_entity_id::text AS object_entity_id,
           origin_contexts, confidence
      FROM entity_edge
     WHERE deleted_at IS NULL
       AND (subject_entity_id = ${entity.entityId}::bigint OR object_entity_id = ${entity.entityId}::bigint)
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
    // over live rows, so the replacement cannot be inserted alongside it.
    await db`UPDATE entity_edge SET deleted_at = now() WHERE edge_id = ${edge.edge_id}::bigint`;
    const subject =
      edge.subject_entity_id === entity.entityId ? successor.entity_id : edge.subject_entity_id;
    const object =
      edge.object_entity_id === entity.entityId ? successor.entity_id : edge.object_entity_id;
    await db`
      INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts, confidence)
      VALUES (${subject}::bigint, ${edge.edge_type}, ${object}::bigint,
              ${textArrayLiteral(union(edge.origin_contexts, widened))}::text[], ${edge.confidence})
    `;
  }

  await db`UPDATE entity SET deleted_at = now() WHERE entity_id = ${entity.entityId}::bigint`;

  return toEntity(successor);
}

export interface ResolveEntityRequest {
  readonly name: string;
  readonly type: EntityType;
  readonly origins: readonly string[];
  readonly taxonomyVersion: number;
}

/**
 * The entity a name refers to, creating it if the brain has not seen it.
 *
 * Every path leaves the same three things true: the entity exists, its origin
 * union covers the write that mentioned it, and the normalized surface form is
 * in its alias vocabulary.
 */
export async function resolveOrCreateEntity(
  db: SQL,
  request: ResolveEntityRequest,
): Promise<EntityRow> {
  const key = normalize(request.name);
  if (key.length === 0) throw new Error('an entity needs a name');

  const found = await findEntityByName(db, request.name);
  if (found !== null) {
    const missing = request.origins.filter((origin) => !found.originContexts.includes(origin));
    const current = missing.length === 0 ? found : await widenEntityOrigins(db, found, missing);
    await db`
      INSERT INTO entity_alias (entity_id, alias, alias_source, confidence)
      VALUES (${current.entityId}::bigint, ${key}, 'inferred', ${INFERRED_ALIAS_CONFIDENCE})
      ON CONFLICT (entity_id, alias) DO NOTHING
    `;
    return current;
  }

  const created = (await db`
    INSERT INTO entity (canonical_name, entity_type, taxonomy_version, origin_contexts)
    VALUES (${request.name}, ${request.type}, ${request.taxonomyVersion},
            ${textArrayLiteral([...new Set(request.origins)].sort())}::text[])
    RETURNING entity_id::text AS entity_id, canonical_name, origin_contexts
  `) as RawEntity[];

  const entity = created[0];
  if (entity === undefined) throw new Error(`could not create entity '${request.name}'`);

  await db`
    INSERT INTO entity_slug (slug, entity_id, kind)
    VALUES (${await availableSlug(db, request.name)}, ${entity.entity_id}::bigint, 'canonical')
  `;
  await db`
    INSERT INTO entity_alias (entity_id, alias, alias_source, confidence)
    VALUES (${entity.entity_id}::bigint, ${key}, 'inferred', ${INFERRED_ALIAS_CONFIDENCE})
    ON CONFLICT (entity_id, alias) DO NOTHING
  `;

  return toEntity(entity);
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

  for (const implied of impliedEdges(request.facts)) {
    const subject = await resolveOrCreateEntity(db, {
      name: implied.subject.name,
      type: implied.subject.type,
      origins: request.origins,
      taxonomyVersion: request.taxonomyVersion,
    });
    const object = await resolveOrCreateEntity(db, {
      name: implied.object.name,
      type: implied.object.type,
      origins: request.origins,
      taxonomyVersion: request.taxonomyVersion,
    });
    // The schema refuses a self-loop; two surface forms of one thing resolving
    // to the same entity is the ordinary way one is reached.
    if (subject.entityId === object.entityId) continue;
    const resolved: ResolvedEdge = {
      subjectId: subject.entityId,
      objectId: object.entityId,
      edgeType: implied.edgeType,
      confidence: implied.confidence,
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

  return { added, removed, kept };
}
