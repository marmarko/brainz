/**
 * `bun run conformance` — gbrain's runner against a local brainz server, graded
 * against the published `memory-verbs-v1-partial` delta (U7 approach step 5).
 *
 * The pieces are separate files on purpose, because each has a different failure
 * mode worth testing on its own: `pin.ts` refuses an unverified upstream,
 * `gbrain.ts` fetches or builds exactly the pinned commit, `server.ts` boots the
 * real surface, and `delta.ts` grades the run. This file is the sequence.
 *
 * **A non-zero exit from the runner is the expected case**, not an error path.
 * Assumption 2: "The gbrain conformance runner reports rather than hard-fails on
 * the partial surface. Evidence leans against this … so U7 builds the
 * delta-asserting wrapper unconditionally and treats a hard fail as expected."
 * So the exit code is recorded and ignored; what is read is the report.
 *
 * **`exit code 1` covers three different states and they are not interchangeable:**
 * a graded run that deviates (the delta grades it), a run that produced no
 * report (a refusal — never an empty failure set), and a client that could not
 * complete the MCP handshake at all. {@link classifyRunnerOutput} separates
 * them, because filing the third as "unreadable report" would send the next
 * reader looking for a parsing bug.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  assertDelta,
  parseDelta,
  parseReport,
  renderDelta,
  type PublishedDelta,
} from './delta.ts';
import { installGbrain, loadPin, resolveGbrain, type ResolvedGbrain } from './gbrain.ts';
import { startLocalServer } from './server.ts';

export const DELTA_PATH = 'upstream/memory-verbs-v1-partial.json';

export type RunnerOutcome =
  | { readonly kind: 'report'; readonly report: unknown; readonly exitCode: number }
  | { readonly kind: 'handshake_incompatible'; readonly detail: string; readonly exitCode: number }
  | { readonly kind: 'no_report'; readonly detail: string; readonly exitCode: number };

/**
 * The MCP SDK's refusal, as it appears on the client's stderr.
 *
 * Matched on the message rather than on an exit code because the exit code is 1
 * for every failure the runner has. A message match is brittle against an
 * upstream rewording — and it is pinned to a *pinned* upstream, which is exactly
 * the situation in which a message match is safe: the string cannot change
 * without somebody deliberately advancing `upstream/gbrain.pin`.
 */
const HANDSHAKE_REFUSAL = /protocol version is not supported/i;

export function classifyRunnerOutput(input: {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}): RunnerOutcome {
  // A report first, always. A run that graded cases and also printed a warning
  // is a run whose delta is gradeable, and hiding it behind a blocker would
  // discard the measurement.
  try {
    return { kind: 'report', report: parseReport(input.stdout), exitCode: input.exitCode };
  } catch {
    // fall through to the blocker classification
  }

  const refusal = input.stderr.match(HANDSHAKE_REFUSAL);
  if (refusal !== null) {
    return {
      kind: 'handshake_incompatible',
      exitCode: input.exitCode,
      detail: input.stderr.trim().split('\n').slice(-3).join(' ').trim(),
    };
  }

  return {
    kind: 'no_report',
    exitCode: input.exitCode,
    detail:
      `the runner exited ${input.exitCode} without a JSON report on stdout. ` +
      `stdout: ${input.stdout.trim().slice(-400) || '(empty)'} | stderr: ${input.stderr.trim().slice(-400) || '(empty)'}`,
  };
}

export function loadDelta(): PublishedDelta {
  return parseDelta(readFileSync(fileURLToPath(new URL(`../../${DELTA_PATH}`, import.meta.url)), 'utf8'));
}

export interface ConformanceRunOptions {
  /** Skip the `bun install` step when the checkout is known to be ready. */
  readonly skipInstall?: boolean;
}

/**
 * Run the pinned runner against a fresh local server and return its output.
 *
 * Nothing here interprets the result; `main` does. Separated so the orchestration
 * can be exercised by hand (`bun run evals/conformance/run.ts --raw`) when the
 * question is "what does upstream actually say" rather than "does the delta hold".
 */
export async function runConformanceRunner(
  resolved: ResolvedGbrain,
): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number; readonly target: string }> {
  const server = await startLocalServer({ slug: 'conformance' });
  try {
    const proc = Bun.spawn({
      cmd: [
        'bun',
        'run',
        'src/cli.ts',
        'protocol',
        'conformance',
        '--target',
        server.url,
        '--token',
        server.token,
        '--json',
      ],
      cwd: resolved.dir,
      stdout: 'pipe',
      stderr: 'pipe',
      // A throwaway home so the runner's own brain, config and usage log never
      // touch the operator's `~/.gbrain`. It is a reference implementation being
      // run as a subprocess, not an installation.
      env: { ...process.env, GBRAIN_HOME: `${resolved.dir}/.conformance-home` },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, target: server.url };
  } finally {
    await server.close();
  }
}

/**
 * `--probe`: gbrain's case set against brainz, with a brainz-supplied transport.
 *
 * **This is not a certification and it never exits 0.** The certification path
 * is `main` above: gbrain's own CLI, gbrain's own MCP client, gbrain's own
 * transport. That path is blocked today by a protocol-version floor in the
 * pinned SDK, and a blocked gate that reports nothing at all would leave the
 * next reader to rediscover the entire delta by hand.
 *
 * So this mode imports `runConformance` from the *pinned checkout* — gbrain's
 * real cases, real fixtures and real response schemas — and drives it through a
 * plain JSON-RPC adapter written here, which never negotiates a protocol
 * version because `ConformanceClient` is only `listTools` + `callTool`. What is
 * borrowed is upstream's definition of correct; what is substituted is the
 * transport. That substitution is exactly why the output is a probe: it says
 * what the delta *would* be, and only a run through upstream's own client can
 * say what it *is*.
 *
 * The distinction is not pedantry. A transport is where session handling,
 * content-type negotiation and error mapping live, and a wrapper that quietly
 * swapped it while still calling the result "conformance" would be publishing a
 * verdict about code it did not run.
 */
async function probe(resolved: ResolvedGbrain, out: (line: string) => void): Promise<number> {
  const module = (await import(`${resolved.dir}/src/core/verbs/conformance.ts`)) as {
    runConformance: (client: unknown, opts: Record<string, unknown>) => Promise<unknown>;
  };

  const server = await startLocalServer({ slug: 'conformanceprobe' });
  try {
    let id = 0;
    const rpc = async (method: string, params: unknown): Promise<Record<string, unknown>> => {
      const response = await fetch(server.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: (id += 1), method, params }),
      });
      return (await response.json()) as Record<string, unknown>;
    };

    const client = {
      async listTools() {
        const body = await rpc('tools/list', {});
        const result = body['result'] as { tools?: Array<Record<string, unknown>> } | undefined;
        return (result?.tools ?? []).map((tool) => ({
          name: tool['name'] as string,
          description: tool['description'] as string | undefined,
          annotations: tool['annotations'],
        }));
      },
      async callTool(name: string, args: Record<string, unknown>) {
        const body = await rpc('tools/call', { name, arguments: args });
        const result = (body['result'] ?? {}) as { isError?: boolean; content?: Array<{ text?: string }> };
        const text = (result.content ?? []).map((part) => (typeof part.text === 'string' ? part.text : '')).join('\n');
        return { isError: result.isError, text };
      },
    };

    const report = await module.runConformance(client, {});
    const parsed = parseReport(JSON.stringify(report));

    out('');
    out('PROBE — NOT A CERTIFICATION. gbrain\'s cases and schemas, brainz\'s transport.');
    out(`  ${parsed.passed} pass, ${parsed.failed} fail, ${parsed.skipped} skip`);
    for (const row of parsed.results) {
      if (row.status === 'pass') continue;
      out(`  ${row.status.padEnd(4)} ${row.verb.padEnd(11)} ${row.name}`);
      if (row.detail.trim().length > 0) out(`         ${row.detail.slice(0, 220)}`);
    }
    out('');
    out(`Certification stays blocked; see ${DELTA_PATH}. This mode always exits non-zero so it`);
    out('cannot be wired as a green gate in place of the real one.');
    return 1;
  } finally {
    await server.close();
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  const raw = argv.includes('--raw');
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  const pin = loadPin();
  const delta = loadDelta();

  out(`conformance: gbrain ${pin.tag} (${pin.commit.slice(0, 12)}) vs brainz ${DELTA_PATH}`);

  let resolved: ResolvedGbrain;
  try {
    resolved = resolveGbrain({ pin });
    if (argv.includes('--skip-install') !== true) installGbrain(resolved);
  } catch (error) {
    out(`  [gbrain_unresolvable] ${error instanceof Error ? error.message : String(error)}`);
    out('conformance: NOT RUN — the pinned runner could not be resolved, so nothing was certified.');
    return 1;
  }
  out(`  runner: ${resolved.dir} (${resolved.source})`);

  if (argv.includes('--probe')) return probe(resolved, out);

  const run = await runConformanceRunner(resolved);
  if (raw) {
    out(run.stdout);
    process.stderr.write(run.stderr);
  }

  const outcome = classifyRunnerOutput(run);

  if (outcome.kind !== 'report') {
    out(`  target: ${run.target}`);
    out(`  [${outcome.kind}] ${outcome.detail}`);
    if (delta.status === 'blocked' && delta.blocker?.kind === outcome.kind) {
      // The published delta already records this blocker, so the run is not a
      // surprise — but it is still not a certification, and the command still
      // exits non-zero. A gate that goes green on a documented inability to run
      // is the failure this whole wrapper is built against.
      out(`conformance: BLOCKED as published — ${delta.blocker.detail}`);
      return 1;
    }
    out('conformance: NOT CERTIFIED — the runner produced no gradeable report.');
    return 1;
  }

  const result = assertDelta(outcome.report, delta, { gbrainCommit: pin.commit });
  out(renderDelta(result, delta));
  return result.passed ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
