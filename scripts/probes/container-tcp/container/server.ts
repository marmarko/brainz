/**
 * The throwaway container's entrypoint.
 *
 * It exists only to give the Worker something to call inside the container, so
 * that the network stack being measured is genuinely the deployed container's
 * and not the Worker's. Three routes and no state.
 *
 * The connection string is NOT baked into the image and NOT passed as a
 * container environment variable. The Worker reads it from its own secret and
 * posts it with the request. That is a deliberate choice: container env is
 * captured at start, so a rotated secret would silently keep testing the old
 * credential until someone noticed the instance had never restarted.
 */

import { runProbe, type RunOptions } from './run.ts';

const PORT = Number.parseInt(process.env['PORT'] ?? '8080', 10);

/**
 * 15s, not 8s. The README's own sequence guarantees a COLD Neon compute on the
 * verdict run — calibrate (which wakes it), then `wrangler deploy` (minutes
 * under amd64 emulation on Apple Silicon), then run — and a wake that pushes
 * one backend-message wait past the deadline used to fail `tcp.authenticate`
 * and report a spurious inconclusive on a working platform.
 */
const DEFAULT_STAGE_TIMEOUT_MS = 15_000;
const MIN_STAGE_TIMEOUT_MS = 1_000;
const MAX_STAGE_TIMEOUT_MS = 60_000;

/**
 * Backstop only. Every network stage carries its own deadline, so this should
 * never fire; it is here because a hang would otherwise surface as a Cloudflare
 * 5xx with no report at all, which reads like a failed probe rather than a
 * failed request.
 *
 * DERIVED from the stage timeout rather than fixed: a fully-blocked egress path
 * spends its whole run in sequential timeouts (DNS, HTTPS, reachability, the
 * TCP transport, the 443 control, the WebSocket, the HTTP control), so a fixed
 * ceiling with a raised stage timeout would cut off the run and return a 504
 * with NO report — losing INCONCLUSIVE_NO_BASELINE_EGRESS exactly when it is
 * the answer.
 */
function overallDeadlineMs(stageTimeoutMs: number): number {
  return Math.min(300_000, Math.max(90_000, stageTimeoutMs * 10));
}

interface ProbeRequestBody {
  dsn?: unknown;
  colo?: unknown;
  workerSawCfObject?: unknown;
  workerRayColo?: unknown;
  allowPooler?: unknown;
  allowNonStandardPort?: unknown;
  stageTimeoutMs?: unknown;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return fallback;
}

function clampTimeout(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_STAGE_TIMEOUT_MS;
  return Math.min(MAX_STAGE_TIMEOUT_MS, Math.max(MIN_STAGE_TIMEOUT_MS, Math.round(value)));
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

async function handleProbe(request: Request): Promise<Response> {
  let body: ProbeRequestBody = {};
  try {
    const text = await request.text();
    if (text.trim() !== '') body = JSON.parse(text) as ProbeRequestBody;
  } catch {
    return json({ error: 'bad_request', detail: 'request body was not JSON' }, 400);
  }

  const dsn = typeof body.dsn === 'string' && body.dsn !== '' ? body.dsn : process.env['PROBE_DATABASE_URL'];
  if (dsn === undefined || dsn === '') {
    return json(
      {
        error: 'missing_dsn',
        detail:
          'No connection string. The Worker normally injects it from its PROBE_DATABASE_URL ' +
          'secret; set that with `wrangler secret put PROBE_DATABASE_URL`.',
      },
      400,
    );
  }

  const stageTimeoutMs = clampTimeout(body.stageTimeoutMs);
  const options: RunOptions = {
    dsn,
    // A CLAIM, not evidence — `container/run.ts:attest` is what decides whether
    // it is corroborated, from the three fields below plus the driver's own
    // observation of a `cf-ray` on the response.
    origin: 'container',
    colo: typeof body.colo === 'string' && body.colo !== '' ? body.colo : null,
    workerSawCfObject: bool(body.workerSawCfObject, false),
    workerRayColo: typeof body.workerRayColo === 'string' && body.workerRayColo !== '' ? body.workerRayColo : null,
    allowPooler: bool(body.allowPooler, process.env['PROBE_ALLOW_POOLER'] === '1'),
    allowNonStandardPort: bool(body.allowNonStandardPort, process.env['PROBE_ALLOW_NONSTANDARD_PORT'] === '1'),
    // Deliberately NOT accepted from the request body. The driver documents
    // `--tls-insecure` as a laptop-only escape hatch for a corporate MITM
    // proxy; honouring it over the wire would let a caller disable the
    // certificate check on the one run that settles the question.
    tlsInsecure: process.env['PROBE_TLS_INSECURE'] === '1',
    stageTimeoutMs,
  };

  const ceiling = overallDeadlineMs(stageTimeoutMs);
  const deadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), ceiling));
  const report = await Promise.race([runProbe(options), deadline]);
  if (report === null) {
    return json(
      {
        error: 'deadline_exceeded',
        detail: `the probe did not finish within ${ceiling}ms (stage timeout ${stageTimeoutMs}ms); ` +
          'every stage is individually bounded, so this indicates a bug in the probe rather than ' +
          'a network result. Nothing here is a statement about Cloudflare egress.',
      },
      504,
    );
  }
  return json(report, 200);
}

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok\n');
    if (url.pathname === '/probe' && request.method === 'POST') return handleProbe(request);
    return new Response(
      'brainz Assumption 4 probe container.\n' +
        '  GET  /health\n' +
        '  POST /probe   {"dsn", "colo", "workerSawCfObject", "workerRayColo",\n' +
        '                 "allowPooler", "allowNonStandardPort", "stageTimeoutMs"}\n' +
        '                 — normally posted by the Worker, which is the only thing\n' +
        '                   that can observe the Cloudflare attestation fields.\n',
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  },
});

// stdout from the container is visible in `wrangler tail`, which is the only
// way to see that the image actually started when a deploy goes wrong.
console.log(`[assumption4-probe] listening on :${PORT}`);
