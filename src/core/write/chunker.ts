/**
 * One chunker, chosen deliberately and recorded (U4 approach step 2):
 * heading- and paragraph-aware fixed windows with overlap, a hard 6,000
 * character safety cap, and per-character sizing once a document is ≥30% CJK.
 *
 * The ledger row this closes (`gap.write-path`) records two upstream production
 * bugs, and what they have in common is more important than either: **both were
 * silent.** An over-limit chunk failed embedding forever and reported nothing —
 * the row was simply never searchable. CJK text sized by a word-shaped estimate
 * imported cleanly and never became searchable either. Neither is visible in a
 * happy-path test, so the design rules here are stated as properties rather
 * than as behaviour:
 *
 *  - **Nothing is dropped.** Every chunk carries a half-open coverage interval
 *    `[sourceStart, sourceEnd)` into the source, the intervals tile the source
 *    exactly, and `test/core/write/chunker.test.ts` reconstructs the input from
 *    them. Not "the output looks right": byte-for-byte. Separators, blank lines
 *    and trailing whitespace all belong to some interval, which is why blocks
 *    are cut *before* a boundary line rather than around it.
 *  - **Overlap is context, not coverage.** `content` is what gets stored and
 *    embedded and reaches back `CHUNK_OVERLAP_CHARS` into the previous window,
 *    so a sentence split across a boundary is embedded whole at least once. The
 *    coverage interval excludes that reach-back, which is what keeps "nothing
 *    is dropped" and "nothing is counted twice" from being in tension.
 *  - **The cap is absolute and applies to `content`**, overlap included. It is
 *    a safety cap, not a target: content that cannot be split at a sentence or
 *    a word boundary is cut at a code-point boundary rather than left oversized
 *    or discarded.
 *
 * **Why sizing switches on a CJK ratio rather than on a token count.** A token
 * count needs a tokenizer per model, which is a second thing to keep in sync
 * with the embedding provider for a number that only decides how much text goes
 * in a window. A Han character carries roughly an order of magnitude more
 * information per character than a Latin one, so the ratio is the property that
 * actually matters and it is computable here, deterministically, with nothing
 * imported.
 */

/**
 * Recorded on every page (`page.chunker_version`). A change here re-partitions
 * every future document, so a corpus written before and after is not
 * comparable; KTD8's re-embed job selects on the signature this is part of.
 */
export const CHUNKER_VERSION = 1;

/**
 * The hard safety cap, in UTF-16 code units, applied to what is stored and sent
 * to the embedding provider. The plan states 6,000 characters; content over it
 * is split, never dropped.
 */
export const MAX_CHUNK_CHARS = 6_000;

/** The window the packer aims for on word-shaped text. */
export const TARGET_CHUNK_CHARS = 1_800;

/**
 * The window the packer aims for on CJK-shaped text, counted in **code
 * points**. Roughly the same information content as {@link TARGET_CHUNK_CHARS}
 * of Latin prose.
 */
export const TARGET_CJK_CHARS = 700;

/** How far a chunk reaches back into the previous window, in code units. */
export const CHUNK_OVERLAP_CHARS = 200;

/** ≥30% CJK code points switches sizing to per-character (U4 approach step 2). */
export const CJK_SIZING_THRESHOLD = 0.3;

export interface Chunk {
  /** Contiguous from zero. `chunk.ordinal` in the schema. */
  readonly ordinal: number;
  /** What is stored and embedded: the window plus its reach-back. */
  readonly content: string;
  /** Where `content` starts in the source. `≤ sourceStart`. */
  readonly contentStart: number;
  /** Start of this chunk's exclusive coverage of the source. */
  readonly sourceStart: number;
  /** End of it. The intervals tile `[0, source.length)` with no gap. */
  readonly sourceEnd: number;
}

/**
 * CJK ranges by **code point**, which is why the ratio is computed over an
 * iterator rather than over `text.length`: Extension B lives above the basic
 * plane, so every one of its characters is two UTF-16 units and a length-based
 * count halves the ratio of exactly the text most in need of the CJK branch.
 */
function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // Hiragana + Katakana
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK Extension A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK Unified Ideographs
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // Hangul syllables
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // Compatibility ideographs
    (codePoint >= 0x20000 && codePoint <= 0x3ffff) // Extensions B and beyond
  );
}

/**
 * The share of a document's non-whitespace code points that are CJK.
 *
 * Whitespace is excluded because CJK text carries very little of it, so
 * including it would make a mixed document's ratio depend mostly on how much
 * Latin formatting surrounds the Han.
 */
export function cjkRatio(text: string): number {
  let counted = 0;
  let cjk = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (/\s/u.test(character)) continue;
    counted += 1;
    if (isCjk(codePoint)) cjk += 1;
  }
  return counted === 0 ? 0 : cjk / counted;
}

interface Sizing {
  /** Window target, in this mode's own unit. */
  readonly target: number;
  /** True when the unit is code points rather than UTF-16 code units. */
  readonly byCodePoint: boolean;
}

function sizingFor(text: string): Sizing {
  return cjkRatio(text) >= CJK_SIZING_THRESHOLD
    ? { target: TARGET_CJK_CHARS, byCodePoint: true }
    : { target: TARGET_CHUNK_CHARS, byCodePoint: false };
}

function measure(text: string, sizing: Sizing): number {
  if (!sizing.byCodePoint) return text.length;
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** Nudges an index off the low half of a surrogate pair. */
function alignLeft(source: string, index: number): number {
  if (index <= 0 || index >= source.length) return Math.max(0, Math.min(index, source.length));
  const code = source.charCodeAt(index);
  const previous = source.charCodeAt(index - 1);
  if (code >= 0xdc00 && code <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) return index - 1;
  return index;
}

/**
 * The index reached by consuming `budget` measured units from `from`. Always a
 * code-point boundary: a cut between the halves of a surrogate pair produces a
 * lone surrogate that stores, embeds and renders as a replacement character
 * with nothing anywhere reporting a problem.
 */
function advance(source: string, from: number, budget: number, sizing: Sizing): number {
  if (!sizing.byCodePoint) return alignLeft(source, Math.min(from + budget, source.length));
  let index = from;
  let taken = 0;
  while (index < source.length && taken < budget) {
    const codePoint = source.codePointAt(index);
    index += codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    taken += 1;
  }
  return Math.min(index, source.length);
}

interface Block {
  readonly start: number;
  readonly end: number;
  /** Opens with a heading line, so it always starts a window. */
  readonly heading: boolean;
}

const HEADING_LINE = /^ {0,3}#{1,6}\s/;

/**
 * Cuts the source into blocks at headings and paragraph breaks, **before** the
 * boundary line rather than around it, so that every character — separators,
 * blank lines, trailing newlines — belongs to exactly one block and the blocks
 * concatenate back to the source.
 */
function splitBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  let start = 0;
  let hasContent = false;
  let heading = false;
  let previousBlank = false;
  let cursor = 0;

  while (cursor < source.length) {
    const newline = source.indexOf('\n', cursor);
    const lineEnd = newline === -1 ? source.length : newline + 1;
    const line = source.slice(cursor, lineEnd);
    const blank = line.trim().length === 0;
    const isHeading = HEADING_LINE.test(line);

    if (hasContent && (isHeading || (!blank && previousBlank))) {
      blocks.push({ start, end: cursor, heading });
      start = cursor;
      hasContent = !blank;
      heading = isHeading;
    } else {
      if (!hasContent && isHeading) heading = true;
      if (!blank) hasContent = true;
    }

    previousBlank = blank;
    cursor = lineEnd;
  }

  if (source.length > start) blocks.push({ start, end: source.length, heading });
  return blocks;
}

/** Sentence terminators in both scripts, plus the CJK full stop family. */
const SENTENCE_END = /[.!?;:。！？；：\n]/;

/**
 * Splits one over-target block into pieces no larger than the target, cutting
 * at the best boundary available: a sentence end, else whitespace, else a
 * code-point boundary. The last of those is what makes "never silently
 * dropped" true for a 20,000-character run with no structure in it at all.
 */
function splitOversized(source: string, block: Block, sizing: Sizing): Array<[number, number]> {
  const pieces: Array<[number, number]> = [];
  let from = block.start;

  while (from < block.end) {
    const hard = Math.min(advance(source, from, sizing.target, sizing), block.end);
    if (hard >= block.end) {
      pieces.push([from, block.end]);
      break;
    }

    // Only back off inside the last 40% of the piece: a boundary found near the
    // start would produce a run of tiny chunks on text with dense punctuation.
    const floor = advance(source, from, Math.floor(sizing.target * 0.6), sizing);
    let cut = -1;
    for (let index = hard; index > floor; index -= 1) {
      const character = source[index - 1];
      if (character !== undefined && SENTENCE_END.test(character)) {
        cut = index;
        break;
      }
    }
    if (cut === -1) {
      for (let index = hard; index > floor; index -= 1) {
        const character = source[index - 1];
        if (character !== undefined && /\s/u.test(character)) {
          cut = index;
          break;
        }
      }
    }
    pieces.push([from, cut === -1 ? hard : cut]);
    from = cut === -1 ? hard : cut;
  }

  return pieces;
}

/**
 * Chunks a document.
 *
 * Returns `[]` for a document with no content at all, rather than one empty
 * chunk: an empty chunk is a row that costs an embedding call, ranks against
 * nothing and is invisible in every count.
 */
export function chunkDocument(source: string): Chunk[] {
  if (source.trim().length === 0) return [];

  const sizing = sizingFor(source);
  const blocks = splitBlocks(source);

  // Blocks, flattened to units no larger than the target, each remembering
  // whether it opens a heading.
  const units: Array<{ start: number; end: number; heading: boolean }> = [];
  for (const block of blocks) {
    const text = source.slice(block.start, block.end);
    if (measure(text, sizing) <= sizing.target) {
      units.push({ start: block.start, end: block.end, heading: block.heading });
      continue;
    }
    let first = true;
    for (const [start, end] of splitOversized(source, block, sizing)) {
      units.push({ start, end, heading: first && block.heading });
      first = false;
    }
  }

  const windows: Array<{ start: number; end: number }> = [];
  let open: { start: number; end: number } | null = null;

  for (const unit of units) {
    const size = measure(source.slice(unit.start, unit.end), sizing);
    const openSize = open === null ? 0 : measure(source.slice(open.start, open.end), sizing);
    // A heading always opens a window: a section title packed into the tail of
    // the previous window is a title that ranks for the wrong section.
    if (open !== null && (unit.heading || openSize + size > sizing.target)) {
      windows.push(open);
      open = null;
    }
    if (open === null) open = { start: unit.start, end: unit.end };
    else open.end = unit.end;
  }
  if (open !== null) windows.push(open);

  return windows.map((window, ordinal) => {
    const contentStart =
      ordinal === 0 ? window.start : alignLeft(source, Math.max(0, window.start - CHUNK_OVERLAP_CHARS));
    const content = source.slice(contentStart, window.end);
    if (content.length > MAX_CHUNK_CHARS) {
      // Unreachable by construction — every window is at most one target wide
      // and the reach-back is bounded — and asserted rather than trusted,
      // because the failure it guards against is the silent one the ledger row
      // records: an over-cap chunk that never embeds and never reports why.
      throw new Error(
        `chunker produced a ${content.length}-character chunk, over the ${MAX_CHUNK_CHARS} cap`,
      );
    }
    return {
      ordinal,
      content,
      contentStart,
      sourceStart: window.start,
      sourceEnd: window.end,
    };
  });
}
