/**
 * R11's CI case, and the containment that makes it worth asserting.
 *
 * **The trap.** "`/admin` gets `scope_denied` on `recall`" passes trivially on a
 * surface that has never heard of `recall` — the refusal would be a lookup miss
 * wearing a security code, and it would keep passing after somebody added a
 * `recall` handler under a different name. It also passes on a surface that
 * refuses everything, including the operations `/admin` exists to run.
 *
 * So this file asserts four separate things:
 *
 *  1. The refusal is provoked by an `/admin` credential **genuinely attempting a
 *     content read** — `recall`, by name, on a surface that lists it — and the
 *     code is `scope_denied` rather than `unknown_operation`.
 *  2. The same surface **can** run its own operations, so the refusal is a scope
 *     decision rather than a surface that does nothing.
 *  3. The admin identity cannot resolve any tenant's connection string, which is
 *     the layer R11 says the tool-surface refusal proves nothing without.
 *  4. The admin credential presented to the **real** `/mcp` dispatch is refused
 *     *and opens no tenant database* — the assertion that a refusal made after a
 *     connection was opened would not satisfy.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { SQL } from 'bun';

import { dispatch, type DispatchDeps } from '../../src/mcp/dispatch.ts';
import type { TenantConnections } from '../../src/mcp/tenant-db.ts';
import { createInMemoryAuthorizationStore } from '../../src/mcp/oauth.ts';
import { createInMemoryAccessLog } from '../../src/mcp/access-log.ts';
import { createControlSignals } from '../../src/mcp/control-signals.ts';
import {
  adminIdentity,
  createInMemorySecretBackend,
  createTenantSecretStore,
  fleetIdentity,
  webAppIdentity,
} from '../../src/control/secrets.ts';
import {
  ADMIN_OPERATIONS,
  WIRE_TOOL_NAMES,
  adminDispatch,
  adminToolVerdict,
} from '../../src/web/admin.ts';
import { TOOL_NAMES } from '../../src/mcp/tools/index.ts';
import { createGateway } from '../consolidate/fixture.ts';
import {
  connect,
  createControlPlane,
  dropControlPlane,
  seedTenant,
  type ControlFixture,
} from '../worker/fixture.ts';

const ADMIN_CREDENTIAL = 'bzadm_the_web_apps_operator_credential';
const TENANT = 'alice';

let fixture: ControlFixture;
let controlSql: SQL;

beforeAll(async () => {
  fixture = await createControlPlane('adminscope');
  controlSql = connect(fixture);
  await seedTenant(controlSql, TENANT);
}, 60_000);

afterAll(async () => {
  await controlSql?.close();
  if (fixture) await dropControlPlane(fixture);
});

// ---------------------------------------------------------------------------

describe('the /admin surface knows every tool name and denies the lot', () => {
  test('its tool list is the wire tool list, so a tenth tool cannot appear unnoticed', () => {
    // If `src/mcp/tools/index.ts` grows a name, this fails until somebody
    // decides what `/admin` does with it. A surface that silently answered
    // `unknown_operation` for a new tool would be exactly the lookup-miss
    // refusal this file exists to distinguish from a scope decision.
    expect([...WIRE_TOOL_NAMES].sort()).toEqual([...TOOL_NAMES].sort());
  });

  test('R11: recall is refused with scope_denied, by name', async () => {
    const refusal = await adminDispatch({ controlSql }, { name: 'recall', args: { query: 'anything' } });

    expect(refusal).toMatchObject({ ok: false, code: 'scope_denied', tool: 'recall' });
  });

  test('and it is a scope decision, not a name nobody recognised', () => {
    // The pair that carries the weight. A surface with no `recall` handler
    // answers the same thing for `recall` and for `recallx`; this one does not.
    expect(adminToolVerdict('recall')).toMatchObject({ code: 'scope_denied' });
    expect(adminToolVerdict('recallx')).toMatchObject({ code: 'unknown_operation' });
  });

  test('every wire tool is denied, not just the obvious readers', async () => {
    for (const name of WIRE_TOOL_NAMES) {
      const refusal = await adminDispatch({ controlSql }, { name });
      expect(refusal).toMatchObject({ ok: false, code: 'scope_denied', tool: name });
    }
  });
});

describe('the surface is not simply refusing everything', () => {
  test('its own fleet operations answer', async () => {
    for (const operation of ADMIN_OPERATIONS) {
      const result = await adminDispatch(
        { controlSql },
        { name: operation, args: { tenant_id: TENANT } },
      );
      expect(result.ok).toBe(true);
    }
  });

  test('a fleet answer is counters, and carries nothing a user wrote', async () => {
    const result = await adminDispatch({ controlSql }, { name: 'tenant_status', args: { tenant_id: TENANT } });
    if (!result.ok) throw new Error('tenant_status was refused');

    expect(Object.keys(result.content).sort()).toEqual([
      'last_activity',
      'last_cycle_at',
      'next_due_at',
      'pending_debt',
      'schema_version',
      'spend_micro_usd',
      'state',
      'tenant_id',
      'tier',
    ]);
    // Not even the reference. This surface has no reason to name a namespace a
    // reader could then go and ask the secret store for.
    expect(JSON.stringify(result.content)).not.toContain('secret');
  });
});

describe('the layer below the tool surface, which is where R11 says it is decided', () => {
  test('the admin and web-app identities cannot resolve a tenant secret', async () => {
    const secrets = createTenantSecretStore({ backend: createInMemorySecretBackend() });
    await secrets.put({ kind: 'control-plane' }, TENANT, {
      connectionString: 'postgres://brainz_owner:secret@alice.example.invalid/brainz',
      bearerGrant: 'bzk_alice_secret',
    });

    // The tenant's own fleet identity can, or the assertion below would be
    // proving that the store is broken rather than that the boundary holds.
    expect((await secrets.resolve(fleetIdentity(TENANT), TENANT)).ok).toBe(true);

    for (const caller of [adminIdentity(), webAppIdentity()]) {
      expect(await secrets.resolve(caller, TENANT)).toEqual({ ok: false, reason: 'scope_denied' });
    }
  });
});

describe('the admin credential against the real /mcp dispatch', () => {
  /**
   * A connections port that records every open. The point of the test is what
   * this array contains after a refusal.
   */
  function spyConnections(): TenantConnections & { readonly opened: string[] } {
    const opened: string[] = [];
    return {
      opened,
      open(tenantId: string) {
        opened.push(tenantId);
        // A refusal rather than a throw: the point is what `opened` holds, and a
        // rejection here would make an unrelated failure look like this one.
        return Promise.resolve({ ok: false as const, reason: 'unavailable' as const });
      },
      refreshSchemaVersion: () => Promise.resolve(undefined),
      close: () => Promise.resolve(),
    } as unknown as TenantConnections & { readonly opened: string[] };
  }

  function deps(connections: TenantConnections): DispatchDeps {
    return {
      endpoint: 'mcp',
      secrets: createTenantSecretStore({ backend: createInMemorySecretBackend() }),
      connections,
      store: createInMemoryAuthorizationStore(),
      accessLog: createInMemoryAccessLog(),
      signals: createControlSignals({ sink: { apply: () => Promise.resolve() }, now: () => 0 }),
      gateway: createGateway().gateway,
      now: () => new Date('2026-08-13T09:00:00.000Z'),
    };
  }

  test('an /admin credential attempting recall is refused, and opens no database', async () => {
    const connections = spyConnections();
    const result = await dispatch(deps(connections), {
      authorization: `Bearer ${ADMIN_CREDENTIAL}`,
      tool: 'recall',
      args: { query: "somebody else's mail" },
    });

    expect(result.ok).toBe(false);
    // The wording is the tool surface's to choose and this test does not own it.
    // What it owns is the property underneath: nothing was opened.
    expect(connections.opened).toEqual([]);
  });

  test('the same is true of every content tool, not just recall', async () => {
    const connections = spyConnections();
    for (const tool of WIRE_TOOL_NAMES) {
      const result = await dispatch(deps(connections), {
        authorization: `Bearer ${ADMIN_CREDENTIAL}`,
        tool,
        args: {},
      });
      expect(result.ok).toBe(false);
    }
    expect(connections.opened).toEqual([]);
  });

  test('the spy would notice — a credential that authenticates does open one', async () => {
    // The positive control. Without it, `opened` being empty is equally
    // consistent with a dispatch that never opens anything for anybody, and the
    // two assertions above would be measuring nothing.
    const connections = spyConnections();
    const secrets = createTenantSecretStore({ backend: createInMemorySecretBackend() });
    const bearer = `bzk_${TENANT}_a_real_provisioned_grant`;
    await secrets.put({ kind: 'control-plane' }, TENANT, {
      connectionString: 'postgres://x',
      bearerGrant: bearer,
    });

    await dispatch(
      { ...deps(connections), secrets },
      { authorization: `Bearer ${bearer}`, tool: 'recall', args: { query: 'my own mail' } },
    );
    expect(connections.opened).toEqual([TENANT]);
  });
});
