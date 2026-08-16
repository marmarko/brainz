/**
 * `control.tenant.spend_cap_micro_usd` — one column, two readers, and whether
 * they mean the same thing by it.
 *
 * The column sits under a comment that calls it U20's **rolling** counter's cap,
 * and `src/ai/gateway.ts` accumulates into `spend_micro_usd` over a window that
 * rolls once per billing month. The ingest gate
 * (`src/ingest/first-import.ts:readHeadroom`) reads it that way: cap minus what
 * the window has already spent, floored at zero.
 *
 * **The consolidation cycle read it as a fresh per-cycle ceiling.** Same row,
 * same column, no subtraction — so a tenant sitting exactly on its cap was
 * refused every import and handed a whole cap's worth of model budget by every
 * cycle, for as long as the cycles keep coming. A ceiling that resets on a timer
 * nobody chose is not a cap on anything, and it is the direction that costs
 * money rather than the direction that produces a support ticket.
 *
 * **So the probe is one row read by both.** `spend_micro_usd =
 * spend_cap_micro_usd = 1_000_000`, inside a live window. Asserting on the
 * consolidation reader alone would leave "what does this column mean" answerable
 * two ways; asserting both against the same row is what makes the answer one
 * thing. The tests below are deliberately paired that way, and the second half —
 * a window that has lapsed restores the whole cap — is what stops the fix from
 * being "subtract something, refuse everybody": U20's meter only rolls
 * `spend_window_started_at` when it *writes*, so an idle tenant still carries
 * last month's total and charging them for it would be a wrong refusal wearing a
 * safety property's clothes.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { consolidationTierOf } from '../../src/control/tier.ts';
import { DEFAULT_SPEND_WINDOW_SECONDS } from '../../src/ai/gateway.ts';
import { readHeadroom } from '../../src/ingest/first-import.ts';
import {
  connect,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from '../worker/fixture.ts';

const TENANT = 'capped';
const NOW = new Date('2026-08-15T12:00:00.000Z');
const ONE_DOLLAR = 1_000_000;

let control: ControlFixture;
let controlSql: SQL;

beforeAll(async () => {
  control = await createControlPlane('spendcap');
  controlSql = connect(control);
}, 60_000);

afterAll(async () => {
  await controlSql?.close();
  if (control) await dropControlPlane(control);
});

/** One tenant row, with the spend columns placed exactly. */
async function seedSpend(options: {
  readonly spent: number;
  readonly cap: number | null;
  readonly windowStartedAt: Date;
  readonly tier?: 'free' | 'paid' | 'internal';
}): Promise<void> {
  await controlSql`DELETE FROM control.tenant`;
  await seedTenant(controlSql, TENANT);
  await controlSql`
    UPDATE control.tenant
       SET spend_micro_usd = ${options.spent},
           spend_cap_micro_usd = ${options.cap},
           spend_window_started_at = ${options.windowStartedAt},
           tier = ${options.tier ?? 'paid'}::control.tenant_tier
     WHERE tenant_id = ${TENANT}`;
}

describe('a tenant sitting on its cap, inside a live window', () => {
  test('THE CONSOLIDATION READER HANDS OUT NO FURTHER BUDGET', async () => {
    // The whole finding, in one row. Before the fix this answered `1_000_000` —
    // a second dollar, and another one every cycle after that.
    await seedSpend({ spent: ONE_DOLLAR, cap: ONE_DOLLAR, windowStartedAt: NOW });

    const lookup = await consolidationTierOf(controlSql, TENANT, { now: NOW });
    expect(lookup).toEqual({ ok: true, billing: { tier: 'paid', capMicroUsd: 0 } });
  });

  test('and the ingest reader agrees, against the same row', async () => {
    // Not a second assertion of the same fact: it is the reference reading. If
    // these two ever disagree again, the column means two things and one of the
    // two paths is spending money the other believes is gone.
    await seedSpend({ spent: ONE_DOLLAR, cap: ONE_DOLLAR, windowStartedAt: NOW });

    const read = await readHeadroom(controlSql, { tenantId: TENANT, now: NOW });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.headroom.headroomMicroUsd).toBe(0);
  });

  test('half spent is half left, not a whole cap', async () => {
    await seedSpend({ spent: 400_000, cap: ONE_DOLLAR, windowStartedAt: NOW });

    const lookup = await consolidationTierOf(controlSql, TENANT, { now: NOW });
    expect(lookup).toMatchObject({ ok: true, billing: { capMicroUsd: 600_000 } });
  });

  test('overspend floors at zero rather than going negative', async () => {
    // A cap lowered under a tenant who has already spent past it, which is what
    // an operator turning the dial down looks like. A negative cap would be read
    // by `budgetsFor` as "no cap at all" through `cap <= 0`, so the floor is not
    // cosmetic.
    await seedSpend({ spent: 3 * ONE_DOLLAR, cap: ONE_DOLLAR, windowStartedAt: NOW });

    const lookup = await consolidationTierOf(controlSql, TENANT, { now: NOW });
    expect(lookup).toMatchObject({ ok: true, billing: { capMicroUsd: 0 } });
  });
});

describe('a window that has lapsed', () => {
  test('restores the whole cap, because the meter only rolls when it writes', async () => {
    // The half that stops "make it rolling" from becoming "refuse everybody".
    // U20's counter rolls `spend_window_started_at` inside the UPDATE that
    // accumulates, so a tenant whose last model call was five weeks ago still
    // carries last month's total in the column. Charging them for it is a wrong
    // refusal, and it is the reading `readHeadroom` already takes.
    const lapsed = new Date(NOW.getTime() - (DEFAULT_SPEND_WINDOW_SECONDS + 60) * 1_000);
    await seedSpend({ spent: ONE_DOLLAR, cap: ONE_DOLLAR, windowStartedAt: lapsed });

    const lookup = await consolidationTierOf(controlSql, TENANT, { now: NOW });
    expect(lookup).toMatchObject({ ok: true, billing: { capMicroUsd: ONE_DOLLAR } });

    const read = await readHeadroom(controlSql, { tenantId: TENANT, now: NOW });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.headroom.headroomMicroUsd).toBe(ONE_DOLLAR);
  });
});

describe('a NULL cap', () => {
  test('stays NULL rather than acquiring a ceiling this reader invented', async () => {
    // Deliberately unchanged by the rolling fix, and stated so it is a decision
    // rather than an oversight. NULL here reaches `budgetsFor` as "no tenant
    // ceiling", where the cycle's own estimate bounds each phase — which is what
    // the `internal` tier (the canary, a founder's brain) runs on. Folding in
    // the ingest path's platform default would quietly throttle exactly the
    // brains the fleet is measured on, and that is a policy change, not this
    // defect.
    await seedSpend({ spent: 9 * ONE_DOLLAR, cap: null, windowStartedAt: NOW, tier: 'internal' });

    const lookup = await consolidationTierOf(controlSql, TENANT, { now: NOW });
    expect(lookup).toEqual({ ok: true, billing: { tier: 'paid', capMicroUsd: null } });
  });
});

describe('the refusals are unchanged', () => {
  test('an unknown tenant has no headroom to compute', async () => {
    await controlSql`DELETE FROM control.tenant`;
    expect(await consolidationTierOf(controlSql, 'nobody', { now: NOW })).toEqual({
      ok: false,
      reason: 'unknown_tenant',
    });
  });

  test('a tenant that is not ready is refused rather than given a budget', async () => {
    await controlSql`DELETE FROM control.tenant`;
    await seedTenant(controlSql, TENANT, { state: 'provisioning' });
    expect(await consolidationTierOf(controlSql, TENANT, { now: NOW })).toEqual({
      ok: false,
      reason: 'not_ready',
    });
  });
});
