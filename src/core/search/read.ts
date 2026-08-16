/**
 * The request path: one function, from a question to a ranked answer.
 *
 * **This module exists because two things the unit promised had nowhere to
 * live.** The stages were all written and individually tested, and *nothing
 * composed them over a database* — so the query embedding was never issued, and
 * Assumption 5's degraded contract was a branch in `runArms` that no caller
 * could reach. A `null` query vector that only a test constructs is not a
 * contract; it is a parameter. What makes the promise real is the conversion
 * here: a gateway failure becomes a value, and the read continues.
 *
 * **Every model call goes through U20's gateway, by op name.** The query
 * embedding is the `embedding` op with KTD8's query-side wrap
 * (`write/embed.ts:queryEncoding`), which is the same op and the same wrap the
 * write path uses for documents — one space, two encodings. Issuing it here
 * rather than at the surface is R14's rule: the request path's spend is metered
 * through the same gateway as everything else, and a provider reached directly
 * from a read would be spend nobody sees.
 *
 * **The order is: resolve, then plan, then recall, then compose.** Resolution
 * runs before the arms because the graph arm cannot fan out without seeds, and
 * the plan is *refined* with what resolution found — which is why the plan
 * travels on the outcome rather than being recomputed downstream. See
 * `types.ts:RecallOutcome.plan`.
 */

import type { SQL } from 'bun';

import { createBudget, type Budget, type ModelGateway } from '../../ai/gateway.ts';
import type { CallerIdentity } from '../../control/secrets.ts';
import { embedTexts, queryEncoding } from '../write/embed.ts';
import { textArrayLiteral } from '../write/pg-values.ts';
import {
  aliasLadderTiers,
  mentionsIn,
  resolveEntities,
  type EntityRef,
  type LadderLookup,
  type MentionKey,
  type PageRef,
} from './alias-hop.ts';
import { hydrate, readFtsLanguage, runArms } from './arms.ts';
import type { Grant } from './fence.ts';
import { classifyIntent, planFor, refinePlan, resolutionOf } from './intent.ts';
import { normalize, normalizeQuery, tokens } from './normalize.ts';
import { composeUpToPacking, finishRanking, type ComposeRequest } from './pipeline.ts';
import { rerankPassageOf } from './rerank.ts';
import { resolveRerankStage } from './rerank-stage.ts';
import type { Candidate, Degradation, RecallOutcome, ScoredCandidate, SearchResponse } from './types.ts';

export interface RecallRequest {
  readonly sql: SQL;
  readonly gateway: ModelGateway;
  readonly tenantId: string;
  readonly caller: CallerIdentity;
  readonly budget?: Budget;
  readonly query: string;
  readonly grant: Grant;
  readonly limit: number;
  readonly offset?: number;
  /** Injected, never the wall clock — see `boosts.ts`. */
  readonly now: Date;
  readonly compose?: Omit<ComposeRequest, 'query' | 'limit' | 'now' | 'plan'>;
}

/**
 * The query vector, or the reason there isn't one.
 *
 * **A failure is a value here and that is the whole of Assumption 5's
 * availability half.** `recall`, `search` and `entity` all need a query
 * embedding before RRF runs, so a provider 429 would take down every read tool
 * at once if this threw. Three arms exist precisely so one can be absent.
 *
 * `null` rather than a zero vector, for the reason `arms.ts` gives: a zero
 * vector is a *silently wrong* arm, and the whole point is to be loudly partial
 * instead of quietly wrong.
 */
export async function embedQuery(request: {
  readonly gateway: ModelGateway;
  readonly tenantId: string;
  readonly caller: CallerIdentity;
  readonly budget?: Budget;
  readonly query: string;
}): Promise<{ readonly vector: readonly number[] | null; readonly degraded: Degradation[] }> {
  const budget = request.budget ?? readPathBudget();

  let outcome: Awaited<ReturnType<typeof embedTexts>>;
  try {
    outcome = await embedTexts({
      gateway: request.gateway,
      tenantId: request.tenantId,
      caller: request.caller,
      budget,
      texts: [queryEncoding(request.query)],
    });
  } catch {
    // The gateway reports transport failures as `{ ok: false }`, but a
    // configuration or key-resolution error still throws — and on the read path
    // those are the same event to a user: no vector. Catching here rather than
    // letting one class through is deliberate; a read that 500s because a key
    // rotated is the outage this contract exists to prevent.
    return { vector: null, degraded: ['embedding_unavailable'] };
  }

  if (!outcome.ok) return { vector: null, degraded: ['embedding_unavailable'] };
  const vector = outcome.vectors[0];
  if (vector === undefined) return { vector: null, degraded: ['embedding_unavailable'] };
  return { vector, degraded: [] };
}

/**
 * What one read may spend, in micro-USD, when the caller sets no budget of its
 * own.
 *
 * **Derived, not chosen.** The worst *legitimate* read is two calls, and both
 * are bounded by constants in this package:
 *
 *   - the cross-encoder sees at most `RERANK_CANDIDATES_DEFAULT` (100) passages
 *     of about `TARGET_CHUNK_CHARS` (1,800) characters, which the gateway
 *     estimates at 4 characters per token — 45,000 tokens, and
 *     `@cf/baai/bge-reranker-base` is priced at 3,000 µUSD per million input
 *     tokens: **~135 µUSD**;
 *   - the query embedding is one short string through
 *     `text-embedding-3-large` at 130,000 µUSD per million — a generous
 *     4,000-character query is 1,000 tokens: **~130 µUSD**.
 *
 * So ~265 µUSD is the ceiling of ordinary, and this is roughly ten times it.
 * The margin is the point: a cap that fires on a legitimate read is a search
 * outage, and a cap an order of magnitude above the worst legitimate read still
 * turns a pathological one — a caller feeding a megabyte of "query" — into a
 * degraded answer rather than an invoice.
 */
export const READ_PATH_BUDGET_MICRO_USD = 3_000;

/**
 * A fresh budget for one read.
 *
 * **A function, never a module constant.** A single `Budget` at module scope
 * with a finite cap is a *process-lifetime* budget: it accumulates across every
 * request the instance ever serves, and once it fills, every read from that
 * instance degrades forever, with nothing in the response explaining why. That
 * is a strictly worse failure than the uncapped budget this replaced, and it is
 * the shape the previous constant would have taken if a cap had simply been
 * written into it.
 *
 * **What this is not.** It is a *per-request* ceiling and nothing more. There is
 * **no tenant-level cap on the request path at all** — this comment used to say
 * that the caps that mattered were "the tenant-level ones the gateway's meter
 * enforces", and no such layer exists: `createPostgresSpendMeter` accumulates
 * `spend_micro_usd` and has no way to refuse a call. The two readers that do
 * enforce a tenant ceiling — `first-import.ts:readHeadroom` and
 * `tier.ts:consolidationTierOf` — are on the ingest and consolidation paths and
 * are never consulted here. A tenant may therefore issue unboundedly many
 * bounded reads, and the honest statement of this module's protection is "one
 * request cannot run away", not "a tenant cannot".
 */
function readPathBudget(): Budget {
  return createBudget({ label: 'read-path', capMicroUsd: READ_PATH_BUDGET_MICRO_USD });
}

/**
 * The cross-encoder's scores for one packed list, or `null` if it could not run.
 *
 * **`null` rather than a throw, and rather than zeros**, for the same reason
 * {@link embedQuery} returns a null vector: this is the *second* synchronous
 * provider call on the request path (KTD4), and a rate limit on it must not
 * become a failed read. A vector of zeros would be worse than either — autocut
 * reads this score and only this score, so a uniformly-zero list is a cliff at
 * every position.
 *
 * **Bounded, and the bound is the dial.** The scorer sees at most
 * `RERANK_CANDIDATES_DEFAULT` passages, which is what makes this "bounded
 * scoring over a fixed candidate set" rather than the unbounded generative call
 * KTD4 forbids at request time.
 */
async function scoreWithCrossEncoder(
  request: RecallRequest,
  candidates: readonly ScoredCandidate[],
): Promise<readonly number[] | null> {
  if (candidates.length === 0) return [];

  let result: Awaited<ReturnType<ModelGateway['call']>>;
  try {
    result = await request.gateway.call({
      op: RERANK_OP,
      tenantId: request.tenantId,
      caller: request.caller,
      budget: request.budget ?? readPathBudget(),
      input: {
        kind: 'rerank',
        query: request.query,
        // One passage builder, shared with the eval's committed score manifest.
        // A divergent input template is exactly the drift `eval:live-parity`
        // exists to catch, and it would report as a score mismatch.
        candidates: candidates.map((entry) => rerankPassageOf(entry.candidate)),
      },
    });
  } catch {
    return null;
  }

  if (!result.ok) return null;
  if (result.output.kind !== 'rerank') return null;
  // A short list is not a partial answer here: the scores are positional, so a
  // missing tail would silently score the wrong candidates.
  if (result.output.scores.length !== candidates.length) return null;
  for (const score of result.output.scores) if (!Number.isFinite(score)) return null;
  return result.output.scores;
}

/** The gateway op name. KTD13's table decides the model; nothing here names one. */
const RERANK_OP = 'rerank' as const;

/** The whole read, from a question to a ranked, fenced, packed answer. */
export async function recall(request: RecallRequest): Promise<SearchResponse> {
  // **One budget for the whole read, minted here.** The two model calls below
  // are stages of a single request, so they share a single ceiling: a budget
  // minted per stage would let the two of them together spend twice what either
  // is allowed, and a caller who set their own budget keeps it either way.
  const budgeted: RecallRequest = { ...request, budget: request.budget ?? readPathBudget() };

  const outcome = await recallArms(budgeted);
  const compose: ComposeRequest = {
    query: request.query,
    limit: request.limit,
    now: request.now,
    ...(request.compose ?? {}),
  };

  // Stages 1–11 first, because the candidate set the cross-encoder is asked
  // about does not exist until packing has run. This is the seam
  // `pipeline.ts:PackedRanking` documents, and it is the only reason the read
  // path may await mid-pipeline while the eval stays synchronous.
  const packed = composeUpToPacking(compose, outcome);

  const stage = resolveRerankStage(compose.rerank ?? {});
  if (!stage.rerank && stage.reason !== 'unavailable') {
    return finishRanking(packed, compose.rerank);
  }

  const scores = await scoreWithCrossEncoder(budgeted, packed.results.slice(0, stage.candidates));
  if (scores === null) {
    // Both stages sit out together — autocut has no score to read — and the
    // response says which of the two external dependencies was the one that
    // refused.
    const { score: _unavailable, ...rest } = compose.rerank ?? {};
    const response = finishRanking(packed, { ...rest, enabled: true });
    return {
      ...response,
      degraded: [...new Set<Degradation>([...response.degraded, 'rerank_unavailable'])],
    };
  }

  return finishRanking(packed, {
    ...(compose.rerank ?? {}),
    enabled: true,
    candidates: stage.candidates,
    score: (_candidate, index) => scores[index] ?? 0,
  });
}

/** Everything up to the composition — the substrate half, for callers that need it. */
export async function recallArms(request: RecallRequest): Promise<RecallOutcome> {
  const materialised = await materialiseLadder(request.sql, request.query, request.grant);
  const { lookup } = materialised;
  const seeds = resolveEntities(request.query, lookup);
  const plan = refinePlan(
    planFor(classifyIntent(request.query)),
    resolutionOf(request.query, seeds),
  );
  const ladder = aliasLadderTiers(request.query, lookup, seeds);

  const embedded = await embedQuery(request);
  const ftsLanguage = await readFtsLanguage(request.sql);

  const arms = await runArms({
    sql: request.sql,
    query: request.query,
    grant: request.grant,
    limit: request.limit,
    ...(request.offset === undefined ? {} : { offset: request.offset }),
    ftsLanguage,
    entityIds: seeds.map((seed) => seed.entityId),
    useGraphArm: plan.useGraphArm,
    // The plan's two graph-ranking inputs, carried rather than recomputed. Both
    // reached U7's eval adapter and not this call for the whole of U5, which is
    // how the blocking tier came to grade an arm the fleet does not run.
    relations: plan.relations,
    seedFirst: plan.intent === 'entity_lookup',
    queryVector: embedded.vector,
  });

  // The ladder injects ids no arm returned, so its candidates have to be
  // hydrated separately — and hydration is where the fence runs, so an id the
  // grant does not cover simply vanishes rather than being filtered later.
  const candidates = new Map<string, Candidate>(arms.candidates);
  const missing = ladder
    .flatMap((tier) => [...tier.ids])
    .filter((id) => !candidates.has(id));
  if (missing.length > 0) {
    for (const [id, candidate] of await hydrate(request.sql, missing, request.grant)) {
      candidates.set(id, candidate);
    }
  }

  attachAdjacency(candidates, materialised, seeds);

  return {
    plan,
    arms: arms.arms,
    candidates,
    aliasLadder: ladder
      .map((tier) => ({ ...tier, ids: tier.ids.filter((id) => candidates.has(id)) }))
      .filter((tier) => tier.ids.length > 0),
    resolvedEntityIds: seeds.map((seed) => seed.entityId),
    // The matched key when the substrate recorded which one matched, else the
    // canonical name: stage 6 recognises the text the user typed.
    resolvedNames: seeds.map((seed) => seed.matchedKey ?? seed.canonicalName),
    // A **set** union, not a concatenation. Both layers legitimately report the
    // same event — `embedQuery` because it saw the provider refuse, `runArms`
    // because it saw a null vector — and a response that carries
    // `['embedding_unavailable', 'embedding_unavailable']` tells U6's envelope
    // that two things went wrong. The duplication is invisible to any test that
    // asserts `.toContain`, which is why this one asserts the whole array.
    degraded: [...new Set<Degradation>([...embedded.degraded, ...arms.degraded])],
  };
}

/**
 * Attach the resolved entities each candidate is adjacent to.
 *
 * **Without this the graph-adjacency boost and the title boost's residual rule
 * are inert on the fleet.** `arms.ts:toCandidate` defaults `entityIds` to `[]`
 * and no production caller ever passed one, so two documented ranking terms read
 * an empty array on every request while U7's eval adapter populated the field
 * and graded them. That is the same defect as a ranking key that exists only in
 * the eval, one stage further down the pipeline.
 *
 * **Three sets, because three stages ask three different questions.**
 *
 *   - `evidenceEntityIds` — this chunk is the source of a fact about the entity.
 *     The strongest statement the stack has, and chunk-granular by nature.
 *   - `entityIds` — this chunk names the entity, or evidences it. Chunk-granular
 *     too: a paragraph that names nobody is evidence about nobody, and widening
 *     it to the page lifts every paragraph of a profile above the row that
 *     answers the question. Resolved **competitively**, over a dictionary of
 *     every in-grant entity — `sam` is an alias of one person and the first
 *     token of another's name, and a per-entity containment test attributes the
 *     second one's sentence to the first (`alias-hop.ts:mentionsIn`).
 *   - `pageEntityIds` — this chunk's *page* names the entity. Page-granular
 *     because a title is the page's, and the title rule is the only stage that
 *     reads it.
 *
 * Nothing here queries: every half comes off the already-materialised ladder
 * lookup and the candidates' own text, so the derivations the rungs and the
 * boosts share stay one derivation.
 */
function attachAdjacency(
  candidates: Map<string, Candidate>,
  materialised: MaterialisedLadder,
  seeds: readonly EntityRef[],
): void {
  if (seeds.length === 0) return;
  const { lookup, dictionary } = materialised;

  const pageNamed = new Map<string, Set<string>>();
  const evidenced = new Map<string, Set<string>>();
  const add = (into: Map<string, Set<string>>, key: string, entityId: string): void => {
    const set = into.get(key);
    if (set === undefined) into.set(key, new Set([entityId]));
    else set.add(entityId);
  };

  for (const seed of seeds) {
    for (const page of lookup.pagesMentioning(seed.entityId)) {
      add(pageNamed, page.pageId, seed.entityId);
    }
    for (const chunkId of lookup.evidenceFor(seed.entityId)) {
      add(evidenced, chunkId, seed.entityId);
    }
  }

  for (const [chunkId, candidate] of candidates) {
    const mentioned = mentionsIn(candidate.content, dictionary);
    const evidence = evidenced.get(chunkId) ?? new Set<string>();
    const chunkLevel = new Set<string>([...evidence]);
    for (const entityId of mentioned) chunkLevel.add(entityId);
    const pageLevel = new Set<string>([...chunkLevel, ...(pageNamed.get(candidate.pageId) ?? [])]);

    candidates.set(chunkId, {
      ...candidate,
      entityIds: [...chunkLevel],
      evidenceEntityIds: [...evidence],
      pageEntityIds: [...pageLevel],
    });
  }
}

// ---------------------------------------------------------------------------
// The ladder, over SQL.
// ---------------------------------------------------------------------------

interface EntityRow {
  readonly entity_id: string;
  readonly canonical_name: string;
  readonly name: string;
}

interface PageRow {
  readonly page_id: string;
  readonly title: string | null;
  readonly chunk_ids: string[];
  readonly text: string;
}

/**
 * The ladder's lookup plus the mention dictionary it was built from.
 *
 * The dictionary travels with the lookup because `attachAdjacency` needs the
 * *same* one: a chunk's mentions and a rung's mentions answering to two
 * dictionaries is the silent version of a routing bug.
 */
interface MaterialisedLadder {
  readonly lookup: LadderLookup;
  readonly dictionary: readonly MentionKey[];
}

/**
 * Fetch everything the ladder can need for this query, then serve it
 * synchronously.
 *
 * **Materialised on purpose.** `LadderLookup` is synchronous so that the whole
 * post-retrieval stack stays the pure function U7's blocking eval can call; if
 * the lookup were async, the eval would be grading a second implementation. The
 * cost is that the queries below fetch a superset of what any one rung uses, and
 * the bound on that superset is the query itself: candidate entities are those
 * whose name or alias appears in the query, and candidate pages are those titled
 * near the query or naming one of those entities.
 *
 * **Every statement carries the fence.** Entities resolve on *intersect*
 * (`origin_contexts && $grant`) because an entity is a name; every page and
 * chunk the resolution then reaches is fenced on scalar membership. That split
 * is `fence.ts`'s, read back here rather than restated.
 */
async function materialiseLadder(
  sql: SQL,
  query: string,
  grant: Grant,
): Promise<MaterialisedLadder> {
  const normalized = normalizeQuery(query);
  const queryTokens = tokens(query);
  const grantLiteral = textArrayLiteral(grant);

  if (grant.length === 0 || queryTokens.length === 0) {
    return { lookup: EMPTY_LOOKUP, dictionary: [] };
  }

  // Entities whose canonical name or any alias appears in the query, with the
  // name that matched travelling alongside — `intent.ts:resolutionOf` needs it.
  const entityRows = (await sql.unsafe(
    `SELECT e.entity_id::text AS entity_id, e.canonical_name, n.name
       FROM entity e
       CROSS JOIN LATERAL (
         SELECT e.canonical_name AS name
         UNION ALL
         SELECT a.alias AS name FROM entity_alias a WHERE a.entity_id = e.entity_id
       ) n
      WHERE e.deleted_at IS NULL
        AND e.origin_contexts && $1::text[]`,
    [grantLiteral],
  )) as EntityRow[];

  const byEntity = new Map<string, { ref: EntityRef; keys: string[] }>();
  for (const row of entityRows) {
    const entry = byEntity.get(row.entity_id) ?? {
      ref: { entityId: row.entity_id, canonicalName: row.canonical_name, slug: slugOf(row.canonical_name) },
      keys: [],
    };
    const key = normalize(row.name);
    if (key.length > 0) entry.keys.push(key);
    byEntity.set(row.entity_id, entry);
  }

  const tokenSet = new Set(queryTokens);
  const matched: EntityRef[] = [];
  for (const entry of byEntity.values()) {
    // Longest key first, so a two-word name wins over a one-word alias it
    // contains — the same competitive rule `mentionsIn` applies to text.
    const keys = [...entry.keys].sort((a, b) => b.length - a.length);
    for (const key of keys) {
      if (!tokenSet.has(key) && !(key.includes(' ') && normalized.includes(key))) continue;
      matched.push({ ...entry.ref, matchedKey: key });
      break;
    }
  }
  matched.sort((a, b) => (b.matchedKey ?? '').length - (a.matchedKey ?? '').length);

  const pages = await readPages(sql, grantLiteral);
  const evidence = await readEvidence(sql, grantLiteral, [...byEntity.keys()]);
  const entityIdsByPage = new Map<string, Set<string>>();
  for (const page of pages) {
    const haystack = normalize(`${page.title ?? ''} ${page.text}`);
    const named = new Set<string>();
    for (const [entityId, entry] of byEntity) {
      if (entry.keys.some((key) => key.length > 0 && haystack.includes(key))) named.add(entityId);
    }
    entityIdsByPage.set(page.page_id, named);
  }

  const refFor = (page: PageRow): PageRef => ({
    pageId: page.page_id,
    title: page.title,
    chunkIds: page.chunk_ids,
    text: page.text,
  });

  // One dictionary over every in-grant entity's names, so a chunk's mentions
  // resolve **competitively** rather than per entity. `sam` is a declared alias
  // of one person and the first token of another's name; a per-entity check
  // attributes the second one's sentence to the first. Same rule, same list, as
  // the ladder's own — see `alias-hop.ts:mentionsIn`.
  const dictionary: MentionKey[] = [];
  for (const [entityId, entry] of byEntity) {
    for (const key of entry.keys) dictionary.push({ key, entityId });
  }

  const lookup: LadderLookup = {
    pagesByTitle(key) {
      return pages.filter((page) => normalize(page.title ?? '') === key).map(refFor);
    },
    pagesTitledContaining(key) {
      return pages
        .filter((page) => {
          const title = normalize(page.title ?? '');
          if (title.length === 0 || title === key) return false;
          return title.includes(key) || key.includes(title);
        })
        .map(refFor);
    },
    entitiesByName() {
      return matched;
    },
    entitiesBySlugSuffix(suffixTokens) {
      const wanted = new Set(suffixTokens);
      return [...byEntity.values()]
        .filter((entry) => {
          const suffix = entry.ref.slug.split('-').pop() ?? '';
          return suffix.length > 2 && wanted.has(suffix);
        })
        .map((entry) => entry.ref);
    },
    pagesTitled(name) {
      const key = normalize(name);
      return pages.filter((page) => normalize(page.title ?? '') === key).map(refFor);
    },
    evidenceFor(entityId) {
      return evidence.get(entityId) ?? [];
    },
    pagesMentioning(entityId) {
      return pages.filter((page) => entityIdsByPage.get(page.page_id)?.has(entityId) === true).map(refFor);
    },
  };

  return { lookup, dictionary };
}

/**
 * A canonical name as its slug, matching the DDL's slug shape.
 *
 * The slug-suffix rung asks whether a bare surname is the tail of an entity's
 * slug, so it needs the slug; the column the tenant schema stores it in is U4's
 * to add, and until then it is derived from the canonical name through the
 * shared normalizer rather than through a second lowercasing rule.
 */
function slugOf(name: string): string {
  return normalize(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Chunks that evidence each entity — the source chunks of facts naming it,
 * current before superseded, newest first.
 *
 * Mirrors `arms.ts:graphArm`'s ordering exactly, and for the same reason: a
 * superseded statement is demoted rather than dropped, because it is still the
 * best evidence for a question about the past. Facts fence on **subset**
 * (`fence.ts:fenceRow`) — the statement is a synthesis of every contributing
 * origin, so a credential holding only some of them must not read it.
 */
async function readEvidence(
  sql: SQL,
  grantLiteral: string,
  entityIds: readonly string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (entityIds.length === 0) return out;

  const rows = (await sql.unsafe(
    `WITH seeds AS (SELECT unnest($2::bigint[]) AS entity_id),
     names AS (
       SELECT s.entity_id, n.name
         FROM seeds s
         CROSS JOIN LATERAL (
           SELECT e.canonical_name AS name FROM entity e
            WHERE e.entity_id = s.entity_id AND e.deleted_at IS NULL
           UNION ALL
           SELECT a.alias AS name FROM entity_alias a WHERE a.entity_id = s.entity_id
         ) n
     )
     SELECT DISTINCT ON (nm.entity_id, c.chunk_id)
            nm.entity_id::text AS entity_id,
            c.chunk_id::text AS chunk_id,
            (f.superseded_by IS NULL) AS current,
            f.created_at
       FROM names nm
       JOIN fact f ON f.statement ILIKE '%' || nm.name || '%'
       JOIN fact_source fs ON fs.fact_id = f.fact_id
       JOIN chunk c ON c.chunk_id = fs.chunk_id
       LEFT JOIN page p ON p.page_id = c.page_id
      WHERE f.deleted_at IS NULL
        AND f.quarantined_at IS NULL
        AND f.origin_contexts <@ $1::text[]
        AND c.deleted_at IS NULL
        AND c.quarantined_at IS NULL
        AND c.origin_context = ANY($1::text[])
        AND (p.page_id IS NULL OR (p.deleted_at IS NULL AND p.quarantined_at IS NULL))
      ORDER BY nm.entity_id, c.chunk_id, current DESC, f.created_at DESC`,
    [grantLiteral, textArrayLiteral(entityIds)],
  )) as Array<{ entity_id: string; chunk_id: string; current: boolean; created_at: string }>;

  const ranked = new Map<string, Array<{ chunkId: string; current: boolean; at: number }>>();
  for (const row of rows) {
    const list = ranked.get(row.entity_id) ?? [];
    list.push({ chunkId: row.chunk_id, current: row.current, at: Date.parse(row.created_at) || 0 });
    ranked.set(row.entity_id, list);
  }
  for (const [entityId, list] of ranked) {
    list.sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        b.at - a.at ||
        (a.chunkId < b.chunkId ? -1 : 1),
    );
    out.set(entityId, list.map((entry) => entry.chunkId));
  }
  return out;
}

const EMPTY_LOOKUP: LadderLookup = {
  pagesByTitle: () => [],
  pagesTitledContaining: () => [],
  entitiesByName: () => [],
  entitiesBySlugSuffix: () => [],
  pagesTitled: () => [],
  evidenceFor: () => [],
  pagesMentioning: () => [],
};

/**
 * Every live, in-grant page with its chunk ids in ordinal order and its body as
 * one string.
 *
 * The body is what the mention rung ranks on, and it is aggregated in SQL rather
 * than joined per chunk in TypeScript so that the fence is in the statement —
 * the same rule every arm follows, for the reason hazard H3 documents.
 */
async function readPages(sql: SQL, grantLiteral: string): Promise<PageRow[]> {
  return (await sql.unsafe(
    `SELECT p.page_id::text AS page_id,
            p.title,
            array_agg(c.chunk_id::text ORDER BY c.ordinal, c.chunk_id) AS chunk_ids,
            string_agg(c.content, ' ' ORDER BY c.ordinal, c.chunk_id) AS text
       FROM page p
       JOIN chunk c ON c.page_id = p.page_id
      WHERE p.deleted_at IS NULL
        AND p.quarantined_at IS NULL
        AND c.deleted_at IS NULL
        AND c.quarantined_at IS NULL
        AND p.origin_context = ANY($1::text[])
        AND c.origin_context = ANY($1::text[])
      GROUP BY p.page_id, p.title`,
    [grantLiteral],
  )) as PageRow[];
}
