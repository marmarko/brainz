/**
 * The invariant `src/README.md` states and nothing enforced until now: **no
 * provider SDK and no raw model endpoint is reachable outside `src/ai/`.**
 *
 * A direct provider call from `core/`, `ingest/` or `worker/` is not a style
 * problem. It is a model call with no routing entry, no pinned id, no price
 * lookup, no budget and no tenant counter — and it does not surface as an
 * error, it surfaces as a bill. That is the failure this whole unit exists to
 * prevent, so the boundary is checked the same way `test/control/accessor-
 * boundary.test.ts` checks the storage accessor: a scan over the source tree,
 * not a type-level assertion. Types are the wrong instrument here — `fetch` is
 * a global, every provider speaks plain HTTPS, and no signature anywhere would
 * have to change for a second caller to appear.
 *
 * Four ways a second call site can appear, so the scan looks for four things:
 *
 *  1. **A provider SDK import.** Bare specifiers only — a relative import of
 *     `../ai/gateway.ts` is the whole point of the module and must stay legal.
 *  2. **An endpoint literal.** The SDK-free version of the same thing: a URL
 *     and a `fetch`. `neon-api.ts` shows the repo already writes HTTP clients
 *     by hand, so this is the likelier shape, not the exotic one.
 *  3. **A raw model id.** `@cf/…` in a string outside `src/ai/` means someone
 *     is naming a model at a call site, which KTD13 forbids even when the call
 *     itself goes through the gateway.
 *  4. **A platform AI binding.** `env.AI.run(...)` needs no import and no URL,
 *     and would sail past the first three rules on Cloudflare's own runtime.
 *
 * Plus the rule that is not about models at all: **a file containing a NUL byte
 * is a finding**, because a single control byte makes a file binary and every
 * grep-shaped check in CI then silently skips exactly the file it was pointed
 * at. That is how a guard reports green for a file it never read, and it has
 * already happened once in this repo.
 *
 * The scan is `src/**\/*.ts`, minus `src/ai/`. Tests are out of scope: a test
 * may legitimately name an endpoint to assert something about it, and this one
 * does.
 */

import { describe, expect, test } from 'bun:test';

const SRC_DIR = `${import.meta.dir}/../../src`;

/** The one directory allowed to reach a model provider. */
const GATEWAY_DIR = 'src/ai/';

/**
 * Provider SDKs, as bare import specifiers. The list is deliberately broader
 * than the vendors KTD13 names: the rule is about the *shape* of the mistake,
 * and a future contributor reaching for `@ai-sdk/openai` has made it whether or
 * not the plan mentions that package.
 */
const PROVIDER_SDKS: readonly string[] = [
  'openai',
  'ai',
  'anthropic',
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  '@google/genai',
  '@google-cloud/vertexai',
  '@ai-sdk/openai',
  '@ai-sdk/google',
  '@ai-sdk/anthropic',
  '@cloudflare/ai',
  'cloudflare:ai',
  'groq-sdk',
  'cohere-ai',
  'replicate',
  'together-ai',
  'ollama',
  '@mistralai/mistralai',
  'langchain',
  'llamaindex',
];

/**
 * Endpoint markers. Each one is a substring of a real inference URL, chosen so
 * that matching it means "this file is about to talk to a model" and nothing
 * else. `api.cloudflare.com` is deliberately absent — U2 already uses the
 * Cloudflare and Neon control APIs for provisioning, and a marker that fires on
 * those is a marker that gets switched off.
 */
const ENDPOINT_MARKERS: readonly string[] = [
  'gateway.ai.cloudflare.com',
  'generativelanguage.googleapis.com',
  'aiplatform.googleapis.com',
  'api.openai.com',
  'openai.azure.com',
  'api.anthropic.com',
  'bedrock-runtime.',
  'api.x.ai',
  'api.groq.com',
  'api.deepseek.com',
  'api.mistral.ai',
  'api.fireworks.ai',
  'openrouter.ai',
  'api.together.xyz',
  '/ai/run/',
  // **Without the version segment**, which is the load-bearing detail. The
  // gateway's own transport spells these paths exactly this way, and says why:
  // the vendors disagree about where `/v1` sits, so the root is the part an
  // operator configures. A marker that insisted on `/v1/` would therefore miss
  // a bypass written in the style of the module it bypasses — the likeliest
  // style there is, since that is the code a contributor copies from.
  '/chat/completions',
  '/embeddings',
  '/v1/messages',
  ':11434',
];

/** A model id written at a call site. */
const MODEL_ID_MARKER = '@cf/';

/**
 * The Workers AI binding: no import, no URL, still a model call. All the ways
 * it is reached — `env.AI.run(…)`, `env['AI'].run(…)`, and the alias a
 * destructure leaves behind (`const ai = env.AI`). The word boundary keeps it
 * off `main.run(…)` and `openai.run(…)`, where the letters appear inside
 * another identifier.
 */
const AI_BINDINGS: readonly RegExp[] = [
  /\bAI\s*\.\s*run\s*\(/i,
  /\[\s*['"]AI['"]\s*\]\s*\.\s*run\s*\(/i,
];

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** Strip comments, keeping string and template literals. Prose is not a call. */
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

/** Every bare import specifier: relative paths are excluded by construction. */
function bareImportSpecifiers(code: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?[^'"]*from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
      found.push(specifier);
    }
  }
  return found;
}

export function findProviderAccessOutsideGateway(files: readonly SourceFile[]): string[] {
  const findings: string[] = [];

  for (const file of files) {
    // Fail closed on binary before anything else: every rule below is a text
    // scan, and a scan of a file nothing can read reports green.
    if (file.text.includes('\u0000')) {
      findings.push(`${file.path}: contains a NUL byte — text tooling reads this file as binary`);
      continue;
    }
    if (file.path.startsWith(GATEWAY_DIR)) continue;

    const code = stripComments(file.text);

    for (const specifier of bareImportSpecifiers(code)) {
      const root = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      if (PROVIDER_SDKS.includes(specifier) || (root !== undefined && PROVIDER_SDKS.includes(root))) {
        findings.push(
          `${file.path}: imports the provider SDK '${specifier}' — every model call goes through ${GATEWAY_DIR}`,
        );
      }
    }

    for (const marker of ENDPOINT_MARKERS) {
      if (code.includes(marker)) {
        findings.push(
          `${file.path}: names the model endpoint '${marker}' — an unmetered call is a bill, not an error`,
        );
      }
    }

    if (code.includes(MODEL_ID_MARKER)) {
      findings.push(
        `${file.path}: names a model id ('${MODEL_ID_MARKER}…') — callers ask for an op, never a model`,
      );
    }

    if (AI_BINDINGS.some((pattern) => pattern.test(code))) {
      findings.push(
        `${file.path}: calls the platform AI binding directly — no routing, no price, no counter`,
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

describe('no model provider is reachable outside the gateway', () => {
  test('the scan actually reads the source tree, gateway included', () => {
    expect(SOURCES.length).toBeGreaterThanOrEqual(4);
    const paths = SOURCES.map((file) => file.path);
    expect(paths).toContain('src/ai/gateway.ts');
    expect(paths).toContain('src/ai/routing.ts');
  });

  test('no source file outside src/ai reaches a provider', () => {
    expect(findProviderAccessOutsideGateway(SOURCES)).toEqual([]);
  });

  test('the markers match what the gateway actually writes — positive control', () => {
    // Run the same rules over `src/ai/` with its exemption removed. If the
    // endpoint list, the SDK list and the model-id marker have all drifted out
    // of date, this comes back empty and every assertion above is scanning for
    // literals nothing in the repo writes.
    const gatewayFiles = SOURCES.filter((file) => file.path.startsWith(GATEWAY_DIR)).map((file) => ({
      path: file.path.slice(GATEWAY_DIR.length),
      text: file.text,
    }));
    const findings = findProviderAccessOutsideGateway(gatewayFiles);
    expect(findings.some((finding) => finding.includes('model endpoint'))).toBe(true);
    expect(findings.some((finding) => finding.includes('model id'))).toBe(true);
  });
});

/**
 * The retention posture KTD13 puts in this module rather than in a console
 * setting nobody owns. Every chunk of the user's mail transits `src/ai/`, so a
 * debug line added during an incident is the one line in the repo that can turn
 * the transport into a content store — outside all five erasure legs.
 */
export function findLoggingInsideGateway(files: readonly SourceFile[]): string[] {
  const findings: string[] = [];
  for (const file of files) {
    if (!file.path.startsWith(GATEWAY_DIR)) continue;
    if (file.text.includes('\u0000')) {
      findings.push(`${file.path}: contains a NUL byte`);
      continue;
    }
    const code = stripComments(file.text);
    if (/\bconsole\s*\.\s*\w+\s*\(/.test(code) || /process\s*\.\s*(stdout|stderr)\s*\.\s*write\s*\(/.test(code)) {
      findings.push(
        `${file.path}: writes to the process log — the gateway emits metering records, never lines`,
      );
    }
  }
  return findings;
}

describe('the gateway never writes to a log', () => {
  test('no file under src/ai logs anything', () => {
    expect(findLoggingInsideGateway(SOURCES)).toEqual([]);
  });

  test('the rule goes red on a debug line', () => {
    expect(
      findLoggingInsideGateway([{ path: 'src/ai/gateway.ts', text: 'console.debug(request);\n' }]),
    ).toHaveLength(1);
    expect(
      findLoggingInsideGateway([
        { path: 'src/ai/gateway.ts', text: 'process.stderr.write(`${prompt}\\n`);\n' },
      ]),
    ).toHaveLength(1);
  });

  test('a comment mentioning console.log is not a log line', () => {
    expect(
      findLoggingInsideGateway([
        { path: 'src/ai/gateway.ts', text: '// never console.log(prompt) here\nconst n = 1;\n' },
      ]),
    ).toEqual([]);
  });
});

describe('the boundary guard goes red', () => {
  function fixture(path: string, text: string): SourceFile[] {
    return [{ path, text }];
  }

  test('an SDK import outside the gateway fails', () => {
    for (const line of [
      "import OpenAI from 'openai';\n",
      "import { generateText } from 'ai';\n",
      "import Anthropic from '@anthropic-ai/sdk';\n",
      "const { GoogleGenAI } = require('@google/genai');\n",
      "const mod = await import('@ai-sdk/openai');\n",
    ]) {
      const findings = findProviderAccessOutsideGateway(fixture('src/core/extract.ts', line));
      expect(findings.length, line).toBeGreaterThan(0);
      expect(findings[0]).toContain('provider SDK');
    }
  });

  test('a hand-rolled endpoint call outside the gateway fails', () => {
    const findings = findProviderAccessOutsideGateway(
      fixture('src/worker/jobs.ts', "await fetch('https://api.openai.com/v1/embeddings', init);\n"),
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]).toContain('model endpoint');
  });

  test('naming a model at a call site fails', () => {
    const findings = findProviderAccessOutsideGateway(
      fixture('src/core/consolidate.ts', "const model = '@cf/zai-org/glm-5.2';\n"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('model id');
  });

  test('the platform binding fails, even with no import and no URL', () => {
    const findings = findProviderAccessOutsideGateway(
      fixture('src/mcp/router.ts', 'const out = await env.AI.run(model, payload);\n'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('platform AI binding');
  });

  test('every bypass written in the gateway\'s own style fails', () => {
    // Each of these was written, run against the guard, and survived it. The
    // first two are the ones that matter most: they are what a contributor
    // produces by copying `gateway.ts`, which spells its paths without the
    // version segment on purpose.
    const evasions: ReadonlyArray<readonly [string, string]> = [
      ['versionless chat path over a configured base', 'await fetch(`${base}/chat/completions`, init);\n'],
      ['versionless embeddings path', "await fetch(base + '/embeddings', init);\n"],
      ['the binding through an index', "await env['AI'].run(model, payload);\n"],
      ['the binding through an alias', 'const ai = env.AI;\nawait ai.run(model, payload);\n'],
      ['bedrock', "await fetch('https://bedrock-runtime.us-east-1.amazonaws.com/model/x/invoke', i);\n"],
      ['azure openai', "await fetch('https://x.openai.azure.com/openai/deployments/y/chat', i);\n"],
      ['vertex', "await fetch('https://us-central1-aiplatform.googleapis.com/v1/projects/x', i);\n"],
      ['deepseek', "await fetch('https://api.deepseek.com/chat/completions', i);\n"],
    ];
    for (const [label, text] of evasions) {
      const findings = findProviderAccessOutsideGateway(fixture('src/core/extract.ts', text));
      expect(findings.length, label).toBeGreaterThan(0);
    }
  });

  test('an ordinary route path is not a provider call', () => {
    // The false positive the versionless markers could produce: this repo
    // serves HTTP too, and `/messages` or `/embed` as a local route must not
    // read as a model endpoint.
    for (const line of [
      "router.post('/messages', handler);\n",
      "router.get('/embed', handler);\n",
      "if (url.pathname === '/completions') return handler(request);\n",
    ]) {
      expect(findProviderAccessOutsideGateway(fixture('src/mcp/router.ts', line)), line).toEqual([]);
    }
  });

  test('a file the scan cannot read as text fails, rather than being skipped', () => {
    const findings = findProviderAccessOutsideGateway(
      fixture('src/core/notes.ts', "const s = 'a\u0000b';\n"),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('NUL byte');
  });

  test('importing the gateway itself is exactly what callers should do', () => {
    const findings = findProviderAccessOutsideGateway(
      fixture('src/core/write/embed.ts', "import { createModelGateway } from '../../ai/gateway.ts';\n"),
    );
    expect(findings).toEqual([]);
  });

  test('prose about OpenAI is not a call', () => {
    const findings = findProviderAccessOutsideGateway(
      fixture(
        'src/core/write/embed.ts',
        '/** KTD8: embeddings come from openai, via https://api.openai.com/v1/embeddings. */\nconst n = 1;\n',
      ),
    );
    expect(findings).toEqual([]);
  });

  test('the provisioning control APIs are not model endpoints', () => {
    // The false positive that would get this guard deleted: U2 legitimately
    // calls Neon's and Cloudflare's control planes over plain HTTPS.
    const findings = findProviderAccessOutsideGateway(
      fixture(
        'src/control/neon-api.ts',
        "await fetch('https://console.neon.tech/api/v2/projects', init);\n" +
          "await fetch('https://api.cloudflare.com/client/v4/accounts/x/r2/buckets', init);\n",
      ),
    );
    expect(findings).toEqual([]);
  });

  test('the gateway is exempt, and only the gateway', () => {
    const line = "const base = 'https://gateway.ai.cloudflare.com/v1';\n";
    expect(findProviderAccessOutsideGateway(fixture('src/ai/gateway.ts', line))).toEqual([]);
    expect(findProviderAccessOutsideGateway(fixture('src/core/gateway.ts', line))).toHaveLength(1);
  });
});
