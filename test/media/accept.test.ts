/**
 * Acceptance, and the one thing acceptance is not.
 *
 * U21 approach step 1: "Drive files, mail attachments, and folder-import media
 * are stored as raw payloads under the tenant prefix with their content type
 * recorded. Acceptance is not extraction — nothing is transcribed on the write
 * path." Both halves are asserted here, and the second one is the one that goes
 * wrong quietly: a write path that transcribed would still return a receipt, and
 * only the bill would say so.
 *
 * The round-trip guard is byte-for-byte against a payload whose bytes are not
 * text. R23's whole preservation promise is that a better extractor can
 * re-derive later, and a payload that survived as *mostly* the same bytes is a
 * payload nothing can re-derive from — the first symptom is a corrupt PNG a year
 * from now, on a fleet whose originals are gone.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  DECLINED_MEDIA_FAMILIES,
  MEDIA_COLLECTION,
  SUPPORTED_MEDIA_TYPES,
  acceptMedia,
  classifyMedia,
  mediaPolicyForRemember,
  unsupportedMediaMessage,
  type AcceptMediaDeps,
} from '../../src/core/media/accept.ts';
import {
  CALLER,
  ORIGIN,
  TENANT,
  countRows,
  createPayloadStore,
  createStorage,
  createTenantFixture,
  pdfWithTextLayer,
  screenshotBytes,
  type PayloadStore,
  type TenantFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;

let tenant: TenantFixture;

beforeAll(async () => {
  tenant = await createTenantFixture('mediaaccept');
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await tenant?.close();
});

function depsWith(payloads: PayloadStore): AcceptMediaDeps {
  return { sql: tenant.sql, storage: createStorage(), store: payloads.store };
}

describe('what the brain takes', () => {
  test('a screenshot and a PDF are both supported, and each says which kind it is', () => {
    const png = classifyMedia('image/png');
    expect(png.ok).toBe(true);
    if (png.ok) expect(png.kind).toBe('image');

    const pdf = classifyMedia('application/pdf');
    expect(pdf.ok).toBe(true);
    if (pdf.ok) expect(pdf.kind).toBe('pdf');
  });

  test('the content type is read past its parameters and its case', () => {
    const verdict = classifyMedia('  IMAGE/PNG; charset=binary  ');
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.mediaType).toBe('image/png');
  });

  test('a voice memo is refused, and the refusal names both sides', () => {
    const verdict = classifyMedia('audio/m4a');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('a voice memo must not classify as supported');

    expect(verdict.reason).toBe('unsupported_media_type');
    expect(verdict.mediaType).toBe('audio/m4a');
    // Typed, not prose: a caller reads the set off the error rather than
    // parsing a sentence.
    expect(verdict.supported).toEqual(SUPPORTED_MEDIA_TYPES);
    expect(verdict.declined).toEqual(DECLINED_MEDIA_FAMILIES);

    const message = unsupportedMediaMessage(verdict);
    expect(message).toContain('audio/m4a');
    expect(message).toContain('image/png');
    expect(message).toContain('application/pdf');
  });

  test('a video and an unrecognised binary are refused the same way', () => {
    for (const mediaType of ['video/mp4', 'application/octet-stream', 'application/x-nonsense']) {
      const verdict = classifyMedia(mediaType);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.supported.length).toBeGreaterThan(0);
    }
  });

  test('an empty content type is refused rather than guessed', () => {
    expect(classifyMedia('').ok).toBe(false);
    expect(classifyMedia('   ').ok).toBe(false);
  });
});

describe('remember has a stated answer for every one of them', () => {
  test('a voice memo gets a typed refusal naming the supported set', () => {
    const answer = mediaPolicyForRemember('audio/m4a');
    expect(answer.reason).toBe('unsupported_media_type');
    expect(answer.transcribable).toBe(false);
    expect(answer.acceptedVia).toBeNull();
    expect(answer.supported).toEqual(SUPPORTED_MEDIA_TYPES);
    expect(answer.declined).toEqual(DECLINED_MEDIA_FAMILIES);
  });

  test('a screenshot is refused too — but the refusal names the path that takes it', () => {
    const answer = mediaPolicyForRemember('image/png');
    expect(answer.transcribable).toBe(true);
    // The distinction is the whole point of a *stated* policy: "we cannot read
    // this at all" and "we read this, through a different door" are different
    // answers, and collapsing them sends a user looking for a feature that is
    // already there.
    expect(answer.acceptedVia).toBe('connector_or_import');
  });
});

describe('accept and preserve', () => {
  test('the payload round-trips byte for byte', async () => {
    const payloads = createPayloadStore();
    const bytes = screenshotBytes();

    const outcome = await acceptMedia(depsWith(payloads), {
      tenantId: TENANT,
      caller: CALLER,
      originContext: ORIGIN,
      mediaType: 'image/png',
      bytes,
      externalId: 'drive:wifi-screenshot',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(`accept failed: ${outcome.reason}`);

    const stored = await payloads.reader.read(outcome.objectKey);
    expect(stored).not.toBeNull();
    expect(stored?.contentType).toBe('image/png');
    expect([...(stored?.bytes ?? [])]).toEqual([...bytes]);
  });

  test('the key comes from the accessor and sits under this tenant, in the media collection', async () => {
    const payloads = createPayloadStore();
    const outcome = await acceptMedia(depsWith(payloads), {
      tenantId: TENANT,
      caller: CALLER,
      originContext: ORIGIN,
      mediaType: 'image/png',
      bytes: screenshotBytes(),
      externalId: 'drive:keyed',
    });
    if (!outcome.ok) throw new Error(`accept failed: ${outcome.reason}`);

    expect(outcome.objectKey).toContain(`/${TENANT}/`);
    expect(outcome.objectKey).toContain(`/${MEDIA_COLLECTION}/`);
    // Hashed, never the provider's own string: `keyForUntrusted` is the accessor
    // method for exactly this, and a key carrying the raw id would carry
    // whatever the provider put in it.
    expect(outcome.objectKey).not.toContain('drive:keyed');
  });

  test('nothing is transcribed on the write path', async () => {
    const payloads = createPayloadStore();
    const outcome = await acceptMedia(depsWith(payloads), {
      tenantId: TENANT,
      caller: CALLER,
      originContext: ORIGIN,
      mediaType: 'application/pdf',
      // A text layer this very payload carries. If acceptance ever extracts,
      // this is the fixture that shows it: the text is right there for the
      // taking, and the row must still come back untranscribed.
      bytes: pdfWithTextLayer('the guest network password is hunter2'),
      externalId: 'mail:invoice.pdf',
    });
    if (!outcome.ok) throw new Error(`accept failed: ${outcome.reason}`);

    const rows = (await tenant.sql`
      SELECT ocr_text FROM attachment WHERE attachment_id = ${outcome.attachmentId}::bigint
    `) as Array<{ ocr_text: string | null }>;
    expect(rows[0]?.ocr_text).toBeNull();

    // And no page was written either: an attachment is not a document until
    // something reads it.
    expect(await countRows(tenant.sql, 'page', `external_ref = 'attachment:${outcome.attachmentId}'`))
      .toBe(0);
  });

  test('the row records the content type, the size and the digest', async () => {
    const payloads = createPayloadStore();
    const bytes = screenshotBytes();
    const outcome = await acceptMedia(depsWith(payloads), {
      tenantId: TENANT,
      caller: CALLER,
      originContext: ORIGIN,
      mediaType: 'image/png',
      bytes,
      externalId: 'drive:recorded',
    });
    if (!outcome.ok) throw new Error(`accept failed: ${outcome.reason}`);

    const rows = (await tenant.sql`
      SELECT media_type, byte_size::int AS byte_size, content_sha256, origin_context, object_key
        FROM attachment WHERE attachment_id = ${outcome.attachmentId}::bigint
    `) as Array<{
      media_type: string;
      byte_size: number;
      content_sha256: string;
      origin_context: string;
      object_key: string;
    }>;
    const row = rows[0];
    expect(row?.media_type).toBe('image/png');
    expect(row?.byte_size).toBe(bytes.length);
    expect(row?.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.origin_context).toBe(ORIGIN);
    expect(row?.object_key).toBe(outcome.objectKey);
  });

  test('a second pull of the same unchanged object writes nothing twice', async () => {
    const payloads = createPayloadStore();
    const deps = depsWith(payloads);
    const input = {
      tenantId: TENANT,
      caller: CALLER,
      originContext: ORIGIN,
      mediaType: 'image/png',
      bytes: screenshotBytes(),
      externalId: 'drive:polled-every-ten-minutes',
    };

    const first = await acceptMedia(deps, input);
    const second = await acceptMedia(deps, input);
    if (!first.ok || !second.ok) throw new Error('accept failed');

    expect(first.status).toBe('stored');
    expect(second.status).toBe('unchanged');
    expect(second.attachmentId).toBe(first.attachmentId);
    expect(
      await countRows(tenant.sql, 'attachment', `object_key = '${first.objectKey}'`),
    ).toBe(1);
  });

  test('a changed payload replaces the bytes and re-queues the transcription', async () => {
    const payloads = createPayloadStore();
    const deps = depsWith(payloads);
    const externalId = 'drive:edited';

    const first = await acceptMedia(deps, {
      tenantId: TENANT,
      caller: CALLER,
      originContext: ORIGIN,
      mediaType: 'image/png',
      bytes: screenshotBytes(),
      externalId,
    });
    if (!first.ok) throw new Error('accept failed');

    // Pretend the cycle already read it.
    await tenant.sql`
      UPDATE attachment SET ocr_text = 'the old picture' WHERE attachment_id = ${first.attachmentId}::bigint
    `;

    const changed = new Uint8Array([...screenshotBytes(), 0x2a]);
    const second = await acceptMedia(deps, {
      tenantId: TENANT,
      caller: CALLER,
      originContext: ORIGIN,
      mediaType: 'image/png',
      bytes: changed,
      externalId,
    });
    if (!second.ok) throw new Error('accept failed');

    expect(second.status).toBe('replaced');
    expect(second.attachmentId).toBe(first.attachmentId);

    const rows = (await tenant.sql`
      SELECT ocr_text, byte_size::int AS byte_size
        FROM attachment WHERE attachment_id = ${first.attachmentId}::bigint
    `) as Array<{ ocr_text: string | null; byte_size: number }>;
    // Stale transcription cleared: the old text describes bytes that are gone.
    expect(rows[0]?.ocr_text).toBeNull();
    expect(rows[0]?.byte_size).toBe(changed.length);
    expect([...((await payloads.reader.read(second.objectKey))?.bytes ?? [])]).toEqual([...changed]);
  });

  test('an unsupported payload is refused before anything is stored', async () => {
    const payloads = createPayloadStore();
    const outcome = await acceptMedia(depsWith(payloads), {
      tenantId: TENANT,
      caller: CALLER,
      originContext: ORIGIN,
      mediaType: 'audio/m4a',
      bytes: new Uint8Array([1, 2, 3]),
      externalId: 'mail:voice-memo',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('a voice memo must not be accepted');
    expect(outcome.reason).toBe('unsupported_media_type');
    expect(outcome.media?.supported).toEqual(SUPPORTED_MEDIA_TYPES);
    expect(payloads.store.keys).toEqual([]);
  });

  test('a failed preservation stops the acceptance, and writes no row', async () => {
    const payloads = createPayloadStore();
    payloads.store.failNextPut(new Error('object store unavailable'));

    const before = await countRows(tenant.sql, 'attachment');
    const outcome = await acceptMedia(depsWith(payloads), {
      tenantId: TENANT,
      caller: CALLER,
      originContext: ORIGIN,
      mediaType: 'image/png',
      bytes: screenshotBytes(),
      externalId: 'drive:unpreservable',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('an unpreserved payload must not be accepted');
    expect(outcome.reason).toBe('preservation_failed');
    // A row pointing at an object that is not there is a transcription the
    // cycle will queue, pay a phase stop for, and never resolve.
    expect(await countRows(tenant.sql, 'attachment')).toBe(before);
  });

  test('a caller outside its own tenant gets nothing at all', async () => {
    const payloads = createPayloadStore();
    const outcome = await acceptMedia(depsWith(payloads), {
      tenantId: TENANT,
      caller: { kind: 'fleet', tenantId: 'somebody-else' },
      originContext: ORIGIN,
      mediaType: 'image/png',
      bytes: screenshotBytes(),
      externalId: 'drive:not-yours',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('a cross-tenant accept must be refused');
    expect(outcome.reason).toBe('key_denied');
    expect(payloads.store.keys).toEqual([]);
  });

  test('a junk-gated attachment is stored and quarantined, so it costs no model call', async () => {
    const payloads = createPayloadStore();
    const outcome = await acceptMedia(depsWith(payloads), {
      tenantId: TENANT,
      caller: CALLER,
      originContext: ORIGIN,
      mediaType: 'image/png',
      bytes: screenshotBytes(),
      externalId: 'mail:tracking-pixel',
      quarantine: 'bulk',
    });
    if (!outcome.ok) throw new Error('accept failed');

    const rows = (await tenant.sql`
      SELECT quarantined_at FROM attachment WHERE attachment_id = ${outcome.attachmentId}::bigint
    `) as Array<{ quarantined_at: Date | null }>;
    expect(rows[0]?.quarantined_at).not.toBeNull();
  });
});
