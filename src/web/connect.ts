/**
 * The guided connect flow (R2a) — the mechanism that replaces "paste this URL
 * into settings".
 *
 * R2a names a prohibition rather than a mechanism: *"paste this URL into
 * settings" is the setup question R1 forbids*. U15 owes the replacement, named
 * and verified against the target client's real UX before building. It was, on
 * 2026-08-13, and the answer is in
 * `docs/plans/2026-08-13-003-u15-web-app-identity-billing-replan.md` §1 with
 * sources.
 *
 * **What the vendor actually provides.** Anthropic documents an install deep
 * link under the heading "Share an install link", shipped 2026-05-13, and frames
 * it as the thing you put behind a "Connect to Claude" button:
 *
 *     https://claude.ai/customize/connectors?modal=add-custom-connector
 *       &connectorName=<name>&connectorUrl=<percent-encoded server URL>
 *
 * The docs are explicit about its limits, and so is this module: *"Install links
 * only prefill the form. They do not bypass review by the user, and they do not
 * grant your server any permissions the user has not confirmed."* The user still
 * clicks **Add**, then **Connect**, then authorizes — and Claude shows a notice
 * that the values came from an external link.
 *
 * **So the mechanism has two halves and the second one is ours.** The link
 * removes the transcription step, which is what R2a forbids. It does not make
 * the flow verifiable: a link the user may or may not have followed is still an
 * instruction. {@link connectionStatus} is the other half — the web app watches
 * for the tenant's first authenticated call and flips to "connected" when it
 * arrives, so the step has an observable end state rather than a hopeful one.
 *
 * **Honest copy is part of the mechanism, not decoration.** A "one click"
 * promise followed by three clicks is its own abandonment point, so
 * {@link CONNECT_STEPS} says Add, Connect, authorize, and says the external-link
 * notice will appear.
 *
 * Three paths were checked and are not used: `.mcpb`/`.dxt` Desktop Extensions
 * declare only local `node`/`python`/`binary`/`uv` server types and cannot carry
 * a remote endpoint at all; no MCP-spec install mechanism has landed (SEP-1649
 * and SEP-1960 are both closed unaccepted); and Anthropic's connector directory
 * requires a Team or Enterprise organisation to submit. Sources in the re-plan.
 */

import type { SQL } from 'bun';

/** The vendor's documented prefill endpoint. One function, one place to fix. */
const INSTALL_LINK_BASE = 'https://claude.ai/customize/connectors';

/** The org-admin variant: Team and Enterprise owners add connectors here. */
const ADMIN_INSTALL_LINK_BASE = 'https://claude.ai/admin-settings/connectors';

/** What the prefilled dialog shows as the connector's name. */
export const CONNECTOR_NAME = 'brainz';

export type ClaudeSurface = 'personal' | 'organization';

/**
 * Build the install link for this fleet's `/mcp` origin.
 *
 * The server URL is percent-encoded as a whole query-parameter value, which is
 * what the documented example does (`connectorUrl=https%3A%2F%2Fmcp.example.com%2F`).
 */
export function installLink(request: {
  readonly mcpUrl: string;
  readonly surface?: ClaudeSurface;
  readonly connectorName?: string;
}): string {
  const base = request.surface === 'organization' ? ADMIN_INSTALL_LINK_BASE : INSTALL_LINK_BASE;
  const params = new URLSearchParams({
    modal: 'add-custom-connector',
    connectorName: request.connectorName ?? CONNECTOR_NAME,
    connectorUrl: request.mcpUrl,
  });
  return `${base}?${params.toString()}`;
}

/**
 * The Claude Code equivalent.
 *
 * There is no install deep link for Claude Code — the documented flow is a
 * command, and `claude mcp add-json` plus a committable `.mcp.json` are the only
 * one-shot forms. A copy button on a single line is the honest best available,
 * and it is not the thing R2a forbids: the user copies one command rather than
 * being walked through a settings dialog.
 */
export function claudeCodeCommand(mcpUrl: string, name = CONNECTOR_NAME): string {
  return `claude mcp add --transport http ${name} ${mcpUrl}`;
}

/**
 * What the connect page tells the user will happen, in order.
 *
 * Written down as data rather than prose in a template so that the copy and the
 * link cannot drift apart, and so a test can assert that the page does not claim
 * fewer steps than the vendor's flow has.
 */
export const CONNECT_STEPS: readonly string[] = [
  'Open the link. Claude opens its "Add custom connector" dialog with the name and address already filled in, and shows a notice that they came from an external link — that notice is expected.',
  'Click Add. The connector appears in your list, not yet connected.',
  'Click Connect and approve the sign-in. That is the step that gives this brain to your Claude, and nothing before it grants anything.',
];

export type ConnectionState = 'never_connected' | 'connected';

export interface ConnectionStatus {
  readonly state: ConnectionState;
  readonly firstSeenAt: Date | null;
  readonly lastSeenAt: Date | null;
}

/**
 * Has this tenant's brain ever been reached by a client?
 *
 * Read from the control plane's own `last_activity` — the signal U6's dispatch
 * already stamps on user-originated calls (KTD11). Deliberately not a new
 * counter: a second signal for "has anybody connected" would be a second thing
 * to keep true, and the first authenticated tool call *is* the event the connect
 * flow is waiting for.
 *
 * The honest limit, stated because the page's copy depends on it: this reports
 * that **something authenticated as this tenant made a user-originated call**.
 * It cannot distinguish Claude Desktop from Claude Code from a `curl`, because
 * the wire does not carry that, and a page claiming to know which client
 * connected would be inventing it.
 */
export async function connectionStatus(controlSql: SQL, tenantId: string): Promise<ConnectionStatus> {
  const rows = await controlSql<{ last_activity: Date | null; ready_at: Date | null }[]>`
    SELECT last_activity, ready_at FROM control.tenant WHERE tenant_id = ${tenantId}`;
  const found = rows[0];
  if (found === undefined || found.last_activity === null) {
    return { state: 'never_connected', firstSeenAt: null, lastSeenAt: null };
  }
  return {
    state: 'connected',
    firstSeenAt: found.ready_at,
    lastSeenAt: found.last_activity,
  };
}
