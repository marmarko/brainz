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
  DEFAULT_LOCK_TIMEOUT_MS,
  FLEET_CONTRACT,
  FLEET_SCHEMA_VERSION,
  PartialMigrationError,
  SCHEMA_LOOKAHEAD,
  TenantMigrationTimeoutError,
  TenantSchemaAheadError,
  TenantSchemaBehindError,
  assertServableSchema,
  findExpandContractViolations,
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
  sqlstateOf,
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

      // The failure has to be a *runtime* one, and the second statement is an
      // INSERT for that reason: the runner now refuses a rung the expand/contract
      // scanner rejects, so a bare `SELECT 1/0` would throw before any DDL ran
      // and this test would pass while proving nothing about transactionality.
      const broken = `
        CREATE TABLE chunk (chunk_id bigint GENERATED ALWAYS AS IDENTITY, origin_context text NOT NULL, content text NOT NULL, CONSTRAINT chunk_pkey PRIMARY KEY (chunk_id));
        INSERT INTO chunk (origin_context, content) VALUES ('personal', 1 / 0);
      `;
      // Stated as an assertion rather than as a comment: if this rung ever stops
      // being accepted by the scanner, the test below stops measuring the thing
      // it names.
      expect(findExpandContractViolations(broken)).toEqual([]);

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
    'a contracting rung is refused by the runner, not only by CI',
    async () => {
      // The asymmetry adversarial review found: `baselineDdl` lets a caller hand
      // the runner arbitrary DDL, and that DDL used to get the HNSW dimension
      // check and *not* the expand/contract check — whose only caller was a
      // test over the committed ladder. So the rule held for the ladder in the
      // tree and for nothing that actually executed.
      const fixture = track(await createEmptyDatabase('contracting'));
      const sql = open(fixture);

      const laundered = `
        CREATE TABLE chunk (chunk_id bigint GENERATED ALWAYS AS IDENTITY, origin_context text NOT NULL, content text NOT NULL, CONSTRAINT chunk_pkey PRIMARY KEY (chunk_id));
        ALTER TABLE chunk ADD COLUMN ordinal integer, DROP COLUMN content;
      `;

      await expect(
        migrateTenantSchema(sql, {
          ftsLanguage: FIXTURE_FTS_LANGUAGE,
          to: 1,
          baselineDdl: laundered,
        }),
      ).rejects.toThrow(/not expand-only/);

      // Refused before anything ran, which is the point: a contracting rung that
      // is caught after it commits has already broken the live previous release.
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

describe('a rung waits for its lock, but not forever', () => {
  test(
    'a rung queued behind an ordinary open read gives up instead of taking the tenant down',
    async () => {
      // Reproduced by adversarial review: rung two issues four `ALTER TABLE
      // chunk ADD COLUMN`, which take ACCESS EXCLUSIVE. One ordinary open
      // transaction holding ACCESS SHARE — a woken tenant mid-request — queues
      // the rung, and every read arriving *after* the rung queues behind the
      // exclusive request it cannot jump. So one long query plus one wake-time
      // migration takes the tenant's whole read path down, and the migration
      // waits forever.
      const fixture = track(await provisionLegacyV1('lock_wait'));
      const reader = open(fixture);
      const migrator = open(fixture);

      let releaseReader: () => void = () => {};
      const readerDone = new Promise<void>((resolve) => {
        releaseReader = resolve;
      });
      const holding = reader.begin(async (tx) => {
        // ACCESS SHARE on chunk, held open for the length of the "request".
        await tx.unsafe('SELECT count(*) FROM chunk');
        await readerDone;
        return { done: true };
      });

      try {
        const blocked = await migrateTenantSchema(migrator, {
          ftsLanguage: FIXTURE_FTS_LANGUAGE,
          lockTimeoutMs: 500,
        }).then(
          () => undefined,
          (error: unknown) => error,
        );

        // A retryable failure with a code the caller can dispatch on, rather
        // than an indefinite stall. 55P03 is lock_not_available.
        expect(sqlstateOf(blocked)).toBe('55P03');

        // And the tenant is untouched: the rung and its ledger row commit
        // together or not at all, so a rung that could not get its lock leaves
        // a tenant on the rung boundary it started from.
        expect(await readTenantSchemaVersion(migrator)).toBe(1);
      } finally {
        releaseReader();
        await holding;
      }

      // The next wake succeeds, which is what makes giving up the right answer:
      // there is another wake along in a moment.
      const after = await migrateTenantSchema(migrator, { ftsLanguage: FIXTURE_FTS_LANGUAGE });
      expect(after.to).toBe(HEAD_SCHEMA_VERSION);
      expect(after.applied).toEqual([2]);
    },
    TEST_TIMEOUT_MS,
  );

  test('the default is a bound, not the absence of one', () => {
    // A default of 0 would restore the reproduced outage for every caller that
    // did not think to ask, which is every caller today.
    expect(DEFAULT_LOCK_TIMEOUT_MS).toBeGreaterThan(0);
  });
});

describe('a run that is cancelled stops on a rung boundary', () => {
  test(
    'the deadline is threaded into the migration rather than checked around it',
    async () => {
      const fixture = track(await createEmptyDatabase('cancelled'));
      const sql = open(fixture);

      const cancelled = new AbortController();
      cancelled.abort();

      await expect(
        migrateTenantSchema(sql, { ftsLanguage: FIXTURE_FTS_LANGUAGE, signal: cancelled.signal }),
      ).rejects.toThrow(/aborted/);
      expect(await readTenantSchemaVersion(sql)).toBe(0);

      // And a run cancelled after one rung leaves the tenant at that rung — not
      // between two. This is the property per-rung transactions buy, and the
      // reason a cancelled provisioning run is recoverable rather than a mess.
      const first = await migrateTenantSchema(sql, { ftsLanguage: FIXTURE_FTS_LANGUAGE, to: 1 });
      expect(first.to).toBe(1);

      const stopped = new AbortController();
      stopped.abort();
      await expect(
        migrateTenantSchema(sql, { ftsLanguage: FIXTURE_FTS_LANGUAGE, signal: stopped.signal }),
      ).rejects.toThrow(/aborted/);
      expect(await readTenantSchemaVersion(sql)).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a ladder that got part-way says so', () => {
  test(
    'the failure carries the version the tenant really reached',
    async () => {
      // A genuine partial ladder: rung one applies, rung two collides with a
      // table that was already there. The tenant IS at v1 afterwards, and a
      // bare throw would lose that — the sweep would report v0 and bank
      // nothing, which is an outcome record the database disproves.
      const fixture = track(await createEmptyDatabase('partial'));
      const sql = open(fixture);
      await sql.unsafe('CREATE TABLE page (page_id bigint)');

      const failure = await migrateTenantSchema(sql, { ftsLanguage: FIXTURE_FTS_LANGUAGE }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(PartialMigrationError);
      expect((failure as PartialMigrationError).result).toEqual({ from: 0, to: 1, applied: [1] });
      // The original failure is carried, not swallowed: it is the thing an
      // operator has to read to know what to do next.
      expect(sqlstateOf((failure as PartialMigrationError).failure)).toBe('42P07');

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

  test('one tenant that never finishes does not stall the whole sweep', async () => {
    // The bound that was missing. `listBehind` bounds the sweep in count, which
    // is what stops it waking the fleet — but a tenant whose rung is queued
    // behind a long read never returns, and without a per-tenant budget every
    // tenant behind it in the batch stays behind while the next sweep starts on
    // the same one.
    const banked: string[] = [];
    const seen: { tenantId: string; aborted: boolean }[] = [];

    const ports: SweepPorts = {
      listBehind: () =>
        Promise.resolve([candidate('alpha', 1), candidate('wedged', 1), candidate('charlie', 1)]),
      migrate: (tenant, signal) =>
        tenant.tenantId === 'wedged'
          ? new Promise<never>((_resolve, reject) => {
              // A port that honours the signal stops working as well as being
              // stopped waiting for. This one records that it was told.
              signal?.addEventListener('abort', () => {
                seen.push({ tenantId: tenant.tenantId, aborted: true });
                reject(new Error('the port gave up when it was told to'));
              });
            })
          : Promise.resolve({ from: 1, to: HEAD_SCHEMA_VERSION, applied: [2] }),
      recordSchemaVersion: (tenantId) => {
        banked.push(tenantId);
        return Promise.resolve();
      },
    };

    const outcomes = await sweepTenantSchemas(ports, { limit: 10, perTenantTimeoutMs: 50 });

    expect(outcomes.map((o) => o.status)).toEqual(['migrated', 'failed', 'migrated']);
    expect(outcomes[1]?.error).toBeInstanceOf(TenantMigrationTimeoutError);
    expect(banked).toEqual(['alpha', 'charlie']);
    expect(seen).toEqual([{ tenantId: 'wedged', aborted: true }]);
  });

  test('a partly-migrated tenant is reported and banked where it actually is', async () => {
    // Rungs commit one at a time, so a ladder that fails on its third rung has
    // genuinely moved the tenant to its second. Reporting `from`/`to` as the
    // version it started with tells an operator something the database can
    // disprove — and banking nothing leaves the control-plane row lying until
    // the next wake re-reads the tenant.
    const banked: { tenantId: string; version: number }[] = [];
    const ports: SweepPorts = {
      listBehind: () => Promise.resolve([candidate('alpha', 1)]),
      migrate: () =>
        Promise.reject(
          new PartialMigrationError({ from: 1, to: 2, applied: [2] }, new Error('rung 3 failed')),
        ),
      recordSchemaVersion: (tenantId, version) => {
        banked.push({ tenantId, version });
        return Promise.resolve();
      },
    };

    const outcomes = await sweepTenantSchemas(ports, { limit: 10 });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe('failed');
    expect(outcomes[0]?.from).toBe(1);
    expect(outcomes[0]?.to).toBe(2);
    expect(banked).toEqual([{ tenantId: 'alpha', version: 2 }]);
  });

  test('a cancelled sweep stops between tenants and reports what it did', async () => {
    const cancelled = new AbortController();
    const visited: string[] = [];
    const ports: SweepPorts = {
      listBehind: () => Promise.resolve([candidate('alpha', 1), candidate('bravo', 1)]),
      migrate: (tenant) => {
        visited.push(tenant.tenantId);
        cancelled.abort();
        return Promise.resolve({ from: 1, to: HEAD_SCHEMA_VERSION, applied: [2] });
      },
      recordSchemaVersion: () => Promise.resolve(),
    };

    const outcomes = await sweepTenantSchemas(ports, { limit: 10, signal: cancelled.signal });

    // One visited, one not attempted — and no invented outcome for the tenant
    // the sweep never touched.
    expect(visited).toEqual(['alpha']);
    expect(outcomes.map((o) => o.tenantId)).toEqual(['alpha']);
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
