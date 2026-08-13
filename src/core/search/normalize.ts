/**
 * Stage 1 of the retrieval stack: the shared normalizer, seen from the read
 * side, plus the read-side vocabulary the later stages compare with.
 *
 * **This module deliberately contains no normalizer.** `normalize` and
 * `slugify` are re-exported from `../write/normalize.ts` — the same function
 * objects the write path calls, not a second implementation that agrees today.
 * The plan names drift between the two sides as *the* failure, and drift has no
 * symptom: an alias stored the way a mail client spelled it and looked up the
 * way a keyboard types it simply does not match, with nothing thrown and nothing
 * logged. `test/core/write/normalize.test.ts` scans `src/` for a second
 * `String.normalize('NFKC')` call site; `test/core/search/normalize.test.ts`
 * asserts function *identity* across the seam, which is the half a scan cannot
 * see (two modules can each call the shared one and still diverge in what they
 * do afterwards).
 *
 * **What is genuinely new here is tokenisation, and it belongs to the read
 * side.** The write path produces keys — one normalized string per alias, per
 * title, per dedup comparison. The read path compares *sequences*: the
 * title-phrase boost asks whether a page's title contains the asked phrase in
 * order, the Jaccard dedup layer asks how much two chunks' token sets overlap,
 * and the alias ladder's slug-suffix rung asks whether a trailing token matches
 * a slug. All three need the same tokenisation or they disagree about what a
 * word is, so it is defined once, here, on top of the shared normalizer rather
 * than beside it.
 *
 * **Why the token character class is what it is.** `sokonkwo@example.com`,
 * `K&Q` and `3.4.1` are all single tokens in the fixture corpus and all three
 * are alias-table or title keys. A tokeniser that split on `@`, `&` or `.`
 * turns each into fragments that match nothing — the alias floor is
 * all-or-nothing at fourteen queries, so one such split is a failed gate. The
 * class therefore keeps those characters *inside* a token and strips them only
 * at the edges, where they are punctuation rather than spelling.
 */

export {
  MAX_SLUG_LENGTH,
  NORMALIZER_VERSION,
  normalize,
  slugify,
} from '../write/normalize.ts';

import { normalize } from '../write/normalize.ts';

/**
 * The asked text, as a key.
 *
 * A one-line alias for {@link normalize} that exists so read-side call sites
 * read as what they are doing. It is the same function underneath; there is no
 * query-specific folding, because a query folded differently from the alias it
 * is looking for is the drift this module exists to prevent.
 */
export function normalizeQuery(text: string): string {
  return normalize(text);
}

/**
 * Characters that stay *inside* a token: the ones that are part of how a name,
 * an address or a version number is spelled rather than how a sentence is
 * punctuated.
 */
const TOKEN_BREAK = /[^\p{L}\p{N}@.&+#_-]+/gu;

/** The same characters, where they appear at an edge and are therefore noise. */
const EDGE_PUNCTUATION = /^[@.&+#_-]+|[@.&+#_-]+$/g;

/**
 * The normalized text as a token sequence.
 *
 * Order is preserved because two of the three consumers care about it, and
 * duplicates are preserved because the third (Jaccard) does its own set
 * conversion — a tokeniser that de-duplicated for it would silently change what
 * the phrase consumers see.
 */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of normalize(text).split(TOKEN_BREAK)) {
    const trimmed = raw.replace(EDGE_PUNCTUATION, '');
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

/** Where `needle` occurs as a contiguous run inside `haystack`, or -1. */
function runIndex(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) return -1;
  outer: for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return start;
  }
  return -1;
}

/**
 * Contiguous-subsequence containment — a *phrase* test, not a bag-of-words one.
 *
 * The distinction is the whole reason the title-phrase boost is a separate stage
 * from the keyword arm. Twenty of U7's queries are title substrings whose decoy
 * page repeats the same words more densely than the titled page does; a boost
 * that fired on unordered word overlap would fire on the decoy too and the stage
 * would be a second keyword arm under another name.
 */
export function containsPhrase(haystack: string, phrase: string): boolean {
  return runIndex(tokens(haystack), tokens(phrase)) >= 0;
}

/**
 * How much of `phrase` appears in `haystack` as one unbroken run, from 0 to 1.
 *
 * The graded form of {@link containsPhrase}, for the boost's partial credit: a
 * query that is three quarters of a title should outrank one that shares two
 * scattered words with it, and a binary containment test cannot express that.
 * The longest *run* rather than the total overlap, for the same reason
 * containment is contiguous.
 */
export function longestPhraseRun(haystack: string, phrase: string): string[] {
  const needle = tokens(phrase);
  if (needle.length === 0) return [];
  const hay = tokens(haystack);
  if (hay.length === 0) return [];

  let best: string[] = [];
  for (let start = 0; start < needle.length; start += 1) {
    for (let end = needle.length; end > start + best.length; end -= 1) {
      const run = needle.slice(start, end);
      if (runIndex(hay, run) >= 0) {
        if (run.length > best.length) best = run;
        break;
      }
    }
  }
  return best;
}

export function phraseOverlap(haystack: string, phrase: string): number {
  const needle = tokens(phrase);
  if (needle.length === 0) return 0;
  return longestPhraseRun(haystack, phrase).length / needle.length;
}
