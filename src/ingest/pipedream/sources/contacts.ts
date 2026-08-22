/**
 * Google Contacts, and the adapter that deliberately ingests nothing.
 *
 * **The measurement this file exists because of.** The founder's address book
 * holds 2,525 contacts and 2,131 distinct email addresses. Of those addresses,
 * **thirteen** appear anywhere in the brain's corpus. The address book and the
 * correspondence graph are, as datasets, very nearly disjoint — an address book
 * is a decade of accumulated cruft (`Humin Activation` names an app that shut
 * down around 2016), while the people somebody actually deals with live in mail
 * headers this fleet already fetches.
 *
 * So this lane writes **no pages and no entities**. A connector that turned
 * 2,525 contacts into pages would bury a 10,036-page corpus under a book that
 * barely intersects it; one that turned them into entities would take a
 * 56-entity roster to roughly 2,500, where 99.5% of the rows are attested by
 * nothing and connect to nothing. That is the failure the admission fence
 * (`src/core/write/entity-admission.ts`) was built to stop, at fifty times the
 * scale, and it would be self-inflicted.
 *
 * What contacts are *for* is the opposite question. Not *does this person
 * exist* — the corpus answers that — but *given an address this brain has
 * independently seen, what is this person called*. That is a dictionary, it is
 * consulted rather than ingested, and it is a separate commit; this file is the
 * connector plumbing that lane needs, shipped first because it is what makes
 * the tile appear, connect, disconnect, pause and report health like every
 * other source.
 *
 * **Three vendor facts, measured against the live project on 2026-08-21 with
 * the founder's connected account rather than reasoned about — the discipline
 * `client.ts`'s header sets after assuming a proxy shape cost this repo twice:**
 *
 *   1. The host is `people.googleapis.com`. The same path under
 *      `www.googleapis.com` answers **400** — the opposite way round from
 *      Calendar, which answers 200 on `www.` and 404 on its own host.
 *   2. `nextSyncToken` is returned **only on the last page**. A 2,525-contact
 *      book is three pages at `pageSize=1000`, and page one — which carries a
 *      `nextPageToken` — carries no sync token at all. An adapter that read the
 *      token from the first response would get `undefined`, silently fall back
 *      to a full re-walk every single day, and never once error.
 *   3. An invalid sync token answers **400**, and *only the status was
 *      measured* — the body was empty. Google's documented shape for this is a
 *      410 with `EXPIRED_SYNC_TOKEN`, which is not what this proxy returned.
 *
 * **(3) is why there is no sync token here.** Classifying an unmeasured 400
 * body is exactly the guess this module's neighbours were burned by, and the
 * token buys nothing anyway: obtaining one requires walking every page, which
 * is the entire cost of the poll. So the walk is tokenless and daily, and the
 * cursor it returns is **synthetic** — see {@link syntheticCursor}.
 */

import type { Correspondent } from '../../correspondents.ts';
import type { ProviderApi } from '../client.ts';
import {
  asArray,
  asRecord,
  asString,
  type ProviderListOutcome,
  type ProviderListRequest,
  type ProviderSource,
  type PulledFailure,
} from './types.ts';

const APP = 'google_contacts' as const;

/**
 * The vendor's ceiling for `people.connections.list`, and what the whole book
 * is walked at. Measured: 2,525 contacts came back as three pages.
 */
const PAGE_SIZE = 1000;

/**
 * Pages one poll will walk before giving up on reaching the end of the book.
 *
 * A ceiling rather than a `while (pageToken)` loop, because an unbounded walk
 * against a paginating vendor is the one shape that can turn a daily poll into
 * an unbounded spend. Six is roughly twice the measured book; a book that needs
 * more is a signal, not something to absorb silently.
 */
const MAX_PAGES = 6;

/**
 * The fields a dictionary needs, and no more.
 *
 * `biographies`, `urls`, `addresses` and `birthdays` are deliberately absent:
 * they are the address-book fields that would only matter if contacts became
 * pages, which they do not. Asking for less is also asking Google for less of
 * somebody's personal data than the connection technically permits.
 */
const PERSON_FIELDS = 'names,emailAddresses,organizations,metadata';

export function createContactsSource(api: ProviderApi): ProviderSource {
  return {
    source: 'contacts',
    sourceType: 'contact',

    async list(request: ProviderListRequest): Promise<ProviderListOutcome> {
      let pageToken: string | null = null;
      let walked = 0;
      // **Accumulated now that there is a reader.** At the ceiling of
      // MAX_PAGES x PAGE_SIZE this is six thousand `{address, name, role}`
      // structs — a low six figures of bytes, a fraction of one page body — and
      // the bodies themselves are still dropped per page rather than held.
      const stated: Correspondent[] = [];

      for (; walked < MAX_PAGES; walked += 1) {
        const listed = await api.request({
          app: APP,
          method: 'GET',
          path: '/v1/people/me/connections',
          query: {
            personFields: PERSON_FIELDS,
            pageSize: PAGE_SIZE,
            ...(pageToken === null ? {} : { pageToken }),
          },
          externalUserId: request.externalUserId,
          accountId: request.accountId ?? null,
        });

        // **`itemFailureFor` is deliberately not imported.** It classifies the
        // failure of *one item* inside a listing that succeeded; a listing that
        // failed is not that, and mapping it through the per-item vocabulary is
        // how a rate limit becomes "this contact is broken" and the cursor
        // walks past a page nobody ever read.
        if (!listed.ok) return { ok: false, reason: listed.reason };

        const body = asRecord(listed.value);
        for (const person of contactsIn(body)) stated.push(...correspondentsOf(person));
        pageToken = asString(body?.nextPageToken ?? null);
        if (pageToken === null) break;
      }

      // **A truncated walk is surfaced, not absorbed.** A book needing more than
      // MAX_PAGES is never finished, every day, forever, because a tokenless
      // walk banks no resume cursor. That is a signal.
      //
      // **`retryable: false`, and getting this wrong wedges the lane.** A
      // retryable failure sets `incomplete`, and the cursor is saved only when
      // `incomplete` is undefined — so a retryable row here would withhold the
      // synthetic cursor, `pullModeFor` would read null as `backfill`, and the
      // lane would re-enter the first-import gate every single day: the exact
      // failure `syntheticCursor` exists to prevent, reintroduced by its own
      // safeguard. It is also the honest verdict, since asking again returns
      // the same six pages. `ceilingFailureFor` is deliberately not reused —
      // its `retryable: true` is right for an ITEM ceiling, where holding the
      // cursor re-offers the item, and there is no cursor to hold here.
      const failures: PulledFailure[] =
        walked === MAX_PAGES && pageToken !== null
          ? [{ externalRef: null, reason: 'cancelled', retryable: false }]
          : [];

      return {
        ok: true,
        page: {
          items: [],
          tombstones: [],
          failures,
          // Nothing was left outside a window, because this lane has no window:
          // it walks the whole book every time. Null is the honest answer and
          // not a shrug — `totalPeople` is available and deliberately unused,
          // since reporting "importing 0 of 2,525" would describe an import
          // that is not being attempted.
          outsideWindow: null,
          // Statements, not sightings: the book carries no page, so these can
          // never insert a `correspondent_sighting` and can never satisfy an
          // evidence test. The dictionary supplies a NAME for somebody the
          // corpus already justified, and nothing else.
          correspondents: stated,
          nextCursor: syntheticCursor(request.now),
        },
      };
    },
  };
}

/**
 * A cursor that carries no provider token, because this lane has none.
 *
 * **It cannot be `null`, and that is the whole reason this function exists.**
 * `pullModeFor` reads a null cursor as `backfill`, and so does any cursor whose
 * kind is not `delta`. A lane that returned null every poll would re-enter U8's
 * gate as a first import every single day — re-priced, re-approved, re-gated,
 * forever — for a walk that is the same three pages either way.
 *
 * `SourceCursor.value` is documented as "the provider's own opaque token, never
 * parsed, never joined to a key", and this value is **not** one: it is the
 * instant the walk finished, and it is written down here so the next reader
 * does not try to send it back to Google. Nothing reads it. Its only job is to
 * be present and to say `delta`.
 */
function syntheticCursor(now: Date): { kind: 'delta'; value: string; issuedAt: string } {
  return { kind: 'delta', value: now.toISOString(), issuedAt: now.toISOString() };
}

/**
 * One contact's addresses, as the dictionary keys them.
 *
 * A person with six emails is six rows: the dictionary is keyed by address, and
 * collapsing them would be inventing an identity the provider did not state.
 * A contact with **no** email produces nothing at all — measured, that is 897 of
 * 2,525, and a nameless key is not something this table can hold.
 */
function correspondentsOf(person: Record<string, unknown>): Correspondent[] {
  const name = asString(asRecord(asArray(person.names)[0])?.displayName ?? null);
  const found: Correspondent[] = [];
  for (const entry of asArray(person.emailAddresses)) {
    const address = asString(asRecord(entry)?.value ?? null);
    if (address === null) continue;
    found.push({ address, name, role: 'book' });
  }
  return found;
}

/** Contacts a page of the book states. */
export function contactsIn(body: unknown): ReadonlyArray<Record<string, unknown>> {
  return asArray(asRecord(body)?.connections)
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}
