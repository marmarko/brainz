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
  summarizeNotes,
  VERDICTS,
  type DetailValue,
  type ProbeReport,
  type Redactor,
  type StageResult,
  type TransportSummary,
  type VerdictInputs,
} from './report.ts';
import {
  httpOneShotChannel,
  openTcpTlsTransport,
  openWebSocketTransport,
  probeGenericHttps,
  probeReachability,
} from './transports.ts';

export interface RunOptions {
  dsn: string;
  /** `container` is the only origin that settles anything. See ProbeReport. */
  origin: 'container' | 'local';
  /** Cloudflare colo, stamped by the Worker. Null on a laptop run. */
  colo: string | null;
  /** Escape hatch for a `-pooler` DSN. Off by default — see battery.ts. */
  allowPooler: boolean;
  /** Escape hatch for a corporate TLS-intercepting proxy on the laptop run. */
  tlsInsecure: boolean;
  stageTimeoutMs: number;
}

const APPLICATION_NAME = 'brainz-assumption4-probe';

const EMPTY_TRANSPORT: TransportSummary = {
  channelOpen: false,
  authenticated: false,
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
    port: url.port ? Number.parseInt(url.port, 10) : 5432,
    user,
    password,
    database,
    extra,
    hadChannelBindingRequire: url.searchParams.get('channel_binding') === 'require',
  };
}

export async function runProbe(options: RunOptions): Promise<ProbeReport> {
  const startedAt = new Date().toISOString();
  const runStarted = Date.now();
  const stages: StageResult[] = [];
  const notes: string[] = [];

  const environment: Record<string, DetailValue> = {
    origin: options.origin,
    cloudflare_colo: options.colo,
    bun_version: typeof Bun === 'undefined' ? null : Bun.version,
    platform: platform(),
    arch: arch(),
    // Present only when Cloudflare's outbound HTTPS interception is active for
    // this container. Its presence changes how an HTTPS result should be read,
    // so it is recorded whether or not it is set.
    cloudflare_egress_ca_present: existsSync('/etc/cloudflare/certs/cloudflare-containers-ca.crt'),
    tls_verification: options.tlsInsecure ? 'DISABLED (--tls-insecure)' : 'enforced',
  };

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
    return finish(startedAt, runStarted, options, stages, notes, environment, {
      hostFingerprint: 'unknown',
      hostSuffix: 'unknown',
      port: 0,
      isPoolerEndpoint: false,
    }, {
      precondition: { ok: false },
      rawTcp5432: EMPTY_TRANSPORT,
      webSocket443: EMPTY_TRANSPORT,
      httpOneShot443: EMPTY_TRANSPORT,
      genericHttpsEgress: false,
      rawTcp443Reachable: false,
    });
  }

  const redact = makeRedactor([options.dsn, dsn.password, dsn.user], dsn.host);
  const isPooler = dsn.host.includes('-pooler.');
  const target = {
    hostFingerprint: hostFingerprint(dsn.host),
    hostSuffix: hostSuffix(dsn.host),
    port: dsn.port,
    isPoolerEndpoint: isPooler,
  };

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
    return finish(startedAt, runStarted, options, stages, notes, environment, target, {
      precondition: { ok: false },
      rawTcp5432: EMPTY_TRANSPORT,
      webSocket443: EMPTY_TRANSPORT,
      httpOneShot443: EMPTY_TRANSPORT,
      genericHttpsEgress: false,
      rawTcp443Reachable: false,
    });
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

  /* --- candidate (a): raw TCP on 5432 ------------------------------------ */

  const reachStarted = Date.now();
  const reach = await probeReachability(dsn.host, dsn.port, options.stageTimeoutMs, true);
  const postgresAnswered = reach.tcpConnectOk && reach.sslNegotiationReply === 'S';
  stages.push({
    id: 'tcp.reachability',
    proves: `a raw outbound TCP socket to port ${dsn.port} opens AND a real Postgres answers the SSL negotiation. This is the pure egress question Assumption 4 asks.`,
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
        'negotiation. That reads as interception or black-holing rather than a clean block, and ' +
        'is worth raising with Cloudflare before accepting any no-branch.',
    );
  }

  let tcpSummary: TransportSummary = { ...EMPTY_TRANSPORT, channelOpen: postgresAnswered };
  if (postgresAnswered) {
    tcpSummary = await runOverTransport(
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
      dsn,
      options.stageTimeoutMs,
      true,
    );
    tcpSummary.channelOpen = true;
  }

  /* --- control: raw TCP on 443 ------------------------------------------- */

  const tcp443Started = Date.now();
  const tcp443 = await probeReachability(dsn.host, 443, options.stageTimeoutMs, false);
  stages.push({
    id: 'control.tcp_443',
    proves: 'whether ANY raw outbound TCP socket opens from this runtime. Separates "port 5432 is filtered" from "no raw sockets at all", which are different problems with different fallbacks.',
    status: tcp443.tcpConnectOk ? 'ok' : 'failed',
    ms: Date.now() - tcp443Started,
    detail: { tcp_connect: tcp443.tcpConnectOk, tcp_connect_ms: tcp443.tcpConnectMs },
    error: tcp443.failure ? redact(`${tcp443.failure.code}: ${tcp443.failure.message}`) : null,
  });

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
    dsn,
    options.stageTimeoutMs,
    false,
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
    sessionSemantics: httpBattery.sessionSemantics,
  };
  if (httpBattery.authenticated && !httpBattery.sessionSemantics) {
    notes.push(
      "The one-shot HTTP endpoint answered SELECT 1 and then failed the session battery, exactly " +
        'as it should. That is the control that proves the WebSocket transport above is a real ' +
        'session and not the HTTP function wearing a different name.',
    );
  }

  return finish(startedAt, runStarted, options, stages, notes, environment, target, {
    precondition: { ok: true },
    rawTcp5432: tcpSummary,
    webSocket443: wsSummary,
    httpOneShot443: httpSummary,
    genericHttpsEgress: https.ok,
    rawTcp443Reachable: tcp443.tcpConnectOk,
  });
}

/** Open a byte channel, authenticate over it, then run the identical battery. */
async function runOverTransport(
  prefix: string,
  description: string,
  stages: StageResult[],
  redact: Redactor,
  open: () => Promise<{ transport: import('./pg-wire.ts').WireTransport; detail: Record<string, DetailValue> }>,
  dsn: ParsedDsn,
  timeoutMs: number,
  channelAlreadyProven: boolean,
): Promise<TransportSummary> {
  const summary: TransportSummary = { ...EMPTY_TRANSPORT, channelOpen: channelAlreadyProven };

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
  } catch (error) {
    stages.push({
      id: `${prefix}.channel_open`,
      proves: `${description} — the byte channel itself opens.`,
      status: 'failed',
      ms: Date.now() - openStarted,
      detail: {},
      error: redact(error instanceof Error ? error.message : String(error)),
    });
    return summary;
  }

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
    stages.push({
      id: `${prefix}.authenticate`,
      proves: 'SCRAM-SHA-256 completed AND the server signature verified — the far end really is this Neon Postgres, not a proxy that accepted the socket.',
      status: 'ok',
      ms: Date.now() - authStarted,
      detail: {
        server_version: session.parameters.get('server_version') ?? null,
        backend_pid_received: session.pid !== null,
      },
      error: null,
    });
  } catch (error) {
    stages.push({
      id: `${prefix}.authenticate`,
      proves: 'SCRAM-SHA-256 completed AND the server signature verified.',
      status: 'failed',
      ms: Date.now() - authStarted,
      detail: {},
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
  stages: StageResult[],
  notes: string[],
  environment: Record<string, DetailValue>,
  target: ProbeReport['target'],
  inputs: VerdictInputs,
): ProbeReport {
  const verdict = decideVerdict(inputs);
  const allNotes = [...notes, ...summarizeNotes(inputs, verdict)];
  const base = VERDICTS[verdict];
  // A calibration run computes the same verdict from the same evidence, but the
  // evidence came from the wrong machine. Rewriting the wording — rather than
  // relying on a note further down the page — is what stops a green laptop run
  // from being pasted into RESULT.md as the answer.
  const meaning =
    options.origin === 'local'
      ? {
          label: `CALIBRATION ONLY (not a verdict) — would be ${base.label}`,
          assumption4:
            'NOT SETTLED. This ran on the machine that invoked it, so it measures that machine\'s ' +
            'egress, not a deployed Cloudflare Container\'s. What it does establish is that the ' +
            'probe itself works against this Neon project — which is what makes a later container ' +
            'failure attributable to the platform.',
          planAction:
            'Deploy the Worker and container and re-run without --local. Only that run may be ' +
            'recorded in RESULT.md as the answer to Assumption 4.',
          exitCode: base.exitCode,
        }
      : base;
  if (options.origin === 'local') {
    allNotes.unshift(
      'THIS IS A CALIBRATION RUN, NOT A VERDICT. It ran on the machine that invoked it, not ' +
        'inside a deployed Cloudflare Container, so it says nothing about Cloudflare egress. Its ' +
        'job is to prove this probe\'s own wire implementation works against this Neon project, ' +
        'so that a failure in the container run is attributable to the platform rather than to ' +
        'this code.',
    );
  }
  return {
    probe: 'container-tcp',
    settles:
      'Assumption 4 — a deployed Cloudflare Container can open unrestricted raw outbound TCP to Neon',
    schemaVersion: 1,
    startedAt,
    totalMs: Date.now() - runStarted,
    origin: options.origin,
    environment,
    target,
    stages,
    transports: {
      rawTcp5432: inputs.rawTcp5432,
      webSocket443: inputs.webSocket443,
      httpOneShot443: inputs.httpOneShot443,
    },
    verdict,
    verdictMeaning: meaning,
    notes: allNotes,
  };
}
