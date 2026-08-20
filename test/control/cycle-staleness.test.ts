/**
 * The detection rule, and the days it was written for.
 *
 * **The incident.** One brain's consolidation froze — 5,608 pages, 167 facts,
 * flat for days — and nothing anywhere said so. Not a banner, not a non-200, not
 * a queue row out of place. A cycle ran on the ceiling every day, stopped short
 * in a phase, banked its reason, left its run open and *returned*; and a cycle
 * that returns completes its job. So `control.job` read `state: done, attempts:
 * 1, failure_code: NULL` on every pass, and `queue.complete()` stamped
 * `control.tenant.last_cycle_at` and `next_due_at` in the same transaction. On
 * the live control plane during the freeze the frozen brain's `last_cycle_at`
 * was five and a half hours old and a *healthy* canary's was eight — the frozen
 * one looked better.
 *
 * The one thing that stood still was the instant a cycle last *closed*, and
 * nothing read it.
 *
 * So the case that matters most in this file is the first one below, named after
 * the incident: *the frozen brain* — cycles returning constantly, every job
 * done with no failure code, and no completion for days. Every clock but one
 * calls it healthy. This rule calls it `stale`.
 *
 * **The other half of the error budget is here too.** A rule that only avoided
 * false negatives would be a rule somebody mutes, so the quiet cases are pinned
 * by name: a cycle in flight right now (an open run banks no reason, and reading
 * that as a failure would flip every brain in the fleet to `slipping` every day
 * it worked); a free-tier brain, whose cycles finish at `free_tier` and would
 * otherwise be permanently stale; a brain still on its first consolidation; and
 * a fleet whose completions are simply not visible from where the reading is
 * taken.
 */

import { describe, expect, test } from 'bun:test';

import {
  CYCLE_PERIOD_SECONDS,
  controlPlaneCycleFreshness,
  cycleFreshnessOf,
  fleetCycleVerdict,
  isAlarming,
  isCompletion,
  staleAfterSeconds,
  unattendedAfterSeconds,
  type CycleFreshness,
} from '../../src/control/cycle-staleness.ts';
import type { StopReason } from '../../src/worker/consolidate/checkpoint.ts';
import { ALPHA_CEILING_MS, ALPHA_SCHEDULER } from '../../src/worker/scheduler.ts';

const NOW = new Date('2026-08-20T01:24:13.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

/**
 * One brain's cycle history, with the interesting field per case overridden.
 *
 * `cyclingSince` defaults to a month back: every case here is about a brain that
 * has been around long enough for the first-completion grace to have expired,
 * except the two that are about the grace.
 */
function brain(overrides: {
  readonly lastCompleteCycleAt?: Date | null;
  readonly latestStopReason?: StopReason | null;
  readonly cycled?: boolean;
  readonly cyclingSince?: Date | null;
}) {
  const cycled = overrides.cycled ?? true;
  return {
    completion: cycled
      ? {
          lastCompleteCycleAt:
            overrides.lastCompleteCycleAt === undefined ? ago(HOUR) : overrides.lastCompleteCycleAt,
          latestStopReason:
            overrides.latestStopReason === undefined ? ('complete' as const) : overrides.latestStopReason,
        }
      : undefined,
    cyclingSince: overrides.cyclingSince === undefined ? ago(30 * DAY) : overrides.cyclingSince,
    now: NOW,
  };
}

describe('the clock the rule measures from', () => {
  test('the period is the scheduler ceiling, and drift between them is a failure here', () => {
    // Declared rather than imported, so that reading one number does not pull
    // the schema sweep into the web fleet's bundle. This is the guard the import
    // would have been.
    expect(CYCLE_PERIOD_SECONDS * 1000).toBe(ALPHA_CEILING_MS);
    expect(ALPHA_SCHEDULER.ceilingMs).toBe(ALPHA_CEILING_MS);
  });

  test('only the two stop reasons that close a run count as completions', () => {
    expect(isCompletion('complete')).toBe(true);
    // The one that would otherwise put every free brain in the fleet in `stale`
    // forever. `finishRun` closes a `free_tier` run exactly as it closes
    // `complete`; the cycle did everything the plan asks of it.
    expect(isCompletion('free_tier')).toBe(true);
    for (const reason of ['budget_exhausted', 'phase_failed', 'cancelled', 'out_of_time'] as const) {
      expect(isCompletion(reason)).toBe(false);
    }
  });
});

describe('the frozen brain', () => {
  /**
   * The incident, replayed. Cycles returned every day for days — so every job
   * was `done`, every `failure_code` NULL, every `attempts` 1, and
   * `last_cycle_at` was hours fresh the whole time. The only fact that says
   * anything is that nothing closed a run.
   */
  test('cycles returning constantly with no completion for days is stale', () => {
    const report = cycleFreshnessOf(
      brain({ latestStopReason: 'phase_failed', lastCompleteCycleAt: ago(6 * DAY) }),
    );
    expect(report.state).toBe('stale');
    expect(isAlarming(report.state)).toBe(true);
  });

  test('and one frozen brain decides the fleet verdict', () => {
    const fleet: CycleFreshness[] = ['current', 'current', 'slipping', 'stale', 'current'];
    expect(fleetCycleVerdict(fleet)).toBe('stalled');
  });

  test('every stop the brain did not choose reaches it, not just the one that happened', () => {
    // The freeze was `phase_failed`. An attempt clock that runs out every cycle
    // and a cancellation loop are the same failure to a reader of this brain:
    // nothing is finishing, and nothing about it was asked for.
    for (const reason of ['phase_failed', 'cancelled', 'out_of_time'] as const) {
      const report = cycleFreshnessOf(
        brain({ latestStopReason: reason, lastCompleteCycleAt: ago(6 * DAY) }),
      );
      expect(report.state).toBe('stale');
    }
  });

  test('a spend cap is not a freeze, however long it has been held', () => {
    // The one reason above that the OWNER chose. The cap is a rolling 30-day
    // figure, so a cap reached on day 3 stops every cycle for the remaining ~24
    // — folding that into `stale` paints a brain doing exactly what it was
    // configured to do as a multi-day emergency for most of the billing window,
    // which is the alarm somebody mutes. Not alarming, and not silent: it has
    // its own reading, its own sentence on the coverage page, and it warns the
    // fleet rather than paging it.
    const report = cycleFreshnessOf(
      brain({ latestStopReason: 'budget_exhausted', lastCompleteCycleAt: ago(26 * DAY) }),
    );
    expect(report.state).toBe('capped');
    expect(isAlarming(report.state)).toBe(false);
    expect(fleetCycleVerdict(['current', report.state])).toBe('degraded');
    // And it is still measured against the same clock it would have been judged
    // by — the split is the reason, never a second threshold.
    expect(report.lastCompleteCycleAt).toEqual(ago(26 * DAY));
  });

  test('a cap inside the window is still only slipping, the same as any other stop', () => {
    // The split happens at the far end only. One capped cycle over a healthy
    // completion is the ordinary Tuesday `slipping` exists for, and giving the
    // cap its own reading there would mean two names for one state.
    expect(
      cycleFreshnessOf(
        brain({ latestStopReason: 'budget_exhausted', lastCompleteCycleAt: ago(6 * HOUR) }),
      ).state,
    ).toBe('slipping');
  });

  test('the threshold is stated in the report rather than left to be guessed', () => {
    const report = cycleFreshnessOf(
      brain({ latestStopReason: 'phase_failed', lastCompleteCycleAt: ago(6 * DAY) }),
    );
    expect(report.staleAfterSeconds).toBe(staleAfterSeconds());
    expect(report.lastCompleteCycleAt).toEqual(ago(6 * DAY));
  });
});

describe('quiet when healthy, which is the half that keeps it read', () => {
  test('a brain that completed last night is current', () => {
    expect(cycleFreshnessOf(brain({ latestStopReason: 'complete' })).state).toBe('current');
  });

  test('a free-tier brain that finished its half is current, not stale', () => {
    // Free brains never run the model phases and their cycles stop at
    // `free_tier`. A rule that read that as a failure would report the entire
    // free population as frozen, permanently, from the day it shipped.
    expect(cycleFreshnessOf(brain({ latestStopReason: 'free_tier' })).state).toBe('current');
  });

  test('a cycle in flight banks no reason, and that is not a failure', () => {
    // An open run with a NULL `stop_reason` is a cycle running right now or a
    // cycle killed before it could write, and nothing distinguishes them. If
    // NULL fell into the stopped-short branch every brain in the fleet would
    // read `slipping` for the duration of every cycle it ever ran, and the
    // degraded level would mean nothing.
    expect(
      cycleFreshnessOf(brain({ latestStopReason: null, lastCompleteCycleAt: ago(2 * HOUR) })).state,
    ).toBe('current');
  });

  test('one stopped cycle over a healthy completion is slipping, and is not paged for', () => {
    const report = cycleFreshnessOf(
      brain({ latestStopReason: 'out_of_time', lastCompleteCycleAt: ago(6 * HOUR) }),
    );
    expect(report.state).toBe('slipping');
    expect(isAlarming(report.state)).toBe(false);
    expect(fleetCycleVerdict(['current', report.state])).toBe('degraded');
  });

  test('a resume chain inside two ceilings is still only slipping', () => {
    // A first consolidation of a large brain stops on `out_of_time`, and the
    // next cycle picks up where it left off through the per-row consideration
    // stamps rather than through the run, which closed. Because the settle path
    // is outcome-blind that chain reschedules at the full ceiling each time. Two
    // ceilings of that is a brain converging, not a brain frozen.
    const report = cycleFreshnessOf(
      brain({ latestStopReason: 'out_of_time', lastCompleteCycleAt: ago(2 * DAY) }),
    );
    expect(report.state).toBe('slipping');
  });

  test('a brain scheduled on the ceiling is current the whole day between cycles', () => {
    // `ALPHA_SCHEDULER` re-enqueues a day after the last cycle whatever the debt
    // does, so 23h59m since the last completion is the ordinary healthy state of
    // every quiet brain in the fleet.
    expect(
      cycleFreshnessOf(
        brain({ latestStopReason: 'complete', lastCompleteCycleAt: ago(DAY - 60_000) }),
      ).state,
    ).toBe('current');
  });

  test('an empty fleet is ok', () => {
    expect(fleetCycleVerdict([])).toBe('ok');
  });
});

describe('a new brain is not a stopped one', () => {
  test('a brain still on its first consolidation is starting, not never_completed', () => {
    const report = cycleFreshnessOf(
      brain({
        lastCompleteCycleAt: null,
        latestStopReason: 'out_of_time',
        cyclingSince: ago(2 * DAY),
      }),
    );
    expect(report.state).toBe('starting');
    expect(isAlarming(report.state)).toBe(false);
  });

  test('a brain that has been cycling for a month and never once finished is an alarm', () => {
    const report = cycleFreshnessOf(
      brain({ lastCompleteCycleAt: null, latestStopReason: 'phase_failed' }),
    );
    // Distinct from `stale` on purpose: "it stopped finishing" and "it has never
    // once finished" have different remedies.
    expect(report.state).toBe('never_completed');
    expect(isAlarming(report.state)).toBe(true);
  });

  test('an unknown start is read as expired rather than as young', () => {
    // On the surface whose job is to notice, "I cannot tell how long this has
    // been trying" must not answer "so assume it just started".
    expect(
      cycleFreshnessOf(
        brain({ lastCompleteCycleAt: null, latestStopReason: 'phase_failed', cyclingSince: null }),
      ).state,
    ).toBe('never_completed');
  });

  test('a brain no cycle has ever started against is uncycled, and makes no claim', () => {
    const report = cycleFreshnessOf(brain({ cycled: false, cyclingSince: null }));
    // Not alarming here, and the reason is a limit rather than a judgement: the
    // tenant database holds no "ready since" clock, so this surface cannot say
    // how long the silence has lasted. `controlPlaneCycleFreshness` can, and
    // does.
    expect(report.state).toBe('uncycled');
    expect(isAlarming(report.state)).toBe(false);
  });
});

describe('the scheduler stopping is its own reading', () => {
  test('a completed cycle that is nevertheless ancient is unattended', () => {
    const report = cycleFreshnessOf(
      brain({ latestStopReason: 'complete', lastCompleteCycleAt: ago(5 * DAY) }),
    );
    // Nothing is failing — nothing has run. A completed newest cycle whose
    // completion is old *is* "nothing has consolidated this brain since", and no
    // second clock is needed to see it.
    expect(report.state).toBe('unattended');
    expect(isAlarming(report.state)).toBe(true);
  });

  test('a paused fleet inside the wider ceiling does not page', () => {
    // The cell a long deploy freeze lands in. Wider than `stale` deliberately:
    // paging on a holiday weekend is how an alert gets muted.
    expect(
      cycleFreshnessOf(
        brain({ latestStopReason: 'complete', lastCompleteCycleAt: ago(3 * DAY + HOUR) }),
      ).state,
    ).toBe('current');
    expect(unattendedAfterSeconds()).toBeGreaterThan(staleAfterSeconds());
  });

  test('a crash loop that never banks a reason still surfaces', () => {
    // A cycle killed before it can write leaves a NULL reason forever. Judged on
    // completion age alone it reaches `unattended` rather than `stale` — a
    // slightly less specific sentence, and still an alarm, which is the property
    // that matters.
    const report = cycleFreshnessOf(
      brain({ latestStopReason: null, lastCompleteCycleAt: ago(9 * DAY) }),
    );
    expect(isAlarming(report.state)).toBe(true);
  });
});

describe('what the control plane can honestly say, which is less', () => {
  function tenant(overrides: {
    readonly tenantState?: string;
    readonly lastReturnAt?: Date | null;
    readonly readySince?: Date | null;
  }) {
    return {
      tenantState: overrides.tenantState ?? 'ready',
      lastReturnAt: overrides.lastReturnAt === undefined ? ago(5 * HOUR) : overrides.lastReturnAt,
      readySince: overrides.readySince === undefined ? ago(30 * DAY) : overrides.readySince,
      now: NOW,
    };
  }

  test('the frozen brain reads unobserved from the control plane, and never stale', () => {
    // The whole point, stated as a test. These are the frozen brain's real
    // control-plane numbers from during the freeze: `state: ready`, a
    // `last_cycle_at` five and a half hours old. Nothing in `control.tenant` or
    // `control.job` distinguishes it from a brain that is completing every
    // cycle, so the honest answer is to decline rather than to guess green.
    const state = controlPlaneCycleFreshness(tenant({ lastReturnAt: ago(5 * HOUR + 29 * 60_000) }));
    expect(state).toBe('unobserved');
    expect(isAlarming(state)).toBe(false);
  });

  test('a fleet the control plane cannot see into answers ok, not a permanent yellow', () => {
    // A verdict that never goes green is a verdict nobody reads, which is the
    // state that produced the days of silence. The `unobserved` count published
    // beside it is what tells an operator the difference.
    expect(fleetCycleVerdict(['unobserved', 'unobserved', 'unobserved'])).toBe('ok');
  });

  test('what it CAN see is that nothing has returned at all', () => {
    // The one cell `last_cycle_at` answers truthfully. It is an attempt clock,
    // exactly like `connector_health.last_attempt_at` — useless for "is this
    // healthy", conclusive for "has anything even run".
    expect(controlPlaneCycleFreshness(tenant({ lastReturnAt: ago(9 * DAY) }))).toBe('unattended');
    expect(controlPlaneCycleFreshness(tenant({ lastReturnAt: null }))).toBe('unattended');
  });

  test('a brain that has just been provisioned is graced', () => {
    expect(
      controlPlaneCycleFreshness(tenant({ lastReturnAt: null, readySince: ago(2 * HOUR) })),
    ).toBe('uncycled');
  });

  test('a tenant that is not ready is not a fault', () => {
    for (const state of ['provisioning', 'failed', 'deleting']) {
      expect(controlPlaneCycleFreshness(tenant({ tenantState: state, lastReturnAt: null }))).toBe(
        'not_ready',
      );
    }
  });
});
