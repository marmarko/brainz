/**
 * What the client said it can do, read from this request and no other.
 *
 * **Why it is per request.** The 2026-07-28 revision removed the
 * `initialize`/`initialized` handshake (SEP-2575) and the session header
 * (SEP-2567). There is no connection to remember anything on, so a client
 * carries its protocol version, identity and capabilities in `_meta` on every
 * request under the `io.modelcontextprotocol/*` keys. That is a gift for a
 * stateless server: the capability that decides how `manage` is gated is
 * present on the very call being gated, rather than on a handshake some other
 * instance saw.
 *
 * **It fails closed, and the direction matters more than the parsing.** Two
 * capabilities are read here, and each one, when present, *widens* what the
 * caller may do — `ui` opens the panel branch, `elicitation` opens the confirm
 * branch. So an unreadable, absent, misspelled or differently-vendored
 * declaration reads as `false`, and the caller lands on the branch that grants
 * least. This is not defensive coding: at the time of writing it is unverified
 * whether Claude sends per-request client capabilities at all
 * (`anthropics/claude-ai-mcp#636`'s own server log still shows `initialize`),
 * so "we could not tell" is the expected state rather than an edge case, and it
 * must resolve to the fallback.
 *
 * **Presence, not truthiness.** MCP declares a capability by *including its
 * key*, with an object of settings that may legally be empty (`"extensions":
 * {"io.modelcontextprotocol/ui": {}}`, `"elicitation": {"form": {}}`). So the
 * test is "is there an object here", never "is it truthy" — an empty settings
 * object is a declaration, and reading it as absence would refuse a conformant
 * client.
 */

/** The MCP Apps extension identifier (SEP-1865, Final 2026-01-26). */
export const UI_EXTENSION = 'io.modelcontextprotocol/ui';

/** Where a 2026-07-28 client puts its capabilities on every request. */
export const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

export interface ClientCapabilities {
  /** The client can render a `ui://` resource in a sandboxed frame. */
  readonly ui: boolean;
  /**
   * The client can answer a mid-call `input_required` (SEP-2322) — which is
   * what elicitation became once there was no stream to push a request down.
   */
  readonly elicitation: boolean;
}

/** What a caller gets when it declared nothing. Every branch it opens is closed. */
export const NO_CLIENT_CAPABILITIES: ClientCapabilities = { ui: false, elicitation: false };

function objectAt(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  const child = (value as Record<string, unknown>)[key];
  if (typeof child !== 'object' || child === null || Array.isArray(child)) return null;
  return child as Record<string, unknown>;
}

/**
 * Read the capabilities out of a request's `_meta`.
 *
 * Takes the whole `_meta` object rather than the capabilities block, so the one
 * place that knows the key name is this module and a caller cannot reach past
 * it to a differently-spelled block.
 */
export function readClientCapabilities(meta: unknown): ClientCapabilities {
  const capabilities = objectAt(meta, CLIENT_CAPABILITIES_META_KEY);
  if (capabilities === null) return NO_CLIENT_CAPABILITIES;

  return {
    ui: objectAt(capabilities.extensions, UI_EXTENSION) !== null,
    elicitation: objectAt(capabilities, 'elicitation') !== null,
  };
}
