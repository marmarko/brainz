/**
 * gbrain's CHANGELOG, read as data.
 *
 * The parser is the least interesting half of U19 and the most dangerous, for one
 * reason: **its failure mode and its success mode look identical from outside.**
 * "No new releases since the pin" is the correct answer for a repo that is up to
 * date and the answer a broken regex gives for any repo at all. A weekly job that
 * reports the second while believing the first classifies nothing, forever, and
 * every gate downstream stays green.
 *
 * {@link releasesSince} therefore refuses to report an empty delta from a file it
 * cannot prove it understood. It must find the pinned version's own header. Not
 * finding it is an error with the version in the message, and that single rule
 * covers a truncated file, an upstream reformat, a pin naming a release that was
 * never published, and a regex that stopped matching — all of which would
 * otherwise arrive as "nothing new upstream".
 *
 * Version comparison is numeric per segment, and `0.42.9` vs `0.42.10` is why:
 * string comparison calls the older one newer, so a lexical sort would silently
 * drop a release from the delta rather than fail.
 */

/** One bullet under a release's `### Itemized changes` heading. */
export interface ItemizedChange {
  /** The bullet's text, joined onto one line. */
  readonly text: string;
  /** Upstream repo paths the bullet names, in the order they appear. */
  readonly paths: readonly string[];
}

export interface Release {
  /** `MAJOR.MINOR.PATCH[.MICRO]`, as written in the header. */
  readonly version: string;
  /** The header's ISO day. */
  readonly released_on: string;
  /** The first bold line of the section, stripped of its markers. Empty if absent. */
  readonly headline: string;
  /** Everything between this header and the next one. */
  readonly body: string;
  readonly itemized: readonly ItemizedChange[];
}

const RELEASE_HEADER = /^##\s+\[([0-9]+(?:\.[0-9]+){1,3}(?:-[A-Za-z0-9.]+)?)\]\s+-\s+(\d{4}-\d{2}-\d{2})\s*$/;

/**
 * A repo path inside backticks. Anchored on a known top-level directory rather
 * than "anything with a slash", because release prose is full of `--flag/value`
 * shapes and URLs, and a path list contaminated with those makes the path gate's
 * unmapped-area finding meaningless.
 */
const PATH_IN_TICKS =
  /`((?:src|test|tests|scripts|docs|skills|evals|admin|deploy|bin)\/[A-Za-z0-9_@./-]+|[A-Za-z0-9_.-]+\.(?:ts|tsx|sql|sh|mjs|md|json))`/g;

/** Bare `**headline**` on its own line, which is how every release section opens. */
const HEADLINE = /^\*\*(.+?)\*\*/s;

export function compareVersions(left: string, right: string): number {
  const parse = (value: string): number[] =>
    (value.split('-')[0] ?? '')
      .split('.')
      .map((segment) => Number.parseInt(segment, 10))
      .map((segment) => (Number.isNaN(segment) ? 0 : segment));

  const a = parse(left);
  const b = parse(right);
  const width = Math.max(a.length, b.length, 4);

  for (let index = 0; index < width; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function pathsIn(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(PATH_IN_TICKS)) {
    const path = match[1];
    if (path !== undefined && !found.includes(path)) found.push(path);
  }
  return found;
}

/**
 * Bullets under `### Itemized changes`, up to the next heading.
 *
 * A bullet may wrap over several lines; continuation lines are folded in, because
 * a path that happened to land on line two of a bullet is not a different change.
 */
function parseItemized(body: string): ItemizedChange[] {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => /^###\s+Itemized changes\s*$/.test(line));
  if (start === -1) return [];

  const bullets: string[] = [];
  let current: string | undefined;

  for (const line of lines.slice(start + 1)) {
    if (/^#{2,3}\s/.test(line)) break;
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet?.[1] !== undefined) {
      if (current !== undefined) bullets.push(current);
      current = bullet[1];
      continue;
    }
    if (current === undefined) continue;
    if (line.trim().length === 0) {
      bullets.push(current);
      current = undefined;
      continue;
    }
    current = `${current} ${line.trim()}`;
  }
  if (current !== undefined) bullets.push(current);

  return bullets.map((text) => ({ text, paths: pathsIn(text) }));
}

/** Every release section in the file, in file order (newest first by convention). */
export function parseChangelog(text: string): Release[] {
  const lines = text.split('\n');
  const starts: Array<{ index: number; version: string; released_on: string }> = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = RELEASE_HEADER.exec(lines[index] ?? '');
    if (match?.[1] !== undefined && match[2] !== undefined) {
      starts.push({ index, version: match[1], released_on: match[2] });
    }
  }

  return starts.map((start, position) => {
    const end = starts[position + 1]?.index ?? lines.length;
    const body = lines.slice(start.index + 1, end).join('\n');
    const headline = HEADLINE.exec(body.trim())?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
    return {
      version: start.version,
      released_on: start.released_on,
      headline,
      body,
      itemized: parseItemized(body),
    };
  });
}

/**
 * Releases strictly newer than `pinnedVersion`.
 *
 * @throws if `pinnedVersion` does not appear in the file. That refusal is the
 * point of the function: an empty delta is only ever returned from a changelog
 * the parser demonstrably read.
 */
export function releasesSince(text: string, pinnedVersion: string): Release[] {
  const releases = parseChangelog(text);

  if (releases.length === 0) {
    throw new Error(
      'gbrain CHANGELOG.md parsed to zero releases — the file is empty, truncated, or its ' +
        'header format changed. Refusing to report an empty delta from a file that was not understood.',
    );
  }

  const pinned = releases.find((release) => compareVersions(release.version, pinnedVersion) === 0);
  if (pinned === undefined) {
    throw new Error(
      `the pinned gbrain version ${pinnedVersion} has no \`## [${pinnedVersion}]\` header in the ` +
        `CHANGELOG at that commit (${releases.length} releases parsed, newest ${releases[0]?.version}). ` +
        'Without locating the pin, "no new releases" and "the parser broke" are the same answer.',
    );
  }

  return releases.filter((release) => compareVersions(release.version, pinnedVersion) > 0);
}
