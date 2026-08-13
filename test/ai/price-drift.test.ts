/**
 * The drift guard: **`src/ai/pricing.ts` is the only file under `src/` that may
 * contain a price.**
 *
 * This is the discipline gbrain reached after a 53× cost overrun, and the plan
 * is explicit that adopting it on day one is cheaper than retrofitting it. The
 * mechanism has to be a scan rather than a convention, because the failure is
 * silent by construction: a second copy of a price does not break a test, does
 * not raise an error, and does not diverge from the first copy until the day a
 * vendor changes a number. Then one of the two moves and the other does not,
 * and the first symptom is an invoice.
 *
 * Three rules, because a price can be written down three ways:
 *
 *   A. **Named.** `const RERANK_INPUT_COST = 3_000` — an identifier carrying
 *      price vocabulary, assigned a number. The commonest shape by far.
 *   B. **Copied.** A literal equal to a canonical price (in micro-USD, or in the
 *      dollars-per-million form KTD13 prints), on a line that also carries price
 *      vocabulary. Value alone would be far too noisy — `3000` is a plausible
 *      timeout — so the value and the context must agree.
 *   C. **Re-unitised.** Any identifier naming a *rate per million tokens*.
 *      That unit belongs to one module; a second file that names it is pricing,
 *      whatever it calls the constant.
 *
 * **The bound, stated rather than papered over.** A price written with no price
 * vocabulary anywhere near it (`const K = 3_000`) is invisible to all three
 * rules, and no grep-shaped guard can see it. What the scan earns is that a
 * price cannot be written down *legibly* outside the canonical table — which is
 * the form a second copy actually takes, because whoever writes it wants the
 * next reader to know what the number means.
 *
 * The positive control matters as much as the rules: the same scan run over
 * `pricing.ts` with its exemption removed must produce findings. Without it,
 * a typo in the vocabulary would leave every rule matching nothing, and the
 * guard would report green for a tree it never read.
 */

import { describe, expect, test } from 'bun:test';

import { CANONICAL_PRICING } from '../../src/ai/pricing.ts';

const SRC_DIR = `${import.meta.dir}/../../src`;

/** The one file allowed to hold a price. */
const CANONICAL_TABLE = 'src/ai/pricing.ts';

/**
 * Identifier vocabulary that says "this number is money", matched **per
 * camelCase / snake_case segment** rather than as a substring. `generated`
 * contains `rate`; `separator` nearly contains it; a substring match would
 * produce the kind of false positive that gets a guard deleted in a week.
 */
const MONEY_WORDS: ReadonlySet<string> = new Set(['price', 'prices', 'cost', 'costs', 'usd', 'tariff', 'billing']);

/**
 * Vocabulary that says "this line is about money", used only for the value
 * rule. Deliberately narrower than {@link MONEY_WORDS}: `src/` is already full
 * of comments about cost and latency, and `0.5` is a plausible ranking weight,
 * so the value rule fires only next to an explicit unit.
 */
const PRICE_CONTEXT = /(price|usd|\$|per\s*million|\/\s*M\b)/i;

/** Split an identifier into its camelCase / snake_case words. */
export function identifierWords(identifier: string): string[] {
  return identifier
    .split(/[_$]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

function namesMoney(identifier: string): boolean {
  return identifierWords(identifier).some((word) => MONEY_WORDS.has(word));
}

/** The unit a price is quoted in. Naming it is pricing. */
const RATE_UNIT = /per_?million/i;

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

interface Finding {
  readonly path: string;
  readonly line: number;
  readonly rule: 'named' | 'copied' | 'rate-unit';
  readonly message: string;
}

/**
 * Replace comment bodies with spaces, preserving length and newlines, so a
 * finding's line number still points at the line it came from. String and
 * template literals survive: a price hidden in a string is still a price.
 */
export function blankComments(source: string): string {
  const out: string[] = [];
  let i = 0;

  const keep = (ch: string): void => {
    out.push(ch);
  };
  const blank = (ch: string): void => {
    out.push(ch === '\n' ? '\n' : ' ');
  };

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') blank(source[i++]!);
      continue;
    }
    if (ch === '/' && next === '*') {
      blank(source[i++]!);
      blank(source[i++]!);
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) blank(source[i++]!);
      if (i < source.length) blank(source[i++]!);
      if (i < source.length) blank(source[i++]!);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      keep(source[i++]!);
      while (i < source.length) {
        const inner = source[i]!;
        keep(source[i++]!);
        if (inner === '\\' && i < source.length) {
          keep(source[i++]!);
          continue;
        }
        if (inner === quote) break;
      }
      continue;
    }

    keep(source[i++]!);
    i += 0;
  }

  return out.join('');
}

/** Every numeric literal the canonical table implies, in both quoted units. */
export function canonicalPriceLiterals(): ReadonlySet<number> {
  const values = new Set<number>();
  for (const price of CANONICAL_PRICING.values()) {
    for (const micro of [price.inputMicroUsdPerMillion, price.outputMicroUsdPerMillion]) {
      if (micro === null) continue;
      values.add(micro);
      // The dollars-per-million form KTD13 prints, which is how a human copies
      // a price out of the plan and into a constant.
      values.add(micro / 1_000_000);
    }
  }
  // Zero and one are not prices in any useful sense; every file has them.
  values.delete(0);
  values.delete(1);
  return values;
}

const ASSIGNMENT = /\b([A-Za-z_$][\w$]*)\s*[:=]\s*(-?\d[\d_]*(?:\.\d+)?)/g;
const ANY_NUMBER = /-?\b\d[\d_]*(?:\.\d+)?\b/g;
const IDENTIFIER = /\b[A-Za-z_$][\w$]*\b/g;

export function findPriceLiterals(
  files: readonly SourceFile[],
  exempt: readonly string[] = [CANONICAL_TABLE],
): Finding[] {
  const findings: Finding[] = [];
  const canonical = canonicalPriceLiterals();

  for (const file of files) {
    // Fail closed on binary first: every rule below is a text scan, and a scan
    // of a file nothing can read reports green.
    if (file.text.includes('\u0000')) {
      findings.push({
        path: file.path,
        line: 0,
        rule: 'named',
        message: 'contains a NUL byte — text tooling reads this file as binary',
      });
      continue;
    }
    if (exempt.includes(file.path)) continue;

    const rawLines = file.text.split('\n');
    const codeLines = blankComments(file.text).split('\n');

    for (let index = 0; index < codeLines.length; index += 1) {
      const code = codeLines[index] ?? '';
      const raw = rawLines[index] ?? '';
      const line = index + 1;

      for (const match of code.matchAll(ASSIGNMENT)) {
        const [, name, literal] = match;
        if (name === undefined || literal === undefined) continue;
        if (!namesMoney(name)) continue;
        findings.push({
          path: file.path,
          line,
          rule: 'named',
          message: `${name} = ${literal} — a price named outside ${CANONICAL_TABLE}`,
        });
      }

      for (const match of code.matchAll(ANY_NUMBER)) {
        const literal = match[0];
        const value = Number(literal.split('_').join(''));
        if (!canonical.has(value)) continue;
        if (!PRICE_CONTEXT.test(raw)) continue;
        findings.push({
          path: file.path,
          line,
          rule: 'copied',
          message: `${literal} is a canonical price, copied outside ${CANONICAL_TABLE}`,
        });
      }

      for (const match of code.matchAll(IDENTIFIER)) {
        if (!RATE_UNIT.test(match[0])) continue;
        findings.push({
          path: file.path,
          line,
          rule: 'rate-unit',
          message: `${match[0]} names a per-million rate — that unit belongs to ${CANONICAL_TABLE}`,
        });
      }
    }
  }

  return findings;
}

async function readSource(): Promise<SourceFile[]> {
  const relative = [...new Bun.Glob('**/*.ts').scanSync({ cwd: SRC_DIR })].sort();
  const files: SourceFile[] = [];
  for (const name of relative) {
    files.push({
      path: `src/${name.split('\\').join('/')}`,
      text: await Bun.file(`${SRC_DIR}/${name}`).text(),
    });
  }
  return files;
}

const SOURCES = await readSource();

describe('one canonical pricing table', () => {
  test('the scan reads the source tree, and the table is in it', () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(4);
    expect(SOURCES.map((file) => file.path)).toContain(CANONICAL_TABLE);
    expect(canonicalPriceLiterals().size).toBeGreaterThanOrEqual(8);
  });

  test('no second price literal exists anywhere under src/', () => {
    expect(findPriceLiterals(SOURCES)).toEqual([]);
  });

  test('the rules match the real table — positive control', () => {
    // With the exemption removed the canonical table must trip its own rules.
    // If it does not, the vocabulary has drifted and every assertion above is
    // matching nothing.
    const findings = findPriceLiterals(SOURCES, []);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((finding) => finding.path === CANONICAL_TABLE)).toBe(true);
    expect(new Set(findings.map((finding) => finding.rule))).toEqual(
      new Set(['named', 'copied', 'rate-unit']),
    );
  });
});

describe('the drift guard goes red', () => {
  function fixture(path: string, text: string): SourceFile[] {
    return [{ path, text }];
  }

  test('a named price outside the table fails', () => {
    const findings = findPriceLiterals(fixture('src/core/consolidate.ts', 'const RERANK_COST = 3_000;\n'));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('named');
  });

  test('a copied price with price vocabulary on the line fails', () => {
    const findings = findPriceLiterals(
      fixture('src/worker/budget.ts', 'const glm = 1_400_000; // $/M in\n'),
    );
    expect(findings.some((finding) => finding.rule === 'copied')).toBe(true);
  });

  test('the dollars-per-million form KTD13 prints is caught too', () => {
    const findings = findPriceLiterals(
      fixture('src/core/estimate.ts', 'const perM = 0.049; // usd\n'),
    );
    expect(findings.some((finding) => finding.rule === 'copied')).toBe(true);
  });

  test('re-declaring the rate unit fails', () => {
    const findings = findPriceLiterals(
      fixture('src/core/estimate.ts', 'interface P { inputMicroUsdPerMillion: number }\n'),
    );
    expect(findings.some((finding) => finding.rule === 'rate-unit')).toBe(true);
  });

  test('an unreadable file fails rather than being skipped', () => {
    const findings = findPriceLiterals(fixture('src/core/notes.ts', "const s = 'a\u0000b';\n"));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toContain('NUL byte');
  });

  test('prose about cost is not a finding', () => {
    // The false positive that would get this guard deleted within a week —
    // `src/` already carries a dozen comments about cost.
    const findings = findPriceLiterals(
      fixture(
        'src/control/provision.ts',
        '/** Step 5, a pure cost lever: 3000 ms of suspend timeout. */\nconst suspendTimeoutSeconds = 60;\n',
      ),
    );
    expect(findings).toEqual([]);
  });

  test('an ordinary timeout that happens to equal a price is not a finding', () => {
    const findings = findPriceLiterals(fixture('src/worker/jobs.ts', 'const TIMEOUT_MS = 3_000;\n'));
    expect(findings).toEqual([]);
  });

  test('the canonical table is exempt, and only the canonical table', () => {
    const line = 'const p = { inputMicroUsdPerMillion: 300_000 };\n';
    expect(findPriceLiterals(fixture(CANONICAL_TABLE, line))).toEqual([]);
    expect(findPriceLiterals(fixture('src/ai/gateway.ts', line)).length).toBeGreaterThan(0);
  });
});
