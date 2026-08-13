/**
 * Google Drive, thin.
 *
 * Drive's change feed is the cleanest of the three about deletion and the
 * messiest about content. A change carries `removed: true` when the file left
 * the user's view entirely, and a `file.trashed` flag when it went to the bin;
 * both are tombstones here, because a document in the bin must stop answering
 * queries whatever the mechanism was.
 *
 * **A binary file is refused, not decoded leniently.** A PDF or a PNG run
 * through a text decoder becomes a page of replacement characters with a vector
 * attached to it: it costs an embedding call and pollutes retrieval with a
 * document that says nothing. U21 owns the media path; what belongs here is the
 * honest failure row — the same choice U8's folder import makes, one store
 * over.
 */

import type { ProviderApi } from '../client.ts';
import {
  asArray,
  asDate,
  asRecord,
  asString,
  boundBody,
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

const GOOGLE_DOC = 'application/vnd.google-apps.document';
const GOOGLE_SHEET = 'application/vnd.google-apps.spreadsheet';
const GOOGLE_SLIDES = 'application/vnd.google-apps.presentation';

const FILE_FIELDS = 'id,name,mimeType,trashed,modifiedTime';

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

export function createDriveSource(api: ProviderApi): ProviderSource {
  async function fetchContent(
    request: ProviderListRequest,
    file: Record<string, unknown>,
  ): Promise<PulledItem | PulledFailure> {
    const id = asString(file.id);
    if (id === null) return { externalRef: null, reason: 'parse_failed' };
    const externalRef = externalRefFor('drive', id);
    const mimeType = asString(file.mimeType) ?? '';
    const exportMime = exportMimeFor(mimeType);

    if (exportMime === null && !isTextual(mimeType)) {
      return { externalRef, reason: 'parse_failed' };
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
    if (!outcome.ok) return { externalRef, reason: 'provider_error' };

    const text = typeof outcome.value === 'string' ? outcome.value : '';
    // A NUL byte is legal UTF-8 and never appears in a document a human wrote.
    if (text.trim().length === 0 || text.includes('\u0000')) {
      return { externalRef, reason: 'parse_failed' };
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
  ): Promise<{ items: PulledItem[]; failures: PulledFailure[] }> {
    const items: PulledItem[] = [];
    const failures: PulledFailure[] = [];
    for (const file of files) {
      const fetched = await fetchContent(request, file);
      if ('reason' in fetched) failures.push(fetched);
      else items.push(fetched);
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

    const { items, failures } = await collect(request, live.slice(0, request.maxItems));
    const nextPageToken = asString(body?.nextPageToken ?? null);
    const newStartPageToken = asString(body?.newStartPageToken ?? null);

    return {
      ok: true,
      page: {
        items,
        tombstones,
        failures,
        nextCursor:
          nextPageToken !== null
            ? { kind: 'backfill', value: nextPageToken }
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
        q: `trashed = false${request.since === null ? '' : ` and modifiedTime > '${request.since.toISOString()}'`}`,
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

    const { items, failures } = await collect(request, files);
    const nextPageToken = asString(body?.nextPageToken ?? null);

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
