/**
 * Google Calendar, thin.
 *
 * This is the source that makes the tombstone case concrete: **a cancelled
 * event is not an absence, it is an item with `status: "cancelled"`**, and it
 * arrives in the same feed as everything else. A pull that only wrote items
 * would leave the meeting in the brain forever — it would keep appearing in
 * tomorrow's briefing, and U11 would eventually read it against its
 * rescheduled replacement and report a contradiction that never happened.
 *
 * **Upstream: `PROVIDER_API_BASE['google_calendar']` — `https://www.googleapis.com`.**
 * Named once in that table rather than here, because `app` already says which
 * upstream this is. The host is not interchangeable and was not guessed: the
 * same path under `calendar.googleapis.com` answers Google's own `404`, which
 * is a failure that would look exactly like an empty calendar. `sources.test.ts`
 * pins this adapter's decoded target against the base it was verified on.
 *
 * It is also the source that forces the cursor-expiry path: Calendar answers
 * `410 GONE` on an expired sync token and *mandates* a full re-sync. The
 * runner's answer is to discard the cursor and re-enter through U8's gate with
 * a bounded window, never to re-list the whole calendar.
 */

import type { Correspondent } from '../../correspondents.ts';
import type { ProviderApi } from '../client.ts';
import {
  asArray,
  asDate,
  asRecord,
  asString,
  RESUME_DELIMITER,
  boundBody,
  ceilingFailureFor,
  externalRefFor,
  joinResumeCursor,
  type ProviderListOutcome,
  type ProviderListRequest,
  type ProviderSource,
  type PulledFailure,
  type PulledItem,
  type PulledTombstone,
} from './types.ts';

const APP = 'google_calendar' as const;
const PAGE_SIZE = 250;

/**
 * How far ahead an event may start and still be worth remembering.
 *
 * **`singleEvents: true` expands a recurring event into one item per
 * occurrence, and a floor without a ceiling expands it forever.** Measured on
 * the founder's brain before this constant existed: 935 calendar pages, of
 * which **875 started after 2027 and the furthest was 2056** — a weekly 1:1
 * contributing 387 instances and another 356, each one chunked, embedded, and
 * turned into facts by a paid model call. Only about sixty described anything
 * that had happened. The damage did not stop at the calendar either: those
 * instances read as sentences like *"…is set for March 5, 2048"*, and that is
 * where a brain full of months filed as *organizations* came from.
 *
 * **400 days, because it keeps exactly one occurrence of an annual event.** A
 * birthday, an anniversary and a yearly review each survive once, which is what
 * makes "when is it next" answerable; a 365-day horizon drops the ones that
 * have just passed and answers "never". Everything above a year is a recurrence
 * rule the brain can no longer distinguish from a fact.
 *
 * **What this deliberately costs**, stated because it is a real gap rather than
 * a rounding error: a delta feed only reports events that *change*, so an
 * unchanged occurrence sitting beyond the horizon today is not offered again on
 * the day it moves inside it. It is picked up when a backfill re-lists the
 * window — which this source already does whenever Calendar answers `410 GONE`
 * on an expired sync token. The alternative was worse: tombstoning
 * beyond-horizon events would remove an occurrence permanently, because nothing
 * would ever re-offer it.
 */
export const CALENDAR_HORIZON_DAYS = 400;

/** The instant past which an event is a recurrence rule rather than a plan. */
export function calendarHorizon(now: Date): Date {
  return new Date(now.getTime() + CALENDAR_HORIZON_DAYS * 86_400_000);
}

/**
 * When this event starts, or `null` when it says nothing this source can read.
 *
 * All-day events carry `start.date` rather than `start.dateTime`; both are read
 * here so an all-day birthday thirty years out is bounded like everything else.
 */
function startsAt(event: Record<string, unknown>): Date | null {
  const start = asRecord(event.start);
  if (start === null) return null;
  return asDate(start.dateTime) ?? asDate(start.date);
}

/** The one calendar alpha reads. A multi-calendar fan-out is a later rung. */
const CALENDAR_ID = 'primary';

/**
 * The event as prose.
 *
 * An event's knowledge is in its title, its description and *who was there* —
 * the attendee list is the half a naive mapping drops, and it is the half that
 * answers "when did I last meet them".
 */
/**
 * The people an event states, structured, from the fields the API already gives.
 *
 * **`eventBody` is deliberately left alone.** It flattens these same addresses
 * into `Attendees:` and `Organizer:` prose lines, which is the round trip this
 * function exists to stop needing — but that prose is part of the page's
 * content, so changing it changes `contentDigest`, which re-chunks and
 * re-embeds the whole calendar corpus once. That is a cost with its own
 * argument and its own commit. Both callers read the same fields through this
 * helper so the parse is not written twice in the meantime.
 */
function eventCorrespondents(event: Record<string, unknown>): Correspondent[] {
  const found: Correspondent[] = [];
  for (const entry of asArray(event.attendees)) {
    const email = asString(asRecord(entry)?.email ?? null);
    const name = asString(asRecord(entry)?.displayName ?? null);
    if (email !== null) found.push({ address: email, name, role: 'attendee' });
  }
  const organizer = asRecord(event.organizer);
  const organizerEmail = organizer === null ? null : asString(organizer.email);
  if (organizerEmail !== null) {
    found.push({
      address: organizerEmail,
      name: organizer === null ? null : asString(organizer.displayName),
      role: 'organizer',
    });
  }
  return found;
}

function eventBody(event: Record<string, unknown>): string {
  const lines: string[] = [];
  const summary = asString(event.summary);
  if (summary !== null) lines.push(summary);

  const start = asRecord(event.start);
  const when = start === null ? null : (asString(start.dateTime) ?? asString(start.date));
  if (when !== null) lines.push(`When: ${when}`);

  const location = asString(event.location);
  if (location !== null) lines.push(`Where: ${location}`);

  const attendees = asArray(event.attendees)
    .map((entry) => asString(asRecord(entry)?.email ?? null))
    .filter((email): email is string => email !== null);
  if (attendees.length > 0) lines.push(`Attendees: ${attendees.join(', ')}`);

  const organizer = asString(asRecord(event.organizer)?.email ?? null);
  if (organizer !== null) lines.push(`Organizer: ${organizer}`);

  const description = asString(event.description);
  if (description !== null) lines.push('', description);

  return boundBody(lines.join('\n').trim());
}

/**
 * A sync cursor, read. `<syncToken>` when the source is caught up,
 * `<pageToken>~<syncToken>` when a sync ran past one page. See
 * {@link RESUME_DELIMITER} for why `~` is safe against Google's own tokens.
 */
function readSyncCursor(cursor: string | null): {
  readonly syncToken: string | null;
  readonly pageToken: string | null;
} {
  if (cursor === null) return { syncToken: null, pageToken: null };
  const index = cursor.indexOf(RESUME_DELIMITER);
  if (index < 0) return { syncToken: cursor, pageToken: null };
  return { pageToken: cursor.slice(0, index) || null, syncToken: cursor.slice(index + 1) || null };
}

export function createCalendarSource(
  api: ProviderApi,
  /**
   * The clock the horizon is measured from. Injected for the same reason the
   * client injects one: a bound relative to `now` is untestable against a fixed
   * fixture otherwise, and a horizon nothing has watched apply is not a bound.
   */
  now: () => Date = () => new Date(),
): ProviderSource {
  return {
    source: 'calendar',
    sourceType: 'calendar',

    async list(request: ProviderListRequest): Promise<ProviderListOutcome> {
      const delta = request.mode === 'delta' && request.cursor !== null;
      // A sync that ran past one page carries both halves: `<pageToken>~<syncToken>`.
      // Google's own incremental-sync sample keeps the sync token set and adds
      // the page token, and the alternative — storing the bare page token — is a
      // cursor the next pull cannot tell from a first import's continuation.
      // A cursor with no delimiter is a plain sync token, never a page token:
      // `splitResumeCursor` reads the bare form the other way round, which is
      // right for a backfill's continuation and wrong here.
      const resume = readSyncCursor(delta ? request.cursor : null);

      const listed = await api.request({
        app: APP,
        method: 'GET',
        path: `/calendar/v3/calendars/${CALENDAR_ID}/events`,
        query: {
          maxResults: Math.min(PAGE_SIZE, Math.max(1, request.maxItems)),
          // `showDeleted` is what makes a cancellation observable at all. A
          // delta feed without it reports the event as simply absent, and an
          // absence in a delta feed means "unchanged".
          showDeleted: true,
          singleEvents: true,
          ...(delta
            ? {
                syncToken: resume.syncToken ?? '',
                ...(resume.pageToken === null ? {} : { pageToken: resume.pageToken }),
              }
            : {
                ...(request.since === null ? {} : { timeMin: request.since.toISOString() }),
                // **The ceiling the expansion never had.** Measured against the
                // live project: `timeMin`+`timeMax` answers 200, and
                // `syncToken`+`timeMax` answers **400** — Google refuses a
                // window on an incremental sync because the token already
                // encodes one. So the bound goes on the listing here, and the
                // delta branch enforces the same horizon on the items instead.
                timeMax: calendarHorizon(now()).toISOString(),
                ...(request.cursor === null ? {} : { pageToken: request.cursor }),
              }),
        },
        externalUserId: request.externalUserId,
        accountId: request.accountId ?? null,
      });
      if (!listed.ok) return { ok: false, reason: listed.reason };

      const body = asRecord(listed.value);
      const items: PulledItem[] = [];
      const tombstones: PulledTombstone[] = [];
      const failures: PulledFailure[] = [];

      const offered = asArray(body?.items);
      const ceiling = Math.max(0, request.maxItems);
      const horizon = calendarHorizon(now());
      // Beyond the ceiling is accounted for rather than sliced away: the row is
      // retryable, which holds the cursor, which is what makes the event be
      // offered again instead of dropped.
      for (const entry of offered.slice(ceiling)) {
        const id = asString(asRecord(entry)?.id ?? null);
        failures.push(
          id === null
            ? { externalRef: null, reason: 'parse_failed', retryable: false }
            : ceilingFailureFor(externalRefFor('calendar', id)),
        );
      }

      for (const entry of offered.slice(0, ceiling)) {
        const event = asRecord(entry);
        const id = event === null ? null : asString(event.id);
        if (event === null || id === null) {
          failures.push({ externalRef: null, reason: 'parse_failed', retryable: false });
          continue;
        }

        if (asString(event.status) === 'cancelled') {
          tombstones.push({ externalRef: externalRefFor('calendar', id), reason: 'cancelled' });
          continue;
        }

        const text = eventBody(event);
        if (text.length === 0) {
          failures.push({
            externalRef: externalRefFor('calendar', id),
            reason: 'parse_failed',
            retryable: false,
          });
          continue;
        }

        // The same horizon the listing asks for, applied to what came back —
        // because the delta branch is forbidden from asking. Skipped rather
        // than failed: a failure is retryable and would hold the cursor on an
        // event that is never going to become wanted, wedging the source. And
        // skipped rather than tombstoned: a tombstone would be permanent, and a
        // delta feed never re-offers an unchanged event, so an occurrence
        // removed at 400 days would never return at 300.
        const startsAtInstant = startsAt(event);
        if (startsAtInstant !== null && startsAtInstant.getTime() > horizon.getTime()) continue;

        items.push({
          externalRef: externalRefFor('calendar', id),
          title: asString(event.summary),
          body: text,
          occurredAt: startsAtInstant,
          correspondents: eventCorrespondents(event),
        });
      }

      const nextPageToken = asString(body?.nextPageToken ?? null);
      const nextSyncToken = asString(body?.nextSyncToken ?? null);

      return {
        ok: true,
        page: {
          items,
          tombstones,
          failures,
          // A page token means the listing is unfinished, and *which* listing
          // decides the cursor's kind. An unfinished first import is a
          // `backfill` cursor, so the next slice is re-gated and re-windowed.
          // An unfinished **sync** is still a sync: labelling it `backfill`
          // sends the next pull down the first-import leg, where the page token
          // is replayed against a differently-parameterised listing and the
          // rest of the sync is lost. It carries its sync token beside it,
          // because only the last page of a sync answers `nextSyncToken`.
          nextCursor:
            nextPageToken !== null
              ? delta
                ? {
                    kind: 'delta',
                    value: joinResumeCursor(nextPageToken, resume.syncToken),
                  }
                : { kind: 'backfill', value: nextPageToken }
              : nextSyncToken !== null
                ? { kind: 'delta', value: nextSyncToken }
                : null,
          outsideWindow: null,
        },
      };
    },
  };
}
