/**
 * Rollout safety — U3's "expand/contract discipline", asserted rather than
 * assumed.
 *
 * The plan states the problem precisely: during every rolling deploy, old and
 * new fleet versions serve concurrently, so a tenant migrated to v2 by a new
 * instance and then routed to an old one hits the schema refusal for the length
 * of the rollout — **and the retry loop cannot resolve it**, because the old
 * instance never will understand v2. For a per-tenant migration system across
 * tens of thousands of mostly-suspended databases, deploy ordering *is* the
 * safety story.
 *
 * Two halves, and neither is sufficient alone:
 *
 * **The ordering rule** — deploy first, migrate second — is a property of a pair
 * of releases, so it is checked as data.
 *
 * **The compatibility promise** — every migration leaves the previous fleet
 * version able to serve a migrated tenant — is a property of DDL, so it is
 * checked twice over: statically, by refusing any rung that is not additive; and
 * behaviourally, by taking the previous release's own frozen statements and
 * running them against a database this rung has already migrated.
 *
 * The behavioural half is the one that earns `SCHEMA_LOOKAHEAD`. Without it, the
 * tolerance that keeps a rolling deploy from being an outage would be a number
 * somebody chose.
 */

import type { SQL } from 'bun';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  SCHEMA_LOOKAHEAD,
  findExpandContractViolations,
  findRolloutViolations,
  splitStatements,
  type FleetRelease,
} from '../../src/control/migrate.ts';
import { HEAD_SCHEMA_VERSION, readLadderDdl } from '../../src/schema/migrations.ts';
import {
  connect,
  dropFixtureDatabase,
  provisionFixture,
  type SchemaFixture,
} from './fixture.ts';
import { FLEET_1_SURFACE, FLEET_SURFACES, runFleetSurface } from './fleet-surface.ts';

const SETUP_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 120_000;

const ladder = await readLadderDdl();

describe('every rung is additive, statically', () => {
  test('the shipped ladder has no contracting statement', () => {
    const findings = ladder.flatMap(({ migration, ddl }) =>
      findExpandContractViolations(ddl).map((finding) => `v${migration.version}: ${finding}`),
    );

    expect(findings).toEqual([]);
    // The scan must have seen something. A splitter that returned nothing would
    // report every rung clean forever, which is the failure shape this repo's
    // guards keep tripping over.
    expect(ladder.length).toBe(HEAD_SCHEMA_VERSION);
    for (const { ddl } of ladder) expect(splitStatements(ddl).length).toBeGreaterThan(0);
  });

  test('the scanner rejects the four shapes that break a live previous release', () => {
    // A column the old release still SELECTs.
    expect(findExpandContractViolations('DROP TABLE chunk;')).toHaveLength(1);
    expect(findExpandContractViolations('ALTER TABLE chunk DROP COLUMN content;')).toHaveLength(1);
    // A rename is a drop and an add that happen to rhyme.
    expect(findExpandContractViolations('ALTER TABLE chunk RENAME COLUMN content TO body;')).toHaveLength(1);
    // The subtle one: every INSERT naming the previous column list starts
    // failing the moment this commits, and review does not notice because the
    // new code always names the new column.
    expect(
      findExpandContractViolations('ALTER TABLE chunk ADD COLUMN page_id bigint NOT NULL;'),
    ).toHaveLength(1);

    // And the same column with a default is fine, which is what makes the rule
    // usable rather than a blanket ban.
    expect(
      findExpandContractViolations('ALTER TABLE chunk ADD COLUMN page_id bigint NOT NULL DEFAULT 0;'),
    ).toEqual([]);
  });

  test('an unrecognized statement is a finding, not a shrug', () => {
    // Fail-closed. A scanner that hunts for known-bad verbs passes everything it
    // has not thought of, and the destructive statement nobody anticipated is
    // exactly the one this exists to catch.
    expect(findExpandContractViolations('TRUNCATE chunk;')).toHaveLength(1);
    expect(findExpandContractViolations('ALTER TABLE chunk ALTER COLUMN content TYPE varchar(80);')).toHaveLength(1);
    expect(findExpandContractViolations('')).toHaveLength(1);
  });

  test('the splitter understands dollar-quoted function bodies', () => {
    // Rung two ships three plpgsql functions. A splitter that broke on `;`
    // inside `$$ ... $$` would read each of them as a handful of malformed
    // statements and report a wall of false findings — at which point the guard
    // gets switched off, which is worse than not having it.
    const withFunction = `
      CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN
        IF true THEN RAISE EXCEPTION 'x; y'; END IF;
        RETURN NEW;
      END;
      $f$;
      CREATE TABLE t (id int);
    `;
    const statements = splitStatements(withFunction);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('RETURN NEW');
    expect(findExpandContractViolations(withFunction)).toEqual([]);

    // A semicolon inside an ordinary string literal is not a statement boundary
    // either — `CHECK (x ~ '^a;b$')` is a real thing to write.
    expect(splitStatements(`INSERT INTO t VALUES ('a;b'); SELECT 1;`)).toHaveLength(2);
  });
});

describe('deploy first, migrate second — as data', () => {
  const shipped: FleetRelease = { release: 'fleet-1', head: 1, migrationsEnabled: true };

  test('a release may not enable a migration its predecessor cannot serve', () => {
    // The safe rollout: the release that introduces rung 2 ships understanding
    // it. Its predecessor tolerates one rung ahead (see SCHEMA_LOOKAHEAD), which
    // is what keeps the window between the first migrated tenant and the last
    // replaced instance from being an outage.
    expect(
      findRolloutViolations(shipped, { release: 'fleet-2', head: 2, migrationsEnabled: true }),
    ).toEqual([]);

    // Two rungs in one release is the case that breaks: an instance of fleet-1
    // routed a v3 tenant has no path to understanding it, and no retry helps.
    expect(
      findRolloutViolations(shipped, { release: 'fleet-3', head: 3, migrationsEnabled: true }),
    ).toHaveLength(1);

    // The same jump is fine with migrations off — that is the deploy half of
    // "deploy first, migrate second", and it is why the flag is separate from
    // the head version rather than implied by it.
    expect(
      findRolloutViolations(shipped, { release: 'fleet-3', head: 3, migrationsEnabled: false }),
    ).toEqual([]);
  });

  test('a rung cannot be un-shipped by rolling the head backwards', () => {
    expect(
      findRolloutViolations({ release: 'fleet-2', head: 2, migrationsEnabled: true }, shipped),
    ).toHaveLength(1);
  });
});

describe('the previous fleet version still serves a tenant migrated to the current one', () => {
  let atItsOwnVersion: SchemaFixture;
  let migratedToHead: SchemaFixture;
  let own: SQL;
  let head: SQL;

  beforeAll(async () => {
    // The database `fleet-1` was written against...
    atItsOwnVersion = await provisionFixture('rollout_v1', { targetVersion: FLEET_1_SURFACE.schemaVersion });
    // ...and one a newer instance has already migrated out from under it.
    migratedToHead = await provisionFixture('rollout_head');
    own = connect(atItsOwnVersion);
    head = connect(migratedToHead);
  }, { timeout: SETUP_TIMEOUT_MS });

  afterAll(async () => {
    await own?.close();
    await head?.close();
    if (atItsOwnVersion !== undefined) await dropFixtureDatabase(atItsOwnVersion);
    if (migratedToHead !== undefined) await dropFixtureDatabase(migratedToHead);
  }, { timeout: SETUP_TIMEOUT_MS });

  test(
    'the frozen surface is genuinely that release’s SQL — it runs on that release’s schema',
    async () => {
      // This is what stops the freeze from rotting. A statement quietly "fixed"
      // by borrowing a column from a later rung fails here, so the only way to
      // make the migrated run below pass is to fix the *migration*.
      const failures = await runFleetSurface(own, FLEET_1_SURFACE);
      expect(failures).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    'and it still runs, unchanged, against a database migrated to head',
    async () => {
      const failures = await runFleetSurface(head, FLEET_1_SURFACE);

      // The named test from U3's scenario list. If this goes red, the rung that
      // broke it must be reshaped — an old instance cannot be taught anything.
      expect(failures).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  test('the surface is not empty, and covers writes as well as reads', () => {
    // A surface trimmed to selects would pass every migration that ever added a
    // NOT NULL column, which is the single most likely way to break a live
    // previous release.
    expect(FLEET_SURFACES.length).toBeGreaterThanOrEqual(1);
    expect(FLEET_1_SURFACE.exchanges.length).toBeGreaterThanOrEqual(6);

    const all = FLEET_1_SURFACE.exchanges.flatMap((exchange) => exchange.statements);
    expect(all.some((statement) => /^INSERT INTO chunk \(origin_context, content, embedding/.test(statement.trim()))).toBe(
      true,
    );
    expect(all.some((statement) => statement.trim().startsWith('UPDATE chunk'))).toBe(true);
    expect(all.some((statement) => statement.includes('SET LOCAL hnsw.ef_search'))).toBe(true);
  });

  test('one release of promise buys exactly one rung of tolerance', () => {
    // The link the lookahead constant depends on: the frozen surfaces prove
    // compatibility across one rung, so the fleet tolerates one rung.
    const proven = HEAD_SCHEMA_VERSION - FLEET_1_SURFACE.schemaVersion;
    expect(SCHEMA_LOOKAHEAD).toBeLessThanOrEqual(proven);
  });
});
