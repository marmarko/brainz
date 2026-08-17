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
  const secrets = await openSecretStore(env, controlSql);
  const gateway = openFleetGateway(env, { controlSql, keys: secrets.providerKeys });

  // **Set in the deployed fleet, and still `optional` rather than `required`.**
  // The deployment's manifest carries it (`router.ts:MCP_FLEET_VARIABLES`), so
  // the browser leg is live — but a `required` here would refuse to start every
  // process that serves no browser flow: a self-hosted single-tenant instance, a
  // test harness, an operator running the image with a bearer-only client. The
  // browser leg is a capability this process may or may not have, and `optional`
  // is how that is spelled. What it must never become is silently absent in a
  // deployment that means to serve consent — which is why the manifest is where
  // the decision is written down and `router-env.test.ts` is what pins it.
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
 * **The tension this function used to leave open has been resolved, in the
 * direction that costs something.** `src/mcp/router.ts:MCP_FLEET_VARIABLES` now
 * carries `BRAINZ_IDENTITY_DATABASE_URL`, so this runs in the deployed fleet and
 * a browser can complete a connect flow. It previously withheld it, on the
 * argument that the process parsing attacker-supplied content should not hold
 * the credential store of every account — an argument that was not wrong, and
 * whose cost has simply been paid instead: an MCP instance compromise now
 * reaches accounts, password digests and sessions.
 *
 * It was paid because `edge.ts` routes `/authorize` here. Without the DSN this
 * function is never constructed, `deps.resourceOwners` is `undefined`, and the
 * browser leg answers `401` — the connector's *first* hop, so the whole flow is
 * unreachable from a browser rather than degraded.
 *
 * **The other design is still the better one and is still unbuilt.** Move the
 * consent surface to the web fleet, which already owns identity, and have the
 * two fleets exchange a signed assertion over the shared secret store; the MCP
 * fleet then verifies an assertion instead of holding a database. It needs a new
 * web path and a matching `edge.ts` entry — a build, not a manifest line — and
 * when it lands, that manifest line comes back out.
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
