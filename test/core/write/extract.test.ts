/**
 * Deterministic fact extraction — U4 approach step 1, which puts it here rather
 * than in U8 for a scheduling reason worth restating: R6's blocking
 * extraction-recall floor is scored by U7 against a gold key that already
 * exists, so the extractor that key grades has to exist by the time U6 runs.
 *
 * The first test is the one that makes the rest meaningful. `evals/fixtures/
 * extraction.ts` assigns every fact in the corpus to a **rule family**, and its
 * own header says those families "are U6's to implement; naming them here is
 * what lets U6's extractor be graded against a gold key that predates it." An
 * extractor whose families are spelled differently scores zero against that key
 * while looking correct in isolation — so the two lists are compared directly
 * rather than by eye.
 *
 * The second property under test is **re-extraction determinism**. Facts are
 * stored as statements, and both edge reconciliation and supersession recover
 * structure by re-running the extractor over a stored statement. If
 * `extractFromStatement(fact.statement)` does not reproduce what
 * `extractFacts` produced, a stale edge is never removed and a superseding
 * write silently inserts a second contradictory fact instead.
 */

import { describe, expect, test } from 'bun:test';

import { RULE_FAMILIES } from '../../../evals/fixtures/extraction.ts';
import { chunkDocument } from '../../../src/core/write/chunker.ts';
import {
  DETERMINISTIC_RULE_FAMILIES,
  extractFacts,
  extractFromStatement,
  splitSentences,
} from '../../../src/core/write/extract.ts';
import { normalize } from '../../../src/core/write/normalize.ts';

function factsIn(text: string) {
  return extractFacts(chunkDocument(text));
}

describe('the extractor is graded against a gold key that predates it', () => {
  test('its rule families are exactly the eval fixture families, minus model_only', () => {
    const expected = RULE_FAMILIES.filter((family) => family !== 'model_only');
    expect([...DETERMINISTIC_RULE_FAMILIES].sort()).toEqual([...expected].sort());
  });

  test('model_only is not a family this extractor claims', () => {
    expect((DETERMINISTIC_RULE_FAMILIES as readonly string[]).includes('model_only')).toBe(false);
  });
});

describe('each family fires on the shape it is named for', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['role_copula_sentence', 'Samantha Okonkwo is the head of platform at Verdant Systems.'],
    ['relation_verb_sentence', 'Marcus Fell founded Kettle Works.'],
    ['relation_verb_sentence', 'Tessellate Capital invested in Verdant Systems.'],
    ['location_sentence', 'Kettle Works is based in Lisbon.'],
    ['currency_amount_sentence', 'The Halcyon licence is 40000 euro for the year.'],
    ['dated_event_sentence', 'Saltmarsh shipped on 9 April.'],
    ['versioned_defect_sentence', 'The advisory affects firmware 2.1.0.'],
  ];

  for (const [family, sentence] of cases) {
    test(`${family}: ${sentence}`, () => {
      const facts = factsIn(sentence);
      expect(facts).toHaveLength(1);
      expect(facts[0]?.family).toBe(family as never);
      // The user's own words are what is stored: the statement is the sentence.
      expect(sentence).toContain(facts[0]?.statement ?? '<none>');
    });
  }

  test('prose with no extractable shape yields nothing rather than a guess', () => {
    // A fabricated fact enters the brain as truth and every later phase treats
    // it as evidence — so silence is the correct output here.
    expect(factsIn('It was a reasonably quiet week and nothing much happened.')).toEqual([]);
    expect(factsIn('Thanks — talk tomorrow.')).toEqual([]);
  });
});

describe('a statement round-trips through the extractor', () => {
  test('re-extracting a stored statement reproduces subject, topic and object', () => {
    for (const [, sentence] of [
      ['', 'Samantha Okonkwo is the head of platform at Verdant Systems.'],
      ['', 'Marcus Fell founded Kettle Works.'],
      ['', 'Kettle Works is based in Lisbon.'],
    ] as const) {
      const original = factsIn(sentence)[0];
      expect(original).toBeDefined();
      const again = extractFromStatement(original?.statement ?? '');
      expect(again).toBeDefined();
      expect(again?.subject).toBe(original?.subject ?? '');
      expect(again?.topic).toBe(original?.topic ?? '');
      expect(again?.object).toBe(original?.object ?? '');
      expect(again?.predicate).toBe(original?.predicate ?? ('' as never));
    }
  });
});

describe('the supersession key is subject plus topic, not the whole statement', () => {
  test('a role change keeps the topic and moves the object', () => {
    // The frozen contract's own example: same entity, same kind, different text.
    const before = factsIn('Samantha Okonkwo is the head of platform at Verdant Systems.')[0];
    const after = factsIn('Samantha Okonkwo is the head of platform at Northwind Labs.')[0];
    expect(before?.subject).toBe(after?.subject ?? '');
    expect(before?.topic).toBe(after?.topic ?? '');
    expect(normalize(before?.object ?? '')).not.toBe(normalize(after?.object ?? ''));
  });

  test('joining and leaving share the employment topic', () => {
    const joined = factsIn('Dana Whitlock joined Northwind Labs.')[0];
    const left = factsIn('Dana Whitlock left Northwind Labs.')[0];
    expect(joined?.topic).toBe(left?.topic ?? '');
    expect(joined?.subject).toBe(left?.subject ?? '');
  });

  test('a relocation and an employment change are different topics', () => {
    const moved = factsIn('Kettle Works moved to Porto.')[0];
    const employed = factsIn('Marcus Fell is the founder of Kettle Works.')[0];
    expect(moved?.topic).not.toBe(employed?.topic ?? '');
  });
});

describe('extraction reads whole documents, and records where a fact came from', () => {
  const document = [
    '# Verdant Systems',
    '',
    'Samantha Okonkwo is the head of platform at Verdant Systems.',
    'Tessellate Capital invested in Verdant Systems.',
    '',
    '# Kettle Works',
    '',
    'Marcus Fell founded Kettle Works. Kettle Works is based in Lisbon.',
  ].join('\n');

  test('it finds every stated fact once', () => {
    const facts = factsIn(document);
    expect(facts.map((fact) => fact.family).sort()).toEqual([
      'location_sentence',
      'relation_verb_sentence',
      'relation_verb_sentence',
      'role_copula_sentence',
    ]);
  });

  test('each fact names the chunk it came from', () => {
    const chunks = chunkDocument(document);
    for (const fact of extractFacts(chunks)) {
      expect(fact.chunkOrdinals.length).toBeGreaterThan(0);
      for (const ordinal of fact.chunkOrdinals) {
        expect(chunks[ordinal]?.content).toContain(fact.statement);
      }
    }
  });

  test('the same sentence repeated in two chunks is one fact citing both', () => {
    const repeated = `Marcus Fell founded Kettle Works.\n\n${'Filler prose. '.repeat(200)}\n\nMarcus Fell founded Kettle Works.`;
    const facts = factsIn(repeated);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.chunkOrdinals.length).toBeGreaterThan(1);
  });
});

describe('sentence splitting keeps the text it splits', () => {
  test('the pieces reconstruct the source', () => {
    const source = 'One thing happened. Then another! And a third? 好的。Finally this';
    expect(splitSentences(source).map((piece) => piece.text).join('')).toBe(source);
  });

  test('offsets point back into the source', () => {
    const source = 'Marcus Fell founded Kettle Works. Kettle Works is based in Lisbon.';
    for (const piece of splitSentences(source)) {
      expect(source.slice(piece.start, piece.start + piece.text.length)).toBe(piece.text);
    }
  });
});
