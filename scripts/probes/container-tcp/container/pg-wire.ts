/**
 * The Postgres v3 frontend/backend protocol, transport-agnostic.
 *
 * This file knows nothing about sockets. It is handed a `WireTransport` — a
 * duplex byte channel — and speaks Postgres over it. That indirection is the
 * experiment's design: the SAME protocol code runs over a raw TLS socket on
 * 5432 and over a WebSocket on 443, so a difference in outcome is a difference
 * in transport and cannot be a difference in client behaviour.
 *
 * Only the simple query protocol ('Q') is implemented. That is sufficient and
 * deliberate — see `battery.ts` for why SQL-level PREPARE/EXECUTE is the
 * right-sized proof of the property KTD2 needs.
 */

import { ScramError, startScram, verifyServerSignature } from './scram.ts';

export interface WireTransport {
  /** For the report: `tcp+tls:5432` or `wss:443`. */
  readonly name: string;
  write(bytes: Uint8Array): void;
  close(): void;
  onData(cb: (chunk: Uint8Array) => void): void;
  /** Called once when the peer closes or errors. */
  onClose(cb: (reason: string) => void): void;
}

export interface QueryResult {
  fields: string[];
  rows: (string | null)[][];
  commandTags: string[];
  notices: string[];
}

/** Anything that can answer SQL. Implemented by `PgSession` and by the HTTP one-shot client. */
export interface SqlChannel {
  readonly name: string;
  query(sql: string): Promise<QueryResult>;
}

export class PgProtocolError extends Error {
  constructor(
    message: string,
    readonly sqlState: string | null = null,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------------- */
/* Byte helpers                                                               */
/* ------------------------------------------------------------------------- */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function int32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, false);
  return out;
}

function cstring(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes, 0);
  return out;
}

/** A frontend message: one type byte, then a self-inclusive int32 length. */
function frame(type: string, payload: Uint8Array): Uint8Array {
  return concat([encoder.encode(type), int32(payload.length + 4), payload]);
}

/** The startup and SSLRequest messages are the only ones with no type byte. */
function untypedFrame(payload: Uint8Array): Uint8Array {
  return concat([int32(payload.length + 4), payload]);
}

export const SSL_REQUEST = untypedFrame(int32(80877103));

export function buildStartup(params: Readonly<Record<string, string>>): Uint8Array {
  const parts: Uint8Array[] = [int32(196608)]; // protocol 3.0
  for (const [key, value] of Object.entries(params)) {
    parts.push(cstring(key), cstring(value));
  }
  parts.push(new Uint8Array([0]));
  return untypedFrame(concat(parts));
}

/* ------------------------------------------------------------------------- */
/* Backend message parsing                                                    */
/* ------------------------------------------------------------------------- */

interface BackendMessage {
  type: string;
  body: Uint8Array;
}

function readCString(body: Uint8Array, offset: number): { value: string; next: number } {
  let end = offset;
  while (end < body.length && body[end] !== 0) end++;
  return { value: decoder.decode(body.subarray(offset, end)), next: end + 1 };
}

interface ErrorFields {
  severity: string;
  code: string;
  message: string;
}

function parseErrorResponse(body: Uint8Array): ErrorFields {
  const out: ErrorFields = { severity: 'ERROR', code: '', message: '' };
  let offset = 0;
  while (offset < body.length && body[offset] !== 0) {
    const field = String.fromCharCode(body[offset] ?? 0);
    const read = readCString(body, offset + 1);
    if (field === 'S') out.severity = read.value;
    else if (field === 'C') out.code = read.value;
    else if (field === 'M') out.message = read.value;
    offset = read.next;
  }
  return out;
}

function parseRowDescription(body: Uint8Array): string[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const count = view.getInt16(0, false);
  const names: string[] = [];
  let offset = 2;
  for (let i = 0; i < count; i++) {
    const read = readCString(body, offset);
    names.push(read.value);
    offset = read.next + 18; // tableOid(4) attnum(2) typeOid(4) typlen(2) typmod(4) format(2)
  }
  return names;
}

function parseDataRow(body: Uint8Array): (string | null)[] {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const count = view.getInt16(0, false);
  const cells: (string | null)[] = [];
  let offset = 2;
  for (let i = 0; i < count; i++) {
    const length = view.getInt32(offset, false);
    offset += 4;
    if (length === -1) {
      cells.push(null);
    } else {
      cells.push(decoder.decode(body.subarray(offset, offset + length)));
      offset += length;
    }
  }
  return cells;
}

/* ------------------------------------------------------------------------- */
/* The session                                                                */
/* ------------------------------------------------------------------------- */

export interface PgConnectParams {
  user: string;
  password: string;
  database: string;
  /** Extra startup parameters, e.g. Neon's `options=endpoint%3D...`. */
  extra?: Readonly<Record<string, string>>;
  applicationName: string;
}

/**
 * One Postgres session over one byte channel.
 *
 * Messages are pulled, not pushed: `next()` awaits the next backend message
 * with its own deadline. Filtered egress usually presents as a silent SYN drop
 * rather than a refusal, so every wait in this probe has to be bounded or the
 * whole run hangs and reports nothing.
 */
export class PgSession implements SqlChannel {
  readonly name: string;

  private buffer: Uint8Array = new Uint8Array(0);
  private readonly queue: BackendMessage[] = [];
  private waiter: ((message: BackendMessage) => void) | null = null;
  private rejecter: ((error: Error) => void) | null = null;
  private closed: Error | null = null;
  /** Server-sent settings (server_version, ...) — useful evidence in the report. */
  readonly parameters = new Map<string, string>();
  private backendPid: number | null = null;

  constructor(private readonly transport: WireTransport) {
    this.name = transport.name;
    transport.onData((chunk) => this.ingest(chunk));
    transport.onClose((reason) => this.fail(new PgProtocolError(`transport closed: ${reason}`)));
  }

  get pid(): number | null {
    return this.backendPid;
  }

  private fail(error: Error): void {
    this.closed ??= error;
    const reject = this.rejecter;
    this.waiter = null;
    this.rejecter = null;
    if (reject) reject(error);
  }

  private ingest(chunk: Uint8Array): void {
    this.buffer = concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 5) return;
      const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, this.buffer.byteLength);
      const length = view.getInt32(1, false);
      const total = length + 1;
      if (length < 4 || total > 64 * 1024 * 1024) {
        this.fail(new PgProtocolError(`implausible backend message length ${length}`));
        return;
      }
      if (this.buffer.length < total) return;
      const message: BackendMessage = {
        type: String.fromCharCode(this.buffer[0] ?? 0),
        // slice(), not subarray(): the copy detaches the message from the
        // rolling buffer, which is reallocated on the next chunk.
        body: this.buffer.slice(5, total),
      };
      this.buffer = this.buffer.slice(total);
      const resolve = this.waiter;
      if (resolve) {
        this.waiter = null;
        this.rejecter = null;
        resolve(message);
      } else {
        this.queue.push(message);
      }
    }
  }

  private next(timeoutMs: number): Promise<BackendMessage> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.closed) return Promise.reject(this.closed);
    return new Promise<BackendMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        this.rejecter = null;
        reject(new PgProtocolError(`timed out after ${timeoutMs}ms waiting for a backend message`));
      }, timeoutMs);
      this.waiter = (message) => {
        clearTimeout(timer);
        resolve(message);
      };
      this.rejecter = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  /**
   * Startup + authentication, ending at the first ReadyForQuery.
   *
   * Only SCRAM-SHA-256 and "no authentication" are accepted. Cleartext and MD5
   * are refused loudly rather than implemented: Neon uses SCRAM, so being asked
   * for either is itself a finding worth reading in the report.
   */
  async authenticate(params: PgConnectParams, timeoutMs: number): Promise<void> {
    this.transport.write(
      buildStartup({
        user: params.user,
        database: params.database,
        application_name: params.applicationName,
        client_encoding: 'UTF8',
        ...(params.extra ?? {}),
      }),
    );

    const scram = startScram(params.password);
    let expectedServerSignature: string | null = null;

    for (;;) {
      const message = await this.next(timeoutMs);
      switch (message.type) {
        case 'R': {
          const view = new DataView(message.body.buffer, message.body.byteOffset, message.body.byteLength);
          const subtype = view.getInt32(0, false);
          if (subtype === 0) break; // AuthenticationOk
          if (subtype === 10) {
            const mechanisms: string[] = [];
            let offset = 4;
            while (offset < message.body.length && message.body[offset] !== 0) {
              const read = readCString(message.body, offset);
              mechanisms.push(read.value);
              offset = read.next;
            }
            if (!mechanisms.includes('SCRAM-SHA-256')) {
              throw new ScramError(`server offered only: ${mechanisms.join(', ')}`);
            }
            const payload = encoder.encode(scram.clientFirst);
            this.transport.write(
              frame('p', concat([cstring('SCRAM-SHA-256'), int32(payload.length), payload])),
            );
            break;
          }
          if (subtype === 11) {
            const serverFirst = decoder.decode(message.body.subarray(4));
            const final = scram.clientFinal(serverFirst);
            expectedServerSignature = final.expectedServerSignature;
            this.transport.write(frame('p', encoder.encode(final.message)));
            break;
          }
          if (subtype === 12) {
            const serverFinal = decoder.decode(message.body.subarray(4));
            if (expectedServerSignature === null) {
              throw new ScramError('server-final arrived before client-final was sent');
            }
            if (!verifyServerSignature(serverFinal, expectedServerSignature)) {
              // Mutual authentication failed: something answered, but it does
              // not hold this role's stored key.
              throw new ScramError('server signature did not verify — the peer is not this Postgres');
            }
            break;
          }
          throw new PgProtocolError(
            `unsupported authentication request ${subtype} (this probe implements SCRAM-SHA-256 only)`,
          );
        }
        case 'S': {
          const key = readCString(message.body, 0);
          const value = readCString(message.body, key.next);
          this.parameters.set(key.value, value.value);
          break;
        }
        case 'K': {
          const view = new DataView(message.body.buffer, message.body.byteOffset, message.body.byteLength);
          this.backendPid = view.getInt32(0, false);
          break;
        }
        case 'Z':
          return;
        case 'E': {
          const error = parseErrorResponse(message.body);
          throw new PgProtocolError(`${error.severity} ${error.code}: ${error.message}`, error.code);
        }
        case 'N':
          break;
        default:
          break;
      }
    }
  }

  async query(sql: string, timeoutMs = 15_000): Promise<QueryResult> {
    this.transport.write(frame('Q', cstring(sql)));
    const result: QueryResult = { fields: [], rows: [], commandTags: [], notices: [] };
    let failure: PgProtocolError | null = null;
    for (;;) {
      const message = await this.next(timeoutMs);
      switch (message.type) {
        case 'T':
          result.fields = parseRowDescription(message.body);
          break;
        case 'D':
          result.rows.push(parseDataRow(message.body));
          break;
        case 'C':
          result.commandTags.push(readCString(message.body, 0).value);
          break;
        case 'N': {
          const notice = parseErrorResponse(message.body);
          result.notices.push(`${notice.severity}: ${notice.message}`);
          break;
        }
        case 'E': {
          const error = parseErrorResponse(message.body);
          // Do not throw yet: the backend still owes a ReadyForQuery, and
          // abandoning it here would desynchronise every later query.
          failure = new PgProtocolError(`${error.severity} ${error.code}: ${error.message}`, error.code);
          break;
        }
        case 'Z':
          if (failure) throw failure;
          return result;
        default:
          break;
      }
    }
  }

  async terminate(): Promise<void> {
    try {
      this.transport.write(frame('X', new Uint8Array(0)));
    } catch {
      // Already gone. Nothing to report — this runs in a finally.
    }
    this.transport.close();
  }
}

/** First cell of the first row, or null. Keeps `noUncheckedIndexedAccess` honest. */
export function firstCell(result: QueryResult): string | null {
  const row = result.rows[0];
  if (row === undefined) return null;
  return row[0] ?? null;
}
