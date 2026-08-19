/**
 * Whether a connector is importing, and the one clock that can answer.
 *
 * **The failure this closes.** Every connector on a brain stopped importing for
 * roughly ten hours and nothing surfaced it — no banner, no non-200, no queue
 * row out of place. The mechanism is worth stating exactly, because every
 * cheaper rule than this one is a rule that would have missed it:
 *
 *   * A pull that halts mid-run returns `outcome: 'stopped'`, and a `stopped`
 *     run is deliberately **not** thrown on — its cursor is held and the next
 *     tick resumes it (`src/ingest/pipedream/pull.ts`). So the job completes.
 *   * `control.connector_health.last_attempt_at` is stamped on every attempt,
 *     success or failure. It stayed minutes fresh for ten hours.
 *   * `items_failed` stayed at **zero**: both halt paths break out of the item
 *     loop before anything is counted as lost.
 *   * `control.job` therefore held no dead rows, no failure codes, and a fresh
 *     `finished_at`.
 *
 * Only `last_success_at` stood still, and nothing read it. So this module reads
 * that and only that, and the type it is handed is deliberately too narrow to
 * carry an attempt time — {@link ConnectorAttemptState} has no `lastAttemptAt`
 * field, so a later edit cannot quietly start measuring from the clock that
 * lied.
 *
 * **The rule is a cross-product, not a severity ladder, and the conjunction is
 * load-bearing.** Two independent facts decide it: did the *latest* attempt
 * complete, and how long ago was the *last success*.
 *
 *                        | outcome = completed | outcome ≠ completed
 *     ---------------------------------------------------------------------
 *      success recent    | current             | slipping
 *      success old       | unattended*         | stale        ← the incident
 *      success never     | (not storable)      | starting / never_succeeded
 *
 * `unattended*` is the cell that keeps this rule usable. A fleet restart leaves
 * a gap of up to two hours with `run_outcome = 'completed'` still on the row —
 * nothing failed, nothing was even attempted — and a rule that called that
 * `stale` would page on every deploy until the page stopped being read. It only
 * becomes an alarm at the wider ceiling, where it is the one signature a
 * success-only reading catches and cannot name any other way: the scheduler
 * itself stopped. (A completed run stamps both clocks with the same instant, so
 * an old success under a completed outcome *is* "nothing has attempted this
 * since" — no second clock is needed to see it.)
 *
 * **Thresholds are multiples of a poll period, and the period is not the
 * cadence.** `cursor.ts` declares gmail at five minutes, but the worker fleet is
 * woken by a half-hourly cron, so five minutes is a cadence that never happens.
 * The effective period is `max(cadence, wake)`, and a threshold derived from the
 * declared number alone would report every healthy gmail connector as stale,
 * every night.
 *
 * **Nothing here is content.** Every input is a code, a count or an instant and
 * every output is a label from a closed set — the rule `ConnectorHealthView`
 * already lives by, which is what lets the same function decide a user's banner
 * and an operator's fleet verdict without either surface holding a tenant
 * handle.
 */

import { DEFAULT_CADENCE_SECONDS } from '../ingest/cursor.ts';
import type { PullOutcome } from '../ingest/pipedream/pull.ts';
import type { ConnectorLinkView } from './connector-pg.ts';

/**
 * How often a connector is *actually* polled, at best.
 *
 * `wrangler.toml` wakes the worker fleet on a half-hourly cron and the container
 * sheds after five idle minutes, so no source is polled more often than this
 * whatever its cadence says. It is the floor under every threshold below.
 */
export const WAKE_PERIOD_SECONDS = 1800;

/**
 * Missed polls before a connector is called stale, and before it is called
 * unattended.
 *
 * Three periods (ninety minutes at today's wake) is the alarm, and it cost
 * nothing against the measured population: of every observed gap between
 * consecutive pull attempts, 99.3% were inside ninety minutes and the only two
 * that were not were fleet restarts — which land in `unattended`, never in
 * `stale`, because their outcome is still `completed`.
 *
 * Six periods (three hours) is the ceiling for the unattended cell, chosen the
 * same way: the widest healthy gap ever measured was two hours and twenty
 * minutes, so nothing that has ever worked reaches it.
 */
export const STALE_PERIODS = 3;
export const UNATTENDED_PERIODS = 6;

/**
 * How long a connector that has never succeeded is given before it is an alarm.
 *
 * The first poll runs on the worker fleet's next wake, and a first import can
 * legitimately stop on a spend cap. Without this window every new connect would
 * flip the fleet verdict for its first half hour — a monitor that cries wolf
 * every signup is a monitor somebody turns off, which is how the ten hours
 * happen again.
 */
export const FIRST_SUCCESS_GRACE_PERIODS = 2;

function periodFor(source: string): number {
  const cadence = (DEFAULT_CADENCE_SECONDS as Readonly<Record<string, number | undefined>>)[source];
  // An unknown source gets the wake period rather than zero. A missing cadence
  // must not become a zero-second threshold that reports every connector of that
  // kind as stale forever — the fail-safe direction here is the quiet one,
  // because the loud one would be permanent.
  return Math.max(cadence ?? WAKE_PERIOD_SECONDS, WAKE_PERIOD_SECONDS);
}

export function pollPeriodSeconds(source: string): number {
  return periodFor(source);
}

export function staleAfterSeconds(source: string): number {
  return periodFor(source) * STALE_PERIODS;
}

export function unattendedAfterSeconds(source: string): number {
  return periodFor(source) * UNATTENDED_PERIODS;
}

export function firstSuccessGraceSeconds(source: string): number {
  return periodFor(source) * FIRST_SUCCESS_GRACE_PERIODS;
}

/**
 * What the seven readings mean, and which of them anybody is paged for.
 *
 *  * `current` — a success inside its window, and the last attempt completed.
 *  * `slipping` — a success inside its window, and the last attempt did **not**
 *    complete. The early warning: one refused poll, which is an ordinary
 *    Tuesday and resolves itself on the next tick. Not an alarm, and not a
 *    banner — but the cause is worth showing, because it is the sentence that
 *    tells a user their spend cap is holding their mail.
 *  * `stale` — no success inside its window, and the last attempt did not
 *    complete. **The incident.** Something has been refusing this connector for
 *    longer than any healthy gap.
 *  * `unattended` — the last attempt completed, and it was long enough ago that
 *    nothing has polled this source since. The scheduler's own failure.
 *  * `never_succeeded` — it has been attempted and has never once worked, past
 *    the grace. Distinct from `stale` on purpose: "it failed since March" and
 *    "it has never worked" are different emergencies and have different
 *    remedies.
 *  * `starting` — the same row, inside the grace. Not yet a claim either way.
 *  * `unpolled` — connected, and no attempt has ever been recorded.
 *  * `not_connected` — decided from the link alone, before any health row is
 *    consulted.
 */
export type ConnectorFreshness =
  | 'current'
  | 'slipping'
  | 'stale'
  | 'unattended'
  | 'never_succeeded'
  | 'starting'
  | 'unpolled'
  | 'not_connected';

/**
 * The last attempt, reduced to the two fields that decide anything.
 *
 * **There is no `lastAttemptAt` here and that is the point.** Every failing run
 * during the incident advanced it, so a rule that could see it is a rule that
 * could be rewritten to measure from it. `ConnectorHealthView` satisfies this
 * type structurally, so the panel passes its health record straight in.
 */
export interface ConnectorAttemptState {
  readonly lastSuccessAt: Date | null;
  readonly runOutcome: PullOutcome | null;
}

export interface ConnectorFreshnessInput {
  readonly source: string;
  /** Read first, and alone: a health row outlives a disconnect. See below. */
  readonly link: ConnectorLinkView;
  /** Absent means nothing has ever recorded an attempt for this source. */
  readonly attempt: ConnectorAttemptState | undefined;
  /**
   * Roughly when this source started being polled — the link's `created_at`
   * fleet-side, the first `ingest_pull` row's `created_at` on the dashboard.
   *
   * Only ever used to decide whether a connector that has never succeeded is
   * still inside its first window. `null` is read as *expired*, not as *young*:
   * "I cannot tell how long this has been trying" must not answer "so assume it
   * just started" on the surface whose whole job is to notice.
   */
  readonly attemptingSince: Date | null;
  readonly now: Date;
}

export interface ConnectorFreshnessReport {
  readonly source: string;
  readonly state: ConnectorFreshness;
  /** Echoed so a caller can render the clock it was judged against. */
  readonly lastSuccessAt: Date | null;
  /** The threshold applied, so a surface can say what it used rather than guess. */
  readonly staleAfterSeconds: number;
}

/** The readings an operator is paged for. `slipping` is deliberately not one. */
const ALARMING: ReadonlySet<ConnectorFreshness> = new Set<ConnectorFreshness>([
  'stale',
  'unattended',
  'never_succeeded',
]);

export function isAlarming(state: ConnectorFreshness): boolean {
  return ALARMING.has(state);
}

function elapsedSeconds(from: Date, now: Date): number {
  return (now.getTime() - from.getTime()) / 1000;
}

/**
 * The rule. Pure, so a mutation to it fails a case rather than a fleet.
 *
 * **The link is read first and the health row second.** Nothing deletes a health
 * record on disconnect — its foreign key is to the tenant, not to the link — so
 * a source somebody removed in March keeps an ancient `last_success_at` forever.
 * A rule that started from the health row would report it as stalled for the
 * rest of the fleet's life, the alert would be muted, and the surface would be
 * worse than none. It is the same gate the dashboard panel already applies to a
 * dead lane, for the same reason.
 */
export function freshnessOf(input: ConnectorFreshnessInput): ConnectorFreshnessReport {
  const staleAfter = staleAfterSeconds(input.source);
  const report = (state: ConnectorFreshness, lastSuccessAt: Date | null = null) => ({
    source: input.source,
    state,
    lastSuccessAt,
    staleAfterSeconds: staleAfter,
  });

  if (input.link !== 'connected') return report('not_connected');
  if (input.attempt === undefined) {
    // **Graced, not exempt.** This branch used to return `unpolled`
    // unconditionally, and `unpolled` is not in `ALARMING` — so a connected link
    // with no health row read green forever, with no threshold and no expiry. A
    // whole fleet in that state answered `ok`, which is the exact silence this
    // module exists to end: nothing had ever polled any of it, and nothing said
    // so.
    //
    // Past its first window it is `unattended`, which is the reading it deserves
    // — not "this connector failed" but "nothing is attending this connector",
    // the dead-scheduler signature. `attemptingSince === null` is read as
    // expired here for the reason the field's own doc gives: on the surface
    // whose job is to notice, "I cannot tell how long this has been waiting"
    // must not answer "so assume it just started".
    const waiting =
      input.attemptingSince === null
        ? Number.POSITIVE_INFINITY
        : elapsedSeconds(input.attemptingSince, input.now);
    return report(waiting <= firstSuccessGraceSeconds(input.source) ? 'unpolled' : 'unattended');
  }

  const { lastSuccessAt, runOutcome } = input.attempt;

  if (lastSuccessAt === null) {
    // Attempted, never once succeeded. Inside the first window this is a
    // connector still finding its feet; past it, it is a connector that has
    // never worked, which no elapsed-time reading of a success clock can say
    // because there is no success to measure from.
    const grace = firstSuccessGraceSeconds(input.source);
    const started =
      input.attemptingSince === null ? Number.POSITIVE_INFINITY : elapsedSeconds(input.attemptingSince, input.now);
    return report(started <= grace ? 'starting' : 'never_succeeded', null);
  }

  const since = elapsedSeconds(lastSuccessAt, input.now);

  if (runOutcome === 'completed') {
    // Nothing is failing. Either it worked recently, or nothing has tried since
    // it worked — and the second of those only becomes an alarm at the wider
    // ceiling, because up to two hours of it is an ordinary deploy.
    return report(
      since > unattendedAfterSeconds(input.source) ? 'unattended' : 'current',
      lastSuccessAt,
    );
  }

  // The last attempt did not complete. Whether that is an ordinary refused poll
  // or the incident is decided by the success clock and by nothing else.
  return report(since > staleAfter ? 'stale' : 'slipping', lastSuccessAt);
}

/**
 * One field a monitor can page on, folded from many connectors.
 *
 * Three levels rather than a boolean, so the external rule can be *warn on
 * `degraded`, page on `stalled`* rather than a JSON walk. Monotone: the worst
 * connector decides, because a fleet with one dead brain in it is not a healthy
 * fleet with a rounding error.
 *
 * **An empty fleet is `ok`, deliberately.** Health is a claim about a thing that
 * is supposed to be running; there is no thing. A verdict that read `unknown`
 * for a fleet with no connectors would be permanently non-green, and a monitor
 * that is always yellow is a monitor that is off — which is the state that
 * produced the ten hours. The counts published beside it are what tell an empty
 * fleet from a broken one.
 */
export type FleetConnectorVerdict = 'ok' | 'degraded' | 'stalled';

export function fleetConnectorVerdict(
  states: Iterable<ConnectorFreshness>,
): FleetConnectorVerdict {
  let verdict: FleetConnectorVerdict = 'ok';
  for (const state of states) {
    if (isAlarming(state)) return 'stalled';
    if (state === 'slipping') verdict = 'degraded';
  }
  return verdict;
}
