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
 *             onto an expensive no-branch it did not need.
 *
 *   (default) VERDICT. Calls the deployed Worker, which runs the probe inside a
 *             deployed Cloudflare Container. This is the only run that settles
 *             Assumption 4.
 *
 * Exit codes are meaningful, so this can be scripted:
 *   0  (a) raw TCP works                     10 (b) WebSocket only
 *   20 (c) both blocked                      30 inconclusive — do not branch
 *   40 the probe could not run at all
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runProbe } from './container/run.ts';
import type { ProbeReport, StageResult } from './container/report.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url).href);

interface Cli {
  local: boolean;
  jsonOnly: boolean;
  allowPooler: boolean;
  tlsInsecure: boolean;
  stageTimeoutMs: number;
  outPath: string | null;
}

function parseCli(argv: readonly string[]): Cli {
  const cli: Cli = {
    local: false,
    jsonOnly: false,
    allowPooler: process.env['PROBE_ALLOW_POOLER'] === '1',
    tlsInsecure: process.env['PROBE_TLS_INSECURE'] === '1',
    stageTimeoutMs: 8_000,
    outPath: null,
  };
  for (const arg of argv) {
    if (arg === '--local') cli.local = true;
    else if (arg === '--json') cli.jsonOnly = true;
    else if (arg === '--allow-pooler') cli.allowPooler = true;
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
  PROBE_ALLOW_POOLER=1   run against a -pooler endpoint anyway (the result will be wrong)
  PROBE_TLS_INSECURE=1   skip TLS certificate verification (corporate MITM proxies)

Flags
  --json                 print the report JSON only
  --timeout=<ms>         per-stage deadline (default 8000)
  --out=<path>           where to write the result JSON
`;

function fail(message: string): never {
  process.stderr.write(`\nprobe: ${message}\n`);
  process.exit(40);
  // Unreachable. `process.exit` is not declared as `never` under this project's
  // type configuration, and a `never` function needs an unreachable end point.
  throw new Error(message);
}

async function fetchRemoteReport(cli: Cli): Promise<ProbeReport> {
  const base = process.env['PROBE_URL'];
  const token = process.env['PROBE_AUTH_TOKEN'];
  if (!base) fail('PROBE_URL is not set. Deploy the Worker first — see the README.');
  if (!token) fail('PROBE_AUTH_TOKEN is not set. Use the same value you gave `wrangler secret put`.');

  const url = new URL('/probe', base).toString();
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ allowPooler: cli.allowPooler, stageTimeoutMs: cli.stageTimeoutMs }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (error) {
    fail(
      `could not reach ${new URL(base).origin} — ${error instanceof Error ? error.message : String(error)}\n` +
        '  A cold container can take a while on the first call after a deploy. Retry once.',
    );
  }

  const text = await response.text();
  if (!response.ok) {
    fail(`the Worker answered HTTP ${response.status}:\n${text.slice(0, 1200)}`);
  }
  try {
    return JSON.parse(text) as ProbeReport;
  } catch {
    return fail(`the Worker did not return a report:\n${text.slice(0, 1200)}`);
  }
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
  out.push('');
  out.push('='.repeat(100));
  out.push('  ASSUMPTION 4 PROBE — raw outbound TCP from a Cloudflare Container to Neon');
  out.push('='.repeat(100));
  out.push('');
  out.push(`  origin              ${report.origin}${report.origin === 'local' ? '  (calibration — NOT a verdict)' : ''}`);
  out.push(`  cloudflare colo     ${report.environment['cloudflare_colo'] ?? '(none)'}`);
  out.push(`  runtime             bun ${String(report.environment['bun_version'])} on ${String(report.environment['platform'])}/${String(report.environment['arch'])}`);
  out.push(`  egress CA present   ${String(report.environment['cloudflare_egress_ca_present'])}`);
  out.push(`  target              ${report.target.hostFingerprint} (*.${report.target.hostSuffix}) port ${report.target.port}`);
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
  const rows: [string, string][] = [
    ['(a) raw TCP :5432       ', 'rawTcp5432'],
    ['(b) postgres over wss   ', 'webSocket443'],
    ['    one-shot HTTP (ctrl)', 'httpOneShot443'],
  ];
  out.push(`${' '.repeat(28)}channel   authenticated   session semantics`);
  for (const [label, key] of rows) {
    const t = report.transports[key as keyof ProbeReport['transports']];
    out.push(
      `  ${label}    ${String(t.channelOpen).padEnd(10)}${String(t.authenticated).padEnd(16)}${String(t.sessionSemantics)}`,
    );
  }
  out.push('');
  out.push('='.repeat(100));
  out.push(`  VERDICT: ${report.verdictMeaning.label}`);
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
    allowPooler: cli.allowPooler,
    tlsInsecure: cli.tlsInsecure,
    stageTimeoutMs: cli.stageTimeoutMs,
  });
} else {
  report = await fetchRemoteReport(cli);
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
if (!cli.jsonOnly) process.stdout.write(`  raw report written to ${outPath}\n\n`);

process.exit(report.verdictMeaning.exitCode);
