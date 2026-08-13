/**
 * The ingest log (U8, R16): what happened per source, and the only place
 * staleness is derived from.
 *
 * **This module owns a vocabulary, not a table.** `ingest_log` is U3's
 * (`src/schema/migrations/v2-knowledge-core.sql`), it is rung two, and it holds
 * one shape: an origin, a source type, an optional provider item id, an
 * outcome, a failure code and three counters. Everything below is that table
 * used two ways, and the discrimination is stated here rather than left for a
 * reader to infer from a query:
 *
 *   * **A run row** (`external_ref IS NULL`) is one import. It is what
 *     `page.ingest_id` references, so it is also what U4's write path
 *     increments — `countIngestItem` advances `items_seen` on the row whose id
 *     the caller passed in, and the caller passes this one. It opens `running`
 *     and closes terminal.
 *   * **An item row** (`external_ref` = the provider's own id) is one item, and
 *     it is inserted **already terminal**. Never `running`: U6's
 *     `search_degraded` counts running rows to decide whether an import is in
 *     flight, and a crash between "insert running" and "update terminal" would
 *     make a brain permanently claim to be importing.
 *
 * **The hash the plan asks an item row to carry lives on the page, not here.**
 * There is no digest column, and adding one is a rung — three other units'
 * files. It is not lost: an accepted item's digest is `page.content_sha256`
 * reachable by the same `external_ref` this row records, and `page` is where
 * every other reader already looks for it. An item that *failed* has no
 * accepted content, so it has no digest, and inventing one would be worse than
 * the gap.
 *
 * **What a disposition survives as.** The table's `outcome` has four values and
 * this module's dispositions have five, so the mapping is lossy in exactly one
 * place and it is written down: `tombstoned` and `unchanged` both land as `ok`
 * with `items_written = 0`, and the two are told apart by the page's own
 * `deleted_at`. Nothing here pretends otherwise.
 *
 * **Staleness is derived, never stored.** "Nothing new from this source in 23
 * days" is `now - max(finished_at where items_written > 0)`, and the reason the
 * run row has to exist even for an import that found nothing is that *checked
 * and found nothing* and *never checked* are different sentences. An item-rows-
 * only log cannot say the first one.
 */

import type { SQL } from 'bun';

import type { SourceType } from '../core/write/write-path.ts';

/** `ingest_log_outcome_is_known`, restated so a bad value is refused here. */
export const RUN_OUTCOMES = ['running', 'ok', 'failed', 'cancelled'] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** `ingest_log_failure_is_a_code`, restated for the same reason. */
export const INGEST_FAILURE_CODES = [
  'auth_expired',
  'rate_limited',
  'provider_error',
  'parse_failed',
  'budget_exhausted',
  'cancelled',
] as const;
export type IngestFailureCode = (typeof INGEST_FAILURE_CODES)[number];

/**
 * What happened to one item. Five values over the table's four outcomes; see
 * the header for the one place the mapping is lossy and how it is recovered.
 */
export const ITEM_DISPOSITIONS = [
  'written',
  'unchanged',
  'quarantined',
  'tombstoned',
  'failed',
] as const;
export type ItemDisposition = (typeof ITEM_DISPOSITIONS)[number];

/**
 * How long a `running` run row may sit before {@link openRun} treats it as the
 * wreckage of a crashed import.
 *
 * The table carries no heartbeat — `started_at` is the only clock on the row —
 * so this is a wall-clock ceiling on an import, not a liveness check, and it is
 * deliberately generous. Sweeping a *live* run's row would make U6 stop
 * reporting an import that is still running, which is the failure this whole
 * mechanism exists to avoid in the other direction.
 */
export const ABANDONED_RUN_AFTER_MS = 6 * 60 * 60 * 1000;

export interface OpenRunRequest {
  readonly originContext: string;
  readonly sourceType: SourceType;
  /** Defaults to {@link ABANDONED_RUN_AFTER_MS}. */
  readonly abandonedAfterMs?: number;
}

export interface OpenRunResult {
  /** `ingest_log.ingest_id`, as text: it is a bigint and this process must not
   * round one through a double. */
  readonly ingestId: string;
  /** Wreckage this call closed on its way in. Zero on a healthy brain. */
  readonly sweptAbandoned: number;
}

export interface FinishRunRequest {
  readonly outcome: Exclude<RunOutcome, 'running'>;
  readonly failureCode?: IngestFailureCode | null;
}

export interface RecordItemRequest {
  readonly originContext: string;
  readonly sourceType: SourceType;
  /** The provider's own id. Never a storage key, never a path. */
  readonly externalRef: string;
  readonly disposition: ItemDisposition;
  readonly failureCode?: IngestFailureCode | null;
}

export interface SourceStaleness {
  readonly originContext: string;
  readonly sourceType: SourceType;
  /** When this source was last checked at all, run or item. */
  readonly lastCheckedAt: Date | null;
  /** When this source last produced a written item. The staleness clock. */
  readonly lastWriteAt: Date | null;
  /** `now - lastWriteAt`, in whole seconds. Null when nothing was ever written. */
  readonly staleSeconds: number | null;
  readonly itemsWritten: number;
  readonly itemsSeen: number;
  /**
   * Why the source is unhappy **now** — the failure code of its most recent
   * terminal run, and `null` when that run succeeded.
   *
   * Not "the most recent failure ever". One cursor expiry writes one failed run
   * row, and a view that reaches past every later success to find it answers
   * "provider_error" for the rest of the brain's life. A staleness display
   * nobody can clear is a staleness display nobody reads.
   */
  readonly lastFailureCode: IngestFailureCode | null;
  /**
   * Items this source could not import, counted from the item rows.
   *
   * The run rows cannot say this: a pull that lost forty messages to a rate
   * limit and imported the rest still closes `ok`, and the whole loss lives in
   * rows a run-row-only view filters out by construction. This is the number
   * that separates "nothing happened this week" from "your mail stopped
   * syncing".
   */
  readonly itemsFailed: number;
  /** The most recent item-level failure code. Null when no item ever failed. */
  readonly lastItemFailureCode: IngestFailureCode | null;
  readonly runInProgress: boolean;
}

/**
 * How a disposition lands in the table's own vocabulary.
 *
 * One place, because the mapping is the module's contract with every reader of
 * `ingest_log` and a second copy is how "written" and "seen" drift apart. See
 * the header for the one lossy pair and how it is told apart.
 */
export function itemRowFor(disposition: ItemDisposition): {
  readonly outcome: Exclude<RunOutcome, 'running'>;
  readonly written: number;
  readonly quarantined: number;
} {
  switch (disposition) {
    case 'written':
      return { outcome: 'ok', written: 1, quarantined: 0 };
    case 'quarantined':
      return { outcome: 'ok', written: 0, quarantined: 1 };
    case 'failed':
      return { outcome: 'failed', written: 0, quarantined: 0 };
    // `unchanged` and `tombstoned`: handled, and both cost nothing.
    default:
      return { outcome: 'ok', written: 0, quarantined: 0 };
  }
}

/**
 * Close `running` run rows older than the threshold.
 *
 * `cancelled` rather than `failed`, and the difference is not cosmetic: nothing
 * observed this run fail. What is known is that it stopped reporting, which is
 * what `cancelled` with `failure_code = 'cancelled'` says.
 *
 * Scoped to one source. A sweep that closed every stale run in the brain would
 * be a folder import cleaning up after a chat import it knows nothing about.
 */
export async function sweepAbandonedRuns(
  sql: SQL,
  request: {
    readonly originContext: string;
    readonly sourceType: SourceType;
    readonly olderThanMs: number;
  },
): Promise<number> {
  const seconds = Math.max(0, Math.trunc(request.olderThanMs)) / 1_000;
  const rows = (await sql`
    UPDATE ingest_log
       SET outcome = 'cancelled', failure_code = 'cancelled', finished_at = now()
     WHERE outcome = 'running'
       AND external_ref IS NULL
       AND origin_context = ${request.originContext}
       AND source_type = ${request.sourceType}
       AND started_at <= now() - make_interval(secs => ${seconds})
    RETURNING ingest_id
  `) as ReadonlyArray<unknown>;
  return rows.length;
}

/**
 * Open a run row, after closing any wreckage this source left behind.
 *
 * The sweep runs *before* the insert, deliberately: the row this call is about
 * to create cannot be old enough to sweep, so "a sweep can never close the run
 * that started it" is a property of the sequence rather than of a predicate
 * someone has to keep correct.
 *
 * The sweep lives here rather than on a schedule because nothing in this unit
 * runs on one. A crashed import would otherwise leave U6 reporting
 * `import_in_progress` forever, and the next import is the event that proves
 * the last one is not coming back.
 */
export async function openRun(sql: SQL, request: OpenRunRequest): Promise<OpenRunResult> {
  const sweptAbandoned = await sweepAbandonedRuns(sql, {
    originContext: request.originContext,
    sourceType: request.sourceType,
    olderThanMs: request.abandonedAfterMs ?? ABANDONED_RUN_AFTER_MS,
  });

  const rows = (await sql`
    INSERT INTO ingest_log (origin_context, source_type, outcome)
    VALUES (${request.originContext}, ${request.sourceType}, 'running')
    RETURNING ingest_id::text AS ingest_id
  `) as Array<{ ingest_id: string }>;

  const ingestId = rows[0]?.ingest_id;
  if (ingestId === undefined) throw new Error('ingest_log insert returned no id');
  return { ingestId, sweptAbandoned };
}

/**
 * Close a run row.
 *
 * Guarded on `outcome = 'running'`, so a run the sweep already cancelled is not
 * quietly reopened by a straggling process reporting success on work nobody
 * banked. The same fencing instinct as U10's lease, at a much smaller scale.
 */
export async function finishRun(
  sql: SQL,
  ingestId: string,
  request: FinishRunRequest,
): Promise<void> {
  await sql`
    UPDATE ingest_log
       SET outcome = ${request.outcome},
           failure_code = ${request.failureCode ?? null},
           finished_at = now()
     WHERE ingest_id = ${ingestId}::bigint
       AND outcome = 'running'
  `;
}

/**
 * Count an item the run *saw* but never handed to the write path — a malformed
 * conversation, a file that vanished mid-scan.
 *
 * U4's own counter advances for everything it accepts; nothing advances it for
 * what never got there, so a run whose denominator excludes its failures reports
 * a clean import of a broken export.
 */
export async function countRunItem(
  sql: SQL,
  ingestId: string,
  item: { readonly written: number; readonly quarantined: number },
): Promise<void> {
  await sql`
    UPDATE ingest_log
       SET items_seen = items_seen + 1,
           items_written = items_written + ${item.written},
           items_quarantined = items_quarantined + ${item.quarantined}
     WHERE ingest_id = ${ingestId}::bigint
  `;
}

/** One item, inserted already terminal. Never `running` — see the header. */
export async function recordItem(sql: SQL, request: RecordItemRequest): Promise<void> {
  const row = itemRowFor(request.disposition);
  await sql`
    INSERT INTO ingest_log (
      origin_context, source_type, external_ref, outcome, failure_code,
      items_seen, items_written, items_quarantined, finished_at
    ) VALUES (
      ${request.originContext}, ${request.sourceType}, ${request.externalRef},
      ${row.outcome},
      ${row.outcome === 'failed' ? (request.failureCode ?? 'provider_error') : (request.failureCode ?? null)},
      1, ${row.written}, ${row.quarantined}, now()
    )
  `;
}

/**
 * Per-source staleness, for the panel's display and `search_degraded`'s
 * statement of what is not indexed yet.
 *
 * **The counters aggregate run rows only; the failures aggregate item rows
 * too.** The two halves are separated by `FILTER` rather than by a `WHERE`,
 * because they answer different questions and only one of them double-counts.
 * Summing `items_seen` across both row kinds reports twice the traffic — a
 * display nobody trusts the second time they check it. But *excluding* item
 * rows from the view entirely, which is what a `WHERE external_ref IS NULL`
 * does, hides every item-level loss there is: a pull that lost forty messages
 * to a rate limit and imported the rest closes its run row `ok`, and the brain
 * then reports itself healthy while a slice of the mailbox is missing.
 */
export async function sourceStaleness(
  sql: SQL,
  request: { readonly now: Date },
): Promise<readonly SourceStaleness[]> {
  const rows = (await sql`
    SELECT origin_context,
           source_type,
           max(coalesce(finished_at, started_at))                        AS last_checked_at,
           max(finished_at) FILTER (
             WHERE external_ref IS NULL AND items_written > 0)           AS last_write_at,
           coalesce(sum(items_seen)    FILTER (WHERE external_ref IS NULL), 0)::int
                                                                         AS items_seen,
           coalesce(sum(items_written) FILTER (WHERE external_ref IS NULL), 0)::int
                                                                         AS items_written,
           count(*) FILTER (
             WHERE external_ref IS NULL AND outcome = 'running')::int    AS running,
           -- The most recent *terminal run*, whatever it said. A later success
           -- therefore clears the code instead of being reached past.
           (array_agg(failure_code
                        ORDER BY coalesce(finished_at, started_at) DESC, ingest_id DESC)
              FILTER (WHERE external_ref IS NULL AND outcome <> 'running'))[1]
                                                                         AS last_failure_code,
           count(*) FILTER (
             WHERE external_ref IS NOT NULL AND outcome = 'failed')::int AS items_failed,
           (array_agg(failure_code
                        ORDER BY coalesce(finished_at, started_at) DESC, ingest_id DESC)
              FILTER (WHERE external_ref IS NOT NULL AND outcome = 'failed'))[1]
                                                                         AS last_item_failure_code
      FROM ingest_log
     GROUP BY origin_context, source_type
     ORDER BY origin_context, source_type
  `) as Array<{
    origin_context: string;
    source_type: string;
    last_checked_at: Date | null;
    last_write_at: Date | null;
    items_seen: number;
    items_written: number;
    running: number;
    last_failure_code: string | null;
    items_failed: number;
    last_item_failure_code: string | null;
  }>;

  return rows.map((row) => ({
    originContext: row.origin_context,
    sourceType: row.source_type as SourceType,
    lastCheckedAt: row.last_checked_at,
    lastWriteAt: row.last_write_at,
    staleSeconds:
      row.last_write_at === null
        ? null
        : Math.max(
            0,
            Math.round((request.now.getTime() - row.last_write_at.getTime()) / 1_000),
          ),
    itemsSeen: row.items_seen,
    itemsWritten: row.items_written,
    lastFailureCode: (row.last_failure_code as IngestFailureCode | null) ?? null,
    itemsFailed: row.items_failed,
    lastItemFailureCode: (row.last_item_failure_code as IngestFailureCode | null) ?? null,
    runInProgress: row.running > 0,
  }));
}
