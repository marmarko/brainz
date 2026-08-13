/**
 * The corpus validator, shown rejecting things.
 *
 * A validator that has only ever been called on valid input has not been shown
 * to reject anything, so every test here breaks the corpus in one specific way
 * and asserts the throw. The breakages are chosen to be the ones that would
 * otherwise turn into a *score*: a gold key pointing at a deleted chunk, an
 * answer fenced out of its own query's grant, a dilution group with no reachable
 * member. None of those produce an error at run time. They produce a permanent,
 * silent miss on one query and a floor that is quietly measuring the fixture.
 */

import { test, expect, describe } from 'bun:test';

import { buildCorpus, CORPUS, CORPUS_INPUT, corpusTexts, type CorpusInput } from '../../evals/corpus.ts';
import type { FixturePage, FixtureQuery } from '../../evals/fixtures/types.ts';

/** Structured clone through JSON: the fixture is plain data, so this is faithful. */
function mutate(change: (input: {
  pages: FixturePage[];
  queries: FixtureQuery[];
  entities: CorpusInput['entities'];
  edgeTypes: CorpusInput['edgeTypes'];
  edges: CorpusInput['edges'];
  facts: CorpusInput['facts'];
  contradictions: CorpusInput['contradictions'];
}) => void): () => void {
  return () => {
    const copy = JSON.parse(JSON.stringify(CORPUS_INPUT)) as {
      pages: FixturePage[];
      queries: FixtureQuery[];
      entities: CorpusInput['entities'];
      edgeTypes: CorpusInput['edgeTypes'];
      edges: CorpusInput['edges'];
      facts: CorpusInput['facts'];
      contradictions: CorpusInput['contradictions'];
    };
    change(copy);
    buildCorpus(copy);
  };
}

function firstQuery(queries: FixtureQuery[], predicate: (query: FixtureQuery) => boolean): FixtureQuery {
  const found = queries.find(predicate);
  if (found === undefined) throw new Error('the fixture no longer contains the query this test needs');
  return found;
}

describe('the shipped corpus', () => {
  test('loads, and is not a toy', () => {
    expect(CORPUS.pages.size).toBeGreaterThanOrEqual(50);
    expect(CORPUS.chunks.size).toBeGreaterThanOrEqual(120);
    expect(CORPUS.queries.length).toBeGreaterThanOrEqual(60);
    expect(CORPUS.entities.size).toBeGreaterThanOrEqual(12);
    expect(CORPUS.edges.length).toBeGreaterThanOrEqual(10);
  });

  test('carries the four things the corpus half was asked for', () => {
    const people = [...CORPUS.entities.values()].filter((entity) => entity.type === 'person');
    const organisations = [...CORPUS.entities.values()].filter((entity) => entity.type === 'organization');
    expect(people.length).toBeGreaterThanOrEqual(6);
    expect(organisations.length).toBeGreaterThanOrEqual(5);

    // Temporal facts: at least one superseded chain.
    const superseded = [...CORPUS.facts.values()].filter((fact) => fact.supersededBy !== undefined);
    expect(superseded.length).toBeGreaterThanOrEqual(5);

    // Contradictions: two live facts about the same thing, neither superseded.
    const memo = CORPUS.facts.get('f-series-a-amount-memo');
    const recap = CORPUS.facts.get('f-series-a-amount-recap');
    expect(memo?.supersededBy).toBeUndefined();
    expect(recap?.supersededBy).toBeUndefined();

    // Cross-origin duplicates: at least one group spanning more than one origin.
    const groups = new Map<string, Set<string>>();
    for (const chunk of CORPUS.chunks.values()) {
      if (chunk.dupGroup === undefined) continue;
      const origins = groups.get(chunk.dupGroup) ?? new Set<string>();
      origins.add(chunk.origin);
      groups.set(chunk.dupGroup, origins);
    }
    const crossOrigin = [...groups.values()].filter((origins) => origins.size > 1);
    expect(crossOrigin.length).toBeGreaterThanOrEqual(3);
  });

  test('every question type and every family is populated', () => {
    const types = new Set(CORPUS.queries.map((query) => query.type));
    const families = new Set(CORPUS.queries.map((query) => query.family));
    expect([...types].sort()).toEqual(['context_fenced', 'named_entity', 'relational', 'temporal']);
    expect([...families].sort()).toEqual(['alias', 'dilution', 'general', 'title_substring']);
  });

  test('the context-fenced pairs really are pairs: same text, different grant, different answer', () => {
    const byText = new Map<string, FixtureQuery[]>();
    for (const query of CORPUS.queries) {
      const bucket = byText.get(query.text) ?? [];
      bucket.push(query);
      byText.set(query.text, bucket);
    }
    const pairs = [...byText.values()].filter((bucket) => bucket.length > 1);
    expect(pairs.length).toBeGreaterThanOrEqual(3);

    for (const pair of pairs) {
      const grants = pair.map((query) => [...query.grant].sort().join(','));
      expect(new Set(grants).size).toBe(pair.length);
      const answers = pair.map((query) => [...query.answers].sort().join(','));
      // If both halves had the same answer the pair would be measuring nothing.
      expect(new Set(answers).size).toBe(pair.length);
    }
  });

  test('corpusTexts covers every chunk and every query, and nothing else', () => {
    const texts = corpusTexts(CORPUS);
    expect(texts.size).toBe(CORPUS.chunks.size + CORPUS.facts.size + CORPUS.queries.length);
    for (const id of CORPUS.chunkIds) expect(texts.get(id)?.kind).toBe('chunk');
    for (const query of CORPUS.queries) expect(texts.get(query.id)?.kind).toBe('query');
  });
});

describe('the validator rejects', () => {
  test('a gold answer that points at a chunk which does not exist', () => {
    expect(
      mutate((input) => {
        const query = firstQuery(input.queries, () => true);
        (query as unknown as { answers: string[] }).answers = ['p-does-not-exist#0'];
      }),
    ).toThrow(/answers with missing chunk/);
  });

  test('a gold answer on a soft-deleted page', () => {
    expect(
      mutate((input) => {
        const query = firstQuery(input.queries, () => true);
        (query as unknown as { answers: string[] }).answers = ['p-deleted-old-renewal#0'];
      }),
    ).toThrow(/deleted or quarantined/);
  });

  test('a gold answer on a quarantined page', () => {
    expect(
      mutate((input) => {
        const query = firstQuery(input.queries, () => true);
        (query as unknown as { answers: string[] }).answers = ['p-quarantined-spam#0'];
      }),
    ).toThrow(/deleted or quarantined/);
  });

  test('a gold answer fenced out of its own query grant', () => {
    expect(
      mutate((input) => {
        // A personal-grant query answered by a work-origin chunk: unanswerable
        // forever, and indistinguishable from a retrieval miss.
        const query = firstQuery(input.queries, (candidate) => candidate.grant.includes('personal:files'));
        (query as unknown as { grant: string[] }).grant = ['personal:files'];
        (query as unknown as { answers: string[] }).answers = ['p-windbreak-status#0'];
      }),
    ).toThrow(/outside its own grant/);
  });

  test('a supporting grade outside 1..2', () => {
    expect(
      mutate((input) => {
        const query = firstQuery(input.queries, () => true);
        (query as unknown as { supporting: Record<string, number> }).supporting = { 'p-verdant-overview#0': 3 };
      }),
    ).toThrow(/supporting grades are 1 or 2/);
  });

  test('a chunk graded both as an answer and as supporting', () => {
    expect(
      mutate((input) => {
        const query = firstQuery(input.queries, () => true);
        const answer = query.answers[0];
        if (answer === undefined) throw new Error('query has no answer to duplicate');
        (query as unknown as { supporting: Record<string, number> }).supporting = { [answer]: 2 };
      }),
    ).toThrow(/both as an answer and as supporting/);
  });

  test('a dilution query requiring a group with no live member inside its grant', () => {
    expect(
      mutate((input) => {
        const query = firstQuery(input.queries, (candidate) => candidate.family === 'dilution');
        // Narrow the grant to one origin the required groups do not live in.
        (query as unknown as { grant: string[] }).grant = ['personal:calendar'];
      }),
    ).toThrow(/outside its own grant|no live member inside its grant/);
  });

  test('a dilution query with only one required group', () => {
    expect(
      mutate((input) => {
        const query = firstQuery(input.queries, (candidate) => candidate.family === 'dilution');
        (query as unknown as { requiredGroups: string[] }).requiredGroups = ['dup-advisory'];
      }),
    ).toThrow(/at least two distinct duplicate groups/);
  });

  test('required groups on a query that is not a dilution probe', () => {
    expect(
      mutate((input) => {
        const query = firstQuery(input.queries, (candidate) => candidate.family === 'general');
        (query as unknown as { requiredGroups: string[] }).requiredGroups = ['dup-advisory'];
      }),
    ).toThrow(/not in the dilution family/);
  });

  test('a duplicate group that no query probes — the orphan direction', () => {
    expect(
      mutate((input) => {
        for (const query of input.queries) {
          if (query.family !== 'dilution') continue;
          (query as unknown as { requiredGroups: string[] }).requiredGroups = (query.requiredGroups ?? []).filter(
            (group) => group !== 'dup-advisory',
          );
        }
      }),
    ).toThrow(/at least two distinct duplicate groups|no query probes/);
  });

  test('an edge type whose inverse is not involutive', () => {
    expect(
      mutate((input) => {
        const edgeType = input.edgeTypes.find((candidate) => candidate.type === 'invested_in');
        if (edgeType === undefined) throw new Error('the fixture no longer declares invested_in');
        (edgeType as unknown as { inverse: string }).inverse = 'works_at';
      }),
    ).toThrow(/not involutive/);
  });

  test('an edge with no supporting fact', () => {
    expect(
      mutate((input) => {
        const edge = input.edges[0];
        if (edge === undefined) throw new Error('the fixture has no edges');
        (edge as unknown as { factIds: string[] }).factIds = [];
      }),
    ).toThrow(/no supporting fact/);
  });

  test('a fact superseded by one that predates it', () => {
    expect(
      mutate((input) => {
        const fact = input.facts.find((candidate) => candidate.id === 'f-sam-title-current');
        if (fact === undefined) throw new Error('the fixture no longer carries f-sam-title-current');
        (fact as unknown as { validFrom: string }).validFrom = '2000-01-01';
      }),
    ).toThrow(/older than it/);
  });

  test('a user-declared alias carrying a confidence score', () => {
    expect(
      mutate((input) => {
        const entity = input.entities.find((candidate) => candidate.id === 'samantha-okonkwo');
        const alias = entity?.aliases.find((candidate) => candidate.source === 'user');
        if (alias === undefined) throw new Error('the fixture no longer carries a user alias');
        (alias as unknown as { confidence: number }).confidence = 0.9;
      }),
    ).toThrow(/a declaration is not an inference/);
  });

  test('an inferred alias with no confidence score', () => {
    expect(
      mutate((input) => {
        const entity = input.entities.find((candidate) => candidate.id === 'samantha-okonkwo');
        const alias = entity?.aliases.find((candidate) => candidate.source === 'inferred');
        if (alias === undefined) throw new Error('the fixture no longer carries an inferred alias');
        delete (alias as unknown as { confidence?: number }).confidence;
      }),
    ).toThrow(/no usable confidence/);
  });

  test('a query with no mechanisms — an unaudited query', () => {
    expect(
      mutate((input) => {
        const query = firstQuery(input.queries, () => true);
        (query as unknown as { mechanisms: string[] }).mechanisms = [];
      }),
    ).toThrow(/names no mechanism/);
  });

  test('a query with no substantive answerability note', () => {
    expect(
      mutate((input) => {
        const query = firstQuery(input.queries, () => true);
        (query as unknown as { evidence: string }).evidence = 'because';
      }),
    ).toThrow(/no substantive answerability note/);
  });

  test('the removal of the soft-deleted page, which would leave R12 unexercised', () => {
    expect(
      mutate((input) => {
        input.pages = input.pages.filter((page) => page.deletedAt === undefined);
      }),
    ).toThrow(/no soft-deleted page/);
  });

  test('the removal of the quarantined page', () => {
    expect(
      mutate((input) => {
        input.pages = input.pages.filter((page) => page.quarantinedAt === undefined);
      }),
    ).toThrow(/no quarantined page/);
  });
});

describe('relevanceFor and visibleTo', () => {
  test('asking for a gold key that does not exist throws rather than returning empty', () => {
    expect(() => CORPUS.relevanceFor('q-was-never-authored')).toThrow(/no gold key/);
  });

  test('visibility excludes deleted, quarantined, and out-of-grant chunks', () => {
    const visible = new Set(CORPUS.visibleTo(['work:mail']));
    expect(visible.has('p-halcyon-renewal-2026#0')).toBe(true);
    expect(visible.has('p-deleted-old-renewal#0')).toBe(false); // deleted, and work:mail
    expect(visible.has('p-quarantined-spam#0')).toBe(false); // quarantined
    expect(visible.has('p-saltmarsh-retro#0')).toBe(false); // personal:files
  });

  test('an empty grant is refused, not treated as "everything"', () => {
    expect(() => CORPUS.visibleTo([])).toThrow(/empty grant/);
  });
});
