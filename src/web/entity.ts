/**
 * One named subject, as the owner's own record of them — the read behind
 * `/dashboard?view=entity`.
 *
 * ===========================================================================
 * THE PAGE THIS IS NOT, AND WHY THAT REFUSAL IS THE DESIGN
 * ===========================================================================
 *
 * The owner asked for a page listing the people, companies, facts and
 * relationships their brain knows about. **That page is not built, and this one
 * exists instead.** `src/web/coverage.ts` refuses the roster in four numbered
 * arguments; the second is the one that decides it:
 *
 *   *"A count survives being screenshotted into a support thread, cast to a
 *   meeting-room display and left open on a desk; a list of forty names does
 *   not — and it is the AGGREGATION that does the damage, because any one name
 *   is in the user's mail anyway while this page would be the only artifact
 *   that renders their whole address book in one screenful."*
 *
 * At the measured size that is not a risk, it is a description: this brain holds
 * **53 entities**, so "the list" and "one screenful" are the same object and
 * there is no page size at which the harm goes away.
 *
 * ===========================================================================
 * WHAT MAKES A LOOKUP DIFFERENT FROM A ROSTER, MECHANICALLY
 * ===========================================================================
 *
 * `?view=review` crosses the same privacy line and licenses itself on four
 * properties: navigated to, holds only what is undecided, **steady state
 * empty**, and every row a question the system asked. A roster scores one of
 * four. This page reaches the third by a different mechanism — with no name
 * submitted it renders **nothing at all**, and opens no tenant database — and
 * replaces the second with *only the one subject the owner supplied*.
 *
 * That substitution is only true if a found render does not emit names the
 * querent did not supply, which is what shapes three of the six statements:
 *
 *   * **Outbound edges name their neighbour; inbound edges are counted.** An
 *     edge whose *subject* is the queried entity is a property of it — *works
 *     at Acme* — few and about the person asked for. An edge whose *object* is
 *     the queried entity is a membership list of other people: `works_at` is
 *     seeded with inverse `employs`, so the owner's employer accumulates inbound
 *     rows and rendering them by name is a colleague roster. Inbound therefore
 *     renders as *"21 people work here"* — a count and a closed-vocabulary code
 *     from a registry whose own COMMENT reads "no user content".
 *   * **The outbound ceiling is 8, and the arithmetic is the bound.** A ceiling
 *     of 25 would sit *above* this brain's 27 edges, and a bound that cannot
 *     bind is a formality — which is this module's own reason for refusing the
 *     roster. Eight is above the honest maximum for a real subject and below the
 *     26 people a roster would reach.
 *   * **The mention census renders counts and never statements.** A statement is
 *     mail prose and routinely names several parties, and nothing in a
 *     word-boundary predicate bounds how many *other* people a matched sentence
 *     names. Twenty-five of them is more third-party names in one screenful than
 *     the roster this module refuses — and the highest-yield query is the most
 *     natural first one anybody types: their own name, or their employer.
 *
 * ===========================================================================
 * THE HONEST LIMIT OF THE CENSUS, WHICH THE PAGE STATES RATHER THAN HIDES
 * ===========================================================================
 *
 * **There is no fact-to-entity link in this schema.** `fact` carries `page_id`
 * and `origin_contexts` and nothing that reaches an entity; every entity-to-fact
 * path in the codebase is a text scan. So this counts *live sentences whose text
 * contains this name* — not everything the brain knows about them, and, for a
 * common name, possibly a sentence about somebody else. A caption reading "what
 * your brain knows about X" over a text match would attribute other people's
 * statements to X with no way for the owner to tell. A census with the caveat
 * printed beside it is the honest version of the same information, and it is
 * what lets the number reconcile with coverage's own fact count.
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
 * accounts." A mixed card genuinely carries surviving evidence. Review went
 * stricter only because `review_queue` is swept by nothing at all; that reason
 * does not carry here. A page that withheld mixed rows would be the only
 * surface in the product saying "nothing is known about this person" while the
 * assistant answers happily.
 *
 * **Aliases are not origin-filtered either**, unlike the `entity` tool's subset
 * fence — that fence exists because a caller may hold only one half of the
 * brain, and this caller is the account holder who holds both. Recorded so the
 * omission reads as a decision.
 *
 * **`entity` is joined live behind every alias, slug and edge touch.**
 * `entity_alias` and `entity_slug` carry no `deleted_at` at all and hold the
 * identifier in plaintext — they go when the purge takes the entity — so
 * without the join an erased correspondent's name renders for the full 72 hours
 * before the purge. On edges the join is needed on **both** endpoints and for
 * the counted arm as much as the named one: severance writes no `deleted_at` on
 * `entity_edge`, relying on both endpoints being tombstoned and the row leaving
 * at purge by cascade. Between severance and purge an edge is live with a dead
 * endpoint, so the named arm would render a severed relationship with two names
 * on it and the counted arm would inflate *"employs: 21"* with a tombstoned
 * person. Subject erasure hard-deletes edges, so only severance produces that
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

export type EntityLookup =
  | { readonly status: 'idle' }
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
