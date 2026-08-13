/**
 * Reading the pinned runner's output, and resolving the pinned checkout.
 *
 * **The classifier exists because "exit code 1" means three different things
 * here**, and collapsing them is how a wrapper lies. Assumption 2 predicted the
 * first: gbrain hard-fails on a partial surface, so a non-zero exit with a full
 * report is the *expected* case and the delta is what grades it. The second is a
 * runner that produced no report at all — a crash, a transport refusal — which
 * must never read as "no failures". The third is the one this repo is actually
 * in: the pinned runner's MCP SDK caps at an older protocol version than brainz
 * declares, so its client aborts the handshake before a single case runs. That
 * is a specific, actionable state and it deserves its own name rather than being
 * filed as "the report was unreadable".
 */

import { describe, expect, test } from 'bun:test';

import { classifyRunnerOutput } from '../../evals/conformance/run.ts';
import { GbrainUnresolvable, resolveGbrain, type Spawner } from '../../evals/conformance/gbrain.ts';
import { type GbrainPin } from '../../evals/conformance/pin.ts';

const SHA = 'a'.repeat(40);
const PIN: GbrainPin = {
  repo: 'https://example.com/gbrain.git',
  tag: 'v0.0.0',
  commit: SHA,
  pinned_on: '2026-08-13',
  advanced_by: 'test',
};

const REPORT = {
  protocol_version: 1,
  results: [{ name: 'a', verb: 'recall', status: 'pass', detail: '' }],
  passed: 1,
  failed: 0,
  skipped: 0,
  ok: true,
};

describe('classifyRunnerOutput', () => {
  test('a report on stdout with a non-zero exit is a report, not a failure — Assumption 2', () => {
    const outcome = classifyRunnerOutput({
      stdout: JSON.stringify(REPORT),
      stderr: '',
      exitCode: 1,
    });
    expect(outcome.kind).toBe('report');
  });

  test('a report on stdout with a zero exit is also a report', () => {
    expect(classifyRunnerOutput({ stdout: JSON.stringify(REPORT), stderr: '', exitCode: 0 }).kind).toBe('report');
  });

  test('a refused protocol handshake is its own state, named', () => {
    const outcome = classifyRunnerOutput({
      stdout: '',
      stderr: "Server's protocol version is not supported: 2026-07-28\n",
      exitCode: 1,
    });
    expect(outcome.kind).toBe('handshake_incompatible');
    if (outcome.kind === 'handshake_incompatible') {
      expect(outcome.detail).toContain('2026-07-28');
    }
  });

  test('the handshake state is not reachable when a report was produced', () => {
    // Order matters: a run that graded cases AND printed a version warning is a
    // run whose delta is gradeable, and hiding it behind the blocker would lose
    // the measurement.
    const outcome = classifyRunnerOutput({
      stdout: JSON.stringify(REPORT),
      stderr: "Server's protocol version is not supported: 2026-07-28",
      exitCode: 1,
    });
    expect(outcome.kind).toBe('report');
  });

  test('no report and no recognised blocker is no_report, carrying the evidence', () => {
    const outcome = classifyRunnerOutput({ stdout: 'CONFORMANT\n', stderr: 'ECONNREFUSED', exitCode: 7 });
    expect(outcome.kind).toBe('no_report');
    if (outcome.kind === 'no_report') {
      expect(outcome.detail).toContain('ECONNREFUSED');
      expect(outcome.detail).toContain('7');
    }
  });

  test('an empty stdout and an empty stderr is still no_report, never a pass', () => {
    expect(classifyRunnerOutput({ stdout: '', stderr: '', exitCode: 0 }).kind).toBe('no_report');
  });
});

describe('resolveGbrain refuses anything but the pinned build', () => {
  const gitAt = (head: string): Spawner => (input) => {
    if (input.cmd[1] === 'rev-parse') return { ok: true, stdout: head, stderr: '' };
    if (input.cmd[1] === 'status') return { ok: true, stdout: '', stderr: '' };
    return { ok: false, stdout: '', stderr: `unexpected ${input.cmd.join(' ')}` };
  };

  test('an override at the pinned sha resolves', () => {
    const resolved = resolveGbrain({ pin: PIN, spawner: gitAt(SHA), override: '/tmp/gbrain' });
    expect(resolved.source).toBe('override');
    expect(resolved.dir).toBe('/tmp/gbrain');
  });

  test('an override at a different sha throws — an override is a convenience, not an exemption', () => {
    expect(() => resolveGbrain({ pin: PIN, spawner: gitAt('b'.repeat(40)), override: '/tmp/gbrain' })).toThrow(
      GbrainUnresolvable,
    );
  });

  test('a clone that lands on a moved tag throws rather than certifying against it', () => {
    const spawner: Spawner = (input) => {
      if (input.cmd[1] === 'clone') return { ok: true, stdout: '', stderr: '' };
      if (input.cmd[1] === 'rev-parse') return { ok: true, stdout: 'c'.repeat(40), stderr: '' };
      if (input.cmd[1] === 'status') return { ok: true, stdout: '', stderr: '' };
      return { ok: false, stdout: '', stderr: 'unexpected' };
    };
    expect(() =>
      resolveGbrain({ pin: PIN, spawner, cacheRoot: '/tmp/does-not-exist-brainz-cache' }),
    ).toThrow(/tag has moved/);
  });

  test('a failed clone throws with the reason, and never returns a directory', () => {
    const spawner: Spawner = (input) => {
      if (input.cmd[1] === 'clone') return { ok: false, stdout: '', stderr: 'fatal: could not read from remote' };
      return { ok: false, stdout: '', stderr: 'unexpected' };
    };
    expect(() => resolveGbrain({ pin: PIN, spawner, cacheRoot: '/tmp/does-not-exist-brainz-cache' })).toThrow(
      /could not read from remote/,
    );
  });
});
