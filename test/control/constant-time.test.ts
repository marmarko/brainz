/**
 * One constant-time string comparison in the whole source tree.
 *
 * `src/control/accounts.ts` exports `constantTimeEqual` and its own comment says
 * why: *"Exported because `src/web/` needs it and there must not be a second
 * copy."* That sentence was aspirational — `src/mcp/oauth.ts` carried a private
 * copy of the same four lines, and `verifyTenantBearer` open-coded them a third
 * time. Three implementations of a constant-time compare is how one of them
 * quietly stops being constant-time: a contributor "simplifying" a digest away,
 * or adding an early `if (a.length !== b.length) return false`, fixes one call
 * site and leaves the others answering the length of a bearer token.
 *
 * **The guard is a scan, not a type.** Nothing about the signature would have to
 * change for a fourth copy to appear — it is four lines of `node:crypto` that
 * any file can write — so the check has the same shape as
 * `test/ai/boundary.test.ts` and `test/control/accessor-boundary.test.ts`: read
 * the source tree, strip the prose, look for the mistake.
 *
 * Two ways a second copy appears, so the scan looks for two things:
 *
 *   1. **The name, declared twice.** The literal duplicate that was here.
 *   2. **The body, under another name.** A renamed copy evades rule 1 entirely,
 *      and the body has a recognisable shape: digest *both* sides with sha256 so
 *      the buffers are equal-length, then `timingSafeEqual`. That pairing is the
 *      primitive; a file that spells it out has written a second copy whatever
 *      it called the function.
 *
 * **What is deliberately not a finding.** `timingSafeEqual` on its own is used
 * across the repo on values that are already fixed-length by construction — an
 * HMAC hex digest (`attestation.ts`, `panel-token.ts`, `billing.ts`), a
 * hex-decoded stored digest (`ingest/pipedream/client.ts`). Those are not string
 * comparisons and routing them through a string primitive would be a
 * re-encoding, not a consolidation. The rule is about the *digest-both-sides*
 * shape, which exists only because the inputs are caller-supplied strings of
 * unknown length.
 */

import { describe, expect, test } from 'bun:test';

const SRC_DIR = `${import.meta.dir}/../../src`;

/** The one module allowed to implement it. */
const OWNER = 'src/control/accounts.ts';

/** Rule 1: the name, declared. Any of the three ways TypeScript spells it. */
const DECLARATIONS: readonly RegExp[] = [
  /\bfunction\s+constantTimeEqual\s*\(/,
  /\bconst\s+constantTimeEqual\s*[:=]/,
  /\blet\s+constantTimeEqual\s*[:=]/,
];

/**
 * Rule 2: the body, under any name.
 *
 * Two sha256 digests and a `timingSafeEqual` inside one small window. The window
 * is characters rather than lines so a reformat cannot slip under it, and it is
 * short enough that two unrelated digests elsewhere in a long file do not pair
 * up by accident.
 */
const DIGEST_PAIR =
  /createHash\(\s*(['"])sha256\1\s*\)[\s\S]{0,240}?createHash\(\s*(['"])sha256\2\s*\)[\s\S]{0,240}?timingSafeEqual\s*\(/;

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/**
 * Strip comments, keeping string and template literals.
 *
 * Prose is not an implementation: this very file names the shape it forbids, and
 * so does the docstring above `constantTimeEqual` itself.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < source.length) {
        const inner = source[i]!;
        out += inner;
        i += 1;
        if (inner === '\\') {
          if (i < source.length) {
            out += source[i]!;
            i += 1;
          }
          continue;
        }
        if (inner === quote) break;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

export function findSecondCopies(files: readonly SourceFile[]): string[] {
  const findings: string[] = [];

  for (const file of files) {
    // Fail closed on binary before anything else: every rule below is a text
    // scan, and a scan of a file nothing can read reports green.
    if (file.text.includes('\u0000')) {
      findings.push(`${file.path}: contains a NUL byte — text tooling reads this file as binary`);
      continue;
    }
    if (file.path === OWNER) continue;

    const code = stripComments(file.text);

    if (DECLARATIONS.some((pattern) => pattern.test(code))) {
      findings.push(
        `${file.path}: declares constantTimeEqual — import it from ${OWNER}, which exists so there is one`,
      );
    }

    if (DIGEST_PAIR.test(code)) {
      findings.push(
        `${file.path}: digests both sides and calls timingSafeEqual — that is ${OWNER}'s primitive ` +
          'written a second time under another name',
      );
    }
  }

  return findings;
}

/** Enumerated, not listed: a hardcoded path is a guard a new file escapes. */
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

describe('there is one constant-time string comparison', () => {
  test('the scan reads the source tree, owner included', () => {
    const paths = SOURCES.map((file) => file.path);
    expect(paths).toContain(OWNER);
    expect(paths).toContain('src/mcp/oauth.ts');
    expect(paths).toContain('src/web/app.ts');
  });

  test('the owner really does implement it, so the exemption is not vacuous', async () => {
    const owner = stripComments(await Bun.file(`${SRC_DIR}/control/accounts.ts`).text());
    expect(DECLARATIONS.some((pattern) => pattern.test(owner))).toBe(true);
    expect(DIGEST_PAIR.test(owner)).toBe(true);
    // And it is reachable by the modules that need it, which is the whole reason
    // it is exported rather than private.
    expect(owner).toMatch(/export\s+function\s+constantTimeEqual/);
  });

  test('no other module implements it, under that name or another', () => {
    expect(findSecondCopies(SOURCES)).toEqual([]);
  });
});
