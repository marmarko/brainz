/**
 * Stage 10 — four-layer read-time dedup.
 *
 * **Four layers because a brain fed from two mailboxes produces four different
 * kinds of repetition, and no single rule catches more than one of them.**
 *
 *   1. **Top 3 chunks per page.** A long document is one answer, not forty. This
 *      runs first so that a verbose page cannot consume the budget the later
 *      layers are deciding over.
 *   2. **0.85 Jaccard over normalized tokens.** The same *text* on different
 *      pages: a mail forwarded into the work mailbox, the same advisory pasted
 *      into a chat channel, a document and its "(copy)". The page caps are
 *      structurally unable to see these — they are different pages, and in the
 *      ordinary case one chunk each.
 *   3. **60% page-type cap.** One surface must not own the whole answer. A chat
 *      channel that discussed a topic all week will out-recall the document that
 *      settled it, every time, on term overlap alone.
 *   4. **2 chunks per page in the payload.** The reader-facing form of layer 1.
 *
 * **Every layer is a named option, and that is deliberate.** "Delete this layer"
 * is expressible as a call, so `dedup.test.ts` can show each layer's individual
 * contribution by turning it off — which is also the mutation schedule. A layer
 * whose removal changes nothing is a layer that is not doing anything.
 *
 * **Dedup removes; it never reorders.** Every survivor keeps its position
 * relative to every other survivor, so the ordering the earlier stages produced
 * is what the reader gets, minus repeats.
 *
 * **The tokeniser is the shared one.** Jaccard over a private tokenisation would
 * be a second normalizer by another name — two chunks differing only in curly
 * quotes would score below the threshold and both survive.
 */

import { tokens } from './normalize.ts';
import type { ScoredCandidate, SourceType } from './types.ts';

export interface DedupOptions {
  /** Layer 1: chunks per page admitted to the later layers. */
  readonly chunksPerPage: number;
  /** Layer 2: token-set overlap at or above which two chunks are the same text. */
  readonly jaccardThreshold: number;
  /** Layer 3: the largest share of the *requested* payload one source type may hold. */
  readonly pageTypeCap: number;
  /**
   * How many results the caller asked for — the denominator layer 3 caps
   * against.
   *
   * It has to be the requested size and not the surviving size, and the
   * difference is not a detail. Capping against survivors is self-referential:
   * removing a row shrinks the denominator, which lowers the allowance, which
   * removes another row. On a payload that is nine chat messages and one
   * document that recursion settles at *one* chat message — a diversity rule
   * that threw away eight answers to make a ratio come out. Capping against the
   * request means one type may claim at most 60% of the slots and the rest stay
   * open for other types; if no other type exists, the slots simply go unused.
   */
  readonly targetSize: number;
  /** Layer 4: chunks per page in what is returned. */
  readonly finalChunksPerPage: number;
  /**
   * Below this many survivors the page-type cap stands down.
   *
   * A cap applied to a three-result payload is a rule that throws away answers
   * to enforce a diversity nobody asked for — and on a homogeneous corpus (every
   * candidate is a chat message) it would empty the result set entirely.
   */
  readonly pageTypeCapFloor: number;
}

export const DEFAULT_DEDUP: DedupOptions = {
  chunksPerPage: 3,
  jaccardThreshold: 0.85,
  pageTypeCap: 0.6,
  targetSize: 10,
  finalChunksPerPage: 2,
  pageTypeCapFloor: 4,
};

/** Token-set Jaccard, through the shared tokeniser. */
export function jaccard(a: string, b: string): number {
  const left = new Set(tokens(a));
  const right = new Set(tokens(b));
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

export function dedupe(
  results: readonly ScoredCandidate[],
  overrides: Partial<DedupOptions> = {},
): ScoredCandidate[] {
  const options = { ...DEFAULT_DEDUP, ...overrides };

  // ---- layer 1: top N per page ------------------------------------------
  const perPage = new Map<string, number>();
  const afterPageCap: ScoredCandidate[] = [];
  for (const entry of results) {
    const seen = perPage.get(entry.candidate.pageId) ?? 0;
    if (seen >= options.chunksPerPage) continue;
    perPage.set(entry.candidate.pageId, seen + 1);
    afterPageCap.push(entry);
  }

  // ---- layer 2: near-duplicate text --------------------------------------
  // The first survivor of a cluster wins, and the list arrives score-ordered, so
  // the survivor is the highest-scoring member without a second pass.
  const afterJaccard: ScoredCandidate[] = [];
  for (const entry of afterPageCap) {
    const duplicate = afterJaccard.some(
      (kept) => jaccard(kept.candidate.content, entry.candidate.content) >= options.jaccardThreshold,
    );
    if (!duplicate) afterJaccard.push(entry);
  }

  // ---- layer 3: source-type share ----------------------------------------
  const afterTypeCap = capBySourceType(afterJaccard, options);

  // ---- layer 4: chunks per page in the payload ---------------------------
  const finalPerPage = new Map<string, number>();
  const out: ScoredCandidate[] = [];
  for (const entry of afterTypeCap) {
    const seen = finalPerPage.get(entry.candidate.pageId) ?? 0;
    if (seen >= options.finalChunksPerPage) continue;
    finalPerPage.set(entry.candidate.pageId, seen + 1);
    out.push(entry);
  }

  return out;
}

/**
 * Hold each source type to its share of the requested payload.
 *
 * It stands down entirely below {@link DedupOptions.pageTypeCapFloor} survivors,
 * and it never drops a type that has no competitor — a corpus where every
 * candidate is a chat message has no diversity to enforce, only answers to lose.
 */
function capBySourceType(
  results: readonly ScoredCandidate[],
  options: DedupOptions,
): ScoredCandidate[] {
  if (results.length < options.pageTypeCapFloor) return [...results];

  const types = new Set<SourceType>(results.map((entry) => entry.candidate.sourceType));
  if (types.size < 2) return [...results];

  const allowance = Math.max(1, Math.floor(options.targetSize * options.pageTypeCap));
  const used = new Map<SourceType, number>();
  const kept: ScoredCandidate[] = [];
  const overflow: ScoredCandidate[] = [];

  for (const entry of results) {
    const type = entry.candidate.sourceType;
    const seen = used.get(type) ?? 0;
    if (seen >= allowance) {
      overflow.push(entry);
      continue;
    }
    used.set(type, seen + 1);
    kept.push(entry);
  }

  // Overflow is dropped rather than appended: re-adding it at the tail would
  // make the cap a reordering, which is the one thing this stage must not be.
  return kept;
}
