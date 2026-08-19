/**
 * Rung three, checked against the database rather than against the file that was
 * supposed to create it.
 *
 * `test/schema/tenant-schema.test.ts` already enumerates every table's class,
 * origin shape and immutability trigger, and rung three's tables join that
 * enumeration rather than escaping it. What is asserted *here* is the part that
 * is specific to consolidation and that no general rule would notice:
 *
 *   - **The anti-loop marker exists and defaults to `ingested`.** It is the
 *     column every model phase's candidate query filters on. A default of
 *     anything else would make every pre-existing page invisible to extraction;
 *     no default at all would break the previous fleet version's INSERTs, which
 *     is what the expand/contract rule forbids.
 *   - **A derived row cannot claim to be ingested.** The CHECK is what stops a
 *     materializer from writing a summary page that the next cycle re-reads as
 *     evidence — the guard in `materialize.ts` is the first line, and this is the
 *     one that holds when somebody writes the row by hand.
 *   - **The run record can say `dreamt: false` with a reason**, because "the
 *     cycle stopped early" and "the cycle had nothing to do" must not be the same
 *     row.
 *   - **A review-queue entry cannot be closed by the channel R12a forbids.**
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { findExpandContractViolations } from '../../src/control/migrate.ts';
import {
  HEAD_SCHEMA_VERSION,
  MIGRATIONS,
  readMigrationDdl,
} from '../../src/schema/migrations.ts';
import { CYCLE_PHASES, PHASE_STOPS } from '../../src/worker/consolidate/phases.ts';
import {
  connect,
  dropFixtureDatabase,
  provisionFixture,
  sqlstateOfFailure,
  type SchemaFixture,
} from '../schema/fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;

let fixture: SchemaFixture;
let sql: SQL;

beforeAll(async () => {
  fixture = await provisionFixture('consolidation');
  sql = connect(fixture);
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await sql?.close();
  if (fixture !== undefined) await dropFixtureDatabase(fixture);
}, SETUP_TIMEOUT_MS);

/**
 * The rung this suite is about, found by name rather than by "the head".
 *
 * It was `HEAD_SCHEMA_VERSION` until U12 added a rung above it, at which point
 * "the head" silently became a different file and this suite would have been
 * asserting U12's properties while claiming U11's. A rung is identified by what
 * it is, not by where it currently sits on the ladder.
 */
const CONSOLIDATION_RUNG = MIGRATIONS.find((migration) => migration.name === 'consolidation');

describe('the rung is on the ladder and is additive', () => {
  test('the ladder names the consolidation rung', () => {
    expect(CONSOLIDATION_RUNG).toBeDefined();
    expect(CONSOLIDATION_RUNG!.version).toBeLessThanOrEqual(HEAD_SCHEMA_VERSION);
  });

  test('the rung contains no contracting statement', async () => {
    const head = CONSOLIDATION_RUNG;
    expect(head).toBeDefined();
    if (head === undefined) return;
    const ddl = await readMigrationDdl(head);
    expect(findExpandContractViolations(ddl)).toEqual([]);
  });

  test('the ledger records it as applied', async () => {
    const rows = (await sql`SELECT version FROM schema_migration ORDER BY version`) as Array<{
      version: number;
    }>;
    expect(rows.map((row) => row.version)).toContain(HEAD_SCHEMA_VERSION);
  });
});

describe('the anti-loop marker', () => {
  test('page and fact both carry a derivation that defaults to ingested', async () => {
    const rows = (await sql`
      SELECT table_name, column_default, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'derivation'
         AND table_name IN ('page', 'fact')
       ORDER BY table_name
    `) as Array<{ table_name: string; column_default: string | null; is_nullable: string }>;

    expect(rows.map((row) => row.table_name)).toEqual(['fact', 'page']);
    for (const row of rows) {
      expect(row.is_nullable).toBe('NO');
      // NOT NULL *with* a default: the previous fleet version's INSERTs name the
      // old column list, and they have to keep working for the length of a
      // rolling deploy.
      expect(row.column_default ?? '').toContain('ingested');
    }
  });

  test('a page written by the previous fleet version is ingested, not derived', async () => {
    await sql.unsafe(`
      INSERT INTO page (origin_context, source_type, title, embedding_model, embedding_dimensions,
                        chunker_version, normalizer_version, content_sha256)
      VALUES ('personal:mail', 'email', 'legacy insert', 'text-embedding-3-large', 1536, 1, 1, repeat('c', 64))
    `);
    const rows = (await sql`
      SELECT derivation FROM page WHERE title = 'legacy insert'
    `) as Array<{ derivation: string }>;
    expect(rows[0]?.derivation).toBe('ingested');
  });

  test('an unknown derivation is refused by the database, not just by the writer', async () => {
    const state = await sqlstateOfFailure(
      sql,
      `INSERT INTO page (origin_context, source_type, title, derivation, embedding_model,
                         embedding_dimensions, chunker_version, normalizer_version, content_sha256)
       VALUES ('personal:mail', 'note', 'bad derivation', 'laundered', 'text-embedding-3-large',
               1536, 1, 1, repeat('d', 64))`,
    );
    expect(state).toBe('23514');
  });
});

describe('the per-cycle run record', () => {
  test('a run that stopped early must say why; a finished one must not claim both', async () => {
    const undreamt = await sqlstateOfFailure(
      sql,
      `INSERT INTO consolidation_run (trigger_reason, tier, dreamt, finished_at)
       VALUES ('time_ceiling', 'paid', false, now())`,
    );
    // A finished, undreamt run with no stop reason is exactly the row that makes
    // "consolidated but not dreamt" unreadable.
    expect(undreamt).toBe('23514');

    await sql.unsafe(`
      INSERT INTO consolidation_run (trigger_reason, tier, dreamt, finished_at, stop_reason)
      VALUES ('time_ceiling', 'free', false, now(), 'free_tier')
    `);
    const rows = (await sql`
      SELECT dreamt, stop_reason FROM consolidation_run ORDER BY run_id DESC LIMIT 1
    `) as Array<{ dreamt: boolean; stop_reason: string }>;
    expect(rows[0]).toEqual({ dreamt: false, stop_reason: 'free_tier' });
  });
});

/**
 * The phase attribution rung 20 adds, checked against the database's own
 * alphabet rather than against the file that was supposed to write it.
 *
 * **Both columns are closed vocabularies, and the vocabularies are the code's.**
 * The CHECKs spell out `CYCLE_PHASES` and `PHASE_STOPS`, which is one fact in
 * two places, so the assertion below is that the two places agree: every member
 * the cycle can produce is a value the database accepts, and a value the cycle
 * cannot produce is one it refuses. Without that, a phase added to `phases.ts`
 * would start failing its own run record's CHECK the first time it stopped a
 * cycle — at exactly the moment somebody needed to read it.
 *
 * The refusals matter more than the admissions. A column that took free text
 * here is one prompt away from holding the provider's sentence, and the phase a
 * cycle stopped in is at its most tempting to describe rather than to name.
 */
describe('rung 20 — which phase stopped the cycle', () => {
  test('every phase the cycle can stop in is a value the run record accepts', async () => {
    for (const phase of CYCLE_PHASES) {
      await sql.unsafe(
        `INSERT INTO consolidation_run (trigger_reason, tier, stopped_phase, stopped_phase_code)
         VALUES ('time_ceiling', 'paid', $1, 'out_of_time')`,
        [phase],
      );
    }
    const rows = (await sql`
      SELECT count(DISTINCT stopped_phase)::int AS n FROM consolidation_run
       WHERE stopped_phase IS NOT NULL
    `) as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(CYCLE_PHASES.length);
  });

  test('every code a phase can stop with is a value the run record accepts', async () => {
    for (const code of PHASE_STOPS) {
      await sql.unsafe(
        `INSERT INTO consolidation_run (trigger_reason, tier, stopped_phase, stopped_phase_code)
         VALUES ('time_ceiling', 'paid', 'synopsis', $1)`,
        [code],
      );
    }
    const rows = (await sql`
      SELECT count(DISTINCT stopped_phase_code)::int AS n FROM consolidation_run
       WHERE stopped_phase_code IS NOT NULL
    `) as Array<{ n: number }>;
    expect(rows[0]?.n).toBe(PHASE_STOPS.length);
  });

  test('a phase name nobody declared is refused by the database', async () => {
    const state = await sqlstateOfFailure(
      sql,
      `INSERT INTO consolidation_run (trigger_reason, tier, stopped_phase, stopped_phase_code)
       VALUES ('time_ceiling', 'paid', 'summarising the Q3 board deck', 'bad_output')`,
    );
    expect(state).toBe('23514');
  });

  test('a run-level stop reason is not a phase-level code', async () => {
    // `cancelled`, `complete` and `free_tier` are things a *run* does. A phase
    // never reports them, so admitting them here would make the column mean two
    // things and make "which code did the phase stop with" unanswerable.
    for (const reason of ['cancelled', 'complete', 'free_tier', 'phase_failed']) {
      const state = await sqlstateOfFailure(
        sql,
        `INSERT INTO consolidation_run (trigger_reason, tier, stopped_phase, stopped_phase_code)
         VALUES ('time_ceiling', 'paid', 'synopsis', '${reason}')`,
      );
      expect(state).toBe('23514');
    }
  });

  test('half an attribution is refused — a phase with no code says nothing', async () => {
    const orphanPhase = await sqlstateOfFailure(
      sql,
      `INSERT INTO consolidation_run (trigger_reason, tier, stopped_phase)
       VALUES ('time_ceiling', 'paid', 'synopsis')`,
    );
    expect(orphanPhase).toBe('23514');

    const orphanCode = await sqlstateOfFailure(
      sql,
      `INSERT INTO consolidation_run (trigger_reason, tier, stopped_phase_code)
       VALUES ('time_ceiling', 'paid', 'bad_output')`,
    );
    expect(orphanCode).toBe('23514');
  });

  test('the previous fleet version writes neither column and is not refused', async () => {
    // The rolling-deploy case, and the reason nothing here is tied to
    // `stop_reason` or `dreamt` by a CHECK. An instance running the release
    // before this rung resumes a run a newer instance attributed, completes it,
    // and issues an UPDATE that names only the columns it knows about.
    await sql.unsafe(`
      INSERT INTO consolidation_run (trigger_reason, tier, stopped_phase, stopped_phase_code)
      VALUES ('time_ceiling', 'paid', 'enrich', 'model_unavailable')
    `);
    await sql.unsafe(`
      UPDATE consolidation_run
         SET dreamt = true, stop_reason = 'complete', finished_at = now()
       WHERE run_id = (SELECT max(run_id) FROM consolidation_run)
    `);
    const rows = (await sql`
      SELECT dreamt, stop_reason, stopped_phase FROM consolidation_run
       ORDER BY run_id DESC LIMIT 1
    `) as Array<{ dreamt: boolean; stop_reason: string; stopped_phase: string | null }>;
    // The old release leaves the attribution behind because it cannot see it.
    // That is the price of the lookahead and it is the right one: a CHECK that
    // refused this UPDATE would turn a rolling deploy into an outage, and the
    // current release clears the pair itself on every write.
    expect(rows[0]).toEqual({ dreamt: true, stop_reason: 'complete', stopped_phase: 'enrich' });
  });
});

describe('R15 — a derived artifact cannot narrow its inputs’ origins', () => {
  test('an entity card claiming less than the entity it describes is refused', async () => {
    await sql.unsafe(`
      INSERT INTO entity (canonical_name, entity_type, origin_contexts) VALUES
        ('union-subject', 'person', ARRAY['personal:mail','work:files']),
        ('union-subject-2', 'person', ARRAY['personal:mail','work:files'])
    `);

    // The covering case first, so the refusal below is a refusal of something
    // and not of everything.
    await sql.unsafe(`
      INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts)
      SELECT entity_id, 'covers both', 'model_inferred', 'model_derived',
             ARRAY['personal:mail','work:files']
        FROM entity WHERE canonical_name = 'union-subject'
    `);

    const state = await sqlstateOfFailure(
      sql,
      `INSERT INTO entity_card (entity_id, summary, trust_level, derivation, origin_contexts)
       SELECT entity_id, 'narrows to one', 'model_inferred', 'model_derived', ARRAY['personal:mail']
         FROM entity WHERE canonical_name = 'union-subject-2'`,
    );
    // BZ002: a derived row that does not carry an input's origin. KTD5 fences on
    // origin alone, so this is a work relationship handed to a personal-fenced
    // reader one derivation removed.
    expect(state).toBe('BZ002');
  });
});

describe('R12a — a review entry closes out of band or not at all', () => {
  test('a restatement over MCP cannot close a review entry', async () => {
    const state = await sqlstateOfFailure(
      sql,
      // `closed_at` is supplied deliberately: without it the row also violates
      // the "a closed entry says who and when" CHECK, and the test would pass on
      // a schema that had dropped the R12a rule entirely.
      `INSERT INTO review_queue (kind, target_ref, proposal, confidence, state, closed_by, closed_at, origin_contexts)
       VALUES ('entity_merge', 'entity:1', 'merge these two', 0.6, 'applied', 'agent_mcp', now(), ARRAY['personal:mail'])`,
    );
    expect(state).toBe('23514');
  });

  test('a user action in the web app can', async () => {
    await sql.unsafe(`
      INSERT INTO review_queue (kind, target_ref, proposal, confidence, state, closed_by, closed_at, origin_contexts)
      VALUES ('entity_merge', 'entity:2', 'merge these two', 0.6, 'applied', 'user_out_of_band', now(), ARRAY['personal:mail'])
    `);
    const rows = (await sql`
      SELECT closed_by FROM review_queue WHERE target_ref = 'entity:2'
    `) as Array<{ closed_by: string }>;
    expect(rows[0]?.closed_by).toBe('user_out_of_band');
  });
});
