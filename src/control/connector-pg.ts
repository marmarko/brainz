/**
 * The connector link, in the control plane — the durable half of "an
 * authorization at the vendor became a connection this brain polls".
 *
 * `src/control/connector-store.sql` carries the argument for the placement and
 * for every column; this module is the four statements that make the
 * concurrency claims true, and each one is written the way it is because the
 * obvious version is wrong under a fleet with more than one instance.
 *
 * **1. Adoption is a conditional INSERT, so "reconciled twice" is decided by the
 * engine.** `ConnectorState` carries the cursor. A second reconciliation that
 * overwrote a live state would reset that cursor to `null`, `pullModeFor` would
 * answer `backfill`, and the next poll would re-import a mailbox the brain
 * already holds — the spend *and* the duplicate-content failure. So
 * {@link ConnectorLinks.adopt} is `UPDATE … WHERE state IS NULL AND fence = $`:
 * create-only is a property of the statement, not a check a caller performs
 * before it.
 *
 * **2. Every write is fenced, including the cursor advance.** A pull reads the
 * state, spends a minute against the provider, and writes the cursor back. If
 * the user pressed disconnect in between, that write must not put the connection
 * back — the runner would then poll with a credential we have already asked the
 * vendor to revoke. So the store handed to the pull runner captures the fence on
 * `read` and conditions its `write` on it, and a write whose fence has moved is
 * **dropped silently**. Silent is right here and only here: the state it would
 * have written belongs to a connection the user has removed, and throwing would
 * dead-letter a job whose work is already correctly discarded.
 *
 * **3. A record that will not open, or will not parse, is a throw.**
 * `secrets.ts` states the rule this inherits: "the store is down" and "this
 * tenant does not exist" are different sentences, and a fleet booted with the
 * wrong key must look like a broken fleet rather than like a database that lost
 * every tenant. Answering `[]` would be worse here than in the secret store,
 * because adoption is create-only: nothing would ever repair the row, and a live
 * cursor would sit unreadable behind a dashboard that says "not connected".
 * `enqueueDuePulls` already catches per tenant and counts `unreadable`, which is
 * where an operator sees it.
 *
 * **4. The intent and the fence need no key.** Recording that a user pressed
 * connect, and clearing a link on disconnect, are a timestamp and a counter —
 * so `src/web/app.ts` performs both directly, and holds no sealing key and no
 * ability to read a connector state back. That is the same narrowing
 * `ProviderKeyWriter` gives BYOK, arrived at by which statements need a key.
 */

import type { SQL } from 'bun';

import { seal, unseal } from './sealed.ts';
import {
  isConnectorSource,
  parseConnectorState,
  type ConnectorSource,
  type ConnectorState,
  type ConnectorStateStore,
} from '../ingest/cursor.ts';
import type { ConnectorTierReader, PendingLink } from '../ingest/pipedream/reconcile.ts';

/** Its own advisory lock, after the schema runner's, the secret store's and the OAuth store's. */
export const CONNECTOR_LINK_LOCK_KEY = 80_120_266;

const DDL_PATH = `${import.meta.dir}/connector-store.sql`;

/**
 * How long a connect the user never finished keeps costing a vendor round trip.
 *
 * Thirty-six hours: long enough that somebody who authorized on their phone and
 * came back the next morning is still reconciled, short enough that an abandoned
 * consent screen is not a query against the vendor forever. It is deliberately
 * far longer than the connect link's own ten-minute TTL, because the two bound
 * different things — the link bounds who can attach an account, this bounds how
 * long we keep looking for one.
 */
export const PENDING_WINDOW_MS = 36 * 60 * 60 * 1_000;

/** How many pending links one fleet-wide pass considers. The export lane's bound. */
const DEFAULT_PENDING_LIMIT = 500;

export class ConnectorLinkError extends Error {
  readonly tenantId: string;
  readonly source: string;

  constructor(tenantId: string, source: string, why: string) {
    // No envelope, no plaintext, no vendor text. An error object is the most
    // casually-logged thing in any system and this one names a tenant already.
    super(`the connector link for '${tenantId}/${source}' is unusable: ${why}`);
    this.name = 'ConnectorLinkError';
    this.tenantId = tenantId;
    this.source = source;
  }
}

/**
 * The AAD every envelope is bound to.
 *
 * Per (tenant, source), so a row lifted from one tenant and pasted over
 * another's fails to open instead of handing tenant B tenant A's mailbox — and
 * so a gmail envelope moved onto the calendar row fails too, which is the
 * cross-source version of the same mistake.
 */
export function connectorNamespace(tenantId: string, source: ConnectorSource): string {
  return `connector/${tenantId}/${source}`;
}

async function storePresent(sql: SQL): Promise<boolean> {
  const rows = (await sql`
    SELECT to_regclass('control.connector_link') IS NOT NULL AS present
  `) as unknown as { present: boolean }[];
  return rows[0]?.present === true;
}

/**
 * Create the table if this deployment does not have it yet.
 *
 * Idempotent and advisory-locked: whichever fleet boots first does the work and
 * the others ask a question and move on. The catch-and-re-ask is the shape
 * `secret-pg.ts` settled — two instances racing the catalog check can both pass
 * it, and the loser's `CREATE` fails on a table the winner just made.
 */
export async function ensureConnectorLinkSchema(sql: SQL): Promise<void> {
  if (await storePresent(sql)) return;

  const ddl = await Bun.file(DDL_PATH).text();
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(${CONNECTOR_LINK_LOCK_KEY})`;
      if (await storePresent(tx)) return;
      await tx.unsafe(ddl);
    });
  } catch (error) {
    if (!(await storePresent(sql))) throw error;
  }
}

/**
 * Record that a user asked for this connector, before they leave for the vendor.
 *
 * **Before, not after, and that is the design.** The moment the user presses the
 * button is the last one this side is guaranteed to see: they may authorize and
 * close the tab. This row is what lets the fleet go and ask the vendor later
 * about a connection nobody came back to report.
 *
 * Pressing connect twice is one link. The `pending_since` is refreshed rather
 * than left at the first press, because the window it opens is measured from the
 * user's most recent intent.
 *
 * **It never disturbs a connected link.** `WHERE state IS NULL` on the conflict
 * path: a user who presses connect on a source that is already polling has asked
 * for a link to a connection they already have, and clearing the state to
 * "pending" would stop the polling and — because adoption is create-only against
 * a fresh state — resume it later from no cursor at all.
 */
export async function markConnectPending(
  sql: SQL,
  request: { readonly tenantId: string; readonly source: ConnectorSource; readonly now: Date },
): Promise<void> {
  await sql`
    INSERT INTO control.connector_link (tenant_id, source, pending_since, created_at, updated_at)
    VALUES (
      ${request.tenantId},
      ${request.source}::control.connector_source,
      ${request.now}, ${request.now}, ${request.now}
    )
    ON CONFLICT (tenant_id, source) DO UPDATE
       SET pending_since = ${request.now}, updated_at = ${request.now}
     WHERE control.connector_link.state IS NULL`;
}

/**
 * Disconnect: clear the connection, forget the intent, advance the fence.
 *
 * **This runs before the vendor is told anything.** The failure a disconnect
 * must never have is polling with a credential we have asked to have revoked, so
 * the polling stops first and the revocation follows. The reverse order has a
 * window in which a reconciliation pass that listed the account before the
 * delete can still commit — and the connection comes back with no vendor account
 * behind it.
 *
 * The fence is the backstop rather than the mechanism: clearing `pending_since`
 * already stops the next pass from asking. What the fence covers is the pass
 * that is *already* mid-flight, holding a value it read before any of this.
 *
 * A source nobody connected is not an error. The vendor is the authority on
 * whether an account exists, and a throw here would turn a user pressing
 * disconnect on an already-clean source into a 500.
 */
export async function fenceConnectorLink(
  sql: SQL,
  request: { readonly tenantId: string; readonly source: ConnectorSource; readonly now: Date },
): Promise<void> {
  await sql`
    INSERT INTO control.connector_link (tenant_id, source, fence, created_at, updated_at)
    VALUES (${request.tenantId}, ${request.source}::control.connector_source, 1, ${request.now}, ${request.now})
    ON CONFLICT (tenant_id, source) DO UPDATE
       SET state = NULL,
           pending_since = NULL,
           fence = control.connector_link.fence + 1,
           updated_at = ${request.now}`;
}

/**
 * Which tier a tenant is on, from `control.tenant.tier`.
 *
 * **This column rather than the account's subscription row**, and it is a
 * deliberate choice rather than the nearest handle: the worker fleet holds no
 * identity database at all, `applyBillingEvent` writes both halves of a tier
 * transition, and a rule whose answer depended on which fleet asked would be two
 * rulings wearing one name. `effectiveTierOf` reads the same column for the same
 * reason, one direction over.
 *
 * A tenant with no row reads as `free` — the fail-closed direction. Connecting
 * an account carries a monthly vendor fee, so "I could not find out" must mean
 * "do not start one".
 */
export function createControlPlaneTiers(sql: SQL): ConnectorTierReader {
  return {
    async tierFor(tenantId) {
      const rows = (await sql`
        SELECT tier::text AS tier FROM control.tenant WHERE tenant_id = ${tenantId}
      `) as unknown as { tier: string }[];
      const tier = rows[0]?.tier;
      return tier === 'paid' || tier === 'internal' ? tier : 'free';
    },
  };
}

/**
 * What this tenant's links say, without opening one envelope.
 *
 * The dashboard needs to answer "did my authorization land?" and that is a
 * question about `state IS NULL`, not about the state — so it is answered from
 * two columns and no sealing key, which is what keeps `src/web/app.ts` unable to
 * read a connector's cursor while still being able to render its status
 * honestly.
 */
export type ConnectorLinkView = 'connected' | 'pending' | 'absent';

export async function readConnectorLinks(
  sql: SQL,
  request: { readonly tenantId: string; readonly now: Date },
): Promise<ReadonlyMap<string, ConnectorLinkView>> {
  const since = new Date(request.now.getTime() - PENDING_WINDOW_MS);
  const rows = (await sql`
    SELECT source::text AS source,
           state IS NOT NULL AS connected,
           (state IS NULL AND pending_since IS NOT NULL AND pending_since > ${since}) AS pending
      FROM control.connector_link
     WHERE tenant_id = ${request.tenantId}
  `) as unknown as { source: string; connected: boolean; pending: boolean }[];

  const views = new Map<string, ConnectorLinkView>();
  for (const row of rows) {
    views.set(row.source, row.connected ? 'connected' : row.pending ? 'pending' : 'absent');
  }
  return views;
}

export interface ConnectorLinks {
  /**
   * Connects the user asked for that have not produced a connection yet, with
   * the fence each was read under.
   */
  pending(request: {
    readonly now: Date;
    /** One tenant's, for the dashboard. Absent means the whole fleet's. */
    readonly tenantId?: string;
    readonly limit?: number;
  }): Promise<readonly PendingLink[]>;
  /** Every source this tenant has connected. Opens no tenant database. */
  states(tenantId: string): Promise<readonly ConnectorState[]>;
  /** Create-only, fenced. `false` means somebody else got there first. */
  adopt(request: {
    readonly tenantId: string;
    readonly source: ConnectorSource;
    readonly fence: number;
    readonly state: ConnectorState;
  }): Promise<boolean>;
  /** The cursor store one pull runs against. Fenced on the value it read. */
  storeFor(tenantId: string): ConnectorStateStore;
}

export interface ConnectorLinksOptions {
  readonly sql: SQL;
  readonly key: CryptoKey;
  readonly now?: () => Date;
}

export function createPostgresConnectorLinks(options: ConnectorLinksOptions): ConnectorLinks {
  const { sql, key } = options;
  const now = options.now ?? (() => new Date());

  async function open(tenantId: string, source: ConnectorSource, envelope: string): Promise<ConnectorState> {
    let plaintext: string;
    try {
      plaintext = await unseal(key, connectorNamespace(tenantId, source), envelope);
    } catch (error) {
      throw new ConnectorLinkError(
        tenantId,
        source,
        `its envelope did not open (${error instanceof Error ? error.name : 'unknown'})`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext) as unknown;
    } catch {
      throw new ConnectorLinkError(tenantId, source, 'it opened to something that is not JSON');
    }

    const state = parseConnectorState(parsed);
    if (state === null || state.source !== source) {
      throw new ConnectorLinkError(tenantId, source, 'it opened to something that is not this source’s state');
    }
    return state;
  }

  function sealFor(tenantId: string, state: ConnectorState): Promise<string> {
    return seal(key, connectorNamespace(tenantId, state.source), JSON.stringify(state));
  }

  return {
    async pending(request) {
      const since = new Date(request.now.getTime() - PENDING_WINDOW_MS);
      const limit = request.limit ?? DEFAULT_PENDING_LIMIT;
      // One statement for both callers: the dashboard narrows by tenant, the
      // worker tick does not, and a second query shape is a second place for
      // the pending predicate to drift from the index that serves it.
      const rows = (await sql`
        SELECT tenant_id, source::text AS source, fence::text AS fence
          FROM control.connector_link
         WHERE state IS NULL
           AND pending_since IS NOT NULL
           AND pending_since > ${since}
           AND (${request.tenantId ?? null}::text IS NULL OR tenant_id = ${request.tenantId ?? null})
         ORDER BY pending_since
         LIMIT ${limit}
      `) as unknown as { tenant_id: string; source: string; fence: string }[];

      const links: PendingLink[] = [];
      for (const row of rows) {
        // The enum cannot hold anything else, so this is a type narrowing rather
        // than a validation — but the alternative is a cast, and a cast here
        // would be the one place a fourth label could reach the pull lane.
        if (!isConnectorSource(row.source)) continue;
        links.push({ tenantId: row.tenant_id, source: row.source, fence: Number(row.fence) });
      }
      return links;
    },

    async states(tenantId) {
      const rows = (await sql`
        SELECT source::text AS source, state
          FROM control.connector_link
         WHERE tenant_id = ${tenantId} AND state IS NOT NULL
         ORDER BY source
      `) as unknown as { source: string; state: string }[];

      const states: ConnectorState[] = [];
      for (const row of rows) {
        if (!isConnectorSource(row.source)) {
          throw new ConnectorLinkError(tenantId, row.source, 'it names a source this fleet does not serve');
        }
        states.push(await open(tenantId, row.source, row.state));
      }
      return states;
    },

    async adopt(request) {
      const sealed = await sealFor(request.tenantId, request.state);
      const stamp = now();
      // The whole ruling, in one WHERE clause. `state IS NULL` is create-only —
      // it is what stops a second pass resetting a live cursor. `fence = $` is
      // the disconnect — it is what stops a pass that listed the account before
      // the user pressed disconnect committing afterwards.
      const rows = (await sql`
        UPDATE control.connector_link
           SET state = ${sealed}, pending_since = NULL, updated_at = ${stamp}
         WHERE tenant_id = ${request.tenantId}
           AND source = ${request.source}::control.connector_source
           AND state IS NULL
           AND fence = ${request.fence}
        RETURNING tenant_id
      `) as unknown as { tenant_id: string }[];
      return rows.length === 1;
    },

    storeFor(tenantId) {
      /** The fence each source was read under, so `write` can condition on it. */
      const fences = new Map<ConnectorSource, number>();

      return {
        async read(source) {
          const rows = (await sql`
            SELECT state, fence::text AS fence
              FROM control.connector_link
             WHERE tenant_id = ${tenantId} AND source = ${source}::control.connector_source
          `) as unknown as { state: string | null; fence: string }[];

          const row = rows[0];
          if (row === undefined) return null;
          fences.set(source, Number(row.fence));
          // Not connected — a fresh link, an expired intent, or a source the
          // user disconnected. `runPull` reads this as `not_connected` and
          // refuses, which is the right answer for a job that outlived its
          // connection.
          if (row.state === null) return null;
          return await open(tenantId, source, row.state);
        },

        async write(state) {
          const fence = fences.get(state.source);
          if (fence === undefined) {
            // Never reached by the pull runner, which always reads first. A
            // throw rather than an unfenced write: a caller that wrote without
            // reading would be writing over whatever a disconnect had just done.
            throw new ConnectorLinkError(
              tenantId,
              state.source,
              'a write was attempted without a read, so there is no fence to write under',
            );
          }
          const sealed = await sealFor(tenantId, state);
          // `state IS NOT NULL` as well as the fence: the fence alone would let
          // a write land on a link that had been disconnected and re-created at
          // the same fence, and the two together mean "the connection I read is
          // still the connection here".
          await sql`
            UPDATE control.connector_link
               SET state = ${sealed}, updated_at = ${now()}
             WHERE tenant_id = ${tenantId}
               AND source = ${state.source}::control.connector_source
               AND state IS NOT NULL
               AND fence = ${fence}`;
        },
      };
    },
  };
}
