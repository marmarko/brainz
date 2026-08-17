/**
 * The two ingest job kinds, driven through the runner the fleet composes.
 *
 * **What was missing.** `JOB_KINDS` has declared `ingest_pull` and `import`
 * since U10; `src/ingest/pipedream/pull.ts` and `src/ingest/import/run.ts` have
 * known how to run both since U9 and U8. `src/worker/serve.ts` registered
 * `{ consolidate, export }`, and `enqueuePullIfDue` — the module's own "cadence
 * trigger" — had no caller in `src/`. So a connected account was never polled and
 * a deferred import never resumed.
 *
 * **A test that asserts the handler map has a key proves nothing**, which is why
 * every case below goes through `createJobRunner.runOnce`: a job is claimed
 * under a lease, the handler runs, and what is asserted is the effect in a real
 * database or the state the job settled in. A handler registered against the
 * wrong kind, or one that throws on every job, passes a map-shaped test and
 * fails all of these.
 *
 * The vendor half is a scripted `ProviderSource` rather than a network: what is
 * under test is the fleet's wiring, and U9's suite already owns whether the
 * Gmail adapter parses Gmail.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';

import { createJobQueue, createLeaseChannel } from '../../src/worker/queue.ts';
import { createJobRunner } from '../../src/worker/runner.ts';
import {
  ConnectorRuntimeUnavailableError,
  connectorSourceOpener,
  enqueueDuePulls,
  type ConnectorRuntime,
} from '../../src/worker/connectors.ts';
import { createIngestPullHandler } from '../../src/ingest/pipedream/pull.ts';
import { createImportHandler, type ImportMaterial, type TenantRuntime } from '../../src/ingest/import/run.ts';
import {
  ImportTargetUnavailableError,
  createChatExportMaterializer,
  createImportMaterializer,
} from '../../src/ingest/import/materialize.ts';
import {
  createInMemoryRawStore,
  manifestKeyFor,
  rawKeyFor,
  writeManifest,
  type InMemoryRawStore,
} from '../../src/ingest/import/raw.ts';
import {
  SOURCE_TYPE_FOR,
  connectSource,
  createInMemoryConnectorStore,
  pullModeFor,
  type ConnectorSource,
  type ConnectorState,
} from '../../src/ingest/cursor.ts';
import type { PullPage } from '../../src/ingest/pipedream/sources/types.ts';
import { pauseSource } from '../../src/ingest/pause.ts';
import { HOSTED_PROFILE } from '../../src/ai/routing.ts';
import { ACTIVE_EMBEDDING_SEAT, seatColumnSql } from '../../src/schema/embedding-seat.ts';
import { fleetIdentity, tenantNamespace } from '../../src/control/secrets.ts';
import { startWorkerFleet } from '../../src/worker/serve.ts';
import { createConnectorRuntime } from '../../src/worker/connectors.ts';
import {
  createControlPlaneTiers,
  createPostgresConnectorLinks,
  ensureConnectorLinkSchema,
  markConnectPending,
  type ConnectorLinks,
} from '../../src/control/connector-pg.ts';
import { generateSealingKeyMaterial, importSealingKey } from '../../src/control/sealed.ts';
import {
  createConnectorReconciler,
  type ConnectorAccountLister,
} from '../../src/ingest/pipedream/reconcile.ts';
import type { ConnectedAccount, ProviderApi } from '../../src/ingest/pipedream/client.ts';
import { FAKE_CF_ACCOUNT_ID, writeSecretsFile } from '../fleet/fixture.ts';
import { testStorage } from '../ingest/fixture.ts';
import { createGateway } from '../core/write/fixture.ts';
import { createFakeSource, emptyPage } from '../ingest/pipedream/fixture.ts';
import {
  connect as connectControl,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from './fixture.ts';
import {
  connect as connectTenant,
  dropFixtureDatabase,
  provisionFixture,
  type SchemaFixture,
} from '../schema/fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const TENANT = 'lanes-alice';
const NOW = new Date('2026-08-17T09:00:00.000Z');

let control: ControlFixture;
let controlSql: SQL;
let leaseSql: SQL;
let brain: SchemaFixture;
let brainSql: SQL;
let tenant: TenantRuntime;
/** What the connector link store seals under. One per run, and nothing reads it back. */
let SEALED_KEY: CryptoKey;

beforeAll(async () => {
  control = await createControlPlane('ingestlanes');
  controlSql = connectControl(control, 4);
  leaseSql = connectControl(control, 2);
  // The connector link table, which both deployed entrypoints ensure at boot.
  await ensureConnectorLinkSchema(controlSql);
  SEALED_KEY = await importSealingKey(generateSealingKeyMaterial());
  brain = await provisionFixture('ingestlanes_brain');
  brainSql = connectTenant(brain);
  tenant = {
    sql: brainSql,
    gateway: createGateway().gateway,
    tenantId: TENANT,
    caller: fleetIdentity(TENANT),
  };
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await brainSql?.close();
  await controlSql?.close();
  await leaseSql?.close();
  if (brain !== undefined) await dropFixtureDatabase(brain);
  if (control !== undefined) await dropControlPlane(control);
});

/** The brain, back to empty — in dependency order, as `test/ingest/run.test.ts` does it. */
async function resetBrain(): Promise<void> {
  await brainSql`DELETE FROM fact_source`;
  await brainSql`DELETE FROM entity_edge`;
  await brainSql`UPDATE fact SET superseded_by = NULL`;
  await brainSql`DELETE FROM fact`;
  await brainSql`DELETE FROM entity_alias`;
  await brainSql`DELETE FROM entity`;
  await brainSql`DELETE FROM chunk`;
  await brainSql`DELETE FROM attachment`;
  await brainSql`UPDATE page SET ingest_id = NULL`;
  await brainSql`DELETE FROM page`;
  await brainSql`DELETE FROM ingest_log`;
  await brainSql`DELETE FROM source_pause`;
}

beforeEach(async () => {
  await controlSql`DELETE FROM control.job`;
  await controlSql`DELETE FROM control.tenant`;
  await resetBrain();
  await seedTenant(controlSql, TENANT);
  // A cap the gate can approve against: `seedTenant` leaves the spend columns at
  // their defaults, and a first import is gated on what is left of the window.
  await controlSql`
    UPDATE control.tenant SET spend_cap_micro_usd = 5000000, spend_micro_usd = 0
     WHERE tenant_id = ${TENANT}`;
});

/**
 * The tenant handle the fleet hands both handlers. Closing is the caller's, and
 * here the connection outlives the job, so `close` is a no-op rather than a
 * pool the suite would then have to rebuild per case.
 */
function openTenant(): Promise<TenantRuntime> {
  return Promise.resolve(tenant);
}

async function enqueueClaimable(
  kind: 'ingest_pull' | 'import',
  target: string,
): Promise<string> {
  const queue = createJobQueue({ sql: controlSql });
  const outcome = await queue.enqueue({
    tenantId: TENANT,
    kind,
    target: target as never,
    trigger: 'user_request',
    now: NOW,
  });
  if (!outcome.enqueued) throw new Error(`fixture: could not enqueue (${outcome.reason})`);
  return outcome.job.jobId;
}

function runnerWith(handlers: Parameters<typeof createJobRunner>[0]['handlers']) {
  return createJobRunner({
    queue: createJobQueue({ sql: controlSql }),
    leases: createLeaseChannel({ sql: leaseSql }),
    handlers,
    owner: 'ingest-lanes-test',
    concurrency: 2,
  });
}

/**
 * One job's settled state, by kind.
 *
 * Keyed on the kind rather than "the only row", because a tick of the real
 * entrypoint also runs the export lane's enqueue pass — so the table carries
 * more than the row under test, and a positional read would answer for whichever
 * one sorted first.
 */
async function jobState(
  kind: 'ingest_pull' | 'import' = 'ingest_pull',
): Promise<{ state: string; attempts: number; failure: string | null }> {
  const rows = (await controlSql`
    SELECT state::text AS state, attempts, failure_code::text AS failure
      FROM control.job WHERE kind = ${kind}::control.job_kind`) as Array<{
    state: string;
    attempts: number;
    failure: string | null;
  }>;
  return rows[0] ?? { state: 'missing', attempts: -1, failure: null };
}

// ---------------------------------------------------------------------------
// `ingest_pull`.
// ---------------------------------------------------------------------------

/** A connector this tenant connected, with no cursor — so the first pull is gated. */
function connected(source: ConnectorSource = 'gmail'): ConnectorState {
  return connectSource({
    source,
    externalUserId: `${TENANT}-${source}`,
    accountId: 'apn_fixture',
    accountKey: 'owner@example.test',
    now: new Date(NOW.getTime() - 86_400_000),
  });
}

/** A runtime over an in-memory cursor store and a scripted listing. */
function runtimeWith(state: ConnectorState, listing: PullPage | null): ConnectorRuntime {
  const states = createInMemoryConnectorStore([state]);
  return {
    states: () => Promise.resolve([state]),
    open: (_tenant, source) =>
      Promise.resolve({
        source: createFakeSource(source, SOURCE_TYPE_FOR[source], [
          { ok: true, page: listing ?? emptyPage() },
        ]),
        states,
      }),
  };
}

describe('the `ingest_pull` lane', () => {
  test(
    'a queued pull is claimed, run, and its items land in the brain',
    async () => {
      await enqueueClaimable('ingest_pull', 'gmail');
      const runtime = runtimeWith(connected(), {
        items: [
          {
            externalRef: 'gmail:owner@example.test:m1',
            title: 'the rollout',
            body: 'the rollout starts on the fourteenth and the runbook is in the wiki',
            occurredAt: NOW,
          },
        ],
        tombstones: [],
        failures: [],
        nextCursor: { kind: 'delta', value: 'h-1' },
        outsideWindow: null,
        accountKey: 'owner@example.test',
      });

      const pass = await runnerWith({
        ingest_pull: createIngestPullHandler({
          control: controlSql,
          profile: HOSTED_PROFILE,
          openTenant,
          openSource: connectorSourceOpener(runtime),
        }),
      }).runOnce({ now: NOW });

      expect(pass.claimed).toBe(1);
      expect(pass.outcomes.completed).toBe(1);
      // The effect, in the tenant's own database — not the handler's return
      // value, and not a spy on a port.
      const pages = (await brainSql`
        SELECT external_ref, origin_context FROM page WHERE deleted_at IS NULL`) as Array<{
        external_ref: string;
        origin_context: string;
      }>;
      expect(pages).toEqual([
        { external_ref: 'gmail:owner@example.test:m1', origin_context: 'pipedream:gmail' },
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * **The seam this deployment actually composes.**
   *
   * `worker/serve.ts` passes `connectorSourceOpener(undefined)` because the
   * cursor a pull resumes from lives in the tenant's object prefix and `src/`
   * has no production credential minter to reach one with. What matters is that
   * the refusal *fails the job* — a handler that returned quietly would mark the
   * pull complete, and the source would then wait a full cadence before anyone
   * asked again, which is `pull.ts`'s own stated rule about a pull that never
   * reached the provider.
   */
  test(
    'with no connector runtime the job fails into the ladder rather than reporting success',
    async () => {
      await enqueueClaimable('ingest_pull', 'gmail');

      const pass = await runnerWith({
        ingest_pull: createIngestPullHandler({
          control: controlSql,
          profile: HOSTED_PROFILE,
          openTenant,
          openSource: connectorSourceOpener(undefined),
        }),
      }).runOnce({ now: NOW });

      expect(pass.claimed).toBe(1);
      expect(pass.outcomes.completed).toBe(0);
      expect(pass.outcomes.failed).toBe(1);
      const settled = await jobState();
      expect(settled.state).not.toBe('done');
      expect(settled.attempts).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  test('the refusal names which missing piece it is', async () => {
    const refused = await connectorSourceOpener(undefined)(tenant, 'drive').then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(ConnectorRuntimeUnavailableError);
    expect((refused as Error).message).toContain('credential minter');
  });

  /**
   * A registered kind is not enough on its own: a runner scopes its claim to the
   * handler keys it was given, so the *unregistered* case is a row that sits
   * `due` forever — invisible to the dead-letter list an operator reads. This is
   * the state `worker/serve.ts` used to be in for both these kinds.
   */
  test(
    'an unregistered kind leaves the row untouched, which is why both are registered',
    async () => {
      await enqueueClaimable('ingest_pull', 'gmail');
      const pass = await runnerWith({
        import: createImportHandler({
          control: controlSql,
          storage: testStorage(),
          rawStore: createInMemoryRawStore(),
          profile: HOSTED_PROFILE,
          openTenant,
          materialize: () => Promise.reject(new Error('not reached')),
        }),
      }).runOnce({ now: NOW });

      expect(pass.claimed).toBe(0);
      expect((await jobState()).state).toBe('due');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The cadence pass.
// ---------------------------------------------------------------------------

describe('the cadence pass', () => {
  function passDeps(runtime: ConnectorRuntime | undefined, opened: string[]) {
    return {
      sql: controlSql,
      queue: createJobQueue({ sql: controlSql }),
      ...(runtime === undefined ? {} : { runtime }),
      openTenant: (tenantId: string) => {
        opened.push(tenantId);
        return Promise.resolve({ sql: brainSql, close: () => Promise.resolve() });
      },
    };
  }

  test('a due source becomes an `ingest_pull` job on its own target', async () => {
    const opened: string[] = [];
    const result = await enqueueDuePulls(passDeps(runtimeWith(connected(), null), opened), {
      now: NOW,
    });

    expect(result.enqueued).toEqual([{ tenantId: TENANT, source: 'gmail' }]);
    const rows = (await controlSql`
      SELECT kind::text AS kind, target::text AS target, trigger_reason::text AS trigger
        FROM control.job`) as Array<Record<string, string>>;
    expect(rows).toEqual([
      { kind: 'ingest_pull', target: 'gmail', trigger: 'connector_cadence' },
    ]);
  });

  /**
   * **The economy of the pass, asserted as the thing it costs.** Connector state
   * is object storage and wakes nothing; the pause set is in the tenant's own
   * Postgres. A tenant with nothing due must not be woken to be told so — that
   * is the cost `scheduler.ts` bounds its schema sweep to avoid, and a cadence
   * that opened every tenant's database every minute would be paying it sixty
   * times an hour per brain.
   */
  test('a tenant with nothing due costs no connection to their database', async () => {
    const opened: string[] = [];
    const fresh = { ...connected(), lastPullAt: NOW.toISOString() };
    const result = await enqueueDuePulls(
      passDeps(runtimeWith(fresh, null), opened),
      { now: NOW },
    );

    expect(result.considered).toBe(1);
    expect(result.enqueued).toEqual([]);
    expect(opened).toEqual([]);
    expect(result.opened).toBe(0);
  });

  test('a paused source is refused as paused, and no job is enqueued', async () => {
    await pauseSource(brainSql, 'gmail', 'panel');
    const opened: string[] = [];
    const result = await enqueueDuePulls(passDeps(runtimeWith(connected(), null), opened), {
      now: NOW,
    });

    // Named rather than folded into `not_due`: a user who paused their mailbox
    // and watched it keep pulling would be right to conclude the button does
    // nothing.
    expect(result.paused).toEqual([{ tenantId: TENANT, source: 'gmail' }]);
    expect(result.enqueued).toEqual([]);
    const count = (await controlSql`SELECT count(*)::int AS n FROM control.job`) as Array<{
      n: number;
    }>;
    expect(count[0]?.n).toBe(0);
  });

  test('a lane that is already open is skipped in SQL rather than asked and refused', async () => {
    await enqueueClaimable('ingest_pull', 'gmail');
    const opened: string[] = [];
    const result = await enqueueDuePulls(passDeps(runtimeWith(connected(), null), opened), {
      now: NOW,
    });

    expect(result.enqueued).toEqual([]);
    expect(result.refused).toEqual([]);
    // And the tenant's database is not opened for a lane that has nothing to
    // schedule: the anti-join runs before the pause read.
    expect(opened).toEqual([]);
  });

  test('a deployment with no connector runtime enqueues nothing and queries nothing', async () => {
    const opened: string[] = [];
    const result = await enqueueDuePulls(passDeps(undefined, opened), { now: NOW });
    expect(result).toMatchObject({ considered: 0, opened: 0, enqueued: [], refused: [] });
    expect(opened).toEqual([]);
  });

  test('one tenant’s unreadable connector state does not stop the pass', async () => {
    const opened: string[] = [];
    const broken: ConnectorRuntime = {
      states: () => Promise.reject(new Error('the object store is unreachable')),
      open: () => Promise.reject(new Error('not reached')),
    };
    const result = await enqueueDuePulls(passDeps(broken, opened), { now: NOW });
    expect(result.unreadable).toBe(1);
    expect(result.enqueued).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `import`.
// ---------------------------------------------------------------------------

const CLAUDE_EXPORT = [
  {
    uuid: 'conv-1',
    name: 'Rollout plan',
    created_at: '2026-05-01T10:00:00.000000Z',
    account: { uuid: 'acct-1' },
    chat_messages: [
      {
        uuid: 'm1',
        sender: 'human',
        created_at: '2026-05-01T10:00:00.000000Z',
        content: [{ type: 'text', text: 'When does the rollout start, and who owns the runbook?' }],
        attachments: [],
        files: [],
      },
      {
        uuid: 'm2',
        sender: 'assistant',
        created_at: '2026-05-01T10:00:05.000000Z',
        content: [
          {
            type: 'text',
            text: 'It starts on the fourteenth. The runbook lives in the wiki and the on-call rota is pinned beside it.',
          },
        ],
        attachments: [],
        files: [],
      },
    ],
  },
];

/** The manifest and the payload a deferred chat-export import resumes from. */
async function seedDeferredExport(
  rawStore: InMemoryRawStore,
  jobId: string,
  document: unknown = CLAUDE_EXPORT,
): Promise<void> {
  const storage = testStorage();
  const rawId = 'conversations.json';
  const rawKey = rawKeyFor(storage, tenant.caller, TENANT, rawId);
  const manifestKey = manifestKeyFor(storage, tenant.caller, TENANT, jobId);
  if (!rawKey.ok || !manifestKey.ok) throw new Error('fixture: no key');

  await rawStore.put(rawKey.key, {
    bytes: new TextEncoder().encode(JSON.stringify(document)),
    contentType: 'application/json',
  });
  await writeManifest(rawStore, manifestKey.key, {
    tenantId: TENANT,
    target: 'chat_export',
    originContext: 'personal:chat',
    sourceType: 'chat',
    window: 'all',
    rawKey: rawId,
    approvedMicroUsd: 5_000_000,
  });
}

describe('the `import` lane', () => {
  test(
    'a deferred chat export resumes from its manifest and becomes pages',
    async () => {
      const rawStore = createInMemoryRawStore();
      const storage = testStorage();
      const jobId = await enqueueClaimable('import', 'chat_export');
      await seedDeferredExport(rawStore, jobId);

      const pass = await runnerWith({
        import: createImportHandler({
          control: controlSql,
          storage,
          rawStore,
          profile: HOSTED_PROFILE,
          openTenant,
          // Composed exactly as `worker/serve.ts` composes it, with the object
          // store this deployment does not have supplied by the fixture.
          materialize: createImportMaterializer({
            chat_export: createChatExportMaterializer({ rawStore, storage }),
          }),
        }),
      }).runOnce({ now: NOW });

      expect(pass.outcomes.completed).toBe(1);
      const pages = (await brainSql`
        SELECT external_ref, origin_context FROM page WHERE deleted_at IS NULL`) as Array<{
        external_ref: string;
        origin_context: string;
      }>;
      expect(pages).toEqual([{ external_ref: 'claude:conv-1', origin_context: 'personal:chat' }]);
      expect((await jobState('import')).state).toBe('done');
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * **The junk gate, reached through the registered handler.**
   *
   * `gateJunk` lives at a seam both runners reach and `runImport` calls it in
   * front of the estimate; what this asserts is that the *materializer* keeps
   * `ImportItem.junk` intact on the way there. A dispatcher that rebuilt items
   * — the natural way to write one — would drop the field, and a consumer
   * mailbox arriving through this door (Assumption 1's MBOX fallback is a
   * `TargetMaterializer` and nothing else) would be chunked and embedded at full
   * price, which `junk.ts` calls the single largest avoidable cost in the
   * product.
   */
  test(
    'a bulk item from the materializer is quarantined rather than embedded',
    async () => {
      const rawStore = createInMemoryRawStore();
      const storage = testStorage();
      const jobId = await enqueueClaimable('import', 'chat_export');
      await seedDeferredExport(rawStore, jobId);

      const material: ImportMaterial = {
        items: [
          {
            externalRef: 'mbox:1',
            title: 'Half off everything this weekend',
            body: 'a newsletter body long enough to be worth embedding if anything embedded it',
            occurredAt: NOW,
            junk: {
              headers: { 'List-Unsubscribe': '<https://sender.example/u>' },
              from: 'news@sender.example',
              subject: 'Half off everything this weekend',
            },
          },
          {
            externalRef: 'mbox:2',
            title: 'the runbook',
            body: 'the on-call rota is pinned beside the runbook in the wiki',
            occurredAt: NOW,
          },
        ],
        failures: [],
        raw: null,
      };

      const pass = await runnerWith({
        import: createImportHandler({
          control: controlSql,
          storage,
          rawStore,
          profile: HOSTED_PROFILE,
          openTenant,
          materialize: createImportMaterializer({
            chat_export: () => Promise.resolve(material),
          }),
        }),
      }).runOnce({ now: NOW });

      expect(pass.outcomes.completed).toBe(1);

      // `quarantined_at`, because U4's seam is one nullable marker and
      // `junk.ts` states that the marker string itself gets no column — a
      // hidden page is one the reads exclude, which is what this asserts.
      const pages = (await brainSql`
        SELECT external_ref, (quarantined_at IS NOT NULL) AS hidden FROM page
         WHERE deleted_at IS NULL ORDER BY external_ref`) as Array<{
        external_ref: string;
        hidden: boolean;
      }>;
      expect(pages).toEqual([
        { external_ref: 'mbox:1', hidden: true },
        { external_ref: 'mbox:2', hidden: false },
      ]);

      // And the run says so, which is the number an operator reads: one item
      // seen and hidden, one written.
      const log = (await brainSql`
        SELECT items_seen, items_written, items_quarantined FROM ingest_log
         WHERE external_ref IS NULL ORDER BY ingest_id DESC LIMIT 1`) as Array<{
        items_seen: number;
        items_written: number;
        items_quarantined: number;
      }>;
      expect(log[0]).toMatchObject({ items_written: 1, items_quarantined: 1 });

      // **The structural half, which is where the money is.** A hidden item's
      // chunks are written with `quarantined_at` set, and `embed.ts`'s backlog
      // query excludes exactly that — so the newsletter is never encoded, while
      // the ordinary mail beside it is. Asserted as vectors rather than as rows,
      // because a row costs nothing and a vector is the bill.
      const embedded = (await brainSql.unsafe(`
        SELECT p.external_ref,
               count(c.chunk_id)::int AS chunks,
               count(c.${seatColumnSql(ACTIVE_EMBEDDING_SEAT.column)})::int AS vectors,
               count(*) FILTER (WHERE c.quarantined_at IS NOT NULL)::int AS hidden
          FROM page p JOIN chunk c ON c.page_id = p.page_id
         WHERE p.deleted_at IS NULL GROUP BY p.external_ref ORDER BY p.external_ref`)) as Array<{
        external_ref: string;
        chunks: number;
        vectors: number;
        hidden: number;
      }>;
      const junked = embedded.find((row) => row.external_ref === 'mbox:1');
      const kept = embedded.find((row) => row.external_ref === 'mbox:2');
      expect(junked?.vectors).toBe(0);
      expect(junked?.hidden).toBe(junked?.chunks);
      expect(kept?.vectors).toBeGreaterThan(0);
      expect(kept?.hidden).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test('the dispatcher hands back the target’s own material, field for field', async () => {
    const material: ImportMaterial = {
      items: [
        {
          externalRef: 'mbox:3',
          title: null,
          body: 'body',
          occurredAt: null,
          junk: { labels: ['CATEGORY_PROMOTIONS'] },
        },
      ],
      failures: [],
      raw: null,
    };
    const materialize = createImportMaterializer({ chat_export: () => Promise.resolve(material) });

    const rebuilt = await materialize(
      {
        tenantId: TENANT,
        target: 'chat_export',
        originContext: 'personal:chat',
        sourceType: 'chat',
        window: 'all',
        approvedMicroUsd: 1,
      },
      tenant,
    );
    // Identity, not equality: a dispatcher that reconstructed the material would
    // pass a deep-equality check right up until somebody added a field to
    // `ImportItem`, which is exactly how `junk` would be lost.
    expect(rebuilt).toBe(material);
  });

  test('a target this deployment cannot rebuild refuses, and says which one', async () => {
    const materialize = createImportMaterializer({});
    const refused = await materialize(
      {
        tenantId: TENANT,
        target: 'folder',
        originContext: 'personal:folder',
        sourceType: 'document',
        window: 'all',
        approvedMicroUsd: 1,
      },
      tenant,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(ImportTargetUnavailableError);
    expect((refused as ImportTargetUnavailableError).target).toBe('folder');
    // A container has no access to the user's filesystem — which is a different
    // missing piece from the object store, and the message says so rather than
    // reporting one gap for two causes.
    expect((refused as Error).message).toContain('filesystem');
  });

  test(
    'a manifest whose payload is gone fails the job rather than importing nothing',
    async () => {
      const rawStore = createInMemoryRawStore();
      const storage = testStorage();
      const jobId = await enqueueClaimable('import', 'chat_export');
      await seedDeferredExport(rawStore, jobId);
      // The payload disappears; the manifest still names it. Completing here
      // would mark the user's export imported when nothing was.
      const emptied = createInMemoryRawStore();
      const manifestKey = manifestKeyFor(storage, tenant.caller, TENANT, jobId);
      if (!manifestKey.ok) throw new Error('fixture: no key');
      const manifest = await rawStore.get(manifestKey.key);
      if (manifest === null) throw new Error('fixture: no manifest');
      await emptied.put(manifestKey.key, manifest);

      const pass = await runnerWith({
        import: createImportHandler({
          control: controlSql,
          storage,
          rawStore: emptied,
          profile: HOSTED_PROFILE,
          openTenant,
          materialize: createImportMaterializer({
            chat_export: createChatExportMaterializer({ rawStore: emptied, storage }),
          }),
        }),
      }).runOnce({ now: NOW });

      expect(pass.outcomes.failed).toBe(1);
      expect((await jobState('import')).state).not.toBe('done');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The registration itself, in the process that has to carry it.
// ---------------------------------------------------------------------------

/**
 * **What every case above cannot prove.**
 *
 * They compose a runner and drive it, which is the right way to test a handler
 * — and it is exactly what `worker/serve.ts` used to *not* do for these two
 * kinds. A runner scopes its claim to the handler keys it is given, so an
 * unregistered kind is not refused, retried or dead-lettered: the row is never
 * claimed at all, and it sits `due` while an operator reads a dead-letter list
 * that is empty. So these two cases start the real entrypoint and assert the
 * row **moved**.
 *
 * The jobs below fail, because both seams are absent on this deployment. That is
 * the point: failing is a state the fleet can see, and `due` forever is not.
 */
/**
 * The real entrypoint, started against this suite's databases.
 *
 * Module-scoped rather than local to one describe, because two blocks drive it
 * now: the one that proves a queued job runs, and the one that proves anything
 * ever queues it.
 */
async function fleetOver(
  seams: Parameters<typeof startWorkerFleet>[1] = {},
): Promise<Awaited<ReturnType<typeof startWorkerFleet>>> {
  const scratch = mkdtempSync(join(tmpdir(), 'brainz-lanes-'));
  const secretsFile = join(scratch, 'secrets.json');
  await writeSecretsFile(secretsFile, {
    secrets: { [tenantNamespace(TENANT)]: { connectionString: brain.dsn, bearerGrant: 'unused' } },
  });
  return await startWorkerFleet(
    {
      PORT: '0',
      BRAINZ_CONTROL_DATABASE_URL: control.dsn,
      BRAINZ_SECRET_BACKEND: 'file',
      BRAINZ_SECRETS_FILE: secretsFile,
      BRAINZ_CF_ACCOUNT_ID: FAKE_CF_ACCOUNT_ID,
      // Long enough that the only tick is the one a case drives.
      BRAINZ_WORKER_TICK_MS: '3600000',
    },
    seams,
  );
}

describe('the running worker fleet claims both ingest kinds', () => {

  /**
   * **The pull lane, end to end through the deployed process.**
   *
   * Supplying a runtime is what makes this stronger than "the row moved": the
   * job **completes** and a page appears, which is only true if the entrypoint
   * registered the handler *and* wired its `openSource` seam to the same
   * supplier the cadence pass uses. Wire one of the two to a different supplier
   * and this goes red while every handler-level case stays green.
   */
  test(
    'one tick of the real entrypoint runs a queued pull to completion',
    async () => {
      await enqueueClaimable('ingest_pull', 'gmail');
      const fleet = await fleetOver({
        connectors: runtimeWith(connected(), {
          items: [
            {
              externalRef: 'gmail:owner@example.test:fleet-1',
              title: 'the rollout',
              body: 'the rollout starts on the fourteenth and the runbook is in the wiki',
              occurredAt: NOW,
            },
          ],
          tombstones: [],
          failures: [],
          nextCursor: { kind: 'delta', value: 'h-1' },
          outsideWindow: null,
          accountKey: 'owner@example.test',
        }),
      });
      try {
        await fleet.tick(NOW);
      } finally {
        await fleet.stop();
      }

      expect((await jobState('ingest_pull')).state).toBe('done');
      const pages = (await brainSql`
        SELECT external_ref FROM page WHERE deleted_at IS NULL`) as Array<{ external_ref: string }>;
      expect(pages).toEqual([{ external_ref: 'gmail:owner@example.test:fleet-1' }]);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * The import lane has no supplier to hand it — the object store is absent — so
   * what is asserted is the attempt. An unregistered kind is never claimed and
   * its counter never moves; a registered one whose seam refuses fails, backs
   * off, and is visible.
   */
  test(
    'one tick of the real entrypoint claims a queued import job',
    async () => {
      await enqueueClaimable('import', 'chat_export');
      const fleet = await fleetOver();
      try {
        await fleet.tick(NOW);
      } finally {
        await fleet.stop();
      }

      const settled = await jobState('import');
      // **`attempts`, not `state`.** A failed job goes back to `due` with a
      // backoff, so the state alone cannot tell "claimed and failed" from "never
      // claimed at all" — which is exactly the difference registration makes.
      // Unregister the kind in `worker/serve.ts` and this line goes red.
      expect(settled.attempts).toBe(1);
      expect(settled.failure).not.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * **The cadence pass, bound to the tick that has to run it.**
   *
   * The handler cases above prove a queued pull runs. Nothing in them proves
   * anything ever *queues* one — and on this deployment the pass is a no-op, so
   * deleting the call from `tick` would change nothing observable. That is the
   * exact shape the connector lane was already in: `enqueuePullIfDue` complete,
   * tested, and called by nobody. Supplying a runtime makes one tick's work
   * visible, and this is the assertion that goes red when the call disappears.
   */
  test(
    'one tick enqueues the cadence pull the connector runtime says is due',
    async () => {
      const fleet = await fleetOver({ connectors: runtimeWith(connected(), null) });
      try {
        await fleet.tick(NOW);
      } finally {
        await fleet.stop();
      }

      const rows = (await controlSql`
        SELECT kind::text AS kind, target::text AS target, trigger_reason::text AS trigger
          FROM control.job WHERE kind = 'ingest_pull'::control.job_kind`) as Array<
        Record<string, string>
      >;
      expect(rows).toEqual([
        { kind: 'ingest_pull', target: 'gmail', trigger: 'connector_cadence' },
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Reconciliation — the last link in the chain.
// ---------------------------------------------------------------------------

/**
 * **What every case above assumed, and nothing produced.**
 *
 * The block before this one proves a connected source is polled. What it does
 * *not* prove — and what nothing in `src/` proved, because nothing in `src/`
 * did it — is that a source ever becomes connected. `connectSource` had no
 * production caller: the web app minted a real connect link, the user
 * authorized at Google, and no `ConnectorState` was ever written. Every case
 * above supplied one by hand.
 *
 * These drive the real entrypoint's tick over a real control plane, with the
 * vendor's account listing as the only channel — no browser, no callback, no
 * return URL. The user in this story pressed connect and closed the tab.
 */
describe('an authorization at the vendor becomes a connection this fleet polls', () => {
  function links(): ConnectorLinks {
    return createPostgresConnectorLinks({ sql: controlSql, key: SEALED_KEY });
  }

  /** The vendor's listing, scripted, and a record of what it was asked. */
  function lister(accounts: readonly ConnectedAccount[]): ConnectorAccountLister & {
    readonly asked: readonly string[];
  } {
    const asked: string[] = [];
    return {
      get asked() {
        return asked;
      },
      accountsFor(request) {
        asked.push(`${request.tenantId}/${request.source}`);
        return Promise.resolve({ ok: true as const, value: accounts });
      },
    };
  }

  /** An account the vendor says is attached, in the shape its listing reports. */
  function attached(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
    return {
      accountId: 'apn_this_test_invented_it',
      appSlug: 'gmail',
      dead: false,
      createdAt: '2026-08-17T08:55:00.000Z',
      ...overrides,
    };
  }

  /**
   * Enough of Gmail to answer a first pull with an empty mailbox.
   *
   * Empty on purpose: what these cases are about is the connection existing and
   * being polled, and `sources.test.ts` already owns whether the adapter parses
   * mail. An empty listing still exercises the whole path — the handler opens
   * the source, reads the state reconciliation wrote out of the sealed store,
   * gates the first import and banks a cursor.
   */
  function gmailApi(): ProviderApi {
    return {
      request(request) {
        if (request.path.includes('/profile')) {
          return Promise.resolve({
            ok: true as const,
            value: { historyId: '9001', emailAddress: 'owner@example.test' },
          });
        }
        // The delta arm, so a *second* poll of the same connection is a
        // successful quiet one rather than an incidental provider error — which
        // is what makes "the cursor the first tick banked is still there" a
        // statement about the store rather than about a failed call.
        if (request.path.includes('/history')) {
          return Promise.resolve({ ok: true as const, value: { historyId: '9002', history: [] } });
        }
        if (request.path.includes('/messages')) {
          return Promise.resolve({ ok: true as const, value: { messages: [] } });
        }
        return Promise.resolve({ ok: false as const, reason: 'provider_error' as const, status: 404 });
      },
    };
  }

  async function paid(): Promise<void> {
    await controlSql`
      UPDATE control.tenant SET tier = 'paid'::control.tenant_tier WHERE tenant_id = ${TENANT}`;
  }

  async function linkRow(): Promise<{ state: string | null; fence: string; pending: Date | null }> {
    const rows = (await controlSql`
      SELECT state, fence::text AS fence, pending_since AS pending
        FROM control.connector_link
       WHERE tenant_id = ${TENANT} AND source = 'gmail'::control.connector_source
    `) as Array<{ state: string | null; fence: string; pending: Date | null }>;
    return rows[0] ?? { state: null, fence: '-1', pending: null };
  }

  async function pullJobs(): Promise<Array<{ target: string; trigger: string }>> {
    return (await controlSql`
      SELECT target::text AS target, trigger_reason::text AS trigger
        FROM control.job WHERE kind = 'ingest_pull'::control.job_kind
       ORDER BY created_at`) as Array<{ target: string; trigger: string }>;
  }

  function seamsOver(
    vendor: ConnectorAccountLister,
  ): Parameters<typeof startWorkerFleet>[1] {
    const store = links();
    return {
      connectors: createConnectorRuntime({ client: gmailApi(), links: store }),
      reconciler: createConnectorReconciler({
        links: store,
        vendor,
        tiers: createControlPlaneTiers(controlSql),
      }),
    };
  }

  /**
   * **The defect, closed, through the deployed process.**
   *
   * One tick: the fleet asks the vendor about the connect this user started,
   * writes the connection, enqueues the cadence pull, and runs it. Nothing in
   * the sequence involves the browser coming back.
   */
  test(
    'one tick turns a connect the user walked away from into a completed pull',
    async () => {
      await paid();
      await markConnectPending(controlSql, { tenantId: TENANT, source: 'gmail', now: NOW });

      const fleet = await fleetOver(seamsOver(lister([attached()])));
      try {
        await fleet.tick(NOW);
      } finally {
        await fleet.stop();
      }

      // The connection exists, sealed, and is no longer waiting to be found.
      const row = await linkRow();
      expect(row.state).toMatch(/^v1[.]/);
      expect(row.pending).toBeNull();

      // And it was polled on the same tick, rather than a cron period later.
      expect(await pullJobs()).toEqual([{ target: 'gmail', trigger: 'connector_cadence' }]);
      expect((await jobState('ingest_pull')).state).toBe('done');
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * **The trap: reconciling twice.**
   *
   * `ConnectorState` carries the cursor. A second pass that wrote a fresh state
   * over the first would reset it to `null`, `pullModeFor` would answer
   * `backfill`, and the next poll would re-import the whole mailbox — the spend
   * and the duplicate-content failure at once. Two ticks, and the second must
   * change nothing.
   */
  test(
    'a second tick neither re-enqueues nor resets the cursor the first one banked',
    async () => {
      await paid();
      await markConnectPending(controlSql, { tenantId: TENANT, source: 'gmail', now: NOW });
      const vendor = lister([attached()]);

      const first = await fleetOver(seamsOver(vendor));
      try {
        await first.tick(NOW);
      } finally {
        await first.stop();
      }

      const banked = (await links().states(TENANT))[0];
      expect(banked?.cursor).not.toBeNull();

      const second = await fleetOver(seamsOver(vendor));
      try {
        // Far enough ahead that the cadence itself is due again, so what stops a
        // second *state write* is the store's rule rather than the clock.
        await second.tick(new Date(NOW.getTime() + 3_600_000));
      } finally {
        await second.stop();
      }

      // The vendor was asked once. After adoption the link is not pending, so
      // the second pass had nothing to ask about — the bound on vendor traffic.
      expect(vendor.asked).toEqual([`${TENANT}/gmail`]);

      // The cursor moved *forward* — the second tick polled and banked a newer
      // one — and that is the difference this case is about. A re-adoption
      // would have written a fresh state: cursor `null`, `pullModeFor` back to
      // `backfill`, and the whole mailbox re-listed on the tick after that.
      const after = (await links().states(TENANT))[0] as ConnectorState;
      expect(pullModeFor(after)).toBe('delta');
      expect(after.cursor).not.toBeNull();
      expect(after.connectedAt).toBe(banked?.connectedAt ?? '');
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * **The money ruling.** The tier gate refused this account at the button;
   * reconciliation must not let a background tick undo that. Asked before the
   * vendor is, so a downgraded tenant costs no round trip either.
   */
  test(
    'a tenant the tier no longer permits is neither connected nor asked about',
    async () => {
      // Left at `seedTenant`'s default, which is `free`.
      await markConnectPending(controlSql, { tenantId: TENANT, source: 'gmail', now: NOW });
      const vendor = lister([attached()]);

      const fleet = await fleetOver(seamsOver(vendor));
      try {
        await fleet.tick(NOW);
      } finally {
        await fleet.stop();
      }

      expect(vendor.asked).toEqual([]);
      expect((await linkRow()).state).toBeNull();
      expect(await pullJobs()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * **The disconnect ruling, at the fleet.** The user pressed disconnect while
   * a pending link was still outstanding. `fenceConnectorLink` clears the intent
   * and advances the fence, and the tick that follows must find nothing to do —
   * a reconciler that re-added the connection would be a disconnect button that
   * does not work.
   */
  test(
    'a tick after a disconnect does not put the connection back',
    async () => {
      await paid();
      await markConnectPending(controlSql, { tenantId: TENANT, source: 'gmail', now: NOW });
      await controlSql`
        UPDATE control.connector_link
           SET state = NULL, pending_since = NULL, fence = fence + 1
         WHERE tenant_id = ${TENANT} AND source = 'gmail'::control.connector_source`;
      const vendor = lister([attached()]);

      const fleet = await fleetOver(seamsOver(vendor));
      try {
        await fleet.tick(NOW);
      } finally {
        await fleet.stop();
      }

      expect(vendor.asked).toEqual([]);
      expect((await linkRow()).state).toBeNull();
      expect(await pullJobs()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * A fleet where nobody is mid-connect must reach the vendor zero times. The
   * alternative — three sources times every ready tenant, every tick — is a
   * vendor bill for people who never pressed the button.
   */
  test(
    'a tick with nothing pending asks the vendor nothing at all',
    async () => {
      await paid();
      const vendor = lister([attached()]);

      const fleet = await fleetOver(seamsOver(vendor));
      try {
        await fleet.tick(NOW);
      } finally {
        await fleet.stop();
      }

      expect(vendor.asked).toEqual([]);
      expect(await pullJobs()).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );
});
