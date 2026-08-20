/**
 * What a phase has already looked at, and the two freezes that answer.
 *
 * **Freeze one — the cycle that never reaches its later phases.** One page the
 * model will not summarise stopped the synopsis phase, which stopped the cycle,
 * so `contradiction` and `salience_refine` were never reached at all. Rung 21
 * broke that link for the failures a page can be answerable for: the item is
 * skipped, counted, and the phase completes through it.
 *
 * **Freeze two — the work that is paid for twice, or never again.** It is the
 * one the six refuted rounds were about, and it has two faces that look like
 * opposites:
 *
 *   * A cycle that stops leaves its run open, `openRun` adopts it, and a
 *     sibling phase's checkpoint is honoured against that open run forever. One
 *     page drawing a provider 500 called `extract` ONCE across three cycles on a
 *     brain of 5,608 pages.
 *   * A cycle that closes its run on every exit re-pays `extract` every cycle,
 *     and never gets past it to `enrich`, `synopsis`, `contradiction` or
 *     `salience_refine` at all.
 *
 * Both faces have the same cause, which is that four of the six model phases
 * could not say what they had already looked at. Their selectors took the top N
 * by salience or by id with no clause about work already done, so the ONLY thing
 * standing between a second cycle and a second invoice was a checkpoint row —
 * and a checkpoint row is per-run, so keeping it costs reachability and dropping
 * it costs the invoice.
 *
 * A phase that records what it has considered pays neither. This suite is the
 * assertion that both freezes are gone **in one run**: the same three cycles
 * that reach every phase are the three cycles that pay for extraction once.
 *
 * The marker is a VERSION rather than a flag, so re-consideration is possible
 * without a manual reset — section 2 — and it is written whether or not the row
 * produced anything, so the chunk that legitimately states no facts is not
 * offered forever at the top of the salience queue — section 3, which is the
 * design the owner rejected, asserted against.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { runConsolidationCycle } from '../../src/worker/consolidate/cycle.ts';
import {
  CALLER,
  TENANT,
  countRows,
  createGateway,
  createTenantFixture,
  seedEntity,
  seedFact,
  seedPage,
  type TenantFixture,
} from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;

let tenant: TenantFixture;

beforeEach(async () => {
  tenant = await createTenantFixture('considered');
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  await tenant?.close();
}, SETUP_TIMEOUT_MS);

/** The title whose synopsis the provider always answers with something unreadable. */
const UNREADABLE = 'Thread unreadable';

/**
 * A script that considers everything and produces nothing.
 *
 * Every phase answers with a well-formed, empty result — which is the case the
 * marker has to get right and a yields-output rule cannot: the row WAS looked
 * at, the model DID answer, and there is nothing to show for it. A rule keyed on
 * output would offer all of it again next cycle, forever.
 */
const EMPTY_ANSWERS = {
  extract: () => JSON.stringify({ facts: [] }),
  enrich: () => JSON.stringify({ cards: [] }),
  contradiction: () => JSON.stringify({ conflicts: [] }),
  salience: () => JSON.stringify({ scores: [] }),
};

/**
 * Six pages, one of which the model answers about with prose instead of JSON.
 *
 * An HTTP 200 whose body will not parse is the per-item failure rung 21 made
 * survivable: the phase cannot tell a page it can never read from one badly
 * sampled answer, so it counts the refusal against the page and completes. That
 * is what makes this the right poison for freeze one — the phase is *supposed*
 * to get past it, and before rung 21 it did not.
 */
async function seedProbeBrain(good: number): Promise<void> {
  const { sql } = tenant;
  for (let index = 0; index < good; index++) {
    const page = await seedPage(sql, {
      origin: 'personal:mail',
      sourceType: 'email',
      title: `Thread ${index}`,
      body: `Person${index} joined Company${index}. Company${index} is based in City${index}.`,
    });
    await seedFact(sql, {
      statement: `Person${index} joined Company${index}.`,
      origins: ['personal:mail'],
      pageId: page.pageId,
      chunkIds: page.chunkIds,
      confidence: 0.8,
    });
    await seedEntity(sql, { name: `Person${index}`, type: 'person', origins: ['personal:mail'] });
  }

  await seedPage(sql, {
    origin: 'personal:mail',
    sourceType: 'email',
    title: UNREADABLE,
    body: 'PersonX joined CompanyX. CompanyX is based in CityX.',
    // Old, so recency decay sorts it last and the good pages are summarised
    // before it is reached. Its position is not what this suite is about, but a
    // poison page at the top would make "the good pages got summarised"
    // unreachable for reasons that have nothing to do with the marker.
    createdAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
  });
}

function gateway() {
  return createGateway({
    chat: {
      ...EMPTY_ANSWERS,
      synopsis: (request) => {
        if (request.input.kind === 'chat' && request.input.user.includes(UNREADABLE)) {
          // Reachable, billed, and unreadable. Not the page's fault as far as
          // anything here can prove, so it is the page's outcome and never the
          // phase's.
          return 'I could not read that document.';
        }
        return JSON.stringify({ summary: 'A thread about a hire.' });
      },
    },
  });
}

function openRuns(): Promise<number> {
  return countRows(tenant.sql, 'consolidation_run', 'finished_at IS NULL');
}

function summaryPages(): Promise<number> {
  return countRows(tenant.sql, 'page', "external_ref LIKE 'summary:%' AND deleted_at IS NULL");
}

// ---------------------------------------------------------------------------
// 1. The decisive test. Both freezes, one run.
// ---------------------------------------------------------------------------

describe('one unreadable page freezes neither the cycle nor the corpus', () => {
  test(
    'three cycles reach every phase, and pay for the corpus exactly once',
    async () => {
      const GOOD = 5;
      const CYCLES = 3;
      await seedProbeBrain(GOOD);

      // One instant for every cycle. The deterministic salience phase decays a
      // page's score with its age and that score orders the candidate sets, so a
      // moving `now` would reshuffle the queues between cycles and make "what
      // did the second cycle see" unanswerable.
      const now = new Date();
      const { gateway: model, transport } = gateway();

      const stops: string[] = [];
      const reached: string[][] = [];
      const openAfter: number[] = [];

      for (let cycle = 0; cycle < CYCLES; cycle++) {
        const result = await runConsolidationCycle(
          { sql: tenant.sql, gateway: model, tenantId: TENANT, caller: CALLER },
          { trigger: 'time_ceiling', tier: 'paid', now },
        );
        stops.push(result.stopReason);
        reached.push(
          result.phases.filter((phase) => phase.skipped === 'not_reached').map((phase) => phase.phase),
        );
        openAfter.push(await openRuns());
      }

      // **Freeze one.** Nothing stopped, so nothing was left unreached. The
      // unreadable page is skipped inside the synopsis phase and the two phases
      // behind it run on every cycle — which is the whole of what a cycle is
      // for, and what a brain sitting at `phase_failed` never got to do.
      expect(stops).toEqual(Array.from({ length: CYCLES }, () => 'complete'));
      expect(reached).toEqual(Array.from({ length: CYCLES }, () => []));
      expect(openAfter).toEqual(Array.from({ length: CYCLES }, () => 0));

      // **Freeze two.** Every model phase whose work is now durable was paid for
      // on the first cycle and never again: the second and third cycles select
      // nothing, so they do not call the provider at all. This is the assertion
      // that made closing the run affordable — before it, `extract` here reads
      // 3, one invoice per cycle for a corpus that had not changed.
      expect(transport.callsFor('extract').length).toBe(1);
      expect(transport.callsFor('enrich').length).toBe(1);
      expect(transport.callsFor('contradiction').length).toBe(1);
      expect(transport.callsFor('salience').length).toBe(1);

      // And the work the brain is actually for got done. The five good pages are
      // summarised once — `synopsis` was content-durable before any of this —
      // and the sixth costs one call a cycle for as long as it stays unreadable,
      // blaming nobody and retiring nothing.
      expect(await summaryPages()).toBe(GOOD);
      expect(transport.callsFor('synopsis').length).toBe(GOOD + CYCLES);
      expect(await countRows(tenant.sql, 'page', 'consolidation_refusals = 3')).toBe(1);
      expect(await countRows(tenant.sql, 'page', 'quarantined_at IS NOT NULL')).toBe(0);
    },
    SETUP_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 2. The version, which is what makes re-consideration possible at all.
// ---------------------------------------------------------------------------

/**
 * The cost of a durable marker is that a deliberate re-run needs a way in, and
 * the version stamp is it: a row carries the version that considered it, and a
 * selector takes rows whose stamp is absent or older than the one it is running
 * at. Retuning a phase — a new prompt, a new seat — is the case this exists for.
 */
describe('a version bump offers the whole corpus again', () => {
  test(
    'a considered chunk is a candidate once the phase runs at a higher version',
    async () => {
      await seedProbeBrain(2);
      const now = new Date();
      const { gateway: model, transport } = gateway();

      await runConsolidationCycle(
        { sql: tenant.sql, gateway: model, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now },
      );
      expect(transport.callsFor('extract').length).toBe(1);

      // The same corpus, unchanged, at the same version: nothing to consider.
      await runConsolidationCycle(
        { sql: tenant.sql, gateway: model, tenantId: TENANT, caller: CALLER },
        { trigger: 'time_ceiling', tier: 'paid', now },
      );
      expect(transport.callsFor('extract').length).toBe(1);

      // And at a higher one: every chunk is a candidate again, exactly once.
      const bumped = { trigger: 'time_ceiling', tier: 'paid', now, consideration: { extract: 99 } } as const;
      await runConsolidationCycle(
        { sql: tenant.sql, gateway: model, tenantId: TENANT, caller: CALLER },
        bumped,
      );
      expect(transport.callsFor('extract').length).toBe(2);
      await runConsolidationCycle(
        { sql: tenant.sql, gateway: model, tenantId: TENANT, caller: CALLER },
        bumped,
      );
      expect(transport.callsFor('extract').length).toBe(2);
    },
    SETUP_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// 3. The rejected design, asserted against.
// ---------------------------------------------------------------------------

/**
 * **The reason the marker says "looked at" and not "produced something".**
 *
 * A calendar invite, a one-line email, a footer — a chunk can be perfectly
 * readable and state no factual claim at all. Under a rule keyed on output such
 * a chunk is never done, so it stays at the top of the salience-ordered queue
 * and is re-sent every cycle for the life of the brain, and every chunk behind
 * it waits. The batch is pinned by exactly the rows with nothing in them.
 *
 * The assertion is what the SECOND cycle sends: the chunks the first one
 * considered are gone from the prompt whatever they yielded, and the chunk that
 * was queued behind them is in it.
 */
describe('a chunk that states nothing is considered, not re-offered', () => {
  test(
    'the second batch is the rows the first one did not reach',
    async () => {
      const { sql } = tenant;
      // Three pages, one chunk each, seeded newest-first so the deterministic
      // salience phase's recency term orders them 0, 1, 2.
      for (let index = 0; index < 3; index++) {
        await seedPage(sql, {
          origin: 'personal:mail',
          sourceType: 'calendar',
          title: `Invite ${index}`,
          body: `Invite ${index}: a standing sync, no claim stated. Marker ${index}.`,
          createdAt: new Date(Date.now() - index * 24 * 60 * 60 * 1000).toISOString(),
        });
      }

      const now = new Date();
      const { gateway: model, transport } = gateway();
      const options = { trigger: 'time_ceiling', tier: 'paid', now, limit: 2 } as const;

      await runConsolidationCycle(
        { sql, gateway: model, tenantId: TENANT, caller: CALLER },
        options,
      );
      const first = transport.callsFor('extract');
      expect(first.length).toBe(1);
      const firstPrompt = first[0]?.input.kind === 'chat' ? first[0].input.user : '';
      expect(firstPrompt).toContain('Marker 0');
      expect(firstPrompt).toContain('Marker 1');
      expect(firstPrompt).not.toContain('Marker 2');

      await runConsolidationCycle(
        { sql, gateway: model, tenantId: TENANT, caller: CALLER },
        options,
      );
      const second = transport.callsFor('extract');
      expect(second.length).toBe(2);
      const secondPrompt = second[1]?.input.kind === 'chat' ? second[1].input.user : '';
      // The two that stated nothing are done. The one behind them is not, and it
      // is the whole of the second batch.
      expect(secondPrompt).not.toContain('Marker 0');
      expect(secondPrompt).not.toContain('Marker 1');
      expect(secondPrompt).toContain('Marker 2');

      // Nothing was extracted from any of them, and nothing is owed.
      expect(await countRows(sql, 'fact')).toBe(0);
      await runConsolidationCycle(
        { sql, gateway: model, tenantId: TENANT, caller: CALLER },
        options,
      );
      expect(transport.callsFor('extract').length).toBe(2);
    },
    SETUP_TIMEOUT_MS,
  );
});
