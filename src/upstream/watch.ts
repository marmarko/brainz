/**
 * `bun src/upstream/watch.ts` — the weekly upstream watcher.
 *
 * ```
 *   bun src/upstream/watch.ts                       # delta since the pin, to stdout
 *   bun src/upstream/watch.ts --report <path>       # …and bank the run receipt
 *   bun src/upstream/watch.ts --apply               # append discovered rows to the ledger
 *   bun src/upstream/watch.ts --sweep               # guard sweep against the pin
 *   bun src/upstream/watch.ts --sweep --write-sweep # …and regenerate cards + stubs
 *   bun src/upstream/watch.ts --since 0.43.0.0      # demonstration against an older pin
 * ```
 *
 * No `package.json` alias, no scheduled workflow: this session may write neither.
 * The cron invocation is recorded in
 * `docs/plans/2026-08-13-002-u19-upstream-watcher-replan.md` instead, and the
 * enforcement — the half that matters — is already wired as `bun run
 * ledger:check`. A missed run delays discovery; it cannot make anything green
 * that should be red, because the review deadline is evaluated against each row's
 * own date at every ledger check rather than at watch time.
 *
 * **Two reads, two roles, both through git plumbing.** Anything that describes
 * *the pinned build* — the guard sweep — resolves at the pinned commit, so it is
 * a function of `upstream/gbrain.pin` and nothing else. The *delta* has to read a
 * ref newer than the pin by definition, so it names one (`--ref`, default `HEAD`)
 * and the receipt records the sha it resolved to. Neither read touches the
 * working tree, and none of them can write: `gbrain-repo.ts` admits five
 * read-only git subcommands and refuses the rest.
 *
 * **It does not advance the pin.** It says whether it thinks the pin should move
 * and why. Advancing it changes the build `bun run conformance` grades against,
 * and `upstream/memory-verbs-v1-partial.json` binds itself to the pinned commit
 * and refuses to grade against any other — so an automated advance would
 * invalidate a published delta with nobody in the loop.
 */

import { parsePin, type GbrainPin } from '../../evals/conformance/pin.ts';
import { releasesSince, type Release } from './changelog.ts';
import { classifyReleases, noRowsReason, type DiscoveredRow } from './classify.ts';
import { defaultCheckoutPath, openCheckout, type GbrainCheckout } from './gbrain-repo.ts';
import {
  guardFilesIn,
  renderCards,
  renderStubs,
  spliceCards,
  sweep,
  sweptCards,
  type SweepReport,
} from './hazard-sweep.ts';
import { gatePath } from './path-gate.ts';

export const PIN_PATH = 'upstream/gbrain.pin';
export const LEDGER_PATH = 'upstream/concepts.jsonl';
export const HAZARDS_DOC_PATH = 'docs/porting-hazards.md';
export const SWEPT_STUBS_PATH = 'test/hazards/swept.test.ts';
export const GUARD_INVENTORY_PATH = 'upstream/gbrain-guards.json';

export interface PinRecommendation {
  readonly advance: boolean;
  readonly reason: string;
}

export interface WatchReport {
  readonly kind: 'upstream-watch';
  /** `weekly` for a run against the live pin; `demonstration` when `--since` backdates it. */
  readonly mode: 'weekly' | 'demonstration';
  readonly run_on: string;
  readonly pin: { readonly tag: string; readonly commit: string; readonly compared_from: string };
  readonly upstream_ref: { readonly ref: string; readonly commit: string; readonly commits_ahead: number };
  readonly delta: {
    readonly releases: readonly string[];
    /**
     * Releases that produced nothing, each with its reason. `no-paths` is the
     * residue a path gate cannot see; `all-out-of-scope` is a decision the gate
     * took and a reader can check. Reported rather than dropped.
     */
    readonly no_rows: readonly { readonly version: string; readonly reason: string }[];
    readonly rows: number;
  };
  readonly rows: readonly DiscoveredRow[];
  /** Upstream `src/` paths the gate has never heard of. A finding in its own right. */
  readonly unmapped_paths: readonly string[];
  readonly out_of_scope: Readonly<Record<string, number>>;
  readonly sweep?: SweepReport & { readonly cards: readonly string[] };
  readonly pin_recommendation: PinRecommendation;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Whether the pin should move — advisory, and deliberately conservative.
 *
 * Ahead-ness is not a reason. A checkout can sit thirteen commits past the pin
 * with no release in them (unreleased work on a branch), and advancing to that
 * point would move the conformance target onto a build nobody published while
 * buying the ledger nothing.
 */
export function recommendPin(delta: readonly Release[], commitsAhead: number): PinRecommendation {
  if (delta.length > 0) {
    return {
      advance: true,
      reason:
        `${delta.length} release(s) since the pin (${delta.map((release) => release.version).join(', ')}). ` +
        'Advancing is a deliberate act with a conformance consequence: `upstream/memory-verbs-v1-partial.json` ' +
        'binds itself to the pinned commit, so the delta must be re-observed in the same change ' +
        '(`bun run conformance --raw`). This watcher does not advance it.',
    };
  }
  if (commitsAhead > 0) {
    return {
      advance: false,
      reason:
        `the checkout is ${commitsAhead} commit(s) past the pin but ships no new release — no CHANGELOG ` +
        'entry, nothing to classify. Advancing onto unreleased work would move the conformance target ' +
        'without moving the ledger. Leave the pin.',
    };
  }
  return { advance: false, reason: 'the checkout is at the pin; nothing upstream to act on.' };
}

export interface RunOptions {
  readonly checkoutPath?: string;
  readonly ref?: string;
  /** Backdate the comparison point. Produces a `demonstration` report, never a weekly one. */
  readonly since?: string;
  readonly runOn?: string;
  readonly sweep?: boolean;
}

export function runWatch(pin: GbrainPin, checkout: GbrainCheckout, opts: RunOptions = {}): WatchReport {
  const ref = opts.ref ?? 'HEAD';
  const runOn = opts.runOn ?? today();
  const pinnedVersion = pin.tag.replace(/^v/, '');
  const comparedFrom = opts.since ?? pinnedVersion;

  const changelog = checkout.readFileAt(ref, 'CHANGELOG.md');
  // Throws rather than returning [] when `comparedFrom` is not in the file. An
  // empty delta is only ever reported from a changelog the parser understood.
  const delta = releasesSince(changelog, comparedFrom);

  const rows = classifyReleases(delta, {
    run_on: runOn,
    gbrain_commit: checkout.resolve(ref),
    from_version: comparedFrom,
  });

  const unmapped = new Set<string>();
  const outOfScope: Record<string, number> = {};
  for (const release of delta) {
    for (const match of release.body.matchAll(/`((?:src|test|scripts|docs|skills|evals|admin|deploy)\/[A-Za-z0-9_@./-]+)`/g)) {
      const path = match[1];
      if (path === undefined) continue;
      const gated = gatePath(path);
      if (gated.in_scope) {
        if (gated.area === 'unmapped') unmapped.add(path);
        continue;
      }
      outOfScope[gated.reason] = (outOfScope[gated.reason] ?? 0) + 1;
    }
  }

  const report: WatchReport = {
    kind: 'upstream-watch',
    mode: opts.since === undefined ? 'weekly' : 'demonstration',
    run_on: runOn,
    pin: { tag: pin.tag, commit: pin.commit, compared_from: comparedFrom },
    upstream_ref: { ref, commit: checkout.resolve(ref), commits_ahead: checkout.commitsAhead() },
    delta: {
      releases: delta.map((release) => release.version),
      no_rows: delta.flatMap((release) => {
        const reason = noRowsReason(release);
        return reason === undefined ? [] : [{ version: release.version, reason }];
      }),
      rows: rows.length,
    },
    rows,
    unmapped_paths: [...unmapped].sort(),
    out_of_scope: outOfScope,
    pin_recommendation: recommendPin(delta, checkout.commitsAhead()),
  };

  if (opts.sweep !== true) return report;

  const guards = guardFilesIn(checkout.listTree('scripts'));
  const swept = sweep(guards);
  return { ...report, sweep: { ...swept, cards: sweptCards().map((card) => `${card.id} — ${card.title}`) } };
}

/**
 * Append discovered rows to the ledger, skipping ids already present.
 *
 * Skipping rather than crashing is what makes a re-run a no-op: ids are derived
 * from the release and the area, both facts about upstream, so a second run over
 * the same delta proposes the same rows. `check-ledger.ts` fails on a duplicate
 * id anyway, which is the backstop if this ever gets it wrong.
 */
export async function applyRows(rows: readonly DiscoveredRow[], ledgerPath = LEDGER_PATH): Promise<string[]> {
  if (rows.length === 0) return [];

  const existing = await Bun.file(ledgerPath).text();
  const present = new Set(
    existing
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => (JSON.parse(line) as { id?: string }).id)
      .filter((id): id is string => typeof id === 'string'),
  );

  const fresh = rows.filter((row) => !present.has(row.id));
  if (fresh.length === 0) return [];

  const separator = existing.endsWith('\n') ? '' : '\n';
  await Bun.write(ledgerPath, `${existing}${separator}${fresh.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return fresh.map((row) => row.id);
}

/** Regenerate the swept cards, their stubs, and the guard inventory receipt. */
export async function writeSweep(report: SweepReport, guards: readonly string[]): Promise<void> {
  const cards = sweptCards();

  const document = await Bun.file(HAZARDS_DOC_PATH).text();
  await Bun.write(HAZARDS_DOC_PATH, spliceCards(document, renderCards(cards)));
  await Bun.write(SWEPT_STUBS_PATH, renderStubs(cards));

  await Bun.write(
    GUARD_INVENTORY_PATH,
    `${JSON.stringify(
      {
        generated_by: 'src/upstream/hazard-sweep.ts',
        note:
          'Enumerated from the gbrain checkout at the pinned commit. The counts are measured, not ' +
          'inherited: `shell_guards` is the figure docs/porting-hazards.md quotes, `executable_guards` ' +
          'includes the TypeScript and JavaScript guards that figure omits, and `privacy_scanners` is a ' +
          'subset of the guards rather than an addition to them.',
        counts: report.counts,
        guards,
        cards: cards.map((card) => ({ id: card.id, title: card.title, sources: card.sources })),
      },
      null,
      2,
    )}\n`,
  );
}

function humanReport(report: WatchReport): string {
  const lines: string[] = [];
  const rule = '─'.repeat(78);

  lines.push(rule);
  lines.push(` upstream watch (${report.mode}) — ${report.run_on}`);
  lines.push(` pin ${report.pin.tag} @ ${report.pin.commit.slice(0, 12)}  compared from ${report.pin.compared_from}`);
  lines.push(
    ` upstream ${report.upstream_ref.ref} @ ${report.upstream_ref.commit.slice(0, 12)} ` +
      `(${report.upstream_ref.commits_ahead} commits ahead of the pin)`,
  );
  lines.push(rule);

  if (report.delta.releases.length === 0) {
    lines.push(' 0 releases since the pin. The CHANGELOG was read and the pinned release was found in it,');
    lines.push(' so this is an empty delta and not a broken parser.');
  } else {
    lines.push(` ${report.delta.releases.length} release(s): ${report.delta.releases.join(', ')}`);
    lines.push(` ${report.delta.rows} candidate row(s), every one \`not-yet\` — the watcher cannot claim coverage.`);
    for (const row of report.rows) {
      lines.push(`   ${row.id}  [${row.discovered_by.confidence}]  review by ${row.discovered_by.review_by}`);
      lines.push(`     ${row.discovered_by.evidence.join(', ')}`);
    }
  }

  const noPaths = report.delta.no_rows.filter((entry) => entry.reason === 'no-paths');
  const declined = report.delta.no_rows.filter((entry) => entry.reason === 'all-out-of-scope');
  if (noPaths.length > 0) {
    lines.push(` ${noPaths.length} release(s) name no file at all — invisible to a path gate, so nobody`);
    lines.push(` has read them yet: ${noPaths.map((entry) => entry.version).join(', ')}.`);
  }
  if (declined.length > 0) {
    lines.push(` ${declined.length} release(s) named only out-of-scope paths — the gate decided, and the`);
    lines.push(` decision is checkable: ${declined.map((entry) => entry.version).join(', ')}.`);
  }
  if (report.unmapped_paths.length > 0) {
    lines.push(` ${report.unmapped_paths.length} upstream path(s) the gate has never seen — extend src/upstream/path-gate.ts:`);
    for (const path of report.unmapped_paths) lines.push(`   ${path}`);
  }

  if (report.sweep !== undefined) {
    const { counts, undecided, stale, cards } = report.sweep;
    lines.push(rule);
    lines.push(
      ` guard sweep at the pin: ${counts.entries} \`scripts/check-*\` entries — ` +
        `${counts.executable_guards} executable guards (${counts.shell_guards} shell), ` +
        `${counts.data_files} data file(s).`,
    );
    lines.push(
      `   ${counts.carded} carded · ${counts.guarded} guarded here · ${counts.not_applicable} not applicable · ` +
        `${counts.unported} unported (${counts.privacy_scanners} of them privacy scanners).`,
    );
    for (const card of cards) lines.push(`   ${card}`);
    if (undecided.length > 0) {
      lines.push(' UNDECIDED — upstream guards with no entry in src/upstream/hazard-map.ts:');
      for (const path of undecided) lines.push(`   ${path}`);
    }
    if (stale.length > 0) {
      lines.push(' STALE — decision-table entries for guards upstream no longer ships:');
      for (const path of stale) lines.push(`   ${path}`);
    }
  }

  lines.push(rule);
  lines.push(` pin: ${report.pin_recommendation.advance ? 'CONSIDER ADVANCING' : 'leave as is'}`);
  lines.push(`   ${report.pin_recommendation.reason}`);
  lines.push(rule);

  return lines.join('\n');
}

export async function main(argv: readonly string[]): Promise<number> {
  const flag = (name: string): boolean => argv.includes(`--${name}`);
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };

  const pin = parsePin(await Bun.file(PIN_PATH).text());
  const checkoutPath = value('checkout') ?? defaultCheckoutPath();

  let checkout: GbrainCheckout;
  try {
    checkout = openCheckout({ path: checkoutPath, commit: pin.commit });
  } catch (error) {
    console.error(`\n  ${(error as Error).message}\n`);
    console.error('  Set GBRAIN_CHECKOUT or pass --checkout <path> to a clone containing the pinned commit.\n');
    return 2;
  }

  const wantSweep = flag('sweep') || flag('write-sweep');
  const sinceArg = value('since');
  const refArg = value('ref');
  const report = runWatch(pin, checkout, {
    sweep: wantSweep,
    ...(sinceArg === undefined ? {} : { since: sinceArg }),
    ...(refArg === undefined ? {} : { ref: refArg }),
  });

  console.log(humanReport(report));

  const reportPath = value('report');
  if (reportPath !== undefined) {
    await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n  receipt written to ${reportPath}`);
  }

  if (flag('apply')) {
    if (report.mode === 'demonstration') {
      console.error('\n  refusing --apply on a backdated run: a demonstration is not a weekly discovery.\n');
      return 2;
    }
    const applied = await applyRows(report.rows);
    console.log(`\n  ${applied.length} row(s) appended to ${LEDGER_PATH}${applied.length > 0 ? `: ${applied.join(', ')}` : ''}`);
  }

  if (flag('write-sweep') && report.sweep !== undefined) {
    await writeSweep(report.sweep, guardFilesIn(checkout.listTree('scripts')));
    console.log(`\n  regenerated ${HAZARDS_DOC_PATH}, ${SWEPT_STUBS_PATH} and ${GUARD_INVENTORY_PATH}`);
  }

  // The sweep's own findings are the exit code: an upstream guard nobody has
  // classified should stop a run, not decorate it.
  return report.sweep !== undefined && !report.sweep.ok ? 1 : 0;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
