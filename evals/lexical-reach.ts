/**
 * Which gold answers this corpus lets a **keyed** mechanism find, and which ones
 * only meaning can reach.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS
 * ============================================================================
 *
 * U7's committed vectors are hashed lexical projections, not embeddings
 * (`evals/embeddings.ts` says so at length). Under them the vector arm is a
 * second keyword arm, so a probe whose answer needs *semantic* recall is not
 * being measured — it is being failed for a reason that has nothing to do with
 * the stack. `evals/gates.ts` needs to be able to say "this floor is not yet
 * measurable" without that sentence becoming a place to park an inconvenient
 * failure.
 *
 * So eligibility is **derived from the corpus**, never asserted by hand, and the
 * derivation's job is to *refuse* deferrals rather than to grant them. A gold
 * chunk is **semantically blocked** only when both halves hold:
 *
 *   1. **The query said something about it that no key can see.** Some content
 *      key the query supplied is carried nowhere in the gold's page — not by the
 *      chunk, not by its siblings, not by its title. A semantic arm is the only
 *      thing that could connect it.
 *   2. **What the gold does carry is not distinguishing.** At least `cutoff`
 *      *other* things in the corpus carry every key the gold carries, so any
 *      ranking that puts it inside the cutoff is ordering on something the query
 *      never supplied.
 *
 * **Both halves, and the conjunction is the whole safety property.** Half 1
 * alone excuses any query whose answer paraphrases it — which is most of them.
 * Half 2 alone excuses a probe whose gold ties with a decoy on keys and is
 * separated by exactly the priors the stack exists to apply: "MV roast contract"
 * ties with the profile page naming the same person and the same two words, and
 * the stack ranks it first, so calling it unreachable would be excusing a probe
 * that passes. Together they say: the query supplied evidence this answer cannot
 * match, and the evidence it can match does not pick it out.
 *
 * ============================================================================
 * WHAT COUNTS AS A KEY
 * ============================================================================
 *
 * The three things a zero-LLM mechanism in this stack matches on:
 *
 *   1. **Content tokens.** A query word the text or the title carries — what
 *      both lexical arms rank on. *Content*: function words are excluded through
 *      the same `PHRASE_STOPWORDS` the title boost and the ladder's mention rung
 *      use, and so are the words that spell a resolved entity's name, because
 *      those are already the entity key. This is the same residual split
 *      `intent.ts:resolutionOf` computes — the name says which subject, the rest
 *      says which of that subject's documents.
 *   2. **Entities.** An entity the query names, by canonical name or by any
 *      declared alias, that the chunk names or evidences — what the alias
 *      ladder's rungs and the graph-adjacency boost match on.
 *   3. **Edges.** An entity *pair* joined by an edge **of a type the question
 *      asked about**, where the chunk is the source of a fact naming both
 *      endpoints and one endpoint is an entity the query named — exactly what
 *      the graph arm's relation key matches on (`arms.ts:graphArm`'s `asked`
 *      CTE), keyed on endpoints rather than on a fact→edge link for the reason
 *      that arm gives: the tenant schema has no such link.
 *
 * Key three exists because of two probes that keys one and two get wrong in
 * opposite directions. "Who invested in Verdant Loom" has a gold sharing no
 * content word with the query and a dozen entity-siblings, so without it the
 * criterion calls a probe the graph arm answers every time unreachable. And
 * "where does Sam work" has a gold that *does* carry the edge key — and so does
 * the decoy that beats it, because both facts name the same two endpoints, which
 * is precisely what the fleet's endpoint-keyed rule can and cannot separate.
 * Reading the cue table is what makes the difference visible; a type-blind edge
 * key would hand every neighbour of a resolved entity the same key and blur
 * both cases together.
 *
 * ============================================================================
 * WHY IT SPEAKS THE STACK'S VOCABULARY
 * ============================================================================
 *
 * The claim is about what the *shipped* keyed mechanisms can see, so the words
 * and the function-word list are the shipped ones (`search/normalize.ts`, itself
 * a re-export of the write path's normalizer). A private tokeniser here would be
 * a criterion that defers probes the stack can reach, and it would drift.
 *
 * What this module still refuses to import is any *ranking*: no arm, no fusion,
 * no boost, no score. It reads the corpus and the query and nothing else, so the
 * verdicts it produces are a property of the fixture rather than of whatever the
 * stack happens to do this week — which is what lets an R6a receipt carry them.
 */

import { classifyIntent } from '../src/core/search/intent.ts';
import { PHRASE_STOPWORDS, tokens } from '../src/core/search/normalize.ts';
import type { Corpus, FixtureQuery, OriginContext } from './corpus.ts';

/**
 * A key, rendered so a receipt can print it and a diff can show it change:
 * `token:pilot`, `entity:samantha-okonkwo`, `edge:samantha-okonkwo~verdant-loom`.
 */
export type ReachKey = string;

export interface IsolationVerdict {
  readonly chunkId: string;
  /** The rank the floor's metric reads — 1 for Hit@1, 3 for the dilution metric. */
  readonly cutoff: number;
  /** Keys the query supplied that the gold's whole page cannot match. Sorted. */
  readonly uncovered: readonly ReachKey[];
  /** Keys the gold chunk itself carries, which is what dominance is judged on. */
  readonly carried: readonly ReachKey[];
  /**
   * Duplicate groups (or, ungrouped, chunk ids) of every other visible chunk
   * carrying all of {@link carried}. Sorted; the count is what decides.
   */
  readonly dominators: readonly string[];
  /** True when the query's own evidence could single this chunk out inside `cutoff`. */
  readonly isolable: boolean;
}

interface DictionaryEntry {
  readonly key: string;
  readonly parts: readonly string[];
  readonly entityId: string;
}

/**
 * Competitive longest match over one dictionary of every entity's canonical name
 * and declared aliases — the policy `alias-hop.ts:mentionsIn` applies, for the
 * reason it gives: `sam` is a declared alias of one person and the first token
 * of another's name, and per-entity containment attributes the second's sentence
 * to the first.
 */
function mentions(text: string, dictionary: readonly DictionaryEntry[]): Set<string> {
  const haystack = tokens(text);
  const found = new Set<string>();
  if (haystack.length === 0) return found;

  let position = 0;
  while (position < haystack.length) {
    let matched = 0;
    for (const entry of dictionary) {
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

interface CorpusIndex {
  readonly dictionary: readonly DictionaryEntry[];
  /** entityId → every token that spells it, canonical name or alias. */
  readonly nameTokens: ReadonlyMap<string, ReadonlySet<string>>;
  /** chunkId → entities named by facts it is the source of. */
  readonly evidences: ReadonlyMap<string, ReadonlySet<string>>;
  /** chunkId → `subject~object~type` for every edge a sourced fact names in full. */
  readonly edgePairs: ReadonlyMap<string, ReadonlySet<string>>;
  /** chunkId → the entities its own text and title name. */
  readonly namesByChunk: ReadonlyMap<string, ReadonlySet<string>>;
  /** chunkId → the tokens its own text and title carry. */
  readonly tokensByChunk: ReadonlyMap<string, ReadonlySet<string>>;
  /** pageId → its chunks, in corpus order. */
  readonly chunksByPage: ReadonlyMap<string, readonly string[]>;
}

const indexes = new WeakMap<Corpus, CorpusIndex>();

function indexOf(corpus: Corpus): CorpusIndex {
  const cached = indexes.get(corpus);
  if (cached !== undefined) return cached;

  const dictionary: DictionaryEntry[] = [];
  const nameTokens = new Map<string, Set<string>>();
  for (const [entityId, entity] of corpus.entities) {
    const spelled = new Set<string>();
    for (const name of [entity.canonicalName, ...entity.aliases.map((alias) => alias.alias)]) {
      const parts = tokens(name);
      if (parts.length === 0) continue;
      dictionary.push({ key: parts.join(' '), parts, entityId });
      for (const part of parts) spelled.add(part);
    }
    // The slug's words too: a query naming `verdant-loom` names the entity.
    for (const part of tokens(entityId.replace(/-/g, ' '))) spelled.add(part);
    nameTokens.set(entityId, spelled);
  }
  dictionary.sort((a, b) => b.parts.length - a.parts.length || (a.key < b.key ? -1 : 1));

  const namesByChunk = new Map<string, ReadonlySet<string>>();
  const tokensByChunk = new Map<string, ReadonlySet<string>>();
  const chunksByPage = new Map<string, string[]>();
  for (const chunkId of corpus.chunkIds) {
    const chunk = corpus.chunks.get(chunkId);
    if (chunk === undefined) continue;
    const text = `${chunk.title} ${chunk.content}`;
    namesByChunk.set(chunkId, mentions(text, dictionary));
    tokensByChunk.set(chunkId, new Set(tokens(text)));
    const list = chunksByPage.get(chunk.pageId) ?? [];
    list.push(chunkId);
    chunksByPage.set(chunk.pageId, list);
  }

  const evidences = new Map<string, Set<string>>();
  const edgePairs = new Map<string, Set<string>>();
  for (const [, fact] of corpus.facts) {
    const named = mentions(fact.statement, dictionary);
    if (named.size === 0) continue;
    const pairs: string[] = [];
    for (const edge of corpus.edges) {
      if (named.has(edge.subject) && named.has(edge.object)) {
        pairs.push(`${edge.subject}~${edge.object}~${edge.type}`);
      }
    }
    for (const chunkId of fact.sourceChunks) {
      const into = evidences.get(chunkId) ?? new Set<string>();
      for (const entityId of named) into.add(entityId);
      evidences.set(chunkId, into);
      if (pairs.length === 0) continue;
      const intoPairs = edgePairs.get(chunkId) ?? new Set<string>();
      for (const pair of pairs) intoPairs.add(pair);
      edgePairs.set(chunkId, intoPairs);
    }
  }

  const index: CorpusIndex = {
    dictionary,
    nameTokens,
    evidences,
    edgePairs,
    namesByChunk,
    tokensByChunk,
    chunksByPage,
  };
  indexes.set(corpus, index);
  return index;
}

export interface QueryKeys {
  readonly entities: readonly string[];
  /** Query tokens that are neither grammar nor part of a resolved entity's name. */
  readonly residual: readonly string[];
  /** The edge types the question asked about — `intent.ts`'s cue table, verbatim. */
  readonly relations: readonly string[];
  /**
   * The entity and token keys, rendered. Sorted.
   *
   * Edge keys are **not** here: they are evidence the corpus offers *about* a
   * chunk, not something the query asked for in its own right, and counting one
   * as uncovered would call every non-relational query's answer unreachable.
   */
  readonly keys: readonly ReachKey[];
}

/**
 * What evidence this query supplies, split the way the stack splits it: the
 * names say which subject, the residual says which of that subject's documents.
 */
export function queryKeys(corpus: Corpus, query: FixtureQuery): QueryKeys {
  const index = indexOf(corpus);
  const entities = [...mentions(query.text, index.dictionary)].sort();

  const spelled = new Set<string>();
  for (const entityId of entities) {
    for (const token of index.nameTokens.get(entityId) ?? []) spelled.add(token);
  }

  const residual = [
    ...new Set(
      tokens(query.text).filter((token) => !spelled.has(token) && !PHRASE_STOPWORDS.has(token)),
    ),
  ].sort();

  return {
    entities,
    residual,
    relations: classifyIntent(query.text).relations,
    keys: [
      ...entities.map((entityId) => `entity:${entityId}`),
      ...residual.map((token) => `token:${token}`),
    ].sort(),
  };
}

/** The keys a chunk carries, out of the ones this query supplied. */
export function keysCarriedBy(corpus: Corpus, supplied: QueryKeys, chunkId: string): ReachKey[] {
  const index = indexOf(corpus);
  if (!corpus.chunks.has(chunkId)) return [];

  const carried = new Set<ReachKey>();
  const present = index.tokensByChunk.get(chunkId);
  for (const token of supplied.residual) if (present?.has(token) === true) carried.add(`token:${token}`);

  const names = index.namesByChunk.get(chunkId);
  const evidenced = index.evidences.get(chunkId);
  for (const entityId of supplied.entities) {
    if (names?.has(entityId) === true || evidenced?.has(entityId) === true) {
      carried.add(`entity:${entityId}`);
    }
  }

  for (const pair of index.edgePairs.get(chunkId) ?? []) {
    const [subject, object, edgeType] = pair.split('~');
    if (subject === undefined || object === undefined || edgeType === undefined) continue;
    if (!supplied.relations.includes(edgeType)) continue;
    if (supplied.entities.includes(subject) || supplied.entities.includes(object)) {
      carried.add(`edge:${subject}~${object}`);
    }
  }

  return [...carried].sort();
}

/**
 * Can the query's own evidence single this chunk out inside the top `cutoff`?
 *
 * **Coverage is asked of the page, dominance of the chunk**, and the split is
 * deliberate. "Is there anything in this query that this *document* cannot
 * match" is a question about the document — the paragraph carrying a renewal
 * price is routinely not the paragraph naming the person asked about, and
 * reading coverage per chunk would call that answer unreachable when the ladder
 * reaches it every time. "Does what this *chunk* matches pick it out" is a
 * question about the row that has to occupy the slot.
 *
 * Dominators are counted as **duplicate groups**: the stack's dedup collapses a
 * cross-origin cluster into one slot, so three copies of a page take one place
 * in the top three, and counting them as three would defer probes the stack can
 * still pass. Only chunks the query's own grant can see are counted — a
 * dominator behind the fence can never take the slot.
 */
export function isolationOf(
  corpus: Corpus,
  query: FixtureQuery,
  chunkId: string,
  cutoff: number,
): IsolationVerdict {
  if (!Number.isInteger(cutoff) || cutoff < 1) {
    throw new Error(`isolation cutoff must be a positive integer; got ${String(cutoff)}`);
  }
  const chunk = corpus.chunks.get(chunkId);
  if (chunk === undefined) {
    // A gold key naming a chunk outside the corpus is a corpus error, and it
    // must never read as "unreachable, therefore excused".
    throw new Error(`cannot judge isolation of ${chunkId}: it is not a chunk in this corpus`);
  }

  const index = indexOf(corpus);
  const supplied = queryKeys(corpus, query);
  const carried = keysCarriedBy(corpus, supplied, chunkId);

  const acrossPage = new Set<ReachKey>();
  for (const sibling of index.chunksByPage.get(chunk.pageId) ?? [chunkId]) {
    for (const key of keysCarriedBy(corpus, supplied, sibling)) acrossPage.add(key);
  }
  const uncovered = supplied.keys.filter((key) => !acrossPage.has(key));

  const groupOfSelf = corpus.groupOf(chunkId) ?? chunkId;
  const dominators = new Set<string>();
  for (const otherId of corpus.visibleTo(query.grant as readonly OriginContext[])) {
    if (otherId === chunkId) continue;
    const group = corpus.groupOf(otherId) ?? otherId;
    if (group === groupOfSelf || dominators.has(group)) continue;
    const theirs = new Set(keysCarriedBy(corpus, supplied, otherId));
    if (carried.every((key) => theirs.has(key))) dominators.add(group);
  }

  return {
    chunkId,
    cutoff,
    uncovered,
    carried,
    dominators: [...dominators].sort(),
    // Isolable unless BOTH halves hold. See the header: either half alone
    // excuses probes the stack should be — and is — getting right.
    isolable: uncovered.length === 0 || dominators.size < cutoff,
  };
}

export interface ProbeReach {
  readonly queryId: string;
  readonly cutoff: number;
  readonly verdicts: readonly IsolationVerdict[];
  /**
   * True when **every** required chunk is beyond the reach of a keyed mechanism.
   * One isolable chunk is enough to refuse the deferral: the stack had a path.
   */
  readonly semanticOnly: boolean;
}

/** Judge a probe over every chunk that would have had to reach the cutoff. */
export function probeReach(
  corpus: Corpus,
  query: FixtureQuery,
  required: readonly string[],
  cutoff: number,
): ProbeReach {
  if (required.length === 0) {
    throw new Error(`probe ${query.id} has no required chunks; an empty set is vacuously unreachable`);
  }
  const verdicts = required.map((chunkId) => isolationOf(corpus, query, chunkId, cutoff));
  return {
    queryId: query.id,
    cutoff,
    verdicts,
    semanticOnly: verdicts.every((verdict) => !verdict.isolable),
  };
}
