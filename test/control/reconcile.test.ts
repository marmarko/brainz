/**
 * The tenant reconciler: what the fleet is paying for that nothing will finish,
 * and the four guards standing between a report and an incident.
 *
 * ============================================================================
 * THE INCIDENT THIS FILE IS WRITTEN AGAINST
 * ============================================================================
 *
 * A cleanup once deleted every vendor project whose name matched a tenant-id
 * prefix. One of them was a real user's brain. It had never been used — no
 * activity, no content — so **every heuristic a `safe_to_delete` grade could be
 * built from would have said disposable**. The single fact that separated it
 * from the three throwaways beside it is that somebody owned it, and ownership
 * lives in the identity database, never in a resource name.
 *
 * So the assertions here are not "the classifier is correct". They are:
 *
 *   * a row that reached ready is never a candidate, whatever else is true;
 *   * a tenant somebody owns is never handed to the teardown port — and the
 *     test asserts that against the **port**, not against the proposal, because
 *     a reconciler that proposed `none` and then acted anyway would pass every
 *     assertion about its own report;
 *   * "I could not see the owners" refuses the whole operation rather than
 *     reporting everything as unowned, which is the incident again with the
 *     operator's own tooling telling them it was safe;
 *   * acting needs an explicit id list, so no pattern, prefix or age filter can
 *     ever reach a deletion.
 *
 * ============================================================================
 * WHY THE ACT PATH EXISTS HERE AND NOWHERE ELSE
 * ============================================================================
 *
 * `/admin` composes `createReconcilePorts`, which carries **no teardown port**,
 * so the surface an operator can reach is type-incapable of destroying
 * anything. The act path in the policy module is what makes the guards
 * assertable at all: a refusal can only be tested against something that would
 * otherwise have happened. Every case below that acts does so through a fake
 * teardown that records its calls, and the recording is the assertion.
 *
 * Every tenant id here is synthetic. This is a public repository and a real
 * fleet's ids are not test data.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import type { SQL } from 'bun';

import { ensureSecretStoreSchema } from '../../src/control/secret-pg.ts';
import { createReconcilePorts, ownerCensusFrom } from '../../src/control/reconcile-ports.ts';
import {
  classifyResidue,
  reconcileTenants,
  type OwnerCensus,
  type ReconcilePorts,
  type TenantResidue,
  type TeardownReceipt,
} from '../../src/control/reconcile.ts';
import {
  connect as connectControl,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from '../worker/fixture.ts';

const SETUP_TIMEOUT_MS = 120_000;
const READY_AT = new Date('2026-08-01T00:00:00.000Z').getTime();

// ---------------------------------------------------------------------------
// Fakes. Narrow on purpose: the policy module takes ports and nothing else, so
// none of this needs a database.
// ---------------------------------------------------------------------------

function row(overrides: Partial<TenantResidue> & { readonly tenantId: string }): TenantResidue {
  return {
    state: 'failed',
    readyAt: null,
    neonProjectId: null,
    connectionSecretRef: null,
    ...overrides,
  };
}

interface Recorder {
  readonly ports: ReconcilePorts;
  readonly tornDown: string[];
}

function portsFor(options: {
  readonly tenants?: readonly TenantResidue[];
  readonly namespaces?: readonly string[];
  readonly census?: OwnerCensus;
  readonly withTeardown?: boolean;
}): Recorder {
  const tornDown: string[] = [];
  const census = options.census ?? { ok: true as const, ownedTenantIds: new Set<string>() };
  const ports: ReconcilePorts = {
    tenants: () => Promise.resolve(options.tenants ?? []),
    secretNamespaces: () => Promise.resolve(options.namespaces ?? []),
    owners: () => Promise.resolve(census),
    ...(options.withTeardown === true
      ? {
          teardown: (tenantId: string): Promise<TeardownReceipt> => {
            tornDown.push(tenantId);
            return Promise.resolve({ tenantId, complete: true });
          },
        }
      : {}),
  };
  return { ports, tornDown };
}

function owns(...tenantIds: readonly string[]): OwnerCensus {
  return { ok: true, ownedTenantIds: new Set(tenantIds) };
}

// ---------------------------------------------------------------------------
// The prefix table.
// ---------------------------------------------------------------------------

describe('a row is classified by the provisioning step it died after', () => {
  test('and the recognition is exact rather than a heuristic', () => {
    // The synchronous lane's observable prefixes, in creation order. Each is a
    // *column* fact — the id was banked before the next call was made, which is
    // the rule that makes a retry able to name what it must delete.
    expect(classifyResidue(row({ tenantId: 'syn-a' }))).toBe('failed_before_project');
    expect(classifyResidue(row({ tenantId: 'syn-b', neonProjectId: 'p' }))).toBe('failed_with_project');
    expect(
      classifyResidue(row({ tenantId: 'syn-c', neonProjectId: 'p', connectionSecretRef: 's' })),
    ).toBe('failed_with_credential');
    expect(classifyResidue(row({ tenantId: 'syn-d', state: 'provisioning' }))).toBe('provisioning_in_flight');
    expect(classifyResidue(row({ tenantId: 'syn-e', state: 'deleting', readyAt: null }))).toBe(
      'teardown_interrupted',
    );
  });

  test('and reaching ready is checked before anything else, both ways', () => {
    expect(classifyResidue(row({ tenantId: 'syn-f', state: 'ready', readyAt: READY_AT }))).toBe('live');
    // `readyAt` as well as `state`, which is `provision.ts`'s own guard and not a
    // second opinion about it. The row that made the destructive path reachable
    // in the first place was one whose state a straggling run had overwritten
    // while its `ready_at` stayed.
    expect(classifyResidue(row({ tenantId: 'syn-g', state: 'failed', readyAt: READY_AT }))).toBe('live');
  });
});

// ---------------------------------------------------------------------------
// Guard 2: a ready tenant is never a candidate.
// ---------------------------------------------------------------------------

describe('a tenant that reached ready is never a candidate', () => {
  test('it is reported, refused by name, and proposes nothing', async () => {
    const { ports } = portsFor({
      tenants: [
        row({ tenantId: 'syn-live', state: 'ready', readyAt: READY_AT, neonProjectId: 'p', connectionSecretRef: 's' }),
        row({ tenantId: 'syn-dead', neonProjectId: 'p' }),
      ],
    });

    const outcome = await reconcileTenants(ports);
    if (!outcome.ok) throw new Error(`reconcile refused: ${outcome.reason}`);

    // Reported rather than filtered out. An operator reading a residue list
    // needs to see that the live row was considered and excluded — a row that
    // simply is not there reads as a row nobody looked at.
    expect(outcome.findings.map((finding) => `${finding.tenantId}:${finding.proposal}`)).toEqual([
      'syn-dead:teardown',
      'syn-live:none',
    ]);
    expect(outcome.findings[1]?.refusedBecause).toBe('reached_ready');
  });

  test('and naming it explicitly does not get it destroyed', async () => {
    const { ports, tornDown } = portsFor({
      tenants: [
        row({ tenantId: 'syn-live', state: 'ready', readyAt: READY_AT, neonProjectId: 'p' }),
        // A row whose `state` a straggling run overwrote while `ready_at` stayed.
        // `schema.sql` refuses to store this shape now; the guard is what found
        // it, and an operator typing the id is exactly the path that used to
        // destroy a live user's database.
        row({ tenantId: 'syn-overwritten', state: 'failed', readyAt: READY_AT, neonProjectId: 'p' }),
      ],
      withTeardown: true,
    });

    const outcome = await reconcileTenants(ports, {
      act: true,
      ids: ['syn-live', 'syn-overwritten'],
    });
    if (!outcome.ok) throw new Error(`reconcile refused: ${outcome.reason}`);

    // Asserted against the port, not against the report. A reconciler that
    // proposed `none` and then acted anyway passes every assertion about its own
    // output.
    expect(tornDown).toEqual([]);
    expect(outcome.acted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Guard 1: ownership.
// ---------------------------------------------------------------------------

describe('a tenant with an owner is never silently destroyed', () => {
  test('an owned failed row is refused, and the teardown port is never called', async () => {
    const { ports, tornDown } = portsFor({
      tenants: [
        row({ tenantId: 'syn-owned', neonProjectId: 'p', connectionSecretRef: 's' }),
        row({ tenantId: 'syn-unowned', neonProjectId: 'p', connectionSecretRef: 's' }),
      ],
      census: owns('syn-owned'),
      withTeardown: true,
    });

    const outcome = await reconcileTenants(ports, {
      act: true,
      ids: ['syn-owned', 'syn-unowned'],
    });
    if (!outcome.ok) throw new Error(`reconcile refused: ${outcome.reason}`);

    expect(tornDown).toEqual(['syn-unowned']);
    const owned = outcome.findings.find((finding) => finding.tenantId === 'syn-owned');
    expect(owned?.proposal).toBe('none');
    expect(owned?.refusedBecause).toBe('owned');
    // The report says the link exists without saying whose it is. `owned` is a
    // boolean here and a domain-and-digest one surface up, because a reconciler
    // report is the artifact most likely to be pasted into a ticket.
    expect(owned?.holds).toContain('brain_link');
    expect(JSON.stringify(outcome)).not.toContain('@');
  });

  test('an unreachable owner lookup refuses the whole operation', async () => {
    const { ports, tornDown } = portsFor({
      tenants: [row({ tenantId: 'syn-dead', neonProjectId: 'p' })],
      census: { ok: false },
      withTeardown: true,
    });

    // Reporting every tenant as unowned because the lookup was down is the
    // incident again, with the operator's own tooling telling them it was safe.
    const reported = await reconcileTenants(ports);
    expect(reported).toEqual({ ok: false, reason: 'owner_lookup_unavailable' });

    const acted = await reconcileTenants(ports, { act: true, ids: ['syn-dead'] });
    expect(acted).toEqual({ ok: false, reason: 'owner_lookup_unavailable' });
    expect(tornDown).toEqual([]);
  });

  test('but an interrupted teardown is resumed even for a tenant somebody owns', async () => {
    // The deliberate exception, and it is not a hole in guard 1. A `failed` row
    // with an owner is somebody's half-made brain and the sweep has no business
    // touching it. A `deleting` row with an owner is an account closure that
    // already started and stopped — the decision is recorded in the state, the
    // legs are idempotent, and refusing on ownership would strand exactly the
    // rows U17's teardown was built to be resumable for, forever.
    const { ports, tornDown } = portsFor({
      tenants: [row({ tenantId: 'syn-closing', state: 'deleting', neonProjectId: 'p' })],
      census: owns('syn-closing'),
      withTeardown: true,
    });

    const outcome = await reconcileTenants(ports, { act: true, ids: ['syn-closing'] });
    if (!outcome.ok) throw new Error(`reconcile refused: ${outcome.reason}`);

    expect(outcome.findings[0]?.proposal).toBe('resume_teardown');
    expect(tornDown).toEqual(['syn-closing']);
  });
});

// ---------------------------------------------------------------------------
// Guard 3: only an explicit id list may destroy.
// ---------------------------------------------------------------------------

describe('acting needs an explicit id list and a port that exists', () => {
  test('a sweep with no ids is refused before either read runs', async () => {
    let read = 0;
    const { tornDown } = portsFor({});
    const outcome = await reconcileTenants(
      {
        tenants: () => {
          read += 1;
          return Promise.resolve([]);
        },
        secretNamespaces: () => Promise.resolve([]),
        owners: () => Promise.resolve(owns()),
        teardown: (tenantId) => Promise.resolve({ tenantId, complete: true }),
      },
      { act: true },
    );

    expect(outcome).toEqual({ ok: false, reason: 'act_needs_an_explicit_id_list' });
    // The refusal costs nothing when it happens first, and a sweep that had
    // already enumerated the fleet is one keystroke from acting on it.
    expect(read).toBe(0);
    expect(tornDown).toEqual([]);
  });

  test('a composition with no teardown port cannot be talked into one', async () => {
    // `/admin` is this composition. It does not decline to act; it holds no
    // capability to act, which is the difference between a policy and a
    // property.
    const { ports } = portsFor({ tenants: [row({ tenantId: 'syn-dead' })] });
    const outcome = await reconcileTenants(ports, { act: true, ids: ['syn-dead'] });
    expect(outcome).toEqual({ ok: false, reason: 'teardown_unavailable' });
  });

  test('an id not on the list is untouched even when it is the more obvious candidate', async () => {
    const { ports, tornDown } = portsFor({
      tenants: [
        row({ tenantId: 'syn-named', neonProjectId: 'p' }),
        row({ tenantId: 'syn-unnamed', neonProjectId: 'p', connectionSecretRef: 's' }),
      ],
      withTeardown: true,
    });

    const outcome = await reconcileTenants(ports, { act: true, ids: ['syn-named'] });
    if (!outcome.ok) throw new Error(`reconcile refused: ${outcome.reason}`);

    expect(tornDown).toEqual(['syn-named']);
    expect(outcome.findings.map((finding) => finding.tenantId)).toEqual(['syn-named']);
  });
});

// ---------------------------------------------------------------------------
// The residue that outlives its row.
// ---------------------------------------------------------------------------

describe('residue with no control-plane row is reported and never proposed', () => {
  test('a secret namespace and a brain link with nothing behind them', async () => {
    const { ports, tornDown } = portsFor({
      tenants: [row({ tenantId: 'syn-known', neonProjectId: 'p' })],
      namespaces: ['syn-known', 'syn-stray-secret'],
      census: owns('syn-orphan-link'),
      withTeardown: true,
    });

    const outcome = await reconcileTenants(ports, {
      act: true,
      ids: ['syn-stray-secret', 'syn-orphan-link'],
    });
    if (!outcome.ok) throw new Error(`reconcile refused: ${outcome.reason}`);

    expect(
      outcome.findings.map((finding) => `${finding.tenantId}:${finding.residue}:${finding.refusedBecause}`),
    ).toEqual([
      'syn-orphan-link:orphan_brain_link:no_control_row',
      'syn-stray-secret:orphan_secret:no_control_row',
    ]);
    // The control-plane row is the only record of what the other stores held, so
    // residue with no row behind it has a blast radius nothing can compute. A
    // human reads it; the sweep does not guess.
    expect(tornDown).toEqual([]);
  });

  test('and a namespace that does have a row is not reported twice', async () => {
    const { ports } = portsFor({
      tenants: [row({ tenantId: 'syn-known', neonProjectId: 'p', connectionSecretRef: 's' })],
      namespaces: ['syn-known'],
    });

    const outcome = await reconcileTenants(ports);
    if (!outcome.ok) throw new Error(`reconcile refused: ${outcome.reason}`);
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]?.residue).toBe('failed_with_credential');
  });
});

// ---------------------------------------------------------------------------
// The world.
// ---------------------------------------------------------------------------

describe('the ports read a real control plane and publish nothing they read', () => {
  let fixture: ControlFixture;
  let controlSql: SQL;

  beforeAll(async () => {
    fixture = await createControlPlane('reconcile');
    controlSql = connectControl(fixture, 2);
    // The secret store is not in `schema.sql` — it is one of the tables the
    // fleet ensures at boot — and the orphan-namespace arm reads it.
    await ensureSecretStoreSchema(controlSql);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await controlSql?.close();
    if (fixture !== undefined) await dropControlPlane(fixture);
  });

  beforeEach(async () => {
    await controlSql`DELETE FROM control.tenant_secret`;
    await controlSql`DELETE FROM control.tenant`;
  });

  test('the prefixes a real row carries survive the projection', async () => {
    await seedTenant(controlSql, 'syn-ready');
    await seedTenant(controlSql, 'syn-half', { state: 'provisioning' });
    await controlSql`
      UPDATE control.tenant SET state = 'failed'::control.tenant_state,
                                failure_code = 'schema_apply_failed'::control.provisioning_failure,
                                neon_project_id = 'proj-syn-half'
       WHERE tenant_id = 'syn-half'`;

    const ports = createReconcilePorts({
      controlSql,
      owners: { owners: () => Promise.resolve({ ok: true as const, owners: [] }) },
    });
    const outcome = await reconcileTenants(ports);
    if (!outcome.ok) throw new Error(`reconcile refused: ${outcome.reason}`);

    expect(outcome.findings.map((finding) => `${finding.tenantId}:${finding.residue}`)).toEqual([
      'syn-half:failed_with_project',
      'syn-ready:live',
    ]);
    // The projection publishes presence, never the value: a project id is the
    // string somebody pastes into a vendor console, and a secret reference is
    // the namespace they would go and ask for.
    expect(JSON.stringify(outcome)).not.toContain('proj-syn-half');
    expect(JSON.stringify(outcome)).not.toContain('tenant/syn-ready');
  });

  test('a secret namespace with no tenant row behind it is found', async () => {
    // A well-formed sealed envelope, because the column's domain refuses
    // anything else — that alphabet is what makes a connection string unstorable
    // here, and a fixture that bypassed it would be testing a column production
    // does not have.
    await controlSql`
      INSERT INTO control.tenant_secret (namespace, sealed)
      VALUES ('tenant/syn-stray', 'v1.0123456789abcdef.AAAAAAAAAAAAAAAAAAAAAAAA')`;

    const ports = createReconcilePorts({
      controlSql,
      owners: { owners: () => Promise.resolve({ ok: true as const, owners: [] }) },
    });
    const outcome = await reconcileTenants(ports);
    if (!outcome.ok) throw new Error(`reconcile refused: ${outcome.reason}`);

    expect(outcome.findings.map((finding) => finding.residue)).toEqual(['orphan_secret']);
    expect(outcome.findings[0]?.tenantId).toBe('syn-stray');
  });

  test('and the owner refusal travels through the adapter unchanged', async () => {
    const census = await ownerCensusFrom({ owners: () => Promise.resolve({ ok: false as const }) })();
    expect(census).toEqual({ ok: false });
  });
});
