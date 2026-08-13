/**
 * The opaque id grammar — one alphabet shared by `recall`, `search`, `fetch`
 * and `forget`.
 *
 * **Why a grammar rather than a bare row id.** Four tables are addressable and a
 * bare integer says nothing about which; a caller that round-trips
 * `search → fetch` would have to know the schema, and a caller that guessed
 * wrong would read someone's chunk when it meant to read a fact. The prefix is
 * also what lets `forget` compute a cascade — retracting a document is a
 * different blast radius from retracting one passage — without asking the caller
 * to say which they meant.
 *
 * **Ids are ours, not the caller's.** They are minted from row ids and parsed
 * back here; nothing else in the surface constructs one, and nothing parses one
 * loosely. A key that is not a bare integer is refused before any query is
 * built — an id from request input reaching a statement is the whole reason
 * `origin_context` fences exist as parameters rather than as interpolation.
 */

export const ID_KINDS = ['fact', 'doc', 'chunk', 'ent'] as const;
export type IdKind = (typeof ID_KINDS)[number];

export interface OpaqueId {
  readonly kind: IdKind;
  /** The row id, as digits. Bound as `$n::bigint`; never interpolated. */
  readonly key: string;
}

const KIND_SET = new Set<string>(ID_KINDS);

export function formatId(kind: IdKind, key: string | number): string {
  return `${kind}:${key}`;
}

/**
 * Parse an id, or `null`.
 *
 * Strict on purpose: `chunk:12 OR 1=1`, `chunk:-1`, `chunk:1.0` and `chunk:`
 * are all `null` rather than "probably fine". The parser is the only place a
 * caller's string becomes something a query will see.
 */
export function parseId(value: unknown): OpaqueId | null {
  if (typeof value !== 'string') return null;
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const kind = value.slice(0, separator);
  const key = value.slice(separator + 1);
  if (!KIND_SET.has(kind)) return null;
  if (!/^[1-9][0-9]{0,18}$/.test(key)) return null;
  return { kind: kind as IdKind, key };
}

/**
 * The stable URL a projection reports for a record.
 *
 * OpenAI's `search` result shape requires a `url` field. There is no public page
 * for a personal brain, so it is a deep link into the user's own web app (U15) —
 * addressable, meaningless to anyone else, and carrying no content.
 */
export function recordUrl(base: string, id: string): string {
  return `${base.replace(/\/$/, '')}/r/${encodeURIComponent(id)}`;
}
