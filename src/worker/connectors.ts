/**
 * The connector lane's fleet half: the runtime seam the `ingest_pull` handler
 * needs, and the cadence pass that gives it work.
 *
 * **What was wrong.** `JOB_KINDS` has carried `ingest_pull` since U10 and
 * `LEGAL_TARGETS` has said it targets a connector source for just as long;
 * `src/ingest/pipedream/pull.ts` has known how to run one, hold a cursor, gate a
 * backfill and tombstone a deletion since U9. `src/worker/serve.ts` registered
 * `{ consolidate, export }`, and `enqueuePullIfDue` — which that module calls
 * *"the cadence trigger"* — had no caller anywhere in `src/`. So a connected
 * account would never have been polled: this is `export.ts`'s defect, one lane
 * over, in its fifth instance.
 *
 * ============================================================================
 * THE PASS OPENS NO DATABASE IT DOES NOT ALREADY HAVE A REASON TO
 * ============================================================================
 *
 * `scheduler.ts` bounds its schema sweep to avoid *"a wake plus DDL against
 * somebody's suspended database"*, and `export.ts` schedules onto the slot the
 * tenant's consolidation already wakes for the same reason. A connector cadence
 * cannot ride that slot — gmail's is 300 seconds and the consolidation ceiling
 * is a day — so the rule is honoured differently and deliberately: **the pass
 * decides due-ness from state that costs no wake, and opens the tenant's
 * database only for a tenant that has something due anyway.**
 *
 * Connector state lives in the tenant's object prefix (`src/ingest/cursor.ts`),
 * which is not their Postgres compute, so {@link ConnectorRuntime.states} reads
 * it without waking anything. The pause set is the one fact that *is* in the
 * tenant database — U14's `source_pause`, where absence is the state — and it is
 * read once per tenant, after due-ness, and only when at least one source is
 * due. A tenant whose sources are all inside their cadence costs this pass a
 * listing and nothing else; a tenant with a due source is about to be woken by
 * the pull itself.
 *
 * The pause read is not skippable, and folding it into the pull would be the
 * wrong economy: a user who paused their mailbox and watched a job get enqueued
 * every minute anyway would be right to conclude the button does nothing, which
 * is the failure `enqueuePullIfDue` names `paused` rather than `not_due` to
 * avoid.
 *
 * ============================================================================
 * THE ANTI-JOIN, FOR THE REASON `export.ts` GIVES
 * ============================================================================
 *
 * `enqueue` already refuses a second open job per (tenant, kind, target) — a
 * partial unique index, and it is the authority. But a queued pull does not
 * advance `lastPullAt`, so the state stays due until the job actually runs and
 * every tick in between would issue an INSERT and be told `already_open`. One
 * statement asks instead. Dead-lettered lanes are excluded for the same reason
 * exports exclude them: the queue would answer `quarantined` every minute until
 * an operator cleared it.
 *
 * ============================================================================
 * WHERE THE STATE THIS PASS READS ACTUALLY LIVES
 * ============================================================================
 *
 * This block used to say {@link ConnectorRuntime} had no production
 * implementation, and gave the reason: both of its methods need the connector's
 * stored state, `cursor.ts` places that state under `{tenant}/connectors/<source>`
 * in object storage, and `src/control/storage.ts` has no production
 * `ScopedCredentialMinter` — so no process in `src/` could obtain the
 * prefix-scoped credential that read requires. That was true, and the
 * consequence was worse than "the pass enqueues nothing": `connectSource` had no
 * production caller anywhere, so a user could authorize at the vendor and
 * nothing in this fleet would ever be told.
 *
 * The state now lives in the control plane, sealed
 * (`src/control/connector-store.sql` carries the whole argument, and it is the
 * one `secret-store.sql` already made for tenant credentials: the record has to
 * be shared between fleets with no volume between them). Two things follow for
 * this file:
 *
 *   * {@link ConnectorRuntime.states} still opens no tenant database. It reads
 *     one control-plane row set — which every fleet process has open already —
 *     so the economy this module is built around is unchanged.
 *   * A deployment with no vendor credential still composes no runtime, and the
 *     absence still behaves the way it did: this pass enqueues nothing, and a
 *     hand-planted `ingest_pull` row fails its handler and walks the backoff
 *     ladder to the dead-letter list. That is the designed surface for "this
 *     tenant cannot be served" — the same one `TenantNotConsolidableError` uses.
 */

import type { SQL } from 'bun';

import {
  isPullDue,
  type ConnectorSource,
  type ConnectorState,
  type ConnectorStateStore,
} from '../ingest/cursor.ts';
import { readPausedSources } from '../ingest/pause.ts';
import type { ProviderApi } from '../ingest/pipedream/client.ts';
import { enqueuePullIfDue } from '../ingest/pipedream/pull.ts';
import { createCalendarSource } from '../ingest/pipedream/sources/calendar.ts';
import { createDriveSource } from '../ingest/pipedream/sources/drive.ts';
import { createGmailSource } from '../ingest/pipedream/sources/gmail.ts';
import type { ProviderSource } from '../ingest/pipedream/sources/types.ts';
import type { TenantRuntime } from '../ingest/import/run.ts';
import type { TenantConnection } from '../control/tier.ts';
import type { EnqueueRefusal, JobQueue } from './jobs.ts';

/**
 * How this deployment reaches a tenant's connectors.
 *
 * Two methods and one reason for each: the cadence pass has to know what is
 * connected without opening a tenant's database, and the handler has to be able
 * to run one source against a live adapter and a live cursor store. Both are
 * ports because the credential-to-client mapping is the composition root's, and
 * because KTD6's Phase 5 own-OAuth swap replaces exactly this and nothing above
 * it.
 */
export interface ConnectorRuntime {
  /** Every source this tenant has connected. Must not open the tenant's database. */
  states(tenantId: string): Promise<readonly ConnectorState[]>;
  /** The adapter and the cursor store for one source, as `PullHandlerDeps.openSource` wants them. */
  open(
    tenant: TenantRuntime,
    source: ConnectorSource,
  ): Promise<{ readonly source: ProviderSource; readonly states: ConnectorStateStore }>;
}

/**
 * Thrown by the `openSource` seam when this deployment has no connector runtime.
 *
 * Typed and carrying no vendor detail, so the runner's failure reason is a code
 * an operator can act on rather than a stack trace. It says which of the two
 * missing pieces it is, because "no Pipedream credential" and "no object store
 * to keep a cursor in" are different work.
 */
export class ConnectorRuntimeUnavailableError extends Error {
  readonly source: ConnectorSource;

  constructor(source: ConnectorSource) {
    super(
      `no connector runtime is configured on this deployment, so '${source}' cannot be polled: ` +
        'a pull resumes from a cursor stored under the tenant’s object prefix, and `src/control/storage.ts` ' +
        'has no production credential minter to reach one with',
    );
    this.name = 'ConnectorRuntimeUnavailableError';
    this.source = source;
  }
}

/**
 * The `openSource` seam, built from a runtime or from its absence.
 *
 * Composed here rather than inline at the entrypoint so the refusal is one
 * object with one message, and so a deployment that gains a runtime changes a
 * composition argument rather than a handler.
 */
export function connectorSourceOpener(
  runtime: ConnectorRuntime | undefined,
): ConnectorRuntime['open'] {
  if (runtime !== undefined) return (tenant, source) => runtime.open(tenant, source);
  return (_tenant, source) => Promise.reject(new ConnectorRuntimeUnavailableError(source));
}

/**
 * The three adapters, by the source they serve.
 *
 * A record rather than a `switch`, so the set is the same shape as
 * `CONNECTOR_SOURCES` and `APP_FOR_SOURCE` and a fourth connector added to one
 * and not the others fails to typecheck rather than falling through to a
 * default. Each takes a {@link ProviderApi} and nothing else — the narrow port
 * the adapters were written against so that KTD6's Phase 5 own-OAuth swap
 * replaces the client and not them.
 */
const ADAPTER_FOR: Readonly<Record<ConnectorSource, (api: ProviderApi) => ProviderSource>> = {
  gmail: createGmailSource,
  calendar: createCalendarSource,
  drive: createDriveSource,
};

/** Where a tenant's connector states are kept, as this module needs them. */
export interface ConnectorLinkReader {
  states(tenantId: string): Promise<readonly ConnectorState[]>;
  storeFor(tenantId: string): ConnectorStateStore;
}

/**
 * The production runtime: the vendor client, and the durable link store.
 *
 * **What this closes.** `ConnectorRuntime` was a port with no implementation, so
 * `enqueueDuePulls` was a no-op in every deployment and the `ingest_pull`
 * handler's `openSource` seam refused every job. Both halves of the connector
 * lane were registered and neither could run.
 *
 * The client is shared across every tenant and every source, and that is
 * correct rather than convenient: its rate budget is per **vendor project**, so
 * one client per tenant would be N tenants each holding the whole quota while
 * each reported itself inside it.
 *
 * The store is per tenant and is built fresh per `open`, because it captures the
 * disconnect fence it read and conditions its cursor write on that value — a
 * store shared between two pulls would carry one pull's fence into the other's
 * write.
 */
export function createConnectorRuntime(deps: {
  readonly client: ProviderApi;
  readonly links: ConnectorLinkReader;
}): ConnectorRuntime {
  return {
    states(tenantId) {
      return deps.links.states(tenantId);
    },
    open(tenant, source) {
      return Promise.resolve({
        source: ADAPTER_FOR[source](deps.client),
        states: deps.links.storeFor(tenant.tenantId),
      });
    },
  };
}

export interface PullEnqueueDeps {
  /** The control plane: which tenants are ready, and which lanes are already open. */
  readonly sql: SQL;
  readonly queue: JobQueue;
  /** Absent means this deployment cannot poll; the pass is then a no-op. */
  readonly runtime?: ConnectorRuntime;
  /** The tenant's own database — opened only for a tenant with a due source. */
  readonly openTenant: (tenantId: string) => Promise<TenantConnection>;
}

export interface PullEnqueueResult {
  /** Tenants whose connector state was read. Zero means nothing is connected. */
  readonly considered: number;
  /** Tenants whose database this pass opened, which is the cost worth watching. */
  readonly opened: number;
  readonly enqueued: readonly { readonly tenantId: string; readonly source: ConnectorSource }[];
  readonly paused: readonly { readonly tenantId: string; readonly source: ConnectorSource }[];
  /**
   * Refusals, carried out rather than swallowed — `runSchedulerTick`'s rule: a
   * tick whose enqueues all come back refused looks exactly like a fleet with
   * nothing to do.
   */
  readonly refused: readonly {
    readonly tenantId: string;
    readonly source: ConnectorSource;
    readonly reason: EnqueueRefusal;
  }[];
  /**
   * Tenants whose state could not be read. Not thrown: one tenant's unreadable
   * connector record must not stop the pass for the rest of the fleet, and the
   * count is what tells an operator it is happening.
   */
  readonly unreadable: number;
}

/** How many tenants one tick will consider. The export lane's bound, for the same reason. */
const DEFAULT_LIMIT = 500;

const EMPTY: PullEnqueueResult = {
  considered: 0,
  opened: 0,
  enqueued: [],
  paused: [],
  refused: [],
  unreadable: 0,
};

export async function enqueueDuePulls(
  deps: PullEnqueueDeps,
  options: { readonly now: Date; readonly limit?: number },
): Promise<PullEnqueueResult> {
  const runtime = deps.runtime;
  // No runtime is not an error and not a silence: it is a deployment that
  // cannot poll, and asking the control plane for a tenant list to do nothing
  // with is a query per tick forever.
  if (runtime === undefined) return EMPTY;

  const limit = options.limit ?? DEFAULT_LIMIT;

  const tenants = (await deps.sql`
    SELECT t.tenant_id
      FROM control.tenant t
     WHERE t.state = 'ready'
     ORDER BY t.created_at
     LIMIT ${limit}
  `) as Array<{ tenant_id: string }>;
  if (tenants.length === 0) return EMPTY;

  // Every lane already standing, in one statement — see the header. `dead` is in
  // the set because the queue answers `quarantined` for a dead-lettered lane
  // until an operator clears it.
  const standing = (await deps.sql`
    SELECT tenant_id, target::text AS target
      FROM control.job
     WHERE kind = 'ingest_pull'::control.job_kind
       AND state IN ('due', 'running', 'dead')
  `) as Array<{ tenant_id: string; target: string }>;
  const open = new Set(standing.map((row) => `${row.tenant_id}/${row.target}`));

  const enqueued: { tenantId: string; source: ConnectorSource }[] = [];
  const paused: { tenantId: string; source: ConnectorSource }[] = [];
  const refused: { tenantId: string; source: ConnectorSource; reason: EnqueueRefusal }[] = [];
  let considered = 0;
  let opened = 0;
  let unreadable = 0;

  for (const row of tenants) {
    const tenantId = row.tenant_id;

    let states: readonly ConnectorState[];
    try {
      states = await runtime.states(tenantId);
    } catch {
      unreadable += 1;
      continue;
    }
    considered += 1;

    // Due-ness first, and it is the whole economy of this pass: everything above
    // this line is object storage, and everything below it may cost a wake.
    const due = states.filter(
      (state) => !open.has(`${tenantId}/${state.source}`) && isPullDue(state, options.now),
    );
    if (due.length === 0) continue;

    const connection = await deps.openTenant(tenantId);
    opened += 1;
    let pausedSources: readonly ConnectorSource[];
    try {
      pausedSources = await readPausedSources(connection.sql);
    } finally {
      await connection.close();
    }
    const isPaused = new Set(pausedSources);

    for (const state of due) {
      const outcome = await enqueuePullIfDue(deps.queue, {
        tenantId,
        state,
        now: options.now,
        paused: isPaused.has(state.source),
      });
      if (outcome.enqueued) {
        enqueued.push({ tenantId, source: state.source });
        continue;
      }
      if (outcome.reason === 'paused') {
        paused.push({ tenantId, source: state.source });
        continue;
      }
      // `not_due` cannot happen here — the filter above already asked — so
      // anything left is the queue's own refusal and belongs in the result.
      if (outcome.reason !== 'not_due') {
        refused.push({ tenantId, source: state.source, reason: outcome.reason });
      }
    }
  }

  return { considered, opened, enqueued, paused, refused, unreadable };
}
