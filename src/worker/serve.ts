#!/usr/bin/env bun
/**
 * The worker fleet's process entrypoint.
 *
 * **The fleet image builds one image for two entrypoints and only ever had one
 * file to name.** The Dockerfile says the worker fleet runs the same image with
 * `entrypoint` overridden on its Container class; `src/worker/` held a runner, a
 * queue, a lock ladder and a scheduler, and nothing that started any of them. So
 * this is the composition root for the batch half: it binds a port so the
 * platform's readiness poll can pass, and it ticks the scheduler and the runner
 * on a timer.
 *
 * **Why a batch process listens on a port at all.** Cloudflare's readiness is a
 * port poll against the Container class's `pingEndpoint`; an instance that never
 * binds never reports ready, whatever it is doing internally. The route is also
 * the honest place to publish what the loop is doing — a worker whose ticks are
 * all failing looks exactly like an idle one from outside.
 *
 * **This is where the billing → consolidation seam gets its caller.**
 * `createConsolidateWorld` (`src/control/tier.ts`) reads
 * `control.tenant.tier` — the column `src/control/billing.ts` is the only thing
 * allowed to write — at open time, per cycle, and hands it to the cycle as the
 * tier that decides whether the model phases run. Until this file existed the
 * seam's only caller was its own test, so a subscription change moved a column
 * that nothing in a running fleet read. That is the paid feature being given
 * away, and it is silent in the direction that costs money.
 *
 * **Two connections to the control plane, not one.** Hazard H4: the lease
 * channel must own a connection the job work never uses, or a busy pool starves
 * lease renewal and live jobs are declared dead. `createJobRunner` refuses the
 * shared wiring at construction, which is the check this file is on the wrong
 * side of if anyone simplifies it back to one handle.
 */

import { SQL } from 'bun';

import { createJobQueue, createLeaseChannel } from './queue.ts';
import { createJobRunner } from './runner.ts';
import { ALPHA_SCHEDULER, runSchedulerTick } from './scheduler.ts';
import {
  connectorSourceOpener,
  createConnectorRuntime,
  enqueueDuePulls,
  type ConnectorRuntime,
} from './connectors.ts';
import {
  createControlPlaneTiers,
  createPostgresConnectorLinks,
  ensureConnectorLinkSchema,
} from '../control/connector-pg.ts';
import {
  createControlPlaneConnectorHealth,
  ensureConnectorHealthSchema,
} from '../control/connector-health.ts';
import {
  createConnectorReconciler,
  createPipedreamAccountLister,
  type ConnectorReconciler,
} from '../ingest/pipedream/reconcile.ts';
import { createConsolidateHandler } from './consolidate/cycle.ts';
import { createExportHandler, enqueueDueExports } from './export.ts';
import { createPurgeHandler, enqueueDuePurges, purgeEnqueueEnabled } from './purge.ts';
import { ensurePurgeJobKind } from '../control/job-kinds.ts';
import { createSchemaSweepPorts } from '../control/schema-sweep.ts';
import {
  ensureAuthorizationStoreSchema,
  purgeExpiredAuthorizationState,
} from '../control/oauth-pg.ts';
import { createConsolidateWorld } from '../control/tier.ts';
import { fleetIdentity } from '../control/secrets.ts';
import { createTenantStorage } from '../control/storage.ts';
import { createImportHandler, type TenantRuntime } from '../ingest/import/run.ts';
import {
  createChatExportMaterializer,
  createImportMaterializer,
} from '../ingest/import/materialize.ts';
import type { RawStore } from '../ingest/import/raw.ts';
import { createIngestPullHandler } from '../ingest/pipedream/pull.ts';
import { DEFAULT_STEAL_GRACE_MS } from './locks.ts';
import {
  fleetRoutingProfile,
  openConnectorClient,
  openControlPlane,
  openFleetGateway,
  openSecretStore,
} from '../fleet/compose.ts';
import { announceListening, integer, port, refuseToStart, type Environment } from '../fleet/env.ts';

/** How often the loop ticks. A minute is well inside the alpha's 24h ceiling. */
const DEFAULT_TICK_MS = 60_000;

export interface WorkerFleetProcess {
  readonly port: number;
  /** One scheduler tick plus one runner pass. Exposed so a test can drive the loop. */
  tick(now?: Date): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The capabilities a caller may substitute for the ones this process builds.
 *
 * **This used to be the honest record of a lane nothing could compose.** A
 * {@link ConnectorRuntime} needed the tenant's object prefix, which needs a
 * prefix-scoped credential, which needs a `ScopedCredentialMinter` — and `src/`
 * has no production implementation of that port, so no value of any environment
 * variable composed one and the deployed process ran with the seam absent.
 *
 * Connector state now lives in the control plane, sealed, so the deployed
 * process **does** build a runtime out of its environment whenever it holds a
 * vendor credential and a sealing key ({@link connectorSeam}). What survives is
 * the parameter itself, for the reason it was worth having then: it keeps both
 * halves of the connector lane — the handler's `openSource` seam and the cadence
 * pass — wired to the *same* supplier, and it lets a test drive a tick against a
 * runtime it controls without a vendor on the other end.
 *
 * A supplier passed here wins over the one the environment would build, so a
 * test's runtime is not silently shadowed by a `.env` an operator left lying
 * around.
 */
export interface WorkerFleetSeams {
  readonly connectors?: ConnectorRuntime;
  /** Substituted alongside the runtime, so a test tick can reconcile too. */
  readonly reconciler?: ConnectorReconciler;
}

export async function startWorkerFleet(
  env: Environment,
  seams: WorkerFleetSeams = {},
): Promise<WorkerFleetProcess> {
  const controlSql = openControlPlane(env);
  // The dedicated lease channel (H4). Its own handle, never the work one.
  const leaseSql = new SQL(env['BRAINZ_CONTROL_DATABASE_URL'] as string, { max: 2 });
  const secrets = await openSecretStore(env, controlSql);
  const gateway = openFleetGateway(env, { controlSql, keys: secrets.providerKeys });

  // **Applied here as well as in the MCP fleet, and not for this fleet's own
  // reads — it has none.** The sweep below is the only thing here that touches
  // those tables, and a worker that boots before any MCP instance has ever
  // started would otherwise fail every tick on `relation does not exist`. The
  // ensure is idempotent and advisory-locked, so whichever fleet gets there
  // first does the work and the others ask a question and move on.
  await ensureAuthorizationStoreSchema(controlSql);
  // Same argument, second table: this fleet reads connector links on every tick,
  // and a worker that booted before any web instance had ever served a connect
  // would otherwise fail every tick on `relation does not exist`.
  await ensureConnectorLinkSchema(controlSql);
  // Third table, and this fleet is the one that WRITES it: every `ingest_pull`
  // attempt banks its outcome there, and the dashboard and `/admin` both read a
  // failed poll's cause out of it. Ensured at boot rather than on first write —
  // a missing table would turn every attempt's record into a logged error and
  // leave the product back where it started, with the cause on stdout.
  await ensureConnectorHealthSchema(controlSql);
  // Not a table but a *change*, and the same argument: `src/control/schema.sql`
  // builds a control plane from nothing and is run once, so a value added to
  // `control.job_kind` reaches new installs and no live deployment. This fleet
  // enqueues `purge` on every tick; without the rung the insert answers
  // `22P02 invalid input value for enum control.job_kind` forever. See
  // `src/control/job-kinds.ts`.
  await ensurePurgeJobKind(controlSql);

  const queue = createJobQueue({ sql: controlSql });
  const leases = createLeaseChannel({ sql: leaseSql });

  /**
   * The tenant's own database, resolved through the secret store by **that
   * tenant's** fleet identity and nothing wider. `close` is honoured because a
   * worker that opened a connection per job and never closed one exhausts the
   * per-tenant LRU the whole runtime choice was made around.
   */
  /**
   * One tenant's database, opened under that tenant's fleet identity and no
   * wider one. Lifted out of the consolidation world because the export job
   * needs exactly the same handle under exactly the same identity, and two
   * copies of this closure is two places for the identity to be widened.
   */
  async function connectTenant(tenantId: string) {
    const resolved = await secrets.store.resolve(fleetIdentity(tenantId), tenantId);
    if (!resolved.ok) {
      throw new Error(
        `no resolvable connection secret for ${tenantId} (${resolved.reason}); this instance cannot serve it`,
      );
    }
    const sql = new SQL(resolved.secret.connectionString, { max: 2 });
    return { sql, close: () => sql.close() };
  }

  const ports = createConsolidateWorld({
    controlSql,
    connect: connectTenant,
    // One gateway per tenant is the R22 shape, and this fleet's gateway already
    // resolves keys per tenant on every call, so the same instance satisfies it.
    gateway: () => gateway,
    onCycle(tenantId, result) {
      process.stdout.write(
        `${JSON.stringify({
          event: 'cycle',
          tenant: tenantId,
          stop_reason: result.stopReason,
          // The one that separates "this brain finished" from "this brain ran
          // out of clock". A tenant emitting it cycle after cycle is a brain
          // whose free tier no longer fits an attempt — the condition that
          // preceded a dead lane, visible here before it becomes one, and
          // nothing else in this log would show it.
          more_to_do: result.moreToDo,
          // Which phase stopped it, and with what code. Both are closed
          // vocabularies, so this line stays as content-free as the reason
          // beside it. It is also on the run record now — this log is a
          // convenience for whoever can read the container's output, and the
          // reason the columns exist is that on this fleet nobody can.
          stopped_phase: result.stoppedPhase?.phase ?? null,
          stopped_phase_code: result.stoppedPhase?.code ?? null,
          wall_clock_ms: result.wallClockMs,
          model_calls: result.modelCalls,
          spent_micro_usd: result.spentMicroUsd,
          // Pages this cycle stopped trying to consolidate. Every other field
          // here reports something that went wrong loudly; this one is the only
          // thing the cycle does that removes a page from the brain's own
          // reading and produces no other symptom at all. A count rather than a
          // list, for the same reason `stopped_phase` is a name rather than a
          // sentence — the pages carry the code, and this log carries nothing
          // about their contents.
          quarantined: result.quarantined,
        })}\n`,
      );
    },
  });

  /**
   * U17's scheduled self-export, given the handler and the enqueuer it never
   * had (`src/worker/export.ts`).
   *
   * **`destinations` is empty, and that is a statement rather than a stub.**
   * The two kinds this fleet could serve are both blocked on something that
   * does not exist in `src/`:
   *
   *   * `object_store` — `src/control/object-store.ts` is a real
   *     `ErasableObjectStore`/writer against the storage accessor, but every
   *     call needs a prefix-scoped credential and there is no production
   *     `ScopedCredentialMinter` anywhere in `src/`. `web/serve.ts` wires a
   *     *refusing* minter for exactly this reason, and a destination whose
   *     every delivery fails is worse than a fleet that admits it has none:
   *     the failure would be banked on the tenant's row and read back to the
   *     user as their scheduled export failing.
   *   * `user_bucket` — rung 9's `self_export` carries a destination *kind* and
   *     no address and no credential, so there is nowhere to put the one the
   *     user would give us. `/api/export-config` still answers `501` saying so.
   *
   * Registering the handler anyway is deliberate: a job already on the queue
   * drains to an honest outcome instead of sitting `due` forever, which is what
   * happens to a kind the runner has no handler for.
   */
  const exportHandler = createExportHandler({
    open: connectTenant,
    destinations: {},
    onExport(tenantId, outcome) {
      process.stdout.write(`${JSON.stringify({ event: 'export', tenant: tenantId, ...outcome })}\n`);
    },
  });

  /**
   * R12's retention sweep, given the handler and the enqueuer it never had
   * (`src/worker/purge.ts`).
   *
   * **This is the first time `forget`'s 72-hour TTL is enforced by anything.**
   * `purgeExpiredTombstones` had no production caller at all — every reference
   * to it in `src/` was a comment reasoning from a sweep that did not run. The
   * handler takes the module's conservative default budget, so a first pass over
   * a brain carrying years of tombstones is small and countable and the next
   * slot resumes it; see the file header for why a run that does not finish
   * completes the job rather than failing it.
   */
  const purgeHandler = createPurgeHandler({
    open: connectTenant,
    onPurge(tenantId, result) {
      process.stdout.write(
        `${JSON.stringify({
          event: 'purge',
          tenant: tenantId,
          cutoff: result.cutoff,
          batches: result.batches,
          exhausted: result.exhausted,
          // Both halves, because the second is the one the receipt never had:
          // rows removed by a foreign key that nobody ever retracted.
          removed: result.counts,
          cascaded: result.cascaded,
        })}\n`,
      );
    },
  });

  /**
   * The two ingest lanes, and the seam each is missing.
   *
   * **Both handlers are registered, and both are registered *because* their
   * suppliers are absent rather than in spite of it.** `createJobRunner` scopes
   * its claim to the handler keys it is given, so an unregistered kind is not
   * safe — it is a row that sits `due` forever, invisible to the dead-letter
   * list an operator reads. A registered handler whose seam refuses fails the
   * job, walks the backoff ladder and lands somewhere a human can see it, which
   * is the same choice `createExportHandler` makes about a destination it cannot
   * build and the same one `TenantNotConsolidableError` makes about a tenant it
   * cannot open.
   *
   * **What is absent, and it is one thing wearing two hats.** Both lanes need
   * the tenant's object prefix — the connector's cursor lives at
   * `{tenant}/connectors/<source>`, a deferred import's manifest and preserved
   * payload at `{tenant}/imports/` and `{tenant}/raw/` — and reaching one needs
   * a prefix-scoped credential from a `ScopedCredentialMinter`, of which `src/`
   * has no production implementation. So neither lane can be *enqueued* on this
   * deployment either: `enqueueDuePulls` is a no-op without a runtime, and the
   * gate cannot defer an import whose manifest it cannot write. Nothing
   * dead-letters today because nothing is queued; what changes when a minter
   * lands is a composition argument here, not a handler.
   *
   * The storage accessor **is** built, with a refusing minter — the shape
   * `web/serve.ts` uses and for the same reason: deriving a key needs no minter,
   * and a fleet that wired the in-memory one as production would be handing out
   * credentials no object store honours.
   */
  const storage = prefixSource();
  const rawStore = absentRawStore();
  const profile = fleetRoutingProfile(env);

  /**
   * The connector lane's two halves, from this deployment's own credentials.
   *
   * They travel together on purpose. A runtime without a reconciler polls
   * connections nothing can create; a reconciler without a runtime creates
   * connections nothing polls. Both come from the same vendor client and the
   * same link store, so a deployment has the lane or does not have it.
   */
  const connectors = connectorSeam(env, { controlSql, secrets, seams });

  async function openIngestTenant(tenantId: string): Promise<IngestTenant> {
    const connection = await connectTenant(tenantId);
    return {
      runtime: {
        sql: connection.sql,
        gateway,
        tenantId,
        caller: fleetIdentity(tenantId),
      },
      close: connection.close,
    };
  }

  const ingestPullHandler = createIngestPullHandler({
    control: controlSql,
    profile,
    openTenant: async (tenantId) => (await openIngestTenant(tenantId)).runtime,
    closeTenant: (tenant) => tenant.sql.close(),
    openSource: connectorSourceOpener(connectors.runtime),
    // The durable half. `onResult` below still writes the live line, and it is
    // still unreadable from outside the container — `wrangler tail` captures the
    // Worker, not this process — which is precisely why the same facts now land
    // in a table two other surfaces can read.
    health: createControlPlaneConnectorHealth(controlSql, (error) => {
      process.stderr.write(
        `${JSON.stringify({
          event: 'connector_health_unrecorded',
          message: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    }),
    onResult(result, lease) {
      process.stdout.write(
        `${JSON.stringify({
          event: 'pull',
          tenant: lease.tenantId,
          source: lease.target,
          outcome: result.outcome,
          written: result.counts.written,
          quarantined: result.counts.quarantined,
          suppressed: result.counts.suppressed,
          stop_reason: result.stopReason ?? null,
        })}\n`,
      );
    },
  });

  const importHandler = createImportHandler({
    control: controlSql,
    storage,
    rawStore,
    profile,
    openTenant: async (tenantId) => (await openIngestTenant(tenantId)).runtime,
    closeTenant: (tenant) => tenant.sql.close(),
    // `chat_export` is the target this deployment could serve the moment the
    // object store lands; `folder` is absent for a reason that is not the object
    // store at all — a container has no access to the user's filesystem. Both
    // refusals are `materialize.ts`'s, so the two reasons stay separate.
    materialize: createImportMaterializer({
      chat_export: createChatExportMaterializer({ rawStore, storage }),
    }),
  });

  const runner = createJobRunner({
    queue,
    leases,
    handlers: {
      consolidate: createConsolidateHandler(ports),
      export: exportHandler,
      purge: purgeHandler,
      ingest_pull: ingestPullHandler,
      import: importHandler,
    },
    owner: `worker-${process.pid}`,
    concurrency: integer(env, 'BRAINZ_WORKER_CONCURRENCY', 4),
  });

  const schemas = createSchemaSweepPorts({ control: controlSql, secrets: secrets.store });

  async function tick(now: Date = new Date()): Promise<void> {
    // The scheduler first: reclaim what died, migrate who is behind, enqueue who
    // is due. Then the runner drains what is now claimable. The other order runs
    // a pass against a queue this tick has not filled yet.
    await runSchedulerTick(
      { sql: controlSql, queue, config: ALPHA_SCHEDULER, stealGraceMs: DEFAULT_STEAL_GRACE_MS, schemas },
      { now },
    );
    // The export lane, alongside the consolidation one rather than inside it:
    // `runSchedulerTick` is the consolidation trigger set and folding a second
    // cadence into it would make its result type answer for two questions. Each
    // tenant's export is scheduled onto the slot its consolidation already
    // wakes, so this adds a job and not a wake — see `export.ts`.
    await enqueueDueExports({ sql: controlSql, queue }, { now });
    // The retention lane, on the same slot as the export for the same reason:
    // both ride a wake the consolidation ceiling already pays for. Its own
    // enqueuer rather than a branch inside the export's, so a result type still
    // answers one question.
    await enqueueDuePurges({ sql: controlSql, queue }, { now, enabled: purgeEnqueueEnabled(env) });
    // **Reconciliation, and it runs BEFORE the cadence pass rather than after.**
    // A connection adopted this tick is due immediately (`lastPullAt` is null,
    // so `nextPullAt` is the epoch), so reconciling first means a user who
    // authorized while this instance was asleep gets their first poll on the
    // same wake rather than half an hour later. The other order costs a whole
    // cron period for nothing.
    //
    // It asks the vendor only about links a user actually started — a pending
    // row in the control plane, written when they pressed the button — so a
    // fleet where nobody is mid-connect reaches the vendor zero times.
    if (connectors.reconciler !== undefined) {
      const reconciled = await connectors.reconciler.run({ now });
      // Reported rather than swallowed, and both halves: `runSchedulerTick`'s
      // rule is that a tick whose every attempt came back refused looks exactly
      // like a fleet with nothing to do.
      if (reconciled.asked > 0) {
        process.stdout.write(
          `${JSON.stringify({
            event: 'connector_reconcile',
            asked: reconciled.asked,
            adopted: reconciled.adopted.length,
            refused: reconciled.refused.map((entry) => entry.reason),
          })}\n`,
        );
      }
    }
    // The connector cadence, which cannot ride the consolidation slot the export
    // lane rides — gmail's is 300 seconds against a daily ceiling. It costs one
    // control-plane query and, per tenant, a listing that wakes nothing; a
    // tenant's own database is opened only when that listing says a source is
    // already due. See `connectors.ts`. A deployment with no connector runtime
    // returns before the first query.
    await enqueueDuePulls(
      {
        sql: controlSql,
        queue,
        openTenant: connectTenant,
        ...(connectors.runtime === undefined ? {} : { runtime: connectors.runtime }),
      },
      { now },
    );
    await runner.runOnce({ now });
    // The OAuth store's hygiene, last: nothing in the flow's correctness waits
    // on it — every read applies its own expiry bound, so an unswept row is
    // never honoured — but a table that only grows is the thing that pages
    // somebody at 3am, and an abandoned consent screen leaves a code behind.
    //
    // **This fleet, rather than the MCP one, because this is the fleet with a
    // cadence.** A Cloudflare cron wakes it every thirty minutes whether or not
    // anybody is using their connector; the MCP instances scale to zero, so a
    // timer there would only run while the flow was busy. The revocation arm
    // keeps its own, much longer, derived retention — see
    // `oauth-pg.ts:REVOCATION_RETENTION_SECONDS`.
    await purgeExpiredAuthorizationState(controlSql, { now });
  }

  const stopHeartbeat = runner.start();
  const tickMs = integer(env, 'BRAINZ_WORKER_TICK_MS', DEFAULT_TICK_MS);
  const timer = setInterval(() => {
    // A tick that throws must not take the process with it: the next tick is a
    // minute away and an unhandled rejection here is a crash loop over one bad
    // batch. It is reported, loudly, and never swallowed.
    void tick().catch((error: unknown) => {
      process.stderr.write(
        `${JSON.stringify({ event: 'tick_failed', message: error instanceof Error ? error.message : String(error) })}\n`,
      );
    });
  }, tickMs);

  const http = Bun.serve({
    port: port(env),
    hostname: '0.0.0.0',
    fetch(request: Request): Response {
      const path = new URL(request.url).pathname;
      if (path === '/health') {
        return Response.json({ ok: true, service: 'worker', inFlight: runner.inFlight() });
      }
      return new Response('not found', { status: 404 });
    },
  });

  // The port the socket actually bound, off the server's own URL: with `PORT=0`
  // the OS chooses it, so a caller that echoed the configured value would report
  // `0` and a harness would dial nothing.
  const bound = Number(http.url.port);
  announceListening({ service: 'worker', port: bound });

  return {
    port: bound,
    tick,
    async stop() {
      clearInterval(timer);
      stopHeartbeat();
      await http.stop(true);
      await controlSql.close();
      await leaseSql.close();
    },
  };
}

/**
 * The connector lane, composed from this deployment's environment.
 *
 * **Three ways it comes back empty, and each is a real deployment rather than a
 * misconfiguration.** No vendor credential is a self-hoster who ingests chat
 * exports and folders (R8a) and never connects an account. No sealing key is the
 * `file` secret backend, where there is no sealed control-plane store to keep a
 * connection in. A caller-supplied runtime is a test driving the lane without a
 * vendor on the other end, and it wins over both — a suite must not be silently
 * shadowed by an operator's `.env`.
 *
 * **The two halves are composed together and never separately.** A runtime with
 * no reconciler polls connections that nothing can create; a reconciler with no
 * runtime writes connections that nothing polls. That pairing was the shape of
 * the defect this whole lane spent a unit in, and building them from one client
 * and one store is what stops it recurring by omission.
 */
function connectorSeam(
  env: Environment,
  deps: {
    readonly controlSql: SQL;
    readonly secrets: Awaited<ReturnType<typeof openSecretStore>>;
    readonly seams: WorkerFleetSeams;
  },
): { readonly runtime?: ConnectorRuntime; readonly reconciler?: ConnectorReconciler } {
  const supplied = {
    ...(deps.seams.connectors === undefined ? {} : { runtime: deps.seams.connectors }),
    ...(deps.seams.reconciler === undefined ? {} : { reconciler: deps.seams.reconciler }),
  };
  if (supplied.runtime !== undefined) return supplied;

  const client = openConnectorClient(env);
  const key = deps.secrets.sealingKey;
  if (client === undefined || key === undefined) return supplied;

  const links = createPostgresConnectorLinks({ sql: deps.controlSql, key });
  return {
    runtime: createConnectorRuntime({ client, links }),
    reconciler:
      supplied.reconciler ??
      createConnectorReconciler({
        links,
        vendor: createPipedreamAccountLister(client),
        tiers: createControlPlaneTiers(deps.controlSql),
      }),
  };
}

/** One tenant's ingest runtime, and the handle discipline the rest of this file uses. */
interface IngestTenant {
  readonly runtime: TenantRuntime;
  close(): Promise<void>;
}

/**
 * The storage accessor, with a minter that refuses.
 *
 * Deriving a key needs no credential — `manifestKeyFor` and `rawKeyFor` are pure
 * functions of the accessor's own layout — so the import handler can compute
 * exactly where a manifest *would* be. What it cannot do is mint the credential
 * to read it, and the refusal below is why: `createInMemoryCredentialMinter`
 * says in its own header that it is not R2's scheme, and a fleet that wired it
 * as production would hand out credentials no object store honours. Same
 * construction, same reason, as `src/web/serve.ts:prefixSource`.
 */
function prefixSource(): ReturnType<typeof createTenantStorage> {
  return createTenantStorage({
    minter: {
      mint() {
        return Promise.reject(
          new Error(
            'no object-storage credential minter is configured; this fleet derives keys and never mints',
          ),
        );
      },
    },
  });
}

/**
 * The object store this deployment does not have.
 *
 * **Not an in-memory store standing in.** A `Map` here would make the import
 * handler *succeed*: `readManifest` would answer `null` for a job whose manifest
 * a different container wrote, and the handler would throw the "no manifest"
 * error — or worse, on a machine where the same instance wrote it, the import
 * would run and its raw payload would die with the container. That is the
 * per-container tmpfile the durable secret store exists to end, rebuilt one
 * layer up. A refusal names the missing piece instead.
 */
function absentRawStore(): RawStore {
  const refuse = (): Promise<never> =>
    Promise.reject(
      new Error(
        'no object store is configured on this deployment; `src/control/storage.ts` has no production credential minter',
      ),
    );
  return { put: refuse, get: refuse };
}

if (import.meta.main) {
  try {
    await startWorkerFleet(process.env);
  } catch (error) {
    refuseToStart(error);
  }
}
