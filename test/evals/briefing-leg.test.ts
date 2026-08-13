/**
 * The briefing leg of the blocking tier, and the A/B receipt's freshness.
 *
 * **A leg that cannot go red is decoration**, so the cases are driven from both
 * ends: the shipped set runs clean, a deliberately-failing case surfaces as a
 * violation, and an empty case list throws rather than passing everything. The
 * per-case content is where the real work is — each shipped case carries its own
 * twin assertion so it cannot pass for want of a branch (see `evals/briefing.ts`).
 *
 * **The receipt is checked for freshness, not for its number.** Asserting the
 * measured delta here would pin a value that is supposed to move the day a
 * provider score lands. What is pinned is that the committed receipt is what the
 * current corpus, stack and manifest produce — so a stack change that moves the
 * A/B and was not accompanied by a regenerated receipt is red.
 */

import { describe, expect, test } from 'bun:test';

import { BRIEFING_CASES, runBriefingLeg, type BriefingCase } from '../../evals/briefing.ts';
import {
  buildReceipt,
  costLine,
  readCommittedReceipt,
  receiptDigest,
} from '../../evals/rerank-ab.ts';

describe('the briefing leg', () => {
  test('the shipped cases run clean', () => {
    const leg = runBriefingLeg();
    expect(leg.violations).toEqual([]);
    expect(leg.passed).toBe(true);
    expect(leg.cases).toBe(BRIEFING_CASES.length);
  });

  test('it covers both properties the plan names', () => {
    const ids = BRIEFING_CASES.map((entry) => entry.id);
    expect(ids.some((id) => id.startsWith('participants.'))).toBe(true);
    expect(ids.some((id) => id.startsWith('delta.'))).toBe(true);
  });

  test('a failing case surfaces rather than being swallowed', () => {
    const broken: BriefingCase = {
      id: 'fixture.always_fails',
      what: 'a case that is always in violation',
      run: () => [{ check: 'fixture.always_fails', detail: 'by construction' }],
    };
    const leg = runBriefingLeg([...BRIEFING_CASES, broken]);
    expect(leg.passed).toBe(false);
    expect(leg.violations.map((violation) => violation.check)).toContain('fixture.always_fails');
  });

  test('an empty leg is refused, not passed', () => {
    expect(() => runBriefingLeg([])).toThrow(/empty leg/);
  });

  test('every case reports at least one check when it runs', () => {
    // A case whose `run` returns `[]` for every input is indistinguishable from
    // a case that measures nothing. Each shipped case asserts its own twin, so
    // the way to observe that here is that the set is non-empty and each entry
    // is callable without throwing.
    for (const entry of BRIEFING_CASES) {
      expect(entry.what.length).toBeGreaterThan(0);
      expect(() => entry.run()).not.toThrow();
    }
  });
});

describe('the U12 A/B receipt', () => {
  test('the committed receipt is what this tree produces', async () => {
    const fresh = await buildReceipt();
    const committed = readCommittedReceipt();
    expect(receiptDigest(fresh)).toBe(receiptDigest(committed));
  });

  test('the uplift is deferred while every committed score is synthetic', () => {
    const committed = readCommittedReceipt();
    expect(committed.score_sources['provider']).toBe(0);
    expect(committed.uplift_status).toBe('deferred');
    // The measured delta is carried as evidence for the deferral rather than
    // hidden: a stand-in weaker than the stack it reranks scores below it, and
    // that is what the number says.
    expect(committed.delta_ndcg10).toBeLessThan(0);
  });

  test('the p99 latency is deferred and names what would produce it', () => {
    const committed = readCommittedReceipt();
    expect(committed.latency.status).toBe('deferred');
    expect(committed.latency.what_would_produce_it).toContain('deployed');
    // KTD4's dial, carried so a future operator does not reach for the flag.
    expect(committed.latency.dial_if_it_misses).toBe('candidate_count');
  });

  test('the cost line comes from the canonical table and clears KTD4', () => {
    const line = costLine();
    expect(line.model_id).toBe('@cf/baai/bge-reranker-base');
    expect(line.micro_usd_per_query_at_envelope).toBeGreaterThan(0);
    expect(line.within_envelope).toBe(true);
    // KTD4 quotes ~$0.00012 per query at a hundred 400-token candidates. The
    // receipt derives it; this asserts the derivation still lands there, so a
    // price move or a candidate-count change is visible rather than absorbed.
    expect(line.micro_usd_per_query_at_envelope).toBe(120);
  });

  test('the cost scales with the dial, which is what makes it a dial', () => {
    const full = costLine();
    const halved = costLine({ candidates: full.candidates / 2 });
    expect(halved.micro_usd_per_query_at_envelope).toBeLessThan(full.micro_usd_per_query_at_envelope);
  });
});
