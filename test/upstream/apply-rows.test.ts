/**
 * The one code path in this unit that writes into the trust ledger.
 *
 * Everything else the watcher does is a read and a report. `applyRows` appends
 * rows to `upstream/concepts.jsonl`, which is the artifact R7 rests on — and
 * until this file existed it had never executed: the weekly run against the
 * current pin has an empty delta, and `--apply` refuses a backdated run outright.
 * A path that first runs in anger on the day a gbrain release lands is exactly
 * what this unit exists to argue against, so it runs here instead.
 *
 * Three properties, and the third is the one that matters weekly:
 *
 *   - **A fresh row is appended, and the result still passes the gate.** Writing
 *     a row `bun run ledger:check` would reject is worse than writing nothing:
 *     the next PR goes red for a reason nobody on it caused.
 *   - **A row already present is skipped rather than duplicated.** Ids are
 *     derived from the release and the area — both facts about upstream — so a
 *     re-run proposes the same rows. `check-ledger` fails on a duplicate id, so
 *     the skip is a convenience with a hard backstop underneath it.
 *   - **A second run changes no bytes.** Not "adds no rows" — no bytes. An
 *     append that rewrites the file identically except for a trailing newline
 *     would pass a row-count assertion and produce a diff every week.
 *
 * The ledger is copied to a temp path first. A test that appended to the real
 * one and tidied up afterwards would leave rows behind the moment it failed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkLedger } from '../../scripts/check-ledger.ts';
import type { DiscoveredRow } from '../../src/upstream/classify.ts';
import { LEDGER_PATH, applyRows } from '../../src/upstream/watch.ts';

const TODAY = new Date('2026-08-13T00:00:00Z');

let dir: string;
let ledger: string;

function row(id: string, area: string): DiscoveredRow {
  return {
    id,
    capability: `a capability discovered in ${area}`,
    criticality: 'critical',
    status: 'not-yet',
    priority: 'p1',
    unit: 'U19-review',
    source: 'upstream-watcher',
    notes: 'Discovered by the U19 upstream watcher.',
    discovered_by: {
      watcher: 'u19',
      run_on: '2026-08-13',
      gbrain_release: '0.45.0.0',
      gbrain_commit: 'a'.repeat(40),
      area: 'retrieval',
      confidence: 'high',
      evidence: ['src/core/search/rrf.ts'],
      assigned: ['criticality', 'priority', 'unit'],
      review_by: '2026-08-20',
    },
  };
}

/** An id the committed ledger already carries, read from it rather than guessed. */
const existingId = (await Bun.file(LEDGER_PATH).text())
  .split('\n')
  .filter((line) => line.trim().length > 0)
  .map((line) => (JSON.parse(line) as { id: string }).id)[0]!;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'u19-apply-'));
  ledger = join(dir, 'concepts.jsonl');
  await Bun.write(ledger, await Bun.file(LEDGER_PATH).text());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('applyRows', () => {
  test('the fixture is the real ledger, and the id it reuses is really in it', async () => {
    // Without this the duplicate case below could be testing a row that was
    // never there, which is a different and trivially passing assertion.
    const text = await Bun.file(ledger).text();
    const ids = text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => (JSON.parse(line) as { id: string }).id);
    expect(ids.length).toBeGreaterThan(100);
    expect(ids).toContain(existingId);
    expect(ids).not.toContain('up.0-45-0-0.retrieval');
  });

  test('appends a fresh row and skips one already present', async () => {
    const before = (await Bun.file(ledger).text()).split('\n').filter((line) => line.trim().length > 0).length;

    const applied = await applyRows([row(existingId, 'retrieval'), row('up.0-45-0-0.retrieval', 'retrieval')], ledger);

    expect(applied).toEqual(['up.0-45-0-0.retrieval']);
    const after = (await Bun.file(ledger).text()).split('\n').filter((line) => line.trim().length > 0);
    expect(after.length).toBe(before + 1);
    expect(after.filter((line) => (JSON.parse(line) as { id: string }).id === existingId)).toHaveLength(1);
  });

  test('what it wrote still passes the gate it will be checked by', async () => {
    await applyRows([row('up.0-45-0-0.retrieval', 'retrieval')], ledger);
    const report = checkLedger(await Bun.file(ledger).text(), { today: TODAY });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  test('a second run over the same delta changes no bytes', async () => {
    const rows = [row('up.0-45-0-0.retrieval', 'retrieval'), row('up.0-45-0-0.schema', 'schema')];
    await applyRows(rows, ledger);
    const once = await Bun.file(ledger).text();

    expect(await applyRows(rows, ledger)).toEqual([]);
    expect(await Bun.file(ledger).text()).toBe(once);
  });

  test('a ledger with no trailing newline gets one, rather than a glued line', async () => {
    // The committed ledger happens to end with a newline, so the separator
    // branch is unexercised by every other test here — a mutation that deleted
    // it survived them all. JSONL has no recovery from two objects on one line:
    // `check-ledger` reports malformed JSON and names a line number that no
    // longer corresponds to a row anybody wrote.
    const trimmed = (await Bun.file(ledger).text()).replace(/\n+$/, '');
    await Bun.write(ledger, trimmed);

    await applyRows([row('up.0-45-0-0.retrieval', 'retrieval')], ledger);

    const lines = (await Bun.file(ledger).text()).split('\n').filter((line) => line.trim().length > 0);
    expect(() => lines.map((line) => JSON.parse(line))).not.toThrow();
    expect(checkLedger(await Bun.file(ledger).text(), { today: TODAY }).findings).toEqual([]);
    expect((JSON.parse(lines.at(-1)!) as { id: string }).id).toBe('up.0-45-0-0.retrieval');
  });

  test('an empty delta does not touch the file at all', async () => {
    const before = await Bun.file(ledger).text();
    expect(await applyRows([], ledger)).toEqual([]);
    expect(await Bun.file(ledger).text()).toBe(before);
  });

  test('the appended row is what the watcher produced, not a reshaped copy', async () => {
    const produced = row('up.0-45-0-0.retrieval', 'retrieval');
    await applyRows([produced], ledger);
    const last = (await Bun.file(ledger).text())
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .at(-1)!;
    expect(JSON.parse(last)).toEqual(produced);
  });
});
