/**
 * The answerability audit, checked against the concepts ledger rather than
 * against itself.
 *
 * **The failure this prevents is the one R6a's upper bound is named after.** A
 * query whose answer is only reachable by the cross-encoder (U12) or by the
 * compiled-truth boost (U11) is unanswerable by the stack U5 ships. When U5 is
 * graded against it, the floor miss looks like an accuracy-architecture failure
 * — which is exactly what stop condition (c) escalates on — and it is really a
 * fixture that asked for a mechanism nobody had built yet.
 *
 * So the evidence chains are not free text checked by a human. Every mechanism
 * a query names is resolved against `upstream/concepts.jsonl`: it must exist,
 * and its owning unit must be one that lands by the time these floors bind. The
 * allowed set is derived from the ledger's own `unit` field, not hardcoded here
 * — a hardcoded list would go stale the moment the ledger moved, and would go
 * stale silently.
 *
 * The check runs in both directions, like the rest of this unit: every named
 * mechanism resolves, and every mechanism the corpus claims to exercise is
 * actually named by at least one query.
 */

import { test, expect, describe } from 'bun:test';

import { CORPUS } from '../../evals/corpus.ts';
import { QUESTION_TYPES } from '../../evals/fixtures/types.ts';

interface LedgerRow {
  readonly id: string;
  readonly status: string;
  readonly unit?: string;
  readonly criticality: string;
}

const LEDGER_PATH = 'upstream/concepts.jsonl';

/**
 * Units whose deliverables exist by the time the blocking tier's ranking floors
 * bind. U3 is the schema, U4 the write path, U5 the retrieval stack. U11 and U12
 * land in later phases, so a query that needs one of them cannot be used to
 * grade U5.
 */
const UNITS_AVAILABLE_BY_U5 = new Set(['U3', 'U4', 'U5']);

const ledgerText = await Bun.file(LEDGER_PATH).text();
const ledger: LedgerRow[] = ledgerText
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as LedgerRow);

const ledgerById = new Map(ledger.map((row) => [row.id, row] as const));

describe('the ledger this audit is checked against', () => {
  test('parses, and is not empty — a regex that matched nothing would pass everything below', () => {
    expect(ledger.length).toBeGreaterThan(50);
    expect(ledgerById.size).toBe(ledger.length);
  });

  test('still contains the stack rows the corpus leans on', () => {
    for (const id of ['stack.alias-hop', 'stack.graph-arm', 'stack.title-phrase-boost', 'stack.recency-decay']) {
      expect(ledgerById.has(id)).toBe(true);
    }
  });

  test('still places the deferred mechanisms in later units, which is what makes the check bite', () => {
    expect(ledgerById.get('stack.cross-encoder-rerank')?.unit).toBe('U12');
    expect(ledgerById.get('stack.autocut')?.unit).toBe('U12');
    expect(ledgerById.get('stack.compiled-truth-boost')?.unit).toBe('U11');
  });
});

describe('every query is answerable by the stack it will grade', () => {
  test('every named mechanism exists in the ledger', () => {
    for (const query of CORPUS.queries) {
      for (const mechanism of query.mechanisms) {
        expect(ledgerById.has(mechanism)).toBe(true);
      }
    }
  });

  test('every named mechanism belongs to a unit that lands by U5', () => {
    const offenders: string[] = [];
    for (const query of CORPUS.queries) {
      for (const mechanism of query.mechanisms) {
        const row = ledgerById.get(mechanism);
        if (row === undefined || row.unit === undefined || !UNITS_AVAILABLE_BY_U5.has(row.unit)) {
          offenders.push(`${query.id} -> ${mechanism} (${row?.unit ?? 'no unit'})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every query carries an evidence chain a reader can check', () => {
    for (const query of CORPUS.queries) {
      expect(query.evidence.trim().length).toBeGreaterThan(40);
      expect(query.mechanisms.length).toBeGreaterThan(0);
    }
  });

  test('each question type has enough audited queries to support a per-type floor', () => {
    const counts = new Map<string, number>();
    for (const query of CORPUS.queries) counts.set(query.type, (counts.get(query.type) ?? 0) + 1);
    for (const type of QUESTION_TYPES) {
      expect(counts.get(type) ?? 0).toBeGreaterThanOrEqual(12);
    }
  });

  test('the mechanisms actually spread across the stack rather than naming one thing', () => {
    const named = new Set<string>();
    for (const query of CORPUS.queries) for (const mechanism of query.mechanisms) named.add(mechanism);
    // A corpus whose every query says "keyword arm" would pass every check above
    // and prove nothing about the stack.
    expect(named.size).toBeGreaterThanOrEqual(8);
    for (const required of [
      'stack.alias-hop',
      'stack.graph-arm',
      'stack.title-phrase-boost',
      'stack.recency-decay',
      'stack.read-time-dedup',
    ]) {
      expect(named.has(required)).toBe(true);
    }
  });

  test('each probe family names the mechanism it is supposed to be probing', () => {
    const familyMechanism: Readonly<Record<string, string>> = {
      title_substring: 'stack.title-phrase-boost',
      alias: 'stack.alias-hop',
      dilution: 'stack.read-time-dedup',
    };
    for (const query of CORPUS.queries) {
      const required = familyMechanism[query.family];
      if (required === undefined) continue;
      expect(query.mechanisms).toContain(required);
    }
  });

  test('every temporal question names a mechanism that can tell time', () => {
    for (const query of CORPUS.queries) {
      if (query.type !== 'temporal') continue;
      expect(query.mechanisms).toContain('stack.recency-decay');
    }
  });
});
