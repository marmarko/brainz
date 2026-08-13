/**
 * A local brainz MCP server for the conformance runner to certify.
 *
 * U7's gates half "needs a running server", and this is it: the real
 * `createMcpServer` over the real dispatch, the real tenant schema, the real
 * secret store and the real control plane, on an ephemeral port. What is faked
 * is the network and the model — the two things a credential-free CI job may not
 * have — which is exactly the boundary `test/mcp/fixture.ts` already draws.
 *
 * **The fixture is imported, never re-implemented.** Composing a second set of
 * `DispatchDeps` here would mean the surface gbrain certifies is not the surface
 * the suite exercises, and the first drift between them would be invisible in
 * both directions. That is the same argument `test/core/search/corpus-ranker.ts`
 * makes for being the one adapter U7's harness and U5's tests share.
 *
 * It needs `DATABASE_URL` — a real Postgres with pgvector. There is no in-memory
 * fallback on purpose: a conformance verdict produced against a stand-in engine
 * is the hazard-ledger's "dev engine masks remote engine" card, wearing a
 * different hat.
 */

import { createMcpServer } from '../../src/mcp/server.ts';
import { createMcpFixture, type McpFixture } from '../../test/mcp/fixture.ts';

export interface LocalServer {
  /** The `--target` gbrain's runner is pointed at. */
  readonly url: string;
  /** The provisioned tenant bearer, passed as `--token`. */
  readonly token: string;
  readonly tenantId: string;
  close(): Promise<void>;
}

export interface LocalServerOptions {
  /** 0 asks the OS for a free port, which is what a CI job wants. */
  readonly port?: number;
  readonly slug?: string;
}

export async function startLocalServer(options: LocalServerOptions = {}): Promise<LocalServer> {
  if (!process.env['DATABASE_URL']) {
    throw new Error(
      'DATABASE_URL is not set; the conformance target is a real brainz server over a real tenant schema, ' +
        'and a verdict produced against a stand-in engine would not be a conformance verdict',
    );
  }

  let fixture: McpFixture | undefined;
  try {
    fixture = await createMcpFixture(options.slug ?? 'conformance');
  } catch (error) {
    throw new Error(
      `could not provision the conformance tenant: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const provisioned = fixture;

  const port = options.port ?? 0;
  // The issuer has to be the address the client actually reaches, because the
  // discovery documents echo it. Bound after listen so an ephemeral port lands
  // in the metadata rather than a guess.
  const http = Bun.serve({
    port,
    fetch(request) {
      return server.fetch(request);
    },
  });
  const issuer = `http://127.0.0.1:${http.port}`;

  const server = createMcpServer({
    ...provisioned.deps,
    issuer,
    // Empty on purpose: the runner authenticates with the provisioned bearer
    // rather than through the OAuth flow, so dynamic client registration has no
    // use case here and an allowlist with entries would be a credential-shaped
    // string in a public repo for nothing.
    registrationAllowlist: { redirectUris: [], maxRegistrationsPerHour: 0 },
  });

  return {
    url: `${issuer}/mcp`,
    token: provisioned.bearer,
    tenantId: provisioned.tenantId,
    async close() {
      await http.stop(true);
      await provisioned.close();
    },
  };
}
