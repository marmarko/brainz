/**
 * The admission fence: what may become an entity, and what may not.
 *
 * A brain that holds a person called `Here` holds it because a model wrote the
 * sentence *"Here is the contact at Capital One."* and the deterministic rule
 * extractor — written for clean parsed assertions — was then run over that
 * prose to decide who the brain now knows. `NAME` (`extract.ts`) is
 * `[A-Z][…]*`, so the first capital in a sentence qualifies; `PREDICATE_LINKS`
 * types the subject from the *rule slot* rather than from the word, so `Here`
 * became a **person**; and the only content check between that match and the
 * `INSERT` was `if (key.length === 0) throw`. Measured on the production
 * corpus that produced this module: 2,173 of 2,255 live facts are
 * `model_derived`, so the extractor now runs at a 26:1 ratio over prose it was
 * never graded on.
 *
 * **This is a fence, not a filter, and the difference is the whole design.** It
 * is consulted inside {@link resolveOrCreateEntities} *after* the name has
 * failed to resolve and *before* the row is created. A name that already
 * resolves is never asked about. That placement is what makes the following
 * true rather than hoped for:
 *
 *   * **It can never remove anything.** A live `rule_derived` edge has two
 *     existing endpoints, existing endpoints always resolve, and a resolving
 *     endpoint is always admitted — so no edge this fence touches can fall out
 *     of the projection and be tombstoned. The failure mode a name-filter
 *     applied at match time would have had is not available here: a real
 *     employer whose name the vocabulary happens to contain (`Indeed` is one,
 *     in this brain) would have had its graph silently deleted every cycle
 *     forever, and nothing would have errored.
 *   * **The vocabulary is safe to grow.** Rule 4 tests that *every* token is a
 *     function word, not that the first one is. Under a first-token test,
 *     adding `given` kills `Given Imaging`, `best` kills `Best Buy`, `will`
 *     kills `Will Smith`. Under an all-tokens test a new token can only ever
 *     kill names composed entirely of function words. That is the stopping
 *     rule; without it, every added word needs its own sensitivity run.
 *
 * **The unknown reads *open*, deliberately — the opposite direction from
 * {@link ../../ingest/junk.ts}'s, and for the opposite reason.** Junk's unknown
 * is a whole mail source, so reading it as junk loses a corpus. This unknown is
 * a single unresolved name that the next cycle re-decides against a wider
 * corpus, so the evidence door (§{@link corpusEvidence}) can only ever *clear*
 * a name and never refuse one. A false admit costs one junk row, which is
 * visible on the roster and forgettable. A false refuse costs a real name
 * nobody can see is missing.
 *
 * **What it deliberately cannot do**, so the next reader does not expect it to:
 *
 *   * **Fix a type.** `Android`, `App Store`, `Google Play` and `Discover` are
 *     filed as *people* and this changes none of them. `entity_type` is written
 *     only at INSERT, `findEntitiesByName` has no type predicate, and the type
 *     is part of `mergeEntitiesByRule`'s bucket key — so writing `Android` as an
 *     organization creates a *second* row rather than repairing the first. The
 *     cause is upstream anyway: `ROLE` matches the word `part`, so `role_copula`
 *     intercepts every copula spelling of `part_of` and re-asserts it as
 *     `works_at`, whose subject slot is `person`. Pinned as a `test.failing`.
 *   * **Catch junk that is shaped like a name.** `PS1`, `XXXXX2285` (a masked
 *     account number), `GmbH`, `IVe Systems` (a sentence-cased *I've*) and
 *     `Eric Dargelies and Marko` all admit. Each is a one-row class, and a rule
 *     per row is the treadmill rule 4 exists to stop.
 *   * **Merge anything.** Six spellings of Anthem, `Google Inc`/`Google LLC`,
 *     `X`/`X Corp` are each individually a fine name.
 *
 * The measured cost of every constant is stated at its definition. Nothing
 * below is an estimate: the predicate was run over the 84 production names and
 * an 83-name known-good corpus before it was written down.
 */

// The fence borrows the extractor's own `NAME` through
// {@link namesAwayFromSentenceStart} rather than restating it: a second copy of
// that pattern would agree today and disagree silently after one edit.
import { namesAwayFromSentenceStart } from './extract.ts';
import { normalize } from './normalize.ts';

/** Two bands, and no `hold`. */
export type Admission = 'admit' | 'refuse';

export interface NameVerdict {
  readonly verdict: Admission;
  /** Which rules fired, for the counters {@link ReconcileResult} carries. */
  readonly signals: readonly string[];
}

/**
 * Names the corpus states away from a sentence opening, by normalize key.
 *
 * The one signal that separates a capital a name earned from a capital a
 * sentence gave it for free.
 */
export interface NameEvidence {
  readonly seenAwayFromStart: ReadonlySet<string>;
}

/**
 * Alphanumerics only, after punctuation is stripped.
 *
 * The argument is not borrowed from the read surfaces — `reads.ts` and
 * `assemble.ts` decline to do *fuzzy recall* on a short name and still return
 * the entity; the roster and `lookupEntity` have no floor at all. This declines
 * to *create* one. `NAME` begins `[A-Z]`, so a single capital matches and prose
 * supplies `A`, `I`, `We` and `Mr` constantly.
 *
 * **Measured cost: `GE`, `HP`, `3M`, `H&M`, `A&E`** are never auto-created —
 * note that the last two are exactly the `&` that `NAME` was widened to admit.
 * Once such a row exists by any route it resolves forever.
 */
const MIN_NAME_CHARACTERS = 3;

/**
 * Weekdays, months and the deictic day words.
 *
 * Both halves are already spelled elsewhere in the tree — months at
 * `extract.ts`'s `MONTH`, weekdays at `src/core/search/intent.ts` — because a
 * date is a thing the extractor already knows it is looking at. The production
 * corpus nevertheless created all twelve months and four weekdays as
 * *organizations*, through the `based_in` slot of sentences like *"Lunch moved
 * to Thursday."*
 *
 * **Measured cost:** a new single-token entity genuinely named a weekday or
 * month. Bounded by the arity guard — `June Smith`, `Friday Harbor` and `Black
 * Friday Inc` all admit. A person actually called June is the disclosed
 * casualty: English capitalises these mid-sentence everywhere, so no corpus
 * signal can clear a bare `June` and the door is not offered here.
 */
const CALENDAR_WORDS: ReadonlySet<string> = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'today', 'tomorrow', 'yesterday', 'tonight', 'weekday', 'weekend',
]);

/**
 * A hyphenated adjective, by known suffix.
 *
 * **Narrowed from `^[A-Z][A-Za-z]*-[a-z][a-z-]*$` by measurement**, which was
 * far broader than its name and refused `Anne-marie`, `Jean-luc`, `Wal-mart`,
 * `Mercedes-benz`, `Hewlett-packard`, `E-trade` and `X-ray`. That matters more
 * than it looks: this corpus has demonstrated case corruption — `IVe Systems`
 * is a sentence-cased `I've` that reached the extractor intact — and a
 * sentence-cased `Mercedes-benz` is the same damage one step over.
 *
 * **Measured cost with the suffix list: zero across the known-good corpus.**
 */
const ADJECTIVAL_COMPOUND =
  /^[\p{L}\p{N}&.']+-(?:powered|based|driven|enabled|focused|facing|backed|owned|led|ready|friendly|specific|related|only|like|free|heavy|centric|native|first|style|ish)$/u;

/**
 * Words that cannot compose a name **on their own**.
 *
 * Deliberately **not** `PHRASE_STOPWORDS` (`src/core/search/normalize.ts`),
 * ruled out by its own docstring: it *"affects a ranking boost and a tie-break,
 * never a fence or a filter, so the failure mode of a missing language is a
 * slightly worse ordering, not a wrong answer."* Promoting that list to a
 * write-side fence makes a missing language a wrong answer, which is a
 * different contract than the one it was written under.
 *
 * **Measured cost across 83 known-good names: zero.** `Best Buy`, `Yes Bank`,
 * `Now Foods`, `Given Imaging`, `Will Smith`, `Hello Fresh`, `Dear Media`,
 * `This American Life`, `Here Technologies`, `Indeed Inc`, `Every Inc`, `That
 * Game Company`, `The Beatles`, `All Nippon Airways`, `First Republic` and
 * `Bank of America` all admit, because every one of them contains a content
 * word. The disclosed casualty class is single-token brands that are *purely*
 * function words — `Indeed`, `Every`, `Here` alone — which is precisely what
 * the evidence door exists for.
 */
const FUNCTION_WORDS: ReadonlySet<string> = new Set([
  // Prepositions.
  'in', 'on', 'at', 'of', 'to', 'from', 'with', 'into', 'onto', 'about', 'after',
  'before', 'during', 'under', 'over', 'per', 'via', 'within', 'without',
  'across', 'among', 'between', 'through', 'toward', 'towards', 'upon',
  'regarding', 'concerning', 'following', 'despite',
  // Determiners and quantifiers.
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'each', 'every', 'all',
  'any', 'some', 'no', 'none', 'both', 'either', 'neither', 'much', 'many',
  'few', 'several', 'other', 'another', 'such', 'same', 'own',
  // Pronouns.
  'i', 'me', 'my', 'mine', 'myself', 'we', 'us', 'our', 'ours', 'ourselves',
  'you', 'your', 'yours', 'yourself', 'yourselves', 'he', 'him', 'his',
  'himself', 'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'they',
  'them', 'their', 'theirs', 'themselves', 'who', 'whom', 'whose', 'which',
  'what', 'someone', 'somebody', 'something', 'anyone', 'anybody', 'anything',
  'everyone', 'everybody', 'everything', 'nobody', 'nothing', 'one', 'ones',
  // Conjunctions.
  'and', 'or', 'but', 'nor', 'so', 'yet', 'because', 'although', 'though',
  'while', 'whereas', 'if', 'unless', 'since', 'until', 'whether', 'than', 'as',
  // Copulas, auxiliaries and modals.
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did',
  'done', 'have', 'has', 'had', 'having', 'will', 'would', 'shall', 'should',
  'can', 'could', 'may', 'might', 'must',
  // Wh- words and pro-adverbs.
  'here', 'there', 'where', 'when', 'why', 'how', 'then', 'now', 'thus', 'hence',
  // Discourse adverbs.
  'also', 'too', 'indeed', 'however', 'therefore', 'moreover', 'furthermore',
  'otherwise', 'meanwhile', 'nevertheless', 'nonetheless', 'likewise',
  'instead', 'again', 'still', 'just', 'only', 'even', 'ever', 'never',
  'always', 'perhaps', 'maybe', 'yes', 'not',
  // The openers email prose is made of.
  'attached', 'forwarded', 'sent', 'please', 'thanks', 'hi', 'hello', 'dear',
  'best', 'regards',
]);

/**
 * Prepositions that open a clause rather than a name.
 *
 * **Trimmed by measurement** from the full preposition set: `on at from with
 * into to over under` were removed after they refused `On Semiconductor`, `On
 * Deck Capital`, `At Home Group`, `From Software`, `With Intelligence`, `Into
 * the Gloss` and `To The Stars` — seven real brands for one caught row.
 *
 * **This rule has the worst ratio in the set and is flagged as such**: on the
 * production corpus it earns exactly one row (`In California Anthem Blue
 * Cross`) and its measured residual cost is `Per Scholas`, `Via
 * Transportation`, `In Good Company` and `Through Line`. Both of its jobs are
 * door-clearable, and `refusedBySignal` is how an operator decides whether to
 * keep it. `normalize` does not split on hyphens or `&`, so `In-N-Out Burger`
 * and `AT&T` tokenise as single tokens and survive.
 */
const NAME_MAY_NOT_OPEN_WITH: ReadonlySet<string> = new Set([
  'in', 'of', 'per', 'via', 'after', 'before', 'during', 'within', 'without',
  'across', 'among', 'between', 'through', 'upon', 'regarding', 'concerning',
  'following', 'despite',
]);

/**
 * Distinct statements that must state a name away from a sentence opening
 * before the door clears it.
 *
 * Two rather than one because the door's failure direction is admitting: a
 * single quoted subject line is not the corpus asserting anything.
 */
export const EVIDENCE_THRESHOLD = 2;

/**
 * Whether a name that does not already resolve may be created.
 *
 * `evidence === undefined` is the strict reading, and it is what the write path
 * gets before it has a corpus to consult.
 */
export function admitEntityName(surface: string, evidence?: NameEvidence): NameVerdict {
  const signals: string[] = [];
  const key = normalize(surface);
  const parts = key.split(' ').filter((part) => part.length > 0);
  const first = parts[0] ?? '';
  const cleared = evidence?.seenAwayFromStart.has(key) ?? false;

  // 1. A one- or two-character surface is a substring, an initial or a stray capital.
  if (surface.replace(/[^\p{L}\p{N}]/gu, '').length < MIN_NAME_CHARACTERS) {
    signals.push('too_short');
  }

  // 2. A bare weekday or month. Single token only.
  if (parts.length === 1 && CALENDAR_WORDS.has(first)) signals.push('calendar_word');

  // 3. A hyphenated adjective, by known suffix.
  if (ADJECTIVAL_COMPOUND.test(key)) signals.push('adjectival_compound');

  // 4. EVERY token is a function word. Door-clearable.
  if (!cleared && parts.length > 0 && parts.every((part) => FUNCTION_WORDS.has(part))) {
    signals.push('function_words_only');
  }

  // 5. A multi-token name opening with a clause preposition. Door-clearable.
  if (!cleared && parts.length > 1 && NAME_MAY_NOT_OPEN_WITH.has(first)) {
    signals.push('opens_with_a_preposition');
  }

  return { verdict: signals.length > 0 ? 'refuse' : 'admit', signals };
}

/**
 * The evidence door, built in memory from statements the caller already holds.
 *
 * **Name-keyed, not token-keyed**, which is what closes the poisoning hazard: a
 * quoted subject line *"Re: Here is your statement."* clears the key `here is
 * your statement`, not `here`. The residual, stated: a corpus that twice states
 * an exact junk name away from a sentence opening re-admits it. In an
 * email-derived brain that is possible rather than adversarial, and it is the
 * open direction this module chose on purpose.
 *
 * Zero round trips — one tokenising pass over strings the phase has already
 * read.
 */
export function corpusEvidence(statements: readonly string[]): NameEvidence {
  const counts = new Map<string, Set<number>>();
  statements.forEach((statement, index) => {
    for (const name of namesAwayFromSentenceStart(statement)) {
      const key = normalize(name);
      if (key.length === 0) continue;
      const seen = counts.get(key) ?? new Set<number>();
      seen.add(index);
      counts.set(key, seen);
    }
  });
  const cleared = new Set<string>();
  for (const [key, statementIndexes] of counts) {
    if (statementIndexes.size >= EVIDENCE_THRESHOLD) cleared.add(key);
  }
  return { seenAwayFromStart: cleared };
}
