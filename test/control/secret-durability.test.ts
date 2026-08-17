/**
 * The durable secret store, against a real control-plane database.
 *
 * **The property, stated so it cannot be satisfied by accident:** a tenant
 * written by one store instance is readable by a *different* store instance,
 * over a *different* connection, built *after* the writer is gone — and the
 * bytes at rest are useless to anyone who has the database but not the key.
 *
 * A round trip through one object proves none of that. That is exactly what the
 * file backend passed, every time, while the deployment it shipped into could
 * not resolve a single tenant across its two container fleets. So every case
 * here builds the reader separately from the writer, and the durability case
 * drops the reader and rebuilds it.
 *
 * The cross-*process* half of the same property — the web fleet provisioning and
 * the MCP fleet serving — lives in `test/fleet/cross-fleet-secrets.test.ts`,
 * because only two processes can express it. This file is the cheap, precise
 * half: the seed's semantics, the namespace binding, and what happens when the
 * key is wrong.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';

import {
  MAX_SEALED_PLAINTEXT_BYTES,
  createPostgresSecretStore,
  ensureSecretStoreSchema,
  importSecretSeed,
  type PostgresSecretStore,
} from '../../src/control/secret-pg.ts';
import {
  SealedEnvelopeError,
  SealingKeyError,
  importSealingKey,
  seal,
  unseal,
} from '../../src/control/sealed.ts';
import {
  controlPlaneIdentity,
  createTenantSecretStore,
  fleetIdentity,
  poolNamespace,
  tenantNamespace,
} from '../../src/control/secrets.ts';
import { providerKeyNamespace } from '../../src/ai/keys.ts';
import {
  ADMIN_DSN,
  createControlPlane,
  dropControlPlane,
  type ControlFixture,
} from '../worker/fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;

/** Thirty-two zero bytes. See `test/fleet/fixture.ts:FAKE_SEALING_KEY`. */
const KEY_A = 'A'.repeat(43);
/** Thirty-two bytes of something else, for the wrong-key cases. */
const KEY_B = 'B'.repeat(43);

const TENANT = 't-durability000000000001';
const OTHER_TENANT = 't-durability000000000002';
const DSN = 'postgresql://brainz_owner:npg_fake@ep-example-1.eu.aws.neon.invalid/brainz';
const OTHER_DSN = 'postgresql://brainz_owner:npg_fake@ep-example-2.eu.aws.neon.invalid/brainz';
const BEARER = `${TENANT}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

let control: ControlFixture;
/** The writer's handle — the web fleet's. */
let writerSql: SQL;
let writer: PostgresSecretStore;

beforeAll(async () => {
  control = await createControlPlane('secretdurability');
  writerSql = new SQL(control.dsn, { max: 2 });
  // The fixture applies `schema.sql`, which is the live control plane's state:
  // no secret store until a fleet creates one.
  await ensureSecretStoreSchema(writerSql);
  writer = createPostgresSecretStore({ sql: writerSql, key: await importSealingKey(KEY_A) });
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await writerSql?.close();
  if (control !== undefined) await dropControlPlane(control);
});

beforeEach(async () => {
  await writerSql`DELETE FROM control.tenant_secret`;
  await writerSql`DELETE FROM control.secret_seed`;
});

/** A reader with nothing in common with the writer but the database. */
async function openReader(key = KEY_A): Promise<{ store: PostgresSecretStore; close(): Promise<void> }> {
  const sql = new SQL(control.dsn, { max: 1 });
  const store = createPostgresSecretStore({ sql, key: await importSealingKey(key) });
  return { store, close: () => sql.close() };
}

async function sealedColumn(namespace: string): Promise<string | undefined> {
  const rows = (await writerSql`
    SELECT sealed FROM control.tenant_secret WHERE namespace = ${namespace}
  `) as Array<{ sealed: string }>;
  return rows[0]?.sealed;
}

describe('a writer and a separate reader agree', () => {
  test('a tenant written by one instance is resolvable by another', async () => {
    await writer.secrets.put(tenantNamespace(TENANT), {
      connectionString: DSN,
      bearerGrant: BEARER,
    });

    const reader = await openReader();
    try {
      // Through the real accessor, not the raw backend: the scope check, the
      // namespace derivation and the cache are the request path's, and a test
      // that bypassed them would be asserting about a different code path than
      // `/token` runs.
      const store = createTenantSecretStore({ backend: reader.store.secrets });
      const resolved = await store.resolve(fleetIdentity(TENANT), TENANT);
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) throw new Error(resolved.reason);
      expect(resolved.secret).toEqual({ connectionString: DSN, bearerGrant: BEARER });
    } finally {
      await reader.close();
    }
  });

  test('the reader can be destroyed and rebuilt and still sees it', async () => {
    await writer.secrets.put(tenantNamespace(TENANT), {
      connectionString: DSN,
      bearerGrant: BEARER,
    });

    const first = await openReader();
    expect(await first.store.secrets.get(tenantNamespace(TENANT))).toBeDefined();
    await first.close();

    // "It is durable now" passes trivially if nothing ever restarts. This is the
    // instance replacement: a new connection, a new store, a freshly imported
    // key, no memory of the first.
    const second = await openReader();
    try {
      expect(await second.store.secrets.get(tenantNamespace(TENANT))).toEqual({
        connectionString: DSN,
        bearerGrant: BEARER,
      });
    } finally {
      await second.close();
    }
  });

  test('a revoke by one instance is a miss for another', async () => {
    await writer.secrets.put(tenantNamespace(TENANT), {
      connectionString: DSN,
      bearerGrant: BEARER,
    });
    await writer.secrets.delete(tenantNamespace(TENANT));

    const reader = await openReader();
    try {
      expect(await reader.store.secrets.get(tenantNamespace(TENANT))).toBeUndefined();
    } finally {
      await reader.close();
    }
  });

  test('a pool entry keeps its empty bearer, and a provider key rides the same table', async () => {
    // Three namespaces, three shapes, one table. If the prefixes stopped being
    // the boundary, one of these would read another's payload.
    await writer.secrets.put(poolNamespace('pool-000000000000000001'), {
      connectionString: OTHER_DSN,
      bearerGrant: '',
    });
    await writer.providerKeys.put(providerKeyNamespace(TENANT, 'openai'), 'sk-not-a-real-key');

    const reader = await openReader();
    try {
      expect(await reader.store.secrets.get(poolNamespace('pool-000000000000000001'))).toEqual({
        connectionString: OTHER_DSN,
        bearerGrant: '',
      });
      expect(await reader.store.providerKeys.get(providerKeyNamespace(TENANT, 'openai'))).toBe(
        'sk-not-a-real-key',
      );
      // A tenant pair read as a provider key is a refusal, not a string that
      // happens to parse.
      await writer.secrets.put(tenantNamespace(TENANT), {
        connectionString: DSN,
        bearerGrant: BEARER,
      });
      expect(reader.store.providerKeys.get(tenantNamespace(TENANT))).rejects.toThrow(
        /not a provider key/,
      );
    } finally {
      await reader.close();
    }
  });
});

describe('what the database holds is unusable on its own', () => {
  test('no part of the plaintext survives into the column', async () => {
    await writer.secrets.put(tenantNamespace(TENANT), {
      connectionString: DSN,
      bearerGrant: BEARER,
    });

    const stored = (await sealedColumn(tenantNamespace(TENANT))) ?? '';
    expect(stored.startsWith('v1.')).toBe(true);
    expect(stored).not.toContain('neon.invalid');
    expect(stored).not.toContain('npg_fake');
    expect(stored).not.toContain(BEARER);
    // The DSN's own alphabet cannot be in there — this is the property the
    // column's CHECK enforces from the other side.
    expect(stored).not.toContain('@');
    expect(stored).not.toContain(':');
  });

  test('two seals of the same secret are different rows', async () => {
    await writer.secrets.put(tenantNamespace(TENANT), {
      connectionString: DSN,
      bearerGrant: BEARER,
    });
    const first = await sealedColumn(tenantNamespace(TENANT));
    await writer.secrets.put(tenantNamespace(TENANT), {
      connectionString: DSN,
      bearerGrant: BEARER,
    });
    // A fresh nonce per write, so the table leaks no equality between tenants
    // that happen to share a value.
    expect(await sealedColumn(tenantNamespace(TENANT))).not.toBe(first);
  });

  test('a reader with the wrong key throws rather than reporting an empty store', async () => {
    await writer.secrets.put(tenantNamespace(TENANT), {
      connectionString: DSN,
      bearerGrant: BEARER,
    });

    const reader = await openReader(KEY_B);
    try {
      // **The distinction this whole store depends on.** `undefined` here would
      // mean a fleet booted with the wrong key answers `not_found` for every
      // tenant it holds — the `invalid_grant` this change exists to end, back
      // under a new name and now caused by a typo in a secret.
      expect(reader.store.secrets.get(tenantNamespace(TENANT))).rejects.toThrow(
        SealedEnvelopeError,
      );
    } finally {
      await reader.close();
    }
  });

  test('an absent row is a miss, not a failure', async () => {
    const reader = await openReader();
    try {
      expect(await reader.store.secrets.get(tenantNamespace(OTHER_TENANT))).toBeUndefined();
    } finally {
      await reader.close();
    }
  });

  test('a row moved onto another tenant will not open', async () => {
    await writer.secrets.put(tenantNamespace(TENANT), {
      connectionString: DSN,
      bearerGrant: BEARER,
    });
    const lifted = (await sealedColumn(tenantNamespace(TENANT))) ?? '';

    // The row-swap: an operator, a bad migration or anyone with write access
    // pastes one tenant's envelope onto another's namespace. Without the
    // namespace bound as authenticated data this hands tenant B tenant A's
    // database, silently and with a valid-looking row.
    await writerSql`
      INSERT INTO control.tenant_secret (namespace, sealed)
      VALUES (${tenantNamespace(OTHER_TENANT)}, ${lifted})`;

    expect(writer.secrets.get(tenantNamespace(OTHER_TENANT))).rejects.toThrow(SealedEnvelopeError);
  });

  test('an oversized secret is refused by name, not by a driver', async () => {
    expect(
      writer.secrets.put(tenantNamespace(TENANT), {
        connectionString: 'x'.repeat(MAX_SEALED_PLAINTEXT_BYTES + 1),
        bearerGrant: BEARER,
      }),
    ).rejects.toThrow(/exceeds/);
  });
});

describe('the sealing key is a key, not whatever was typed', () => {
  test('a wrong-length key is refused rather than stretched', async () => {
    for (const bad of ['', 'AAAA', 'A'.repeat(21), 'not base64url at all!!!']) {
      expect(importSealingKey(bad)).rejects.toThrow(SealingKeyError);
    }
  });

  test('padded, unpadded and standard base64 all import to the same key', async () => {
    const namespace = 'tenant/x';
    const padded = `${'A'.repeat(43)}=`;
    const sealed = await seal(await importSealingKey(KEY_A), namespace, 'hello');
    expect(await unseal(await importSealingKey(padded), namespace, sealed)).toBe('hello');
  });

  test('a mangled envelope is malformed, and a tampered one is unopenable', async () => {
    const key = await importSealingKey(KEY_A);
    const sealed = await seal(key, 'tenant/x', 'hello');

    expect(unseal(key, 'tenant/x', 'not-an-envelope')).rejects.toThrow(/malformed/);
    expect(unseal(key, 'tenant/x', sealed.replace('v1.', 'v2.'))).rejects.toThrow(/malformed/);
    // One flipped character in the ciphertext. GCM's tag is what makes this a
    // refusal rather than a plausible-looking wrong answer.
    const flipped = `${sealed.slice(0, -1)}${sealed.endsWith('A') ? 'B' : 'A'}`;
    expect(unseal(key, 'tenant/x', flipped)).rejects.toThrow(/unopenable/);
  });
});

describe('the schema is created once, by whoever starts first', () => {
  test('a control plane built from schema.sql alone gains the store', async () => {
    const fresh = await createControlPlane('secretensure');
    const sql = new SQL(fresh.dsn, { max: 4 });
    try {
      const before = (await sql`
        SELECT to_regclass('control.tenant_secret') IS NOT NULL AS present`) as Array<{
        present: boolean;
      }>;
      expect(before[0]?.present).toBe(false);

      // Three fleets deploying at once, which is the ordinary case. `CREATE
      // DOMAIN` has no `IF NOT EXISTS`, so without the advisory lock and the
      // re-check inside it two of these three refuse to start.
      await Promise.all([
        ensureSecretStoreSchema(sql),
        ensureSecretStoreSchema(sql),
        ensureSecretStoreSchema(sql),
      ]);

      const after = (await sql`
        SELECT to_regclass('control.tenant_secret') IS NOT NULL AS present`) as Array<{
        present: boolean;
      }>;
      expect(after[0]?.present).toBe(true);

      // And again on a store that already exists: a fleet restart is not a
      // migration.
      await ensureSecretStoreSchema(sql);
    } finally {
      await sql.close();
      await dropControlPlane(fresh);
    }
  }, SETUP_TIMEOUT_MS);

  test('a database it cannot create the store in is a refusal, not a start', async () => {
    // The loser of the create race is answered by asking whether the store is
    // there now, which is a narrow question with a real risk attached: an
    // implementation that swallowed the error instead would start a fleet whose
    // every resolve fails, on a control plane nobody noticed was wrong. Here the
    // DDL cannot apply at all — no `control` schema — and the refusal has to
    // survive.
    const sql = new SQL(ADMIN_DSN, { max: 1 });
    try {
      expect(ensureSecretStoreSchema(sql)).rejects.toThrow();
    } finally {
      await sql.close();
    }
  });
});

describe('BRAINZ_SECRETS_JSON is a seed, and only a seed', () => {
  const seedText = (entries: Record<string, { connectionString: string; bearerGrant: string }>) =>
    JSON.stringify({ secrets: entries, providerKeys: {} }, null, 2);

  async function importSeed(text: string) {
    return importSecretSeed({
      sql: writerSql,
      key: await importSealingKey(KEY_A),
      text,
      source: 'the seed under test',
    });
  }

  test('the canary a blob carries becomes a durable entry a separate reader can see', async () => {
    const text = seedText({ [tenantNamespace(TENANT)]: { connectionString: DSN, bearerGrant: BEARER } });
    const outcome = await importSeed(text);
    expect(outcome).toMatchObject({ applied: true, entries: 1 });

    // This is the canary's migration: its credentials only ever existed inside
    // the blob, and now a process that never saw the blob can resolve it.
    const reader = await openReader();
    try {
      const store = createTenantSecretStore({ backend: reader.store.secrets });
      const resolved = await store.resolve(fleetIdentity(TENANT), TENANT);
      expect(resolved.ok).toBe(true);
    } finally {
      await reader.close();
    }
  });

  test('the same blob is imported once, however many fleets start', async () => {
    const text = seedText({ [tenantNamespace(TENANT)]: { connectionString: DSN, bearerGrant: BEARER } });
    expect((await importSeed(text)).applied).toBe(true);
    expect((await importSeed(text)).applied).toBe(false);
    expect((await importSeed(text)).applied).toBe(false);

    const rows = await writerSql`SELECT digest FROM control.secret_seed`;
    expect(rows).toHaveLength(1);
  });

  test('a seed never overwrites a live entry', async () => {
    // The exact failure this whole change is about: two stores disagreeing
    // about a tenant's bearer. The durable store rotated it; the container's
    // environment still holds the blob from before the rotation.
    await writer.secrets.put(tenantNamespace(TENANT), {
      connectionString: DSN,
      bearerGrant: 'the-rotated-one',
    });

    const stale = seedText({
      [tenantNamespace(TENANT)]: { connectionString: OTHER_DSN, bearerGrant: 'the-old-one' },
    });
    const outcome = await importSeed(stale);
    expect(outcome.applied).toBe(true);
    expect(outcome.entries).toBe(0);

    expect(await writer.secrets.get(tenantNamespace(TENANT))).toEqual({
      connectionString: DSN,
      bearerGrant: 'the-rotated-one',
    });
  });

  test('a revoked tenant is not resurrected by a container that still holds the blob', async () => {
    const text = seedText({ [tenantNamespace(TENANT)]: { connectionString: DSN, bearerGrant: BEARER } });
    await importSeed(text);
    await writer.secrets.delete(tenantNamespace(TENANT));

    // A second container starts — same blob, same digest, nothing to do. Without
    // the digest ledger this is a deleted credential coming back to life at the
    // next deploy, which is worse than the bug it replaced.
    expect((await importSeed(text)).applied).toBe(false);
    expect(await writer.secrets.get(tenantNamespace(TENANT))).toBeUndefined();
  });

  test('an operator adding an entry gets a new digest, and only the new entry lands', async () => {
    const first = seedText({ [tenantNamespace(TENANT)]: { connectionString: DSN, bearerGrant: BEARER } });
    await importSeed(first);

    const second = seedText({
      [tenantNamespace(TENANT)]: { connectionString: DSN, bearerGrant: BEARER },
      [tenantNamespace(OTHER_TENANT)]: { connectionString: OTHER_DSN, bearerGrant: 'another' },
    });
    const outcome = await importSeed(second);
    expect(outcome).toMatchObject({ applied: true, entries: 1 });
    expect(await writer.secrets.get(tenantNamespace(OTHER_TENANT))).toBeDefined();
  });

  test('a malformed blob is a refusal, not an empty store', async () => {
    expect(importSeed('{ not json')).rejects.toThrow(/not JSON/);
    // And nothing was claimed on the way out: a digest banked for an import
    // that never ran would make the real one a no-op forever.
    expect(await writerSql`SELECT digest FROM control.secret_seed`).toHaveLength(0);
  });

  test('the control-plane identity can still write, and the fleet identity still cannot', async () => {
    // The permissions `secrets.ts` decides are untouched by the substrate: this
    // is here so a future backend swap cannot quietly widen them.
    const store = createTenantSecretStore({ backend: writer.secrets });
    expect(
      await store.put(fleetIdentity(TENANT), TENANT, { connectionString: DSN, bearerGrant: BEARER }),
    ).toEqual({ ok: false, reason: 'scope_denied' });
    expect(
      await store.put(controlPlaneIdentity(), TENANT, {
        connectionString: DSN,
        bearerGrant: BEARER,
      }),
    ).toEqual({ ok: true });
    expect((await store.resolve(fleetIdentity(OTHER_TENANT), TENANT)).ok).toBe(false);
  });
});
