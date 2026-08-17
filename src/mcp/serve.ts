#!/usr/bin/env bun
/**
 * The MCP fleet's process entrypoint — the one the image's `CMD` names.
 *
 * **What was here before, and why this file is not a formality.** The Dockerfile
 * ran `bun run src/mcp/server.ts`, a module that only *exports*
 * `createMcpServer`. Executed, it evaluated some definitions and exited `0`:
 * empty stdout, nothing on :8080, and a container platform reporting a healthy
 * start of a process that served nothing. Every test in the repo composed the
 * server in memory and called `fetch` on the returned object, so none of them
 * could see it. This file is the composition root that was missing: it reads the
 * environment, builds the real dependencies, binds the socket, and says so.
 *
 * **A composition root, and only a composition root.** No routing decision, no
 * scope check and no policy lives here — those are `server.ts`, `dispatch.ts`
 * and the accessors below them, and a second copy at the wiring layer is a
 * second place to get them wrong. What this file owns is the answer to "which
 * implementation of each port does the deployed process get", which is a
 * question no unit test can answer on its behalf.
 *
 * **Two ports are wired to in-memory implementations, deliberately and
 * visibly.** The authorization store and the access log have no durable
 * implementation in this repo yet (`oauth.ts` and `access-log.ts` each say so in
 * their own headers, and the access log's retention policy has a legal half that
 * is not settled). Wiring them here to the in-memory implementations is honest
 * about a single-instance alpha and is wrong for a multi-instance fleet: an
 * OAuth code minted on one instance cannot be redeemed on another, and the
 * access log does not survive a restart. Both are `record`-shaped ports, so the
 * durable versions are substitutions here rather than redesigns.
 */

import { SQL } from 'bun';

import { createMcpServer, type ResourceOwners } from './server.ts';
import { createInMemoryAccessLog } from './access-log.ts';
import { createControlSignals, createPostgresSignalSink } from './control-signals.ts';
import { createInMemoryAuthorizationStore } from './oauth.ts';
import { createSettingsBackend } from './settings.ts';
import { hashToken } from './oauth.ts';
import { createTenantConnections } from './tenant-db.ts';
import { brainOf, resolveSession } from '../control/accounts.ts';
import { readCookie, SESSION_COOKIE } from '../web/app.ts';
import { openControlPlane, openFleetGateway, openSecretStore } from '../fleet/compose.ts';
import {
  announceListening,
  integer,
  list,
  optional,
  origin,
  port,
  refuseToStart,
  type Environment,
} from '../fleet/env.ts';

export interface McpFleetProcess {
  readonly port: number;
  stop(): Promise<void>;
}

/**
 * Build and bind. Exported so the shape is testable and so a future single-image
 * multiplexer could host it, but the module's own `import.meta.main` block below
 * is what the container runs.
 */
export async function startMcpFleet(env: Environment): Promise<McpFleetProcess> {
  const issuer = origin(env, 'BRAINZ_PUBLIC_ORIGIN');
  const controlSql = openControlPlane(env);
  const secrets = openSecretStore(env);
  const gateway = openFleetGateway(env, { controlSql, keys: secrets.providerKeys });

  // **Optional, and unset in the deployed fleet today — read the note on
  // {@link sessionResourceOwners} before setting it.** `required` here would
  // refuse to start every process that does not serve a browser flow, including
  // the one the image currently runs.
  const identityUrl = optional(env, 'BRAINZ_IDENTITY_DATABASE_URL');
  const identity = identityUrl === undefined ? undefined : new SQL(identityUrl, { max: 4 });

  const connections = createTenantConnections({ secrets: secrets.store, now: Date.now });
  const signals = createControlSignals({
    sink: createPostgresSignalSink(controlSql),
    now: Date.now,
  });

  const server = createMcpServer({
    secrets: secrets.store,
    connections,
    store: createInMemoryAuthorizationStore(),
    accessLog: createInMemoryAccessLog(),
    signals,
    gateway,
    settings: createSettingsBackend(controlSql),
    now: () => new Date(),
    issuer,
    // Empty by default, which refuses every dynamic registration. That is the
    // fail-closed direction for an endpoint whose whole job is to hand out
    // client credentials: an operator who wants one names the redirect.
    registrationAllowlist: {
      redirectUris: list(env, 'BRAINZ_OAUTH_REDIRECT_URIS'),
      maxRegistrationsPerHour: integer(env, 'BRAINZ_OAUTH_MAX_REGISTRATIONS_PER_HOUR', 0),
    },
    ...(optional(env, 'BRAINZ_WEB_APP_BASE_URL') === undefined
      ? {}
      : { webAppBaseUrl: optional(env, 'BRAINZ_WEB_APP_BASE_URL') as string }),
    ...(identity === undefined ? {} : { resourceOwners: sessionResourceOwners(identity) }),
  });

  const http = Bun.serve({
    port: port(env),
    // `hostname` is explicit because the platform's readiness probe dials the
    // instance from outside it; a process bound to loopback passes every local
    // check and is unreachable.
    hostname: '0.0.0.0',
    fetch(request: Request): Promise<Response> | Response {
      // The readiness route, ahead of the server. Cloudflare's readiness is a
      // port poll against the class's `pingEndpoint`, and `server.fetch` answers
      // 404 for everything it does not route — which a poll would read as
      // "listening" but a human debugging a deploy would not.
      if (new URL(request.url).pathname === '/health') {
        return Response.json({ ok: true, service: 'mcp' });
      }
      return server.fetch(request);
    },
  });

  // The port the socket actually bound, off the server's own URL: with `PORT=0`
  // the OS chooses it, so a caller that echoed the configured value would report
  // `0` and a harness would dial nothing.
  const bound = Number(http.url.port);
  announceListening({ service: 'mcp', port: bound });

  return {
    port: bound,
    async stop() {
      await http.stop(true);
      await controlSql.close();
      await identity?.close();
    },
  };
}

/**
 * The browser half of `/authorize`, over the identity database.
 *
 * **This is the one dependency of the consent flow that the deployment does not
 * currently supply, and it is a decision rather than an oversight to inherit.**
 * `src/mcp/router.ts:MCP_FLEET_VARIABLES` deliberately withholds
 * `BRAINZ_IDENTITY_DATABASE_URL` from this fleet — `test/fleet/router-env.test.ts`
 * asserts its absence in both directions, on the argument that the process
 * parsing attacker-supplied mail should not hold the credential store of every
 * account. Wiring a browser consent screen onto that same process is in tension
 * with it, and resolving the tension belongs to whoever owns the manifest: it is
 * either identity on this fleet, or the consent surface moves to the web fleet
 * and the two exchange a signed assertion. Until then this reads the variable if
 * it is set and the browser leg answers `401` if it is not, which is exactly what
 * it answered before the leg existed.
 *
 * **The session token never leaves this function.** `sessionKey` is a digest of
 * it, so the consent token derived from that is bound to the session without the
 * surface above ever holding the credential itself.
 */
export function sessionResourceOwners(sql: SQL): ResourceOwners {
  return {
    async resolve(cookieHeader) {
      const token = readCookie(cookieHeader, SESSION_COOKIE);
      if (token === null) return null;
      // The identity store's own reader: it enforces both the idle and the
      // absolute bound and stamps `last_seen_at`, and a second query written
      // here would be a second session policy.
      const session = await resolveSession(sql, { token, now: new Date() });
      if (!session.ok) return null;
      const brain = await brainOf(sql, session.accountId);
      return {
        accountId: session.accountId,
        tenantId: brain?.tenantId ?? null,
        sessionKey: hashToken(token),
      };
    },
  };
}

if (import.meta.main) {
  try {
    await startMcpFleet(process.env);
  } catch (error) {
    refuseToStart(error);
  }
}
