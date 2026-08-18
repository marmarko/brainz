/**
 * What the dashboard may honestly say about each connector, and where it comes
 * from.
 *
 * **This module used to open with an honest limit that has since been closed,
 * and the shape of the panel still follows from it.** It read: *nothing in this
 * fleet is told when a user finishes a consent screen; the connect link is
 * redeemed at the vendor; `connectSource` has no production caller; no
 * `ConnectorState` is ever written* — so *"gmail is attached"* was not a fact
 * this app held, and the panel reported the only evidence there was, the
 * `ingest_pull` queue.
 *
 * A fleet *is* told now: `src/ingest/pipedream/reconcile.ts` asks the vendor
 * which accounts exist under this tenant's per-source external user and writes
 * the connection, and `control.connector_link` is where that lands. So the panel
 * has two sources rather than one, and they answer different questions:
 *
 *   * **The link** answers *is this source attached* — from two columns and no
 *     sealing key, so this module still cannot read a connector's cursor.
 *   * **The queue** answers *is it being polled, and did the last poll work* —
 *     which is the question the link cannot answer and the one that matters once
 *     a connection is a week old.
 *
 * Both are needed, and the gap between them is a real user-visible state rather
 * than an implementation detail: a connection adopted a minute ago is attached
 * and has never been polled, because the poll happens on the worker fleet's next
 * wake. A panel with only the queue would tell that user *not connected* and
 * they would press connect again.
 *
 * **Why not `sourceStaleness`, and what replaced the answer this paragraph used
 * to give.** `src/ingest/log.ts:sourceStaleness` is the richer view — items
 * written, items lost, per-item failure codes — and it runs against the
 * **tenant's** database. R11 forbids this module a tenant handle
 * (`test/control/accessor-boundary.test.ts` is that rule's guard), so reaching
 * it would mean a new port shaped like {@link import('./app.ts').SeverancePort}.
 * This module used to say that port was worth adding the day a user needed to
 * see how many messages a poll lost. It is not, and the reason is a case that
 * port cannot serve: **a tenant database nobody can reach.** A read-through port
 * answers that question with an error, and it is one of the four causes a user
 * or an operator has to be able to tell apart. So the attempt's own outcome is
 * banked in the control plane by the process that already holds the tenant
 * handle — `control.connector_health`, written by the worker mid-pull
 * (`src/control/connector-health.sql` carries the whole argument) — and this
 * module reads a code, a count and an instant from the same database it was
 * already reading. The per-ITEM record stays in the tenant's `ingest_log`, out
 * of reach, which is where a provider's id for somebody's message belongs.
 *
 * **The most recent terminal run wins.** One dead-lettered pull followed by a
 * successful one is a source that recovered, and a panel that reached past the
 * success to find the failure would show a red line nobody can clear. A
 * staleness display nobody can clear is a staleness display nobody reads.
 *
 * **`discarded` rows are not evidence of anything.** They are what
 * `handleDisconnect` writes when it stops the polling. Reading them as failures
 * would make pressing *disconnect* render as *something is broken* on the very
 * next page load.
 */

import type { SQL } from 'bun';

import { causeOf, readConnectorHealth, type ConnectorHealthView } from '../control/connector-health.ts';
import type { ConnectorLinkView } from '../control/connector-pg.ts';

/**
 * What the panel knows, in seven values.
 *
 *  * `absent` — no link, no pull. Not connected, and now that is a fact rather
 *    than an inference: a connect writes a row before the user leaves.
 *  * `pending` — the user pressed connect and no account has appeared yet.
 *    Either they are still at the consent screen or they abandoned it.
 *  * `attached` — a connection exists and has never been polled. The state a
 *    reconciliation creates, and the one a user sees the moment they come back.
 *  * `checking` — a pull is queued or leased right now, and no attempt of it has
 *    failed.
 *  * `retrying` — a pull is queued or leased right now, and it is queued
 *    *because the last attempt failed*. **This was the panel's blind spot and it
 *    was the ordinary case:** a lane on its first, second or third attempt is
 *    `state = 'due'` with `attempts > 0`, which the queue-only reading below
 *    reported as `checking` — "a check is queued or running now" — for as long
 *    as the ladder ran. A user whose grant was revoked was told their connector
 *    was working, right up until it dead-lettered.
 *  * `connected` — a pull has completed.
 *  * `failing` — the lane was dead-lettered and has not succeeded since.
 */
export type ConnectorPanelState =
  | 'absent'
  | 'pending'
  | 'attached'
  | 'checking'
  | 'retrying'
  | 'connected'
  | 'failing';

export interface ConnectorStatus {
  readonly source: string;
  readonly state: ConnectorPanelState;
  /** The last completed check, or the moment the lane died. Null when neither. */
  readonly lastCheckedAt: Date | null;
  /**
   * The **queue's** code for the lane's death: `handler_error`,
   * `tenant_unavailable`, `lease_stolen`. Present on `failing` only.
   *
   * It is not the cause and never was — `handler_error` is the runner's bucket
   * for "a handler threw" and covers a revoked grant, an exhausted budget and a
   * bug in equal measure. {@link ConnectorStatus.cause} is the cause.
   */
  readonly failureCode: string | null;
  /**
   * Why the last attempt did not work, in the ingest log's own vocabulary where
   * a run got far enough to have one and the queue's where it did not.
   *
   * Null when the last attempt was fine, or when nothing has recorded one — a
   * connector last polled by a fleet that predates `control.connector_health`
   * has no record, and the copy must degrade to what it said before rather than
   * inventing a reason.
   */
  readonly cause: string | null;
  /** Items the last attempt could not import. Zero when nothing was lost. */
  readonly itemsFailed: number;
}

/**
 * One source's pull history, aggregated. Exported so the resolution rule below
 * can be tested without a database standing in the way of it.
 */
export interface PullHistory {
  readonly target: string;
  /** Rows in `due` or `running`. */
  readonly open: number;
  /**
   * Attempts already spent by the open row.
   *
   * The difference between "queued" and "queued again because it failed", and
   * the reason it comes off the open row rather than off a count of dead ones: a
   * lane on attempt three of five has never dead-lettered and never completed,
   * so every other column here reads exactly like a healthy first check.
   */
  readonly openAttempts: number;
  readonly lastDoneAt: Date | null;
  readonly deadAt: Date | null;
  readonly deadCode: string | null;
}

/**
 * The resolution rule, alone, so a mutation to it fails a test rather than a page.
 *
 * **The queue is read first and the link second, everywhere the two could
 * disagree.** A dead-lettered lane on a live link is still a failing connector,
 * and a completed pull on a link that was disconnected a second ago is still a
 * disconnected connector — so the failure states come off the queue and the
 * "nothing has happened yet" states come off the link, which is the only
 * arrangement where neither source can hide the other.
 */
export function statusFor(
  source: string,
  history: PullHistory | undefined,
  link: ConnectorLinkView = 'absent',
  health: ConnectorHealthView | undefined = undefined,
): ConnectorStatus {
  // A success after the dead-lettering clears it. See the header.
  const stillDead =
    history !== undefined &&
    history.deadAt !== null &&
    (history.lastDoneAt === null || history.deadAt.getTime() > history.lastDoneAt.getTime());

  const cause = causeOf(health);
  const itemsFailed = health?.itemsFailed ?? 0;

  // **Only while the link is live.** A dead letter that outlived a disconnect
  // would paint a red line on a source the user has removed, and the only way
  // to clear it would be to connect the source again.
  if (stillDead && link === 'connected') {
    return {
      source,
      state: 'failing',
      lastCheckedAt: history.deadAt,
      failureCode: history.deadCode,
      cause,
      itemsFailed,
    };
  }

  if (link !== 'connected') {
    // No connection. Which of the two reasons it is comes from the link alone —
    // the queue cannot tell "never asked" from "asked and nothing came back".
    // No cause either: whatever the last attempt said, it was about a connection
    // this user no longer has, and a code on a disconnected source is a red line
    // with no control to clear it.
    return {
      source,
      state: link === 'pending' ? 'pending' : 'absent',
      lastCheckedAt: null,
      failureCode: null,
      cause: null,
      itemsFailed: 0,
    };
  }

  if (history !== undefined && history.open > 0) {
    // Queued because the last attempt failed, or queued because it is time?
    // Both are `due`, and only `attempts` tells them apart.
    const retrying = history.openAttempts > 0;
    return {
      source,
      state: retrying ? 'retrying' : 'checking',
      lastCheckedAt: history.lastDoneAt,
      failureCode: null,
      // Only on the retrying reading. A first check that has not run yet has
      // nothing to explain, and a stale code from a connector that has since
      // been fine would be exactly the red line the header forbids.
      cause: retrying ? cause : null,
      itemsFailed: retrying ? itemsFailed : 0,
    };
  }
  if (history !== undefined && history.lastDoneAt !== null) {
    return {
      source,
      state: 'connected',
      lastCheckedAt: history.lastDoneAt,
      failureCode: null,
      // A completed lane still reports what the last attempt lost. `stopped` and
      // `refused` runs complete the job — the cursor is held and the next tick
      // resumes — so this is the one place a user learns that a poll came back
      // short rather than empty.
      cause,
      itemsFailed,
    };
  }
  // Attached, and the first check has not run. Not a gap to be papered over: the
  // cadence pass runs on the worker fleet's wake, so this is what a user sees
  // for as long as half an hour after they authorize, and the copy says so.
  return {
    source,
    state: 'attached',
    lastCheckedAt: null,
    failureCode: null,
    cause: null,
    itemsFailed: 0,
  };
}

/**
 * Every offered source's status, in the order the caller offers them.
 *
 * One statement for all three rather than one per source: the panel is rendered
 * on every dashboard load, and three round trips to the control plane for a
 * three-row answer is the shape that becomes nine when a fourth connector
 * lands. The link view arrives from the caller for the same reason — it is one
 * more query on the same handle, made once.
 */
export async function connectorStatuses(
  controlSql: SQL,
  request: {
    readonly tenantId: string;
    readonly sources: readonly string[];
    readonly links?: ReadonlyMap<string, ConnectorLinkView>;
  },
): Promise<readonly ConnectorStatus[]> {
  const rows = await controlSql<
    {
      target: string;
      open: number;
      open_attempts: number;
      last_done_at: Date | null;
      dead_at: Date | null;
      dead_code: string | null;
    }[]
  >`
    SELECT target::text                                                    AS target,
           count(*) FILTER (WHERE state IN ('due', 'running'))::int        AS open,
           coalesce(max(attempts) FILTER (
             WHERE state IN ('due', 'running')), 0)::int                   AS open_attempts,
           max(finished_at) FILTER (WHERE state = 'done')                  AS last_done_at,
           max(dead_lettered_at) FILTER (WHERE state = 'dead')             AS dead_at,
           (array_agg(failure_code::text ORDER BY dead_lettered_at DESC)
              FILTER (WHERE state = 'dead'))[1]                            AS dead_code
      FROM control.job
     WHERE tenant_id = ${request.tenantId}
       AND kind = 'ingest_pull'
     GROUP BY target`;

  // A second statement on the same handle rather than a join: the two tables
  // answer about different things — one lane can have no job rows and a health
  // record, or job rows and no health record — and an outer join whose ON clause
  // has to keep both of those true is a query nobody can read.
  const health = await readConnectorHealth(controlSql, { tenantId: request.tenantId });

  const byTarget = new Map<string, PullHistory>();
  for (const row of rows) {
    byTarget.set(row.target, {
      target: row.target,
      open: row.open,
      openAttempts: row.open_attempts,
      lastDoneAt: row.last_done_at,
      deadAt: row.dead_at,
      deadCode: row.dead_code,
    });
  }
  return request.sources.map((source) =>
    statusFor(
      source,
      byTarget.get(source),
      request.links?.get(source) ?? 'absent',
      health.get(source),
    ),
  );
}
