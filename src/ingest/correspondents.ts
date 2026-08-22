/**
 * Who a message was between, as the provider stated it.
 *
 * **The part of every mail this fleet already fetches and throws away.**
 * `toItem` in the Gmail adapter builds a full header map on every message,
 * hands `from`, `subject` and `labels` to the junk gate, and then keeps only
 * `externalRef`, `title`, `body` and `occurredAt`. Every `From`, `To` and `Cc`
 * is fetched at no extra cost and dropped on the floor. Calendar is worse in an
 * interesting way: it has structured `attendees[].email` and flattens them into
 * body prose for a regex to re-parse downstream.
 *
 * **One shape for three producers, because a second identity convention is how
 * two halves of a system come to disagree about what one person is.** Gmail
 * states it in a header, Calendar in `attendees[]`, and the People API in
 * `emailAddresses[]` — and every one of them is *somebody, spelled by a machine
 * that was told who they are*.
 *
 * **What this is emphatically not: a second roster.** Measured on the brain it
 * was built against, of 2,131 distinct addresses in the owner's address book,
 * **thirteen** appear anywhere in a 10,036-page corpus. So the dictionary
 * answers *what is this person called* and never *does this person exist*; the
 * corpus answers the second. Nothing here creates an entity, and the address
 * book structurally cannot: a book entry is a STATEMENT and a header is a
 * SIGHTING, the book carries no page, and `correspondent_sighting.role` has no
 * `'book'` value for it to use.
 */

import type { SQL } from 'bun';

import { erasedSubjects } from '../core/lifecycle/subject-erasure.ts';
import { normalize } from '../core/write/normalize.ts';
import { textArrayLiteral } from '../core/write/pg-values.ts';

/**
 * A bare address anywhere in a surface.
 *
 * Deliberately permissive on the local part and strict about the domain having
 * at least one dot-separated label after it, so `alice@example.test.` at the end
 * of a sentence yields the address and not the full stop. This is not a
 * validator — a string that is not really an address costs one lookup that
 * misses.
 */
export const ADDRESS = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * `Alice Example <alice@example.test>` and `"Example, Alice" <alice@…>`.
 *
 * The display name is only taken when it is *attached to an address*, which is
 * what keeps this from degenerating into "hash every phrase in the body". A name
 * standing alone in prose has no address to anchor it.
 */
export const NAMED_ADDRESS =
  /(?:"([^"\r\n]{1,200})"|([^<>,;:"\r\n]{1,200}?))\s*<\s*([A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\s*>/g;

/** Shorter than this is not a name anybody was erased under. */
export const MIN_NAME_CHARACTERS = 2;

/** Which slot stated it. Carried for the sighting; never part of identity. */
export type CorrespondentRole = 'from' | 'to' | 'cc' | 'attendee' | 'organizer' | 'book';

export interface Correspondent {
  /** The addr-spec exactly as the provider spelled it. */
  readonly address: string;
  /** The display name attached to it, or null. Never invented. */
  readonly name: string | null;
  readonly role: CorrespondentRole;
}

/**
 * The dictionary key, and it is `normalize` and nothing else.
 *
 * Not a second convention: `subjectDigest` hashes `normalize(identifier)`, so
 * `sha256(addressKey(a))` IS the erasure tombstone's key by construction. That
 * identity is what lets the erasure consult below be a comparison rather than a
 * second spelling of "what one identifier is".
 *
 * **No provider-specific folding.** Gmail treats `a.b@gmail.com` and
 * `ab@gmail.com` as one mailbox; almost nobody else does. Folding dots or `+`
 * tags would silently merge two different people at every non-Google domain,
 * and a silent merge is unrecoverable.
 */
export function addressKey(address: string): string {
  return normalize(address);
}

/** Structured correspondents from one header value or body surface. */
export function correspondentsIn(surface: string, role: CorrespondentRole): Correspondent[] {
  if (surface.length === 0) return [];
  const found = new Map<string, Correspondent>();

  for (const match of surface.matchAll(NAMED_ADDRESS)) {
    const name = (match[1] ?? match[2] ?? '').trim();
    const address = (match[3] ?? '').trim();
    if (address.length === 0) continue;
    const usable = name.length >= MIN_NAME_CHARACTERS && !name.includes('@') ? name : null;
    found.set(addressKey(address), { address, name: usable, role });
  }
  // Bare addresses second, so a named form already seen keeps its name.
  for (const match of surface.matchAll(ADDRESS)) {
    const address = match[0];
    const key = addressKey(address);
    if (found.has(key)) continue;
    found.set(key, { address, name: null, role });
  }
  return [...found.values()];
}

export interface CorrespondentSighting {
  /** The page the write path just returned. Mail and calendar have one. */
  readonly pageId: string;
  readonly correspondents: readonly Correspondent[];
}

export interface CorrespondentObservation {
  /** Distinct keys upserted. */
  readonly addresses: number;
  /** Rows that took a display name. */
  readonly named: number;
  /** Sighting rows inserted, conflicts excluded. */
  readonly sightings: number;
  /** Dropped whole by the erasure tombstone. */
  readonly suppressed: number;
  /** Names nulled as encoded-word or address-shaped. The address still lands. */
  readonly refusedNames: number;
  /**
   * Keys that are not addresses at all, dropped whole.
   *
   * A real address book holds a phone number in an email field. Counted rather
   * than silent, because the number going up is how an operator learns the
   * provider is offering something this table cannot hold.
   */
  readonly refusedAddresses: number;
  /** Items whose addressed roles were dropped by the recipient cap. */
  readonly droppedByRecipientCap: number;
}

/**
 * Addressed recipients above which an item states no correspondents at all.
 *
 * **Drop them all rather than truncating**, and the reasoning is the part to
 * keep: a 200-recipient blast contains no correspondents, so taking an
 * arbitrary 25 of them is a silently arbitrary answer. `from` and `organizer`
 * are always kept — a blast still has a sender.
 *
 * Disclosed simplification: the owner's own address is dropped from such an
 * item too. Harmless, because it appears in the addressed slot of essentially
 * every other message they hold, and it avoids inventing an "owner address"
 * concept this tree does not have.
 */
export const MAX_RECIPIENTS = 25;

/** Rows per upsert. Bounded so one pathological listing binds a bounded array. */
const UPSERT_BATCH = 500;

/** A display name that is machine noise rather than a person. */
const ENCODED_WORD = /=\?[^?]+\?[BbQq]\?[^?]*\?=/;

/**
 * `correspondent_key_is_an_address`, restated so a bad key is refused BEFORE
 * the write rather than at the last statement of a batch.
 *
 * **One malformed entry used to kill the whole book.** A real address book
 * holds things that are not addresses: measured on the founder's, a phone
 * number typed into an email field and a 46-character string with no `@` at
 * all. The insert is batched, so both raised, the whole 2,131-row upsert rolled
 * back, and the contacts lane reported `provider_error` on every poll —
 * permanently, because the provider will keep offering the same two rows.
 *
 * Stated twice, here and in the DDL, which is a real hazard: a widening in one
 * and not the other is either a refused write or a row this filter admits and
 * the database rejects. It is worth it because the alternative is a batch whose
 * failure mode is all-or-nothing on data the provider legitimately holds.
 */
const ADDRESS_KEY = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

interface Folded {
  address: string;
  name: string | null;
  nameKey: string | null;
  source: 'headers' | 'book' | null;
  roles: Set<CorrespondentRole>;
  pageIds: Set<string>;
}

/**
 * Record what the providers stated. The ONLY writer of `correspondent`.
 *
 * **The erasure consult lives here, not in the callers.** The contacts lane
 * never passes `partitionErasedSubjects` — it has no items to partition — so a
 * caller-side filter would let the daily address-book walk re-insert an erased
 * person's name and address within a day of the receipt saying this brain holds
 * nothing about her. One sink, one enforcement point.
 *
 * **It consults BOTH halves, address and display name.** A data-subject request
 * usually names a person rather than an address, and a name-keyed erasure writes
 * a digest of the NAME; without the second arm the row the erasure deleted comes
 * back on tomorrow's walk.
 *
 * Fails CLOSED by throwing, exactly as `partitionErasedSubjects` does: if the
 * tombstone table cannot be read, the honest outcome is a failed run that
 * retries, not a poll that quietly re-learns the person it was told to forget.
 */
export async function observeCorrespondents(
  sql: SQL,
  request: {
    readonly originContext: string;
    readonly at: Date;
    /** Correspondents with a page behind them. Gmail, Calendar. */
    readonly sightings?: readonly CorrespondentSighting[];
    /** Correspondents with no page behind them. The address book. */
    readonly stated?: readonly Correspondent[];
  },
): Promise<CorrespondentObservation> {
  const folded = new Map<string, Folded>();
  let refusedNames = 0;
  let refusedAddresses = 0;
  let droppedByRecipientCap = 0;

  const ADDRESSED: ReadonlySet<CorrespondentRole> = new Set(['to', 'cc', 'attendee']);

  const fold = (who: Correspondent, source: 'headers' | 'book', pageId?: string): void => {
    const key = addressKey(who.address);
    if (key.length === 0) return;
    // Refused here rather than by the CHECK, because the write is batched and a
    // constraint violation takes every other row in the batch with it.
    if (!ADDRESS_KEY.test(key)) {
      refusedAddresses += 1;
      return;
    }
    let name = who.name;
    // An encoded-word or address-shaped display name is machine noise, not a
    // person. The ADDRESS is still recorded — it is the useful half — and only
    // the name is refused.
    if (name !== null && (ENCODED_WORD.test(name) || name.includes('@'))) {
      name = null;
      refusedNames += 1;
    }
    const seen = folded.get(key) ?? {
      address: who.address,
      name: null,
      nameKey: null,
      source: null,
      roles: new Set<CorrespondentRole>(),
      pageIds: new Set<string>(),
    };
    // First non-null name wins within an origin. The two feeds write different
    // `origin_context` values, so a book-vs-headers tie is never the same row
    // and is not arbitrated here.
    if (seen.name === null && name !== null) {
      seen.name = name;
      // **The only place in the system that computes this**, which is what keeps
      // the erasure's name arm exact: it compares a stored key against this same
      // function's output rather than against `lower()` in SQL.
      seen.nameKey = normalize(name);
      seen.source = source;
    }
    seen.roles.add(who.role);
    if (pageId !== undefined) seen.pageIds.add(pageId);
    folded.set(key, seen);
  };

  for (const sighting of request.sightings ?? []) {
    const addressed = sighting.correspondents.filter((who) => ADDRESSED.has(who.role));
    const keep =
      addressed.length > MAX_RECIPIENTS
        ? sighting.correspondents.filter((who) => !ADDRESSED.has(who.role))
        : sighting.correspondents;
    if (addressed.length > MAX_RECIPIENTS) droppedByRecipientCap += 1;
    for (const who of keep) fold(who, 'headers', sighting.pageId);
  }
  for (const who of request.stated ?? []) fold(who, 'book');

  if (folded.size === 0) {
    return {
      addresses: 0,
      named: 0,
      sightings: 0,
      suppressed: 0,
      refusedNames,
      refusedAddresses,
      droppedByRecipientCap,
    };
  }

  // Both halves, in one batched consult.
  const asked = [...folded.values()].flatMap((row) =>
    row.name === null ? [row.address] : [row.address, row.name],
  );
  const erased = await erasedSubjects(sql, asked);
  let suppressed = 0;
  for (const [key, row] of [...folded]) {
    if (erased.has(row.address) || (row.name !== null && erased.has(row.name))) {
      folded.delete(key);
      suppressed += 1;
    }
  }
  if (folded.size === 0) {
    return {
      addresses: 0,
      named: 0,
      sightings: 0,
      suppressed,
      refusedNames,
      refusedAddresses,
      droppedByRecipientCap,
    };
  }

  const rows = [...folded];
  const idOf = new Map<string, string>();
  for (let at = 0; at < rows.length; at += UPSERT_BATCH) {
    const slice = rows.slice(at, at + UPSERT_BATCH);
    const written = (await sql.unsafe(
      `INSERT INTO correspondent (address_key, origin_context, display_name, name_key,
                                  name_source, first_seen_at, last_seen_at)
       SELECT u.key, $2, nullif(u.name, ''), nullif(u.name_key, ''), nullif(u.source, ''),
              $3::timestamptz, $3::timestamptz
         FROM unnest($1::text[], $4::text[], $5::text[], $6::text[])
                AS u(key, name, source, name_key)
       ON CONFLICT (address_key, origin_context) DO UPDATE
          SET last_seen_at = EXCLUDED.last_seen_at,
              -- A name once stated is kept: a later bare To: header must not
              -- erase the spelling an earlier From: gave. The three move in
              -- lockstep, which the paired CHECKs enforce.
              display_name = coalesce(correspondent.display_name, EXCLUDED.display_name),
              name_key     = coalesce(correspondent.name_key,     EXCLUDED.name_key),
              name_source  = coalesce(correspondent.name_source,  EXCLUDED.name_source)
       RETURNING correspondent_id::text AS correspondent_id, address_key`,
      [
        textArrayLiteral(slice.map(([key]) => key)),
        request.originContext,
        request.at.toISOString(),
        textArrayLiteral(slice.map(([, row]) => row.name ?? '')),
        textArrayLiteral(slice.map(([, row]) => row.source ?? '')),
        textArrayLiteral(slice.map(([, row]) => row.nameKey ?? '')),
      ],
    )) as Array<{ correspondent_id: string; address_key: string }>;
    for (const row of written) idOf.set(row.address_key, row.correspondent_id);
  }

  const pending: Array<{ id: string; pageId: string; role: CorrespondentRole }> = [];
  for (const [key, row] of rows) {
    const id = idOf.get(key);
    if (id === undefined) continue;
    for (const pageId of row.pageIds) {
      for (const role of row.roles) {
        // `book` carries no page, so it can never reach here — and the CHECK
        // refuses it anyway, which is the structural half of the design.
        if (role === 'book') continue;
        pending.push({ id, pageId, role });
      }
    }
  }

  let sightings = 0;
  for (let at = 0; at < pending.length; at += UPSERT_BATCH) {
    const slice = pending.slice(at, at + UPSERT_BATCH);
    const written = (await sql.unsafe(
      `INSERT INTO correspondent_sighting (correspondent_id, page_id, role)
       SELECT u.id::bigint, u.page::bigint, u.role
         FROM unnest($1::text[], $2::text[], $3::text[]) AS u(id, page, role)
       ON CONFLICT (correspondent_id, page_id, role) DO NOTHING
       RETURNING page_id`,
      [
        textArrayLiteral(slice.map((row) => row.id)),
        textArrayLiteral(slice.map((row) => row.pageId)),
        textArrayLiteral(slice.map((row) => row.role)),
      ],
    )) as Array<unknown>;
    sightings += written.length;
  }

  return {
    addresses: rows.length,
    named: rows.filter(([, row]) => row.name !== null).length,
    sightings,
    suppressed,
    refusedNames,
    refusedAddresses,
    droppedByRecipientCap,
  };
}
