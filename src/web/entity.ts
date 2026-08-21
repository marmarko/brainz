/**
 * The people and companies a brain holds — the read behind
 * `/dashboard?view=entity`.
 *
 * ===========================================================================
 * THIS PAGE WAS REFUSED, AND THEN ASKED FOR AGAIN. BOTH ARE RECORDED.
 * ===========================================================================
 *
 * `src/web/coverage.ts` refuses a roster of the brain's entities in four
 * numbered arguments, and the second is the sharpest:
 *
 *   *"A count survives being screenshotted into a support thread, cast to a
 *   meeting-room display and left open on a desk; a list of forty names does
 *   not — and it is the AGGREGATION that does the damage, because any one name
 *   is in the user's mail anyway while this page would be the only artifact
 *   that renders their whole address book in one screenful."*
 *
 * This module shipped first as a **resting-empty lookup** on exactly that
 * argument: one subject, named by the owner, nothing until they typed. The
 * owner then asked for the list, twice, with pagination. **That is their call
 * to make — it is their brain and their data — and this file now serves it.**
 *
 * The argument is not deleted, because it was not wrong. It is recorded, along
 * with what changed:
 *
 *   * **The harm is real and is now accepted rather than avoided.** At the
 *     measured size — 53 entities — "the list" and "one screenful" are close to
 *     the same object, and paginating at {@link ROSTER_PAGE} does not change
 *     that much. Anyone who can see this page can see who the brain knows.
 *   * **What the page can still honestly do is warn.** The rule paragraph names
 *     the risk in the reader's own words — *this one is about somebody: it is
 *     not safe to screenshot* — instead of implying a safety the page no longer
 *     has. That sentence was written for the lookup and is more load-bearing
 *     now, not less.
 *   * **The mitigations that survive are the ones that cost nothing.** The list
 *     carries names and types and nothing else: no card text, no statements, no
 *     edges, no mention counts. Detail stays one deliberate click away, and the
 *     per-subject reads are unchanged. So a glance at this page reveals the
 *     address book; it does not reveal what the brain says about anybody in it.
 *   * **Navigation stays a POST.** A page number in the URL leaks nothing, so
 *     paging is a GET — but opening a subject still posts their name in a body
 *     rather than a query string, because browser history and URL-bar
 *     autocomplete sync across devices and outlive the session. The page shows
 *     names to whoever is looking at it; it does not write them into an
 *     artifact the owner cannot clear.
 *
 * If the roster is ever reconsidered, the thing to re-read is `coverage.ts`'s
 * four arguments, not this paragraph.
 *
 * ===========================================================================
 * THE HONEST LIMIT OF THE CENSUS, WHICH THE PAGE STATES RATHER THAN HIDES
 * ===========================================================================
 *
 * **There is no fact-to-entity link in this schema.** `fact` carries `page_id`
 * and `origin_contexts` and nothing that reaches an entity; every entity-to-fact
 * path in the codebase is a text scan. So the mention census counts *live
 * sentences whose text contains this name* — not everything the brain knows
 * about them, and, for a common name, possibly a sentence about somebody else.
 * A caption reading "what your brain knows about X" over a text match would
 * attribute other people's statements to X with no way for the owner to tell.
 *
 * ===========================================================================
 * WHAT STILL SHAPES THE PER-SUBJECT READ
 * ===========================================================================
 *
 *   * **Outbound edges name their neighbour; inbound edges are counted.** An
 *     edge whose *object* is the queried entity is a membership list of other
 *     people: `works_at` is seeded with inverse `employs`, so an employer
 *     accumulates inbound rows and naming them is a colleague roster nested
 *     inside a subject page. Inbound renders as *"21 people work here"* — a
 *     count and a code from a registry whose own COMMENT reads "no user
 *     content".
 *   * **The census renders counts and never statements.** A statement is mail
 *     prose that routinely names several parties, and nothing in a
 *     word-boundary predicate bounds how many *other* people a matched sentence
 *     names.
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY NOT FENCED, AND WHY THAT IS A DECISION
 * ===========================================================================
 *
 * **No severance predicate beyond `deleted_at IS NULL`, and that is the system
 * baseline rather than an omission.** Severance is exact-origin: it tombstones
 * rows whose origins are a *subset* of the severed one, deliberately, because
 * the `@>` alternative "would tombstone every mixed row: the user disconnects
 * work and loses their shared history with everyone they know through both
 * accounts." A page that withheld mixed rows would be the only surface in the
 * product saying "nothing is known about this person" while the assistant
 * answers happily.
 *
 * **`entity` is joined live behind every alias, slug and edge touch.**
 * `entity_alias` and `entity_slug` carry no `deleted_at` at all and hold the
 * identifier in plaintext — they go when the purge takes the entity — so
 * without the join an erased correspondent's name renders for the full 72 hours
 * before the purge. On edges the join is needed on **both** endpoints and for
 * the counted arm as much as the named one: severance writes no `deleted_at` on
 * `entity_edge`, relying on both endpoints being tombstoned and the row leaving
 * at purge by cascade. Between severance and purge an edge is live with a dead
 * endpoint. Subject erasure hard-deletes edges, so only severance produces that
 * state — which is exactly why it survives casual testing.
 */

import type { SQL } from 'bun';

import { nameMatchPattern } from '../core/search/name-match.ts';
import { normalize } from '../core/write/normalize.ts';
import type { EntityKind } from './coverage.ts';

/** A name is a label, not a paragraph. Review's constant, for review's reason. */
export const NAME_CHARACTERS = 200;

/** A card summary is prose a model wrote, with no length CHECK behind it. */
export const SUMMARY_CHARACTERS = 2000;

/**
 * Outbound neighbours named on one render.
 *
 * Eight rather than twenty-five: this brain holds 27 edges over 53 entities, so
 * a ceiling of 25 would sit above the corpus, and a bound that cannot bind is a
 * formality. Raising this means re-deriving the paragraph above it.
 */
export const OUTBOUND_EDGE_CEILING = 8;

/** Spellings of the subject the querent already named: a render bound only. */
export const ALIAS_CEILING = 25;

/**
 * Below this, a name is a substring rather than a name.
 *
 * The briefing ships exactly this guard on the same substring join, and
 * `resolveOrCreateEntity` writes a normalized surface form as an alias with no
 * length floor — so `Ed`, `IT`, `HR` and `AI` are ordinary rows rather than
 * exotic ones. `canonical_name` also carries no non-empty CHECK, and an empty
 * pattern matches every live fact.
 */
export const MENTION_NAME_FLOOR = 3;

/** Above this the census is skipped with a sentence: a pathological name is a per-row comparand across every live fact. */
export const MENTION_NAME_CEILING = 200;

/**
 * Subjects listed per page of the roster.
 *
 * **Offset paging rather than keyset, and the reason is what a cursor would
 * have to carry.** A keyset cursor over an alphabetical list is a NAME, and it
 * would ride in the query string into browser history and URL-bar
 * autocomplete — the one artifact this page still refuses to write. A page
 * number carries nothing. The cost of offset is deep-page scanning, and at this
 * corpus size (53 entities, three pages) it is not a cost; the row to watch is
 * this one, and the remedy if a brain ever holds tens of thousands of entities
 * is a keyset cursor over `entity_id` — opaque, and not a name.
 *
 * The honest wart: offset drifts if a consolidation cycle inserts an entity
 * between two page loads, so a row can be seen twice or missed. On a corpus
 * that changes a few times an hour that is a smaller harm than a name in the
 * address bar.
 */
export const ROSTER_PAGE = 25;

export interface Subject {
  readonly name: string;
  readonly nameTruncated: boolean;
  readonly type: EntityKind;
  readonly firstSeenAt: string;
  readonly origins: readonly string[];
  readonly card: {
    readonly summary: string;
    readonly truncated: boolean;
    readonly trustLevel: string;
    readonly derivation: string;
    readonly writtenAt: string;
  } | null;
  readonly aliases: readonly {
    readonly alias: string;
    readonly truncated: boolean;
    readonly source: string;
  }[];
  readonly aliasesOverflowed: boolean;
  /** Properties OF this subject, each naming one neighbour. */
  readonly outbound: readonly {
    readonly type: string;
    readonly otherName: string;
    readonly otherTruncated: boolean;
    readonly otherType: EntityKind;
    readonly at: string;
  }[];
  readonly outboundOverflowed: boolean;
  /** Who points AT this subject. Counts and declared-inverse codes. Never names. */
  readonly inbound: readonly { readonly type: string; readonly count: number }[];
  readonly mentions:
    | {
        readonly kind: 'counted';
        readonly total: number;
        readonly mostRecentAt: string | null;
        readonly byTrust: readonly { readonly level: string; readonly count: number }[];
      }
    | { readonly kind: 'name_too_short' }
    | { readonly kind: 'name_too_long' };
}

export interface RosterEntry {
  readonly name: string;
  readonly truncated: boolean;
  readonly type: EntityKind;
  /** Whether the brain has written a summary. A boolean, never the text. */
  readonly hasCard: boolean;
}

export interface Roster {
  readonly entries: readonly RosterEntry[];
  readonly total: number;
  /** Zero-based, as it arrives from the query string. */
  readonly page: number;
  readonly pages: number;
}

export type EntityLookup =
  | { readonly status: 'browsing'; readonly roster: Roster }
  | { readonly status: 'not_found' }
  | { readonly status: 'ambiguous' }
  | { readonly status: 'found'; readonly subject: Subject };

function isoOf(value: Date | string | null): string {
  if (value === null) return '';
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Resolve one name and read everything the page renders about it.
 *
 * Six statements at most, and the first one short-circuits: an input that
 * normalizes to nothing returns before any of them. That is structural rather
 * than merely tested — the alias and slug rungs are blocked by their own CHECKs,
 * but the third rung is `lower(canonical_name) = ''` against a column with no
 * non-empty CHECK.
 */
/**
 * One page of the roster.
 *
 * **Names and types and one boolean, and nothing else.** No card text, no
 * statements, no edges, no counts per subject: a glance at this page reveals
 * who the brain knows, which is what the owner asked for, and does not reveal
 * what it says about any of them. That is the line the detail view is on the
 * other side of, one deliberate click away.
 */
export async function listEntities(sql: SQL, page: number): Promise<Roster> {
  const at = Number.isFinite(page) && page > 0 ? Math.floor(page) : 0;

  const totals = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM entity WHERE deleted_at IS NULL`,
    [],
  )) as Array<{ n: number }>;
  const total = totals[0]?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / ROSTER_PAGE));
  const bounded = Math.min(at, pages - 1);

  const rows = (await sql.unsafe(
    `SELECT left(e.canonical_name, $1::int)    AS name,
            length(e.canonical_name) > $1::int AS truncated,
            e.entity_type,
            EXISTS (
              SELECT 1 FROM entity_card c
               WHERE c.entity_id = e.entity_id AND c.deleted_at IS NULL
            ) AS has_card
       FROM entity e
      WHERE e.deleted_at IS NULL
      ORDER BY lower(e.canonical_name), e.entity_id
      LIMIT $2::int OFFSET $3::int`,
    [NAME_CHARACTERS, ROSTER_PAGE, bounded * ROSTER_PAGE],
  )) as Array<{ name: string; truncated: boolean; entity_type: EntityKind; has_card: boolean }>;

  return {
    entries: rows.map((row) => ({
      name: row.name,
      truncated: row.truncated,
      type: row.entity_type,
      hasCard: row.has_card,
    })),
    total,
    page: bounded,
    pages,
  };
}

export async function lookupEntity(sql: SQL, name: string): Promise<EntityLookup> {
  const key = normalize(name);
  if (key.length === 0) return { status: 'not_found' };

  // Three rungs, ALL equality — no LIKE, no prefix, no trigram, nowhere on this
  // page. 'LIMIT 2' so "one thing answers to this name" and "more than one
  // does" are different facts; two rows render the ambiguous state with no
  // count, because LIMIT 2 cannot produce a truthful one.
  const matched = (await sql.unsafe(
    `WITH matched AS (
       SELECT a.entity_id, 1 AS rung FROM entity_alias a WHERE a.alias = $1
       UNION ALL
       SELECT s.entity_id, 2 AS rung FROM entity_slug  s WHERE s.slug  = $1
       UNION ALL
       SELECT e.entity_id, 3 AS rung FROM entity       e WHERE lower(e.canonical_name) = $1
     ),
     resolved AS (SELECT entity_id, min(rung) AS rung FROM matched GROUP BY entity_id)
     SELECT e.entity_id::text                  AS entity_id,
            e.canonical_name                   AS name_raw,
            left(e.canonical_name, $2::int)    AS name,
            length(e.canonical_name) > $2::int AS name_truncated,
            e.entity_type, e.origin_contexts, e.created_at
       FROM resolved r
       JOIN entity e ON e.entity_id = r.entity_id
      WHERE e.deleted_at IS NULL
      ORDER BY r.rung, e.entity_id
      LIMIT 2`,
    [key, NAME_CHARACTERS],
  )) as Array<{
    entity_id: string;
    name_raw: string;
    name: string;
    name_truncated: boolean;
    entity_type: EntityKind;
    origin_contexts: string[];
    created_at: Date | string;
  }>;

  if (matched.length === 0) return { status: 'not_found' };
  if (matched.length > 1) return { status: 'ambiguous' };
  const found = matched[0];
  if (found === undefined) return { status: 'not_found' };
  const entityId = found.entity_id;

  const cards = (await sql.unsafe(
    `SELECT left(c.summary, $2::int)    AS summary,
            length(c.summary) > $2::int AS summary_truncated,
            c.trust_level, c.derivation, c.created_at
       FROM entity_card c
       JOIN entity e ON e.entity_id = c.entity_id AND e.deleted_at IS NULL
      WHERE c.entity_id = $1::bigint AND c.deleted_at IS NULL
      LIMIT 1`,
    [entityId, SUMMARY_CHARACTERS],
  )) as Array<{
    summary: string;
    summary_truncated: boolean;
    trust_level: string;
    derivation: string;
    created_at: Date | string;
  }>;
  const cardRow = cards[0];

  const aliasRows = (await sql.unsafe(
    `SELECT left(a.alias, $2::int)    AS alias,
            length(a.alias) > $2::int AS truncated,
            a.alias_source
       FROM entity_alias a
       JOIN entity e ON e.entity_id = a.entity_id AND e.deleted_at IS NULL
      WHERE a.entity_id = $1::bigint
      ORDER BY a.alias
      LIMIT $3::int`,
    [entityId, NAME_CHARACTERS, ALIAS_CEILING + 1],
  )) as Array<{ alias: string; truncated: boolean; alias_source: string }>;

  const outboundRows = (await sql.unsafe(
    `SELECT x.edge_type                        AS type_code,
            left(o.canonical_name, $2::int)    AS other_name,
            length(o.canonical_name) > $2::int AS other_truncated,
            o.entity_type                      AS other_type,
            x.created_at
       FROM entity_edge x
       JOIN entity s ON s.entity_id = x.subject_entity_id AND s.deleted_at IS NULL
       JOIN entity o ON o.entity_id = x.object_entity_id  AND o.deleted_at IS NULL
      WHERE x.subject_entity_id = $1::bigint AND x.deleted_at IS NULL
      ORDER BY x.created_at DESC
      LIMIT $3::int`,
    [entityId, NAME_CHARACTERS, OUTBOUND_EDGE_CEILING + 1],
  )) as Array<{
    type_code: string;
    other_name: string;
    other_truncated: boolean;
    other_type: EntityKind;
    created_at: Date | string;
  }>;

  // The declared inverse, not the stored type: traversal in the other direction
  // reads the type's registered inverse instead of a mirrored row, so without
  // the 'edge_type' join an inbound 'works_at' reads backwards.
  const inboundRows = (await sql.unsafe(
    `SELECT t.inverse_type AS type_code, count(*)::int AS n
       FROM entity_edge x
       JOIN edge_type t ON t.edge_type = x.edge_type
       JOIN entity s ON s.entity_id = x.subject_entity_id AND s.deleted_at IS NULL
       JOIN entity o ON o.entity_id = x.object_entity_id  AND o.deleted_at IS NULL
      WHERE x.object_entity_id = $1::bigint AND x.deleted_at IS NULL
      GROUP BY t.inverse_type
      ORDER BY n DESC, t.inverse_type`,
    [entityId],
  )) as Array<{ type_code: string; n: number }>;

  // The census matches on the UNCAPPED canonical name: the cap is a render
  // concern, and matching a truncated name would silently widen the set.
  const raw = found.name_raw.trim();
  let mentions: Subject['mentions'];
  if (raw.length < MENTION_NAME_FLOOR) {
    mentions = { kind: 'name_too_short' };
  } else if (raw.length > MENTION_NAME_CEILING) {
    mentions = { kind: 'name_too_long' };
  } else {
    const censusRows = (await sql.unsafe(
      `SELECT coalesce(trust_level, 'unrecorded') AS trust_level,
              count(*)::int                       AS n,
              max(created_at)                     AS most_recent
         FROM fact
        WHERE deleted_at IS NULL
          AND quarantined_at IS NULL
          AND superseded_by IS NULL
          AND statement ~* $1
        GROUP BY 1
        ORDER BY n DESC, 1`,
      [nameMatchPattern(raw)],
    )) as Array<{ trust_level: string; n: number; most_recent: Date | string | null }>;

    const total = censusRows.reduce((sum, row) => sum + row.n, 0);
    const instants = censusRows
      .map((row) => (row.most_recent === null ? null : isoOf(row.most_recent)))
      .filter((value): value is string => value !== null)
      .sort();
    mentions = {
      kind: 'counted',
      total,
      mostRecentAt: instants[instants.length - 1] ?? null,
      byTrust: censusRows.map((row) => ({ level: row.trust_level, count: row.n })),
    };
  }

  return {
    status: 'found',
    subject: {
      name: found.name,
      nameTruncated: found.name_truncated,
      type: found.entity_type,
      firstSeenAt: isoOf(found.created_at),
      origins: found.origin_contexts,
      card:
        cardRow === undefined
          ? null
          : {
              summary: cardRow.summary,
              truncated: cardRow.summary_truncated,
              trustLevel: cardRow.trust_level,
              derivation: cardRow.derivation,
              writtenAt: isoOf(cardRow.created_at),
            },
      aliases: aliasRows.slice(0, ALIAS_CEILING).map((row) => ({
        alias: row.alias,
        truncated: row.truncated,
        source: row.alias_source,
      })),
      aliasesOverflowed: aliasRows.length > ALIAS_CEILING,
      outbound: outboundRows.slice(0, OUTBOUND_EDGE_CEILING).map((row) => ({
        type: row.type_code,
        otherName: row.other_name,
        otherTruncated: row.other_truncated,
        otherType: row.other_type,
        at: isoOf(row.created_at),
      })),
      outboundOverflowed: outboundRows.length > OUTBOUND_EDGE_CEILING,
      inbound: inboundRows.map((row) => ({ type: row.type_code, count: row.n })),
      mentions,
    },
  };
}
