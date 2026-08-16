/**
 * U18's context grants have a producer now, and this file is where that stops
 * being a claim anybody has to take on trust.
 *
 * ============================================================================
 * WHAT CHANGED, AND WHY THIS FILE STILL EXISTS
 * ============================================================================
 *
 * The fence was always real: `src/mcp/grant-scope.ts` defines what a narrowed
 * grant is, `dispatch.ts` derives the read fence from it, and
 * `test/mcp/context-grants.test.ts` drives every tool on both endpoints against
 * planted rows and proves a `work:*` grant reaches none of the personal ones.
 * What did not exist was anything that *wrote* a `work:` row. Connectors filed
 * at `pipedream:<source>`; the only context-class origins any production path
 * emitted were `personal:agent` and the `<class>:agent` a narrowed grant's own
 * `remember` lands at. So on a real brain a work-scoped grant expanded to
 * `['work:agent']` and read back exactly the memories it wrote itself.
 *
 * `ConnectorState.contextClass` (`src/ingest/cursor.ts`) is the producer:
 * recorded on the connection, it makes every page, chunk and fact that source
 * writes carry `<class>:<source>`.
 * `test/ingest/pipedream/context-origin.test.ts` proves the round trip through
 * the real `expandGrant` and the real fence.
 *
 * **So the demand this file makes has moved rather than gone.** It is not "there
 * is no producer" and never was — it is that **the producer set is known**, and
 * that adding to it is a decision somebody makes on purpose. Three things say
 * what the set is: the two producers below, and the ledger row. Prose drifts;
 * these assertions do not.
 *
 * The connector producer is asserted **behaviourally** rather than by grepping
 * for a string, because it is built from a value at runtime — the whole point is
 * that no source name is hardcoded to a class, so there is no literal to find.
 */

import { describe, expect, test } from 'bun:test';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { isContextClass } from '../../src/ingest/cursor.ts';
import { originContextFor } from '../../src/ingest/pipedream/pull.ts';

/**
 * Every origin literal in code, comments excluded.
 *
 * The strip is crude — block comments, line comments — and that is enough here,
 * because the thing it exists to exclude is prose *about* origins, which this
 * repo now has a lot of (including several paragraphs written to document
 * exactly this seam). A regex over raw source would match its own documentation
 * and pass forever.
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

describe('the context-grant vocabulary has exactly two producers in src/', () => {
  test('no context origin is hardcoded anywhere but the default write origin', async () => {
    const found: string[] = [];
    for (const file of sourceFiles('src')) {
      const code = codeWithoutComments(await Bun.file(file).text());
      for (const match of code.matchAll(CONTEXT_ORIGIN_LITERAL)) {
        found.push(`${file}: ${match[0]}`);
      }
    }

    // One entry. Not "at most one" and not a `toContain`: the assertion is over
    // the whole set, so a *hardcoded* context origin arriving anywhere in `src/`
    // fails here rather than widening a grant nobody re-read the docs for. In
    // particular a connector must never name a class — which mailbox is work is
    // a user's answer, not a constant.
    expect(found).toEqual(["src/mcp/dispatch.ts: 'personal:agent'"]);
  });

  test('the connector producer is the recorded class, and nothing else', () => {
    // The second producer, asserted as behaviour because it has no literal. A
    // connection that recorded a class files there; one that did not keeps the
    // vendor class, which no `work:*` or `personal:*` grant can name (`classOf`
    // matches on exact string equality before the first colon).
    expect(originContextFor('gmail', 'work')).toBe('work:gmail');
    expect(originContextFor('calendar', 'personal')).toBe('personal:calendar');
    expect(originContextFor('gmail', null)).toBe('pipedream:gmail');

    // And the class it will accept is U18's grammar rather than a second one —
    // the guard that stops `Work`, `work:mail` or `''` reaching the one column
    // access is decided on.
    expect(isContextClass('work')).toBe(true);
    expect(isContextClass('Work')).toBe(false);
    expect(isContextClass('work:mail')).toBe(false);
    expect(isContextClass('')).toBe(false);
  });

  test('the ledger says the same thing, in the row that would otherwise read as covered', async () => {
    const ledger = await Bun.file('upstream/concepts.jsonl').text();
    const row = ledger
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { id: string; status: string; notes?: string })
      .find((entry) => entry.id === 'gap.context-injection-gate');

    // Still `not-yet`, and the row says why: a producer that no connect flow can
    // reach is a seam rather than a capability. `connectSource` has no caller in
    // `src/` at all, so no user can yet obtain a work-origin connector.
    expect(row?.status).toBe('not-yet');
    // The specific sentence, because a row that merely mentions origins would
    // satisfy a looser check while saying nothing a reader could act on.
    expect(row?.notes ?? '').toContain('no connect flow can reach it');
  });

  test('and so does the fence suite, so a green run there is not read as the capability', async () => {
    const suite = await Bun.file('test/mcp/context-grants.test.ts').text();
    expect(suite).toContain('planted by this fixture, in SQL');
  });
});
