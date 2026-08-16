/**
 * U18 §1 — the `/openai` wire shape, and the one conformance question this unit
 * cannot close.
 *
 * ============================================================================
 * WHAT OPENAI MANDATES (verified 2026-08-15)
 * ============================================================================
 *
 * From `https://developers.openai.com/api/docs/mcp`, for an MCP server ChatGPT
 * connects to:
 *
 *   * `search` returns "an object with a **single key**, `results`, whose value
 *     is an array of result objects", each carrying `id`, `title`, `url`;
 *   * `fetch` returns one object with `id`, `title`, `text`, `url`, and optional
 *     `metadata`;
 *   * both are "returned as `structuredContent`" **and** "the same value as a
 *     JSON-encoded string in the content array";
 *   * *"ChatGPT creates citation metadata only when `url` is a non-empty
 *     string."*
 *
 * The last one is a silent failure — an empty `url` produces an uncited answer
 * and errors nowhere — and it is asserted in `test/mcp/equivalence.test.ts`
 * against the real HTTP server rather than against a handler's return value.
 *
 * ============================================================================
 * THE QUESTION THIS FILE EXISTS FOR, AND WHY IT IS NOT SWITCHED ON
 * ============================================================================
 *
 * `server.ts:toolResult` spreads brainz's response envelope (`degraded`,
 * `notice`, `next`, `setup`, `protocol`) **beside** `results`. The mandate says
 * a single key.
 *
 * Whether ChatGPT ignores the extra keys, tolerates them, or refuses the tool is
 * **not determinable without a live connector against a real ChatGPT account** —
 * which is spend and a deployment. So the honest position, rather than a guess
 * in either direction:
 *
 *   * The **mandated half is pinned now**: the fields, their types, the
 *     non-empty `url`, and `structuredContent` deep-equalling the text lane.
 *   * The **strict projection is written and unit-tested here, and not wired**.
 *     Turning it on is one line at the wire layer.
 *   * Live verification is recorded as **deferred with its reason** in
 *     `docs/plans/2026-08-15-005-u18-…-replan.md` §2.1. Reporting it as passing
 *     would be a fake pass; switching it on without evidence would silently
 *     downgrade the surface, because `degraded` is how a caller learns the index
 *     is cold and `setup` is how a new user learns their brain is empty.
 *
 * Which way the evidence points decides which of those is a bug. Neither is a
 * bug today, and pretending to know which would be.
 */

/** The keys OpenAI's `search` result objects may carry. Order is the sorted order. */
export const OPENAI_SEARCH_RESULT_KEYS = ['id', 'title', 'url'] as const;

/** The keys OpenAI's `fetch` object may carry. `metadata` is optional. */
export const OPENAI_FETCH_KEYS = ['id', 'title', 'text', 'url', 'metadata'] as const;

export interface StrictnessFinding {
  readonly field: string;
  readonly detail: string;
}

/**
 * The payload reduced to exactly what the mandate names, and nothing else.
 *
 * `search` keeps `{results}` and each result keeps its three fields; `fetch`
 * keeps its five. Everything else — the envelope, the counts, the intent, the
 * `untrusted` flag — is dropped.
 *
 * **`untrusted` being dropped is the cost, and it is worth naming.** R2a wraps
 * external content in a demarcation region that survives this projection (it is
 * inside `text` and `title`), so the *protection* is intact; what goes is the
 * machine-readable flag beside it. A client reading the flag rather than the
 * markers would lose it. That is a real trade and it is the reason this is a
 * function to be switched on deliberately rather than a rewrite of the handler.
 */
export function strictOpenAiPayload(
  tool: 'search' | 'fetch',
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (tool === 'search') {
    const results = Array.isArray(payload.results) ? payload.results : [];
    return {
      results: results.map((row) => pick(row as Record<string, unknown>, OPENAI_SEARCH_RESULT_KEYS)),
    };
  }
  return pick(payload, OPENAI_FETCH_KEYS);
}

/**
 * Every way a payload departs from the mandated shape, as sentences.
 *
 * Reported rather than thrown, and reported *all at once*, because the caller
 * for this is a test and a reviewer: one finding at a time turns a conformance
 * check into a game of whack-a-mole against a spec that names four things.
 *
 * The `url` rule is the one worth reading twice: an empty string is not a
 * missing field, it is a **present field that silently costs the citation**, so
 * it is checked as its own finding rather than folded into presence.
 */
export function openAiShapeFindings(
  tool: 'search' | 'fetch',
  payload: Record<string, unknown>,
): StrictnessFinding[] {
  const findings: StrictnessFinding[] = [];

  if (tool === 'search') {
    if (!Array.isArray(payload.results)) {
      findings.push({ field: 'results', detail: 'search must return an array under `results`' });
      return findings;
    }
    for (const [index, raw] of payload.results.entries()) {
      const row = raw as Record<string, unknown>;
      for (const key of OPENAI_SEARCH_RESULT_KEYS) {
        if (row[key] === undefined) {
          findings.push({ field: `results[${index}].${key}`, detail: 'is missing' });
        }
      }
      for (const key of Object.keys(row)) {
        if (!(OPENAI_SEARCH_RESULT_KEYS as readonly string[]).includes(key)) {
          findings.push({
            field: `results[${index}].${key}`,
            detail: 'is not one of the three fields the mandated result object names',
          });
        }
      }
      if (typeof row.url !== 'string' || row.url.length === 0) {
        findings.push({
          field: `results[${index}].url`,
          detail: 'is empty — ChatGPT creates citation metadata only when url is a non-empty string',
        });
      }
      if (typeof row.title !== 'string') {
        findings.push({
          field: `results[${index}].title`,
          detail: 'is not a string — on this shape the title is the whole of what the model sees',
        });
      }
    }
    return findings;
  }

  for (const key of ['id', 'title', 'text', 'url']) {
    if (payload[key] === undefined) findings.push({ field: key, detail: 'is missing' });
  }
  if (typeof payload.url !== 'string' || payload.url.length === 0) {
    findings.push({
      field: 'url',
      detail: 'is empty — ChatGPT creates citation metadata only when url is a non-empty string',
    });
  }
  if (typeof payload.text !== 'string') {
    findings.push({ field: 'text', detail: 'must be the full text of the document as a string' });
  }
  return findings;
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}
