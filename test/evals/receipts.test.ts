/**
 * The two R6a receipts, recomputed and compared to what is committed.
 *
 * **A receipt nobody recomputes is a claim, not a receipt.** The committed JSON
 * is what a reader of this repository sees when they ask "is this corpus
 * non-trivial, and is it attainable?", and there is exactly one mechanism that
 * keeps that answer true as the corpus changes: recompute it and diff. So this
 * file rebuilds both receipts from the shipped corpus and the committed manifest
 * and asserts byte-level agreement.
 *
 * The failure modes it is written against, in order of how quietly they happen:
 *
 *   - someone edits a page or a gold grade, the numbers move, and the receipts
 *     still assert the old ones;
 *   - someone regenerates the embeddings and the vector-arm baseline moves with
 *     them, narrowing a margin nobody re-checked;
 *   - the receipt file is deleted or truncated and the test that "checks" it
 *     quietly finds nothing to check.
 *
 * The last one is why a missing or unparseable receipt is an explicit failure
 * here rather than a skipped test.
 */

import { test, expect, describe } from 'bun:test';

import { CORPUS_DIGEST } from '../../evals/corpus.ts';
import {
  buildLowerBound,
  buildUpperBound,
  LOWER_BOUND_PATH,
  renderReceipt,
  renderSummary,
  SUMMARY_PATH,
  UPPER_BOUND_PATH,
} from '../../evals/calibrate.ts';
import { MANIFEST_PATH } from '../../evals/regenerate-embeddings.ts';
import { RANKING_FLOORS } from '../../evals/gates.ts';

const manifest = await Bun.file(MANIFEST_PATH).text();

async function readCommitted(path: string): Promise<string> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`${path} is missing; a calibration receipt that is not on disk cannot be checked`);
  }
  const text = await file.text();
  if (text.trim().length === 0) throw new Error(`${path} is empty`);
  return text;
}

const committedLower = await readCommitted(LOWER_BOUND_PATH);
const committedUpper = await readCommitted(UPPER_BOUND_PATH);
const committedSummary = await readCommitted(SUMMARY_PATH);

const lower = buildLowerBound(manifest);
const upper = buildUpperBound(manifest);

describe('the lower-bound receipt', () => {
  test('matches what is committed, byte for byte', () => {
    expect(renderReceipt(lower)).toBe(committedLower);
  });

  test('clears: the strongest naive arm is at or below every floor minus its margin', () => {
    expect(lower.clears).toBe(true);
    expect(lower.rows.length).toBe(RANKING_FLOORS.length);
    for (const row of lower.rows) {
      expect(row.clears).toBe(true);
      expect(row.naive).toBeLessThanOrEqual(row.ceiling);
      expect(row.margin).toBeGreaterThan(0);
    }
  });

  test('takes the strongest naive arm, not a chosen one', () => {
    for (const row of lower.rows) {
      const perArm = Object.values(lower.per_baseline).map((values) => values[row.floorId]);
      for (const value of perArm) {
        expect(value).toBeDefined();
        expect(row.naive).toBeGreaterThanOrEqual(value!);
      }
    }
  });

  test('records both naive arms rather than only the one that won', () => {
    expect(Object.keys(lower.per_baseline).sort()).toEqual(['naive-lexical-bm25', 'naive-vector-cosine']);
  });

  test('carries the deterministic-extraction rule-coverage baseline R6a asks for', () => {
    expect(lower.extraction_rule_coverage.totalFacts).toBeGreaterThan(0);
    expect(lower.extraction_rule_coverage.coverage).toBeGreaterThan(0);
    expect(lower.extraction_rule_coverage.floor).toBe(0.8);
    // The finding is the point: the ceiling equals the floor, so the floor is a
    // knife edge on this corpus. If a later edit gives it headroom, this test
    // should be updated deliberately rather than the finding quietly deleted.
    expect(lower.extraction_rule_coverage.headroom).toBeLessThanOrEqual(0.0001);
    expect(lower.extraction_rule_coverage.finding).toContain('FLAGGED');
  });

  test('names the threats to validity rather than presenting a clean number', () => {
    expect(lower.threats_to_validity.length).toBeGreaterThanOrEqual(4);
    expect(lower.threats_to_validity.join(' ')).toContain('synthetic');
  });

  test('is bound to the corpus and the vectors it was computed over', () => {
    expect(lower.corpus_digest).toBe(CORPUS_DIGEST);
    expect(lower.embedding_manifest_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('carries no wall-clock timestamp, so the drift check compares data and not a clock', () => {
    expect(committedLower).not.toMatch(/\b20\d\d-\d\d-\d\dT/);
  });
});

describe('the upper-bound receipt', () => {
  test('matches what is committed, byte for byte', () => {
    expect(renderReceipt(upper)).toBe(committedUpper);
  });

  test('attains: the gold key reaches the theoretical maximum on every floor', () => {
    expect(upper.attains).toBe(true);
    expect(upper.rows.length).toBe(RANKING_FLOORS.length);
    for (const row of upper.rows) {
      expect(row.oracleValue).toBe(row.theoreticalMaximum);
      expect(row.queries).toBeGreaterThanOrEqual(row.minimumQueries);
    }
  });

  test('the gold key also clears the gate itself, violations included', () => {
    expect(upper.gate_on_oracle.passed).toBe(true);
    expect(upper.gate_on_oracle.violations).toBe(0);
  });

  test('the answerability audit covers every query, in every question type', () => {
    expect(upper.answerability_audit.coverage).toBe(1);
    expect(upper.answerability_audit.audited).toBe(upper.answerability_audit.total);
    for (const [type, bucket] of Object.entries(upper.answerability_audit.by_type)) {
      expect(bucket.queries).toBeGreaterThanOrEqual(12);
      expect(bucket.audited).toBe(bucket.queries);
      expect(type.length).toBeGreaterThan(0);
    }
  });

  test('states what the oracle does not prove', () => {
    expect(upper.known_limitations.length).toBeGreaterThanOrEqual(3);
    expect(upper.known_limitations.join(' ')).toContain('necessary, not sufficient');
  });

  test('is bound to the same corpus as the lower bound', () => {
    expect(upper.corpus_digest).toBe(lower.corpus_digest);
    expect(upper.embedding_manifest_digest).toBe(lower.embedding_manifest_digest);
  });
});

describe('the human-readable summary', () => {
  test('matches what is committed', () => {
    expect(renderSummary(lower, upper)).toBe(committedSummary);
  });

  test('states both verdicts in words a reader can act on', () => {
    expect(committedSummary).toContain('**CLEARS**');
    expect(committedSummary).toContain('**ATTAINABLE**');
    expect(committedSummary).toContain('Threats to validity');
  });
});
