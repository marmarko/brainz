/**
 * The connector link, against a real control plane.
 *
 * **What this table replaced, and why the object prefix could not be it.**
 * `src/ingest/cursor.ts` says a connector's state lives under the tenant's own
 * object prefix — *"not in the control plane, which is content-free by
 * construction and cannot hold a provider token"* — and that sentence was
 * written before `src/control/secret-store.sql` generalised the rule it rests
 * on. There is no production `ScopedCredentialMinter` anywhere in `src/`, so no
 * process in this fleet can obtain the prefix-scoped credential that store
 * needs: `worker/serve.ts` composes an absent object store and says so, and
 * `wrangler.toml` records that the R2 credentials are on no fleet's manifest for
 * exactly that reason. A connector state written there is a connector state
 * written nowhere.
 *
 * The control plane is where the same problem was already solved once: a
 * tenant's connection string had to be shared between three container fleets
 * with no volume between them, so it lives here **sealed**, and the rule became
 * *"the control plane holds nothing a reader of the control plane can use"*.
 * Connector state has that shape exactly — the web fleet records the intent, the
 * worker fleet polls, no volume between them — and its two sensitive fields (a
 * provider sync token, and later the mailbox the provider names) are inside the
 * envelope rather than in a column.
 *
 * **What this file proves that a unit test with a fake store cannot.** Every
 * property that matters here is a property of one SQL statement under
 * concurrency: create-only, the disconnect fence, and the cursor that must
 * survive both. A `Map` standing in for the table would pass all of them by
 * accident.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';

import {
  createPostgresConnectorLinks,
  ensureConnectorLinkSchema,
  fenceConnectorLink,
  markConnectPending,
  type ConnectorLinks,
} from '../../src/control/connector-pg.ts';
import { generateSealingKeyMaterial, importSealingKey, seal } from '../../src/control/sealed.ts';
import { connectSource, type ConnectorState } from '../../src/ingest/cursor.ts';
import { createControlPlane, dropControlPlane, seedTenant, type ControlFixture } from '../worker/fixture.ts';

const NOW = new Date('2026-08-17T09:00:00.000Z');
const TENANT = 't-0123456789abcdef01234567';
const OTHER = 't-0123456789abcdef01234568';

let fixture: ControlFixture;
let sql: SQL;
let key: CryptoKey;
let links: ConnectorLinks;

beforeAll(async () => {
  fixture = await createControlPlane('connector_link');
  sql = new SQL(fixture.dsn, { max: 2 });
  await ensureConnectorLinkSchema(sql);
  key = await importSealingKey(generateSealingKeyMaterial());
  links = createPostgresConnectorLinks({ sql, key });
}, 120_000);

afterAll(async () => {
  await sql?.close();
  if (fixture !== undefined) await dropControlPlane(fixture);
});

beforeEach(async () => {
  await sql`DELETE FROM control.connector_link`;
  await sql`DELETE FROM control.tenant`;
  await seedTenant(sql, TENANT);
  await seedTenant(sql, OTHER);
});

function freshState(tenantId = TENANT, source: 'gmail' | 'calendar' | 'drive' = 'gmail'): ConnectorState {
  return connectSource({
    source,
    externalUserId: `${tenantId}-${source}`,
    accountId: 'apn_this_test_invented_it',
    now: NOW,
  });
}

async function rowFor(tenantId: string, source: string): Promise<{ state: string | null; fence: string; pending_since: Date | null }> {
  const rows = (await sql`
    SELECT state, fence::text AS fence, pending_since
      FROM control.connector_link
     WHERE tenant_id = ${tenantId} AND source = ${source}::control.connector_source
  `) as unknown as { state: string | null; fence: string; pending_since: Date | null }[];
  const row = rows[0];
  if (row === undefined) throw new Error(`no connector_link row for ${tenantId}/${source}`);
  return row;
}

describe('recording that a user pressed connect', () => {
  test('a pending link is what reconciliation is allowed to ask about', async () => {
    await markConnectPending(sql, { tenantId: TENANT, source: 'gmail', now: NOW });

    expect(await links.pending({ now: NOW })).toEqual([
      { tenantId: TENANT, source: 'gmail', fence: 0 },
    ]);
  });

  test('pressing connect twice is one pending link, not two', async () => {
    await markConnectPending(sql, { tenantId: TENANT, source: 'gmail', now: NOW });
    await markConnectPending(sql, {
      tenantId: TENANT,
      source: 'gmail',
      now: new Date(NOW.getTime() + 60_000),
    });

    expect(await links.pending({ now: NOW })).toHaveLength(1);
  });

  test('a link nobody finished stops being asked about', async () => {
    // A user who opened the consent screen and walked away is not a vendor round
    // trip forever. The window is the connect link's own useful life, generously.
    await markConnectPending(sql, { tenantId: TENANT, source: 'gmail', now: NOW });

    const later = new Date(NOW.getTime() + 40 * 60 * 60 * 1_000);
    expect(await links.pending({ now: later })).toEqual([]);
  });

  test('a connected link is not pending, so a connected source is never re-asked', async () => {
    await markConnectPending(sql, { tenantId: TENANT, source: 'gmail', now: NOW });
    expect(await links.adopt({ tenantId: TENANT, source: 'gmail', fence: 0, state: freshState() })).toBe(true);

    expect(await links.pending({ now: NOW })).toEqual([]);
  });

  test('one tenant’s view is that tenant’s alone', async () => {
    await markConnectPending(sql, { tenantId: TENANT, source: 'gmail', now: NOW });
    await markConnectPending(sql, { tenantId: OTHER, source: 'drive', now: NOW });

    expect(await links.pending({ now: NOW, tenantId: OTHER })).toEqual([
      { tenantId: OTHER, source: 'drive', fence: 0 },
    ]);
  });
});

describe('adopting a connection', () => {
  beforeEach(async () => {
    await markConnectPending(sql, { tenantId: TENANT, source: 'gmail', now: NOW });
  });

  test('what is stored is an envelope, not the state', async () => {
    await links.adopt({ tenantId: TENANT, source: 'gmail', fence: 0, state: freshState() });

    const row = await rowFor(TENANT, 'gmail');
    expect(row.state).toMatch(/^v1[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]{22,}$/);
    // Nothing about the connection is legible to a reader of this database.
    expect(row.state).not.toContain('apn_');
    expect(row.state).not.toContain('gmail');
  });

  test('it reads back as the state that was written', async () => {
    const state = freshState();
    await links.adopt({ tenantId: TENANT, source: 'gmail', fence: 0, state });

    expect(await links.states(TENANT)).toEqual([state]);
  });

  test('adopting twice writes once — the second pass cannot reset a cursor', async () => {
    // The trap the whole design turns on. `ConnectorState` carries the cursor;
    // a second reconciliation that overwrote it with a fresh state would send
    // `pullModeFor` back to `backfill` and re-import the mailbox from scratch.
    await links.adopt({ tenantId: TENANT, source: 'gmail', fence: 0, state: freshState() });

    const store = links.storeFor(TENANT);
    const held = await store.read('gmail');
    await store.write({
      ...(held as ConnectorState),
      cursor: { kind: 'delta', value: 'history-4711', issuedAt: NOW.toISOString() },
      lastPullAt: NOW.toISOString(),
    });

    const second = await links.adopt({ tenantId: TENANT, source: 'gmail', fence: 0, state: freshState() });

    expect(second).toBe(false);
    const [after] = await links.states(TENANT);
    expect(after?.cursor).toEqual({ kind: 'delta', value: 'history-4711', issuedAt: NOW.toISOString() });
  });

  test('a fence that moved refuses the write', async () => {
    await fenceConnectorLink(sql, { tenantId: TENANT, source: 'gmail', now: NOW });

    expect(await links.adopt({ tenantId: TENANT, source: 'gmail', fence: 0, state: freshState() })).toBe(false);
    expect((await rowFor(TENANT, 'gmail')).state).toBeNull();
  });

  test('a state carrying a long provider cursor still fits the column', async () => {
    // A continuation token is opaque and its length is the provider's business.
    // A CHECK violation here would land on a *cursor advance*, which is a
    // connector that polls once and then wedges — so the bound is checked with
    // a token far past anything Google has been observed to issue.
    const state: ConnectorState = {
      ...freshState(),
      cursor: { kind: 'backfill', value: 'x'.repeat(1_500), issuedAt: NOW.toISOString() },
    };
    await links.adopt({ tenantId: TENANT, source: 'gmail', fence: 0, state });

    const [read] = await links.states(TENANT);
    expect(read?.cursor?.value).toHaveLength(1_500);
  });
});

describe('the cursor, once a pull is advancing it', () => {
  beforeEach(async () => {
    await markConnectPending(sql, { tenantId: TENANT, source: 'gmail', now: NOW });
    await links.adopt({ tenantId: TENANT, source: 'gmail', fence: 0, state: freshState() });
  });

  test('a write lands', async () => {
    const store = links.storeFor(TENANT);
    const held = (await store.read('gmail')) as ConnectorState;
    await store.write({ ...held, cursor: { kind: 'delta', value: 'h-1', issuedAt: NOW.toISOString() } });

    expect((await links.states(TENANT))[0]?.cursor?.value).toBe('h-1');
  });

  test('a write from a pull the user disconnected under is dropped, not resurrected', async () => {
    // The `ingest_pull` handler reads the state, spends a minute against the
    // provider and writes the cursor back. If the user pressed disconnect in
    // between, that write must not put the connection back — the runner would
    // then poll with a credential we have already asked the vendor to revoke.
    const store = links.storeFor(TENANT);
    const held = (await store.read('gmail')) as ConnectorState;

    await fenceConnectorLink(sql, { tenantId: TENANT, source: 'gmail', now: NOW });

    await store.write({ ...held, cursor: { kind: 'delta', value: 'h-2', issuedAt: NOW.toISOString() } });

    expect((await rowFor(TENANT, 'gmail')).state).toBeNull();
    expect(await links.states(TENANT)).toEqual([]);
  });

  test('a disconnected source reads as not connected rather than as an error', async () => {
    await fenceConnectorLink(sql, { tenantId: TENANT, source: 'gmail', now: NOW });

    expect(await links.storeFor(TENANT).read('gmail')).toBeNull();
  });
});

describe('disconnect', () => {
  beforeEach(async () => {
    await markConnectPending(sql, { tenantId: TENANT, source: 'gmail', now: NOW });
    await links.adopt({ tenantId: TENANT, source: 'gmail', fence: 0, state: freshState() });
  });

  test('it clears the state and forgets the intent in one statement', async () => {
    await fenceConnectorLink(sql, { tenantId: TENANT, source: 'gmail', now: NOW });

    const row = await rowFor(TENANT, 'gmail');
    expect(row.state).toBeNull();
    expect(row.pending_since).toBeNull();
    expect(row.fence).toBe('1');
    // And it is not pending, so the next reconciliation pass does not ask about
    // it at all — the fence is the backstop, not the mechanism.
    expect(await links.pending({ now: NOW })).toEqual([]);
  });

  test('the fence only ever advances, so two disconnects cannot alias', async () => {
    await fenceConnectorLink(sql, { tenantId: TENANT, source: 'gmail', now: NOW });
    await fenceConnectorLink(sql, { tenantId: TENANT, source: 'gmail', now: NOW });

    expect((await rowFor(TENANT, 'gmail')).fence).toBe('2');
  });

  test('disconnecting a source nobody connected is not an error', async () => {
    // `handleDisconnect` runs this before it tells the vendor anything, and the
    // vendor is the authority on whether an account exists. A throw here would
    // turn a user pressing disconnect on an already-clean source into a 500.
    await fenceConnectorLink(sql, { tenantId: OTHER, source: 'drive', now: NOW });

    expect((await rowFor(OTHER, 'drive')).fence).toBe('1');
  });

  test('it touches one source, not the tenant’s others', async () => {
    await markConnectPending(sql, { tenantId: TENANT, source: 'calendar', now: NOW });
    await links.adopt({
      tenantId: TENANT,
      source: 'calendar',
      fence: 0,
      state: freshState(TENANT, 'calendar'),
    });

    await fenceConnectorLink(sql, { tenantId: TENANT, source: 'gmail', now: NOW });

    expect((await links.states(TENANT)).map((state) => state.source)).toEqual(['calendar']);
  });
});

describe('the seal', () => {
  test('a state sealed for one tenant does not open under another', async () => {
    // The namespace is the additional authenticated data, so a row lifted from
    // one tenant and pasted over another fails to open rather than handing
    // tenant B tenant A's mailbox.
    await markConnectPending(sql, { tenantId: TENANT, source: 'gmail', now: NOW });
    await links.adopt({ tenantId: TENANT, source: 'gmail', fence: 0, state: freshState() });
    const stolen = (await rowFor(TENANT, 'gmail')).state;

    await markConnectPending(sql, { tenantId: OTHER, source: 'gmail', now: NOW });
    await sql`
      UPDATE control.connector_link
         SET state = ${stolen}, pending_since = NULL
       WHERE tenant_id = ${OTHER} AND source = 'gmail'::control.connector_source`;

    expect(links.states(OTHER)).rejects.toThrow();
  });

  test('a fleet booted with the wrong key looks broken, not empty', async () => {
    // The rule `secrets.ts` states: "the store is down" and "this tenant does
    // not exist" are different sentences. Answering `[]` here would make a
    // key rotation look like a fleet where nobody has ever connected anything —
    // and, because adoption is create-only, nothing would ever repair it.
    await markConnectPending(sql, { tenantId: TENANT, source: 'gmail', now: NOW });
    await links.adopt({ tenantId: TENANT, source: 'gmail', fence: 0, state: freshState() });

    const wrong = createPostgresConnectorLinks({
      sql,
      key: await importSealingKey(generateSealingKeyMaterial()),
    });

    expect(wrong.states(TENANT)).rejects.toThrow();
  });

  test('a well-sealed envelope that is not a connector state is refused too', async () => {
    // Sealed is not the same as valid. A worker spends money on what this record
    // says, so a record that opens and then does not parse is a broken fleet
    // rather than a source with a surprising cadence.
    await markConnectPending(sql, { tenantId: TENANT, source: 'gmail', now: NOW });
    const nonsense = await seal(key, `connector/${TENANT}/gmail`, JSON.stringify({ source: 'gmail' }));
    await sql`
      UPDATE control.connector_link
         SET state = ${nonsense}, pending_since = NULL
       WHERE tenant_id = ${TENANT} AND source = 'gmail'::control.connector_source`;

    expect(links.states(TENANT)).rejects.toThrow();
  });
});

describe('the schema', () => {
  test('applying it twice is not an error', async () => {
    await ensureConnectorLinkSchema(sql);
    await ensureConnectorLinkSchema(sql);
    expect(await links.pending({ now: NOW })).toEqual([]);
  });

  test('a deleted tenant takes its connector links with it', async () => {
    // A sealed connector state that outlived its tenant is a record about
    // somebody who asked to be forgotten, sitting in the one database an
    // operator dumps.
    await markConnectPending(sql, { tenantId: TENANT, source: 'gmail', now: NOW });
    await links.adopt({ tenantId: TENANT, source: 'gmail', fence: 0, state: freshState() });

    await sql`DELETE FROM control.tenant WHERE tenant_id = ${TENANT}`;

    const rows = (await sql`
      SELECT count(*)::int AS n FROM control.connector_link WHERE tenant_id = ${TENANT}
    `) as unknown as { n: number }[];
    expect(rows[0]?.n).toBe(0);
  });
});
