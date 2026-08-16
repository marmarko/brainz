/**
 * U14 — `manage`, and the three ways a call is authorised or refused.
 *
 * **The shape of every test here.** `manage` is the one tool on this surface
 * that changes something, on a connection that also carries ingested
 * third-party content. So each case asserts two things and not one: the typed
 * outcome, *and* the store re-read straight out of Postgres. A gate that
 * returns the right error while the write already happened is the failure this
 * file exists to catch, and asserting only the error code cannot see it.
 *
 * The stores are read with plain SQL rather than through the settings port, on
 * purpose: a port that both writes and reports is a port that can agree with
 * itself about a write that never landed.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { NO_CLIENT_CAPABILITIES } from '../../src/mcp/client-capabilities.ts';
import { deepLinkFor, MANAGE_ACTIONS } from '../../src/mcp/panel.ts';
import { deriveSigningKey, hashToken, mintAccessToken } from '../../src/mcp/oauth.ts';
import { PANEL_NONCE_TTL_MS, mintPanelToken } from '../../src/mcp/panel-token.ts';
import { PANEL_RESOURCE_URI } from '../../src/mcp/panel.ts';
import { readResource } from '../../src/mcp/resources.ts';
import { createMcpFixture, type McpFixture } from './fixture.ts';

const PANEL_CLIENT = { ui: true, elicitation: false } as const;
const ELICITING_CLIENT = { ui: false, elicitation: true } as const;

let fixture: McpFixture;

/** The three stores, read directly. */
async function stores(): Promise<{
  spendCap: number | null;
  contextPolicy: string | null;
  paused: Array<{ source: string; by: string }>;
}> {
  const capRows = (await fixture.controlSql`
    SELECT spend_cap_micro_usd::bigint AS cap FROM control.tenant WHERE tenant_id = ${fixture.tenantId}
  `) as Array<{ cap: string | number | null }>;
  const policyRows = (await fixture.sql`
    SELECT context_policy FROM tenant_setting
  `) as Array<{ context_policy: string | null }>;
  const pausedRows = (await fixture.sql`
    SELECT source, paused_by FROM source_pause ORDER BY source
  `) as Array<{ source: string; paused_by: string }>;

  const cap = capRows[0]?.cap;
  return {
    spendCap: cap === null || cap === undefined ? null : Number(cap),
    contextPolicy: policyRows[0]?.context_policy ?? null,
    paused: pausedRows.map((row) => ({ source: row.source, by: row.paused_by })),
  };
}

async function mintNonce(): Promise<string> {
  const result = await readResource(fixture.deps, {
    authorization: `Bearer ${fixture.bearer}`,
    uri: PANEL_RESOURCE_URI,
    clientCapabilities: PANEL_CLIENT,
  });
  const nonce = result.meta?.['brainz.app/panel_nonce'];
  if (typeof nonce !== 'string') throw new Error('resources/read minted no nonce');
  return nonce;
}

beforeAll(async () => {
  fixture = await createMcpFixture('manage_gate');
});

afterAll(async () => {
  await fixture.close();
});

beforeEach(async () => {
  await fixture.sql`DELETE FROM source_pause`;
  await fixture.sql`UPDATE tenant_setting SET context_policy = NULL`;
  await fixture.controlSql`
    UPDATE control.tenant SET spend_cap_micro_usd = NULL WHERE tenant_id = ${fixture.tenantId}
  `;
});

describe('the panel branch — a nonce, and nothing else', () => {
  test('a nonce from resources/read applies the change', async () => {
    const result = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail', panel_nonce: await mintNonce() },
      { capabilities: PANEL_CLIENT },
    );

    expect(result.ok).toBe(true);
    expect((result.content as { applied: boolean }).applied).toBe(true);
    expect((await stores()).paused).toEqual([{ source: 'gmail', by: 'panel' }]);
  });

  test('a model calling manage with no nonce is refused, and writes nothing', async () => {
    const result = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail' },
      { capabilities: PANEL_CLIENT },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_params');
    expect((await stores()).paused).toEqual([]);
  });

  test('a nonce past its TTL is refused, and writes nothing', async () => {
    const nonce = await mintNonce();

    // One millisecond inside the window still works, so the refusal below is
    // about expiry rather than about the nonce never having been valid.
    fixture.advance(PANEL_NONCE_TTL_MS - 1);
    const inTime = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'calendar', panel_nonce: nonce },
      { capabilities: PANEL_CLIENT },
    );
    expect(inTime.ok).toBe(true);

    fixture.advance(2);
    const expired = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'drive', panel_nonce: nonce },
      { capabilities: PANEL_CLIENT },
    );

    expect(expired.ok).toBe(false);
    expect(expired.error?.code).toBe('invalid_params');
    expect((await stores()).paused.map((row) => row.source)).toEqual(['calendar']);
  });

  // The three bindings, separated.
  //
  // A nonce lifted from another brain differs in *three* ways at once — key,
  // tenant id, connection id — so a test that only tries that one refuses for
  // whichever check happens to run first, and stays green when the other two are
  // deleted. Mutation showed exactly that: with the signature check and the
  // tenant binding both removed, the composite test below still passed, held up
  // by the connection binding alone. So each is isolated here, by minting a
  // token that is correct in every respect except the one under test.
  const realKey = (): string => deriveSigningKey(fixture.bearer);
  const realCaller = (): string => `bearer:${hashToken(fixture.bearer).slice(0, 16)}`;

  test('a nonce signed with another brain’s key is refused, and writes nothing', async () => {
    const forged = mintPanelToken('a-key-this-brain-never-derived', {
      purpose: 'panel',
      tenantId: fixture.tenantId,
      callerKey: realCaller(),
      expiresAt: fixture.now() + PANEL_NONCE_TTL_MS,
    });

    const result = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail', panel_nonce: forged },
      { capabilities: PANEL_CLIENT },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_params');
    expect((await stores()).paused).toEqual([]);
  });

  test('a correctly signed nonce naming another brain is refused, and writes nothing', async () => {
    const misaddressed = mintPanelToken(realKey(), {
      purpose: 'panel',
      tenantId: 't-some-other-brain',
      callerKey: realCaller(),
      expiresAt: fixture.now() + PANEL_NONCE_TTL_MS,
    });

    const result = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail', panel_nonce: misaddressed },
      { capabilities: PANEL_CLIENT },
    );

    expect(result.ok).toBe(false);
    expect((await stores()).paused).toEqual([]);
  });

  test('a correctly signed nonce from another connection is refused, and writes nothing', async () => {
    const otherConnection = mintPanelToken(realKey(), {
      purpose: 'panel',
      tenantId: fixture.tenantId,
      callerKey: 'bearer:0000000000000000',
      expiresAt: fixture.now() + PANEL_NONCE_TTL_MS,
    });

    const result = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail', panel_nonce: otherConnection },
      { capabilities: PANEL_CLIENT },
    );

    expect(result.ok).toBe(false);
    expect((await stores()).paused).toEqual([]);
  });

  test('a nonce minted for another brain is refused, and writes nothing', async () => {
    const other = await createMcpFixture('manage_gate_other', { tenantId: 't-manage-other' });
    try {
      const foreign = await readResource(other.deps, {
        authorization: `Bearer ${other.bearer}`,
        uri: PANEL_RESOURCE_URI,
        clientCapabilities: PANEL_CLIENT,
      });
      const nonce = foreign.meta?.['brainz.app/panel_nonce'];
      expect(typeof nonce).toBe('string');

      const result = await fixture.call(
        'manage',
        { action: 'pause_source', value: 'gmail', panel_nonce: String(nonce) },
        { capabilities: PANEL_CLIENT },
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('invalid_params');
      expect((await stores()).paused).toEqual([]);
    } finally {
      await other.close();
    }
  });

  test('elicitation never substitutes for a nonce on a panel-capable client', async () => {
    // The precedence rule: a host that can render a panel must produce a panel
    // credential. Answering a confirmation instead would let the model reach a
    // gate that was never about confirmation.
    const result = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail' },
      {
        capabilities: { ui: true, elicitation: true },
        resume: { inputResponses: { confirm: true } },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.inputRequired).toBeUndefined();
    expect((await stores()).paused).toEqual([]);
  });

  test('the panel branch is where set_context_policy still lives', async () => {
    const result = await fixture.call(
      'manage',
      { action: 'set_context_policy', value: 'personal_only', panel_nonce: await mintNonce() },
      { capabilities: PANEL_CLIENT },
    );

    expect(result.ok).toBe(true);
    expect((await stores()).contextPolicy).toBe('personal_only');
  });
});

describe('the fallback branch — confirm, or refuse', () => {
  test('without elicitation, manage refuses and hands over the deep link', async () => {
    const result = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail' },
      { capabilities: NO_CLIENT_CAPABILITIES },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('scope_denied');
    expect(result.error?.message).toContain(deepLinkFor('pause_source', 'https://app.brainz.test'));
    expect(result.inputRequired).toBeUndefined();
    expect((await stores()).paused).toEqual([]);
  });

  test('without elicitation, answering a confirmation that was never asked changes nothing', async () => {
    // The fail-closed half. A host that cannot elicit could still *claim* an
    // answer; the gate must key on the capability, not on the answer.
    const result = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail' },
      {
        capabilities: NO_CLIENT_CAPABILITIES,
        resume: { inputResponses: { confirm: true } },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('scope_denied');
    expect((await stores()).paused).toEqual([]);
  });

  test('with elicitation, the first call asks and does not act', async () => {
    const result = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail' },
      { capabilities: ELICITING_CLIENT },
    );

    expect(result.inputRequired?.inputRequests.confirm?.type).toBe('elicitation');
    expect(typeof result.inputRequired?.requestState).toBe('string');
    expect((await stores()).paused).toEqual([]);
  });

  test('the echoed requestState plus a yes applies it, recorded as agent-confirmed', async () => {
    const asked = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail' },
      { capabilities: ELICITING_CLIENT },
    );
    const requestState = asked.inputRequired?.requestState ?? '';

    const applied = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail' },
      {
        capabilities: ELICITING_CLIENT,
        resume: { requestState, inputResponses: { confirm: true } },
      },
    );

    expect(applied.ok).toBe(true);
    // Never `user_out_of_band`: the agent issued this call and the user waved
    // it through inside an agent-driven turn. R12a's distinction survives.
    expect((await stores()).paused).toEqual([{ source: 'gmail', by: 'agent_confirmed' }]);
  });

  test('a no is a no', async () => {
    const asked = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail' },
      { capabilities: ELICITING_CLIENT },
    );

    const declined = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail' },
      {
        capabilities: ELICITING_CLIENT,
        resume: {
          requestState: asked.inputRequired?.requestState ?? '',
          inputResponses: { confirm: false },
        },
      },
    );

    expect(declined.ok).toBe(false);
    expect((await stores()).paused).toEqual([]);
  });

  test('the confirmed change is the one that happens — a swapped retry changes nothing', async () => {
    const asked = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail' },
      { capabilities: ELICITING_CLIENT },
    );

    const swapped = await fixture.call(
      'manage',
      { action: 'set_spend_cap', value: '0' },
      {
        capabilities: ELICITING_CLIENT,
        resume: {
          requestState: asked.inputRequired?.requestState ?? '',
          inputResponses: { confirm: true },
        },
      },
    );

    expect(swapped.ok).toBe(false);
    const after = await stores();
    expect(after.spendCap).toBeNull();
    expect(after.paused).toEqual([]);
  });

  test('a requestState past its TTL is refused, and writes nothing', async () => {
    const asked = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail' },
      { capabilities: ELICITING_CLIENT },
    );

    fixture.advance(PANEL_NONCE_TTL_MS + 1);
    const stale = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail' },
      {
        capabilities: ELICITING_CLIENT,
        resume: {
          requestState: asked.inputRequired?.requestState ?? '',
          inputResponses: { confirm: true },
        },
      },
    );

    expect(stale.ok).toBe(false);
    expect((await stores()).paused).toEqual([]);
  });

  test('a forged requestState is refused, and writes nothing', async () => {
    const result = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail' },
      {
        capabilities: ELICITING_CLIENT,
        resume: { requestState: 'not.a.token', inputResponses: { confirm: true } },
      },
    );

    expect(result.ok).toBe(false);
    expect((await stores()).paused).toEqual([]);
  });

  test('set_context_policy is web-app-only here, even with a yes in hand', async () => {
    const asked = await fixture.call(
      'manage',
      { action: 'set_context_policy', value: 'personal_only' },
      { capabilities: ELICITING_CLIENT },
    );

    expect(asked.ok).toBe(false);
    expect(asked.inputRequired).toBeUndefined();
    expect(asked.error?.code).toBe('scope_denied');
    expect(asked.error?.message).toContain(
      deepLinkFor('set_context_policy', 'https://app.brainz.test'),
    );
    expect((await stores()).contextPolicy).toBeNull();
  });

  test('a panel nonce is not a substitute for a confirmation on a panel-less client', async () => {
    // The nonce could only have come from a ui-capable request. Presenting one
    // on a client that declares no ui is either a replay or a leak, and either
    // way it is not this branch's credential — so the call is asked about, not
    // waved through.
    const nonce = await mintNonce();
    const result = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail', panel_nonce: nonce },
      { capabilities: ELICITING_CLIENT },
    );

    expect(result.inputRequired).toBeDefined();
    expect((result.content as { applied?: boolean }).applied).toBeUndefined();
    expect((await stores()).paused).toEqual([]);
  });
});

describe('the actions do what they say', () => {
  test('set_spend_cap lands on the column the first-import gate reads', async () => {
    const result = await fixture.call(
      'manage',
      { action: 'set_spend_cap', value: '2500000', panel_nonce: await mintNonce() },
      { capabilities: PANEL_CLIENT },
    );

    expect(result.ok).toBe(true);
    expect((await stores()).spendCap).toBe(2_500_000);
  });

  test('resume_source removes the pause rather than recording a second state', async () => {
    await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail', panel_nonce: await mintNonce() },
      { capabilities: PANEL_CLIENT },
    );
    const resumed = await fixture.call(
      'manage',
      { action: 'resume_source', value: 'gmail', panel_nonce: await mintNonce() },
      { capabilities: PANEL_CLIENT },
    );

    expect(resumed.ok).toBe(true);
    expect((await stores()).paused).toEqual([]);
  });

  test('a value outside the closed set is refused before it reaches a store', async () => {
    for (const [action, value] of [
      ['pause_source', 'not-a-connector'],
      ['set_context_policy', 'whatever-i-like'],
      ['set_spend_cap', 'a lot'],
      ['set_spend_cap', '-1'],
    ] as const) {
      const result = await fixture.call(
        'manage',
        { action, value, panel_nonce: await mintNonce() },
        { capabilities: PANEL_CLIENT },
      );
      expect(`${action}=${value}: ${result.ok}`).toBe(`${action}=${value}: false`);
    }

    const after = await stores();
    expect(after.paused).toEqual([]);
    expect(after.contextPolicy).toBeNull();
    expect(after.spendCap).toBeNull();
  });

  test('an unknown action is refused whatever credential it carries', async () => {
    const result = await fixture.call(
      'manage',
      { action: 'close_review', value: '1', panel_nonce: await mintNonce() },
      { capabilities: PANEL_CLIENT },
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('invalid_params');
  });
});

describe('R12a — the review queue has no close on this surface, by ruling', () => {
  test('the declared enum contains no review action', () => {
    const actions = MANAGE_ACTIONS.map((entry) => entry.action);
    expect(actions).toEqual([
      'set_context_policy',
      'set_spend_cap',
      'pause_source',
      'resume_source',
    ]);
    for (const action of actions) {
      expect(`${action} mentions review: ${action.includes('review')}`).toBe(
        `${action} mentions review: false`,
      );
    }
  });

  test('an open entry stays open no matter what manage is asked to do', async () => {
    await fixture.sql`
      INSERT INTO review_queue (kind, target_ref, proposal, confidence, origin_contexts)
      VALUES ('entity_merge', 'entity:u14', 'merge these two', 0.6, ARRAY['personal:mail'])
    `;

    const nonce = await mintNonce();
    for (const action of ['close_review', 'apply_review', 'set_context_policy']) {
      await fixture.call(
        'manage',
        { action, value: 'entity:u14', panel_nonce: nonce },
        { capabilities: PANEL_CLIENT },
      );
    }

    const rows = (await fixture.sql`
      SELECT state, closed_by FROM review_queue WHERE target_ref = 'entity:u14'
    `) as Array<{ state: string; closed_by: string | null }>;
    expect(rows[0]?.state).toBe('open');
    expect(rows[0]?.closed_by).toBeNull();

    await fixture.sql`DELETE FROM review_queue WHERE target_ref = 'entity:u14'`;
  });

  test('the pause table refuses an authority that would blur R12a’s line', async () => {
    // Mutation found this one: weakening rung 7's CHECK to `length > 0` broke
    // nothing, because the code only ever writes two of the three legal values
    // and no test asked the database anything. The constraint's whole job is to
    // stop a later writer recording a pause as something it was not — and
    // `agent_mcp` is the name that matters, because it is the one
    // `review_queue.closed_by` refuses one table over.
    for (const authority of ['agent_mcp', 'user_out_of_band', 'whatever']) {
      let sqlstate = 'none';
      try {
        await fixture.sql.unsafe(
          `INSERT INTO source_pause (source, paused_by) VALUES ('drive', '${authority}')`,
        );
      } catch (error) {
        sqlstate = String((error as { errno?: string }).errno ?? '');
      }
      expect(`${authority}: ${sqlstate}`).toBe(`${authority}: 23514`);
    }

    // And the legal ones are accepted, so the constraint is a closed set rather
    // than a table that refuses every write.
    for (const authority of ['panel', 'agent_confirmed', 'app']) {
      await fixture.sql.unsafe(
        `INSERT INTO source_pause (source, paused_by) VALUES ('drive', '${authority}')`,
      );
      await fixture.sql`DELETE FROM source_pause WHERE source = 'drive'`;
    }
  });

  test('the schema still refuses agent_mcp, so the ruling is not the only thing holding', async () => {
    let sqlstate = 'none';
    try {
      await fixture.sql.unsafe(`
        INSERT INTO review_queue (kind, target_ref, proposal, confidence, state, closed_by, closed_at, origin_contexts)
        VALUES ('entity_merge', 'entity:u14b', 'merge', 0.6, 'applied', 'agent_mcp', now(), ARRAY['personal:mail'])
      `);
    } catch (error) {
      sqlstate = String((error as { errno?: string; code?: string }).errno ?? (error as { code?: string }).code ?? '');
    }
    expect(sqlstate).toBe('23514');
  });
});

describe('the text twin is reachable without a panel', () => {
  test('brain carries the management block, its values, and the deep link', async () => {
    await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail', panel_nonce: await mintNonce() },
      { capabilities: PANEL_CLIENT },
    );

    const result = await fixture.call('brain', {}, { capabilities: NO_CLIENT_CAPABILITIES });
    const management = (result.content as { management?: Record<string, unknown> }).management;
    expect(management).toBeDefined();
    expect((management as { paused_sources: string[] }).paused_sources).toEqual(['gmail']);

    const serialised = JSON.stringify(management);
    for (const action of MANAGE_ACTIONS) {
      expect(`${action.action} in brain: ${serialised.includes(action.action)}`).toBe(
        `${action.action} in brain: true`,
      );
    }
    expect(serialised).toContain('https://app.brainz.test');
  });
});

// ---------------------------------------------------------------------------
// U18 — a credential that holds a slice of the brain does not manage the brain.
// ---------------------------------------------------------------------------

/**
 * **`manage` is tenant-wide, and nothing above it checked the grant's scope.**
 *
 * The spend cap, the context policy and the source pauses are properties of the
 * whole brain: pausing `gmail` stops the personal mailbox as surely as the work
 * one, and zeroing the cap stops every connector at once. A work-connector
 * grant is a slice — that is the entire product meaning of U18's narrowing —
 * and the gate that decides whether a call may change something asked only what
 * the *client* could render, never what the *credential* was for.
 *
 * Two checkpoints, because either alone is a control the other's failure hides:
 *
 *   * `resources.ts` minted the panel nonce for any authenticated caller. That
 *     is the mint, and it also hands back the panel HTML, which renders the
 *     tenant-wide settings a narrowed grant should not be reading either.
 *   * `manage-gate.ts` never consulted the scope. A nonce is a bearer value: it
 *     rides `_meta` on a resource read and is echoed back as a tool argument, so
 *     "the mint is closed" is not the same claim as "the gate refuses". The gate
 *     test below therefore mints its nonce **directly**, so the gate is asked
 *     the question even when the mint would not have answered it.
 */
describe('a narrowed grant does not manage the whole brain', () => {
  const NARROWED_GRANT_ID = 'g-work-connector';

  function narrowedAuthorization(): string {
    return `Bearer ${mintAccessToken(
      {
        grantId: NARROWED_GRANT_ID,
        tenantId: fixture.tenantId,
        clientId: 'client-work-connector',
        scope: 'narrowed',
        origins: ['work:*'],
        writeOrigin: 'work:agent',
        endpoint: 'mcp',
        issuedAt: fixture.now(),
        expiresAt: fixture.now() + 3_600_000,
      },
      deriveSigningKey(fixture.bearer),
    )}`;
  }

  /** A structurally perfect nonce for the narrowed caller, minted past the mint. */
  function nonceForNarrowedGrant(): string {
    return mintPanelToken(deriveSigningKey(fixture.bearer), {
      purpose: 'panel',
      tenantId: fixture.tenantId,
      callerKey: NARROWED_GRANT_ID,
      expiresAt: fixture.now() + PANEL_NONCE_TTL_MS,
    });
  }

  test('the panel resource is not minted for a credential that holds a slice', async () => {
    const result = await readResource(fixture.deps, {
      authorization: narrowedAuthorization(),
      uri: PANEL_RESOURCE_URI,
      clientCapabilities: PANEL_CLIENT,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('scope_denied');
    // And no nonce came back on the refusal, which is the half that matters:
    // the nonce is the credential the gate below accepts.
    expect(result.meta?.['brainz.app/panel_nonce']).toBeUndefined();
    // Nor did the panel HTML, which renders the tenant-wide settings.
    expect(result.contents).toBeUndefined();
  });

  test('and the whole-brain credential still gets one, so the refusal is not blanket', async () => {
    const result = await readResource(fixture.deps, {
      authorization: `Bearer ${fixture.bearer}`,
      uri: PANEL_RESOURCE_URI,
      clientCapabilities: PANEL_CLIENT,
    });
    expect(result.ok).toBe(true);
    expect(typeof result.meta?.['brainz.app/panel_nonce']).toBe('string');
  });

  test('a valid nonce does not carry a narrowed grant past the gate, and writes nothing', async () => {
    const result = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail', panel_nonce: nonceForNarrowedGrant() },
      { capabilities: PANEL_CLIENT, authorization: narrowedAuthorization() },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('scope_denied');
    expect((await stores()).paused).toEqual([]);
  });

  test('nor does a confirmation on the elicitation branch, and it is never even asked', async () => {
    // The refusal has to land *before* the prompt is minted. A narrowed grant
    // that reaches `input_required` has already been handed a `requestState`
    // it can spend, and the user has been asked to authorise a change the
    // connector was never entitled to request.
    const result = await fixture.call(
      'manage',
      { action: 'set_spend_cap', value: '1000' },
      { capabilities: ELICITING_CLIENT, authorization: narrowedAuthorization() },
    );

    expect(result.inputRequired).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('scope_denied');
    expect((await stores()).spendCap).toBeNull();
  });

  test('the same call under the whole-brain credential still applies, so the gate is scope and not breakage', async () => {
    const result = await fixture.call(
      'manage',
      { action: 'pause_source', value: 'gmail', panel_nonce: await mintNonce() },
      { capabilities: PANEL_CLIENT },
    );
    expect(result.ok).toBe(true);
    expect((await stores()).paused).toEqual([{ source: 'gmail', by: 'panel' }]);
  });
});
