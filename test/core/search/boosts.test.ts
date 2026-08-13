/**
 * Stages 6–9 — title-phrase boost, per-prefix recency decay, source-type and
 * trust priors, graph adjacency, and R12a's corroboration rule.
 *
 * Each block below proves one term's *individual* contribution: two candidates
 * identical in every respect except the one the term reads, and an assertion
 * about which ends up higher. That shape is deliberate. A boost suite that only
 * checked final orderings on a rich fixture would pass with three of the five
 * terms doing nothing, because some other term happened to order the fixture
 * correctly — which is the fail-open shape this session keeps producing.
 *
 * **R12a gets the most attention here, because it is the term an attacker can
 * reach.** Corroboration means an origin the external sender cannot also write.
 * Three properties, all pinned:
 *
 *   1. A user attestation corroborates; an external origin never does, at any
 *      count. Two connected accounts agreeing is forgeable by the sender who
 *      wrote both, and `From:` is free — so a boost keyed on distinct external
 *      senders would be a ranking primitive an emailer controls.
 *   2. A mail message and the calendar event derived from it are **one** origin.
 *      Reported as `independentOrigins: 1`, not 2.
 *   3. A `remember` over MCP marks a claim *restated* and clears nothing. The
 *      assistant holding `remember` is the same assistant reading the attacker's
 *      mail.
 */

import { describe, expect, test } from 'bun:test';

import {
  RECENCY_HALF_LIFE_DAYS,
  applyBoosts,
  corroborationOf,
} from '../../../src/core/search/boosts.ts';
import { classifyIntent, planFor } from '../../../src/core/search/intent.ts';
import type { Attestation, Candidate } from '../../../src/core/search/types.ts';

const NOW = new Date('2026-07-01T00:00:00Z');

function candidate(
  id: string,
  overrides: Partial<Candidate> = {},
): Candidate {
  return {
    id,
    pageId: `page-${id}`,
    ordinal: 0,
    title: 'A page',
    content: 'body text',
    origin: 'personal:mail',
    sourceType: 'document',
    createdAt: '2026-06-01',
    live: true,
    attestations: [{ channel: 'user_curated' }],
    entityIds: [],
    ...overrides,
  };
}

/** Two candidates fused at exactly the same base — the only fair comparison. */
function scoreTwo(
  query: string,
  a: Candidate,
  b: Candidate,
  extra: { readonly resolvedEntityIds?: readonly string[] } = {},
) {
  const plan = planFor(classifyIntent(query));
  const scored = applyBoosts({
    fused: new Map([
      [a.id, 1],
      [b.id, 1],
    ]),
    candidates: new Map([
      [a.id, a],
      [b.id, b],
    ]),
    query,
    plan,
    now: NOW,
    resolvedEntityIds: extra.resolvedEntityIds ?? [],
    aliasLadder: [],
  });
  return { order: scored.map((s) => s.candidate.id), scored };
}

describe('stage 6 — the title-phrase boost', () => {
  test('an ordered phrase in the title beats a denser body decoy', () => {
    const titled = candidate('titled', {
      title: 'Saltmarsh launch retro',
      content: 'The outcome landed two days late.',
    });
    const decoy = candidate('decoy', {
      title: 'Weekly standup digest',
      content: 'saltmarsh launch retro saltmarsh launch retro saltmarsh launch retro',
    });
    expect(scoreTwo('Saltmarsh launch retro', titled, decoy).order[0]).toBe('titled');
  });

  test('word overlap out of order does not fire it', () => {
    // Otherwise the stage is a second keyword arm under a phrase boost's name.
    const scrambled = candidate('scrambled', { title: 'retro launch Saltmarsh' });
    const none = candidate('none', { title: 'Unrelated page' });
    const { scored } = scoreTwo('Saltmarsh launch retro', scrambled, none);
    const boost = scored.find((s) => s.candidate.id === 'scrambled')?.boosts['title'] ?? 0;
    const full = candidate('full', { title: 'Saltmarsh launch retro' });
    const fullBoost =
      scoreTwo('Saltmarsh launch retro', full, none).scored.find((s) => s.candidate.id === 'full')
        ?.boosts['title'] ?? 0;
    expect(boost).toBeLessThan(fullBoost);
  });

  test('a page with no title is not penalised into oblivion', () => {
    const untitled = candidate('untitled', { title: null });
    const other = candidate('other', { title: 'Something else' });
    const { scored } = scoreTwo('Saltmarsh launch retro', untitled, other);
    for (const entry of scored) expect(entry.score).toBeGreaterThan(0);
  });
});

describe('stage 7 — per-prefix recency decay', () => {
  test('on a temporal question the newer page wins', () => {
    const fresh = candidate('fresh', { createdAt: '2026-06-25', sourceType: 'email' });
    const stale = candidate('stale', { createdAt: '2025-06-25', sourceType: 'email' });
    expect(scoreTwo('what did I say last week', fresh, stale).order[0]).toBe('fresh');
  });

  test('on a relational question it does not fire at all', () => {
    // A standing relational fact is frequently the oldest page in the brain.
    const fresh = candidate('fresh', { createdAt: '2026-06-25' });
    const stale = candidate('stale', { createdAt: '2019-01-01' });
    const { scored } = scoreTwo('who founded Kettle and Quill', fresh, stale);
    for (const entry of scored) expect(entry.boosts['recency'] ?? 0).toBe(0);
  });

  test('churny surfaces decay faster than durable ones', () => {
    // The 14-to-60-day spread, as an assertion on the table rather than prose.
    expect(RECENCY_HALF_LIFE_DAYS.chat).toBeLessThan(RECENCY_HALF_LIFE_DAYS.document);
    expect(RECENCY_HALF_LIFE_DAYS.chat).toBeLessThanOrEqual(14);
    expect(RECENCY_HALF_LIFE_DAYS.document).toBeGreaterThanOrEqual(60);

    const chat = candidate('chat', { createdAt: '2026-05-01', sourceType: 'chat' });
    const doc = candidate('doc', { createdAt: '2026-05-01', sourceType: 'document' });
    const { scored } = scoreTwo('what changed last month', chat, doc);
    const chatDecay = scored.find((s) => s.candidate.id === 'chat')?.boosts['recency'] ?? 0;
    const docDecay = scored.find((s) => s.candidate.id === 'doc')?.boosts['recency'] ?? 0;
    expect(chatDecay).toBeLessThan(docDecay);
  });

  test('an unparseable date contributes no tilt rather than a wrong one', () => {
    const broken = candidate('broken', { createdAt: 'not-a-date' });
    const fine = candidate('fine', { createdAt: '2026-06-25' });
    const { scored } = scoreTwo('what happened last week', broken, fine);
    expect(scored.find((s) => s.candidate.id === 'broken')?.boosts['recency'] ?? 0).toBe(0);
  });

  test('`now` is injected, so the ranking does not drift with the wall clock', () => {
    const fresh = candidate('fresh', { createdAt: '2026-06-25' });
    const stale = candidate('stale', { createdAt: '2025-06-25' });
    const plan = planFor(classifyIntent('what changed last week'));
    const inputs = {
      fused: new Map([
        ['fresh', 1],
        ['stale', 1],
      ]),
      candidates: new Map([
        ['fresh', fresh],
        ['stale', stale],
      ]),
      query: 'what changed last week',
      plan,
      resolvedEntityIds: [],
      aliasLadder: [],
    };
    const atOneTime = applyBoosts({ ...inputs, now: new Date('2026-07-01T00:00:00Z') });
    const atAnother = applyBoosts({ ...inputs, now: new Date('2027-07-01T00:00:00Z') });
    expect(atOneTime[0]?.boosts['recency']).not.toBe(atAnother[0]?.boosts['recency']);
  });
});

describe('stage 8 — source-type and trust priors (KTD5, ranking only)', () => {
  test('a schedule question lifts calendar pages', () => {
    const invite = candidate('invite', { sourceType: 'calendar' });
    const doc = candidate('doc', { sourceType: 'document' });
    expect(scoreTwo('what is happening on 3 September', invite, doc).order[0]).toBe('invite');
    // …and does not lift them on an unrelated question.
    expect(scoreTwo('who invested in Verdant Loom', invite, doc).order[0]).toBe('doc');
  });

  test('a user attestation carries a higher trust prior than a bare external row', () => {
    const attested = candidate('attested', {
      sourceType: 'email',
      attestations: [{ channel: 'external', senderKey: 'sender:a' }, { channel: 'user_out_of_band' }],
    });
    const bare = candidate('bare', {
      sourceType: 'email',
      attestations: [{ channel: 'external', senderKey: 'sender:b' }],
    });
    const { scored } = scoreTwo('roast contract terms', attested, bare);
    const trustOf = (id: string) => scored.find((s) => s.candidate.id === id)?.boosts['trust'] ?? 0;
    expect(trustOf('attested')).toBeGreaterThan(trustOf('bare'));
  });

  test('priors never take a score to zero or below', () => {
    const chat = candidate('chat', { sourceType: 'chat', title: null });
    const other = candidate('other', { sourceType: 'chat', title: null });
    const { scored } = scoreTwo('anything at all', chat, other);
    for (const entry of scored) expect(entry.score).toBeGreaterThan(0);
  });
});

describe('stage 9 — graph adjacency', () => {
  test('a chunk evidencing a resolved entity outranks one that does not', () => {
    const adjacent = candidate('adjacent', { entityIds: ['e-verdant'] });
    const distant = candidate('distant', { entityIds: ['e-other'] });
    const { order } = scoreTwo('who invested in Verdant Loom', adjacent, distant, {
      resolvedEntityIds: ['e-verdant'],
    });
    expect(order[0]).toBe('adjacent');
  });

  test('with no resolved entity the term is inert', () => {
    const a = candidate('a', { entityIds: ['e-verdant'] });
    const b = candidate('b', { entityIds: [] });
    const { scored } = scoreTwo('who invested in Verdant Loom', a, b);
    for (const entry of scored) expect(entry.boosts['graph'] ?? 0).toBe(0);
  });
});

describe('R12a — corroboration', () => {
  const external = (sender: string): Attestation => ({ channel: 'external', senderKey: sender });

  test('a user attestation corroborates', () => {
    const verdict = corroborationOf([external('sender:acme'), { channel: 'user_out_of_band' }]);
    expect(verdict.corroborated).toBe(true);
    expect(verdict.independentOrigins).toBe(2);
    expect(verdict.eligibleForCompiledTruth).toBe(true);
  });

  test('an external origin never corroborates, at any count', () => {
    // `From:` is free. A boost keyed on distinct external senders is a ranking
    // primitive an emailer controls.
    const one = corroborationOf([external('sender:acme')]);
    const many = corroborationOf([external('sender:acme'), external('sender:widget'), external('sender:third')]);
    expect(one.corroborated).toBe(false);
    expect(many.corroborated).toBe(false);
    expect(many.independentOrigins).toBe(3);
    expect(many.eligibleForCompiledTruth).toBe(false);
  });

  test('a mail message and the calendar event derived from it are ONE origin', () => {
    // The derived row carries its root's sender key, which is what makes the
    // collapse observable. The naive implementation — count distinct
    // `origin_context` values — reports 2 here and fails.
    const verdict = corroborationOf([external('sender:acme'), external('sender:acme')]);
    expect(verdict.independentOrigins).toBe(1);
    expect(verdict.corroborated).toBe(false);
  });

  test('a remember over MCP marks the claim restated and clears nothing', () => {
    const verdict = corroborationOf([external('sender:acme'), { channel: 'agent_mcp' }]);
    expect(verdict.restated).toBe(true);
    expect(verdict.corroborated).toBe(false);
    expect(verdict.eligibleForCompiledTruth).toBe(false);
    // And it does not even count as an independent origin.
    expect(verdict.independentOrigins).toBe(1);
  });

  test('an internally-derived origin corroborates', () => {
    expect(corroborationOf([external('sender:acme'), { channel: 'internal' }]).corroborated).toBe(true);
  });

  test('a row with no external attestation is compiled-truth eligible without one', () => {
    expect(corroborationOf([{ channel: 'user_curated' }]).eligibleForCompiledTruth).toBe(true);
  });

  test('a corroborated fact outranks the same-scored fact attested externally alone', () => {
    const corroborated = candidate('corroborated', {
      sourceType: 'email',
      attestations: [external('sender:acme'), { channel: 'user_out_of_band' }],
    });
    const alone = candidate('alone', {
      sourceType: 'email',
      attestations: [external('sender:acme')],
    });
    expect(scoreTwo('roast contract terms', corroborated, alone).order[0]).toBe('corroborated');
  });

  test('mail plus its derived calendar event gets no corroboration boost', () => {
    const derivedPair = candidate('pair', {
      sourceType: 'email',
      attestations: [external('sender:acme'), external('sender:acme')],
    });
    const mailAlone = candidate('alone', {
      sourceType: 'email',
      attestations: [external('sender:acme')],
    });
    const { scored } = scoreTwo('roast contract terms', derivedPair, mailAlone);
    const boostOf = (id: string) =>
      scored.find((s) => s.candidate.id === id)?.boosts['corroboration'] ?? 0;
    expect(boostOf('pair')).toBe(0);
    expect(boostOf('pair')).toBe(boostOf('alone'));
  });
});

describe('the output is a total order and explains itself', () => {
  test('ties break on id, ascending', () => {
    const a = candidate('zeta');
    const b = candidate('alpha');
    expect(scoreTwo('anything', a, b).order).toEqual(['alpha', 'zeta']);
  });

  test('every result carries its per-term attribution', () => {
    const { scored } = scoreTwo('Saltmarsh launch retro', candidate('a'), candidate('b'));
    for (const entry of scored) {
      expect(Object.keys(entry.boosts).sort()).toEqual([
        'corroboration',
        'graph',
        'recency',
        'source_type',
        'title',
        'trust',
      ]);
    }
  });

  test('a candidate with no fused score still ranks below one with any', () => {
    // Ladder injection is what gives an unrecalled candidate a base at all; a
    // candidate with none has not been recalled by anything.
    const plan = planFor(classifyIntent('anything'));
    const scored = applyBoosts({
      fused: new Map([['recalled', 0.5]]),
      candidates: new Map([
        ['recalled', candidate('recalled')],
        ['orphan', candidate('orphan')],
      ]),
      query: 'anything',
      plan,
      now: NOW,
      resolvedEntityIds: [],
      aliasLadder: [],
    });
    expect(scored[0]?.candidate.id).toBe('recalled');
    expect(scored.find((s) => s.candidate.id === 'orphan')?.score).toBe(0);
  });
});
