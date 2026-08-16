/**
 * The export's first problem, and the one nothing else in this repo had to
 * solve: **`page` has no body column.**
 *
 * The only copy of a document's text inside a tenant database is
 * `chunk.content`, and `chunk.content` carries U4's 200-character reach-back
 * overlap — context for the embedding, deliberately *not* coverage. The chunker
 * guarantees its coverage intervals tile the source exactly, and it does not
 * store them. So an export that concatenates chunks in ordinal order emits a
 * document with up to 200 duplicated characters at every boundary. It is not the
 * user's file, and it would pass every test that compares an export against
 * itself.
 *
 * These are the tests that make that impossible to ship:
 *
 *   1. **Reconstruction is byte-exact** over documents the real chunker
 *      partitioned, including one built from a repeated pattern longer than the
 *      overlap — the shape that defeats a naive longest-match de-overlap.
 *   2. **The digest is the arbiter.** `page.content_sha256` is U4's idempotency
 *      key, so it is exact and never stale. A reconstruction that does not
 *      reproduce it is reported as unverified, not shipped as if it were the
 *      user's document and not silently dropped from their backup.
 */

import { describe, expect, test } from 'bun:test';

import { chunkDocument, CHUNK_OVERLAP_CHARS } from '../../../src/core/write/chunker.ts';
import { contentDigest } from '../../../src/core/write/write-path.ts';
import { deoverlap, verifyReconstruction } from '../../../src/core/export/reconstruct.ts';

/** A document long enough that the real chunker cuts it into several windows. */
function prose(paragraphs: number): string {
  const lines: string[] = [];
  for (let index = 0; index < paragraphs; index += 1) {
    lines.push(`## Section ${index}`);
    lines.push(
      `This is paragraph ${index}. ` +
        'It exists to give the packer something with sentence boundaries to work with, and it is '.repeat(
          6,
        ),
    );
  }
  return lines.join('\n\n');
}

/**
 * The adversary for a longest-match join: a pattern that repeats at a period
 * *shorter* than the reach-back, so the accumulated text ends with many
 * different-length prefixes of the next chunk and the longest one is not the
 * true overlap.
 */
function repeatedPattern(): string {
  const unit = 'ABCDEFGHIJ'.repeat(12); // 120 chars, below the 200-char reach-back
  return `${unit}\n\n`.repeat(60);
}

describe('reconstruction from chunks', () => {
  test('a multi-chunk document comes back byte-for-byte', () => {
    const source = prose(40);
    const chunks = chunkDocument(source);
    expect(chunks.length).toBeGreaterThan(3);

    expect(deoverlap(chunks.map((chunk) => chunk.content))).toBe(source);
  });

  test('a document that repeats inside the reach-back window still comes back exactly', () => {
    const source = repeatedPattern();
    const chunks = chunkDocument(source);
    expect(chunks.length).toBeGreaterThan(3);

    // The naive answer, stated so the test is about the difference: joining the
    // stored contents duplicates the reach-back at every boundary.
    const naive = chunks.map((chunk) => chunk.content).join('');
    expect(naive.length).toBeGreaterThan(source.length);

    expect(deoverlap(chunks.map((chunk) => chunk.content))).toBe(source);
  });

  test('CJK text, which the chunker sizes per character, round-trips too', () => {
    const source = `${'これは日本語の文章です。'.repeat(80)}\n\n${'漢字の並びが続きます。'.repeat(80)}`;
    const chunks = chunkDocument(source);
    expect(chunks.length).toBeGreaterThan(1);
    expect(deoverlap(chunks.map((chunk) => chunk.content))).toBe(source);
  });

  test('a reach-back that lands between the halves of a surrogate pair still rejoins', () => {
    // `alignLeft` in the chunker steps one code unit further left when the
    // 200-character reach-back would otherwise cut an astral character in half,
    // so the real overlap is 201 rather than 200 — and a ceiling of exactly 200
    // rejoins this document with a **duplicated** character and no error.
    // The shape is found rather than asserted: one ASCII character of padding
    // shifts every emoji off the even grid, and blocks of 899 emoji put a window
    // boundary where the pair is.
    const source = `x${Array.from({ length: 6 }, () => '\u{1F600}'.repeat(899)).join('\n\n')}`;
    const chunks = chunkDocument(source);
    const reaches = chunks.slice(1).map((chunk) => chunk.sourceStart - chunk.contentStart);
    // The fixture is only a fixture while it still provokes the branch.
    expect(reaches).toContain(CHUNK_OVERLAP_CHARS + 1);

    expect(deoverlap(chunks.map((chunk) => chunk.content))).toBe(source);
  });

  test('one chunk is its own document', () => {
    const source = 'A short note.';
    expect(deoverlap(chunkDocument(source).map((chunk) => chunk.content))).toBe(source);
  });

  test('the reach-back never exceeds what the chunker promises', () => {
    const chunks = chunkDocument(prose(40));
    for (let index = 1; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunk === undefined) continue;
      // +1 for the surrogate-alignment step in `alignLeft`.
      expect(chunk.sourceStart - chunk.contentStart).toBeLessThanOrEqual(CHUNK_OVERLAP_CHARS + 1);
    }
  });
});

describe('the digest is the arbiter, not the join', () => {
  test('a faithful reconstruction verifies', () => {
    const source = prose(20);
    const title = 'A document with a title';
    const body = deoverlap(chunkDocument(source).map((chunk) => chunk.content));

    const outcome = verifyReconstruction({ title, body, expected: contentDigest(title, source) });
    expect(outcome.verified).toBe(true);
    expect(outcome.actual).toBe(contentDigest(title, source));
  });

  test('a chunk that is gone makes the reconstruction unverifiable, and it says so', () => {
    const source = prose(20);
    const title = 'A document with a title';
    const chunks = chunkDocument(source);
    expect(chunks.length).toBeGreaterThan(2);

    // A purge, a partial write, a row somebody deleted by hand: the join still
    // produces *a* document, and it is not this one.
    const damaged = deoverlap(chunks.filter((_, index) => index !== 1).map((chunk) => chunk.content));
    expect(damaged).not.toBe(source);

    const outcome = verifyReconstruction({
      title,
      body: damaged,
      expected: contentDigest(title, source),
    });
    expect(outcome.verified).toBe(false);
    expect(outcome.actual).not.toBe(outcome.expected);
  });

  test('the title is part of the digest, so a retitled page does not verify', () => {
    const source = prose(6);
    const body = deoverlap(chunkDocument(source).map((chunk) => chunk.content));
    const outcome = verifyReconstruction({
      title: 'the wrong title',
      body,
      expected: contentDigest('the right title', source),
    });
    expect(outcome.verified).toBe(false);
  });

  test('a null title is not the string "null"', () => {
    const body = 'a remembered note';
    expect(
      verifyReconstruction({ title: null, body, expected: contentDigest(null, body) }).verified,
    ).toBe(true);
    expect(
      verifyReconstruction({ title: 'null', body, expected: contentDigest(null, body) }).verified,
    ).toBe(false);
  });
});
