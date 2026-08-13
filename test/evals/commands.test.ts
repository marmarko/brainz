/**
 * The Verification Contract's command names, as the dispatcher resolves them.
 *
 * `package.json` points every declared command at `scripts/not-yet.ts`, which
 * U1 chose so that "CI configuration, docs and muscle memory never have to
 * change when the implementation lands — only the script body does". This file
 * pins both halves of that bargain:
 *
 *   - a command U7 implemented actually runs its gate;
 *   - a command still owned by a later unit prints the same refusal it always
 *     printed and exits non-zero, because a stub that passes makes an
 *     unimplemented gate look green.
 *
 * These run the real subprocess rather than importing the router, because the
 * thing being checked is what `bun run <name>` does — the exit code a CI step
 * reads, not a function's return value.
 */

import { describe, expect, test } from 'bun:test';

const ROOT = new URL('../..', import.meta.url).pathname;

/**
 * The child's environment, with every gate variable stripped.
 *
 * **This is not tidiness.** `real-substrate.yml` runs `bun test` with
 * `BRAINZ_REAL_SUBSTRATE=1` set, and two cases below assert that the scheduled
 * tiers REFUSE without it. Inheriting the parent's environment would make those
 * two assertions pass locally, pass in the PR job, and fail the moment the
 * nightly workflow has a registered suite to run — a failure that arrives in a
 * different job, weeks later, in the workflow whose whole purpose is to be
 * believed. Stripping the credentials as well keeps the "no credentials in
 * tests" constraint true for anything this file spawns, rather than true only
 * for what it imports.
 */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const stripped = new Set([
    'BRAINZ_REAL_SUBSTRATE',
    'BRAINZ_CANARY_TENANT',
    'OPENAI_API_KEY',
    'NEON_API_KEY',
  ]);
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !stripped.has(key)) env[key] = value;
  }
  return env;
}

async function run(script: string, args: readonly string[] = []) {
  const proc = Bun.spawn({
    cmd: ['bun', 'run', script, ...args],
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: childEnv(),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe('a command still owned by a later unit stays loudly unimplemented', () => {
  test('test:roundtrip exits non-zero and names its owning unit', async () => {
    const result = await run('test:roundtrip');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('test:roundtrip is declared but not implemented yet');
    expect(result.stderr).toContain('owned by U17');
    // The exact clause U1 wrote, kept verbatim: it is the sentence that stops
    // somebody wiring the placeholder into CI as a passing gate.
    expect(result.stderr).toContain('an unimplemented\n  gate must never look green');
  });

  test('an unknown command name is refused rather than silently succeeding', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', 'run', 'scripts/not-yet.ts', 'eval:imaginary', 'U99'],
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      env: childEnv(),
    });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('eval:imaginary is declared but not implemented yet');
  });

  test('the router with no arguments is a usage error, not a pass', async () => {
    const proc = Bun.spawn({
      cmd: ['bun', 'run', 'scripts/not-yet.ts'],
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
      env: childEnv(),
    });
    expect(await proc.exited).toBe(2);
  });
});

describe('the commands U7 implemented run their gate', () => {
  test('eval:blocking runs the floors and exits 0 on the shipped stack', async () => {
    const result = await run('eval:blocking');
    expect(result.stdout).toContain('blocking tier — ranker: u5-retrieval-stack');
    expect(result.stdout).toContain('aggregate.ndcg10');
    // The deferral block prints on every run, pass or fail.
    expect(result.stdout).toContain('R6 floors NOT YET MEASURABLE');
    expect(result.exitCode).toBe(0);
  }, 120_000);

  test('eval:canary --preflight answers the question a nightly workflow asks', async () => {
    const result = await run('eval:canary', ['--preflight']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('gradeable=0');
    expect(result.stdout).toContain('deferred=2');
  }, 60_000);

  test('eval:canary without the real-substrate gate refuses instead of grading nothing', async () => {
    const result = await run('eval:canary');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('NOT RUN');
  }, 60_000);

  test('eval:live-parity without the real-substrate gate refuses', async () => {
    const result = await run('eval:live-parity');
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('NOT RUN');
  }, 60_000);

  test('eval:live-parity --preflight reports what is committed to compare against', async () => {
    // The scheduled workflow branches on this. It answers even without the
    // substrate flag, because the question ("is there anything to compare?") is
    // about committed data rather than about a live provider.
    const result = await run('eval:live-parity', ['--preflight']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('samples=0');
  }, 60_000);
});
