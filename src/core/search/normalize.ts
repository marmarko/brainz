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
 *
 * **The inner loop starts at the haystack's length, not the needle's, and that
 * is a bound rather than an optimisation.** `phrase` here is the *query* — a
 * value the caller chooses the size of — and `haystack` is a page title, which
 * is short. Started at `needle.length` the search is O(needle²) *slices*, each
 * up to needle-length long, so the work grows about cubically in what the caller
 * typed: measured on this repo's own tokenizer, a 10,000-character query costs
 * 235ms, 20,000 costs 1.7s and 40,000 costs 13s — per candidate, per request, on
 * the request path. `arms.ts` used to hide it by raising 54001 before the
 * ranking stage was reached, which stopped being true the moment that became a
 * degradation instead of a refusal; it was never true below the tsquery
 * threshold, where a 40KB query already bought thirteen seconds of CPU.
 *
 * The cap changes no result. `runIndex` returns -1 for any run longer than the
 * haystack — it is the first thing it checks — so every iteration this skips was
 * one that could not have matched. `test/core/search/normalize.test.ts` pins the
 * equivalence over the cases the boost actually ranks on.
 */
export function longestPhraseRun(haystack: string, phrase: string): string[] {
  const needle = tokens(phrase);
  if (needle.length === 0) return [];
  const hay = tokens(haystack);
  if (hay.length === 0) return [];

  let best: string[] = [];
  for (let start = 0; start < needle.length; start += 1) {
    // A run longer than the haystack cannot appear in it.
    const longest = Math.min(needle.length, start + hay.length);
    for (let end = longest; end > start + best.length; end -= 1) {
      const run = needle.slice(start, end);
      if (runIndex(hay, run) >= 0) {
        if (run.length > best.length) best = run;
        break;
      }
    }
  }
  return best;
}

/**
 * Function words that carry no subject.
 *
 * **Read-side vocabulary, which is why it lives here** — two stages need the
 * same list and for the same reason. The title boost must not fire on a run that
 * is entirely grammar ("who is Sam" against "Dana Ilves who she is"); the alias
 * ladder's mention rung must not order pages by which one repeats `does`. A
 * second copy in either place would be the drift this module exists to prevent,
 * one level up from characters.
 *
 * **English only, and that is a stated limitation.** KTD9 makes the FTS
 * configuration a per-tenant provision-time decision, so a Spanish brain wants a
 * Spanish list. It affects a ranking boost and a tie-break, never a fence or a
 * filter, so the failure mode of a missing language is a slightly worse
 * ordering, not a wrong answer.
 */
export const PHRASE_STOPWORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'did', 'do',
  'does', 'for', 'from', 'has', 'have', 'he', 'her', 'his', 'how', 'i', 'in',
  'is', 'it', 'its', 'me', 'my', 'not', 'of', 'on', 'or', 'our', 's', 'she',
  'that', 'the', 'their', 'them', 'they', 'this', 'to', 'was', 'we', 'were',
  'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'will', 'with', 'you',
  'your',
]);

/**
 * The cheapest stand-in for stemming that needs no language: two tokens share a
 * stem when one is the other's prefix at four characters or more.
 *
 * `suppliers`/`supplier` and `want`/`wants` pair; `list`/`listen` do not. It is
 * used only to *order* candidates inside one ladder rung — never to decide
 * whether a row is returned — so its failure mode is a worse ordering inside a
 * tier, not a wrong answer. The tenant FTS configuration (KTD9) is where real
 * stemming lives; this is the part that has to work without one.
 */
export function stemMatch(a: string, b: string): boolean {
  return a === b || (a.length >= 4 && b.startsWith(a)) || (b.length >= 4 && a.startsWith(b));
}

export function phraseOverlap(haystack: string, phrase: string): number {
  const needle = tokens(phrase);
  if (needle.length === 0) return 0;
  return longestPhraseRun(haystack, phrase).length / needle.length;
}
