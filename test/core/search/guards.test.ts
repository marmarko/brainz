/**
 * The behavioural guards a mutation run showed were missing.
 *
 * **Every test in this file exists because a specific mutation survived.** The
 * schedule ran eighteen one-token edits against the committed stack and eleven
 * of them left the suite green — including four that disable a stage the module
 * headers argue for at length. Prose is not a guard; a test that fails when the
 * behaviour is removed is. Each block below names the mutation it kills, so the
 * next run can tell a guard from a decoration.
 *
 * **They are deliberately not floors tests.** The R6 floors are a whole-corpus
 * measurement and they were red while the mutations ran, which is exactly why
 * eleven survived unnoticed — a gate that is already failing cannot report that
 * something else broke. These assert one stage's behaviour on constructed
 * input, so they answer even when the corpus gate does not.
 */

import { describe, expect, test } from 'bun:test';

import { LADDER_RUNG_WEIGHTS, aliasLadderTiers, type LadderLookup } from '../../../src/core/search/alias-hop.ts';
import { RESTATEMENT_PENALTY, applyBoosts, corroborationOf } from '../../../src/core/search/boosts.ts';
import { DEFAULT_DEDUP, dedupe } from '../../../src/core/search/dedup.ts';
import { classifyIntent, planFor, refinePlan, resolutionOf } from '../../../src/core/search/intent.ts';
import { normalizeQuery } from '../../../src/core/search/normalize.ts';
import { normalize as writeNormalize } from '../../../src/core/write/normalize.ts';
import { composeRanking } from '../../../src/core/search/pipeline.ts';
import { foldRanked } from '../../../src/core/search/rrf.ts';
import type { Candidate, RecallOutcome, ScoredCandidate, SourceType } from '../../../src/core/search/types.ts';

function candidate(id: string, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id,
    pageId: `page-${id}`,
    ordinal: 0,
    title: null,
    content: `content of ${id}`,
    origin: 'personal:files',
    sourceType: 'document',
    createdAt: '2026-05-01',
    live: true,
    attestations: [{ channel: 'user_curated' }],
    entityIds: [],
    ...overrides,
  };
}

function scored(id: string, score: number, overrides: Partial<Candidate> = {}): ScoredCandidate {
  return { candidate: candidate(id, overrides), fused: score, score, boosts: {} };
}

// ---------------------------------------------------------------------------
// M8 — the alias ladder can only boost, never inject.
// ---------------------------------------------------------------------------

describe('M8: the ladder injects candidates no arm recalled', () => {
  test('folding a rung introduces ids the fusion had never seen', () => {
    // The mutation guarded against: `if (out.has(id))` around the write, which
    // turns the fold into a multiplier. Every ladder rung then becomes decorative
    // for exactly the queries it exists for — an exact-title match no arm
    // returned scores zero forever — and no test noticed.
    const fused = new Map<string, number>([['recalled', 0.5]]);
    const folded = foldRanked(fused, ['never-recalled', 'recalled'], { weight: 2, k: 10 });

    expect(folded.has('never-recalled')).toBe(true);
    expect(folded.get('never-recalled')).toBeGreaterThan(0);
    // And the rank still decays, so injection is not a flat promotion.
    expect(folded.get('never-recalled')).toBeGreaterThan(
      foldRanked(new Map(), ['x', 'y', 'never-recalled'], { weight: 2, k: 10 }).get('never-recalled')!,
    );
  });
});

// ---------------------------------------------------------------------------
// M12 / M13 — the mention rung, and page-granular rungs' rank arithmetic.
// ---------------------------------------------------------------------------

function ladderLookupOver(pages: Array<{ pageId: string; title: string | null; chunkIds: string[]; text: string }>): LadderLookup {
  return {
    pagesByTitle: () => [],
    pagesTitledContaining: () => [],
    entitiesByName: () => [],
    entitiesBySlugSuffix: () => [],
    pagesTitled: () => [],
    evidenceFor: () => [],
    pagesMentioning: () => pages,
  };
}

describe('M12: the mention rung reaches a page no fact points at', () => {
  test('a page that names the entity and evidences nothing is still nominated', () => {
    const tiers = aliasLadderTiers(
      'what does Tosh want changed',
      ladderLookupOver([
        {
          pageId: 'p-review',
          title: 'Design review notes',
          chunkIds: ['p-review#0', 'p-review#1'],
          text: 'Toshiro Abe wants the sensor housing two millimetres shorter.',
        },
      ]),
      [{ entityId: 'toshiro-abe', canonicalName: 'Toshiro Abe', slug: 'toshiro-abe', matchedKey: 'tosh' }],
    );

    const mention = tiers.find((tier) => tier.rung === 'entity_mention');
    expect(mention).toBeDefined();
    expect(mention!.ids).toContain('p-review#0');
    // The weight is what makes it a nomination rather than a decoration. Zero
    // here is the mutation that survived the whole suite.
    expect(LADDER_RUNG_WEIGHTS.entity_mention).toBeGreaterThan(0);
    expect(mention!.weight).toBeGreaterThan(0);
  });
});

describe('M13: a page-granular rung ranks by page, not by chunk offset', () => {
  test('every nominated page’s lead chunk outranks every page’s second chunk', () => {
    // The mutation guarded against: `pages.flatMap(page => page.chunkIds)`. With
    // concatenation an eight-chunk page pushes the second page's lead chunk to
    // rank nine, so the ladder pays it a third as much — a systematic bias
    // toward chatty pages that leaves the right page nominated at a rank it
    // cannot win from.
    const tiers = aliasLadderTiers(
      'Ellie renewal price',
      ladderLookupOver([
        {
          pageId: 'p-long',
          title: 'Parked items',
          chunkIds: ['p-long#0', 'p-long#1', 'p-long#2', 'p-long#3'],
          text: 'ask ellie about the renewal price, ellie has the renewal price somewhere.',
        },
        {
          pageId: 'p-answer',
          title: 'Halcyon Grid renewal terms',
          chunkIds: ['p-answer#0', 'p-answer#1'],
          text: 'The 2026 renewal price is 18,400 euro. Elena Barros confirmed it.',
        },
      ]),
      [{ entityId: 'elena-barros', canonicalName: 'Elena Barros', slug: 'elena-barros', matchedKey: 'ellie' }],
    );

    const ids = tiers.find((tier) => tier.rung === 'entity_mention')!.ids;
    const leadOfSecondPage = ids.indexOf('p-answer#0');
    const secondChunkOfFirstPage = ids.indexOf('p-long#1');
    expect(leadOfSecondPage).toBeGreaterThanOrEqual(0);
    expect(leadOfSecondPage).toBeLessThan(secondChunkOfFirstPage);
  });
});

// ---------------------------------------------------------------------------
// M14 — the plan the arms ran under is the plan the stages score under.
// ---------------------------------------------------------------------------

describe('M14: composeRanking scores under the plan the arms ran under', () => {
  test('a refined plan on the outcome is not silently replaced by a fresh one', () => {
    // "Ellie renewal price" classifies `lexical` — no cue fires. The refined
    // plan is the one that saw the ladder resolve, and it differs. The mutation
    // guarded against is `request.plan ?? planFor(classifyIntent(query))`, which
    // scores the ranking under a plan that never chose an arm.
    const query = 'S. Okonkwo Verdant Loom';
    const unrefined = planFor(classifyIntent(query));
    const refined = refinePlan(
      unrefined,
      resolutionOf(query, [
        { canonicalName: 'Samantha Okonkwo', slug: 'samantha-okonkwo' },
        { canonicalName: 'Verdant Loom', slug: 'verdant-loom' },
      ]),
    );
    // The premise: refinement really did change the plan, or this proves nothing.
    expect(refined).not.toEqual(unrefined);
    expect(refined.useGraphArm).toBe(true);
    expect(unrefined.useGraphArm).toBe(false);

    const outcome: RecallOutcome = {
      plan: refined,
      arms: [{ arm: 'graph', ranked: ['a'] }],
      candidates: new Map([['a', candidate('a')]]),
      aliasLadder: [],
      resolvedEntityIds: [],
      degraded: [],
    };

    const response = composeRanking({ query, limit: 5, now: new Date('2026-06-01') }, outcome);
    expect(response.plan).toEqual(refined);
    expect(response.intent).toBe(refined.intent);
    // The graph arm's weight is nonzero only under the refined plan, so a
    // recomputed plan would score this candidate at zero.
    expect(response.results[0]!.fused).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// M11 — the restatement penalty.
// ---------------------------------------------------------------------------

describe('M11: a chunk that restates the question ranks below one that answers it', () => {
  const plan = planFor(classifyIntent('renewal price'));

  function rank(query: string, ...candidates: Candidate[]): string[] {
    return applyBoosts({
      fused: new Map(candidates.map((entry) => [entry.id, 0.2])),
      candidates: new Map(candidates.map((entry) => [entry.id, entry])),
      query,
      plan,
      now: new Date('2026-07-01'),
      resolvedEntityIds: [],
      aliasLadder: [],
    }).map((entry) => entry.candidate.id);
  }

  test('the interrogative form is demoted at equal fused score', () => {
    expect(RESTATEMENT_PENALTY).toBeGreaterThan(0);
    const order = rank(
      'renewal price',
      candidate('asks', {
        content: 'did the renewal price change? has the renewal price changed at all?',
      }),
      candidate('answers', { content: 'The 2026 renewal price is 18,400 euro for the year.' }),
    );
    expect(order[0]).toBe('answers');
  });

  test('the backlog form — no question mark, all echo — is demoted too', () => {
    const order = rank(
      'renewal price',
      candidate('echo', {
        content: 'renewal price for 2026 — nobody has the renewal price, chase the renewal price.',
      }),
      candidate('answers', { content: 'The 2026 renewal price is 18,400 euro for the year.' }),
    );
    expect(order[0]).toBe('answers');
  });

  test('a row that merely mentions the query terms once is not demoted', () => {
    // The penalty must not become a general "matches the query" penalty.
    const entry = applyBoosts({
      fused: new Map([['plain', 0.2]]),
      candidates: new Map([['plain', candidate('plain', { content: 'The renewal price is set each June.' })]]),
      query: 'renewal price',
      plan,
      now: new Date('2026-07-01'),
      resolvedEntityIds: [],
      aliasLadder: [],
    })[0]!;
    expect(entry.boosts.restatement).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// M9 — the corroboration boost, isolated from the trust prior.
// ---------------------------------------------------------------------------

describe('M9: the corroboration boost is what orders a corroborated row', () => {
  test('it fires with the trust prior held equal', () => {
    // The existing probe paired `user_out_of_band` against a bare external row,
    // so the *trust* prior alone (0.08 against 0) already produced the expected
    // order — zeroing the corroboration term left it green. Holding trust equal
    // is what makes this measure the term it names.
    const both: Candidate = candidate('corroborated', {
      attestations: [{ channel: 'internal' }, { channel: 'external', senderKey: 'sender:acme' }],
    });
    const trustOnly: Candidate = candidate('trust-only', {
      // Same TRUST_PRIOR as `internal` would give? No — pick the *higher* trust
      // so that any ordering that survives is the corroboration term's doing.
      attestations: [{ channel: 'user_out_of_band' }],
    });
    expect(corroborationOf(both.attestations).corroborated).toBe(true);
    expect(corroborationOf(trustOnly.attestations).corroborated).toBe(true);

    // With both corroborated, the term cancels and trust decides: the control.
    const control = applyBoosts({
      fused: new Map([[both.id, 0.2], [trustOnly.id, 0.2]]),
      candidates: new Map([[both.id, both], [trustOnly.id, trustOnly]]),
      query: 'anything',
      plan: planFor(classifyIntent('anything')),
      now: new Date('2026-07-01'),
      resolvedEntityIds: [],
      aliasLadder: [],
    });
    expect(control[0]!.candidate.id).toBe('trust-only');

    // Now the same pair with corroboration removed from one side only. The trust
    // priors are unchanged, so anything that moves is the corroboration term.
    const uncorroborated = candidate('uncorroborated', {
      attestations: [{ channel: 'user_curated' }],
    });
    const scoredPair = applyBoosts({
      fused: new Map([[both.id, 0.2], [uncorroborated.id, 0.2]]),
      candidates: new Map([[both.id, both], [uncorroborated.id, uncorroborated]]),
      query: 'anything',
      plan: planFor(classifyIntent('anything')),
      now: new Date('2026-07-01'),
      resolvedEntityIds: [],
      aliasLadder: [],
    });
    const corroboratedEntry = scoredPair.find((entry) => entry.candidate.id === both.id)!;
    expect(corroboratedEntry.boosts.corroboration).toBeGreaterThan(0);
    expect(scoredPair[0]!.candidate.id).toBe(both.id);
  });
});

// ---------------------------------------------------------------------------
// M5-D1 / M6 — dedup layer 1, and the page-type cap's denominator.
// ---------------------------------------------------------------------------

describe('M5-D1: layer 1 caps what reaches the later layers, not just the payload', () => {
  test('a verbose page cannot suppress another page through the Jaccard layer', () => {
    // **Why the obvious test does not work, stated so nobody rebuilds it.**
    // Layer 4 caps the *payload* at two chunks per page, so disabling layer 1
    // and counting the output shows no difference at all — which is exactly why
    // the mutation survived. What layer 1 protects is the *input* to layer 2:
    // near-duplicate collapse keeps the first survivor of a cluster, so a chunk
    // deep inside a verbose page can suppress another page's only chunk. With
    // layer 1 on, that chunk never reaches layer 2.
    const shared = 'the calibration jig tolerance was measured at two millimetres out of true';
    const rows: ScoredCandidate[] = [];
    for (let index = 0; index < 40; index += 1) {
      rows.push(
        scored(`v${index}`, 1 - index / 100, {
          pageId: 'p-verbose',
          content: index === 10 ? shared : `paragraph ${index} of an unrelated running commentary`,
        }),
      );
    }
    // Scores below the verbose page's tenth chunk, so it is the one that would
    // be suppressed rather than the suppressor.
    rows.push(scored('other', 0.2, { pageId: 'p-other', content: shared }));

    const kept = dedupe(rows, { targetSize: 10 });
    expect(kept.map((entry) => entry.candidate.pageId)).toContain('p-other');
  });
});

describe('M6: the page-type cap counts against the request, not the survivors', () => {
  test('nineteen chat messages are held to six, not to eleven', () => {
    // Capping against survivors is self-referential — removing a row shrinks the
    // denominator, which lowers the allowance, which removes another row — and
    // it also un-caps the moment the candidate set is larger than the request.
    // Nineteen survivors against a request of ten is the case that separates
    // them: the request says six, the survivor count says eleven.
    const rows: ScoredCandidate[] = [];
    for (let index = 0; index < 19; index += 1) {
      rows.push(
        scored(`chat${index}`, 1 - index / 100, {
          pageId: `p-chat-${index}`,
          sourceType: 'chat' as SourceType,
          content: `chat line ${index}: entirely distinct wording number ${index} here`,
        }),
      );
    }
    rows.push(scored('doc', 0.2, { pageId: 'p-doc', sourceType: 'document' }));

    const kept = dedupe(rows, { targetSize: 10 });
    const chatKept = kept.filter((entry) => entry.candidate.sourceType === 'chat').length;
    expect(chatKept).toBe(Math.floor(10 * DEFAULT_DEDUP.pageTypeCap));
    expect(kept.some((entry) => entry.candidate.sourceType === 'document')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M18 — the read side must not re-implement the normalizer.
// ---------------------------------------------------------------------------

describe('M18: the query normalizer is the write path’s, not a lookalike', () => {
  test('every fold the write side applies, the read side applies', () => {
    // The identity assertion in `normalize.test.ts` pins the *re-export*; it
    // says nothing about `normalizeQuery`, which is the function every read-side
    // call site actually uses. A plausible re-implementation —
    // `NFKC + toLowerCase + collapse whitespace` — passed the whole suite while
    // dropping the punctuation fold and the invisible-character strip, which is
    // precisely the drift that makes an alias stored by a mail client
    // unfindable from a keyboard.
    for (const sample of [
      'Ronan O’Brien',
      "Ronan O'Brien",
      'Kettle “and” Quill',
      'soft­hyphen',
      'zero​width',
      'ideographic　space',
      'Søren – Halcyon',
      'ﬁle ligature',
    ]) {
      expect(normalizeQuery(sample)).toBe(writeNormalize(sample));
    }
    // And the fold is not a no-op, or the assertion above is vacuous.
    expect(normalizeQuery('Ronan O’Brien')).toBe(normalizeQuery("Ronan O'Brien"));
    expect(normalizeQuery('soft­hyphen')).toBe('softhyphen');
  });
});
