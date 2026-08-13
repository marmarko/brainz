/**
 * Migration runner v0 — U3 approach step 4, against a real Postgres.
 *
 * The runner's job is not "run some DDL". It is to be correct across tens of
 * thousands of mostly-suspended databases woken by a stateless fleet, so the
 * cases below are the ones that only appear at that shape:
 *
 *   * A **legacy** tenant, provisioned before the ledger existed, must be
 *     recognised as rung one rather than replayed from zero over a live brain.
 *   * **Two instances waking the same tenant** is ordinary, not exotic. Exactly
 *     one may apply a rung; the other must no-op rather than fail.
 *   * A rung that fails must leave the tenant at the version it started at, with
 *     no ledger row claiming otherwise — the property Postgres's transactional
 *     DDL gives us and that a runner can still throw away by committing the
 *     version separately.
 *   * The request path must **refuse** a schema it does not understand, with a
 *     typed error whose two flavours differ in what the caller should do next.
 */

import type { SQL } from 'bun';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  FLEET_CONTRACT,
  FLEET_SCHEMA_VERSION,
  SCHEMA_LOOKAHEAD,
  TenantSchemaAheadError,
  TenantSchemaBehindError,
  assertServableSchema,
  isServableSchema,
  migrateTenantSchema,
  readTenantSchemaVersion,
  sweepTenantSchemas,
  type SweepCandidate,
  type SweepPorts,
} from '../../src/control/migrate.ts';
import { FtsLanguageDriftError } from '../../src/schema/fts-language.ts';
import { HEAD_SCHEMA_VERSION, MIGRATIONS, findLadderViolations } from '../../src/schema/migrations.ts';
import {
  FIXTURE_FTS_LANGUAGE,
  connect,
  createEmptyDatabase,
  dropFixtureDatabase,
  provisionFixture,
  provisionLegacyV1,
  type SchemaFixture,
} from './fixture.ts';

const TEST_TIMEOUT_MS = 120_000;

const opened: SQL[] = [];
const created: SchemaFixture[] = [];

function track(fixture: SchemaFixture): SchemaFixture {
  created.push(fixture);
  return fixture;
}

function open(fixture: SchemaFixture): SQL {
  const sql = connect(fixture);
  opened.push(sql);
  return sql;
}

beforeEach(() => {
  opened.length = 0;
  created.length = 0;
});

afterEach(async () => {
  for (const sql of opened) await sql.close();
  for (const fixture of created) await dropFixtureDatabase(fixture);
}, TEST_TIMEOUT_MS);

describe('the ladder itself', () => {
  test('is contiguous, named, and its validator can still go red', () => {
    expect(findLadderViolations(MIGRATIONS)).toEqual([]);
    expect(HEAD_SCHEMA_VERSION).toBe(MIGRATIONS.length);

    // A validator nobody points at a broken input is a validator that has never
    // run. Two shapes, both of which make "the tenant is at version N"
    // ambiguous or wrong.
    expect(
      findLadderViolations([
        { version: 1, name: 'chunk-storage-core', file: 'tenant.sql' },
        { version: 3, name: 'skips-a-rung', file: 'x.sql' },
      ]),
    ).toHaveLength(1);
    expect(findLadderViolations([])).toHaveLength(1);
  });
});

describe('reading where a tenant is', () => {
  test(
    'an empty database is version 0, a legacy tenant is version 1, head is head',
    async () => {
      const empty = open(track(await createEmptyDatabase('read_empty')));
      expect(await readTenantSchemaVersion(empty)).toBe(0);

      // The case the ledger cannot answer: rung one's tables and nothing to say
      // so. Inferring it is what stops the runner replaying rung one over a
      // brain that already has chunks in it.
      const legacy = open(track(await provisionLegacyV1('read_legacy')));
      expect(await readTenantSchemaVersion(legacy)).toBe(1);

      const head = open(track(await provisionFixture('read_head')));
      expect(await readTenantSchemaVersion(head)).toBe(HEAD_SCHEMA_VERSION);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a tenant behind the fleet is migrated inline and then served', () => {
  test(
    'v1 refuses to be served, migrates to head, and then answers a head-only query',
    async () => {
      const fixture = track(await provisionLegacyV1('inline'));
      const sql = open(fixture);

      // A v1 brain with rows in it — the state that makes replaying rung one
      // destructive rather than merely wasteful.
      await sql.unsafe(`INSERT INTO chunk (origin_context, content) VALUES ('personal', 'before the migration')`);

      const before = await readTenantSchemaVersion(sql);
      expect(before).toBe(1);

      // The request path's refusal, and the flavour that says what to do next.
      let refusal: unknown;
      try {
        assertServableSchema(before);
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(TenantSchemaBehindError);
      expect((refusal as TenantSchemaBehindError).migratable).toBe(true);
      expect((refusal as TenantSchemaBehindError).tenantSchemaVersion).toBe(1);

      const result = await migrateTenantSchema(sql, { ftsLanguage: FIXTURE_FTS_LANGUAGE });
      expect(result).toEqual({ from: 1, to: HEAD_SCHEMA_VERSION, applied: [2] });

      // Served now, and the rows that were there before still are.
      expect(() => assertServableSchema(result.to)).not.toThrow();
      const rows = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM chunk`;
      expect(rows[0]?.n).toBe(1);

      // A head-only query answers, which is what "served" actually means.
      const pages = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM page`;
      expect(pages[0]?.n).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'migrating again is a no-op, not a replay',
    async () => {
      const fixture = track(await provisionFixture('idempotent'));
      const sql = open(fixture);

      const again = await migrateTenantSchema(sql, { ftsLanguage: FIXTURE_FTS_LANGUAGE });
      expect(again.applied).toEqual([]);
      expect(again.to).toBe(HEAD_SCHEMA_VERSION);

      const ledger = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM schema_migration`;
      expect(ledger[0]?.n).toBe(HEAD_SCHEMA_VERSION);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'two instances waking the same tenant: one applies, the other no-ops',
    async () => {
      const fixture = track(await provisionLegacyV1('concurrent'));
      // Two connections, because two fleet instances are two connections. One
      // connection would serialise the race the lock exists to arbitrate.
      const first = open(fixture);
      const second = open(fixture);

      const [a, b] = await Promise.all([
        migrateTenantSchema(first, { ftsLanguage: FIXTURE_FTS_LANGUAGE }),
        migrateTenantSchema(second, { ftsLanguage: FIXTURE_FTS_LANGUAGE }),
      ]);

      // Exactly one of them did the work; both report the same destination.
      expect([a.applied.length, b.applied.length].sort()).toEqual([0, 1]);
      expect(a.to).toBe(HEAD_SCHEMA_VERSION);
      expect(b.to).toBe(HEAD_SCHEMA_VERSION);

      // Two rows, one per rung, exactly once each: rung one **adopted** (this
      // tenant predates the runner, so nobody watched that DDL run) and rung two
      // applied by whichever instance won the lock.
      const ledger = await first<{ version: number; name: string; n: number }[]>`
        SELECT version, min(name) AS name, count(*)::int AS n
        FROM schema_migration GROUP BY version ORDER BY version
      `;
      expect(ledger.map((row) => row.n)).toEqual([1, 1]);
      expect(ledger[0]?.name).toContain('adopted');
      expect(ledger[1]?.name).not.toContain('adopted');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a rung that fails leaves nothing behind', () => {
  test(
    'the DDL and the version it claims commit together or not at all',
    async () => {
      const fixture = track(await createEmptyDatabase('atomic'));
      const sql = open(fixture);

      const broken = `
        CREATE TABLE chunk (chunk_id bigint GENERATED ALWAYS AS IDENTITY, origin_context text NOT NULL, content text NOT NULL, CONSTRAINT chunk_pkey PRIMARY KEY (chunk_id));
        SELECT 1 / 0;
      `;

      await expect(
        migrateTenantSchema(sql, { ftsLanguage: FIXTURE_FTS_LANGUAGE, to: 1, baselineDdl: broken }),
      ).rejects.toThrow();

      // Not "the tenant is at 1 but the table is missing" — the version and the
      // schema are the same commit.
      expect(await readTenantSchemaVersion(sql)).toBe(0);
      const tables = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = 'chunk'
      `;
      expect(tables[0]?.n).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a rung declaring an unindexable dimension is refused before the database is touched',
    async () => {
      // H2 at migration-definition time: `vector(3072)` stores, inserts and
      // queries fine and fails only at CREATE INDEX — by which point a tenant
      // that answers by sequential scan already exists.
      const fixture = track(await createEmptyDatabase('ceiling'));
      const sql = open(fixture);

      const oversized = `CREATE TABLE chunk (chunk_id bigint GENERATED ALWAYS AS IDENTITY, embedding vector(3072));`;
      await expect(
        migrateTenantSchema(sql, { ftsLanguage: FIXTURE_FTS_LANGUAGE, to: 1, baselineDdl: oversized }),
      ).rejects.toThrow(/HNSW ceiling/);

      expect(await readTenantSchemaVersion(sql)).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'a tenant indexed in one language is not migrated as another',
    async () => {
      const fixture = track(await provisionLegacyV1('drift'));
      const sql = open(fixture);

      // KTD9's failure, arriving through the migration path rather than the
      // provisioning path: the control-plane row says one thing and the tenant's
      // own generated columns say another.
      await expect(migrateTenantSchema(sql, { ftsLanguage: 'english' })).rejects.toThrow(
        FtsLanguageDriftError,
      );

      expect(await readTenantSchemaVersion(sql)).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('the request path refuses what it does not understand', () => {
  test('a tenant one rung ahead is served; two rungs ahead is refused', () => {
    // The lookahead is what keeps a rolling deploy from being an outage: an
    // instance of the previous release keeps serving a tenant a newer instance
    // has already migrated. It is licensed by `rollout.test.ts`, which runs the
    // previous release's own statements against a migrated database.
    expect(isServableSchema(FLEET_SCHEMA_VERSION)).toBe(true);
    expect(isServableSchema(FLEET_SCHEMA_VERSION + SCHEMA_LOOKAHEAD)).toBe(true);

    let refusal: unknown;
    try {
      assertServableSchema(FLEET_SCHEMA_VERSION + SCHEMA_LOOKAHEAD + 1);
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(TenantSchemaAheadError);
    // The distinction that matters operationally: retrying will not help and
    // neither will migrating. This instance is the stale one.
    expect((refusal as TenantSchemaAheadError).migratable).toBe(false);
    expect((refusal as TenantSchemaAheadError).fleetSchemaVersion).toBe(FLEET_SCHEMA_VERSION);
    expect(FLEET_CONTRACT.head).toBe(HEAD_SCHEMA_VERSION);
  });
});

describe('the bounded sweep', () => {
  function candidate(tenantId: string, schemaVersion: number): SweepCandidate {
    return { tenantId, schemaVersion, ftsLanguage: FIXTURE_FTS_LANGUAGE };
  }

  test('migrates at most the bound it was given, and banks each result', async () => {
    const behind = [candidate('alpha', 1), candidate('bravo', 1), candidate('charlie', 1)];
    const banked: { tenantId: string; version: number }[] = [];
    const asked: number[] = [];

    const ports: SweepPorts = {
      listBehind(limit) {
        asked.push(limit);
        return Promise.resolve(behind.slice(0, limit));
      },
      migrate(tenant) {
        return Promise.resolve({ from: tenant.schemaVersion, to: HEAD_SCHEMA_VERSION, applied: [2] });
      },
      recordSchemaVersion(tenantId, version) {
        banked.push({ tenantId, version });
        return Promise.resolve();
      },
    };

    const outcomes = await sweepTenantSchemas(ports, { limit: 2 });

    // Bounded at the source: a sweep that pulls the whole fleet and then trims
    // has already asked the control plane for tens of thousands of rows.
    expect(asked).toEqual([2]);
    expect(outcomes.map((o) => o.tenantId)).toEqual(['alpha', 'bravo']);
    expect(outcomes.every((o) => o.status === 'migrated')).toBe(true);
    expect(banked).toEqual([
      { tenantId: 'alpha', version: HEAD_SCHEMA_VERSION },
      { tenantId: 'bravo', version: HEAD_SCHEMA_VERSION },
    ]);
  });

  test('one tenant’s failure does not stop the sweep', async () => {
    const banked: string[] = [];
    const ports: SweepPorts = {
      listBehind: () => Promise.resolve([candidate('alpha', 1), candidate('bravo', 1), candidate('charlie', 1)]),
      migrate: (tenant) =>
        tenant.tenantId === 'bravo'
          ? Promise.reject(new Error('bravo is suspended and did not wake'))
          : Promise.resolve({ from: 1, to: HEAD_SCHEMA_VERSION, applied: [2] }),
      recordSchemaVersion: (tenantId) => {
        banked.push(tenantId);
        return Promise.resolve();
      },
    };

    const outcomes = await sweepTenantSchemas(ports, { limit: 10 });

    // A fleet-wide sweep that aborts on the first unreachable tenant leaves
    // every tenant after it behind, and the next sweep hits the same one first.
    expect(outcomes.map((o) => o.status)).toEqual(['migrated', 'failed', 'migrated']);
    expect(outcomes[1]?.error).toBeInstanceOf(Error);
    expect(banked).toEqual(['alpha', 'charlie']);
  });

  test('a tenant another instance already migrated is reported, not re-banked', async () => {
    const banked: string[] = [];
    const ports: SweepPorts = {
      listBehind: () => Promise.resolve([candidate('alpha', HEAD_SCHEMA_VERSION)]),
      migrate: () => Promise.resolve({ from: HEAD_SCHEMA_VERSION, to: HEAD_SCHEMA_VERSION, applied: [] }),
      recordSchemaVersion: (tenantId) => {
        banked.push(tenantId);
        return Promise.resolve();
      },
    };

    const outcomes = await sweepTenantSchemas(ports, { limit: 10 });

    expect(outcomes[0]?.status).toBe('already-current');
    expect(banked).toEqual([]);
  });
});
