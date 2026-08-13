/**
 * The cheap path: a PDF that already carries its text gives it up for free.
 *
 * U21 approach step 2 routes transcription through a model, and this module is
 * the exception the plan states in the same breath: "A PDF with a text layer is
 * extracted without an OCR model call (cheaper path taken when available)."
 * Most PDFs a person receives — invoices, statements, contracts, manuals — were
 * produced by software and carry their own text. Sending those to a vision model
 * is paying for OCR of a document that was never scanned.
 *
 * **`null` means "there is no text layer", and `''` is not a synonym.** The
 * caller routes on it: `null` sends the page to the model, a string does not. An
 * extractor that returned an empty string for a scanned page would suppress the
 * model call for exactly the pages that need one, and the failure would be
 * silent — a scanned contract that is simply never searchable, with a green tick
 * on the cycle that skipped it.
 *
 * **What this is not.** It is not a PDF renderer and does not try to be. It
 * reads the content streams, pulls the operands of the text-showing operators,
 * and stops. Column order, ligature mapping and font encodings beyond the
 * byte-identity ones are out of its reach, and a document it reads badly is one
 * the raw payload is still preserved for — R23's whole argument for keeping the
 * original is that a better extractor can re-derive later. What it must never do
 * is claim text a document does not have, because that is the case where the
 * model is never called and nobody finds out.
 */

import { inflateRawSync, inflateSync } from 'node:zlib';

/** Every PDF starts with this. Bytes that do not are not scavenged for text. */
const HEADER = '%PDF-';

/** How far in the header may sit. Some producers prepend a UTF-8 BOM or junk. */
const HEADER_SEARCH_BYTES = 1_024;

/** A ceiling on what one document may contribute, so a hostile file is bounded. */
const MAX_TEXT_CHARS = 400_000;

/**
 * Bytes as a byte-preserving string. `latin1` is the only single-byte encoding
 * that round-trips every value 0–255, which is what a container format needs:
 * `utf8` would replace every byte it cannot parse and silently move every offset
 * after it.
 */
function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('latin1');
}

function isTextual(value: string): boolean {
  return /[A-Za-z0-9]/.test(value);
}

/**
 * One PDF literal string, starting at the `(`.
 *
 * Returns the decoded text and the index just past the closing parenthesis.
 * Parentheses nest, and an escaped one does not — getting that wrong ends the
 * string early and turns the rest of the document into operators.
 */
function readLiteralString(source: string, start: number): { text: string; next: number } {
  let index = start + 1;
  let depth = 1;
  let out = '';

  while (index < source.length) {
    const ch = source[index] as string;

    if (ch === '\\') {
      const escaped = source[index + 1];
      index += 2;
      switch (escaped) {
        case 'n':
          out += '\n';
          break;
        case 'r':
          out += '\r';
          break;
        case 't':
          out += '\t';
          break;
        case 'b':
        case 'f':
          out += ' ';
          break;
        case '\n':
          // A backslash at end of line is a continuation: no character at all.
          break;
        case '\r':
          if (source[index] === '\n') index += 1;
          break;
        default: {
          if (escaped !== undefined && escaped >= '0' && escaped <= '7') {
            let octal = escaped;
            while (octal.length < 3) {
              const digit = source[index];
              if (digit === undefined || digit < '0' || digit > '7') break;
              octal += digit;
              index += 1;
            }
            out += String.fromCharCode(Number.parseInt(octal, 8));
            break;
          }
          if (escaped !== undefined) out += escaped;
        }
      }
      continue;
    }

    if (ch === '(') {
      depth += 1;
      out += ch;
      index += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      index += 1;
      if (depth === 0) return { text: out, next: index };
      out += ch;
      continue;
    }

    out += ch;
    index += 1;
  }

  return { text: out, next: index };
}

/** One hex string, starting at the `<`. An odd final digit is padded with `0`. */
function readHexString(source: string, start: number): { text: string; next: number } {
  const end = source.indexOf('>', start);
  if (end === -1) return { text: '', next: source.length };

  const digits = source.slice(start + 1, end).replace(/[^0-9A-Fa-f]/g, '');
  const padded = digits.length % 2 === 0 ? digits : `${digits}0`;
  let out = '';
  for (let index = 0; index < padded.length; index += 2) {
    out += String.fromCharCode(Number.parseInt(padded.slice(index, index + 2), 16));
  }
  return { text: out, next: end + 1 };
}

/**
 * The text-showing operators' operands, in order.
 *
 * Strings are collected as they are read and flushed when an operator says what
 * they were for. Anything else clears them — an operand that was never shown is
 * not text on the page, and treating every parenthesised run as visible text is
 * how a font name or an XML metadata blob ends up in a search index.
 */
function showText(content: string): string {
  const out: string[] = [];
  let pending: string[] = [];
  let index = 0;

  while (index < content.length && out.length < MAX_TEXT_CHARS) {
    const ch = content[index] as string;

    if (ch === '(') {
      const literal = readLiteralString(content, index);
      pending.push(literal.text);
      index = literal.next;
      continue;
    }
    if (ch === '<' && content[index + 1] !== '<') {
      const hex = readHexString(content, index);
      pending.push(hex.text);
      index = hex.next;
      continue;
    }
    if (ch === '<' || ch === '>' || ch === '[' || ch === ']' || ch === '{' || ch === '}') {
      index += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      index += 1;
      continue;
    }

    // An operator or an operand token: read to the next delimiter.
    let token = '';
    while (index < content.length && !/[\s()<>[\]{}/]/.test(content[index] as string)) {
      token += content[index] as string;
      index += 1;
    }
    if (token.length === 0) {
      // A name (`/F1`) or a delimiter this loop does not consume: step over it.
      index += 1;
      continue;
    }

    if (token === 'Tj' || token === 'TJ' || token === "'" || token === '"') {
      if (pending.length > 0) out.push(pending.join(''));
      pending = [];
      if (token === "'" || token === '"') out.push('\n');
      continue;
    }
    if (token === 'Td' || token === 'TD' || token === 'T*' || token === 'ET') {
      if (pending.length > 0) out.push(pending.join(''));
      pending = [];
      out.push('\n');
      continue;
    }
    if (/^-?[\d.]+$/.test(token)) continue;

    // Any other operator: whatever was pending was not shown.
    pending = [];
  }

  return out.join('');
}

/** The dictionary immediately before a stream, as text. Bounded, not parsed. */
function dictionaryBefore(source: string, streamAt: number): string {
  const open = source.lastIndexOf('<<', streamAt);
  return open === -1 ? source.slice(Math.max(0, streamAt - 512), streamAt) : source.slice(open, streamAt);
}

function decodeStream(dictionary: string, raw: Buffer): string | null {
  if (!/\/Filter\s*(\[[^\]]*)?\/FlateDecode/.test(dictionary)) {
    // Any other filter (DCT, JPX, LZW, RunLength, an encryption handler) is a
    // stream this module declines to read rather than one it reads badly.
    if (/\/Filter/.test(dictionary)) return null;
    return raw.toString('latin1');
  }
  try {
    return inflateSync(raw).toString('latin1');
  } catch {
    try {
      // Some producers write a raw deflate stream with no zlib header.
      return inflateRawSync(raw).toString('latin1');
    } catch {
      return null;
    }
  }
}

/**
 * The text a PDF already carries, or `null` when it carries none.
 *
 * Never throws. It is handed whatever arrived from a connector, and a parser
 * that throws on a malformed document turns one bad attachment into a failed
 * consolidation phase for the whole brain.
 */
export function extractPdfTextLayer(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;

  const source = latin1(bytes);
  const headerAt = source.slice(0, HEADER_SEARCH_BYTES).indexOf(HEADER);
  if (headerAt === -1) return null;

  const collected: string[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const keyword = source.indexOf('stream', cursor);
    if (keyword === -1) break;
    // `endstream` also contains `stream`; stepping past it is what keeps the
    // walk from re-entering the body it just left.
    if (source.slice(keyword - 3, keyword) === 'end') {
      cursor = keyword + 6;
      continue;
    }

    let start = keyword + 'stream'.length;
    if (source[start] === '\r') start += 1;
    if (source[start] === '\n') start += 1;

    const dictionary = dictionaryBefore(source, keyword);

    // The declared length is exact where a search for `endstream` is a guess —
    // binary image data may contain those bytes.
    const declared = /\/Length\s+(\d+)/.exec(dictionary);
    const end =
      declared === null
        ? source.indexOf('endstream', start)
        : Math.min(start + Number.parseInt(declared[1] as string, 10), source.length);
    if (end === -1 || end < start) break;

    cursor = end;

    // An image is bytes, not text. Reading one would produce a long run of
    // nothing, and occasionally a run that looks like something.
    if (!/\/Subtype\s*\/Image/.test(dictionary)) {
      const decoded = decodeStream(dictionary, Buffer.from(bytes.subarray(start, end)));
      if (decoded !== null) collected.push(showText(decoded));
    }
  }

  const text = collected.join('\n').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  return isTextual(text) ? text.slice(0, MAX_TEXT_CHARS) : null;
}
