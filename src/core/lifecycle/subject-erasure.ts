/**
 * Subject-scoped erasure (R12), keyed on a **correspondent**, not on a tenant.
 *
 * Every one of the five account-erasure legs drops a whole tenant. A brain also
 * holds identifiable content about people who never signed up — the ones who
 * write to the user and the ones who attend their meetings — and a request from
 * one of them has nothing to run against a brain that stays live. This module is
 * what makes that request answerable.
 *
 * It is built against the determination a sibling settled first, at
 * `docs/plans/2026-08-13-003-u15-web-app-identity-billing-replan.md` §6 — brainz
 * is the **processor** and the user is the **controller** for everything in the
 * brain, including this content — and §6.3 fixes four properties this module
 * owes. Each is answered here:
 *
 *   1. **Keyed on a correspondent identifier, not a tenant.** The identifier is
 *      an address or a name, normalised through the *same* normalizer the write
 *      path used, and resolved through `entity_slug` and `entity_alias`.
 *   2. **Spanning derivation, not just rows.** See the two handles below.
 *   3. **Invocable by the controlling user, out of band.** This module exports a
 *      function and registers no MCP tool. R12a's rule applies with full force:
 *      the assistant that would issue it is the assistant reading the
 *      correspondent's mail.
 *   4. **Tombstoned against re-ingestion.** {@link eraseSubject} writes an
 *      `erased_subject` row, and {@link isErasedSubject} is what a pull path
 *      consults before writing a page. **The consulting half is not wired** —
 *      `src/ingest/pipedream/pull.ts` is another unit's file — and that is
 *      recorded in the ledger rather than assumed, because without it the next
 *      poll undoes the erasure on a cadence and the receipt handed to a third
 *      party becomes false within the hour.
 *
 * ============================================================================
 * TWO HANDLES, AND THE LIMIT BETWEEN THEM
 * ============================================================================
 *
 * **The derivation handle.** The resolved `entity` and everything hanging off
 * it: its slugs, its aliases, its `entity_card`, and every `entity_edge` it is
 * an endpoint of.
 *
 * **The text handle.** Pages, chunks, facts and commitments whose text names the
 * subject. This exists because there is no structural edge from a fact to the
 * entity it is about — `fact_source` reaches chunks, `entity_edge` reaches
 * entities, and nothing joins the two — so a derivation-only sweep would delete
 * the person's card and leave every sentence about them answering `recall`.
 *
 * **A hazard on the text handle, stated where an editor will see it.** The
 * surface forms include the entity's *inferred* aliases, not only the ones a
 * user stated. A short or generic inferred alias widens the sweep, and this
 * sweep deletes. The mitigation is the flow rather than a filter: the controller
 * sees {@link previewSubjectErasure}'s match list — every page, with the handle
 * that found it — before instructing, exactly as they see a blast radius before
 * a `forget`. Anything that makes erasure invocable without that preview
 * re-opens this.
 *
 * **What neither handle reaches**, stated here rather than discovered by a
 * regulator: a message that mentions the correspondent, from which no fact was
 * extracted, *and* which does not contain the identifier or any known alias as
 * text. That is a limit of extraction rather than of erasure, and the receipt
 * reports which handle found each page so the controller can see the difference.
 *
 * ============================================================================
 * REMOVED IS NOT THE WHOLE COST
 * ============================================================================
 *
 * Same shape as `blast-radius.ts`, for the same R15 reason: a derived row that
 * *survives* but lost an input is not correct any more. A surviving fact whose
 * source chunks were partly removed, and a surviving entity's card that was
 * built while an edge to the erased person existed, both have to be re-derived.
 * They are counted separately and the receipt says a recompute is required —
 * an erasure that silently left stale derived text about the person it erased
 * would be the failure this module exists to prevent, one derivation removed.
 */

import { createHash } from 'node:crypto';
import type { SQL } from 'bun';

import { normalize, slugify } from '../write/normalize.ts';
import { textArrayLiteral } from '../write/pg-values.ts';

/** Where the erasure instruction came from. `agent_mcp` is deliberately absent. */
export type ErasureAuthority = 'app' | 'panel' | 'operator';

export interface SubjectCounts {
  readonly pages: number;
  readonly chunks: number;
  readonly facts: number;
  readonly entities: number;
  readonly entityCards: number;
  readonly commitments: number;
  readonly edges: number;
}

const NOTHING: SubjectCounts = {
  pages: 0,
  chunks: 0,
  facts: 0,
  entities: 0,
  entityCards: 0,
  commitments: 0,
  edges: 0,
};

export interface SubjectMatch {
  readonly pageId: string;
  readonly externalRef: string | null;
  /** Which handle found it: the entity graph, or the identifier as text. */
  readonly handle: 'derivation' | 'text';
}

export interface SubjectErasurePreview {
  /** sha256 of the normalised identifier. The identifier itself is never stored. */
  readonly subjectDigest: string;
  /** The entities the identifier resolved to. Empty is a real, reportable answer. */
  readonly entityIds: readonly string[];
  /** Every surface form the sweep will match on: the identifier and its aliases. */
  readonly surfaceForms: readonly string[];
  readonly matches: readonly SubjectMatch[];
  readonly removed: SubjectCounts;
  /** Rows that survive with a hole in their evidence. */
  readonly recomputed: SubjectCounts;
  readonly recomputeRequired: boolean;
}

/**
 * The tombstone key.
 *
 * Digest, never the identifier: keeping `alice@example.com` in a table whose
 * whole purpose is that we no longer hold anything about her is the failure
 * wearing the fix's clothes. Normalised first, through the write path's own
 * normalizer, so the comparison is the one the brain would have made.
 */
export function subjectDigest(identifier: string): string {
  return createHash('sha256').update(normalize(identifier)).digest('hex');
}

/**
 * What erasing this correspondent would take, and what it would invalidate.
 *
 * Read-only. The controller sees this before instructing, exactly as they see a
 * blast radius before a `forget`.
 */
export async function previewSubjectErasure(
  sql: SQL,
  request: { readonly identifier: string },
): Promise<SubjectErasurePreview> {
  const digest = subjectDigest(request.identifier);
  const normalized = normalize(request.identifier);

  const entities = (await sql`
    SELECT DISTINCT e.entity_id::text AS entity_id, e.canonical_name
      FROM entity e
      LEFT JOIN entity_slug s ON s.entity_id = e.entity_id
      LEFT JOIN entity_alias a ON a.entity_id = e.entity_id
     WHERE e.deleted_at IS NULL
       AND (s.slug = ${slugify(request.identifier)} OR lower(a.alias) = ${normalized})
     ORDER BY e.entity_id::text
  `) as Array<{ entity_id: string; canonical_name: string }>;

  const entityIds = entities.map((row) => row.entity_id);

  const aliases =
    entityIds.length === 0
      ? []
      : ((await sql`
          SELECT DISTINCT alias FROM entity_alias
           WHERE entity_id = ANY(${textArrayLiteral(entityIds)}::text[]::bigint[])
        `) as Array<{ alias: string }>).map((row) => row.alias);

  // The identifier itself, the entities' canonical names, and every alias the
  // brain knows for them. Deduplicated and non-empty by construction.
  const surfaceForms = [
    ...new Set(
      [request.identifier, ...entities.map((row) => row.canonical_name), ...aliases]
        .map((form) => form.trim())
        .filter((form) => form.length > 0),
    ),
  ];

  const matches = await matchingPages(sql, entityIds, surfaceForms);
  const removed = await countRemoved(sql, entityIds, surfaceForms, matches);
  const recomputed = await countRecomputed(sql, entityIds, matches);

  return {
    subjectDigest: digest,
    entityIds,
    surfaceForms,
    matches,
    removed,
    recomputed,
    recomputeRequired:
      recomputed.facts + recomputed.entityCards + recomputed.commitments + recomputed.edges > 0,
  };
}

/** Objects a caller can empty. The key derivation stays with the caller (R9). */
export interface SubjectObjectStore {
  delete(key: string): Promise<boolean>;
}

export interface SubjectErasureDeps {
  readonly sql: SQL;
  /**
   * The raw payload's object key for one external ref, or `null` when the
   * caller cannot derive one. **The caller derives it**, through
   * `src/ingest/import/raw.ts:rawKeyFor` and therefore through the one accessor
   * that may build a key — this module never constructs one (`src/README.md`).
   */
  readonly rawKeyOf?: (externalRef: string) => string | null;
  readonly objects?: SubjectObjectStore;
}

export interface SubjectErasureReceipt extends SubjectErasurePreview {
  readonly erasedBy: ErasureAuthority;
  readonly erasedAt: string;
  /** R2 raw payloads removed, and the ones the caller could not name. */
  readonly rawObjectsRemoved: number;
  readonly rawObjectsUnreachable: number;
  /** True once `erased_subject` carries this digest. */
  readonly reingestionTombstoned: boolean;
  /** The same bound account erasure states, and deliberately not a longer one. */
  readonly unrecoverableAfterDays: number;
}

/** Imported rather than re-declared: one number, two erasure paths. */
import { PITR_WINDOW_DAYS } from './erasure.ts';

/**
 * Erase one correspondent from a brain that stays live.
 *
 * Soft-deletes rather than hard-deletes, deliberately: the 72-hour TTL cascade
 * (`src/mcp/tombstone.ts`) already exists, already purges, and already carries
 * the recovery window a mistaken erasure needs. A hard delete here would be a
 * second deletion mechanism with different semantics for the highest-stakes
 * operation in the product — and it would make an erasure instructed against the
 * wrong `alice` unrecoverable within the same second it was issued.
 *
 * **The tombstone is written in the same transaction as the deletions.** An
 * erasure that removed the rows and failed to write the suppression row is an
 * erasure the next poll undoes, and the receipt would already have been handed
 * over.
 */
export async function eraseSubject(
  deps: SubjectErasureDeps,
  request: {
    readonly identifier: string;
    readonly erasedBy: ErasureAuthority;
    readonly now?: Date;
  },
): Promise<SubjectErasureReceipt> {
  const sql = deps.sql;
  const preview = await previewSubjectErasure(sql, request);
  const at = (request.now ?? new Date()).toISOString();
  const pageIds = preview.matches.map((match) => match.pageId);
  const forms = preview.surfaceForms;

  await sql.begin(async (tx) => {
    if (pageIds.length > 0) {
      const ids = textArrayLiteral(pageIds);
      await tx`UPDATE fact SET deleted_at = ${at}::timestamptz
                WHERE deleted_at IS NULL AND page_id = ANY(${ids}::text[]::bigint[])`;
      await tx`UPDATE chunk SET deleted_at = ${at}::timestamptz
                WHERE deleted_at IS NULL AND page_id = ANY(${ids}::text[]::bigint[])`;
      await tx`UPDATE page SET deleted_at = ${at}::timestamptz
                WHERE deleted_at IS NULL AND page_id = ANY(${ids}::text[]::bigint[])`;
    }

    // Facts and commitments that name the subject in their own text, wherever
    // they came from. Without this the person's card goes and every sentence
    // about them keeps answering `recall`.
    for (const form of forms) {
      const pattern = `%${escapeLike(form)}%`;
      await tx`UPDATE fact SET deleted_at = ${at}::timestamptz
                WHERE deleted_at IS NULL AND statement ILIKE ${pattern}`;
      await tx`UPDATE commitment SET deleted_at = ${at}::timestamptz
                WHERE deleted_at IS NULL
                  AND (statement ILIKE ${pattern} OR coalesce(owner_name, '') ILIKE ${pattern})`;
    }

    // **The snapshot table is a second copy of every document**, and this unit
    // built it. `page_version` outlives the 72h purge by design (its foreign key
    // is ON DELETE SET NULL, so history survives a tombstone being reaped) — so
    // a subject erasure that retracted the page and left the snapshot would hand
    // the requester a receipt while her mail sat verbatim in a table nothing
    // else will ever sweep. Keyed on `doc_key` rather than `page_id`, because
    // `page_id` may already have been nulled by an earlier purge.
    const docKeys = preview.matches.map((match) =>
      match.externalRef === null ? `page:${match.pageId}` : match.externalRef,
    );
    if (docKeys.length > 0) {
      await tx`DELETE FROM page_version WHERE doc_key = ANY(${textArrayLiteral(docKeys)}::text[])`;
    }

    if (preview.entityIds.length > 0) {
      const ids = textArrayLiteral(preview.entityIds);
      await tx`UPDATE entity_card SET deleted_at = ${at}::timestamptz
                WHERE deleted_at IS NULL AND entity_id = ANY(${ids}::text[]::bigint[])`;
      await tx`DELETE FROM entity_edge
                WHERE subject_entity_id = ANY(${ids}::text[]::bigint[])
                   OR object_entity_id = ANY(${ids}::text[]::bigint[])`;
      await tx`UPDATE entity SET deleted_at = ${at}::timestamptz
                WHERE deleted_at IS NULL AND entity_id = ANY(${ids}::text[]::bigint[])`;
    }

    // Same transaction as the deletions. An erasure that removed the rows and
    // failed to suppress re-ingestion is one the next poll silently undoes.
    await tx`
      INSERT INTO erased_subject (subject_digest, erased_at, erased_by,
                                  pages_removed, facts_removed, entities_removed, artifacts_recomputed)
      VALUES (${preview.subjectDigest}, ${at}::timestamptz, ${request.erasedBy},
              ${preview.removed.pages}, ${preview.removed.facts}, ${preview.removed.entities},
              ${preview.recomputed.facts + preview.recomputed.entityCards + preview.recomputed.commitments})
      ON CONFLICT (subject_digest) DO UPDATE
        SET erased_at = EXCLUDED.erased_at,
            erased_by = EXCLUDED.erased_by,
            pages_removed = erased_subject.pages_removed + EXCLUDED.pages_removed,
            facts_removed = erased_subject.facts_removed + EXCLUDED.facts_removed,
            entities_removed = erased_subject.entities_removed + EXCLUDED.entities_removed,
            artifacts_recomputed = erased_subject.artifacts_recomputed + EXCLUDED.artifacts_recomputed
    `;

    return { value: null };
  });

  let rawObjectsRemoved = 0;
  let rawObjectsUnreachable = 0;
  if (deps.objects !== undefined && deps.rawKeyOf !== undefined) {
    for (const match of preview.matches) {
      if (match.externalRef === null) continue;
      const key = deps.rawKeyOf(match.externalRef);
      if (key === null) {
        rawObjectsUnreachable += 1;
        continue;
      }
      if (await deps.objects.delete(key)) rawObjectsRemoved += 1;
    }
  } else {
    rawObjectsUnreachable = preview.matches.filter((match) => match.externalRef !== null).length;
  }

  const tombstoned = (await sql`
    SELECT 1 AS present FROM erased_subject WHERE subject_digest = ${preview.subjectDigest}
  `) as Array<{ present: number }>;

  return {
    ...preview,
    erasedBy: request.erasedBy,
    erasedAt: at,
    rawObjectsRemoved,
    rawObjectsUnreachable,
    reingestionTombstoned: tombstoned.length === 1,
    unrecoverableAfterDays: PITR_WINDOW_DAYS,
  };
}

/**
 * Whether this brain has been instructed to hold nothing about this person.
 *
 * The pull path's question, and the only one that stops the next poll from
 * undoing an erasure. It takes the raw identifier and hashes it here, so no
 * caller has to know the tombstone stores a digest — and so no caller is
 * tempted to store the plaintext to compare against.
 */
export async function isErasedSubject(sql: SQL, identifier: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 AS present FROM erased_subject WHERE subject_digest = ${subjectDigest(identifier)}
  `) as Array<{ present: number }>;
  return rows.length === 1;
}

async function matchingPages(
  sql: SQL,
  entityIds: readonly string[],
  surfaceForms: readonly string[],
): Promise<SubjectMatch[]> {
  const matches = new Map<string, SubjectMatch>();

  // The text handle. Title or passage — a mail whose body names them and whose
  // subject line does not is the ordinary case.
  for (const form of surfaceForms) {
    const pattern = `%${escapeLike(form)}%`;
    const rows = (await sql`
      SELECT DISTINCT p.page_id::text AS page_id, p.external_ref
        FROM page p
        LEFT JOIN chunk c ON c.page_id = p.page_id AND c.deleted_at IS NULL
       WHERE p.deleted_at IS NULL
         AND (coalesce(p.title, '') ILIKE ${pattern} OR c.content ILIKE ${pattern})
    `) as Array<{ page_id: string; external_ref: string | null }>;
    for (const row of rows) {
      if (!matches.has(row.page_id)) {
        matches.set(row.page_id, { pageId: row.page_id, externalRef: row.external_ref, handle: 'text' });
      }
    }
  }

  // **There is deliberately no page-discovery arm here for the entity graph, and
  // the reason is a hazard rather than an omission.** The schema has no
  // structural edge from a fact to the entity it is about: `fact_source` reaches
  // chunks, `entity_edge` reaches entities, and nothing joins the two. The
  // tempting proxy is to walk `entity_edge` and match facts whose origins
  // overlap the edge's — and it is catastrophically wrong, in the *ordinary*
  // shape rather than an exotic one. In a single-origin brain (every row
  // `personal`, which is what an alpha tenant looks like) every fact's origins
  // overlap every edge's, so once the subject has one edge the arm matches every
  // fact-bearing page in the brain and the erasure deletes it. Origin overlap is
  // a fence, not a derivation edge.
  //
  // So page discovery is the text handle, and the entity subtree below is
  // reached directly by id. The limit that leaves — a page that mentions the
  // correspondent, from which no fact was extracted, and which contains neither
  // the identifier nor any known alias as text — is stated in this module's
  // header rather than papered over with a proxy that over-matches. The
  // `handle` field stays on {@link SubjectMatch} for the day a structural link
  // exists; until then every match is honestly `text`.
  void entityIds;

  return [...matches.values()].sort((left, right) => Number(left.pageId) - Number(right.pageId));
}

async function countRemoved(
  sql: SQL,
  entityIds: readonly string[],
  surfaceForms: readonly string[],
  matches: readonly SubjectMatch[],
): Promise<SubjectCounts> {
  if (matches.length === 0 && entityIds.length === 0) return NOTHING;

  const pageIds = textArrayLiteral(matches.map((match) => match.pageId));
  const ids = textArrayLiteral(entityIds);
  const patterns = textArrayLiteral(surfaceForms.map((form) => `%${escapeLike(form)}%`));

  const rows = (await sql`
    SELECT
      (SELECT count(*)::int FROM page
        WHERE deleted_at IS NULL AND page_id = ANY(${pageIds}::text[]::bigint[])) AS pages,
      (SELECT count(*)::int FROM chunk
        WHERE deleted_at IS NULL AND page_id = ANY(${pageIds}::text[]::bigint[])) AS chunks,
      (SELECT count(*)::int FROM fact
        WHERE deleted_at IS NULL
          AND (page_id = ANY(${pageIds}::text[]::bigint[])
               OR statement ILIKE ANY(${patterns}::text[]))) AS facts,
      (SELECT count(*)::int FROM entity
        WHERE deleted_at IS NULL AND entity_id = ANY(${ids}::text[]::bigint[])) AS entities,
      (SELECT count(*)::int FROM entity_card
        WHERE deleted_at IS NULL AND entity_id = ANY(${ids}::text[]::bigint[])) AS entity_cards,
      (SELECT count(*)::int FROM commitment
        WHERE deleted_at IS NULL
          AND (statement ILIKE ANY(${patterns}::text[])
               OR coalesce(owner_name, '') ILIKE ANY(${patterns}::text[]))) AS commitments,
      (SELECT count(*)::int FROM entity_edge
        WHERE subject_entity_id = ANY(${ids}::text[]::bigint[])
           OR object_entity_id = ANY(${ids}::text[]::bigint[])) AS edges
  `) as Array<Record<string, number>>;

  return shape(rows[0]);
}

/**
 * Rows that survive and are no longer correct.
 *
 * Two shapes, and both are derivation losing an input rather than losing a row:
 * a surviving fact one of whose source chunks is going, and a surviving
 * entity's card where an edge to the erased person is going. Neither is deleted
 * by this erasure and neither can be trusted until a cycle re-derives it.
 */
async function countRecomputed(
  sql: SQL,
  entityIds: readonly string[],
  matches: readonly SubjectMatch[],
): Promise<SubjectCounts> {
  if (matches.length === 0 && entityIds.length === 0) return NOTHING;

  const pageIds = textArrayLiteral(matches.map((match) => match.pageId));
  const ids = textArrayLiteral(entityIds);

  const rows = (await sql`
    SELECT
      0 AS pages, 0 AS chunks, 0 AS entities, 0 AS edges,
      (SELECT count(DISTINCT f.fact_id)::int FROM fact f
         JOIN fact_source fs ON fs.fact_id = f.fact_id
         JOIN chunk c ON c.chunk_id = fs.chunk_id
        WHERE f.deleted_at IS NULL
          AND NOT (f.page_id = ANY(${pageIds}::text[]::bigint[]))
          AND c.page_id = ANY(${pageIds}::text[]::bigint[])) AS facts,
      (SELECT count(DISTINCT card.card_id)::int FROM entity_card card
         JOIN entity_edge e
           ON e.subject_entity_id = card.entity_id OR e.object_entity_id = card.entity_id
        WHERE card.deleted_at IS NULL
          AND NOT (card.entity_id = ANY(${ids}::text[]::bigint[]))
          AND (e.subject_entity_id = ANY(${ids}::text[]::bigint[])
               OR e.object_entity_id = ANY(${ids}::text[]::bigint[]))) AS entity_cards,
      (SELECT count(*)::int FROM commitment c
        WHERE c.deleted_at IS NULL
          AND c.page_id = ANY(${pageIds}::text[]::bigint[])) AS commitments
  `) as Array<Record<string, number>>;

  return shape(rows[0]);
}

function shape(row: Record<string, number> | undefined): SubjectCounts {
  const source = row ?? {};
  return {
    pages: Number(source.pages ?? 0),
    chunks: Number(source.chunks ?? 0),
    facts: Number(source.facts ?? 0),
    entities: Number(source.entities ?? 0),
    entityCards: Number(source.entity_cards ?? 0),
    commitments: Number(source.commitments ?? 0),
    edges: Number(source.edges ?? 0),
  };
}

/**
 * `%` and `_` are LIKE metacharacters, and a correspondent's name is theirs.
 *
 * The same rule U8's folder sweep applies to a root id, one table over: an
 * identifier carrying a metacharacter would widen its own sweep across other
 * people's records — and here the sweep *deletes*.
 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}
