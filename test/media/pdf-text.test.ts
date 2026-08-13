/**
 * The cheap path, on its own.
 *
 * U21: "A PDF with a text layer is extracted without an OCR model call (cheaper
 * path taken when available)." That is a claim about two things — that the text
 * comes out, and that a page which genuinely has no text layer says so rather
 * than returning something. The second is what makes the no-model-call test in
 * `ocr-phase.test.ts` mean anything: an extractor that returned `''` for a
 * scanned page would suppress the model call for a page nothing can read, and
 * the screenshot case would silently stop working.
 *
 * `null` and `''` are therefore not interchangeable here, and the extractor is
 * required to return `null` — "there is no text layer" — rather than an empty
 * string, which would read as "the text layer is empty" one caller up.
 */

import { describe, expect, test } from 'bun:test';

import { extractPdfTextLayer } from '../../src/core/media/pdf-text.ts';
import { pdfWithTextLayer, scannedPdf, screenshotBytes } from './fixture.ts';

describe('a PDF that carries its own text', () => {
  test('an uncompressed content stream gives its text up', () => {
    const text = extractPdfTextLayer(pdfWithTextLayer('the guest wifi password is hunter2'));
    expect(text).not.toBeNull();
    expect(text ?? '').toContain('guest wifi password is hunter2');
  });

  test('a FlateDecode content stream gives its text up', () => {
    const text = extractPdfTextLayer(
      pdfWithTextLayer('the guest wifi password is hunter2', { compress: true }),
    );
    expect(text).not.toBeNull();
    expect(text ?? '').toContain('guest wifi password is hunter2');
  });

  test('escaped parentheses survive, because a real document has them', () => {
    const text = extractPdfTextLayer(pdfWithTextLayer('invoice (final) for Q3'));
    expect(text ?? '').toContain('invoice (final) for Q3');
  });
});

describe('a PDF that does not', () => {
  test('a scanned page reports no text layer at all', () => {
    // Not `''`: see the header. The caller routes on `null`.
    expect(extractPdfTextLayer(scannedPdf())).toBeNull();
  });

  test('bytes that are not a PDF are refused rather than scavenged', () => {
    expect(extractPdfTextLayer(screenshotBytes())).toBeNull();
    expect(extractPdfTextLayer(new Uint8Array())).toBeNull();
  });

  test('a text layer of nothing but whitespace is no text layer', () => {
    expect(extractPdfTextLayer(pdfWithTextLayer('   '))).toBeNull();
  });
});
