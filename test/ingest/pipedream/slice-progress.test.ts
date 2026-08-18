/**
 * **A long import makes the same progress on its hundredth slice as on its
 * first.**
 *
 * This file does not guard the failure-code change that landed beside it. A
 * label written by `reclaim` cannot make a slice import fewer messages, and
 * nothing here would notice if the two codes were swapped.
 *
 * What it pins is the shape of the last attempt at the `attempt_timed_out`
 * problem: that change sized each slice against the age of the process running
 * it, captured that age once at boot, and so gave every wake after the first a
 * budget already spent. In production it capped each slice at exactly one item
 * — and that one item was always the re-listed page's already-banked first
 * message, which takes the unchanged shortcut in the write path and costs
 * nothing. `attemptedItems` was 1, `counts.written` was 0, the cursor held, and
 * every row in the control plane read healthy while a mailbox imported nothing
 * for an hour.
 *
 * Two rules it inherits from that post-mortem, and both matter:
 *
 *   - **The measure is new work, not work attempted.** `attemptedItems > 0` and
 *     `pages > 0` are both green in the regressed world. `counts.written` and a
 *     cursor that moves are not.
 *   - **Every slice, not the first.** The collapse was to zero *new* items from
 *     slice two, so a floor asserted once proves nothing.
 *
 * **What this file cannot do, stated because it was once claimed otherwise.**
 * It does not detect a re-introduced boot-scoped budget on its own. Nothing in
 * the pull path reads a clock today, and `PullHandlerDeps` has no injected one,
 * so a process-origin arm has nothing here to read and nothing here to advance
 * — the injected `now` moves the *lease*, not the process's idea of its own
 * age. An earlier version of this file appeared to catch the defect, but only
 * because its lease pinned `attemptDeadlineAt` to `T0` while `now` advanced,
 * which drove the attempt's remaining budget negative by slice two. `claim`
 * stamps that deadline fresh on every claim, so the state was unreachable in
 * production; the fixture was the discriminator, not the assertion. That lease
 * is now stamped the way `claim` stamps it, and the file is green on both sides
 * of the reverted commit.
 *
 * So the guarantee is the narrower true one: **every slice does new work.** A
 * change that reintroduces a per-process budget has to add the clock seam to
 * read it, and adding that seam is what makes a real guard writable — assert
 * there, against an injected process clock, and let this file keep the
 * throughput floor.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { HOSTED_PROFILE } from '../../../src/ai/routing.ts';
import {
  connectSource,
  createInMemoryConnectorStore,
  type ConnectorStateStore,
} from '../../../src/ingest/cursor.ts';
import { createIngestPullHandler, type PullResult } from '../../../src/ingest/pipedream/pull.ts';
import { externalRefFor } from '../../../src/ingest/pipedream/sources/types.ts';
import type { JobLease } from '../../../src/worker/jobs.ts';
import { countRows, createIngestFixture, setSpend, TENANT, type IngestFixture } from '../fixture.ts';
import { createFakeSource, mailBody, page } from './fixture.ts';
import { createRecordingHealth } from './health-fixture.ts';

let fixture: IngestFixture;

const T0 = new Date('2026-08-13T10:00:00.000Z');

/**
 * One tick's worth of clock between slices, and deliberately longer than the
 * window a wake is given: `WorkerFleet.sleepAfter` in `src/mcp/router.ts` is
 * `'5m'`. Anything derived from when the *process* started is unrecoverably
 * stale by the second slice at this spacing, which is the point.
 */
const SLICE_GAP_MS = 10 * 60_000;

const SLICES = 3;
const ITEMS_PER_SLICE = 2;

/** Distinct prose per item, so nothing arrives as an update to something else. */
function pageOf(slice: number) {
  return page({
    items: Array.from({ length: ITEMS_PER_SLICE }, (_, index) => {
      const id = `slice-${slice}-${index}`;
      return {
        externalRef: externalRefFor('gmail', id),
        title: `subject ${id}`,
        body: mailBody(id, 1),
        occurredAt: new Date(T0.getTime() + slice * SLICE_GAP_MS),
      };
    }),
    nextCursor: { kind: 'delta' as const, value: `cursor-after-slice-${slice}` },
  });
}

/**
 * Stamped from the claim instant, because that is what `claim` does:
 * `src/worker/queue.ts` computes both `expiresAt` and `deadline` from
 * `request.now` on **every** claim, so a slice always opens with a full lease
 * and a full attempt budget in front of it.
 *
 * Pinning them to `T0` instead — which this fixture used to do — hands slice
 * two a deadline that has already passed, and that is a state the queue cannot
 * produce. A test that depends on it is measuring the fixture.
 */
function leaseFor(jobId: string, now: Date): JobLease {
  return {
    jobId,
    tenantId: TENANT,
    kind: 'ingest_pull',
    target: 'gmail',
    leaseToken: 1,
    owner: 'worker-1',
    expiresAt: new Date(now.getTime() + 60_000),
    attemptDeadlineAt: new Date(now.getTime() + 900_000),
    attempts: 1,
    maxAttempts: 5,
    debtObserved: 0,
  };
}

beforeAll(async () => {
  fixture = await createIngestFixture('u9slice');
  // Uncapped, so what a slice imports is a fact about the slice rather than
  // about the tenant's remaining headroom. The budget has its own tests; this
  // one must not be able to pass or fail for its reasons.
  await setSpend(fixture.controlSql, TENANT, { spentMicroUsd: 0, capMicroUsd: null });
});

afterAll(async () => {
  await fixture.close();
});

describe("a long import's throughput does not decay with the age of the process", () => {
  test('every slice imports its page, and the tenth minute looks like the first', async () => {
    const states: ConnectorStateStore = createInMemoryConnectorStore();
    await states.write(
      connectSource({ source: 'gmail', externalUserId: TENANT, accountId: 'apn_1', now: T0 }),
    );

    const source = createFakeSource(
      'gmail',
      'email',
      Array.from({ length: SLICES }, (_, slice) => pageOf(slice)),
    );

    const results: PullResult[] = [];
    // **Once, above the loop.** `serve.ts` builds this handler at startup and
    // then hands it every tick for as long as the container lives; a fixture
    // that rebuilt it per wake would hide exactly the defect this file names.
    const handler = createIngestPullHandler({
      health: createRecordingHealth(),
      control: fixture.controlSql,
      profile: HOSTED_PROFILE,
      openTenant: () => Promise.resolve(fixture.runtime),
      openSource: () => Promise.resolve({ source, states }),
      onResult: (result) => {
        results.push(result);
      },
    });

    let banked = await countRows(fixture.tenantSql, 'page');

    for (let slice = 0; slice < SLICES; slice += 1) {
      const now = new Date(T0.getTime() + slice * SLICE_GAP_MS);
      await handler({
        lease: leaseFor(`job-slice-${slice}`, now),
        now,
        signal: new AbortController().signal,
      });

      const result = results[slice];
      expect(result?.outcome).toBe('completed');

      // The discriminating number. `attemptedItems` stays at 1 in the regressed
      // world — the free re-walk of an already-banked message — so a floor
      // asserted on it is a floor that was never crossed.
      expect(result?.counts.written).toBe(ITEMS_PER_SLICE);

      // The cursor is the other half: a slice that banked and then held its
      // cursor hands the identical page to the next slice forever.
      expect((await states.read('gmail'))?.cursor?.value).toBe(`cursor-after-slice-${slice}`);

      // And the frontier itself moved. A poller re-walking the same prefix
      // writes nothing new however busy its log looks.
      const after = await countRows(fixture.tenantSql, 'page');
      expect(after - banked).toBe(ITEMS_PER_SLICE);
      banked = after;
    }

    // Stated once more against the whole run, because the per-slice loop above
    // would still pass if it ran a single iteration.
    expect(results).toHaveLength(SLICES);
    expect(source.requests).toHaveLength(SLICES);
    expect(await countRows(fixture.tenantSql, 'page')).toBe(SLICES * ITEMS_PER_SLICE);
  });
});
