/**
 * U18's context grants have no producer, and this file is where that stops
 * being true quietly.
 *
 * The fence is real: `src/mcp/grant-scope.ts` defines what a narrowed grant is,
 * `dispatch.ts` derives the read fence from it, `test/mcp/context-grants.test.ts`
 * drives every tool on both endpoints against planted rows and proves a `work:*`
 * grant reaches none of the personal ones. What does not exist is anything that
 * *writes* a `work:` row. Connectors file at `pipedream:<source>`; the only
 * context-class origin any production path emits is `personal:agent`, plus the
 * `<class>:agent` a narrowed grant's own `remember` lands at. So on a real brain
 * a work-scoped grant expands to `['work:agent']` and reads back exactly the
 * memories it wrote itself.
 *
 * **A passing fence suite is therefore not the capability**, and the gap between
 * the two is the kind that gets forgotten because everything is green. Three
 * places say so — the module docstring, the ledger row, and the fence suite's
 * own header — and prose drifts. This file is the part that cannot: it pins the
 * producer set, so the day somebody teaches a connector to file at a context
 * class, this test fails and points at the three statements that have just
 * become false.
 *
 * It is deliberately **not** an assertion that the producer is missing forever.
 * It is an assertion that the producer set is *known*, and a demand that adding
 * to it is a decision somebody makes on purpose.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every origin literal in code, comments excluded.
 *
 * The strip is crude — block comments, line comments — and that is enough here,
 * because the thing it exists to exclude is prose *about* origins, which this
 * repo now has a lot of (including three paragraphs written to document exactly
 * the gap this file pins). A regex over raw source would match its own
 * documentation and pass forever.
 */
function codeWithoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (path.endsWith('.ts')) out.push(path);
  }
  return out.sort();
}

/** `class:source`, quoted, as the grammar in `grant-scope.ts` defines it. */
const CONTEXT_ORIGIN_LITERAL = /'(work|personal):[a-z][a-z0-9_.-]*'/g;

describe('the context-grant vocabulary has exactly one producer in src/', () => {
  test('and it is the default write origin, not a connector', async () => {
    const found: string[] = [];
    for (const file of sourceFiles('src')) {
      const code = codeWithoutComments(await Bun.file(file).text());
      for (const match of code.matchAll(CONTEXT_ORIGIN_LITERAL)) {
        found.push(`${file}: ${match[0]}`);
      }
    }

    // One entry. Not "at most one" and not a `toContain`: the assertion is over
    // the whole set, so a second producer arriving anywhere in `src/` fails here
    // rather than widening a grant nobody re-read the docs for.
    expect(found).toEqual(["src/mcp/dispatch.ts: 'personal:agent'"]);
  });

  test('connectors file at a class no context grant can name', async () => {
    // `pipedream:<source>` — the class is `pipedream`, and `classOf` matches on
    // exact string equality before the first colon, so no `work:*` or
    // `personal:*` grant expands to reach it. This is the whole reason the
    // capability is unreachable, and it is asserted rather than assumed because
    // changing this one line is how it would become reachable.
    const pull = await Bun.file('src/ingest/pipedream/pull.ts').text();
    expect(pull).toContain('return `pipedream:${source}`');
  });

  test('the ledger says the same thing, in the row that would otherwise read as covered', async () => {
    const ledger = await Bun.file('upstream/concepts.jsonl').text();
    const row = ledger
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { id: string; status: string; notes?: string })
      .find((entry) => entry.id === 'gap.context-injection-gate');

    expect(row?.status).toBe('not-yet');
    // The specific sentence, because a row that merely mentions origins would
    // satisfy a looser check while saying nothing a reader could act on.
    expect(row?.notes ?? '').toContain('the context grants have no producer');
  });

  test('and so does the fence suite, so a green run there is not read as the capability', async () => {
    const suite = await Bun.file('test/mcp/context-grants.test.ts').text();
    expect(suite).toContain('planted by this fixture, in SQL');
  });
});
