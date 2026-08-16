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
import { createConsolidateHandler } from './consolidate/cycle.ts';
import { createSchemaSweepPorts } from '../control/schema-sweep.ts';
import { createConsolidateWorld } from '../control/tier.ts';
import { fleetIdentity } from '../control/secrets.ts';
import { DEFAULT_STEAL_GRACE_MS } from './locks.ts';
import { openControlPlane, openFleetGateway, openSecretStore } from '../fleet/compose.ts';
import { announceListening, integer, port, refuseToStart, type Environment } from '../fleet/env.ts';

/** How often the loop ticks. A minute is well inside the alpha's 24h ceiling. */
const DEFAULT_TICK_MS = 60_000;

export interface WorkerFleetProcess {
  readonly port: number;
  /** One scheduler tick plus one runner pass. Exposed so a test can drive the loop. */
  tick(now?: Date): Promise<void>;
  stop(): Promise<void>;
}

export async function startWorkerFleet(env: Environment): Promise<WorkerFleetProcess> {
  const controlSql = openControlPlane(env);
  // The dedicated lease channel (H4). Its own handle, never the work one.
  const leaseSql = new SQL(env['BRAINZ_CONTROL_DATABASE_URL'] as string, { max: 2 });
  const secrets = openSecretStore(env);
  const gateway = openFleetGateway(env, { controlSql, keys: secrets.providerKeys });

  const queue = createJobQueue({ sql: controlSql });
  const leases = createLeaseChannel({ sql: leaseSql });

  /**
   * The tenant's own database, resolved through the secret store by **that
   * tenant's** fleet identity and nothing wider. `close` is honoured because a
   * worker that opened a connection per job and never closed one exhausts the
   * per-tenant LRU the whole runtime choice was made around.
   */
  const ports = createConsolidateWorld({
    controlSql,
    async connect(tenantId: string) {
      const resolved = await secrets.store.resolve(fleetIdentity(tenantId), tenantId);
      if (!resolved.ok) {
        throw new Error(
          `no resolvable connection secret for ${tenantId} (${resolved.reason}); this instance cannot consolidate it`,
        );
      }
      const sql = new SQL(resolved.secret.connectionString, { max: 2 });
      return { sql, close: () => sql.close() };
    },
    // One gateway per tenant is the R22 shape, and this fleet's gateway already
    // resolves keys per tenant on every call, so the same instance satisfies it.
    gateway: () => gateway,
    onCycle(tenantId, result) {
      process.stdout.write(
        `${JSON.stringify({
          event: 'cycle',
          tenant: tenantId,
          stop_reason: result.stopReason,
          model_calls: result.modelCalls,
          spent_micro_usd: result.spentMicroUsd,
        })}\n`,
      );
    },
  });

  const runner = createJobRunner({
    queue,
    leases,
    handlers: { consolidate: createConsolidateHandler(ports) },
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
    await runner.runOnce({ now });
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

if (import.meta.main) {
  try {
    await startWorkerFleet(process.env);
  } catch (error) {
    refuseToStart(error);
  }
}
