/**
 * What a fleet process reads out of its environment, and what it refuses to
 * start without.
 *
 * **Every missing variable is a refusal, never a default.** That direction is
 * the whole point of this module: a fleet that defaults its control-plane URL,
 * its public origin or its webhook secret starts successfully and is wrong — an
 * empty signing secret yields a deterministic HMAC anybody can compute
 * (`billing.ts` refuses it for exactly that reason), and a guessed origin is
 * baked into OAuth discovery documents that a connector then binds to. A process
 * that will not start is an outage somebody fixes in a minute; a process that
 * starts misconfigured is an incident nobody notices.
 *
 * The refusal names the variable, because the operator reading it is looking at
 * a container log with no other context.
 */

export type Environment = Readonly<Record<string, string | undefined>>;

export class FleetConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, detail: string) {
    super(`${variable} ${detail}`);
    this.name = 'FleetConfigError';
    this.variable = variable;
  }
}

/** A required variable. Absent or empty are the same thing and both refuse. */
export function required(env: Environment, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new FleetConfigError(name, 'is required and was not set');
  }
  return value.trim();
}

/** An optional variable. Empty reads as absent — an unset var and one set to '' are the same intent. */
export function optional(env: Environment, name: string): string | undefined {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) return undefined;
  return value.trim();
}

/**
 * A non-negative integer, or a refusal.
 *
 * A malformed number is refused rather than coerced: `Number('eight')` is `NaN`,
 * and a pool target or a tick interval of `NaN` is a silent behaviour change
 * that reads as a bug in the code somebody set the variable to configure.
 */
export function integer(env: Environment, name: string, fallback: number): number {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new FleetConfigError(name, `must be a non-negative integer, not ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * The listening port.
 *
 * `8080` matches the Dockerfile's `EXPOSE` and the Container class's
 * `defaultPort`; `0` asks the OS for a free one, which is what a test harness
 * passes and why the bound port is reported rather than assumed.
 */
export function port(env: Environment): number {
  return integer(env, 'PORT', 8080);
}

/**
 * An origin, validated as one.
 *
 * OAuth discovery documents embed this verbatim and a connector binds to what it
 * reads, so a trailing slash or a path segment here is a mismatch that surfaces
 * days later as a client refusing an issuer. Normalising quietly would hide the
 * misconfiguration; refusing names it.
 */
export function origin(env: Environment, name: string): string {
  const raw = required(env, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FleetConfigError(name, `must be an absolute URL, not ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FleetConfigError(name, `must be http or https, not ${JSON.stringify(url.protocol)}`);
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new FleetConfigError(name, `must be a bare origin with no path, not ${JSON.stringify(raw)}`);
  }
  return url.origin;
}

/**
 * A vendor API base, which is an origin *plus a path* and therefore not an
 * {@link origin}.
 *
 * The two are separated deliberately rather than by loosening `origin`. What
 * `origin` guards is a value that gets *published* — an OAuth issuer a connector
 * binds to — where a stray path segment is a mismatch surfacing days later at
 * somebody else's token endpoint. An API base is the opposite: it is consumed,
 * never published, and the real ones carry a version path (`…/api/v2`), so
 * refusing a path would make the shipped default unexpressible and force every
 * operator who wants to point at a proxy or a local double to give up
 * validation entirely.
 *
 * A trailing slash is stripped rather than refused, because every call site
 * appends a rooted path and `…/v2//projects` is a 404 an operator cannot see in
 * their own configuration. Query strings and fragments are refused: they cannot
 * survive concatenation with a path, so accepting one would build a URL nobody
 * asked for.
 */
export function apiBase(env: Environment, name: string): string {
  const raw = required(env, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new FleetConfigError(name, `must be an absolute URL, not ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new FleetConfigError(name, `must be http or https, not ${JSON.stringify(url.protocol)}`);
  }
  if (url.search !== '' || url.hash !== '') {
    throw new FleetConfigError(
      name,
      `must carry no query string or fragment, unlike ${JSON.stringify(raw)}`,
    );
  }
  return `${url.origin}${url.pathname}`.replace(/\/$/, '');
}

/** A comma-separated list. Absent is empty, which is a meaningful allowlist. */
export function list(env: Environment, name: string): readonly string[] {
  const raw = optional(env, name);
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export interface Listening {
  readonly service: string;
  readonly port: number;
}

/**
 * The one line every entrypoint prints once its socket is bound.
 *
 * On **stdout**, as JSON, and after the bind rather than before it. That is what
 * makes readiness observable to something other than a port scan: a supervisor,
 * a test harness or a human reading `docker logs` all learn the same fact from
 * the same line, and a process that printed nothing has demonstrably not bound.
 */
export function announceListening(listening: Listening): void {
  process.stdout.write(`${JSON.stringify({ event: 'listening', ...listening })}\n`);
}

/**
 * Report a configuration refusal and exit non-zero.
 *
 * Non-zero matters: a container platform restarts and then reports a crash loop,
 * which is visible. `exit(0)` on a misconfiguration is the fleet image's original
 * failure — a process that ends successfully having served nothing.
 */
export function refuseToStart(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`refusing to start: ${message}\n`);
  process.exit(1);
}
