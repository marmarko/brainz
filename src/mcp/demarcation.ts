/**
 * R2a's untrusted-content demarcation.
 *
 * **The threat, stated once so the rules below read as consequences.** A
 * stranger who can email the founder is writing into a store that the founder's
 * assistant reads — and that assistant holds `remember`, `forget` and (behind a
 * nonce) `manage` on the same connection. If mail content reaches the model as
 * undifferentiated server output, the mailbox is an instruction channel into the
 * user's agent. Demarcation is what makes the boundary visible: everything
 * inside the region is *data the brain stored*, never *the brain speaking*, and
 * the server `instructions` say so in as many words.
 *
 * **The rule keys on origin, not on row type.** The obvious implementation asks
 * "is this a chunk from an ingested email?" and it has a hole the size of the
 * consolidation cycle: an entity card, a commitment or a canonical summary chunk
 * derived from that email is a *model-derived* row of a different type, and it
 * carries the attacker's sentences forward. R15 already gives the durable
 * signal — every derived row inherits the **union** of its inputs' origins — so
 * the question this module asks is "does this row's origin union include an
 * origin an outsider can write". One external origin in the union demarcates the
 * whole row.
 *
 * **The classifier fails closed, and that is the load-bearing half.** Origins
 * are `scope:surface` strings minted per credential (`personal:mail`,
 * `work:files`). Deciding externality by listing the *external* surfaces means
 * every connector added after today — and every typo — reads as first-party and
 * is handed to the model unwrapped. So the list here is the **first-party** one,
 * it is short, and everything else is external. `files` is deliberately on the
 * external side: a shared drive document is writable by whoever shared it,
 * which is the same sentence R12a uses to refuse it as corroboration.
 *
 * **The delimiter is unpredictable per response and the payload is escaped
 * against it.** A fixed marker is a string the attacker can print, which ends
 * the region and lets the rest of the body speak as the server. A per-response
 * nonce makes that guess-once-per-request; escaping every occurrence of the
 * nonce out of the payload makes it impossible rather than unlikely. The nonce
 * — not the bracket glyphs — is what the escape targets, because the nonce is
 * the whole of the unforgeability and the marker shape may change.
 */

/**
 * Surfaces the user themselves writes through. Everything else is external.
 *
 *   - `agent`  — a `remember` arriving over `/mcp`. The user typed it at their
 *     assistant. (R12a still refuses to let it *corroborate* anything, which is
 *     a separate question from whether it is quoted as untrusted data.)
 *   - `app`    — the web app (U15).
 *   - `panel`  — an MCP Apps panel action (U14).
 *   - `self`   — brain-internal derivation with no external input in its union.
 */
export const FIRST_PARTY_SURFACES = ['agent', 'app', 'panel', 'self'] as const;

export type FirstPartySurface = (typeof FIRST_PARTY_SURFACES)[number];

const FIRST_PARTY = new Set<string>(FIRST_PARTY_SURFACES);

/**
 * Is this origin one an outside party can write into?
 *
 * Fail-closed: an origin with no surface segment, an unknown surface, or an
 * empty string is external. The only way to be first-party is to say so.
 */
export function isExternalOrigin(origin: string): boolean {
  const surface = surfaceOf(origin);
  if (surface === null) return true;
  return !FIRST_PARTY.has(surface);
}

/**
 * R15's union rule, read for demarcation: one external contributor makes the
 * whole derived row untrusted.
 *
 * An empty union is external for the same reason `fence.ts:fenceRow` refuses
 * one — a row that records no origin is a write-path bug, and the safe reading
 * of a bug is "untrusted", not "ours".
 */
export function isExternalUnion(origins: readonly string[]): boolean {
  if (origins.length === 0) return true;
  return origins.some((origin) => isExternalOrigin(origin));
}

/** The surface segment of a `scope:surface` origin, or `null` if there isn't one. */
function surfaceOf(origin: string): string | null {
  const trimmed = origin.trim().toLowerCase();
  const separator = trimmed.indexOf(':');
  if (separator <= 0) return null;
  const surface = trimmed.slice(separator + 1);
  return surface.length === 0 ? null : surface;
}

/** Bytes for a fresh delimiter. Injected so the escape test can collide with it. */
export type NonceSource = (bytes: number) => Uint8Array;

const DEFAULT_NONCE_SOURCE: NonceSource = (bytes) =>
  crypto.getRandomValues(new Uint8Array(bytes));

/** 128 bits of it. A response carries one; every wrapped row shares it. */
export function mintDelimiter(source: NonceSource = DEFAULT_NONCE_SOURCE): string {
  const bytes = source(16);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function openingMarker(nonce: string): string {
  return `<<<UNTRUSTED-CONTENT ${nonce}>>>`;
}

export function closingMarker(nonce: string): string {
  return `<<</UNTRUSTED-CONTENT ${nonce}>>>`;
}

/** What replaces the nonce where a payload tried to print it. */
export const ESCAPED_NONCE = '[escaped-delimiter]';

/**
 * Wrap a payload as untrusted data.
 *
 * The escape runs first and it targets the *nonce*: with the nonce gone from the
 * body, no arrangement of the surrounding glyphs reconstructs either marker.
 */
export function demarcate(payload: string, nonce: string): string {
  const escaped = nonce.length === 0 ? payload : payload.split(nonce).join(ESCAPED_NONCE);
  return `${openingMarker(nonce)}\n${escaped}\n${closingMarker(nonce)}`;
}

/**
 * The one call site shape every response assembler uses: wrap iff the row's
 * origin union says an outsider could have written it.
 */
export function demarcateIfExternal(
  payload: string,
  origins: readonly string[],
  nonce: string,
): { readonly text: string; readonly untrusted: boolean } {
  if (!isExternalUnion(origins)) return { text: payload, untrusted: false };
  return { text: demarcate(payload, nonce), untrusted: true };
}
