/**
 * Stage 5 — the alias ladder: exact title → alias table → slug suffix.
 *
 * **Two calls, and the split is forced by the pipeline's own order.** Entity
 * resolution has to happen *before* the arms, because the graph arm needs seed
 * entities to fan out from; the ladder's chunk injection happens *after* fusion,
 * because that is where the plan puts it. Same rungs, same lookup, two entry
 * points — {@link resolveEntities} and {@link aliasLadderRanking}.
 *
 * **The rung order is the test.** A ladder that consulted the alias table first
 * would answer "Design review notes" with whichever entity happens to be called
 * something similar, rather than with the page actually titled that. A ladder
 * that stopped at the first rung would never resolve a nickname. So each block
 * below pins one rung's contribution *and* that the rung above it wins when both
 * match.
 *
 * **Injection, not promotion.** The ladder's output is folded into the fused
 * scores with RRF arithmetic rather than applied as a multiplier, because a
 * multiplier on a fused score of zero is still zero: an exact-title match that
 * neither the vector nor the full-text arm returned would score nothing forever.
 * That is pinned in `rrf.test.ts` (`foldRanked`) and exercised end to end in the
 * floors harness, where the alias floor is all-or-nothing at fourteen queries.
 */

import { describe, expect, test } from 'bun:test';

import {
  aliasLadderRanking,
  resolveEntities,
  type LadderLookup,
} from '../../../src/core/search/alias-hop.ts';
import { normalize } from '../../../src/core/search/normalize.ts';

interface Page {
  readonly pageId: string;
  readonly title: string;
  readonly chunkIds: readonly string[];
  /** The page's body, which only the mention rung reads. */
  readonly text?: string;
}

interface Entity {
  readonly entityId: string;
  readonly canonicalName: string;
  readonly slug: string;
  readonly aliases: readonly string[];
  readonly evidence: readonly string[];
}

/**
 * A lookup over plain arrays. The substrate differs (SQL on the read path,
 * fixture maps in the eval); the *policy* under test is the ladder's, and it
 * lives in one module either way.
 */
function lookupOver(pages: readonly Page[], entities: readonly Entity[]): LadderLookup {
  return {
    pagesByTitle(normalizedQuery) {
      return pages
        .filter((page) => normalize(page.title) === normalizedQuery)
        .map((page) => ({ pageId: page.pageId, title: page.title, chunkIds: page.chunkIds }));
    },
    pagesTitledContaining(normalizedQuery) {
      return pages
        .filter((page) => {
          const title = normalize(page.title);
          return title !== normalizedQuery && (title.includes(normalizedQuery) || normalizedQuery.includes(title));
        })
        .map((page) => ({ pageId: page.pageId, title: page.title, chunkIds: page.chunkIds }));
    },
    entitiesByName(normalizedQuery) {
      return entities
        .filter((entity) =>
          [entity.canonicalName, ...entity.aliases].some((name) => {
            const key = normalize(name);
            return key.length > 0 && (normalizedQuery === key || normalizedQuery.includes(key));
          }),
        )
        .map((entity) => ({
          entityId: entity.entityId,
          canonicalName: entity.canonicalName,
          slug: entity.slug,
        }));
    },
    entitiesBySlugSuffix(queryTokens) {
      const wanted = new Set(queryTokens);
      return entities
        .filter((entity) => {
          const suffix = entity.slug.split('-').pop() ?? '';
          return suffix.length > 2 && wanted.has(suffix);
        })
        .map((entity) => ({
          entityId: entity.entityId,
          canonicalName: entity.canonicalName,
          slug: entity.slug,
        }));
    },
    pagesTitled(name) {
      const key = normalize(name);
      return pages
        .filter((page) => normalize(page.title) === key)
        .map((page) => ({ pageId: page.pageId, title: page.title, chunkIds: page.chunkIds }));
    },
    evidenceFor(entityId) {
      return entities.find((entity) => entity.entityId === entityId)?.evidence ?? [];
    },
    pagesMentioning(entityId) {
      const entity = entities.find((candidate) => candidate.entityId === entityId);
      if (entity === undefined) return [];
      const keys = [entity.canonicalName, ...entity.aliases].map((name) => normalize(name));
      return pages
        .filter((page) => keys.some((key) => key.length > 0 && normalize(page.text ?? '').includes(key)))
        .map((page) => ({
          pageId: page.pageId,
          title: page.title,
          chunkIds: page.chunkIds,
          text: page.text ?? '',
        }));
    },
  };
}

const PAGES: Page[] = [
  { pageId: 'p-retro', title: 'Saltmarsh launch retro', chunkIds: ['p-retro#0', 'p-retro#1'] },
  { pageId: 'p-marcus', title: 'Marcus Vandenberg', chunkIds: ['p-marcus#0', 'p-marcus#1'] },
  { pageId: 'p-noise', title: 'Weekly standup digest', chunkIds: ['p-noise#0'] },
];

const ENTITIES: Entity[] = [
  {
    entityId: 'e-marcus',
    canonicalName: 'Marcus Vandenberg',
    slug: 'marcus-vandenberg',
    aliases: ['Marc', 'MV', 'marcus@example.com'],
    evidence: ['p-kettle#0', 'p-marcus#0'],
  },
  {
    entityId: 'e-sam',
    canonicalName: 'Samantha Okonkwo',
    slug: 'samantha-okonkwo',
    aliases: ['Sam', 'S. Okonkwo', 'sokonkwo@example.com'],
    evidence: ['p-promotion#0', 'p-old-title#0'],
  },
];

const LOOKUP = lookupOver(PAGES, ENTITIES);

describe('rung 1 — exact title', () => {
  test('an exact title match injects that page, in ordinal order', () => {
    const ranked = aliasLadderRanking('Saltmarsh launch retro', LOOKUP, []);
    expect(ranked.slice(0, 2)).toEqual(['p-retro#0', 'p-retro#1']);
  });

  test('typography does not break the match', () => {
    // The whole reason the ladder shares the write path's normalizer.
    const ranked = aliasLadderRanking('“Saltmarsh launch retro”', LOOKUP, []);
    expect(ranked[0]).toBe('p-retro#0');
  });

  test('a query matching no title and no name injects nothing', () => {
    expect(aliasLadderRanking('quarterly widget throughput', LOOKUP, [])).toEqual([]);
  });
});

describe('rung 2 — the alias table', () => {
  test('a nickname resolves to the canonical entity', () => {
    const resolved = resolveEntities('who is MV', LOOKUP);
    expect(resolved.map((entity) => entity.entityId)).toEqual(['e-marcus']);
  });

  test('an address resolves, because the tokeniser keeps it whole', () => {
    expect(resolveEntities('sokonkwo@example.com', LOOKUP).map((e) => e.entityId)).toEqual(['e-sam']);
  });

  test("the resolved entity's canonically-titled page outranks its other evidence", () => {
    // "who is MV" wants the profile page, not the first chunk that mentions him.
    const ranked = aliasLadderRanking('who is MV', LOOKUP, resolveEntities('who is MV', LOOKUP));
    expect(ranked[0]).toBe('p-marcus#0');
    expect(ranked).toContain('p-kettle#0');
    expect(ranked.indexOf('p-marcus#0')).toBeLessThan(ranked.indexOf('p-kettle#0'));
  });

  test('an exact title beats an alias when both match', () => {
    // The rung order, as an assertion rather than as a comment.
    const ranked = aliasLadderRanking(
      'Marcus Vandenberg',
      LOOKUP,
      resolveEntities('Marcus Vandenberg', LOOKUP),
    );
    expect(ranked[0]).toBe('p-marcus#0');
  });
});

describe('rung 3 — slug suffix', () => {
  test('a surname that is a slug suffix resolves when no alias matched', () => {
    const resolved = resolveEntities('vandenberg contract', LOOKUP);
    expect(resolved.map((entity) => entity.entityId)).toEqual(['e-marcus']);
  });

  test('the suffix rung is last: an alias hit wins over a suffix hit', () => {
    const resolved = resolveEntities('Sam vandenberg', LOOKUP);
    expect(resolved[0]?.entityId).toBe('e-sam');
  });
});

describe('the ladder is deterministic and bounded', () => {
  test('no id appears twice', () => {
    const ranked = aliasLadderRanking('Marcus Vandenberg', LOOKUP, resolveEntities('Marcus Vandenberg', LOOKUP));
    expect(new Set(ranked).size).toBe(ranked.length);
  });

  test('the same query always produces the same ranking', () => {
    const once = aliasLadderRanking('who is MV', LOOKUP, resolveEntities('who is MV', LOOKUP));
    const twice = aliasLadderRanking('who is MV', LOOKUP, resolveEntities('who is MV', LOOKUP));
    expect(twice).toEqual(once);
  });

  test('an empty query resolves nothing rather than everything', () => {
    expect(resolveEntities('   ', LOOKUP)).toEqual([]);
    expect(aliasLadderRanking('   ', LOOKUP, [])).toEqual([]);
  });
});
