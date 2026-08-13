/**
 * Stage 3a — the origin fence, which every recall arm routes through.
 *
 * **KTD5 is the whole content of this file: origin informs nothing about access
 * except access.** Source-type priors and trust levels are ranking inputs and
 * they arrive later in the stack; the fence evaluates the immutable
 * `origin_context` and nothing else. Subject inference — R15's mutable,
 * confidence-scored half — never widens what a credential can see, which is a
 * property that has to be *asserted*, because the natural implementation (one
 * "context" field consulted everywhere) satisfies every other test in this
 * suite.
 *
 * **Three row shapes, three rules, and one uniform rule would be wrong.** The
 * schema spells origin two ways: scalar on ingested rows (`chunk`, `page`) and
 * an array on derived ones (`fact`, `entity_edge`, `entity`). A single
 * subset-everywhere rule refuses to resolve a project entity that appears in
 * both a work and a personal origin, which silently disables the graph arm on
 * precisely the relational queries it exists for. A single intersect-everywhere
 * rule leaks: a fact synthesized from a personal input would surface under a
 * work grant. So:
 *
 *   - **scalar** (chunk, page): the origin is in the grant.
 *   - **subset** (fact, edge): *every* contributing origin is in the grant,
 *     because the row's content is a synthesis of all of them.
 *   - **intersect** (entity): at least one, because an entity is a name, and a
 *     name that a credential legitimately saw is a name that credential may use
 *     as a search key. What it may then *read* is fenced again, by the two rules
 *     above, on the rows the fan-out returns.
 *
 * The intersect rule is the one that could be abused, so the last block below
 * pins the property that makes it safe: resolving an entity through a shared
 * origin never returns a row from the origin the credential does not hold.
 */

import { describe, expect, test } from 'bun:test';

import {
  fenceEntity,
  fenceRow,
  fenceScalar,
  visibleUnder,
  type Grant,
} from '../../../src/core/search/fence.ts';
import type { Candidate } from '../../../src/core/search/types.ts';

const PERSONAL: Grant = ['personal:mail', 'personal:files'];
const WORK: Grant = ['work:mail', 'work:files'];
const BOTH: Grant = [...PERSONAL, ...WORK];

function candidate(overrides: Partial<Candidate> & Pick<Candidate, 'id' | 'origin'>): Candidate {
  return {
    pageId: 'p-x',
    ordinal: 0,
    title: 'A page',
    content: 'body',
    sourceType: 'document',
    createdAt: '2026-06-01',
    live: true,
    attestations: [],
    entityIds: [],
    ...overrides,
  };
}

describe('scalar origins — chunks and pages', () => {
  test('in-grant passes, out-of-grant does not', () => {
    expect(fenceScalar('personal:mail', PERSONAL)).toBe(true);
    expect(fenceScalar('work:mail', PERSONAL)).toBe(false);
    expect(fenceScalar('work:mail', BOTH)).toBe(true);
  });

  test('an empty grant sees nothing', () => {
    // Fail-closed. The alternative reading — "no restriction stated" — is how a
    // caller that forgot to pass a grant gets the whole brain.
    expect(fenceScalar('personal:mail', [])).toBe(false);
  });

  test('an unknown origin is refused, not admitted', () => {
    expect(fenceScalar('personal:sms', PERSONAL)).toBe(false);
  });
});

describe('array origins — facts and edges are subset, entities are intersect', () => {
  test('a fact carries the union of its inputs, so every one must be in grant', () => {
    expect(fenceRow(['personal:mail'], PERSONAL)).toBe(true);
    expect(fenceRow(['personal:mail', 'personal:files'], PERSONAL)).toBe(true);
    // The leak this rule exists to prevent: a work reader must not receive a
    // statement that a personal page contributed to.
    expect(fenceRow(['personal:mail', 'work:mail'], WORK)).toBe(false);
    expect(fenceRow(['personal:mail', 'work:mail'], BOTH)).toBe(true);
  });

  test('a row with no origins at all is refused', () => {
    // The DDL forbids it; the read path refuses it anyway rather than treating
    // "no origins" as "no restrictions".
    expect(fenceRow([], BOTH)).toBe(false);
  });

  test('an entity is resolvable when the credential shares any one of its origins', () => {
    // project-windbreak's shape in the fixture corpus: a work project that is
    // also discussed in a personal chat. Subset-everywhere would refuse to
    // resolve it under a work-only grant and take the graph arm down with it.
    expect(fenceEntity(['work:files', 'work:mail', 'personal:chat'], WORK)).toBe(true);
    expect(fenceEntity(['work:files', 'work:mail', 'personal:chat'], PERSONAL)).toBe(false);
    expect(fenceEntity([], WORK)).toBe(false);
  });
});

describe('KTD5 — subject inference never widens access', () => {
  test('a subject in grant does not admit a row whose origin is not', () => {
    const row = candidate({
      id: 'p-work#0',
      origin: 'work:mail',
      subject: { context: 'personal:mail', confidence: 0.99 },
    });
    expect(visibleUnder([row], PERSONAL)).toEqual([]);
  });

  test('a subject out of grant does not exclude a row whose origin is in it', () => {
    // The mirror. An inferred subject that *narrowed* access would be the same
    // bug wearing a safe-looking hat: reads would silently lose rows the
    // credential is entitled to, and the miss has no error attached to it.
    const row = candidate({
      id: 'p-personal#0',
      origin: 'personal:mail',
      subject: { context: 'work:mail', confidence: 0.99 },
    });
    expect(visibleUnder([row], PERSONAL).map((r) => r.id)).toEqual(['p-personal#0']);
  });

  test('trust and source type do not participate in the fence', () => {
    const trusted = candidate({
      id: 'p-trusted#0',
      origin: 'work:files',
      sourceType: 'document',
      attestations: [{ channel: 'user_out_of_band' }],
    });
    expect(visibleUnder([trusted], PERSONAL)).toEqual([]);
  });
});

describe('visibility excludes non-live rows regardless of grant', () => {
  test('a soft-deleted or quarantined row is never visible', () => {
    const dead = candidate({ id: 'p-dead#0', origin: 'personal:mail', live: false });
    expect(visibleUnder([dead], PERSONAL)).toEqual([]);
    expect(visibleUnder([dead], BOTH)).toEqual([]);
  });
});
