/**
 * The create-to-first-query benchmark (U2 approach step 3).
 *
 * Alpha does not need this number — it provisions one tenant at a time and a
 * founder never races themselves. It is measured anyway because it sizes U15's
 * warm pool, and because it can answer that a pool is not needed at all. A pool
 * of pre-provisioned projects is real machinery with real cost and its own
 * failure modes; building one without knowing the latency it hides is how a
 * system acquires a component nobody can justify.
 *
 * The harness is pure: it takes a closure that provisions once, an injected
 * clock, and produces a report. Everything vendor-shaped is the caller's, which
 * is what lets the whole thing be tested deterministically with no network while
 * the real run drives it against live Neon (`test/control/provision.real.test.ts`,
 * gated on `BRAINZ_REAL_SUBSTRATE`).
 *
 * Two decisions worth stating, because both are ways a benchmark lies:
 *
 * **Latency covers successful provisions only.** A run that dies in 40ms because
 * the API rejected it is not a fast provision, and averaging it in moves the
 * number the flattering way. Failures are counted and reported beside the
 * latency so the two cannot be read apart.
 *
 * **The receipt is committed to a public repository**, so it carries numbers and
 * a closed set of failure codes — never a message, never an id, never a host.
 * The report models a failure as a *label from a known set*; anything else
 * becomes `unknown`. A harness that formats a driver's error text into a
 * committed file is a credential leak wearing a measurement's clothes, and the
 * error most likely to be quoted is the one holding the connection string.
 */

import { PROVISIONING_FAILURE_CODES, PROVISION_REJECTIONS } from './provision.ts';

/** What one timed attempt reports. Deliberately not `ProvisionResult`: the
 * harness must be drivable by anything, including a bare project-create probe. */
export type ProvisionAttempt =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: string };

export interface BenchmarkSample {
  readonly index: number;
  readonly ok: boolean;
  readonly elapsedMs: number;
  readonly failure: string | null;
}

export interface LatencySummary {
  /** Successful provisions. `null` percentiles below mean this was zero. */
  readonly count: number;
  readonly minMs: number | null;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly maxMs: number | null;
  readonly meanMs: number | null;
}

export interface BenchmarkReport {
  readonly runs: number;
  readonly succeeded: number;
  readonly failed: number;
  /** Attempts whose cleanup did not complete — i.e. resources possibly left. */
  readonly teardownFailures: number;
  readonly latency: LatencySummary;
  readonly failures: Readonly<Record<string, number>>;
  readonly samples: readonly BenchmarkSample[];
}

export interface BenchmarkOptions {
  readonly runs: number;
  /** One provision. Timed from just before the call to just after it returns. */
  readonly provision: (index: number) => Promise<ProvisionAttempt>;
  /** Cleanup for that run. Always called, never timed. */
  readonly teardown?: (index: number) => Promise<void>;
  /** Injectable clock. Defaults to a monotonic one. */
  readonly now?: () => number;
  readonly onSample?: (sample: BenchmarkSample) => void;
}

/** An attempt that threw rather than returning a result. */
export const THREW = 'threw';

/** A label outside the known set. The label itself is discarded, not printed. */
export const UNKNOWN_FAILURE = 'unknown';

const KNOWN_FAILURE_LABELS: ReadonlySet<string> = new Set<string>([
  ...PROVISIONING_FAILURE_CODES,
  ...PROVISION_REJECTIONS,
  THREW,
  UNKNOWN_FAILURE,
]);

/**
 * The sample size below which p99 is simply the maximum observed. The receipt
 * says so rather than printing a number that invites a pool sized on one
 * unlucky run.
 */
export const P99_MINIMUM_SAMPLE = 100;

/**
 * Nearest-rank, on a copy. `percentile(xs, 99)` is the smallest value at or
 * above which 99% of the samples fall — for 100 samples, the 99th smallest.
 * Chosen because it is the definition a reader can verify by counting, and
 * because it never invents a value that was not measured, the way interpolation
 * does.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? null;
}

function summarise(durations: readonly number[]): LatencySummary {
  if (durations.length === 0) {
    return {
      count: 0,
      minMs: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      maxMs: null,
      meanMs: null,
    };
  }

  const total = durations.reduce((sum, value) => sum + value, 0);

  return {
    count: durations.length,
    minMs: percentile(durations, 0),
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    maxMs: percentile(durations, 100),
    meanMs: Math.round((total / durations.length) * 10) / 10,
  };
}

function knownLabel(label: string): string {
  return KNOWN_FAILURE_LABELS.has(label) ? label : UNKNOWN_FAILURE;
}

export async function runProvisioningBenchmark(
  options: BenchmarkOptions,
): Promise<BenchmarkReport> {
  const { runs, provision } = options;
  if (runs < 1) throw new Error('a benchmark needs at least one run');

  const now = options.now ?? (() => performance.now());

  const samples: BenchmarkSample[] = [];
  const durations: number[] = [];
  const failures = new Map<string, number>();
  let succeeded = 0;
  let teardownFailures = 0;

  for (let index = 0; index < runs; index += 1) {
    const startedAt = now();
    let sample: BenchmarkSample;

    try {
      const attempt = await provision(index);
      const elapsedMs = now() - startedAt;
      sample = attempt.ok
        ? { index, ok: true, elapsedMs, failure: null }
        : { index, ok: false, elapsedMs, failure: knownLabel(attempt.failure) };
    } catch {
      // The error is deliberately not read: see the module note on receipts.
      sample = { index, ok: false, elapsedMs: now() - startedAt, failure: THREW };
    }

    if (sample.ok) {
      succeeded += 1;
      durations.push(sample.elapsedMs);
    } else if (sample.failure !== null) {
      failures.set(sample.failure, (failures.get(sample.failure) ?? 0) + 1);
    }

    samples.push(sample);
    options.onSample?.(sample);

    // Always, and outside the timing window. A benchmark that leaves projects
    // behind costs money and, worse, reports nothing about having done so.
    if (options.teardown !== undefined) {
      try {
        await options.teardown(index);
      } catch {
        teardownFailures += 1;
      }
    }
  }

  return {
    runs,
    succeeded,
    failed: runs - succeeded,
    teardownFailures,
    latency: summarise(durations),
    failures: Object.fromEntries([...failures.entries()].sort(([a], [b]) => a.localeCompare(b))),
    samples,
  };
}

function ms(value: number | null): string {
  return value === null ? 'not measured' : `${Math.round(value)} ms`;
}

/**
 * The committed receipt. Takes the report and nothing else — no title, no note,
 * no caller-supplied prose — so "this file carries no identifiers" is a property
 * of this function rather than a promise about how it is called.
 */
export function formatBenchmarkReceipt(report: BenchmarkReport): string {
  const failureRows =
    Object.keys(report.failures).length === 0
      ? '_None._'
      : Object.entries(report.failures)
          .map(([code, count]) => `- \`${code}\`: ${count}`)
          .join('\n');

  const caveat =
    report.latency.count < P99_MINIMUM_SAMPLE
      ? `> **Sample is fewer than 100 successful provisions** (${report.latency.count}), so the p99 above is simply the slowest run observed. Size a pool on it only as a lower bound.`
      : '> Percentiles are nearest-rank over successful provisions.';

  return [
    '## U2 — create-to-first-query benchmark',
    '',
    'Latency is measured over **successful** provisions only; failures are counted',
    'separately below. A run that fails fast is not a fast provision.',
    '',
    '| Measurement | Value |',
    '|---|---|',
    `| Provisions attempted | ${report.runs} |`,
    `| Succeeded | ${report.succeeded} |`,
    `| Failed | ${report.failed} |`,
    `| Cleanup failures | ${report.teardownFailures} |`,
    `| create-to-first-query p50 | ${ms(report.latency.p50Ms)} |`,
    `| create-to-first-query p95 | ${ms(report.latency.p95Ms)} |`,
    `| create-to-first-query p99 | ${ms(report.latency.p99Ms)} |`,
    `| fastest / slowest | ${ms(report.latency.minMs)} / ${ms(report.latency.maxMs)} |`,
    `| mean | ${ms(report.latency.meanMs)} |`,
    '',
    '### Failures by code',
    '',
    failureRows,
    '',
    caveat,
    '',
    '> Cleanup failures are the number that decides whether to go and look at the',
    '> vendor by hand. A run that is killed before it finishes reports nothing at all.',
    '',
  ].join('\n');
}
