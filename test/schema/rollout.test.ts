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
import {
  FLEET_1_SURFACE,
  FLEET_13_SURFACE,
  FLEET_SURFACES,
  runFleetSurface,
} from './fleet-surface.ts';

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

  test('DROP NOT NULL is admitted, and every neighbour it sits beside is not', () => {
    // The one `ALTER COLUMN` action that widens rather than rewrites. Rung 14
    // needs it: `fact.embedding` is `vector(1536) NOT NULL` and the 1024 seat
    // cannot fill it, so without this the seat is blocked on a routing edit
    // nobody can make.
    expect(
      findExpandContractViolations('ALTER TABLE fact ALTER COLUMN embedding DROP NOT NULL;'),
    ).toEqual([]);
    // Postgres accepts the short spelling too, and a rule that refused it would
    // be crying wolf on correct DDL.
    expect(findExpandContractViolations('ALTER TABLE fact ALTER embedding DROP NOT NULL;')).toEqual([]);

    // Its neighbours are one token away and every one of them breaks the
    // previous release. This is the whole reason the admission is a shape and
    // not a family: `ALTER COLUMN` was refused wholesale, and the refusal was
    // right about these four.
    for (const action of [
      'SET NOT NULL',
      'TYPE vector(1024)',
      'SET DEFAULT 0',
      'DROP DEFAULT',
      'DROP EXPRESSION',
    ]) {
      expect(
        findExpandContractViolations(`ALTER TABLE fact ALTER COLUMN embedding ${action};`),
      ).toHaveLength(1);
    }

    // And it cannot be used to launder anything alongside it: actions are
    // judged one at a time, so a legitimate DROP NOT NULL at the front buys the
    // rest of the statement nothing.
    expect(
      findExpandContractViolations(
        'ALTER TABLE fact ALTER COLUMN embedding DROP NOT NULL, DROP COLUMN statement;',
      ),
    ).toHaveLength(1);
    // Nor may it carry a trailing clause the anchor would otherwise let through.
    expect(
      findExpandContractViolations('ALTER TABLE fact ALTER COLUMN embedding DROP NOT NULL CASCADE;'),
    ).toHaveLength(1);
  });

  test('an unrecognized statement is a finding, not a shrug', () => {
    // Fail-closed. A scanner that hunts for known-bad verbs passes everything it
    // has not thought of, and the destructive statement nobody anticipated is
    // exactly the one this exists to catch.
    expect(findExpandContractViolations('TRUNCATE chunk;')).toHaveLength(1);
    expect(findExpandContractViolations('ALTER TABLE chunk ALTER COLUMN content TYPE varchar(80);')).toHaveLength(1);
    expect(findExpandContractViolations('')).toHaveLength(1);
  });

  test('a multi-action ALTER TABLE is judged action by action', () => {
    // Every one of these was ACCEPTED by a scanner that matched on the statement
    // head: Postgres allows several actions per `ALTER TABLE`, and `ADD COLUMN`
    // at the front launders whatever follows it. The same three actions are
    // rejected standalone, which is what made the gap invisible in review.
    expect(
      findExpandContractViolations('ALTER TABLE chunk ADD COLUMN x int, DROP COLUMN content;'),
    ).toHaveLength(1);
    expect(
      findExpandContractViolations(
        'ALTER TABLE chunk ADD COLUMN y int, ALTER COLUMN content TYPE varchar(80);',
      ),
    ).toHaveLength(1);
    expect(
      findExpandContractViolations('ALTER TABLE chunk ADD COLUMN z int, DROP CONSTRAINT chunk_pkey;'),
    ).toHaveLength(1);

    // And the NOT NULL rule is per action too. Statement-wide, this one reads as
    // "there is a DEFAULT in here somewhere" — while `b` breaks every INSERT the
    // previous release issues.
    expect(
      findExpandContractViolations('ALTER TABLE chunk ADD COLUMN a int DEFAULT 0, ADD COLUMN b int NOT NULL;'),
    ).toHaveLength(1);

    // The legitimate multi-action form still passes, or the rule is unusable.
    expect(
      findExpandContractViolations(
        `ALTER TABLE chunk ADD COLUMN a int DEFAULT 0, ADD COLUMN b int NOT NULL DEFAULT 0,
         ADD CONSTRAINT chunk_ab CHECK (a IN (0, 1) AND b >= 0);`,
      ),
    ).toEqual([]);
    // Commas inside a parenthesised list are not action boundaries — a splitter
    // that thought so would report a wall of false findings on real DDL, and a
    // guard that cries wolf gets switched off.
    expect(
      findExpandContractViolations(
        `ALTER TABLE chunk ADD CONSTRAINT chunk_page_fkey FOREIGN KEY (page_id, ordinal) REFERENCES page (page_id, ordinal);`,
      ),
    ).toEqual([]);
  });

  test('a uniqueness promise on a pre-existing table is a rollout break', () => {
    // Reproduced by adversarial review as passing BOTH nets: the scanner (it is
    // a `CREATE ... INDEX`, which is additive in shape) and the frozen fleet
    // surface (whose two chunks happen to carry distinct content). It breaks the
    // previous release on the first duplicate that release writes — on a schema
    // it can neither understand nor retry past.
    expect(
      findExpandContractViolations('CREATE UNIQUE INDEX chunk_content_unique ON chunk (content);'),
    ).toHaveLength(1);
    expect(
      findExpandContractViolations('ALTER TABLE chunk ADD CONSTRAINT chunk_content_unique UNIQUE (content);'),
    ).toHaveLength(1);

    // On a table the same rung creates, the promise is free: nothing else is
    // writing to a table the previous release has never heard of. This is the
    // shape the shipped ladder actually uses, three times.
    expect(
      findExpandContractViolations(
        `CREATE TABLE note (note_id bigint GENERATED ALWAYS AS IDENTITY, slug text NOT NULL);
         CREATE UNIQUE INDEX note_slug ON note (slug);`,
      ),
    ).toEqual([]);
    // Order within the rung must not decide it.
    expect(
      findExpandContractViolations(
        `CREATE UNIQUE INDEX note_slug ON public.note (slug);
         CREATE TABLE note (note_id bigint GENERATED ALWAYS AS IDENTITY, slug text NOT NULL);`,
      ),
    ).toEqual([]);
    // A non-unique index on an existing table stays fine: it promises nothing
    // about what may be written.
    expect(findExpandContractViolations('CREATE INDEX chunk_by_content ON chunk (content);')).toEqual([]);

    // And the constraint form gets the same exemption on a table the rung
    // creates. Without it the rule fires on correct DDL — create the table,
    // then constrain it — which is how a guard earns a reputation for noise.
    expect(
      findExpandContractViolations(
        `CREATE TABLE note (note_id bigint GENERATED ALWAYS AS IDENTITY, slug text NOT NULL);
         ALTER TABLE note ADD CONSTRAINT note_slug_unique UNIQUE (slug);`,
      ),
    ).toEqual([]);
  });

  test('CREATE OR REPLACE FUNCTION is a change, not an addition', () => {
    // The Q1/Q2 join, and the sharpest shape review found: an "additive" rung
    // that replaces the shared origin-trigger function with one that returns NEW
    // unconditionally disables R15 on every table at once. The scanner accepted
    // it, the frozen surface ran it successfully, and every trigger definition
    // still read correctly afterwards.
    const neuter = `CREATE OR REPLACE FUNCTION refuse_origin_change() RETURNS trigger
      LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END; $f$;`;
    expect(findExpandContractViolations(neuter)).toHaveLength(1);

    // A NEW function is still additive — that is the migration path for a rung
    // that needs different behaviour: add a function, point new triggers at it.
    expect(
      findExpandContractViolations(`CREATE FUNCTION refuse_origin_change_v2() RETURNS trigger
        LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END; $f$;`),
    ).toEqual([]);
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
  /** One database per frozen release, at that release's own rung. */
  const atOwnVersion = new Map<number, { fixture: SchemaFixture; sql: SQL }>();
  let migratedToHead: SchemaFixture;
  let head: SQL;

  beforeAll(async () => {
    for (const surface of FLEET_SURFACES) {
      if (atOwnVersion.has(surface.schemaVersion)) continue;
      // The database each release was written against...
      const fixture = await provisionFixture(`rollout_v${surface.schemaVersion}`, {
        targetVersion: surface.schemaVersion,
      });
      atOwnVersion.set(surface.schemaVersion, { fixture, sql: connect(fixture) });
    }
    // ...and one a newer instance has already migrated out from under them.
    migratedToHead = await provisionFixture('rollout_head');
    head = connect(migratedToHead);
  }, { timeout: SETUP_TIMEOUT_MS });

  afterAll(async () => {
    for (const { fixture, sql } of atOwnVersion.values()) {
      await sql?.close();
      await dropFixtureDatabase(fixture);
    }
    await head?.close();
    if (migratedToHead !== undefined) await dropFixtureDatabase(migratedToHead);
  }, { timeout: SETUP_TIMEOUT_MS });

  for (const surface of FLEET_SURFACES) {
    test(
      `${surface.release}'s surface is genuinely that release’s SQL — it runs on that release’s schema`,
      async () => {
        // This is what stops the freeze from rotting. A statement quietly "fixed"
        // by borrowing a column from a later rung fails here, so the only way to
        // make the migrated run below pass is to fix the *migration*.
        const own = atOwnVersion.get(surface.schemaVersion);
        expect(own).toBeDefined();
        expect(await runFleetSurface(own!.sql, surface)).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      `and ${surface.release}'s surface still runs, unchanged, against a database migrated to head`,
      async () => {
        const failures = await runFleetSurface(head, surface);

        // The named test from U3's scenario list. If this goes red, the rung that
        // broke it must be reshaped — an old instance cannot be taught anything.
        expect(failures).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );
  }

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

  test('the release that rung 14 relaxes a constraint under is frozen, writes included', () => {
    // Rung 14 drops `fact.embedding`'s NOT NULL. The claim that a fleet-13
    // instance cannot tell is worth exactly this surface: if it does not write
    // a fact, it proves nothing about the constraint that replaced it.
    const facts = FLEET_13_SURFACE.exchanges.flatMap((exchange) => exchange.statements);
    expect(facts.some((statement) => /^INSERT INTO fact \(page_id, statement, embedding/.test(statement.trim()))).toBe(
      true,
    );
    expect(facts.some((statement) => statement.includes('embedding <=>'))).toBe(true);
    expect(facts.some((statement) => statement.trim().startsWith('UPDATE chunk SET embedding'))).toBe(true);
  });

  test('one release of promise buys exactly one rung of tolerance', () => {
    // The link the lookahead constant depends on: the frozen surfaces prove
    // compatibility across one rung, so the fleet tolerates one rung. Measured
    // from the NEWEST frozen release, because that is the one an instance
    // running during the current rollout is actually on — taking the oldest
    // would let the tolerance grow by one rung every time a rung shipped
    // without a surface beside it.
    const newest = Math.max(...FLEET_SURFACES.map((surface) => surface.schemaVersion));
    expect(HEAD_SCHEMA_VERSION - newest).toBeGreaterThanOrEqual(SCHEMA_LOOKAHEAD);
  });
});
