/**
 * The record of why a poll failed: what it may say, and what it may not carry.
 *
 * Two properties, and they pull in opposite directions — which is why they are
 * in one file.
 *
 * **1. It must be able to name the cause.** The whole point of the table is that
 * `handler_error` on a job row is not an answer, and four causes — the vendor
 * refused, the budget stopped it, the tenant database was unreachable, the code
 * threw — have to be distinguishable by a reader with no shell on a container.
 *
 * **2. It must not be able to name anything else.** A failure reason is a code
 * and a timestamp. The ordinary way somebody's subject line reaches a
 * content-free database is an exception message assigned to a field that will
 * take one, and the ordinary way it stays out is that no field will. So the
 * violating fixture below is an error carrying a subject line in every place a
 * careless implementation would read from, run at every layer that could store
 * it.
 *
 * `test/control/schema.test.ts` already proves the *shape* rule over
 * `connector-health.sql` by globbing `src/**\/*.sql` — every column typed by an
 * enum or a bounded, alphabet-pinned domain. What that guard cannot know is
 * whether the labels in those enums are the same labels the rest of the fleet
 * uses, which is the first half of this file, or what the write path does with a
 * value they refuse, which is the second.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import {
  causeOf,
  createControlPlaneConnectorHealth,
  ensureConnectorHealthSchema,
  readConnectorHealth,
} from '../../src/control/connector-health.ts';
import { INGEST_FAILURE_CODES } from '../../src/ingest/log.ts';
import { CONNECTOR_SOURCES } from '../../src/ingest/cursor.ts';
import { PULL_OUTCOMES } from '../../src/ingest/pipedream/pull.ts';
import { JOB_FAILURE_CODES, jobFailureCodeOf } from '../../src/worker/jobs.ts';
import {
  connect,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from '../worker/fixture.ts';

const TENANT = 'health-alice';
const NOW = new Date('2026-08-17T09:00:00.000Z');

/**
 * A subject line, in the shape a real one has: capitals, spaces, punctuation,
 * and a provider's id beside it. Nothing in the control plane may hold this, and
 * every assertion about that names this constant rather than a substring of it.
 */
const SUBJECT = "Re: Q3 payroll numbers — final (attn: legal)";

const SCHEMA_PATH = `${import.meta.dir}/../../src/control/connector-health.sql`;
const SCHEMA_SQL = await Bun.file(SCHEMA_PATH).text();

/** The labels of one `CREATE TYPE … AS ENUM` in the DDL, in declaration order. */
function enumLabels(name: string): string[] {
  const pattern = new RegExp(`CREATE TYPE ${name} AS ENUM\\s*\\(([^)]*)\\)`, 'i');
  const found = pattern.exec(SCHEMA_SQL);
  if (found === null) throw new Error(`no enum named ${name} in connector-health.sql`);
  return [...(found[1] ?? '').matchAll(/'([^']*)'/g)].map((match) => match[1] ?? '');
}

let fixture: ControlFixture;
let sql: SQL;

beforeAll(async () => {
  fixture = await createControlPlane('connectorhealth');
  sql = connect(fixture);
  await ensureConnectorHealthSchema(sql);
  await seedTenant(sql, TENANT);
}, 60_000);

afterAll(async () => {
  await sql?.close();
  if (fixture !== undefined) await dropControlPlane(fixture);
});

async function clear(): Promise<void> {
  await sql`DELETE FROM control.connector_health`;
}

describe('the vocabularies are the fleet’s, not this table’s', () => {
  /**
   * **Why these four cases exist.** A cause has to survive three hops — the run
   * records it in the tenant's `ingest_log`, the handler hands it to the control
   * plane, and the panel turns it into a sentence — and each hop is a place a
   * label could be spelled differently. A fifth vocabulary in the middle of that
   * is not a small mess: it is a code the panel cannot translate and an operator
   * cannot look up, arriving on the one surface a user reads when something is
   * already wrong. So the DDL is parsed and compared, rather than reviewed.
   */
  test('the ingest failure codes are `ingest_log.failure_code`’s', () => {
    expect(enumLabels('control.connector_ingest_failure')).toEqual([...INGEST_FAILURE_CODES]);
  });

  test('the job failure codes are `control.job.failure_code`’s', () => {
    expect(enumLabels('control.connector_job_failure')).toEqual([...JOB_FAILURE_CODES]);
  });

  test('the run outcomes are `PullResult.outcome`’s', () => {
    expect(enumLabels('control.connector_run_outcome')).toEqual([...PULL_OUTCOMES]);
  });

  test('the sources are the three connectors the rest of the fleet serves', () => {
    expect(enumLabels('control.connector_health_source')).toEqual([...CONNECTOR_SOURCES]);
  });
});

describe('the record answers "why is this connector not polling"', () => {
  test('a provider refusal is stored as the run’s own code, and read back', async () => {
    await clear();
    const health = createControlPlaneConnectorHealth(sql, (error) => {
      throw error;
    });
    await health.record({
      tenantId: TENANT,
      source: 'gmail',
      at: NOW,
      runOutcome: 'failed',
      ingestFailureCode: 'auth_expired',
      jobFailureCode: null,
      itemsWritten: 0,
      itemsFailed: 0,
    });

    const stored = (await readConnectorHealth(sql, { tenantId: TENANT })).get('gmail');
    expect(stored).toMatchObject({
      runOutcome: 'failed',
      ingestFailureCode: 'auth_expired',
      jobFailureCode: null,
      lastSuccessAt: null,
    });
    expect(causeOf(stored)).toBe('auth_expired');
  });

  test('an unreachable brain is a different record from a bug in our code', async () => {
    await clear();
    const health = createControlPlaneConnectorHealth(sql, (error) => {
      throw error;
    });
    for (const [source, code] of [
      ['gmail', 'tenant_unavailable'],
      ['calendar', 'handler_error'],
    ] as const) {
      await health.record({
        tenantId: TENANT,
        source,
        at: NOW,
        runOutcome: null,
        ingestFailureCode: null,
        jobFailureCode: code,
        itemsWritten: 0,
        itemsFailed: 0,
      });
    }

    const stored = await readConnectorHealth(sql, { tenantId: TENANT });
    // The distinction the job row could have made since U10 and never did: one
    // of these is a substrate incident that clears on its own, the other is ours
    // and will not.
    expect(causeOf(stored.get('gmail'))).toBe('tenant_unavailable');
    expect(causeOf(stored.get('calendar'))).toBe('handler_error');
  });

  test('a recovery clears the cause instead of leaving a red line', async () => {
    await clear();
    const health = createControlPlaneConnectorHealth(sql, (error) => {
      throw error;
    });
    await health.record({
      tenantId: TENANT,
      source: 'gmail',
      at: NOW,
      runOutcome: 'failed',
      ingestFailureCode: 'rate_limited',
      jobFailureCode: null,
      itemsWritten: 0,
      itemsFailed: 3,
    });
    const later = new Date(NOW.getTime() + 1_800_000);
    await health.record({
      tenantId: TENANT,
      source: 'gmail',
      at: later,
      runOutcome: 'completed',
      ingestFailureCode: null,
      jobFailureCode: null,
      itemsWritten: 12,
      itemsFailed: 0,
    });

    // The upsert overwrites with NULL rather than coalescing. A `COALESCE`
    // upsert is the shape somebody reaches for when they think of this as
    // "merging what we know", and it is how a connector that recovered keeps a
    // red code for the rest of its life.
    const stored = (await readConnectorHealth(sql, { tenantId: TENANT })).get('gmail');
    expect(stored).toMatchObject({
      runOutcome: 'completed',
      ingestFailureCode: null,
      jobFailureCode: null,
      itemsWritten: 12,
      itemsFailed: 0,
      lastSuccessAt: later,
    });
    expect(causeOf(stored)).toBeNull();
  });

  test('a later failure does not erase when the connector last worked', async () => {
    await clear();
    const health = createControlPlaneConnectorHealth(sql, (error) => {
      throw error;
    });
    const worked = new Date(NOW.getTime() - 86_400_000);
    await health.record({
      tenantId: TENANT,
      source: 'gmail',
      at: worked,
      runOutcome: 'completed',
      ingestFailureCode: null,
      jobFailureCode: null,
      itemsWritten: 4,
      itemsFailed: 0,
    });
    await health.record({
      tenantId: TENANT,
      source: 'gmail',
      at: NOW,
      runOutcome: 'failed',
      ingestFailureCode: 'auth_expired',
      jobFailureCode: null,
      itemsWritten: 0,
      itemsFailed: 0,
    });

    const stored = (await readConnectorHealth(sql, { tenantId: TENANT })).get('gmail');
    // "It is failing now" and "it has never worked" are different emergencies,
    // and this is the one column that tells them apart.
    expect(stored?.lastSuccessAt).toEqual(worked);
    expect(stored?.ingestFailureCode).toBe('auth_expired');
  });

  test('a record that explains nothing is not storable', async () => {
    await clear();
    // The guard, mutated in isolation: everything else about this row is legal,
    // and the only thing wrong with it is that it says an attempt happened and
    // nothing about it — which is the state the whole table exists to end.
    const refused = await sql`
      INSERT INTO control.connector_health (tenant_id, source, last_attempt_at)
      VALUES (${TENANT}, 'gmail'::control.connector_health_source, ${NOW})
    `.then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(refused)).toContain('connector_health_says_what_happened');
  });

  test('a completed run cannot also carry a cause', async () => {
    await clear();
    const refused = await sql`
      INSERT INTO control.connector_health (
        tenant_id, source, last_attempt_at, run_outcome, ingest_failure_code
      ) VALUES (
        ${TENANT}, 'gmail'::control.connector_health_source, ${NOW},
        'completed'::control.connector_run_outcome,
        'auth_expired'::control.connector_ingest_failure
      )
    `.then(
      () => null,
      (error: unknown) => error,
    );
    expect(String(refused)).toContain('connector_health_completed_runs_name_no_cause');
  });
});

describe('a failure reason is a code, and cannot become a subject line', () => {
  /**
   * **The violating case, built rather than imagined.** A provider's error body
   * routinely quotes the item it was about, so an exception on the pull path is
   * exactly where a subject line is available to a careless implementation. The
   * three places one could be assigned are: the property the runner reads off a
   * thrown error, the column the queue writes, and the column this table writes.
   * Each is checked on its own below.
   */
  const carrying = Object.assign(new Error(`provider refused: ${SUBJECT} (msg_881)`), {
    jobFailureCode: SUBJECT,
  });

  test('the classifier refuses a code the vocabulary does not contain', () => {
    // Not "sanitises" — refuses. The fallback is the label that was already
    // there, so a handler that tried this records exactly what it recorded
    // before, and the text goes nowhere.
    expect(jobFailureCodeOf(carrying, false)).toBe('handler_error');
    expect(jobFailureCodeOf(carrying, false)).not.toContain('Q3');

    // The positive control: without it this test would pass against a
    // classifier that answered `handler_error` for everything, including for
    // the codes the whole change exists to record.
    expect(jobFailureCodeOf({ jobFailureCode: 'tenant_unavailable' }, false)).toBe(
      'tenant_unavailable',
    );
    // And the fence still wins. A handler that noticed something on its way out
    // does not get to relabel a lease it had already lost.
    expect(jobFailureCodeOf({ jobFailureCode: 'tenant_unavailable' }, true)).toBe('lease_stolen');
  });

  test('the column refuses it too, so the classifier is not the only thing standing there', async () => {
    await clear();
    const refused = await sql`
      INSERT INTO control.connector_health (
        tenant_id, source, last_attempt_at, job_failure_code
      ) VALUES (
        ${TENANT}, 'gmail'::control.connector_health_source, ${NOW},
        ${SUBJECT}::control.connector_job_failure
      )
    `.then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).not.toBeNull();
    // Postgres names the type it could not produce a value of. What matters is
    // that the statement did not commit — asserted below against the table.
    expect(String(refused)).toContain('connector_job_failure');
    const rows = (await sql`
      SELECT count(*)::int AS n FROM control.connector_health`) as unknown as { n: number }[];
    expect(rows[0]?.n).toBe(0);
  });

  test('nothing in the whole table can be made to hold it', async () => {
    await clear();
    const health = createControlPlaneConnectorHealth(sql, (error) => {
      throw error;
    });
    await health.record({
      tenantId: TENANT,
      source: 'gmail',
      at: NOW,
      runOutcome: 'failed',
      ingestFailureCode: 'provider_error',
      jobFailureCode: jobFailureCodeOf(carrying, false),
      itemsWritten: 0,
      itemsFailed: 2,
    });

    // Every text-shaped value in the table, concatenated. A future column that
    // could hold prose fails this without anybody having to remember to add a
    // case for it, which is the only version of this assertion worth writing.
    const dumped = (await sql`
      SELECT string_agg(t.value::text, ' ') AS all_text
        FROM control.connector_health h,
             LATERAL (VALUES
               (h.tenant_id::text), (h.source::text), (h.run_outcome::text),
               (h.ingest_failure_code::text), (h.job_failure_code::text),
               (h.last_attempt_at::text), (h.last_success_at::text),
               (h.items_written::text), (h.items_failed::text)
             ) AS t(value)`) as unknown as { all_text: string | null }[];
    const text = dumped[0]?.all_text ?? '';
    expect(text).toContain('provider_error');
    expect(text).not.toContain('Q3');
    expect(text).not.toContain('payroll');
    expect(text).not.toContain('msg_881');
  });
});

/**
 * **The gap this suite would not have caught, and the deployment it would have
 * broken.**
 *
 * `ensureConnectorHealthSchema` used to return the instant the table existed.
 * That is right for the table and silently wrong for the enums declared beside
 * it: the DDL file is applied once per deployment ever, so a control plane that
 * already had the table could never learn a label the fleet added later. Every
 * test above runs against a control plane created from the *current* file, so
 * every one of them passed while that was true.
 *
 * What it would have cost: the seventh ingest code lands, the fleet deploys,
 * and the first connector to fail on a fleet credential tries to store
 * `fleet_auth_failed` into a six-label enum. The write raises, the recorder
 * hands the error to its sink and returns — by design, so a control-plane blip
 * cannot walk a tenant up the retry ladder — and the dashboard shows an attempt
 * with no cause at all. The one table built to end that silence would have been
 * the thing producing it.
 *
 * So the fixture here is the shape a live deployment actually has: the type as
 * it was *before* the label, the table already built on it, and `ensure` asked
 * to catch up.
 */
describe('a control plane built before a code existed learns it', () => {
  let old: ControlFixture;
  let oldSql: SQL;

  /**
   * `connector-health.sql`, rewound to the vocabulary *before* the newest label.
   *
   * Keyed on the newest label rather than on `fleet_auth_failed`, which is what
   * it used to name: that made the rewind silently stop rewinding the moment an
   * eighth label was appended after it, and a rewind that matches nothing is
   * caught below only because the throw was written. Any comment lines the DDL
   * carries between the labels are consumed too, or the strip leaves a dangling
   * `--` inside the enum body.
   */
  function ddlBeforeNewestCode(): string {
    const rewound = SCHEMA_SQL.replace(
      /,\s*\n(?:\s*--[^\n]*\n)*\s*'embed_unavailable'\n\)/,
      '\n)',
    );
    // The rewind must have done something, or this whole describe is asserting
    // that the current file equals itself.
    if (rewound === SCHEMA_SQL) throw new Error('the newest-label rewind matched nothing');
    return rewound;
  }

  beforeAll(async () => {
    old = await createControlPlane('connectorhealthold');
    oldSql = connect(old);
    await oldSql.unsafe(ddlBeforeNewestCode());
    await seedTenant(oldSql, TENANT);
  }, 60_000);

  afterAll(async () => {
    await oldSql?.close();
    if (old !== undefined) await dropControlPlane(old);
  });

  test('the table it already has is not rebuilt, and the enum it is missing is', async () => {
    const before = (await oldSql`
      SELECT enumlabel::text AS label FROM pg_enum
       WHERE enumtypid = 'control.connector_ingest_failure'::regtype
       ORDER BY enumsortorder`) as unknown as { label: string }[];
    // Filtered on the same label the rewind strips, so the two cannot drift: the
    // pair used to name `fleet_auth_failed` in both places and would have gone
    // on asserting a rewind that no longer happened.
    expect(before.map((row) => row.label)).toEqual(
      INGEST_FAILURE_CODES.filter((code) => code !== 'embed_unavailable'),
    );

    await ensureConnectorHealthSchema(oldSql);

    const after = (await oldSql`
      SELECT enumlabel::text AS label FROM pg_enum
       WHERE enumtypid = 'control.connector_ingest_failure'::regtype
       ORDER BY enumsortorder`) as unknown as { label: string }[];
    // In the constant's order, not merely present: `ADD VALUE` appends, so an
    // upgraded deployment and a fresh one agree only while the constant is
    // append-only. The pin at the top of this file compares the same sequence.
    expect(after.map((row) => row.label)).toEqual([...INGEST_FAILURE_CODES]);
  });

  test('and the cause it could not store before is stored, not swallowed', async () => {
    // The consequence, which is the only version of this worth asserting: a
    // label present in `pg_enum` and a row that will not insert are the same
    // outage. The sink rethrows here, so a swallowed failure fails the test.
    await ensureConnectorHealthSchema(oldSql);
    const health = createControlPlaneConnectorHealth(oldSql, (error) => {
      throw error;
    });
    await health.record({
      tenantId: TENANT,
      source: 'gmail',
      at: NOW,
      runOutcome: 'failed',
      ingestFailureCode: 'fleet_auth_failed',
      jobFailureCode: null,
      itemsWritten: 0,
      itemsFailed: 0,
    });

    const stored = (await readConnectorHealth(oldSql, { tenantId: TENANT })).get('gmail');
    expect(causeOf(stored)).toBe('fleet_auth_failed');
  });

  test('running it again changes nothing', async () => {
    // Idempotence is the property that lets every web and worker instance call
    // this at boot. A second pass that raised would crash-loop the fleet.
    await ensureConnectorHealthSchema(oldSql);
    await ensureConnectorHealthSchema(oldSql);
    const labels = (await oldSql`
      SELECT enumlabel::text AS label FROM pg_enum
       WHERE enumtypid = 'control.connector_ingest_failure'::regtype
       ORDER BY enumsortorder`) as unknown as { label: string }[];
    expect(labels.map((row) => row.label)).toEqual([...INGEST_FAILURE_CODES]);
  });
});
