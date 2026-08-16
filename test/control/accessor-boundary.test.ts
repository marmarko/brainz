/**
 * The guard U2 names and did not have: **no module outside the storage accessor
 * constructs an object key from request input.**
 *
 * `src/README.md` states it as an invariant that outlives any single unit, and
 * `storage.ts` is written on the assumption that it holds — R9's file-storage
 * claim is "platform-enforced, *conditional on correct prefix derivation*", and
 * the conditional is only satisfied while derivation happens in exactly one
 * place. Until now that was true because there were four source files: the
 * invariant was held by the absence of code, not by a check, and the first
 * `ingest/` or `core/` module could break it silently.
 *
 * Three ways a second derivation site can appear, so the guard looks for three
 * things:
 *
 * 1. **A cast to the branded types.** `TenantPrefix` and `ObjectKey` cannot be
 *    produced outside the accessor *except* by a cast, because that is what a
 *    brand is for. So a cast is the only type-level escape, and it is grep-able.
 * 2. **The layout, written down a second time.** `PREFIX_ROOT` is module-private;
 *    a module that spells `tenants/` into a string is deriving a prefix by hand,
 *    whatever it calls the variable.
 * 3. **The de-branded copy on the control-plane row.** `TenantRecord.storagePrefix`
 *    is a plain `string`, and `schema.sql` persists it. A module that reads
 *    `storage_prefix` and concatenates has derived a key without ever touching a
 *    branded type. Only the accessor and the module that *records* what the
 *    accessor derived may name it.
 *
 * And one rule that is not about object keys at all: **a file containing a NUL
 * byte is a finding.** A single control byte makes a file binary, at which point
 * `grep` reports nothing for it and every grep-shaped check in CI silently skips
 * exactly the file it was pointed at — which is how a guard reports green for a
 * file it never read. This one was live in `test/control/storage.test.ts`, the
 * file that guards the R9 boundary.
 *
 * The scan is `src/**\/*.ts`. Tests are deliberately out of scope: a test may
 * legitimately construct a prefix to assert something about it, and
 * `provision.test.ts` does.
 */

import { describe, expect, test } from 'bun:test';

const REPO_ROOT = `${import.meta.dir}/../..`;
const SRC_DIR = `${REPO_ROOT}/src`;

/** The one module allowed to derive a prefix, a key, or a credential. */
const ACCESSOR = 'src/control/storage.ts';

/**
 * The modules that *record* what the accessor derived, and never re-derive it.
 *
 * `provision.ts` writes `storage_prefix` onto the control-plane row — the
 * schema's own `storage_prefix_belongs_to_this_tenant` CHECK is what pins that.
 * `control-store.ts` is the SQL half of that same write: it maps the column
 * `provision.ts` names onto the statement that stores it, and adds no second
 * opinion about what a prefix looks like. `provisioner.ts` copies the value
 * `prefixFor` handed back onto the record those two persist. `dispatch.ts` and
 * `attestation.ts` put it in U16's isolation receipt, which is a JSON document
 * and therefore cannot carry a branded type across the wire; the prefix reaches
 * them from `prefixFor` and is copied, never constructed.
 *
 * **The exemption is narrower than it looks, deliberately.** It is consulted
 * *after* the cast rule and the `PREFIX_ROOT` literal rule, so a file on this
 * list still cannot cast to `TenantPrefix` and still cannot spell the storage
 * root. All it may do is read a value the accessor already produced — which is
 * the difference between recording a derivation and performing one.
 */
const PREFIX_RECORDERS: readonly string[] = [
  'src/control/provision.ts',
  'src/control/control-store.ts',
  'src/control/provisioner.ts',
  'src/mcp/dispatch.ts',
  'src/mcp/attestation.ts',
];

/** The root segment `storage.ts` keeps private, spelled out here on purpose. */
const PREFIX_ROOT = 'tenants';

const BRANDED_TYPES: readonly string[] = ['TenantPrefix', 'ObjectKey'];

interface SourceFile {
  /** Repo-relative, POSIX separators. */
  readonly path: string;
  readonly text: string;
}

/**
 * Strip comments, keeping string and template literals intact. The rules below
 * are about *code*: prose that says the word "tenants" is not a derivation site,
 * and a guard that cannot tell the difference gets switched off by the first
 * false positive.
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

/** Every string/template literal in the code, contents only. */
function stringLiterals(code: string): string[] {
  const found: string[] = [];
  let i = 0;

  while (i < code.length) {
    const ch = code[i]!;
    if (ch !== "'" && ch !== '"' && ch !== '`') {
      i += 1;
      continue;
    }
    const quote = ch;
    i += 1;
    let literal = '';
    while (i < code.length) {
      const inner = code[i]!;
      i += 1;
      if (inner === '\\') {
        literal += inner;
        if (i < code.length) {
          literal += code[i]!;
          i += 1;
        }
        continue;
      }
      if (inner === quote) break;
      literal += inner;
    }
    found.push(literal);
  }

  return found;
}

/**
 * One finding per way a file could derive an object key outside the accessor.
 * An empty array is the only passing result.
 */
function findKeyDerivationOutsideAccessor(files: readonly SourceFile[]): string[] {
  const findings: string[] = [];

  for (const file of files) {
    // Fail closed on binary before anything else: every rule below is a text
    // scan, and a scan of a file nothing can read reports green.
    if (file.text.includes('\u0000')) {
      findings.push(`${file.path}: contains a NUL byte — text tooling reads this file as binary`);
      continue;
    }

    if (file.path === ACCESSOR) continue;

    const code = stripComments(file.text);

    for (const branded of BRANDED_TYPES) {
      const cast = new RegExp(`\\bas\\s+(?:unknown\\s+as\\s+)?${branded}\\b`);
      if (cast.test(code)) {
        findings.push(
          `${file.path}: casts to ${branded} — the brand is the control, and a cast is the way around it`,
        );
      }
    }

    for (const literal of stringLiterals(code)) {
      if (literal === PREFIX_ROOT || literal.includes(`${PREFIX_ROOT}/`)) {
        findings.push(
          `${file.path}: spells the object-storage root '${PREFIX_ROOT}' — a second derivation site`,
        );
        break;
      }
    }

    if (PREFIX_RECORDERS.includes(file.path)) continue;
    if (/\bstoragePrefix\b|\bstorage_prefix\b/.test(code)) {
      findings.push(
        `${file.path}: reads the de-branded storage_prefix — derive through the accessor instead`,
      );
    }
  }

  return findings;
}

/** Enumerated, not listed: a hardcoded path is a guard that a new file escapes. */
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

describe('no module outside the storage accessor constructs an object key', () => {
  test('the scan actually reads the source tree', () => {
    // A guard whose enumeration silently returns nothing passes forever. This is
    // the same reason `schema.test.ts` asserts its parser found columns.
    expect(SOURCES.length).toBeGreaterThanOrEqual(4);
    expect(SOURCES.map((file) => file.path)).toContain(ACCESSOR);
  });

  test('no source file derives an object key or prefix outside the accessor', () => {
    expect(findKeyDerivationOutsideAccessor(SOURCES)).toEqual([]);
  });

  test('the accessor itself is where the layout lives', () => {
    // The positive control. If this ever fails, the root moved and the rule
    // above is scanning for a literal nothing writes any more — green, and
    // guarding nothing.
    const accessor = SOURCES.find((file) => file.path === ACCESSOR);
    expect(accessor).toBeDefined();
    expect(stringLiterals(stripComments(accessor?.text ?? ''))).toContain(PREFIX_ROOT);
  });
});

describe('the accessor-boundary guard goes red', () => {
  function fixture(path: string, text: string): SourceFile[] {
    return [{ path, text }];
  }

  test('a module that writes the prefix layout by hand fails', () => {
    const findings = findKeyDerivationOutsideAccessor(
      fixture('src/ingest/drive.ts', 'const key = `tenants/${tenantId}/${name}`;\n'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('second derivation site');
  });

  test('a module that casts its way to a branded prefix fails', () => {
    for (const cast of ['raw as TenantPrefix', 'raw as unknown as ObjectKey']) {
      const findings = findKeyDerivationOutsideAccessor(
        fixture('src/core/write.ts', `const p = ${cast};\n`),
      );
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain('the brand is the control');
    }
  });

  test('a module that concatenates the de-branded row copy fails', () => {
    const findings = findKeyDerivationOutsideAccessor(
      fixture('src/core/files.ts', 'const key = `${tenant.storagePrefix}${name}`;\n'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('de-branded');
  });

  test('a file the scan cannot read as text fails, rather than being skipped', () => {
    // F7, generalised. One control byte turned the file guarding R9 into
    // `data`, and every grep in CI reported nothing for it — including,
    // eventually, this one.
    const findings = findKeyDerivationOutsideAccessor(
      fixture('src/core/notes.ts', "const s = 'a\u0000b';\n"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('NUL byte');
  });

  test('prose about tenants is not a finding', () => {
    // The false positive that would get this guard deleted within a week.
    const findings = findKeyDerivationOutsideAccessor(
      fixture(
        'src/control/secrets.ts',
        '/** Sized against ~500 warm tenants per instance. */\n// tenants/alice/ is what the accessor derives\nconst n = 512;\n',
      ),
    );
    expect(findings).toEqual([]);
  });

  test('the accessor is exempt, and only the accessor', () => {
    const line = "const PREFIX_ROOT = 'tenants';\n";
    expect(findKeyDerivationOutsideAccessor(fixture(ACCESSOR, line))).toEqual([]);
    expect(findKeyDerivationOutsideAccessor(fixture('src/control/copy.ts', line))).toHaveLength(1);
  });

  test('the recorder may name the column it records, and nobody else may', () => {
    const line = 'const prefix = record.storagePrefix;\n';
    expect(findKeyDerivationOutsideAccessor(fixture('src/control/provision.ts', line))).toEqual([]);
    expect(findKeyDerivationOutsideAccessor(fixture('src/worker/jobs.ts', line))).toHaveLength(1);
  });
});
