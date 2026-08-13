/**
 * Shared harness for the U6 suite. Not a `*.test.ts` file.
 *
 * **Everything below the tool handlers is real.** A real tenant database at the
 * head of the ladder (so the origin fence, the immutability triggers and the
 * soft-delete columns are all enforcing), a real control-plane database (so the
 * consolidation signals land in the columns U10's scheduler reads), the real
 * secret store with its per-tenant resolve boundary, and the real gateway with
 * an injected transport. What is faked is the network and the model, which are
 * the two things a blocking test may not have.
 *
 * **The clock is injected everywhere.** Tombstone TTLs, the activity-stamp
 * throttle and token expiry are all time-dependent, and a suite that waits is a
 * suite that flakes.
 */

import { SQL } from 'bun';

import {
  createInMemorySecretBackend,
  createTenantSecretStore,
  controlPlaneIdentity,
  type TenantSecretStore,
} from '../../src/control/secrets.ts';
import {
  createInMemoryAccessLog,
  type InMemoryAccessLog,
} from '../../src/mcp/access-log.ts';
import {
  createControlSignals,
  createPostgresSignalSink,
  type ControlSignals,
  type SignalSink,
} from '../../src/mcp/control-signals.ts';
import { dispatch, type DispatchDeps, type DispatchResult } from '../../src/mcp/dispatch.ts';
import {
  createInMemoryAuthorizationStore,
  mintTenantBearer,
  type AuthorizationStore,
} from '../../src/mcp/oauth.ts';
import { createTenantConnections, type TenantConnections } from '../../src/mcp/tenant-db.ts';
import type { Endpoint } from '../../src/mcp/tools/index.ts';
import { createControlPlane, dropControlPlane, seedTenant, type ControlFixture } from '../worker/fixture.ts';
import { createGateway, type GatewayHarness } from '../core/write/fixture.ts';
import { connect, dropFixtureDatabase, provisionFixture, type SchemaFixture } from '../schema/fixture.ts';

export { seedEntity, seedFact, seedPage } from '../core/search/fixture.ts';

/** Where an MCP `remember` lands. First-party by construction (see demarcation.ts). */
export const AGENT_ORIGIN = 'personal:agent';

export interface McpFixture {
  readonly tenantId: string;
  readonly bearer: string;
  readonly schema: SchemaFixture;
  readonly control: ControlFixture;
  readonly sql: SQL;
  readonly controlSql: SQL;
  readonly secrets: TenantSecretStore;
  readonly store: AuthorizationStore;
  readonly accessLog: InMemoryAccessLog;
  readonly signals: ControlSignals;
  readonly gateway: GatewayHarness;
  readonly connections: TenantConnections;
  readonly deps: DispatchDeps;
  /** Milliseconds since epoch, moved by {@link advance}. */
  now(): number;
  advance(ms: number): void;
  call(
    tool: string,
    args?: Record<string, unknown>,
    options?: { readonly authorization?: string | null; readonly endpoint?: Endpoint },
  ): Promise<DispatchResult>;
  close(): Promise<void>;
}

export interface McpFixtureOptions {
  readonly tenantId?: string;
  readonly endpoint?: Endpoint;
  readonly startAt?: number;
  /**
   * Stop the tenant's ladder partway up, so the request path can be asked what
   * it does with a tenant whose schema this fleet does not understand. There is
   * no other way to build that state: provisioning runs the whole ladder.
   */
  readonly schemaVersion?: number;
  /** Swap the signal sink to observe or to break it. */
  readonly sink?: (control: SQL) => SignalSink;
}

const DEFAULT_START = Date.UTC(2026, 7, 13, 9, 0, 0);

export async function createMcpFixture(
  slug: string,
  options: McpFixtureOptions = {},
): Promise<McpFixture> {
  const tenantId = options.tenantId ?? `t-${slug.replace(/_/g, '-')}`;
  const schema = await provisionFixture(
    slug,
    options.schemaVersion === undefined ? {} : { targetVersion: options.schemaVersion },
  );
  const control = await createControlPlane(slug);
  const sql = connect(schema);
  const controlSql = new SQL(control.dsn, { max: 1 });
  await seedTenant(controlSql, tenantId);

  let clock = options.startAt ?? DEFAULT_START;
  const now = (): number => clock;

  const bearer = mintTenantBearer(tenantId);
  const secrets = createTenantSecretStore({ backend: createInMemorySecretBackend(), now });
  await secrets.put(controlPlaneIdentity(), tenantId, {
    connectionString: schema.dsn,
    bearerGrant: bearer,
  });

  const gateway = createGateway();
  const accessLog = createInMemoryAccessLog();
  const sink = (options.sink ?? createPostgresSignalSink)(controlSql);
  const signals = createControlSignals({ sink, now });
  const store = createInMemoryAuthorizationStore();

  // One connection, handed out by the real accessor so `cold_start` is the
  // accessor's own cache-miss signal rather than a flag a test sets.
  const connections = createTenantConnections({
    secrets,
    open: (connectionString) => (connectionString === schema.dsn ? sql : new SQL(connectionString, { max: 1 })),
    now,
  });

  const deps: DispatchDeps = {
    endpoint: options.endpoint ?? 'mcp',
    secrets,
    connections,
    store,
    accessLog,
    signals,
    gateway: gateway.gateway,
    now: () => new Date(clock),
  };

  return {
    tenantId,
    bearer,
    schema,
    control,
    sql,
    controlSql,
    secrets,
    store,
    accessLog,
    signals,
    gateway,
    connections,
    deps,
    now,
    advance(ms) {
      clock += ms;
    },
    call(tool, args = {}, callOptions = {}) {
      return dispatch(
        callOptions.endpoint === undefined ? deps : { ...deps, endpoint: callOptions.endpoint },
        {
          authorization:
            callOptions.authorization === undefined ? `Bearer ${bearer}` : callOptions.authorization,
          tool,
          args,
        },
      );
    },
    async close() {
      await signals.flush().catch(() => undefined);
      await connections.close();
      await sql.close().catch(() => undefined);
      await controlSql.close();
      await dropFixtureDatabase(schema);
      await dropControlPlane(control);
    },
  };
}
