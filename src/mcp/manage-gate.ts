/**
 * The `manage` gate — one total function over what the client said it can do.
 *
 * **Why this is a gate rather than a check inside the handler.** `panel_nonce`
 * is already consumed below the handlers for the reason `test/mcp/guards.test.ts`
 * writes down: a gate a handler could choose not to check is not a gate. The
 * confirmation is the same class of control and belongs in the same place, so
 * that "did this call have permission to change something" has exactly one
 * answer and one implementation.
 *
 * **The matrix, and why each row is what it is.**
 *
 * | client declares | gate |
 * |---|---|
 * | `io.modelcontextprotocol/ui` | a panel nonce, and nothing else |
 * | no `ui`, has `elicitation` | an MRTR confirmation bound to this exact change |
 * | neither | refuse, with the web-app deep link |
 *
 *   * **Elicitation never substitutes for a nonce on a ui-capable client.** A
 *     host that can render a panel can produce a panel credential. Accepting a
 *     confirmation instead would mean the model reaches a gate that was never
 *     about confirmation, on the one branch where the nonce is obtainable.
 *   * **A nonce never substitutes for a confirmation on a ui-less client.** A
 *     nonce is only mintable on a request that declared `ui` (see
 *     `resources.ts`), so one presented here is a replay or a leak, and either
 *     way it is not this branch's credential.
 *   * **`set_context_policy` is refused on both fallback rows**, including the
 *     one with elicitation. The roadmap moves it web-app-only in the fallback;
 *     it is not "confirmable". A yes-click on a prompt the connected agent
 *     framed is not the user choosing how their brain reads.
 *   * **It fails closed.** Every capability, when present, *widens* what the
 *     caller may do, and an unreadable declaration reads as absent
 *     (`client-capabilities.ts`). The branch that grants least is the default,
 *     which matters because whether the target client sends per-request
 *     capabilities at all is unverified.
 *
 * **What the confirmation is bound to.** The minted `requestState` carries the
 * exact action and value the user was asked about. Without that binding the
 * retry is a blank cheque — ask about pausing a mailbox, spend the yes on
 * zeroing the spend cap.
 */

import type { PauseAuthority } from '../ingest/pause.ts';
import type { ClientCapabilities } from './client-capabilities.ts';
import {
  deepLinkFor,
  MANAGE_ACTION_NAMES,
  manageActionByName,
  normalizeManageValue,
} from './manage-actions.ts';
import { PANEL_NONCE_TTL_MS, mintPanelToken, verifyPanelToken } from './panel-token.ts';
import type { ErrorCode } from './tools/context.ts';

/** One question the server needs answered mid-call (SEP-2322). */
export interface InputRequest {
  readonly type: 'elicitation';
  readonly message: string;
  readonly schema: Record<string, unknown>;
}

/** The `input_required` body a stateless server hands back instead of a stream. */
export interface InputRequired {
  readonly inputRequests: Readonly<Record<string, InputRequest>>;
  /** Opaque to the client, which MUST echo it back unmodified on the retry. */
  readonly requestState: string;
}

/** What the client echoed back. Carried on the request, never in the tool's arguments. */
export interface ResumeInput {
  readonly requestState?: string;
  readonly inputResponses?: Record<string, unknown>;
}

export type ManageGate =
  | { readonly kind: 'allow'; readonly authority: PauseAuthority }
  | {
      readonly kind: 'refuse';
      readonly code: ErrorCode;
      readonly message: string;
      readonly suggestion?: string;
    }
  | { readonly kind: 'ask'; readonly inputRequired: InputRequired; readonly message: string };

export interface ManageGateInput {
  readonly action: string | null;
  readonly value: string | null;
  readonly panelNonce: string;
  readonly capabilities: ClientCapabilities;
  readonly resume: ResumeInput | undefined;
  readonly signingKey: string;
  readonly tenantId: string;
  readonly callerKey: string;
  readonly nowMs: number;
  readonly webAppBaseUrl: string;
}

/** The one key the confirmation rides under. Named so both ends agree. */
export const CONFIRM_KEY = 'confirm';

export function resolveManageGate(input: ManageGateInput): ManageGate {
  const def = input.action === null ? undefined : manageActionByName(input.action);
  if (def === undefined) {
    // Before any credential is looked at, and deliberately so: an unknown
    // action must not be a way to learn which credentials this surface accepts.
    return {
      kind: 'refuse',
      code: 'invalid_params',
      message: `\`action\` must be one of ${MANAGE_ACTION_NAMES.join(', ')}.`,
    };
  }

  if (input.capabilities.ui) {
    const verdict =
      input.panelNonce.length === 0
        ? null
        : verifyPanelToken(input.panelNonce, input.signingKey, {
            purpose: 'panel',
            tenantId: input.tenantId,
            callerKey: input.callerKey,
            nowMs: input.nowMs,
          });

    if (verdict === null || !verdict.ok) {
      return {
        kind: 'refuse',
        code: 'invalid_params',
        message:
          'This tool requires a current panel nonce, which is minted into a panel view rather than offered to a model.',
      };
    }
    return { kind: 'allow', authority: 'panel' };
  }

  const deepLink = deepLinkFor(def.action, input.webAppBaseUrl);

  if (def.panelOnly) {
    return {
      kind: 'refuse',
      code: 'scope_denied',
      message: `\`${def.action}\` is not changed from a chat connection. Open ${deepLink} to change it.`,
    };
  }

  if (!input.capabilities.elicitation) {
    return {
      kind: 'refuse',
      code: 'scope_denied',
      message: `This client cannot ask you to confirm a change, so this connection does not make one. Open ${deepLink} instead.`,
    };
  }

  // Normalised **before** the confirmation is written, so the only strings that
  // can reach the prompt the user reads are closed-set names and digits. See
  // `manage-actions.ts` for why that ordering is the control rather than a nicety.
  const normalized = normalizeManageValue(def.action, input.value);
  if (!normalized.ok) {
    return { kind: 'refuse', code: 'invalid_params', message: normalized.message };
  }
  const value = normalized.normalized;
  const presentedState = input.resume?.requestState ?? '';

  if (presentedState.length === 0) {
    return {
      kind: 'ask',
      message: `Confirm this change, or open ${deepLink} to make it in the web app.`,
      inputRequired: {
        inputRequests: {
          [CONFIRM_KEY]: {
            type: 'elicitation',
            message: confirmationText(def.action, value),
            schema: { type: 'boolean' },
          },
        },
        requestState: mintPanelToken(input.signingKey, {
          purpose: 'confirm',
          tenantId: input.tenantId,
          callerKey: input.callerKey,
          action: def.action,
          value,
          expiresAt: input.nowMs + PANEL_NONCE_TTL_MS,
        }),
      },
    };
  }

  const verdict = verifyPanelToken(presentedState, input.signingKey, {
    purpose: 'confirm',
    tenantId: input.tenantId,
    callerKey: input.callerKey,
    action: def.action,
    value,
    nowMs: input.nowMs,
  });

  if (!verdict.ok) {
    return {
      kind: 'refuse',
      code: 'invalid_params',
      message:
        verdict.reason === 'action_mismatch'
          ? 'That confirmation was for a different change. Ask again for this one.'
          : 'That confirmation is no longer current. Ask again.',
    };
  }

  if (input.resume?.inputResponses?.[CONFIRM_KEY] !== true) {
    return {
      kind: 'refuse',
      code: 'invalid_params',
      message: 'Not confirmed, so nothing was changed.',
    };
  }

  // Never `user_out_of_band`, and the name is the reason: this call was issued
  // by the connected agent and approved inside an agent-driven turn. R12a's
  // distinction is what stops that becoming a corroborating attestation.
  return { kind: 'allow', authority: 'agent_confirmed' };
}

function confirmationText(action: string, value: string): string {
  switch (action) {
    case 'set_spend_cap':
      return `Set this brain's rolling model-spend cap to ${value} micro-USD?`;
    case 'pause_source':
      return `Stop polling ${value} for this brain? Nothing already stored is removed.`;
    case 'resume_source':
      return `Start polling ${value} again for this brain?`;
    default:
      return `Apply ${action} = ${value} to this brain?`;
  }
}
