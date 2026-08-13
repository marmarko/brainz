/**
 * The free→paid prompt, bounded.
 *
 * **Why this is a module and not three lines in the handler.** `briefing` is
 * what a client scheduled task pulls every morning (KTD12, R21). An
 * unconditional upgrade prompt therefore fires 365 times a year on the flagship
 * read, which is how a knowledge product becomes an ad. So the prompt is bounded
 * the way U17's self-export nag is: **once per debt-threshold crossing, or once
 * per {@link PROMPT_INTERVAL_DAYS} days, with a stated dismissal.**
 *
 * The band is what makes the crossing rule real. Prompting whenever
 * `pendingDebt >= threshold` looks bounded and fires every morning forever; what
 * is stored is the *band the user was last prompted at*, and a prompt needs a
 * band strictly above it. Debt accruing inside one band is silence.
 *
 * **It reads `pending_debt` and never a contradiction count.** R8 is explicit
 * about the reason, and it is not squeamishness: contradictions are a model-phase
 * artifact, the free tier runs the deterministic phases only, so a
 * contradiction-gated prompt renders empty for exactly the tier it exists to
 * convert. {@link PromptInput} has nowhere to put one, which makes that
 * structural rather than remembered.
 *
 * **What it surfaces instead is R12a's reachable path.** The pending-review and
 * uncorroborated-claim counts travel with the prompt, because R12a's
 * "corroborated by the user" leg needs somewhere a user can see that there is
 * something to corroborate. A restatement through `remember` marks a claim
 * restated and clears nothing on its own — the review entry closes on an
 * out-of-band action — but a claim nobody knows about gets neither.
 */

/** The rungs a crossing is measured against. Ascending, first above zero. */
export const DEBT_THRESHOLDS: readonly number[] = [10, 50, 250, 1000];

/** The other way through: a fortnight, so a monthly reader sees it at most once. */
export const PROMPT_INTERVAL_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The band a debt count sits in: the largest threshold it has reached, or zero.
 *
 * Zero is "below the first rung", which is not a band — nothing is prompted
 * there. It is a number rather than an index so the stored value survives a
 * change to the ladder: adding a rung between two existing ones cannot silently
 * re-prompt everybody who was last shown at the higher one.
 */
export function bandOf(pendingDebt: number): number {
  if (!Number.isFinite(pendingDebt)) return 0;
  let band = 0;
  for (const threshold of DEBT_THRESHOLDS) {
    if (pendingDebt >= threshold) band = threshold;
  }
  return band;
}

export interface PromptState {
  /** ISO timestamp of the last prompt, or `null` if this caller has never seen one. */
  readonly lastShownAt: string | null;
  /** The band it was shown at. Zero when it has never been shown. */
  readonly lastShownDebt: number;
}

export interface PromptInput {
  /**
   * The tier of the most recent completed cycle, or `null` when none has run.
   *
   * `null` counts as free: a brain that has never consolidated has never had the
   * paid phases run over it, which is the state the prompt is about. A paid
   * tenant is never prompted, however much backlog they are carrying — that is
   * the failure the bound exists to prevent, arriving through a different door.
   */
  readonly tier: 'free' | 'paid' | null;
  /** R8's deterministic counter: items awaiting extraction and the checks after it. */
  readonly pendingDebt: number;
  readonly pendingReview: number;
  readonly uncorroboratedClaims: number;
  readonly state: PromptState;
  readonly now: Date;
}

export interface UpgradePrompt {
  readonly kind: 'upgrade';
  readonly reason: 'debt_threshold' | 'interval';
  /** The band this prompt was shown at, to be stored against the caller. */
  readonly threshold: number;
  readonly pendingDebt: number;
  readonly pendingReview: number;
  readonly uncorroboratedClaims: number;
  readonly text: string;
  readonly dismissal: string;
}

function textFor(input: PromptInput): string {
  const parts = [
    `${input.pendingDebt} items are waiting on the phases this brain does not run yet: ` +
      'extraction, participant cards, commitments and the checks over them.',
  ];
  if (input.pendingReview > 0) {
    parts.push(
      `${input.pendingReview} proposals are waiting on a decision only you can make, in the app.`,
    );
  }
  if (input.uncorroboratedClaims > 0) {
    parts.push(
      `${input.uncorroboratedClaims} claims came in from outside and nothing you wrote vouches for them yet — ` +
        'saying one back through `remember` marks it restated, which is what a person can do about it from here.',
    );
  }
  return parts.join(' ');
}

/**
 * Whether to prompt, and what with. `null` is the ordinary answer.
 *
 * Pure: the clock, the counters and the stored state all arrive as values, so
 * the bound is testable without waiting a fortnight.
 */
export function upgradePrompt(input: PromptInput): UpgradePrompt | null {
  if (input.tier === 'paid') return null;

  const band = bandOf(input.pendingDebt);
  // Nothing to convert on. The interval rule does not resurrect a prompt for a
  // brain with no backlog — an empty nag on a schedule is the purest form of
  // the thing this module refuses.
  if (band === 0) return null;

  const shownBand = bandOf(input.state.lastShownDebt);
  const crossed = band > shownBand;

  const lastShownAt = input.state.lastShownAt === null ? null : Date.parse(input.state.lastShownAt);
  const elapsed =
    lastShownAt === null || !Number.isFinite(lastShownAt)
      ? Number.POSITIVE_INFINITY
      : input.now.getTime() - lastShownAt;
  const due = elapsed >= PROMPT_INTERVAL_DAYS * DAY_MS;

  if (!crossed && !due) return null;

  return {
    kind: 'upgrade',
    reason: crossed ? 'debt_threshold' : 'interval',
    threshold: band,
    pendingDebt: input.pendingDebt,
    pendingReview: input.pendingReview,
    uncorroboratedClaims: input.uncorroboratedClaims,
    text: textFor(input),
    dismissal:
      `This appears at most once every ${PROMPT_INTERVAL_DAYS} days, and once more only if the backlog ` +
      'crosses the next mark. Turn it off for good in the app.',
  };
}
