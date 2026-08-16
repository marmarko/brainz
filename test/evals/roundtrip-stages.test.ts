/**
 * `test:roundtrip` reports what it ran, and nothing else.
 *
 * The command's own header says "each stage reports for itself; nothing here
 * reports a stage it did not run", and underneath that sentence the first stage
 * was a hardcoded `ok`: with `BRAINZ_REAL_SUBSTRATE` set it printed
 * `ok  export the source brain` having opened no database and exported nothing.
 * Contained — the command exits non-zero while any stage is deferred, so no gate
 * ever went green on it — and precisely the failure the file exists to prevent,
 * which is why it gets a test rather than a comment.
 *
 * **The trap here is a test that agrees with the code by construction.** Reading
 * `stages()` and asserting the statuses it returns proves only that a literal is
 * a literal. So the rule is asserted the other way round: for any stage claiming
 * `ok`, this file demands the evidence of a run — and there is none to demand,
 * because nothing in this environment provisions a tenant. A future stage that
 * genuinely executes has to bring that evidence with it.
 */

import { describe, expect, test } from 'bun:test';

import { main, STAGES, stages } from '../../evals/roundtrip.ts';

describe('the stage list is the four legs R18 names', () => {
  test('all four, in order, and not fewer', () => {
    expect([...STAGES]).toEqual([
      'export the source brain',
      'provision a fresh tenant',
      'import the tree through the folder path',
      're-consolidate, then score the blocking eval',
    ]);
    expect(stages().map((stage) => stage.stage)).toEqual([...STAGES]);
  });
});

describe('no stage reports a status it did not earn', () => {
  test(
    'nothing claims ok, because nothing in this environment provisions a tenant to run against',
    () => {
      // Every leg of this command needs a fresh tenant: the export needs a brain
      // to export, the import needs somewhere to import to, and the score needs
      // a consolidated corpus. None of that exists here, so an `ok` in this list
      // would be a claim with nothing behind it.
      const claimed = stages().filter((stage) => stage.status === 'ok');
      expect(claimed).toEqual([]);
    },
  );

  test('every deferred stage says why, and points somewhere real when it can', () => {
    for (const stage of stages()) {
      expect(stage.status).toBe('deferred');
      expect(stage.detail.length).toBeGreaterThan(20);
    }
    // The export leg is genuinely proven, just not by this command. A reader
    // told "deferred" with no pointer would reasonably conclude nothing checks
    // it, which is also untrue.
    expect(stages()[0]?.detail).toContain('test/core/export/roundtrip-file-parity.test.ts');
  });
});

describe('the command refuses either way rather than reporting a comparison it did not make', () => {
  test('without the substrate, and with it', async () => {
    const said: string[] = [];
    const capture = process.stdout.write.bind(process.stdout);
    // `main` writes to stdout; the exit code is the contract under test.
    process.stdout.write = ((chunk: string) => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    const before = process.env['BRAINZ_REAL_SUBSTRATE'];
    try {
      delete process.env['BRAINZ_REAL_SUBSTRATE'];
      expect(await main([])).toBe(1);

      process.env['BRAINZ_REAL_SUBSTRATE'] = '1';
      expect(await main([])).toBe(1);
    } finally {
      process.stdout.write = capture;
      if (before === undefined) delete process.env['BRAINZ_REAL_SUBSTRATE'];
      else process.env['BRAINZ_REAL_SUBSTRATE'] = before;
    }

    // And the output a reader sees never contains an `ok` line.
    expect(said.join('')).not.toMatch(/^\s*ok\s/m);
  });
});
