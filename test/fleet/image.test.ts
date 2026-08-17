/**
 * The image names entrypoints that serve, and starts them with a secret store.
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
 * **The second half of this file is the bootstrap**, which is the answer to a
 * question the image could not previously answer: where does the secret store
 * come from? A secrets file baked into the image is a credential in a build
 * artefact, and a path handed in by configuration is a way to point a fleet at
 * one. So every start path routes through one script that materialises the store
 * from a secret and owns the path. That script is *executed* here, under `sh`,
 * because a Dockerfile line nobody runs is a claim rather than a control.
 *
 * `src/mcp/router.ts` is read as text rather than imported: it imports
 * `@cloudflare/containers`, which imports the workerd-only `cloudflare:workers`,
 * so nothing importing it can be loaded by a blocking test. Its own header says
 * as much. (`test/fleet/router-env.test.ts` supplies that built-in with
 * `mock.module` and asserts the classes' `envVars` by construction; what stays
 * here is the argv, which is a fact about the image.)
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { REPO_ROOT, spawnArgv } from './fixture.ts';

const DOCKERFILE = `${REPO_ROOT}/Dockerfile`;
const ROUTER = `${REPO_ROOT}/src/mcp/router.ts`;

/** Where the bootstrap lands in the image. Both start paths must name it. */
const BOOTSTRAP_PATH = '/usr/local/bin/fleet-bootstrap';

/** `CMD ["…"]`, as a list of arguments. */
function cmdOf(dockerfile: string): string[] {
  const match = /^CMD\s+(\[[^\]]*\])/m.exec(dockerfile);
  if (match?.[1] === undefined) throw new Error('the Dockerfile declares no exec-form CMD');
  return JSON.parse(match[1]) as string[];
}

/** The `entrypoint = [...]` a Container class overrides, if it overrides one. */
function entrypointOf(router: string, className: string): string[] | null {
  const body = new RegExp(`class\\s+${className}\\s+extends[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(
    router,
  );
  if (body?.[1] === undefined) throw new Error(`src/mcp/router.ts declares no class ${className}`);
  const entry = /entrypoint\s*=\s*(\[[^\]]*\])/.exec(body[1]);
  return entry?.[1] === undefined ? null : (JSON.parse(entry[1].replace(/'/g, '"')) as string[]);
}

/**
 * The serving module a start path ends at: `[<bootstrap>, "bun", "run", <entry>]`.
 *
 * Asserted as a shape rather than picked out by index, so a start path that
 * skipped the bootstrap — the mutation that would give one fleet a secret store
 * and the other none — fails here instead of at the first tenant resolve.
 */
function servingModuleOf(argv: readonly string[]): string {
  expect(argv.slice(0, 3)).toEqual([BOOTSTRAP_PATH, 'bun', 'run']);
  expect(argv).toHaveLength(4);
  return argv[3] as string;
}

/**
 * The bootstrap's source, lifted out of the Dockerfile heredoc that installs it.
 *
 * Extracted rather than kept as a separate file so there is exactly one copy: a
 * `bin/` script and a Dockerfile that `COPY`s it are two things that can drift,
 * and the drift would be invisible until a deployed container read an empty
 * store.
 */
function bootstrapOf(dockerfile: string): string {
  const match = /<<'FLEET_BOOTSTRAP'[^\n]*\n([\s\S]*?)\nFLEET_BOOTSTRAP\n/.exec(dockerfile);
  if (match?.[1] === undefined) {
    throw new Error('the Dockerfile installs no FLEET_BOOTSTRAP heredoc');
  }
  return match[1];
}

interface BootstrapRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the bootstrap under `sh` with a given environment, and let it `exec` its
 * arguments. `/usr/bin/env` is the probe: whatever the started process sees is
 * what it prints, which is the only honest way to ask what survived.
 */
async function runBootstrap(
  env: Readonly<Record<string, string>>,
  argv: readonly string[] = ['/usr/bin/env'],
): Promise<BootstrapRun> {
  const scratch = mkdtempSync(join(tmpdir(), 'brainz-bootstrap-'));
  try {
    const script = join(scratch, 'fleet-bootstrap');
    await Bun.write(script, `${bootstrapOf(await Bun.file(DOCKERFILE).text())}\n`);
    const proc = Bun.spawn(['sh', script, ...argv], {
      cwd: scratch,
      // `bun` has to be reachable: the bootstrap validates the store with it
      // rather than shipping a JSON parser written in shell.
      env: { PATH: process.env['PATH'] ?? '', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Remove a materialised store and the private directory the bootstrap made for
 * it. The bootstrap deliberately does not clean up after itself — it `exec`s, so
 * it never runs again — and a container filesystem is thrown away. A test
 * running on somebody's laptop is not.
 */
function discardStore(path: string): void {
  rmSync(dirname(path), { recursive: true, force: true });
}

/** One `NAME=value` line out of `env` output. */
function envLine(stdout: string, name: string): string | undefined {
  const line = stdout.split('\n').find((entry) => entry.startsWith(`${name}=`));
  return line === undefined ? undefined : line.slice(name.length + 1);
}

/**
 * Start the module with an empty configuration and report how it ended.
 *
 * `env` is deliberately near-empty: the point is to distinguish "refused to
 * start, loudly" from "ran to completion having served nothing", and both
 * outcomes are fast.
 *
 * `spawnArgv` supplies `--env-file=/dev/null`, which is load-bearing here rather
 * than tidy. Without it Bun reads the repository's own `.env` inside the child,
 * so on a machine where the fleet is actually configured this test asks what
 * happens when a variable is absent and is answered about a variable that is
 * present — and on a fully configured machine the process would bind a socket
 * and hang instead of refusing. CI, which has no `.env`, would never show it.
 */
async function runBare(entry: string): Promise<BootstrapRun> {
  const proc = Bun.spawn([...spawnArgv(entry)], {
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
  test('the CMD routes through the bootstrap to a file that exists', async () => {
    const entry = servingModuleOf(cmdOf(await Bun.file(DOCKERFILE).text()));
    expect(await Bun.file(`${REPO_ROOT}/${entry}`).exists()).toBe(true);
  });

  test('the other two fleets override the entrypoint, each onto its own file', async () => {
    const router = await Bun.file(ROUTER).text();
    const cmd = cmdOf(await Bun.file(DOCKERFILE).text());
    const cmdEntry = servingModuleOf(cmd);

    // One image, three fleets. Without the override a fleet runs the MCP
    // server: up, healthy, and doing none of its own work — no consolidation
    // cycle for the worker fleet, and for the web fleet a second copy of the
    // MCP surface where the signup page should be.
    for (const className of ['WorkerFleet', 'WebFleet'] as const) {
      const override = entrypointOf(router, className);
      expect({ className, overridden: override !== null }).toEqual({ className, overridden: true });
      const entry = servingModuleOf(override as string[]);
      expect({ className, entry }).not.toEqual({ className, entry: cmdEntry });
      expect({ className, exists: await Bun.file(`${REPO_ROOT}/${entry}`).exists() }).toEqual({
        className,
        exists: true,
      });
    }

    // And they are not each other's, which a copy-paste of the class would make
    // them: two fleets on one entrypoint is one fleet with a spare bill.
    expect(servingModuleOf(entrypointOf(router, 'WorkerFleet') as string[])).not.toBe(
      servingModuleOf(entrypointOf(router, 'WebFleet') as string[]),
    );

    // The MCP fleet deliberately names none: it runs the image's own CMD, so the
    // default lives in one place rather than in two that can drift.
    expect(entrypointOf(router, 'McpFleet')).toBeNull();
  });

  /**
   * Cloudflare's `entrypoint` replaces the container's whole command rather than
   * appending to it, so a class that named `bun` directly would start with no
   * secret store while the fleet inheriting the image's `CMD` started with one —
   * an asymmetry that is invisible until the worker fleet resolves its first
   * tenant and finds nothing.
   */
  test('every start path runs the same bootstrap', async () => {
    const dockerfile = await Bun.file(DOCKERFILE).text();
    const router = await Bun.file(ROUTER).text();
    const starts = [
      cmdOf(dockerfile),
      entrypointOf(router, 'WorkerFleet') as string[],
      entrypointOf(router, 'WebFleet') as string[],
    ];
    for (const argv of starts) expect(argv[0]).toBe(BOOTSTRAP_PATH);
    // And the image actually installs it at that path.
    expect(dockerfile).toContain(BOOTSTRAP_PATH);
  });

  test(
    'every entrypoint refuses to start unconfigured rather than exiting zero',
    async () => {
      const dockerfile = await Bun.file(DOCKERFILE).text();
      const router = await Bun.file(ROUTER).text();
      const entries = [
        servingModuleOf(cmdOf(dockerfile)),
        servingModuleOf(entrypointOf(router, 'WorkerFleet') as string[]),
        servingModuleOf(entrypointOf(router, 'WebFleet') as string[]),
      ];

      for (const entry of entries) {
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

describe('the image starts a fleet with a secret store it did not ship', () => {
  const STORE = '{"secrets":{},"providerKeys":{}}';

  test('an unconfigured store is a refusal on the backend that needs one', async () => {
    const outcome = await runBootstrap({ BRAINZ_SECRET_BACKEND: 'file' });
    expect(outcome.exitCode).not.toBe(0);
    // `refusing to start:` is `env.ts`'s phrasing. One phrase for every
    // configuration refusal, whichever layer noticed, because the operator
    // reading it is looking at a container log with no other context.
    expect(outcome.stderr).toContain('refusing to start');
    expect(outcome.stderr).toContain('BRAINZ_SECRETS_JSON');
    // It refused instead of starting the fleet with an empty store.
    expect(outcome.stdout).toBe('');
  });

  /**
   * The other side of the same rule, and the reason the refusal above had to
   * become conditional.
   *
   * On the default backend the store is the control-plane database, and
   * `BRAINZ_SECRETS_JSON` is only a bootstrap seed
   * (`src/control/secret-pg.ts:importSecretSeed`). A deployment that has
   * migrated deletes the secret — so refusing without one would make the
   * migrated state unreachable, and force an operator to keep a stale snapshot
   * of every tenant's credentials set forever to satisfy a check about a store
   * this image no longer reads.
   */
  test('no seed is a normal start on the durable backend, and materialises nothing', async () => {
    const outcome = await runBootstrap({});
    expect(outcome.exitCode).toBe(0);
    // Handed over to the fleet without inventing a path, and without leaving a
    // file behind for anything to read.
    expect(envLine(outcome.stdout, 'BRAINZ_SECRETS_FILE')).toBeUndefined();
    expect(outcome.stderr).not.toContain('refusing to start');
  });

  test('a store that is not a JSON object is refused before the fleet starts', async () => {
    for (const malformed of ['not json at all', '[]', '"a string"']) {
      const outcome = await runBootstrap({ BRAINZ_SECRETS_JSON: malformed });
      expect(outcome.exitCode).not.toBe(0);
      expect(outcome.stderr).toContain('refusing to start');
      expect(outcome.stdout).toBe('');
    }
  });

  /**
   * The whole point of the bootstrap, in one assertion: the fleet process is
   * handed a path the *image* chose, holding content the *deployment* supplied.
   * Neither half can come from the other.
   */
  test('a configured store reaches the started process as a file it can read', async () => {
    const outcome = await runBootstrap({ BRAINZ_SECRETS_JSON: STORE });
    expect(outcome.exitCode).toBe(0);

    const path = envLine(outcome.stdout, 'BRAINZ_SECRETS_FILE');
    expect(path).toBeDefined();
    expect(await Bun.file(path as string).text()).toBe(STORE);

    // Owner read/write. A secrets file the group can read is not a secrets file.
    expect((statSync(path as string).mode & 0o777).toString(8)).toBe('600');
    discardStore(path as string);
  });

  /**
   * A path supplied by configuration is how a fleet gets pointed at a file baked
   * into an image, so the bootstrap does not accept one. Discouraging this would
   * leave the mistake available; overriding it makes it unavailable.
   */
  test('a path supplied by configuration is overridden, not honoured', async () => {
    const outcome = await runBootstrap({
      BRAINZ_SECRETS_JSON: STORE,
      BRAINZ_SECRETS_FILE: '/app/secrets.json',
    });
    expect(outcome.exitCode).toBe(0);

    const path = envLine(outcome.stdout, 'BRAINZ_SECRETS_FILE') as string;
    expect(path).not.toBe('/app/secrets.json');
    // Never inside the image's own tree, which is the only place a baked file
    // could be.
    expect(path.startsWith('/app')).toBe(false);
    // And the operator is told, rather than left wondering why their volume is
    // being ignored.
    expect(outcome.stderr).toContain('BRAINZ_SECRETS_FILE');
    discardStore(path);
  });

  /**
   * The store is a credential; the started process needs the *file*, never the
   * blob. Leaving it set would put every tenant's connection string in the
   * environ of the process that parses attacker-supplied content, for the life
   * of the instance.
   */
  test('the secret is not left in the started process’s environment', async () => {
    const outcome = await runBootstrap({ BRAINZ_SECRETS_JSON: STORE });
    expect(outcome.exitCode).toBe(0);
    expect(envLine(outcome.stdout, 'BRAINZ_SECRETS_JSON')).toBeUndefined();
    expect(outcome.stdout).not.toContain('providerKeys');
    discardStore(envLine(outcome.stdout, 'BRAINZ_SECRETS_FILE') as string);
  });

  /**
   * `exec`, not a child: the fleet process has to be PID 1's own image so the
   * platform's SIGTERM on scale-to-zero reaches it rather than a shell that
   * ignores it and leaves the container to be killed.
   */
  test('the bootstrap hands the process over rather than wrapping it', async () => {
    const dockerfile = await Bun.file(DOCKERFILE).text();
    expect(bootstrapOf(dockerfile)).toMatch(/\nexec "\$@"\n?$/);

    const outcome = await runBootstrap({ BRAINZ_SECRETS_JSON: STORE }, [
      '/bin/sh',
      '-c',
      'echo handed-over; exec /usr/bin/env',
    ]);
    expect(outcome.stdout).toContain('handed-over');
    discardStore(envLine(outcome.stdout, 'BRAINZ_SECRETS_FILE') as string);
  });
});
