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
 * It is also the source that forces the cursor-expiry path: Calendar answers
 * `410 GONE` on an expired sync token and *mandates* a full re-sync. The
 * runner's answer is to discard the cursor and re-enter through U8's gate with
 * a bounded window, never to re-list the whole calendar.
 */

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

/** The one calendar alpha reads. A multi-calendar fan-out is a later rung. */
const CALENDAR_ID = 'primary';

/**
 * The event as prose.
 *
 * An event's knowledge is in its title, its description and *who was there* —
 * the attendee list is the half a naive mapping drops, and it is the half that
 * answers "when did I last meet them".
 */
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

export function createCalendarSource(api: ProviderApi): ProviderSource {
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

        const start = asRecord(event.start);
        items.push({
          externalRef: externalRefFor('calendar', id),
          title: asString(event.summary),
          body: text,
          occurredAt:
            start === null ? null : (asDate(start.dateTime) ?? asDate(start.date)),
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
