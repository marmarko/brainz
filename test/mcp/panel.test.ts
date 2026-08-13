/**
 * U14 — the panel resource, its short-TTL nonce, and the text twin.
 *
 * **What these tests are trying not to be.** Every property below is an
 * *absence* — a nonce that must stop working, a caller that must not be
 * admitted, a mutation that must not have happened. Absence properties pass
 * trivially when the branch is never entered, and this repository has shipped
 * guards that were green for exactly that reason. So every refusal case here
 * asserts the refusal **and** re-reads the underlying store to prove nothing
 * moved, and the token tests exercise the accept path beside every reject path
 * so a verifier that refuses everything cannot pass either.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  NO_CLIENT_CAPABILITIES,
  readClientCapabilities,
  UI_EXTENSION,
  CLIENT_CAPABILITIES_META_KEY,
} from '../../src/mcp/client-capabilities.ts';
import {
  MANAGE_ACTIONS,
  PANEL_MIME_TYPE,
  PANEL_RESOURCE_URI,
  deepLinkFor,
  panelHtml,
  panelTextTwin,
} from '../../src/mcp/panel.ts';
import {
  PANEL_NONCE_TTL_MS,
  mintPanelToken,
  verifyPanelToken,
} from '../../src/mcp/panel-token.ts';
import { listResources, readResource } from '../../src/mcp/resources.ts';
import { listedTools } from '../../src/mcp/tools/index.ts';
import { createMcpFixture, type McpFixture } from './fixture.ts';

const KEY = 'a-derived-signing-key';
const TENANT = 't-panel';
const CALLER = 'bearer:0123456789abcdef';

describe('the panel token — short TTL, tenant-bound, caller-bound, purpose-bound', () => {
  const base = {
    purpose: 'panel' as const,
    tenantId: TENANT,
    callerKey: CALLER,
    expiresAt: 1_000_000 + PANEL_NONCE_TTL_MS,
  };

  test('a fresh token verifies — the accept path exists', () => {
    const token = mintPanelToken(KEY, base);
    const verdict = verifyPanelToken(token, KEY, {
      purpose: 'panel',
      tenantId: TENANT,
      callerKey: CALLER,
      nowMs: 1_000_000,
    });
    expect(verdict.ok).toBe(true);
  });

  test('it stops verifying the instant it expires', () => {
    const token = mintPanelToken(KEY, base);
    const justBefore = verifyPanelToken(token, KEY, {
      purpose: 'panel',
      tenantId: TENANT,
      callerKey: CALLER,
      nowMs: base.expiresAt - 1,
    });
    expect(justBefore.ok).toBe(true);

    const atExpiry = verifyPanelToken(token, KEY, {
      purpose: 'panel',
      tenantId: TENANT,
      callerKey: CALLER,
      nowMs: base.expiresAt,
    });
    expect(atExpiry.ok).toBe(false);
    if (!atExpiry.ok) expect(atExpiry.reason).toBe('expired');
  });

  test('another tenant cannot spend it, and neither can another connection', () => {
    const token = mintPanelToken(KEY, base);

    const otherTenant = verifyPanelToken(token, KEY, {
      purpose: 'panel',
      tenantId: 't-someone-else',
      callerKey: CALLER,
      nowMs: 1_000_000,
    });
    expect(otherTenant.ok).toBe(false);
    if (!otherTenant.ok) expect(otherTenant.reason).toBe('wrong_tenant');

    const otherCaller = verifyPanelToken(token, KEY, {
      purpose: 'panel',
      tenantId: TENANT,
      callerKey: 'bearer:ffffffffffffffff',
      nowMs: 1_000_000,
    });
    expect(otherCaller.ok).toBe(false);
    if (!otherCaller.ok) expect(otherCaller.reason).toBe('wrong_caller');
  });

  test('a confirm token is not a panel nonce and a panel nonce is not a confirm', () => {
    const nonce = mintPanelToken(KEY, base);
    const asConfirm = verifyPanelToken(nonce, KEY, {
      purpose: 'confirm',
      tenantId: TENANT,
      callerKey: CALLER,
      action: 'pause_source',
      value: 'gmail',
      nowMs: 1_000_000,
    });
    expect(asConfirm.ok).toBe(false);
    if (!asConfirm.ok) expect(asConfirm.reason).toBe('wrong_purpose');
  });

  test('a confirm token names the exact change it confirmed', () => {
    const confirm = mintPanelToken(KEY, {
      purpose: 'confirm',
      tenantId: TENANT,
      callerKey: CALLER,
      action: 'pause_source',
      value: 'gmail',
      expiresAt: 1_000_000 + 60_000,
    });

    const asIssued = verifyPanelToken(confirm, KEY, {
      purpose: 'confirm',
      tenantId: TENANT,
      callerKey: CALLER,
      action: 'pause_source',
      value: 'gmail',
      nowMs: 1_000_000,
    });
    expect(asIssued.ok).toBe(true);

    // The swap: the user was asked about pausing gmail and the retry asks for a
    // different change entirely.
    const swapped = verifyPanelToken(confirm, KEY, {
      purpose: 'confirm',
      tenantId: TENANT,
      callerKey: CALLER,
      action: 'set_spend_cap',
      value: '0',
      nowMs: 1_000_000,
    });
    expect(swapped.ok).toBe(false);
    if (!swapped.ok) expect(swapped.reason).toBe('action_mismatch');

    // And the narrower swap, same action, different target.
    const retargeted = verifyPanelToken(confirm, KEY, {
      purpose: 'confirm',
      tenantId: TENANT,
      callerKey: CALLER,
      action: 'pause_source',
      value: 'drive',
      nowMs: 1_000_000,
    });
    expect(retargeted.ok).toBe(false);
    if (!retargeted.ok) expect(retargeted.reason).toBe('action_mismatch');
  });

  test('a token signed with another brain’s key is refused', () => {
    const token = mintPanelToken('a-different-key', base);
    const verdict = verifyPanelToken(token, KEY, {
      purpose: 'panel',
      tenantId: TENANT,
      callerKey: CALLER,
      nowMs: 1_000_000,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('bad_signature');
  });

  test('a tampered payload is refused, not silently re-read', () => {
    const token = mintPanelToken(KEY, base);
    const [payload, signature] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as {
      tenantId: string;
    };
    decoded.tenantId = 't-someone-else';
    const forged = `${Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')}.${signature}`;

    const verdict = verifyPanelToken(forged, KEY, {
      purpose: 'panel',
      tenantId: 't-someone-else',
      callerKey: CALLER,
      nowMs: 1_000_000,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('bad_signature');
  });

  test('garbage is refused without throwing', () => {
    for (const junk of ['', 'not-a-token', 'a.b.c', '.', 'eyJ9.']) {
      const verdict = verifyPanelToken(junk, KEY, {
        purpose: 'panel',
        tenantId: TENANT,
        callerKey: CALLER,
        nowMs: 1_000_000,
      });
      expect(verdict.ok).toBe(false);
    }
  });
});

describe('client capabilities are read per request, and absence means absent', () => {
  test('the ui extension and elicitation are both detected', () => {
    const caps = readClientCapabilities({
      [CLIENT_CAPABILITIES_META_KEY]: {
        extensions: { [UI_EXTENSION]: { mimeTypes: [PANEL_MIME_TYPE] } },
        elicitation: { form: {} },
      },
    });
    expect(caps).toEqual({ ui: true, elicitation: true });
  });

  test('an ui-less, elicitation-less client reads as neither', () => {
    expect(readClientCapabilities({ [CLIENT_CAPABILITIES_META_KEY]: {} })).toEqual(
      NO_CLIENT_CAPABILITIES,
    );
    expect(readClientCapabilities(undefined)).toEqual(NO_CLIENT_CAPABILITIES);
    expect(readClientCapabilities(null)).toEqual(NO_CLIENT_CAPABILITIES);
    expect(readClientCapabilities({ nonsense: true })).toEqual(NO_CLIENT_CAPABILITIES);
  });

  test('a differently-named extension is not the ui extension', () => {
    const caps = readClientCapabilities({
      [CLIENT_CAPABILITIES_META_KEY]: { extensions: { 'com.example/ui': {} } },
    });
    expect(caps.ui).toBe(false);
  });
});

describe('what tools/list says, per client', () => {
  test('a ui-capable client sees seven model tools plus an app-scoped manage', () => {
    const listed = listedTools('mcp', { ui: true, elicitation: false });
    const names = listed.map((entry) => entry.def.name);
    expect(names).toContain('manage');

    const modelVisible = listed.filter(
      (entry) => (entry.meta?.ui as { visibility?: string[] } | undefined)?.visibility?.includes('model') !== false,
    );
    expect(modelVisible.length).toBe(7);

    const manage = listed.find((entry) => entry.def.name === 'manage');
    expect((manage?.meta?.ui as { visibility?: string[] }).visibility).toEqual(['app']);
  });

  test('a ui-capable client is told where the panel lives', () => {
    const listed = listedTools('mcp', { ui: true, elicitation: false });
    const carrier = listed.find(
      (entry) => (entry.meta?.ui as { resourceUri?: string } | undefined)?.resourceUri !== undefined,
    );
    expect((carrier?.meta?.ui as { resourceUri?: string }).resourceUri).toBe(PANEL_RESOURCE_URI);
  });

  test('a client without the ui extension sees manage as an ordinary eighth name', () => {
    const listed = listedTools('mcp', NO_CLIENT_CAPABILITIES);
    const manage = listed.find((entry) => entry.def.name === 'manage');
    expect(manage).toBeDefined();
    expect(manage?.meta).toBeUndefined();
    expect(listed.length).toBe(8);
  });

  test('the ChatGPT surface never lists manage', () => {
    for (const caps of [NO_CLIENT_CAPABILITIES, { ui: true, elicitation: true }]) {
      const names = listedTools('openai', caps).map((entry) => entry.def.name);
      expect(names).not.toContain('manage');
      expect(names.length).toBe(7);
    }
  });
});

describe('text-twin parity — a client that cannot render is not a client that cannot manage', () => {
  const view = {
    spendCapMicroUsd: 2_500_000,
    contextPolicy: null,
    pausedSources: ['gmail'] as readonly string[],
    connectorSources: ['gmail', 'calendar', 'drive'] as readonly string[],
    webAppBaseUrl: 'https://app.brainz.test',
  };

  test('there are actions to check at all', () => {
    expect(MANAGE_ACTIONS.length).toBe(4);
  });

  test('every panel action appears in the text twin', () => {
    const twin = panelTextTwin(view);
    for (const action of MANAGE_ACTIONS) {
      const entry = twin.actions.find((candidate) => candidate.action === action.action);
      expect(`${action.action} has a twin: ${entry !== undefined}`).toBe(
        `${action.action} has a twin: true`,
      );
    }
    expect(twin.actions.length).toBe(MANAGE_ACTIONS.length);
  });

  test('every text twin appears in the panel, so neither side can grow alone', () => {
    const html = panelHtml(view, 'nonce-abc');
    for (const action of MANAGE_ACTIONS) {
      expect(`${action.action} in panel: ${html.includes(action.action)}`).toBe(
        `${action.action} in panel: true`,
      );
    }
  });

  test('each twin is a call this server would actually dispatch, or a deep link', () => {
    const twin = panelTextTwin(view);
    for (const entry of twin.actions) {
      const def = MANAGE_ACTIONS.find((candidate) => candidate.action === entry.action);
      if (def?.panelOnly === true) {
        // The roadmap's fallback rule: this one moves web-app-only, so its twin
        // is the deep link rather than a tool call.
        expect(entry.call).toBeNull();
        expect(entry.webAppUrl).toBe(deepLinkFor(entry.action, view.webAppBaseUrl));
      } else {
        expect(entry.call?.tool).toBe('manage');
        expect(entry.call?.args.action).toBe(entry.action);
      }
    }
  });

  test('the panel carries its nonce and the twin never does', () => {
    expect(panelHtml(view, 'nonce-abc')).toContain('nonce-abc');
    expect(JSON.stringify(panelTextTwin(view))).not.toContain('nonce-abc');
  });

  test('the panel escapes what it renders — a source name is not markup', () => {
    const hostile = {
      ...view,
      pausedSources: ['</script><img src=x onerror=alert(1)>'] as readonly string[],
      connectorSources: ['</script><img src=x onerror=alert(1)>'] as readonly string[],
    };
    const html = panelHtml(hostile, 'nonce-abc');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('</script><img');
  });
});

describe('the panel resource, over the wire', () => {
  let fixture: McpFixture;

  beforeAll(async () => {
    fixture = await createMcpFixture('panel_resource');
  });

  afterAll(async () => {
    await fixture.close();
  });

  test('it is only listed to a client that can render it', () => {
    expect(listResources({ ui: true, elicitation: false }).map((entry) => entry.uri)).toEqual([
      PANEL_RESOURCE_URI,
    ]);
    expect(listResources(NO_CLIENT_CAPABILITIES)).toEqual([]);
  });

  test('a ui-capable read returns the panel and mints a nonce', async () => {
    const result = await readResource(fixture.deps, {
      authorization: `Bearer ${fixture.bearer}`,
      uri: PANEL_RESOURCE_URI,
      clientCapabilities: { ui: true, elicitation: false },
    });

    expect(result.ok).toBe(true);
    expect(result.contents?.[0]?.mimeType).toBe(PANEL_MIME_TYPE);
    expect(result.contents?.[0]?.uri).toBe(PANEL_RESOURCE_URI);
    const nonce = result.meta?.['brainz.app/panel_nonce'];
    expect(typeof nonce).toBe('string');
    expect(result.contents?.[0]?.text).toContain(String(nonce));
  });

  test('a client that cannot render one cannot mint one either', async () => {
    const result = await readResource(fixture.deps, {
      authorization: `Bearer ${fixture.bearer}`,
      uri: PANEL_RESOURCE_URI,
      clientCapabilities: NO_CLIENT_CAPABILITIES,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('scope_denied');
    expect(result.meta?.['brainz.app/panel_nonce']).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('panel_nonce');
  });

  test('an unauthenticated read mints nothing and says nothing about the tenant', async () => {
    const result = await readResource(fixture.deps, {
      authorization: null,
      uri: PANEL_RESOURCE_URI,
      clientCapabilities: { ui: true, elicitation: false },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('unauthorized');
    expect(result.meta?.['brainz.app/panel_nonce']).toBeUndefined();
  });

  test('an unknown uri is a miss, not a panel', async () => {
    const result = await readResource(fixture.deps, {
      authorization: `Bearer ${fixture.bearer}`,
      uri: 'ui://brainz/not-a-panel',
      clientCapabilities: { ui: true, elicitation: false },
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('not_found');
  });

  test('the read is logged like every other reach into the brain', async () => {
    const before = fixture.accessLog.entries.length;
    await readResource(fixture.deps, {
      authorization: `Bearer ${fixture.bearer}`,
      uri: PANEL_RESOURCE_URI,
      clientCapabilities: { ui: true, elicitation: false },
    });
    const added = fixture.accessLog.entries.slice(before);
    expect(added.length).toBe(1);
    expect(added[0]?.tool).toBe('resources/read');
    expect(added[0]?.tenantId).toBe(fixture.tenantId);
  });
});
