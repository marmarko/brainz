/**
 * The benchmark harness measures U2's create-to-first-query latency, and the
 * number it produces sizes U15's warm pool — or retires it, if provisioning
 * turns out to be fast enough that a pool buys nothing.
 *
 * A measurement harness is worth testing for two reasons that have nothing to do
 * with arithmetic:
 *
 * 1. **A p50 that quietly includes failed runs is a lie in the flattering
 *    direction.** A run that dies in 40ms because the API rejected it is not a
 *    fast provision. Latency is summarised over successful runs only, and the
 *    failures are reported next to it so the number cannot be read alone.
 * 2. **The receipt is committed to a public repository.** So the report holds a
 *    closed set of failure *codes*, never a message — and the test below feeds
 *    the harness a provision function that throws an error containing a
 *    connection string, then scans the receipt for it. A harness that formats
 *    `error.message` into a committed file is a credential leak wearing a
 *    measurement's clothes.
 *
 * No network and no clock dependency: the clock is injected and the "provision"
 * is a closure, so every percentile below is exact rather than approximately
 * right on a fast machine.
 */

import { describe, expect, test } from 'bun:test';

import {
  formatBenchmarkReceipt,
  percentile,
  runProvisioningBenchmark,
  type BenchmarkReport,
  type ProvisionAttempt,
} from '../../src/control/benchmark.ts';

const LEAKY_DSN = 'postgres://role-fake:pw-fake@ep-fake.example.invalid/brainz';

/**
 * Identifier shapes that must never appear in a committed receipt. Deliberately
 * broader than what this test can produce — the point is the class, not the
 * fixture.
 */
const FORBIDDEN_SHAPES: readonly RegExp[] = [
  /postgres(ql)?:\/\//i,
  /@[a-z0-9-]+\.[a-z0-9.-]+/i,
  /\b(?:ep|br|proj)-[a-z0-9-]{4,}/i,
  /[A-Za-z0-9_-]{32,}/,
];

/** A harness driver whose every run takes exactly the milliseconds it is told. */
function scripted(
  clock: { ms: number },
  script: readonly (number | { readonly ms: number; readonly failure: string })[],
): (index: number) => Promise<ProvisionAttempt> {
  return (index) => {
    const step = script[index];
    if (step === undefined) throw new Error(`test: no script entry for run ${index}`);
    if (typeof step === 'number') {
      clock.ms += step;
      return Promise.resolve({ ok: true });
    }
    clock.ms += step.ms;
    return Promise.resolve({ ok: false, failure: step.failure });
  };
}

describe('percentiles', () => {
  test('nearest-rank: the p50 of ten samples is the fifth smallest', () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile(values, 99)).toBe(100);
    expect(percentile(values, 10)).toBe(10);
  });

  test('an unsorted input gives the same answer, and is not reordered in place', () => {
    const values = [30, 10, 20];
    expect(percentile(values, 50)).toBe(20);
    expect(values).toEqual([30, 10, 20]);
  });

  test('a single sample is every percentile of itself', () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 99)).toBe(7);
  });

  test('no samples means no percentile — not zero', () => {
    // Zero would print as a spectacular result. `null` prints as "not measured".
    expect(percentile([], 50)).toBeNull();
  });
});

describe('the benchmark harness', () => {
  test('summarises latency over successful runs only', async () => {
    const clock = { ms: 0 };
    const report = await runProvisioningBenchmark({
      runs: 4,
      now: () => clock.ms,
      provision: scripted(clock, [100, { ms: 5, failure: 'project_create_failed' }, 200, 300]),
    });

    expect(report.runs).toBe(4);
    expect(report.succeeded).toBe(3);
    expect(report.failed).toBe(1);
    expect(report.latency.count).toBe(3);
    expect(report.latency.minMs).toBe(100);
    expect(report.latency.maxMs).toBe(300);
    expect(report.latency.p50Ms).toBe(200);
    expect(report.latency.meanMs).toBe(200);
  });

  test('a fast failure cannot flatter the p50', async () => {
    const clock = { ms: 0 };
    const report = await runProvisioningBenchmark({
      runs: 3,
      now: () => clock.ms,
      provision: scripted(clock, [
        { ms: 1, failure: 'project_create_failed' },
        { ms: 1, failure: 'project_create_failed' },
        900,
      ]),
    });

    expect(report.latency.p50Ms).toBe(900);
    expect(report.failures).toEqual({ project_create_failed: 2 });
  });

  test('a provision that throws is recorded as a code, and the run continues', async () => {
    const clock = { ms: 0 };
    const report = await runProvisioningBenchmark({
      runs: 3,
      now: () => clock.ms,
      provision: (index) => {
        clock.ms += 50;
        if (index === 1) throw new Error(`connect failed: ${LEAKY_DSN}`);
        return Promise.resolve({ ok: true });
      },
    });

    expect(report.runs).toBe(3);
    expect(report.succeeded).toBe(2);
    expect(report.failures).toEqual({ threw: 1 });
    expect(JSON.stringify(report)).not.toContain('pw-fake');
  });

  test('teardown runs after every attempt, successful or not', async () => {
    const clock = { ms: 0 };
    const torn: number[] = [];

    await runProvisioningBenchmark({
      runs: 3,
      now: () => clock.ms,
      provision: (index) => {
        clock.ms += 10;
        if (index === 0) throw new Error('boom');
        if (index === 1) return Promise.resolve({ ok: false, failure: 'first_query_failed' });
        return Promise.resolve({ ok: true });
      },
      teardown: (index) => {
        torn.push(index);
        return Promise.resolve();
      },
    });

    expect(torn).toEqual([0, 1, 2]);
  });

  test('teardown time is not counted as provisioning latency', async () => {
    const clock = { ms: 0 };
    const report = await runProvisioningBenchmark({
      runs: 1,
      now: () => clock.ms,
      provision: () => {
        clock.ms += 100;
        return Promise.resolve({ ok: true });
      },
      teardown: () => {
        clock.ms += 5_000;
        return Promise.resolve();
      },
    });

    expect(report.latency.p50Ms).toBe(100);
  });

  test('a teardown that fails is counted, not swallowed and not fatal', async () => {
    // A benchmark that cannot clean up leaves billable projects behind. RESULT.md
    // learned that the expensive way: verify against the vendor, not against the
    // run's own claim of success.
    const clock = { ms: 0 };
    const report = await runProvisioningBenchmark({
      runs: 2,
      now: () => clock.ms,
      provision: () => {
        clock.ms += 10;
        return Promise.resolve({ ok: true });
      },
      teardown: () => Promise.reject(new Error(`could not delete: ${LEAKY_DSN}`)),
    });

    expect(report.succeeded).toBe(2);
    expect(report.teardownFailures).toBe(2);
    expect(JSON.stringify(report)).not.toContain('pw-fake');
  });

  test('a benchmark of zero runs is refused rather than reported', async () => {
    // An empty report with null percentiles reads as "measured, inconclusive".
    // It is neither.
    await expect(runProvisioningBenchmark({ runs: 0, provision: () => Promise.resolve({ ok: true }) })).rejects.toThrow(
      'at least one run',
    );
  });

  test('each sample is reported individually, in order', async () => {
    const clock = { ms: 0 };
    const report = await runProvisioningBenchmark({
      runs: 2,
      now: () => clock.ms,
      provision: scripted(clock, [10, { ms: 20, failure: 'timed_out' }]),
    });

    expect(report.samples).toEqual([
      { index: 0, ok: true, elapsedMs: 10, failure: null },
      { index: 1, ok: false, elapsedMs: 20, failure: 'timed_out' },
    ]);
  });
});

describe('the committed receipt', () => {
  async function receiptFor(
    runs: number,
    provision: (index: number) => Promise<ProvisionAttempt>,
    now?: () => number,
  ): Promise<{ report: BenchmarkReport; receipt: string }> {
    const report = await runProvisioningBenchmark(
      now === undefined ? { runs, provision } : { runs, provision, now },
    );
    return { report, receipt: formatBenchmarkReceipt(report) };
  }

  test('reports the numbers a pool-sizing decision needs', async () => {
    const clock = { ms: 0 };
    const { receipt } = await receiptFor(4, scripted(clock, [100, 200, 300, 400]), () => clock.ms);

    expect(receipt).toContain('p50');
    expect(receipt).toContain('p99');
    expect(receipt).toContain('4');
    expect(receipt).toContain('create-to-first-query');
  });

  test('says so when the sample is too small for the percentile it prints', async () => {
    // p99 of five samples is just the maximum. Printing it without saying that
    // invites a pool sized on one unlucky run.
    const clock = { ms: 0 };
    const { receipt } = await receiptFor(5, scripted(clock, [1, 2, 3, 4, 5]), () => clock.ms);

    expect(receipt.toLowerCase()).toContain('fewer than 100');
  });

  test('a receipt from a hundred runs carries no such caveat', async () => {
    const clock = { ms: 0 };
    const script = Array.from({ length: 100 }, (_, index) => index + 1);
    const { receipt } = await receiptFor(100, scripted(clock, script), () => clock.ms);

    expect(receipt.toLowerCase()).not.toContain('fewer than 100');
    expect(receipt).toContain('100');
  });

  test('carries no identifier, host, DSN or key shape — the repo is public', async () => {
    const clock = { ms: 0 };
    const { receipt } = await receiptFor(
      3,
      (index) => {
        clock.ms += 10;
        if (index === 0) throw new Error(`neon said: ${LEAKY_DSN} on project ep-fake-12345`);
        if (index === 1) return Promise.resolve({ ok: false, failure: 'role_create_failed' });
        return Promise.resolve({ ok: true });
      },
      () => clock.ms,
    );

    for (const shape of FORBIDDEN_SHAPES) {
      expect(receipt).not.toMatch(shape);
    }
    expect(receipt).toContain('role_create_failed');
    expect(receipt).toContain('threw');
  });

  test('a failure label the harness did not produce cannot reach the receipt', async () => {
    // Failure labels come from the provision closure, which is caller code. The
    // harness treats an unrecognised label as `unknown` rather than printing it:
    // a public receipt is the wrong place to trust a string.
    const clock = { ms: 0 };
    const { report, receipt } = await receiptFor(
      1,
      () => {
        clock.ms += 10;
        return Promise.resolve({ ok: false, failure: `boom ${LEAKY_DSN}` });
      },
      () => clock.ms,
    );

    expect(report.failures).toEqual({ unknown: 1 });
    expect(receipt).not.toContain('pw-fake');
    expect(receipt).toContain('unknown');
  });
});
