/**
 * The transcription phase: what it costs, what it does not cost, and what it
 * leaves behind when it stops.
 *
 * Four properties, and every one of them passes trivially for a phase that never
 * runs its branch — which is why each fixture below is built to *provoke* the
 * branch and then asserted on the thing that would still be true if the branch
 * were missing:
 *
 *  1. **A screenshot becomes retrievable text.** Not "the phase returned a
 *     string": the transcript has to reach the same index the keyword arm reads,
 *     or "find the screenshot with the wifi password" fails with the phase
 *     reporting success.
 *  2. **A PDF with a text layer costs no `vision` call.** Asserted on the
 *     transport, never on the output. An output assertion passes just as well
 *     when the model was called and its answer discarded, which is the expensive
 *     way to be right.
 *  3. **Budget exhaustion queues, never loses.** The items that were not
 *     transcribed must still be pending afterwards, and the deterministic phases
 *     that ran before this one must still have their output.
 *  4. **An attachment that transcribes to nothing is not paid for twice.** The
 *     "attempted and produced nothing" state is the one piece of this design
 *     that is invisible: with only `ocr_text IS NULL` to read, an unreadable
 *     image is re-sent to the model on every cycle, forever, and nothing fails.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { HOSTED_PROFILE, IMAGE_INPUT_TOKENS, routeFor } from '../../src/ai/routing.ts';
import { acceptMedia, type AcceptMediaDeps } from '../../src/core/media/accept.ts';
import { runTranscribePhase } from '../../src/core/media/ocr-phase.ts';
import { runConsolidationCycle } from '../../src/worker/consolidate/cycle.ts';
import { estimateCycle, measureWorkload } from '../../src/worker/consolidate/estimate.ts';
import {
  CALLER,
  EMPTY_READER,
  ORIGIN,
  TENANT,
  cappedBudget,
  countRows,
  createGateway,
  createPayloadStore,
  createStorage,
  createTenantFixture,
  pdfWithTextLayer,
  scannedPdf,
  screenshotBytes,
  uncappedBudget,
  type PayloadStore,
  type TenantFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 120_000;

const WIFI = 'the guest wifi password is hunter2 and the network is called parsley';

let tenant: TenantFixture;

beforeAll(async () => {
  tenant = await createTenantFixture('mediaocr');
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await tenant?.close();
});

beforeEach(async () => {
  // Every guard below reads counts off the whole brain, so each starts empty.
  await tenant.sql`DELETE FROM attachment`;
  await tenant.sql`DELETE FROM fact`;
  await tenant.sql`DELETE FROM chunk`;
  await tenant.sql`DELETE FROM page`;
  await tenant.sql`DELETE FROM consolidation_checkpoint`;
  await tenant.sql`DELETE FROM consolidation_run`;
});

function acceptDeps(payloads: PayloadStore): AcceptMediaDeps {
  return { sql: tenant.sql, storage: createStorage(), store: payloads.store };
}

async function accept(
  payloads: PayloadStore,
  input: { readonly mediaType: string; readonly bytes: Uint8Array; readonly externalId: string },
): Promise<string> {
  const outcome = await acceptMedia(acceptDeps(payloads), {
    tenantId: TENANT,
    caller: CALLER,
    originContext: ORIGIN,
    ...input,
  });
  if (!outcome.ok) throw new Error(`accept failed: ${outcome.reason}`);
  return outcome.attachmentId;
}

async function ocrTextOf(attachmentId: string): Promise<string | null> {
  const rows = (await tenant.sql`
    SELECT ocr_text FROM attachment WHERE attachment_id = ${attachmentId}::bigint
  `) as Array<{ ocr_text: string | null }>;
  return rows[0]?.ocr_text ?? null;
}

/** What the keyword arm would find: the generated tsvector, queried its way. */
async function retrievableChunks(term: string): Promise<number> {
  const rows = (await tenant.sql`
    SELECT count(*)::int AS n
      FROM chunk
     WHERE deleted_at IS NULL AND quarantined_at IS NULL
       AND content_tsv @@ websearch_to_tsquery('simple', ${term})
  `) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

describe('a screenshot becomes text the ordinary stack can find', () => {
  test(
    'the transcript is chunked, indexed and attributed to the attachment',
    async () => {
      const payloads = createPayloadStore();
      const attachmentId = await accept(payloads, {
        mediaType: 'image/png',
        bytes: screenshotBytes(),
        externalId: 'drive:wifi',
      });
      const harness = createGateway({ vision: () => WIFI });

      const outcome = await runTranscribePhase({
        sql: tenant.sql,
        gateway: harness.gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget(),
        runId: '1',
        now: new Date(),
        payloads: payloads.reader,
      });

      expect(outcome.stopped).toBeNull();
      expect(outcome.items).toBe(1);
      expect(outcome.applied).toBe(1);
      expect(outcome.modelCalls).toBe(1);

      // The retrieval claim, on the index the keyword arm reads.
      expect(await retrievableChunks('hunter2')).toBeGreaterThan(0);

      const pages = (await tenant.sql`
        SELECT source_type, origin_context, derivation
          FROM page WHERE external_ref = ${`attachment:${attachmentId}`}
      `) as Array<{ source_type: string; origin_context: string; derivation: string }>;
      expect(pages.length).toBe(1);
      // R15: the transcript inherits the attachment's credential-derived origin,
      // never a new one. A transcript behind a different fence is a leak one
      // derivation removed.
      expect(pages[0]?.origin_context).toBe(ORIGIN);
      expect(pages[0]?.source_type).toBe('file');

      expect(await ocrTextOf(attachmentId)).toBe(WIFI);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the image itself goes to the vision op, and the bytes go with it',
    async () => {
      const payloads = createPayloadStore();
      const bytes = screenshotBytes();
      await accept(payloads, { mediaType: 'image/png', bytes, externalId: 'drive:bytes' });
      const harness = createGateway({ vision: () => WIFI });

      await runTranscribePhase({
        sql: tenant.sql,
        gateway: harness.gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget(),
        runId: '1',
        now: new Date(),
        payloads: payloads.reader,
      });

      const calls = harness.transport.callsFor('vision');
      expect(calls.length).toBe(1);
      const input = calls[0]?.input;
      if (input?.kind !== 'chat') throw new Error('the vision op takes a chat input');
      expect(input.images?.length).toBe(1);
      expect(input.images?.[0]?.mediaType).toBe('image/png');
      expect([...(input.images?.[0]?.bytes ?? [])]).toEqual([...bytes]);
      // KTD13: the phase names an op and never a model — so the id on the wire
      // is whatever the vision row says, read from the table rather than
      // matched against a substring. (It used to assert the id contained
      // "vision", which passed only because the old seat's name happened to.)
      expect(calls[0]?.modelId).toBe(routeFor(HOSTED_PROFILE, 'vision').id);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    're-running the phase over a transcribed attachment costs nothing',
    async () => {
      const payloads = createPayloadStore();
      await accept(payloads, {
        mediaType: 'image/png',
        bytes: screenshotBytes(),
        externalId: 'drive:once',
      });
      const harness = createGateway({ vision: () => WIFI });
      const deps = {
        sql: tenant.sql,
        gateway: harness.gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget(),
        runId: '1',
        now: new Date(),
        payloads: payloads.reader,
      };

      await runTranscribePhase(deps);
      const second = await runTranscribePhase(deps);

      expect(second.items).toBe(0);
      expect(harness.transport.callsFor('vision').length).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a quarantined attachment is never sent to a model',
    async () => {
      const payloads = createPayloadStore();
      const outcome = await acceptMedia(acceptDeps(payloads), {
        tenantId: TENANT,
        caller: CALLER,
        originContext: ORIGIN,
        mediaType: 'image/png',
        bytes: screenshotBytes(),
        externalId: 'mail:tracking-pixel',
        quarantine: 'bulk',
      });
      if (!outcome.ok) throw new Error('accept failed');
      const harness = createGateway({ vision: () => WIFI });

      const result = await runTranscribePhase({
        sql: tenant.sql,
        gateway: harness.gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget(),
        runId: '1',
        now: new Date(),
        payloads: payloads.reader,
      });

      expect(result.items).toBe(0);
      expect(harness.transport.callsFor('vision').length).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the cheap path is taken when it exists', () => {
  test(
    'a PDF with a text layer makes no vision call at all',
    async () => {
      const payloads = createPayloadStore();
      const attachmentId = await accept(payloads, {
        mediaType: 'application/pdf',
        bytes: pdfWithTextLayer(WIFI),
        externalId: 'mail:router-manual.pdf',
      });
      const harness = createGateway({
        vision: () => {
          throw new Error('the text-layer path must not reach a model');
        },
      });

      const outcome = await runTranscribePhase({
        sql: tenant.sql,
        gateway: harness.gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget(),
        runId: '1',
        now: new Date(),
        payloads: payloads.reader,
      });

      // The assertion that matters is on the transport, not on the text.
      expect(harness.transport.callsFor('vision')).toEqual([]);
      expect(outcome.modelCalls).toBe(0);
      expect(outcome.applied).toBe(1);
      expect(await ocrTextOf(attachmentId)).toContain('hunter2');
      expect(await retrievableChunks('hunter2')).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a scanned PDF does reach the model — so the fixture above proves something',
    async () => {
      const payloads = createPayloadStore();
      await accept(payloads, {
        mediaType: 'application/pdf',
        bytes: scannedPdf(),
        externalId: 'mail:scan.pdf',
      });
      const harness = createGateway({ vision: () => WIFI });

      const outcome = await runTranscribePhase({
        sql: tenant.sql,
        gateway: harness.gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget(),
        runId: '1',
        now: new Date(),
        payloads: payloads.reader,
      });

      expect(harness.transport.callsFor('vision').length).toBe(1);
      expect(outcome.modelCalls).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('what a stop leaves behind', () => {
  test(
    'the budget runs out mid-phase: what was transcribed is kept, the rest stays queued',
    async () => {
      const payloads = createPayloadStore();
      const ids: string[] = [];
      for (const name of ['a', 'b', 'c']) {
        ids.push(
          await accept(payloads, {
            mediaType: 'image/png',
            bytes: new Uint8Array([...screenshotBytes(), name.charCodeAt(0)]),
            externalId: `drive:${name}`,
          }),
        );
      }
      const harness = createGateway({ vision: (_request, index) => `${WIFI} number ${index}` });

      // Sized to admit the first image's call and refuse the second. The number
      // is derived from what the gateway reserves rather than guessed: the first
      // call's reservation is the whole cap.
      const budget = cappedBudget(1);
      const outcome = await runTranscribePhase({
        sql: tenant.sql,
        gateway: harness.gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget,
        runId: '1',
        now: new Date(),
        payloads: payloads.reader,
      });

      expect(outcome.stopped).toBe('budget_exhausted');
      expect(outcome.items).toBe(3);
      // Queued, not lost: every untranscribed attachment is still pending, so
      // the next cycle picks it up exactly where this one gave up.
      const pending = await countRows(
        tenant.sql,
        'attachment',
        'ocr_text IS NULL AND deleted_at IS NULL AND quarantined_at IS NULL',
      );
      expect(pending).toBe(3 - outcome.applied);
      expect(pending).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a payload that is not there stops the phase instead of marking the row done',
    async () => {
      const payloads = createPayloadStore();
      const attachmentId = await accept(payloads, {
        mediaType: 'image/png',
        bytes: screenshotBytes(),
        externalId: 'drive:vanished',
      });
      const harness = createGateway({ vision: () => WIFI });

      const outcome = await runTranscribePhase({
        sql: tenant.sql,
        gateway: harness.gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget(),
        runId: '1',
        now: new Date(),
        payloads: EMPTY_READER,
      });

      expect(outcome.stopped).toBe('payload_unavailable');
      expect(harness.transport.callsFor('vision')).toEqual([]);
      // Still pending. Marking it done would retire an attachment nobody ever
      // read, and the raw payload is the thing R23 promised to keep.
      expect(await ocrTextOf(attachmentId)).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a failed write leaves the attachment queued rather than marked transcribed',
    async () => {
      const payloads = createPayloadStore();
      const attachmentId = await accept(payloads, {
        mediaType: 'image/png',
        bytes: screenshotBytes(),
        externalId: 'drive:unwritable',
      });
      // The vision call succeeds and the write path then refuses the document.
      // The ordering under test is page-first: if `ocr_text` were written before
      // the page, this attachment would now be marked done with nothing to show
      // for it, and no later cycle would ever look at it again.
      const harness = createGateway({ vision: () => WIFI });

      const settings = (await tenant.sql`
        SELECT fts_language, taxonomy_version FROM tenant_setting
      `) as Array<{ fts_language: string; taxonomy_version: number }>;
      const saved = settings[0];
      if (saved === undefined) throw new Error('the fixture has no tenant settings to remove');
      await tenant.sql`DELETE FROM tenant_setting`;

      try {
        const outcome = await runTranscribePhase({
          sql: tenant.sql,
          gateway: harness.gateway,
          tenantId: TENANT,
          caller: CALLER,
          budget: uncappedBudget(),
          runId: '1',
          now: new Date(),
          payloads: payloads.reader,
        });

        // The model was called and paid for; the write did not land.
        expect(harness.transport.callsFor('vision').length).toBe(1);
        expect(outcome.stopped).not.toBeNull();
        expect(outcome.applied).toBe(0);
        expect(await ocrTextOf(attachmentId)).toBeNull();
        expect(await countRows(tenant.sql, 'page', `external_ref = 'attachment:${attachmentId}'`)).toBe(0);
      } finally {
        await tenant.sql`
          INSERT INTO tenant_setting (fts_language, taxonomy_version)
          VALUES (${saved.fts_language}, ${saved.taxonomy_version})
        `;
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an image that transcribes to nothing is not sent to the model a second time',
    async () => {
      const payloads = createPayloadStore();
      const attachmentId = await accept(payloads, {
        mediaType: 'image/png',
        bytes: screenshotBytes(),
        externalId: 'drive:photograph-of-a-cat',
      });
      const harness = createGateway({ vision: () => '   ' });
      const deps = {
        sql: tenant.sql,
        gateway: harness.gateway,
        tenantId: TENANT,
        caller: CALLER,
        budget: uncappedBudget(),
        runId: '1',
        now: new Date(),
        payloads: payloads.reader,
      };

      const first = await runTranscribePhase(deps);
      expect(first.logged).toBe(1);
      expect(first.applied).toBe(0);

      const second = await runTranscribePhase(deps);
      expect(second.items).toBe(0);
      // One call, not two. Without a recorded "attempted and produced nothing",
      // this attachment is a standing charge on every cycle for the life of the
      // brain.
      expect(harness.transport.callsFor('vision').length).toBe(1);
      expect(await ocrTextOf(attachmentId)).toBe('');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the estimate knows there is work', () => {
  test(
    'the workload counts exactly what the phase would queue',
    async () => {
      const payloads = createPayloadStore();
      await accept(payloads, {
        mediaType: 'image/png',
        bytes: screenshotBytes(),
        externalId: 'estimate:pending',
      });

      const read = await accept(payloads, {
        mediaType: 'image/png',
        bytes: new Uint8Array([...screenshotBytes(), 1]),
        externalId: 'estimate:already-read',
      });
      await tenant.sql`
        UPDATE attachment SET ocr_text = 'done' WHERE attachment_id = ${read}::bigint
      `;

      const junk = await acceptMedia(acceptDeps(payloads), {
        tenantId: TENANT,
        caller: CALLER,
        originContext: ORIGIN,
        mediaType: 'image/png',
        bytes: new Uint8Array([...screenshotBytes(), 2]),
        externalId: 'estimate:junk',
        quarantine: 'bulk',
      });
      if (!junk.ok) throw new Error('accept failed');

      const workload = await measureWorkload(tenant.sql, { batch: 100 });
      // One pending, and only one. A workload that counted the transcribed or
      // the quarantined one would budget for calls the phase is forbidden to
      // make — and the cap would look mysteriously generous rather than wrong.
      expect(workload.transcribe?.items).toBe(1);
      expect(workload.transcribe?.inputTokensPerItem).toBeGreaterThan(IMAGE_INPUT_TOKENS);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a brain with pending attachments budgets more for transcription than an empty one',
    async () => {
      const empty = estimateCycle({
        profile: HOSTED_PROFILE,
        workload: await measureWorkload(tenant.sql, { batch: 100 }),
      });

      const payloads = createPayloadStore();
      await accept(payloads, {
        mediaType: 'image/png',
        bytes: screenshotBytes(),
        externalId: 'estimate:budgeted',
      });

      const loaded = estimateCycle({
        profile: HOSTED_PROFILE,
        workload: await measureWorkload(tenant.sql, { batch: 100 }),
      });

      // Without this, a phase whose workload is never counted gets a cap of
      // zero, refuses its first call, and reports `budget_exhausted` — which
      // looks exactly like a tenant that ran out of money.
      expect(loaded.perPhase.transcribe).toBeGreaterThan(empty.perPhase.transcribe);
      expect(empty.perPhase.transcribe).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the phase inside the cycle', () => {
  test(
    'truncation inside transcription keeps the deterministic phases output and queues the rest',
    async () => {
      const payloads = createPayloadStore();
      for (const name of ['a', 'b', 'c']) {
        await accept(payloads, {
          mediaType: 'image/png',
          bytes: new Uint8Array([...screenshotBytes(), name.charCodeAt(0)]),
          externalId: `cycle:${name}`,
        });
      }
      const harness = createGateway({ vision: (_request, index) => `${WIFI} number ${index}` });

      const result = await runConsolidationCycle(
        {
          sql: tenant.sql,
          gateway: harness.gateway,
          tenantId: TENANT,
          caller: CALLER,
          payloads: payloads.reader,
        },
        {
          trigger: 'time_ceiling',
          tier: 'paid',
          now: new Date(),
          capMicroUsd: 1,
        },
      );

      expect(result.dreamt).toBe(false);
      expect(result.stopReason).toBe('budget_exhausted');

      // Every deterministic phase ran and is checkpointed. That is "earlier
      // phases' output intact" stated as the thing the next cycle reads.
      const deterministic = result.phases.filter((phase) => phase.tier === 'deterministic');
      expect(deterministic.length).toBeGreaterThan(0);
      expect(deterministic.every((phase) => phase.ran)).toBe(true);

      const transcribe = result.phases.find((phase) => phase.phase === 'transcribe');
      expect(transcribe?.stopped).toBe('budget_exhausted');

      // Nothing after transcription was reached, and nothing before it was lost.
      const pending = await countRows(
        tenant.sql,
        'attachment',
        'ocr_text IS NULL AND deleted_at IS NULL AND quarantined_at IS NULL',
      );
      expect(pending).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the free tier transcribes nothing, and pays for nothing',
    async () => {
      const payloads = createPayloadStore();
      const attachmentId = await accept(payloads, {
        mediaType: 'image/png',
        bytes: screenshotBytes(),
        externalId: 'free:tier',
      });
      const harness = createGateway({ vision: () => WIFI });

      const result = await runConsolidationCycle(
        {
          sql: tenant.sql,
          gateway: harness.gateway,
          tenantId: TENANT,
          caller: CALLER,
          payloads: payloads.reader,
        },
        { trigger: 'time_ceiling', tier: 'free', now: new Date() },
      );

      expect(result.stopReason).toBe('free_tier');
      expect(harness.transport.callsFor('vision')).toEqual([]);
      // Not lost: a tenant that upgrades finds its screenshots still queued.
      expect(await ocrTextOf(attachmentId)).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});
