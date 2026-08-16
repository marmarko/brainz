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
 */
export async function startService(options: StartOptions): Promise<RunningService> {
  const proc = Bun.spawn(['bun', 'run', options.entry], {
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
