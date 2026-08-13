/**
 * The free→paid prompt, and the one property that makes it a product rather
 * than a daily sales pitch: **it is bounded**.
 *
 * `briefing` is what a scheduled task pulls every morning (KTD12/R21). An
 * unconditional upgrade prompt therefore fires 365 times a year on the flagship
 * read. U12's rule is U17's self-export nag: once per debt-threshold crossing,
 * or once per N days, with a stated dismissal.
 *
 * **The trap this file is written against.** A bound test passes trivially if
 * the threshold is only ever crossed once — every implementation looks bounded
 * on a single crossing. So the sequence below crosses a threshold, *accrues more
 * debt inside the same band*, and asserts silence; then crosses the next band
 * and asserts exactly one more prompt. The middle assertion is the whole test.
 *
 * **And it reads `pending_debt`, never the contradiction count.** R8 is explicit
 * about why: contradictions are a model-phase artifact the free tier by
 * construction cannot produce, so a contradiction-count prompt renders empty for
 * exactly the tier it exists to convert. The structural half of that guard is
 * that {@link PromptInput} has nowhere to put a contradiction count; the
 * behavioural half is `assemble.test.ts`, where a brain full of contradictions
 * and no debt produces no prompt.
 */

import { describe, expect, test } from 'bun:test';

import {
  DEBT_THRESHOLDS,
  PROMPT_INTERVAL_DAYS,
  bandOf,
  upgradePrompt,
  type PromptInput,
  type PromptState,
} from '../../src/core/briefing/prompt.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date('2026-08-13T09:00:00.000Z');

const FRESH: PromptState = { lastShownAt: null, lastShownDebt: 0 };

function ask(overrides: Partial<PromptInput> = {}): ReturnType<typeof upgradePrompt> {
  return upgradePrompt({
    tier: 'free',
    pendingDebt: 0,
    pendingReview: 0,
    uncorroboratedClaims: 0,
    state: FRESH,
    now: START,
    ...overrides,
  });
}

describe('the thresholds are a ladder', () => {
  test('they are ascending and start above zero', () => {
    expect(DEBT_THRESHOLDS.length).toBeGreaterThan(1);
    expect(DEBT_THRESHOLDS[0]).toBeGreaterThan(0);
    for (let i = 1; i < DEBT_THRESHOLDS.length; i += 1) {
      expect(DEBT_THRESHOLDS[i]!).toBeGreaterThan(DEBT_THRESHOLDS[i - 1]!);
    }
  });

  test('a band is the largest threshold the debt has reached, and zero below the first', () => {
    expect(bandOf(0)).toBe(0);
    expect(bandOf(DEBT_THRESHOLDS[0]! - 1)).toBe(0);
    expect(bandOf(DEBT_THRESHOLDS[0]!)).toBe(DEBT_THRESHOLDS[0]!);
    expect(bandOf(DEBT_THRESHOLDS[1]! - 1)).toBe(DEBT_THRESHOLDS[0]!);
    expect(bandOf(Number.MAX_SAFE_INTEGER)).toBe(DEBT_THRESHOLDS[DEBT_THRESHOLDS.length - 1]!);
  });
});

describe('the prompt is bounded', () => {
  test('below the first threshold there is nothing to convert on', () => {
    expect(ask({ pendingDebt: DEBT_THRESHOLDS[0]! - 1 })).toBeNull();
  });

  test('crossing the first threshold prompts once', () => {
    const prompt = ask({ pendingDebt: DEBT_THRESHOLDS[0]! });
    expect(prompt).not.toBeNull();
    expect(prompt?.reason).toBe('debt_threshold');
    expect(prompt?.threshold).toBe(DEBT_THRESHOLDS[0]!);
  });

  test('MORE DEBT INSIDE THE SAME BAND IS SILENT — the bound itself', () => {
    // The assertion the whole file exists for. An implementation that prompts
    // whenever `pendingDebt >= threshold` passes every other test here and
    // fires every single morning.
    const shown: PromptState = { lastShownAt: START.toISOString(), lastShownDebt: DEBT_THRESHOLDS[0]! };
    for (const debt of [DEBT_THRESHOLDS[0]!, DEBT_THRESHOLDS[0]! + 1, DEBT_THRESHOLDS[1]! - 1]) {
      expect(
        ask({ pendingDebt: debt, state: shown, now: new Date(START.getTime() + DAY_MS) }),
      ).toBeNull();
    }
  });

  test('crossing the NEXT band prompts exactly once more', () => {
    const shown: PromptState = { lastShownAt: START.toISOString(), lastShownDebt: DEBT_THRESHOLDS[0]! };
    const crossed = ask({
      pendingDebt: DEBT_THRESHOLDS[1]!,
      state: shown,
      now: new Date(START.getTime() + DAY_MS),
    });
    expect(crossed?.threshold).toBe(DEBT_THRESHOLDS[1]!);

    // ...and having shown it, the next morning is silent again.
    const after: PromptState = {
      lastShownAt: new Date(START.getTime() + DAY_MS).toISOString(),
      lastShownDebt: DEBT_THRESHOLDS[1]!,
    };
    expect(
      ask({ pendingDebt: DEBT_THRESHOLDS[1]! + 5, state: after, now: new Date(START.getTime() + 2 * DAY_MS) }),
    ).toBeNull();
  });

  test('the interval is the other way through, and one day short is silent', () => {
    const shown: PromptState = { lastShownAt: START.toISOString(), lastShownDebt: DEBT_THRESHOLDS[0]! };
    const almost = new Date(START.getTime() + (PROMPT_INTERVAL_DAYS - 1) * DAY_MS);
    const due = new Date(START.getTime() + PROMPT_INTERVAL_DAYS * DAY_MS);

    expect(ask({ pendingDebt: DEBT_THRESHOLDS[0]!, state: shown, now: almost })).toBeNull();
    const prompt = ask({ pendingDebt: DEBT_THRESHOLDS[0]!, state: shown, now: due });
    expect(prompt?.reason).toBe('interval');
  });

  test('the interval does not resurrect a prompt there is no debt for', () => {
    const shown: PromptState = { lastShownAt: START.toISOString(), lastShownDebt: DEBT_THRESHOLDS[0]! };
    const due = new Date(START.getTime() + PROMPT_INTERVAL_DAYS * DAY_MS);
    expect(ask({ pendingDebt: 0, state: shown, now: due })).toBeNull();
  });
});

describe('who it is for', () => {
  test('a paid tenant is never prompted, however much debt they carry', () => {
    expect(ask({ tier: 'paid', pendingDebt: DEBT_THRESHOLDS[DEBT_THRESHOLDS.length - 1]! })).toBeNull();
  });

  test('a brain that has never consolidated is still free-tier for this purpose', () => {
    expect(ask({ tier: null, pendingDebt: DEBT_THRESHOLDS[0]! })).not.toBeNull();
  });
});

describe('what it says', () => {
  test('it carries the two counts R12a needs a reachable path for', () => {
    const prompt = ask({ pendingDebt: DEBT_THRESHOLDS[0]!, pendingReview: 4, uncorroboratedClaims: 7 });
    expect(prompt?.pendingReview).toBe(4);
    expect(prompt?.uncorroboratedClaims).toBe(7);
    // The restatement path: a `remember` marks a claim restated (R12a), which is
    // the only move a connected agent can make toward corroboration.
    expect(prompt?.text).toContain('remember');
  });

  test('it states its own dismissal, because a prompt with no off switch is an ad', () => {
    const prompt = ask({ pendingDebt: DEBT_THRESHOLDS[0]! });
    expect(prompt?.dismissal.length).toBeGreaterThan(0);
    expect(prompt?.dismissal).toContain(String(PROMPT_INTERVAL_DAYS));
  });

  test('it never mentions contradictions', () => {
    const prompt = ask({ pendingDebt: DEBT_THRESHOLDS[0]!, pendingReview: 3, uncorroboratedClaims: 2 });
    expect(`${prompt?.text} ${prompt?.dismissal}`.toLowerCase()).not.toContain('contradict');
  });
});

describe('the counter it reads is the deterministic one', () => {
  test('the module names no contradiction anywhere', async () => {
    // Structural rather than behavioural, and deliberately both: `PromptInput`
    // has nowhere to put a contradiction count, and this asserts nobody added
    // one through a back door. R8's reason is that the free tier cannot produce
    // contradictions at all, so a contradiction-gated prompt renders empty for
    // exactly the tier it exists to convert.
    const source = await Bun.file(`${import.meta.dir}/../../src/core/briefing/prompt.ts`).text();
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      .join('\n');
    expect(code.toLowerCase()).not.toContain('contradiction');
  });
});
