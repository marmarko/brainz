#!/usr/bin/env bun
/**
 * `bun run probe:container-tcp` — the driver for the Assumption 4 probe.
 *
 * Two modes, and the distinction is the point:
 *
 *   --local   CALIBRATION. Runs the identical probe code on this machine.
 *             Proves nothing about Cloudflare; proves everything about whether
 *             this probe's own wire implementation works against your Neon
 *             project. Run it FIRST. Without it, a container failure is
 *             ambiguous between "Cloudflare blocks this" and "the probe is
 *             broken", and that ambiguity is exactly what would push the plan
 *             onto an expensive no-branch it did not need. A calibration run
 *             always exits 50 and its verdict is always CALIBRATION_ONLY — it
 *             can never be mistaken for the answer by a script or by a reader.
 *
 *   (default) VERDICT. Calls the deployed Worker, which runs the probe inside a
 *             deployed Cloudflare Container. This is the only run that settles
 *             Assumption 4 — and only if this driver can independently see that
 *             Cloudflare served the response.  See `gateReport` in driver-gate.ts: the
 *             container's own `origin: 'container'` is a claim, not evidence.
 *
 * Exit codes are meaningful, so this can be scripted:
 *   0  (a) raw TCP works                     10 (b) WebSocket only
 *   20 (c) both blocked                      30 inconclusive — do not branch
 *   40 the probe could not run at all        50 calibration only — never a verdict
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runProbe } from './container/run.ts';
import type { ProbeReport, StageResult, TransportSummary } from './container/report.ts';
import {
  classifyEndpoint,
  gateReport,
  parseReport,
  writeReceipt,
  type EndpointEvidence,
} from './driver-gate.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url).href);
const RECEIPT_PATH = `${HERE}result-calibration-receipt.json`;

interface Cli {
  local: boolean;
  jsonOnly: boolean;
  allowPooler: boolean;
  allowNonStandardPort: boolean;
  tlsInsecure: boolean;
  stageTimeoutMs: number;
  outPath: string | null;
}

function parseCli(argv: readonly string[]): Cli {
  const cli: Cli = {
    local: false,
    jsonOnly: false,
    allowPooler: process.env['PROBE_ALLOW_POOLER'] === '1',
    allowNonStandardPort: process.env['PROBE_ALLOW_NONSTANDARD_PORT'] === '1',
    tlsInsecure: process.env['PROBE_TLS_INSECURE'] === '1',
    stageTimeoutMs: 15_000,
    outPath: null,
  };
  for (const arg of argv) {
    if (arg === '--local') cli.local = true;
    else if (arg === '--json') cli.jsonOnly = true;
    else if (arg === '--allow-pooler') cli.allowPooler = true;
    else if (arg === '--allow-nonstandard-port') cli.allowNonStandardPort = true;
    else if (arg === '--tls-insecure') cli.tlsInsecure = true;
    else if (arg.startsWith('--timeout=')) {
      const value = Number.parseInt(arg.slice('--timeout='.length), 10);
      if (Number.isFinite(value) && value > 0) cli.stageTimeoutMs = value;
    } else if (arg.startsWith('--out=')) cli.outPath = arg.slice('--out='.length);
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
  }
  return cli;
}

const USAGE = `
brainz probe: can a deployed Cloudflare Container open raw outbound TCP to Neon?
Settles Assumption 4 (plan: Assumption 4, KTD2, U1 step 6).

  bun run probe:container-tcp -- --local     calibration on this machine (run first)
  bun run probe:container-tcp                the verdict, from inside the container

Environment
  --local mode
    PROBE_DATABASE_URL   direct (NON-pooler) Neon connection string
  default mode
    PROBE_URL            https://brainz-probe-container-tcp.<subdomain>.workers.dev
    PROBE_AUTH_TOKEN     the same random string given to \`wrangler secret put\`

Optional
  PROBE_ALLOW_POOLER=1            run against a -pooler endpoint anyway (the result will be wrong)
  PROBE_ALLOW_NONSTANDARD_PORT=1  run against a DSN whose port is not 5432
  PROBE_TLS_INSECURE=1            skip TLS certificate verification, --local only (MITM proxies)

Flags
  --json                 print the report JSON only
  --timeout=<ms>         per-stage deadline (default 15000, clamped to 1000..60000)
  --out=<path>           where to write the result JSON

Exit codes
  0  (a) raw TCP works       10 (b) WebSocket only        20 (c) both blocked
  30 inconclusive            40 could not run at all      50 calibration (--local)
`;

function fail(message: string): never {
  process.stderr.write(`\nprobe: ${message}\n`);
  process.exit(40);
  // Unreachable. `process.exit` is not declared as `never` under this project's
  // type configuration, and a `never` function needs an unreachable end point.
  throw new Error(message);
}

/* ------------------------------------------------------------------------- */
/* The remote call                                                            */
/* ------------------------------------------------------------------------- */

async function fetchRemoteReport(cli: Cli): Promise<{ report: ProbeReport; evidence: EndpointEvidence }> {
  const base = process.env['PROBE_URL'];
  const token = process.env['PROBE_AUTH_TOKEN'];
  if (!base) fail('PROBE_URL is not set. Deploy the Worker first — see the README.');
  if (!token) fail('PROBE_AUTH_TOKEN is not set. Use the same value you gave `wrangler secret put`.');

  const url = new URL('/probe', base).toString();
  // The container's own ceiling is derived from the stage timeout; this one has
  // to sit above it, or a legitimately slow run is reported to the operator as
  // an unreachable endpoint.
  const clientTimeoutMs = Math.max(180_000, cli.stageTimeoutMs * 12 + 60_000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        allowPooler: cli.allowPooler,
        allowNonStandardPort: cli.allowNonStandardPort,
        stageTimeoutMs: cli.stageTimeoutMs,
      }),
      signal: AbortSignal.timeout(clientTimeoutMs),
    });
  } catch (error) {
    fail(
      `could not reach the probe endpoint — ${error instanceof Error ? error.message : String(error)}\n` +
        '  A cold container can take a while on the first call after a deploy. Retry once.',
    );
  }

  const text = await response.text();
  if (!response.ok) {
    fail(`the Worker answered HTTP ${response.status}:\n${text.slice(0, 1200)}`);
  }
  const parsed = parseReport(text);
  if (!parsed.ok) {
    fail(
      'the response was not a container-tcp report:\n  - ' +
        parsed.problems.join('\n  - ') +
        '\n  If an older image is deployed, redeploy it: ' +
        '`bunx wrangler deploy -c scripts/probes/container-tcp/wrangler.toml`.',
    );
  }
  return { report: parsed.report, evidence: classifyEndpoint(base, response.headers) };
}

/* ------------------------------------------------------------------------- */
/* Human output                                                               */
/* ------------------------------------------------------------------------- */

const MARK: Record<StageResult['status'], string> = {
  ok: '  PASS',
  failed: '  FAIL',
  skipped: '  skip',
  expected_failure: '  FAIL(expected)',
};

const CONTROL_MEANING: Record<ProbeReport['negativeControl'], string> = {
  discriminated:
    'PASS — it authenticated, then failed to read back the SET LOCAL nonce and failed to run a ' +
    'prepared statement from an earlier round trip, as a channel with no session must',
  absent: 'DID NOT RUN — the battery was never shown to be capable of failing',
  suspect: 'SUSPECT — a channel with no session kept per-session state; the battery is in doubt',
};

/** One line per row of the transports table, so `peer verified` is never read bare. */
const PEER_REASON_TEXT: Record<TransportSummary['peerVerificationReason'], string> = {
  scram_server_signature_verified:
    'SCRAM-SHA-256 completed and the server signature verified — the peer holds this role’s stored key',
  cleartext_auth_no_server_signature:
    'NOT VERIFIABLE ON THIS TRANSPORT BY DESIGN: the endpoint asked for a cleartext password ' +
    'inside its own TLS and offers no SASL, so there is no server signature to check. Session ' +
    'semantics below, contrasted with the one-shot HTTP control, is what rules out a terminator here',
  no_authentication_requested:
    'THE FAR END CHALLENGED FOR NOTHING — straight to AuthenticationOk. Refused on every transport',
  auth_incomplete: 'authentication was attempted and did not complete',
  auth_not_attempted: 'the channel never opened, so authentication was never attempted',
  one_shot_http_no_wire_auth:
    'not applicable — it authenticates inside Neon from a header, not over the wire from here',
};

function wrap(text: string, indent: string, width = 96): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines.map((l) => indent + l).join('\n');
}

function render(report: ProbeReport): string {
  const out: string[] = [];
  const attestation = report.attestation;
  out.push('');
  out.push('='.repeat(100));
  out.push('  ASSUMPTION 4 PROBE — raw outbound TCP from a Cloudflare Container to Neon');
  out.push('='.repeat(100));
  out.push('');
  out.push(`  origin (claimed)    ${report.origin}${report.origin === 'local' ? '  (calibration — NOT a verdict)' : ''}`);
  out.push(
    `  origin corroborated ${String(attestation.originCorroborated)}${attestation.originCorroborated ? '' : '   <-- nothing below is a statement about Cloudflare'}`,
  );
  if (attestation.missing.length > 0) {
    for (const item of attestation.missing) out.push(wrap(`missing: ${item}`, ' '.repeat(22)));
  }
  out.push(`  cloudflare colo     ${attestation.cloudflareColo ?? '(none)'}`);
  out.push(`  worker saw cf/ray   cf=${String(attestation.workerSawCfObject)} ray_colo=${attestation.workerRayColo ?? '(none)'}`);
  out.push(`  cf container env    ${attestation.containerEnvMarkers.length > 0 ? attestation.containerEnvMarkers.join(' ') : '(none)'}`);
  if (report.driver !== null) {
    const d = report.driver;
    out.push(
      `  driver saw          scheme=${d.endpointScheme} host=${d.endpointHostShape} cf-ray=${String(d.cfRayPresent)}${d.cfRayColo === null ? '' : ` (${d.cfRayColo})`}`,
    );
    out.push(`  container verdict   ${d.containerVerdict ?? '(none)'}`);
  }
  out.push(`  runtime             bun ${String(report.environment['bun_version'])} on ${String(report.environment['platform'])}/${String(report.environment['arch'])}`);
  out.push(
    `  egress CA           present=${String(attestation.cloudflareEgressCaPresent)} trusted=${String(attestation.extraCaConfigured)}`,
  );
  out.push(`  target              ${report.target.hostFingerprint} (*.${report.target.hostSuffix}) port ${report.target.port}`);
  out.push(`  stage timeout       ${String(report.environment['stage_timeout_ms'])} ms`);
  out.push(`  elapsed             ${report.totalMs} ms`);
  out.push('');
  out.push('-'.repeat(100));
  out.push('  STAGES');
  out.push('-'.repeat(100));
  for (const stage of report.stages) {
    out.push(`${MARK[stage.status].padEnd(18)}${stage.id.padEnd(30)}${stage.ms}ms`);
    out.push(wrap(stage.proves, ' '.repeat(20)));
    const details = Object.entries(stage.detail).filter(([, v]) => v !== null && v !== '');
    if (details.length > 0) {
      out.push(`${' '.repeat(20)}[${details.map(([k, v]) => `${k}=${String(v)}`).join(' ')}]`);
    }
    if (stage.error !== null) out.push(wrap(`error: ${stage.error}`, ' '.repeat(20)));
  }
  out.push('');
  out.push('-'.repeat(100));
  out.push('  TRANSPORTS');
  out.push('-'.repeat(100));
  const rows: [string, keyof ProbeReport['transports']][] = [
    [`(a) raw TCP :${report.target.port}`.padEnd(24), 'rawTcpPostgresPort'],
    ['(b) postgres over wss   ', 'webSocket443'],
    ['    one-shot HTTP (ctrl)', 'httpOneShot443'],
  ];
  out.push(`${' '.repeat(28)}channel   authenticated   peer verified   session semantics`);
  for (const [label, key] of rows) {
    const t = report.transports[key];
    out.push(
      `  ${label}    ${String(t.channelOpen).padEnd(10)}${String(t.authenticated).padEnd(16)}${String(t.peerVerified).padEnd(16)}${String(t.sessionSemantics)}`,
    );
    // `peer verified: false` means several completely different things. Printing
    // the bare boolean without the reason is how (b) gets misread as carrying
    // (a)'s assurance, or as a failure when the endpoint simply has no mechanism
    // that could produce one.
    out.push(
      wrap(`peer_verification_reason=${t.peerVerificationReason} — ${PEER_REASON_TEXT[t.peerVerificationReason]}`, ' '.repeat(30)),
    );
  }
  out.push('');
  out.push(`  negative control    ${CONTROL_MEANING[report.negativeControl]}`);
  if (report.negativeControlAssertions !== null) {
    const a = report.negativeControlAssertions;
    out.push(
      `${' '.repeat(22)}control assertions: select_1=${String(a.selectOne)} ` +
        `set_local_readback=${String(a.setLocalReadback)} same_backend=${String(a.sameBackendInTxn)} ` +
        `local_scoped_out=${String(a.localScopedOut)} prepared_statement=${String(a.preparedStatement)}`,
    );
    out.push(
      wrap(
        'The two that must be false are set_local_readback and prepared_statement. same_backend ' +
          'may legitimately be true — Neon keeps warm backends, so two one-shot requests can land ' +
          'on the same pid without any session existing.',
        ' '.repeat(22),
      ),
    );
  }
  out.push('');
  out.push('='.repeat(100));
  out.push(`  VERDICT: ${report.verdict} — ${report.verdictMeaning.label}`);
  if (report.wouldBeVerdict !== null) {
    out.push(`  (on the same evidence, a container run would have reported ${report.wouldBeVerdict})`);
  }
  out.push('='.repeat(100));
  out.push('');
  out.push('  Assumption 4');
  out.push(wrap(report.verdictMeaning.assumption4, '    '));
  out.push('');
  out.push('  What the plan should do');
  out.push(wrap(report.verdictMeaning.planAction, '    '));
  if (report.notes.length > 0) {
    out.push('');
    out.push('  Notes');
    for (const note of report.notes) {
      out.push(wrap(`- ${note}`, '    '));
    }
  }
  out.push('');
  return out.join('\n');
}

/* ------------------------------------------------------------------------- */

const cli = parseCli(process.argv.slice(2));

let report: ProbeReport;
if (cli.local) {
  const dsn = process.env['PROBE_DATABASE_URL'];
  if (!dsn) fail('PROBE_DATABASE_URL is not set. Use the DIRECT (non-pooler) Neon connection string.');
  report = await runProbe({
    dsn,
    origin: 'local',
    colo: null,
    workerSawCfObject: false,
    workerRayColo: null,
    allowPooler: cli.allowPooler,
    allowNonStandardPort: cli.allowNonStandardPort,
    tlsInsecure: cli.tlsInsecure,
    stageTimeoutMs: cli.stageTimeoutMs,
  });
  // The receipt records what this probe's own WebSocket client did, so a later
  // container run that wants to claim (c) has something to check itself against.
  writeReceipt(report, RECEIPT_PATH);
} else {
  const remote = await fetchRemoteReport(cli);
  report = gateReport(remote.report, remote.evidence, RECEIPT_PATH);
}

if (cli.jsonOnly) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(render(report));
}

// `result-*.json` is gitignored, so the raw evidence stays on the machine that
// produced it while RESULT.md — the durable, redacted record — is committed.
const stamp = report.startedAt.replace(/[:.]/g, '-');
const outPath = cli.outPath ?? `${HERE}result-${report.origin}-${stamp}.json`;
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
if (!cli.jsonOnly) {
  process.stdout.write(`  raw report written to ${outPath}\n`);
  if (cli.local) process.stdout.write(`  calibration receipt written to ${RECEIPT_PATH}\n`);
  process.stdout.write('\n');
}

process.exit(report.verdictMeaning.exitCode);
