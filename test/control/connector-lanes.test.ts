/**
 * A connector lane that died has to have a way back, and it did not have one.
 *
 * **The state this file reproduces.** `enqueueDuePulls` counts a lane as
 * standing when it is `due`, `running` **or `dead`**, and refuses to enqueue a
 * second one — correctly, because a dead-lettered row is a lane an operator has
 * not cleared and re-enqueueing over it would issue an INSERT every minute
 * forever. `handleDisconnect` is the only thing in `src/` that clears a standing
 * lane, and it cleared `('due', 'running')`. So a lane that dead-lettered
 * survived the disconnect, survived the reconnect after it, and stood in the
 * anti-join for the rest of the tenant's life: **the source is never polled
 * again, by anything, ever.**
 *
 * That is not a hypothetical. A fleet-wide bug in the vendor request shape
 * walked all three of one brain's connectors up the ladder to `dead` in ten
 * minutes; the fix for the bug then deployed and changed nothing, because
 * nothing would ever ask again. The dashboard said the connector was failing and
 * the copy said to reconnect, which was the one thing that could not help.
 *
 * So the statement is one statement, in one place, called by both surfaces that
 * need it — the user's disconnect and the operator's requeue — and it clears
 * `dead` along with the rest. The two callers differ in what they do next, not
 * in what "stop this lane" means.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { discardConnectorLanes } from '../../src/control/connector-lanes.ts';
import { adminDispatch } from '../../src/web/admin.ts';
import { connect, createControlPlane, dropControlPlane, seedTenant, type ControlFixture } from '../worker/fixture.ts';

const TENANT = 't-lanes-fixture';
const OTHER = 't-lanes-other';
const NOW = new Date('2026-05-01T00:00:00.000Z');

let fixture: ControlFixture;
let controlSql: SQL;

beforeAll(async () => {
  fixture = await createControlPlane('connector_lanes');
  controlSql = connect(fixture, 4);
});

afterAll(async () => {
  await controlSql.close();
  await dropControlPlane(fixture);
});

beforeEach(async () => {
  await controlSql`DELETE FROM control.job`;
  await controlSql`DELETE FROM control.tenant`;
  await seedTenant(controlSql, TENANT);
  await seedTenant(controlSql, OTHER);
});

/**
 * One `control.job` row, in whatever state the case needs.
 *
 * The lease columns travel with `running` because the table's own
 * `running_jobs_hold_a_lease` CHECK refuses a leaseless one — which is the
 * property the last case in this block asserts survives the discard.
 */
async function lane(options: {
  readonly tenantId?: string;
  readonly kind?: 'ingest_pull' | 'consolidate';
  readonly target: string;
  readonly state: 'due' | 'running' | 'dead' | 'done' | 'discarded';
  readonly attempts?: number;
}): Promise<string> {
  const running = options.state === 'running';
  const rows = (await controlSql`
    INSERT INTO control.job (
      job_id, tenant_id, kind, target, state, trigger_reason, attempts,
      run_at, created_at, updated_at, finished_at,
      lease_token, lease_owner, lease_expires_at, attempt_deadline_at,
      dead_lettered_at, failure_code
    ) VALUES (
      gen_random_uuid(), ${options.tenantId ?? TENANT},
      ${options.kind ?? 'ingest_pull'}::control.job_kind,
      ${options.target}::control.job_target, ${options.state}::control.job_state,
      'connector_cadence', ${options.attempts ?? 0},
      ${NOW}, ${NOW}, ${NOW},
      ${options.state === 'done' || options.state === 'discarded' ? NOW : null},
      ${running ? 1 : 0},
      ${running ? 'a-worker' : null},
      ${running ? new Date(NOW.getTime() + 60_000) : null},
      ${running ? new Date(NOW.getTime() + 60_000) : null},
      ${options.state === 'dead' ? NOW : null},
      ${options.state === 'dead' ? 'handler_error' : null}::control.job_failure
    ) RETURNING job_id::text AS job_id`) as Array<{ job_id: string }>;
  return rows[0]!.job_id;
}

async function states(): Promise<Array<{ tenant: string; target: string; state: string }>> {
  return (await controlSql`
    SELECT tenant_id AS tenant, target::text AS target, state::text AS state
      FROM control.job ORDER BY tenant_id, target`) as Array<{
    tenant: string;
    target: string;
    state: string;
  }>;
}

describe('clearing a standing connector lane', () => {
  /**
   * **The case the whole file is about.** `dead` is in the set, and it is the
   * only member whose absence is unrecoverable: a `due` row drains on its own,
   * a `running` row settles, and a `dead` row is forever.
   */
  test('a dead-lettered lane is discarded, not left standing', async () => {
    await lane({ target: 'gmail', state: 'dead', attempts: 5 });

    const discarded = await discardConnectorLanes(controlSql, {
      tenantId: TENANT,
      source: 'gmail',
      now: NOW,
    });

    expect(discarded).toHaveLength(1);
    expect(await states()).toEqual([{ tenant: TENANT, target: 'gmail', state: 'discarded' }]);
  });

  test('a queued or leased lane is discarded too — this replaces no behaviour', async () => {
    await lane({ target: 'gmail', state: 'due' });
    const discarded = await discardConnectorLanes(controlSql, {
      tenantId: TENANT,
      source: 'gmail',
      now: NOW,
    });
    expect(discarded).toHaveLength(1);

    await lane({ target: 'calendar', state: 'running' });
    const second = await discardConnectorLanes(controlSql, {
      tenantId: TENANT,
      source: 'calendar',
      now: NOW,
    });
    expect(second).toHaveLength(1);
  });

  /**
   * A settled row is history, and rewriting it would make the operator's requeue
   * look like a disconnect in every later reading of the queue.
   */
  test('a completed or already-discarded lane is left exactly as it is', async () => {
    await lane({ target: 'gmail', state: 'done' });
    await lane({ target: 'calendar', state: 'discarded' });

    expect(
      await discardConnectorLanes(controlSql, { tenantId: TENANT, source: 'gmail', now: NOW }),
    ).toEqual([]);
    expect(await states()).toEqual([
      { tenant: TENANT, target: 'calendar', state: 'discarded' },
      { tenant: TENANT, target: 'gmail', state: 'done' },
    ]);
  });

  /**
   * The unit is one source of one tenant. An operator clearing a stuck mailbox
   * must not silently stop the calendar beside it, and must not touch a
   * stranger's brain — the argument is a tenant id, and a statement that keyed on
   * the source alone would be a fleet-wide action wearing a tenant-shaped call.
   */
  test('nothing outside the named tenant and source is touched', async () => {
    await lane({ target: 'gmail', state: 'dead', attempts: 5 });
    await lane({ target: 'calendar', state: 'dead', attempts: 5 });
    await lane({ tenantId: OTHER, target: 'gmail', state: 'dead', attempts: 5 });

    await discardConnectorLanes(controlSql, { tenantId: TENANT, source: 'gmail', now: NOW });

    expect(await states()).toEqual([
      { tenant: TENANT, target: 'calendar', state: 'dead' },
      { tenant: TENANT, target: 'gmail', state: 'discarded' },
      { tenant: OTHER, target: 'gmail', state: 'dead' },
    ]);
  });

  /**
   * `whole_brain` is a legal `control.job_target` and is not a connector. The
   * refusal is a thrown error rather than a cast failure from Postgres, and it
   * happens before any statement runs — so the argument never reaches SQL and the
   * caller gets something it can turn into a typed answer.
   */
  test('a target that is not a connector source is refused before any statement runs', async () => {
    await lane({ kind: 'consolidate', target: 'whole_brain', state: 'due' });

    await expect(
      discardConnectorLanes(controlSql, { tenantId: TENANT, source: 'whole_brain', now: NOW }),
    ).rejects.toThrow();
    expect(await states()).toEqual([{ tenant: TENANT, target: 'whole_brain', state: 'due' }]);
  });

  /** The lease columns go with the state, or a claimed row keeps a live-looking lease. */
  test('the discarded row carries no lease anybody could still be holding', async () => {
    const jobId = await lane({ target: 'gmail', state: 'running' });

    await discardConnectorLanes(controlSql, { tenantId: TENANT, source: 'gmail', now: NOW });

    const [row] = (await controlSql`
      SELECT lease_owner, lease_expires_at, attempt_deadline_at, finished_at
        FROM control.job WHERE job_id = ${jobId}::uuid`) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({
      lease_owner: null,
      lease_expires_at: null,
      attempt_deadline_at: null,
      finished_at: NOW,
    });
  });
});

// ---------------------------------------------------------------------------
// The operator's half.
// ---------------------------------------------------------------------------

/**
 * **Why an operator surface at all, when disconnect already clears the lane.**
 *
 * Disconnect is the user's answer and it costs a re-authorization at the
 * provider. When the lane died of *our* bug — a fleet-wide request shape the
 * vendor refused — asking every affected user to re-consent at Google to recover
 * from a defect we shipped and fixed is not a remedy, it is a second injury. So
 * the operator can clear the lane without touching the grant, and the cadence
 * picks the source back up on its next tick.
 */
describe('the operator requeue', () => {
  /**
   * The directory port is never reached by this operation and is handed a
   * throwing stub rather than a working one, so a requeue that quietly grew a
   * read of who owns the brain fails this file rather than passing it.
   */
  function dispatch(name: string, args: Record<string, unknown>, write = true) {
    return adminDispatch(
      {
        controlSql,
        owners: {
          owners: () => Promise.reject(new Error('requeue must not read the owner directory')),
        },
      },
      { name, args, write, now: NOW },
    );
  }

  test('clears a dead lane so the cadence can enqueue again', async () => {
    await lane({ target: 'gmail', state: 'dead', attempts: 5 });

    const result = await dispatch('requeue_connector', { tenant_id: TENANT, source: 'gmail' });

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.content).toMatchObject({
      tenant_id: TENANT,
      source: 'gmail',
      lanes_cleared: 1,
    });
    expect(await states()).toEqual([{ tenant: TENANT, target: 'gmail', state: 'discarded' }]);
  });

  /**
   * The same rule `grant_internal_tier` is under, for the same reason: an
   * operator action reachable by GET is an action a bookmark, a shell-history
   * recall or a link in a ticket can fire, with the tenant id in the URL.
   */
  test('a GET cannot requeue anything', async () => {
    await lane({ target: 'gmail', state: 'dead', attempts: 5 });

    const result = await dispatch('requeue_connector', { tenant_id: TENANT, source: 'gmail' }, false);

    expect(result).toMatchObject({ ok: false, code: 'invalid_params' });
    expect(await states()).toEqual([{ tenant: TENANT, target: 'gmail', state: 'dead' }]);
  });

  test('refuses without a tenant, and without a source', async () => {
    expect(await dispatch('requeue_connector', { source: 'gmail' })).toMatchObject({
      ok: false,
      code: 'invalid_params',
    });
    expect(await dispatch('requeue_connector', { tenant_id: TENANT })).toMatchObject({
      ok: false,
      code: 'invalid_params',
    });
  });

  /**
   * The refusal names the vocabulary rather than echoing the word back. This
   * surface's whole property is that no argument it takes is a word a user
   * wrote; a message that quoted the caller's string would carry one into an
   * operator's scrollback.
   */
  test('a source outside the connector vocabulary is refused, and nothing is discarded', async () => {
    await lane({ kind: 'consolidate', target: 'whole_brain', state: 'due' });

    const result = await dispatch('requeue_connector', {
      tenant_id: TENANT,
      source: 'whole_brain',
    });

    expect(result).toMatchObject({ ok: false, code: 'invalid_params' });
    expect(result.ok === false && result.message).not.toContain('whole_brain');
    expect(await states()).toEqual([{ tenant: TENANT, target: 'whole_brain', state: 'due' }]);
  });

  /** Nothing to clear is an ordinary answer, not a refusal an operator has to interpret. */
  test('a source with no standing lane answers zero rather than failing', async () => {
    const result = await dispatch('requeue_connector', { tenant_id: TENANT, source: 'drive' });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.content).toMatchObject({ lanes_cleared: 0 });
  });
});
