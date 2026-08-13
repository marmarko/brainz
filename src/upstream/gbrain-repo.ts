/**
 * The upstream checkout, read at the pin and never written.
 *
 * Two invariants, both structural rather than remembered.
 *
 * **Reads resolve at the pinned commit, not at the working tree.** The gbrain
 * clone on any given machine is on whatever branch its owner last used — on this
 * one, a local deploy branch with unreleased commits. A watcher that read
 * `CHANGELOG.md` off the filesystem would produce a different delta depending on
 * that, which makes its report unfalsifiable: you could not tell a real upstream
 * release from somebody's checkout moving. Everything here goes through
 * `git show <commit>:<path>` and `git ls-tree <commit>`, so the delta and the
 * guard sweep are functions of `upstream/gbrain.pin` alone.
 *
 * **Nothing here can modify gbrain.** `gbrain is reference-only` is the roadmap's
 * governing constraint on R20, and this is where it stops being a policy: the git
 * wrapper carries an allowlist of read-only subcommands and refuses anything
 * else before spawning. A later caller cannot reach `git fetch`, `git checkout`
 * or `git commit` through this module even by mistake.
 */

const GIT_TIMEOUT_MS = 30_000;

/**
 * Subcommands that cannot mutate a repository, its index, or its working tree.
 *
 * Deliberately short. `fetch` and `remote` are absent because they mutate refs;
 * `log` is absent because `rev-list` covers what is needed and a smaller list is
 * easier to keep true.
 */
export const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'show',
  'ls-tree',
  'cat-file',
  'rev-list',
  'rev-parse',
]);

export interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

/** @throws if the subcommand is not on the read-only allowlist. */
export function runGit(repoPath: string, args: readonly string[]): GitResult {
  const subcommand = args[0];
  if (subcommand === undefined || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    throw new Error(
      `refusing to run \`git ${subcommand ?? '<none>'}\` against the upstream checkout: this accessor is ` +
        `read-only and admits ${[...READ_ONLY_GIT_SUBCOMMANDS].join(', ')} only. gbrain is a reference, ` +
        'not a dependency — nothing in brainz may modify it.',
    );
  }

  const spawned = Bun.spawnSync(['git', '-C', repoPath, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: GIT_TIMEOUT_MS,
  });

  return {
    ok: spawned.exitCode === 0,
    stdout: spawned.stdout.toString(),
    stderr: spawned.stderr.toString(),
  };
}

export interface GbrainCheckout {
  readonly path: string;
  readonly commit: string;
  /** File contents at the pinned commit. @throws if the path does not exist there. */
  readFile(path: string): string;
  /** Entry paths under `dir` at the pinned commit. `''` lists the repo root. */
  listTree(dir: string): string[];
  /** The checkout's current HEAD sha, for the report — never used as a read target. */
  headCommit(): string;
  /**
   * Resolve any ref to a sha. The delta needs a ref NEWER than the pin by
   * definition, so it names one; the report records the sha it resolved to, which
   * is what makes a run reproducible without pretending it read only the pin.
   */
  resolve(ref: string): string;
  /** File contents at an arbitrary ref. Used only for the delta read. */
  readFileAt(ref: string, path: string): string;
  /** How many commits HEAD is ahead of the pin. Input to the pin-advance recommendation. */
  commitsAhead(): number;
}

/**
 * `GBRAIN_CHECKOUT` if set, else a sibling clone. The pin's `repo` field is a
 * clone URL for CI; locally the watcher runs against a checkout that already
 * exists rather than cloning gbrain on every run.
 */
export function defaultCheckoutPath(): string {
  const configured = process.env['GBRAIN_CHECKOUT'];
  if (configured !== undefined && configured.trim().length > 0) return configured;
  return new URL('../../../gbrain', import.meta.url).pathname;
}

export function openCheckout(opts: { path: string; commit: string }): GbrainCheckout {
  const { path, commit } = opts;

  const present = runGit(path, ['cat-file', '-e', `${commit}^{commit}`]);
  if (!present.ok) {
    throw new Error(
      `the gbrain checkout at ${path} does not contain the pinned commit ${commit}. ` +
        'Refusing to read: a sweep or a delta taken against a different build is not evidence about the pin.',
    );
  }

  return {
    path,
    commit,

    readFile(file: string): string {
      const result = runGit(path, ['show', `${commit}:${file}`]);
      if (!result.ok) {
        throw new Error(`gbrain ${commit} has no ${file}: ${result.stderr.trim()}`);
      }
      return result.stdout;
    },

    listTree(dir: string): string[] {
      const spec = dir.length === 0 ? [] : [`${dir.replace(/\/$/, '')}/`];
      const result = runGit(path, ['ls-tree', '--name-only', commit, ...spec]);
      if (!result.ok) return [];
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    },

    headCommit(): string {
      const result = runGit(path, ['rev-parse', 'HEAD']);
      return result.ok ? result.stdout.trim() : 'unknown';
    },

    resolve(ref: string): string {
      const result = runGit(path, ['rev-parse', `${ref}^{commit}`]);
      if (!result.ok) throw new Error(`gbrain checkout at ${path} cannot resolve ${ref}: ${result.stderr.trim()}`);
      return result.stdout.trim();
    },

    readFileAt(ref: string, file: string): string {
      const result = runGit(path, ['show', `${ref}:${file}`]);
      if (!result.ok) throw new Error(`gbrain ${ref} has no ${file}: ${result.stderr.trim()}`);
      return result.stdout;
    },

    commitsAhead(): number {
      const result = runGit(path, ['rev-list', '--count', `${commit}..HEAD`]);
      if (!result.ok) return 0;
      const count = Number.parseInt(result.stdout.trim(), 10);
      return Number.isNaN(count) ? 0 : count;
    },
  };
}
