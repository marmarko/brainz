/**
 * The per-tenant change channel (P13), and the two constraints that shape it.
 *
 * P13's demand is narrow and worth quoting: *"A gbrain user runs the upgrade …
 * A brainz user's memory changes behavior overnight with no notice, no changelog
 * channel, and no consent."* The answer is a change record — what shipped, what
 * it did to your memory, what you can do about it — staged per tenant.
 *
 * **Constraint one: the control plane is content-free.** So "what it did to your
 * memory" cannot be stored anywhere. It is rendered from the tenant's own
 * database at read time and thrown away. Testing an absence is the trap here: an
 * assertion that a string is missing from the control plane passes trivially if
 * the string was never produced. So every content-free assertion below is paired
 * with its positive half — the distinctive title is asserted **present** in the
 * rendered block first, and only then absent from every textual column of every
 * control-plane table, enumerated from `information_schema` rather than from a
 * list somebody has to remember to extend.
 *
 * The second leak surface is the fleet-wide record itself: it is committed, it is
 * identical for every tenant, and it is rendered against many. Its bytes are
 * asserted unchanged after rendering for two different tenants, so a renderer
 * that ever wrote back into it fails here rather than in the next tenant's
 * output.
 *
 * **Constraint two: staging is fail-closed.** A tenant with no row for a flag
 * sees nothing. That is the direction that matters — an off-by-default channel
 * shows a change to nobody until somebody stages it; an on-by-default one ships
 * every draft record to the whole fleet the moment it is committed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { createControlPlane, dropControlPlane, connect as connectControl } from '../worker/fixture.ts';
import {
  connect as connectTenant,
  dropFixtureDatabase,
  provisionFixture,
  type SchemaFixture,
} from '../schema/fixture.ts';
import { FLAG_REGISTRY, readFlagStages, setFlagStage } from '../../src/control/flags.ts';
import { changeChannel, measureEffects } from '../../src/upstream/change-channel.ts';
import { loadChangeRecords, parseChangeRecord } from '../../src/upstream/changes.ts';
import { textArrayLiteral } from '../../src/core/write/pg-values.ts';

/** Distinctive enough that finding it anywhere is proof, not coincidence. */
const SECRET_TITLE = 'zqx-marbled-heron-invoice-7741';
const OTHER_TITLE = 'zqx-plaited-otter-memo-9920';

let control: Awaited<ReturnType<typeof createControlPlane>>;
let controlSql: SQL;
let alice: SchemaFixture;
let bob: SchemaFixture;
let aliceSql: SQL;
let bobSql: SQL;

const records = await loadChangeRecords();

beforeAll(async () => {
  control = await createControlPlane('u19_changes');
  controlSql = connectControl(control);
  await controlSql`
    INSERT INTO control.tenant (tenant_id, state, fts_language)
    VALUES ('alice', 'provisioning', 'simple'), ('bob', 'provisioning', 'simple')`;

  alice = await provisionFixture('u19_alice');
  bob = await provisionFixture('u19_bob');
  aliceSql = connectTenant(alice);
  bobSql = connectTenant(bob);

  for (const [sql, title] of [
    [aliceSql, SECRET_TITLE],
    [bobSql, OTHER_TITLE],
  ] as const) {
    await sql`
      INSERT INTO page (origin_context, source_type, title, content_sha256, embedding_model,
                        embedding_dimensions, chunker_version, normalizer_version)
      VALUES ('personal', 'note', ${title}, ${'0'.repeat(63) + '1'}, 'test-embed', 1536, 1, 1)`;
  }
}, 120_000);

afterAll(async () => {
  await aliceSql?.close();
  await bobSql?.close();
  await controlSql?.close();
  if (alice !== undefined) await dropFixtureDatabase(alice);
  if (bob !== undefined) await dropFixtureDatabase(bob);
  if (control !== undefined) await dropControlPlane(control);
}, 120_000);

describe('the committed change records', () => {
  test('there is at least one, and each names a flag the registry declares', () => {
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) expect([...FLAG_REGISTRY as readonly string[]]).toContain(record.flag);
  });

  test('a record naming a flag nobody declared is refused', () => {
    expect(() =>
      parseChangeRecord({ ...records[0], id: 'x', flag: 'not_a_declared_flag' }, 'fixture.json'),
    ).toThrow(/flag/);
  });

  test('a record naming an effect probe nobody wrote is refused', () => {
    expect(() =>
      parseChangeRecord({ ...records[0], id: 'x', effect: { probe: 'no_such_probe' } }, 'fixture.json'),
    ).toThrow(/probe/);
  });
});

describe('staging is per tenant and fail-closed', () => {
  test('a tenant with no flag row sees nothing', async () => {
    const stages = await readFlagStages(controlSql, 'alice');
    expect(stages.size).toBe(0);
    const block = await changeChannel({ records, stages, sql: aliceSql });
    expect(block.changes).toEqual([]);
  });

  test('`off` is not the same as absent, and still shows nothing', async () => {
    await setFlagStage(controlSql, 'alice', records[0]!.flag, 'off');
    const stages = await readFlagStages(controlSql, 'alice');
    expect(stages.get(records[0]!.flag)).toBe('off');
    expect((await changeChannel({ records, stages, sql: aliceSql })).changes).toEqual([]);
  });

  test('`canary` shows it to that tenant and to no other', async () => {
    await setFlagStage(controlSql, 'alice', records[0]!.flag, 'canary');

    const aliceBlock = await changeChannel({
      records,
      stages: await readFlagStages(controlSql, 'alice'),
      sql: aliceSql,
    });
    const bobBlock = await changeChannel({
      records,
      stages: await readFlagStages(controlSql, 'bob'),
      sql: bobSql,
    });

    expect(aliceBlock.changes.map((change) => change.id)).toContain(records[0]!.id);
    expect(aliceBlock.changes[0]?.stage).toBe('canary');
    expect(bobBlock.changes).toEqual([]);
  });

  test('`on` shows it too — the stage is carried so a user can see they are early', async () => {
    await setFlagStage(controlSql, 'bob', records[0]!.flag, 'on');
    const block = await changeChannel({
      records,
      stages: await readFlagStages(controlSql, 'bob'),
      sql: bobSql,
    });
    expect(block.changes[0]?.stage).toBe('on');
  });
});

describe('what it did to YOUR memory is measured against your own database', () => {
  test('the effect probe reads the tenant, and the two tenants differ', async () => {
    const effect = await measureEffects(aliceSql, records[0]!);
    expect(effect).toBeDefined();
    expect(effect?.count).toBe(1);
    expect(effect?.examples).toEqual([SECRET_TITLE]);

    const other = await measureEffects(bobSql, records[0]!);
    expect(other?.examples).toEqual([OTHER_TITLE]);
  });

  test('the rendered block names the tenant’s own content', async () => {
    // The positive half. Without it every absence assertion below is vacuous.
    const block = await changeChannel({
      records,
      stages: await readFlagStages(controlSql, 'alice'),
      sql: aliceSql,
    });
    expect(JSON.stringify(block)).toContain(SECRET_TITLE);
    expect(JSON.stringify(block)).not.toContain(OTHER_TITLE);
  });
});

describe('nothing rendered is written back anywhere', () => {
  test('no textual column of any control-plane table holds either tenant’s content', async () => {
    // Enumerated from the catalog rather than from a list of tables: a table a
    // later unit adds is covered by this assertion the day it lands.
    const columns = await controlSql<{ table_name: string; column_name: string }[]>`
      SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'control' AND t.table_type = 'BASE TABLE'`;

    expect(columns.length).toBeGreaterThan(10);

    const hits: string[] = [];
    for (const column of columns) {
      const rows = await controlSql.unsafe(
        `SELECT count(*)::int AS n FROM control.${column.table_name}
         WHERE ${column.column_name}::text = ANY($1::text[])`,
        // Bun's SQL spreads a JavaScript array into a value list, which is the
        // very footgun `src/core/write/pg-values.ts` exists for — and the one
        // H8 was swept for. Bind the literal as text and let the cast parse it.
        [textArrayLiteral([SECRET_TITLE, OTHER_TITLE])],
      );
      const found = (rows as unknown as { n: number }[])[0]?.n ?? 0;
      if (found > 0) hits.push(`control.${column.table_name}.${column.column_name}`);
    }

    expect(hits).toEqual([]);
  });

  test('the committed fleet-wide record is byte-identical after rendering for two tenants', async () => {
    const before = await Bun.file(records[0]!.path).text();
    await changeChannel({ records, stages: await readFlagStages(controlSql, 'alice'), sql: aliceSql });
    await changeChannel({ records, stages: await readFlagStages(controlSql, 'bob'), sql: bobSql });
    expect(await Bun.file(records[0]!.path).text()).toBe(before);
  });

  test('the record the channel returns still carries the template, not one tenant’s numbers', () => {
    // The record objects are shared across tenants in one process. A renderer
    // that substituted in place would leak alice's counts into bob's response
    // and the leak would be invisible in a single-tenant test.
    expect(records[0]?.what_it_did_to_your_memory).toContain('{count}');
  });
});
