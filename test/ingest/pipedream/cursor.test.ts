/**
 * Cursor state and the invalidation path (U9 approach 2a).
 *
 * The load-bearing property is one line: **a state with no cursor is a
 * backfill, and a backfill is gated.** Providers force this on us — Calendar
 * answers `410 GONE` on an expired sync token and mandates a full re-sync, and
 * Gmail's history window expires the same way — so every stalled tenant
 * eventually arrives at "re-list everything", which is precisely the unbounded
 * first import the gate exists to prevent. If `pullModeFor` ever reads a
 * missing cursor as a delta pull, the gate is never consulted and the mailbox
 * is imported at full price.
 *
 * The store is validated rather than cast, for the same reason U8's manifest is:
 * this record is read back by a worker that will spend money on what it says.
 */

import { describe, expect, test } from 'bun:test';

import { fleetIdentity } from '../../../src/control/secrets.ts';
import { createInMemoryRawStore } from '../../../src/ingest/import/raw.ts';
import {
  CONNECTOR_COLLECTION,
  DEFAULT_CADENCE_SECONDS,
  MIN_CADENCE_SECONDS,
  connectSource,
  createInMemoryConnectorStore,
  createObjectConnectorStore,
  discardCursor,
  isCursorInvalidation,
  isPullDue,
  normalizeCadenceSeconds,
  nextPullAt,
  parseConnectorState,
  pullModeFor,
  type ConnectorState,
} from '../../../src/ingest/cursor.ts';
import { testStorage } from './fixture.ts';

const NOW = new Date('2026-08-13T10:00:00.000Z');

function connected(overrides: Partial<ConnectorState> = {}): ConnectorState {
  return {
    ...connectSource({ source: 'gmail', externalUserId: 'tenant-a', now: NOW }),
    ...overrides,
  };
}

const DELTA = { kind: 'delta', value: 'h-100', issuedAt: NOW.toISOString() } as const;

describe('the mode a state implies', () => {
  test('no cursor is a backfill', () => {
    expect(pullModeFor(connected())).toBe('backfill');
  });

  test('a delta cursor is a delta pull', () => {
    expect(pullModeFor(connected({ cursor: DELTA }))).toBe('delta');
  });

  test('a backfill continuation cursor is still a backfill, and is still gated', () => {
    // A long first import is a sequence of slices. Each slice is re-estimated
    // and re-gated — cheap, because U4 is a no-op on what is already held — and
    // reading a continuation token as "delta, carry on" is how the second slice
    // of a 40k-message mailbox arrives ungated.
    expect(
      pullModeFor(connected({ cursor: { kind: 'backfill', value: 'p-2', issuedAt: NOW.toISOString() } })),
    ).toBe('backfill');
  });

  test('an empty cursor value is a backfill, not a delta pull', () => {
    // A provider that answers with `""` for its next token, or a state file
    // truncated to an empty string, must not be read as "resume from here" —
    // the resume would silently start from the beginning of time with no gate.
    expect(pullModeFor(connected({ cursor: { ...DELTA, value: '' } }))).toBe('backfill');
    expect(pullModeFor(connected({ cursor: { ...DELTA, value: '   ' } }))).toBe('backfill');
  });

  test('discarding a cursor records when it happened and returns to backfill', () => {
    const live = connected({ cursor: DELTA });
    const discarded = discardCursor(live, NOW);
    expect(discarded.cursor).toBeNull();
    expect(discarded.lastCursorInvalidatedAt).toBe(NOW.toISOString());
    expect(pullModeFor(discarded)).toBe('backfill');
    // The input is not mutated: the caller still holds what it read.
    expect(live.cursor).not.toBeNull();
  });
});

describe('what counts as an invalidated cursor', () => {
  test('410 GONE is an invalidation whatever the body says', () => {
    expect(isCursorInvalidation(410, {})).toBe(true);
    expect(isCursorInvalidation(410, { error: { message: 'anything' } })).toBe(true);
  });

  test("Google's fullSyncRequired reason is an invalidation", () => {
    expect(
      isCursorInvalidation(400, {
        error: { errors: [{ reason: 'fullSyncRequired' }], message: 'Sync token is no longer valid' },
      }),
    ).toBe(true);
  });

  test('a 404 naming the history id is an invalidation', () => {
    expect(
      isCursorInvalidation(404, { error: { message: 'startHistoryId is too old' } }),
    ).toBe(true);
  });

  test('ordinary failures are not invalidations', () => {
    expect(isCursorInvalidation(500, { error: 'boom' })).toBe(false);
    expect(isCursorInvalidation(429, { error: 'slow down' })).toBe(false);
    expect(isCursorInvalidation(401, { error: 'invalid_grant' })).toBe(false);
    expect(isCursorInvalidation(404, { error: { message: 'no such message' } })).toBe(false);
  });

  test('an unreadable body does not turn a 500 into an invalidation', () => {
    // Reading an unparseable error as "cursor gone" would discard a live cursor
    // on every provider hiccup and re-gate a full backfill each time.
    expect(isCursorInvalidation(500, 'not json at all')).toBe(false);
    expect(isCursorInvalidation(500, null)).toBe(false);
  });
});

describe('cadence', () => {
  test('a source has a default cadence and it is not zero', () => {
    for (const seconds of Object.values(DEFAULT_CADENCE_SECONDS)) {
      expect(seconds).toBeGreaterThanOrEqual(MIN_CADENCE_SECONDS);
    }
  });

  test('a declared cadence below the floor is raised to it', () => {
    // The floor is the per-source rate budget expressed as a schedule: a
    // caller asking for a one-second cadence is asking to be rate-limited.
    expect(normalizeCadenceSeconds('gmail', 1)).toBe(MIN_CADENCE_SECONDS);
    expect(normalizeCadenceSeconds('gmail', 0)).toBe(MIN_CADENCE_SECONDS);
    expect(normalizeCadenceSeconds('gmail', -600)).toBe(MIN_CADENCE_SECONDS);
    expect(normalizeCadenceSeconds('gmail', Number.NaN)).toBe(DEFAULT_CADENCE_SECONDS.gmail);
  });

  test('a source that has never pulled is due now', () => {
    expect(isPullDue(connected(), NOW)).toBe(true);
  });

  test('a source pulled inside its cadence is not due, and is due after it', () => {
    const state = connected({ lastPullAt: NOW.toISOString(), cadenceSeconds: 300 });
    expect(isPullDue(state, new Date(NOW.getTime() + 299_000))).toBe(false);
    expect(isPullDue(state, new Date(NOW.getTime() + 300_000))).toBe(true);
    expect(nextPullAt(state).toISOString()).toBe(new Date(NOW.getTime() + 300_000).toISOString());
  });
});

describe('the state store', () => {
  test('the in-memory store round-trips a state', async () => {
    const store = createInMemoryConnectorStore();
    expect(await store.read('gmail')).toBeNull();
    const state = connected();
    await store.write(state);
    expect(await store.read('gmail')).toEqual(state);
    expect(await store.read('calendar')).toBeNull();
  });

  test('the object store round-trips through the tenant prefix', async () => {
    const raw = createInMemoryRawStore();
    const store = createObjectConnectorStore({
      store: raw,
      storage: testStorage(),
      caller: fleetIdentity('tenant-a'),
      tenantId: 'tenant-a',
    });

    const state = connected({ cursor: DELTA });
    await store.write(state);
    expect(await store.read('gmail')).toEqual(state);
    expect(raw.keys.some((key) => key.includes(`/${CONNECTOR_COLLECTION}/gmail`))).toBe(true);
  });

  test('a stored record that is not a state reads as absent, never as a default', async () => {
    expect(parseConnectorState({ source: 'gmail' })).toBeNull();
    expect(parseConnectorState({ ...connected(), source: 'mastodon' })).toBeNull();
    expect(parseConnectorState({ ...connected(), cadenceSeconds: -1 })).toBeNull();
    expect(parseConnectorState({ ...connected(), cursor: { kind: 'sideways', value: 'x' } })).toBeNull();
    expect(parseConnectorState({ ...connected(), externalUserId: '' })).toBeNull();
    expect(parseConnectorState(null)).toBeNull();
    expect(parseConnectorState('nonsense')).toBeNull();
  });

  test('a corrupt stored record does not become a cursor', async () => {
    const raw = createInMemoryRawStore();
    const storage = testStorage();
    const caller = fleetIdentity('tenant-a');
    const store = createObjectConnectorStore({ store: raw, storage, caller, tenantId: 'tenant-a' });

    await store.write(connected({ cursor: DELTA }));
    const key = storage.keyFor(caller, 'tenant-a', [CONNECTOR_COLLECTION, 'gmail']);
    if (!key.ok) throw new Error('the fixture could not build its own key');
    await raw.put(key.key, {
      bytes: new TextEncoder().encode('{"source":"gmail","cursor":{"kind":"delta","value":"h-999"}'),
      contentType: 'application/json',
    });

    // Not a partially-parsed state carrying `h-999`: nothing at all.
    expect(await store.read('gmail')).toBeNull();
  });
});
