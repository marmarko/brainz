/**
 * The harness for U21's media suite. Not a `*.test.ts` file.
 *
 * **It does not import `evals/`.** `test/consolidate/fixture.ts` has a scripted
 * transport already, but it seeds the eval corpus at module scope, so importing
 * it pulls a whole corpus into a suite that needs one screenshot. The duplicated
 * forty lines below are cheaper than that coupling, and they let this suite
 * script the `vision` op — which the consolidation fixture has no reason to.
 *
 * **A real tenant database, through the real applier.** The attachment row this
 * unit writes is governed by CHECK constraints and an origin-immutability
 * trigger that a hand-rolled table would not have. U3 reserved the columns; a
 * test against a subset of them proves nothing about the row the fleet writes.
 *
 * **The transport records every call, keyed by op.** That is the assertion
 * surface for the cheapest promise this unit makes: a PDF with a text layer
 * costs *no* `vision` call. Asserting on the output instead would pass just as
 * well if the model had been called and its answer thrown away.
 *
 * **The PDF builders are real PDFs, not strings that look like them.** One with
 * an uncompressed content stream, one Flate-compressed, one carrying nothing but
 * an image XObject — the scanned page. If the third one's fixture were merely
 * "a PDF with no text", the no-model-call test would pass for a parser that
 * always returns text and a parser that never does.
 */

import { deflateSync } from 'node:zlib';
import { SQL } from 'bun';

import {
  createBudget,
  createInMemorySpendMeter,
  createModelGateway,
  TransportError,
  type Budget,
  type InMemorySpendMeter,
  type ModelGateway,
  type ModelTransport,
  type TransportRequest,
  type TransportResponse,
} from '../../src/ai/gateway.ts';
import {
  createHostedKeyPool,
  createInMemoryProviderKeyBackend,
  createTenantProviderKeyStore,
} from '../../src/ai/keys.ts';
import { HOSTED_PROFILE, type ModelOp } from '../../src/ai/routing.ts';
import { fleetIdentity } from '../../src/control/secrets.ts';
import {
  createInMemoryCredentialMinter,
  createTenantStorage,
  type ObjectKey,
  type TenantStorage,
} from '../../src/control/storage.ts';
import type { StoredPayloadReader } from '../../src/core/media/accept.ts';
import {
  createInMemoryRawStore,
  type InMemoryRawStore,
  type RawObject,
} from '../../src/ingest/import/raw.ts';
import { lexicalVector } from '../core/write/fixture.ts';
import {
  connect,
  dropFixtureDatabase,
  provisionFixture,
  type SchemaFixture,
} from '../schema/fixture.ts';

export { lexicalVector };

export const TENANT = 'viewer';
export const CALLER = fleetIdentity(TENANT);
export const ORIGIN = 'personal:mail';

export function uncappedBudget(label = 'media'): Budget {
  return createBudget({ label, capMicroUsd: null });
}

export function cappedBudget(capMicroUsd: number, label = 'media'): Budget {
  return createBudget({ label, capMicroUsd });
}

// ---------------------------------------------------------------------------
// The transport.
// ---------------------------------------------------------------------------

export interface MediaTransport extends ModelTransport {
  readonly calls: readonly TransportRequest[];
  callsFor(op: ModelOp): readonly TransportRequest[];
}

export interface MediaTransportOptions {
  /** What the vision model answers. Called once per image. */
  readonly vision?: (request: TransportRequest, index: number) => string;
  /** Reject every call for this op, so a phase's refusal path can be observed. */
  readonly failOn?: ModelOp;
  readonly failWith?: Error;
  /** Output tokens each chat reply claims. Drives the metered cost. */
  readonly outputTokens?: number;
}

export function createMediaTransport(options: MediaTransportOptions = {}): MediaTransport {
  const calls: TransportRequest[] = [];
  const outputTokens = options.outputTokens ?? 24;
  let visionCalls = 0;

  return {
    id: 'media-fake',
    get calls() {
      return calls;
    },
    callsFor(op) {
      return calls.filter((call) => call.op === op);
    },
    invoke(request: TransportRequest): Promise<TransportResponse> {
      calls.push(request);

      if (options.failOn === request.op) {
        return Promise.reject(options.failWith ?? new TransportError('provider refused', 503));
      }

      if (request.input.kind === 'embedding') {
        const texts = request.input.texts;
        return Promise.resolve({
          output: { kind: 'embedding', vectors: texts.map((text) => lexicalVector(text)) },
          usage: { inputTokens: texts.reduce((sum, text) => sum + text.length, 0), outputTokens: 0 },
        });
      }
      if (request.input.kind === 'rerank') {
        return Promise.resolve({
          output: { kind: 'rerank', scores: request.input.candidates.map(() => 0) },
          usage: { inputTokens: 1, outputTokens: 0 },
        });
      }

      const index = visionCalls;
      if (request.op === 'vision') visionCalls += 1;
      let text: string;
      try {
        text = options.vision === undefined ? '' : options.vision(request, index);
      } catch (error) {
        // A script may refuse ONE call rather than the whole op. `failOn` is
        // per-op and cannot express "this image, and not the next one" — which
        // is the only shape that can tell a per-item skip from a phase stop, so
        // a loop that draws that line cannot be tested without it.
        return Promise.reject(error);
      }
      return Promise.resolve({
        output: { kind: 'chat', text },
        usage: { inputTokens: 1_200, outputTokens },
      });
    },
  };
}

export interface GatewayHarness {
  readonly gateway: ModelGateway;
  readonly transport: MediaTransport;
  readonly meter: InMemorySpendMeter;
}

export function createGateway(options: MediaTransportOptions = {}): GatewayHarness {
  const transport = createMediaTransport(options);
  const meter = createInMemorySpendMeter();
  const gateway = createModelGateway({
    profile: HOSTED_PROFILE,
    transport,
    meter,
    keys: {
      store: createTenantProviderKeyStore({ backend: createInMemoryProviderKeyBackend() }),
      hosted: createHostedKeyPool({
        openai: 'hosted-openai',
        google: 'hosted-google',
        cloudflare: 'hosted-cloudflare',
        'self-host': 'hosted-self-host',
      }),
    },
  });
  return { gateway, transport, meter };
}

// ---------------------------------------------------------------------------
// Storage.
// ---------------------------------------------------------------------------

export function createStorage(): TenantStorage {
  return createTenantStorage({
    minter: createInMemoryCredentialMinter({
      parentAccessKeyId: 'parent-key-id',
      parentSecretAccessKey: 'parent-secret',
    }),
  });
}

export interface PayloadStore {
  readonly store: InMemoryRawStore;
  readonly reader: StoredPayloadReader;
}

/**
 * The object store, plus the read port the OCR phase is given.
 *
 * The cast lives here rather than in `src/`: `ObjectKey` is a *derivation*
 * guarantee, and `test/control/accessor-boundary.test.ts` scans `src/**` for
 * exactly this cast because a source module that could mint one could mint a
 * key under someone else's prefix. A test may hold one — `provision.test.ts`
 * does — and the phase itself never sees a branded type at all.
 */
export function createPayloadStore(): PayloadStore {
  const store = createInMemoryRawStore();
  return {
    store,
    reader: { read: (objectKey: string): Promise<RawObject | null> => store.get(objectKey as ObjectKey) },
  };
}

/** A reader that has lost the object it was asked for. */
export const EMPTY_READER: StoredPayloadReader = { read: () => Promise.resolve(null) };

// ---------------------------------------------------------------------------
// The tenant.
// ---------------------------------------------------------------------------

export interface TenantFixture {
  readonly schema: SchemaFixture;
  readonly sql: SQL;
  close(): Promise<void>;
}

export async function createTenantFixture(slug: string): Promise<TenantFixture> {
  const schema = await provisionFixture(slug);
  const sql = connect(schema);
  return {
    schema,
    sql,
    async close() {
      await sql.close();
      await dropFixtureDatabase(schema);
    },
  };
}

export async function countRows(sql: SQL, table: string, where = 'true'): Promise<number> {
  const rows = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Payload fixtures.
// ---------------------------------------------------------------------------

/**
 * A PNG whose bytes are not text. Every byte class that a UTF-8 round trip
 * mangles is in here on purpose: a NUL, a lone 0xFF, and a byte pair that is
 * not a legal UTF-8 sequence. `String(bytes)` and back is the mistake this
 * fixture exists to catch, and it is invisible against ASCII test data.
 */
export function screenshotBytes(): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const body: number[] = [];
  for (let value = 0; value < 256; value += 1) body.push(value);
  body.push(0xff, 0xfe, 0x00, 0x80, 0xc0, 0xaf);
  return new Uint8Array([...signature, ...body]);
}

function pdfObject(number: number, body: string): string {
  return `${number} 0 obj\n${body}\nendobj\n`;
}

/**
 * A PDF carrying one content stream, optionally Flate-compressed.
 *
 * Assembled rather than fetched so the suite has no binary fixture to keep in
 * sync, and small enough to read: catalog, page tree, one page, one stream.
 */
export function pdfWithTextLayer(
  text: string,
  options: { readonly compress?: boolean } = {},
): Uint8Array {
  const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/([()\\])/g, '\\$1')}) Tj ET`;
  const raw = Buffer.from(content, 'latin1');
  const stream = options.compress === true ? deflateSync(raw) : raw;
  const filter = options.compress === true ? '/Filter /FlateDecode ' : '';

  const head =
    '%PDF-1.4\n' +
    pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>') +
    pdfObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>') +
    pdfObject(3, '<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>') +
    `4 0 obj\n<< ${filter}/Length ${stream.length} >>\nstream\n`;
  const tail = '\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';

  return new Uint8Array(
    Buffer.concat([Buffer.from(head, 'latin1'), stream, Buffer.from(tail, 'latin1')]),
  );
}

/**
 * A scanned page: one image XObject, no text operators anywhere.
 *
 * The image stream is Flate-compressed like a real one, so a parser that
 * inflates every stream it finds and reads whatever comes out has to deal with
 * bytes rather than with an obviously-empty file.
 */
export function scannedPdf(): Uint8Array {
  const pixels = Buffer.from(screenshotBytes());
  const stream = deflateSync(pixels);

  const head =
    '%PDF-1.4\n' +
    pdfObject(1, '<< /Type /Catalog /Pages 2 0 R >>') +
    pdfObject(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>') +
    pdfObject(3, '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> >>') +
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /Filter /FlateDecode /Length ${stream.length} >>\nstream\n`;
  const tail = '\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n';

  return new Uint8Array(
    Buffer.concat([Buffer.from(head, 'latin1'), stream, Buffer.from(tail, 'latin1')]),
  );
}
