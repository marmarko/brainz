/**
 * Reconciliation: turning an authorization the user completed at the vendor
 * into a `ConnectorState` this brain polls.
 *
 * **What this is defending.** `connectSource` had no production caller. The
 * connect link was minted, redeemed at the vendor, and nothing in the fleet was
 * ever told — so `enqueueDuePulls` read no state, queued no `ingest_pull`, and
 * an attached mailbox was invisible here forever. The browser cannot be the
 * channel that fixes it: the user leaves for the vendor and may close the tab.
 *
 * So the channel is the vendor's own account listing, and the cases below are
 * the ones that make asking it safe rather than the one that makes it work. A
 * reconciler that only handles "one account, adopt it" is a reconciler that
 * re-imports a mailbox from scratch the second time it runs, re-enables a
 * connector the tier forbids, and undoes a disconnect the user just pressed.
 *
 * The vendor and the store are in-memory here. The store's *own* concurrency —
 * the fence compare-and-set that makes "reconcile immediately after disconnect"
 * lose — is proved against a real Postgres in
 * `test/control/connector-link.test.ts`; what this file proves is that the
 * reconciler asks for it and honours the answer.
 */

import { describe, expect, test } from 'bun:test';

import {
  connectSource,
  pullModeFor,
  type ConnectorSource,
  type ConnectorState,
} from '../../../src/ingest/cursor.ts';
import {
  externalUserIdFor,
  type ClientOutcome,
  type ConnectedAccount,
  type PipedreamClient,
} from '../../../src/ingest/pipedream/client.ts';
import {
  chooseAccount,
  createPipedreamAccountLister,
  reconcileConnectors,
  type ConnectorAccountLister,
  type ConnectorLinkWriter,
  type ConnectorTierReader,
  type PendingLink,
} from '../../../src/ingest/pipedream/reconcile.ts';

const NOW = new Date('2026-08-17T09:00:00.000Z');
const TENANT = 't-0123456789abcdef01234567';
const OTHER = 't-0123456789abcdef01234568';

function account(overrides: Partial<ConnectedAccount> = {}): ConnectedAccount {
  return {
    accountId: 'apn_this_test_invented_it',
    appSlug: 'gmail',
    dead: false,
    createdAt: '2026-08-17T08:55:00.000Z',
    ...overrides,
  };
}

interface RecordingWriter extends ConnectorLinkWriter {
  readonly adopted: readonly { tenantId: string; source: ConnectorSource; state: ConnectorState }[];
}

/** A writer that accepts everything, so a refusal upstream is visible as silence. */
function writerThatAccepts(): RecordingWriter {
  const adopted: { tenantId: string; source: ConnectorSource; state: ConnectorState }[] = [];
  return {
    get adopted() {
      return adopted;
    },
    adopt(request) {
      adopted.push({ tenantId: request.tenantId, source: request.source, state: request.state });
      return Promise.resolve(true);
    },
  };
}

/** A writer whose compare-and-set always loses: the disconnect, or a rival tick. */
function writerThatLoses(): RecordingWriter {
  const adopted: { tenantId: string; source: ConnectorSource; state: ConnectorState }[] = [];
  return {
    get adopted() {
      return adopted;
    },
    adopt(request) {
      adopted.push({ tenantId: request.tenantId, source: request.source, state: request.state });
      return Promise.resolve(false);
    },
  };
}

interface RecordingLister extends ConnectorAccountLister {
  readonly asked: readonly { tenantId: string; source: ConnectorSource }[];
}

function listerReturning(
  answers: Readonly<Record<string, readonly ConnectedAccount[]>>,
  failures: Readonly<Record<string, true>> = {},
): RecordingLister {
  const asked: { tenantId: string; source: ConnectorSource }[] = [];
  return {
    get asked() {
      return asked;
    },
    accountsFor(request) {
      asked.push({ tenantId: request.tenantId, source: request.source });
      const key = `${request.tenantId}/${request.source}`;
      if (failures[key] === true) {
        return Promise.resolve({ ok: false as const, reason: 'provider_error' as const, status: 502 });
      }
      return Promise.resolve({ ok: true as const, value: answers[key] ?? [] });
    },
  };
}

function tiers(map: Readonly<Record<string, 'free' | 'paid' | 'internal'>>): ConnectorTierReader {
  return { tierFor: (tenantId) => Promise.resolve(map[tenantId] ?? 'free') };
}

function pending(tenantId: string, source: ConnectorSource, fence = 0): PendingLink {
  return { tenantId, source, fence };
}

describe('choosing which account a listing means', () => {
  test('one live account is that account', () => {
    const chosen = chooseAccount('gmail', [account()]);
    expect(chosen.ok).toBe(true);
    if (chosen.ok) expect(chosen.account.accountId).toBe('apn_this_test_invented_it');
  });

  test('an account the vendor marks dead is not a connection to poll', () => {
    const chosen = chooseAccount('gmail', [account({ dead: true })]);
    expect(chosen).toEqual({ ok: false, reason: 'no_account' });
  });

  test('a dead account beside a live one does not make the answer ambiguous', () => {
    // The reconnect-after-revocation shape: the old grant is dead at the vendor
    // and the new one is live. Reading both as candidates would refuse exactly
    // the user who just fixed their connection.
    const chosen = chooseAccount('gmail', [
      account({ accountId: 'apn_old', dead: true, createdAt: '2026-08-01T00:00:00.000Z' }),
      account({ accountId: 'apn_new' }),
    ]);
    expect(chosen.ok).toBe(true);
    if (chosen.ok) expect(chosen.account.accountId).toBe('apn_new');
  });

  test('an account for a different app is refused rather than adopted', () => {
    // The external user id is per source, so this should not happen — but the
    // connect token is not app-scoped, so a user CAN attach Gmail through the
    // calendar link. Writing that state would point the calendar adapter at a
    // mailbox and dead-letter the lane with a provider error nobody can read.
    const chosen = chooseAccount('calendar', [account({ appSlug: 'gmail' })]);
    expect(chosen).toEqual({ ok: false, reason: 'no_account' });
  });

  test('an account whose app the vendor did not name is accepted on the id it was asked under', () => {
    // Fail-open on a field, and only this one: the external user id already
    // binds the listing to one source. Refusing here would mean a vendor field
    // rename silently un-connects every user.
    const chosen = chooseAccount('calendar', [account({ appSlug: null })]);
    expect(chosen.ok).toBe(true);
  });

  test('two live accounts resolve to the newest, which is the last thing the user did', () => {
    const chosen = chooseAccount('gmail', [
      account({ accountId: 'apn_first', createdAt: '2026-08-01T00:00:00.000Z' }),
      account({ accountId: 'apn_second', createdAt: '2026-08-16T00:00:00.000Z' }),
    ]);
    expect(chosen.ok).toBe(true);
    if (chosen.ok) expect(chosen.account.accountId).toBe('apn_second');
  });

  test('two live accounts with no order between them are refused, not guessed', () => {
    // `ConnectorState` holds one account id. Picking the wrong one files a
    // stranger's mail under this brain's origin, and a coin flip is not a thing
    // to do with somebody's mailbox.
    const chosen = chooseAccount('gmail', [
      account({ accountId: 'apn_first', createdAt: null }),
      account({ accountId: 'apn_second', createdAt: '2026-08-16T00:00:00.000Z' }),
    ]);
    expect(chosen).toEqual({ ok: false, reason: 'ambiguous_accounts' });
  });

  test('an empty listing is the ordinary answer while a user is still at the consent screen', () => {
    expect(chooseAccount('gmail', [])).toEqual({ ok: false, reason: 'no_account' });
  });
});

describe('reconciling a pending connect', () => {
  test('an authorization the user never came back from becomes a connection', async () => {
    // The whole point: nothing here is a browser. The link was minted, the user
    // authorized at Google and closed the tab, and this is what notices.
    const vendor = listerReturning({ [`${TENANT}/gmail`]: [account()] });
    const links = writerThatAccepts();

    const result = await reconcileConnectors(
      { vendor, links, tiers: tiers({ [TENANT]: 'paid' }) },
      { pending: [pending(TENANT, 'gmail')], now: NOW },
    );

    expect(result.adopted).toEqual([{ tenantId: TENANT, source: 'gmail' }]);
    expect(links.adopted).toHaveLength(1);

    const written = links.adopted[0]?.state as ConnectorState;
    expect(written.source).toBe('gmail');
    expect(written.accountId).toBe('apn_this_test_invented_it');
    expect(written.externalUserId).toBe(externalUserIdFor(TENANT, 'gmail'));
  });

  test('the state it writes is the shape the first-import gate still sees', async () => {
    // A newly connected mailbox is exactly the unbounded first import the gate
    // exists to bound. A reconciler that invented a cursor to look tidy would
    // make `pullModeFor` answer `delta`, and the first poll would walk past the
    // gate into an un-estimated, un-approved re-list of somebody's mail.
    const vendor = listerReturning({ [`${TENANT}/gmail`]: [account()] });
    const links = writerThatAccepts();

    await reconcileConnectors(
      { vendor, links, tiers: tiers({ [TENANT]: 'paid' }) },
      { pending: [pending(TENANT, 'gmail')], now: NOW },
    );

    const written = links.adopted[0]?.state as ConnectorState;
    expect(written.cursor).toBeNull();
    expect(pullModeFor(written)).toBe('backfill');
    expect(written.backfill).toBeNull();
    expect(written.lastPullAt).toBeNull();
  });

  test('it claims nothing about which mailbox this is', async () => {
    // `accountKey` is the provider's own spelling of the account, adopted from
    // the first listing that reports one and refused if a later listing
    // disagrees. The vendor's account record is a different vocabulary; writing
    // its label here would make the first real pull stop on `identity_changed`
    // against a mailbox that never changed.
    const vendor = listerReturning({ [`${TENANT}/gmail`]: [account()] });
    const links = writerThatAccepts();

    await reconcileConnectors(
      { vendor, links, tiers: tiers({ [TENANT]: 'paid' }) },
      { pending: [pending(TENANT, 'gmail')], now: NOW },
    );

    expect((links.adopted[0]?.state as ConnectorState).accountKey).toBeNull();
  });

  test('a tenant the tier no longer permits is not connected, and is not even asked', async () => {
    // The tier gate refused this account at the connect button. A reconciler
    // that wrote state anyway would re-enable polling — and the monthly vendor
    // fee behind it — for an account that stopped paying. Asked first, so a
    // downgraded tenant costs the vendor nothing either.
    const vendor = listerReturning({ [`${TENANT}/gmail`]: [account()] });
    const links = writerThatAccepts();

    const result = await reconcileConnectors(
      { vendor, links, tiers: tiers({ [TENANT]: 'free' }) },
      { pending: [pending(TENANT, 'gmail')], now: NOW },
    );

    expect(result.adopted).toEqual([]);
    expect(result.refused).toEqual([{ tenantId: TENANT, source: 'gmail', reason: 'tier_forbidden' }]);
    expect(links.adopted).toEqual([]);
    expect(vendor.asked).toEqual([]);
  });

  test('an internal tenant is permitted, because that is what the tier means', async () => {
    const vendor = listerReturning({ [`${TENANT}/gmail`]: [account()] });
    const links = writerThatAccepts();

    const result = await reconcileConnectors(
      { vendor, links, tiers: tiers({ [TENANT]: 'internal' }) },
      { pending: [pending(TENANT, 'gmail')], now: NOW },
    );

    expect(result.adopted).toEqual([{ tenantId: TENANT, source: 'gmail' }]);
  });

  test('a disconnect that lands mid-reconcile wins, and the reconciler does not retry', async () => {
    // The ordering hazard: this pass read the fence, asked the vendor, and by
    // the time it wrote, the user had pressed disconnect. The store refuses the
    // write; a reconciler that answered by re-reading and writing again would be
    // a disconnect button that does not work.
    const vendor = listerReturning({ [`${TENANT}/gmail`]: [account()] });
    const links = writerThatLoses();

    const result = await reconcileConnectors(
      { vendor, links, tiers: tiers({ [TENANT]: 'paid' }) },
      { pending: [pending(TENANT, 'gmail', 3)], now: NOW },
    );

    expect(result.adopted).toEqual([]);
    expect(result.refused).toEqual([{ tenantId: TENANT, source: 'gmail', reason: 'superseded' }]);
    // One attempt. Not two, not a loop.
    expect(links.adopted).toHaveLength(1);
  });

  test('the fence it writes under is the one it read, not one it re-read', async () => {
    const vendor = listerReturning({ [`${TENANT}/gmail`]: [account()] });
    const seen: number[] = [];
    const links: ConnectorLinkWriter = {
      adopt(request) {
        seen.push(request.fence);
        return Promise.resolve(true);
      },
    };

    await reconcileConnectors(
      { vendor, links, tiers: tiers({ [TENANT]: 'paid' }) },
      { pending: [pending(TENANT, 'gmail', 7)], now: NOW },
    );

    expect(seen).toEqual([7]);
  });

  test('a vendor that will not answer refuses this link and leaves the rest of the fleet alone', async () => {
    const vendor = listerReturning(
      { [`${OTHER}/calendar`]: [account({ appSlug: 'google_calendar' })] },
      { [`${TENANT}/gmail`]: true },
    );
    const links = writerThatAccepts();

    const result = await reconcileConnectors(
      { vendor, links, tiers: tiers({ [TENANT]: 'paid', [OTHER]: 'paid' }) },
      { pending: [pending(TENANT, 'gmail'), pending(OTHER, 'calendar')], now: NOW },
    );

    expect(result.refused).toEqual([{ tenantId: TENANT, source: 'gmail', reason: 'vendor_error' }]);
    expect(result.adopted).toEqual([{ tenantId: OTHER, source: 'calendar' }]);
  });

  test('a listing with nothing in it is not a failure — the user has not finished yet', async () => {
    const vendor = listerReturning({});
    const links = writerThatAccepts();

    const result = await reconcileConnectors(
      { vendor, links, tiers: tiers({ [TENANT]: 'paid' }) },
      { pending: [pending(TENANT, 'gmail')], now: NOW },
    );

    expect(result.adopted).toEqual([]);
    expect(result.refused).toEqual([{ tenantId: TENANT, source: 'gmail', reason: 'no_account' }]);
    expect(links.adopted).toEqual([]);
  });

  test('nothing pending is no vendor traffic at all', async () => {
    const vendor = listerReturning({ [`${TENANT}/gmail`]: [account()] });
    const links = writerThatAccepts();

    const result = await reconcileConnectors(
      { vendor, links, tiers: tiers({ [TENANT]: 'paid' }) },
      { pending: [], now: NOW },
    );

    expect(result).toEqual({ asked: 0, adopted: [], refused: [] });
    expect(vendor.asked).toEqual([]);
  });

  test('the calendar link asks under the calendar external user, never the tenant', async () => {
    // Per-source external users are what make `deleteExternalUser` mean
    // "disconnect this source". A reconciler that asked under a tenant-wide id
    // would adopt whichever source happened to answer first.
    const vendor = listerReturning({
      [`${TENANT}/calendar`]: [account({ appSlug: 'google_calendar', accountId: 'apn_cal' })],
    });
    const links = writerThatAccepts();

    await reconcileConnectors(
      { vendor, links, tiers: tiers({ [TENANT]: 'paid' }) },
      { pending: [pending(TENANT, 'calendar')], now: NOW },
    );

    const written = links.adopted[0]?.state as ConnectorState;
    expect(written.externalUserId).toBe(externalUserIdFor(TENANT, 'calendar'));
    expect(written.externalUserId).toBe(`${TENANT}-calendar`);
  });

  test('the cadence it writes is the source’s own default, not a number this pass invented', async () => {
    const vendor = listerReturning({ [`${TENANT}/drive`]: [account({ appSlug: 'google_drive' })] });
    const links = writerThatAccepts();

    await reconcileConnectors(
      { vendor, links, tiers: tiers({ [TENANT]: 'paid' }) },
      { pending: [pending(TENANT, 'drive')], now: NOW },
    );

    const written = links.adopted[0]?.state as ConnectorState;
    const reference = connectSource({
      source: 'drive',
      externalUserId: externalUserIdFor(TENANT, 'drive'),
      now: NOW,
    });
    expect(written.cadenceSeconds).toBe(reference.cadenceSeconds);
  });
});

describe('the vendor port over the real client', () => {
  /**
   * **The external user id is derived, never passed in**, and it is derived per
   * source. `deleteExternalUser` is the only revocation this vendor offers, so
   * whatever an external user id spans is what a disconnect destroys — bind it
   * to the tenant alone and asking about gmail answers for the calendar too,
   * and disconnecting one silently revokes all three.
   */
  test('it asks under this tenant’s per-source external user, and derives it itself', async () => {
    const asked: string[] = [];
    const client = {
      listAccounts(request: { externalUserId: string }): Promise<ClientOutcome<readonly ConnectedAccount[]>> {
        asked.push(request.externalUserId);
        return Promise.resolve({ ok: true as const, value: [] });
      },
    } as unknown as PipedreamClient;

    const lister = createPipedreamAccountLister(client);
    await lister.accountsFor({ tenantId: TENANT, source: 'gmail' });
    await lister.accountsFor({ tenantId: TENANT, source: 'calendar' });

    expect(asked).toEqual([externalUserIdFor(TENANT, 'gmail'), externalUserIdFor(TENANT, 'calendar')]);
    expect(asked).toEqual([`${TENANT}-gmail`, `${TENANT}-calendar`]);
  });
});
