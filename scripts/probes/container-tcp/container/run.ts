/**
 * The orchestrator: runs every stage, in order, and assembles the report.
 *
 * The order is not arbitrary. Preconditions refuse bad input before anything is
 * measured; the controls run before the candidates so that a candidate failure
 * can be attributed; the two candidate transports run independently so neither
 * can mask the other; and the one-shot HTTP channel runs last as the negative
 * control that shows what losing the session actually looks like.
 *
 * Nothing here throws to the caller. A probe that dies on an unexpected error
 * reports nothing, and reporting nothing is indistinguishable — to whoever runs
 * it — from reporting failure. Every stage captures its own outcome.
 *
 * NO STAGE GATES ANOTHER STAGE THAT COULD MEASURE THE SAME FACT
 * ------------------------------------------------------------
 * `probeReachability` used to gate the whole raw-TCP arm on a single-shot
 * throwaway connection. One lost packet on that connection suppressed the real
 * transport — which opens its own socket and redoes the same check — and the
 * run then reported a decisive "raw TCP is blocked" over a port that had just
 * completed a handshake. Reachability is now diagnostic only: the real
 * transport is ALWAYS attempted, and any completed handshake to the Postgres
 * port forbids the verdicts that claim raw TCP did not work.
 */

import { existsSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { PgSession, type SqlChannel } from './pg-wire.ts';
import { runSessionBattery } from './battery.ts';
import {
  decideVerdict,
  hostFingerprint,
  hostSuffix,
  makeRedactor,
  materializeMeaning,
  summarizeNotes,
  unmaskableSecretCount,
  VERDICTS,
  type DetailValue,
  type NegativeControlState,
  type OriginAttestation,
  type ProbeReport,
  type Redactor,
  type StageResult,
  type TransportSummary,
  type Verdict,
  type VerdictInputs,
} from './report.ts';
import {
  httpOneShotChannel,
  openTcpTlsTransport,
  openWebSocketTransport,
  probeGenericHttps,
  probeReachability,
  TransportError,
} from './transports.ts';

export interface RunOptions {
  dsn: string;
  /** `container` is a CLAIM, not evidence. See `attestation` on the report. */
  origin: 'container' | 'local';
  /** Cloudflare colo, stamped by the Worker from `request.cf`. Null on a laptop. */
  colo: string | null;
  /** Did the Worker see a Cloudflare `cf` object at all? Absent under `wrangler dev`. */
  workerSawCfObject: boolean;
  /** Colo suffix of the incoming `cf-ray`, as the Worker saw it. Names only, never the id. */
  workerRayColo: string | null;
  /** Escape hatch for a `-pooler` DSN. Off by default — see battery.ts. */
  allowPooler: boolean;
  /** Escape hatch for a DSN whose port is not 5432. Off by default — see below. */
  allowNonStandardPort: boolean;
  /** Escape hatch for a corporate TLS-intercepting proxy on the laptop run. */
  tlsInsecure: boolean;
  stageTimeoutMs: number;
}

const APPLICATION_NAME = 'brainz-assumption4-probe';

/** The port Assumption 4 is literally about. */
const POSTGRES_PORT = 5432;

const CLOUDFLARE_EGRESS_CA = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';

const EMPTY_TRANSPORT: TransportSummary = {
  channelOpen: false,
  authenticated: false,
  peerVerified: false,
  sessionSemantics: false,
};

interface ParsedDsn {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  extra: Record<string, string>;
  hadChannelBindingRequire: boolean;
}

function parseDsn(dsn: string): ParsedDsn {
  const url = new URL(dsn);
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`expected a postgres:// or postgresql:// URL, got ${url.protocol}//`);
  }
  const host = url.hostname;
  const user = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!host) throw new Error('the connection string has no host');
  if (!user) throw new Error('the connection string has no role');
  if (!password) throw new Error('the connection string has no password (SCRAM needs one)');
  if (!database) throw new Error('the connection string has no database');

  const extra: Record<string, string> = {};
  // Neon's `options=endpoint%3D...` is the non-SNI routing fallback; carry it
  // through if the DSN has it, since a client that drops it lands nowhere.
  const options = url.searchParams.get('options');
  if (options !== null) extra['options'] = options;

  return {
    host,
    port: url.port ? Number.parseInt(url.port, 10) : POSTGRES_PORT,
    user,
    password,
    database,
    extra,
    hadChannelBindingRequire: url.searchParams.get('channel_binding') === 'require',
  };
}

/**
 * Evidence about where this run happened, gathered inside the container.
 *
 * The gate is deliberately positive: a container run must SHOW that Cloudflare
 * handled the request, rather than being believed because it said so. The
 * driver adds its own independent half (`cf-ray` on the response it received);
 * this half alone is necessary, not sufficient.
 */
function attest(options: RunOptions): OriginAttestation {
  const containerEnvMarkers = Object.keys(process.env)
    .filter((key) => key.startsWith('CLOUDFLARE_'))
    .sort();
  const missing: string[] = [];
  if (options.origin === 'container') {
    if (!options.workerSawCfObject) {
      missing.push(
        'worker_cf_object — the Worker saw no Cloudflare `cf` object on the incoming request, ' +
          'which is what a plain `wrangler dev` looks like',
      );
    }
    if (options.colo === null || options.colo === '') {
      missing.push('cloudflare_colo — no colo was stamped on this run');
    }
    if (options.workerRayColo === null) {
      missing.push(
        'worker_cf_ray — the request that reached the Worker carried no `cf-ray` header, so it ' +
          "did not arrive through Cloudflare's edge",
      );
    }
  }
  return {
    claimedOrigin: options.origin,
    workerSawCfObject: options.workerSawCfObject,
    cloudflareColo: options.colo,
    workerRayColo: options.workerRayColo,
    containerEnvMarkers,
    cloudflareEgressCaPresent: existsSync(CLOUDFLARE_EGRESS_CA),
    extraCaConfigured: (process.env['NODE_EXTRA_CA_CERTS'] ?? '') !== '',
    originCorroborated: options.origin === 'local' ? true : missing.length === 0,
    missing,
  };
}

export async function runProbe(options: RunOptions): Promise<ProbeReport> {
  const startedAt = new Date().toISOString();
  const runStarted = Date.now();
  const stages: StageResult[] = [];
  const notes: string[] = [];
  const attestation = attest(options);

  const environment: Record<string, DetailValue> = {
    origin_claimed: options.origin,
    origin_corroborated: attestation.originCorroborated,
    cloudflare_colo: options.colo,
    cloudflare_env_markers: attestation.containerEnvMarkers.length,
    bun_version: typeof Bun === 'undefined' ? null : Bun.version,
    platform: platform(),
    arch: arch(),
    // Present only when Cloudflare's outbound HTTPS interception is active for
    // this container. Its presence changes how an HTTPS result should be read,
    // so it is recorded whether or not it is set — and the image's entrypoint
    // trusts it, so a detected CA is remediated rather than merely observed.
    cloudflare_egress_ca_present: attestation.cloudflareEgressCaPresent,
    extra_ca_configured: attestation.extraCaConfigured,
    tls_verification: options.tlsInsecure ? 'DISABLED (--tls-insecure)' : 'enforced',
    stage_timeout_ms: options.stageTimeoutMs,
  };

  if (attestation.cloudflareEgressCaPresent && !attestation.extraCaConfigured) {
    notes.push(
      "Cloudflare's egress interception CA is mounted in this container but this process was " +
        'not started with NODE_EXTRA_CA_CERTS pointing at it. Every HTTPS candidate (the ' +
        'generic control, the WebSocket, the one-shot HTTP control) can then fail certificate ' +
        'validation and read as a platform denial when it is a trust-store misconfiguration. ' +
        'Rebuild the image: the entrypoint exports it when the file exists.',
    );
  }
  if (!attestation.originCorroborated) {
    notes.push(`Missing origin evidence: ${attestation.missing.join('; ')}.`);
  }

  /* --- precondition: the connection string ------------------------------- */

  let dsn: ParsedDsn;
  try {
    dsn = parseDsn(options.dsn);
  } catch (error) {
    // No host yet, so nothing host-shaped can be safely echoed. Report the
    // failure abstractly rather than risk pasting a credential into a public
    // repo via RESULT.md.
    stages.push({
      id: 'precondition.dsn',
      proves: 'the supplied connection string is a usable Postgres URL.',
      status: 'failed',
      ms: 0,
      detail: {},
      error: error instanceof Error ? error.message : 'unparseable connection string',
    });
    return finish(startedAt, runStarted, options, attestation, stages, notes, environment, {
      hostFingerprint: 'unknown',
      hostSuffix: 'unknown',
      port: 0,
      isPoolerEndpoint: false,
    }, {
      precondition: { ok: false },
      originCorroborated: attestation.originCorroborated,
      rawTcpPostgresPort: EMPTY_TRANSPORT,
      rawTcpPortConnectOk: false,
      webSocket443: EMPTY_TRANSPORT,
      httpOneShot443: EMPTY_TRANSPORT,
      negativeControl: 'absent',
      genericHttpsEgress: false,
      rawTcp443Reachable: false,
    });
  }

  const redact = makeRedactor([options.dsn, dsn.password, dsn.user], dsn.host);
  const unmaskable = unmaskableSecretCount([dsn.password, dsn.user]);
  if (unmaskable > 0) {
    notes.push(
      `${unmaskable} credential value(s) in this DSN are shorter than 3 characters and were NOT ` +
        'pattern-redacted — substituting a one- or two-character needle would shred every error ' +
        'string in the report. Read the output before pasting any of it into RESULT.md.',
    );
  }
  const isPooler = dsn.host.includes('-pooler.');
  const target = {
    hostFingerprint: hostFingerprint(dsn.host),
    hostSuffix: hostSuffix(dsn.host),
    port: dsn.port,
    isPoolerEndpoint: isPooler,
  };
  const emptyInputs = (): VerdictInputs => ({
    precondition: { ok: false },
    originCorroborated: attestation.originCorroborated,
    rawTcpPostgresPort: EMPTY_TRANSPORT,
    rawTcpPortConnectOk: false,
    webSocket443: EMPTY_TRANSPORT,
    httpOneShot443: EMPTY_TRANSPORT,
    negativeControl: 'absent',
    genericHttpsEgress: false,
    rawTcp443Reachable: false,
  });

  stages.push({
    id: 'precondition.dsn',
    proves: 'the supplied connection string is a usable Postgres URL.',
    status: 'ok',
    ms: 0,
    detail: { port: dsn.port, has_neon_options_param: 'options' in dsn.extra },
    error: null,
  });

  if (dsn.hadChannelBindingRequire) {
    notes.push(
      'The connection string carries `channel_binding=require`. That is a client-side ' +
        'preference; this probe negotiates plain SCRAM-SHA-256 on both transports on purpose, ' +
        'because the WebSocket transport has no Postgres-layer TLS channel to bind to and the ' +
        'two runs must be byte-identical above the transport to be comparable.',
    );
  }

  /* --- precondition: the port Assumption 4 is about ----------------------- */

  // Every port in this probe is DSN-derived, but the question is not: Assumption
  // 4 asks about 5432 specifically, and a verdict computed over some other port
  // would be a true statement about the wrong measurement. It also collapses the
  // `control.tcp_443` arm if the DSN happens to name 443.
  const portOk = dsn.port === POSTGRES_PORT || options.allowNonStandardPort;
  stages.push({
    id: 'precondition.postgres_port',
    proves: `the DSN names port ${POSTGRES_PORT}, which is the port Assumption 4 is written about.`,
    status: portOk ? 'ok' : 'failed',
    ms: 0,
    detail: { port: dsn.port, override_set: options.allowNonStandardPort },
    error: portOk
      ? null
      : `This DSN names port ${dsn.port}, not ${POSTGRES_PORT}. Assumption 4 is a claim about raw ` +
        `outbound TCP to ${POSTGRES_PORT}; certifying it from a run against another port would ` +
        'be a true measurement of the wrong thing. Use the direct Neon endpoint on ' +
        `${POSTGRES_PORT}, or set PROBE_ALLOW_NONSTANDARD_PORT=1 (or pass --allow-nonstandard-port) ` +
        'if you are deliberately testing port filtering — every verdict string then names the ' +
        'port actually dialled.',
  });
  if (!portOk) {
    return finish(startedAt, runStarted, options, attestation, stages, notes, environment, target, emptyInputs());
  }
  if (dsn.port !== POSTGRES_PORT) {
    notes.push(
      `This run dialled port ${dsn.port}, NOT ${POSTGRES_PORT}. Every verdict below is a statement ` +
        `about ${dsn.port}. Assumption 4 as written is about ${POSTGRES_PORT} and is not settled ` +
        'by this run.',
    );
  }

  /* --- precondition: not a pooler endpoint ------------------------------- */

  const poolerOk = !isPooler || options.allowPooler;
  stages.push({
    id: 'precondition.direct_endpoint',
    proves: 'the target is a direct Neon endpoint, not the PgBouncer pooler.',
    status: poolerOk ? 'ok' : 'failed',
    ms: 0,
    detail: { pooler_endpoint: isPooler, override_set: options.allowPooler },
    error: poolerOk
      ? null
      : 'This is a `-pooler` endpoint. PgBouncer transaction pooling breaks SET LOCAL readback ' +
        'and standalone PREPARE/EXECUTE by design, so the session battery would fail on a ' +
        'perfectly working raw TCP connection and this probe would report (b) or (c) when the ' +
        'answer is (a). Use the direct endpoint from the Neon dashboard (the host WITHOUT ' +
        '`-pooler`). KTD2\'s "pooled TCP" means the client-side postgres.js pool, not PgBouncer. ' +
        'Set PROBE_ALLOW_POOLER=1 only if you understand that the battery result will be wrong.',
  });

  if (!poolerOk) {
    return finish(startedAt, runStarted, options, attestation, stages, notes, environment, target, emptyInputs());
  }
  if (isPooler && options.allowPooler) {
    notes.push(
      'PROBE_ALLOW_POOLER is set and this IS a pooler endpoint. PgBouncer can route PREPARE and ' +
        'EXECUTE to the same backend when it holds a single idle server connection, so a PASSING ' +
        'session battery here is not evidence of session semantics — only of egress. Do not read ' +
        'the (a)/(b) distinction off this run.',
    );
  }

  /* --- control: generic HTTPS egress ------------------------------------- */

  const httpsStarted = Date.now();
  const https = await probeGenericHttps(dsn.host, options.stageTimeoutMs);
  stages.push({
    id: 'control.https_443',
    proves: 'this runtime has ordinary internet access to the target host. If this fails, nothing else in the report means anything about Cloudflare.',
    status: https.ok ? 'ok' : 'failed',
    ms: Date.now() - httpsStarted,
    detail: { http_status: https.status },
    error: https.failure ? redact(`${https.failure.code}: ${https.failure.message}`) : null,
  });

  /* --- candidate (a): raw TCP on the Postgres port ------------------------ */

  const reachStarted = Date.now();
  const reach = await probeReachability(dsn.host, dsn.port, options.stageTimeoutMs, true);
  const postgresAnswered = reach.tcpConnectOk && reach.sslNegotiationReply === 'S';
  stages.push({
    id: 'tcp.reachability',
    proves: `DIAGNOSTIC ONLY (it gates nothing): a raw outbound TCP socket to port ${dsn.port} opens AND a real Postgres answers the SSL negotiation. The transport below opens its own socket regardless of what this stage found.`,
    status: postgresAnswered ? 'ok' : 'failed',
    ms: Date.now() - reachStarted,
    detail: {
      dns_resolved: reach.dnsOk,
      address_family: reach.addressFamily,
      tcp_connect: reach.tcpConnectOk,
      tcp_connect_ms: reach.tcpConnectMs,
      sslrequest_reply: reach.sslNegotiationReply,
    },
    error: reach.failure ? redact(`${reach.failure.phase}/${reach.failure.code}: ${reach.failure.message}`) : null,
  });

  if (reach.failure?.code === 'ETIMEDOUT' && reach.failure.phase === 'tcp') {
    notes.push(
      'The TCP connect to the Postgres port timed out rather than being refused. A silent SYN ' +
        'drop is what a filtered egress path looks like; a refusal would point at the far end.',
    );
  }
  if (reach.tcpConnectOk && reach.sslNegotiationReply !== 'S') {
    notes.push(
      'A TCP connection to the Postgres port was ACCEPTED but nothing answered the Postgres SSL ' +
        'negotiation on that connection. That reads as interception or black-holing rather than ' +
        'a clean block, and is worth raising with Cloudflare before accepting any no-branch.',
    );
  }

  // Always attempted. `openTcpTlsTransport` redoes the connect and the
  // SSLRequest check on its own socket, so gating it on the throwaway probe
  // above would let one transient suppress the measurement that matters.
  let tcpPortConnectOk = reach.tcpConnectOk;
  const tcpSummary = await runOverTransport(
    'tcp',
    `raw TCP + STARTTLS on ${dsn.port}`,
    stages,
    redact,
    async () => {
      const opened = await openTcpTlsTransport(
        dsn.host,
        dsn.port,
        options.stageTimeoutMs,
        !options.tlsInsecure,
      );
      tcpPortConnectOk = true;
      return {
        transport: opened.transport,
        detail: {
          tcp_connect_ms: opened.tcpConnectMs,
          tls_handshake_ms: opened.tlsHandshakeMs,
          tls_protocol: opened.tlsProtocol,
          tls_certificate_authorized: opened.tlsAuthorized,
        },
      };
    },
    (error) => {
      // A failure AFTER the TCP handshake still proves the handshake happened.
      // Recording that is what stops a TLS or SSLRequest problem being reported
      // as "the platform blocks raw TCP".
      if (error instanceof TransportError && error.phase !== 'dns' && error.phase !== 'tcp') {
        tcpPortConnectOk = true;
      }
    },
    dsn,
    options.stageTimeoutMs,
  );

  /* --- control: raw TCP on 443 ------------------------------------------- */

  const tcp443Started = Date.now();
  const tcp443Independent = dsn.port !== 443;
  const tcp443 = tcp443Independent
    ? await probeReachability(dsn.host, 443, options.stageTimeoutMs, false)
    : null;
  stages.push({
    id: 'control.tcp_443',
    proves: 'whether ANY raw outbound TCP socket opens from this runtime. Separates "the Postgres port is filtered" from "no raw sockets at all", which are different problems with different fallbacks.',
    status: tcp443 === null ? 'skipped' : tcp443.tcpConnectOk ? 'ok' : 'failed',
    ms: Date.now() - tcp443Started,
    detail:
      tcp443 === null
        ? { reason: 'the DSN already names port 443, so this control would measure the candidate' }
        : { tcp_connect: tcp443.tcpConnectOk, tcp_connect_ms: tcp443.tcpConnectMs },
    error: tcp443?.failure ? redact(`${tcp443.failure.code}: ${tcp443.failure.message}`) : null,
  });
  if (tcp443 === null) {
    notes.push(
      'The `control.tcp_443` arm was skipped: the DSN names port 443, so the control and the ' +
        'candidate would be the same measurement. Port filtering cannot be distinguished from a ' +
        'blanket socket ban on this run.',
    );
  }

  /* --- candidate (b): Postgres over a WebSocket on 443 -------------------- */

  const wsSummary = await runOverTransport(
    'ws',
    'the Postgres wire protocol over wss on 443',
    stages,
    redact,
    async () => {
      const opened = await openWebSocketTransport(dsn.host, options.stageTimeoutMs);
      return { transport: opened.transport, detail: { upgrade_ms: opened.upgradeMs, path: '/v2' } };
    },
    null,
    dsn,
    options.stageTimeoutMs,
  );

  /* --- negative control: the one-shot HTTP driver ------------------------- */

  const httpChannel: SqlChannel = httpOneShotChannel(options.dsn, dsn.host, options.stageTimeoutMs);
  const httpBattery = await runSessionBattery(httpChannel, {
    prefix: 'http',
    expectSession: false,
    redact,
  });
  stages.push(...httpBattery.stages);
  const httpSummary: TransportSummary = {
    channelOpen: httpBattery.authenticated,
    authenticated: httpBattery.authenticated,
    // The one-shot endpoint authenticates inside Neon rather than over the wire
    // from here, so it never carries evidence about the peer.
    peerVerified: false,
    sessionSemantics: httpBattery.sessionSemantics,
  };
  const negativeControl: NegativeControlState = httpBattery.sessionSemantics
    ? 'suspect'
    : httpBattery.authenticated
      ? 'discriminated'
      : 'absent';
  if (negativeControl === 'discriminated') {
    notes.push(
      "The one-shot HTTP endpoint answered SELECT 1 and then failed the session battery, exactly " +
        'as it should. That is the control that proves the WebSocket transport above is a real ' +
        'session and not the HTTP function wearing a different name.',
    );
  }
  if (negativeControl === 'absent') {
    const why = httpBattery.stages.find((stage) => stage.id === 'http.select_1')?.error;
    notes.push(
      `The negative control could not run. Reason recorded by \`http.select_1\`: ${why ?? 'no error was captured'}.`,
    );
  }

  return finish(startedAt, runStarted, options, attestation, stages, notes, environment, target, {
    precondition: { ok: true },
    originCorroborated: attestation.originCorroborated,
    rawTcpPostgresPort: tcpSummary,
    rawTcpPortConnectOk: tcpPortConnectOk,
    webSocket443: wsSummary,
    httpOneShot443: httpSummary,
    negativeControl,
    genericHttpsEgress: https.ok,
    rawTcp443Reachable: tcp443?.tcpConnectOk ?? false,
  });
}

/** Open a byte channel, authenticate over it, then run the identical battery. */
async function runOverTransport(
  prefix: string,
  description: string,
  stages: StageResult[],
  redact: Redactor,
  open: () => Promise<{ transport: import('./pg-wire.ts').WireTransport; detail: Record<string, DetailValue> }>,
  /** Lets the caller record socket-level facts carried by a failed open. */
  onOpenError: ((error: unknown) => void) | null,
  dsn: ParsedDsn,
  timeoutMs: number,
): Promise<TransportSummary> {
  const summary: TransportSummary = { ...EMPTY_TRANSPORT };

  const openStarted = Date.now();
  let session: PgSession;
  try {
    const opened = await open();
    summary.channelOpen = true;
    stages.push({
      id: `${prefix}.channel_open`,
      proves: `${description} — the byte channel itself opens.`,
      status: 'ok',
      ms: Date.now() - openStarted,
      detail: opened.detail,
      error: null,
    });
    session = new PgSession(opened.transport);
    session.queryTimeoutMs = timeoutMs;
  } catch (error) {
    onOpenError?.(error);
    stages.push({
      id: `${prefix}.channel_open`,
      proves: `${description} — the byte channel itself opens.`,
      status: 'failed',
      ms: Date.now() - openStarted,
      detail: {
        failed_phase: error instanceof TransportError ? error.phase : null,
        failed_code: error instanceof TransportError ? error.code : null,
      },
      error: redact(error instanceof Error ? error.message : String(error)),
    });
    return summary;
  }

  const authProves =
    'the far end completed SCRAM-SHA-256 and returned a server signature this client verified, ' +
    'so it holds this role\'s stored key — not a terminator that merely accepted the socket. ' +
    '(A byte-RELAYING proxy is not ruled out: plain SCRAM without channel binding cannot detect one.)';
  const authStarted = Date.now();
  try {
    await session.authenticate(
      {
        user: dsn.user,
        password: dsn.password,
        database: dsn.database,
        extra: dsn.extra,
        applicationName: APPLICATION_NAME,
      },
      timeoutMs,
    );
    summary.peerVerified = session.auth.serverSignatureVerified;
    stages.push({
      id: `${prefix}.authenticate`,
      proves: authProves,
      // The claim above is only true when the facts below say so. A session
      // that came up without a verified SCRAM exchange is recorded as a FAILED
      // authenticate stage even though the connection is usable, and the
      // verdict refuses to be conclusive over it.
      status: summary.peerVerified ? 'ok' : 'failed',
      ms: Date.now() - authStarted,
      detail: {
        auth_method: session.auth.method,
        scram_started: session.auth.saslStarted,
        server_signature_verified: session.auth.serverSignatureVerified,
        server_version: session.parameters.get('server_version') ?? null,
        backend_pid_received: session.pid !== null,
      },
      error: summary.peerVerified
        ? null
        : 'the session came up without a verified SCRAM-SHA-256 server signature, so nothing here ' +
          'establishes that the peer is this Neon Postgres rather than something that accepted the bytes',
    });
  } catch (error) {
    stages.push({
      id: `${prefix}.authenticate`,
      proves: authProves,
      status: 'failed',
      ms: Date.now() - authStarted,
      detail: {
        auth_method: session.auth.method,
        scram_started: session.auth.saslStarted,
        server_signature_verified: session.auth.serverSignatureVerified,
      },
      error: redact(error instanceof Error ? error.message : String(error)),
    });
    await session.terminate();
    return summary;
  }

  try {
    const battery = await runSessionBattery(session, { prefix, expectSession: true, redact });
    stages.push(...battery.stages);
    summary.authenticated = battery.authenticated;
    summary.sessionSemantics = battery.sessionSemantics;
  } finally {
    await session.terminate();
  }
  return summary;
}

function finish(
  startedAt: string,
  runStarted: number,
  options: RunOptions,
  attestation: OriginAttestation,
  stages: StageResult[],
  notes: string[],
  environment: Record<string, DetailValue>,
  target: ProbeReport['target'],
  inputs: VerdictInputs,
): ProbeReport {
  const observed = decideVerdict(inputs);
  const allNotes = [...notes, ...summarizeNotes(inputs, observed, target.port)];

  // A calibration run computes the same verdict from the same evidence, but the
  // evidence came from the wrong machine. The VERDICT ITSELF becomes
  // CALIBRATION_ONLY — not a rewritten label over an `A_RAW_TCP_OK` field and a
  // zero exit code — because `verdict` and the exit code are the two surfaces a
  // script and a transcriber read, and both used to lie on a laptop run.
  const isLocal = options.origin === 'local';
  const verdict: Verdict = isLocal ? 'CALIBRATION_ONLY' : observed;
  const wouldBeVerdict: Verdict | null = isLocal ? observed : null;
  const meaning = materializeMeaning(VERDICTS[verdict], target.port);
  if (isLocal) {
    allNotes.unshift(
      'THIS IS A CALIBRATION RUN, NOT A VERDICT. It ran on the machine that invoked it, not ' +
        'inside a deployed Cloudflare Container, so it says nothing about Cloudflare egress. Its ' +
        "job is to prove this probe's own wire implementation works against this Neon project, " +
        'so that a failure in the container run is attributable to the platform rather than to ' +
        `this code. On the same evidence, a container run would have reported ${observed}.`,
    );
  }
  return {
    probe: 'container-tcp',
    settles:
      'Assumption 4 — a deployed Cloudflare Container can open unrestricted raw outbound TCP to Neon',
    schemaVersion: 2,
    startedAt,
    totalMs: Date.now() - runStarted,
    origin: options.origin,
    attestation,
    environment,
    target,
    stages,
    transports: {
      rawTcpPostgresPort: inputs.rawTcpPostgresPort,
      webSocket443: inputs.webSocket443,
      httpOneShot443: inputs.httpOneShot443,
    },
    negativeControl: inputs.negativeControl,
    verdict,
    wouldBeVerdict,
    verdictMeaning: meaning,
    notes: allNotes,
    driver: null,
  };
}
