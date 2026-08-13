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

import { inventory } from '../reads.ts';
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
    },
  };
};

const REVERSIBLE_ACTIONS = new Set(['set_context_policy', 'set_spend_cap', 'pause_source', 'resume_source']);

export const manage: Handler = (_ctx, args) => {
  const action = stringArg(args, 'action');
  if (action === null || !REVERSIBLE_ACTIONS.has(action)) {
    return Promise.resolve(invalid(`\`action\` must be one of ${[...REVERSIBLE_ACTIONS].join(', ')}.`));
  }

  // Every action in the enum acts on something — a cap, a policy, a source — so
  // a call with no value is refused here rather than reaching a settings store
  // that would have to invent a default. Validated now rather than when the
  // store lands, because a parameter this handler declares and drops is the
  // silently-wrong-answer shape the definitions guard exists to refuse.
  const value = stringArg(args, 'value');
  if (value === null) {
    return Promise.resolve(invalid(`\`${action}\` needs a \`value\`.`));
  }

  // The panel's settings store is U14's. What lands here is the dispatch seam,
  // the nonce gate and the validation, so the gate is real from the first call
  // rather than being added once a panel exists to bypass it.
  return Promise.resolve({
    ok: true,
    content: {
      action,
      value,
      applied: false,
      detail: 'The panel settings store lands with the panel surface.',
    },
  });
};

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
