/**
 * Stage 5 — the alias ladder: exact title → alias table → slug suffix.
 *
 * **The rungs are ordered because they are increasingly speculative.** An exact
 * title is a statement about a document the user named; an alias is a statement
 * about an entity somebody (or something) said was the same as another; a slug
 * suffix is a guess that a bare surname means the person whose canonical slug
 * ends with it. Reversing the order is not a tuning choice — it means "Design
 * review notes" is answered by whichever entity has a similar-sounding alias
 * rather than by the page actually titled that.
 *
 * **Two entry points, one policy.** {@link resolveEntities} runs before the arms,
 * because the graph arm cannot fan out without seeds.
 * {@link aliasLadderRanking} runs after fusion, because that is where the plan
 * puts the injection. Both consult the same {@link LadderLookup} and use the
 * same rungs in the same order, so a substrate cannot accidentally resolve
 * differently from the way it injects.
 *
 * **The lookup is injected, and that is the seam between substrates.** On the
 * read path it is a handful of indexed queries against `page.title_tsv`,
 * `entity_alias` and `entity_slug`; in U7's blocking eval it is a map lookup.
 * What must not differ between them is the *policy* — which rung wins, what the
 * resolved entity contributes, in what order — so the policy is here and the
 * lookup is a parameter.
 *
 * **Injection, not promotion.** The ranking this returns is folded into the
 * fused scores with RRF arithmetic (`rrf.ts:foldRanked`), not applied as a
 * multiplier. A multiplier on a fused score of zero is zero, so an exact-title
 * match no arm recalled would score nothing forever — and the alias floor is
 * all-or-nothing at fourteen queries.
 */

import { normalize, normalizeQuery, tokens } from './normalize.ts';

export interface PageRef {
  readonly pageId: string;
  readonly title: string | null;
  /** The page's chunks, in ordinal order. */
  readonly chunkIds: readonly string[];
}

export interface EntityRef {
  readonly entityId: string;
  readonly canonicalName: string;
  readonly slug: string;
}

/**
 * What the ladder needs from a substrate. Every method is synchronous: the read
 * path materialises these lookups before composing, so that the composed stack
 * stays the pure function U7's eval can call.
 */
export interface LadderLookup {
  /** Pages whose normalized title is exactly the normalized query. */
  pagesByTitle(normalizedQuery: string): readonly PageRef[];
  /** Pages whose normalized title contains the query, or is contained by it. */
  pagesTitledContaining(normalizedQuery: string): readonly PageRef[];
  /** Entities whose canonical name or any alias appears in the query. */
  entitiesByName(normalizedQuery: string, queryTokens: readonly string[]): readonly EntityRef[];
  /** Entities whose canonical slug's last segment is one of the query's tokens. */
  entitiesBySlugSuffix(queryTokens: readonly string[]): readonly EntityRef[];
  /** Pages titled exactly with this name — an entity's profile page. */
  pagesTitled(name: string): readonly PageRef[];
  /** Chunks that evidence this entity, best first. */
  evidenceFor(entityId: string): readonly string[];
}

/**
 * The rungs, as a closed set with a weight each.
 *
 * **The weights are the rung order, expressed as a number instead of only as a
 * position.** Position alone is not enough: `foldRanked` decays with rank, so a
 * query that matches no title puts the most speculative rung — an entity's
 * evidence — at rank 1, with the same contribution an exact title match would
 * have had. That is how "what does Tosh want changed" gets answered with the
 * company overview that states where Toshiro works: the ladder resolved
 * correctly and then shouted.
 *
 * So each rung carries a multiplier on the plan's alias weight, and they descend
 * in the order the rungs are tried.
 */
export const LADDER_RUNG_WEIGHTS = {
  /** The user named a document. Nothing in the ladder is more certain. */
  exact_title: 1,
  /** A page titled with an entity the query resolved to. */
  entity_title: 0.85,
  /** A title that contains the query, or is contained by it. */
  title_containing: 0.7,
  /** Chunks that evidence a resolved entity. The most speculative rung. */
  entity_evidence: 0.4,
} as const;

export type LadderRung = keyof typeof LADDER_RUNG_WEIGHTS;

export interface LadderTier {
  readonly rung: LadderRung;
  readonly weight: number;
  /** Best first. Globally de-duplicated: an id appears in its highest rung only. */
  readonly ids: readonly string[];
}

/**
 * Rungs 2 and 3, run before the arms so the graph arm has seeds.
 *
 * The alias rung is tried first and the slug-suffix rung only answers when it
 * found nothing — a bare surname is a guess, and a guess must not compete with a
 * declared alias. Both rungs preserve the lookup's order and de-duplicate, so
 * the seed list is deterministic.
 */
export function resolveEntities(query: string, lookup: LadderLookup): EntityRef[] {
  const normalized = normalizeQuery(query);
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return [];

  const byName = dedupeEntities(lookup.entitiesByName(normalized, queryTokens));
  if (byName.length > 0) return orderByMention(byName, normalized);

  return orderByMention(dedupeEntities(lookup.entitiesBySlugSuffix(queryTokens)), normalized);
}

/**
 * The ladder's chunk injection, as weighted tiers in rung order.
 *
 * `entities` is passed in rather than re-resolved so that the seeds the graph
 * arm fanned out from are exactly the seeds the ladder injects for. Re-resolving
 * here would let the two disagree, which is the silent version of a routing bug.
 */
export function aliasLadderTiers(
  query: string,
  lookup: LadderLookup,
  entities: readonly EntityRef[],
): LadderTier[] {
  const normalized = normalizeQuery(query);
  if (tokens(query).length === 0) return [];

  const seen = new Set<string>();
  const take = (ids: Iterable<string>): string[] => {
    const out: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  };

  const exactTitle: string[] = [];
  for (const page of lookup.pagesByTitle(normalized)) exactTitle.push(...take(page.chunkIds));

  // A page titled with a resolved entity's canonical name, exactly or as a
  // phrase. "K&Q suppliers" resolves the organisation and then wants the page
  // titled *Kettle and Quill supplier list* — which no title rung keyed on the
  // query text can reach, because the query does not contain the entity's name.
  const entityTitle: string[] = [];
  for (const entity of entities) {
    const named: PageRef[] = [
      ...lookup.pagesTitled(entity.canonicalName),
      ...lookup.pagesTitledContaining(normalize(entity.canonicalName)),
    ];
    // Ordered by how well the *rest* of the query matches each title. The entity
    // name says which subject; the remaining words say which of that subject's
    // documents. "K&Q suppliers" resolves the organisation and then has to pick
    // the supplier list out of three pages titled with its name — without this
    // the rung returns them in storage order and the relocation note wins.
    for (const page of rankByResidual(named, query, entity.canonicalName)) {
      entityTitle.push(...take(page.chunkIds));
    }
  }

  const titleContaining: string[] = [];
  for (const page of lookup.pagesTitledContaining(normalized)) {
    titleContaining.push(...take(page.chunkIds));
  }

  const evidence: string[] = [];
  for (const entity of entities) evidence.push(...take(lookup.evidenceFor(entity.entityId)));

  const tiers: LadderTier[] = [
    { rung: 'exact_title', weight: LADDER_RUNG_WEIGHTS.exact_title, ids: exactTitle },
    { rung: 'entity_title', weight: LADDER_RUNG_WEIGHTS.entity_title, ids: entityTitle },
    { rung: 'title_containing', weight: LADDER_RUNG_WEIGHTS.title_containing, ids: titleContaining },
    { rung: 'entity_evidence', weight: LADDER_RUNG_WEIGHTS.entity_evidence, ids: evidence },
  ];

  return tiers.filter((tier) => tier.ids.length > 0);
}

/**
 * The tiers flattened into one ranking, rung by rung.
 *
 * The ordering the tiers imply, for callers that need a plain list — the fused
 * pipeline folds the tiers separately so their weights survive.
 */
export function aliasLadderRanking(
  query: string,
  lookup: LadderLookup,
  entities: readonly EntityRef[],
): string[] {
  return aliasLadderTiers(query, lookup, entities).flatMap((tier) => [...tier.ids]);
}

/**
 * Resolved entities in the order they are mentioned in the query.
 *
 * "Priya R. at Tessellate" resolves two entities, and the question is about the
 * first one. Ordering by matched-key length instead puts the organisation first
 * — it has the longer name — and answers with the fund's memo. Position is the
 * signal that actually tracks which entity the sentence is about.
 */
/**
 * Order pages by the query terms that are *not* the entity's own name.
 *
 * Matching is prefix-based at four characters or more, which is the cheapest
 * stand-in for stemming that does not need a language: `suppliers` and
 * `supplier` share a stem, `list` and `listen` do not share four characters of
 * one being the other's prefix in the direction that matters. It is used only to
 * order one ladder rung — never to decide whether a row is returned — so its
 * failure mode is a worse ordering inside a tier, not a wrong answer.
 */
function rankByResidual(
  pages: readonly PageRef[],
  query: string,
  entityName: string,
): PageRef[] {
  const nameTokens = new Set(tokens(entityName));
  const residual = tokens(query).filter((token) => !nameTokens.has(token));
  if (residual.length === 0 || pages.length < 2) return [...pages];

  const stemMatch = (a: string, b: string): boolean =>
    a === b || (a.length >= 4 && b.startsWith(a)) || (b.length >= 4 && a.startsWith(b));

  return pages
    .map((page, index) => {
      const titleTokens = tokens(page.title ?? '');
      let hits = 0;
      for (const token of residual) {
        if (titleTokens.some((titleToken) => stemMatch(token, titleToken))) hits += 1;
      }
      return { page, hits, index };
    })
    .sort((a, b) => b.hits - a.hits || a.index - b.index)
    .map((entry) => entry.page);
}

function orderByMention(entities: readonly EntityRef[], normalizedQuery: string): EntityRef[] {
  return [...entities]
    .map((entity, index) => {
      const at = normalizedQuery.indexOf(normalize(entity.canonicalName).split(' ')[0] ?? '');
      return { entity, at: at < 0 ? Number.MAX_SAFE_INTEGER : at, index };
    })
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((entry) => entry.entity);
}

/**
 * Which entities a piece of text names, resolved by **longest match**.
 *
 * This is the disambiguation the alias table cannot do on its own. `Sam` is a
 * declared alias of Samantha Okonkwo, and it is also the first token of
 * "Sam Trelawney works at Northwind Analytics." A per-entity containment check
 * — even a token-boundary one — attributes that sentence to Samantha, and the
 * ladder then answers "who is Sam" with a different person's job.
 *
 * So mentions are resolved *competitively*, over one dictionary, the way a
 * dictionary tagger does it: at each position the longest key wins and consumes
 * the tokens it matched. `sam trelawney` beats `sam`, and the shorter alias does
 * not get a second chance at tokens the longer name already claimed.
 *
 * The dictionary is built by the caller from every entity's canonical name and
 * aliases, which is the same data both substrates have.
 */
export interface MentionKey {
  readonly key: string;
  readonly entityId: string;
}

export function mentionsIn(
  text: string,
  dictionary: readonly MentionKey[],
): Set<string> {
  const haystack = tokens(text);
  const found = new Set<string>();
  if (haystack.length === 0) return found;

  // Longest first, so the greedy scan below is a longest match.
  const byLength = [...dictionary]
    .map((entry) => ({ ...entry, parts: tokens(entry.key) }))
    .filter((entry) => entry.parts.length > 0)
    .sort((a, b) => b.parts.length - a.parts.length || (a.key < b.key ? -1 : 1));

  let position = 0;
  while (position < haystack.length) {
    let matched = 0;
    for (const entry of byLength) {
      if (position + entry.parts.length > haystack.length) continue;
      let ok = true;
      for (let offset = 0; offset < entry.parts.length; offset += 1) {
        if (haystack[position + offset] !== entry.parts[offset]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      found.add(entry.entityId);
      matched = entry.parts.length;
      break;
    }
    position += matched > 0 ? matched : 1;
  }

  return found;
}

function dedupeEntities(entities: readonly EntityRef[]): EntityRef[] {
  const seen = new Set<string>();
  const out: EntityRef[] = [];
  for (const entity of entities) {
    if (seen.has(entity.entityId)) continue;
    seen.add(entity.entityId);
    out.push(entity);
  }
  return out;
}
