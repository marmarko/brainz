/**
 * The sweep: upstream's guard corpus against brainz's decision table.
 *
 * The automated claim is narrow and worth stating so nobody reads more into it.
 * This module does **not** decide whether a hazard applies here — a human did
 * that once, in `hazard-map.ts`. What it does is refuse to let the two drift:
 * every `scripts/check-*` file present at the pinned commit must have a
 * disposition, every disposition must correspond to a file that is still there,
 * and every disposition that closes a hazard by naming a brainz guard must name
 * one that exists.
 *
 * That is the finding U19 exists to produce, made structural. Before it, "gbrain
 * ships 39 guards and brainz has ported four hazards" was a sentence somebody had
 * to re-check by hand. After it, a guard upstream writes next week turns
 * `bun src/upstream/watch.ts --sweep` red until somebody says what it means here.
 *
 * **The counts are enumerated rather than inherited.** `docs/porting-hazards.md`
 * opens with "39 executable `scripts/check-*.sh` guards ... plus 6 privacy
 * scanners", and both halves of that sentence need care: the 39 counts shell
 * files, so it excludes the TypeScript and JavaScript guards upstream also ships,
 * and the 6 privacy scanners are *inside* the 39 rather than additional to them.
 * This module reports what it counted, in the categories it counted them in.
 */

import { GUARD_DISPOSITIONS, SWEPT_CARDS, type Disposition, type SweptCardSpec } from './hazard-map.ts';

/** The hand-written cards in `docs/porting-hazards.md`. Swept cards number after them. */
export const HAND_WRITTEN_CARDS = 4;

export interface SweptCard extends SweptCardSpec {
  /** `H5`, `H6`, … — positional in {@link SWEPT_CARDS}, so re-rendering is a no-op. */
  readonly id: string;
  readonly status: 'unported' | 'guarded';
  /** The brainz guard that closed it, when the card is `guarded`. */
  readonly guarded_by?: string;
  /** The upstream guards this card answers for. */
  readonly sources: readonly string[];
  /** Upstream's own words, quoted from the guard headers at the pinned commit. */
  readonly upstream_quote: string;
}

export interface SweepCounts {
  /** Every `scripts/check-*` entry, including the data files. */
  readonly entries: number;
  /** Files that are executable guards: `.sh`, `.ts`, `.mjs`. */
  readonly executable_guards: number;
  /** The subset written in shell — the number `docs/porting-hazards.md` quotes. */
  readonly shell_guards: number;
  /** Non-guard companions (allowlists, fixtures) counted separately, never as guards. */
  readonly data_files: number;
  /** Guards whose disposition is a privacy scanner card. A subset, not an addition. */
  readonly privacy_scanners: number;
  readonly carded: number;
  readonly guarded: number;
  readonly not_applicable: number;
  readonly unported: number;
}

export interface SweepReport {
  readonly ok: boolean;
  /** Upstream guards with no entry in the decision table. The finding. */
  readonly undecided: readonly string[];
  /** Decision-table entries for files upstream no longer ships. A stale claim. */
  readonly stale: readonly string[];
  readonly counts: SweepCounts;
}

const GUARD_EXTENSIONS = ['.sh', '.ts', '.mjs'];

function isExecutableGuard(path: string): boolean {
  return GUARD_EXTENSIONS.some((extension) => path.endsWith(extension));
}

/** Every `scripts/check-*` entry in an upstream tree listing. */
export function guardFilesIn(tree: readonly string[]): string[] {
  return tree.filter((path) => /^scripts\/check-/.test(path)).sort();
}

export function sweep(upstreamFiles: readonly string[]): SweepReport {
  const present = [...upstreamFiles].sort();
  const decided = new Set(Object.keys(GUARD_DISPOSITIONS));

  const undecided = present.filter((path) => !decided.has(path));
  const stale = [...decided].filter((path) => !present.includes(path)).sort();

  const dispositions = present
    .map((path) => GUARD_DISPOSITIONS[path])
    .filter((entry): entry is Disposition => entry !== undefined);

  const counts: SweepCounts = {
    entries: present.length,
    executable_guards: present.filter(isExecutableGuard).length,
    shell_guards: present.filter((path) => path.endsWith('.sh')).length,
    data_files: present.filter((path) => !isExecutableGuard(path)).length,
    privacy_scanners: dispositions.filter(
      (entry) => entry.kind === 'unported' && entry.card === 'privacy-scanners',
    ).length,
    carded: dispositions.filter((entry) => entry.kind === 'carded').length,
    // `ported` counts here rather than under `unported`: it names a brainz guard
    // that exists, which is what `guarded` means. The distinction the two kinds
    // keep is whether a card was ever emitted, not whether a guard is written.
    guarded: dispositions.filter((entry) => entry.kind === 'guarded' || entry.kind === 'ported')
      .length,
    not_applicable: dispositions.filter((entry) => entry.kind === 'not-applicable').length,
    unported: dispositions.filter((entry) => entry.kind === 'unported').length,
  };

  return { ok: undecided.length === 0 && stale.length === 0, undecided, stale, counts };
}

/**
 * The cards the decision table obliges, numbered from {@link HAND_WRITTEN_CARDS}.
 *
 * A card spec with no upstream guard pointing at it produces nothing — a card
 * whose sources all disappeared upstream is a hazard nobody is inheriting any
 * more, and it should stop printing rather than linger.
 */
export function sweptCards(): SweptCard[] {
  const sourcesByCard = new Map<string, string[]>();
  const quotesByCard = new Map<string, string[]>();

  // A card closed by a brainz guard keeps its sources, its quote and its number.
  // Dropping it would renumber every card after it, which is why `ported` exists
  // as a kind rather than as a deletion.
  const guardsByCard = new Map<string, string[]>();

  for (const [guard, disposition] of Object.entries(GUARD_DISPOSITIONS)) {
    if (disposition.kind !== 'unported' && disposition.kind !== 'ported') continue;
    const sources = sourcesByCard.get(disposition.card) ?? [];
    sources.push(guard);
    sourcesByCard.set(disposition.card, sources.sort());
    const quotes = quotesByCard.get(disposition.card) ?? [];
    quotes.push(disposition.quote);
    quotesByCard.set(disposition.card, quotes);
    if (disposition.kind === 'ported') {
      const closed = guardsByCard.get(disposition.card) ?? [];
      closed.push(disposition.guard);
      guardsByCard.set(disposition.card, [...new Set(closed)].sort());
    }
  }

  const cards: SweptCard[] = [];
  let next = HAND_WRITTEN_CARDS + 1;

  for (const spec of SWEPT_CARDS) {
    const sources = sourcesByCard.get(spec.key);
    if (sources === undefined || sources.length === 0) continue;
    // Guarded only when EVERY upstream guard behind the card is ported. Six
    // privacy scanners are one card; closing one of them closes no hazard, and a
    // card that flipped on the first would be claiming coverage it does not have.
    const closedBy = guardsByCard.get(spec.key) ?? [];
    const guarded = closedBy.length > 0 && closedBy.length === countPortedFor(spec.key) &&
      sources.length === countPortedFor(spec.key);

    cards.push({
      ...spec,
      id: `H${next}`,
      status: guarded ? 'guarded' : 'unported',
      ...(guarded ? { guarded_by: closedBy.join(', ') } : {}),
      sources,
      upstream_quote: (quotesByCard.get(spec.key) ?? []).join(' … '),
    });
    next += 1;
  }

  return cards;
}

/** How many of a card's upstream guards carry a `ported` disposition. */
function countPortedFor(card: string): number {
  return Object.values(GUARD_DISPOSITIONS).filter(
    (entry) => entry.kind === 'ported' && entry.card === card,
  ).length;
}

/**
 * Cards in the format `docs/porting-hazards.md` already uses — heading, status
 * line, and the five fields H1–H4 carry.
 *
 * The heading and status shapes are not cosmetic:
 * `test/hazards/registry-consistency.test.ts` parses exactly them, and a card it
 * cannot read is a card that obliges no skipped stub and therefore counts toward
 * nothing.
 */
export function renderCards(cards: readonly SweptCard[]): string {
  const sections = cards.map((card) => {
    const sources = card.sources.map((source) => `\`${source}\``).join(', ');
    const related = card.related === undefined ? '' : `\n**Related.** ${card.related}\n`;

    return [
      `## ${card.id} — ${card.title}`,
      '',
      `**Status:** \`${card.status}\` — swept from gbrain's guard corpus by \`src/upstream/hazard-sweep.ts\`.`,
      card.status === 'guarded'
        ? `brainz guard: \`${card.guarded_by}\`. Upstream source: ${sources}.`
        : `No brainz counterpart. Upstream source: ${sources}.`,
      '',
      `**Mechanism.** gbrain's own words, from the guard header at the pinned commit:`,
      '',
      `> ${card.upstream_quote}`,
      '',
      `**What masked it.** ${card.masked}`,
      '',
      `**brainz analog.** ${card.analog}`,
      '',
      `**The guard.** ${card.guard}`,
      related,
    ].join('\n');
  });

  return sections.join('\n---\n\n');
}

/**
 * The skipped-test stubs the cards oblige.
 *
 * U1's discipline, stated in the roadmap: *"Every unported gbrain hazard ships as
 * a skipped test naming its reason, so the suite prints the unguarded-hazard
 * count."* Generating them alongside the cards is what keeps
 * `registry-consistency.test.ts` satisfiable without anybody hand-copying a
 * roster — and that test, not this generator, is what fails if the two drift.
 */
export function renderStubs(cards: readonly SweptCard[]): string {
  const header = [
    '/**',
    ' * Skipped stubs for the hazards swept out of gbrain’s guard corpus (U19).',
    ' *',
    ' * GENERATED by `src/upstream/hazard-sweep.ts` — run',
    ' * `bun src/upstream/watch.ts --sweep --write-sweep` to refresh. Edit the decision',
    ' * table in `src/upstream/hazard-map.ts`, never this file.',
    ' *',
    ' * Each stub names a mechanism gbrain guards executably and brainz does not. The',
    ' * reason string is the whole artifact: `bun test` prints it on every run, so the',
    ' * unguarded-hazard count is a number the suite reports rather than a number',
    ' * somebody re-derives. A stub becomes a real test when its card flips to',
    ' * `guarded` in `docs/porting-hazards.md`.',
    ' */',
    '',
    "import { test } from 'bun:test';",
    '',
  ].join('\n');

  // A guarded card obliges no stub: `registry-consistency.test.ts` reads a stub
  // with no `unported` row as a stale skip inflating the unguarded count.
  const stubs = cards.filter((card) => card.status === 'unported').map((card) => {
    const sources = card.sources.join(', ');
    const reason = `${card.id} — ${card.title}: unported from ${sources}. ${card.guard.replace(/\s+/g, ' ')}`;
    return `test.skip(${JSON.stringify(reason)}, () => {});`;
  });

  return `${header}${stubs.join('\n\n')}\n`;
}

/** Markers delimiting the generated region inside the hand-written ledger. */
export const SWEEP_BEGIN = '<!-- BEGIN swept-cards (generated by src/upstream/hazard-sweep.ts) -->';
export const SWEEP_END = '<!-- END swept-cards -->';

/**
 * Splice rendered cards into `docs/porting-hazards.md` between the markers,
 * leaving every hand-written word outside them untouched.
 *
 * @throws if the markers are absent or out of order — silently appending to a
 * hand-written ledger is how a generator starts owning prose nobody meant it to.
 */
export function spliceCards(document: string, rendered: string): string {
  const begin = document.indexOf(SWEEP_BEGIN);
  const end = document.indexOf(SWEEP_END);
  if (begin === -1 || end === -1 || end < begin) {
    throw new Error(
      `docs/porting-hazards.md is missing the generated-region markers (${SWEEP_BEGIN} … ${SWEEP_END}). ` +
        'Refusing to write: a generator that appends to a hand-written ledger will eventually own it.',
    );
  }
  return `${document.slice(0, begin + SWEEP_BEGIN.length)}\n\n${rendered}\n${document.slice(end)}`;
}
