/**
 * The Worker in front of the throwaway probe container.
 *
 * Containers are reached *through* a Worker — a Durable Object routes to the
 * instance — so this file is not optional scaffolding, it is the only way to
 * make a container run at all. It mirrors the shape the real fleet uses
 * (Worker -> DO -> Container, KTD2) so the thing being measured is the same
 * runtime the plan intends to ship on.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not open any connection itself. If the Worker connected to Neon, the
 * result would describe the Workers runtime — which has its own outbound socket
 * rules — and would say nothing about Containers. Every byte measured is
 * emitted from inside the container.
 *
 * FAIL CLOSED
 * -----------
 * This endpoint runs SQL against a real Neon project and returns diagnostics.
 * Its `*.workers.dev` URL is public and guessable. So a missing bearer token is
 * a refusal, never a default-open, and the DSN is never echoed back.
 */

import { Container } from '@cloudflare/containers';

interface ProbeEnv {
  PROBE_CONTAINER: DurableObjectNamespace<ContainerTcpProbe>;
  /** `wrangler secret put PROBE_DATABASE_URL` — the throwaway Neon DSN. */
  PROBE_DATABASE_URL?: string;
  /** `wrangler secret put PROBE_AUTH_TOKEN` — any random string you also pass locally. */
  PROBE_AUTH_TOKEN?: string;
  /** `"1"` to allow a `-pooler` DSN. Off by default; see container/battery.ts. */
  PROBE_ALLOW_POOLER?: string;
  /** `"1"` to allow a DSN whose port is not 5432. Off by default. */
  PROBE_ALLOW_NONSTANDARD_PORT?: string;
}

/** The knobs the driver is allowed to set per call. */
interface ClientOptions {
  allowPooler?: unknown;
  allowNonStandardPort?: unknown;
  stageTimeoutMs?: unknown;
}

export class ContainerTcpProbe extends Container<ProbeEnv> {
  override defaultPort = 8080;

  /**
   * Short on purpose. This is a throwaway that should cost nothing between the
   * two or three times it is invoked, and a cold start costs seconds, not
   * correctness — nothing here is latency-sensitive.
   */
  override sleepAfter = '2m';

  /**
   * Set explicitly rather than inherited. The platform default is `true`, but
   * this single flag is the difference between "Cloudflare blocks raw TCP" and
   * "this container had no internet at all", and a probe whose central negative
   * result could be caused by an unstated default is not evidence.
   */
  override enableInternet = true;

  override envVars = { PORT: '8080' };
}

/** Length-independent-ish comparison; the token is not a password but is a bearer. */
function tokensMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const expected = env.PROBE_AUTH_TOKEN;
    if (expected === undefined || expected === '') {
      return json(
        {
          error: 'probe_not_configured',
          detail:
            'PROBE_AUTH_TOKEN is not set, so this endpoint refuses every request. Set it with ' +
            '`wrangler secret put PROBE_AUTH_TOKEN` (any random string) and pass the same value ' +
            'as PROBE_AUTH_TOKEN when running `bun run probe:container-tcp`.',
        },
        503,
      );
    }

    const header = request.headers.get('authorization') ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!tokensMatch(presented, expected)) {
      return json(
        {
          error: 'unauthorized',
          detail:
            'The bearer token did not match. The usual cause is a trailing newline captured by ' +
            "`echo 'tok' | wrangler secret put PROBE_AUTH_TOKEN` — use `printf %s 'tok' | ...` or " +
            'paste it at the interactive prompt. The other usual cause is a shell variable that ' +
            'was never exported. Nothing about the expected value is disclosed here.',
        },
        401,
      );
    }

    const url = new URL(request.url);
    if (url.pathname !== '/probe' || request.method !== 'POST') {
      return json(
        { error: 'not_found', detail: 'POST /probe is the only route.' },
        404,
      );
    }

    // The driver's per-call knobs used to be dropped on the floor here: this
    // handler built a fresh body and never read the request. `--timeout` and
    // `--allow-pooler` were therefore inert in the ONLY mode that settles the
    // question, and the README documented them as if they worked.
    let clientOptions: ClientOptions = {};
    try {
      const text = await request.text();
      if (text.trim() !== '') clientOptions = JSON.parse(text) as ClientOptions;
    } catch {
      return json({ error: 'bad_request', detail: 'the request body was not JSON.' }, 400);
    }

    const dsn = env.PROBE_DATABASE_URL;
    if (dsn === undefined || dsn === '') {
      return json(
        {
          error: 'missing_dsn',
          detail:
            'PROBE_DATABASE_URL is not set. Set it with `wrangler secret put PROBE_DATABASE_URL` ' +
            'using the DIRECT (non-pooler) connection string of a throwaway Neon project.',
        },
        400,
      );
    }

    // WHERE DID THIS ACTUALLY RUN?
    //
    // The container stamps `origin: 'container'` on its own report, which is a
    // claim and not evidence: `wrangler dev` runs the identical image in local
    // Docker, and that run would produce the same claim from a laptop. So the
    // Worker forwards what it can independently observe, and the container's
    // verdict refuses to be conclusive without it. The cast keeps this file
    // free of a workers-types import.
    const cf = (request as unknown as { cf?: { colo?: string } }).cf;
    const colo = cf?.colo ?? null;
    // `cf-ray` is added by Cloudflare's edge on the way in. It is absent on a
    // request served by a local dev server. Only the trailing colo is kept —
    // the ray id itself is an identifier and this report is headed for a public
    // repo.
    const ray = request.headers.get('cf-ray');
    const rayColo = ray !== null && ray.includes('-') ? (ray.split('-').pop() ?? null) : null;

    // One fixed instance name: this probe has no tenants, and the affinity that
    // matters to KTD2 is not what is being measured here.
    const id = env.PROBE_CONTAINER.idFromName('assumption-4');
    return env.PROBE_CONTAINER.get(id).fetch(
      new Request('http://container/probe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          dsn,
          colo,
          workerSawCfObject: cf !== undefined && cf !== null,
          workerRayColo: rayColo,
          // EITHER source enables these — the per-call flag OR the Worker
          // secret. They are loosening-only escape hatches, and the driver
          // always sends an explicit boolean, so "the call wins" would have
          // made the secret dead in the one mode that settles the question,
          // which is the same class of bug as the shell flag being inert.
          allowPooler: clientOptions.allowPooler === true || env.PROBE_ALLOW_POOLER === '1',
          allowNonStandardPort:
            clientOptions.allowNonStandardPort === true || env.PROBE_ALLOW_NONSTANDARD_PORT === '1',
          stageTimeoutMs:
            typeof clientOptions.stageTimeoutMs === 'number' ? clientOptions.stageTimeoutMs : undefined,
        }),
      }),
    );
  },
};
