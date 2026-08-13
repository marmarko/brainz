/**
 * The gold key U11's exit gate would score the `vision` op against.
 *
 * **Why this file exists rather than a folder of screenshots.** Every other op
 * in the exit gate names a committed fixture as its gold — the extraction key,
 * the entity key, the corpus. Transcription had none, so the op sat outside the
 * gate entirely: implemented, routed, priced, and covered by no line that would
 * ever produce a receipt (`docs/alpha-exit.md` B5 recorded exactly that). A gate
 * naming a gold that does not exist would have been the same hole with a tick
 * next to it, so the gold is built here, in code, and the images are real.
 *
 * **Generated rather than checked in as binaries**, for the reason
 * `test/media/fixture.ts` assembles its PDFs instead of shipping them: a binary
 * fixture is a thing nobody can read in a diff and nobody can regenerate when it
 * rots. Every image below is produced by the encoder in this file from the text
 * beside it, so the gold answer is *by construction* the text the image
 * contains — there is no second place for the two to disagree.
 *
 * **What these images are.** Machine-rendered text on a plain ground, which is
 * what U21 says the dominant consumer image is: "the dominant consumer image is
 * a screenshot, which is mostly text". They are deliberately not photographs.
 * Scoring transcription of a photograph would measure interpretation, which U21
 * step 3 names as explicitly not the goal.
 *
 * **What this gold cannot tell you.** It is synthetic, so a model that reads
 * these perfectly has been shown to read *clean rendered glyphs* — not a JPEG of
 * a phone screen at an angle. It is the floor, not the ceiling, and the founder's
 * own alpha screenshots are what replaces it. Recorded here rather than left to
 * be discovered from a green tick.
 *
 * No model is called from this file and nothing here is scored yet: the exit
 * gate is deferred for want of an authorised spend, and this is the key the run
 * would grade against when that changes.
 */

import { deflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// A 5x7 bitmap font, and the smallest PNG encoder that produces a real one.
// ---------------------------------------------------------------------------

/**
 * The glyphs, one row of five cells per line, `#` set and `.` clear.
 *
 * Uppercase only, and the gold text below is written to match: a font with one
 * case is a font whose expected transcript cannot drift from what was drawn.
 */
const GLYPHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '####.', '#...#', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '####.', '#....', '#....', '#....', '#####'],
  F: ['#####', '#....', '####.', '#....', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#...#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  Q: ['.###.', '#...#', '#...#', '#...#', '#.#.#', '#..#.', '.##.#'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  W: ['#...#', '#...#', '#...#', '#...#', '#.#.#', '##.##', '#...#'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  Z: ['#####', '....#', '...#.', '..#..', '.#...', '#....', '#####'],
  '0': ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  '1': ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '#####'],
  '2': ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  '3': ['#####', '...#.', '..#..', '...#.', '....#', '#...#', '.###.'],
  '4': ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  '5': ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  '6': ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  '7': ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  '8': ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  '9': ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '-': ['.....', '.....', '.....', '#####', '.....', '.....', '.....'],
  ':': ['.....', '..#..', '..#..', '.....', '..#..', '..#..', '.....'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
});

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
/** Blank columns between glyphs, and blank rows between lines. */
const TRACKING = 1;
const LEADING = 3;
/** Pixels per font cell. Small enough to stay a screenshot, large enough to read. */
const SCALE = 3;
const MARGIN = 8;

/** The characters the font can draw. Gold text outside this set is a fault. */
export const DRAWABLE = Object.keys(GLYPHS).join('');

const CRC_TABLE: readonly number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typed = new Uint8Array(type.length + data.length);
  for (let i = 0; i < type.length; i += 1) typed[i] = type.charCodeAt(i);
  typed.set(data, type.length);

  const out = new Uint8Array(8 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typed, 4);
  view.setUint32(out.length - 4, crc32(typed));
  return out;
}

/**
 * An 8-bit greyscale PNG from a pixel plane. Real enough for a decoder.
 *
 * Greyscale rather than RGB because the glyphs are one ink on one ground, and a
 * three-channel image would triple the bytes to say the same thing. Filter byte
 * 0 on every scanline: the encoder's job here is correctness, not compression.
 */
function encodePng(width: number, height: number, plane: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    raw.set(plane.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, width);
  header.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type: greyscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw)))),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const png = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

/** Draw the lines and return the image. Dark ink on a light ground. */
export function renderTextPng(lines: readonly string[]): Uint8Array {
  const columns = Math.max(...lines.map((line) => line.length), 1);
  const width = MARGIN * 2 + columns * (GLYPH_WIDTH + TRACKING) * SCALE;
  const height =
    MARGIN * 2 + lines.length * (GLYPH_HEIGHT + LEADING) * SCALE - LEADING * SCALE;

  const plane = new Uint8Array(width * height).fill(0xf5);

  lines.forEach((line, lineIndex) => {
    const top = MARGIN + lineIndex * (GLYPH_HEIGHT + LEADING) * SCALE;
    [...line].forEach((character, columnIndex) => {
      const glyph = GLYPHS[character];
      if (glyph === undefined) {
        throw new Error(`the transcription gold cannot draw ${JSON.stringify(character)}`);
      }
      const left = MARGIN + columnIndex * (GLYPH_WIDTH + TRACKING) * SCALE;
      glyph.forEach((row, rowIndex) => {
        [...row].forEach((cell, cellIndex) => {
          if (cell !== '#') return;
          for (let dy = 0; dy < SCALE; dy += 1) {
            for (let dx = 0; dx < SCALE; dx += 1) {
              const y = top + rowIndex * SCALE + dy;
              const x = left + cellIndex * SCALE + dx;
              plane[y * width + x] = 0x14;
            }
          }
        });
      });
    });
  });

  return encodePng(width, height, plane);
}

// ---------------------------------------------------------------------------
// The gold.
// ---------------------------------------------------------------------------

export interface TranscriptionGold {
  readonly id: string;
  /** What is drawn, one entry per line. The expected transcript, in order. */
  readonly lines: readonly string[];
  /** Why this shape is in the sample. */
  readonly note: string;
}

/**
 * Eight images, each a shape U21 was written for.
 *
 * Sized as a sample rather than a corpus: the metric is per-image, the images
 * are homogeneous by construction, and every one of them costs a reserved
 * `maxOutputTokens` in the committed estimate. The first entry is the one U21
 * names by hand — "find the screenshot with the wifi password" — and it is here
 * because a gold that did not contain the plan's own worked example would be a
 * gold chosen to be easy.
 */
export const TRANSCRIPTION_GOLD: readonly TranscriptionGold[] = Object.freeze([
  {
    id: 'wifi-password',
    lines: ['GUEST NETWORK', 'SSID: HARBOUR-GUEST', 'PASSWORD: TRQ7-4KDN-92XM'],
    note: 'U21 step 3’s worked example, verbatim: the screenshot with the wifi password.',
  },
  {
    id: 'booking-reference',
    lines: ['BOOKING CONFIRMED', 'REFERENCE: 8QN4LM', 'DEPARTS 2026-09-04 07:45'],
    note: 'A short code and a date — the two things a transcript is asked for most often.',
  },
  {
    id: 'error-dialog',
    lines: ['CONNECTION FAILED', 'ERROR 0X8007045D', 'RETRY OR CONTACT SUPPORT'],
    note: 'A hex code: adjacent glyph shapes a near-miss transcript would confuse.',
  },
  {
    id: 'invoice-total',
    lines: ['INVOICE 2026-0417', 'SUBTOTAL 1240.00', 'VAT 20 PERCENT 248.00', 'TOTAL DUE 1488.00'],
    note: 'Four lines with decimals — reading order matters as much as the digits.',
  },
  {
    id: 'meeting-whiteboard',
    lines: ['Q4 PRIORITIES', 'ONE: RETENTION', 'TWO: ONBOARDING', 'THREE: PRICING'],
    note: 'A list. A model that summarises rather than transcribes collapses it.',
  },
  {
    id: 'shipping-label',
    lines: ['TRACKING', 'RC 4471 8820 6 GB', 'DELIVER BY 2026-08-21'],
    note: 'Grouped digits, where a transcript that helpfully reflows loses the grouping.',
  },
  {
    id: 'terminal-output',
    lines: ['MIGRATION 6 APPLIED', 'ROWS TOUCHED: 0', 'ELAPSED 41 MS'],
    note: 'Monospaced-looking output, including a zero that is not the letter O.',
  },
  {
    id: 'blank-notice',
    lines: ['   '],
    note:
      'Nothing legible. The one case whose gold answer is the empty transcript — ' +
      'and the case `ocr-phase.ts` records as `""` rather than NULL so it is never re-read.',
  },
]);

/** The image for one gold entry, built from the very text it is graded against. */
export function goldImage(entry: TranscriptionGold): Uint8Array {
  return renderTextPng(entry.lines);
}

/** The transcript a perfect reader returns: the drawn lines, joined. */
export function goldTranscript(entry: TranscriptionGold): string {
  return entry.lines.join('\n').trim();
}
