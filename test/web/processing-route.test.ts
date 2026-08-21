/**
 * The page that says WHICH step is behind, and whether it failed or never ran.
 *
 * ============================================================================
 * WHAT WAS MISSING, AND WHY IT IS A SECOND PAGE
 * ============================================================================
 *
 * `?view=coverage` answers *what came in and what the brain made of it*, and it
 * is the right page for "is my brain working". It cannot answer the question
 * that costs the most time when the answer is no. A brain sat at 8,584 pages and
 * 205 facts while every clock in the system read healthy: `synopsis` used the
 * whole of every attempt's model half, so `contradiction` and `salience_refine`
 * were recorded `not_reached` on every cycle and never ran at all; and `extract`
 * was sending a batch its seat's output ceiling could not answer, so the reply
 * was truncated and the phase marked nothing. Coverage showed a fact count that
 * would not move. The diagnosis was made by a human reading SQL.
 *
 * ============================================================================
 * WHAT THESE TESTS ARE FOR, AND WHAT THEY DELIBERATELY ARE NOT
 * ============================================================================
 *
 * The render assertions here are about **claims**, not about layout. Nearly
 * every one of them pins a sentence this page is forbidden from saying, because
 * every one of those sentences was reachable from a plausible implementation:
 *
 *   * a `not_reached` line that names a DETERMINISTIC phase — `cluster` is a
 *     routine `stopped_phase` at this corpus size, and telling an owner they are
 *     behind on work that produces nothing they can see is worse than silence;
 *   * a bare "ran 10 of its 12 steps" with no cause, which on a healthy brain is
 *     a shortfall report for the free half yielding its share on schedule;
 *   * "nothing after it ran" under `phase_failed`, which has been false since
 *     the cycle began continuing past a durable phase failure;
 *   * the reassuring pacing note rendered directly under the line saying that
 *     same step never got a turn;
 *   * "unreadable", for a counter that also increments when a prompt or a seat
 *     is the problem and which cannot tell those apart.
 *
 * **Two halves, and the second is where the counts are actually proved.** Every
 * waiting count is a predicate mirroring a phase's own selector, and a fake
 * would be asserting its own arithmetic — so the composition half drives the
 * REAL `readProcessing` against a REAL schema, the way `coverage-route.test.ts`
 * does. Each case there is a row shape that a plausible wrong predicate counts
 * and the right one does not:
 *
 *   * a `model_derived` summary page **with a live chunk against it** — the
 *     exact shape `writeCanonicalSummary` writes — is in NO counter. Counting it
 *     makes `extract`'s meter unreachable, because that chunk is never a
 *     candidate and the denominator grows every time `synopsis` succeeds.
 *   * an ingested page with **no live chunk** is in neither page counter:
 *     `selectIngestedPages` joins `chunk`, so such a page is never offered.
 *   * a page with **two** summaries standing — the historical duplicate, which
 *     nothing retires — is counted once, not twice and not negatively.
 *   * an attachment with `ocr_text = ''` is DONE, not waiting: the empty string
 *     is the done state, and `IS NULL` is the predicate.
 *   * a row stamped at the CURRENT consideration version is absent; the same row
 *     one version behind is present. A bare `IS NULL` passes the first and fails
 *     the second, and would report a converged brain on the day of a bump.
 *   * a refused page that now HAS a summary, and one that has gone stale, are in
 *     neither `refusedWaiting` nor `mostRefusals` — because the copy invites the
 *     reader to compare that number against the synopsis count, and a refusal
 *     count over a different row set than the waiting count makes that a lie.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { ACTIVE_EMBEDDING_SEAT } from '../../src/schema/embedding-seat.ts';
import { EMBEDDING_DIMENSIONS } from '../../src/schema/vector-index.ts';
import { CONSIDERATION_VERSION } from '../../src/worker/consolidate/consideration.ts';
import { SUMMARY_REF_PREFIX } from '../../src/worker/consolidate/materialize.ts';
import {
  connect as connectTenant,
  dropFixtureDatabase,
  provisionFixture,
  type SchemaFixture,
} from '../schema/fixture.ts';

import { CYCLE_PHASE_NAMES } from '../../src/web/coverage.ts';
import { PROCESSING_PATH, renderPage } from '../../src/web/pages.ts';
import {
  PROCESSING_PHASES,
  readProcessing,
  standingOf,
  type ProcessingCycle,
  type ProcessingPhase,
  type ProcessingView,
} from '../../src/web/processing.ts';
// A test may import worker vocabulary; a page render may not. The ban in
// `coverage.ts` is about what a page load pulls into its module graph.
import { CYCLE_PHASES, MODEL_PHASES } from '../../src/worker/consolidate/phases.ts';

const AT = '2026-08-20T22:00:00.000Z';

function cycle(over: Partial<ProcessingCycle> = {}): ProcessingCycle {
  return {
    tier: 'paid',
    dreamt: false,
    stopReason: 'out_of_time',
    stoppedPhase: 'synopsis',
    stoppedPhaseCode: 'out_of_time',
    startedAt: AT,
    finishedAt: AT,
    phasesRun: 10,
    phasesPlanned: 12,
    modelCalls: 47,
    spentMicroUsd: 110_000,
    ...over,
  };
}

function view(over: Partial<ProcessingView> = {}): ProcessingView {
  const latest = over.latestCycle === undefined ? cycle() : over.latestCycle;
  const waiting: Record<ProcessingPhase, number> = {
    transcribe: 0,
    extract: 4193,
    enrich: 0,
    synopsis: 900,
    contradiction: 2298,
    salience_refine: 3507,
  };
  return {
    lastArrivedAt: AT,
    latestCycle: latest,
    cycleFreshness: 'current',
    phases: PROCESSING_PHASES.map((phase) => ({
      phase,
      waiting: waiting[phase],
      standing: standingOf(phase, latest),
    })),
    refusedWaiting: 0,
    mostRefusals: 0,
    modelTier: 'paid',
    ...over,
  };
}

function render(over: Partial<ProcessingView> = {}): string {
  return renderPage({
    kind: 'processing',
    available: true,
    reachable: true,
    tier: 'paid',
    view: view(over),
  });
}

describe('the three renders keep the way back on the page', () => {
  test('no port explains itself rather than printing six zeroes', () => {
    const page = renderPage({
      kind: 'processing',
      available: false,
      reachable: false,
      tier: 'free',
      view: null,
    });
    expect(page).toContain('indistinguishable from a brain that has finished everything');
    expect(page).toContain('href="/dashboard"');
  });

  test('a brain that will not open is explained, not blanked', () => {
    const page = renderPage({
      kind: 'processing',
      available: true,
      reachable: false,
      tier: 'paid',
      view: null,
    });
    expect(page).toContain('database waking up');
    expect(page).toContain('Nothing has been lost and nothing has stopped');
  });

  test('an empty brain says so and stops, rather than listing six idle steps', () => {
    const page = render({ lastArrivedAt: null });
    expect(page).toContain('nothing for the steps below to work on');
    expect(page).not.toContain('Making sense of it');
  });
});

describe('the standing of a step is inferred, and only where it is provable', () => {
  test('a clock stop marks the step it stopped in and every step after it', () => {
    expect(standingOf('synopsis', cycle())).toBe('stopped_here');
    expect(standingOf('contradiction', cycle())).toBe('not_reached');
    expect(standingOf('salience_refine', cycle())).toBe('not_reached');
    // Before it in run order: it ran, and the record says nothing more.
    expect(standingOf('extract', cycle())).toBe('unknown');
  });

  test('a phase failure claims nothing about the steps behind it', () => {
    const failed = cycle({ stopReason: 'phase_failed', stoppedPhase: 'extract', stoppedPhaseCode: 'bad_output' });
    expect(standingOf('extract', failed)).toBe('failed_here');
    // NOT `not_reached`: since the cycle began continuing past a durable phase
    // failure, the steps after it were attempted and only the first is recorded.
    expect(standingOf('synopsis', failed)).toBe('unknown');
    expect(standingOf('salience_refine', failed)).toBe('unknown');
  });

  test('a lost lease attributes nothing to any step', () => {
    const lost = cycle({ stopReason: 'cancelled', stoppedPhase: null, stoppedPhaseCode: null });
    for (const phase of PROCESSING_PHASES) expect(standingOf(phase, lost)).toBe('unknown');
  });

  test('a completed cycle attributes nothing, even having yielded its prefix', () => {
    const done = cycle({ stopReason: 'complete', dreamt: true, stoppedPhase: null, stoppedPhaseCode: null });
    for (const phase of PROCESSING_PHASES) expect(standingOf(phase, done)).toBe('unknown');
  });
});

describe('the page says only what the run record supports', () => {
  test('a clock stop renders the not-reached line and names the step it stopped at', () => {
    const page = render();
    expect(page).toContain('The last cycle stopped in this step');
    expect(page).toContain('<code>synopsis</code>');
    expect(page).toContain('before it got this far');
  });

  test('a stop in the free half is a section line, and never names that phase', () => {
    const page = render({ latestCycle: cycle({ stoppedPhase: 'cluster', stoppedPhaseCode: 'out_of_time' }) });
    expect(page).toContain('before this half of the pipeline began');
    // `cluster` is read by nothing the owner can see. The inference is kept and
    // the name is withheld.
    expect(page).not.toContain('cluster');
    expect(page).not.toContain('<code>salience</code>');
  });

  test('a phase failure says attempted, and never that nothing after it ran', () => {
    const page = render({
      latestCycle: cycle({ stopReason: 'phase_failed', stoppedPhase: 'extract', stoppedPhaseCode: 'bad_output' }),
    });
    expect(page).toContain('The steps after it were still attempted');
    expect(page).not.toContain('nothing after it ran');
    expect(page).not.toContain('before it got this far');
  });

  test('a shortfall is never printed without its cause, and never under a non-completion', () => {
    const short = render({
      latestCycle: cycle({ stopReason: 'complete', dreamt: true, stoppedPhase: null, stoppedPhaseCode: null, phasesRun: 10 }),
    });
    expect(short).toContain('10 of its 12 steps');
    expect(short).toContain('used its share of the cycle');

    // A cancelled cycle would otherwise print a bare fraction beside four large
    // waiting counts with no explanation anywhere on the page.
    const lost = render({ latestCycle: cycle({ stopReason: 'cancelled', stoppedPhase: null, stoppedPhaseCode: null }) });
    expect(lost).not.toMatch(/\d+ of its \d+ steps/);
  });

  test('a free run is never told it ran 6 of 12', () => {
    const page = render({
      latestCycle: cycle({ tier: 'free', stopReason: 'free_tier', stoppedPhase: null, stoppedPhaseCode: null, phasesRun: 6, phasesPlanned: 6, modelCalls: 0 }),
    });
    expect(page).toContain('ran every step of the pipeline');
    expect(page).not.toContain('of its 12 steps');
  });

  test('an open run does not guess between running and killed', () => {
    const page = render({ latestCycle: cycle({ finishedAt: null }) });
    expect(page).toContain('does not guess between them');
  });

  test('no cycle yet still renders the counters', () => {
    const page = render({ latestCycle: null });
    expect(page).toContain('No cycle has run on this brain yet');
    expect(page).toContain('Making sense of it');
  });
});

describe('money is rendered as what the cycle banked, and never as a bill', () => {
  test('a spend below the rounding floor says so rather than reading as free', () => {
    expect(render({ latestCycle: cycle({ spentMicroUsd: 4_000 }) })).toContain('less than a cent');
    expect(render({ latestCycle: cycle({ spentMicroUsd: 4_000 }) })).not.toContain('$0.00');
  });

  test('no spend at all is a word, because it is the diagnosis', () => {
    expect(render({ latestCycle: cycle({ spentMicroUsd: 0 }) })).toContain('nothing');
  });

  test('the figure is labelled as the cycle’s own, not the account’s', () => {
    const page = render();
    expect(page).toContain('$0.11');
    expect(page).toContain('not your bill');
  });
});

describe('the pacing note is gated on the step having had a turn', () => {
  test('it is absent when the step never ran', () => {
    // The default fixture stops at `synopsis`, so `salience_refine` is
    // `not_reached` and its pace is zero a cycle, not "a small fixed batch".
    expect(render()).not.toContain('the pace rather than a fault');
  });

  test('it renders when the step was reached and has a backlog', () => {
    const reached = view({ latestCycle: cycle({ stopReason: 'complete', dreamt: true, stoppedPhase: null, stoppedPhaseCode: null }) });
    const page = renderPage({ kind: 'processing', available: true, reachable: true, tier: 'paid', view: reached });
    expect(page).toContain('the pace rather than a fault');
  });
});

describe('the refusal count is reported without blaming the document', () => {
  test('it says the answer could not be used, and never that a document is unreadable', () => {
    const page = render({ refusedWaiting: 14, mostRefusals: 6 });
    expect(page).toContain('the answer could not be used');
    expect(page).toContain('the most any one of them has been sent is 6 times');
    expect(page).toContain('still stored');
    expect(page).not.toContain('unreadable');
    expect(page).not.toContain('offered again every cycle');
  });

  test('every waiting document being refused is an equality fact, not a threshold', () => {
    const page = render({ refusedWaiting: 900, mostRefusals: 4 });
    expect(page).toContain('Every document waiting here is one of them');
    expect(page).toContain('class="failing"');
  });

  test('an ordinary day prints no emphasis at all', () => {
    // One `out_of_time` cycle under `current` freshness. A page that warns on an
    // ordinary day is a page whose warnings stop being read.
    expect(render()).not.toContain('class="failing"');
  });

  test('the same stop under an alarming freshness is emphasised', () => {
    const page = render({ cycleFreshness: 'stale' });
    expect(page).toContain('class="failing"');
    expect(page).toContain('<strong>');
  });
});

describe('the free plan renders an absence, not six zeroes', () => {
  test('it says what the plan does rather than reporting a fault', () => {
    const page = renderPage({
      kind: 'processing',
      available: true,
      reachable: true,
      tier: 'free',
      view: view({ phases: null, refusedWaiting: null, mostRefusals: null, modelTier: 'free' }),
    });
    expect(page).toContain('not on the free plan');
    expect(page).toContain('still stored and searchable');
    // The section is absent, not six zeroes: no step list, no per-step code.
    expect(page).not.toContain('<code>synopsis</code>');
    expect(page).not.toContain('Nothing waiting');
  });
});

describe('the page shows counts, codes, times and one figure — and nothing else', () => {
  test('the rule paragraph states four classes, because the page renders four', () => {
    // NOT coverage's sentence: that one promises "counts, codes and times", and
    // this page also renders money. Copying it would understate the page in the
    // one paragraph whose whole job is being exact.
    expect(render()).toContain('counts, codes, times, and what your last cycle cost');
  });

  test('every value the view can carry is a number, an instant or a closed code', () => {
    const subject = view({ refusedWaiting: 14, mostRefusals: 6 });
    const standings = new Set(['not_reached', 'stopped_here', 'failed_here', 'unknown']);
    for (const entry of subject.phases ?? []) {
      expect(PROCESSING_PHASES).toContain(entry.phase);
      expect(typeof entry.waiting).toBe('number');
      expect(standings.has(entry.standing)).toBe(true);
    }
    expect(typeof subject.refusedWaiting).toBe('number');
    expect(typeof subject.mostRefusals).toBe('number');
    expect(subject.lastArrivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof subject.latestCycle?.spentMicroUsd).toBe('number');
    expect(typeof subject.latestCycle?.modelCalls).toBe('number');
  });

  test('no branch promises a remedy, an estimate, or a cap', () => {
    const pages = [
      render(),
      render({ cycleFreshness: 'stale' }),
      render({ cycleFreshness: 'capped' }),
      render({ refusedWaiting: 900, mostRefusals: 4 }),
      render({ latestCycle: null }),
      render({ latestCycle: cycle({ stopReason: 'phase_failed', stoppedPhase: 'extract', stoppedPhaseCode: 'bad_output' }) }),
    ];
    for (const page of pages) {
      expect(page).not.toContain('catch up');
      expect(page).not.toContain('next cycle will');
      expect(page).not.toContain('spend cap');
      expect(page).not.toContain('<form');
    }
  });

  test('the honest limit is stated rather than papered over', () => {
    // A phase that marked a large batch considered for a handful of results
    // renders here as progress, and no page can close that gap.
    expect(render()).toContain('not a claim that it found something in all of it');
  });
});

describe('the two siblings link both ways', () => {
  test('the processing page links to coverage for the totals', () => {
    expect(render()).toContain('href="/dashboard?view=coverage"');
  });

  test('the path is a query parameter, because the edge enumerates web paths', () => {
    expect(PROCESSING_PATH).toBe('/dashboard?view=processing');
  });
});

describe('the vocabularies this page reads are pinned to the ones it reads from', () => {
  test('the phase order is the cycle order, because the inference reads it as run order', () => {
    // `standingOf` decides `not_reached` by POSITION. The existing schema check
    // asserts the set sorted; a reorder to match the CHECK's text would silently
    // invert this page's central claim, and nothing else would notice.
    expect([...CYCLE_PHASE_NAMES]).toEqual([...CYCLE_PHASES]);
  });

  test('the six steps are the model half, because the denominator is derived from both', () => {
    // `phasesPlanned` is `CYCLE_PHASE_NAMES.length - PROCESSING_PHASES.length`
    // on a free run, so a member added to one and not the other prints the wrong
    // denominator to a free user.
    expect([...PROCESSING_PHASES]).toEqual([...MODEL_PHASES]);
  });
});

// ---------------------------------------------------------------------------
// The composition. The real read, against a real brain.
// ---------------------------------------------------------------------------

describe('the read that is actually wired', () => {
  const NOW = new Date('2026-08-20T22:00:00.000Z');
  const WORK = 'work:mail';
  const VECTOR = `[${new Array(EMBEDDING_DIMENSIONS).fill(0).join(',')}]`;

  let brainSql: SQL;
  let schema: SchemaFixture;

  beforeAll(async () => {
    schema = await provisionFixture('processingroute');
    brainSql = connectTenant(schema);
  }, 180_000);

  afterAll(async () => {
    await brainSql?.close();
    if (schema !== undefined) await dropFixtureDatabase(schema);
  });

  beforeEach(async () => {
    await brainSql.unsafe(`
      DELETE FROM attachment;
      DELETE FROM entity;
      DELETE FROM fact;
      DELETE FROM chunk;
      DELETE FROM page;
      DELETE FROM consolidation_run;
    `);
  });

  async function insertPage(options: {
    readonly derivation?: string;
    readonly externalRef?: string | null;
    readonly stale?: boolean;
    readonly quarantined?: boolean;
    readonly refusals?: number;
    readonly refineVersion?: number | null;
  } = {}): Promise<string> {
    const rows = (await brainSql.unsafe(
      `INSERT INTO page (origin_context, source_type, title, derivation, external_ref,
                         embedding_model, embedding_dimensions, chunker_version, normalizer_version,
                         content_sha256, created_at, stale_at, quarantined_at,
                         consolidation_refusals, salience_refine_considered_version)
       VALUES ($1, 'email', 'Lunch with Priya about the Q3 renewal', $2, $3,
               'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1,
               md5(random()::text) || md5(random()::text), $4::timestamptz,
               $5::timestamptz, $6::timestamptz, $7, $8)
       RETURNING page_id::text AS id`,
      [
        WORK,
        options.derivation ?? 'ingested',
        options.externalRef ?? null,
        NOW.toISOString(),
        options.stale === true ? NOW.toISOString() : null,
        options.quarantined === true ? NOW.toISOString() : null,
        options.refusals ?? 0,
        options.refineVersion ?? null,
      ],
    )) as Array<{ id: string }>;
    return rows[0]?.id ?? '';
  }

  async function insertChunk(pageId: string, extractVersion: number | null = null): Promise<void> {
    await brainSql.unsafe(
      `INSERT INTO chunk (page_id, ordinal, content, ${ACTIVE_EMBEDDING_SEAT.column},
                          origin_context, extract_considered_version)
       VALUES ($1::bigint, 0, 'Priya confirmed the renewal lands in Q3.', $2::vector, $3, $4)`,
      [pageId, VECTOR, WORK, extractVersion],
    );
  }

  /** A summary page plus the chunk `writeCanonicalSummary` writes against it. */
  async function summarise(pageId: string): Promise<void> {
    const summary = await insertPage({
      derivation: 'model_derived',
      externalRef: `${SUMMARY_REF_PREFIX}${pageId}`,
    });
    await insertChunk(summary);
  }

  const read = (tier: 'free' | 'paid' = 'paid') =>
    readProcessing(brainSql, { now: NOW, modelTier: tier });

  const waitingFor = (result: ProcessingView, phase: ProcessingPhase): number =>
    result.phases?.find((entry) => entry.phase === phase)?.waiting ?? -1;

  test('the brain’s own summaries are in no counter, so the meters can reach zero', async () => {
    const page = await insertPage();
    await insertChunk(page);
    await summarise(page);

    const result = await read();
    // The summary page has a live chunk of its own. If that chunk were counted,
    // `extract` would gain one candidate every time `synopsis` succeeded.
    expect(waitingFor(result, 'extract')).toBe(1);
    expect(waitingFor(result, 'synopsis')).toBe(0);
    expect(waitingFor(result, 'salience_refine')).toBe(1);
  });

  test('an ingested page with no live chunk is offered to no page phase', async () => {
    await insertPage();
    const result = await read();
    expect(waitingFor(result, 'synopsis')).toBe(0);
    expect(waitingFor(result, 'salience_refine')).toBe(0);
  });

  test('two summaries standing against one page count it once, not twice', async () => {
    const page = await insertPage();
    await insertChunk(page);
    await summarise(page);
    await summarise(page);

    // `page_by_external_ref` is not unique and duplicates stand in production.
    expect(waitingFor(await read(), 'synopsis')).toBe(0);
  });

  test('a stale or quarantined page is in no counter', async () => {
    const stale = await insertPage({ stale: true });
    await insertChunk(stale);
    const hidden = await insertPage({ quarantined: true });
    await insertChunk(hidden);

    const result = await read();
    expect(waitingFor(result, 'synopsis')).toBe(0);
    expect(waitingFor(result, 'extract')).toBe(0);
    expect(waitingFor(result, 'salience_refine')).toBe(0);
  });

  test('an empty transcription is the done state, not a waiting one', async () => {
    const page = await insertPage();
    await brainSql.unsafe(
      `INSERT INTO attachment (page_id, origin_context, media_type, object_key, ocr_text)
       VALUES ($1::bigint, $2, 'image/png', 'k/1', ''), ($1::bigint, $2, 'image/png', 'k/2', NULL)`,
      [page, WORK],
    );
    expect(waitingFor(await read(), 'transcribe')).toBe(1);
  });

  test('a stamped row is done, and a version bump re-offers it', async () => {
    const stamped = await insertPage({ refineVersion: CONSIDERATION_VERSION.salience_refine });
    await insertChunk(stamped, CONSIDERATION_VERSION.extract);
    const unstamped = await insertPage();
    await insertChunk(unstamped);
    await summarise(stamped);
    await summarise(unstamped);

    const result = await read();
    expect(waitingFor(result, 'extract')).toBe(1);
    expect(waitingFor(result, 'salience_refine')).toBe(1);

    // **"One version behind" is unreachable while the floor is 1**: the CHECK is
    // `IS NULL OR >= 1`, so version 0 is not a storable state and the two live
    // cases above cannot tell `IS NULL` apart from `IS NULL OR col < $n`. The
    // `<` arm is what makes a bump re-offer the corpus, so it is asserted by
    // running the counter's own predicate one version ahead — the exact query
    // this read issues on the day somebody increments the constant.
    const ahead = (await brainSql.unsafe(
      `SELECT count(*)::int AS n
         FROM chunk c JOIN page p ON p.page_id = c.page_id
        WHERE c.deleted_at IS NULL AND c.quarantined_at IS NULL
          AND p.deleted_at IS NULL AND p.quarantined_at IS NULL AND p.stale_at IS NULL
          AND p.derivation = 'ingested'
          AND (c.extract_considered_version IS NULL OR c.extract_considered_version < $1)`,
      [CONSIDERATION_VERSION.extract + 1],
    )) as Array<{ n: number }>;
    // Both chunks: the stamped one is behind the new version, and a bare
    // `IS NULL` page would still report one and call the brain converged.
    expect(ahead[0]?.n).toBe(2);
  });

  test('enrich counts live entities only; contradiction counts live, unsuperseded facts', async () => {
    await brainSql.unsafe(
      `INSERT INTO entity (canonical_name, entity_type, origin_contexts, deleted_at)
       VALUES ('Priya', 'person', ARRAY[$1]::text[], NULL),
              ('Gone', 'person', ARRAY[$1]::text[], $2::timestamptz)`,
      [WORK, NOW.toISOString()],
    );
    const rows = (await brainSql.unsafe(
      `INSERT INTO fact (statement, ${ACTIVE_EMBEDDING_SEAT.column}, origin_contexts, quarantined_at)
       VALUES ('live', $1::vector, ARRAY[$2]::text[], NULL),
              ('hidden', $1::vector, ARRAY[$2]::text[], $3::timestamptz),
              ('older', $1::vector, ARRAY[$2]::text[], NULL)
       RETURNING fact_id::text AS id`,
      [VECTOR, WORK, NOW.toISOString()],
    )) as Array<{ id: string }>;
    await brainSql.unsafe(`UPDATE fact SET superseded_by = $1::bigint WHERE fact_id = $2::bigint`, [
      rows[0]?.id ?? '',
      rows[2]?.id ?? '',
    ]);

    const result = await read();
    expect(waitingFor(result, 'enrich')).toBe(1);
    expect(waitingFor(result, 'contradiction')).toBe(1);
  });

  test('the refusal count is scoped to the documents synopsis is still waiting on', async () => {
    const waitingRefused = await insertPage({ refusals: 3 });
    await insertChunk(waitingRefused);

    // Refused, but since summarised: no longer waiting, so out of both numbers.
    const summarised = await insertPage({ refusals: 9 });
    await insertChunk(summarised);
    await summarise(summarised);

    // Refused, but gone stale: out of the candidate set entirely.
    const stale = await insertPage({ refusals: 7, stale: true });
    await insertChunk(stale);

    const result = await read();
    expect(waitingFor(result, 'synopsis')).toBe(1);
    // 9 and 7 are both larger than 3. A whole-table predicate would report one
    // of them and make the sentence comparing these two numbers false.
    expect(result.refusedWaiting).toBe(1);
    expect(result.mostRefusals).toBe(3);
  });

  test('a brain with no refusals reports zero, not null, so the gate is the count', async () => {
    const page = await insertPage();
    await insertChunk(page);
    const result = await read();
    expect(result.refusedWaiting).toBe(0);
    expect(result.mostRefusals).toBe(0);
  });

  test('the free tier is asked for no counters at all', async () => {
    const page = await insertPage();
    await insertChunk(page);
    const result = await read('free');
    expect(result.phases).toBeNull();
    expect(result.refusedWaiting).toBeNull();
    expect(result.modelTier).toBe('free');
  });

  test('the newest run is read open or closed, and its spend survives the bigint', async () => {
    await brainSql.unsafe(
      `INSERT INTO consolidation_run (trigger_reason, tier, dreamt, stop_reason, stopped_phase,
                                      stopped_phase_code, started_at, finished_at, phases_run,
                                      model_calls, spent_micro_usd)
       VALUES ('user_request', 'paid', false, 'out_of_time', 'synopsis', 'out_of_time',
               $1::timestamptz, $1::timestamptz, 10, 47, 110000)`,
      [NOW.toISOString()],
    );
    const result = await read();
    expect(result.latestCycle?.spentMicroUsd).toBe(110_000);
    expect(result.latestCycle?.phasesPlanned).toBe(12);
    expect(waitingFor(result, 'contradiction')).toBe(0);
    // The stop is at `synopsis`, so everything after it never got a turn.
    expect(result.phases?.find((p) => p.phase === 'contradiction')?.standing).toBe('not_reached');
  });

  test('a free run’s denominator is the deterministic half, never twelve', async () => {
    await brainSql.unsafe(
      `INSERT INTO consolidation_run (trigger_reason, tier, dreamt, stop_reason, started_at,
                                      finished_at, phases_run, model_calls, spent_micro_usd)
       VALUES ('time_ceiling', 'free', false, 'free_tier', $1::timestamptz, $1::timestamptz, 6, 0, 0)`,
      [NOW.toISOString()],
    );
    expect((await read()).latestCycle?.phasesPlanned).toBe(6);
  });

  test('the summary prefix this read restates is the one the writer uses', () => {
    // A test may import worker code; a page render may not. This is what keeps
    // the local restatement honest.
    expect(SUMMARY_REF_PREFIX).toBe('summary:');
  });
});
