/**
 * What `fleet_status` can and cannot say about a frozen brain, asserted as both.
 *
 * **The incident.** One brain's consolidation froze — 5,608 documents, 167
 * facts, flat for days — and nothing anywhere alerted. Not a queue row, not a
 * failure code, not a banner. A cycle ran every day on the scheduling ceiling,
 * stopped short in a phase, banked its reason, left its run open and *returned*;
 * a cycle that returns completes its job; and `queue.complete()` stamps
 * `control.tenant.last_cycle_at` and `next_due_at` in the same transaction as
 * `state = 'done', failure_code = NULL`. Measured on the live control plane
 * mid-freeze, the frozen brain's `last_cycle_at` was five and a half hours old
 * and a healthy canary's was eight hours old. **The frozen one looked better.**
 *
 * So this file pins two things that are usually in tension, and here are the
 * same discipline:
 *
 *  1. **What the control plane CAN see, it now says.** A ready tenant nothing
 *     has scheduled at all reaches `cycles.verdict: stalled`. That is the one
 *     cell a return clock answers truthfully, and nothing was reading it.
 *  2. **What it cannot see, it refuses to imply.** The frozen brain's own
 *     control-plane row reads `unobserved` and the fleet verdict stays `ok` —
 *     because the fact that separates a returning cycle from a completing one is
 *     `consolidation_run.stop_reason`, which lives in the tenant's database, and
 *     this fleet holds no tenant handles by design. `completion_observable:
 *     false` is how the answer says so, and the `unobserved` count is the size
 *     of the gap rather than a green light. A verdict that went permanently
 *     yellow instead would be a verdict nobody reads, which is the state that
 *     produced the days of silence.
 *
 * The rich reading — the one that fires on the freeze — is on the coverage page,
 * which opens a tenant handle. `test/web/coverage-route.test.ts` pins it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { ensureConnectorHealthSchema } from '../../src/control/connector-health.ts';
import { ensureConnectorLinkSchema } from '../../src/control/connector-pg.ts';
import { unattendedAfterSeconds } from '../../src/control/cycle-staleness.ts';
import { adminDispatch } from '../../src/web/admin.ts';
import {
  connect,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from '../worker/fixture.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const noOwners = { owners: () => Promise.resolve({ ok: true as const, owners: [] }) };

let fixture: ControlFixture;
let controlSql: SQL;

beforeAll(async () => {
  fixture = await createControlPlane('cyclehealth');
  controlSql = connect(fixture);
  // `fleet_status` reads connectors in the same answer; without their tables the
  // assertions below would be about a 500 rather than about a verdict.
  await ensureConnectorHealthSchema(controlSql);
  await ensureConnectorLinkSchema(controlSql);
}, 60_000);

afterAll(async () => {
  await controlSql?.close();
  if (fixture) await dropControlPlane(fixture);
});

beforeEach(async () => {
  await controlSql`DELETE FROM control.tenant`;
});

/** The `cycles` block of a `fleet_status` answer. */
async function cycles(now: Date): Promise<Record<string, unknown>> {
  const result = await adminDispatch(
    { controlSql, owners: noOwners },
    { name: 'fleet_status', now },
  );
  if (!result.ok) throw new Error('fleet_status was refused');
  return result.content['cycles'] as Record<string, unknown>;
}

describe('the frozen brain, as the control plane sees it', () => {
  test('its own row reads unobserved, and the fleet verdict stays ok', async () => {
    const now = new Date('2026-08-20T01:24:13.000Z');
    // The frozen brain's real numbers from during the freeze: ready, and a
    // return clock five and a half hours old. Every clock in this row is clean.
    await seedTenant(controlSql, 'frozen', {
      lastCycleAt: new Date(now.getTime() - (5 * HOUR + 29 * 60_000)),
      nextDueAt: new Date(now.getTime() + 18 * HOUR),
    });

    const block = await cycles(now);
    expect(block['unobserved']).toBe(1);
    expect(block['unattended']).toBe(0);
    // Not a green light. The field beside it is what says how much the verdict
    // is worth.
    expect(block['verdict']).toBe('ok');
    expect(block['completion_observable']).toBe(false);
  });

  test('the block never prints a zero for a state it cannot observe', async () => {
    // `stale: 0` here would be an assertion that nothing in the fleet is frozen
    // — which is the sentence nobody on this surface is entitled to make, and
    // the exact shape of the silence this rule exists to end. Absent, not zero.
    const now = new Date('2026-08-20T01:24:13.000Z');
    await seedTenant(controlSql, 'frozen', { lastCycleAt: new Date(now.getTime() - 5 * HOUR) });

    const block = await cycles(now);
    for (const unobservable of ['stale', 'slipping', 'current', 'never_completed', 'starting']) {
      expect(Object.keys(block)).not.toContain(unobservable);
    }
  });

  test('a healthy brain and a frozen brain are indistinguishable here, and that is the finding', async () => {
    // Stated as a test so that nobody later reads the `ok` above as evidence the
    // fleet is fine. These two tenants differ only in a column this plane does
    // not hold.
    const now = new Date('2026-08-20T01:24:13.000Z');
    await seedTenant(controlSql, 'frozen', { lastCycleAt: new Date(now.getTime() - 5 * HOUR) });
    await seedTenant(controlSql, 'healthy', { lastCycleAt: new Date(now.getTime() - 8 * HOUR) });

    const block = await cycles(now);
    expect(block['unobserved']).toBe(2);
    expect(block['total']).toBe(2);
  });
});

describe('what the return clock does answer, and nothing was reading it', () => {
  test('a ready brain nothing has ever scheduled pages the fleet', async () => {
    const now = new Date('2026-08-20T01:24:13.000Z');
    // `seedTenant` stamps `ready_at` at the epoch, so this brain is long past
    // its first-cycle grace: nothing has ever come back for it.
    await seedTenant(controlSql, 'orphan', { lastCycleAt: null });

    const block = await cycles(now);
    expect(block['unattended']).toBe(1);
    expect(block['verdict']).toBe('stalled');
  });

  test('a brain nothing has returned for in days pages the fleet', async () => {
    const now = new Date('2026-08-20T01:24:13.000Z');
    await seedTenant(controlSql, 'stopped', {
      lastCycleAt: new Date(now.getTime() - 9 * DAY),
    });

    const block = await cycles(now);
    expect(block['unattended']).toBe(1);
    expect(block['verdict']).toBe('stalled');
  });

  test('one stalled brain decides the verdict for the whole fleet', async () => {
    const now = new Date('2026-08-20T01:24:13.000Z');
    await seedTenant(controlSql, 'ok-one', { lastCycleAt: new Date(now.getTime() - HOUR) });
    await seedTenant(controlSql, 'ok-two', { lastCycleAt: new Date(now.getTime() - 3 * HOUR) });
    await seedTenant(controlSql, 'stopped', { lastCycleAt: new Date(now.getTime() - 9 * DAY) });

    expect((await cycles(now))['verdict']).toBe('stalled');
  });

  test('a paused fleet inside the ceiling does not page', async () => {
    // The half of the error budget that keeps the alert read. A rule that paged
    // on a long deploy freeze is a rule somebody mutes, and a muted rule is how
    // days of silence happen twice.
    const now = new Date('2026-08-20T01:24:13.000Z');
    const inside = unattendedAfterSeconds() * 1000 - HOUR;
    await seedTenant(controlSql, 'paused', { lastCycleAt: new Date(now.getTime() - inside) });

    const block = await cycles(now);
    expect(block['unattended']).toBe(0);
    expect(block['verdict']).toBe('ok');
  });
});

describe('the states that are not faults', () => {
  test('a half-provisioned brain is not consolidating and is not an alarm', async () => {
    const now = new Date('2026-08-20T01:24:13.000Z');
    await seedTenant(controlSql, 'half', { state: 'provisioning', lastCycleAt: null });
    await seedTenant(controlSql, 'gone', { state: 'deleting', lastCycleAt: null });

    const block = await cycles(now);
    // `deleting` keeps its provisioning artifacts, so the state is read first
    // and alone — clocks that will never move again must not hold the fleet red.
    expect(block['not_ready']).toBe(2);
    expect(block['unattended']).toBe(0);
    expect(block['verdict']).toBe('ok');
  });

  test('an empty fleet is ok, and the counts are what tell it from a broken one', async () => {
    const block = await cycles(new Date('2026-08-20T01:24:13.000Z'));
    expect(block['verdict']).toBe('ok');
    expect(block['total']).toBe(0);
  });
});

describe('the answer an operator pastes into a channel', () => {
  test('the fleet block names no tenant', async () => {
    const now = new Date('2026-08-20T01:24:13.000Z');
    await seedTenant(controlSql, 'stopped', { lastCycleAt: new Date(now.getTime() - 9 * DAY) });

    const result = await adminDispatch(
      { controlSql, owners: noOwners },
      { name: 'fleet_status', now },
    );
    if (!result.ok) throw new Error('fleet_status was refused');
    // Which brain is one call away, on `tenant_status`, under the same
    // credential. This response is the artifact most likely to be pasted
    // somewhere it outlives the incident.
    expect(JSON.stringify(result.content)).not.toContain('stopped');
  });

  test('tenant_status carries the same reading and the same refusal', async () => {
    const now = new Date('2026-08-20T01:24:13.000Z');
    await seedTenant(controlSql, 'frozen', { lastCycleAt: new Date(now.getTime() - 5 * HOUR) });

    const result = await adminDispatch(
      { controlSql, owners: noOwners },
      { name: 'tenant_status', args: { tenant_id: 'frozen' }, now },
    );
    if (!result.ok) throw new Error('tenant_status was refused');
    const block = result.content['cycles'] as Record<string, unknown>;
    expect(block['state']).toBe('unobserved');
    // Said where somebody debugging one brain will read it, beside the two
    // instants that look fine and are not evidence of anything.
    expect(block['completion_observable']).toBe(false);
    expect(block['unattended_after_seconds']).toBe(unattendedAfterSeconds());
  });
});
