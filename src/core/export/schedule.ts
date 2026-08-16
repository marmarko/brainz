/**
 * Scheduled self-export to a user-owned destination, and the reminder that is
 * **bounded** rather than daily.
 *
 * **Why the bound is the design and not a nicety.** The reminder rides the same
 * daily read the free→paid prompt does, and U12 already paid for that lesson:
 * `briefing` is what a client scheduled task pulls every morning, so an
 * unconditional prompt fires 365 times a year on the flagship read and a
 * knowledge product becomes an advertisement. A backup nag is worse, not better,
 * because it is a nag about something the user cannot dismiss by buying
 * anything.
 *
 * So the bound is exactly the one `src/core/briefing/prompt.ts` established, and
 * this module deliberately mirrors its shape rather than inventing a second
 * discipline: **once per band crossing, or once per interval, with a stated
 * dismissal.** What is stored is the *band* the caller was last reminded at, so
 * days accruing inside one band are silence.
 *
 *   * **Per caller**, on the grant-derived key `briefing_cursor` uses, for U12's
 *     reason: a tenant-wide bound means a second client's first-ever briefing is
 *     silent because the scheduled task used up the tenant's one reminder.
 *   * **Nothing to back up is silence.** A brain with no content is not nagged,
 *     however long it has existed — that is the `band === 0` rule from the
 *     upgrade prompt, and it exists because an empty reminder on a schedule is
 *     the purest form of the thing this module refuses.
 *   * **"Never tried" and "tried and failed" are different facts.** `self_export`
 *     carries both, and the reminder says which — a backup product that reports
 *     six weeks of silent failures as "not set up yet" has told the user the one
 *     thing that will stop them investigating.
 */

import type { SQL } from 'bun';

import { textArrayLiteral } from '../write/pg-values.ts';
import { reconstructLivePages } from './reconstruct.ts';
import { planTree, type ExportManifest, type ExportedFile } from './tree.ts';

/** Days since the last successful export. Ascending, first above zero. */
export const STALENESS_BANDS: readonly number[] = [7, 30, 90];

/** The other way through. A fortnight, so a monthly reader sees it at most once. */
export const NAG_INTERVAL_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The band a staleness sits in: the largest threshold it has reached, or zero.
 *
 * A number rather than an index so the stored value survives a change to the
 * ladder — adding a rung between two existing ones cannot silently re-remind
 * everybody who was last shown at the higher one.
 */
export function bandOf(daysStale: number): number {
  if (!Number.isFinite(daysStale)) return 0;
  let band = 0;
  for (const threshold of STALENESS_BANDS) {
    if (daysStale >= threshold) band = threshold;
  }
  return band;
}

export interface NagState {
  readonly lastShownAt: string | null;
  readonly lastBand: number;
}

export interface NagInput {
  /** Whether the user has ever chosen a destination. */
  readonly destinationConfigured: boolean;
  readonly lastExportAt: string | null;
  /** When the brain first held anything. Null means it holds nothing. */
  readonly oldestContentAt: string | null;
  readonly pages: number;
  /** A run that was attempted and failed, so silence is not reported as "not set up". */
  readonly lastFailure: string | null;
  readonly state: NagState;
  readonly now: Date;
}

export interface SelfExportNag {
  readonly kind: 'self_export';
  readonly reason: 'staleness_band' | 'interval';
  readonly band: number;
  readonly daysStale: number;
  readonly pages: number;
  readonly text: string;
  readonly dismissal: string;
}

/**
 * Whether to remind, and what with. `null` is the ordinary answer.
 *
 * Pure: the clock, the counters and the stored state all arrive as values, so
 * the bound is testable without waiting a fortnight.
 */
export function selfExportNag(input: NagInput): SelfExportNag | null {
  // Nothing to back up. Not "no destination yet" — an empty brain.
  if (input.pages === 0 || input.oldestContentAt === null) return null;

  const since = input.lastExportAt ?? input.oldestContentAt;
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) return null;

  const daysStale = Math.floor((input.now.getTime() - sinceMs) / DAY_MS);
  const band = bandOf(daysStale);
  if (band === 0) return null;

  const shownBand = bandOf(input.state.lastBand);
  const crossed = band > shownBand;

  const lastShownAt = input.state.lastShownAt === null ? null : Date.parse(input.state.lastShownAt);
  const elapsed =
    lastShownAt === null || !Number.isFinite(lastShownAt)
      ? Number.POSITIVE_INFINITY
      : input.now.getTime() - lastShownAt;
  const due = elapsed >= NAG_INTERVAL_DAYS * DAY_MS;

  if (!crossed && !due) return null;

  return {
    kind: 'self_export',
    reason: crossed ? 'staleness_band' : 'interval',
    band,
    daysStale,
    pages: input.pages,
    text: textFor(input, daysStale),
    dismissal:
      `This appears at most once every ${NAG_INTERVAL_DAYS} days, and once more only if it gets ` +
      'further out of date. Turn it off for good in the app.',
  };
}

function textFor(input: NagInput, daysStale: number): string {
  if (input.lastFailure !== null) {
    // The distinction a backup product must never lose. Reporting a failing
    // schedule as "not set up yet" is what stops the user investigating.
    return (
      `Your scheduled export has been failing for ${daysStale} days (${input.lastFailure}). ` +
      `${input.pages} documents are not backed up anywhere you control.`
    );
  }
  if (!input.destinationConfigured) {
    return (
      `${input.pages} documents live only here. An export writes them as ordinary markdown ` +
      'to somewhere you own, in the same format a self-hosted brain reads.'
    );
  }
  return (
    `Your last export was ${daysStale} days ago. ${input.pages} documents have changed or ` +
    'arrived since then.'
  );
}

export interface ExportState {
  readonly destinationKind: string | null;
  readonly lastExportAt: string | null;
  readonly lastExportPages: number | null;
  readonly lastExportDigest: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastFailure: string | null;
}

const NEVER: ExportState = {
  destinationKind: null,
  lastExportAt: null,
  lastExportPages: null,
  lastExportDigest: null,
  lastAttemptAt: null,
  lastFailure: null,
};

export async function readExportState(sql: SQL): Promise<ExportState> {
  const rows = (await sql`
    SELECT destination_kind, last_export_at::text AS last_export_at, last_export_pages,
           last_export_digest, last_attempt_at::text AS last_attempt_at, last_failure
      FROM self_export WHERE singleton
  `) as Array<Record<string, unknown>>;

  const row = rows[0];
  if (row === undefined) return NEVER;
  return {
    destinationKind: row.destination_kind === null ? null : String(row.destination_kind),
    lastExportAt: row.last_export_at === null ? null : String(row.last_export_at),
    lastExportPages: row.last_export_pages === null ? null : Number(row.last_export_pages),
    lastExportDigest: row.last_export_digest === null ? null : String(row.last_export_digest),
    lastAttemptAt: row.last_attempt_at === null ? null : String(row.last_attempt_at),
    lastFailure: row.last_failure === null ? null : String(row.last_failure),
  };
}

export async function readNagState(sql: SQL, callerKey: string): Promise<NagState> {
  const rows = (await sql`
    SELECT last_shown_at::text AS last_shown_at, last_band
      FROM self_export_nag WHERE caller_key = ${callerKey}
  `) as Array<{ last_shown_at: string | null; last_band: number }>;
  const row = rows[0];
  if (row === undefined) return { lastShownAt: null, lastBand: 0 };
  return { lastShownAt: row.last_shown_at, lastBand: Number(row.last_band) };
}

/** Bank a reminder against the caller that saw it. Idempotent per caller. */
export async function recordNagShown(
  sql: SQL,
  request: { readonly callerKey: string; readonly band: number; readonly at: Date },
): Promise<void> {
  await sql`
    INSERT INTO self_export_nag (caller_key, last_shown_at, last_band)
    VALUES (${request.callerKey}, ${request.at.toISOString()}::timestamptz, ${request.band})
    ON CONFLICT (caller_key) DO UPDATE
      SET last_shown_at = EXCLUDED.last_shown_at,
          last_band = EXCLUDED.last_band,
          updated_at = now()
  `;
}

/** Where an export goes. The transport is a live-vendor leg; the port is not. */
export interface SelfExportDestination {
  readonly kind: 'object_store' | 'user_bucket' | 'download';
  write(request: {
    readonly files: readonly ExportedFile[];
    readonly manifest: ExportManifest;
  }): Promise<void>;
}

export type SelfExportOutcome =
  | { readonly ok: true; readonly manifest: ExportManifest; readonly files: number }
  | { readonly ok: false; readonly failure: string };

/**
 * Run the export and record what happened — including when it failed.
 *
 * The attempt is banked **before** the delivery, so a destination that throws
 * leaves `last_attempt_at` moved and `last_export_at` where it was. That
 * asymmetry is the whole reason there are two columns: it is what lets the
 * reminder say "failing for six weeks" instead of "not set up yet".
 */
export async function runSelfExport(
  sql: SQL,
  request: { readonly destination: SelfExportDestination; readonly now: Date },
): Promise<SelfExportOutcome> {
  const tree = planTree(await reconstructLivePages(sql));
  const at = request.now.toISOString();

  try {
    await request.destination.write({ files: tree.files, manifest: tree.manifest });
  } catch (error) {
    const failure = error instanceof Error ? error.name : 'unknown_error';
    await sql`
      INSERT INTO self_export (singleton, destination_kind, last_attempt_at, last_failure)
      VALUES (true, ${request.destination.kind}, ${at}::timestamptz, ${failure})
      ON CONFLICT (singleton) DO UPDATE
        SET destination_kind = EXCLUDED.destination_kind,
            last_attempt_at = EXCLUDED.last_attempt_at,
            last_failure = EXCLUDED.last_failure,
            updated_at = now()
    `;
    return { ok: false, failure };
  }

  await sql`
    INSERT INTO self_export (singleton, destination_kind, last_export_at, last_export_pages,
                             last_export_digest, last_attempt_at, last_failure)
    VALUES (true, ${request.destination.kind}, ${at}::timestamptz, ${tree.manifest.pages},
            ${tree.manifest.digest}, ${at}::timestamptz, NULL)
    ON CONFLICT (singleton) DO UPDATE
      SET destination_kind = EXCLUDED.destination_kind,
          last_export_at = EXCLUDED.last_export_at,
          last_export_pages = EXCLUDED.last_export_pages,
          last_export_digest = EXCLUDED.last_export_digest,
          last_attempt_at = EXCLUDED.last_attempt_at,
          last_failure = NULL,
          updated_at = now()
  `;

  return { ok: true, manifest: tree.manifest, files: tree.files.length };
}

/**
 * The two facts the nag needs from the brain itself: how much is in it, and how
 * long any of it has been there.
 *
 * **`origins` fences it, and the caller that reads this on the briefing passes
 * one.** "Your brain holds N documents" is the most direct statement about
 * corpus size any surface makes, and a credential scoped to one origin has no
 * business being told the whole number — every other count in the bundle is
 * fenced by the grant, and a reminder that was not would be the one place a
 * narrow connection learns how big the brain it cannot read is. Omitted means
 * whole-brain, which is what a scheduled export itself runs as.
 */
export async function readContentAge(
  sql: SQL,
  options: { readonly origins?: readonly string[] } = {},
): Promise<{ readonly pages: number; readonly oldestContentAt: string | null }> {
  // Bun sends a JS array as a scalar, so the fence crosses the wire as a
  // literal and `NULL` means "no fence" — the same shape `versions.ts` uses.
  const fence = options.origins === undefined ? null : textArrayLiteral(options.origins);
  const rows = (await sql`
    SELECT count(*)::int AS pages, min(created_at)::text AS oldest
      FROM page
     WHERE deleted_at IS NULL AND quarantined_at IS NULL
       AND (${fence}::text[] IS NULL OR origin_context = ANY(${fence}::text[]))
  `) as Array<{ pages: number; oldest: string | null }>;
  const row = rows[0];
  return { pages: Number(row?.pages ?? 0), oldestContentAt: row?.oldest ?? null };
}
