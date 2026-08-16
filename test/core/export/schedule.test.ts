/**
 * The scheduled self-export and its **bounded** reminder.
 *
 * The trap named in the unit's own brief: *"an unconditional nag on a daily path
 * is a daily sales pitch."* `briefing` is what a client scheduled task pulls
 * every morning, so a reminder with no bound fires 365 times a year on the
 * flagship read. The bound is the one U12's free→paid prompt established, and
 * the first test here is the one that would catch its removal: **two consecutive
 * scheduled runs, no dismissal, no band crossing → exactly one reminder.**
 *
 * The rest are the ways a bound quietly stops bounding: a brain with nothing in
 * it being reminded to back up nothing; a fresh export still producing a
 * reminder; and — the one a backup product must never get wrong — six weeks of
 * silently failing exports being reported as "not set up yet".
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  NAG_INTERVAL_DAYS,
  STALENESS_BANDS,
  bandOf,
  readContentAge,
  readExportState,
  readNagState,
  recordNagShown,
  runSelfExport,
  selfExportNag,
  type NagInput,
  type SelfExportDestination,
} from '../../../src/core/export/schedule.ts';
import { EMBEDDING_DIMENSIONS } from '../../../src/schema/vector-index.ts';
import { connect, dropFixtureDatabase, provisionFixture, type SchemaFixture } from '../../schema/fixture.ts';

import type { SQL } from 'bun';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

let schema: SchemaFixture;
let sql: SQL;

const NOW = new Date('2026-08-15T00:00:00.000Z');

function input(overrides: Partial<NagInput> = {}): NagInput {
  return {
    destinationConfigured: false,
    lastExportAt: null,
    oldestContentAt: new Date(NOW.getTime() - 40 * DAY_MS).toISOString(),
    pages: 12,
    lastFailure: null,
    state: { lastShownAt: null, lastBand: 0 },
    now: NOW,
    ...overrides,
  };
}

describe('the bound', () => {
  test('two consecutive scheduled runs, nothing changed, produce exactly ONE reminder', () => {
    const first = selfExportNag(input());
    expect(first).not.toBeNull();

    // The next morning's briefing, same state, the band banked.
    const second = selfExportNag(
      input({
        state: { lastShownAt: NOW.toISOString(), lastBand: first!.band },
        now: new Date(NOW.getTime() + DAY_MS),
      }),
    );
    expect(second).toBeNull();
  });

  test('a fortnight later it may speak again, and not before', () => {
    const shown = { lastShownAt: NOW.toISOString(), lastBand: 30 };
    const dayBefore = selfExportNag(
      input({ state: shown, now: new Date(NOW.getTime() + (NAG_INTERVAL_DAYS - 1) * DAY_MS) }),
    );
    expect(dayBefore).toBeNull();

    const dayOf = selfExportNag(
      input({ state: shown, now: new Date(NOW.getTime() + NAG_INTERVAL_DAYS * DAY_MS) }),
    );
    expect(dayOf?.reason).toBe('interval');
  });

  test('crossing into a worse band speaks even inside the interval', () => {
    const nag = selfExportNag(
      input({
        state: { lastShownAt: NOW.toISOString(), lastBand: 7 },
        oldestContentAt: new Date(NOW.getTime() - 100 * DAY_MS).toISOString(),
        now: new Date(NOW.getTime() + DAY_MS),
      }),
    );
    expect(nag?.reason).toBe('staleness_band');
    expect(nag?.band).toBe(90);
  });

  test('staleness accruing INSIDE one band is silence', () => {
    // The half that makes the crossing rule real: 8 days and 29 days are the
    // same band, and a reminder per day inside it is the daily sales pitch.
    const nag = selfExportNag(
      input({
        state: { lastShownAt: NOW.toISOString(), lastBand: 7 },
        oldestContentAt: new Date(NOW.getTime() - 20 * DAY_MS).toISOString(),
        now: new Date(NOW.getTime() + DAY_MS),
      }),
    );
    expect(nag).toBeNull();
  });

  test('the reminder states its own dismissal', () => {
    expect(selfExportNag(input())?.dismissal).toContain(String(NAG_INTERVAL_DAYS));
  });

  test('the band ladder is what it says it is', () => {
    expect(bandOf(0)).toBe(0);
    expect(bandOf(6)).toBe(0);
    expect(bandOf(7)).toBe(STALENESS_BANDS[0] ?? -1);
    expect(bandOf(1000)).toBe(STALENESS_BANDS.at(-1) ?? -1);
  });
});

describe('what the reminder refuses to say', () => {
  test('a brain with nothing in it is never reminded to back up nothing', () => {
    expect(selfExportNag(input({ pages: 0, oldestContentAt: null }))).toBeNull();
    expect(selfExportNag(input({ pages: 0 }))).toBeNull();
  });

  test('a brain exported yesterday is not reminded', () => {
    expect(
      selfExportNag(
        input({
          destinationConfigured: true,
          lastExportAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
        }),
      ),
    ).toBeNull();
  });

  test('a failing schedule is reported as failing, not as "not set up yet"', () => {
    // The distinction a backup product must never lose: reporting six weeks of
    // silent failures as an absent setup is what stops the user investigating.
    const nag = selfExportNag(
      input({
        destinationConfigured: true,
        lastExportAt: new Date(NOW.getTime() - 45 * DAY_MS).toISOString(),
        lastFailure: 'DestinationUnreachable',
      }),
    );
    expect(nag?.text).toContain('failing');
    expect(nag?.text).toContain('DestinationUnreachable');
    expect(nag?.text).not.toContain('live only here');
  });
});

describe('the run, and the two columns it writes to', () => {
  beforeEach(async () => {
    if (schema === undefined) {
      schema = await provisionFixture('u17sched');
      sql = connect(schema);
    }
    await sql`DELETE FROM self_export`;
    await sql`DELETE FROM self_export_nag`;
    await sql`DELETE FROM chunk`;
    await sql`DELETE FROM page`;
    await sql.unsafe(`
      INSERT INTO page (origin_context, source_type, title, embedding_model, embedding_dimensions,
                        chunker_version, normalizer_version, content_sha256)
      VALUES ('personal', 'note', 'a note', 'text-embedding-3-small', ${EMBEDDING_DIMENSIONS}, 1, 1, repeat('a', 64));
      INSERT INTO chunk (origin_context, content, page_id, ordinal)
      SELECT 'personal', 'something worth keeping', page_id, 0 FROM page WHERE title = 'a note';
    `);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await sql?.close();
    if (schema !== undefined) await dropFixtureDatabase(schema);
  });

  test(
    'a delivered export banks its digest, and the reminder goes quiet',
    async () => {
      const written: number[] = [];
      const destination: SelfExportDestination = {
        kind: 'object_store',
        write: ({ files }) => {
          written.push(files.length);
          return Promise.resolve();
        },
      };

      const outcome = await runSelfExport(sql, { destination, now: NOW });
      expect(outcome.ok).toBe(true);
      expect(written).toEqual([1]);

      const state = await readExportState(sql);
      expect(state.lastExportAt).not.toBeNull();
      expect(state.lastExportPages).toBe(1);
      expect(state.lastExportDigest).toHaveLength(64);
      expect(state.lastFailure).toBeNull();

      const age = await readContentAge(sql);
      expect(
        selfExportNag({
          destinationConfigured: state.destinationKind !== null,
          lastExportAt: state.lastExportAt,
          oldestContentAt: age.oldestContentAt,
          pages: age.pages,
          lastFailure: state.lastFailure,
          state: await readNagState(sql, 'grant-1'),
          now: NOW,
        }),
      ).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a failed delivery moves the ATTEMPT and leaves the last successful export where it was',
    async () => {
      await runSelfExport(sql, {
        destination: { kind: 'object_store', write: () => Promise.resolve() },
        now: NOW,
      });
      const delivered = await readExportState(sql);

      const outcome = await runSelfExport(sql, {
        destination: {
          kind: 'object_store',
          write: () => {
            const failure = new Error('the bucket did not answer');
            failure.name = 'DestinationUnreachable';
            return Promise.reject(failure);
          },
        },
        now: new Date(NOW.getTime() + DAY_MS),
      });
      expect(outcome.ok).toBe(false);

      const after = await readExportState(sql);
      // The asymmetry is the whole reason there are two columns.
      expect(after.lastExportAt).toBe(delivered.lastExportAt);
      expect(after.lastFailure).toBe('DestinationUnreachable');
      expect(after.lastAttemptAt).not.toBe(delivered.lastAttemptAt);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a successful export CLEARS a previous failure, or the reminder says "failing" forever',
    async () => {
      const failing: SelfExportDestination = {
        kind: 'object_store',
        write: () => {
          const failure = new Error('the bucket did not answer');
          failure.name = 'DestinationUnreachable';
          return Promise.reject(failure);
        },
      };
      await runSelfExport(sql, { destination: failing, now: NOW });
      expect((await readExportState(sql)).lastFailure).toBe('DestinationUnreachable');

      await runSelfExport(sql, {
        destination: { kind: 'object_store', write: () => Promise.resolve() },
        now: new Date(NOW.getTime() + DAY_MS),
      });

      const after = await readExportState(sql);
      expect(after.lastFailure).toBeNull();
      // And the reminder stops calling a working backup broken.
      const age = await readContentAge(sql);
      expect(
        selfExportNag({
          destinationConfigured: true,
          lastExportAt: after.lastExportAt,
          oldestContentAt: age.oldestContentAt,
          pages: age.pages,
          lastFailure: after.lastFailure,
          state: { lastShownAt: null, lastBand: 0 },
          now: new Date(NOW.getTime() + 100 * DAY_MS),
        })?.text ?? '',
      ).not.toContain('failing');
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'the reminder bound is per caller, so a second client is not silenced by the first',
    async () => {
      await recordNagShown(sql, { callerKey: 'grant-1', band: 30, at: NOW });

      expect(await readNagState(sql, 'grant-1')).toEqual({
        lastShownAt: expect.any(String),
        lastBand: 30,
      });
      // A different credential has never been reminded. U12's reason, applied
      // to the second thing that rides the daily read.
      expect(await readNagState(sql, 'grant-2')).toEqual({ lastShownAt: null, lastBand: 0 });
    },
    TEST_TIMEOUT_MS,
  );
});
