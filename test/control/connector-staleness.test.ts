/**
 * The detection rule, and the ten hours it was written for.
 *
 * **The incident.** Every connector on a brain stopped importing for roughly ten
 * hours and nothing anywhere said so. Not a banner, not a non-200, not a queue
 * row out of place. Each cadence tick enqueued a pull, each pull halted before
 * it wrote anything, and each halt was recorded as a run that *completed its
 * job* — because a `stopped` run holds its cursor and is deliberately not thrown
 * on (`src/ingest/pipedream/pull.ts`). So `last_attempt_at` advanced every five
 * minutes, `items_failed` stayed at zero on both halt paths, and every clock a
 * reader might reach for looked fresh.
 *
 * The one clock that did not move was `last_success_at`, and nothing read it.
 *
 * So the case that matters most in this file is the first one below, named after
 * the incident: *the ten-hour silence* — a health row whose last attempt is
 * minutes old, whose failed-item count is zero, and whose last success is ten
 * hours back. An attempt-based rule calls it healthy. This rule calls it
 * `stale`.
 *
 * **The other half of the error budget is here too.** A rule that only avoided
 * false negatives would be a rule somebody mutes: the fleet is woken by a cron
 * every thirty minutes, so a poll period is never shorter than that whatever a
 * connector's cadence says, and a deploy leaves a gap of up to two hours with
 * nothing wrong. Those cases are pinned as *not* alarming, deliberately and by
 * name, because they are what a threshold chosen from the cadence alone would
 * page on nightly until the page stopped being read.
 */

import { describe, expect, test } from 'bun:test';

import {
  fleetConnectorVerdict,
  freshnessOf,
  isAlarming,
  pollPeriodSeconds,
  staleAfterSeconds,
  unattendedAfterSeconds,
  type ConnectorFreshness,
} from '../../src/control/connector-staleness.ts';

const NOW = new Date('2026-08-18T18:00:00.000Z');
const HOUR = 3_600_000;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

/**
 * One connected source, described the way the control plane describes it, with
 * the interesting field per case overridden.
 *
 * `attemptingSince` defaults to a week back: every case here is about a
 * connector that has been around long enough for the first-success grace to have
 * expired, except the two that are about the grace.
 */
function state(overrides: {
  readonly lastSuccessAt?: Date | null;
  readonly runOutcome?: 'completed' | 'stopped' | 'deferred' | 'refused' | 'failed' | null;
  readonly attempted?: boolean;
  readonly attemptingSince?: Date | null;
  readonly link?: 'connected' | 'pending' | 'absent';
  readonly source?: string;
}): ConnectorFreshness {
  const attempted = overrides.attempted ?? true;
  return freshnessOf({
    source: overrides.source ?? 'gmail',
    link: overrides.link ?? 'connected',
    attempt: attempted
      ? {
          lastSuccessAt: overrides.lastSuccessAt ?? null,
          runOutcome: overrides.runOutcome ?? 'completed',
        }
      : undefined,
    attemptingSince: overrides.attemptingSince ?? ago(7 * 24 * HOUR),
    now: NOW,
  }).state;
}

// ---------------------------------------------------------------------------

describe('the ten-hour silence', () => {
  test('THE CASE: every attempt failing keeps last_attempt_at fresh, and the rule still says stale', () => {
    // The founder's brain, as `control.connector_health` actually held it: a
    // `stopped` run five minutes ago, nothing lost because the halt is upstream
    // of the write, and a last success ten hours back. Every field except one
    // reads as a connector that is being polled and is fine.
    expect(
      state({ lastSuccessAt: ago(10 * HOUR), runOutcome: 'stopped' }),
    ).toBe('stale');
  });

  test('and an attempt-based reading of the same row is the bug, so it is pinned as one', () => {
    // The rule is handed no `lastAttemptAt` at all. That is the design and not an
    // omission: a field this function cannot see is a field a later edit cannot
    // quietly start measuring from. If this stops compiling because somebody
    // added one, the ten hours are back on the table.
    const input = {
      source: 'gmail',
      link: 'connected' as const,
      attempt: { lastSuccessAt: ago(10 * HOUR), runOutcome: 'stopped' as const },
      attemptingSince: ago(7 * 24 * HOUR),
      now: NOW,
    };
    expect(Object.hasOwn(input.attempt, 'lastAttemptAt')).toBe(false);
    expect(freshnessOf(input).state).toBe('stale');
  });

  test('the same row an hour in is not stale yet, because a poll is not owed that fast', () => {
    // Not a softening of the case above — the boundary. A single failed poll is
    // a normal Tuesday, and a rule that banners on it is a rule that gets muted
    // before the day it is needed.
    expect(state({ lastSuccessAt: ago(HOUR), runOutcome: 'stopped' })).toBe('slipping');
  });
});

describe('the clock is last_success_at, and NULL is not a reading of it', () => {
  test('a connector that has attempted and never once succeeded is its own state', () => {
    expect(state({ lastSuccessAt: null, runOutcome: 'failed' })).toBe('never_succeeded');
  });

  test('and it is not the same as one nothing has attempted yet', () => {
    // Two different sentences and two different remedies: nothing has run, versus
    // it runs and has never worked. A rule that answered `unknown` for both would
    // hide the second inside the first.
    expect(state({ attempted: false })).toBe('unpolled');
  });

  test('never-succeeded inside its first window is `starting`, not an alarm', () => {
    // The first poll happens on the worker fleet's next wake, and a first import
    // can legitimately stop on a spend cap. Without this window every fresh
    // signup would flip the fleet verdict for its first half hour, weekly, until
    // somebody turned the monitor off.
    expect(
      state({
        lastSuccessAt: null,
        runOutcome: 'stopped',
        attemptingSince: ago(20 * 60_000),
      }),
    ).toBe('starting');
  });

  test('and an unknown anchor is read as expired rather than as young', () => {
    // Fail loud. "I cannot tell how long this has been trying" must not answer
    // "so assume it just started" on the one surface whose job is to notice.
    expect(
      state({ lastSuccessAt: null, runOutcome: 'failed', attemptingSince: null }),
    ).toBe('never_succeeded');
  });
});

describe('the cell that is not an alarm, and the deploy gap it exists for', () => {
  test('a completed run with an old success is unattended, not stale', () => {
    // The conjunction is the whole design. A restart leaves a gap of up to two
    // hours with `run_outcome = 'completed'` still on the row: nothing failed,
    // nothing was even tried. Calling that `stale` would page on every deploy,
    // and a rule that pages on every deploy is a rule nobody reads on the day
    // something is actually wrong.
    expect(state({ lastSuccessAt: ago(2 * HOUR), runOutcome: 'completed' })).toBe('current');
    expect(isAlarming(state({ lastSuccessAt: ago(2 * HOUR), runOutcome: 'completed' }))).toBe(
      false,
    );
  });

  test('but a completed run whose success is a day old is the dead scheduler', () => {
    // The one failure a success-only reading catches and cannot name any other
    // way: the last thing that happened worked, and nothing has happened since.
    // A completed run stamps both clocks with the same instant, so an old success
    // under a completed outcome IS "nothing has attempted this since".
    expect(state({ lastSuccessAt: ago(24 * HOUR), runOutcome: 'completed' })).toBe('unattended');
    expect(isAlarming('unattended')).toBe(true);
  });
});

describe('thresholds account for cadence, and for the wake that outranks it', () => {
  test('no source is polled faster than the fleet is woken', () => {
    // gmail asks for five minutes and cannot have it: the worker fleet is woken
    // by a half-hourly cron, so five minutes is a cadence that never happens.
    // A threshold derived from the declared number would alarm on every healthy
    // gmail connector, every night.
    expect(pollPeriodSeconds('gmail')).toBe(1800);
    expect(pollPeriodSeconds('drive')).toBe(1800);
  });

  test('a slower source gets a proportionally later threshold', () => {
    // Not a constant. The rule is a multiple of the source's own period, so a
    // connector declared at two hours does not read as stale at ninety minutes
    // the day somebody adds one.
    expect(staleAfterSeconds('gmail')).toBe(3 * 1800);
    expect(unattendedAfterSeconds('gmail')).toBe(6 * 1800);
    expect(staleAfterSeconds('quarterly-thing')).toBeGreaterThanOrEqual(3 * 1800);
  });

  test('an unknown source is given the wake period rather than zero', () => {
    // The fail-safe direction for a source this build has never heard of: a
    // missing cadence must not become a zero-second threshold that reports every
    // connector of that kind as stale forever.
    expect(pollPeriodSeconds('something-new')).toBe(1800);
  });
});

describe('a source nobody connected is not a source that is broken', () => {
  test('a disconnected link reads as not_connected however old its health row is', () => {
    // Nothing deletes a health row on disconnect — its foreign key is to the
    // tenant, not to the link. A rule that started from the health row would
    // report a source somebody removed in March as stalled forever, the alert
    // would be muted, and the surface would be worse than none.
    expect(
      state({ lastSuccessAt: ago(90 * 24 * HOUR), runOutcome: 'stopped', link: 'absent' }),
    ).toBe('not_connected');
    expect(
      state({ lastSuccessAt: ago(90 * 24 * HOUR), runOutcome: 'stopped', link: 'pending' }),
    ).toBe('not_connected');
  });
});

describe('the fleet verdict is one field a monitor can page on', () => {
  test('every connector current reads ok', () => {
    expect(fleetConnectorVerdict(['current', 'current', 'starting', 'unpolled'])).toBe('ok');
  });

  test('a fleet with no connectors at all is ok rather than unknown', () => {
    // Vacuously healthy, and deliberately: health is a claim about a thing that
    // is supposed to be running, and a verdict that is permanently non-green on
    // an empty fleet is a monitor somebody switches off within a week. The counts
    // beside it are what tell an empty fleet from a broken one.
    expect(fleetConnectorVerdict([])).toBe('ok');
  });

  test('one failing attempt is degraded, and one stale connector is stalled', () => {
    expect(fleetConnectorVerdict(['current', 'slipping'])).toBe('degraded');
    expect(fleetConnectorVerdict(['current', 'slipping', 'stale'])).toBe('stalled');
    expect(fleetConnectorVerdict(['never_succeeded'])).toBe('stalled');
    expect(fleetConnectorVerdict(['unattended'])).toBe('stalled');
  });
});
