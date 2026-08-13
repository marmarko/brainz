/**
 * Turning an upstream release into candidate ledger rows.
 *
 * **The single most important property of this module is what it cannot do.**
 * There is no code path here that emits `covered`, and none that emits
 * `omitted`. Both are excluded for the same reason, stated from opposite ends:
 *
 *   - `covered` retires a capability from every list an operator reads
 *     (`test/ledger/coverage-claims.test.ts` says it plainly, and exists because
 *     four rows in this repo claimed coverage they did not have). A weekly job
 *     that can write it is that failure industrialised.
 *   - `omitted` requires a `reason` and a `revisit_by` — judgements about
 *     brainz's roadmap, which is not in the artifact this module reads.
 *
 * `not-yet` is the only honest machine output: it says a capability exists
 * upstream and keeps it visible until somebody looks. The asymmetry is the whole
 * design. A `not-yet` about something already built costs a reviewer two minutes.
 * A `covered` about something absent costs the ledger its meaning, silently.
 *
 * **What the row carries so a wrong guess is cheap to catch.** `discovered_by`
 * records the machine, the run, the release, the area, the confidence, the
 * evidence (upstream paths), which required fields the machine assigned rather
 * than a human, and the day the review is due. `scripts/check-ledger.ts` reads
 * that block: a watcher row cannot claim coverage without a human's
 * `reviewed_by`, and it cannot sit past `review_by` unreviewed without turning
 * `bun run ledger:check` red.
 *
 * **Grouping is per (release, area), not per bullet.** A release that touches
 * four retrieval files is one concept with four pieces of evidence, not four
 * concepts. That also makes the id stable and a re-run a no-op.
 */

import type { Release } from './changelog.ts';
import { gatePath, type Area, type Confidence } from './path-gate.ts';

/**
 * How long a discovered row may sit unreviewed before `ledger:check` fails.
 *
 * Seven days, because the roadmap's own verification for this unit is *"within a
 * week the ledger has classified rows for its concepts, and CI enforces them"* —
 * and because a gate that goes red the instant a row is written is a gate that
 * trains people to ignore it. `upstream/memory-verbs-v1-partial.json` declines to
 * wire a CI job for exactly that reason; the same judgement applies here.
 */
export const REVIEW_WINDOW_DAYS = 7;

export interface Discovery {
  /** Which watcher wrote this row. A constant, so the rule can key on it. */
  readonly watcher: 'u19';
  readonly run_on: string;
  readonly gbrain_release: string;
  readonly gbrain_commit: string;
  readonly area: Area;
  readonly confidence: Confidence;
  /** The upstream paths that produced the row. */
  readonly evidence: readonly string[];
  /** Which required ledger fields were assigned by the machine, not judged by a human. */
  readonly assigned: readonly string[];
  readonly review_by: string;
  /** Absent until a human takes the row. Its presence is what unlocks a status change. */
  readonly reviewed_by?: string;
}

export interface DiscoveredRow {
  readonly id: string;
  readonly capability: string;
  readonly criticality: 'critical' | 'important' | 'optional';
  readonly status: 'not-yet';
  readonly priority: 'p0' | 'p1' | 'p2';
  readonly unit: string;
  readonly source: 'upstream-watcher';
  readonly notes: string;
  readonly discovered_by: Discovery;
}

export interface ClassifyOptions {
  readonly run_on: string;
  readonly gbrain_commit: string;
  /** The version the delta was taken from. Recorded in the notes so a row explains itself. */
  readonly from_version: string;
}

/** Stable across runs: the release and the area are both facts about upstream, not about the run. */
export function conceptId(version: string, area: Area): string {
  return `up.${version.replace(/\./g, '-')}.${area}`;
}

function addDays(isoDay: string, days: number): string {
  const date = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`run_on must be an ISO day, got ${JSON.stringify(isoDay)}`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Confidence is about how well the gate understood the change, and nothing else.
 * It orders a reviewer's queue. It never grants a status — the highest confidence
 * this module can express still produces `not-yet`.
 */
function confidenceFor(area: Area, evidence: readonly string[]): Confidence {
  if (area === 'unmapped') return 'low';
  return evidence.length >= 2 ? 'high' : 'medium';
}

/** Every backticked repo path anywhere in the release body, itemized or prose. */
function pathsInRelease(release: Release): string[] {
  const found: string[] = [];
  const pattern =
    /`((?:src|test|tests|scripts|docs|skills|evals|admin|deploy|bin)\/[A-Za-z0-9_@./-]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|sql|sh|mjs|md|json))`/g;
  for (const match of release.body.matchAll(pattern)) {
    const path = match[1];
    if (path !== undefined && !found.includes(path)) found.push(path);
  }
  return found;
}

/**
 * Why a release produced no rows, or `undefined` when it produced some.
 *
 * The two reasons are different problems and are not collapsed. `no-paths` is a
 * release whose prose describes behaviour and names no file — invisible to a path
 * gate by construction, and the residue a model would read. `all-out-of-scope` is
 * a release the gate *did* understand and decided against, which is a judgement
 * somebody can check against `path-gate.ts`. Reporting them as one number would
 * hide the first behind the second.
 */
export function noRowsReason(release: Release): 'no-paths' | 'all-out-of-scope' | undefined {
  const paths = pathsInRelease(release);
  if (paths.some((path) => gatePath(path).in_scope)) return undefined;
  return paths.length === 0 ? 'no-paths' : 'all-out-of-scope';
}

export function classifyRelease(release: Release, opts: ClassifyOptions): DiscoveredRow[] {
  const byArea = new Map<Area, string[]>();

  for (const path of pathsInRelease(release)) {
    const gated = gatePath(path);
    if (!gated.in_scope) continue;
    const bucket = byArea.get(gated.area) ?? [];
    if (!bucket.includes(path)) bucket.push(path);
    byArea.set(gated.area, bucket);
  }

  const rows: DiscoveredRow[] = [];

  for (const [area, evidence] of [...byArea.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const floor = gatePath(evidence[0] ?? '');
    if (!floor.in_scope) continue;

    const headline = release.headline.length > 0 ? release.headline : `gbrain ${release.version}`;

    rows.push({
      id: conceptId(release.version, area),
      capability: `${headline} — the ${area} part of gbrain ${release.version}`,
      criticality: floor.criticality,
      status: 'not-yet',
      priority: floor.priority,
      // The unit is this watcher until a human routes it. Naming a plausible
      // implementation unit would be a second machine-made claim.
      unit: 'U19-review',
      source: 'upstream-watcher',
      notes:
        `Discovered by the U19 upstream watcher from gbrain ${release.version} (${release.released_on}), ` +
        `taken against the pin at ${opts.from_version}. Upstream touched: ${evidence.join(', ')}. ` +
        'This row asserts only that upstream shipped something in this area — NOT that brainz lacks it ' +
        'and NOT that brainz has it. A reviewer decides which, adds `reviewed_by`, and cites a path in ' +
        'this repo when the answer is `covered`.',
      discovered_by: {
        watcher: 'u19',
        run_on: opts.run_on,
        gbrain_release: release.version,
        gbrain_commit: opts.gbrain_commit,
        area,
        confidence: confidenceFor(area, evidence),
        evidence,
        assigned: ['criticality', 'priority', 'unit'],
        review_by: addDays(opts.run_on, REVIEW_WINDOW_DAYS),
      },
    });
  }

  return rows;
}

export function classifyReleases(releases: readonly Release[], opts: ClassifyOptions): DiscoveredRow[] {
  return releases.flatMap((release) => classifyRelease(release, opts));
}
