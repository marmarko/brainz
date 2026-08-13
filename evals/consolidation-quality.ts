/**
 * What "consolidation improved the brain" means, as two numbers.
 *
 * U11's verification asks for a free-tier cycle that "still improves dedup/links
 * measurably on the eval corpus". Measurably needs an instrument, and the
 * instrument has to be one that a cycle cannot game by deleting things: both
 * counts below are *defects*, and both are paired in the caller's assertions
 * with a count of what must survive.
 *
 *   - **Duplicate fact groups.** Live facts that state the same claim, under the
 *     same credential, more than once. Same credential is the whole definition:
 *     the same claim from two credentials is two attestations R12a needs, and a
 *     pass that collapsed them would score better here while destroying the
 *     corroboration signal. So they are not counted as defects.
 *   - **Unsupported edges.** Live typed edges that no live fact implies. Edges
 *     are a projection of live facts (`src/core/write/links.ts`), so an edge with
 *     no live statement behind it is an answer the brain gives with nothing to
 *     point at.
 *
 * Both are computed **in this module rather than in SQL**, because both turn on
 * the shared normalizer and on the deterministic extractor — the two things a
 * SQL-side approximation would have to reimplement. `links.ts` names that
 * reimplementation as the failure with no symptom.
 */

import type { SQL } from 'bun';

import { extractFromStatement } from '../src/core/write/extract.ts';
import { impliedEdges } from '../src/core/write/links.ts';
import { normalize } from '../src/core/write/normalize.ts';

export interface QualityReport {
  /** Live facts, for context: a report of zero defects over zero rows is not a pass. */
  readonly liveFacts: number;
  readonly liveEdges: number;
  /** Live facts beyond the first in each (normalized statement, origin set) group. */
  readonly duplicateFacts: number;
  /** Distinct (statement, origin set) groups with more than one member. */
  readonly duplicateGroups: number;
  /** Live edges no live fact implies. */
  readonly unsupportedEdges: number;
  /**
   * Edges the live facts imply that no live row carries.
   *
   * The other half of "the graph agrees with the facts", and the half an
   * unreconciled brain actually exhibits: the write path's reconciler is
   * page-scoped, so an edge two pages jointly imply is only ever written by
   * whichever page's write ran the projection. A pass that only ever deleted
   * would score perfectly on {@link unsupportedEdges} and answer no questions.
   */
  readonly missingEdges: number;
  /** Live edges some live fact implies. Paired with the above so a pass that
   * deleted the graph is visible rather than flattering. */
  readonly supportedEdges: number;
}

interface FactRow {
  readonly statement: string;
  readonly origin_contexts: string[];
}

interface EdgeRow {
  readonly edge_type: string;
  readonly subject: string;
  readonly object: string;
}

/** Every live edge, named by its endpoints' canonical names rather than by id. */
async function liveEdgeKeys(sql: SQL): Promise<Set<string>> {
  const rows = (await sql`
    SELECT e.edge_type, s.canonical_name AS subject, o.canonical_name AS object
      FROM entity_edge e
      JOIN entity s ON s.entity_id = e.subject_entity_id
      JOIN entity o ON o.entity_id = e.object_entity_id
     WHERE e.deleted_at IS NULL AND s.deleted_at IS NULL AND o.deleted_at IS NULL
  `) as EdgeRow[];

  const keys = new Set<string>();
  for (const row of rows) {
    keys.add(edgeKey(row.subject, row.edge_type, row.object));
  }
  return keys;
}

/**
 * Undirected for symmetric types, directed otherwise — the same orientation rule
 * `links.ts` applies when it stores them, so a supported edge is not counted as
 * unsupported for having been stored the other way round.
 */
function edgeKey(subject: string, edgeType: string, object: string): string {
  const left = normalize(subject);
  const right = normalize(object);
  if (edgeType === 'related_to') {
    return left <= right ? `${left}|${edgeType}|${right}` : `${right}|${edgeType}|${left}`;
  }
  return `${left}|${edgeType}|${right}`;
}

export async function measureConsolidationQuality(sql: SQL): Promise<QualityReport> {
  const facts = (await sql`
    SELECT statement, origin_contexts
      FROM fact
     WHERE deleted_at IS NULL AND quarantined_at IS NULL AND superseded_by IS NULL
  `) as FactRow[];

  const groups = new Map<string, number>();
  const implied = new Set<string>();

  for (const fact of facts) {
    const key = JSON.stringify([normalize(fact.statement), [...fact.origin_contexts].sort()]);
    groups.set(key, (groups.get(key) ?? 0) + 1);

    const extracted = extractFromStatement(fact.statement);
    if (extracted === null) continue;
    for (const edge of impliedEdges([extracted])) {
      implied.add(edgeKey(edge.subject.name, edge.edgeType, edge.object.name));
    }
  }

  let duplicateFacts = 0;
  let duplicateGroups = 0;
  for (const count of groups.values()) {
    if (count <= 1) continue;
    duplicateGroups += 1;
    duplicateFacts += count - 1;
  }

  const live = await liveEdgeKeys(sql);
  let supportedEdges = 0;
  let unsupportedEdges = 0;
  for (const key of live) {
    if (implied.has(key)) supportedEdges += 1;
    else unsupportedEdges += 1;
  }

  let missingEdges = 0;
  for (const key of implied) {
    if (!live.has(key)) missingEdges += 1;
  }

  return {
    liveFacts: facts.length,
    liveEdges: live.size,
    duplicateFacts,
    duplicateGroups,
    unsupportedEdges,
    missingEdges,
    supportedEdges,
  };
}
