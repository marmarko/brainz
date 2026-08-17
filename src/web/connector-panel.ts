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
 * **Why not `sourceStaleness`.** `src/ingest/log.ts:sourceStaleness` is the
 * richer view — items written, items lost, per-item failure codes — and it runs
 * against the **tenant's** database. R11 forbids this module a tenant handle
 * (`test/control/accessor-boundary.test.ts` is that rule's guard), so reaching
 * it would mean a new port shaped like {@link import('./app.ts').SeverancePort}.
 * That port is worth adding the day a user needs to see how many messages a poll
 * lost; the states below are what they need to see before that.
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

import type { ConnectorLinkView } from '../control/connector-pg.ts';

/**
 * What the panel knows, in six values.
 *
 *  * `absent` — no link, no pull. Not connected, and now that is a fact rather
 *    than an inference: a connect writes a row before the user leaves.
 *  * `pending` — the user pressed connect and no account has appeared yet.
 *    Either they are still at the consent screen or they abandoned it.
 *  * `attached` — a connection exists and has never been polled. The state a
 *    reconciliation creates, and the one a user sees the moment they come back.
 *  * `checking` — a pull is queued or leased right now.
 *  * `connected` — a pull has completed.
 *  * `failing` — the lane was dead-lettered and has not succeeded since.
 */
export type ConnectorPanelState =
  | 'absent'
  | 'pending'
  | 'attached'
  | 'checking'
  | 'connected'
  | 'failing';

export interface ConnectorStatus {
  readonly source: string;
  readonly state: ConnectorPanelState;
  /** The last completed check, or the moment the lane died. Null when neither. */
  readonly lastCheckedAt: Date | null;
  /** The dead-letter code, and only on `failing`. */
  readonly failureCode: string | null;
}

/**
 * One source's pull history, aggregated. Exported so the resolution rule below
 * can be tested without a database standing in the way of it.
 */
export interface PullHistory {
  readonly target: string;
  /** Rows in `due` or `running`. */
  readonly open: number;
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
): ConnectorStatus {
  // A success after the dead-lettering clears it. See the header.
  const stillDead =
    history !== undefined &&
    history.deadAt !== null &&
    (history.lastDoneAt === null || history.deadAt.getTime() > history.lastDoneAt.getTime());

  // **Only while the link is live.** A dead letter that outlived a disconnect
  // would paint a red line on a source the user has removed, and the only way
  // to clear it would be to connect the source again.
  if (stillDead && link === 'connected') {
    return {
      source,
      state: 'failing',
      lastCheckedAt: history.deadAt,
      failureCode: history.deadCode,
    };
  }

  if (link !== 'connected') {
    // No connection. Which of the two reasons it is comes from the link alone —
    // the queue cannot tell "never asked" from "asked and nothing came back".
    return {
      source,
      state: link === 'pending' ? 'pending' : 'absent',
      lastCheckedAt: null,
      failureCode: null,
    };
  }

  if (history !== undefined && history.open > 0) {
    return { source, state: 'checking', lastCheckedAt: history.lastDoneAt, failureCode: null };
  }
  if (history !== undefined && history.lastDoneAt !== null) {
    return { source, state: 'connected', lastCheckedAt: history.lastDoneAt, failureCode: null };
  }
  // Attached, and the first check has not run. Not a gap to be papered over: the
  // cadence pass runs on the worker fleet's wake, so this is what a user sees
  // for as long as half an hour after they authorize, and the copy says so.
  return { source, state: 'attached', lastCheckedAt: null, failureCode: null };
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
      last_done_at: Date | null;
      dead_at: Date | null;
      dead_code: string | null;
    }[]
  >`
    SELECT target::text                                                    AS target,
           count(*) FILTER (WHERE state IN ('due', 'running'))::int        AS open,
           max(finished_at) FILTER (WHERE state = 'done')                  AS last_done_at,
           max(dead_lettered_at) FILTER (WHERE state = 'dead')             AS dead_at,
           (array_agg(failure_code::text ORDER BY dead_lettered_at DESC)
              FILTER (WHERE state = 'dead'))[1]                            AS dead_code
      FROM control.job
     WHERE tenant_id = ${request.tenantId}
       AND kind = 'ingest_pull'
     GROUP BY target`;

  const byTarget = new Map<string, PullHistory>();
  for (const row of rows) {
    byTarget.set(row.target, {
      target: row.target,
      open: row.open,
      lastDoneAt: row.last_done_at,
      deadAt: row.dead_at,
      deadCode: row.dead_code,
    });
  }
  return request.sources.map((source) =>
    statusFor(source, byTarget.get(source), request.links?.get(source) ?? 'absent'),
  );
}
