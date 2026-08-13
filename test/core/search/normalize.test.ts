/**
 * Stage 1 — the shared normalizer, from the read side.
 *
 * The plan names drift between write-side and read-side normalization as the
 * failure, and U4 already shipped the module. So the load-bearing assertion here
 * is not "the read side normalizes correctly" — it is **"the read side is the
 * same function object the write side uses."** A read-side copy that happened to
 * agree today would pass every behavioural test in this file and diverge on the
 * first edit to either copy, which is exactly the silent failure the requirement
 * names.
 *
 * Everything else in this file is the read-side vocabulary the later stages need
 * and the write side does not: query tokenisation (the title-phrase boost, the
 * Jaccard dedup layer and the alias ladder all compare token sequences) and
 * phrase containment.
 */

import { describe, expect, test } from 'bun:test';

import {
  NORMALIZER_VERSION as READ_VERSION,
  containsPhrase,
  normalize as readNormalize,
  normalizeQuery,
  phraseOverlap,
  slugify as readSlugify,
  tokens,
} from '../../../src/core/search/normalize.ts';
import {
  NORMALIZER_VERSION as WRITE_VERSION,
  normalize as writeNormalize,
  slugify as writeSlugify,
} from '../../../src/core/write/normalize.ts';

describe('one module, not two', () => {
  test('the read side re-exports the write side, identically', () => {
    // Identity, not equivalence. `toBe` on a function is what makes a copy fail.
    expect(readNormalize).toBe(writeNormalize);
    expect(readSlugify).toBe(writeSlugify);
    expect(READ_VERSION).toBe(WRITE_VERSION);
  });

  test('an alias written with typographic punctuation matches a typed query', () => {
    // The requirement's own example, from both directions: the alias table is
    // populated by the write side and queried by the read side.
    const written = writeNormalize('O’Brien — “Sam” Okonkwo Jr.');
    const asked = readNormalize("o'brien -- \"sam\" okonkwo jr.");
    expect(written).toBe('o\'brien - "sam" okonkwo jr.');
    expect(asked).toBe('o\'brien -- "sam" okonkwo jr.');
    // The dash fold collapses one em dash to one hyphen; a typed double hyphen
    // is two characters and stays two. What must match is the fancy-quote case.
    expect(readNormalize('“K&Q”')).toBe(writeNormalize('"K&Q"'));
    expect(readNormalize('Sam’s current title')).toBe(writeNormalize("Sam's current title"));
  });
});

describe('normalizeQuery', () => {
  test('is the shared normalizer applied to the asked text', () => {
    expect(normalizeQuery('  Who   is  SAM?  ')).toBe(writeNormalize('  Who   is  SAM?  '));
  });
});

describe('tokens', () => {
  test('keeps an address and a dotted version as one token each', () => {
    // Both are alias-table keys in the fixture corpus. Splitting on `@` or `.`
    // turns `sokonkwo@example.com` into three tokens that match nothing.
    expect(tokens('sokonkwo@example.com')).toEqual(['sokonkwo@example.com']);
    expect(tokens('Firmware 3.4.1 hotfix')).toEqual(['firmware', '3.4.1', 'hotfix']);
    expect(tokens('K&Q suppliers')).toEqual(['k&q', 'suppliers']);
  });

  test('trims punctuation that is only ever a separator', () => {
    expect(tokens('S. Okonkwo')).toEqual(['s', 'okonkwo']);
    expect(tokens("Sam's current title")).toEqual(['sam', 's', 'current', 'title']);
    expect(tokens('  ')).toEqual([]);
  });

  test('tokenises through the shared normalizer', () => {
    expect(tokens('“Sam O.”')).toEqual(tokens('"Sam O."'));
  });
});

describe('containsPhrase', () => {
  test('is contiguous-subsequence containment, not bag-of-words', () => {
    expect(containsPhrase('Saltmarsh launch retro', 'Saltmarsh launch retro')).toBe(true);
    expect(containsPhrase('The Saltmarsh launch retro notes', 'Saltmarsh launch retro')).toBe(true);
    // Same words, different order: a title-phrase boost that fired here would be
    // a second keyword arm wearing a phrase boost's name.
    expect(containsPhrase('retro launch Saltmarsh', 'Saltmarsh launch retro')).toBe(false);
    expect(containsPhrase('Saltmarsh retro', 'Saltmarsh launch retro')).toBe(false);
  });

  test('an empty phrase is not contained in anything', () => {
    expect(containsPhrase('anything at all', '   ')).toBe(false);
  });
});

describe('phraseOverlap', () => {
  test('is the fraction of the phrase covered by the longest run present', () => {
    expect(phraseOverlap('Saltmarsh launch retro', 'Saltmarsh launch retro')).toBe(1);
    expect(phraseOverlap('notes from the Saltmarsh launch', 'Saltmarsh launch retro')).toBeCloseTo(
      2 / 3,
      10,
    );
    expect(phraseOverlap('unrelated text', 'Saltmarsh launch retro')).toBe(0);
    expect(phraseOverlap('anything', '')).toBe(0);
  });
});
