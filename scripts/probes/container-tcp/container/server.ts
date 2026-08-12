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
 * Backstop only. Every network stage carries its own deadline, so this should
 * never fire; it is here because a hang would otherwise surface as a Cloudflare
 * 5xx with no report at all, which reads like a failed probe rather than a
 * failed request.
 */
const OVERALL_DEADLINE_MS = 90_000;
const DEFAULT_STAGE_TIMEOUT_MS = 8_000;

interface ProbeRequestBody {
  dsn?: unknown;
  colo?: unknown;
  allowPooler?: unknown;
  tlsInsecure?: unknown;
  stageTimeoutMs?: unknown;
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return fallback;
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

  const options: RunOptions = {
    dsn,
    origin: 'container',
    colo: typeof body.colo === 'string' ? body.colo : null,
    allowPooler: bool(body.allowPooler, process.env['PROBE_ALLOW_POOLER'] === '1'),
    tlsInsecure: bool(body.tlsInsecure, process.env['PROBE_TLS_INSECURE'] === '1'),
    stageTimeoutMs:
      typeof body.stageTimeoutMs === 'number' && body.stageTimeoutMs > 0
        ? body.stageTimeoutMs
        : DEFAULT_STAGE_TIMEOUT_MS,
  };

  const deadline = new Promise<null>((resolve) => setTimeout(() => resolve(null), OVERALL_DEADLINE_MS));
  const report = await Promise.race([runProbe(options), deadline]);
  if (report === null) {
    return json(
      {
        error: 'deadline_exceeded',
        detail: `the probe did not finish within ${OVERALL_DEADLINE_MS}ms; every stage is ` +
          'individually bounded, so this indicates a bug in the probe rather than a network result',
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
        '  POST /probe   {"dsn": "postgresql://...", "colo": "..."}\n',
      { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  },
});

// stdout from the container is visible in `wrangler tail`, which is the only
// way to see that the image actually started when a deploy goes wrong.
console.log(`[assumption4-probe] listening on :${PORT}`);
