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
import type { ConnectorLinkView } from '../../src/control/connector-pg.ts';
import { statusFor, type ConnectorStatus, type PullHistory } from '../../src/web/connector-panel.ts';
import { causeSentence, renderPage } from '../../src/web/pages.ts';

const NOW = new Date('2026-08-17T09:00:00.000Z');
const EARLIER = new Date(NOW.getTime() - 3_600_000);
const TWO_HOURS_AGO = new Date(NOW.getTime() - 2 * 3_600_000);
const TEN_HOURS_AGO = new Date(NOW.getTime() - 10 * 3_600_000);
const TWO_DAYS_AGO = new Date(NOW.getTime() - 48 * 3_600_000);
const LAST_WEEK = new Date(NOW.getTime() - 7 * 24 * 3_600_000);

function history(overrides: Partial<PullHistory> = {}): PullHistory {
  return {
    target: 'gmail',
    open: 0,
    openAttempts: 0,
    openMaxAttempts: 0,
    openRunAt: null,
    firstQueuedAt: LAST_WEEK,
    lastDoneAt: null,
    deadAt: null,
    deadCode: null,
    deadAttempts: 0,
    deadMaxAttempts: 0,
    ...overrides,
  };
}

/**
 * {@link statusFor} against the clock this file shares.
 *
 * The resolution rule takes a `now` because staleness is a claim about elapsed
 * time and a function that read the wall clock could not be tested for it. The
 * cases below that are not about the clock say so by not restating it; the ones
 * that are pass it explicitly.
 */
function panel(
  source: string,
  hist: PullHistory | undefined,
  link: ConnectorLinkView = 'connected',
  record: ConnectorHealthView | undefined = undefined,
): ConnectorStatus {
  return statusFor(source, hist, link, record, NOW);
}

/**
 * The page a browser gets for one source, rendered from its status.
 *
 * `kind: 'connectors'` rather than `'dashboard'`: the panel moved to its own
 * page. Nothing else in these assertions changed, which is the point — the
 * render moved, the policy did not.
 */
function dashboard(status: ConnectorStatus): string {
  return renderPage({
    kind: 'connectors',
    connectorsAvailable: true,
    connectors: [status],
  });
}

function health(overrides: Partial<ConnectorHealthView> = {}): ConnectorHealthView {
  return {
    source: 'gmail',
    lastAttemptAt: NOW,
    lastSuccessAt: null,
    runOutcome: 'failed',
    ingestFailureCode: 'auth_expired',
    ingestFailureStatus: null,
    jobFailureCode: null,
    itemsWritten: 0,
    itemsFailed: 0,
    ...overrides,
  };
}

describe('a lane that is retrying is not a lane that is checking', () => {
  test('an open row with attempts spent reads as retrying, and names the cause', () => {
    const status = panel('gmail', history({ open: 1, openAttempts: 1 }), 'connected', health());
    expect(status).toMatchObject({ state: 'retrying', cause: 'auth_expired' });
  });

  test('an open row on its first attempt still reads as checking', () => {
    // The other half of the distinction, and the reason it is `attempts` rather
    // than "is there a health record": a first check has nothing to explain, and
    // a source that failed last week and is being polled again now must not
    // wear last week's code while this attempt is still running.
    const status = panel(
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
    const status = panel(
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
      expect(panel('gmail', history({ open: 1, openAttempts: 3 }), link, health())).toMatchObject(
        { cause: null, itemsFailed: 0 },
      );
    }
  });

  test('a connector nothing has recorded reads as it did before the record existed', () => {
    // The upgrade case. A connector last polled by a fleet older than
    // `control.connector_health` has a job row and no health row, and the panel
    // must degrade to what it used to say rather than invent a reason.
    const status = panel('gmail', history({ open: 1, openAttempts: 2 }), 'connected', undefined);
    expect(status).toMatchObject({ state: 'retrying', cause: null, itemsFailed: 0 });
    expect(causeSentence(status.cause)).toBeNull();
  });

  test('a completed lane still reports what the last attempt lost', () => {
    // A `stopped` run completes its job — the cursor is held and the next tick
    // resumes it — so a poll that came back short leaves no failing lane at all.
    // This is the only place a user hears about it.
    const status = panel(
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
    const unreachable = panel(
      'gmail',
      history({ open: 1, openAttempts: 1 }),
      'connected',
      health({ runOutcome: null, ingestFailureCode: null, jobFailureCode: 'tenant_unavailable' }),
    );
    expect(unreachable.cause).toBe('tenant_unavailable');

    // And the run's own code wins when there is one. `handler_error` beside an
    // ingest code is the runner saying "a handler threw", which is true and is
    // not the answer anybody wants.
    const refused = panel(
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
      // The seventh ingest code. It is the one that must never carry the
      // reconnect instruction — the credential that failed is the fleet's own —
      // and `test/ingest/pipedream/fleet-auth.test.ts` asserts that half.
      'fleet_auth_failed',
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
    const status = panel(
      'gmail',
      history({ deadAt: NOW, deadCode: 'handler_error', deadAttempts: 1, deadMaxAttempts: 12 }),
      'connected',
      health(),
    );
    expect(status).toMatchObject({ state: 'blocked', cause: 'auth_expired', attempts: 1 });
  });

  test('a lane that reached its budget reads as failing, and carries the count', () => {
    const status = panel(
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
    const status = panel(
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

  test('a first check that has never failed is not given a next-attempt time', () => {
    // A `checking` lane has a `run_at` like any other queued row — it is when
    // the fleet may claim it, not when it will "try again". Reporting it would
    // be the `retrying`-for-`checking` confusion in a second place: a user
    // told their working first check has a retry scheduled reads that as
    // something having already gone wrong.
    const status = panel(
      'gmail',
      history({ open: 1, openAttempts: 0, openMaxAttempts: 12, openRunAt: NOW }),
      'connected',
      undefined,
    );
    expect(status).toMatchObject({ state: 'checking', nextAttemptAt: null });
  });

  test('a healthy lane offers no attempt count and no next attempt', () => {
    const status = panel('gmail', history({ lastDoneAt: EARLIER }), 'connected', undefined);
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
    const status = panel(
      'gmail',
      history({ deadAt: NOW, deadCode: 'handler_error', deadAttempts: 1, deadMaxAttempts: 12 }),
      'absent',
      health(),
    );
    expect(status).toMatchObject({ state: 'absent', cause: null });
  });
});

/**
 * **The ten-hour silence, at the surface that told the lie.**
 *
 * Every connector on a brain stopped importing for roughly ten hours and the
 * dashboard rendered as usual, because each of the three clocks a reader could
 * reach kept moving: a halted pull returns `stopped`, a stopped run is not
 * thrown on, so its job completed and `finished_at` advanced; `last_attempt_at`
 * is stamped on every attempt; and `items_failed` stayed at zero because both
 * halt paths break out of the item loop before anything is counted as lost.
 *
 * The panel read the queue, found a completed job minutes old, and printed
 * *"Connected. Last checked 12:04."* — and then suppressed the cause it was
 * holding, because that clause was gated on `itemsFailed > 0`, a counter that is
 * zero by construction on exactly the runs that need explaining.
 *
 * So these cases assert the page, not the struct. A case that asserted
 * `statusFor` returned some field would have passed while the sentence stayed
 * wrong.
 */
describe('the ten-hour silence, on the page', () => {
  /** The incident's own row: minutes since the last attempt, ten hours since the last success. */
  function silent(): ConnectorStatus {
    return statusFor(
      'gmail',
      history({ lastDoneAt: new Date(NOW.getTime() - 5 * 60_000), firstQueuedAt: LAST_WEEK }),
      'connected',
      health({
        runOutcome: 'stopped',
        ingestFailureCode: 'budget_exhausted',
        lastSuccessAt: TEN_HOURS_AGO,
        // Zero, exactly as the live row read. This is the field the old copy
        // gated the cause on.
        itemsFailed: 0,
      }),
      NOW,
    );
  }

  test('THE CASE: a connector that has imported nothing for ten hours is not rendered as connected', () => {
    const status = silent();
    // The queue still says the last job finished five minutes ago, and that is
    // true. It is simply not the question anybody was asking.
    expect(status).toMatchObject({ state: 'connected', freshness: 'stale' });

    const page = dashboard(status);
    // The sentence the page used to be, in full. If this ever matches again, the
    // ten hours are back.
    expect(page).not.toMatch(/<p>Connected\. Last checked <time[^>]*>[^<]*<\/time>\.<\/p>/);
    expect(page).toContain('Nothing has been imported since');
    expect(page).toContain(TEN_HOURS_AGO.toISOString());
  });

  test('and the cause it was holding the whole time is printed', () => {
    // The suppression, in one clause: `itemsFailed <= 0` hid the cause on
    // precisely the runs that produce no failed items. `connector_health`'s own
    // CHECK constraint says a completed run may name no cause — so a cause that
    // is present at all IS the evidence that the last run did not complete, and
    // no counter needs to agree with it.
    const page = dashboard(silent());
    expect(page).toContain('spending cap stopped the import');
  });

  test('a connector that has never once succeeded says so rather than counting from nothing', () => {
    const status = statusFor(
      'gmail',
      history({ lastDoneAt: EARLIER, firstQueuedAt: LAST_WEEK }),
      'connected',
      health({ runOutcome: 'stopped', ingestFailureCode: 'embed_unavailable', lastSuccessAt: null }),
      NOW,
    );
    expect(status.freshness).toBe('never_succeeded');
    expect(dashboard(status)).toContain('No check has ever finished importing anything');
  });

  test('a connector nothing has polled since it last worked names the fleet, not the user', () => {
    // The dead-scheduler cell. The last attempt COMPLETED, so nothing is
    // failing and there is nothing for the user to do — which is the sentence.
    const status = statusFor(
      'gmail',
      history({ lastDoneAt: TWO_DAYS_AGO, firstQueuedAt: LAST_WEEK }),
      'connected',
      health({ runOutcome: 'completed', ingestFailureCode: null, lastSuccessAt: TWO_DAYS_AGO }),
      NOW,
    );
    expect(status.freshness).toBe('unattended');
    expect(dashboard(status)).toContain('Nothing has checked this source since');
  });

  test('and the healthy page is left exactly as quiet as it was', () => {
    // The other half of the error budget. A staleness banner on a working
    // connector is how the banner stops being read, so the same render must be
    // silent when the clock is fine — including across a two-hour deploy gap,
    // which is a completed run with an old success and nothing wrong.
    const working = statusFor(
      'gmail',
      history({ lastDoneAt: EARLIER, firstQueuedAt: LAST_WEEK }),
      'connected',
      health({ runOutcome: 'completed', ingestFailureCode: null, lastSuccessAt: EARLIER }),
      NOW,
    );
    expect(working.freshness).toBe('current');
    const page = dashboard(working);
    expect(page).toContain('Connected. Last checked');
    expect(page).not.toContain('Nothing has been imported since');
    expect(page).not.toContain('class="failing"');

    const acrossADeploy = statusFor(
      'gmail',
      history({ lastDoneAt: TWO_HOURS_AGO, firstQueuedAt: LAST_WEEK }),
      'connected',
      health({ runOutcome: 'completed', ingestFailureCode: null, lastSuccessAt: TWO_HOURS_AGO }),
      NOW,
    );
    expect(acrossADeploy.freshness).toBe('current');
    expect(dashboard(acrossADeploy)).not.toContain('Nothing has been imported since');
  });

  test('a source the user disconnected is never called stale, however old its health row', () => {
    // Nothing deletes a health row on disconnect — the foreign key is to the
    // tenant, not to the link. A staleness reading that skipped the link check
    // would paint a permanent red line on a source somebody removed, with no
    // control anywhere on the page to clear it.
    const removed = statusFor(
      'gmail',
      history({ lastDoneAt: LAST_WEEK, firstQueuedAt: LAST_WEEK }),
      'absent',
      health({ runOutcome: 'stopped', lastSuccessAt: LAST_WEEK }),
      NOW,
    );
    expect(removed).toMatchObject({ state: 'absent', freshness: 'not_connected', lastSuccessAt: null });
    expect(dashboard(removed)).not.toContain('Nothing has been imported since');
  });
});
