/**
 * The admission fence.
 *
 * This file is the fence's cost disclosure, executable. A vocabulary that
 * refuses names is a thing whose *false* refusals are invisible in production —
 * nothing errors, the brain simply stops knowing about somebody — so the pins
 * here are weighted the other way from the usual: **the admits matter more than
 * the refusals.** If a later reader adds one token to `FUNCTION_WORDS` and
 * `Best Buy` or `Will Smith` stops being creatable, this file says so in the
 * same commit rather than a quarter later when somebody notices a gap.
 *
 * The three corpora are all real:
 *
 *   * the 84 names the production brain actually created, which is where the
 *     design came from;
 *   * 83 known-good names, which is what every constant's cost was measured
 *     against before it was written down;
 *   * the probes that *killed* rules — a broad `^[A-Z][a-z]*-[a-z-]+$`
 *     hyphen rule, a 40-token trailing-word rule, and eight prepositions —
 *     asserted as admits so those rules cannot come back without this file
 *     going red.
 */

import { describe, expect, test } from 'bun:test';

import {
  EVIDENCE_THRESHOLD,
  admitEntityName,
  corpusEvidence,
} from '../../../src/core/write/entity-admission.ts';

/**
 * Every name the production brain created, with the verdict the fence gives it
 * **without** the corpus door.
 *
 * 29 of 84. The 55 admits are as much of the pin as the refusals: they are
 * §"what it deliberately cannot do", executable.
 */
const PRODUCTION: ReadonlyArray<readonly [string, string | null]> = [
  ['IVe Systems', null],
  ['AI-powered', 'adjectival_compound'],
  ['Morgan Wealth Management', null],
  ['JPMorgan Chase', null],
  ['In California Anthem Blue Cross', 'opens_with_a_preposition'],
  ['Blue Cross of California', null],
  ['New York Anthem Blue Cross', null],
  ['Anthem HealthChoice Assurance', null],
  ['Anthem Blue Cross HP', null],
  ['Anthem HP', null],
  ['Anthem', null],
  ['Anthem Insurance Companies', null],
  ['App Store', null],
  ['Apple Inc', null],
  ['Jack Cheng', null],
  ['Every', 'function_words_only'],
  ['Discover', null],
  ['Capital One', null],
  ['Glassdoor', null],
  ['Indeed', 'function_words_only'],
  ['Indeed We', 'function_words_only'],
  ['How', 'function_words_only'],
  ['Clover Park', null],
  ['Luke', null],
  ['PS1', null],
  ['There', 'function_words_only'],
  ['Jennette', null],
  ['Google Play', null],
  ['Google LLC', null],
  ['TRADE', null],
  ['Morgan Stanley', null],
  ['Attached', 'function_words_only'],
  ['DivorceVirtual', null],
  ['Chase Payment Solutions', null],
  ['JPMorgan Chase Bank', null],
  ['X', 'too_short'],
  ['X Corp', null],
  ['Here', 'function_words_only'],
  ['Social Foundations', null],
  ['That', 'function_words_only'],
  ['Shepard', null],
  ['Everyone', 'function_words_only'],
  ['Gaza', null],
  ["School Wrap Party'", null],
  ['Friday', 'calendar_word'],
  ['Android', null],
  ['Google Inc', null],
  ["Andy Catchup'", null],
  ['Thursday', 'calendar_word'],
  ['Jim Meenaghan', null],
  ['TrueTake', null],
  ["AI Systems'", null],
  ['June', 'calendar_word'],
  ["House'", null],
  ['Tuesday', 'calendar_word'],
  ['Marko Vasiljevic', null],
  ['Wednesday', 'calendar_word'],
  ['FICO', null],
  ['Fair Isaac Corporation', null],
  ['GmbH', null],
  ['Geranienweg', null],
  ['Sprouts Farmers Market', null],
  ['Apple', null],
  ['Apple One Premier', null],
  ['EasyPassport', null],
  ['Monday', 'calendar_word'],
  ['XXXXX2285', null],
  ['AutoPay', null],
  ['Google Ads', null],
  ['Search and Performance Max', null],
  ['Twin Peaks', null],
  ['Ralphs', null],
  ['July', 'calendar_word'],
  ['August', 'calendar_word'],
  ['Eric Dargelies and Marko', null],
  ['April', 'calendar_word'],
  ['March', 'calendar_word'],
  ['February', 'calendar_word'],
  ['January', 'calendar_word'],
  ['December', 'calendar_word'],
  ['November', 'calendar_word'],
  ['October', 'calendar_word'],
  ['September', 'calendar_word'],
  ['May', 'calendar_word'],
];

/**
 * Names a personal brain should always be able to create.
 *
 * Every constant in the module was measured against this list before it was
 * written down. Five are refused and they are asserted as refusals below, so
 * the length floor's cost is pinned rather than discovered.
 */
const KNOWN_GOOD: readonly string[] = [
  // Function words that are also brands, saved by a content word.
  'Best Buy', 'Yes Bank', 'Now Foods', 'Given Imaging', 'Will Smith',
  'Hello Fresh', 'Dear Media', 'This American Life', 'Here Technologies',
  'Indeed Inc', 'Every Inc', 'That Game Company', 'The Beatles',
  'All Nippon Airways', 'First Republic', 'Bank of America', 'About You Group',
  // Prepositions that open real names — the eight this design gave back.
  'On Semiconductor', 'On Deck Capital', 'At Home Group', 'From Software',
  'With Intelligence', 'Into the Gloss', 'To The Stars', 'Under Armour',
  'Over the Moon Bakery',
  // Hyphens the narrowed compound rule must not touch.
  'Wal-mart', 'Mercedes-benz', 'Hewlett-packard', 'E-trade', 'X-ray Labs',
  'Anne-marie Slaughter', 'Jean-luc Picard', 'In-N-Out Burger', 'Coca-Cola',
  'T-Mobile', 'Rolls-Royce',
  // Trailing tokens the rejected `cannot_end_a_name` rule would have killed.
  'Nguyen Van An', 'Le Thi An', 'Bui Thi Be', 'Park Ji In', 'Company A',
  'Series A', 'Class A', 'Vitamin A', 'Studio B',
  // Calendar words rescued by the arity guard.
  'June Smith', 'Friday Harbor', 'Black Friday Inc', 'April Ryan',
  'Sunday Riley', 'May Mobility', 'August Capital',
  // Ampersands and dots the normalizer keeps as one token.
  'AT&T', 'Johnson & Johnson', 'J.P. Morgan', 'Procter & Gamble',
  // Ordinary people and companies.
  'Marcus Fell', 'Kettle Works', 'Samantha Okonkwo', 'Verdant Loom',
  'Toshiro Abe', 'Kettle and Quill', 'Acme Holdings', 'Capital One',
  'Sprouts Farmers Market', 'Fair Isaac Corporation', 'Morgan Stanley',
  'Twin Peaks', 'Clover Park', 'Google Ads', 'Apple One Premier',
  'EasyPassport', 'TrueTake', 'DivorceVirtual', 'Social Foundations',
  'Glassdoor', 'Android Auto', 'Google Play Store', 'Chase Payment Solutions',
  'Anthem Insurance Companies', 'Blue Cross of California', 'Gaza', 'Luke',
  'Jennette', 'Shepard', 'Geranienweg',
];

/** The known-good names the length floor declines, and nothing else. */
const KNOWN_GOOD_REFUSED: readonly string[] = ['GE', 'HP', '3M', 'H&M', 'A&E'];

describe('the production corpus, name by name', () => {
  for (const [name, signal] of PRODUCTION) {
    test(`${name} — ${signal ?? 'admit'}`, () => {
      const verdict = admitEntityName(name);
      if (signal === null) {
        expect(verdict.verdict).toBe('admit');
        expect(verdict.signals).toEqual([]);
        return;
      }
      expect(verdict.verdict).toBe('refuse');
      expect(verdict.signals).toContain(signal);
    });
  }

  test('29 of the 84 rows would never have been created', () => {
    const refused = PRODUCTION.filter(([, signal]) => signal !== null);
    expect(refused).toHaveLength(29);
    expect(PRODUCTION).toHaveLength(84);
  });

  test('the wrong-typed rows are admitted, because their names are fine', () => {
    // The fence cannot fix a type and this is where that is executable rather
    // than a paragraph: every one of these is filed as a *person* in production.
    for (const name of ['Android', 'App Store', 'Discover', 'Glassdoor', 'Google Play', 'TRADE']) {
      expect(admitEntityName(name).verdict).toBe('admit');
    }
  });

  test('junk shaped like a name is admitted, and named as such', () => {
    // One-row classes. A rule per row is the treadmill the all-tokens
    // formulation exists to stop, so these stay and are forgotten by hand.
    for (const name of ['PS1', 'XXXXX2285', 'GmbH', 'IVe Systems', 'Eric Dargelies and Marko']) {
      expect(admitEntityName(name).verdict).toBe('admit');
    }
  });
});

describe('the known-good corpus', () => {
  for (const name of KNOWN_GOOD) {
    test(`${name} is creatable`, () => {
      expect(admitEntityName(name)).toEqual({ verdict: 'admit', signals: [] });
    });
  }

  for (const name of KNOWN_GOOD_REFUSED) {
    test(`${name} is not — the length floor's disclosed cost`, () => {
      const verdict = admitEntityName(name);
      expect(verdict.verdict).toBe('refuse');
      expect(verdict.signals).toEqual(['too_short']);
    });
  }

  test('nothing else in the known-good corpus is refused', () => {
    const refused = KNOWN_GOOD.filter((name) => admitEntityName(name).verdict === 'refuse');
    expect(refused).toEqual([]);
  });
});

describe('the evidence door', () => {
  const door = { seenAwayFromStart: new Set(['indeed']) };

  test('clears a single-token brand that is a pure function word', () => {
    expect(admitEntityName('Indeed').verdict).toBe('refuse');
    expect(admitEntityName('Indeed', door).verdict).toBe('admit');
  });

  test('is one-directional: no evidence set turns an admit into a refuse', () => {
    const everything = { seenAwayFromStart: new Set(KNOWN_GOOD.map((n) => n.toLowerCase())) };
    for (const name of [...KNOWN_GOOD, 'Android', 'PS1']) {
      const bare = admitEntityName(name).verdict;
      if (bare === 'refuse') continue;
      expect(admitEntityName(name, everything).verdict).toBe('admit');
    }
  });

  test('is name-keyed, so a quoted sentence cannot poison a token', () => {
    // The hazard: a subject line quoted into a statement. Clearing the whole
    // phrase must not clear the word.
    const poisoned = { seenAwayFromStart: new Set(['here is your statement']) };
    expect(admitEntityName('Here', poisoned).verdict).toBe('refuse');
  });

  test('cannot clear a calendar word or a length floor', () => {
    const wide = { seenAwayFromStart: new Set(['thursday', 'x', 'ai-powered']) };
    expect(admitEntityName('Thursday', wide).verdict).toBe('refuse');
    expect(admitEntityName('X', wide).verdict).toBe('refuse');
    expect(admitEntityName('AI-powered', wide).verdict).toBe('refuse');
  });
});

describe('corpusEvidence', () => {
  test('collects a name stated away from a sentence opening', () => {
    const evidence = corpusEvidence([
      'The contact is Indeed for hiring.',
      'Payroll runs through Indeed each month.',
    ]);
    expect(evidence.seenAwayFromStart.has('indeed')).toBe(true);
  });

  test('ignores a name that only ever opens a sentence', () => {
    const evidence = corpusEvidence([
      'Indeed is the contact at Capital One.',
      'Indeed sent the summary.',
    ]);
    expect(evidence.seenAwayFromStart.has('indeed')).toBe(false);
    // ...and picks up the one that did not open one.
    expect(evidence.seenAwayFromStart.has('capital one')).toBe(false);
  });

  test(`needs ${EVIDENCE_THRESHOLD} distinct statements, not two mentions in one`, () => {
    const once = corpusEvidence(['Payroll runs through Indeed and Indeed again.']);
    expect(once.seenAwayFromStart.has('indeed')).toBe(false);
    const twice = corpusEvidence([
      'Payroll runs through Indeed.',
      'The listing went to Indeed.',
    ]);
    expect(twice.seenAwayFromStart.has('indeed')).toBe(true);
  });

  test('an empty corpus clears nothing', () => {
    expect(corpusEvidence([]).seenAwayFromStart.size).toBe(0);
  });
});
