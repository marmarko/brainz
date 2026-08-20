/**
 * The one prompt in the cycle whose size is the batch's problem.
 *
 * **Every other model phase sends one item per call.** `salience_refine` sends N
 * whole documents and asks for N scores, so its request grew with the corpus AND
 * with `limit` — a knob every other phase reads as "how many items, one at a
 * time". Measured on a real brain at `limit: 400`, the request drew a durable
 * `input_rejected` on every cycle. Because it is the LAST phase, that did not
 * cost a single summary and was invisible in the numbers a reader watches; what
 * it cost was the run's `complete`, so `finished_at` never carried a completing
 * reason, the completion clock never advanced, and every surface reading it
 * called the brain frozen. The freeze was reported three phases downstream of
 * anything that was actually wrong.
 *
 * Two bounds, because either alone still grows: a page cap
 * ({@link SALIENCE_PAGE_CHARS}) and a batch cap the cycle's `limit` cannot
 * raise.
 */

import { describe, expect, test } from 'bun:test';

import {
  SALIENCE_PAGE_CHARS,
  buildSaliencePrompt,
} from '../../src/worker/consolidate/materialize.ts';

function page(index: number, chars: number) {
  return {
    pageId: String(index),
    title: `Thread ${index}`,
    text: 'a'.repeat(chars),
    origins: ['personal:mail'],
  };
}

describe('a salience prompt is bounded by the document, not by the corpus', () => {
  test('an enormous document contributes a bounded prefix, and says it was cut', () => {
    const prompt = buildSaliencePrompt({ pages: [page(1, 200_000)] });
    // The prompt is a small multiple of the cap rather than a multiple of the
    // document: fencing and headers are the only other content.
    expect(prompt.user.length).toBeLessThan(SALIENCE_PAGE_CHARS * 3);
    // And the model is told, so a score is never given on the assumption that a
    // prefix was the whole document.
    expect(prompt.user).toContain('[document continues]');
  });

  test('a short document is passed whole and carries no truncation marker', () => {
    const prompt = buildSaliencePrompt({ pages: [page(1, 40)] });
    expect(prompt.user).toContain('a'.repeat(40));
    expect(prompt.user).not.toContain('[document continues]');
  });

  test('the request grows with the batch and not with the documents in it', () => {
    // The property the failure violated. Twenty-five ordinary pages and
    // twenty-five enormous ones must cost about the same, because the size of a
    // request is what the provider refuses.
    const small = buildSaliencePrompt({
      pages: Array.from({ length: 25 }, (_, index) => page(index, 900)),
    });
    const huge = buildSaliencePrompt({
      pages: Array.from({ length: 25 }, (_, index) => page(index, 120_000)),
    });
    expect(huge.user.length).toBeLessThan(small.user.length * 3);
    // Stated absolutely too, so a future edit that removes the cap fails here
    // rather than only in production: 25 pages capped at 1,500 characters is
    // ~40KB of document, and nothing near a context window.
    expect(huge.user.length).toBeLessThan(25 * SALIENCE_PAGE_CHARS * 2);
  });

  test('every page is still scoreable — the cap trims text, never the batch', () => {
    // The cap must not silently drop pages: a page absent from the prompt is a
    // page the model cannot return a `page_id` for, and `runSalienceRefinePhase`
    // counts a missing entry as `logged`. Truncation that quietly became
    // omission would read as a model that declined to answer.
    const prompt = buildSaliencePrompt({
      pages: Array.from({ length: 25 }, (_, index) => page(index, 50_000)),
    });
    for (let index = 0; index < 25; index++) {
      expect(prompt.user).toContain(`page_id: ${index}`);
    }
  });
});
