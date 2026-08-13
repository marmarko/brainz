/**
 * Acceptance (U21 approach step 1) — and the line it must not cross.
 *
 * **Acceptance is not extraction.** A Drive file, a mail attachment or a
 * folder-import image is stored as a raw payload under the tenant's own prefix
 * with its content type recorded, and *nothing is transcribed here*.
 * Transcription is a model call, and per the plan's cross-cutting principle a
 * model call belongs where calls are batched, budgeted and checkpointed — which
 * is `ocr-phase.ts`, inside U11's cycle. A write path that quietly OCR'd would
 * still return a receipt; the only place it would show up is the bill, and only
 * after a connector's first backfill.
 *
 * **The payload is preserved before the row exists.** R23's argument for keeping
 * the original is that extraction improves and the fleet cannot re-derive from
 * bytes it no longer has. So the object is written first and a failed write
 * *stops* the acceptance: a row pointing at an object that is not there is a
 * transcription the cycle queues, pays a phase stop for, and never resolves.
 * `src/ingest/import/raw.ts` states the same rule for chat exports; this is the
 * same rule for media.
 *
 * **No key is built here.** `src/control/storage.ts` is the one place a tenant id
 * becomes a prefix or a key, and R2's measured semantics — a *literal*
 * leading-substring match, so a credential scoped to `tenant-a` reads
 * `tenant-abc/` — are why that is enforced by a scan rather than agreed. The
 * provider's own id is hashed by the accessor rather than sanitised, because a
 * Drive filename is the user's and a sanitiser is a losing game against
 * percent-encoding.
 *
 * **The supported set is a closed list, and the refusal names it.** U21 step 4:
 * a voice memo, a video or an unrecognised binary gets a typed error naming what
 * is and is not supported, "rather than accepting and silently never indexing
 * it". Silent acceptance is the failure mode this whole unit is designed
 * against, so the classifier refuses anything it does not recognise instead of
 * storing it against the hope that something downstream will cope.
 */

import { createHash } from 'node:crypto';
import type { SQL } from 'bun';

import type { CallerIdentity } from '../../control/secrets.ts';
import type { TenantStorage } from '../../control/storage.ts';
import type { RawObject, RawStore } from '../../ingest/import/raw.ts';

/** Where media lands: `{tenant}/media/<digest of the provider's own id>`. */
export const MEDIA_COLLECTION = 'media';

/**
 * The external ref a transcript page is keyed on.
 *
 * Spelled once, and that is not tidiness: three places have to agree on it — the
 * OCR phase writes it, the connector's deletion sweep has to *find* it, and the
 * tests assert against it. Two of those three did not exist when the phase chose
 * the string, which is how a transcript came to be unreachable by every deletion
 * path in the system.
 */
export function transcriptRefFor(attachmentId: string): string {
  return `attachment:${attachmentId}`;
}

/**
 * The images U21 is built for. A screenshot is the dominant consumer image and
 * it is mostly text; interpreting photographs is explicitly not the goal, so the
 * list is the formats a screenshot actually arrives in rather than everything a
 * decoder could open.
 */
export const IMAGE_MEDIA_TYPES: readonly string[] = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export const PDF_MEDIA_TYPE = 'application/pdf';

export const SUPPORTED_MEDIA_TYPES: readonly string[] = Object.freeze([
  ...IMAGE_MEDIA_TYPES,
  PDF_MEDIA_TYPE,
]);

/**
 * The largest payload this brain will take in one object.
 *
 * A ceiling rather than a correctness rule, in the same spirit as
 * `sources/types.ts:MAX_ITEM_CHARACTERS`: nothing here streams, so an
 * unbounded object is the whole file in memory on the way to the store and the
 * whole file in memory again on the way to the vision model. Sources refuse
 * *before* fetching wherever the provider states a size — a listing that says
 * two gigabytes should never become a download — and this constant is the
 * backstop for the ones that do not say.
 */
export const MAX_MEDIA_BYTES = 10_000_000;

/**
 * What these bytes actually are, read from the bytes.
 *
 * A filename extension is the user's, and a source that trusted `.png` would
 * hand a mislabelled file to a decoder that cannot read it — or, worse, accept
 * `invoice.png` that is really a 900MB video because the name said otherwise.
 * The signatures below are the four image formats U21 supports plus PDF, which
 * is the whole closed set; anything else returns `null` and the caller records
 * the refusal that {@link classifyMedia} would have produced anyway.
 *
 * Sources that carry a *provider-asserted* content type (Drive, mail) use that
 * instead: it is the same class of claim as `occurred_at` — content, not truth
 * — but it is the provider's own answer for its own object, and `classifyMedia`
 * refuses anything outside the closed set regardless.
 */
export function sniffMediaType(bytes: Uint8Array): string | null {
  const starts = (...signature: number[]): boolean =>
    bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);

  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  // RIFF....WEBP — the four length bytes in between are not part of the claim.
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes.length >= 12) {
    const webp = [0x57, 0x45, 0x42, 0x50];
    if (webp.every((byte, index) => bytes[8 + index] === byte)) return 'image/webp';
  }
  if (starts(0x25, 0x50, 0x44, 0x46)) return PDF_MEDIA_TYPE;

  return null;
}

/**
 * The families the plan declines by name, kept separate from "we do not
 * recognise this". A user who sends a voice memo has asked for a feature that
 * does not exist; a user who sends `application/x-quicken` has asked for one
 * nobody has considered. Telling them apart is the difference between a policy
 * and a shrug.
 */
export const DECLINED_MEDIA_FAMILIES: readonly string[] = Object.freeze(['audio/*', 'video/*']);

export type MediaKind = 'image' | 'pdf';

export interface MediaAccepted {
  readonly ok: true;
  readonly kind: MediaKind;
  /** Normalised: lower case, parameters stripped. */
  readonly mediaType: string;
}

export interface MediaRefused {
  readonly ok: false;
  readonly reason: 'unsupported_media_type';
  /** What was offered, as it was offered. */
  readonly mediaType: string;
  readonly supported: readonly string[];
  readonly declined: readonly string[];
}

export type MediaVerdict = MediaAccepted | MediaRefused;

/** `image/PNG; charset=binary` and `image/png` are one content type. */
export function normalizeMediaType(raw: string): string {
  const [first] = raw.trim().toLowerCase().split(';');
  return (first ?? '').trim();
}

export function classifyMedia(raw: string): MediaVerdict {
  const mediaType = normalizeMediaType(raw);

  if (IMAGE_MEDIA_TYPES.includes(mediaType)) return { ok: true, kind: 'image', mediaType };
  if (mediaType === PDF_MEDIA_TYPE) return { ok: true, kind: 'pdf', mediaType };

  return {
    ok: false,
    reason: 'unsupported_media_type',
    mediaType: raw.trim(),
    supported: SUPPORTED_MEDIA_TYPES,
    declined: DECLINED_MEDIA_FAMILIES,
  };
}

export function unsupportedMediaMessage(refusal: MediaRefused): string {
  return (
    `\`${refusal.mediaType}\` is not a content type this brain can read. ` +
    `It reads ${refusal.supported.join(', ')}; it does not transcribe ${refusal.declined.join(' or ')}. ` +
    'The file is not stored, so nothing was silently dropped.'
  );
}

// ---------------------------------------------------------------------------
// `remember`'s stated answer (U21 approach step 4).
// ---------------------------------------------------------------------------

export interface RememberMediaAnswer {
  readonly reason: 'unsupported_media_type';
  readonly mediaType: string;
  /** True when the *brain* can read this, even though `remember` cannot take it. */
  readonly transcribable: boolean;
  readonly supported: readonly string[];
  readonly declined: readonly string[];
  /** Where a transcribable type does get in, or `null` when nowhere does. */
  readonly acceptedVia: 'connector_or_import' | null;
}

/**
 * What `remember` answers when a caller declares a file.
 *
 * **It is always a refusal, and the two refusals are not the same.** A voice
 * memo is not transcribable at all. A screenshot is — but `remember` still
 * cannot take it, because accepting media means preserving the raw payload under
 * the tenant prefix and the request path holds no object store. Answering "yes"
 * and dropping the bytes would be exactly the silent acceptance step 4 exists to
 * forbid, and the honest answer names the door that is open instead.
 */
export function mediaPolicyForRemember(raw: string): RememberMediaAnswer {
  const verdict = classifyMedia(raw);
  const transcribable = verdict.ok;
  return {
    reason: 'unsupported_media_type',
    mediaType: verdict.ok ? verdict.mediaType : raw.trim(),
    transcribable,
    supported: SUPPORTED_MEDIA_TYPES,
    declined: DECLINED_MEDIA_FAMILIES,
    acceptedVia: transcribable ? 'connector_or_import' : null,
  };
}

export function rememberMediaMessage(answer: RememberMediaAnswer): string {
  if (!answer.transcribable) {
    return (
      `\`${answer.mediaType}\` is not something this brain can read. ` +
      `It reads ${answer.supported.join(', ')}; it does not transcribe ${answer.declined.join(' or ')}. ` +
      'Nothing was stored — describe it in words instead and that will be remembered.'
    );
  }
  return (
    `\`${answer.mediaType}\` is readable, but not through \`remember\`, which takes text only. ` +
    'Files become searchable when they arrive from a connected source or a folder import: ' +
    'the original is preserved and the next consolidation cycle transcribes it. ' +
    'Nothing was stored by this call.'
  );
}

// ---------------------------------------------------------------------------
// Accepting one object.
// ---------------------------------------------------------------------------

/**
 * Reading back a payload this brain already stored.
 *
 * Keyed on a plain `string`, and that is deliberate. `ObjectKey` is a
 * *derivation* guarantee — a key that came out of the accessor — and the
 * guarantee has already been discharged by the time a key is sitting in
 * `attachment.object_key`, which nothing but {@link acceptMedia} writes. Reading
 * is not a derivation site, so the OCR phase never holds a branded type and
 * never has to mint one; `test/control/accessor-boundary.test.ts` scans `src/`
 * for exactly the cast that would be needed otherwise.
 */
export interface StoredPayloadReader {
  read(objectKey: string): Promise<RawObject | null>;
}

export interface AcceptMediaDeps {
  readonly sql: SQL;
  readonly storage: TenantStorage;
  readonly store: RawStore;
}

export interface AcceptMediaInput {
  readonly tenantId: string;
  readonly caller: CallerIdentity;
  /** R15: credential-derived, immutable, and inherited by the transcript. */
  readonly originContext: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  /** The provider's own id for this object. Hashed by the accessor, never trusted. */
  readonly externalId: string;
  /** The page this arrived on, when it arrived on one. */
  readonly pageId?: string | null;
  readonly subject?: { readonly context: string; readonly confidence: number } | null;
  /** U9's junk verdict. A quarantined attachment is stored and never transcribed. */
  readonly quarantine?: string | null;
}

export type AcceptFailureReason =
  | 'unsupported_media_type'
  | 'empty_payload'
  /** Over {@link MAX_MEDIA_BYTES}. The backstop for a source that fetched first. */
  | 'payload_too_large'
  | 'origin_missing'
  | 'key_denied'
  | 'preservation_failed';

export interface AcceptFailure {
  readonly ok: false;
  readonly reason: AcceptFailureReason;
  readonly detail?: string;
  /** Present on `unsupported_media_type`: what is and is not supported. */
  readonly media?: MediaRefused;
}

export interface AcceptReceipt {
  readonly ok: true;
  /** `unchanged` cost nothing at all — a poller's most common outcome. */
  readonly status: 'stored' | 'unchanged' | 'replaced';
  readonly attachmentId: string;
  readonly objectKey: string;
  readonly mediaType: string;
  readonly kind: MediaKind;
  readonly contentSha256: string;
  readonly byteSize: number;
}

export type AcceptResult = AcceptReceipt | AcceptFailure;

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface ExistingAttachment {
  readonly attachmentId: string;
  readonly contentSha256: string | null;
  readonly quarantined: boolean;
}

async function liveAttachmentByKey(sql: SQL, objectKey: string): Promise<ExistingAttachment | null> {
  const rows = (await sql`
    SELECT attachment_id::text AS attachment_id, content_sha256,
           (quarantined_at IS NOT NULL) AS quarantined
      FROM attachment
     WHERE object_key = ${objectKey} AND deleted_at IS NULL
     ORDER BY attachment_id DESC
     LIMIT 1
  `) as Array<{ attachment_id: string; content_sha256: string | null; quarantined: boolean }>;
  const row = rows[0];
  return row === undefined
    ? null
    : {
        attachmentId: row.attachment_id,
        contentSha256: row.content_sha256,
        quarantined: row.quarantined,
      };
}

/**
 * Record which provider object this row is, if the row does not say yet.
 *
 * **Rung 6's backfill, and it is an observation rather than a migration.** Every
 * attachment written before that rung carries `external_ref IS NULL`, which
 * makes it unreachable by the connector's deletion sweep — and the id cannot be
 * recovered from the key, because the accessor hashes it (R9). What can be
 * recovered is the caller in front of us right now, who has just been handed
 * this exact object under this exact id by the provider. So the value is
 * written from a sighting, on whichever path the sighting arrives — including
 * `unchanged`, which is a poller's most common outcome and therefore the one
 * that heals the most rows.
 *
 * `WHERE external_ref IS NULL` is the whole safety rule: an observed value is
 * never replaced by a later, different claim.
 */
async function noteExternalRef(sql: SQL, attachmentId: string, externalRef: string): Promise<void> {
  if (externalRef.length === 0) return;
  await sql`
    UPDATE attachment SET external_ref = ${externalRef}
     WHERE attachment_id = ${attachmentId}::bigint AND external_ref IS NULL
  `;
}

/**
 * Store one object and record it. Nothing is read, decoded or transcribed.
 *
 * Idempotent on (object key, digest, junk verdict) — the same triple the write
 * path keys a document on, and for the same reason it is a triple rather than a
 * digest: a message re-classified between two pulls has identical bytes and a
 * different visibility, so taking the shortcut on the digest alone would make
 * the first classification a one-way door.
 */
export async function acceptMedia(
  deps: AcceptMediaDeps,
  input: AcceptMediaInput,
): Promise<AcceptResult> {
  const verdict = classifyMedia(input.mediaType);
  if (!verdict.ok) {
    return { ok: false, reason: 'unsupported_media_type', media: verdict };
  }
  if (input.bytes.length === 0) return { ok: false, reason: 'empty_payload' };
  if (input.bytes.length > MAX_MEDIA_BYTES) {
    return { ok: false, reason: 'payload_too_large', detail: String(input.bytes.length) };
  }

  const origin = input.originContext.trim();
  if (origin.length === 0) return { ok: false, reason: 'origin_missing' };

  const key = deps.storage.keyForUntrusted(
    input.caller,
    input.tenantId,
    MEDIA_COLLECTION,
    input.externalId,
  );
  if (!key.ok) return { ok: false, reason: 'key_denied', detail: key.reason };

  const contentSha256 = digestOf(input.bytes);
  const quarantined = (input.quarantine ?? '').trim().length > 0;
  const externalRef = input.externalId.trim();
  const existing = await liveAttachmentByKey(deps.sql, key.key);

  if (
    existing !== null &&
    existing.contentSha256 === contentSha256 &&
    existing.quarantined === quarantined
  ) {
    // Nothing about the object changed, so nothing about the object is written
    // — except the one thing this sighting is evidence of, and only if the row
    // does not already know it. See `noteExternalRef`.
    await noteExternalRef(deps.sql, existing.attachmentId, externalRef);
    return {
      ok: true,
      status: 'unchanged',
      attachmentId: existing.attachmentId,
      objectKey: key.key,
      mediaType: verdict.mediaType,
      kind: verdict.kind,
      contentSha256,
      byteSize: input.bytes.length,
    };
  }

  // Preservation first, and a failure here is the end of it. See the header.
  try {
    await deps.store.put(key.key, { bytes: input.bytes, contentType: verdict.mediaType });
  } catch (error) {
    return {
      ok: false,
      reason: 'preservation_failed',
      detail: error instanceof Error ? error.name : 'unknown',
    };
  }

  if (existing !== null) {
    // The bytes moved, so any transcription of them describes a payload that is
    // gone. Clearing it re-queues the attachment rather than leaving the brain
    // holding a description of an old picture.
    await deps.sql`
      UPDATE attachment
         SET media_type = ${verdict.mediaType},
             byte_size = ${input.bytes.length},
             content_sha256 = ${contentSha256},
             external_ref = coalesce(external_ref, ${externalRef}),
             ocr_text = NULL,
             quarantined_at = ${quarantined ? new Date() : null}
       WHERE attachment_id = ${existing.attachmentId}::bigint
    `;
    return {
      ok: true,
      status: 'replaced',
      attachmentId: existing.attachmentId,
      objectKey: key.key,
      mediaType: verdict.mediaType,
      kind: verdict.kind,
      contentSha256,
      byteSize: input.bytes.length,
    };
  }

  const rows = (await deps.sql`
    INSERT INTO attachment (page_id, origin_context, subject_context, subject_confidence,
                            media_type, object_key, byte_size, content_sha256, external_ref,
                            quarantined_at)
    VALUES (${input.pageId ?? null}, ${origin}, ${input.subject?.context ?? null},
            ${input.subject?.confidence ?? null}, ${verdict.mediaType}, ${key.key},
            ${input.bytes.length}, ${contentSha256},
            ${externalRef.length === 0 ? null : externalRef},
            ${quarantined ? new Date() : null})
    RETURNING attachment_id::text AS attachment_id
  `) as Array<{ attachment_id: string }>;
  const attachmentId = rows[0]?.attachment_id;
  if (attachmentId === undefined) throw new Error('attachment insert returned no id');

  return {
    ok: true,
    status: 'stored',
    attachmentId,
    objectKey: key.key,
    mediaType: verdict.mediaType,
    kind: verdict.kind,
    contentSha256,
    byteSize: input.bytes.length,
  };
}
