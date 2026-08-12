/**
 * The three byte channels under test, plus the two reachability probes that
 * make a failure attributable.
 *
 *   openTcpTlsTransport   (a) raw outbound TCP to 5432, STARTTLS, SNI.
 *   openWebSocketTransport(b) the Postgres protocol tunnelled over `wss` on 443.
 *   httpOneShotChannel    the negative control: Neon's one-shot HTTP SQL
 *                         endpoint. Not a candidate runtime — it is here to
 *                         prove 443 egress works and, more importantly, to
 *                         demonstrate what losing the session looks like, so
 *                         (b) can never be confused with it.
 *
 * WHY REACHABILITY IS PROBED SEPARATELY FROM THE SESSION
 * ------------------------------------------------------
 * "The driver threw" is not evidence. Filtered egress, a refused connection and
 * an intercepted-then-reset connection are three different platform behaviours
 * with three different consequences, and they are indistinguishable once a
 * driver has wrapped them. Worse, a bug in this probe's own wire code would
 * present identically. So the socket-level facts are captured first and on
 * their own: did DNS resolve, did the TCP handshake complete, and did a real
 * Postgres answer the SSL negotiation.
 *
 * That last one matters more than it looks. A transparent proxy or a captive
 * network can accept a TCP connection to anything and then sit there. Sending
 * the 8-byte SSLRequest and requiring the single byte `S` back is what
 * distinguishes "a socket opened" from "Postgres is on the other end".
 */

import { lookup } from 'node:dns/promises';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { SSL_REQUEST, type QueryResult, type SqlChannel, type WireTransport } from './pg-wire.ts';

export interface ConnectFailure {
  message: string;
  /** `ETIMEDOUT` (filtered), `ECONNREFUSED` (rejected), `ECONNRESET` (intercepted), ... */
  code: string;
  phase: 'dns' | 'tcp' | 'ssl_negotiation' | 'tls' | 'upgrade' | 'http';
}

export class TransportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly phase: ConnectFailure['phase'],
  ) {
    super(message);
  }
}

function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}

function messageOf(error: unknown): string {
  // Some runtimes raise connection errors with an empty `message` and all the
  // information in `code`. An empty string in the report reads as "no reason
  // given", which is worse than saying so.
  if (error instanceof Error) return error.message || error.name || 'error carried no message';
  return String(error);
}

/* ------------------------------------------------------------------------- */
/* Reachability                                                               */
/* ------------------------------------------------------------------------- */

export interface ReachabilityResult {
  dnsOk: boolean;
  addressFamily: number | null;
  tcpConnectOk: boolean;
  tcpConnectMs: number | null;
  /** 'S' = TLS accepted, 'N' = TLS refused, null = not attempted or no reply. */
  sslNegotiationReply: string | null;
  failure: ConnectFailure | null;
}

/**
 * DNS + TCP handshake, and optionally the Postgres SSL negotiation.
 *
 * The address itself is never returned: it is not needed for the verdict and
 * this result is destined for a file in a public repo.
 */
export async function probeReachability(
  host: string,
  port: number,
  timeoutMs: number,
  sendSslRequest: boolean,
): Promise<ReachabilityResult> {
  const result: ReachabilityResult = {
    dnsOk: false,
    addressFamily: null,
    tcpConnectOk: false,
    tcpConnectMs: null,
    sslNegotiationReply: null,
    failure: null,
  };

  try {
    const resolved = await boundedLookup(host, timeoutMs);
    result.dnsOk = true;
    result.addressFamily = resolved.family;
  } catch (error) {
    result.failure = { message: messageOf(error), code: codeOf(error), phase: 'dns' };
    return result;
  }

  const started = Date.now();
  let socket: Socket | null = null;
  try {
    socket = await connectTcp(host, port, timeoutMs);
    result.tcpConnectOk = true;
    result.tcpConnectMs = Date.now() - started;
  } catch (error) {
    result.failure = { message: messageOf(error), code: codeOf(error), phase: 'tcp' };
    return result;
  }

  if (!sendSslRequest) {
    socket.destroy();
    return result;
  }

  try {
    socket.write(Buffer.from(SSL_REQUEST));
    const reply = await readOneByte(socket, timeoutMs);
    result.sslNegotiationReply = String.fromCharCode(reply);
  } catch (error) {
    result.failure = { message: messageOf(error), code: codeOf(error), phase: 'ssl_negotiation' };
  } finally {
    socket.destroy();
  }
  return result;
}

/**
 * `dns.lookup` carries no deadline of its own — it is bounded only by the
 * resolver's own retry policy, which on a container with filtered egress can be
 * tens of seconds. Every other wait in this probe is bounded; an unbounded one
 * here would burn the whole-run deadline and return no report at all, which
 * reads to whoever ran it exactly like a failure.
 */
async function boundedLookup(host: string, timeoutMs: number): Promise<{ family: number }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new TransportError(`DNS lookup timed out after ${timeoutMs}ms`, 'ETIMEDOUT', 'dns')),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([lookup(host), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function connectTcp(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    // A blocked port normally presents as a silent SYN drop, so the deadline —
    // not an error event — is what ends this call in the interesting case.
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new TransportError(`TCP connect to :${port} timed out after ${timeoutMs}ms`, 'ETIMEDOUT', 'tcp'));
    }, timeoutMs);
    const socket = netConnect({ host, port });
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      resolve(socket);
    });
    function onError(error: Error): void {
      clearTimeout(timer);
      socket.destroy();
      reject(new TransportError(messageOf(error), codeOf(error), 'tcp'));
    }
    socket.once('error', onError);
  });
}

/** Consume exactly one byte, leaving anything after it for the TLS layer. */
function readOneByte(socket: Socket, timeoutMs: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new TransportError('no reply to the Postgres SSLRequest', 'ETIMEDOUT', 'ssl_negotiation'));
    }, timeoutMs);

    const onReadable = (): void => {
      const chunk: unknown = socket.read(1);
      if (!(chunk instanceof Uint8Array)) return;
      const byte = chunk[0];
      if (byte === undefined) return;
      cleanup();
      resolve(byte);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new TransportError(messageOf(error), codeOf(error), 'ssl_negotiation'));
    };
    const onEnd = (): void => {
      cleanup();
      reject(
        new TransportError(
          'the peer closed the connection without answering the SSLRequest',
          'ECONNRESET',
          'ssl_negotiation',
        ),
      );
    };
    function cleanup(): void {
      clearTimeout(timer);
      socket.removeListener('readable', onReadable);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
    }

    socket.on('readable', onReadable);
    socket.once('error', onError);
    socket.once('end', onEnd);
    onReadable(); // in case the byte is already buffered
  });
}

/* ------------------------------------------------------------------------- */
/* Transport (a): raw TCP + STARTTLS on 5432                                  */
/* ------------------------------------------------------------------------- */

/**
 * Holds inbound bytes until the protocol layer attaches. Both transports open
 * before `PgSession` is constructed, and a frame arriving in that window would
 * otherwise be dropped — a race that would present as an unexplained timeout.
 */
class Sink {
  private pending: Uint8Array[] = [];
  private sink: ((chunk: Uint8Array) => void) | null = null;
  private closeReason: string | null = null;
  private onCloseCb: ((reason: string) => void) | null = null;

  push(chunk: Uint8Array): void {
    if (this.sink) this.sink(chunk);
    else this.pending.push(chunk);
  }

  end(reason: string): void {
    this.closeReason ??= reason;
    if (this.onCloseCb) this.onCloseCb(reason);
  }

  attach(cb: (chunk: Uint8Array) => void): void {
    this.sink = cb;
    const buffered = this.pending;
    this.pending = [];
    for (const chunk of buffered) cb(chunk);
  }

  attachClose(cb: (reason: string) => void): void {
    this.onCloseCb = cb;
    if (this.closeReason !== null) cb(this.closeReason);
  }
}

export interface TcpTlsResult {
  transport: WireTransport;
  tcpConnectMs: number;
  tlsHandshakeMs: number;
  tlsProtocol: string | null;
  tlsAuthorized: boolean;
}

export async function openTcpTlsTransport(
  host: string,
  port: number,
  timeoutMs: number,
  rejectUnauthorized: boolean,
): Promise<TcpTlsResult> {
  const tcpStarted = Date.now();
  const socket = await connectTcp(host, port, timeoutMs);
  const tcpConnectMs = Date.now() - tcpStarted;

  socket.write(Buffer.from(SSL_REQUEST));
  const reply = String.fromCharCode(await readOneByte(socket, timeoutMs));
  if (reply !== 'S') {
    socket.destroy();
    throw new TransportError(
      `the server answered the SSLRequest with '${reply}' — it will not do TLS on this port`,
      'ESSLREFUSED',
      'ssl_negotiation',
    );
  }

  const tlsStarted = Date.now();
  const sink = new Sink();
  const tls = await new Promise<import('node:tls').TLSSocket>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TransportError(`TLS handshake timed out after ${timeoutMs}ms`, 'ETIMEDOUT', 'tls'));
    }, timeoutMs);
    // `servername` is not optional here even though it looks like a detail:
    // Neon routes to the right compute by SNI, so a handshake without it lands
    // nowhere.
    const upgraded = tlsConnect({ socket, servername: host, rejectUnauthorized, minVersion: 'TLSv1.2' });
    upgraded.once('secureConnect', () => {
      clearTimeout(timer);
      upgraded.removeListener('error', onError);
      resolve(upgraded);
    });
    function onError(error: Error): void {
      clearTimeout(timer);
      reject(new TransportError(messageOf(error), codeOf(error), 'tls'));
    }
    upgraded.once('error', onError);
  });
  const tlsHandshakeMs = Date.now() - tlsStarted;

  tls.on('data', (chunk: Buffer) => sink.push(new Uint8Array(chunk)));
  tls.once('close', () => sink.end('socket closed'));
  tls.once('error', (error: Error) => sink.end(`${codeOf(error)}: ${messageOf(error)}`));

  return {
    transport: {
      name: `tcp+tls:${port}`,
      // STARTTLS completed above, and `rejectUnauthorized` is on unless the
      // operator explicitly passed --tls-insecure.
      encrypted: true,
      write: (bytes) => void tls.write(Buffer.from(bytes)),
      close: () => void tls.destroy(),
      onData: (cb) => sink.attach(cb),
      onClose: (cb) => sink.attachClose(cb),
    },
    tcpConnectMs,
    tlsHandshakeMs,
    tlsProtocol: tls.getProtocol(),
    tlsAuthorized: tls.authorized,
  };
}

/* ------------------------------------------------------------------------- */
/* Transport (b): the Postgres protocol over a WebSocket on 443               */
/* ------------------------------------------------------------------------- */

/**
 * `wss://<host>/v2` is Neon's wire proxy — the same endpoint
 * `@neondatabase/serverless` uses for its `Pool`/`Client`. It is a transparent
 * TCP tunnel: the bytes inside the frames are the ordinary Postgres v3
 * protocol, in the clear, because the WebSocket is already TLS.
 *
 * This is the transport KTD2's first no-branch names, and it is emphatically
 * NOT the `neon()` HTTP function — that one is `httpOneShotChannel` below, and
 * conflating the two is the confusion the plan already had to correct once.
 * Here, a `Client` holds a session; there, every statement is its own request.
 *
 * AUTHENTICATION ON THIS LEG IS NOT SCRAM
 * ---------------------------------------
 * The proxy answers the startup message with `AuthenticationCleartextPassword`
 * (request 3) and offers no SASL mechanism at all. That is Neon's documented
 * design for the serverless endpoint: SCRAM-SHA-256's PBKDF2 is specified to
 * cost on the order of 100ms of CPU, which does not fit a serverless CPU budget,
 * so they lean on the tunnel's own TLS and on long random generated passwords
 * instead. `@neondatabase/serverless` reflects the same fact from the other
 * side — its default `pipelineConnect: "password"` pipelines the startup message
 * with a cleartext PasswordMessage, which is only possible because that is what
 * the endpoint asks for, and its default `forceDisablePgSSL: true` skips
 * Postgres-level TLS because the WebSocket already carries it.
 *
 * The consequence for this probe: there is no server signature to verify on this
 * transport, so `peerVerified` is false here BY DESIGN and the verdict rule gates
 * (b) on session semantics instead. See `PeerVerificationReason` in report.ts.
 */
export interface WebSocketResult {
  transport: WireTransport;
  upgradeMs: number;
  url: string;
}

export async function openWebSocketTransport(
  host: string,
  timeoutMs: number,
): Promise<WebSocketResult> {
  const url = `wss://${host}/v2`;
  const started = Date.now();
  const sink = new Sink();
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Closing a socket that never opened is not interesting.
      }
      reject(new TransportError(`WebSocket upgrade timed out after ${timeoutMs}ms`, 'ETIMEDOUT', 'upgrade'));
    }, timeoutMs);
    socket.onopen = (): void => {
      clearTimeout(timer);
      resolve();
    };
    socket.onerror = (): void => {
      clearTimeout(timer);
      // The browser-shaped WebSocket API deliberately withholds the reason for
      // a failed handshake, so there is nothing more specific to report here.
      reject(new TransportError(`WebSocket upgrade to ${url} failed`, 'EWSUPGRADE', 'upgrade'));
    };
  });
  const upgradeMs = Date.now() - started;

  socket.onmessage = (event): void => {
    const data: unknown = event.data;
    if (data instanceof ArrayBuffer) sink.push(new Uint8Array(data));
    else if (data instanceof Uint8Array) sink.push(data);
    else if (typeof data === 'string') sink.push(new TextEncoder().encode(data));
  };
  socket.onclose = (event): void => sink.end(`websocket closed (code ${event.code})`);
  socket.onerror = (): void => sink.end('websocket error');

  return {
    transport: {
      name: 'wss:443',
      // `wss` — the URL is built as such a few lines up, and the runtime
      // validates the endpoint's certificate. This is what makes it legitimate
      // to answer Neon's cleartext-password request on this leg; a `ws://`
      // transport would report false here and `authenticate` would refuse.
      encrypted: true,
      write: (bytes) => socket.send(bytes),
      close: () => socket.close(),
      onData: (cb) => sink.attach(cb),
      onClose: (cb) => sink.attachClose(cb),
    },
    upgradeMs,
    url,
  };
}

/* ------------------------------------------------------------------------- */
/* The negative control: Neon's one-shot HTTP SQL endpoint                    */
/* ------------------------------------------------------------------------- */

/**
 * Every statement is an independent HTTPS request with no session behind it.
 * This is the driver KTD2's *second* no-branch falls to, and running the
 * identical session battery through it is the discriminator: if the WebSocket
 * transport were secretly this, the battery would fail there in the same way.
 */
export function httpOneShotChannel(dsn: string, host: string, timeoutMs: number): SqlChannel {
  const endpoint = `https://${host}/sql`;
  return {
    name: 'https:443 (one-shot)',
    async query(sql: string): Promise<QueryResult> {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'neon-connection-string': dsn,
          'neon-raw-text-output': 'true',
          'neon-array-mode': 'true',
        },
        body: JSON.stringify({ query: sql, params: [] }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new TransportError(
          `HTTP ${response.status}: ${text.slice(0, 400)}`,
          `HTTP_${response.status}`,
          'http',
        );
      }
      const parsed: unknown = JSON.parse(text);
      return normalizeHttpResult(parsed);
    },
  };
}

function normalizeHttpResult(parsed: unknown): QueryResult {
  const result: QueryResult = { fields: [], rows: [], commandTags: [], notices: [] };
  if (typeof parsed !== 'object' || parsed === null) return result;
  const body = parsed as { fields?: unknown; rows?: unknown; command?: unknown };
  if (Array.isArray(body.fields)) {
    for (const field of body.fields) {
      if (typeof field === 'object' && field !== null && 'name' in field) {
        result.fields.push(String((field as { name: unknown }).name));
      }
    }
  }
  if (Array.isArray(body.rows)) {
    for (const row of body.rows) {
      if (Array.isArray(row)) {
        result.rows.push(row.map((cell: unknown) => (cell === null ? null : String(cell))));
      }
    }
  }
  if (typeof body.command === 'string') result.commandTags.push(body.command);
  return result;
}

/** A plain HTTPS request that proves this runtime has internet at all. */
export async function probeGenericHttps(
  host: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number | null; failure: ConnectFailure | null }> {
  try {
    const response = await fetch(`https://${host}/`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Any status at all is a pass: a 404 still proves DNS, TCP 443 and TLS.
    return { ok: true, status: response.status, failure: null };
  } catch (error) {
    return {
      ok: false,
      status: null,
      failure: { message: messageOf(error), code: codeOf(error), phase: 'http' },
    };
  }
}
