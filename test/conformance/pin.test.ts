/**
 * `upstream/gbrain.pin` — the reason upstream master cannot redden brainz CI.
 *
 * U7 step 5: "The gbrain build is pinned — a tag recorded in
 * `upstream/gbrain.pin`, fetched or built by the wrapper — so upstream master
 * cannot redden brainz CI on unrelated PRs. Advancing the pin is a deliberate
 * U19 ledger action."
 *
 * **A tag is not a pin.** Tags are mutable refs; a force-pushed tag changes what
 * the wrapper builds while the pin file reads identically, which is the exact
 * silent-drift shape the model-id pin guard exists to close on the model side.
 * So the pin carries a full commit sha, the tag is recorded alongside it as the
 * human-readable name, and the checkout is verified against the **sha**.
 *
 * Every check fails toward refusing to run: an unverifiable checkout produces no
 * conformance verdict at all rather than a verdict against an unknown build.
 */

import { describe, expect, test } from 'bun:test';

import { parsePin, verifyCheckout, type GbrainPin } from '../../evals/conformance/pin.ts';

const SHA = 'a'.repeat(40);

const GOOD: GbrainPin = {
  repo: 'https://github.com/garrytan/gbrain.git',
  tag: 'v0.44.1.0',
  commit: SHA,
  pinned_on: '2026-08-13',
  advanced_by: 'U7 — first pin; advancing it is a U19 ledger action',
};

function pinText(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...GOOD, ...overrides });
}

describe('parsePin', () => {
  test('it round-trips a well-formed pin', () => {
    expect(parsePin(pinText())).toEqual(GOOD);
  });

  test('a short or upper-case sha is refused', () => {
    expect(() => parsePin(pinText({ commit: 'a'.repeat(7) }))).toThrow(/commit/);
    expect(() => parsePin(pinText({ commit: 'A'.repeat(40) }))).toThrow(/commit/);
  });

  test('a missing commit is refused even when a tag is present', () => {
    const { commit: _drop, ...rest } = GOOD;
    void _drop;
    expect(() => parsePin(JSON.stringify(rest))).toThrow(/commit/);
  });

  test('a missing tag is refused: the pin has to be readable by a person too', () => {
    const { tag: _drop, ...rest } = GOOD;
    void _drop;
    expect(() => parsePin(JSON.stringify(rest))).toThrow(/tag/);
  });

  test('a non-https, non-file repo is refused', () => {
    expect(() => parsePin(pinText({ repo: 'git@github.com:garrytan/gbrain.git' }))).toThrow(/repo/);
  });

  test('a pinned_on that is not a real calendar day is refused', () => {
    expect(() => parsePin(pinText({ pinned_on: '2026-02-30' }))).toThrow(/pinned_on/);
  });

  test('an empty advanced_by is refused — advancing the pin is a deliberate act with an owner', () => {
    expect(() => parsePin(pinText({ advanced_by: '   ' }))).toThrow(/advanced_by/);
  });

  test('malformed JSON throws', () => {
    expect(() => parsePin('not json')).toThrow();
  });
});

describe('verifyCheckout refuses anything but the pinned build', () => {
  const at = (head: string, status = '') =>
    verifyCheckout({
      dir: '/tmp/gbrain',
      pin: GOOD,
      git: (args) => {
        if (args[0] === 'rev-parse') return { ok: true, stdout: head };
        if (args[0] === 'status') return { ok: true, stdout: status };
        throw new Error(`unexpected git ${args.join(' ')}`);
      },
    });

  test('a checkout at the pinned sha verifies', () => {
    expect(at(SHA).violations).toEqual([]);
    expect(at(SHA).verified).toBe(true);
  });

  test('trailing whitespace in rev-parse output does not fail the compare', () => {
    expect(at(`${SHA}\n`).verified).toBe(true);
  });

  test('a checkout at a different sha is pin_mismatch', () => {
    const result = at('b'.repeat(40));
    expect(result.verified).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(['pin_mismatch']);
  });

  test('a dirty worktree is checkout_dirty — a modified upstream is not the pinned build', () => {
    const result = at(SHA, ' M src/core/verbs/conformance.ts\n');
    expect(result.verified).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(['checkout_dirty']);
  });

  test('a git invocation that fails is checkout_unusable, never a pass', () => {
    const result = verifyCheckout({
      dir: '/tmp/nope',
      pin: GOOD,
      git: () => ({ ok: false, stdout: 'fatal: not a git repository' }),
    });
    expect(result.verified).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(['checkout_unusable']);
  });

  test('a git helper that throws is caught and reported, not propagated as a crash', () => {
    const result = verifyCheckout({
      dir: '/tmp/nope',
      pin: GOOD,
      git: () => {
        throw new Error('spawn ENOENT');
      },
    });
    expect(result.verified).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(['checkout_unusable']);
    expect(result.violations[0]?.detail).toContain('ENOENT');
  });

  test('an empty rev-parse answer is not treated as a match', () => {
    const result = at('');
    expect(result.verified).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(['pin_mismatch']);
  });
});
