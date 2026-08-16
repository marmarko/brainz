/**
 * A query too big for `websearch_to_tsquery` degrades. It does not take the read
 * with it.
 *
 * ============================================================================
 * WHAT WAS REPRODUCED, AND WHAT WAS NOT
 * ============================================================================
 *
 * **Real:** a ~150KB `query` reaches `arms.ts:ftsArm`'s
 * `websearch_to_tsquery($2::regconfig, $3)` and Postgres raises SQLSTATE
 * `54001` — `stack depth limit exceeded`, `routine: check_stack_depth` — while
 * parsing it. The threshold is not a byte count: it is where the parser's
 * recursion meets `max_stack_depth`, so it moves with the server's
 * configuration and with how many distinct terms the text holds. Measured
 * against the suite's own Postgres 17 it fires from roughly 100KB. Far past it,
 * around 1MB, the failure changes to `54000` — `value is too big in tsquery`,
 * `routine: pushValue_internal` — which is the same event with the parser
 * refusing before the stack does.
 *
 * **Not real: "an uncaught 500".** `dispatch.ts` already wraps every handler
 * call and converts a throw into a typed refusal, and `server.ts` renders that
 * as a JSON-RPC error inside a 200. Nothing 500s and no stack trace reaches the
 * wire. What the caller got was `ok: false, code: 'error'` and the sentence
 * "That call could not be completed."
 *
 * **Which is still wrong, and is what this file fixes.** The read path's
 * contract is degradation, written down in `read.ts` beside
 * `READ_PATH_SPEND_CEILING`: a cap an order of magnitude above the worst
 * legitimate read "still turns a pathological one — a caller feeding a megabyte
 * of 'query' — into a degraded answer rather than an invoice". A megabyte of
 * query did not produce a degraded answer. It produced a whole-read refusal
 * whose message names no cause, on a path where two of three arms could have
 * answered: the vector arm does not touch the query text (it is handed an
 * embedding) and neither does the graph arm (it is handed entity ids).
 *
 * ============================================================================
 * WHY A SQLSTATE AND NOT A LENGTH CAP
 * ============================================================================
 *
 * A cap is a guess at a threshold the database owns. It moves with
 * `max_stack_depth`, with the term distribution of the text, and with the
 * Postgres version; a cap tuned here would refuse queries this server could
 * have answered on one deployment and still throw on another. Catching the two
 * SQLSTATEs catches the actual event, wherever it happens to sit.
 *
 * And **only** those two. A connection reset, a missing column, a permission
 * error and a statement timeout must still throw — an arm that swallowed those
 * would report "your query was too complex" for an outage, which is a worse
 * failure than the one being fixed because it is a plausible-looking lie. The
 * last two tests below are the ones that hold that line.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { ftsArm, isQueryTooComplexError } from '../../src/core/search/arms.ts';
import { longestPhraseRun } from '../../src/core/search/normalize.ts';
import { DEGRADED_REASONS } from '../../src/mcp/envelope.ts';
import { createMcpFixture, seedPage, type McpFixture } from './fixture.ts';

import type { SQL } from 'bun';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

const ORIGIN = 'personal:mail';

/**
 * Big enough to blow the tsquery parser's stack on the suite's Postgres.
 *
 * Deliberately ordinary words rather than a pathological string: the reported
 * case is a caller pasting a document into `query`, not an attacker crafting
 * one.
 */
function oversizedQuery(characters = 150_000): string {
  const words = 'the quarterly review covered hiring runway and the migration schedule'.split(' ');
  let text = '';
  let index = 0;
  while (text.length < characters) {
    text += `${words[index % words.length]} `;
    index += 1;
  }
  return text.slice(0, characters);
}

let fixture: McpFixture;

beforeAll(async () => {
  fixture = await createMcpFixture('mcp_bigquery');
  await seedPage(fixture.sql, {
    id: 'quarterly',
    title: 'The quarterly review',
    sourceType: 'email',
    origin: ORIGIN,
    createdAt: '2026-06-01',
    paragraphs: ['The quarterly review covered hiring, runway and the migration schedule.'],
  });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

// ---------------------------------------------------------------------------
// 0. The event is real, and it is this event.
// ---------------------------------------------------------------------------

describe('the database really does refuse the statement', () => {
  test(
    'websearch_to_tsquery raises 54001 on a query of this size',
    async () => {
      let errno = '';
      let routine = '';
      try {
        await fixture.sql.unsafe(`SELECT websearch_to_tsquery($1::regconfig, $2) AS tsq`, [
          'simple',
          oversizedQuery(),
        ]);
      } catch (error) {
        errno = String((error as { errno?: unknown }).errno ?? '');
        routine = String((error as { routine?: unknown }).routine ?? '');
      }
      // Named rather than "it threw": a test that only asserted a throw would
      // stay green if the failure became a timeout, and the fix below is keyed
      // on the code.
      expect(errno).toBe('54001');
      expect(routine).toBe('check_stack_depth');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 1. The contract: degrade, do not refuse the read.
// ---------------------------------------------------------------------------

describe('an oversized query degrades the text arm and answers anyway', () => {
  test(
    'recall returns results with the reason named, instead of refusing the call',
    async () => {
      const result = await fixture.call('recall', { query: oversizedQuery() });

      // The whole point. Before the fix this was `ok: false, code: 'error'` with
      // "That call could not be completed." — no cause, no partial answer, on a
      // path whose stated contract is to degrade.
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();

      expect(result.envelope.degraded?.reasons ?? []).toContain('query_too_complex');
      expect(result.resultClass).toBe('degraded');

      // The text arm is the one that dropped, and it is the only one this
      // degradation is about.
      const content = result.content as { results: unknown[]; arms_used: string[] };
      expect(content.arms_used).not.toContain('fts');

      // And the read still answers. That is the whole difference between a
      // degradation and a refusal, and it is asserted on the results rather than
      // on which arm produced them.
      expect(content.results.length).toBeGreaterThan(0);

      // **The vector arm survives this query, and it did not always.** At the
      // previous embedding seat's price, 37,000 tokens of "query" cost more than
      // `READ_PATH_SPEND_CEILING` allowed and the read lost that arm too — for a
      // different and equally intended reason. The seat this fleet routes now is
      // eleven times cheaper, so the same query is inside the same margin and
      // keeps its vector arm; the ceiling still refuses the megabyte the
      // constant was written against. Asserted rather than left unstated,
      // because "which arms ran" is the thing a reader of a degraded answer is
      // being told, and it changed.
      expect(result.envelope.degraded?.reasons ?? []).not.toContain('embedding_unavailable');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and it answers in bounded time, which is not what a degradation used to buy',
    async () => {
      // **The other half of this fix, and the half nobody had named.**
      // `boosts.ts` ranks every candidate with `normalize.ts:longestPhraseRun`,
      // whose needle is the *query*. Started at the needle's own length it is
      // O(needle²) array slices — about cubic in what the caller typed: 235ms at
      // 10KB, 1.7s at 20KB, 13s at 40KB, per candidate. Below the tsquery
      // threshold that was already a live CPU sink on the request path; above it,
      // turning the text arm's throw into a degradation walked straight into it
      // and a 150KB query burned minutes of CPU instead of failing fast.
      //
      // **Measured on the function rather than end-to-end, on purpose.** The
      // whole read at 150KB took over eleven minutes of CPU before the bound and
      // never returned; a guard shaped like "the request finished in 15s" would
      // therefore *hang* rather than fail, and a hanging guard tells CI nothing
      // useful. 40,000 characters is the largest size the un-bounded form still
      // completes at — 13s measured — so this assertion goes red in seconds with
      // a clear number rather than timing out.
      const phrase = oversizedQuery(40_000);
      const startedRun = Date.now();
      longestPhraseRun('The quarterly review', phrase);
      const elapsedRun = Date.now() - startedRun;
      expect(`longestPhraseRun under 2s: ${elapsedRun < 2_000} (${elapsedRun}ms)`).toBe(
        `longestPhraseRun under 2s: true (${elapsedRun}ms)`,
      );

      // And the whole read, which is what a caller experiences.
      const started = Date.now();
      const result = await fixture.call('recall', { query: oversizedQuery() });
      expect(result.ok).toBe(true);
      expect(`recall under 15s: ${Date.now() - started < 15_000}`).toBe('recall under 15s: true');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the phrase-run bound changes no ranking, it only stops the search early',
    () => {
      // The cap is `min(needle.length, start + hay.length)`, and `runIndex`
      // refuses any run longer than the haystack as its first act — so every
      // iteration skipped was one that could not have matched. Asserted over the
      // shapes the title boost actually ranks on rather than argued.
      expect(longestPhraseRun('The quarterly review', 'the quarterly review')).toEqual([
        'the',
        'quarterly',
        'review',
      ]);
      // A needle longer than the haystack: the best run is bounded by the title.
      expect(longestPhraseRun('quarterly review', 'notes on the quarterly review of hiring')).toEqual([
        'quarterly',
        'review',
      ]);
      // The run must be contiguous, which is the property the whole stage exists
      // for — a cap that broke it would turn this into a bag-of-words boost.
      expect(longestPhraseRun('quarterly hiring review', 'quarterly review')).toEqual(['quarterly']);
      expect(longestPhraseRun('nothing in common', 'quarterly review')).toEqual([]);
      expect(longestPhraseRun('', 'quarterly review')).toEqual([]);
      expect(longestPhraseRun('quarterly review', '')).toEqual([]);
    },
  );

  test(
    'the detail sentence carries no fragment of the query',
    async () => {
      // This string reaches logs, support tickets and the model's context. The
      // query is the user's own words — a pasted document, in the reported case.
      const result = await fixture.call('recall', { query: oversizedQuery() });
      const detail = result.envelope.degraded?.detail ?? '';
      expect(detail.length).toBeGreaterThan(0);
      expect(detail).not.toContain('quarterly');
      expect(detail.length).toBeLessThan(600);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the /openai projection degrades identically, because it is the same handler',
    async () => {
      const result = await fixture.call('search', { query: oversizedQuery() }, { endpoint: 'openai' });
      expect(result.ok).toBe(true);
      expect(result.envelope.degraded?.reasons ?? []).toContain('query_too_complex');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the reason is a member of the envelope’s closed set',
    () => {
      // `envelopeViolations` refuses a reason outside the set, and a degradation
      // the envelope then dropped would be a silent read failure again.
      expect(DEGRADED_REASONS as readonly string[]).toContain('query_too_complex');
    },
  );

  test(
    'an ordinary query still uses the text arm, so the fix is not a mute button',
    async () => {
      const result = await fixture.call('recall', { query: 'quarterly review migration schedule' });
      expect(result.ok).toBe(true);
      const content = result.content as { arms_used: string[] };
      expect(content.arms_used).toContain('fts');
      expect(result.envelope.degraded?.reasons ?? []).not.toContain('query_too_complex');
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. Only this event. Everything else still throws.
// ---------------------------------------------------------------------------

describe('the caught set is exactly the two statement-complexity codes', () => {
  test('the predicate recognises 54001 and 54000 and nothing else', () => {
    expect(isQueryTooComplexError({ errno: '54001' })).toBe(true);
    expect(isQueryTooComplexError({ errno: '54000' })).toBe(true);

    // The codes an outage wears. Reporting "your query was too complex" for any
    // of these is a plausible-looking lie, which is worse than the refusal this
    // change replaced.
    for (const errno of ['08006', '08003', '57014', '42703', '42501', '53300', '40001']) {
      expect(`${errno}: ${isQueryTooComplexError({ errno })}`).toBe(`${errno}: false`);
    }
    expect(isQueryTooComplexError(new Error('connection reset'))).toBe(false);
    expect(isQueryTooComplexError(null)).toBe(false);
    expect(isQueryTooComplexError(undefined)).toBe(false);
  });

  test('a non-complexity failure inside the text arm still propagates', async () => {
    const exploding = {
      unsafe: async () => {
        throw Object.assign(new Error('terminating connection due to administrator command'), {
          errno: '57P01',
        });
      },
    } as unknown as SQL;

    let raised = '';
    try {
      await ftsArm(exploding, { query: 'anything', grant: [ORIGIN], limit: 10, ftsLanguage: 'simple' });
    } catch (error) {
      raised = error instanceof Error ? error.message : String(error);
    }
    expect(raised).toContain('terminating connection');
  });

  test('and a complexity failure inside the text arm comes back as an empty arm', async () => {
    const tooComplex = {
      unsafe: async () => {
        throw Object.assign(new Error('stack depth limit exceeded'), { errno: '54001' });
      },
    } as unknown as SQL;

    const outcome = await ftsArm(tooComplex, {
      query: 'anything',
      grant: [ORIGIN],
      limit: 10,
      ftsLanguage: 'simple',
    });
    expect(outcome.ranked).toEqual([]);
    expect(outcome.candidates.size).toBe(0);
    expect(outcome.tooComplex).toBe(true);
  });
});
