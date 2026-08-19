/**
 * What a thin brain says about itself, on the real request path.
 *
 * **The failure this suite exists to close.** A brain with a large corpus and
 * almost no facts answered every `recall` as a clean success over raw passages.
 * Nothing in the closed reason set described it — `no_content_yet` was false,
 * `embedding_backlog` was false, every arm ran — so `degraded` was omitted,
 * `resultClass` stayed `ok`, and the user concluded the product was weak rather
 * than that the index was behind. The mechanism to say so had been built and was
 * populated in one place.
 *
 * **This is written as a ladder, and the order is the point.** One fixture,
 * climbed one rung per test: nothing connected, connected but never told
 * anything, healthy, and then behind. Each rung is a state a real brain passes
 * through, and the assertion at each is as much about what the envelope does
 * NOT say as about what it does. A per-test fixture would cost four database
 * provisions to assert the same four states in isolation, and would lose the
 * property the ladder is really testing: that the surface goes quiet again when
 * the state that made it speak is gone.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { CONSOLIDATION_CORPUS_FLOOR } from '../../src/mcp/envelope.ts';
import { ladderVector, SEAT_COLUMN } from '../core/search/fixture.ts';
import { AGENT_ORIGIN, createMcpFixture, seedFact, type McpFixture } from './fixture.ts';

const SETUP_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

/** Where the fixture's imported material claims to have come from. */
const MAIL_ORIGIN = 'personal:mail';

/**
 * Comfortably over the floor, so the ratio has an opinion at every rung.
 *
 * A corpus at or under {@link CONSOLIDATION_CORPUS_FLOOR} is silent by
 * construction, which would make the behind-case assertion below pass for the
 * wrong reason and the healthy-case assertion prove nothing.
 */
const CORPUS_PAGES = CONSOLIDATION_CORPUS_FLOOR + 10;

let fixture: McpFixture;

beforeAll(async () => {
  fixture = await createMcpFixture('mcp_thin_brain');
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await fixture.close();
});

/**
 * A corpus, written the way a connector writes one: pages with embedded chunks.
 *
 * Bulk rather than through `seedPage` because the count has to clear the
 * consolidation floor and the assertions are about counters, not about content.
 * The chunks carry a vector in the **active seat's** column for the same reason
 * `indexState` counts that column and not the literal `embedding` — a chunk
 * seeded into a column the arm does not scan is a chunk the backlog counter
 * reports as pending, and the brain would be degraded for the wrong reason.
 */
async function seedCorpus(pages: number): Promise<void> {
  await fixture.sql.unsafe(
    `WITH seeded AS (
       INSERT INTO page (origin_context, source_type, title, created_at, embedding_model,
                         embedding_dimensions, chunker_version, normalizer_version, content_sha256)
       SELECT $1, 'email', 'An imported document ' || g, '2026-05-01'::timestamptz, 'fixture-model',
              $2::int, 1, 1, repeat('0', 64)
         FROM generate_series(1, $3::int) AS g
       RETURNING page_id
     )
     INSERT INTO chunk (origin_context, content, page_id, ordinal, ${SEAT_COLUMN})
     SELECT $1, 'An imported passage about the quarterly review.', page_id, 0, $4::vector
       FROM seeded`,
    [MAIL_ORIGIN, 1536, pages, ladderVector(0.5)],
  );
}

/** One completed ingestion run: the evidence that a source is connected. */
async function seedIngestRun(): Promise<void> {
  await fixture.sql.unsafe(
    `INSERT INTO ingest_log (origin_context, source_type, outcome, items_seen, items_written, finished_at)
     VALUES ($1, 'email', 'ok', $2::int, $2::int, now())`,
    [MAIL_ORIGIN, CORPUS_PAGES],
  );
}

interface Envelope {
  readonly degraded?: { readonly reasons: readonly string[]; readonly detail: string };
  readonly notice?: readonly string[];
  readonly setup?: { readonly kind: string; readonly detail: string; readonly url?: string };
}

async function recall(): Promise<Envelope> {
  const result = await fixture.call('recall', { query: 'the quarterly review' });
  expect(result.ok).toBe(true);
  return result.envelope as Envelope;
}

describe('rung 1 — nothing connected, nothing stored', () => {
  test(
    'names connecting a source, and gives the user somewhere to do it',
    async () => {
      const envelope = await recall();

      expect(envelope.setup?.kind).toBe('connect_source');
      expect(envelope.setup?.url).toBeDefined();

      // The empty brain is a `setup` state, not a `notice` state. `degraded`
      // still carries the machine-readable half; the sentence a person needs
      // here names an action, and saying it in both lanes is one piece of news
      // told twice in one response.
      expect(envelope.degraded?.reasons).toContain('no_content_yet');
      expect(envelope.notice).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('rung 2 — a source has delivered, the user never has', () => {
  test(
    'asks for the capture habit, and says nothing about the index',
    async () => {
      await seedCorpus(CORPUS_PAGES);
      await seedIngestRun();
      // Enough facts to keep pace with the corpus, so the only thing missing at
      // this rung is the half of the loop the user drives.
      for (let n = 0; n < CORPUS_PAGES / 5; n += 1) {
        await seedFact(fixture.sql, {
          statement: `An extracted claim about the review, number ${n}.`,
          origins: [MAIL_ORIGIN],
          chunkIds: [],
        });
      }

      const envelope = await recall();

      expect(envelope.setup?.kind).toBe('first_memory');
      // Indexed, embedded, and keeping pace: there is nothing wrong with this
      // read, so it is not degraded and it does not editorialise.
      expect(envelope.degraded).toBeUndefined();
      expect(envelope.notice).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('rung 3 — healthy', () => {
  /**
   * THE ASSERTION THAT STOPS THIS BECOMING A NAG, on the real request path.
   *
   * Every ingredient here is load-bearing and each one is a way this could fail
   * for a reason that looks like a bug: the chunks are embedded (or the backlog
   * reason fires), the ingestion run finished (or the import reason fires), the
   * facts keep pace with the corpus (or the consolidation reason fires), and one
   * fact carries the agent's own write origin (or the capture rung fires). A
   * healthy brain that says anything at all is a brain the user turns off.
   */
  test(
    'A HEALTHY BRAIN RETURNS NEITHER A NOTICE NOR A SETUP HINT',
    async () => {
      await seedFact(fixture.sql, {
        statement: 'The user prefers written updates to meetings.',
        origins: [AGENT_ORIGIN],
        chunkIds: [],
      });

      const envelope = await recall();

      expect(envelope.notice).toBeUndefined();
      expect(envelope.setup).toBeUndefined();
      expect(envelope.degraded).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );
});

describe('rung 4 — the corpus is there and the facts are not', () => {
  test(
    'says so in words, once, and still asks the user for nothing',
    async () => {
      // Consolidation frozen, stated as the state it produces: the documents
      // stay, the layer built from them goes. The agent's own memory survives,
      // which is what keeps this rung about the index rather than about capture.
      await fixture.sql.unsafe(
        `UPDATE fact SET deleted_at = now()
          WHERE deleted_at IS NULL AND NOT ($1 = ANY(origin_contexts))`,
        [AGENT_ORIGIN],
      );

      const result = await fixture.call('recall', { query: 'the quarterly review' });
      expect(result.ok).toBe(true);
      const envelope = result.envelope as Envelope;

      expect(envelope.degraded?.reasons).toContain('consolidation_behind');
      // The machine-readable half is not enough on its own: `degraded` is a code
      // the model may or may not narrate, and this is the lane the server
      // instructions tell it to relay.
      expect(envelope.notice).toHaveLength(1);
      expect(envelope.notice?.[0]).toMatch(/consolidat/i);

      // A read this thin is not an `ok` read, and the access log is where that
      // distinction becomes visible over a fleet.
      expect(result.resultClass).toBe('degraded');

      // There is nothing the user can connect or capture to fix this, so the
      // slot that would ask them to stays empty.
      expect(envelope.setup).toBeUndefined();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and the briefing says it too — which the ever-completed flag alone could not',
    async () => {
      // A cycle that completed and dreamt, once. This is the state the old
      // signal could not see past: `consolidation_pending` asks whether the
      // model tier has EVER completed, so one finished run months ago answers
      // "materialized" forever and the bundle reports itself whole over a layer
      // that stopped being built. `paid` because the free tier's own bounded
      // upgrade prompt is the sentence written for a cold layer, and this test
      // is about the other state.
      await fixture.sql.unsafe(
        `INSERT INTO consolidation_run (trigger_reason, tier, dreamt, finished_at, wall_clock_ms)
         VALUES ('time_ceiling', 'paid', true, now() - interval '90 days', 1000)`,
        [],
      );

      const result = await fixture.call('briefing', {});
      expect(result.ok).toBe(true);
      const envelope = result.envelope as Envelope;
      const content = result.content as { coverage: string };

      // The bundle believes it is whole…
      expect(content.coverage).toBe('materialized');
      expect(envelope.degraded?.reasons).not.toContain('consolidation_pending');
      // …and the read still says, in words, that the layer is behind the corpus.
      expect(envelope.degraded?.reasons).toContain('consolidation_behind');
      expect(envelope.notice?.some((line) => /consolidat/i.test(line))).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
