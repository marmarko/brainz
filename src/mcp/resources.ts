/**
 * `resources/list` and `resources/read` — the panel, and where its nonce is
 * minted.
 *
 * **This is the whole resource surface, and it holds exactly one resource.**
 * Resources are a general MCP primitive and this server deliberately does not
 * become a file server over the user's brain: everything readable goes through
 * the fenced tool handlers, where the origin fence is derived from the
 * credential. The one `ui://` resource here renders *settings*, and it renders
 * them from counts and closed-set values rather than from content.
 *
 * **The credential path is shared with `dispatch.ts`, not copied.** A second
 * surface with its own idea of how to authenticate is how the tenant-existence
 * oracle that module's comments record gets rewritten somewhere new. So this
 * calls `authenticate` and produces the same single refusal.
 *
 * **The nonce is minted only for a client that declared the ui extension, and
 * that rule is the access control rather than a nicety.** A nonce is a
 * credential for a surface the model is not supposed to drive; if any
 * authenticated caller could ask for one, the connected agent would simply read
 * this resource, take the nonce, and call `manage` — and the gate would be a
 * formality. Requiring the declaration means a host that cannot render a panel
 * cannot mint a panel credential either. The residual that remains, written down
 * rather than discovered: on a ui-capable host where resource content can reach
 * model context, the model can still see the nonce. That is bounded for four
 * reversible settings and is exactly why the review-queue close is not one of
 * them (re-plan §3).
 */

import { authenticate, type DispatchDeps, type DispatchError } from './dispatch.ts';
import { NO_CLIENT_CAPABILITIES, type ClientCapabilities } from './client-capabilities.ts';
import { DEFAULT_WEB_APP_BASE_URL } from './manage-actions.ts';
import { PANEL_CONNECTOR_SOURCES, PANEL_MIME_TYPE, PANEL_RESOURCE_URI, panelHtml } from './panel.ts';
import { PANEL_NONCE_TTL_MS, mintPanelToken } from './panel-token.ts';
import type { ResultClass } from './access-log.ts';

/** The `_meta` key the minted nonce rides under, for a host that surfaces it. */
export const PANEL_NONCE_META_KEY = 'brainz.app/panel_nonce';

/** How this surface names itself in the access log. */
export const RESOURCE_READ_TOOL = 'resources/read';

export interface ResourceDescriptor {
  readonly uri: string;
  readonly name: string;
  readonly description: string;
  readonly mimeType: string;
  readonly _meta: Record<string, unknown>;
}

export interface ResourceContents {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

export interface ResourceResult {
  readonly ok: boolean;
  readonly contents?: readonly ResourceContents[];
  readonly meta?: Record<string, unknown>;
  readonly error?: DispatchError;
}

export interface ResourceRequest {
  readonly authorization: string | null;
  readonly uri: string;
  readonly clientCapabilities?: ClientCapabilities;
}

/**
 * What `resources/list` answers.
 *
 * Empty for a client that cannot render one — advertising a resource whose only
 * consumer is a frame the client will not mount is a list entry that teaches a
 * caller to fetch something it cannot use, and on this surface it would also be
 * an invitation to mint a credential.
 *
 * The CSP is declared and it is empty of external origins on purpose: the panel
 * inlines its own style and script, so there is nothing for a host to have to
 * allow, and a host that enforces the declaration blocks anything this document
 * later grows without the declaration growing with it.
 */
export function listResources(
  capabilities: ClientCapabilities = NO_CLIENT_CAPABILITIES,
): readonly ResourceDescriptor[] {
  if (!capabilities.ui) return [];
  return [
    {
      uri: PANEL_RESOURCE_URI,
      name: 'Manage this brain',
      description:
        'Spend cap, connector pauses and reading posture. Every action here has a text equivalent on the `brain` tool.',
      mimeType: PANEL_MIME_TYPE,
      _meta: {
        ui: {
          csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
          permissions: {},
          prefersBorder: true,
        },
      },
    },
  ];
}

function refuse(code: string, message: string): ResourceResult {
  return { ok: false, error: { code, message } };
}

export async function readResource(
  deps: DispatchDeps,
  request: ResourceRequest,
): Promise<ResourceResult> {
  const now = deps.now();
  const capabilities = request.clientCapabilities ?? NO_CLIENT_CAPABILITIES;

  const authenticated = await authenticate(deps, request.authorization);
  if (!authenticated.ok) {
    log(deps, now, authenticated.refusal.actor, authenticated.refusal.resultClass);
    return refuse(authenticated.refusal.code, authenticated.refusal.message);
  }

  const { claims, actor, signingKey } = authenticated.caller;

  // Before the database is opened, for the same reason the tool check is: a
  // request for a resource this server does not serve must not cost a
  // connection.
  if (request.uri !== PANEL_RESOURCE_URI) {
    log(deps, now, actor, 'not_found');
    return refuse('not_found', `No resource at ${JSON.stringify(request.uri)}.`);
  }

  if (!capabilities.ui) {
    log(deps, now, actor, 'scope_denied');
    return refuse(
      'scope_denied',
      'This resource is a panel view, and this client did not declare that it can render one.',
    );
  }

  // **The panel is tenant-wide; a narrowed credential is not.** The spend cap,
  // the context policy and the source pauses are properties of the whole brain
  // — pausing `gmail` stops the personal mailbox as surely as the work one —
  // and a work-connector grant is a slice of it, which is the entire product
  // meaning of U18's narrowing. So this refuses on the credential's scope and
  // not only on the client's capability: the two questions are "can this host
  // render a panel" and "is this credential for the brain the panel manages",
  // and the second had no asker.
  //
  // It closes the *mint*. It does not close the gate, and cannot: a nonce is a
  // bearer value that rides `_meta` here and comes back as a tool argument, so
  // `manage-gate.ts` asks the same question again on the way in. Either check
  // alone is a control whose failure the other one hides.
  if (claims.scope !== 'whole_brain') {
    log(deps, now, actor, 'scope_denied');
    return refuse(
      'scope_denied',
      'This connection holds part of this brain rather than all of it, and these settings apply to all of it. Open the web app to change them.',
    );
  }

  if (deps.settings === undefined) {
    log(deps, now, actor, 'unavailable');
    return refuse('unavailable', 'This brain’s settings could not be reached.');
  }

  const opened = await deps.connections.open(claims.tenantId);
  if (!opened.ok) {
    log(deps, now, actor, 'unavailable');
    return refuse('unavailable', 'This brain could not be reached.');
  }

  let html: string;
  let nonce: string;
  try {
    const snapshot = await deps.settings
      .forTenant({ tenantId: claims.tenantId, sql: opened.connection.sql })
      .read();

    nonce = mintPanelToken(signingKey, {
      purpose: 'panel',
      tenantId: claims.tenantId,
      // The same identity the access log names, so a nonce minted on one
      // connection is not spendable on another.
      callerKey: claims.grantId,
      expiresAt: now.getTime() + PANEL_NONCE_TTL_MS,
    });

    html = panelHtml(
      {
        spendCapMicroUsd: snapshot.spendCapMicroUsd,
        contextPolicy: snapshot.contextPolicy,
        pausedSources: snapshot.pausedSources,
        connectorSources: PANEL_CONNECTOR_SOURCES,
        webAppBaseUrl: deps.webAppBaseUrl ?? DEFAULT_WEB_APP_BASE_URL,
      },
      nonce,
    );
  } catch {
    // A throw here must not become a stack trace on the wire, for the reason
    // dispatch gives: the message is the ordinary way a user's row content
    // reaches a log this system promises holds none.
    log(deps, now, actor, 'error');
    return refuse('error', 'That panel could not be assembled.');
  }

  log(deps, now, actor, 'ok');
  return {
    ok: true,
    contents: [{ uri: PANEL_RESOURCE_URI, mimeType: PANEL_MIME_TYPE, text: html }],
    meta: { [PANEL_NONCE_META_KEY]: nonce },
  };
}

function log(
  deps: DispatchDeps,
  now: Date,
  actor: { readonly grantId: string; readonly tenantId: string },
  resultClass: ResultClass,
): void {
  try {
    deps.accessLog.record({
      at: now.toISOString(),
      grantId: actor.grantId,
      tenantId: actor.tenantId,
      tool: RESOURCE_READ_TOOL,
      resultClass,
    });
  } catch {
    // A log sink that can fail a read is a log sink that gets removed.
  }
}
