/**
 * Shared harness for the U8 ingest suite. Not a `*.test.ts` file.
 *
 * U8 is the first unit that needs **both** databases at once: the tenant's
 * knowledge core, because the delta-aware estimate is a query over its pages
 * and the write path commits into it, and the control plane, because the gate
 * reads the rolling spend counter and the cap off `control.tenant`. A gate
 * tested against one of them proves nothing about the arrangement that actually
 * bounds spend.
 *
 * Everything vendor-shaped is a port with an in-memory implementation: the
 * embedding provider is U4's deterministic lexical transport (shared rather than
 * re-invented, so this suite's vectors order the same way that one's do), object
 * storage is `createInMemoryRawStore`, and the folder is a scan value rather
 * than a directory — which is the only way to produce the `complete: false` the
 * tombstone sweep must refuse.
 *
 * No network, no model call, no credential.
 */

import { SQL } from 'bun';

import {
  createBudget,
  type Budget,
  type InMemorySpendMeter,
  type ModelGateway,
} from '../../src/ai/gateway.ts';
import { HOSTED_PROFILE } from '../../src/ai/routing.ts';
import { fleetIdentity, type CallerIdentity } from '../../src/control/secrets.ts';
import {
  createInMemoryCredentialMinter,
  createTenantStorage,
  type TenantStorage,
} from '../../src/control/storage.ts';
import { contentDigest, type SourceType } from '../../src/core/write/write-path.ts';
import { createJobQueue, type PostgresJobQueue } from '../../src/worker/queue.ts';
import type { ImportCandidate } from '../../src/ingest/first-import.ts';
import {
  createInMemoryRawStore,
  type InMemoryRawStore,
} from '../../src/ingest/import/raw.ts';
import type { ImportItem, TenantRuntime } from '../../src/ingest/import/run.ts';
import { createGateway, lexicalVector, type RecordingTransport } from '../core/write/fixture.ts';
import {
  connect as connectTenant,
  dropFixtureDatabase,
  provisionFixture,
  type SchemaFixture,
} from '../schema/fixture.ts';
import {
  connect as connectControl,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from '../worker/fixture.ts';

export { HOSTED_PROFILE, contentDigest, createInMemoryRawStore, lexicalVector };
export type { ImportCandidate, ImportItem, InMemoryRawStore, SourceType, TenantRuntime };

export const TENANT = 'importer';
export const CALLER: CallerIdentity = fleetIdentity(TENANT);
export const ORIGIN = 'chat-export:local';

/** Stands in for a chunk of the user's transcript; asserted absent from logs. */
export const CANARY = 'CANARY-4d71-ingest-do-not-retain';

export function uncappedBudget(label = 'import'): Budget {
  return createBudget({ label, capMicroUsd: null });
}

export interface IngestFixture {
  readonly tenantSql: SQL;
  readonly controlSql: SQL;
  readonly gateway: ModelGateway;
  readonly transport: RecordingTransport;
  readonly meter: InMemorySpendMeter;
  readonly storage: TenantStorage;
  readonly rawStore: InMemoryRawStore;
  readonly queue: PostgresJobQueue;
  readonly runtime: TenantRuntime;
  close(): Promise<void>;
}

/** A storage accessor over the in-process minter. No network, no parent secret. */
export function testStorage(): TenantStorage {
  return createTenantStorage({
    minter: createInMemoryCredentialMinter({
      parentAccessKeyId: 'fixture-key',
      parentSecretAccessKey: 'fixture-secret',
    }),
  });
}

/**
 * Both databases, the gateway, the ports, and one seeded `ready` tenant.
 *
 * `slug` names the throwaway databases, so a failed run leaves two
 * recognisably-ours databases behind rather than one anonymous pair.
 */
export async function createIngestFixture(
  slug: string,
  options: { readonly newJobId?: () => string } = {},
): Promise<IngestFixture> {
  const schema: SchemaFixture = await provisionFixture(slug);
  const control: ControlFixture = await createControlPlane(slug);
  const tenantSql = connectTenant(schema);
  const controlSql = connectControl(control);
  await seedTenant(controlSql, TENANT);

  const harness = createGateway();
  const storage = testStorage();
  const rawStore = createInMemoryRawStore();
  const queue = createJobQueue({ sql: controlSql, ...(options.newJobId === undefined ? {} : { newJobId: options.newJobId }) });

  return {
    tenantSql,
    controlSql,
    gateway: harness.gateway,
    transport: harness.transport,
    meter: harness.meter,
    storage,
    rawStore,
    queue,
    runtime: {
      sql: tenantSql,
      gateway: harness.gateway,
      tenantId: TENANT,
      caller: CALLER,
    },
    async close() {
      await tenantSql.close();
      await controlSql.close();
      await dropFixtureDatabase(schema);
      await dropControlPlane(control);
    },
  };
}

/** Sets the tenant's spend state, which `seedTenant` leaves at its defaults. */
export async function setSpend(
  sql: SQL,
  tenantId: string,
  spend: {
    readonly spentMicroUsd?: number;
    readonly capMicroUsd?: number | null;
    readonly windowStartedAt?: Date;
  },
): Promise<void> {
  await sql`
    UPDATE control.tenant
       SET spend_micro_usd = ${spend.spentMicroUsd ?? 0},
           spend_cap_micro_usd = ${spend.capMicroUsd === undefined ? null : spend.capMicroUsd},
           spend_window_started_at = ${spend.windowStartedAt ?? new Date()}
     WHERE tenant_id = ${tenantId}
  `;
}

export async function countRows(sql: SQL, table: string, where = 'TRUE'): Promise<number> {
  const rows = (await sql.unsafe(
    `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

export async function ingestLogRows(sql: SQL): Promise<
  Array<{
    ingest_id: string;
    origin_context: string;
    source_type: string;
    external_ref: string | null;
    outcome: string;
    failure_code: string | null;
    items_seen: number;
    items_written: number;
    items_quarantined: number;
    started_at: Date;
    finished_at: Date | null;
  }>
> {
  return (await sql`
    SELECT ingest_id::text AS ingest_id, origin_context, source_type, external_ref,
           outcome, failure_code, items_seen, items_written, items_quarantined,
           started_at, finished_at
      FROM ingest_log
     ORDER BY ingest_id
  `) as never;
}

/** An import candidate from a body, digested exactly as U4 digests it. */
export function candidateFrom(
  externalRef: string,
  body: string,
  occurredAt: Date | null,
  title: string | null = null,
): ImportCandidate {
  return {
    externalRef,
    contentSha256: contentDigest(title, body),
    occurredAt,
    characters: body.length,
  };
}

export function itemFrom(
  externalRef: string,
  body: string,
  occurredAt: Date | null,
  title: string | null = null,
): ImportItem {
  return { externalRef, title, body, occurredAt };
}

/** Deterministic prose long enough to chunk, and distinct per seed. */
export function proseOf(seed: string, paragraphs: number): string {
  const lines: string[] = [];
  for (let index = 0; index < paragraphs; index += 1) {
    lines.push(
      `${seed} paragraph ${index}: the quarterly review covered hiring, runway and the ` +
        `migration schedule, and ${seed} raised the question of who owns the rollout.`,
    );
  }
  return lines.join('\n\n');
}
