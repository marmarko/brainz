/**
 * What the dashboard says about a connector, and — the half that was missing —
 * whether it says anything the person reading it can act on.
 *
 * **The defect these cases pin.** A connector whose grant had been revoked
 * produced a job row in `due` with `attempts > 0`, walking the retry ladder. The
 * panel read the queue, saw an open row, and rendered *"Connected. A check is
 * queued or running now"* — the same sentence a perfectly healthy connector
 * gets — for the whole length of the ladder. When it finally dead-lettered, the
 * copy named `handler_error`, which is the runner's bucket for "a handler
 * threw", and told the user to disconnect and connect again, which is the right
 * instruction for one cause and the wrong one for every other.
 *
 * A test that asserted the failing lane rendered the word "failing" passed
 * throughout. So these assert the **cause** and the **instruction**, and the
 * pair below is the one that matters: `auth_expired` is told to reconnect and
 * `budget_exhausted` is explicitly not, because reconnecting costs that user a
 * re-authorization and then fails again in the same place.
 *
 * Pure functions and no database. `test/worker/ingest-lanes.test.ts` is where a
 * real failed poll is driven through a real queue into these; what is here is
 * the resolution rule and the copy, where a mutation should fail a case rather
 * than a page.
 */

import { describe, expect, test } from 'bun:test';

import type { ConnectorHealthView } from '../../src/control/connector-health.ts';
import { statusFor, type PullHistory } from '../../src/web/connector-panel.ts';
import { causeSentence } from '../../src/web/pages.ts';

const NOW = new Date('2026-08-17T09:00:00.000Z');
const EARLIER = new Date(NOW.getTime() - 3_600_000);

function history(overrides: Partial<PullHistory> = {}): PullHistory {
  return {
    target: 'gmail',
    open: 0,
    openAttempts: 0,
    openMaxAttempts: 0,
    openRunAt: null,
    lastDoneAt: null,
    deadAt: null,
    deadCode: null,
    deadAttempts: 0,
    deadMaxAttempts: 0,
    ...overrides,
  };
}

function health(overrides: Partial<ConnectorHealthView> = {}): ConnectorHealthView {
  return {
    source: 'gmail',
    lastAttemptAt: NOW,
    lastSuccessAt: null,
    runOutcome: 'failed',
    ingestFailureCode: 'auth_expired',
    jobFailureCode: null,
    itemsWritten: 0,
    itemsFailed: 0,
    ...overrides,
  };
}

describe('a lane that is retrying is not a lane that is checking', () => {
  test('an open row with attempts spent reads as retrying, and names the cause', () => {
    const status = statusFor('gmail', history({ open: 1, openAttempts: 1 }), 'connected', health());
    expect(status).toMatchObject({ state: 'retrying', cause: 'auth_expired' });
  });

  test('an open row on its first attempt still reads as checking', () => {
    // The other half of the distinction, and the reason it is `attempts` rather
    // than "is there a health record": a first check has nothing to explain, and
    // a source that failed last week and is being polled again now must not
    // wear last week's code while this attempt is still running.
    const status = statusFor(
      'gmail',
      history({ open: 1, openAttempts: 0, lastDoneAt: EARLIER }),
      'connected',
      health(),
    );
    expect(status).toMatchObject({ state: 'checking', cause: null });
  });

  test('a dead-lettered lane still reports the dead-letter code AND the cause', () => {
    // Two different facts, and the panel needs both: `deadCode` is why the queue
    // stopped retrying, `cause` is why the attempts failed. Collapsing them was
    // the original defect — the user was shown the first and told it was the
    // second.
    const status = statusFor(
      'gmail',
      history({ deadAt: NOW, deadCode: 'handler_error' }),
      'connected',
      health(),
    );
    expect(status).toMatchObject({
      state: 'failing',
      failureCode: 'handler_error',
      cause: 'auth_expired',
    });
  });

  test('a disconnected source carries no cause, whatever the last attempt said', () => {
    // A code on a source the user has removed is a red line with no control to
    // clear it — the same rule the dead-letter reading already followed.
    for (const link of ['absent', 'pending'] as const) {
      expect(statusFor('gmail', history({ open: 1, openAttempts: 3 }), link, health())).toMatchObject(
        { cause: null, itemsFailed: 0 },
      );
    }
  });

  test('a connector nothing has recorded reads as it did before the record existed', () => {
    // The upgrade case. A connector last polled by a fleet older than
    // `control.connector_health` has a job row and no health row, and the panel
    // must degrade to what it used to say rather than invent a reason.
    const status = statusFor('gmail', history({ open: 1, openAttempts: 2 }), 'connected', undefined);
    expect(status).toMatchObject({ state: 'retrying', cause: null, itemsFailed: 0 });
    expect(causeSentence(status.cause)).toBeNull();
  });

  test('a completed lane still reports what the last attempt lost', () => {
    // A `stopped` run completes its job — the cursor is held and the next tick
    // resumes it — so a poll that came back short leaves no failing lane at all.
    // This is the only place a user hears about it.
    const status = statusFor(
      'gmail',
      history({ lastDoneAt: NOW }),
      'connected',
      health({ runOutcome: 'stopped', ingestFailureCode: 'budget_exhausted', itemsFailed: 40 }),
    );
    expect(status).toMatchObject({
      state: 'connected',
      cause: 'budget_exhausted',
      itemsFailed: 40,
    });
  });

  test('the job code is used only when no run recorded one', () => {
    const unreachable = statusFor(
      'gmail',
      history({ open: 1, openAttempts: 1 }),
      'connected',
      health({ runOutcome: null, ingestFailureCode: null, jobFailureCode: 'tenant_unavailable' }),
    );
    expect(unreachable.cause).toBe('tenant_unavailable');

    // And the run's own code wins when there is one. `handler_error` beside an
    // ingest code is the runner saying "a handler threw", which is true and is
    // not the answer anybody wants.
    const refused = statusFor(
      'gmail',
      history({ open: 1, openAttempts: 1 }),
      'connected',
      health({ ingestFailureCode: 'rate_limited', jobFailureCode: 'handler_error' }),
    );
    expect(refused.cause).toBe('rate_limited');
  });
});

describe('the copy tells the user what to do, and only when there is something', () => {
  test('an expired grant is the one cause the user can fix, and it says so', () => {
    const sentence = causeSentence('auth_expired') ?? '';
    expect(sentence).toContain('Disconnecting and connecting again is the fix');
  });

  test('an exhausted cap does NOT tell them to reconnect', () => {
    // The instruction the panel used to give everybody. For this cause it costs
    // the user a re-authorization and then fails again in the same place.
    const sentence = causeSentence('budget_exhausted') ?? '';
    expect(sentence).not.toContain('connecting again');
    expect(sentence).toContain('spending cap');
  });

  test('the causes that are ours say so rather than sending the user anywhere', () => {
    for (const cause of ['tenant_unavailable', 'handler_error', 'parse_failed'] as const) {
      const sentence = causeSentence(cause) ?? '';
      expect(sentence).not.toContain('connecting again');
      expect(sentence.length).toBeGreaterThan(20);
    }
  });

  test('every code either vocabulary can produce has a sentence', () => {
    // Not a completeness ritual: an unrecognised code falls through to rendering
    // itself, and `handler_error` printed at a user is exactly the artifact this
    // change exists to remove from the page.
    for (const cause of [
      'auth_expired',
      'rate_limited',
      'provider_error',
      'parse_failed',
      'budget_exhausted',
      'cancelled',
      'attempt_timed_out',
      'lease_stolen',
      'tenant_unavailable',
      'handler_error',
    ]) {
      const sentence = causeSentence(cause) ?? '';
      expect({ cause, names: sentence.includes(cause) }).toEqual({ cause, names: false });
      expect(sentence.length).toBeGreaterThan(20);
    }
  });

  test('no cause is not a cause', () => {
    expect(causeSentence(null)).toBeNull();
  });
});

/**
 * **Three worlds, and the panel used to have one sentence for two of them.**
 *
 * A user looking at a connector that is not working needs to know which of these
 * they are in, because the three have different answers:
 *
 *   1. It failed and it will try again on its own — and roughly when.
 *   2. It stopped, because the provider will not accept our access at all, and
 *      only they can fix that.
 *   3. It tried until it ran out of attempts and gave up — and there is a button.
 *
 * Before the retry policy was made per-kind, (2) and (3) were the same row: a
 * revoked grant and a provider outage both burned the same five attempts and
 * both landed on the same copy, *"Connected, and no longer being polled … If it
 * stays like this, disconnecting and connecting again restarts the polling."*
 * That sentence was the right instruction for (2), a waste of a
 * re-authorization for (3), and — until a dead lane could be cleared at all —
 * false for both.
 *
 * The three are told apart from `control.job` alone, which is the panel's
 * standing discipline: a lane that stopped **below** its attempt budget was
 * stopped deliberately, and one that reached the budget ran out.
 */
describe('the three worlds a failing connector can be in', () => {
  test('a lane stopped below its budget reads as blocked, not as one that gave up', () => {
    const status = statusFor(
      'gmail',
      history({ deadAt: NOW, deadCode: 'handler_error', deadAttempts: 1, deadMaxAttempts: 12 }),
      'connected',
      health(),
    );
    expect(status).toMatchObject({ state: 'blocked', cause: 'auth_expired', attempts: 1 });
  });

  test('a lane that reached its budget reads as failing, and carries the count', () => {
    const status = statusFor(
      'gmail',
      history({ deadAt: NOW, deadCode: 'handler_error', deadAttempts: 12, deadMaxAttempts: 12 }),
      'connected',
      health({ ingestFailureCode: 'provider_error' }),
    );
    expect(status).toMatchObject({
      state: 'failing',
      cause: 'provider_error',
      attempts: 12,
      maxAttempts: 12,
    });
  });

  test('a retrying lane says when the next attempt is due', () => {
    // The half of "it will retry on its own" that a user actually needs. It is
    // `run_at` on the open row and nothing inferred, so the panel can only say
    // it when the queue has actually written one.
    const soon = new Date(NOW.getTime() + 30 * 60_000);
    const status = statusFor(
      'gmail',
      history({ open: 1, openAttempts: 2, openMaxAttempts: 12, openRunAt: soon }),
      'connected',
      health({ ingestFailureCode: 'provider_error' }),
    );
    expect(status).toMatchObject({
      state: 'retrying',
      nextAttemptAt: soon,
      attempts: 2,
      maxAttempts: 12,
    });
  });

  test('a healthy lane offers no attempt count and no next attempt', () => {
    const status = statusFor('gmail', history({ lastDoneAt: EARLIER }), 'connected', undefined);
    expect(status).toMatchObject({
      state: 'connected',
      nextAttemptAt: null,
      attempts: 0,
      maxAttempts: 0,
    });
  });

  test('a dead-lettered lane on a source the user removed is still not a red line', () => {
    // The `blocked` reading must not escape the link check either: a source that
    // was disconnected has no state worth alarming anybody about.
    const status = statusFor(
      'gmail',
      history({ deadAt: NOW, deadCode: 'handler_error', deadAttempts: 1, deadMaxAttempts: 12 }),
      'absent',
      health(),
    );
    expect(status).toMatchObject({ state: 'absent', cause: null });
  });
});
