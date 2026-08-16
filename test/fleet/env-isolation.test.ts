/**
 * The fleet fixture promises a spawned entrypoint sees `options.env` and
 * nothing else. Bun breaks that promise silently.
 *
 * `Bun.spawn({ env })` sets the child's environment — and then Bun, starting up
 * inside the child, reads `.env` from its cwd and merges those values in on top
 * of nothing. So on a machine where the fleet is actually configured, every
 * variable the operator set is visible to every fleet test, and a test asking
 * what happens when a required variable is ABSENT silently becomes a test of
 * what happens when it is present.
 *
 * The failure mode is inverted, which is what makes it worth a dedicated test:
 * CI has no `.env`, so CI stays green and reports the guarantee holds. It breaks
 * only on the machines holding real credentials — exactly where a fail-closed
 * startup check earns its keep.
 *
 * These tests plant a `.env` in a scratch directory rather than leaning on the
 * repository's, so they assert the same thing on a contributor's laptop and on a
 * runner that has never seen a credential.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnArgv } from './fixture.ts';

const scratch = mkdtempSync(join(tmpdir(), 'brainz-envisolation-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const PROBE = join(scratch, 'probe.ts');
writeFileSync(
  PROBE,
  `console.log(process.env['BRAINZ_LEAKED_FROM_DOTENV'] ?? 'absent');\n`,
  'utf8',
);
writeFileSync(join(scratch, '.env'), `BRAINZ_LEAKED_FROM_DOTENV='leaked'\n`, 'utf8');

async function run(argv: readonly string[]): Promise<string> {
  const proc = Bun.spawn([...argv], {
    cwd: scratch,
    env: { PATH: process.env['PATH'] ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

describe('a spawned entrypoint sees the environment it was given', () => {
  test('the child does not inherit a .env sitting in its working directory', async () => {
    expect(await run(spawnArgv(PROBE))).toBe('absent');
  });

  /**
   * The control. Without this the test above passes for the wrong reason on any
   * runner where the planted `.env` was never readable in the first place — and
   * a guard that cannot distinguish "suppressed" from "never there" is not a
   * guard. This asserts the leak is real and that suppressing it is what the
   * flag does.
   */
  test('and without the suppression the same child reads that .env', async () => {
    expect(await run(['bun', 'run', PROBE])).toBe('leaked');
  });

  test('the fixture builds its argv with the suppression, so removing it fails here', () => {
    expect(spawnArgv('src/mcp/serve.ts')).toEqual([
      'bun',
      'run',
      '--env-file=/dev/null',
      'src/mcp/serve.ts',
    ]);
  });
});
