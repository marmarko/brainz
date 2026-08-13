/**
 * Stage 3 — the three recall arms, over a tenant Postgres database.
 *
 * **What is in this file and what deliberately is not.** The arms are the only
 * part of the retrieval stack that knows what a database is. Everything after
 * them — fusion, the alias ladder, the boosts, dedup, packing, rerank, autocut —
 * is a pure function of {@link RecallOutcome}, which is what lets U7's
 * synchronous fixture eval grade *the same* accuracy stack the fleet runs
 * instead of a re-implementation that happens to agree. The audit's central
 * finding is that the accuracy is in the stages after retrieval; the split here
 * is what stops those stages from existing twice.
 *
 * **The vector arm asks for a pool, not for results, and the difference is
 * hazard H1.** `candidatePoolFor` in `src/schema/vector-query.ts` exists as a
 * named function precisely so an arm passing a bare `limit` is a visible
 * mistake: `hnsw.ef_search` sizes the HNSW candidate list, so passing `limit =
 * 10` sets the pool to ten — below even pgvector's own default of forty — and
 * every hazard guard stays green while RRF fuses a truncated universe. The pool
 * is computed **once**, here, and used for both the GUC and the `LIMIT`, so the
 * mutation "pool → limit" is a single token and `arms.test.ts` measures its
 * effect rather than asserting the source text.
 *
 * **Every arm carries the fence itself.** R15's origin predicate, R12's soft
 * delete and U9's quarantine are in every statement below, on both the chunk and
 * its page — a chunk whose page was tombstoned is as invisible as a tombstoned
 * chunk. They are not applied afterwards in TypeScript, for the reason hazard H3
 * documents: the predicates run *after* the HNSW scan, so they consume the
 * candidate budget, and an arm that filtered in the application would return a
 * pool of the wrong size *and* leak until the filter ran.
 *
 * **Degradation is a value, not an exception (Assumption 5).** The query
 * embedding is the read path's only external dependency before U12. When it
 * fails, {@link runArms} drops the vector arm, fuses what is left, and reports
 * `embedding_unavailable`. A provider 429 must not read to a user as "the brain
 * is down" — three arms exist precisely so one can fail.
 */

import type { SQL, TransactionSQL } from 'bun';

import { candidatePoolFor, withVectorScan } from '../../schema/vector-query.ts';
import { textArrayLiteral } from '../write/pg-values.ts';
import { grantSet, type Grant } from './fence.ts';
import { normalizeQuery } from './normalize.ts';
import type {
  ArmName,
  ArmResult,
  Attestation,
  Candidate,
  Degradation,
  SourceType,
} from './types.ts';

/**
 * The default when a chunk predates rung two and has no page.
 *
 * `document` rather than `email`: the source-type prior treats documents as
 * neutral, so an unattributable row neither gains nor loses rank from a fact
 * nobody recorded.
 */
export const DEFAULT_SOURCE_TYPE: SourceType = 'document';

/**
 * Which channel a page's `source_type` implies (R12a).
 *
 * **Two classes, and the split is about who can write, not about quality.**
 * Mail, calendar invites, chat messages, web captures and transcripts of calls
 * are all things an outside party can put into the brain unbidden — that is
 * R12a's "every alpha source is writable by unauthenticated outsiders". Notes,
 * files and documents are the user's own store; better, and still not an
 * attestation, because a shared drive file is writable by whoever shared it.
 *
 * Neither class corroborates anything. Corroboration needs an
 * origin the external sender cannot also write, which means an explicit
 * `user_out_of_band` or `internal` attestation — a record U12/U14/U15 create and
 * that no `source_type` can stand in for. That is the whole point of keeping
 * this table small: a bigger one would be a way to promote a claim by choosing
 * its source type.
 */
export const CHANNEL_BY_SOURCE_TYPE: Readonly<Record<SourceType, Attestation['channel']>> = {
  email: 'external',
  calendar: 'external',
  chat: 'external',
  web: 'external',
  transcript: 'external',
  note: 'user_curated',
  file: 'user_curated',
  document: 'user_curated',
};

/**
 * Who wrote an externally-sourced row, for R12a's collapse rule.
 *
 * A mail message and the calendar event auto-derived from it are **one** origin,
 * because the same sender produced both — so the derived row must carry its
 * root's sender, not its own surface's. Connectors (U9) record that in
 * `external_ref`; until they do, this falls back to the origin context, which
 * collapses *every* external row under one credential into one attestation.
 * That fallback is deliberate and it is the fail-closed direction: it can only
 * ever under-count independent origins, never manufacture one.
 */
export function senderKeyFor(input: {
  readonly externalRef: string | null;
  readonly origin: string;
}): string {
  const match = input.externalRef?.match(/(?:^|[?&;])sender=([^&;\s]+)/);
  if (match?.[1] !== undefined) return `sender:${normalizeQuery(match[1])}`;
  return `origin:${input.origin}`;
}

// ---------------------------------------------------------------------------
// Row hydration.
// ---------------------------------------------------------------------------

interface ChunkRow {
  readonly id: string;
  readonly page_id: string | null;
  readonly ordinal: number | null;
  readonly content: string;
  readonly origin_context: string;
  readonly subject_context: string | null;
  readonly subject_confidence: number | null;
  readonly title: string | null;
  readonly source_type: string | null;
  readonly external_ref: string | null;
  readonly created_at: string;
}

/**
 * The predicate every read carries, as one string, so the four statements below
 * cannot drift apart. `$1` is always the grant array.
 */
const LIVE_AND_IN_GRANT = `c.deleted_at IS NULL
       AND c.quarantined_at IS NULL
       AND c.origin_context = ANY($1::text[])
       AND (p.page_id IS NULL OR (p.deleted_at IS NULL AND p.quarantined_at IS NULL))`;

function toCandidate(row: ChunkRow, entityIds: readonly string[] = []): Candidate {
  const sourceType = (row.source_type ?? DEFAULT_SOURCE_TYPE) as SourceType;
  const channel = CHANNEL_BY_SOURCE_TYPE[sourceType] ?? 'user_curated';
  return {
    id: row.id,
    pageId: row.page_id ?? `chunk:${row.id}`,
    ordinal: row.ordinal ?? 0,
    title: row.title,
    content: row.content,
    origin: row.origin_context,
    ...(row.subject_context !== null && row.subject_confidence !== null
      ? { subject: { context: row.subject_context, confidence: row.subject_confidence } }
      : {}),
    sourceType,
    createdAt: typeof row.created_at === 'string' ? row.created_at : new Date(row.created_at).toISOString(),
    live: true,
    attestations: [
      {
        channel,
        ...(channel === 'external'
          ? { senderKey: senderKeyFor({ externalRef: row.external_ref, origin: row.origin_context }) }
          : {}),
      },
    ],
    entityIds,
  };
}

const CHUNK_COLUMNS = `c.chunk_id::text AS id,
         c.page_id::text AS page_id,
         c.ordinal,
         c.content,
         c.origin_context,
         c.subject_context,
         c.subject_confidence,
         p.title,
         p.source_type,
         p.external_ref,
         coalesce(p.created_at, c.created_at)::text AS created_at`;

/** Hydrate ids into fenced, live candidates. Ids the fence rejects simply vanish. */
export async function hydrate(
  sql: SQL,
  ids: readonly string[],
  grant: Grant,
): Promise<Map<string, Candidate>> {
  const out = new Map<string, Candidate>();
  if (ids.length === 0 || grant.length === 0) return out;

  const rows = (await sql.unsafe(
    `SELECT ${CHUNK_COLUMNS}
       FROM chunk c
       LEFT JOIN page p ON p.page_id = c.page_id
      WHERE c.chunk_id = ANY($2::bigint[])
        AND ${LIVE_AND_IN_GRANT}`,
    [textArrayLiteral(grant), textArrayLiteral(ids)],
  )) as ChunkRow[];

  for (const row of rows) out.set(row.id, toCandidate(row));
  return out;
}

// ---------------------------------------------------------------------------
// Arm 1 — vector.
// ---------------------------------------------------------------------------

/**
 * The vector arm's statement, exported so the guard cannot drift from the arm.
 *
 * `test/core/search/arms.test.ts` runs this same text with a deliberately
 * mis-sized pool as its control, which is what makes "the pool sizing matters"
 * a measurement rather than a source-code assertion.
 */
export function vectorArmSql(): string {
  return `SELECT ${CHUNK_COLUMNS}
       FROM chunk c
       LEFT JOIN page p ON p.page_id = c.page_id
      WHERE c.embedding IS NOT NULL
        AND ${LIVE_AND_IN_GRANT}
      ORDER BY c.embedding <=> $2::vector
      LIMIT $3`;
}

export interface VectorArmRequest {
  readonly queryVector: readonly number[];
  readonly grant: Grant;
  readonly limit: number;
  readonly offset?: number;
}

/**
 * Nearest neighbours over `chunk.embedding`, inside `withVectorScan`.
 *
 * The pool is {@link candidatePoolFor}'s arithmetic — `offset + max(limit * 5,
 * 100)` — computed once and used for the GUC *and* the `LIMIT`. Every guard in
 * `test/hazards/` pins the helper's transaction mechanics; what they cannot pin
 * is that a caller asked for a pool rather than for a page of results, which is
 * this function's responsibility and the reason the pool is a local constant.
 */
export async function vectorArm(
  sql: SQL,
  request: VectorArmRequest,
): Promise<{ ranked: string[]; candidates: Map<string, Candidate> }> {
  const pool = candidatePoolFor({ limit: request.limit, offset: request.offset ?? 0 });
  return runVectorScan(sql, request, pool);
}

/**
 * The body of {@link vectorArm}, with the pool passed in.
 *
 * Separated for exactly one reason: the guard needs to run the identical query
 * with a *wrong* pool to show that the right one is doing work. Production has
 * one caller and it is the function above.
 */
export async function runVectorScan(
  sql: SQL,
  request: VectorArmRequest,
  pool: number,
): Promise<{ ranked: string[]; candidates: Map<string, Candidate> }> {
  const literal = `[${request.queryVector.join(',')}]`;

  const rows = await withVectorScan(sql, { candidatePool: pool }, async (tx: TransactionSQL) => {
    return (await tx.unsafe(vectorArmSql(), [textArrayLiteral(request.grant), literal, pool])) as ChunkRow[];
  });

  const candidates = new Map<string, Candidate>();
  const ranked: string[] = [];
  for (const row of rows) {
    candidates.set(row.id, toCandidate(row));
    ranked.push(row.id);
  }
  return { ranked, candidates };
}

// ---------------------------------------------------------------------------
// Arm 2 — full text.
// ---------------------------------------------------------------------------

/**
 * The tenant's FTS configuration, read rather than assumed (KTD9).
 *
 * An English default applied to a Spanish brain is the silent-wrong-answer
 * failure KTD9 forbids, and the write side already baked the choice into a
 * generated column — so a read that guessed would be querying one language's
 * index with another language's stems. There is no fallback: a tenant with no
 * setting row is a tenant that was never provisioned.
 */
export async function readFtsLanguage(sql: SQL): Promise<string> {
  const rows = (await sql`SELECT fts_language FROM tenant_setting LIMIT 1`) as Array<{
    fts_language: string;
  }>;
  const language = rows[0]?.fts_language;
  if (language === undefined) {
    throw new Error('tenant_setting has no fts_language row; the tenant is not provisioned (KTD9)');
  }
  return language;
}

export interface FtsArmRequest {
  readonly query: string;
  readonly grant: Grant;
  readonly limit: number;
  readonly offset?: number;
  readonly ftsLanguage: string;
}

/**
 * `websearch_to_tsquery` over the chunk body, with the page title admitted to
 * *recall* at a discount.
 *
 * The discount is the interesting decision. A page whose title carries the
 * asked-for phrase and whose body does not must still be recallable, or the
 * title-phrase boost has nothing to boost — a boost cannot promote a row no arm
 * returned. But ranking primarily on the title here would make this arm a
 * title-matcher, and the twenty title-substring probes in U7's corpus are
 * exactly the case where a body-text decoy repeats the title's words more
 * densely than the titled page does. So: recall on either field, order on the
 * body with the title at 0.4, and leave the actual title *signal* to stage 6,
 * which is ordered-phrase-aware and cannot be fooled by term density.
 *
 * `websearch_to_tsquery` rather than `plainto_tsquery` because it never raises
 * on user punctuation — a read surface takes whatever arrives.
 */
export async function ftsArm(
  sql: SQL,
  request: FtsArmRequest,
): Promise<{ ranked: string[]; candidates: Map<string, Candidate> }> {
  const pool = candidatePoolFor({ limit: request.limit, offset: request.offset ?? 0 });

  const rows = (await sql.unsafe(
    `WITH q AS (SELECT websearch_to_tsquery($2::regconfig, $3) AS tsq)
     SELECT ${CHUNK_COLUMNS},
            ts_rank_cd(c.content_tsv, q.tsq)
              + 0.4 * coalesce(ts_rank_cd(p.title_tsv, q.tsq), 0) AS score
       FROM chunk c
       LEFT JOIN page p ON p.page_id = c.page_id
       CROSS JOIN q
      WHERE (c.content_tsv @@ q.tsq OR p.title_tsv @@ q.tsq)
        AND ${LIVE_AND_IN_GRANT}
      ORDER BY score DESC, c.chunk_id
      LIMIT $4`,
    [textArrayLiteral(request.grant), request.ftsLanguage, request.query, pool],
  )) as Array<ChunkRow & { score: number }>;

  const candidates = new Map<string, Candidate>();
  const ranked: string[] = [];
  for (const row of rows) {
    candidates.set(row.id, toCandidate(row));
    ranked.push(row.id);
  }
  return { ranked, candidates };
}

// ---------------------------------------------------------------------------
// Arm 3 — graph.
// ---------------------------------------------------------------------------

export interface GraphArmRequest {
  readonly entityIds: readonly string[];
  readonly grant: Grant;
  readonly limit: number;
}

/**
 * The relational arm: from resolved entities, out along typed edges, to the
 * chunks the evidencing facts came from.
 *
 * **An arm over an empty graph is the failure the ledger row names** — it is
 * marketed at parity and measures at roughly half the precision. So the arm is
 * written against the edge supply U4 actually produces: `entity_edge` rows
 * reconciled from extracted facts, `fact` statements that mention both
 * endpoints, and `fact_source` back to chunks.
 *
 * **Two hops, ordered, and the order is the ranking.** Edge evidence first (the
 * answer to "who invested in X" is the row that states the investment), then
 * facts that merely mention the seed (the answer to "who is Sam" is whatever the
 * brain most recently asserted about Sam). Superseded facts are demoted rather
 * than dropped: a superseded statement is still the best evidence for a question
 * about the past, and dropping it here would make the temporal probes
 * unanswerable from this arm rather than merely lower-ranked.
 *
 * **The fence is subset on facts and edges, scalar on chunks** — see
 * `fence.ts`. Entities resolve on intersect, which happens one stage earlier;
 * this arm never widens that.
 */
export async function graphArm(
  sql: SQL,
  request: GraphArmRequest,
): Promise<{ ranked: string[]; candidates: Map<string, Candidate> }> {
  const empty = { ranked: [] as string[], candidates: new Map<string, Candidate>() };
  if (request.entityIds.length === 0 || request.grant.length === 0) return empty;

  const rows = (await sql.unsafe(
    `WITH seeds AS (
       SELECT unnest($2::bigint[]) AS entity_id
     ),
     neighbourhood AS (
       SELECT e.subject_entity_id AS a, e.object_entity_id AS b
         FROM entity_edge e
        WHERE e.deleted_at IS NULL
          AND e.origin_contexts <@ $1::text[]
          AND (e.subject_entity_id IN (SELECT entity_id FROM seeds)
            OR e.object_entity_id IN (SELECT entity_id FROM seeds))
     ),
     touched AS (
       SELECT entity_id FROM seeds
       UNION SELECT a FROM neighbourhood
       UNION SELECT b FROM neighbourhood
     ),
     names AS (
       SELECT t.entity_id, n.name
         FROM touched t
         JOIN LATERAL (
           SELECT e.canonical_name AS name FROM entity e
            WHERE e.entity_id = t.entity_id AND e.deleted_at IS NULL
           UNION ALL
           SELECT a.alias AS name FROM entity_alias a WHERE a.entity_id = t.entity_id
         ) n ON true
     ),
     evidence AS (
       SELECT f.fact_id,
              f.created_at,
              f.superseded_by,
              max(CASE WHEN nm.entity_id IN (SELECT entity_id FROM seeds) THEN 1 ELSE 0 END) AS hits_seed,
              count(DISTINCT nm.entity_id) AS entity_hits
         FROM fact f
         JOIN names nm ON f.statement ILIKE '%' || nm.name || '%'
        WHERE f.deleted_at IS NULL
          AND f.quarantined_at IS NULL
          AND f.origin_contexts <@ $1::text[]
        GROUP BY f.fact_id, f.created_at, f.superseded_by
       HAVING max(CASE WHEN nm.entity_id IN (SELECT entity_id FROM seeds) THEN 1 ELSE 0 END) = 1
     )
     SELECT ${CHUNK_COLUMNS}
       FROM evidence ev
       JOIN fact_source fs ON fs.fact_id = ev.fact_id
       JOIN chunk c ON c.chunk_id = fs.chunk_id
       LEFT JOIN page p ON p.page_id = c.page_id
      WHERE ${LIVE_AND_IN_GRANT}
      ORDER BY (ev.entity_hits > 1) DESC,
               (ev.superseded_by IS NULL) DESC,
               ev.created_at DESC,
               c.chunk_id
      LIMIT $3`,
    [textArrayLiteral(request.grant), textArrayLiteral(request.entityIds), Math.max(request.limit * 5, 100)],
  )) as ChunkRow[];

  const candidates = new Map<string, Candidate>();
  const ranked: string[] = [];
  for (const row of rows) {
    if (candidates.has(row.id)) continue;
    candidates.set(row.id, toCandidate(row));
    ranked.push(row.id);
  }
  return { ranked, candidates };
}

// ---------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------

export interface ArmDispatch {
  readonly sql: SQL;
  readonly query: string;
  readonly grant: Grant;
  readonly limit: number;
  readonly offset?: number;
  readonly ftsLanguage: string;
  readonly entityIds: readonly string[];
  readonly useGraphArm: boolean;
  /**
   * The query vector, or `null` when the embedding provider failed.
   *
   * `null` rather than a thrown error, and rather than a zero vector: a zero
   * vector is a *silently wrong* arm (every cosine distance against it is
   * undefined), which is the shape Assumption 5's contract exists to avoid.
   */
  readonly queryVector: readonly number[] | null;
}

export interface ArmsOutcome {
  readonly arms: readonly ArmResult[];
  readonly candidates: Map<string, Candidate>;
  readonly degraded: readonly Degradation[];
  readonly armsUsed: readonly ArmName[];
}

/**
 * Run the arms the plan asked for, and report what came back.
 *
 * The vector arm is skipped — not failed — when there is no query vector, and
 * the degradation is reported rather than thrown. That is the whole of
 * Assumption 5's availability half: `recall`, `search` and `entity` all need a
 * query embedding before RRF runs, so a provider outage would take down every
 * read tool at once unless the arm can be absent.
 */
export async function runArms(dispatch: ArmDispatch): Promise<ArmsOutcome> {
  const arms: ArmResult[] = [];
  const candidates = new Map<string, Candidate>();
  const degraded: Degradation[] = [];
  const armsUsed: ArmName[] = [];

  const absorb = (arm: ArmName, result: { ranked: string[]; candidates: Map<string, Candidate> }) => {
    arms.push({ arm, ranked: result.ranked });
    for (const [id, candidate] of result.candidates) {
      if (!candidates.has(id)) candidates.set(id, candidate);
    }
    if (result.ranked.length > 0) armsUsed.push(arm);
  };

  if (dispatch.queryVector === null) {
    degraded.push('embedding_unavailable');
  } else {
    absorb(
      'vector',
      await vectorArm(dispatch.sql, {
        queryVector: dispatch.queryVector,
        grant: dispatch.grant,
        limit: dispatch.limit,
        ...(dispatch.offset === undefined ? {} : { offset: dispatch.offset }),
      }),
    );
  }

  absorb(
    'fts',
    await ftsArm(dispatch.sql, {
      query: dispatch.query,
      grant: dispatch.grant,
      limit: dispatch.limit,
      ...(dispatch.offset === undefined ? {} : { offset: dispatch.offset }),
      ftsLanguage: dispatch.ftsLanguage,
    }),
  );

  if (dispatch.useGraphArm && dispatch.entityIds.length > 0) {
    absorb(
      'graph',
      await graphArm(dispatch.sql, {
        entityIds: dispatch.entityIds,
        grant: dispatch.grant,
        limit: dispatch.limit,
      }),
    );
  }

  return { arms, candidates, degraded, armsUsed };
}

/** Re-exported so a caller cannot reach for the arithmetic without the name. */
export { candidatePoolFor };

/** The fence, as a set, for callers that hydrate their own rows. */
export { grantSet };
