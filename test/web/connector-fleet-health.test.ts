/**
 * The half that turns ten hours into ten minutes.
 *
 * **What was missing, exactly.** When every connector on a brain stopped
 * importing, there was no signal anywhere that an uptime monitor could have
 * polled. `/admin?op=queue_status` counts jobs by state and kind, and the queue
 * was spotless: a halted pull returns `stopped`, a stopped run is deliberately
 * not thrown on, so every job completed and no row was ever dead or late.
 * `/admin?op=connector_status` holds the answer and needs a `tenant_id` — which
 * is precisely what nobody had, because nobody knew anything was wrong.
 * `fleet_status` counted tenants and spend and knew nothing about connectors at
 * all.
 *
 * So this file asserts two things a monitor and an operator each need, and one
 * they must never be given:
 *
 *  1. **`fleet_status` carries one field to page on.** `connectors.verdict`,
 *     monotone, three levels, and no tenant identifier anywhere near it — that
 *     answer is the artifact most likely to end up in a chat channel.
 *  2. **`connector_status` with no `tenant_id` says which brain.** The drill-down
 *     the page leads to, on the same credential that could already list every
 *     tenant by name.
 *  3. **Neither is fooled by the clocks that lied.** Every case here is built by
 *     the real recorder, so a rule that read `last_attempt_at`, or the queue, or
 *     `items_failed`, fails them.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import {
  createControlPlaneConnectorHealth,
  ensureConnectorHealthSchema,
} from '../../src/control/connector-health.ts';
import { ensureConnectorLinkSchema } from '../../src/control/connector-pg.ts';
import { adminDispatch } from '../../src/web/admin.ts';
import {
  connect,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from '../worker/fixture.ts';

const NOW = new Date('2026-08-18T18:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Shaped like a sealed envelope and opening to nothing. No test here reads it. */
const ENVELOPE = 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBB';

const noOwners = { owners: () => Promise.resolve({ ok: true as const, owners: [] }) };

let fixture: ControlFixture;
let controlSql: SQL;
/** Errors from the real recorder. Asserted empty, or every case below is vacuous. */
let unrecorded: unknown[] = [];

beforeAll(async () => {
  fixture = await createControlPlane('fleethealth');
  controlSql = connect(fixture);
  await ensureConnectorHealthSchema(controlSql);
  await ensureConnectorLinkSchema(controlSql);
  for (const tenant of ['alice', 'bob', 'carol']) await seedTenant(controlSql, tenant);
}, 60_000);

afterAll(async () => {
  await controlSql?.close();
  if (fixture) await dropControlPlane(fixture);
});

beforeEach(async () => {
  unrecorded = [];
  await controlSql`DELETE FROM control.connector_health`;
  await controlSql`DELETE FROM control.connector_link`;
});

/** A link the user connected, or one they never finished / removed. */
async function link(
  tenantId: string,
  source: string,
  options: { readonly connected: boolean; readonly createdAt?: Date },
): Promise<void> {
  await controlSql`
    INSERT INTO control.connector_link (tenant_id, source, state, pending_since, fence, created_at, updated_at)
    VALUES (${tenantId}, ${source}::control.connector_source,
            ${options.connected ? ENVELOPE : null}, null, 1,
            ${options.createdAt ?? new Date(NOW.getTime() - 7 * 24 * HOUR)}, ${NOW})`;
}

/** One attempt, through the writer production uses. */
async function attempt(
  tenantId: string,
  source: string,
  at: Date,
  outcome: 'completed' | 'stopped' | 'failed',
  cause: string | null = null,
): Promise<void> {
  const recorder = createControlPlaneConnectorHealth(controlSql, (error) => unrecorded.push(error));
  await recorder.record({
    tenantId,
    source: source as 'gmail',
    at,
    runOutcome: outcome,
    ingestFailureCode: cause as never,
    ingestFailureStatus: null,
    jobFailureCode: null,
    itemsWritten: outcome === 'completed' ? 3 : 0,
    // Zero on the halt, exactly as the live row read. Both halt paths break out
    // of the item loop before anything is counted as lost.
    itemsFailed: 0,
  });
  expect(unrecorded).toEqual([]);
}

async function fleet(): Promise<Record<string, unknown>> {
  const answer = await adminDispatch(
    { controlSql, owners: noOwners },
    { name: 'fleet_status', now: NOW },
  );
  expect(answer.ok).toBe(true);
  return (answer as { content: Record<string, unknown> }).content;
}

async function connectors(args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const answer = await adminDispatch(
    { controlSql, owners: noOwners },
    { name: 'connector_status', args, now: NOW },
  );
  expect(answer.ok).toBe(true);
  return (answer as { content: Record<string, unknown> }).content;
}

// ---------------------------------------------------------------------------

describe('the fleet verdict a monitor can page on', () => {
  test('THE CASE: the ten-hour silence reaches the fleet field, through the real recorder', async () => {
    // Built the way the incident built it: one successful poll, then failing
    // polls every five minutes for ten hours. The recorder holds `last_success_at`
    // at the first and moves `last_attempt_at` to the last, which is what made
    // every attempt-based reading report a healthy fleet.
    await link('alice', 'gmail', { connected: true });
    await attempt('alice', 'gmail', new Date(NOW.getTime() - 10 * HOUR), 'completed');
    await attempt('alice', 'gmail', new Date(NOW.getTime() - 5 * MINUTE), 'stopped', 'embed_unavailable');

    const banked = await controlSql<{ last_attempt_at: Date; last_success_at: Date }[]>`
      SELECT last_attempt_at, last_success_at FROM control.connector_health`;
    // The two clocks, ten hours apart, in one row. This is the shape.
    expect(banked[0]?.last_attempt_at).toEqual(new Date(NOW.getTime() - 5 * MINUTE));
    expect(banked[0]?.last_success_at).toEqual(new Date(NOW.getTime() - 10 * HOUR));

    const status = await fleet();
    expect(status['connectors']).toMatchObject({
      verdict: 'stalled',
      total: 1,
      stale: 1,
      current: 0,
    });
  });

  test('a fleet whose connectors are all importing reads ok', async () => {
    await link('alice', 'gmail', { connected: true });
    await attempt('alice', 'gmail', new Date(NOW.getTime() - 10 * MINUTE), 'completed');
    await link('bob', 'calendar', { connected: true });
    await attempt('bob', 'calendar', new Date(NOW.getTime() - 20 * MINUTE), 'completed');

    expect(await fleet()).toMatchObject({
      connectors: { verdict: 'ok', total: 2, current: 2, stale: 0 },
    });
  });

  test('a fleet with no connectors at all is ok, and says so with a count rather than a mood', async () => {
    // Vacuously healthy. A verdict that read `unknown` on an empty fleet would be
    // permanently non-green, and a monitor that is always yellow is a monitor
    // that is off — which is the state that produced the ten hours. The count
    // beside it is what tells an empty fleet from a broken one.
    expect(await fleet()).toMatchObject({ connectors: { verdict: 'ok', total: 0 } });
  });

  test('one refused poll is degraded and not a page', async () => {
    // The error budget, deliberately split. A single failing attempt on a
    // connector that worked twenty minutes ago is an ordinary Tuesday; a monitor
    // may warn on it, and nobody should be woken.
    await link('alice', 'gmail', { connected: true });
    await attempt('alice', 'gmail', new Date(NOW.getTime() - 20 * MINUTE), 'completed');
    await attempt('alice', 'gmail', new Date(NOW.getTime() - MINUTE), 'stopped', 'rate_limited');

    expect(await fleet()).toMatchObject({
      connectors: { verdict: 'degraded', slipping: 1, stale: 0 },
    });
  });

  test('a source the user disconnected never pages, however old its health row', async () => {
    // Nothing deletes a health row on disconnect — the foreign key is to the
    // tenant, not to the link. Without the link filter every abandoned source in
    // the fleet would page forever, the alert would be muted within a week, and
    // this surface would be worse than none.
    await link('alice', 'gmail', { connected: false });
    await attempt('alice', 'gmail', new Date(NOW.getTime() - 90 * 24 * HOUR), 'completed');
    await attempt('alice', 'gmail', new Date(NOW.getTime() - 89 * 24 * HOUR), 'failed', 'auth_expired');

    expect(await fleet()).toMatchObject({ connectors: { verdict: 'ok', total: 0 } });
  });

  test('a connector connected minutes ago is starting, not an alarm', async () => {
    // Without this window every new signup would flip the verdict for its first
    // half hour — the first poll runs on the worker fleet's next wake, and a
    // first import can legitimately stop on a spend cap.
    await link('carol', 'drive', { connected: true, createdAt: new Date(NOW.getTime() - 10 * MINUTE) });
    await attempt('carol', 'drive', new Date(NOW.getTime() - 5 * MINUTE), 'stopped', 'budget_exhausted');

    expect(await fleet()).toMatchObject({
      connectors: { verdict: 'ok', starting: 1, never_succeeded: 0 },
    });
  });

  test('and the same connector a day later is not', async () => {
    await link('carol', 'drive', { connected: true, createdAt: new Date(NOW.getTime() - 24 * HOUR) });
    await attempt('carol', 'drive', new Date(NOW.getTime() - 5 * MINUTE), 'stopped', 'budget_exhausted');

    expect(await fleet()).toMatchObject({
      connectors: { verdict: 'stalled', never_succeeded: 1, starting: 0 },
    });
  });

  test('the fleet answer names no tenant, because it is the one that gets pasted', async () => {
    await link('alice', 'gmail', { connected: true });
    await attempt('alice', 'gmail', new Date(NOW.getTime() - 10 * HOUR), 'completed');
    await attempt('alice', 'gmail', new Date(NOW.getTime() - MINUTE), 'stopped', 'embed_unavailable');

    const block = (await fleet())['connectors'] as Record<string, unknown>;
    expect(JSON.stringify(block)).not.toContain('alice');
    // Codes, counts and one label. Nothing else is allowed to appear here by
    // accident, which is what pinning the key set buys over eyeballing it.
    expect(Object.keys(block).sort()).toEqual(
      [
        'current',
        'never_succeeded',
        'slipping',
        'stale',
        'starting',
        'total',
        'truncated',
        'unattended',
        'unpolled',
        'verdict',
      ].sort(),
    );
  });
});

describe('and the drill-down that says which brain', () => {
  test('connector_status with no tenant names the degraded lanes, fleet-wide', async () => {
    // The gap that made the ten hours ten hours: the operation that knew the
    // answer required the one thing nobody had. A page tells you the fleet is
    // stalled; this is the call that turns that into a tenant id.
    await link('alice', 'gmail', { connected: true });
    await attempt('alice', 'gmail', new Date(NOW.getTime() - 10 * HOUR), 'completed');
    await attempt('alice', 'gmail', new Date(NOW.getTime() - 5 * MINUTE), 'stopped', 'embed_unavailable');
    await link('bob', 'calendar', { connected: true });
    await attempt('bob', 'calendar', new Date(NOW.getTime() - 20 * MINUTE), 'completed');

    const content = await connectors();
    expect(content).toMatchObject({ scope: 'fleet', verdict: 'stalled', truncated: false });
    expect(content['connectors']).toMatchObject([
      {
        tenant_id: 'alice',
        source: 'gmail',
        freshness: 'stale',
        run_outcome: 'stopped',
        cause: 'embed_unavailable',
      },
    ]);
    // Only what is not fine. A healthy connector in the list is a list an
    // operator has to read rather than act on.
    expect((content['connectors'] as unknown[]).length).toBe(1);
  });

  test('and it still answers the per-tenant question in the per-tenant shape', async () => {
    // The existing operation, unchanged. The two answers have to be told apart
    // by something better than length, so the fleet one is stamped `scope`.
    await link('alice', 'gmail', { connected: true });
    await attempt('alice', 'gmail', new Date(NOW.getTime() - 5 * MINUTE), 'stopped', 'embed_unavailable');

    const content = await connectors({ tenant_id: 'alice' });
    expect(content).toMatchObject({ tenant_id: 'alice' });
    expect(content['scope']).toBeUndefined();
    expect(content['lanes']).toEqual([]);
    expect(content['connectors']).toMatchObject([
      { source: 'gmail', cause: 'embed_unavailable', last_success_at: null },
    ]);
  });
});
