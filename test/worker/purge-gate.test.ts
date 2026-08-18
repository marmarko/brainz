/**
 * **The switch on the only lane in the fleet that destroys data.**
 *
 * This header used to argue that the enqueuer must default off because
 * `restoreForgotten` had no production caller — nothing in `TOOL_NAMES`,
 * nothing in `ADMIN_OPERATIONS`, nothing in the web app could restore a
 * forgotten page. That premise is gone: the web app lists what is restorable
 * and puts it back (`src/web/serve.ts:retractionPort`), so the deletion half of
 * the 72-hour promise no longer runs ahead of the recovery half.
 *
 * The assertions below are unchanged, because what they pin never depended on
 * that argument. "Absent reads as off" is a property of **upgrades**: a fleet
 * that has never heard of this flag must not begin hard-deleting because
 * somebody rebuilt a container. That is cheap to assert and the failure it
 * prevents is not.
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
