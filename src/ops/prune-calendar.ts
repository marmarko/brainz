/**
 * Retiring the calendar entries a recurrence rule invented.
 *
 * `singleEvents: true` expands a recurring event into one item per occurrence,
 * and the listing carried a `timeMin` with no `timeMax` — a floor with no
 * ceiling. Measured on the founder's brain before the ceiling shipped: 935
 * calendar pages, of which **875 started after 2027 and the furthest was 2056**.
 * A weekly 1:1 contributed 387 instances and another 356. Each was chunked,
 * embedded and turned into facts by a paid model call, and 830 of 2,255 live
 * facts — 37% of everything the brain knew — described a meeting decades away.
 *
 * The connector now refuses to fetch them. This retires the ones already
 * stored, and it deliberately reads {@link CALENDAR_HORIZON_DAYS} from that
 * same module rather than taking a horizon of its own: a cleanup that used a
 * different number from the fetch would leave a band of pages that one half
 * keeps re-fetching and the other half keeps deleting.
 *
 * **Through `forgetRecord`, not raw SQL**, which is what makes this reversible.
 * Each page becomes a ledgered retraction, undoable for 72 hours from
 * `/retractions`, and the cascade carries the origin fence with it — the chunks
 * and facts a page sourced go with it, and only those the grant covers.
 *
 * Dry-run by default. `--confirm` writes.
 *
 *     bun run src/ops/prune-calendar.ts
 *     bun run src/ops/prune-calendar.ts --confirm --limit 200
 */

import { SQL } from 'bun';

import { CALENDAR_HORIZON_DAYS } from '../ingest/pipedream/sources/calendar.ts';
import { parseId } from '../mcp/ids.ts';
import { forgetRecord } from '../mcp/tombstone.ts';

interface Doomed {
  page_id: string;
  title: string | null;
  occurred_at: Date;
  chunks: number;
  facts: number;
}

export interface PrunePreview {
  readonly horizon: Date;
  readonly pages: readonly Doomed[];
  readonly byTitle: readonly { readonly title: string; readonly n: number; readonly furthest: Date }[];
  readonly chunks: number;
  readonly facts: number;
}

/** What is past the horizon, and what would go with it. Reads only. */
export async function previewPrune(sql: SQL, now: Date): Promise<PrunePreview> {
  const horizon = new Date(now.getTime() + CALENDAR_HORIZON_DAYS * 86_400_000);
  const pages = (await sql.unsafe(
    `SELECT p.page_id::text AS page_id, p.title, p.occurred_at,
            (SELECT count(*)::int FROM chunk c
              WHERE c.page_id = p.page_id AND c.deleted_at IS NULL) AS chunks,
            (SELECT count(*)::int FROM fact f
              WHERE f.deleted_at IS NULL
                AND (f.page_id = p.page_id
                     OR f.fact_id IN (SELECT fs.fact_id FROM fact_source fs
                                        JOIN chunk c2 ON c2.chunk_id = fs.chunk_id
                                       WHERE c2.page_id = p.page_id))) AS facts
       FROM page p
      WHERE p.deleted_at IS NULL
        AND p.source_type = 'calendar'
        AND p.occurred_at > $1::timestamptz
      ORDER BY p.occurred_at`,
    [horizon.toISOString()],
  )) as Doomed[];

  const grouped = new Map<string, { n: number; furthest: Date }>();
  for (const page of pages) {
    const title = page.title ?? '(untitled)';
    const seen = grouped.get(title) ?? { n: 0, furthest: page.occurred_at };
    seen.n += 1;
    if (page.occurred_at > seen.furthest) seen.furthest = page.occurred_at;
    grouped.set(title, seen);
  }
  return {
    horizon,
    pages,
    byTitle: [...grouped]
      .map(([title, seen]) => ({ title, n: seen.n, furthest: seen.furthest }))
      .sort((left, right) => right.n - left.n),
    chunks: pages.reduce((total, page) => total + page.chunks, 0),
    facts: pages.reduce((total, page) => total + page.facts, 0),
  };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const confirm = argv.includes('--confirm');
  const limitArg = argv.indexOf('--limit');
  const limit = limitArg >= 0 ? Number(argv[limitArg + 1] ?? '0') : Number.POSITIVE_INFINITY;

  const dsn = process.env.TENANT_DSN;
  if (dsn === undefined || dsn.length === 0) {
    console.error('TENANT_DSN is not set. Confirm it is THIS brain before running with --confirm.');
    process.exit(2);
  }

  const sql = new SQL(dsn);
  const now = new Date();
  const preview = await previewPrune(sql, now);

  console.log(`horizon: ${preview.horizon.toISOString().slice(0, 10)}  (now + ${CALENDAR_HORIZON_DAYS} days)`);
  console.log(`calendar pages past it: ${preview.pages.length}`);
  console.log(`  their live chunks: ${preview.chunks}`);
  console.log(`  their live facts:  ${preview.facts}`);
  console.log('\nby recurring series:');
  for (const row of preview.byTitle.slice(0, 12)) {
    console.log(`  ${String(row.n).padStart(4)}  ${row.furthest.toISOString().slice(0, 10)}  ${row.title.slice(0, 56)}`);
  }

  if (!confirm) {
    console.log('\nDRY RUN — nothing was written. Re-run with --confirm.');
    console.log('Each page becomes a ledgered retraction, undoable for 72 hours from /retractions.');
    await sql.end();
    process.exit(0);
  }

  // The grant is every origin a live page carries, which is what an owner
  // acting on their own brain holds. `forgetRecord` fences the cascade with it.
  const grant = (
    (await sql`SELECT DISTINCT origin_context FROM page WHERE deleted_at IS NULL`) as Array<{
      origin_context: string;
    }>
  ).map((row) => row.origin_context);

  let forgotten = 0;
  let chunks = 0;
  let facts = 0;
  let refused = 0;
  for (const page of preview.pages.slice(0, limit)) {
    // `doc`, not `page`: ID_KINDS is ['fact', 'doc', 'chunk', 'ent'], and a page
    // is addressed as a document. parseId returns null for anything else, which
    // is what turned an early run of this script into 845 clean refusals rather
    // than 845 wrong writes.
    const id = parseId(`doc:${page.page_id}`);
    if (id === null) { refused += 1; continue; }
    const outcome = await forgetRecord(sql, { id, grant, now: new Date() });
    if (!outcome.ok) { refused += 1; continue; }
    forgotten += 1;
    chunks += outcome.cascade.chunks;
    facts += outcome.cascade.facts;
    if (forgotten % 100 === 0) console.log(`  ... ${forgotten} pages`);
  }
  console.log(`\nforgot ${forgotten} pages, ${chunks} chunks, ${facts} facts; refused ${refused}.`);
  console.log('Undoable for 72 hours from /retractions.');
  await sql.end();
}
