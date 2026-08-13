/**
 * The path gate: which upstream changes are brainz's problem, and which are not.
 *
 * Two failure directions, and the tests below hold both open.
 *
 * **Letting something through as out-of-scope silently.** An upstream path the
 * gate has never heard of must not be dropped. gbrain adds directories; a gate
 * that answers "not ours" for anything it does not recognise is a gate that goes
 * quiet exactly when upstream does something new. Unknown paths under `src/`
 * therefore land in a named `unmapped` area and reach the ledger at low
 * confidence, rather than disappearing.
 *
 * **Claiming scope where there is none.** brainz has no CLI, no skillpacks and no
 * operator SPA, and the ledger already records those as `oos.*` rows. A gate that
 * routes `src/commands/` into the ledger would refill it with decisions already
 * taken. Every out-of-scope verdict therefore carries the reason, so the report
 * says why rather than just how many.
 */

import { describe, expect, test } from 'bun:test';

import { AREAS, gatePath, type Area } from '../../src/upstream/path-gate.ts';

describe('in-scope paths', () => {
  test('retrieval, schema and the wire surface are brainz areas', () => {
    expect(gatePath('src/core/search/rrf.ts')).toMatchObject({ in_scope: true, area: 'retrieval' });
    expect(gatePath('src/core/vector-index.ts')).toMatchObject({ in_scope: true, area: 'schema' });
    expect(gatePath('src/mcp/server.ts')).toMatchObject({ in_scope: true, area: 'mcp-surface' });
  });

  test('an area carries the criticality and priority a discovered row will use', () => {
    const gated = gatePath('src/core/search/rrf.ts');
    expect(gated.in_scope).toBe(true);
    if (!gated.in_scope) throw new Error('unreachable');
    expect(gated.criticality).toBe('critical');
    expect(gated.priority).toBe('p1');
  });

  test('the worker, ingest, consolidation and routing areas all resolve', () => {
    const expected: ReadonlyArray<readonly [string, Area]> = [
      ['src/core/minions/handlers/embed-backfill.ts', 'worker'],
      ['src/core/ingestion/pull.ts', 'ingest'],
      ['src/core/cycle/synthesize.ts', 'consolidation'],
      ['src/core/ai/gateway.ts', 'ai-routing'],
      ['src/core/budget/estimate.ts', 'spend'],
    ];
    for (const [path, area] of expected) {
      expect(gatePath(path)).toMatchObject({ in_scope: true, area });
    }
  });
});

describe('out-of-scope paths carry their reason', () => {
  test('the CLI is out of scope because brainz has no CLI', () => {
    const gated = gatePath('src/commands/search.ts');
    expect(gated.in_scope).toBe(false);
    if (gated.in_scope) throw new Error('unreachable');
    expect(gated.reason).toMatch(/CLI/i);
  });

  test('surfaces the ledger already declined point back at their `oos.` row', () => {
    for (const path of ['skills/query.md', 'src/core/skillpack/build.ts', 'src/core/thin-client/route.ts']) {
      const gated = gatePath(path);
      expect(gated.in_scope).toBe(false);
      if (gated.in_scope) throw new Error('unreachable');
      expect(gated.reason).toMatch(/oos\./);
    }
  });

  test("upstream's own tests and docs are not concepts", () => {
    expect(gatePath('test/gateway.test.ts').in_scope).toBe(false);
    expect(gatePath('docs/ENGINES.md').in_scope).toBe(false);
    expect(gatePath('CHANGELOG.md').in_scope).toBe(false);
  });
});

describe('an unrecognised upstream path is a finding, not a shrug', () => {
  test('an unknown `src/` path lands in the unmapped area, in scope', () => {
    const gated = gatePath('src/core/some-future-thing/index.ts');
    expect(gated.in_scope).toBe(true);
    if (!gated.in_scope) throw new Error('unreachable');
    expect(gated.area).toBe('unmapped');
    // Low, because the only thing the gate knows is that it does not know.
    expect(gated.confidence).toBe('low');
  });

  test('a known area is more than low confidence, or the signal is worthless', () => {
    const gated = gatePath('src/core/search/rrf.ts');
    if (!gated.in_scope) throw new Error('unreachable');
    expect(gated.confidence).not.toBe('low');
  });

  test('every declared area is reachable from some path — no dead enum members', () => {
    // A dead area is a mapping somebody deleted without deleting its label, and
    // it would make the report's area histogram lie by omission.
    const reached = new Set<Area>();
    const probes = [
      'src/core/search/rrf.ts',
      'src/core/vector-index.ts',
      'src/mcp/server.ts',
      'src/core/minions/queue.ts',
      'src/core/ingestion/pull.ts',
      'src/core/cycle/synthesize.ts',
      'src/core/ai/gateway.ts',
      'src/core/budget/estimate.ts',
      'src/core/eval/replay.ts',
      'src/core/some-future-thing/index.ts',
    ];
    for (const path of probes) {
      const gated = gatePath(path);
      if (gated.in_scope) reached.add(gated.area);
    }
    expect([...reached].sort()).toEqual([...AREAS].sort());
  });
});
