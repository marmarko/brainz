/**
 * Fetching or building the pinned gbrain, and refusing anything else.
 *
 * U7 step 5: the runner is "fetched or built by the wrapper". Three resolution
 * modes, in this order:
 *
 *   1. `BRAINZ_GBRAIN_REPO` — an explicit checkout. Verified against the pin
 *      like every other mode; an override is a convenience, not an exemption.
 *   2. The cache at `BRAINZ_GBRAIN_CACHE` (default `~/.cache/brainz-gbrain/<sha>`),
 *      if a previous run already put the pinned commit there.
 *   3. A shallow clone of the pinned repo at the pinned tag.
 *
 * **The cache lives outside the repository** — a build artifact of a different
 * project inside a public repo is a `.gitignore` entry waiting to be forgotten,
 * and gbrain's tree is large enough that forgetting it would be loud.
 *
 * **gbrain is a reference, never a dependency.** It is not in `package.json`, it
 * is not vendored, and nothing in `src/` imports it. It is fetched at a pinned
 * sha, run as a subprocess, and thrown away — which is the whole point of the
 * extract/watch/re-implement discipline in R20.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parsePin, verifyCheckout, type GbrainPin, type GitResult } from './pin.ts';

export const DEFAULT_CACHE_ROOT = `${process.env['HOME'] ?? '/tmp'}/.cache/brainz-gbrain`;

export interface ResolvedGbrain {
  readonly dir: string;
  readonly pin: GbrainPin;
  /** How the checkout got here, for the run's own output. */
  readonly source: 'override' | 'cache' | 'clone';
}

export type Spawner = (input: {
  readonly cmd: readonly string[];
  readonly cwd: string;
  readonly timeoutMs?: number;
}) => { readonly ok: boolean; readonly stdout: string; readonly stderr: string };

/** The default spawner: synchronous, inherits nothing, captures both streams. */
export const spawnSync: Spawner = ({ cmd, cwd }) => {
  const proc = Bun.spawnSync({ cmd: [...cmd], cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    ok: proc.exitCode === 0,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
};

export function loadPin(): GbrainPin {
  return parsePin(readFileSync(fileURLToPath(new URL('../../upstream/gbrain.pin', import.meta.url)), 'utf8'));
}

export class GbrainUnresolvable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GbrainUnresolvable';
  }
}

function gitIn(dir: string, spawner: Spawner) {
  return (args: readonly string[]): GitResult => {
    const result = spawner({ cmd: ['git', ...args], cwd: dir });
    return { ok: result.ok, stdout: result.ok ? result.stdout : `${result.stdout}${result.stderr}` };
  };
}

/**
 * Resolve a checkout of the pinned gbrain, or throw.
 *
 * There is no degraded mode. A conformance verdict produced against an
 * unverified upstream is worse than no verdict, because it looks like evidence —
 * so every path out of this function either returns the pinned commit or throws
 * a `GbrainUnresolvable` naming what went wrong.
 */
export function resolveGbrain(options: {
  readonly pin: GbrainPin;
  readonly spawner?: Spawner;
  readonly cacheRoot?: string;
  readonly override?: string | undefined;
}): ResolvedGbrain {
  const spawner = options.spawner ?? spawnSync;
  const cacheRoot = options.cacheRoot ?? process.env['BRAINZ_GBRAIN_CACHE'] ?? DEFAULT_CACHE_ROOT;
  const override = options.override ?? process.env['BRAINZ_GBRAIN_REPO'];

  if (override !== undefined && override.trim().length > 0) {
    const verdict = verifyCheckout({ dir: override, pin: options.pin, git: gitIn(override, spawner) });
    if (!verdict.verified) {
      throw new GbrainUnresolvable(
        `BRAINZ_GBRAIN_REPO=${override} is not the pinned build: ` +
          verdict.violations.map((v) => `[${v.kind}] ${v.detail}`).join('; '),
      );
    }
    return { dir: override, pin: options.pin, source: 'override' };
  }

  const dir = `${cacheRoot}/${options.pin.commit}`;
  if (existsSync(`${dir}/.git`)) {
    const verdict = verifyCheckout({ dir, pin: options.pin, git: gitIn(dir, spawner) });
    if (verdict.verified) return { dir, pin: options.pin, source: 'cache' };
    // A cache entry keyed by sha that is not at that sha has been tampered with
    // or half-written. Refuse rather than re-cloning over it silently.
    throw new GbrainUnresolvable(
      `the cached checkout at ${dir} is not the pinned build: ` +
        verdict.violations.map((v) => `[${v.kind}] ${v.detail}`).join('; ') +
        '; remove the directory and re-run',
    );
  }

  const clone = spawner({
    cmd: ['git', 'clone', '--quiet', '--depth', '1', '--branch', options.pin.tag, options.pin.repo, dir],
    cwd: cacheRoot.startsWith('/') ? '/' : '.',
  });
  if (!clone.ok) {
    throw new GbrainUnresolvable(
      `could not clone ${options.pin.repo} at ${options.pin.tag} into ${dir}: ${clone.stderr.trim() || clone.stdout.trim()}`,
    );
  }

  const verdict = verifyCheckout({ dir, pin: options.pin, git: gitIn(dir, spawner) });
  if (!verdict.verified) {
    throw new GbrainUnresolvable(
      `the freshly cloned ${options.pin.tag} is not ${options.pin.commit} — the tag has moved upstream: ` +
        verdict.violations.map((v) => `[${v.kind}] ${v.detail}`).join('; '),
    );
  }
  return { dir, pin: options.pin, source: 'clone' };
}

/** Install the runner's own dependencies. gbrain ships a lockfile; it is honoured. */
export function installGbrain(resolved: ResolvedGbrain, spawner: Spawner = spawnSync): void {
  const result = spawner({ cmd: ['bun', 'install', '--frozen-lockfile'], cwd: resolved.dir });
  if (!result.ok) {
    throw new GbrainUnresolvable(
      `could not install the pinned gbrain's dependencies in ${resolved.dir}: ${result.stderr.trim().slice(-800)}`,
    );
  }
}
