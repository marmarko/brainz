/**
 * The retention window, held against the two ways it silently becomes zero.
 *
 * ============================================================================
 * WHY A SUITE WITH NO DATABASE IN IT
 * ============================================================================
 *
 * `purgeExpiredTombstones` derived its cutoff from
 * `(request.ttlHours ?? FORGET_TTL_HOURS)`. `??` falls back on `null` and
 * `undefined` and on nothing else, so **`ttlHours: 0` passed straight through**
 * and collapsed a 72-hour recovery window to zero — hard-deleting tombstones
 * written seconds earlier, against the `recoverableUntil = now + 72h` the
 * receipt had already promised the user. There was no validation anywhere, and
 * `Number('')` is `0`, so a configuration value that failed to parse reached it
 * looking exactly like a deliberate choice. Negative is worse: the cutoff moves
 * into the *future* and the purge takes rows that have not been retracted long
 * enough to be past anything. `NaN` was the one input that failed closed, and it
 * did so by accident — every comparison against it is false.
 *
 * So the fix is a refusal rather than a clamp, and the refusal must happen
 * **before any statement runs**. That is what this file asserts and it is why
 * the handle passed in is a proxy that throws on contact: a validation that
 * happens inside the transaction is a validation that has already opened one,
 * and on the negative input it would have opened one holding row locks over a
 * cutoff nobody chose. If any of these tests reaches the database, the proxy
 * fails them with the property name it was asked for.
 *
 * The mirror case is on the restore side and is admitted here for the same
 * reason: `restoreForgotten` reads the same parameter to decide whether an undo
 * is still admissible, and a zero there refuses every undo while reporting the
 * TTL as the reason.
 */

import { describe, expect, test } from 'bun:test';

import {
  FORGET_TTL_HOURS,
  previewTombstonePurge,
  purgeExpiredTombstones,
  restoreForgotten,
  retentionHoursOf,
} from '../../src/mcp/tombstone.ts';

import type { SQL } from 'bun';

const NOW = new Date('2026-08-18T00:00:00.000Z');

/**
 * A handle that cannot be used, so "it refused before it queried" is a property
 * rather than a hope.
 *
 * A plain object would answer `undefined` for `begin` and fail with a
 * `TypeError` that reads like a harness bug. This names the property, so a
 * regression that moves the check below the first statement says which
 * statement it was.
 */
function refusingSql(): SQL {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `the purge reached the database (asked for ${String(property)}) before validating its retention window`,
        );
      },
    },
  ) as unknown as SQL;
}

/**
 * Every spelling of "no window", including the one a mis-parsed configuration
 * produces. `Number('')` is `0` and `Number('72 hours')` is `NaN`; both are
 * ordinary outcomes of reading an environment variable, and neither is a
 * retention policy.
 */
const REFUSED: readonly (readonly [string, number])[] = [
  ['zero, the value a mis-parsed empty string becomes', 0],
  ['the empty string, parsed', Number('')],
  ['negative, which moves the cutoff into the future', -1],
  ['a fraction of an hour that rounds to no window at all', -0.5],
  ['not a number', Number.NaN],
  ['unbounded', Number.POSITIVE_INFINITY],
];

describe('a retention window that is not a window is refused, not honoured', () => {
  for (const [name, ttlHours] of REFUSED) {
    test(`the purge refuses ${name}`, async () => {
      await expect(
        purgeExpiredTombstones(refusingSql(), { now: NOW, ttlHours }),
      ).rejects.toThrow(/retention/i);
    });

    test(`the preview refuses ${name}`, async () => {
      await expect(
        previewTombstonePurge(refusingSql(), { now: NOW, ttlHours }),
      ).rejects.toThrow(/retention/i);
    });

    test(`the restore refuses ${name}`, async () => {
      await expect(
        restoreForgotten(refusingSql(), {
          deletedAt: NOW.toISOString(),
          now: NOW,
          ttlHours,
        }),
      ).rejects.toThrow(/retention/i);
    });
  }

  test('and the absent value is still the product’s own 72 hours', () => {
    expect(retentionHoursOf(undefined)).toBe(FORGET_TTL_HOURS);
    expect(retentionHoursOf(FORGET_TTL_HOURS)).toBe(FORGET_TTL_HOURS);
    // A shorter window is a legitimate ask — the suites that exercise the purge
    // use one — so the guard must not have become "72 or nothing".
    expect(retentionHoursOf(1)).toBe(1);
  });
});
