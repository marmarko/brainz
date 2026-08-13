/**
 * Every fenced statement the MCP surface issues, in one module.
 *
 * **Why one module rather than a query per handler.** Critical gap 6: a scope
 * check that exists in one projection and not its twin is a cross-origin read
 * that no equivalence test can see, because equivalence compares two results the
 * same grant produced. Keeping the SQL here — and keeping `src/mcp/tools/` free
 * of it, which `test/mcp/guards.test.ts` enforces by scanning — means a handler
 * *cannot* write an unfenced query, rather than being trusted not to.
 *
 * **Three fence rules, not one, and they are `fence.ts`'s.** Scalar membership
 * for `chunk` and `page`; **subset** for `fact`, because a statement is a
 * synthesis of every contributing origin and a credential holding only some of
 * them must not read the synthesis; **intersect** for `entity`, because an
 * entity is a name and a subset rule would refuse to resolve any person who
 * appears in both a work and a personal mailbox — which is most of the
 * interesting ones. Read back from U5 rather than restated.
 *
 * **Existence is disclosed deliberately on id-addressed reads.** `fetch` and
 * `recall({id})` answer `scope_denied` rather than `not_found` when a row exists
 * outside the grant. That is a real, bounded disclosure — the caller learns an
 * id it already held names something — and it is the shape the unit's test
 * scenario requires, because "the fence is enforced" and "the row does not
 * exist" must be distinguishable when an isolation claim is being audited.
 * Ranked reads disclose nothing: an out-of-grant row is simply absent.
 */

import type { SQL } from 'bun';

import { fenceEntity, fenceRow, fenceScalar, type Grant } from '../core/search/fence.ts';
// The shared normalizer, reached through the read side's re-export — the same
// function objects `write/links.ts` files aliases with, never a second copy.
// `test/core/search/normalize.test.ts` asserts that identity across the seam.
import { normalize, slugify } from '../core/search/normalize.ts';
import { textArrayLiteral } from '../core/write/pg-values.ts';
import type { IndexState } from './envelope.ts';
import { formatId, type IdKind, type OpaqueId } from './ids.ts';

export type ReadStatus = 'ok' | 'not_found' | 'scope_denied';

export interface Record_ {
  readonly id: string;
  readonly kind: IdKind;
  readonly title: string | null;
  readonly text: string;
  /** R15's union for this row: one entry for ingested rows, many for derived. */
  readonly origins: readonly string[];
  readonly sourceType: string | null;
  readonly createdAt: string;
}

export type RecordOutcome =
  | { readonly status: 'ok'; readonly record: Record_ }
  | { readonly status: 'not_found' | 'scope_denied' };

/**
 * What the tenant's substrate holds right now — counts only.
 *
 * Fenced, because "your brain is empty" must mean *this grant's* brain: a
 * work-scoped connector telling a user their personal brain is empty would be a
 * cross-origin inference wearing a status message.
 */
export async function indexState(sql: SQL, grant: Grant): Promise<IndexState> {
  const grantLiteral = textArrayLiteral(grant);
  const rows = (await sql.unsafe(
    `SELECT
       (SELECT count(*) FROM page  WHERE deleted_at IS NULL AND quarantined_at IS NULL AND origin_context = ANY($1::text[]))::int AS pages,
       (SELECT count(*) FROM chunk WHERE deleted_at IS NULL AND quarantined_at IS NULL AND origin_context = ANY($1::text[]))::int AS chunks,
       (SELECT count(*) FROM chunk WHERE deleted_at IS NULL AND quarantined_at IS NULL AND embedding IS NULL AND origin_context = ANY($1::text[]))::int AS pending,
       (SELECT count(*) FROM ingest_log WHERE outcome = 'running' AND origin_context = ANY($1::text[]))::int AS running`,
    [grantLiteral],
  )) as Array<{ pages: number; chunks: number; pending: number; running: number }>;

  const row = rows[0] ?? { pages: 0, chunks: 0, pending: 0, running: 0 };
  return {
    pages: row.pages,
    chunks: row.chunks,
    chunksPendingEmbedding: row.pending,
    importInProgress: row.running > 0,
  };
}

/** Inventory for the `brain` tool. Counts, in grant, nothing else. */
export async function inventory(
  sql: SQL,
  grant: Grant,
): Promise<{ readonly pages: number; readonly chunks: number; readonly facts: number; readonly entities: number }> {
  const grantLiteral = textArrayLiteral(grant);
  const rows = (await sql.unsafe(
    `SELECT
       (SELECT count(*) FROM page   WHERE deleted_at IS NULL AND quarantined_at IS NULL AND origin_context = ANY($1::text[]))::int AS pages,
       (SELECT count(*) FROM chunk  WHERE deleted_at IS NULL AND quarantined_at IS NULL AND origin_context = ANY($1::text[]))::int AS chunks,
       (SELECT count(*) FROM fact   WHERE deleted_at IS NULL AND quarantined_at IS NULL AND origin_contexts <@ $1::text[])::int AS facts,
       (SELECT count(*) FROM entity WHERE deleted_at IS NULL AND origin_contexts && $1::text[])::int AS entities`,
    [grantLiteral],
  )) as Array<{ pages: number; chunks: number; facts: number; entities: number }>;
  return rows[0] ?? { pages: 0, chunks: 0, facts: 0, entities: 0 };
}

/**
 * Every origin this brain actually holds.
 *
 * Deliberately **unfenced**, and it is the one function here that is: it exists
 * to *build* the fence for the tenant's own provisioned bearer, which grants the
 * whole brain. Its result never reaches a caller — `dispatch.ts` turns it into a
 * grant and nothing else — and the agent write origin is added unconditionally so
 * that a brand-new tenant, which holds no rows at all, can still store its first
 * memory and read it back (R2a's activation loop).
 */
export async function brainOrigins(sql: SQL): Promise<string[]> {
  const rows = (await sql.unsafe(
    `SELECT DISTINCT origin_context AS origin FROM page WHERE deleted_at IS NULL
      UNION
     SELECT DISTINCT origin_context FROM chunk WHERE deleted_at IS NULL
      UNION
     SELECT DISTINCT unnest(origin_contexts) FROM fact WHERE deleted_at IS NULL
      UNION
     SELECT DISTINCT unnest(origin_contexts) FROM entity WHERE deleted_at IS NULL`,
    [],
  )) as Array<{ origin: string }>;
  return rows.map((row) => row.origin).filter((origin) => typeof origin === 'string');
}

/**
 * One record in full, by opaque id.
 *
 * The two-step — read the origin, judge it, *then* read the content — is not a
 * micro-optimisation. A single query that selected the body and filtered on the
 * fence would make `not_found` and `scope_denied` indistinguishable, and this is
 * the one place the surface has undertaken to distinguish them.
 */
export async function fetchRecord(sql: SQL, grant: Grant, id: OpaqueId): Promise<RecordOutcome> {
  switch (id.kind) {
    case 'chunk':
      return fetchChunk(sql, grant, id.key);
    case 'doc':
      return fetchPage(sql, grant, id.key);
    case 'fact':
      return fetchFact(sql, grant, id.key);
    case 'ent':
      return fetchEntity(sql, grant, id.key);
  }
}

async function fetchChunk(sql: SQL, grant: Grant, key: string): Promise<RecordOutcome> {
  const rows = (await sql.unsafe(
    // The same fence on the join, in the other direction. A title is row
    // content and a mail *subject* is attacker-authored — the one field the
    // `/openai` shape can make the whole of what a model sees. Fencing the
    // passage and then reading its parent's title hands a work-scoped grant a
    // sentence a personal-origin sender wrote.
    `SELECT c.origin_context, c.content, c.created_at, p.title, p.source_type
       FROM chunk c
       LEFT JOIN page p ON p.page_id = c.page_id AND p.origin_context = ANY($2::text[])
      WHERE c.chunk_id = $1::bigint
        AND c.deleted_at IS NULL
        AND c.quarantined_at IS NULL`,
    [key, textArrayLiteral(grant)],
  )) as Array<{
    origin_context: string;
    content: string;
    created_at: string;
    title: string | null;
    source_type: string | null;
  }>;

  const row = rows[0];
  if (row === undefined) return { status: 'not_found' };
  if (!fenceScalar(row.origin_context, grant)) return { status: 'scope_denied' };

  return {
    status: 'ok',
    record: {
      id: formatId('chunk', key),
      kind: 'chunk',
      title: row.title,
      text: row.content,
      origins: [row.origin_context],
      sourceType: row.source_type,
      createdAt: isoOf(row.created_at),
    },
  };
}

async function fetchPage(sql: SQL, grant: Grant, key: string): Promise<RecordOutcome> {
  // The join fences too, and it is not redundant with the page's own check.
  // `chunk.origin_context` is its own credential-derived column — nothing in the
  // schema ties it to its page's, which is why `indexState` counts chunks
  // separately — so a page in grant can hang passages that are not. Fencing the
  // parent and then aggregating the children is a cross-origin read wearing a
  // document read.
  const rows = (await sql.unsafe(
    `SELECT p.origin_context, p.title, p.source_type, p.created_at,
            coalesce(string_agg(c.content, E'\\n\\n' ORDER BY c.ordinal, c.chunk_id), '') AS body
       FROM page p
       LEFT JOIN chunk c
         ON c.page_id = p.page_id AND c.deleted_at IS NULL AND c.quarantined_at IS NULL
        AND c.origin_context = ANY($2::text[])
      WHERE p.page_id = $1::bigint
        AND p.deleted_at IS NULL
        AND p.quarantined_at IS NULL
      GROUP BY p.page_id, p.origin_context, p.title, p.source_type, p.created_at`,
    [key, textArrayLiteral(grant)],
  )) as Array<{
    origin_context: string;
    title: string | null;
    source_type: string;
    created_at: string;
    body: string;
  }>;

  const row = rows[0];
  if (row === undefined) return { status: 'not_found' };
  if (!fenceScalar(row.origin_context, grant)) return { status: 'scope_denied' };

  return {
    status: 'ok',
    record: {
      id: formatId('doc', key),
      kind: 'doc',
      title: row.title,
      text: row.body,
      origins: [row.origin_context],
      sourceType: row.source_type,
      createdAt: isoOf(row.created_at),
    },
  };
}

async function fetchFact(sql: SQL, grant: Grant, key: string): Promise<RecordOutcome> {
  const rows = (await sql.unsafe(
    `SELECT origin_contexts, statement, created_at
       FROM fact
      WHERE fact_id = $1::bigint
        AND deleted_at IS NULL
        AND quarantined_at IS NULL`,
    [key],
  )) as Array<{ origin_contexts: string[]; statement: string; created_at: string }>;

  const row = rows[0];
  if (row === undefined) return { status: 'not_found' };
  // Subset, per `fence.ts:fenceRow`: the statement is a synthesis of every
  // contributing origin.
  if (!fenceRow(row.origin_contexts, grant)) return { status: 'scope_denied' };

  return {
    status: 'ok',
    record: {
      id: formatId('fact', key),
      kind: 'fact',
      title: null,
      text: row.statement,
      origins: row.origin_contexts,
      sourceType: null,
      createdAt: isoOf(row.created_at),
    },
  };
}

async function fetchEntity(sql: SQL, grant: Grant, key: string): Promise<RecordOutcome> {
  const rows = (await sql.unsafe(
    `SELECT origin_contexts, canonical_name, entity_type, created_at
       FROM entity
      WHERE entity_id = $1::bigint AND deleted_at IS NULL`,
    [key],
  )) as Array<{ origin_contexts: string[]; canonical_name: string; entity_type: string; created_at: string }>;

  const row = rows[0];
  if (row === undefined) return { status: 'not_found' };
  if (!fenceEntity(row.origin_contexts, grant)) return { status: 'scope_denied' };

  return {
    status: 'ok',
    record: {
      id: formatId('ent', key),
      kind: 'ent',
      title: row.canonical_name,
      text: `${row.canonical_name} — ${row.entity_type}`,
      origins: row.origin_contexts,
      sourceType: null,
      createdAt: isoOf(row.created_at),
    },
  };
}

// ---------------------------------------------------------------------------
// The entity card.
// ---------------------------------------------------------------------------

export interface EntityCard {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly aliases: readonly string[];
  readonly origins: readonly string[];
  readonly facts: readonly { readonly id: string; readonly text: string; readonly origins: readonly string[] }[];
}

export type EntityOutcome =
  | { readonly status: 'ok'; readonly card: EntityCard }
  | { readonly status: 'scope_denied' }
  | { readonly status: 'not_found'; readonly suggestions: readonly string[] };

/**
 * The rungs this tool resolves a name on, in the order it tries them.
 *
 * **The order is the increasing speculation the ranked read's ladder uses**
 * (`search/alias-hop.ts`), read back rather than re-invented — the write side
 * already walks the first two in the same order (`write/links.ts:findEntityByName`,
 * "the read path's ladder, applied on the write side"), and this tool having
 * only the first of them is what made that docstring aspirational.
 *
 * What is deliberately *not* here is the ladder's speculative tail — the
 * slug-suffix guess that a bare surname means the person whose slug ends with
 * it, and the mention rung. Both exist to *nominate* candidates into a ranking
 * that then decides between them. This tool returns one card and no ranking, so
 * a guess arrives wearing the same confidence as an exact match; the honest
 * degradation for that tier is the suggestion list a miss already returns, which
 * hands the caller the candidates instead of picking one for it.
 */
const ENTITY_RUNGS = {
  /**
   * The recall vocabulary: normalized surface forms and declared aliases.
   *
   * **This rung does not use `entity_alias_lookup`, and that is a decision with
   * a measurement behind it.** The index is on `lower(alias)`, so hitting it
   * would mean comparing the key against a *derived* value rather than against
   * the stored one — `lower()` in Postgres and `toLowerCase` in the normalizer
   * agree on almost every input and not on all of them (`U+0130` is the usual
   * example), and a row whose key the index's expression alters is a row nothing
   * can ever match. The whole defect this rung was rewritten to close is a fold
   * applied on one side and not the other, so buying an index with a third fold
   * would be closing it at the top and reopening it underneath. Measured at
   * 20,000 entities the whole statement is ~3.7ms against the ~7.4ms of the
   * `entity`-to-`entity_alias` join it replaced, so this is faster than what was
   * here rather than a regression — but both are linear in the corpus, and the
   * real remedy is an index on the key column itself (`(alias)`, not
   * `(lower(alias))`), which is one additive line for whoever next opens the
   * schema ladder.
   */
  alias: 1,
  /** The addressing namespace — canonical slugs *and* redirects, so a renamed entity keeps its old address. */
  slug: 2,
  /**
   * The canonical name, compared raw.
   *
   * Last, and it is the one comparison here not made against a stored key.
   * `canonical_name` holds the user's own spelling — the normalizer deliberately
   * does not touch stored text — so `lower()` on it is a weaker fold than the
   * one the write path applied. It stays because nothing in the schema *requires*
   * an alias row, so a row filed by a path that did not write one would otherwise
   * be unreachable by its own name; every entity `resolveOrCreateEntity` creates
   * carries its normalized name as an alias and is answered by rung 1 first.
   */
  canonical_name: 3,
} as const;

/**
 * One entity as a card. Zero model calls, by construction — this is the tool
 * whose entire justification for having a name is that it is fast.
 *
 * **The name is folded by the shared normalizer, and the comparison is made
 * against the keys the write path wrote.** Both halves matter and the second is
 * the easy one to miss: `write/links.ts` stores every alias as a
 * {@link normalize} key, so `lower(alias) = lower(asked)` is a *second*
 * normalizer sitting on top of the first — it folds case and nothing else,
 * which means the punctuation fold the write path applied is invisible to it. A
 * name carrying a curly apostrophe, a fullwidth letter or an ellipsis then
 * resolves through `recall`'s alias ladder and misses here, silently, with
 * `found: false` on the tool that exists to answer exactly that question. So the
 * key is computed once, through the one module, and each rung below compares it
 * against a column written through the same module — never against a second
 * fold expressed in SQL, which would be that same failure one layer down.
 */
export async function entityCard(sql: SQL, grant: Grant, name: string): Promise<EntityOutcome> {
  const key = normalize(name);
  if (key.length === 0) return { status: 'not_found', suggestions: [] };
  const grantLiteral = textArrayLiteral(grant);
  // Derived from `normalize`, not from a second lowercasing convention, so the
  // address a name resolves to is the address that name was filed under.
  const slug = slugify(name);

  // In-grant matches first, then the rung, then a stable tiebreak.
  //
  // The lookup is deliberately unfenced — an id-addressed or name-addressed read
  // answers `scope_denied` rather than `not_found` when a row exists outside the
  // grant, which is the disclosure this surface has undertaken to make so that
  // "the fence held" and "there is nothing there" stay distinguishable. But an
  // *unordered* unfenced match makes that disclosure decide the ordinary case
  // too: two people share a name across a work and a personal mailbox — most of
  // the interesting ones do — and the grant that holds one of them gets
  // `scope_denied` on its own entity depending on which row the planner happened
  // to return. Resolving in-grant first keeps the disclosure for the case it was
  // meant for, which is the name this grant genuinely cannot reach.
  //
  // The grant outranks the rung, and that ordering is the same decision: a
  // caller's own entity, reached on a lower rung, is a better answer than a
  // neighbouring origin's exact match that this credential may not read.
  const rows = (await sql.unsafe(
    `WITH matched AS (
       SELECT a.entity_id, ${ENTITY_RUNGS.alias} AS rung FROM entity_alias a WHERE a.alias = $1
       UNION ALL
       SELECT s.entity_id, ${ENTITY_RUNGS.slug} AS rung FROM entity_slug s WHERE s.slug = $3
       UNION ALL
       SELECT e.entity_id, ${ENTITY_RUNGS.canonical_name} AS rung FROM entity e WHERE lower(e.canonical_name) = $1
     ),
     resolved AS (
       -- An id appears in its highest rung only, which is the ladder's own
       -- de-duplication rule and, here, the tie-break.
       SELECT entity_id, min(rung) AS rung FROM matched GROUP BY entity_id
     )
     SELECT e.entity_id::text AS entity_id, e.canonical_name, e.entity_type, e.origin_contexts
       FROM resolved r
       JOIN entity e ON e.entity_id = r.entity_id
      WHERE e.deleted_at IS NULL
      ORDER BY (e.origin_contexts && $2::text[]) DESC, r.rung, e.entity_id
      LIMIT 1`,
    [key, grantLiteral, slug],
  )) as Array<{ entity_id: string; canonical_name: string; entity_type: string; origin_contexts: string[] }>;

  const row = rows[0];
  if (row === undefined) {
    // The suggestion arm folds the same way the resolution arm does. A prefix
    // taken from a normalized key and matched only against the unnormalized
    // column suggests nothing in precisely the case the caller needed the hint —
    // the spelling that just missed.
    const suggestions = (await sql.unsafe(
      `SELECT e.canonical_name
         FROM entity e
        WHERE e.deleted_at IS NULL
          AND e.origin_contexts && $2::text[]
          AND (lower(e.canonical_name) LIKE $1
               OR EXISTS (SELECT 1 FROM entity_alias a WHERE a.entity_id = e.entity_id AND a.alias LIKE $1))
        ORDER BY e.canonical_name
        LIMIT 3`,
      [`${key.split(/\s+/)[0] ?? key}%`, grantLiteral],
    )) as Array<{ canonical_name: string }>;
    return { status: 'not_found', suggestions: suggestions.map((s) => s.canonical_name) };
  }

  if (!fenceEntity(row.origin_contexts, grant)) return { status: 'scope_denied' };

  const aliases = (await sql.unsafe(
    `SELECT alias FROM entity_alias WHERE entity_id = $1::bigint ORDER BY alias`,
    [row.entity_id],
  )) as Array<{ alias: string }>;

  const facts = (await sql.unsafe(
    `SELECT fact_id::text AS fact_id, statement, origin_contexts
       FROM fact
      WHERE deleted_at IS NULL
        AND quarantined_at IS NULL
        AND superseded_by IS NULL
        AND origin_contexts <@ $2::text[]
        AND statement ILIKE '%' || $1 || '%'
      ORDER BY created_at DESC
      LIMIT 10`,
    [row.canonical_name, grantLiteral],
  )) as Array<{ fact_id: string; statement: string; origin_contexts: string[] }>;

  return {
    status: 'ok',
    card: {
      id: formatId('ent', row.entity_id),
      name: row.canonical_name,
      type: row.entity_type,
      aliases: aliases.map((a) => a.alias),
      origins: row.origin_contexts,
      facts: facts.map((fact) => ({
        id: formatId('fact', fact.fact_id),
        text: fact.statement,
        origins: fact.origin_contexts,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// The briefing bundle.
// ---------------------------------------------------------------------------

export interface BriefingBundle {
  readonly changed: readonly Record_[];
  readonly facts: readonly Record_[];
}

/**
 * The pre-U11 briefing: what arrived and what was stated in the window, by SQL.
 *
 * This is deliberately thin, and the envelope says so. The bundle U12 ships
 * assembles over materialised consolidation outputs — participant cards,
 * extracted commitments, the synopsis layer — which do not exist until U11 runs.
 * Serving a retrieval-only bundle *marked degraded* is the honest shape; serving
 * it unmarked would teach agents that this is what a briefing is.
 */
export async function briefingBundle(
  sql: SQL,
  grant: Grant,
  window: {
    readonly since: string;
    readonly until: string;
    readonly limit?: number;
    /** Narrow to one person, project or topic. Matched on title, body and statement. */
    readonly focus?: string | null;
  },
): Promise<BriefingBundle> {
  const grantLiteral = textArrayLiteral(grant);
  const limit = Math.max(1, Math.min(window.limit ?? 20, 100));
  // `null` rather than `%%`: a NULL parameter short-circuits the predicate below
  // instead of running an unanchored wildcard scan on every unfocused call.
  const focus = window.focus === null || window.focus === undefined || window.focus.length === 0
    ? null
    : window.focus;

  const pages = (await sql.unsafe(
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
        AND ($4::text IS NULL
             OR p.title ILIKE '%' || $4 || '%'
             OR c.content ILIKE '%' || $4 || '%')
      GROUP BY p.page_id, p.title, p.source_type, p.origin_context, p.created_at
      ORDER BY p.created_at DESC
      LIMIT ${limit}`,
    [grantLiteral, window.since, window.until, focus],
  )) as Array<{
    page_id: string;
    title: string | null;
    source_type: string;
    origin_context: string;
    created_at: string;
    body: string;
  }>;

  const facts = (await sql.unsafe(
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
      LIMIT ${limit}`,
    [grantLiteral, window.since, window.until, focus],
  )) as Array<{ fact_id: string; statement: string; origin_contexts: string[]; created_at: string }>;

  return {
    changed: pages.map((page) => ({
      id: formatId('doc', page.page_id),
      kind: 'doc' as const,
      title: page.title,
      text: page.body,
      origins: [page.origin_context],
      sourceType: page.source_type,
      createdAt: isoOf(page.created_at),
    })),
    facts: facts.map((fact) => ({
      id: formatId('fact', fact.fact_id),
      kind: 'fact' as const,
      title: null,
      text: fact.statement,
      origins: fact.origin_contexts,
      sourceType: null,
      createdAt: isoOf(fact.created_at),
    })),
  };
}

function isoOf(value: string | Date): string {
  return typeof value === 'string' ? new Date(value).toISOString() : value.toISOString();
}
