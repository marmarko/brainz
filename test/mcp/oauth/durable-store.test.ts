/**
 * The authorization store, against a real control-plane database.
 *
 * **The property, stated so it cannot be satisfied by accident:** a client
 * registered at T, a refresh token issued at T and a revocation recorded at T
 * are all still honoured after every container serving the fleet has been
 * destroyed and replaced. So every durability case below builds the reader
 * separately from the writer, over a *different* connection, *after* the writer
 * has been closed — the shape `test/control/secret-durability.test.ts` settled,
 * for the same reason: a round trip through one object proves nothing, and that
 * is exactly what the in-memory store passed every time while the deployment it
 * shipped into forgot the founder's connector every fifteen minutes.
 *
 * **The contract suite runs over BOTH implementations.** The in-memory store
 * stays — for tests and for a single-instance self-hoster — and two stores that
 * disagree about single-use, about tenant-keying or about the rate window is a
 * bug that only shows up in production. So the semantics are asserted once,
 * against each.
 *
 * The cases that are only meaningful in SQL — the concurrent redeem, what the
 * bytes at rest are, the sweep and its retention — are Postgres-only and say so.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';

import {
  AuthorizationStoreError,
  REVOCATION_RETENTION_SECONDS,
  createPostgresAuthorizationStore,
  ensureAuthorizationStoreSchema,
  purgeExpiredAuthorizationState,
} from '../../../src/control/oauth-pg.ts';
import { importSealingKey } from '../../../src/control/sealed.ts';
import {
  DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
  DEFAULT_REFRESH_TOKEN_TTL_SECONDS,
  MAX_CLIENT_NAME_LENGTH,
  MAX_REDIRECT_URIS,
  authorize,
  createInMemoryAuthorizationStore,
  hashToken,
  isMintableGrantId,
  issueTokens,
  mintClientId,
  mintGrantId,
  redeemAuthorizationCode,
  registerClient,
  type AuthorizationStore,
  type ClientRecord,
  type CodeRecord,
  type RefreshRecord,
} from '../../../src/mcp/oauth.ts';
import { createControlPlane, dropControlPlane, type ControlFixture } from '../../worker/fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;

/** Thirty-two zero bytes. See `test/fleet/fixture.ts:FAKE_SEALING_KEY`. */
const KEY_A = 'A'.repeat(43);
/** Thirty-two bytes of something else, for the wrong-key case. */
const KEY_B = 'B'.repeat(43);

const TENANT = 't-durablestore0000000001';
const OTHER_TENANT = 't-durablestore0000000002';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const T0 = Date.UTC(2026, 7, 17, 9, 0, 0);

let control: ControlFixture;
/** The writer's handle — the flow instance's, and it is closed on purpose. */
let writerSql: SQL;

beforeAll(async () => {
  control = await createControlPlane('oauthstore');
  writerSql = new SQL(control.dsn, { max: 4 });
  // The fixture applies `schema.sql`, which is the live control plane's state:
  // no authorization store until a fleet creates one.
  await ensureAuthorizationStoreSchema(writerSql);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await writerSql?.close();
  if (control !== undefined) await dropControlPlane(control);
});

beforeEach(async () => {
  await writerSql`DELETE FROM control.oauth_client`;
  await writerSql`DELETE FROM control.oauth_code`;
  await writerSql`DELETE FROM control.oauth_refresh`;
  await writerSql`DELETE FROM control.oauth_revocation`;
  await writerSql`DELETE FROM control.oauth_registration`;
});

async function durableStore(
  sql: SQL = writerSql,
  options: { key?: string; now?: () => number } = {},
): Promise<AuthorizationStore> {
  return createPostgresAuthorizationStore({
    sql,
    key: await importSealingKey(options.key ?? KEY_A),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

/** A reader with nothing in common with the writer but the database. */
async function openReader(): Promise<{ store: AuthorizationStore; close(): Promise<void> }> {
  const sql = new SQL(control.dsn, { max: 1 });
  return { store: await durableStore(sql), close: () => sql.close() };
}

function clientRecord(overrides: Partial<ClientRecord> = {}): ClientRecord {
  return {
    clientId: mintClientId(),
    clientName: 'Claude',
    redirectUris: [REDIRECT],
    registeredAt: T0,
    ...overrides,
  };
}

function codeRecord(overrides: Partial<CodeRecord> = {}): CodeRecord {
  return {
    clientId: mintClientId(),
    redirectUri: REDIRECT,
    codeChallenge: 'x'.repeat(43),
    tenantId: TENANT,
    scope: 'whole_brain',
    origins: [],
    writeOrigin: 'personal:agent',
    endpoint: 'mcp',
    grantId: mintGrantId(),
    issuedAt: T0,
    expiresAt: T0 + 60_000,
    ...overrides,
  };
}

function refreshRecord(overrides: Partial<RefreshRecord> = {}): RefreshRecord {
  return {
    clientId: mintClientId(),
    tenantId: TENANT,
    scope: 'narrowed',
    origins: ['work:mail', 'work:agent'],
    writeOrigin: 'work:agent',
    endpoint: 'mcp',
    grantId: mintGrantId(),
    expiresAt: T0 + DEFAULT_REFRESH_TOKEN_TTL_SECONDS * 1000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The contract, asserted against every implementation.
// ---------------------------------------------------------------------------

const IMPLEMENTATIONS: readonly {
  readonly name: string;
  readonly open: () => Promise<AuthorizationStore>;
}[] = [
  { name: 'in-memory', open: async () => createInMemoryAuthorizationStore() },
  { name: 'durable', open: () => durableStore() },
];

for (const implementation of IMPLEMENTATIONS) {
  describe(`the ${implementation.name} store answers the contract`, () => {
    test('a client written is a client read back', async () => {
      const store = await implementation.open();
      const record = clientRecord();
      await store.putClient(record);

      const found = await store.getClient(record.clientId);
      expect(found?.clientId).toBe(record.clientId);
      expect(found?.clientName).toBe('Claude');
      expect(found?.redirectUris).toEqual([REDIRECT]);
      expect(found?.registeredAt).toBe(T0);
    });

    test('an unknown client is undefined, not an error', async () => {
      const store = await implementation.open();
      expect(await store.getClient(mintClientId())).toBeUndefined();
    });

    test('a code is single-use', async () => {
      const store = await implementation.open();
      const record = codeRecord();
      await store.putCode('code-alpha', record);

      const first = await store.takeCode('code-alpha');
      expect(first?.grantId).toBe(record.grantId);
      expect(await store.takeCode('code-alpha')).toBeUndefined();
    });

    test('a code round-trips every field the mint decided', async () => {
      const store = await implementation.open();
      const record = codeRecord({ scope: 'narrowed', origins: ['work:mail'], writeOrigin: 'work:agent', endpoint: 'openai' });
      await store.putCode('code-beta', record);
      expect(await store.takeCode('code-beta')).toEqual(record);
    });

    test('a refresh token is single-use, which is what makes theft detectable', async () => {
      const store = await implementation.open();
      const record = refreshRecord();
      const digest = hashToken('bzr_whatever');
      await store.putRefresh(digest, record);

      expect(await store.takeRefresh(digest)).toEqual(record);
      expect(await store.takeRefresh(digest)).toBeUndefined();
    });

    test('a revocation is keyed on the tenant as well as the grant', async () => {
      const store = await implementation.open();
      const grantId = mintGrantId();
      await store.revokeGrant(TENANT, grantId);

      expect(await store.isRevoked(TENANT, grantId)).toBe(true);
      // The whole reason the key is a pair: a grant id is the only thing
      // `/revoke` receives from its caller, so a list keyed on it alone is a
      // list any authenticated tenant can write into a stranger's row of.
      expect(await store.isRevoked(OTHER_TENANT, grantId)).toBe(false);
    });

    test('revoking the same grant twice is not an error', async () => {
      const store = await implementation.open();
      const grantId = mintGrantId();
      await store.revokeGrant(TENANT, grantId);
      await store.revokeGrant(TENANT, grantId);
      expect(await store.isRevoked(TENANT, grantId)).toBe(true);
    });

    test('the registration window counts inside it and not outside it', async () => {
      const store = await implementation.open();
      await store.noteRegistration(T0 - 2 * 60 * 60 * 1000);
      await store.noteRegistration(T0 - 30 * 60 * 1000);
      await store.noteRegistration(T0);

      expect(await store.registrationsSince(T0 - 60 * 60 * 1000)).toBe(2);
      expect(await store.registrationsSince(T0 - 3 * 60 * 60 * 1000)).toBe(3);
      expect(await store.registrationsSince(T0 + 1)).toBe(0);
    });
  });
}

// ---------------------------------------------------------------------------
// Durability: the reader is built after the writer is gone.
// ---------------------------------------------------------------------------

describe('the durable store outlives every container that wrote to it', () => {
  test('a client registered by one instance is known to another built after it closed', async () => {
    const sql = new SQL(control.dsn, { max: 1 });
    const record = clientRecord();
    await (await durableStore(sql)).putClient(record);
    await sql.close();

    const reader = await openReader();
    try {
      const found = await reader.store.getClient(record.clientId);
      expect(found?.clientName).toBe('Claude');
      expect(found?.redirectUris).toEqual([REDIRECT]);
    } finally {
      await reader.close();
    }
  });

  test('a refresh token issued by one instance is redeemable by another built after it closed', async () => {
    const sql = new SQL(control.dsn, { max: 1 });
    const record = refreshRecord();
    const digest = hashToken('bzr_survives-the-container');
    await (await durableStore(sql)).putRefresh(digest, record);
    await sql.close();

    const reader = await openReader();
    try {
      expect(await reader.store.takeRefresh(digest)).toEqual(record);
    } finally {
      await reader.close();
    }
  });

  test('a revocation recorded on one instance is honoured on another built after it closed', async () => {
    // The consequence that is not merely an outage. Before this store, a
    // revocation lived in the flow instance's `Set` and a tool call read the
    // tenant instance's — so a grant the user retired kept working, and a
    // restart brought it back even on the instance that recorded it.
    const sql = new SQL(control.dsn, { max: 1 });
    const grantId = mintGrantId();
    await (await durableStore(sql)).revokeGrant(TENANT, grantId);
    await sql.close();

    const reader = await openReader();
    try {
      expect(await reader.store.isRevoked(TENANT, grantId)).toBe(true);
    } finally {
      await reader.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The race the in-memory store got for free.
// ---------------------------------------------------------------------------

describe('a code cannot be redeemed twice, under concurrency', () => {
  test('two simultaneous takes produce exactly one winner', async () => {
    // In memory, read-then-delete was one turn of the event loop. In SQL a
    // SELECT followed by a DELETE has a window in it, and two redemptions of
    // one consent both walk through — two access tokens from one authorization.
    // Each take runs on its own connection, so the two really are concurrent
    // rather than serialised by a pool of one.
    //
    // **Both stores are built, and both connections are warmed, BEFORE either
    // take is issued — and that is the whole difference between this case and a
    // decorative one.** Written the obvious way, as
    // `Promise.all([(await durableStore(a)).takeCode(…), (await durableStore(b)).takeCode(…)])`,
    // the array's second element does not begin evaluating until its first has
    // suspended, so the `await importSealingKey(…)` inside `durableStore(b)` —
    // and, the first time a handle is used, the whole TCP+startup handshake —
    // runs while connection `a`'s statement is already on the wire. The two
    // takes are then sequential in every run, and a SELECT-then-DELETE
    // implementation (sequentially correct, racy under load) passes. Measured:
    // that shape survived this case and was caught only by the stampede below.
    // Hoisting the construction out makes the two dispatches one synchronous
    // tick, and the same mutation dies here.
    const a = new SQL(control.dsn, { max: 1 });
    const b = new SQL(control.dsn, { max: 1 });
    try {
      const record = codeRecord();
      const [first, second] = [await durableStore(a), await durableStore(b)];
      await first.putCode('code-contended', record);
      // Warm both connections: an unopened handle pays for its handshake inside
      // the first statement, which would serialise the race by accident.
      await Promise.all([a`SELECT 1`, b`SELECT 1`]);

      const taken = await Promise.all([
        first.takeCode('code-contended'),
        second.takeCode('code-contended'),
      ]);

      const winners = taken.filter((entry) => entry !== undefined);
      expect(winners).toHaveLength(1);
      expect(winners[0]?.grantId).toBe(record.grantId);
    } finally {
      await a.close();
      await b.close();
    }
  });

  test('a hundred simultaneous takes still produce exactly one winner', async () => {
    const record = codeRecord();
    const store = await durableStore();
    await store.putCode('code-stampede', record);

    const attempts = await Promise.all(
      Array.from({ length: 100 }, () => store.takeCode('code-stampede')),
    );
    expect(attempts.filter((taken) => taken !== undefined)).toHaveLength(1);
  });

  test('the redeem path itself refuses the second attempt', async () => {
    // The store-level case above proves the statement; this one proves the
    // function `/token` actually calls inherits it, including the rule that a
    // wrong verifier burns the code rather than licensing a brute force.
    const store = await durableStore();
    const verifier = 'v'.repeat(64);
    const record = codeRecord({ codeChallenge: pkceChallenge(verifier) });
    await store.putCode('code-redeemed', record);

    const request = {
      code: 'code-redeemed',
      codeVerifier: verifier,
      redirectUri: record.redirectUri,
      clientId: record.clientId,
      now: T0 + 1_000,
    };
    const first = await redeemAuthorizationCode(store, request);
    expect(first.ok).toBe(true);
    const second = await redeemAuthorizationCode(store, request);
    expect(second.ok).toBe(false);
  });
});

function pkceChallenge(verifier: string): string {
  return Buffer.from(new Bun.CryptoHasher('sha256').update(verifier, 'ascii').digest()).toString(
    'base64url',
  );
}

// ---------------------------------------------------------------------------
// A credential is banked before it is handed out.
// ---------------------------------------------------------------------------

describe('nothing is issued before the store has it', () => {
  /** A store whose one write is held open until the test lets it finish. */
  function gated(store: AuthorizationStore, method: 'putCode' | 'putRefresh') {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let banked = false;
    const gatedStore: AuthorizationStore = {
      ...store,
      async putCode(code, record) {
        if (method === 'putCode') {
          await gate;
          banked = true;
        }
        await store.putCode(code, record);
      },
      async putRefresh(hash, record) {
        if (method === 'putRefresh') {
          await gate;
          banked = true;
        }
        await store.putRefresh(hash, record);
      },
    };
    return { store: gatedStore, release: () => release(), banked: () => banked };
  }

  /** Enough turns of the microtask queue for an unawaited write to have escaped. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  }

  test('issueTokens does not resolve until the refresh record is written', async () => {
    // `void store.putRefresh(...)` reads as a harmless optimisation and is the
    // reported failure in miniature: a client holding a refresh token the store
    // does not is exactly what "the connector broke after fifteen minutes"
    // looked like. Held open here rather than raced, so the case is a fact
    // about ordering rather than about scheduling luck.
    const gate = gated(createInMemoryAuthorizationStore(), 'putRefresh');
    let settled = false;
    const issuing = issueTokens(gate.store, {
      grant: {
        grantId: mintGrantId(),
        tenantId: TENANT,
        scope: 'whole_brain',
        origins: [],
        writeOrigin: 'personal:agent',
        endpoint: 'mcp',
        clientId: mintClientId(),
      },
      signingKey: 'a-signing-key',
      now: T0,
    }).then((tokens) => {
      settled = true;
      return tokens;
    });

    await settle();
    expect(settled).toBe(false);
    expect(gate.banked()).toBe(false);

    gate.release();
    const tokens = await issuing;
    expect(gate.banked()).toBe(true);
    expect(await gate.store.takeRefresh(hashToken(tokens.refresh_token))).toBeDefined();
  });

  test('authorize does not return a redirect until the code is written', async () => {
    // The same property one hop earlier: a browser sent to the client with a
    // code the store has not banked fails at `/token` as `invalid_grant` — a
    // routing fault wearing a client error.
    const base = createInMemoryAuthorizationStore();
    const client = clientRecord();
    await base.putClient(client);
    const gate = gated(base, 'putCode');

    let settled = false;
    const authorizing = authorize(gate.store, {
      clientId: client.clientId,
      redirectUri: REDIRECT,
      codeChallenge: 'c'.repeat(43),
      codeChallengeMethod: 'S256',
      state: 'opaque-state',
      tenantId: TENANT,
      scope: 'whole_brain',
      origins: [],
      writeOrigin: 'personal:agent',
      endpoint: 'mcp',
      now: T0,
    }).then((outcome) => {
      settled = true;
      return outcome;
    });

    await settle();
    expect(settled).toBe(false);

    gate.release();
    const outcome = await authorizing;
    expect(outcome.ok).toBe(true);
    expect(gate.banked()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What is at rest, and what is not.
// ---------------------------------------------------------------------------

describe('the bytes at rest are useless to a reader of the database', () => {
  test('the code is not stored — only a digest of it', async () => {
    const store = await durableStore();
    await store.putCode('code-secret-value', codeRecord());

    const rows = (await writerSql`
      SELECT code_digest, sealed FROM control.oauth_code
    `) as Array<{ code_digest: string; sealed: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.code_digest).toBe(hashToken('code-secret-value'));
    expect(rows[0]?.code_digest).not.toBe('code-secret-value');
    // And the body is not readable either: the tenant, the fence origins and
    // the write origin are the grant that is about to be minted.
    expect(rows[0]?.sealed).toStartWith('v1.');
    expect(rows[0]?.sealed).not.toContain(TENANT);
    expect(rows[0]?.sealed).not.toContain(REDIRECT);
  });

  test('the refresh record is sealed, and the token was never offered to the store', async () => {
    const store = await durableStore();
    await store.putRefresh(hashToken('bzr_a-real-credential'), refreshRecord());

    const rows = (await writerSql`
      SELECT token_digest, sealed FROM control.oauth_refresh
    `) as Array<{ token_digest: string; sealed: string }>;
    expect(rows[0]?.token_digest).toBe(hashToken('bzr_a-real-credential'));
    expect(rows[0]?.sealed).not.toContain('work:mail');
  });

  test('the client record is sealed because the column cannot hold a URL, not because it is secret', async () => {
    // Said in the assertion as well as in the comment: what is proven here is
    // that the redirect URI is not in the column. The client itself is public
    // — `token_endpoint_auth_method: none`, no client secret, and its redirect
    // is already the deployment's own allowlist.
    const store = await durableStore();
    await store.putClient(clientRecord());

    const rows = (await writerSql`SELECT sealed FROM control.oauth_client`) as Array<{
      sealed: string;
    }>;
    expect(rows[0]?.sealed).not.toContain('claude.ai');
    expect(rows[0]?.sealed).not.toContain('Claude');
  });

  test('a revocation is in the clear, because two ids and a timestamp are what this database holds', async () => {
    const grantId = mintGrantId();
    await (await durableStore()).revokeGrant(TENANT, grantId);

    const rows = (await writerSql`
      SELECT tenant_id, grant_id FROM control.oauth_revocation
    `) as Array<{ tenant_id: string; grant_id: string }>;
    expect(rows).toEqual([{ tenant_id: TENANT, grant_id: grantId }]);
  });

  test('an envelope lifted onto another row key does not open', async () => {
    // The namespace is the AAD, so a row copied from one client onto another
    // fails to open rather than handing over the neighbour's registration —
    // the property `sealed.ts` already buys for tenants.
    const store = await durableStore();
    const mine = clientRecord();
    await store.putClient(mine);

    const [row] = (await writerSql`
      SELECT sealed FROM control.oauth_client WHERE client_id = ${mine.clientId}
    `) as Array<{ sealed: string }>;
    const transplanted = mintClientId();
    await writerSql`
      INSERT INTO control.oauth_client (client_id, sealed, registered_at)
      VALUES (${transplanted}, ${row!.sealed}, ${new Date(T0)})
    `;

    expect(store.getClient(transplanted)).rejects.toBeInstanceOf(Error);
  });

  test('a store booted with the wrong key looks broken, not like a database that lost every client', async () => {
    await (await durableStore()).putClient(clientRecord({ clientId: 'bzc_wrongkeyprobe000001' }));
    const wrongKey = await durableStore(writerSql, { key: KEY_B });
    expect(wrongKey.getClient('bzc_wrongkeyprobe000001')).rejects.toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// The revocation endpoint's input, which is a caller's string.
// ---------------------------------------------------------------------------

describe('a grant id admitted by the mint is admitted by the store, and nothing else is', () => {
  test('every id the mint can produce is storable and readable', async () => {
    // The direction that matters most: a domain tightened past what `authorize`
    // mints silently drops a REAL revocation, which is the security property
    // failing open in a new place.
    const store = await durableStore();
    const minted = Array.from({ length: 1000 }, () => mintGrantId());
    for (const id of minted) expect(isMintableGrantId(id)).toBe(true);

    const sample = minted.slice(0, 40);
    for (const id of sample) await store.revokeGrant(TENANT, id);
    for (const id of sample) expect(await store.isRevoked(TENANT, id)).toBe(true);
  });

  test('a grant id no mint could have produced is ignored, not raised', async () => {
    // `/revoke` reads `grant_id` off a form body, so an arbitrary caller string
    // reaches this store. RFC 7009 says revocation answers 200 whether or not
    // the token was known, so a CHECK violation surfacing as a 500 would be the
    // wrong answer twice — and a row would be a free write amplifier.
    const store = await durableStore();
    for (const hostile of [
      'a note about the meeting',
      'g_' + 'x'.repeat(10_000),
      "g_'; DROP TABLE control.oauth_revocation; --",
      'https://evil.example/callback',
      '',
    ]) {
      await store.revokeGrant(TENANT, hostile);
      expect(await store.isRevoked(TENANT, hostile)).toBe(false);
    }

    const [counted] = (await writerSql`
      SELECT count(*)::int AS n FROM control.oauth_revocation
    `) as Array<{ n: number }>;
    expect(counted?.n).toBe(0);
  });

  test('a tenant id outside the alphabet is ignored too', async () => {
    const store = await durableStore();
    await store.revokeGrant('NOT A TENANT', mintGrantId());
    const [counted] = (await writerSql`
      SELECT count(*)::int AS n FROM control.oauth_revocation
    `) as Array<{ n: number }>;
    expect(counted?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Registration, bounded before it reaches a column.
// ---------------------------------------------------------------------------

describe('a registration cannot inflate the record it is sealed into', () => {
  const allowlist = { redirectUris: [REDIRECT], maxRegistrationsPerHour: 10 };

  test('an ordinary registration is accepted and readable', async () => {
    const store = await durableStore();
    const outcome = await registerClient(
      store,
      { clientName: 'Claude', redirectUris: [REDIRECT] },
      { allowlist, now: T0 },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect((await store.getClient(outcome.client.client_id))?.clientName).toBe('Claude');
  });

  test('an oversized client name is refused with a client-metadata error, not a 500', async () => {
    const store = await durableStore();
    const outcome = await registerClient(
      store,
      { clientName: 'C'.repeat(MAX_CLIENT_NAME_LENGTH + 1), redirectUris: [REDIRECT] },
      { allowlist, now: T0 },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('invalid_client_metadata');

    const [counted] = (await writerSql`
      SELECT count(*)::int AS n FROM control.oauth_client
    `) as Array<{ n: number }>;
    expect(counted?.n).toBe(0);
  });

  test('one allowed redirect repeated past the ceiling is refused', async () => {
    // The allowlist checks each URI for membership and says nothing about how
    // many times one may appear, so a registration repeating an ALLOWED
    // redirect passes every existing check and inflates the sealed record until
    // the column refuses it.
    const store = await durableStore();
    const outcome = await registerClient(
      store,
      { clientName: 'Claude', redirectUris: Array(MAX_REDIRECT_URIS + 1).fill(REDIRECT) },
      { allowlist, now: T0 },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBe('invalid_client_metadata');
  });

  test('a record that would still overflow the column refuses by name rather than by constraint', async () => {
    const store = await durableStore();
    expect(
      store.putClient(clientRecord({ redirectUris: [`https://example.invalid/${'p'.repeat(2000)}`] })),
    ).rejects.toBeInstanceOf(AuthorizationStoreError);
  });
});

// ---------------------------------------------------------------------------
// Fail closed.
// ---------------------------------------------------------------------------

describe('the revocation check fails closed across the boundary', () => {
  test('a store whose database is unreachable rejects rather than answering "not revoked"', async () => {
    // The one answer this call must never invent. `dispatch.ts` reads it on
    // every tool call and treats `false` as "carry on", so a backend failure
    // flattened into `false` is a revoked grant served for as long as the
    // control plane is unwell.
    const broken = new SQL('postgres://nobody@127.0.0.1:1/unreachable', { max: 1 });
    try {
      const store = await durableStore(broken);
      expect(store.isRevoked(TENANT, mintGrantId())).rejects.toBeInstanceOf(Error);
    } finally {
      await broken.close().catch(() => undefined);
    }
  });
});

// ---------------------------------------------------------------------------
// Expiry.
// ---------------------------------------------------------------------------

describe('nothing here grows without bound', () => {
  test('an expired code, refresh token and registration are swept', async () => {
    const store = await durableStore();
    await store.putCode('code-stale', codeRecord({ expiresAt: T0 - 1 }));
    await store.putCode('code-fresh', codeRecord({ expiresAt: T0 + 60_000 }));
    await store.putRefresh(hashToken('bzr_stale'), refreshRecord({ expiresAt: T0 - 1 }));
    await store.putRefresh(hashToken('bzr_fresh'), refreshRecord({ expiresAt: T0 + 60_000 }));
    await store.noteRegistration(T0 - 2 * 60 * 60 * 1000);
    await store.noteRegistration(T0 - 30 * 60 * 1000);

    const swept = await purgeExpiredAuthorizationState(writerSql, { now: new Date(T0) });
    expect(swept.codes).toBe(1);
    expect(swept.refreshTokens).toBe(1);
    expect(swept.registrations).toBe(1);

    expect(await store.takeCode('code-fresh')).not.toBeUndefined();
    expect(await store.takeRefresh(hashToken('bzr_fresh'))).not.toBeUndefined();
    expect(await store.registrationsSince(T0 - 3 * 60 * 60 * 1000)).toBe(1);
  });

  test('a revocation is NOT swept while a credential naming it could still exist', async () => {
    // The retention is derived rather than chosen: the newest refresh token that
    // can name a grant revoked at T expires at T + refresh-TTL (a revocation
    // blocks rotation), and the newest access token minted before T expires at
    // T + access-TTL. Sweeping on the codes' schedule would un-revoke a grant
    // whose refresh token is still valid, which is the whole failure this store
    // exists to end, rebuilt inside the fix.
    const grantId = mintGrantId();
    const store = await durableStore(writerSql, { now: () => T0 });
    await store.revokeGrant(TENANT, grantId);

    const justBefore = T0 + REVOCATION_RETENTION_SECONDS * 1000 - 1_000;
    expect((await purgeExpiredAuthorizationState(writerSql, { now: new Date(justBefore) })).revocations).toBe(0);
    expect(await store.isRevoked(TENANT, grantId)).toBe(true);

    const justAfter = T0 + REVOCATION_RETENTION_SECONDS * 1000 + 1_000;
    expect((await purgeExpiredAuthorizationState(writerSql, { now: new Date(justAfter) })).revocations).toBe(1);
    expect(await store.isRevoked(TENANT, grantId)).toBe(false);
  });

  test('the retention covers the longest-lived credential that can name a grant', () => {
    expect(REVOCATION_RETENTION_SECONDS).toBeGreaterThanOrEqual(
      DEFAULT_REFRESH_TOKEN_TTL_SECONDS + DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    );
  });

  test('the sweep is safe to run against a control plane with nothing in it', async () => {
    const swept = await purgeExpiredAuthorizationState(writerSql, { now: new Date(T0) });
    expect(swept).toEqual({ codes: 0, refreshTokens: 0, registrations: 0, revocations: 0 });
  });
});

// ---------------------------------------------------------------------------
// Schema application.
// ---------------------------------------------------------------------------

describe('the schema applies itself, once, from any process', () => {
  test('three concurrent ensures leave one store and no error', async () => {
    // Three fleets deploy at once and each has several processes. `CREATE
    // DOMAIN` has no `IF NOT EXISTS`, so the loser of the advisory-lock race
    // sees `42710` from a catalog view older than the winner's commit — the
    // same measured shape `secret-pg.ts` documents.
    const handles = [
      new SQL(control.dsn, { max: 1 }),
      new SQL(control.dsn, { max: 1 }),
      new SQL(control.dsn, { max: 1 }),
    ];
    try {
      await Promise.all(handles.map((sql) => ensureAuthorizationStoreSchema(sql)));
      const [counted] = (await writerSql`
        SELECT count(*)::int AS n FROM pg_tables
        WHERE schemaname = 'control' AND tablename LIKE 'oauth\\_%'
      `) as Array<{ n: number }>;
      expect(counted?.n).toBe(5);
    } finally {
      await Promise.all(handles.map((sql) => sql.close()));
    }
  });
});

afterEach(async () => {
  // Nothing to do; the beforeEach truncation is the isolation. Present so a
  // future case that opens a handle has an obvious place to close it.
});
