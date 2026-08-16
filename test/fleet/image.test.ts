/**
 * The image names entrypoints that serve.
 *
 * **The failure this refuses.** `CMD ["bun","run","src/mcp/server.ts"]` named a
 * module that only exports a factory. Run, it evaluated some definitions and
 * exited `0` — empty stdout, nothing on :8080 — and a container platform read
 * that as a healthy start. Nothing in the repo could see it, because the check
 * everybody would write ("the handler exists") was true the whole time.
 *
 * So the assertion here is not "the file exists" and not "it exports something".
 * It is: **run the module the image names, with nothing configured, and watch it
 * refuse.** A module that binds a socket cannot do so without its configuration
 * and exits non-zero saying which variable is missing; a module that only
 * defines things exits `0` and says nothing. That difference is the whole bug,
 * and it is the one thing a mutation back to `server.ts` cannot survive.
 *
 * `src/mcp/router.ts` is read as text rather than imported: it imports
 * `@cloudflare/containers`, which imports the workerd-only `cloudflare:workers`,
 * so nothing importing it can be loaded by a blocking test. Its own header says
 * as much.
 */

import { describe, expect, test } from 'bun:test';

import { REPO_ROOT } from './fixture.ts';

const DOCKERFILE = `${REPO_ROOT}/Dockerfile`;
const ROUTER = `${REPO_ROOT}/src/mcp/router.ts`;

/** `CMD ["bun", "run", "<entry>"]`, as a list of arguments. */
function cmdOf(dockerfile: string): string[] {
  const match = /^CMD\s+(\[[^\]]*\])/m.exec(dockerfile);
  if (match?.[1] === undefined) throw new Error('the Dockerfile declares no exec-form CMD');
  return JSON.parse(match[1]) as string[];
}

/** The `entrypoint = [...]` a Container class overrides, if it overrides one. */
function entrypointOf(router: string, className: string): string[] | null {
  const body = new RegExp(
    `class\\s+${className}\\s+extends[^{]*\\{([\\s\\S]*?)\\n\\}`,
  ).exec(router);
  if (body?.[1] === undefined) throw new Error(`src/mcp/router.ts declares no class ${className}`);
  const entry = /entrypoint\s*=\s*(\[[^\]]*\])/.exec(body[1]);
  return entry?.[1] === undefined ? null : (JSON.parse(entry[1].replace(/'/g, '"')) as string[]);
}

/**
 * Start the module with an empty configuration and report how it ended.
 *
 * `env` is deliberately near-empty: the point is to distinguish "refused to
 * start, loudly" from "ran to completion having served nothing", and both
 * outcomes are fast.
 */
async function runBare(entry: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', entry], {
    cwd: REPO_ROOT,
    env: { PATH: process.env['PATH'] ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe('the fleet image names entrypoints that listen', () => {
  test('the CMD is an exec-form bun invocation of a file that exists', async () => {
    const cmd = cmdOf(await Bun.file(DOCKERFILE).text());
    expect(cmd.slice(0, 2)).toEqual(['bun', 'run']);
    const entry = cmd[2] ?? '';
    expect(await Bun.file(`${REPO_ROOT}/${entry}`).exists()).toBe(true);
  });

  test('the worker fleet overrides the entrypoint, and it is a different file', async () => {
    const router = await Bun.file(ROUTER).text();
    const worker = entrypointOf(router, 'WorkerFleet');
    const cmd = cmdOf(await Bun.file(DOCKERFILE).text());

    // One image, two fleets. Without the override the worker fleet runs the
    // MCP server: up, healthy, and running no consolidation cycles at all.
    expect(worker).not.toBeNull();
    expect(worker?.slice(0, 2)).toEqual(['bun', 'run']);
    expect(worker?.[2]).not.toBe(cmd[2]);
    expect(await Bun.file(`${REPO_ROOT}/${worker?.[2] ?? ''}`).exists()).toBe(true);

    // The MCP fleet deliberately names none: it runs the image's own CMD, so the
    // default lives in one place rather than in two that can drift.
    expect(entrypointOf(router, 'McpFleet')).toBeNull();
  });

  test(
    'both entrypoints refuse to start unconfigured rather than exiting zero',
    async () => {
      const cmd = cmdOf(await Bun.file(DOCKERFILE).text());
      const worker = entrypointOf(await Bun.file(ROUTER).text(), 'WorkerFleet');

      for (const entry of [cmd[2] ?? '', worker?.[2] ?? '']) {
        const outcome = await runBare(entry);
        // Non-zero, so the platform restarts and reports a crash loop somebody
        // can see. `exit(0)` having served nothing is the original bug.
        expect(outcome.exitCode).not.toBe(0);
        expect(outcome.stderr).toContain('refusing to start');
        // And it must not have claimed to be listening.
        expect(outcome.stdout).not.toContain('listening');
      }
    },
    60_000,
  );
});
