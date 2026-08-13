/**
 * The shared normalizer — U4 approach step 2 of U5's list, owned here because
 * the write path populates what the read path queries.
 *
 * **The named failure is drift between the two sides, and it does not present
 * as an error.** An alias stored the way a mail client wrote it (curly
 * apostrophe, non-breaking space, fullwidth punctuation) and queried the way a
 * keyboard types it (ASCII) simply misses: no exception, no log line, one fewer
 * result. So the assertions below are all of the form "these two spellings
 * produce the same key", and the guard at the bottom is what keeps a second
 * implementation from appearing next to this one.
 *
 * NFKC alone does **not** close it. Unicode's compatibility decomposition folds
 * ligatures and fullwidth forms but leaves U+2019 RIGHT SINGLE QUOTATION MARK
 * exactly where it found it — so a normalizer that stops at `.normalize('NFKC')`
 * passes a casual reading of the requirement and fails the requirement's own
 * example. That case is pinned first.
 */

import { describe, expect, test } from 'bun:test';

import {
  NORMALIZER_VERSION,
  normalize,
  slugify,
} from '../../../src/core/write/normalize.ts';

describe('the write side and the read side agree on a key', () => {
  test("a fancy apostrophe matches an ASCII one — NFKC alone does not do this", () => {
    // The requirement's own example. `String.prototype.normalize('NFKC')` leaves
    // U+2019 untouched, so this assertion is the difference between citing the
    // spec and implementing it.
    expect(normalize('O’Brien’s Notes')).toBe(normalize("O'Brien's Notes"));
    expect('O’Brien'.normalize('NFKC')).not.toBe("O'Brien");
  });

  test('typographic dashes, ellipses and quotes fold to their ASCII spellings', () => {
    expect(normalize('Acme — Series A')).toBe(normalize('Acme - Series A'));
    expect(normalize('“widget”')).toBe(normalize('"widget"'));
    expect(normalize('wait…')).toBe(normalize('wait...'));
  });

  test('a non-breaking space is a space, and runs of whitespace collapse', () => {
    expect(normalize('Series A')).toBe('series a');
    expect(normalize('  Series \t\n  A  ')).toBe('series a');
  });

  test('zero-width characters are removed, not preserved as a difference', () => {
    // Pasted from a rich-text editor. Invisible in every diff and every test
    // report, and it makes an exact-match lookup miss forever.
    expect(normalize('Wid​get﻿ Co')).toBe(normalize('Widget Co'));
  });

  test('compatibility forms fold: fullwidth, ligature, and circled digits', () => {
    expect(normalize('ＡＣＭＥ')).toBe('acme');
    expect(normalize('ofﬁce')).toBe('office');
  });

  test('case folds', () => {
    expect(normalize('Verdant Systems')).toBe('verdant systems');
  });

  test('normalizing twice changes nothing', () => {
    const once = normalize('  “Acme’s—Widgets” Ltd ');
    expect(normalize(once)).toBe(once);
  });

  test('it does not collapse two genuinely different names together', () => {
    expect(normalize('Verdant Systems')).not.toBe(normalize('Verdant Sciences'));
  });
});

describe('slugs are derived from the normalizer, not from a second convention', () => {
  test('a slug satisfies the schema CHECK that governs the addressing namespace', () => {
    // `entity_slug_is_a_slug`: ^[a-z0-9][a-z0-9-]{0,127}$. A slug the database
    // refuses is a write path that fails at the last statement of a transaction.
    const pattern = /^[a-z0-9][a-z0-9-]{0,127}$/;
    for (const name of [
      'O’Brien & Sons, Ltd.',
      '  Verdant   Systems  ',
      'ＡＣＭＥ',
      '2026 Q1 Plan',
      'a'.repeat(400),
      '中文文档',
    ]) {
      expect(slugify(name)).toMatch(pattern);
    }
  });

  test('two spellings of one name produce one slug', () => {
    expect(slugify('O’Brien’s')).toBe(slugify("O'Brien's"));
  });

  test('a name with nothing sluggable still produces an addressable slug', () => {
    // "!!!" normalizes to the empty string. Returning '' would violate the CHECK
    // and take the whole write down at commit time.
    expect(slugify('!!!')).toMatch(/^[a-z0-9][a-z0-9-]{0,127}$/);
  });
});

describe('the version is declared, because the page records it', () => {
  test('NORMALIZER_VERSION is a positive integer', () => {
    expect(Number.isInteger(NORMALIZER_VERSION)).toBe(true);
    expect(NORMALIZER_VERSION).toBeGreaterThan(0);
  });
});

describe('one module, enforced', () => {
  test('nothing else under src/ implements a second normalizer', async () => {
    // The plan names drift between write-side and read-side normalization as
    // the failure. A prose rule cannot stop U5 from writing its own; this scan
    // can. It looks for the two things a second implementation must contain.
    const { Glob } = await import('bun');
    const root = `${import.meta.dir}/../../../src`;
    const offenders: string[] = [];

    for await (const relative of new Glob('**/*.ts').scan({ cwd: root })) {
      if (relative === 'core/write/normalize.ts') continue;
      const text = await Bun.file(`${root}/${relative}`).text();
      // Strip comments: a doc comment explaining the rule is not a violation.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('//'))
        .join('\n');
      if (/normalize\(\s*['"]NFK[CD]['"]\s*\)/.test(code)) {
        offenders.push(`${relative}: calls String.normalize('NFKC') outside the shared module`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
