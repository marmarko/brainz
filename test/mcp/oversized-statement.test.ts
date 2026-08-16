/**
 * A statement too expensive to embed is refused before the provider is reached.
 *
 * **The read path's twin, on the write side, and it was the untested half.**
 * `remember` runs one gateway call — `write-path.ts:remember` embeds exactly one
 * text, the statement itself — and until the ceiling landed it ran that call on
 * `capMicroUsd: null`. The estimate is computed from the caller's own bytes, so
 * an uncapped budget on this path is a bill sized by whoever is typing: one tool
 * call carrying a pasted book is one embedding priced at the book.
 *
 * `write.ts:REMEMBER_SPEND_CEILING` closed it, and nothing held it shut. It is a
 * one-line argument to `createBudget`, and every mutation of that line — a
 * `null` cap, a ceiling a thousand times larger — left every test in this suite
 * green, because the suite's writes are all small enough that no ceiling is ever
 * approached. A limit nothing exercises is a comment.
 *
 * **The assertion is on the gateway, not on the tool's answer.** A refusal that
 * arrives *after* the provider ran is not a cap — it is a record of the money
 * with an apology attached — and both look identical from the handler's
 * `unavailable`. So this asserts what the transport was asked to do (nothing)
 * and what the meter recorded for the tenant (nothing), and only then that the
 * caller was told honestly.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { CANONICAL_PRICE_BOOK, costMicroUsd } from '../../src/ai/pricing.ts';
import { HOSTED_PROFILE, routeFor } from '../../src/ai/routing.ts';
import { REMEMBER_SPEND_CEILING } from '../../src/mcp/tools/write.ts';
import { createMcpFixture, type McpFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

/**
 * A statement whose single embedding prices past any honest write.
 *
 * Ordinary prose rather than a pathological string: the shape being defended
 * against is a caller pasting a document into `statement`, which is a thing
 * agents do by accident, not an attacker crafting bytes.
 *
 * **Sentence-terminated on purpose, and it is not a stylistic choice.**
 * `write-path.ts:remember` runs `extract.ts:extractFromStatement` over the whole
 * statement *before* it asks the gateway for anything, and that function is
 * superlinear in run-on text: measured on this suite's runtime, 400 characters
 * with no full stop takes ~10 seconds and 600 takes ~44, independently of how
 * much longer the text gets. That is a separate defect on the same path — a
 * request-path CPU sink a few hundred characters wide — and it is deliberately
 * not what this file tests, so the generator stays on the linear side of it.
 */
function pastedBook(characters: number): string {
  let text = '';
  let index = 0;
  while (text.length < characters) {
    text += `Row ${index} of the ledger reconciles against the batch. `;
    index += 1;
  }
  return text.slice(0, characters);
}

let fixture: McpFixture;

beforeAll(async () => {
  fixture = await createMcpFixture('mcp_bigwrite');
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture?.close();
});

describe('a `remember` too expensive to embed never reaches the provider', () => {
  test(
    'A PASTED BOOK IS A TYPED REFUSAL, NOT AN INVOICE',
    async () => {
      // Sized from the canonical table rather than typed: enough characters
      // that one embedding of them prices past *any* ceiling this handler could
      // reasonably carry, so the test says "the cap fired" rather than "the cap
      // happens to be 6,000 today". The gateway estimates four characters to the
      // token.
      const route = routeFor(HOSTED_PROFILE, 'embedding');
      const price = CANONICAL_PRICE_BOOK.lookup(route.id);
      if (price === undefined) throw new Error(`${route.id} must be priced for this test to mean anything`);
      const statement = pastedBook(700_000);
      const wouldCost = costMicroUsd(
        { inputTokens: Math.ceil(statement.length / 4), outputTokens: 0 },
        price,
      );
      // Asserted against the ceiling itself rather than against a number,
      // because a price change is exactly what would quietly make this input
      // legitimate again and leave the test green having proved nothing — and
      // the embedding seat's price has since fallen by a factor of eleven. Twice
      // the ceiling, so the refusal below cannot be a rounding accident at a
      // boundary; the input grows if the seat ever gets cheap enough to need it.
      expect(wouldCost).toBeGreaterThan(2 * REMEMBER_SPEND_CEILING);

      const before = {
        calls: fixture.gateway.transport.calls.length,
        records: fixture.gateway.meter.records().length,
        spend: fixture.gateway.meter.totalFor(fixture.tenantId),
      };

      const result = await fixture.call('remember', { statement });

      // **Never asked, and never billed.** These two are the cap; everything
      // below is bedside manner. An uncapped budget makes both of them move.
      expect(fixture.gateway.transport.calls.length).toBe(before.calls);
      expect(fixture.gateway.meter.records().length).toBe(before.records);
      expect(fixture.gateway.meter.totalFor(fixture.tenantId)).toBe(before.spend);

      // And the caller is told, in the class that means "this brain could not do
      // it right now" rather than "you asked wrong": the write did not happen
      // and retrying a smaller statement is the remedy.
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('unavailable');

      // Nothing landed. A refusal that half-wrote the page would be worse than
      // the spend it saved.
      const pages = (await fixture.sql`SELECT count(*)::int AS n FROM page`) as Array<{ n: number }>;
      expect(pages[0]?.n).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'an ordinary memory is nowhere near the ceiling and still writes',
    async () => {
      // The half that keeps the ceiling from being satisfied by refusing
      // everything. A ceiling that fires on a real memory is a brain that
      // cannot be written to.
      const before = fixture.gateway.meter.totalFor(fixture.tenantId);

      const result = await fixture.call('remember', {
        statement: 'The calibration jig is out by two millimetres and needs re-running before the next batch.',
      });

      expect(result.ok).toBe(true);
      expect(fixture.gateway.meter.totalFor(fixture.tenantId)).toBeGreaterThan(before);
    },
    TEST_TIMEOUT_MS,
  );
});
