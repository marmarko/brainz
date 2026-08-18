/**
 * The re-ingestion half of R12's subject erasure: what a poll asks before it
 * writes a page.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * `src/core/lifecycle/subject-erasure.ts` owes U15's §6.3 determination four
 * properties, and the fourth is "tombstoned against re-ingestion". Its own
 * header says how: `eraseSubject` writes an `erased_subject` row and
 * {@link isErasedSubject} "is what a pull path consults before writing a page".
 * No pull path consulted it, and the consequence is not a slow leak. Mail polls
 * every five minutes (`DEFAULT_CADENCE_SECONDS`), the erasure *soft*-deletes her
 * pages, and U4's replacement lookup only ever finds a **live** page — so the
 * next tick re-offers the same message, finds nothing live at that ref, and
 * writes a brand-new page about the correspondent whose receipt says this brain
 * holds nothing about her. Within the hour, with the receipt already handed
 * over.
 *
 * This module is the question. `pull.ts` is the caller.
 *
 * ============================================================================
 * THE TOMBSTONE STORES A DIGEST, AND THAT DECIDES THE SHAPE
 * ============================================================================
 *
 * `erased_subject` holds a sha256 and nothing else — deliberately, because
 * keeping `alice@example.test` in the table whose whole purpose is that we no
 * longer hold anything about her is the failure wearing the fix's clothes. So
 * the suppression **cannot** be "scan this body for erased people": there is no
 * set of erased names to scan for, and there must not be one.
 *
 * What is possible is the other direction: name every correspondent this item
 * *has*, hash each, and ask. That is {@link identifiersIn}, and its reach is the
 * honest bound of the whole property:
 *
 *   * **Covered.** Every address in the correspondent headers (`From`, `To`,
 *     `Cc`, …) and every address in the item's own title and body — which is
 *     what makes it work for Calendar, whose adapter folds the attendee and
 *     organizer addresses into the composed body rather than into a header. Plus
 *     the display names that appear *beside* an address (`Alice Example
 *     <alice@…>`), since an erasure keyed on a name rather than an address is an
 *     ordinary request.
 *   * **Not covered.** A prose mention with no address anywhere. Nothing in the
 *     brain can enumerate erased names, so nothing can match one, and inventing
 *     a plaintext list to compare against would undo the erasure it is meant to
 *     enforce. `test/ingest/pipedream/erased-subject.test.ts` pins this bound as
 *     an observed fact rather than leaving it to be rediscovered.
 *   * **Not reachable from a pull at all.** Objects. No connector offers one:
 *     Drive was the only adapter that ever did and it is metadata-only, so a
 *     pull carries items and tombstones and nothing else. Objects still arrive
 *     through the folder importer (`import/run.ts`), whose only text comes from
 *     U11's transcribe phase, long after this decision.
 *
 * **The suppression is deliberately allowed to be broader than the sweep.** The
 * erasure's own page arm matches title and chunk text; a mail *from* her whose
 * body never spells her name is not a page it would have taken. Suppressing that
 * message's successor anyway is what the instruction says — "hold nothing about
 * this person" — and the asymmetry is stated here rather than discovered by
 * someone comparing two counts.
 *
 * ============================================================================
 * ONE QUESTION PER DISTINCT CORRESPONDENT, PER PULL
 * ============================================================================
 *
 * The identifiers are deduplicated across the **whole listing** before anything
 * is asked, so a hundred messages from one sender cost one lookup rather than a
 * hundred. What is deliberately *not* here is a ceiling on how many distinct
 * identifiers a page may ask about: a cap would be a fail-open control — the one
 * identifier past the limit is the one that gets re-ingested — and the thing
 * being bounded is a primary-key lookup on a table with one row per erasure.
 *
 * There is no in-process cache either. A pull is minutes long and an erasure is
 * a thing a controller does *because it is urgent*; a cache would mean the pull
 * running when the receipt was signed keeps writing her pages until it finishes.
 */

import type { SQL } from 'bun';

import { isErasedSubject } from '../core/lifecycle/subject-erasure.ts';
import type { JunkInput } from './junk.ts';

/**
 * The headers that say who a message is *between*.
 *
 * A fixed list rather than every header the provider returned. Scanning all of
 * them sweeps in `Received`, `DKIM-Signature` and `Message-Id`, which carry
 * addresses of infrastructure rather than of people — and an erasure is about a
 * person. Delivery headers are in because a bcc'd correspondent appears nowhere
 * else.
 */
const CORRESPONDENT_HEADERS = [
  'from',
  'sender',
  'reply-to',
  'to',
  'cc',
  'bcc',
  'delivered-to',
  'x-original-to',
] as const;

/**
 * An address, as it appears in a header or in running text.
 *
 * Deliberately permissive on the local part and strict about the domain having
 * at least one dot-separated label after it, so `alice@example.test.` at the end
 * of a sentence yields the address and not the full stop. This is not a
 * validator — a string that is not really an address costs one primary-key
 * lookup that misses.
 */
const ADDRESS = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

/**
 * `Alice Example <alice@example.test>` and `"Example, Alice" <alice@…>`.
 *
 * The display name is only taken when it is *attached to an address*, which is
 * what keeps this from degenerating into "hash every phrase in the body". A name
 * that stands alone in prose has no address to anchor it and is the bound the
 * header states.
 */
const NAMED_ADDRESS =
  /(?:"([^"\r\n]{1,200})"|([^<>,;:"\r\n]{1,200}?))\s*<\s*([A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)\s*>/g;

/** Shorter than this is not a name anybody was erased under. */
const MIN_NAME_CHARACTERS = 2;

/** What this module needs of an item. Structural, so both runners' shapes fit. */
export interface ErasableItem {
  readonly title?: string | null;
  readonly body: string;
  readonly junk?: JunkInput;
}

function addIdentifier(into: Set<string>, value: string | null | undefined): void {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length === 0) return;
  into.add(trimmed);
}

/**
 * Every correspondent this item names, in a form {@link isErasedSubject} can
 * hash.
 *
 * Both arms run over both surfaces — the correspondent headers and the item's
 * own title and body — because the three adapters disagree about where a
 * participant lives: Gmail puts them in headers, Calendar composes them into the
 * body, and a Drive document has whatever its author typed.
 *
 * Returned de-duplicated in first-seen order. Normalisation is **not** done
 * here: `subjectDigest` normalises through the write path's own normalizer, and
 * a second spelling convention in this file is how the two sides come to
 * disagree about what one identifier is.
 */
export function identifiersIn(item: ErasableItem): string[] {
  const found = new Set<string>();

  const surfaces: string[] = [];
  const headers = item.junk?.headers;
  if (headers !== undefined) {
    for (const [name, value] of Object.entries(headers)) {
      if ((CORRESPONDENT_HEADERS as readonly string[]).includes(name.toLowerCase())) {
        surfaces.push(value);
      }
    }
  }
  // `junk.from` is the same string the `from` header carried for Gmail, and it
  // is the *only* one an adapter that fills the convenience field without the
  // header map provides. Both, de-duplicated by the set.
  addIdentifierSurface(surfaces, item.junk?.from);
  addIdentifierSurface(surfaces, item.title);
  surfaces.push(item.body);

  for (const surface of surfaces) {
    for (const match of surface.matchAll(NAMED_ADDRESS)) {
      const name = (match[1] ?? match[2] ?? '').trim();
      if (name.length >= MIN_NAME_CHARACTERS && !name.includes('@')) addIdentifier(found, name);
    }
    for (const match of surface.matchAll(ADDRESS)) addIdentifier(found, match[0]);
  }

  return [...found];
}

function addIdentifierSurface(into: string[], value: string | null | undefined): void {
  if (typeof value === 'string' && value.length > 0) into.push(value);
}

export interface ErasedSubjectPartition<T> {
  /** Items the pull may go on to price, write and embed. */
  readonly kept: readonly T[];
  /** Items an erasure instruction forbids this brain from holding. */
  readonly suppressed: readonly T[];
  /** Distinct identifiers this listing asked about. For the caller's receipt. */
  readonly identifiersConsulted: number;
}

/**
 * Split a listing into what may be written and what an erasure forbids.
 *
 * **Called before the estimate, not before the write.** An item that will never
 * be written must not price the approval — the same rule the junk gate follows
 * one line above it, and for the same reason: a gate that approves spend for
 * work the runner then declines to do is a gate reporting a number nobody will
 * ever see spent.
 *
 * Fails **closed** by throwing rather than by returning everything as kept: if
 * the tombstone table cannot be read, the honest outcome is a failed run that
 * retries, not a poll that quietly re-ingests the person it was told to forget.
 */
export async function partitionErasedSubjects<T extends { readonly item: ErasableItem }>(
  sql: SQL,
  entries: readonly T[],
): Promise<ErasedSubjectPartition<T>> {
  const perEntry = entries.map((entry) => identifiersIn(entry.item));

  // One question per distinct correspondent in the whole listing, not per item.
  const distinct = new Set<string>();
  for (const identifiers of perEntry) for (const identifier of identifiers) distinct.add(identifier);

  const erased = new Set<string>();
  for (const identifier of distinct) {
    if (await isErasedSubject(sql, identifier)) erased.add(identifier);
  }

  const kept: T[] = [];
  const suppressed: T[] = [];
  entries.forEach((entry, index) => {
    const identifiers = perEntry[index] ?? [];
    if (identifiers.some((identifier) => erased.has(identifier))) suppressed.push(entry);
    else kept.push(entry);
  });

  return { kept, suppressed, identifiersConsulted: distinct.size };
}
