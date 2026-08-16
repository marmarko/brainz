/**
 * Shared fakes for the U20 gateway suite. Not a `*.test.ts` file.
 *
 * Two things live here and nothing else:
 *
 * 1. **A transport that never touches the network.** Every gateway test drives
 *    a real `ModelTransport` implementation whose only difference from the
 *    shipped one is that it answers from a script instead of a socket. It
 *    records what it was asked, which is how the pre-call guards are proved:
 *    a cap that is checked *after* the provider call is indistinguishable from
 *    no cap at all unless the test can assert the provider was never reached.
 *
 * 2. **A real control-plane database.** `src/control/schema.sql` carries U20's
 *    rolling spend counter, and until now nothing in the blocking suite had
 *    ever executed that DDL (`test/control/schema.test.ts` says so in its own
 *    header). The metering guarantee this unit is judged on — "cost accrues to
 *    the correct tenant under concurrent calls from two tenants" — is a
 *    statement about a `UPDATE … SET x = x + $1` under concurrency, and an
 *    in-memory `Map` cannot make it. So it is measured against Postgres, on
 *    the same `DATABASE_URL` convention `test/hazards/fixture.ts` establishes.
 *
 * The canary below is the stand-in for a chunk of the user's mail. Every test
 * that asserts content does not leak uses this one string, so a single grep
 * over a captured record set answers the question.
 */

import { SQL } from 'bun';

import { ADMIN_DSN } from '../hazards/fixture.ts';
import type {
  ModelTransport,
  TransportRequest,
  TransportResponse,
} from '../../src/ai/gateway.ts';
import type { TokenUsage } from '../../src/ai/pricing.ts';
import { EMBEDDING_DIMENSIONS } from '../../src/schema/vector-index.ts';

export { ADMIN_DSN };

/**
 * A string no ordinary code path would produce, standing in for the user's
 * content. If it appears in a metering record, a log line or an error message,
 * the retention posture KTD13 puts in this module has already failed.
 */
export const CANARY = 'CANARY-a3f9-severance-agreement-draft-do-not-retain';

export interface FakeTransportScript {
  /** Usage the provider reports back. `null` means the provider reported none. */
  readonly usage?: TokenUsage | null;
  /** Throw instead of answering. The message deliberately carries the canary. */
  readonly failWith?: Error;
  /** Vector width for embedding answers; defaults to the pinned dimension. */
  readonly embeddingDimensions?: number;
}

export interface FakeTransport extends ModelTransport {
  readonly calls: readonly TransportRequest[];
}

const DEFAULT_USAGE: TokenUsage = { inputTokens: 1_000, outputTokens: 200 };

/**
 * A transport that answers from a script. It is a real implementation of the
 * interface the shipped transports satisfy — the gateway cannot tell.
 */
export function createFakeTransport(script: FakeTransportScript = {}): FakeTransport {
  const calls: TransportRequest[] = [];

  return {
    id: 'fake',
    get calls() {
      return calls;
    },
    invoke(request: TransportRequest): Promise<TransportResponse> {
      calls.push(request);
      if (script.failWith !== undefined) return Promise.reject(script.failWith);

      const usage = script.usage === undefined ? DEFAULT_USAGE : script.usage;
      // The routed seat's width by default, so a fake that says nothing about
      // dimensions produces a vector the gateway accepts. A literal here is the
      // shape of bug the seat registry exists against: it would make every
      // embedding call in the suite fail `embedding_dimension_mismatch` the day
      // a seat moves, which is a suite-wide red for a fixture's opinion.
      const width = script.embeddingDimensions ?? EMBEDDING_DIMENSIONS;

      if (request.kind === 'embedding') {
        const texts = request.input.kind === 'embedding' ? request.input.texts : [];
        return Promise.resolve({
          output: {
            kind: 'embedding',
            vectors: texts.map(() => Array.from({ length: width }, () => 0)),
          },
          ...(usage === null ? {} : { usage: { inputTokens: usage.inputTokens, outputTokens: 0 } }),
        });
      }

      if (request.kind === 'rerank') {
        const candidates = request.input.kind === 'rerank' ? request.input.candidates : [];
        return Promise.resolve({
          output: { kind: 'rerank', scores: candidates.map((_, index) => 1 / (index + 1)) },
          ...(usage === null ? {} : { usage: { inputTokens: usage.inputTokens, outputTokens: 0 } }),
        });
      }

      return Promise.resolve({
        output: { kind: 'chat', text: 'ok' },
        ...(usage === null ? {} : { usage }),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// The real control-plane database.
// ---------------------------------------------------------------------------

const CONTROL_DDL_PATH = `${import.meta.dir}/../../src/control/schema.sql`;

export interface ControlPlaneFixture {
  readonly dsn: string;
  readonly sql: SQL;
  /** Inserts a tenant row. `fts_language` has no default, by KTD9's design. */
  seedTenant(tenantId: string, capMicroUsd?: number): Promise<void>;
  /** Reads the counter as text: Bun surfaces `bigint` in more than one shape. */
  spendOf(tenantId: string): Promise<bigint>;
  /** The R22 half of the same read: what the platform actually paid for. */
  hostedCogsOf(tenantId: string): Promise<bigint>;
  close(): Promise<void>;
}

function databaseUrlFor(database: string): string {
  const url = new URL(ADMIN_DSN);
  url.pathname = `/${database}`;
  return url.toString();
}

/**
 * A throwaway control-plane database with `src/control/schema.sql` applied.
 * Applied through the shipped DDL, not a hand-written subset: a metering test
 * that invents its own `tenant` table proves nothing about the column the
 * scheduler reads.
 */
export async function createControlPlaneFixture(slug: string): Promise<ControlPlaneFixture> {
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(slug)) throw new Error(`unusable fixture slug: ${slug}`);
  const database = `brainz_ai_${slug}`;

  const admin = new SQL(ADMIN_DSN, { max: 1 });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${database}`);
  } finally {
    await admin.close();
  }

  const dsn = databaseUrlFor(database);
  // More than one connection on purpose: the concurrency guard is meaningless
  // if every "concurrent" call queues behind the same backend.
  const sql = new SQL(dsn, { max: 8 });
  await sql.unsafe(await Bun.file(CONTROL_DDL_PATH).text());

  return {
    dsn,
    sql,
    async seedTenant(tenantId, capMicroUsd) {
      await sql`
        INSERT INTO control.tenant (tenant_id, fts_language, spend_cap_micro_usd)
        VALUES (${tenantId}, 'simple', ${capMicroUsd ?? null})
      `;
    },
    async spendOf(tenantId) {
      const rows = (await sql`
        SELECT spend_micro_usd::text AS spend FROM control.tenant WHERE tenant_id = ${tenantId}
      `) as Array<{ spend: string }>;
      const row = rows[0];
      if (row === undefined) throw new Error(`no tenant row: ${tenantId}`);
      return BigInt(row.spend);
    },
    async hostedCogsOf(tenantId) {
      const rows = (await sql`
        SELECT hosted_cogs_micro_usd::text AS cogs FROM control.tenant WHERE tenant_id = ${tenantId}
      `) as Array<{ cogs: string }>;
      const row = rows[0];
      if (row === undefined) throw new Error(`no tenant row: ${tenantId}`);
      return BigInt(row.cogs);
    },
    async close() {
      await sql.close();
      const dropper = new SQL(ADMIN_DSN, { max: 1 });
      try {
        await dropper.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      } finally {
        await dropper.close();
      }
    },
  };
}
