/**
 * The panel: one action table (`manage-actions.ts`), rendered two ways.
 *
 * **The text twin is not a courtesy, it is the requirement.** U14's verification
 * line reads "every panel action has a working text twin", and the reason is in
 * `docs/plans/2026-08-13-002-u14-panel-manage-replan.md`: on the client this
 * product launches against, the panel does not render for a custom remote
 * connector, so the twin is not the degraded path — it is the path. A client
 * that cannot render is not a client that cannot manage.
 *
 * **Both renderings read the same table**, so the parity test compares two
 * renderings rather than comparing a list to itself, and neither side can grow
 * an action alone.
 *
 * **The HTML escapes everything it interpolates.** The view carries connector
 * names and a policy string, and while none of those is user prose today, a
 * panel is an HTML document rendered inside the user's client — the one place
 * on this surface where a string becomes markup. `demarcation.ts` makes the
 * same argument about the model's context; this is the browser's version of it.
 */

import { CONNECTOR_SOURCES } from '../ingest/cursor.ts';
import type { ClientCapabilities } from './client-capabilities.ts';
import {
  acceptedValuesFor,
  deepLinkFor,
  MANAGE_ACTIONS,
  type ManageAction,
  type ManageActionDef,
} from './manage-actions.ts';

export {
  CLEAR_SPEND_CAP,
  CONTEXT_POLICIES,
  DEFAULT_WEB_APP_BASE_URL,
  MANAGE_ACTIONS,
  MANAGE_ACTION_NAMES,
  acceptedValuesFor,
  deepLinkFor,
  manageActionByName,
  normalizeManageValue,
  type ContextPolicy,
  type ManageAction,
  type ManageActionDef,
} from './manage-actions.ts';

/** The resource a host fetches and renders. SEP-1865's `ui://` scheme. */
export const PANEL_RESOURCE_URI = 'ui://brainz/panel';

/** The MIME type the MCP Apps MVP requires. Not negotiable, not abbreviated. */
export const PANEL_MIME_TYPE = 'text/html;profile=mcp-app';

/** What both renderings read. Counts and setting values only — no user prose. */
export interface PanelView {
  readonly spendCapMicroUsd: number | null;
  readonly contextPolicy: string | null;
  readonly pausedSources: readonly string[];
  readonly connectorSources: readonly string[];
  readonly webAppBaseUrl: string;
}

export interface TwinCall {
  readonly tool: 'manage';
  readonly args: Readonly<Record<string, string>>;
}

export interface TwinAction {
  readonly action: ManageAction;
  readonly label: string;
  readonly summary: string;
  /** The exact call, or `null` when this action's twin is the deep link. */
  readonly call: TwinCall | null;
  readonly webAppUrl: string;
  readonly accepts: readonly string[];
}

export interface PanelTextTwin {
  readonly current: {
    readonly spend_cap_micro_usd: number | null;
    readonly context_policy: string | null;
    readonly paused_sources: readonly string[];
  };
  readonly actions: readonly TwinAction[];
  readonly note: string;
}

/**
 * What a given action's `value` may be.
 *
 * Connector names come from the view, because a panel rendered for a brain
 * should offer that brain's connectors; everything else comes from the one
 * validator the gate and the settings port both run, so the panel cannot offer
 * a value the store would refuse.
 */
function acceptedValues(def: ManageActionDef, view: PanelView): readonly string[] {
  return def.valueKind === 'connector_source'
    ? view.connectorSources
    : acceptedValuesFor(def.action);
}

/**
 * The text rendering.
 *
 * It carries no nonce, deliberately. The twin is what callers on the fallback
 * branch read, where a nonce is not the credential and could only leak.
 */
export function panelTextTwin(view: PanelView): PanelTextTwin {
  return {
    current: {
      spend_cap_micro_usd: view.spendCapMicroUsd,
      context_policy: view.contextPolicy,
      paused_sources: [...view.pausedSources],
    },
    actions: MANAGE_ACTIONS.map((def) => ({
      action: def.action,
      label: def.label,
      summary: def.summary,
      call: def.panelOnly ? null : { tool: 'manage' as const, args: { action: def.action } },
      webAppUrl: deepLinkFor(def.action, view.webAppBaseUrl),
      accepts: acceptedValues(def, view),
    })),
    note:
      'Each of these needs your explicit confirmation before it runs. If this client cannot ask ' +
      'you, the call is refused and the web-app link is what you use instead.',
  };
}

/** HTML-escape. Everything interpolated below goes through it, without exception. */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The panel document.
 *
 * Self-contained: no external stylesheet, no external script, nothing for the
 * host's CSP to have to allow. The nonce is embedded because the app's own
 * script is what presents it back with a `tools/call`, and the residual that
 * creates — a host that lets resource content reach model context hands the
 * model the nonce — is exactly why the review-queue close is not one of these
 * actions (re-plan §3).
 */
export function panelHtml(view: PanelView, nonce: string): string {
  const rows = MANAGE_ACTIONS.map((def) => {
    const options = acceptedValues(def, view)
      .map((value) => `<option value="${escape(value)}">${escape(value)}</option>`)
      .join('');
    const control =
      def.valueKind === 'micro_usd'
        ? `<input type="number" min="0" step="1" data-value-for="${escape(def.action)}" />`
        : `<select data-value-for="${escape(def.action)}">${options}</select>`;
    const button = def.panelOnly
      ? `<a class="deep" href="${escape(deepLinkFor(def.action, view.webAppBaseUrl))}">Open in the web app</a>`
      : `<button data-action="${escape(def.action)}">Apply</button>`;

    return [
      '<section class="action">',
      `<h2>${escape(def.label)}</h2>`,
      `<p>${escape(def.summary)}</p>`,
      `<p class="twin">Text equivalent: <code>manage(action: "${escape(def.action)}", value: …)</code></p>`,
      `<div class="row">${control}${button}</div>`,
      '</section>',
    ].join('');
  }).join('');

  const state = JSON.stringify({
    panel_nonce: nonce,
    current: {
      spend_cap_micro_usd: view.spendCapMicroUsd,
      context_policy: view.contextPolicy,
      paused_sources: [...view.pausedSources],
    },
    // The panel's own list of what it may call — same names the text twin
    // publishes, from the same table.
    actions: MANAGE_ACTIONS.map((def) => def.action),
  })
    // A JSON payload inside a <script> block ends the block if it ever prints a
    // closing tag. Nothing here can today; escaping means nothing here can
    // tomorrow either.
    .replace(/</g, '\\u003c');

  return [
    '<main class="brainz-panel">',
    '<h1>Your brain</h1>',
    `<p class="current">Spend cap: ${escape(String(view.spendCapMicroUsd ?? 'platform default'))} · `,
    `Reading posture: ${escape(view.contextPolicy ?? 'not set')} · `,
    `Paused: ${escape(view.pausedSources.length === 0 ? 'nothing' : [...view.pausedSources].join(', '))}</p>`,
    rows,
    `<script type="application/json" id="brainz-panel-state">${state}</script>`,
    '<script>',
    // Minimal, dependency-free, and it calls exactly one tool.
    "const state=JSON.parse(document.getElementById('brainz-panel-state').textContent);",
    "for(const button of document.querySelectorAll('button[data-action]')){",
    'button.addEventListener(\'click\',()=>{',
    'const action=button.dataset.action;',
    "const field=document.querySelector('[data-value-for=\"'+action+'\"]');",
    "window.parent.postMessage({jsonrpc:'2.0',id:Date.now(),method:'tools/call',",
    "params:{name:'manage',arguments:{action,value:String(field?field.value:''),panel_nonce:state.panel_nonce}}},'*');",
    '});}',
    '</script>',
    '</main>',
  ].join('\n');
}

/** The panel is offered only to a client that says it can render one. */
export function panelIsOffered(capabilities: ClientCapabilities): boolean {
  return capabilities.ui;
}

/** The connectors a panel view lists, in one place so the twin cannot disagree. */
export const PANEL_CONNECTOR_SOURCES: readonly string[] = CONNECTOR_SOURCES;
