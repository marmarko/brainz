/**
 * Starting a real fleet process, and waiting for it to actually listen.
 *
 * Not a `*.test.ts` file. It exists because the thing under test in this
 * directory is **the process**, not a handler: every other suite in this repo
 * composes deps in-memory and calls a function, which is exactly the shape that
 * let a fleet image ship whose `CMD` exited zero with an empty stdout and
 * nothing on :8080. A test that constructs `createMcpServer` and asserts on its
 * `fetch` cannot see that; a test that spawns `bun run src/mcp/serve.ts` and
 * sends it an HTTP request cannot miss it.
 *
 * **Readiness is read from the process, not slept for.** Each entrypoint prints
 * one `{"event":"listening",…}` line to stdout after the socket is bound, and
 * this waits for that line. A fixed sleep would be a flake on a slow machine and
 * a false green on a process that printed nothing — which is the failure mode
 * being defended against, so it may not be the harness's failure mode either.
 */

import type { Subprocess } from 'bun';

/** The repo root, derived rather than assumed: `bun test` may run from anywhere. */
export const REPO_ROOT = `${import.meta.dir}/../..`;

export interface ListeningLine {
  readonly event: 'listening';
  readonly service: string;
  readonly port: number;
}

export interface RunningService {
  /** `http://127.0.0.1:<port>`, from the port the process reported binding. */
  readonly url: string;
  readonly service: string;
  readonly pid: number;
  /** Everything the process wrote to stderr, for a failure message worth reading. */
  stderrText(): Promise<string>;
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Repo-relative entrypoint, e.g. `src/mcp/serve.ts`. */
  readonly entry: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Start an entrypoint and resolve once it reports a bound port.
 *
 * `PORT=0` is passed by default so the OS picks the port and two suites can run
 * at once; the process reports back what it got, which is also the only way a
 * caller could know.
 *
 * `--env-file=/dev/null` is load-bearing, not tidiness. Passing an explicit
 * `env` to `Bun.spawn` does NOT give the child that environment and nothing
 * else: Bun reads `.env` again *inside the child*, from `cwd`, and those values
 * land in its `process.env`. So on any machine with a real `.env` — which is
 * every machine where the fleet has actually been configured — every variable
 * an operator set leaks into every fleet test, and a test that asks what happens
 * when a variable is ABSENT is instead told what happens when it is present.
 *
 * That failure is invisible in CI, which has no `.env`, and appears only where
 * the credentials are real. It is therefore exactly backwards: the fail-closed
 * guarantee stops being tested precisely where it matters most. Suppressing the
 * child's own `.env` read is what makes `options.env` mean what it says.
 */
/**
 * The argv every fleet entrypoint is started with.
 *
 * Exported so the suppression above is asserted rather than trusted: it is one
 * flag whose absence changes nothing visible on a machine without a `.env`, so
 * nothing else in the suite would notice it being dropped.
 */
export function spawnArgv(entry: string): readonly string[] {
  return ['bun', 'run', '--env-file=/dev/null', entry];
}

export async function startService(options: StartOptions): Promise<RunningService> {
  const proc = Bun.spawn([...spawnArgv(options.entry)], {
    cwd: REPO_ROOT,
    env: { PATH: process.env['PATH'] ?? '', PORT: '0', ...options.env },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stderrChunks: string[] = [];
  const stderrDone = drain(proc.stderr, stderrChunks);

  const stop = async (): Promise<void> => {
    proc.kill();
    await proc.exited;
    await stderrDone.catch(() => undefined);
  };

  let line: ListeningLine;
  try {
    line = await readListeningLine(proc, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (error) {
    await stop();
    const stderr = stderrChunks.join('');
    throw new Error(
      `${options.entry} never reported a listening port: ` +
        `${error instanceof Error ? error.message : String(error)}\n` +
        `--- exit code: ${String(proc.exitCode)}\n--- stderr ---\n${stderr}`,
    );
  }

  return {
    url: `http://127.0.0.1:${line.port}`,
    service: line.service,
    pid: proc.pid,
    stderrText: async () => {
      await Promise.race([stderrDone, Bun.sleep(50)]);
      return stderrChunks.join('');
    },
    stop,
  };
}

async function drain(stream: ReadableStream<Uint8Array> | undefined, into: string[]): Promise<void> {
  if (stream === undefined) return;
  const decoder = new TextDecoder();
  for await (const chunk of stream) into.push(decoder.decode(chunk, { stream: true }));
}

async function readListeningLine(
  proc: Subprocess<'ignore', 'pipe', 'pipe'>,
  timeoutMs: number,
): Promise<ListeningLine> {
  const stdout = proc.stdout;
  if (stdout === undefined) throw new Error('the process was spawned without a stdout pipe');

  const deadline = Date.now() + timeoutMs;
  const decoder = new TextDecoder();
  let buffered = '';

  const reader = stdout.getReader();
  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out after ${timeoutMs}ms`);

      const next = await Promise.race([
        reader.read(),
        Bun.sleep(remaining).then(() => 'timeout' as const),
      ]);
      if (next === 'timeout') throw new Error(`timed out after ${timeoutMs}ms`);
      if (next.done) throw new Error('the process closed stdout without reporting a port');

      buffered += decoder.decode(next.value, { stream: true });
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const candidate = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        const parsed = parseListening(candidate);
        if (parsed !== null) return parsed;
        newline = buffered.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseListening(line: string): ListeningLine | null {
  if (!line.startsWith('{')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record['event'] !== 'listening') return null;
  const port = record['port'];
  const service = record['service'];
  if (typeof port !== 'number' || typeof service !== 'string') return null;
  return { event: 'listening', service, port };
}

/**
 * A Cloudflare account id that is nobody's.
 *
 * The hosted routing profile — which is the default, and therefore what every
 * spawned fleet process below composes — bills its model calls through
 * `…/accounts/{id}/ai`, and `compose.ts` refuses to start without the id rather
 * than discovering it is missing inside a tenant's first paid cycle. So a test
 * that starts a fleet has to supply one, exactly as a deployment does.
 *
 * A literal fake, never the real value: this repository is public, the real id
 * lives in `BRAINZ_CF_ACCOUNT_ID`, and gitleaks runs on every push. Thirty-two
 * hex characters because that is the shape, and all zeroes because nothing
 * about the shape should tempt anyone to think it is live.
 */
export const FAKE_CF_ACCOUNT_ID = '0'.repeat(32);

/**
 * A sealing key that seals nothing anybody cares about.
 *
 * Thirty-two zero bytes, base64url — the shape
 * `src/control/sealed.ts:importSealingKey` demands, and a value no deployment
 * could ever hold by accident. Same rule as {@link FAKE_CF_ACCOUNT_ID}: this
 * repository is public, the real key lives in `BRAINZ_SECRET_ENCRYPTION_KEY`,
 * and gitleaks runs on every push. A test that generated a random key would be
 * indistinguishable in a diff from one that pasted a live one.
 */
export const FAKE_SEALING_KEY = 'A'.repeat(43);

/**
 * A secrets file in the shape `src/control/secret-file.ts` reads.
 *
 * Written by the test the way an operator or a pool filler writes it, so what
 * the entrypoint reads is a file on disk rather than an object a test handed it.
 */
export interface SecretsFileContent {
  readonly secrets?: Readonly<Record<string, { connectionString: string; bearerGrant: string }>>;
  readonly providerKeys?: Readonly<Record<string, string>>;
}

export async function writeSecretsFile(path: string, content: SecretsFileContent): Promise<void> {
  await Bun.write(path, JSON.stringify({ secrets: {}, providerKeys: {}, ...content }, null, 2));
}
