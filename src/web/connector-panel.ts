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
import { freshnessOf, type ConnectorFreshness } from '../control/connector-staleness.ts';

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
 *  * `blocked` — the lane was dead-lettered **below** its attempt budget, which
 *    only happens when a failure was classified terminal: the provider will not
 *    accept our access, and no amount of retrying changes that. The user has to
 *    do something.
 *  * `failing` — the lane walked its whole ladder and gave up. Nothing is
 *    required of the user except, if they want it back, one press.
 *
 * **`blocked` and `failing` used to be one state, and that was the panel's last
 * remaining lie.** A revoked grant and a two-day provider outage both ended as
 * `failing`, and the copy told both of them to disconnect and connect again —
 * an instruction that is right for the first and a wasted re-authorization for
 * the second. The two are told apart from `control.job` alone: a lane that
 * stopped short of `max_attempts` was stopped on purpose (`src/worker/jobs.ts:
 * jobRetryableOf`), and one that reached it ran out. No health record is needed
 * for the distinction, which matters because the health record is the thing that
 * may be missing.
 */
export type ConnectorPanelState =
  | 'absent'
  | 'pending'
  | 'attached'
  | 'checking'
  | 'retrying'
  | 'connected'
  | 'blocked'
  | 'failing';

export interface ConnectorStatus {
  readonly source: string;
  readonly state: ConnectorPanelState;
  /** The last completed check, or the moment the lane died. Null when neither. */
  readonly lastCheckedAt: Date | null;
  /**
   * Whether anything is actually arriving, on the second axis
   * ({@link import('../control/connector-staleness.ts').ConnectorFreshness}).
   *
   * **The state above cannot answer this and it is not a near miss.** Every
   * member of {@link ConnectorPanelState} is derived from row existence and
   * counters: is a job open, did one die, is a link live. During the ten hours
   * this fleet imported nothing, all of those read exactly as they do on a
   * healthy brain — the halted pulls completed their jobs — so the panel state
   * was `connected` the whole time and was right to be. Freshness is the
   * orthogonal reading, off `last_success_at`, and it is what turns "a check
   * finished five minutes ago" into "and it has imported nothing since
   * yesterday".
   */
  readonly freshness: ConnectorFreshness;
  /**
   * When an attempt last actually completed, which is not when one last ran.
   *
   * Null on a source that is not connected, whatever its health row says: the
   * record outlives a disconnect, and a success time from a connection the user
   * removed is a clock nothing on the page can clear.
   */
  readonly lastSuccessAt: Date | null;
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
  /**
   * When the queue will try again, on a `retrying` lane. Null everywhere else.
   *
   * It is `run_at` on the open row and nothing computed: the panel does not know
   * the backoff policy and must not restate it. The copy says *around*, because
   * the worker fleet is woken by a cron every thirty minutes, so every delay the
   * queue writes is rounded up to the next wake.
   */
  readonly nextAttemptAt: Date | null;
  /**
   * Attempts already spent and failed, and the budget they were spent from.
   *
   * Both zero when there is nothing to count. They exist so the copy can say
   * *how long this has been going on* without the page inventing a duration:
   * "the check failed four times" is a fact the queue holds, and "it has been
   * failing for two days" is one it does not.
   */
  readonly attempts: number;
  readonly maxAttempts: number;
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
   * Attempts already spent **and failed** by the open row — not the attempt in
   * flight.
   *
   * The difference between "queued" and "queued again because it failed", and
   * the reason it comes off the open row rather than off a count of dead ones: a
   * lane on attempt three of five has never dead-lettered and never completed,
   * so every other column here reads exactly like a healthy first check.
   *
   * **`control.job.attempts` is not this number for a `running` row, and reading
   * it as if it were made every healthy pull render as a failure.** `claim` sets
   * `state = 'running'` and `attempts = attempts + 1` in one statement, so a
   * first pull is `running` with `attempts = 1` for however long it takes to
   * run — minutes, on a mailbox, against a five-minute cadence. Counted raw,
   * that is `attempts > 0`, which is `retrying`, which renders as *"the last
   * check did not work"* about a check that is working, for most of the time the
   * connector exists. The row's own state is the only thing that tells the
   * in-flight attempt from the spent ones, so the query discounts it there.
   */
  readonly openAttempts: number;
  /** The open row's own budget, so the copy can say "of twelve" without guessing. */
  readonly openMaxAttempts: number;
  /** When the open row becomes claimable. The queue's `run_at`, unmodified. */
  readonly openRunAt: Date | null;
  /**
   * When a pull for this source was **first** enqueued, over every row the queue
   * still holds.
   *
   * The only thing it decides is whether a connector that has never once
   * succeeded is still inside its first window or is a connector that has never
   * worked — and that question has no clock anywhere else, because
   * `connector_health` keeps one row per source and overwrites it. It is a floor
   * rather than the connection's age (a reconnect reuses the link and mints new
   * jobs), and a floor is the conservative direction here: it expires the grace
   * earlier, so the reading errs towards saying something.
   */
  readonly firstQueuedAt: Date | null;
  readonly lastDoneAt: Date | null;
  readonly deadAt: Date | null;
  readonly deadCode: string | null;
  /**
   * What the dead row had spent, and what it was allowed to spend.
   *
   * These two are how `blocked` is told from `failing` without a health record.
   * A lane that died **below** its budget was stopped deliberately by
   * `queue.fail`'s terminal branch; one that died **at** it ran out of ladder.
   * Both zero when nothing here is dead, which reads as `failing` — the
   * conservative direction, and the one an upgraded brain's older dead letters
   * fall into.
   */
  readonly deadAttempts: number;
  readonly deadMaxAttempts: number;
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
  link: ConnectorLinkView,
  health: ConnectorHealthView | undefined,
  now: Date,
): ConnectorStatus {
  // A success after the dead-lettering clears it. See the header.
  const stillDead =
    history !== undefined &&
    history.deadAt !== null &&
    (history.lastDoneAt === null || history.deadAt.getTime() > history.lastDoneAt.getTime());

  const cause = causeOf(health);
  const itemsFailed = health?.itemsFailed ?? 0;

  // **The clock is an argument, and every parameter above is now required.** A
  // resolution rule that read the wall clock itself could not be tested for the
  // one property this whole reading exists to have — that ten hours of failing
  // polls stop reading as healthy — and the defaults that used to sit on `link`
  // and `health` are what would have let a fifth argument be forgotten at a call
  // site rather than refused by the compiler.
  const freshness = freshnessOf({
    source,
    link,
    attempt: health,
    attemptingSince: history?.firstQueuedAt ?? null,
    now,
  });

  // **Only while the link is live.** A dead letter that outlived a disconnect
  // would paint a red line on a source the user has removed, and the only way
  // to clear it would be to connect the source again.
  if (stillDead && link === 'connected') {
    // **Which of the two deaths this was**, from the row's own counters. A lane
    // stopped short of its budget was stopped on purpose — `queue.fail`'s
    // terminal branch is the only thing that can do that — and the remedy is the
    // user's. A lane that reached its budget spent every rung of its ladder, and
    // the remedy is a button.
    //
    // **Both counters must be real before either is believed.** A dead row with
    // `attempts = 0` is not a state the queue can produce — dying requires a
    // failure, and a failure requires a claim, which increments — so a zero
    // there means the row was written by something other than `fail` or
    // `reclaim`, or read from a lane older than these columns. Either way it
    // carries no evidence about which of the two deaths this was, and the
    // no-evidence answer is `failing`: it is the reading that offers the user a
    // control rather than an instruction, and the control works on any dead lane.
    const stoppedEarly =
      history.deadAttempts > 0 &&
      history.deadMaxAttempts > 0 &&
      history.deadAttempts < history.deadMaxAttempts;
    return {
      source,
      freshness: freshness.state,
      lastSuccessAt: freshness.lastSuccessAt,
      state: stoppedEarly ? 'blocked' : 'failing',
      lastCheckedAt: history.deadAt,
      failureCode: history.deadCode,
      cause,
      itemsFailed,
      nextAttemptAt: null,
      attempts: history.deadAttempts,
      maxAttempts: history.deadMaxAttempts,
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
      freshness: freshness.state,
      lastSuccessAt: freshness.lastSuccessAt,
      state: link === 'pending' ? 'pending' : 'absent',
      lastCheckedAt: null,
      failureCode: null,
      cause: null,
      itemsFailed: 0,
      nextAttemptAt: null,
      attempts: 0,
      maxAttempts: 0,
    };
  }

  if (history !== undefined && history.open > 0) {
    // Queued because the last attempt failed, or queued because it is time?
    // Both are `due`, and only `attempts` tells them apart.
    const retrying = history.openAttempts > 0;
    return {
      source,
      freshness: freshness.state,
      lastSuccessAt: freshness.lastSuccessAt,
      state: retrying ? 'retrying' : 'checking',
      lastCheckedAt: history.lastDoneAt,
      failureCode: null,
      // Only on the retrying reading. A first check that has not run yet has
      // nothing to explain, and a stale code from a connector that has since
      // been fine would be exactly the red line the header forbids.
      cause: retrying ? cause : null,
      itemsFailed: retrying ? itemsFailed : 0,
      // Only on the retrying reading, for the same reason the cause is: a first
      // check that has not run yet is not waiting out a backoff, and telling a
      // user it will "try again around 09:30" about a check that has never
      // failed is the `retrying`-for-`checking` confusion in a second place.
      nextAttemptAt: retrying ? history.openRunAt : null,
      attempts: history.openAttempts,
      maxAttempts: history.openMaxAttempts,
    };
  }
  if (history !== undefined && history.lastDoneAt !== null) {
    return {
      source,
      freshness: freshness.state,
      lastSuccessAt: freshness.lastSuccessAt,
      state: 'connected',
      lastCheckedAt: history.lastDoneAt,
      failureCode: null,
      // A completed lane still reports what the last attempt lost. `stopped` and
      // `refused` runs complete the job — the cursor is held and the next tick
      // resumes — so this is the one place a user learns that a poll came back
      // short rather than empty.
      cause,
      itemsFailed,
      nextAttemptAt: null,
      attempts: 0,
      maxAttempts: 0,
    };
  }
  // Attached, and the first check has not run. Not a gap to be papered over: the
  // cadence pass runs on the worker fleet's wake, so this is what a user sees
  // for as long as half an hour after they authorize, and the copy says so.
  return {
    source,
    freshness: freshness.state,
    lastSuccessAt: freshness.lastSuccessAt,
    state: 'attached',
    lastCheckedAt: null,
    failureCode: null,
    cause: null,
    itemsFailed: 0,
    nextAttemptAt: null,
    attempts: 0,
    maxAttempts: 0,
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
    /**
     * The instant the page is rendered at. Required rather than defaulted,
     * because staleness is the one reading here that is a claim about elapsed
     * time — and a default would have been the quiet way for a caller to get a
     * clock nobody chose.
     */
    readonly now: Date;
  },
): Promise<readonly ConnectorStatus[]> {
  const rows = await controlSql<
    {
      target: string;
      open: number;
      open_attempts: number;
      open_max_attempts: number;
      open_run_at: Date | null;
      first_queued_at: Date | null;
      last_done_at: Date | null;
      dead_at: Date | null;
      dead_code: string | null;
      dead_attempts: number;
      dead_max_attempts: number;
    }[]
  >`
    SELECT target::text                                                    AS target,
           count(*) FILTER (WHERE state IN ('due', 'running'))::int        AS open,
           -- The attempt in flight is discounted; the ones behind it are not.
           -- See PullHistory.openAttempts: claim increments attempts as it sets
           -- running, so a healthy first pull carries a 1 that means "this one
           -- is happening", not "one has failed".
           coalesce(max(
             CASE WHEN state = 'running' THEN greatest(attempts - 1, 0) ELSE attempts END
           ) FILTER (WHERE state IN ('due', 'running')), 0)::int           AS open_attempts,
           coalesce(max(max_attempts)
             FILTER (WHERE state IN ('due', 'running')), 0)::int           AS open_max_attempts,
           -- When the queue will claim it next. Only from a due row: a running
           -- one is being worked on now and its run_at is when THIS attempt
           -- started, which rendered as a next attempt would be a time in the
           -- past.
           min(run_at) FILTER (WHERE state = 'due')                        AS open_run_at,
           -- Over every row, filtered by nothing: the question it answers is
           -- "how long has this source been being polled at all", and a
           -- connector that has never succeeded has no done row to date from.
           -- created_at rather than run_at because backoff moves the second one
           -- forward, so a lane that has been retrying for a day would date
           -- itself from its next attempt.
           min(created_at)                                                 AS first_queued_at,
           max(finished_at) FILTER (WHERE state = 'done')                  AS last_done_at,
           max(dead_lettered_at) FILTER (WHERE state = 'dead')             AS dead_at,
           (array_agg(failure_code::text ORDER BY dead_lettered_at DESC)
              FILTER (WHERE state = 'dead'))[1]                            AS dead_code,
           -- The dead row's own counters, ordered the same way dead_code is, so
           -- all three describe the SAME row. They are what tells a lane that
           -- was stopped on purpose from one that ran out of ladder.
           coalesce((array_agg(attempts ORDER BY dead_lettered_at DESC)
              FILTER (WHERE state = 'dead'))[1], 0)::int                   AS dead_attempts,
           coalesce((array_agg(max_attempts ORDER BY dead_lettered_at DESC)
              FILTER (WHERE state = 'dead'))[1], 0)::int                   AS dead_max_attempts
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
      openMaxAttempts: row.open_max_attempts,
      openRunAt: row.open_run_at,
      firstQueuedAt: row.first_queued_at,
      lastDoneAt: row.last_done_at,
      deadAt: row.dead_at,
      deadCode: row.dead_code,
      deadAttempts: row.dead_attempts,
      deadMaxAttempts: row.dead_max_attempts,
    });
  }
  return request.sources.map((source) =>
    statusFor(
      source,
      byTarget.get(source),
      request.links?.get(source) ?? 'absent',
      health.get(source),
      request.now,
    ),
  );
}
