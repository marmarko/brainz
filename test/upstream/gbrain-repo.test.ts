/**
 * Reading the upstream checkout, and the two properties that make it safe.
 *
 * **1. It reads the pin, not the working tree.** The gbrain checkout on this
 * machine sits on a local branch with unreleased commits on it. A watcher that
 * read `CHANGELOG.md` off the filesystem would classify against whatever somebody
 * last checked out — a report that changes when nobody upstream shipped anything.
 * Every read here goes through git plumbing at the pinned **commit**, so the
 * sweep and the delta are functions of the pin and of nothing else.
 *
 * **2. It cannot write.** gbrain is a reference, not a dependency: nothing in
 * brainz may modify it. That is enforced structurally rather than by care — the
 * git wrapper carries an allowlist of read-only subcommands and refuses
 * everything else, so a future caller cannot reach `git commit` through it even
 * by accident.
 *
 * These tests need a real gbrain checkout. Without one they skip with a reason
 * string rather than passing, which is the same discipline `test/hazards/` uses:
 * a guard that quietly passes when its subject is absent is worse than no guard.
 */

import { describe, expect, test } from 'bun:test';

import {
  READ_ONLY_GIT_SUBCOMMANDS,
  defaultCheckoutPath,
  openCheckout,
  runGit,
} from '../../src/upstream/gbrain-repo.ts';
import { parsePin } from '../../evals/conformance/pin.ts';

const PIN = parsePin(await Bun.file('upstream/gbrain.pin').text());
const CHECKOUT = defaultCheckoutPath();

const available = (() => {
  try {
    openCheckout({ path: CHECKOUT, commit: PIN.commit });
    return true;
  } catch {
    return false;
  }
})();

describe('the git wrapper is read-only by construction', () => {
  test('the allowlist holds only commands that cannot mutate a repository', () => {
    expect([...READ_ONLY_GIT_SUBCOMMANDS].sort()).toEqual(
      ['cat-file', 'ls-tree', 'rev-list', 'rev-parse', 'show'].sort(),
    );
  });

  test('a mutating subcommand is refused before git is spawned', () => {
    for (const forbidden of ['commit', 'checkout', 'add', 'fetch', 'clean', 'reset']) {
      expect(() => runGit(CHECKOUT, [forbidden, '--help'])).toThrow(/read-only/i);
    }
  });
});

describe.if(available)('reading gbrain at the pinned commit', () => {
  const checkout = openCheckout({ path: CHECKOUT, commit: PIN.commit });

  test('the CHANGELOG read at the pin carries the pinned release header', () => {
    expect(checkout.readFile('CHANGELOG.md')).toContain(`## [${PIN.tag.replace(/^v/, '')}]`);
  });

  test('a path that exists only after the pin is not readable at the pin', () => {
    // The property that separates "read the pin" from "read the working tree".
    // If this ever passes, the accessor is reading the filesystem.
    const afterThePin = checkout
      .listTree('')
      .filter((entry) => entry === 'deploy');
    expect(afterThePin).toEqual([]);
  });

  test('trees list at the pin, not at HEAD', () => {
    const scripts = checkout.listTree('scripts');
    expect(scripts.length).toBeGreaterThan(20);
    expect(scripts).toContain('scripts/check-jsonb-pattern.sh');
  });

  test('a commit the checkout does not contain is refused, not silently retargeted', () => {
    expect(() => openCheckout({ path: CHECKOUT, commit: 'f'.repeat(40) })).toThrow(/f{40}/);
  });

  test('the checkout reports how far its HEAD has moved past the pin', () => {
    // Input to the pin-advance recommendation. Ahead-ness alone is not a reason
    // to advance; a release in that ahead-ness is.
    expect(checkout.commitsAhead()).toBeGreaterThanOrEqual(0);
  });
});

describe.if(!available)('no gbrain checkout on this machine', () => {
  test.skip(
    `upstream reads skipped — no gbrain checkout at ${CHECKOUT} containing ${PIN.commit}. ` +
      'Set GBRAIN_CHECKOUT to a clone that contains the pinned commit.',
    () => {},
  );
});
