/**
 * The gates' own exit codes, and the four guards a mutation run walked past.
 *
 * **Why this file exists.** Every check in U7 is a function that returns a
 * verdict, and every *gate* is a process that turns that verdict into an exit
 * code a CI step reads. The verdict functions are covered exhaustively
 * (`test/evals/blocking.test.ts`, `test/evals/live-parity.test.ts`,
 * `test/evals/canary.test.ts`, `test/conformance/delta.test.ts`). The
 * translation from verdict to exit code was covered in exactly one direction:
 * the passing one.
 *
 * An adversarial mutation run made that concrete. Replacing
 *
 *     return result.passed ? 0 : 1;   →   return 0;
 *
 * in `evals/blocking.ts`, `evals/live-parity.ts`, `evals/canary.ts` and
 * `evals/conformance/run.ts` left the entire suite green — four commands whose
 * whole purpose is to be non-zero when something is wrong, and not one test
 * observed the non-zero. The refusal paths that *were* pinned
 * (`test/evals/commands.test.ts`) are the early returns for a missing
 * `BRAINZ_REAL_SUBSTRATE`, not the verdict.
 *
 * The same run found three more surviving guards, all of the same shape — a
 * check written against a state no test constructs:
 *
 *   - `classifyFloors` given an empty floor list. Its twin `checkFloors` throws
 *     and is tested; `classifyFloors` is the one the command actually calls, and
 *     an empty gate passes everything.
 *   - `assertDelta`'s re-derivation of the runner's own pass/fail/skip tallies.
 *     "Re-derived, never trusted" is the file's claim; deleting the comparison
 *     changed nothing.
 *   - `resolveGbrain`'s cache branch. The override branch and the post-clone
 *     branch both refuse an unverified checkout and both are tested; the cache
 *     branch is the one CI actually takes (`BRAINZ_GBRAIN_CACHE` plus
 *     `actions/cache`, keyed on the pin), and accepting a cache entry that is
 *     not at the pinned commit was invisible.
 *
 * These tests are written against the *failing* side of each guard, because the
 * passing side was never the part at risk.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { loadTierContext, main as blockingMain } from '../../evals/blocking.ts';
import { main as canaryMain } from '../../evals/canary.ts';
import { assertDelta, parseDelta, type PublishedDelta } from '../../evals/conformance/delta.ts';
import { GbrainUnresolvable, resolveGbrain, type Spawner } from '../../evals/conformance/gbrain.ts';
import { main as conformanceMain } from '../../evals/conformance/run.ts';
import { type GbrainPin } from '../../evals/conformance/pin.ts';
import { RANKING_FLOORS, classifyFloors } from '../../evals/gates.ts';
import { main as parityMain } from '../../evals/live-parity.ts';
import { runEval, type Ranker } from '../../evals/run.ts';

const ROOT = new URL('../..', import.meta.url).pathname;

/** Swallow the commands' human output; the exit code is what is under test. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = write;
  }
}

/** Set env vars for one call and put the previous values back afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// The verdict, as an exit code.
// ---------------------------------------------------------------------------

describe('a gate that measured something wrong exits non-zero', () => {
  test('eval:blocking returns 1 when a floor is missed, not just a printed MISSED line', async () => {
    // A ranker that answers nothing. Every floor is below its bar and none of
    // the misses is deferrable, so the tier's verdict is unambiguous — which is
    // the point: the assertion is about the number `main` returns, not about
    // which floor caught it.
    const silent: Ranker = {
      name: 'answers-nothing',
      description: 'returns no candidate for any query',
      rank: () => [],
    };
    const context = loadTierContext();
    const code = await quietly(() => blockingMain([], { ranker: silent, context }));
    expect(code).toBe(1);
  }, 120_000);

  test('eval:blocking still returns 0 on the shipped stack — the seam changes nothing else', async () => {
    const code = await quietly(() => blockingMain([]));
    expect(code).toBe(0);
  }, 120_000);

  test('eval:live-parity returns 1 when it compared nothing, with the substrate gate open', async () => {
    // Past the `BRAINZ_REAL_SUBSTRATE` refusal that `commands.test.ts` already
    // pins, into the verdict itself. No provider vector is committed, so the
    // command reaches `checkEmbeddingParity` with an empty sample set and makes
    // no model call: the refusal it returns is the thing being checked.
    const code = await withEnv(
      { BRAINZ_REAL_SUBSTRATE: '1', OPENAI_API_KEY: undefined },
      () => quietly(() => parityMain([])),
    );
    expect(code).toBe(1);
  }, 60_000);

  test('eval:canary returns 1 when nothing is gradeable, with the substrate gate open', async () => {
    const code = await withEnv(
      { BRAINZ_REAL_SUBSTRATE: '1', BRAINZ_CANARY_TENANT: undefined },
      () => quietly(() => canaryMain([])),
    );
    expect(code).toBe(1);
  }, 60_000);

  test('conformance returns 1 when the pinned runner cannot be resolved', async () => {
    // This repository is a git checkout at a sha that is not gbrain's pinned
    // commit, so it is the cheapest unresolvable override there is — no clone,
    // no network. `NOT RUN` must never be exit 0: a wrapper that could not
    // fetch the runner has certified nothing.
    const code = await withEnv({ BRAINZ_GBRAIN_REPO: ROOT }, () =>
      quietly(() => conformanceMain([])),
    );
    expect(code).toBe(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Three guards written against a state no other test constructs.
// ---------------------------------------------------------------------------

describe('classifyFloors refuses an empty gate', () => {
  const context = loadTierContext();
  const report = runEval(
    { name: 'answers-nothing', description: 'x', rank: () => [] },
    context,
  );

  test('an empty floor list throws rather than passing everything', () => {
    expect(() => classifyFloors(report, [], context)).toThrow(/empty gate passes everything/);
  });

  test('the real floor list still classifies every floor', () => {
    expect(classifyFloors(report, RANKING_FLOORS, context).outcomes.length).toBe(RANKING_FLOORS.length);
  });
});

describe('assertDelta re-derives the runner tallies rather than trusting them', () => {
  const OBSERVED: PublishedDelta = parseDelta(
    JSON.stringify({
      profile: 'memory-verbs-v1-partial',
      protocol_version: 1,
      status: 'observed',
      gbrain_commit: 'a'.repeat(40),
      observed_on: '2026-08-13',
      rationale: 'fixture',
      deviations: [],
    }),
  );

  const report = (over: Record<string, unknown>) => ({
    protocol_version: 1,
    results: [{ name: 'advertises recall', verb: 'recall', status: 'pass', detail: '' }],
    passed: 1,
    failed: 0,
    skipped: 0,
    ok: true,
    ...over,
  });

  test('a report whose counts disagree with its own rows is inconsistent_report', () => {
    // Every row passes and the delta declares no deviation, so the exact-set
    // comparison is satisfied — the tally is the only thing wrong, and it is a
    // runner whose verdict cannot be used in either direction.
    const result = assertDelta(report({ passed: 9 }), OBSERVED, { gbrainCommit: 'a'.repeat(40) });
    expect(result.passed).toBe(false);
    expect(result.violations.map((violation) => violation.kind)).toEqual(['inconsistent_report']);
  });

  test('a report claiming ok while carrying a failure it declared is still inconsistent', () => {
    const result = assertDelta(
      report({
        results: [{ name: 'synthesize is advertised', verb: 'synthesize', status: 'fail', detail: 'unavailable' }],
        passed: 0,
        failed: 1,
        skipped: 0,
        ok: true,
      }),
      parseDelta(
        JSON.stringify({
          profile: 'memory-verbs-v1-partial',
          protocol_version: 1,
          status: 'observed',
          gbrain_commit: 'a'.repeat(40),
          observed_on: '2026-08-13',
          rationale: 'fixture',
          deviations: [
            {
              case: 'synthesize is advertised',
              verb: 'synthesize',
              status: 'fail',
              reason: 'KTD3 keeps synthesize dispatchable-but-unadvertised',
            },
          ],
        }),
      ),
      { gbrainCommit: 'a'.repeat(40) },
    );
    expect(result.violations.map((violation) => violation.kind)).toEqual(['inconsistent_report']);
  });

  test('an honest tally over the same rows is clean — the check is not just always-on', () => {
    const result = assertDelta(report({}), OBSERVED, { gbrainCommit: 'a'.repeat(40) });
    expect(result.passed).toBe(true);
  });
});

describe('resolveGbrain refuses a cache entry that is not at the pinned commit', () => {
  const SHA = 'a'.repeat(40);
  const PIN: GbrainPin = {
    repo: 'https://example.com/gbrain.git',
    tag: 'v0.0.0',
    commit: SHA,
    pinned_on: '2026-08-13',
    advanced_by: 'test',
  };

  const roots: string[] = [];
  const cacheAt = (head: string): string => {
    const root = mkdtempSync(join(tmpdir(), 'brainz-gbrain-cache-'));
    roots.push(root);
    mkdirSync(join(root, SHA, '.git'), { recursive: true });
    void head;
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const gitAt = (head: string): Spawner => (input) => {
    if (input.cmd[1] === 'rev-parse') return { ok: true, stdout: head, stderr: '' };
    if (input.cmd[1] === 'status') return { ok: true, stdout: '', stderr: '' };
    return { ok: false, stdout: '', stderr: `unexpected ${input.cmd.join(' ')}` };
  };

  test('a cache directory keyed by the pinned sha but sitting at another commit throws', () => {
    // The path says the pinned sha; the checkout does not. Half-written or
    // tampered with, it is not the pinned build — and this is the branch CI
    // takes, since the workflow restores `BRAINZ_GBRAIN_CACHE` from
    // `actions/cache` before the command runs.
    const cacheRoot = cacheAt('b'.repeat(40));
    expect(() => resolveGbrain({ pin: PIN, spawner: gitAt('b'.repeat(40)), cacheRoot })).toThrow(
      GbrainUnresolvable,
    );
    expect(() => resolveGbrain({ pin: PIN, spawner: gitAt('b'.repeat(40)), cacheRoot })).toThrow(
      /cached checkout .* is not the pinned build/,
    );
  });

  test('a cache directory at the pinned commit resolves, and says it came from the cache', () => {
    const cacheRoot = cacheAt(SHA);
    const resolved = resolveGbrain({ pin: PIN, spawner: gitAt(SHA), cacheRoot });
    expect(resolved.source).toBe('cache');
    expect(resolved.dir).toBe(join(cacheRoot, SHA));
  });

  test('a dirty cache checkout at the right commit is still refused', () => {
    const cacheRoot = cacheAt(SHA);
    const dirty: Spawner = (input) => {
      if (input.cmd[1] === 'rev-parse') return { ok: true, stdout: SHA, stderr: '' };
      if (input.cmd[1] === 'status') return { ok: true, stdout: ' M src/cli.ts\n', stderr: '' };
      return { ok: false, stdout: '', stderr: 'unexpected' };
    };
    expect(() => resolveGbrain({ pin: PIN, spawner: dirty, cacheRoot })).toThrow(GbrainUnresolvable);
  });
});
