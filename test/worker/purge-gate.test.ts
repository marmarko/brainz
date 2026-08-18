/**
 * **The switch on the only lane in the fleet that destroys data.**
 *
 * `purgeExpiredTombstones` is correct, bounded and countable — and turning its
 * enqueuer on is still a product decision rather than an engineering one,
 * because `restoreForgotten` has no production caller. Nothing in `TOOL_NAMES`,
 * nothing in `ADMIN_OPERATIONS`, nothing in the web app restores a forgotten
 * page. So an enqueuer that defaults on would not begin keeping the 72-hour
 * promise; it would begin enforcing the deletion half of a promise whose
 * recovery half does not exist.
 *
 * These assertions are cheap and the failure they prevent is not: a hard-delete
 * lane that arrives switched on because someone rebuilt a container.
 */

import { describe, expect, test } from 'bun:test';

import { enqueueDuePurges, purgeEnqueueEnabled } from '../../src/worker/purge.ts';

/** Throws if touched. The gate must refuse before it reaches the database. */
const refusingDeps = {
  sql: new Proxy({}, { get: () => { throw new Error('the gate let a query through'); } }),
  queue: { enqueue: () => { throw new Error('the gate let an enqueue through'); } },
} as never;

describe('the retention lane is off unless an operator turned it on', () => {
  test('an unset flag reads as off, so an upgrade does not start deleting', () => {
    expect(purgeEnqueueEnabled({})).toBe(false);
    expect(purgeEnqueueEnabled({ BRAINZ_PURGE_ENABLED: undefined })).toBe(false);
  });

  test('only the exact string turns it on — no truthiness, no near-misses', () => {
    expect(purgeEnqueueEnabled({ BRAINZ_PURGE_ENABLED: 'true' })).toBe(true);
    for (const value of ['1', 'yes', 'TRUE', 'True', 'on', '', 'false', ' true ']) {
      expect(purgeEnqueueEnabled({ BRAINZ_PURGE_ENABLED: value })).toBe(false);
    }
  });

  test('disabled, it reaches neither the database nor the queue', async () => {
    const result = await enqueueDuePurges(refusingDeps, { now: new Date(), enabled: false });
    expect(result).toEqual({ due: 0, enqueued: [], refused: [] });
  });

  test('an omitted flag is the same refusal as an explicit false', async () => {
    const result = await enqueueDuePurges(refusingDeps, { now: new Date() });
    expect(result).toEqual({ due: 0, enqueued: [], refused: [] });
  });
});
