/**
 * Deterministic fact extraction, on the write path.
 *
 * **Why it is here and not in U8 or U11.** R6's blocking extraction-recall
 * floor is graded by U7 against a gold key that already exists, and
 * `evals/fixtures/extraction.ts` assigns every fact in that key to a *rule
 * family* — naming the families up front is what lets an extractor written
 * later be graded by a key written earlier. U8's format parsers feed this
 * module rather than owning extraction themselves, so there is one extractor
 * and one set of families to grade.
 *
 * **The families are shared vocabulary, so they are declared here and pinned by
 * a test against the eval fixture.** `src/` may not import from `evals/` — the
 * dependency runs the other way — so the guard lives in
 * `test/core/write/extract.test.ts`, which imports both and compares them.
 *
 * **Three properties this file is written to hold.**
 *
 * 1. **Silence beats a guess.** A fabricated fact enters the brain as truth and
 *    every later phase treats it as evidence; a missed one costs recall on one
 *    sentence. So each rule matches a stated shape or declines, and no rule has
 *    a catch-all branch.
 * 2. **Re-extraction is exact.** Facts are stored as statements and nothing
 *    records their structure, so edge reconciliation and supersession both
 *    recover it by re-running {@link extractFromStatement} over a stored
 *    statement. If that disagreed with {@link extractFacts}, a stale edge would
 *    never be removed and a superseding write would insert a second
 *    contradictory fact instead of superseding the first. One rule engine, run
 *    over one sentence, is what makes them agree by construction.
 * 3. **The supersession key is (subject, topic), not the statement.** The frozen
 *    `remember` contract supersedes on "same entity + same kind + similarity
 *    above the threshold + different text", and `fact` carries no entity column
 *    and no kind column — so both halves of that key are derived here.
 *    `works_at`, `joined` and `left` share the `employment` topic precisely so
 *    that "X left acme-example" supersedes "X at acme-example".
 */

import type { Chunk } from './chunker.ts';
import { normalize } from './normalize.ts';

/**
 * The rule families, spelled as `evals/fixtures/extraction.ts` spells them.
 * `model_only` is deliberately absent: it is that fixture's label for a fact
 * needing the model phase, not a rule this extractor can claim.
 */
export const DETERMINISTIC_RULE_FAMILIES = [
  'relation_verb_sentence',
  'role_copula_sentence',
  'location_sentence',
  'currency_amount_sentence',
  'dated_event_sentence',
  'versioned_defect_sentence',
] as const;

export type RuleFamily = (typeof DETERMINISTIC_RULE_FAMILIES)[number];

/**
 * What a rule asserts. Only the first four have a declared edge type in the
 * schema's registry; see `PREDICATE_EDGE_TYPES` in `links.ts` for what happens
 * to the rest, and why promoting one is a schema rung rather than a code edit.
 */
export const PREDICATES = [
  'works_at',
  'left',
  'invested_in',
  'part_of',
  'founded',
  'advises',
  'acquired',
  'based_in',
  'amount',
  'dated_event',
  'defect',
  /** No rule matched. A user's own assertion is still a fact; it simply has no
   * structure, so it implies no edge and can supersede nothing. */
  'assertion',
] as const;

export type Predicate = (typeof PREDICATES)[number];

export interface ExtractedFact {
  /** The user's own sentence, verbatim. Stored as `fact.statement`. */
  readonly statement: string;
  /** Null when no rule matched — which `remember` allows and ingestion does not. */
  readonly family: RuleFamily | null;
  readonly predicate: Predicate;
  /** Surface form of the thing the statement is about. */
  readonly subject: string;
  /** Surface form of what is asserted about it. */
  readonly object: string;
  /**
   * The dimension a later statement can supersede along — the "kind" half of
   * the frozen contract's supersession key. Two facts with the same subject and
   * the same topic and a different object are a change, not a contradiction.
   */
  readonly topic: string;
  /** How sure the rule is. Stored as `fact.confidence`; never null here. */
  readonly confidence: number;
  /** Which chunks stated it. At least one, and more when a page repeats itself. */
  readonly chunkOrdinals: readonly number[];
}

// ---------------------------------------------------------------------------
// Sentence splitting.
// ---------------------------------------------------------------------------

export interface Sentence {
  readonly text: string;
  readonly start: number;
}

/**
 * Is this full stop the end of a sentence, or part of a token?
 *
 * The version-string case is the one that matters and it is not hypothetical:
 * `versioned_defect_sentence` exists to extract "the advisory affects firmware
 * 2.1.0", and a splitter that treats every `.` as a terminator cuts that
 * sentence into "…firmware 2", "1", "0" and the rule can never fire. The whole
 * family scores zero against the gold key with nothing to point at. Initials
 * ("J. Okonkwo") are the same shape one step down.
 */
function endsSentence(text: string, index: number): boolean {
  const before = text[index - 1];
  const after = text[index + 1];
  // 2.1.0, 3.5, 1,000.50 — a digit on both sides is a number, not a stop.
  if (before !== undefined && after !== undefined && /\d/.test(before) && /\d/.test(after)) {
    return false;
  }
  // "J. Okonkwo" — a lone capital before the stop is an initial.
  if (before !== undefined && /[A-Z]/.test(before)) {
    const preceding = text[index - 2];
    if (preceding === undefined || /\s/u.test(preceding)) return false;
  }
  return true;
}

/**
 * Splits text into sentences **without losing a character** — the pieces
 * concatenate back to the input. A splitter that trims produces statements that
 * no longer appear in the chunk they came from, which breaks the citation the
 * write path records.
 */
export function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  let start = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? '';
    if (!/[.!?。！？\n]/.test(character)) continue;
    if (character === '.' && !endsSentence(text, index)) continue;
    // A terminator followed by more terminators or whitespace ends the sentence
    // after the run, so "happened! " keeps its exclamation mark and its space.
    let end = index + 1;
    while (end < text.length && /[.!?。！？\s]/.test(text[end] ?? '')) end += 1;
    sentences.push({ text: text.slice(start, end), start });
    start = end;
    index = end - 1;
  }

  if (start < text.length) sentences.push({ text: text.slice(start), start });
  return sentences;
}

// ---------------------------------------------------------------------------
// The rules.
// ---------------------------------------------------------------------------

/**
 * A named thing: a run of capitalised words, with lowercase connectors allowed
 * inside it ("Bank of America") but never at either end. Deliberately
 * conservative — an over-eager name pattern produces subjects that are sentence
 * fragments, and those become entities.
 */
const NAME = String.raw`[A-Z][\p{L}\p{N}&.'’-]*(?:[ ](?:of|the|and|for|de|van|von|da)?[ ]?[A-Z][\p{L}\p{N}&.'’-]*)*`;

const ROLE = String.raw`[a-z][a-z ]{2,40}?`;

/** Verbs that assert a relation between two named things. */
const RELATION_VERBS: ReadonlyArray<readonly [RegExp, Predicate, string]> = [
  [/\b(?:co-)?founded\b/, 'founded', 'founding'],
  [/\badvises\b|\bis an adviser to\b|\bis an advisor to\b/, 'advises', 'advisory'],
  [/\binvested in\b|\bled the round in\b/, 'invested_in', 'investment'],
  [/\bacquired\b/, 'acquired', 'ownership'],
  [/\bis part of\b|\bis a subsidiary of\b|\bis a division of\b/, 'part_of', 'composition'],
  [/\bjoined\b/, 'works_at', 'employment'],
  [/\bleft\b|\bresigned from\b|\bdeparted\b/, 'left', 'employment'],
];

const MONTH =
  '(?:january|february|march|april|may|june|july|august|september|october|november|december)';

const CURRENCY = String.raw`(?:€|\$|£|euros?|dollars?|pounds?|usd|eur|gbp)`;

/**
 * The surface form of a named thing, with the sentence's own punctuation taken
 * off it. Without this, "Verdant Systems." and "Verdant Systems" are two
 * entities — the trailing full stop belongs to the sentence, not the name, and
 * it survives the normalizer, which folds punctuation shapes but does not
 * delete them. The cost is that "Acme Inc." is filed as "Acme Inc", which is
 * the same decision on both the write and the read side and so matches.
 *
 * **The trailing class also takes an unbalanced quote, and the class is
 * unbalanced quotes rather than possessives.** `NAME` starts `[A-Z]`, so an
 * opening `'` is never captured while the closing one is: *"'AI Systems' is a
 * partner of Anthem."* yielded the subject `AI Systems'`, and `School Wrap
 * Party'` is a quoted phrase rather than a genitive. Somebody looking here for
 * an apostrophe-`s` rule will not find one. The curly form is stripped here and
 * deliberately **not** removed from `NAME`'s own character class, because
 * `normalize` folds U+2019 to ASCII precisely so `O’Brien` and `O'Brien`
 * co-resolve — an apostrophe inside a name is part of it.
 */
function cleanName(surface: string): string {
  return surface.replace(/[\s.,;:!?'’]+$/u, '').replace(/\s+/gu, ' ').trim();
}

interface Rule {
  readonly family: RuleFamily;
  match(sentence: string): Omit<ExtractedFact, 'statement' | 'family' | 'chunkOrdinals'> | null;
}

/**
 * Ordered, and the order is part of the specification: the first rule that
 * matches wins, so a sentence yields at most one fact. Two rules firing on one
 * sentence would make re-extraction ambiguous, which is the property
 * reconciliation and supersession both stand on.
 */
const RULES: readonly Rule[] = [
  {
    // "X is the head of platform at Y", "X is a partner at Y"
    //
    // **The preposition is `at`, and it is the whole rule.** This pattern used
    // to admit `of` and `for` as well, and measured against a production brain
    // that made it the single largest source of wrong knowledge in the system:
    // of 58 sentences it matched, **one** was a job title. The other 57 were
    // `set for` (17 — every recurring calendar entry), `trademark of` and
    // `service mark of` (13 — the legal footer of any commercial mail),
    // `confirmed for` and `scheduled for` (10 — bookings), `part of` and
    // `division of` (4), and assorted prose like `too busy`, `going to the
    // camp` and `increasing the price`. Every one of them was asserted as
    // employment, which is what typed `Android`, `App Store`, `Google Play`,
    // `FICO`, `Discover` and `Glassdoor` as **people** — because `works_at`
    // declares its subject a person and nothing ever looks at the word.
    //
    // `ROLE` is `[a-z][a-z ]{2,40}?`, which is very nearly any lowercase run,
    // so the preposition was carrying the whole burden of deciding what this
    // sentence is about — and `of` and `for` are the prepositions of
    // composition, attribution and scheduling rather than of employment. Both
    // spellings this rule was written for take `at`, which is why narrowing it
    // costs nothing the rule was ever for: "the head of platform **at** Y"
    // still matches, with `head of platform` captured as the role.
    //
    // Measured cost of the narrowing on that corpus: 58 matches become 4, and
    // the one true positive — "Jack Cheng is a senior editor at Every" — is
    // among the four. Three false positives remain (`is meeting at`, `is going
    // to the camp at`, `is hosted at`) and are left standing rather than
    // chased, because a rule that fired on 58 and now fires on 4 has had its
    // failure mode changed in kind, and the next narrowing should be argued
    // from a fresh measurement rather than from this list.
    //
    // Handing `part of` back is the other half: with `of` gone, `relation_verb`
    // finally sees "X is part of Y" and asserts `part_of`, whose slots are
    // **organization to organization**. This rule was intercepting it purely by
    // being first.
    family: 'role_copula_sentence',
    match(sentence) {
      const pattern = new RegExp(
        String.raw`(${NAME})\s+is\s+(?:the|a|an)?\s*(${ROLE})\s+at\s+(${NAME})`,
        'u',
      );
      const found = pattern.exec(sentence);
      if (found === null) return null;
      const [, subject, role, object] = found;
      if (subject === undefined || role === undefined || object === undefined) return null;
      return {
        predicate: 'works_at',
        subject: cleanName(subject),
        object: cleanName(object),
        topic: 'employment',
        confidence: 0.8,
      };
    },
  },
  {
    // "X founded Y", "X invested in Y", "X left Y"
    family: 'relation_verb_sentence',
    match(sentence) {
      for (const [verb, predicate, topic] of RELATION_VERBS) {
        // The verb source is wrapped: several of these are alternations, and an
        // unwrapped `a|b` would split the whole pattern rather than the verb.
        const pattern = new RegExp(
          String.raw`(${NAME})\s+(?:${verb.source})\s+(?:the\s+)?(${NAME})`,
          'u',
        );
        const found = pattern.exec(sentence);
        if (found === null) continue;
        const [, subject, object] = found;
        if (subject === undefined || object === undefined) continue;
        return {
          predicate,
          subject: cleanName(subject),
          object: cleanName(object),
          topic,
          confidence: 0.8,
        };
      }
      return null;
    },
  },
  {
    // "X is based in Y", "X moved to Y"
    family: 'location_sentence',
    match(sentence) {
      const pattern = new RegExp(
        String.raw`(${NAME})\s+(?:is\s+based\s+in|is\s+headquartered\s+in|moved\s+to|relocated\s+to)\s+(${NAME})`,
        'u',
      );
      const found = pattern.exec(sentence);
      if (found === null) return null;
      const [, subject, object] = found;
      if (subject === undefined || object === undefined) return null;
      return {
        predicate: 'based_in',
        subject: cleanName(subject),
        object: cleanName(object),
        topic: 'location',
        confidence: 0.8,
      };
    },
  },
  {
    // "The Halcyon licence is 40000 euro for the year."
    family: 'currency_amount_sentence',
    match(sentence) {
      const pattern = new RegExp(
        String.raw`(${NAME})[^.!?]*?\b((?:${CURRENCY})\s?[\d][\d.,]*|[\d][\d.,]*\s?(?:${CURRENCY}))`,
        'iu',
      );
      const found = pattern.exec(sentence);
      if (found === null) return null;
      const [, subject, amount] = found;
      if (subject === undefined || amount === undefined) return null;
      return {
        predicate: 'amount',
        subject: cleanName(subject),
        object: amount.trim(),
        topic: 'amount',
        confidence: 0.7,
      };
    },
  },
  {
    // "Saltmarsh shipped on 9 April."
    family: 'dated_event_sentence',
    match(sentence) {
      const pattern = new RegExp(
        String.raw`(${NAME})\s+(shipped|signed|launched|released|delivered|closed|announced|completed)\s+on\s+(\d{4}-\d{2}-\d{2}|\d{1,2}\s+${MONTH}|${MONTH}\s+\d{1,2})`,
        'iu',
      );
      const found = pattern.exec(sentence);
      if (found === null) return null;
      const [, subject, verb, date] = found;
      if (subject === undefined || verb === undefined || date === undefined) return null;
      return {
        predicate: 'dated_event',
        subject: cleanName(subject),
        object: date.trim(),
        topic: `event:${verb.toLowerCase()}`,
        confidence: 0.75,
      };
    },
  },
  {
    // "The advisory affects firmware 2.1.0."
    family: 'versioned_defect_sentence',
    match(sentence) {
      if (!/\b(advisory|vulnerability|defect|bug|regression|fixed|patched|affects)\b/i.test(sentence)) {
        return null;
      }
      const version = /\bv?(\d+\.\d+(?:\.\d+)?)\b/.exec(sentence);
      if (version === null) return null;
      const component =
        new RegExp(String.raw`\b([a-z][a-z-]{2,30}|${NAME})\s+v?\d+\.\d+`, 'u').exec(sentence);
      const subject = component?.[1] === undefined ? undefined : cleanName(component[1]);
      if (subject === undefined || version[1] === undefined) return null;
      return {
        predicate: 'defect',
        subject,
        object: version[1],
        topic: `defect:${normalize(version[1])}`,
        confidence: 0.7,
      };
    },
  },
];

/**
 * Every `NAME`-shaped run in `text` that does **not** start at a sentence
 * opening.
 *
 * The one signal that separates a capital a name earned from a capital a
 * sentence gave it for free. `Here is the contact at Capital One.` yields
 * `Capital One` and not `Here`; the same sentence with the words reordered
 * would yield both, which is the corpus saying something different.
 *
 * It lives here rather than in {@link ../write/entity-admission.ts} because it
 * needs this module's own `NAME` and `splitSentences`, and a second copy of
 * `NAME` is exactly the two-ladders failure this module's header warns about:
 * it would agree today and disagree silently after one edit.
 */
export function namesAwayFromSentenceStart(text: string): string[] {
  const found: string[] = [];
  for (const sentence of splitSentences(text)) {
    const opening = sentence.text.search(/\S/);
    if (opening < 0) continue;
    const pattern = new RegExp(NAME, 'gu');
    for (const match of sentence.text.matchAll(pattern)) {
      if (match.index === undefined || match.index <= opening) continue;
      const name = cleanName(match[0]);
      if (name.length > 0) found.push(name);
    }
  }
  return found;
}

/**
 * The whole rule engine over one sentence, and the entry point reconciliation
 * and dedup use to recover structure from a stored statement.
 */
export function extractFromStatement(statement: string): ExtractedFact | null {
  const trimmed = statement.trim();
  if (trimmed.length === 0) return null;
  for (const rule of RULES) {
    const found = rule.match(trimmed);
    if (found !== null) {
      return { ...found, statement: trimmed, family: rule.family, chunkOrdinals: [] };
    }
  }
  return null;
}

/**
 * Every fact a document states, cited back to the chunks that state them.
 *
 * A sentence repeated across chunks — which overlap makes ordinary — produces
 * **one** fact citing both, never two rows the dedup pass then has to reconcile
 * against each other.
 */
export function extractFacts(chunks: readonly Chunk[]): ExtractedFact[] {
  const byStatement = new Map<string, { fact: ExtractedFact; ordinals: Set<number> }>();

  for (const chunk of chunks) {
    for (const sentence of splitSentences(chunk.content)) {
      const found = extractFromStatement(sentence.text);
      if (found === null) continue;
      const key = normalize(found.statement);
      const existing = byStatement.get(key);
      if (existing === undefined) {
        byStatement.set(key, { fact: found, ordinals: new Set([chunk.ordinal]) });
      } else {
        existing.ordinals.add(chunk.ordinal);
      }
    }
  }

  return [...byStatement.values()].map(({ fact, ordinals }) => ({
    ...fact,
    chunkOrdinals: [...ordinals].sort((left, right) => left - right),
  }));
}
