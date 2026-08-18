/**
 * Google Drive, metadata only.
 *
 * **The founder's ruling, verbatim in effect: "we shouldn't be storing files
 * from the drive, just filename and metadata."** Asked to choose between three
 * readings they picked the strictest. Drive contributes a filename and the
 * metadata around it and no document text at all — including native Google Docs
 * and Sheets, which this adapter used to export to `text/plain` and `text/csv`.
 * `recall` can tell the user a file exists, what it is, whose it is and where to
 * open it; it will not answer from the contents of a document they wrote. That
 * is the intended trade and it is a scope reduction rather than an
 * optimisation.
 *
 * **Upstream: `PROVIDER_API_BASE['google_drive']` — `https://www.googleapis.com`.**
 * Named once in that table rather than here, because `app` already says which
 * upstream this is.
 *
 * ============================================================================
 * WHAT THIS ALSO FIXES, AND WHY IT DISSOLVES RATHER THAN PATCHES IT
 * ============================================================================
 *
 * Drive had never once recorded a successful run. It was the only adapter that
 * populated `PullPage.media`, and `pull.ts` step 7a answers a listing that
 * carries objects when the handler was composed with neither a `TenantStorage`
 * nor a `RawStore` — which is every deployment of this fleet — by counting each
 * object failed, setting `incomplete = 'provider_error'`, and refusing to save
 * a cursor at step 10. So page one of the backfill replayed every thirty
 * minutes forever, roughly 10 MB a cycle, and the files behind it were never
 * offered at all. Measured per run against the live account on 2026-08-17: 8
 * `ok`, 4 `parse_failed`, **11 `provider_error`** — PDFs and PNGs the adapter
 * had fetched *successfully* and was refused only because there was nowhere to
 * keep them.
 *
 * Metadata-only removes the media path, so the wedge goes with its cause. No
 * object store, no download, no export. **One provider call per page — the
 * listing itself — and zero per file.** A video, a PDF, an empty Doc and a
 * 57 MB deck are now the same thing: a filename with metadata.
 *
 * ============================================================================
 * WHICH METADATA, AND WHY THESE
 * ============================================================================
 *
 * The test is whether a person searching their brain can **recognise the file
 * and go open it**. `fields` is an explicit parameter on both calls below, so a
 * narrower projection is both cheaper and a smaller data footprint — which is
 * the point of the change, and the reason nothing is asked for that does not
 * reach the page:
 *
 *   * `name` — the filename, and now the whole value of the source. It is the
 *     page title *and* the first line of the body, because the full-text arm
 *     recalls on `content_tsv OR title_tsv` and a bare filename needs both.
 *   * `mimeType` — what kind of thing it is, rendered as a human word as well as
 *     the raw type: "spreadsheet" is a term a person searches with and
 *     `application/vnd.google-apps.spreadsheet` is not.
 *   * `webViewLink` — the "go open it" half. Without it recall can say a file
 *     exists and cannot say where.
 *   * `owners(displayName,emailAddress)` — whose file it is. Often the only
 *     thing that tells two similarly named files apart ("the deck alice shared").
 *   * `createdTime` / `modifiedTime` — when it appeared and when it last moved.
 *     `modifiedTime` is also the page's `occurredAt`.
 *   * `size` — recognition again: the 46 MB recording is not the 5 KB note.
 *   * `trashed` — never on the page; it is how the changes feed says "gone".
 *
 * **What is deliberately not asked for, and the reason is one rule.** Every
 * field that reaches the body is part of `page.content_sha256`, so a field that
 * changes without the file changing rewrites the page, re-chunks it and pays for
 * an embedding for nothing. `starred` and `shared` are exactly that. `parents`
 * is a folder *id*, which needs a second provider call per file to become a name
 * a human recognises — the cost this change exists to remove. `fileExtension`
 * is already in the name.
 */

import type { ProviderApi } from '../client.ts';
import {
  asArray,
  asDate,
  asRecord,
  asString,
  boundBody,
  ceilingFailureFor,
  externalRefFor,
  joinResumeCursor,
  splitResumeCursor,
  type ProviderListOutcome,
  type ProviderListRequest,
  type ProviderSource,
  type PulledFailure,
  type PulledItem,
  type PulledTombstone,
} from './types.ts';

const APP = 'google_drive' as const;
const PAGE_SIZE = 100;

/**
 * **A folder is not a document that failed to parse — it is not a document.**
 *
 * Measured against a live account on 2026-08-17: 4 folders in the first 26
 * entries. Before `a80d146` every one of them became a `parse_failed` row, and
 * `items_failed` is the number the connector panel shows an operator — so the
 * surface a stalled connector is diagnosed from reported 18 refusals where 14
 * files had genuinely been refused. It still costs a slice of `maxItems` if it
 * arrives, which is why the guard is here as well as in the listing's `q`.
 */
const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';

/**
 * Exactly the projection the body is built from. Asked for on both the listing
 * and the changes feed, so the two produce byte-identical bodies for the same
 * file state — otherwise a file would flip between `replaced` and `unchanged`
 * depending on which leg saw it.
 */
export const DRIVE_FILE_FIELDS =
  'id,name,mimeType,trashed,createdTime,modifiedTime,size,webViewLink,owners(displayName,emailAddress)';

/**
 * A word a person would search with, for the content types a Drive actually
 * holds. Small on purpose: what is not named falls through to the raw type,
 * which is honest, and a table that tried to name every media type would be a
 * second thing to keep true.
 */
const KIND_BY_MIME: Readonly<Record<string, string>> = {
  'application/vnd.google-apps.document': 'Google Docs document',
  'application/vnd.google-apps.spreadsheet': 'Google Sheets spreadsheet',
  'application/vnd.google-apps.presentation': 'Google Slides presentation',
  'application/vnd.google-apps.form': 'Google Form',
  'application/vnd.google-apps.drawing': 'Google Drawing',
  'application/vnd.google-apps.script': 'Google Apps Script',
  'application/vnd.google-apps.shortcut': 'Drive shortcut',
  'application/pdf': 'PDF',
};

function kindFor(mimeType: string): string | null {
  const named = KIND_BY_MIME[mimeType];
  if (named !== undefined) return named;
  switch (mimeType.split('/')[0]) {
    case 'image':
      return 'image';
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'text':
      return 'text file';
    default:
      return null;
  }
}

const SIZE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const;

/**
 * A size a person recognises. Rounded, because this is a recognition aid and
 * not an accounting record — and deterministic, because it is part of the
 * digest.
 */
function humanSize(raw: unknown): string | null {
  const text = asString(raw);
  if (text === null || !/^\d+$/.test(text)) return null;
  const bytes = Number(text);
  if (!Number.isSafeInteger(bytes)) return null;
  if (bytes < 1024) return `${bytes} bytes`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Math.round(value)} ${SIZE_UNITS[unit]}`;
}

/**
 * Normalised rather than echoed. The provider states RFC 3339; parsing and
 * re-emitting means a change in how Google formats a timestamp is not a change
 * to every page's digest.
 */
function instant(raw: unknown): string | null {
  return asDate(raw)?.toISOString() ?? null;
}

function ownersOf(file: Record<string, unknown>): string | null {
  const named = asArray(file['owners'])
    .map(asRecord)
    .flatMap((owner) => {
      if (owner === null) return [];
      const name = asString(owner['displayName']);
      const email = asString(owner['emailAddress']);
      if (name === null && email === null) return [];
      if (name === null) return [email as string];
      return [email === null ? name : `${name} (${email})`];
    });
  return named.length === 0 ? null : named.join(', ');
}

/**
 * The page body for one Drive file — **the single builder**, shared by the
 * backfill leg, the delta leg and the one-shot reconciliation of the pages
 * written under the old behaviour. Exported for that third caller: a second
 * copy of this function would give the same file two digests and rewrite every
 * page the next time either one ran.
 *
 * It is never empty. `chunkDocument` returns no chunks for a blank body and
 * `ingestDocument` answers `empty_document` — which would fail the item, hold
 * the cursor, and reproduce the wedge this change removes — so the constant
 * line below is load-bearing rather than decorative.
 */
export function driveMetadataBody(file: Record<string, unknown>): string {
  const name = asString(file['name']);
  const mimeType = asString(file['mimeType']);
  const kind = mimeType === null ? null : kindFor(mimeType);
  const lines: string[] = [];

  if (name !== null) lines.push(name, '');
  lines.push('Google Drive file.');
  if (mimeType !== null) {
    lines.push(`Type: ${kind === null ? mimeType : `${kind} (${mimeType})`}`);
  }

  const owners = ownersOf(file);
  if (owners !== null) lines.push(`Owner: ${owners}`);
  const size = humanSize(file['size']);
  if (size !== null) lines.push(`Size: ${size}`);
  const created = instant(file['createdTime']);
  if (created !== null) lines.push(`Created: ${created}`);
  const modified = instant(file['modifiedTime']);
  if (modified !== null) lines.push(`Modified: ${modified}`);
  const link = asString(file['webViewLink']);
  if (link !== null) lines.push(`Link: ${link}`);

  return boundBody(lines.join('\n'));
}

export function createDriveSource(api: ProviderApi): ProviderSource {
  /**
   * Files to pages. **Nothing here reaches the network**, which is the whole
   * shape of the change: the listing already carried every field the page is
   * made of, so the per-file leg that used to export, download and refuse is
   * gone rather than disabled.
   */
  function collect(
    request: ProviderListRequest,
    files: ReadonlyArray<Record<string, unknown>>,
  ): { items: PulledItem[]; failures: PulledFailure[] } {
    const items: PulledItem[] = [];
    const failures: PulledFailure[] = [];
    // **Above the ceiling on purpose.** A slot spent on a folder is a slot no
    // file gets, so the skip has to happen before the budget is counted. The
    // listing refuses folders at the provider (see `backfill`); the changes feed
    // takes no `q`, so this is the only guard covering a folder created or
    // renamed since the last pull.
    const candidates = files.filter((file) => asString(file['mimeType']) !== GOOGLE_FOLDER);
    const ceiling = Math.max(0, request.maxItems);
    // Beyond the ceiling is accounted for, not sliced away: a retryable row
    // holds the cursor, so the file is offered again rather than skipped.
    for (const file of candidates.slice(ceiling)) {
      const id = asString(file['id']);
      failures.push(
        id === null
          ? { externalRef: null, reason: 'parse_failed', retryable: false }
          : ceilingFailureFor(externalRefFor('drive', id)),
      );
    }
    for (const file of candidates.slice(0, ceiling)) {
      const id = asString(file['id']);
      if (id === null) {
        // A file the provider named nothing: there is no idempotency key to
        // write it under, so it cannot become a page and asking again cannot
        // change that.
        failures.push({ externalRef: null, reason: 'parse_failed', retryable: false });
        continue;
      }
      items.push({
        externalRef: externalRefFor('drive', id),
        title: asString(file['name']),
        body: driveMetadataBody(file),
        occurredAt: asDate(file['modifiedTime']),
      });
    }
    return { items, failures };
  }

  async function delta(request: ProviderListRequest): Promise<ProviderListOutcome> {
    const listed = await api.request({
      app: APP,
      method: 'GET',
      path: '/drive/v3/changes',
      query: {
        pageToken: request.cursor ?? '',
        pageSize: Math.min(PAGE_SIZE, Math.max(1, request.maxItems)),
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${DRIVE_FILE_FIELDS}))`,
      },
      externalUserId: request.externalUserId,
      accountId: request.accountId ?? null,
    });
    if (!listed.ok) return { ok: false, reason: listed.reason };

    const body = asRecord(listed.value);
    const tombstones: PulledTombstone[] = [];
    const live: Record<string, unknown>[] = [];

    for (const entry of asArray(body?.['changes'])) {
      const change = asRecord(entry);
      if (change === null) continue;
      const fileId = asString(change['fileId']);
      const file = asRecord(change['file']);

      if (change['removed'] === true) {
        if (fileId !== null) {
          tombstones.push({ externalRef: externalRefFor('drive', fileId), reason: 'removed' });
        }
        continue;
      }
      if (file !== null && file['trashed'] === true) {
        const id = asString(file['id']) ?? fileId;
        if (id !== null) {
          tombstones.push({ externalRef: externalRefFor('drive', id), reason: 'trashed' });
        }
        continue;
      }
      // A change with neither a file nor a removal flag says nothing about the
      // file; treating it as live would write a page for something that may not
      // exist. It is skipped rather than guessed at.
      if (file !== null) live.push(file);
    }

    const { items, failures } = collect(request, live);
    const nextPageToken = asString(body?.['nextPageToken'] ?? null);
    const newStartPageToken = asString(body?.['newStartPageToken'] ?? null);

    return {
      ok: true,
      page: {
        items,
        tombstones,
        failures,
        // **A truncated change page is still a delta.** The changes feed's own
        // `nextPageToken` is what `/drive/v3/changes` wants next. Labelling it
        // `backfill` sends the next pull down the first-import leg, which
        // fetches a brand-new start token and hands this changes token to
        // `/drive/v3/files`: the wrong endpoint, a token it cannot use, and the
        // rest of the change feed lost.
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
      startPageToken = asString(asRecord(start.value)?.['startPageToken'] ?? null);
    }

    const listed = await api.request({
      app: APP,
      method: 'GET',
      path: '/drive/v3/files',
      query: {
        pageSize: Math.min(PAGE_SIZE, Math.max(1, request.maxItems)),
        fields: `nextPageToken,files(${DRIVE_FILE_FIELDS})`,
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
    // **Not sliced here.** `collect` is the one place that decides what happens
    // to a file this pull has no room for, and its answer is a retryable row
    // that holds the cursor — a `.slice` above it would drop the tail silently
    // and the file would never be offered again. Measured against the live
    // vendor on 2026-08-17: Google honours `pageSize`, so this branch does not
    // fire in production; it fires for a provider that overshoots, which is
    // exactly when the difference between "accounted for" and "gone" matters.
    const files = asArray(body?.['files'])
      .map(asRecord)
      .filter((file): file is Record<string, unknown> => file !== null);

    const { items, failures } = collect(request, files);
    const nextPageToken = asString(body?.['nextPageToken'] ?? null);

    return {
      ok: true,
      page: {
        items,
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
