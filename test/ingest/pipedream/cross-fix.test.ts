/**
 * The three connector fixes, asked together.
 *
 * They were built in parallel by three agents that could not see each other,
 * and they land on overlapping ground: two of them edit `pull.ts`, and **all
 * three change what a failing lane records**. Each one's own suite proves its
 * own claim against the rest of the tree as it stood *before* the other two.
 * Nothing yet asks whether the claims survive each other, and the place they
 * would fail is not a merge conflict — it is a precedence, which compiles.
 *
 * Two seams are worth the file:
 *
 *   1. **The auth split reaches its verdict through `runPull`, and the timeout
 *      work put a second stop reason in the same return path.** `stopReason` is
 *      `halted ?? incomplete`, and `time_exhausted` is a `halted`. A yield check
 *      that ran a step earlier — before the listing rather than between items —
 *      would answer `time_exhausted` for a slice whose *provider* had just
 *      revoked the grant, and `time_exhausted` is deliberately non-terminal. The
 *      lane would then climb the whole ladder against a 401 nobody can retry
 *      past, with the dashboard saying *it picks up where it left off* and the
 *      one person who could fix it in thirty seconds never asked. That is the
 *      exact failure `0bca917` exists to prevent, re-manufactured by `8c8e466`.
 *      It does not happen, and this file is why we know.
 *
 *   2. **The folder skip shortens the item list the timeout budget iterates.**
 *      `a80d146` filters folders above the ceiling, so a Drive page that used to
 *      carry four folders and twenty-two files now carries twenty-six files —
 *      and the runner's one-item floor (`attemptedItems > 0`) is stated over
 *      *that* list. A page whose every entry is filtered is a loop that never
 *      runs, so the floor never trips, and the assertions that pin it live in a
 *      suite whose pages are hand-built and contain no folders at all.
 *
 * Each test names the pre-fix behaviour it would report if the guard it depends
 * on were removed, because a cross-fix file that only says "still green" is one
 * nobody can read a regression out of.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { HOSTED_PROFILE } from '../../../src/ai/routing.ts';
import {
  connectSource,
  createInMemoryConnectorStore,
  type ConnectorState,
  type ConnectorStateStore,
} from '../../../src/ingest/cursor.ts';
import { createPipedreamClient } from '../../../src/ingest/pipedream/client.ts';
import {
  IngestPullFailure,
  attemptFor,
  runPull,
  type PullResult,
} from '../../../src/ingest/pipedream/pull.ts';
import { createDriveSource } from '../../../src/ingest/pipedream/sources/drive.ts';
import { externalRefFor } from '../../../src/ingest/pipedream/sources/types.ts';
import { jobRetryableOf } from '../../../src/worker/jobs.ts';
import { createIngestFixture, TENANT, countRows, type IngestFixture } from '../fixture.ts';
import { CONFIG, createScriptedTransport, createFakeSource, withToken } from './fixture.ts';

let fixture: IngestFixture;

const NOW = new Date('2026-08-13T10:00:00.000Z');

/**
 * A slice whose window is already gone.
 *
 * `attemptYieldAtMs` is allowed to answer an instant in the past — that is the
 * honest answer for a claim taken with nothing left — so this is not a contrived
 * value, it is the ordinary tick that lands seconds before the container sheds.
 * Every `outOfTime()` consulted under it is true.
 */
const SPENT_YIELD_AT_MS = 1_000;
const WELL_PAST = () => SPENT_YIELD_AT_MS + 60_000;

const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';

beforeAll(async () => {
  fixture = await createIngestFixture('crossfix');
});

afterAll(async () => {
  await fixture.close();
});

function stateFor(source: 'gmail' | 'drive', overrides: Partial<ConnectorState> = {}): ConnectorState {
  return {
    ...connectSource({ source, externalUserId: TENANT, accountId: 'apn_1', now: NOW }),
    ...overrides,
  };
}

async function storeWith(state: ConnectorState): Promise<ConnectorStateStore> {
  const store = createInMemoryConnectorStore();
  await store.write(state);
  return store;
}

/** The health record `/admin connector_status` and the dashboard both read. */
function recordedCauseOf(result: PullResult): string | null {
  return attemptFor({ tenantId: TENANT }, 'gmail', NOW, result).ingestFailureCode;
}

// ---------------------------------------------------------------------------
// 1. The auth split, asked from inside a slice that has no time left.
// ---------------------------------------------------------------------------

describe('a spent slice budget does not re-answer the auth question', () => {
  /**
   * Run a listing failure through the real runner with the wall clock already
   * gone. Both facts are true of the same attempt, and the test is which one the
   * lane is told about.
   */
  async function pullWithNoTimeLeft(reason: 'auth_expired' | 'fleet_auth_failed'): Promise<PullResult> {
    return runPull({
      tenant: fixture.runtime,
      control: fixture.controlSql,
      profile: HOSTED_PROFILE,
      source: createFakeSource('gmail', 'email', [{ ok: false, reason }]),
      states: await storeWith(stateFor('gmail')),
      now: NOW,
      interactive: false,
      yieldAtMs: SPENT_YIELD_AT_MS,
      clock: WELL_PAST,
    });
  }

  test('a revoked grant is still terminal, and still says reconnect', async () => {
    const result = await pullWithNoTimeLeft('auth_expired');

    // **`failed`, not `stopped`.** The distinction is the whole ladder: a
    // `stopped` run banks and completes its job, and a lane whose grant is gone
    // would then be re-polled on the ordinary cadence forever.
    expect({ outcome: result.outcome, stopReason: result.stopReason }).toEqual({
      outcome: 'failed',
      stopReason: 'auth_expired',
    });

    // The consequence, taken from the runner's own reader rather than from the
    // predicate — `jobRetryableOf` is what decides whether the ladder runs.
    const failure = new IngestPullFailure('gmail', result.stopReason);
    expect(jobRetryableOf(failure, false)).toBe(false);

    // And the operator's surface still names it. `time_exhausted` records
    // `cancelled`, whose copy is *it picks up where it left off* — true of a
    // banked slice and a lie about a withdrawn permission.
    expect(recordedCauseOf(result)).toBe('auth_expired');
  });

  test('the fleet’s own credential is still the fleet’s, and still retries', async () => {
    const result = await pullWithNoTimeLeft('fleet_auth_failed');

    expect({ outcome: result.outcome, stopReason: result.stopReason }).toEqual({
      outcome: 'failed',
      stopReason: 'fleet_auth_failed',
    });

    // Retryable, because the remedy is a rotation or a redeploy and a lane that
    // stopped trying would not notice it land.
    const failure = new IngestPullFailure('gmail', result.stopReason);
    expect(jobRetryableOf(failure, false)).toBe(true);

    // The code is the signal, and `cancelled` would bury it among every
    // deliberate stop in the fleet — including, now, every long import.
    expect(recordedCauseOf(result)).toBe('fleet_auth_failed');
  });

  test('the two are still distinguishable from each other and from a spent window', async () => {
    // Stated as one assertion rather than three files' worth, because the
    // failure this guards is a collapse: a change that made any two of these
    // agree would pass both tests above only if it collapsed them the same way.
    const [grant, fleet] = await Promise.all([
      pullWithNoTimeLeft('auth_expired'),
      pullWithNoTimeLeft('fleet_auth_failed'),
    ]);

    expect(new Set([recordedCauseOf(grant), recordedCauseOf(fleet), 'cancelled']).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2. The folder skip, under the timeout budget that iterates what it leaves.
// ---------------------------------------------------------------------------

describe('a Drive folder costs the panel nothing, budget or no budget', () => {
  /**
   * The real Drive adapter over a scripted transport, so the folder guard under
   * test is the shipped one and not a page hand-built to have already applied
   * it. The changes feed is the leg that matters: it takes no `q`, so the
   * provider cannot be asked to withhold folders and `collect`'s filter is the
   * only thing standing between a folder and a `parse_failed` row.
   */
  function driveWithFolders(transport: ReturnType<typeof createScriptedTransport>, fileId: string) {
    transport.on('/changes?', {
      status: 200,
      body: {
        newStartPageToken: 'p-9',
        changes: [
          { fileId: 'fold-1', file: { id: 'fold-1', name: 'Board decks', mimeType: GOOGLE_FOLDER, trashed: false } },
          { fileId: 'fold-2', file: { id: 'fold-2', name: 'Legal', mimeType: GOOGLE_FOLDER, trashed: false } },
          {
            fileId,
            file: {
              id: fileId,
              name: 'strategy.txt',
              mimeType: 'text/plain',
              trashed: false,
              modifiedTime: '2026-08-12T09:00:00Z',
            },
          },
        ],
      },
    });
    transport.on(`/files/${fileId}`, { status: 200, body: `the ${fileId} strategy document body, at length` });
    return createDriveSource(
      createPipedreamClient({
        config: CONFIG,
        transport,
        now: () => NOW,
        rate: { take: () => Promise.resolve() },
      }),
    );
  }

  /**
   * A file id per case. The fixture's brain is one database for the whole file,
   * and U4 answers a second write of identical content `unchanged` — which is
   * correct, and would silently turn the forward-progress assertion below into
   * an assertion about deduplication.
   */
  async function pullDrive(options: {
    readonly spent: boolean;
    readonly fileId: string;
  }): Promise<PullResult> {
    const transport = withToken(createScriptedTransport());
    return runPull({
      tenant: fixture.runtime,
      control: fixture.controlSql,
      profile: HOSTED_PROFILE,
      source: driveWithFolders(transport, options.fileId),
      states: await storeWith(stateFor('drive', { cursor: { kind: 'delta', value: 'p-8', issuedAt: NOW.toISOString() } })),
      now: NOW,
      interactive: false,
      storage: fixture.storage,
      rawStore: fixture.rawStore,
      ...(options.spent ? { yieldAtMs: SPENT_YIELD_AT_MS, clock: WELL_PAST } : {}),
    });
  }

  test('the runner counts no failure for a folder, so items_failed is the truth', async () => {
    const result = await pullDrive({ spent: false, fileId: 'file-unspent' });

    // **`counts.failed` is `items_failed` on the connector panel**, which is the
    // surface a stalled connector is diagnosed from. Pre-fix this was 2 — one
    // `parse_failed` per folder, per run, against a folder tree that never
    // changes — and the adapter's own suite cannot make this assertion because
    // the number is assembled here.
    expect({ failed: result.counts.failed, written: result.counts.written }).toEqual({
      failed: 0,
      written: 1,
    });

    // And no row was written for one either. The count could be right while the
    // log still carried the refusals, and the log is the durable half.
    expect(
      await countRows(
        fixture.tenantSql,
        'ingest_log',
        `external_ref IN ('${externalRefFor('drive', 'fold-1')}', '${externalRefFor('drive', 'fold-2')}')`,
      ),
    ).toBe(0);
  });

  test('a slice with no time left still banks the file the folders used to crowd out', async () => {
    const result = await pullDrive({ spent: true, fileId: 'file-spent' });

    // **The one-item floor, stated over the filtered list.** The guard is
    // `attemptedItems > 0`, and `attemptedItems` counts what survived the folder
    // filter — so the question this asks is whether a page that is mostly
    // folders still makes forward progress when the window is gone. Without the
    // floor this is `written: 0` with the cursor held: a lane handing the
    // identical page to the next slice forever while every row in the control
    // plane reads healthy.
    expect({
      written: result.counts.written,
      failed: result.counts.failed,
      attempted: result.attemptedItems,
    }).toEqual({ written: 1, failed: 0, attempted: 1 });

    // It stopped on the wall clock, and it said so in its own vocabulary rather
    // than borrowing the ceiling's. `stopped` — the job completes, no attempt is
    // charged, no ladder is climbed.
    expect({ outcome: result.outcome, stopReason: result.stopReason }).toEqual({
      outcome: 'stopped',
      stopReason: 'time_exhausted',
    });

    // The cursor holds, because the page is not finished. That is what makes the
    // next wake resume rather than skip.
    expect(result.cursorAdvanced).toBe(false);
  });
});
