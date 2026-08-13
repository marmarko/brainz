/**
 * The chunker — U4 approach step 2, and the ledger row `gap.write-path`.
 *
 * The two production bugs that row records are both **silent**: an over-limit
 * chunk that failed embedding forever with nothing to show for it, and CJK text
 * that imported and never became searchable because a byte- or word-shaped size
 * estimate said a 6,000-character Chinese paragraph was small. Neither produced
 * an error, so neither can be caught by a test that only checks the happy path.
 *
 * So the assertions here are about the properties that go quietly false:
 *
 *  - **Nothing is dropped.** Not "the output looks reasonable" — the source is
 *    reconstructed byte-for-byte from the chunks' coverage intervals. A helpful
 *    `.trim()` anywhere in the chunker fails this.
 *  - **Nothing exceeds the cap**, including the overlap the chunker itself adds,
 *    and including a single unbroken block far larger than the cap.
 *  - **CJK is sized per character**, which is checked by comparing against the
 *    word-shaped sizing on a document of the same length rather than by
 *    asserting a magic number.
 */

import { describe, expect, test } from 'bun:test';

import {
  CHUNKER_VERSION,
  CJK_SIZING_THRESHOLD,
  MAX_CHUNK_CHARS,
  chunkDocument,
  cjkRatio,
} from '../../../src/core/write/chunker.ts';

/** Prose that is deterministic, paragraph-shaped, and long enough to split. */
function latinDocument(approximateChars: number): string {
  const paragraph =
    'The quarterly review covered pipeline health, hiring plans and the migration schedule. ' +
    'Nothing in it was surprising, which is itself worth recording for later comparison. ';
  const blocks: string[] = [];
  let total = 0;
  let index = 0;
  while (total < approximateChars) {
    const block = index % 4 === 0 ? `## Section ${index}\n\n${paragraph}` : paragraph.repeat(3);
    blocks.push(block);
    total += block.length + 2;
    index += 1;
  }
  return blocks.join('\n\n');
}

/** Han text with no spaces at all — the shape word-based sizing gets wrong. */
function cjkDocument(characters: number): string {
  const sentence = '这份季度回顾涵盖了销售管道的健康状况、招聘计划以及迁移时间表。';
  const out: string[] = [];
  let total = 0;
  while (total < characters) {
    out.push(sentence);
    total += sentence.length;
  }
  return out.join('');
}

function reconstruct(source: string, chunks: ReturnType<typeof chunkDocument>): string {
  return chunks.map((chunk) => source.slice(chunk.sourceStart, chunk.sourceEnd)).join('');
}

describe('a 20k-character document chunks completely', () => {
  const source = latinDocument(20_000);
  const chunks = chunkDocument(source);

  test('it produces more than one chunk', () => {
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('ordinals are contiguous from zero', () => {
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, index) => index));
  });

  test('no chunk exceeds the hard safety cap, overlap included', () => {
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  test('the source is reconstructed exactly from the coverage intervals', () => {
    // The strong form of "content survives round-trip". Trimming, collapsing or
    // dropping a separator all fail here and nowhere else.
    expect(reconstruct(source, chunks)).toBe(source);
  });

  test('coverage intervals tile the source with no gap and no double-count', () => {
    let cursor = 0;
    for (const chunk of chunks) {
      expect(chunk.sourceStart).toBe(cursor);
      expect(chunk.sourceEnd).toBeGreaterThan(chunk.sourceStart);
      cursor = chunk.sourceEnd;
    }
    expect(cursor).toBe(source.length);
  });

  test('every chunk stores text that really is its own slice of the source', () => {
    for (const chunk of chunks) {
      expect(source).toContain(chunk.content);
      expect(chunk.content).toContain(source.slice(chunk.sourceStart, chunk.sourceEnd));
    }
  });

  test('consecutive chunks overlap, so a sentence cut in half is embedded whole once', () => {
    const overlapping = chunks
      .slice(1)
      .filter((chunk) => chunk.contentStart < chunk.sourceStart);
    expect(overlapping.length).toBe(chunks.length - 1);
  });

  test('an empty document produces no chunks rather than one empty one', () => {
    expect(chunkDocument('')).toEqual([]);
    expect(chunkDocument('   \n\n  ')).toEqual([]);
  });
});

describe('over-cap content is split, never silently dropped', () => {
  // One unbroken run with no paragraph break, no heading and no sentence end:
  // the input that defeats every structural boundary the chunker looks for.
  const source = `${'x'.repeat(MAX_CHUNK_CHARS * 3 + 137)}`;
  const chunks = chunkDocument(source);

  test('it is split into several chunks', () => {
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  test('none of them exceeds the cap', () => {
    for (const chunk of chunks) expect(chunk.content.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  test('every character survives', () => {
    expect(reconstruct(source, chunks)).toBe(source);
  });

  test('a hard cut never lands inside a surrogate pair', () => {
    // Han Extension B characters are surrogate pairs in UTF-16. A cut between
    // the halves produces a lone surrogate: it stores, it embeds, and it renders
    // as a replacement character forever.
    const astral = '𠜎'.repeat(MAX_CHUNK_CHARS);
    for (const chunk of chunkDocument(astral)) {
      expect(chunk.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(chunk.content).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });
});

describe('CJK is sized per character, not per word', () => {
  test('cjkRatio counts code points, not UTF-16 units', () => {
    expect(cjkRatio('')).toBe(0);
    expect(cjkRatio('hello world')).toBe(0);
    expect(cjkRatio('这份季度回顾')).toBe(1);
    // Half Han, half ASCII, by code point.
    expect(cjkRatio('中文abc文')).toBeCloseTo(3 / 6, 5);
    // Extension B: two UTF-16 units per character, so a length-based count
    // would report half the true ratio on exactly the text that needs the
    // CJK branch most.
    expect(cjkRatio('𠜎𠜱𠝹')).toBe(1);
  });

  test('the threshold is the one the plan states', () => {
    expect(CJK_SIZING_THRESHOLD).toBeCloseTo(0.3, 10);
  });

  test('a CJK document of the same length yields strictly more chunks', () => {
    // The comparison the plan asks for: character-based sizing against
    // word-based sizing on the same character count. If the CJK branch is
    // removed the two numbers converge and this goes red.
    const characters = 12_000;
    const latin = chunkDocument(latinDocument(characters));
    const cjk = chunkDocument(cjkDocument(characters));
    expect(cjk.length).toBeGreaterThan(latin.length);
  });

  test('a mixed document just under the threshold uses word sizing', () => {
    const han = '这份季度回顾涵盖了销售管道';
    const ascii = 'the quarterly review covered the sales pipeline and the hiring plan again ';
    // ~13 Han characters per ~73 ASCII: well under 30%.
    const mixed = `${han}${ascii}`.repeat(200);
    expect(cjkRatio(mixed)).toBeLessThan(CJK_SIZING_THRESHOLD);
    const sized = chunkDocument(mixed);
    const cjkSized = chunkDocument(cjkDocument(mixed.length));
    expect(cjkSized.length).toBeGreaterThan(sized.length);
  });

  test('CJK content still round-trips', () => {
    const source = cjkDocument(9_000);
    expect(reconstruct(source, chunkDocument(source))).toBe(source);
  });
});

describe('structure is respected where it exists', () => {
  test('a heading starts a new chunk rather than trailing the previous one', () => {
    const body = 'Body text for the section, repeated to give the window something to hold. ';
    const source = `# First\n\n${body.repeat(20)}\n\n# Second\n\n${body.repeat(20)}`;
    const chunks = chunkDocument(source);
    const second = chunks.find((chunk) => chunk.content.includes('# Second'));
    expect(second).toBeDefined();
    // The heading opens the chunk's own coverage, not the middle of a window.
    expect(source.slice(second?.sourceStart ?? -1).startsWith('# Second')).toBe(true);
  });

  test('short paragraphs are packed together rather than each becoming a chunk', () => {
    const source = Array.from({ length: 12 }, (_, index) => `Line ${index}.`).join('\n\n');
    expect(chunkDocument(source).length).toBe(1);
  });
});

describe('the version is declared, because the page records it', () => {
  test('CHUNKER_VERSION is a positive integer', () => {
    expect(Number.isInteger(CHUNKER_VERSION)).toBe(true);
    expect(CHUNKER_VERSION).toBeGreaterThan(0);
  });

  test('the cap is the number the plan names', () => {
    expect(MAX_CHUNK_CHARS).toBe(6000);
  });
});
