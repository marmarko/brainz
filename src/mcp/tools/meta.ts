/**
 * The three tools that are not about knowledge: `brain`, `manage`, and the
 * `synthesize` stub.
 *
 * **`brain` is the trust artifact, and it has to be a read.** The isolation
 * attestation also rides `_meta` on every response, which is the stronger
 * signal — a claim you have to ask for proves a claim, one stamped on every
 * response is a property. But `_meta` is invisible to the model, so a user
 * asking their assistant "is my data actually isolated?" gets nothing from it.
 * This is the model-reachable rendering, and being read-only is what keeps it
 * alive on surfaces where writes default to off.
 *
 * **`manage` is nonce-gated and advertised nowhere.** SEP-1865 panel actions can
 * only ride `tools/call`, and the action enum is permitted here *only* because
 * no model selects it. Every action is reversible; disconnect, delete, export and
 * sharing deep-link to the web app instead of living here, which is what lets
 * `destructiveHint: false` be honest rather than annotated around.
 *
 * **`synthesize` answers `unavailable` with a suggestion.** A caller carrying
 * gbrain's frozen five gets an actionable error naming `briefing` rather than
 * `unknown_tool`. The capability moved to the nightly consolidation schedule,
 * where its cost can be estimated before it is spent.
 */

import type { PauseAuthority } from '../../ingest/pause.ts';
import { deepLinkFor, MANAGE_ACTION_NAMES } from '../manage-actions.ts';
import { PANEL_CONNECTOR_SOURCES, panelTextTwin } from '../panel.ts';
import { inventory } from '../reads.ts';
import type { SettingsOutcome, SettingsPort } from '../settings.ts';
import { advertisedTools, definitionsDigest, ENDPOINTS, type Endpoint } from './index.ts';
import { INSTRUCTIONS_RELEASE, INSTRUCTIONS_RELEASED_ON } from '../instructions.ts';
import { invalid, stringArg, type Handler } from './context.ts';

/**
 * The attestation body, shared by the `brain` tool and the `_meta` stamp.
 *
 * **What it claims is scoped to what was verified.** The Neon boundary is
 * structural — one project, one database, one role per tenant, checkable from
 * the connection string. The object-storage boundary is structural *conditional
 * on correct prefix derivation*, because the platform matches prefixes literally
 * and enforces the string it was given rather than a boundary at the separator.
 * Reporting the second as unconditionally structural would be a receipt that
 * keeps verifying after the property stops holding.
 *
 * The signature is deliberately absent here: R10 puts the signing key outside
 * the fleet's readable secret scope, precisely so the process that parses
 * attacker-controlled mail cannot mint a valid receipt. U16 wires the sign-only
 * signer; until it does, this reports `unsigned` rather than self-signing.
 */
export function attestation(tenantId: string): Record<string, unknown> {
  return {
    tenant_id: tenantId,
    database_boundary: 'structural',
    storage_boundary: 'structural_conditional_on_prefix_derivation',
    signature: 'unsigned',
    definitions_digest: definitionsDigest(),
    instructions_release: INSTRUCTIONS_RELEASE,
  };
}

export const brain: Handler = async (ctx) => {
  const counts = await inventory(ctx.sql, ctx.grant);
  const state = await ctx.indexState();

  const matrix: Record<string, string[]> = {};
  for (const endpoint of ENDPOINTS) {
    matrix[endpoint] = advertisedTools(endpoint).map((tool) => tool.name);
  }

  return {
    ok: true,
    content: {
      counts,
      health: {
        cold_start: ctx.coldStart,
        chunks_pending_embedding: state.chunksPendingEmbedding,
        import_in_progress: state.importInProgress,
      },
      attestation: attestation(ctx.tenantId),
      definitions_digest: definitionsDigest(),
      instructions: { release: INSTRUCTIONS_RELEASE, released_on: INSTRUCTIONS_RELEASED_ON },
      // What this connection may read, as origin labels rather than as content.
      // A user asking "what is this connector able to see" gets an answer.
      origins: ctx.grant,
      tools: matrix,
      // U14's text twin, and the reason it rides here rather than on a tool of
      // its own: `brain` is advertised on both endpoints, is read-only, and
      // costs no model call, so the management surface is reachable from any
      // client — including the ones that cannot render a panel, which on the
      // evidence is every shipping client this connector meets. Same table the
      // panel renders from, so the two cannot describe different worlds.
      management: await managementTwin(ctx.settings, ctx.webAppBaseUrl),
    },
  };
};

/**
 * The management block, or an honest absence.
 *
 * When no settings backend is wired the block says so instead of reporting
 * defaults: a twin that invented "no cap, nothing paused" would be indistinguishable
 * from a brain that really had neither, and a user would act on it.
 */
async function managementTwin(
  settings: SettingsPort | null,
  webAppBaseUrl: string,
): Promise<Record<string, unknown>> {
  if (settings === null) {
    return {
      available: false,
      detail: 'This server is not wired to a settings store, so nothing here can be changed.',
      web_app_url: `${webAppBaseUrl.replace(/\/+$/, '')}/manage`,
    };
  }

  const snapshot = await settings.read();
  const twin = panelTextTwin({
    spendCapMicroUsd: snapshot.spendCapMicroUsd,
    contextPolicy: snapshot.contextPolicy,
    pausedSources: snapshot.pausedSources,
    connectorSources: PANEL_CONNECTOR_SOURCES,
    webAppBaseUrl,
  });

  return {
    available: true,
    spend_cap_micro_usd: snapshot.spendCapMicroUsd,
    context_policy: snapshot.contextPolicy,
    paused_sources: [...snapshot.pausedSources],
    actions: twin.actions,
    note: twin.note,
  };
}

/**
 * `manage` — four reversible settings, and nothing else.
 *
 * **The authorisation already happened.** Whether this call may change anything
 * is decided in `manage-gate.ts`, below the handlers, for the reason
 * `test/mcp/guards.test.ts` writes down: a gate a handler could choose not to
 * check is not a gate. By the time this runs the caller holds either a current
 * panel nonce or a confirmation bound to this exact action and value, and
 * `ctx.authority` says which.
 *
 * **`applied` is never optimistic.** It reports what the store said, and the
 * `effect` line beside it says where the change does and does not bite — which
 * matters most for `set_context_policy`, whose column rung 7 adds and whose
 * read-path narrowing is U15's. A response that implied otherwise would be a
 * user believing their reads had changed when they had not.
 */
export const manage: Handler = async (ctx, args) => {
  const action = stringArg(args, 'action');
  if (action === null || !MANAGE_ACTION_NAMES.includes(action as never)) {
    return invalid(`\`action\` must be one of ${MANAGE_ACTION_NAMES.join(', ')}.`);
  }

  // Every action acts on something — a cap, a policy, a source — so a call with
  // no value is refused rather than reaching a store that would have to invent
  // a default.
  const value = stringArg(args, 'value');
  if (value === null) return invalid(`\`${action}\` needs a \`value\`.`);

  if (ctx.settings === null) {
    return {
      ok: false,
      code: 'unavailable',
      message: 'This brain’s settings could not be reached.',
    };
  }

  const outcome = await applyManageAction(ctx.settings, action, value, ctx.authority);
  if (!outcome.ok) return { ok: false, code: outcome.code, message: outcome.message };

  return {
    ok: true,
    content: {
      action,
      value,
      applied: true,
      authority: ctx.authority,
      effect: outcome.effect,
      web_app_url: deepLinkFor(action, ctx.webAppBaseUrl),
    },
  };
};

function applyManageAction(
  settings: SettingsPort,
  action: string,
  value: string,
  authority: PauseAuthority,
): Promise<SettingsOutcome> {
  switch (action) {
    case 'set_spend_cap':
      return settings.setSpendCap(value);
    case 'set_context_policy':
      return settings.setContextPolicy(value);
    case 'pause_source':
      return settings.pauseSource(value, authority);
    case 'resume_source':
      return settings.resumeSource(value);
    default:
      // Unreachable: the enum was checked above and again in the gate. Kept so
      // that adding a name to the table without adding a case here is a typed
      // refusal rather than a silent success.
      return Promise.resolve({
        ok: false,
        code: 'invalid_params',
        message: `\`${action}\` has no implementation on this surface.`,
      });
  }
}

export const synthesize: Handler = () =>
  Promise.resolve({
    ok: false,
    code: 'unavailable',
    message:
      'This server does not run server-side synthesis. `briefing` assembles the same material from work already paid for, and your own model writes the prose.',
    suggestion: 'briefing',
  });

/** The endpoint-aware tool matrix `brain` publishes, exported for the server. */
export function toolMatrix(): Record<Endpoint, string[]> {
  return Object.fromEntries(
    ENDPOINTS.map((endpoint) => [endpoint, advertisedTools(endpoint).map((tool) => tool.name)]),
  ) as Record<Endpoint, string[]>;
}
