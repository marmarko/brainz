/**
 * What the dashboard may honestly say about each connector, and where it comes
 * from.
 *
 * **The honest limit first, because the whole design follows from it.** Nothing
 * in this fleet is told when a user finishes a consent screen. The connect link
 * is redeemed at the vendor; `connectSource` has no production caller; no
 * `ConnectorState` is ever written. So *"gmail is attached"* is not a fact this
 * app holds, and a panel that claimed it would be inventing one — the same
 * failure `connectionStatus` refuses when it declines to name which client
 * connected.
 *
 * **What it does hold is the queue.** `control.job` is the web app's own
 * database, and an `ingest_pull` row for a source exists only because the
 * cadence pass read a connected state for it. That is the single piece of
 * evidence of attachment this fleet has, so it is what the panel reports —
 * and when there is none, the panel says *not connected as far as this brain
 * can tell* rather than *not connected*.
 *
 * **Why not `sourceStaleness`.** `src/ingest/log.ts:sourceStaleness` is the
 * richer view — items written, items lost, per-item failure codes — and it runs
 * against the **tenant's** database. R11 forbids this module a tenant handle
 * (`test/control/accessor-boundary.test.ts` is that rule's guard), so reaching
 * it would mean a new port shaped like {@link import('./app.ts').SeverancePort}.
 * That port would be worth adding the day the item counts differ from the queue
 * — today both are empty for the same reason (no `ConnectorRuntime` is
 * composed), so it would add a seam and no information. Named here so the
 * omission is a decision rather than something to rediscover.
 *
 * **The most recent terminal run wins.** `sourceStaleness` states this rule for
 * its own view and the reason carries over exactly: one dead-lettered pull
 * followed by a successful one is a source that recovered, and a panel that
 * reached past the success to find the failure would show a red line nobody can
 * clear. A staleness display nobody can clear is a staleness display nobody
 * reads.
 *
 * **`discarded` rows are not evidence of anything.** They are what
 * `handleDisconnect` writes when it stops the polling. Reading them as failures
 * would make pressing *disconnect* render as *something is broken* on the very
 * next page load.
 */

import type { SQL } from 'bun';

/**
 * What the panel knows, in four values.
 *
 *  * `checking` — a pull is queued or leased right now.
 *  * `connected` — a pull has completed; the source was attached at least then.
 *  * `failing` — the lane was dead-lettered and has not succeeded since.
 *  * `unknown` — no pull has ever run. Attached-but-never-polled and
 *    never-attached are the same row set, and the copy says so rather than
 *    picking one.
 */
export type ConnectorPanelState = 'checking' | 'connected' | 'failing' | 'unknown';

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

/** The resolution rule, alone, so a mutation to it fails a test rather than a page. */
export function statusFor(source: string, history: PullHistory | undefined): ConnectorStatus {
  if (history === undefined) {
    return { source, state: 'unknown', lastCheckedAt: null, failureCode: null };
  }
  // A success after the dead-lettering clears it. See the header.
  const stillDead =
    history.deadAt !== null &&
    (history.lastDoneAt === null || history.deadAt.getTime() > history.lastDoneAt.getTime());
  if (stillDead) {
    return {
      source,
      state: 'failing',
      lastCheckedAt: history.deadAt,
      failureCode: history.deadCode,
    };
  }
  if (history.open > 0) {
    return { source, state: 'checking', lastCheckedAt: history.lastDoneAt, failureCode: null };
  }
  if (history.lastDoneAt !== null) {
    return { source, state: 'connected', lastCheckedAt: history.lastDoneAt, failureCode: null };
  }
  return { source, state: 'unknown', lastCheckedAt: null, failureCode: null };
}

/**
 * Every offered source's status, in the order the caller offers them.
 *
 * One statement for all three rather than one per source: the panel is rendered
 * on every dashboard load, and three round trips to the control plane for a
 * three-row answer is the shape that becomes nine when a fourth connector
 * lands.
 */
export async function connectorStatuses(
  controlSql: SQL,
  request: { readonly tenantId: string; readonly sources: readonly string[] },
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
  return request.sources.map((source) => statusFor(source, byTarget.get(source)));
}
