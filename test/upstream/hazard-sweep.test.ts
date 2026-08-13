/**
 * The hazard sweep, and the rule that gives it teeth.
 *
 * gbrain encodes its production scar tissue as executable guards under
 * `scripts/`. None of them ports as code. What ports is the *question*: does
 * brainz have anything that would catch this mechanism? `docs/porting-hazards.md`
 * answers it in prose for four of them, hand-written.
 *
 * **The automated half is completeness, not judgement.** Every upstream guard
 * gets an entry in a committed decision table that a human wrote. The sweep then
 * asserts the table and the upstream checkout still agree in both directions: a
 * guard upstream added with no entry is a hard failure, and an entry for a guard
 * upstream deleted is a stale claim. That is the finding the unit exists to
 * produce — *a guard that exists upstream and has no brainz counterpart* — turned
 * from something somebody has to remember to look for into something the build
 * refuses to be green without.
 *
 * The trap this file is built against: a completeness check passes trivially when
 * the enumeration is empty. Every assertion below runs against a non-empty guard
 * list, asserted first.
 */

import { describe, expect, test } from 'bun:test';

import { GUARD_DISPOSITIONS } from '../../src/upstream/hazard-map.ts';
import { renderCards, sweep, sweptCards } from '../../src/upstream/hazard-sweep.ts';

/** A stand-in upstream tree. Real trees are exercised in `watch.test.ts`. */
const FILES = Object.keys(GUARD_DISPOSITIONS);

describe('the guard list the sweep grades against is not empty', () => {
  test('the decision table covers dozens of upstream guards', () => {
    expect(FILES.length).toBeGreaterThan(30);
  });
});

describe('completeness in both directions', () => {
  test('an upstream tree matching the table has no findings', () => {
    const report = sweep(FILES);
    expect(report.undecided).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('a guard upstream added with no entry is a finding', () => {
    const report = sweep([...FILES, 'scripts/check-brand-new-thing.sh']);
    expect(report.undecided).toEqual(['scripts/check-brand-new-thing.sh']);
    expect(report.ok).toBe(false);
  });

  test('an entry for a guard upstream deleted is a finding', () => {
    const report = sweep(FILES.filter((file) => file !== 'scripts/check-jsonb-pattern.sh'));
    expect(report.stale).toEqual(['scripts/check-jsonb-pattern.sh']);
    expect(report.ok).toBe(false);
  });

  test('non-guard files in the same directory are not counted as guards', () => {
    // `scripts/check-test-isolation.allowlist` is data the guard reads. Counting
    // it as a guard would inflate every number this sweep reports.
    const report = sweep(FILES);
    expect(report.counts.executable_guards).toBeLessThan(FILES.length);
    expect(report.counts.data_files).toBeGreaterThan(0);
  });
});

describe('the counts are enumerated, not inherited', () => {
  test('the shell-guard count and the executable-guard count are reported separately', () => {
    // `docs/porting-hazards.md` opens with "39 executable `scripts/check-*.sh`
    // guards". That number counts `.sh` files. Upstream also ships guards written
    // in TypeScript and JavaScript, so the number of *guards* is larger than the
    // number of shell guards, and the sweep reports both rather than repeating a
    // figure it did not measure.
    const report = sweep(FILES);
    expect(report.counts.shell_guards).toBeGreaterThan(0);
    expect(report.counts.executable_guards).toBeGreaterThan(report.counts.shell_guards);
  });

  test('the privacy scanners are a subset of the guards, not an addition to them', () => {
    const report = sweep(FILES);
    expect(report.counts.privacy_scanners).toBeGreaterThan(0);
    expect(report.counts.privacy_scanners).toBeLessThan(report.counts.executable_guards);
  });
});

describe('cards are emitted only where nothing here would catch the mechanism', () => {
  const cards = sweptCards();

  test('there is at least one card, and each names its upstream sources', () => {
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.sources.length).toBeGreaterThan(0);
      expect(card.id).toMatch(/^H\d+$/);
      expect(['unported', 'guarded']).toContain(card.status);
      // A card that says `guarded` must name what closed it. The point of
      // keeping a closed card is that its number survives; a closed card with
      // no guard path would be a number surviving and nothing else.
      if (card.status === 'guarded') expect(card.guarded_by ?? '').not.toBe('');
    }
  });

  test('a closed card keeps its number rather than vanishing', () => {
    // Card ids are positional. Deleting `unpinned-search-path` when H6 was
    // guarded would have renumbered H7…H15 under every reference to them in the
    // tree, which is why `ported` is a disposition kind and not a deletion.
    const closed = cards.find((card) => card.sources.includes('scripts/check-search-path.sh'));
    expect(closed?.id).toBe('H6');
    expect(closed?.status).toBe('guarded');
    expect(cards.at(-1)?.id).toBe('H15');
  });

  test('card ids continue after the hand-written ones and never collide', () => {
    const ids = cards.map((card) => card.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(Number.parseInt(id.slice(1), 10)).toBeGreaterThan(4);
    }
  });

  test('card numbering is stable across runs, so a re-render is a no-op', () => {
    expect(sweptCards().map((card) => `${card.id}:${card.title}`)).toEqual(
      cards.map((card) => `${card.id}:${card.title}`),
    );
  });

  test('a guard with a brainz counterpart produces no card', () => {
    const carded = new Set(cards.flatMap((card) => card.sources));
    // H4 already covers lock renewal, and the gateway boundary is guarded here.
    expect(carded.has('scripts/check-worker-lock-renewal-shape.sh')).toBe(false);
    expect(carded.has('scripts/check-gateway-routed-no-direct-anthropic.sh')).toBe(false);
  });

  test('every disposition that names a brainz guard names one that exists', () => {
    // The same evidence rule the ledger applies to a `covered` row. A
    // disposition that closes a hazard by citing a file nobody wrote is the
    // whole failure this unit is against, in a different file.
    for (const [guard, disposition] of Object.entries(GUARD_DISPOSITIONS)) {
      // `ported` is held to the same rule as `guarded`: it closes a hazard by
      // naming a file, so the file has to be there.
      if (disposition.kind !== 'guarded' && disposition.kind !== 'ported') continue;
      expect(
        { guard, exists: Bun.file(disposition.guard).size > 0 },
      ).toEqual({ guard, exists: true });
    }
  });
});

describe('rendered cards match the shape `docs/porting-hazards.md` already uses', () => {
  const markdown = renderCards(sweptCards());

  test('every card carries a parseable heading and status line', () => {
    // `test/hazards/registry-consistency.test.ts` parses exactly these two
    // shapes. A card it cannot read is a card that obliges no skipped stub.
    for (const card of sweptCards()) {
      expect(markdown).toContain(`## ${card.id} — ${card.title}`);
    }
    expect(markdown).toMatch(/\*\*Status:\*\* `unported`/);
    expect(markdown).toMatch(/\*\*Status:\*\* `guarded`/);
  });

  test('each card carries the five fields the format declares', () => {
    for (const section of markdown.split(/^## /m).slice(1)) {
      expect(section).toContain('**Mechanism.**');
      expect(section).toContain('**What masked it.**');
      expect(section).toContain('**brainz analog.**');
      expect(section).toContain('**The guard.**');
      expect(section).toContain('**Status:**');
    }
  });

  test("the mechanism quotes upstream's own words and attributes them", () => {
    for (const card of sweptCards()) {
      expect(card.upstream_quote.length).toBeGreaterThan(40);
    }
    expect(markdown).toContain('gbrain');
  });
});
