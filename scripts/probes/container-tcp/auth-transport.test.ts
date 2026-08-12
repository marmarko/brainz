/**
 * The per-transport authentication rules, and the credential containment that
 * comes with them.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Neon's WebSocket wire proxy answers the startup message with
 * `AuthenticationCleartextPassword` (request 3) and offers no SASL. Until the
 * probe could answer that, the `ws.*` arm failed at authenticate against real
 * Neon — which made verdict (b) unreachable, and (b) is the branch on which
 * Containers are KEPT.
 *
 * Supporting cleartext opens two ways to be wrong, and both are tested here
 * rather than argued in a comment:
 *
 *   1. A DOWNGRADE. Raw TCP must still refuse cleartext — Neon's Postgres does
 *      offer SCRAM on 5432, so being asked for a password there is a finding.
 *      "It threw" is not the property under test; "it threw BEFORE putting the
 *      credential on the wire" is, so every refusal test inspects the bytes the
 *      client actually wrote.
 *   2. A LEAK. This repo is public and the probe's output is designed to be
 *      pasted into RESULT.md. The PasswordMessage is the one frame in this
 *      protocol whose payload IS the credential, so its failure path is the one
 *      place a transport error could quote it back.
 *
 * It also pins the thing that replaced the peer-verification gate on the
 * WebSocket leg: the session battery has to be shown to DISCRIMINATE, using the
 * one-shot HTTP channel's real observed behaviour as the null case.
 */

import { describe, expect, test } from 'bun:test';

import { runSessionBattery } from './container/battery.ts';
import {
  PgSession,
  SCRAM_ONLY,
  type AuthPolicy,
  type QueryResult,
  type SqlChannel,
  type WireTransport,
} from './container/pg-wire.ts';
import {
  classifyNegativeControl,
  decideVerdict,
  makeRedactor,
  materializeMeaning,
  summarizeNotes,
  VERDICTS,
  type TransportSummary,
  type VerdictInputs,
} from './container/report.ts';

/* ------------------------------------------------------------------------- */
/* A scripted backend, so the wire rules can be tested without a network       */
/* ------------------------------------------------------------------------- */

const enc = new TextEncoder();

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

function be32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setInt32(0, value, false);
  return out;
}

function be16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setInt16(0, value, false);
  return out;
}

function cstr(value: string): Uint8Array {
  return concat([enc.encode(value), new Uint8Array([0])]);
}

/** One backend message: type byte, self-inclusive int32 length, body. */
function msg(type: string, body: Uint8Array): Uint8Array {
  return concat([enc.encode(type), be32(body.length + 4), body]);
}

const authOk = (): Uint8Array => msg('R', be32(0));
/** AuthenticationCleartextPassword. */
const authCleartext = (): Uint8Array => msg('R', be32(3));
const authSaslScram = (): Uint8Array =>
  msg('R', concat([be32(10), cstr('SCRAM-SHA-256'), new Uint8Array([0])]));
const backendKey = (pid: number): Uint8Array => msg('K', concat([be32(pid), be32(9999)]));
const ready = (): Uint8Array => msg('Z', enc.encode('I'));

function rowDescription(names: readonly string[]): Uint8Array {
  const parts: Uint8Array[] = [be16(names.length)];
  for (const name of names) parts.push(cstr(name), new Uint8Array(18));
  return msg('T', concat(parts));
}

function dataRow(values: readonly (string | null)[]): Uint8Array {
  const parts: Uint8Array[] = [be16(values.length)];
  for (const value of values) {
    if (value === null) {
      parts.push(be32(-1));
    } else {
      const bytes = enc.encode(value);
      parts.push(be32(bytes.length), bytes);
    }
  }
  return msg('D', concat(parts));
}

const commandComplete = (tag: string): Uint8Array => msg('C', cstr(tag));

function errorResponse(code: string, message: string): Uint8Array {
  return msg(
    'E',
    concat([
      enc.encode('S'),
      cstr('ERROR'),
      enc.encode('C'),
      cstr(code),
      enc.encode('M'),
      cstr(message),
      new Uint8Array([0]),
    ]),
  );
}

/** A single-cell result: RowDescription, one DataRow, CommandComplete. */
function oneCell(value: string | null): Uint8Array {
  return concat([rowDescription(['v']), dataRow([value]), commandComplete('SELECT 1')]);
}

type FrontendKind = 'startup' | 'password' | 'query' | 'terminate' | 'other';

function classifyFrontend(bytes: Uint8Array, startupSeen: boolean): FrontendKind {
  if (!startupSeen) return 'startup';
  switch (String.fromCharCode(bytes[0] ?? 0)) {
    case 'p':
      return 'password';
    case 'Q':
      return 'query';
    case 'X':
      return 'terminate';
    default:
      return 'other';
  }
}

interface FakeTransportOptions {
  encrypted: boolean;
  /** Answer a frontend message by returning backend bytes (or nothing). */
  respond: (kind: FrontendKind, bytes: Uint8Array, sent: number) => Uint8Array | null;
  /** Simulates a transport whose `write` fails. Runs BEFORE the write is recorded. */
  failWrite?: (kind: FrontendKind) => Error | null;
}

/**
 * Records every byte the client hands to the transport.
 *
 * `writes` is the assertion surface for every refusal test: a refusal that
 * happens after the credential was already transmitted is not a refusal.
 */
class FakeTransport implements WireTransport {
  readonly name = 'fake';
  readonly encrypted: boolean;
  readonly writes: Uint8Array[] = [];
  closed = false;

  private dataCb: ((chunk: Uint8Array) => void) | null = null;
  private closeCb: ((reason: string) => void) | null = null;
  private startupSeen = false;
  private sent = 0;

  constructor(private readonly options: FakeTransportOptions) {
    this.encrypted = options.encrypted;
  }

  write(bytes: Uint8Array): void {
    const kind = classifyFrontend(bytes, this.startupSeen);
    const failure = this.options.failWrite?.(kind) ?? null;
    if (failure !== null) throw failure;
    this.writes.push(bytes);
    if (kind === 'startup') this.startupSeen = true;
    const reply = this.options.respond(kind, bytes, this.sent);
    this.sent += 1;
    if (reply !== null && this.dataCb !== null) this.dataCb(reply);
  }

  close(): void {
    this.closed = true;
  }

  onData(cb: (chunk: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  onClose(cb: (reason: string) => void): void {
    this.closeCb = cb;
  }

  /** Only used to prove the close path is wired; never called by these tests. */
  simulateClose(reason: string): void {
    this.closeCb?.(reason);
  }

  /** Does any byte sequence the client transmitted contain this secret? */
  transmitted(secret: string): boolean {
    const needle = enc.encode(secret);
    return this.writes.some((chunk) => indexOfBytes(chunk, needle) !== -1);
  }
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const PASSWORD = 'npg_correcthorsebatterystaple99';
const CONNECT = {
  user: 'probe_role',
  password: PASSWORD,
  database: 'probedb',
  applicationName: 'brainz-assumption4-probe',
} as const;

/** Neon's WebSocket proxy: cleartext request, then a working session. */
function neonWebSocketBackend(): FakeTransportOptions['respond'] {
  return (kind) => {
    if (kind === 'startup') return authCleartext();
    if (kind === 'password') return concat([authOk(), backendKey(4242), ready()]);
    return null;
  };
}

const ALLOW_CLEARTEXT: AuthPolicy = { cleartextPassword: 'allow-over-encrypted-transport' };

/* ------------------------------------------------------------------------- */

describe('AuthenticationCleartextPassword, per transport', () => {
  test('the WebSocket policy answers request 3 and completes the startup', async () => {
    const transport = new FakeTransport({ encrypted: true, respond: neonWebSocketBackend() });
    const session = new PgSession(transport);

    await session.authenticate(CONNECT, 1_000, ALLOW_CLEARTEXT);

    expect(session.auth.method).toBe('cleartext-password');
    expect(session.auth.cleartextPasswordSent).toBe(true);
    expect(session.auth.saslStarted).toBe(false);
    // No SASL means no server signature. This is the fact the verdict rule reads
    // to keep (b) reachable without pretending the peer was verified.
    expect(session.auth.serverSignatureVerified).toBe(false);
    expect(session.pid).toBe(4242);
  });

  test('the password is sent as a PasswordMessage, so the refusal tests below are real', async () => {
    const transport = new FakeTransport({ encrypted: true, respond: neonWebSocketBackend() });
    await new PgSession(transport).authenticate(CONNECT, 1_000, ALLOW_CLEARTEXT);

    // A refusal test that passed because the client never sends the password at
    // all would prove nothing. This is the positive control for those.
    expect(transport.transmitted(PASSWORD)).toBe(true);
    const passwordFrame = transport.writes.find((w) => String.fromCharCode(w[0] ?? 0) === 'p');
    expect(passwordFrame).toBeDefined();
  });

  test('raw TCP refuses request 3 — and refuses it BEFORE transmitting the credential', async () => {
    const transport = new FakeTransport({ encrypted: true, respond: neonWebSocketBackend() });
    const session = new PgSession(transport);

    await expect(session.authenticate(CONNECT, 1_000, SCRAM_ONLY)).rejects.toThrow(
      /cleartext password/i,
    );

    // The whole point. Neon offers SCRAM on the Postgres port, so answering a
    // cleartext request there would be a downgrade a real attacker could steer.
    expect(transport.transmitted(PASSWORD)).toBe(false);
    expect(transport.writes.some((w) => String.fromCharCode(w[0] ?? 0) === 'p')).toBe(false);
    expect(session.auth.cleartextPasswordSent).toBe(false);
  });

  test('the default policy is SCRAM-only, so a caller that forgets to pass one is safe', async () => {
    const transport = new FakeTransport({ encrypted: true, respond: neonWebSocketBackend() });

    await expect(new PgSession(transport).authenticate(CONNECT, 1_000)).rejects.toThrow(
      /cleartext password/i,
    );

    expect(transport.transmitted(PASSWORD)).toBe(false);
  });

  test('an unencrypted transport refuses request 3 even when the policy allows it', async () => {
    const transport = new FakeTransport({ encrypted: false, respond: neonWebSocketBackend() });

    await expect(
      new PgSession(transport).authenticate(CONNECT, 1_000, ALLOW_CLEARTEXT),
    ).rejects.toThrow(/does not encrypt/i);

    expect(transport.transmitted(PASSWORD)).toBe(false);
  });

  test('a mid-exchange downgrade from SASL to cleartext is refused', async () => {
    // A peer that starts SCRAM and then asks for the password instead is
    // abandoning exactly the half of the exchange that would identify it.
    const transport = new FakeTransport({
      encrypted: true,
      respond: (kind) => {
        if (kind === 'startup') return authSaslScram();
        if (kind === 'password') return authCleartext();
        return null;
      },
    });
    const session = new PgSession(transport);

    await expect(session.authenticate(CONNECT, 1_000, ALLOW_CLEARTEXT)).rejects.toThrow(
      /downgrade/i,
    );

    expect(session.auth.saslStarted).toBe(true);
    expect(session.auth.cleartextPasswordSent).toBe(false);
    // The SCRAM client-first message is also a 'p' frame, so the byte check —
    // not the frame type — is what carries this assertion.
    expect(transport.transmitted(PASSWORD)).toBe(false);
  });

  test('an unimplemented method (MD5) is still refused outright', async () => {
    const transport = new FakeTransport({
      encrypted: true,
      respond: (kind) => (kind === 'startup' ? msg('R', concat([be32(5), new Uint8Array(4)])) : null),
    });

    await expect(
      new PgSession(transport).authenticate(CONNECT, 1_000, ALLOW_CLEARTEXT),
    ).rejects.toThrow(/unsupported authentication request 5/i);

    expect(transport.transmitted(PASSWORD)).toBe(false);
  });

  test('a peer that asks for nothing at all is recorded as such, not as authenticated', async () => {
    const transport = new FakeTransport({
      encrypted: true,
      respond: (kind) => (kind === 'startup' ? concat([authOk(), backendKey(7), ready()]) : null),
    });
    const session = new PgSession(transport);

    await session.authenticate(CONNECT, 1_000, ALLOW_CLEARTEXT);

    // The startup succeeds, but `method: 'none'` is what the verdict rule turns
    // into `no_authentication_requested` — the terminator shape, fatal on every
    // transport including the WebSocket one.
    expect(session.auth.method).toBe('none');
    expect(session.auth.serverSignatureVerified).toBe(false);
    expect(transport.transmitted(PASSWORD)).toBe(false);
  });
});

/* ------------------------------------------------------------------------- */
/* Credential containment. The repo is public.                                */
/* ------------------------------------------------------------------------- */

describe('the cleartext path cannot leak the credential', () => {
  test('a write failure on the PasswordMessage does not quote the password back', async () => {
    // The worst realistic case: the transport layer echoes the buffer it failed
    // to send. This is the one frame whose payload IS the credential.
    const transport = new FakeTransport({
      encrypted: true,
      respond: neonWebSocketBackend(),
      failWrite: (kind) =>
        kind === 'password' ? new Error(`send failed for payload p\0${PASSWORD}\0`) : null,
    });

    let thrown: unknown;
    try {
      await new PgSession(transport).authenticate(CONNECT, 1_000, ALLOW_CLEARTEXT);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain(PASSWORD);
    expect(message).toContain('[redacted]');
    // Still diagnosable — scrubbing must not turn the error into a shrug.
    expect(message).toContain('failed to send the password response');
  });

  test('the recorded auth facts carry no credential material', async () => {
    const transport = new FakeTransport({ encrypted: true, respond: neonWebSocketBackend() });
    const session = new PgSession(transport);

    await session.authenticate(CONNECT, 1_000, ALLOW_CLEARTEXT);

    // `session.auth` is copied verbatim into the report's `*.authenticate` stage
    // detail, so it is a published surface.
    expect(JSON.stringify(session.auth)).not.toContain(PASSWORD);
  });

  test('redaction still covers error text on the cleartext transport', async () => {
    // A server that echoes connection parameters back inside an ErrorResponse
    // would otherwise put the credential straight into a stage error, and stage
    // errors are what get pasted into RESULT.md.
    const dsn = `postgresql://${CONNECT.user}:${PASSWORD}@ep-fake-probe-123.eu-central-1.aws.neon.tech/probedb`;
    const redact = makeRedactor([dsn, PASSWORD, CONNECT.user], 'ep-fake-probe-123.eu-central-1.aws.neon.tech');

    const transport = new FakeTransport({
      encrypted: true,
      respond: (kind, _bytes, sent) => {
        if (kind === 'startup') return authCleartext();
        if (kind === 'password') return concat([authOk(), backendKey(11), ready()]);
        if (kind !== 'query') return null;
        // First query answers; everything after it fails with a message that
        // embeds the whole connection string.
        if (sent === 2) return concat([oneCell('1'), ready()]);
        return concat([errorResponse('28P01', `connection ${dsn} rejected`), ready()]);
      },
    });
    const session = new PgSession(transport);
    await session.authenticate(CONNECT, 1_000, ALLOW_CLEARTEXT);

    const battery = await runSessionBattery(session, {
      prefix: 'ws',
      expectSession: true,
      redact,
    });

    const serialized = JSON.stringify(battery.stages);
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain('ep-fake-probe-123');
    // The stage errors did carry the server's text — they were redacted, not
    // dropped. A test that passed because nothing was recorded would be empty.
    expect(serialized).toContain('[redacted]');
  });
});

/* ------------------------------------------------------------------------- */
/* The gate that replaced peer verification on the WebSocket leg              */
/* ------------------------------------------------------------------------- */

/** Neon's one-shot HTTP endpoint, reproducing its real observed behaviour. */
function oneShotHttpChannel(): SqlChannel {
  return {
    name: 'fake one-shot',
    async query(sql: string): Promise<QueryResult> {
      const result = (value: string | null): QueryResult => ({
        fields: ['v'],
        rows: [[value]],
        commandTags: [],
        notices: [],
      });
      if (sql.startsWith('SELECT 1 AS one')) return result('1');
      // A warm backend pool means consecutive one-shot requests genuinely CAN
      // land on the same pid. The classifier must not read that as a session.
      if (sql.startsWith('SELECT pg_backend_pid')) return result('80808');
      if (sql === 'BEGIN' || sql === 'COMMIT') {
        return { fields: [], rows: [], commandTags: [sql], notices: [] };
      }
      if (sql.startsWith('SET LOCAL')) return { fields: [], rows: [], commandTags: [], notices: [] };
      // No session: the GUC is gone the moment the request ends.
      if (sql.startsWith("SELECT current_setting")) return result('');
      if (sql.startsWith('PREPARE')) return { fields: [], rows: [], commandTags: [], notices: [] };
      if (sql.startsWith('EXECUTE')) throw new Error('prepared statement does not exist');
      if (sql.startsWith('SELECT 1 FROM pg_extension')) {
        return { fields: [], rows: [], commandTags: [], notices: [] };
      }
      return { fields: [], rows: [], commandTags: [], notices: [] };
    },
  };
}

/** A channel that really does hold a session — what the control must not look like. */
function statefulChannel(): SqlChannel {
  const gucs = new Map<string, string>();
  const prepared = new Set<string>();
  let inTxn = false;
  return {
    name: 'fake session',
    async query(sql: string): Promise<QueryResult> {
      const result = (value: string | null): QueryResult => ({
        fields: ['v'],
        rows: [[value]],
        commandTags: [],
        notices: [],
      });
      if (sql.startsWith('SELECT 1 AS one')) return result('1');
      if (sql.startsWith('SELECT pg_backend_pid')) return result('31337');
      if (sql === 'BEGIN') {
        inTxn = true;
        return { fields: [], rows: [], commandTags: ['BEGIN'], notices: [] };
      }
      if (sql === 'COMMIT') {
        inTxn = false;
        gucs.clear();
        return { fields: [], rows: [], commandTags: ['COMMIT'], notices: [] };
      }
      const setLocal = /^SET LOCAL ([\w.]+) = '(.*)'$/.exec(sql);
      if (setLocal !== null && inTxn) {
        gucs.set(setLocal[1] ?? '', setLocal[2] ?? '');
        return { fields: [], rows: [], commandTags: [], notices: [] };
      }
      const read = /^SELECT current_setting\('([\w.]+)', true\)$/.exec(sql);
      if (read !== null) return result(gucs.get(read[1] ?? '') ?? '');
      const prepare = /^PREPARE (\w+)/.exec(sql);
      if (prepare !== null) {
        prepared.add(prepare[1] ?? '');
        return { fields: [], rows: [], commandTags: [], notices: [] };
      }
      const execute = /^EXECUTE (\w+)\((\d+)\)$/.exec(sql);
      if (execute !== null) {
        if (!prepared.has(execute[1] ?? '')) throw new Error('prepared statement does not exist');
        return result(String(Number.parseInt(execute[2] ?? '0', 10) * 2));
      }
      if (sql.startsWith('DEALLOCATE')) return { fields: [], rows: [], commandTags: [], notices: [] };
      if (sql.startsWith('SELECT 1 FROM pg_extension')) {
        return { fields: [], rows: [], commandTags: [], notices: [] };
      }
      return { fields: [], rows: [], commandTags: [], notices: [] };
    },
  };
}

const noRedact = (value: string): string => value;

describe('the session battery carries the anti-terminator job on the WebSocket leg', () => {
  test("the one-shot HTTP control fails the assertions that need a session", async () => {
    const battery = await runSessionBattery(oneShotHttpChannel(), {
      prefix: 'http',
      expectSession: false,
      redact: noRedact,
    });

    expect(battery.authenticated).toBe(true);
    expect(battery.sessionSemantics).toBe(false);
    expect(battery.assertions.setLocalReadback).toBe(false);
    expect(battery.assertions.preparedStatement).toBe(false);
    // Deliberately true, and deliberately NOT required to be false: a warm
    // backend pool makes this happen on real Neon.
    expect(battery.assertions.sameBackendInTxn).toBe(true);

    expect(classifyNegativeControl(battery.authenticated, battery.assertions)).toBe('discriminated');
  });

  test('a channel that DOES hold a session passes the same battery', async () => {
    const battery = await runSessionBattery(statefulChannel(), {
      prefix: 'ws',
      expectSession: true,
      redact: noRedact,
    });

    // Without this, "the control failed" would be unfalsifiable — a battery that
    // fails everything discriminates nothing.
    expect(battery.sessionSemantics).toBe(true);
    expect(battery.assertions.setLocalReadback).toBe(true);
    expect(battery.assertions.localScopedOut).toBe(true);
    expect(battery.assertions.preparedStatement).toBe(true);
  });

  test('a control that keeps per-session state makes the whole run suspect', () => {
    const base = {
      selectOne: true,
      setLocalReadback: false,
      sameBackendInTxn: true,
      localScopedOut: false,
      preparedStatement: false,
    };

    expect(classifyNegativeControl(true, base)).toBe('discriminated');
    expect(classifyNegativeControl(true, { ...base, setLocalReadback: true })).toBe('suspect');
    expect(classifyNegativeControl(true, { ...base, preparedStatement: true })).toBe('suspect');
    expect(classifyNegativeControl(false, base)).toBe('absent');
  });
});

/* ------------------------------------------------------------------------- */
/* The verdict rule                                                           */
/* ------------------------------------------------------------------------- */

const OK_TCP: TransportSummary = {
  channelOpen: true,
  authenticated: true,
  peerVerified: true,
  peerVerificationReason: 'scram_server_signature_verified',
  sessionSemantics: true,
};

const DEAD_TCP: TransportSummary = {
  channelOpen: false,
  authenticated: false,
  peerVerified: false,
  peerVerificationReason: 'auth_not_attempted',
  sessionSemantics: false,
};

/** What real Neon produces on the WebSocket leg: a session, and no signature. */
const WS_CLEARTEXT: TransportSummary = {
  channelOpen: true,
  authenticated: true,
  peerVerified: false,
  peerVerificationReason: 'cleartext_auth_no_server_signature',
  sessionSemantics: true,
};

const HTTP_CONTROL: TransportSummary = {
  channelOpen: true,
  authenticated: true,
  peerVerified: false,
  peerVerificationReason: 'one_shot_http_no_wire_auth',
  sessionSemantics: false,
};

function inputs(overrides: Partial<VerdictInputs> = {}): VerdictInputs {
  return {
    precondition: { ok: true },
    originCorroborated: true,
    rawTcpPostgresPort: DEAD_TCP,
    rawTcpPortConnectOk: false,
    webSocket443: WS_CLEARTEXT,
    httpOneShot443: HTTP_CONTROL,
    negativeControl: 'discriminated',
    genericHttpsEgress: true,
    rawTcp443Reachable: true,
    ...overrides,
  };
}

describe('the peer-verification gate is per transport', () => {
  test('(b) is REACHABLE when the WebSocket leg authenticated with a cleartext password', () => {
    // The defect this whole change exists for. Before it, this case returned
    // INCONCLUSIVE_PEER_UNVERIFIED, which would have hidden the branch that
    // keeps Containers behind an inconclusive against real Neon.
    expect(decideVerdict(inputs())).toBe('B_WEBSOCKET_ONLY');
  });

  test('(b) is still refused when the far end challenged for nothing', () => {
    expect(
      decideVerdict(
        inputs({
          webSocket443: { ...WS_CLEARTEXT, peerVerificationReason: 'no_authentication_requested' },
        }),
      ),
    ).toBe('INCONCLUSIVE_PEER_UNVERIFIED');
  });

  test('(b) is still refused when authentication never completed', () => {
    expect(
      decideVerdict(
        inputs({
          webSocket443: { ...WS_CLEARTEXT, peerVerificationReason: 'auth_incomplete' },
        }),
      ),
    ).toBe('INCONCLUSIVE_PEER_UNVERIFIED');
  });

  test('(b) is still refused when the battery was never shown able to fail', () => {
    // With no peer signature on this leg, the control is the only remaining
    // guard against a channel that was merely accepted.
    expect(decideVerdict(inputs({ negativeControl: 'absent' }))).toBe(
      'INCONCLUSIVE_CONTROL_ABSENT',
    );
  });

  test('(b) is still refused when the control kept state it cannot hold', () => {
    expect(decideVerdict(inputs({ negativeControl: 'suspect' }))).toBe(
      'INCONCLUSIVE_CONTROL_SUSPECT',
    );
  });

  test('(b) is still refused when a raw socket to the Postgres port opened', () => {
    expect(decideVerdict(inputs({ rawTcpPortConnectOk: true }))).toBe(
      'INCONCLUSIVE_TCP_REACHABLE',
    );
  });

  test('(a) still requires a verified SCRAM server signature — cleartext does NOT unlock it', () => {
    expect(
      decideVerdict(
        inputs({
          rawTcpPostgresPort: {
            ...OK_TCP,
            peerVerified: false,
            peerVerificationReason: 'cleartext_auth_no_server_signature',
          },
          rawTcpPortConnectOk: true,
        }),
      ),
    ).toBe('INCONCLUSIVE_PEER_UNVERIFIED');
  });

  test('(a) is unchanged on a healthy raw TCP run', () => {
    expect(decideVerdict(inputs({ rawTcpPostgresPort: OK_TCP, rawTcpPortConnectOk: true }))).toBe(
      'A_RAW_TCP_OK',
    );
  });

  test('(c) is unchanged when neither transport carried a session', () => {
    expect(
      decideVerdict(
        inputs({
          webSocket443: DEAD_TCP,
          rawTcp443Reachable: false,
        }),
      ),
    ).toBe('C_BOTH_BLOCKED');
  });
});

describe('a (b) verdict says out loud what it does not establish', () => {
  test('the verdict text names the missing peer verification and why', () => {
    const meaning = materializeMeaning(VERDICTS.B_WEBSOCKET_ONLY, 5432);

    expect(meaning.assumption4).toContain('NOT cryptographically verified');
    expect(meaning.assumption4).toContain('cleartext password');
    expect(meaning.label).toContain('peer NOT cryptographically verified');
  });

  test('the notes spell out both halves for a real (b) run', () => {
    const notes = summarizeNotes(inputs(), 'B_WEBSOCKET_ONLY', 5432);
    const joined = notes.join('\n');

    expect(joined).toContain('WHAT (b) DOES NOT CLAIM');
    expect(joined).toContain('cleartext_auth_no_server_signature');
    expect(joined).toContain('WHAT (b) DOES claim');
  });

  test('a SCRAM-verified WebSocket run does not carry the cleartext caveat', () => {
    const notes = summarizeNotes(
      inputs({
        webSocket443: { ...WS_CLEARTEXT, peerVerified: true, peerVerificationReason: 'scram_server_signature_verified' },
      }),
      'B_WEBSOCKET_ONLY',
      5432,
    );

    expect(notes.join('\n')).not.toContain('WHAT (b) DOES NOT CLAIM');
  });
});
