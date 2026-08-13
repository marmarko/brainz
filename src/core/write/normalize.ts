/**
 * The shared normalizer. One module, applied on write **and** on read.
 *
 * The plan names drift between the two sides as the failure, and the reason it
 * says so is that drift has no symptom. An alias stored the way a mail client
 * spelled it — curly apostrophe, non-breaking space, a zero-width joiner left
 * behind by a rich-text paste — and looked up the way a keyboard types it
 * simply does not match. Nothing throws, nothing is logged, the entity is
 * merely not found. So this is the module both sides import, and
 * `test/core/write/normalize.test.ts` scans `src/` to keep a second copy from
 * appearing beside it.
 *
 * **NFKC alone is not the normalizer, and believing it is is the subtle bug.**
 * Unicode's compatibility decomposition folds fullwidth forms, ligatures and
 * circled digits, and it maps U+00A0 to a space — but it leaves U+2019 RIGHT
 * SINGLE QUOTATION MARK exactly where it found it. `O’Brien` and `O'Brien` are
 * still two different strings after NFKC, which is precisely the example the
 * requirement uses. The punctuation fold below is therefore load-bearing rather
 * than cosmetic.
 *
 * **What it deliberately does not do: touch stored text.** `chunk.content` and
 * `page.title` keep the user's own spelling. This produces *keys* — alias
 * lookups, dedup comparisons, slug derivation — and a write path that
 * normalized the content it stored would hand the reader back a lowercased,
 * de-punctuated version of their own note.
 */

import { createHash } from 'node:crypto';

/**
 * Recorded on every page (`page.normalizer_version`), because a change here
 * changes which aliases match which queries across the whole corpus. KTD8's
 * re-embed job selects on the provenance signature this is part of.
 */
export const NORMALIZER_VERSION = 1;

/**
 * Typographic characters NFKC leaves alone, and their ASCII spellings.
 *
 * Every entry is a character a mail client, a word processor or a phone
 * keyboard produces automatically, on text a human will later type by hand.
 */
const PUNCTUATION_FOLD: ReadonlyArray<readonly [RegExp, string]> = [
  // Apostrophes and single quotes: U+2018/2019/201A/201B, U+2032 prime, U+02BC
  // modifier apostrophe (common in transliterated names), U+0060 backtick.
  [/[‘’‚‛′ʼ´`]/g, "'"],
  // Double quotes: U+201C-U+201F, U+2033 double prime, U+00AB/BB guillemets.
  [/[“”„‟″«»]/g, '"'],
  // Dashes: hyphen-minus variants, en, em, horizontal bar, minus sign.
  [/[‐‑‒–—―−]/g, '-'],
  // Ellipsis. NFKC maps U+2026 to "..." already, but only under NFKC — and a
  // future change to the composition order should not silently drop this.
  [/…/g, '...'],
];

/**
 * Characters that are invisible in every diff, every test report and every
 * error message, and that make an exact-match lookup miss forever: zero-width
 * space/non-joiner/joiner, word joiner, BOM, and the soft hyphen.
 */
const INVISIBLE = /[­​‌‍⁠﻿]/g;

/**
 * The key both sides compute. NFKC first, then the punctuation fold NFKC does
 * not perform, then invisibles, then case, then whitespace.
 *
 * Order matters in one place worth naming: the fold runs *after* NFKC so that a
 * fullwidth quotation mark (which NFKC turns into U+201C) still reaches the
 * fold table.
 */
export function normalize(text: string): string {
  let out = text.normalize('NFKC');
  for (const [pattern, replacement] of PUNCTUATION_FOLD) out = out.replace(pattern, replacement);
  out = out.replace(INVISIBLE, '');
  out = out.toLowerCase();
  // `\s` under `u` covers the whole Unicode whitespace class, including the
  // ideographic space U+3000 that NFKC has already turned into U+0020.
  return out.replace(/\s+/gu, ' ').trim();
}

/** Longest slug `entity_slug_is_a_slug` admits: `^[a-z0-9][a-z0-9-]{0,127}$`. */
export const MAX_SLUG_LENGTH = 128;

/**
 * The addressing form of a name, derived from {@link normalize} rather than
 * from a second convention — two spellings of one name must not produce two
 * addresses.
 *
 * **A name with no ASCII-sluggable characters still gets an address.** `中文文档`
 * and `!!!` both reduce to nothing under the character class, and returning the
 * empty string would violate the schema CHECK — which surfaces as a failed
 * transaction at the end of an otherwise complete write, on a corpus where CJK
 * entity names are ordinary rather than exotic. The fallback is a digest of the
 * normalized name, so it is stable across runs and distinct per name.
 */
export function slugify(name: string): string {
  const normalized = normalize(name);
  const ascii = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, '');

  if (ascii.length > 0 && /^[a-z0-9]/.test(ascii)) return ascii;

  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  return ascii.length === 0 ? `x-${digest}` : `x-${digest}-${ascii}`.slice(0, MAX_SLUG_LENGTH);
}
