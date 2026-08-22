/**
 * Deciding that a correspondent is a person.
 *
 * **The point of no cheap return.** Everything upstream of this file is a
 * mirror: the dictionary records what a provider stated, and the next poll
 * rebuilds it. This creates entities, which is the one thing in the sequence
 * that costs something to undo.
 *
 * **The corpus decides existence; the dictionary only supplies a name.** Of
 * 2,131 addresses in the address book this was built against, thirteen appear
 * anywhere in a 10,036-page corpus — so a book entry can never create anybody,
 * structurally: it carries no page, so it can never insert a sighting, so it
 * can never clear the evidence floors below. Its only path is step 6, where an
 * entity the corpus already justified is found by name and bound.
 *
 * **It runs inside `link_reconcile` rather than as a phase of its own**, and
 * that is the only place in the cycle that already holds all three things it
 * needs: a whole-corpus evidence door, a settled entity map, and a budget.
 * Anything it creates joins the desired-set loop unchanged, so `CYCLE_PHASES`
 * and rung 20's CHECK are not touched.
 *
 * **The discipline it inherits is not optional.** That phase runs on the bare
 * handle — every statement autocommits individually — and yields only to a lost
 * lease, never to the clock, because an edge missing from a half-built desired
 * set is an edge the diff *deletes*. So this must not bank a partial position,
 * and its cost is set-based: a fixed handful of statements per pass, whatever
 * the candidate count.
 */

import type { SQL } from 'bun';

import { MACHINE_SENDER } from '../../ingest/junk.ts';
import { admitEntityName, type NameEvidence } from '../../core/write/entity-admission.ts';
import { findEntitiesByName, resolveOrCreateEntities } from '../../core/write/links.ts';
import { normalize } from '../../core/write/normalize.ts';
import { numericArrayLiteral, textArrayLiteral } from '../../core/write/pg-values.ts';
import type { AttemptBudget } from './deadline.ts';

export interface PromotionResult {
  /** Address keys examined this pass. */
  readonly considered: number;
  /** Bound to an entity that already resolved. */
  readonly bound: number;
  /** Entities this pass created. */
  readonly created: number;
  readonly refused: number;
  readonly refusedBySignal: Readonly<Record<string, number>>;
}

/**
 * Address keys examined per pass.
 *
 * The first-run clamp, in the shape `tombstone.ts` argues for — *a first run
 * that takes everything is a decision nobody got to make*. A module constant
 * rather than an option, so no caller can widen it, and deliberately the same
 * number as the enrich batch: one promotion pass can never hand the enrichment
 * phase more entities than one of its prompts can summarise.
 */
const PROMOTION_BATCH = 25;

/**
 * Pages naming this address in an ADDRESSED slot — `to`, `cc`, `attendee`.
 *
 * One is enough because an addressed slot is the owner's own client naming
 * somebody: the owner wrote to them, or put them on an invitation. That is a
 * different quality of evidence from appearing in a `From:`, which anybody who
 * can send mail can arrange.
 */
const MIN_ADDRESSED_PAGES = 1;

/** Pages naming this address in any slot, when none of them is an addressed one. */
const MIN_ATTESTING_PAGES = 2;

/** A display name that is machine noise rather than a person. */
const ENCODED_WORD = /=\?[^?]+\?[BbQq]\?[^?]*\?=/;

interface Row {
  correspondent_id: string;
  address_key: string;
  origin_context: string;
  display_name: string | null;
  name_source: string | null;
  entity_id: string | null;
  binding_is_live: boolean;
  retracted: boolean;
  addressed_pages: number;
  attesting_pages: number;
}

/** The local part of an address key, for the name-equals-mailbox veto. */
function localPartOf(addressKey: string): string {
  const at = addressKey.indexOf('@');
  return at < 0 ? addressKey : addressKey.slice(0, at);
}

export async function promoteCorrespondents(
  sql: SQL,
  options: {
    readonly taxonomyVersion: number;
    readonly evidence: NameEvidence;
    readonly budget: AttemptBudget;
  },
): Promise<PromotionResult> {
  const nothing: PromotionResult = {
    considered: 0,
    bound: 0,
    created: 0,
    refused: 0,
    refusedBySignal: {},
  };
  if (options.budget.cancelled() !== null) return nothing;

  const keyRows = (await sql.unsafe(
    `SELECT c.address_key
       FROM correspondent c
      WHERE c.promoted_at IS NULL
        AND c.display_name IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM correspondent r
                         WHERE r.address_key = c.address_key AND r.retracted_at IS NOT NULL)
      GROUP BY c.address_key
      ORDER BY c.address_key
      LIMIT $1`,
    [PROMOTION_BATCH],
  )) as Array<{ address_key: string }>;
  if (keyRows.length === 0) return nothing;
  const keys = keyRows.map((row) => row.address_key);

  // Every row for those keys, regardless of `promoted_at`, so a partly-latched
  // group is seen whole.
  //
  // **The join to `page` on `deleted_at IS NULL` is load-bearing.** A `forget`
  // TOMBSTONES a page; no cascade fires until the purge hard-deletes it 72
  // hours later. Counting `p.page_id` rather than `s.page_id` is what makes
  // "evidence shrinks when a page is forgotten" true rather than aspirational.
  const rows = (await sql.unsafe(
    `SELECT c.correspondent_id::text AS correspondent_id,
            c.address_key, c.origin_context, c.display_name, c.name_source,
            c.entity_id::text AS entity_id,
            (e.entity_id IS NOT NULL) AS binding_is_live,
            (c.retracted_at IS NOT NULL) AS retracted,
            count(DISTINCT p.page_id) FILTER (WHERE s.role <> 'from')::int AS addressed_pages,
            count(DISTINCT p.page_id)::int AS attesting_pages
       FROM correspondent c
       LEFT JOIN entity e ON e.entity_id = c.entity_id AND e.deleted_at IS NULL
       LEFT JOIN correspondent_sighting s ON s.correspondent_id = c.correspondent_id
       LEFT JOIN page p ON p.page_id = s.page_id
                       AND p.deleted_at IS NULL AND p.quarantined_at IS NULL
      WHERE c.address_key = ANY($1::text[])
      GROUP BY c.correspondent_id, e.entity_id`,
    [textArrayLiteral(keys)],
  )) as Row[];

  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(row.address_key, [...(groups.get(row.address_key) ?? []), row]);

  const refusedBySignal: Record<string, number> = {};
  let refused = 0;
  const refuse = (signal: string): void => {
    refused += 1;
    refusedBySignal[signal] = (refusedBySignal[signal] ?? 0) + 1;
  };

  /** Groups that resolved or were created, as (correspondent ids -> entity id). */
  const latch: Array<{ correspondentId: string; entityId: string }> = [];
  let bound = 0;

  interface Candidate {
    readonly key: string;
    readonly name: string;
    readonly rows: readonly Row[];
    readonly origins: readonly string[];
    readonly hasBook: boolean;
    readonly addressed: number;
    readonly attesting: number;
  }
  const candidates: Candidate[] = [];

  for (const [key, group] of groups) {
    // 1. **A dead binding is a retraction, and it is permanent.** The latched
    // row IS the suppression record — `forgetRecord` writes none of its own —
    // re-derived each pass at no cost. Do not "repair" this into a rebind: the
    // one case where a dead binding is not a retraction is a severance, and the
    // severance clears its own so this rule stays true.
    if (group.some((row) => row.retracted)) {
      refuse('retracted');
      continue;
    }
    if (group.some((row) => row.entity_id !== null && !row.binding_is_live)) {
      refuse('retracted');
      continue;
    }

    // 2. Already bound: bring the group's unbound rows onto the same entity.
    const live = group.find((row) => row.entity_id !== null && row.binding_is_live);
    if (live !== undefined) {
      for (const row of group) {
        if (row.entity_id === null) {
          latch.push({ correspondentId: row.correspondent_id, entityId: live.entity_id ?? '' });
        }
      }
      bound += 1;
      continue;
    }

    // 3. The book's spelling outranks a header's: an address-book entry is the
    // owner's own curation, and a `From:` display name is sender-chosen text.
    const named = [...group]
      .filter((row) => row.display_name !== null)
      .sort((left, right) => {
        const rank = (row: Row): number => (row.name_source === 'book' ? 0 : 1);
        return rank(left) - rank(right) || left.correspondent_id.localeCompare(right.correspondent_id);
      })[0];
    if (named === undefined || named.display_name === null) {
      refuse('no_name');
      continue;
    }
    const name = named.display_name;

    // 4. The name gate. Each rule produces its own signal.
    if (ENCODED_WORD.test(name)) {
      // `admitEntityName` cannot catch this: one token, thirty-odd characters,
      // and `normalize` does not split on `?` or `=`.
      refuse('encoded_word');
      continue;
    }
    if (name.includes('@')) {
      refuse('address_shaped');
      continue;
    }
    if (MACHINE_SENDER.test(key)) {
      // Two disclosed false-positive classes: a local part like
      // `marko.notifications@`, and a domain like `alice@team-notifications.example.com`.
      // The second is new as a VETO even though the junk gate already matches
      // the same text, and it is accepted because the alternative — a person
      // minted from a notifications mailbox — is the louder failure.
      refuse('machine_sender');
      continue;
    }
    if (normalize(name) === localPartOf(key)) {
      // `noreply`, `support`, `billing`, `team` — without a role vocabulary
      // nobody has measured.
      refuse('name_is_the_local_part');
      continue;
    }
    const verdict = admitEntityName(name, options.evidence);
    if (verdict.verdict === 'refuse') {
      for (const signal of verdict.signals) refuse(signal);
      continue;
    }

    const origins = [
      ...new Set(group.filter((row) => row.attesting_pages > 0).map((row) => row.origin_context)),
    ].sort();
    const addressed = group.reduce((total, row) => total + row.addressed_pages, 0);
    const attesting = group.reduce((total, row) => total + row.attesting_pages, 0);
    const hasBook = group.some((row) => row.name_source === 'book');

    // 5. **The binding gate, and it must not be relaxed into "has a name".**
    // `findEntitiesByName` has no type predicate and no origin predicate, so one
    // admitted email carrying `From: "Alice Example" <mallory@attacker.test>`
    // would otherwise latch a binding from the real Alice's entity onto the
    // attacker's address — and that binding is an erasure resolution key. The
    // book is the half an attacker cannot write; a header display name alone is
    // attacker-authored text and buys nothing on its own.
    const attested =
      hasBook || addressed >= MIN_ADDRESSED_PAGES || attesting >= MIN_ATTESTING_PAGES;
    if (!attested) {
      refuse('unattested');
      continue;
    }
    candidates.push({ key, name, rows: group, origins, hasBook, addressed, attesting });
  }

  // 6. **Resolve first, and stop if it resolves.** This is the dictionary's
  // whole job, and it is the only path a book-only group can ever take.
  let created = 0;
  if (candidates.length > 0) {
    const resolved = await findEntitiesByName(
      sql,
      candidates.map((candidate) => candidate.name),
    );
    const unresolved: Candidate[] = [];
    for (const candidate of candidates) {
      const hit = resolved.get(normalize(candidate.name));
      if (hit === undefined) {
        unresolved.push(candidate);
        continue;
      }
      for (const row of candidate.rows) {
        latch.push({ correspondentId: row.correspondent_id, entityId: hit.entityId });
      }
      bound += 1;
    }

    // 7. Only then, independent evidence. A book-only group has no sightings and
    // therefore no origins, so it can never reach here — which is the whole
    // measurement made structural.
    const creatable = unresolved.filter(
      (candidate) =>
        candidate.origins.length > 0 &&
        (candidate.addressed >= MIN_ADDRESSED_PAGES ||
          candidate.attesting >= MIN_ATTESTING_PAGES),
    );
    for (const candidate of unresolved) {
      if (!creatable.includes(candidate)) {
        // Left alone: not latched, not retracted. The unknown reads closed, and
        // a later cycle re-decides when a second page arrives.
        refuse('too_little_evidence');
      }
    }

    if (creatable.length > 0) {
      const { entities } = await resolveOrCreateEntities(
        sql,
        creatable.map((candidate) => ({
          name: candidate.name,
          type: 'person' as const,
          // The origins that contributed a SIGHTING, and only those: a book
          // entry states a name, not a place the person was seen.
          origins: candidate.origins,
          taxonomyVersion: options.taxonomyVersion,
        })),
        { evidence: options.evidence },
      );
      for (const candidate of creatable) {
        const born = entities.get(normalize(candidate.name));
        if (born === undefined) continue;
        for (const row of candidate.rows) {
          latch.push({ correspondentId: row.correspondent_id, entityId: born.entityId });
        }
        created += 1;
      }
    }
  }

  // 8. Bind and latch, one statement for the pass.
  if (latch.length > 0) {
    await sql.unsafe(
      `UPDATE correspondent c
          SET entity_id = m.entity_id, promoted_at = now()
         FROM unnest($1::bigint[], $2::bigint[]) AS m(correspondent_id, entity_id)
        WHERE c.correspondent_id = m.correspondent_id`,
      [
        numericArrayLiteral(latch.map((row) => row.correspondentId)),
        numericArrayLiteral(latch.map((row) => row.entityId)),
      ],
    );
  }

  return { considered: keys.length, bound, created, refused, refusedBySignal };
}
