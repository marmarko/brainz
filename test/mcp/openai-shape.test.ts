/**
 * U18 §1 — the `/openai` shape checker, and the projection that is ready and not
 * switched on.
 *
 * `equivalence.test.ts` asserts the live wire against OpenAI's mandate. This file
 * tests the *checker* — because a conformance check that cannot fail is a
 * conformance check nobody should trust, and the way to show it can fail is to
 * hand it payloads that are wrong in each of the four ways the mandate names.
 */

import { describe, expect, test } from 'bun:test';

import {
  OPENAI_FETCH_KEYS,
  OPENAI_SEARCH_RESULT_KEYS,
  openAiShapeFindings,
  strictOpenAiPayload,
} from '../../src/mcp/openai.ts';

const GOOD_SEARCH = {
  results: [{ id: 'chunk:1', title: 'A note', url: 'https://app.brainz.test/r/chunk%3A1' }],
};

const GOOD_FETCH = {
  id: 'chunk:1',
  title: 'A note',
  text: 'the body',
  url: 'https://app.brainz.test/r/chunk%3A1',
  metadata: { source_type: 'email', created_at: '2026-06-01' },
};

describe('the checker passes what the mandate names', () => {
  test('a conforming search payload has no findings', () => {
    expect(openAiShapeFindings('search', GOOD_SEARCH)).toEqual([]);
  });

  test('a conforming fetch payload has no findings', () => {
    expect(openAiShapeFindings('fetch', GOOD_FETCH)).toEqual([]);
  });
});

describe('and fails each of the four ways the mandate can be broken', () => {
  test('a missing field is a finding', () => {
    const findings = openAiShapeFindings('search', {
      results: [{ id: 'chunk:1', url: 'https://x.test/1' }],
    });
    expect(findings.some((f) => f.field === 'results[0].title')).toBe(true);
  });

  test('an EMPTY url is a finding, and it is its own finding', () => {
    // The silent one: a present field that costs the citation and errors
    // nowhere. Folding it into presence would make this pass.
    const findings = openAiShapeFindings('search', {
      results: [{ id: 'chunk:1', title: 'A note', url: '' }],
    });
    expect(findings.some((f) => f.field === 'results[0].url' && f.detail.includes('citation'))).toBe(
      true,
    );
  });

  test('an extra field on a result object is a finding', () => {
    const findings = openAiShapeFindings('search', {
      results: [{ ...GOOD_SEARCH.results[0], untrusted: true }],
    });
    expect(findings.some((f) => f.field === 'results[0].untrusted')).toBe(true);
  });

  test('a fetch payload with no text is a finding', () => {
    const { text: _text, ...withoutText } = GOOD_FETCH;
    const findings = openAiShapeFindings('fetch', withoutText);
    expect(findings.some((f) => f.field === 'text')).toBe(true);
  });

  test('every finding is reported at once, not one at a time', () => {
    // A checker that returned the first problem turns conformance against a
    // four-clause spec into a game of whack-a-mole.
    const findings = openAiShapeFindings('search', { results: [{ url: '' }] });
    expect(findings.length).toBeGreaterThan(2);
  });
});

describe('the strict projection — written, tested, and deliberately not wired', () => {
  test('search keeps exactly the three mandated fields', () => {
    const projected = strictOpenAiPayload('search', {
      ...GOOD_SEARCH,
      results: [{ ...GOOD_SEARCH.results[0], untrusted: true, snippet: 'x' }],
      degraded: { kind: 'index_cold' },
      protocol: '2026-07-28',
    });
    expect(Object.keys(projected)).toEqual(['results']);
    const first = (projected.results as Record<string, unknown>[])[0] ?? {};
    expect(Object.keys(first).sort()).toEqual([...OPENAI_SEARCH_RESULT_KEYS].sort());
    expect(openAiShapeFindings('search', projected)).toEqual([]);
  });

  test('fetch keeps its five and drops the rest', () => {
    const projected = strictOpenAiPayload('fetch', {
      ...GOOD_FETCH,
      untrusted: true,
      protocol: '2026-07-28',
      notice: ['something'],
    });
    expect(Object.keys(projected).sort()).toEqual([...OPENAI_FETCH_KEYS].sort());
    expect(openAiShapeFindings('fetch', projected)).toEqual([]);
  });

  test(
    'the demarcation survives the projection — the protection is in the text, not in the flag',
    () => {
      // The cost of switching this on, stated as a test rather than as a
      // comment: `untrusted` goes, and R2a's markers do not. A client reading
      // the flag rather than the markers would lose its signal, which is
      // exactly why this projection is a deliberate switch and not a rewrite of
      // the handler.
      const wrapped = '<<<UNTRUSTED-CONTENT abc>>>\nmail body\n<<</UNTRUSTED-CONTENT abc>>>';
      const projected = strictOpenAiPayload('fetch', {
        ...GOOD_FETCH,
        text: wrapped,
        untrusted: true,
      });
      expect(projected.text).toBe(wrapped);
      expect(projected.untrusted).toBeUndefined();
    },
  );

  test('it is not wired into the server — turning it on is a decision, not a default', async () => {
    // The claim the re-plan makes, pinned so it cannot quietly stop being true
    // in either direction: if someone wires it, this test says so and they can
    // update the plan; if someone deletes it, the plan's "ready fix" is gone
    // and this says that too.
    const server = await Bun.file(`${import.meta.dir}/../../src/mcp/server.ts`).text();
    expect(server.includes('strictOpenAiPayload')).toBe(false);
  });
});
