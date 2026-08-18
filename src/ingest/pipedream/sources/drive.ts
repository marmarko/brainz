/**
 * Google Drive, thin.
 *
 * Drive's change feed is the cleanest of the three about deletion and the
 * messiest about content. A change carries `removed: true` when the file left
 * the user's view entirely, and a `file.trashed` flag when it went to the bin;
 * both are tombstones here, because a document in the bin must stop answering
 * queries whatever the mechanism was.
 *
 * **Upstream: `PROVIDER_API_BASE['google_drive']` — `https://www.googleapis.com`.**
 * Named once in that table rather than here, because `app` already says which
 * upstream this is. This adapter is the one that makes the proxy's encoding
 * load-bearing: a 44-character file id — the everyday length — puts the `?` of
 * `?alt=media` at an offset where standard base64 emits a raw `/`, which splits
 * the proxy's path segment and is answered `404` before Google is ever reached.
 * Every download below depends on that segment being base64**url**.
 *
 * **A binary file is never decoded leniently.** A PDF or a PNG run through a
 * text decoder becomes a page of replacement characters with a vector attached
 * to it: it costs an embedding call and pollutes retrieval with a document that
 * says nothing. That was the whole argument for the failure row this adapter
 * used to write for every image — and the failure row was only ever half the
 * answer, because it meant a Drive full of screenshots imported as a Drive full
 * of failures and U21's transcribe queue stayed empty for good.
 *
 * So: a binary whose content type U21 can read is **fetched as bytes** and
 * offered as media. It is preserved by the runner and transcribed later, in the
 * cycle, under a phase budget. A binary U21 cannot read still gets the honest
 * failure row, and so does one the provider says is too big to hold — refused
 * from the *listing*, before a download, because the listing already states the
 * size and a two-gigabyte file should never become a request.
 */

import { MAX_MEDIA_BYTES, classifyMedia } from '../../../core/media/accept.ts';
import type { ProviderApi } from '../client.ts';
import {
  asArray,
  asDate,
  asRecord,
  asString,
  boundBody,
  ceilingFailureFor,
  externalRefFor,
  itemFailureFor,
  joinResumeCursor,
  splitResumeCursor,
  type ProviderListOutcome,
  type ProviderListRequest,
  type ProviderSource,
  type PulledFailure,
  type PulledItem,
  type PulledMedia,
  type PulledTombstone,
} from './types.ts';

const APP = 'google_drive' as const;
const PAGE_SIZE = 100;

/**
 * **A folder is not a document that failed to parse — it is not a document.**
 *
 * Drive's listing and its change feed both carry folders, and every one of them
 * used to reach `classifyMedia`, be refused for a content type that is not a
 * content type, and land in `ingest_log` as `parse_failed`. Measured against a
 * live account on 2026-08-17: 4 folders in the first 26 entries, so four bogus
 * refusals per run against a folder tree that never changes — and
 * `items_failed` is the number the connector panel shows an operator, so the
 * surface a stalled connector is diagnosed from was reporting 18 refusals where
 * 14 files had genuinely been refused.
 */
const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';

const GOOGLE_DOC = 'application/vnd.google-apps.document';
const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_SLIDES = 'application/vnd.google-apps.presentation';

const FILE_FIELDS = 'id,name,mimeType,trashed,modifiedTime,size';

/** Mime types this unit can turn into prose without a model. */
function isTextual(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml' ||
    mimeType === 'application/rtf'
  );
}

function exportMimeFor(mimeType: string): string | null {
  if (mimeType === GOOGLE_DOC || mimeType === GOOGLE_SLIDES) return 'text/plain';
  if (mimeType === GOOGLE_SHEET) return 'text/csv';
  return null;
}

/** Drive states `size` as a decimal string, and only for binary files. */
function declaredSize(file: Record<string, unknown>): number | null {
  const raw = asString(file.size);
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const size = Number(raw);
  return Number.isSafeInteger(size) ? size : null;
}

export function createDriveSource(api: ProviderApi): ProviderSource {
  /**
   * A file U21 can read, fetched as bytes.
   *
   * The size check is against the *listing*, before the request: nothing here
   * streams, so an unbounded object is the whole file in memory on the way to
   * the object store — and a listing that says two gigabytes should never
   * become a download. `acceptMedia` re-checks at the boundary for the files
   * Drive did not size.
   */
  async function fetchMedia(
    request: ProviderListRequest,
    file: Record<string, unknown>,
    externalRef: string,
    mediaType: string,
  ): Promise<PulledMedia | PulledFailure> {
    const size = declaredSize(file);
    if (size !== null && size > MAX_MEDIA_BYTES) {
      return { externalRef, reason: 'parse_failed', retryable: false };
    }

    const id = asString(file.id) ?? '';
    const outcome = await api.request({
      app: APP,
      method: 'GET',
      path: `/drive/v3/files/${encodeURIComponent(id)}`,
      query: { alt: 'media' },
      externalUserId: request.externalUserId,
      accountId: request.accountId ?? null,
      binary: true,
    });
    if (!outcome.ok) return itemFailureFor(externalRef, outcome);

    const bytes = outcome.value instanceof Uint8Array ? outcome.value : null;
    if (bytes === null) {
      // The client in use cannot answer in bytes. That is a fact about this
      // deployment, not about the file, so the cursor holds: a fleet that gains
      // a binary-capable transport tomorrow must be offered this change again,
      // and the alternative is a user's screenshots skipped for good by a
      // configuration nobody noticed.
      return { externalRef, reason: 'provider_error', retryable: true };
    }
    if (bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) {
      return { externalRef, reason: 'parse_failed', retryable: false };
    }
    return { externalRef, mediaType, bytes };
  }

  async function fetchContent(
    request: ProviderListRequest,
    file: Record<string, unknown>,
  ): Promise<PulledItem | PulledMedia | PulledFailure> {
    const id = asString(file.id);
    if (id === null) return { externalRef: null, reason: 'parse_failed', retryable: false };
    const externalRef = externalRefFor('drive', id);
    const mimeType = asString(file.mimeType) ?? '';
    const exportMime = exportMimeFor(mimeType);

    if (exportMime === null && !isTextual(mimeType)) {
      // Drive states its own content type for its own object, so it is used
      // rather than sniffed — and `classifyMedia` refuses anything outside the
      // closed set regardless, which is what keeps a voice memo out.
      const verdict = classifyMedia(mimeType);
      if (verdict.ok) return await fetchMedia(request, file, externalRef, verdict.mediaType);
      return { externalRef, reason: 'parse_failed', retryable: false };
    }

    const outcome = await api.request({
      app: APP,
      method: 'GET',
      path:
        exportMime === null
          ? `/drive/v3/files/${encodeURIComponent(id)}`
          : `/drive/v3/files/${encodeURIComponent(id)}/export`,
      query: exportMime === null ? { alt: 'media' } : { mimeType: exportMime },
      externalUserId: request.externalUserId,
      accountId: request.accountId ?? null,
      raw: true,
    });
    // The provider's own status decides whether the cursor may move past this
    // file: a 429 collapsed into `provider_error` reads as "this document is
    // broken" and the edit is never offered again.
    if (!outcome.ok) return itemFailureFor(externalRef, outcome);

    const text = typeof outcome.value === 'string' ? outcome.value : '';
    // A NUL byte is legal UTF-8 and never appears in a document a human wrote.
    if (text.trim().length === 0 || text.includes('\u0000')) {
      return { externalRef, reason: 'parse_failed', retryable: false };
    }

    return {
      externalRef,
      title: asString(file.name),
      body: boundBody(text),
      occurredAt: asDate(file.modifiedTime),
    };
  }

  async function collect(
    request: ProviderListRequest,
    files: ReadonlyArray<Record<string, unknown>>,
  ): Promise<{ items: PulledItem[]; media: PulledMedia[]; failures: PulledFailure[] }> {
    const items: PulledItem[] = [];
    const media: PulledMedia[] = [];
    const failures: PulledFailure[] = [];
    // **Above the ceiling on purpose.** A slot spent on a folder is a slot no
    // file gets, so the skip has to happen before the budget is counted rather
    // than inside `fetchContent`. The listing refuses folders at the provider
    // (see `backfill`); the changes feed takes no `q`, so this is the only
    // guard that covers a folder created or renamed since the last pull.
    const candidates = files.filter((file) => asString(file.mimeType) !== GOOGLE_FOLDER);
    const ceiling = Math.max(0, request.maxItems);
    // Beyond the ceiling is accounted for, not sliced away: a retryable row
    // holds the cursor, so the change is offered again rather than skipped.
    for (const file of candidates.slice(ceiling)) {
      const id = asString(file.id);
      failures.push(
        id === null
          ? { externalRef: null, reason: 'parse_failed', retryable: false }
          : ceilingFailureFor(externalRefFor('drive', id)),
      );
    }
    for (const file of candidates.slice(0, ceiling)) {
      const fetched = await fetchContent(request, file);
      if ('reason' in fetched) failures.push(fetched);
      else if ('bytes' in fetched) media.push(fetched);
      else items.push(fetched);
    }
    return { items, media, failures };
  }

  async function delta(request: ProviderListRequest): Promise<ProviderListOutcome> {
    const listed = await api.request({
      app: APP,
      method: 'GET',
      path: '/drive/v3/changes',
      query: {
        pageToken: request.cursor ?? '',
        pageSize: Math.min(PAGE_SIZE, Math.max(1, request.maxItems)),
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
      },
      externalUserId: request.externalUserId,
      accountId: request.accountId ?? null,
    });
    if (!listed.ok) return { ok: false, reason: listed.reason };

    const body = asRecord(listed.value);
    const tombstones: PulledTombstone[] = [];
    const live: Record<string, unknown>[] = [];

    for (const entry of asArray(body?.changes)) {
      const change = asRecord(entry);
      if (change === null) continue;
      const fileId = asString(change.fileId);
      const file = asRecord(change.file);

      if (change.removed === true) {
        if (fileId !== null) {
          tombstones.push({ externalRef: externalRefFor('drive', fileId), reason: 'removed' });
        }
        continue;
      }
      if (file !== null && file.trashed === true) {
        const id = asString(file.id) ?? fileId;
        if (id !== null) {
          tombstones.push({ externalRef: externalRefFor('drive', id), reason: 'trashed' });
        }
        continue;
      }
      // A change with neither a file nor a removal flag says nothing about the
      // file's content; treating it as live would fetch a file that may not
      // exist. It is skipped rather than guessed at.
      if (file !== null) live.push(file);
    }

    const { items, media, failures } = await collect(request, live);
    const nextPageToken = asString(body?.nextPageToken ?? null);
    const newStartPageToken = asString(body?.newStartPageToken ?? null);

    return {
      ok: true,
      page: {
        items,
        media,
        tombstones,
        failures,
        // **A truncated change page is still a delta.** The changes feed's own
        // `nextPageToken` is what `/drive/v3/changes` wants next — it is a delta
        // cursor in every sense. Labelling it `backfill` sends the next pull
        // down the first-import leg, which fetches a brand-new start token and
        // hands this changes token to `/drive/v3/files`: the wrong endpoint,
        // a token it cannot use, and the rest of the change feed lost.
        nextCursor:
          nextPageToken !== null
            ? { kind: 'delta', value: nextPageToken }
            : newStartPageToken === null
              ? null
              : { kind: 'delta', value: newStartPageToken },
        outsideWindow: null,
      },
    };
  }

  async function backfill(request: ProviderListRequest): Promise<ProviderListOutcome> {
    // The change token comes first, for the reason Gmail's history id does: a
    // file edited during the backfill must land in the delta that follows
    // rather than in the gap between the two calls.
    const resume = splitResumeCursor(request.cursor);
    let startPageToken = resume.deltaToken;
    if (startPageToken === null) {
      const start = await api.request({
        app: APP,
        method: 'GET',
        path: '/drive/v3/changes/startPageToken',
        externalUserId: request.externalUserId,
        accountId: request.accountId ?? null,
      });
      if (!start.ok) return { ok: false, reason: start.reason };
      startPageToken = asString(asRecord(start.value)?.startPageToken ?? null);
    }

    const listed = await api.request({
      app: APP,
      method: 'GET',
      path: '/drive/v3/files',
      query: {
        pageSize: Math.min(PAGE_SIZE, Math.max(1, request.maxItems)),
        fields: `nextPageToken,files(${FILE_FIELDS})`,
        // The folder clause is the provider's half of the guard in `collect`:
        // asked for here, a folder never costs a slice of `maxItems` in the
        // first place. Live, that is 4 of every 26 entries — 15% of a first
        // import's page budget, on every page, for the life of the backfill.
        q:
          `trashed = false and mimeType != '${GOOGLE_FOLDER}'` +
          `${request.since === null ? '' : ` and modifiedTime > '${request.since.toISOString()}'`}`,
        ...(resume.pageToken === null ? {} : { pageToken: resume.pageToken }),
      },
      externalUserId: request.externalUserId,
      accountId: request.accountId ?? null,
    });
    if (!listed.ok) return { ok: false, reason: listed.reason };

    const body = asRecord(listed.value);
    const files = asArray(body?.files)
      .map(asRecord)
      .filter((file): file is Record<string, unknown> => file !== null)
      .slice(0, request.maxItems);

    const { items, media, failures } = await collect(request, files);
    const nextPageToken = asString(body?.nextPageToken ?? null);

    return {
      ok: true,
      page: {
        items,
        media,
        tombstones: [],
        failures,
        nextCursor:
          nextPageToken !== null
            ? { kind: 'backfill', value: joinResumeCursor(nextPageToken, startPageToken) }
            : startPageToken === null
              ? null
              : { kind: 'delta', value: startPageToken },
        outsideWindow: null,
      },
    };
  }

  return {
    source: 'drive',
    sourceType: 'document',
    list(request) {
      return request.mode === 'delta' && request.cursor !== null ? delta(request) : backfill(request);
    },
  };
}
