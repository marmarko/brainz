/**
 * Making two entity rows into one, and the two routines that do the moving.
 *
 * **This module is exported and, in the commit that introduces it, called by
 * nothing.** That is deliberate: the shared routines below are what
 * {@link widenEntityOrigins} has always needed and never had, and landing them
 * with no caller means the commit that wires them in changes one function
 * rather than inventing a primitive at the same time.
 *
 * **Two arms, and they differ in exactly one thing: how the surviving row is
 * produced.**
 *
 *   * **In-place** — the primary's `origin_contexts` already covers the union of
 *     every member's, so the primary survives with its own `entity_id`. Worth
 *     the extra branch rather than always minting: the id is what an open
 *     `review_queue.target_ref` names, what `undoProposal` holds, and what the
 *     purge window would otherwise fill with another tombstone.
 *   * **Successor** — it does not, and `UPDATE entity SET origin_contexts` is
 *     refused outright by `refuse_origin_change` (BZ001), whose hint states the
 *     only remedy: *a row whose origin would change is a different row; write a
 *     new one and tombstone this one*. So a successor is minted, carrying every
 *     column the predecessor had.
 *
 * **The edges are NOT an arm difference, and this is the trap worth naming.**
 * It reads as though the in-place arm could simply re-point an edge's subject,
 * the way `mergeEntitiesByRule` does — but that function is legal only because
 * its bucket key pins the two rows' origin sets *identical*, which is precisely
 * the property a cross-origin merge gives up. Take a keeper carrying
 * `{work, personal}`, a loser carrying `{work}`, and a third party carrying
 * `{work}`. The keeper already covers the union, so the in-place arm is chosen.
 * Re-point the loser's edge onto the keeper and `assert_edge_origin_union`
 * requires that edge to carry `{work, personal}` — it carries `{work}` — and
 * raises BZ002 at commit. So **every** edge that moves is retired and
 * re-inserted with the union, on both arms.
 *
 * **The same is true of the card**, for the same reason and one more:
 * `entity_card.origin_contexts` is immutable by trigger, so there is no
 * in-place repair available even in principle.
 *
 * **What this refuses rather than resolves.** Two live `user_stated` cards
 * across the members is `two_of_yours`, and it refuses *before* anything is
 * written. Two summaries the owner personally approved are two decisions, and
 * silently keeping one of them is the kind of loss that is discovered months
 * later by somebody wondering where a sentence went. Picking for them is a
 * judgement this module is not entitled to make.
 */

import type { SQL } from 'bun';

import { numericArrayLiteral, textArrayLiteral } from './pg-values.ts';
import type { EntityType } from './links.ts';

export type MergeArm = 'in_place' | 'successor';

export type MergeRefusal =
  /** Two or more live `user_stated` cards across the members. Two decisions. */
  | 'two_of_yours'
  /** Fewer than two live members resolved, so there is nothing to merge. */
  | 'not_enough'
  /** A named member is absent or already tombstoned. */
  | 'member_gone';

export interface MergePlan {
  /** Whose canonical name and canonical slug the result carries. */
  readonly primary: string;
  /** Every member, primary included, sorted by entity id. */
  readonly members: readonly string[];
  /** The sorted union of every member's origins. */
  readonly origins: readonly string[];
  /** The result's type. A retype may ride along by naming a different one. */
  readonly entityType: EntityType;
  readonly arm: MergeArm;
  /** The one card that survives, if any member has one. */
  readonly card: { readonly cardId: string; readonly trustLevel: string } | null;
  /** For the preview: how many live edges will be rewritten. */
  readonly edgeCount: number;
  /** For the preview: spellings more than one member knows. */
  readonly aliasCollisions: readonly string[];
}

interface MemberRow {
  entity_id: string;
  canonical_name: string;
  entity_type: string;
  taxonomy_version: number;
  origin_contexts: string[];
}

/**
 * What a merge would do, reading nothing into it.
 *
 * Read-only, and it reads the **cards first** so that `two_of_yours` is
 * answered before any other work is done or reported. A preview that described
 * a merge it was going to refuse anyway would be worse than no preview.
 */
export async function planMerge(
  sql: SQL,
  input: {
    readonly primary: string;
    readonly members: readonly string[];
    readonly entityType?: EntityType;
  },
): Promise<{ ok: true; plan: MergePlan } | { ok: false; reason: MergeRefusal }> {
  const wanted = [...new Set([input.primary, ...input.members])].sort();
  if (wanted.length < 2) return { ok: false, reason: 'not_enough' };

  const rows = (await sql.unsafe(
    `SELECT entity_id::text AS entity_id, canonical_name, entity_type, taxonomy_version,
            origin_contexts
       FROM entity
      WHERE entity_id = ANY($1::bigint[]) AND deleted_at IS NULL
      ORDER BY entity_id`,
    [numericArrayLiteral(wanted)],
  )) as MemberRow[];
  if (rows.length !== wanted.length) return { ok: false, reason: 'member_gone' };

  const primary = rows.find((row) => row.entity_id === input.primary);
  if (primary === undefined) return { ok: false, reason: 'member_gone' };

  // Cards first, and the refusal before anything else is computed.
  const cards = (await sql.unsafe(
    `SELECT card_id::text AS card_id, entity_id::text AS entity_id, trust_level
       FROM entity_card
      WHERE entity_id = ANY($1::bigint[]) AND deleted_at IS NULL
      ORDER BY entity_id`,
    [numericArrayLiteral(wanted)],
  )) as Array<{ card_id: string; entity_id: string; trust_level: string }>;
  const owned = cards.filter((card) => card.trust_level === 'user_stated');
  if (owned.length > 1) return { ok: false, reason: 'two_of_yours' };

  // The owner's card wins if there is one; otherwise the primary's; otherwise
  // whichever member has one, lowest id first, which is stable across runs.
  const survivor =
    owned[0] ?? cards.find((card) => card.entity_id === primary.entity_id) ?? cards[0] ?? null;

  const origins = [...new Set(rows.flatMap((row) => row.origin_contexts))].sort();
  const arm: MergeArm = origins.every((origin) => primary.origin_contexts.includes(origin))
    ? 'in_place'
    : 'successor';

  const edges = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM entity_edge
      WHERE deleted_at IS NULL
        AND (subject_entity_id = ANY($1::bigint[]) OR object_entity_id = ANY($1::bigint[]))`,
    [numericArrayLiteral(wanted)],
  )) as Array<{ n: number }>;

  const aliases = (await sql.unsafe(
    `SELECT alias FROM entity_alias WHERE entity_id = ANY($1::bigint[])
      GROUP BY alias HAVING count(DISTINCT entity_id) > 1 ORDER BY alias`,
    [numericArrayLiteral(wanted)],
  )) as Array<{ alias: string }>;

  return {
    ok: true,
    plan: {
      primary: primary.entity_id,
      members: rows.map((row) => row.entity_id),
      origins,
      entityType: input.entityType ?? (primary.entity_type as EntityType),
      arm,
      card:
        survivor === null ? null : { cardId: survivor.card_id, trustLevel: survivor.trust_level },
      edgeCount: edges[0]?.n ?? 0,
      aliasCollisions: aliases.map((row) => row.alias),
    },
  };
}

/**
 * Retire every member's live card and re-seat one survivor per destination.
 *
 * **Batched over a mapping rather than called per entity**, and the shape is
 * not a preference: `test/core/write/links.test.ts` asserts that widening a
 * whole set costs a *fixed* number of statements however large the set, and a
 * per-entity call here reintroduces exactly the growth that test was written to
 * forbid. A merge passes many members mapping to one destination; a widen
 * passes many one-to-one pairs. One routine covers both because the question is
 * the same one: which card survives, and what union must it carry.
 *
 * **Retire-then-insert, and the order is forced twice over.**
 * `entity_card_one_live_per_entity` is a partial unique index on `entity_id`
 * where `deleted_at IS NULL`, so a second live card cannot exist alongside the
 * first; and `entity_card.origin_contexts` is immutable by trigger, so the
 * surviving row cannot simply be re-pointed and widened. The re-insert carries
 * the full union, which is what `assert_entity_card_origin_union` demands of a
 * card whose entity now has more origins than the card was written under.
 *
 * **`user_stated` wins the tie**, because the owner approving a summary is a
 * decision and the model writing one is not. `card_id` changes and that is
 * disclosed rather than hidden: nothing in the tree holds one across a
 * transaction, and `undoProposal` keys on `created_at`, which is copied
 * verbatim.
 */
export async function recastCards(
  db: SQL,
  input: {
    /** Every member, mapped to the entity id its card should end up on. */
    readonly moves: ReadonlyMap<string, string>;
    /** Origins each destination will carry, keyed by destination id. */
    readonly originsOf: ReadonlyMap<string, readonly string[]>;
    readonly now: Date;
  },
): Promise<{ readonly seated: number }> {
  const members = [...input.moves.keys()];
  if (members.length === 0) return { seated: 0 };
  const ids = numericArrayLiteral(members);

  const live = (await db.unsafe(
    `SELECT entity_id::text AS entity_id, summary, trust_level, derivation, confidence,
            model_id, run_id::text AS run_id, subject_context, subject_confidence, created_at
       FROM entity_card
      WHERE entity_id = ANY($1::bigint[]) AND deleted_at IS NULL
      ORDER BY (trust_level = 'user_stated') DESC, entity_id`,
    [ids],
  )) as Array<Record<string, unknown>>;
  if (live.length === 0) return { seated: 0 };

  // One survivor per destination. The ORDER BY above puts the owner's card
  // first, so the first row seen for a destination is the one that wins.
  const survivor = new Map<string, Record<string, unknown>>();
  for (const card of live) {
    const onto = input.moves.get(String(card.entity_id));
    if (onto === undefined || survivor.has(onto)) continue;
    survivor.set(onto, card);
  }

  await db.unsafe(
    `UPDATE entity_card SET deleted_at = $2::timestamptz
      WHERE entity_id = ANY($1::bigint[]) AND deleted_at IS NULL`,
    [ids, input.now.toISOString()],
  );

  const rows = [...survivor.entries()];
  if (rows.length === 0) return { seated: 0 };
  await db.unsafe(
    `INSERT INTO entity_card (entity_id, summary, trust_level, derivation, confidence,
                              model_id, run_id, origin_contexts, subject_context,
                              subject_confidence, created_at)
     SELECT u.entity_id::bigint, u.summary, u.trust_level, u.derivation,
            nullif(u.confidence, '')::real, nullif(u.model_id, ''),
            nullif(u.run_id, '')::bigint, u.origins::text[],
            nullif(u.subject_context, ''), nullif(u.subject_confidence, '')::real,
            u.created_at::timestamptz
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                   $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
            AS u(entity_id, summary, trust_level, derivation, confidence, model_id, run_id,
                 origins, subject_context, subject_confidence, created_at)`,
    [
      textArrayLiteral(rows.map(([onto]) => onto)),
      textArrayLiteral(rows.map(([, card]) => String(card.summary))),
      textArrayLiteral(rows.map(([, card]) => String(card.trust_level))),
      textArrayLiteral(rows.map(([, card]) => String(card.derivation))),
      textArrayLiteral(rows.map(([, card]) => (card.confidence == null ? '' : String(card.confidence)))),
      textArrayLiteral(rows.map(([, card]) => (card.model_id == null ? '' : String(card.model_id)))),
      textArrayLiteral(rows.map(([, card]) => (card.run_id == null ? '' : String(card.run_id)))),
      textArrayLiteral(rows.map(([onto]) => textArrayLiteral([...(input.originsOf.get(onto) ?? [])]))),
      textArrayLiteral(rows.map(([, card]) => (card.subject_context == null ? '' : String(card.subject_context)))),
      textArrayLiteral(rows.map(([, card]) => (card.subject_confidence == null ? '' : String(card.subject_confidence)))),
      textArrayLiteral(
        rows.map(([, card]) =>
          card.created_at instanceof Date ? card.created_at.toISOString() : String(card.created_at),
        ),
      ),
    ],
  );
  return { seated: rows.length };
}

/**
 * Move every live edge touching a member onto its destination, carrying the
 * union its new endpoints demand.
 *
 * `moves` may be an identity mapping — that is what a pure widen and the
 * in-place arm both pass — and the work is still real, because the *origins* of
 * an endpoint have changed even when its id has not.
 *
 * **Eleven columns minus two.** `edge_id` is generated and `deleted_at` is the
 * tombstone; every other column is copied, and three of them were being dropped
 * before this routine existed. `derivation` is the one that mattered: an edge
 * re-born at its `DEFAULT 'rule_derived'` becomes a candidate for
 * `reconcileAllEdges`' removal predicate, which is exactly
 * `derivation = 'rule_derived'` — so the first connector- or model-derived edge
 * to meet a widen was deleted on the next cycle, in a table `restoreForgotten`
 * deliberately refuses to walk.
 */
export async function recastEdges(
  db: SQL,
  input: {
    readonly moves: ReadonlyMap<string, string>;
    readonly originsOf: ReadonlyMap<string, readonly string[]>;
  },
): Promise<{ readonly rewritten: number; readonly dropped: number }> {
  const touched = [...input.moves.keys()];
  if (touched.length === 0) return { rewritten: 0, dropped: 0 };
  const ids = numericArrayLiteral(touched);

  const live = (await db.unsafe(
    `SELECT edge_id::text AS edge_id, subject_entity_id::text AS subject, edge_type,
            object_entity_id::text AS object, origin_contexts, subject_context,
            subject_confidence, confidence, derivation
       FROM entity_edge
      WHERE deleted_at IS NULL
        AND (subject_entity_id = ANY($1::bigint[]) OR object_entity_id = ANY($1::bigint[]))
      ORDER BY edge_id`,
    [ids],
  )) as Array<{
    edge_id: string;
    subject: string;
    edge_type: string;
    object: string;
    origin_contexts: string[];
    subject_context: string | null;
    subject_confidence: number | null;
    confidence: number | null;
    derivation: string;
  }>;
  if (live.length === 0) return { rewritten: 0, dropped: 0 };

  const destination = (id: string): string => input.moves.get(id) ?? id;
  const wanted = new Map<string, (typeof live)[number] & { origins: string[] }>();
  let dropped = 0;
  for (const edge of live) {
    const subject = destination(edge.subject);
    const object = destination(edge.object);
    // Two members of one merge that pointed at each other become a self-loop,
    // which the schema refuses. Dropping it is the correct answer: an entity
    // does not have a relationship with itself.
    if (subject === object) {
      dropped += 1;
      continue;
    }
    const origins = [
      ...new Set([
        ...edge.origin_contexts,
        ...(input.originsOf.get(subject) ?? []),
        ...(input.originsOf.get(object) ?? []),
      ]),
    ].sort();
    const key = `${subject}|${edge.edge_type}|${object}`;
    const seen = wanted.get(key);
    if (seen === undefined) {
      wanted.set(key, { ...edge, subject, object, origins });
      continue;
    }
    // Two edges collapsing onto one pair keep the wider union and the higher
    // confidence, so a merge never narrows what an edge was attested by.
    seen.origins = [...new Set([...seen.origins, ...origins])].sort();
    seen.confidence = Math.max(seen.confidence ?? 0, edge.confidence ?? 0) || null;
    dropped += 1;
  }

  await db.unsafe(
    `UPDATE entity_edge SET deleted_at = now()
      WHERE deleted_at IS NULL
        AND (subject_entity_id = ANY($1::bigint[]) OR object_entity_id = ANY($1::bigint[]))`,
    [ids],
  );

  const rows = [...wanted.values()];
  if (rows.length > 0) {
    await db.unsafe(
      `INSERT INTO entity_edge (subject_entity_id, edge_type, object_entity_id, origin_contexts,
                                subject_context, subject_confidence, confidence, derivation)
       -- nullif on every nullable column: unnest of a text[] cannot carry a
       -- NULL through textArrayLiteral, so absence travels as the empty string
       -- and is turned back here. Without it ''::real raises, and a widen would
       -- take the whole ingest transaction with it.
       SELECT u.subject::bigint, u.edge_type, u.object::bigint, u.origins::text[],
              nullif(u.subject_context, ''), nullif(u.subject_confidence, '')::real,
              nullif(u.confidence, '')::real, u.derivation
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
                     $7::text[], $8::text[])
              AS u(subject, edge_type, object, origins, subject_context, subject_confidence,
                   confidence, derivation)`,
      [
        textArrayLiteral(rows.map((row) => row.subject)),
        textArrayLiteral(rows.map((row) => row.edge_type)),
        textArrayLiteral(rows.map((row) => row.object)),
        textArrayLiteral(rows.map((row) => textArrayLiteral(row.origins))),
        textArrayLiteral(rows.map((row) => row.subject_context ?? '')),
        textArrayLiteral(rows.map((row) => String(row.subject_confidence ?? ''))),
        textArrayLiteral(rows.map((row) => String(row.confidence ?? ''))),
        textArrayLiteral(rows.map((row) => row.derivation)),
      ],
    );
  }
  return { rewritten: rows.length, dropped };
}

/**
 * Make the members one entity, inside the caller's transaction.
 *
 * **Irreversible, and the design says so out loud rather than hedging.** Three
 * of the steps below are one-way at the database level: the absorbed rows'
 * aliases are hard-DELETEd (the unique key is total, so they cannot coexist),
 * their canonical slugs are overwritten to redirects, and their edges are
 * retired in a table `restoreForgotten` deliberately refuses to walk. There is
 * no undo, so the protection is a preview read beforehand — see
 * `src/ops/merge.ts`.
 *
 * Statement order is not arbitrary:
 *
 *  1. `FOR UPDATE` every member before any write, so a concurrent widen cannot
 *     tombstone one out from under the merge.
 *  2. The surviving row: unchanged on the in-place arm, minted on the successor
 *     arm carrying every column.
 *  3. Cards, then slugs, then aliases — aliases last of the three because their
 *     delete-then-insert is the step with no undo, and everything that could
 *     still refuse has refused by then.
 *  4. Edges through {@link recastEdges}, which is where BZ002 is satisfied.
 *  5. The departing rows leave, with `AND deleted_at IS NULL` so a concurrent
 *     cascade's instant is never silently overwritten — neither existing
 *     tombstone path carries that predicate.
 */
export async function mergeEntities(
  db: SQL,
  plan: MergePlan,
  now: Date,
): Promise<{ readonly entityId: string; readonly tombstoned: readonly string[] }> {
  const members = numericArrayLiteral([...plan.members]);

  // 1. Lock every member first. A rowcount short of the plan means something
  // moved between planning and applying, and continuing would merge a subset.
  const locked = (await db.unsafe(
    `SELECT entity_id::text AS entity_id, canonical_name, entity_type, taxonomy_version,
            origin_contexts
       FROM entity
      WHERE entity_id = ANY($1::bigint[]) AND deleted_at IS NULL
      ORDER BY entity_id
        FOR UPDATE`,
    [members],
  )) as MemberRow[];
  if (locked.length !== plan.members.length) {
    throw new Error('a member of this merge is gone; re-run the preview');
  }

  const primary = locked.find((row) => row.entity_id === plan.primary);
  if (primary === undefined) throw new Error('the primary of this merge is gone');

  // 2. The surviving row.
  let survivor = plan.primary;
  if (plan.arm === 'successor') {
    // `origin_contexts` is immutable by trigger (BZ001), and its hint names the
    // only remedy: a row whose origin would change is a different row.
    const born = (await db.unsafe(
      `INSERT INTO entity (canonical_name, entity_type, taxonomy_version, origin_contexts,
                           subject_context, subject_confidence, enrich_considered_version)
       SELECT $2, $3, e.taxonomy_version, $4::text[], e.subject_context, e.subject_confidence,
              e.enrich_considered_version
         FROM entity e WHERE e.entity_id = $1::bigint
       RETURNING entity_id::text AS entity_id`,
      [plan.primary, primary.canonical_name, plan.entityType, textArrayLiteral([...plan.origins])],
    )) as Array<{ entity_id: string }>;
    survivor = born[0]?.entity_id ?? '';
    if (survivor === '') throw new Error('the successor was not created');
  } else if (plan.entityType !== primary.entity_type) {
    // A retype riding along on an in-place merge. Legal: `entity_type` has no
    // trigger, and the caller has already been through the same collision
    // pre-flight `src/ops/retype.ts` runs.
    await db.unsafe(
      `UPDATE entity SET entity_type = $2, enrich_considered_version = NULL
        WHERE entity_id = $1::bigint`,
      [survivor, plan.entityType],
    );
  }

  // 3. The card follows, carrying the union.
  await recastCards(db, {
    moves: new Map(plan.members.map((member) => [member, survivor] as const)),
    originsOf: new Map([[survivor, plan.origins]]),
    now,
  });

  // 4. Slugs. The survivor's canonical slug stays canonical; every other
  // member's becomes a redirect, so an address somebody already holds keeps
  // resolving rather than 404ing.
  await db.unsafe(
    `UPDATE entity_slug SET entity_id = $2::bigint, kind = 'redirect'
      WHERE entity_id = ANY($1::bigint[]) AND entity_id <> $2::bigint`,
    [members, survivor],
  );

  // 5. Aliases. `entity_alias`'s unique key is (entity_id, alias) and is TOTAL
  // -- there is no partial-on-live form -- so a spelling two members both know
  // cannot be inserted twice. Read, resolve in memory, delete, re-insert.
  const aliases = (await db.unsafe(
    `SELECT alias, alias_source, confidence, origin_contexts
       FROM entity_alias WHERE entity_id = ANY($1::bigint[]) ORDER BY alias`,
    [members],
  )) as Array<{
    alias: string;
    alias_source: string;
    confidence: number | null;
    origin_contexts: string[];
  }>;
  const resolved = new Map<string, (typeof aliases)[number]>();
  for (const row of aliases) {
    const seen = resolved.get(row.alias);
    if (seen === undefined) {
      resolved.set(row.alias, { ...row });
      continue;
    }
    // A spelling both members knew keeps the wider provenance and the higher
    // score. Narrowing either would make a merge lose recall.
    seen.origin_contexts = [...new Set([...seen.origin_contexts, ...row.origin_contexts])].sort();
    seen.confidence = Math.max(seen.confidence ?? 0, row.confidence ?? 0) || null;
  }
  await db.unsafe(`DELETE FROM entity_alias WHERE entity_id = ANY($1::bigint[])`, [members]);
  const rows = [...resolved.values()];
  if (rows.length > 0) {
    await db.unsafe(
      `INSERT INTO entity_alias (entity_id, alias, alias_source, confidence, origin_contexts)
       SELECT $1::bigint, u.alias, u.alias_source, nullif(u.confidence, '')::real, u.origins::text[]
         FROM unnest($2::text[], $3::text[], $4::text[], $5::text[])
              AS u(alias, alias_source, confidence, origins)`,
      [
        survivor,
        textArrayLiteral(rows.map((row) => row.alias)),
        textArrayLiteral(rows.map((row) => row.alias_source)),
        textArrayLiteral(rows.map((row) => (row.confidence == null ? '' : String(row.confidence)))),
        textArrayLiteral(rows.map((row) => textArrayLiteral(row.origin_contexts))),
      ],
    );
  }

  // 6. Severance history follows the survivor, or a severed spelling would be
  // stranded on a tombstone and stop suppressing what it was written to suppress.
  await db.unsafe(
    `UPDATE severed_alias SET entity_id = $2::bigint WHERE entity_id = ANY($1::bigint[])`,
    [members, survivor],
  );

  // 7. Edges, where the origin union is actually satisfied.
  await recastEdges(db, {
    moves: new Map(plan.members.map((member) => [member, survivor] as const)),
    originsOf: new Map([[survivor, plan.origins]]),
  });

  // 8. The dictionary bindings and the owner's self-pointer, for the reason
  // `widenEntityOrigins` re-points them: neither carries a foreign key, and a
  // pointer left aimed at a tombstoned member reads as a user retraction in one
  // case and as "never stated" in the other. A merge would silently un-promote
  // a person, or un-say which entity the owner is.
  await db.unsafe(
    `UPDATE correspondent SET entity_id = $2::bigint WHERE entity_id = ANY($1::bigint[])`,
    [members, survivor],
  );
  await db.unsafe(
    `UPDATE tenant_setting SET self_entity_id = $2::bigint WHERE self_entity_id = ANY($1::bigint[])`,
    [members, survivor],
  );

  // 9. Any proposal still waiting on a member now names the survivor.
  await db.unsafe(
    `UPDATE review_queue SET target_ref = 'entity:' || $2::text
      WHERE state = 'open' AND target_ref = ANY($1::text[])`,
    [
      textArrayLiteral(plan.members.filter((m) => m !== survivor).map((m) => `entity:${m}`)),
      survivor,
    ],
  );

  // 10. The departing rows leave. `AND deleted_at IS NULL` because neither
  // existing tombstone path carries it, and both would silently overwrite a
  // concurrent cascade's instant.
  const departing = plan.members.filter((member) => member !== survivor);
  if (departing.length > 0) {
    await db.unsafe(
      `UPDATE entity SET deleted_at = $2::timestamptz
        WHERE entity_id = ANY($1::bigint[]) AND deleted_at IS NULL`,
      [numericArrayLiteral(departing), now.toISOString()],
    );
  }
  return { entityId: survivor, tombstoned: departing };
}
